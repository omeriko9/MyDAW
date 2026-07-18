/**
 * Small timeline-local UI bits (U1): the 12-color popover and a floating inline
 * text input (marker naming, clip/track rename at an arbitrary screen position).
 */

import { useEffect, useRef } from "react";
import { TRACK_COLORS } from "../../lib/canvas";

/* ============================================================================
 * ColorPopover — 12-color track palette picker at a fixed screen position
 * ========================================================================= */

export interface ColorPopoverProps {
  x: number;
  y: number;
  current?: string;
  onPick: (color: string) => void;
  onClose: () => void;
}

export function ColorPopover({ x, y, current, onPick, onClose }: ColorPopoverProps) {
  const w = 6 * 24 + 12;
  const left = Math.min(Math.max(4, x), window.innerWidth - w - 8);
  const top = Math.min(Math.max(4, y), window.innerHeight - 64);
  return (
    <div
      className="tl-pop-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      onWheel={() => onClose()}
    >
      <div className="tl-color-pop" style={{ left, top }}>
        {TRACK_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="tl-color-swatch"
            data-on={current && current.toLowerCase() === c.toLowerCase() ? "true" : undefined}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            onClick={() => {
              onPick(c);
              onClose();
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ============================================================================
 * FloatingInput — fixed-position inline text input (Enter commit, Esc cancel)
 * ========================================================================= */

export interface FloatingInputProps {
  x: number;
  y: number;
  width?: number;
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export function FloatingInput({
  x,
  y,
  width = 150,
  initial,
  placeholder,
  onCommit,
  onCancel,
}: FloatingInputProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(ref.current?.value ?? "");
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const left = Math.min(Math.max(4, x), window.innerWidth - width - 8);
  const top = Math.min(Math.max(4, y), window.innerHeight - 30);

  return (
    <input
      ref={ref}
      className="input tl-floating-input"
      style={{ left, top, width }}
      defaultValue={initial}
      placeholder={placeholder}
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") cancel();
      }}
      onBlur={commit}
    />
  );
}
