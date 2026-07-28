import { afterEach, describe, expect, it, vi } from "vitest";
import type { MidiCc, Note } from "../protocol/types";
import {
  compressVelocity,
  deleteContinuousCc,
  deleteControllers,
  deleteDoubles,
  deleteNotes,
  deleteOverlapsMono,
  deleteOverlapsPoly,
  fixedLength,
  fixedVelocity,
  humanizeTiming,
  humanizeVelocity,
  legato,
  limitVelocity,
  mirror,
  pedalsToNoteLength,
  rampVelocity,
  restrictPolyphony,
  reverse,
  scaleVelocity,
  smoothVelocity,
  thinOutCc,
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

describe("rampVelocity", () => {
  it("blends from→to linearly across the selection's time span", () => {
    const notes = [
      note({ startBeat: 0, velocity: 100 }),
      note({ startBeat: 2, velocity: 100 }),
      note({ startBeat: 4, velocity: 100 }),
    ];
    const out = applyPatch(notes, rampVelocity(notes, 40, 120));
    expect(out.map((n) => n.velocity)).toEqual([40, 80, 120]);
  });

  it("is order-independent (position, not array order, decides the blend)", () => {
    const notes = [
      note({ startBeat: 4, velocity: 1 }),
      note({ startBeat: 0, velocity: 1 }),
    ];
    const p = rampVelocity(notes, 20, 100);
    expect(patchFor(p, notes[0].id)).toEqual({ velocity: 100 });
    expect(patchFor(p, notes[1].id)).toEqual({ velocity: 20 });
  });

  it("zero span / single note takes `from`; velocities clamp to 1..127", () => {
    const one = [note({ startBeat: 3, velocity: 64 })];
    expect(patchFor(rampVelocity(one, 200, 50), one[0].id)).toEqual({ velocity: 127 });
    const chord = [note({ startBeat: 1, velocity: 9 }), note({ startBeat: 1, velocity: 9 })];
    const p = rampVelocity(chord, -20, 80);
    expect(patchFor(p, chord[0].id)).toEqual({ velocity: 1 });
    expect(patchFor(p, chord[1].id)).toEqual({ velocity: 1 });
  });

  it("returns an empty patch when nothing changes", () => {
    const notes = [note({ startBeat: 0, velocity: 40 }), note({ startBeat: 2, velocity: 120 })];
    expect(rampVelocity(notes, 40, 120)).toEqual({});
  });
});

describe("smoothVelocity", () => {
  it("ramps between the first and last note's existing velocities", () => {
    const notes = [
      note({ startBeat: 0, velocity: 60 }),
      note({ startBeat: 1, velocity: 127 }),
      note({ startBeat: 2, velocity: 100 }),
    ];
    const out = applyPatch(notes, smoothVelocity(notes));
    expect(out.map((n) => n.velocity)).toEqual([60, 80, 100]);
  });

  it("needs at least three notes", () => {
    const notes = [note({ startBeat: 0 }), note({ startBeat: 1, velocity: 20 })];
    expect(smoothVelocity(notes)).toEqual({});
  });
});

describe("legato overlap parameter", () => {
  it("positive overlap reaches into the next note", () => {
    const notes = [
      note({ startBeat: 0, lengthBeats: 0.25 }),
      note({ startBeat: 2, lengthBeats: 1 }),
    ];
    const out = applyPatch(notes, legato(notes, 0.5));
    expect(out[0].lengthBeats).toBe(2.5);
  });

  it("negative overlap leaves a gap", () => {
    const notes = [
      note({ startBeat: 0, lengthBeats: 3 }),
      note({ startBeat: 2, lengthBeats: 1 }),
    ];
    const out = applyPatch(notes, legato(notes, -0.5));
    expect(out[0].lengthBeats).toBe(1.5);
  });
});

describe("deleteOverlapsMono", () => {
  it("trims a note that overlaps the next note of the same pitch", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0, lengthBeats: 3 }),
      note({ pitch: 60, startBeat: 2, lengthBeats: 1 }),
    ];
    const out = applyPatch(notes, deleteOverlapsMono(notes));
    expect(out[0].lengthBeats).toBe(2);
    expect(out[1].lengthBeats).toBe(1);
  });

  it("ignores overlaps between different pitches", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0, lengthBeats: 4 }),
      note({ pitch: 64, startBeat: 2, lengthBeats: 1 }),
    ];
    expect(deleteOverlapsMono(notes)).toEqual({});
  });

  it("treats channels separately", () => {
    const notes = [
      note({ pitch: 60, channel: 0, startBeat: 0, lengthBeats: 4 }),
      note({ pitch: 60, channel: 1, startBeat: 2, lengthBeats: 1 }),
    ];
    expect(deleteOverlapsMono(notes)).toEqual({});
  });

  it("returns an empty patch when nothing overlaps", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0, lengthBeats: 1 }),
      note({ pitch: 60, startBeat: 2, lengthBeats: 1 }),
    ];
    expect(deleteOverlapsMono(notes)).toEqual({});
  });
});

