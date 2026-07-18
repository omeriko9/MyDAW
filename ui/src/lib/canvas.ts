/**
 * lib/canvas.ts — canvas plumbing shared by all canvas-rendered views (owned by F4).
 *
 * - useCanvas(): devicePixelRatio-aware <canvas> sizing via ResizeObserver. The backing
 *   store is sized in device pixels and the context transform is set to dpr, so ALL
 *   drawing code works in CSS pixels. Returns a callback ref plus ctx/size.
 * - rafLoop(fn, win?): shared requestAnimationFrame loop PER WINDOW. Auto-pauses while
 *   that window is hidden, auto-stops when the last subscriber leaves. Canvases portaled
 *   into a popped-out window pass their own window (canvas.ownerDocument.defaultView) so
 *   they keep animating while the main tab is hidden. useRafLoop() is the hook form.
 * - Crisp-line + roundRect drawing helpers (1px lines on the half-pixel grid).
 * - TRACK_COLORS: the 12-color track palette (mirrors --track-color-1..12 in theme.css).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { THEME_EVENT } from "./theme";

/* ============================================================================
 * Track palette (keep in sync with theme.css --track-color-*)
 * ========================================================================= */

export const TRACK_COLORS: readonly string[] = [
  "#e25d5d", // 1 red
  "#e2814d", // 2 orange
  "#d8a14a", // 3 amber
  "#bdb84f", // 4 yellow
  "#8fc457", // 5 green
  "#56c596", // 6 mint
  "#4dc3cd", // 7 cyan
  "#54a3e8", // 8 blue
  "#7a82f0", // 9 indigo
  "#a06ee8", // 10 purple
  "#d165d6", // 11 magenta
  "#e0639c", // 12 pink
];

/** Deterministic palette pick (e.g. by track index or id). */
export function trackColor(index: number): string {
  const i = Math.abs(Math.trunc(index)) % TRACK_COLORS.length;
  return TRACK_COLORS[i];
}

/* ============================================================================
 * useCanvas
 * ========================================================================= */

export interface CanvasSize {
  /** CSS-pixel width of the canvas element. */
  width: number;
  /** CSS-pixel height of the canvas element. */
  height: number;
  /** devicePixelRatio applied to the backing store / transform. */
  dpr: number;
}

export interface UseCanvas {
  /** Attach to the <canvas ref={ref}>. Size the element with CSS (e.g. width/height 100%). */
  ref: (el: HTMLCanvasElement | null) => void;
  /** The element, once mounted. */
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  /** 2D context with dpr transform applied — draw in CSS pixels. Null before mount. */
  ctxRef: React.MutableRefObject<CanvasRenderingContext2D | null>;
  /** Same as ctxRef.current at last render (state — triggers a re-render when ready). */
  ctx: CanvasRenderingContext2D | null;
  /** Current CSS-pixel size (state — updates on resize). {0,0} before mount. */
  size: CanvasSize;
}

/**
 * dpr-aware canvas hook. `onResize` (optional) is called synchronously whenever the
 * backing store was (re)allocated — redraw static content there. Animated consumers
 * can ignore it and just draw every frame via rafLoop.
 */
