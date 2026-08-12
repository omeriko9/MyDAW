#!/usr/bin/env node
/**
 * Hardware MIDI output test (SPEC §5.5, ROADMAP Phase 5 "MIDI hardware output").
 *
 *   node scripts/midi-out-test.mjs [--port 8573]
 *
 * There is no loopback to assert audio against, so the observable is the engine's own
 * delivery counter: midi/getOutputs reports `sent` = short messages ACTUALLY handed to
 * the device since it opened.
 *
 * The device is the engine's SYNTHETIC sink (--null-midi-out): it counts events and
 * sends nothing. Previously this test picked the first real port, which on Windows is
 * the GS Wavetable Synth — so every gate run played its notes out loud through the
 * user's speakers (reported 2026-08-12). The null sink also removes the old SKIP path:
 * the suite no longer depends on the machine having any MIDI hardware at all.
 *
 * Covered: device enumeration, Track.midiOutDevice patch (midi/instrument only —
 * audio tracks refuse), playback events reaching the device (baked path through
 * TrackNode's originate-tap), transport-stop note hygiene (allNotesOff bumps `sent`),
 * and save/load persistence of the routing.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8573"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-midiout-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

const engine = spawn(
  path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--null-midi-out", "--no-browser", "--port", String(PORT)],
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
  const d = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
  if (d.replyTo === undefined) return;
  const p = pending.get(d.replyTo);
  if (!p) return;
  pending.delete(d.replyTo);
  d.ok === false ? p.rej(new Error(`${p.t}: ${d.error?.code ?? "error"} ${d.error?.message ?? ""}`)) : p.res(d.payload ?? {});
};
const req = (t, payload = {}, ms = 120000) => {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type: t, payload }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej, t });
    setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms);
  });
};

try {
  await req("session/hello", { clientName: "midiout" });
  await req("project/new", {});

  /* ---- 1. enumeration ---- */
  const list1 = (await req("midi/getOutputs", {})).outputs;
  if (!Array.isArray(list1)) die(1, "midi/getOutputs returned no outputs array");
  // The synthetic sink must be there — the engine was started with --null-midi-out —
  // and the test targets ONLY it, so no audible synth is ever opened. Its absence is a
  // real failure (the flag or the device list broke), not a reason to skip.
  const dev = list1.find((d) => d.name === "Null Output (MyDAW)");
  report("the null MIDI sink is offered under --null-midi-out",
    !!dev, `${list1.length} device(s): ${list1.map((d) => d.name).join(", ")}`);
  if (!dev) die(1, "no null MIDI output — nothing safe to send to");
  report("midi/getOutputs lists devices", list1.every((d) => typeof d.name === "string" && typeof d.sent === "number"),
    `${list1.length}: ${list1.map((d) => d.name).join(", ")}`);
  report("devices start closed with sent=0", list1.every((d) => !d.open && d.sent === 0));

  /* ---- 2. routing patch: midi/instrument only ---- */
  const midiTrack = (await req("cmd/track.add", { kind: "midi", name: "Outboard" })).track;
  await req("cmd/track.set", { trackId: midiTrack.id, patch: { midiOutDevice: dev.name } });
  const audioTrack = (await req("cmd/track.add", { kind: "audio", name: "NoMidi" })).track;
  let refused = false;
  try { await req("cmd/track.set", { trackId: audioTrack.id, patch: { midiOutDevice: dev.name } }); }
  catch { refused = true; }
  report("audio track refuses midiOutDevice", refused);

  // The structural rebuild resolves the device — it must now be open.
  await sleep(300);
  const open1 = (await req("midi/getOutputs", {})).outputs.find((d) => d.name === dev.name);
  report("setting midiOutDevice opens the device", !!open1 && open1.open === true,
    JSON.stringify(open1));

  /* ---- 3. playback reaches the hardware ---- */
  const clip = (await req("cmd/clip.addMidi", { trackId: midiTrack.id, startBeat: 0, lengthBeats: 4, notes: [
    { pitch: 60, startBeat: 0.0, lengthBeats: 0.4, velocity: 100 },
    { pitch: 64, startBeat: 1.0, lengthBeats: 0.4, velocity: 100 },
    { pitch: 67, startBeat: 2.0, lengthBeats: 0.4, velocity: 100 },
    { pitch: 72, startBeat: 3.0, lengthBeats: 0.4, velocity: 100 },
  ] })).clip;
  report("MIDI clip on the routed track", clip.notes.length === 4);
  await req("transport/locate", { beat: 0 });
  await req("transport/play", {});
  await sleep(1600); // 120 bpm: ~3 beats — at least 3 note-on/off pairs render
  const during = (await req("midi/getOutputs", {})).outputs.find((d) => d.name === dev.name);
  await req("transport/stop", {});
  await sleep(300);
  const after = (await req("midi/getOutputs", {})).outputs.find((d) => d.name === dev.name);
  report("playback delivers events to the device", !!during && during.sent >= 6,
    `sent during playback=${during?.sent}`);
  // transport/stop sends sustain-off + all-sound-off + all-notes-off on 16 channels
  report("stop sends the note-hygiene flush (48 msgs)", !!after && after.sent >= during.sent + 48,
    `after stop=${after?.sent}`);

  /* ---- 4. persistence ---- */
  const proj = path.join(TMP, "MidiOut.mydaw");
  await req("project/saveAs", { path: proj });
  await req("project/new", {});
  await req("project/load", { path: proj });
  const loaded = (await req("session/hello", { clientName: "midiout" })).project;
  const lt = loaded.tracks.find((t) => t.name === "Outboard");
  report("midiOutDevice survives save/load", !!lt && lt.midiOutDevice === dev.name,
    `loaded=${lt?.midiOutDevice}`);

  /* ---- 5. absent device is honest, not fatal ---- */
  await req("cmd/track.set", { trackId: lt.id, patch: { midiOutDevice: "No Such Device XYZ" } });
  await sleep(200);
  const status = await req("engine/getStatus", {});
  report("unknown device degrades gracefully (engine alive)", !!status);

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? "MIDI OUT TEST: ALL PASS" : "MIDI OUT TEST: FAILURES");
  cleanup();
  setTimeout(() => process.exit(failed === 0 ? 0 : 1), 400);
} catch (e) {
  console.log("[FAIL] unexpected error — " + (e?.message ?? e));
  cleanup();
  setTimeout(() => process.exit(1), 400);
}
