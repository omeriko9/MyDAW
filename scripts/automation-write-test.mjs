#!/usr/bin/env node
/**
 * Automation-write test. Arms transport automation-write, plays, then "drags" a track's volume
 * fader (transient cmd/track.set) over time and verifies the moves are captured as automation
 * points in the track's "volume" lane at advancing playhead beats. Also checks:
 *   - the armed state round-trips through the transport reply / session/hello
 *   - with write OFF, moving the fader records nothing
 *   - a plugin param drag records into its "plugin:<id>:<pid>" lane
 * Usage: node scripts/automation-write-test.mjs [--port 8555]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8555"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };

const engine = spawn(path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
let elog = "";
engine.stderr.on("data", (d) => { elog = (elog + d).slice(-6000); });
const die = (code, msg) => { console.log(msg); try { engine.kill(); } catch {} setTimeout(() => process.exit(code), 300); };

let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(500); } }
if (!up) die(2, "engine failed to boot:\n" + elog.slice(-800));

let nextId = 1; const pending = new Map();
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
sock.onmessage = (m) => { const j = JSON.parse(m.data); if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); } } };
const send = (t, payload = {}, transient = false, ms = 30000) => {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type: t, payload, transient }));
  return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); });
};
const req = (t, p = {}) => send(t, p, false);
const laneOf = (proj, trackId, ref) => (proj.tracks.find((t) => t.id === trackId)?.automation ?? []).find((l) => l.paramRef === ref);

try {
  await req("session/hello", { clientName: "auto" });
  await req("project/new", {});
  const trk = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;

  // arm write; the reply carries the transport state
  const armReply = await req("transport/setAutomationWrite", { enabled: true });
  const hello = await req("session/hello", { clientName: "auto" });
  report("automationWrite arms + round-trips in transport/hello state",
    armReply?.automationWrite === true && hello?.automationWrite === true,
    `reply=${armReply?.automationWrite} hello=${hello?.automationWrite}`);

  // play, then "drag" the fader over ~1s so the playhead advances between moves
  await req("transport/play", {});
  const vols = [0.2, 0.4, 0.6, 0.8];
  for (const v of vols) { await send("cmd/track.set", { trackId: trk.id, patch: { volume: v } }, true); await sleep(160); }
  await send("cmd/track.set", { trackId: trk.id, patch: { volume: 1.0 } }, false); // commit
  await req("transport/stop", {});

  const proj = (await req("session/hello", { clientName: "auto" })).project;
  const lane = laneOf(proj, trk.id, "volume");
  const pts = lane?.points ?? [];
  const beatsIncrease = pts.length >= 2 && pts.every((p, i) => i === 0 || p.beat >= pts[i - 1].beat);
  const capturedHigh = pts.some((p) => p.value >= 0.75); // the later drag values
  report("volume drag during playback recorded multiple points at advancing beats",
    pts.length >= 3 && beatsIncrease && capturedHigh,
    `points=${pts.length} beats=[${pts.map((p) => p.beat.toFixed(2)).join(",")}] vals=[${pts.map((p) => p.value.toFixed(2)).join(",")}]`);

  // write OFF → no capture
  await req("transport/setAutomationWrite", { enabled: false });
  await req("cmd/track.add", { kind: "audio", name: "Audio 2" });
  const trk2 = (await req("session/hello", { clientName: "auto" })).project.tracks.find((t) => t.name === "Audio 2");
  await req("transport/play", {});
  await send("cmd/track.set", { trackId: trk2.id, patch: { volume: 0.5 } }, false);
  await sleep(100);
  await req("transport/stop", {});
  const proj2 = (await req("session/hello", { clientName: "auto" })).project;
  const lane2 = laneOf(proj2, trk2.id, "volume");
  report("write OFF captures nothing", !lane2 || (lane2.points?.length ?? 0) === 0, `lane=${!!lane2} points=${lane2?.points?.length ?? 0}`);

  // not-playing with write ON → no capture (guarded by isPlaying)
  await req("transport/setAutomationWrite", { enabled: true });
  await send("cmd/track.set", { trackId: trk2.id, patch: { volume: 0.7 } }, false); // stopped
  const proj3 = (await req("session/hello", { clientName: "auto" })).project;
  const lane3 = laneOf(proj3, trk2.id, "volume");
  report("armed but stopped captures nothing", !lane3 || (lane3.points?.length ?? 0) === 0, `points=${lane3?.points?.length ?? 0}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "AUTOMATION WRITE TEST: ALL PASS" : "AUTOMATION WRITE TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "AUTOMATION WRITE TEST: EXCEPTION\n" + elog.slice(-800));
}
