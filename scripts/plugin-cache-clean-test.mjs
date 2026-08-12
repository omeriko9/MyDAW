#!/usr/bin/env node
/**
 * plugins/cleanCache — pruning dead scan-cache records (SPEC §8.3).
 *
 *   node scripts/plugin-cache-clean-test.mjs [--port 8655]
 *
 * The cache is a durable log of every file MyDAW has ever tried to scan, and the Plugin
 * Manager's Health view shows it raw — so records from folders the user has since removed
 * live there forever. Reported 2026-08-12: "I see a VST from C:\Temp\... but that path
 * isn't in my Plug-ins settings, where is it coming from?" Those records can never be
 * consulted again (a scan only walks the CONFIGURED folders), so cleanCache drops them,
 * plus records whose file is gone. It must NEVER touch the blacklist, which holds
 * decisions rather than findings.
 *
 * Isolated %APPDATA% seeded before boot, so no real plugin is needed anywhere.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8655"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

const APPDATA_ISO = mkdtempSync(path.join(tmpdir(), "mydaw-cacheclean-"));
const appDir = path.join(APPDATA_ISO, "MyDAW");
mkdirSync(appDir, { recursive: true });

// One configured folder holding one real file (a copy of the scan host: a valid PE that
// is not a plugin, which is all the folder walk needs).
const KEPT_DIR = path.join(APPDATA_ISO, "configured-vsts");
mkdirSync(KEPT_DIR, { recursive: true });
const LIVE = path.join(KEPT_DIR, "present.dll");
writeFileSync(LIVE, Buffer.from("MZ not a real PE, never scanned in this test"));
writeFileSync(path.join(appDir, "settings.json"), JSON.stringify({
  pluginFoldersVst2: [KEPT_DIR],
  pluginFoldersVst3: [],
}, null, 2));

const GONE_INSIDE = path.join(KEPT_DIR, "deleted-since.dll"); // inside, but not on disk
const OUTSIDE_A = "C:\\Temp\\NI_Kontakt_SETUP_capture\\bak\\Kontakt2.patched - Copy.dll";
const OUTSIDE_B = "C:\\Temp\\NI_Kontakt_SETUP_capture\\files\\C\\PF\\SV\\K2\\Kontakt2.dll";
const entry = (p, extra = {}) => ({ path: p, size: 1, mtimeMs: 1, ok: false,
  verdict: "init_failed", error: "seeded", ...extra });
writeFileSync(path.join(appDir, "plugin-cache.json"), JSON.stringify({
  version: 2,
  entries: [
    entry(LIVE),                                   // keep: configured + present
    entry(GONE_INSIDE),                            // drop: configured but missing
    entry(OUTSIDE_A),                              // drop: outside every folder
    entry(OUTSIDE_B),                              // drop: outside every folder
  ],
}));

// The blacklist must survive untouched, including its out-of-folder entries.
const BLACKLIST = [
  { path: OUTSIDE_A, reason: "disabled by user", when: "2026-08-01T10:00:00Z" },
  { path: LIVE, reason: "crashed during scan (0xC0000005)", when: "2026-08-02T10:00:00Z" },
];
writeFileSync(path.join(appDir, "blacklist.json"), JSON.stringify({ entries: BLACKLIST }, null, 2));

const engine = spawn(path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: APPDATA_ISO } });
engine.stderr.on("data", () => {});
const cleanup = () => {
  try { spawnSync("taskkill", ["/F", "/PID", String(engine.pid)], { stdio: "ignore" }); } catch { /* gone */ }
};
const die = (code, msg) => { console.log(msg); cleanup(); setTimeout(() => process.exit(code), 400); };

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { await sleep(500); }
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

const cachePaths = () =>
  JSON.parse(readFileSync(path.join(appDir, "plugin-cache.json"), "utf8"))
    .entries.map((e) => e.path);

try {
  await req("session/hello", { clientName: "cacheclean" });

  /* ---- the Health view is exactly where the stale record shows up ---------------- */
  const health0 = (await req("plugins/getHealth", { includeBenign: true })).payload;
  report("a file outside every configured folder still appears in Health",
    (health0.files ?? []).some((f) => f.path === OUTSIDE_A),
    `${(health0.files ?? []).length} file(s) listed`);

  /* ---- dryRun counts without deleting ------------------------------------------- */
  const dry = (await req("plugins/cleanCache", { dryRun: true })).payload;
  report("dryRun counts the two out-of-folder records and the one missing file",
    dry.removedOutsideFolders === 2 && dry.removedMissingFiles === 1 && dry.kept === 1,
    JSON.stringify(dry));
  report("…and changes nothing on disk",
    cachePaths().length === 4, JSON.stringify(cachePaths().length));

  /* ---- the real prune ------------------------------------------------------------ */
  const done = (await req("plugins/cleanCache", {})).payload;
  report("clean removes exactly those records",
    done.removedOutsideFolders === 2 && done.removedMissingFiles === 1 && done.kept === 1,
    JSON.stringify(done));
  const after = cachePaths();
  report("only the configured, still-present file survives in the cache file",
    after.length === 1 && after[0] === LIVE, JSON.stringify(after));

  // getHealth lists cache records UNION blacklisted paths, so a pruned file only leaves
  // the view when nothing else claims it. OUTSIDE_B was merely cached → gone. OUTSIDE_A
  // is BLACKLISTED → it must stay listed, or the user could no longer see (or undo) a
  // decision they made about it.
  const health1 = (await req("plugins/getHealth", { includeBenign: true })).payload;
  const paths1 = (health1.files ?? []).map((f) => f.path);
  report("a merely-cached stale record disappears from Health",
    !paths1.includes(OUTSIDE_B), JSON.stringify(paths1.length));
  report("…but a BLACKLISTED out-of-folder path stays visible, so the decision is undoable",
    paths1.includes(OUTSIDE_A), JSON.stringify(paths1));

  /* ---- the blacklist is a DECISION store: never pruned --------------------------- */
  const bl = (await req("plugins/getBlacklist", {})).payload;
  const blPaths = (bl.entries ?? []).map((e) => e.path);
  report("the blacklist keeps both entries, including the out-of-folder one",
    blPaths.includes(OUTSIDE_A) && blPaths.includes(LIVE), JSON.stringify(blPaths));
  report("blacklist.json on disk is untouched",
    existsSync(path.join(appDir, "blacklist.json")) &&
      JSON.parse(readFileSync(path.join(appDir, "blacklist.json"), "utf8")).entries.length === 2);

  /* ---- idempotent ---------------------------------------------------------------- */
  const again = (await req("plugins/cleanCache", {})).payload;
  report("running it again finds nothing left to do",
    again.removedOutsideFolders === 0 && again.removedMissingFiles === 0 && again.kept === 1,
    JSON.stringify(again));
} catch (e) {
  report("harness completed", false, e?.stack ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 400);
