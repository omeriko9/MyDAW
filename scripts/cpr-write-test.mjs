#!/usr/bin/env node
/**
 * cpr-write-test.mjs — M2 acceptance test for the .cpr writer (scripts/cpr-write.mjs).
 *
 * For each test model:
 *   1. writeCpr(model) -> temp .cpr (the writer self-checks byte sanity: re-parse +
 *      re-serialize byte-identical via the M1 library),
 *   2. ORACLE: MyDAW's own importer re-imports the file through a throwaway ISOLATED
 *      engine (scratch APPDATA, --driver null --no-browser, port 8434):
 *      project/importForeign {path} then session/hello, and the returned project is
 *      compared field-by-field against the source model:
 *        track names/kinds exact, note pitch/velocity exact, beats within 1e-6,
 *        tempo within 0.01 bpm, volume within 0.01 dB, pan within 0.02.
 *   3. regression: scripts/cpr-roundtrip-test.mjs must still pass 60/60
 *      (skip with --skip-corpus).
 *
 * usage: node scripts/cpr-write-test.mjs [--port 8434] [--skip-corpus] [--keep]
 * Exit nonzero on any failure. The engine child is killed by ITS pid, never by name.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeCpr, DONOR_BASE_TRACKS } from "./cpr-write.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const PORT = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : "8434");
const SKIP_CORPUS = argv.includes("--skip-corpus");
const KEEP = argv.includes("--keep");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- test models ---------------- */

const db = (x) => Math.pow(10, x / 20);
const note = (pitch, velocity, startBeat, lengthBeats) => ({ pitch, velocity, startBeat, lengthBeats });
const CASES = [
  {
    id: "1-track-1-note",
    model: {
      tempo: 120,
      tracks: [
        { name: "Lead", kind: "midi", volumeGain: 1.0, pan: 0,
          clips: [{ startBeat: 0, lengthBeats: 4, notes: [note(60, 100, 0, 1)] }] },
      ],
    },
  },
  {
    id: "3-tracks-chords-velocities",
    model: {
      tempo: 96.5,
      tracks: [
        { name: "Keys", kind: "midi", volumeGain: 1.0, pan: 0,
          clips: [{ startBeat: 0, lengthBeats: 8, notes: [
            note(60, 64, 0, 2), note(64, 80, 0, 2), note(67, 127, 0, 2),
            note(59, 50, 4, 1.5), note(62, 90, 4, 1.5), note(67, 110, 4, 1.5),
          ] }] },
        { name: "Bass", kind: "midi", volumeGain: 1.0, pan: 0,
          clips: [{ startBeat: 0, lengthBeats: 8, notes: [
            note(36, 127, 0, 0.5), note(43, 30, 0.5, 0.25), note(36, 1, 1, 0.25),
          ] }] },
        { name: "Pad", kind: "midi", volumeGain: 1.0, pan: 0,
          clips: [{ startBeat: 2, lengthBeats: 6, notes: [
            note(72, 64, 0, 6), note(76, 72, 0, 6), note(79, 88, 3, 3),
          ] }] },
      ],
    },
  },
  {
    id: "moved-faders-pans",
    model: {
      tempo: 128,
      tracks: [
        { name: "V-Down", kind: "midi", volumeGain: db(-6.97), pan: 0,
          clips: [{ startBeat: 0, lengthBeats: 4, notes: [note(60, 96, 0, 1)] }] },
        { name: "V-Up", kind: "midi", volumeGain: db(3.5), pan: -1,
          clips: [{ startBeat: 0, lengthBeats: 4, notes: [note(62, 96, 1, 1)] }] },
        { name: "V-Half", kind: "midi", volumeGain: 0.5, pan: 1,
          clips: [{ startBeat: 0, lengthBeats: 4, notes: [note(64, 96, 2, 1)] }] },
        { name: "V-Unity", kind: "midi", volumeGain: 1.0, pan: 0.33,
          clips: [{ startBeat: 0, lengthBeats: 4, notes: [note(65, 96, 3, 1)] }] },
        { name: "V-Low", kind: "midi", volumeGain: 0.1, pan: -0.25,
          clips: [{ startBeat: 0, lengthBeats: 4, notes: [note(67, 96, 0, 4)] }] },
      ],
    },
  },
  {
    id: "2-clips-per-track",
    model: {
      tempo: 140,
      tracks: [
        { name: "Riff", kind: "midi", volumeGain: db(-3.01), pan: 0.5,
          clips: [
            { startBeat: 0, lengthBeats: 4, notes: [note(48, 110, 0, 0.5), note(55, 70, 1, 0.5), note(48, 90, 2.5, 1.5)] },
            { startBeat: 8, lengthBeats: 4, notes: [note(50, 100, 0, 2), note(57, 60, 2, 2)] },
          ] },
        { name: "Melody", kind: "midi", volumeGain: 1.0, pan: -0.5,
          clips: [
            { startBeat: 2, lengthBeats: 2, notes: [note(72, 84, 0, 2)] },
            { startBeat: 12, lengthBeats: 4, notes: [note(74, 92, 0.25, 0.75), note(76, 96, 1, 3)] },
          ] },
      ],
    },
  },
];

