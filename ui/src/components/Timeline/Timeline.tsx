/**
 * Timeline (U1) — the arrangement view (App center). Composes the 220px DOM track-header
 * column, the Ruler (seek / loop / markers — already wired), the clip canvas, and a
 * playhead overlay canvas driven from transportBus (RAF only while playing).
 *
 * Owns the shared viewport (store.viewport: zoomX px/beat, zoomY, scrollX/Y px), the
 * row model (layout.computeRows — folder collapse + automation lane expansion via the
 * local automationUi store + live height-drag preview), wheel navigation (wheel =
 * v-scroll, shift = h-scroll, ctrl = h-zoom at cursor, alt = v-zoom) and the overlay
 * scrollbars.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import "./timeline.css";
import { transportBus, useStore } from "../../store/store";
import type { TransportEvent } from "../../protocol/types";
import Ruler from "./Ruler";
import TrackHeaders from "./TrackHeaders";
import ClipCanvas from "./ClipCanvas";
import Minimap, { MINIMAP_H } from "./Minimap";
import { useAutomationUi } from "./automationUi";
import { useIsKeyTarget } from "../common/paneFocus";
import { lineV, useCanvas, useRafLoop } from "../../lib/canvas";
import { noteManualScroll } from "../../lib/followSuspend";
import { followScrollX, shouldFollow } from "../../lib/followPlayhead";
import { REVEAL_BEAT_EVENT, type RevealBeatDetail } from "../../lib/reveal";
import { animateViewport, cancelViewportAnimation } from "../../lib/viewportAnim";
import NavigatorPill from "./NavigatorPill";
import { beatToPx, bpmAtBeat } from "../../lib/time";
import {
  MAX_ZOOM_X,
  MAX_ZOOM_Y,
  MIN_ZOOM_X,
  MIN_ZOOM_Y,
  RULER_H,
  clamp,
  computeRows,
  contentBeats,
  rowsBottom,
  themeVar,
  vScaleOf,
} from "./layout";

const EMPTY_SET: ReadonlySet<number> = new Set<number>();

/* ============================================================================
 * Playhead overlay — separate canvas, RAF only while playing (SPEC §9)
 * ========================================================================= */

function PlayheadOverlay() {
  const zoomX = useStore((s) => s.viewport.zoomX);
  const scrollX = useStore((s) => s.viewport.scrollX);
  const playing = useStore((s) => s.transport.state !== "stopped");
  const tempoMap = useStore((s) => s.project?.tempoMap);

  const stRef = useRef({ zoomX, scrollX, tempoMap });
  stRef.current = { zoomX, scrollX, tempoMap };

  const lastRef = useRef<{ ev: TransportEvent; at: number } | null>(
    transportBus.last ? { ev: transportBus.last, at: performance.now() } : null,
  );
  const sizeRef = useRef({ width: 0, height: 0 });
  const drawRef = useRef<() => void>(() => undefined);

  const { ref, ctxRef } = useCanvas((_ctx, sz) => {
    sizeRef.current = { width: sz.width, height: sz.height };
    drawRef.current();
  });

  const draw = (): void => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { width: w, height: h } = sizeRef.current;
    if (w <= 0 || h <= 0) return;
    ctx.clearRect(0, 0, w, h);
    const l = lastRef.current;
    if (!l) return;
    let beat = l.ev.beat;
    if (l.ev.state !== "stopped") {
      // light extrapolation between ~20 Hz transport events for a smooth playhead
      const dt = Math.min(0.25, (performance.now() - l.at) / 1000);
      beat += dt * (bpmAtBeat(beat, stRef.current.tempoMap ?? []) / 60);
    }
    const x = beatToPx(beat, { zoomX: stRef.current.zoomX, scrollX: stRef.current.scrollX });
    if (x < -1 || x > w + 1) return;
    ctx.strokeStyle = themeVar("--playhead");
    ctx.lineWidth = 1;
    lineV(ctx, x, 0, h);
  };
  drawRef.current = draw;

  useEffect(
    () =>
      transportBus.subscribe((ev) => {
        lastRef.current = { ev, at: performance.now() };
        // while playing the RAF loop redraws; otherwise (locate/stop) redraw here
        if (ev.state === "stopped") drawRef.current();
      }),
    [],
  );

  useRafLoop(() => drawRef.current(), playing);

  useEffect(() => {
    draw();
  });

  return <canvas ref={ref} className="tl-playhead-overlay" />;
}

/* ============================================================================
 * Overlay scrollbar
 * ========================================================================= */

interface ScrollbarProps {
  dir: "h" | "v";
  scroll: number;
  content: number;
  view: number;
  onScroll(v: number): void;
}

