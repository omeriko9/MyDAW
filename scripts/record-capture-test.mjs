#!/usr/bin/env node
/**
 * Headless record-capture test — the foundation Phase 3 stands on.
 *
 *   node scripts/record-capture-test.mjs [--port 8566]
 *
 * Until `--null-input N` existed, NO automated layer could exercise recording at all:
 * NullDriver::enumerate reported maxInputs = 0 and the callback passed (nullptr, 0), so a
 * headless engine had no capture source and every recording feature — punch, loop-record
 * takes, input metering — was verifiable only by hand. Four independent readings of the
 * subsystem flagged the same gap, and it is exactly the situation that hid earlier
 * recording bugs.
 *
 * The synthetic source is a 1 Hz sawtooth over [-1, 1), period == sampleRate. That is not
 * decoration: it is POSITION-RECOVERABLE, so from any captured sample you can recover its
 * absolute frame index modulo one second. A periodic tone would prove only that something
 * was recorded; this proves WHICH samples were, which is what sample-accurate punch in/out
 * will need to assert against.
 *
 * Asserted here:
 *   1. the engine opens a capture path when a track is armed (and not before)
 *   2. recording commits a clip whose length matches the wall-clock time recorded
 *   3. the written WAV is 32-bit float at the engine's rate, and NOT silence
 *   4. its samples are the ramp — consecutive deltas equal 2/sampleRate — which is what
 *      makes position assertions possible for the punch work that follows
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8566"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-reccap-"));
const PROJECT = path.join(TMP, "Captured.mydaw");
const RECORD_MS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

/** Walk RIFF chunks properly — reading at a guessed offset lands in the header. */
function readWav(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF") return null;
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "fmt ")
      fmt = { tag: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10),
              sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") return { fmt, off: off + 8, bytes: Math.min(sz, b.length - off - 8), buf: b };
    off += 8 + sz + (sz & 1);
  }
  return null;
}

const engine = spawn(
  path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT), "--null-input", "2"],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: TMP } },
);
let elog = "";
engine.stderr.on("data", (d) => { elog = (elog + d).slice(-4000); });
const cleanup = () => {
  try { spawnSync("taskkill", ["/F", "/PID", String(engine.pid)], { stdio: "ignore" }); } catch { /* gone */ }
  // The engine's own log file can still be held for a moment after the kill.
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
};
const die = (code, msg) => { console.log(msg); cleanup(); setTimeout(() => process.exit(code), 400); };

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(400); }
}
if (!up) die(2, "engine failed to boot:\n" + elog.slice(-800));

let nextId = 1;
const pending = new Map();
let lastCaptureState = null; // most recent event/captureState payload (SPEC §5.5 honesty)
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
sock.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.type === "event/captureState") lastCaptureState = j.payload;
  if (j.replyTo == null) return;
  const p = pending.get(j.replyTo);
  if (!p) return;
  pending.delete(j.replyTo);
  p(j.ok ? { ok: true, payload: j.payload ?? {} } : { ok: false, error: j.error ?? {} });
};
const req = (type, payload = {}, ms = 30000) => {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type, payload }));
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(type + ": timeout")); }, ms);
  });
};
/** Poll for the event/captureState we expect; returns the last one seen either way. */
const untilCapture = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(lastCaptureState)) return lastCaptureState;
    await sleep(50);
  }
  return lastCaptureState;
};

