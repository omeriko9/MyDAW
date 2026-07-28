/**
 * MIDI functions (owned by U4) — pure note-math behind the piano roll's
 * "Functions" menu (legato, humanize, reverse, …). Each function takes the notes to
 * operate on and returns the patch to apply via cmd/notes.edit (store/actions
 * editNotes): `{ update?, remove? }`. No store access, no I/O — trivially testable.
 *
 * Conventions: pitches clamp to 0..127, velocities to 1..127, startBeat to ≥ 0;
 * a function returns an EMPTY result when it would change nothing.
 */

import type { CcInput, CcUpdate, MidiCc, Note, NoteInput, NoteUpdate } from "../protocol/types";

export interface NotesPatch {
  update?: NoteUpdate[];
  remove?: number[];
  /** New notes to create (engine assigns ids). */
  add?: NoteInput[];
}

/** Controller-lane edits (mirrors cmd/cc.edit's shape). */
export interface CcPatchOps {
  add?: CcInput[];
  remove?: number[];
  update?: CcUpdate[];
}

/** A function result touching both notes and controllers — committed as ONE
 *  cmd/notes.edit (its optional `cc` block) so undo reverts the pair together. */
export interface MidiClipPatch {
  notes?: NotesPatch;
  cc?: CcPatchOps;
}

export const notesPatchEmpty = (p: NotesPatch): boolean =>
  (p.update?.length ?? 0) === 0 && (p.remove?.length ?? 0) === 0 && (p.add?.length ?? 0) === 0;

export const ccPatchEmpty = (p: CcPatchOps): boolean =>
  (p.update?.length ?? 0) === 0 && (p.remove?.length ?? 0) === 0 && (p.add?.length ?? 0) === 0;

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
 * `overlapBeats` shifts every produced end: positive reaches into the next note,
 * negative leaves a gap before it (Cubase's legato overlap setting).
 */
export function legato(notes: Note[], overlapBeats = 0): NotesPatch {
  if (notes.length < 2) return {};
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  const update: NoteUpdate[] = [];
  for (const n of sorted) {
    const next = sorted.find((m) => m.startBeat > n.startBeat + 1e-9);
    if (!next) continue;
    const len = Math.max(1 / 64, next.startBeat - n.startBeat + overlapBeats);
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

/**
 * Velocity ramp across the selection's TIME span (UI_IMPROVE.md §2.3C): each
 * note's velocity is the linear blend of `from`→`to` at its onset position.
 * One gesture shapes a crescendo/diminuendo. Single notes / zero span get `from`.
 */
export function rampVelocity(notes: Note[], from: number, to: number): NotesPatch {
  if (notes.length === 0) return {};
  let s0 = Infinity;
  let s1 = -Infinity;
  for (const n of notes) {
    s0 = Math.min(s0, n.startBeat);
    s1 = Math.max(s1, n.startBeat);
  }
  const span = s1 - s0;
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const t = span > 1e-9 ? (n.startBeat - s0) / span : 0;
    const velocity = clampVel(from + (to - from) * t);
    if (velocity !== n.velocity) update.push({ noteId: n.id, patch: { velocity } });
  }
  return update.length > 0 ? { update } : {};
}

/**
 * Smooth ramp between the selection's EXISTING first and last velocities —
 * evens out a lumpy passage without choosing new dynamics.
 */
export function smoothVelocity(notes: Note[]): NotesPatch {
  if (notes.length < 3) return {};
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  return rampVelocity(notes, sorted[0].velocity, sorted[sorted.length - 1].velocity);
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

/**
 * Truncate notes that overlap the NEXT onset of the same pitch (and channel), so a
 * pitch never sounds twice at once. Exact doubles are Delete Doubles' job — a zero
 * gap clamps to the 1/64-beat minimum here.
 */
export function deleteOverlapsMono(notes: Note[]): NotesPatch {
  const groups = new Map<string, Note[]>();
  for (const n of notes) {
    const key = `${n.pitch}:${n.channel ?? 0}`;
    const list = groups.get(key);
    if (list) list.push(n);
    else groups.set(key, [n]);
  }
  const update: NoteUpdate[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.startBeat - b.startBeat);
    for (let i = 0; i < g.length - 1; i++) {
      const n = g[i];
      const next = g[i + 1];
      if (n.startBeat + n.lengthBeats > next.startBeat + 1e-9) {
        const len = Math.max(1 / 64, next.startBeat - n.startBeat);
        if (Math.abs(len - n.lengthBeats) > 1e-9) {
          update.push({ noteId: n.id, patch: { lengthBeats: len } });
        }
      }
    }
  }
  return update.length > 0 ? { update } : {};
}

/**
 * Truncate any note that overlaps a LATER onset of any pitch. Chords (equal starts)
 * survive intact — only reaching past the next distinct onset is trimmed.
 */
export function deleteOverlapsPoly(notes: Note[]): NotesPatch {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  const update: NoteUpdate[] = [];
  for (const n of sorted) {
    const next = sorted.find((m) => m.startBeat > n.startBeat + 1e-9);
    if (!next) continue;
    if (n.startBeat + n.lengthBeats > next.startBeat + 1e-9) {
      const len = Math.max(1 / 64, next.startBeat - n.startBeat);
      if (Math.abs(len - n.lengthBeats) > 1e-9) {
        update.push({ noteId: n.id, patch: { lengthBeats: len } });
      }
    }
  }
  return update.length > 0 ? { update } : {};
}

/** Every note gets the same velocity. */
export function fixedVelocity(notes: Note[], velocity: number): NotesPatch {
  const v = clampVel(velocity);
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    if (n.velocity !== v) update.push({ noteId: n.id, patch: { velocity: v } });
  }
  return update.length > 0 ? { update } : {};
}

/** Clamp velocities into [min, max] (Cubase Velocity dialog's Limit mode). */
export function limitVelocity(notes: Note[], min: number, max: number): NotesPatch {
  const lo = clampVel(Math.min(min, max));
  const hi = clampVel(Math.max(min, max));
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const velocity = Math.max(lo, Math.min(hi, n.velocity));
    if (velocity !== n.velocity) update.push({ noteId: n.id, patch: { velocity } });
  }
  return update.length > 0 ? { update } : {};
}

