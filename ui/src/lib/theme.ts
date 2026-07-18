/**
 * Theme switching (owned by F4) — dark (default) / light.
 *
 * The palette lives in CSS custom properties (theme.css): dark values on :root,
 * light overrides under :root[data-theme="light"]. Switching = stamping the
 * data-theme attribute on every live document (main window + pop-out panes) and
 * broadcasting THEME_EVENT so canvas renderers re-resolve their cached colors
 * (layout.ts themeVar / prDraw palettes key their caches by theme).
 *
 * index.html applies the saved theme inline before first paint (no flash);
 * initTheme() re-applies it defensively at module init.
 */

import { useEffect, useState } from "react";
import { loadPref, oneOf, savePref } from "./prefs";

export type ThemeName = "dark" | "light";

/** window CustomEvent fired (on the MAIN window) after the theme changed. */
export const THEME_EVENT = "mydaw:themechange";

export const THEMES: Array<{ value: ThemeName; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

let current: ThemeName = loadPref<ThemeName>("ui.theme", "dark", oneOf<ThemeName>("dark", "light"));

/** Pop-out documents that must be stamped along with the main one. */
const extraDocs = new Set<Document>();

function stamp(doc: Document, theme: ThemeName): void {
  doc.documentElement.dataset.theme = theme;
}

export function getTheme(): ThemeName {
  return current;
}

/** Resolved theme of the document an element lives in (pop-outs have their own). */
export function themeOf(el: Element): ThemeName {
  return el.ownerDocument.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Track a pop-out document: stamped immediately and on every later switch.
 * Returns the unregister function (call from the pop-out's dispose).
 */
export function registerThemeDocument(doc: Document): () => void {
  extraDocs.add(doc);
  stamp(doc, current);
  return () => {
    extraDocs.delete(doc);
  };
}

export function applyTheme(theme: ThemeName): void {
  current = theme;
  savePref("ui.theme", theme);
  stamp(document, theme);
  for (const doc of extraDocs) {
    try {
      stamp(doc, theme);
    } catch {
      /* popup already destroyed — unregister happens via its dispose */
    }
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

/** Apply the persisted theme to the main document (idempotent; called at startup). */
export function initTheme(): void {
  stamp(document, current);
}

/** React hook — current theme as state (re-renders on switch, e.g. canvas deps). */
export function useThemeName(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(current);
  useEffect(() => {
    const on = () => setTheme(current);
    window.addEventListener(THEME_EVENT, on);
    return () => window.removeEventListener(THEME_EVENT, on);
  }, []);
  return theme;
}
