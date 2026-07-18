/**
 * LLM configuration defaults, validation, and endpoint resolution (Increment 4).
 *
 * Persisted under settings.llm in %APPDATA%/MyDAW/settings.json (per-user, never in the
 * .mydaw project). Defaults point at a local OpenAI-compatible server (LM Studio,
 * llama.cpp server, Ollama's compat endpoint, …) — set yours in Settings ▸ LLM.
 */

import type { LlmConfig } from "./agentTypes";

export const PRIMARY_ENDPOINT = "http://localhost:8038/v1";
export const FALLBACK_ENDPOINT = "http://localhost:8036/v1";

export const MAX_STEPS_CEILING = 32;

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  endpoint: PRIMARY_ENDPOINT,
  model: "",
  apiKey: "",
  temperature: 0.7,
  maxSteps: 12,
  yolo: false,
};

const clampNumber = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Normalize an OpenAI-compatible base URL: trim, drop trailing slash. "" stays "". */
export function normalizeEndpoint(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

/**
 * Coerce an arbitrary persisted value into a valid LlmConfig, filling defaults for any
 * missing/invalid field. Never throws — corrupt settings degrade to defaults.
 */
export function coerceLlmConfig(raw: unknown): LlmConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const endpoint = normalizeEndpoint(
    typeof o.endpoint === "string" && o.endpoint.trim()
      ? o.endpoint
      : DEFAULT_LLM_CONFIG.endpoint,
  );
  return {
    endpoint,
    model: typeof o.model === "string" ? o.model : "",
    apiKey: typeof o.apiKey === "string" ? o.apiKey : "",
    temperature: clampNumber(o.temperature, 0, 2, DEFAULT_LLM_CONFIG.temperature),
    maxSteps: Math.round(
      clampNumber(o.maxSteps, 1, MAX_STEPS_CEILING, DEFAULT_LLM_CONFIG.maxSteps),
    ),
    yolo: o.yolo === true,
  };
}

/** True when the config has enough to attempt a connection. */
export function isConfigReady(config: LlmConfig): boolean {
  return normalizeEndpoint(config.endpoint) !== "" && config.model.trim() !== "";
}

/**
 * Ordered candidate endpoints to try when discovering models: a previously saved endpoint
 * first, then the primary and fallback locals. Deduplicated, normalized, non-empty.
 */
export function endpointCandidates(saved?: string): string[] {
  const out: string[] = [];
  for (const e of [saved ?? "", PRIMARY_ENDPOINT, FALLBACK_ENDPOINT]) {
    const n = normalizeEndpoint(e);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}
