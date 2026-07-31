#!/usr/bin/env node
/**
 * Undoable media/import + tempo prompt plumbing (SPEC §5.5).
 *
 *   node scripts/media-import-test.mjs [--port 8575]
 *
 * Two contracts under test:
 *
 * 1. An import is ONE undo entry. Before this shipped, commitImport bypassed the
 *    command layer entirely: no snapshot was taken, so pressing undo after an import
 *    restored the PREVIOUS command's snapshot and silently deleted the imported
 *    material. The discriminating sequence here: import → one edit/undo must remove
 *    exactly the imported objects (and nothing else) → one edit/redo restores them.
 *
 * 2. media/probe + adoptTempo. The probe must report EXPLICIT tempo metas only —
 *    SmfReader synthesizes 120bpm/4-4 defaults when a file has none, so map size
 *    cannot distinguish "explicit tempo" from "no meta"; a meta-less file is the
 *    counter-case that keeps this check honest. adoptTempo folds the file's full maps
 *    into the SAME undo entry: one undo reverts tempo AND tracks together.
 */
import { spawnEngine } from "./lib/harness.mjs";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8575"));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

/** Minimal format-0 SMF, division 480. withTempo: explicit 95 BPM + 3/4 metas. */
function makeSmf(withTempo) {
  const ev = [];
  const push = (...b) => ev.push(...b);
  if (withTempo) {
    push(0x00, 0xff, 0x51, 0x03, 0x09, 0xa3, 0x1b); // 631579 us/qn ≈ 95 BPM
    push(0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08); // 3/4
  }
  push(0x00, 0x90, 0x3c, 0x64);       // C4 on
  push(0x83, 0x60, 0x80, 0x3c, 0x00); // delta 480 (VLQ 83 60), C4 off
  push(0x00, 0xff, 0x2f, 0x00);       // end of track
  const trk = Buffer.from(ev);
  const head = Buffer.alloc(14 + 8);
  head.write("MThd", 0); head.writeUInt32BE(6, 4);
  head.writeUInt16BE(0, 8); head.writeUInt16BE(1, 10); head.writeUInt16BE(480, 12);
  head.write("MTrk", 14); head.writeUInt32BE(trk.length, 18);
  return Buffer.concat([head, trk]);
}

