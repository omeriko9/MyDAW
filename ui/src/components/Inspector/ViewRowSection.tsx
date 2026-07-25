/**
 * Inspector section for VIEW-ROW tracks (TRACK_TYPES_PLAN §3.5-3.8): the selected
 * marker/arranger/chord/transpose lane edits its project-level data here.
 *  - arranger: sections list + the CHAIN EDITOR (ordered list, move up/down, remove,
 *    append, activate, flatten) — the canvas lane shows blocks, this is where the
 *    chain is arranged.
 *  - chord / transpose: event lists (jump / edit / delete).
 *  - marker: points to the existing Markers section below (single source of truth).
 */

import React, { useState } from "react";
import type { Project, Track } from "../../protocol/types";
import {
  addArrangerSection,
  flattenArranger,
  locate,
  removeArrangerSection,
  removeChord,
  removeTranspose,
  setArrangerChain,
  setArrangerSection,
  setChord,
  setTranspose,
} from "../../store/actions";
import { transportBus } from "../../store/store";
import { formatBarsBeats } from "../../lib/time";
import { chordLabel } from "../Timeline/viewRows";
import { Section } from "./Section";
import { errText } from "./fields";
import { TextInput } from "../common/TextInput";
import { IconButton } from "../common/IconButton";
import { Toggle } from "../common/Toggle";
import { confirmDialog } from "../Dialogs/confirm";

