/**
 * ZoomPill (UI_IMPROVE.md §1.1, owned by F4) — the shared floating
 * [Fit][−][100%][+] zoom control docked bottom-right of a canvas pane. The
 * visible affordance for zoom (which is otherwise modifier-wheel/G/H only);
 * hovering it advertises those shortcuts. The % readout (when the pane has a
 * meaningful 100% reference) is a NumberDrag: scrub, wheel, double-click to
 * type. Position: absolute bottom-right — the parent must be positioned.
 */

import React from "react";
import { IconButton } from "./IconButton";
import { NumberDrag } from "./NumberDrag";

export interface ZoomPillProps {
  onFit: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  /** Percent readout (100 = the pane's default zoom). Omit for a Fit/−/+ pill. */
  pct?: number;
  minPct?: number;
  maxPct?: number;
  /** Absolute percent set (scrub/type). Required when pct is given. */
  onPct?: (pct: number) => void;
  fitTooltip?: string;
  title?: string;
  className?: string;
}

export function ZoomPill({
  onFit,
  onZoomOut,
  onZoomIn,
  pct,
  minPct,
  maxPct,
  onPct,
  fitTooltip = "Fit content into view (F)",
  title = "Zoom — Ctrl+wheel over the editor, or G / H",
  className,
}: ZoomPillProps) {
  return (
    <div className={"zoom-pill" + (className ? " " + className : "")} title={title}>
      <button type="button" className="zoom-pill-fit" title={fitTooltip} onClick={onFit}>
        Fit
      </button>
      <IconButton icon="zoomOut" size={20} tooltip="Zoom out (G)" onClick={onZoomOut} />
      {pct !== undefined && onPct && (
        <NumberDrag
          value={pct}
          min={minPct}
          max={maxPct}
          precision={0}
          units="%"
          width={52}
          title="Zoom level — drag, wheel, or double-click to type (100% = default)"
          onChange={onPct}
          onCommit={onPct}
        />
      )}
      <IconButton icon="zoomIn" size={20} tooltip="Zoom in (H)" onClick={onZoomIn} />
    </div>
  );
}
