/**
 * InstrumentEditors — dedicated "hardware" panels for the built-in instruments
 * (builtin:piano, builtin:polysynth), rendered by PluginEditorHost in place of the
 * generic parameter list (a toolbar toggle brings the list back).
 *
 * Params stay the engine's normalized-0..1 wire values; each control maps norm→display
 * locally (mirroring the engine's lin/log maps in Effects.cpp) so captions track live
 * drags without waiting for an engine round-trip. onChange streams transients,
 * onCommit sends the final undoable value, onMenu opens the automation/reset menu.
 * The keyboard at the bottom auditions through midi/preview on the owner track
 * (fire-and-forget, same as the piano-roll keys column).
 */

import React, { useCallback, useMemo, useRef, useState } from "react";
import type { PluginParam } from "../../protocol/types";
import { previewNote } from "../../store/actions";
import { Knob } from "../common/Knob";
import "./instrumenteditors.css";

/* ============================================================================
 * Registry — PluginEditorHost asks by uid
 * ========================================================================= */

export interface InstrumentEditorSpec {
  /** preferred (default) window size for a first open */
  w: number;
  h: number;
}

const SPECS: Record<string, InstrumentEditorSpec> = {
  "builtin:piano": { w: 720, h: 400 },
  "builtin:polysynth": { w: 792, h: 560 },
};

export function instrumentEditorSpec(uid: string | undefined): InstrumentEditorSpec | null {
  return uid !== undefined ? (SPECS[uid] ?? null) : null;
}

export interface InstrumentEditorProps {
  uid: string;
  params: PluginParam[];
  /** owner track id — audition target (null = unknown/disconnected) */
  trackId: number | null;
  disabled: boolean;
  onChange: (id: number, value: number) => void;
  onCommit: (id: number, value: number) => void;
  onMenu: (e: React.MouseEvent, param: PluginParam) => void;
}

export default function InstrumentEditor(props: InstrumentEditorProps) {
  if (props.uid === "builtin:piano") return <PianoEditor {...props} />;
  if (props.uid === "builtin:polysynth") return <PolySynthEditor {...props} />;
  return null;
}

/* ============================================================================
 * Norm ↔ display maps (mirror Effects.cpp)
 * ========================================================================= */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const linMap = (n: number, lo: number, hi: number) => lo + clamp01(n) * (hi - lo);
const logMap = (n: number, lo: number, hi: number) => lo * Math.pow(hi / lo, clamp01(n));

const fmtPct = (n: number) => `${Math.round(n * 100)}%`;
const fmtBipolarPct = (n: number) => {
  const v = Math.round((n * 2 - 1) * 100);
  return `${v > 0 ? "+" : ""}${v}%`;
};
const fmtDb = (lo: number, hi: number) => (n: number) => `${linMap(n, lo, hi).toFixed(1)} dB`;
const fmtMs = (lo: number, hi: number) => (n: number) => {
  const ms = logMap(n, lo, hi);
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
};
const fmtHz = (lo: number, hi: number) => (n: number) => {
  const hz = logMap(n, lo, hi);
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
};

/* ============================================================================
 * Shared building blocks
 * ========================================================================= */

interface CtlProps {
  params: PluginParam[];
  disabled: boolean;
  onChange: (id: number, value: number) => void;
  onCommit: (id: number, value: number) => void;
  onMenu: (e: React.MouseEvent, param: PluginParam) => void;
}

function byId(params: PluginParam[], id: number): PluginParam | undefined {
  return params.find((p) => p.id === id);
}

/** One labeled knob bound to a normalized param. */
function PKnob({
  ctl,
  id,
  label,
  format,
  bipolar,
  size = 40,
}: {
  ctl: CtlProps;
  id: number;
  label: string;
  format: (norm: number) => string;
  bipolar?: boolean;
  size?: number;
}) {
  const p = byId(ctl.params, id);
  if (!p) return null;
  return (
    <div className="ie-ctl" onContextMenu={(e) => ctl.onMenu(e, p)}>
      <Knob
        size={size}
        value={p.value}
        min={0}
        max={1}
        defaultValue={p.defaultValue}
        bipolar={bipolar}
        label={label}
        format={format}
        disabled={ctl.disabled}
        onChange={(v) => ctl.onChange(id, v)}
        onCommit={(v) => ctl.onCommit(id, v)}
      />
    </div>
  );
}

