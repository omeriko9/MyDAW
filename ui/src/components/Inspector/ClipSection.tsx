/**
 * Inspector CLIP section (U5): name/color/mute, start (bars.beats), length,
 * audio gain/fades/source info + [Open in Editor], midi note count + [Open Piano Roll].
 */

import React from "react";
import type { Clip, Project, Track } from "../../protocol/types";
import { isAudioClip, isMidiClip } from "../../protocol/types";
import { useStore } from "../../store/store";
import { moveClips, resizeClip, setClip } from "../../store/actions";
import { transientParam, commitParam } from "../../store/actions";
import {
  beatsToSeconds,
  formatBarsBeats,
  parseBarsBeats,
  secondsToBeats,
} from "../../lib/time";
import { Section } from "./Section";
import { ColorSwatches, GainDbDrag, SecondsDrag, useDraftValue } from "./fields";
import { TextInput } from "../common/TextInput";
import { Toggle } from "../common/Toggle";
import { NumberDrag } from "../common/NumberDrag";
import { Icon } from "../common/icons";

/** Audio clip length in beats at its position (duration mapped through the tempo map). */
function audioLengthBeats(startBeat: number, lengthSamples: number, project: Project): number {
  const sr = project.sampleRate > 0 ? project.sampleRate : 48000;
  const startSec = beatsToSeconds(startBeat, project.tempoMap);
  const endBeat = secondsToBeats(startSec + lengthSamples / sr, project.tempoMap);
  return Math.max(0, endBeat - startBeat);
}

function LengthDrag({
  lengthBeats,
  onCommitLength,
}: {
  lengthBeats: number;
  onCommitLength: (v: number) => void;
}) {
  const { shown, preview, settle } = useDraftValue(lengthBeats);
  return (
    <NumberDrag
      value={shown}
      min={0.0625}
      step={0.25}
      precision={2}
      units="beats"
      width={72}
      title="Clip length"
      onChange={(v) => preview(v)}
      onCommit={(v) => {
        onCommitLength(v);
        settle();
      }}
    />
  );
}

export function ClipSection({
  clip,
  track,
  project,
}: {
  clip: Clip;
  track: Track;
  project: Project;
}) {
  const setPanels = useStore((s) => s.setPanels);
  const setActiveMidiClipId = useStore((s) => s.setActiveMidiClipId);
  const setActiveAudioClipId = useStore((s) => s.setActiveAudioClipId);

  const id = clip.id;
  const sig = project.timeSigMap;
  const audio = isAudioClip(clip);
  const lengthBeats = audio
    ? audioLengthBeats(clip.startBeat, clip.lengthSamples, project)
    : clip.lengthBeats;

  const asset = audio ? project.assets.find((a) => a.id === clip.assetId) : undefined;
  const assetName = asset ? (asset.file.split(/[\\/]/).pop() ?? asset.file) : undefined;
  const sr = project.sampleRate > 0 ? project.sampleRate : 48000;

  return (
    <Section
      title="Clip"
      badge={
        <span className="row gap1">
          <span className="badge">{audio ? "audio" : "midi"}</span>
          {clip.muted ? <span className="badge danger">muted</span> : null}
        </span>
      }
    >
      <div className="insp-row">
        <span className="insp-label">Name</span>
        <TextInput
          className="grow"
          value={clip.name}
          onCommit={(v) => {
            if (v.trim().length > 0) void setClip(id, { name: v.trim() });
          }}
          placeholder="Clip name"
        />
        <Toggle
          on={clip.muted ?? false}
          onChange={(on) => void setClip(id, { muted: on })}
          variant="danger"
          tooltip="Mute clip (M)"
        >
          M
        </Toggle>
      </div>

      <div className="insp-row">
        <span className="insp-label">Color</span>
        <ColorSwatches current={clip.color} onPick={(c) => void setClip(id, { color: c })} />
      </div>

      <div className="insp-row">
        <span className="insp-label">Start</span>
        <TextInput
          className="mono"
          width={86}
          value={formatBarsBeats(clip.startBeat, sig)}
          title="Start position (bars.beats.ticks)"
          onCommit={(text) => {
            const b = parseBarsBeats(text, sig);
            if (b !== null && Math.abs(b - clip.startBeat) > 1e-9) {
              void moveClips([id], b - clip.startBeat);
            }
          }}
        />
        <span className="grow" />
        <span className="insp-label" style={{ flex: "0 0 auto" }}>
          Length
        </span>
        <LengthDrag
          lengthBeats={lengthBeats}
          onCommitLength={(v) => void resizeClip(id, "r", { newLengthBeats: v })}
        />
      </div>

      <div className="insp-row">
        <span className="insp-label">Track</span>
        <span className="ellipsis dim" title={track.name}>
          {track.name}
        </span>
      </div>

      {audio ? (
        <>
          <div className="insp-row">
            <span className="insp-label">Gain</span>
            <GainDbDrag
              gain={clip.gain}
              onDrag={(g) => transientParam("cmd/clip.set", { clipId: id, patch: { gain: g } })}
              onCommit={(g) =>
                void commitParam("cmd/clip.set", { clipId: id, patch: { gain: g } })
              }
              width={64}
              title="Clip gain"
            />
          </div>
          <div className="insp-row">
            <span className="insp-label">Fade in</span>
            <SecondsDrag
              value={clip.fadeInSec}
              onDrag={(v) =>
                transientParam("cmd/clip.set", { clipId: id, patch: { fadeInSec: v } })
              }
              onCommit={(v) =>
                void commitParam("cmd/clip.set", { clipId: id, patch: { fadeInSec: v } })
              }
              width={56}
              title="Fade-in (seconds)"
            />
            <span className="grow" />
            <span className="insp-label" style={{ flex: "0 0 auto" }}>
              Fade out
            </span>
            <SecondsDrag
              value={clip.fadeOutSec}
              onDrag={(v) =>
                transientParam("cmd/clip.set", { clipId: id, patch: { fadeOutSec: v } })
              }
              onCommit={(v) =>
                void commitParam("cmd/clip.set", { clipId: id, patch: { fadeOutSec: v } })
              }
              width={56}
              title="Fade-out (seconds)"
            />
          </div>
          <div className="insp-row">
            <span className="insp-label">Source</span>
            <span className="ellipsis" title={asset?.originalPath ?? asset?.file}>
              {assetName ?? "(missing asset)"}
            </span>
            {asset?.missing ? <span className="badge danger">missing</span> : null}
          </div>
          <div className="insp-row">
            <span className="insp-label">Offset</span>
            <span className="mono dim">
              {clip.srcOffsetSamples.toLocaleString()} smp ({(clip.srcOffsetSamples / sr).toFixed(2)} s)
            </span>
          </div>
          <div className="insp-row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setActiveAudioClipId(id);
                setPanels({ bottomTab: "clipEditor" });
              }}
            >
              <Icon name="audioWave" size={13} />
              Open in Editor
            </button>
          </div>
        </>
      ) : isMidiClip(clip) ? (
        <>
          <div className="insp-row">
            <span className="insp-label">Notes</span>
            <span className="dim">{clip.notes.length}</span>
          </div>
          <div className="insp-row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setActiveMidiClipId(id);
                setPanels({ bottomTab: "pianoRoll" });
              }}
            >
              <Icon name="piano" size={13} />
              Open Piano Roll
            </button>
          </div>
        </>
      ) : null}
    </Section>
  );
}
