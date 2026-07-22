/**
 * MidiActivityChip (status bar) — live "the DAW hears your keyboard" indicator,
 * fed by event/midiActivity (midiActivityBus).
 *
 * Three states:
 *   idle    dim chip — no recent MIDI
 *   ok      green LED + device name — MIDI arriving AND a track is listening
 *   warn    amber, sticky — MIDI arriving but NO track is record-armed or
 *           monitoring, i.e. the engine is dropping your notes (the silent
 *           failure this chip exists to expose). CLICK = one-click fix: arms
 *           the selected armable track, else the first instrument track.
 *
 * A normal click (non-warn) opens Settings → the MIDI device list.
 */

import React, { useEffect, useRef, useState } from "react";
import { midiActivityBus, useStore } from "../../store/store";
import { setTrack } from "../../store/actions";
import { showToast } from "../common/ToastHost";
import type { Track } from "../../protocol/types";

const LIT_MS = 900;

/** Kinds whose live input is MIDI (audio tracks listen to audio inputs instead). */
const armable = (t: Track): boolean => t.kind === "instrument" || t.kind === "midi";

function anyMidiListener(): boolean {
  const p = useStore.getState().project;
  return !!p && p.tracks.some((t) => armable(t) && (t.recordArm || t.monitor));
}

export default function MidiActivityChip() {
  const [lit, setLit] = useState(false);
  const [warn, setWarn] = useState(false);
  const [device, setDevice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = midiActivityBus.subscribe((ev) => {
      const inputs = useStore.getState().midiInputs;
      setDevice(inputs.find((i) => i.id === ev.deviceId)?.name ?? `device ${ev.deviceId}`);
      setLit(true);
      setWarn(!anyMidiListener());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setLit(false);
        setWarn(false);
      }, LIT_MS);
    });
    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const fixArm = (): void => {
    const s = useStore.getState();
    const p = s.project;
    if (!p) return;
    const selected = p.tracks.find((t) => s.selection.trackIds.includes(t.id) && armable(t));
    const target = selected ?? p.tracks.find(armable);
    if (!target) {
      showToast("No instrument or MIDI track to arm — add one first.", "info");
      return;
    }
    void setTrack(target.id, { recordArm: true })
      .then(() => showToast(`Armed "${target.name}" — your keyboard plays through it now.`, "success"))
      .catch((e) => showToast(`Arming failed: ${e instanceof Error ? e.message : e}`, "error"));
  };

  const title = warn
    ? `MIDI is arriving from "${device ?? "a device"}" but NO track is record-armed or monitoring — the notes go nowhere.\nClick to arm ${"the selected track (or the first instrument track)"}.`
    : lit
      ? `MIDI activity: ${device}`
      : "MIDI input — lights up when the engine receives notes.\nClick for MIDI device settings.";

  return (
    <button
      type="button"
      className={"sb-item sb-midi" + (warn ? " warn" : lit ? " ok" : "")}
      title={title}
      onClick={() => {
        if (warn) fixArm();
        else useStore.getState().setDialogs({ settings: true });
      }}
    >
      <span className="sb-midi-led" />
      MIDI
      {lit && device ? <span className="sb-midi-dev ellipsis">{device}</span> : null}
      {warn ? <span className="sb-midi-hint">no track armed!</span> : null}
    </button>
  );
}
