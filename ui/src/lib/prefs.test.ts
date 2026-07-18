import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isBool,
  isFiniteNumber,
  loadBoolPref,
  loadPref,
  numberIn,
  oneOf,
  savePref,
  shapeOf,
} from "./prefs";

/**
 * Minimal Map-backed localStorage stub — tests run in a plain node environment.
 * loadPref/savePref read `localStorage` at call time, so installing the stub in
 * beforeEach (after the module is imported) is sufficient.
 */
function makeStorageStub() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
}

let store: ReturnType<typeof makeStorageStub>;
const g = globalThis as { localStorage?: unknown };

beforeEach(() => {
  store = makeStorageStub();
  g.localStorage = store;
});

afterEach(() => {
  delete g.localStorage;
});

describe("loadPref", () => {
  it("returns the fallback when the key is missing", () => {
    expect(loadPref("ui.missing", 42)).toBe(42);
    expect(loadPref("ui.missing", "draw")).toBe("draw");
  });

  it("returns the fallback for malformed JSON", () => {
    store.map.set("mydaw.ui.bad", "{not json");
    expect(loadPref("ui.bad", 7)).toBe(7);
  });

  it("returns the fallback when validation fails", () => {
    store.map.set("mydaw.ui.w", JSON.stringify(999));
    expect(loadPref("ui.w", 280, numberIn(200, 400))).toBe(280);
    store.map.set("mydaw.ui.w", JSON.stringify("wide"));
    expect(loadPref("ui.w", 280, numberIn(200, 400))).toBe(280);
  });

  it("returns the stored value when validation passes", () => {
    store.map.set("mydaw.ui.w", JSON.stringify(300));
    expect(loadPref("ui.w", 280, numberIn(200, 400))).toBe(300);
  });

  it("returns the stored value without a validator", () => {
    store.map.set("mydaw.ui.zoom", JSON.stringify(1.5));
    expect(loadPref("ui.zoom", 1)).toBe(1.5);
  });

  it("returns the fallback when localStorage.getItem throws", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadPref("ui.w", 280)).toBe(280);
  });

  it("returns the fallback when localStorage is entirely absent", () => {
    delete g.localStorage;
    expect(loadPref("ui.w", 280)).toBe(280);
  });
});

describe("savePref", () => {
  it("round-trips through loadPref, namespaced under mydaw.", () => {
    savePref("ui.tool", "draw");
    expect(store.map.has("mydaw.ui.tool")).toBe(true);
    expect(loadPref("ui.tool", "select")).toBe("draw");

    savePref("ui.viewport", { zoomX: 24, scrollX: 100 });
    expect(loadPref("ui.viewport", null)).toEqual({ zoomX: 24, scrollX: 100 });

    savePref("mixer.wide", false);
    expect(loadPref("mixer.wide", true, isBool)).toBe(false);
  });

  it("swallows storage errors (private mode / quota)", () => {
    g.localStorage = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => savePref("ui.tool", "draw")).not.toThrow();
  });
});

describe("loadBoolPref", () => {
  it("passes real booleans through", () => {
    savePref("mixer.wide", true);
    expect(loadBoolPref("mixer.wide", false)).toBe(true);
    savePref("mixer.wide", false);
    expect(loadBoolPref("mixer.wide", true)).toBe(false);
  });

  it('coerces legacy raw "1"/"0" values (parsed as numbers 1/0)', () => {
    // pre-module writers stored the raw string "1"/"0" — JSON.parse gives 1/0
    store.map.set("mydaw.mixer.wide", "1");
    expect(loadBoolPref("mixer.wide", false)).toBe(true);
    store.map.set("mydaw.mixer.wide", "0");
    expect(loadBoolPref("mixer.wide", true)).toBe(false);
  });

  it('coerces JSON string "1"/"0" values', () => {
    store.map.set("mydaw.pianoRoll.audition", JSON.stringify("1"));
    expect(loadBoolPref("pianoRoll.audition", false)).toBe(true);
    store.map.set("mydaw.pianoRoll.audition", JSON.stringify("0"));
    expect(loadBoolPref("pianoRoll.audition", true)).toBe(false);
  });

  it("falls back for missing or non-boolish values", () => {
    expect(loadBoolPref("mixer.wide", true)).toBe(true);
    store.map.set("mydaw.mixer.wide", JSON.stringify("yes"));
    expect(loadBoolPref("mixer.wide", false)).toBe(false);
    store.map.set("mydaw.mixer.wide", JSON.stringify(2));
    expect(loadBoolPref("mixer.wide", true)).toBe(true);
  });
});

describe("validators", () => {
  it("isBool accepts only booleans", () => {
    expect(isBool(true)).toBe(true);
    expect(isBool(false)).toBe(true);
    expect(isBool(1)).toBe(false);
    expect(isBool("true")).toBe(false);
  });

  it("isFiniteNumber rejects NaN/Infinity/non-numbers", () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-3.5)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber("5")).toBe(false);
  });

  it("numberIn accepts finite numbers within [lo, hi] inclusive", () => {
    const v = numberIn(200, 400);
    expect(v(200)).toBe(true);
    expect(v(400)).toBe(true);
    expect(v(300.5)).toBe(true);
    expect(v(199.999)).toBe(false);
    expect(v(401)).toBe(false);
    expect(v(NaN)).toBe(false);
    expect(v("300")).toBe(false);
  });

  it("oneOf accepts only the listed literals", () => {
    const v = oneOf("select", "draw", "erase");
    expect(v("draw")).toBe(true);
    expect(v("erase")).toBe(true);
    expect(v("paint")).toBe(false);
    expect(v(undefined)).toBe(false);
  });

  it("shapeOf validates listed fields and ignores extras", () => {
    const v = shapeOf({ zoomX: numberIn(1, 500), snap: isBool });
    expect(v({ zoomX: 24, snap: true })).toBe(true);
    expect(v({ zoomX: 24, snap: true, extra: "ignored" })).toBe(true);
    expect(v({ zoomX: 9999, snap: true })).toBe(false); // field fails its validator
    expect(v({ zoomX: 24 })).toBe(false); // missing field
    expect(v(null)).toBe(false);
    expect(v([1, 2])).toBe(false);
    expect(v("nope")).toBe(false);
  });

  it("plugs into loadPref end-to-end", () => {
    savePref("pr.view", { zoomX: 24, snap: true });
    const v = shapeOf({ zoomX: numberIn(1, 500), snap: isBool });
    expect(loadPref("pr.view", null, v)).toEqual({ zoomX: 24, snap: true });
    savePref("pr.view", { zoomX: 24 });
    expect(loadPref("pr.view", null, v)).toBeNull();
  });
});
