#!/usr/bin/env node
/**
 * Crash-recovery test.
 *
 *   node scripts/recovery-test.mjs [--port 8565]
 *
 * The path that runs after the engine dies with unsaved work — and the only data-loss
 * surface in the project with no test at all. Seventeen harnesses call project/saveAs or
 * project/load as setup; none of them had ever asked for recoveryInfo.
 *
 * The mechanism (ProjectIO): a session.lock is written next to the settings and deleted on
 * clean shutdown, so finding one at startup means the previous run died. Recovery then
 * offers the NEWEST <project>/autosave/project-N.json, falling back to the saved
 * project.json when no autosave exists. Autosave itself is timer-driven — every
 * settings.autosaveMinutes while the project is dirty — with no manual trigger, which is
 * why this harness is slow: the interval is an int in MINUTES, so 1 is the floor.
 *
 * What is actually asserted, in order of what a user would lose:
 *   1. a fresh profile offers no recovery (or the whole thing is vacuous)
 *   2. after a HARD kill, recovery is offered and points at the AUTOSAVE, not project.json
 *   3. recover() returns the edits that were never saved — the assertion that carries the
 *      bug, checked against the saved file, which still holds the older state
 *   4. after a CLEAN shutdown, no recovery is offered
 *
 * The engine is killed by PID with taskkill /F — never by image name, which would take a
 * live MyDAW session with it. Everything runs under a redirected APPDATA.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8565"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-recov-"));
const APPDATA = path.join(TMP, "appdata");
const PROJECT = path.join(TMP, "Recovered.mydaw");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

/* --------------------------------------------------------------- engine control */

const live = new Set();
function startEngine(extra = []) {
  const p = spawn(
    path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
    ["--driver", "null", "--no-browser", "--port", String(PORT), ...extra],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA } },
  );
  p.stderr.on("data", () => { /* drained: an unread pipe deadlocks the engine at ~4 KB */ });
  live.add(p);
  return p;
}
/** TerminateProcess — no shutdown path, so session.lock survives. This IS the crash. */
function hardKill(proc) {
  spawnSync("taskkill", ["/F", "/PID", String(proc.pid)], { stdio: "ignore" });
  live.delete(proc);
}
async function waitUp(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return true; } catch { /* not yet */ }
    await sleep(300);
  }
  return false;
}
async function waitDown(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await fetch(`http://127.0.0.1:${PORT}/`); } catch { return true; }
    await sleep(500);
  }
  return false;
}

/** One request/reply socket. Returns { req, close }. */
async function connect() {
  let nextId = 1;
  const pending = new Map();
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => {
    sock.onopen = res;
    sock.onerror = () => rej(new Error("ws connect failed"));
    setTimeout(() => rej(new Error("ws connect timeout")), 10000);
  });
  sock.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.replyTo == null) return;
    const p = pending.get(j.replyTo);
    if (!p) return;
    pending.delete(j.replyTo);
    p.res(j.ok ? { ok: true, payload: j.payload ?? {} } : { ok: false, error: j.error ?? {} });
  };
  const req = (type, payload = {}, ms = 60000) => {
    const id = nextId++;
    sock.send(JSON.stringify({ id, type, payload }));
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      setTimeout(() => { if (pending.delete(id)) rej(new Error(type + ": timeout")); }, ms);
    });
  };
  return { req, close: () => { try { sock.close(); } catch { /* already gone */ } } };
}

