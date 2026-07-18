import { describe, expect, it } from "vitest";
import {
  TPQ,
  buildScore,
  decomposeDuration,
  detectKey,
  durTicks,
  keySignatureAccidentals,
  keyName,
  spellPitch,
  type Meter,
} from "./notation";

const C4 = 60;
const FOUR_FOUR: Meter = { num: 4, den: 4 };
const SIX_EIGHT: Meter = { num: 6, den: 8 };

describe("pitch spelling", () => {
  it("spells naturals in C major", () => {
    expect(spellPitch(C4, 0)).toMatchObject({ letter: "C", alter: 0, octave: 4 });
    expect(spellPitch(62, 0)).toMatchObject({ letter: "D", alter: 0, octave: 4 });
    expect(spellPitch(71, 0)).toMatchObject({ letter: "B", alter: 0, octave: 4 });
  });

  it("uses sharps in sharp keys and flats in flat keys", () => {
    // MIDI 61 is C#/Db — the key decides which.
    expect(spellPitch(61, 4)).toMatchObject({ letter: "C", alter: 1 }); // E major
    expect(spellPitch(61, -4)).toMatchObject({ letter: "D", alter: -1 }); // Ab major
    // MIDI 66 is F#/Gb
    expect(spellPitch(66, 2)).toMatchObject({ letter: "F", alter: 1 }); // D major
    expect(spellPitch(66, -3)).toMatchObject({ letter: "G", alter: -1 }); // Eb major
  });

  it("produces E# in F# major rather than a foreign F natural", () => {
    expect(spellPitch(65, 6)).toMatchObject({ letter: "E", alter: 1 });
  });

  it("keeps the octave right across the B#/Cb seam", () => {
    // B#3 sounds as middle C; it must NOT be reported as octave 4.
    const s = spellPitch(60, 7); // C# major territory
    expect(s.pitch).toBe(60);
    expect(s.octave * 12 + 12 + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[s.letter]! + s.alter).toBe(60);
  });

  it("round-trips: every spelling renders the pitch it was asked for", () => {
    for (let fifths = -7; fifths <= 7; fifths++) {
      for (let pitch = 36; pitch <= 84; pitch++) {
        expect(spellPitch(pitch, fifths).pitch).toBe(pitch);
      }
    }
  });
});

describe("key signatures", () => {
  it("orders sharps F C G D A E B and flats B E A D G C F", () => {
    expect(keySignatureAccidentals(3).map((a) => a.letter)).toEqual(["F", "C", "G"]);
    expect(keySignatureAccidentals(-3).map((a) => a.letter)).toEqual(["B", "E", "A"]);
    expect(keySignatureAccidentals(0)).toEqual([]);
  });

  it("names keys", () => {
    expect(keyName(0)).toBe("C major");
    expect(keyName(2)).toBe("D major");
    expect(keyName(-1)).toBe("F major");
    expect(keyName(0, true)).toBe("A minor");
  });

  it("detects a key from the notes played", () => {
    // A G-major scale: one sharp.
    const g = [67, 69, 71, 72, 74, 76, 78, 79].map((pitch) => ({ pitch, ticks: TPQ }));
    expect(detectKey(g).fifths).toBe(1);
    // A plain C-major scale: no accidentals.
    const c = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch) => ({ pitch, ticks: TPQ }));
    expect(detectKey(c).fifths).toBe(0);
  });

  it("returns C for no input rather than throwing", () => {
    expect(detectKey([])).toEqual({ fifths: 0, minor: false });
  });
});

describe("duration decomposition", () => {
  const total = (ds: { ticks: number }[]) => ds.reduce((s, d) => s + d.ticks, 0);

  it("keeps whole values whole", () => {
    expect(decomposeDuration(0, TPQ, FOUR_FOUR)).toEqual([{ value: 4, dots: 0, ticks: TPQ }]);
    expect(decomposeDuration(0, TPQ * 4, FOUR_FOUR)).toEqual([{ value: 1, dots: 0, ticks: TPQ * 4 }]);
  });

  it("writes 1.5 beats as a dotted quarter", () => {
    const d = decomposeDuration(0, TPQ * 1.5, FOUR_FOUR);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ value: 4, dots: 1 });
  });

  it("splits a quarter that starts off the beat into tied eighths", () => {
    // Starting on the 'and' of beat 1, a quarter would straddle beat 2.
    const d = decomposeDuration(TPQ / 2, TPQ, FOUR_FOUR);
    expect(d.length).toBeGreaterThan(1);
    expect(total(d)).toBe(TPQ);
    expect(d.every((x) => x.value === 8)).toBe(true);
  });

  it("never loses or invents time", () => {
    for (const len of [TPQ / 4, TPQ / 2, TPQ, TPQ * 1.5, TPQ * 2, TPQ * 3, TPQ * 3.5]) {
      for (const pos of [0, TPQ / 4, TPQ / 2, TPQ, TPQ * 2]) {
        if (pos + len > TPQ * 4) continue;
        expect(total(decomposeDuration(pos, len, FOUR_FOUR))).toBe(len);
      }
    }
  });

  it("respects compound-time grouping", () => {
    // In 6/8 the beat is a dotted quarter, so a dotted quarter on the beat stays whole.
    const d = decomposeDuration(0, durTicks(4, 1), SIX_EIGHT);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ value: 4, dots: 1 });
  });
});

