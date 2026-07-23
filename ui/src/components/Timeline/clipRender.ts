/**
 * Canvas rendering for the arrangement (U1): grid, clips (audio waveform via peaks,
 * midi mini preview, fades), and automation lanes. Pure draw functions — the
 * interaction layer lives in ClipCanvas.tsx.
 */

import type { AudioClip, LoopRegion, MidiClip, Project, TimeSigEntry } from "../../protocol/types";
import { beatToPx, bpmAtBeat, pxToBeat, type HViewport } from "../../lib/time";
import { lineV, roundRect } from "../../lib/canvas";
import { pickLod } from "../../lib/peaks";
import { peaksFor } from "./peaksCache";
import {
  CLIP_RADIUS,
  clamp,
  fadePixels,
  gridLines,
  shade,
  sortedPoints,
  themeVar,
  withAlpha,
  type LaneRowL,
  type ParamSpec,
} from "./layout";

/* ============================================================================
 * Theme colors resolved for canvas use
 * ========================================================================= */

export interface TlColors {
  bg: string;
  panel: string;
  border: string;
  borderLight: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  selection: string;
  playhead: string;
  danger: string;
  warn: string;
  /** ruler strip background (--tl-ruler-bg; = --panel except themed washes) */
  ruler: string;
}

export function tlColors(): TlColors {
  return {
    // the ARRANGEMENT pane's surface, not the global bg — the canvas must match
    // the pane tint around it (Prism gives every pane a genuinely different hue)
    bg: themeVar("--pane-arrange"),
    panel: themeVar("--panel"),
    border: themeVar("--border"),
    borderLight: themeVar("--border-light"),
    text: themeVar("--text"),
    textDim: themeVar("--text-dim"),
    textFaint: themeVar("--text-faint"),
    accent: themeVar("--accent"),
    selection: themeVar("--selection"),
    playhead: themeVar("--playhead"),
    danger: themeVar("--danger"),
    warn: themeVar("--warn"),
    ruler: themeVar("--tl-ruler-bg"),
  };
}

export const CLIP_FONT = "600 9.5px Inter, system-ui, sans-serif";
export const SMALL_FONT = "500 10px Inter, system-ui, sans-serif";

/* ============================================================================
 * Grid
 * ========================================================================= */

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  vp: HViewport,
  timeSigMap: TimeSigEntry[],
  division: number | null,
  colors: TlColors,
): void {
  const startBeat = pxToBeat(0, vp);
  const endBeat = pxToBeat(w, vp);
  const lines = gridLines(startBeat, endBeat, vp.zoomX, timeSigMap, division);
  for (const ln of lines) {
    const x = beatToPx(ln.beat, vp);
    if (x < -1 || x > w + 1) continue;
    ctx.strokeStyle =
      ln.level === 0
        ? withAlpha(colors.borderLight, 0.9)
        : ln.level === 1
          ? withAlpha(colors.border, 0.9)
          : withAlpha(colors.border, 0.45);
    lineV(ctx, x, 0, h);
  }
}

export function drawLoopColumn(
  ctx: CanvasRenderingContext2D,
  loop: LoopRegion,
  vp: HViewport,
  w: number,
  h: number,
  colors: TlColors,
): void {
  if (!loop.enabled || loop.endBeat <= loop.startBeat) return;
  const x0 = beatToPx(loop.startBeat, vp);
  const x1 = beatToPx(loop.endBeat, vp);
  if (x1 < 0 || x0 > w) return;
  ctx.fillStyle = withAlpha(colors.accent, 0.05);
  ctx.fillRect(Math.max(0, x0), 0, Math.min(w, x1) - Math.max(0, x0), h);
  ctx.strokeStyle = withAlpha(colors.accent, 0.25);
  if (x0 >= 0 && x0 <= w) lineV(ctx, x0, 0, h);
  if (x1 >= 0 && x1 <= w) lineV(ctx, x1, 0, h);
}

/* ============================================================================
 * Clips
 * ========================================================================= */

