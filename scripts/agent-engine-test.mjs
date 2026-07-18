#!/usr/bin/env node
/**
 * Integration coverage for the internal agent/query and agent/batch engine primitives.
 *
 * Spawns a null-driver engine with isolated APPDATA, creates a temporary project, and
 * drives the real WebSocket router. Requires Node >= 21 (global WebSocket).
 *
 * Usage: node scripts/agent-engine-test.mjs [--port 18417] [--exe <path>] [--no-spawn]
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
const PORT = Number(argValue("--port", "18417"));
const EXE = argValue(
  "--exe",
  path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
);
const NO_SPAWN = args.includes("--no-spawn");
const TMP = path.join(os.tmpdir(), `mydaw-agent-engine-${process.pid}`);
const APPDATA = path.join(TMP, "appdata");
const PROJECT_DIR = path.join(TMP, "AgentTest.mydaw");
const API_SECRET = "agent-engine-api-secret";
const MCP_SECRET = "agent-engine-mcp-secret";

let engine = null;
let socket = null;
let stderrTail = "";
let nextId = 1;
let passed = 0;
const pending = new Map();
const events = [];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class ProtocolError extends Error {
  constructor(type, error) {
    super(`${type}: ${error?.code ?? "error"} ${error?.message ?? ""}`.trim());
    this.name = "ProtocolError";
    this.code = error?.code ?? "error";
  }
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    socket = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error("WebSocket connect timeout")), 8000);
    socket.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    socket.onerror = (event) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error ${event?.message ?? ""}`));
    };
    socket.onmessage = (message) => {
      let envelope;
      try {
        envelope = JSON.parse(message.data);
      } catch {
        return;
      }
      if (envelope.replyTo != null) {
        const entry = pending.get(envelope.replyTo);
        if (!entry) return;
        pending.delete(envelope.replyTo);
        clearTimeout(entry.timeout);
        if (envelope.ok) entry.resolve(envelope.payload ?? {});
        else entry.reject(new ProtocolError(entry.type, envelope.error));
      } else if (envelope.type) {
        events.push(envelope);
      }
    };
    socket.onclose = () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error(`${entry.type}: WebSocket closed`));
      }
      pending.clear();
    };
  });
}

function request(type, payload = {}, timeoutMs = 30000) {
  assert(socket?.readyState === WebSocket.OPEN, "WebSocket is not open");
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${type}: timeout`));
    }, timeoutMs);
    pending.set(id, { type, resolve, reject, timeout });
    socket.send(JSON.stringify({ id, type, payload }));
  });
}

async function expectProtocolError(type, payload, code) {
  try {
    await request(type, payload);
  } catch (error) {
    assert(error instanceof ProtocolError, `expected protocol error, received ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`${type} unexpectedly succeeded; expected ${code}`);
}

const query = (payload) => request("agent/query", payload);
const batch = (payload) => request("agent/batch", payload);
const projectSnapshot = async () =>
  (await request("session/hello", { clientName: "agent-engine-test" })).project;
const currentRevision = async () =>
  (await query({ view: "project_summary", fields: ["name"] })).revision;

async function startEngine() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(path.join(APPDATA, "MyDAW"), { recursive: true });
  writeFileSync(
    path.join(APPDATA, "MyDAW", "settings.json"),
    JSON.stringify({
      autosaveMinutes: 0,
      llm: { apiKey: API_SECRET, nested: { mcpToken: MCP_SECRET } },
    }),
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
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      ready = response.ok;
    } catch {
      await sleep(250);
    }
  }
  assert(ready, `engine did not become ready on ${PORT}\n${stderrTail}`);
  await connect(`ws://127.0.0.1:${PORT}/ws`);
}

async function cleanup() {
  try {
    socket?.close();
  } catch {}
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
  await test("temporary project is created and saved", async () => {
    const hello = await request("session/hello", { clientName: "agent-engine-test" });
    assert.equal(hello.engine.driver, "null");
    await request("project/new", {});
    await request("project/saveAs", { path: PROJECT_DIR });
    assert(existsSync(path.join(PROJECT_DIR, "project.json")));
  });

  const baseProject = await projectSnapshot();
  const baseRevision = await currentRevision();

  await test("representative bounded and redacted query views", async () => {
    const summary = await query({
      view: "project_summary",
      fields: ["name", "trackCount", "clipCount"],
    });
    assert.equal(summary.revision, baseRevision);
    assert.equal(summary.total, 1);
    assert.equal(summary.items[0].trackCount, 1); // master

    const settings = await query({ view: "settings" });
    assert.equal(settings.total, 1);
    assert.equal(settings.items[0].llm.apiKey, "[REDACTED]");
    assert.equal(settings.items[0].llm.nested.mcpToken, "[REDACTED]");
    assert(!JSON.stringify(settings).includes(API_SECRET));
    assert(!JSON.stringify(settings).includes(MCP_SECRET));

    const runtime = await query({ view: "engine_status" });
    assert.equal(runtime.total, 1);
    assert.equal(runtime.items[0].running, true);
    assert.equal(runtime.items[0].driver, "null");
  });

  let trackId;
  let clipId;
  let batchRevision;
  await test("two-operation alias batch emits once and advances one revision", async () => {
    events.length = 0;
    const result = await batch({
      label: "Create agent MIDI clip",
      expectedRevision: baseRevision,
      operations: [
        {
          type: "cmd/track.add",
          payload: { kind: "midi", name: "Agent MIDI" },
          as: "track",
        },
        {
          type: "cmd/clip.addMidi",
          payload: {
            trackId: { $result: "track", pointer: "/track/id" },
            startBeat: 0,
            lengthBeats: 8,
            name: "Agent Phrase",
          },
          as: "clip",
        },
      ],
    });
    trackId = result.results[0].result.track.id;
    clipId = result.results[1].result.clip.id;
    batchRevision = result.revision;
    assert.equal(result.label, "Create agent MIDI clip");
    assert.equal(result.results.length, 2);
    assert.equal(result.results[1].payload.trackId, trackId);
    assert.equal(batchRevision, baseRevision + 1);
    assert.equal(await currentRevision(), batchRevision);

    const changes = events.filter(({ type }) => type === "event/projectChanged");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].payload.revision, batchRevision);
    assert.equal(changes[0].payload.scope, "project");
  });

  await test("track queries project fields and paginate with an opaque cursor", async () => {
    const first = await query({
      view: "tracks",
      where: { includeMaster: true },
      fields: ["id", "name"],
      limit: 1,
    });
    assert.equal(first.total, 2);
    assert.equal(first.items.length, 1);
    assert.deepEqual(Object.keys(first.items[0]).sort(), ["id", "name"]);
    assert.equal(first.nextCursor, "1");

    const second = await query({
      view: "tracks",
      where: { includeMaster: true },
      fields: ["id", "name"],
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.total, 2);
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [...first.items, ...second.items].map(({ name }) => name),
      ["Agent MIDI", "Master"],
    );

    const oneTrack = await query({
      view: "track",
      where: { trackId },
      fields: ["id", "kind", "name", "clipCount"],
    });
    assert.deepEqual(oneTrack.items, [{ id: trackId, kind: "midi", name: "Agent MIDI", clipCount: 1 }]);

    await expectProtocolError("agent/query", { view: "tracks", limit: 501 }, "invalid_arguments");
  });

  await test("notes query filters and projects fields", async () => {
    await request("cmd/notes.edit", {
      clipId,
      add: [{ pitch: 64, velocity: 91, startBeat: 1, lengthBeats: 0.5 }],
    });
    const notes = await query({
      view: "notes",
      where: { clipId },
      fields: ["id", "pitch", "velocity", "startBeat", "lengthBeats"],
      limit: 10,
    });
    assert.equal(notes.total, 1);
    assert.deepEqual(
      { pitch: notes.items[0].pitch, velocity: notes.items[0].velocity,
        startBeat: notes.items[0].startBeat, lengthBeats: notes.items[0].lengthBeats },
      { pitch: 64, velocity: 91, startBeat: 1, lengthBeats: 0.5 },
    );
    // Field leniency for LLM-supplied near-miss names: unknown fields are ignored (not a
    // hard invalid_arguments), and an all-unknown set returns the full item so the model can
    // discover the real field names.
    const lenient = await query({
      view: "notes",
      where: { clipId },
      fields: ["note", "velocity", "duration", "clipId"], // note/duration are not real fields
      limit: 10,
    });
    assert.equal(lenient.total, 1);
    assert.deepEqual(Object.keys(lenient.items[0]).sort(), ["clipId", "velocity"]);
    const discover = await query({
      view: "notes",
      where: { clipId },
      fields: ["note", "duration"], // all unknown -> full item returned
      limit: 10,
    });
    assert(discover.items[0].pitch === 64, "all-unknown fields fall back to the full item");
    await request("edit/undo", {}); // remove the standalone note edit; batch undo remains
    const empty = await query({ view: "notes", where: { clipId } });
    assert.equal(empty.total, 0);
    batchRevision = empty.revision;
  });

  await test("a broad notes query is rejected by the pre-pagination work budget", async () => {
    const compactNotes = Array.from({ length: 20_001 }, (_, index) => ({
      pitch: 48 + (index % 24),
      velocity: 64,
      startBeat: index / 100,
      lengthBeats: 0.005,
    }));
    await request("cmd/notes.edit", { clipId, add: compactNotes }, 120_000);
    await expectProtocolError("agent/query", {
      view: "notes",
      where: { clipId },
      fields: ["id", "pitch"],
      limit: 500,
    }, "query_too_broad");
    await request("edit/undo", {}, 120_000);
    const empty = await query({ view: "notes", where: { clipId } });
    assert.equal(empty.total, 0);
  });

  await test("stale revision is rejected without changing state", async () => {
    const before = await projectSnapshot();
    const revision = await currentRevision();
    await expectProtocolError("agent/batch", {
      expectedRevision: revision - 1,
      operations: [{ type: "cmd/track.add", payload: { kind: "audio", name: "Stale" } }],
    }, "stale_revision");
    assert.equal(await currentRevision(), revision);
    assert.deepEqual(await projectSnapshot(), before);
  });

  await test("a failing second operation rolls back the first operation", async () => {
    const before = await projectSnapshot();
    const revision = await currentRevision();
    events.length = 0;
    await expectProtocolError("agent/batch", {
      expectedRevision: revision,
      operations: [
        {
          type: "cmd/track.add",
          payload: { kind: "audio", name: "Must Roll Back" },
          as: "temporary",
        },
        {
          type: "cmd/track.addSend",
          payload: {
            trackId: { $result: "temporary", pointer: "/track/id" },
            destTrackId: 999999999,
            level: 0.5,
          },
        },
      ],
    }, "bad_request");
    assert.equal(await currentRevision(), revision);
    assert.deepEqual(await projectSnapshot(), before);
    assert.equal(events.filter(({ type }) => type === "event/projectChanged").length, 0);
  });

  await test("non-batchable operations and 65-operation batches are rejected", async () => {
    const before = await projectSnapshot();
    const revision = await currentRevision();
    await expectProtocolError("agent/batch", {
      expectedRevision: revision,
      operations: [{ type: "cmd/track.bounce", payload: { trackId } }],
    }, "batch_not_supported");
    await expectProtocolError("agent/batch", {
      expectedRevision: revision,
      operations: Array.from({ length: 65 }, (_, index) => ({
        type: "cmd/marker.add",
        payload: { beat: index, name: `Too many ${index}` },
      })),
    }, "bad_request");
    assert.equal(await currentRevision(), revision);
    assert.deepEqual(await projectSnapshot(), before);
  });

  await test("one undo reverts the complete two-operation batch", async () => {
    const revision = await currentRevision();
    await request("edit/undo", {});
    assert.equal(await currentRevision(), revision + 1);
    assert.deepEqual(await projectSnapshot(), baseProject);
  });

  await test("the exact 64-operation boundary is accepted atomically", async () => {
    const revision = await currentRevision();
    events.length = 0;
    const result = await batch({
      expectedRevision: revision,
      label: "Add 64 markers",
      operations: Array.from({ length: 64 }, (_, index) => ({
        type: "cmd/marker.add",
        payload: { beat: index, name: `Marker ${index}` },
      })),
    });
    assert.equal(result.results.length, 64);
    assert.equal(result.revision, revision + 1);
    const markers = await query({ view: "markers", fields: ["id", "beat", "name"], limit: 500 });
    assert.equal(markers.total, 64);
    assert.equal(events.filter(({ type }) => type === "event/projectChanged").length, 1);
    await request("edit/undo", {});
    assert.deepEqual(await projectSnapshot(), baseProject);
    await expectProtocolError("edit/undo", {}, "nothing_to_undo");
  });

  let builtinTrackId;
  let utilityInstanceId;
  await test("batch undo/redo restores first-edit built-in params and controls live", async () => {
    builtinTrackId = (await request("cmd/track.add", {
      kind: "audio",
      name: "Built-in Undo Probe",
    })).track.id;
    utilityInstanceId = (await request("cmd/plugin.add", {
      trackId: builtinTrackId,
      uid: "builtin:utility",
    })).instance.instanceId;

    const before = await query({
      view: "plugin_instances",
      where: { instanceId: utilityInstanceId },
      fields: ["instanceId", "uid", "bypass", "wetDry", "parameterValueCount", "live"],
    });
    assert.deepEqual(before.items, [{
      instanceId: utilityInstanceId,
      uid: "builtin:utility",
      bypass: false,
      wetDry: 1,
      parameterValueCount: 0,
      live: true,
    }]);

    const params = await query({
      view: "plugin_params",
      where: { instanceId: utilityInstanceId },
      fields: ["id", "name", "value", "defaultValue", "source"],
      limit: 64,
    });
    const gain = params.items.find(({ name }) => name === "Gain");
    assert(gain, "builtin:utility did not expose its Gain parameter");
    assert.equal(gain.source, "live");
    const oldGain = gain.value;
    const newGain = oldGain > 0.2 ? 0.2 : 0.8;
    const paramChange = await batch({
      expectedRevision: params.revision,
      label: "Change first utility parameter",
      operations: [{
        type: "cmd/plugin.setParam",
        payload: { instanceId: utilityInstanceId, paramId: gain.id, value: newGain },
      }],
    });
    assert.equal(paramChange.revision, params.revision + 1);
    const readGain = async () => {
      const result = await query({
        view: "plugin_params",
        where: { instanceId: utilityInstanceId, paramId: gain.id },
        fields: ["id", "value", "source"],
      });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].source, "live");
      return result.items[0].value;
    };
    assert(Math.abs((await readGain()) - newGain) < 1e-6);

    await request("edit/undo", {});
    assert(Math.abs((await readGain()) - oldGain) < 1e-6);
    let instanceState = await query({
      view: "plugin_instances",
      where: { instanceId: utilityInstanceId },
      fields: ["parameterValueCount", "live"],
    });
    assert.deepEqual(instanceState.items, [{ parameterValueCount: 0, live: true }]);

    await request("edit/redo", {});
    assert(Math.abs((await readGain()) - newGain) < 1e-6);
    await request("edit/undo", {});
    assert(Math.abs((await readGain()) - oldGain) < 1e-6);

    const revision = await currentRevision();
    const changed = await batch({
      expectedRevision: revision,
      label: "Change utility controls",
      operations: [{
        type: "cmd/plugin.set",
        payload: {
          instanceId: utilityInstanceId,
          patch: { bypass: true, wetDry: 0.25 },
        },
      }],
    });
    assert.equal(changed.revision, revision + 1);
    const applied = await query({
      view: "plugin_instances",
      where: { instanceId: utilityInstanceId },
      fields: ["bypass", "wetDry", "live"],
    });
    assert.deepEqual(applied.items, [{ bypass: true, wetDry: 0.25, live: true }]);

    await request("edit/undo", {});
    const restored = await query({
      view: "plugin_instances",
      where: { instanceId: utilityInstanceId },
      fields: ["bypass", "wetDry", "live"],
    });
    assert.deepEqual(restored.items, [{ bypass: false, wetDry: 1, live: true }]);
    instanceState = await query({
      view: "plugin_instances",
      where: { instanceId: utilityInstanceId },
      fields: ["parameterValueCount", "live"],
    });
    assert.deepEqual(instanceState.items, [{ parameterValueCount: 0, live: true }]);
  });

  await test("EQ is queryable immediately and undo restores the previous coefficients", async () => {
    const revision = await currentRevision();
    const band = { enabled: true, type: 0, freqHz: 1200, gainDb: 6, q: 1.25 };
    const changed = await batch({
      expectedRevision: revision,
      label: "Set probe EQ",
      operations: [{
        type: "cmd/track.setEq",
        payload: { trackId: builtinTrackId, patch: { bypass: false, bands: [band] } },
      }],
    });
    assert.equal(changed.revision, revision + 1);
    const applied = await query({
      view: "track",
      where: { trackId: builtinTrackId },
      fields: ["id", "eq"],
    });
    assert.deepEqual(applied.items, [{
      id: builtinTrackId,
      eq: { bypass: false, bands: [band] },
    }]);

    await request("edit/undo", {});
    const restored = await query({
      view: "track",
      where: { trackId: builtinTrackId },
      fields: ["id", "eq"],
    });
    assert.deepEqual(restored.items, [{
      id: builtinTrackId,
      eq: { bypass: false, bands: [] },
    }]);

    // Remove the setup plugin and track; both were ordinary commands before the probes.
    await request("edit/undo", {});
    await request("edit/undo", {});
    assert.deepEqual(await projectSnapshot(), baseProject);
  });

  await test("the existing WebSocket remains healthy after expected failures", async () => {
    const status = await request("engine/getStatus", {});
    assert.equal(status.running, true);
    const summary = await query({ view: "project_summary", fields: ["trackCount", "markerCount"] });
    assert.deepEqual(summary.items, [{ trackCount: 1, markerCount: 0 }]);
  });
}

try {
  await main();
  console.log(`\n${passed} agent engine integration checks passed`);
} catch (error) {
  console.error(`\n[FAIL] ${error.stack ?? error}`);
  if (stderrTail) console.error(`\nEngine stderr tail:\n${stderrTail}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
