/**
 * Per-user, project-keyed chat history and prepared-script persistence (Increment 4).
 *
 * Stored under settings.llm in %APPDATA%/MyDAW/settings.json — never in the .mydaw project,
 * so chatting does not dirty a music project. Bulky/mutable collections are persisted as
 * JSON strings (historiesJson / customScriptsJson) rather than nested objects, so a save
 * replaces them wholesale instead of union-merging with the engine's recursive settings
 * merge (which would otherwise never drop a pruned thread).
 *
 * All coercion is defensive: corrupt or partial persisted data degrades to empty/defaults
 * rather than throwing (versioned recovery).
 */

import type { ChatMessage } from "./agentTypes";

export const PERSIST_VERSION = 1;
export const MAX_THREADS_PER_PROJECT = 20;
export const MAX_MESSAGES_PER_THREAD = 200;
export const MAX_HISTORY_BYTES = 512 * 1024; // total serialized history budget

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ProjectHistory {
  threads: ChatThread[];
}

export type Histories = Record<string, ProjectHistory>;

export interface CustomScript {
  id: string;
  title: string;
  category: string;
  prompt: string;
  tags?: string[];
}

/** Stable per-project key: unsaved projects share a session-local bucket until first save. */
export function projectKey(projectPath: string | null | undefined): string {
  if (!projectPath || !projectPath.trim()) return "session:unsaved";
  const normalized = projectPath.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  // FNV-1a 32-bit — a stable, dependency-free key (not security-sensitive).
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `project:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function coerceMessage(raw: unknown): ChatMessage | null {
  if (!isObject(raw)) return null;
  const role = raw.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    return null;
  }
  const content = typeof raw.content === "string" ? raw.content : raw.content === null ? null : "";
  const msg: ChatMessage = { role, content };
  if (Array.isArray(raw.tool_calls)) msg.tool_calls = raw.tool_calls as ChatMessage["tool_calls"];
  if (typeof raw.tool_call_id === "string") msg.tool_call_id = raw.tool_call_id;
  if (typeof raw.name === "string") msg.name = raw.name;
  return msg;
}

function coerceThread(raw: unknown): ChatThread | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(coerceMessage).filter((m): m is ChatMessage => m !== null)
    : [];
  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "Chat",
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    messages,
  };
}

/** Trim one project's history to the per-thread and per-project limits. */
export function pruneProjectHistory(history: ProjectHistory): ProjectHistory {
  const threads = history.threads
    .map((t) => ({
      ...t,
      messages:
        t.messages.length > MAX_MESSAGES_PER_THREAD
          ? t.messages.slice(t.messages.length - MAX_MESSAGES_PER_THREAD)
          : t.messages,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt) // newest first
    .slice(0, MAX_THREADS_PER_PROJECT);
  return { threads };
}

/** Enforce the total byte budget by dropping the oldest threads across all projects. */
export function enforceByteBudget(histories: Histories): Histories {
  const serialized = () => JSON.stringify(histories).length;
  if (serialized() <= MAX_HISTORY_BYTES) return histories;
  // Flatten to (key, thread) pairs sorted oldest-first, drop until under budget.
  const pairs: Array<{ key: string; thread: ChatThread }> = [];
  for (const [key, ph] of Object.entries(histories)) {
    for (const thread of ph.threads) pairs.push({ key, thread });
  }
  pairs.sort((a, b) => a.thread.updatedAt - b.thread.updatedAt);
  const trimmed: Histories = {};
  for (const [key, ph] of Object.entries(histories)) trimmed[key] = { threads: [...ph.threads] };
  let i = 0;
  while (JSON.stringify(trimmed).length > MAX_HISTORY_BYTES && i < pairs.length) {
    const { key, thread } = pairs[i];
    i += 1;
    const ph = trimmed[key];
    if (!ph) continue;
    ph.threads = ph.threads.filter((t) => t.id !== thread.id);
    if (ph.threads.length === 0) delete trimmed[key];
  }
  return trimmed;
}

/** Parse persisted histories (a JSON string or an object) into a valid, bounded structure. */
export function parseHistories(raw: unknown): Histories {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  if (!isObject(value)) return {};
  const out: Histories = {};
  for (const [key, ph] of Object.entries(value)) {
    if (!isObject(ph) || !Array.isArray(ph.threads)) continue;
    const threads = ph.threads
      .map(coerceThread)
      .filter((t): t is ChatThread => t !== null);
    if (threads.length) out[key] = pruneProjectHistory({ threads });
  }
  return enforceByteBudget(out);
}

export function stringifyHistories(histories: Histories): string {
  return JSON.stringify(enforceByteBudget(histories));
}

/** Insert or replace a thread in a project's history, then prune. */
export function upsertThread(
  histories: Histories,
  key: string,
  thread: ChatThread,
): Histories {
  const existing = histories[key]?.threads ?? [];
  const threads = existing.filter((t) => t.id !== thread.id);
  threads.push(thread);
  const next: Histories = { ...histories, [key]: pruneProjectHistory({ threads }) };
  return enforceByteBudget(next);
}

/** Parse persisted custom prepared scripts (a JSON string or array), dropping invalid ones. */
export function parseCustomScripts(raw: unknown): CustomScript[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = raw.trim() ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CustomScript[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const { id, title, category, prompt } = entry;
    if (
      typeof id !== "string" ||
      !id ||
      seen.has(id) ||
      typeof title !== "string" ||
      typeof category !== "string" ||
      typeof prompt !== "string" ||
      !prompt
    ) {
      continue;
    }
    seen.add(id);
    out.push({
      id,
      title,
      category,
      prompt,
      ...(Array.isArray(entry.tags)
        ? { tags: entry.tags.filter((t): t is string => typeof t === "string") }
        : {}),
    });
  }
  return out;
}

export function stringifyCustomScripts(scripts: CustomScript[]): string {
  return JSON.stringify(scripts);
}
