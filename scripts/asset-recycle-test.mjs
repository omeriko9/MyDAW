#!/usr/bin/env node
/**
 * Recycled-asset-id test.
 *
 *   node scripts/asset-recycle-test.mjs [--port 8564]
 *
 * Asset ids are RECYCLED: undo restores Project::nextId, so the offline render after an
 * undone one is handed the id the undone render just freed. Every AssetStore cache —
 * decoded PCM, channel/frame counts, the peak file — is keyed by that id alone, so
 * without an invalidation step a fresh render inherits the UNDONE render's audio: the
 * project plays material the user already took back, and every further process compounds
 * it. AssetStore::invalidateIfRecycled compares a sourceKey (file|originalPath) and evicts
 * when an id turns up pointing at different material.
 *
 * The test earns its assertions rather than assuming the setup worked:
 *   - it asserts the second render really did receive the SAME id (no recycling, no bug,
 *     and a green run would mean nothing)
 *   - then that the audible result reflects the NEW material, not the old
 *   - and that the peak file served over HTTP for that id changed too, since peaks are a
 *     separate cache with the same key and were also wrong
 *
 * Runs against a throwaway engine with a redirected APPDATA — never a live session.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8564"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-recy-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

function makeSineWav(sr = 48000, secs = 2, freq = 440, amp = 0.5) {
  const n = sr * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * amp * 32767), 44 + i * 2);
  return buf;
}

const peakOf = (file) => {
  if (!existsSync(file)) return null;
  const w = readFileSync(file);
  if (w.toString("ascii", 0, 4) !== "RIFF") return null;
  let pk = 0;
  for (let i = 200; i + 1 < Math.min(w.length, 4000000); i += 2) pk = Math.max(pk, Math.abs(w.readInt16LE(i)));
  return pk;
};

const engine = spawn(
  path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: TMP } },
);
let elog = "";
engine.stderr.on("data", (d) => { elog = (elog + d).slice(-6000); });
const cleanup = () => {
  try { engine.kill(); } catch { /* gone */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
};
const die = (code, msg) => { console.log(msg); cleanup(); setTimeout(() => process.exit(code), 300); };

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(500); }
}
if (!up) die(2, "engine failed to boot:\n" + elog.slice(-800));

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
  j.ok ? p.res(j.payload ?? {}) : p.rej(new Error(`${p.t}: ${j.error?.code} ${j.error?.message}`));
};
const req = (t, payload = {}, ms = 120000) => {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type: t, payload }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej, t });
    setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms);
  });
};

let seq = 0;
const renderOut = async () => {
  const out = path.join(TMP, `r${seq++}.wav`);
  await req("export/render", { path: out, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 16 } });
  return peakOf(out);
};
const peaksBytes = async (assetId) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/peaks/${assetId}?lod=0`);
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
};

try {
  await req("session/hello", { clientName: "recy" });
  await req("project/new", {});
  const track = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;

  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav()], { type: "audio/wav" }), "sine.wav");
  await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${track.id}&atBeat=0&file0=sine.wav`,
    { method: "POST", body: fd });
  await sleep(600);

  let hello = await req("session/hello", {});
  const clip = (hello.project.tracks.find((t) => t.id === track.id).clips ?? [])[0];
  if (!clip) die(2, "upload produced no clip");

  const loud = await renderOut();
  report("baseline renders audible material", loud > 4000, `peak=${loud}`);

  // --- render 1: full-gain material -------------------------------------------------
  const r1 = await req("cmd/track.renderInPlace", { trackId: track.id, startBeat: 0, endBeat: 4 });
  const id1 = r1.assetId;
  await sleep(400);
  const peak1 = await renderOut();
  const peaks1 = await peaksBytes(id1);
  report("first offline render produces an asset", id1 > 0, `assetId=${id1}`);
  report("the first render is the loud material", peak1 > 4000, `peak=${peak1}`);

  // --- undo, then change the material and render again -------------------------------
  await req("edit/undo", {});
  await sleep(400);
  hello = await req("session/hello", {});
  const clipBack = (hello.project.tracks.find((t) => t.id === track.id).clips ?? [])[0];
  report("undo restored the pre-render clip", clipBack && clipBack.assetId !== id1,
    `clip.assetId=${clipBack?.assetId} (render was ${id1})`);

  // Quieten the clip so the SECOND render is unmistakably different material.
  await req("cmd/clip.set", { clipId: clipBack.id, patch: { gain: 0.05 } });
  await sleep(200);

  const r2 = await req("cmd/track.renderInPlace", { trackId: track.id, startBeat: 0, endBeat: 4 });
  const id2 = r2.assetId;
  await sleep(400);

  // THE PRECONDITION. If ids stopped recycling this test would pass vacuously forever.
  report("the freed asset id really was recycled", id2 === id1,
    id2 === id1 ? `both renders got id ${id1}` : `id1=${id1} id2=${id2} — ids no longer recycle, so this test no longer exercises the bug`);

  const peak2 = await renderOut();
  report(
    "the recycled id serves the NEW material, not the undone render's",
    peak2 < peak1 * 0.5,
    `peak1=${peak1} peak2=${peak2} (expected roughly ${Math.round(peak1 * 0.05)})`,
  );

  const peaks2 = await peaksBytes(id2);
  report(
    "the peak file for the recycled id was rebuilt too",
    peaks1 != null && peaks2 != null && !peaks1.equals(peaks2),
    peaks1 == null || peaks2 == null
      ? `peaks1=${peaks1 ? peaks1.length : "null"} peaks2=${peaks2 ? peaks2.length : "null"}`
      : `${peaks1.length} vs ${peaks2.length} bytes, identical=${peaks1.equals(peaks2)}`,
  );
} catch (e) {
  report("harness completed", false, e?.message ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
