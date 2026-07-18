#!/usr/bin/env node
/**
 * MyDAW waveform-peaks pipeline test (GET /api/peaks/<assetId>?lod=<n>, SPEC §5.5).
 *
 * Verifies the fallback-peaks-dir fix end to end:
 *   A. NEVER-SAVED session: upload a wav (media-import path) -> peaks must serve
 *      HTTP 200 with a valid MPK1 payload (this 404'd before: AssetStore::readPeaks
 *      bailed whenever no project dir was set, while media-import had already written
 *      the .pk under %APPDATA%/MyDAW/media/peaks).
 *   B. After project/saveAs the same asset serves from <projectDir>/peaks (regenerated
 *      from cached PCM on demand).
 *   C. cpr-style IN-PLACE asset (file == "", originalPath set) with a WRONG guessed
 *      channel count / length in the model: after decode the engine reconciles the
 *      asset record (channels/lengthSamples) + broadcasts projectChanged, and peaks
 *      serve a payload consistent with the reconciled record.
 *   D. Saving a project holding an in-place asset copies it into audio/ via
 *      originalPath (ProjectIO::copyExternalAssets previously marked it missing).
 *   E. undo taken during the decode window does NOT revert the asset reconcile:
 *      the undo snapshot embeds the guessed record, but handleUndoRedo re-imposes
 *      the decoded channels/lengthSamples, so peaks keep serving consistently.
 *   F. File > New leftovers: a fallback-dir .pk of the previous (never-saved) model
 *      is never served for a colliding asset id of the new model — 404 while the
 *      asset is undeclared, then the NEW asset's bytes once imported.
 *   Plus: peaks responses are revalidatable (Cache-Control: no-cache + ETag/304),
 *   never immutable — asset ids recycle per model.
 *
 * Usage: node scripts/peaks-test.mjs [--port 18511] [--no-spawn] [--exe <path>]
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
const PORT = Number(argVal("--port", "18511"));
const EXE = argVal("--exe", path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"));
const NO_SPAWN = args.includes("--no-spawn");
const TMP = path.join(os.tmpdir(), "mydaw-peaks-test");

let passCount = 0, failCount = 0;
const fails = [];
function report(name, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passCount++; else { failCount++; fails.push(name); }
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- tiny PCM16 RIFF/WAVE generator (sine) ---------- */
function makeSineWav(sr = 44100, secs = 2, channels = 2, freq = 440, amp = 12000) {
  const frames = Math.round(sr * secs);
  const blockAlign = channels * 2;
  const dataBytes = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * amp);
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, 44 + i * blockAlign + c * 2);
  }
  return buf;
}

/* ---------- fabricate a structurally-valid MPK1 file (zeroed buckets) ----------
 * Passes AssetStore's structural validation for the given channels/frames — used to
 * model a stale-but-plausible leftover .pk so project/load skips the synchronous
 * decode and the reconcile window stays open for the undo test (section E). */
function makeFakePk(channels, frames) {
  const lods = [256, 1024, 4096, 16384];
  let total = 8;
  const nbs = lods.map((spb) => Math.ceil(frames / spb));
  for (const nb of nbs) total += 8 + nb * channels * 2;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(PEAK_MAGIC, 0); buf.writeUInt32LE(lods.length, 4);
  let off = 8;
  for (let l = 0; l < lods.length; l++) {
    buf.writeUInt32LE(lods[l], off); buf.writeUInt32LE(nbs[l], off + 4);
    off += 8 + nbs[l] * channels * 2; // bucket bytes stay zero
  }
  return buf;
}

