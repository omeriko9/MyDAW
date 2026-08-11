#!/usr/bin/env node
/**
 * Punch in/out test (SPEC §5.3 / §6, ROADMAP Phase 3).
 *
 *   node scripts/punch-test.mjs [--port 8567]
 *
 * The punch region gates whether the recorder CAPTURES; it never moves the playhead. The
 * gate lives in AudioGraph's per-span loop, so it inherits the span splitting the loop and
 * arranger already do, and a punch boundary landing mid-block simply shortens that span's
 * contribution.
 *
 * WHY THE ASSERTIONS CAN BE EXACT: `--null-input` synthesizes a 1 Hz sawtooth whose period
 * is the sample rate, so the captured audio is position-recoverable. A punch window of a
 * known length must produce EXACTLY that many frames — not "about" that many — which is
 * the only way to tell a correct sample-accurate gate from one that is a block out.
 *
 * The boundary arithmetic is deliberately chosen to be block-aligned at 120 bpm / 48 kHz,
 * because that is precisely the case that broke the loop wrap before (f9a5309): an edge
 * detector `pos < end && pos+frames > end` never fires when the boundary is exactly on a
 * block edge. punchSpan() is an interval intersection for that reason, and this test would
 * catch a regression to an edge test.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8567"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-punch-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

function wavFrames(file) {
  const b = readFileSync(file);
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12) };
    if (id === "data") {
      const bytes = Math.min(sz, b.length - off - 8);
      return { frames: bytes / (fmt.ch * 4), fmt, first: b.readFloatLE(off + 8) };
    }
    off += 8 + sz + (sz & 1);
  }
  return null;
}

const engine = spawn(
  path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT), "--null-input", "2"],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: TMP } },
);
engine.stderr.on("data", () => {});
const cleanup = () => {
  try { spawnSync("taskkill", ["/F", "/PID", String(engine.pid)], { stdio: "ignore" }); } catch { /* gone */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* log file may linger */ }
};
const die = (code, msg) => { console.log(msg); cleanup(); setTimeout(() => process.exit(code), 400); };

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(400); }
}
if (!up) die(2, "engine failed to boot");

