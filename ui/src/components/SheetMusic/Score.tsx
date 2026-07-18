/**
 * Score.tsx — draws a laid-out score as SVG.
 *
 * Purely presentational: every coordinate already exists in the ScoreLayout, so this file
 * only decides ink. SVG (not canvas) because the same element tree is what the browser
 * hands to the printer — vector at 600 dpi, no re-render at print resolution — and
 * because noteheads become hit targets for free.
 */

import React from "react";
import {
  ACC_DOUBLE_SHARP,
  ACC_FLAT,
  ACC_NATURAL,
  ACC_SHARP,
  CLEF_ALTO,
  CLEF_BASS,
  CLEF_BASS_DOTS,
  CLEF_TREBLE,
  DOT_R,
  bracePath,
  digitPath,
  digitsWidth,
  flagPath,
  noteheadPath,
  restPath,
  tiePath,
} from "./glyphs";
import {
  CLEF_ANCHOR,
  keySignatureSteps,
  stepY,
  type Clef,
  type LaidElement,
  type LaidMeasure,
  type LaidSystem,
  type ScoreLayout,
} from "./layout";

const STAFF_LINES = 5;
/** Title block height in staff spaces — must clear title, subtitle AND the tempo mark. */
export const HEADER_SPACES = 9;

export interface ScoreProps {
  layout: ScoreLayout;
  /** Index into layout.pages. */
  page: number;
  /** Note ids currently sounding — drawn in the accent colour. */
  highlight?: ReadonlySet<number>;
  selected?: ReadonlySet<number>;
  /** Playhead position within this page, if it falls here. */
  playhead?: { system: LaidSystem; x: number } | null;
  onPickTick?: (tick: number) => void;
  onPickNote?: (noteId: number, additive: boolean) => void;
  showBarNumbers?: boolean;
  /** Added to measure indices when numbering bars (the score may start mid-project). */
  barOffset?: number;
  /** Print the letter name inside each notehead — a learning aid, off by default. */
  noteNames?: boolean;
  /** Page box; when absent the SVG sizes itself to the content. */
  pageWidth?: number;
  pageHeight?: number;
  margin?: number;
  /** Extra room left of the staves — the grand-staff brace lives out here. */
  leftPad?: number;
  header?: { title: string; subtitle?: string; part?: string; tempo?: number; pageNo?: number; pages?: number };
}

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];

function accPath(alter: number): string {
  if (alter === 1) return ACC_SHARP;
  if (alter === -1) return ACC_FLAT;
  if (alter === 2) return ACC_DOUBLE_SHARP;
  return ACC_NATURAL;
}

/** One staff's five lines. */
function StaffLines({ y, width, sp, x }: { y: number; width: number; sp: number; x: number }) {
  const lines = [];
  for (let i = 0; i < STAFF_LINES; i++) {
    const ly = y + i * sp;
    lines.push(
      <line key={i} x1={x} y1={ly} x2={x + width} y2={ly} className="sm-staffline" strokeWidth={Math.max(0.6, sp * 0.09)} />,
    );
  }
  return <>{lines}</>;
}

function Clef({ clef, x, y, sp }: { clef: Clef; x: number; y: number; sp: number }) {
  const cy = y + CLEF_ANCHOR[clef] * sp;
  const t = `translate(${x} ${cy}) scale(${sp})`;
  if (clef === "treble") {
    return (
      <path
        d={CLEF_TREBLE}
        transform={t}
        className="sm-ink"
        fill="none"
        strokeWidth={0.24}
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
    );
  }
  if (clef === "bass") {
    return (
      <g transform={t}>
        <path d={CLEF_BASS} className="sm-ink" />
        {CLEF_BASS_DOTS.map(([dx, dy], i) => (
          <circle key={i} cx={dx} cy={dy} r={0.16} className="sm-ink" />
        ))}
      </g>
    );
  }
  return <path d={CLEF_ALTO} transform={t} className="sm-ink" />;
}

function KeySignature({
  fifths,
  clef,
  x,
  y,
  sp,
}: {
  fifths: number;
  clef: Clef;
  x: number;
  y: number;
  sp: number;
}) {
  const steps = keySignatureSteps(fifths, clef);
  return (
    <>
      {steps.map((s, i) => (
        <path
          key={i}
          d={accPath(s.alter)}
          className="sm-ink"
          transform={`translate(${x + i * 1.05 * sp} ${y + stepY(s.step, clef, sp)}) scale(${sp})`}
        />
      ))}
    </>
  );
}

