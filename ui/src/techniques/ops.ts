/**
 * Shared technique vocabulary — thin composites over EXISTING store actions.
 * Techniques compose these; a new technique should rarely need a new op.
 *
 * Undo accounting: every non-transient cmd/* is one engine undo entry. Ops route
 * commands through a Tx which counts them; a stage returns tx.count so the wizard
 * can Take Back exactly that many edit/undo steps.
 *
 * Freshness: replies (created track/plugin/clip) are used directly — the store's
 * project mirror updates asynchronously via event/projectChanged, so ops never
 * read the store for something a reply already carries.
 */

import {
  addMidiClip,
  addPlugin,
  addSend,
  addTrack,
  editNotes,
  getPluginParams,
  setAutomation,
  setPluginParam,
  setTrackEq,
} from "../store/actions";
import type {
  AutomationAddPoint,
  EqBand,
  MidiClip,
  NoteInput,
  PluginInstance,
  Project,
  Track,
} from "../protocol/types";
import { normFor } from "./norm";
import { useStore } from "../store/store";
import type { TechniqueCtx } from "./types";

/* ============================================================================
 * Tx — undo-entry accounting
 * ========================================================================= */

export class Tx {
  count = 0;

  /** Await an engine command that creates ONE undo entry. */
  async cmd<T>(p: Promise<T>): Promise<T> {
    const r = await p;
    this.count++;
    return r;
  }
}

/* ============================================================================
 * Units / musical math
 * ========================================================================= */

export const dbToLin = (db: number) => Math.pow(10, db / 20);

export function bpmOf(project: Project): number {
  return project.tempoMap[0]?.bpm ?? 120;
}

export function beatsPerBarOf(project: Project): number {
  const ts = project.timeSigMap[0];
  return ts ? (ts.num * 4) / ts.den : 4;
}

export const msPerBeat = (bpm: number) => 60000 / bpm;

/** ms → beats at the given tempo (clip nudges, pre-delays). */
export const msToBeats = (ms: number, bpm: number) => ms / msPerBeat(bpm);

/** First bar line at or after `beat`. */
export function nextBarBeat(ctx: TechniqueCtx, beat = ctx.playheadBeat): number {
  const bar = ctx.beatsPerBar;
  return Math.ceil(beat / bar - 1e-9) * bar;
}

/* ============================================================================
 * Tracks / buses / inserts
 * ========================================================================= */

export async function newTrack(
  tx: Tx,
  kind: "audio" | "instrument" | "bus" | "midi",
  name: string,
): Promise<Track> {
  const r = await tx.cmd(addTrack(kind, { name }));
  return r.track;
}

/**
 * Add a built-in insert and dial its settings — values in REAL units by param NAME
 * (norm.ts maps them onto the wire's normalized 0..1; unknown names throw, and
 * catalog.test.ts walks every technique's settings so they throw in CI, not here).
 * Param ids come from plugin/getParams at run time (read, not an undo entry);
 * each set is one undo entry, counted.
 */
export async function addInsert(
  tx: Tx,
  trackId: number,
  uid: string,
  settings: Record<string, number> = {},
): Promise<PluginInstance> {
  const { instance } = await tx.cmd(addPlugin(trackId, uid));
  const names = Object.keys(settings);
  if (names.length > 0) {
    const { params } = await getPluginParams(instance.instanceId);
    for (const name of names) {
      const p = params.find((x) => x.name === name);
      if (!p) throw new Error(`addInsert: ${uid} has no param named "${name}"`);
      await tx.cmd(setPluginParam(instance.instanceId, p.id, normFor(uid, name, settings[name])));
    }
  }
  return instance;
}

/** Replace a track's channel-EQ bands (one undo entry). */
export async function setEqBands(tx: Tx, trackId: number, bands: EqBand[]): Promise<void> {
  await tx.cmd(setTrackEq(trackId, { bypass: false, bands }));
}

export const eqLowCut = (freqHz: number, q = 0.7): EqBand => ({
  enabled: true,
  type: 4, // lowCut
  freqHz,
  gainDb: 0,
  q,
});

export const eqHighCut = (freqHz: number, q = 0.7): EqBand => ({
  enabled: true,
  type: 3, // highCut
  freqHz,
  gainDb: 0,
  q,
});

/**
 * Add a send from `trackId` to `destTrackId` at a linear level; returns the new
 * send's INDEX (sends append — index = source track's send count before the add,
 * read from the CURRENT store project snapshot passed in).
 */
export async function sendTo(
  tx: Tx,
  project: Project,
  trackId: number,
  destTrackId: number,
  level: number,
): Promise<number> {
  const src = project.tracks.find((t) => t.id === trackId);
  const index = src ? src.sends.length : 0;
  await tx.cmd(addSend(trackId, destTrackId, level));
  return index;
}

