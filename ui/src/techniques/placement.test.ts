import { describe, expect, it } from "vitest";
import { TECHNIQUES } from "./catalog";
import { landingBar, leadInRange, trimNote } from "./ops";
import type { TechniqueCtx } from "./types";

/**
 * Where a technique puts things (2026-08-02 bug, found on a user project).
 *
 * "Build-Up Riser" applied with the playhead at beat 16.5 (bar 5.x) landed its drop at
 * bar 9, not the bar 6 the user was looking at: the default drop bar was clamped forward
 * so a full 8-bar build could fit before it. Wrong side of the trade — the user's
 * position is the intent, the build length is the flexible part.
 */

const ctxAt = (playheadBeat: number, beatsPerBar = 4, clipStarts: number[] = []): TechniqueCtx =>
  ({
    project: {
      tracks: clipStarts.map((startBeat, i) => ({
        id: i + 1,
        clips: [{ id: i + 1, startBeat, lengthBeats: 4, type: "midi" }],
      })),
      chordEvents: [],
      masterTrack: { inserts: [] },
    },
    selection: { trackIds: [], clipIds: [], noteIds: [] },
    bpm: 120,
    beatsPerBar,
    playheadBeat,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("landing bars follow the playhead", () => {
  it("lands on the bar line the playhead is heading into", () => {
    expect(landingBar(ctxAt(16.5))).toBe(6); // mid-bar-5 → the bar 5 ends on
    expect(landingBar(ctxAt(16))).toBe(5); // parked ON a bar line → that bar
    expect(landingBar(ctxAt(18, 3))).toBe(7); // 3/4: beat 18 IS the bar-7 line
  });

  it("aims at the song's entrance when the playhead was never placed", () => {
    // Playhead at 0 is not a request to drop at bar 2 — that is before the music.
    expect(landingBar(ctxAt(0, 4, [8.25, 20]))).toBe(3); // clip enters IN bar 3
    expect(landingBar(ctxAt(0, 4, [16]))).toBe(5); // exactly on a bar line
    expect(landingBar(ctxAt(0, 4, []))).toBe(2); // empty project: nothing to aim at
    expect(landingBar(ctxAt(0, 4, [0]))).toBe(2); // content at zero: same
    // A PLACED playhead still wins over content.
    expect(landingBar(ctxAt(16.5, 4, [8.25]))).toBe(6);
  });

  it("EVERY landing-bar default in the catalog is that bar, never pushed later", () => {
    const ctx = ctxAt(16.5);
    const offenders: string[] = [];
    for (const t of TECHNIQUES) {
      for (const stage of t.stages) {
        for (const p of stage.params ?? []) {
          // "atBar"/"endBar"/"dropBar" = something LANDS there. ("From bar" pickers,
          // which start at the playhead's own bar, use other keys.)
          if (!/^(dropBar|atBar|endBar)$/.test(p.key)) continue;
          const v = typeof p.default === "function" ? p.default(ctx) : p.default;
          if (v !== 6) offenders.push(`${t.id}/${stage.id}/${p.key} = ${String(v)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("lead-ins are trimmed, not moved", () => {
  it("keeps the landing and clamps the start at the project start", () => {
    const ctx = ctxAt(16.5);
    const full = leadInRange(ctx, 9, 8); // 8 bars fit before bar 9
    expect(full).toEqual({ start: 0, end: 32, bars: 8 });

    const cramped = leadInRange(ctx, 6, 8); // only 5 bars of room
    expect(cramped.end).toBe(20); // the drop stayed put …
    expect(cramped.start).toBe(0); // … and the build was cut short
    expect(cramped.bars).toBe(5);
  });

  it("says so when it trimmed, and stays quiet when it did not", () => {
    expect(trimNote(5, 8)).toContain("Trimmed to 5 bars");
    expect(trimNote(1, 2)).toContain("1 bar —");
    expect(trimNote(8, 8)).toBe("");
  });
});
