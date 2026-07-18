/**
 * confirmDialog (U5) — imperative confirmation modal, like openContextMenu.
 *
 *   if (await confirmDialog({ title: "Delete track", message: "...", danger: true })) { ... }
 *
 * Renders into its own React root portal'd to <body>; the Promise resolves true on
 * confirm, false on cancel / Escape / overlay click. Concurrent calls queue.
 * Non-destructive dialogs focus the confirm button (Enter = OK); `danger` dialogs
 * keep the initial focus on Cancel so a reflexive Enter never destroys anything.
 */

import React from "react";
import { createRoot, Root } from "react-dom/client";
import "./dialogs.css";
import { Modal } from "../common/Modal";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label for the confirm button (default "OK"). */
  confirmLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

let reactRoot: Root | null = null;
const queue: PendingConfirm[] = [];
let active: PendingConfirm | null = null;
let seq = 0;

function ensureRoot(): Root {
  if (!reactRoot) {
    const host = document.createElement("div");
    host.id = "mydaw-confirm-root";
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  }
  return reactRoot;
}

function pump(): void {
  if (active) return;
  const next = queue.shift();
  if (!next) {
    ensureRoot().render(null);
    return;
  }
  active = next;
  ensureRoot().render(<ConfirmModal key={++seq} opts={next.opts} onDone={finish} />);
}

function finish(ok: boolean): void {
  const a = active;
  active = null;
  a?.resolve(ok);
  pump();
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ opts, resolve });
    pump();
  });
}

function ConfirmModal({
  opts,
  onDone,
}: {
  opts: ConfirmOptions;
  onDone: (ok: boolean) => void;
}) {
  return (
    <Modal
      open
      onClose={() => onDone(false)}
      title={opts.title}
      width={440}
      showClose={false}
      footer={
        <>
          <button type="button" className="btn" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={opts.danger ? "btn danger" : "btn primary"}
            data-autofocus={opts.danger ? undefined : "true"}
            onClick={() => onDone(true)}
          >
            {opts.confirmLabel ?? "OK"}
          </button>
        </>
      }
    >
      <div className="dlg-confirm-msg">{opts.message}</div>
    </Modal>
  );
}