/** Segmented selector for a stepped param (value = index / (steps-1)). */
function Seg({
  ctl,
  id,
  options,
  ariaLabel,
}: {
  ctl: CtlProps;
  id: number;
  options: Array<{ label: React.ReactNode; title: string }>;
  ariaLabel: string;
}) {
  const p = byId(ctl.params, id);
  if (!p) return null;
  const steps = options.length;
  const idx = Math.min(steps - 1, Math.max(0, Math.round(p.value * (steps - 1))));
  return (
    <div className="ie-seg" role="radiogroup" aria-label={ariaLabel} onContextMenu={(e) => ctl.onMenu(e, p)}>
      {options.map((o, i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={i === idx}
          className={"ie-seg-btn" + (i === idx ? " on" : "")}
          title={o.title}
          disabled={ctl.disabled}
          onClick={() => ctl.onCommit(p.id, steps <= 1 ? 0 : i / (steps - 1))}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Tiny waveform glyphs for the oscillator selectors. */
function WaveGlyph({ kind }: { kind: "saw" | "square" | "triangle" | "sine" }) {
  const d =
    kind === "saw"
      ? "M1 9 L8 2 L8 9 L15 2"
      : kind === "square"
        ? "M1 2 L5 2 L5 9 L11 9 L11 2 L15 2"
        : kind === "triangle"
          ? "M1 9 L5 2 L12 9 L15 6"
          : "M1 6 C 3 0, 6 0, 8 6 C 10 12, 13 12, 15 6";
  return (
    <svg width={16} height={11} viewBox="0 0 16 11" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const WAVE_OPTIONS = [
  { label: <WaveGlyph kind="saw" />, title: "Saw" },
  { label: <WaveGlyph kind="square" />, title: "Square" },
  { label: <WaveGlyph kind="triangle" />, title: "Triangle" },
  { label: <WaveGlyph kind="sine" />, title: "Sine" },
];

/**
 * ADSR preview — polyline over a normalized time axis. Segment widths follow the
 * normalized knob values (not real ms) so the shape always reads at a glance.
 */
function EnvGraph({ a, d, s, r }: { a: number; d: number; s: number; r: number }) {
  const W = 132;
  const H = 36;
  const pad = 2;
  const wA = 4 + 30 * clamp01(a);
  const wD = 4 + 30 * clamp01(d);
  const wR = 4 + 30 * clamp01(r);
  const wS = W - 2 * pad - wA - wD - wR;
  const y = (level: number) => pad + (1 - clamp01(level)) * (H - 2 * pad);
  const pts = [
    [pad, y(0)],
    [pad + wA, y(1)],
    [pad + wA + wD, y(s)],
    [pad + wA + wD + wS, y(s)],
    [W - pad, y(0)],
  ]
    .map(([x, py]) => `${x.toFixed(1)},${py.toFixed(1)}`)
    .join(" ");
  return (
    <svg className="ie-env" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />
      <polyline points={`${pts} ${W - pad},${H - pad} ${pad},${H - pad}`} fill="var(--accent-soft)" stroke="none" opacity={0.5} />
    </svg>
  );
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={"ie-section" + (className ? " " + className : "")}>
      <div className="ie-section-title">{title}</div>
      <div className="ie-section-body">{children}</div>
    </div>
  );
}

/* ============================================================================
 * Audition keyboard (midi/preview on the owner track)
 * ========================================================================= */

interface KeyGeom {
  note: number;
  black: boolean;
  /** 0..1 fractions of the strip width */
  x: number;
  w: number;
}

const BLACK_IN_OCTAVE = new Set([1, 3, 6, 8, 10]);

function buildKeys(low: number, high: number): { keys: KeyGeom[]; whites: number } {
  let whites = 0;
  for (let n = low; n <= high; ++n) if (!BLACK_IN_OCTAVE.has(n % 12)) whites++;
  const ww = 1 / whites;
  const keys: KeyGeom[] = [];
  let wi = 0;
  for (let n = low; n <= high; ++n) {
    if (BLACK_IN_OCTAVE.has(n % 12)) {
      keys.push({ note: n, black: true, x: wi * ww - ww * 0.32, w: ww * 0.64 });
    } else {
      keys.push({ note: n, black: false, x: wi * ww, w: ww });
      wi++;
    }
  }
  return { keys, whites };
}

export function KeyboardStrip({
  trackId,
  disabled,
  low,
  high,
}: {
  trackId: number | null;
  disabled: boolean;
  low: number;
  high: number;
}) {
  const { keys } = useMemo(() => buildKeys(low, high), [low, high]);
  const blacks = useMemo(() => keys.filter((k) => k.black), [keys]);
  const [pressed, setPressed] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<number | null>(null);

  const hitTest = useCallback(
    (clientX: number, clientY: number): { note: number; vel: number } | null => {
      const el = rootRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = (clientX - r.left) / r.width;
      const y = (clientY - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      // strike position → velocity (soft at the top, hard at the bottom)
      const vel = Math.min(127, Math.max(20, Math.round(35 + 92 * y)));
      if (y < 0.62) {
        for (const k of blacks) if (x >= k.x && x <= k.x + k.w) return { note: k.note, vel };
      }
      for (const k of keys) if (!k.black && x >= k.x && x < k.x + k.w) return { note: k.note, vel };
      return null;
    },
    [keys, blacks],
  );

  const noteOff = useCallback(() => {
    const cur = activeRef.current;
    activeRef.current = null;
    setPressed(null);
    if (cur !== null && trackId !== null) previewNote(trackId, cur, 100, false).catch(() => undefined);
  }, [trackId]);

  const noteOn = useCallback(
    (note: number, vel: number) => {
      if (activeRef.current === note) return;
      const cur = activeRef.current;
      if (cur !== null && trackId !== null) previewNote(trackId, cur, 100, false).catch(() => undefined);
      activeRef.current = note;
      setPressed(note);
      if (trackId !== null) previewNote(trackId, note, vel, true).catch(() => undefined);
    },
    [trackId],
  );

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || trackId === null || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) noteOn(hit.note, hit.vel);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeRef.current === null) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) noteOn(hit.note, hit.vel);
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeRef.current === null) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    noteOff();
  };

  return (
    <div
      ref={rootRef}
      className={"ie-keys" + (disabled || trackId === null ? " disabled" : "")}
      role="presentation"
      title={trackId === null ? "Audition unavailable" : "Click / drag to audition (lower on the key = harder)"}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {keys
        .filter((k) => !k.black)
        .map((k) => (
          <div
            key={k.note}
            className={"ie-key-w" + (pressed === k.note ? " down" : "")}
            style={{ left: `${k.x * 100}%`, width: `${k.w * 100}%` }}
          >
            {k.note % 12 === 0 && <span className="ie-key-label">C{Math.floor(k.note / 12) - 1}</span>}
          </div>
        ))}
      {blacks.map((k) => (
        <div
          key={k.note}
          className={"ie-key-b" + (pressed === k.note ? " down" : "")}
          style={{ left: `${k.x * 100}%`, width: `${k.w * 100}%` }}
        />
      ))}
    </div>
  );
}

/* ============================================================================
 * Piano — builtin:piano  (param ids mirror PianoInstrument's enum in Effects.cpp)
 * ========================================================================= */

const PIANO = { decay: 0, bright: 1, hard: 2, detune: 3, release: 4, width: 5, dynamics: 6, gain: 7 };

function PianoEditor({ params, trackId, disabled, onChange, onCommit, onMenu }: InstrumentEditorProps) {
  const ctl: CtlProps = { params, disabled, onChange, onCommit, onMenu };
  return (
    <div className="ie-root ie-piano">
      <div className="ie-brand">
        <span className="ie-brand-name">Grand</span>
        <span className="ie-brand-sub">MyDAW modeled piano</span>
      </div>
      <div className="ie-panels">
        <Section title="Tone">
          <PKnob ctl={ctl} id={PIANO.bright} label="Bright" format={fmtBipolarPct} bipolar />
          <PKnob ctl={ctl} id={PIANO.hard} label="Hardness" format={fmtPct} />
          <PKnob ctl={ctl} id={PIANO.dynamics} label="Dynamics" format={fmtPct} />
        </Section>
        <Section title="Strings">
          <PKnob ctl={ctl} id={PIANO.decay} label="Decay" format={(n) => `${Math.round(logMap(n, 0.25, 4) * 100)}%`} />
          <PKnob ctl={ctl} id={PIANO.release} label="Release" format={fmtMs(20, 500)} />
          <PKnob ctl={ctl} id={PIANO.detune} label="Detune" format={(n) => `${linMap(n, 0, 8).toFixed(1)} ct`} />
        </Section>
        <Section title="Output">
          <PKnob ctl={ctl} id={PIANO.width} label="Width" format={fmtPct} />
          <PKnob ctl={ctl} id={PIANO.gain} label="Gain" format={fmtDb(-24, 6)} />
        </Section>
      </div>
      <KeyboardStrip trackId={trackId} disabled={disabled} low={21} high={108} />
    </div>
  );
}

/* ============================================================================
 * PolySynth — builtin:polysynth (param ids mirror PolySynthInstrument's enum)
 * ========================================================================= */

const PS = {
  osc1Wave: 0, osc2Wave: 1, osc2Semi: 2, osc2Fine: 3, oscMix: 4, sub: 5, noise: 6, glide: 7,
  cutoff: 8, reso: 9, fltMode: 10, fltEnv: 11, fltTrack: 12,
  ampA: 13, ampD: 14, ampS: 15, ampR: 16, fltA: 17, fltD: 18, fltS: 19, fltR: 20,
  lfoRate: 21, lfoDepth: 22, lfoDest: 23, width: 24, gain: 25,
};

const FLT_OPTIONS = [
  { label: "LP", title: "Low-pass" },
  { label: "BP", title: "Band-pass" },
  { label: "HP", title: "High-pass" },
];
const LFO_OPTIONS = [
  { label: "Off", title: "LFO off" },
  { label: "Pitch", title: "Vibrato (±1 st)" },
  { label: "Filter", title: "Cutoff sweep (±2 oct)" },
  { label: "Amp", title: "Tremolo" },
];

function envNorms(params: PluginParam[], ids: [number, number, number, number]) {
  return ids.map((id) => byId(params, id)?.value ?? 0) as [number, number, number, number];
}

function PolySynthEditor({ params, trackId, disabled, onChange, onCommit, onMenu }: InstrumentEditorProps) {
  const ctl: CtlProps = { params, disabled, onChange, onCommit, onMenu };
  const [aA, aD, aS, aR] = envNorms(params, [PS.ampA, PS.ampD, PS.ampS, PS.ampR]);
  const [fA, fD, fS, fR] = envNorms(params, [PS.fltA, PS.fltD, PS.fltS, PS.fltR]);
  return (
    <div className="ie-root ie-synth">
      <div className="ie-brand">
        <span className="ie-brand-name">PolySynth</span>
        <span className="ie-brand-sub">2-osc subtractive · 16 voices</span>
      </div>
      <div className="ie-panels">
        <Section title="Osc 1">
          <Seg ctl={ctl} id={PS.osc1Wave} options={WAVE_OPTIONS} ariaLabel="Osc 1 waveform" />
        </Section>
        <Section title="Osc 2">
          <Seg ctl={ctl} id={PS.osc2Wave} options={WAVE_OPTIONS} ariaLabel="Osc 2 waveform" />
          <PKnob ctl={ctl} id={PS.osc2Semi} label="Semi" size={34} bipolar
            format={(n) => `${Math.round(linMap(n, -24, 24)) > 0 ? "+" : ""}${Math.round(linMap(n, -24, 24))} st`} />
          <PKnob ctl={ctl} id={PS.osc2Fine} label="Fine" size={34} bipolar
            format={(n) => `${Math.round(linMap(n, -50, 50)) > 0 ? "+" : ""}${Math.round(linMap(n, -50, 50))} ct`} />
        </Section>
        <Section title="Mix">
          <PKnob ctl={ctl} id={PS.oscMix} label="Osc 1·2" size={34} bipolar format={fmtPct} />
          <PKnob ctl={ctl} id={PS.sub} label="Sub" size={34} format={fmtPct} />
          <PKnob ctl={ctl} id={PS.noise} label="Noise" size={34} format={fmtPct} />
        </Section>
        <Section title="Filter" className="ie-wide">
          <Seg ctl={ctl} id={PS.fltMode} options={FLT_OPTIONS} ariaLabel="Filter type" />
          <PKnob ctl={ctl} id={PS.cutoff} label="Cutoff" size={46} format={fmtHz(30, 18000)} />
          <PKnob ctl={ctl} id={PS.reso} label="Reso" size={34} format={fmtPct} />
          <PKnob ctl={ctl} id={PS.fltEnv} label="Env Amt" size={34} bipolar format={fmtBipolarPct} />
          <PKnob ctl={ctl} id={PS.fltTrack} label="Key Trk" size={34} format={fmtPct} />
        </Section>
        <Section title="Amp Envelope" className="ie-wide">
          <EnvGraph a={aA} d={aD} s={aS} r={aR} />
          <PKnob ctl={ctl} id={PS.ampA} label="A" size={30} format={fmtMs(1, 4000)} />
          <PKnob ctl={ctl} id={PS.ampD} label="D" size={30} format={fmtMs(1, 4000)} />
          <PKnob ctl={ctl} id={PS.ampS} label="S" size={30} format={fmtPct} />
          <PKnob ctl={ctl} id={PS.ampR} label="R" size={30} format={fmtMs(1, 8000)} />
        </Section>
        <Section title="Filter Envelope" className="ie-wide">
          <EnvGraph a={fA} d={fD} s={fS} r={fR} />
          <PKnob ctl={ctl} id={PS.fltA} label="A" size={30} format={fmtMs(1, 4000)} />
          <PKnob ctl={ctl} id={PS.fltD} label="D" size={30} format={fmtMs(1, 4000)} />
          <PKnob ctl={ctl} id={PS.fltS} label="S" size={30} format={fmtPct} />
          <PKnob ctl={ctl} id={PS.fltR} label="R" size={30} format={fmtMs(1, 8000)} />
        </Section>
        <Section title="LFO">
          <Seg ctl={ctl} id={PS.lfoDest} options={LFO_OPTIONS} ariaLabel="LFO target" />
          <PKnob ctl={ctl} id={PS.lfoRate} label="Rate" size={34}
            format={(n) => `${logMap(n, 0.05, 25).toFixed(2)} Hz`} />
          <PKnob ctl={ctl} id={PS.lfoDepth} label="Depth" size={34} format={fmtPct} />
        </Section>
        <Section title="Voice">
          <PKnob ctl={ctl} id={PS.glide} label="Glide" size={34}
            format={(n) => (n <= 0.005 ? "Off" : fmtMs(5, 1000)(n))} />
          <PKnob ctl={ctl} id={PS.width} label="Width" size={34} format={fmtPct} />
          <PKnob ctl={ctl} id={PS.gain} label="Gain" size={34} format={fmtDb(-24, 6)} />
        </Section>
      </div>
      <KeyboardStrip trackId={trackId} disabled={disabled} low={36} high={84} />
    </div>
  );
}
