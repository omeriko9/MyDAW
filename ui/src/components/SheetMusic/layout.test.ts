import { describe, expect, it } from "vitest";
import { TPQ, buildScore, type SourceNote } from "./notation";
import { CLEF_TOP_STEP, layoutScore, pointToTick, stepY, tickToPoint } from "./layout";

const note = (id: number, start: number, ticks: number, pitch: number): SourceNote => ({
  id,
  start,
  ticks,
  pitch,
  velocity: 90,
});

const build = (notes: SourceNote[], splitPitch: number | null = null) =>
  buildScore(notes, {
    meter: { num: 4, den: 4 },
    fifths: 0,
    quantize: TPQ / 4,
    splitPitch,
    transpose: 0,
  });

const lay = (notes: SourceNote[], opts: Partial<Parameters<typeof layoutScore>[1]> = {}) =>
  layoutScore(build(notes, opts.clefs && opts.clefs.length > 1 ? 60 : null), {
    sp: 8,
    width: 700,
    clefs: ["treble"],
    fifths: 0,
    ...opts,
  });

describe("staff geometry", () => {
  it("puts each clef's reference pitch on its reference line", () => {
    // Treble: G4 (step 32) sits on line 2 from the bottom = 3 spaces below the top line.
    expect(stepY(32, "treble", 8)).toBeCloseTo(3 * 8);
    // Bass: F3 (step 24) sits on line 2 from the top = 1 space below the top line.
    expect(stepY(24, "bass", 8)).toBeCloseTo(1 * 8);
    // Alto: C4 (step 28) sits on the middle line.
    expect(stepY(28, "alto", 8)).toBeCloseTo(2 * 8);
  });

  it("moves up the staff as pitch rises", () => {
    expect(stepY(CLEF_TOP_STEP.treble, "treble", 8)).toBe(0);
    expect(stepY(CLEF_TOP_STEP.treble - 2, "treble", 8)).toBe(8); // one space lower
  });
});

