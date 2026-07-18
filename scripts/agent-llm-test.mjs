#!/usr/bin/env node
/**
 * Real local-LLM end-to-end test (SPEC §19.4).
 *
 * Spawns a null-driver engine + temp project, then drives a REAL OpenAI-compatible endpoint
 * through the same six-tool surface the in-app agent uses, executing every tool call against
 * the live engine over WebSocket. The assertions inspect engine/project state (via
 * agent/query), NOT the model's prose — the model must actually change the project.
 *
 * Usage: node scripts/agent-llm-test.mjs [--endpoint http://localhost:8038/v1]
 *                                        [--model <id>] [--port 18711] [--maxSteps 10]
 *
 * The endpoint must be reachable and expose /models + /chat/completions with forced tool
 * calls. On an unreachable endpoint the test SKIPS (exit 0) with a clear message rather than
 * failing — it is a live-dependency smoke, not a hermetic unit test.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const ENDPOINT = argValue("--endpoint", "http://localhost:8038/v1").replace(/\/+$/, "");
let MODEL = argValue("--model", "");
const PORT = Number(argValue("--port", "18711"));
const MAX_STEPS = Number(argValue("--maxSteps", "10"));
const EXE = argValue("--exe", path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"));
const TMP = path.join(os.tmpdir(), `mydaw-agent-llm-${process.pid}`);
const APPDATA = path.join(TMP, "appdata");
const PROJECT_DIR = path.join(TMP, "AgentLlm.mydaw");

let engine = null;
let socket = null;
let stderrTail = "";
let nextId = 1;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- WebSocket engine transport ---------------- */

function connect(url) {
  return new Promise((resolve, reject) => {
    socket = new WebSocket(url);
    const t = setTimeout(() => reject(new Error("ws connect timeout")), 8000);
    socket.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    socket.onerror = (e) => {
      clearTimeout(t);
      reject(new Error(`ws error ${e?.message ?? ""}`));
    };
    socket.onmessage = (m) => {
      let env;
      try {
        env = JSON.parse(m.data);
      } catch {
        return;
      }
      if (env.replyTo != null) {
        const p = pending.get(env.replyTo);
        if (!p) return;
        pending.delete(env.replyTo);
        clearTimeout(p.timer);
        env.ok ? p.resolve(env.payload ?? {}) : p.reject(env.error ?? { code: "error" });
      }
    };
  });
}

function ws(type, payload = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${type} timeout`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, type, payload }));
  });
}

/* ---------------- OpenAI-compatible client ---------------- */

async function chat(messages, tools) {
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.2, stream: false }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return body.choices?.[0]?.message ?? { role: "assistant", content: "" };
}

/* ---------------- the six tools (mirror the in-app surface) ---------------- */

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length ? { required } : {}),
});
const TOOLS = [
  { type: "function", function: { name: "mydaw_context", description: "Current project summary + revision.", parameters: obj({}) } },
  { type: "function", function: { name: "mydaw_describe", description: "Look up an operation's schema by name.", parameters: obj({ name: { type: "string" } }, ["name"]) } },
  { type: "function", function: { name: "mydaw_query", description: "Read project data by view (e.g. tracks, markers).", parameters: obj({ view: { type: "string" }, where: { type: "object" } }, ["view"]) } },
  { type: "function", function: { name: "mydaw_execute", description: "Run one operation, e.g. operation 'cmd/track.add' with payload {kind:'midi',name:'...'}.", parameters: obj({ operation: { type: "string" }, payload: { type: "object" } }, ["operation"]) } },
  { type: "function", function: { name: "mydaw_batch", description: "Run an atomic group of cmd/* operations.", parameters: obj({ operations: { type: "array" }, label: { type: "string" } }, ["operations"]) } },
];

async function runTool(name, argsRaw) {
  let a = {};
  try {
    a = argsRaw ? JSON.parse(argsRaw) : {};
  } catch {
    return { isError: true, text: "invalid JSON arguments" };
  }
  try {
    if (name === "mydaw_context") {
      const s = await ws("agent/query", { view: "project_summary" });
      return { text: JSON.stringify(s) };
    }
    if (name === "mydaw_describe") {
      // Minimal describe: enough for the model to fill cmd/track.add.
      return {
        text: JSON.stringify({
          name: a.name,
          hint: "cmd/track.add payload: { kind: 'audio'|'midi'|'instrument'|'bus', name: string }",
        }),
      };
    }
    if (name === "mydaw_query") return { text: JSON.stringify(await ws("agent/query", a)) };
    if (name === "mydaw_batch") return { text: JSON.stringify(await ws("agent/batch", a)) };
    if (name === "mydaw_execute") {
      const payload = a.payload && typeof a.payload === "object" ? a.payload : {};
      return { text: JSON.stringify(await ws(a.operation, payload)) };
    }
    return { isError: true, text: `unknown tool ${name}` };
  } catch (e) {
    return { isError: true, text: JSON.stringify(e) };
  }
}

/* ---------------- engine lifecycle ---------------- */

async function startEngine() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(path.join(APPDATA, "MyDAW"), { recursive: true });
  writeFileSync(path.join(APPDATA, "MyDAW", "settings.json"), JSON.stringify({ autosaveMinutes: 0 }));
  assert(existsSync(EXE), `engine not found: ${EXE}`);
  engine = spawn(EXE, ["--driver", "null", "--no-browser", "--port", String(PORT)], {
    env: { ...process.env, APPDATA, LOCALAPPDATA: APPDATA },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  engine.stderr.on("data", (d) => (stderrTail = (stderrTail + d).slice(-6000)));
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    if (engine.exitCode !== null) break;
    try {
      ready = (await fetch(`http://127.0.0.1:${PORT}/`)).ok;
    } catch {
      await sleep(250);
    }
  }
  assert(ready, `engine not ready\n${stderrTail}`);
  await connect(`ws://127.0.0.1:${PORT}/ws`);
  await ws("session/hello", { clientName: "agent-llm-test" });
  await ws("project/new", {});
  await ws("project/saveAs", { path: PROJECT_DIR });
}

