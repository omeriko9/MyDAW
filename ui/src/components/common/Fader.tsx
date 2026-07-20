/**
 * Fader — vertical channel fader with dB taper (owned by F4).
 *
 * Mapping (SPEC §9): position p∈[0,1] ↔ dB via  db = p*72 - 60  (range -60..+12 dB,
 * 0 dB marker at p = 60/72). `value` is LINEAR gain (1 = 0 dB); value 0 / p 0 = -inf.
 *
 * Ergonomics: drag = absolute positioning (grab the cap anywhere, click track jumps),
 * Shift = fine relative drag, double-click resets to 0 dB (gain 1), wheel ±1 dB
 * (Shift ±0.2 dB), arrow keys ±1 dB (Shift ±0.2 dB) when focused, Escape cancels the
 * drag. onChange streams (send transient), onCommit fires once on release.
 */

import React, { useEffect, useRef, useState } from "react";
import { ValueHud } from "./ValueHud";

export const FADER_DB_MIN = -60;
export const FADER_DB_MAX = 12;
const DB_SPAN = FADER_DB_MAX - FADER_DB_MIN; // 72

export function gainToDb(gain: number): number {
  return 20 * Math.log10(gain);
}
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
/** Linear gain → fader position [0,1] (0 / -inf clamps to 0). */
export function gainToPos(gain: number): number {
  if (!(gain > 0)) return 0;
  const db = gainToDb(gain);
  return Math.min(1, Math.max(0, (db - FADER_DB_MIN) / DB_SPAN));
}
/** Fader position [0,1] → linear gain (0 → 0 = -inf). */
export function posToGain(pos: number): number {
  if (pos <= 0) return 0;
  return dbToGain(FADER_DB_MIN + Math.min(1, pos) * DB_SPAN);
}
/** "x.x dB" display text ("-inf" at 0). */
export function gainToDbText(gain: number): string {
  if (!(gain > 0)) return "-inf";
  const db = gainToDb(gain);
  return (db > 0 ? "+" : "") + db.toFixed(1);
}

const TICK_DBS = [12, 6, 0, -6, -12, -24, -36, -48, -60];
const PAD = 8; // px travel inset so the cap stays inside

export interface FaderProps {
  /** Linear gain (1 = 0 dB). */
  value: number;
  onChange: (gain: number) => void;
  onCommit?: (gain: number) => void;
  height?: number; // px, default 140
  width?: number; // px, default 36
  disabled?: boolean;
  className?: string;
  /** Hide the dB tick marks (narrow strips). */
  noTicks?: boolean;
  title?: string;
}

export function Fader({
  value,
  onChange,
  onCommit,
  height = 140,
  width = 36,
  disabled,
  className,
  noTicks,
  title,
}: FaderProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ grabDy: number; lastY: number; pos: number; startGain: number } | null>(null);

  const travel = height - 2 * PAD;
  const posToY = (p: number) => PAD + (1 - p) * travel;
  const yToPos = (y: number) => Math.min(1, Math.max(0, (travel - (y - PAD)) / travel));

  const emit = (p: number) => onChange(posToGain(p));

  // Escape cancels drag.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag.current) {
        const g = drag.current.startGain;
        drag.current = null;
        setDragging(false);
        onChange(g);
        onCommit?.(g);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  // Non-passive wheel: ±1 dB, Shift ±0.2 dB. value/onChange/onCommit are mirrored
  // into refs so the handler (registered once per [disabled]) never dispatches to a
  // stale entity's callbacks when the component instance is reused.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const stepDb = e.shiftKey ? 0.2 : 1;
      const curDb = valueRef.current > 0 ? gainToDb(valueRef.current) : FADER_DB_MIN;
      const db = Math.min(FADER_DB_MAX, Math.max(FADER_DB_MIN, curDb + dir * stepDb));
      const g = db <= FADER_DB_MIN ? 0 : dbToGain(db);
      onChangeRef.current(g);
      onCommitRef.current?.(g);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const localY = (clientY: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return clientY - rect.top;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const y = localY(e.clientY);
    const pos = gainToPos(value);
    const handleY = posToY(pos);
    // Grab the cap (keep offset) if hit within it, else jump.
    const grabDy = Math.abs(y - handleY) <= 8 ? handleY - y : 0;
    const p = grabDy !== 0 ? pos : yToPos(y);
    drag.current = { grabDy, lastY: e.clientY, pos: p, startGain: value };
    setDragging(true);
    if (grabDy === 0) emit(p);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (e.shiftKey) {
      // fine: relative, 5x slower
      d.pos = Math.min(1, Math.max(0, d.pos + (d.lastY - e.clientY) / travel / 5));
    } else {
      d.pos = yToPos(localY(e.clientY) + d.grabDy);
    }
    d.lastY = e.clientY;
    emit(d.pos);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    onCommit?.(posToGain(d.pos));
  };
  const onDoubleClick = () => {
    if (disabled) return;
    onChange(1);
    onCommit?.(1);
  };

  // Keyboard: the fader is a focusable role="slider" — arrows step ±1 dB (Shift ±0.2 dB),
  // mirroring the wheel. Consumed so the global shortcut layer never sees them.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const dir =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (dir === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const stepDb = e.shiftKey ? 0.2 : 1;
    const curDb = value > 0 ? gainToDb(value) : FADER_DB_MIN;
    const db = Math.min(FADER_DB_MAX, Math.max(FADER_DB_MIN, curDb + dir * stepDb));
    const g = db <= FADER_DB_MIN ? 0 : dbToGain(db);
    onChange(g);
    onCommit?.(g);
  };

  const pos = gainToPos(value);
  const handleY = posToY(pos);

  return (
    <div
      ref={ref}
      className={"fader" + (disabled ? " disabled" : "") + (className ? " " + className : "")}
      style={{ width, height }}
      data-dragging={dragging ? "true" : undefined}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={pos}
      aria-valuetext={gainToDbText(value) + " dB"}
      aria-orientation="vertical"
      tabIndex={disabled ? undefined : 0}
    >
      <ValueHud
        anchor={ref.current}
        visible={dragging}
        text={`${gainToDbText(value)} dB`}
        hint="⇧ fine · Esc cancel"
      />
      <div className="fader-groove" style={{ top: PAD, bottom: PAD }} />
      {!noTicks &&
        TICK_DBS.map((db) => {
          const y = posToY((db - FADER_DB_MIN) / DB_SPAN);
          const zero = db === 0;
          return (
            <div
              key={db}
              className={"fader-tick" + (zero ? " zero" : "")}
              style={{
                top: y,
                left: zero ? 2 : 5,
                right: zero ? 2 : 5,
              }}
            />
          );
        })}
      <div className="fader-handle" style={{ top: handleY }} />
    </div>
  );
}