function Scrollbar({ dir, scroll, content, view, onScroll }: ScrollbarProps) {
  const [active, setActive] = useState(false);
  const dragRef = useRef<{ startPx: number; startScroll: number; trackPx: number } | null>(null);
  if (!(content > view + 1) || view <= 0) return null;

  const frac = Math.max(0.04, Math.min(1, view / content));
  const maxScroll = content - view;
  const pos = clamp(scroll / maxScroll, 0, 1);
  const thumbStyle: React.CSSProperties =
    dir === "h"
      ? { width: `${frac * 100}%`, left: `${pos * (1 - frac) * 100}%` }
      : { height: `${frac * 100}%`, top: `${pos * (1 - frac) * 100}%` };

  return (
    <div className={dir === "h" ? "tl-hscroll" : "tl-vscroll"}>
      <div
        className="tl-scroll-thumb"
        data-active={active ? "true" : undefined}
        style={thumbStyle}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const parent = e.currentTarget.parentElement;
          const r = parent ? parent.getBoundingClientRect() : { width: 0, height: 0 };
          dragRef.current = {
            startPx: dir === "h" ? e.clientX : e.clientY,
            startScroll: scroll,
            trackPx: (dir === "h" ? r.width : r.height) * (1 - frac),
          };
          setActive(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d || d.trackPx <= 0) return;
          const dpx = (dir === "h" ? e.clientX : e.clientY) - d.startPx;
          onScroll(clamp(d.startScroll + (dpx / d.trackPx) * maxScroll, 0, maxScroll));
        }}
        onPointerUp={(e) => {
          dragRef.current = null;
          setActive(false);
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
      />
    </div>
  );
}

/* ============================================================================
 * Timeline
 * ========================================================================= */

