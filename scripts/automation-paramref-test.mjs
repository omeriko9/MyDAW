#!/usr/bin/env node
/**
 * automation paramRef grammar test.
 *
 *   node scripts/automation-paramref-test.mjs [--port 8563]
 *
 * The paramRef grammar ("volume" | "pan" | "send:<n>" | "plugin:<inst>:<id>" | "cc:<0..129>")
 * is decided in more than one place: parseParamRef owns it, validParamRef re-states it, and
 * automationSet re-states it a second time inline. That duplication has already produced one
 * live bug — cc: lanes made by midi.extractAutomation were rejected by every edit, because
 * two of the three spellings had never heard of cc: — so the property worth pinning is not
 * "these strings are valid" but "all three commands agree about every string".
 *
 * So the table below is checked against cmd/automation.set, .ramp and .clear alike, and a
 * disagreement fails even when the individual verdict looks reasonable. If someone tightens
 * one spelling and not the others, this goes red before a user finds an uneditable lane.
 *
 * Runs against a throwaway engine with a redirected APPDATA — never a live session.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", "8563"));
const TMP = mkdtempSync(path.join(tmpdir(), "mydaw-apr-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
};

/* ------------------------------------------------------------------ the table */

/**
 * `accept` is what the CONTRACT says today, not what looks tidy.
 *
 * "send:" and "plugin:" are matched by prefix only, so "send:abc" is accepted while
 * parseParamRef calls it Invalid. That latitude is deliberate for plugin: — a lane must
 * survive a project whose plugin has not been instantiated yet — and falls out of the same
 * branch for send:. It is asserted here so that tightening it is a visible decision rather
 * than an accident; see the note printed at the end of the run.
 */
const CASES = [
  { ref: "volume", accept: true, why: "the canonical track parameter" },
  { ref: "pan", accept: true, why: "the other canonical track parameter" },
  { ref: "send:0", accept: true, why: "first send" },
  { ref: "send:3", accept: true, why: "a send index that need not exist yet" },
  { ref: "cc:0", accept: true, why: "lower cc bound" },
  { ref: "cc:74", accept: true, why: "an ordinary controller — what extractAutomation makes" },
  { ref: "cc:129", accept: true, why: "upper cc bound (128/129 are the aftertouch pair)" },
  { ref: "plugin:1:0", accept: true, why: "plugin parameter" },

  { ref: "", accept: false, why: "empty" },
  { ref: "bogus", accept: false, why: "not in the grammar" },
  { ref: "Volume", accept: false, why: "the grammar is case-sensitive" },
  { ref: "volume ", accept: false, why: "no trailing-space tolerance" },
  { ref: "cc:", accept: false, why: "cc with no controller" },
  { ref: "cc:x", accept: false, why: "cc with a non-numeric controller" },
  { ref: "cc:130", accept: false, why: "past the cc ceiling" },
  { ref: "cc:-1", accept: false, why: "below the cc floor" },
  { ref: "cc:1x", accept: false, why: "cc must consume the WHOLE suffix" },

  // Prefix-only latitude, pinned deliberately (see the comment above).
  { ref: "send:abc", accept: true, why: "prefix-only match — latitude, not correctness" },
  { ref: "plugin:nope", accept: true, why: "prefix-only match — latitude, not correctness" },
];

/* ----------------------------------------------------------------- the engine */

const engine = spawn(
  path.join(ROOT, "build", "bin", "Release", "mydaw-engine.exe"),
  ["--driver", "null", "--no-browser", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, APPDATA: TMP } },
);
let elog = "";
engine.stderr.on("data", (d) => { elog = (elog + d).slice(-6000); });
const cleanup = () => {
  try { engine.kill(); } catch { /* already gone */ }
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
  // Rejection is an EXPECTED outcome here, so hand back the verdict instead of throwing.
  p.res(j.ok ? { ok: true, payload: j.payload ?? {} } : { ok: false, error: j.error ?? {} });
};
const req = (t, payload = {}, ms = 30000) => {
  const id = nextId++;
  sock.send(JSON.stringify({ id, type: t, payload }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej, t });
    setTimeout(() => { if (pending.delete(id)) rej(new Error(t + ": timeout")); }, ms);
  });
};

/* ------------------------------------------------------------------- the run */

try {
  await req("session/hello", { clientName: "apr" });
  await req("project/new", {});
  const added = await req("cmd/track.add", { kind: "audio", name: "Audio 1" });
  if (!added.ok) die(2, "could not add a track: " + JSON.stringify(added.error));
  const trackId = added.payload.track.id;

  let disagreements = 0;
  for (const c of CASES) {
    const set = await req("cmd/automation.set", {
      trackId, paramRef: c.ref, add: [{ beat: 0, value: 0.5 }],
    });
    const ramp = await req("cmd/automation.ramp", {
      trackId, paramRef: c.ref, fromBeat: 0, toBeat: 4, fromValue: 0, toValue: 1,
    });
    const clear = await req("cmd/automation.clear", { trackId, paramRef: c.ref });

    const verdicts = [set.ok, ramp.ok, clear.ok];
    const agree = verdicts.every((v) => v === verdicts[0]);
    if (!agree) disagreements++;
    report(
      `all three commands agree on ${JSON.stringify(c.ref)}`,
      agree,
      agree ? `all ${verdicts[0] ? "accept" : "reject"}`
            : `set=${set.ok} ramp=${ramp.ok} clear=${clear.ok} — THE GRAMMAR HAS DRIFTED`,
    );
    report(
      `${JSON.stringify(c.ref)} is ${c.accept ? "accepted" : "rejected"} (${c.why})`,
      set.ok === c.accept,
      set.ok === c.accept ? "" : `set returned ok=${set.ok} ${set.error?.message ?? ""}`,
    );
  }

  // Acceptance has to mean a lane actually exists, not merely that nothing errored.
  await req("cmd/automation.set", { trackId, paramRef: "cc:74", add: [{ beat: 1, value: 0.25 }] });
  const hello = await req("session/hello", { clientName: "apr" });
  const track = (hello.payload.project?.tracks ?? []).find((t) => t.id === trackId);
  const lane = (track?.automation ?? []).find((l) => l.paramRef === "cc:74");
  report(
    "an accepted cc: lane is really in the project",
    !!lane && (lane.points ?? []).length > 0,
    lane ? `${(lane.points ?? []).length} point(s)` : `lanes=${JSON.stringify((track?.automation ?? []).map((l) => l.paramRef))}`,
  );

  if (disagreements === 0)
    console.log("\nnote: \"send:\" and \"plugin:\" match by PREFIX, so \"send:abc\" is accepted and " +
                "then evaluates as Invalid. Pinned deliberately — tighten it as a decision, not by accident.");
} catch (e) {
  report("harness completed", false, e?.message ?? String(e));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
