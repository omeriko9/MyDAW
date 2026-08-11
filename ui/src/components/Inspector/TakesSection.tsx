/**
 * Inspector VERSIONS section (U5) — take folders for the selected track.
 *
 * One strip per version, each showing its clips; clicking a clip makes that version the one
 * you hear (its overlapping siblings mute — cmd/take.pick). Combinations are built with the
 * mute tool on the arrangement, not here. "Flatten" collapses the folder back to plain clips,
 * keeping whatever is currently unmuted. When >=2 clips are selected on the track, offers
 * "Create take folder" to stack them.
 */

import React from "react";
import type { Project, TakeFolder, Track } from "../../protocol/types";
import { useStore } from "../../store/store";
import { Section } from "./Section";
import { createTakeFolder, flattenTake, pickTake } from "../../store/actions";
import { errText } from "./fields";
import { Icon } from "../common/icons";
import { contextMenuHandler } from "../common/ContextMenu";
import { LANE_COLORS } from "../../lib/comping";
import { clipLengthBeats } from "../Timeline/layout";

function FolderView({ track, folder, project }: { track: Track; folder: TakeFolder; project: Project }) {
  const [err, setErr] = React.useState<string | null>(null);
  const span = Math.max(1e-6, folder.endBeat - folder.startBeat);
  const pct = (beat: number) => `${(((beat - folder.startBeat) / span) * 100).toFixed(3)}%`;

  return (
    <div className="takes-folder">
      <div className="insp-row" style={{ marginBottom: 2 }}>
        <span className="insp-item-name" title={folder.name}>
          {folder.name}
        </span>
        <span className="faint mono">{folder.lanes.length} versions</span>
        <span className="grow" />
        <button
          type="button"
          className="btn"
          title="Collapse to plain clips, keeping the versions you can hear"
          onClick={() => void flattenTake(track.id, folder.id).catch((er) => setErr(errText(er)))}
        >
          <Icon name="export" size={12} /> Flatten
        </button>
      </div>

      {/* one strip per version; a clip you can hear is solid, a muted one is faded */}
      {folder.lanes.map((ln, li) => (
        <div className="takes-lane" key={ln.id}>
          <span className="takes-lane-name" title={ln.name}>
            {ln.name}
          </span>
          <div
            className="takes-strip"
            onContextMenu={contextMenuHandler(() => [
              {
                label: "Flatten Versions…",
                icon: "export",
                title: "Collapse to plain clips, keeping the versions you can hear",
                onClick: () =>
                  void flattenTake(track.id, folder.id).catch((er) => setErr(errText(er))),
              },
            ])}
            title="Click a clip to make that version the one you hear"
          >
            {ln.clips.map((c) => (
              <div
                key={c.id}
                className="takes-strip-active"
                role="button"
                tabIndex={0}
                onClick={() =>
                  void pickTake(track.id, c.id).catch((er) => setErr(errText(er)))
                }
                style={{
                  left: pct(c.startBeat),
                  width: `${((Math.max(1e-6, clipLengthBeats(c, project.tempoMap, project.sampleRate)) / span) * 100).toFixed(3)}%`,
                  background: LANE_COLORS[li % LANE_COLORS.length],
                  opacity: c.muted === true ? 0.28 : 1,
                  cursor: "pointer",
                }}
                title={c.muted === true ? `${ln.name} (muted) — click to hear this version` : ln.name}
              />
            ))}
          </div>
        </div>
      ))}
      {err ? <div className="insp-error">{err}</div> : null}
    </div>
  );
}

export function TakesSection({ track, project }: { track: Track; project: Project }) {
  const selection = useStore((s) => s.selection);
  const [err, setErr] = React.useState<string | null>(null);
  const folders = track.takeFolders ?? [];
  // Clips of THIS track that are currently selected — the candidates to stack into a folder.
  const selClipIds = track.clips.filter((c) => selection.clipIds.includes(c.id)).map((c) => c.id);
  const canCreate = selClipIds.length >= 2;

  if (folders.length === 0 && !canCreate) return null;

  return (
    <Section title="Takes / Comp" badge={folders.length ? <span className="badge">{folders.length}</span> : undefined}>
      {canCreate ? (
        <div className="insp-row">
          <button
            type="button"
            className="btn"
            title="Stack the selected clips as takes in one comp folder"
            onClick={() =>
              void createTakeFolder(track.id, selClipIds).catch((e) => setErr(errText(e)))
            }
          >
            <Icon name="plus" size={13} /> Create take folder ({selClipIds.length})
          </button>
        </div>
      ) : null}
      {folders.map((f) => (
        <FolderView key={f.id} track={track} folder={f} project={project} />
      ))}
      {folders.length === 0 ? (
        <div className="insp-hint">Select 2+ clips on this track and stack them as takes.</div>
      ) : null}
      {err ? <div className="insp-error">{err}</div> : null}
    </Section>
  );
}
