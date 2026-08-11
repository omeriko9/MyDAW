/**
 * Per-plugin visual identity, shared by the Browser plugins tab (and any future picker):
 * the fallback chain is USER EMOJI OVERRIDE → extracted PNG (registry `iconKey`, served
 * at /api/plugin-icon/<key>) → vendor-colored initial avatar. Most VST2 DLLs carry no
 * icon resource, so the avatar is the common look; the emoji override (Omer 2026-08-11)
 * lets the user brand any plugin themselves.
 *
 * Overrides persist in pref `plugins.customIcons` keyed by pluginFavKey (format|uid|
 * bitness — path deliberately excluded so a moved DLL keeps its emoji, same rationale as
 * favorites in lib/ids.ts).
 */

import type { PluginInfo } from "../protocol/types";
import { pluginFavKey } from "./ids";
import { loadPref, savePref } from "./prefs";

const PREF = "plugins.customIcons";

const isRecord = (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");

export function loadCustomIcons(): Record<string, string> {
  return loadPref<Record<string, string>>(PREF, {}, isRecord);
}

/** emoji === "" clears the override. Returns the updated map (storage already written). */
export function setCustomIcon(p: PluginInfo, emoji: string): Record<string, string> {
  const map = loadCustomIcons();
  const key = pluginFavKey(p);
  if (emoji.trim() === "") delete map[key];
  else map[key] = emoji.trim().slice(0, 8); // a couple of code points, not an essay
  savePref(PREF, map);
  return map;
}

export function customIconOf(map: Record<string, string>, p: PluginInfo): string | undefined {
  return map[pluginFavKey(p)];
}

/** Deterministic avatar hue from the vendor string (same vendor = same color). */
export function vendorHue(vendor: string): number {
  let h = 0;
  for (const c of vendor) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((h % 360) + 360) % 360;
}