function makeSineWav(sr = 44100, secs = 1, freq = 440) {
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

const e = await spawnEngine({ port: PORT });
const MID_TEMPO = path.join(e.appdata, "tempo95.mid");
const MID_PLAIN = path.join(e.appdata, "plain.mid");
const WAV = path.join(e.appdata, "tone.wav");
writeFileSync(MID_TEMPO, makeSmf(true));
writeFileSync(MID_PLAIN, makeSmf(false));
writeFileSync(WAV, makeSineWav());

const proj = async () => (await e.req("session/hello", {})).payload.project;

try {
  await e.req("session/hello", { clientName: "mediaimport" });
  await e.req("project/new", {});
  await e.req("cmd/track.add", { kind: "audio", name: "Keep" });

  // ---- media/probe ----
  const probe = (await e.req("media/probe", { paths: [MID_TEMPO, MID_PLAIN, WAV] })).payload;
  const [pT, pP, pW] = probe.files;
  report("probe classifies files", pT.kind === "midi" && pP.kind === "midi" && pW.kind === "audio",
    JSON.stringify(probe.files.map((f) => f.kind)));
  report("probe reports the EXPLICIT tempo metas (95 BPM, 3/4)",
    !!pT.tempo && Math.abs(pT.tempo.bpm - 95) < 0.01 && pT.tempo.timeSigNum === 3,
    JSON.stringify(pT.tempo));
  report("a meta-less .mid reports NO tempo (synthesized defaults don't count)",
    pP.tempo === undefined, JSON.stringify(pP.tempo ?? "absent"));

  // ---- plain import: no tempo adoption, one undo entry ----
  const imp1 = await e.req("media/import", { paths: [MID_TEMPO] });
  report("import succeeded", imp1.ok && imp1.payload.tracks.length === 1,
    JSON.stringify(imp1.error ?? imp1.payload.tracks?.length));
  let p = await proj();
  report("without adoptTempo the project tempo is untouched",
    Math.abs(p.tempoMap[0].bpm - 120) < 1e-9 && imp1.payload.adoptedTempo === false,
    `bpm=${p.tempoMap[0].bpm}`);
  const importedName = imp1.payload.tracks[0]?.name;

  await e.req("edit/undo", {});
  p = await proj();
  report("ONE undo removes the imported track (and only it)",
    !p.tracks.some((t) => t.id === imp1.payload.tracks[0].id) &&
      p.tracks.some((t) => t.name === "Keep"),
    `tracks=${JSON.stringify(p.tracks.map((t) => t.name))}`);
  await e.req("edit/redo", {});
  p = await proj();
  report("redo restores the imported track",
    p.tracks.some((t) => t.name === importedName), `tracks=${p.tracks.length}`);
  await e.req("edit/undo", {}); // back to just "Keep" for the next phase

  // ---- adoptTempo: maps + material in the SAME entry ----
  const imp2 = await e.req("media/import", { paths: [MID_TEMPO], adoptTempo: true });
  p = await proj();
  report("adoptTempo adopts the file's tempo map (95 BPM)",
    imp2.ok && imp2.payload.adoptedTempo === true && Math.abs(p.tempoMap[0].bpm - 95) < 0.01,
    `bpm=${p.tempoMap[0]?.bpm} adopted=${imp2.payload?.adoptedTempo}`);
  report("adoptTempo adopts the file's time signature (3/4)",
    p.timeSigMap[0]?.num === 3 && p.timeSigMap[0]?.den === 4,
    JSON.stringify(p.timeSigMap[0]));

  await e.req("edit/undo", {});
  p = await proj();
  report("ONE undo reverts tempo AND the imported track together",
    Math.abs(p.tempoMap[0].bpm - 120) < 1e-9 && p.tracks.length === 1 &&
      p.tracks[0].name === "Keep",
    `bpm=${p.tempoMap[0].bpm} tracks=${p.tracks.length}`);
  await e.req("edit/redo", {});
  p = await proj();
  report("redo re-adopts tempo and material together",
    Math.abs(p.tempoMap[0].bpm - 95) < 0.01 && p.tracks.length === 2,
    `bpm=${p.tempoMap[0].bpm} tracks=${p.tracks.length}`);

  // ---- a meta-less file with adoptTempo: nothing to adopt, import still lands ----
  const imp3 = await e.req("media/import", { paths: [MID_PLAIN], adoptTempo: true });
  report("adoptTempo on a meta-less file adopts nothing (no fake 120 overwrite)",
    imp3.ok && imp3.payload.adoptedTempo === false, JSON.stringify(imp3.payload?.adoptedTempo));
  await e.req("edit/undo", {});

  // ---- audio import: undoable, file survives undo ----
  const imp4 = await e.req("media/import", { paths: [WAV] });
  report("audio import creates an asset", imp4.ok && imp4.payload.assets.length === 1,
    JSON.stringify(imp4.error ?? imp4.payload.assets?.length));
  await e.req("edit/undo", {});
  p = await proj();
  report("undo removes the imported asset record",
    !p.assets.some((a) => a.id === imp4.payload.assets[0].id),
    `assets=${p.assets.length}`);
  report("undo never deletes the source file on disk", existsSync(WAV), WAV);

  // ---- upload transport: adoptTempo rides the query string ----
  await e.req("project/new", {});
  const fd = new FormData();
  fd.append("files", new Blob([makeSmf(true)], { type: "audio/midi" }), "tempo95.mid");
  const up = await fetch(`http://127.0.0.1:${PORT}/api/upload?adoptTempo=1`,
    { method: "POST", body: fd });
  const upBody = await up.json();
  p = await proj();
  report("upload with adoptTempo=1 adopts the file tempo too",
    up.ok && upBody.ok && Math.abs(p.tempoMap[0].bpm - 95) < 0.01,
    `bpm=${p.tempoMap[0]?.bpm}`);
  await e.req("edit/undo", {});
  p = await proj();
  report("the upload import is one undo entry as well",
    Math.abs(p.tempoMap[0].bpm - 120) < 1e-9 && p.tracks.length === 0,
    `bpm=${p.tempoMap[0].bpm} tracks=${p.tracks.length}`);
} catch (err) {
  report("harness completed", false, err?.stack ?? String(err));
}

console.log(`\n${passed} passed, ${failed} failed`);
e.close();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
