#!/usr/bin/env node
/**
 * Integration coverage for the embedded MCP server (POST /mcp, revision 2025-11-25).
 *
 * Spawns a null-driver engine with isolated APPDATA and a known MCP bearer token, then
 * drives the real Streamable-HTTP JSON-RPC endpoint with fetch(). Verifies lifecycle,
 * security, the six tools, resources, prompts, a representative project sequence, and that
 * concurrent long-ish calls do not deadlock the single socket thread.
 *
 * Usage: node scripts/mcp-test.mjs [--port 18517] [--exe <path>] [--no-spawn]
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
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const PORT = Number(argValue("--port", "18517"));
const EXE = argValue(
  "--exe",
  path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
);
const NO_SPAWN = args.includes("--no-spawn");
const TMP = path.join(os.tmpdir(), `mydaw-mcp-${process.pid}`);
const APPDATA = path.join(TMP, "appdata");
const MCP_TOKEN = "mcp-integration-bearer-token";
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;

let engine = null;
let stderrTail = "";
let nextId = 1;
let passed = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

// Raw POST /mcp. Returns { status, json } (json null when the body is empty).
async function post(body, { token = MCP_TOKEN, origin, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, json: parsed, text };
}

// JSON-RPC request helper (asserts a 200 + jsonrpc envelope, returns the envelope).
async function rpc(method, params, opts) {
  const id = nextId++;
  const { status, json } = await post({ jsonrpc: "2.0", id, method, params }, opts);
  assert.equal(status, 200, `${method} HTTP status`);
  assert(json && json.jsonrpc === "2.0", `${method} jsonrpc envelope`);
  assert.equal(json.id, id, `${method} id echo`);
  return json;
}

// Call a tool; returns the MCP tool result ({ content, structuredContent, isError? }).
async function callTool(name, args = {}) {
  const env = await rpc("tools/call", { name, arguments: args });
  assert(!env.error, `${name} produced JSON-RPC error: ${JSON.stringify(env.error)}`);
  return env.result;
}

async function startEngine() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(path.join(APPDATA, "MyDAW"), { recursive: true });
  writeFileSync(
    path.join(APPDATA, "MyDAW", "settings.json"),
    JSON.stringify({ autosaveMinutes: 0, llm: { mcpToken: MCP_TOKEN } }),
  );

  if (!NO_SPAWN) {
    assert(existsSync(EXE), `engine executable not found: ${EXE}`);
    engine = spawn(
      EXE,
      ["--driver", "null", "--no-browser", "--port", String(PORT)],
      {
        env: { ...process.env, APPDATA, LOCALAPPDATA: APPDATA },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    engine.stderr.on("data", (data) => {
      stderrTail = (stderrTail + data.toString()).slice(-8000);
    });
  }

  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    if (engine && engine.exitCode !== null) break;
    try {
      const response = await fetch(`${BASE}/`);
      ready = response.ok;
    } catch {
      await sleep(250);
    }
  }
  assert(ready, `engine did not become ready on ${PORT}\n${stderrTail}`);
}

async function cleanup() {
  if (engine && engine.exitCode === null) {
    engine.kill();
    await Promise.race([
      new Promise((resolve) => engine.once("exit", resolve)),
      sleep(3000),
    ]);
    if (engine.exitCode === null) engine.kill("SIGKILL");
  }
  rmSync(TMP, { recursive: true, force: true });
}

async function main() {
  await test("null-driver engine boots on an isolated high port", startEngine);

  await test("GET /mcp is 405 (no SSE stream in this version)", async () => {
    const response = await fetch(MCP_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${MCP_TOKEN}` },
    });
    assert.equal(response.status, 405);
    assert(/post/i.test(response.headers.get("allow") ?? ""));
  });

  await test("missing/invalid bearer token is rejected 401", async () => {
    const noAuth = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { token: null },
    );
    assert.equal(noAuth.status, 401);
    const badAuth = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { token: "wrong-token" },
    );
    assert.equal(badAuth.status, 401);
  });

  await test("a non-loopback Origin is rejected 403 (DNS-rebinding guard)", async () => {
    const evil = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: "http://evil.example" },
    );
    assert.equal(evil.status, 403);
    // A loopback Origin is accepted.
    const ok = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: `http://localhost:${PORT}` },
    );
    assert.equal(ok.status, 200);
  });

  await test("initialize negotiates protocol + advertises capabilities", async () => {
    const env = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcp-test", version: "0" },
    });
    assert.equal(env.result.protocolVersion, "2025-11-25");
    assert.equal(env.result.serverInfo.name, "mydaw-engine");
    for (const cap of ["tools", "resources", "prompts"]) {
      assert(cap in env.result.capabilities, `capabilities.${cap}`);
    }
  });

  await test("notifications/initialized returns 202 with no body", async () => {
    const { status, text } = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(status, 202);
    assert.equal(text, "");
  });

  await test("ping returns an empty result", async () => {
    const env = await rpc("ping", {});
    assert.deepEqual(env.result, {});
  });

  await test("tools/list exposes the six tools with annotations, under budget", async () => {
    const env = await rpc("tools/list", {});
    const names = env.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "mydaw_batch",
      "mydaw_context",
      "mydaw_describe",
      "mydaw_execute",
      "mydaw_query",
      "mydaw_ui",
    ]);
    for (const tool of env.result.tools) {
      assert(tool.inputSchema && tool.inputSchema.type === "object", `${tool.name} schema`);
      assert(tool.annotations && typeof tool.annotations.readOnlyHint === "boolean");
    }
    const query = env.result.tools.find((t) => t.name === "mydaw_query");
    assert.equal(query.annotations.readOnlyHint, true);
    const execute = env.result.tools.find((t) => t.name === "mydaw_execute");
    assert.equal(execute.annotations.readOnlyHint, false);
    // §18 compact tool-schema budget: tools/list stays well under 12 KiB.
    assert(JSON.stringify(env.result).length < 12 * 1024, "tools/list under 12 KiB");
  });

  await test("unknown method and unknown tool produce correct JSON-RPC errors", async () => {
    const unknownMethod = await rpc("does/not/exist", {});
    assert.equal(unknownMethod.error.code, -32601);
    const unknownTool = await rpc("tools/call", { name: "mydaw_nope", arguments: {} });
    assert.equal(unknownTool.error.code, -32602);
  });

  await test("malformed JSON body is rejected 400 with a parse error", async () => {
    const { status, json } = await post(null, { raw: "{ not json" });
    assert.equal(status, 400);
    assert.equal(json.error.code, -32700);
  });

  await test("mydaw_context reports revision, transport, and capability categories", async () => {
    const result = await callTool("mydaw_context");
    assert(!result.isError);
    const ctx = result.structuredContent;
    assert.equal(typeof ctx.revision, "number");
    assert(ctx.transport, "context has transport");
    assert(ctx.capabilityCategories && Object.keys(ctx.capabilityCategories).length > 0);
    assert.equal(ctx.availability.uiController, false);
  });

  await test("mydaw_describe returns a self-contained input schema for a named op", async () => {
    const search = await callTool("mydaw_describe", { query: "track", limit: 5 });
    assert(search.structuredContent.operations.length > 0);
    const named = await callTool("mydaw_describe", { name: "cmd/track.add" });
    const op = named.structuredContent.operations[0];
    assert.equal(op.name, "cmd/track.add");
    assert(op.input && op.input.type === "object", "resolved input schema");
    assert(!JSON.stringify(op.input).includes("$ref"), "refs are inlined");
    assert(Array.isArray(op.examples) && op.examples.length > 0);
  });

  await test("mydaw_ui is honestly unavailable without a controller", async () => {
    const result = await callTool("mydaw_ui", {
      operation: "ui/theme.set",
      payload: { theme: "dark" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "ui_unavailable");
  });

  let midiTrackId = 0;
  await test("mydaw_execute creates a track (engine command boundary)", async () => {
    const result = await callTool("mydaw_execute", {
      operation: "cmd/track.add",
      payload: { kind: "midi", name: "Agent MIDI" },
    });
    assert(!result.isError, JSON.stringify(result));
    midiTrackId = result.structuredContent.track.id;
    assert(midiTrackId > 0);
  });

  await test("mydaw_execute rejects a stale expectedRevision without mutating", async () => {
    const before = (await callTool("mydaw_query", { view: "project_summary" }))
      .structuredContent.revision;
    const stale = await callTool("mydaw_execute", {
      operation: "cmd/track.add",
      payload: { kind: "audio", name: "Should Not Exist" },
      expectedRevision: before + 999,
    });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.code, "stale_revision");
    const after = (await callTool("mydaw_query", { view: "project_summary" }))
      .structuredContent.revision;
    assert.equal(after, before, "stale execute left the revision unchanged");
  });

  await test("mydaw_batch applies an atomic group that one undo reverts", async () => {
    const before = (await callTool("mydaw_query", { view: "project_summary" }))
      .structuredContent.revision;
    const batch = await callTool("mydaw_batch", {
      label: "Add two markers",
      expectedRevision: before,
      operations: [
        { type: "cmd/marker.add", payload: { beat: 0, name: "A" } },
        { type: "cmd/marker.add", payload: { beat: 4, name: "B" } },
      ],
    });
    assert(!batch.isError, JSON.stringify(batch));
    assert.equal(batch.structuredContent.revision, before + 1, "batch is one revision");
    const markers = await callTool("mydaw_query", { view: "markers", limit: 50 });
    assert.equal(markers.structuredContent.items.length, 2);

    const undo = await callTool("mydaw_execute", { operation: "edit/undo", payload: {} });
    assert(!undo.isError, JSON.stringify(undo));
    const after = await callTool("mydaw_query", { view: "markers", limit: 50 });
    assert.equal(after.structuredContent.items.length, 0, "one undo reverted both markers");
  });

  await test("a failing mydaw_execute is reported as a tool error, not a fake success", async () => {
    const result = await callTool("mydaw_execute", {
      operation: "cmd/track.set",
      payload: { trackId: 999999, patch: { name: "ghost" } },
    });
    assert.equal(result.isError, true);
    assert(result.structuredContent.code, "carries an engine error code");
  });

  await test("resources: list, templates, and a capabilities read", async () => {
    const list = await rpc("resources/list", {});
    const uris = list.result.resources.map((r) => r.uri);
    assert(uris.includes("mydaw://capabilities"));
    assert(uris.includes("mydaw://project/summary"));
    const templates = await rpc("resources/templates/list", {});
    assert(
      templates.result.resourceTemplates.some((t) =>
        t.uriTemplate.includes("mydaw://tracks/"),
      ),
    );
    const caps = await rpc("resources/read", { uri: "mydaw://capabilities" });
    const content = caps.result.contents[0];
    assert.equal(content.uri, "mydaw://capabilities");
    const catalog = JSON.parse(content.text);
    assert(Array.isArray(catalog.operations) && catalog.operations.length > 0);
    // Templated read resolves the track created above.
    const track = await rpc("resources/read", { uri: `mydaw://tracks/${midiTrackId}` });
    const trackJson = JSON.parse(track.result.contents[0].text);
    assert.equal(trackJson.items[0].id, midiTrackId);
  });

  await test("prompts: list the embedded scripts and fetch one by id", async () => {
    const list = await rpc("prompts/list", {});
    assert(list.result.prompts.length >= 10, "embedded prepared scripts");
    const first = list.result.prompts[0].name;
    const got = await rpc("prompts/get", { name: first });
    assert(got.result.messages[0].content.text.length > 0);
    const missing = await rpc("prompts/get", { name: "no-such-prompt" });
    assert.equal(missing.error.code, -32602);
  });

  await test("concurrent MCP calls all resolve (socket thread stays non-blocking)", async () => {
    const calls = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? callTool("mydaw_query", { view: "tracks" })
        : callTool("mydaw_context"),
    );
    const results = await Promise.all(calls);
    assert.equal(results.length, 12);
    for (const r of results) assert(!r.isError);
  });

  console.log(`\n${passed} MCP integration checks passed`);
}

main()
  .then(cleanup)
  .catch(async (error) => {
    console.error(`\n[FAIL] ${error?.stack ?? error}`);
    if (stderrTail) console.error(`\nEngine stderr tail:\n${stderrTail}`);
    await cleanup();
    process.exit(1);
  });
