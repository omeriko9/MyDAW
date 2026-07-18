/**
 * ChannelStrip (U3) — one mixer strip (SPEC §9 "Mixer").
 *
 * Top-to-bottom: color tab (click → palette), kind icon + name (TextInput →
 * cmd/track.set), input select (audio: capture channel mono/pairs from
 * store.audioDevices; midi/instrument: omni label), output select (master/buses/none),
 * inserts, sends, pan knob (bipolar, dragTrack/commitTrack), fader + meter
 * (metersBus), dB readout, M/S/R/monitor row. Master variant: no IO selects, no
 * sends, no buttons; shows output device + engine latency; clip latch lives on the
 * meter itself (click resets). The whole strip accepts Browser plugin drags AND insert
 * drags from other strips (lib/dnd; insert drags append at the chain end — move, or
 * Alt-copy with settings) unless frozen; InsertSlots consumes drops on itself, so no
 * double-add.
 */

import React, { useRef, useState } from "react";
import type { Track, TrackKind } from "../../protocol/types";
import { metersBus, useStore } from "../../store/store";
import * as actions from "../../store/actions";
import { hasInsertDrag, hasPluginDrag, insertDropEffectFor, readPluginDrag } from "../../lib/dnd";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import { confirmDialog } from "../Dialogs/confirm";
import type { IconName } from "../common/icons";
import { Icon } from "../common/icons";
import { Fader, gainToDbText } from "../common/Fader";
import { Knob } from "../common/Knob";
import { Meter } from "../common/Meter";
import { Select, SelectOption } from "../common/Select";
import { TextInput } from "../common/TextInput";
import { Tooltip } from "../common/Tooltip";
import { InsertSlots, applyInsertAreaDrop } from "./InsertSlots";
import { SendsBlock } from "./SendsBlock";
import { ColorPopup } from "./popups";
import { useGestureValue } from "./useGestureValue";

export const KIND_ICONS: Record<TrackKind, IconName> = {
  audio: "audioWave",
  midi: "midiNote",
  instrument: "piano",
  folder: "folder",
  bus: "sliders",
  master: "mixer",
};

function panText(v: number): string {
  const n = Math.round(Math.abs(v) * 100);
  if (n === 0) return "C";
  return v < 0 ? `L${n}` : `R${n}`;
}

/* ============================================================================
 * IO selects
 * ========================================================================= */

function InputSelect({ track }: { track: Track }) {
  const audioDevices = useStore((s) => s.audioDevices);
  const engineInfo = useStore((s) => s.engineInfo);

  const opts: SelectOption[] = [{ value: "", label: "No Input" }];
  const driverName = (engineInfo?.driver ?? "").toLowerCase();
  const driver =
    audioDevices?.drivers.find((d) => d.available && d.type === driverName) ??
    audioDevices?.drivers.find((d) => d.available);
  for (const dev of driver?.devices ?? []) {
    if (dev.maxInputs <= 0) continue;
    // NOTE(spec): inputChannel encoding is not pinned in SPEC; we use the 0-based index
    // of the (first) capture channel — pair vs mono follows track.channels.
    if (track.channels === 2) {
      for (let c = 0; c + 1 < dev.maxInputs; c += 2) {
        opts.push({ value: `${dev.id}::${c}`, label: `In ${c + 1}/${c + 2}`, group: dev.name });
      }
      if (dev.maxInputs === 1) {
        opts.push({ value: `${dev.id}::0`, label: "In 1", group: dev.name });
      }
    } else {
      for (let c = 0; c < dev.maxInputs; c++) {
        opts.push({ value: `${dev.id}::${c}`, label: `In ${c + 1}`, group: dev.name });
      }
    }
  }
  const cur = track.inputDevice ? `${track.inputDevice}::${track.inputChannel ?? 0}` : "";
  if (cur !== "" && !opts.some((o) => o.value === cur)) {
    opts.push({ value: cur, label: `In ${(track.inputChannel ?? 0) + 1} (missing)` });
  }

  return (
    <Select
      className="mxstrip-select"
      value={cur}
      options={opts}
      title="Record input"
      onChange={(v) => {
        if (v === "") {
          void actions.setTrack(track.id, { inputDevice: "", inputChannel: 0 });
          return;
        }
        const i = v.lastIndexOf("::");
        void actions.setTrack(track.id, {
          inputDevice: v.slice(0, i),
          inputChannel: Number(v.slice(i + 2)),
        });
      }}
    />
  );
}

