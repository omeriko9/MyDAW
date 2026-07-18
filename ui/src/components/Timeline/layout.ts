/**
 * Timeline layout & math (U1 — components/Timeline).
 *
 * Row model (track rows + automation lane rows), clip geometry (beats↔samples windows,
 * fade pixel math), adaptive grid line generation, automation evaluation (SPEC §7 curve
 * shape v = lerp^(2^curve)), paramRef specs, and theme/color helpers shared by the
 * timeline canvases. Pure functions only — no React here.
 */

import type {
  AudioClip,
  AutomationPoint,
  Clip,
  Grid,
  Project,
  TempoPoint,
  TimeSigEntry,
  Track,
  TrackKind,
} from "../../protocol/types";
import {
  barToBeat,
  beatToBar,
  beatsToSeconds,
  bpmAtBeat,
  secondsToBeats,
  snapBeat,
  timeSigAtBeat,
  type SnapMode,
} from "../../lib/time";
import { gainToDbText } from "../common/Fader";
import type { IconName } from "../common/icons";

/* ============================================================================
 * Constants
 * ========================================================================= */

/** Ruler total height: loop strip + marker lane + bars/beats strip. */
export const RULER_H = 48;
export const RULER_LOOP_H = 14;
export const RULER_MARKER_H = 16;
/** y where the bars/beats strip starts inside the ruler. */
export const RULER_BARS_Y = RULER_LOOP_H + RULER_MARKER_H;

export const DEFAULT_TRACK_H = 64;
export const MIN_TRACK_H = 28;
export const MAX_TRACK_H = 400;
/** Automation lane row height (not affected by vertical zoom). */
export const LANE_H = 44;

/** store.viewport.zoomY === BASE_ZOOM_Y → track-height scale 1. */
export const BASE_ZOOM_Y = 16;
export const MIN_ZOOM_X = 0.5;
export const MAX_ZOOM_X = 640;
export const MIN_ZOOM_Y = 8;
export const MAX_ZOOM_Y = 48;

export const EDGE_HIT_PX = 6;
export const FADE_HIT_PX = 7;
export const POINT_HIT_PX = 7;
export const CLIP_RADIUS = 4;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Vertical zoom factor applied to track heights. */
export function vScaleOf(zoomY: number): number {
  return clamp(zoomY, MIN_ZOOM_Y, MAX_ZOOM_Y) / BASE_ZOOM_Y;
}

/** Snap helper: respects grid.snap; `disable` (shift while dragging) bypasses. Clamps ≥ 0. */
export function snapB(
  beat: number,
  grid: Grid | null | undefined,
  disable = false,
  mode: SnapMode = "round",
): number {
  if (disable || !grid) return Math.max(0, beat);
  return Math.max(0, snapBeat(beat, grid, mode));
}

/* ============================================================================
 * Row model — track rows and automation lane rows, vertically stacked
 * ========================================================================= */

export interface TrackRowL {
  kind: "track";
  track: Track;
  /** folder nesting depth */
  depth: number;
  /** absolute y offset in content space (px) */
  top: number;
  height: number;
  /** index into project.tracks (flat ordered list) */
  flatIndex: number;
}

export interface LaneRowL {
  kind: "lane";
  track: Track;
  paramRef: string;
  points: AutomationPoint[];
  top: number;
  height: number;
  depth: number;
}

export type Row = TrackRowL | LaneRowL;

export interface RowsOptions {
  collapsedFolders: ReadonlySet<number>;
  /** tracks with their automation lanes expanded */
  autoExpanded: ReadonlySet<number>;
  /** locally added (still point-less) lanes per trackId */
  extraLanes: ReadonlyMap<number, readonly string[]>;
  /** live height preview during a header height drag (display px) */
  heightOverride?: { trackId: number; height: number } | null;
  vScale: number;
}

export function trackDisplayHeight(track: Track, vScale: number): number {
  return clamp(Math.round((track.height ?? DEFAULT_TRACK_H) * vScale), MIN_TRACK_H, MAX_TRACK_H);
}

