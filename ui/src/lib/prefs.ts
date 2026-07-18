/**
 * Persistent per-user UI preferences (localStorage) — owned by F4.
 *
 * Small, deliberate user choices (panel sizes, active tabs, zoom, theme, toggles) that
 * should survive a reload but do NOT belong in the project file (they are per-user,
 * not per-document) and do NOT need the engine (they must be readable synchronously at
 * store-init time, before the WebSocket connects).
 *
 * Keys are namespaced "mydaw.<area>.<name>". Values are JSON. Reads are validated —
 * a malformed or out-of-range stored value falls back to the default instead of
 * poisoning the UI. All writes swallow storage errors (private mode, quota).
 *
 *   loadPref("ui.browserW", 280, numberIn(200, 400))
 *   savePref("ui.tool", "draw")
 *   savePrefDebounced("ui.viewport", {...})      // high-frequency (drag) writers
 *   const [wide, setWide] = usePrefState("mixer.wide", true, isBool)
 */

import { useCallback, useState } from "react";

const PREFIX = "mydaw.";

/* ============================================================================
 * Validators
 * ========================================================================= */

export type PrefValidator = (v: unknown) => boolean;

export const isBool: PrefValidator = (v) => typeof v === "boolean";

export const isFiniteNumber: PrefValidator = (v) => typeof v === "number" && Number.isFinite(v);

/** Finite number within [lo, hi]. */
export function numberIn(lo: number, hi: number): PrefValidator {
  return (v) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

/** One of a fixed set of (usually string) literals. */
export function oneOf<T>(...allowed: T[]): PrefValidator {
  return (v) => allowed.includes(v as T);
}

/** Plain object whose listed fields each pass their validator (extra fields ignored). */
export function shapeOf(fields: Record<string, PrefValidator>): PrefValidator {
  return (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    return Object.entries(fields).every(([k, valid]) => valid(o[k]));
  };
}

/* ============================================================================
 * Load / save
 * ========================================================================= */

export function loadPref<T>(key: string, fallback: T, valid?: PrefValidator): T {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREFIX + key);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    if (valid && !valid(v)) return fallback;
    return v as T;
  } catch {
    return fallback;
  }
}

/**
 * Boolean load that also accepts the legacy raw "1"/"0" values written before this
 * module existed (mydaw.mixer.wide, mydaw.pianoRoll.audition) — JSON.parse turns
 * those into the numbers 1/0.
 */
export function loadBoolPref(key: string, fallback: boolean): boolean {
  const v = loadPref<unknown>(key, fallback);
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1") return true;
  if (v === 0 || v === "0") return false;
  return fallback;
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* private mode / quota — prefs are best-effort */
  }
}

const debounceTimers = new Map<string, number>();

/** Debounced save for high-frequency writers (resize/zoom drags). Trailing edge. */
export function savePrefDebounced(key: string, value: unknown, ms = 300): void {
  const t = debounceTimers.get(key);
  if (t !== undefined) window.clearTimeout(t);
  debounceTimers.set(
    key,
    window.setTimeout(() => {
      debounceTimers.delete(key);
      savePref(key, value);
    }, ms),
  );
}

/* ============================================================================
 * React hook
 * ========================================================================= */

/**
 * useState that loads its initial value from a pref and persists every set
 * (debounced, so drag-driven setters are safe). Functional updates supported.
 */
export function usePrefState<T>(
  key: string,
  fallback: T,
  valid?: PrefValidator,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => loadPref(key, fallback, valid));
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        savePrefDebounced(key, next);
        return next;
      });
    },
    [key],
  );
  return [value, set];
}
