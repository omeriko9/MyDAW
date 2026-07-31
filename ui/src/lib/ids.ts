/**
 * Client-side temporary ids for optimistic operations.
 *
 * Engine ids are uint64, monotonically increasing, always > 0 (SPEC §4, Model::nextId).
 * The UI uses NEGATIVE ids for objects it creates optimistically before the engine reply
 * arrives (e.g. a note drawn while cmd/notes.edit is in flight). Negative ids never clash
 * with engine ids and are trivially detectable.
 */

import { loadPref, savePref } from "./prefs";

let nextTemp = -1;

/** Allocate a new temporary (negative) id. */
export function tempId(): number {
  return nextTemp--;
}

/** True if `id` is a client-side temporary id (negative). */
export function isTempId(id: number): boolean {
  return id < 0;
}

/** Reset the counter (tests / full project replace). */
export function resetTempIds(): void {
  nextTemp = -1;
}

/**
 * Stable, UNIQUE React key / identity for a registry plugin.
 *
 * uid alone is NOT unique: a VST2 shell (Waves WaveShell, Kontakt, …) reports the same uid
 * for every copy of the shell DLL found, so a uid-only key produces duplicate React keys and
 * rows render on top of each other. The file path disambiguates them.
 */
export function pluginKey(p: PluginRef): string {
  return `${p.format}|${p.uid}|${p.bitness}|${p.path}`;
}

/** The registry fields every plugin identity below is built from. */
export interface PluginRef {
  format: string;
  uid: string;
  bitness: number;
  path: string;
}

/* ============================================================================
 * Favorite plugins (pref "browser.pluginFavorites")
 *
 * ONE reader + ONE writer for the whole app: the Browser's Plugins tab, the Plugin
 * Manager page, the Recreate-plugins dialog and the track-header instrument picker all
 * share this pref, and the last time the key format changed in the writers only, every
 * reader that kept its own copy of the rule went silently dead. Add readers here, not
 * in the components.
 * ========================================================================= */

const FAVORITES_PREF = "browser.pluginFavorites";

const isStringArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Identity a ★ is stored under — deliberately NOT pluginKey.
 *
 * The path is the one part of a plugin's identity that MOVES: a version upgrade renames
 * the DLL (WaveShell1-VST 13.0_x64 → 14.0), and users relocate their VST folder. A
 * path-keyed star dies there, and the orphaned entry can never be un-starred through the
 * UI (only registry rows have a star), so the pref grows dead keys forever. format+uid+
 * bitness survives both. It merges only literal duplicate COPIES of one DLL (same uid,
 * same bitness, two paths) — the same plugin, so one star covering both is correct; the
 * shell sub-plugins that forced pluginKey's path have DISTINCT uids and stay separate.
 */
export function pluginFavKey(p: PluginRef): string {
  return `${p.format}|${p.uid}|${p.bitness}`;
}

/**
 * True if `p` is starred. Three key generations live in the pref and all are honoured on
 * read so nobody loses stars: the stable key above, the full pluginKey (path included),
 * and a bare uid (oldest — it lit up every same-uid variant at once).
 */
export function isPluginFavorite(favorites: ReadonlySet<string>, p: PluginRef): boolean {
  return favorites.has(pluginFavKey(p)) || favorites.has(pluginKey(p)) || favorites.has(p.uid);
}

/** Current favourites, exactly as stored (mixed generations — read via isPluginFavorite). */
export function loadPluginFavorites(): string[] {
  return loadPref<string[]>(FAVORITES_PREF, [], isStringArray);
}

/**
 * Star / un-star `p` and persist; returns the new list.
 *
 * Read-modify-write against storage, NOT against a component's copy: the Plugin Manager
 * runs in a second browser tab on the same pref, so a whole-array write from a copy that
 * was seeded at mount silently dropped whatever the other tab had starred meanwhile.
 * Un-starring drops every generation of the key, otherwise an older entry brings the
 * star straight back.
 */
export function togglePluginFavorite(p: PluginRef): string[] {
  const cur = loadPluginFavorites();
  const next = isPluginFavorite(new Set(cur), p)
    ? cur.filter((k) => k !== pluginFavKey(p) && k !== pluginKey(p) && k !== p.uid)
    : [...cur, pluginFavKey(p)];
  savePref(FAVORITES_PREF, next);
  return next;
}
