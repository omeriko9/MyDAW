/**
 * Take lane UI state (SPEC §8.7) — which tracks have their take lanes expanded
 * ("Show Lanes"). Local-only zustand store like automationUi, deliberately NOT in
 * store.ts and never persisted: the §8.7 design lesson is that the lanes VIEW must be
 * completely independent of the record take MODE (transport state) and of what plays
 * (mute state). Expanding lanes only ever changes what you SEE.
 */

import { create } from "zustand";
import { takeLane } from "../../store/actions";
import { showToast } from "../common/ToastHost";
import { confirmDialog } from "../Dialogs/confirm";
import type { MenuEntry } from "../common/ContextMenu";
import type { Track } from "../../protocol/types";

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

/* ============================================================================
 * Lane row context menu — shared by the track headers and the canvas take rows,
 * so right-clicking a lane means the same thing on either side of the divider.
 * ========================================================================= */

const fire = (p: Promise<unknown>): void => {
  p.catch((e: unknown) => {
    console.warn("[takes] lane command failed:", e);
    showToast(e instanceof Error && e.message ? e.message : "Command failed", "error");
  });
};

export function takeLaneMenuItems(track: Track, lane: number): MenuEntry[] {
  const clips = track.clips.filter((c) => (c.lane ?? 0) === lane);
  const name = lane === 0 ? "Main" : `Lane ${lane + 1}`;
  const empty = clips.length === 0;
  const active = clips.length > 0 && clips.every((c) => !c.muted);
  return [
    {
      label: `Set “${name}” as Active Take`,
      icon: "check",
      disabled: empty || active,
      title: empty
        ? "This lane has no takes on it"
        : active
          ? "Already the active lane everywhere it has material"
          : "Play this lane wherever it has material (the others stay, muted)",
      onClick: () => fire(takeLane(track.id, lane, "front")),
    },
    "separator",
    {
      label: `Delete “${name}”`,
      icon: "trash",
      danger: true,
      disabled: empty,
      title: empty ? "This lane has no takes on it" : undefined,
      onClick: () => {
        void (async () => {
          const ok = await confirmDialog({
            title: `Delete ${name}`,
            message:
              `Delete ${clips.length} take${clips.length === 1 ? "" : "s"} on ${name}? ` +
              `Lanes above it move down, and takes it was covering become audible again. ` +
              `This can be undone.`,
            confirmLabel: "Delete",
            danger: true,
          });
          if (ok) fire(takeLane(track.id, lane, "delete"));
        })();
      },
    },
  ];
}
