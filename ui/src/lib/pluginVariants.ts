/**
 * pluginVariants — collapse shell sub-plugin duplicates into one row per plugin.
 *
 * Waves-style VST2 shells register one sub-plugin per channel routing ("C1 comp Mono",
 * "C1 comp Stereo", "PS01 - Keyboards stereo2stereo") and often ship 32- AND 64-bit
 * shells, so the registry legitimately holds 3-6 rows for what the user thinks of as
 * ONE plugin. Each row has its own uid — the scanner cannot merge them — but the
 * pickers can: group by (format, isInstrument, config-stripped name), pick the best
 * routing (stereo2stereo > stereo > mono2stereo > …) at the highest bitness as the
 * representative, and keep the variant names around for the "×N" badge tooltip.
 */

import type { PluginInfo } from "../protocol/types";
import { pluginKey } from "./ids";

/** Channel-routing / arch tokens shells append to sub-plugin names. */
const CONFIG_TOKENS = new Set([
  "mono",
  "stereo",
  "mono2mono",
  "mono2stereo",
  "stereo2stereo",
  "stereo2mono",
  "m2s",
  "s2s",
  "m2m",
  "s2m",
  "x64",
  "x86",
]);

/** Plugin name with trailing channel-config tokens stripped ("C1 comp Mono" → "C1 comp"). */
export function pluginBaseName(name: string): string {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && CONFIG_TOKENS.has(words[words.length - 1].toLowerCase()))
    words.pop();
  return words.join(" ");
}

/** Routing preference: plain name best, then stereo-ish routings, mono last. */
function configRank(name: string): number {
  const last = name.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  switch (last) {
    case "stereo2stereo":
    case "s2s":
      return 1;
    case "stereo":
      return 2;
    case "mono2stereo":
    case "m2s":
      return 3;
    case "stereo2mono":
    case "s2m":
      return 4;
    case "mono2mono":
    case "m2m":
      return 5;
    case "mono":
      return 6;
    default:
      return CONFIG_TOKENS.has(last) ? 7 : 0; // no config suffix = the plain build
  }
}

export interface GroupedPlugins {
  /** One representative per group, sorted like the input; name left untouched. */
  plugins: PluginInfo[];
  /**
   * pluginKey(representative) → full names of ALL rows in its group (representative
   * included), for the "×N variants" badge/tooltip. Only present for groups > 1.
   */
  variantsByKey: Map<string, string[]>;
}

/**
 * Collapse config/bitness variants. Representative choice: non-blacklisted first, best
 * routing rank, highest bitness, shortest name. Groups keyed by
 * (format, isInstrument, lowercased base name) — VST2 and VST3 stay separate rows.
 */
export function groupPluginVariants(list: readonly PluginInfo[]): GroupedPlugins {
  const groups = new Map<string, PluginInfo[]>();
  for (const p of list) {
    const key = `${p.format}|${p.isInstrument ? 1 : 0}|${pluginBaseName(p.name).toLowerCase()}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const better = (a: PluginInfo, b: PluginInfo): boolean => {
    if (a.blacklisted !== b.blacklisted) return !a.blacklisted;
    const ra = configRank(a.name);
    const rb = configRank(b.name);
    if (ra !== rb) return ra < rb;
    if (a.bitness !== b.bitness) return a.bitness > b.bitness;
    return a.name.length < b.name.length;
  };
  const repByKey = new Map<string, PluginInfo>();
  for (const [key, g] of groups) {
    let rep = g[0];
    for (const p of g) if (better(p, rep)) rep = p;
    repByKey.set(key, rep);
  }
  const variantsByKey = new Map<string, string[]>();
  const plugins: PluginInfo[] = [];
  const emitted = new Set<string>();
  for (const p of list) {
    const key = `${p.format}|${p.isInstrument ? 1 : 0}|${pluginBaseName(p.name).toLowerCase()}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const rep = repByKey.get(key)!;
    const g = groups.get(key)!;
    plugins.push(rep);
    if (g.length > 1)
      variantsByKey.set(
        pluginKey(rep),
        g.map((v) => `${v.name} (${v.format.toUpperCase()} ${v.bitness}-bit)`).sort(),
      );
  }
  return { plugins, variantsByKey };
}
