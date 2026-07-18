/**
 * AgentPanel (Increment 5) — the docked agent chat panel. Header (title / model / YOLO badge
 * / new / clear / close), a smart-scrolling transcript (user / assistant / tool rows + a live
 * streaming bubble + inline approval card), and a composer (multiline, Enter sends,
 * Shift+Enter newline, Send↔Stop, prepared-scripts menu). Hidden by default; mounted only
 * when panels.agent is true.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./agent.css";
import { isConfigReady } from "../../agent/agentConfig";
import { parseCustomScripts } from "../../agent/agentPersistence";
import { AGENT_PROMPTS } from "../../agent/prompts.gen";
import { useAgentSession, type DisplayMessage } from "../../agent/useAgentSession";
import { getSettings } from "../../store/actions";
import { useStore } from "../../store/store";
import { openContextMenu, type MenuEntry } from "../common/ContextMenu";
import { Icon } from "../common/icons";
import { IconButton } from "../common/IconButton";
import { ApprovalCard } from "./ApprovalCard";
import { ScriptsManager } from "./ScriptsManager";

function MessageRow({ message }: { message: DisplayMessage }) {
  if (message.role === "user") {
    return (
      <div className="agent-row user">
        <div className="agent-bubble">{message.content}</div>
      </div>
    );
  }
  if (message.role === "assistant") {
    const usedTools = (message.tool_calls?.length ?? 0) > 0;
    if (!message.content && !usedTools) return null;
    return (
      <div className="agent-row assistant">
        {message.content ? <div className="agent-bubble">{message.content}</div> : null}
        {usedTools ? (
          <div className="agent-tool-note">
            → {message.tool_calls!.map((t) => t.function.name).join(", ")}
          </div>
        ) : null}
      </div>
    );
  }
  if (message.role === "tool") {
    return (
      <details className={"agent-tool" + (message.error ? " error" : "")}>
        <summary>
          {message.error ? "⚠ " : "✓ "}
          {message.name ?? "tool"}
        </summary>
        <pre>{message.content}</pre>
      </details>
    );
  }
  return null;
}

export function AgentPanel() {
  const setPanels = useStore((s) => s.setPanels);
  const connected = useStore((s) => s.connected);
  const session = useAgentSession();
  const [draft, setDraft] = useState("");
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { transcript, streaming, running, config, pendingApproval, error } = session;
  const ready = config ? isConfigReady(config) : false;

  // Terminal-style input history: recall previously sent user messages with ArrowUp/Down.
  const history = useMemo(
    () =>
      transcript
        .filter((m) => m.role === "user" && typeof m.content === "string")
        .map((m) => m.content as string),
    [transcript],
  );
  const histIdxRef = useRef(-1); // -1 = editing a fresh draft; else index from newest
  const savedDraftRef = useRef("");

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  // Auto-follow only when the user is already near the bottom (smart scroll).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [transcript, streaming, pendingApproval, atBottom]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // The caret opens a quick-pick of prepared scripts (embedded + custom); choosing one sends
  // its prompt straight into the chat. The icon opens the full ScriptsManager modal.
  const openScriptsMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const toItems = (customJson: unknown): MenuEntry[] => {
      const all = [...AGENT_PROMPTS, ...parseCustomScripts(customJson)];
      return all.length
        ? all.map((sc) => ({
            label: sc.title,
            title: sc.category,
            onClick: () => void session.send(sc.prompt),
          }))
        : [{ label: "No scripts yet", disabled: true }];
    };
    getSettings()
      .then((s) => {
        const llm = (s as { llm?: unknown }).llm;
        const json =
          llm && typeof llm === "object" ? (llm as { customScriptsJson?: unknown }).customScriptsJson : undefined;
        openContextMenu(rect.left, rect.bottom + 2, toItems(json));
      })
      .catch(() => openContextMenu(rect.left, rect.bottom + 2, toItems(undefined)));
  };

  const submit = () => {
    const text = draft;
    if (!text.trim() || running) return;
    setDraft("");
    histIdxRef.current = -1;
    savedDraftRef.current = "";
    void session.send(text);
  };

  const recall = (index: number) => {
    // index: 0 = newest sent message … history.length-1 = oldest
    const msg = history[history.length - 1 - index];
    if (msg !== undefined) setDraft(msg);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    // ArrowUp on the first line recalls older messages; ArrowDown on the last line goes newer.
    const caret = ta.selectionStart;
    const onFirstLine = !draft.slice(0, caret).includes("\n");
    const onLastLine = !draft.slice(caret).includes("\n");
    if (e.key === "ArrowUp" && onFirstLine && history.length > 0) {
      e.preventDefault();
      if (histIdxRef.current === -1) savedDraftRef.current = draft;
      histIdxRef.current = Math.min(histIdxRef.current + 1, history.length - 1);
      recall(histIdxRef.current);
    } else if (e.key === "ArrowDown" && onLastLine && histIdxRef.current !== -1) {
      e.preventDefault();
      histIdxRef.current -= 1;
      if (histIdxRef.current < 0) {
        histIdxRef.current = -1;
        setDraft(savedDraftRef.current);
      } else {
        recall(histIdxRef.current);
      }
    }
  };

  const empty = transcript.length === 0 && !streaming && !running;

  return (
    <div className="agent-panel" role="complementary" aria-label="MyDAW agent">
      <div className="agent-header">
        <span className="agent-title">Agent</span>
        <span className="agent-model" title={config?.endpoint}>
          {connected ? (ready ? config?.model || "no model" : "not configured") : "offline"}
        </span>
        {config ? (
          <button
            type="button"
            className={"agent-yolo" + (config.yolo ? " on" : " off")}
            title={
              config.yolo
                ? "YOLO mode ON — agent actions run without confirmation. Click to require approvals."
                : "YOLO mode off — mutations pause for approval. Click to enable (runs without confirmation)."
            }
            onClick={() => {
              if (config.yolo) {
                session.setYolo(false);
              } else if (
                window.confirm(
                  "YOLO mode runs agent actions WITHOUT confirmation, including non-undoable " +
                    "ones. Enable it?",
                )
              ) {
                session.setYolo(true);
              }
            }}
          >
            YOLO
          </button>
        ) : null}
        <span className="agent-header-spacer" />
        <IconButton
          icon="plus"
          tooltip="New chat"
          disabled={running}
          onClick={session.newChat}
        />
        <IconButton
          icon="trash"
          tooltip="Clear chat"
          disabled={running || empty}
          onClick={() => {
            if (window.confirm("Clear this conversation?")) session.clear();
          }}
        />
        <span className="agent-scripts-split">
          <button
            type="button"
            className="btn-icon agent-scripts-main"
            title="Prepared scripts — view, add, edit, delete"
            aria-label="Manage scripts"
            onClick={() => setScriptsOpen(true)}
          >
            <Icon name="scriptList" size={16} />
          </button>
          <button
            type="button"
            className="btn-icon agent-scripts-caret-btn"
            title="Run a prepared script"
            aria-label="Run a prepared script"
            onClick={openScriptsMenu}
          >
            <Icon name="chevronDown" size={10} />
          </button>
        </span>
        <IconButton
          icon="x"
          tooltip="Close (Ctrl+Shift+I)"
          onClick={() => setPanels({ agent: false })}
        />
      </div>

      <div className="agent-transcript" ref={scrollRef} onScroll={onScroll}>
        {empty ? (
          <div className="agent-empty">
            Ask me to build, edit, mix, or diagnose your project. I’ll show a plan before any
            change.
          </div>
        ) : null}
        {transcript.map((m, i) => (
          <MessageRow key={i} message={m} />
        ))}
        {streaming ? (
          <div className="agent-row assistant">
            <div className="agent-bubble">{streaming}</div>
          </div>
        ) : null}
        {running && !streaming && !pendingApproval ? (
          <div className="agent-working">working…</div>
        ) : null}
        {pendingApproval ? (
          <ApprovalCard pending={pendingApproval} onDecide={session.resolveApproval} />
        ) : null}
        {error ? <div className="agent-error">{error}</div> : null}
      </div>

      {!atBottom ? (
        <button
          type="button"
          className="agent-jump"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setAtBottom(true);
          }}
        >
          ↓ latest
        </button>
      ) : null}

      <div className="agent-composer">
        <textarea
          ref={textareaRef}
          className="agent-input"
          placeholder={ready ? "Message the agent…  (Enter to send, ↑ for history)" : "Configure in Settings → LLM"}
          value={draft}
          disabled={!ready}
          onChange={(e) => {
            histIdxRef.current = -1; // typing exits history browsing
            setDraft(e.target.value);
          }}
          onKeyDown={onKeyDown}
          rows={2}
        />
        {running ? (
          <button type="button" className="btn danger" onClick={session.stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={!ready || !draft.trim()}
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>

      {scriptsOpen ? (
        <ScriptsManager
          onClose={() => setScriptsOpen(false)}
          onUse={(prompt) => {
            setDraft((d) => (d ? `${d}\n${prompt}` : prompt));
            setScriptsOpen(false);
            textareaRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
