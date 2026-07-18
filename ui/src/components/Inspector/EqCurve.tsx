/**
 * EQ response curve (U5) — a small canvas plotting the summed magnitude response of the
 * ENABLED bands (RBJ biquad magnitude at log-spaced frequencies, computed in eq.ts).
 *
 * It also draws a handle dot per band; dragging a handle moves that band's freq (X, log)
 * and — for gain-using types — gain (Y). Drags stream transient setTrackEq and commit on
 * release, mirroring the rest of the inspector's gesture pattern. All geometry is guarded
 * so a non-finite band value can never produce a NaN canvas coordinate.
 */

import React, { useEffect, useRef } from "react";
import type { EqBand } from "../../protocol/types";
import { useCanvas } from "../../lib/canvas";
import { useThemeName } from "../../lib/theme";
import { themeVar, withAlpha } from "../Timeline/layout";
import {
  GAIN_MAX,
  GAIN_MIN,
  bandUsesGain,
  clampNum,
  eqResponseCurve,
  freqToNorm,
  normToFreq,
  sanitizeBand,
} from "./eq";

/** Vertical dB range shown on the curve (a touch beyond the ±24 band limit for headroom). */
const VIEW_DB = 26;

export interface EqCurveProps {
  bands: EqBand[];
  bypass: boolean;
  sampleRate: number;
  /** Streamed during a handle drag (transient). */
  onDragBand: (index: number, patch: Partial<EqBand>) => void;
  /** Once at the end of a handle drag (commit). */
  onCommitBand: (index: number, patch: Partial<EqBand>) => void;
  /** Right-click near a band handle (screen coords) — the owner builds the menu. */
  onBandMenu?: (index: number, x: number, y: number) => void;
  height?: number;
}

function dbToY(db: number, h: number): number {
  const d = clampNum(db, -VIEW_DB, VIEW_DB, 0);
  return h / 2 - (d / VIEW_DB) * (h / 2);
}
function yToDb(y: number, h: number): number {
  const half = h / 2 || 1;
  return clampNum(((half - y) / half) * VIEW_DB, GAIN_MIN, GAIN_MAX, 0);
}

export function EqCurve({
  bands,
  bypass,
  sampleRate,
  onDragBand,
  onCommitBand,
  onBandMenu,
  height = 96,
}: EqCurveProps) {
  const { ref, ctxRef, size } = useCanvas();
  const theme = useThemeName(); // draw-effect dep — repaint with fresh colors on switch
  const drag = useRef<{ index: number; usesGain: boolean } | null>(null);

  // Mirror inputs into a ref so the pointer handlers (bound once) read fresh values.
  const stateRef = useRef({ bands, bypass, sampleRate, size, onDragBand, onCommitBand, onBandMenu });
  stateRef.current = { bands, bypass, sampleRate, size, onDragBand, onCommitBand, onBandMenu };

  /* ---- draw (static; re-runs when bands/size/bypass change) ---- */
  useEffect(() => {
    const ctx = ctxRef.current;
    const { width: w, height: h } = size;
    if (!ctx || w <= 0 || h <= 0) return;

    const accent = themeVar("--accent");
    const faint = themeVar("--text-faint");

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = themeVar("--bg-sunken");
    ctx.fillRect(0, 0, w, h);

    // grid: 0 dB center + ±6/±12 dB lines
    ctx.strokeStyle = themeVar("--border");
    ctx.lineWidth = 1;
    for (const g of [-18, -12, -6, 6, 12, 18]) {
      const y = Math.round(dbToY(g, h)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // vertical decade lines at 100 / 1k / 10k
    for (const f of [100, 1000, 10000]) {
      const x = Math.round(freqToNorm(f) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    // 0 dB line
    ctx.strokeStyle = themeVar("--border-light");
    const y0 = Math.round(dbToY(0, h)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.stroke();

    const safeBands = bands.map(sanitizeBand);
    const enabledCount = safeBands.filter((b) => b.enabled).length;

    // response curve
    const n = Math.max(2, Math.min(512, Math.round(w)));
    const { db } = eqResponseCurve(safeBands, sampleRate, n);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = dbToY(db[i], h);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const flat = bypass || enabledCount === 0;
    ctx.strokeStyle = flat ? faint : accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // fill under the curve (subtle)
    if (!flat) {
      ctx.lineTo(w, y0);
      ctx.lineTo(0, y0);
      ctx.closePath();
      ctx.fillStyle = withAlpha(accent, 0.1);
      ctx.fill();
    }

    // band handles
    safeBands.forEach((b, i) => {
      const x = freqToNorm(b.freqHz) * w;
      const usesGain = bandUsesGain(b.type);
      const y = usesGain ? dbToY(b.gainDb, h) : y0;
      const hi = b.enabled ? themeVar("--thumb-hover") : faint;
      ctx.beginPath();
      ctx.arc(x, y, b.enabled ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = b.enabled ? accent : themeVar("--knob-face-hi");
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = hi;
      ctx.stroke();
      // band number
      ctx.fillStyle = hi;
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), x, y);
    });
  }, [bands, bypass, sampleRate, size, ctxRef, theme]);

  /* ---- drag handles ---- */
  function nearestBand(px: number, py: number): number | null {
    const { size: sz, bands: bs } = stateRef.current;
    const { width: w, height: h } = sz;
    if (w <= 0) return null;
    let best = -1;
    let bestD = Infinity;
    bs.forEach((raw, i) => {
      const b = sanitizeBand(raw);
      const x = freqToNorm(b.freqHz) * w;
      const y = bandUsesGain(b.type) ? dbToY(b.gainDb, h) : h / 2;
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return bestD <= 22 && best >= 0 ? best : null;
  }

  const localXY = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const patchFromXY = (index: number, px: number, py: number): Partial<EqBand> => {
    const { size: sz, bands: bs } = stateRef.current;
    const { width: w, height: h } = sz;
    const b = sanitizeBand(bs[index]);
    const t = clampNum(px / (w || 1), 0, 1, 0);
    const patch: Partial<EqBand> = { freqHz: Math.round(normToFreq(t)) };
    if (bandUsesGain(b.type)) {
      patch.gainDb = parseFloat(yToDb(py, h).toFixed(1));
    }
    return patch;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const [px, py] = localXY(e);
    const idx = nearestBand(px, py);
    if (idx === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { index: idx, usesGain: bandUsesGain(sanitizeBand(bands[idx]).type) };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const [px, py] = localXY(e);
    stateRef.current.onDragBand(d.index, patchFromXY(d.index, px, py));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const [px, py] = localXY(e);
    stateRef.current.onCommitBand(d.index, patchFromXY(d.index, px, py));
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cb = stateRef.current.onBandMenu;
    if (!cb) return;
    const r = e.currentTarget.getBoundingClientRect();
    const idx = nearestBand(e.clientX - r.left, e.clientY - r.top);
    if (idx === null) return; // not near a handle: no menu
    e.preventDefault();
    cb(idx, e.clientX, e.clientY);
  };

  return (
    <canvas
      ref={ref}
      className="eq-curve"
      style={{ width: "100%", height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      title="EQ response — drag a band dot to move it"
    />
  );
}
