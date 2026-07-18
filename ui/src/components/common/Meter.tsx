/**
 * Meter — canvas peak/RMS level meter (owned by F4).
 *
 * Pulls levels every animation frame via `getLevels(): [peakL, peakR, rmsL, rmsR]`
 * (linear 0..~1.4, per SPEC §5.4 event/meters; wire it to `metersBus.last`).
 * Only draws while on-screen (IntersectionObserver) and while its own window is
 * visible (per-window rafLoop — meters in a popped-out mixer keep running while the
 * main tab is hidden). Features: green/yellow/red zones (-60..+6 dB scale, yellow from -12,
 * red above 0 dB), ballistic peak fall, RMS bar, 1.2 s peak-hold line, clip latch
 * LED at the top — click the meter to reset it.
 */

import React, { useEffect, useRef, useState } from "react";
import { rafLoop, useCanvas } from "../../lib/canvas";
import { themeVar } from "../Timeline/layout";

export type MeterLevels = readonly [number, number, number, number]; // peakL, peakR, rmsL, rmsR

export interface MeterProps {
  /** Pulled once per frame. Return last-known levels (linear gain). */
  getLevels: () => MeterLevels | null | undefined;
  /** CSS size; defaults fill the parent. */
  width?: number | string;
  height?: number | string;
  /** Draw left-to-right instead of bottom-up (e.g. transport master mini-meter). */
  horizontal?: boolean;
  /** 1 = mono (uses L only), 2 = stereo (default). */
  channels?: 1 | 2;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

const DB_MIN = -60;
const DB_MAX = 6;
const DB_SPAN = DB_MAX - DB_MIN;
const POS_YELLOW = (-12 - DB_MIN) / DB_SPAN; // -12 dB
const POS_RED = (0 - DB_MIN) / DB_SPAN; // 0 dB
const PEAK_FALL = 26 / DB_SPAN / 1000; // pos units per ms (~26 dB/s)
const RMS_FALL = 18 / DB_SPAN / 1000;
const HOLD_MS = 1200;
const HOLD_FALL = 14 / DB_SPAN / 1000;
const CLIP_LED = 4; // px

function levelToPos(linear: number): number {
  if (!(linear > 0)) return 0;
  const db = 20 * Math.log10(linear);
  return Math.min(1, Math.max(0, (db - DB_MIN) / DB_SPAN));
}

interface ChanState {
  peak: number; // displayed peak pos
  rms: number; // displayed rms pos
  hold: number; // hold pos
  holdAt: number; // timestamp the hold was set
  clip: boolean; // latched
}

export function Meter({
  getLevels,
  width,
  height,
  horizontal,
  channels = 2,
  className,
  style,
  title,
}: MeterProps) {
  const { ref, canvasRef, ctxRef, size } = useCanvas();
  const [visible, setVisible] = useState(false);
  const chans = useRef<ChanState[]>([
    { peak: 0, rms: 0, hold: 0, holdAt: 0, clip: false },
    { peak: 0, rms: 0, hold: 0, holdAt: 0, clip: false },
  ]);
  const getLevelsRef = useRef(getLevels);
  getLevelsRef.current = getLevels;

  // Pause drawing while scrolled off-screen.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries[0]?.isIntersecting ?? false));
    io.observe(el);
    return () => io.disconnect();
    // canvasRef.current is stable post-mount for this component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width > 0]);

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const propsRef = useRef({ horizontal: !!horizontal, channels });
  propsRef.current = { horizontal: !!horizontal, channels };

  useEffect(() => {
    if (!visible) return;
    // The meter canvas may live in a popped-out window (portal) — drive the animation
    // from ITS rAF clock, not the main window's (the main tab may be hidden/minimized
    // while the popup is fully visible). `visible` implies the canvas is mounted, so
    // the ref is populated by the time this effect runs.
    const win = canvasRef.current?.ownerDocument.defaultView ?? window;
    return rafLoop((dt, t) => {
      const ctx = ctxRef.current;
      const { width: w, height: h } = sizeRef.current;
      if (!ctx || w <= 0 || h <= 0) return;
      const { horizontal: horiz, channels: nch } = propsRef.current;

      const lv = getLevelsRef.current() ?? [0, 0, 0, 0];
      const cs = chans.current;
      for (let i = 0; i < nch; i++) {
        const c = cs[i];
        const peakIn = levelToPos(lv[i]);
        const rmsIn = levelToPos(lv[2 + i]);
        c.peak = Math.max(peakIn, c.peak - PEAK_FALL * dt);
        c.rms = Math.max(rmsIn, c.rms - RMS_FALL * dt);
        if (peakIn >= c.hold) {
          c.hold = peakIn;
          c.holdAt = t;
        } else if (t - c.holdAt > HOLD_MS) {
          c.hold = Math.max(c.peak, c.hold - HOLD_FALL * dt);
        }
        if (lv[i] >= 1.0) c.clip = true;
      }

      /* ---- draw ---- */
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = themeVar("--groove");
      ctx.fillRect(0, 0, w, h);

      const len = (horiz ? w : h) - CLIP_LED - 1; // bar travel
      const across = horiz ? h : w;
      const gap = nch === 2 ? 1 : 0;
      const barAcross = nch === 2 ? (across - gap) / 2 : across;

      const seg = (
        ci: number,
        from: number,
        to: number,
        color: string,
        alpha: number,
      ) => {
        if (to <= from) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        const a0 = ci * (barAcross + gap);
        if (horiz) ctx.fillRect(from * len, a0, (to - from) * len, barAcross);
        else ctx.fillRect(a0, h - CLIP_LED - 1 - to * len, barAcross, (to - from) * len);
      };
      const zones = (ci: number, upTo: number, alpha: number) => {
        seg(ci, 0, Math.min(upTo, POS_YELLOW), "#45c25f", alpha);
        seg(ci, POS_YELLOW, Math.min(upTo, POS_RED), "#d9c945", alpha);
        seg(ci, POS_RED, upTo, "#e0504c", alpha);
      };

      for (let i = 0; i < nch; i++) {
        const c = cs[i];
        zones(i, c.peak, 0.35); // translucent peak bar
        zones(i, c.rms, 1.0); // solid RMS bar
        // peak-hold line
        if (c.hold > 0.003) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = c.hold >= POS_RED ? "#ff6b66" : themeVar("--playhead");
          const a0 = i * (barAcross + gap);
          if (horiz) ctx.fillRect(Math.min(c.hold * len, len - 1.5), a0, 1.5, barAcross);
          else ctx.fillRect(a0, Math.max(CLIP_LED + 1, h - CLIP_LED - 1 - c.hold * len - 1.5), barAcross, 1.5);
        }
        // clip LED
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.clip ? "#ff3b30" : themeVar("--border");
        const a0 = i * (barAcross + gap);
        if (horiz) ctx.fillRect(w - CLIP_LED, a0, CLIP_LED, barAcross);
        else ctx.fillRect(a0, 0, barAcross, CLIP_LED);
      }
      ctx.globalAlpha = 1;
    }, win);
  }, [visible, ctxRef, canvasRef]);

  const onClick = () => {
    for (const c of chans.current) c.clip = false;
  };

  return (
    <canvas
      ref={ref}
      className={"meter" + (className ? " " + className : "")}
      style={{ width: width ?? "100%", height: height ?? "100%", ...style }}
      onClick={onClick}
      title={title ?? "Click to reset clip indicator"}
    />
  );
}
