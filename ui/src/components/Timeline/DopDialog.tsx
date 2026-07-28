/**
 * Direct Offline Processing dialog — the editable process chain of one audio clip
 * (SPEC §6 DOP). openDopDialog(clipId) renders an imperative modal that tracks the
 * live store (list re-renders on every projectChanged), so engine recomputes show
 * up immediately. Entries can be toggled, reordered, removed, and (DSP ops)
 * re-parameterized; built-in effects can be appended; Make Permanent / Clear
 * mirror Cubase.
 */

import React from "react";
import { createRoot, Root } from "react-dom/client";
import { Modal } from "../common/Modal";
import { Icon } from "../common/icons";
import { showToast } from "../common/ToastHost";
import { useStore } from "../../store/store";
import { processChain } from "../../store/actions";
import { fieldsDialog, type FieldSpec } from "../Dialogs/fields";
import { FADE_CURVES, FADE_CURVE_LABELS } from "../../lib/fadeCurves";
import { isAudioClip, type AudioClip, type ClipProcess, type FadeCurve } from "../../protocol/types";
import "../Dialogs/dialogs.css";

const BUILTIN_FX: Array<{ uid: string; label: string }> = [
  { uid: "builtin:utility", label: "Utility" },
  { uid: "builtin:gate", label: "Gate" },
  { uid: "builtin:compressor", label: "Compressor" },
  { uid: "builtin:limiter", label: "Limiter" },
  { uid: "builtin:delay", label: "Delay" },
  { uid: "builtin:reverb", label: "Reverb" },
];

/* ----------------------------------------------------------------------------
 * Static param tables for the offline-editable built-ins — id order, real-unit
 * ranges, and defaults mirror the addParam() calls in Effects.cpp (the CONTRACT:
 * a change there must be mirrored here, like InstrumentEditors' PIANO/PS maps).
 * The chain stores NORMALIZED 0..1 values by param id; the edit dialog converts.
 * ------------------------------------------------------------------------- */

type PMap =
  | { kind: "lin"; lo: number; hi: number }
  | { kind: "log"; lo: number; hi: number }
  | { kind: "toggle" }
  | { kind: "norm" }; // raw 0..1

interface FxParam {
  id: number;
  name: string;
  unit: string;
  map: PMap;
  /** engine default in REAL units (toggle: 0/1; norm: 0..1) */
  def: number;
  step?: number;
}

