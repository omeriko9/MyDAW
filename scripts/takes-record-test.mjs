#!/usr/bin/env node
/**
 * Record take modes test (SPEC §8.7): Keep History vs Replace.
 *
 *   node scripts/takes-record-test.mjs [--port 8585]
 *
 * Keep History: recording over existing material mutes the overlapped clips WHOLE and
 * lands each lap on its own fresh take lane, newest in front. Replace: only the final
 * lap survives on lane 0 and existing material in the range is deleted or trimmed.
 * The mode is a TRANSPORT setting (transport/setRecordMode) that App forwards inside
 * the internal/recording.commit payload — it must never leak into project.json, and it
 * must be completely independent of any lanes VIEW state.
 *
 * WHY THE ASSERTIONS CAN BE EXACT: audio passes are gated by a punch window, and
 * `--null-input` synthesizes a position-recoverable ramp — a punch window of a known
 * length produces EXACTLY that many frames (see punch-test.mjs). MIDI passes lean on
 * the recorder rounding the final lap end up to a whole bar, which pins the Replace
 * trim boundary to an exact beat.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8585"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-takes-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

const engine = spawn(
  path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT), "--null-input", "2"],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: TMP } },
);
engine.stderr.on("data", () => {});
const cleanup = () => {
  try { spawnSync("taskkill", ["/F", "/PID", String(engine.pid)], { stdio: "ignore" }); } catch { /* gone */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* log may linger */ }
};
const die = (code, msg) => { console.log(msg); cleanup(); setTimeout(() => process.exit(code), 400); };

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(400); }
}
if (!up) die(2, "engine failed to boot");

let nextId = 1;
const pending = new Map();
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
sock.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.replyTo == null) return;
  const p = pending.get(j.replyTo);
  if (!p) return;
  pending.delete(j.replyTo);
  p(j.ok ? { ok: true, payload: j.payload ?? {} } : { ok: false, error: j.error ?? {} });
};
const req = (type, payload = {}, ms = 30000) => {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type, payload }));
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(type + ": timeout")); }, ms);
  });
};
const noteOn = (pitch, vel = 100) => req("midi/feedEvent", { status: 0x90, data1: pitch, data2: vel });
const noteOff = (pitch) => req("midi/feedEvent", { status: 0x80, data1: pitch, data2: 0 });

const trackClips = async (trackId) =>
  ((await req("session/hello", {})).payload.project.tracks.find((t) => t.id === trackId).clips) ?? [];
const brief = (cs) => JSON.stringify(cs.map((c) => ({
  id: c.id, start: c.startBeat, lane: c.lane ?? 0, muted: !!c.muted, name: c.name,
})));

async function recordPass(ms, locateBeat = 0) {
  await req("transport/locate", { beat: locateBeat });
  await req("transport/record", {});
  await sleep(ms);
  await req("transport/stop", {});
  await sleep(900);
}

