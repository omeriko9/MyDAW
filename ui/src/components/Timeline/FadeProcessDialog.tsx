/**
 * FadeProcessDialog — the Cubase-style fade follow-up modal (the DOP window's Fade
 * In/Out panel): the clip's waveform drawn WITH the fade applied, the curve line
 * overlaid, and a row of curve-shape preset tiles to pick from.
 *
 * Three callers share it:
 *   - Process ▸ Fade In/Out (render)… — full-span fade appended to the DOP chain
 *   - Offline Processes… pencil on a fadeIn/fadeOut chain entry (re-edit the curve;
 *     previews over the PRE-chain material the chain replays from)
 *   - the clip fade-handle dialog (double-click / Fade In…) — adds a length field
 *     (`length` option) and previews the partial-span handle fade
 *
 * openFadeProcessDialog(opts) is imperative like openDopDialog; the dialog owns no
 * store state — callers pass the asset span and receive (curve[, lengthSec]) on Apply.
 */

import React from "react";
import { createRoot, Root } from "react-dom/client";
import { Modal } from "../common/Modal";
import { peaksFor } from "./peaksCache";
import { themeVar } from "./layout";
import { PEAK_LOD_SAMPLES_PER_BUCKET, PEAK_MAX_LOD } from "../../lib/peaks";
import { FADE_CURVES, FADE_CURVE_LABELS, fadeGainAt } from "../../lib/fadeCurves";
import type { FadeCurve } from "../../protocol/types";
import "../Dialogs/dialogs.css";

export interface FadeProcessDialogOptions {
  title: string;
  which: "in" | "out";
  /** Asset span the fade previews over (the material the fade will apply to). */
  assetId: number;
  channels: number;
  sampleRate: number;
  srcOffsetSamples: number;
  lengthSamples: number;
  initialCurve: FadeCurve;
  /** Present = clip-handle mode: editable fade length, previewed as a partial span. */
  length?: { sec: number; maxSec: number };
  applyLabel?: string;
  onApply: (curve: FadeCurve, lengthSec?: number) => void;
}

let reactRoot: Root | null = null;
let seq = 0;

function ensureRoot(): Root {
  if (!reactRoot) {
    const host = document.createElement("div");
    host.id = "mydaw-fadeproc-root";
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  }
  return reactRoot;
}

export function openFadeProcessDialog(opts: FadeProcessDialogOptions): void {
  ensureRoot().render(<FadeModal key={++seq} opts={opts} onClose={close} />);
}

function close(): void {
  ensureRoot().render(null);
}

/** Small curve-shape tile (Cubase's preset row) — direction-aware polyline. */
function CurveTile({
  curve,
  which,
  selected,
  onPick,
}: {
  curve: FadeCurve;
  which: "in" | "out";
  selected: boolean;
  onPick: () => void;
}) {
  const W = 34;
  const H = 26;
  const pts: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const g = fadeGainAt(which, curve, 1, t);
    pts.push(`${(2 + t * (W - 4)).toFixed(1)},${(H - 3 - g * (H - 6)).toFixed(1)}`);
  }
  return (
    <button
      type="button"
      className="btn fade-curve-tile"
      title={FADE_CURVE_LABELS[curve]}
      aria-pressed={selected}
      style={{
        padding: "2px 4px",
        lineHeight: 0,
        borderColor: selected ? "var(--accent)" : undefined,
        color: selected ? "var(--accent)" : "var(--text-dim)",
      }}
      onClick={onPick}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.6} />
      </svg>
    </button>
  );
}

