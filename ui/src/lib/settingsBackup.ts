/** Versioned, portable backup format for engine settings + browser-side preferences. */

import type { AppSettings } from "../protocol/types";

export const SETTINGS_BACKUP_FORMAT = "mydaw-settings-backup";
export const SETTINGS_BACKUP_VERSION = 1;
const PREF_PREFIX = "mydaw.";

export interface SettingsBackup {
  format: typeof SETTINGS_BACKUP_FORMAT;
  version: typeof SETTINGS_BACKUP_VERSION;
  exportedAt: string;
  engine: AppSettings;
  /** Exact localStorage strings, so legacy non-JSON preferences also round-trip. */
  ui: Record<string, string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function collectUiSettings(storage: Storage): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key?.startsWith(PREF_PREFIX)) continue;
    const value = storage.getItem(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

export function createSettingsBackup(
  engine: AppSettings,
  storage: Storage,
  now = new Date(),
): SettingsBackup {
  return {
    format: SETTINGS_BACKUP_FORMAT,
    version: SETTINGS_BACKUP_VERSION,
    exportedAt: now.toISOString(),
    engine,
    ui: collectUiSettings(storage),
  };
}

export function parseSettingsBackup(text: string): SettingsBackup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (!isPlainObject(value) || value.format !== SETTINGS_BACKUP_FORMAT) {
    throw new Error("That is not a MyDAW settings backup.");
  }
  if (value.version !== SETTINGS_BACKUP_VERSION) {
    throw new Error(`Unsupported settings backup version: ${String(value.version)}.`);
  }
  if (
    typeof value.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    !isPlainObject(value.engine) ||
    !isPlainObject(value.ui)
  ) {
    throw new Error("The settings backup is incomplete or malformed.");
  }
  const ui: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value.ui)) {
    if (!key.startsWith(PREF_PREFIX) || typeof raw !== "string") {
      throw new Error("The settings backup contains an invalid UI preference.");
    }
    ui[key] = raw;
  }
  return { ...value, engine: value.engine as AppSettings, ui } as SettingsBackup;
}

/** Merge the imported preferences without touching unrelated site storage. */
export function applyUiSettings(settings: Record<string, string>, storage: Storage): void {
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(PREF_PREFIX)) storage.setItem(key, value);
  }
}
