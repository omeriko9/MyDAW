/**
 * Production Techniques — model (docs/PRODUCTION_TECHNIQUES_PLAN.md).
 *
 * A technique = data + tiny run functions over EXISTING engine primitives. Stages
 * apply automatically (Apply), or manually (every stage carries honest by-hand
 * instructions + "Mark done"), and can be taken back stage-granularly: run() reports
 * how many undoable engine commands it issued, and Take Back = that many edit/undo
 * (the wizard warns when the revision moved since — later edits would be swept up).
 */

import type { Project, Track } from "../protocol/types";
import type { Selection } from "../store/store";

export type TechniqueCategory =
  | "transitions"
  | "mixing"
  | "vocal"
  | "editing"
  | "master"
  | "macros"
  | "custom";

export const CATEGORY_LABELS: Record<TechniqueCategory, string> = {
  transitions: "Transitions & FX",
  mixing: "Mixing — Space & Dynamics",
  vocal: "Vocal Production",
  editing: "Editing & Sound Design",
  master: "Bus, Glue & Master",
  macros: "Macros — Full Flows",
  custom: "Custom — Your Techniques",
};

export const CATEGORY_ORDER: TechniqueCategory[] = [
  "transitions",
  "mixing",
  "vocal",
  "editing",
  "master",
  "macros",
  "custom",
];

/** Snapshot handed to requirements() and run() — read state, never mutate. */
export interface TechniqueCtx {
  project: Project;
  selection: Selection;
  /** Tempo of the project's first tempo point (v1: single-entry map). */
  bpm: number;
  /** Beats per bar from the first time signature (4 when unset). */
  beatsPerBar: number;
  playheadBeat: number;
}

export type ParamKind = "number" | "select" | "track" | "clip";

export interface ParamDef {
  key: string;
  label: string;
  kind: ParamKind;
  /** kind "number" */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** kind "select" */
  options?: Array<{ value: string; label: string }>;
  /** kind "track": which tracks qualify (default: all non-view-row tracks). */
  trackFilter?: (t: Track) => boolean;
  /** kind "clip": which clip type the picker offers (default "audio"). */
  clipKind?: "audio" | "midi";
  /** Context-computed default (track/clip kinds return an id, or 0 = none). */
  default: (ctx: TechniqueCtx) => number | string;
  help?: string;
}

export type ParamValues = Record<string, number | string>;

export interface StageResult {
  /** Undoable engine commands issued — Take Back = this many edit/undo. */
  commands: number;
  /** One-line outcome shown in the wizard ("Riser bus ready — send at −10 dB"). */
  note?: string;
}

/**
 * Scratch shared between one technique run's stages (ids of what stage 1 created,
 * for stage 2 to target). A stage done MANUALLY leaves no state — later stages must
 * fall back to finding their targets (by name/uid/selection) or throw a clear
 * Error; the wizard surfaces the message.
 */
export type StageState = Record<string, unknown>;

export interface StageDef {
  id: string;
  title: string;
  /** What Apply will DO, concretely — shown before running. */
  summary: string;
  /** Honest how-to-do-this-by-hand instructions (the wizard doubles as a teacher). */
  manual: string;
  optional?: boolean;
  params?: ParamDef[];
  /** Pane where this stage's result is VISIBLE — the wizard reveals it (shell-aware,
   *  shell/reveal) right before running, so the user watches the change land. */
  reveal?: "mixer" | "pianoRoll" | "timeline";
  run(ctx: TechniqueCtx, params: ParamValues, state: StageState): Promise<StageResult>;
}

export interface Requirement {
  ok: boolean;
  label: string;
  /** Offered when !ok and the wizard can fix it ("Add a Piano track for me"). */
  fix?: { label: string; run(): Promise<void> };
}

export interface TechniqueDef {
  id: string;
  category: TechniqueCategory;
  title: string;
  /** Card one-liner. */
  tagline: string;
  /** What the listener hears / when to use it. */
  description: string;
  stages: StageDef[];
  requirements(ctx: TechniqueCtx): Requirement[];
}
