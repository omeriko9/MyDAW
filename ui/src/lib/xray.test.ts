import { describe, expect, it } from "vitest";
import type { Project } from "../protocol/types";
import { computeLensValues, heatHex } from "./xray";

let nextId = 1;

function midiClip(notes: Array<{ pitch: number; velocity: number }>, lengthBeats = 4) {
  return {
    id: nextId++,
    type: "midi",
    startBeat: 0,
    lengthBeats,
    notes: notes.map((n, i) => ({ id: i + 1, startBeat: i, lengthBeats: 1, ...n })),
    cc: [],
  };
}

function audioClip() {
  return { id: nextId++, type: "audio", startBeat: 0, lengthSamples: 44100 };
}

function project(clips: unknown[][]): Project {
  return {
    tracks: clips.map((cs, i) => ({ id: 1000 + i, kind: "midi", clips: cs })),
  } as unknown as Project;
}

const note = (pitch: number, velocity = 100) => ({ pitch, velocity });

describe("computeLensValues", () => {
  it("normalizes density project-relative (min→0, max→1)", () => {
    const sparse = midiClip([note(60)], 4); // 0.25 notes/beat
    const busy = midiClip([note(60), note(62), note(64), note(65)], 2); // 2 notes/beat
    const vals = computeLensValues(project([[sparse, busy]]), "density");
    expect(vals.get(sparse.id)).toBe(0);
    expect(vals.get(busy.id)).toBe(1);
  });

  it("register flips: LOW pitch lands on the hot (1) end", () => {
    const bass = midiClip([note(36)]);
    const lead = midiClip([note(84)]);
    const vals = computeLensValues(project([[bass], [lead]]), "register");
    expect(vals.get(bass.id)).toBe(1);
    expect(vals.get(lead.id)).toBe(0);
  });

  it("energy averages velocity; flat projects map to 0.5", () => {
    const a = midiClip([note(60, 90)]);
    const b = midiClip([note(72, 90)]);
    const vals = computeLensValues(project([[a, b]]), "energy");
    expect(vals.get(a.id)).toBe(0.5);
    expect(vals.get(b.id)).toBe(0.5);
  });

  it("audio clips get no value; empty MIDI clips count as 0 density but skip register/energy", () => {
    const audio = audioClip();
    const empty = midiClip([]);
    const full = midiClip([note(60)]);
    const density = computeLensValues(project([[audio, empty, full]]), "density");
    expect(density.has(audio.id)).toBe(false);
    expect(density.get(empty.id)).toBe(0);
    const energy = computeLensValues(project([[audio, empty, full]]), "energy");
    expect(energy.has(empty.id)).toBe(false);
    expect(energy.has(full.id)).toBe(true);
  });
});

describe("heatHex", () => {
  it("hits the ramp stops and clamps outside 0..1", () => {
    expect(heatHex(0)).toBe("#4aa3e8");
    expect(heatHex(0.5)).toBe("#d8c945");
    expect(heatHex(1)).toBe("#e0504c");
    expect(heatHex(-5)).toBe("#4aa3e8");
    expect(heatHex(5)).toBe("#e0504c");
  });
});
