/** Shared deliberate/destructive actions over a track selection. */

import { removeTrack } from "../store/actions";
import { useStore } from "../store/store";
import { ws } from "../protocol/ws";
import { confirmDialog } from "../components/Dialogs/confirm";

export async function confirmRemoveTracks(trackIds: number[]): Promise<boolean> {
  const project = useStore.getState().project;
  if (!project) return false;
  const wanted = new Set(trackIds);
  const tracks = project.tracks.filter((t) => wanted.has(t.id));
  if (tracks.length === 0) return false;
  const clips = tracks.reduce((n, t) => n + t.clips.length, 0);
  const n = tracks.length;
  const ok = await confirmDialog({
    title: n === 1 ? "Delete track" : `Delete ${n} tracks`,
    message:
      `Delete ${n === 1 ? `"${tracks[0].name}"` : `${n} selected tracks`}` +
      `${clips > 0 ? ` and ${clips} clip${clips === 1 ? "" : "s"}` : ""}? This can be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return false;
  if (tracks.length <= 64) {
    // One structural commit, one projectChanged, and one Undo removes/restores the set.
    await ws.requestRaw("agent/batch", {
      expectedRevision: useStore.getState().revision,
      label: tracks.length === 1 ? "Delete Track" : `Delete ${tracks.length} Tracks`,
      operations: tracks.map((track) => ({
        type: "cmd/track.remove",
        payload: { trackId: track.id },
      })),
    });
  } else {
    // The engine caps atomic batches at 64 operations; retain deterministic behavior
    // for unusually large selections instead of making Delete silently do nothing.
    for (const track of tracks) await removeTrack(track.id);
  }
  useStore.getState().setSelection({ trackIds: [], clipIds: [], noteIds: [], scope: "none" });
  return true;
}
