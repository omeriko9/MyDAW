/**
 * BigClock (UI_IMPROVE.md §4.3) — floating position display readable from
 * across the room (hands on an instrument, eyes off the screen). Toggled from
 * View → Big Clock (panels.bigClock, persisted). Drag anywhere to move
 * (position persisted); shows BARS.BEATS.TICKS large + clock time small,
 * extrapolated between transport events via rAF while playing (Minimap's
 * ballistics — never per-frame React state).
 */

import React, { useEffect, useRef } from "react";
import { transportBus, useStore } from "../../store/store";
import type { TransportEvent } from "../../protocol/types";
import { useRafLoop } from "../../lib/canvas";
import { loadPref, savePrefDebounced, shapeOf, isFiniteNumber } from "../../lib/prefs";
import { beatsToSeconds, bpmAtBeat, formatBarsBeats } from "../../lib/time";
import { IconButton } from "../common/IconButton";

const POS_PREF = "ui.bigClockPos";

export default function BigClock() {
  const open = useStore((s) => s.panels.bigClock);
  const setPanels = useStore((s) => s.setPanels);
  const playing = useStore((s) => s.transport.state !== "stopped");
  const hasProject = useStore((s) => s.project !== null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLDivElement | null>(null);
  const posRef = useRef(
    loadPref<{ x: number; y: number }>(
      POS_PREF,
      { x: 0, y: 0 },
      shapeOf({ x: isFiniteNumber, y: isFiniteNumber }),
    ),
  );
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  const transportRef = useRef<{ ev: TransportEvent; at: number } | null>(
    transportBus.last ? { ev: transportBus.last, at: performance.now() } : null,
  );
  useEffect(
    () =>
      transportBus.subscribe((ev) => {
        transportRef.current = { ev, at: performance.now() };
        if (ev.state === "stopped") renderNow();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const renderNow = (): void => {
    const bars = barsRef.current;
    const time = timeRef.current;
    const p = useStore.getState().project;
    if (!bars || !time || !p) return;
    const l = transportRef.current;
    let beat = l?.ev.beat ?? 0;
    if (l && l.ev.state !== "stopped") {
      const dt = Math.min(0.25, (performance.now() - l.at) / 1000);
      beat += dt * (bpmAtBeat(beat, p.tempoMap) / 60);
    }
    bars.textContent = formatBarsBeats(beat, p.timeSigMap);
    const sec = beatsToSeconds(beat, p.tempoMap);
    const mm = Math.floor(sec / 60);
    const ss = Math.floor(sec % 60);
    const tenths = Math.floor((sec % 1) * 10);
    time.textContent = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${tenths}`;
  };

  useRafLoop(renderNow, open && playing);
  useEffect(() => {
    if (open) renderNow();
  });

  // Clamp the persisted position into the viewport (window may have shrunk).
  const clampPos = (x: number, y: number): { x: number; y: number } => {
    const w = rootRef.current?.offsetWidth ?? 240;
    const h = rootRef.current?.offsetHeight ?? 90;
    return {
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)),
      y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h)),
    };
  };

  if (!open || !hasProject) return null;

  const pos = clampPos(posRef.current.x || window.innerWidth - 300, posRef.current.y || 64);

  return (
    <div
      ref={rootRef}
      className="big-clock"
      style={{ left: pos.x, top: pos.y }}
      title="Big Clock — drag to move"
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y };
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        const el = rootRef.current;
        if (!d || !el) return;
        const next = clampPos(d.ox + e.clientX - d.px, d.oy + e.clientY - d.py);
        posRef.current = next;
        el.style.left = `${next.x}px`;
        el.style.top = `${next.y}px`;
        savePrefDebounced(POS_PREF, next);
      }}
      onPointerUp={(e) => {
        dragRef.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      }}
    >
      <div className="big-clock-bars mono" ref={barsRef}>
        1.1.000
      </div>
      <div className="big-clock-time mono" ref={timeRef}>
        00:00.0
      </div>
      <div className="big-clock-close">
        <IconButton
          icon="x"
          size={18}
          tooltip="Close (View → Big Clock)"
          onClick={() => setPanels({ bigClock: false })}
        />
      </div>
    </div>
  );
}
