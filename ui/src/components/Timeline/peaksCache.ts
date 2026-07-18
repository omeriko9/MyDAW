/**
 * Synchronous-friendly wrapper over lib/peaks for canvas rendering (U1).
 *
 * The clip canvas asks for peaks every frame; this returns the exact lod when it is
 * already loaded, kicks off an async fetch otherwise, and falls back to the closest
 * already-loaded lod of the same asset so something draws immediately. `onArrive`
 * is invoked when a fetch lands (callers schedule a redraw).
 */

import { fetchPeaks, PEAK_MAX_LOD, type PeakLod } from "../../lib/peaks";

const ready = new Map<string, PeakLod>();
const pending = new Set<string>();
const failed = new Set<string>();
// Bumped by dropPeaks(): an in-flight fetch started before the drop must not land its
// (possibly stale — project replaced, ids recycle) result in `ready` afterwards.
let epoch = 0;

const FAIL_RETRY_MS = 15_000;

export function peaksFor(
  assetId: number,
  lod: number,
  channels: number,
  onArrive: () => void,
): PeakLod | null {
  const clamped = Math.max(0, Math.min(Math.trunc(lod), PEAK_MAX_LOD));
  const key = `${assetId}:${clamped}`;
  const exact = ready.get(key);
  if (exact) return exact;

  if (!pending.has(key) && !failed.has(key)) {
    pending.add(key);
    const fetchEpoch = epoch;
    fetchPeaks(assetId, clamped, Math.max(1, channels))
      .then((l) => {
        pending.delete(key);
        if (fetchEpoch === epoch) ready.set(key, l); // dropped since → discard, refetch
        onArrive();
      })
      .catch(() => {
        pending.delete(key);
        if (fetchEpoch === epoch) {
          failed.add(key);
          window.setTimeout(() => failed.delete(key), FAIL_RETRY_MS);
        }
        onArrive(); // let callers repaint into their failed state
      });
  }

  // Fall back to the closest lod we already have for this asset.
  let best: PeakLod | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let l = 0; l <= PEAK_MAX_LOD; l++) {
    if (l === clamped) continue;
    const alt = ready.get(`${assetId}:${l}`);
    if (alt) {
      const d = Math.abs(l - clamped);
      if (d < bestDist) {
        best = alt;
        bestDist = d;
      }
    }
  }
  return best;
}

/** True while the last fetch for this asset/lod failed (auto-retries after a pause). */
export function peaksFailed(assetId: number, lod: number): boolean {
  const clamped = Math.max(0, Math.min(Math.trunc(lod), PEAK_MAX_LOD));
  return failed.has(`${assetId}:${clamped}`);
}

/**
 * Drop cached peaks (project replaced / asset reconciled / relink / re-record).
 * Also clears the failure backoff — after the engine reconciles an asset record the
 * retry must be immediate, not after the 15 s pause — and bumps the epoch so an
 * in-flight fetch from before the drop cannot repopulate `ready` with stale data.
 */
export function dropPeaks(assetId?: number): void {
  epoch++;
  if (assetId === undefined) {
    ready.clear();
    failed.clear();
    return;
  }
  const prefix = `${assetId}:`;
  for (const k of [...ready.keys()]) if (k.startsWith(prefix)) ready.delete(k);
  for (const k of [...failed]) if (k.startsWith(prefix)) failed.delete(k);
}
