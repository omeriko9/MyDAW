/**
 * Take-lane UI state (SPEC §8.7) — which tracks show their take-folder lanes inline in
 * the arrangement. Local-only zustand store, deliberately NOT in store.ts (the
 * automationUi precedent): expansion is per-window view state, never persisted and
 * never engine-authoritative — Ctrl+Z after an edit restores the previous state via
 * the project mirror while the expansion survives, which is the desired behavior.
 */

import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { Project } from "../../protocol/types";

interface TakesUiState {
  /** tracks with their take lanes expanded */
  expanded: ReadonlySet<number>;
  setExpanded(trackId: number, on: boolean): void;
}

export const useTakesUi = create<TakesUiState>((set) => ({
  expanded: new Set<number>(),

  setExpanded: (trackId, on) =>
    set((s) => {
      if (s.expanded.has(trackId) === on) return s;
      const expanded = new Set(s.expanded);
      if (on) expanded.add(trackId);
      else expanded.delete(trackId);
      return { expanded };
    }),
}));

/**
 * Versions are shown BY DEFAULT wherever they exist (SPEC §8.7).
 *
 * Cubase draws lanes as sub-tracks; the stack IS the feature, so hiding it by default
 * hides the feature. A first attempt only expanded on a GAIN — which meant a folder that
 * already existed (opening a project, or folding clips with take.create) stayed collapsed,
 * and the reported problem — "I still can't see all versions at once" — survived the fix.
 * Verified in a browser 2026-08-11: after `cmd/take.create` the T toggle read
 * aria-pressed=false and the arrangement drew 0 lane rows until it was clicked.
 *
 * So: expand on FIRST SIGHT of a track that has lanes, and again whenever the lane count
 * grows. A user collapse sticks, because `seen` already holds that track's count and only
 * a genuine gain re-expands it. `seen` is per-mount, so a reload returns to
 * versions-visible — the default the user asked for, not a preference being overridden.
 */
export function useRevealNewTakeLanes(project: Project | null): void {
  const seen = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const next = new Map<number, number>();
    for (const t of project?.tracks ?? []) {
      // Total lanes across the track's folders: grows on every fold, whether the take
      // landed in an existing folder or created a new one.
      const lanes = (t.takeFolders ?? []).reduce((n, f) => n + f.lanes.length, 0);
      next.set(t.id, lanes);
      const before = seen.current.get(t.id);
      const firstSight = before === undefined && lanes > 0;
      if (firstSight || (before !== undefined && lanes > before))
        useTakesUi.getState().setExpanded(t.id, true);
    }
    seen.current = next;
  }, [project]);
}
