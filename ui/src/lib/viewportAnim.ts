/**
 * Smooth viewport animation (UI_IMPROVE.md §1.4, owned by F4) — programmatic
 * arrange-view jumps (zoom-to-fit, navigator pill, palette/minimap reveals) glide
 * over ~180ms instead of teleporting, preserving spatial continuity. Honors the
 * motion setting: anything below "full" (user pref or OS reduced-motion) applies
 * the patch instantly — this is exactly the movement --dur-move gates in CSS.
 *
 * One animation at a time; starting a new one retargets from the current values.
 * User gestures that write the viewport directly simply race the last few frames
 * (durations are short); call cancelViewportAnimation() from gesture starts that
 * must own the viewport outright.
 */

import { useStore, type Viewport } from "../store/store";
import { getEffectiveMotion } from "./motion";

type ViewportPatch = Partial<Pick<Viewport, "zoomX" | "zoomY" | "scrollX" | "scrollY">>;

let raf = 0;

export function cancelViewportAnimation(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export function animateViewport(patch: ViewportPatch, ms = 180): void {
  cancelViewportAnimation();
  const store = useStore.getState();
  if (getEffectiveMotion() !== "full" || ms <= 0) {
    store.setViewport(patch);
    return;
  }
  const keys = Object.keys(patch) as Array<keyof ViewportPatch>;
  const from: ViewportPatch = {};
  for (const k of keys) from[k] = store.viewport[k];
  const t0 = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - t0) / ms);
    const k = easeOutCubic(t);
    const cur: ViewportPatch = {};
    for (const key of keys) cur[key] = from[key]! + (patch[key]! - from[key]!) * k;
    useStore.getState().setViewport(cur);
    raf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  raf = requestAnimationFrame(step);
}
