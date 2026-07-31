#!/usr/bin/env node
/**
 * Stem export test (SPEC §5.5) — export/render {stems:true}.
 *
 *   node scripts/stem-export-test.mjs [--port 8574]
 *
 * Single-pass multi-sink: the engine renders ONCE and taps each eligible track's
 * post-insert/EQ/PDC/fader/pan work buffer alongside the master sink. The checks are
 * chosen to discriminate the two ways a stem tap could silently lie:
 *
 *   - If the tap read the master bus instead of the track, each "stem" would contain
 *     BOTH sines — so each stem's peak must equal only its own track's amplitude
 *     (0.79 vs 0.20, far apart by construction).
 *   - If the pass double-rendered or mis-scaled, master ≠ sum of stems — with two
 *     master-routed tracks and no sends/bus processing, master[i] must equal
 *     stemA[i] + stemB[i] to float precision, sample by sample.
 *
 * Also covered: eligibility (a bus IS a stem — silent here, reported at -120 dB; the
 * master is NOT a stem, it is the main file), the WAV-only v1 restriction (stems+mp3
 * → bad_request, no silent fallback), and that an un-requested export carries no
 * stems field.
 */
import { spawnEngine, sleep } from "./lib/harness.mjs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8574"));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

/** 16-bit mono PCM sine fixture (44.1k, resampled by the engine on import). */
function makeSineWav(amp16, freq, sr = 44100, secs = 2) {
  const n = sr * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * amp16), 44 + i * 2);
  return buf;
}

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
const sampleAt = (w, i) => w.buf.readFloatLE(w.off + i * w.fmt.ch * 4); // ch0
const frameCount = (w) => w.bytes / (w.fmt.ch * 4);
const wavPeak = (w) => {
  let p = 0;
  for (let i = 0; i + 3 < w.bytes; i += 4) p = Math.max(p, Math.abs(w.buf.readFloatLE(w.off + i)));
  return p;
};

const e = await spawnEngine({ port: PORT });

try {
  await e.req("session/hello", { clientName: "stems" });
  await e.req("project/new", {});
  const tA = (await e.req("cmd/track.add", { kind: "audio", name: "Lead" })).payload.track;
  const tB = (await e.req("cmd/track.add", { kind: "audio", name: "Bass" })).payload.track;
  const bus = (await e.req("cmd/track.add", { kind: "bus", name: "FX Bus" })).payload.track;

  const AMP_A = 26000 / 32768, AMP_B = 6500 / 32768; // ≈ 0.7935 / 0.1984
  for (const [t, amp16, freq, nm] of [[tA, 26000, 440, "a.wav"], [tB, 6500, 220, "b.wav"]]) {
    const fd = new FormData();
    fd.append("files", new Blob([makeSineWav(amp16, freq)], { type: "audio/wav" }), nm);
    const up = await fetch(`http://127.0.0.1:${PORT}/api/upload?trackId=${t.id}&atBeat=0`,
      { method: "POST", body: fd });
    if (!up.ok) throw new Error(`upload ${nm}: http ${up.status}`);
  }
  await sleep(600); // async decode

  // ---- the WAV-only restriction is enforced, not silently ignored ----
  const rejected = await e.req("export/render",
    { path: path.join(e.appdata, "no.mp3"), startBeat: 0, endBeat: 4,
      format: { type: "mp3", bitDepth: 16, kbps: 192 }, stems: true });
  report("stems with an encoded format is refused (WAV-only v1)",
    !rejected.ok && rejected.error?.code === "bad_request",
    JSON.stringify(rejected.error ?? rejected));

  // ---- the real export ----
  const out = path.join(e.appdata, "Mix.wav");
  const r = await e.req("export/render",
    { path: out, startBeat: 0, endBeat: 4, format: { type: "wav", bitDepth: 32 }, stems: true },
    120000);
  report("stems export succeeded", r.ok, JSON.stringify(r.error ?? ""));
  if (!r.ok) throw new Error("export failed, nothing further to assert");

  const stems = r.payload.stems ?? [];
  report("one stem per eligible track (2 audio + 1 bus, master excluded)",
    stems.length === 3 && !stems.some((s) => s.path === out),
    JSON.stringify(stems.map((s) => s.name)));

  const byName = Object.fromEntries(stems.map((s) => [s.name, s]));
  const sA = byName["Lead"], sB = byName["Bass"], sBus = byName["FX Bus"];
  report("every stem file exists on disk",
    stems.every((s) => existsSync(s.path)), stems.map((s) => path.basename(s.path)).join(", "));

  const wM = readWav(out), wA = sA && readWav(sA.path), wB = sB && readWav(sB.path);
  report("stem files are 32-bit float at the master's frame count",
    !!wA && !!wB && wA.fmt.bits === 32 && wB.fmt.bits === 32 &&
      frameCount(wA) === frameCount(wM) && frameCount(wB) === frameCount(wM),
    wA && wM ? `${frameCount(wA)} vs master ${frameCount(wM)}` : "unreadable");

  // Each stem holds ONLY its own track (a master-bus mis-tap would show both sines).
  const pA = wavPeak(wA), pB = wavPeak(wB);
  report("the Lead stem peaks at its own amplitude only",
    pA > AMP_A * 0.97 && pA < AMP_A * 1.03, `peak=${pA.toFixed(4)} expected≈${AMP_A.toFixed(4)}`);
  report("the Bass stem peaks at its own amplitude only",
    pB > AMP_B * 0.97 && pB < AMP_B * 1.03, `peak=${pB.toFixed(4)} expected≈${AMP_B.toFixed(4)}`);

  // Single-pass correctness: master == Lead + Bass, sample by sample.
  let worst = 0;
  const n = Math.min(frameCount(wM), frameCount(wA), frameCount(wB));
  for (let i = 0; i < n; i++)
    worst = Math.max(worst, Math.abs(sampleAt(wM, i) - (sampleAt(wA, i) + sampleAt(wB, i))));
  report("master equals the sum of the stems (single pass, no double render)",
    n > 0 && worst < 1e-5, `worst |master-(A+B)| = ${worst.toExponential(2)} over ${n} frames`);

  report("the silent bus stem is written and reported at -120 dB",
    !!sBus && existsSync(sBus.path) && sBus.peakDb <= -119,
    sBus ? `peakDb=${sBus.peakDb}` : "missing");
  report("stem peakDb matches the written signal",
    Math.abs(sA.peakDb - 20 * Math.log10(pA)) < 0.2, `reply=${sA.peakDb.toFixed(2)}`);

  // ---- no stems unless asked ----
  const plain = await e.req("export/render",
    { path: path.join(e.appdata, "Plain.wav"), startBeat: 0, endBeat: 2,
      format: { type: "wav", bitDepth: 32 } }, 120000);
  report("an export without stems carries no stems field",
    plain.ok && !("stems" in plain.payload), JSON.stringify(Object.keys(plain.payload ?? {})));
} catch (err) {
  report("harness completed", false, err?.stack ?? String(err));
}

console.log(`\n${passed} passed, ${failed} failed`);
e.close();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
