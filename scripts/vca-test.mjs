#!/usr/bin/env node
/**
 * VCA group fader test. Assigns a track to a VCA and verifies the VCA gain multiplies the
 * track's rendered level, that it persists through saveAs/load, and that removing the VCA
 * detaches the member (gain back to unity).
 * Usage: node scripts/vca-test.mjs [--port 8560]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8560"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-vca-"));
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

const peakOf = (file) => { if (!existsSync(file)) return null; const w = readFileSync(file); if (w.toString("ascii", 0, 4) !== "RIFF") return null; let pk = 0; for (let i = 200; i + 1 < Math.min(w.length, 800000); i += 2) pk = Math.max(pk, Math.abs(w.readInt16LE(i))); return pk; };
let seq = 0;
const render = async () => { const out = path.join(TMP, `r${seq++}.wav`); await req("export/render", { path: out, startBeat: 0, endBeat: 2, format: { type: "wav", bitDepth: 16 } }, 120000); return peakOf(out); };

try {
  await req("session/hello", { clientName: "vca" });
  await req("project/new", {});
  const t = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "sine.wav");
  await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${t.id}&atBeat=0`, { method: "POST", body: fd });
  await sleep(400);

  const base = await render();
  report("baseline render nonzero", base != null && base > 100, `peak=${base}`);

  const vca = (await req("cmd/vca.add", { name: "Group A" })).vca;
  report("cmd/vca.add returns a vca id", !!vca?.id, `id=${vca?.id} name=${vca?.name}`);
  await req("cmd/track.set", { trackId: t.id, patch: { vcaId: vca.id } });

  await req("cmd/vca.set", { id: vca.id, patch: { gain: 0.5 } });
  const half = await render();
  report("VCA gain 0.5 halves the member's level", half != null && Math.abs(half - base * 0.5) < base * 0.08,
    `base=${base} half=${half} (ratio ${(half / base).toFixed(3)})`);

  await req("cmd/vca.set", { id: vca.id, patch: { gain: 1.0 } });
  const full = await render();
  report("VCA gain 1.0 restores the member's level", full != null && Math.abs(full - base) < base * 0.05, `base=${base} full=${full}`);

  // persistence
  await req("cmd/vca.set", { id: vca.id, patch: { gain: 0.5 } });
  const projDir = path.join(TMP, "Vca.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  const savedVca = (saved.vcas ?? []).find((v) => v.id === vca.id);
  const savedTrack = saved.tracks.find((x) => x.id === t.id);
  report("saveAs persists vcas + track.vcaId", !!savedVca && Math.abs(savedVca.gain - 0.5) < 1e-6 && savedTrack?.vcaId === vca.id,
    `vcaGain=${savedVca?.gain} track.vcaId=${savedTrack?.vcaId}`);

  await req("project/load", { path: projDir });
  await sleep(400);
  const reloaded = await render();
  report("reloaded project applies the VCA gain", reloaded != null && Math.abs(reloaded - base * 0.5) < base * 0.08, `peak=${reloaded} (want ~${(base * 0.5) | 0})`);

  // remove → detach → unity
  const lv = (await req("session/hello", { clientName: "vca" })).project.vcas[0];
  await req("cmd/vca.remove", { id: lv.id });
  const afterRemove = await render();
  report("removing the VCA detaches the member (unity)", afterRemove != null && Math.abs(afterRemove - base) < base * 0.05, `peak=${afterRemove} base=${base}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "VCA TEST: ALL PASS" : "VCA TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "VCA TEST: EXCEPTION\n" + elog.slice(-800));
}
