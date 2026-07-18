import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../protocol/types";
import {
  deleteDoubles,
  fixedLength,
  humanizeTiming,
  humanizeVelocity,
  legato,
  reverse,
  scaleVelocity,
  transpose,
  type NotesPatch,
} from "./midiFunctions";

let nextId = 1;
function note(partial: Partial<Note> = {}): Note {
  return {
    id: nextId++,
    pitch: 60,
    velocity: 100,
    startBeat: 0,
    lengthBeats: 1,
    ...partial,
  };
}

/** Apply a NotesPatch the way the store would, returning the resulting notes. */
function applyPatch(notes: Note[], patch: NotesPatch): Note[] {
  const removed = new Set(patch.remove ?? []);
  const updates = new Map((patch.update ?? []).map((u) => [u.noteId, u.patch]));
  return notes
    .filter((n) => !removed.has(n.id))
    .map((n) => ({ ...n, ...updates.get(n.id) }));
}

function patchFor(patch: NotesPatch, id: number) {
  return patch.update?.find((u) => u.noteId === id)?.patch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transpose", () => {
  it("shifts every pitch by the given semitones", () => {
    const notes = [note({ pitch: 60 }), note({ pitch: 64 }), note({ pitch: 67 })];
    const p = transpose(notes, 5);
    expect(p.update).toHaveLength(3);
    expect(applyPatch(notes, p).map((n) => n.pitch)).toEqual([65, 69, 72]);
  });

  it("clamps at 127 on the way up", () => {
    const notes = [note({ pitch: 120 })];
    expect(patchFor(transpose(notes, 12), notes[0].id)).toEqual({ pitch: 127 });
  });

  it("clamps at 0 on the way down", () => {
    const notes = [note({ pitch: 5 })];
    expect(patchFor(transpose(notes, -12), notes[0].id)).toEqual({ pitch: 0 });
  });

  it("returns an empty patch when nothing changes", () => {
    expect(transpose([note({ pitch: 60 })], 0)).toEqual({});
    // already pinned to the clamp boundary
    expect(transpose([note({ pitch: 127 })], 7)).toEqual({});
    expect(transpose([note({ pitch: 0 })], -3)).toEqual({});
  });

  it("only includes notes whose pitch actually changes", () => {
    const notes = [note({ pitch: 127 }), note({ pitch: 60 })];
    const p = transpose(notes, 2);
    expect(p.update).toHaveLength(1);
    expect(p.update![0].noteId).toBe(notes[1].id);
  });
});

describe("fixedLength", () => {
  it("gives every note the same length", () => {
    const notes = [note({ lengthBeats: 1 }), note({ lengthBeats: 0.25 })];
    const p = fixedLength(notes, 0.5);
    expect(applyPatch(notes, p).map((n) => n.lengthBeats)).toEqual([0.5, 0.5]);
  });

  it("skips notes that already have the target length", () => {
    const notes = [note({ lengthBeats: 0.5 }), note({ lengthBeats: 1 })];
    const p = fixedLength(notes, 0.5);
    expect(p.update).toHaveLength(1);
    expect(p.update![0].noteId).toBe(notes[1].id);
  });

  it("clamps the length up to a 64th note", () => {
    const notes = [note({ lengthBeats: 1 })];
    expect(patchFor(fixedLength(notes, 0), notes[0].id)).toEqual({ lengthBeats: 1 / 64 });
  });

  it("returns an empty patch when all lengths already match", () => {
    expect(fixedLength([note({ lengthBeats: 2 })], 2)).toEqual({});
  });
});

