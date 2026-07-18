/**
 * Follow-playhead suspension — a module-level timestamp shared between the manual
 * scroll writers (ClipCanvas pan, Timeline wheel / scrollbars / zoom anchor) and the
 * Timeline "J" follow subscription. Lives outside React on purpose: it is written at
 * gesture rate and read at transport-event rate (~20 Hz), and must never re-render.
 *
 * Every user-initiated viewport scroll calls noteManualScroll(); the follow page-jump
 * checks manualScrollSuspended() and stands down for graceMs after the last manual
 * write. Active gestures (pan pointermoves, wheel streams, scrollbar drags) keep
 * refreshing the timestamp, so the suspension covers the whole gesture with no
 * explicit gesture-end bookkeeping — it simply expires ~1 s after the last write and
 * the next out-of-band transport tick re-engages the follow (the standard DAW
 * auto-scroll-suspend behavior).
 */

let lastManualScrollAt = -Infinity;

/** Record a user-initiated viewport scroll (pan / wheel / scrollbar / zoom anchor). */
export function noteManualScroll(): void {
  lastManualScrollAt = performance.now();
}

/** True while within the grace window after the last manual scroll. */
export function manualScrollSuspended(graceMs = 1000): boolean {
  return performance.now() - lastManualScrollAt < graceMs;
}
