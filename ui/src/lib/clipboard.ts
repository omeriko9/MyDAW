/**
 * Internal clip clipboard (owned by U2) — SPEC §9: "Copy/paste lives in UI (sends
 * cmd/clip.duplicate-like add commands) with internal clipboard."
 *
 * copySelection()  — snapshot the clips referenced by store.selection.clipIds
 *                    (deep copies, with their source trackIds).
 * cutSelection()   — copySelection + cmd/clip.delete (one undo entry for the delete).
 * pasteAt(beat?)   — reconstruct via cmd/clip.addMidi / cmd/clip.addAudio using the
 *                    pinned optional payload extensions (notes/name/color/gain/fades/
 *                    srcOffset/lengthSamples). Default paste position = playhead
 *                    (transportBus.last). Clips land on their ORIGINAL tracks; multi-clip
 *                    selections keep relative beat offsets (earliest clip = paste point).
 *                    Returns the new clip ids and selects them.
 *
 * v1 tradeoff: pasting N clips issues N add commands → N undo entries (SPEC has no
 * batch-add). Duplicate (Ctrl+D) uses cmd/clip.duplicate instead, which is one entry.
 */

import { ws } from "../protocol/ws";
import { useStore, transportBus } from "../store/store";
import { isAudioClip, isMidiClip } from "../protocol/types";
import type { Clip, NoteInput, Project, Track } from "../protocol/types";

interface ClipboardEntry {
  trackId: number;
  clip: Clip;
}

interface ClipboardState {
  entries: ClipboardEntry[];
  /** startBeat of the earliest copied clip — relative offsets are kept from this. */
  baseBeat: number;
}

let clipboard: ClipboardState | null = null;

/* ============================================================================
 * Lookup helpers (exported — also used by the transport bar / keyboard defaults)
 * ========================================================================= */

/** Find a clip and its owning track in the project mirror. */
export function findClipById(
  project: Project,
  clipId: number,
): { track: Track; clip: Clip } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  const masterClip = project.masterTrack.clips.find((c) => c.id === clipId);
  if (masterClip) return { track: project.masterTrack, clip: masterClip };
  return null;
}

function deepCopyClip(clip: Clip): Clip {
  return JSON.parse(JSON.stringify(clip)) as Clip;
}

/* ============================================================================
 * API
 * ========================================================================= */

/** True if there is something to paste. */
export function hasClipboard(): boolean {
  return clipboard !== null && clipboard.entries.length > 0;
}

/**
 * Snapshot the currently selected clips. Returns the number of clips copied
 * (0 = nothing selected / no project — clipboard left untouched).
 */
export function copySelection(): number {
  const s = useStore.getState();
  const project = s.project;
  if (!project || s.selection.clipIds.length === 0) return 0;

  const entries: ClipboardEntry[] = [];
  for (const clipId of s.selection.clipIds) {
    const found = findClipById(project, clipId);
    if (found) entries.push({ trackId: found.track.id, clip: deepCopyClip(found.clip) });
  }
  if (entries.length === 0) return 0;

  const baseBeat = Math.min(...entries.map((e) => e.clip.startBeat));
  clipboard = { entries, baseBeat };
  return entries.length;
}

/** Copy, then delete the selection (cmd/clip.delete — single undo entry). */
export async function cutSelection(): Promise<number> {
  const n = copySelection();
  if (n === 0) return 0;
  const clipIds = clipboard!.entries.map((e) => e.clip.id);
  await ws.request("cmd/clip.delete", { clipIds });
  useStore.getState().setSelection({ clipIds: [], noteIds: [] });
  return n;
}

/** Strip engine note ids — the engine assigns fresh ones on add. */
function notesToInputs(notes: ReadonlyArray<NoteInput & { id?: number }>): NoteInput[] {
  return notes.map((n) => ({
    pitch: n.pitch,
    velocity: n.velocity,
    startBeat: n.startBeat,
    lengthBeats: n.lengthBeats,
    ...(n.channel !== undefined ? { channel: n.channel } : {}),
  }));
}

/**
 * Paste the clipboard. `beat` defaults to the current playhead (transportBus.last,
 * 0 before the first transport event). Clips go to their original tracks; entries whose
 * source track no longer exists are skipped. Returns the new clip ids (also selected).
 */
export async function pasteAt(beat?: number): Promise<number[]> {
  const s = useStore.getState();
  const project = s.project;
  if (!project || !clipboard || clipboard.entries.length === 0) return [];

  const targetBeat = Math.max(0, beat ?? transportBus.last?.beat ?? 0);
  const { entries, baseBeat } = clipboard;
  const trackIds = new Set<number>(project.tracks.map((t) => t.id));

  const newIds: number[] = [];
  for (const entry of entries) {
    if (!trackIds.has(entry.trackId)) {
      console.warn(`[clipboard] paste: source track ${entry.trackId} no longer exists — skipping clip`);
      continue;
    }
    const clip = entry.clip;
    const startBeat = targetBeat + (clip.startBeat - baseBeat);
    try {
      if (isMidiClip(clip)) {
        const r = await ws.request("cmd/clip.addMidi", {
          trackId: entry.trackId,
          startBeat,
          lengthBeats: clip.lengthBeats,
          notes: notesToInputs(clip.notes),
          name: clip.name,
          ...(clip.color !== undefined ? { color: clip.color } : {}),
        });
        newIds.push(r.clip.id);
      } else if (isAudioClip(clip)) {
        const r = await ws.request("cmd/clip.addAudio", {
          trackId: entry.trackId,
          startBeat,
          assetId: clip.assetId,
          name: clip.name,
          ...(clip.color !== undefined ? { color: clip.color } : {}),
          gain: clip.gain,
          fadeInSec: clip.fadeInSec,
          fadeOutSec: clip.fadeOutSec,
          srcOffsetSamples: clip.srcOffsetSamples,
          lengthSamples: clip.lengthSamples,
        });
        newIds.push(r.clip.id);
      }
    } catch (e) {
      console.error("[clipboard] paste: add command failed:", e);
    }
  }

  if (newIds.length > 0) {
    useStore.getState().setSelection({ clipIds: newIds, noteIds: [] });
  }
  return newIds;
}
