/**
 * Relink dialog (U5) — opens automatically while the project has assets with
 * missing:true (SPEC §5.5). Per-row [Locate…] uses the engine's native file picker
 * (dialog/importFiles) then media/relink. "Skip all" dismisses until the missing
 * set changes.
 */

import React, { useState } from "react";
import { useStore } from "../../store/store";
import { dialogImportFiles, relinkAsset } from "../../store/actions";
import { Modal } from "../common/Modal";
import { Icon } from "../common/icons";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function RelinkDialog() {
  const project = useStore((s) => s.project);
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const missing = project?.assets.filter((a) => a.missing) ?? [];
  const sig = missing
    .map((a) => a.id)
    .sort((a, b) => a - b)
    .join(",");
  const open = missing.length > 0 && sig !== dismissedSig;

  const dismiss = () => setDismissedSig(sig);

  const locate = (assetId: number) => {
    setErr(null);
    setBusyId(assetId);
    dialogImportFiles()
      .then((r) => {
        const path = r.paths && r.paths.length > 0 ? r.paths[0] : null;
        if (!path) return; // user cancelled the native dialog
        return relinkAsset(assetId, path);
      })
      .catch((e) => setErr(errText(e)))
      .finally(() => setBusyId(null));
  };

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title="Missing audio files"
      width={520}
      footer={
        <button type="button" className="btn" onClick={dismiss}>
          Skip all
        </button>
      }
    >
      <div className="col gap2">
        <div className="dim">
          {missing.length} audio {missing.length === 1 ? "file" : "files"} referenced by this
          project could not be found. Locate them to relink.
        </div>
        <div className="dlg-list">
          {missing.map((a) => (
            <div className="dlg-item" key={a.id}>
              <Icon name="warning" size={14} />
              <span className="col grow" style={{ minWidth: 0 }}>
                <span className="name" title={a.file}>
                  {a.file.split(/[\\/]/).pop() ?? a.file}
                </span>
                <span className="path" title={a.originalPath ?? a.file}>
                  {a.originalPath ?? a.file}
                </span>
              </span>
              <button
                type="button"
                className="btn"
                disabled={busyId !== null}
                onClick={() => locate(a.id)}
              >
                <Icon name="link" size={13} />
                {busyId === a.id ? "Locating…" : "Locate…"}
              </button>
            </div>
          ))}
        </div>
        {err ? <div className="dlg-error">{err}</div> : null}
      </div>
    </Modal>
  );
}
