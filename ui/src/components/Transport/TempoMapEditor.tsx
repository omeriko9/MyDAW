/**
 * TempoMapEditor (owned by U2) — popup panel editing the FULL tempo / time-signature
 * maps. Opened from the chevron next to the transport tempo display (TransportBar
 * anchors it and handles outside-click/Escape close, like the swing popover).
 *
 * Every row commit sends the COMPLETE edited list via cmd/tempoMap.set /
 * cmd/timeSigMap.set (one undo entry per send; the engine validates: first tempo
 * entry at beat 0, first timesig entry at bar 0, bpm 20..400, num 1..32,
 * den in {1,2,4,8,16,32}). Entry 0 of each map is position-locked (no delete).
 */

import { useState } from "react";
import { transportBus, useStore } from "../../store/store";
import { setTempoMap, setTimeSigMap } from "../../store/actions";
import { bpmAtBeat, formatBarsBeats, parseBarsBeats } from "../../lib/time";
import type { TempoPoint, TimeSigEntry } from "../../protocol/types";
import { IconButton } from "../common/IconButton";
import { NumberDrag } from "../common/NumberDrag";
import { Select } from "../common/Select";
import { TextInput } from "../common/TextInput";

const fire = (p: Promise<unknown>): void => {
  p.catch((e) => console.warn("[tempoMap] command failed:", e));
};

const NUM_OPTIONS = Array.from({ length: 32 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));
const DEN_OPTIONS = [1, 2, 4, 8, 16, 32].map((d) => ({ value: String(d), label: String(d) }));

const clampBpm = (bpm: number): number => Math.min(400, Math.max(20, bpm));

/** bpm NumberDrag with a local draft so the readout follows the drag (commit on release). */
function BpmCell({ bpm, onCommit }: { bpm: number; onCommit: (v: number) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <NumberDrag
      value={drag ?? bpm}
      min={20}
      max={400}
      step={0.1}
      precision={1}
      speed={0.5}
      units="BPM"
      width={72}
      title="Tempo (BPM)"
      onChange={setDrag}
      onCommit={(v) => {
        setDrag(null);
        onCommit(v);
      }}
    />
  );
}

/** bar NumberDrag (0-based, engine convention) with a local draft. */
function BarCell({
  bar,
  disabled,
  onCommit,
}: {
  bar: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <NumberDrag
      value={drag ?? bar}
      min={0}
      step={1}
      precision={0}
      units="bar"
      width={74}
      disabled={disabled}
      title={disabled ? "First time signature is locked to bar 0" : "Bar (0-based)"}
      onChange={setDrag}
      onCommit={(v) => {
        setDrag(null);
        onCommit(Math.max(0, Math.round(v)));
      }}
    />
  );
}

export default function TempoMapEditor() {
  const project = useStore((s) => s.project);
  if (!project) return null;
  const tempoMap = project.tempoMap;
  const sigMap = project.timeSigMap;

  /* ---- tempo map (full-list sends; entry 0 pinned to beat 0) ---- */

  const commitTempo = (entries: TempoPoint[]) => {
    const list = entries
      .map((e) => ({ beat: Math.max(0, e.beat), bpm: clampBpm(e.bpm) }))
      .sort((a, b) => a.beat - b.beat);
    if (list.length > 0) list[0] = { ...list[0], beat: 0 };
    fire(setTempoMap(list));
  };

  const updateTempo = (i: number, patch: Partial<TempoPoint>) =>
    commitTempo(tempoMap.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  const addTempoAtPlayhead = () => {
    const beat = Math.max(0, transportBus.last?.beat ?? 0);
    if (tempoMap.some((e) => Math.abs(e.beat - beat) < 1e-6)) return; // entry already there
    commitTempo([...tempoMap, { beat, bpm: bpmAtBeat(beat, tempoMap) }]);
  };

  /* ---- time-signature map (entry 0 pinned to bar 0) ---- */

  const commitSig = (entries: TimeSigEntry[]) => {
    const list = entries
      .map((e) => ({ bar: Math.max(0, Math.round(e.bar)), num: e.num, den: e.den }))
      .sort((a, b) => a.bar - b.bar);
    if (list.length > 0) list[0] = { ...list[0], bar: 0 };
    fire(setTimeSigMap(list));
  };

  const updateSig = (i: number, patch: Partial<TimeSigEntry>) =>
    commitSig(sigMap.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  const addSig = () => {
    const last = sigMap[sigMap.length - 1] ?? { bar: 0, num: 4, den: 4 };
    commitSig([...sigMap, { ...last, bar: last.bar + 4 }]);
  };

  return (
    <div className="tb-popover tb-tempomap">
      <div className="tb-popover-title">Tempo</div>
      {tempoMap.map((e, i) => (
        <div className="tb-map-row" key={`t${i}`}>
          <TextInput
            value={formatBarsBeats(e.beat, sigMap)}
            width={74}
            disabled={i === 0}
            title={i === 0 ? "First tempo entry is locked to the project start" : "Position (bars.beats)"}
            onCommit={(text) => {
              const beat = parseBarsBeats(text, sigMap);
              if (beat !== null && Number.isFinite(beat)) updateTempo(i, { beat: Math.max(0, beat) });
            }}
          />
          <BpmCell bpm={e.bpm} onCommit={(bpm) => updateTempo(i, { bpm })} />
          {i === 0 ? (
            <span className="tb-map-spacer" />
          ) : (
            <IconButton
              icon="trash"
              danger
              size={20}
              tooltip="Remove tempo change"
              onClick={() => commitTempo(tempoMap.filter((_, j) => j !== i))}
            />
          )}
        </div>
      ))}
      <button type="button" className="btn" onClick={addTempoAtPlayhead}>
        + Add at playhead
      </button>

      <div className="tb-popover-title" style={{ marginTop: 8 }}>
        Time signature
      </div>
      {sigMap.map((e, i) => (
        <div className="tb-map-row" key={`s${i}`}>
          <BarCell bar={e.bar} disabled={i === 0} onCommit={(bar) => updateSig(i, { bar })} />
          <span className="row gap0">
            <Select
              value={String(e.num)}
              onChange={(v) => updateSig(i, { num: Number(v) })}
              options={NUM_OPTIONS}
              width={48}
              title="Beats per bar"
            />
            <span className="faint">/</span>
            <Select
              value={String(e.den)}
              onChange={(v) => updateSig(i, { den: Number(v) })}
              options={DEN_OPTIONS}
              width={48}
              title="Beat unit"
            />
          </span>
          {i === 0 ? (
            <span className="tb-map-spacer" />
          ) : (
            <IconButton
              icon="trash"
              danger
              size={20}
              tooltip="Remove time signature change"
              onClick={() => commitSig(sigMap.filter((_, j) => j !== i))}
            />
          )}
        </div>
      ))}
      <button type="button" className="btn" onClick={addSig}>
        + Add
      </button>
    </div>
  );
}
