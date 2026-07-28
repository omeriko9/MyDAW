/**
 * Logical Editor — Cubase-style rule engine over MIDI notes: a PROGRAM is a list of
 * filters (ANDed), a mode, and (for transform) a list of actions. Pure math like
 * lib/midiFunctions: no store access, no I/O — trivially testable. The dialog
 * (PianoRoll/LogicalEditorDialog) and the agent op (ui/midi.logicalEditor) both run
 * programs through applyLogicalEditor.
 *
 * Filter properties include two derived ones: `pitchClass` (pitch % 12, so "every C"
 * is expressible) and `index` (position in the time-sorted selection, so "every other
 * note" is expressible with cond even/odd).
 */

import type { Note, NoteUpdate } from "../protocol/types";
import type { NotesPatch } from "./midiFunctions";

export type LeProperty =
  | "pitch"
  | "velocity"
  | "startBeat"
  | "lengthBeats"
  | "channel"
  | "pitchClass"
  | "index";

export type LeCondition =
  | "eq"
  | "ne"
  | "lt"
  | "gt"
  | "le"
  | "ge"
  | "inRange" // value..value2 inclusive
  | "outsideRange"
  | "even"
  | "odd"
  | "modEq"; // floor-tolerant: prop mod value === value2

export interface LeFilter {
  prop: LeProperty;
  cond: LeCondition;
  value?: number;
  value2?: number;
}

export type LeActionOp =
  | "set"
  | "add"
  | "mul"
  | "random"; // add a uniform random offset in [value, value2]

export interface LeAction {
  prop: "pitch" | "velocity" | "startBeat" | "lengthBeats" | "channel";
  op: LeActionOp;
  value: number;
  value2?: number;
}

export type LeMode = "transform" | "delete" | "select";

export interface LeProgram {
  mode: LeMode;
  filters: LeFilter[]; // ANDed; empty = match everything
  actions: LeAction[]; // transform mode only
}

export interface LeResult {
  /** matched note ids (always filled — "select" consumers use it directly) */
  matchedIds: number[];
  /** transform/delete edits to commit via cmd/notes.edit (empty for "select") */
  patch: NotesPatch;
}

const EPS = 1e-6;

function propValue(n: Note, index: number, prop: LeProperty): number {
  switch (prop) {
    case "pitch": return n.pitch;
    case "velocity": return n.velocity;
    case "startBeat": return n.startBeat;
    case "lengthBeats": return n.lengthBeats;
    case "channel": return n.channel ?? 0;
    case "pitchClass": return n.pitch % 12;
    case "index": return index;
  }
}

function matches(v: number, f: LeFilter): boolean {
  const a = f.value ?? 0;
  const b = f.value2 ?? 0;
  switch (f.cond) {
    case "eq": return Math.abs(v - a) < EPS;
    case "ne": return Math.abs(v - a) >= EPS;
    case "lt": return v < a - EPS;
    case "gt": return v > a + EPS;
    case "le": return v <= a + EPS;
    case "ge": return v >= a - EPS;
    case "inRange": return v >= Math.min(a, b) - EPS && v <= Math.max(a, b) + EPS;
    case "outsideRange": return v < Math.min(a, b) - EPS || v > Math.max(a, b) + EPS;
    case "even": return Math.round(v) % 2 === 0;
    case "odd": return Math.abs(Math.round(v)) % 2 === 1;
    case "modEq": {
      if (a <= 0) return false;
      const m = ((v % a) + a) % a; // positive modulo
      return Math.abs(m - b) < EPS || Math.abs(m - b - a) < EPS;
    }
  }
}

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)));

function applyAction(value: number, act: LeAction, rand: () => number): number {
  switch (act.op) {
    case "set": return act.value;
    case "add": return value + act.value;
    case "mul": return value * act.value;
    case "random": {
      const lo = Math.min(act.value, act.value2 ?? act.value);
      const hi = Math.max(act.value, act.value2 ?? act.value);
      return value + lo + rand() * (hi - lo);
    }
  }
}

