/**
 * Accent-color personalization (UI_IMPROVE.md §9, owned by F4) — an optional
 * user accent that overrides the theme's --accent family. One stored hex; the
 * derived tokens (hover/active/soft/border/on-accent/selection) are COMPUTED
 * against the current theme's surfaces, so every theme stays readable.
 *
 * Applied as inline custom properties on the document root (main + pop-outs,
 * like lib/theme). Re-derived on every theme switch: this module subscribes to
 * THEME_EVENT at import time — before any React canvas listener exists — so by
 * the time canvases re-resolve their palettes the overrides are in place.
 * applyAccent() itself also fires THEME_EVENT so canvases pick up accent-only
 * changes.
 */

import { loadPref, savePref } from "./prefs";
import { isLightTheme, getTheme, THEME_EVENT } from "./theme";

const PREF = "ui.accent";

export const ACCENT_SWATCHES: Array<{ value: string; label: string }> = [
  { value: "#5b8cff", label: "Blue" },
  { value: "#4dc3cd", label: "Cyan" },
  { value: "#56c596", label: "Mint" },
  { value: "#8fc457", label: "Green" },
  { value: "#d8a14a", label: "Amber" },
  { value: "#e2814d", label: "Orange" },
  { value: "#d165d6", label: "Magenta" },
  { value: "#a06ee8", label: "Purple" },
];

const isHex = (v: unknown): boolean => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

let current: string | null = loadPref<string | null>(PREF, null, (v) => v === null || isHex(v));

/** Pop-out documents that must be stamped along with the main one. */
const extraDocs = new Set<Document>();

/* ---- color math ---- */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function toHex(c: Rgb): string {
  const p = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function luminance(c: Rgb): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

/* ---- stamping ---- */

const VARS = [
  "--accent",
  "--accent-hover",
  "--accent-active",
  "--accent-soft",
  "--accent-border",
  "--on-accent",
  "--selection",
] as const;

function stamp(doc: Document): void {
  const st = doc.documentElement.style;
  if (current === null) {
    for (const v of VARS) st.removeProperty(v);
    return;
  }
  const acc = hexToRgb(current);
  const light = isLightTheme(getTheme());
  // Read the THEME's background to blend soft/border tints against (computed
  // value of --bg without our overrides — --bg is never overridden here).
  const bgStr = getComputedStyle(doc.documentElement).getPropertyValue("--bg").trim();
  const bg = isHex(bgStr) ? hexToRgb(bgStr) : light ? WHITE : { r: 22, g: 23, b: 28 };

  st.setProperty("--accent", current);
  st.setProperty("--accent-hover", toHex(mix(acc, light ? BLACK : WHITE, light ? 0.12 : 0.14)));
  // pressed state sits slightly darker than the accent on every theme family
  st.setProperty("--accent-active", toHex(mix(acc, BLACK, light ? 0.2 : 0.1)));
  st.setProperty("--accent-soft", toHex(mix(acc, bg, 0.78)));
  st.setProperty("--accent-border", toHex(mix(acc, bg, 0.55)));
  st.setProperty("--on-accent", luminance(acc) > 0.62 ? "#1a1d26" : "#ffffff");
  st.setProperty("--selection", `rgba(${acc.r},${acc.g},${acc.b},0.25)`);
}

function stampAll(): void {
  stamp(document);
  for (const doc of extraDocs) {
    try {
      stamp(doc);
    } catch {
      /* popup already destroyed */
    }
  }
}

export function getAccent(): string | null {
  return current;
}

/** Track a pop-out document; returns the unregister function. */
export function registerAccentDocument(doc: Document): () => void {
  extraDocs.add(doc);
  stamp(doc);
  return () => {
    extraDocs.delete(doc);
  };
}

/** hex like "#8fc457", or null = the theme's own accent. */
export function applyAccent(hex: string | null): void {
  current = hex;
  savePref(PREF, hex);
  stampAll();
  // Canvas renderers key their palette caches off THEME_EVENT — poke them.
  window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

/** Apply the persisted accent (idempotent; called at startup) + follow theme switches. */
export function initAccent(): void {
  stampAll();
  // Re-derive soft/border blends when the theme (and so --bg) changes. Module
  // import order puts this listener ahead of React canvas listeners.
  window.addEventListener(THEME_EVENT, () => {
    if (current !== null) stampAll();
  });
}
