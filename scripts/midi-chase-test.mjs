#!/usr/bin/env node
/**
 * MIDI note chase (SPEC §7 "Tracks render"): starting playback INSIDE a held note must
 * sound it.
 *
 *   node scripts/midi-chase-test.mjs [--port 8577]
 *
 * The bug this pins (2026-08-02, found on a user project): TrackNode's in-block
 * scheduler binary-searches for events at `sample >= playhead`, so a note-on that
 * already happened was never sent. An 8-bar riser — one held note — was dead silent
 * from every play position after its start, and from every loop wrap, for its entire
 * length. The engine chased CC state on those same discontinuities but not notes.
 *
 * Observable: the instrument track's output meter (null driver, stock PolySynth on a
 * sustained patch). Covered here:
 *   - play from inside a held note      → sounds (the fix)
 *   - play from before it               → sounds (never regressed)
 *   - a note that ENDED before the position is NOT re-triggered (chase ≠ replay)
 *   - a loop whose start sits inside the note keeps sounding across the wrap
 *   - stop after a chased note leaves nothing stuck (the ledger owns chased notes)
 */
import { spawnEngine, sleep } from "./lib/harness.mjs";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8577"));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

/** Loudest meter value seen for `id` across the collected event/meters rows. */
const maxPeak = (events, id) => {
  let m = 0;
  for (const e of events) {
    if (e.type !== "event/meters") continue;
    const row = e.payload?.tracks?.[String(id)];
    if (row) m = Math.max(m, row[0], row[1]);
  }
  return m;
};

const e = await spawnEngine({ port: PORT });
try {
  await e.req("session/hello", { clientName: "midichase" });
  await e.req("project/new", {});

  // 120 bpm default: 1 beat = 0.5 s, so a 16-beat note spans 8 s of transport.
  const held = (await e.req("cmd/track.add", { kind: "instrument", name: "Held" })).payload.track;
  await e.req("cmd/plugin.add", { trackId: held.id, uid: "builtin:polysynth" });
  const heldClip = (await e.req("cmd/clip.addMidi", {
    trackId: held.id, startBeat: 0, lengthBeats: 16,
  })).payload.clip;
  await e.req("cmd/notes.edit", {
    clipId: heldClip.id,
    add: [{ pitch: 48, velocity: 100, startBeat: 0, lengthBeats: 16 }],
  });

  // Control track: its note is long over, so nothing may re-trigger it mid-timeline.
  const early = (await e.req("cmd/track.add", { kind: "instrument", name: "Early" })).payload.track;
  await e.req("cmd/plugin.add", { trackId: early.id, uid: "builtin:polysynth" });
  const earlyClip = (await e.req("cmd/clip.addMidi", {
    trackId: early.id, startBeat: 0, lengthBeats: 1,
  })).payload.clip;
  await e.req("cmd/notes.edit", {
    clipId: earlyClip.id,
    add: [{ pitch: 60, velocity: 100, startBeat: 0, lengthBeats: 1 }],
  });

  /** Play `seconds` from `beat` and return both tracks' peaks. */
  const playFrom = async (beat, seconds = 1.6) => {
    await e.req("transport/locate", { beat });
    await sleep(120);
    e.events.length = 0;
    await e.req("transport/play", {});
    await sleep(seconds * 1000);
    await e.req("transport/stop", {});
    const out = { held: maxPeak(e.events, held.id), early: maxPeak(e.events, early.id) };
    await sleep(250); // let the release tail die before the next measurement
    return out;
  };

  // ---- the regression: playback starting inside the held note --------------
  const mid = await playFrom(8);
  report("a note held across the play position SOUNDS (note chase)",
    mid.held > 0.01, `peak=${mid.held.toFixed(4)}`);
  report("a note that ended before the position is NOT re-triggered",
    mid.early < 1e-3, `peak=${mid.early.toFixed(5)}`);

  // ---- the case that always worked, kept honest ----------------------------
  const zero = await playFrom(0);
  report("playing from the note's own start still sounds",
    zero.held > 0.01, `peak=${zero.held.toFixed(4)}`);
  report("chasing does not change the level of an unchased note",
    Math.abs(zero.held - mid.held) < 0.25 * Math.max(zero.held, 1e-6),
    `from0=${zero.held.toFixed(4)} from8=${mid.held.toFixed(4)}`);

  // ---- loop wrap: every pass must re-sound the note ------------------------
  await e.req("cmd/loop.set", { startBeat: 8, endBeat: 10, enabled: true });
  await e.req("transport/locate", { beat: 8 });
  await sleep(120);
  await e.req("transport/play", {});
  await sleep(1400); // ~1.4 loops of a 1 s region: the first wrap has happened
  e.events.length = 0;
  await sleep(1400); // measure only AFTER the wrap
  await e.req("transport/stop", {});
  const wrapped = maxPeak(e.events, held.id);
  report("a loop whose start sits inside the note keeps sounding after the wrap",
    wrapped > 0.01, `peak=${wrapped.toFixed(4)}`);
  await e.req("cmd/loop.set", { enabled: false });

  // ---- hygiene: a chased note is owned by the ledger, so stop releases it ---
  await sleep(900); // past the polysynth's release tail
  e.events.length = 0;
  await sleep(700);
  report("stop leaves no chased note stuck", maxPeak(e.events, held.id) < 1e-3,
    `peak=${maxPeak(e.events, held.id).toFixed(5)}`);
} catch (err) {
  report("test ran to completion", false, String(err?.message ?? err));
} finally {
  e.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
