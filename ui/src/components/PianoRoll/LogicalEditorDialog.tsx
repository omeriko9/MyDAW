/**
 * Logical Editor dialog — Cubase-style rule editor over the active MIDI clip.
 * openLogicalEditor() renders an imperative modal (confirmDialog root pattern):
 * preset dropdown, filter rows (ANDed), mode, action rows; Apply runs the program
 * via lib/logicalEditor on the current note selection (or the whole clip when
 * nothing is selected) and stays open for repeated application.
 */

import React, { useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { Modal } from "../common/Modal";
import { Icon } from "../common/icons";
import { showToast } from "../common/ToastHost";
import { useStore } from "../../store/store";
import { editNotes } from "../../store/actions";
import { isMidiClip, type MidiClip, type Note } from "../../protocol/types";
import {
  LE_PRESETS,
  applyLogicalEditor,
  type LeAction,
  type LeCondition,
  type LeFilter,
  type LeMode,
  type LeProgram,
  type LeProperty,
} from "../../lib/logicalEditor";
import "../Dialogs/dialogs.css";

const FILTER_PROPS: Array<{ value: LeProperty; label: string }> = [
  { value: "pitch", label: "Pitch" },
  { value: "pitchClass", label: "Pitch class (0=C)" },
  { value: "velocity", label: "Velocity" },
  { value: "startBeat", label: "Position (beats)" },
  { value: "lengthBeats", label: "Length (beats)" },
  { value: "channel", label: "Channel" },
  { value: "index", label: "Note index" },
];

const CONDS: Array<{ value: LeCondition; label: string; args: 0 | 1 | 2 }> = [
  { value: "eq", label: "=", args: 1 },
  { value: "ne", label: "≠", args: 1 },
  { value: "lt", label: "<", args: 1 },
  { value: "gt", label: ">", args: 1 },
  { value: "le", label: "≤", args: 1 },
  { value: "ge", label: "≥", args: 1 },
  { value: "inRange", label: "in range", args: 2 },
  { value: "outsideRange", label: "outside range", args: 2 },
  { value: "even", label: "is even", args: 0 },
  { value: "odd", label: "is odd", args: 0 },
  { value: "modEq", label: "mod A = B", args: 2 },
];

const ACTION_PROPS: Array<{ value: LeAction["prop"]; label: string }> = [
  { value: "pitch", label: "Pitch" },
  { value: "velocity", label: "Velocity" },
  { value: "startBeat", label: "Position" },
  { value: "lengthBeats", label: "Length" },
  { value: "channel", label: "Channel" },
];

const ACTION_OPS: Array<{ value: LeAction["op"]; label: string; args: 1 | 2 }> = [
  { value: "set", label: "set to", args: 1 },
  { value: "add", label: "add", args: 1 },
  { value: "mul", label: "multiply by", args: 1 },
  { value: "random", label: "add random", args: 2 },
];

let reactRoot: Root | null = null;
let openFlag = false;
let seq = 0;

function ensureRoot(): Root {
  if (!reactRoot) {
    const host = document.createElement("div");
    host.id = "mydaw-logical-editor-root";
    document.body.appendChild(host);
    reactRoot = createRoot(host);
  }
  return reactRoot;
}

export function openLogicalEditor(): void {
  if (openFlag) return;
  openFlag = true;
  ensureRoot().render(<LogicalEditorModal key={++seq} onClose={close} />);
}

function close(): void {
  openFlag = false;
  ensureRoot().render(null);
}

/** Active MIDI clip + the notes the program will run over (selection first). */
function targetNotes(): { clip: MidiClip; notes: Note[] } | null {
  const st = useStore.getState();
  const proj = st.project;
  const clipId = st.activeMidiClipId;
  if (!proj || clipId == null) return null;
  for (const t of [...proj.tracks, proj.masterTrack]) {
    for (const c of t.clips) {
      if (c.id === clipId && isMidiClip(c)) {
        const sel = st.selection.noteIds;
        const notes =
          sel.length > 0 ? c.notes.filter((n) => sel.includes(n.id)) : [...c.notes];
        return { clip: c, notes };
      }
    }
  }
  return null;
}

function LogicalEditorModal({ onClose }: { onClose: () => void }) {
  const [program, setProgram] = useState<LeProgram>({
    mode: "transform",
    filters: [{ prop: "velocity", cond: "lt", value: 30 }],
    actions: [{ prop: "velocity", op: "set", value: 64 }],
  });
  const [presetIdx, setPresetIdx] = useState<number>(-1);
  const [status, setStatus] = useState<string | null>(null);

  const patchFilter = (i: number, patch: Partial<LeFilter>) =>
    setProgram((p) => ({
      ...p,
      filters: p.filters.map((f, k) => (k === i ? { ...f, ...patch } : f)),
    }));
  const patchAction = (i: number, patch: Partial<LeAction>) =>
    setProgram((p) => ({
      ...p,
      actions: p.actions.map((a, k) => (k === i ? { ...a, ...patch } : a)),
    }));

  const apply = () => {
    const target = targetNotes();
    if (!target) {
      setStatus("Open a MIDI clip in the piano roll first.");
      return;
    }
    if (target.notes.length === 0) {
      setStatus("The clip has no notes to run on.");
      return;
    }
    const r = applyLogicalEditor(target.notes, program);
    if (program.mode === "select") {
      useStore.getState().setSelection({ noteIds: r.matchedIds });
      setStatus(`Selected ${r.matchedIds.length} of ${target.notes.length} notes.`);
      return;
    }
    const updates = r.patch.update?.length ?? 0;
    const removes = r.patch.remove?.length ?? 0;
    if (updates === 0 && removes === 0) {
      setStatus(`Matched ${r.matchedIds.length} notes — nothing changed.`);
      return;
    }
    void editNotes(target.clip.id, r.patch)
      .then(() =>
        setStatus(
          program.mode === "delete"
            ? `Deleted ${removes} of ${target.notes.length} notes.`
            : `Updated ${updates} of ${target.notes.length} notes.`,
        ),
      )
      .catch(() => showToast("Logical Editor apply failed", "info"));
  };

  const num = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? "" : String(v));
  const parse = (t: string) => (t === "" ? undefined : Number(t));

  return (
    <Modal
      open
      onClose={onClose}
      title="Logical Editor"
      width={560}
      draggable
      footer={
        <>
          {status !== null && <span className="dim grow le-status">{status}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn primary" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <div className="dlg-fields">
        <label className="dlg-field">
          <span className="dlg-field-label">Preset</span>
          <select
            value={String(presetIdx)}
            onChange={(e) => {
              const i = Number(e.target.value);
              setPresetIdx(i);
              if (i >= 0) {
                // deep-copy so row edits never mutate the preset library
                setProgram(JSON.parse(JSON.stringify(LE_PRESETS[i].program)) as LeProgram);
                setStatus(null);
              }
            }}
          >
            <option value="-1">(custom)</option>
            {LE_PRESETS.map((p, i) => (
              <option key={p.name} value={String(i)}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <div className="dlg-subhead">Filters (all must match — empty list matches every note)</div>
        {program.filters.map((f, i) => {
          const cond = CONDS.find((c) => c.value === f.cond) ?? CONDS[0];
          return (
            <div key={i} className="le-row">
              <select
                value={f.prop}
                onChange={(e) => patchFilter(i, { prop: e.target.value as LeProperty })}
              >
                {FILTER_PROPS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <select
                value={f.cond}
                onChange={(e) => patchFilter(i, { cond: e.target.value as LeCondition })}
              >
                {CONDS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {cond.args >= 1 && (
                <input
                  type="number"
                  value={num(f.value)}
                  onChange={(e) => patchFilter(i, { value: parse(e.target.value) })}
                />
              )}
              {cond.args >= 2 && (
                <input
                  type="number"
                  value={num(f.value2)}
                  onChange={(e) => patchFilter(i, { value2: parse(e.target.value) })}
                />
              )}
              <button
                type="button"
                className="btn-icon"
                title="Remove filter"
                onClick={() =>
                  setProgram((p) => ({ ...p, filters: p.filters.filter((_, k) => k !== i) }))
                }
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
        <div>
          <button
            type="button"
            className="btn"
            onClick={() =>
              setProgram((p) => ({
                ...p,
                filters: [...p.filters, { prop: "pitch", cond: "eq", value: 60 }],
              }))
            }
          >
            <Icon name="plus" size={12} /> Add Filter
          </button>
        </div>

        <label className="dlg-field">
          <span className="dlg-field-label">Then</span>
          <select
            value={program.mode}
            onChange={(e) => setProgram((p) => ({ ...p, mode: e.target.value as LeMode }))}
          >
            <option value="transform">Transform the matches</option>
            <option value="delete">Delete the matches</option>
            <option value="select">Select the matches</option>
          </select>
        </label>

        {program.mode === "transform" && (
          <>
            <div className="dlg-subhead">Actions (applied in order)</div>
            {program.actions.map((a, i) => {
              const op = ACTION_OPS.find((o) => o.value === a.op) ?? ACTION_OPS[0];
              return (
                <div key={i} className="le-row">
                  <select
                    value={a.prop}
                    onChange={(e) => patchAction(i, { prop: e.target.value as LeAction["prop"] })}
                  >
                    {ACTION_PROPS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <select
                    value={a.op}
                    onChange={(e) => patchAction(i, { op: e.target.value as LeAction["op"] })}
                  >
                    {ACTION_OPS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    value={num(a.value)}
                    onChange={(e) => patchAction(i, { value: parse(e.target.value) ?? 0 })}
                  />
                  {op.args >= 2 && (
                    <input
                      type="number"
                      value={num(a.value2)}
                      onChange={(e) => patchAction(i, { value2: parse(e.target.value) })}
                    />
                  )}
                  <button
                    type="button"
                    className="btn-icon"
                    title="Remove action"
                    onClick={() =>
                      setProgram((p) => ({ ...p, actions: p.actions.filter((_, k) => k !== i) }))
                    }
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              );
            })}
            <div>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setProgram((p) => ({
                    ...p,
                    actions: [...p.actions, { prop: "velocity", op: "add", value: 10 }],
                  }))
                }
              >
                <Icon name="plus" size={12} /> Add Action
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
