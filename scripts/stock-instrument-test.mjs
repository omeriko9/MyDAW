#!/usr/bin/env node
/**
 * Stock instrument test. Boots the engine, makes an instrument track with the built-in Synth,
 * writes a MIDI chord clip, and verifies the synth is a working MIDI-driven source:
 *   - registry lists builtin:synth as isInstrument
 *   - cmd/plugin.add on an instrument track creates an in-engine instrument node
 *   - a rendered MIDI chord produces nonzero audio (the synth made sound from MIDI)
 *   - removing the synth leaves the track silent (it WAS the source)
 *   - Gain param attenuates the render; params persist through saveAs/load and still play
 * Usage: node scripts/stock-instrument-test.mjs [--port 8552]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8552"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-inst-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };

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

const peakOf = (file) => {
  if (!existsSync(file)) return null;
  const w = readFileSync(file);
  if (w.toString("ascii", 0, 4) !== "RIFF") return null;
  let pk = 0;
  for (let i = 200; i + 1 < Math.min(w.length, 800000); i += 2) pk = Math.max(pk, Math.abs(w.readInt16LE(i)));
  return pk;
};
let seq = 0;
const render = async () => {
  const out = path.join(TMP, `r${seq++}.wav`);
  await req("export/render", { path: out, startBeat: 0, endBeat: 2, format: { type: "wav", bitDepth: 16 } }, 120000);
  return peakOf(out);
};

try {
  await req("session/hello", { clientName: "inst" });
  await req("project/new", {});
  const inst = (await req("cmd/track.add", { kind: "instrument", name: "Synth Trk" })).track;

  const reg = (await req("plugins/getRegistry", {})).registry;
  const synth = reg.find((p) => p.uid === "builtin:synth");
  report("registry lists builtin:synth as instrument", !!synth && synth.isInstrument === true && synth.format === "builtin",
    `found=${!!synth} isInstrument=${synth?.isInstrument}`);

  const si = (await req("cmd/plugin.add", { trackId: inst.id, uid: "builtin:synth" })).instance;
  report("add builtin:synth to instrument track", !!si?.instanceId && si.format === "builtin", `id=${si?.instanceId} name=${si?.name}`);

  // MIDI chord clip (C major, beats 0..2)
  const clip = (await req("cmd/clip.addMidi", { trackId: inst.id, startBeat: 0, lengthBeats: 2 })).clip;
  await req("cmd/notes.edit", { clipId: clip.id, add: [
    { pitch: 60, velocity: 110, startBeat: 0, lengthBeats: 1.5 },
    { pitch: 64, velocity: 110, startBeat: 0, lengthBeats: 1.5 },
    { pitch: 67, velocity: 110, startBeat: 0, lengthBeats: 1.5 },
  ] });
  await sleep(200);

  const withSynth = await render();
  report("synth renders MIDI chord to nonzero audio", withSynth != null && withSynth > 100, `peak=${withSynth}`);

  // getParams
  const gp = (await req("plugin/getParams", { instanceId: si.instanceId }));
  const params = gp.params ?? [];
  const gainP = params.find((p) => p.name === "Gain");
  const waveP = params.find((p) => p.name === "Waveform");
  report("synth exposes params (Waveform/Cutoff/…/Gain)", params.length >= 8 && !!gainP && !!waveP && gp.hasEditor === false,
    `n=${params.length} names=${params.map((p) => p.name).join("/")}`);

  // Gain to -24 dB (norm 0) → quieter
  await req("cmd/plugin.setParam", { instanceId: si.instanceId, paramId: gainP.id, value: 0 });
  const quiet = await render();
  report("Gain -24 dB attenuates the synth", quiet != null && withSynth != null && quiet < withSynth * 0.5, `full=${withSynth} quiet=${quiet}`);
  await req("cmd/plugin.setParam", { instanceId: si.instanceId, paramId: gainP.id, value: ((-6) - (-24)) / (6 - (-24)) }); // back to -6 dB

  // Remove synth → track is silent (it was the source)
  await req("cmd/plugin.remove", { trackId: inst.id, instanceId: si.instanceId });
  const noSynth = await render();
  report("removing synth leaves the track silent", noSynth != null && noSynth < 5, `peak=${noSynth}`);

  // Re-add + persistence
  const si2 = (await req("cmd/plugin.add", { trackId: inst.id, uid: "builtin:synth" })).instance;
  await req("cmd/plugin.setParam", { instanceId: si2.instanceId, paramId: gainP.id, value: (0 - -24) / (6 - -24) }); // 0 dB
  const projDir = path.join(TMP, "Inst.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  const savedInsert = saved.tracks.flatMap((t) => t.inserts ?? []).find((i) => i.uid === "builtin:synth");
  report("saveAs persists the synth insert", !!savedInsert && savedInsert.format === "builtin", `insert=${!!savedInsert}`);

  await req("project/load", { path: projDir });
  await sleep(500);
  const reloadPeak = await render();
  report("reloaded synth still plays the chord", reloadPeak != null && reloadPeak > 100, `peak=${reloadPeak}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "STOCK INSTRUMENT TEST: ALL PASS" : "STOCK INSTRUMENT TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "STOCK INSTRUMENT TEST: EXCEPTION\n" + elog.slice(-800));
}
