/**
 * Minimap (U1) — bird's-eye strip of the whole arrangement, above the ruler.
 *
 * Every track is a thin row; clips render at project scale in their track colors.
 * The translucent brush is the visible beat range: drag it to scroll, click anywhere
 * to center the view there. A playhead line animates via rAF while playing.
 *
 * Rendering: clip content is cached in an offscreen canvas (rebuilt on project /
 * size / theme changes); the per-frame pass just blits the cache and draws the
 * brush + playhead on top. Toggled by View → Minimap (panels.minimap, persisted).
 */

import React, { useEffect, useMemo, useRef } from "react";
import { transportBus, useStore } from "../../store/store";
import type { TransportEvent } from "../../protocol/types";
import { isMidiClip } from "../../protocol/types";
import { useCanvas, useRafLoop } from "../../lib/canvas";
import { miniBeatX, miniRowH, miniScrollTo } from "../../lib/vizMath";
import { useThemeName } from "../../lib/theme";
import { noteManualScroll } from "../../lib/followSuspend";
import { bpmAtBeat } from "../../lib/time";
import { clamp, clipLengthBeats, contentBeats, themeVar, withAlpha } from "./layout";

export const MINIMAP_H = 36;

export interface MinimapProps {
  /** Width of the clip-canvas viewport in px (drives the brush width). */
  viewW: number;
}

