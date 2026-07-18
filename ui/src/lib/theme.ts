/**
 * Theme switching (owned by F4) — dark (default) / slate / sepia / light.
 *
 * The palette lives in CSS custom properties (theme.css): dark values on :root,
 * every other theme restating the same contract under :root[data-theme="…"].
 * Each theme also defines per-pane surface tints (--pane-*) so the editors are
 * distinguishable at a glance. Switching = stamping the
 * data-theme attribute on every live document (main window + pop-out panes) and
 * broadcasting THEME_EVENT so canvas renderers re-resolve their cached colors
 * (layout.ts themeVar / prDraw palettes key their caches by theme).
 *
 * index.html applies the saved theme inline before first paint (no flash);
 * initTheme() re-applies it defensively at module init.
 */

import { useEffect, useState } from "react";
import { loadPref, oneOf, savePref } from "./prefs";

/**
 * Slate and Sepia are deliberately mid-tone rather than another dark/light pair:
 * Slate is a cool blue-grey with light type, Sepia a warm paper with dark type.
 */
export type ThemeName = "dark" | "light" | "slate" | "sepia";

/** window CustomEvent fired (on the MAIN window) after the theme changed. */
export const THEME_EVENT = "mydaw:themechange";

export const THEMES: Array<{ value: ThemeName; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "slate", label: "Slate" },
  { value: "sepia", label: "Sepia" },
  { value: "light", label: "Light" },
];

const isThemeName = oneOf<ThemeName>("dark", "light", "slate", "sepia");

let current: ThemeName = loadPref<ThemeName>("ui.theme", "dark", isThemeName);

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
  const t = el.ownerDocument.documentElement.dataset.theme;
  return isThemeName(t) ? (t as ThemeName) : "dark";
}

/** True for themes whose surfaces are light enough to need dark type. */
export const isLightTheme = (t: ThemeName): boolean => t === "light" || t === "sepia";

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