function TimeSignature({
  num,
  den,
  x,
  y,
  sp,
}: {
  num: number;
  den: number;
  x: number;
  y: number;
  sp: number;
}) {
  const draw = (text: string, cy: number) => {
    const w = digitsWidth(text);
    return text.split("").map((ch, i) => (
      <path
        key={`${cy}-${i}`}
        d={digitPath(ch)}
        className="sm-ink"
        transform={`translate(${x + (i + 0.5) * 1.28 * sp - w * sp * 0 } ${cy}) scale(${sp * 1.05})`}
      />
    ));
  };
  return (
    <>
      {draw(String(num), y + sp)}
      {draw(String(den), y + 3 * sp)}
    </>
  );
}

function Element({
  el,
  staffY,
  sp,
  clef,
  highlight,
  selected,
  noteNames,
  onPickNote,
}: {
  el: LaidElement;
  staffY: number;
  sp: number;
  clef: Clef;
  highlight?: ReadonlySet<number>;
  selected?: ReadonlySet<number>;
  noteNames?: boolean;
  onPickNote?: (noteId: number, additive: boolean) => void;
}) {
  const g: React.ReactNode[] = [];

  if (el.source.kind === "rest") {
    g.push(
      <path
        key="rest"
        d={restPath(el.source.dur.value)}
        className="sm-ink"
        transform={`translate(${el.x} ${staffY + el.restY}) scale(${sp})`}
      />,
    );
    for (let d = 0; d < el.dots; d++) {
      g.push(
        <circle
          key={`d${d}`}
          cx={el.x + (0.85 + d * 0.42) * sp}
          cy={staffY + el.dotY}
          r={DOT_R * sp}
          className="sm-ink"
        />,
      );
    }
    return <g>{g}</g>;
  }

  // ledger lines
  el.ledgers.forEach((l, i) =>
    g.push(
      <line
        key={`l${i}`}
        x1={el.x + l.x1}
        y1={staffY + l.y}
        x2={el.x + l.x2}
        y2={staffY + l.y}
        className="sm-staffline"
        strokeWidth={Math.max(0.7, sp * 0.11)}
      />,
    ),
  );

  // stem
  if (el.stem) {
    g.push(
      <line
        key="stem"
        x1={el.x + el.stem.x}
        y1={staffY + el.stem.y1}
        x2={el.x + el.stem.x}
        y2={staffY + el.stem.y2}
        className="sm-ink-stroke"
        strokeWidth={sp * 0.13}
        strokeLinecap="round"
      />,
    );
    for (let f = 0; f < el.flags; f++) {
      g.push(
        <path
          key={`f${f}`}
          d={flagPath(el.stemUp, f)}
          className="sm-ink"
          transform={`translate(${el.x + el.stem.x} ${staffY + el.stem.y2}) scale(${sp})`}
        />,
      );
    }
  }

  // heads, accidentals, dots
  el.heads.forEach((h, i) => {
    const on = highlight?.has(h.noteId);
    const sel = selected?.has(h.noteId);
    const cls = "sm-head" + (on ? " playing" : "") + (sel ? " selected" : "");
    if (h.accidental !== null) {
      g.push(
        <path
          key={`a${i}`}
          d={accPath(h.accidental)}
          className="sm-ink"
          transform={`translate(${el.x + h.accX} ${staffY + h.y}) scale(${sp})`}
        />,
      );
    }
    g.push(
      <path
        key={`h${i}`}
        d={noteheadPath(h.value)}
        className={cls}
        fillRule="evenodd"
        data-nid={h.noteId}
        transform={`translate(${el.x + h.dx} ${staffY + h.y}) scale(${sp})`}
        onPointerDown={
          onPickNote
            ? (e) => {
                e.stopPropagation();
                onPickNote(h.noteId, e.shiftKey || e.ctrlKey);
              }
            : undefined
        }
      />,
    );
    if (noteNames) {
      g.push(
        <text
          key={`n${i}`}
          x={el.x + h.dx}
          y={staffY + h.y + sp * 0.28}
          className="sm-headname"
          fontSize={sp * 0.72}
          textAnchor="middle"
        >
          {LETTERS[((h.step % 7) + 7) % 7]}
        </text>,
      );
    }
    for (let d = 0; d < el.dots; d++) {
      g.push(
        <circle
          key={`hd${i}-${d}`}
          cx={el.x + h.dx + (0.95 + d * 0.42) * sp}
          cy={staffY + el.dotY}
          r={DOT_R * sp}
          className="sm-ink"
        />,
      );
    }
  });

  return <g>{g}</g>;
}

