/**
 * PianoRoll canvas renderers (U4). All drawing in CSS pixels (useCanvas applies the dpr
 * transform). Colors resolve from theme tokens / .pr-root component tokens (pianoRoll.css)
 * — no hardcoded color literals here.
 */

import { crisp, lineH, lineV, roundRect } from "../../lib/canvas";
import { barToBeat, beatToBar, timeSigAtBeat } from "../../lib/time";
import type { TimeSigEntry } from "../../protocol/types";
import * as M from "./prMath";
import type { PrView, RenderCcPoint, RenderNote } from "./prMath";

/* ============================================================================
 * Palette — resolved once from CSS custom properties on .pr-root
 * ========================================================================= */

export interface Palette {
  panel: string;
  border: string;
  borderLight: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  selection: string;
  playhead: string;
  rowWhite: string;
  rowBlack: string;
  gridFine: string;
  gridBeat: string;
  gridBar: string;
  gridOctave: string;
  keyWhite: string;
  keyBlack: string;
  keyText: string;
  keyBorder: string;
  outside: string;
  clipSpan: string;
  clipEdge: string;
  velBg: string;
  noteText: string;
  /** chord-track tone-row wash (translucent accent) */
  chordTone: string;
}

const VAR_MAP: Array<[keyof Palette, string, string]> = [
  ["panel", "--panel", "#1e2027"],
  ["border", "--border", "#2a2d36"],
  ["borderLight", "--border-light", "#353947"],
  ["text", "--text", "#d7dae3"],
  ["textDim", "--text-dim", "#8b90a0"],
  ["textFaint", "--text-faint", "#5f6573"],
  ["accent", "--accent", "#5b8cff"],
  ["selection", "--selection", "rgba(91,140,255,0.25)"],
  ["playhead", "--playhead", "#e8eaf2"],
  ["rowWhite", "--pr-row-white", "#1f222a"],
  ["rowBlack", "--pr-row-black", "#1a1c23"],
  ["gridFine", "--pr-grid-fine", "#252830"],
  ["gridBeat", "--pr-grid-beat", "#2e323d"],
  ["gridBar", "--pr-grid-bar", "#3c414f"],
  ["gridOctave", "--pr-grid-octave", "#30343f"],
  ["keyWhite", "--pr-key-white", "#b6bcc9"],
  ["keyBlack", "--pr-key-black", "#23262e"],
  ["keyText", "--pr-key-text", "#454b59"],
  ["keyBorder", "--pr-key-border", "#868c9b"],
  ["outside", "--pr-outside", "rgba(10,11,14,0.45)"],
  // Faint "the clip lives here" wash. The grid marks real bars now, so the clip
  // start no longer has a line of its own — this keeps it readable without
  // pretending to be musical structure (Omer, 2026-08-14). Theme-overridable.
  ["clipSpan", "--pr-clip-span", "rgba(150,180,255,0.10)"],
  ["clipEdge", "--pr-clip-edge", "rgba(150,180,255,0.55)"],
  ["velBg", "--pr-vel-bg", "#191b21"],
  ["noteText", "--pr-note-text", "rgba(13,14,18,0.78)"],
  ["chordTone", "--pr-chord-tone", "rgba(91,140,255,0.10)"],
];

export function resolvePalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const out = {} as Palette;
  for (const [key, cssVar, fallback] of VAR_MAP) {
    const v = cs.getPropertyValue(cssVar).trim();
    out[key] = v || fallback;
  }
  return out;
}

/* ============================================================================
 * Color helpers (velocity → opacity/saturation of the note color)
 * ========================================================================= */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const rgbCache = new Map<string, Rgb>();

function hexToRgb(hex: string): Rgb {
  const cached = rgbCache.get(hex);
  if (cached) return cached;
  let h = hex.trim().replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  let r = 128;
  let g = 128;
  let b = 128;
  if (/^[0-9a-fA-F]{6}$/.test(h)) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  const out = { r, g, b };
  rgbCache.set(hex, out);
  return out;
}

