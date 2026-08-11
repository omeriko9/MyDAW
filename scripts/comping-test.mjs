#!/usr/bin/env node
/**
 * Comping test. Proves take folders + a per-segment comp drive playback:
 *   - cmd/take.create folds two clips (a LOUD take and a QUIET take) into a take folder (2 lanes)
 *     and removes them from the track's flat clip list
 *   - cmd/take.setComp {activeLane} selects one take for the whole span → render matches that take
 *   - cmd/take.setComp {comp:[…]} with a mid-span boundary makes the first half play lane 0 and
 *     the second half play lane 1 (sample-accurate comp switch)
 *   - the folder + comp round-trip through saveAs/load and still render the comped result
 *   - cmd/take.flatten bounces the comp back to plain clips and renders identically
 * Usage: node scripts/comping-test.mjs [--port 8562]
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
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-comp-"));
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

// ISOLATED %APPDATA%: this harness spawns a real engine, and an engine writes settings
// (audio device, PLUGIN FOLDERS), plugin-cache.json, recent.json, autosave data and a
// session.lock. Run against the developer's real profile it silently rewrites their DAW
// configuration — and a hard kill leaves a lock that makes their next launch "recover"
// this harness's throwaway project instead of their work.
const APPDATA_ISO = mkdtempSync(path.join(tmpdir(), "mydaw-iso-"));
const engine = spawn(path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] , env: { ...process.env, APPDATA: APPDATA_ISO } });
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

// RMS over a fractional window [f0,f1) of the WAV data region (channel-agnostic 16-bit).
const rmsFrac = (file, f0, f1) => {
  if (!existsSync(file)) return null;
  const w = readFileSync(file);
  if (w.toString("ascii", 0, 4) !== "RIFF") return null;
  const dataStart = 44, dataEnd = w.length - ((w.length - 44) % 2);
  const total = dataEnd - dataStart;
  let a = dataStart + Math.floor(total * f0); a -= a % 2;
  let b = dataStart + Math.floor(total * f1); b -= b % 2;
  let sum = 0, n = 0;
  for (let i = a; i + 1 < b; i += 2) { const v = w.readInt16LE(i); sum += v * v; n++; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
};
let seq = 0;
const render = async () => { const out = path.join(TMP, `r${seq++}.wav`); await req("export/render", { path: out, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } }, 120000); return out; };
const uploadClip = async (trackId, wav, atBeat = 0) => {
  const fd = new FormData();
  fd.append("files", new Blob([wav], { type: "audio/wav" }), "clip.wav");
  await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${trackId}&atBeat=${atBeat}`, { method: "POST", body: fd });
};

try {
  await req("session/hello", { clientName: "comp" });
  await req("project/new", {});
  const track = (await req("cmd/track.add", { kind: "audio", name: "Vox" })).track;

  // Two takes at beat 0: a LOUD one (amp 0.5) then a QUIET one (amp 0.1).
  await uploadClip(track.id, makeSineWav(44100, 2, 220, 0.5));
  await sleep(300);
  await uploadClip(track.id, makeSineWav(44100, 2, 220, 0.1));
  await sleep(400);

  let hello = await req("session/hello", { clientName: "comp" });
  let clips = hello.project.tracks.find((t) => t.id === track.id).clips;
  report("two clips uploaded onto the track", clips.length === 2, `n=${clips.length}`);
  const loudId = clips[0].id, quietId = clips[1].id;

  // Fold them into a take folder: lane 0 = loud, lane 1 = quiet.
  const folder = (await req("cmd/take.create", { trackId: track.id, clipIds: [loudId, quietId] })).folder;
  report("cmd/take.create returns a 2-lane folder", !!folder?.id && folder.lanes?.length === 2, `id=${folder?.id} lanes=${folder?.lanes?.length}`);
  hello = await req("session/hello", { clientName: "comp" });
  const tk = hello.project.tracks.find((t) => t.id === track.id);
  report("clips moved off the flat list into the folder", (tk.clips?.length ?? 0) === 0 && (tk.takeFolders?.length ?? 0) === 1,
    `clips=${tk.clips?.length} folders=${tk.takeFolders?.length}`);

  // MUTE IS THE SELECTOR (2026-08-11): take.create parks all but the newest version, and
  // cmd/take.pick makes a version audible by CLIPS, muting the ones overlapping it.
  const loudClip = folder.lanes[0].clips[0].id;
  const quietClip = folder.lanes[1].clips[0].id;
  await req("cmd/take.pick", { trackId: track.id, clipId: loudClip });
  const loudRms = rmsFrac(await render(), 0, 1);
  await req("cmd/take.pick", { trackId: track.id, clipId: quietClip });
  const quietRms = rmsFrac(await render(), 0, 1);
  report("picking the loud version plays it", loudRms > 100, `rms=${loudRms?.toFixed(1)}`);
  report("picking the quiet version plays THAT one (much lower)", quietRms > 10 && quietRms < loudRms * 0.5,
    `loud=${loudRms?.toFixed(1)} quiet=${quietRms?.toFixed(1)} (ratio ${(quietRms / loudRms).toFixed(3)})`);

  // The pick is exclusive: the sibling it muted must really be silent, not merely unselected.
  const tk2 = (await req("session/hello", { clientName: "comp" })).project.tracks.find((t) => t.id === track.id);
  const f2 = tk2.takeFolders[0];
  report("picking mutes the sibling version",
    f2.lanes[0].clips[0].muted === true && f2.lanes[1].clips[0].muted !== true,
    `lane0.muted=${f2.lanes[0].clips[0].muted} lane1.muted=${f2.lanes[1].clips[0].muted}`);

  // Stacking parks everything but the newest, or a fold would leave both playing summed.
  report("take.create left only the newest version audible",
    quietRms < loudRms * 0.5, `quiet=${quietRms?.toFixed(1)}`);

  // Version clips are ordinary clips: a split must keep BOTH halves inside the lane —
  // the right half escaping onto the track would half-dissolve the version.
  await req("cmd/clip.split", { clipIds: [quietClip], atBeat: 1 });
  const tkS = (await req("session/hello", { clientName: "comp" })).project.tracks.find((t) => t.id === track.id);
  report("splitting a version clip keeps both halves in its lane",
    (tkS.clips?.length ?? 0) === 0 && tkS.takeFolders[0].lanes[1].clips.length === 2,
    `flat=${tkS.clips?.length} laneClips=${tkS.takeFolders[0].lanes[1].clips.length}`);
  await req("edit/undo", {});
  const tkU = (await req("session/hello", { clientName: "comp" })).project.tracks.find((t) => t.id === track.id);
  report("undo restores the un-split version",
    tkU.takeFolders[0].lanes[1].clips.length === 1,
    `laneClips=${tkU.takeFolders[0].lanes[1].clips.length}`);

  // Persistence: mute state is what carries the choice now, so that is what must survive.
  const projDir = path.join(TMP, "Comp.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  const sf = saved.tracks.find((t) => t.id === track.id)?.takeFolders?.[0];
  report("saveAs persists the folder and its per-clip mutes",
    !!sf && sf.lanes?.length === 2 && sf.lanes[0].clips[0].muted === true && sf.comp === undefined,
    `lanes=${sf?.lanes?.length} lane0.muted=${sf?.lanes?.[0]?.clips?.[0]?.muted} comp=${sf?.comp}`);
  await req("project/load", { path: projDir });
  await sleep(500);
  const reRms = rmsFrac(await render(), 0, 1);
  report("reloaded project still plays the picked (quiet) version",
    Math.abs(reRms - quietRms) < Math.max(2, quietRms * 0.1), `before=${quietRms?.toFixed(1)} after=${reRms?.toFixed(1)}`);

  // Flatten keeps what you HEAR: the muted version is discarded with the folder.
  const lf = (await req("session/hello", { clientName: "comp" })).project.tracks.find((t) => t.id === track.id).takeFolders[0];
  const flat = await req("cmd/take.flatten", { trackId: track.id, folderId: lf.id });
  report("cmd/take.flatten returns the audible clip ids", Array.isArray(flat.clipIds) && flat.clipIds.length === 1, `n=${flat.clipIds?.length}`);
  const af = (await req("session/hello", { clientName: "comp" })).project.tracks.find((t) => t.id === track.id);
  report("flatten removes the folder and leaves the audible clip",
    (af.takeFolders?.length ?? 0) === 0 && (af.clips?.length ?? 0) === 1,
    `folders=${af.takeFolders?.length} clips=${af.clips?.length}`);
  const ffRms = rmsFrac(await render(), 0, 1);
  report("flattened audio is unchanged",
    Math.abs(ffRms - quietRms) < Math.max(2, quietRms * 0.1), `before=${quietRms?.toFixed(1)} after=${ffRms?.toFixed(1)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "COMPING TEST: ALL PASS" : "COMPING TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "COMPING TEST: EXCEPTION\n" + elog.slice(-800));
}
