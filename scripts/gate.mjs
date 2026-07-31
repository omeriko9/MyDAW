#!/usr/bin/env node
/**
 * gate — one command for "is this change done?".
 *
 *   node scripts/gate.mjs            # fast tier: what you run before every commit
 *   node scripts/gate.mjs --full     # everything, including the slow and asset-dependent
 *   node scripts/gate.mjs --list     # show the table and what each tier costs
 *   node scripts/gate.mjs --only smoke,ui-smoke
 *
 * BUILDING.md says a change is not done until the tests are green. Honouring that used to
 * mean typing thirty commands and knowing which of them need real VST plugins or a Cubase
 * corpus that is not in the repo — so in practice nobody ran them all, and a documented
 * gate that nobody runs is decoration.
 *
 * SEQUENTIAL BY NECESSITY, not by caution. Each harness spawns an engine on its own
 * hard-coded default port and several of them collide: 8547 is shared by dop-vst and
 * export-formats, 8561 by midi-learn and sidechain, and 8562 by comping, midi-out-channel
 * AND timestretch. Running these concurrently produces failures that look like flaky
 * tests. The fast tier is about a minute anyway; wall clock is not the constraint.
 *
 * SKIPPING IS A FIRST-CLASS OUTCOME. Seven harnesses need things a fresh clone does not
 * have — real plugins installed, or the CPR corpus, which is deliberately gitignored. A
 * runner that goes red on every machine but one developer's teaches people to ignore it,
 * so a missing prerequisite reports SKIP with the reason and does not fail the run.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const ENGINE = path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe");
const UI_DIST = path.join(ROOT, "ui", "dist");

/* ------------------------------------------------------------------- the table */

const needsEngine = { path: ENGINE, why: "engine not built — run .\\build.cmd" };
const needsUi = { path: UI_DIST, why: "ui/dist not built — run npm run build in ui/" };
// A scanned plugin registry is machine state, not repo state: a fresh clone has none, and
// the plugin harnesses have no no-plugins path of their own, so the gate has to skip them
// rather than let them fail for a reason that is nobody's bug.
const PLUGIN_CACHE = path.join(process.env.APPDATA ?? "", "MyDAW", "plugin-cache.json");
const needsPlugins = { path: PLUGIN_CACHE, why: "no scanned plugin registry on this machine" };
// The CPR corpus round-trip lives in a harness that is deliberately gitignored.
const CPR_ROUNDTRIP = path.join(ROOT, "scripts", "cpr-roundtrip-test.mjs");

/** tier: "fast" runs by default. "full" is slow or asset-dependent. "manual" never runs. */
const SUITES = [
  // Cheapest layer first, so a broken pure function fails in under a second.
  { id: "vitest", tier: "fast", cmd: "npm", args: ["test", "--silent"], cwd: path.join(ROOT, "ui"),
    shell: true, note: "pure logic, no engine" },

  { id: "smoke", tier: "fast", script: "smoke-test.mjs", requires: needsEngine },
  { id: "import", tier: "fast", script: "import-test.mjs", requires: needsEngine },
  { id: "peaks", tier: "fast", script: "peaks-test.mjs", requires: needsEngine },
  { id: "automation-paramref", tier: "fast", script: "automation-paramref-test.mjs", requires: needsEngine },
  { id: "automation-write", tier: "fast", script: "automation-write-test.mjs", requires: needsEngine },
  { id: "asset-recycle", tier: "fast", script: "asset-recycle-test.mjs", requires: needsEngine },
  { id: "record-capture", tier: "fast", script: "record-capture-test.mjs", requires: needsEngine,
    note: "headless recording via --null-input; the base every Phase 3 test builds on" },
  { id: "midi-learn", tier: "fast", script: "midi-learn-test.mjs", requires: needsEngine },
  { id: "midi-out-channel", tier: "fast", script: "midi-out-channel-test.mjs", requires: needsEngine },
  { id: "smf-logic", tier: "fast", script: "smf-logic-test.mjs", requires: needsEngine },
  { id: "track-types", tier: "fast", script: "track-types-test.mjs", requires: needsEngine },
  { id: "vca", tier: "fast", script: "vca-test.mjs", requires: needsEngine },
  { id: "sidechain", tier: "fast", script: "sidechain-test.mjs", requires: needsEngine },
  { id: "comping", tier: "fast", script: "comping-test.mjs", requires: needsEngine },
  { id: "loudness", tier: "fast", script: "loudness-test.mjs", requires: needsEngine },
  { id: "timestretch", tier: "fast", script: "timestretch-test.mjs", requires: needsEngine },
  { id: "export-formats", tier: "fast", script: "export-formats-test.mjs", requires: needsEngine },
  { id: "stock-effects", tier: "fast", script: "stock-effects-test.mjs", requires: needsEngine },
  { id: "stock-instrument", tier: "fast", script: "stock-instrument-test.mjs", requires: needsEngine },
  { id: "stock-sampler", tier: "fast", script: "stock-sampler-test.mjs", requires: needsEngine },
  { id: "agent-engine", tier: "fast", script: "agent-engine-test.mjs", requires: needsEngine },
  { id: "mcp", tier: "fast", script: "mcp-test.mjs", requires: needsEngine },

  // The browser suite: needs a served ui/dist and its own Chrome. Last in the fast tier
  // because it is the most expensive thing in it.
  { id: "ui-smoke", tier: "fast", script: "ui-smoke.mjs", requires: needsUi,
    note: "real Chrome over CDP" },

  // Slow or asset-dependent.
  { id: "recovery", tier: "full", script: "recovery-test.mjs", requires: needsEngine,
    note: "~80 s: autosave's interval is an int in MINUTES, so 60 s is the floor" },
  { id: "vst-load", tier: "full", script: "vst-load-test.mjs", requires: needsPlugins,
    note: "scans and loads REAL plugins — machine-dependent" },
  { id: "dop-vst", tier: "full", script: "dop-vst-test.mjs", requires: needsPlugins,
    note: "needs a real VST in the registry" },
  // Its own flag, not a skip: the writer half runs anywhere, only the corpus round-trip
  // needs the gitignored fixtures. Dropping the whole suite would lose the portable half.
  { id: "cpr-write", tier: "full", script: "cpr-write-test.mjs", requires: needsEngine,
    extraArgs: () => (existsSync(CPR_ROUNDTRIP) ? [] : ["--skip-corpus"]),
    note: "corpus round-trip is skipped when the gitignored fixtures are absent" },

  // Never run automatically: needs a local LLM server on a port this cannot assume.
  { id: "agent-llm", tier: "manual", script: "agent-llm-test.mjs",
    note: "needs a local model server — run it by hand" },
];

