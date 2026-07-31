#!/usr/bin/env node
/**
 * ui-smoke — a browser smoke suite for MyDAW.
 *
 *   node scripts/ui-smoke.mjs [--slot N] [--filter substr] [--headful] [--keep]
 *
 * Opens ONE slot (engine + Chrome + fixture, see scripts/ui-drive.mjs), runs every
 * check in order against it, prints one line per check, and exits non-zero if any
 * check failed or errored. `--keep` leaves the slot running for post-mortem
 * poking; `--filter` matches the check id, title or area.
 *
 * The slot is the expensive part (~10 s), a check is cheap, so the suite pays for
 * the browser once and reuses it — the reason ui-drive grew an API alongside its
 * CLI. Between checks the runner calls s.reload(), so no check can inherit
 * another's DOM, selection or open dialog.
 *
 * ------------------------------------------------------------ WRITING A CHECK
 *
 *   { id: "bars-1based", title: "...", area: "transport",
 *     guards: "the commit or bug this protects",
 *     run: async (s, t) => { ... } }
 *
 * A check FAILS by throwing (any assertion or unexpected error) and PASSES by
 * returning. `s` is the Slot; `t` is the assert helper (t.eq/t.ok/t.near/t.match).
 * A check that cannot run — feature absent, needs a real audio device — must
 * `throw new SkipError("why")`; that reports SKIP and does not fail the run.
 *
 * Rules that came out of the last browser test pass, all of them paid for:
 *
 * - REACT DOES NOT FLUSH SYNCHRONOUSLY. Never assert in the same eval that
 *   performed the action; act, then `await s.untilEval(...)` for the consequence.
 * - The reload only resets the UI. The ENGINE keeps its project, transport
 *   position, loop and selection across a reload, so a check must establish its
 *   own preconditions (locate to 0, add the track it needs) instead of assuming
 *   a virgin session.
 * - Prefer trusted input (s.key/s.click/s.drag) over events dispatched from eval;
 *   only trusted events carry what a real keyboard layout sends.
 * - Canvas surfaces (clips, ruler, notes, waveforms) have NO accessibility nodes:
 *   locate by geometry from getBoundingClientRect, assert via getImageData.
 * - Menu-strip items are icon-only — match by aria-label ("File", "View", ...);
 *   menu entries are `div.ctx-item` matched by exact text.
 * - Bars are 1-based in the UI ("1.1.000" at project start); the wire is 0-based.
 * - Engine truth comes from s.probe(); replies correlate on replyTo.
 * - Toasts auto-dismiss (~5 s info / 10 s error): install a MutationObserver
 *   BEFORE the action, never poll for one afterwards.
 * - No sleeps as synchronisation, and no assertions on absolute pixel positions —
 *   the viewport is whatever Chrome gave us. Assert on relative geometry, engine
 *   state or DOM facts.
 * - A page function passed to s.eval is stringified: it has no closure over the
 *   check's variables. Interpolate what it needs into the source.
 */

import { pathToFileURL } from "node:url";
import { openSlot } from "./ui-drive.mjs";

/* ------------------------------------------------------------------ helpers */

/** Thrown by a check that cannot run here. Reports SKIP, never fails the run. */
export class SkipError extends Error {
  constructor(why) { super(why); this.name = "SkipError"; }
}

export class AssertionError extends Error {
  constructor(msg) { super(msg); this.name = "AssertionError"; }
}

const show = (v) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

/** The whole assertion vocabulary. Every failure names the label and both values. */
export const t = {
  ok(cond, label) {
    if (!cond) throw new AssertionError(`${label}: expected truthy, got ${show(cond)}`);
  },
  eq(actual, expected, label) {
    const same = actual === expected || (actual !== null && typeof actual === "object" && show(actual) === show(expected));
    if (!same) throw new AssertionError(`${label}: expected ${show(expected)}, got ${show(actual)}`);
  },
  near(actual, expected, tol, label) {
    if (typeof actual !== "number" || !Number.isFinite(actual))
      throw new AssertionError(`${label}: expected a number near ${expected}, got ${show(actual)}`);
    if (Math.abs(actual - expected) > tol)
      throw new AssertionError(`${label}: expected ${expected} ±${tol}, got ${actual} (off by ${(actual - expected).toFixed(4)})`);
  },
  match(str, regex, label) {
    if (typeof str !== "string" || !regex.test(str))
      throw new AssertionError(`${label}: expected ${regex} to match ${show(str)}`);
  },
};

/* ------------------------------------------------------------------- checks */

