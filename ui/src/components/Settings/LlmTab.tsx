/**
 * Settings → LLM tab (Increment 4). Endpoint, model discovery, API key, temperature, max
 * agent steps, YOLO mode, and the MCP bearer token (masked / copy / rotate). Persisted to
 * settings.llm (per-user, never in the project).
 */

import React, { useEffect, useState } from "react";
import type { AppSettings } from "../../protocol/types";
import { getSettings, setSettings } from "../../store/actions";
import { AgentClient } from "../../agent/agentClient";
import {
  coerceLlmConfig,
  MAX_STEPS_CEILING,
  normalizeEndpoint,
} from "../../agent/agentConfig";
import type { LlmConfig } from "../../agent/agentTypes";
import { NumberDrag } from "../common/NumberDrag";
import { Select } from "../common/Select";
import { TextInput } from "../common/TextInput";
import { Toggle } from "../common/Toggle";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function LlmTab() {
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [mcpToken, setMcpToken] = useState<string>("");
  const [models, setModels] = useState<string[]>([]);
  const [health, setHealth] = useState<"unknown" | "ok" | "error">("unknown");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((s) => {
        if (!alive) return;
        const llm = (s as AppSettings & { llm?: unknown }).llm;
        setConfig(coerceLlmConfig(llm));
        const token =
          llm && typeof llm === "object" && typeof (llm as Record<string, unknown>).mcpToken === "string"
            ? ((llm as Record<string, unknown>).mcpToken as string)
            : "";
        setMcpToken(token);
      })
      .catch((e) => {
        if (alive) {
          setErr(errText(e));
          setConfig(coerceLlmConfig(null));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const persist = (patch: Partial<LlmConfig>) => {
    setConfig((prev) => {
      const next = { ...(prev ?? coerceLlmConfig(null)), ...patch };
      setSettings({ llm: patch } as Partial<AppSettings>).catch((e) => setErr(errText(e)));
      return next;
    });
  };

  const refreshModels = async () => {
    if (!config) return;
    const endpoint = normalizeEndpoint(config.endpoint);
    if (!endpoint) {
      setErr("enter an endpoint first");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const client = new AgentClient(endpoint, "", config.apiKey);
      const ids = await client.listModels();
      setModels(ids);
      setHealth("ok");
      if (ids.length && !ids.includes(config.model)) persist({ model: ids[0] });
    } catch (e) {
      setHealth("error");
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleYolo = (on: boolean) => {
    if (on) {
      const warned = window.confirm(
        "YOLO mode runs agent actions WITHOUT confirmation, including non-undoable ones. " +
          "Enable it?",
      );
      if (!warned) return;
    }
    persist({ yolo: on });
  };

  const rotateToken = () => {
    const token = randomToken();
    setMcpToken(token);
    setSettings({ llm: { mcpToken: token } } as Partial<AppSettings>).catch((e) =>
      setErr(errText(e)),
    );
  };

  if (!config) {
    return <div className="sett-note">Loading…</div>;
  }

  const maskedToken = mcpToken
    ? showToken
      ? mcpToken
      : `${mcpToken.slice(0, 4)}${"•".repeat(Math.max(0, mcpToken.length - 4))}`
    : "(none)";

  return (
    <div className="col gap2">
      <div className="sett-grid">
        <span className="sett-label">Endpoint</span>
        <div className="row gap1">
          <TextInput
            value={config.endpoint}
            onCommit={(v) => persist({ endpoint: normalizeEndpoint(v) })}
            placeholder="http://localhost:8038/v1"
            width={280}
          />
          <button type="button" className="btn" disabled={busy} onClick={refreshModels}>
            {busy ? "…" : "Refresh models"}
          </button>
          <span className={"sett-note" + (health === "error" ? " sett-error" : "")}>
            {health === "ok" ? "connected" : health === "error" ? "unreachable" : ""}
          </span>
        </div>

        <span className="sett-label">Model</span>
        <div className="row gap1">
          {models.length ? (
            <Select
              value={config.model}
              options={models.map((m) => ({ value: m, label: m }))}
              onChange={(v) => persist({ model: v })}
              width={280}
            />
          ) : (
            <TextInput
              value={config.model}
              onCommit={(v) => persist({ model: v })}
              placeholder="refresh to discover models"
              width={280}
            />
          )}
        </div>

        <span className="sett-label">API key</span>
        <div className="row gap1">
          <TextInput
            value={config.apiKey}
            type="password"
            onCommit={(v) => persist({ apiKey: v })}
            placeholder="optional"
            width={280}
          />
          <span className="sett-note">stored locally in plaintext</span>
        </div>

        <span className="sett-label">Temperature</span>
        <div className="row gap1">
          <NumberDrag
            value={config.temperature}
            min={0}
            max={2}
            step={0.05}
            precision={2}
            width={64}
            onChange={(v) => setConfig((p) => (p ? { ...p, temperature: v } : p))}
            onCommit={(v) => persist({ temperature: v })}
          />
        </div>

        <span className="sett-label">Max agent steps</span>
        <div className="row gap1">
          <NumberDrag
            value={config.maxSteps}
            min={1}
            max={MAX_STEPS_CEILING}
            step={1}
            precision={0}
            width={64}
            onChange={(v) => setConfig((p) => (p ? { ...p, maxSteps: Math.round(v) } : p))}
            onCommit={(v) => persist({ maxSteps: Math.round(v) })}
          />
        </div>

        <span className="sett-label">YOLO mode</span>
        <div className="row gap1">
          <Toggle on={config.yolo} onChange={toggleYolo} variant="danger">
            {config.yolo ? "ON — no confirmations" : "off"}
          </Toggle>
          <span className="sett-note">run agent actions without confirmation</span>
        </div>

        <span className="sett-label">MCP token</span>
        <div className="row gap1">
          <code className="sett-token">{maskedToken}</code>
          <button type="button" className="btn" onClick={() => setShowToken((s) => !s)}>
            {showToken ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!mcpToken}
            onClick={() => navigator.clipboard?.writeText(mcpToken)}
          >
            Copy
          </button>
          <button type="button" className="btn" onClick={rotateToken}>
            Rotate
          </button>
        </div>
      </div>

      <div className="sett-note">
        LLM settings are stored per user in %APPDATA%/MyDAW/settings.json (never in the
        project). The MCP token authenticates external MCP clients at /mcp.
      </div>
      {config.yolo ? (
        <div className="sett-error">
          YOLO mode is ON — agent mutations run without confirmation.
        </div>
      ) : null}
      {err ? <div className="sett-error">{err}</div> : null}
    </div>
  );
}
