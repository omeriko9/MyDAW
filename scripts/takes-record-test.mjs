#!/usr/bin/env node
/**
 * "Keep Takes" record-to-lanes test (Cubase-style lanes, SPEC §8.7).
 *
 *   node scripts/takes-record-test.mjs [--port 8586]
 *
 * Boots a real engine headlessly (isolated %APPDATA%, --null-input 2 synthetic capture)
 * and proves the four pieces shipped together:
 *   P1  transport/setKeepTakes round-trips, and PERSISTS across an engine relaunch
 *   P2  a MIDI recording with zero notes and zero CC creates NO clip (unconditional)
 *   P3  with Keep Takes ON, recording over existing material folds into take lanes:
 *       - over a loose clip: folder{lane0 "Previous"=old clip, lane1=new}, comp plays the
 *         NEW lane inside the recorded range and lane 0 outside (partial overlap)
 *       - over that folder: a third pass APPENDS a lane, span = union, comp outside the
 *         new range preserved
 *       - toggle OFF: two passes = two overlapping plain clips, zero folders (legacy)
 *   P4  cmd/take.setLaneMuted flips every clip in one lane (structural; the render-side
 *       effect of muted-in-lane is covered by comping-test + AudioGraph's muted skips)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8586"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };

const APPDATA_ISO = mkdtempSync(path.join(tmpdir(), "mydaw-iso-"));
mkdirSync(path.join(APPDATA_ISO, "MyDAW"), { recursive: true });
const ENGINE = path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe");

let engine = null;
let elog = "";
async function launchEngine() {
  engine = spawn(ENGINE, ["--driver", "null", "--no-browser", "--port", String(PORT), "--null-input", "2"],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: APPDATA_ISO } });
  engine.stderr.on("data", (d) => { elog = (elog + d).slice(-6000); });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(500); } }
  if (!up) throw new Error("engine failed to boot:\n" + elog.slice(-800));
}
const die = (code, msg) => { console.log(msg); try { engine?.kill(); } catch {} setTimeout(() => process.exit(code), 300); };

let sock = null, nextId = 1;
const pending = new Map();
async function connect() {
  sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
  sock.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); p(j); } }
  };
}
const raw = (t, payload = {}) => {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type: t, payload }));
  return new Promise((res, rej) => { pending.set(id, res); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, 30000); });
};
const req = async (t, p = {}) => {
  const r = await raw(t, p);
  if (!r.ok) throw new Error(`${t}: ${r.error?.code} ${r.error?.message}`);
  return r.payload ?? {};
};
const trackOf = async (id) =>
  (await req("session/hello", { clientName: "takes" })).project.tracks.find((t) => t.id === id);
/** Effective lane at `beat` — mirror of lib/comping.ts laneAt (LAST segment <= beat wins;
 *  paintComp may leave zero-width leading segments, so comp[0].lane alone is meaningless). */
const laneAtBeat = (f, beat) => {
  if (!f?.comp?.length) return 0;
  let lane = f.comp[0].lane;
  for (const s of f.comp) { if (beat >= s.startBeat) lane = s.lane; else break; }
  return lane;
};

async function recordPass(ms) {
  await req("transport/locate", { beat: 0 });
  await req("transport/record", {});
  await sleep(ms);
  await req("transport/stop", {});
  await sleep(900); // deferred commit (wav finalize + internal/recording.commit)
}
/** Feed one MIDI note during a recording pass (armed MIDI track hears midi/feedEvent). */
async function recordMidiPass(ms, notes) {
  await req("transport/locate", { beat: 0 });
  await req("transport/record", {});
  await sleep(200);
  for (let i = 0; i < notes; i++) {
    await req("midi/feedEvent", { status: 0x90, data1: 60 + i, data2: 100 });
    await sleep(120);
    await req("midi/feedEvent", { status: 0x80, data1: 60 + i, data2: 0 });
  }
  await sleep(Math.max(0, ms - 200 - notes * 120));
  await req("transport/stop", {});
  await sleep(900);
}

