/**
 * Crash-recovery prompt (U5) — once per app session, after the first successful
 * session/hello, query project/recoveryInfo; if an autosave is available offer
 * Recover / Discard (SPEC §5.1, §6 crash recovery).
 */

import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../../store/store";
import { getRecoveryInfo, recoverProject } from "../../store/actions";
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
  const engineInfo = useStore((s) => s.engineInfo);
  const checked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /* hello completed ⇒ engineInfo is set; check recovery exactly once per session */
  useEffect(() => {
    if (!engineInfo || checked.current) return;
    checked.current = true;
    getRecoveryInfo()
      .then((info) => {
        if (info.available) setDialogs({ recovery: info });
      })
      .catch((e) => console.error("[recovery] recoveryInfo failed:", e));
  }, [engineInfo, setDialogs]);

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
        {err ? <div className="dlg-error">{err}</div> : null}
      </div>
    </Modal>
  );
}