export function computeRows(project: Project | null, o: RowsOptions): Row[] {
  if (!project) return [];
  const byId = new Map<number, Track>(project.tracks.map((t) => [t.id, t]));
  const isHidden = (t: Track): boolean => {
    let p = t.parentId;
    let guard = 0;
    while (p !== undefined && guard++ < 64) {
      if (o.collapsedFolders.has(p)) return true;
      p = byId.get(p)?.parentId;
    }
    return false;
  };
  const depthOf = (t: Track): number => {
    let d = 0;
    let p = t.parentId;
    let guard = 0;
    while (p !== undefined && guard++ < 64) {
      d++;
      p = byId.get(p)?.parentId;
    }
    return d;
  };

  const rows: Row[] = [];
  let top = 0;
  project.tracks.forEach((t, flatIndex) => {
    if (isHidden(t)) return;
    const h =
      o.heightOverride && o.heightOverride.trackId === t.id
        ? clamp(o.heightOverride.height, MIN_TRACK_H, MAX_TRACK_H)
        : trackDisplayHeight(t, o.vScale);
    const depth = depthOf(t);
    rows.push({ kind: "track", track: t, depth, top, height: h, flatIndex });
    top += h;
    if (o.autoExpanded.has(t.id)) {
      const seen = new Set<string>();
      for (const lane of t.automation) {
        if (seen.has(lane.paramRef)) continue;
        seen.add(lane.paramRef);
        rows.push({ kind: "lane", track: t, paramRef: lane.paramRef, points: lane.points, top, height: LANE_H, depth });
        top += LANE_H;
      }
      for (const ref of o.extraLanes.get(t.id) ?? []) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        rows.push({ kind: "lane", track: t, paramRef: ref, points: [], top, height: LANE_H, depth });
        top += LANE_H;
      }
    }
  });
  return rows;
}

export function rowsBottom(rows: Row[]): number {
  const last = rows[rows.length - 1];
  return last ? last.top + last.height : 0;
}

export function rowAtY(rows: Row[], y: number): Row | null {
  for (const r of rows) {
    if (y >= r.top && y < r.top + r.height) return r;
  }
  return null;
}

export function trackRowOf(rows: Row[], trackId: number): TrackRowL | null {
  for (const r of rows) {
    if (r.kind === "track" && r.track.id === trackId) return r;
  }
  return null;
}

export function laneRowOf(rows: Row[], trackId: number, paramRef: string): LaneRowL | null {
  for (const r of rows) {
    if (r.kind === "lane" && r.track.id === trackId && r.paramRef === paramRef) return r;
  }
  return null;
}

/* ============================================================================
 * Clip geometry
 * ========================================================================= */

/** Duration in beats of `samples` starting at musical position `startBeat`. */
export function samplesToBeatsAt(
  startBeat: number,
  samples: number,
  tempoMap: TempoPoint[],
  sampleRate: number,
): number {
  if (!(sampleRate > 0)) return 0;
  const s0 = beatsToSeconds(startBeat, tempoMap);
  return secondsToBeats(s0 + samples / sampleRate, tempoMap) - startBeat;
}

/** Samples spanned by `beats` starting at musical position `startBeat`. */
export function beatsToSamplesAt(
  startBeat: number,
  beats: number,
  tempoMap: TempoPoint[],
  sampleRate: number,
): number {
  const s0 = beatsToSeconds(startBeat, tempoMap);
  const s1 = beatsToSeconds(startBeat + beats, tempoMap);
  return Math.max(0, Math.round((s1 - s0) * sampleRate));
}

export function clipLengthBeats(clip: Clip, tempoMap: TempoPoint[], sampleRate: number): number {
  if (clip.type === "midi") return Math.max(0, clip.lengthBeats);
  return Math.max(0, samplesToBeatsAt(clip.startBeat, clip.lengthSamples, tempoMap, sampleRate));
}

export function clipEndBeat(clip: Clip, tempoMap: TempoPoint[], sampleRate: number): number {
  return clip.startBeat + clipLengthBeats(clip, tempoMap, sampleRate);
}