describe("buildScore", () => {
  const note = (id: number, start: number, ticks: number, pitch: number, velocity = 90) => ({
    id,
    start,
    ticks,
    pitch,
    velocity,
  });

  const opts = {
    meter: FOUR_FOUR,
    fifths: 0,
    quantize: TPQ / 4,
    splitPitch: null,
    transpose: 0,
  };

  it("fills an empty bar with rests totalling one measure", () => {
    const m = buildScore([], opts);
    expect(m).toHaveLength(1);
    const ticks = m[0].staves[0].reduce((s, e) => s + e.dur.ticks, 0);
    expect(ticks).toBe(TPQ * 4);
    expect(m[0].staves[0].every((e) => e.kind === "rest")).toBe(true);
  });

  it("accounts for every tick of every measure it emits", () => {
    const notes = [note(1, 0, TPQ, 60), note(2, TPQ * 2, TPQ / 2, 64), note(3, TPQ * 5, TPQ, 67)];
    for (const m of buildScore(notes, opts)) {
      for (const staff of m.staves) {
        expect(staff.reduce((s, e) => s + e.dur.ticks, 0)).toBe(m.ticks);
      }
    }
  });

  it("groups simultaneous notes into one chord element", () => {
    const notes = [note(1, 0, TPQ, 60), note(2, 0, TPQ, 64), note(3, 0, TPQ, 67)];
    const m = buildScore(notes, opts);
    const first = m[0].staves[0][0];
    expect(first.kind).toBe("note");
    expect(first.heads).toHaveLength(3);
  });

  it("ties a note that crosses a barline instead of dropping it", () => {
    const notes = [note(1, TPQ * 3, TPQ * 2, 60)]; // last beat of bar 1 into bar 2
    const m = buildScore(notes, opts);
    expect(m).toHaveLength(2);
    const a = m[0].staves[0].find((e) => e.kind === "note")!;
    const b = m[1].staves[0].find((e) => e.kind === "note")!;
    expect(a.heads[0].tieTo).toBe(true);
    expect(b.heads[0].tieFrom).toBe(true);
  });

  it("splits a grand staff at the given pitch", () => {
    const notes = [note(1, 0, TPQ, 72), note(2, 0, TPQ, 48)];
    const m = buildScore(notes, { ...opts, splitPitch: 60 });
    expect(m[0].staves).toHaveLength(2);
    expect(m[0].staves[0][0].heads[0].spelled.pitch).toBe(72); // treble
    expect(m[0].staves[1][0].heads[0].spelled.pitch).toBe(48); // bass
  });

  it("beams consecutive eighths within a beat but not across the bar", () => {
    const notes = [
      note(1, 0, TPQ / 2, 60),
      note(2, TPQ / 2, TPQ / 2, 62),
      note(3, TPQ, TPQ / 2, 64),
      note(4, TPQ * 1.5, TPQ / 2, 65),
    ];
    const m = buildScore(notes, opts);
    const eighths = m[0].staves[0].filter((e) => e.kind === "note");
    expect(eighths).toHaveLength(4);
    // pair 1 shares a beam, pair 2 shares a different one
    expect(eighths[0].beam).not.toBeNull();
    expect(eighths[0].beam).toBe(eighths[1].beam);
    expect(eighths[2].beam).toBe(eighths[3].beam);
    expect(eighths[0].beam).not.toBe(eighths[2].beam);
  });

  it("prints an accidental once per measure, not once per note", () => {
    const notes = [note(1, 0, TPQ, 61), note(2, TPQ, TPQ, 61), note(3, TPQ * 2, TPQ, 61)];
    const m = buildScore(notes, opts);
    const withAcc = m[0].staves[0].filter((e) => e.heads.some((h) => h.accidental !== null));
    expect(withAcc).toHaveLength(1);
  });

  it("transposes the written pitch", () => {
    const m = buildScore([note(1, 0, TPQ, 60)], { ...opts, transpose: 2 });
    expect(m[0].staves[0][0].heads[0].spelled.pitch).toBe(62);
  });

  it("points stems away from the middle line", () => {
    // A high note gets a down stem; a low note gets an up stem.
    const high = buildScore([note(1, 0, TPQ, 84)], opts)[0].staves[0][0];
    const low = buildScore([note(1, 0, TPQ, 55)], opts)[0].staves[0][0];
    expect(high.stemUp).toBe(false);
    expect(low.stemUp).toBe(true);
  });
});
