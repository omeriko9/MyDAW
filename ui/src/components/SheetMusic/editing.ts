/**
 * editing.ts — note edits expressed as patches, so the Sheet Music pane is an editor and
 * not just a view.
 *
 * Every operation returns a per-clip {add, remove, update} patch rather than calling the
 * engine, which keeps the rules testable and lets the caller decide batching. Notes may
 * come from several clips at once (the pane can engrave a whole track), so everything is
 * grouped by clip first — one `cmd/notes.edit` per clip, one undo entry each.
 */

import type { MidiClip, Note, NoteInput, NoteUpdate } from "../../protocol/types";

export interface NoteRef {
  clip: MidiClip;
  note: Note;
}

export interface ClipPatch {
  clipId: number;
  add?: NoteInput[];
  remove?: number[];
  update?: NoteUpdate[];
}

/** Shortest note we will ever create by splitting — a 64th. */
export const MIN_LEN = 0.0625;

export const noteAbsStart = (r: NoteRef): number => r.clip.startBeat + r.note.startBeat;
export const noteAbsEnd = (r: NoteRef): number => noteAbsStart(r) + r.note.lengthBeats;

/** Resolve selected ids against the clips on show, dropping anything stale. */
export function resolveNotes(clips: MidiClip[], ids: Iterable<number>): NoteRef[] {
  const want = new Set(ids);
  const out: NoteRef[] = [];
  for (const clip of clips) {
    for (const note of clip.notes) {
      if (want.has(note.id)) out.push({ clip, note });
    }
  }
  return out.sort((a, b) => noteAbsStart(a) - noteAbsStart(b) || a.note.pitch - b.note.pitch);
}

function byClip(refs: NoteRef[]): Map<number, NoteRef[]> {
  const m = new Map<number, NoteRef[]>();
  for (const r of refs) {
    const list = m.get(r.clip.id);
    if (list) list.push(r);
    else m.set(r.clip.id, [r]);
  }
  return m;
}

/* ============================================================================
 * Operations
 * ========================================================================= */

export function deleteNotes(refs: NoteRef[]): ClipPatch[] {
  return [...byClip(refs)].map(([clipId, list]) => ({
    clipId,
    remove: list.map((r) => r.note.id),
  }));
}

/** Set every selected note to an exact length in beats. */
export function setLength(refs: NoteRef[], beats: number): ClipPatch[] {
  const len = Math.max(MIN_LEN, beats);
  return [...byClip(refs)].map(([clipId, list]) => ({
    clipId,
    update: list.map((r) => ({ noteId: r.note.id, patch: { lengthBeats: len } })),
  }));
}

export function transposeNotes(refs: NoteRef[], semitones: number): ClipPatch[] {
  return [...byClip(refs)].map(([clipId, list]) => ({
    clipId,
    update: list.map((r) => ({ noteId: r.note.id, patch: { pitch: Math.max(0, Math.min(127, r.note.pitch + semitones)) } })),
  }));
}

export function setVelocity(refs: NoteRef[], velocity: number): ClipPatch[] {
  const v = Math.max(1, Math.min(127, Math.round(velocity)));
  return [...byClip(refs)].map(([clipId, list]) => ({
    clipId,
    update: list.map((r) => ({ noteId: r.note.id, patch: { velocity: v } })),
  }));
}

/**
 * JOIN: merge each run of selected notes that share a pitch into one longer note —
 * which is exactly how a tie is produced in the engraved output. Notes of different
 * pitches are left alone (they are not the same voice), so joining a chord is a no-op
 * and the caller can say so.
 */
