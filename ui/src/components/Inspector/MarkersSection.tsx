/**
 * Inspector MARKERS section (U5): marker list (jump / rename / delete) + add at playhead.
 */

import React, { useState } from "react";
import type { Project } from "../../protocol/types";
import { transportBus } from "../../store/store";
import { addMarker, locate, removeMarker, setMarker } from "../../store/actions";
import { formatBarsBeats } from "../../lib/time";
import { Section } from "./Section";
import { errText } from "./fields";
import { TextInput } from "../common/TextInput";
import { IconButton } from "../common/IconButton";
import { Icon } from "../common/icons";

export function MarkersSection({ project }: { project: Project }) {
  const [err, setErr] = useState<string | null>(null);
  const markers = [...project.markers].sort((a, b) => a.beat - b.beat);

  const addAtPlayhead = () => {
    const beat = transportBus.last?.beat ?? 0;
    // Number off the highest existing "Marker N", not off the count — after a delete the
    // count reuses a suffix that is still on screen (two rows both reading "Marker 3").
    const n =
      project.markers.reduce((mx, m) => {
        const k = /^Marker (\d+)$/.exec(m.name);
        return k ? Math.max(mx, Number(k[1])) : mx;
      }, project.markers.length) + 1;
    void addMarker(beat, `Marker ${n}`).catch((e) => setErr(errText(e)));
  };

  return (
    <Section
      title="Markers"
      defaultOpen={markers.length > 0}
      badge={<span className="badge">{markers.length}</span>}
    >
      {markers.length > 0 ? (
        <div className="insp-list">
          {markers.map((m) => (
            <div className="insp-item" key={m.id}>
              <IconButton
                icon="play"
                size={20}
                tooltip="Jump to marker"
                onClick={() => void locate(m.beat)}
              />
              <span
                className="mono dim"
                style={{ flex: "0 0 auto", fontSize: 11 }}
                title="Position (bars.beats.ticks)"
              >
                {formatBarsBeats(m.beat, project.timeSigMap)}
              </span>
              <TextInput
                className="grow"
                style={{ height: 20, fontSize: 11 }}
                value={m.name}
                onCommit={(v) => {
                  if (v.trim().length > 0) void setMarker(m.id, { name: v.trim() });
                }}
              />
              <IconButton
                icon="trash"
                size={20}
                danger
                tooltip="Delete marker"
                onClick={() => void removeMarker(m.id).catch((e) => setErr(errText(e)))}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="insp-hint">No markers.</div>
      )}
      <div className="insp-row">
        <button type="button" className="btn" onClick={addAtPlayhead}>
          <Icon name="marker" size={13} />
          Add at playhead
        </button>
      </div>
      {err ? <div className="insp-error">{err}</div> : null}
    </Section>
  );
}
