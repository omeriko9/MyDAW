/**
 * Reveal-position bus (owned by F4) — lets non-timeline UI (command palette,
 * future navigator) ask the arrangement view to bring a beat position into view
 * after a programmatic locate. The Timeline owns its viewport width, so it does
 * the actual scroll; everything else just announces the target.
 */

export const REVEAL_BEAT_EVENT = "mydaw:revealbeat";

export interface RevealBeatDetail {
  beat: number;
}

/** Ask the arrangement view to scroll the given beat into view. */
export function revealBeat(beat: number): void {
  window.dispatchEvent(
    new CustomEvent<RevealBeatDetail>(REVEAL_BEAT_EVENT, { detail: { beat } }),
  );
}
