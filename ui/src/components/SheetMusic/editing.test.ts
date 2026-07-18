import { describe, expect, it } from "vitest";
import type { MidiClip, Note } from "../../protocol/types";
import {
  deleteNotes,
  joinNotes,
  legatoNotes,
  prunePatches,
  resolveNotes,
  setLength,
  setVelocity,
  splitAtBeat,
  splitNotes,
  transposeNotes,
  type NoteRef,
} from "./editing";

const note = (id: number, startBeat: number, lengthBeats: number, pitch: number, velocity = 90): Note => ({
  id,
  pitch,
  velocity,
  startBeat,
  lengthBeats,
});

const clip = (id: number, startBeat: number, notes: Note[]): MidiClip => ({
  id,
  type: "midi",
  name: `clip${id}`,
  startBeat,
  lengthBeats: 16,
  notes,
});

const refs = (c: MidiClip, ids: number[]): NoteRef[] => resolveNotes([c], ids);

describe("resolveNotes", () => {
  it("finds notes across clips and drops stale ids", () => {
    const a = clip(1, 0, [note(10, 0, 1, 60), note(11, 1, 1, 62)]);
    const b = clip(2, 8, [note(20, 0, 1, 64)]);
    const got = resolveNotes([a, b], [10, 20, 999]);
    expect(got.map((r) => r.note.id)).toEqual([10, 20]);
    expect(got[1].clip.id).toBe(2);
  });

  it("sorts by absolute position, not clip-relative", () => {
    const a = clip(1, 8, [note(10, 0, 1, 60)]); // absolute beat 8
    const b = clip(2, 0, [note(20, 4, 1, 64)]); // absolute beat 4
    expect(resolveNotes([a, b], [10, 20]).map((r) => r.note.id)).toEqual([20, 10]);
  });
});

describe("delete / set length / transpose / velocity", () => {
  const c = clip(1, 0, [note(10, 0, 1, 60), note(11, 2, 1, 64)]);

  it("removes by id, grouped per clip", () => {
    const p = deleteNotes(refs(c, [10, 11]));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ clipId: 1, remove: [10, 11] });
  });

  it("sets an exact length", () => {
    const p = setLength(refs(c, [10]), 1.5);
    expect(p[0].update).toEqual([{ noteId: 10, patch: { lengthBeats: 1.5 } }]);
  });

  it("never sets a length below the floor", () => {
    const p = setLength(refs(c, [10]), 0);
    expect(p[0].update![0].patch.lengthBeats).toBeGreaterThan(0);
  });

  it("transposes and clamps to the MIDI range", () => {
    expect(transposeNotes(refs(c, [10]), 12)[0].update![0].patch.pitch).toBe(72);
    const high = clip(1, 0, [note(10, 0, 1, 120)]);
    expect(transposeNotes(refs(high, [10]), 24)[0].update![0].patch.pitch).toBe(127);
  });

  it("clamps velocity to 1..127", () => {
    expect(setVelocity(refs(c, [10]), 500)[0].update![0].patch.velocity).toBe(127);
    expect(setVelocity(refs(c, [10]), -5)[0].update![0].patch.velocity).toBe(1);
  });
});

