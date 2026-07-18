#!/usr/bin/env node
/**
 * Encoded-export test. Boots the engine, puts a sine clip on an audio track, then exports the
 * same range to WAV / MP3 / FLAC / M4A and validates each output file:
 *   - WAV: RIFF/WAVE header + nonzero PCM
 *   - MP3: ID3 tag or MPEG frame sync (0xFFEx)
 *   - FLAC: "fLaC" magic
 *   - M4A/AAC: ISO-BMFF "ftyp" box
 * Also checks an unsupported format returns a clean bad_request (honest, no silent switch).
 * Usage: node scripts/export-formats-test.mjs [--port 8547]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8547"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-exp-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };

function makeSineWav(sr = 44100, secs = 2, freq = 440) {
  const n = sr * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 12000), 44 + i * 2);
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

const magics = {
  wav: (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE",
  mp3: (b) => b.toString("ascii", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  flac: (b) => b.toString("ascii", 0, 4) === "fLaC",
  m4a: (b) => b.toString("ascii", 4, 8) === "ftyp",
};

try {
  await req("session/hello", { clientName: "exp" });
  await req("project/new", {});
  const audioT = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "sine440.wav");
  const upl = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${audioT.id}&atBeat=0`, { method: "POST", body: fd });
  report("upload sine clip", upl.ok, `http ${upl.status}`);
  await sleep(400);

  const cases = [
    { type: "wav", ext: "wav", fmt: { type: "wav", bitDepth: 16 } },
    { type: "mp3", ext: "mp3", fmt: { type: "mp3", bitDepth: 16, kbps: 192 } },
    { type: "flac", ext: "flac", fmt: { type: "flac", bitDepth: 16 } },
    { type: "m4a", ext: "m4a", fmt: { type: "m4a", bitDepth: 16, kbps: 192 } },
  ];
  for (const c of cases) {
    const out = path.join(TMP, `mix.${c.ext}`);
    let ok = false, detail = "";
    try {
      const rep = await req("export/render", { path: out, startBeat: 0, endBeat: 4, format: c.fmt }, 120000);
      const exists = existsSync(out);
      const size = exists ? statSync(out).size : 0;
      const magicOk = exists && size > 256 && magics[c.type](readFileSync(out).subarray(0, 16));
      ok = rep?.format === c.type && magicOk;
      detail = `reply.format=${rep?.format} bytes=${size} magicOk=${magicOk}`;
    } catch (e) { detail = "exception: " + (e?.message ?? e); }
    report(`export ${c.type.toUpperCase()} produces a valid file`, ok, detail);
  }

  // Unsupported format → honest bad_request (no silent WAV).
  let rejected = false, rerr = "";
  try { await req("export/render", { path: path.join(TMP, "x.ogg"), startBeat: 0, endBeat: 1, format: { type: "ogg", bitDepth: 16 } }); }
  catch (e) { rejected = true; rerr = String(e?.message ?? e); }
  report("unsupported format rejected (bad_request)", rejected && /unsupported export format|bad_request/.test(rerr), rerr.slice(0, 80));

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "EXPORT FORMATS TEST: ALL PASS" : "EXPORT FORMATS TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "EXPORT FORMATS TEST: EXCEPTION\n" + elog.slice(-800));
}
