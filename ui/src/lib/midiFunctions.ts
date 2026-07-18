/**
 * MIDI functions (owned by U4) — pure note-math behind the piano roll's
 * "Functions" menu (legato, humanize, reverse, …). Each function takes the notes to
 * operate on and returns the patch to apply via cmd/notes.edit (store/actions
 * editNotes): `{ update?, remove? }`. No store access, no I/O — trivially testable.
 *
 * Conventions: pitches clamp to 0..127, velocities to 1..127, startBeat to ≥ 0;
 * a function returns an EMPTY result when it would change nothing.
 */

import type { Note, NoteUpdate } from "../protocol/types";

export interface NotesPatch {
  update?: NoteUpdate[];
  remove?: number[];
}

const clampPitch = (p: number) => Math.max(0, Math.min(127, Math.round(p)));
const clampVel = (v: number) => Math.max(1, Math.min(127, Math.round(v)));

export function transpose(notes: Note[], semitones: number): NotesPatch {
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const pitch = clampPitch(n.pitch + semitones);
    if (pitch !== n.pitch) update.push({ noteId: n.id, patch: { pitch } });
  }
  return update.length > 0 ? { update } : {};
}

/** Every note gets the same length (typically the current grid step). */
export function fixedLength(notes: Note[], lengthBeats: number): NotesPatch {
  const len = Math.max(1 / 64, lengthBeats);
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    if (n.lengthBeats !== len) update.push({ noteId: n.id, patch: { lengthBeats: len } });
  }
  return update.length > 0 ? { update } : {};
}

/**
 * Extend each note to the start of the NEXT note onset (any pitch — classic Cubase
 * legato). Chords (equal starts) get the same end. The final onset keeps its length.
 */
export function legato(notes: Note[]): NotesPatch {
  if (notes.length < 2) return {};
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  const update: NoteUpdate[] = [];
  for (const n of sorted) {
    const next = sorted.find((m) => m.startBeat > n.startBeat + 1e-9);
    if (!next) continue;
    const len = Math.max(1 / 64, next.startBeat - n.startBeat);
    if (Math.abs(len - n.lengthBeats) > 1e-9) {
      update.push({ noteId: n.id, patch: { lengthBeats: len } });
    }
  }
  return update.length > 0 ? { update } : {};
}

/** Random start offsets within ±maxBeats (never before beat 0). */
export function humanizeTiming(notes: Note[], maxBeats: number): NotesPatch {
  if (maxBeats <= 0) return {};
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const startBeat = Math.max(0, n.startBeat + (Math.random() * 2 - 1) * maxBeats);
    update.push({ noteId: n.id, patch: { startBeat } });
  }
  return { update };
}

/** Random velocity offsets within ±amount. */
export function humanizeVelocity(notes: Note[], amount: number): NotesPatch {
  if (amount <= 0) return {};
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const velocity = clampVel(n.velocity + Math.round((Math.random() * 2 - 1) * amount));
    if (velocity !== n.velocity) update.push({ noteId: n.id, patch: { velocity } });
  }
  return update.length > 0 ? { update } : {};
}

/** velocity = velocity × mul + add (then clamped). */
export function scaleVelocity(notes: Note[], mul: number, add: number): NotesPatch {
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const velocity = clampVel(n.velocity * mul + add);
    if (velocity !== n.velocity) update.push({ noteId: n.id, patch: { velocity } });
  }
  return update.length > 0 ? { update } : {};
}

/** Mirror the notes in time within their own span (pitches unchanged). */
export function reverse(notes: Note[]): NotesPatch {
  if (notes.length < 2) return {};
  let s0 = Infinity;
  let e0 = 0;
  for (const n of notes) {
    s0 = Math.min(s0, n.startBeat);
    e0 = Math.max(e0, n.startBeat + n.lengthBeats);
  }
  if (!(e0 > s0)) return {};
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const startBeat = Math.max(0, s0 + (e0 - (n.startBeat + n.lengthBeats)));
    if (Math.abs(startBeat - n.startBeat) > 1e-9) {
      update.push({ noteId: n.id, patch: { startBeat } });
    }
  }
  return update.length > 0 ? { update } : {};
}

/**
 * Remove exact doubles: same pitch and (near-)same start. Keeps the longest (then
 * highest-velocity) note of each cluster.
 */
export function deleteDoubles(notes: Note[]): NotesPatch {
  const byKey = new Map<string, Note[]>();
  for (const n of notes) {
    const key = `${n.pitch}:${Math.round(n.startBeat * 3840)}`; // 1/960-beat buckets
    const list = byKey.get(key);
    if (list) list.push(n);
    else byKey.set(key, [n]);
  }
  const remove: number[] = [];
  for (const cluster of byKey.values()) {
    if (cluster.length < 2) continue;
    cluster.sort((a, b) => b.lengthBeats - a.lengthBeats || b.velocity - a.velocity);
    for (const n of cluster.slice(1)) remove.push(n.id);
  }
  return remove.length > 0 ? { remove } : {};
}
