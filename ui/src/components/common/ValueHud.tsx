/**
 * ValueHud (UI_IMPROVE.md §3.1, owned by F4) — large transient readout floating
 * above a control while it is being dragged ("−3.2 dB"), with an optional dim
 * hint line ("⇧ fine"). Small captions are fine at rest; during a grab the eyes
 * are on the mouse target and precision feedback must be readable at a glance.
 *
 * Portals into the anchor's ownerDocument body so it works inside popped-out
 * panes (mixer in its own window). Pointer-events: none; positioned above the
 * anchor, re-measured on every render (drags re-render per move anyway).
 */

import React from "react";
import { createPortal } from "react-dom";

export interface ValueHudProps {
  /** The control being dragged — the HUD floats above its rect. */
  anchor: HTMLElement | SVGElement | null;
  visible: boolean;
  text: string;
  /** Dim second line, e.g. "⇧ fine". */
  hint?: string;
}

export function ValueHud({ anchor, visible, text, hint }: ValueHudProps) {
  if (!visible || !anchor) return null;
  const rect = anchor.getBoundingClientRect();
  return createPortal(
    <div
      className="value-hud"
      style={{ left: rect.left + rect.width / 2, top: rect.top - 8 }}
      role="status"
    >
      <div className="value-hud-text">{text}</div>
      {hint ? <div className="value-hud-hint">{hint}</div> : null}
    </div>,
    anchor.ownerDocument.body,
  );
}
