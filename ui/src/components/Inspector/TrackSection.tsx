/**
 * Inspector TRACK section (U5): name, color, kind/channels badges, volume/pan,
 * input routing (audio), output routing, MIDI out routing (midi → shared instrument),
 * arm/monitor/mute/solo, sends, inserts, freeze/bounce.
 */

import React, { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { DriverInfo, Project, Track } from "../../protocol/types";
import { useStore } from "../../store/store";
import {
  addSend,
  addVca,
  bounceTrack,
  commitTrack,
  commitSend,
  commitVcaGain,
  dragSend,
  dragTrack,
  dragVcaGain,
  midiLearn,
  midiUnlearn,
  movePlugin,
  removePlugin,
  removeSend,
  setPlugin,
  setSend,
  setTrack,
  unfreezeTrack,
} from "../../store/actions";
import { Section } from "./Section";
import { EqSection } from "./EqSection";
import {
  ColorSwatches,
  GainDbDrag,
  LevelKnob,
  PanKnob,
  errText,
} from "./fields";
import { TextInput } from "../common/TextInput";
import { Select } from "../common/Select";
import type { SelectOption } from "../common/Select";
import { Toggle } from "../common/Toggle";
import { IconButton } from "../common/IconButton";
import { Icon } from "../common/icons";
import { openContextMenu } from "../common/ContextMenu";
import type { MenuEntry } from "../common/ContextMenu";

function trackNameById(project: Project, id: number): string {
  if (project.masterTrack.id === id) return "Master";
  return project.tracks.find((t) => t.id === id)?.name ?? `#${id}`;
}

/* ---- input device options from the capture-capable devices of available drivers ---- */

function inputDeviceOptions(drivers: DriverInfo[]): SelectOption[] {
  const opts: SelectOption[] = [{ value: "", label: "None" }];
  for (const drv of drivers) {
    if (!drv.available) continue;
    for (const dev of drv.devices) {
      if (dev.maxInputs > 0) {
        opts.push({ value: dev.id, label: dev.name, group: drv.type.toUpperCase() });
      }
    }
  }
  return opts;
}

function inputChannelOptions(maxInputs: number, stereo: boolean): SelectOption[] {
  const opts: SelectOption[] = [];
  if (stereo) {
    for (let ch = 0; ch + 1 < maxInputs; ch++) {
      opts.push({ value: String(ch), label: `${ch + 1}/${ch + 2}` });
    }
  } else {
    for (let ch = 0; ch < maxInputs; ch++) {
      opts.push({ value: String(ch), label: `${ch + 1}` });
    }
  }
  return opts;
}

/** MIDI-learn chip for one paramRef: "MIDI" to learn, "CC<n>" when mapped (click to unmap),
 *  "…" while armed and awaiting a control move. Mirrors store.midiMaps / store.midiLearnArm. */
function MidiLearnChip({ paramRef, label }: { paramRef: string; label: string }) {
  const armed = useStore((s) => s.midiLearnArm === paramRef);
  const map = useStore((s) => s.midiMaps.find((m) => m.paramRef === paramRef));
  return (
    <button
      type="button"
      className={"btn" + (armed ? " primary" : map ? " active" : "")}
      title={
        armed
          ? `Move a MIDI control to bind it to ${label}…`
          : map
            ? `${label} ← CC ${map.cc} — click to unmap`
            : `MIDI Learn ${label}`
      }
      onClick={() => void (map ? midiUnlearn(paramRef) : midiLearn(paramRef))}
    >
      {armed ? "…" : map ? `CC ${map.cc}` : "MIDI"}
    </button>
  );
}

export function TrackSection({ track, project }: { track: Track; project: Project }) {
  const audioDevices = useStore((s) => s.audioDevices);
  // Per-insert shallow selection so an unrelated event/pluginState doesn't re-render the whole
  // inspector (the whole-record selector did).
  const insertStates = useStore(
    useShallow((s) => track.inserts.map((ins) => s.pluginStates[ins.instanceId])),
  );
  const openPluginEditorWindow = useStore((s) => s.openPluginEditorWindow);
  const [busy, setBusy] = useState<"freeze" | "bounce" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const id = track.id;
  const isMaster = track.kind === "master";
  const isFolder = track.kind === "folder";
  const isAudio = track.kind === "audio";
  const isMidi = track.kind === "midi";
  const canArm = track.kind === "audio" || track.kind === "midi" || track.kind === "instrument";
  const buses = project.tracks.filter((t) => t.kind === "bus" && t.id !== id);

  const run = (what: "freeze" | "bounce", fn: () => Promise<unknown>) => {
    setBusy(what);
    setErr(null);
    fn()
      .catch((e) => setErr(errText(e)))
      .finally(() => setBusy(null));
  };

  /* ---- output routing ---- */
  const outValue =
    track.outputTarget === "master" || track.outputTarget === "none"
      ? track.outputTarget
      : String(track.outputTarget);
  const outOptions: SelectOption[] = [
    { value: "master", label: "Master" },
    ...buses.map((b) => ({ value: String(b.id), label: b.name, group: "Buses" })),
    { value: "none", label: "No output" },
  ];

  /* ---- MIDI routing (midi tracks → one shared instrument instance) ---- */
  const midiOutValue = String(track.midiTarget ?? 0);
  const assignedVca = (project.vcas ?? []).find((v) => v.id === track.vcaId) ?? null;
  const midiOutOptions: SelectOption[] = [
    { value: "0", label: "None (this track)" },
    ...project.tracks
      .filter((t) => t.kind === "instrument")
      .map((t) => ({ value: String(t.id), label: `${t.name} (#${t.id})`, group: "Instruments" })),
  ];
  // Stale target (instrument track deleted) — synthetic option so the true value shows
  // and the user can clear it (same idea as the time-sig fallback in the TransportBar).
  if (!midiOutOptions.some((o) => o.value === midiOutValue)) {
    midiOutOptions.push({ value: midiOutValue, label: `#${midiOutValue} (missing)` });
  }

  /* ---- input routing (audio tracks) ---- */
  const drivers = audioDevices?.drivers ?? [];
  const devOpts = inputDeviceOptions(drivers);
  const curDevice = track.inputDevice ?? "";
  const curDeviceInfo = drivers
    .flatMap((d) => d.devices)
    .find((d) => d.id === curDevice);
  const chOpts = curDeviceInfo
    ? inputChannelOptions(curDeviceInfo.maxInputs, track.channels === 2)
    : [];

  const addSendMenu = (e: React.MouseEvent) => {
    const items: MenuEntry[] =
      buses.length > 0
        ? buses.map((b) => ({
            label: b.name,
            onClick: () => {
              void addSend(id, b.id).catch((er) => setErr(errText(er)));
            },
          }))
        : [{ label: "No bus tracks — add a bus first", disabled: true }];
    openContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <>
    <Section
      title="Track"
      badge={
        <span className="row gap1">
          <span className="badge">{track.kind}</span>
          <span className="badge">{track.channels === 2 ? "stereo" : "mono"}</span>
          {track.frozen ? (
            <span className="badge accent" title="Track is frozen (inserts bypassed, plays bounced audio)">
              <Icon name="snowflake" size={10} /> frozen
            </span>
          ) : null}
        </span>
      }
    >
      <div className="insp-row">
        <span className="insp-label">Name</span>
        <TextInput
          className="grow"
          value={track.name}
          onCommit={(v) => {
            if (v.trim().length > 0) void setTrack(id, { name: v.trim() });
          }}
          placeholder="Track name"
        />
      </div>

      <div className="insp-row">
        <span className="insp-label">Color</span>
        <ColorSwatches current={track.color} onPick={(c) => void setTrack(id, { color: c })} />
      </div>

      {!isFolder && (
        <div className="insp-row">
          <span className="insp-label">Volume</span>
          <GainDbDrag
            gain={track.volume}
            onDrag={(g) => dragTrack(id, { volume: g })}
            onCommit={(g) => void commitTrack(id, { volume: g })}
            width={64}
            title="Track volume"
          />
          <span className="grow" />
          <span className="insp-label" style={{ flex: "0 0 auto" }}>
            Pan
          </span>
          <PanKnob
            pan={track.pan}
            onDrag={(p) => dragTrack(id, { pan: p })}
            onCommit={(p) => void commitTrack(id, { pan: p })}
            title="Pan"
          />
        </div>
      )}

      {isAudio && (
        <>
          <div className="insp-row">
            <span className="insp-label">Input</span>
            <Select
              className="grow"
              value={curDevice}
              options={devOpts}
              onChange={(v) => void setTrack(id, { inputDevice: v })}
              title="Capture device"
            />
          </div>
          <div className="insp-row">
            <span className="insp-label">Channel</span>
            <Select
              value={String(track.inputChannel ?? 0)}
              options={chOpts.length > 0 ? chOpts : [{ value: String(track.inputChannel ?? 0), label: "—" }]}
              disabled={chOpts.length === 0}
              onChange={(v) => void setTrack(id, { inputChannel: Number(v) })}
              width={72}
              title="Input channel offset"
            />
            <span className="grow" />
            <Toggle
              on={track.monitor ?? false}
              onChange={(on) => void setTrack(id, { monitor: on })}
              variant="ok"
              icon="headphones"
              tooltip="Input monitoring"
            />
          </div>
        </>
      )}

      {!isMaster && !isFolder && (
        <div className="insp-row">
          <span className="insp-label">Output</span>
          <Select
            className="grow"
            value={outValue}
            options={outOptions}
            onChange={(v) =>
              void setTrack(id, { outputTarget: v === "master" || v === "none" ? v : Number(v) })
            }
            title="Output routing"
          />
        </div>
      )}

      {isMidi && (
        <div className="insp-row">
          <span className="insp-label">MIDI Out</span>
          <Select
            className="grow"
            value={midiOutValue}
            options={midiOutOptions}
            onChange={(v) => void setTrack(id, { midiTarget: Number(v) })}
            title="Route this track's MIDI into a shared instrument track"
          />
        </div>
      )}

      {!isFolder && (
        <div className="insp-row">
          <span className="insp-label">VCA</span>
          <Select
            className="grow"
            value={String(track.vcaId ?? 0)}
            options={[
              { value: "0", label: "None" },
              ...(project.vcas ?? []).map((v) => ({ value: String(v.id), label: v.name })),
              { value: "new", label: "＋ New VCA…" },
            ]}
            onChange={(v) => {
              if (v === "new") {
                void addVca()
                  .then((res) => setTrack(id, { vcaId: res.vca.id }))
                  .catch((e) => setErr(errText(e)));
              } else {
                void setTrack(id, { vcaId: Number(v) }).catch((e) => setErr(errText(e)));
              }
            }}
            title="Assign this track to a VCA control group"
          />
          {assignedVca ? (
            <GainDbDrag
              gain={assignedVca.gain}
              onDrag={(g) => dragVcaGain(assignedVca.id, g)}
              onCommit={(g) => void commitVcaGain(assignedVca.id, g).catch((e) => setErr(errText(e)))}
              width={64}
              title={`${assignedVca.name} group gain`}
            />
          ) : null}
        </div>
      )}

      {!isFolder && (
        <div className="insp-row gap1">
          <span className="insp-label">MIDI</span>
          <MidiLearnChip paramRef={`track:${id}:volume`} label="Volume" />
          <span className="dim">Vol</span>
          <MidiLearnChip paramRef={`track:${id}:pan`} label="Pan" />
          <span className="dim">Pan</span>
        </div>
      )}

      {!isFolder && (
        <div className="insp-row gap1">
          {canArm && (
            <Toggle
              on={track.recordArm}
              onChange={(on) => void setTrack(id, { recordArm: on })}
              variant="danger"
              icon="record"
              tooltip="Record arm"
            />
          )}
          <Toggle
            on={track.mute}
            onChange={(on) => void setTrack(id, { mute: on })}
            variant="danger"
            tooltip="Mute (M)"
          >
            M
          </Toggle>
          {!isMaster && (
            <Toggle
              on={track.solo}
              onChange={(on) => void setTrack(id, { solo: on })}
              variant="warn"
              tooltip="Solo (S)"
            >
              S
            </Toggle>
          )}
        </div>
      )}

      {/* ---- sends ---- */}
      {!isMaster && !isFolder && (
        <>
          <div className="insp-row">
            <span className="insp-label">Sends</span>
            <span className="grow" />
            <IconButton icon="plus" tooltip="Add send" onClick={addSendMenu} />
          </div>
          {track.sends.length > 0 ? (
            <div className="insp-list">
              {track.sends.map((s, i) => (
                <div className="insp-item" key={i}>
                  <span className="insp-item-name" title={trackNameById(project, s.destTrackId)}>
                    {trackNameById(project, s.destTrackId)}
                  </span>
                  <LevelKnob
                    level={s.level}
                    onDrag={(v) => dragSend(id, i, { level: v })}
                    onCommit={(v) => void commitSend(id, i, { level: v })}
                    title="Send level (dB)"
                  />
                  <Toggle
                    on={s.pre}
                    onChange={(on) => void setSend(id, i, { pre: on })}
                    tooltip="Pre-fader"
                    style={{ height: 20, padding: "0 5px", fontSize: 10 }}
                  >
                    PRE
                  </Toggle>
                  <IconButton
                    icon="power"
                    active={s.enabled}
                    tooltip={s.enabled ? "Disable send" : "Enable send"}
                    size={20}
                    onClick={() => void setSend(id, i, { enabled: !s.enabled })}
                  />
                  <IconButton
                    icon="trash"
                    danger
                    tooltip="Remove send"
                    size={20}
                    onClick={() => void removeSend(id, i).catch((e) => setErr(errText(e)))}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="insp-hint">No sends.</div>
          )}
        </>
      )}

      {/* ---- inserts ---- */}
      {!isFolder && (
        <>
          <div className="insp-row">
            <span className="insp-label">Inserts</span>
          </div>
          {track.inserts.length > 0 ? (
            <div className="insp-list">
              {track.inserts.map((ins, i) => {
                const ps = insertStates[i];
                const bad =
                  ps && (ps.state === "crashed" || ps.state === "timeout" || ps.state === "failed");
                const warnState = ps && (ps.state === "loading" || ps.state === "restarting");
                return (
                  <div className={"insp-item" + (ins.bypass ? " bypassed" : "")} key={ins.instanceId}>
                    <span className="faint mono" style={{ flex: "0 0 auto" }}>
                      {i + 1}
                    </span>
                    <span className="insp-item-name" title={ins.name}>
                      {ins.name}
                    </span>
                    {bad ? (
                      <span className="badge danger" title={ps.message ?? ps.state}>
                        {ps.state}
                      </span>
                    ) : warnState ? (
                      <span className="badge warn" title={ps.message ?? ps.state}>
                        {ps.state}
                      </span>
                    ) : null}
                    <IconButton
                      icon="chevronUp"
                      size={20}
                      tooltip="Move up"
                      disabled={i === 0}
                      onClick={() => void movePlugin(id, ins.instanceId, i - 1)}
                    />
                    <IconButton
                      icon="chevronDown"
                      size={20}
                      tooltip="Move down"
                      disabled={i === track.inserts.length - 1}
                      onClick={() => void movePlugin(id, ins.instanceId, i + 1)}
                    />
                    <IconButton
                      icon="power"
                      size={20}
                      active={!ins.bypass}
                      tooltip={ins.bypass ? "Un-bypass" : "Bypass"}
                      onClick={() => void setPlugin(ins.instanceId, { bypass: !ins.bypass })}
                    />
                    <IconButton
                      icon="sliders"
                      size={20}
                      tooltip="Open editor"
                      onClick={() => openPluginEditorWindow(ins.instanceId)}
                    />
                    <IconButton
                      icon="trash"
                      size={20}
                      danger
                      tooltip="Remove insert"
                      onClick={() =>
                        void removePlugin(id, ins.instanceId).catch((e) => setErr(errText(e)))
                      }
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="insp-hint">No inserts — drag a plugin from the Browser.</div>
          )}
        </>
      )}

      {/* ---- freeze / bounce ---- */}
      {!isMaster && !isFolder && (
        <div className="insp-row gap1">
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            title={track.frozen ? "Restore live playback" : "Render to audio and bypass inserts"}
            onClick={() =>
              run("freeze", () => (track.frozen ? unfreezeTrack(id) : bounceTrack(id, true)))
            }
          >
            <Icon name="snowflake" size={13} />
            {busy === "freeze"
              ? track.frozen
                ? "Unfreezing…"
                : "Freezing…"
              : track.frozen
                ? "Unfreeze"
                : "Freeze"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || track.frozen === true}
            title="Render this track to a new audio asset"
            onClick={() => run("bounce", () => bounceTrack(id))}
          >
            <Icon name="export" size={13} />
            {busy === "bounce" ? "Bouncing…" : "Bounce"}
          </button>
        </div>
      )}

      {err ? <div className="insp-error">{err}</div> : null}
    </Section>
    {!isFolder && <EqSection track={track} />}
    </>
  );
}