/* ---------- MPK1 parser (mirrors ui/src/lib/peaks.ts, the normative format) ---------- */
const PEAK_MAGIC = 0x314b504d; // 'MPK1' LE
function parsePeaks(buf, channels) {
  const dv = new DataView(buf);
  if (buf.byteLength < 8) throw new Error("file too small");
  if (dv.getUint32(0, true) !== PEAK_MAGIC) throw new Error("bad magic");
  const numLods = dv.getUint32(4, true);
  let off = 8;
  const lods = [];
  let nonzero = false;
  for (let i = 0; i < numLods; i++) {
    if (off + 8 > buf.byteLength) throw new Error(`truncated lod header (lod ${i})`);
    const spb = dv.getUint32(off, true);
    const nb = dv.getUint32(off + 4, true);
    off += 8;
    const byteLen = nb * channels * 2;
    if (off + byteLen > buf.byteLength) throw new Error(`truncated lod data (lod ${i})`);
    const data = new Int8Array(buf, off, byteLen);
    for (let k = 0; k < data.length && !nonzero; k++) if (data[k] !== 0) nonzero = true;
    lods.push({ spb, nb });
    off += byteLen;
  }
  if (off !== buf.byteLength) throw new Error(`trailing bytes (${buf.byteLength - off})`);
  return { lods, nonzero };
}

async function getPeaks(assetId, lod, attempts = 1, delayMs = 300) {
  let res = null;
  for (let i = 0; i < attempts; i++) {
    res = await fetch(`http://127.0.0.1:${PORT}/api/peaks/${assetId}?lod=${lod}`);
    if (res.ok) return { status: res.status, buf: await res.arrayBuffer() };
    await sleep(delayMs);
  }
  return { status: res?.status ?? 0, buf: null };
}