export function joinNotes(refs: NoteRef[]): { patches: ClipPatch[]; merged: number } {
  const groups = new Map<string, NoteRef[]>();
  for (const r of refs) {
    const key = `${r.clip.id}:${r.note.pitch}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const perClip = new Map<number, ClipPatch>();
  const patchFor = (clipId: number): ClipPatch => {
    const p = perClip.get(clipId) ?? { clipId, remove: [], update: [] };
    perClip.set(clipId, p);
    return p;
  };

  let merged = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => noteAbsStart(a) - noteAbsStart(b));
    const keep = sorted[0];
    const end = Math.max(...sorted.map(noteAbsEnd));
    const p = patchFor(keep.clip.id);
    p.update!.push({ noteId: keep.note.id, patch: { lengthBeats: Math.max(MIN_LEN, end - noteAbsStart(keep)) } });
    for (const r of sorted.slice(1)) {
      // A note from another clip cannot be absorbed into this one — drop it there.
      patchFor(r.clip.id).remove!.push(r.note.id);
      merged++;
    }
  }
  return { patches: [...perClip.values()], merged };
}

/**
 * SEPARATE: cut each selected note into `parts` equal pieces. The original keeps its id
 * (and the selection with it); the remainder become new notes.
 */
export function splitNotes(refs: NoteRef[], parts: number): { patches: ClipPatch[]; split: number } {
  const n = Math.max(2, Math.round(parts));
  const perClip = new Map<number, ClipPatch>();
  let split = 0;

  for (const r of refs) {
    const piece = r.note.lengthBeats / n;
    if (piece < MIN_LEN) continue;
    const p = perClip.get(r.clip.id) ?? { clipId: r.clip.id, add: [], update: [] };
    perClip.set(r.clip.id, p);
    p.update!.push({ noteId: r.note.id, patch: { lengthBeats: piece } });
    for (let i = 1; i < n; i++) {
      p.add!.push({
        pitch: r.note.pitch,
        velocity: r.note.velocity,
        startBeat: r.note.startBeat + piece * i,
        lengthBeats: piece,
      });
    }
    split++;
  }
  return { patches: [...perClip.values()], split };
}

/** Cut selected notes at an absolute timeline beat (the playhead). */
export function splitAtBeat(refs: NoteRef[], absBeat: number): { patches: ClipPatch[]; split: number } {
  const perClip = new Map<number, ClipPatch>();
  let split = 0;

  for (const r of refs) {
    const start = noteAbsStart(r);
    const end = noteAbsEnd(r);
    if (absBeat <= start + MIN_LEN || absBeat >= end - MIN_LEN) continue;
    const p = perClip.get(r.clip.id) ?? { clipId: r.clip.id, add: [], update: [] };
    perClip.set(r.clip.id, p);
    p.update!.push({ noteId: r.note.id, patch: { lengthBeats: absBeat - start } });
    p.add!.push({
      pitch: r.note.pitch,
      velocity: r.note.velocity,
      startBeat: absBeat - r.clip.startBeat,
      lengthBeats: end - absBeat,
    });
    split++;
  }
  return { patches: [...perClip.values()], split };
}

/** Extend every selected note to meet the next one at the same pitch (Cubase legato). */
export function legatoNotes(refs: NoteRef[]): ClipPatch[] {
  const perClip = new Map<number, ClipPatch>();
  const groups = new Map<string, NoteRef[]>();
  for (const r of refs) {
    const key = `${r.clip.id}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => noteAbsStart(a) - noteAbsStart(b));
    const p: ClipPatch = { clipId: sorted[0].clip.id, update: [] };
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = noteAbsStart(sorted[i + 1]) - noteAbsStart(sorted[i]);
      if (gap > MIN_LEN) p.update!.push({ noteId: sorted[i].note.id, patch: { lengthBeats: gap } });
    }
    if (p.update!.length) perClip.set(p.clipId, p);
  }
  return [...perClip.values()];
}

/** Drop empty patches so we never send a no-op edit (and never log a no-op undo). */
export function prunePatches(patches: ClipPatch[]): ClipPatch[] {
  return patches.filter(
    (p) => (p.add?.length ?? 0) + (p.remove?.length ?? 0) + (p.update?.length ?? 0) > 0,
  );
}