export interface ClipDrawOpts {
  clip: AudioClip | MidiClip;
  x: number;
  y: number;
  w: number;
  h: number;
  canvasW: number;
  color: string;
  selected: boolean;
  /** when set, draw as a translucent drag ghost with this alpha */
  ghost?: number;
  /** invalid drop target — red border */
  invalid?: boolean;
  /** fade preview overrides (audio) */
  fadeInSec?: number;
  fadeOutSec?: number;
  /** left-trim preview override (audio): sample peaks from here instead of the clip's */
  srcOffsetSamples?: number;
  showFadeHandles?: boolean;
  project: Project;
  zoomX: number;
  colors: TlColors;
  onPeaksArrive: () => void;
}

export function drawClip(ctx: CanvasRenderingContext2D, o: ClipDrawOpts): void {
  const { clip, x, y, h, colors } = o;
  const w = Math.max(2, o.w);
  if (x + w < -2 || x > o.canvasW + 2 || h < 6) return;
  const muted = clip.muted === true;
  const alpha = o.ghost !== undefined ? o.ghost : muted ? 0.38 : 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  const r = Math.min(CLIP_RADIUS, w / 2);
  const bodyTop = y + 1;
  const bodyH = h - 3;

  // body
  roundRect(ctx, x + 0.5, bodyTop + 0.5, w - 1, bodyH - 1, r);
  ctx.fillStyle = withAlpha(o.color, 0.26);
  ctx.fill();

  // name strip
  const stripH = bodyH >= 26 && w > 16 ? 13 : 0;
  if (stripH > 0) {
    ctx.save();
    roundRect(ctx, x + 0.5, bodyTop + 0.5, w - 1, bodyH - 1, r);
    ctx.clip();
    ctx.fillStyle = withAlpha(o.color, muted ? 0.45 : 0.85);
    ctx.fillRect(x, bodyTop, w, stripH);
    if (w > 26) {
      ctx.fillStyle = "rgba(10,11,14,0.92)";
      ctx.font = CLIP_FONT;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const label = (muted ? "⌀ " : "") + (clip.name || (clip.type === "audio" ? "Audio" : "MIDI"));
      ctx.fillText(label, Math.max(x + 5, 3), bodyTop + stripH / 2 + 0.5, Math.max(8, w - 10));
    }
    ctx.restore();
  }

  // content
  const areaY = bodyTop + stripH + 1;
  const areaH = bodyH - stripH - 3;
  if (areaH > 4 && w > 4) {
    if (clip.type === "audio") drawAudioContent(ctx, o, areaY, areaH);
    else drawMidiContent(ctx, o, clip, areaY, areaH);
  }

  // fades (audio only)
  if (clip.type === "audio") drawFades(ctx, o, clip, bodyTop, bodyH, w);

  // border
  roundRect(ctx, x + 0.5, bodyTop + 0.5, w - 1, bodyH - 1, r);
  ctx.lineWidth = 1;
  ctx.strokeStyle = o.invalid ? colors.danger : shade(o.color, -0.45);
  ctx.stroke();

  if (o.selected) {
    roundRect(ctx, x + 1, bodyTop + 1, w - 2, bodyH - 2, Math.max(0, r - 1));
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.accent;
    ctx.stroke();
  }

  ctx.restore();
}

