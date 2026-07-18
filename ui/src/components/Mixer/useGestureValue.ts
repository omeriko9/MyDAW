/**
 * useGestureValue — local preview value for transient drag gestures (SPEC §5 / §5.8).
 *
 * While dragging a fader/knob the engine receives transient messages (no
 * event/projectChanged broadcast), so the store value does not move. This hook keeps a
 * local override during the gesture so the control + readout track the pointer, then
 * releases the override once the authoritative store value catches up after the commit
 * (or after a timeout fallback, e.g. if the commit failed while disconnected).
 */

import { useEffect, useRef, useState } from "react";

const RELEASE_FALLBACK_MS = 1500;

export interface GestureValue {
  /** Value to render: local preview while gesturing, else the store value. */
  value: number;
  /** Call from onChange (every drag frame) alongside the transient send. */
  drag: (v: number) => void;
  /** Call from onCommit (gesture end) alongside the non-transient commit. */
  end: (v: number) => void;
}

export function useGestureValue(storeValue: number): GestureValue {
  const [local, setLocal] = useState<number | null>(null);
  const awaitingStore = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // The committed value came back through event/projectChanged → drop the override.
  useEffect(() => {
    if (awaitingStore.current) {
      awaitingStore.current = false;
      clearTimer();
      setLocal(null);
    }
  }, [storeValue]);

  useEffect(() => clearTimer, []);

  return {
    value: local ?? storeValue,
    drag: (v: number) => {
      awaitingStore.current = false;
      clearTimer();
      setLocal(v);
    },
    end: (v: number) => {
      setLocal(v);
      awaitingStore.current = true;
      clearTimer();
      timer.current = setTimeout(() => {
        awaitingStore.current = false;
        timer.current = null;
        setLocal(null);
      }, RELEASE_FALLBACK_MS);
    },
  };
}
