/**
 * followPlayhead — the shared "keep the playhead on screen" rule.
 *
 * The Timeline had this logic inline; every other pane that draws a playhead needs the
 * SAME behaviour or "Follow Playhead" means something different depending on where you
 * look. Extracted so the Piano Roll, Sheet Music and the Timeline all page-jump
 * identically, and so the dead zone lives in one place.
 *
 * Page-jump, deliberately, not smooth scrolling: continuous scrolling at 20 Hz makes the
 * music appear to slide under a stationary cursor, which is much harder to read from
 * than a stable page that flips when the playhead runs off the edge (the behaviour
 * Cubase/Logic/Pro Tools all default to).
 */

import { manualScrollSuspended } from "./followSuspend";

export interface FollowGeometry {
  /** Playhead position in CONTENT pixels (not screen pixels). */
  x: number;
  /** Current horizontal scroll offset, content px. */
  scrollX: number;
  /** Visible width, px. */
  viewW: number;
  /** Total scrollable content width, px. */
  contentW: number;
}

export interface FollowTuning {
  /** Where the playhead lands after a jump, as a fraction of the viewport. */
  lead?: number;
  /** Dead zone: no jump while the playhead sits between these viewport fractions. */
  from?: number;
  to?: number;
}

/**
 * New scrollX to keep the playhead visible, or null when the view should stay put
 * (playhead already comfortably on screen, or nothing would change).
 */
export function followScrollX(g: FollowGeometry, tune: FollowTuning = {}): number | null {
  const lead = tune.lead ?? 0.1;
  const from = tune.from ?? 0.05;
  const to = tune.to ?? 0.8;
  if (g.viewW <= 0) return null;
  if (g.x >= g.scrollX + g.viewW * from && g.x <= g.scrollX + g.viewW * to) return null;
  const maxX = Math.max(0, g.contentW - g.viewW);
  const next = Math.max(0, Math.min(maxX, g.x - g.viewW * lead));
  return next === g.scrollX ? null : next;
}

/**
 * True when a pane should act on a transport tick: the user asked for follow AND is not
 * mid-navigation (manual scrolling suspends follow for ~1 s so dragging the view around
 * during playback doesn't fight the playhead).
 */
export function shouldFollow(followPlayhead: boolean): boolean {
  return followPlayhead && !manualScrollSuspended();
}
