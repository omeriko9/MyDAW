import { getSettings, setSettings } from "../../store/actions";
import {
  applyUiSettings,
  createSettingsBackup,
  parseSettingsBackup,
} from "../../lib/settingsBackup";
import { confirmDialog } from "../Dialogs/confirm";
import { showToast } from "../common/ToastHost";

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

interface WritableHandle {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface SaveHandle {
  createWritable(): Promise<WritableHandle>;
}

interface OpenHandle {
  getFile(): Promise<File>;
}

interface PickerWindow extends Window {
  showSaveFilePicker?: (options: unknown) => Promise<SaveHandle>;
  showOpenFilePicker?: (options: unknown) => Promise<OpenHandle[]>;
}

function cancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function backupName(): string {
  return `MyDAW-settings-${new Date().toISOString().slice(0, 10)}.json`;
}

/** Ask for the destination while the menu click's user activation is still live. */
async function chooseSaveHandle(): Promise<SaveHandle | null | undefined> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      return await picker.call(window, {
        suggestedName: backupName(),
        types: [{ description: "MyDAW settings", accept: { "application/json": [".json"] } }],
      });
    } catch (error) {
      if (cancelled(error)) return null;
      throw error;
    }
  }
  return undefined;
}

async function saveBackupFile(blob: Blob, handle: SaveHandle | undefined): Promise<void> {
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupName();
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function fallbackOpenFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    }, { once: true });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

async function openBackupFile(): Promise<File | null> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (!picker) return fallbackOpenFile();
  try {
    const handles = await picker.call(window, {
      multiple: false,
      types: [{ description: "MyDAW settings", accept: { "application/json": [".json"] } }],
    });
    return handles[0] ? handles[0].getFile() : null;
  } catch (error) {
    if (cancelled(error)) return null;
    throw error;
  }
}

export async function exportSettingsFlow(): Promise<void> {
  const handle = await chooseSaveHandle();
  if (handle === null) return;
  const engine = await getSettings();
  const backup = createSettingsBackup(engine, localStorage);
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
  await saveBackupFile(blob, handle);
  showToast("Settings exported.", "success");
}

export async function importSettingsFlow(): Promise<void> {
  const file = await openBackupFile();
  if (!file) return;
  if (file.size > MAX_BACKUP_BYTES) throw new Error("Settings backup is larger than 10 MB.");
  const backup = parseSettingsBackup(await file.text());
  const ok = await confirmDialog({
    title: "Import Settings",
    message:
      `Import settings exported on ${new Date(backup.exportedAt).toLocaleString()}?\n\n` +
      "This replaces matching preferences and reloads the interface. Audio driver changes may require restarting the engine.",
    confirmLabel: "Import",
  });
  if (!ok) return;

  await setSettings(backup.engine);
  applyUiSettings(backup.ui, localStorage);
  showToast("Settings imported. Reloading…", "success", { durationMs: 1_000 });
  window.setTimeout(() => window.location.reload(), 500);
}
