/**
 * Inspector TAKES section (U5) — comping for the selected track.
 *
 * Shows each take folder as a comp bar plus one strip per take (lane). Click a take strip to
 * make that take play for the whole folder; drag ("swipe") across a take strip to assign just
 * that beat-range to the take — the classic comp gesture. When ≥2 clips are selected on the
 * track, offers "Create take folder" to stack them. "Flatten" bounces the comp to plain clips.
 */

import React, { useRef } from "react";
import type { Project, TakeFolder, Track } from "../../protocol/types";
import { useStore } from "../../store/store";
import { Section } from "./Section";
import { createTakeFolder, flattenTake, setTakeActiveLane, setTakeComp } from "../../store/actions";
import { errText } from "./fields";
import { Icon } from "../common/icons";
import { contextMenuHandler } from "../common/ContextMenu";

interface Seg {
  s: number;
  e: number;
  lane: number;
}

/** Comp boundaries → concrete [s,e) segments (mirrors AudioGraph::buildPlan). */
function compSegments(f: TakeFolder): Seg[] {
  const segs: Seg[] = [];
  const fs = f.startBeat;
  const fe = f.endBeat;
  if (!f.comp || f.comp.length === 0) {
    if (f.lanes.length) segs.push({ s: fs, e: fe, lane: 0 });
    return segs;
  }
  for (let i = 0; i < f.comp.length; i++) {
    const s = i === 0 ? fs : Math.max(f.comp[i].startBeat, fs);
    let e = i + 1 < f.comp.length ? Math.max(f.comp[i + 1].startBeat, s) : fe;
    e = Math.min(e, fe);
    if (e > s) segs.push({ s, e, lane: f.comp[i].lane });
  }
  return segs;
}

function laneAt(f: TakeFolder, beat: number): number {
  if (!f.comp || f.comp.length === 0) return 0;
  let lane = f.comp[0].lane;
  for (const s of f.comp) {
    if (beat >= s.startBeat) lane = s.lane;
    else break;
  }
  return lane;
}

/** Paint [b0,b1) with `lane`, preserving what played before b0 and restoring at b1. */
function paintComp(
  f: TakeFolder,
  b0: number,
  b1: number,
  lane: number,
): { startBeat: number; lane: number }[] {
  const fs = f.startBeat;
  const fe = f.endBeat;
  let lo = Math.max(fs, Math.min(b0, fe));
  let hi = Math.max(fs, Math.min(b1, fe));
  if (hi < lo) [lo, hi] = [hi, lo];
  const src = f.comp && f.comp.length ? f.comp : [{ startBeat: fs, lane: 0 }];
  const laneAfter = laneAt(f, hi);
  const pts: { startBeat: number; lane: number }[] = [];
  for (const s of src) if (s.startBeat < lo - 1e-6) pts.push({ startBeat: s.startBeat, lane: s.lane });
  if (pts.length === 0) pts.push({ startBeat: fs, lane: laneAt(f, fs) });
  pts.push({ startBeat: lo, lane });
  if (fe - hi > 1e-6) pts.push({ startBeat: hi, lane: laneAfter });
  for (const s of src) if (s.startBeat > hi + 1e-6) pts.push({ startBeat: s.startBeat, lane: s.lane });
  pts.sort((a, b) => a.startBeat - b.startBeat);
  // Drop redundant consecutive same-lane boundaries; anchor the first to the folder start.
  const out: { startBeat: number; lane: number }[] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1].lane === p.lane) continue;
    out.push(p);
  }
  if (out.length) out[0] = { startBeat: fs, lane: out[0].lane };
  return out;
}

const LANE_COLORS = ["#4f8cff", "#28c07a", "#e0a533", "#c96be0", "#e0605f", "#33bcd6"];

