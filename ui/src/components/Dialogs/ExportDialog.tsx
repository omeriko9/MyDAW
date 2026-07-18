/**
 * Export dialog (U5) — store.dialogs.export. Range (loop / whole project / custom bars),
 * bit depth, normalize → export/render (no path: engine shows its native save dialog).
 * Progress via event/exportProgress (store.exportProgress), done state with path+seconds.
 */

import React, { useEffect, useState } from "react";
import type { ExportFormat, Project } from "../../protocol/types";
import { numberIn, oneOf, usePrefState } from "../../lib/prefs";
import { useStore } from "../../store/store";
import { renderExport } from "../../store/actions";
import { WsRequestError } from "../../protocol/ws";
import {
  barToBeat,
  beatToBar,
  beatsToSeconds,
  formatBarsBeats,
  secondsToBeats,
} from "../../lib/time";
import { Modal } from "../common/Modal";
import { NumberDrag } from "../common/NumberDrag";
import { Select } from "../common/Select";
import { Icon } from "../common/icons";
import { showToast } from "../common/ToastHost";

type RangeMode = "loop" | "project" | "custom";
type Codec = "wav16" | "wav24" | "wav32" | "mp3" | "flac" | "m4a";

const CODECS: { value: Codec; label: string }[] = [
  { value: "wav24", label: "WAV 24-bit PCM" },
  { value: "wav16", label: "WAV 16-bit PCM" },
  { value: "wav32", label: "WAV 32-bit float" },
  { value: "mp3", label: "MP3" },
  { value: "m4a", label: "AAC (.m4a)" },
  { value: "flac", label: "FLAC (lossless)" },
];

function formatFor(codec: Codec, kbps: number): ExportFormat {
  switch (codec) {
    case "wav16": return { type: "wav", bitDepth: 16 };
    case "wav24": return { type: "wav", bitDepth: 24 };
    case "wav32": return { type: "wav", bitDepth: 32 };
    case "flac": return { type: "flac", bitDepth: 24 };
    case "mp3": return { type: "mp3", bitDepth: 16, kbps };
    case "m4a": return { type: "m4a", bitDepth: 16, kbps };
  }
}

type Phase =
  | { kind: "config" }
  | { kind: "exporting" }
  | { kind: "done"; path: string; seconds: number; lufs?: number; peakDb?: number };

// "Off" | "peak" | LUFS target
type LoudnessMode = "off" | "peak" | "-14" | "-16" | "-23";
const LOUDNESS: { value: LoudnessMode; label: string }[] = [
  { value: "off", label: "None" },
  { value: "peak", label: "Peak → 0 dBFS" },
  { value: "-14", label: "-14 LUFS (streaming)" },
  { value: "-16", label: "-16 LUFS (podcast)" },
  { value: "-23", label: "-23 LUFS (broadcast)" },
];

/** End of the last clip, rounded up to the next bar (min 1 bar). */
function projectEndBeat(p: Project): number {
  let end = 0;
  for (const t of p.tracks) {
    for (const c of t.clips) {
      let e: number;
      if (c.type === "midi") {
        e = c.startBeat + c.lengthBeats;
      } else {
        const sr = p.sampleRate > 0 ? p.sampleRate : 48000;
        const startSec = beatsToSeconds(c.startBeat, p.tempoMap);
        e = secondsToBeats(startSec + c.lengthSamples / sr, p.tempoMap);
      }
      if (e > end) end = e;
    }
  }
  const sig = p.timeSigMap;
  const bar = beatToBar(Math.max(end, 0.0001), sig);
  const barStart = barToBeat(bar, sig);
  const endBar = end <= barStart + 1e-9 ? bar : bar + 1;
  return Math.max(barToBeat(endBar, sig), barToBeat(2, sig));
}

