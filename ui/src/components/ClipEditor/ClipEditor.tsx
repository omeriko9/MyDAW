/**
 * ClipEditor — audio clip editor dock tab for store.activeAudioClipId (set by
 * double-clicking an audio clip / Inspector "Open in Editor").
 *
 * Layout: mini-toolbar (clip name + asset, gain in dB, Normalize, fades, Split at
 * Cursor, zoom fit) over a sample-domain waveform canvas: x maps to SOURCE samples
 * of the asset; the audible range [srcOffsetSamples, +lengthSamples] is highlighted.
 * Wheel scrolls, ctrl+wheel zooms around the pointer, default view is zoom-to-fit.
 *
 * Gestures mirror the timeline (SPEC §5.8): trim edge drags preview locally and send
 * ONE cmd/clip.resize on release (same semantics as ClipCanvas edge drags — "l" →
 * newStartBeat, "r" → newLengthBeats); fade handle / gain drags stream transient
 * cmd/clip.set and commit non-transient on release. Normalize scans the lod-0 peaks
 * over the audible range and sets gain = 1/peak (capped at +24 dB) in one command.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioClip, Asset, Project, Track } from "../../protocol/types";
import { isAudioClip } from "../../protocol/types";
import { useStore } from "../../store/store";
import { commitParam, resizeClip, setClip, splitClips, transientParam } from "../../store/actions";
import { paneVisible, registerKeyContext } from "../../lib/keyboard";
import { fetchPeaks, pickLod, type PeakLod } from "../../lib/peaks";
import { beatsToSeconds, bpmAtBeat, secondsToBeats } from "../../lib/time";
import { lineV, roundRect, useCanvas } from "../../lib/canvas";
import { clamp, EDGE_HIT_PX, FADE_HIT_PX, themeVar, withAlpha } from "../Timeline/layout";
import { peaksFailed, peaksFor } from "../Timeline/peaksCache";
import { FloatingInput } from "../Timeline/bits";
import { Icon } from "../common/icons";
import { openContextMenu } from "../common/ContextMenu";
import { useIsKeyTarget } from "../common/paneFocus";
import { GainDbDrag, SecondsDrag } from "../Inspector/fields";
import "./clipEditor.css";

/* Interaction constants not exported by Timeline/layout. */
const FADE_ZONE_PX = 18;
const MIN_CLIP_BEATS = 1 / 16; // mirrors ClipCanvas MIN_CLIP_BEATS (module-local there)
const MAX_NORM_GAIN = Math.pow(10, 24 / 20); // +24 dB cap for Normalize
const MIN_SPP = 1; // max zoom-in: 1 sample per px (lod 0 resolves no finer anyway)

const fire = (p: Promise<unknown>): void => {
  p.catch((e) => console.warn("[clipEditor] command failed:", e));
};

/* ============================================================================
 * Theme colors (themeVar caches resolved CSS vars — same as the timeline canvases)
 * ========================================================================= */

interface CeColors {
  bg: string;
  border: string;
  borderLight: string;
  textDim: string;
  textFaint: string;
  accent: string;
  playhead: string;
  danger: string;
}

function ceColors(): CeColors {
  return {
    bg: themeVar("--bg"),
    border: themeVar("--border"),
    borderLight: themeVar("--border-light"),
    textDim: themeVar("--text-dim"),
    textFaint: themeVar("--text-faint"),
    accent: themeVar("--accent"),
    playhead: themeVar("--playhead"),
    danger: themeVar("--danger"),
  };
}

/* ============================================================================
 * Component
 * ========================================================================= */

/** Horizontal view over the SOURCE sample axis. */
interface View {
  /** samples per px */
  spp: number;
  /** source sample at the canvas left edge */
  scroll: number;
}

type Drag =
  | {
      kind: "trimL" | "trimR";
      grabX: number;
      origOffset: number;
      origLen: number;
      offset: number;
      len: number;
      moved: boolean;
    }
  | { kind: "fade"; which: "in" | "out"; sec: number; moved: boolean }
  | { kind: "cursor" };

interface Snap {
  project: Project | null;
  track: Track | null;
  clip: AudioClip | null;
  asset: Asset | null;
  sr: number;
  cursorSmp: number | null;
}