describe("join", () => {
  it("merges same-pitch notes into one spanning note", () => {
    const c = clip(1, 0, [note(10, 0, 1, 60), note(11, 1, 1, 60), note(12, 2, 1, 60)]);
    const { patches, merged } = joinNotes(refs(c, [10, 11, 12]));
    expect(merged).toBe(2);
    const p = patches[0];
    // the earliest note survives and now covers all three
    expect(p.update).toEqual([{ noteId: 10, patch: { lengthBeats: 3 } }]);
    expect(p.remove).toEqual([11, 12]);
  });

  it("spans a gap between the notes it merges", () => {
    const c = clip(1, 0, [note(10, 0, 1, 60), note(11, 4, 2, 60)]);
    const { patches } = joinNotes(refs(c, [10, 11]));
    expect(patches[0].update![0].patch.lengthBeats).toBe(6); // 0 → 6
  });

  it("leaves different pitches alone (a chord is not joinable)", () => {
    const c = clip(1, 0, [note(10, 0, 1, 60), note(11, 0, 1, 64)]);
    const { merged } = joinNotes(refs(c, [10, 11]));
    expect(merged).toBe(0);
  });

  it("does nothing with a single note", () => {
    const c = clip(1, 0, [note(10, 0, 1, 60)]);
    expect(joinNotes(refs(c, [10])).merged).toBe(0);
  });

  it("does NOT merge across clips", () => {
    // The survivor would have to grow past its own clip's bounds, where the engine would
    // stop playing it — so same-pitch notes in different clips are deliberately left alone.
    const a = clip(1, 0, [note(10, 0, 1, 60)]);
    const b = clip(2, 4, [note(20, 0, 1, 60)]);
    expect(joinNotes(resolveNotes([a, b], [10, 20])).merged).toBe(0);
  });

  it("uses absolute positions when merging within a clip", () => {
    // clip starts at beat 8; notes are clip-relative, so the merge must not mix frames
    const c = clip(1, 8, [note(10, 0, 1, 60), note(11, 3, 1, 60)]);
    const { patches, merged } = joinNotes(refs(c, [10, 11]));
    expect(merged).toBe(1);
    expect(patches[0].update![0].patch.lengthBeats).toBe(4);
  });
});

describe("split", () => {
  it("cuts a note into equal pieces, keeping the original id", () => {
    const c = clip(1, 0, [note(10, 0, 2, 60)]);
    const { patches, split } = splitNotes(refs(c, [10]), 4);
    expect(split).toBe(1);
    const p = patches[0];
    expect(p.update).toEqual([{ noteId: 10, patch: { lengthBeats: 0.5 } }]);
    expect(p.add).toHaveLength(3);
    expect(p.add!.map((n) => n.startBeat)).toEqual([0.5, 1, 1.5]);
    expect(p.add!.every((n) => n.lengthBeats === 0.5 && n.pitch === 60)).toBe(true);
  });

  it("conserves total duration", () => {
    const c = clip(1, 0, [note(10, 0, 3, 60)]);
    const { patches } = splitNotes(refs(c, [10]), 3);
    const total =
      patches[0].update![0].patch.lengthBeats! +
      patches[0].add!.reduce((s, n) => s + n.lengthBeats, 0);
    expect(total).toBeCloseTo(3);
  });

  it("refuses to make unreadably short notes", () => {
    const c = clip(1, 0, [note(10, 0, 0.0625, 60)]);
    expect(splitNotes(refs(c, [10]), 4).split).toBe(0);
  });

  it("splits at an absolute beat", () => {
    const c = clip(1, 4, [note(10, 0, 4, 60)]); // absolute beats 4..8
    const { patches, split } = splitAtBeat(refs(c, [10]), 6);
    expect(split).toBe(1);
    expect(patches[0].update![0].patch.lengthBeats).toBe(2);
    expect(patches[0].add![0]).toMatchObject({ startBeat: 2, lengthBeats: 2, pitch: 60 });
  });

  it("ignores a split point outside the note", () => {
    const c = clip(1, 0, [note(10, 0, 1, 60)]);
    expect(splitAtBeat(refs(c, [10]), 50).split).toBe(0);
    expect(splitAtBeat(refs(c, [10]), 0).split).toBe(0);
  });
});

describe("legato", () => {
  it("extends each note to the next", () => {
    const c = clip(1, 0, [note(10, 0, 0.5, 60), note(11, 2, 0.5, 62), note(12, 3, 1, 64)]);
    const p = legatoNotes(refs(c, [10, 11, 12]));
    expect(p[0].update).toEqual([
      { noteId: 10, patch: { lengthBeats: 2 } },
      { noteId: 11, patch: { lengthBeats: 1 } },
    ]);
  });
});

describe("prunePatches", () => {
  it("drops patches that would be a no-op edit", () => {
    expect(
      prunePatches([
        { clipId: 1, add: [], remove: [], update: [] },
        { clipId: 2, remove: [5] },
      ]),
    ).toEqual([{ clipId: 2, remove: [5] }]);
  });
});