function OutputSelect({ track, buses }: { track: Track; buses: Track[] }) {
  const opts: SelectOption[] = [{ value: "master", label: "Master" }];
  for (const b of buses) {
    if (b.id !== track.id) opts.push({ value: String(b.id), label: b.name, group: "Buses" });
  }
  opts.push({ value: "none", label: "No Output" });

  const cur = typeof track.outputTarget === "number" ? String(track.outputTarget) : track.outputTarget;
  if (!opts.some((o) => o.value === cur)) opts.push({ value: cur, label: `#${cur} (missing)` });

  return (
    <Select
      className="mxstrip-select"
      value={cur}
      options={opts}
      title="Output routing"
      onChange={(v) => {
        const outputTarget = v === "master" || v === "none" ? v : Number(v);
        void actions.setTrack(track.id, { outputTarget });
      }}
    />
  );
}

/* ============================================================================
 * M / S / R / monitor row
 * ========================================================================= */

function StripButtons({ track }: { track: Track }) {
  const canArm = track.kind === "audio" || track.kind === "midi" || track.kind === "instrument";
  return (
    <div className="mxstrip-btns">
      <button
        type="button"
        className="mxbtn"
        data-on={track.mute ? "true" : undefined}
        data-variant="danger"
        title="Mute (M)"
        onClick={() => void actions.setTrack(track.id, { mute: !track.mute })}
      >
        M
      </button>
      <button
        type="button"
        className="mxbtn"
        data-on={track.solo ? "true" : undefined}
        data-variant="warn"
        title="Solo (S)"
        onClick={() => void actions.setTrack(track.id, { solo: !track.solo })}
      >
        S
      </button>
      {canArm && (
        <button
          type="button"
          className="mxbtn"
          data-on={track.recordArm ? "true" : undefined}
          data-variant="danger"
          title="Record arm"
          onClick={() => void actions.setTrack(track.id, { recordArm: !track.recordArm })}
        >
          <Icon name="record" size={9} />
        </button>
      )}
      {canArm && (
        <button
          type="button"
          className="mxbtn"
          data-on={track.monitor ? "true" : undefined}
          data-variant="ok"
          title="Input monitor"
          onClick={() => void actions.setTrack(track.id, { monitor: !track.monitor })}
        >
          <Icon name="headphones" size={10} />
        </button>
      )}
    </div>
  );
}

/* ============================================================================
 * The strip
 * ========================================================================= */

export interface ChannelStripProps {
  track: Track;
  /** Bus tracks, for output routing + sends destinations. */
  buses: Track[];
  wide: boolean;
  isMaster?: boolean;
}