const cleanup = () => {
  for (const p of live) { try { spawnSync("taskkill", ["/F", "/PID", String(p.pid)], { stdio: "ignore" }); } catch { /* gone */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
};
const die = (code, msg) => { console.log(msg); cleanup(); setTimeout(() => process.exit(code), 300); };

const autosaveFiles = () => {
  const dir = path.join(PROJECT, "autosave");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^project-\d+\.json$/.test(f));
};
const trackCount = (payload) => (payload.project?.tracks ?? []).length;

/* ------------------------------------------------------------------------ run */

try {
  // autosaveMinutes is read at startup, so the settings file has to exist first.
  mkdirSync(path.join(APPDATA, "MyDAW"), { recursive: true });
  writeFileSync(path.join(APPDATA, "MyDAW", "settings.json"),
    JSON.stringify({ autosaveMinutes: 1, port: PORT }, null, 2), "utf8");

  /* --- 1. a fresh profile must not offer recovery ------------------------------- */
  let eng = startEngine();
  if (!await waitUp()) die(2, "engine failed to boot");
  let c = await connect();
  await c.req("session/hello", { clientName: "recov" });
  let info = await c.req("project/recoveryInfo");
  report("a fresh profile offers no recovery", info.payload.available === false,
    JSON.stringify(info.payload));

  /* --- 2. save a project, then make edits that are NEVER saved ------------------ */
  await c.req("project/new", {});
  await c.req("cmd/track.add", { kind: "audio", name: "Saved A" });
  await c.req("cmd/track.add", { kind: "audio", name: "Saved B" });
  const saveReply = await c.req("project/saveAs", { path: PROJECT });
  if (!saveReply.ok) die(2, "saveAs failed: " + JSON.stringify(saveReply.error));
  const savedCount = trackCount((await c.req("session/hello", {})).payload);
  report("the project saved with its tracks", savedCount === 2, `tracks=${savedCount}`);

  // These exist only in memory and in whatever autosave writes.
  await c.req("cmd/track.add", { kind: "midi", name: "Unsaved C" });
  await c.req("cmd/track.add", { kind: "midi", name: "Unsaved D" });
  const dirtyCount = trackCount((await c.req("session/hello", {})).payload);
  report("the unsaved edits are in memory", dirtyCount === 4, `tracks=${dirtyCount}`);

  // Autosave is timer-driven with a 1-minute floor; poll rather than sleep blindly.
  console.log("    waiting for the autosave timer (60 s floor)...");
  const t0 = Date.now();
  while (autosaveFiles().length === 0 && Date.now() - t0 < 150000) await sleep(2000);
  const files = autosaveFiles();
  report("autosave captured the dirty project", files.length > 0,
    files.length ? `${files.join(", ")} after ${Math.round((Date.now() - t0) / 1000)}s`
                 : "no autosave appeared within 150s");
  if (files.length === 0) die(1, "cannot test recovery without an autosave");

  /* --- 3. CRASH ---------------------------------------------------------------- */
  c.close();
  hardKill(eng);
  if (!await waitDown()) die(2, "engine did not die");

  eng = startEngine();
  if (!await waitUp()) die(2, "engine failed to restart");
  c = await connect();
  const hello = await c.req("session/hello", { clientName: "recov" });
  info = await c.req("project/recoveryInfo");

  report("a hard kill leaves recovery on offer", info.payload.available === true,
    JSON.stringify(info.payload));
  report("recovery points at the AUTOSAVE, not the saved project.json",
    typeof info.payload.autosavePath === "string" &&
      info.payload.autosavePath.replace(/\\/g, "/").includes("/autosave/"),
    String(info.payload.autosavePath));
  // The restarted engine must NOT already be holding the unsaved work, or step 4 proves nothing.
  report("the restarted engine did not silently already have the edits",
    trackCount(hello.payload) !== 4, `tracks on restart=${trackCount(hello.payload)}`);

  /* --- 4. the edits that were never saved come back ----------------------------- */
  const rec = await c.req("project/recover");
  report("project/recover succeeds", rec.ok, JSON.stringify(rec.error ?? {}));
  const names = (rec.payload.project?.tracks ?? []).map((t) => t.name);
  report("recovery returns the work that was NEVER saved",
    names.includes("Unsaved C") && names.includes("Unsaved D"),
    `tracks=${JSON.stringify(names)}`);
  report("...and the saved tracks too", names.includes("Saved A") && names.includes("Saved B"),
    `tracks=${JSON.stringify(names)}`);

  // The file on disk still holds the OLDER state — so recovery really did return newer
  // material rather than just reloading what was saved.
  const loaded = await c.req("project/load", { path: PROJECT });
  const loadedNames = (loaded.payload.project?.tracks ?? []).map((t) => t.name);
  report("the saved file still holds only the pre-crash state",
    loadedNames.length === 2 && !loadedNames.includes("Unsaved C"),
    `tracks=${JSON.stringify(loadedNames)}`);

  /* --- 5. a CLEAN shutdown must not offer recovery ------------------------------ */
  c.close();
  hardKill(eng);
  await waitDown();

  // --exit-when-idle self-terminates 15 s after its last client leaves, and that path runs
  // the real shutdown (clearSessionLock). It also disables autosave, which is fine here.
  eng = startEngine(["--exit-when-idle"]);
  if (!await waitUp()) die(2, "idle engine failed to boot");
  c = await connect();
  await c.req("session/hello", { clientName: "recov" });
  c.close();
  console.log("    waiting for the clean idle shutdown (15 s grace)...");
  const wentDown = await waitDown(60000);
  report("the idle engine shut itself down cleanly", wentDown);
  live.delete(eng);

  if (wentDown) {
    eng = startEngine();
    if (!await waitUp()) die(2, "engine failed to boot after clean shutdown");
    c = await connect();
    await c.req("session/hello", { clientName: "recov" });
    info = await c.req("project/recoveryInfo");
    report("a clean shutdown leaves NO recovery offer", info.payload.available === false,
      JSON.stringify(info.payload));
    c.close();
  }
} catch (e) {
  report("harness completed", false, e?.stack ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