/* ============================================================================
 * Clips / notes / automation
 * ========================================================================= */

export async function newMidiClip(
  tx: Tx,
  trackId: number,
  startBeat: number,
  lengthBeats: number,
): Promise<MidiClip> {
  const r = await tx.cmd(addMidiClip(trackId, startBeat, lengthBeats));
  return r.clip;
}

/** One undo entry for the whole batch (cmd/notes.edit contract). */
export async function addNotes(tx: Tx, clipId: number, notes: NoteInput[]): Promise<void> {
  await tx.cmd(editNotes(clipId, { add: notes }));
}

/** Write an automation ramp (one undo entry per lane). */
export async function ramp(
  tx: Tx,
  trackId: number,
  paramRef: string,
  points: AutomationAddPoint[],
): Promise<void> {
  await tx.cmd(setAutomation(trackId, paramRef, { add: points }));
}

export const pluginParamRef = (instanceId: number, paramId: number) =>
  `plugin:${instanceId}:${paramId}`;

/** Make a generated MIDI clip the piano roll's active clip (UI state, no undo entry) —
 *  pattern stages call this so their reveal ("pianoRoll") shows the new notes. */
export function focusMidiClip(clipId: number): void {
  const s = useStore.getState();
  s.setActiveMidiClipId(clipId);
  s.setSelection({ clipIds: [clipId], noteIds: [] });
}

/** Find a builtin instance's param id by name (read-only, no undo entry). */
export async function paramIdByName(instanceId: number, name: string): Promise<number> {
  const { params } = await getPluginParams(instanceId);
  const p = params.find((x) => x.name === name);
  if (!p) throw new Error(`paramIdByName: no param "${name}" on instance ${instanceId}`);
  return p.id;
}

/* ============================================================================
 * Context snapshot + common lookups
 * ========================================================================= */

export function selectedTrack(ctx: TechniqueCtx): Track | null {
  const id = ctx.selection.trackIds[0];
  return ctx.project.tracks.find((t) => t.id === id) ?? null;
}

export function findClip(ctx: TechniqueCtx, clipId: number): { track: Track; clip: Track["clips"][number] } | null {
  for (const t of ctx.project.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return null;
}

export const isAudioLike = (t: Track) => t.kind === "audio" || t.kind === "instrument";

/** Every AUDIO clip in the project, with its track (pickers + resolvers). */
export function allAudioClips(ctx: TechniqueCtx): Array<{ track: Track; clip: Track["clips"][number] }> {
  const out: Array<{ track: Track; clip: Track["clips"][number] }> = [];
  for (const t of ctx.project.tracks)
    for (const c of t.clips) if (c.type === "audio") out.push({ track: t, clip: c });
  return out;
}

/** Every MIDI clip in the project, with its track. */
export function allMidiClips(ctx: TechniqueCtx): Array<{ track: Track; clip: MidiClip }> {
  const out: Array<{ track: Track; clip: MidiClip }> = [];
  for (const t of ctx.project.tracks)
    for (const c of t.clips) if (c.type === "midi") out.push({ track: t, clip: c });
  return out;
}

/** Resolve a MIDI-clip param (explicit id → that clip; 0 → first selected MIDI clip). */
export function resolveMidiClip(
  ctx: TechniqueCtx,
  clipId: number | undefined,
): { track: Track; clip: MidiClip } | null {
  const all = allMidiClips(ctx);
  if (clipId !== undefined && clipId !== 0) return all.find((x) => x.clip.id === clipId) ?? null;
  for (const id of ctx.selection.clipIds) {
    const hit = all.find((x) => x.clip.id === id);
    if (hit) return hit;
  }
  return null;
}

/** cmd/clip.stretch transpose semantics: pitch × ratio at constant length —
 *  ratio = 2^(semitones/12) (engine clamps 0.25..4 = ±24 st). */
export const pitchRatio = (semitones: number) => Math.pow(2, semitones / 12);

/**
 * Resolve a clip-param value: explicit id → that audio clip; 0/absent → the first
 * SELECTED audio clip; null when neither resolves.
 */
export function resolveAudioClip(
  ctx: TechniqueCtx,
  clipId: number | undefined,
): { track: Track; clip: Track["clips"][number] } | null {
  const all = allAudioClips(ctx);
  if (clipId !== undefined && clipId !== 0) return all.find((x) => x.clip.id === clipId) ?? null;
  for (const id of ctx.selection.clipIds) {
    const hit = all.find((x) => x.clip.id === id);
    if (hit) return hit;
  }
  return null;
}
export const isMixerTrack = (t: Track) =>
  t.kind === "audio" || t.kind === "instrument" || t.kind === "bus" || t.kind === "midi";
