import { describe, expect, it } from "vitest";
import { TECHNIQUES, techniqueById } from "./catalog";
import { CATEGORY_ORDER } from "./types";
import type { TechniqueCtx } from "./types";
import { BUILTIN_PARAM_SPECS, linNorm, logNorm, normFor } from "./norm";
import type { Project, Track } from "../protocol/types";

/** Minimal fake ctx — requirements() and param defaults must not throw on it. */
function fakeCtx(): TechniqueCtx {
  const track = (id: number, kind: Track["kind"], name: string): Track =>
    ({
      id,
      kind,
      name,
      color: "",
      channels: 2,
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      recordArm: false,
      outputTarget: "master",
      sends: [],
      inserts: [],
      eq: { bypass: true, bands: [] },
      clips: [],
    }) as unknown as Track;
  const project = {
    name: "t",
    sampleRate: 48000,
    tempoMap: [{ beat: 0, bpm: 120 }],
    timeSigMap: [{ bar: 0, num: 4, den: 4 }],
    tracks: [track(1, "audio", "Vocal"), track(2, "instrument", "Keys"), track(3, "bus", "Bus A")],
    masterTrack: track(99, "master", "Master"),
  } as unknown as Project;
  return {
    project,
    selection: { trackIds: [], clipIds: [], noteIds: [] },
    bpm: 120,
    beatsPerBar: 4,
    playheadBeat: 0,
  };
}

describe("technique catalog integrity", () => {
  it("ships 10 techniques, 2 per category", () => {
    expect(TECHNIQUES.length).toBe(10);
    for (const cat of CATEGORY_ORDER)
      expect(TECHNIQUES.filter((t) => t.category === cat).length).toBe(2);
  });

  it("ids are unique and kebab-case", () => {
    const ids = TECHNIQUES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(techniqueById("sidechain-pump")?.title).toBe("Sidechain Pump");
  });

  it("every technique has 2–4 stages, each with summary AND manual instructions", () => {
    for (const t of TECHNIQUES) {
      expect(t.stages.length, t.id).toBeGreaterThanOrEqual(2);
      expect(t.stages.length, t.id).toBeLessThanOrEqual(4);
      expect(t.description.length, t.id).toBeGreaterThan(40);
      const stageIds = new Set(t.stages.map((s) => s.id));
      expect(stageIds.size, t.id).toBe(t.stages.length);
      for (const s of t.stages) {
        expect(s.summary.length, `${t.id}/${s.id} summary`).toBeGreaterThan(20);
        expect(s.manual.length, `${t.id}/${s.id} manual`).toBeGreaterThan(20);
      }
    }
  });

  it("requirements and param defaults evaluate against a bare project", () => {
    const ctx = fakeCtx();
    for (const t of TECHNIQUES) {
      const reqs = t.requirements(ctx);
      for (const r of reqs) expect(typeof r.ok, `${t.id} req`).toBe("boolean");
      for (const s of t.stages)
        for (const p of s.params ?? []) {
          const v = p.default(ctx);
          expect(v === null || v === undefined, `${t.id}/${s.id}/${p.key} default`).toBe(false);
        }
    }
  });
});

describe("builtin param normalization mirror", () => {
  it("linear + log mappings match the Effects.cpp defaults", () => {
    // Compressor Threshold default −18 in [−60, 0] (Effects.cpp:206)
    expect(linNorm(-18, -60, 0)).toBeCloseTo(0.7, 10);
    // Delay Time default 300 ms in [1, 2000] (Effects.cpp:318)
    expect(linNorm(300, 1, 2000)).toBeCloseTo(299 / 1999, 10);
    // Compressor Ratio default 4 in log [1, 20] (Effects.cpp:207)
    expect(logNorm(4, 1, 20)).toBeCloseTo(Math.log(4) / Math.log(20), 10);
  });

  it("normFor covers the params the shipped techniques set (unknown name throws)", () => {
    expect(() => normFor("builtin:compressor", "Nope", 1)).toThrow();
    expect(normFor("builtin:delay", "Ping-Pong", 1)).toBe(1); // stepped: index / (steps-1)
    expect(normFor("builtin:reverb", "Mix", 100)).toBe(1);
    expect(normFor("builtin:limiter", "Ceiling", -1)).toBeCloseTo(23 / 24, 10);
    // spot-check the spec table stays in the uid namespaces techniques use
    for (const uid of [
      "builtin:compressor",
      "builtin:limiter",
      "builtin:delay",
      "builtin:reverb",
      "builtin:sampler",
      "builtin:polysynth",
    ])
      expect(Object.keys(BUILTIN_PARAM_SPECS[uid]).length, uid).toBeGreaterThan(1);
  });
});