function rgba(c: Rgb, a: number): string {
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

/* Velocity heat ramp (UI_IMPROVE.md §2.3B): blue → yellow → red, saturated
   mid-tones that read on every theme (same family as the track palette). */
const HEAT_LO: Rgb = { r: 74, g: 163, b: 232 }; // #4aa3e8
const HEAT_MID: Rgb = { r: 216, g: 201, b: 69 }; // #d8c945
const HEAT_HI: Rgb = { r: 224, g: 80, b: 76 }; // #e0504c

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

/** velT ∈ [0,1] → heat color. */
function velHeat(velT: number): Rgb {
  return velT < 0.5 ? lerpRgb(HEAT_LO, HEAT_MID, velT * 2) : lerpRgb(HEAT_MID, HEAT_HI, (velT - 0.5) * 2);
}

function lighten(c: Rgb, t: number): Rgb {
  return {
    r: Math.round(c.r + (255 - c.r) * t),
    g: Math.round(c.g + (255 - c.g) * t),
    b: Math.round(c.b + (255 - c.b) * t),
  };
}

const FONT = "9px Inter, system-ui, sans-serif";
const FONT_RULER = "10px Inter, system-ui, sans-serif";

/* ============================================================================
 * Keys column
 * ========================================================================= */

export function drawKeys(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: PrView,
  pressedPitch: number | null,
  pal: Palette,
  /** Pointer-hovered key (UI_IMPROVE.md §8.4): brightened + named. */
  hoverPitch: number | null = null,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = pal.keyWhite;
  ctx.fillRect(0, 0, w, h);

  const pTop = M.yToPitch(0, v);
  const pBot = M.yToPitch(h, v);
  const blackW = Math.round(w * 0.62);

  for (let p = pBot; p <= pTop; p++) {
    const y = M.pitchTop(p, v);
    if (M.isBlackKey(p)) {
      ctx.fillStyle = pal.keyBlack;
      ctx.fillRect(0, y, blackW, v.rowH);
      // white-key gap line behind the black key (real-piano look)
      ctx.strokeStyle = pal.keyBorder;
      ctx.globalAlpha = 0.45;
      lineH(ctx, blackW, w, y + v.rowH / 2);
      ctx.globalAlpha = 1;
    }
  }
  // full-width separators between adjacent white keys (B|C and E|F boundaries)
  ctx.strokeStyle = pal.keyBorder;
  ctx.globalAlpha = 0.6;
  for (let p = pBot; p <= pTop; p++) {
    const pc = p % 12;
    if (pc === 0 || pc === 5) {
      lineH(ctx, 0, w, M.pitchTop(p, v) + v.rowH);
    }
  }
  ctx.globalAlpha = 1;

  // hover: soft highlight (under the press highlight, if both)
  if (
    hoverPitch !== null &&
    hoverPitch !== pressedPitch &&
    hoverPitch >= pBot &&
    hoverPitch <= pTop
  ) {
    ctx.fillStyle = pal.accent;
    ctx.globalAlpha = 0.16;
    ctx.fillRect(0, M.pitchTop(hoverPitch, v), w, v.rowH);
    ctx.globalAlpha = 1;
  }

  if (pressedPitch !== null && pressedPitch >= pBot && pressedPitch <= pTop) {
    ctx.fillStyle = pal.accent;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, M.pitchTop(pressedPitch, v), w, v.rowH);
    ctx.globalAlpha = 1;
  }

  if (v.rowH >= 9) {
    ctx.font = FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = pal.keyText;
    for (let p = pBot; p <= pTop; p++) {
      if (p % 12 === 0) {
        ctx.fillText(M.pitchName(p), w - 4, M.pitchTop(p, v) + v.rowH / 2 + 0.5);
      }
    }
  }

  // name the hovered/pressed key (skip Cs — already labeled above)
  const named = pressedPitch ?? hoverPitch;
  if (named !== null && named % 12 !== 0 && named >= pBot && named <= pTop && v.rowH >= 7) {
    ctx.font = FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = pal.keyText;
    ctx.fillText(M.pitchName(named), w - 4, M.pitchTop(named, v) + v.rowH / 2 + 0.5);
  }
}

/* ============================================================================
 * Ruler — ABSOLUTE bars via clip.startBeat offset (brief requirement)
 * ========================================================================= */

/** Width of the clip-edge grips in the ruler; the hit test uses the same number. */
export const PR_EDGE_HANDLE_W = 7;