export const ChannelStrip = React.memo(function ChannelStrip({
  track,
  buses,
  wide,
  isMaster,
}: ChannelStripProps) {
  const selected = useStore((s) => s.selection.trackIds.includes(track.id));
  const setSelection = useStore((s) => s.setSelection);
  const engineStatus = useStore((s) => s.engineStatus);
  const engineInfo = useStore((s) => s.engineInfo);
  const [colorPop, setColorPop] = useState<{ x: number; y: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);

  const vol = useGestureValue(track.volume);
  const pan = useGestureValue(track.pan);
  const frozen = !!track.frozen;
  const width = wide ? 84 : 56;
  const faderH = wide ? 150 : 120;
  const meterW = wide ? 12 : 8;

  const getLevels = () =>
    isMaster
      ? metersBus.last?.master ?? null
      : metersBus.last?.tracks[String(track.id)] ?? null;

  const latencyMs = engineStatus?.latencyMs ?? engineInfo?.latencyMs;

  /* ---- drag-drop: whole strip is a target for Browser plugins & insert drags.
   * MIDI channels host no audio plugins (Cubase semantics) — they accept nothing. ---- */
  const stripAccepts = (dt: DataTransfer) =>
    track.kind !== "midi" && (hasPluginDrag(dt) || hasInsertDrag(dt));

  const onDragEnter = (e: React.DragEvent) => {
    if (frozen || !stripAccepts(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current++;
    setDropActive(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (frozen || !stripAccepts(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = hasInsertDrag(e.dataTransfer)
      ? insertDropEffectFor(track.id, e.altKey)
      : "copy";
  };
  const onDragLeave = () => {
    if (dragDepth.current > 0) dragDepth.current--;
    if (dragDepth.current === 0) setDropActive(false);
  };
  // capture phase: clear the highlight even when InsertSlots consumes the drop
  // (its onDrop stopPropagation()s, so the bubble handler below never runs then)
  const onDropCapture = () => {
    dragDepth.current = 0;
    setDropActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (frozen) {
      // Swallow insert drags so a frozen strip cancels the drag instead of letting it
      // bubble to lib/dnd's drop-on-nothing listener (which would remove the insert).
      if (hasInsertDrag(e.dataTransfer)) e.stopPropagation();
      return;
    }
    if (hasInsertDrag(e.dataTransfer)) {
      // Insert dropped on the strip body: append at the chain end (move, or Alt-copy).
      e.preventDefault();
      e.stopPropagation();
      void applyInsertAreaDrop(track, e.dataTransfer, track.inserts.length, e.altKey);
      return;
    }
    const data = readPluginDrag(e.dataTransfer);
    if (!data) return;
    e.preventDefault();
    e.stopPropagation();
    void actions.addPlugin(track.id, data.uid);
  };

  /* ---- strip context menu (right-click anywhere on the strip) ---- */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canArm = track.kind === "audio" || track.kind === "midi" || track.kind === "instrument";

  const onStripContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected) setSelection({ trackIds: [track.id] });
    const x = e.clientX;
    const y = e.clientY;
    const set = (patch: Parameters<typeof actions.setTrack>[1]) =>
      void actions.setTrack(track.id, patch);
    const items: MenuEntry[] = [];
    if (!isMaster) {
      items.push(
        {
          label: "Rename…",
          icon: "pencil",
          onClick: () => {
            const input = rootRef.current?.querySelector<HTMLInputElement>(".mxstrip-name");
            input?.focus();
            input?.select();
          },
        },
        { label: "Color…", onClick: () => setColorPop({ x, y }) },
        "separator",
        { label: "Mute", shortcut: "M", checked: !!track.mute, onClick: () => set({ mute: !track.mute }) },
        { label: "Solo", shortcut: "S", checked: !!track.solo, onClick: () => set({ solo: !track.solo }) },
      );
      if (canArm) {
        items.push(
          { label: "Record Arm", checked: !!track.recordArm, onClick: () => set({ recordArm: !track.recordArm }) },
          { label: "Input Monitor", checked: !!track.monitor, onClick: () => set({ monitor: !track.monitor }) },
        );
      }
    }
    items.push(
      "separator",
      {
        label: "Reset Volume (0 dB)",
        disabled: track.volume === 1,
        onClick: () => void actions.commitTrack(track.id, { volume: 1 }),
      },
    );
    if (!isMaster) {
      items.push({
        label: "Reset Pan (Center)",
        disabled: track.pan === 0,
        onClick: () => void actions.commitTrack(track.id, { pan: 0 }),
      });
      const freezable = canArm;
      if (freezable) {
        items.push(
          "separator",
          track.frozen
            ? { label: "Unfreeze Track", icon: "snowflake", onClick: () => void actions.unfreezeTrack(track.id) }
            : { label: "Freeze Track", icon: "snowflake", onClick: () => void actions.bounceTrack(track.id, true) },
          { label: "Bounce to Audio", icon: "export", onClick: () => void actions.bounceTrack(track.id, false) },
        );
      }
      items.push(
        "separator",
        { label: "Duplicate Track", icon: "plus", onClick: () => void actions.duplicateTrack(track.id) },
        {
          label: "Delete Track",
          icon: "trash",
          danger: true,
          onClick: () => {
            void confirmDialog({
              title: "Delete track",
              message: `Delete "${track.name}"${track.clips.length > 0 ? ` and its ${track.clips.length} clip${track.clips.length === 1 ? "" : "s"}` : ""}? This can be undone.`,
              confirmLabel: "Delete",
              danger: true,
            }).then((ok) => {
              if (ok) void actions.removeTrack(track.id);
            });
          },
        },
      );
    } else {
      items.push("separator", {
        label: "Reset Audio (Panic)",
        icon: "warning",
        title: "All notes off + reset the audio engine",
        onClick: () => void actions.panic(),
      });
    }
    openContextMenu(x, y, items);
  };

  return (
    <div
      ref={rootRef}
      className={
        "mxstrip" +
        (selected ? " selected" : "") +
        (wide ? "" : " narrow") +
        (dropActive ? " drop-active" : "")
      }
      style={{ width }}
      onPointerDown={() => {
        if (!selected) setSelection({ trackIds: [track.id] });
      }}
      onContextMenu={onStripContextMenu}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDropCapture={onDropCapture}
      onDrop={onDrop}
    >
      {/* color tab — a real button so it is focusable and Enter opens the palette */}
      <button
        type="button"
        className="mxstrip-color"
        style={{ background: track.color || "var(--accent)" }}
        title="Track color"
        aria-label="Track color"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setColorPop({ x: r.left, y: r.bottom + 4 });
        }}
      />

      {/* kind icon + name + frozen badge */}
      <div className="mxstrip-head">
        <span className="mxstrip-kind" title={track.kind}>
          <Icon name={KIND_ICONS[track.kind]} size={11} />
        </span>
        <TextInput
          className="mxstrip-name"
          value={track.name}
          title={track.name}
          onCommit={(v) => {
            const name = v.trim();
            if (name) void actions.setTrack(track.id, { name });
          }}
        />
        {frozen && (
          <Tooltip content="Track is frozen — inserts are bypassed (unfreeze from the track list)">
            <span className="mxstrip-frozen">
              <Icon name="snowflake" size={11} />
            </span>
          </Tooltip>
        )}
      </div>

      {/* IO (wide only — narrow strips drop detail sections) */}
      {wide && !isMaster && (
        <div className="mxstrip-io">
          {track.kind === "audio" ? (
            <InputSelect track={track} />
          ) : track.kind === "midi" || track.kind === "instrument" ? (
            <div className="mxstrip-static" title="MIDI input: all enabled devices, all channels">
              In: Omni
            </div>
          ) : null}
          <OutputSelect track={track} buses={buses} />
        </div>
      )}
      {wide && isMaster && (
        <div className="mxstrip-io">
          <div
            className="mxstrip-static"
            title={`Hardware output${engineStatus?.device ? `: ${engineStatus.device}` : ""}`}
          >
            Out: {engineStatus?.device || engineInfo?.driver || "device"}
          </div>
        </div>
      )}

      {/* inserts + sends (MIDI channels host no audio plugins — no insert section) */}
      {wide && track.kind !== "midi" && <InsertSlots track={track} />}
      {wide && !isMaster && <SendsBlock track={track} buses={buses} />}
      {!wide && <div className="mxstrip-flexspace" />}

      {/* pan */}
      <div className="mxstrip-pan">
        <Knob
          size={wide ? 28 : 22}
          min={-1}
          max={1}
          bipolar
          defaultValue={0}
          label="Pan"
          value={pan.value}
          format={panText}
          title={`Pan ${panText(pan.value)} — double-click centers`}
          onChange={(v) => {
            pan.drag(v);
            actions.dragTrack(track.id, { pan: v });
          }}
          onCommit={(v) => {
            pan.end(v);
            void actions.commitTrack(track.id, { pan: v });
          }}
        />
      </div>

      {/* fader + meter */}
      <div className="mxstrip-fader">
        <Fader
          value={vol.value}
          height={faderH}
          width={wide ? 34 : 24}
          noTicks={!wide}
          title={`${gainToDbText(vol.value)} dB — double-click resets to 0 dB`}
          onChange={(v) => {
            vol.drag(v);
            actions.dragTrack(track.id, { volume: v });
          }}
          onCommit={(v) => {
            vol.end(v);
            void actions.commitTrack(track.id, { volume: v });
          }}
        />
        <div style={{ width: meterW, height: faderH }}>
          <Meter getLevels={getLevels} channels={track.channels === 1 ? 1 : 2} />
        </div>
      </div>
      <div className="mxstrip-db" title="Fader level">
        {gainToDbText(vol.value)}
      </div>

      {/* M / S / R / monitor — not on the master strip */}
      {!isMaster && <StripButtons track={track} />}
      {isMaster && (
        <div className="mxstrip-lat" title="Engine output latency">
          {typeof latencyMs === "number" ? `${latencyMs.toFixed(1)} ms` : "— ms"}
        </div>
      )}

      {colorPop && (
        <ColorPopup
          x={colorPop.x}
          y={colorPop.y}
          onClose={() => setColorPop(null)}
          onPick={(color) => void actions.setTrack(track.id, { color })}
        />
      )}
    </div>
  );
});
