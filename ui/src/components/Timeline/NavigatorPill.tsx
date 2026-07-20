/**
 * Navigator pill (UI_IMPROVE.md §1.1) — floating [Fit][−][100%][+] control in the
 * arrange view's bottom-right corner: the VISIBLE affordance for zoom, which was
 * previously modifier-wheel/keyboard-only. 100% = the default 32 px/beat. The %
 * readout is a NumberDrag (scrub, wheel, double-click to type). Zoom keeps the
 * view's center anchored; button zooms animate (lib/viewportAnim, motion-gated).
 */

import React from "react";
import { useStore } from "../../store/store";
import { IconButton } from "../common/IconButton";
import { NumberDrag } from "../common/NumberDrag";
import { animateViewport } from "../../lib/viewportAnim";
import { zoomToFitPane } from "../../lib/keyboard";
import { MAX_ZOOM_X, MIN_ZOOM_X } from "./layout";

/** store.ts prefViewport default — the pill's 100% reference. */
const DEFAULT_ZOOM_X = 32;
const ZOOM_STEP = 1.3;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export default function NavigatorPill({ viewW }: { viewW: number }) {
  const zoomX = useStore((s) => s.viewport.zoomX);
  const pct = (zoomX / DEFAULT_ZOOM_X) * 100;

  const zoomTo = (nextZoom: number, animate: boolean): void => {
    const s = useStore.getState();
    const v = s.viewport;
    const z = clamp(nextZoom, MIN_ZOOM_X, MAX_ZOOM_X);
    if (z === v.zoomX) return;
    const centerBeat = (v.scrollX + viewW / 2) / v.zoomX;
    const scrollX = Math.max(0, centerBeat * z - viewW / 2);
    if (animate) animateViewport({ zoomX: z, scrollX }, 140);
    else s.setViewport({ zoomX: z, scrollX });
  };

  return (
    <div className="tl-nav-pill" title={"Zoom — Ctrl+wheel over the arrangement, or G / H"}>
      <button
        type="button"
        className="tl-nav-fit"
        title="Fit the selection (or everything) into view (F)"
        onClick={() => zoomToFitPane("timeline")}
      >
        Fit
      </button>
      <IconButton
        icon="zoomOut"
        size={20}
        tooltip="Zoom out (G)"
        onClick={() => zoomTo(zoomX / ZOOM_STEP, true)}
      />
      <NumberDrag
        value={pct}
        min={(MIN_ZOOM_X / DEFAULT_ZOOM_X) * 100}
        max={(MAX_ZOOM_X / DEFAULT_ZOOM_X) * 100}
        precision={0}
        units="%"
        width={52}
        title="Zoom level — drag, wheel, or double-click to type (100% = default)"
        onChange={(p) => zoomTo((p / 100) * DEFAULT_ZOOM_X, false)}
        onCommit={(p) => zoomTo((p / 100) * DEFAULT_ZOOM_X, false)}
      />
      <IconButton
        icon="zoomIn"
        size={20}
        tooltip="Zoom in (H)"
        onClick={() => zoomTo(zoomX * ZOOM_STEP, true)}
      />
    </div>
  );
}
