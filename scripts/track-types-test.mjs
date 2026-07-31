#!/usr/bin/env node
/**
 * Track-types batch test (TRACK_TYPES_PLAN, 2026-07-25):
 *  - view-row track kinds (marker/arranger/chord/transpose): add, max-one, no clips/
 *    inserts/sends, no duplicate, persistence
 *  - cycle markers (endBeat; beat drag carries the range)
 *  - chord + transpose event commands (+ sorting, clamping, undo)
 *  - TRANSPOSE PLAYBACK: a +12 transpose event makes the rendered audio's dominant
 *    frequency double (builtin polysynth, FFT-free zero-crossing estimate)
 *  - ARRANGER CHAIN PLAYBACK: chain [B, A] makes section B's note sound FIRST in a
 *    realtime null-driver playthrough (export/render is linear by design)
 *  - arranger flatten: chain [B, A] rebuilds the timeline with B's material first
 * Usage: node scripts/track-types-test.mjs [--port 8572]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8572"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-tracktypes-"));
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
engine.stderr.on("data", (d) => { elog = (elog + d).slice(-8000); });
const die = (code, msg) => { console.log(msg); try { engine.kill(); } catch {} setTimeout(() => process.exit(code), 300); };

let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(500); } }
if (!up) die(2, "engine failed to boot:\n" + elog.slice(-800));

let nextId = 1; const pending = new Map(); const events = [];
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
sock.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); } }
  else if (j.type) events.push(j);
};
const req = (t, payload = {}, ms = 120000) => { const id = nextId++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };
const proj = async () => (await req("session/hello", { clientName: "tt" })).project;

/* wav helpers: 16-bit mono/stereo PCM peak + dominant-frequency estimate over a window */
const wavSamples = (file) => {
  const w = readFileSync(file);
  if (w.toString("ascii", 0, 4) !== "RIFF") return null;
  const ch = w.readUInt16LE(22), sr = w.readUInt32LE(24);
  const out = [];
  for (let i = 44; i + 1 < w.length; i += 2 * ch) out.push(w.readInt16LE(i) / 32768);
  return { sr, samples: out };
};
const peakOf = (file) => { const d = wavSamples(file); return d ? Math.max(...d.samples.map(Math.abs)) : null; };
// dominant frequency via zero-crossing count over [t0,t1) seconds
const freqOf = (file, t0, t1) => {
  const d = wavSamples(file);
  if (!d) return null;
  const a = Math.floor(t0 * d.sr), b = Math.min(Math.floor(t1 * d.sr), d.samples.length);
  let crossings = 0;
  for (let i = a + 1; i < b; i++)
    if ((d.samples[i - 1] < 0) !== (d.samples[i] < 0)) crossings++;
  return crossings / 2 / (t1 - t0);
};