export default function Timeline() {
  const project = useStore((s) => s.project);
  const viewport = useStore((s) => s.viewport);
  const setViewport = useStore((s) => s.setViewport);
  const showMinimap = useStore((s) => s.panels.minimap);
  const isKeyTarget = useIsKeyTarget("timeline");

  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(EMPTY_SET);
  const [heightOverride, setHeightOverride] = useState<{ trackId: number; height: number } | null>(
    null,
  );
  const [view, setView] = useState({ w: 0, h: 0 });

  const autoExpanded = useAutomationUi((s) => s.expanded);
  const extraLanes = useAutomationUi((s) => s.extraLanes);

  const vScale = vScaleOf(viewport.zoomY);
  const rows = useMemo(
    () =>
      computeRows(project, {
        collapsedFolders: collapsed,
        autoExpanded,
        extraLanes,
        heightOverride,
        vScale,
      }),
    [project, collapsed, autoExpanded, extraLanes, heightOverride, vScale],
  );

  const cBeats = contentBeats(project);
  const contentW = cBeats * viewport.zoomX;
  const contentH = rowsBottom(rows) + 96;

  const mainRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const extentRef = useRef({ cBeats, contentH, viewW: 0, viewH: 0 });
  extentRef.current = { cBeats, contentH, viewW: view.w, viewH: view.h };

  // measure the canvas viewport (drives scrollbar math + clamping)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setView({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep scroll within content when extents shrink (zoom-out, track removal, …)
  useEffect(() => {
    if (view.w <= 0 || view.h <= 0) return;
    const maxX = Math.max(0, contentW - view.w);
    const maxY = Math.max(0, contentH - view.h);
    const patch: { scrollX?: number; scrollY?: number } = {};
    if (viewport.scrollX > maxX) patch.scrollX = maxX;
    if (viewport.scrollY > maxY) patch.scrollY = maxY;
    if (patch.scrollX !== undefined || patch.scrollY !== undefined) setViewport(patch);
  }, [contentW, contentH, view.w, view.h, viewport.scrollX, viewport.scrollY, setViewport]);

  // "J" follow-playhead: page-jump the view whenever the playhead leaves
  // [scrollX + 5% w, scrollX + 80% w] — during playback AND on locate while stopped
  // (transportBus fires for both). Page jumps only, never per-frame scrolling — and the
  // jump stands down while the user navigates: every manual scroll write (pan / wheel /
  // scrollbar / zoom anchor) refreshes the followSuspend timestamp, active gestures keep
  // refreshing it, and the follow re-engages ~1 s after the last manual write (at the
  // next out-of-band transport tick).
  useEffect(
    () =>
      transportBus.subscribe((ev) => {
        const s = useStore.getState();
        if (!shouldFollow(s.followPlayhead)) return;
        const ex = extentRef.current;
        const v = s.viewport;
        const scrollX = followScrollX({
          x: ev.beat * v.zoomX,
          scrollX: v.scrollX,
          viewW: ex.viewW,
          contentW: ex.cBeats * v.zoomX,
        });
        if (scrollX !== null) s.setViewport({ scrollX });
      }),
    [],
  );

  // Reveal requests (command palette "go to bar / marker") — bring a beat into view
  // even when follow-playhead is off. No-op when the target is already comfortably
  // visible; otherwise land it 35% in from the left edge.
  useEffect(() => {
    const onReveal = (e: Event): void => {
      const { beat } = (e as CustomEvent<RevealBeatDetail>).detail;
      const s = useStore.getState();
      const ex = extentRef.current;
      const v = s.viewport;
      const x = beat * v.zoomX;
      if (x >= v.scrollX + ex.viewW * 0.05 && x <= v.scrollX + ex.viewW * 0.85) return;
      const maxX = Math.max(0, ex.cBeats * v.zoomX - ex.viewW);
      animateViewport({ scrollX: Math.min(maxX, Math.max(0, x - ex.viewW * 0.35)) });
    };
    window.addEventListener(REVEAL_BEAT_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_BEAT_EVENT, onReveal);
  }, []);

  // wheel navigation — native non-passive listener (ctrl+wheel must preventDefault)
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      cancelViewportAnimation(); // manual navigation owns the viewport outright
      const s = useStore.getState();
      const v = s.viewport;
      const ex = extentRef.current;
      const right = rightRef.current;
      const rRect = right ? right.getBoundingClientRect() : { left: 0, top: 0 };
      const maxScrollX = (zoomX: number): number => Math.max(0, ex.cBeats * zoomX - ex.viewW);
      const maxScrollY = Math.max(0, ex.contentH - ex.viewH);

      if (e.ctrlKey || e.metaKey) {
        // horizontal zoom anchored at the cursor
        e.preventDefault();
        const cx = Math.max(0, e.clientX - rRect.left);
        const zoomX = clamp(v.zoomX * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM_X, MAX_ZOOM_X);
        if (zoomX === v.zoomX) return;
        const beatAt = (cx + v.scrollX) / v.zoomX;
        const scrollX = clamp(beatAt * zoomX - cx, 0, maxScrollX(zoomX));
        noteManualScroll(); // zoom anchor rewrites scrollX — suspend follow-playhead
        s.setViewport({ zoomX, scrollX });
      } else if (e.altKey) {
        // vertical zoom (track-height scale)
        e.preventDefault();
        const zoomY = clamp(v.zoomY * (e.deltaY < 0 ? 1.2 : 1 / 1.2), MIN_ZOOM_Y, MAX_ZOOM_Y);
        if (zoomY === v.zoomY) return;
        const cy = Math.max(0, e.clientY - rRect.top - RULER_H);
        const scale = vScaleOf(zoomY) / vScaleOf(v.zoomY);
        const scrollY = Math.max(0, (v.scrollY + cy) * scale - cy);
        s.setViewport({ zoomY, scrollY });
      } else if (e.shiftKey) {
        e.preventDefault();
        noteManualScroll(); // even a clamped-at-edge wheel signals manual navigation
        const dx = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        const scrollX = clamp(v.scrollX + dx, 0, maxScrollX(v.zoomX));
        if (scrollX !== v.scrollX) s.setViewport({ scrollX });
      } else {
        e.preventDefault();
        noteManualScroll();
        const patch: { scrollX?: number; scrollY?: number } = {};
        if (e.deltaX !== 0) patch.scrollX = clamp(v.scrollX + e.deltaX, 0, maxScrollX(v.zoomX));
        if (e.deltaY !== 0) patch.scrollY = clamp(v.scrollY + e.deltaY, 0, maxScrollY);
        if (
          (patch.scrollX !== undefined && patch.scrollX !== v.scrollX) ||
          (patch.scrollY !== undefined && patch.scrollY !== v.scrollY)
        ) {
          s.setViewport(patch);
        }
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className="tl-root"
      data-key-target={isKeyTarget || undefined}
      onPointerDownCapture={() => useStore.getState().setFocusedPane("timeline")}
    >
      <div className="tl-main" ref={mainRef}>
        <TrackHeaders
          rows={rows}
          scrollY={viewport.scrollY}
          topSpacerHeight={showMinimap ? MINIMAP_H : 0}
          collapsedFolders={collapsed}
          onToggleFolder={(id) =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onHeightPreview={setHeightOverride}
          vScale={vScale}
        />
        <div className="tl-right" ref={rightRef}>
          {showMinimap && <Minimap viewW={view.w} />}
          <Ruler />
          <div className="tl-canvas-wrap" ref={wrapRef}>
            <ClipCanvas rows={rows} />
            <PlayheadOverlay />
            {!project && (
              <div className="tl-empty-hint">No project — waiting for the engine…</div>
            )}
            <Scrollbar
              dir="h"
              scroll={viewport.scrollX}
              content={contentW}
              view={view.w}
              onScroll={(scrollX) => {
                noteManualScroll();
                cancelViewportAnimation();
                setViewport({ scrollX });
              }}
            />
            <Scrollbar
              dir="v"
              scroll={viewport.scrollY}
              content={contentH}
              view={view.h}
              onScroll={(scrollY) => {
                noteManualScroll();
                cancelViewportAnimation();
                setViewport({ scrollY });
              }}
            />
            {project && <NavigatorPill viewW={view.w} />}
          </div>
        </div>
      </div>
    </div>
  );
}