/* ---------------------------------------------------------------------- running */

const run = (s) => new Promise((resolve) => {
  const t0 = Date.now();
  const cmd = s.cmd ?? process.execPath;
  const args = (s.args ?? [path.join(ROOT, "scripts", s.script)]).concat(s.extraArgs?.() ?? []);
  const p = spawn(cmd, args, {
    cwd: s.cwd ?? ROOT, shell: s.shell ?? false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("error", (e) => resolve({ ok: false, ms: Date.now() - t0, out: String(e) }));
  p.on("close", (code) => resolve({ ok: code === 0, code, ms: Date.now() - t0, out }));
});

/** The last line that looks like a tally, so the summary shows evidence not just a verdict. */
function tally(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^\d+\s*\/\s*\d+ passed/.test(l)) return l;                 // ui-smoke
    if (/^\d+ passed(, \d+ failed)?/.test(l)) return l;             // report()-style harnesses
    if (/^Tests\s+\d+ passed/.test(l)) return l.replace(/\s+/g, " "); // vitest
    if (/TEST:\s+(ALL\s+)?PASS/.test(l)) return l;                  // "<NAME> TEST: ALL PASS" / "…: PASS (detail)"
    if (/^\d+ .*checks? passed$/.test(l)) return l;                 // agent-engine / mcp
  }
  return "";
}

async function main() {
  const only = val("only")?.split(",").map((x) => x.trim()).filter(Boolean) ?? null;
  const full = flag("full");
  const picked = SUITES.filter((s) =>
    only ? only.includes(s.id) : (s.tier === "fast" || (full && s.tier === "full")));

  if (flag("list")) {
    const w = Math.max(...SUITES.map((s) => s.id.length));
    for (const s of SUITES)
      console.log(`${s.id.padEnd(w)}  ${s.tier.padEnd(6)}  ${s.note ?? ""}`);
    console.log(`\nfast: ${SUITES.filter((s) => s.tier === "fast").length} suites` +
                `  full: +${SUITES.filter((s) => s.tier === "full").length}` +
                `  manual: ${SUITES.filter((s) => s.tier === "manual").length}`);
    return 0;
  }
  if (picked.length === 0) { console.log("nothing selected"); return 1; }

  console.log(`gate: ${picked.length} suite(s), ${full ? "full" : "fast"} tier\n`);
  const results = [];
  const t0 = Date.now();
  for (const s of picked) {
    if (s.requires && !existsSync(s.requires.path)) {
      results.push({ s, verdict: "SKIP", detail: s.requires.why, ms: 0 });
      console.log(`SKIP  ${s.id.padEnd(20)}         ${s.requires.why}`);
      continue;
    }
    // The in-progress line is a carriage-return overwrite, which only works on a terminal.
    // Piped (CI, a log file, a tool reading this), \r is just a character and every suite
    // would print twice — so only draw it when there is a TTY to erase it from.
    if (process.stdout.isTTY) process.stdout.write(`....  ${s.id.padEnd(20)}`);
    const r = await run(s);
    const secs = `${(r.ms / 1000).toFixed(1)}s`.padStart(7);
    const verdict = r.ok ? "PASS" : "FAIL";
    results.push({ s, verdict, detail: tally(r.out), ms: r.ms, out: r.out });
    process.stdout.write(`${process.stdout.isTTY ? "\r" : ""}${verdict}  ${s.id.padEnd(20)} ${secs}  ${tally(r.out)}\n`);
  }

  const failed = results.filter((r) => r.verdict === "FAIL");
  const skipped = results.filter((r) => r.verdict === "SKIP");
  // Failures print their output at the end, so a long run does not bury the reason.
  for (const f of failed) {
    console.log(`\n${"-".repeat(72)}\nFAILED: ${f.s.id}\n${"-".repeat(72)}`);
    console.log(f.out.split(/\r?\n/).slice(-40).join("\n"));
  }

  console.log(
    `\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} suites passed` +
    (failed.length ? `, ${failed.length} FAILED (${failed.map((f) => f.s.id).join(", ")})` : "") +
    (skipped.length ? `, ${skipped.length} skipped` : "") +
    ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  if (!full && !only)
    console.log("(fast tier — run with --full before a release or a merge)");
  return failed.length > 0 ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(`gate: ${e?.stack ?? e}`);
  process.exit(1);
});
