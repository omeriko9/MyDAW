/**
 * Per-user technique-browser preferences (localStorage via lib/prefs):
 *  - favorites: starred technique ids (shipped AND custom) → the ★ Favorites filter
 *  - category order: which category the rail lists first (right-click a category
 *    to move it) — merged against CATEGORY_ORDER so new categories appear at the
 *    end instead of vanishing when the stored list predates them.
 */

import { loadPref, savePref } from "../lib/prefs";
import { CATEGORY_ORDER, type TechniqueCategory } from "./types";

const FAV_PREF = "techniques.favorites";
const ORDER_PREF = "techniques.catOrder";

export function loadTechFavorites(): string[] {
  return loadPref<string[]>(FAV_PREF, [], (v) => Array.isArray(v) && v.every((x) => typeof x === "string"));
}

export function saveTechFavorites(list: string[]): void {
  savePref(FAV_PREF, list);
}

export function toggleTechFavorite(id: string): string[] {
  const cur = loadTechFavorites();
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  saveTechFavorites(next);
  return next;
}

/** Stored order sanitized: unknown entries dropped, missing categories appended. */
export function loadCatOrder(): TechniqueCategory[] {
  const stored = loadPref<string[]>(ORDER_PREF, [], (v) => Array.isArray(v) && v.every((x) => typeof x === "string"));
  const known = stored.filter((c): c is TechniqueCategory =>
    (CATEGORY_ORDER as string[]).includes(c),
  );
  for (const c of CATEGORY_ORDER) if (!known.includes(c)) known.push(c);
  return known;
}

export function saveCatOrder(list: TechniqueCategory[]): void {
  savePref(ORDER_PREF, list);
}

export function moveCategory(
  order: TechniqueCategory[],
  cat: TechniqueCategory,
  to: "top" | "up" | "down",
): TechniqueCategory[] {
  const i = order.indexOf(cat);
  if (i < 0) return order;
  const next = [...order];
  next.splice(i, 1);
  const j = to === "top" ? 0 : to === "up" ? Math.max(0, i - 1) : Math.min(next.length, i + 1);
  next.splice(j, 0, cat);
  return next;
}
