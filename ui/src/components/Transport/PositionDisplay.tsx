/**
 * Transport position readout (owned by U2).
 *
 * Big primary readout + small secondary readout: bars.beats.ticks and min:sec.
 * Click the small one to swap which format is primary; double-click the primary
 * to type a position (parsed via parseBarsBeats / parseTimeSec, then transport/locate).
 *
 * Live values come imperatively from transportBus (20 Hz) — text nodes are updated
 * via refs, no React re-render per frame (SPEC §9).
 */

import { useEffect, useRef, useState } from "react";
import { transportBus, useStore } from "../../store/store";
import { locate } from "../../store/actions";
import {
  beatsToSeconds,
  formatBarsBeats,
  formatTimeSec,
  parseBarsBeats,
  parseTimeSec,
  secondsToBeats,
} from "../../lib/time";
import type { TempoPoint, TimeSigEntry } from "../../protocol/types";

type PosMode = "bars" | "time";

const DEFAULT_SIG: TimeSigEntry[] = [{ bar: 1, num: 4, den: 4 }];
const DEFAULT_TEMPO: TempoPoint[] = [{ beat: 0, bpm: 120 }];

export default function PositionDisplay() {
  const timeSigMap = useStore((s) => s.project?.timeSigMap ?? DEFAULT_SIG);
  const tempoMap = useStore((s) => s.project?.tempoMap ?? DEFAULT_TEMPO);
  const [mode, setMode] = useState<PosMode>("bars");
  const [editing, setEditing] = useState<string | null>(null);

  const mainRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Imperative text updates from the transport bus (no per-frame re-render).
  useEffect(() => {
    const update = (beat: number, timeSec: number) => {
      const bars = formatBarsBeats(beat, timeSigMap);
      const time = formatTimeSec(timeSec);
      if (mainRef.current) mainRef.current.textContent = mode === "bars" ? bars : time;
      if (subRef.current) subRef.current.textContent = mode === "bars" ? time : bars;
    };
    const t = transportBus.last;
    update(t?.beat ?? 0, t?.timeSec ?? 0);
    return transportBus.subscribe((ev) => update(ev.beat, ev.timeSec));
  }, [timeSigMap, mode, editing]);

  const startEdit = () => {
    const t = transportBus.last;
    const beat = t?.beat ?? 0;
    setEditing(
      mode === "bars"
        ? formatBarsBeats(beat, timeSigMap)
        : formatTimeSec(t?.timeSec ?? beatsToSeconds(beat, tempoMap)),
    );
  };

  useEffect(() => {
    if (editing !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitEdit = (text: string) => {
    setEditing(null);
    const trimmed = text.trim();
    if (!trimmed) return;
    let beat: number | null = null;
    if (mode === "bars") {
      beat = parseBarsBeats(trimmed, timeSigMap);
    } else {
      const sec = parseTimeSec(trimmed);
      if (sec !== null) beat = secondsToBeats(sec, tempoMap);
    }
    if (beat === null || !Number.isFinite(beat)) return;
    locate(Math.max(0, beat)).catch((e) => console.warn("[transport] locate failed:", e));
  };

  return (
    <div className="tb-pos mono" title="Position — double-click to type, click the small readout to swap format">
      {editing !== null ? (
        <input
          ref={inputRef}
          className="tb-pos-input mono"
          aria-label={mode === "bars" ? "Locate to bars.beats.ticks" : "Locate to time"}
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={(e) => commitEdit(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitEdit((e.target as HTMLInputElement).value);
            else if (e.key === "Escape") setEditing(null);
          }}
        />
      ) : (
        <div className="tb-pos-main" ref={mainRef} onDoubleClick={startEdit} />
      )}
      <div
        className="tb-pos-sub"
        ref={subRef}
        title={mode === "bars" ? "Click to show time first" : "Click to show bars.beats first"}
        onClick={() => {
          setEditing(null);
          setMode((m) => (m === "bars" ? "time" : "bars"));
        }}
      />
    </div>
  );
}