describe("deleteOverlapsPoly", () => {
  it("trims any note reaching past the next distinct onset", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0, lengthBeats: 4 }),
      note({ pitch: 72, startBeat: 1.5, lengthBeats: 1 }),
    ];
    const out = applyPatch(notes, deleteOverlapsPoly(notes));
    expect(out[0].lengthBeats).toBe(1.5);
  });

  it("keeps chords (equal starts) intact", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0, lengthBeats: 2 }),
      note({ pitch: 64, startBeat: 0, lengthBeats: 2 }),
    ];
    expect(deleteOverlapsPoly(notes)).toEqual({});
  });

  it("trims every member of a chord at the next onset", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0, lengthBeats: 3 }),
      note({ pitch: 64, startBeat: 0, lengthBeats: 4 }),
      note({ pitch: 67, startBeat: 2, lengthBeats: 1 }),
    ];
    const out = applyPatch(notes, deleteOverlapsPoly(notes));
    expect(out[0].lengthBeats).toBe(2);
    expect(out[1].lengthBeats).toBe(2);
    expect(out[2].lengthBeats).toBe(1);
  });
});

describe("fixedVelocity", () => {
  it("sets every note to the target velocity", () => {
    const notes = [note({ velocity: 30 }), note({ velocity: 90 })];
    const out = applyPatch(notes, fixedVelocity(notes, 100));
    expect(out.map((n) => n.velocity)).toEqual([100, 100]);
  });

  it("returns an empty patch when all notes already match", () => {
    expect(fixedVelocity([note({ velocity: 64 })], 64)).toEqual({});
  });
});

describe("limitVelocity", () => {
  it("clamps into [min, max] and leaves in-range notes alone", () => {
    const notes = [note({ velocity: 10 }), note({ velocity: 64 }), note({ velocity: 120 })];
    const p = limitVelocity(notes, 32, 112);
    expect(p.update).toHaveLength(2);
    expect(applyPatch(notes, p).map((n) => n.velocity)).toEqual([32, 64, 112]);
  });

  it("tolerates swapped bounds", () => {
    const notes = [note({ velocity: 10 })];
    expect(patchFor(limitVelocity(notes, 112, 32), notes[0].id)).toEqual({ velocity: 32 });
  });
});

describe("compressVelocity", () => {
  it("compresses toward the center with ratio < 1", () => {
    const notes = [note({ velocity: 34 }), note({ velocity: 94 })];
    const out = applyPatch(notes, compressVelocity(notes, 0.5, 64));
    expect(out.map((n) => n.velocity)).toEqual([49, 79]);
  });

  it("expands away from the center with ratio > 1 (clamped)", () => {
    const notes = [note({ velocity: 54 }), note({ velocity: 120 })];
    const out = applyPatch(notes, compressVelocity(notes, 2, 64));
    expect(out.map((n) => n.velocity)).toEqual([44, 127]);
  });
});

