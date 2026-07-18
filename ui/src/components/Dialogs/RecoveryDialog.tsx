/**
 * Crash-recovery prompt (U5) — a pure renderer of store.dialogs.recovery. WHETHER to
 * prompt is decided in one place only, projectFlows.checkRecoveryOnce (Settings →
 * General → Crash recovery: auto / ask / never); this dialog is what "ask" shows.
 */

import React, { useState } from "react";
import { useStore } from "../../store/store";
import { recoverProject } from "../../store/actions";
import { Modal } from "../common/Modal";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatMtime(mtime: number | undefined): string | null {
  if (typeof mtime !== "number" || !(mtime > 0)) return null;
  // tolerate either epoch seconds or milliseconds
  const ms = mtime > 1e12 ? mtime : mtime * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

export default function RecoveryDialog() {
  const recovery = useStore((s) => s.dialogs.recovery);
  const setDialogs = useStore((s) => s.setDialogs);
  const setProject = useStore((s) => s.setProject);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const open = recovery !== null && recovery.available;
  const close = () => setDialogs({ recovery: null });

  const recover = () => {
    setBusy(true);
    setErr(null);
    recoverProject()
      .then((r) => {
        setProject(r.project);
        close();
      })
      .catch((e) => setErr(errText(e)))
      .finally(() => setBusy(false));
  };

  const when = formatMtime(recovery?.mtime);

  return (
    <Modal
      open={open}
      onClose={close}
      title="Recover unsaved project?"
      width={460}
      closeOnOverlay={false}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={close}>
            Discard
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={recover}>
            {busy ? "Recovering…" : "Recover"}
          </button>
        </>
      }
    >
      <div className="col gap2">
        <div>
          MyDAW did not shut down cleanly last time. An autosaved copy of your project is
          available.
        </div>
        {recovery?.autosavePath ? <div className="dlg-path">{recovery.autosavePath}</div> : null}
        {when ? <div className="dim">Autosaved {when}</div> : null}
        <div className="dim">
          Settings → General → Crash recovery can restore this automatically instead of
          asking.
        </div>
        {err ? <div className="dlg-error">{err}</div> : null}
      </div>
    </Modal>
  );
}