try {
  await req("session/hello", { clientName: "takes" });
  const SR = (await req("engine/getStatus")).payload.sampleRate;
  const framesPerBeat = SR / 2; // 120 bpm default

  /* ---- the mode is a transport setting with keepHistory as default -------------- */
  const tp0 = (await req("transport/pause")).payload;
  report("the default record take mode is keepHistory",
    tp0.recordTakeMode === "keepHistory", JSON.stringify(tp0.recordTakeMode));
  const bad = await req("transport/setRecordMode", { mode: "banana" });
  report("an unknown mode is refused", !bad.ok && bad.error?.code === "bad_request",
    JSON.stringify(bad.error ?? bad));
  const setR = await req("transport/setRecordMode", { mode: "replace" });
  report("setRecordMode echoes the new mode in the transport reply",
    setR.ok && setR.payload.recordTakeMode === "replace", JSON.stringify(setR.payload.recordTakeMode));
  await req("transport/setRecordMode", { mode: "keepHistory" });

  const PROJECT = path.join(TMP, "T.mydaw");
  await req("project/new", {});
  const track = (await req("cmd/track.add", { kind: "audio", name: "Cap" })).payload.track;
  await req("project/saveAs", { path: PROJECT });
  await req("cmd/track.set", { trackId: track.id, patch: { recordArm: true } });
  await sleep(400);

  /* ---- keepHistory on empty ground is mode-invisible ---------------------------- */
  await req("cmd/punch.set", { startBeat: 0, endBeat: 4, enabled: true });
  await recordPass(3200);
  let clips = await trackClips(track.id);
  report("first recording on empty ground lands as one plain clip",
    clips.length === 1 && (clips[0].lane ?? 0) === 0 && !clips[0].muted &&
      Math.abs(clips[0].startBeat) < 1e-9 && clips[0].lengthSamples === 4 * framesPerBeat,
    brief(clips));
  if (clips.length !== 1) die(1, "no base clip");
  const clipA = clips[0].id;

  /* ---- keepHistory over existing material: mute whole, stack on a new lane ------ */
  await req("cmd/punch.set", { startBeat: 1, endBeat: 2, enabled: true });
  await recordPass(2200);
  clips = await trackClips(track.id);
  const a2 = clips.find((c) => c.id === clipA);
  const take2 = clips.find((c) => c.id !== clipA);
  report("the overlapped clip is muted WHOLE, never split",
    clips.length === 2 && !!a2 && a2.muted === true &&
      Math.abs(a2.startBeat) < 1e-9 && a2.lengthSamples === 4 * framesPerBeat,
    brief(clips));
  report("the new take lands unmuted on the next free lane",
    !!take2 && (take2.lane ?? 0) === 1 && !take2.muted && take2.name === "Take 2" &&
      Math.abs(take2.startBeat - 1) < 1e-9 && take2.lengthSamples === 1 * framesPerBeat,
    brief(clips));

  /* ---- comp tool seam: cmd/take.front swaps which take is audible --------------- */
  const f1 = await req("cmd/take.front", { clipId: clipA });
  clips = await trackClips(track.id);
  report("take.front unmutes the clicked take and mutes what it overlaps",
    f1.ok && !clips.find((c) => c.id === clipA)?.muted && // muted omitted when false
      clips.find((c) => c.id === take2?.id)?.muted === true, brief(clips));
  await req("cmd/take.front", { clipId: take2.id });
  clips = await trackClips(track.id);
  report("…and one click on the other take swaps it back",
    clips.find((c) => c.id === clipA)?.muted === true &&
      !clips.find((c) => c.id === take2?.id)?.muted, brief(clips));
  const f3 = await req("cmd/take.front", { clipId: take2.id });
  report("take.front on the already-front take is a no-op (no undo entry)",
    f3.ok === true, JSON.stringify(f3.error ?? "ok"));

  /* ---- comp drag seam: cmd/take.comp splits at the bounds and chooses a lane ----
   * clipA [0,4) lane 0 muted, Take 2 [1,2) lane 1 unmuted. Comp lane 0 over
   * [1.25, 1.75): both takes split at both bounds; inside the window lane 0 sounds,
   * outside stays exactly as it was. Split positions are sample-rounded, hence 1e-4. */
  const cp = await req("cmd/take.comp",
    { trackId: track.id, lane: 0, startBeat: 1.25, endBeat: 1.75 });
  clips = await trackClips(track.id);
  const near = (a, b) => Math.abs(a - b) < 1e-4;
  const at = (b) => clips.filter((c) => near(c.startBeat, b));
  report("take.comp splits every take at both range bounds",
    cp.ok && clips.length === 6 && at(1.25).length === 2 && at(1.75).length === 2,
    brief(clips));
  const audibleC = clips.filter((c) => !c.muted);
  report("inside the range ONLY the chosen lane sounds; outside is untouched",
    audibleC.length === 3 &&
      audibleC.some((c) => (c.lane ?? 0) === 0 && near(c.startBeat, 1.25)) &&
      audibleC.some((c) => (c.lane ?? 0) === 1 && near(c.startBeat, 1)) &&
      audibleC.some((c) => (c.lane ?? 0) === 1 && near(c.startBeat, 1.75)),
    brief(clips));
  await req("edit/undo", {});
  clips = await trackClips(track.id);
  report("a single undo reassembles the comped takes and their mutes",
    clips.length === 2 && clips.find((c) => c.id === clipA)?.muted === true &&
      !clips.find((c) => c.id === take2?.id)?.muted, brief(clips));

  /* ---- lane row menu: cmd/take.lane front / delete ------------------------------
   * State here: clipA [0,4) lane 0 (muted), Take 2 [1,2) lane 1 (audible). */
  const lf = await req("cmd/take.lane", { trackId: track.id, lane: 0, action: "front" });
  clips = await trackClips(track.id);
  report("take.lane front makes the whole lane active where it has material",
    lf.ok && !clips.find((c) => c.id === clipA)?.muted &&
      clips.find((c) => c.id === take2?.id)?.muted === true, brief(clips));
  const badLane = await req("cmd/take.lane", { trackId: track.id, lane: 9, action: "front" });
  report("fronting an empty lane is refused, not a silent no-op",
    !badLane.ok && badLane.error?.code === "bad_request", JSON.stringify(badLane.error ?? badLane));
  const badAct = await req("cmd/take.lane", { trackId: track.id, lane: 0, action: "banana" });
  report("an unknown lane action is refused",
    !badAct.ok && badAct.error?.code === "bad_request", JSON.stringify(badAct.error ?? badAct));

  // Delete lane 0: Take 2 (lane 1) must shift DOWN to lane 0 and, having lost the clip
  // that was covering it, become audible again (the heal).
  const ld = await req("cmd/take.lane", { trackId: track.id, lane: 0, action: "delete" });
  clips = await trackClips(track.id);
  report("take.lane delete removes the lane, shifts higher lanes down and heals audibility",
    ld.ok && clips.length === 1 && clips[0].id === take2.id &&
      (clips[0].lane ?? 0) === 0 && !clips[0].muted, brief(clips));
  await req("edit/undo", {});
  clips = await trackClips(track.id);
  report("one undo restores the deleted lane, its lane number and the mutes",
    clips.length === 2 && (clips.find((c) => c.id === take2.id)?.lane ?? 0) === 1 &&
      clips.find((c) => c.id === take2.id)?.muted === true, brief(clips));
  // Deleting a lane's clips the ORDINARY way (select them, press Delete) must settle the
  // stack exactly like the lane menu did: gap closed, covered takes audible again.
  const delA = await req("cmd/clip.delete", { clipIds: [clipA] });
  clips = await trackClips(track.id);
  report("deleting a lane's last take closes the gap and re-exposes what it covered",
    delA.ok && clips.length === 1 && (clips[0].lane ?? 0) === 0 && !clips[0].muted,
    brief(clips));
  await req("edit/undo", {});
  clips = await trackClips(track.id);
  report("…and one undo puts the lane, its number and the mutes back",
    clips.length === 2 && (clips.find((c) => c.id === take2.id)?.lane ?? 0) === 1,
    brief(clips));

  // Back to "clipA muted, Take 2 audible" for the cycle section below.
  await req("cmd/take.front", { clipId: take2.id });

  /* ---- keepHistory cycle: laps stack above the existing lanes, newest in front -- */
  await req("cmd/punch.set", { startBeat: 0, endBeat: 0, enabled: false });
  await req("cmd/loop.set", { startBeat: 0, endBeat: 2, enabled: true });
  await recordPass(2700); // ~2.5 laps of 1 s
  clips = await trackClips(track.id);
  const laps = clips.filter((c) => c.id !== clipA && c.id !== (take2?.id ?? -1));
  report("cycle laps land on consecutive fresh lanes above the stack",
    laps.length >= 2 && laps.every((c, ) => (c.lane ?? 0) >= 2) &&
      new Set(laps.map((c) => c.lane ?? 0)).size === laps.length,
    brief(clips));
  const audible = clips.filter((c) => !c.muted);
  const newest = Math.max(...laps.map((c) => c.lane ?? 0));
  report("after the cycle, ONLY the newest lap is audible (older takes were muted)",
    audible.length === 1 && (audible[0].lane ?? 0) === newest, brief(clips));

  /* ---- one undo takes back the whole record pass, mutes included ----------------
   * loop.set/punch.set are themselves undoable project commands, so the undo must run
   * BEFORE the rig-restoring loop toggle — else it undoes the toggle, not the pass. */
  await req("edit/undo", {});
  clips = await trackClips(track.id);
  const t2b = clips.find((c) => c.id === take2?.id);
  report("a single undo removes the laps AND restores the older take's audibility",
    clips.length === 2 && !!t2b && !t2b.muted, brief(clips));
  await req("cmd/loop.set", { startBeat: 0, endBeat: 2, enabled: false });

  /* ---- Replace: exact-window overwrite trims the underlying clip ---------------- */
  await req("transport/setRecordMode", { mode: "replace" });
  await req("cmd/punch.set", { startBeat: 2, endBeat: 3, enabled: true });
  await recordPass(2700);
  clips = await trackClips(track.id);
  // clipA [0,4) gets its middle [2,3) cut out; Take 2 at [1,2) merely TOUCHES the
  // window and must be untouched (strict overlap).
  const head = clips.find((c) => c.id === clipA);
  const tail = clips.find((c) => Math.abs(c.startBeat - 3) < 1e-6 && c.id !== clipA);
  const fresh = clips.find((c) => Math.abs(c.startBeat - 2) < 1e-6);
  report("replace trims the overlapped clip's head to end at the punch-in",
    !!head && head.lengthSamples === 2 * framesPerBeat && head.muted === true,
    brief(clips));
  report("…and re-anchors its tail after the punch-out, reading the right source region",
    !!tail && tail.lengthSamples === 1 * framesPerBeat &&
      tail.srcOffsetSamples === head.srcOffsetSamples + 3 * framesPerBeat,
    brief(clips));
  report("the new material lands on lane 0, unmuted",
    !!fresh && (fresh.lane ?? 0) === 0 && !fresh.muted &&
      fresh.lengthSamples === 1 * framesPerBeat, brief(clips));
  const t2c = clips.find((c) => c.id === take2?.id);
  report("a clip that only TOUCHES the window edge is untouched",
    !!t2c && t2c.lengthSamples === 1 * framesPerBeat && !t2c.muted, brief(clips));
  report("nothing changed lanes: replace never stacks",
    clips.every((c) => (c.lane ?? 0) <= 1), brief(clips));

  await req("edit/undo", {}); // again BEFORE the punch restore (undoable, see above)
  clips = await trackClips(track.id);
  const aRestored = clips.find((c) => c.id === clipA);
  report("a single undo reassembles the trimmed clip",
    clips.length === 2 && !!aRestored && aRestored.lengthSamples === 4 * framesPerBeat,
    brief(clips));
  await req("cmd/punch.set", { startBeat: 0, endBeat: 0, enabled: false });

  /* ---- lanes and mutes persist with the project (project/load clears the undo
   *      stack, so this runs after every undo assertion) -------------------------- */
  await req("project/saveAs", { path: PROJECT });
  const savedJson = JSON.parse(readFileSync(path.join(PROJECT, "project.json"), "utf8"));
  report("the record take mode never leaks into project.json",
    savedJson.recordTakeMode === undefined && savedJson.takeMode === undefined, "");
  await req("project/load", { path: PROJECT });
  const reloaded = await trackClips(track.id);
  report("lanes and mutes survive a save/load round-trip",
    JSON.stringify(reloaded.map((c) => [c.lane ?? 0, !!c.muted]).sort()) ===
      JSON.stringify(clips.map((c) => [c.lane ?? 0, !!c.muted]).sort()),
    brief(reloaded));

  /* ---- Replace on MIDI: trim via the bar-rounded lap end ------------------------ */
  const mtrack = (await req("cmd/track.add", { kind: "midi", name: "Keys" })).payload.track;
  await req("cmd/clip.addMidi", {
    trackId: mtrack.id, startBeat: 0, lengthBeats: 8, name: "Bed",
    notes: [
      { pitch: 48, velocity: 100, startBeat: 0.5, lengthBeats: 0.5 },
      { pitch: 50, velocity: 100, startBeat: 6.5, lengthBeats: 0.5 },
    ],
  });
  await req("cmd/track.set", { trackId: track.id, patch: { recordArm: false } });
  await req("cmd/track.set", { trackId: mtrack.id, patch: { recordArm: true } });
  // Record from beat 1 for ~1.2 s (~beat 3.4); the recorder rounds the lap end up to
  // the bar, so the Replace window is EXACTLY [1, 4).
  await req("transport/locate", { beat: 1 });
  await req("transport/record", {});
  await sleep(500);
  await noteOn(72); await sleep(200); await noteOff(72);
  await sleep(500);
  await req("transport/stop", {});
  await sleep(900);
  const mclips = await trackClips(mtrack.id);
  const mHead = mclips.find((c) => Math.abs(c.startBeat) < 1e-9 && c.name === "Bed");
  const mTail = mclips.find((c) => Math.abs(c.startBeat - 4) < 1e-6);
  const mNew = mclips.find((c) => (c.notes ?? []).some((n) => n.pitch === 72));
  report("MIDI replace trims the bed's head at the record start",
    !!mHead && Math.abs(mHead.lengthBeats - 1) < 1e-6 &&
      (mHead.notes ?? []).length === 1 && mHead.notes[0].pitch === 48, brief(mclips));
  report("…keeps the bed's tail past the bar-rounded lap end, notes re-based",
    !!mTail && (mTail.notes ?? []).length === 1 && mTail.notes[0].pitch === 50 &&
      Math.abs(mTail.notes[0].startBeat - 2.5) < 1e-6, brief(mclips));
  report("the recorded MIDI lands as the only material in the window",
    !!mNew && !mNew.muted && (mNew.lane ?? 0) === 0 &&
      Math.abs(mNew.startBeat - 1) < 0.07, brief(mclips));
} catch (e) {
  report("harness completed", false, e?.stack ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
