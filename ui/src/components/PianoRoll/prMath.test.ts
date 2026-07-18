import { describe, expect, it } from "vitest";
import {
  divisionBeats,
  gridStep,
  isBlackKey,
  pitchName,
  scalePitchClasses,
  snapFloor,
  snapPitchToScale,
} from "./prMath";

describe("scalePitchClasses", () => {
  it("C major is {0,2,4,5,7,9,11}", () => {
    expect(scalePitchClasses(0, "major")).toEqual(new Set([0, 2, 4, 5, 7, 9, 11]));
  });

  it("A minor contains the same pitch classes as C major (relative keys)", () => {
    expect(scalePitchClasses(9, "minor")).toEqual(scalePitchClasses(0, "major"));
  });

  it("wraps the root into 0..11 (including negative roots)", () => {
    expect(scalePitchClasses(12, "major")).toEqual(scalePitchClasses(0, "major"));
    expect(scalePitchClasses(-3, "minor")).toEqual(scalePitchClasses(9, "minor"));
  });

  it("wraps scale steps past the octave (D major contains C#=1)", () => {
    expect(scalePitchClasses(2, "major")).toEqual(new Set([2, 4, 6, 7, 9, 11, 1]));
  });

  it("returns null for an unknown scale id", () => {
    expect(scalePitchClasses(0, "off")).toBeNull();
    expect(scalePitchClasses(0, "nope")).toBeNull();
  });
});

describe("snapPitchToScale", () => {
  const cMajor = scalePitchClasses(0, "major")!;

  it("dir 0 leaves in-scale pitches unchanged", () => {
    for (const p of [60, 62, 64, 65, 67, 69, 71, 72]) {
      expect(snapPitchToScale(p, cMajor, 0)).toBe(p);
    }
  });

  it("dir 0 snaps out-of-scale pitches to the nearest scale tone, ties going up", () => {
    expect(snapPitchToScale(61, cMajor, 0)).toBe(62); // C# → D (up wins the 1-semitone tie)
    expect(snapPitchToScale(63, cMajor, 0)).toBe(64); // D# → E (E/D both 1 away; up wins)
    expect(snapPitchToScale(66, cMajor, 0)).toBe(67); // F# → G
  });

  it("dir +1 strictly moves up, even from an in-scale pitch", () => {
    expect(snapPitchToScale(60, cMajor, 1)).toBe(62); // C → D
    expect(snapPitchToScale(64, cMajor, 1)).toBe(65); // E → F
    expect(snapPitchToScale(61, cMajor, 1)).toBe(62); // C# → D
  });

  it("dir -1 strictly moves down, even from an in-scale pitch", () => {
    expect(snapPitchToScale(60, cMajor, -1)).toBe(59); // C → B
    expect(snapPitchToScale(65, cMajor, -1)).toBe(64); // F → E
    expect(snapPitchToScale(63, cMajor, -1)).toBe(62); // D# → D
  });

  it("clamps at the top of the MIDI range", () => {
    // 127 = G8 is in C major; there is nothing above it to move to
    expect(snapPitchToScale(127, cMajor, 1)).toBe(127);
  });

  it("clamps at the bottom of the MIDI range", () => {
    // 0 = C-2 is in C major; there is nothing below it to move to
    expect(snapPitchToScale(0, cMajor, -1)).toBe(0);
    // D major does not contain C: nearest from pitch 0 can only go up
    const dMajor = scalePitchClasses(2, "major")!;
    expect(snapPitchToScale(0, dMajor, 0)).toBe(1);
    expect(snapPitchToScale(0, dMajor, -1)).toBe(0);
  });

  it("returns the pitch unchanged for an empty pitch-class set", () => {
    expect(snapPitchToScale(61, new Set<number>(), 0)).toBe(61);
    expect(snapPitchToScale(61, new Set<number>(), 1)).toBe(61);
  });
});

describe("divisionBeats", () => {
  it("maps division labels to beats (beats are quarter notes)", () => {
    expect(divisionBeats("1/1")).toBe(4);
    expect(divisionBeats("1/2")).toBe(2);
    expect(divisionBeats("1/4")).toBe(1);
    expect(divisionBeats("1/8")).toBe(0.5);
    expect(divisionBeats("1/16")).toBe(0.25);
    expect(divisionBeats("1/32")).toBe(0.125);
  });

  it("falls back to 1/16 (0.25 beats) for unknown labels", () => {
    expect(divisionBeats("1/128")).toBe(0.25);
    expect(divisionBeats("")).toBe(0.25);
  });
});

describe("gridStep", () => {
  it("returns the division unchanged for straight grids", () => {
    expect(gridStep(1, false)).toBe(1);
    expect(gridStep(0.25, false)).toBe(0.25);
  });

  it("scales by 2/3 for triplet grids", () => {
    expect(gridStep(1, true)).toBeCloseTo(2 / 3, 12);
    expect(gridStep(0.5, true)).toBeCloseTo(1 / 3, 12);
  });
});

describe("snapFloor", () => {
  it("floors to the previous grid line", () => {
    expect(snapFloor(1.7, 0.5)).toBe(1.5);
    expect(snapFloor(1.5, 0.5)).toBe(1.5);
    expect(snapFloor(0.49, 0.5)).toBe(0);
  });

  it("tolerates float error just below a grid line", () => {
    // 0.1 * 3 = 0.30000000000000004-style error must not floor down a whole step
    expect(snapFloor(0.7 + 0.1, 0.2)).toBeCloseTo(0.8, 12);
  });

  it("returns the beat unchanged for a non-positive step", () => {
    expect(snapFloor(1.23, 0)).toBe(1.23);
    expect(snapFloor(1.23, -1)).toBe(1.23);
  });
});

describe("isBlackKey", () => {
  it("matches the piano octave pattern", () => {
    const blackPcs = [1, 3, 6, 8, 10];
    for (let p = 60; p < 72; p++) {
      expect(isBlackKey(p)).toBe(blackPcs.includes(p % 12));
    }
  });

  it("works across the whole range", () => {
    expect(isBlackKey(0)).toBe(false); // C-2
    expect(isBlackKey(127)).toBe(false); // G8
    expect(isBlackKey(106)).toBe(true); // A#6
  });
});

describe("pitchName", () => {
  it("uses the Cubase/Yamaha convention (middle C = C3)", () => {
    expect(pitchName(60)).toBe("C3");
  });

  it("names range ends and accidentals", () => {
    expect(pitchName(0)).toBe("C-2");
    expect(pitchName(127)).toBe("G8");
    expect(pitchName(61)).toBe("C#3");
    expect(pitchName(59)).toBe("B2");
    expect(pitchName(69)).toBe("A3"); // A440
  });
});
