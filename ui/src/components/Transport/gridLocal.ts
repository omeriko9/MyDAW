/**
 * Grid edits — persisted via cmd/grid.set (SPEC §5.3) with an optimistic local mirror.
 *
 * The store's project mirror is patched immediately so the snap controls feel instant;
 * the engine command persists project.grid (undoable, saved with the project) and the
 * resulting event/projectChanged reconciles the mirror to the authoritative value.
 */

import { useStore } from "../../store/store";
import { setGrid } from "../../store/actions";
import type { Grid } from "../../protocol/types";

/** Used when project === null (controls disabled but must render sanely). */
export const DEFAULT_GRID: Grid = { division: 1, snap: true, triplet: false, swing: 0 };

/**
 * Optimistically merge a patch into project.grid, then persist via cmd/grid.set.
 * Pass transient=true while dragging (no undo entry, no projectChanged echo to fight
 * the mirror) and commit once non-transient on release — same pattern as setLoop.
 */
export function setGridLocal(patch: Partial<Grid>, transient?: boolean): void {
  const s = useStore.getState();
  if (!s.project) return;
  s.setProject({ ...s.project, grid: { ...s.project.grid, ...patch } });
  setGrid(patch, transient).catch((e) => console.error("cmd/grid.set failed:", e));
}
