#!/usr/bin/env node
/**
 * Sidechain compressor test. Proves the built-in compressor can key its detector off ANOTHER
 * track instead of its own input:
 *   - a quiet "target" track (below the compressor threshold) and a loud "key" source track
 *   - the key track is MUTED (contributes nothing to the mix) but its pre-fader signal is still
 *     captured, so the export measures the target alone
 *   - without a sidechain the sub-threshold target passes ~unchanged (self-detection idle)
 *   - wiring sidechainSource = key track makes the loud key duck the target (RMS drops)
 *   - the routing round-trips through saveAs/load and still ducks
 *   - clearing sidechainSource (0) restores the un-ducked level
 * Usage: node scripts/sidechain-test.mjs [--port 8561]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8561"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-sc-"));
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

const rmsOf = (file) => { if (!existsSync(file)) return null; const w = readFileSync(file); if (w.toString("ascii", 0, 4) !== "RIFF") return null; let sum = 0, n = 0; for (let i = 2000; i + 1 < Math.min(w.length, 800000); i += 2) { const v = w.readInt16LE(i); sum += v * v; n++; } return n > 0 ? Math.sqrt(sum / n) : 0; };
let seq = 0;
const render = async () => { const out = path.join(TMP, `r${seq++}.wav`); await req("export/render", { path: out, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } }, 120000); return rmsOf(out); };
const norm = (v, lo, hi) => (v - lo) / (hi - lo); // linear param norm

const uploadClip = async (trackId, wav) => {
  const fd = new FormData();
  fd.append("files", new Blob([wav], { type: "audio/wav" }), "clip.wav");
  await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${trackId}&atBeat=0`, { method: "POST", body: fd });
};

try {
  await req("session/hello", { clientName: "sc" });
  await req("project/new", {});

  // Target: quiet sine (~-18 dBFS peak) — below the compressor threshold on its own.
  const target = (await req("cmd/track.add", { kind: "audio", name: "Target" })).track;
  await uploadClip(target.id, makeSineWav(44100, 2, 220, 0.12));
  // Key/source: loud sine (~-3 dBFS peak); muted so it never reaches the mix, only the detector.
  const key = (await req("cmd/track.add", { kind: "audio", name: "Key" })).track;
  await uploadClip(key.id, makeSineWav(44100, 2, 660, 0.7));
  await req("cmd/track.set", { trackId: key.id, patch: { mute: true } });
  await sleep(500);

  const dry = await render();
  report("dry render is nonzero (target only; key muted)", dry != null && dry > 1, `rms=${dry?.toFixed(1)}`);

  // Compressor on the target: threshold -12 dB, 20:1, fast attack, medium release, no makeup.
  const comp = (await req("cmd/plugin.add", { trackId: target.id, uid: "builtin:compressor" })).instance;
  report("add builtin:compressor to target", !!comp?.instanceId && comp.format === "builtin", `id=${comp?.instanceId}`);
  const cp = (await req("plugin/getParams", { instanceId: comp.instanceId })).params;
  const byName = (nm) => cp.find((p) => p.name === nm);
  const setP = (nm, value) => req("cmd/plugin.setParam", { instanceId: comp.instanceId, paramId: byName(nm).id, value });
  await setP("Threshold", norm(-12, -60, 0));
  await setP("Ratio", 1.0);          // 20:1
  await setP("Attack", 0.0);         // 0.1 ms
  await setP("Release", 0.6);        // ~200 ms — steady reduction, not per-cycle pumping
  await setP("Knee", 0.0);
  await setP("Makeup", 0.0);

  const selfRender = await render();
  report("sub-threshold target passes ~unchanged without a sidechain", selfRender != null && Math.abs(selfRender - dry) / dry < 0.15,
    `dry=${dry?.toFixed(1)} self=${selfRender?.toFixed(1)} (ratio ${(selfRender / dry).toFixed(3)})`);

  // Wire the loud key track into the compressor's detector.
  await req("cmd/plugin.set", { instanceId: comp.instanceId, patch: { sidechainSource: key.id } });
  const scRender = await render();
  report("sidechain from the loud key ducks the target", scRender != null && scRender < dry * 0.75,
    `dry=${dry?.toFixed(1)} sc=${scRender?.toFixed(1)} (ratio ${(scRender / dry).toFixed(3)})`);
  report("sidechain ducks strictly more than self-detection", scRender != null && selfRender != null && scRender < selfRender * 0.9,
    `self=${selfRender?.toFixed(1)} sc=${scRender?.toFixed(1)}`);

  // Persistence: sidechainSource round-trips.
  const projDir = path.join(TMP, "Sidechain.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  const savedIns = saved.tracks.flatMap((t) => t.inserts ?? []).find((i) => i.uid === "builtin:compressor");
  report("saveAs persists sidechainSource on the insert", savedIns?.sidechainSource === key.id,
    `sidechainSource=${savedIns?.sidechainSource} key=${key.id}`);

  await req("project/load", { path: projDir });
  await sleep(600);
  const reloaded = await render();
  report("reloaded project still ducks via the sidechain", reloaded != null && reloaded < dry * 0.75,
    `dry=${dry?.toFixed(1)} reloaded=${reloaded?.toFixed(1)}`);

  // Clear the routing → back to the un-ducked level.
  const lt = (await req("session/hello", { clientName: "sc" })).project.tracks.find((t) => (t.inserts ?? []).some((i) => i.uid === "builtin:compressor"));
  const lComp = (lt.inserts ?? []).find((i) => i.uid === "builtin:compressor");
  await req("cmd/plugin.set", { instanceId: lComp.instanceId, patch: { sidechainSource: 0 } });
  const cleared = await render();
  report("clearing sidechainSource restores the un-ducked level", cleared != null && Math.abs(cleared - dry) / dry < 0.15,
    `dry=${dry?.toFixed(1)} cleared=${cleared?.toFixed(1)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "SIDECHAIN TEST: ALL PASS" : "SIDECHAIN TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "SIDECHAIN TEST: EXCEPTION\n" + elog.slice(-800));
}
