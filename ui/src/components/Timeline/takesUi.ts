/**
 * Take-lane UI state (SPEC §8.7) — which tracks show their take-folder lanes inline in
 * the arrangement. Local-only zustand store, deliberately NOT in store.ts (the
 * automationUi precedent): expansion is per-window view state, never persisted and
 * never engine-authoritative — Ctrl+Z after a comp swipe restores the previous comp
 * via the project mirror while the expansion survives, which is the desired behavior.
 */

import { create } from "zustand";

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