export default function Minimap({ viewW }: MinimapProps) {
  const project = useStore((s) => s.project);
  const viewport = useStore((s) => s.viewport);
  const setViewport = useStore((s) => s.setViewport);
  const playing = useStore((s) => s.transport.state !== "stopped");
  const theme = useThemeName();

  const totalBeats = Math.max(1, contentBeats(project));

  const stRef = useRef({ project, viewport, viewW, totalBeats });
  stRef.current = { project, viewport, viewW, totalBeats };

  const cacheRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const drawRef = useRef<() => void>(() => undefined);

  const { ref, canvasRef, ctxRef } = useCanvas((_ctx, sz) => {
    sizeRef.current = { w: sz.width, h: sz.height };
    cacheRef.current = null; // size changed — rebuild the content cache
    drawRef.current();
  });

  const transportRef = useRef<{ ev: TransportEvent; at: number } | null>(
    transportBus.last ? { ev: transportBus.last, at: performance.now() } : null,
  );
  useEffect(
    () =>
      transportBus.subscribe((ev) => {
        transportRef.current = { ev, at: performance.now() };
        if (ev.state === "stopped") drawRef.current();
      }),
    [],
  );

  /* ---- content cache: rows of clip rects at project scale ---- */
  const buildCache = (): HTMLCanvasElement | null => {
    const { w, h } = sizeRef.current;
    const { project: proj, totalBeats: total } = stRef.current;
    if (w <= 0 || h <= 0) return null;
    const c = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = themeVar("--bg-sunken");
    ctx.fillRect(0, 0, w, h);
    if (!proj) return c;

    /* song-strip band (UI_IMPROVE.md §1.3A): marker regions as labeled colored
       bands along the top, so the minimap reads as Verse / Chorus / Bridge */
    const markers = [...proj.markers].sort((a, b) => a.beat - b.beat);
    const bandH = markers.length > 0 ? 11 : 0;
    if (bandH > 0) {
      ctx.font = "8px Inter, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      markers.forEach((m, i) => {
        const x0 = miniBeatX(m.beat, total, w);
        const x1 = i + 1 < markers.length ? miniBeatX(markers[i + 1].beat, total, w) : w;
        const col = m.color || themeVar("--accent");
        ctx.fillStyle = withAlpha(col, 0.28);
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), bandH);
        ctx.fillStyle = withAlpha(col, 0.9);
        ctx.fillRect(x0, 0, 1, bandH);
        if (x1 - x0 >= 22 && m.name) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + 2, 0, x1 - x0 - 4, bandH);
          ctx.clip();
          ctx.fillStyle = themeVar("--text");
          ctx.fillText(m.name, x0 + 4, bandH / 2 + 0.5);
          ctx.restore();
        }
      });
      ctx.strokeStyle = themeVar("--border");
      ctx.beginPath();
      ctx.moveTo(0, bandH + 0.5);
      ctx.lineTo(w, bandH + 0.5);
      ctx.stroke();
    }

    const tracks = proj.tracks;
    const rowH = miniRowH(tracks.length, h - bandH);
    const gap = rowH > 3 ? 1 : 0;
    tracks.forEach((t, i) => {
      const y = 1 + bandH + i * rowH;
      for (const clip of t.clips) {
        const len = isMidiClip(clip)
          ? clip.lengthBeats
          : clipLengthBeats(clip, proj.tempoMap, proj.sampleRate);
        const x0 = miniBeatX(clip.startBeat, total, w);
        const x1 = miniBeatX(clip.startBeat + len, total, w);
        ctx.fillStyle = withAlpha(clip.color || t.color || themeVar("--accent"), clip.muted ? 0.3 : 0.85);
        ctx.fillRect(x0, y, Math.max(1, x1 - x0), Math.max(1, rowH - gap));
      }
    });
    return c;
  };

  const draw = (): void => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { w, h } = sizeRef.current;
    if (w <= 0 || h <= 0) return;
    if (!cacheRef.current) cacheRef.current = buildCache();
    ctx.clearRect(0, 0, w, h);
    if (cacheRef.current) ctx.drawImage(cacheRef.current, 0, 0, w, h);

    const { viewport: v, viewW: vw, totalBeats: total, project: proj } = stRef.current;

    // brush = visible beat range
    if (vw > 0) {
      const bx0 = miniBeatX(v.scrollX / v.zoomX, total, w);
      const bx1 = miniBeatX((v.scrollX + vw) / v.zoomX, total, w);
      ctx.fillStyle = withAlpha(themeVar("--accent"), 0.14);
      ctx.fillRect(bx0, 0, Math.max(2, bx1 - bx0), h);
      ctx.strokeStyle = withAlpha(themeVar("--accent"), 0.8);
      ctx.lineWidth = 1;
      ctx.strokeRect(bx0 + 0.5, 0.5, Math.max(2, bx1 - bx0) - 1, h - 1);
    }

    // playhead
    const l = transportRef.current;
    if (l && proj) {
      let beat = l.ev.beat;
      if (l.ev.state !== "stopped") {
        const dt = Math.min(0.25, (performance.now() - l.at) / 1000);
        beat += dt * (bpmAtBeat(beat, proj.tempoMap) / 60);
      }
      const x = miniBeatX(beat, total, w);
      ctx.strokeStyle = themeVar("--playhead");
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
    }
  };
  drawRef.current = draw;

  useRafLoop(() => drawRef.current(), playing);

  // content changes (project edits / theme switch) invalidate the cache
  useMemo(() => {
    cacheRef.current = null;
  }, [project, theme]);
  useEffect(() => {
    draw();
  });

  /* ---- navigation: click centers, drag scrubs ---- */
  const dragRef = useRef(false);
  const navTo = (clientX: number): void => {
    const el = canvasRef.current;
    if (!el) return;
    const { viewport: v, viewW: vw, totalBeats: total } = stRef.current;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || vw <= 0) return;
    noteManualScroll();
    setViewport({
      scrollX: miniScrollTo(clamp(clientX - r.left, 0, r.width), total, r.width, v.zoomX, vw),
    });
  };

  return (
    <canvas
      ref={ref}
      className="tl-minimap"
      style={{ height: MINIMAP_H }}
      title="Minimap — click or drag to navigate"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = true;
        navTo(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragRef.current) navTo(e.clientX);
      }}
      onPointerUp={(e) => {
        dragRef.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      }}
    />
  );
}
