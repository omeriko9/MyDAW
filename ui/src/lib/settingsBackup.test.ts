import { describe, expect, it } from "vitest";
import {
  applyUiSettings,
  createSettingsBackup,
  parseSettingsBackup,
  SETTINGS_BACKUP_FORMAT,
} from "./settingsBackup";

function storage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("settings backup", () => {
  it("exports engine settings and only MyDAW browser preferences", () => {
    const store = storage({ "mydaw.ui.theme": '"slate"', unrelated: "leave me" });
    const backup = createSettingsBackup({ autosaveMinutes: 5 }, store, new Date("2026-08-02T12:00:00Z"));
    expect(backup).toEqual({
      format: SETTINGS_BACKUP_FORMAT,
      version: 1,
      exportedAt: "2026-08-02T12:00:00.000Z",
      engine: { autosaveMinutes: 5 },
      ui: { "mydaw.ui.theme": '"slate"' },
    });
  });

  it("validates and restores a backup without changing unrelated storage", () => {
    const parsed = parseSettingsBackup(JSON.stringify({
      format: SETTINGS_BACKUP_FORMAT,
      version: 1,
      exportedAt: "2026-08-02T12:00:00.000Z",
      engine: { pluginFoldersVst2: ["C:/VST"] },
      ui: { "mydaw.ui.theme": '"light"' },
    }));
    const store = storage({ unrelated: "keep" });
    applyUiSettings(parsed.ui, store);
    expect(store.getItem("mydaw.ui.theme")).toBe('"light"');
    expect(store.getItem("unrelated")).toBe("keep");
  });

  it("rejects JSON that is not a supported MyDAW backup", () => {
    expect(() => parseSettingsBackup("{}"))
      .toThrow("not a MyDAW settings backup");
    expect(() => parseSettingsBackup(JSON.stringify({ format: SETTINGS_BACKUP_FORMAT, version: 99 })))
      .toThrow("Unsupported settings backup version");
  });
});