export function drawRuler(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: PrView,
  clipStartBeat: number,
  clipLengthBeats: number,
  timeSigMap: TimeSigEntry[],
  pal: Palette,
  /** Live drag preview for the clip-edge handles: clip-relative beats. */
  handlePreview: { startBeat?: number; lengthBeats?: number } | null = null,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = pal.panel;
  ctx.fillRect(0, 0, w, h);

  const absStart = clipStartBeat + M.xToBeat(0, v);
  const absEnd = clipStartBeat + M.xToBeat(w, v);
  const sig = timeSigAtBeat(Math.max(0, absStart), timeSigMap);
  const barPx = sig.beatsPerBar * v.zoomX;
  let labelEvery = 1;
  while (barPx * labelEvery < 44) labelEvery *= 2;

  const firstBar = Math.max(1, beatToBar(Math.max(0, absStart), timeSigMap));
  const lastBar = beatToBar(Math.max(0, absEnd), timeSigMap) + 1;

  ctx.font = FONT_RULER;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  for (let bar = firstBar; bar <= lastBar; bar++) {
    const barBeat = barToBeat(bar, timeSigMap);
    const x = M.beatToX(barBeat - clipStartBeat, v);
    if (x > w + 1) break;
    ctx.strokeStyle = pal.borderLight;
    lineV(ctx, x, h * 0.35, h);
    if ((bar - 1) % labelEvery === 0) {
      ctx.fillStyle = pal.textDim;
      ctx.fillText(String(bar), x + 3, 3);
    }
    // beat ticks inside the bar
    if (v.zoomX >= 14 && labelEvery === 1) {
      const bs = timeSigAtBeat(barBeat, timeSigMap);
      ctx.strokeStyle = pal.border;
      for (let b = 1; b < bs.num; b++) {
        const bx = M.beatToX(barBeat + b * (4 / bs.den) - clipStartBeat, v);
        if (bx > w) break;
        lineV(ctx, bx, h * 0.65, h);
      }
    }
  }

  // shade past the clip end
  const endX = M.beatToX(clipLengthBeats, v);
  if (endX < w) {
    ctx.fillStyle = pal.outside;
    ctx.fillRect(Math.max(0, endX), 0, w - Math.max(0, endX), h);
  }

  // Clip-edge handles (Omer, 2026-08-14): small grips in the ruler at the clip's start
  // and end, dragged to trim or extend the part without leaving the piano roll. Drawn
  // last so they sit above the shading, and sized for the pointer, not for looks.
  const hStart = handlePreview?.startBeat ?? 0;
  const hEnd = handlePreview?.lengthBeats ?? clipLengthBeats;
  for (const [beat, side] of [[hStart, -1], [hEnd, 1]] as const) {
    const x = M.beatToX(beat, v);
    if (x < -PR_EDGE_HANDLE_W || x > w + PR_EDGE_HANDLE_W) continue;
    const left = side < 0 ? x : x - PR_EDGE_HANDLE_W;
    ctx.fillStyle = pal.clipEdge;
    ctx.fillRect(left, 1, PR_EDGE_HANDLE_W, h - 3);
    ctx.fillStyle = pal.panel;
    ctx.fillRect(left + 2, h * 0.3, 1, h * 0.4); // grip line, so it reads as a handle
  }

  ctx.strokeStyle = pal.border;
  lineH(ctx, 0, w, h - 1);
}

/* ============================================================================
 * Notes grid + notes + marquee (single canvas)
 * ========================================================================= */

export interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function drawNotesArea(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: PrView,
  clipLengthBeats: number,
  stepBeats: number,
  beatsPerBar: number,
  notes: RenderNote[],
  baseColor: string,
  pal: Palette,
  marquee: MarqueeRect | null,
  /** In-scale pitch classes (0-11), or null = classic white/black-key rows. */
  scale: ReadonlySet<number> | null = null,
  /** Heat mode (§2.3B): tint notes blue→red by velocity instead of opacity. */
  velColors = false,
  /** Chord-track tone highlight (TRACK_TYPES_PLAN §3.7): per CLIP-RELATIVE beat range,
   *  tint the chord-tone rows — the region ends where the next chord begins. */
  chordRegions: ReadonlyArray<{ startBeat: number; endBeat: number; pcs: ReadonlySet<number> }> | null = null,
  /** Where this clip sits on the TIMELINE. The emphasised grid lines mark real bars, so
   *  they have to be measured from the project's bar 1 — a clip that starts off-bar was
   *  drawing its own beat 0 as a barline and every accent after it was wrong
   *  (Omer, 2026-08-14). */
  clipStartBeat = 0,
): void {
  ctx.clearRect(0, 0, w, h);

  /* ---- pitch rows (scale set → in-scale light / out-of-scale dark, FL-style) ---- */
  ctx.fillStyle = pal.rowWhite;
  ctx.fillRect(0, 0, w, h);
  const pTop = M.yToPitch(0, v);
  const pBot = M.yToPitch(h, v);
  ctx.fillStyle = pal.rowBlack;
  for (let p = pBot; p <= pTop; p++) {
    const dark = scale ? !scale.has(((p % 12) + 12) % 12) : M.isBlackKey(p);
    if (dark) ctx.fillRect(0, M.pitchTop(p, v), w, v.rowH);
  }
  // chord-track tone highlight: accent wash on chord-tone rows per chord region
  if (chordRegions) {
    for (const cr of chordRegions) {
      const x0 = Math.max(0, M.beatToX(cr.startBeat, v));
      const x1 = Math.min(w, M.beatToX(cr.endBeat, v));
      if (x1 <= x0) continue;
      ctx.fillStyle = pal.chordTone;
      for (let p = pBot; p <= pTop; p++) {
        if (cr.pcs.has(((p % 12) + 12) % 12))
          ctx.fillRect(x0, M.pitchTop(p, v), x1 - x0, v.rowH);
      }
    }
  }
  // hairline row separators when rows are tall enough
  if (v.rowH >= 10) {
    ctx.strokeStyle = pal.gridFine;
    for (let p = pBot; p <= pTop; p++) {
      lineH(ctx, 0, w, M.pitchTop(p, v) + v.rowH);
    }
  }
  // octave (C) dividers
  ctx.strokeStyle = pal.gridOctave;
  for (let p = pBot; p <= pTop; p++) {
    if (p % 12 === 0) lineH(ctx, 0, w, M.pitchTop(p, v) + v.rowH);
  }

  /* ---- the clip's own span: a barely-there wash so you can still see where the part
     begins and ends now that the grid answers to the timeline instead ---- */
  {
    const x0 = M.beatToX(0, v);
    const x1 = M.beatToX(clipLengthBeats, v);
    const spanStart = Math.max(0, x0);
    const spanEnd = Math.min(w, x1);
    if (spanEnd > spanStart) {
      ctx.fillStyle = pal.clipSpan;
      ctx.fillRect(spanStart, 0, spanEnd - spanStart, h);
    }
    // ...and mark the BOUNDARIES themselves. A wash alone reads as "slightly different
    // shade" and the eye slides over it; the edges are what the user is actually looking
    // for (Omer, 2026-08-14 — the first attempt was too faint to see).
    ctx.strokeStyle = pal.clipEdge;
    if (x0 >= -1 && x0 <= w + 1) lineV(ctx, x0, 0, h);
    if (x1 >= -1 && x1 <= w + 1) lineV(ctx, x1, 0, h);
  }

  /* ---- vertical grid (absolute bars — see clipStartBeat) ---- */
  let effStep = stepBeats;
  while (effStep > 0 && effStep * v.zoomX < 7) effStep *= 2;
  if (effStep > 0) {
    const startBeat = Math.max(0, M.xToBeat(0, v));
    const endBeat = M.xToBeat(w, v);
    // Walk ABSOLUTE beats: the accents belong to the timeline's bars, not to the clip.
    const i0 = Math.floor((startBeat + clipStartBeat) / effStep);
    const i1 = Math.ceil((endBeat + clipStartBeat) / effStep);
    const eps = 1e-6;
    for (let i = i0; i <= i1; i++) {
      const absBeat = i * effStep;
      const beat = absBeat - clipStartBeat; // clip-relative, for the pixel mapping
      const x = M.beatToX(beat, v);
      if (x < -1 || x > w + 1) continue;
      const barPos = absBeat / beatsPerBar;
      const isBar = Math.abs(barPos - Math.round(barPos)) < eps;
      const isBeat = Math.abs(absBeat - Math.round(absBeat)) < eps;
      ctx.strokeStyle = isBar ? pal.gridBar : isBeat ? pal.gridBeat : pal.gridFine;
      lineV(ctx, x, 0, h);
    }
  }

  /* ---- area past clip end ---- */
  const endX = M.beatToX(clipLengthBeats, v);
  if (endX < w) {
    ctx.fillStyle = pal.outside;
    ctx.fillRect(Math.max(0, endX), 0, w - Math.max(0, endX), h);
    ctx.strokeStyle = pal.borderLight;
    lineV(ctx, endX, 0, h);
  }

  /* ---- notes (velocity → opacity; selected accent; ghosts for alt-copy) ---- */
  const base = hexToRgb(baseColor);
  const selBase = lighten(base, 0.25);
  const accent = pal.accent;
  const showLabels = v.rowH >= 13;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = FONT;

  // draw unselected first so selected stay visible on top
  for (const pass of [0, 1] as const) {
    for (const n of notes) {
      if ((pass === 1) !== n.selected) continue;
      const x = M.beatToX(n.startBeat, v);
      const nw = Math.max(3, n.lengthBeats * v.zoomX - 1);
      if (x + nw < -2 || x > w + 2) continue;
      const y = M.pitchTop(n.pitch, v) + 1;
      const nh = Math.max(2, v.rowH - 2);
      if (y + nh < -2 || y > h + 2) continue;

      const velT = M.clamp(n.velocity, 1, 127) / 127;
      const alpha = velColors ? 0.9 : 0.35 + 0.6 * velT; // heat mode: hue carries velocity
      const body = velColors ? velHeat(velT) : base;
      const selBody = velColors ? lighten(velHeat(velT), 0.25) : selBase;
      if (n.ghost) ctx.globalAlpha = 0.55;
      roundRect(ctx, x, y, nw, nh, Math.min(3, nh / 2));
      ctx.fillStyle = n.selected ? rgba(selBody, Math.max(alpha, 0.75)) : rgba(body, alpha);
      ctx.fill();
      if (n.ghost) ctx.setLineDash([3, 2]);
      ctx.strokeStyle = n.selected ? accent : rgba(lighten(body, 0.1), 0.9);
      ctx.lineWidth = n.selected ? 1.5 : 1;
      ctx.stroke();
      ctx.lineWidth = 1;
      if (n.ghost) {
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      if (showLabels && nw >= 34) {
        ctx.fillStyle = pal.noteText;
        const label = M.pitchName(n.pitch);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, y, nw - 2, nh);
        ctx.clip();
        ctx.fillText(label, x + 4, y + nh / 2 + 0.5);
        ctx.restore();
      }
    }
  }

  /* ---- marquee ---- */
  if (marquee) {
    const mx = Math.min(marquee.x0, marquee.x1);
    const my = Math.min(marquee.y0, marquee.y1);
    const mw = Math.abs(marquee.x1 - marquee.x0);
    const mh = Math.abs(marquee.y1 - marquee.y0);
    ctx.fillStyle = pal.selection;
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = accent;
    ctx.strokeRect(crisp(mx), crisp(my), Math.max(1, mw), Math.max(1, mh));
  }
}

