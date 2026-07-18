/**
 * Metronome helper — single path used by both the transport bar toggle and the keyboard
 * "C" shortcut. Updates the store mirror optimistically, sends transport/setMetronome,
 * then reconciles from the reply's authoritative "metronome" echo (optional field; the
 * mirror is also reconciled from session/hello and event/transport in store.ts).
 */

import { reconcileMetronome, useStore } from "./store";
import { setMetronome as wsSetMetronome } from "./actions";

export function applyMetronome(enabled: boolean, countIn: 0 | 1 | 2): void {
  useStore.getState().setMetronome({ enabled, countIn }); // optimistic
  wsSetMetronome(enabled, countIn)
    .then((r) => reconcileMetronome(r.metronome))
    .catch((e) => console.warn("[metronome] failed:", e));
}

/** Flip enabled, keeping the current count-in. */
export function toggleMetronome(): void {
  const m = useStore.getState().metronome;
  applyMetronome(!m.enabled, m.countIn);
}