describe("layout", () => {
  it("packs measures into systems that fit the width", () => {
    // 12 bars of quarter notes at a narrow width must wrap onto several systems.
    const notes: SourceNote[] = [];
    for (let bar = 0; bar < 12; bar++) {
      for (let beat = 0; beat < 4; beat++) {
        notes.push(note(bar * 4 + beat + 1, (bar * 4 + beat) * TPQ, TPQ, 60 + (beat % 5)));
      }
    }
    const layout = lay(notes, { width: 500 });
    const systems = layout.pages.flatMap((p) => p.systems);
    expect(systems.length).toBeGreaterThan(1);
    for (const sys of systems) {
      expect(sys.width).toBeLessThanOrEqual(500 + 1);
      expect(sys.measures.length).toBeGreaterThan(0);
    }
    // every measure appears exactly once, in order
    const indices = systems.flatMap((s) => s.measures.map((m) => m.index));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(new Set(indices).size).toBe(indices.length);
  });

  it("aligns both staves of a grand staff at the same musical instant", () => {
    // Right hand and left hand strike together on every beat.
    const notes: SourceNote[] = [];
    for (let beat = 0; beat < 8; beat++) {
      notes.push(note(beat * 2 + 1, beat * TPQ, TPQ, 72));
      notes.push(note(beat * 2 + 2, beat * TPQ, TPQ, 48));
    }
    const layout = lay(notes, { clefs: ["treble", "bass"] });
    const measures = layout.pages.flatMap((p) => p.systems).flatMap((s) => s.measures);
    for (const m of measures) {
      const byTick = new Map<number, number[]>();
      for (const el of m.elements) {
        const xs = byTick.get(el.start) ?? [];
        xs.push(el.x);
        byTick.set(el.start, xs);
      }
      for (const [, xs] of byTick) {
        // Same tick on treble and bass → identical x, or the staves would drift apart.
        expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.001);
      }
    }
  });

  it("never lets a measure start before the previous one ends", () => {
    const notes = Array.from({ length: 24 }, (_, i) => note(i + 1, i * TPQ, TPQ, 60 + (i % 7)));
    const layout = lay(notes, { width: 460 });
    for (const sys of layout.pages.flatMap((p) => p.systems)) {
      for (let i = 1; i < sys.measures.length; i++) {
        const prev = sys.measures[i - 1];
        expect(sys.measures[i].x).toBeCloseTo(prev.x + prev.width, 3);
      }
    }
  });

  it("gives longer notes more room than shorter ones", () => {
    const short = lay([note(1, 0, TPQ / 4, 60), note(2, TPQ / 4, TPQ * 3.75, 62)]);
    const m = short.pages[0].systems[0].measures[0];
    const els = m.elements.slice().sort((a, b) => a.x - b.x);
    const firstGap = els[1].x - els[0].x;
    expect(firstGap).toBeGreaterThan(0);
    // The sixteenth gets less space than the long note that follows it.
    expect(firstGap).toBeLessThan(m.contentW * 0.5);
  });

  it("round-trips a musical position to a point and back", () => {
    const notes = Array.from({ length: 16 }, (_, i) => note(i + 1, i * TPQ, TPQ, 60));
    const layout = lay(notes, { width: 520 });
    for (const tick of [0, TPQ, TPQ * 5, TPQ * 9.5, TPQ * 15]) {
      const pt = tickToPoint(layout, tick);
      expect(pt).not.toBeNull();
      const back = pointToTick(pt!.system, pt!.x);
      expect(back).not.toBeNull();
      expect(Math.abs(back! - tick)).toBeLessThan(TPQ * 0.02);
    }
  });

  it("reports nothing for a position past the end of the music", () => {
    const layout = lay([note(1, 0, TPQ, 60)]);
    expect(tickToPoint(layout, TPQ * 1000)).toBeNull();
  });

  it("breaks into pages when a page height is given", () => {
    const notes = Array.from({ length: 200 }, (_, i) => note(i + 1, i * TPQ, TPQ, 60 + (i % 9)));
    const layout = lay(notes, { width: 500, pageHeight: 300 });
    expect(layout.pages.length).toBeGreaterThan(1);
    for (const p of layout.pages) {
      expect(p.systems.length).toBeGreaterThan(0);
    }
  });

  it("beams stay attached to their stems", () => {
    // Four sixteenths on beat 1 — one beam group, two beam levels.
    const notes = [0, 1, 2, 3].map((i) => note(i + 1, i * (TPQ / 4), TPQ / 4, 64 + i));
    const layout = lay(notes);
    const m = layout.pages[0].systems[0].measures[0];
    expect(m.beams.length).toBeGreaterThanOrEqual(2); // primary + secondary
    const beamed = m.elements.filter((e) => e.source.beam !== null);
    expect(beamed).toHaveLength(4);
    for (const el of beamed) {
      expect(el.stem).not.toBeNull();
      const stemX = el.x + el.stem!.x;
      // the primary beam must span this stem
      const primary = m.beams.filter((b) => b.level === 0);
      const covered = primary.some(
        (b) => stemX >= Math.min(b.x1, b.x2) - 0.5 && stemX <= Math.max(b.x1, b.x2) + 0.5,
      );
      expect(covered).toBe(true);
    }
  });

  it("draws ledger lines only outside the staff", () => {
    // Middle C (below the treble staff) and a high C (above it).
    const layout = lay([note(1, 0, TPQ, 60), note(2, TPQ, TPQ, 88)]);
    const m = layout.pages[0].systems[0].measures[0];
    const withLedgers = m.elements.filter((e) => e.ledgers.length > 0);
    expect(withLedgers.length).toBe(2);
    for (const el of withLedgers) {
      for (const l of el.ledgers) {
        // A ledger is never between the top and bottom staff lines.
        expect(l.y < 0 || l.y > 4 * 8).toBe(true);
      }
    }
  });
});
