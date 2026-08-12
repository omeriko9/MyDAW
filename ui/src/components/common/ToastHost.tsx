/**
 * ToastHost + showToast (owned by U2) — minimal transient notifications.
 *
 *   showToast("Import failed: …", "error");
 *
 * Module-level store (useSyncExternalStore) so any flow can fire a toast without React
 * context; <ToastHost /> is mounted once from DialogsHost. Toasts auto-dismiss (errors
 * stay longer; hovering pauses the timer so long messages can be read) and dismiss on
 * click. Portal'd to <body>, stacked bottom-right above modals so failures behind a
 * dialog are still visible.
 */

import React, { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import "./toast.css";

export type ToastKind = "info" | "success" | "error";

/** Inline action button (e.g. post-take "Undo take"). Clicking dismisses the toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  actions?: ToastAction[];
  /** Override the kind-based auto-dismiss (ms). */
  durationMs?: number;
}

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  actions?: ToastAction[];
  durationMs?: number;
  /** A long operation is RUNNING: spinner, and never auto-dismisses (its owner closes it). */
  busy?: boolean;
  /** Exit animation running — still in the DOM, removed after TOAST_EXIT_MS. */
  leaving?: boolean;
}

const MAX_TOASTS = 4;
const INFO_MS = 5_000;
const ERROR_MS = 10_000;
/** Matches the toast-out animation duration (toast.css). */
const TOAST_EXIT_MS = 150;

let toasts: Toast[] = [];
let nextId = 1;
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

/** Auto-dismiss timers, keyed by toast id (cleared while hovered — see pause/resume). */
const timers = new Map<number, number>();

function pauseAutoDismiss(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) {
    window.clearTimeout(t);
    timers.delete(id);
  }
}

function toastDuration(t: { kind: ToastKind; durationMs?: number }): number {
  return t.durationMs ?? (t.kind === "error" ? ERROR_MS : INFO_MS);
}

function resumeAutoDismiss(id: number): void {
  const toast = toasts.find((t) => t.id === id);
  if (!toast || toast.busy || timers.has(id)) return; // a running op owns its own toast
  timers.set(id, window.setTimeout(() => dismissToast(id), toastDuration(toast)));
}

export function dismissToast(id: number): void {
  pauseAutoDismiss(id);
  const toast = toasts.find((t) => t.id === id);
  if (!toast || toast.leaving) return;
  // Two-phase removal so the exit animation can play (motion "off" zeroes the
  // animation; the extra 150ms in the DOM is invisible then).
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, TOAST_EXIT_MS);
}

export function showToast(message: string, kind: ToastKind = "info", opts?: ToastOptions): void {
  const id = nextId++;
  const dropped = toasts.slice(0, Math.max(0, toasts.length - (MAX_TOASTS - 1)));
  for (const d of dropped) pauseAutoDismiss(d.id); // overflowed out — kill their timers
  const toast: Toast = { id, message, kind, actions: opts?.actions, durationMs: opts?.durationMs };
  toasts = [...toasts.slice(-(MAX_TOASTS - 1)), toast];
  emit();
  timers.set(id, window.setTimeout(() => dismissToast(id), toastDuration(toast)));
}

/**
 * A toast for an operation that is STILL RUNNING; returns its closer. No auto-dismiss —
 * it lives exactly as long as the work does.
 *
 * Added 2026-08-12: File ▸ Close looked dead because closing a project with plugins
 * loaded spends seconds tearing down the hosts (6.5 s on the reporter's session) with
 * nothing on screen. Callers should go through `withBusyIndicator`, which only shows this
 * once an operation is slow enough to need it.
 */
export function showBusyToast(message: string): () => void {
  const id = nextId++;
  toasts = [...toasts.slice(-(MAX_TOASTS - 1)), { id, message, kind: "info", busy: true }];
  emit();
  return () => dismissToast(id);
}

const KIND_ICON: Record<ToastKind, IconName> = {
  info: "dot",
  success: "check",
  error: "error",
};

export default function ToastHost() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  if (list.length === 0) return null;
  return createPortal(
    <div className="toast-host">
      {list.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}`}
          data-leaving={t.leaving || undefined}
          role={t.kind === "error" ? "alert" : "status"}
          title={t.busy ? "Working…" : "Click to dismiss"}
          onClick={() => { if (!t.busy) dismissToast(t.id); }}
          onMouseEnter={() => pauseAutoDismiss(t.id)}
          onMouseLeave={() => resumeAutoDismiss(t.id)}
        >
          {t.busy ? <span className="toast-spinner" aria-hidden="true" /> : <Icon name={KIND_ICON[t.kind]} size={14} />}
          <div className="toast-body">
            <span className="toast-msg">{t.message}</span>
            {t.actions && t.actions.length > 0 && (
              <div className="toast-actions">
                {t.actions.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissToast(t.id);
                      a.onClick();
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
