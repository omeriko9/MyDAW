/**
 * withBusyIndicator — show a "still working" toast only for operations that turn out to
 * be SLOW, and always take it down again.
 *
 * Paid for 2026-08-12: File ▸ Close was reported as doing nothing. It worked — the
 * engine log showed `project/new ok 6540ms` — but closing a project with plugins loaded
 * spends seconds destroying their hosts, and the UI said nothing for all of it. A click
 * with no response for six seconds IS a broken button as far as the user is concerned.
 *
 * The delay matters as much as the indicator: an empty project closes in milliseconds,
 * and flashing a spinner for every File ▸ Close would be its own kind of noise.
 */

import { showBusyToast } from "../components/common/ToastHost";

export interface BusyOptions {
  /** Stay silent unless the work is still running after this long (ms). */
  delayMs?: number;
  /** Injected by tests; defaults to the real toast. Must return its own closer. */
  show?: (label: string) => () => void;
}

export async function withBusyIndicator<T>(
  label: string,
  work: () => Promise<T>,
  opts: BusyOptions = {},
): Promise<T> {
  const delayMs = opts.delayMs ?? 400;
  const show = opts.show ?? showBusyToast;
  // Held in a one-slot box so TypeScript keeps the closure's assignment in view (a plain
  // `let` is narrowed to `null` at the read below, which it then calls "not callable").
  const pending: { close: (() => void) | null } = { close: null };
  const timer = setTimeout(() => {
    pending.close = show(label);
  }, delayMs);
  try {
    return await work();
  } finally {
    // Both paths matter: cancel the pending show, and close one that already appeared —
    // including when `work` threw, or a failed Close would leave a spinner up forever.
    clearTimeout(timer);
    pending.close?.();
  }
}
