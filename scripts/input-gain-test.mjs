#!/usr/bin/env node
/**
 * Input gain + input metering test (SPEC §5.5).
 *
 *   node scripts/input-gain-test.mjs [--port 8573]
 *
 * The §5.5 contract under test: `Track.inputGainDb` is a PRE-INSERT stage — it scales
 * monitoring, metering and playback, while the recorded FILE stays RAW (the record tap
 * reads the raw driver buffers upstream of the graph). Every assertion here is chosen to
 * DISCRIMINATE that contract from the two ways it could silently break:
 *
 *   - If the gain were baked into the file, the recorded WAV's peak would be the post-gain
 *     level (0.1 at -20 dB) instead of the raw ramp's ~1.0.
 *   - If the gain missed the playback path, an offline render of the raw take would peak
 *     at ~1.0 instead of ~0.1.
 *
 * The -20 dB test value is deliberate: the `--null-input` sawtooth spans ±1 over exactly
 * one second, so any capture window >= 1 s has a deterministic max |x| of ~1.0 — making
 * post-gain meter peaks exact (0.1), not phase-dependent.
 *
 * Also covered: the input meter must NOT leak into the audio path (output meter stays
 * silent while the input meter reads signal — the liveAudioActive/PDC trap), the meter row
 * appears on arm (recordArm is structural now) and disappears on disarm (slot release),
 * a live gain change reaches the meter through the param ring without a rebuild, MIDI
 * tracks reject the field, and the value survives save/load and undo.
 */
import { spawnEngine, sleep } from "./lib/harness.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8573"));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

/** Minimal RIFF walk (same as record-capture-test). */
function readWav(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF") return null;
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "fmt ")
      fmt = { tag: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10),
              sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") return { fmt, off: off + 8, bytes: Math.min(sz, b.length - off - 8), buf: b };
    off += 8 + sz + (sz & 1);
  }
  return null;
}
const wavPeak = (w) => {
  let peak = 0;
  for (let i = 0; i + 3 < w.bytes; i += 4)
    peak = Math.max(peak, Math.abs(w.buf.readFloatLE(w.off + i)));
  return peak;
};

/** Max input-meter peak for `id` over the event/meters rows collected in `events`. */
function maxInputPeak(events, id) {
  let m = -1; // -1 = no row ever seen (distinct from "row of zeros")
  for (const e of events) {
    if (e.type !== "event/meters") continue;
    const row = e.payload?.inputs?.[String(id)];
    if (row) m = Math.max(m, row[0], row[1]);
  }
  return m;
}
function maxTrackPeak(events, id) {
  let m = 0;
  for (const e of events) {
    if (e.type !== "event/meters") continue;
    const row = e.payload?.tracks?.[String(id)];
    if (row) m = Math.max(m, row[0], row[1]);
  }
  return m;
}

const e = await spawnEngine({ port: PORT, args: ["--null-input", "2"] });
const PROJECT = path.join(e.appdata, "Gain.mydaw");

