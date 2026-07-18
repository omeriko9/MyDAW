/**
 * Tooltip — title-like hover tooltip with delay (owned by F4).
 *
 * Wraps a single React element (it must forward DOM mouse events, which all intrinsic
 * elements and our common components do). Shows a portal'd `.tooltip` after `delay` ms,
 * positioned relative to the hovered element's rect and clamped to the viewport.
 * Hidden on mouse leave / pointer down / scroll.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface TooltipProps {
  content: React.ReactNode;
  /** Single element to attach to. */
  children: React.ReactElement;
  /** ms before showing (default 500). */
  delay?: number;
  side?: "top" | "bottom";
  disabled?: boolean;
}

interface Shown {
  rect: DOMRect;
}

export function Tooltip({ content, children, delay = 500, side = "bottom", disabled }: TooltipProps) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timerRef = useRef<number>(0);
  const tipRef = useRef<HTMLDivElement | null>(null);

  const clear = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
  };
  const hide = () => {
    clear();
    setShown(null);
    setPos(null);
  };

  useEffect(() => clear, []);
  useEffect(() => {
    if (!shown) return;
    const onAny = () => hide();
    window.addEventListener("scroll", onAny, true);
    window.addEventListener("blur", onAny);
    return () => {
      window.removeEventListener("scroll", onAny, true);
      window.removeEventListener("blur", onAny);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  // Measure + clamp after the tooltip renders.
  useLayoutEffect(() => {
    if (!shown || !tipRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    const r = shown.rect;
    let x = r.left + r.width / 2 - tip.width / 2;
    let y = side === "top" ? r.top - tip.height - 6 : r.bottom + 6;
    x = Math.max(4, Math.min(x, window.innerWidth - tip.width - 4));
    if (y + tip.height > window.innerHeight - 4) y = r.top - tip.height - 6;
    if (y < 4) y = r.bottom + 6;
    setPos({ x, y });
  }, [shown, side]);

  if (disabled || content == null || content === "") return children;

  const childProps = (children as React.ReactElement<Record<string, unknown>>).props;
  const child = React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      (childProps.onMouseEnter as React.MouseEventHandler | undefined)?.(e);
      const rect = e.currentTarget.getBoundingClientRect();
      clear();
      timerRef.current = window.setTimeout(() => setShown({ rect }), delay);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      (childProps.onMouseLeave as React.MouseEventHandler | undefined)?.(e);
      hide();
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      (childProps.onPointerDown as React.PointerEventHandler | undefined)?.(e);
      hide();
    },
  });

  return (
    <>
      {child}
      {shown
        ? createPortal(
            <div
              ref={tipRef}
              className="tooltip"
              style={{
                left: pos ? pos.x : -9999,
                top: pos ? pos.y : -9999,
                visibility: pos ? "visible" : "hidden",
              }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
