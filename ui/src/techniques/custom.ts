/**
 * Custom techniques (the "Custom — Your Techniques" category): user-composed flows
 * built in the wizard's Builder by REMIXING the shipped catalog — each step is a
 * reference to an existing technique's stage. Borrowed stages bring their params,
 * manual instructions, reveal target and state-fallback lookups along, so a custom
 * flow behaves exactly like a shipped one in the wizard (Apply / do-it-myself /
 * Take Back / Apply All / summary).
 *
 * Persistence: localStorage pref `techniques.custom` (per-user, not per-project —
 * a technique is a way of working, not document data). A step whose source
 * technique/stage no longer exists resolves to nothing and is reported, never
 * silently dropped at RUN time (resolveCustom returns the missing list).
 */

import { loadPref, savePref } from "../lib/prefs";
import type { Requirement, StageDef, TechniqueCtx, TechniqueDef } from "./types";

export interface CustomStepRef {
  /** Source technique id (e.g. "sidechain-pump"). */
  tech: string;
  /** Stage id within it (e.g. "key"). */
  stage: string;
}

export interface CustomTechniqueData {
  id: string; // "custom-<n>"
  title: string;
  tagline: string;
  description: string;
  steps: CustomStepRef[];
}

const PREF = "techniques.custom";

function validCustomList(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.every(
    (d) =>
      d !== null &&
      typeof d === "object" &&
      typeof (d as CustomTechniqueData).id === "string" &&
      typeof (d as CustomTechniqueData).title === "string" &&
      Array.isArray((d as CustomTechniqueData).steps) &&
      (d as CustomTechniqueData).steps.every(
        (st) => st !== null && typeof st === "object" &&
          typeof (st as CustomStepRef).tech === "string" &&
          typeof (st as CustomStepRef).stage === "string",
      ),
  );
}

export function loadCustomTechniques(): CustomTechniqueData[] {
  return loadPref<CustomTechniqueData[]>(PREF, [], validCustomList);
}

export function saveCustomTechniques(list: CustomTechniqueData[]): void {
  savePref(PREF, list);
}

export function freshCustomId(list: CustomTechniqueData[]): string {
  let n = 0;
  for (const d of list) {
    const m = /^custom-(\d+)$/.exec(d.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `custom-${n + 1}`;
}

export interface ResolvedCustom {
  def: TechniqueDef;
  /** Step refs whose source technique/stage no longer exists in the catalog. */
  missing: CustomStepRef[];
}

/**
 * Materialize a stored custom technique against the live catalog. Requirements =
 * the union (deduped by label, minus fix duplication) of every source technique's
 * requirements — a borrowed stage keeps its original preconditions honest.
 */
export function resolveCustom(
  data: CustomTechniqueData,
  catalog: TechniqueDef[],
): ResolvedCustom {
  const stages: StageDef[] = [];
  const missing: CustomStepRef[] = [];
  const sources: TechniqueDef[] = [];
  data.steps.forEach((ref, i) => {
    const tech = catalog.find((t) => t.id === ref.tech);
    const stage = tech?.stages.find((s) => s.id === ref.stage);
    if (!tech || !stage) {
      missing.push(ref);
      return;
    }
    if (!sources.includes(tech)) sources.push(tech);
    // Unique stage id per step (the same stage may be borrowed twice); title carries
    // the source so a remixed list stays readable.
    stages.push({
      ...stage,
      id: `${i}-${ref.tech}-${ref.stage}`,
      title: `${stage.title} (${tech.title})`,
    });
  });
  const def: TechniqueDef = {
    id: data.id,
    category: "custom",
    title: data.title || "Untitled technique",
    tagline: data.tagline || `${stages.length} borrowed steps`,
    description:
      data.description ||
      `Your composed flow: ${stages.length} steps borrowed from ${sources.map((s) => s.title).join(", ") || "the catalog"}.`,
    stages,
    requirements: (ctx: TechniqueCtx): Requirement[] => {
      const out: Requirement[] = [];
      const seen = new Set<string>();
      for (const src of sources)
        for (const r of src.requirements(ctx)) {
          if (seen.has(r.label)) continue;
          seen.add(r.label);
          out.push(r);
        }
      return out;
    },
  };
  return { def, missing };
}
