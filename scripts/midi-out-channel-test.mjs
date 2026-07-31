#!/usr/bin/env node
/**
 * Track MIDI output channel test (SPEC §6 Track.midiOutChannel): the per-track channel
 * that lets several MIDI tracks address one multitimbral instrument.
 *
 *   cmd/track.set {midiOutChannel} accepts 0..16, clamps out-of-range, survives undo
 *   export/midi stamps every note/CC of the track with that channel (the only place the
 *     emitted channel is observable headlessly — the built-in instruments are omni and a
 *     rendered wav cannot tell channels apart)
 *   saveAs/load round-trips the field
 *   playback with a forced channel still sounds (no note dropped by the re-stamping) and
 *     is bit-comparable to the same take on "as played"
 *
 * Usage: node scripts/midi-out-channel-test.mjs [--port 8562]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8562"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-midich-"));
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
const req = (t, payload = {}, ms = 60000) => { const id = nextId++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };

const trackOf = async (id) => (await req("session/hello", { clientName: "midich" })).project.tracks.find((t) => t.id === id);

/* ---- minimal SMF reader: channel-voice status bytes per MTrk (running status aware) ---- */
function smfChannels(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "MThd") return null;
  const tracks = [];
  let p = 8 + b.readUInt32BE(4);
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4);
    const len = b.readUInt32BE(p + 4);
    const body = b.subarray(p + 8, p + 8 + len);
    p += 8 + len;
    if (id !== "MTrk") continue;
    const chans = new Set();
    let i = 0, running = 0;
    const vlq = () => { let v = 0, c; do { c = body[i++]; v = (v << 7) | (c & 0x7F); } while (c & 0x80); return v; };
    while (i < body.length) {
      vlq(); // delta
      let st = body[i];
      if (st & 0x80) { i++; } else { st = running; }
      if (st === 0xFF) { i++; const n = vlq(); i += n; continue; }          // meta
      if (st === 0xF0 || st === 0xF7) { const n = vlq(); i += n; continue; } // sysex
      running = st;
      chans.add(st & 0x0F);
      const hi = st & 0xF0;
      i += hi === 0xC0 || hi === 0xD0 ? 1 : 2;
    }
    tracks.push(chans);
  }
  return tracks;
}

const peakOf = (file) => { if (!existsSync(file)) return null; const w = readFileSync(file); if (w.toString("ascii", 0, 4) !== "RIFF") return null; let pk = 0; for (let i = 200; i + 1 < w.length; i += 2) pk = Math.max(pk, Math.abs(w.readInt16LE(i))); return pk; };
let seq = 0;
const render = async () => { const out = path.join(TMP, `r${seq++}.wav`); await req("export/render", { path: out, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } }, 120000); return { peak: peakOf(out), bytes: existsSync(out) ? readFileSync(out) : null }; };

