import { describe, expect, it } from "vitest";
import type { Note } from "../protocol/types";
import { LE_PRESETS, applyLogicalEditor, type LeProgram } from "./logicalEditor";

let nextId = 1;
function note(partial: Partial<Note> = {}): Note {
  return { id: nextId++, pitch: 60, velocity: 100, startBeat: 0, lengthBeats: 1, ...partial };
}

const prog = (p: Partial<LeProgram>): LeProgram => ({
  mode: "transform",
  filters: [],
  actions: [],
  ...p,
});

describe("filters", () => {
  it("empty filter list matches everything", () => {
    const notes = [note(), note(), note()];
    expect(applyLogicalEditor(notes, prog({ mode: "select" })).matchedIds).toHaveLength(3);
  });

  it("filters AND together", () => {
    const a = note({ pitch: 60, velocity: 20 });
    const b = note({ pitch: 60, velocity: 90 });
    const c = note({ pitch: 72, velocity: 20 });
    const r = applyLogicalEditor([a, b, c], prog({
      mode: "select",
      filters: [
        { prop: "pitch", cond: "eq", value: 60 },
        { prop: "velocity", cond: "lt", value: 30 },
      ],
    }));
    expect(r.matchedIds).toEqual([a.id]);
  });

  it("inRange / outsideRange are inclusive / exclusive", () => {
    const lo = note({ pitch: 50 });
    const mid = note({ pitch: 60 });
    const hi = note({ pitch: 70 });
    const inR = applyLogicalEditor([lo, mid, hi], prog({
      mode: "select",
      filters: [{ prop: "pitch", cond: "inRange", value: 50, value2: 60 }],
    }));
    expect(inR.matchedIds.sort()).toEqual([lo.id, mid.id].sort());
    const outR = applyLogicalEditor([lo, mid, hi], prog({
      mode: "select",
      filters: [{ prop: "pitch", cond: "outsideRange", value: 50, value2: 60 }],
    }));
    expect(outR.matchedIds).toEqual([hi.id]);
  });

  it("pitchClass matches every octave of a note", () => {
    const c3 = note({ pitch: 48 });
    const c4 = note({ pitch: 60 });
    const d4 = note({ pitch: 62 });
    const r = applyLogicalEditor([c3, c4, d4], prog({
      mode: "select",
      filters: [{ prop: "pitchClass", cond: "eq", value: 0 }],
    }));
    expect(r.matchedIds.sort()).toEqual([c3.id, c4.id].sort());
  });

  it("index derives from TIME order, not array order", () => {
    const late = note({ startBeat: 4 });
    const early = note({ startBeat: 0 });
    const r = applyLogicalEditor([late, early], prog({
      mode: "select",
      filters: [{ prop: "index", cond: "eq", value: 0 }],
    }));
    expect(r.matchedIds).toEqual([early.id]);
  });

  it("modEq matches beat grid positions (positive modulo)", () => {
    const down = note({ startBeat: 8 });
    const off = note({ startBeat: 9.5 });
    const r = applyLogicalEditor([down, off], prog({
      mode: "select",
      filters: [{ prop: "startBeat", cond: "modEq", value: 4, value2: 0 }],
    }));
    expect(r.matchedIds).toEqual([down.id]);
  });
});

describe("modes", () => {
  it("delete removes the matched notes", () => {
    const quiet = note({ velocity: 10 });
    const loud = note({ velocity: 120 });
    const r = applyLogicalEditor([quiet, loud], prog({
      mode: "delete",
      filters: [{ prop: "velocity", cond: "lt", value: 30 }],
    }));
    expect(r.patch.remove).toEqual([quiet.id]);
  });

  it("select produces no patch", () => {
    const r = applyLogicalEditor([note()], prog({ mode: "select" }));
    expect(r.patch).toEqual({});
  });
});

describe("actions", () => {
  it("set / add / mul apply in order and clamp", () => {
    const n = note({ pitch: 120, velocity: 60 });
    const r = applyLogicalEditor([n], prog({
      actions: [
        { prop: "pitch", op: "add", value: 12 }, // 132 → clamps 127
        { prop: "velocity", op: "mul", value: 2 }, // 120
        { prop: "velocity", op: "add", value: 100 }, // 220 → clamps 127
      ],
    }));
    const patch = r.patch.update![0].patch;
    expect(patch.pitch).toBe(127);
    expect(patch.velocity).toBe(127);
  });

  it("random adds an offset inside [value, value2]", () => {
    const notes = Array.from({ length: 50 }, () => note({ velocity: 64 }));
    const r = applyLogicalEditor(notes, prog({
      actions: [{ prop: "velocity", op: "random", value: -10, value2: 10 }],
    }));
    for (const u of r.patch.update ?? []) {
      expect(u.patch.velocity!).toBeGreaterThanOrEqual(54);
      expect(u.patch.velocity!).toBeLessThanOrEqual(74);
    }
  });

  it("deterministic with an injected rng", () => {
    const n = note({ velocity: 64 });
    const mid = applyLogicalEditor([n], prog({
      actions: [{ prop: "velocity", op: "random", value: -10, value2: 10 }],
    }), () => 0.5);
    expect(mid.patch).toEqual({}); // -10 + 0.5*20 = 0 → no change, no patch
    const up = applyLogicalEditor([n], prog({
      actions: [{ prop: "velocity", op: "random", value: -10, value2: 10 }],
    }), () => 1);
    expect(up.patch.update![0].patch.velocity).toBe(74); // -10 + 1*20 = +10
  });

  it("emits no patch when nothing changes", () => {
    const r = applyLogicalEditor([note({ velocity: 100 })], prog({
      actions: [{ prop: "velocity", op: "set", value: 100 }],
    }));
    expect(r.patch).toEqual({});
  });
});

describe("presets", () => {
  it("every preset has a coherent shape", () => {
    for (const p of LE_PRESETS) {
      expect(p.name.length).toBeGreaterThan(0);
      if (p.program.mode === "transform") expect(p.program.actions.length).toBeGreaterThan(0);
      else expect(p.program.actions).toHaveLength(0);
    }
  });

  it("'Select every other note' picks odd time-sorted indices", () => {
    const notes = [0, 1, 2, 3].map((b) => note({ startBeat: b }));
    const preset = LE_PRESETS.find((p) => p.name.startsWith("Select every other"))!;
    const r = applyLogicalEditor(notes, preset.program);
    expect(r.matchedIds).toEqual([notes[1].id, notes[3].id]);
  });

  it("'Accent downbeats' bumps only bar starts", () => {
    const down = note({ startBeat: 4, velocity: 80 });
    const off = note({ startBeat: 5, velocity: 80 });
    const preset = LE_PRESETS.find((p) => p.name.startsWith("Accent"))!;
    const r = applyLogicalEditor([down, off], preset.program);
    expect(r.patch.update).toEqual([{ noteId: down.id, patch: { velocity: 100 } }]);
  });
});