try {
  await e.req("session/hello", { clientName: "inputgain" });
  const SR = (await e.req("engine/getStatus")).payload.sampleRate;

  await e.req("project/new", {});
  const track = (await e.req("cmd/track.add", { kind: "audio", name: "Gain" })).payload.track;
  const midiTrack = (await e.req("cmd/track.add", { kind: "midi", name: "Keys" })).payload.track;
  await e.req("project/saveAs", { path: PROJECT });

  // -20 dB -> linear 0.1, set BEFORE arming so the baked path is exercised too.
  const set = await e.req("cmd/track.set", { trackId: track.id, patch: { inputGainDb: -20 } });
  report("inputGainDb is accepted on an audio track", set.ok, JSON.stringify(set.error ?? ""));

  const bad = await e.req("cmd/track.set", { trackId: midiTrack.id, patch: { inputGainDb: -6 } });
  report("inputGainDb on a MIDI track is refused", !bad.ok && bad.error?.code === "bad_request",
    JSON.stringify(bad.error ?? bad));

  // ---- input meter appears on arm, post-gain, without touching the audio path ----
  e.events.length = 0;
  await e.req("cmd/track.set", { trackId: track.id, patch: { recordArm: true } });
  await sleep(1600); // > one full sawtooth period => deterministic max |x| = 1.0 pre-gain

  const armedPeak = maxInputPeak(e.events, track.id);
  report("armed track has an input meter row", armedPeak >= 0, `maxPeak=${armedPeak}`);
  report("the input meter reads POST-gain (-20 dB of a ±1 ramp ≈ 0.1)",
    armedPeak > 0.085 && armedPeak < 0.115, `maxPeak=${armedPeak.toFixed(4)}`);
  const outPeak = maxTrackPeak(e.events, track.id);
  report("metering does not leak into the audio path (output meter silent, monitor off)",
    outPeak < 1e-3, `outputPeak=${outPeak}`);

  // ---- live gain change reaches the meter via the param ring (no rebuild) ----
  await e.req("cmd/track.set", { trackId: track.id, patch: { inputGainDb: 0 } });
  await sleep(150); // let the old accumulation drain
  e.events.length = 0;
  await sleep(1300);
  const unityPeak = maxInputPeak(e.events, track.id);
  report("a live gain change scales the meter without a rebuild (0 dB ≈ 1.0)",
    unityPeak > 0.9 && unityPeak < 1.1, `maxPeak=${unityPeak.toFixed(4)}`);
  await e.req("cmd/track.set", { trackId: track.id, patch: { inputGainDb: -20 } });

  // ---- disarm releases the slot: the row must disappear ----
  await e.req("cmd/track.set", { trackId: track.id, patch: { recordArm: false } });
  await sleep(300); // settle past the 66 ms drain cadence
  e.events.length = 0;
  await sleep(600);
  report("disarming removes the input meter row", maxInputPeak(e.events, track.id) === -1);

  // ---- record: the FILE stays raw ----
  await e.req("cmd/track.set", { trackId: track.id, patch: { recordArm: true } });
  await sleep(400);
  await e.req("transport/locate", { beat: 0 });
  await e.req("transport/record", {});
  await sleep(1300);
  await e.req("transport/stop", {});
  await sleep(900);

  const hello = await e.req("session/hello", {});
  const clips = hello.payload.project.tracks.find((t) => t.id === track.id)?.clips ?? [];
  report("recording committed a clip", clips.length === 1, `clips=${clips.length}`);

  const { existsSync, readdirSync } = await import("node:fs");
  const dir = path.join(PROJECT, "audio");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wav")) : [];
  report("a take file was written", files.length === 1, files.join(", ") || "none");

  let filePeak = 0;
  if (files.length === 1) {
    const w = readWav(path.join(dir, files[0]));
    filePeak = wavPeak(w);
    // THE raw-file assertion: at -20 dB a gain-baked file would peak at ~0.1.
    report("the recorded FILE is RAW (peak ≈ 1.0, not the post-gain 0.1)",
      filePeak > 0.9 && filePeak < 1.01, `filePeak=${filePeak.toFixed(4)}`);
  } else {
    report("the recorded FILE is RAW (peak ≈ 1.0, not the post-gain 0.1)", false, "no file");
  }

  // ---- playback: the gain IS applied pre-insert on render ----
  const lenBeats = 4; // comfortably covers the ~1.3 s clip at 120 bpm
  const out = path.join(e.appdata, "render.wav");
  const render = await e.req("export/render",
    { path: out, startBeat: 0, endBeat: lenBeats, format: { type: "wav", bitDepth: 32 } }, 60000);
  report("offline render succeeded", render.ok, JSON.stringify(render.error ?? ""));
  if (render.ok && filePeak > 0) {
    const rw = readWav(out);
    const renderPeak = wavPeak(rw);
    const ratio = renderPeak / filePeak;
    report("playback applies the -20 dB input gain (render/file ratio ≈ 0.1)",
      ratio > 0.095 && ratio < 0.105, `ratio=${ratio.toFixed(4)} (render=${renderPeak.toFixed(4)})`);
  } else {
    report("playback applies the -20 dB input gain (render/file ratio ≈ 0.1)", false,
      "render or file missing");
  }

  // ---- undo + persistence ----
  await e.req("cmd/track.set", { trackId: track.id, patch: { inputGainDb: 6 } });
  await e.req("edit/undo", {});
  let cur = (await e.req("session/hello", {})).payload.project.tracks
    .find((t) => t.id === track.id);
  report("undo restores the previous input gain", Math.abs((cur.inputGainDb ?? 0) - -20) < 1e-9,
    `inputGainDb=${cur.inputGainDb}`);

  await e.req("project/save", {});
  // project/new first so the reload PROVES persistence — asserting against the
  // still-loaded session would pass even if load dropped the field (or if the load
  // op name were wrong: an earlier version used nonexistent "project/open" and this
  // check could not fail).
  await e.req("project/new", {});
  const load = await e.req("project/load", { path: PROJECT });
  report("the saved project loads back", load.ok, JSON.stringify(load.error ?? ""));
  cur = (await e.req("session/hello", {})).payload.project.tracks
    .find((t) => t.name === "Gain");
  report("inputGainDb survives save/load", !!cur && Math.abs((cur.inputGainDb ?? 0) - -20) < 1e-9,
    `inputGainDb=${cur?.inputGainDb}`);
} catch (err) {
  report("harness completed", false, err?.stack ?? String(err));
}

console.log(`\n${passed} passed, ${failed} failed`);
e.close();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