async function cleanup() {
  try {
    socket?.close();
  } catch {}
  if (engine && engine.exitCode === null) {
    engine.kill();
    await Promise.race([new Promise((r) => engine.once("exit", r)), sleep(3000)]);
    if (engine.exitCode === null) engine.kill("SIGKILL");
  }
  rmSync(TMP, { recursive: true, force: true });
}

/* ---------------- the run ---------------- */

async function resolveModel() {
  const res = await fetch(`${ENDPOINT}/models`);
  if (!res.ok) throw new Error(`models ${res.status}`);
  const body = await res.json();
  const ids = (body.data ?? []).map((m) => m.id).filter(Boolean);
  if (!MODEL) MODEL = ids[0];
  assert(MODEL, "no model available at endpoint");
  return ids;
}

async function main() {
  // Live-dependency guard: skip cleanly if the endpoint is unreachable.
  try {
    await resolveModel();
  } catch (e) {
    console.log(`[SKIP] endpoint ${ENDPOINT} unreachable (${e.message}); real-model E2E skipped.`);
    process.exit(0);
  }
  console.log(`[info] endpoint ${ENDPOINT} model ${MODEL}`);

  await startEngine();
  const before = await ws("agent/query", { view: "tracks" });
  const beforeCount = before.total ?? before.items?.length ?? 0;

  const messages = [
    {
      role: "system",
      content:
        "You control a DAW through tools. To add a track call mydaw_execute with " +
        'operation "cmd/track.add" and payload {"kind":"midi","name":"AI Lead"}. ' +
        "Make exactly that one change, then reply with a short confirmation and no more tool calls.",
    },
    { role: "user", content: "Add a new MIDI track called 'AI Lead'." },
  ];

  let steps = 0;
  let toolCalls = 0;
  let executeOk = false;
  while (steps < MAX_STEPS) {
    steps += 1;
    const msg = await chat(messages, TOOLS);
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) break;
    for (const call of calls) {
      toolCalls += 1;
      const result = await runTool(call.function.name, call.function.arguments);
      if (call.function.name === "mydaw_execute" && !result.isError) executeOk = true;
      console.log(
        `[step ${steps}] ${call.function.name}(${(call.function.arguments || "").slice(0, 80)}) -> ${result.isError ? "ERR " : ""}${result.text.slice(0, 100)}`,
      );
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result.text });
    }
  }

  // Assertions on ENGINE STATE, not the model's prose.
  const after = await ws("agent/query", { view: "tracks", fields: ["id", "name", "kind"] });
  const afterCount = after.total ?? after.items?.length ?? 0;
  const names = (after.items ?? []).map((t) => t.name);
  console.log(`[result] steps=${steps} toolCalls=${toolCalls} tracks ${beforeCount}->${afterCount} names=${JSON.stringify(names)}`);

  assert(toolCalls > 0, "model made no tool calls (tool-calling unsupported or refused)");
  assert(executeOk, "model never executed a successful mutation via mydaw_execute");
  assert(afterCount > beforeCount, "engine track count did not increase — no real project change");

  console.log(`\n[PASS] real-model E2E on ${MODEL}: model added ${afterCount - beforeCount} track(s) via tools`);
}

main()
  .then(cleanup)
  .catch(async (e) => {
    console.error(`\n[FAIL] ${e?.stack ?? e}`);
    if (stderrTail) console.error(`engine stderr tail:\n${stderrTail}`);
    await cleanup();
    process.exit(1);
  });