describe("deleteNotes", () => {
  it("removes notes below the velocity threshold", () => {
    const quiet = note({ velocity: 10 });
    const loud = note({ velocity: 100 });
    expect(deleteNotes([quiet, loud], { minVelocity: 20 }).remove).toEqual([quiet.id]);
  });

  it("removes notes below the length threshold", () => {
    const short = note({ lengthBeats: 0.05 });
    const long = note({ lengthBeats: 1 });
    expect(deleteNotes([short, long], { minLengthBeats: 0.125 }).remove).toEqual([short.id]);
  });

  it("either criterion removes (OR semantics)", () => {
    const quiet = note({ velocity: 5, lengthBeats: 1 });
    const short = note({ velocity: 100, lengthBeats: 0.01 });
    const ok = note({ velocity: 100, lengthBeats: 1 });
    const p = deleteNotes([quiet, short, ok], { minVelocity: 20, minLengthBeats: 0.1 });
    expect(p.remove!.sort()).toEqual([quiet.id, short.id].sort());
  });

  it("a note exactly AT a threshold survives", () => {
    const n = note({ velocity: 20, lengthBeats: 0.125 });
    expect(deleteNotes([n], { minVelocity: 20, minLengthBeats: 0.125 })).toEqual({});
  });
});

describe("mirror", () => {
  it("swaps the outer voices around the default midpoint axis", () => {
    const notes = [note({ pitch: 60 }), note({ pitch: 64 }), note({ pitch: 72 })];
    const out = applyPatch(notes, mirror(notes));
    expect(out.map((n) => n.pitch)).toEqual([72, 68, 60]);
  });

  it("is an involution (applying twice restores the input)", () => {
    const notes = [note({ pitch: 55 }), note({ pitch: 67 }), note({ pitch: 62 })];
    const once = applyPatch(notes, mirror(notes));
    const twice = applyPatch(once, mirror(once));
    expect(twice.map((n) => n.pitch)).toEqual(notes.map((n) => n.pitch));
  });

  it("honors an explicit axis", () => {
    const notes = [note({ pitch: 62 })];
    expect(patchFor(mirror(notes, 60), notes[0].id)).toEqual({ pitch: 58 });
  });

  it("returns an empty patch for symmetric material", () => {
    expect(mirror([note({ pitch: 60 })])).toEqual({});
  });
});

describe("restrictPolyphony", () => {
  it("truncates the oldest sounding note when the limit is exceeded", () => {
    const notes = [
      note({ pitch: 60, startBeat: 0, lengthBeats: 4 }),
      note({ pitch: 64, startBeat: 1, lengthBeats: 4 }),
      note({ pitch: 67, startBeat: 2, lengthBeats: 1 }),
    ];
    const out = applyPatch(notes, restrictPolyphony(notes, 2));
    expect(out[0].lengthBeats).toBe(2); // truncated at the third onset
    expect(out[1].lengthBeats).toBe(4);
    expect(out[2].lengthBeats).toBe(1);
  });

  it("removes a chord note that would be truncated to nothing", () => {
    const weak = note({ pitch: 60, startBeat: 0, lengthBeats: 2, velocity: 30 });
    const mid = note({ pitch: 64, startBeat: 0, lengthBeats: 2, velocity: 80 });
    const strong = note({ pitch: 67, startBeat: 0, lengthBeats: 2, velocity: 120 });
    const p = restrictPolyphony([weak, mid, strong], 2);
    expect(p.remove).toEqual([weak.id]);
  });

  it("leaves material within the limit untouched", () => {
    const notes = [
      note({ startBeat: 0, lengthBeats: 1 }),
      note({ pitch: 64, startBeat: 2, lengthBeats: 1 }),
    ];
    expect(restrictPolyphony(notes, 2)).toEqual({});
  });
});

/* ---- controller-lane functions ---- */

let nextCcId = 1000;
function ccPoint(partial: Partial<MidiCc> = {}): MidiCc {
  return { id: nextCcId++, controller: 1, beat: 0, value: 0.5, ...partial };
}

