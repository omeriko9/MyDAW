/**
 * musicxml.ts — export the engraved model as MusicXML 4.0 (partwise).
 *
 * The point of this file: printing from a browser is fine for a lead sheet, but anyone
 * doing real preparation wants the score in MuseScore / Dorico / Sibelius. MusicXML is
 * the lingua franca, it is plain text, and we already hold every fact it needs — pitch
 * SPELLING (not just MIDI numbers), notated durations, ties, beams, stems and staff
 * assignment. Exporting from the notation model rather than from raw MIDI is what makes
 * the result open as written rather than as a quantised mess.
 */

import { TPQ, type NotatedElement, type NotatedMeasure } from "./notation";
import type { Clef } from "./layout";

const TYPE_NAME: Record<number, string> = {
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "16th",
  32: "32nd",
  64: "64th",
};

const ACC_NAME: Record<number, string> = {
  [-2]: "flat-flat",
  [-1]: "flat",
  0: "natural",
  1: "sharp",
  2: "double-sharp",
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CLEF_SIGN: Record<Clef, { sign: string; line: number }> = {
  treble: { sign: "G", line: 2 },
  bass: { sign: "F", line: 4 },
  alto: { sign: "C", line: 3 },
};

export interface MusicXmlOptions {
  title: string;
  partName: string;
  composer?: string;
  clefs: Clef[];
  fifths: number;
  /** Quarter-notes per minute at the start of the score. */
  tempo?: number;
}

/** Beam state for one element, given its position in its group. */
function beamStates(el: NotatedElement): string | null {
  if (el.beam === null || el.beamIndex === undefined || el.beamCount === undefined) return null;
  if (el.beamIndex === 0) return "begin";
  if (el.beamIndex === el.beamCount - 1) return "end";
  return "continue";
}

function noteXml(el: NotatedElement, staff: number, indent: string): string {
  const out: string[] = [];
  const type = TYPE_NAME[el.dur.value] ?? "quarter";
  const dots = "<dot/>".repeat(el.dur.dots);
  const beam = beamStates(el);
  const beamXml = beam ? `<beam number="1">${beam}</beam>` : "";

  if (el.kind === "rest") {
    out.push(
      `${indent}<note>`,
      `${indent}  <rest/>`,
      `${indent}  <duration>${Math.round(el.dur.ticks)}</duration>`,
      `${indent}  <voice>${staff + 1}</voice>`,
      `${indent}  <type>${type}</type>`,
      ...(dots ? [`${indent}  ${dots}`] : []),
      `${indent}  <staff>${staff + 1}</staff>`,
      `${indent}</note>`,
    );
    return out.join("\n");
  }

  el.heads.forEach((h, i) => {
    const p = h.spelled;
    const tie: string[] = [];
    const tied: string[] = [];
    if (h.tieFrom) {
      tie.push(`${indent}  <tie type="stop"/>`);
      tied.push(`<tied type="stop"/>`);
    }
    if (h.tieTo) {
      tie.push(`${indent}  <tie type="start"/>`);
      tied.push(`<tied type="start"/>`);
    }
    out.push(
      `${indent}<note>`,
      ...(i > 0 ? [`${indent}  <chord/>`] : []),
      `${indent}  <pitch>`,
      `${indent}    <step>${p.letter}</step>`,
      ...(p.alter !== 0 ? [`${indent}    <alter>${p.alter}</alter>`] : []),
      `${indent}    <octave>${p.octave}</octave>`,
      `${indent}  </pitch>`,
      `${indent}  <duration>${Math.round(el.dur.ticks)}</duration>`,
      ...tie,
      `${indent}  <voice>${staff + 1}</voice>`,
      `${indent}  <type>${type}</type>`,
      ...(dots ? [`${indent}  ${dots}`] : []),
      ...(h.accidental !== null ? [`${indent}  <accidental>${ACC_NAME[h.accidental] ?? "natural"}</accidental>`] : []),
      `${indent}  <stem>${el.stemUp ? "up" : "down"}</stem>`,
      `${indent}  <staff>${staff + 1}</staff>`,
      ...(beamXml && i === 0 ? [`${indent}  ${beamXml}`] : []),
      ...(tied.length ? [`${indent}  <notations>${tied.join("")}</notations>`] : []),
      `${indent}</note>`,
    );
  });
  return out.join("\n");
}

export function toMusicXml(measures: NotatedMeasure[], opt: MusicXmlOptions): string {
  const staffCount = opt.clefs.length;
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
  );
  lines.push('<score-partwise version="4.0">');
  lines.push(`  <work><work-title>${esc(opt.title)}</work-title></work>`);
  lines.push("  <identification>");
  if (opt.composer) lines.push(`    <creator type="composer">${esc(opt.composer)}</creator>`);
  lines.push("    <encoding><software>MyDAW</software></encoding>");
  lines.push("  </identification>");
  lines.push("  <part-list>");
  lines.push(`    <score-part id="P1"><part-name>${esc(opt.partName)}</part-name></score-part>`);
  lines.push("  </part-list>");
  lines.push('  <part id="P1">');

  measures.forEach((m, mi) => {
    lines.push(`    <measure number="${mi + 1}">`);
    if (mi === 0) {
      lines.push("      <attributes>");
      lines.push(`        <divisions>${TPQ}</divisions>`);
      lines.push(`        <key><fifths>${opt.fifths}</fifths></key>`);
      lines.push(`        <time><beats>${m.meter.num}</beats><beat-type>${m.meter.den}</beat-type></time>`);
      lines.push(`        <staves>${staffCount}</staves>`);
      opt.clefs.forEach((c, i) => {
        const cl = CLEF_SIGN[c];
        lines.push(`        <clef number="${i + 1}"><sign>${cl.sign}</sign><line>${cl.line}</line></clef>`);
      });
      lines.push("      </attributes>");
      if (opt.tempo) {
        lines.push("      <direction placement=\"above\">");
        lines.push("        <direction-type>");
        lines.push(
          `          <metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(opt.tempo)}</per-minute></metronome>`,
        );
        lines.push("        </direction-type>");
        lines.push(`        <sound tempo="${Math.round(opt.tempo)}"/>`);
        lines.push("      </direction>");
      }
    } else if (m.showMeter) {
      lines.push("      <attributes>");
      lines.push(`        <time><beats>${m.meter.num}</beats><beat-type>${m.meter.den}</beat-type></time>`);
      lines.push("      </attributes>");
    }

    m.staves.forEach((staff, si) => {
      if (si > 0) {
        // Rewind the cursor so the next staff starts at the barline again.
        lines.push(`      <backup><duration>${Math.round(m.ticks)}</duration></backup>`);
      }
      for (const el of staff) lines.push(noteXml(el, si, "      "));
    });

    lines.push("    </measure>");
  });

  lines.push("  </part>");
  lines.push("</score-partwise>");
  return lines.join("\n");
}

/** Hand the file to the browser's download flow (no engine round-trip needed). */
export function downloadMusicXml(xml: string, filename: string): void {
  const blob = new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".musicxml") ? filename : `${filename}.musicxml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
