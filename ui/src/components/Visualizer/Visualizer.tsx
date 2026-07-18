/**
 * Visualizer (bottom-dock tab, pop-out capable) — performance eye candy driven
 * entirely by data the UI already has:
 *
 *   Notes — Synthesia-style falling notes: every MIDI clip's notes stream toward a
 *   keyboard strip, colored by track, with additive glow + motion trails; the strip
 *   lights active pitches and each track's live RMS (metersBus) drives glow.
 *
 *   Stage — hand-rolled WebGL (stage3d.ts): one lit 3D bar per audio-role track on a
 *   floor grid, orbiting camera, heights driven by smoothed live levels. Falls back
 *   to 2D bars when WebGL is unavailable.
 *
 * Playhead comes from transportBus with the same extrapolation the other panes use;
 * both modes animate on their own window's rAF clock (pop-out safe).
 */

import React, { useEffect, useMemo, useRef } from "react";
import { metersBus, transportBus, useStore } from "../../store/store";
import type { TransportEvent } from "../../protocol/types";
import { useCanvas, useRafLoop } from "../../lib/canvas";
import { usePrefState, oneOf } from "../../lib/prefs";
import { useThemeName } from "../../lib/theme";
import { bpmAtBeat } from "../../lib/time";
import {
  buildNoteEvents,
  eventsInWindow,
  pitchRange,
  smoothLevel,
  stageLayout,
  vizTracks,
} from "../../lib/vizMath";
import { hexToRgb, themeVar } from "../Timeline/layout";
import { Icon } from "../common/icons";
import { Tabs } from "../common/Tabs";
import { createStageRenderer, type StageRenderer } from "./stage3d";
import "./visualizer.css";

const LOOKAHEAD_BEATS = 8;
const KEYS_H = 26;

type VizMode = "notes" | "stage";

/** Smoothed playhead beat from transportBus (shared by both modes). */
function usePlayhead() {
  const ref = useRef<{ ev: TransportEvent; at: number } | null>(
    transportBus.last ? { ev: transportBus.last, at: performance.now() } : null,
  );
  useEffect(
    () =>
      transportBus.subscribe((ev) => {
        ref.current = { ev, at: performance.now() };
      }),
    [],
  );
  return (tempoLookup: (beat: number) => number): { beat: number; playing: boolean } => {
    const l = ref.current;
    if (!l) return { beat: 0, playing: false };
    let beat = l.ev.beat;
    const playing = l.ev.state !== "stopped";
    if (playing) {
      const dt = Math.min(0.25, (performance.now() - l.at) / 1000);
      beat += dt * (tempoLookup(beat) / 60);
    }
    return { beat, playing };
  };
}

/** Track RMS (0..1) from the last meters event. */
function trackRms(trackId: number): number {
  const lv = metersBus.last?.tracks[String(trackId)];
  if (!lv) return 0;
  return ((lv[2] ?? 0) + (lv[3] ?? lv[2] ?? 0)) / 2;
}

export default function Visualizer() {
  const project = useStore((s) => s.project);
  const connected = useStore((s) => s.connected);
  const [mode, setMode] = usePrefState<VizMode>("viz.mode", "notes", oneOf("notes", "stage"));

  if (!project) {
    return (
      <div className="viz-root viz-empty">
        <Icon name="power" size={28} />
        <div className="dim">{connected ? "No project loaded" : "Engine disconnected"}</div>
      </div>
    );
  }
  return (
    <div className="viz-root">
      <div className="viz-toolbar">
        <Tabs
          tabs={[
            { id: "notes", label: "Notes" },
            { id: "stage", label: "Stage" },
          ]}
          active={mode}
          onChange={(id) => setMode(id as VizMode)}
        />
        <span className="grow" />
        <span className="dim viz-hint">
          {mode === "notes"
            ? "Falling notes — colors per track, glow follows the mix"
            : "Live levels on a 3D stage"}
        </span>
      </div>
      {mode === "notes" ? <NotesFall /> : <Stage3D />}
    </div>
  );
}

/* ============================================================================
 * Notes mode — falling notes over a lit keyboard strip
 * ========================================================================= */

