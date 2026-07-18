import { describe, expect, it } from "vitest";
import type { Grid, TempoPoint, TimeSigEntry } from "../protocol/types";
import {
  barToBeat,
  beatToBar,
  beatsToSeconds,
  bpmAtBeat,
  formatBarsBeats,
  gridStepBeats,
  secondsToBeats,
  snapBeat,
  timeSigAtBeat,
} from "./time";

const flat120: TempoPoint[] = [{ beat: 0, bpm: 120 }];
// 120 bpm for beats 0..8, then 60 bpm
const twoTempo: TempoPoint[] = [
  { beat: 0, bpm: 120 },
  { beat: 8, bpm: 60 },
];

describe("beatsToSeconds", () => {
  it("converts at a constant tempo (120 bpm = 0.5 s/beat)", () => {
    expect(beatsToSeconds(0, flat120)).toBe(0);
    expect(beatsToSeconds(4, flat120)).toBeCloseTo(2, 12);
    expect(beatsToSeconds(1, [{ beat: 0, bpm: 60 }])).toBeCloseTo(1, 12);
  });

  it("defaults to 120 bpm for an empty tempo map", () => {
    expect(beatsToSeconds(4, [])).toBeCloseTo(2, 12);
  });

  it("accumulates piecewise-constant segments", () => {
    // 8 beats @120 = 4 s, then @60 = 1 s/beat
    expect(beatsToSeconds(8, twoTempo)).toBeCloseTo(4, 12);
    expect(beatsToSeconds(10, twoTempo)).toBeCloseTo(6, 12);
  });
});

describe("secondsToBeats", () => {
  it("inverts constant-tempo conversion", () => {
    expect(secondsToBeats(2, flat120)).toBeCloseTo(4, 12);
    expect(secondsToBeats(0, flat120)).toBe(0);
  });

  it("defaults to 120 bpm for an empty tempo map", () => {
    expect(secondsToBeats(3, [])).toBeCloseTo(6, 12);
  });

  it("inverts across a tempo change", () => {
    expect(secondsToBeats(4, twoTempo)).toBeCloseTo(8, 12);
    expect(secondsToBeats(6, twoTempo)).toBeCloseTo(10, 12);
  });

  it("round-trips with beatsToSeconds on a multi-segment map", () => {
    const map: TempoPoint[] = [
      { beat: 0, bpm: 90 },
      { beat: 4, bpm: 140 },
      { beat: 16, bpm: 75.5 },
    ];
    for (const beat of [0, 0.5, 3.99, 4, 7.25, 16, 16.01, 100]) {
      expect(secondsToBeats(beatsToSeconds(beat, map), map)).toBeCloseTo(beat, 9);
    }
  });
});

describe("bpmAtBeat", () => {
  it("returns the tempo in effect at a beat (entries hold until the next)", () => {
    expect(bpmAtBeat(0, twoTempo)).toBe(120);
    expect(bpmAtBeat(7.999, twoTempo)).toBe(120);
    expect(bpmAtBeat(8, twoTempo)).toBe(60);
    expect(bpmAtBeat(100, twoTempo)).toBe(60);
    expect(bpmAtBeat(5, [])).toBe(120);
  });
});

// bars 1-2 in 4/4 (beats 0..8), bar 3+ in 3/4 (3 beats per bar)
const sigMap: TimeSigEntry[] = [
  { bar: 1, num: 4, den: 4 },
  { bar: 3, num: 3, den: 4 },
];

describe("barToBeat", () => {
  it("uses 4/4 when the map is empty", () => {
    expect(barToBeat(1, [])).toBe(0);
    expect(barToBeat(3, [])).toBe(8);
  });

  it("accounts for time-signature changes", () => {
    expect(barToBeat(1, sigMap)).toBe(0);
    expect(barToBeat(2, sigMap)).toBe(4);
    expect(barToBeat(3, sigMap)).toBe(8); // change lands here
    expect(barToBeat(4, sigMap)).toBe(11); // 3/4 bars are 3 beats
    expect(barToBeat(5, sigMap)).toBe(14);
  });

  it("handles denominators other than 4 (6/8 bar = 3 quarter-note beats)", () => {
    const sixEight: TimeSigEntry[] = [{ bar: 1, num: 6, den: 8 }];
    expect(barToBeat(2, sixEight)).toBe(3);
    expect(barToBeat(3, sixEight)).toBe(6);
  });
});