export default function ClipEditor() {
  const project = useStore((s) => s.project);
  const clipId = useStore((s) => s.activeAudioClipId);

  /* ----------------------------------------------------- resolve active clip */

  let track: Track | null = null;
  let clip: AudioClip | null = null;
  if (project && clipId != null) {
    for (const t of [...project.tracks, project.masterTrack]) {
      for (const c of t.clips) {
        if (c.id === clipId && isAudioClip(c)) {
          track = t;
          clip = c;
        }
      }
    }
  }
  const asset = project && clip ? (project.assets.find((a) => a.id === clip!.assetId) ?? null) : null;
  const sr = project && project.sampleRate > 0 ? project.sampleRate : 48000;

  /* ------------------------------------------------------------ local state */

  /** Editor split cursor, in SOURCE samples (null = unset). */
  const [cursorSmp, setCursorSmp] = useState<number | null>(null);
  /** lod-0 peaks of the asset — exact data for Normalize (display uses peaksFor). */
  const [lod0, setLod0] = useState<PeakLod | null>(null);
  /** Rename input opened from the context menu (screen coords). */
  const [renameAt, setRenameAt] = useState<{ x: number; y: number } | null>(null);

  const viewRef = useRef<View | null>(null);
  const fitForRef = useRef<number | null>(null); // clip id the view was last fitted for
  const dragRef = useRef<Drag | null>(null);
  /** in-gesture values so the waveform tracks toolbar/handle drags before the engine echo */
  const gainPreviewRef = useRef<number | null>(null);
  const fadePreviewRef = useRef<{ fadeIn?: number; fadeOut?: number }>({});
  const sizeRef = useRef({ width: 0, height: 0 });

  const stateRef = useRef<Snap>({ project: null, track: null, clip: null, asset: null, sr, cursorSmp: null });
  stateRef.current = { project, track, clip, asset, sr, cursorSmp };

  const drawRef = useRef<() => void>(() => undefined);
  const { ref, canvasRef, ctxRef } = useCanvas((_ctx, sz) => {
    sizeRef.current = { width: sz.width, height: sz.height };
    drawRef.current();
  });

  /* ------------------------------------------------------ redraw scheduling */

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

  /* -------------------------------------------- reset gesture state per clip */

  useEffect(() => {
    setCursorSmp(null);
    setRenameAt(null);
    dragRef.current = null;
    gainPreviewRef.current = null;
    fadePreviewRef.current = {};
  }, [clipId]);

  // engine echo landed → drop the matching local preview
  useEffect(() => {
    gainPreviewRef.current = null;
    schedule();
  }, [clip?.gain, schedule]);
  useEffect(() => {
    fadePreviewRef.current.fadeIn = undefined;
    schedule();
  }, [clip?.fadeInSec, schedule]);
  useEffect(() => {
    fadePreviewRef.current.fadeOut = undefined;
    schedule();
  }, [clip?.fadeOutSec, schedule]);

  /* ------------------------------------------------- lod-0 peaks (Normalize) */

  const assetKey = asset && !asset.missing ? asset.id : null;
  const assetCh = asset ? Math.max(1, asset.channels) : 1;
  useEffect(() => {
    setLod0(null);
    if (assetKey === null) return;
    let alive = true;
    fetchPeaks(assetKey, 0, assetCh)
      .then((l) => {
        if (alive) setLod0(l);
      })
      .catch(() => {
        /* Normalize stays disabled; the canvas shows the unavailable state */
      });
    return () => {
      alive = false;
    };
  }, [assetKey, assetCh]);

  /* ------------------------------------------------------------------- view */

  const fitView = useCallback((c: AudioClip, width: number): View => {
    const len = Math.max(1, c.lengthSamples);
    const pad = len * 0.03;
    return { spp: Math.max(0.001, (len + 2 * pad) / Math.max(32, width)), scroll: c.srcOffsetSamples - pad };
  }, []);

  /** Current geometry (drag previews applied). Null when there is nothing to draw on. */
  const geomNow = useCallback(() => {
    const st = stateRef.current;
    const v = viewRef.current;
    const { clip: c, asset: a } = st;
    if (!c || !a || a.missing || !v) return null;
    const d = dragRef.current;
    let off = c.srcOffsetSamples;
    let len = c.lengthSamples;
    if (d && (d.kind === "trimL" || d.kind === "trimR") && d.moved) {
      off = d.offset;
      len = d.len;
    }
    const x0 = (off - v.scroll) / v.spp;
    const x1 = (off + len - v.scroll) / v.spp;
    const wPx = Math.max(0, x1 - x0);
    const fi = fadePreviewRef.current.fadeIn ?? c.fadeInSec;
    const fo = fadePreviewRef.current.fadeOut ?? c.fadeOutSec;
    const inPx = clamp((Math.max(0, fi) * st.sr) / v.spp, 0, wPx);
    const outPx = clamp((Math.max(0, fo) * st.sr) / v.spp, 0, wPx);
    return { v, off, len, x0, x1, inPx, outPx };
  }, []);

  /* ------------------------------------------------------------------- draw */

  const draw = (): void => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { width: w, height: h } = sizeRef.current;
    if (w <= 2 || h <= 2) return;
    const st = stateRef.current;
    const colors = ceColors();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    const { clip: c, asset: a, project: proj } = st;
    if (!c || !proj) return;

    if (!a || a.missing) {
      // missing asset — diagonal hatch + message (same idiom as the timeline)
      ctx.strokeStyle = withAlpha(colors.danger, 0.35);
      ctx.lineWidth = 1;
      for (let x = -h; x < w; x += 12) {
        ctx.beginPath();
        ctx.moveTo(x, h);
        ctx.lineTo(x + h, 0);
        ctx.stroke();
      }
      ctx.fillStyle = colors.danger;
      ctx.font = "500 12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(a ? "missing audio — relink the asset to edit it" : "audio asset not found", w / 2, h / 2);
      return;
    }

    // (re)fit when the active clip changed or the view was reset
    if (!viewRef.current || fitForRef.current !== c.id) {
      viewRef.current = fitView(c, w);
      fitForRef.current = c.id;
    }
    const g = geomNow();
    if (!g) return;
    const { v, off, len, x0, x1, inPx, outPx } = g;
    const color = c.color ?? st.track?.color ?? colors.accent;

    // dim everything outside the audible range; tint + edge lines for the clip body
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    if (x0 > 0) ctx.fillRect(0, 0, Math.min(w, x0), h);
    if (x1 < w) ctx.fillRect(Math.max(0, x1), 0, w - Math.max(0, x1), h);
    ctx.fillStyle = withAlpha(color, 0.07);
    ctx.fillRect(Math.max(0, x0), 0, Math.min(w, x1) - Math.max(0, x0), h);

    // center line
    const midY = h / 2;
    ctx.strokeStyle = withAlpha(colors.border, 0.7);
    ctx.beginPath();
    ctx.moveTo(0, midY + 0.5);
    ctx.lineTo(w, midY + 0.5);
    ctx.stroke();

    // waveform — per-pixel min/max from peaks, channels summed, gain applied
    // visually (same technique as Timeline/clipRender.drawAudioContent); peaks come
    // from the shared Timeline/peaksCache (exact lod when loaded, closest fallback,
    // onArrive repaints when a fetch we kicked off lands)
    const lod = pickLod(1 / v.spp);
    const peaks = peaksFor(a.id, lod, Math.max(1, a.channels), schedule);
    const px0 = Math.max(Math.floor(x0) + 1, 0);
    const px1 = Math.min(Math.ceil(x1) - 1, Math.ceil(w));
    const n = px1 - px0;
    const halfH = h / 2 - 6;
    const gainScale = clamp(gainPreviewRef.current ?? c.gain, 0, 2);
    ctx.fillStyle = withAlpha(color, 0.85);

    if (!peaks || halfH <= 1) {
      if (n > 0) ctx.fillRect(px0, midY - 0.5, n, 1);
      if (n > 80 && h > 30) {
        ctx.fillStyle = colors.textFaint;
        ctx.font = "500 11px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const msg = peaksFailed(a.id, lod)
          ? "waveform unavailable (peaks failed to load)"
          : "loading waveform…";
        ctx.fillText(msg, (Math.max(0, x0) + Math.min(w, x1)) / 2, midY - 14);
        ctx.fillStyle = withAlpha(color, 0.85);
      }
    } else if (n > 0) {
      const spb = Math.max(1, peaks.samplesPerBucket);
      const ch = Math.max(1, peaks.channels);
      const data = peaks.data;
      const nb = peaks.numBuckets;
      const tops = new Float32Array(n);
      const bots = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const s0 = v.scroll + (px0 + i) * v.spp;
        const s1 = s0 + v.spp;
        let b0 = Math.floor(s0 / spb);
        let b1 = Math.max(b0, Math.ceil(s1 / spb) - 1);
        b0 = clamp(b0, 0, nb - 1);
        b1 = clamp(b1, 0, nb - 1);
        let mn = 127;
        let mx = -128;
        for (let b = b0; b <= b1; b++) {
          for (let cc = 0; cc < ch; cc++) {
            const idx = (b * ch + cc) * 2;
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
      ctx.moveTo(px0, tops[0]);
      for (let i = 1; i < n; i++) ctx.lineTo(px0 + i, tops[i]);
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(px0 + i, bots[i]);
      ctx.closePath();
      ctx.fill();
    }

    // fade ramps + corner handles (same look as Timeline/clipRender.drawFades)
    if (inPx > 0.5) {
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0 + inPx, 0);
      ctx.lineTo(x0, h);
      ctx.closePath();
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x0, h);
      ctx.lineTo(x0 + inPx, 0);
      ctx.strokeStyle = withAlpha(colors.playhead, 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (outPx > 0.5) {
      ctx.beginPath();
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1 - outPx, 0);
      ctx.lineTo(x1, h);
      ctx.closePath();
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x1 - outPx, 0);
      ctx.lineTo(x1, h);
      ctx.strokeStyle = withAlpha(colors.playhead, 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (x1 - x0 >= 24) {
      const hs = 7;
      for (const hx of [x0 + inPx, x1 - outPx]) {
        if (hx < -hs || hx > w + hs) continue;
        ctx.fillStyle = colors.playhead;
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(hx - hs / 2, 4, hs, hs);
        ctx.fill();
        ctx.stroke();
      }
    }

    // trim handles: edge line + vertical grip at each end of the audible range
    for (const [hx, inward] of [
      [x0, 1],
      [x1, -1],
    ] as const) {
      if (hx < -8 || hx > w + 8) continue;
      ctx.strokeStyle = withAlpha(color, 0.9);
      ctx.lineWidth = 1.5;
      lineV(ctx, hx, 0, h);
      const gw = 6;
      const gh = Math.min(28, h * 0.4);
      const gx = inward > 0 ? hx + 1.5 : hx - 1.5 - gw;
      roundRect(ctx, gx, midY - gh / 2, gw, gh, 3);
      ctx.fillStyle = colors.bg;
      ctx.fill();
      ctx.strokeStyle = colors.borderLight;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // split cursor
    if (st.cursorSmp !== null) {
      const cx = (st.cursorSmp - v.scroll) / v.spp;
      if (cx >= -1 && cx <= w + 1 && st.cursorSmp >= off && st.cursorSmp <= off + len) {
        ctx.strokeStyle = colors.playhead;
        ctx.lineWidth = 1;
        lineV(ctx, cx, 0, h);
        ctx.fillStyle = colors.playhead;
        ctx.beginPath();
        ctx.moveTo(cx - 4, 0);
        ctx.lineTo(cx + 4, 0);
        ctx.lineTo(cx, 6);
        ctx.closePath();
        ctx.fill();
      }
    }
  };
  drawRef.current = draw;

  useEffect(() => {
    draw();
  });

  /* ------------------------------------------------------------ interaction */

  const localX = (e: { clientX: number }): number => {
    const el = canvasRef.current;
    return e.clientX - (el ? el.getBoundingClientRect().left : 0);
  };
  const localY = (e: { clientY: number }): number => {
    const el = canvasRef.current;
    return e.clientY - (el ? el.getBoundingClientRect().top : 0);
  };

  type Zone = "fadeIn" | "fadeOut" | "l" | "r" | null;
  const zoneAt = (x: number, y: number): Zone => {
    const g = geomNow();
    if (!g) return null;
    if (y <= FADE_ZONE_PX && g.x1 - g.x0 >= 24) {
      if (Math.abs(x - (g.x0 + g.inPx)) <= FADE_HIT_PX) return "fadeIn";
      if (Math.abs(x - (g.x1 - g.outPx)) <= FADE_HIT_PX) return "fadeOut";
    }
    if (Math.abs(x - g.x0) <= EDGE_HIT_PX) return "l";
    if (Math.abs(x - g.x1) <= EDGE_HIT_PX) return "r";
    return null;
  };

  const setCursorFromX = (x: number): void => {
    const g = geomNow();
    if (!g) return;
    const smp = Math.round(clamp(g.v.scroll + x * g.v.spp, g.off, g.off + g.len));
    setCursorSmp(smp);
  };

  /** Smallest allowed clip length in samples (mirrors the timeline's 1/16-beat floor). */
  const minLenSamples = (c: AudioClip, proj: Project): number => {
    const secPerBeat = 60 / Math.max(1e-6, bpmAtBeat(c.startBeat, proj.tempoMap));
    return Math.max(16, Math.ceil(MIN_CLIP_BEATS * secPerBeat * stateRef.current.sr));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    const st = stateRef.current;
    const c = st.clip;
    if (!c || !st.asset || st.asset.missing) return;
    const x = localX(e);
    const y = localY(e);
    const zone = zoneAt(x, y);

    if (zone === "fadeIn" || zone === "fadeOut") {
      const which = zone === "fadeIn" ? "in" : "out";
      const sec =
        which === "in"
          ? (fadePreviewRef.current.fadeIn ?? c.fadeInSec)
          : (fadePreviewRef.current.fadeOut ?? c.fadeOutSec);
      dragRef.current = { kind: "fade", which, sec, moved: false };
    } else if (zone === "l" || zone === "r") {
      dragRef.current = {
        kind: zone === "l" ? "trimL" : "trimR",
        grabX: x,
        origOffset: c.srcOffsetSamples,
        origLen: c.lengthSamples,
        offset: c.srcOffsetSamples,
        len: c.lengthSamples,
        moved: false,
      };
    } else {
      dragRef.current = { kind: "cursor" };
      setCursorFromX(x);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    schedule();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    const x = localX(e);
    const y = localY(e);
    if (!d) {
      const zone = zoneAt(x, y);
      const el = canvasRef.current;
      const cur = zone ? "ew-resize" : "crosshair";
      if (el && el.style.cursor !== cur) el.style.cursor = cur;
      return;
    }
    const st = stateRef.current;
    const c = st.clip;
    const a = st.asset;
    const proj = st.project;
    const v = viewRef.current;
    if (!c || !a || !proj || !v) return;

    switch (d.kind) {
      case "cursor": {
        setCursorFromX(x);
        schedule();
        return;
      }
      case "fade": {
        d.moved = true;
        const g = geomNow();
        if (!g) return;
        const lenSec = g.len / st.sr;
        const distPx = d.which === "in" ? x - g.x0 : g.x1 - x;
        const sec = clamp((distPx * v.spp) / st.sr, 0, lenSec);
        d.sec = sec;
        if (d.which === "in") fadePreviewRef.current.fadeIn = sec;
        else fadePreviewRef.current.fadeOut = sec;
        transientParam("cmd/clip.set", {
          clipId: c.id,
          patch: d.which === "in" ? { fadeInSec: sec } : { fadeOutSec: sec },
        });
        schedule();
        return;
      }
      case "trimL": {
        if (Math.abs(x - d.grabX) > 2) d.moved = true;
        const dSmp = Math.round((x - d.grabX) * v.spp);
        // can't trim past timeline 0 (startBeat >= 0) nor before the source start
        const startSec = beatsToSeconds(c.startBeat, proj.tempoMap);
        const loOff = Math.max(0, d.origOffset - Math.floor(startSec * st.sr));
        const hiOff = d.origOffset + d.origLen - minLenSamples(c, proj);
        d.offset = clamp(d.origOffset + dSmp, loOff, Math.max(loOff, hiOff));
        d.len = d.origOffset + d.origLen - d.offset;
        schedule();
        return;
      }
      case "trimR": {
        if (Math.abs(x - d.grabX) > 2) d.moved = true;
        const dSmp = Math.round((x - d.grabX) * v.spp);
        const hiLen = Math.max(1, a.lengthSamples - d.origOffset);
        d.len = clamp(d.origLen + dSmp, Math.min(minLenSamples(c, proj), hiLen), hiLen);
        schedule();
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const st = stateRef.current;
    const c = st.clip;
    const proj = st.project;
    if (!d || !c || !proj) {
      schedule();
      return;
    }

    if (d.kind === "fade") {
      if (d.moved) {
        fire(
          commitParam("cmd/clip.set", {
            clipId: c.id,
            patch: d.which === "in" ? { fadeInSec: d.sec } : { fadeOutSec: d.sec },
          }),
        );
      }
    } else if (d.kind === "trimL") {
      // same command the timeline edge-drag sends: one cmd/clip.resize on release
      if (d.moved && d.offset !== d.origOffset) {
        const startSec = beatsToSeconds(c.startBeat, proj.tempoMap);
        const newStartBeat = Math.max(
          0,
          secondsToBeats(startSec + (d.offset - d.origOffset) / st.sr, proj.tempoMap),
        );
        fire(resizeClip(c.id, "l", { newStartBeat }));
      }
    } else if (d.kind === "trimR") {
      if (d.moved && d.len !== d.origLen) {
        const startSec = beatsToSeconds(c.startBeat, proj.tempoMap);
        const newLengthBeats = Math.max(
          MIN_CLIP_BEATS,
          secondsToBeats(startSec + d.len / st.sr, proj.tempoMap) - c.startBeat,
        );
        fire(resizeClip(c.id, "r", { newLengthBeats }));
      }
    }
    schedule();
  };

  /* wheel: scroll horizontally; ctrl = zoom around the pointer (non-passive) */
  const hasEditor = Boolean(project && clip);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !hasEditor) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const st = stateRef.current;
      const v = viewRef.current;
      const a = st.asset;
      if (!v || !st.clip || !a || a.missing) return;
      const w = Math.max(1, sizeRef.current.width);
      if (e.ctrlKey || e.metaKey) {
        const x = e.clientX - el.getBoundingClientRect().left;
        const anchor = v.scroll + x * v.spp;
        const maxSpp = Math.max(32, (a.lengthSamples / Math.max(64, w)) * 1.25);
        const spp = clamp(v.spp * Math.exp(e.deltaY * 0.0012), MIN_SPP, maxSpp);
        v.spp = spp;
        v.scroll = anchor - x * spp;
      } else {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        v.scroll += delta * v.spp;
      }
      const viewSmp = w * v.spp;
      const lo = -viewSmp * 0.1;
      v.scroll = clamp(v.scroll, lo, Math.max(lo, a.lengthSamples - viewSmp * 0.9));
      schedule();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasEditor, canvasRef, schedule]);

  /* keyboard context (lib/keyboard) — G/H zoom routes here while this pane is focused;
   * zooms the LOCAL spp/scroll view, center-anchored (same clamps as the wheel zoom) */
  useEffect(
    () =>
      registerKeyContext("clipEditor", {
        zoomH: (factor) => {
          // Visible = dock tab active OR popped out into its own window.
          if (!paneVisible(useStore.getState().panels, "clipEditor")) return false;
          const st = stateRef.current;
          const v = viewRef.current;
          const a = st.asset;
          if (!v || !st.clip || !a || a.missing) return false;
          const w = Math.max(1, sizeRef.current.width);
          const cx = w / 2;
          const anchor = v.scroll + cx * v.spp;
          const maxSpp = Math.max(32, (a.lengthSamples / Math.max(64, w)) * 1.25);
          v.spp = clamp(v.spp / factor, MIN_SPP, maxSpp); // zoom in = fewer samples/px
          v.scroll = anchor - cx * v.spp;
          const viewSmp = w * v.spp;
          const lo = -viewSmp * 0.1;
          v.scroll = clamp(v.scroll, lo, Math.max(lo, a.lengthSamples - viewSmp * 0.9));
          schedule();
          return true;
        },
        // F — same as the toolbar Fit button: the whole waveform in view.
        zoomToFit: () => {
          if (!paneVisible(useStore.getState().panels, "clipEditor")) return false;
          const st = stateRef.current;
          if (!st.clip || !st.asset || st.asset.missing) return false;
          viewRef.current = fitView(st.clip, Math.max(1, sizeRef.current.width));
          schedule();
          return true;
        },
      }),
    [schedule, fitView],
  );

  /* ------------------------------------------------------- toolbar commands */

  // Normalize target: peak over the audible range from the exact lod-0 buckets
  const normGain = useMemo((): number | null => {
    if (!clip || !lod0 || !asset || asset.missing) return null;
    const spb = Math.max(1, lod0.samplesPerBucket);
    const ch = Math.max(1, lod0.channels);
    const nb = lod0.numBuckets;
    if (nb <= 0) return null;
    const b0 = clamp(Math.floor(clip.srcOffsetSamples / spb), 0, nb - 1);
    const b1 = clamp(Math.ceil((clip.srcOffsetSamples + clip.lengthSamples) / spb) - 1, 0, nb - 1);
    let peak = 0;
    for (let b = b0; b <= b1; b++) {
      for (let cc = 0; cc < ch; cc++) {
        const idx = (b * ch + cc) * 2;
        const mn = Math.abs(lod0.data[idx]);
        const mx = Math.abs(lod0.data[idx + 1]);
        if (mn > peak) peak = mn;
        if (mx > peak) peak = mx;
      }
    }
    peak /= 127;
    if (!(peak > 0)) return null;
    return Math.min(1 / peak, MAX_NORM_GAIN);
  }, [clip, lod0, asset]);

  const normTitle = !asset
    ? "No audio asset"
    : asset.missing
      ? "Audio file is missing"
      : !lod0
        ? "Waveform peaks are still loading…"
        : normGain === null
          ? "Clip is silent — nothing to normalize"
          : `Set gain so the peak hits 0 dBFS (${(20 * Math.log10(normGain)).toFixed(1)} dB, capped at +24)`;

  // Split target beat (absolute timeline beats), null disables the button
  const splitBeat = useMemo((): number | null => {
    if (!project || !clip || !asset || asset.missing || cursorSmp === null) return null;
    const off = clip.srcOffsetSamples;
    if (cursorSmp <= off + 1 || cursorSmp >= off + clip.lengthSamples - 1) return null;
    const startSec = beatsToSeconds(clip.startBeat, project.tempoMap);
    return secondsToBeats(startSec + (cursorSmp - off) / sr, project.tempoMap);
  }, [project, clip, asset, cursorSmp, sr]);

  /* ---------------------------------------------------------- context menu */

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    e.preventDefault();
    const c = stateRef.current.clip;
    if (!c) return;
    const noFades = c.fadeInSec <= 0 && c.fadeOutSec <= 0;
    openContextMenu(e.clientX, e.clientY, [
      {
        label: "Split at Cursor",
        icon: "split",
        disabled: splitBeat === null,
        title:
          splitBeat === null
            ? "Click in the waveform to set the split cursor"
            : "Split the clip at the cursor",
        onClick: () => {
          if (splitBeat !== null) fire(splitClips([c.id], splitBeat));
        },
      },
      {
        label: "Mute Clip",
        checked: Boolean(c.muted),
        onClick: () => fire(setClip(c.id, { muted: !c.muted })),
      },
      {
        label: "Rename…",
        icon: "pencil",
        onClick: () => setRenameAt({ x: e.clientX, y: e.clientY }),
      },
      "separator",
      {
        label: "Reset Gain",
        disabled: c.gain === 1,
        title: c.gain === 1 ? "Gain is already 0 dB" : "Set clip gain back to 0 dB",
        onClick: () => fire(setClip(c.id, { gain: 1 })),
      },
      {
        label: "Clear Fades",
        disabled: noFades,
        title: noFades ? "No fades set" : "Remove the fade-in and fade-out",
        onClick: () => fire(setClip(c.id, { fadeInSec: 0, fadeOutSec: 0 })),
      },
    ]);
  };

  /* ------------------------------------------------------------------ render */

  const focusPane = () => useStore.getState().setFocusedPane("clipEditor");
  const isKeyTarget = useIsKeyTarget("clipEditor");

  if (!project || !clip) {
    return (
      <div
        className="ce-root ce-empty col"
        data-key-target={isKeyTarget || undefined}
        onPointerDownCapture={focusPane}
      >
        <Icon name="audioWave" />
        <div className="ce-empty-title">Double-click an audio clip</div>
        <div className="ce-empty-sub">
          …in the timeline (or use the Inspector&apos;s &ldquo;Open in Editor&rdquo;) to edit it here.
        </div>
      </div>
    );
  }

  const chipColor = clip.color ?? track?.color ?? "#888";
  const assetLabel = asset ? (asset.file.split(/[\\/]/).pop() ?? asset.file) : "(missing asset)";
  const lenSec = clip.lengthSamples / sr;
  const canFit = Boolean(asset && !asset.missing);

  return (
    <div className="ce-root" data-key-target={isKeyTarget || undefined} onPointerDownCapture={focusPane}>
      <div className="ce-toolbar">
        <span className="ce-clip-chip" style={{ background: chipColor }} />
        <span className="ce-clip-name ellipsis" title={clip.name}>
          {clip.name || "Audio"}
        </span>
        <span className="ce-asset-name dim ellipsis" title={asset?.originalPath ?? asset?.file}>
          {assetLabel}
        </span>
        {asset?.missing ? <span className="badge danger">missing</span> : null}

        <span className="ce-sep" />
        <span className="ce-lbl dim">Gain</span>
        <GainDbDrag
          gain={clip.gain}
          onDrag={(g) => {
            gainPreviewRef.current = g;
            transientParam("cmd/clip.set", { clipId: clip.id, patch: { gain: g } });
            schedule();
          }}
          onCommit={(g) => {
            gainPreviewRef.current = g;
            void commitParam("cmd/clip.set", { clipId: clip.id, patch: { gain: g } });
            schedule();
          }}
          width={64}
          title="Clip gain (drag, double-click to type)"
        />
        <button
          type="button"
          className="btn"
          disabled={normGain === null}
          title={normTitle}
          onClick={() => {
            if (normGain !== null) fire(setClip(clip.id, { gain: normGain }));
          }}
        >
          Normalize
        </button>

        <span className="ce-sep" />
        <span className="ce-lbl dim">Fade in</span>
        <SecondsDrag
          value={clip.fadeInSec}
          max={lenSec}
          width={56}
          title="Fade-in (seconds)"
          onDrag={(v) => {
            fadePreviewRef.current.fadeIn = v;
            transientParam("cmd/clip.set", { clipId: clip.id, patch: { fadeInSec: v } });
            schedule();
          }}
          onCommit={(v) => {
            fadePreviewRef.current.fadeIn = v;
            void commitParam("cmd/clip.set", { clipId: clip.id, patch: { fadeInSec: v } });
            schedule();
          }}
        />
        <span className="ce-lbl dim">Fade out</span>
        <SecondsDrag
          value={clip.fadeOutSec}
          max={lenSec}
          width={56}
          title="Fade-out (seconds)"
          onDrag={(v) => {
            fadePreviewRef.current.fadeOut = v;
            transientParam("cmd/clip.set", { clipId: clip.id, patch: { fadeOutSec: v } });
            schedule();
          }}
          onCommit={(v) => {
            fadePreviewRef.current.fadeOut = v;
            void commitParam("cmd/clip.set", { clipId: clip.id, patch: { fadeOutSec: v } });
            schedule();
          }}
        />

        <span className="ce-sep" />
        <button
          type="button"
          className="btn"
          disabled={splitBeat === null}
          title={
            splitBeat === null
              ? "Click in the waveform to set the split cursor"
              : "Split the clip at the cursor"
          }
          onClick={() => {
            if (splitBeat !== null) fire(splitClips([clip.id], splitBeat));
          }}
        >
          <Icon name="split" size={13} />
          Split at Cursor
        </button>
        {cursorSmp !== null ? (
          <span className="ce-cursor mono dim" title="Cursor position from clip start">
            {((cursorSmp - clip.srcOffsetSamples) / sr).toFixed(3)} s
          </span>
        ) : null}

        <span className="grow" />
        <button
          type="button"
          className="btn"
          disabled={!canFit}
          title="Zoom to fit the clip"
          onClick={() => {
            fitForRef.current = null; // next draw refits
            schedule();
          }}
        >
          <Icon name="zoomOut" size={13} />
          Fit
        </button>
      </div>

      <div className="ce-wave">
        <canvas
          ref={ref}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={onContextMenu}
        />
      </div>
      {renameAt && (
        <FloatingInput
          x={renameAt.x}
          y={renameAt.y}
          width={160}
          initial={clip.name}
          placeholder="Clip name"
          onCommit={(name) => {
            setRenameAt(null);
            const trimmed = name.trim();
            if (trimmed && trimmed !== clip.name) fire(setClip(clip.id, { name: trimmed }));
          }}
          onCancel={() => setRenameAt(null)}
        />
      )}
    </div>
  );
}
