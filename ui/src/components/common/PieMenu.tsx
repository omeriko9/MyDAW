/**
 * PieMenu — radial gesture menu (Blender/Maya style), opened by a stationary
 * MIDDLE-CLICK on a canvas pane (middle-DRAG still pans; the caller decides).
 *
 *   openPieMenu(e.clientX, e.clientY, [{ icon, label, onClick, active? }, ...]);
 *
 * Items sit on a circle starting at 12 o'clock, clockwise; the hovered item's
 * label shows in the center chip. Click an item to run it; click anywhere else,
 * Escape, wheel or right-click closes. Imperative singleton (ContextMenu
 * pattern) rendered into its own portal root; keydown is swallowed while open
 * so global shortcuts can't fire underneath.
 */

import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Icon, type IconName } from "./icons";

export interface PieItem {
  icon: IconName;
  label: string;
  active?: boolean;
  onClick: () => void;
}

const RADIUS = 82;
const CLAMP_PAD = RADIUS + 46;

let host: HTMLDivElement | null = null;
let reactRoot: Root | null = null;
let openSeq = 0;

export function openPieMenu(x: number, y: number, items: PieItem[]): void {
  if (!reactRoot) {
    host = document.createElement("div");
    host.id = "mydaw-pie-root";
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  }
  reactRoot.render(<PieOverlay key={++openSeq} x={x} y={y} items={items} />);
}

export function closePieMenu(): void {
  reactRoot?.render(null);
}

function PieOverlay({ x, y, items }: { x: number; y: number; items: PieItem[] }) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<number>(-1);

  const cx = Math.min(Math.max(x, CLAMP_PAD), window.innerWidth - CLAMP_PAD);
  const cy = Math.min(Math.max(y, CLAMP_PAD), window.innerHeight - CLAMP_PAD);

  useEffect(() => {
    overlayRef.current?.focus();
    const onAway = () => closePieMenu();
    window.addEventListener("blur", onAway);
    window.addEventListener("resize", onAway);
    return () => {
      window.removeEventListener("blur", onAway);
      window.removeEventListener("resize", onAway);
    };
  }, []);

  const pick = (it: PieItem): void => {
    closePieMenu();
    it.onClick();
  };

  return (
    <div
      ref={overlayRef}
      className="pie-overlay"
      tabIndex={-1}
      onKeyDown={(e) => {
        e.stopPropagation(); // own the keyboard while open
        if (e.key === "Escape") closePieMenu();
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closePieMenu();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        closePieMenu();
      }}
      onWheel={() => closePieMenu()}
    >
      {items.map((it, i) => {
        const ang = -Math.PI / 2 + (i * 2 * Math.PI) / items.length;
        const ix = cx + RADIUS * Math.cos(ang);
        const iy = cy + RADIUS * Math.sin(ang);
        return (
          <button
            key={i}
            type="button"
            className={
              "pie-item" + (it.active ? " on" : "") + (hover === i ? " hover" : "")
            }
            style={{ left: ix, top: iy }}
            title={it.label}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover((h) => (h === i ? -1 : h))}
            onClick={() => pick(it)}
            // middle-click selects too — the finger that opened the pie can pick
            onAuxClick={(e) => {
              if (e.button === 1) pick(it);
            }}
          >
            <Icon name={it.icon} size={18} />
          </button>
        );
      })}
      <div className="pie-center" style={{ left: cx, top: cy }}>
        {hover >= 0 ? items[hover].label : "·"}
      </div>
    </div>
  );
}