/** Fade-in/out widths in px for an audio clip of display width `wPx`. */
export function fadePixels(
  clip: AudioClip,
  tempoMap: TempoPoint[],
  zoomX: number,
  wPx: number,
  fadeInSec?: number,
  fadeOutSec?: number,
): { inPx: number; outPx: number } {
  const s0 = beatsToSeconds(clip.startBeat, tempoMap);
  const fi = Math.max(0, fadeInSec ?? clip.fadeInSec ?? 0);
  const fo = Math.max(0, fadeOutSec ?? clip.fadeOutSec ?? 0);
  const inPx = clamp((secondsToBeats(s0 + fi, tempoMap) - clip.startBeat) * zoomX, 0, wPx);
  const endBeat = clip.startBeat + wPx / Math.max(1e-6, zoomX);
  const endSec = beatsToSeconds(endBeat, tempoMap);
  const outPx = clamp((endBeat - secondsToBeats(Math.max(s0, endSec - fo), tempoMap)) * zoomX, 0, wPx);
  return { inPx, outPx };
}

/** Inverse of fadePixels: handle position (px from the relevant clip edge) → seconds. */
export function fadePxToSec(
  clip: AudioClip,
  tempoMap: TempoPoint[],
  zoomX: number,
  wPx: number,
  px: number,
  which: "in" | "out",
): number {
  const lenBeats = wPx / Math.max(1e-6, zoomX);
  const p = clamp(px, 0, wPx);
  if (which === "in") {
    const s0 = beatsToSeconds(clip.startBeat, tempoMap);
    return Math.max(0, beatsToSeconds(clip.startBeat + p / Math.max(1e-6, zoomX), tempoMap) - s0);
  }
  const endBeat = clip.startBeat + lenBeats;
  const endSec = beatsToSeconds(endBeat, tempoMap);
  return Math.max(0, endSec - beatsToSeconds(endBeat - p / Math.max(1e-6, zoomX), tempoMap));
}

/** Total timeline extent (beats), padded; minimum 256 beats. */
export function contentBeats(project: Project | null): number {
  if (!project) return 256;
  let end = 0;
  for (const t of project.tracks) {
    for (const c of t.clips) {
      const e = clipEndBeat(c, project.tempoMap, project.sampleRate);
      if (e > end) end = e;
    }
  }
  if (project.loop.endBeat > end) end = project.loop.endBeat;
  for (const m of project.markers) if (m.beat > end) end = m.beat;
  return Math.max(256, Math.ceil(end / 16) * 16 + 64);
}

/** Beats-per-pixel-aware px width of one sample at a given position. */
export function samplesPerPx(project: Project, atBeat: number, zoomX: number): number {
  const bpm = bpmAtBeat(atBeat, project.tempoMap);
  const samplesPerBeat = (project.sampleRate * 60) / Math.max(1e-6, bpm);
  return samplesPerBeat / Math.max(1e-6, zoomX);
}

/* ============================================================================
 * Adaptive grid lines (canvas grid + ruler share this)
 * ========================================================================= */

export interface GridLine {
  beat: number;
  /** 0 = bar, 1 = beat (denominator unit), 2 = grid division */
  level: 0 | 1 | 2;
  /** for level 0: the 1-based bar number */
  bar?: number;
  /** for level 0: whether a bar-number label should be drawn at this line */
  label?: boolean;
}