const FX_PARAMS: Record<string, FxParam[]> = {
  "builtin:utility": [
    { id: 0, name: "Gain", unit: "dB", map: { kind: "lin", lo: -60, hi: 24 }, def: 0, step: 0.5 },
    { id: 1, name: "Pan", unit: "", map: { kind: "lin", lo: -1, hi: 1 }, def: 0, step: 0.05 },
    { id: 2, name: "Invert Phase", unit: "", map: { kind: "toggle" }, def: 0 },
    { id: 3, name: "Mono", unit: "", map: { kind: "toggle" }, def: 0 },
  ],
  "builtin:gate": [
    { id: 0, name: "Threshold", unit: "dB", map: { kind: "lin", lo: -80, hi: 0 }, def: -40 },
    { id: 1, name: "Attack", unit: "ms", map: { kind: "log", lo: 0.1, hi: 100 }, def: 1, step: 0.1 },
    { id: 2, name: "Hold", unit: "ms", map: { kind: "lin", lo: 0, hi: 500 }, def: 50 },
    { id: 3, name: "Release", unit: "ms", map: { kind: "log", lo: 5, hi: 2000 }, def: 100 },
    { id: 4, name: "Range", unit: "dB", map: { kind: "lin", lo: -80, hi: 0 }, def: -60 },
  ],
  "builtin:compressor": [
    { id: 0, name: "Threshold", unit: "dB", map: { kind: "lin", lo: -60, hi: 0 }, def: -18 },
    { id: 1, name: "Ratio", unit: ":1", map: { kind: "log", lo: 1, hi: 20 }, def: 4, step: 0.1 },
    { id: 2, name: "Attack", unit: "ms", map: { kind: "log", lo: 0.1, hi: 100 }, def: 10, step: 0.1 },
    { id: 3, name: "Release", unit: "ms", map: { kind: "log", lo: 5, hi: 2000 }, def: 100 },
    { id: 4, name: "Knee", unit: "dB", map: { kind: "lin", lo: 0, hi: 24 }, def: 6 },
    { id: 5, name: "Makeup", unit: "dB", map: { kind: "lin", lo: 0, hi: 24 }, def: 0, step: 0.5 },
  ],
  "builtin:limiter": [
    { id: 0, name: "Ceiling", unit: "dB", map: { kind: "lin", lo: -24, hi: 0 }, def: -0.3, step: 0.1 },
    { id: 1, name: "Release", unit: "ms", map: { kind: "log", lo: 1, hi: 1000 }, def: 50 },
  ],
  "builtin:delay": [
    { id: 0, name: "Time", unit: "ms", map: { kind: "lin", lo: 1, hi: 2000 }, def: 300 },
    { id: 1, name: "Feedback", unit: "%", map: { kind: "lin", lo: 0, hi: 95 }, def: 30 },
    { id: 2, name: "Mix", unit: "%", map: { kind: "lin", lo: 0, hi: 100 }, def: 30 },
    { id: 3, name: "Tone", unit: "Hz", map: { kind: "log", lo: 200, hi: 20000 }, def: 8000 },
    { id: 4, name: "Ping-Pong", unit: "", map: { kind: "toggle" }, def: 0 },
  ],
  "builtin:reverb": [
    { id: 0, name: "Size", unit: "", map: { kind: "norm" }, def: 0.5, step: 0.05 },
    { id: 1, name: "Damp", unit: "", map: { kind: "norm" }, def: 0.5, step: 0.05 },
    { id: 2, name: "Width", unit: "", map: { kind: "norm" }, def: 1, step: 0.05 },
    { id: 3, name: "Mix", unit: "%", map: { kind: "lin", lo: 0, hi: 100 }, def: 25 },
  ],
};

const normToReal = (m: PMap, n: number): number => {
  const x = Math.max(0, Math.min(1, n));
  switch (m.kind) {
    case "lin": return m.lo + x * (m.hi - m.lo);
    case "log": return m.lo * Math.pow(m.hi / m.lo, x);
    case "toggle": return x >= 0.5 ? 1 : 0;
    case "norm": return x;
  }
};

const realToNorm = (m: PMap, v: number): number => {
  switch (m.kind) {
    case "lin": return Math.max(0, Math.min(1, (v - m.lo) / (m.hi - m.lo)));
    case "log": return Math.max(0, Math.min(1, Math.log(Math.max(v, m.lo) / m.lo) / Math.log(m.hi / m.lo)));
    case "toggle": return v >= 0.5 ? 1 : 0;
    case "norm": return Math.max(0, Math.min(1, v));
  }
};

let reactRoot: Root | null = null;
let openForClip: number | null = null;
let seq = 0;

function ensureRoot(): Root {
  if (!reactRoot) {
    const host = document.createElement("div");
    host.id = "mydaw-dop-root";
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  }
  return reactRoot;
}

export function openDopDialog(clipId: number): void {
  openForClip = clipId;
  ensureRoot().render(<DopModal key={++seq} clipId={clipId} onClose={closeDop} />);
}

function closeDop(): void {
  openForClip = null;
  ensureRoot().render(null);
}

function findClip(clipId: number): AudioClip | null {
  const proj = useStore.getState().project;
  if (!proj) return null;
  for (const t of [...proj.tracks, proj.masterTrack]) {
    for (const c of t.clips) if (c.id === clipId && isAudioClip(c)) return c;
  }
  return null;
}

