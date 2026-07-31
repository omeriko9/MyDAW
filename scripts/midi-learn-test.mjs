#!/usr/bin/env node
/**
 * MIDI-learn / control-surface test. Uses midimap/feedCc to inject CCs (stands in for hardware).
 *   - midimap/learn arms a paramRef; the next CC binds to it (the learn CC does NOT apply)
 *   - a mapped CC then drives the track volume live (rendered peak scales with the CC value)
 *   - the map is reported in session/hello (+ event/midiMaps) and persists through saveAs/load
 *   - midimap/remove deletes it
 * Usage: node scripts/midi-learn-test.mjs [--port 8561]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8561"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-ml-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };

function makeSineWav(sr = 44100, secs = 2, freq = 440, amp = 0.5) {
  const n = sr * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * amp * 32767), 44 + i * 2);
  return buf;
}

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
/* Broadcasts, not just replies: a hardware control is the ONLY source whose value nothing
   on screen can learn any other way, so the echo it produces is part of the contract. */
const events = [];
sock.onmessage = (m) => { const j = JSON.parse(m.data); if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); } } else if (j.type) { events.push(j); } };
const req = (t, payload = {}, ms = 60000) => { const id = nextId++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };

const peakOf = (file) => { if (!existsSync(file)) return null; const w = readFileSync(file); if (w.toString("ascii", 0, 4) !== "RIFF") return null; let pk = 0; for (let i = 200; i + 1 < Math.min(w.length, 800000); i += 2) pk = Math.max(pk, Math.abs(w.readInt16LE(i))); return pk; };
let seq = 0;
const render = async () => { const out = path.join(TMP, `r${seq++}.wav`); await req("export/render", { path: out, startBeat: 0, endBeat: 2, format: { type: "wav", bitDepth: 16 } }, 120000); return peakOf(out); };
const feed = (cc, value, channel = 0) => req("midimap/feedCc", { cc, channel, value });

try {
  await req("session/hello", { clientName: "ml" });
  await req("project/new", {});
  const t = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "sine.wav");
  await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${t.id}&atBeat=0`, { method: "POST", body: fd });
  await sleep(400);

  const base = await render();
  const ref = `track:${t.id}:volume`;

  // arm learn, then bind CC 7
  const armReply = await req("midimap/learn", { paramRef: ref });
  report("midimap/learn arms the paramRef", armReply?.armed === ref, `armed=${armReply?.armed}`);
  const afterBind = await feed(7, 100); // learn CC → creates the map, does NOT apply
  const map = (afterBind?.maps ?? []).find((mm) => mm.paramRef === ref) ?? (await req("session/hello", {})).midiMaps?.maps?.find((mm) => mm.paramRef === ref);
  report("first CC after learn creates the mapping (and clears armed)", !!map && map.cc === 7, `map=${JSON.stringify(map)}`);
  const volAfterBind = (await req("session/hello", {})).project.tracks.find((x) => x.id === t.id)?.volume;
  report("the learn CC did NOT change the volume", Math.abs((volAfterBind ?? 1) - 1) < 1e-6, `volume=${volAfterBind}`);

  // now the mapped CC drives the volume live
  await feed(7, 0);
  const silent = await render();
  report("mapped CC 0 → volume 0 → silent", silent != null && silent < 5, `peak=${silent}`);

  await feed(7, 64);
  const half = await render();
  report("mapped CC 64 → ~half level", half != null && Math.abs(half - base * (64 / 127)) < base * 0.1, `base=${base} half=${half}`);

  await feed(7, 127);
  const full = await render();
  report("mapped CC 127 → full level", full != null && Math.abs(full - base) < base * 0.05, `base=${base} full=${full}`);

  /* The mapped CC must also REACH THE SCREEN. applyMidiMap applies transiently so a
     controller sweep behaves like a fader drag — no undo entry per CC, no revision bump —
     but transient also makes execute() skip broadcastChanges, and that half is only right
     when the browser is the source and already draws the value it is dragging. A hardware
     controller is not the UI, so the touched track is mirrored back explicitly. The bug
     was that nothing on screen ever learned the value, which is the whole point of learn. */
  events.length = 0;
  const sweep = [10, 40, 80, 120];
  for (const v of sweep) { await feed(7, v); await sleep(60); }
  await sleep(250);
  const echoes = events.filter((e) => e.type === "event/projectChanged");
  report("a hardware CC echoes a projectChanged per message", echoes.length >= sweep.length,
    `${echoes.length} echo(es) for ${sweep.length} CCs`);
  const scoped = echoes.filter((e) => (e.payload?.tracks ?? []).some((x) => x.id === t.id));
  report("the echo carries the touched track", scoped.length >= sweep.length,
    `${scoped.length} carried track ${t.id}`);
  const lastVol = scoped.length
    ? (scoped[scoped.length - 1].payload.tracks.find((x) => x.id === t.id) ?? {}).volume
    : null;
  report("the echoed volume is the value the controller sent",
    lastVol != null && Math.abs(lastVol - 120 / 127) < 1e-6,
    `echoed=${lastVol} expected=${120 / 127}`);
  /* ...and the transient envelope survives: a sweep that bumped the revision per message
     would be pushing an undo entry per CC, which is what transient exists to prevent. */
  const revs = [...new Set(scoped.map((e) => e.payload?.revision))];
  report("a CC sweep does not bump the revision per message", revs.length === 1,
    `revisions seen: ${JSON.stringify(revs)}`);

  // an UNMAPPED cc does nothing
  const beforeVol = (await req("session/hello", {})).project.tracks.find((x) => x.id === t.id)?.volume;
  await feed(20, 0);
  const afterVol = (await req("session/hello", {})).project.tracks.find((x) => x.id === t.id)?.volume;
  report("an unmapped CC is ignored", Math.abs((afterVol ?? 0) - (beforeVol ?? 0)) < 1e-6, `before=${beforeVol} after=${afterVol}`);

  // persistence
  const projDir = path.join(TMP, "Ml.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  const savedMap = (saved.midiMaps ?? []).find((mm) => mm.paramRef === ref);
  report("saveAs persists the midi map", !!savedMap && savedMap.cc === 7, `map=${JSON.stringify(savedMap)}`);
  await req("project/load", { path: projDir });
  await sleep(300);
  await feed(7, 0);
  const reloadedSilent = await render();
  report("reloaded map still controls the volume", reloadedSilent != null && reloadedSilent < 5, `peak=${reloadedSilent}`);

  // remove
  const rm = await req("midimap/remove", { paramRef: ref });
  report("midimap/remove deletes the mapping", !(rm?.maps ?? []).some((mm) => mm.paramRef === ref), `maps=${JSON.stringify(rm?.maps)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "MIDI LEARN TEST: ALL PASS" : "MIDI LEARN TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "MIDI LEARN TEST: EXCEPTION\n" + elog.slice(-800));
}
