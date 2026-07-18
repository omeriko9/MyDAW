/**
 * NumberDrag — drag-to-change numeric field (owned by F4).
 *
 * Ergonomics: vertical drag changes the value (Shift = 10x finer), mouse wheel steps,
 * double-click (or Enter when focused) switches to a text input (Enter commits, Escape
 * cancels, blur commits), Up/Down arrows step when focused (Shift = 10x finer), Escape
 * during a drag cancels it. onChange streams during the gesture, onCommit fires at the
 * end (release / typed entry / wheel / arrow key).
 */

import React, { useEffect, useRef, useState } from "react";

export interface NumberDragProps {
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  /** Wheel/typing quantum and drag rounding. Default 10^-precision. */
  step?: number;
  /** Display decimals (default 2; ignored when `format` given). */
  precision?: number;
  /** Unit suffix rendered dim (e.g. "dB", "BPM", "ms"). */
  units?: string;
  /** Value change per dragged pixel. Default: step (or range/200 when min+max given). */
  speed?: number;
  format?: (value: number) => string;
  /** Parse typed text; return null to reject. Default parseFloat. */
  parse?: (text: string) => number | null;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  width?: number | string;
  title?: string;
}

export function NumberDrag({
  value,
  onChange,
  onCommit,
  min,
  max,
  step,
  precision = 2,
  units,
  speed,
  format,
  parse,
  disabled,
  className,
  style,
  width,
  title,
}: NumberDragProps) {
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const drag = useRef<{ lastY: number; acc: number; startVal: number; moved: boolean } | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const stepQ = step ?? Math.pow(10, -precision);
  const clamp = (v: number) => {
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };
  const quant = (v: number) => {
    const q = Math.round(v / stepQ) * stepQ;
    // kill float noise (e.g. 0.30000000000000004)
    return clamp(parseFloat(q.toFixed(10)));
  };
  const dragSpeed =
    speed ?? (min !== undefined && max !== undefined ? Math.max(stepQ, (max - min) / 200) : stepQ);

  /* ---- drag ---- */
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

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || editing !== null || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { lastY: e.clientY, acc: value, startVal: value, moved: false };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.lastY - e.clientY;
    if (dy === 0) return;
    d.lastY = e.clientY;
    d.moved = true;
    d.acc = clamp(d.acc + dy * dragSpeed * (e.shiftKey ? 0.1 : 1));
    onChange(quant(d.acc));
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
    if (d.moved) onCommit?.(quant(d.acc));
  };

  /* ---- wheel (non-passive so we can preventDefault) ----
   * value/onChange/onCommit are mirrored into refs so the handler (registered once
   * per [disabled,min,max,step,precision,editing]) never dispatches to a stale
   * entity's callbacks when the component instance is reused. */
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  useEffect(() => {
    const el = elRef.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      // Shift = 1/10 step fine control (intentionally allowed to land between steps).
      const inc = stepQ * (e.shiftKey ? 0.1 : 1);
      const out = clamp(parseFloat((valueRef.current + dir * inc).toFixed(10)));
      onChangeRef.current(out);
      onCommitRef.current?.(out);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, min, max, step, precision, editing]);

  /* ---- type-in ---- */
  const startEdit = () => {
    if (disabled) return;
    drag.current = null;
    setDragging(false);
    setEditing(format ? String(parseFloat(value.toFixed(precision))) : value.toFixed(precision));
  };
  useEffect(() => {
    if (editing !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitEdit = (text: string) => {
    setEditing(null);
    const parsed = parse ? parse(text) : parseFloat(text.replace(",", "."));
    if (parsed === null || parsed === undefined || Number.isNaN(parsed)) return;
    const v = quant(parsed);
    onChange(v);
    onCommit?.(v);
  };

  if (editing !== null) {
    return (
      <input
        ref={inputRef}
        className="numdrag-input"
        style={{ width: width ?? 56, ...style }}
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={(e) => commitEdit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitEdit((e.target as HTMLInputElement).value);
          else if (e.key === "Escape") {
            setEditing(null);
            e.stopPropagation();
          }
        }}
      />
    );
  }

  const text = format ? format(value) : value.toFixed(precision);

  // Keyboard: focusable role="spinbutton" — Up/Down step like the wheel (Shift = 1/10
  // fine), Enter opens the type-in editor. Consumed so global shortcuts never see them.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      startEdit();
      return;
    }
    const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const inc = stepQ * (e.shiftKey ? 0.1 : 1);
    const out = clamp(parseFloat((value + dir * inc).toFixed(10)));
    onChange(out);
    onCommit?.(out);
  };

  return (
    <div
      ref={elRef}
      className={"numdrag" + (disabled ? " disabled" : "") + (className ? " " + className : "")}
      style={width !== undefined ? { width, ...style } : style}
      data-dragging={dragging ? "true" : undefined}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={startEdit}
      onKeyDown={onKeyDown}
      role="spinbutton"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={text + (units ? ` ${units}` : "")}
      tabIndex={disabled ? undefined : 0}
    >
      <span>{text}</span>
      {units ? <span className="numdrag-units">{units}</span> : null}
    </div>
  );
}