/**
 * Run a program over `notes` (any order — `index` derives from the time-sorted order).
 * Transform actions clamp per property: pitch/channel round to their MIDI ranges,
 * velocity to 1..127, startBeat >= 0, lengthBeats >= 1/64.
 */
export function applyLogicalEditor(
  notes: Note[],
  prog: LeProgram,
  rand: () => number = Math.random,
): LeResult {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.id - b.id);
  const matched: Note[] = [];
  sorted.forEach((n, i) => {
    if (prog.filters.every((f) => matches(propValue(n, i, f.prop), f))) matched.push(n);
  });
  const matchedIds = matched.map((n) => n.id);
  if (prog.mode === "select" || matched.length === 0) return { matchedIds, patch: {} };
  if (prog.mode === "delete") return { matchedIds, patch: { remove: matchedIds } };

  const update: NoteUpdate[] = [];
  for (const n of matched) {
    let pitch = n.pitch;
    let velocity = n.velocity;
    let startBeat = n.startBeat;
    let lengthBeats = n.lengthBeats;
    let channel = n.channel ?? 0;
    for (const act of prog.actions) {
      switch (act.prop) {
        case "pitch": pitch = applyAction(pitch, act, rand); break;
        case "velocity": velocity = applyAction(velocity, act, rand); break;
        case "startBeat": startBeat = applyAction(startBeat, act, rand); break;
        case "lengthBeats": lengthBeats = applyAction(lengthBeats, act, rand); break;
        case "channel": channel = applyAction(channel, act, rand); break;
      }
    }
    const patch: NoteUpdate["patch"] = {};
    const p = clampInt(pitch, 0, 127);
    const v = clampInt(velocity, 1, 127);
    const s = Math.max(0, startBeat);
    const l = Math.max(1 / 64, lengthBeats);
    const c = clampInt(channel, 0, 15);
    if (p !== n.pitch) patch.pitch = p;
    if (v !== n.velocity) patch.velocity = v;
    if (Math.abs(s - n.startBeat) > 1e-9) patch.startBeat = s;
    if (Math.abs(l - n.lengthBeats) > 1e-9) patch.lengthBeats = l;
    if (c !== (n.channel ?? 0)) patch.channel = c;
    if (Object.keys(patch).length > 0) update.push({ noteId: n.id, patch });
  }
  return { matchedIds, patch: update.length > 0 ? { update } : {} };
}

/* ============================================================================
 * Preset library (the Cubase classics)
 * ========================================================================= */

export interface LePreset {
  name: string;
  program: LeProgram;
}

export const LE_PRESETS: LePreset[] = [
  {
    name: "Select every other note",
    program: { mode: "select", filters: [{ prop: "index", cond: "odd" }], actions: [] },
  },
  {
    name: "Delete short notes (< 1/32)",
    program: {
      mode: "delete",
      filters: [{ prop: "lengthBeats", cond: "lt", value: 0.125 }],
      actions: [],
    },
  },
  {
    name: "Delete quiet notes (< 30)",
    program: {
      mode: "delete",
      filters: [{ prop: "velocity", cond: "lt", value: 30 }],
      actions: [],
    },
  },
  {
    name: "Randomize velocity ±10",
    program: {
      mode: "transform",
      filters: [],
      actions: [{ prop: "velocity", op: "random", value: -10, value2: 10 }],
    },
  },
  {
    name: "Fixed velocity 100",
    program: {
      mode: "transform",
      filters: [],
      actions: [{ prop: "velocity", op: "set", value: 100 }],
    },
  },
  {
    name: "Accent downbeats (+20)",
    program: {
      mode: "transform",
      filters: [{ prop: "startBeat", cond: "modEq", value: 4, value2: 0 }],
      actions: [{ prop: "velocity", op: "add", value: 20 }],
    },
  },
  {
    name: "Octave up",
    program: {
      mode: "transform",
      filters: [],
      actions: [{ prop: "pitch", op: "add", value: 12 }],
    },
  },
  {
    name: "Humanize timing (±0.02 beat)",
    program: {
      mode: "transform",
      filters: [],
      actions: [{ prop: "startBeat", op: "random", value: -0.02, value2: 0.02 }],
    },
  },
];
