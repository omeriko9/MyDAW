#!/usr/bin/env node
/**
 * Import Project test: generates a 2-track format-1 SMF (tempo 95, named tracks),
 * imports it via project/importForeign, verifies tempo/tracks/clips/notes.
 * Usage: node scripts/import-test.mjs [--port 8523]
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "8523");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- minimal SMF format-1 writer (PPQN 480) ---- */
const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
function trackChunk(events) {
  const body = [];
  for (const [dt, ...bytes] of events) body.push(...vlq(dt), ...bytes);
  body.push(0, 0xff, 0x2f, 0); // end of track
  const len = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body];
}
function makeSmf() {
  const P = 480; // ticks per quarter
  const tempoUsPerQ = Math.round(60000000 / 95); // 95 bpm
  const tempo2UsPerQ = Math.round(60000000 / 140);
  const meta = trackChunk([
    [0, 0xff, 0x51, 3, (tempoUsPerQ >> 16) & 255, (tempoUsPerQ >> 8) & 255, tempoUsPerQ & 255],
    [0, 0xff, 0x58, 4, 4, 2, 24, 8], // 4/4
    [P * 8, 0xff, 0x51, 3, (tempo2UsPerQ >> 16) & 255, (tempo2UsPerQ >> 8) & 255, tempo2UsPerQ & 255], // 140 bpm at beat 8
  ]);
  const name = (s) => [0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))];
  const t1 = trackChunk([
    [0, ...name("Piano")],
    [0, 0xb0, 64, 127],                            // sustain down at beat 0
    [0, 0x90, 60, 100], [P, 0x80, 60, 0],          // C4 quarter at beat 0
    [0, 0xe0, 0x00, 0x60],                         // pitch bend up at beat 1
    [0, 0x90, 64, 90], [P, 0x80, 64, 0],           // E4 quarter at beat 1
    [0, 0xb0, 64, 0],                              // sustain up at beat 2
    [0, 0x90, 67, 80], [P * 2, 0x80, 67, 0],       // G4 half at beat 2
  ]);
  const t2 = trackChunk([
    [0, ...name("Bass")],
    [P * 4, 0x91, 36, 110], [P * 4, 0x81, 36, 0],  // C2 whole at bar 2
  ]);
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, (P >> 8) & 255, P & 255];
  return Buffer.from([...hdr, ...meta, ...t1, ...t2]);
}

const smfPath = path.join(os.tmpdir(), "mydaw-import-test.mid");
writeFileSync(smfPath, makeSmf());

const engine = spawn(path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
let elog = ""; engine.stderr.on("data", (d) => { elog = (elog + d).slice(-4000); });
const die = (code, msg) => { console.log(msg); try { engine.kill(); } catch {} setTimeout(() => process.exit(code), 300); };

let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(500); } }
if (!up) die(2, "engine failed to boot:\n" + elog.slice(-600));

let nid = 1; const pending = new Map();
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws connect failed")); });
sock.onmessage = (m) => { const j = JSON.parse(m.data); if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); } } };
const req = (t, payload = {}, ms = 30000) => { const id = nid++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };

await req("session/hello", { clientName: "import-test" });

const fmts = await req("project/getImportFormats", {});
console.log("formats:", JSON.stringify(fmts.formats));
if (!fmts.formats?.some((f) => f.id === "smf")) die(1, "FAIL: smf provider not registered");

/* ---- --file mode: import arbitrary real files and report stats ---- */
const fileArgs = process.argv.slice(2).filter((a, i, arr) => arr[i - 1] === "--file");
if (fileArgs.length) {
  let anyFail = 0;
  for (const f of fileArgs) {
    const t0 = Date.now();
    try {
      const { project: pr } = await req("project/importForeign", { path: f }, 120000);
      const notes = pr.tracks.reduce((s, t) => s + t.clips.reduce((c, cl) => c + (cl.notes?.length ?? 0), 0), 0);
      const maxEnd = Math.max(0, ...pr.tracks.flatMap((t) => t.clips.map((c) => (c.startBeat ?? 0) + (c.lengthBeats ?? 0))));
      console.log(`[PASS] ${path.basename(f)} -> "${pr.name}": ${pr.tracks.length} tracks, ${notes} notes, ` +
        `tempo ${pr.tempoMap?.[0]?.bpm}, ${pr.timeSigMap?.[0]?.num}/${pr.timeSigMap?.[0]?.den}, ` +
        `${maxEnd.toFixed(1)} beats, ${Date.now() - t0} ms`);
      for (const t of pr.tracks.slice(0, 24)) {
        const n = t.clips.reduce((c, cl) => c + (cl.notes?.length ?? 0), 0);
        console.log(`    - ${t.name}: ${n} notes`);
      }
    } catch (e) {
      console.log(`[FAIL] ${path.basename(f)}: ${e.message}`); anyFail++;
    }
  }
  die(anyFail ? 1 : 0, anyFail ? "\nFILE IMPORT: FAILURES" : "\nFILE IMPORT: ALL PASS");
}

