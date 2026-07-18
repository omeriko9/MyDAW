/**
 * Score.tsx — draws a laid-out score as SVG, and is the pane's hit-testing surface.
 *
 * Purely presentational plus geometry: every coordinate already exists in the ScoreLayout,
 * so this file decides ink and turns pointer events back into musical positions
 * ({staff, tick, step}) for the editor. SVG rather than canvas because the same element
 * tree is what the printer receives — vector at any DPI — and noteheads become hit
 * targets for free.
 *
 * Glyphs are real Bravura outlines (see bravura.ts); they render in font units through
 * glyphAt(), which also flips the y axis.
 */

import React from "react";
import {
  BBOX,
  BRAVURA,
  BRACE_H,
  DOT_W,
  accidentalGlyph,
  clefGlyph,
  digitGlyph,
  digitWidth,
  digitsWidth,
  flagGlyph,
  glyphAt,
  noteheadGlyph,
  noteheadHalfWidth,
  restGlyph,
  restWidth,
  tiePath,
  unitScale,
} from "./glyphs";
import {
  CLEF_ANCHOR,
  keySignatureSteps,
  prefixSlots,
  stepY,
  yToStep,
  type Clef,
  type LaidElement,
  type LaidMeasure,
  type LaidSystem,
  type ScoreLayout,
} from "./layout";

const STAFF_LINES = 5;
/** Title block height in staff spaces — must clear title, subtitle AND the tempo mark. */
export const HEADER_SPACES = 9;

/** A musical position resolved from a pointer event. */
export interface ScorePoint {
  page: number;
  system: LaidSystem;
  staff: number;
  /** Absolute tick under the pointer (unsnapped). */
  tick: number;
  /** Diatonic step under the pointer. */
  step: number;
  /** Content-space coordinates, for drawing a marquee. */
  x: number;
  y: number;
}

export interface ScoreProps {
  layout: ScoreLayout;
  page: number;
  highlight?: ReadonlySet<number>;
  selected?: ReadonlySet<number>;
  showBarNumbers?: boolean;
  barOffset?: number;
  noteNames?: boolean;
  pageWidth?: number;
  pageHeight?: number;
  margin?: number;
  leftPad?: number;
  header?: { title: string; subtitle?: string; part?: string; tempo?: number; pageNo?: number; pages?: number };
  /** Edit mode changes the cursor and enables note insertion. */
  editing?: boolean;
  /** Marquee rectangle in content coordinates, while rubber-band selecting on this page. */
  marquee?: { x1: number; y1: number; x2: number; y2: number } | null;
  onPickTick?: (tick: number) => void;
  onNoteDown?: (noteId: number, e: React.PointerEvent) => void;
  onStaffDown?: (pt: ScorePoint, e: React.PointerEvent) => void;
  onNoteContext?: (noteId: number, e: React.MouseEvent) => void;
  onStaffContext?: (pt: ScorePoint, e: React.MouseEvent) => void;
}

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];

/** Draw one Bravura glyph with its origin at (x, y) px. */
function G({
  name,
  x,
  y,
  sp,
  className = "sm-ink",
}: {
  name: string;
  x: number;
  y: number;
  sp: number;
  className?: string;
}) {
  const d = BRAVURA[name];
  if (!d) return null;
  return <path d={d} className={className} transform={glyphAt(x, y, sp)} />;
}

