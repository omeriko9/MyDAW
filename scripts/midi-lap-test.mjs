#!/usr/bin/env node
/**
 * MIDI cycle-record lap-splitting test.
 *
 *   node scripts/midi-lap-test.mjs [--port 8568]
 *
 * Audio has produced one clip per lap for longer; MIDI merged every lap into a
 * single clip (docs/STUBS.md: "MIDI loop-record isn't lap-split"), so three passes over the
 * same bar landed on top of each other with no way to choose between them.
 *
 * This could not be tested at all until `midi/feedEvent` existed: midimap/feedCc drives the
 * MAPPING path and never reaches MidiRecorder, so nothing in the repo could drive a MIDI
 * recording without physical hardware. feedEvent enters MidiInput's QPC-timestamped mirror
 * ring — the same door a winmm message comes through — so recording accuracy is
 * reconstructed from arrival time exactly as it is for a real keyboard.
 *
 * The lap boundaries are the cycle seams, which wrapTake() already reports.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8568"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-midilap-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

const engine = spawn(
  path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: TMP } },
);
engine.stderr.on("data", () => {});
const cleanup = () => {
  try { spawnSync("taskkill", ["/F", "/PID", String(engine.pid)], { stdio: "ignore" }); } catch { /* gone */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* log may linger */ }
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
const noteOn = (pitch, vel = 100) => req("midi/feedEvent", { status: 0x90, data1: pitch, data2: vel });
const noteOff = (pitch) => req("midi/feedEvent", { status: 0x80, data1: pitch, data2: 0 });

try {
  await req("session/hello", { clientName: "midilap" });

  // Reachability first: a bad status byte must be refused, not silently swallowed.
  const bad = await req("midi/feedEvent", { status: 0xF8, data1: 0, data2: 0 });
  report("a non-channel-voice status is refused", !bad.ok && bad.error?.code === "bad_request",
    JSON.stringify(bad.error ?? bad));

  await req("project/new", {});
  const track = (await req("cmd/track.add", { kind: "midi", name: "Keys" })).payload.track;
  await req("project/saveAs", { path: path.join(TMP, "M.mydaw") });

  // A 2-beat cycle at 120 bpm = 1 s per lap. Short, so several laps fit quickly.
  await req("cmd/loop.set", { startBeat: 0, endBeat: 2, enabled: true });
  await req("cmd/track.set", { trackId: track.id, patch: { recordArm: true } });
  await req("transport/locate", { beat: 0 });
  await req("transport/record", {});

  // One distinct note per lap, played mid-lap so it cannot straddle a seam.
  const LAPS = 3;
  const pitches = [60, 64, 67];
  for (let lap = 0; lap < LAPS; lap++) {
    await sleep(400);            // ~0.8 beats into the lap
    await noteOn(pitches[lap]);
    await sleep(200);
    await noteOff(pitches[lap]);
    await sleep(400);            // let the lap finish and wrap
  }
  await req("transport/stop", {});
  await sleep(900);

  const hello = await req("session/hello", {});
  const t = hello.payload.project.tracks.find((x) => x.id === track.id);
  // Laps land as ordinary clips carrying a take-lane index (SPEC §8.7, default record
  // mode Keep History): consecutive lanes, newest lap in front (unmuted), older laps
  // muted. What this suite exists for is unchanged — the recorder must SPLIT the laps
  // instead of merging them into one long clip; takes-record-test owns the mode matrix.
  const lapClips = t.clips ?? [];
  report("cycle-record produced one clip per lap, not one merged clip",
    lapClips.length >= 2,
    `clips=${lapClips.length} for ${LAPS} lap(s) played`);
  if (lapClips.length < 2) die(1, "laps were merged");

  // Each lap must hold its OWN note, not a copy of everything — that is the difference
  // between lap-splitting and merging.
  const perLap = lapClips.map((c) => (c.notes ?? []).map((n) => n.pitch).sort());
  report("each lap holds only the note played during that lap",
    perLap.every((ps) => ps.length === 1),
    JSON.stringify(perLap));
  const flat = perLap.flat().sort((a, b) => a - b);
  const wanted = pitches.slice(0, lapClips.length).sort((a, b) => a - b);
  report("the laps together hold every note played, once each",
    JSON.stringify(flat) === JSON.stringify(wanted),
    `got ${JSON.stringify(flat)}, played ${JSON.stringify(pitches)}`);

  // Notes are clip-relative to their OWN lap, so every lap starts near the cycle start
  // rather than accumulating an ever-growing offset.
  const starts = lapClips.map((c) => c.notes?.[0]?.startBeat ?? -1);
  report("every lap's note is re-based to its own lap start",
    starts.every((s) => s >= 0 && s < 2),
    JSON.stringify(starts.map((s) => Number(s.toFixed(3)))));

  report("all laps are anchored at the cycle start",
    lapClips.every((c) => Math.abs((c.startBeat ?? -1) - 0) < 1e-9),
    JSON.stringify(lapClips.map((c) => c.startBeat)));

  // Keep History (the default): laps stack on consecutive take lanes with only the
  // NEWEST lap audible — the SPEC §8.7 invariant for a freshly recorded stack.
  const lanes = lapClips.map((c) => c.lane ?? 0).sort((a, b) => a - b);
  report("laps occupy consecutive take lanes from 0",
    lanes.every((l, i) => l === i), JSON.stringify(lanes));
  const unmuted = lapClips.filter((c) => !c.muted);
  const maxLane = Math.max(...lapClips.map((c) => c.lane ?? 0));
  report("only the newest lap is audible",
    unmuted.length === 1 && (unmuted[0].lane ?? 0) === maxLane,
    JSON.stringify(lapClips.map((c) => ({ lane: c.lane ?? 0, muted: !!c.muted }))));
} catch (e) {
  report("harness completed", false, e?.stack ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
