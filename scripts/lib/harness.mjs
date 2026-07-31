/**
 * harness — the one correct way for a test to run an engine.
 *
 *   import { spawnEngine } from "./lib/harness.mjs";
 *   const e = await spawnEngine({ port: 8570 });
 *   try {
 *     await e.req("session/hello", { clientName: "mytest" });
 *     const p = (await e.req("cmd/track.add", { kind: "audio" })).payload.track;
 *   } finally {
 *     e.close();
 *   }
 *
 * WHY THIS EXISTS — a real incident, 2026-07-31.
 *
 * Eighteen harnesses spawned an engine with the developer's REAL %APPDATA%. An engine is
 * not a passive process: it writes settings (audio device AND plugin folders),
 * plugin-cache.json, recent.json, autosave slots, a session.lock, and renders into a
 * fallback media dir under the profile. Run that way they rewrote a live DAW install.
 *
 *   - vst-load-test called plugins/setFolders with vst2: [] and erased the user's VST2
 *     folder list. The registry is filtered to configured folders, so every VST2 plugin
 *     AND every favourite pointing at one disappeared (registry went to vst2=0 of 679).
 *   - stock-sampler-test saved a throwaway project to a temp dir and was hard-killed,
 *     leaving a session.lock pointing at it. The user's DAW crash-RECOVERED that fixture
 *     instead of their work, and autosaved it over their slots once a minute.
 *   - Cumulatively the harnesses left 1.6 GB of render/bounce output in the profile.
 *
 * Isolating APPDATA fixes all of it at once, including the media litter: the engine derives
 * its fallback media dir from the profile, so a redirected APPDATA redirects that too.
 *
 * Using this helper is the easy path. `scripts/harness-isolation-test.mjs` is the one that
 * makes it the ONLY path — it fails the gate if any harness spawns an engine without a
 * redirected APPDATA, whether or not it uses this module.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENGINE_EXE = path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn an engine with a throwaway profile and connect one request socket to it.
 *
 * @param {object}   opts
 * @param {number}   opts.port        WS/HTTP port. Pick one no other harness uses.
 * @param {string[]} [opts.args]      extra CLI args (e.g. ["--null-input","2"]).
 * @param {string}   [opts.driver]    default "null".
 * @param {number}   [opts.bootMs]    boot timeout, default 20000.
 * @param {boolean}  [opts.connect]   open the WS socket, default true.
 * @returns {Promise<Engine>} { proc, port, appdata, req, events, close, kill }
 */
export async function spawnEngine({ port, args = [], driver = "null", bootMs = 20000,
                                    connect = true } = {}) {
  if (!port) throw new Error("spawnEngine: a port is required");
  if (!existsSync(ENGINE_EXE)) throw new Error(`engine not built: ${ENGINE_EXE}`);

  // The whole point. Every profile-backed thing the engine writes lands in here.
  const appdata = mkdtempSync(path.join(tmpdir(), "mydaw-iso-"));

  const proc = spawn(
    ENGINE_EXE,
    ["--driver", driver, "--no-browser", "--port", String(port), ...args],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: appdata } },
  );
  // Drain stderr: an unread pipe deadlocks the engine once ~4 KB of log fills it, which
  // presents as a random request timeout much later.
  let log = "";
  proc.stderr.on("data", (d) => { log = (log + d).slice(-8000); });

  let up = false;
  const t0 = Date.now();
  while (!up && Date.now() - t0 < bootMs) {
    try { up = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { await sleep(250); }
  }
  if (!up) {
    try { spawnSync("taskkill", ["/F", "/PID", String(proc.pid)], { stdio: "ignore" }); } catch { /* gone */ }
    throw new Error(`engine failed to boot on ${port}:\n${log.slice(-800)}`);
  }

  let sock = null;
  let nextId = 1;
  const pending = new Map();
  const events = [];
  if (connect) {
    sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((res, rej) => {
      sock.onopen = res;
      sock.onerror = () => rej(new Error("ws connect failed"));
      setTimeout(() => rej(new Error("ws connect timeout")), 10000);
    });
    sock.onmessage = (m) => {
      const j = JSON.parse(m.data);
      if (j.replyTo == null) { if (j.type) events.push(j); return; }
      const p = pending.get(j.replyTo);
      if (!p) return;
      pending.delete(j.replyTo);
      // Rejection is a legitimate outcome to assert on, so hand back the verdict.
      p(j.ok ? { ok: true, payload: j.payload ?? {} } : { ok: false, error: j.error ?? {} });
    };
  }

  const kill = () => {
    // BY PID, never by image name: `taskkill /IM mydaw-engine.exe` once killed the
    // developer's live session mid-run.
    try { spawnSync("taskkill", ["/F", "/PID", String(proc.pid)], { stdio: "ignore" }); } catch { /* gone */ }
  };

  return {
    proc, port, appdata, events,
    enginePid: proc.pid,
    log: () => log,
    req(type, payload = {}, ms = 30000) {
      if (!sock) throw new Error("spawnEngine({connect:false}): no socket");
      const id = nextId++;
      sock.send(JSON.stringify({ id, type, payload }));
      return new Promise((res, rej) => {
        pending.set(id, res);
        setTimeout(() => { if (pending.delete(id)) rej(new Error(`${type}: timeout`)); }, ms);
      });
    },
    close() {
      try { sock?.close(); } catch { /* already gone */ }
      kill();
      // The engine's own log file can stay locked for a moment after the kill, so a
      // failure to remove the profile must not fail the test.
      try { rmSync(appdata, { recursive: true, force: true }); } catch { /* best effort */ }
    },
    kill,
  };
}