function StaffLines({ y, width, sp, x }: { y: number; width: number; sp: number; x: number }) {
  const lines = [];
  for (let i = 0; i < STAFF_LINES; i++) {
    const ly = y + i * sp;
    lines.push(
      <line
        key={i}
        x1={x}
        y1={ly}
        x2={x + width}
        y2={ly}
        className="sm-staffline"
        strokeWidth={Math.max(0.6, sp * 0.09)}
      />,
    );
  }
  return <>{lines}</>;
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
  return (
    <>
      {keySignatureSteps(fifths, clef).map((s, i) => {
        const g = accidentalGlyph(s.alter);
        return g ? <G key={i} name={g} x={x + i * 1.05 * sp} y={y + stepY(s.step, clef, sp)} sp={sp} /> : null;
      })}
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
    const total = digitsWidth(text);
    const slot = Math.max(digitsWidth(String(num)), digitsWidth(String(den)));
    let cx = x + ((slot - total) / 2) * sp; // centre the shorter row over the longer
    return text.split("").map((ch, i) => {
      const el = <G key={`${cy}-${i}`} name={digitGlyph(ch)} x={cx} y={cy} sp={sp} />;
      cx += digitWidth(ch) * sp;
      return el;
    });
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
  highlight,
  selected,
  noteNames,
  onNoteDown,
  onNoteContext,
}: {
  el: LaidElement;
  staffY: number;
  sp: number;
  highlight?: ReadonlySet<number>;
  selected?: ReadonlySet<number>;
  noteNames?: boolean;
  onNoteDown?: (noteId: number, e: React.PointerEvent) => void;
  onNoteContext?: (noteId: number, e: React.MouseEvent) => void;
}) {
  const g: React.ReactNode[] = [];

  if (el.source.kind === "rest") {
    const name = restGlyph(el.source.dur.value);
    g.push(<G key="rest" name={name} x={el.x - (restWidth(el.source.dur.value) / 2) * sp} y={staffY + el.restY} sp={sp} />);
    for (let d = 0; d < el.dots; d++) {
      g.push(
        <G
          key={`d${d}`}
          name="augmentationDot"
          x={el.x + (0.75 + d * (DOT_W + 0.18)) * sp}
          y={staffY + el.dotY}
          sp={sp}
        />,
      );
    }
    return <g>{g}</g>;
  }

  el.ledgers.forEach((l, i) =>
    g.push(
      <line
        key={`l${i}`}
        x1={el.x + l.x1}
        y1={staffY + l.y}
        x2={el.x + l.x2}
        y2={staffY + l.y}
        className="sm-staffline"
        strokeWidth={Math.max(0.7, sp * 0.13)}
      />,
    ),
  );

  if (el.stem) {
    g.push(
      <line
        key="stem"
        x1={el.x + el.stem.x}
        y1={staffY + el.stem.y1}
        x2={el.x + el.stem.x}
        y2={staffY + el.stem.y2}
        className="sm-ink-stroke"
        strokeWidth={sp * 0.12}
      />,
    );
    if (el.flags > 0) {
      const fg = flagGlyph(el.source.dur.value, el.stemUp);
      if (fg) g.push(<G key="flag" name={fg} x={el.x + el.stem.x} y={staffY + el.stem.y2} sp={sp} />);
    }
  }

  el.heads.forEach((h, i) => {
    const on = highlight?.has(h.noteId);
    const sel = selected?.has(h.noteId);
    const cls = "sm-head" + (on ? " playing" : "") + (sel ? " selected" : "");
    const half = noteheadHalfWidth(h.value) * sp;

    if (h.accidental !== null) {
      const ag = accidentalGlyph(h.accidental);
      if (ag) g.push(<G key={`a${i}`} name={ag} x={el.x + h.accX} y={staffY + h.y} sp={sp} />);
    }

    g.push(
      <path
        key={`h${i}`}
        d={BRAVURA[noteheadGlyph(h.value)]}
        className={cls}
        data-nid={h.noteId}
        transform={glyphAt(el.x + h.dx - half, staffY + h.y, sp)}
        onPointerDown={onNoteDown ? (e) => onNoteDown(h.noteId, e) : undefined}
        onContextMenu={onNoteContext ? (e) => onNoteContext(h.noteId, e) : undefined}
      />,
    );

    if (noteNames) {
      g.push(
        <text
          key={`n${i}`}
          x={el.x + h.dx}
          y={staffY + h.y + sp * 0.3}
          className="sm-headname"
          fontSize={sp * 0.78}
          textAnchor="middle"
        >
          {LETTERS[((h.step % 7) + 7) % 7]}
        </text>,
      );
    }

    for (let d = 0; d < el.dots; d++) {
      g.push(
        <G
          key={`hd${i}-${d}`}
          name="augmentationDot"
          x={el.x + h.dx + half + (0.28 + d * (DOT_W + 0.18)) * sp}
          y={staffY + el.dotY}
          sp={sp}
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
  const slots = prefixSlots(sp, m.showClef, m.showKey, m.showMeter, layout.fifths);

  for (let s = 0; s < staffCount; s++) {
    const clef = layout.clefs[s] ?? "treble";
    const y = sys.y + (sys.staffY[s] ?? 0);
    if (m.showClef) {
      parts.push(
        <G key={`c${s}`} name={clefGlyph(clef)} x={m.x + slots.clef} y={y + CLEF_ANCHOR[clef] * sp} sp={sp} />,
      );
    }
    if (m.showKey && layout.fifths !== 0) {
      parts.push(
        <KeySignature key={`k${s}`} fifths={layout.fifths} clef={clef} x={m.x + slots.key} y={y} sp={sp} />,
      );
    }
    if (m.showMeter) {
      parts.push(
        <TimeSignature key={`t${s}`} num={m.meter.num} den={m.meter.den} x={m.x + slots.meter} y={y} sp={sp} />,
      );
    }
  }

  for (const el of m.elements) {
    const y = sys.y + (sys.staffY[el.staff] ?? 0);
    parts.push(
      <Element
        key={`e${el.staff}-${el.start}-${el.x}`}
        el={el}
        staffY={y}
        sp={sp}
        highlight={props.highlight}
        selected={props.selected}
        noteNames={props.noteNames}
        onNoteDown={props.onNoteDown}
        onNoteContext={props.onNoteContext}
      />,
    );
  }

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

  const top = sys.y + (sys.staffY[0] ?? 0);
  const bottom = sys.y + (sys.staffY[staffCount - 1] ?? 0) + 4 * sp;
  const bx = m.x + m.width;
  if (isLastOfScore) {
    parts.push(
      <g key="final">
        <line
          x1={bx - sp * 0.55}
          y1={top}
          x2={bx - sp * 0.55}
          y2={bottom}
          className="sm-ink-stroke"
          strokeWidth={sp * 0.11}
        />
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
      <text key="dyn" x={m.contentX} y={bottom + sp * 1.9} className="sm-dynamic" fontSize={sp * 1.7}>
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
  const leftPad = props.leftPad ?? 0;
  const headerH = props.header && page === 0 ? HEADER_SPACES * sp : 0;
  const contentW = props.pageWidth ? props.pageWidth - margin * 2 : layout.width;
  const svgW = props.pageWidth ?? layout.width + leftPad;
  const svgH = props.pageHeight ?? pg.height + sp * 4;
  const lastSystem = pg.systems[pg.systems.length - 1];

  /** Pointer event → musical position on this page. */
  const locate = (clientX: number, clientY: number, svg: SVGSVGElement): ScorePoint | null => {
    const rect = svg.getBoundingClientRect();
    const scale = svgW / Math.max(1, rect.width);
    const x = (clientX - rect.left) * scale - margin - leftPad;
    const y = (clientY - rect.top) * scale - margin - headerH;

    let best: { sys: LaidSystem; d: number } | null = null;
    for (const s of pg.systems) {
      const d = y < s.y ? s.y - y : y > s.y + s.height ? y - (s.y + s.height) : 0;
      if (!best || d < best.d) best = { sys: s, d };
    }
    if (!best) return null;
    const sys = best.sys;

    // nearest staff within the system
    let staff = 0;
    let bestD = Infinity;
    for (let i = 0; i < layout.staffCount; i++) {
      const top = sys.y + (sys.staffY[i] ?? 0);
      const d = y < top ? top - y : y > top + 4 * sp ? y - (top + 4 * sp) : 0;
      if (d < bestD) {
        bestD = d;
        staff = i;
      }
    }
    const staffTopY = sys.y + (sys.staffY[staff] ?? 0);
    const step = yToStep(y - staffTopY, layout.clefs[staff] ?? "treble", sp);

    for (const m of sys.measures) {
      if (x >= m.x && x < m.x + m.width) {
        const frac = Math.max(0, Math.min(1, (x - m.contentX) / Math.max(1, m.contentW)));
        return { page, system: sys, staff, tick: m.startTick + frac * m.ticks, step, x, y };
      }
    }
    return null;
  };

  const onBackgroundPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const pt = locate(e.clientX, e.clientY, e.currentTarget);
    if (!pt) return;
    if (props.onStaffDown) props.onStaffDown(pt, e);
    else props.onPickTick?.(pt.tick);
  };

  const onBackgroundContext = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!props.onStaffContext) return;
    const pt = locate(e.clientX, e.clientY, e.currentTarget as unknown as SVGSVGElement);
    if (pt) props.onStaffContext(pt, e);
  };

  return (
    <svg
      className={"sm-page" + (props.editing ? " editing" : "")}
      width={svgW}
      height={svgH}
      viewBox={`0 0 ${svgW} ${svgH}`}
      onPointerDown={onBackgroundPointerDown}
      onContextMenu={onBackgroundContext}
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
            <text
              x={contentW / 2 + margin}
              y={margin + sp * 4.9}
              textAnchor="middle"
              className="sm-subtitle"
              fontSize={sp * 1.2}
            >
              {props.header.subtitle}
            </text>
          ) : null}
          {props.header.tempo ? (
            <text x={margin + leftPad} y={margin + sp * 7.9} className="sm-tempo" fontSize={sp * 1.1}>
              {`♩ = ${Math.round(props.header.tempo)}`}
            </text>
          ) : null}
        </g>
      ) : null}

      <g transform={`translate(${margin + leftPad} ${margin + headerH})`} className="sm-music">
        {pg.systems.map((sys, si) => {
          const staffCount = layout.staffCount;
          const top = sys.y + (sys.staffY[0] ?? 0);
          const bottom = sys.y + (sys.staffY[staffCount - 1] ?? 0) + 4 * sp;
          return (
            <g key={si}>
              {Array.from({ length: staffCount }, (_, s) => (
                <StaffLines key={s} x={0} y={sys.y + (sys.staffY[s] ?? 0)} width={sys.width} sp={sp} />
              ))}
              <line x1={0} y1={top} x2={0} y2={bottom} className="sm-ink-stroke" strokeWidth={sp * 0.13} />
              {staffCount > 1 ? (
                <path
                  className="sm-ink"
                  d={BRAVURA.brace}
                  // The brace outline is a fixed height; stretch it to span the system.
                  transform={`translate(${-sp * 0.9} ${bottom}) scale(${unitScale(sp)} ${
                    -unitScale(sp) * ((bottom - top) / sp / BRACE_H)
                  })`}
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

        {props.marquee ? (
          <rect
            className="sm-marquee"
            x={Math.min(props.marquee.x1, props.marquee.x2)}
            y={Math.min(props.marquee.y1, props.marquee.y2)}
            width={Math.abs(props.marquee.x2 - props.marquee.x1)}
            height={Math.abs(props.marquee.y2 - props.marquee.y1)}
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

/** Bounding box of a laid element's noteheads, for marquee hit-testing. */
export function elementBox(el: LaidElement, staffY: number, sp: number): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  const half = noteheadHalfWidth(el.heads[0]?.value ?? 4) * sp;
  const ys = el.heads.map((h) => staffY + h.y);
  return {
    x1: el.x - half,
    x2: el.x + half,
    y1: Math.min(...ys) - sp * 0.5,
    y2: Math.max(...ys) + sp * 0.5,
  };
}

export { BBOX };
