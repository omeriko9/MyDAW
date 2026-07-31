#!/usr/bin/env node
/**
 * MIDI cycle-record lap-splitting test.
 *
 *   node scripts/midi-lap-test.mjs [--port 8568]
 *
 * Audio has produced one take per lap since comping shipped; MIDI merged every lap into a
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
  const folders = t.takeFolders ?? [];
  const clips = t.clips ?? [];

  report("cycle-record produced a take folder, not one merged clip",
    folders.length === 1,
    `folders=${folders.length} loose clips=${clips.length}`);
  if (folders.length !== 1) die(1, "no take folder — laps were merged");

  const lanes = folders[0].lanes ?? [];
  report("one lane per lap", lanes.length >= 2,
    `${lanes.length} lane(s) for ${LAPS} lap(s) played`);

  // Each lane must hold its OWN note, not a copy of everything — that is the difference
  // between lap-splitting and merging.
  const perLane = lanes.map((l) => (l.clips[0]?.notes ?? []).map((n) => n.pitch).sort());
  report("each lane holds only the note played during that lap",
    perLane.every((ps) => ps.length === 1),
    JSON.stringify(perLane));
  const flat = perLane.flat().sort((a, b) => a - b);
  const wanted = pitches.slice(0, lanes.length).sort((a, b) => a - b);
  report("the lanes together hold every note played, once each",
    JSON.stringify(flat) === JSON.stringify(wanted),
    `got ${JSON.stringify(flat)}, played ${JSON.stringify(pitches)}`);

  // Notes are clip-relative to their OWN lap, so every lap starts near the cycle start
  // rather than accumulating an ever-growing offset.
  const starts = lanes.map((l) => l.clips[0]?.notes?.[0]?.startBeat ?? -1);
  report("every lap's note is re-based to its own lap start",
    starts.every((s) => s >= 0 && s < 2),
    JSON.stringify(starts.map((s) => Number(s.toFixed(3)))));

  report("all lanes are anchored at the cycle start",
    lanes.every((l) => Math.abs((l.clips[0]?.startBeat ?? -1) - 0) < 1e-9),
    JSON.stringify(lanes.map((l) => l.clips[0]?.startBeat)));
} catch (e) {
  report("harness completed", false, e?.stack ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