try {
  await req("session/hello", { clientName: "tt" });
  await req("project/new", {});

  /* ---- 1. view-row track kinds ---- */
  for (const kind of ["marker", "arranger", "chord", "transpose"]) {
    const t = (await req("cmd/track.add", { kind })).track;
    report(`cmd/track.add kind=${kind}`, t.kind === kind, `name=${t.name}`);
    let dupFailed = false;
    try { await req("cmd/track.add", { kind }); } catch { dupFailed = true; }
    report(`second ${kind} track rejected (max one per project)`, dupFailed);
    let insFailed = false;
    try { await req("cmd/plugin.add", { trackId: t.id, uid: "builtin:compressor" }); } catch { insFailed = true; }
    report(`${kind} track rejects inserts`, insFailed);
  }
  const p1 = await proj();
  const markerTrack = p1.tracks.find((t) => t.kind === "marker");
  let dupViewFailed = false;
  try { await req("cmd/track.duplicate", { trackId: markerTrack.id }); } catch { dupViewFailed = true; }
  report("view-row track cannot be duplicated", dupViewFailed);

  /* ---- 2. cycle markers ---- */
  const mk = (await req("cmd/marker.add", { beat: 8, endBeat: 16, name: "Cycle A" })).marker;
  report("cycle marker add carries endBeat", mk.endBeat === 16, JSON.stringify(mk));
  await req("cmd/marker.set", { markerId: mk.id, patch: { beat: 12 } });
  let m2 = (await proj()).markers.find((m) => m.id === mk.id);
  report("moving a cycle marker carries its range", m2.beat === 12 && m2.endBeat === 20, JSON.stringify(m2));
  await req("cmd/marker.set", { markerId: mk.id, patch: { endBeat: 0 } });
  m2 = (await proj()).markers.find((m) => m.id === mk.id);
  report("endBeat <= beat collapses to a point marker", !m2.endBeat, JSON.stringify(m2));

  /* ---- 3. chord + transpose commands ---- */
  const c1 = (await req("cmd/chord.add", { beat: 4, root: 9, quality: "min7" })).chord;
  await req("cmd/chord.add", { beat: 0, root: 0, quality: "maj" });
  let chords = (await proj()).chordEvents;
  report("chords kept sorted by beat", chords.length === 2 && chords[0].beat === 0 && chords[1].beat === 4);
  await req("cmd/chord.set", { chordId: c1.id, patch: { quality: "7", bass: 2 } });
  chords = (await proj()).chordEvents;
  report("chord patch applies quality + bass", chords[1].quality === "7" && chords[1].bass === 2);
  await req("cmd/chord.remove", { chordId: c1.id });
  report("chord remove", (await proj()).chordEvents.length === 1);

  const tr1 = (await req("cmd/transpose.add", { beat: 2, semitones: 99 })).event;
  report("transpose semitones clamped to 24", tr1.semitones === 24, `got ${tr1.semitones}`);
  await req("edit/undo", {});
  report("transpose add undoes", ((await proj()).transposeEvents ?? []).length === 0);

  /* ---- 4. transpose playback: +12 doubles the pitch ---- */
  const inst = (await req("cmd/track.add", { kind: "instrument", name: "Synth" })).track;
  await req("cmd/plugin.add", { trackId: inst.id, uid: "builtin:polysynth" });
  await req("cmd/clip.addMidi", { trackId: inst.id, startBeat: 0, lengthBeats: 8, notes: [
    { pitch: 69, startBeat: 0, lengthBeats: 3.5, velocity: 100 },   // A4 (440) in beats 0-4
    { pitch: 69, startBeat: 4, lengthBeats: 3.5, velocity: 100 },   // A4 again in beats 4-8
  ] });
  await req("cmd/transpose.add", { beat: 4, semitones: 12 });        // second note plays A5
  const wav1 = path.join(TMP, "transpose.wav");
  await req("export/render", { path: wav1, startBeat: 0, endBeat: 8, format: { type: "wav", bitDepth: 16 } }, 300000);
  // 120bpm: beat 4 = 2.0s. Windows well inside each note's sustain.
  const f1 = freqOf(wav1, 0.5, 1.5);
  const f2 = freqOf(wav1, 2.5, 3.5);
  report("transpose event shifts playback +12 st (frequency doubles)",
    f1 !== null && f2 !== null && f2 / f1 > 1.8 && f2 / f1 < 2.2,
    `f1=${f1?.toFixed(1)}Hz f2=${f2?.toFixed(1)}Hz ratio=${(f2 / f1).toFixed(3)}`);
  // clips keep raw pitches
  const rawPitches = (await proj()).tracks.find((t) => t.id === inst.id).clips[0].notes.map((n) => n.pitch);
  report("clips keep raw pitches (transpose bakes at playback only)", rawPitches.every((x) => x === 69));

  /* ---- 5. arranger sections + chain playback ---- */
  const sA = (await req("cmd/arranger.addSection", { name: "A", startBeat: 0, endBeat: 4 })).section;
  const sB = (await req("cmd/arranger.addSection", { name: "B", startBeat: 4, endBeat: 8 })).section;
  report("arranger sections created", sA.name === "A" && sB.name === "B");
  let chainErr = false;
  try { await req("cmd/arranger.setChain", { chain: [999999] }); } catch { chainErr = true; }
  report("chain with unknown section id rejected", chainErr);

  // Distinct pitches per section: A holds A4 (440), B holds A5 (880) — remove the
  // transpose event first so it doesn't recolor section B.
  const trAll = (await proj()).transposeEvents ?? [];
  for (const te of trAll) await req("cmd/transpose.remove", { eventId: te.id });
  await req("cmd/clip.delete", { clipIds: (await proj()).tracks.find((t) => t.id === inst.id).clips.map((c) => c.id) });
  await req("cmd/clip.addMidi", { trackId: inst.id, startBeat: 0, lengthBeats: 8, notes: [
    { pitch: 69, startBeat: 0, lengthBeats: 3.5, velocity: 100 },  // section A = 440 Hz
    { pitch: 81, startBeat: 4, lengthBeats: 3.5, velocity: 100 },  // section B = 880 Hz
  ] });

  // Chain [B, A] ACTIVE: playback from B's start should sound 880 first, then 440.
  await req("cmd/arranger.setChain", { chain: [sB.id, sA.id], active: true, locateToStart: true });
  await req("transport/play", {});
  await sleep(4600); // ~2 beats/sec at 120bpm: >4s spans the B->A jump at 2s
  const snap = await req("transport/stop", {}); // transport/* replies carry {beat}
  // The audible proof needs a capture path; headless with the null driver we instead
  // verify the TRANSPORT jumped: locateToStart puts the playhead at beat 4 (B); 4.6 s at
  // 120bpm = 9.2 beats. With the B->A jump: 4->8, land at 0, +5.2 => ~5.2 (A is the last
  // chain step, so play continues linearly past its end). Without the jump: ~13.2.
  const beatNow = snap?.beat ?? -1;
  report("active chain [B,A]: transport jumped B->A at B's end",
    beatNow > 4.0 && beatNow < 7.0, `beat=${beatNow?.toFixed?.(2)} (no-jump would be ~13.2)`);
  await req("cmd/arranger.setChain", { active: false });

  /* ---- 6. arranger flatten: chain [B, A] rebuilds timeline as B then A ---- */
  await req("cmd/arranger.setChain", { chain: [sB.id, sA.id] });
  await req("cmd/arranger.flatten", {});
  const pf = await proj();
  report("flatten clears arranger data", !pf.arranger || (pf.arranger.sections.length === 0 && pf.arranger.chain.length === 0));
  const flatNotes = pf.tracks.find((t) => t.id === inst.id).clips
    .flatMap((c) => c.notes.map((n) => ({ abs: c.startBeat + n.startBeat, pitch: n.pitch })))
    .sort((a, b) => a.abs - b.abs);
  report("flatten put section B's note first (A5 at 0, A4 at 4)",
    flatNotes.length === 2 && flatNotes[0].pitch === 81 && flatNotes[0].abs < 0.01 &&
    flatNotes[1].pitch === 69 && Math.abs(flatNotes[1].abs - 4) < 0.01,
    JSON.stringify(flatNotes));
  const wavFlat = path.join(TMP, "flat.wav");
  await req("export/render", { path: wavFlat, startBeat: 0, endBeat: 8, format: { type: "wav", bitDepth: 16 } }, 300000);
  const ff1 = freqOf(wavFlat, 0.5, 1.5), ff2 = freqOf(wavFlat, 2.5, 3.5);
  report("flattened render: 880 Hz first, 440 Hz second",
    ff1 !== null && ff2 !== null && ff1 / ff2 > 1.8 && ff1 / ff2 < 2.2,
    `first=${ff1?.toFixed(1)}Hz second=${ff2?.toFixed(1)}Hz`);

  /* ---- 7. persistence ---- */
  await req("cmd/arranger.addSection", { name: "P", startBeat: 0, endBeat: 4 });
  await req("cmd/chord.add", { beat: 1, root: 5, quality: "sus4", tensions: "9" });
  await req("cmd/transpose.add", { beat: 3, semitones: -5 });
  await req("cmd/marker.add", { beat: 2, endBeat: 6, name: "Cyc" });
  const projDir = path.join(TMP, "TrackTypes.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  report("saveAs persists arranger/chordEvents/transposeEvents/cycle marker",
    (saved.arranger?.sections?.length ?? 0) === 1 &&
    (saved.chordEvents?.length ?? 0) >= 1 &&
    (saved.transposeEvents?.length ?? 0) === 1 &&
    saved.markers.some((m) => m.endBeat === 6) &&
    ["marker", "arranger", "chord", "transpose"].every((k) => saved.tracks.some((t) => t.kind === k)));
  await req("project/load", { path: projDir });
  await sleep(300);
  const pl = await proj();
  report("project/load restores the view-row data",
    (pl.arranger?.sections?.length ?? 0) === 1 &&
    (pl.chordEvents?.length ?? 0) >= 1 &&
    (pl.transposeEvents?.length ?? 0) === 1);

  /* ---- 8. agent surface: the new data is queryable ---- */
  const qArr = await req("agent/query", { view: "arranger" });
  report("agent view:arranger returns sections+chain",
    Array.isArray(qArr.items) && qArr.items.length === 1 && qArr.items[0].sections.length === 1,
    JSON.stringify(qArr.items?.[0] ?? null).slice(0, 120));
  const qCh = await req("agent/query", { view: "chord_events" });
  report("agent view:chord_events lists chords with ids",
    qCh.items?.length >= 1 && qCh.items.every((c) => c.id > 0 && typeof c.quality === "string"));
  const qTr = await req("agent/query", { view: "transpose_events" });
  report("agent view:transpose_events lists events",
    qTr.items?.length === 1 && qTr.items[0].semitones === -5);
  const qMk = await req("agent/query", { view: "markers" });
  report("agent view:markers carries endBeat on cycle markers",
    qMk.items?.some((m) => m.endBeat === 6));
  const qSum = await req("agent/query", { view: "project_summary" });
  report("agent project_summary counts the new data",
    qSum.items?.[0]?.arrangerSectionCount === 1 && qSum.items?.[0]?.chordEventCount >= 1 &&
    qSum.items?.[0]?.transposeEventCount === 1);
  let viewErr = "";
  try { await req("agent/query", { view: "nope" }); } catch (e) { viewErr = String(e.message); }
  report("unknown view error enumerates the full view list (incl. new views)",
    viewErr.includes("chord_events") && viewErr.includes("arranger") && viewErr.includes("transpose_events"));

  const st = await req("engine/getStatus", {});
  report("engine alive at the end", st.running === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "TRACK TYPES TEST: ALL PASS" : "TRACK TYPES TEST: FAILURES\n" + elog.slice(-1200));
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "TRACK TYPES TEST: EXCEPTION\n" + elog.slice(-1500));
}
