import { describe, expect, it } from "vitest";
import { TPQ, buildScore, type SourceNote } from "./notation";
import { toMusicXml } from "./musicxml";

const note = (id: number, start: number, ticks: number, pitch: number): SourceNote => ({
  id,
  start,
  ticks,
  pitch,
  velocity: 90,
});

/**
 * Minimal well-formedness check — the test environment is node (no DOMParser) and a
 * whole XML parser is not worth a dependency. Verifies tags nest and close, and that
 * text content carries no raw markup characters.
 */
function assertWellFormed(xml: string): void {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][\w-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = tag.exec(body)) !== null) {
    const text = body.slice(lastEnd, m.index);
    if (text.includes("<")) throw new Error(`raw '<' in text: ${text.slice(0, 40)}`);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(text)) {
      throw new Error(`unescaped '&' in text: ${text.slice(0, 40)}`);
    }
    lastEnd = m.index + m[0].length;

    const [, closing, name, , selfClose] = m;
    if (selfClose) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) throw new Error(`</${name}> closes <${open ?? "nothing"}>`);
    } else {
      stack.push(name);
    }
  }
  if (stack.length) throw new Error(`unclosed: ${stack.join(", ")}`);
}

const xmlFor = (notes: SourceNote[], splitPitch: number | null = null, fifths = 0) =>
  toMusicXml(
    buildScore(notes, { meter: { num: 4, den: 4 }, fifths, quantize: TPQ / 4, splitPitch, transpose: 0 }),
    {
      title: "Test Piece",
      partName: "Piano",
      clefs: splitPitch === null ? ["treble"] : ["treble", "bass"],
      fifths,
      tempo: 120,
    },
  );

describe("MusicXML export", () => {
  it("emits a well-formed partwise document", () => {
    const xml = xmlFor([note(1, 0, TPQ, 60)]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<score-partwise version="4.0">');
    expect(xml).toContain("</score-partwise>");
    // tags balance
    const opens = (xml.match(/<measure\b/g) ?? []).length;
    const closes = (xml.match(/<\/measure>/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(() => assertWellFormed(xml)).not.toThrow();
  });

  it("carries the title, part name, divisions, key and tempo", () => {
    const xml = xmlFor([note(1, 0, TPQ, 60)], null, 3);
    expect(xml).toContain("<work-title>Test Piece</work-title>");
    expect(xml).toContain("<part-name>Piano</part-name>");
    expect(xml).toContain(`<divisions>${TPQ}</divisions>`);
    expect(xml).toContain("<fifths>3</fifths>");
    expect(xml).toContain("<per-minute>120</per-minute>");
  });

  it("exports SPELLED pitches, not raw MIDI numbers", () => {
    // In A major (3 sharps) MIDI 61 must be written C#, not Db.
    const xml = xmlFor([note(1, 0, TPQ, 61)], null, 3);
    expect(xml).toContain("<step>C</step>");
    expect(xml).toContain("<alter>1</alter>");
    expect(xml).not.toContain("<step>D</step>");
  });

  it("marks ties across a barline at both ends", () => {
    const xml = xmlFor([note(1, TPQ * 3, TPQ * 2, 60)]);
    expect(xml).toContain('<tie type="start"/>');
    expect(xml).toContain('<tie type="stop"/>');
    expect(xml).toContain('<tied type="start"/>');
    expect(xml).toContain('<tied type="stop"/>');
  });

  it("writes chords with the <chord/> marker on the later notes only", () => {
    const xml = xmlFor([note(1, 0, TPQ, 60), note(2, 0, TPQ, 64), note(3, 0, TPQ, 67)]);
    expect((xml.match(/<chord\/>/g) ?? []).length).toBe(2); // 3 notes, 2 markers
  });

  it("backs the cursor up between staves of a grand staff", () => {
    const xml = xmlFor([note(1, 0, TPQ, 72), note(2, 0, TPQ, 48)], 60);
    expect(xml).toContain("<staves>2</staves>");
    expect(xml).toContain("<backup>");
    expect(xml).toContain('<clef number="2"><sign>F</sign><line>4</line></clef>');
    expect(xml).toContain("<staff>2</staff>");
  });

  it("escapes characters that would break the XML", () => {
    const xml = toMusicXml(
      buildScore([note(1, 0, TPQ, 60)], {
        meter: { num: 4, den: 4 },
        fifths: 0,
        quantize: TPQ / 4,
        splitPitch: null,
        transpose: 0,
      }),
      { title: 'Rock & <Roll> "Live"', partName: "Gtr & Bass", clefs: ["treble"], fifths: 0 },
    );
    expect(xml).toContain("Rock &amp; &lt;Roll&gt; &quot;Live&quot;");
    expect(() => assertWellFormed(xml)).not.toThrow();
  });

  it("emits rests for empty time", () => {
    const xml = xmlFor([note(1, TPQ * 2, TPQ, 60)]);
    expect(xml).toContain("<rest/>");
  });
});