export const checks = [
  {
    id: "mount-clean",
    title: "the app mounts with no console errors",
    area: "app",
    guards: "a mount-time throw or a React error boundary would otherwise let every DOM check pass against a half-dead page",
    run: async (s, tt) => {
      // reload() clears the console buffer at the document boundary, so what is left
      // afterwards belongs to THIS mount — no matter where this check runs in the suite.
      await s.reload();

      // The page really is the app, not an error boundary that swallowed it. Asserted
      // BEFORE the console is read: reload() returns as soon as the app mounts, and the
      // interesting logs come from the render that follows it (waveforms, meters, the
      // project arriving). Reading the buffer first only ever saw an empty page.
      const dom = await s.eval(() => ({
        root: document.querySelector("#root")?.childElementCount ?? 0,
        headers: document.querySelectorAll(".tlh-row").length,
        transport: !!document.querySelector(".tb-pos-main"),
        status: document.querySelector(".sb-dot")?.dataset.ok ?? null,
      }));
      tt.ok(dom.root > 0, "#root has children");
      tt.ok(dom.transport, "transport position readout is present");
      tt.eq(dom.status, "true", "status bar reports the engine connected");
      tt.ok(dom.headers >= 4, `fixture track headers rendered (got ${dom.headers})`);

      // Waveform peaks are the last thing to load and the only fetch that used to race
      // this check; openSlot's fixture now blocks until they exist, so a peaks 404 here
      // is a real regression rather than the timing artefact it once was.
      const errs = s.consoleErrors();
      tt.eq(errs.length, 0, `console errors during mount [${errs.map((e) => `${e.source}: ${e.text}`).join(" | ")}]`);
    },
  },

  {
    id: "bars-1based",
    title: 'the transport reads "1.1.000" at beat 0 and typing "3.1.000" locates to 0:04.000',
    area: "transport",
    guards: "f9a5309/1314840 — the engine keys timeSigMap by a 0-BASED bar and lib/time.ts assumed 1-based, so beat 0 read '0.1.000' and typing a bar located one bar early",
    run: async (s, tt) => {
      // The engine survives the reload, so the playhead is wherever the last check
      // left it — put it back at the project start rather than assuming.
      await s.probe("transport/locate", { beat: 0 });
      await s.untilEval("readout returns to the project start", () =>
        document.querySelector(".tb-pos-main")?.textContent === "1.1.000");

      const start = await s.eval(() => ({
        bars: document.querySelector(".tb-pos-main")?.textContent,
        time: document.querySelector(".tb-pos-sub")?.textContent,
      }));
      tt.eq(start.bars, "1.1.000", "bars.beats.ticks at beat 0");
      tt.eq(start.time, "0:00.000", "seconds readout at beat 0");

      // Double-click the readout to type a location. Geometry, not coordinates: the
      // window size is whatever Chrome handed us.
      const box = await s.eval(() => {
        const el = document.querySelector(".tb-pos-main");
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await s.click(box.x, box.y, { clicks: 2 });
      await s.untilEval("locate field opens", () => !!document.querySelector("input.tb-pos-input"));

      // The field opens with its text selected, so typing replaces it.
      await s.type("3.1.000");
      await s.key("Enter");

      await s.untilEval("readout follows the locate", () =>
        document.querySelector(".tb-pos-main")?.textContent === "3.1.000");
      const after = await s.eval(() => document.querySelector(".tb-pos-sub")?.textContent);
      tt.eq(after, "0:04.000", "bar 3 is 8 beats = 4 s at 120 bpm");

      // And the engine agrees — the readout could be lying on its own.
      const reply = await s.probe("transport/pause");
      tt.near(reply.payload.beat, 8, 1e-6, "engine playhead after locating to bar 3");
    },
  },

  {
    id: "cycle-wraps",
    title: "a 0..8 beat cycle wraps at the right locator instead of running past it",
    area: "transport",
    guards: "f9a5309 — nextSpans() only split a block when pos < le && pos+frames > le, so a BLOCK-ALIGNED loop end (8 beats at 120bpm/48k is exactly 3000 x 64 frames — the default cycle) never wrapped",
    run: async (s, tt) => {
      await s.probe("cmd/loop.set", { startBeat: 0, endBeat: 8, enabled: true });
      await s.probe("transport/locate", { beat: 0 });
      try {
        await s.probe("transport/play");
        // Sample the readout in the page: 6 s at 120 bpm is 1.5 cycles, so a healthy
        // loop must turn over at least once and never show more than the 4 s locator.
        const samples = await s.eval(`(async () => {
          const out = [];
          await new Promise((done) => {
            const t0 = Date.now();
            const iv = setInterval(() => {
              out.push(document.querySelector('.tb-pos-sub')?.textContent ?? '');
              if (Date.now() - t0 >= 6000) { clearInterval(iv); done(); }
            }, 50);
          });
          return out;
        })()`, { timeoutMs: 30000 });

        const secs = samples
          .map((s0) => /^(\d+):(\d\d)\.(\d\d\d)$/.exec(s0))
          .filter(Boolean)
          .map((m) => Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000);
        tt.ok(secs.length > 40, `sampled the position readout (${secs.length} of ${samples.length} parsed)`);
        tt.ok(Math.max(...secs) > 1, `the transport actually moved (max ${Math.max(...secs)}s)`);

        const back = secs.filter((v, i) => i > 0 && v < secs[i - 1] - 0.05).length;
        tt.ok(back >= 1, `cycle wrapped back to the left locator at least once (${back} backward steps, max ${Math.max(...secs)}s)`);
        // 4.0 s is the locator; allow one block of overshoot in the readout.
        tt.ok(Math.max(...secs) <= 4.1, `never played past the right locator (max ${Math.max(...secs)}s, locator 4.000s)`);
      } finally {
        await s.probe("transport/stop");
        await s.probe("cmd/loop.set", { startBeat: 0, endBeat: 8, enabled: false });
      }
    },
  },

  {
    id: "dirty-survives-reload",
    title: "the unsaved-changes marker survives a reload",
    area: "project",
    guards: "f9a5309 — dirty lived client-side and HelloReply never carried it, so a reloaded tab believed a dirty project was clean and autoSaveIfDirty() then skipped the save-before-replace (real data loss)",
    run: async (s, tt) => {
      await s.probe("cmd/track.add", { kind: "midi", name: "Dirty Marker" });
      await s.untilEval("title marks unsaved changes before the reload", () =>
        document.title.startsWith("●") && !!document.querySelector(".sb-dirty"));

      await s.reload();

      // The engine still holds the unsaved edit; the fresh client must be told.
      await s.untilEval("title still marks unsaved changes after the reload", () =>
        document.title.startsWith("●"));
      const after = await s.eval(() => ({
        title: document.title,
        dirty: !!document.querySelector(".sb-dirty"),
      }));
      tt.match(after.title, /^● /, "window title keeps its dirty bullet after a reload");
      tt.ok(after.dirty, "status bar keeps its .sb-dirty marker after a reload");
    },
  },
];

/* ------------------------------------------------------------------- runner */

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const PAD = 26;
const line = (verdict, c, ms, msg) =>
  console.log(
    `${verdict.padEnd(4)} ${c.id.padEnd(PAD)} ${String(ms).padStart(5)}ms  ${c.title}` +
    (msg ? `\n       ${msg.replace(/\n/g, "\n       ")}` : ""),
  );

async function main() {
  // Slot 8 by default: hand-driven ui-drive slots live at 1..4, and the suite must
  // never kill a slot someone is debugging in.
  const slot = Number(arg("slot", "8"));
  const filter = arg("filter", "");
  const picked = filter
    ? checks.filter((c) => [c.id, c.title, c.area].some((f) => f.toLowerCase().includes(filter.toLowerCase())))
    : checks;
  if (picked.length === 0) {
    console.log(`no checks match --filter ${filter}`);
    process.exit(1);
  }

  console.log(`ui-smoke: ${picked.length} check(s) on slot ${slot}${filter ? ` (filter "${filter}")` : ""}`);
  const t0 = Date.now();
  const s = await openSlot({ slot, fixture: true, headful: flag("headful") });
  console.log(`slot up in ${((Date.now() - t0) / 1000).toFixed(1)}s — engine ${s.enginePort}, debug ${s.debugPort}\n`);

  let pass = 0, fail = 0, skip = 0;
  try {
    for (let i = 0; i < picked.length; i++) {
      const c = picked[i];
      // No check may inherit another's DOM. The engine state is NOT reset — checks
      // establish their own preconditions.
      if (i > 0) {
        try {
          await s.reload();
        } catch (e) {
          fail++;
          line("FAIL", c, 0, `could not reload between checks: ${e.message}`);
          continue;
        }
      }
      const t1 = Date.now();
      try {
        await c.run(s, t);
        pass++;
        line("PASS", c, Date.now() - t1);
      } catch (e) {
        if (e instanceof SkipError || e?.name === "SkipError") {
          skip++;
          line("SKIP", c, Date.now() - t1, e.message);
        } else {
          fail++;
          const detail = e?.name === "AssertionError" ? e.message : `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;
          line("FAIL", c, Date.now() - t1, detail);
        }
      }
    }
  } finally {
    if (flag("keep")) {
      s.detach();
      console.log(`\nslot ${slot} left up: ${s.url} (node scripts/ui-drive.mjs down --slot ${slot})`);
    } else {
      await s.close();
    }
  }

  console.log(
    `\n${pass}/${picked.length} passed` +
    (fail ? `, ${fail} failed` : "") +
    (skip ? `, ${skip} skipped` : "") +
    ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  process.exit(fail > 0 ? 1 : 0);
}

// Importing this file (for SkipError, `t` or `checks`) must not run the suite.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`ui-smoke: ${e?.stack ?? e}`);
    process.exit(1);
  });
}
