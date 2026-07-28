import { describe, expect, it } from "vitest";
import { FADE_CURVES, envGainAt, fadeGain, fadeGainAt } from "./fadeCurves";

describe("fadeGain", () => {
  it("every shape starts at 0 and ends at 1", () => {
    for (const c of FADE_CURVES) {
      expect(fadeGain(c, 0)).toBeCloseTo(0, 6);
      expect(fadeGain(c, 1)).toBeCloseTo(1, 6);
    }
  });

  it("every shape is monotonically non-decreasing", () => {
    for (const c of FADE_CURVES) {
      let prev = -1;
      for (let k = 0; k <= 100; k++) {
        const g = fadeGain(c, k / 100);
        expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = g;
      }
    }
  });

  it("clamps t outside 0..1", () => {
    expect(fadeGain("linear", -0.5)).toBe(0);
    expect(fadeGain("linear", 1.5)).toBe(1);
  });

  it("undefined curve behaves as linear", () => {
    expect(fadeGain(undefined, 0.37)).toBeCloseTo(0.37, 9);
  });

  it("eqPower crossfade sums to unity power", () => {
    // fade-out evaluates the shape on the REMAINING fraction, so at any point of an
    // overlap: out = shape(1-t), in = shape(t); eqPower → out² + in² = 1.
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const fadeIn = fadeGain("eqPower", t);
      const fadeOut = fadeGain("eqPower", 1 - t);
      expect(fadeIn * fadeIn + fadeOut * fadeOut).toBeCloseTo(1, 6);
    }
  });

  it("expo is slower than linear early; log is faster", () => {
    expect(fadeGain("expo", 0.25)).toBeLessThan(0.25);
    expect(fadeGain("log", 0.25)).toBeGreaterThan(0.25);
  });
});

describe("fadeGainAt", () => {
  it("fadeFrac 0 = no fade anywhere", () => {
    for (const c of FADE_CURVES) {
      expect(fadeGainAt("in", c, 0, 0)).toBe(1);
      expect(fadeGainAt("out", c, 0, 1)).toBe(1);
    }
  });

  it("full-span fade-in matches fadeGain; fade-out mirrors it", () => {
    for (const c of FADE_CURVES) {
      for (let k = 0; k <= 10; k++) {
        const p = k / 10;
        expect(fadeGainAt("in", c, 1, p)).toBeCloseTo(fadeGain(c, p), 9);
        expect(fadeGainAt("out", c, 1, p)).toBeCloseTo(fadeGain(c, 1 - p), 9);
      }
    }
  });

  it("partial fade-in covers [0, frac] and holds unity after", () => {
    expect(fadeGainAt("in", "linear", 0.5, 0.25)).toBeCloseTo(0.5, 9);
    expect(fadeGainAt("in", "linear", 0.5, 0.5)).toBe(1);
    expect(fadeGainAt("in", "linear", 0.5, 0.9)).toBe(1);
  });

  it("partial fade-out holds unity until 1-frac, then falls to 0", () => {
    expect(fadeGainAt("out", "linear", 0.25, 0.5)).toBe(1);
    expect(fadeGainAt("out", "linear", 0.25, 0.875)).toBeCloseTo(0.5, 9);
    expect(fadeGainAt("out", "linear", 0.25, 1)).toBeCloseTo(0, 9);
  });
});

describe("envGainAt", () => {
  const env = [
    { pos: 0.2, value: 1 },
    { pos: 0.6, value: 0.5 },
    { pos: 0.8, value: 2 },
  ];

  it("returns unity for an empty/absent envelope", () => {
    expect(envGainAt(undefined, 0.5)).toBe(1);
    expect(envGainAt([], 0.5)).toBe(1);
  });

  it("holds the first/last value outside the point range", () => {
    expect(envGainAt(env, 0)).toBe(1);
    expect(envGainAt(env, 1)).toBe(2);
  });

  it("interpolates linearly between points", () => {
    expect(envGainAt(env, 0.4)).toBeCloseTo(0.75, 9); // midway 1 → 0.5
    expect(envGainAt(env, 0.7)).toBeCloseTo(1.25, 9); // midway 0.5 → 2
  });

  it("hits the exact values at the points", () => {
    expect(envGainAt(env, 0.2)).toBe(1);
    expect(envGainAt(env, 0.6)).toBeCloseTo(0.5, 9);
    expect(envGainAt(env, 0.8)).toBeCloseTo(2, 9);
  });
});