function entryLabel(pr: ClipProcess): string {
  const p = pr.params ?? {};
  const s = pr.sparams ?? {};
  switch (pr.op) {
    case "plugin": {
      const uid = s.uid ?? "";
      return BUILTIN_FX.find((f) => f.uid === uid)?.label ?? uid.replace("builtin:", "");
    }
    case "gain": return `Gain ${(p.gainDb ?? 0) > 0 ? "+" : ""}${p.gainDb ?? 0} dB`;
    case "normalize": return `Normalize ${s.mode ?? "peak"} → ${p.targetDb ?? -1} dB`;
    case "fadeIn": return `Fade In (${FADE_CURVE_LABELS[(s.curve as FadeCurve) ?? "linear"] ?? s.curve})`;
    case "fadeOut": return `Fade Out (${FADE_CURVE_LABELS[(s.curve as FadeCurve) ?? "linear"] ?? s.curve})`;
    case "stereoFlip": return `Stereo Flip (${s.flipMode ?? "swap"})`;
    case "reverse": return "Reverse";
    case "invert": return "Invert Phase";
    case "silence": return "Silence";
    case "dcRemove": return "Remove DC Offset";
    default: return pr.op;
  }
}

const fire = (p: Promise<unknown>, what: string): void => {
  p.catch(() => showToast(`${what} failed`, "info"));
};

/** Param-edit dialog per DSP op; null = the op has nothing to edit. */
function editFields(pr: ClipProcess): FieldSpec[] | null {
  const p = pr.params ?? {};
  const s = pr.sparams ?? {};
  if (pr.op === "plugin") {
    const table = FX_PARAMS[s.uid ?? ""];
    if (!table) return null;
    return table.map((fp): FieldSpec => {
      const storedNorm = p[String(fp.id)];
      const real = storedNorm !== undefined ? normToReal(fp.map, storedNorm) : fp.def;
      if (fp.map.kind === "toggle") {
        return { key: String(fp.id), label: fp.name, kind: "checkbox", value: real >= 0.5 };
      }
      const lo = fp.map.kind === "norm" ? 0 : fp.map.lo;
      const hi = fp.map.kind === "norm" ? 1 : fp.map.hi;
      return {
        key: String(fp.id),
        label: fp.unit ? `${fp.name} (${fp.unit})` : fp.name,
        kind: "number",
        value: Math.round(real * 100) / 100,
        min: lo,
        max: hi,
        step: fp.step ?? 1,
      };
    });
  }
  const curveField: FieldSpec = {
    key: "curve",
    label: "Curve",
    kind: "select",
    value: s.curve ?? "linear",
    options: FADE_CURVES.map((c) => ({ value: c, label: FADE_CURVE_LABELS[c] })),
  };
  switch (pr.op) {
    case "gain":
      return [{ key: "gainDb", label: "Gain (dB)", kind: "number", value: p.gainDb ?? 0, min: -48, max: 48, step: 0.5 }];
    case "normalize":
      return [
        {
          key: "mode",
          label: "Measure",
          kind: "select",
          value: s.mode ?? "peak",
          options: [
            { value: "peak", label: "Peak (dBFS)" },
            { value: "rms", label: "RMS (dB)" },
            { value: "lufs", label: "Loudness (LUFS)" },
          ],
        },
        { key: "targetDb", label: "Target", kind: "number", value: p.targetDb ?? -1, min: -48, max: 0, step: 0.5 },
      ];
    case "fadeIn":
    case "fadeOut":
      return [curveField];
    case "stereoFlip":
      return [
        {
          key: "flipMode",
          label: "Mode",
          kind: "select",
          value: s.flipMode ?? "swap",
          options: [
            { value: "swap", label: "Swap Channels" },
            { value: "leftToBoth", label: "Left → Both" },
            { value: "rightToBoth", label: "Right → Both" },
            { value: "merge", label: "Merge to Mono" },
            { value: "subtract", label: "Keep Side (L−R)" },
          ],
        },
      ];
    default:
      return null;
  }
}

