/**
 * ScriptsManager (Increment 5 follow-up) — a modal to view, use, add, edit, duplicate, and
 * delete prepared agent scripts. Embedded starter scripts (from prompts.gen.ts) are
 * read-only but duplicatable; custom scripts persist per-user to settings.llm.customScriptsJson.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Modal } from "../common/Modal";
import { TextInput } from "../common/TextInput";
import { AGENT_PROMPTS } from "../../agent/prompts.gen";
import { getSettings, setSettings } from "../../store/actions";
import {
  parseCustomScripts,
  stringifyCustomScripts,
  type CustomScript,
} from "../../agent/agentPersistence";

interface Props {
  onClose: () => void;
  onUse: (prompt: string) => void;
}

function makeId(): string {
  try {
    return `c-${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `c-${Date.now()}`;
  }
}

type Selected = { source: "embedded" | "custom"; id: string } | null;

export function ScriptsManager({ onClose, onUse }: Props) {
  const [custom, setCustom] = useState<CustomScript[]>([]);
  const [selected, setSelected] = useState<Selected>(null);
  const [draft, setDraft] = useState<CustomScript | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((s) => {
        if (!alive) return;
        const llm = (s as { llm?: unknown }).llm;
        const raw =
          llm && typeof llm === "object"
            ? (llm as { customScriptsJson?: unknown }).customScriptsJson
            : undefined;
        setCustom(parseCustomScripts(raw));
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const persist = (next: CustomScript[]) => {
    setCustom(next);
    setSettings({ llm: { customScriptsJson: stringifyCustomScripts(next) } } as never).catch(
      (e) => setErr(e instanceof Error ? e.message : String(e)),
    );
  };

  const embedded = AGENT_PROMPTS;
  const current = useMemo(() => {
    if (!selected) return null;
    if (selected.source === "embedded")
      return embedded.find((s) => s.id === selected.id) ?? null;
    return custom.find((s) => s.id === selected.id) ?? null;
  }, [selected, custom, embedded]);

  const isCustom = selected?.source === "custom";

  const startNew = () => {
    const s: CustomScript = { id: makeId(), title: "New script", category: "custom", prompt: "" };
    persist([...custom, s]);
    setSelected({ source: "custom", id: s.id });
    setDraft(s);
  };

  const duplicate = (from: { title: string; category: string; prompt: string }) => {
    const s: CustomScript = {
      id: makeId(),
      title: `${from.title} (copy)`,
      category: from.category,
      prompt: from.prompt,
    };
    persist([...custom, s]);
    setSelected({ source: "custom", id: s.id });
    setDraft(s);
  };

  const saveDraft = () => {
    if (!draft) return;
    if (!draft.prompt.trim()) {
      setErr("prompt cannot be empty");
      return;
    }
    setErr(null);
    persist(custom.map((s) => (s.id === draft.id ? draft : s)));
  };

  const remove = (id: string) => {
    persist(custom.filter((s) => s.id !== id));
    setSelected(null);
    setDraft(null);
  };

  const selectScript = (source: "embedded" | "custom", id: string) => {
    setSelected({ source, id });
    setErr(null);
    if (source === "custom") {
      const s = custom.find((x) => x.id === id) ?? null;
      setDraft(s ? { ...s } : null);
    } else {
      setDraft(null);
    }
  };

  return (
    <Modal open onClose={onClose} title="Prepared scripts" width={720}>
      <div className="scripts-mgr">
        <div className="scripts-mgr-list">
          <button type="button" className="btn primary scripts-mgr-new" onClick={startNew}>
            + New script
          </button>
          <div className="scripts-mgr-group">Embedded</div>
          {embedded.map((s) => (
            <button
              key={s.id}
              type="button"
              className={"scripts-mgr-item" + (selected?.source === "embedded" && selected.id === s.id ? " sel" : "")}
              onClick={() => selectScript("embedded", s.id)}
            >
              <span>{s.title}</span>
              <span className="scripts-mgr-cat">{s.category}</span>
            </button>
          ))}
          <div className="scripts-mgr-group">Custom</div>
          {custom.length === 0 ? (
            <div className="scripts-mgr-empty">No custom scripts yet.</div>
          ) : (
            custom.map((s) => (
              <button
                key={s.id}
                type="button"
                className={"scripts-mgr-item" + (selected?.source === "custom" && selected.id === s.id ? " sel" : "")}
                onClick={() => selectScript("custom", s.id)}
              >
                <span>{s.title}</span>
                <span className="scripts-mgr-cat">{s.category}</span>
              </button>
            ))
          )}
        </div>

        <div className="scripts-mgr-detail">
          {!current ? (
            <div className="scripts-mgr-empty">Select a script, or create a new one.</div>
          ) : isCustom && draft ? (
            <div className="col gap2">
              <label className="scripts-mgr-field">
                <span>Title</span>
                <TextInput value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} width="100%" />
              </label>
              <label className="scripts-mgr-field">
                <span>Category</span>
                <TextInput value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} width="100%" />
              </label>
              <label className="scripts-mgr-field">
                <span>Prompt</span>
                <textarea
                  className="scripts-mgr-prompt"
                  value={draft.prompt}
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                  rows={8}
                />
              </label>
              {err ? <div className="sett-error">{err}</div> : null}
              <div className="row gap1">
                <button type="button" className="btn primary" onClick={saveDraft}>Save</button>
                <button type="button" className="btn" onClick={() => onUse(draft.prompt)}>Use</button>
                <button type="button" className="btn" onClick={() => duplicate(draft)}>Duplicate</button>
                <span className="scripts-mgr-spacer" />
                <button type="button" className="btn danger" onClick={() => remove(draft.id)}>Delete</button>
              </div>
            </div>
          ) : (
            <div className="col gap2">
              <div className="scripts-mgr-title">{current.title}</div>
              <div className="scripts-mgr-cat">{current.category} · read-only</div>
              <pre className="scripts-mgr-view">{current.prompt}</pre>
              <div className="row gap1">
                <button type="button" className="btn primary" onClick={() => onUse(current.prompt)}>Use</button>
                <button type="button" className="btn" onClick={() => duplicate(current)}>Duplicate to custom</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
