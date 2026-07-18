#!/usr/bin/env node
/**
 * Stock sampler test. Uploads a WAV, assigns it to the built-in Sampler on an instrument track,
 * and verifies MIDI-driven playback + persistence:
 *   - registry lists builtin:sampler as an instrument
 *   - upload → assetId → cmd/plugin.setSample binds the PCM
 *   - a rendered MIDI note plays the sample (nonzero); no sample = silence
 *   - the sampleAssetId + the WAV survive saveAs/load and the reloaded sampler still plays
 * Usage: node scripts/stock-sampler-test.mjs [--port 8559]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8559"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-smp-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };

function makeSineWav(sr = 44100, secs = 1, freq = 440, amp = 0.6) {
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
sock.onmessage = (m) => { const j = JSON.parse(m.data); if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); } } };
const req = (t, payload = {}, ms = 60000) => { const id = nextId++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };

const peakOf = (file) => { if (!existsSync(file)) return null; const w = readFileSync(file); if (w.toString("ascii", 0, 4) !== "RIFF") return null; let pk = 0; for (let i = 200; i + 1 < Math.min(w.length, 800000); i += 2) pk = Math.max(pk, Math.abs(w.readInt16LE(i))); return pk; };
let seq = 0;
const render = async () => { const out = path.join(TMP, `r${seq++}.wav`); await req("export/render", { path: out, startBeat: 0, endBeat: 2, format: { type: "wav", bitDepth: 16 } }, 120000); return peakOf(out); };

try {
  await req("session/hello", { clientName: "smp" });
  await req("project/new", {});
  const inst = (await req("cmd/track.add", { kind: "instrument", name: "Sampler Trk" })).track;

  const reg = (await req("plugins/getRegistry", {})).registry;
  const sm = reg.find((p) => p.uid === "builtin:sampler");
  report("registry lists builtin:sampler as instrument", !!sm && sm.isInstrument === true, `found=${!!sm} isInstrument=${sm?.isInstrument}`);

  const si = (await req("cmd/plugin.add", { trackId: inst.id, uid: "builtin:sampler" })).instance;
  report("add builtin:sampler", !!si?.instanceId && si.format === "builtin", `id=${si?.instanceId}`);

  // MIDI note at root (C4 = 60), beats 0..1.5
  const clip = (await req("cmd/clip.addMidi", { trackId: inst.id, startBeat: 0, lengthBeats: 2 })).clip;
  await req("cmd/notes.edit", { clipId: clip.id, add: [{ pitch: 60, velocity: 120, startBeat: 0, lengthBeats: 1.5 }] });
  await sleep(150);

  // no sample yet → silence
  const silent = await render();
  report("sampler with no sample is silent", silent != null && silent < 5, `peak=${silent}`);

  // upload WAV → assetId
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "hit.wav");
  const upl = await fetch(`http://127.0.0.1:${PORT}/api/upload`, { method: "POST", body: fd });
  const upJson = await upl.json().catch(() => ({}));
  const assets = upJson.assets ?? upJson.payload?.assets ?? [];
  const assetId = assets[0]?.id;
  report("upload WAV returns an assetId", upl.ok && typeof assetId === "number", `http ${upl.status} assetId=${assetId}`);
  await sleep(300);

  await req("cmd/plugin.setSample", { instanceId: si.instanceId, assetId });
  await sleep(150);
  const withSample = await render();
  report("sampler plays the assigned sample on a MIDI note", withSample != null && withSample > 100, `peak=${withSample}`);

  // persistence
  const projDir = path.join(TMP, "Smp.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  const savedInsert = saved.tracks.flatMap((t) => t.inserts ?? []).find((i) => i.uid === "builtin:sampler");
  const audioDir = path.join(projDir, "audio");
  const wavCopied = existsSync(audioDir) && readdirSync(audioDir).some((f) => f.toLowerCase().endsWith(".wav"));
  report("saveAs persists sampleAssetId + copies the WAV into the project", !!savedInsert && savedInsert.sampleAssetId === assetId && wavCopied,
    `sampleAssetId=${savedInsert?.sampleAssetId} wavCopied=${wavCopied}`);

  await req("project/load", { path: projDir });
  await sleep(700); // recreate + loadAsync + rebuild rebinds the sample
  const reloadPeak = await render();
  report("reloaded sampler still plays the sample", reloadPeak != null && reloadPeak > 100, `peak=${reloadPeak}`);

  // clear the sample → silent again
  const li = (await req("session/hello", { clientName: "smp" })).project.tracks.flatMap((t) => t.inserts ?? []).find((i) => i.uid === "builtin:sampler");
  await req("cmd/plugin.setSample", { instanceId: li.instanceId, assetId: 0 });
  await sleep(150);
  const cleared = await render();
  report("clearing the sample silences the sampler", cleared != null && cleared < 5, `peak=${cleared}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "STOCK SAMPLER TEST: ALL PASS" : "STOCK SAMPLER TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "STOCK SAMPLER TEST: EXCEPTION\n" + elog.slice(-800));
}