/* ============================================================================
 * Velocity lane
 * ========================================================================= */

export function drawVelLane(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: PrView,
  clipLengthBeats: number,
  notes: RenderNote[],
  baseColor: string,
  pal: Palette,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = pal.velBg;
  ctx.fillRect(0, 0, w, h);

  // guides at 25/50/75%
  ctx.strokeStyle = pal.gridFine;
  for (const t of [0.25, 0.5, 0.75]) {
    lineH(ctx, 0, w, h - 4 - t * (h - 8));
  }

  const base = hexToRgb(baseColor);
  const barW = M.velBarW(v.zoomX);

  for (const pass of [0, 1] as const) {
    for (const n of notes) {
      if ((pass === 1) !== n.selected) continue;
      if (n.ghost) continue;
      const x = M.beatToX(n.startBeat, v);
      if (x + barW < -2 || x > w + 2) continue;
      const velT = M.clamp(n.velocity, 1, 127) / 127;
      // Shared velocity geometry: M.velToY is the bar TOP for this velocity, and the
      // hit-test (PianoRoll velFromY → M.velYToVel) is its exact inverse. bh keeps the
      // >=2px visual floor by pinning the bottom at h-2.
      const y = M.velToY(n.velocity, h);
      const bh = Math.max(2, h - 2 - y);
      ctx.fillStyle = n.selected ? pal.accent : rgba(base, 0.4 + 0.5 * velT);
      roundRect(ctx, x, y, barW, bh, 1.5);
      ctx.fill();
      // value cap
      ctx.fillStyle = n.selected ? pal.playhead : rgba(lighten(base, 0.3), 0.95);
      ctx.fillRect(x, y, barW, 2);
    }
  }

  const endX = M.beatToX(clipLengthBeats, v);
  if (endX < w) {
    ctx.fillStyle = pal.outside;
    ctx.fillRect(Math.max(0, endX), 0, w - Math.max(0, endX), h);
  }
}