/**
 * Compress (ratio < 1) or expand (ratio > 1) velocities around a center value —
 * Cubase Velocity dialog's Compress/Expand mode.
 */
export function compressVelocity(notes: Note[], ratio: number, center = 64): NotesPatch {
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const velocity = clampVel(center + (n.velocity - center) * ratio);
    if (velocity !== n.velocity) update.push({ noteId: n.id, patch: { velocity } });
  }
  return update.length > 0 ? { update } : {};
}

/** Remove notes shorter than minLengthBeats and/or quieter than minVelocity. */
export function deleteNotes(
  notes: Note[],
  opts: { minLengthBeats?: number; minVelocity?: number },
): NotesPatch {
  const remove: number[] = [];
  for (const n of notes) {
    const tooShort = opts.minLengthBeats !== undefined && n.lengthBeats < opts.minLengthBeats - 1e-9;
    const tooQuiet = opts.minVelocity !== undefined && n.velocity < opts.minVelocity;
    if (tooShort || tooQuiet) remove.push(n.id);
  }
  return remove.length > 0 ? { remove } : {};
}

/**
 * Invert pitches around an axis (Cubase Mirror). Default axis is the midpoint of the
 * selection's pitch range, so the outer voices swap and the contour flips in place.
 */
export function mirror(notes: Note[], axisPitch?: number): NotesPatch {
  if (notes.length === 0) return {};
  let lo = 127;
  let hi = 0;
  for (const n of notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
  }
  // p' = 2*axis - p; with the default axis (lo+hi)/2 this stays integer-exact.
  const axis2 = axisPitch !== undefined ? Math.round(axisPitch * 2) : lo + hi;
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const pitch = clampPitch(axis2 - n.pitch);
    if (pitch !== n.pitch) update.push({ noteId: n.id, patch: { pitch } });
  }
  return update.length > 0 ? { update } : {};
}

/**
 * Limit simultaneous voices to maxVoices: when a new onset would exceed the limit,
 * the OLDEST sounding note is truncated at that onset (removed if nothing remains).
 * Same-start ties process quiet-first so louder chord notes win the voices.
 */
export function restrictPolyphony(notes: Note[], maxVoices: number): NotesPatch {
  const voices = Math.max(1, Math.round(maxVoices));
  const sorted = [...notes].sort(
    (a, b) => a.startBeat - b.startBeat || a.velocity - b.velocity || a.id - b.id,
  );
  const update: NoteUpdate[] = [];
  const remove: number[] = [];
  const ends = new Map<number, number>(); // id → current (possibly truncated) end
  let active: Note[] = []; // sounding notes, oldest first
  for (const n of sorted) {
    active = active.filter((a) => (ends.get(a.id) ?? 0) > n.startBeat + 1e-9);
    while (active.length >= voices) {
      const victim = active.shift()!;
      const len = n.startBeat - victim.startBeat;
      if (len < 1 / 64 - 1e-9) {
        remove.push(victim.id);
      } else if (Math.abs(len - victim.lengthBeats) > 1e-9) {
        update.push({ noteId: victim.id, patch: { lengthBeats: len } });
      }
      ends.set(victim.id, victim.startBeat + Math.max(0, len));
    }
    active.push(n);
    ends.set(n.id, n.startBeat + n.lengthBeats);
  }
  const out: NotesPatch = {};
  if (update.length > 0) out.update = update;
  if (remove.length > 0) out.remove = remove;
  return out;
}

