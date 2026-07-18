import { beforeEach, describe, expect, it } from "vitest";
import {
  cancelInsertDrag,
  clearInsertDrag,
  endInsertDrag,
  insertDragPending,
  insertDropEffectFor,
  peekInsertDrag,
  reorderTargetIndex,
  setInsertDrag,
  voidInsertDrag,
} from "./dnd";
import type { InsertDrag } from "./dnd";

/**
 * Mirrors engine CommandProcessor::pluginMove: pull the instance out, then insert it at
 * newIndex (clamped to the post-removal list). Lets us assert the plugin actually lands in
 * the gap the user dropped it into.
 */
function applyEngineMove<T>(list: T[], fromIndex: number, newIndex: number): T[] {
  const out = [...list];
  const [moved] = out.splice(fromIndex, 1);
  out.splice(newIndex, 0, moved);
  return out;
}

/** Drop `list[fromIndex]` into the gap `before` and return the resulting order. */
function drop(list: string[], fromIndex: number, before: number): string[] {
  const target = reorderTargetIndex(before, fromIndex, list.length);
  if (target === null) return list; // no-op drop
  return applyEngineMove(list, fromIndex, target);
}

describe("reorderTargetIndex (mixer insert drag)", () => {
  const L = ["A", "B", "C", "D"];

  it("is a no-op when dropped back into its own gap", () => {
    expect(reorderTargetIndex(1, 1, 4)).toBeNull(); // gap before itself
    expect(reorderTargetIndex(2, 1, 4)).toBeNull(); // gap just after itself
    expect(drop(L, 1, 1)).toEqual(L);
    expect(drop(L, 1, 2)).toEqual(L);
  });

  it("moves a plugin earlier in the chain", () => {
    expect(drop(L, 2, 0)).toEqual(["C", "A", "B", "D"]); // C to the very top
    expect(drop(L, 3, 1)).toEqual(["A", "D", "B", "C"]); // D between A and B
  });

  it("moves a plugin later in the chain (boundary shifts left after removal)", () => {
    expect(drop(L, 0, 2)).toEqual(["B", "A", "C", "D"]); // A between B and C
    expect(drop(L, 0, 4)).toEqual(["B", "C", "D", "A"]); // A to the very end
    expect(drop(L, 1, 4)).toEqual(["A", "C", "D", "B"]); // B to the very end
  });

  it("clamps a past-the-end boundary to the last slot", () => {
    expect(reorderTargetIndex(99, 0, 4)).toBe(3);
    expect(drop(L, 0, 99)).toEqual(["B", "C", "D", "A"]);
  });

  it("handles a single-item chain", () => {
    expect(reorderTargetIndex(0, 0, 1)).toBeNull();
    expect(reorderTargetIndex(1, 0, 1)).toBeNull();
  });

  it("lands the plugin in the dropped gap for every from/before combination", () => {
    for (let from = 0; from < L.length; from++) {
      for (let before = 0; before <= L.length; before++) {
        const result = drop(L, from, before);
        // the moved item must sit where the user aimed, accounting for its own removal
        const expectedPos = before > from ? before - 1 : before;
        expect(result).toHaveLength(L.length);
        expect(new Set(result)).toEqual(new Set(L)); // nothing lost or duplicated
        expect(result.indexOf(L[from])).toBe(Math.min(expectedPos, L.length - 1));
      }
    }
  });
});

/* ---------------------------------------------------------------------------------
 * Insert-drag outcome machine (move / Alt-copy / drop-on-nothing removal / Escape).
 * Node env: no DOM, so the transitions the document listeners trigger in the browser
 * (Escape keydown -> cancelInsertDrag, unconsumed drop -> voidInsertDrag) are called
 * directly, against a minimal DataTransfer stand-in.
 * ------------------------------------------------------------------------------ */

function fakeDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    setData: (t: string, v: string) => void data.set(t, v),
    getData: (t: string) => data.get(t) ?? "",
    get types() {
      return Array.from(data.keys());
    },
    effectAllowed: "uninitialized",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

const DRAG: InsertDrag = { trackId: 3, instanceId: 41, uid: "builtin:compressor", index: 0 };

describe("insert drag outcome (drop on nothing removes, Escape cancels)", () => {
  beforeEach(() => {
    clearInsertDrag(); // isolate module-level drag state between tests
  });

  it("no drag in flight -> keep (stray dragend is a no-op)", () => {
    expect(endInsertDrag()).toBe("keep");
  });

  it("stashes the payload for dragover peeking and reports pending", () => {
    setInsertDrag(fakeDataTransfer(), DRAG);
    expect(peekInsertDrag()).toEqual(DRAG);
    expect(insertDragPending()).toBe(true);
  });

  it("consumed by a mixer target -> keep, and the payload is gone", () => {
    setInsertDrag(fakeDataTransfer(), DRAG);
    clearInsertDrag();
    expect(peekInsertDrag()).toBeNull();
    expect(endInsertDrag()).toBe("keep");
  });

  it("unconsumed in-document drop -> remove", () => {
    setInsertDrag(fakeDataTransfer(), DRAG);
    voidInsertDrag();
    expect(endInsertDrag()).toBe("remove");
  });

  it("Escape -> keep, even if an unconsumed drop follows", () => {
    setInsertDrag(fakeDataTransfer(), DRAG);
    cancelInsertDrag();
    voidInsertDrag(); // Escape was first — must win
    expect(endInsertDrag()).toBe("keep");
  });

  it("drag that ends without any drop (released outside the window) -> keep", () => {
    setInsertDrag(fakeDataTransfer(), DRAG);
    expect(endInsertDrag()).toBe("keep");
  });

  it("voidInsertDrag without an active drag is inert", () => {
    voidInsertDrag();
    setInsertDrag(fakeDataTransfer(), DRAG);
    expect(insertDragPending()).toBe(true);
    expect(endInsertDrag()).toBe("keep");
  });

  it("endInsertDrag resets state for the next drag", () => {
    setInsertDrag(fakeDataTransfer(), DRAG);
    voidInsertDrag();
    expect(endInsertDrag()).toBe("remove");
    setInsertDrag(fakeDataTransfer(), DRAG);
    expect(endInsertDrag()).toBe("keep"); // fresh drag starts pending again
  });
});

describe("insertDropEffectFor (hover cursor: move vs Alt-copy)", () => {
  beforeEach(() => {
    clearInsertDrag();
  });

  it("same channel is always a move (reorder), Alt or not", () => {
    setInsertDrag(fakeDataTransfer(), DRAG);
    expect(insertDropEffectFor(DRAG.trackId, false)).toBe("move");
    expect(insertDropEffectFor(DRAG.trackId, true)).toBe("move");
  });

  it("another channel: default move, Alt copies", () => {
    setInsertDrag(fakeDataTransfer(), DRAG);
    expect(insertDropEffectFor(DRAG.trackId + 1, false)).toBe("move");
    expect(insertDropEffectFor(DRAG.trackId + 1, true)).toBe("copy");
  });

  it("falls back to copy when no insert drag is active (Browser plugin drag)", () => {
    expect(insertDropEffectFor(1, false)).toBe("copy");
  });
});
