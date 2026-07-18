/**
 * Transport bar (owned by U2) — SPEC §9.
 *
 * Menu bar (File/Edit/Project/Audio/MIDI — MenuBar.tsx) · transport cluster (|<<,
 * play/pause, stop, record, loop, metronome+count-in, follow-playhead)
 * · position readouts · tempo / timesig · snap grid + triplet + swing + quantize
 * · tool buttons · undo/redo · export chip · CPU/xrun chip · master mini-meter
 * · panic · save indicator · panel toggles.
 *
 * Continuous params (tempo) use the transient drag pattern (transientParam/commitParam).
 * Grid (snap/triplet/swing) edits persist via cmd/grid.set with an optimistic local
 * mirror (gridLocal.ts); the swing slider streams transient sends while dragging and
 * commits one non-transient cmd/grid.set on release.
 * Metronome state mirrors the engine (store.metronome — seeded from session/hello,
 * reconciled from transport events/replies), so the "C" keyboard shortcut and this
 * control stay in sync; toggles update optimistically.
 */

import { useEffect, useRef, useState } from "react";
import { metersBus, useStore } from "../../store/store";
import type { Tool } from "../../store/store";
import {
  commitParam,
  pause,
  locate,
  panic,
  play,
  record,
  redo,
  setAutomationWrite,
  setLoop,
  setTimeSig,
  stop,
  transientParam,
  undo,
} from "../../store/actions";
import { applyMetronome } from "../../store/metronome";
import { timeSigAtBeat } from "../../lib/time";
import { quantizeSelection } from "../../lib/keyboard";
import type { Grid } from "../../protocol/types";
import { Icon } from "../common/icons";
import type { IconName } from "../common/icons";
import { IconButton } from "../common/IconButton";
import { Toggle } from "../common/Toggle";
import { Select } from "../common/Select";
import { NumberDrag } from "../common/NumberDrag";
import { Meter } from "../common/Meter";
import { Tooltip } from "../common/Tooltip";
import { openContextMenu } from "../common/ContextMenu";
import type { MenuEntry } from "../common/ContextMenu";
import TempoMapEditor from "./TempoMapEditor";
import { DEFAULT_GRID, setGridLocal } from "./gridLocal";
import { importProjectFlow, saveProjectFlow } from "./projectFlows";
import "./transport.css";

const fire = (p: Promise<unknown>): void => {
  p.catch((e) => console.warn("[transport] command failed:", e));
};

/* ============================================================================
 * Metronome + count-in
 * ========================================================================= */

function MetronomeControl() {
  // Mirror of the engine metronome state (seeded from session/hello, reconciled from
  // transport events/replies) — keeps the keyboard "C" shortcut and this control in sync.
  const { enabled, countIn } = useStore((s) => s.metronome);

  const apply = (en: boolean, ci: 0 | 1 | 2) => applyMetronome(en, ci);

  const openMenu = (x: number, y: number) => {
    const items: MenuEntry[] = ([0, 1, 2] as const).map((n) => ({
      label: n === 0 ? "No count-in" : `Count-in: ${n} bar${n > 1 ? "s" : ""}`,
      checked: countIn === n,
      onClick: () => apply(enabled, n),
    }));
    openContextMenu(x, y, items);
  };

  return (
    <span
      className="tb-group"
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
    >
      <Toggle
        on={enabled}
        onChange={(on) => apply(on, countIn)}
        icon="metronome"
        tooltip={`Metronome (C)${countIn > 0 ? ` (count-in ${countIn} bar${countIn > 1 ? "s" : ""})` : ""} — right-click for count-in`}
      />
      <IconButton
        icon="chevronDown"
        size={18}
        tooltip="Count-in"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom + 4);
        }}
      />
    </span>
  );
}

/* ============================================================================
 * Follow playhead (auto-scroll)
 * ========================================================================= */

function FollowPlayheadToggle() {
  const follow = useStore((s) => s.followPlayhead);
  const setFollow = useStore((s) => s.setFollowPlayhead);
  return (
    <Toggle
      on={follow}
      onChange={setFollow}
      icon="marker"
      tooltip="Follow playhead (J) — auto-scroll"
    />
  );
}

/* ============================================================================
 * Automation write arm
 * ========================================================================= */

function AutomationWriteToggle() {
  // Mirror of the engine arm (seeded from session/hello, reconciled from transport events/
  // replies). Optimistic local update + send; the engine reply confirms via reconcile.
  const on = useStore((s) => s.automationWrite);
  const setLocal = useStore((s) => s.setAutomationWrite);
  return (
    <Toggle
      on={on}
      onChange={(next) => {
        setLocal(next);
        void setAutomationWrite(next);
      }}
      icon="pencil"
      variant="danger"
      tooltip="Write automation — while ON and playing, fader/knob moves record automation points at the playhead"
    />
  );
}