export function useCanvas(
  onResize?: (ctx: CanvasRenderingContext2D, size: CanvasSize) => void,
): UseCanvas {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const [state, setState] = useState<{ ctx: CanvasRenderingContext2D | null; size: CanvasSize }>({
    ctx: null,
    size: { width: 0, height: 0, dpr: 1 },
  });
  const sizeRef = useRef(state.size);

  const rescale = useCallback(() => {
    const el = canvasRef.current;
    const ctx = ctxRef.current;
    if (!el || !ctx) return;
    const rect = el.getBoundingClientRect();
    // The canvas may live in a popped-out window (portal) — read ITS devicePixelRatio,
    // not the main window's (monitors can differ).
    const dpr = (el.ownerDocument.defaultView ?? window).devicePixelRatio || 1;
    const w = Math.max(0, rect.width);
    const h = Math.max(0, rect.height);
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    const prev = sizeRef.current;
    if (el.width !== bw || el.height !== bh || prev.dpr !== dpr || prev.width !== w || prev.height !== h) {
      el.width = bw;
      el.height = bh;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size: CanvasSize = { width: w, height: h, dpr };
      sizeRef.current = size;
      setState({ ctx, size });
      onResizeRef.current?.(ctx, size);
    }
  }, []);

  const hostWinCleanupRef = useRef<(() => void) | null>(null);

  const ref = useCallback(
    (el: HTMLCanvasElement | null) => {
      if (roRef.current) {
        roRef.current.disconnect();
        roRef.current = null;
      }
      if (hostWinCleanupRef.current) {
        hostWinCleanupRef.current();
        hostWinCleanupRef.current = null;
      }
      canvasRef.current = el;
      if (el) {
        ctxRef.current = el.getContext("2d");
        const ro = new ResizeObserver(() => rescale());
        ro.observe(el);
        roRef.current = ro;
        // Canvas in a popped-out window: dpr changes (zoom / cross-monitor moves) fire
        // the POPUP's resize event, not the main window's — mirror the fallback below.
        const win = el.ownerDocument.defaultView;
        if (win && win !== window) {
          const onHostResize = () => rescale();
          win.addEventListener("resize", onHostResize);
          hostWinCleanupRef.current = () => {
            try {
              win.removeEventListener("resize", onHostResize);
            } catch {
              /* popup window already destroyed */
            }
          };
        }
        rescale();
      } else {
        ctxRef.current = null;
      }
    },
    [rescale],
  );

  // devicePixelRatio changes (browser zoom / moving between monitors) don't always fire
  // the ResizeObserver — re-check on window resize.
  useEffect(() => {
    const onWin = () => rescale();
    window.addEventListener("resize", onWin);
    return () => window.removeEventListener("resize", onWin);
  }, [rescale]);

  // Theme switch: size is unchanged but every resolved color is stale — invoke the
  // same redraw hook resize uses. (THEME_EVENT fires on the MAIN window; pop-out
  // panes share this JS context, so their canvases repaint too.)
  useEffect(() => {
    const onTheme = () => {
      const ctx = ctxRef.current;
      if (ctx) onResizeRef.current?.(ctx, sizeRef.current);
    };
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);

  return { ref, canvasRef, ctxRef, ctx: state.ctx, size: state.size };
}

/* ============================================================================
 * rafLoop — one shared RAF loop PER WINDOW, pauses while that window is hidden
 * ========================================================================= */

export type RafFn = (dtMs: number, timeMs: number) => void;

interface RafWinState {
  subs: Set<RafFn>;
  rafId: number;
  rafLast: number;
  /** visibilitychange restart listener (removed when the last subscriber leaves). */
  onVis: () => void;
}

// Loops are keyed by Window: panes portaled into a popped-out window must animate on
// THAT window's rAF clock — browsers stop servicing a hidden window's rAF, so the main
// tab being minimized would otherwise freeze a fully visible popup (and vice versa).
// Per-window loops also keep dt self-consistent: rAF timestamps are relative to each
// window's own timeOrigin, so frames from different windows must never share rafLast.
const rafWindows = new Map<Window, RafWinState>();

/** Treat a closed/destroyed popup as hidden — touching its document can throw. */
function rafHidden(win: Window): boolean {
  try {
    return win.closed || win.document.hidden;
  } catch {
    return true;
  }
}

function rafTick(win: Window, st: RafWinState, t: number): void {
  st.rafId = 0;
  if (st.subs.size === 0 || rafHidden(win)) return;
  const dt = st.rafLast > 0 ? Math.min(100, t - st.rafLast) : 16.7;
  st.rafLast = t;
  for (const fn of [...st.subs]) {
    try {
      fn(dt, t);
    } catch (err) {
      // A broken subscriber must not kill the shared loop.
      console.error("rafLoop subscriber threw:", err);
    }
  }
  if (st.subs.size > 0 && !rafHidden(win)) {
    st.rafId = win.requestAnimationFrame((t2) => rafTick(win, st, t2));
  }
}

function rafStart(win: Window, st: RafWinState): void {
  if (st.rafId === 0 && st.subs.size > 0 && !rafHidden(win)) {
    st.rafLast = 0; // fresh dt baseline (avoids a giant dt after resume)
    st.rafId = win.requestAnimationFrame((t) => rafTick(win, st, t));
  }
}

function rafStateFor(win: Window): RafWinState {
  let st = rafWindows.get(win);
  if (!st) {
    const created: RafWinState = {
      subs: new Set(),
      rafId: 0,
      rafLast: 0,
      onVis: () => rafStart(win, created),
    };
    win.document.addEventListener("visibilitychange", created.onVis);
    rafWindows.set(win, created);
    st = created;
  }
  return st;
}

/**
 * Subscribe `fn` to the shared animation loop of `win` (default: the main window).
 * Canvas consumers that may render into a popped-out window must pass that window
 * (`canvas.ownerDocument.defaultView`). Returns an unsubscribe function — safe to call
 * after the popup was closed (a dead window's pending frame simply never fires; the
 * loop entry is dropped here when the last subscriber leaves).
 */
export function rafLoop(fn: RafFn, win: Window = window): () => void {
  const st = rafStateFor(win);
  st.subs.add(fn);
  rafStart(win, st);
  return () => {
    st.subs.delete(fn);
    if (st.subs.size === 0 && rafWindows.get(win) === st) {
      rafWindows.delete(win);
      try {
        if (st.rafId !== 0) win.cancelAnimationFrame(st.rafId);
        win.document.removeEventListener("visibilitychange", st.onVis);
      } catch {
        /* popup window already destroyed */
      }
      st.rafId = 0;
    }
  };
}

/**
 * Hook form: runs `fn` every animation frame while `active`. `fn` may change freely.
 * Pass `win` for canvases that may live in a popped-out window — the effect
 * re-subscribes (with a fresh dt baseline) whenever the window identity changes.
 */
export function useRafLoop(fn: RafFn, active = true, win?: Window): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!active) return;
    return rafLoop((dt, t) => fnRef.current(dt, t), win);
  }, [active, win]);
}

/* ============================================================================
 * Drawing helpers (CSS-pixel space; assumes dpr transform from useCanvas)
 * ========================================================================= */

/** Snap a coordinate to the half-pixel grid so a 1px stroke lands on exactly one pixel row. */
export function crisp(v: number): number {
  return Math.round(v) + 0.5;
}

/** Stroke a crisp 1px horizontal line at y from x0..x1 (uses current strokeStyle). */
export function lineH(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  const cy = crisp(y);
  ctx.beginPath();
  ctx.moveTo(x0, cy);
  ctx.lineTo(x1, cy);
  ctx.stroke();
}

/** Stroke a crisp 1px vertical line at x from y0..y1 (uses current strokeStyle). */
export function lineV(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number): void {
  const cx = crisp(x);
  ctx.beginPath();
  ctx.moveTo(cx, y0);
  ctx.lineTo(cx, y1);
  ctx.stroke();
}

/** Path a rounded rectangle (clamps radius). Caller fills and/or strokes. */
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