function drawAudioContent(
  ctx: CanvasRenderingContext2D,
  o: ClipDrawOpts,
  areaY: number,
  areaH: number,
): void {
  const clip = o.clip as AudioClip;
  const project = o.project;
  const asset = project.assets.find((a) => a.id === clip.assetId);
  const cx0 = Math.max(Math.floor(o.x) + 1, 0);
  const cx1 = Math.min(Math.ceil(o.x + o.w) - 1, Math.ceil(o.canvasW));
  if (cx1 <= cx0) return;

  if (!asset || asset.missing) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx0, areaY, cx1 - cx0, areaH);
    ctx.clip();
    ctx.strokeStyle = withAlpha(o.colors.danger, 0.45);
    ctx.lineWidth = 1;
    for (let xx = cx0 - areaH; xx < cx1; xx += 8) {
      ctx.beginPath();
      ctx.moveTo(xx, areaY + areaH);
      ctx.lineTo(xx + areaH, areaY);
      ctx.stroke();
    }
    if (cx1 - cx0 > 60 && areaH > 14) {
      ctx.fillStyle = o.colors.danger;
      ctx.font = SMALL_FONT;
      ctx.textBaseline = "middle";
      ctx.fillText("missing audio", cx0 + 4, areaY + areaH / 2);
    }
    ctx.restore();
    return;
  }

  const bpm = bpmAtBeat(clip.startBeat, project.tempoMap);
  const samplesPerBeat = (project.sampleRate * 60) / Math.max(1e-6, bpm);
  const spp = samplesPerBeat / Math.max(1e-6, o.zoomX); // samples per px
  const lod = pickLod(1 / spp);
  const peaks = peaksFor(asset.id, lod, Math.max(1, asset.channels), o.onPeaksArrive);

  const midY = areaY + areaH / 2;
  const halfH = areaH / 2 - 1;
  const gainScale = clamp(clip.gain, 0, 2);
  ctx.fillStyle = withAlpha(o.color, 0.85);

  if (!peaks || halfH <= 1) {
    ctx.fillRect(cx0, midY - 0.5, cx1 - cx0, 1);
    return;
  }

  const spb = Math.max(1, peaks.samplesPerBucket);
  const ch = Math.max(1, peaks.channels);
  const data = peaks.data;
  const nb = peaks.numBuckets;
  const n = cx1 - cx0;
  if (n <= 0 || nb <= 0) return;

  const tops = new Float32Array(n);
  const bots = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const px = cx0 + i;
    const s0 = (o.srcOffsetSamples ?? clip.srcOffsetSamples) + (px - o.x) * spp;
    const s1 = s0 + spp;
    let b0 = Math.floor(s0 / spb);
    let b1 = Math.max(b0, Math.ceil(s1 / spb) - 1);
    b0 = clamp(b0, 0, nb - 1);
    b1 = clamp(b1, 0, nb - 1);
    let mn = 127;
    let mx = -128;
    for (let b = b0; b <= b1; b++) {
      for (let c = 0; c < ch; c++) {
        const idx = (b * ch + c) * 2;
        const lo = data[idx];
        const hi = data[idx + 1];
        if (lo < mn) mn = lo;
        if (hi > mx) mx = hi;
      }
    }
    if (mx < mn) {
      mn = 0;
      mx = 0;
    }
    const top = clamp((mx / 127) * gainScale, -1, 1);
    const bot = clamp((mn / 127) * gainScale, -1, 1);
    tops[i] = midY - top * halfH;
    bots[i] = Math.max(midY - bot * halfH, midY - top * halfH + 0.8);
  }

  ctx.beginPath();
  ctx.moveTo(cx0, tops[0]);
  for (let i = 1; i < n; i++) ctx.lineTo(cx0 + i, tops[i]);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(cx0 + i, bots[i]);
  ctx.closePath();
  ctx.fill();
}

