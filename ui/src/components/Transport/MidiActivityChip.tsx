/**
 * MidiActivityChip (status bar) — live "the DAW hears your keyboard" indicator,
 * fed by event/midiActivity (midiActivityBus), with SILENT-FAILURE DIAGNOSIS.
 *
 * States:
 *   idle    dim chip — no recent MIDI
 *   ok      green LED + device name — MIDI arriving and a track that can sound
 *           is listening
 *   warn    amber, one of two causes (both real support cases):
 *           1. "no track armed!"        — nothing is record-armed/monitoring;
 *              CLICK arms the best candidate (selected armable track, else the
 *              first armable track WITH a live instrument).
 *           2. "instrument not loaded!" — a track IS listening, but nothing in
 *              its chain can make sound: its instrument is dormant (typical
 *              after Import Project — needs Recreate Plugins) or absent.
 *              CLICK opens the Recreate Plugins dialog / the plugin Browser.
 *
 * Dormancy isn't in the project mirror; it is fetched from
 * project/getUnresolvedPlugins, cached per project revision (refreshed at most
 * every few seconds while MIDI is active).
 */

import React, { useEffect, useRef, useState } from "react";
import { midiActivityBus, useStore } from "../../store/store";
import { getUnresolvedPlugins, setTrack } from "../../store/actions";
import { showToast } from "../common/ToastHost";
import type { Track } from "../../protocol/types";

const LIT_MS = 1100;
const UNRESOLVED_TTL_MS = 5000;

/** Kinds whose live input is MIDI (audio tracks listen to audio inputs instead). */
const armable = (t: Track): boolean => t.kind === "instrument" || t.kind === "midi";

/* ---- dormant-insert cache (instanceIds with NO live host instance) ---- */

let unresolvedIds = new Set<number>();
let unresolvedRev = -1;
let unresolvedAt = 0;
let unresolvedInFlight = false;

function refreshUnresolved(onDone: () => void): void {
  const s = useStore.getState();
  const fresh = unresolvedRev === s.revision && Date.now() - unresolvedAt < UNRESOLVED_TTL_MS;
  if (fresh || unresolvedInFlight) return;
  unresolvedInFlight = true;
  getUnresolvedPlugins()
    .then((r) => {
      unresolvedIds = new Set((r.plugins ?? []).map((u) => u.instanceId));
      unresolvedRev = useStore.getState().revision;
      unresolvedAt = Date.now();
      onDone();
    })
    .catch(() => {
      /* transient — next activity retries */
    })
    .finally(() => {
      unresolvedInFlight = false;
    });
}

/** True when the track's chain (following midiTarget for feeders) has a LIVE
    instrument insert — i.e. arming it can actually make sound. */
function canSound(t: Track): boolean {
  const s = useStore.getState();
  const p = s.project;
  if (!p) return false;
  const host =
    t.kind === "midi" && t.midiTarget
      ? (p.tracks.find((x) => x.id === t.midiTarget) ?? t)
      : t;
  return host.inserts.some((i) => {
    if (unresolvedIds.has(i.instanceId)) return false; // dormant
    const info = s.registry.find((r) => r.uid === i.uid);
    return info ? info.isInstrument : false;
  });
}

type Diag =
  | { kind: "ok" }
  | { kind: "noListener" }
  | { kind: "cantSound"; track: Track; dormant: boolean };

function diagnose(): Diag {
  const p = useStore.getState().project;
  if (!p) return { kind: "ok" };
  const listeners = p.tracks.filter((t) => armable(t) && (t.recordArm || t.monitor));
  if (listeners.length === 0) return { kind: "noListener" };
  if (listeners.some(canSound)) return { kind: "ok" };
  const first = listeners[0];
  const dormant = first.inserts.some((i) => unresolvedIds.has(i.instanceId));
  return { kind: "cantSound", track: first, dormant };
}

export default function MidiActivityChip() {
  const [lit, setLit] = useState(false);
  const [diag, setDiag] = useState<Diag>({ kind: "ok" });
  const [device, setDevice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = midiActivityBus.subscribe((ev) => {
      const inputs = useStore.getState().midiInputs;
      setDevice(inputs.find((i) => i.id === ev.deviceId)?.name ?? `device ${ev.deviceId}`);
      setLit(true);
      setDiag(diagnose());
      refreshUnresolved(() => setDiag(diagnose())); // dormancy may sharpen the verdict
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setLit(false);
        setDiag({ kind: "ok" });
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
    const target =
      (selected && canSound(selected) ? selected : undefined) ??
      p.tracks.find((t) => armable(t) && canSound(t)) ??
      selected ??
      p.tracks.find(armable);
    if (!target) {
      showToast("No instrument or MIDI track to arm — add one first.", "info");
      return;
    }
    void setTrack(target.id, { recordArm: true })
      .then(() => showToast(`Armed "${target.name}" — your keyboard plays through it now.`, "success"))
      .catch((e) => showToast(`Arming failed: ${e instanceof Error ? e.message : e}`, "error"));
  };

  const onClick = (): void => {
    if (diag.kind === "noListener") fixArm();
    else if (diag.kind === "cantSound" && diag.dormant)
      useStore.getState().setDialogs({ recreatePlugins: true });
    else if (diag.kind === "cantSound") {
      useStore.getState().setPanels({ browser: true, browserTab: "plugins" });
      showToast(`"${diag.track.name}" has no instrument — drag one onto it from the Browser.`, "info");
    } else useStore.getState().setDialogs({ settings: true });
  };

  const warn = lit && diag.kind !== "ok";
  const hint =
    diag.kind === "noListener"
      ? "no track armed!"
      : diag.kind === "cantSound"
        ? "instrument not loaded!"
        : null;
  const title =
    diag.kind === "noListener"
      ? `MIDI is arriving from "${device ?? "a device"}" but NO track is record-armed or monitoring — the notes go nowhere.\nClick to arm a track that can play them.`
      : diag.kind === "cantSound"
        ? diag.dormant
          ? `"${diag.track.name}" is armed, but its instrument is DORMANT (not loaded — typical after Import Project).\nClick to open Recreate Plugins.`
          : `"${diag.track.name}" is armed, but it has no loaded instrument to make sound.\nClick to open the plugin Browser.`
        : lit
          ? `MIDI activity: ${device}`
          : "MIDI input — lights up when the engine receives notes.\nClick for MIDI device settings.";

  return (
    <button
      type="button"
      className={"sb-item sb-midi" + (warn ? " warn" : lit ? " ok" : "")}
      title={title}
      onClick={onClick}
    >
      <span className="sb-midi-led" />
      MIDI
      {lit && device ? <span className="sb-midi-dev ellipsis">{device}</span> : null}
      {warn && hint ? <span className="sb-midi-hint">{hint}</span> : null}
    </button>
  );
}