describe("legato", () => {
  it("extends each note to the next onset; the last onset keeps its length", () => {
    const notes = [
      note({ startBeat: 0, lengthBeats: 0.25 }),
      note({ startBeat: 1, lengthBeats: 0.25 }),
      note({ startBeat: 3, lengthBeats: 0.25 }),
    ];
    const out = applyPatch(notes, legato(notes));
    expect(out[0].lengthBeats).toBe(1);
    expect(out[1].lengthBeats).toBe(2);
    expect(out[2].lengthBeats).toBe(0.25); // last onset untouched
  });

  it("gives chord notes (equal starts) the same end", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0, lengthBeats: 0.5 }),
      note({ pitch: 64, startBeat: 0, lengthBeats: 2 }),
      note({ pitch: 67, startBeat: 3, lengthBeats: 1 }),
    ];
    const out = applyPatch(notes, legato(notes));
    expect(out[0].lengthBeats).toBe(3);
    expect(out[1].lengthBeats).toBe(3);
    expect(out[2].lengthBeats).toBe(1);
  });

  it("leaves every note of a final chord untouched", () => {
    const notes = [
      note({ startBeat: 0, lengthBeats: 0.5 }),
      note({ pitch: 62, startBeat: 2, lengthBeats: 4 }),
      note({ pitch: 65, startBeat: 2, lengthBeats: 1 }),
    ];
    const p = legato(notes);
    expect(p.update).toHaveLength(1);
    expect(patchFor(p, notes[0].id)).toEqual({ lengthBeats: 2 });
  });

  it("handles unsorted input", () => {
    const notes = [
      note({ startBeat: 2, lengthBeats: 1 }),
      note({ startBeat: 0, lengthBeats: 0.25 }),
    ];
    const out = applyPatch(notes, legato(notes));
    expect(out.find((n) => n.startBeat === 0)!.lengthBeats).toBe(2);
    expect(out.find((n) => n.startBeat === 2)!.lengthBeats).toBe(1);
  });

  it("returns an empty patch for fewer than two notes or already-legato notes", () => {
    expect(legato([])).toEqual({});
    expect(legato([note()])).toEqual({});
    const already = [
      note({ startBeat: 0, lengthBeats: 1 }),
      note({ startBeat: 1, lengthBeats: 1 }),
    ];
    expect(legato(already)).toEqual({});
  });
});

describe("reverse", () => {
  it("mirrors note starts within the selection's own span", () => {
    const notes = [
      note({ startBeat: 2, lengthBeats: 1 }),
      note({ startBeat: 5, lengthBeats: 1 }),
    ];
    const out = applyPatch(notes, reverse(notes));
    expect(out[0].startBeat).toBe(5);
    expect(out[1].startBeat).toBe(2);
  });

  it("keeps pitches unchanged (patches only startBeat)", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0, lengthBeats: 1 }),
      note({ pitch: 72, startBeat: 3, lengthBeats: 1 }),
    ];
    for (const u of reverse(notes).update!) {
      expect(Object.keys(u.patch)).toEqual(["startBeat"]);
    }
  });

  it("applied twice is the identity for equal-length notes", () => {
    const notes = [
      note({ startBeat: 0, lengthBeats: 0.5 }),
      note({ startBeat: 1, lengthBeats: 0.5 }),
      note({ startBeat: 2.25, lengthBeats: 0.5 }),
      note({ startBeat: 4, lengthBeats: 0.5 }),
    ];
    const once = applyPatch(notes, reverse(notes));
    const twice = applyPatch(once, reverse(once));
    expect(twice.map((n) => n.startBeat)).toEqual(notes.map((n) => n.startBeat));
  });

  it("returns an empty patch for time-symmetric material", () => {
    // outer note spans the whole range, inner note is centered: mirror = self
    const notes = [
      note({ startBeat: 0, lengthBeats: 2 }),
      note({ startBeat: 0.5, lengthBeats: 1 }),
    ];
    expect(reverse(notes)).toEqual({});
  });

  it("returns an empty patch for fewer than two notes", () => {
    expect(reverse([note()])).toEqual({});
  });
});

describe("deleteDoubles", () => {
  it("keeps the longest note of a same-pitch/same-start cluster", () => {
    const keep = note({ pitch: 60, startBeat: 1, lengthBeats: 2 });
    const short1 = note({ pitch: 60, startBeat: 1, lengthBeats: 1 });
    const short2 = note({ pitch: 60, startBeat: 1, lengthBeats: 0.5 });
    const p = deleteDoubles([short1, keep, short2]);
    expect(p.remove!.sort()).toEqual([short1.id, short2.id].sort());
  });

  it("breaks length ties by keeping the highest velocity", () => {
    const loud = note({ pitch: 60, startBeat: 0, lengthBeats: 1, velocity: 110 });
    const quiet = note({ pitch: 60, startBeat: 0, lengthBeats: 1, velocity: 40 });
    expect(deleteDoubles([quiet, loud]).remove).toEqual([quiet.id]);
  });

  it("treats nearly-identical starts as doubles", () => {
    const a = note({ pitch: 60, startBeat: 1, lengthBeats: 1 });
    const b = note({ pitch: 60, startBeat: 1 + 1e-5, lengthBeats: 0.5 });
    expect(deleteDoubles([a, b]).remove).toEqual([b.id]);
  });

  it("leaves different pitches at the same start untouched", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0 }),
      note({ pitch: 64, startBeat: 0 }),
      note({ pitch: 67, startBeat: 0 }),
    ];
    expect(deleteDoubles(notes)).toEqual({});
  });

  it("leaves same pitch at clearly different starts untouched", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0 }),
      note({ pitch: 60, startBeat: 1 }),
    ];
    expect(deleteDoubles(notes)).toEqual({});
  });
});