describe("beatToBar", () => {
  it("returns the 1-based bar containing a beat", () => {
    expect(beatToBar(0, sigMap)).toBe(1);
    expect(beatToBar(3.999, sigMap)).toBe(1);
    expect(beatToBar(4, sigMap)).toBe(2);
    expect(beatToBar(8, sigMap)).toBe(3);
    expect(beatToBar(10.5, sigMap)).toBe(3);
    expect(beatToBar(11, sigMap)).toBe(4);
  });

  it("round-trips with barToBeat at bar starts", () => {
    for (const bar of [1, 2, 3, 4, 7, 20]) {
      expect(beatToBar(barToBeat(bar, sigMap), sigMap)).toBe(bar);
    }
  });
});

describe("timeSigAtBeat", () => {
  it("reports the signature and quarter-note beats per bar", () => {
    expect(timeSigAtBeat(0, sigMap)).toEqual({ num: 4, den: 4, beatsPerBar: 4 });
    expect(timeSigAtBeat(8, sigMap)).toEqual({ num: 3, den: 4, beatsPerBar: 3 });
    const sixEight: TimeSigEntry[] = [{ bar: 1, num: 6, den: 8 }];
    expect(timeSigAtBeat(0, sixEight)).toEqual({ num: 6, den: 8, beatsPerBar: 3 });
  });
});

describe("formatBarsBeats", () => {
  it("formats BAR.BEAT.TTT with 960 ticks per displayed beat", () => {
    expect(formatBarsBeats(0, sigMap)).toBe("1.1.000");
    expect(formatBarsBeats(4.5, sigMap)).toBe("2.1.480");
    expect(formatBarsBeats(8, sigMap)).toBe("3.1.000"); // first 3/4 bar
    expect(formatBarsBeats(13, sigMap)).toBe("4.3.000");
  });
});

const grid = (over: Partial<Grid> = {}): Grid => ({
  division: 0.5,
  snap: true,
  triplet: false,
  swing: 0,
  ...over,
});

describe("gridStepBeats", () => {
  it("returns the division for straight grids", () => {
    expect(gridStepBeats(grid({ division: 1 }))).toBe(1);
    expect(gridStepBeats(grid({ division: 0.25 }))).toBe(0.25);
  });

  it("scales the step by 2/3 for triplets", () => {
    expect(gridStepBeats(grid({ division: 1, triplet: true }))).toBeCloseTo(2 / 3, 12);
    expect(gridStepBeats(grid({ division: 0.5, triplet: true }))).toBeCloseTo(1 / 3, 12);
  });
});

describe("snapBeat", () => {
  it("rounds to the nearest grid line by default", () => {
    expect(snapBeat(1.3, grid())).toBe(1.5);
    expect(snapBeat(1.2, grid())).toBe(1);
    expect(snapBeat(1.5, grid())).toBe(1.5);
  });

  it("supports floor and ceil modes", () => {
    expect(snapBeat(1.9, grid(), "floor")).toBe(1.5);
    expect(snapBeat(1.1, grid(), "ceil")).toBe(1.5);
    expect(snapBeat(1.5, grid(), "floor")).toBe(1.5);
    expect(snapBeat(1.5, grid(), "ceil")).toBe(1.5);
  });

  it("snaps on the triplet grid when enabled", () => {
    expect(snapBeat(0.5, grid({ division: 1, triplet: true }))).toBeCloseTo(2 / 3, 12);
    expect(snapBeat(0.2, grid({ division: 1, triplet: true }))).toBe(0);
  });

  it("is a no-op when snap is off, grid is absent, or division is invalid", () => {
    expect(snapBeat(1.3, grid({ snap: false }))).toBe(1.3);
    expect(snapBeat(1.3, null)).toBe(1.3);
    expect(snapBeat(1.3, undefined)).toBe(1.3);
    expect(snapBeat(1.3, grid({ division: 0 }))).toBe(1.3);
  });

  it("does not apply swing (swing is quantize-only)", () => {
    expect(snapBeat(1.3, grid({ swing: 0.75 }))).toBe(1.5);
  });
});
