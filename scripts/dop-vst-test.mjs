#!/usr/bin/env node
/**
 * VST-as-offline-DOP test (Swipe 7). Boots the engine, uploads a sine clip, then runs a
 * REAL out-of-process VST effect as a Direct-Offline-Processing chain entry:
 *   - cmd/clip.processChain addPlugin with a registry VST uid succeeds
 *   - the entry captures the plugin's state chunk INLINE (sparams.state, base64) + name
 *   - the chain stays length-preserving; the derived asset is new
 *   - the render audibly differs from dry; toggle-off restores the dry render
 *   - undo/redo round-trips the chain
 *   - addPlugin {copyFrom} seeds the entry state from a live insert
 *   - the chain (incl. inline state) survives saveAs/load, and a post-reload recompute
 *     replays the VST from the stored chunk (throwaway instance + setStateForRecreate)
 *   - clear restores the original material
 * Relies on the boot-time plugin registry (cached scan) — does NOT rescan or touch the
 * user's plugin folders. Skips (exit 0) when no usable VST effect is registered.
 * Usage: node scripts/dop-vst-test.mjs [--port 8547] [--plugin <name substring>]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8547"));
const WANT = argVal("--plugin", "").toLowerCase();
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-dopvst-"));
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

let nextId = 1; const pending = new Map(); const events = [];
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
sock.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.replyTo != null) { const p = pending.get(j.replyTo); if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`)); } }
  else events.push(j);
};
const req = (t, payload = {}, ms = 60000) => { const id = nextId++; sock.send(JSON.stringify({ id, type: t, payload })); return new Promise((res, rej) => { pending.set(id, { res, rej, t }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms); }); };
// Chain edits on VST-bearing chains reply immediately ({pending:true}) and commit via
// event/dopDone — wait for it (returns the payload; throws on timeout).
const awaitEvent = async (type, ms = 240000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = events.findIndex((e) => e.type === type);
    if (i >= 0) return events.splice(i, 1)[0].payload;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${type}`);
};
const chainCmd = async (payload) => {
  const reply = await req("cmd/clip.processChain", payload, 240000);
  if (!reply.pending) return { reply, done: { ok: true, sync: true } };
  const done = await awaitEvent("event/dopDone");
  if (!done.ok) throw new Error(`dop render failed: ${done.error}`);
  return { reply, done };
};

const samplesOf = (file) => {
  if (!existsSync(file)) return null;
  const w = readFileSync(file);
  if (w.toString("ascii", 0, 4) !== "RIFF") return null;
  const out = [];
  for (let i = 200; i + 1 < Math.min(w.length, 800000); i += 2) out.push(w.readInt16LE(i));
  return out;
};
const rms = (s) => { let a = 0; for (const v of s) a += v * v; return Math.sqrt(a / s.length); };
const maxDiff = (a, b) => { const n = Math.min(a.length, b.length); let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };
let renderSeq = 0;
const render = async () => {
  const out = path.join(TMP, `r${renderSeq++}.wav`);
  await req("export/render", { path: out, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } }, 180000);
  return samplesOf(out);
};
const getClip = async (clipId) => {
  const proj = (await req("session/hello", {})).project;
  for (const t of proj.tracks) for (const c of (t.clips ?? [])) if (c.id === clipId) return c;
  return null;
};

try {
  await req("session/hello", { clientName: "dopvst" });
  await req("project/new", {});

  // -- pick a real VST effect from the boot-time registry (no rescan) ---------------
  const reg = (await req("plugins/getRegistry", {})).registry ?? [];
  const fx = reg.filter((p) => p.format !== "builtin" && !p.isInstrument && !p.blacklisted);
  if (fx.length === 0) die(0, "SKIP: no VST effects in the cached plugin registry on this machine");
  const prefs = WANT ? [WANT] : ["maxxbass stereo", "abbey road saturator", "sslcomp stereo", "aphex"];
  const candidates = [
    ...prefs.flatMap((s) => fx.filter((p) => p.name.toLowerCase().includes(s))),
    ...fx.filter((p) => p.name.toLowerCase().includes("stereo")),
    ...fx,
  ].filter((p, i, a) => a.findIndex((q) => q.uid === p.uid) === i).slice(0, 4);
  console.log(`registry: ${fx.length} VST effects; candidates: ${candidates.map((p) => p.name).join(" | ")}`);

  const audioT = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "sine440.wav");
  const upl = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${audioT.id}&atBeat=0`, { method: "POST", body: fd });
  const upj = await upl.json().catch(() => ({}));
  const clipId = (upj.clips ?? upj.payload?.clips ?? [])[0]?.id ?? (await req("session/hello", {})).project.tracks.find((x) => x.id === audioT.id)?.clips?.[0]?.id;
  await sleep(500);
  const clip0 = await getClip(clipId);
  report("uploaded sine clip", !!clip0 && clip0.lengthSamples > 1000, `clipId=${clipId} len=${clip0?.lengthSamples}`);
  const dry = await render();
  report("dry render is audible", !!dry && rms(dry) > 100, `rms=${rms(dry ?? []).toFixed(1)}`);

  // -- 1. addPlugin with a registry VST uid (async: pending reply + dopDone commit) --
  let plug = null, addReply = null, busyProbe = null;
  for (const cand of candidates) {
    try {
      events.length = 0;
      const p = req("cmd/clip.processChain", { clipId, action: "addPlugin", uid: cand.uid }, 240000);
      // While the render is in flight every mutation must bounce off the busy guard.
      busyProbe = null;
      addReply = await p;
      if (addReply.pending) {
        try { await req("cmd/track.add", { kind: "audio", name: "busy probe" }, 30000); busyProbe = "accepted"; }
        catch (e) { busyProbe = String(e.message); }
        const done = await awaitEvent("event/dopDone");
        if (!done.ok) throw new Error(`dop render failed: ${done.error}`);
      }
      plug = cand;
      break;
    } catch (e) {
      console.log(`  (candidate ${cand.name} failed: ${String(e.message).slice(0, 120)} — trying next)`);
    }
  }
  if (!plug) die(1, "FAIL: no candidate VST could be applied offline\n" + elog.slice(-800));
  console.log(`using: ${plug.name} (uid=${plug.uid})`);
  report("addPlugin replies immediately (pending) and commits via event/dopDone", addReply.pending === true, `pending=${addReply.pending}`);
  report("busy guard rejects commands mid-render", busyProbe != null && busyProbe.includes("busy_processing"), `probe=${busyProbe}`);
  report("progress events emitted during the render", events.some((e) => e.type === "event/dopProgress"), `events=${events.filter((e) => e.type === "event/dopProgress").length}`);

  const clip1 = await getClip(clipId);
  const entry = (clip1.processes ?? [])[0];
  report("addPlugin appends a VST chain entry", !!entry && entry.op === "plugin" && entry.sparams?.uid === plug.uid, `chain=${(clip1.processes ?? []).length}`);
  report("entry captured inline state (base64) + name", (entry?.sparams?.state ?? "").length > 0 && /^[A-Za-z0-9+/=]+$/.test(entry?.sparams?.state ?? "x") && (entry?.sparams?.name ?? "").length > 0,
    `state=${(entry?.sparams?.state ?? "").length}b64chars name="${entry?.sparams?.name}"`);
  report("length-preserving contract holds", clip1.lengthSamples === clip0.lengthSamples && addReply.lengthSamples === clip0.lengthSamples, `len=${clip1.lengthSamples}`);
  report("derived asset replaces the clip material", clip1.assetId !== clip0.assetId && clip1.dopAssetId === clip0.assetId, `asset ${clip0.assetId} -> ${clip1.assetId}`);

  await sleep(500); // let the derived PCM load before rendering
  const fxRender = await render();
  const fxDiff = fxRender && dry ? maxDiff(fxRender, dry) : 0;
  report("VST audibly processes the clip", fxDiff > 50, `maxSampleDiff=${fxDiff} rms dry=${rms(dry).toFixed(1)} fx=${rms(fxRender ?? []).toFixed(1)}`);

  // -- 2. undo / redo ---------------------------------------------------------------
  await req("edit/undo", {});
  await sleep(400);
  const clipU = await getClip(clipId);
  report("undo removes the chain and restores the material", (clipU.processes ?? []).length === 0 && clipU.assetId === clip0.assetId, `asset=${clipU.assetId}`);
  const undoRender = await render();
  report("undo render matches dry", undoRender && maxDiff(undoRender, dry) < 8, `maxDiff=${undoRender ? maxDiff(undoRender, dry) : "?"}`);
  await req("edit/redo", {});
  await sleep(400);
  const clipR = await getClip(clipId);
  report("redo restores the chain incl. inline state", (clipR.processes ?? []).length === 1 && (clipR.processes[0].sparams?.state ?? "").length > 0 && clipR.assetId === clip1.assetId, "");

  // -- 3. toggle: disabled entry replays to the original ----------------------------
  const pid = clipR.processes[0].id;
  const tOff = await chainCmd({ clipId, action: "toggle", processId: pid });
  report("toggle-off (no enabled VST left) recomputes synchronously", tOff.done.sync === true, "");
  await sleep(500);
  const offRender = await render();
  report("toggle-off restores the dry signal", offRender && maxDiff(offRender, dry) < 8, `maxDiff=${offRender ? maxDiff(offRender, dry) : "?"}`);
  await chainCmd({ clipId, action: "toggle", processId: pid });
  await sleep(500);
  const onRender = await render();
  report("toggle-on re-applies the VST (replayed from stored state)", onRender && maxDiff(onRender, dry) > 50, `maxDiff=${onRender ? maxDiff(onRender, dry) : "?"}`);

  // -- 4. copyFrom: seed entry state from a live insert -----------------------------
  const t2 = (await req("cmd/track.add", { kind: "audio", name: "FX host" })).track;
  const inst = (await req("cmd/plugin.add", { trackId: t2.id, uid: plug.uid }, 240000)).instance;
  await chainCmd({ clipId, action: "addPlugin", copyFrom: inst.instanceId });
  const clipC = await getClip(clipId);
  const cfEntry = (clipC.processes ?? [])[1];
  report("addPlugin {copyFrom} inherits uid + captures live state", !!cfEntry && cfEntry.sparams?.uid === plug.uid && (cfEntry.sparams?.state ?? "").length > 0 && clipC.lengthSamples === clip0.lengthSamples, `chain=${(clipC.processes ?? []).length}`);
  await chainCmd({ clipId, action: "remove", processId: cfEntry.id });

  // -- 5. persistence: chain + inline state survive saveAs/load ---------------------
  const projDir = path.join(TMP, "DopVst.mydaw");
  await req("project/saveAs", { path: projDir });
  const saved = JSON.parse(readFileSync(path.join(projDir, "project.json"), "utf8"));
  const savedClip = saved.tracks.flatMap((t) => t.clips ?? []).find((c) => c.id === clipId);
  const savedEntry = (savedClip?.processes ?? [])[0];
  report("project.json carries the chain with inline state", !!savedEntry && (savedEntry.sparams?.state ?? "").length > 0 && savedClip.dopAssetId === clip0.assetId, `stateChars=${(savedEntry?.sparams?.state ?? "").length}`);

  await req("project/load", { path: projDir });
  await sleep(800); // PCM reload
  const clipL = await getClip(clipId);
  report("reloaded chain intact", (clipL?.processes ?? []).length === 1 && (clipL.processes[0].sparams?.state ?? "").length > 0, "");

  // A post-reload recompute must replay the VST from the STORED chunk (throwaway
  // instance + setStateForRecreate) — appending a builtin forces a full replay.
  await chainCmd({ clipId, action: "addPlugin", uid: "builtin:utility" });
  await sleep(500);
  const clipL2 = await getClip(clipId);
  report("post-reload recompute replays VST from stored state", (clipL2.processes ?? []).length === 2 && clipL2.lengthSamples === clip0.lengthSamples && clipL2.assetId !== clipL.assetId, "");
  const reRender = await render();
  report("post-reload render still processed", reRender && maxDiff(reRender, dry) > 50, `maxDiff=${reRender ? maxDiff(reRender, dry) : "?"}`);

  // -- 6. clear restores the original material --------------------------------------
  await req("cmd/clip.processChain", { clipId, action: "clear" });
  await sleep(400);
  const clipE = await getClip(clipId);
  report("clear drops the chain and restores the original asset", (clipE.processes ?? []).length === 0 && clipE.assetId === clip0.assetId && clipE.lengthSamples === clip0.lengthSamples, "");

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "DOP VST TEST: ALL PASS" : "DOP VST TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "DOP VST TEST: EXCEPTION\n" + elog.slice(-1200));
}