/* ============================================================================
 * CC / pitch-bend lane — step-line (value holds until the next point) + points
 * ========================================================================= */

export function drawCcLane(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: PrView,
  clipLengthBeats: number,
  points: RenderCcPoint[], // sorted by beat (buildRenderCc)
  bipolar: boolean, // pitch bend: baseline at the 0.5 center line
  baseColor: string,
  pal: Palette,
  marquee: MarqueeRect | null,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = pal.velBg;
  ctx.fillRect(0, 0, w, h);

  // guides at 25/50/75% (center emphasized when bipolar)
  ctx.strokeStyle = pal.gridFine;
  for (const t of [0.25, 0.5, 0.75]) {
    lineH(ctx, 0, w, M.ccValueToY(t, h));
  }
  if (bipolar) {
    ctx.strokeStyle = pal.gridBar;
    lineH(ctx, 0, w, M.ccValueToY(0.5, h));
  }

  const base = hexToRgb(baseColor);
  const baseY = M.ccValueToY(bipolar ? 0.5 : 0, h);

  // step segments: each point's value holds until the next point
  if (points.length > 0) {
    ctx.fillStyle = rgba(base, 0.16);
    for (let i = 0; i < points.length; i++) {
      const x0 = M.beatToX(points[i].beat, v);
      const x1 = i + 1 < points.length ? M.beatToX(points[i + 1].beat, v) : w;
      if (x1 < 0 || x0 > w) continue;
      const y = M.ccValueToY(points[i].value, h);
      ctx.fillRect(Math.max(0, x0), Math.min(y, baseY), Math.min(x1, w) - Math.max(0, x0), Math.abs(y - baseY));
    }
    ctx.strokeStyle = rgba(lighten(base, 0.2), 0.95);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const x0 = M.beatToX(points[i].beat, v);
      const x1 = i + 1 < points.length ? M.beatToX(points[i + 1].beat, v) : w;
      const y = M.ccValueToY(points[i].value, h);
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      if (i + 1 < points.length) ctx.lineTo(x1, M.ccValueToY(points[i + 1].value, h));
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // points (selected on top)
  for (const pass of [0, 1] as const) {
    for (const p of points) {
      if ((pass === 1) !== p.selected) continue;
      const x = M.beatToX(p.beat, v);
      if (x < -4 || x > w + 4) continue;
      const y = M.ccValueToY(p.value, h);
      const r = p.ghost ? 1.5 : 2.5;
      ctx.fillStyle = p.selected ? pal.accent : rgba(lighten(base, 0.3), 0.95);
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      if (p.selected && !p.ghost) {
        ctx.strokeStyle = pal.playhead;
        ctx.strokeRect(crisp(x - r), crisp(y - r), r * 2, r * 2);
      }
    }
  }

  // shade past the clip end
  const endX = M.beatToX(clipLengthBeats, v);
  if (endX < w) {
    ctx.fillStyle = pal.outside;
    ctx.fillRect(Math.max(0, endX), 0, w - Math.max(0, endX), h);
  }

  // marquee (lane multi-select)
  if (marquee) {
    const mx = Math.min(marquee.x0, marquee.x1);
    const my = Math.min(marquee.y0, marquee.y1);
    const mw = Math.abs(marquee.x1 - marquee.x0);
    const mh = Math.abs(marquee.y1 - marquee.y0);
    ctx.fillStyle = pal.selection;
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = pal.accent;
    ctx.strokeRect(crisp(mx), crisp(my), Math.max(1, mw), Math.max(1, mh));
  }
}

/* ============================================================================
 * Playhead overlay
 * ========================================================================= */

export function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  x: number,
  playing: boolean,
  pal: Palette,
): void {
  ctx.clearRect(0, 0, w, h);
  if (x < -1 || x > w + 1) return;
  ctx.globalAlpha = playing ? 0.9 : 0.45;
  ctx.strokeStyle = pal.playhead;
  lineV(ctx, x, 0, h);
  ctx.globalAlpha = 1;
}