const { project: p } = await req("project/importForeign", { path: smfPath });
const checks = [
  ["tempo 95", Math.abs((p.tempoMap?.[0]?.bpm ?? 0) - 95) < 0.01],
  ["2 midi tracks", p.tracks.length === 2 && p.tracks.every((t) => t.kind === "midi")],
  ["track names", p.tracks[0].name === "Piano" && p.tracks[1].name === "Bass"],
  ["clips exist", p.tracks.every((t) => t.clips.length === 1)],
  ["piano has 3 notes", p.tracks[0].clips[0].notes?.length === 3],
  ["bass note at bar 2", Math.abs((p.tracks[1].clips[0].notes?.[0]?.startBeat ?? -1) + (p.tracks[1].clips[0].startBeat ?? 0) - 4) < 0.01],
  ["note pitch C4", p.tracks[0].clips[0].notes?.[0]?.pitch === 60],
  ["project named after file", (p.name ?? "").toLowerCase().includes("mydaw-import-test")],
];
// Phase 1: tempo map + CC/PB import
const cc = p.tracks[0].clips[0].cc ?? [];
const sus = cc.filter((e) => e.controller === 64);
const pb = cc.filter((e) => e.controller === 128);
checks.push(
  ["tempo map has 2 entries (95 -> 140 @ beat 8)",
    p.tempoMap?.length === 2 && Math.abs(p.tempoMap[1].bpm - 140) < 0.01 && Math.abs(p.tempoMap[1].beat - 8) < 0.01],
  ["sustain (CC64) imported: down+up", sus.length === 2 && sus[0].value > 0.9 && sus[1].value < 0.01],
  ["pitch bend imported at beat 1 (~0.75)", pb.length === 1 && Math.abs(pb[0].beat - 1) < 0.01 && Math.abs(pb[0].value - ((0x60 << 7) / 16383)) < 0.02],
);
let fail = 0;
for (const [n, ok] of checks) { console.log(`[${ok ? "PASS" : "FAIL"}] ${n}`); if (!ok) fail++; }

// Phase 1: export/midi -> reimport roundtrip
const rtPath = path.join(os.tmpdir(), "mydaw-roundtrip.mid");
await req("export/midi", { path: rtPath });
const { project: p2 } = await req("project/importForeign", { path: rtPath });
const ccCount = (pr) => pr.tracks.reduce((s, t) => s + t.clips.reduce((c, cl) => c + (cl.cc?.length ?? 0), 0), 0);
const noteCount = (pr) => pr.tracks.reduce((s, t) => s + t.clips.reduce((c, cl) => c + (cl.notes?.length ?? 0), 0), 0);
const rtChecks = [
  ["roundtrip: tempo map preserved", p2.tempoMap?.length === 2 && Math.abs(p2.tempoMap[1].bpm - 140) < 0.01],
  ["roundtrip: note count preserved", noteCount(p2) === noteCount(p)],
  ["roundtrip: cc count preserved", ccCount(p2) === ccCount(p) && ccCount(p2) >= 3],
  ["roundtrip: track names preserved", p2.tracks[0]?.name === "Piano" && p2.tracks[1]?.name === "Bass"],
];
for (const [n, ok] of rtChecks) { console.log(`[${ok ? "PASS" : "FAIL"}] ${n}`); if (!ok) fail++; }

// no_provider error path
const bad = path.join(os.tmpdir(), "mydaw-import-test.xyz");
writeFileSync(bad, "not a project");
const err = await req("project/importForeign", { path: bad }).then(() => null).catch((e) => e.message);
const noProv = !!err && err.includes("no_provider");
console.log(`[${noProv ? "PASS" : "FAIL"}] unknown extension -> no_provider (${err})`);
if (!noProv) fail++;

die(fail ? 1 : 0, fail ? `\nIMPORT TEST: ${fail} FAILED` : "\nIMPORT TEST: ALL PASS");
