import { describe, expect, it } from "vitest";
import type { Project } from "../protocol/types";
import {
  buildNoteEvents,
  eventsInWindow,
  miniBeatX,
  miniRowH,
  miniScrollTo,
  pitchRange,
  smoothLevel,
  stageLayout,
  vizTracks,
} from "./vizMath";

/** Minimal project fixture: one instrument track with a midi clip, one audio, a folder. */
function fixture(): Project {
  return {
    tracks: [
      {
        id: 1,
        kind: "instrument",
        name: "Keys",
        color: "#54a3e8",
        clips: [
          {
            id: 10,
            type: "midi",
            startBeat: 4,
            lengthBeats: 8,
            notes: [
              { id: 100, pitch: 60, velocity: 100, startBeat: 0, lengthBeats: 1 },
              { id: 101, pitch: 64, velocity: 80, startBeat: 2, lengthBeats: 4 },
              // starts beyond the clip end — inaudible, must be skipped
              { id: 102, pitch: 70, velocity: 90, startBeat: 9, lengthBeats: 1 },
              // overhangs the clip end — must be trimmed to the clip
              { id: 103, pitch: 62, velocity: 90, startBeat: 7, lengthBeats: 4 },
            ],
            cc: [],
          },
        ],
      },
      { id: 2, kind: "audio", name: "Gtr", color: "#e25d5d", clips: [] },
      { id: 3, kind: "folder", name: "F", color: "", clips: [] },
      {
        id: 4,
        kind: "midi",
        name: "Bass",
        color: "",
        clips: [
          {
            id: 11,
            type: "midi",
            startBeat: 0,
            lengthBeats: 4,
            muted: true, // muted clip → no events
            notes: [{ id: 110, pitch: 36, velocity: 100, startBeat: 0, lengthBeats: 1 }],
            cc: [],
          },
        ],
      },
    ],
  } as unknown as Project;
}

describe("vizTracks", () => {
  it("keeps midi/instrument tracks in order, with a color fallback", () => {
    const ts = vizTracks(fixture());
    expect(ts.map((t) => t.id)).toEqual([1, 4]);
    expect(ts[1].color).toBe("#5b8cff"); // empty color falls back
  });
});

describe("buildNoteEvents", () => {
  it("maps clip-relative onsets to absolute beats, sorted", () => {
    const evs = buildNoteEvents(fixture());
    expect(evs.map((e) => e.beat)).toEqual([4, 6, 11]);
    expect(evs[0].pitch).toBe(60);
    expect(evs[0].trackIndex).toBe(0);
  });
  it("skips notes past the clip end and trims overhangs", () => {
    const evs = buildNoteEvents(fixture());
    expect(evs.some((e) => e.pitch === 70)).toBe(false); // beyond clip end
    const trimmed = evs.find((e) => e.pitch === 62)!;
    expect(trimmed.lengthBeats).toBe(1); // 4 → clipped to clip end (8 − 7)
  });
  it("ignores muted clips", () => {
    expect(buildNoteEvents(fixture()).some((e) => e.trackId === 4)).toBe(false);
  });
});

describe("pitchRange", () => {
  it("pads and widens to at least two octaves, clamped to 0..127", () => {
    const { lo, hi } = pitchRange(buildNoteEvents(fixture()));
    expect(hi - lo).toBeGreaterThanOrEqual(24);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(127);
    expect(lo).toBeLessThanOrEqual(59); // covers padded content
    expect(hi).toBeGreaterThanOrEqual(65);
  });
  it("defaults sanely for no events", () => {
    expect(pitchRange([])).toEqual({ lo: 48, hi: 84 });
  });
});

describe("eventsInWindow", () => {
  it("returns events overlapping [from, to) including already-sounding ones", () => {
    const evs = buildNoteEvents(fixture());
    const inWin = eventsInWindow(evs, 6.5, 8);
    // the 4-beat note at 6 is sounding at 6.5; the 1-beat note at 4 ended at 5
    expect(inWin.map((e) => e.beat)).toEqual([6]);
  });
});

describe("smoothLevel", () => {
  it("attacks fast and releases slowly", () => {
    const up = smoothLevel(0, 1, 25);
    const down = smoothLevel(1, 0, 25);
    expect(up).toBeGreaterThan(0.5); // ~63% after one attack constant
    expect(1 - down).toBeLessThan(0.15); // barely released after 25ms
  });
  it("clamps the target to 0..1 and never goes negative", () => {
    expect(smoothLevel(0, 5, 1000)).toBeLessThanOrEqual(1);
    expect(smoothLevel(0.001, 0, 10_000)).toBeGreaterThanOrEqual(0);
  });
});

describe("minimap mapping", () => {
  it("miniRowH clamps between 1.5 and 6", () => {
    expect(miniRowH(4, 36)).toBe(6);
    expect(miniRowH(100, 36)).toBe(1.5);
    expect(miniRowH(0, 36)).toBe(0);
  });
  it("miniBeatX is proportional", () => {
    expect(miniBeatX(0, 100, 500)).toBe(0);
    expect(miniBeatX(50, 100, 500)).toBe(250);
  });
  it("miniScrollTo centers and clamps to the scroll range", () => {
    // 100 beats at 10px/beat = 1000px content, 200px view → max scroll 800
    expect(miniScrollTo(0, 100, 500, 10, 200)).toBe(0); // clamp left
    expect(miniScrollTo(500, 100, 500, 10, 200)).toBe(800); // clamp right
    expect(miniScrollTo(250, 100, 500, 10, 200)).toBe(400); // centered: 50beats*10 − 100
  });
});

describe("stageLayout", () => {
  it("returns n centered bars", () => {
    const bars = stageLayout(5);
    expect(bars).toHaveLength(5);
    const cx = bars.reduce((s, b) => s + b.x, 0) / bars.length;
    expect(Math.abs(cx)).toBeLessThan(1e-9);
  });
  it("splits large counts into rows of ≤8", () => {
    const bars = stageLayout(20);
    const rows = new Set(bars.map((b) => b.z));
    expect(rows.size).toBeGreaterThan(1);
    for (const z of rows) {
      expect(bars.filter((b) => b.z === z).length).toBeLessThanOrEqual(8);
    }
  });
  it("handles zero", () => {
    expect(stageLayout(0)).toEqual([]);
  });
});
