/**
 * Shared inspector field widgets (U5): dB drag field, pan knob, level knob,
 * seconds drag, color swatch row — all following the SPEC §5.8 drag pattern
 * (local preview during the gesture, transient stream optional, one commit at the end).
 */

import React, { useEffect, useRef, useState } from "react";
import { NumberDrag } from "../common/NumberDrag";
import { Knob } from "../common/Knob";
import { dbToGain, gainToDb, gainToDbText } from "../common/Fader";
import { TRACK_COLORS } from "../../lib/canvas";

/* ============================================================================
 * Draft value: show the in-gesture value locally; fall back to the committed
 * (store) value once it changes (projectChanged) or after a grace timeout.
 * ========================================================================= */

export function useDraftValue(committed: number): {
  shown: number;
  preview: (v: number) => void;
  settle: () => void;
} {
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(null);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, [committed]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return {
    shown: draft ?? committed,
    preview: (v: number) => setDraft(v),
    settle: () => {
      if (timer.current) clearTimeout(timer.current);
      // keep the draft briefly so the display doesn't snap back before projectChanged lands
      timer.current = setTimeout(() => setDraft(null), 1500);
    },
  };
}

/* ============================================================================
 * dB field over a LINEAR gain value (track volume / clip gain). -60 dB floor = gain 0.
 * ========================================================================= */

const DB_MIN = -60;
const DB_MAX = 12;

export function dbFromGain(gain: number): number {
  if (!(gain > 0)) return DB_MIN;
  return Math.max(DB_MIN, Math.min(DB_MAX, gainToDb(gain)));
}

export function gainFromDb(db: number): number {
  return db <= DB_MIN ? 0 : dbToGain(db);
}

export function formatDb(db: number): string {
  if (db <= DB_MIN) return "-inf";
  return (db > 0 ? "+" : "") + db.toFixed(1);
}

export interface GainDbDragProps {
  /** linear gain (1 = 0 dB) */
  gain: number;
  /** streamed during the drag (send transient) */
  onDrag: (gain: number) => void;
  /** once at the end of the gesture (non-transient commit) */
  onCommit: (gain: number) => void;
  disabled?: boolean;
  width?: number | string;
  title?: string;
}

export function GainDbDrag({ gain, onDrag, onCommit, disabled, width, title }: GainDbDragProps) {
  const { shown, preview, settle } = useDraftValue(dbFromGain(gain));
  return (
    <NumberDrag
      value={shown}
      min={DB_MIN}
      max={DB_MAX}
      step={0.1}
      precision={1}
      units="dB"
      width={width}
      title={title}
      disabled={disabled}
      format={formatDb}
      parse={(t) => {
        const s = t.trim().toLowerCase();
        if (s === "-inf" || s === "inf" || s === "off") return DB_MIN;
        const n = parseFloat(s.replace(",", "."));
        return Number.isFinite(n) ? n : null;
      }}
      onChange={(db) => {
        preview(db);
        onDrag(gainFromDb(db));
      }}
      onCommit={(db) => {
        onCommit(gainFromDb(db));
        settle();
      }}
    />
  );
}

/* ============================================================================
 * Pan knob (-1..1, bipolar)
 * ========================================================================= */

export function panText(v: number): string {
  const n = Math.round(Math.abs(v) * 100);
  return n === 0 ? "C" : v < 0 ? `L${n}` : `R${n}`;
}

export interface PanKnobProps {
  pan: number;
  onDrag: (pan: number) => void;
  onCommit: (pan: number) => void;
  size?: number;
  label?: string;
  title?: string;
}

export function PanKnob({ pan, onDrag, onCommit, size = 26, label, title }: PanKnobProps) {
  const { shown, preview, settle } = useDraftValue(pan);
  return (
    <Knob
      value={shown}
      min={-1}
      max={1}
      bipolar
      size={size}
      label={label}
      title={title}
      format={panText}
      onChange={(v) => {
        preview(v);
        onDrag(v);
      }}
      onCommit={(v) => {
        onCommit(v);
        settle();
      }}
    />
  );
}

/* ============================================================================
 * Send-level knob (linear gain 0..2, dB display, default 1 = 0 dB)
 * ========================================================================= */

export interface LevelKnobProps {
  level: number;
  onDrag: (level: number) => void;
  onCommit: (level: number) => void;
  size?: number;
  label?: string;
  title?: string;
}

export function LevelKnob({ level, onDrag, onCommit, size = 24, label, title }: LevelKnobProps) {
  const { shown, preview, settle } = useDraftValue(level);
  return (
    <Knob
      value={shown}
      min={0}
      max={2}
      defaultValue={1}
      size={size}
      label={label}
      title={title}
      format={(v) => gainToDbText(v) + " dB"}
      onChange={(v) => {
        preview(v);
        onDrag(v);
      }}
      onCommit={(v) => {
        onCommit(v);
        settle();
      }}
    />
  );
}

/* ============================================================================
 * Seconds drag (fades)
 * ========================================================================= */

export interface SecondsDragProps {
  value: number;
  onDrag: (v: number) => void;
  onCommit: (v: number) => void;
  max?: number;
  width?: number | string;
  title?: string;
}

export function SecondsDrag({ value, onDrag, onCommit, max = 30, width, title }: SecondsDragProps) {
  const { shown, preview, settle } = useDraftValue(value);
  return (
    <NumberDrag
      value={shown}
      min={0}
      max={max}
      step={0.01}
      precision={2}
      units="s"
      width={width}
      title={title}
      onChange={(v) => {
        preview(v);
        onDrag(v);
      }}
      onCommit={(v) => {
        onCommit(v);
        settle();
      }}
    />
  );
}

/* ============================================================================
 * Color swatch row (12-color track palette)
 * ========================================================================= */

export interface ColorSwatchesProps {
  current?: string;
  onPick: (color: string) => void;
}

export function ColorSwatches({ current, onPick }: ColorSwatchesProps) {
  const cur = (current ?? "").toLowerCase();
  return (
    <div className="insp-swatches">
      {TRACK_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className="insp-swatch"
          data-on={c.toLowerCase() === cur ? "true" : undefined}
          style={{ background: c }}
          title={c}
          onClick={() => onPick(c)}
          aria-label={`Color ${c}`}
        />
      ))}
    </div>
  );
}

/** Friendly message from a thrown WsRequestError / unknown. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