try {
  await req("session/hello", { clientName: "reccap" });
  const status = (await req("engine/getStatus")).payload;
  report("the engine is on the null driver", status.driver === "null",
    `driver=${status.driver} sr=${status.sampleRate}`);
  const SR = status.sampleRate;

  await req("project/new", {});
  const track = (await req("cmd/track.add", { kind: "audio", name: "Cap" })).payload.track;
  await req("project/saveAs", { path: PROJECT });

  // Arming is what opens the capture path (App::reconcileCaptureDevice).
  await req("cmd/track.set", { trackId: track.id, patch: { recordArm: true } });
  await sleep(500);

  await req("transport/locate", { beat: 0 });
  await req("transport/record", {});
  await sleep(RECORD_MS);
  await req("transport/stop", {});
  await sleep(900);

  const hello = await req("session/hello", {});
  const clips = (hello.payload.project.tracks.find((t) => t.id === track.id).clips) ?? [];
  report("recording committed exactly one clip", clips.length === 1,
    `clips=${JSON.stringify(clips.map((c) => ({ start: c.startBeat, len: c.lengthSamples })))}`);
  if (clips.length !== 1) die(1, "nothing was recorded — the capture path did not open");

  // Wall-clock, so generous: the point is "roughly what we recorded", not sample equality.
  const expected = (RECORD_MS / 1000) * SR;
  const got = clips[0].lengthSamples;
  report("the clip length matches the time recorded", got > expected * 0.5 && got < expected * 1.6,
    `${got} samples vs ~${Math.round(expected)} expected`);

  const dir = path.join(PROJECT, "audio");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wav")) : [];
  report("a take file was written", files.length === 1, files.join(", ") || "none");
  if (files.length !== 1) die(1, "no take file");

  const w = readWav(path.join(dir, files[0]));
  report("the take is 32-bit float at the engine's rate",
    !!w && w.fmt.tag === 3 && w.fmt.bits === 32 && w.fmt.sr === SR,
    w ? JSON.stringify(w.fmt) : "unparseable");

  const frames = w.bytes / (w.fmt.ch * 4);
  let peak = 0;
  for (let i = 0; i + 3 < w.bytes; i += 4) peak = Math.max(peak, Math.abs(w.buf.readFloatLE(w.off + i)));
  report("the take is NOT silence", peak > 0.5, `peak=${peak.toFixed(5)} over ${frames} frames`);

  // THE assertion that makes punch testable: consecutive ch0 samples differ by exactly one
  // ramp step, so any captured sample's phase gives its absolute frame index.
  const step = 2 / SR;
  const n = Math.min(512, frames);
  let bad = 0, wraps = 0;
  for (let i = 1; i < n; i++) {
    const a = w.buf.readFloatLE(w.off + (i - 1) * w.fmt.ch * 4);
    const b2 = w.buf.readFloatLE(w.off + i * w.fmt.ch * 4);
    const d = b2 - a;
    if (d < 0) { wraps++; continue; }          // the once-per-second sawtooth reset
    if (Math.abs(d - step) > step * 0.05) bad++;
  }
  report("the captured signal is the position-recoverable ramp", bad === 0 && wraps <= 1,
    `${n} samples checked, ${bad} off-step, ${wraps} wrap(s), step=${step.toExponential(3)}`);

  // Channel identity: ch1 is the same ramp at half amplitude.
  if (w.fmt.ch >= 2) {
    const c0 = w.buf.readFloatLE(w.off + 0);
    const c1 = w.buf.readFloatLE(w.off + 4);
    report("channel 1 is the same ramp at half amplitude",
      Math.abs(c1 * 2 - c0) < 1e-3, `ch0=${c0.toFixed(5)} ch1=${c1.toFixed(5)}`);
  }

  // ---- single-capture-endpoint honesty (SPEC §5.5 / §10) -----------------------------
  // v1 opens ONE endpoint: the first armed/monitoring audio track wins, and every armed
  // node is fed its buffer. A second armed track naming a DIFFERENT device would silently
  // record the winner's signal — so the engine must SAY so (event/captureState + hello),
  // which is what these pin down. Driver-independent: no reconfigure happens because the
  // winner does not change.
  report("hello carries captureState for the armed track",
    hello.payload.captureState?.deviceId === "default" &&
      hello.payload.captureState?.conflicts?.length === 0,
    JSON.stringify(hello.payload.captureState));

  const t2 = (await req("cmd/track.add", { kind: "audio", name: "Cap2" })).payload.track;
  lastCaptureState = null;
  await req("cmd/track.set",
    { trackId: t2.id, patch: { inputDevice: "Imaginary Input", recordArm: true } });
  const conflicted = await untilCapture((c) => c && c.conflicts.length > 0);
  report("arming a second track on another device raises the conflict",
    !!conflicted && conflicted.deviceId === "default" &&
      conflicted.conflicts.length === 1 &&
      conflicted.conflicts[0].trackId === t2.id &&
      conflicted.conflicts[0].device === "Imaginary Input" &&
      conflicted.error === undefined,
    JSON.stringify(conflicted));

  // Undo restores arm/input states WHOLESALE (syncEngineFromModel), which must reconcile
  // capture too — this failed silently before the hook moved there.
  lastCaptureState = null;
  await req("edit/undo", {});
  const cleared = await untilCapture((c) => c && c.conflicts.length === 0);
  report("undoing the arm clears the conflict (undo/load path reconciles)",
    !!cleared && cleared.deviceId === "default" && cleared.conflicts.length === 0,
    JSON.stringify(cleared));

  lastCaptureState = null;
  await req("cmd/track.set", { trackId: track.id, patch: { recordArm: false } });
  const closed = await untilCapture((c) => c && c.deviceId === "");
  report("unarming the last track reports capture closed",
    !!closed && closed.deviceId === "" && closed.conflicts.length === 0,
    JSON.stringify(closed));
} catch (e) {
  report("harness completed", false, e?.stack ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
