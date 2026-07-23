/**
 * Arrangement lane canvas (U1) — grid, loop tint, clips, and ALL clip interactions.
 *
 * Tools from store.tool: select (click / shift-ctrl toggle / marquee, drag-move with snap,
 * alt = duplicate, cross-track same-kind, edge resize, fade-corner drags), draw (drag a new
 * midi clip on midi/instrument tracks), erase (click deletes), split (click splits at the
 * snapped position). Every drag is LOCAL-PREVIEW ONLY and sends ONE command on mouse-up
 * (SPEC §5.8). Dbl-click opens piano roll (midi) / clip editor (audio). Right-click menus
 * for clips and empty space. Drop targets: OS files (uploadFiles), Browser plugins
 * (addPlugin), Browser assets (addAudioClip); plugin/asset drops below the last track
 * create a matching track first. Registers the "timeline" keyboard context.
 *
 * Automation lane rows (expanded via the track header "A" toggle): curve + point handles
 * via clipRender.drawAutomationLane; select-tool dbl-click (or draw-tool click) adds a
 * point, point drag moves it (transient cmd/automation.set stream + commit on release,
 * SPEC §5.8), right-click (or erase-tool click) deletes, alt+vertical-drag bends the
 * segment's start-point curve.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recordingBus, transportBus, useStore } from "../../store/store";
import type { Selection, Tool } from "../../store/store";
import type { RecordingNotesEvent } from "../../protocol/types";
import {
  addAudioClip,
  addMidiClip,
  addPlugin,
  addTrack,
  commitParam,
  deleteClips,
  duplicateClips,
  moveClips,
  resizeClip,
  setAutomation,
  setClip,
  splitClips,
  processAudioClip,
  stretchClip,
  transientParam,
  undo,
  redo,
} from "../../store/actions";
import { copySelection, cutSelection, findClipById, hasClipboard, pasteAt } from "../../lib/clipboard";
import { useAutomationUi } from "./automationUi";
import { registerKeyContext, toggleLoop, zoomToFitPane } from "../../lib/keyboard";
import { openPieMenu, type PieItem } from "../common/PieMenu";
import { computeLensValues, heatHex, type LensId } from "../../lib/xray";
import { lineV, roundRect, useCanvas } from "../../lib/canvas";
import { noteManualScroll } from "../../lib/followSuspend";
import { animateViewport } from "../../lib/viewportAnim";
import {
  beatToPx,
  bpmAtBeat,
  formatBarsBeatsShort,
  gridStepBeats,
  pxToBeat,
  timeSigAtBeat,
  type HViewport,
} from "../../lib/time";
import { hasAssetDrag, hasInsertDrag, hasPluginDrag, readAssetDrag, readPluginDrag, uploadFiles } from "../../lib/dnd";
import { extensionOf, projectOnlyExtensions } from "../Transport/projectFlows";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import { confirmDialog } from "../Dialogs/confirm";
import { showToast } from "../common/ToastHost";
import { ColorPopover, FloatingInput } from "./bits";
import { addTrackMenuItems } from "./TrackHeaders";
import { assignInstrumentToTrack } from "./instrumentAssign";
import {
  drawAutomationLane,
  drawClip,
  drawGrid,
  drawLoopColumn,
  laneValueToY,
  laneYToValue,
  tlColors,
  type LaneOverride,
  type TlColors,
} from "./clipRender";
import {
  EDGE_HIT_PX,
  FADE_HIT_PX,
  MAX_ZOOM_X,
  MIN_ZOOM_X,
  POINT_HIT_PX,
  clamp,
  clipLengthBeats,
  contentBeats,
  fadePixels,
  fadePxToSec,
  laneCurrentValue,
  laneRowOf,
  paramSpecFor,
  rowAtY,
  rowsBottom,
  snapB,
  sortedPoints,
  trackAcceptsClip,
  trackRowOf,
  withAlpha,
  type LaneRowL,
  type Row,
  type TrackRowL,
} from "./layout";
import type { AutomationPoint, Clip, ClipEdge, Project, Track } from "../../protocol/types";

const MIN_CLIP_BEATS = 1 / 16;
const MOVE_THRESHOLD_PX = 3;
/** alt+vertical-drag on a lane segment: curve bend per pixel (full -1..1 ≈ 100px). */
const CURVE_PX_GAIN = 0.02;

/** Right-click toolbox entries (mirror the transport tool buttons + 1-4 keys). */
const TIMELINE_TOOLS: Array<{
  tool: Tool;
  label: string;
  icon: "pointer" | "pencil" | "eraser" | "scissors";
  shortcut: string;
}> = [
  { tool: "select", label: "Select", icon: "pointer", shortcut: "1" },
  { tool: "draw", label: "Draw", icon: "pencil", shortcut: "2" },
  { tool: "erase", label: "Erase", icon: "eraser", shortcut: "3" },
  { tool: "split", label: "Split", icon: "scissors", shortcut: "4" },
];

const fire = (p: Promise<unknown>): void => {
  p.catch((e) => console.warn("[timeline] command failed:", e));
};

function clipById(project: Project, id: number): Clip | null {
  return findClipById(project, id)?.clip ?? null;
}

/**
 * Deleting the LAST point empties the lane and the engine prunes it from
 * track.automation (cmd/automation.set contract) — the user cleared the lane, they
 * didn't ask the row to vanish. Keep it alive as a point-less extra lane first.
 */
function keepEmptiedLaneRow(row: LaneRowL): void {
  if (row.points.length === 1) {
    useAutomationUi.getState().addExtraLane(row.track.id, row.paramRef);
  }
}

/** Nearest lane point within POINT_HIT_PX of (vx, cy) — cy in content space. */
function laneHitPoint(
  row: LaneRowL,
  vx: number,
  cy: number,
  vp: HViewport,
): AutomationPoint | null {
  const spec = paramSpecFor(row.paramRef, row.track);
  let best: AutomationPoint | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of row.points) {
    const dx = Math.abs(vx - beatToPx(p.beat, vp));
    const dy = Math.abs(cy - laneValueToY(p.value, spec, row.top, row.height));
    if (dx <= POINT_HIT_PX && dy <= POINT_HIT_PX && dx + dy < bestD) {
      best = p;
      bestD = dx + dy;
    }
  }
  return best;
}

/** The segment spanning `beat` (needs a point on each side) — a is the curve owner. */
function laneSegmentAt(
  row: LaneRowL,
  beat: number,
): { a: AutomationPoint; b: AutomationPoint } | null {
  const pts = sortedPoints(row.points);
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i].beat <= beat) return i + 1 < pts.length ? { a: pts[i], b: pts[i + 1] } : null;
  }
  return null;
}

/* ============================================================================
 * Drag state (all refs — never React state; local preview only, SPEC §5.8)
 * ========================================================================= */

interface MoveOrigin {
  trackId: number;
  startBeat: number;
  lenBeats: number;
  type: "audio" | "midi";
}

type Drag =
  | {
      kind: "move";
      ids: number[];
      primaryId: number;
      origins: Map<number, MoveOrigin>;
      grabBeat: number;
      minStart: number;
      sourceTrackId: number;
      allowTrack: boolean;
      deltaBeats: number;
      targetTrackId: number | null;
      valid: boolean;
      dup: boolean;
      moved: boolean;
      wasSelected: boolean;
    }
  | {
      kind: "resize";
      clipId: number;
      edge: ClipEdge;
      origStart: number;
      origLen: number;
      start: number;
      len: number;
      /** Left-edge floor: audio can't reveal material before srcOffset 0 (MIDI: 0). */
      minStart: number;
      /** Audio: samples per beat at the clip, for the trim preview's srcOffset. */
      samplesPerBeat: number;
      moved: boolean;
    }
  | { kind: "fade"; clipId: number; which: "in" | "out"; sec: number; origSec: number; moved: boolean }
  | { kind: "draw"; trackId: number; anchor: number; start: number; end: number }
  | { kind: "marquee"; b0: number; y0: number; b1: number; y1: number; base: number[]; additive: boolean }
  | {
      kind: "pan";
      startClientX: number;
      startClientY: number;
      /** viewport scrollX/scrollY at gesture start */
      sx: number;
      sy: number;
    }
  | {
      kind: "lanePoint";
      trackId: number;
      paramRef: string;
      pointId: number;
      beat: number;
      value: number;
      moved: boolean;
    }
  | {
      /** Draw-tool flowing paint over an automation lane: a dense value stream at
       *  qStep granularity, committed as ONE cmd/automation.set (replace-range). */
      kind: "laneDraw";
      trackId: number;
      paramRef: string;
      qStep: number;
      stream: Map<number, number>;
      lo: number;
      hi: number;
      lastBeat: number;
      lastValue: number;
    }
  | {
      kind: "laneCurve";
      trackId: number;
      paramRef: string;
      /** segment start point — owner of the curve value */
      pointId: number;
      /** +1 when dragging up should raise curve (falling segment), -1 when rising */
      sign: 1 | -1;
      startCy: number;
      origCurve: number;
      curve: number;
      moved: boolean;
    };

