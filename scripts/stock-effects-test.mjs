#!/usr/bin/env node
/**
 * Stock (built-in) effects test. Boots the engine, uploads a sine clip on an audio track,
 * then exercises the in-engine effect inserts end-to-end:
 *   - the registry lists all built-in effects (format "builtin")
 *   - cmd/plugin.add creates an in-engine node (no host process)
 *   - plugin/getParams returns the effect's param list (id/name/label/value/defaultValue/valueText)
 *   - a Utility gain at -20 dB measurably attenuates the rendered RMS; bypass restores it
 *   - compressor / reverb are audibly in the chain (rendered RMS differs from dry)
 *   - params round-trip through saveAs/load (paramValues), and the reloaded node still attenuates
 * Usage: node scripts/stock-effects-test.mjs [--port 8543]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8543"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-fx-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

function makeSineWav(sr = 44100, secs = 2, freq = 440) {
  const n = sr * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 12000), 44 + i * 2);
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
sock.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); } }
};
const req = (t, payload = {}, ms = 60000) => { const id = nextId++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };

const rmsOf = (file) => {
  if (!existsSync(file)) return null;
  const w = readFileSync(file);
  if (w.toString("ascii", 0, 4) !== "RIFF") return null;
  let sum = 0, n = 0;
  for (let i = 200; i + 1 < Math.min(w.length, 800000); i += 2) { const v = w.readInt16LE(i); sum += v * v; n++; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
};
let renderSeq = 0;
const render = async (trackId) => {
  const out = path.join(TMP, `r${renderSeq++}.wav`);
  await req("export/render", { path: out, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } }, 120000);
  return rmsOf(out);
};

try {
  await req("session/hello", { clientName: "fx" });
  await req("project/new", {});
  const audioT = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;

  // sine clip at beat 0
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "sine440.wav");
  const upl = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${audioT.id}&atBeat=0`, { method: "POST", body: fd });
  report("upload sine clip", upl.ok, `http ${upl.status}`);
  await sleep(400); // let PCM decode + plan rebuild

  // 1. registry lists all 6 built-ins
  const reg = (await req("plugins/getRegistry", {})).registry;
  const wantUids = ["builtin:utility", "builtin:gate", "builtin:compressor", "builtin:limiter", "builtin:delay", "builtin:reverb"];
  const builtins = reg.filter((p) => p.format === "builtin");
  const haveAll = wantUids.every((u) => builtins.some((p) => p.uid === u));
  report("registry lists all built-in effects", haveAll && builtins.length >= 6, `found ${builtins.length}: ${builtins.map((p) => p.name).join(", ")}`);

  const dry = await render(audioT.id);
  report("dry render is nonzero", dry != null && dry > 1, `rms=${dry?.toFixed(1)}`);

  // 2. Utility gain: add, inspect params, attenuate, bypass
  const util = (await req("cmd/plugin.add", { trackId: audioT.id, uid: "builtin:utility" })).instance;
  report("add builtin:utility -> instance", !!util?.instanceId && util.format === "builtin", `id=${util?.instanceId} fmt=${util?.format} name=${util?.name}`);

  const gp = (await req("plugin/getParams", { instanceId: util.instanceId }));
  const params = gp.params ?? [];
  const gainP = params.find((p) => p.name === "Gain");
  report("getParams returns Utility params (Gain/Pan/…)", params.length >= 4 && !!gainP && gp.hasEditor === false,
    `n=${params.length} names=${params.map((p) => p.name).join("/")}`);

  // set Gain to -20 dB: norm = (-20 - -60)/(24 - -60) = 0.4762
  const gainNorm = (-20 - -60) / (24 - -60);
  await req("cmd/plugin.setParam", { instanceId: util.instanceId, paramId: gainP.id, value: gainNorm });
  const attn = await render(audioT.id);
  report("Utility -20 dB attenuates rendered RMS", attn != null && dry != null && attn < dry * 0.5,
    `dry=${dry?.toFixed(1)} attn=${attn?.toFixed(1)} (ratio ${(attn / dry).toFixed(3)})`);

  // bypass restores level
  await req("cmd/plugin.set", { instanceId: util.instanceId, patch: { bypass: true } });
  const byp = await render(audioT.id);
  report("bypass restores dry level", byp != null && Math.abs(byp - dry) / dry < 0.05, `dry=${dry?.toFixed(1)} byp=${byp?.toFixed(1)}`);
  await req("cmd/plugin.set", { instanceId: util.instanceId, patch: { bypass: false } });

  // 3. Compressor + Reverb are in the chain (rendered RMS differs from dry-through-utility-unity)
  await req("cmd/plugin.setParam", { instanceId: util.instanceId, paramId: gainP.id, value: (0 - -60) / (24 - -60) }); // back to 0 dB
  const comp = (await req("cmd/plugin.add", { trackId: audioT.id, uid: "builtin:compressor" })).instance;
  const cp = (await req("plugin/getParams", { instanceId: comp.instanceId })).params;
  const thr = cp.find((p) => p.name === "Threshold");
  await req("cmd/plugin.setParam", { instanceId: comp.instanceId, paramId: thr.id, value: (-40 - -60) / (0 - -60) }); // -40 dB thresh (heavy)
  const withComp = await render(audioT.id);
  report("compressor renders (nonzero, differs from dry)", withComp != null && withComp > 1 && Math.abs(withComp - dry) / dry > 0.02,
    `dry=${dry?.toFixed(1)} comp=${withComp?.toFixed(1)}`);
  await req("cmd/plugin.remove", { trackId: audioT.id, instanceId: comp.instanceId });

  const rev = (await req("cmd/plugin.add", { trackId: audioT.id, uid: "builtin:reverb" })).instance;
  const withRev = await render(audioT.id);
  report("reverb renders nonzero", withRev != null && withRev > 1, `rms=${withRev?.toFixed(1)}`);
  await req("cmd/plugin.remove", { trackId: audioT.id, instanceId: rev.instanceId });

  // 4. Persistence: Utility at -20 dB survives saveAs/load and still attenuates
  await req("cmd/plugin.setParam", { instanceId: util.instanceId, paramId: gainP.id, value: gainNorm });
  const projDir = path.join(TMP, "Fx.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  const savedInsert = saved.tracks.flatMap((t) => t.inserts ?? []).find((i) => i.uid === "builtin:utility");
  const savedGain = savedInsert?.paramValues?.[String(gainP.id)];
  report("saveAs persists built-in insert + paramValues", !!savedInsert && savedInsert.format === "builtin" && Math.abs((savedGain ?? 0) - gainNorm) < 1e-6,
    `insert=${!!savedInsert} gainNorm=${savedGain}`);

  const loaded = await req("project/load", { path: projDir });
  await sleep(500); // recreatePluginInstances + PCM reload + rebuild
  const lt = loaded.project.tracks.find((t) => (t.inserts ?? []).some((i) => i.uid === "builtin:utility"));
  const lIns = (lt?.inserts ?? []).find((i) => i.uid === "builtin:utility");
  const lp = (await req("plugin/getParams", { instanceId: lIns.instanceId })).params;
  const lGain = lp.find((p) => p.name === "Gain");
  report("reloaded built-in reports persisted param value", Math.abs((lGain?.value ?? 0) - gainNorm) < 1e-3, `value=${lGain?.value?.toFixed(4)} want=${gainNorm.toFixed(4)}`);
  const attn2 = await render(lt.id);
  report("reloaded Utility still attenuates", attn2 != null && dry != null && attn2 < dry * 0.5, `dry=${dry?.toFixed(1)} attn2=${attn2?.toFixed(1)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "STOCK EFFECTS TEST: ALL PASS" : "STOCK EFFECTS TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "STOCK EFFECTS TEST: EXCEPTION\n" + elog.slice(-800));
}