try {
  await launchEngine();
  await connect();
  await req("session/hello", { clientName: "takes" });
  await req("project/new", {});

  /* ---- P1: toggle round-trip ---------------------------------------------------------- */
  const set = await req("transport/setKeepTakes", { enabled: true });
  report("setKeepTakes reply carries the arm", set.keepTakes === true, `keepTakes=${set.keepTakes}`);

  /* ---- P1: persistence across relaunch ------------------------------------------------ */
  await req("engine/shutdown", {}).catch(() => {});
  await sleep(1500);
  try { engine.kill(); } catch {}
  await launchEngine();
  await connect();
  const hello2 = await req("session/hello", { clientName: "takes" });
  report("keepTakes persists across an engine relaunch (settings.json)",
    hello2.keepTakes === true, `hello.keepTakes=${hello2.keepTakes}`);

  /* ---- P3 toggle OFF first: legacy overlap-and-sum locked ----------------------------- */
  await req("project/new", {});
  await req("transport/setKeepTakes", { enabled: false });
  const trkOff = (await req("cmd/track.add", { kind: "audio", name: "Off" })).track;
  await req("cmd/track.set", { trackId: trkOff.id, patch: { recordArm: true } });
  await sleep(400);
  await recordPass(900);
  await recordPass(900);
  const offT = await trackOf(trkOff.id);
  report("toggle OFF keeps today's behavior: two overlapping clips, no folder",
    (offT.clips?.length ?? 0) === 2 && (offT.takeFolders?.length ?? 0) === 0,
    `clips=${offT.clips?.length} folders=${offT.takeFolders?.length}`);
  await req("cmd/track.set", { trackId: trkOff.id, patch: { recordArm: false } });

  /* ---- P3 ON: audio pass over a loose clip folds --------------------------------------- */
  await req("transport/setKeepTakes", { enabled: true });
  const trk = (await req("cmd/track.add", { kind: "audio", name: "Takes" })).track;
  await req("cmd/track.set", { trackId: trk.id, patch: { recordArm: true } });
  await sleep(400);
  await recordPass(1200); // pass 1: a loose clip
  let t1 = await trackOf(trk.id);
  report("first pass over silence stays a plain clip",
    (t1.clips?.length ?? 0) === 1 && (t1.takeFolders?.length ?? 0) === 0,
    `clips=${t1.clips?.length} folders=${t1.takeFolders?.length}`);

  await recordPass(800); // pass 2: overlaps pass 1 (both start at beat 0), SHORTER
  t1 = await trackOf(trk.id);
  const f = t1.takeFolders?.[0];
  report("second pass folds into a take folder",
    (t1.clips?.length ?? 0) === 0 && t1.takeFolders?.length === 1 && f?.lanes?.length === 2,
    `clips=${t1.clips?.length} folders=${t1.takeFolders?.length} lanes=${f?.lanes?.length}`);
  report("lane 0 is the parked previous material",
    f?.lanes?.[0]?.name === "Previous" && (f?.lanes?.[0]?.clips?.length ?? 0) === 1,
    `lane0=${f?.lanes?.[0]?.name} clips=${f?.lanes?.[0]?.clips?.length}`);
  // Comp: the NEW lane (1) plays from the fold start; pass 1 was LONGER, so past the new
  // take's end the comp must fall back to lane 0 (the old material's tail stays audible).
  // Effective audibility: new lane (1) at the fold start, old lane (0) past the new
  // take's end (pass 1 was longer, so its tail must stay audible).
  report("comp plays the new take inside its range and the old material outside",
    laneAtBeat(f, 0.01) === 1 && laneAtBeat(f, f.endBeat - 0.01) === 0,
    `comp=${JSON.stringify(f?.comp)}`);
  const spanOk = f && Math.abs(f.startBeat - 0) < 0.1 &&
    f.endBeat >= Math.max(...(f.lanes.flatMap((l) => l.clips.map((c) => c.startBeat + 0.1))));
  report("folder span covers the union", Boolean(spanOk),
    `span=[${f?.startBeat}, ${f?.endBeat}]`);

  /* ---- P3 ON: a third pass over the FOLDER appends a lane ------------------------------ */
  await recordPass(600);
  t1 = await trackOf(trk.id);
  const f2 = t1.takeFolders?.[0];
  report("a pass over the folder appends a lane (no second folder)",
    t1.takeFolders?.length === 1 && f2?.lanes?.length === 3,
    `folders=${t1.takeFolders?.length} lanes=${f2?.lanes?.length}`);
  report("the newest lane plays at the fold start; earlier comp is preserved after it",
    laneAtBeat(f2, 0.01) === 2 && laneAtBeat(f2, f2.endBeat - 0.01) === 0,
    `comp=${JSON.stringify(f2?.comp)}`);
  await req("cmd/track.set", { trackId: trk.id, patch: { recordArm: false } });

  /* ---- P4: setLaneMuted ---------------------------------------------------------------- */
  await req("cmd/take.setLaneMuted", { trackId: trk.id, folderId: f2.id, lane: 0, muted: true });
  let tm = await trackOf(trk.id);
  report("setLaneMuted mutes every clip in the lane",
    tm.takeFolders[0].lanes[0].clips.every((c) => c.muted === true), "");
  await req("cmd/take.setLaneMuted", { trackId: trk.id, folderId: f2.id, lane: 0, muted: false });
  tm = await trackOf(trk.id);
  report("setLaneMuted unmutes it again",
    tm.takeFolders[0].lanes[0].clips.every((c) => c.muted !== true), "");
  const badLane = await raw("cmd/take.setLaneMuted", { trackId: trk.id, folderId: f2.id, lane: 9, muted: true });
  report("an out-of-range lane is refused",
    badLane.ok === false && badLane.error?.code === "bad_request", `code=${badLane.error?.code}`);

  /* ---- P2: empty MIDI records nothing (toggle-independent) ----------------------------- */
  const midiT = (await req("cmd/track.add", { kind: "midi", name: "M" })).track;
  await req("cmd/track.set", { trackId: midiT.id, patch: { recordArm: true } });
  await sleep(200);
  await recordMidiPass(900, 0); // armed, nothing played
  let mt = await trackOf(midiT.id);
  report("an empty MIDI recording creates NO clip",
    (mt.clips?.length ?? 0) === 0 && (mt.takeFolders?.length ?? 0) === 0,
    `clips=${mt.clips?.length} folders=${mt.takeFolders?.length}`);

  /* ---- P3 ON: MIDI pass over an existing MIDI clip folds ------------------------------- */
  await recordMidiPass(900, 2); // pass 1 with notes → plain clip
  mt = await trackOf(midiT.id);
  report("a played MIDI pass creates a clip", (mt.clips?.length ?? 0) === 1,
    `clips=${mt.clips?.length}`);
  await recordMidiPass(900, 2); // pass 2 over it → fold
  mt = await trackOf(midiT.id);
  const mf = mt.takeFolders?.[0];
  report("a MIDI pass over an existing clip folds into lanes",
    (mt.clips?.length ?? 0) === 0 && mt.takeFolders?.length === 1 &&
      mf?.lanes?.length === 2 && mf?.lanes?.[0]?.name === "Previous" &&
      laneAtBeat(mf, 0.01) === 1,
    `clips=${mt.clips?.length} lanes=${mf?.lanes?.length} comp=${JSON.stringify(mf?.comp)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "TAKES RECORD TEST: ALL PASS" : "TAKES RECORD TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "TAKES RECORD TEST: EXCEPTION\n" + elog.slice(-800));
}
