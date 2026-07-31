import { describe, it, expect, beforeEach } from "vitest";
import {
  isPluginFavorite,
  loadPluginFavorites,
  pluginFavKey,
  pluginKey,
  togglePluginFavorite,
  type PluginRef,
} from "./ids";

const serum: PluginRef = { format: "vst3", uid: "ABCD", bitness: 64, path: "C:\\VST3\\Serum.vst3" };
/** Same plugin after a version upgrade renamed/moved the file. */
const serumMoved: PluginRef = { ...serum, path: "D:\\Plugins\\VST3\\Serum.vst3" };

/** Minimal localStorage for the node test env (prefs swallows a missing one). */
function stubStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("plugin favourites", () => {
  beforeEach(stubStorage);

  it("honours all three key generations on read", () => {
    expect(isPluginFavorite(new Set([pluginFavKey(serum)]), serum)).toBe(true);
    expect(isPluginFavorite(new Set([pluginKey(serum)]), serum)).toBe(true); // path-keyed
    expect(isPluginFavorite(new Set([serum.uid]), serum)).toBe(true); // bare uid
    expect(isPluginFavorite(new Set(), serum)).toBe(false);
  });

  it("keeps the star when the plugin file moves or is upgraded", () => {
    const favs = new Set(togglePluginFavorite(serum));
    expect(isPluginFavorite(favs, serumMoved)).toBe(true);
  });

  it("un-starring drops every generation of the key", () => {
    // A pref that accumulated all three spellings of the same plugin.
    togglePluginFavorite(serum);
    const mixed = [...loadPluginFavorites(), pluginKey(serum), serum.uid];
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "mydaw.browser.pluginFavorites",
      JSON.stringify(mixed),
    );
    expect(togglePluginFavorite(serum)).toEqual([]);
  });

  it("writes through storage, so a stale caller cannot clobber another tab's stars", () => {
    togglePluginFavorite(serum); // "our" tab
    // Another tab (its own React state) stars something else and writes the pref.
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "mydaw.browser.pluginFavorites",
      JSON.stringify([pluginFavKey(serum), "vst2|9999|64"]),
    );
    const other: PluginRef = { format: "vst2", uid: "1111", bitness: 64, path: "C:\\a.dll" };
    expect(togglePluginFavorite(other)).toEqual([
      pluginFavKey(serum),
      "vst2|9999|64",
      pluginFavKey(other),
    ]);
  });
});
