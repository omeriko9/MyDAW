/**
 * PastePathDialog (owned by U2) — "Import Project by path".
 *
 * Browsers cannot read full OS paths from a file picker and the engine's native dialog
 * is flaky, so the primary import flow is: paste/type the absolute path of the project
 * file (.cpr / .mid / …) → project/importForeign {path}. Failures (the engine's
 * "import_failed" / "no_provider" text) display inline; "Browse (native)…" falls back
 * to the old dialog/importProject → importForeign flow.
 *
 * Opened imperatively via openImportPathDialog() (module-level open flag — the dialogs
 * store slice is owned elsewhere); <PastePathDialog /> is mounted once from DialogsHost.
 */

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Modal } from "../common/Modal";
import { showToast } from "../common/ToastHost";
import { getImportFormats } from "../../store/actions";
import type { ImportFormatInfo } from "../../protocol/types";
import {
  extensionOf,
  importForeignPathFlow,
  importProjectNativeFlow,
} from "../Transport/projectFlows";

/* ============================================================================
 * Imperative open flag (no store dependency)
 * ========================================================================= */

let isOpen = false;
const subs = new Set<() => void>();

function emit(): void {
  for (const cb of [...subs]) cb();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

export function openImportPathDialog(): void {
  if (isOpen) return;
  isOpen = true;
  emit();
}

function closeImportPathDialog(): void {
  if (!isOpen) return;
  isOpen = false;
  emit();
}

/* ============================================================================
 * Helpers
 * ========================================================================= */

/** Strip surrounding quotes (Explorer's "Copy as path") and trim whitespace. */
function normalizePath(raw: string): string {
  let p = raw.trim();
  if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
    p = p.slice(1, -1).trim();
  }
  return p;
}

/** Windows drive (C:\ / C:/), UNC (\\server\share) or POSIX-absolute. */
function looksAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

function formatsHint(formats: ImportFormatInfo[] | null): string {
  if (!formats || formats.length === 0) return "Supported: .cpr, .mid";
  return (
    "Supported: " +
    formats
      .map((f) => `${f.name} (${f.extensions.map((x) => `.${x}`).join(", ")})`)
      .join(" · ")
  );
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ============================================================================
 * Dialog
 * ========================================================================= */

export default function PastePathDialog() {
  const open = useSyncExternalStore(subscribe, () => isOpen);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formats, setFormats] = useState<ImportFormatInfo[] | null>(null);

  // Reset per open + fetch the provider registry for the extension hint / validation.
  useEffect(() => {
    if (!open) return;
    setRaw("");
    setBusy(false);
    setErr(null);
    getImportFormats()
      .then((r) => setFormats(r.formats))
      .catch(() => setFormats(null)); // hint falls back; the engine still validates
  }, [open]);

  const path = normalizePath(raw);
  const close = () => {
    if (!busy) closeImportPathDialog();
  };

  /** Client-side shape check; returns an error string or null when sendable. */
  const validate = (): string | null => {
    if (!path) return "Enter the full absolute path of a project file.";
    if (!looksAbsolute(path))
      return "That doesn't look like an absolute path (e.g. C:\\Songs\\MySong.cpr).";
    const ext = extensionOf(path);
    if (!ext) return "The path has no file extension — expected e.g. .cpr or .mid.";
    if (formats && formats.length > 0) {
      const known = new Set(formats.flatMap((f) => f.extensions.map((x) => x.toLowerCase())));
      if (!known.has(ext))
        return `No import provider for ".${ext}". ${formatsHint(formats)}`;
    }
    return null;
  };

  const doImport = () => {
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setErr(null);
    setBusy(true);
    importForeignPathFlow(path)
      .then((result) => {
        if (result === "imported") {
          closeImportPathDialog();
          showToast(`Imported ${path.split(/[\\/]/).pop() ?? path}`, "success");
        }
      })
      .catch((e) => setErr(errText(e))) // "no_provider" | "import_failed" text from engine
      .finally(() => setBusy(false));
  };

  const pasteFromClipboard = () => {
    navigator.clipboard
      ?.readText()
      .then((t) => {
        if (t) setRaw(t);
      })
      .catch(() => setErr("Clipboard not readable — paste into the field with Ctrl+V."));
  };

  const browseNative = () => {
    closeImportPathDialog();
    void importProjectNativeFlow(); // errors surface as toasts
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Import Project"
      width={560}
      footer={
        <>
          <button
            type="button"
            className="btn"
            style={{ marginRight: "auto" }}
            disabled={busy}
            title="Fall back to the engine's native file picker"
            onClick={browseNative}
          >
            Browse (native)…
          </button>
          <button type="button" className="btn" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || path.length === 0}
            onClick={doImport}
          >
            {busy ? "Importing…" : "Validate + Import"}
          </button>
        </>
      }
    >
      <div className="col gap2">
        <div className="dim">
          Browsers can't read full file paths, so paste or type the absolute path of the
          project file to import. It opens as a new project (unsaved changes are confirmed
          first).
        </div>
        <div className="row gap1">
          <input
            className="input mono grow"
            type="text"
            placeholder="C:\Songs\MySong.cpr"
            value={raw}
            disabled={busy}
            spellCheck={false}
            autoFocus
            onChange={(e) => {
              setRaw(e.target.value);
              setErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy && path.length > 0) doImport();
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={busy}
            title="Paste the path from the clipboard"
            onClick={pasteFromClipboard}
          >
            Paste
          </button>
        </div>
        <div className="dim" style={{ fontSize: 11 }}>
          {formatsHint(formats)}
        </div>
        {err ? <div className="dlg-error">{err}</div> : null}
      </div>
    </Modal>
  );
}