/* ============================================================================
 * Snap / grid cluster
 * ========================================================================= */

const SNAP_DIVISIONS: Array<{ value: string; label: string; division: number }> = [
  { value: "2", label: "1/2", division: 2 },
  { value: "1", label: "1/4", division: 1 },
  { value: "0.5", label: "1/8", division: 0.5 },
  { value: "0.25", label: "1/16", division: 0.25 },
  { value: "0.125", label: "1/32", division: 0.125 },
];

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function snapSelectValue(grid: Grid, beatsPerBar: number): string {
  if (!grid.snap) return "off";
  if (approx(grid.division, beatsPerBar)) return "bar";
  const hit = SNAP_DIVISIONS.find((d) => approx(d.division, grid.division));
  return hit ? hit.value : "custom";
}

export function SnapCluster() {
  const project = useStore((s) => s.project);
  const grid = project?.grid ?? DEFAULT_GRID;
  const beatsPerBar = timeSigAtBeat(0, project?.timeSigMap ?? []).beatsPerBar;
  const value = snapSelectValue(grid, beatsPerBar);
  const [swingOpen, setSwingOpen] = useState(false);
  const swingRef = useRef<HTMLDivElement | null>(null);
  // Swing slider gesture: stream transient cmd/grid.set while dragging, commit ONE
  // non-transient on release (same shape as the tempo transientParam/commitParam drag).
  const swingPendingRef = useRef<number | null>(null);
  const commitSwing = () => {
    const v = swingPendingRef.current;
    if (v === null) return;
    swingPendingRef.current = null;
    setGridLocal({ swing: v });
  };

  // close swing popover on outside click / Escape
  useEffect(() => {
    if (!swingOpen) return;
    const onDown = (e: PointerEvent) => {
      if (swingRef.current && !swingRef.current.contains(e.target as Node)) setSwingOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSwingOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [swingOpen]);

  const options = [
    { value: "off", label: "Off" },
    { value: "bar", label: "Bar" },
    ...SNAP_DIVISIONS.map((d) => ({ value: d.value, label: d.label })),
    ...(value === "custom" ? [{ value: "custom", label: `${grid.division}b`, disabled: true }] : []),
  ];

  const onSnapChange = (v: string) => {
    if (v === "off") setGridLocal({ snap: false });
    else if (v === "bar") setGridLocal({ snap: true, division: beatsPerBar });
    else setGridLocal({ snap: true, division: Number(v) });
  };

  return (
    <div className="tb-group gap1">
      <Icon name="magnet" size={13} className={grid.snap ? undefined : "faint"} />
      <Select
        value={value}
        onChange={onSnapChange}
        options={options}
        disabled={!project}
        title="Snap grid"
        width={64}
      />
      <Toggle
        on={grid.triplet}
        onChange={(on) => setGridLocal({ triplet: on })}
        disabled={!project}
        tooltip="Triplet grid"
      >
        3
      </Toggle>
      <div className="tb-swing" ref={swingRef}>
        <button
          type="button"
          className="btn"
          disabled={!project}
          onClick={() => setSwingOpen((o) => !o)}
          title="Swing amount for quantize"
        >
          Swing {Math.round(grid.swing * 100)}%
        </button>
        {swingOpen && (
          <div className="tb-popover">
            <div className="tb-popover-title">Swing (quantize default)</div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              aria-label="Swing amount"
              value={Math.round(grid.swing * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                swingPendingRef.current = v;
                setGridLocal({ swing: v }, true);
              }}
              onPointerUp={commitSwing}
              onKeyUp={commitSwing}
              onBlur={commitSwing}
            />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="faint" style={{ fontSize: 10 }}>
                straight
              </span>
              <span className="mono" style={{ fontSize: 11 }}>
                {Math.round(grid.swing * 100)}%
              </span>
            </div>
          </div>
        )}
      </div>
      <Tooltip content="Quantize (Q) — selected notes (piano roll) or selected MIDI clips, to the grid">
        <button type="button" className="btn" disabled={!project} onClick={quantizeSelection}>
          Q
        </button>
      </Tooltip>
    </div>
  );
}

/* ============================================================================
 * Tempo / time signature
 * ========================================================================= */

export function TempoSigCluster() {
  const project = useStore((s) => s.project);
  const bpm = project?.tempoMap[0]?.bpm ?? 120;
  const sig = project?.timeSigMap[0] ?? { bar: 1, num: 4, den: 4 };
  const [bpmDrag, setBpmDrag] = useState<number | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const mapRef = useRef<HTMLSpanElement | null>(null);

  // close tempo-map popover on outside click / Escape (same pattern as SnapCluster)
  useEffect(() => {
    if (!mapOpen) return;
    const onDown = (e: PointerEvent) => {
      if (mapRef.current && !mapRef.current.contains(e.target as Node)) setMapOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMapOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [mapOpen]);

  return (
    <div className="tb-group gap1">
      <div className="tb-field" title="Tempo — drag, wheel, or double-click to type">
        <span className="tb-tempomap-anchor row gap0" ref={mapRef}>
          <NumberDrag
            value={bpmDrag ?? bpm}
            min={20}
            max={400}
            step={0.1}
            precision={1}
            speed={0.5}
            units="BPM"
            disabled={!project}
            onChange={(v) => {
              setBpmDrag(v);
              transientParam("cmd/tempo.set", { bpm: v });
            }}
            onCommit={(v) => {
              setBpmDrag(null);
              fire(commitParam("cmd/tempo.set", { bpm: v }));
            }}
          />
          <IconButton
            icon="chevronDown"
            size={16}
            tooltip="Tempo / time-signature map"
            disabled={!project}
            onClick={() => setMapOpen((o) => !o)}
          />
          <TapTempoButton disabled={!project} />
          {mapOpen && <TempoMapEditor />}
        </span>
      </div>
      <div className="tb-field">
        <TimeSigField sig={sig} disabled={!project} />
      </div>
    </div>
  );
}

/* Time signature — "N/D" text; double-click to type a new value (validated 1..32 / 1..32,
   mirroring the engine's accepted range). Escape reverts, Enter/blur commits. */
function TimeSigField({
  sig,
  disabled,
}: {
  sig: { num: number; den: number };
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const begin = () => {
    if (disabled) return;
    setDraft(`${sig.num}/${sig.den}`);
    setEditing(true);
  };
  const commit = () => {
    const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(draft);
    if (m) {
      const num = Number(m[1]);
      const den = Number(m[2]);
      if (num >= 1 && num <= 32 && den >= 1 && den <= 32 && (num !== sig.num || den !== sig.den)) {
        fire(setTimeSig(num, den));
      }
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="tb-sig-input"
        aria-label="Time signature"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <span
      className={"tb-sig" + (disabled ? " faint" : "")}
      title="Time signature — double-click to edit (e.g. 3/4, 7/8)"
      onDoubleClick={begin}
    >
      {sig.num}
      <span className="faint">/</span>
      {sig.den}
    </span>
  );
}

/* ============================================================================
 * Tap tempo — median interval of the last taps → cmd/tempo.set
 * ========================================================================= */

function TapTempoButton({ disabled }: { disabled: boolean }) {
  const tapsRef = useRef<number[]>([]);
  const [flash, setFlash] = useState(false);

  const tap = () => {
    const now = performance.now();
    const taps = tapsRef.current;
    // a >2s pause starts a fresh measurement
    if (taps.length > 0 && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 8) taps.shift();
    setFlash(true);
    window.setTimeout(() => setFlash(false), 90);
    if (taps.length < 2) return;
    // median interval is robust against one mis-tap
    const gaps = taps.slice(1).map((t, i) => t - taps[i]).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    const bpm = Math.min(400, Math.max(20, Math.round((60000 / median) * 10) / 10));
    fire(commitParam("cmd/tempo.set", { bpm }));
  };

  return (
    <Tooltip content="Tap tempo — click in time; the median of your last taps sets the BPM">
      <button
        type="button"
        className="btn"
        style={flash ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
        disabled={disabled}
        onClick={tap}
      >
        Tap
      </button>
    </Tooltip>
  );
}

/* ============================================================================
 * Transport bar
 * ========================================================================= */

const TOOLS: Array<{ tool: Tool; icon: IconName; tip: string }> = [
  { tool: "select", icon: "pointer", tip: "Select (1)" },
  { tool: "draw", icon: "pencil", tip: "Draw (2)" },
  { tool: "erase", icon: "eraser", tip: "Erase (3)" },
  { tool: "split", icon: "scissors", tip: "Split (4)" },
];

export default function TransportBar() {
  const transport = useStore((s) => s.transport);
  const project = useStore((s) => s.project);
  const dirty = useStore((s) => s.dirty);
  const status = useStore((s) => s.engineStatus);
  const exportProgress = useStore((s) => s.exportProgress);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const panels = useStore((s) => s.panels);
  const setPanels = useStore((s) => s.setPanels);

  const playing = transport.state === "playing";
  const recording = transport.state === "recording";
  const loop = project?.loop ?? transport.loop;
  const xruns = status?.xruns ?? 0;
  const cpu = Math.round(status?.cpuPercent ?? 0);

  return (
    <div className="transport-bar">
      <div className="tb-side tb-side-left">
        {/* tools */}
        <div className="tb-group">
          {TOOLS.map((t) => (
            <IconButton
              key={t.tool}
              icon={t.icon}
              active={tool === t.tool}
              tooltip={t.tip}
              onClick={() => setTool(t.tool)}
            />
          ))}
        </div>
        <div className="tb-sep" />
        {/* undo / redo */}
        <div className="tb-group">
          <IconButton icon="undo" tooltip="Undo (Ctrl+Z)" onClick={() => fire(undo())} />
          <IconButton icon="redo" tooltip="Redo (Ctrl+Y)" onClick={() => fire(redo())} />
        </div>
      </div>

      {/* transport cluster — centered in the bar */}
      <div className="tb-center">
      <div className="tb-group">
        <Tooltip content="To start (Home)">
          <button
            type="button"
            className="btn-icon"
            aria-label="To start"
            onClick={() => fire(locate(0))}
          >
            <span className="row" style={{ marginRight: -3 }}>
              <Icon name="chevronLeft" size={13} style={{ marginRight: -8 }} />
              <Icon name="chevronLeft" size={13} />
            </span>
          </button>
        </Tooltip>
        <IconButton
          icon={playing ? "pause" : "play"}
          active={playing}
          size={28}
          tooltip={playing ? "Pause (Space stops)" : "Play (Space)"}
          onClick={() => fire(playing ? pause() : play())}
        />
        <IconButton icon="stop" size={28} tooltip="Stop (Space)" onClick={() => fire(stop())} />
        <Toggle
          on={recording}
          onChange={(on) => fire(on ? record() : stop())}
          variant="danger"
          icon="record"
          tooltip="Record (R)"
        />
        <Toggle
          on={loop.enabled}
          onChange={(on) => fire(setLoop(loop.startBeat, loop.endBeat, on))}
          icon="loop"
          tooltip="Loop (L)"
          disabled={!project}
        />
        <MetronomeControl />
        <FollowPlayheadToggle />
        <AutomationWriteToggle />
      </div>
      </div>

      <div className="tb-side tb-side-right">
        {/* right cluster: chips, meter, panic, save, panel toggles — one wrap unit */}
        <div className="tb-group tb-right">
        {exportProgress !== null && (
          <span className="tb-chip accent" title="Export in progress">
            Export {Math.round(exportProgress)}%
          </span>
        )}
        <span
          className={"tb-chip mono" + (xruns > 0 || cpu >= 90 ? " warn" : "")}
          title="Engine DSP load · audio dropouts (highlighted when the engine is close to dropping out)"
        >
          CPU {cpu}% · {xruns} xr
        </span>
        <div className="tb-master" title="Master output">
          <Meter
            horizontal
            channels={2}
            height={12}
            getLevels={() => metersBus.last?.master ?? null}
          />
          <span className="tb-master-label">Master</span>
        </div>
        <IconButton
          icon="import"
          tooltip="Import Project (.cpr / MIDI) — Ctrl+I"
          onClick={() => importProjectFlow()}
        />
        <IconButton
          icon="warning"
          tooltip="Panic — all notes off / reset"
          onClick={() => fire(panic())}
        />
        <span className="tb-save">
          <IconButton
            icon="save"
            active={dirty}
            tooltip={dirty ? "Save (Ctrl+S) — unsaved changes" : "Save (Ctrl+S)"}
            onClick={() => void saveProjectFlow()}
          />
          {dirty && <span className="tb-dirty-dot" />}
        </span>

        <div className="tb-sep" />

        {/* panel toggles */}
        <div className="tb-group">
          <IconButton
            icon="folder"
            active={panels.browser}
            tooltip="Browser panel"
            onClick={() => setPanels({ browser: !panels.browser })}
          />
          <IconButton
            icon="mixer"
            active={panels.bottomTab !== null}
            tooltip="Bottom dock"
            onClick={() => setPanels({ bottomTab: panels.bottomTab === null ? "mixer" : null })}
          />
          <IconButton
            icon="sliders"
            active={panels.browser && panels.browserTab === "inspector"}
            tooltip="Inspector (Browser tab)"
            onClick={() =>
              panels.browser && panels.browserTab === "inspector"
                ? setPanels({ browser: false })
                : setPanels({ browser: true, browserTab: "inspector" })
            }
          />
          <IconButton
            icon="sparkles"
            active={panels.agent}
            tooltip="Agent (Ctrl+Shift+I)"
            onClick={() => setPanels({ agent: !panels.agent })}
          />
        </div>
        </div>
      </div>
    </div>
  );
}