export function gridLines(
  startBeat: number,
  endBeat: number,
  zoomX: number,
  timeSigMap: TimeSigEntry[],
  division: number | null,
): GridLine[] {
  const out: GridLine[] = [];
  if (!(zoomX > 0) || endBeat <= startBeat) return out;
  const s0 = timeSigAtBeat(Math.max(0, startBeat), timeSigMap);
  const pxPerBar = Math.max(0.001, s0.beatsPerBar * zoomX);
  let stride = 1;
  while (pxPerBar * stride < 5 && stride < 65536) stride *= 2;
  let labelStride = stride;
  while (pxPerBar * labelStride < 48 && labelStride < 65536) labelStride *= 2;

  let bar = Math.max(1, beatToBar(Math.max(0, startBeat), timeSigMap) - 1);
  bar = Math.max(1, bar - ((bar - 1) % stride)); // stable stride phase while scrolling
  let guard = 0;
  while (guard++ < 5000) {
    const b = barToBeat(bar, timeSigMap);
    if (b > endBeat) break;
    out.push({ beat: b, level: 0, bar, label: (bar - 1) % labelStride === 0 });
    if (stride === 1) {
      const sig = timeSigAtBeat(b, timeSigMap);
      const unit = 4 / sig.den;
      const barLen = sig.beatsPerBar;
      if (unit * zoomX >= 10) {
        let ig = 0; // defense-in-depth: cap in case unit/barLen are degenerate
        for (let k = unit; k < barLen - 1e-9; k += unit) {
          if (ig++ > 5000) break;
          out.push({ beat: b + k, level: 1 });
        }
      }
      if (division !== null && division > 0 && division * zoomX >= 7 && division < unit - 1e-9) {
        let ig = 0; // defense-in-depth: cap in case division/barLen are degenerate
        for (let k = division; k < barLen - 1e-9; k += division) {
          if (ig++ > 5000) break;
          const onUnit = Math.abs(k / unit - Math.round(k / unit)) < 1e-6;
          if (!onUnit) out.push({ beat: b + k, level: 2 });
        }
      }
    }
    bar += stride;
  }
  return out;
}

/* ============================================================================
 * Automation — paramRef specs, evaluation
 * ========================================================================= */

export interface ParamSpec {
  min: number;
  max: number;
  def: number;
  label: string;
  fmt: (v: number) => string;
}

export type ParsedParamRef =
  | { kind: "volume" }
  | { kind: "pan" }
  | { kind: "send"; index: number }
  | { kind: "plugin"; instanceId: number; paramId: number }
  | { kind: "other" };

export function parseParamRef(ref: string): ParsedParamRef {
  if (ref === "volume") return { kind: "volume" };
  if (ref === "pan") return { kind: "pan" };
  if (ref.startsWith("send:")) {
    const index = Number(ref.slice(5));
    if (Number.isFinite(index)) return { kind: "send", index };
  }
  if (ref.startsWith("plugin:")) {
    const parts = ref.split(":");
    const instanceId = Number(parts[1]);
    const paramId = Number(parts[2]);
    if (Number.isFinite(instanceId) && Number.isFinite(paramId)) {
      return { kind: "plugin", instanceId, paramId };
    }
  }
  return { kind: "other" };
}

export function formatPan(v: number): string {
  const p = Math.round(Math.abs(v) * 100);
  return p === 0 ? "C" : v < 0 ? `L${p}` : `R${p}`;
}

/**
 * Plugin param display names learned from plugin/getParams — keyed "<uid>:<paramId>".
 * Names are a property of the plugin (uid), not the instance: instance ids restart per
 * project, so an instanceId key would collide across project loads.
 */
const paramNameCache = new Map<string, string>();

export function cachePluginParamName(uid: string, paramId: number, name: string): void {
  paramNameCache.set(`${uid}:${paramId}`, name);
}

export function paramSpecFor(paramRef: string, track: Track): ParamSpec {
  const p = parseParamRef(paramRef);
  switch (p.kind) {
    case "volume":
      return { min: 0, max: 2, def: 1, label: "Volume", fmt: gainToDbText };
    case "pan":
      return { min: -1, max: 1, def: 0, label: "Pan", fmt: formatPan };
    case "send": {
      const send = track.sends[p.index];
      return {
        min: 0,
        max: 2,
        def: send ? send.level : 1,
        label: `Send ${p.index + 1}`,
        fmt: gainToDbText,
      };
    }
    case "plugin": {
      const ins = track.inserts.find((i) => i.instanceId === p.instanceId);
      const nm = (ins && paramNameCache.get(`${ins.uid}:${p.paramId}`)) ?? `param ${p.paramId}`;
      return {
        min: 0,
        max: 1,
        def: 0.5,
        label: `${ins ? ins.name : "Plugin"} · ${nm}`,
        fmt: (v) => `${Math.round(v * 100)}%`,
      };
    }
    default:
      return { min: 0, max: 1, def: 0, label: paramRef, fmt: (v) => v.toFixed(2) };
  }
}

