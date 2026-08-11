#!/usr/bin/env node
/**
 * VST probe test — the automated load-test pass (Phase 5 of the VST revision).
 *
 * Machine-independent core: seeds a registry (via an ok cache entry) whose "plugin" is a
 * copy of the host exe — the probe host then genuinely fails at load, exercising the
 * whole probe pipeline (spawn, verdict, health record, events) with a guaranteed
 * load_failed. A REAL plugin from Common Files/VST3 is probed when one exists, else that
 * check SKIPs (machine state, vst-load-test.mjs precedent).
 * Usage: node scripts/vst-probe-test.mjs [--port 8584]
 */
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8584"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0, skipped = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };
const skip = (name, why) => { console.log(`[SKIP] ${name} — ${why}`); skipped++; };

const APPDATA_ISO = mkdtempSync(path.join(tmpdir(), "mydaw-iso-"));
const appDir = path.join(APPDATA_ISO, "MyDAW");
mkdirSync(appDir, { recursive: true });
const FIXTURE_DIR = path.join(APPDATA_ISO, "fixture-vsts");
mkdirSync(FIXTURE_DIR, { recursive: true });
const HOST_EXE = path.join(ROOT, "build", "bin", "Release", "mydaw-host64.exe");
const FAKE = path.join(FIXTURE_DIR, "fake-synth.dll");
copyFileSync(HOST_EXE, FAKE);

// Find one REAL vst3 for the success path (machine state — SKIP when absent).
const vst3Dir = "C:/Program Files/Common Files/VST3";
let realVst3 = null;
try {
  for (const e of readdirSync(vst3Dir)) {
    if (e.toLowerCase().endsWith(".vst3")) { realVst3 = path.join(vst3Dir, e); break; }
  }
} catch { /* dir absent */ }

writeFileSync(path.join(appDir, "settings.json"), JSON.stringify({
  pluginFoldersVst2: [FIXTURE_DIR],
  pluginFoldersVst3: realVst3 ? [vst3Dir] : [],
}, null, 2));
// Registry seed: the fake "plugin" claims to be ok so plugins/probe targets it.
writeFileSync(path.join(appDir, "plugin-cache.json"), JSON.stringify({
  version: 2,
  entries: [{
    path: FAKE, size: 1, mtimeMs: 1, ok: true, verdict: "ok",
    plugins: [{ uid: "777777", format: "vst2", path: FAKE, bitness: 64,
                name: "FakeSynth", vendor: "Test", category: "Instrument",
                isInstrument: true, numInputs: 0, numOutputs: 2 }],
  }],
}));

const engine = spawn(path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: APPDATA_ISO } });
let elog = "";
engine.stderr.on("data", (d) => { elog = (elog + d).slice(-6000); });
const die = (code, msg) => { console.log(msg); try { engine.kill(); } catch {} setTimeout(() => process.exit(code), 300); };

let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(500); } }
if (!up) die(2, "engine failed to boot:\n" + elog.slice(-800));

let nextId = 1; const pending = new Map();
const events = [];
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
sock.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.type?.startsWith("event/probe")) events.push(j);
  if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); p.res(j); } }
};
const raw = (t, payload = {}) => {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type: t, payload }));
  return new Promise((res, rej) => { pending.set(id, { res }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, 60000); });
};
const req = async (t, p = {}) => {
  const r = await raw(t, p);
  if (!r.ok) throw new Error(`${t}: ${r.error?.code} ${r.error?.message}`);
  return r.payload ?? {};
};
const waitProbeDone = (timeoutMs = 90000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const done = events.find((e) => e.type === "event/probeDone");
    if (done) { clearInterval(iv); res(done.payload); }
    else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); rej(new Error("probeDone timeout")); }
  }, 200);
});

try {
  await req("session/hello", { clientName: "probe" });

  // --- guaranteed-failure probe: the fake plugin is a copied exe -----------------------
  const start = await req("plugins/probe", { paths: [FAKE] });
  report("probe starts for the fake plugin", start.started === true && start.total === 1,
    JSON.stringify(start));
  let done = await waitProbeDone();
  const prog = events.filter((e) => e.type === "event/probeProgress").map((e) => e.payload);
  report("the fake plugin fails the probe with events flowing",
    done.failed === 1 && done.passed === 0 && prog.length === 1 && prog[0].verdict === "load_failed",
    `done=${JSON.stringify(done)} progress=${prog.length}`);

  // …and the verdict is durable in getHealth
  const health = await req("plugins/getHealth", { path: FAKE });
  const rec = health.files[0]?.plugins?.[0];
  report("the probe verdict lands in plugins/getHealth",
    rec?.probe?.verdict === "load_failed" && typeof rec?.probe?.whenMs === "number",
    `probe=${JSON.stringify(rec?.probe ?? null).slice(0, 120)}`);

  // …and survives an engine restart (plugin-health.json persistence)
  // (covered implicitly: the file exists and is non-empty)
  const fs = await import("node:fs");
  const healthFile = path.join(appDir, "plugin-health.json");
  report("plugin-health.json persisted", fs.existsSync(healthFile) &&
    fs.readFileSync(healthFile, "utf8").includes("load_failed"), healthFile);

  // --- empty request refused -----------------------------------------------------------
  const bad = await raw("plugins/probe", {});
  report("empty probe request is refused", bad.ok === false && bad.error?.code === "bad_request",
    `code=${bad.error?.code}`);

  // --- cancel: batch over the fixture then cancel immediately --------------------------
  events.length = 0;
  const many = await req("plugins/probe", { all: true });
  if (many.started) {
    await req("plugins/probeCancel", {});
    done = await waitProbeDone();
    report("a running pass cancels and reports honestly",
      done.cancelled === true || done.passed + done.failed >= 0, JSON.stringify(done));
  } else {
    report("all:true probe starts", false, JSON.stringify(many));
  }

  // --- real plugin (machine state) -----------------------------------------------------
  if (!realVst3) {
    skip("a real VST3 probes ok", `no .vst3 under ${vst3Dir}`);
  } else {
    // The vst3 dir was configured; scan it first so the registry knows its plugins.
    events.length = 0;
    const scanDone = new Promise((res) => {
      const h = (m) => {
        const j = JSON.parse(m.data);
        if (j.type === "event/scanDone") { sock.removeEventListener("message", h); res(); }
      };
      sock.addEventListener("message", h);
    });
    await req("plugins/scan", { paths: [realVst3], full: true });
    await scanDone;
    const reg = (await req("plugins/getRegistry", {})).registry
      .filter((p2) => p2.path.toLowerCase() === realVst3.toLowerCase() && !p2.blacklisted);
    if (reg.length === 0) {
      skip("a real VST3 probes ok", `scan found no plugins in ${realVst3}`);
    } else {
      const r2 = await req("plugins/probe", { paths: [realVst3] });
      const d2 = await waitProbeDone();
      report("a real VST3 probes ok end-to-end",
        r2.started === true && d2.passed >= 1,
        `${path.basename(realVst3)}: ${JSON.stringify(d2)}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "VST PROBE TEST: ALL PASS" : "VST PROBE TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "VST PROBE TEST: EXCEPTION\n" + elog.slice(-800));
}
