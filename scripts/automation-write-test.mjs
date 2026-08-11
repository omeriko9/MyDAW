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
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8555"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };

// ISOLATED %APPDATA%: this harness spawns a real engine, and an engine writes settings
// (audio device, PLUGIN FOLDERS), plugin-cache.json, recent.json, autosave data and a
// session.lock. Run against the developer's real profile it silently rewrites their DAW
// configuration — and a hard kill leaves a lock that makes their next launch "recover"
// this harness's throwaway project instead of their work.
const APPDATA_ISO = mkdtempSync(path.join(tmpdir(), "mydaw-iso-"));
const engine = spawn(path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] , env: { ...process.env, APPDATA: APPDATA_ISO } });
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

  /* ---- native-editor knob moves (plugin/feedParamEdit) --------------------------------
     A knob turned in the plugin's OWN editor reaches the engine as a paramEdited push with
     no gesture boundaries — the engine closes the gesture on silence. plugin/feedParamEdit
     is that same entry point, so this drives the real path (App::onPluginParamEdited ->
     CommandProcessor::captureNativeEditorParam -> the idle commit) without a plugin GUI. */
  const PID = 1; // builtin:utility param 1
  const fx = (await req("cmd/plugin.add", { trackId: trk2.id, uid: "builtin:utility" })).instance;
  const fxRef = `plugin:${fx.instanceId}:${PID}`;
  const paramOf = async (instanceId, id) =>
    (await req("plugin/getParams", { instanceId })).params?.find((q) => q.id === id)?.value;

  await req("transport/locate", { beat: 0 });
  await req("transport/play", {});
  const knob = [0.3, 0.45, 0.6, 0.75];
  for (const v of knob) { await req("plugin/feedParamEdit", { instanceId: fx.instanceId, paramId: PID, value: v }); await sleep(150); }
  // The gesture is still OPEN here (transient): nothing may be on the undo stack yet.
  const midProj = (await req("session/hello", { clientName: "auto" })).project;
  const midPts = laneOf(midProj, trk2.id, fxRef)?.points ?? [];
  report("native-editor knob writes points while the gesture is still open",
    midPts.length >= 3, `points=${midPts.length}`);

  await sleep(600); // > the 300 ms idle timer: the gesture commits
  await req("transport/stop", {});
  const fxProj = (await req("session/hello", { clientName: "auto" })).project;
  const fxPts = laneOf(fxProj, trk2.id, fxRef)?.points ?? [];
  const fxBeatsIncrease = fxPts.every((p, i) => i === 0 || p.beat >= fxPts[i - 1].beat);
  report("native-editor knob recorded into its plugin lane at advancing beats",
    fxPts.length >= 3 && fxBeatsIncrease && fxPts.some((p) => p.value >= 0.55),
    `points=${fxPts.length} beats=[${fxPts.map((p) => p.beat.toFixed(2)).join(",")}] vals=[${fxPts.map((p) => p.value.toFixed(2)).join(",")}]`);

  // The value must NOT be echoed back at the plugin — feedParamEdit reports, it does not set.
  // (The model still mirrors it, so getParams reflects the last reported value.)
  report("reported value mirrors into the instance without a set-back",
    Math.abs((await paramOf(fx.instanceId, PID)) - 0.75) < 1e-6,
    `param=${await paramOf(fx.instanceId, PID)}`);

  // ONE undo entry for the whole knob move: undo must clear the lane, not peel off a point.
  await req("edit/undo", {});
  const undoneProj = (await req("session/hello", { clientName: "auto" })).project;
  const undonePts = laneOf(undoneProj, trk2.id, fxRef)?.points ?? [];
  report("one undo takes back the whole native-editor gesture",
    undonePts.length === 0, `points after undo=${undonePts.length}`);

  // write OFF → a native-editor knob records nothing
  await req("transport/setAutomationWrite", { enabled: false });
  await req("transport/play", {});
  for (const v of [0.1, 0.2]) { await req("plugin/feedParamEdit", { instanceId: fx.instanceId, paramId: PID, value: v }); await sleep(120); }
  await sleep(500);
  await req("transport/stop", {});
  const offProj = (await req("session/hello", { clientName: "auto" })).project;
  const offPts = laneOf(offProj, trk2.id, fxRef)?.points ?? [];
  report("write OFF ignores native-editor knob moves", offPts.length === 0, `points=${offPts.length}`);

  /* ---- per-track "W" arm, with the GLOBAL transport arm OFF -------------------------
     The transport pencil is a master switch; a track's own W arms just that track. This
     is the arm the track header exposes, so it is the one most users actually press. */
  await req("transport/setAutomationWrite", { enabled: false });
  const wOn = (await req("cmd/track.add", { kind: "audio", name: "W-On" })).track;
  const wOff = (await req("cmd/track.add", { kind: "audio", name: "W-Off" })).track;
  await req("cmd/track.set", { trackId: wOn.id, patch: { automationWrite: true } });

  const armState = (await req("session/hello", { clientName: "auto" })).project
    .tracks.find((t) => t.id === wOn.id)?.automationWrite;
  report("per-track W round-trips through the project", armState === true, `automationWrite=${armState}`);

  await req("transport/locate", { beat: 0 });
  await req("transport/play", {});
  for (const v of [0.3, 0.55, 0.8]) {
    await send("cmd/track.set", { trackId: wOn.id, patch: { volume: v } }, true);
    await send("cmd/track.set", { trackId: wOff.id, patch: { volume: v } }, true);
    await sleep(150);
  }
  await send("cmd/track.set", { trackId: wOn.id, patch: { volume: 1.0 } }, false);
  await send("cmd/track.set", { trackId: wOff.id, patch: { volume: 1.0 } }, false);
  await req("transport/stop", {});

  const wProj = (await req("session/hello", { clientName: "auto" })).project;
  const wOnPts = laneOf(wProj, wOn.id, "volume")?.points ?? [];
  const wOffPts = laneOf(wProj, wOff.id, "volume")?.points ?? [];
  report("a track's own W records with the global arm OFF", wOnPts.length >= 3,
    `points=${wOnPts.length} vals=[${wOnPts.map((p) => p.value.toFixed(2)).join(",")}]`);
  report("an un-armed track stays untouched in the same pass", wOffPts.length === 0,
    `points=${wOffPts.length}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "AUTOMATION WRITE TEST: ALL PASS" : "AUTOMATION WRITE TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "AUTOMATION WRITE TEST: EXCEPTION\n" + elog.slice(-800));
}