/** Current (non-automated) value of a paramRef on a track — the lane's resting line. */
export function laneCurrentValue(track: Track, paramRef: string): number {
  const p = parseParamRef(paramRef);
  switch (p.kind) {
    case "volume":
      return track.volume;
    case "pan":
      return track.pan;
    case "send":
      return track.sends[p.index]?.level ?? 1;
    case "plugin": {
      const ins = track.inserts.find((i) => i.instanceId === p.instanceId);
      const v = ins?.paramValues?.[String(p.paramId)];
      return typeof v === "number" ? v : 0.5;
    }
    default:
      return 0;
  }
}

export function sortedPoints(points: readonly AutomationPoint[]): AutomationPoint[] {
  return [...points].sort((a, b) => a.beat - b.beat);
}

/** Piecewise-linear with curve bend: t' = t^(2^curve) (SPEC §7). */
export function evalAutomation(
  points: readonly AutomationPoint[],
  beat: number,
  fallback: number,
): number {
  if (points.length === 0) return fallback;
  const pts = sortedPoints(points);
  if (beat <= pts[0].beat) return pts[0].value;
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    if (beat <= b.beat) {
      const a = pts[i - 1];
      const span = b.beat - a.beat;
      if (span <= 1e-9) return b.value;
      let t = (beat - a.beat) / span;
      const c = a.curve ?? 0;
      if (c !== 0) t = Math.pow(t, Math.pow(2, c));
      return a.value + (b.value - a.value) * t;
    }
  }
  return pts[pts.length - 1].value;
}

export function automationValueAt(
  track: Track,
  paramRef: string,
  points: readonly AutomationPoint[],
  beat: number,
): number {
  return evalAutomation(points, beat, laneCurrentValue(track, paramRef));
}

/* ============================================================================
 * Tracks — kinds, clip acceptance, folder relations
 * ========================================================================= */

export function trackKindIcon(kind: TrackKind): IconName {
  switch (kind) {
    case "audio":
      return "audioWave";
    case "midi":
      return "midiNote";
    case "instrument":
      return "piano";
    case "folder":
      return "folder";
    case "bus":
      return "mixer";
    case "master":
      return "sliders";
  }
}

export function trackAcceptsClip(track: Track, clipType: "audio" | "midi"): boolean {
  if (clipType === "audio") return track.kind === "audio";
  return track.kind === "midi" || track.kind === "instrument";
}

export function isDescendantOf(project: Project, trackId: number, ancestorId: number): boolean {
  const byId = new Map<number, Track>(project.tracks.map((t) => [t.id, t]));
  let cur = byId.get(trackId);
  let guard = 0;
  while (cur && cur.parentId !== undefined && guard++ < 64) {
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/* ============================================================================
 * Theme colors (canvas needs resolved values; read CSS vars once, cache).
 * The cache is keyed by the active theme (data-theme on <html>), so a theme
 * switch just resolves fresh values — no invalidation ordering to get right.
 * ========================================================================= */

const varCache = new Map<string, string>();

export function themeVar(name: string): string {
  const theme =
    typeof document !== "undefined" ? (document.documentElement.dataset.theme ?? "dark") : "dark";
  const key = `${theme}|${name}`;
  const cached = varCache.get(key);
  if (cached) return cached;
  let v = "";
  if (typeof window !== "undefined") {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  if (!v) v = "#888888";
  varCache.set(key, v);
  return v;
}

export function hexToRgb(color: string): [number, number, number] {
  let h = color.trim();
  if (h.startsWith("rgb")) {
    const m = h.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return [136, 136, 136];
  }
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [136, 136, 136];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function withAlpha(color: string, a: number): string {
  const [r, g, b] = hexToRgb(color);
  return `rgba(${r},${g},${b},${a})`;
}

/** amt > 0 lightens toward white, amt < 0 darkens toward black (-1..1). */
export function shade(color: string, amt: number): string {
  const [r, g, b] = hexToRgb(color);
  const f = (c: number) => (amt >= 0 ? Math.round(c + (255 - c) * amt) : Math.round(c * (1 + amt)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