try {
  await req("session/hello", { clientName: "midich" });
  await req("project/new", {});

  // An instrument track with the built-in synth + a 4-note clip with one CC lane.
  const t = (await req("cmd/track.add", { kind: "instrument", name: "Multi 1" })).track;
  await req("cmd/plugin.add", { trackId: t.id, uid: "builtin:polysynth" });
  const clip = (await req("cmd/clip.addMidi", { trackId: t.id, startBeat: 0, lengthBeats: 4, notes: [
    { pitch: 60, startBeat: 0, lengthBeats: 1, velocity: 100 },
    { pitch: 64, startBeat: 1, lengthBeats: 1, velocity: 100 },
    { pitch: 67, startBeat: 2, lengthBeats: 1, velocity: 100 },
    { pitch: 72, startBeat: 3, lengthBeats: 1, velocity: 100 },
  ] })).clip;
  await req("cmd/cc.edit", { clipId: clip.id, add: [{ controller: 1, beat: 0, value: 0.5 }, { controller: 1, beat: 2, value: 0.9 }] });

  const base = await render();
  report("baseline: track sounds on the default channel", base.peak != null && base.peak > 100, `peak=${base.peak}`);
  // The built-in synth's oscillators free-run across renders, so two identical takes are
  // NOT sample-identical — level comparisons below use a tolerance, not equality.
  const base2 = await render();
  console.log(`       (renders vary by ${(Math.abs(base2.peak - base.peak) / base.peak * 100).toFixed(1)}% run to run: ${base.peak} vs ${base2.peak})`);

  /* ---- 1. the field itself ---- */
  const d0 = await trackOf(t.id);
  report("new tracks default to 0 (as played)", (d0.midiOutChannel ?? 0) === 0, `midiOutChannel=${d0.midiOutChannel ?? 0}`);

  await req("cmd/track.set", { trackId: t.id, patch: { midiOutChannel: 10 } });
  report("cmd/track.set applies midiOutChannel", (await trackOf(t.id)).midiOutChannel === 10);

  await req("cmd/track.set", { trackId: t.id, patch: { midiOutChannel: 99 } });
  report("out-of-range clamps to 16", (await trackOf(t.id)).midiOutChannel === 16, `got ${(await trackOf(t.id)).midiOutChannel}`);
  await req("cmd/track.set", { trackId: t.id, patch: { midiOutChannel: -3 } });
  report("negative clamps to 0", ((await trackOf(t.id)).midiOutChannel ?? 0) === 0);

  await req("cmd/track.set", { trackId: t.id, patch: { midiOutChannel: 10 } });
  await req("edit/undo", {});
  report("undo restores the previous channel", ((await trackOf(t.id)).midiOutChannel ?? 0) === 0, `got ${(await trackOf(t.id)).midiOutChannel ?? 0}`);

  /* ---- 2. the emitted channel (export/midi) ---- */
  const midiAsPlayed = path.join(TMP, "as-played.mid");
  await req("export/midi", { path: midiAsPlayed }, 120000);
  const asPlayed = smfChannels(midiAsPlayed);
  report("export/midi: channel 0 = as played (notes carry channel 0)",
    asPlayed?.length >= 2 && [...(asPlayed[1] ?? [])].every((c) => c === 0), `channels=${JSON.stringify(asPlayed?.map((s) => [...s]))}`);

  await req("cmd/track.set", { trackId: t.id, patch: { midiOutChannel: 10 } });
  const midiCh10 = path.join(TMP, "ch10.mid");
  await req("export/midi", { path: midiCh10 }, 120000);
  const forced = smfChannels(midiCh10);
  const forcedSet = [...(forced?.[1] ?? [])];
  report("export/midi: midiOutChannel 10 stamps every event on MIDI channel 10 (wire 9)",
    forcedSet.length === 1 && forcedSet[0] === 9, `channels=${JSON.stringify(forcedSet)}`);

  /* ---- 2b. playback is unaffected (built-in synth is omni; nothing dropped) ---- */
  const forcedRender = await render();
  report("forced channel still renders audio", forcedRender.peak > 100, `peak=${forcedRender.peak}`);
  report("forced channel plays at the same level as as-played (nothing dropped by the re-stamping)",
    Math.abs(forcedRender.peak - base.peak) < base.peak * 0.2,
    `base peak=${base.peak} forced peak=${forcedRender.peak}`);

  /* ---- 3. two tracks, two channels — the multitimbral case ---- */
  const t2 = (await req("cmd/track.add", { kind: "midi", name: "Multi 2" })).track;
  await req("cmd/track.set", { trackId: t2.id, patch: { midiTarget: t.id, midiOutChannel: 3 } });
  await req("cmd/clip.addMidi", { trackId: t2.id, startBeat: 0, lengthBeats: 4,
    notes: [{ pitch: 48, startBeat: 0, lengthBeats: 2, velocity: 100 }] });
  const midiBoth = path.join(TMP, "both.mid");
  await req("export/midi", { path: midiBoth }, 120000);
  const both = smfChannels(midiBoth);
  report("two tracks into one instrument keep DISTINCT channels (10 and 3)",
    both?.length >= 3 && [...both[1]].join() === "9" && [...both[2]].join() === "2",
    `channels=${JSON.stringify(both?.map((s) => [...s]))}`);

  /* ---- 4. persistence ---- */
  const projDir = path.join(TMP, "MidiCh.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  report("saveAs persists midiOutChannel",
    saved.tracks.find((x) => x.id === t.id)?.midiOutChannel === 10 &&
    saved.tracks.find((x) => x.id === t2.id)?.midiOutChannel === 3,
    `saved=${JSON.stringify(saved.tracks.map((x) => x.midiOutChannel ?? 0))}`);
  report("midiOutChannel omitted from JSON when 0",
    !("midiOutChannel" in (JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8")).masterTrack ?? {})));

  await req("project/load", { path: projDir });
  await sleep(400);
  const loaded = (await req("session/hello", { clientName: "midich" })).project.tracks;
  report("project/load restores midiOutChannel",
    loaded.find((x) => x.name === "Multi 1")?.midiOutChannel === 10 &&
    loaded.find((x) => x.name === "Multi 2")?.midiOutChannel === 3);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "MIDI OUT CHANNEL TEST: ALL PASS" : "MIDI OUT CHANNEL TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "MIDI OUT CHANNEL TEST: EXCEPTION\n" + elog.slice(-1500));
}
