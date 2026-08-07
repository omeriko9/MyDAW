import { describe, expect, it } from "vitest";
import { GUIDE_STAGES, contentBars, evaluateGuide, suggestedCount } from "./guide";
import { techniqueById } from "./catalog";
import type { TechniqueCtx } from "./types";
import type { PluginInstance, Project, Track } from "../protocol/types";

/* --------------------------------------------------------------- fixtures */

let nextId = 1;

function trk(over: Partial<Track> & { name: string }): Track {
  return {
    id: nextId++,
    kind: "audio",
    color: "",
    channels: 2,
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    recordArm: false,
    outputTarget: "master",
    inserts: [],
    sends: [],
    automation: [],
    clips: [],
    ...over,
  } as unknown as Track;
}

const midiClip = (startBeat = 0, lengthBeats = 16) =>
  ({ id: nextId++, type: "midi", name: "", startBeat, lengthBeats, notes: [] }) as Track["clips"][number];

const audioClip = (startBeat = 0, lengthSamples = 48000) =>
  ({ id: nextId++, type: "audio", name: "", startBeat, assetId: 1, srcOffsetSamples: 0,
     lengthSamples, gain: 1, fadeInSec: 0, fadeOutSec: 0 }) as Track["clips"][number];

const insert = (uid: string, over: Partial<PluginInstance> = {}) =>
  ({ instanceId: nextId++, uid, name: uid, ...over }) as unknown as PluginInstance;

function ctxOf(tracks: Track[], over: Partial<Project> = {}): TechniqueCtx {
  const project = {
    name: "t",
    sampleRate: 48000,
    tracks,
    masterTrack: trk({ name: "Master", kind: "master" as Track["kind"] }),
    markers: [],
    tempoMap: [{ beat: 0, bpm: 120 }],
    timeSigMap: [{ beat: 0, num: 4, den: 4 }],
    loop: { startBeat: 0, endBeat: 0, enabled: false },
    ...over,
  } as unknown as Project;
  return { project, selection: { trackIds: [], clipIds: [], noteIds: [] }, bpm: 120, beatsPerBar: 4, playheadBeat: 0 } as TechniqueCtx;
}

const goal = (id: string) => {
  for (const s of GUIDE_STAGES) for (const g of s.goals) if (g.id === id) return g;
  throw new Error(`no goal ${id}`);
};

/* ------------------------------------------------------------- integrity */

describe("guide catalog integrity", () => {
  it("every means resolves to a real technique", () => {
    for (const s of GUIDE_STAGES)
      for (const g of s.goals)
        for (const m of g.means)
          expect(techniqueById(m.techniqueId), `${s.id}/${g.id} → ${m.techniqueId}`).toBeTruthy();
  });

  it("goal ids are unique and every goal explains itself", () => {
    const ids = new Set<string>();
    for (const s of GUIDE_STAGES)
      for (const g of s.goals) {
        expect(ids.has(g.id), g.id).toBe(false);
        ids.add(g.id);
        expect(g.title.length).toBeGreaterThan(0);
        expect(g.why.length).toBeGreaterThan(20);
        expect(g.hear.length).toBeGreaterThan(10);
        for (const m of g.means) expect(m.when.length, `${g.id}/${m.techniqueId}`).toBeGreaterThan(10);
        // A goal with no wizard must still tell you what to do (SPEC §10: no dead rows).
        if (g.means.length === 0) expect(g.byHand, g.id).toBeTruthy();
      }
  });

  it("every relevance rule returns a valid status + grounded note on an empty project", () => {
    for (const e of evaluateGuide(ctxOf([]))) {
      expect(["suggested", "open", "done", "na"]).toContain(e.relevance.status);
      expect(e.relevance.note.length, e.goal.id).toBeGreaterThan(10);
    }
  });
});

/* ------------------------------------------------------------- relevance */