/* ---------- WS client (same pattern as scripts/smoke-test.mjs) ---------- */
let nextId = 1;
const pending = new Map();
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
      }
    };
  });
}
function req(type, payload = {}, timeoutMs = 30000) {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type, payload }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej, type });
    setTimeout(() => { if (pending.delete(id)) rej(new Error(type + ": timeout")); }, timeoutMs);
  });
}
const helloProject = async () => (await req("session/hello", { clientName: "peaks-test" })).project;

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
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/`); up = r.status > 0; } catch { await sleep(500); }
    }
    if (!report("engine boots and serves HTTP", up, up ? "" : stderrTail.slice(-500))) return finish(1);
  }

  await connect(`ws://127.0.0.1:${PORT}/ws`);
  report("ws connected", true);

  /* ---- A. never-saved session: upload -> peaks must serve ------------------- */
  await req("project/new", {});
  const audioT = (await req("cmd/track.add", { kind: "audio", name: "Audio 1" })).track;
  const fd = new FormData();
  fd.append("files", new Blob([makeSineWav(44100, 2, 2)], { type: "audio/wav" }), "peaks-sine.wav");
  const up = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${audioT.id}&atBeat=0`, { method: "POST", body: fd });
  const upJson = await up.json().catch(() => ({}));
  const asset = (upJson.payload?.assets ?? upJson.assets ?? [])[0];
  if (!report("upload wav into never-saved session", up.ok && !!asset?.id,
      `http ${up.status} asset=${JSON.stringify(asset ?? null)?.slice(0, 140)}`)) return finish(1);

  {
    const { status, buf } = await getPeaks(asset.id, 0, 5);
    let ok = false, detail = `http ${status}`;
    if (buf) {
      try {
        const { lods, nonzero } = parsePeaks(buf, asset.channels);
        const expect = Math.ceil(asset.lengthSamples / 256);
        ok = lods.length === 1 && lods[0].spb === 256 && lods[0].nb === expect && nonzero;
        detail += ` lods=${lods.length} spb=${lods[0]?.spb} nb=${lods[0]?.nb} (expect ${expect}) nonzero=${nonzero}`;
      } catch (e) { detail += " parse: " + e.message; }
    }
    report("never-saved session serves valid MPK1 (lod 0)", ok, detail);
  }
  {
    const { status, buf } = await getPeaks(asset.id, 2, 3);
    let ok = false, detail = `http ${status}`;
    if (buf) {
      try {
        const { lods } = parsePeaks(buf, asset.channels);
        const expect = Math.ceil(asset.lengthSamples / 4096);
        ok = lods.length === 1 && lods[0].spb === 4096 && lods[0].nb === expect;
        detail += ` spb=${lods[0]?.spb} nb=${lods[0]?.nb} (expect ${expect})`;
      } catch (e) { detail += " parse: " + e.message; }
    }
    report("never-saved session serves valid MPK1 (lod 2)", ok, detail);
  }
  {
    // Peaks must be revalidatable, never immutable (asset ids recycle per model):
    // Cache-Control: no-cache + content ETag, 304 on a matching If-None-Match.
    const url = `http://127.0.0.1:${PORT}/api/peaks/${asset.id}?lod=0`;
    const r1 = await fetch(url);
    const cc = r1.headers.get("cache-control") ?? "";
    const tag = r1.headers.get("etag") ?? "";
    await r1.arrayBuffer();
    let s304 = 0;
    if (tag) {
      const r2 = await fetch(url, { headers: { "If-None-Match": tag } });
      s304 = r2.status;
      await r2.arrayBuffer().catch(() => {});
    }
    report("peaks respond no-cache + ETag, 304 on If-None-Match",
      r1.status === 200 && cc.includes("no-cache") && !cc.includes("immutable") &&
      !!tag && s304 === 304,
      `cache-control="${cc}" etag="${tag}" revalidate=${s304}`);
  }

  /* ---- B. save -> peaks serve from <projectDir>/peaks ----------------------- */
  const baseDir = path.join(TMP, "PeaksBase.mydaw");
  await req("project/saveAs", { path: baseDir });
  {
    const { status, buf } = await getPeaks(asset.id, 1, 5);
    let ok = false, detail = `http ${status}`;
    if (buf) {
      try {
        const { lods, nonzero } = parsePeaks(buf, asset.channels);
        ok = lods.length === 1 && lods[0].spb === 1024 && nonzero;
        detail += ` spb=${lods[0]?.spb} nb=${lods[0]?.nb}`;
      } catch (e) { detail += " parse: " + e.message; }
    }
    const pkOnDisk = existsSync(path.join(baseDir, "peaks", `${asset.id}.pk`));
    report("after saveAs peaks serve from the project dir", ok && pkOnDisk,
      `${detail} pkFile=${pkOnDisk}`);
  }

  /* ---- C. cpr-style in-place asset + wrong guessed channels/length ---------- */
  // Build a doctored copy of the saved project: the asset becomes an IN-PLACE
  // reference (file="", originalPath -> a MONO wav) with the cpr-style guesses a
  // foreign import carries (channels=2, bogus lengthSamples). The engine must decode,
  // reconcile the record, broadcast projectChanged, and only then serve peaks.
  const monoPath = path.join(TMP, "mono-440.wav");
  writeFileSync(monoPath, makeSineWav(44100, 1.5, 1));
  const basePj = JSON.parse(readFileSync(path.join(baseDir, "project.json"), "utf8"));
  const doctoredDir = path.join(TMP, "PeaksDoctored.mydaw");
  mkdirSync(doctoredDir, { recursive: true });
  {
    const pj = JSON.parse(JSON.stringify(basePj));
    const a = pj.assets[0];
    a.file = "";
    a.originalPath = monoPath;
    a.channels = 2;        // wrong (cpr guesses stereo)
    a.lengthSamples = 12345; // wrong
    writeFileSync(path.join(doctoredDir, "project.json"), JSON.stringify(pj));
  }
  await req("project/load", { path: doctoredDir });
  let rec = null;
  for (let i = 0; i < 40 && !rec; i++) { // reconcile is posted after the async decode
    const pr = await helloProject();
    const a = pr.assets?.find((x) => x.id === asset.id);
    if (a && a.channels === 1) rec = a;
    else await sleep(250);
  }
  report("asset record reconciled after decode (channels 2->1, length fixed)",
    !!rec && rec.lengthSamples > 0 && rec.lengthSamples !== 12345,
    rec ? `channels=${rec.channels} lengthSamples=${rec.lengthSamples}` : "timed out waiting for reconcile");
  if (rec) {
    const { status, buf } = await getPeaks(asset.id, 0, 10);
    let ok = false, detail = `http ${status}`;
    if (buf) {
      try {
        const { lods, nonzero } = parsePeaks(buf, rec.channels);
        const expect = Math.ceil(rec.lengthSamples / 256);
        ok = lods.length === 1 && lods[0].spb === 256 && lods[0].nb === expect && nonzero;
        detail += ` nb=${lods[0]?.nb} (expect ${expect}) nonzero=${nonzero}`;
      } catch (e) { detail += " parse: " + e.message; }
    }
    report("in-place (cpr-style) asset serves peaks consistent with reconciled record", ok, detail);
  } else {
    report("in-place (cpr-style) asset serves peaks consistent with reconciled record", false, "skipped (no reconcile)");
  }

  /* ---- D. saving an in-place asset copies it via originalPath --------------- */
  const resavedDir = path.join(TMP, "PeaksResaved.mydaw");
  await req("project/saveAs", { path: resavedDir });
  {
    const pj = JSON.parse(readFileSync(path.join(resavedDir, "project.json"), "utf8"));
    const a = pj.assets?.find((x) => x.id === asset.id);
    const copied = a && typeof a.file === "string" && a.file.startsWith("audio/") &&
      existsSync(path.join(resavedDir, a.file)) && a.missing !== true;
    report("saveAs copies in-place asset via originalPath (not marked missing)", !!copied,
      a ? `file="${a.file}" missing=${a.missing ?? false}` : "asset not in project.json");
    const { status, buf } = await getPeaks(asset.id, 0, 5);
    let ok = false, detail = `http ${status}`;
    if (buf) {
      try {
        const { lods } = parsePeaks(buf, a?.channels ?? 1);
        ok = lods.length === 1 && lods[0].spb === 256;
        detail += ` nb=${lods[0]?.nb}`;
      } catch (e) { detail += " parse: " + e.message; }
    }
    report("peaks still serve after re-save", ok, detail);
  }

  /* ---- E. undo during the decode window must not revert the reconcile -------- */
  // Doctored in-place project again, but with (a) a LONG mono source so the async
  // decode takes a while and (b) a fabricated .pk matching the GUESSED record so
  // project/load's synchronous ensurePeaks skips decoding — the reconcile then only
  // lands after the worker decode, leaving a window for an edit whose undo snapshot
  // embeds the stale guesses (channels=2, lengthSamples=12345).
  const monoLongPath = path.join(TMP, "mono-long.wav");
  writeFileSync(monoLongPath, makeSineWav(44100, 60, 1, 330, 9000));
  const doctored2Dir = path.join(TMP, "PeaksDoctored2.mydaw");
  mkdirSync(path.join(doctored2Dir, "peaks"), { recursive: true });
  {
    const pj = JSON.parse(JSON.stringify(basePj));
    const a = pj.assets[0];
    a.file = "";
    a.originalPath = monoLongPath;
    a.channels = 2;          // wrong guess
    a.lengthSamples = 12345; // wrong guess
    writeFileSync(path.join(doctored2Dir, "project.json"), JSON.stringify(pj));
    writeFileSync(path.join(doctored2Dir, "peaks", `${asset.id}.pk`), makeFakePk(2, 12345));
  }
  // Fire load + edit back-to-back: the engine processes them in order, so the edit's
  // undo snapshot is taken inside the decode window (before the posted reconcile).
  const loadP = req("project/load", { path: doctored2Dir });
  const editP = req("cmd/track.add", { kind: "midi", name: "Edit During Decode" });
  await loadP;
  await editP;
  let rec2 = null;
  for (let i = 0; i < 60 && !rec2; i++) {
    const pr = await helloProject();
    const a = pr.assets?.find((x) => x.id === asset.id);
    if (a && a.channels === 1 && a.lengthSamples !== 12345 && a.lengthSamples > 0) rec2 = a;
    else await sleep(250);
  }
  report("undo-test setup: reconcile lands with an edit in the undo stack", !!rec2,
    rec2 ? `channels=${rec2.channels} lengthSamples=${rec2.lengthSamples}`
         : "timed out waiting for reconcile");
  if (rec2) {
    await req("edit/undo", {});
    const pr = await helloProject();
    const a = pr.assets?.find((x) => x.id === asset.id);
    report("undo does NOT revert the asset reconcile (channels/length stay decoded)",
      !!a && a.channels === 1 && a.lengthSamples === rec2.lengthSamples,
      a ? `channels=${a.channels} lengthSamples=${a.lengthSamples}` : "asset gone");
    const { status, buf } = await getPeaks(asset.id, 0, 5);
    let ok = false, detail = `http ${status}`;
    if (buf && a) {
      try {
        const { lods, nonzero } = parsePeaks(buf, a.channels);
        const expect = Math.ceil(a.lengthSamples / 256);
        ok = lods.length === 1 && lods[0].spb === 256 && lods[0].nb === expect && nonzero;
        detail += ` nb=${lods[0]?.nb} (expect ${expect}) nonzero=${nonzero}`;
      } catch (e) { detail += " parse: " + e.message; }
    }
    report("peaks serve consistently with the model record after undo", ok, detail);
  } else {
    report("undo does NOT revert the asset reconcile (channels/length stay decoded)", false, "skipped");
    report("peaks serve consistently with the model record after undo", false, "skipped");
  }

  /* ---- F. File > New: leftover fallback .pk is never served ------------------ */
  // Two never-saved sessions in one run share the fallback peaks dir while asset ids
  // restart per model: after File > New the old <id>.pk must answer 404 (undeclared
  // asset — existence is never trusted), and once a NEW asset with the colliding id
  // is imported its peaks must be the NEW bytes.
  await req("project/new", {});
  const tA = (await req("cmd/track.add", { kind: "audio", name: "Collide A" })).track;
  const fdA = new FormData();
  fdA.append("files", new Blob([makeSineWav(44100, 2, 2, 440, 12000)], { type: "audio/wav" }), "collide-a.wav");
  const upA = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${tA.id}&atBeat=0`, { method: "POST", body: fdA });
  const upAJson = await upA.json().catch(() => ({}));
  const assetA = (upAJson.payload?.assets ?? upAJson.assets ?? [])[0];
  if (!report("upload wav A into fresh never-saved session", upA.ok && !!assetA?.id,
      `http ${upA.status} id=${assetA?.id}`)) return finish(1);
  const peaksA = await getPeaks(assetA.id, 0, 5);
  report("session A serves its peaks", peaksA.status === 200 && !!peaksA.buf, `http ${peaksA.status}`);

  await req("project/new", {});
  {
    const { status } = await getPeaks(assetA.id, 0, 1);
    report("after File > New the leftover .pk answers 404 (asset undeclared)",
      status === 404, `http ${status}`);
  }
  const tB = (await req("cmd/track.add", { kind: "audio", name: "Collide B" })).track;
  const fdB = new FormData();
  fdB.append("files", new Blob([makeSineWav(44100, 1, 2, 440, 4000)], { type: "audio/wav" }), "collide-b.wav");
  const upB = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${tB.id}&atBeat=0`, { method: "POST", body: fdB });
  const upBJson = await upB.json().catch(() => ({}));
  const assetB = (upBJson.payload?.assets ?? upBJson.assets ?? [])[0];
  report("upload wav B after File > New recycles the asset id", !!assetB?.id && assetB.id === assetA.id,
    `idA=${assetA.id} idB=${assetB?.id}`);
  if (assetB?.id) {
    const peaksB = await getPeaks(assetB.id, 0, 5);
    let ok = false, detail = `http ${peaksB.status}`;
    if (peaksB.buf) {
      try {
        const { lods, nonzero } = parsePeaks(peaksB.buf, assetB.channels);
        const expect = Math.ceil(assetB.lengthSamples / 256);
        const differs = !peaksA.buf ||
          Buffer.compare(Buffer.from(peaksB.buf), Buffer.from(peaksA.buf)) !== 0;
        ok = lods.length === 1 && lods[0].spb === 256 && lods[0].nb === expect &&
             nonzero && differs;
        detail += ` nb=${lods[0]?.nb} (expect ${expect}) differsFromA=${differs}`;
      } catch (e) { detail += " parse: " + e.message; }
    }
    report("colliding id serves the NEW asset's bytes, not the previous session's", ok, detail);
  }

  return finish(failCount ? 1 : 0);
}

function finish(code) {
  console.log(`\n${passCount} passed, ${failCount} failed${failCount ? " -> " + fails.join(", ") : ""}`);
  try { sock?.close(); } catch {}
  if (engine) { try { engine.kill(); } catch {} }
  setTimeout(() => process.exit(code), 300);
}

main().catch((e) => { console.error("PEAKS-TEST CRASH:", e.message); finish(1); });
