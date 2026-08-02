/**
 * The technique catalog — aggregated per category. Adding technique #11 = one
 * TechniqueDef in its category file + a row moved in
 * docs/PRODUCTION_TECHNIQUES_BACKLOG.md. catalog.test.ts guards integrity
 * (unique ids, 2+ per category, stages 2..4, manual text everywhere).
 */

import { transitionTechniques } from "./transitions";
import { mixingTechniques } from "./mixing";
import { vocalTechniques } from "./vocal";
import { editingTechniques } from "./editing";
import { masterTechniques } from "./master";
import type { TechniqueDef, TechniqueCategory } from "../types";
import type { IconName } from "../../components/common/icons";

export const TECHNIQUES: TechniqueDef[] = [
  ...transitionTechniques,
  ...mixingTechniques,
  ...vocalTechniques,
  ...editingTechniques,
  ...masterTechniques,
];

export function techniqueById(id: string): TechniqueDef | undefined {
  return TECHNIQUES.find((t) => t.id === id);
}

/**
 * Card/tooltip icon per technique (existing icon set only — no new glyphs).
 * catalog.test.ts enforces every technique has an entry and no entry is an orphan,
 * so adding technique #56 without picking an icon fails the suite, not the eye.
 */
export const TECHNIQUE_ICONS: Record<string, IconName> = {
  // transitions
  "riser-buildup": "zoomIn",
  "snare-roll": "metronome",
  "tape-stop": "stop",
  "reverse-build": "undo",
  downlifter: "zoomOut",
  "noise-sweep": "audioWave",
  "predrop-silence": "mute",
  "impact-rumble": "power",
  "reverse-reverb-swell": "refresh",
  "half-time-drop": "snowflake",
  "chord-swell": "staff",
  // mixing
  "sidechain-pump": "link",
  "vocal-reverb-send": "export",
  "haas-widener": "split",
  "telephone-section": "headphones",
  "ducking-bed": "mic",
  "auto-pan": "loop",
  "gated-reverb": "lock",
  "vocal-presence": "sparkles",
  "trance-gate": "snap",
  "eq-slotting": "sliders",
  "lcr-spread": "layers",
  // vocal
  "vocal-doubler": "layers",
  "delay-throw": "redo",
  slapback: "refresh",
  "harmony-stack": "staff",
  "octave-under": "chevronDown",
  "adlib-space": "marker",
  "vocal-gate": "lock",
  "adt-double": "link",
  "gang-stack": "solo",
  "pitch-drop-tag": "chevronDown",
  "vocal-heat": "power",
  // editing
  "chop-sampler": "scissors",
  "stutter-fill": "split",
  "glitch-ratchet": "snap",
  "reverse-chops": "undo",
  "humanize-groove": "dragHandle",
  "midi-echo": "midiNote",
  "beat-shuffle": "refresh",
  "pitch-chop-riser": "zoomIn",
  "arp-builder": "piano",
  "ghost-notes": "dot",
  "strum-humanizer": "pointer",
  // master
  "master-glue": "glue",
  "parallel-crush": "mixer",
  "stem-buses": "layers",
  "vca-groups": "sliders",
  "headroom-reset": "zoomOut",
  "drum-bus-glue": "glue",
  "mono-check": "eye",
  "mixbus-pump": "metronome",
  "mixbus-color": "sparkles",
  "master-eq-tilt": "settings",
  "loudness-ladder": "chevronUp",
};

const CATEGORY_FALLBACK_ICON: Record<TechniqueCategory, IconName> = {
  transitions: "flag",
  mixing: "mixer",
  vocal: "mic",
  editing: "scissors",
  master: "sliders",
};

export function techniqueIcon(t: TechniqueDef): IconName {
  return TECHNIQUE_ICONS[t.id] ?? CATEGORY_FALLBACK_ICON[t.category];
}