function Measure({
  m,
  sys,
  layout,
  isLastOfScore,
  props,
}: {
  m: LaidMeasure;
  sys: LaidSystem;
  layout: ScoreLayout;
  isLastOfScore: boolean;
  props: ScoreProps;
}) {
  const sp = layout.sp;
  const parts: React.ReactNode[] = [];
  const staffCount = layout.staffCount;

  // prefix: clef / key / meter, per staff
  for (let s = 0; s < staffCount; s++) {
    const clef = layout.clefs[s] ?? "treble";
    const y = sys.y + (sys.staffY[s] ?? 0);
    let px = m.x + 0.6 * sp;
    if (m.showClef) {
      parts.push(<Clef key={`c${s}`} clef={clef} x={px + 1.4 * sp} y={y} sp={sp} />);
      px += 3.1 * sp;
    }
    if (m.showKey && layout.fifths !== 0) {
      parts.push(<KeySignature key={`k${s}`} fifths={layout.fifths} clef={clef} x={px + 0.4 * sp} y={y} sp={sp} />);
      px += (Math.abs(layout.fifths) * 1.05 + 0.5) * sp;
    }
    if (m.showMeter) {
      parts.push(<TimeSignature key={`t${s}`} num={m.meter.num} den={m.meter.den} x={px + 0.3 * sp} y={y} sp={sp} />);
    }
  }

  // elements
  for (const el of m.elements) {
    const y = sys.y + (sys.staffY[el.staff] ?? 0);
    parts.push(
      <Element
        key={`e${el.staff}-${el.start}-${el.x}`}
        el={el}
        staffY={y}
        sp={sp}
        clef={layout.clefs[el.staff] ?? "treble"}
        highlight={props.highlight}
        selected={props.selected}
        noteNames={props.noteNames}
        onPickNote={props.onPickNote}
      />,
    );
  }

  // beams
  m.beams.forEach((b, i) => {
    const y = sys.y + (sys.staffY[b.staff] ?? 0);
    const th = sp * 0.5;
    parts.push(
      <path
        key={`b${i}`}
        className="sm-ink"
        d={`M${b.x1} ${y + b.y1}L${b.x2} ${y + b.y2}L${b.x2} ${y + b.y2 + th}L${b.x1} ${y + b.y1 + th}Z`}
      />,
    );
  });

  // ties
  m.ties.forEach((t, i) => {
    const y = sys.y + (sys.staffY[t.staff] ?? 0);
    parts.push(
      <path
        key={`ti${i}`}
        className="sm-ink"
        transform={`translate(0 ${y}) scale(${sp})`}
        d={tiePath(t.x1 / sp, t.y1 / sp, t.x2 / sp, t.y2 / sp, t.dir)}
      />,
    );
  });

  // barline at the measure's right edge, spanning all staves
  const top = sys.y + (sys.staffY[0] ?? 0);
  const bottom = sys.y + (sys.staffY[staffCount - 1] ?? 0) + 4 * sp;
  const bx = m.x + m.width;
  if (isLastOfScore) {
    parts.push(
      <g key="final">
        <line x1={bx - sp * 0.55} y1={top} x2={bx - sp * 0.55} y2={bottom} className="sm-ink-stroke" strokeWidth={sp * 0.11} />
        <rect x={bx - sp * 0.32} y={top} width={sp * 0.32} height={bottom - top} className="sm-ink" />
      </g>,
    );
  } else {
    parts.push(
      <line key="bar" x1={bx} y1={top} x2={bx} y2={bottom} className="sm-ink-stroke" strokeWidth={sp * 0.11} />,
    );
  }

  if (props.showBarNumbers) {
    parts.push(
      <text key="num" x={m.x + 0.2 * sp} y={top - sp * 0.9} className="sm-barnum" fontSize={sp * 0.95}>
        {m.index + 1 + (props.barOffset ?? 0)}
      </text>,
    );
  }

  if (m.dynamic) {
    parts.push(
      <text
        key="dyn"
        x={m.contentX}
        y={bottom + sp * 1.9}
        className="sm-dynamic"
        fontSize={sp * 1.7}
      >
        {m.dynamic}
      </text>,
    );
  }

  return <g>{parts}</g>;
}

