/**
 * vizMath — pure math shared by the arrangement Minimap and the Visualizer pane
 * (falling notes + 3D stage). No DOM, no store — unit-tested in vizMath.test.ts.
 */

import type { Project, Track } from "../protocol/types";
import { isMidiClip } from "../protocol/types";

/* ============================================================================
 * Note events (falling-notes mode)
 * ========================================================================= */

export interface NoteEvent {
  /** absolute project beat of the onset */
  beat: number;
  lengthBeats: number;
  pitch: number;
  velocity: number;
  /** index into the visualizer's track list (color / meter lookup) */
  trackIndex: number;
  trackId: number;
}

export interface VizTrack {
  id: number;
  name: string;
  color: string;
}

/** midi/instrument tracks in project order (the visualizer's lanes). */
export function vizTracks(project: Project): VizTrack[] {
  return project.tracks
    .filter((t) => t.kind === "midi" || t.kind === "instrument")
    .map((t) => ({ id: t.id, name: t.name, color: t.color || "#5b8cff" }));
}

/** All note onsets of every (non-muted) MIDI clip, sorted by beat. */
export function buildNoteEvents(project: Project): NoteEvent[] {
  const tracks = vizTracks(project);
  const byId = new Map(tracks.map((t, i) => [t.id, i]));
  const out: NoteEvent[] = [];
  for (const track of project.tracks) {
    const trackIndex = byId.get(track.id);
    if (trackIndex === undefined) continue;
    for (const clip of track.clips) {
      if (!isMidiClip(clip) || clip.muted) continue;
      for (const n of clip.notes) {
        // clip-relative → absolute; notes past the clip end are inaudible → skip
        if (n.startBeat >= clip.lengthBeats) continue;
        out.push({
          beat: clip.startBeat + n.startBeat,
          lengthBeats: Math.min(n.lengthBeats, clip.lengthBeats - n.startBeat),
          pitch: n.pitch,
          velocity: n.velocity,
          trackIndex,
          trackId: track.id,
        });
      }
    }
  }
  out.sort((a, b) => a.beat - b.beat);
  return out;
}

/** Pitch range covering the events (min 2 octaves, padded a semitone each side). */
export function pitchRange(events: NoteEvent[]): { lo: number; hi: number } {
  if (events.length === 0) return { lo: 48, hi: 84 };
  let lo = 127;
  let hi = 0;
  for (const e of events) {
    lo = Math.min(lo, e.pitch);
    hi = Math.max(hi, e.pitch);
  }
  lo = Math.max(0, lo - 1);
  hi = Math.min(127, hi + 1);
  while (hi - lo < 24) {
    if (lo > 0) lo--;
    if (hi - lo < 24 && hi < 127) hi++;
    if (lo === 0 && hi === 127) break;
  }
  return { lo, hi };
}

/** Events overlapping the window [fromBeat, toBeat) — assumes `events` sorted by beat. */
export function eventsInWindow(events: NoteEvent[], fromBeat: number, toBeat: number): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const e of events) {
    if (e.beat >= toBeat) break;
    if (e.beat + e.lengthBeats > fromBeat) out.push(e);
  }
  return out;
}

/* ============================================================================
 * Level smoothing (stage + glow) — fast attack, slow release
 * ========================================================================= */

export function smoothLevel(current: number, target: number, dtMs: number): number {
  const t = Math.max(0, Math.min(1, target));
  if (t >= current) {
    const a = 1 - Math.exp(-dtMs / 25); // ~25 ms attack
    return current + (t - current) * a;
  }
  const r = 1 - Math.exp(-dtMs / 300); // ~300 ms release
  return Math.max(0, current + (t - current) * r);
}

/* ============================================================================
 * Minimap mapping
 * ========================================================================= */

/** Uniform mini-row height for n tracks in a strip of `stripH` px. */
export function miniRowH(n: number, stripH: number): number {
  if (n <= 0) return 0;
  return Math.max(1.5, Math.min(6, (stripH - 2) / n));
}

/** beat → x within a minimap of width w showing totalBeats. */
export function miniBeatX(beat: number, totalBeats: number, w: number): number {
  if (totalBeats <= 0) return 0;
  return (beat / totalBeats) * w;
}

/** Center the timeline viewport on the beat under minimap-x (returns new scrollX px). */
export function miniScrollTo(
  x: number,
  totalBeats: number,
  w: number,
  zoomX: number,
  viewW: number,
): number {
  if (w <= 0 || totalBeats <= 0) return 0;
  const beat = (x / w) * totalBeats;
  const maxScroll = Math.max(0, totalBeats * zoomX - viewW);
  return Math.max(0, Math.min(maxScroll, beat * zoomX - viewW / 2));
}

/* ============================================================================
 * 3D stage layout — bars on a floor grid, centered on the origin
 * ========================================================================= */

export interface StageBar {
  x: number;
  z: number;
  trackIndex: number;
}

/** Arrange n bars in a centered grid (≤8 per row), 1.6 units apart. */
export function stageLayout(n: number): StageBar[] {
  const out: StageBar[] = [];
  if (n <= 0) return out;
  const perRow = Math.min(8, Math.ceil(Math.sqrt(n * 2)));
  const rows = Math.ceil(n / perRow);
  const gap = 1.6;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / perRow);
    const inRow = row === rows - 1 ? n - row * perRow : perRow;
    const col = i % perRow;
    out.push({
      x: (col - (inRow - 1) / 2) * gap,
      z: (row - (rows - 1) / 2) * gap,
      trackIndex: i,
    });
  }
  return out;
}