let nextId = 1;
const pending = new Map();
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
sock.onmessage = (m) => {
  const j = JSON.parse(m.data);
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

/** One record pass; returns {clips, takeFrames}. */
async function recordPass(project, trackId, ms) {
  await req("transport/locate", { beat: 0 });
  await req("transport/record", {});
  await sleep(ms);
  await req("transport/stop", {});
  await sleep(900);
  const hello = await req("session/hello", {});
  const clips = (hello.payload.project.tracks.find((t) => t.id === trackId).clips) ?? [];
  const dir = path.join(project, "audio");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wav")) : [];
  const takes = files.map((f) => ({ f, ...wavFrames(path.join(dir, f)) }));
  return { clips, takes };
}

try {
  await req("session/hello", { clientName: "punch" });
  const SR = (await req("engine/getStatus")).payload.sampleRate;
  const PROJECT = path.join(TMP, "P.mydaw");
  await req("project/new", {});
  const track = (await req("cmd/track.add", { kind: "audio", name: "Cap" })).payload.track;
  await req("project/saveAs", { path: PROJECT });

  // 120 bpm: 1 beat = 0.5 s = 24000 frames at 48 kHz. Beats 2..4 is exactly 48000 frames,
  // and both boundaries land on a 64-frame block edge — the case that broke the loop wrap.
  const BPS = 2; // beats per second at 120 bpm
  const framesPerBeat = SR / BPS;
  const PUNCH_IN = 2, PUNCH_OUT = 4;
  const expectFrames = (PUNCH_OUT - PUNCH_IN) * framesPerBeat;

  const set = await req("cmd/punch.set", { startBeat: PUNCH_IN, endBeat: PUNCH_OUT, enabled: true });
  report("cmd/punch.set is accepted", set.ok, JSON.stringify(set.error ?? {}));

  const tp = (await req("transport/pause")).payload;
  report("the transport reports the punch region", !!tp.punch && tp.punch.enabled === true &&
    Math.abs(tp.punch.startBeat - PUNCH_IN) < 1e-9 && Math.abs(tp.punch.endBeat - PUNCH_OUT) < 1e-9,
    JSON.stringify(tp.punch));

  await req("cmd/track.set", { trackId: track.id, patch: { recordArm: true } });
  await sleep(400);

  // Record from beat 0 well past the punch-out, so both boundaries are crossed.
  const r1 = await recordPass(PROJECT, track.id, 3200);
  report("one clip was committed", r1.clips.length === 1,
    JSON.stringify(r1.clips.map((c) => ({ start: c.startBeat, len: c.lengthSamples }))));
  if (r1.clips.length !== 1) die(1, "no clip");

  // THE punch-in assertion: record was pressed at beat 0, but nothing was captured until
  // the punch point, so the clip is anchored there — not where the button was pressed.
  report("the clip starts at the punch-IN point, not where record was pressed",
    Math.abs(r1.clips[0].startBeat - PUNCH_IN) < 1e-9,
    `startBeat=${r1.clips[0].startBeat}, expected ${PUNCH_IN}`);

  // THE punch-out assertion, and the reason the ramp exists: exact, not approximate.
  report("exactly the punch window was captured",
    r1.clips[0].lengthSamples === expectFrames,
    `${r1.clips[0].lengthSamples} frames, expected exactly ${expectFrames}`);
  report("the take file holds exactly that many frames too",
    r1.takes.length === 1 && r1.takes[0].frames === expectFrames,
    r1.takes.map((t) => `${t.f}=${t.frames}`).join(", "));

  // Disabling punch must restore ordinary whole-pass recording.
  await req("cmd/punch.set", { startBeat: PUNCH_IN, endBeat: PUNCH_OUT, enabled: false });
  const r2 = await recordPass(PROJECT, track.id, 1500);
  const newClip = r2.clips.find((c) => Math.abs(c.startBeat) < 1e-9);
  report("with punch disabled, recording starts where record was pressed", !!newClip,
    JSON.stringify(r2.clips.map((c) => ({ start: c.startBeat, len: c.lengthSamples }))));
  report("and it captures far more than the punch window would have",
    !!newClip && newClip.lengthSamples > expectFrames * 0.5 &&
      Math.abs(newClip.startBeat) < 1e-9,
    newClip ? `${newClip.lengthSamples} frames from beat ${newClip.startBeat}` : "no clip at 0");

  // An empty region can never be enabled — otherwise it would gate every sample out and
  // present as a dead record button (SPEC §10).
  await req("cmd/punch.set", { startBeat: 5, endBeat: 5, enabled: true });
  const tp2 = (await req("transport/pause")).payload;
  report("a zero-width punch region refuses to enable", tp2.punch?.enabled === false,
    JSON.stringify(tp2.punch));

  /* ---- multi-lap punch: the case the segment ledger exists for -------------------- */
  // A cycle crosses the punch window once per lap. The old commit derived laps from
  // arithmetic — laps = ceil(frames/loopLen), srcOffset = k*loopLen — which assumed the
  // take began at the loop start and ran continuously. With punch that is plainly wrong:
  // here it would compute loopLen 96000, frames ~72000, laps 1, and emit ONE oversized
  // clip at the wrong position. The ledger records each contiguous run instead.
  await req("cmd/loop.set", { startBeat: 0, endBeat: 4, enabled: true });
  await req("cmd/punch.set", { startBeat: 1, endBeat: 2, enabled: true });
  const lapFrames = 1 * framesPerBeat; // the punch window is one beat
  // Identify the new clips by ID, not by index: clips are kept sorted by start beat, so
  // a pass that records EARLIER than existing material lands mid-array, not at the tail.
  const beforeIds = new Set((((await req("session/hello", {})).payload.project.tracks
    .find((t) => t.id === track.id).clips) ?? []).map((c) => c.id));
  const r3 = await recordPass(PROJECT, track.id, 5200); // ~2.5 cycles
  const tr3 = (await req("session/hello", {})).payload.project.tracks.find((t) => t.id === track.id);
  // Take folders were removed on 2026-08-11 — laps land as plain clips. The point of this
  // check is unchanged: the ledger must SPLIT the punch windows into one clip per lap.
  const lapClips = (tr3.clips ?? []).filter((c) => !beforeIds.has(c.id));
  report("cycle + punch records one clip per lap", lapClips.length >= 2,
    `newClips=${lapClips.length}`);

  if (lapClips.length >= 2) {
    const clips = lapClips;
    report("every lap is anchored at the punch-IN point",
      clips.every((c) => Math.abs(c.startBeat - 1) < 1e-9),
      JSON.stringify(clips.map((c) => c.startBeat)));
    report("every lap captured exactly the punch window",
      clips.every((c) => c.lengthSamples === lapFrames),
      `${JSON.stringify(clips.map((c) => c.lengthSamples))}, expected all ${lapFrames}`);
    // The runs are consecutive in the FILE even though they are not on the timeline —
    // which is exactly the distinction the ledger keeps and the old arithmetic lost.
    const offs = clips.map((c) => c.srcOffsetSamples);
    report("laps read consecutive regions of the one take file",
      offs.every((o, i) => o === i * lapFrames), JSON.stringify(offs));
  }
  await req("cmd/loop.set", { startBeat: 0, endBeat: 8, enabled: false });
  await req("cmd/punch.set", { startBeat: 0, endBeat: 0, enabled: false });

  // Persistence: punch is part of the project, like the loop.
  await req("cmd/punch.set", { startBeat: 1, endBeat: 3, enabled: true });
  await req("project/saveAs", { path: PROJECT });
  const saved = JSON.parse(readFileSync(path.join(PROJECT, "project.json"), "utf8"));
  report("punch is saved with the project",
    saved.punch && saved.punch.enabled === true && saved.punch.startBeat === 1 &&
      saved.punch.endBeat === 3, JSON.stringify(saved.punch));
  await req("project/load", { path: PROJECT });
  const tp3 = (await req("transport/pause")).payload;
  report("and reaches the transport again on load",
    tp3.punch?.enabled === true && Math.abs(tp3.punch.startBeat - 1) < 1e-9,
    JSON.stringify(tp3.punch));
} catch (e) {
  report("harness completed", false, e?.stack ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