/* ---------------- comparison ---------------- */

const dbDiff = (got, exp) => Math.abs(20 * Math.log10(got / exp));

function compare(model, pr, errs) {
  // PIPELINE v2: the writer keeps the donor's track 1 (real-Cubase-validated base), so
  // the imported project = DONOR_BASE_TRACKS ++ model.tracks.
  const nBase = DONOR_BASE_TRACKS.length;
  if (Math.abs((pr.tempoMap?.[0]?.bpm ?? 0) - model.tempo) > 0.01)
    errs.push(`tempo ${pr.tempoMap?.[0]?.bpm} != ${model.tempo}`);
  if ((pr.tempoMap?.[0]?.beat ?? -1) !== 0) errs.push(`tempoMap[0].beat != 0`);
  if ((pr.tracks?.length ?? 0) !== nBase + model.tracks.length) {
    errs.push(`tracks ${pr.tracks?.length} != ${nBase}+${model.tracks.length} [${(pr.tracks ?? []).map(t => t.name).join(", ")}]`);
    return;
  }
  DONOR_BASE_TRACKS.forEach((bt, i) => {
    const t = pr.tracks[i];
    if (t.name !== bt.name || t.kind !== bt.kind)
      errs.push(`base track[${i}]: "${t.name}"/${t.kind} != "${bt.name}"/${bt.kind}`);
  });
  model.tracks.forEach((mt, i) => {
    const t = pr.tracks[nBase + i];
    const tag = `track[${i}] "${mt.name}"`;
    if (t.name !== mt.name) errs.push(`${tag}: name "${t.name}"`);
    if (t.kind !== "midi") errs.push(`${tag}: kind ${t.kind} != midi`);
    const vol = t.volume ?? 1.0;
    if (mt.volumeGain > 0 ? dbDiff(vol, mt.volumeGain) > 0.01 : vol > 1e-6)
      errs.push(`${tag}: volume ${vol} != gain ${mt.volumeGain} (Δ ${mt.volumeGain > 0 ? dbDiff(vol, mt.volumeGain).toFixed(4) : "inf"} dB)`);
    if (Math.abs((t.pan ?? 0) - mt.pan) > 0.02)
      errs.push(`${tag}: pan ${t.pan ?? 0} != ${mt.pan}`);
    const clips = t.clips ?? [];
    if (clips.length !== mt.clips.length) {
      errs.push(`${tag}: clips ${clips.length} != ${mt.clips.length}`);
      return;
    }
    mt.clips.forEach((mc, j) => {
      const c = clips[j];
      const ctag = `${tag} clip[${j}]`;
      if (Math.abs(c.startBeat - mc.startBeat) > 1e-6)
        errs.push(`${ctag}: startBeat ${c.startBeat} != ${mc.startBeat}`);
      if (Math.abs(c.lengthBeats - mc.lengthBeats) > 1e-6)
        errs.push(`${ctag}: lengthBeats ${c.lengthBeats} != ${mc.lengthBeats}`);
      const key = (n) => `${n.startBeat.toFixed(6)}/${n.pitch}`;
      const got = [...(c.notes ?? [])].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
      const exp = [...mc.notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
      if (got.length !== exp.length) {
        errs.push(`${ctag}: ${got.length} notes != ${exp.length}`);
        return;
      }
      exp.forEach((en, k) => {
        const gn = got[k];
        const ntag = `${ctag} note[${k}] (${key(en)})`;
        if (gn.pitch !== en.pitch) errs.push(`${ntag}: pitch ${gn.pitch} != ${en.pitch}`);
        if (gn.velocity !== en.velocity) errs.push(`${ntag}: velocity ${gn.velocity} != ${en.velocity}`);
        if (Math.abs(gn.startBeat - en.startBeat) > 1e-6) errs.push(`${ntag}: startBeat ${gn.startBeat} != ${en.startBeat}`);
        if (Math.abs(gn.lengthBeats - en.lengthBeats) > 1e-6) errs.push(`${ntag}: lengthBeats ${gn.lengthBeats} != ${en.lengthBeats}`);
      });
    });
  });
}

/* ---------------- write the files ---------------- */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpr-write-test-"));
const isoAppData = path.join(workDir, "appdata");
fs.mkdirSync(isoAppData, { recursive: true });
console.log(`work dir: ${workDir}`);

let failures = 0;
const files = [];
for (const c of CASES) {
  try {
    const out = writeCpr(c.model);
    const f = path.join(workDir, `${c.id}.cpr`);
    fs.writeFileSync(f, out);
    files.push({ ...c, file: f });
    console.log(`[write] ${c.id}: ${out.stats.bytes} B, ${out.stats.tracks} tracks, ` +
      `${out.stats.parts} parts, ${out.stats.notes} notes, ${out.stats.healedRefs} refs healed, byte-sanity OK`);
  } catch (e) {
    console.log(`[FAIL] ${c.id}: writer error: ${e.message}`);
    failures++;
  }
}

/* ---------------- oracle: isolated throwaway engine ---------------- */

if (files.length) {
  const exe = path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe");
  if (!fs.existsSync(exe)) {
    console.log(`FAIL: engine binary missing: ${exe} (cmake --build build --config Release --target mydaw-engine)`);
    process.exit(2);
  }
  const engine = spawn(exe, ["--driver", "null", "--no-browser", "--port", String(PORT)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, APPDATA: isoAppData, LOCALAPPDATA: isoAppData },
  });
  const enginePid = engine.pid; // kill EXACTLY this pid, never by image name
  console.log(`engine pid ${enginePid} (isolated APPDATA: ${isoAppData})`);
  let elog = "";
  engine.stderr.on("data", (d) => { elog = (elog + d).slice(-8000); });
  const shutdown = () => { try { process.kill(enginePid); } catch {} };

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(400); }
  }
  if (!up) { shutdown(); console.log("FAIL: engine did not boot\n" + elog.slice(-1500)); process.exit(2); }

  let nid = 1;
  const pending = new Map();
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws connect failed")); });
  sock.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.replyTo != null) {
      const p = pending.get(j.replyTo);
      if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); }
    }
  };
  const req = (t, payload = {}, ms = 60000) => {
    const id = nid++;
    sock.send(JSON.stringify({ id, type: t, payload }));
    return new Promise((res, rej) => {
      pending.set(id, { res, rej, t });
      setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms);
    });
  };

  try {
    await req("session/hello", { clientName: "cpr-write-test" });
    for (const c of files) {
      const t0 = Date.now();
      let errs = [];
      try {
        const imp = await req("project/importForeign", { path: c.file });
        if (!imp.project) errs.push("importForeign returned no project");
        // the session must have ADOPTED the import: hello's project is the compared one
        const hello = await req("session/hello", { clientName: "cpr-write-test" });
        compare(c.model, hello.project ?? {}, errs);
        const wantTracks = DONOR_BASE_TRACKS.length + c.model.tracks.length;
        if (imp.project && (imp.project.tracks?.length ?? -1) !== wantTracks)
          errs.push(`importForeign reply track count ${imp.project.tracks?.length} != ${wantTracks}`);
      } catch (e) {
        errs.push(e.message);
      }
      const ok = errs.length === 0;
      if (!ok) failures++;
      console.log(`[${ok ? "PASS" : "FAIL"}] oracle ${c.id} (${Date.now() - t0} ms)`);
      for (const e of errs) console.log(`       !! ${e}`);
    }
  } finally {
    sock.close();
    shutdown();
  }
  if (failures) console.log("engine log tail:\n" + elog.slice(-2000));
}

/* ---------------- M1 regression: corpus round-trip still 60/60 ---------------- */

if (!SKIP_CORPUS) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "cpr-roundtrip-test.mjs")], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const m = /TOTAL (\d+)\/(\d+) byte-identical/.exec(r.stdout ?? "");
  const ok = r.status === 0 && m && m[1] === m[2];
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] corpus round-trip regression: ${m ? `${m[1]}/${m[2]}` : "no summary"} (exit ${r.status}, ${Date.now() - t0} ms)`);
  if (!ok) console.log((r.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 10).join("\n"));
}

if (!KEEP && !failures) fs.rmSync(workDir, { recursive: true, force: true });
else console.log(`kept: ${workDir}`);
console.log(failures ? `\nCPR WRITE TEST: ${failures} FAILED` : "\nCPR WRITE TEST: ALL PASS");
process.exit(failures ? 1 : 0);
