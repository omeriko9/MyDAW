/**
 * Internal clip clipboard (owned by U2) — SPEC §9: "Copy/paste lives in UI (sends
 * cmd/clip.duplicate-like add commands) with internal clipboard."
 *
 * copySelection()  — snapshot the clips referenced by store.selection.clipIds
 *                    (deep copies, with their source trackIds).
 * cutSelection()   — copySelection + cmd/clip.delete (one undo entry for the delete).
 * pasteAt(beat?)   — reconstruct via cmd/clip.addMidi / cmd/clip.addAudio using the
 *                    pinned optional payload extensions (notes/name/color/gain/fades/
 *                    srcOffset/lengthSamples). Multi-clip selections keep relative beat
 *                    offsets. TARGETING (Cubase-style Ctrl+C/Ctrl+V):
 *                      - a DIFFERENT track selected than the copy's anchor track →
 *                        clips land on the selected track (multi-track selections keep
 *                        their track spacing by index offset) at the SAME time mark as
 *                        the source — copy a clip, click another channel, Ctrl+V.
 *                      - otherwise → original tracks at the playhead (classic paste).
 *                      - an explicit `beat` (context menu "Paste here") always wins.
 *                    Kind-incompatible mappings (audio clip → midi track etc.) are
 *                    skipped with a warning. Returns the new clip ids and selects them.
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

/** Can this track hold this clip? (audio clips need audio tracks; midi needs midi/instrument) */
function trackTakesClip(track: Track, clip: Clip): boolean {
  if (isAudioClip(clip)) return track.kind === "audio";
  return track.kind === "midi" || track.kind === "instrument";
}

/**
 * Paste the clipboard (see the targeting contract in the header comment). Entries whose
 * resolved track no longer exists or can't hold the clip kind are skipped. Returns the
 * new clip ids (also selected).
 */
export async function pasteAt(beat?: number): Promise<number[]> {
  const s = useStore.getState();
  const project = s.project;
  if (!project || !clipboard || clipboard.entries.length === 0) return [];

  const { entries, baseBeat } = clipboard;
  const indexOf = new Map<number, number>(project.tracks.map((t, i) => [t.id, i]));

  // Anchor = the TOPMOST source track still present (multi-track selections keep their
  // vertical spacing relative to it when re-targeted).
  let anchorIdx: number | null = null;
  for (const e of entries) {
    const idx = indexOf.get(e.trackId);
    if (idx !== undefined && (anchorIdx === null || idx < anchorIdx)) anchorIdx = idx;
  }
  const selTrackId = s.selection.trackIds[0];
  const selIdx = selTrackId !== undefined ? indexOf.get(selTrackId) : undefined;
  // Re-target when a DIFFERENT track is selected than the anchor.
  const retarget =
    selIdx !== undefined && anchorIdx !== null && project.tracks[selIdx].id !==
      project.tracks[anchorIdx].id;

  // Position: explicit beat > re-target keeps the SOURCE time mark > playhead.
  const targetBeat = Math.max(
    0,
    beat ?? (retarget ? baseBeat : (transportBus.last?.beat ?? 0)),
  );

  const newIds: number[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const srcIdx = indexOf.get(entry.trackId);
    let destTrack: Track | undefined;
    if (retarget && srcIdx !== undefined && anchorIdx !== null) {
      const mapped = selIdx! + (srcIdx - anchorIdx);
      destTrack = project.tracks[mapped];
    } else if (srcIdx !== undefined) {
      destTrack = project.tracks[srcIdx];
    }
    if (!destTrack || !trackTakesClip(destTrack, entry.clip)) {
      ++skipped;
      console.warn(
        `[clipboard] paste: no compatible target track for clip "${entry.clip.name ?? entry.clip.id}" — skipped`,
      );
      continue;
    }
    const clip = entry.clip;
    const startBeat = targetBeat + (clip.startBeat - baseBeat);
    try {
      if (isMidiClip(clip)) {
        const r = await ws.request("cmd/clip.addMidi", {
          trackId: destTrack.id,
          startBeat,
          lengthBeats: clip.lengthBeats,
          notes: notesToInputs(clip.notes),
          name: clip.name,
          ...(clip.color !== undefined ? { color: clip.color } : {}),
        });
        newIds.push(r.clip.id);
      } else if (isAudioClip(clip)) {
        const r = await ws.request("cmd/clip.addAudio", {
          trackId: destTrack.id,
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

  if (skipped > 0)
    console.warn(`[clipboard] paste: ${skipped} clip(s) had no compatible target track`);
  if (newIds.length > 0) {
    useStore.getState().setSelection({ clipIds: newIds, noteIds: [] });
  }
  return newIds;
}
