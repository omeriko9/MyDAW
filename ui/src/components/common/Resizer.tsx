/**
 * Resizer — drag handle for panel resizing (owned by F4).
 *
 * dir "v" = vertical bar between left/right panels (drag along x, col-resize cursor);
 * dir "h" = horizontal bar between top/bottom panels (drag along y, row-resize cursor).
 * Emits incremental `delta` (px since last event) and `total` (since drag start) —
 * positive = right/down. Double-click fires `onReset` (e.g. restore default size).
 * Invisible until hover/drag (accent highlight), 5px hit area overlapping neighbors.
 */

import React, { useRef, useState } from "react";

export interface ResizerProps {
  dir: "h" | "v";
  /** Called on every move: delta since last call, total since pointer-down. */
  onResize: (delta: number, total: number) => void;
  onStart?: () => void;
  onEnd?: (total: number) => void;
  /** Double-click (typically: reset panel to default size). */
  onReset?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function Resizer({ dir, onResize, onStart, onEnd, onReset, className, style }: ResizerProps) {
  const [active, setActive] = useState(false);
  const drag = useRef<{ start: number; last: number } | null>(null);

  const coord = (e: React.PointerEvent) => (dir === "v" ? e.clientX : e.clientY);

  return (
    <div
      className={`resizer resizer-${dir}` + (className ? " " + className : "")}
      style={style}
      data-active={active ? "true" : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const c = coord(e);
        drag.current = { start: c, last: c };
        setActive(true);
        onStart?.();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const c = coord(e);
        const delta = c - d.last;
        if (delta === 0) return;
        d.last = c;
        onResize(delta, c - d.start);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        setActive(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        onEnd?.(coord(e) - d.start);
      }}
      onPointerCancel={(e) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        setActive(false);
        onEnd?.(coord(e) - d.start);
      }}
      onDoubleClick={onReset}
    />
  );
}
