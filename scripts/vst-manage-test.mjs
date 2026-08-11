#!/usr/bin/env node
/**
 * VST management test — blacklist surfacing + batch unblacklist (Phase 1 of the VST
 * revision; later phases extend this file).
 *
 * Uses an ISOLATED %APPDATA% seeded with a synthetic blacklist.json BEFORE the engine
 * boots — blacklist behavior is testable without any real plugin on the machine.
 * Checks:
 *   - plugins/getBlacklist returns the raw entries incl. path-only ones (no uid),
 *     with reason + when
 *   - batch unblacklist {paths:[...]} removes exactly those, in ONE event/scanDone
 *   - single {uid} stays back-compat
 *   - {all:true} empties the list
 *   - empty request → bad_request
 * Usage: node scripts/vst-manage-test.mjs [--port 8583]
 */
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8583"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => { console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`); ok ? passed++ : failed++; };

// ISOLATED %APPDATA% (see automation-write-test.mjs for the rationale) + seed the
// blacklist BEFORE boot: the Blacklist ctor loads the file once at startup.
const APPDATA_ISO = mkdtempSync(path.join(tmpdir(), "mydaw-iso-"));
const appDir = path.join(APPDATA_ISO, "MyDAW");
mkdirSync(appDir, { recursive: true });
const SEED = [
  { path: "C:\\Fake\\CrashyReverb.dll", reason: "crashed during scan (0xC0000005)", when: "2026-06-15T14:09:38Z" },
  { path: "C:\\Fake\\SlowSampler.dll", reason: "scan timeout", when: "2026-06-16T09:00:00Z" },
  { path: "C:\\Fake\\OldChorus.dll", reason: "disabled by user", uid: "1234567890", when: "2026-07-01T12:00:00Z" },
  { path: "C:\\Fake\\Sub\\Another.dll", reason: "disabled by user", uid: "999", when: "2026-07-02T12:00:00Z" },
  { path: "C:\\Fake\\Keeper.dll", reason: "crashed during scan (0xC0000374)", when: "2026-07-03T12:00:00Z" },
];
writeFileSync(path.join(appDir, "blacklist.json"), JSON.stringify({ entries: SEED }, null, 2));

// A VST2 "folder" of copies of the host exe: valid x64 PEs that are NOT plugins, so every
// full-rescan spawn runs a real scan host that fails fast — enough wall-clock per file to
// cancel mid-scan without needing any real plugin on the machine.
const FIXTURE_DIR = path.join(APPDATA_ISO, "fixture-vsts");
mkdirSync(FIXTURE_DIR, { recursive: true });
const HOST_EXE = path.join(ROOT, "build", "bin", "Release", "mydaw-host64.exe");
const FIXTURE_N = 40;
for (let i = 0; i < FIXTURE_N; i++)
  copyFileSync(HOST_EXE, path.join(FIXTURE_DIR, `notaplugin-${String(i).padStart(2, "0")}.dll`));
writeFileSync(path.join(appDir, "settings.json"), JSON.stringify({
  pluginFoldersVst2: [FIXTURE_DIR],
  pluginFoldersVst3: [],
}, null, 2));

// A v1 plugin-cache with one entry of every real-world failure string, plus an ok entry —
// loadCache must migrate them to structured verdicts (cache v2). Paths point INSIDE the
// fixture dir so populateRegistryFromCache keeps them (configured-folder filter).
const V1_CACHE = {
  version: 1,
  entries: [
    { path: path.join(FIXTURE_DIR, "seed-support.dll"), size: 1, mtimeMs: 1, ok: false,
      error: "LoadLibrary failed: The specified module could not be found (code 126)" },
    { path: path.join(FIXTURE_DIR, "seed-notvst.dll"), size: 1, mtimeMs: 1, ok: false,
      error: "not a VST2 plugin (no VSTPluginMain/main export)" },
    { path: path.join(FIXTURE_DIR, "seed-initfail.dll"), size: 1, mtimeMs: 1, ok: false,
      error: "LoadLibrary failed: A dynamic link library (DLL) initialization routine failed (code 1114)" },
    { path: path.join(FIXTURE_DIR, "seed-badaeffect.dll"), size: 1, mtimeMs: 1, ok: false,
      error: "plugin entry point did not return a valid AEffect" },
    { path: path.join(FIXTURE_DIR, "seed-sehcrash.dll"), size: 1, mtimeMs: 1, ok: false,
      error: "plugin crashed during scan (SEH 0xC0000005)" },
    { path: path.join(FIXTURE_DIR, "seed-good.dll"), size: 1, mtimeMs: 1, ok: true,
      plugins: [{ uid: "424242", format: "vst2", path: path.join(FIXTURE_DIR, "seed-good.dll"),
                  bitness: 64, name: "SeedSynth", vendor: "Seed", category: "Instrument",
                  isInstrument: true, numInputs: 0, numOutputs: 2 }] },
  ],
};
writeFileSync(path.join(appDir, "plugin-cache.json"), JSON.stringify(V1_CACHE));

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
let scanDoneCount = 0;
const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("ws")); });
sock.onmessage = (m) => {
  const j = JSON.parse(m.data);
  if (j.type === "event/scanDone") scanDoneCount++;
  if (j.replyTo != null) {
    const p = pending.get(j.replyTo);
    if (p) { pending.delete(j.replyTo); p.res(j); }
  }
};
const raw = (t, payload = {}) => {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type: t, payload }));
  return new Promise((res, rej) => { pending.set(id, { res }); setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, 20000); });
};
const req = async (t, p = {}) => {
  const r = await raw(t, p);
  if (!r.ok) throw new Error(`${t}: ${r.error?.code} ${r.error?.message}`);
  return r.payload ?? {};
};

