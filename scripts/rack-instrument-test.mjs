#!/usr/bin/env node
/**
 * Rack-owned instruments (SPEC §5.9) — VSTi instances that belong to the PROJECT, not to
 * any track: the industry-standard third leg next to MIDI tracks (notes only, routed by
 * channel) and Instrument tracks (notes + own VST). Requested 2026-08-13 after the
 * "backing instrument track" workaround produced phantom rack rows and a
 * drag-a-VST-per-imported-track workflow.
 *
 * Proves, with the built-in synth (no third-party plugin needed):
 *   - cmd/rack.add creates a project-owned instance; the model gains NO track
 *   - a MIDI track routed at the rack id is AUDIBLE (the whole point)
 *   - two MIDI tracks share one rack instance
 *   - solo on a feeder keeps the rack audible; solo on an unrelated track silences it
 *   - rack.set renames / retargets audio; uid swap keeps the rack id (routings live)
 *   - save/load round-trips the rack and it still SOUNDS after reload
 *   - undo of rack.add tears the instance down; redo brings it back audible
 *   - rack.remove clears feeders' midiTarget (no dangling routings)
 * Usage: node scripts/rack-instrument-test.mjs [--port 8691]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8691"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-rack-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

const APPDATA_ISO = mkdtempSync(path.join(tmpdir(), "mydaw-iso-"));
const engine = spawn(path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: APPDATA_ISO } });
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
const project = async () => (await req("session/hello", { clientName: "rack" })).project;

try {
  await req("session/hello", { clientName: "rack" });
  await req("project/new", {});

  /* ---- create: a project-owned instance, zero new tracks ------------------------- */
  const tracksBefore = (await project()).tracks.length;
  const rk = (await req("cmd/rack.add", { uid: "builtin:synth" })).rack;
  report("rack.add returns the rack entry with a hosted plugin",
    rk && rk.id > 0 && rk.plugin?.uid === "builtin:synth", JSON.stringify(rk ?? null));
  let p = await project();
  report("the model gained a rack entry and NO track — nothing hidden",
    (p.rack ?? []).length === 1 && p.tracks.length === tracksBefore,
    `rack=${(p.rack ?? []).length} tracks=${p.tracks.length}`);

  const fx = await req("cmd/rack.add", { uid: "builtin:utility" }).then(() => null, (e) => e);
  report("an effect is refused — the rack hosts instruments",
    fx instanceof Error && /bad_request/.test(fx.message), String(fx?.message ?? fx));

  /* ---- route a MIDI track at the rack id and HEAR it ------------------------------ */
  const t1 = (await req("cmd/track.add", { kind: "midi", name: "CHA 1" })).track;
  await req("cmd/clip.addMidi", {
    trackId: t1.id, startBeat: 0, lengthBeats: 2, name: "line",
    notes: [{ pitch: 60, velocity: 110, startBeat: 0, lengthBeats: 1.5 }],
  });
  const silent = await render();
  report("unrouted MIDI track renders silence (nothing to sound through)",
    silent !== null && silent < 50, `peak=${silent}`);

  await req("cmd/track.set", { trackId: t1.id, patch: { midiTarget: rk.id } });
  const loud = await render();
  report("routing midiTarget at the RACK id makes it audible — the core capability",
    loud !== null && loud > 500, `peak=${loud}`);

  /* ---- a second feeder shares the same instance ----------------------------------- */
  const t2 = (await req("cmd/track.add", { kind: "midi", name: "CHA 2" })).track;
  await req("cmd/clip.addMidi", {
    trackId: t2.id, startBeat: 0, lengthBeats: 2, name: "line2",
    notes: [{ pitch: 67, velocity: 110, startBeat: 0.5, lengthBeats: 1.0 }],
  });
  await req("cmd/track.set", { trackId: t2.id, patch: { midiTarget: rk.id } });
  const both = await render();
  report("two MIDI tracks share one rack instance (fuller render)",
    both !== null && both >= loud, `peak=${both} (single was ${loud})`);

  /* ---- solo semantics ------------------------------------------------------------- */
  await req("cmd/track.set", { trackId: t1.id, patch: { solo: true } });
  const soloFeeder = await render();
  report("soloing a feeder keeps its rack instrument audible",
    soloFeeder !== null && soloFeeder > 500, `peak=${soloFeeder}`);
  await req("cmd/track.set", { trackId: t1.id, patch: { solo: false } });

  /* ---- shared MIDI SOURCES: solo must isolate ONE of them (Omer, 2026-08-13) -------
     Solo decides which AUDIO NODES run, but several MIDI sources share one instrument
     node — two feeders on a rack VSTi, or a host track's own parts plus a feeder. The
     shared node kept playing every part, so soloing one of N tracks on one VST changed
     nothing at all. Peaks alone cannot see this (equal velocities give equal peaks), so
     the parts are put in DISJOINT time windows and each window is rendered on its own. */
  const winRender = async (startBeat, endBeat) => {
    const out = path.join(TMP, `w${seq++}.wav`);
    await req("export/render", { path: out, startBeat, endBeat, format: { type: "wav", bitDepth: 16 } }, 120000);
    return peakOf(out);
  };
  const sA = (await req("cmd/track.add", { kind: "midi", name: "SrcA" })).track;
  const sB = (await req("cmd/track.add", { kind: "midi", name: "SrcB" })).track;
  for (const [trk, startBeat, pitch] of [[sA, 8, 60], [sB, 12, 72]]) {
    await req("cmd/track.set", { trackId: trk.id, patch: { midiTarget: rk.id } });
    await req("cmd/clip.addMidi", {
      trackId: trk.id, startBeat, lengthBeats: 2, name: `src${pitch}`,
      notes: [{ pitch, velocity: 110, startBeat: 0, lengthBeats: 1.8 }],
    });
  }
  const winA = [8, 10], winB = [12, 14];
  report("both shared sources sound with no solo",
    (await winRender(...winA)) > 500 && (await winRender(...winB)) > 500);
  await req("cmd/track.set", { trackId: sA.id, patch: { solo: true } });
  const aOnA = await winRender(...winA), aOnB = await winRender(...winB);
  report("soloing one feeder keeps ITS part audible", aOnA > 500, `peak=${aOnA}`);
  report("soloing one feeder SILENCES the other feeder on the same instance",
    aOnB < 50, `other feeder's window peak=${aOnB}`);
  await req("cmd/track.set", { trackId: sA.id, patch: { solo: false } });

  // Same law for a host instrument track that carries parts of its OWN plus a feeder —
  // exactly the shape in Omer's project (CHA 3 hosting PS01 with CHA 4 routed into it).
  const host = (await req("cmd/track.add", { kind: "instrument", name: "Host" })).track;
  await req("cmd/plugin.add", { trackId: host.id, uid: "builtin:synth" });
  await req("cmd/clip.addMidi", {
    trackId: host.id, startBeat: 16, lengthBeats: 2, name: "hostPart",
    notes: [{ pitch: 55, velocity: 110, startBeat: 0, lengthBeats: 1.8 }],
  });
  const hFeed = (await req("cmd/track.add", { kind: "midi", name: "HostFeeder" })).track;
  await req("cmd/track.set", { trackId: hFeed.id, patch: { midiTarget: host.id } });
  await req("cmd/clip.addMidi", {
    trackId: hFeed.id, startBeat: 20, lengthBeats: 2, name: "feederPart",
    notes: [{ pitch: 79, velocity: 110, startBeat: 0, lengthBeats: 1.8 }],
  });
  const winH = [16, 18], winF = [20, 22];
  await req("cmd/track.set", { trackId: host.id, patch: { solo: true } });
  const hOnH = await winRender(...winH), hOnF = await winRender(...winF);
  report("soloing the HOST keeps its own parts and drops the feeder into it",
    hOnH > 500 && hOnF < 50, `host=${hOnH} feeder=${hOnF}`);
  await req("cmd/track.set", { trackId: host.id, patch: { solo: false } });
  await req("cmd/track.set", { trackId: hFeed.id, patch: { solo: true } });
  const fOnH = await winRender(...winH), fOnF = await winRender(...winF);
  report("soloing the FEEDER keeps its part and drops the host's own parts",
    fOnF > 500 && fOnH < 50, `host=${fOnH} feeder=${fOnF}`);
  await req("cmd/track.set", { trackId: hFeed.id, patch: { solo: false } });
  for (const id of [hFeed.id, host.id, sA.id, sB.id]) await req("cmd/track.remove", { trackId: id });

  const aud = (await req("cmd/track.add", { kind: "audio", name: "Other" })).track;
  await req("cmd/track.set", { trackId: aud.id, patch: { solo: true } });
  const soloOther = await render();
  report("soloing an unrelated track silences the rack (normal solo law)",
    soloOther !== null && soloOther < 50, `peak=${soloOther}`);
  await req("cmd/track.set", { trackId: aud.id, patch: { solo: false } });

  /* ---- rack.set: rename, uid swap keeps the id (routings survive) ----------------- */
  await req("cmd/rack.set", { rackId: rk.id, patch: { name: "Lead Rack" } });
  p = await project();
  report("rack.set renames", p.rack[0].name === "Lead Rack", p.rack[0].name);
  await req("cmd/rack.set", { rackId: rk.id, patch: { uid: "builtin:polysynth" } });
  p = await project();
  const swapped = p.rack[0];
  report("uid swap replaces the instrument under the SAME rack id",
    swapped.id === rk.id && swapped.plugin.uid === "builtin:polysynth" &&
      swapped.plugin.instanceId !== rk.plugin.instanceId,
    `uid=${swapped.plugin.uid}`);
  const afterSwap = await render();
  report("…and the feeders play the new instrument without re-routing",
    afterSwap !== null && afterSwap > 500, `peak=${afterSwap}`);

  /* ---- persistence ---------------------------------------------------------------- */
  const PROJ = path.join(TMP, "R.mydaw");
  await req("project/saveAs", { path: PROJ });
  await req("project/load", { path: PROJ });
  p = await project();
  report("save/load round-trips the rack and the feeders' routing",
    (p.rack ?? []).length === 1 && p.rack[0].plugin.uid === "builtin:polysynth" &&
      p.tracks.find((t) => t.name === "CHA 1")?.midiTarget === p.rack[0].id,
    JSON.stringify({ rack: (p.rack ?? []).length }));
  const reloaded = await render();
  report("…and it still SOUNDS after the reload", reloaded !== null && reloaded > 500,
    `peak=${reloaded}`);

  /* ---- undo/redo reconciliation (project/load cleared the stack — fresh ops) ------ */
  const rk2 = (await req("cmd/rack.add", { uid: "builtin:synth" })).rack;
  p = await project();
  report("second rack instrument added", (p.rack ?? []).length === 2, `${(p.rack ?? []).length}`);
  await req("edit/undo", {});
  p = await project();
  report("undo removes it from the model", (p.rack ?? []).length === 1, `${(p.rack ?? []).length}`);
  await req("edit/redo", {});
  p = await project();
  report("redo restores it", (p.rack ?? []).length === 2 && p.rack[1].id === rk2.id,
    `${(p.rack ?? []).length}`);

  /* ---- remove clears feeders ------------------------------------------------------ */
  await req("cmd/rack.remove", { rackId: rk2.id });
  await req("cmd/rack.remove", { rackId: rk.id });
  p = await project();
  const t1After = p.tracks.find((t) => t.name === "CHA 1");
  report("rack.remove clears every feeder's midiTarget — no dangling routings",
    (p.rack ?? []).length === 0 && (t1After?.midiTarget ?? 0) === 0,
    `midiTarget=${t1After?.midiTarget}`);
} catch (e) {
  report("harness completed", false, e?.stack ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
try { engine.kill(); } catch { /* gone */ }
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
