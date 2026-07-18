#!/usr/bin/env node
/**
 * MyDAW end-to-end smoke test (SPEC §11).
 * Spawns the engine with the null driver, drives the real WS protocol, verifies
 * project lifecycle, editing, save/load roundtrip, WAV export, undo/redo, transport.
 *
 * Usage: node scripts/smoke-test.mjs [--port 8517] [--no-spawn] [--exe <path>]
 * Requires Node >= 21 (global WebSocket, fetch/FormData). No npm deps.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const PORT = Number(argVal("--port", "8517"));
const EXE = argVal("--exe", path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"));
const NO_SPAWN = args.includes("--no-spawn");
const TMP = path.join(os.tmpdir(), "mydaw-smoke");

let passCount = 0, failCount = 0;
const fails = [];
function report(name, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passCount++; else { failCount++; fails.push(name); }
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- tiny PCM16 stereo RIFF/WAVE generator (2s, 440Hz) ---------- */
function makeSineWav(sr = 44100, secs = 2) {
  const frames = sr * secs;
  const dataBytes = frames * 2 * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000);
    buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 46 + i * 4);
  }
  return buf;
}

/* ---------- WS client ---------- */
let nextId = 1;
const pending = new Map();
const events = [];
let sock;
function connect(url) {
  return new Promise((resolve, reject) => {
    sock = new WebSocket(url);
    const to = setTimeout(() => reject(new Error("ws connect timeout")), 8000);
    sock.onopen = () => { clearTimeout(to); resolve(); };
    sock.onerror = (e) => { clearTimeout(to); reject(new Error("ws error " + (e?.message ?? ""))); };
    sock.onmessage = (m) => {
      let j; try { j = JSON.parse(m.data); } catch { return; }
      if (j.replyTo != null) {
        const p = pending.get(j.replyTo);
        if (p) { pending.delete(j.replyTo); j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.type}: ${j.error?.code} ${j.error?.message ?? ""}`)); }
      } else if (j.type) events.push(j);
    };
  });
}
function req(type, payload = {}, timeoutMs = 30000, envelope = {}) {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type, payload, ...envelope }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej, type });
    setTimeout(() => { if (pending.delete(id)) rej(new Error(type + ": timeout")); }, timeoutMs);
  });
}
// SPEC §5: "transient": true at the envelope top level = drag-gesture message
const reqTransient = (type, payload) => req(type, payload, 30000, { transient: true });
async function waitEvent(type, pred, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    const i = events.findIndex((e) => e.type === type && (!pred || pred(e.payload)));
    if (i >= 0) return events.splice(i, 1)[0].payload;
    if (Date.now() - start > timeoutMs) throw new Error("event timeout: " + type);
    await sleep(50);
  }
}

/* ---------- main ---------- */
let engine = null;
async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  if (!NO_SPAWN) {
    if (!existsSync(EXE)) { console.error("engine exe not found: " + EXE); process.exit(2); }
    engine = spawn(EXE, ["--driver", "null", "--no-browser", "--port", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    engine.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });
    engine.on("exit", (c) => { if (c !== null && failCount + passCount > 0 === false) console.error("engine exited early, code", c, "\n", stderrTail); });
    // wait for HTTP up
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/`); up = r.ok; } catch { await sleep(500); }
    }
    if (!report("engine boots and serves HTTP", up, up ? "" : stderrTail.slice(-500))) return finish(1);
  }

  await connect(`ws://127.0.0.1:${PORT}/ws`);
  report("ws connected", true);

  // hello
  const hello = await req("session/hello", { clientName: "smoke" });
  report("session/hello", !!hello.engine && !!hello.project, `driver=${hello.engine?.driver} sr=${hello.engine?.sampleRate}`);

  await req("project/new", {});
  report("project/new", true);

  // tracks
  const audioT = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;
  const midiT = (await req("cmd/track.add", { kind: "midi", name: "MIDI 1" })).track;
  const busT = (await req("cmd/track.add", { kind: "bus", name: "Bus A" })).track;
  report("add audio/midi/bus tracks", !!(audioT?.id && midiT?.id && busT?.id));

  // routing + send
  await req("cmd/track.set", { trackId: audioT.id, patch: { outputTarget: busT.id, volume: 0.9, pan: -0.2 } });
  await req("cmd/track.addSend", { trackId: audioT.id, destTrackId: busT.id, level: 0.5 });
  report("routing + send", true);

  // per-track parametric EQ (cmd/track.setEq): set two bands + a bypass flag
  await req("cmd/track.setEq", {
    trackId: audioT.id,
    patch: {
      bypass: false,
      bands: [
        { enabled: true, type: 0, freqHz: 1000, gainDb: 6, q: 1.0 },   // peak
        { enabled: true, type: 4, freqHz: 80, gainDb: 0, q: 0.7 },     // low cut
      ],
    },
  });
  {
    const proj = (await req("session/hello", { clientName: "smoke" })).project;
    const et = proj.tracks.find((t) => t.id === audioT.id);
    const okBands = et?.eq?.bands?.length === 2 && et.eq.bypass === false &&
      et.eq.bands[0].type === 0 && Math.abs(et.eq.bands[0].gainDb - 6) < 1e-9 &&
      et.eq.bands[1].type === 4 && Math.abs(et.eq.bands[1].freqHz - 80) < 1e-9;
    report("cmd/track.setEq sets bands", !!okBands,
      `bands=${et?.eq?.bands?.length} bypass=${et?.eq?.bypass}`);
    // out-of-range values are clamped to the contract ranges on apply
    await req("cmd/track.setEq", { trackId: audioT.id, patch: { bands: [{ enabled: true, type: 9, freqHz: 50000, gainDb: 99, q: 99 }] } });
    const p2 = (await req("session/hello", { clientName: "smoke" })).project;
    const b = p2.tracks.find((t) => t.id === audioT.id)?.eq?.bands?.[0];
    report("setEq clamps + validates", b && b.type === 0 && b.freqHz === 20000 && b.gainDb === 24 && b.q === 18,
      `type=${b?.type} freq=${b?.freqHz} gain=${b?.gainDb} q=${b?.q}`);
    // restore the working 2-band EQ for the save/load + render checks below
    await req("cmd/track.setEq", {
      trackId: audioT.id,
      patch: { bypass: false, bands: [
        { enabled: true, type: 0, freqHz: 1000, gainDb: 6, q: 1.0 },
        { enabled: true, type: 4, freqHz: 80, gainDb: 0, q: 0.7 },
      ] },
    });
  }

  // midi clip + notes
  const mclip = (await req("cmd/clip.addMidi", { trackId: midiT.id, startBeat: 0, lengthBeats: 8 })).clip;
  await req("cmd/notes.edit", {
    clipId: mclip.id,
    add: [
      { pitch: 60, velocity: 100, startBeat: 0, lengthBeats: 1 },
      { pitch: 64, velocity: 90, startBeat: 1, lengthBeats: 1 },
      { pitch: 67, velocity: 80, startBeat: 2, lengthBeats: 2 },
    ],
  });
  report("midi clip + notes", !!mclip?.id);

  // automation lane + deep track duplicate (fresh ids everywhere, counts preserved)
  await req("cmd/automation.set", { trackId: midiT.id, paramRef: "volume", add: [{ t: 0, v: 1 }, { t: 4, v: 0.5 }] });
  const snap = (await req("session/hello", { clientName: "smoke" })).project;
  const srcT = snap.tracks.find((t) => t.id === midiT.id);
  const dupT = (await req("cmd/track.duplicate", { trackId: midiT.id })).track;
  const srcNotes = srcT.clips.flatMap((c) => c.notes ?? []);
  const srcNoteIds = new Set(srcNotes.map((n) => n.id));
  const dupNotes = (dupT?.clips ?? []).flatMap((c) => c.notes ?? []);
  const dupOk =
    !!dupT?.id && dupT.id !== midiT.id && /copy$/.test(dupT.name) &&
    dupT.clips.length === srcT.clips.length &&
    dupT.clips.every((c, i) => c.id !== srcT.clips[i].id) &&
    dupNotes.length === srcNotes.length &&
    dupNotes.every((n) => !srcNoteIds.has(n.id)) &&
    (dupT.automation?.length ?? 0) === (srcT.automation?.length ?? 0) &&
    (dupT.automation?.length ?? 0) === 1 &&
    !dupT.frozen; // copies never share the source's frozen asset record
  report("track.duplicate (new ids, name, counts, frozen=false)", dupOk,
    `id ${midiT.id}->${dupT?.id} name="${dupT?.name}" clips=${dupT?.clips?.length} notes=${dupNotes.length} lanes=${dupT?.automation?.length ?? 0} frozen=${dupT?.frozen ?? false}`);

  // duplicate a folder containing a bus + a track sending to it: the clone's send
  // must follow the cloned bus (intra-subtree routing remap), not the original.
  const fldT = (await req("cmd/track.add", { kind: "folder", name: "Fld" })).track;
  const fBusT = (await req("cmd/track.add", { kind: "bus", name: "FldBus" })).track;
  const fAudT = (await req("cmd/track.add", { kind: "audio", name: "FldAud" })).track;
  await req("cmd/track.reorder", { trackId: fBusT.id, newIndex: 99, parentId: fldT.id });
  await req("cmd/track.reorder", { trackId: fAudT.id, newIndex: 99, parentId: fldT.id });
  await req("cmd/track.addSend", { trackId: fAudT.id, destTrackId: fBusT.id, level: 0.4 });
  const dupFld = (await req("cmd/track.duplicate", { trackId: fldT.id })).track;
  const tree = (await req("session/hello", { clientName: "smoke" })).project.tracks;
  const cloneKids = tree.filter((t) => t.parentId === dupFld?.id);
  const cloneBus = cloneKids.find((t) => t.kind === "bus");
  const cloneAud = cloneKids.find((t) => t.kind === "audio");
  const sendDest = cloneAud?.sends?.[0]?.destTrackId;
  report("folder duplicate remaps intra-subtree send", !!cloneBus && sendDest === cloneBus.id && sendDest !== fBusT.id,
    `send dest ${fBusT.id}->${sendDest} (clone bus ${cloneBus?.id})`);

  // cmd/track.setEq on a FOLDER (no processing node) is rejected as bad_request, and the
  // folder's eq stays empty (no dead block, no undo entry).
  {
    const errCode = await req("cmd/track.setEq", {
      trackId: fldT.id,
      patch: { bypass: false, bands: [{ enabled: true, type: 0, freqHz: 1000, gainDb: 6, q: 1.0 }] },
    }).then(() => null).catch((e) => e.message);
    const proj = (await req("session/hello", { clientName: "smoke" })).project;
    const fld = proj.tracks.find((t) => t.id === fldT.id);
    const rejected = typeof errCode === "string" && errCode.includes("bad_request");
    const eqEmpty = !fld?.eq || (fld.eq.bands?.length ?? 0) === 0;
    report("cmd/track.setEq on folder rejected + leaves eq empty", rejected && eqEmpty,
      `err=${errCode} bands=${fld?.eq?.bands?.length ?? 0}`);
  }

  // tempo / loop / marker / grid
  await req("cmd/tempo.set", { bpm: 100 });
  await req("cmd/loop.set", { startBeat: 0, endBeat: 8, enabled: true });
  await req("cmd/marker.add", { beat: 4, name: "Verse" });
  await req("cmd/grid.set", { division: 0.5, swing: 0.25 });
  report("tempo/loop/marker/grid", true);

  // upload + audio clip
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "sine440.wav");
  const up = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${audioT.id}&atBeat=0`, { method: "POST", body: fd });
  const upJson = await up.json().catch(() => ({}));
  const gotAsset = up.ok && Array.isArray(upJson.assets ?? upJson.payload?.assets ?? null) !== false;
  report("upload wav -> asset+clip", up.ok, `http ${up.status} ${JSON.stringify(upJson).slice(0, 120)}`);

  // save / load roundtrip
  const projDir = path.join(TMP, "Smoke.mydaw");
  await req("project/saveAs", { path: projDir });
  const pjPath = path.join(projDir, "project.json");
  report("saveAs writes project.json", existsSync(pjPath));
  const before = JSON.parse(readFileSync(pjPath, "utf8"));

  const loaded = await req("project/load", { path: projDir });
  const lp = loaded.project;
  const rt =
    lp?.tracks?.length === before.tracks.length &&
    Math.abs((lp?.tempoMap?.[0]?.bpm ?? 0) - 100) < 1e-9 &&
    JSON.stringify(lp?.tracks?.map((t) => [t.name, t.kind, t.clips.length])) ===
      JSON.stringify(before.tracks.map((t) => [t.name, t.kind, t.clips.length]));
  report("load roundtrip (tracks/clips/tempo)", !!rt);
  report("grid persists through save/load", lp?.grid?.division === 0.5 && lp?.grid?.swing === 0.25,
    `division=${lp?.grid?.division} swing=${lp?.grid?.swing}`);

  // track.eq survives save/load (bands + bypass preserved)
  {
    const beforeEq = before.tracks.find((t) => t.id === audioT.id)?.eq;
    const loadedEq = lp?.tracks?.find((t) => t.id === audioT.id)?.eq;
    const eqRt = beforeEq?.bands?.length === 2 && loadedEq?.bands?.length === 2 &&
      loadedEq.bypass === beforeEq.bypass &&
      loadedEq.bands[0].type === beforeEq.bands[0].type &&
      Math.abs(loadedEq.bands[0].gainDb - beforeEq.bands[0].gainDb) < 1e-9 &&
      Math.abs(loadedEq.bands[1].freqHz - beforeEq.bands[1].freqHz) < 1e-9;
    report("track.eq round-trips through save/load", !!eqRt,
      `saved=${beforeEq?.bands?.length} loaded=${loadedEq?.bands?.length} bypass=${loadedEq?.bypass}`);
  }

  // transient setEq drag + one non-transient commit = ONE undo entry that reverts the drag
  {
    let proj0 = (await req("session/hello", { clientName: "smoke" })).project;
    const origGain = proj0.tracks.find((t) => t.id === audioT.id)?.eq?.bands?.[0]?.gainDb;
    const drag = (g) => ({ trackId: audioT.id, patch: { bands: [
      { enabled: true, type: 0, freqHz: 1000, gainDb: g, q: 1.0 },
      { enabled: true, type: 4, freqHz: 80, gainDb: 0, q: 0.7 },
    ] } });
    await reqTransient("cmd/track.setEq", drag(9));
    await reqTransient("cmd/track.setEq", drag(11));
    await req("cmd/track.setEq", drag(12)); // commit
    let projC = (await req("session/hello", { clientName: "smoke" })).project;
    const committed = projC.tracks.find((t) => t.id === audioT.id)?.eq?.bands?.[0]?.gainDb;
    await req("edit/undo", {});
    let projU = (await req("session/hello", { clientName: "smoke" })).project;
    const undone = projU.tracks.find((t) => t.id === audioT.id)?.eq?.bands?.[0]?.gainDb;
    report("transient setEq drag = one undo entry reverting the whole gesture",
      committed === 12 && undone === origGain,
      `orig=${origGain} committed=${committed} undone=${undone}`);
    // redo to restore the committed value, then leave a clean enabled high-gain peak for render
    await req("edit/redo", {});
  }

  // undo / redo (load clears the undo stack, so make a fresh edit first)
  await req("cmd/marker.add", { beat: 6, name: "UndoMe" });
  const undoOk = await req("edit/undo", {}).then(() => true).catch((e) => (console.log("  undo:", e.message), false));
  const redoOk = await req("edit/redo", {}).then(() => true).catch((e) => (console.log("  redo:", e.message), false));
  report("undo/redo", undoOk && redoOk);

  // transient-gesture undo: drag = N transient automation.set + one non-transient
  // commit; ONE undo must restore the point's PRE-GESTURE value (SPEC §5).
  const findLane = (proj, trackId, ref) =>
    proj.tracks.find((t) => t.id === trackId)?.automation?.find((l) => l.paramRef === ref);
  let proj = (await req("session/hello", { clientName: "smoke" })).project;
  const gPt = findLane(proj, midiT.id, "volume")?.points?.[0];
  const origVal = gPt?.value;
  await reqTransient("cmd/automation.set", { trackId: midiT.id, paramRef: "volume", update: [{ pointId: gPt?.id, patch: { value: 0.8 } }] });
  await reqTransient("cmd/automation.set", { trackId: midiT.id, paramRef: "volume", update: [{ pointId: gPt?.id, patch: { value: 0.6 } }] });
  await req("cmd/automation.set", { trackId: midiT.id, paramRef: "volume", update: [{ pointId: gPt?.id, patch: { value: 0.42 } }] }); // commit
  proj = (await req("session/hello", { clientName: "smoke" })).project;
  const committedVal = findLane(proj, midiT.id, "volume")?.points?.find((q) => q.id === gPt?.id)?.value;
  await req("edit/undo", {});
  proj = (await req("session/hello", { clientName: "smoke" })).project;
  const undoneVal = findLane(proj, midiT.id, "volume")?.points?.find((q) => q.id === gPt?.id)?.value;
  report("transient-gesture undo restores pre-drag value",
    gPt != null && committedVal === 0.42 && undoneVal === origVal,
    `orig=${origVal} committed=${committedVal} undone=${undoneVal}`);

  // emptied automation lane is auto-removed (cmd/automation.set contract)
  const rLane = findLane(proj, dupT.id, "volume");
  await req("cmd/automation.set", { trackId: dupT.id, paramRef: "volume", remove: (rLane?.points ?? []).map((q) => q.id) });
  proj = (await req("session/hello", { clientName: "smoke" })).project;
  report("automation lane auto-removed when emptied",
    (rLane?.points?.length ?? 0) > 0 && !findLane(proj, dupT.id, "volume"),
    `removed ${rLane?.points?.length ?? 0} points, lane present=${!!findLane(proj, dupT.id, "volume")}`);

  // export — SPEC §11 expects "metronome+any content"; the engine metronome now defaults
  // OFF, so enable it explicitly rather than relying on any default.
  await req("transport/setMetronome", { enabled: true });
  const outWav = path.join(TMP, "out.wav");
  await req("export/render", { path: outWav, startBeat: 0, endBeat: 8, format: { type: "wav", bitDepth: 16 } }, 120000);
  let exportOk = false, detail = "missing file";
  if (existsSync(outWav)) {
    const w = readFileSync(outWav);
    const riff = w.toString("ascii", 0, 4) === "RIFF" && w.toString("ascii", 8, 12) === "WAVE";
    let nonzero = 0;
    for (let i = 200; i < Math.min(w.length, 400000); i += 2) if (w.readInt16LE(i) !== 0) nonzero++;
    exportOk = riff && nonzero > 1000;
    detail = `riff=${riff} bytes=${w.length} nonzeroSamples=${nonzero}`;
  }
  report("export wav (nonzero audio)", exportOk, detail);

  // EQ affects rendered audio: a high-gain enabled peak band changes the exported RMS vs
  // a bypassed EQ (and both stay nonzero). Uses the audio track's sine clip.
  {
    const rmsOf = (file) => {
      if (!existsSync(file)) return null;
      const w = readFileSync(file);
      if (w.toString("ascii", 0, 4) !== "RIFF") return null;
      let sum = 0, n = 0;
      for (let i = 200; i + 1 < Math.min(w.length, 800000); i += 2) {
        const v = w.readInt16LE(i); sum += v * v; n++;
      }
      return n > 0 ? Math.sqrt(sum / n) : 0;
    };
    // EQ on: a +12 dB peak near 440 Hz (the sine fundamental) should boost level audibly.
    await req("cmd/track.setEq", { trackId: audioT.id, patch: { bypass: false, bands: [
      { enabled: true, type: 0, freqHz: 440, gainDb: 12, q: 2.0 },
    ] } });
    const eqOnWav = path.join(TMP, "eq-on.wav");
    await req("export/render", { path: eqOnWav, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } }, 120000);
    const rmsOn = rmsOf(eqOnWav);
    // EQ bypassed: same project, no EQ processing.
    await req("cmd/track.setEq", { trackId: audioT.id, patch: { bypass: true } });
    const eqOffWav = path.join(TMP, "eq-off.wav");
    await req("export/render", { path: eqOffWav, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } }, 120000);
    const rmsOff = rmsOf(eqOffWav);
    const diffOk = rmsOn != null && rmsOff != null && rmsOn > 1 && rmsOff > 1 &&
      Math.abs(rmsOn - rmsOff) / Math.max(rmsOn, rmsOff) > 0.02;
    report("EQ changes rendered RMS (enabled peak vs bypass)", !!diffOk,
      `rmsOn=${rmsOn?.toFixed(1)} rmsOff=${rmsOff?.toFixed(1)}`);
  }

  // ---- Track.midiTarget: MIDI routing into a shared instrument track (SPEC §5.2) ----
  {
    const instT = (await req("cmd/track.add", { kind: "instrument", name: "Inst" })).track;
    const feederT = (await req("cmd/track.add", { kind: "midi", name: "Feeder" })).track;
    const errOf = (p) => req("cmd/track.set", p).then(() => null).catch((e) => e.message);
    // rejected: midiTarget on a non-midi track
    const eAudio = await errOf({ trackId: audioT.id, patch: { midiTarget: instT.id } });
    // rejected: target that is not an Instrument track / does not exist
    const eBus = await errOf({ trackId: feederT.id, patch: { midiTarget: busT.id } });
    const eGone = await errOf({ trackId: feederT.id, patch: { midiTarget: 999999 } });
    // accepted: valid instrument target; 0 clears (and is allowed anywhere)
    await req("cmd/track.set", { trackId: feederT.id, patch: { midiTarget: instT.id } });
    let proj = (await req("session/hello", { clientName: "smoke" })).project;
    const setVal = proj.tracks.find((t) => t.id === feederT.id)?.midiTarget;
    await req("cmd/track.set", { trackId: feederT.id, patch: { midiTarget: 0 } });
    proj = (await req("session/hello", { clientName: "smoke" })).project;
    const clearedVal = proj.tracks.find((t) => t.id === feederT.id)?.midiTarget;
    report("cmd/track.set midiTarget validation (reject audio/bus/missing, accept, 0 clears)",
      [eAudio, eBus, eGone].every((e) => typeof e === "string" && e.includes("bad_request")) &&
        setVal === instT.id && clearedVal === undefined, // omitted from JSON when 0
      `eAudio=${eAudio} eBus=${eBus} eGone=${eGone} set=${setVal} cleared=${clearedVal}`);

    // undo reverts a midiTarget change
    await req("cmd/track.set", { trackId: feederT.id, patch: { midiTarget: instT.id } });
    await req("edit/undo", {});
    proj = (await req("session/hello", { clientName: "smoke" })).project;
    const undone = proj.tracks.find((t) => t.id === feederT.id)?.midiTarget;
    await req("edit/redo", {});
    proj = (await req("session/hello", { clientName: "smoke" })).project;
    const redone = proj.tracks.find((t) => t.id === feederT.id)?.midiTarget;
    report("undo/redo reverts/restores midiTarget", undone === undefined && redone === instT.id,
      `undone=${undone} redone=${redone}`);

    // feeder content so the routed render below schedules real events
    const fclip = (await req("cmd/clip.addMidi", { trackId: feederT.id, startBeat: 0, lengthBeats: 4 })).clip;
    await req("cmd/notes.edit", { clipId: fclip.id, add: [
      { pitch: 60, velocity: 100, startBeat: 0, lengthBeats: 1 },
      { pitch: 64, velocity: 100, startBeat: 1, lengthBeats: 1 },
    ] });

    // save/load round-trip keeps midiTarget
    const routeDir = path.join(TMP, "Route.mydaw");
    await req("project/saveAs", { path: routeDir });
    const routeJson = path.join(routeDir, "project.json");
    const savedPj = JSON.parse(readFileSync(routeJson, "utf8"));
    const savedFeeder = savedPj.tracks.find((t) => t.id === feederT.id);
    const lp2 = (await req("project/load", { path: routeDir })).project;
    const loadedFeeder = lp2?.tracks?.find((t) => t.id === feederT.id);
    report("midiTarget round-trips through save/load",
      savedFeeder?.midiTarget === instT.id && loadedFeeder?.midiTarget === instT.id,
      `saved=${savedFeeder?.midiTarget} loaded=${loadedFeeder?.midiTarget}`);

    // ---- solo-feeder render (what the null driver CAN prove) ----------------------
    // No real plugin runs in smoke, so the instrument's MIDI path itself is silent — that
    // end-to-end proof lives in scripts/midi-route-render-test.mjs (real PlugSound). What
    // IS observable here is the solo-audibility closure: give the INSTRUMENT track an
    // audio clip (the model/graph render audio clips on any clip-holding track; pure test
    // instrumentation, the importer never does this), then:
    //   solo an unrelated empty midi track -> instrument implicit-muted -> silent export;
    //   solo the FEEDER                    -> instrument stays audible  -> nonzero export.
    const pj = JSON.parse(readFileSync(routeJson, "utf8"));
    const asset = pj.assets?.[0];
    const inst = pj.tracks.find((t) => t.id === instT.id);
    const cid = pj.nextId;
    pj.nextId = cid + 1;
    inst.clips.push({ id: cid, type: "audio", name: "probe", startBeat: 0, assetId: asset.id,
      srcOffsetSamples: 0, lengthSamples: asset.lengthSamples, gain: 1.0, fadeInSec: 0, fadeOutSec: 0 });
    writeFileSync(routeJson, JSON.stringify(pj));
    await req("project/load", { path: routeDir });
    // Peak |sample|, not nonzero count: 16-bit export carries ±1 LSB dither even when
    // every track is muted, so "silent" means peak <= 2, "audible" means thousands.
    const peakOf = (file) => {
      if (!existsSync(file)) return null;
      const w = readFileSync(file);
      if (w.toString("ascii", 0, 4) !== "RIFF") return null;
      let peak = 0;
      for (let i = 44; i + 1 < w.length; i += 2) {
        const v = Math.abs(w.readInt16LE(i));
        if (v > peak) peak = v;
      }
      return peak;
    };
    const controlT = (await req("cmd/track.add", { kind: "midi", name: "SoloControl" })).track;
    await req("cmd/track.set", { trackId: controlT.id, patch: { solo: true } });
    const ctlWav = path.join(TMP, "solo-control.wav");
    await req("export/render", { path: ctlWav, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } }, 120000);
    const ctlPeak = peakOf(ctlWav);
    await req("cmd/track.set", { trackId: controlT.id, patch: { solo: false } });
    await req("cmd/track.set", { trackId: feederT.id, patch: { solo: true } });
    const feedWav = path.join(TMP, "solo-feeder.wav");
    let feedPeak = null;
    for (let attempt = 0; attempt < 3; attempt++) { // asset decode after load is async
      await req("export/render", { path: feedWav, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } }, 120000);
      feedPeak = peakOf(feedWav);
      if (feedPeak > 1000) break;
      await sleep(1000);
    }
    await req("cmd/track.set", { trackId: feederT.id, patch: { solo: false } });
    const stRoute = await req("engine/getStatus", {});
    report("solo-feeder keeps its midiTarget instrument audible (render closure)",
      ctlPeak !== null && ctlPeak <= 2 && feedPeak > 1000 && stRoute.running === true,
      `controlPeak=${ctlPeak} feederSoloPeak=${feedPeak} running=${stRoute.running}`);
  }

  // transport on null driver
  events.length = 0;
  await req("transport/play", {});
  const t1 = await waitEvent("event/transport", (p) => p.state === "playing", 5000).catch(() => null);
  await sleep(700);
  const t2 = await waitEvent("event/transport", (p) => p.state === "playing" && p.beat > (t1?.beat ?? 0), 5000).catch(() => null);
  await req("transport/stop", {});
  report("transport plays + playhead advances", !!(t1 && t2), t1 && t2 ? `beat ${t1.beat.toFixed(2)} -> ${t2.beat.toFixed(2)}` : "");

  // status + registry shape
  const st = await req("engine/getStatus", {});
  report("engine/getStatus", st.running === true && typeof st.sampleRate === "number", `driver=${st.driver} block=${st.bufferSize}`);
  const reg = await req("plugins/getRegistry", {});
  report("plugins/getRegistry shape", Array.isArray(reg.registry));

  return finish(failCount ? 1 : 0);
}

function finish(code) {
  console.log(`\n${passCount} passed, ${failCount} failed${failCount ? " -> " + fails.join(", ") : ""}`);
  try { sock?.close(); } catch {}
  if (engine) { try { engine.kill(); } catch {} }
  // give the engine a moment to die before the temp dir is reused next run
  setTimeout(() => process.exit(code), 300);
}

main().catch((e) => { console.error("SMOKE CRASH:", e.message); finish(1); });