type Zone = "body" | "l" | "r" | "fadeIn" | "fadeOut";

interface ClipHit {
  row: TrackRowL;
  clip: Clip;
  x0: number;
  x1: number;
  zone: Zone;
}

type OverlayState =
  | { kind: "rename"; clipId: number; x: number; y: number; initial: string }
  | { kind: "color"; ids: number[]; x: number; y: number; current?: string };

interface StateSnap {
  project: Project | null;
  rows: Row[];
  vp: HViewport;
  scrollY: number;
  tool: Tool;
  selection: Selection;
}

/* ============================================================================
 * Component
 * ========================================================================= */

export interface ClipCanvasProps {
  rows: Row[];
  /** X-ray lens (lib/xray) — analytical clip recoloring; "off" = track colors. */
  lens?: LensId;
}

export default function ClipCanvas({ rows, lens = "off" }: ClipCanvasProps) {
  const project = useStore((s) => s.project);
  const viewport = useStore((s) => s.viewport);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const setSelection = useStore((s) => s.setSelection);

  // Lens heat values — memoized per project reference (cheap lookups per draw).
  const lensValues = useMemo(
    () => (lens === "off" || !project ? null : computeLensValues(project, lens)),
    [project, lens],
  );
  const lensRef = useRef<Map<number, number> | null>(null);
  lensRef.current = lensValues;

  const [overlay, setOverlay] = useState<OverlayState | null>(null);

  const vp: HViewport = { zoomX: viewport.zoomX, scrollX: viewport.scrollX };
  const stateRef = useRef<StateSnap>({
    project: null,
    rows: [],
    vp,
    scrollY: 0,
    tool: "select",
    selection: { trackIds: [], clipIds: [], noteIds: [] },
  });
  stateRef.current = { project, rows, vp, scrollY: viewport.scrollY, tool, selection };

  const dragRef = useRef<Drag | null>(null);
  const hoverRef = useRef<{ clipId: number; zone: Zone } | null>(null);

  /* Drag HUD (UI_IMPROVE.md §2.1/2.2) — floating readout near the cursor during clip
     gestures: position + "copy"/"snap off" modifier hints. Imperative DOM writes only
     (drags are rAF-drawn, never React state); shared .drag-hud style (theme.css). */
  const hudElRef = useRef<HTMLDivElement | null>(null);
  const hudOnRef = useRef(false);
  const hideDragHud = (): void => {
    if (hudOnRef.current && hudElRef.current) {
      hudElRef.current.style.display = "none";
      hudOnRef.current = false;
    }
  };
  const showDragHud = (clientX: number, clientY: number, text: string): void => {
    const el = hudElRef.current;
    if (!el) return;
    el.textContent = text;
    el.style.display = "block";
    el.style.left = `${clientX + 14}px`;
    el.style.top = `${clientY - 18}px`;
    hudOnRef.current = true;
  };
  /** Trim trailing zeros: 1.50 → "1.5", 2.00 → "2". */
  const trimNum = (n: number): string => n.toFixed(2).replace(/\.?0+$/, "") || "0";
  const laneHoverRef = useRef<{ trackId: number; paramRef: string; pointId: number } | null>(null);
  const marqueeIdsRef = useRef<number[]>([]);
  // Right-button drag pans the grid; a bare right-click still opens the context menu.
  const panRightRef = useRef(false);
  const suppressCtxRef = useRef(false);
  const dropHintRef = useRef<{ vx: number } | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  // Live recording feedback: latest in-progress take + a stamped transport sample so the
  // take rectangle's right edge can be interpolated smoothly between 20 Hz transport events.
  const recRef = useRef<RecordingNotesEvent | null>(null);
  const recClockRef = useRef<{ beat: number; at: number; playing: boolean } | null>(null);

  const drawRef = useRef<() => void>(() => undefined);
  const { ref, canvasRef, ctxRef } = useCanvas((_ctx, sz) => {
    sizeRef.current = { width: sz.width, height: sz.height };
    drawRef.current();
  });

  /* ------------------------------------------------------- redraw scheduling */

  const rafRef = useRef(0);
  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawRef.current();
    });
  }, []);
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // While recording, keep a continuous rAF running so the growing take rectangle + live
  // notes animate; grab the take start from the first recording-state transport event and
  // clear the preview when recording stops. (event/recordingNotes fills recRef in between.)
  useEffect(() => {
    let raf = 0;
    let recording = false;
    const loop = (): void => {
      drawRef.current();
      raf = requestAnimationFrame(loop);
    };
    const unsubRec = recordingBus.subscribe((ev) => {
      recRef.current = ev;
    });
    const unsubT = transportBus.subscribe((ev) => {
      recClockRef.current = {
        beat: ev.beat,
        at: performance.now(),
        playing: ev.state !== "stopped",
      };
      const isRec = ev.state === "recording";
      if (isRec && !recording) {
        recording = true;
        if (!raf) raf = requestAnimationFrame(loop);
      } else if (!isRec && recording) {
        recording = false;
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        recRef.current = null;
        drawRef.current(); // one final draw clears the preview
      }
    });
    return () => {
      unsubRec();
      unsubT();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* ------------------------------------------------------------------- draw */

  const computeMarquee = (d: Extract<Drag, { kind: "marquee" }>): Set<number> => {
    const { project: proj, rows: rws } = stateRef.current;
    const out = new Set<number>(d.base);
    if (!proj) return out;
    const bmin = Math.min(d.b0, d.b1);
    const bmax = Math.max(d.b0, d.b1);
    const ymin = Math.min(d.y0, d.y1);
    const ymax = Math.max(d.y0, d.y1);
    for (const row of rws) {
      if (row.kind !== "track") continue;
      if (row.top > ymax || row.top + row.height < ymin) continue;
      for (const clip of row.track.clips) {
        const len = clipLengthBeats(clip, proj.tempoMap, proj.sampleRate);
        if (clip.startBeat <= bmax && clip.startBeat + len >= bmin) out.add(clip.id);
      }
    }
    return out;
  };

  const drawFrozenBadge = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    colors: TlColors,
  ): void => {
    if (w < 30 || h < 20) return;
    const bx = x + Math.max(2, w) - 16;
    const by = y + 3;
    if (bx < -14 || bx > sizeRef.current.width) return;
    ctx.save();
    ctx.fillStyle = "rgba(10,11,14,0.65)";
    roundRect(ctx, bx, by, 12, 12, 3);
    ctx.fill();
    ctx.strokeStyle = colors.textDim;
    ctx.lineWidth = 1;
    const cx = bx + 6;
    const cy = by + 6;
    const r = 3.6;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      ctx.moveTo(cx - Math.cos(a) * r, cy - Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.stroke();
    ctx.restore();
  };

  const draw = (): void => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { width: w, height: h } = sizeRef.current;
    if (w <= 0 || h <= 0) return;
    const { project: proj, rows: rws, vp: v, scrollY, tool: tl, selection: sel } = stateRef.current;
    const colors = tlColors();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    if (!proj) return;

    const d = dragRef.current;
    let marqueeSel: Set<number> | null = null;
    if (d && d.kind === "marquee") {
      marqueeSel = computeMarquee(d);
      marqueeIdsRef.current = [...marqueeSel];
    }
    const selSet = new Set(sel.clipIds);
    const selTracks = new Set(sel.trackIds);
    const hideOriginals =
      d && d.kind === "move" && d.moved && !d.dup ? new Set(d.ids) : null;

    // row tints (under grid)
    for (const row of rws) {
      if (row.kind !== "track") continue;
      const ry = row.top - scrollY;
      if (ry > h || ry + row.height < 0) continue;
      if (selTracks.has(row.track.id)) {
        ctx.fillStyle = withAlpha(colors.accent, 0.05);
        ctx.fillRect(0, ry, w, row.height);
      } else if (row.track.kind === "folder") {
        ctx.fillStyle = withAlpha(colors.border, 0.18);
        ctx.fillRect(0, ry, w, row.height);
      }
    }

    drawGrid(ctx, w, h, v, proj.timeSigMap, proj.grid.division > 0 ? proj.grid.division : null, colors);
    drawLoopColumn(ctx, proj.loop, v, w, h, colors);

    // rows: separators + clips (virtualized: only visible rows / clips draw)
    for (const row of rws) {
      const ry = row.top - scrollY;
      if (ry > h || ry + row.height < 0) continue;
      if (row.kind === "lane") {
        let override: LaneOverride | null = null;
        if (d && d.kind === "lanePoint" && d.moved && d.trackId === row.track.id && d.paramRef === row.paramRef) {
          override = { movePointId: d.pointId, moveBeat: d.beat, moveValue: d.value };
        } else if (d && d.kind === "laneCurve" && d.trackId === row.track.id && d.paramRef === row.paramRef) {
          override = { curvePointId: d.pointId, curveValue: d.curve };
        }
        const lh = laneHoverRef.current;
        drawAutomationLane(ctx, {
          row,
          y: ry,
          w,
          vp: v,
          color: row.track.color,
          colors,
          spec: paramSpecFor(row.paramRef, row.track),
          current: laneCurrentValue(row.track, row.paramRef),
          override,
          hoverPointId:
            lh && lh.trackId === row.track.id && lh.paramRef === row.paramRef ? lh.pointId : null,
        });
        // flowing-paint preview: the in-progress stream as an accent polyline
        if (
          d &&
          d.kind === "laneDraw" &&
          d.trackId === row.track.id &&
          d.paramRef === row.paramRef &&
          d.stream.size > 1
        ) {
          const spec = paramSpecFor(row.paramRef, row.track);
          const pts = [...d.stream.entries()].sort((a, b) => a[0] - b[0]);
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          pts.forEach(([k, val], i) => {
            const x = beatToPx(k * d.qStep, v);
            const py = laneValueToY(val, spec, ry, row.height);
            if (i === 0) ctx.moveTo(x, py);
            else ctx.lineTo(x, py);
          });
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        continue;
      }
      const track = row.track;
      ctx.strokeStyle = withAlpha(colors.border, 0.8);
      ctx.beginPath();
      ctx.moveTo(0, ry + row.height - 0.5);
      ctx.lineTo(w, ry + row.height - 0.5);
      ctx.stroke();

      for (const clip of track.clips) {
        if (hideOriginals?.has(clip.id)) continue;
        let startBeat = clip.startBeat;
        let lenBeats = clipLengthBeats(clip, proj.tempoMap, proj.sampleRate);
        let fadeInSec: number | undefined;
        let fadeOutSec: number | undefined;
        let srcOffsetOverride: number | undefined;
        if (d && d.kind === "resize" && d.clipId === clip.id && d.moved) {
          startBeat = d.start;
          lenBeats = d.len;
          // Left-edge trim preview: the waveform stays anchored on the timeline —
          // sample the peaks from the offset the commit will produce, not the old one.
          if (d.edge === "l" && clip.type === "audio")
            srcOffsetOverride = Math.max(
              0,
              clip.srcOffsetSamples + (d.start - clip.startBeat) * d.samplesPerBeat,
            );
        }
        if (d && d.kind === "fade" && d.clipId === clip.id) {
          if (d.which === "in") fadeInSec = d.sec;
          else fadeOutSec = d.sec;
        }
        const x = beatToPx(startBeat, v);
        const cw = lenBeats * v.zoomX;
        if (x + cw < -2 || x > w + 2) continue;
        const selected = selSet.has(clip.id) || (marqueeSel?.has(clip.id) ?? false);
        const hovered = hoverRef.current?.clipId === clip.id;
        drawClip(ctx, {
          clip,
          x,
          y: ry,
          w: cw,
          h: row.height,
          canvasW: w,
          // X-ray lens: heat color from content; no-data clips (audio, empty
          // MIDI under register/energy) go honest-neutral instead of faking it
          color: lensRef.current
            ? lensRef.current.has(clip.id)
              ? heatHex(lensRef.current.get(clip.id)!)
              : colors.textFaint
            : (clip.color ?? track.color),
          selected,
          fadeInSec,
          fadeOutSec,
          srcOffsetSamples: srcOffsetOverride,
          showFadeHandles: clip.type === "audio" && tl === "select" && (selected || hovered),
          project: proj,
          zoomX: v.zoomX,
          colors,
          onPeaksArrive: schedule,
        });
        if (track.frozen) drawFrozenBadge(ctx, x, ry, cw, row.height, colors);
      }
    }

    // live recording take: growing rectangle + notes on each armed track (event-driven)
    const rec = recRef.current;
    if (rec && rec.trackIds.length > 0) {
      // Right edge = interpolated playhead (smooth), never shorter than the last snapshot.
      const clk = recClockRef.current;
      let liveBeat = rec.startBeat + rec.lengthBeats;
      if (clk) {
        let b = clk.beat;
        if (clk.playing) {
          const dt = Math.min(0.25, (performance.now() - clk.at) / 1000);
          b += dt * (bpmAtBeat(b, proj.tempoMap) / 60);
        }
        liveBeat = Math.max(liveBeat, b);
      }
      const x0 = beatToPx(rec.startBeat, v);
      const x1 = beatToPx(liveBeat, v);
      const rw = Math.max(2, x1 - x0);
      if (x1 >= -2 && x0 <= w + 2) {
        let pmin = 127;
        let pmax = 0;
        for (const nt of rec.notes) {
          if (nt.pitch < pmin) pmin = nt.pitch;
          if (nt.pitch > pmax) pmax = nt.pitch;
        }
        if (pmin > pmax) {
          pmin = 58;
          pmax = 70;
        } // no notes yet — a sane centred band
        pmin = Math.max(0, pmin - 2);
        pmax = Math.min(127, pmax + 2);
        const range = Math.max(1, pmax - pmin);
        for (const tid of rec.trackIds) {
          const row = trackRowOf(rws, tid);
          if (!row) continue;
          const ry = row.top - scrollY;
          if (ry > h || ry + row.height < 0) continue;
          roundRect(ctx, x0, ry + 1, rw, row.height - 3, 3);
          ctx.fillStyle = withAlpha(colors.danger, 0.14);
          ctx.fill();
          ctx.strokeStyle = colors.danger;
          ctx.lineWidth = 1;
          ctx.stroke();
          const areaY = ry + 2;
          const areaH = row.height - 4;
          const rowH = Math.min(4, Math.max(1.5, areaH / (range + 1)));
          ctx.save();
          ctx.beginPath();
          ctx.rect(Math.max(x0, 0), areaY, Math.min(rw, w - Math.max(x0, 0)), areaH);
          ctx.clip();
          ctx.fillStyle = withAlpha(colors.danger, 0.95);
          for (const nt of rec.notes) {
            const nx = x0 + nt.startBeat * v.zoomX;
            const nw = Math.max(1.5, nt.lengthBeats * v.zoomX - 0.5);
            const t = (nt.pitch - pmin) / (range + 1);
            const ny = areaY + (areaH - rowH) * (1 - t);
            ctx.fillRect(nx, ny, nw, rowH);
          }
          ctx.restore();
        }
      }
    }

    // move ghosts
    if (d && d.kind === "move" && d.moved) {
      for (const id of d.ids) {
        const o = d.origins.get(id);
        if (!o) continue;
        const tgtId = d.allowTrack && d.targetTrackId !== null ? d.targetTrackId : o.trackId;
        const row = trackRowOf(rws, tgtId) ?? trackRowOf(rws, o.trackId);
        const clip = clipById(proj, id);
        if (!row || !clip) continue;
        drawClip(ctx, {
          clip,
          x: beatToPx(o.startBeat + d.deltaBeats, v),
          y: row.top - scrollY,
          w: o.lenBeats * v.zoomX,
          h: row.height,
          canvasW: w,
          color: clip.color ?? row.track.color,
          selected: true,
          ghost: 0.7,
          invalid: d.targetTrackId !== null && !d.valid,
          project: proj,
          zoomX: v.zoomX,
          colors,
          onPeaksArrive: schedule,
        });
      }
    }

    // draw-tool preview
    if (d && d.kind === "draw") {
      const row = trackRowOf(rws, d.trackId);
      if (row) {
        const x0 = beatToPx(d.start, v);
        const x1 = beatToPx(Math.max(d.end, d.start + 0.05), v);
        roundRect(ctx, x0, row.top - scrollY + 1, Math.max(2, x1 - x0), row.height - 3, 3);
        ctx.fillStyle = withAlpha(colors.accent, 0.18);
        ctx.fill();
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // marquee rectangle
    if (d && d.kind === "marquee") {
      const x0 = beatToPx(Math.min(d.b0, d.b1), v);
      const x1 = beatToPx(Math.max(d.b0, d.b1), v);
      const y0 = Math.min(d.y0, d.y1) - scrollY;
      const y1 = Math.max(d.y0, d.y1) - scrollY;
      ctx.fillStyle = withAlpha(colors.accent, 0.1);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = withAlpha(colors.accent, 0.8);
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    }

    // drop position hint
    if (dropHintRef.current) {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1;
      lineV(ctx, dropHintRef.current.vx, 0, h);
    }
  };
  drawRef.current = draw;

  useEffect(() => {
    draw();
  });

  /* -------------------------------------------------------------- hit tests */

  const localPoint = (clientX: number, clientY: number): { vx: number; cy: number } => {
    const el = canvasRef.current;
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
    return { vx: clientX - r.left, cy: clientY - r.top + stateRef.current.scrollY };
  };

  const hitTest = (vx: number, cy: number): ClipHit | null => {
    const { project: proj, rows: rws, vp: v, tool: tl, selection: sel } = stateRef.current;
    if (!proj) return null;
    const row = rowAtY(rws, cy);
    if (!row || row.kind !== "track") return null;
    const yIn = cy - row.top;
    const clips = row.track.clips;
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i];
      const lenBeats = clipLengthBeats(clip, proj.tempoMap, proj.sampleRate);
      const x0 = beatToPx(clip.startBeat, v);
      const x1 = x0 + lenBeats * v.zoomX;
      // fade-corner handles (audio, select tool, selected/hovered, top strip)
      if (
        clip.type === "audio" &&
        tl === "select" &&
        yIn <= 16 &&
        x1 - x0 >= 24 &&
        row.height >= 18 &&
        (sel.clipIds.includes(clip.id) || hoverRef.current?.clipId === clip.id)
      ) {
        const { inPx, outPx } = fadePixels(clip, proj.tempoMap, v.zoomX, x1 - x0);
        if (Math.abs(vx - (x0 + inPx)) <= FADE_HIT_PX) return { row, clip, x0, x1, zone: "fadeIn" };
        if (Math.abs(vx - (x1 - outPx)) <= FADE_HIT_PX) return { row, clip, x0, x1, zone: "fadeOut" };
      }
      if (vx < x0 - EDGE_HIT_PX || vx > x1 + EDGE_HIT_PX) continue;
      const wide = x1 - x0 > EDGE_HIT_PX * 2 + 4;
      if (wide && Math.abs(vx - x0) <= EDGE_HIT_PX) return { row, clip, x0, x1, zone: "l" };
      if (wide && Math.abs(vx - x1) <= EDGE_HIT_PX) return { row, clip, x0, x1, zone: "r" };
      if (vx >= x0 && vx <= x1) return { row, clip, x0, x1, zone: "body" };
    }
    return null;
  };

  const updateHover = (vx: number, cy: number): void => {
    const st = stateRef.current;
    const tl = st.tool;
    let cursor = "default";
    if (tl === "draw" || tl === "split") cursor = "crosshair";
    else if (tl === "erase") cursor = "pointer";
    let hov: { clipId: number; zone: Zone } | null = null;
    let laneHov: { trackId: number; paramRef: string; pointId: number } | null = null;
    const row = rowAtY(st.rows, cy);
    if (row && row.kind === "lane") {
      const pt = laneHitPoint(row, vx, cy, st.vp);
      if (pt) {
        laneHov = { trackId: row.track.id, paramRef: row.paramRef, pointId: pt.id };
        if (tl !== "erase") cursor = "pointer";
      } else if (tl === "split") {
        cursor = "default"; // split tool is inert on lanes
      }
    } else {
      const hit = hitTest(vx, cy);
      if (hit) {
        hov = { clipId: hit.clip.id, zone: hit.zone };
        if (tl === "select" && hit.zone !== "body") cursor = "ew-resize";
      } else if (tl === "select") {
        cursor = "default"; // empty space — left-drag rubber-band selects; right-drag pans
      }
    }
    const el = canvasRef.current;
    if (el && el.style.cursor !== cursor) el.style.cursor = cursor;
    const lh = laneHoverRef.current;
    const changed =
      (hoverRef.current?.clipId ?? -1) !== (hov?.clipId ?? -1) ||
      (lh?.pointId ?? -1) !== (laneHov?.pointId ?? -1) ||
      (lh?.trackId ?? -1) !== (laneHov?.trackId ?? -1) ||
      (lh?.paramRef ?? "") !== (laneHov?.paramRef ?? "");
    hoverRef.current = hov;
    laneHoverRef.current = laneHov;
    if (changed) draw();
  };

  /* ------------------------------------------------------------- selection */

  const selectClips = (clipIds: number[], trackIds?: number[]): void => {
    setSelection({ clipIds, noteIds: [], ...(trackIds !== undefined ? { trackIds } : {}) });
  };

  /* ------------------------------------------------------- midi clip create */

  /**
   * Create a one-bar MIDI clip at `rawBeat` (floored to the grid) on `track`, select
   * it, and optionally open it in the piano roll. Backs the empty-area context menu
   * ("Create MIDI Clip") and select-tool double-click on an empty midi/instrument lane.
   */
  const createMidiClipAt = (track: Track, rawBeat: number, openEditor: boolean): void => {
    const proj = stateRef.current.project;
    if (!proj) return;
    const start = snapB(Math.max(0, rawBeat), proj.grid, false, "floor");
    const bar = timeSigAtBeat(start, proj.timeSigMap).beatsPerBar;
    addMidiClip(track.id, start, bar)
      .then((r) => {
        const s = useStore.getState();
        s.setSelection({ clipIds: [r.clip.id], trackIds: [track.id], noteIds: [] });
        if (openEditor) {
          s.setActiveMidiClipId(r.clip.id);
          s.setPanels({ bottomTab: "pianoRoll" });
          s.setFocusedPane("pianoRoll");
        }
      })
      .catch((err) => console.warn("[timeline] create midi clip failed:", err));
  };

  /* Pie menu (stationary middle-click): tools on the top arc, whole-view actions
     on the bottom — the gestural fast path for the hands-on-mouse workflow. */
  const timelinePieItems = (): PieItem[] => {
    const s = useStore.getState();
    const setTool = (t: Tool) => () => useStore.getState().setTool(t);
    return [
      { icon: "pointer", label: "Select tool (1)", active: s.tool === "select", onClick: setTool("select") },
      { icon: "pencil", label: "Draw tool (2)", active: s.tool === "draw", onClick: setTool("draw") },
      { icon: "eraser", label: "Erase tool (3)", active: s.tool === "erase", onClick: setTool("erase") },
      { icon: "split", label: "Split tool (4)", active: s.tool === "split", onClick: setTool("split") },
      { icon: "zoomIn", label: "Fit view (F)", onClick: () => zoomToFitPane("timeline") },
      { icon: "redo", label: "Redo (Ctrl+Y)", onClick: () => void redo().catch(() => {}) },
      { icon: "undo", label: "Undo (Ctrl+Z)", onClick: () => void undo().catch(() => {}) },
      { icon: "loop", label: "Loop on/off (L)", onClick: () => toggleLoop() },
    ];
  };

  /* ---------------------------------------------------------- pointer down */

  const startPan = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const st = stateRef.current;
    dragRef.current = {
      kind: "pan",
      startClientX: e.clientX,
      startClientY: e.clientY,
      sx: st.vp.scrollX,
      sy: st.scrollY,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.style.cursor = "grabbing";
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    // middle-button pan — both axes, any tool (mirrors the PianoRoll middle-drag pan)
    if (e.button === 1) {
      e.preventDefault();
      panRightRef.current = false;
      startPan(e);
      return;
    }
    // right-button drag pans the grid ("hand"); a bare right-click (no drag) still opens the
    // context menu — movement past the click threshold suppresses it (onPointerMove/onContextMenu).
    if (e.button === 2) {
      panRightRef.current = true;
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    const st = stateRef.current;
    const proj = st.project;
    if (!proj) return;
    const { vx, cy } = localPoint(e.clientX, e.clientY);
    const rawBeat = pxToBeat(vx, st.vp);
    const grid = proj.grid;
    const hit = hitTest(vx, cy);
    const row = rowAtY(st.rows, cy);
    const track = row && row.kind === "track" ? row.track : null;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const capture = () => e.currentTarget.setPointerCapture(e.pointerId);

    // automation lane rows — point move / erase / curve bend / draw-tool add
    if (row && row.kind === "lane") {
      const pt = laneHitPoint(row, vx, cy, st.vp);
      if (pt) {
        if (st.tool === "erase") {
          keepEmptiedLaneRow(row);
          fire(setAutomation(row.track.id, row.paramRef, { remove: [pt.id] }));
          return;
        }
        dragRef.current = {
          kind: "lanePoint",
          trackId: row.track.id,
          paramRef: row.paramRef,
          pointId: pt.id,
          beat: pt.beat,
          value: pt.value,
          moved: false,
        };
        capture();
        return;
      }
      if (e.altKey) {
        const seg = laneSegmentAt(row, rawBeat);
        if (seg) {
          dragRef.current = {
            kind: "laneCurve",
            trackId: row.track.id,
            paramRef: row.paramRef,
            pointId: seg.a.id,
            sign: seg.b.value >= seg.a.value ? -1 : 1,
            startCy: cy,
            origCurve: seg.a.curve ?? 0,
            curve: seg.a.curve ?? 0,
            moved: false,
          };
          capture();
        }
        return;
      }
      if (st.tool === "draw") {
        // Flowing paint: collect a dense stream while dragging; a plain click (no
        // movement) falls back to adding ONE snapped point on release.
        const spec = paramSpecFor(row.paramRef, row.track);
        const gs = grid.snap && grid.division > 0 ? gridStepBeats(grid) : 1;
        const qStep = Math.max(gs / 8, 1 / 32);
        const beat = Math.max(0, rawBeat);
        const value = laneYToValue(cy, spec, row.top, row.height);
        const k = Math.round(beat / qStep);
        dragRef.current = {
          kind: "laneDraw",
          trackId: row.track.id,
          paramRef: row.paramRef,
          qStep,
          stream: new Map([[k, value]]),
          lo: k * qStep,
          hi: k * qStep,
          lastBeat: beat,
          lastValue: value,
        };
        capture();
      }
      return;
    }

    if (st.tool === "split") {
      if (hit) {
        const start = hit.clip.startBeat;
        const end = start + clipLengthBeats(hit.clip, proj.tempoMap, proj.sampleRate);
        const at = snapB(rawBeat, grid, e.shiftKey);
        if (at > start + 1e-9 && at < end - 1e-9) fire(splitClips([hit.clip.id], at));
      }
      return;
    }

    if (st.tool === "erase") {
      if (hit) fire(deleteClips([hit.clip.id]));
      return;
    }

    if (st.tool === "draw" && !hit) {
      if (track && trackAcceptsClip(track, "midi")) {
        const a = snapB(rawBeat, grid, e.shiftKey, "floor");
        dragRef.current = { kind: "draw", trackId: track.id, anchor: a, start: a, end: a };
        capture();
        draw();
      }
      return;
    }

    if (hit) {
      const clip = hit.clip;

      if (st.tool === "select" && (hit.zone === "fadeIn" || hit.zone === "fadeOut") && clip.type === "audio") {
        const which = hit.zone === "fadeIn" ? "in" : "out";
        const sec = which === "in" ? clip.fadeInSec : clip.fadeOutSec;
        dragRef.current = { kind: "fade", clipId: clip.id, which, sec, origSec: sec, moved: false };
        capture();
        return;
      }

      if (hit.zone === "l" || hit.zone === "r") {
        const len = clipLengthBeats(clip, proj.tempoMap, proj.sampleRate);
        // Cubase-style left trim: the content stays anchored on the timeline, so the
        // edge can only travel left while there is source material before the clip.
        const spb =
          (proj.sampleRate * 60) / Math.max(1e-6, bpmAtBeat(clip.startBeat, proj.tempoMap));
        const minStart =
          clip.type === "audio"
            ? Math.max(0, clip.startBeat - clip.srcOffsetSamples / spb)
            : 0;
        dragRef.current = {
          kind: "resize",
          clipId: clip.id,
          edge: hit.zone,
          origStart: clip.startBeat,
          origLen: len,
          start: clip.startBeat,
          len,
          minStart,
          samplesPerBeat: spb,
          moved: false,
        };
        capture();
        return;
      }

      // body — selection + potential move
      if (additive) {
        const ids = st.selection.clipIds.includes(clip.id)
          ? st.selection.clipIds.filter((i) => i !== clip.id)
          : [...st.selection.clipIds, clip.id];
        selectClips(ids);
        return;
      }
      const wasSelected = st.selection.clipIds.includes(clip.id);
      const ids = wasSelected ? st.selection.clipIds : [clip.id];
      if (!wasSelected) selectClips(ids, [hit.row.track.id]);

      const origins = new Map<number, MoveOrigin>();
      let minStart = Number.POSITIVE_INFINITY;
      let sameTrack = true;
      let firstTrack = -1;
      for (const id of ids) {
        const found = findClipById(proj, id);
        if (!found) continue;
        origins.set(id, {
          trackId: found.track.id,
          startBeat: found.clip.startBeat,
          lenBeats: clipLengthBeats(found.clip, proj.tempoMap, proj.sampleRate),
          type: found.clip.type,
        });
        if (found.clip.startBeat < minStart) minStart = found.clip.startBeat;
        if (firstTrack < 0) firstTrack = found.track.id;
        else if (found.track.id !== firstTrack) sameTrack = false;
      }
      dragRef.current = {
        kind: "move",
        ids: [...origins.keys()],
        primaryId: clip.id,
        origins,
        grabBeat: rawBeat,
        minStart: Number.isFinite(minStart) ? minStart : 0,
        sourceTrackId: hit.row.track.id,
        allowTrack: sameTrack,
        deltaBeats: 0,
        targetTrackId: null,
        valid: true,
        dup: e.altKey,
        moved: false,
        wasSelected,
      };
      capture();
      return;
    }

    // empty area — left-drag rubber-band selects (plain replaces the selection; Shift/Ctrl
    // adds to it). Panning the grid is a right-button drag now (see onPointerDown). A plain
    // left-click with no drag collapses to an empty marquee, which clears the selection.
    const base = additive ? [...st.selection.clipIds] : [];
    if (!additive) selectClips([]);
    marqueeIdsRef.current = base;
    dragRef.current = { kind: "marquee", b0: rawBeat, y0: cy, b1: rawBeat, y1: cy, base, additive };
    capture();
    draw();
  };

  /* ---------------------------------------------------------- pointer move */

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    const { vx, cy } = localPoint(e.clientX, e.clientY);
    if (!d) {
      hideDragHud();
      updateHover(vx, cy);
      return;
    }
    const st = stateRef.current;
    const proj = st.project;
    if (!proj) return;
    const rawBeat = pxToBeat(vx, st.vp);
    const grid = proj.grid;

    switch (d.kind) {
      case "move": {
        const o = d.origins.get(d.primaryId);
        if (!o) return;
        const snapped = snapB(o.startBeat + (rawBeat - d.grabBeat), grid, e.shiftKey);
        d.deltaBeats = Math.max(snapped - o.startBeat, -d.minStart);
        d.dup = e.altKey;
        const row = rowAtY(st.rows, cy);
        if (d.allowTrack && row && row.kind === "track" && row.track.id !== d.sourceTrackId) {
          d.targetTrackId = row.track.id;
          const tgt = row.track;
          d.valid = [...d.origins.values()].every((or) => trackAcceptsClip(tgt, or.type));
        } else {
          d.targetTrackId = null;
          d.valid = true;
        }
        if (
          !d.moved &&
          (Math.abs((rawBeat - d.grabBeat) * st.vp.zoomX) > MOVE_THRESHOLD_PX || d.targetTrackId !== null)
        ) {
          d.moved = true;
        }
        if (d.moved && o) {
          const pos = formatBarsBeatsShort(o.startBeat + d.deltaBeats, proj.timeSigMap);
          showDragHud(
            e.clientX,
            e.clientY,
            pos +
              (d.dup ? " · copy" : "") +
              (e.shiftKey ? " · snap off" : "") +
              (d.targetTrackId !== null && !d.valid ? " · incompatible track" : ""),
          );
        }
        draw();
        return;
      }
      case "resize": {
        d.moved = true;
        if (d.edge === "l") {
          const ns = clamp(
            snapB(rawBeat, grid, e.shiftKey),
            d.minStart,
            d.origStart + d.origLen - MIN_CLIP_BEATS,
          );
          d.start = ns;
          d.len = d.origStart + d.origLen - ns;
        } else {
          const ne = Math.max(snapB(rawBeat, grid, e.shiftKey), d.origStart + MIN_CLIP_BEATS);
          d.start = d.origStart;
          d.len = ne - d.origStart;
        }
        showDragHud(
          e.clientX,
          e.clientY,
          (d.edge === "l"
            ? `from ${formatBarsBeatsShort(d.start, proj.timeSigMap)}`
            : `to ${formatBarsBeatsShort(d.start + d.len, proj.timeSigMap)}`) +
            ` · ${trimNum(d.len)}b` +
            (e.shiftKey ? " · snap off" : ""),
        );
        draw();
        return;
      }
      case "fade": {
        d.moved = true;
        const found = findClipById(proj, d.clipId);
        if (!found || found.clip.type !== "audio") return;
        const clip = found.clip;
        const wPx = clipLengthBeats(clip, proj.tempoMap, proj.sampleRate) * st.vp.zoomX;
        const x0 = beatToPx(clip.startBeat, st.vp);
        const px = d.which === "in" ? vx - x0 : x0 + wPx - vx;
        d.sec = fadePxToSec(clip, proj.tempoMap, st.vp.zoomX, wPx, px, d.which);
        showDragHud(e.clientX, e.clientY, `fade ${d.which} ${d.sec.toFixed(2)} s`);
        draw();
        return;
      }
      case "draw": {
        const b = snapB(rawBeat, grid, e.shiftKey);
        d.start = Math.min(d.anchor, b);
        d.end = Math.max(d.anchor, b);
        showDragHud(
          e.clientX,
          e.clientY,
          `${formatBarsBeatsShort(d.start, proj.timeSigMap)} → ${formatBarsBeatsShort(d.end, proj.timeSigMap)} · ${trimNum(d.end - d.start)}b`,
        );
        draw();
        return;
      }
      case "marquee": {
        d.b1 = rawBeat;
        d.y1 = cy;
        draw();
        return;
      }
      case "pan": {
        // a right-button pan that actually moves suppresses the context menu that would
        // otherwise fire on release (a stationary right-click keeps its menu)
        if (
          panRightRef.current &&
          Math.abs(e.clientX - d.startClientX) + Math.abs(e.clientY - d.startClientY) > 4
        ) {
          suppressCtxRef.current = true;
        }
        // every pointermove refreshes the follow-playhead suspension, so "J" follow
        // stands down for the whole gesture (even when clamped at a content edge)
        // and re-engages ~1 s after release
        noteManualScroll();
        // clamp with content extents — mirrors Timeline's contentW/contentH clamp math
        const { width: w, height: h } = sizeRef.current;
        const maxX = Math.max(0, contentBeats(proj) * st.vp.zoomX - w);
        const maxY = Math.max(0, rowsBottom(st.rows) + 96 - h); // +96 = Timeline contentH pad
        const scrollX = clamp(d.sx - (e.clientX - d.startClientX), 0, maxX);
        const scrollY = clamp(d.sy - (e.clientY - d.startClientY), 0, maxY);
        const s = useStore.getState();
        if (scrollX !== s.viewport.scrollX || scrollY !== s.viewport.scrollY) {
          s.setViewport({ scrollX, scrollY });
        }
        return;
      }
      case "lanePoint": {
        d.moved = true;
        const row = laneRowOf(st.rows, d.trackId, d.paramRef);
        if (!row) return;
        const spec = paramSpecFor(d.paramRef, row.track);
        d.beat = snapB(rawBeat, grid, e.shiftKey);
        d.value = laneYToValue(cy, spec, row.top, row.height);
        transientParam("cmd/automation.set", {
          trackId: d.trackId,
          paramRef: d.paramRef,
          update: [{ pointId: d.pointId, patch: { beat: d.beat, value: d.value } }],
        });
        draw();
        return;
      }
      case "laneCurve": {
        d.moved = true;
        d.curve = clamp(d.origCurve + d.sign * (d.startCy - cy) * CURVE_PX_GAIN, -1, 1);
        transientParam("cmd/automation.set", {
          trackId: d.trackId,
          paramRef: d.paramRef,
          update: [{ pointId: d.pointId, patch: { curve: d.curve } }],
        });
        draw();
        return;
      }
      case "laneDraw": {
        const row = laneRowOf(st.rows, d.trackId, d.paramRef);
        if (!row) return;
        const spec = paramSpecFor(d.paramRef, row.track);
        const beat = Math.max(0, rawBeat);
        const value = laneYToValue(cy, spec, row.top, row.height);
        const k0 = Math.round(d.lastBeat / d.qStep);
        const k1 = Math.round(beat / d.qStep);
        if (k0 === k1) {
          d.stream.set(k1, value);
        } else {
          const dir = k1 > k0 ? 1 : -1;
          for (let k = k0; k !== k1 + dir; k += dir) {
            const f = (k - k0) / (k1 - k0);
            d.stream.set(k, d.lastValue + (value - d.lastValue) * f);
          }
        }
        d.lo = Math.min(d.lo, k1 * d.qStep);
        d.hi = Math.max(d.hi, k1 * d.qStep);
        d.lastBeat = beat;
        d.lastValue = value;
        showDragHud(e.clientX, e.clientY, `${spec.label} ${spec.fmt(value)}`);
        draw();
        return;
      }
    }
  };

  /* ------------------------------------------------------------ pointer up */

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    dragRef.current = null;
    hideDragHud();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!d) return;
    const proj = stateRef.current.project;
    if (!proj) {
      draw();
      return;
    }

    switch (d.kind) {
      case "move": {
        if (!d.moved) {
          // click on an already-selected clip without dragging → reduce selection to it
          if (d.wasSelected) selectClips([d.primaryId]);
          break;
        }
        const tgt =
          d.targetTrackId !== null && d.valid && d.targetTrackId !== d.sourceTrackId
            ? d.targetTrackId
            : undefined;
        if (d.dup) {
          duplicateClips(d.ids)
            .then(async (r) => {
              const newIds = r.clips.map((c) => c.id);
              if (d.deltaBeats !== 0 || tgt !== undefined) {
                await moveClips(newIds, d.deltaBeats, tgt);
              }
              selectClips(newIds);
            })
            .catch((err) => console.warn("[timeline] duplicate-drag failed:", err));
        } else if (d.deltaBeats !== 0 || tgt !== undefined) {
          fire(moveClips(d.ids, d.deltaBeats, tgt));
        }
        break;
      }
      case "resize": {
        if (d.moved) {
          if (d.edge === "l") fire(resizeClip(d.clipId, "l", { newStartBeat: d.start }));
          else fire(resizeClip(d.clipId, "r", { newLengthBeats: d.len }));
        }
        break;
      }
      case "fade": {
        if (d.moved && Math.abs(d.sec - d.origSec) > 1e-6) {
          fire(setClip(d.clipId, d.which === "in" ? { fadeInSec: d.sec } : { fadeOutSec: d.sec }));
        }
        break;
      }
      case "draw": {
        let len = d.end - d.start;
        if (len <= 1e-9) len = proj.grid.division > 0 ? gridStepBeats(proj.grid) : 1;
        addMidiClip(d.trackId, d.start, len)
          .then((r) => selectClips([r.clip.id]))
          .catch((err) => console.warn("[timeline] draw clip failed:", err));
        break;
      }
      case "marquee": {
        setSelection({ clipIds: marqueeIdsRef.current, noteIds: [] });
        break;
      }
      case "pan": {
        e.currentTarget.style.cursor = "default"; // updateHover restores the cursor on move
        const wasRight = panRightRef.current;
        panRightRef.current = false;
        // stationary MIDDLE-click (right-click keeps its context menu) → pie menu
        const movedPx =
          Math.abs(e.clientX - d.startClientX) + Math.abs(e.clientY - d.startClientY);
        if (!wasRight && movedPx <= 4) openPieMenu(e.clientX, e.clientY, timelinePieItems());
        break;
      }
      case "lanePoint": {
        // transients already streamed — always commit so the engine state is authoritative
        // and the gesture lands on the undo stack (SPEC §5.8)
        if (d.moved) {
          fire(
            commitParam("cmd/automation.set", {
              trackId: d.trackId,
              paramRef: d.paramRef,
              update: [{ pointId: d.pointId, patch: { beat: d.beat, value: d.value } }],
            }),
          );
        }
        break;
      }
      case "laneCurve": {
        if (d.moved) {
          fire(
            commitParam("cmd/automation.set", {
              trackId: d.trackId,
              paramRef: d.paramRef,
              update: [{ pointId: d.pointId, patch: { curve: d.curve } }],
            }),
          );
        }
        break;
      }
      case "laneDraw": {
        if (d.stream.size <= 1) {
          // plain click — one snapped point (the pre-paint draw-tool behavior)
          fire(
            setAutomation(d.trackId, d.paramRef, {
              add: [{ t: snapB(d.lastBeat, proj.grid, e.shiftKey), v: d.lastValue }],
            }),
          );
          break;
        }
        // ONE cmd/automation.set = one undo entry: replace the painted range with
        // the dense stream (same contract as the piano roll's CC pencil).
        const row = laneRowOf(stateRef.current.rows, d.trackId, d.paramRef);
        const remove = row
          ? row.points
              .filter((p) => p.beat >= d.lo - 1e-9 && p.beat <= d.hi + 1e-9)
              .map((p) => p.id)
          : [];
        const add = [...d.stream.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([k, v]) => ({ t: k * d.qStep, v }));
        fire(setAutomation(d.trackId, d.paramRef, { remove, add }));
        break;
      }
    }
    draw();
  };

  /* ------------------------------------------------------------ dbl click */

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const { vx, cy } = localPoint(e.clientX, e.clientY);
    const st = stateRef.current;
    const proj = st.project;
    const row = rowAtY(st.rows, cy);
    // select-tool double-click on an empty midi/instrument lane: create a one-bar clip
    // and open it in the piano roll (the standard "add a note block" gesture)
    if (
      proj &&
      st.tool === "select" &&
      row &&
      row.kind === "track" &&
      trackAcceptsClip(row.track, "midi") &&
      !hitTest(vx, cy)
    ) {
      createMidiClipAt(row.track, pxToBeat(vx, st.vp), true);
      return;
    }
    if (proj && row && row.kind === "lane") {
      // only the select tool adds on dbl-click (draw adds on single click, erase
      // deletes, split stays inert on lanes); skip points (dbl-click = move target)
      if (st.tool !== "select" || laneHitPoint(row, vx, cy, st.vp)) return;
      const spec = paramSpecFor(row.paramRef, row.track);
      fire(
        setAutomation(row.track.id, row.paramRef, {
          add: [
            {
              t: snapB(pxToBeat(vx, st.vp), proj.grid, e.shiftKey),
              v: laneYToValue(cy, spec, row.top, row.height),
            },
          ],
        }),
      );
      return;
    }
    const hit = hitTest(vx, cy);
    if (!hit) return;
    const s = useStore.getState();
    s.setSelection({ clipIds: [hit.clip.id], trackIds: [hit.row.track.id], noteIds: [] });
    // focus follows the editor we just opened, so its key handlers apply immediately
    // (the pointerdown-capture on tl-root set "timeline" an instant earlier)
    if (hit.clip.type === "midi") {
      s.setActiveMidiClipId(hit.clip.id);
      s.setPanels({ bottomTab: "pianoRoll" });
      s.setFocusedPane("pianoRoll");
    } else {
      s.setActiveAudioClipId(hit.clip.id);
      s.setPanels({ bottomTab: "clipEditor" });
      s.setFocusedPane("clipEditor");
    }
  };

  /* ----------------------------------------------------------- context menu */

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    e.preventDefault();
    // A right-button drag that panned the grid must not also pop the context menu.
    if (suppressCtxRef.current) {
      suppressCtxRef.current = false;
      return;
    }
    const st = stateRef.current;
    const proj = st.project;
    if (!proj) return;
    const { vx, cy } = localPoint(e.clientX, e.clientY);
    const rawBeat = pxToBeat(vx, st.vp);
    const pasteBeat = snapB(rawBeat, proj.grid);

    // lane rows: menu on a point (delete / clear lane) — a bare right-click must not
    // destroy data. Empty lane space offers Clear Lane only when points exist.
    const row = rowAtY(st.rows, cy);
    if (row && row.kind === "lane") {
      const pt = laneHitPoint(row, vx, cy, st.vp);
      const clearLane: MenuEntry = {
        label: "Clear Lane",
        icon: "trash",
        danger: true,
        disabled: row.points.length === 0,
        onClick: () => {
          const n = row.points.length;
          void confirmDialog({
            title: "Clear automation lane",
            message: `Remove all ${n} point${n === 1 ? "" : "s"} from this lane? This can be undone.`,
            confirmLabel: "Clear",
            danger: true,
          }).then((ok) => {
            if (!ok) return;
            keepEmptiedLaneRow(row);
            fire(setAutomation(row.track.id, row.paramRef, { remove: row.points.map((p) => p.id) }));
          });
        },
      };
      // Toolbox strip: the two input styles live on the tools — select drags points,
      // DRAW paints flowing automation (click = single dot), erase deletes.
      const s0 = useStore.getState();
      const laneTools: MenuEntry = {
        type: "icons",
        buttons: (
          [
            { tool: "select", label: "Select tool (1) — drag points, Alt-drag bends curves", icon: "pointer" },
            { tool: "draw", label: "Draw tool (2) — click adds a dot, drag PAINTS flowing automation", icon: "pencil" },
            { tool: "erase", label: "Erase tool (3) — click deletes points", icon: "eraser" },
          ] as const
        ).map((t) => ({
          icon: t.icon,
          label: t.label,
          active: s0.tool === t.tool,
          onClick: () => useStore.getState().setTool(t.tool),
        })),
      };
      const spec = paramSpecFor(row.paramRef, row.track);
      const addValue = laneYToValue(cy, spec, row.top, row.height);
      openContextMenu(e.clientX, e.clientY, [
        laneTools,
        "separator",
        ...(pt
          ? [
              {
                label: "Delete Point",
                icon: "trash" as const,
                onClick: () => {
                  keepEmptiedLaneRow(row);
                  fire(setAutomation(row.track.id, row.paramRef, { remove: [pt.id] }));
                },
              },
              "separator" as const,
            ]
          : []),
        {
          label: "Add Point Here",
          icon: "plus",
          title: `${spec.label} ${spec.fmt(addValue)} at ${formatBarsBeatsShort(pasteBeat, proj.timeSigMap)} — any tool; drag with the Draw tool (2) to paint`,
          onClick: () =>
            fire(
              setAutomation(row.track.id, row.paramRef, {
                add: [{ t: pasteBeat, v: addValue }],
              }),
            ),
        },
        clearLane,
      ]);
      return;
    }

    const hit = hitTest(vx, cy);
    const mx = e.clientX;
    const my = e.clientY;

    if (!hit) {
      // Cubase-style toolbox first: right-click on empty space is how DAW users switch
      // tools mid-gesture. Then creation/paste actions for the spot under the cursor.
      const tools: MenuEntry[] = TIMELINE_TOOLS.map((t) => ({
        label: t.label,
        icon: t.icon,
        shortcut: t.shortcut,
        checked: st.tool === t.tool,
        onClick: () => useStore.getState().setTool(t.tool),
      }));
      const track = row && row.kind === "track" ? row.track : null;
      const canMidi = track !== null && trackAcceptsClip(track, "midi");
      openContextMenu(mx, my, [
        ...tools,
        "separator",
        {
          label: "Create MIDI Clip",
          icon: "midiNote",
          disabled: !canMidi,
          title: canMidi
            ? "One-bar clip here — or drag with the Draw tool (2); double-click also works"
            : "Right-click on a MIDI or instrument track lane",
          onClick: () => {
            if (track) createMidiClipAt(track, rawBeat, false);
          },
        },
        {
          label: "Paste at Position",
          shortcut: "Ctrl+V",
          disabled: !hasClipboard(),
          onClick: () => void pasteAt(pasteBeat).catch((err) => console.warn("[timeline] paste failed:", err)),
        },
        "separator",
        { label: "Add Track", icon: "plus", submenu: addTrackMenuItems() },
      ]);
      return;
    }

    const clip = hit.clip;
    let ids = st.selection.clipIds;
    if (!ids.includes(clip.id)) {
      ids = [clip.id];
      selectClips(ids, [hit.row.track.id]);
    }
    const muteTarget = !(clip.muted === true);
    const items: MenuEntry[] = [
      {
        label: "Cut",
        shortcut: "Ctrl+X",
        onClick: () => void cutSelection().catch((err) => console.warn("[timeline] cut failed:", err)),
      },
      { label: "Copy", shortcut: "Ctrl+C", onClick: () => void copySelection() },
      {
        label: "Paste",
        shortcut: "Ctrl+V",
        disabled: !hasClipboard(),
        onClick: () => void pasteAt(pasteBeat).catch((err) => console.warn("[timeline] paste failed:", err)),
      },
      { label: "Duplicate", shortcut: "Ctrl+D", onClick: () => fire(duplicateClips(ids)) },
      "separator",
      {
        label: "Split at Playhead",
        icon: "scissors",
        shortcut: "B",
        onClick: () => fire(splitClips(ids, transportBus.last?.beat ?? 0)),
      },
      {
        label: clip.muted ? "Unmute" : "Mute",
        shortcut: "M",
        checked: clip.muted === true,
        onClick: () => {
          for (const id of ids) {
            const c = clipById(proj, id);
            if (c && (c.muted === true) !== muteTarget) fire(setClip(id, { muted: muteTarget }));
          }
        },
      },
      ...(clip.type === "audio"
        ? ([
            {
              label: "Process",
              icon: "audioWave",
              title:
                "Destructive audio processing on this clip (Cubase-style) — writes an edit file; undoable",
              submenu: [
                { label: "Fade In", onClick: () => fire(processAudioClip(clip.id, "fadeIn")) },
                { label: "Fade Out", onClick: () => fire(processAudioClip(clip.id, "fadeOut")) },
                "separator",
                {
                  label: "Gain",
                  submenu: [6, 3, 1, -1, -3, -6].map((db) => ({
                    label: `${db > 0 ? "+" : ""}${db} dB`,
                    onClick: () => fire(processAudioClip(clip.id, "gain", { gainDb: db })),
                  })),
                },
                {
                  label: "Normalize",
                  submenu: [0, -1, -3, -6].map((db) => ({
                    label: `to ${db} dBFS`,
                    onClick: () => fire(processAudioClip(clip.id, "normalize", { targetDb: db })),
                  })),
                },
                "separator",
                { label: "Reverse", onClick: () => fire(processAudioClip(clip.id, "reverse")) },
                { label: "Invert Phase", onClick: () => fire(processAudioClip(clip.id, "invert")) },
                { label: "Remove DC Offset", onClick: () => fire(processAudioClip(clip.id, "dcRemove")) },
                { label: "Silence", onClick: () => fire(processAudioClip(clip.id, "silence")) },
              ],
            },
            {
              label: "Time-Stretch",
              submenu: [
                { label: "½× (faster)", onClick: () => fire(stretchClip(clip.id, 0.5)) },
                { label: "2× (slower)", onClick: () => fire(stretchClip(clip.id, 2.0)) },
                { label: "1.5× (slower)", onClick: () => fire(stretchClip(clip.id, 1.5)) },
                "separator",
                { label: "Transpose +12 st", onClick: () => fire(stretchClip(clip.id, 2.0, true)) },
                { label: "Transpose −12 st", onClick: () => fire(stretchClip(clip.id, 0.5, true)) },
                { label: "Transpose +7 st", onClick: () => fire(stretchClip(clip.id, 1.4983, true)) },
              ],
            },
          ] as MenuEntry[])
        : []),
      {
        label: "Rename…",
        icon: "pencil",
        onClick: () => setOverlay({ kind: "rename", clipId: clip.id, x: mx, y: my, initial: clip.name }),
      },
      {
        label: "Color…",
        onClick: () => setOverlay({ kind: "color", ids, x: mx, y: my, current: clip.color }),
      },
      "separator",
      {
        label: "Delete",
        icon: "trash",
        shortcut: "Del",
        danger: true,
        onClick: () => fire(deleteClips(ids)),
      },
    ];
    openContextMenu(mx, my, items);
  };

  /* ------------------------------------------------------------------ drops */

  const dragAccepted = (dt: DataTransfer): boolean =>
    hasPluginDrag(dt) || hasAssetDrag(dt) || Array.from(dt.types).includes("Files");

  const onDragOver = (e: React.DragEvent<HTMLCanvasElement>): void => {
    const dt = e.dataTransfer;
    if (!dt || !dragAccepted(dt)) return;
    e.preventDefault();
    dt.dropEffect = "copy";
    const el = canvasRef.current;
    const left = el ? el.getBoundingClientRect().left : 0;
    dropHintRef.current = { vx: e.clientX - left };
    draw();
  };

  const onDragLeave = (): void => {
    if (dropHintRef.current) {
      dropHintRef.current = null;
      draw();
    }
  };

  const onDrop = (e: React.DragEvent<HTMLCanvasElement>): void => {
    const dt = e.dataTransfer;
    if (!dt) return;
    // A mixer insert dragged here lands on "nothing" — let it bubble to lib/dnd's
    // document-level listener, which flags it for removal from its source channel.
    if (hasInsertDrag(dt)) return;
    e.preventDefault();
    e.stopPropagation(); // handled here — keep it from the window stray-drop guard
    dropHintRef.current = null;
    const st = stateRef.current;
    const proj = st.project;
    const { vx, cy } = localPoint(e.clientX, e.clientY);
    const beat = snapB(pxToBeat(vx, st.vp), proj?.grid ?? null, e.shiftKey);
    const row = rowAtY(st.rows, cy);
    const track = row && row.kind === "track" ? row.track : null;

    const plug = readPluginDrag(dt);
    if (plug) {
      if (track && track.kind === "midi") {
        // An INSTRUMENT dropped on a MIDI channel lands on its host instrument track
        // (or creates + routes one) — same semantics as the header dropdown. Only
        // effects have nowhere to go (MIDI channels host no audio plugins).
        const info = useStore.getState().registry.find((p) => p.uid === plug.uid);
        if (info?.isInstrument) {
          if (!assignInstrumentToTrack(track, info))
            showToast("The target instrument track is frozen — unfreeze it first.", "info");
        } else {
          showToast(
            "MIDI tracks can't host effect plugins — drop on an Instrument or Audio track, or on empty space to create one.",
            "info",
          );
        }
      } else if (track) {
        fire(addPlugin(track.id, plug.uid));
      } else {
        // empty area below the last track — create a track of the plugin's kind first
        const info = useStore.getState().registry.find((p) => p.uid === plug.uid);
        fire(
          addTrack(info?.isInstrument ? "instrument" : "audio").then((r) =>
            addPlugin(r.track.id, plug.uid),
          ),
        );
      }
      draw();
      return;
    }
    const asset = readAssetDrag(dt);
    if (asset) {
      if (track === null) {
        // empty area below the last track — create an audio track to hold the clip
        fire(addTrack("audio").then((r) => addAudioClip(r.track.id, beat, asset.assetId)));
      } else if (trackAcceptsClip(track, "audio")) {
        fire(addAudioClip(track.id, beat, asset.assetId));
      } else {
        showToast("Audio files can only be dropped on audio tracks", "info");
      }
      draw();
      return;
    }
    const files = Array.from(dt.files ?? []);
    if (files.length > 0) {
      // A dropped .cpr is a whole project, not media — a browser drop has no file path to
      // hand project/importForeign, so don't upload it to the audio decoder (it would fail
      // in Media Foundation). Upload only real media; the user opens projects via File menu.
      void (async () => {
        const projExts = await projectOnlyExtensions();
        const media = files.filter((f) => !projExts.has(extensionOf(f.name)));
        const projectDropped = files.length - media.length;
        if (projectDropped > 0)
          console.warn("[timeline] ignored a dropped project file — open it via File → Import Project");
        if (media.length > 0) {
          const r = await uploadFiles(media, { ...(track ? { trackId: track.id } : {}), atBeat: beat });
          // no target track: audio lands in the Browser Files tab (only .mid imports
          // create tracks of their own) — say where the files went
          if (!track && r.assets.length > 0 && (r.tracks?.length ?? 0) === 0)
            showToast(
              `Imported ${r.assets.length} file${r.assets.length === 1 ? "" : "s"} to the Files tab`,
              "success",
            );
        }
      })().catch((err) => console.warn("[timeline] drop import failed:", err));
    }
    draw();
  };

  /* ----------------------------------------------------- keyboard context */

  useEffect(
    () =>
      registerKeyContext("timeline", {
        deleteSelection: () => {
          const s = useStore.getState();
          if (s.selection.clipIds.length > 0) fire(deleteClips(s.selection.clipIds));
        },
        selectAll: () => {
          const s = useStore.getState();
          if (!s.project) return;
          const ids: number[] = [];
          for (const t of s.project.tracks) for (const c of t.clips) ids.push(c.id);
          s.setSelection({ clipIds: ids, noteIds: [] });
        },
        escape: () => {
          if (dragRef.current) {
            dragRef.current = null;
            hideDragHud(); // touches only stable refs — safe from the once-registered context
            drawRef.current();
            return true;
          }
          return false;
        },
        // ←/→ nudge the selected clips by one grid step (1 beat when snap is off);
        // Shift = one bar. Clamped so the earliest clip cannot cross beat 0.
        nudge: (dx, _dy, big) => {
          if (dx === 0) return false;
          const s = useStore.getState();
          const proj = s.project;
          const ids = s.selection.clipIds;
          if (!proj || ids.length === 0) return false;
          let minStart = Infinity;
          for (const id of ids) {
            const found = findClipById(proj, id);
            if (found) minStart = Math.min(minStart, found.clip.startBeat);
          }
          if (!Number.isFinite(minStart)) return false;
          const grid = proj.grid;
          const step = big
            ? timeSigAtBeat(minStart, proj.timeSigMap).beatsPerBar
            : grid.snap && grid.division > 0
              ? gridStepBeats(grid)
              : 1;
          const delta = Math.max(dx * step, -minStart);
          if (delta !== 0) fire(moveClips(ids, delta));
          return true;
        },
        // F — fit the selected clips (else the whole arrangement) into the viewport.
        zoomToFit: () => {
          const s = useStore.getState();
          const proj = s.project;
          const el = canvasRef.current;
          if (!proj || !el || el.clientWidth <= 0) return false;
          const ids =
            s.selection.clipIds.length > 0
              ? s.selection.clipIds
              : proj.tracks.flatMap((t) => t.clips.map((c) => c.id));
          let start = Infinity;
          let end = 0;
          for (const id of ids) {
            const found = findClipById(proj, id);
            if (!found) continue;
            start = Math.min(start, found.clip.startBeat);
            end = Math.max(
              end,
              found.clip.startBeat + clipLengthBeats(found.clip, proj.tempoMap, proj.sampleRate),
            );
          }
          if (!Number.isFinite(start) || end <= start) return false;
          const pad = 24; // px of air on each side
          const span = Math.max(0.25, end - start);
          const zoomX = clamp((el.clientWidth - 2 * pad) / span, MIN_ZOOM_X, MAX_ZOOM_X);
          animateViewport({ zoomX, scrollX: Math.max(0, start * zoomX - pad) });
          return true;
        },
      }),
    [],
  );

  /* ----------------------------------------------------------------- render */

  return (
    <>
      <canvas
        ref={ref}
        className="tl-clipcanvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
          hideDragHud();
          draw();
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      />
      <div className="drag-hud" ref={hudElRef} />
      {overlay && overlay.kind === "rename" && (
        <FloatingInput
          x={overlay.x}
          y={overlay.y}
          width={160}
          initial={overlay.initial}
          placeholder="Clip name"
          onCommit={(name) => {
            setOverlay(null);
            const trimmed = name.trim();
            if (trimmed && trimmed !== overlay.initial) fire(setClip(overlay.clipId, { name: trimmed }));
          }}
          onCancel={() => setOverlay(null)}
        />
      )}
      {overlay && overlay.kind === "color" && (
        <ColorPopover
          x={overlay.x}
          y={overlay.y}
          current={overlay.current}
          onPick={(color) => {
            for (const id of overlay.ids) fire(setClip(id, { color }));
          }}
          onClose={() => setOverlay(null)}
        />
      )}
    </>
  );
}