/* ========================================================================== *
 * Controller-lane functions (operate on a MidiClip's cc array)
 * ========================================================================== */

/**
 * Thin out controller data (Cubase Thin Out Data): per controller lane, drop points
 * that a straight line between their kept neighbors already reproduces within
 * `tolerance` (normalized 0..1 value units) — Ramer-Douglas-Peucker, vertical metric.
 */
export function thinOutCc(cc: MidiCc[], tolerance = 1 / 127): CcPatchOps {
  const byCtrl = new Map<number, MidiCc[]>();
  for (const c of cc) {
    const list = byCtrl.get(c.controller);
    if (list) list.push(c);
    else byCtrl.set(c.controller, [c]);
  }
  const remove: number[] = [];
  for (const lane of byCtrl.values()) {
    if (lane.length < 3) continue;
    lane.sort((a, b) => a.beat - b.beat);
    const keep = new Set<number>([0, lane.length - 1]);
    const stack: Array<[number, number]> = [[0, lane.length - 1]];
    while (stack.length > 0) {
      const [lo, hi] = stack.pop()!;
      if (hi - lo < 2) continue;
      const span = lane[hi].beat - lane[lo].beat;
      let worst = -1;
      let worstDist = tolerance;
      for (let i = lo + 1; i < hi; i++) {
        const t = span > 1e-12 ? (lane[i].beat - lane[lo].beat) / span : 0;
        const lerp = lane[lo].value + (lane[hi].value - lane[lo].value) * t;
        const d = Math.abs(lane[i].value - lerp);
        if (d > worstDist) {
          worstDist = d;
          worst = i;
        }
      }
      if (worst >= 0) {
        keep.add(worst);
        stack.push([lo, worst], [worst, hi]);
      }
    }
    for (let i = 0; i < lane.length; i++) {
      if (!keep.has(i)) remove.push(lane[i].id);
    }
  }
  return remove.length > 0 ? { remove } : {};
}

/** Remove ALL controller events (CC, pitch bend, aftertouch). */
export function deleteControllers(cc: MidiCc[]): CcPatchOps {
  return cc.length > 0 ? { remove: cc.map((c) => c.id) } : {};
}

/**
 * Remove continuous controller data (CC curves, pitch bend 128, aftertouch 129) but
 * KEEP switch-type pedals CC64–69 (sustain/portamento/sostenuto/soft/legato/hold2) —
 * Cubase's Delete Continuous Controllers.
 */
export function deleteContinuousCc(cc: MidiCc[]): CcPatchOps {
  const remove = cc.filter((c) => !(c.controller >= 64 && c.controller <= 69)).map((c) => c.id);
  return remove.length > 0 ? { remove } : {};
}

/**
 * Pedals to Note Length (Cubase): notes released while the sustain pedal (CC64) is
 * held are extended to the pedal-up point; the pedal events are then deleted.
 * A pedal never released extends affected notes to `clipLengthBeats` (when given).
 */
export function pedalsToNoteLength(
  notes: Note[],
  cc: MidiCc[],
  clipLengthBeats?: number,
): MidiClipPatch {
  const pedal = cc.filter((c) => c.controller === 64).sort((a, b) => a.beat - b.beat);
  if (pedal.length === 0) return {};
  // Sustain-on intervals: [downBeat, upBeat); value >= 0.5 is "down".
  const intervals: Array<{ on: number; off: number }> = [];
  let downAt: number | null = null;
  for (const c of pedal) {
    const down = c.value >= 0.5;
    if (down && downAt === null) downAt = c.beat;
    else if (!down && downAt !== null) {
      intervals.push({ on: downAt, off: c.beat });
      downAt = null;
    }
  }
  if (downAt !== null && clipLengthBeats !== undefined && clipLengthBeats > downAt) {
    intervals.push({ on: downAt, off: clipLengthBeats });
  }
  const update: NoteUpdate[] = [];
  for (const n of notes) {
    const end = n.startBeat + n.lengthBeats;
    const iv = intervals.find((i) => i.on <= end + 1e-9 && end < i.off - 1e-9);
    if (!iv) continue;
    const len = iv.off - n.startBeat;
    if (len > n.lengthBeats + 1e-9) update.push({ noteId: n.id, patch: { lengthBeats: len } });
  }
  const out: MidiClipPatch = { cc: { remove: pedal.map((c) => c.id) } };
  if (update.length > 0) out.notes = { update };
  return out;
}
