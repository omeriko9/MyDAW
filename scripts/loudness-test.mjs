#!/usr/bin/env node
/**
 * Loudness (BS.1770) export test. Renders a sine and checks:
 *   - export/render reply carries integrated `lufs` (finite, sane) + `peakDb`
 *   - a `loudnessTarget` normalizes the output to ~that LUFS (down AND up), verified by the
 *     reply's measured loudness of the actually-written signal
 * Usage: node scripts/loudness-test.mjs [--port 8557]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8557"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-loud-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };

function makeSineWav(sr = 44100, secs = 3, freq = 440, amp = 0.5) {
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
const req = (t, payload = {}, ms = 120000) => { const id = nextId++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };

const exportRange = (fmt) => req("export/render", { path: path.join(TMP, `m${nextId}.wav`), startBeat: 0, endBeat: 4, format: fmt.format ?? { type: "wav", bitDepth: 24 }, ...(fmt.loudnessTarget !== undefined ? { loudnessTarget: fmt.loudnessTarget } : {}) }, 120000);

try {
  await req("session/hello", { clientName: "loud" });
  await req("project/new", {});
  const t = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "sine.wav");
  const upl = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${t.id}&atBeat=0`, { method: "POST", body: fd });
  report("upload sine", upl.ok, `http ${upl.status}`);
  await sleep(400);

  const base = await exportRange({});
  const lufsFinite = typeof base.lufs === "number" && isFinite(base.lufs) && base.lufs < -1 && base.lufs > -40;
  const peakOk = typeof base.peakDb === "number" && base.peakDb < 0 && base.peakDb > -20;
  report("export reply carries integrated LUFS + peak dBFS", lufsFinite && peakOk, `lufs=${base.lufs?.toFixed(2)} peakDb=${base.peakDb?.toFixed(2)}`);

  for (const target of [-16, -10]) {
    const r = await exportRange({ loudnessTarget: target });
    const near = typeof r.lufs === "number" && Math.abs(r.lufs - target) < 1.5;
    report(`loudnessTarget ${target} LUFS normalizes output to ~${target}`, near, `measured=${r.lufs?.toFixed(2)}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "LOUDNESS TEST: ALL PASS" : "LOUDNESS TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "LOUDNESS TEST: EXCEPTION\n" + elog.slice(-800));
}