function DopModal({ clipId, onClose }: { clipId: number; onClose: () => void }) {
  // Subscribing to the whole project keeps the list current after every recompute.
  useStore((st) => st.project);
  const clip = findClip(clipId);
  if (!clip || openForClip !== clipId) {
    return null;
  }
  const chain = clip.processes ?? [];

  const editEntry = (pr: ClipProcess): void => {
    const fields = editFields(pr);
    if (!fields) return;
    void fieldsDialog({ title: `Edit — ${entryLabel(pr)}`, fields }).then((v) => {
      if (!v) return;
      const params: Record<string, number> = {};
      const sparams: Record<string, string> = {};
      if (pr.op === "plugin") {
        // fields carry REAL units keyed by param id — convert back to normalized
        const table = FX_PARAMS[pr.sparams?.uid ?? ""] ?? [];
        for (const fp of table) {
          const val = v[String(fp.id)];
          const real = typeof val === "boolean" ? (val ? 1 : 0) : (val as number);
          params[String(fp.id)] = realToNorm(fp.map, real);
        }
      } else {
        for (const f of fields) {
          const val = v[f.key];
          if (f.kind === "number") params[f.key] = val as number;
          else if (f.kind === "select") sparams[f.key] = val as string;
        }
      }
      fire(
        processChain({ clipId, action: "setParams", processId: pr.id, params, sparams }),
        "Edit process",
      );
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Offline Processes — ${clip.name || "Audio"}`}
      width={480}
      draggable
      footer={
        <>
          <button
            type="button"
            className="btn"
            disabled={chain.length === 0}
            title="Drop the chain and go back to the original material"
            onClick={() => fire(processChain({ clipId, action: "clear" }), "Clear")}
          >
            Clear
          </button>
          <button
            type="button"
            className="btn"
            disabled={chain.length === 0}
            title="Keep the current render as the clip's material (chain no longer editable)"
            onClick={() => fire(processChain({ clipId, action: "makePermanent" }), "Make permanent")}
          >
            Make Permanent
          </button>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="dlg-fields">
        {chain.length === 0 && (
          <div className="dlg-confirm-msg dim">
            No offline processes yet — use the clip's Process menu, or add an effect below.
            Every entry is re-editable: the chain replays from the original audio.
          </div>
        )}
        {chain.map((pr, i) => (
          <div key={pr.id} className="le-row">
            <label className="dlg-check" title="Enable/disable (replays the chain)">
              <input
                type="checkbox"
                checked={pr.enabled !== false}
                onChange={() => fire(processChain({ clipId, action: "toggle", processId: pr.id }), "Toggle")}
              />
            </label>
            <span
              className="grow ellipsis"
              style={{ opacity: pr.enabled === false ? 0.5 : 1 }}
            >
              {i + 1}. {entryLabel(pr)}
            </span>
            {editFields(pr) !== null && (
              <button type="button" className="btn-icon" title="Edit parameters" onClick={() => editEntry(pr)}>
                <Icon name="pencil" size={12} />
              </button>
            )}
            <button
              type="button"
              className="btn-icon"
              title="Move up"
              disabled={i === 0}
              onClick={() => fire(processChain({ clipId, action: "reorder", processId: pr.id, index: i - 1 }), "Reorder")}
            >
              <Icon name="chevronUp" size={12} />
            </button>
            <button
              type="button"
              className="btn-icon"
              title="Move down"
              disabled={i === chain.length - 1}
              onClick={() => fire(processChain({ clipId, action: "reorder", processId: pr.id, index: i + 1 }), "Reorder")}
            >
              <Icon name="chevronDown" size={12} />
            </button>
            <button
              type="button"
              className="btn-icon"
              title="Remove"
              onClick={() => fire(processChain({ clipId, action: "remove", processId: pr.id }), "Remove")}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        <div className="dlg-subhead">Add built-in effect (runs offline; edit its parameters with the pencil)</div>
        <div className="le-row" style={{ flexWrap: "wrap" }}>
          {BUILTIN_FX.map((f) => (
            <button
              key={f.uid}
              type="button"
              className="btn"
              onClick={() => fire(processChain({ clipId, action: "addPlugin", uid: f.uid }), `Add ${f.label}`)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
