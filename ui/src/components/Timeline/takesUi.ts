/**
 * Take-lane UI state (SPEC §8.7) — which tracks show their take-folder lanes inline in
 * the arrangement. Local-only zustand store, deliberately NOT in store.ts (the
 * automationUi precedent): expansion is per-window view state, never persisted and
 * never engine-authoritative — Ctrl+Z after a comp swipe restores the previous comp
 * via the project mirror while the expansion survives, which is the desired behavior.
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
 * Show a track's versions the moment it gains one (SPEC §8.7).
 *
 * Without this, a Keep Takes fold is invisible: the take folder is created, the newest
 * version plays, and the arrangement still shows ONE clip — the older versions exist but
 * are collapsed behind the "T" toggle nobody pressed. Reported 2026-08-11: "the versions
 * cannot be seen simultaneously on the screen". Cubase shows lanes as sub-tracks, so the
 * stack IS the feature; hiding it by default hides the feature.
 *
 * Mirrors useRevealWrittenLanes: expand only on a GAIN (lane count grew for a folder, or
 * a first folder appeared), never on load — a track absent from `seen` has never been
 * compared, so a freshly loaded project stays as the user left it. Expansion is view
 * state, so the user can still collapse it back and it will not fight them afterwards.
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
      if (before !== undefined && lanes > before)
        useTakesUi.getState().setExpanded(t.id, true);
    }
    seen.current = next;
  }, [project]);
}
