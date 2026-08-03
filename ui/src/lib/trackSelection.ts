/** Shared click/range/keyboard semantics for track selection in every pane. */

import { useStore } from "../store/store";

let anchorId: number | null = null;
let focusId: number | null = null;

export interface TrackSelectionModifiers {
  toggle?: boolean;
  range?: boolean;
  /** Ctrl/Cmd+Shift: add the anchor range instead of replacing the selection. */
  additiveRange?: boolean;
}

function orderedUnique(ids: number[]): number[] {
  return [...new Set(ids)];
}

function rangeIds(order: number[], from: number, to: number): number[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

function clipsOnTracks(trackIds: number[]): number[] {
  const project = useStore.getState().project;
  if (!project) return [];
  const wanted = new Set(trackIds);
  return project.tracks.flatMap((track) =>
    wanted.has(track.id) ? track.clips.map((clip) => clip.id) : [],
  );
}

function commitTrackSelection(trackIds: number[]): void {
  useStore.getState().setSelection({
    trackIds,
    clipIds: clipsOnTracks(trackIds),
    noteIds: [],
    scope: trackIds.length > 0 ? "tracks" : "none",
  });
}

function syncAnchor(order: number[], selected: number[]): void {
  if (selected.length === 0) {
    anchorId = null;
    focusId = null;
    return;
  }
  if (selected.length === 1 && anchorId !== selected[0]) {
    anchorId = selected[0];
    focusId = selected[0];
    return;
  }
  if (anchorId === null || !order.includes(anchorId))
    anchorId = selected.find((id) => order.includes(id)) ?? null;
  if (focusId === null || !order.includes(focusId))
    focusId = [...selected].reverse().find((id) => order.includes(id)) ?? anchorId;
}

export function selectTrack(
  trackId: number,
  orderedTrackIds: number[],
  modifiers: TrackSelectionModifiers = {},
): number[] {
  const order = orderedUnique(orderedTrackIds);
  const state = useStore.getState();
  const selected = state.selection.trackIds.filter((id) => order.includes(id));
  syncAnchor(order, selected);

  let next: number[];
  if (modifiers.range) {
    const anchor = anchorId ?? focusId ?? selected[0] ?? trackId;
    const span = rangeIds(order, anchor, trackId);
    next = modifiers.additiveRange ? orderedUnique([...selected, ...span]) : span;
    anchorId = anchor;
    focusId = trackId;
  } else if (modifiers.toggle) {
    next = selected.includes(trackId)
      ? selected.filter((id) => id !== trackId)
      : [...selected, trackId];
    anchorId = trackId;
    focusId = trackId;
  } else {
    next = [trackId];
    anchorId = trackId;
    focusId = trackId;
  }

  commitTrackSelection(next);
  return next;
}

/** Move the focus one visible track. Shift extends/shrinks from the stable anchor. */
export function moveTrackSelection(
  orderedTrackIds: number[],
  direction: -1 | 1,
  extend: boolean,
): number | null {
  const order = orderedUnique(orderedTrackIds);
  if (order.length === 0) return null;
  const state = useStore.getState();
  const selected = state.selection.trackIds.filter((id) => order.includes(id));
  syncAnchor(order, selected);

  const current = focusId;
  const currentIndex = current === null ? -1 : order.indexOf(current);
  const nextIndex = currentIndex < 0
    ? direction > 0 ? 0 : order.length - 1
    : Math.max(0, Math.min(order.length - 1, currentIndex + direction));
  const nextFocus = order[nextIndex];

  if (extend) {
    const anchor = anchorId ?? current ?? nextFocus;
    commitTrackSelection(rangeIds(order, anchor, nextFocus));
    anchorId = anchor;
  } else {
    commitTrackSelection([nextFocus]);
    anchorId = nextFocus;
  }
  focusId = nextFocus;
  return nextFocus;
}

/** Explicitly reset the range origin after project replacement / selection clearing. */
export function resetTrackSelectionAnchor(): void {
  anchorId = null;
  focusId = null;
}
