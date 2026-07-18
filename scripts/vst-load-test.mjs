#!/usr/bin/env node
/**
 * Real-VST load test: scans the system VST3 folder, loads a real plugin instance
 * out-of-process, verifies it reaches state "ok", pulls its parameter list, and
 * runs the transport so the RT shared-memory bridge exchanges real blocks.
 * Usage: node scripts/vst-load-test.mjs [--plugin Omnisphere] [--port 8521]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8521"));
const WANT = argVal("--plugin", "Omnisphere").toLowerCase();
const VST2DIR = argVal("--vst2", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const engine = spawn(path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
let elog = "";
engine.stderr.on("data", (d) => { elog = (elog + d).slice(-6000); });
const die = (code, msg) => { console.log(msg); try { engine.kill(); } catch {} setTimeout(() => process.exit(code), 300); };

let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(500); } }
if (!up) die(2, "engine failed to boot:\n" + elog.slice(-800));

let nextId = 1; const pending = new Map(); const events = [];
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
sock.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); } }
  else events.push(j);
};
const req = (t, payload = {}, ms = 30000) => { const id = nextId++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };

await req("session/hello", { clientName: "vst-test" });
await req("project/new", {});
await req("plugins/setFolders", { vst2: VST2DIR ? [VST2DIR] : [], vst3: VST2DIR ? [] : ["C:/Program Files/Common Files/VST3"] });
console.log("scanning VST3 folder (sandboxed, 20s/file timeout)...");
await req("plugins/scan", { full: true });
const t0 = Date.now();
let registry = null;
while (Date.now() - t0 < 8 * 60_000) {
  const ev = events.shift();
  if (!ev) { await sleep(200); continue; }
  if (ev.type === "event/scanProgress") process.stdout.write(`  [${ev.payload.current}/${ev.payload.total}] ${path.basename(ev.payload.path ?? "")} (found ${ev.payload.found})\r`);
  if (ev.type === "event/scanDone") { registry = ev.payload.registry; break; }
}
if (!registry) die(1, "\nFAIL: scan did not complete in 8min");
console.log(`\nscan done: ${registry.length} plugins registered`);
for (const p of registry.slice(0, 12)) console.log(`  - ${p.name} (${p.vendor}) ${p.format}${p.blacklisted ? " [BLACKLISTED: " + (p.blacklistReason ?? "") + "]" : ""}`);

const target = registry.find((p) => p.name.toLowerCase().includes(WANT) && !p.blacklisted);
if (!target) die(1, `FAIL: '${WANT}' not in registry`);
console.log(`loading: ${target.name} (${target.vendor}), uid=${target.uid}`);

const track = (await req("cmd/track.add", { kind: "instrument", name: "VST Test" })).track;
events.length = 0;
const inst = (await req("cmd/plugin.add", { trackId: track.id, uid: target.uid }, 90_000)).instance;
console.log(`instance created: instanceId=${inst.instanceId}, name=${inst.name}`);

// wait for runtime state ok (host process spawned, plugin initialized)
let state = "loading";
const t1 = Date.now();
while (Date.now() - t1 < 60_000) {
  const ev = events.find((e) => e.type === "event/pluginState" && e.payload.instanceId === inst.instanceId);
  if (ev) { state = ev.payload.state; if (state !== "loading") break; events.splice(events.indexOf(ev), 1); }
  await sleep(250);
}
console.log(`plugin runtime state: ${state}`);

const params = (await req("plugin/getParams", { instanceId: inst.instanceId }, 30_000)).params;
console.log(`params: ${params.length}${params.length ? ` (first: "${params[0].name}" = ${params[0].valueText ?? params[0].value})` : ""}`);

// run the RT bridge for ~2s of blocks
events.length = 0;
await req("transport/play", {});
await sleep(2000);
await req("transport/stop", {});
const badState = events.find((e) => e.type === "event/pluginState" && ["crashed", "timeout", "failed"].includes(e.payload.state));
console.log(`RT bridge 2s run: ${badState ? "FAIL state=" + badState.payload.state : "stable (no crash/timeout events)"}`);

const ok = (state === "ok") && !badState; // some plugins (e.g. PlugSound) genuinely expose 0 params
die(ok ? 0 : 1, ok ? `\nVST LOAD TEST: PASS (${target.name} live out-of-process, ${params.length} params, bridge stable)` : "\nVST LOAD TEST: FAIL");