function FolderView({ track, folder }: { track: Track; folder: TakeFolder }) {
  const [err, setErr] = React.useState<string | null>(null);
  const span = Math.max(1e-6, folder.endBeat - folder.startBeat);
  const pct = (beat: number) => `${(((beat - folder.startBeat) / span) * 100).toFixed(3)}%`;
  const segs = compSegments(folder);
  const stripRefs = useRef<(HTMLDivElement | null)[]>([]);
  const down = useRef<{ lane: number; x: number } | null>(null);

  const beatAtClientX = (laneIdx: number, clientX: number): number => {
    const el = stripRefs.current[laneIdx];
    if (!el) return folder.startBeat;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    return folder.startBeat + f * span;
  };

  const onLaneDown = (laneIdx: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return; // right-click opens the context menu instead
    e.currentTarget.setPointerCapture(e.pointerId);
    down.current = { lane: laneIdx, x: e.clientX };
  };
  const onLaneUp = (laneIdx: number) => (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || d.lane !== laneIdx) return;
    const moved = Math.abs(e.clientX - d.x) > 4;
    if (!moved) {
      // Click = select this take for the whole folder.
      void setTakeActiveLane(track.id, folder.id, laneIdx).catch((er) => setErr(errText(er)));
      return;
    }
    const b0 = beatAtClientX(laneIdx, d.x);
    const b1 = beatAtClientX(laneIdx, e.clientX);
    void setTakeComp(track.id, folder.id, paintComp(folder, b0, b1, laneIdx)).catch((er) =>
      setErr(errText(er)),
    );
  };

  return (
    <div className="takes-folder">
      <div className="insp-row" style={{ marginBottom: 2 }}>
        <span className="insp-item-name" title={folder.name}>
          {folder.name}
        </span>
        <span className="faint mono">{folder.lanes.length} takes</span>
        <span className="grow" />
        <button
          type="button"
          className="btn"
          title="Bounce the comp to plain clips and remove the folder"
          onClick={() => void flattenTake(track.id, folder.id).catch((er) => setErr(errText(er)))}
        >
          <Icon name="export" size={12} /> Flatten
        </button>
      </div>

      {/* comp result bar */}
      <div className="takes-comp" title="Current comp (colored by take)">
        {segs.map((sg, i) => (
          <div
            key={i}
            className="takes-comp-seg"
            style={{
              left: pct(sg.s),
              width: `${(((sg.e - sg.s) / span) * 100).toFixed(3)}%`,
              background: sg.lane >= 0 ? LANE_COLORS[sg.lane % LANE_COLORS.length] : "transparent",
            }}
          />
        ))}
      </div>

      {/* one strip per take; highlighted where that take is comped in */}
      {folder.lanes.map((ln, li) => (
        <div className="takes-lane" key={ln.id}>
          <span className="takes-lane-name" title={ln.name}>
            {ln.name}
          </span>
          <div
            className="takes-strip"
            ref={(el) => {
              stripRefs.current[li] = el;
            }}
            onPointerDown={onLaneDown(li)}
            onPointerUp={onLaneUp(li)}
            onContextMenu={contextMenuHandler(() => [
              {
                label: "Use This Take",
                title: "Select this take for the whole folder",
                onClick: () =>
                  void setTakeActiveLane(track.id, folder.id, li).catch((er) =>
                    setErr(errText(er)),
                  ),
              },
              {
                label: "Flatten Comp…",
                icon: "export",
                title: "Bounce the comp to plain clips and remove the folder",
                onClick: () =>
                  void flattenTake(track.id, folder.id).catch((er) => setErr(errText(er))),
              },
            ])}
            title="Click to use this take; drag to swipe just part of it into the comp"
          >
            {segs
              .filter((sg) => sg.lane === li)
              .map((sg, i) => (
                <div
                  key={i}
                  className="takes-strip-active"
                  style={{
                    left: pct(sg.s),
                    width: `${(((sg.e - sg.s) / span) * 100).toFixed(3)}%`,
                    background: LANE_COLORS[li % LANE_COLORS.length],
                  }}
                />
              ))}
          </div>
        </div>
      ))}
      {err ? <div className="insp-error">{err}</div> : null}
    </div>
  );
}

export function TakesSection({ track }: { track: Track; project: Project }) {
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
        <FolderView key={f.id} track={track} folder={f} />
      ))}
      {folders.length === 0 ? (
        <div className="insp-hint">Select 2+ clips on this track and stack them as takes.</div>
      ) : null}
      {err ? <div className="insp-error">{err}</div> : null}
    </Section>
  );
}
