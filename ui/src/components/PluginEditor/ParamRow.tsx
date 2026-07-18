/**
 * One parameter row of the generic plugin editor (U6).
 *
 * name | slider (input range, theme-styled) | NumberDrag showing the engine valueText
 * (double-click types an exact normalized 0..1 value). Stepped params (steps > 1)
 * quantize both controls to 1/(steps-1).
 *
 * Memoized — with 1000+ params only the rows whose param object changed re-render.
 * onChange streams during a gesture (caller sends transient cmd/plugin.setParam),
 * onCommit fires once at gesture end (caller sends the non-transient final value).
 */

import React, { memo, useRef } from "react";
import type { PluginParam } from "../../protocol/types";
import { NumberDrag } from "../common/NumberDrag";

export interface ParamRowProps {
  param: PluginParam;
  onChange: (id: number, value: number) => void;
  onCommit: (id: number, value: number) => void;
  onMenu: (e: React.MouseEvent, param: PluginParam) => void;
}

const RANGE_COMMIT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

const ParamRow = memo(function ParamRow({ param: p, onChange, onCommit, onMenu }: ParamRowProps) {
  // True once a gesture (slider drag / keyboard) changed the value — commit only then,
  // so a click without movement creates no spurious undo entry.
  const dirtyRef = useRef(false);

  const stepped = p.steps !== undefined && p.steps > 1;
  const step = stepped ? 1 / ((p.steps as number) - 1) : 0.0001;

  // Defensive: the engine can report a non-finite value (NaN/Infinity) or omit
  // valueText. Clamp to 0..1 (falling back to default) and coerce text to a string
  // so render math and string methods never throw.
  const v = Number.isFinite(p.value) ? Math.min(1, Math.max(0, p.value)) : (p.defaultValue ?? 0);
  const vt = typeof p.valueText === "string" ? p.valueText : "";

  const commitIfDirty = (value: number) => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    onCommit(p.id, value);
  };

  return (
    <div className="pe-row" onContextMenu={(e) => onMenu(e, p)}>
      <span className="pe-name ellipsis" title={`${p.name} (#${p.id})`}>
        {p.name}
      </span>
      <input
        type="range"
        className="pe-slider"
        min={0}
        max={1}
        step={step}
        value={v}
        aria-label={p.name}
        onChange={(e) => {
          dirtyRef.current = true;
          onChange(p.id, Number(e.currentTarget.value));
        }}
        onPointerUp={(e) => commitIfDirty(Number(e.currentTarget.value))}
        onKeyUp={(e) => {
          if (RANGE_COMMIT_KEYS.has(e.key)) commitIfDirty(Number(e.currentTarget.value));
        }}
        onBlur={(e) => commitIfDirty(Number(e.currentTarget.value))}
      />
      <NumberDrag
        width={92}
        value={v}
        min={0}
        max={1}
        step={stepped ? step : 0.001}
        precision={3}
        format={() =>
          vt !== ""
            ? vt + (p.label !== "" && !vt.includes(p.label) ? ` ${p.label}` : "")
            : v.toFixed(3)
        }
        title={`${p.name}: drag, or double-click to type an exact 0..1 value`}
        onChange={(v) => {
          dirtyRef.current = true;
          onChange(p.id, v);
        }}
        onCommit={(v) => {
          dirtyRef.current = false;
          onCommit(p.id, v);
        }}
      />
    </div>
  );
});

export default ParamRow;