describe("scaleVelocity", () => {
  it("applies velocity = velocity * mul + add", () => {
    const notes = [note({ velocity: 50 }), note({ velocity: 60 })];
    const out = applyPatch(notes, scaleVelocity(notes, 1.5, 10));
    expect(out.map((n) => n.velocity)).toEqual([85, 100]);
  });

  it("clamps to 127 at the top", () => {
    const notes = [note({ velocity: 120 })];
    expect(patchFor(scaleVelocity(notes, 2, 0), notes[0].id)).toEqual({ velocity: 127 });
  });

  it("clamps to 1 at the bottom (velocity 0 is not a valid note)", () => {
    const notes = [note({ velocity: 10 })];
    expect(patchFor(scaleVelocity(notes, 0, 0), notes[0].id)).toEqual({ velocity: 1 });
    expect(patchFor(scaleVelocity(notes, 1, -100), notes[0].id)).toEqual({ velocity: 1 });
  });

  it("returns an empty patch for the identity transform", () => {
    expect(scaleVelocity([note({ velocity: 64 })], 1, 0)).toEqual({});
  });
});

describe("humanizeTiming", () => {
  it("returns an empty patch for non-positive amounts", () => {
    expect(humanizeTiming([note()], 0)).toEqual({});
    expect(humanizeTiming([note()], -1)).toEqual({});
  });

  it("keeps every start within ±maxBeats and never before beat 0 (fuzz)", () => {
    const max = 0.25;
    const notes: Note[] = [];
    for (let i = 0; i < 500; i++) {
      notes.push(note({ startBeat: Math.random() * 2 })); // many near beat 0
    }
    const out = applyPatch(notes, humanizeTiming(notes, max));
    for (let i = 0; i < notes.length; i++) {
      expect(out[i].startBeat).toBeGreaterThanOrEqual(0);
      expect(out[i].startBeat).toBeGreaterThanOrEqual(Math.max(0, notes[i].startBeat - max));
      expect(out[i].startBeat).toBeLessThanOrEqual(notes[i].startBeat + max);
    }
  });

  it("clamps the most negative offset to beat 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // offset = -maxBeats exactly
    const notes = [note({ startBeat: 0.1 })];
    expect(patchFor(humanizeTiming(notes, 0.5), notes[0].id)).toEqual({ startBeat: 0 });
  });
});

describe("humanizeVelocity", () => {
  it("returns an empty patch for non-positive amounts", () => {
    expect(humanizeVelocity([note()], 0)).toEqual({});
    expect(humanizeVelocity([note()], -5)).toEqual({});
  });

  it("keeps every velocity within ±amount and inside 1..127 (fuzz)", () => {
    const amount = 20;
    const notes: Note[] = [];
    for (let i = 0; i < 500; i++) {
      notes.push(note({ velocity: 1 + Math.floor(Math.random() * 127) }));
    }
    const out = applyPatch(notes, humanizeVelocity(notes, amount));
    for (let i = 0; i < notes.length; i++) {
      expect(out[i].velocity).toBeGreaterThanOrEqual(Math.max(1, notes[i].velocity - amount));
      expect(out[i].velocity).toBeLessThanOrEqual(Math.min(127, notes[i].velocity + amount));
    }
  });

  it("clamps at both velocity bounds", () => {
    const rnd = vi.spyOn(Math, "random");
    rnd.mockReturnValue(0); // offset = -amount
    const low = [note({ velocity: 5 })];
    expect(patchFor(humanizeVelocity(low, 30), low[0].id)).toEqual({ velocity: 1 });
    rnd.mockReturnValue(0.9999999); // offset ≈ +amount
    const high = [note({ velocity: 125 })];
    expect(patchFor(humanizeVelocity(high, 30), high[0].id)).toEqual({ velocity: 127 });
  });
});