describe("relevance rules read the actual project", () => {
  it("kick-bass: na without the pair, suggested with it, done once a sidechain exists", () => {
    expect(goal("kick-bass").relevance(ctxOf([])).status).toBe("na");

    const kick = trk({ name: "Kick", clips: [audioClip()] });
    const bass = trk({ name: "Bass 808", kind: "instrument" as Track["kind"], clips: [midiClip()] });
    const r = goal("kick-bass").relevance(ctxOf([kick, bass]));
    expect(r.status).toBe("suggested");
    expect(r.note).toContain("Kick");
    expect(r.note).toContain("Bass 808");

    const ducked = trk({
      name: "Bass 808",
      clips: [midiClip()],
      inserts: [insert("builtin:compressor", { sidechainSource: kick.id })],
    });
    expect(goal("kick-bass").relevance(ctxOf([kick, ducked])).status).toBe("done");
  });

  it("clean-takes: suggested for a gateless vocal recording, done once gated, na without vocals", () => {
    expect(goal("clean-takes").relevance(ctxOf([])).status).toBe("na");
    const vox = trk({ name: "Lead Vox", clips: [audioClip()] });
    expect(goal("clean-takes").relevance(ctxOf([vox])).status).toBe("suggested");
    const gated = trk({ name: "Lead Vox", clips: [audioClip()], inserts: [insert("builtin:gate")] });
    expect(goal("clean-takes").relevance(ctxOf([gated])).status).toBe("done");
  });

  it("master-glue: suggested on an empty master, done with a compressor there", () => {
    expect(goal("master-glue").relevance(ctxOf([])).status).toBe("suggested");
    const ctx = ctxOf([]);
    ctx.project.masterTrack.inserts.push(insert("builtin:compressor"));
    expect(goal("master-glue").relevance(ctx).status).toBe("done");
  });

  it("loudness: suggested without a limiter on the master, open with one", () => {
    expect(goal("loudness").relevance(ctxOf([])).status).toBe("suggested");
    const ctx = ctxOf([]);
    ctx.project.masterTrack.inserts.push(insert("builtin:limiter"));
    expect(goal("loudness").relevance(ctx).status).toBe("open");
  });

  it("sections-marked: na when short, suggested at length, done with markers", () => {
    expect(goal("sections-marked").relevance(ctxOf([])).status).toBe("na");
    const long = trk({ name: "Music", kind: "midi" as Track["kind"], clips: [midiClip(0, 64)] }); // 16 bars
    expect(goal("sections-marked").relevance(ctxOf([long])).status).toBe("suggested");
    const withMarkers = ctxOf([long], { markers: [{ id: 1, beat: 0, name: "Intro" }] } as Partial<Project>);
    expect(goal("sections-marked").relevance(withMarkers).status).toBe("done");
  });

  it("played-not-set: suggested for a long static project, open once automation exists", () => {
    const long = trk({ name: "Music", kind: "midi" as Track["kind"], clips: [midiClip(0, 64)] });
    expect(goal("played-not-set").relevance(ctxOf([long])).status).toBe("suggested");
    const ridden = trk({
      name: "Music", kind: "midi" as Track["kind"], clips: [midiClip(0, 64)],
      automation: [{ paramRef: "volume", points: [{ beat: 0, value: 1 }] }] as Track["automation"],
    });
    expect(goal("played-not-set").relevance(ctxOf([ridden])).status).toBe("open");
  });

  it("bus-skeleton: suggested for many busless tracks, done once buses exist", () => {
    const many = Array.from({ length: 7 }, (_, i) => trk({ name: `T${i}`, clips: [audioClip()] }));
    expect(goal("bus-skeleton").relevance(ctxOf(many)).status).toBe("suggested");
    expect(goal("bus-skeleton").relevance(ctxOf([...many, trk({ name: "Drum Bus", kind: "bus" as Track["kind"] })])).status).toBe("done");
  });

  it("contentBars converts midi beats and audio samples", () => {
    const midi = trk({ name: "M", kind: "midi" as Track["kind"], clips: [midiClip(0, 16)] }); // 4 bars at 4/4
    expect(contentBars(ctxOf([midi]))).toBe(4);
    // 4 s of audio at 120 bpm = 8 beats = 2 bars
    const audio = trk({ name: "A", clips: [audioClip(0, 4 * 48000)] });
    expect(contentBars(ctxOf([audio]))).toBe(2);
  });

  it("suggestedCount counts what the song actually triggers", () => {
    const kick = trk({ name: "Kick", clips: [audioClip()] });
    const bass = trk({ name: "Bass", clips: [audioClip()] });
    const evaluated = evaluateGuide(ctxOf([kick, bass]));
    expect(suggestedCount(evaluated)).toBeGreaterThan(0);
  });
});