describe("thinOutCc", () => {
  it("drops points on a straight line and keeps curve corners", () => {
    const lane = [
      ccPoint({ beat: 0, value: 0 }),
      ccPoint({ beat: 1, value: 0.25 }), // exactly on the 0→2 line
      ccPoint({ beat: 2, value: 0.5 }),
      ccPoint({ beat: 3, value: 0.1 }), // sharp corner — must survive
      ccPoint({ beat: 4, value: 0.1 }),
    ];
    const p = thinOutCc(lane, 0.02);
    expect(p.remove).toEqual([lane[1].id]);
  });

  it("keeps endpoints and treats lanes independently", () => {
    const a = [
      ccPoint({ controller: 1, beat: 0, value: 0 }),
      ccPoint({ controller: 1, beat: 1, value: 0.5 }),
      ccPoint({ controller: 1, beat: 2, value: 1 }),
    ];
    const b = [
      ccPoint({ controller: 7, beat: 0, value: 1 }),
      ccPoint({ controller: 7, beat: 2, value: 0 }),
    ];
    const p = thinOutCc([...a, ...b], 0.02);
    expect(p.remove).toEqual([a[1].id]); // only the collinear midpoint of lane 1
  });

  it("returns an empty patch when every point matters", () => {
    const lane = [
      ccPoint({ beat: 0, value: 0 }),
      ccPoint({ beat: 1, value: 1 }),
      ccPoint({ beat: 2, value: 0 }),
    ];
    expect(thinOutCc(lane, 0.02)).toEqual({});
  });
});

describe("deleteControllers / deleteContinuousCc", () => {
  it("deleteControllers removes everything", () => {
    const cc = [ccPoint(), ccPoint({ controller: 64 }), ccPoint({ controller: 128 })];
    expect(deleteControllers(cc).remove).toEqual(cc.map((c) => c.id));
    expect(deleteControllers([])).toEqual({});
  });

  it("deleteContinuousCc keeps pedal switches (CC64–69), drops curves/bend/aftertouch", () => {
    const mod = ccPoint({ controller: 1 });
    const sustain = ccPoint({ controller: 64 });
    const soft = ccPoint({ controller: 67 });
    const bend = ccPoint({ controller: 128 });
    const at = ccPoint({ controller: 129 });
    const p = deleteContinuousCc([mod, sustain, soft, bend, at]);
    expect(p.remove!.sort()).toEqual([mod.id, bend.id, at.id].sort());
  });
});

describe("pedalsToNoteLength", () => {
  it("extends a note released during a pedal-down span to the pedal-up point", () => {
    const n = note({ startBeat: 0, lengthBeats: 1 });
    const down = ccPoint({ controller: 64, beat: 0.5, value: 1 });
    const up = ccPoint({ controller: 64, beat: 3, value: 0 });
    const p = pedalsToNoteLength([n], [down, up], 8);
    expect(p.notes!.update).toEqual([{ noteId: n.id, patch: { lengthBeats: 3 } }]);
    expect(p.cc!.remove!.sort()).toEqual([down.id, up.id].sort());
  });

  it("leaves notes alone that end outside pedal spans, still deletes the pedal events", () => {
    const n = note({ startBeat: 0, lengthBeats: 1 });
    const down = ccPoint({ controller: 64, beat: 2, value: 1 });
    const up = ccPoint({ controller: 64, beat: 3, value: 0 });
    const p = pedalsToNoteLength([n], [down, up], 8);
    expect(p.notes).toBeUndefined();
    expect(p.cc!.remove).toHaveLength(2);
  });

  it("a never-released pedal extends to the clip end", () => {
    const n = note({ startBeat: 0, lengthBeats: 2 });
    const down = ccPoint({ controller: 64, beat: 1, value: 1 });
    const p = pedalsToNoteLength([n], [down], 8);
    expect(p.notes!.update).toEqual([{ noteId: n.id, patch: { lengthBeats: 8 } }]);
  });

  it("no pedal events → empty result", () => {
    expect(pedalsToNoteLength([note()], [ccPoint({ controller: 1 })], 8)).toEqual({});
  });

  it("ignores non-CC64 controllers when building spans", () => {
    const n = note({ startBeat: 0, lengthBeats: 1 });
    const mod = ccPoint({ controller: 1, beat: 0.5, value: 1 });
    expect(pedalsToNoteLength([n], [mod], 8)).toEqual({});
  });
});