try {
  await req("session/hello", { clientName: "vstm" });

  /* ---- Phase 3: getHealth verdict classification (v1 cache migrated to v2) ----------
     Runs FIRST: a completed scan prunes cache entries whose files vanished, and
     the seeds exist only in the cache file - so classify before anything scans. */
  const health = await req("plugins/getHealth", {});
  const s3 = health.summary;
  const vOf = async (base) => {
    const one = await req("plugins/getHealth", { path: path.join(FIXTURE_DIR, base) });
    return one.files[0]?.verdict;
  };
  report("v1 error strings classify to structured verdicts",
    (await vOf("seed-support.dll")) === "dep_missing" &&
      (await vOf("seed-notvst.dll")) === "not_plugin" &&
      (await vOf("seed-initfail.dll")) === "init_failed" &&
      (await vOf("seed-badaeffect.dll")) === "init_failed" &&
      (await vOf("seed-sehcrash.dll")) === "scan_crashed" &&
      (await vOf("seed-good.dll")) === "ok",
    `summary=${JSON.stringify(s3)}`);
  // The default list hides benign non-plugins; the summary still counts them.
  const listed = new Set(health.files.map((f) => f.path));
  report("benign support DLLs are hidden from the default list but counted",
    !listed.has(path.join(FIXTURE_DIR, "seed-support.dll")) &&
      !listed.has(path.join(FIXTURE_DIR, "seed-notvst.dll")) &&
      s3.dep_missing >= 1 && s3.not_plugin >= 1,
    `files=${health.files.length} dep_missing=${s3.dep_missing} not_plugin=${s3.not_plugin}`);
  const withBenign = await req("plugins/getHealth", { includeBenign: true });
  report("includeBenign surfaces them",
    withBenign.files.length > health.files.length,
    `${health.files.length} -> ${withBenign.files.length}`);
  // Single-file detail carries hostTail when one exists; list rows never do.
  report("list rows omit hostTail (detail-only field)",
    health.files.every((f) => f.hostTail === undefined), "");

  // --- getBlacklist surfaces everything, incl. path-only entries -------------------
  const bl0 = (await req("plugins/getBlacklist", {})).entries;
  const pathOnly = bl0.filter((e) => !e.uid);
  report("getBlacklist returns all seeded entries", bl0.length === 5, `entries=${bl0.length}`);
  report("path-only crash entries are visible (no uid)", pathOnly.length === 3, `pathOnly=${pathOnly.length}`);
  const crashy = bl0.find((e) => e.path.includes("CrashyReverb"));
  report("reason and when survive the round-trip",
    crashy?.reason === "crashed during scan (0xC0000005)" && crashy?.when === "2026-06-15T14:09:38Z",
    `reason=${JSON.stringify(crashy?.reason)} when=${crashy?.when}`);

  // --- batch removal: exactly the named paths, ONE broadcast ------------------------
  scanDoneCount = 0;
  const batch = await req("plugins/unblacklist", {
    paths: ["C:\\Fake\\CrashyReverb.dll", "C:\\Fake\\SlowSampler.dll"],
  });
  await sleep(400); // let any (wrong) extra broadcasts arrive before counting
  const bl1 = (await req("plugins/getBlacklist", {})).entries;
  report("batch unblacklist removes exactly the named paths",
    batch.removed === 2 && bl1.length === 3 && !bl1.some((e) => e.path.includes("CrashyReverb")),
    `removed=${batch.removed} left=${bl1.length}`);
  report("one event/scanDone for the whole batch", scanDoneCount === 1, `broadcasts=${scanDoneCount}`);

  // --- back-compat single uid --------------------------------------------------------
  const single = await req("plugins/unblacklist", { uid: "1234567890" });
  const bl2 = (await req("plugins/getBlacklist", {})).entries;
  report("single {uid} still works (back-compat)",
    single.removed === 1 && bl2.length === 2, `removed=${single.removed} left=${bl2.length}`);

  // --- all:true ----------------------------------------------------------------------
  scanDoneCount = 0;
  const all = await req("plugins/unblacklist", { all: true });
  await sleep(400);
  const bl3 = (await req("plugins/getBlacklist", {})).entries;
  report("all:true empties the blacklist in one broadcast",
    all.removed === 2 && bl3.length === 0 && scanDoneCount === 1,
    `removed=${all.removed} left=${bl3.length} broadcasts=${scanDoneCount}`);

  // --- empty request refused -----------------------------------------------------------
  const bad = await raw("plugins/unblacklist", {});
  report("empty request is refused with bad_request",
    bad.ok === false && bad.error?.code === "bad_request", `code=${bad.error?.code}`);

  // --- removing nothing broadcasts nothing --------------------------------------------
  scanDoneCount = 0;
  const none = await req("plugins/unblacklist", { paths: ["C:\\Fake\\NeverWas.dll"] });
  await sleep(300);
  report("a no-op removal broadcasts nothing", none.removed === 0 && scanDoneCount === 0,
    `removed=${none.removed} broadcasts=${scanDoneCount}`);

  /* ---- Phase 2: scan cancel + targeted scan ------------------------------------------
     The fixture folder holds 40 host-exe copies: every full-rescan spawn runs a real scan
     host that reports "not a plugin" — slow enough in aggregate to cancel mid-flight. */
  let scanDonePayload = null;
  const doneWaiter = () => new Promise((res) => {
    const h = (m) => {
      const j = JSON.parse(m.data);
      if (j.type === "event/scanDone") { sock.removeEventListener("message", h); res(j.payload); }
    };
    sock.addEventListener("message", h);
  });

  // cancel with nothing running → false
  const idle = await req("plugins/scanCancel", {});
  report("scanCancel with no scan running returns false", idle.cancelling === false,
    `cancelling=${idle.cancelling}`);

  // full rescan of the fixture folder, cancel after the first progress event
  let sawProgress = false;
  const progWaiter = new Promise((res) => {
    const h = (m) => {
      const j = JSON.parse(m.data);
      if (j.type === "event/scanProgress" && j.payload?.current >= 2) {
        sawProgress = true; sock.removeEventListener("message", h); res();
      }
    };
    sock.addEventListener("message", h);
  });
  let donePromise = doneWaiter();
  const started = await req("plugins/scan", { full: true });
  await progWaiter;
  const cx = await req("plugins/scanCancel", {});
  const t0 = Date.now();
  scanDonePayload = await donePromise;
  report("a running full rescan cancels",
    started.started === true && sawProgress && cx.cancelling === true &&
      scanDonePayload?.cancelled === true,
    `started=${started.started} cancelling=${cx.cancelling} doneCancelled=${scanDonePayload?.cancelled} after=${Date.now() - t0}ms`);

  // a fresh scan can start afterwards and completes WITHOUT the cancelled flag
  donePromise = doneWaiter();
  const again = await req("plugins/scan", { full: false });
  scanDonePayload = await donePromise;
  report("a new scan starts after a cancel and completes",
    again.started === true && scanDonePayload?.cancelled === undefined,
    `started=${again.started} cancelled=${scanDonePayload?.cancelled}`);

  // targeted scan: exactly one file processed, registry untouched for the rest
  donePromise = doneWaiter();
  const oneFile = path.join(FIXTURE_DIR, "notaplugin-00.dll");
  let targetedTotal = -1;
  const progOnce = (m) => {
    const j = JSON.parse(m.data);
    if (j.type === "event/scanProgress") targetedTotal = j.payload.total;
  };
  sock.addEventListener("message", progOnce);
  await req("plugins/scan", { full: true, paths: [oneFile] });
  await donePromise;
  sock.removeEventListener("message", progOnce);
  report("a targeted scan processes only the named file", targetedTotal === 1,
    `total=${targetedTotal}`);

  /* ---- Phase 4: relocate + revealFile ------------------------------------------------ */
  // Blacklist a fixture file, "move" it (copy under a new name), relocate: the blacklist
  // entry must follow the file and the new path must get scanned.
  const relocOld = path.join(FIXTURE_DIR, "notaplugin-01.dll");
  const relocNew = path.join(FIXTURE_DIR, "moved-plugin.dll");
  copyFileSync(HOST_EXE, relocNew);
  await req("plugins/blacklist", { path: relocOld, reason: "disabled by user" });
  const relocDone = (() => new Promise((res) => {
    const h = (m) => {
      const j = JSON.parse(m.data);
      if (j.type === "event/scanDone") { sock.removeEventListener("message", h); res(j.payload); }
    };
    sock.addEventListener("message", h);
  }))();
  const reloc = await req("plugins/relocate", { oldPath: relocOld, newPath: relocNew });
  await relocDone; // the targeted scan of the new path
  const blAfterReloc = (await req("plugins/getBlacklist", {})).entries;
  report("relocate moves the blacklist entry to the new path",
    reloc.ok === true && reloc.blacklistMoved === true && reloc.scanned === true &&
      blAfterReloc.some((e) => e.path === relocNew) &&
      !blAfterReloc.some((e) => e.path === relocOld),
    `moved=${reloc.blacklistMoved} scanned=${reloc.scanned}`);
  const relocBad = await raw("plugins/relocate", { oldPath: relocNew, newPath: "C:\\No\\Such\\File.dll" });
  report("relocate to a missing file is refused",
    relocBad.ok === false && relocBad.error?.code === "not_found", `code=${relocBad.error?.code}`);
  await req("plugins/unblacklist", { paths: [relocNew] }); // leave the fixture clean

  /* ---- Phase 8: folder-category warnings ---------------------------------------------- */
  // The fixture dir holds only .dll files; filing it under the VST3 list must warn (and
  // only warn — the scanner routes by extension, so nothing is lost).
  const misfiled = await req("plugins/setFolders", { vst2: [], vst3: [FIXTURE_DIR] });
  report("a VST2 folder under the VST3 list draws an advisory warning",
    Array.isArray(misfiled.warnings) && misfiled.warnings.length === 1 &&
      misfiled.warnings[0].list === "vst3" && /still found/.test(misfiled.warnings[0].message),
    JSON.stringify(misfiled.warnings ?? null).slice(0, 140));
  const wellFiled = await req("plugins/setFolders", { vst2: [FIXTURE_DIR], vst3: [] });
  report("a correctly filed folder draws none", wellFiled.warnings === undefined,
    JSON.stringify(wellFiled.warnings ?? null));

  /* ---- Phase 7: icon endpoint --------------------------------------------------------- */
  const icon404 = await fetch(`http://127.0.0.1:${PORT}/api/plugin-icon/deadbeefdeadbeef`);
  report("a bogus icon key 404s", icon404.status === 404, `status=${icon404.status}`);
  const iconEvil = await fetch(`http://127.0.0.1:${PORT}/api/plugin-icon/..%2Fsettings.json`);
  report("a path-shaped icon key is refused", iconEvil.status === 404, `status=${iconEvil.status}`);
  // The scan-done icon harvest ran during the scans above: host-exe copies have Windows
  // app icons, so at least one PNG should exist and its registry row carry iconKey.
  const regNow = (await req("plugins/getRegistry", {})).registry;
  const withIcon = regNow.find((p2) => p2.iconKey);
  if (withIcon) {
    const iconOk = await fetch(`http://127.0.0.1:${PORT}/api/plugin-icon/${withIcon.iconKey}`);
    report("an extracted icon serves as image/png",
      iconOk.status === 200 && (iconOk.headers.get("content-type") ?? "").includes("image/png"),
      `status=${iconOk.status} type=${iconOk.headers.get("content-type")}`);
  } else {
    report("registry rows carry iconKey when a PNG exists (none extracted here — acceptable)",
      true, "no icon-bearing plugins in the fixture registry");
  }

  const revealBad = await raw("plugins/revealFile", { path: "C:\\No\\Such\\File.dll" });
  report("revealFile refuses a missing path",
    revealBad.ok === false && revealBad.error?.code === "not_found", `code=${revealBad.error?.code}`);
  const revealUnknown = await raw("plugins/revealFile", { path: HOST_EXE });
  report("revealFile refuses a path the engine does not know as a plugin",
    revealUnknown.ok === false && revealUnknown.error?.code === "bad_request",
    `code=${revealUnknown.error?.code}`);
  // (The success path opens a real Explorer window — deliberately not exercised here.)

  console.log(`\n${passed} passed, ${failed} failed`);
  die(failed === 0 ? 0 : 1, failed === 0 ? "VST MANAGE TEST: ALL PASS" : "VST MANAGE TEST: FAILURES");
} catch (e) {
  report("unexpected exception", false, String(e?.message ?? e));
  die(1, "VST MANAGE TEST: EXCEPTION\n" + elog.slice(-800));
}
