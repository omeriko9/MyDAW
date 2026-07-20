/**
 * NavigatorPill (UI_IMPROVE.md §1.1) — the arrange view's ZoomPill wiring.
 * 100% = the default 32 px/beat (store.ts prefViewport). Zoom keeps the view's
 * center anchored; button zooms animate (lib/viewportAnim, motion-gated), scrub
 * zooms are instant (continuous gesture).
 */

import React from "react";
import { useStore } from "../../store/store";
import { ZoomPill } from "../common/ZoomPill";
import { animateViewport } from "../../lib/viewportAnim";
import { zoomToFitPane } from "../../lib/keyboard";
import { MAX_ZOOM_X, MIN_ZOOM_X } from "./layout";

/** store.ts prefViewport default — the pill's 100% reference. */
const DEFAULT_ZOOM_X = 32;
const ZOOM_STEP = 1.3;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export default function NavigatorPill({ viewW }: { viewW: number }) {
  const zoomX = useStore((s) => s.viewport.zoomX);

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
    <ZoomPill
      title="Zoom — Ctrl+wheel over the arrangement, or G / H"
      fitTooltip="Fit the selection (or everything) into view (F)"
      pct={(zoomX / DEFAULT_ZOOM_X) * 100}
      minPct={(MIN_ZOOM_X / DEFAULT_ZOOM_X) * 100}
      maxPct={(MAX_ZOOM_X / DEFAULT_ZOOM_X) * 100}
      onPct={(p) => zoomTo((p / 100) * DEFAULT_ZOOM_X, false)}
      onFit={() => zoomToFitPane("timeline")}
      onZoomOut={() => zoomTo(zoomX / ZOOM_STEP, true)}
      onZoomIn={() => zoomTo(zoomX * ZOOM_STEP, true)}
    />
  );
}