export function ViewRowSection({ track, project }: { track: Track; project: Project }) {
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => void p.catch((e) => setErr(errText(e)));

  if (track.kind === "marker") {
    return (
      <Section title="Marker Track">
        <div className="insp-hint">
          Markers live at project level — edit them in the Markers section below, or
          directly on the lane (double-click adds, drag moves, Alt+double-click adds a
          cycle marker).
        </div>
      </Section>
    );
  }

  if (track.kind === "chord") {
    const chords = project.chordEvents ?? [];
    return (
      <Section title="Chord Track" badge={<span className="badge">{chords.length}</span>}>
        {chords.length > 0 ? (
          <div className="insp-list">
            {chords.map((c) => (
              <div className="insp-item" key={c.id}>
                <IconButton icon="play" size={20} tooltip="Jump to chord" onClick={() => void locate(c.beat)} />
                <span className="mono dim" style={{ flex: "0 0 auto", fontSize: 11 }}>
                  {formatBarsBeats(c.beat, project.timeSigMap)}
                </span>
                <span className="insp-item-name">{chordLabel(c)}</span>
                <TextInput
                  style={{ height: 20, fontSize: 11, width: 44 }}
                  value={c.tensions ?? ""}
                  placeholder="ten."
                  onCommit={(v) => run(setChord(c.id, { tensions: v.trim() }))}
                />
                <IconButton icon="trash" size={20} danger tooltip="Delete chord" onClick={() => run(removeChord(c.id))} />
              </div>
            ))}
          </div>
        ) : (
          <div className="insp-hint">No chords — double-click the chord lane to add one.</div>
        )}
        {err ? <div className="insp-error">{err}</div> : null}
      </Section>
    );
  }

  if (track.kind === "transpose") {
    const events = project.transposeEvents ?? [];
    return (
      <Section title="Transpose Track" badge={<span className="badge">{events.length}</span>}>
        {events.length > 0 ? (
          <div className="insp-list">
            {events.map((t) => (
              <div className="insp-item" key={t.id}>
                <IconButton icon="play" size={20} tooltip="Jump to event" onClick={() => void locate(t.beat)} />
                <span className="mono dim" style={{ flex: "0 0 auto", fontSize: 11 }}>
                  {formatBarsBeats(t.beat, project.timeSigMap)}
                </span>
                <TextInput
                  style={{ height: 20, fontSize: 11, width: 44 }}
                  value={String(t.semitones)}
                  onCommit={(v) => {
                    const n = Math.round(Number(v));
                    if (Number.isFinite(n)) run(setTranspose(t.id, { semitones: Math.max(-24, Math.min(24, n)) }));
                  }}
                />
                <span className="dim" style={{ fontSize: 11 }}>st</span>
                <span className="grow" />
                <IconButton icon="trash" size={20} danger tooltip="Delete event" onClick={() => run(removeTranspose(t.id))} />
              </div>
            ))}
          </div>
        ) : (
          <div className="insp-hint">No transpose events — double-click the lane (y = semitones).</div>
        )}
        <div className="insp-hint">
          MIDI playback shifts from each event onward; clips keep their raw pitches.
        </div>
        {err ? <div className="insp-error">{err}</div> : null}
      </Section>
    );
  }

  /* ---- arranger ---- */
  const a = project.arranger ?? { sections: [], chain: [], activeChain: false };
  const sectionById = new Map(a.sections.map((s) => [s.id, s]));
  const setChain = (chain: number[]) => run(setArrangerChain({ chain }));

  return (
    <Section title="Arranger" badge={<span className="badge">{a.sections.length} sections</span>}>
      <div className="insp-row">
        <span className="insp-label">Sections</span>
        <span className="grow" />
        <IconButton
          icon="plus"
          tooltip="Add a section at the playhead (4 beats)"
          onClick={() => {
            const beat = transportBus.last?.beat ?? 0;
            run(addArrangerSection({ startBeat: beat, endBeat: beat + 4 }));
          }}
        />
      </div>
      {a.sections.length > 0 ? (
        <div className="insp-list">
          {a.sections.map((s) => (
            <div className="insp-item" key={s.id}>
              <IconButton icon="play" size={20} tooltip="Jump to section" onClick={() => void locate(s.startBeat)} />
              <TextInput
                className="grow"
                style={{ height: 20, fontSize: 11 }}
                value={s.name}
                onCommit={(v) => {
                  if (v.trim()) run(setArrangerSection(s.id, { name: v.trim() }));
                }}
              />
              <IconButton
                icon="plus"
                size={20}
                tooltip="Append to chain"
                onClick={() => setChain([...a.chain, s.id])}
              />
              <IconButton
                icon="trash"
                size={20}
                danger
                tooltip="Delete section"
                onClick={() => run(removeArrangerSection(s.id))}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="insp-hint">No sections — double-click the arranger lane to add one.</div>
      )}

      <div className="insp-row">
        <span className="insp-label">Chain</span>
        <span className="grow" />
        <Toggle
          on={a.activeChain === true}
          onChange={(on) => run(setArrangerChain({ active: on, locateToStart: on }))}
          variant="ok"
          icon="play"
          tooltip={a.activeChain ? "Chain active — playback follows it (deactivate to play linearly)" : "Activate the chain (playback jumps section-to-section; overrides the loop)"}
        />
      </div>
      {a.chain.length > 0 ? (
        <div className="insp-list">
          {a.chain.map((id, i) => {
            const s = sectionById.get(id);
            return (
              <div className="insp-item" key={`${id}-${i}`}>
                <span className="faint mono" style={{ flex: "0 0 auto" }}>{i + 1}</span>
                <span className="insp-item-name">{s ? s.name : `#${id} (missing)`}</span>
                <IconButton
                  icon="chevronUp"
                  size={20}
                  tooltip="Move up"
                  disabled={i === 0}
                  onClick={() => {
                    const c = [...a.chain];
                    [c[i - 1], c[i]] = [c[i], c[i - 1]];
                    setChain(c);
                  }}
                />
                <IconButton
                  icon="chevronDown"
                  size={20}
                  tooltip="Move down"
                  disabled={i === a.chain.length - 1}
                  onClick={() => {
                    const c = [...a.chain];
                    [c[i], c[i + 1]] = [c[i + 1], c[i]];
                    setChain(c);
                  }}
                />
                <IconButton
                  icon="x"
                  size={20}
                  tooltip="Remove this step"
                  onClick={() => setChain(a.chain.filter((_, k) => k !== i))}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="insp-hint">Empty chain — append sections with the ＋ buttons above.</div>
      )}

      <div className="insp-row gap1">
        <button
          type="button"
          className="btn"
          disabled={a.chain.length === 0}
          title="Rebuild the timeline as the chain plays, then clear sections + chain"
          onClick={() => {
            void confirmDialog({
              title: "Flatten arranger chain",
              message:
                "Rebuild the timeline as the chain plays (windowed clip copies per section), then clear the sections and chain? This can be undone.",
              confirmLabel: "Flatten",
            }).then((ok) => {
              if (ok) run(flattenArranger());
            });
          }}
        >
          Flatten Chain
        </button>
        <button
          type="button"
          className="btn"
          disabled={a.chain.length === 0}
          onClick={() => setChain([])}
        >
          Clear Chain
        </button>
      </div>
      {err ? <div className="insp-error">{err}</div> : null}
    </Section>
  );
}