function FadeModal({ opts, onClose }: { opts: FadeProcessDialogOptions; onClose: () => void }) {
  const [curve, setCurve] = React.useState<FadeCurve>(opts.initialCurve);
  const [lengthSec, setLengthSec] = React.useState<number>(opts.length?.sec ?? 0);
  const [, bump] = React.useReducer((n: number) => n + 1, 0); // peaks arrival repaint
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  const durationSec = opts.lengthSamples / Math.max(1, opts.sampleRate);
  const fadeFrac = opts.length
    ? Math.max(0, Math.min(1, lengthSec / Math.max(1e-6, durationSec)))
    : 1;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const cBg = themeVar("--panel");
    const cBorder = themeVar("--border");
    const cDim = themeVar("--text-faint");
    const cAccent = themeVar("--accent");
    ctx.fillStyle = cBg;
    ctx.fillRect(0, 0, W, H);

    // Waveform: pick the finest lod whose buckets are ≤ one per pixel over the span.
    const targetSpb = Math.max(1, opts.lengthSamples / Math.max(1, W));
    let lod = 0;
    while (lod < PEAK_MAX_LOD && PEAK_LOD_SAMPLES_PER_BUCKET[lod + 1] <= targetSpb) lod++;
    const pk = peaksFor(opts.assetId, lod, opts.channels, bump);
    const mid = H / 2;
    if (pk) {
      const drawWave = (color: string, shaped: boolean): void => {
        ctx.fillStyle = color;
        for (let x = 0; x < W; x++) {
          const p = x / W;
          const s = opts.srcOffsetSamples + p * opts.lengthSamples;
          const b = Math.min(pk.numBuckets - 1, Math.max(0, Math.floor(s / pk.samplesPerBucket)));
          let lo = 0;
          let hi = 0;
          for (let c = 0; c < pk.channels; c++) {
            lo = Math.min(lo, pk.data[(b * pk.channels + c) * 2]);
            hi = Math.max(hi, pk.data[(b * pk.channels + c) * 2 + 1]);
          }
          const g = shaped ? fadeGainAt(opts.which, curve, fadeFrac, p) : 1;
          const y0 = mid - (hi / 127) * g * (mid - 2);
          const y1 = mid - (lo / 127) * g * (mid - 2);
          ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
        }
      };
      drawWave(cDim, false); // original, faint
      drawWave(cAccent, true); // faded result
    } else {
      ctx.fillStyle = cDim;
      ctx.font = "500 11px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("loading waveform…", W / 2, mid + 4);
    }

    // Curve line (gain 1 = top).
    ctx.strokeStyle = themeVar("--text");
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = 0; x <= W; x++) {
      const g = fadeGainAt(opts.which, curve, fadeFrac, x / W);
      const y = H - 2 - g * (H - 4);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = cBorder;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={opts.title}
      width={480}
      draggable
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              opts.onApply(curve, opts.length ? lengthSec : undefined);
              onClose();
            }}
          >
            {opts.applyLabel ?? "Apply"}
          </button>
        </>
      }
    >
      <div className="dlg-fields">
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: 140, display: "block", borderRadius: 4 }}
        />
        <div className="le-row" style={{ justifyContent: "center", gap: 6 }}>
          {FADE_CURVES.map((c) => (
            <CurveTile
              key={c}
              curve={c}
              which={opts.which}
              selected={c === curve}
              onPick={() => setCurve(c)}
            />
          ))}
        </div>
        <div className="dlg-confirm-msg dim" style={{ textAlign: "center" }}>
          {FADE_CURVE_LABELS[curve]}
        </div>
        {opts.length && (
          <label className="dlg-field">
            <span className="dlg-field-label">Length (seconds)</span>
            {/* uncontrolled: feeding the parsed value back would fight decimal typing */}
            <input
              type="number"
              min={0}
              max={Math.round(opts.length.maxSec * 1000) / 1000}
              step={0.05}
              defaultValue={Math.round(lengthSec * 1000) / 1000}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v))
                  setLengthSec(Math.max(0, Math.min(opts.length!.maxSec, v)));
              }}
              // onChange already clamped into state; since the field is uncontrolled, an
              // out-of-range entry would keep showing while Apply used the clamped value.
              // Snap the display back on blur so what you read is what you get.
              onBlur={(e) => {
                const shown = parseFloat(e.target.value);
                if (!Number.isFinite(shown) || shown !== lengthSec)
                  e.target.value = String(Math.round(lengthSec * 1000) / 1000);
              }}
            />
          </label>
        )}
      </div>
    </Modal>
  );
}