export default function ExportDialog() {
  const open = useStore((s) => s.dialogs.export);
  const setDialogs = useStore((s) => s.setDialogs);
  const project = useStore((s) => s.project);
  const exportProgress = useStore((s) => s.exportProgress);

  // Range mode / codec / bitrate / loudness remember the last-used values across
  // exports and reloads; custom from/to bars stay per-session (project-specific).
  const [range, setRange] = usePrefState<RangeMode>(
    "export.range",
    "project",
    oneOf<RangeMode>("loop", "project", "custom"),
  );
  const [fromBar, setFromBar] = useState(1);
  const [toBar, setToBar] = useState(5);
  const [codec, setCodec] = usePrefState<Codec>(
    "export.codec",
    "wav24",
    oneOf(...CODECS.map((c) => c.value)),
  );
  const [kbps, setKbps] = usePrefState("export.kbps", 320, numberIn(64, 320));
  const [loudness, setLoudness] = usePrefState<LoudnessMode>(
    "export.loudness",
    "off",
    oneOf(...LOUDNESS.map((l) => l.value)),
  );
  const lossy = codec === "mp3" || codec === "m4a";
  const [phase, setPhase] = useState<Phase>({ kind: "config" });
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPhase({ kind: "config" });
      setErr(null);
    }
  }, [open]);

  const close = () => setDialogs({ export: false });

  if (!project) {
    return (
      <Modal open={open} onClose={close} title="Export Audio" width={460}>
        <div className="dim">No project — connect to the engine first.</div>
      </Modal>
    );
  }

  const sig = project.timeSigMap;
  const loop = project.loop;
  const loopValid = loop.endBeat > loop.startBeat;

  const computeRange = (): { startBeat: number; endBeat: number } => {
    if (range === "loop") return { startBeat: loop.startBeat, endBeat: loop.endBeat };
    if (range === "custom")
      return { startBeat: barToBeat(fromBar, sig), endBeat: barToBeat(toBar, sig) };
    return { startBeat: 0, endBeat: projectEndBeat(project) };
  };

  const { startBeat, endBeat } = computeRange();
  const rangeValid = endBeat > startBeat;
  const durSec = rangeValid
    ? beatsToSeconds(endBeat, project.tempoMap) - beatsToSeconds(startBeat, project.tempoMap)
    : 0;

  const doExport = () => {
    if (!rangeValid) return;
    setErr(null);
    setPhase({ kind: "exporting" });
    renderExport({
      startBeat,
      endBeat,
      format: formatFor(codec, kbps),
      ...(loudness === "peak" ? { normalize: true } : {}),
      ...(loudness !== "off" && loudness !== "peak" ? { loudnessTarget: Number(loudness) } : {}),
    })
      .then((r) => setPhase({ kind: "done", path: r.path, seconds: r.seconds, lufs: r.lufs, peakDb: r.peakDb }))
      .catch((e) => {
        if (e instanceof WsRequestError && e.code === "timeout") {
          // The engine may still be exporting (e.g. its native save dialog is open).
          setErr(
            "No reply yet — the engine may still be exporting (its save dialog could be open). " +
              "You can close this window; the export continues engine-side.",
          );
        } else {
          setErr(e instanceof Error ? e.message : String(e));
          setPhase({ kind: "config" });
        }
      });
  };

  const footer =
    phase.kind === "config" ? (
      <>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!rangeValid} onClick={doExport}>
          <Icon name="export" size={13} />
          Export…
        </button>
      </>
    ) : phase.kind === "exporting" ? (
      <button type="button" className="btn" onClick={close}>
        Hide
      </button>
    ) : (
      <button type="button" className="btn primary" onClick={close}>
        Close
      </button>
    );

  return (
    <Modal open={open} onClose={close} title="Export Audio" width={480} footer={footer}>
      {phase.kind === "config" && (
        <div className="col gap2">
          <div className="dlg-section">
            <div className="dlg-subhead">Range</div>
            <label className={"dlg-radio" + (loopValid ? "" : " disabled")}>
              <input
                type="radio"
                name="exp-range"
                checked={range === "loop"}
                disabled={!loopValid}
                onChange={() => setRange("loop")}
              />
              <span>
                Loop region
                {loopValid ? (
                  <span className="dim">
                    {" "}
                    ({formatBarsBeats(loop.startBeat, sig)} → {formatBarsBeats(loop.endBeat, sig)})
                  </span>
                ) : (
                  <span className="faint"> (no loop region set)</span>
                )}
              </span>
            </label>
            <label className="dlg-radio">
              <input
                type="radio"
                name="exp-range"
                checked={range === "project"}
                onChange={() => setRange("project")}
              />
              <span>Whole project</span>
            </label>
            <label className="dlg-radio">
              <input
                type="radio"
                name="exp-range"
                checked={range === "custom"}
                onChange={() => setRange("custom")}
              />
              <span>Custom range</span>
            </label>
            <div className="dlg-indent">
              <span>from bar</span>
              <NumberDrag
                value={fromBar}
                min={1}
                max={9999}
                step={1}
                precision={0}
                width={48}
                disabled={range !== "custom"}
                onChange={(v) => setFromBar(Math.round(v))}
              />
              <span>to bar</span>
              <NumberDrag
                value={toBar}
                min={1}
                max={9999}
                step={1}
                precision={0}
                width={48}
                disabled={range !== "custom"}
                onChange={(v) => setToBar(Math.round(v))}
              />
            </div>
          </div>

          <div className="dlg-section">
            <div className="dlg-subhead">Format</div>
            <div className="row gap2">
              <Select
                value={codec}
                width={150}
                options={CODECS}
                onChange={(v) => setCodec(v as Codec)}
              />
              {lossy ? (
                <Select
                  value={String(kbps)}
                  width={110}
                  options={[
                    { value: "128", label: "128 kbps" },
                    { value: "192", label: "192 kbps" },
                    { value: "256", label: "256 kbps" },
                    { value: "320", label: "320 kbps" },
                  ]}
                  onChange={(v) => setKbps(Number(v))}
                />
              ) : null}
            </div>
            <div className="row gap2" style={{ marginTop: 6 }}>
              <span className="dim">Normalize</span>
              <Select
                value={loudness}
                width={190}
                options={LOUDNESS}
                onChange={(v) => setLoudness(v as LoudnessMode)}
              />
            </div>
          </div>

          <div className="dlg-summary">
            {rangeValid ? (
              <>
                <span className="mono">{formatBarsBeats(startBeat, sig)}</span>
                {" → "}
                <span className="mono">{formatBarsBeats(endBeat, sig)}</span>
                {"  ·  "}
                {durSec.toFixed(1)} s — a native save dialog opens on the engine machine.
              </>
            ) : (
              <span className="dlg-warn">Invalid range — the end must be after the start.</span>
            )}
          </div>
          {err ? <div className="dlg-error">{err}</div> : null}
        </div>
      )}

      {phase.kind === "exporting" && (
        <div className="col gap2">
          <div className="dlg-progress">
            {exportProgress !== null ? (
              <div
                className="dlg-progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, exportProgress))}%` }}
              />
            ) : (
              <div className="dlg-progress-fill indeterminate" />
            )}
          </div>
          <div className="dim">
            Rendering offline (full graph incl. plugins)…
            {exportProgress !== null ? ` ${Math.round(exportProgress)}%` : ""}
          </div>
          {err ? <div className="dlg-warn">{err}</div> : null}
        </div>
      )}

      {phase.kind === "done" && (
        <div className="dlg-done">
          <div className="row gap1 dlg-ok">
            <Icon name="check" size={15} />
            Export complete
          </div>
          <div className="row gap1" style={{ alignItems: "center", alignSelf: "stretch" }}>
            <div className="dlg-path grow" style={{ minWidth: 0 }}>
              {phase.path}
            </div>
            <button
              type="button"
              className="btn"
              style={{ flex: "0 0 auto" }}
              title="Copy the full file path to the clipboard"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(phase.path)
                  .then(() => showToast("Path copied to clipboard", "success"))
                  .catch(() => showToast("Could not access the clipboard", "error"));
              }}
            >
              Copy path
            </button>
          </div>
          <div className="dim">
            {phase.seconds.toFixed(1)} s of audio written
            {typeof phase.lufs === "number" && phase.lufs > -70
              ? ` — ${phase.lufs.toFixed(1)} LUFS`
              : ""}
            {typeof phase.peakDb === "number" ? `, ${phase.peakDb.toFixed(1)} dBFS peak` : ""}
            .
          </div>
        </div>
      )}
    </Modal>
  );
}
