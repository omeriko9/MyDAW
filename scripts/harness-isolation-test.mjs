#!/usr/bin/env node
/**
 * Harness isolation guard — a test that tests the tests.
 *
 *   node scripts/harness-isolation-test.mjs
 *
 * On 2026-07-31 the test suite damaged a live DAW installation. Harnesses spawned an engine
 * with the developer's REAL %APPDATA%, and an engine writes settings (audio device AND
 * plugin folders), plugin-cache.json, recent.json, autosave slots, a session.lock, and
 * renders into a fallback media dir under the profile:
 *
 *   - the user's VST2 folder list was erased, taking every VST2 plugin and every favourite
 *     out of the registry (679 plugins -> vst2=0);
 *   - a hard-killed harness left a session.lock pointing at its throwaway project, so the
 *     user's next launch crash-RECOVERED a test fixture instead of their work;
 *   - 1.6 GB of render output accumulated in the profile.
 *
 * Eighteen harnesses were fixed one by one. This exists because fixing them one by one does
 * not stop the nineteenth: the invariant has to be ENFORCED, not remembered. It is
 * deliberately a STATIC check — it reads the sources rather than running them, so it costs
 * milliseconds and cannot itself spawn anything.
 *
 * The rule: if a file spawns the engine, that spawn must pass an env redirecting APPDATA.
 * `scripts/lib/harness.mjs` satisfies it by construction; hand-rolled spawns are fine too,
 * as long as they redirect.
 */
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");
const SELF = path.basename(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

/** Does this spawn-call text redirect APPDATA? Accepts `APPDATA: x` and the ES shorthand. */
const isolatedText = (t) => /env\s*:/.test(t) && /APPDATA/.test(t);

/** Every engine spawn in `src`, as {line, text} over the balanced call expression. */
function engineSpawns(src) {
  const out = [];
  const re = /spawn(?:Sync)?\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    let depth = 0, end = -1;
    for (let i = start + m[0].length - 1; i < src.length && i < start + 4000; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) end = Math.min(src.length - 1, start + 1500);
    const text = src.slice(start, end + 1);
    // Only spawns of the ENGINE matter; taskkill/node/pwsh spawns are irrelevant.
    if (/mydaw-engine|ENGINE_EXE/.test(text))
      out.push({ line: src.slice(0, start).split("\n").length, text });
  }
  return out;
}

/* --------------------------------------------------------------- the guard itself */

const offenders = [];
let spawnFiles = 0, spawnCount = 0;
for (const f of readdirSync(SCRIPTS).filter((n) => n.endsWith(".mjs") && n !== SELF)) {
  const src = readFileSync(path.join(SCRIPTS, f), "utf8");
  const usesHelper = /lib\/harness\.mjs/.test(src);
  const spawns = engineSpawns(src);
  if (spawns.length === 0) continue;
  spawnFiles++;
  for (const s of spawns) {
    spawnCount++;
    if (!usesHelper && !isolatedText(s.text)) offenders.push(`${f}:${s.line}`);
  }
}

report("found engine spawns to check", spawnCount > 0,
  `${spawnCount} spawn(s) across ${spawnFiles} file(s)`);

report(
  "every engine spawn redirects APPDATA to a throwaway profile",
  offenders.length === 0,
  offenders.length
    ? `UNISOLATED: ${offenders.join(", ")}\n       A spawn here writes the developer's REAL ` +
      `settings, plugin folders, recent list, autosave and session.lock. Import ` +
      `scripts/lib/harness.mjs, or pass env: { ...process.env, APPDATA: <mkdtemp dir> }.`
    : "",
);

/* ------------------------------------------------------- the detector's own tests */
// A guard whose detector quietly stops matching is worse than no guard, and false POSITIVES
// are as corrosive as misses — they teach people to ignore it. The first version of this
// file matched only `APPDATA:` and wrongly accused four already-correct harnesses.
{
  const bad =
    'const engine = spawn(path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),\n' +
    '  ["--driver", "null", "--port", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });';
  const withColon = bad.replace(
    '{ stdio: ["ignore", "ignore", "pipe"] }',
    '{ stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: ISO } }');
  const withShorthand = bad.replace(
    '{ stdio: ["ignore", "ignore", "pipe"] }',
    '{ stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA } }');
  const irrelevant = 'spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });';

  report("detector: finds the engine spawn at all", engineSpawns(bad).length === 1);
  report("detector: flags an unisolated spawn",
    engineSpawns(bad).length === 1 && !isolatedText(engineSpawns(bad)[0].text));
  report("detector: clears `APPDATA: x`",
    engineSpawns(withColon).length === 1 && isolatedText(engineSpawns(withColon)[0].text));
  report("detector: clears the ES shorthand `APPDATA`",
    engineSpawns(withShorthand).length === 1 && isolatedText(engineSpawns(withShorthand)[0].text));
  report("detector: ignores non-engine spawns", engineSpawns(irrelevant).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