function NotesFall() {
  const project = useStore((s) => s.project)!;
  const theme = useThemeName();

  const tracks = useMemo(() => vizTracks(project), [project]);
  const events = useMemo(() => buildNoteEvents(project), [project]);
  const range = useMemo(() => pitchRange(events), [events]);

  const stRef = useRef({ project, tracks, events, range });
  stRef.current = { project, tracks, events, range };

  const sizeRef = useRef({ w: 0, h: 0 });
  const { ref, canvasRef, ctxRef } = useCanvas((_ctx, sz) => {
    sizeRef.current = { w: sz.width, h: sz.height };
  });
  const playhead = usePlayhead();
  const glowRef = useRef<number[]>([]); // per-track smoothed level
  const lastTsRef = useRef(0);

  const draw = (dtMs: number): void => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { w, h } = sizeRef.current;
    if (w <= 0 || h <= 0) return;
    const { events: evs, range: rg, tracks: trs, project: proj } = stRef.current;
    const { beat } = playhead((b) => bpmAtBeat(b, proj.tempoMap));

    // per-track glow follows the live RMS
    const glow = glowRef.current;
    for (let i = 0; i < trs.length; i++) {
      glow[i] = smoothLevel(glow[i] ?? 0, Math.min(1, trackRms(trs[i].id) * 1.6), dtMs);
    }

    const laneW = w / (rg.hi - rg.lo + 1);
    const fallH = h - KEYS_H;
    const yOf = (b: number): number => fallH - ((b - beat) / LOOKAHEAD_BEATS) * fallH;

    // trails: translucent bg wash instead of a hard clear
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = themeVar("--bg-sunken");
    ctx.globalAlpha = 0.32;
    ctx.fillRect(0, 0, w, fallH);
    ctx.globalAlpha = 1;

    // beat grid line at the "now" edge
    ctx.fillStyle = themeVar("--border");
    ctx.fillRect(0, fallH - 1, w, 1);

    const active = new Map<number, string>(); // pitch → color of a sounding note
    ctx.globalCompositeOperation = "lighter";
    for (const e of eventsInWindow(evs, beat - 1, beat + LOOKAHEAD_BEATS)) {
      const x = (e.pitch - rg.lo) * laneW;
      const y1 = yOf(e.beat);
      const y0 = yOf(e.beat + e.lengthBeats);
      const sounding = e.beat <= beat && beat < e.beat + e.lengthBeats;
      if (sounding) active.set(e.pitch, trs[e.trackIndex].color);
      const [r, g, b] = hexToRgb(trs[e.trackIndex].color);
      const level = glow[e.trackIndex] ?? 0;
      const a = (sounding ? 0.95 : 0.45 + 0.25 * (e.velocity / 127)) * (0.75 + 0.25 * level);
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      const pad = Math.max(0.5, laneW * 0.12);
      const top = Math.max(-8, Math.min(y0, y1));
      const bot = Math.min(fallH, Math.max(y0, y1));
      if (bot <= 0 || top >= fallH) continue;
      ctx.fillRect(x + pad, top, laneW - 2 * pad, Math.max(2, bot - top));
      if (sounding) {
        // additive glow burst at the now line, scaled by the track's live level
        const gh = 10 + 26 * level;
        const grad = ctx.createLinearGradient(0, fallH - gh, 0, fallH);
        grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},${0.30 + 0.45 * level})`);
        ctx.fillStyle = grad;
        ctx.fillRect(x - laneW, fallH - gh, laneW * 3, gh);
      }
    }
    ctx.globalCompositeOperation = "source-over";

    // keyboard strip
    ctx.fillStyle = themeVar("--panel");
    ctx.fillRect(0, fallH, w, KEYS_H);
    for (let p = rg.lo; p <= rg.hi; p++) {
      const x = (p - rg.lo) * laneW;
      const black = [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
      ctx.fillStyle = active.has(p)
        ? active.get(p)!
        : black
          ? themeVar("--groove")
          : themeVar("--panel2");
      ctx.fillRect(x + 0.5, fallH + 1, Math.max(1, laneW - 1), KEYS_H - 2);
    }
  };

  useRafLoop(
    (dt) => {
      lastTsRef.current += dt;
      draw(dt);
    },
    true,
    canvasRef.current?.ownerDocument.defaultView ?? window,
  );

  // theme switch → hard clear so old-theme trails don't linger
  useEffect(() => {
    const ctx = ctxRef.current;
    const { w, h } = sizeRef.current;
    if (ctx && w > 0) ctx.clearRect(0, 0, w, h);
  }, [theme, ctxRef]);

  return <canvas ref={ref} className="viz-canvas" />;
}

/* ============================================================================
 * Stage mode — WebGL bars (2D fallback)
 * ========================================================================= */

/** Tracks with an audio role (their meters exist): everything but folders. */
function stageTracks(project: NonNullable<ReturnType<typeof useStore.getState>["project"]>) {
  return project.tracks.filter((t) => t.kind !== "folder");
}

function Stage3D() {
  const project = useStore((s) => s.project)!;
  const theme = useThemeName();

  const tracks = useMemo(() => stageTracks(project), [project]);
  const layout = useMemo(() => stageLayout(tracks.length), [tracks.length]);
  const stRef = useRef({ tracks, layout });
  stRef.current = { tracks, layout };

  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const glFailedRef = useRef(false);
  const levelsRef = useRef<number[]>([]);
  const ctx2dRef = useRef<CanvasRenderingContext2D | null>(null);

  const setCanvas = (el: HTMLCanvasElement | null): void => {
    rendererRef.current?.dispose();
    rendererRef.current = null;
    ctx2dRef.current = null;
    canvasElRef.current = el;
    if (el) {
      rendererRef.current = createStageRenderer(el);
      if (!rendererRef.current) {
        glFailedRef.current = true;
        ctx2dRef.current = el.getContext("2d");
      }
    }
  };

  useEffect(() => () => setCanvas(null), []);

  const frame = (dtMs: number, timeMs: number): void => {
    const el = canvasElRef.current;
    if (!el) return;
    // dpr-aware backing store (the canvas fills its flex parent via CSS)
    const rect = el.getBoundingClientRect();
    const dpr = (el.ownerDocument.defaultView ?? window).devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (el.width !== bw || el.height !== bh) {
      el.width = bw;
      el.height = bh;
    }

    const { tracks: trs, layout: lay } = stRef.current;
    const levels = levelsRef.current;
    for (let i = 0; i < trs.length; i++) {
      levels[i] = smoothLevel(levels[i] ?? 0, Math.min(1, trackRms(trs[i].id) * 1.5), dtMs);
    }

    const bg = hexToRgb(themeVar("--bg-sunken")).map((v) => v / 255) as [number, number, number];
    const grid = hexToRgb(themeVar("--border")).map((v) => v / 255) as [number, number, number];

    const r3d = rendererRef.current;
    if (r3d) {
      r3d.render({
        bars: lay.map((b, i) => {
          const [r, g, bl] = hexToRgb(trs[i].color || "#5b8cff");
          const lv = levels[i] ?? 0;
          return {
            x: b.x,
            z: b.z,
            h: 0.12 + 3.6 * Math.pow(lv, 0.7),
            color: [r / 255, g / 255, bl / 255],
            emissive: lv,
          };
        }),
        timeMs,
        bg,
        grid,
      });
      return;
    }

    // 2D fallback: plain vertical bars
    const ctx = ctx2dRef.current;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    ctx.fillStyle = themeVar("--bg-sunken");
    ctx.fillRect(0, 0, w, h);
    const bw2 = Math.min(48, (w - 20) / Math.max(1, trs.length));
    trs.forEach((t, i) => {
      const lv = levels[i] ?? 0;
      const bh2 = (h - 30) * Math.pow(lv, 0.7);
      ctx.fillStyle = t.color || themeVar("--accent");
      ctx.fillRect(10 + i * bw2 + 2, h - 10 - bh2, bw2 - 4, bh2);
    });
  };

  useRafLoop(
    (dt, t) => frame(dt, t),
    true,
    canvasElRef.current?.ownerDocument.defaultView ?? window,
  );

  // theme dep keeps colors fresh (themeVar re-read per frame anyway; this re-renders
  // so a popped-out stage picks up data-theme immediately)
  void theme;

  return <canvas ref={setCanvas} className="viz-canvas" />;
}