function drawMidiContent(
  ctx: CanvasRenderingContext2D,
  o: ClipDrawOpts,
  clip: MidiClip,
  areaY: number,
  areaH: number,
): void {
  if (clip.notes.length === 0) return;
  let pmin = 127;
  let pmax = 0;
  for (const nt of clip.notes) {
    if (nt.pitch < pmin) pmin = nt.pitch;
    if (nt.pitch > pmax) pmax = nt.pitch;
  }
  pmin = Math.max(0, pmin - 2);
  pmax = Math.min(127, pmax + 2);
  const range = Math.max(1, pmax - pmin);
  const rowH = Math.min(4, Math.max(1.5, areaH / (range + 1)));

  const cx0 = Math.max(o.x + 1, 0);
  const cx1 = Math.min(o.x + o.w - 1, o.canvasW);
  if (cx1 <= cx0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(cx0, areaY, cx1 - cx0, areaH);
  ctx.clip();
  ctx.fillStyle = withAlpha(o.color, 0.9);
  // PERF (interim guard): a huge MIDI clip would loop every note per frame and hang the
  // Timeline. Above a threshold, draw a single muted summary band spanning the clip's
  // pitch range instead of per-note rects, capping per-frame cost. The proper fix is
  // windowed/cached note rendering (binary-search the visible range) — tracked for later.
  const NOTE_PREVIEW_CAP = 5000;
  if (clip.notes.length > NOTE_PREVIEW_CAP) {
    const tTop = (pmax - pmin) / (range + 1);
    const yTop = areaY + (areaH - rowH) * (1 - tTop);
    const yBot = areaY + (areaH - rowH) * 1 + rowH;
    ctx.fillStyle = withAlpha(o.color, 0.45);
    ctx.fillRect(cx0, yTop, cx1 - cx0, Math.max(rowH, yBot - yTop));
  } else {
    for (const nt of clip.notes) {
      const nx = o.x + nt.startBeat * o.zoomX;
      const nw = Math.max(1.5, nt.lengthBeats * o.zoomX - 0.5);
      if (nx + nw < cx0 || nx > cx1) continue;
      const t = (nt.pitch - pmin) / (range + 1);
      const ny = areaY + (areaH - rowH) * (1 - t);
      ctx.fillRect(nx, ny, nw, rowH);
    }
  }
  ctx.restore();
}

function drawFades(
  ctx: CanvasRenderingContext2D,
  o: ClipDrawOpts,
  clip: AudioClip,
  bodyTop: number,
  bodyH: number,
  w: number,
): void {
  const { inPx, outPx } = fadePixels(
    clip,
    o.project.tempoMap,
    o.zoomX,
    w,
    o.fadeInSec,
    o.fadeOutSec,
  );
  const yTop = bodyTop + 1;
  const yBot = bodyTop + bodyH - 1;
  const x0 = o.x;
  const x1 = o.x + w;

  ctx.save();
  if (inPx > 0.5) {
    ctx.beginPath();
    ctx.moveTo(x0, yTop);
    ctx.lineTo(x0 + inPx, yTop);
    ctx.lineTo(x0, yBot);
    ctx.closePath();
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x0, yBot);
    ctx.lineTo(x0 + inPx, yTop);
    ctx.strokeStyle = withAlpha(o.colors.playhead, 0.7);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (outPx > 0.5) {
    ctx.beginPath();
    ctx.moveTo(x1, yTop);
    ctx.lineTo(x1 - outPx, yTop);
    ctx.lineTo(x1, yBot);
    ctx.closePath();
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x1 - outPx, yTop);
    ctx.lineTo(x1, yBot);
    ctx.strokeStyle = withAlpha(o.colors.playhead, 0.7);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (o.showFadeHandles && w >= 24 && bodyH >= 18) {
    const hs = 5;
    for (const hx of [x0 + inPx, x1 - outPx]) {
      if (hx < -hs || hx > o.canvasW + hs) continue;
      ctx.fillStyle = o.colors.playhead;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(hx - hs / 2, yTop + 1.5, hs, hs);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* ============================================================================
 * Automation lanes
 * ========================================================================= */

export interface LaneOverride {
  movePointId?: number;
  moveBeat?: number;
  moveValue?: number;
  newPoint?: { beat: number; value: number };
  curvePointId?: number;
  curveValue?: number;
}

export interface LaneDrawOpts {
  row: LaneRowL;
  y: number;
  w: number;
  vp: HViewport;
  color: string;
  colors: TlColors;
  spec: ParamSpec;
  /** value of the non-automated parameter (resting line when no points) */
  current: number;
  override?: LaneOverride | null;
  /** point under the cursor — drawn lit like the dragged point */
  hoverPointId?: number | null;
}

export const LANE_PAD = 5;

export function laneValueToY(v: number, spec: ParamSpec, y: number, h: number): number {
  const t = (clamp(v, spec.min, spec.max) - spec.min) / Math.max(1e-9, spec.max - spec.min);
  return y + LANE_PAD + (1 - t) * (h - LANE_PAD * 2);
}

export function laneYToValue(py: number, spec: ParamSpec, y: number, h: number): number {
  const t = 1 - (py - y - LANE_PAD) / Math.max(1, h - LANE_PAD * 2);
  return clamp(spec.min + t * (spec.max - spec.min), spec.min, spec.max);
}

interface LanePt {
  id: number;
  beat: number;
  value: number;
  curve: number;
  isNew?: boolean;
}

export function laneEffectivePoints(row: LaneRowL, override?: LaneOverride | null): LanePt[] {
  const pts: LanePt[] = sortedPoints(row.points).map((p) => ({
    id: p.id,
    beat: p.beat,
    value: p.value,
    curve: p.curve ?? 0,
  }));
  if (override) {
    if (override.movePointId !== undefined) {
      const p = pts.find((q) => q.id === override.movePointId);
      if (p) {
        if (override.moveBeat !== undefined) p.beat = override.moveBeat;
        if (override.moveValue !== undefined) p.value = override.moveValue;
      }
    }
    if (override.curvePointId !== undefined && override.curveValue !== undefined) {
      const p = pts.find((q) => q.id === override.curvePointId);
      if (p) p.curve = override.curveValue;
    }
    if (override.newPoint) {
      pts.push({ id: -1, beat: override.newPoint.beat, value: override.newPoint.value, curve: 0, isNew: true });
    }
    pts.sort((a, b) => a.beat - b.beat);
  }
  return pts;
}

export function drawAutomationLane(ctx: CanvasRenderingContext2D, o: LaneDrawOpts): void {
  const h = o.row.height;
  const { y, w, colors } = o;

  // lane background + bottom separator
  ctx.fillStyle = "rgba(0,0,0,0.20)";
  ctx.fillRect(0, y, w, h);
  ctx.strokeStyle = colors.border;
  ctx.beginPath();
  ctx.moveTo(0, y + h - 0.5);
  ctx.lineTo(w, y + h - 0.5);
  ctx.stroke();

  const pts = laneEffectivePoints(o.row, o.override);

  if (pts.length === 0) {
    const vy = laneValueToY(o.current, o.spec, y, h);
    ctx.save();
    ctx.strokeStyle = withAlpha(o.color, 0.5);
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, vy);
    ctx.lineTo(w, vy);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const px = (beat: number) => beatToPx(beat, o.vp);
  const py = (v: number) => laneValueToY(v, o.spec, y, h);

  // curve path
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, py(pts[0].value));
  if (px(pts[0].beat) > 0) ctx.lineTo(px(pts[0].beat), py(pts[0].value));
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const ax = px(a.beat);
    ctx.lineTo(ax, py(a.value));
    const b = pts[i + 1];
    if (!b) break;
    const bx = px(b.beat);
    if (bx <= ax + 1 || (ax < 0 && bx < 0) || (ax > w && bx > w)) continue;
    if (a.curve !== 0) {
      const steps = clamp(Math.round((bx - ax) / 6), 4, 32);
      const exp = Math.pow(2, a.curve);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const tv = Math.pow(t, exp);
        ctx.lineTo(ax + (bx - ax) * t, py(a.value + (b.value - a.value) * tv));
      }
    }
  }
  const last = pts[pts.length - 1];
  if (px(last.beat) < w) ctx.lineTo(w, py(last.value));

  ctx.strokeStyle = withAlpha(o.color, 0.95);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // fill under curve
  ctx.lineTo(w, y + h - 1);
  ctx.lineTo(0, y + h - 1);
  ctx.closePath();
  ctx.fillStyle = withAlpha(o.color, 0.09);
  ctx.fill();
  ctx.restore();

  // point handles (~6px squares); dragged / hovered points lit accent
  const hs = 6;
  for (const p of pts) {
    const ax = px(p.beat);
    if (ax < -hs || ax > w + hs) continue;
    const ay = py(p.value);
    const hot =
      p.isNew ||
      p.id === o.override?.movePointId ||
      (o.hoverPointId !== undefined && o.hoverPointId !== null && p.id === o.hoverPointId);
    ctx.fillStyle = hot ? colors.accent : colors.bg;
    ctx.fillRect(ax - hs / 2, ay - hs / 2, hs, hs);
    ctx.strokeStyle = withAlpha(o.color, 1);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ax - hs / 2, ay - hs / 2, hs, hs);
  }
}