export default function Score(props: ScoreProps) {
  const { layout, page } = props;
  const sp = layout.sp;
  const pg = layout.pages[page];
  if (!pg) return null;

  const margin = props.margin ?? 0;
  const headerH = props.header && page === 0 ? HEADER_SPACES * sp : 0;
  const contentW = props.pageWidth ? props.pageWidth - margin * 2 : layout.width;
  const contentH = props.pageHeight ? props.pageHeight - margin * 2 : pg.height + sp * 2;
  const svgW = props.pageWidth ?? layout.width + (props.leftPad ?? 0);
  const svgH = props.pageHeight ?? pg.height + sp * 4;

  const lastSystem = pg.systems[pg.systems.length - 1];

  const onBackgroundClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!props.onPickTick) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const scale = svgW / rect.width;
    const x = (e.clientX - rect.left) * scale - margin - (props.leftPad ?? 0);
    const y = (e.clientY - rect.top) * scale - margin - headerH;
    // nearest system by vertical distance
    let best: { sys: (typeof pg.systems)[number]; d: number } | null = null;
    for (const s of pg.systems) {
      const d = y < s.y ? s.y - y : y > s.y + s.height ? y - (s.y + s.height) : 0;
      if (!best || d < best.d) best = { sys: s, d };
    }
    if (!best) return;
    for (const m of best.sys.measures) {
      if (x >= m.x && x < m.x + m.width) {
        const frac = Math.max(0, Math.min(1, (x - m.contentX) / Math.max(1, m.contentW)));
        props.onPickTick(m.startTick + frac * m.ticks);
        return;
      }
    }
  };

  return (
    <svg
      className="sm-page"
      width={svgW}
      height={svgH}
      viewBox={`0 0 ${svgW} ${svgH}`}
      onClick={onBackgroundClick}
      role="img"
      aria-label="Sheet music"
    >
      {props.pageWidth ? <rect x={0} y={0} width={svgW} height={svgH} className="sm-paper" /> : null}

      {props.header && page === 0 ? (
        <g className="sm-header">
          <text x={contentW / 2 + margin} y={margin + sp * 3} textAnchor="middle" className="sm-title" fontSize={sp * 2.6}>
            {props.header.title}
          </text>
          {props.header.subtitle ? (
            <text x={contentW / 2 + margin} y={margin + sp * 4.9} textAnchor="middle" className="sm-subtitle" fontSize={sp * 1.2}>
              {props.header.subtitle}
            </text>
          ) : null}
          {props.header.part ? (
            <text x={margin} y={margin + sp * 6.6} className="sm-part" fontSize={sp * 1.15}>
              {props.header.part}
            </text>
          ) : null}
          {props.header.tempo ? (
            <text x={margin + (props.leftPad ?? 0)} y={margin + sp * 7.9} className="sm-tempo" fontSize={sp * 1.1}>
              {`♩ = ${Math.round(props.header.tempo)}`}
            </text>
          ) : null}
        </g>
      ) : null}

      <g transform={`translate(${margin + (props.leftPad ?? 0)} ${margin + headerH})`} className="sm-music">
        {pg.systems.map((sys, si) => {
          const staffCount = layout.staffCount;
          const top = sys.y + (sys.staffY[0] ?? 0);
          const bottom = sys.y + (sys.staffY[staffCount - 1] ?? 0) + 4 * sp;
          return (
            <g key={si}>
              {Array.from({ length: staffCount }, (_, s) => (
                <StaffLines key={s} x={0} y={sys.y + (sys.staffY[s] ?? 0)} width={sys.width} sp={sp} />
              ))}
              {/* system spine + brace */}
              <line x1={0} y1={top} x2={0} y2={bottom} className="sm-ink-stroke" strokeWidth={sp * 0.13} />
              {staffCount > 1 ? (
                <path
                  className="sm-ink"
                  d={bracePath((bottom - top) / sp)}
                  transform={`translate(${-sp * 0.85} ${top}) scale(${sp})`}
                />
              ) : null}
              {sys.measures.map((m, mi) => (
                <Measure
                  key={mi}
                  m={m}
                  sys={sys}
                  layout={layout}
                  isLastOfScore={
                    page === layout.pages.length - 1 && sys === lastSystem && mi === sys.measures.length - 1
                  }
                  props={props}
                />
              ))}
            </g>
          );
        })}

        {props.playhead ? (
          <line
            className="sm-playhead"
            x1={props.playhead.x}
            x2={props.playhead.x}
            y1={props.playhead.system.y - sp * 1.2}
            y2={
              props.playhead.system.y +
              (props.playhead.system.staffY[layout.staffCount - 1] ?? 0) +
              4 * sp +
              sp * 1.2
            }
          />
        ) : null}
      </g>

      {props.header?.pages && props.header.pages > 1 ? (
        <text x={svgW / 2} y={svgH - margin * 0.45} textAnchor="middle" className="sm-pageno" fontSize={sp * 1.1}>
          {`${(props.header.pageNo ?? 0) + 1} / ${props.header.pages}`}
        </text>
      ) : null}
    </svg>
  );
}
