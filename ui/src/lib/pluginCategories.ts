/**
 * Plugin category normalization, shared by the Browser plugins tab and the mixer's
 * PluginPicker. Raw `category` strings are vendor soup — VST3 subCategories like
 * "Fx|Reverb" / "Instrument|Synth|Sampler", VST2 kPlugCateg names, Waves shells
 * reporting "Shell|..." — so grouping on the raw value scattered one Reverb group
 * across four spellings. The rule: LAST meaningful `|` segment, with the generic
 * wrappers ("Fx", "Instrument", "Shell", "Effect") stripped.
 */

import type { PluginInfo } from "../protocol/types";

const GENERIC = new Set(["", "fx", "effect", "instrument", "shell", "plugin", "vst"]);

/** "Fx|Reverb" → "Reverb"; "Instrument|Synth" → "Synth"; "Fx"/"" → "Other". */
export function categoryLabel(raw: string): string {
  const segs = raw
    .split("|")
    .map((s) => s.trim())
    .filter((s) => !GENERIC.has(s.toLowerCase()));
  return segs.length > 0 ? segs[segs.length - 1] : "Other";
}

export type PluginsMode = "instruments" | "effects" | "all";

/** The Instruments|Effects|All pane filter (Omer 2026-08-10: the pane is 94% effects —
 *  instruments are what a track usually wants, so they are the default). */
export function matchesMode(p: PluginInfo, mode: PluginsMode): boolean {
  if (mode === "all") return true;
  return mode === "instruments" ? p.isInstrument : !p.isInstrument;
}
