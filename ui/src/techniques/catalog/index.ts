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
import type { TechniqueDef } from "../types";

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
