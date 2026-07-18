#!/usr/bin/env node
/**
 * Time-stretch / transpose test (WSOLA). Uploads a sine clip and verifies cmd/clip.stretch:
 *   - ratio 2.0 makes the clip ~2x longer (samples), still audible
 *   - ratio 0.5 makes it ~half length
 *   - transpose (ratio 1.5) keeps the SAME length (pitch shift at constant duration)
 *   - the stretched derivative persists through saveAs/load and still plays
 * Usage: node scripts/timestretch-test.mjs [--port 8562]
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
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-ts-"));
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
sock.onmessage = (m) => { const j = JSON.parse(m.data); if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); } } };
const req = (t, payload = {}, ms = 60000) => { const id = nextId++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };

const peakOf = (file) => { if (!existsSync(file)) return null; const w = readFileSync(file); if (w.toString("ascii", 0, 4) !== "RIFF") return null; let pk = 0; for (let i = 200; i + 1 < Math.min(w.length, 1600000); i += 2) pk = Math.max(pk, Math.abs(w.readInt16LE(i))); return pk; };
let seq = 0;
const render = async (endBeat = 8) => { const out = path.join(TMP, `r${seq++}.wav`); await req("export/render", { path: out, startBeat: 0, endBeat, format: { type: "wav", bitDepth: 16 } }, 120000); return peakOf(out); };
const clipLen = async (clipId) => {
  const proj = (await req("session/hello", {})).project;
  for (const t of proj.tracks) for (const c of (t.clips ?? [])) if (c.id === clipId) return c.lengthSamples;
  return null;
};

try {
  await req("session/hello", { clientName: "ts" });
  await req("project/new", {});
  const t = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "sine.wav");
  const upl = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${t.id}&atBeat=0`, { method: "POST", body: fd });
  const upj = await upl.json().catch(() => ({}));
  const clipId = (upj.clips ?? upj.payload?.clips ?? [])[0]?.id ?? (await req("session/hello", {})).project.tracks.find((x) => x.id === t.id)?.clips?.[0]?.id;
  await sleep(400);
  const origLen = await clipLen(clipId);
  report("uploaded clip has a length", !!clipId && origLen > 1000, `clipId=${clipId} len=${origLen}`);
  const base = await render();

  // stretch 2x (slower, longer)
  const s2 = await req("cmd/clip.stretch", { clipId, ratio: 2.0 });
  await sleep(500);
  const len2 = await clipLen(clipId);
  report("stretch ratio 2.0 ~doubles the clip length", Math.abs(len2 - origLen * 2) < origLen * 0.05, `orig=${origLen} new=${len2} (reply=${s2.lengthSamples})`);
  const peak2 = await render();
  report("stretched clip still renders audible audio", peak2 != null && peak2 > 100, `peak=${peak2}`);

  // stretch back to 0.5 of current (net ~original)
  await req("cmd/clip.stretch", { clipId, ratio: 0.5 });
  await sleep(500);
  const len3 = await clipLen(clipId);
  report("stretch ratio 0.5 ~halves the (now-doubled) length", Math.abs(len3 - len2 * 0.5) < len2 * 0.06, `from=${len2} to=${len3}`);

  // persistence
  const projDir = path.join(TMP, "Ts.mydaw");
  await req("project/saveAs", { path: projDir });
  await req("project/load", { path: projDir });
  await sleep(600);
  const reloaded = await render();
  report("reloaded stretched clip still plays", reloaded != null && reloaded > 100, `peak=${reloaded}`);

  // transpose keeps the length constant
  const lenBefore = await clipLen(clipId);
  await req("cmd/clip.stretch", { clipId, ratio: 1.5, transpose: true });
  await sleep(500);
  const lenAfter = await clipLen(clipId);
  report("transpose keeps the clip length ~constant", Math.abs(lenAfter - lenBefore) < lenBefore * 0.05, `before=${lenBefore} after=${lenAfter}`);
  const peakT = await render();
  report("transposed clip still renders audible audio", peakT != null && peakT > 100, `peak=${peakT}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "TIME-STRETCH TEST: ALL PASS" : "TIME-STRETCH TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "TIME-STRETCH TEST: EXCEPTION\n" + elog.slice(-800));
}
