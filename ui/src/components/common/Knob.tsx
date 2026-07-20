/**
 * Knob — rotary control (owned by F4).
 *
 * Ergonomics: vertical pointer drag (full range over ~150px), Shift = fine (8x slower),
 * double-click resets to defaultValue, mouse wheel steps, arrow keys step when focused
 * (Shift = fine, mirroring the wheel), Escape cancels an active drag.
 * Rendering: SVG arc from -135° to +135°; `bipolar` draws the value arc from 12 o'clock.
 * While hovering/dragging the caption shows the value instead of the label.
 *
 * onChange fires continuously during the gesture (send transient), onCommit once at the end.
 */

import React, { useEffect, useRef, useState } from "react";
import { ValueHud } from "./ValueHud";

export interface KnobProps {
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  min?: number; // default 0
  max?: number; // default 1
  /** Double-click reset target. Default: center for bipolar, min otherwise. */
  defaultValue?: number;
  /** Draw the value arc from the 12 o'clock center (pan-style). */
  bipolar?: boolean;
  /** Quantize emitted values to this step. */
  step?: number;
  size?: number; // px, default 36
  label?: string;
  /** Value → display text (e.g. dB / %). Default: 2 decimals. */
  format?: (value: number) => string;
  disabled?: boolean;
  className?: string;
  title?: string;
}

const ARC = 135; // degrees each side of 12 o'clock

function polar(cx: number, cy: number, r: number, angDeg: number): [number, number] {
  const a = ((angDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function Knob({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 1,
  defaultValue,
  bipolar,
  step,
  size = 36,
  label,
  format,
  disabled,
  className,
  title,
}: KnobProps) {
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ lastY: number; acc: number; startVal: number } | null>(null);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const quant = (v: number) => {
    if (step && step > 0) v = Math.round((v - min) / step) * step + min;
    return clamp(v);
  };
  const range = max - min || 1;
  const resetVal = defaultValue ?? (bipolar ? min + range / 2 : min);

  // Escape cancels the drag, restoring the gesture start value.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag.current) {
        const v = drag.current.startVal;
        drag.current = null;
        setDragging(false);
        onChange(v);
        onCommit?.(v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  // Non-passive wheel (so we can preventDefault page scroll). value/onChange/onCommit
  // go through refs so the handler (registered once per [disabled,min,max,step]) never
  // dispatches to a stale entity's callbacks when the component instance is reused.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  useEffect(() => {
    const el = svgRef.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const inc = (e.shiftKey ? range / 400 : range / 50) * dir;
      const v = quant(valueRef.current + inc);
      onChangeRef.current(v);
      onCommitRef.current?.(v);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, min, max, step]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { lastY: e.clientY, acc: value, startVal: value };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.lastY - e.clientY;
    d.lastY = e.clientY;
    const sens = (range / 150) * (e.shiftKey ? 1 / 8 : 1);
    d.acc = clamp(d.acc + dy * sens);
    onChange(quant(d.acc));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    onCommit?.(quant(d.acc));
  };
  const onDoubleClick = () => {
    if (disabled) return;
    const v = quant(resetVal);
    onChange(v);
    onCommit?.(v);
  };

  // Keyboard: the knob is a focusable role="slider" — arrows step like the wheel
  // (range/50, Shift = range/400 fine). Consumed so global shortcuts never see them.
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
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
    const inc = (e.shiftKey ? range / 400 : range / 50) * dir;
    const v = quant(value + inc);
    onChange(v);
    onCommit?.(v);
  };

  /* ---- render ---- */
  // Defensive: a non-finite value (e.g. NaN pan/send from the engine) would yield
  // NaN SVG coords and a 'NaN' caption. Fall back to the reset/min value for geometry.
  const v0 = Number.isFinite(value) ? value : (defaultValue ?? min);
  const t = Math.min(1, Math.max(0, (v0 - min) / range));
  const c = size / 2;
  const r = size / 2 - 3;
  const ang = -ARC + 270 * t;
  const fromAng = bipolar ? 0 : -ARC;
  const [ix0, iy0] = polar(c, c, r * 0.35, ang);
  const [ix1, iy1] = polar(c, c, r * 0.82, ang);

  const valueText = format ? format(v0) : v0.toFixed(2);
  const showValue = dragging || hover || !label;

  return (
    <div
      className={"knob" + (disabled ? " disabled" : "") + (className ? " " + className : "")}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <svg
        ref={svgRef}
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={v0}
        aria-valuetext={valueText}
        aria-label={label}
        tabIndex={disabled ? undefined : 0}
      >
        {/* track */}
        <path d={arcPath(c, c, r, -ARC, ARC)} stroke="var(--border-light)" strokeWidth={2.5} fill="none" strokeLinecap="round" />
        {/* value */}
        {Math.abs(ang - fromAng) > 0.5 && (
          <path
            d={arcPath(c, c, r, Math.min(fromAng, ang), Math.max(fromAng, ang))}
            stroke="var(--accent)"
            strokeWidth={2.5}
            fill="none"
            strokeLinecap="round"
          />
        )}
        {/* body */}
        <circle cx={c} cy={c} r={r * 0.62} fill="var(--knob-face)" stroke="var(--knob-edge)" strokeWidth={1} />
        {/* indicator */}
        <line x1={ix0} y1={iy0} x2={ix1} y2={iy1} stroke="var(--pointer)" strokeWidth={1.5} strokeLinecap="round" />
      </svg>
      <ValueHud
        anchor={svgRef.current}
        visible={dragging}
        text={label ? `${label} ${valueText}` : valueText}
        hint="⇧ fine · Esc cancel"
      />
      <div className={"knob-caption" + (showValue ? " value" : "")}>
        {showValue ? valueText : label}
      </div>
    </div>
  );
}
