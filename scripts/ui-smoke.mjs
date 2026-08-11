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
 * - s.until vs s.untilEval is the same trap wearing a different hat. untilEval
 *   runs its predicate IN THE PAGE (stringified, no closure); until runs it here
 *   in Node, so it can await s.probe() and see the check's own variables. Waiting
 *   on engine state with untilEval raises a ReferenceError on every poll — which
 *   waitFor now reports, instead of blaming whatever you were waiting for.
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";
import { openSlot } from "./ui-drive.mjs";

const SMOKE_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

/** Newest mtime anywhere under `dir` (0 when it does not exist). */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = nodePath.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

/**
 * `ui/dist` is GITIGNORED, so this suite tests whatever was last built — NOT `ui/src`.
 *
 * Paid for on 2026-08-10: a whole session's "ui-smoke is green" was testing an hours-old
 * bundle. Rebuilding dist immediately exposed 7 real failures that had been sitting on
 * main the entire time. A green run against a stale bundle is not weak evidence, it is a
 * lie about current source — so refuse to run instead of printing a comforting number.
 * `--allow-stale-dist` opts out when testing the old bundle is genuinely what you want.
 */
function refuseIfDistIsStale() {
  const src = newestMtime(nodePath.join(SMOKE_ROOT, "ui", "src"));
  const dist = newestMtime(nodePath.join(SMOKE_ROOT, "ui", "dist"));
  if (dist === 0 || src <= dist) return;
  const ageMin = Math.round((src - dist) / 60000);
  console.log(
    `ui-smoke: REFUSING TO RUN — ui/dist is ${ageMin} min older than ui/src.\n` +
    `  This suite serves ui/dist, so it would test a bundle that predates your changes\n` +
    `  and report green regardless of them.\n` +
    `  Fix:  cd ui && npm run build     (retry on vite's emptyDir error — see BUILDING.md)\n` +
    `  Override, if you really mean it:  --allow-stale-dist`,
  );
  process.exit(2);
}

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
      // Track headers render only after the hello project arrives — under load a bare
      // eval here read an empty list (same race as automation-lanes, hit in gate runs).
      await s.untilEval("the fixture's track headers render", () =>
        document.querySelectorAll(".tlh-row").length >= 4);
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

  {
    id: "layout-slot-save",
    title: "Ctrl+Alt+Shift+1 saves a layout slot",
    area: "menus-layout",
    guards: "1314840 — the handler compared e.key against \"1\"..\"4\", but Shift turns those into \"!@#$\" on a US layout, so the SAVE half of the layout shortcut was dead on real hardware; it keys off e.code now. Only reachable through trusted input: the MCP's synthetic press_key reported key:\"1\" and passed the dead shortcut",
    run: async (s, tt) => {
      // Own precondition: the slots pref survives a reload, so clear it and remount
      // rather than assuming this is the first check to touch it.
      await s.eval(() => { localStorage.removeItem("mydaw.layouts.slots"); return true; });
      await s.reload();
      tt.eq(await s.eval(() => localStorage.getItem("mydaw.layouts.slots")), null,
        "layout slots start empty");

      await s.key("Control+Alt+Shift+1");
      await s.untilEval("slot 1 is written", () => {
        const raw = localStorage.getItem("mydaw.layouts.slots");
        if (!raw) return false;
        const s0 = JSON.parse(raw)[0];
        return !!(s0 && s0.panels && s0.sizes);
      });

      const slots = await s.eval(() => JSON.parse(localStorage.getItem("mydaw.layouts.slots")));
      tt.eq(slots.length, 4, "four slots are kept");
      tt.ok(slots[1] === null && slots[2] === null && slots[3] === null,
        `only slot 1 was written (got ${JSON.stringify(slots.map((x) => x && x.name))})`);
      // A real snapshot, not a stub — it has to carry back the panel state and the
      // pane sizes, or applying it later restores nothing.
      tt.ok(typeof slots[0].name === "string" && slots[0].name.length > 0, "slot 1 carries a name");
      tt.ok(typeof slots[0].panels.bottomTab !== "undefined", "the snapshot records the dock tab");
      tt.ok(typeof slots[0].sizes.browserW === "number", "the snapshot records pane sizes");
    },
  },

  {
    id: "shell-modes",
    title: "the UI shell switches Classic → Ribbon → Workspaces → Classic through each shell's own switcher",
    area: "shell",
    guards: "docs/UI_ALTERNATIVES_PLAN.md — every shell must offer the way OUT of itself (View → UI Mode / ribbon View category); a shell that renders without its switcher strands the user in it, and a broken classic restore would trash the default workspace",
    run: async (s, tt) => {
      // Own precondition: the mode pref survives reloads — start from a clean classic.
      await s.eval(() => { localStorage.removeItem("mydaw.ui.shellMode"); return true; });
      await s.reload();
      tt.eq(await s.eval(() => document.querySelector(".app-frame")?.dataset.shell ?? null),
        "classic", "default shell is classic");

      // Menu / ribbon entries carry shortcut hints in their textContent, so match by
      // prefix, not equality.
      const clickStarts = async (selector, text) => {
        const box = await s.eval(`(() => {
          const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((i) => i.textContent.trim().startsWith(${JSON.stringify(text)}));
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`);
        if (!box) throw new AssertionError(`not found: ${selector} starting with ${JSON.stringify(text)}`);
        await s.click(box.x, box.y);
      };
      // NB: a STRING predicate is evaluated verbatim (only functions get auto-called),
      // so it must be an invoked IIFE or untilEval polls a function object forever.
      const shellIs = (mode) =>
        s.untilEval(`shell is ${mode}`, `(() =>
          document.querySelector(".app-frame")?.dataset.shell === ${JSON.stringify(mode)})()`);

      // classic → ribbon via the menu strip's View ▸ UI Mode
      await clickStarts('[role="menuitem"][aria-label="View"]', "");
      await s.untilEval("View menu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim().startsWith("UI Mode")));
      await clickStarts(".ctx-item", "UI Mode");
      await s.untilEval("UI Mode submenu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim().startsWith("Ribbon")));
      await clickStarts(".ctx-item", "Ribbon");
      await shellIs("ribbon");
      tt.ok(await s.eval(() => !!document.querySelector(".rib-groups .rib-btn")),
        "the ribbon renders contextual command buttons");
      tt.ok(await s.eval(() => !!document.querySelector(".sp-head .sp-pick")),
        "the split work area has a pane picker");

      // ribbon → workspaces via the ribbon's own View category (its way out)
      await clickStarts(".rib-tab", "View");
      await s.untilEval("View category shows its groups", () =>
        [...document.querySelectorAll(".rib-btn")].some((b) => b.textContent.trim().startsWith("UI Mode")));
      await clickStarts(".rib-btn", "UI Mode");
      await s.untilEval("UI Mode menu opens from the ribbon", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim().startsWith("Workspaces")));
      await clickStarts(".ctx-item", "Workspaces");
      await shellIs("workspaces");
      const strip = await s.eval(() => ({
        tabs: [...document.querySelectorAll(".ws-tab")].map((b) => b.textContent.trim()),
        active: document.querySelector('.ws-tab[data-on="true"]')?.textContent.trim() ?? null,
        leafHeads: document.querySelectorAll(".ws-leaf .sp-head").length,
      }));
      tt.eq(strip.tabs.length, 4, `stock workspaces seeded (got ${JSON.stringify(strip.tabs)})`);
      tt.ok(strip.active !== null, "one workspace is active");
      tt.ok(strip.leafHeads >= 1, "the active workspace renders at least one pane tile");

      // workspaces → classic via the (kept) menu strip
      await clickStarts('[role="menuitem"][aria-label="View"]', "");
      await s.untilEval("View menu opens again", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim().startsWith("UI Mode")));
      await clickStarts(".ctx-item", "UI Mode");
      await s.untilEval("UI Mode submenu opens again", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim().startsWith("Classic")));
      await clickStarts(".ctx-item", "Classic");
      await shellIs("classic");

      // Classic came back intact: the dock and its tabs render, and the mode persisted.
      tt.ok(await s.eval(() => !!document.querySelector(".app-dock .app-dock-tabs")),
        "classic bottom dock is back");
      tt.eq(await s.eval(() => JSON.parse(localStorage.getItem("mydaw.ui.shellMode"))),
        "classic", "the mode pref persisted");
    },
  },

  {
    id: "corner-mute-solo-all",
    title: "the Tracks-corner M/S buttons mute/solo every channel at once (and back)",
    area: "track-headers",
    guards: "global M = group toggle over every non-view-row track; S doubles as clear-all-solos — a drifted filter would silently mute view rows or skip buses",
    run: async (s, tt) => {
      const tracksState = async () => {
        const p = (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
        const rows = p.tracks.filter((t) => !["marker", "arranger", "chord", "transpose"].includes(t.kind));
        return { rows, allMuted: rows.every((t) => t.mute), anyMuted: rows.some((t) => t.mute),
                 anySolo: rows.some((t) => t.solo), allSolo: rows.every((t) => t.solo) };
      };
      // own precondition: start from nothing muted/soloed
      const st0 = await tracksState();
      for (const t of st0.rows) await s.probe("cmd/track.set", { trackId: t.id, patch: { mute: false, solo: false } });

      const cornerBtn = async (text) => {
        const box = await s.eval(`(() => {
          const el = [...document.querySelectorAll(".tl-corner .tlh-btn")]
            .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`);
        if (!box) throw new AssertionError(`corner button not found: ${text}`);
        await s.click(box.x, box.y);
      };

      await cornerBtn("M");
      await s.until("all channels muted", async () => (await tracksState()).allMuted);
      await cornerBtn("M");
      await s.until("all channels unmuted again", async () => !(await tracksState()).anyMuted);

      await cornerBtn("S");
      await s.until("all channels soloed", async () => (await tracksState()).allSolo);
      await cornerBtn("S");
      await s.until("solos cleared", async () => !(await tracksState()).anySolo);
      tt.ok(true, "M/S round-trips over every mixer track");
    },
  },

  {
    id: "track-w-arms-and-reveals",
    title: "the track's W button arms automation write and the recorded lane reveals itself",
    area: "track-headers",
    guards: "SPEC §5.4 — the reported confusion (2026-08-10) was pressing 'A' (which only SHOWS lanes) and getting nothing: W must arm THIS track with the transport pencil off, and a written lane must open its track so the move is visible without hunting for it",
    run: async (s, tt) => {
      const project = async () => (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
      const laneRows = () => s.eval(`document.querySelectorAll("[data-lane-ref], .tlh-lane").length`);
      const trackId = (await project()).tracks[0].id;

      // Own preconditions: global (master) arm OFF, this track un-armed, stopped at 0.
      await s.probe("transport/setAutomationWrite", { enabled: false });
      await s.probe("cmd/track.set", { trackId, patch: { automationWrite: false } });
      await s.probe("transport/stop", {});
      await s.probe("transport/locate", { beat: 0 });
      const lanesBefore = await laneRows();

      const wBox = await s.eval(`(() => {
        const el = [...document.querySelectorAll(".tlh-btn")].find((b) => b.textContent.trim() === "W");
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`);
      if (!wBox) throw new AssertionError("no W button in the track headers");
      await s.click(wBox.x, wBox.y);
      await s.until("W arms the track in the engine", async () =>
        (await project()).tracks.find((t) => t.id === trackId)?.automationWrite === true);

      // With ONLY the per-track arm on, a fader move must record.
      await s.probe("transport/play", {});
      for (const v of [0.4, 0.7]) {
        await s.probe("cmd/track.set", { trackId, patch: { volume: v } });
        await new Promise((r) => setTimeout(r, 220));
      }
      await s.probe("transport/stop", {});
      await s.until("the volume lane got points", async () => {
        const t = (await project()).tracks.find((x) => x.id === trackId);
        return (t?.automation?.find((l) => l.paramRef === "volume")?.points?.length ?? 0) >= 2;
      });
      await s.until("the written lane revealed itself", async () => (await laneRows()) > lanesBefore);
      tt.ok(true, "W armed one track with the master arm off, and its lane opened on its own");

      // RESTORE. This check is unusual: succeeding CHANGES THE LAYOUT (a revealed lane adds
      // a row, shifting every track below it). Left behind, it silently broke every later
      // coordinate-driven check in the suite — so put the rig back exactly as it was found.
      await s.probe("cmd/track.set", { trackId, patch: { automationWrite: false, volume: 1.0 } });
      await s.probe("cmd/automation.clear", { trackId, paramRef: "volume" });
      const aBox = await s.eval(`(() => {
        const el = [...document.querySelectorAll(".tlh-btn")].find((b) => b.textContent.trim() === "A");
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`);
      if (aBox) await s.click(aBox.x, aBox.y); // collapse the lanes this check revealed
      await s.until("the rig is back to its original row layout",
        async () => (await laneRows()) === lanesBefore);
    },
  },

  {
    id: "keep-takes-toggle",
    title: "the Keep Takes transport toggle arms the engine's record-to-lanes mode",
    area: "transport",
    guards: "Lanes feature 2026-08-11 — recording over existing material folds into take lanes only while this arm is on; the toggle must exist beside the automation pencil and be engine-authoritative",
    run: async (s, tt) => {
      const box = await s.eval(`(() => {
        const el = [...document.querySelectorAll("button")]
          .find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Keep takes"));
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`);
      tt.ok(box, "the Keep Takes toggle renders in the transport bar");
      // Own precondition: force OFF over the wire, then click ON via the UI.
      await s.probe("transport/setKeepTakes", { enabled: false });
      await s.click(box.x, box.y);
      await s.until("the engine arms Keep Takes", async () =>
        (await s.probe("session/hello", { clientName: "smoke" })).payload.keepTakes === true);
      tt.ok(true, "clicking the toggle arms the engine");
      // RESTORE: the arm persists in engine settings — leave it off for later checks/slots.
      await s.probe("transport/setKeepTakes", { enabled: false });
    },
  },

  {
    id: "plugins-pane-instrument-mode",
    title: "the Browser plugins pane defaults to Instruments and Effects mode groups by category",
    area: "browser",
    guards: "VST revision 2026-08-11 — the pane was 94% effects (2,602 vs 174) with instruments buried; Instruments must be the default mode, Effects one click away, and searching must pierce the mode wall",
    run: async (s, tt) => {
      // Own precondition: the Browser open on the Plugins tab.
      await s.probe("ui/entity.reveal", { pane: "browser" }, { allowError: true }).catch(() => {});
      const openPluginsTab = async () => {
        const box = await s.eval(`(() => {
          const el = [...document.querySelectorAll(".browser-tabs button, [role=tab]")]
            .find((b) => b.textContent.trim() === "Plugins");
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`);
        if (box) await s.click(box.x, box.y);
      };
      await openPluginsTab();
      await s.until("the mode row renders", async () =>
        (await s.eval(`document.querySelectorAll(".browser-mode-btn").length`)) === 3);

      const active = await s.eval(
        `document.querySelector(".browser-mode-btn.active")?.textContent.trim() ?? ""`);
      tt.eq(active, "Instruments", "Instruments is the default mode");

      // Switch to Effects; with category grouping the labels are normalized (no "Fx|").
      await s.eval(`(() => { [...document.querySelectorAll(".browser-mode-btn")]
        .find((b) => b.textContent.trim() === "Effects").click(); return true; })()`);
      await s.until("effects mode active", async () =>
        (await s.eval(`document.querySelector(".browser-mode-btn.active")?.textContent.trim()`)) === "Effects");
      tt.ok(true, "Effects mode is one click away");

      // RESTORE the pref-persisted mode (checks share localStorage across reloads).
      await s.eval(`(() => { [...document.querySelectorAll(".browser-mode-btn")]
        .find((b) => b.textContent.trim() === "Instruments").click(); return true; })()`);
      await s.until("mode restored", async () =>
        (await s.eval(`document.querySelector(".browser-mode-btn.active")?.textContent.trim()`)) === "Instruments");
    },
  },

  {
    id: "plugin-manager-health-view",
    title: "the Plugin Manager's Health view classifies failures and opens a per-file detail",
    area: "plugin-manager",
    guards: "VST revision 2026-08-11 — 2,616 of 2,673 cache 'failures' are benign support DLLs; the Health view must show the bounded real-problem set (chips from plugins/getHealth.summary) and a detail with the rescan-with-trace/reveal/relocate actions, not the raw dump",
    run: async (s, tt) => {
      const base = await s.eval(`location.origin + location.pathname`);
      try {
        await s.send("Page.navigate", { url: `${base}?page=plugins` });
        await s.until("the manager page mounts", async () =>
          (await s.eval(`!!document.querySelector(".pm-title")`)) === true, { timeout: 30000 });
        await s.eval(`(() => { [...document.querySelectorAll(".pm-view-btn")]
          .find(b => b.textContent.trim() === "Health").click(); return true; })()`);
        await s.until("the health view loads its summary", async () =>
          (await s.eval(`document.querySelectorAll(".pm-health .pm-chip").length`)) >= 4);
        const chips = await s.eval(`[...document.querySelectorAll(".pm-health .pm-chip")].map(c => c.textContent.trim())`);
        tt.ok(chips.some((c) => c.startsWith("Problems")), `summary chips render (${chips.join(", ")})`);

        // A detail opens when any row exists (a fresh slot may have zero problems — the
        // empty state is then the correct render, not a failure).
        const rows = await s.eval(`document.querySelectorAll(".pm-health .pm-row-click").length`);
        if (rows > 0) {
          await s.eval(`(() => { document.querySelector(".pm-health .pm-row-click").click(); return true; })()`);
          await s.until("the detail panel opens", async () =>
            (await s.eval(`!!document.querySelector(".pm-health-detail")`)) === true);
          const actions = await s.eval(`[...document.querySelectorAll(".pm-detail-actions .pm-btn")].map(b => b.textContent.trim())`);
          tt.ok(actions.includes("Rescan with trace") && actions.includes("Relocate…"),
            `detail actions present (${actions.join(", ")})`);
        } else {
          tt.ok(await s.eval(`!!document.querySelector(".pm-health .pm-empty")`),
            "no problems on this slot — the empty state renders");
        }
      } finally {
        // RESTORE: the runner reloads the CURRENT url between checks — left on
        // ?page=plugins, every later check would run against the manager page.
        await s.send("Page.navigate", { url: base });
        await s.until("the DAW app is back", async () =>
          (await s.eval(`!!document.querySelector(".tl-corner")`)) === true, { timeout: 30000 });
      }
    },
  },

  {
    id: "technique-master-glue",
    title: "the Production Techniques wizard applies Master Glue stages and takes the last one back",
    area: "techniques",
    guards: "docs/PRODUCTION_TECHNIQUES_PLAN.md — Apply must create REAL engine inserts with dialed params (not UI state), and Take Back must undo exactly the stage's commands; a drifted undo count would silently eat the user's own edits",
    run: async (s, tt) => {
      const insertsOnMaster = async () =>
        (await s.probe("session/hello", { clientName: "smoke" })).payload.project.masterTrack.inserts;
      const before = await insertsOnMaster();

      // The 40-technique browser scrolls (72vh modal body): scroll the target into
      // view BEFORE measuring, or the click lands on whatever covers that Y.
      const clickStarts = async (selector, text) => {
        const box = await s.eval(`(() => {
          const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((i) => i.textContent.trim().startsWith(${JSON.stringify(text)}));
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`);
        if (!box) throw new AssertionError(`not found: ${selector} starting with ${JSON.stringify(text)}`);
        await s.click(box.x, box.y);
      };

      // Project ▸ Production Techniques… → the wizard's card browser
      await clickStarts('[role="menuitem"][aria-label="Project"]', "");
      await s.untilEval("Project menu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim().startsWith("Production Techniques")));
      await clickStarts(".ctx-item", "Production Techniques");
      // The Guide is the landing view now (plan doc §0 step 2) — the card browser is behind it.
      await s.untilEval("the Production Guide lands first", () => !!document.querySelector(".tech-guide"));
      await clickStarts(".tech-guide-browse", "Browse all techniques");
      await s.untilEval("technique cards render", () =>
        document.querySelectorAll(".tech-card").length >= 10);
      await clickStarts(".tech-card", "Master Glue Chain");
      await s.untilEval("wizard shows the three stages", () =>
        document.querySelectorAll(".tech-stage").length === 3);

      // Stage 1 — Glue: a real compressor lands on the master with dialed params
      await clickStarts(".tech-stage.next .btn.primary", "Apply");
      await s.until("glue compressor inserted on the master", async () =>
        (await insertsOnMaster()).length === before.length + 1);
      const afterGlue = await insertsOnMaster();
      tt.eq(afterGlue[afterGlue.length - 1].uid, "builtin:compressor", "stage 1 added the stock compressor");

      // Stage 2 — Ceiling: limiter after it
      await s.untilEval("stage 2 becomes next", () =>
        document.querySelectorAll(".tech-stage")[1]?.classList.contains("next") === true);
      await clickStarts(".tech-stage.next .btn.primary", "Apply");
      await s.until("limiter inserted after the glue", async () =>
        (await insertsOnMaster()).length === before.length + 2);
      const afterCeil = await insertsOnMaster();
      tt.eq(afterCeil[afterCeil.length - 1].uid, "builtin:limiter", "stage 2 added the stock limiter");

      // The engine shows the limiter BEFORE the stage finishes (params still being set,
      // wizard still busy → buttons disabled, and stage 1's Take back is the one on
      // screen until then). Wait for the UI's own "applied" state or the click lands on
      // a disabled button and the confirm never opens (paid for: this check flaked).
      await s.untilEval("stage 2 shows applied in the wizard", () =>
        document.querySelectorAll(".tech-stage")[1]?.classList.contains("st-applied") === true);

      // Take back the LAST applied stage (the limiter) — confirm dialog, then engine undo ×N.
      // The confirm's button is .btn.danger — the STAGE's own "Take back" is a plain .btn
      // inside the same .modal-overlay tree, so match the danger class, not text alone.
      await clickStarts(".tech-stage .btn", "Take back");
      await s.untilEval("take-back confirm opens", () =>
        [...document.querySelectorAll(".modal-overlay .btn.danger")].some((b) =>
          b.textContent.trim() === "Take back"));
      await clickStarts(".modal-overlay .btn.danger", "Take back");
      await s.until("the limiter is undone, the glue stays", async () => {
        const now = await insertsOnMaster();
        return now.length === before.length + 1 &&
          now[now.length - 1].uid === "builtin:compressor";
      });

      // leave the project as found — undo the glue stage's commands engine-side
      // (6 param sets then the addPlugin; capped so a surprise undo stack can't spin)
      for (let n = 0; n < 12 && (await insertsOnMaster()).length > before.length; n++) {
        await s.probe("edit/undo", {});
      }
      tt.eq((await insertsOnMaster()).length, before.length, "master restored for later checks");
    },
  },

  {
    id: "technique-audition-ab",
    title: "the wizard's A/B audition really removes and restores the applied edits — and closing mid-Without auto-restores",
    area: "techniques",
    guards: "Omer 2026-08-07: 'the techniques are a mystery — let me HEAR them'. Without = undo×N / With = redo×N must be exact-state symmetric ON THE ENGINE (not UI state), stage actions must lock while in Without (a new command would truncate the redo tail and strand the With state), and closing the wizard mid-Without must auto-restore — otherwise audition becomes silent data loss",
    run: async (s, tt) => {
      const insertsOnMaster = async () =>
        (await s.probe("session/hello", { clientName: "smoke" })).payload.project.masterTrack.inserts;
      const before = await insertsOnMaster();

      const clickStarts = async (selector, text) => {
        const box = await s.eval(`(() => {
          const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((i) => i.textContent.trim().startsWith(${JSON.stringify(text)}));
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`);
        if (!box) throw new AssertionError(`not found: ${selector} starting with ${JSON.stringify(text)}`);
        await s.click(box.x, box.y);
      };

      // Open the wizard on Master Glue Chain and apply stage 1 (stock compressor).
      await clickStarts('[role="menuitem"][aria-label="Project"]', "");
      await s.untilEval("Project menu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim().startsWith("Production Techniques")));
      await clickStarts(".ctx-item", "Production Techniques");
      // The Guide is the landing view now (plan doc §0 step 2) — the card browser is behind it.
      await s.untilEval("the Production Guide lands first", () => !!document.querySelector(".tech-guide"));
      await clickStarts(".tech-guide-browse", "Browse all techniques");
      await s.untilEval("technique cards render", () =>
        document.querySelectorAll(".tech-card").length >= 10);
      await clickStarts(".tech-card", "Master Glue Chain");
      await s.untilEval("wizard shows the three stages", () =>
        document.querySelectorAll(".tech-stage").length === 3);
      await clickStarts(".tech-stage.next .btn.primary", "Apply");
      await s.until("glue compressor inserted on the master", async () =>
        (await insertsOnMaster()).length === before.length + 1);
      await s.untilEval("the audition A/B appears once something is applied", () =>
        !!document.querySelector(".tech-audition"));

      // The engine restores BEFORE the client's toggle batch resolves (until() polls
      // the engine), so wait for the wizard's own settled state before every click —
      // a click on the still-disabled button is a silent no-op.
      const settled = async (why) =>
        s.untilEval(why, () => document.querySelector(".tech-ab-without")?.disabled === false);

      // Without: the engine really loses the edits, and stage actions lock.
      await settled("audition controls are enabled");
      await clickStarts(".tech-ab-without", "Without");
      await s.until("Without removes the applied edits on the engine", async () =>
        (await insertsOnMaster()).length === before.length);
      const lockedApply = await s.eval(() =>
        document.querySelector(".tech-stage.next .btn.primary")?.disabled === true);
      tt.ok(lockedApply, "Apply is locked while hearing Without (redo tail must survive)");

      // With: the exact state comes back.
      await settled("controls settle in Without");
      await clickStarts(".tech-ab-with", "With");
      await s.until("With restores the applied edits", async () => {
        const now = await insertsOnMaster();
        return now.length === before.length + 1 &&
          now[now.length - 1].uid === "builtin:compressor";
      });

      // The leg that guards against silent loss: close the wizard while in Without —
      // the unmount cleanup must redo everything back on its own.
      await settled("controls settle back in With");
      await clickStarts(".tech-ab-without", "Without");
      await s.until("Without again before closing", async () =>
        (await insertsOnMaster()).length === before.length);
      await s.key("Escape");
      await s.until("closing mid-Without auto-restored the edits", async () =>
        (await insertsOnMaster()).length === before.length + 1);

      // leave the project as found (same cap rationale as technique-master-glue)
      for (let n = 0; n < 12 && (await insertsOnMaster()).length > before.length; n++) {
        await s.probe("edit/undo", {});
      }
      tt.eq((await insertsOnMaster()).length, before.length, "master restored for later checks");
    },
  },

  {
    id: "technique-guide-landing",
    title: "the Production Guide lands first, reads THIS project, and reacts when kick+bass appear",
    area: "techniques",
    guards: "plan doc §0 step 2 (Omer: 'unknown what should be used at what stage') — the guide must be the dialog's landing view, its relevance rules must read the LIVE project (kick+bass with no sidechain flips the goal to Suggested), and a goal must route into the wizard with a back-to-Guide path",
    run: async (s, tt) => {
      const clickStarts = async (selector, text) => {
        const box = await s.eval(`(() => {
          const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((i) => i.textContent.trim().startsWith(${JSON.stringify(text)}));
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`);
        if (!box) throw new AssertionError(`not found: ${selector} starting with ${JSON.stringify(text)}`);
        await s.click(box.x, box.y);
      };
      const goalStatus = () => s.eval(() =>
        document.querySelector('[data-goal="kick-bass"]')?.dataset.status ?? null);

      await clickStarts('[role="menuitem"][aria-label="Project"]', "");
      await s.untilEval("Project menu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim().startsWith("Production Techniques")));
      await clickStarts(".ctx-item", "Production Techniques");

      // Landing = the guide, all six stages, no card browser in sight.
      await s.untilEval("the guide renders its six stages", () =>
        document.querySelectorAll(".tech-guide-stage").length === 6);
      tt.eq(await s.eval(() => document.querySelectorAll(".tech-card").length), 0,
        "the jargon card browser is NOT the landing view");

      // The fixture has no kick/bass — the goal must say so, not nag.
      tt.eq(await goalStatus(), "na", "kick-bass reads 'not applicable' without the pair");

      // Create the pair over the wire: the guide must notice the LIVE project.
      const kick = (await s.probe("cmd/track.add", { kind: "midi", name: "Kick" })).payload.track;
      const bass = (await s.probe("cmd/track.add", { kind: "midi", name: "Bass 808" })).payload.track;
      try {
        await s.probe("cmd/clip.addMidi", { trackId: kick.id, startBeat: 0, lengthBeats: 4 });
        await s.probe("cmd/clip.addMidi", { trackId: bass.id, startBeat: 0, lengthBeats: 4 });
        await s.untilEval("kick+bass with no sidechain flips the goal to Suggested", () =>
          document.querySelector('[data-goal="kick-bass"]')?.dataset.status === "suggested");
        const note = await s.eval(() =>
          document.querySelector('[data-goal="kick-bass"] .tech-goal-note')?.textContent ?? "");
        tt.match(note, /Kick/, "the note quotes the actual track it found");

        // A goal routes into the wizard, and the wizard routes back to the Guide.
        await clickStarts('[data-goal="kick-bass"] .tech-goal-row', "");
        await s.untilEval("the goal expands to its means", () =>
          document.querySelectorAll('[data-goal="kick-bass"] .tech-goal-mean').length >= 2);
        await clickStarts('[data-goal="kick-bass"] .tech-goal-open', "Open");
        await s.untilEval("the technique wizard opens", () =>
          !!document.querySelector(".tech-wizard"));
        await s.untilEval("the wizard's back button points at the Guide", () =>
          document.querySelector(".tech-back")?.textContent.trim() === "Guide");
        await clickStarts(".tech-back", "Guide");
        await s.untilEval("back lands on the guide again", () =>
          !!document.querySelector(".tech-guide"));
      } finally {
        await s.probe("cmd/track.remove", { trackId: bass.id });
        await s.probe("cmd/track.remove", { trackId: kick.id });
      }
    },
  },

  {
    id: "add-audio-track-asks-mono-stereo-and-input",
    title: "Add Audio Track asks mono/stereo + input, and the Inspector can flip channels after",
    area: "timeline-tracks",
    guards: "Omer 2026-08-07: adding an audio channel must ask mono/stereo and WHICH input (mono 1 vs 2 on an interface). channels is add-time-only on cmd/track.add, so the dialog is the only honest place for it — and cmd/track.set gained `channels` so a mis-created track is fixable instead of being re-made",
    run: async (s, tt) => {
      const trackNamed = async (name) =>
        (await s.probe("session/hello", { clientName: "smoke" })).payload.project.tracks.find(
          (t) => t.name === name,
        );
      const clickStarts = async (selector, text) => {
        const box = await s.eval(`(() => {
          const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((i) => i.textContent.trim().startsWith(${JSON.stringify(text)}));
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`);
        if (!box) throw new AssertionError(`not found: ${selector} starting with ${JSON.stringify(text)}`);
        await s.click(box.x, box.y);
      };

      // Project ▸ Add Audio Track opens the dialog instead of adding immediately.
      await clickStarts('[role="menuitem"][aria-label="Project"]', "");
      await s.untilEval("Project menu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) =>
          i.textContent.trim().startsWith("Add Audio Track")));
      await clickStarts(".ctx-item", "Add Audio Track");
      await s.untilEval("the dialog opens with a mono/stereo choice", () =>
        [...document.querySelectorAll(".aat-seg .btn")].some((b) => b.textContent.trim() === "Mono"));

      // Name it, pick Mono, create.
      await s.type("Smoke Mono");
      await clickStarts(".aat-seg .btn", "Mono");
      await clickStarts(".aat-actions .btn.primary", "Add Track");
      await s.until("the mono track is created", async () => {
        const t = await trackNamed("Smoke Mono");
        return !!t && t.channels === 1;
      });
      const made = await trackNamed("Smoke Mono");
      tt.eq(made.kind, "audio", "it is an audio track");
      tt.eq(made.channels, 1, "the Mono choice reached the engine");

      try {
        // The Inspector's channels badge flips it afterwards (cmd/track.set channels).
        await s.probe("cmd/track.set", { trackId: made.id, patch: { channels: 2 } });
        await s.until("channels is editable after creation", async () =>
          (await trackNamed("Smoke Mono")).channels === 2);
        // ...and the engine refuses it where it is meaningless.
        const midi = (await s.probe("cmd/track.add", { kind: "midi", name: "Smoke Midi" })).payload.track;
        const bad = await s.probe(
          "cmd/track.set",
          { trackId: midi.id, patch: { channels: 1 } },
          { allowError: true },
        );
        tt.eq(bad.ok, false, "channels on a MIDI track is refused, not silently applied");
        await s.probe("cmd/track.remove", { trackId: midi.id });
      } finally {
        await s.probe("cmd/track.remove", { trackId: made.id });
      }
    },
  },

  {
    id: "instrument-swap-shows-busy",
    title: "the track's instrument dropdown shows a spinner and refuses re-clicks while loading",
    area: "timeline-tracks",
    guards: "Omer 2026-08-07: 'some can take time, add a small spinning thingy … so the user won't try to do the same action again thinking it didn't stick'. cmd/plugin.add does not reply until the plug-in finished init, so the new instanceId does not exist yet — store.pluginStates has nothing to show and the in-flight command is the only truth (instrumentAssign's busy registry)",
    run: async (s, tt) => {
      const inst = (await s.probe("cmd/track.add", { kind: "instrument", name: "Busy Test" }))
        .payload.track;
      try {
        await s.reload();
        // Pick the built-in piano from the header dropdown and assert the control
        // reports itself busy at least once, then settles showing the instrument.
        const btn = await s.eval(`(() => {
          const row = [...document.querySelectorAll(".tlh-row")]
            .find((r) => r.textContent.includes("Busy Test"));
          const b = row?.querySelector(".tlh-inst-btn");
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        if (!btn) throw new SkipError("track row too short to show the instrument dropdown");

        // Watch for the busy class from BEFORE the click (the swap can be fast).
        await s.eval(`(() => {
          window.__instBusySeen = false;
          const row = [...document.querySelectorAll(".tlh-row")]
            .find((r) => r.textContent.includes("Busy Test"));
          const obs = new MutationObserver(() => {
            if (row.querySelector(".tlh-inst-btn.busy")) window.__instBusySeen = true;
          });
          obs.observe(row, { subtree: true, attributes: true, attributeFilter: ["class"] });
          window.__instBusyObs = obs;
          return true;
        })()`);

        await s.click(btn.x, btn.y);
        await s.untilEval("the instrument picker opens", () =>
          document.querySelectorAll(".ctx-item").length > 0);
        // The stock "Piano" (builtin:piano) — always present, always fast. A real VST
        // here would make the check depend on this machine's plug-in folder.
        const pick = await s.eval(`(() => {
          const el = [...document.querySelectorAll(".ctx-item")]
            .find((i) => i.textContent.trim() === "Piano");
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`);
        if (!pick) throw new SkipError("the stock Piano is not in this picker");
        await s.click(pick.x, pick.y);

        await s.until("the engine loaded an instrument onto the track", async () => {
          const p = (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
          const t = p.tracks.find((x) => x.id === inst.id);
          return !!t && t.inserts.length > 0;
        });
        const seen = await s.eval(() => window.__instBusySeen === true);
        tt.ok(seen, "the dropdown reported busy while the instrument was loading");
        await s.untilEval("the button settles out of the busy state", () => {
          const row = [...document.querySelectorAll(".tlh-row")]
            .find((r) => r.textContent.includes("Busy Test"));
          return !!row && !row.querySelector(".tlh-inst-btn.busy");
        });
        await s.eval(() => {
          window.__instBusyObs?.disconnect();
          return true;
        });
      } finally {
        await s.probe("cmd/track.remove", { trackId: inst.id });
      }
    },
  },

  {
    id: "palette-tab-keeps-keyboard",
    title: "Tab inside the command palette does not strand focus and freeze the keyboard",
    area: "palette-keyboard",
    guards: "1314840 — the input is the palette's only key handler AND its only focusable element, so Tab moved focus out and killed Esc/arrows/Enter; because the palette carries .modal-overlay the global handler was inert too, leaving the whole app keyboard-dead with no way out but the mouse",
    run: async (s, tt) => {
      await s.key("Control+k");
      await s.untilEval("palette opens", () => !!document.querySelector(".cp-overlay"));
      tt.eq(await s.eval(() => document.activeElement?.className ?? null), "cp-input",
        "the palette input takes focus on open");

      await s.key("Tab");
      // Same-tick reads lag React, but focus moves synchronously — still, give the
      // app a render to be wrong in before believing it.
      await s.untilEval("focus stays on the palette input", () =>
        document.activeElement?.className === "cp-input");

      // The real consequence of losing focus was that Escape stopped working, so
      // assert the escape hatch itself rather than only where focus sits.
      await s.key("Escape");
      await s.untilEval("Escape still closes the palette after Tab", () =>
        !document.querySelector(".cp-overlay"));
    },
  },

  {
    id: "dialog-clamps-on-blur",
    title: "Process ▸ Gain shows the clamped value instead of applying a different one",
    area: "dialogs-modals",
    guards: "1314840 — out-of-range entries were clamped only on Apply, so the field kept displaying the typed number: Gain showed 999 dB and applied 48. Shared by gain, normalize, resample, time-stretch, pitch-shift, the velocity ops, delete-notes and DOP edit, so one regression here lies in nine dialogs",
    run: async (s, tt) => {
      // Locate the fixture's audio clip by geometry — the clip surface is a canvas
      // with no accessibility nodes. Lanes line up with the track header rows.
      const target = await s.eval(() => {
        const rows = [...document.querySelectorAll(".tlh-row")];
        const row = rows.find((r) => r.textContent.trim().startsWith("Audio 1"));
        const canvas = document.querySelector("canvas.tl-clipcanvas");
        if (!row || !canvas) return null;
        const rb = row.getBoundingClientRect();
        const cb = canvas.getBoundingClientRect();
        return { x: cb.left + 55, y: rb.top + rb.height / 2 };
      });
      tt.ok(target, "found the Audio 1 lane and the clip surface");

      const clickItem = async (text) => {
        const box = await s.eval(`(() => {
          const el = [...document.querySelectorAll(".ctx-item")]
            .find((i) => i.textContent.trim() === ${JSON.stringify(text)});
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`);
        if (!box) throw new AssertionError(`context-menu item not found: ${text}`);
        await s.click(box.x, box.y);
      };

      await s.click(target.x, target.y, { button: "right" });
      await s.untilEval("clip context menu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim() === "Process"));
      await clickItem("Process");
      await s.untilEval("the Process submenu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim() === "Gain…"));
      await clickItem("Gain…");

      // NB: the selector is written out in full at every use. A function handed to
      // s.eval is stringified and has no closure over this scope, so hoisting it to a
      // const here would evaluate as `undefined` in the page — silently, on every poll,
      // until the wait times out and blames the dialog for not opening.
      await s.untilEval("the gain dialog opens", () =>
        !!document.querySelector(".modal-overlay input[type=number]"));
      const range = await s.eval(() => {
        const el = document.querySelector(".modal-overlay input[type=number]");
        return { min: el.min, max: el.max, focused: document.activeElement === el };
      });
      tt.eq(range.max, "48", "the dB field declares its ceiling");
      tt.ok(range.focused, "the first field takes focus, so typing lands in it");

      // Type well past the ceiling. The field must keep showing what Apply would use.
      await s.key("Control+a");
      await s.type("999");
      await s.untilEval("the field accepts the typed value while typing", () =>
        document.querySelector(".modal-overlay input[type=number]")?.value === "999");

      await s.key("Tab"); // blur
      await s.untilEval("the field clamps on blur", () =>
        document.querySelector(".modal-overlay input[type=number]")?.value === "48");

      // Leave nothing applied — this check must not mutate the project.
      await s.key("Escape");
      await s.untilEval("the dialog closes without applying", () =>
        !document.querySelector(".modal-overlay"));
    },
  },

  {
    id: "escape-closes-topmost-modal-only",
    title: "Escape closes only the top dialog of a stack, not everything under it",
    area: "dialogs-modals",
    guards: "1314840 — one Escape closed EVERY stacked modal, so cancelling the parameter editor also tore down the Offline Processes dialog beneath it. Stacked modals live in separate React roots, each with its own window listener, so the fix is an escStack where only the topmost token answers",
    run: async (s, tt) => {
      const audioClipId = async () => {
        const hello = await s.probe("session/hello", { clientName: "smoke" });
        const clip = (hello.payload.project.tracks ?? [])
          .flatMap((t) => t.clips ?? [])
          .find((c) => c.assetId != null);
        return clip ?? null;
      };
      const clip = await audioClipId();
      tt.ok(clip, "the fixture's audio clip is present");

      // Own precondition: the chain survives reloads AND earlier runs of this check, so
      // start from empty rather than stacking another entry every time. Clearing an
      // already-empty chain is not a failure worth reporting.
      await s.probe("cmd/clip.processChain", { clipId: clip.id, action: "clear" }, { allowError: true });
      // One entry, added over the wire — driving the menus is the clamp check's job.
      // builtin:utility because it HAS an editable parameter table, which is what puts
      // the pencil on the row and so gives us a second modal to stack.
      await s.probe("cmd/clip.processChain", {
        clipId: clip.id, action: "addPlugin", uid: "builtin:utility",
      });

      const target = await s.eval(() => {
        const row = [...document.querySelectorAll(".tlh-row")]
          .find((r) => r.textContent.trim().startsWith("Audio 1"));
        const canvas = document.querySelector("canvas.tl-clipcanvas");
        if (!row || !canvas) return null;
        const rb = row.getBoundingClientRect(), cb = canvas.getBoundingClientRect();
        return { x: cb.left + 55, y: rb.top + rb.height / 2 };
      });
      tt.ok(target, "found the Audio 1 lane and the clip surface");

      await s.click(target.x, target.y, { button: "right" });
      // The item counts the chain ("Offline Processes… (1)"), so match by prefix.
      await s.untilEval("clip context menu opens", () =>
        [...document.querySelectorAll(".ctx-item")]
          .some((i) => i.textContent.trim().startsWith("Offline Processes")));
      const box = await s.eval(() => {
        const el = [...document.querySelectorAll(".ctx-item")]
          .find((i) => i.textContent.trim().startsWith("Offline Processes"));
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await s.click(box.x, box.y);

      await s.untilEval("the Offline Processes dialog opens", () =>
        document.querySelectorAll(".modal-overlay").length === 1);

      // Second modal, on top of the first.
      await s.eval(() => {
        document.querySelector('.modal-overlay button.btn-icon[title="Edit parameters"]').click();
        return true;
      });
      await s.untilEval("the parameter editor stacks on top", () =>
        document.querySelectorAll(".modal-overlay").length === 2);

      // One Escape: the top one goes, the one underneath stays.
      await s.key("Escape");
      await s.untilEval("exactly one dialog is left", () =>
        document.querySelectorAll(".modal-overlay").length === 1);
      const left = await s.eval(() => document.querySelector(".modal-title")?.textContent ?? "");
      tt.match(left, /^Offline Processes/, "the dialog left standing is the one underneath");

      // Second Escape closes that one — the two-Escape contract.
      await s.key("Escape");
      await s.untilEval("the second Escape closes the last dialog", () =>
        document.querySelectorAll(".modal-overlay").length === 0);

      // Put the clip back the way it was found.
      await s.probe("cmd/clip.processChain", { clipId: clip.id, action: "clear" }, { allowError: true });
    },
  },

  {
    id: "track-header-click-retargets-M",
    title: "clicking a track header drops the clip selection, so M mutes the track",
    area: "timeline-tracks",
    guards: "1314840 — a track-header click left a previously selected CLIP in the selection, and M routes to clips whenever any clip is selected (lib/keyboard.ts: tracks-and-no-clips mutes tracks, otherwise clips). So M silently muted a clip on a DIFFERENT track while the header's own M light stayed dark — a wrong-target edit with no error anywhere",
    run: async (s, tt) => {
      const project = async () =>
        (await s.probe("session/hello", { clientName: "smoke" })).payload.project;

      // Own preconditions: mute state survives reloads and earlier runs.
      let p = await project();
      const audio = p.tracks.find((t) => t.name === "Audio 1");
      const midi = p.tracks.find((t) => t.name === "MIDI 1");
      tt.ok(audio && midi, "fixture has both an audio and a MIDI track");
      const clip = (audio.clips ?? [])[0];
      tt.ok(clip, "the audio track has its fixture clip");
      for (const t of p.tracks) await s.probe("cmd/track.set", { trackId: t.id, patch: { mute: false } });
      await s.probe("cmd/clip.set", { clipId: clip.id, patch: { muted: false } }, { allowError: true });
      await s.reload();

      const geom = await s.eval(() => {
        const rows = [...document.querySelectorAll(".tlh-row")];
        const rowOf = (name) => rows.find((r) => r.textContent.trim().startsWith(name));
        const canvas = document.querySelector("canvas.tl-clipcanvas");
        const a = rowOf("Audio 1"), m = rowOf("MIDI 1");
        if (!a || !m || !canvas) return null;
        const ab = a.getBoundingClientRect(), mb = m.getBoundingClientRect();
        const cb = canvas.getBoundingClientRect();
        return {
          clip: { x: cb.left + 55, y: ab.top + ab.height / 2 },
          // The name label, not the row centre — the centre lands on the M/S/R buttons.
          midiHeader: { x: mb.left + 60, y: mb.top + 10 },
        };
      });
      tt.ok(geom, "located the two lanes and the clip surface");

      // Phase 1 — prove the clip really is selected, by using the very routing that
      // makes the bug possible: with a clip selected, M must mute the CLIP. Asserting
      // "a clip is selected" any other way is guesswork, and if the click missed, phase
      // 2 would pass for the wrong reason (no clip selected, so M trivially hits the track).
      await s.click(geom.clip.x, geom.clip.y);
      await s.key("m");
      let clipMid = null;
      await s.until("phase 1: M with a clip selected mutes the CLIP", async () => {
        const mid = await project();
        clipMid = (mid.tracks.find((t) => t.id === audio.id).clips ?? [])
          .find((c) => c.id === clip.id);
        return clipMid?.muted === true;
      });
      tt.ok(clipMid.muted, "the clip selection is real — confirmed via the routing the bug depends on");
      await s.probe("cmd/clip.set", { clipId: clip.id, patch: { muted: false } });

      // Phase 2 — the regression. Clicking a track header must DROP that clip selection.
      await s.click(geom.midiHeader.x, geom.midiHeader.y);
      await s.untilEval("the MIDI track header is selected", () => {
        const row = [...document.querySelectorAll(".tlh-row")]
          .find((r) => r.textContent.trim().startsWith("MIDI 1"));
        return row?.dataset.selected === "true";
      });

      await s.key("m");

      // Engine truth: the clicked TRACK is muted and the clip is untouched.
      await s.untilEval("the header's own M light comes on", () => {
        const row = [...document.querySelectorAll(".tlh-row")]
          .find((r) => r.textContent.trim().startsWith("MIDI 1"));
        const m = [...(row?.querySelectorAll(".tlh-btn") ?? [])]
          .find((b) => b.textContent.trim() === "M");
        return m?.getAttribute("aria-pressed") === "true";
      });

      p = await project();
      const midiAfter = p.tracks.find((t) => t.id === midi.id);
      const audioAfter = p.tracks.find((t) => t.id === audio.id);
      const clipAfter = (audioAfter.clips ?? []).find((c) => c.id === clip.id);
      tt.eq(midiAfter.mute, true, "M muted the track whose header was clicked");
      tt.eq(audioAfter.mute, false, "the other track was left alone");
      tt.ok(!clipAfter.muted, "the previously selected clip was NOT muted instead");

      // Leave the fixture as found.
      await s.probe("cmd/track.set", { trackId: midi.id, patch: { mute: false } });
    },
  },

  {
    id: "settings-audio-shows-the-real-driver",
    title: "Settings ▸ Audio reports the driver the engine is actually running",
    area: "settings",
    guards: "1314840 — the tab showed a fabricated WASAPI config while the engine ran on the Null driver, because a driver the engine never ENUMERATES was missing from the option list and the form fell back to the first available one. The status strip below it read 'null' at the same time, and pressing Apply would have switched the engine off Null",
    run: async (s, tt) => {
      const status = await s.probe("engine/getStatus");
      const driver = status.payload.driver;
      tt.ok(driver, `the engine reports a driver (${driver})`);

      // Settings remembers its last tab; seed it so this opens where the check looks.
      await s.eval(() => {
        localStorage.setItem("mydaw.ui.settingsTab", JSON.stringify("audio"));
        return true;
      });
      await s.reload();

      const menu = await s.eval(() => {
        const el = document.querySelector('[aria-label="File"]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      tt.ok(menu, "the File menu button is present");
      // Settings moved into a File ▸ Settings submenu (e6e955b): click the parent
      // item to open it (ContextMenu's activate() opens submenus on click too),
      // then the "Open Settings…" child. Exact-text matches so a rename explains
      // itself here instead of as a silent timeout.
      await s.click(menu.x, menu.y);
      await s.untilEval("the File menu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim() === "Settings"));
      const parent = await s.eval(() => {
        const el = [...document.querySelectorAll(".ctx-item")]
          .find((i) => i.textContent.trim() === "Settings");
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await s.click(parent.x, parent.y);
      await s.untilEval("the Settings submenu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim() === "Open Settings…"));
      const entry = await s.eval(() => {
        const el = [...document.querySelectorAll(".ctx-item")]
          .find((i) => i.textContent.trim() === "Open Settings…");
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await s.click(entry.x, entry.y);

      await s.untilEval("the Audio tab renders its Driver row", () =>
        [...document.querySelectorAll(".sett-label")].some((l) => l.textContent.trim() === "Driver"));

      // The control is whatever sits beside the "Driver" label — report what was found
      // rather than assuming a tag, so a markup change explains itself.
      const found = await s.eval(() => {
        const label = [...document.querySelectorAll(".sett-label")]
          .find((l) => l.textContent.trim() === "Driver");
        const ctrl = label?.nextElementSibling;
        const sel = ctrl?.tagName === "SELECT" ? ctrl : ctrl?.querySelector("select");
        return {
          tag: ctrl?.tagName ?? null,
          value: sel?.value ?? null,
          options: sel ? [...sel.options].map((o) => `${o.value}|${o.text}`) : null,
          text: (ctrl?.textContent ?? "").trim().slice(0, 60),
        };
      });

      tt.eq(found.value, driver,
        `the Driver control selects the running driver (found ${JSON.stringify(found)})`);
      tt.ok(
        (found.options ?? []).some((o) => o.startsWith(driver + "|")),
        `the running driver has an option of its own (options=${JSON.stringify(found.options)})`,
      );

      await s.key("Escape");
      await s.untilEval("settings closes", () => !document.querySelector(".modal-overlay"));
    },
  },

  {
    id: "punch-toggle-arms-the-record-gate",
    title: "the Punch toggle arms the engine's record gate, seeded from the cycle",
    area: "transport",
    guards: "Phase 3 — punch in/out shipped protocol-only (cmd/punch.set + the RT gate) with no way to reach it from the UI. Arming with no region yet would be a dead button under SPEC §10, so the toggle seeds the region from the cycle the user has already framed",
    run: async (s, tt) => {
      // Own preconditions: both regions persist in the project.
      await s.probe("cmd/punch.set", { startBeat: 0, endBeat: 0, enabled: false });
      await s.probe("cmd/loop.set", { startBeat: 4, endBeat: 12, enabled: true });
      await s.reload();

      const btn = await s.eval(() => {
        const el = [...document.querySelectorAll("button")]
          .find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Punch"));
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, pressed: el.getAttribute("aria-pressed") };
      });
      tt.ok(btn, "the transport has a Punch toggle");
      tt.eq(btn.pressed, "false", "it starts disarmed");

      await s.click(btn.x, btn.y);
      await s.until("the engine arms the punch gate", async () =>
        (await s.probe("transport/pause")).payload.punch?.enabled === true);

      // Seeded from the cycle — not left empty, which would gate every sample out.
      const p = (await s.probe("transport/pause")).payload.punch;
      tt.near(p.startBeat, 4, 1e-9, `punch start seeded from the cycle (${JSON.stringify(p)})`);
      tt.near(p.endBeat, 12, 1e-9, "punch end seeded from the cycle");

      await s.untilEval("the toggle reflects the armed state", () =>
        [...document.querySelectorAll("button")]
          .find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Punch"))
          ?.getAttribute("aria-pressed") === "true");

      // Disarming must keep the region — the user framed it; only the gate turns off.
      await s.click(btn.x, btn.y);
      await s.until("the engine disarms", async () =>
        (await s.probe("transport/pause")).payload.punch?.enabled === false);
      const p2 = (await s.probe("transport/pause")).payload.punch;
      tt.near(p2.startBeat, 4, 1e-9, "the region survives disarming");
      tt.near(p2.endBeat, 12, 1e-9, "the region survives disarming");

      await s.probe("cmd/punch.set", { startBeat: 0, endBeat: 0, enabled: false });
      await s.probe("cmd/loop.set", { startBeat: 0, endBeat: 8, enabled: false });
    },
  },

  {
    id: "capture-conflict-chip",
    title: "arming a track on an input device that can't open raises the honest warning chip",
    area: "transport",
    guards: "SPEC §5.5 multi-endpoint capture (2026-08-07, from Omer's two-mic session) — every armed track's device opens in its own session, so different inputs on different tracks just WORK; what remains warnable is a device that fails to open (that track records SILENCE), surfaced via event/captureState → TransportBar chip with the track and device NAMED (the raw-GUID toast was the bug report)",
    run: async (s, tt) => {
      const a = (await s.probe("cmd/track.add", { kind: "audio", name: "Cap A" })).payload.track;
      const b = (await s.probe("cmd/track.add", { kind: "audio", name: "Cap B" })).payload.track;
      try {
        tt.ok(!(await s.eval(() => !!document.querySelector(".tb-capture-warn"))),
          "no chip before any problem exists (it must be able to be absent)");

        // Two tracks on two different (real) inputs must raise NO warning — that is
        // the multi-endpoint contract, and exactly what used to warn before.
        await s.probe("cmd/track.set", { trackId: a.id, patch: { recordArm: true } });
        await s.probe("cmd/track.set",
          { trackId: b.id, patch: { inputDevice: "Imaginary Input", recordArm: true } });
        await s.untilEval("unavailable-device chip appears", () => !!document.querySelector(".tb-capture-warn"));

        const chip = await s.eval(() => {
          const el = document.querySelector(".tb-capture-warn");
          return { text: el?.textContent ?? "", title: el?.getAttribute("title") ?? "" };
        });
        tt.match(chip.text, /Input unavailable/, "chip names the problem");
        tt.match(chip.title, /Cap B/, "tooltip names the affected track");
        tt.match(chip.title, /Imaginary Input/, "tooltip names the device it asked for");
        tt.match(chip.title, /SILENCE/, "tooltip states the consequence");

        await s.probe("cmd/track.set", { trackId: b.id, patch: { recordArm: false } });
        await s.untilEval("chip clears once the missing device is disarmed",
          () => !document.querySelector(".tb-capture-warn"));
      } finally {
        await s.probe("cmd/track.remove", { trackId: b.id });
        await s.probe("cmd/track.remove", { trackId: a.id });
      }
    },
  },

  {
    id: "palette-bar-jump-labels-where-it-goes",
    title: "the palette's bar-jump promises the beat it actually locates to",
    area: "palette-keyboard",
    guards: "1314840 — the row printed the RAW typed beat while locating to a clamped one, so \"1.9\" in 4/4 offered \"beat 9\" and went to beat 4. The label and the locate are both derived from the clamped index now; this asserts they cannot diverge again",
    run: async (s, tt) => {
      await s.probe("transport/locate", { beat: 0 });
      await s.key("Control+k");
      await s.untilEval("palette opens", () => !!document.querySelector(".cp-overlay"));

      // 4/4, so beat 9 of bar 1 does not exist — it clamps to the bar's last beat, 4.
      await s.type("1.9");
      await s.untilEval("the bar-jump row appears", () =>
        [...document.querySelectorAll(".cp-label")].some((l) => /Go to bar 1/.test(l.textContent)));

      const label = await s.eval(() => {
        const el = [...document.querySelectorAll(".cp-label")]
          .find((l) => /Go to bar 1/.test(l.textContent));
        return el.textContent.trim();
      });
      tt.match(label, /beat 4\b/, `the row names the CLAMPED beat (got ${JSON.stringify(label)})`);
      tt.ok(!/beat 9\b/.test(label), "the row does not promise the raw typed beat");

      await s.key("Enter");
      await s.untilEval("the palette closes on Enter", () => !document.querySelector(".cp-overlay"));

      // Bar 1 beat 4, zero-based on the wire, is beat 3 at 4/4.
      const reply = await s.probe("transport/pause");
      tt.near(reply.payload.beat, 3, 1e-6,
        "the transport lands on the beat the row named, not the one typed");
    },
  },

  {
    id: "add-track-menu-has-no-dead-items",
    title: "a track kind the engine would refuse is disabled with a reason, not silently dead",
    area: "timeline-tracks",
    guards: "1314840 and SPEC §10 (no dead buttons) — the one-per-project view-row kinds stayed enabled once one existed, so choosing them did nothing at all and the engine's refusal only reached console.warn. Now greyed out with a tooltip saying why",
    run: async (s, tt) => {
      // Own precondition: exactly one marker track, whatever earlier checks left behind.
      let project = (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
      const markers = project.tracks.filter((t) => t.kind === "marker");
      for (const extra of markers.slice(1))
        await s.probe("cmd/track.remove", { trackId: extra.id }, { allowError: true });
      let markerId = markers[0]?.id;
      if (markerId == null)
        markerId = (await s.probe("cmd/track.add", { kind: "marker" })).payload.track.id;
      await s.reload();

      const plus = await s.eval(() => {
        // aria-label ONLY — the corner also hosts the global M/S toggles now, so a
        // bare ".tl-corner button" fallback would click Mute-All instead (paid for).
        const el = document.querySelector('.tl-corner [aria-label="Add track"]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      tt.ok(plus, "the Add-track button is present in the tracks corner");
      await s.click(plus.x, plus.y);
      await s.untilEval("the add-track menu opens", () =>
        [...document.querySelectorAll(".ctx-item")]
          .some((i) => i.textContent.trim().startsWith("Add Marker Track")));

      const rows = await s.eval(() => {
        const pick = (label) => {
          const el = [...document.querySelectorAll(".ctx-item")]
            .find((i) => i.textContent.trim().startsWith(label));
          return el ? { disabled: el.classList.contains("disabled"), title: el.getAttribute("title") } : null;
        };
        return { marker: pick("Add Marker Track"), audio: pick("Add Audio Track") };
      });

      tt.ok(rows.marker, "the menu offers a Marker Track row");
      tt.eq(rows.marker.disabled, true, "the already-present kind is disabled");
      tt.match(rows.marker.title ?? "", /already has/i,
        `the disabled row says why (title=${JSON.stringify(rows.marker.title)})`);
      // Discrimination: prove the menu is not simply disabled wholesale.
      tt.ok(rows.audio, "the menu offers an Audio Track row");
      tt.eq(rows.audio.disabled, false, "a kind the engine WOULD accept stays enabled");

      await s.key("Escape");
      await s.probe("cmd/track.remove", { trackId: markerId }, { allowError: true });
    },
  },

  {
    id: "automation-lanes-stay-collapsible-when-short",
    title: "expanded automation lanes can still be collapsed after a vertical zoom-out",
    area: "timeline-tracks",
    guards: "1314840 — the collapse affordance lived only in the track header's 'A' toggle, which is hidden with the rest of the controls once the row drops under 44 px. One Shift+G was enough to strand every expanded track permanently expanded, on every track at once. The lane row is a FIXED height, so it now carries its own collapse button",
    run: async (s, tt) => {
      const project = (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
      const midi = project.tracks.find((t) => t.name === "MIDI 1");
      tt.ok(midi, "fixture has the MIDI track");
      // A lane only exists once it has automation on it.
      await s.probe("cmd/automation.set", {
        trackId: midi.id, paramRef: "volume", add: [{ beat: 0, value: 0.8 }],
      });
      await s.reload();

      // Expand via the header 'A' toggle — the affordance that is about to disappear.
      // reload() returns at app MOUNT; the header rows render only after the hello
      // project arrives, so under load a bare eval here read an empty track list
      // (the one intermittent failure this suite had, 2026-08-07 gate run).
      await s.untilEval("the MIDI 1 header row renders its controls", () => {
        const row = [...document.querySelectorAll(".tlh-row")]
          .find((r) => r.textContent.trim().startsWith("MIDI 1"));
        return [...(row?.querySelectorAll(".tlh-btn") ?? [])]
          .some((b) => b.textContent.trim() === "A");
      });
      const a = await s.eval(() => {
        const row = [...document.querySelectorAll(".tlh-row")]
          .find((r) => r.textContent.trim().startsWith("MIDI 1"));
        const btn = [...(row?.querySelectorAll(".tlh-btn") ?? [])]
          .find((b) => b.textContent.trim() === "A");
        if (!btn) return null;
        const b = btn.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      tt.ok(a, "the header carries the automation-lanes toggle while the row is tall");
      await s.click(a.x, a.y);
      await s.untilEval("a lane row appears", () => !!document.querySelector(".tlh-lane"));

      // Shrink until the controls are gone. Shift+G is vertical zoom-OUT (factor 0.8).
      for (let i = 0; i < 8; i++) await s.key("Shift+g");
      await s.untilEval("track rows fall below the 44px control threshold", () => {
        const row = [...document.querySelectorAll(".tlh-row")]
          .find((r) => r.textContent.trim().startsWith("MIDI 1"));
        return !!row && row.getBoundingClientRect().height < 44;
      });

      const state = await s.eval(() => {
        const row = [...document.querySelectorAll(".tlh-row")]
          .find((r) => r.textContent.trim().startsWith("MIDI 1"));
        const headerToggle = [...(row?.querySelectorAll(".tlh-btn") ?? [])]
          .some((b) => b.textContent.trim() === "A");
        const lane = document.querySelector(".tlh-lane");
        const collapse = lane?.querySelector('button[aria-label="Collapse automation lanes"]');
        const cb = collapse?.getBoundingClientRect();
        return {
          rowH: row ? row.getBoundingClientRect().height : null,
          headerToggle,
          hasCollapse: !!collapse,
          collapseAt: cb ? { x: cb.left + cb.width / 2, y: cb.top + cb.height / 2, w: cb.width } : null,
        };
      });

      tt.ok(state.rowH < 44, `the row really is short (${state.rowH}px)`);
      tt.eq(state.headerToggle, false,
        "the header's own toggle is gone at this height — which is what made this a trap");
      tt.ok(state.hasCollapse, "the lane row carries its own collapse control");
      tt.ok(state.collapseAt && state.collapseAt.w > 0, "and that control is actually laid out");

      // It must WORK, not merely exist.
      await s.click(state.collapseAt.x, state.collapseAt.y);
      await s.untilEval("clicking it collapses the lanes", () => !document.querySelector(".tlh-lane"));

      // Restore the viewport and the fixture.
      for (let i = 0; i < 8; i++) await s.key("Shift+h");
      await s.probe("cmd/automation.clear", { trackId: midi.id, paramRef: "volume" }, { allowError: true });
    },
  },

  {
    id: "knob-click-without-drag-commits-nothing",
    title: "a bare click on a mixer knob sends no command and keeps the redo tail",
    area: "mixer",
    guards: "1314840 — a click with no drag committed a non-transient cmd/track.set carrying the UNCHANGED value. UndoStack::push() does entries_.resize(cursor_), so that no-op entry DROPPED THE REDO TAIL: touching a knob after an undo silently destroyed the user's redo, and nothing on screen changed to hint at it. Knob.tsx is shared by every pan knob, the sends and the plugin/EQ knobs, so one regression spreads across the mixer",
    run: async (s, tt) => {
      const project = async () =>
        (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
      const audioId = (await project()).tracks.find((t) => t.name === "Audio 1").id;

      // (1) The mixer must be the visible dock pane. Panel prefs persist across reloads,
      // so an earlier check that switched the dock would otherwise decide this one.
      await s.eval(() => {
        localStorage.setItem("mydaw.ui.panels", JSON.stringify(
          { browser: true, browserTab: "plugins", inspector: true, bottomTab: "mixer" }));
        localStorage.setItem("mydaw.ui.panels.bottomTab2", JSON.stringify(null));
        return true;
      });
      // (2) Known pan, and (3) a redo tail — built over the WIRE, so the UI is not
      // implicated in creating the very thing we are about to check it does not destroy.
      await s.probe("cmd/track.set", { trackId: audioId, patch: { pan: 0 } });
      await s.probe("cmd/track.set", { trackId: audioId, patch: { pan: 0.5 } });
      await s.probe("edit/undo");
      await s.reload();
      tt.near((await project()).tracks.find((t) => t.id === audioId).pan, 0, 1e-9,
        "the undo left pan back at centre, with a redo waiting");

      await s.untilEval("the Audio 1 mixer strip renders", () =>
        [...document.querySelectorAll(".mxstrip")]
          .some((el) => el.querySelector("input.mxstrip-name")?.value === "Audio 1"));

      const knob = await s.eval(() => {
        const strip = [...document.querySelectorAll(".mxstrip")]
          .find((el) => el.querySelector("input.mxstrip-name")?.value === "Audio 1");
        strip.scrollIntoView({ block: "nearest", inline: "nearest" });
        const el = strip.querySelector('.knob svg[role="slider"][aria-label="Pan"]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, value: el.getAttribute("aria-valuenow") };
      });
      tt.ok(knob, "found the Audio 1 pan knob");
      tt.eq(knob.value, "0", "the knob shows the centred value it is about to be clicked at");

      // Watch the socket itself: the assertion is about what the UI SENDS, and the engine
      // cannot tell a no-op cmd/track.set from a real one.
      await s.eval(() => {
        if (!window.__knobSpy) {
          window.__knobSpy = true;
          window.__sent = [];
          const orig = WebSocket.prototype.send;
          WebSocket.prototype.send = function (d) {
            if (typeof d === "string") window.__sent.push(d);
            return orig.call(this, d);
          };
        }
        window.__sent.length = 0;
        return true;
      });

      // The gesture: press and release at the same point. No pointermove, so Knob's
      // `moved` flag stays false and onPointerUp must not commit.
      await s.click(knob.x, knob.y);

      // Prove the click LANDED before concluding anything from its silence — otherwise a
      // missed click would pass this check perfectly. Knob.onPointerDown focuses the svg
      // by hand (it preventDefault()s the press), so focus is direct evidence of delivery.
      await s.untilEval("the knob took focus, so the press was delivered", () =>
        document.activeElement?.getAttribute?.("aria-label") === "Pan" &&
        document.activeElement?.getAttribute?.("role") === "slider");

      const sent = await s.eval(() =>
        (window.__sent || []).filter((m) => m.includes("cmd/track.set")));
      tt.eq(sent.length, 0, `no track command left the UI (got ${JSON.stringify(sent)})`);

      tt.near((await project()).tracks.find((t) => t.id === audioId).pan, 0, 1e-9,
        "the engine's pan is untouched");

      // The consequence that made this destructive rather than merely noisy.
      const redo = await s.probe("edit/redo", {}, { allowError: true });
      tt.ok(redo.ok, `the redo tail survived the click (${JSON.stringify(redo.error ?? {})})`);
      tt.near((await project()).tracks.find((t) => t.id === audioId).pan, 0.5, 1e-9,
        "and the surviving redo was the pan edit, not something else");

      await s.probe("cmd/track.set", { trackId: audioId, patch: { pan: 0 } });
    },
  },

  {
    id: "pianoroll-drag-draw-keeps-scale-snap",
    title: "drawing a note by press-drag honours scale snapping, like click-draw always did",
    area: "pianoroll",
    guards: "1314840 — the create branch of onNotesMove recomputed the pitch RAW on every pointermove (g.note.pitch = M.yToPitch(y, v)), overwriting the scale-snapped pitch startCreate had chosen. So click-to-draw obeyed the Snap toggle and drag-to-draw silently ignored it, on a purely horizontal drag where the user never moved vertically at all",
    run: async (s, tt) => {
      const clipOf = async () => {
        const p = (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
        return (p.tracks.find((t) => t.name === "MIDI 1").clips ?? [])[0];
      };

      // Follow-playhead can scroll the timeline out from under the clip geometry.
      await s.probe("transport/locate", { beat: 0 });

      // Beats 6..8 are the drawing area. A note left there by a crashed run turns the
      // create gesture into a MOVE gesture, which hangs rather than failing cleanly.
      let clip = await clipOf();
      const stale = (clip.notes ?? []).filter((n) => n.startBeat >= 6).map((n) => n.id);
      if (stale.length) await s.probe("cmd/notes.edit", { clipId: clip.id, remove: stale });
      clip = await clipOf();
      const baseIds = new Set((clip.notes ?? []).map((n) => n.id));
      const added = async () => {
        const c = await clipOf();
        return (c.notes ?? []).filter((n) => !baseIds.has(n.id));
      };

      // Pin every geometry and scale pref this check computes with — all of them persist.
      await s.eval(() => {
        const P = {
          "mydaw.pianoRoll.view": { zoomX: 28, rowH: 14 },
          "mydaw.pianoRoll.division": "1/16",
          "mydaw.pianoRoll.triplet": false,
          "mydaw.pianoRoll.scale": "major",
          "mydaw.pianoRoll.scaleRoot": 0,
          "mydaw.pianoRoll.scaleSnap": true,
          "mydaw.ui.tool": "select",
        };
        for (const [k, v] of Object.entries(P)) localStorage.setItem(k, JSON.stringify(v));
        return true;
      });
      await s.reload();

      // Open the clip: double-click it in the timeline (needs the SELECT tool, hence the
      // pref order above). activeMidiClipId is store-only and is never persisted.
      const clipXY = await s.eval(() => {
        const row = [...document.querySelectorAll(".tlh-row")]
          .find((r) => r.textContent.trim().startsWith("MIDI 1"));
        const canvas = document.querySelector("canvas.tl-clipcanvas");
        const rb = row.getBoundingClientRect(), cb = canvas.getBoundingClientRect();
        return { x: cb.left + 55, y: rb.top + rb.height / 2 };
      });
      await s.click(clipXY.x, clipXY.y, { clicks: 2 });
      await s.untilEval("the piano roll opens on the clip", () =>
        !!document.querySelector(".pr-root:not(.pr-empty) .pr-notes-wrap canvas"));

      await s.key("2");
      await s.untilEval("the draw tool is armed", () =>
        document.querySelector('[aria-label="Draw (2)"]')?.getAttribute("aria-pressed") === "true");

      const geom = await s.eval(() => {
        const c = document.querySelector(".pr-notes-wrap canvas:not(.pr-overlay-canvas)");
        const snap = document.querySelector('button.btn-toggle[aria-label^="Snap to scale"]');
        const b = c.getBoundingClientRect(), sb = snap.getBoundingClientRect();
        return {
          left: b.left, y0: b.top + Math.round(b.height / 2),
          snap: { x: sb.left + sb.width / 2, y: sb.top + sb.height / 2 },
        };
      });
      const X = (beat) => geom.left + beat * 28 + 1;
      const setSnap = async (want) => {
        const on = await s.eval(() =>
          document.querySelector('button.btn-toggle[aria-label^="Snap to scale"]')
            ?.getAttribute("aria-pressed") === "true");
        if (on !== want) {
          await s.click(geom.snap.x, geom.snap.y);
          await s.untilEval(`snap toggles to ${want}`, `(() => document.querySelector('button.btn-toggle[aria-label^="Snap to scale"]')?.getAttribute("aria-pressed") === ${JSON.stringify(String(want))})()`);
        }
      };

      // CALIBRATE. Never assume which pitch a y maps to — yToPitch depends on rowH and on
      // a one-shot per-clip auto-scroll. Two click-only draws with snap OFF commit raw
      // rows, so their difference proves the rowH pin actually took.
      await setSnap(false);
      await s.click(X(6.0), geom.y0);
      await s.until("first calibration note lands", async () => (await added()).length >= 1);
      await s.click(X(6.0), geom.y0 - 14);
      await s.until("second calibration note lands", async () => (await added()).length >= 2);
      let notes = (await added()).sort((a, b) => a.pitch - b.pitch);
      tt.eq(notes.length, 2, "two calibration notes");
      tt.eq(notes[1].pitch, notes[0].pitch + 1, "14 px is exactly one semitone (rowH pin verified)");
      const p0 = notes[0].pitch;
      await s.probe("cmd/notes.edit", { clipId: clip.id, remove: notes.map((n) => n.id) });

      // An out-of-scale row: among any three consecutive semitones at least one is black.
      const MAJOR = [0, 2, 4, 5, 7, 9, 11];
      let k = 0;
      while (k < 3 && MAJOR.includes((p0 + k) % 12)) k++;
      const rawTarget = p0 + k;
      const yTarget = geom.y0 - 14 * k;
      tt.ok(k < 3, `found an out-of-scale row (pitch ${rawTarget}, pc ${rawTarget % 12})`);

      // REFERENCE: click-draw, the path that always honoured the scale.
      await setSnap(true);
      await s.click(X(6.5), yTarget);
      await s.until("the reference note lands", async () => (await added()).length >= 1);
      const clicked = (await added())[0];
      tt.eq(clicked.pitch, rawTarget + 1, "click-draw snaps the out-of-scale row up into the scale");
      tt.ok(MAJOR.includes(clicked.pitch % 12), "and the result really is in C major");

      // THE REGRESSION: a purely HORIZONTAL press-drag on the same row. y never changes,
      // which is what made the old behaviour so damning — the pitch moved anyway.
      await s.drag([X(7.5), yTarget], [X(7.5) + 28, yTarget], 12);
      await s.until("the dragged note lands", async () => (await added()).length >= 2);
      const dragged = (await added()).find((n) => n.id !== clicked.id);
      tt.eq(dragged.pitch, clicked.pitch, "press-drag agrees with click-draw about the pitch");
      tt.ok(dragged.pitch !== rawTarget, `and did not commit the raw row ${rawTarget}`);

      // NEGATIVE CONTROL: the same drag with snap OFF must commit the raw row — proof that
      // rawTarget is reachable by this gesture, so the assertion above cannot pass vacuously.
      await setSnap(false);
      await s.drag([X(8.5), yTarget], [X(8.5) + 28, yTarget], 12);
      await s.until("the control note lands", async () => (await added()).length >= 3);
      const control = (await added()).find((n) => n.id !== clicked.id && n.id !== dragged.id);
      tt.eq(control.pitch, rawTarget,
        "with snap off the same drag commits the raw row, so the two outcomes are distinguishable");

      // Cleanup: the notes, then every pref this check pinned.
      const leftover = (await added()).map((n) => n.id);
      if (leftover.length) await s.probe("cmd/notes.edit", { clipId: clip.id, remove: leftover });
      tt.eq((await added()).length, 0, "the fixture clip is back to its original notes");
      await s.eval(() => {
        for (const k2 of ["mydaw.pianoRoll.view", "mydaw.pianoRoll.division", "mydaw.pianoRoll.triplet",
          "mydaw.pianoRoll.scale", "mydaw.pianoRoll.scaleRoot", "mydaw.pianoRoll.scaleSnap", "mydaw.ui.tool"])
          localStorage.removeItem(k2);
        return true;
      });
    },
  },

  {
    id: "inspector-fade-cannot-exceed-the-clip",
    title: "the Inspector caps a clip fade at the clip's own length",
    area: "browser-inspector",
    guards: "1314840 — both fade fields render SecondsDrag, whose max defaults to 30 s, and ClipSection passed no cap. A 3 s clip accepted a 25 s fade-in, so the gain never reached unity — the clip sat ~22 dB down while the timeline drew an ordinary fade. The ENGINE has no cap of its own (cmd/clip.set {fadeInSec:25} on a 3 s clip is accepted and reported back), so the UI is the only place this can be enforced and the only place it can be tested",
    run: async (s, tt) => {
      const project = async () =>
        (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
      let p = await project();
      const clip = (p.tracks.find((t) => t.name === "Audio 1").clips ?? [])[0];
      tt.ok(clip, "the fixture audio clip is present");
      const lenSec = clip.lengthSamples / p.sampleRate;

      // Own precondition: fades persist, so an earlier run must not decide this one.
      await s.probe("cmd/clip.set", { clipId: clip.id, patch: { fadeInSec: 0, fadeOutSec: 0 } });

      // The Inspector is a TAB of the left Browser, and the active tab is persisted.
      const tab = await s.eval(() => {
        const el = document.querySelector('.browser-tabbar button.tab[data-tab-id="inspector"]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      tt.ok(tab, "the Browser has an Inspector tab");
      await s.click(tab.x, tab.y);
      await s.untilEval("the Inspector tab is active", () =>
        document.querySelector('.browser-tabbar button.tab[data-tab-id="inspector"]')
          ?.getAttribute("aria-selected") === "true");

      // ClipSection only renders with a clip selected.
      const clipXY = await s.eval(() => {
        const row = [...document.querySelectorAll(".tlh-row")]
          .find((r) => r.textContent.trim().startsWith("Audio 1"));
        const canvas = document.querySelector("canvas.tl-clipcanvas");
        const rb = row.getBoundingClientRect(), cb = canvas.getBoundingClientRect();
        return { x: cb.left + 55, y: rb.top + rb.height / 2 };
      });
      await s.click(clipXY.x, clipXY.y);
      await s.untilEval("the Inspector shows the clip's fade fields", () =>
        !!document.querySelector('.inspector .numdrag[title="Fade-in (seconds)"]'));

      // The Inspector column scrolls, and the fade row lays out UNDER the mixer dock at
      // the default window — elementFromPoint there returns a mixer strip. Scroll it into
      // view and then verify what is actually at the point before clicking it.
      const field = await s.eval(() => {
        const el = document.querySelector('.inspector .numdrag[title="Fade-in (seconds)"]');
        el.scrollIntoView({ block: "center" });
        const b = el.getBoundingClientRect();
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        const out = document.querySelector('.inspector .numdrag[title="Fade-out (seconds)"]');
        return {
          cx, cy,
          onTarget: hit === el || el.contains(hit),
          hit: hit?.className ?? null,
          max: el.getAttribute("aria-valuemax"),
          outMax: out?.getAttribute("aria-valuemax") ?? null,
        };
      });
      tt.ok(field.onTarget, `the click point really is the fade field (hit ${JSON.stringify(field.hit)})`);

      // The cap itself, derived from the engine rather than hard-coded.
      tt.eq(field.max, String(lenSec), "fade-in declares the clip's length as its ceiling");
      tt.eq(field.outMax, String(lenSec), "fade-out carries the same cap — both fields had the bug");

      // Ask for far more than the clip holds, through the type-in editor.
      await s.click(field.cx, field.cy, { clicks: 2 });
      await s.untilEval("the type-in editor opens", () => !!document.querySelector("input.numdrag-input"));
      await s.key("Control+a");
      await s.type("25");
      await s.key("Enter");
      await s.untilEval("the editor commits and closes", () => !document.querySelector("input.numdrag-input"));

      const shown = await s.eval(() => {
        const el = document.querySelector('.inspector .numdrag[title="Fade-in (seconds)"]');
        return { text: el.textContent.trim(), now: el.getAttribute("aria-valuenow") };
      });
      tt.near(Number(shown.now), lenSec, 1e-6, `the field displays the clamped value (${shown.text})`);

      // The assertion that carries the bug: the display could be right while the commit is
      // wrong, which is precisely the failure mode the clamp-on-blur fix was about.
      await s.until("the engine records the clamped fade", async () =>
        ((await project()).tracks.find((t) => t.name === "Audio 1").clips ?? [])[0]?.fadeInSec > 0);
      p = await project();
      const after = (p.tracks.find((t) => t.name === "Audio 1").clips ?? [])[0];
      tt.near(after.fadeInSec, lenSec, 1e-6, "the engine stored the clip's length, not the typed 25");
      tt.ok(after.fadeInSec < 25, "and emphatically not the out-of-range value");

      await s.probe("cmd/clip.set", { clipId: clip.id, patch: { fadeInSec: 0, fadeOutSec: 0 } });
    },
  },

  {
    id: "sheetmusic-right-click-retargets-the-menu",
    title: "right-clicking an unselected note runs the menu against THAT note",
    area: "sheetmusic",
    guards: "1314840 — selectedRefs closed over the render-scoped selection, while openNoteMenu re-selects the clicked note after the callbacks are frozen. So every command ran against the PREVIOUS selection: Delete removed other notes and left the clicked one, while the menu header claimed '1 note selected'. A silent wrong-target edit that the header actively lied about",
    run: async (s, tt) => {
      // Dock prefs: shapeOf() rejects a partial panels object outright, and the dock then
      // silently stays on the mixer — so all four fields have to be present.
      await s.eval(() => {
        localStorage.setItem("mydaw.ui.panels", JSON.stringify(
          { browser: true, browserTab: "plugins", inspector: true, bottomTab: "sheetMusic" }));
        localStorage.setItem("mydaw.ui.panels.bottomTab2", JSON.stringify(null));
        localStorage.setItem("mydaw.ui.dockH", JSON.stringify(300));
        return true;
      });
      await s.reload();
      await s.untilEval("the Sheet Music pane mounts", () => !!document.querySelector(".sm-root"));
      await s.untilEval("noteheads are engraved", () =>
        document.querySelectorAll("[data-nid]").length >= 6);

      const clipOf = async () => {
        const p = (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
        return p.tracks.flatMap((t) => t.clips ?? []).find((c) => Array.isArray(c.notes) && c.notes.length);
      };
      const clip = await clipOf();
      const before = clip.notes.map((n) => n.id);
      tt.ok(before.length >= 6, `the fixture clip has notes to work with (${before.length})`);

      // Unlike the timeline, the score is SVG — the noteheads are real queryable nodes and
      // each carries the ENGINE note id, so DOM and engine can be compared by identity.
      const heads = await s.eval(() => {
        const box = document.querySelector(".sm-scroll").getBoundingClientRect();
        return [...document.querySelectorAll("[data-nid]")]
          .map((el) => {
            const b = el.getBoundingClientRect();
            return { nid: Number(el.dataset.nid), x: b.left + b.width / 2, y: b.top + b.height / 2, b };
          })
          .filter((h) => h.b.left >= box.left && h.b.right <= box.right &&
                         h.b.top >= box.top && h.b.bottom <= box.bottom)
          .map(({ nid, x, y }) => ({ nid, x, y }))
          .sort((p1, p2) => p1.x - p2.x);
      });
      tt.ok(heads.length >= 6, `enough noteheads are on screen (${heads.length})`);
      const A = heads[0], B = heads[2], victim = heads[5];

      await s.click(A.x, A.y);
      await s.untilEval("the first note is selected",
        `(() => document.querySelector('[data-nid="${A.nid}"]')?.classList.contains("selected") === true)()`);

      // s.click takes no modifiers, so shift-click goes through the Input domain directly.
      for (const [type, button, buttons] of [["mouseMoved", "none", 0], ["mousePressed", "left", 1], ["mouseReleased", "left", 0]])
        await s.send("Input.dispatchMouseEvent",
          { type, x: B.x, y: B.y, button, buttons, clickCount: 1, modifiers: 8 });
      await s.untilEval("the selection is now two notes", () =>
        document.querySelectorAll("[data-nid].selected").length === 2);

      // Right-click a note that is NOT in that selection.
      await s.click(victim.x, victim.y, { button: "right" });
      await s.untilEval("the note menu opens", () =>
        [...document.querySelectorAll(".ctx-item")]
          .some((i) => (i.querySelector(".ellipsis")?.textContent ?? "").endsWith("selected")));

      // Assert the retarget BEFORE acting — the header lying is what made this invisible.
      const menu = await s.eval(() => ({
        header: document.querySelector(".ctx-item .ellipsis")?.textContent ?? null,
        selected: [...document.querySelectorAll("[data-nid].selected")].map((n) => Number(n.dataset.nid)),
        count: document.querySelector(".sm-selcount")?.textContent ?? null,
      }));
      tt.eq(menu.header, "1 note selected", "the menu header claims a single note");
      tt.eq(menu.selected, [victim.nid], "and the DOM selection really did retarget to the clicked note");

      // The Delete row's textContent is "DeleteDel" — the shortcut hint lives inside it.
      const del = await s.eval(() => {
        const el = [...document.querySelectorAll(".ctx-item")]
          .find((i) => i.querySelector(".ellipsis")?.textContent === "Delete");
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await s.click(del.x, del.y);

      await s.until("the engine drops exactly one note", async () =>
        (await clipOf()).notes.length === before.length - 1);
      const afterIds = (await clipOf()).notes.map((n) => n.id);
      const removed = before.filter((id) => !afterIds.includes(id));

      // THE regression assertion. Pre-fix this fails twice over: A and B vanish and the
      // clicked note survives.
      tt.eq(removed, [victim.nid], "exactly the right-clicked note was deleted");
      tt.ok(afterIds.includes(A.nid), "the previously selected note A is untouched");
      tt.ok(afterIds.includes(B.nid), "the previously selected note B is untouched");

      await s.probe("edit/undo");
      await s.until("undo restores the clip", async () =>
        (await clipOf()).notes.length === before.length);
      await s.eval(() => {
        localStorage.removeItem("mydaw.ui.dockH");
        return true;
      });
    },
  },

  {
    id: "refused-clip-drop-moves-nothing",
    title: "a drop the timeline refuses does not commit the horizontal half of the drag",
    area: "timeline-clips",
    guards: "f9a5309 — the move-drop branch dropped the target track when d.valid was false but still fell through to moveClips(ids, deltaBeats, undefined), so a drop the UI had already drawn in red silently moved the clip to a different bar on its own lane (and with Alt held, left a stray copy behind). Fixed by an early return when the target exists and is invalid",
    run: async (s, tt) => {
      const ZOOM_X = 32;            // px per beat, pinned below
      const DRAG_PX = 120;          // 120/32 = 3.75 beats, a whole number of 1/16 steps
      const expectBeat = DRAG_PX / ZOOM_X;

      await s.eval(`(() => {
        localStorage.setItem("mydaw.ui.tool", JSON.stringify("select"));
        localStorage.setItem("mydaw.ui.viewport", JSON.stringify({ zoomX: ${ZOOM_X}, zoomY: 16, scrollX: 0, scrollY: 0 }));
        return true;
      })()`);
      // The grid lives in the ENGINE project, which also survives the reload.
      await s.probe("cmd/grid.set", { snap: true, division: 0.25, triplet: false, swing: 0 });
      await s.reload();

      const findClip = async () => {
        const p = (await s.probe("session/hello", { clientName: "smoke" })).payload.project;
        for (const track of p.tracks)
          for (const c of track.clips ?? [])
            if (c.assetId != null) return { track, clip: c };
        return null;
      };
      let found = await findClip();
      tt.ok(found, "the fixture's audio clip is present");
      tt.eq(found.track.kind, "audio", "and it is on an audio track");
      const clipId = found.clip.id, audioTrackId = found.track.id;

      // Own precondition: an earlier run may have left it elsewhere, and the canvas
      // hit-tests against the STORE's copy, so the reset must be visible before the press.
      if (Math.abs(found.clip.startBeat) > 1e-9) {
        await s.probe("cmd/clip.move", { clipIds: [clipId], deltaBeats: -found.clip.startBeat });
        await s.reload();
      }

      const geom = await s.eval(`(() => {
        const rows = [...document.querySelectorAll(".tlh-row")];
        const row = (n) => rows.find((r) => r.textContent.trim().startsWith(n));
        const a = row("Audio 1"), m = row("MIDI 1");
        const canvas = document.querySelector("canvas.tl-clipcanvas");
        if (!a || !m || !canvas) return null;
        const ab = a.getBoundingClientRect(), mb = m.getBoundingClientRect();
        const cb = canvas.getBoundingClientRect();
        return { fromX: cb.left + 55, toX: cb.left + 55 + ${DRAG_PX},
                 audioY: ab.top + ab.height / 2, midiY: mb.top + mb.height / 2 };
      })()`);
      tt.ok(geom, "located both lanes and the clip surface");

      // Toasts auto-dismiss, so the observer goes in BEFORE the gesture, never after.
      await s.eval(() => {
        window.__toasts = [];
        window.__toastObs?.disconnect();
        window.__toastObs = new MutationObserver(() => {
          for (const el of document.querySelectorAll(".toast .toast-msg")) {
            const m = el.textContent.trim();
            if (!window.__toasts.includes(m)) window.__toasts.push(m);
          }
        });
        window.__toastObs.observe(document.body, { childList: true, subtree: true });
        return true;
      });

      // PHASE 1 — drag right AND up onto a lane that cannot hold an audio clip.
      await s.drag([geom.fromX, geom.audioY], [geom.toX, geom.midiY], 12);
      // The refusal doubles as the positive control: this toast is only reachable from the
      // move-drop branch with a target set, so seeing it proves the press hit the clip and
      // the drop handler ran to completion.
      await s.untilEval("the drop is refused out loud", () =>
        (window.__toasts ?? []).some((m) => /hold this clip/i.test(m)));

      let after = await findClip();
      tt.eq(after.track.id, audioTrackId, "the refused drop left the clip on its own track");
      tt.near(after.clip.startBeat, 0, 1e-9,
        "and did NOT commit the horizontal half of the same gesture");

      // PHASE 2 — the identical horizontal distance onto a LEGAL target must commit.
      // Without this, phase 1 would pass just as happily for a press that missed the clip.
      await s.drag([geom.fromX, geom.audioY], [geom.toX, geom.audioY], 12);
      await s.until(`the legal drag commits to beat ${expectBeat}`, async () =>
        Math.abs((await findClip()).clip.startBeat - expectBeat) < 1e-9);
      after = await findClip();
      tt.near(after.clip.startBeat, expectBeat, 1e-9,
        `${DRAG_PX}px at zoomX ${ZOOM_X} is ${expectBeat} beats — so the refused drag really was suppressed, not merely too small to see`);

      await s.probe("cmd/clip.move", { clipIds: [clipId], deltaBeats: -expectBeat });
      tt.near((await findClip()).clip.startBeat, 0, 1e-9, "the clip is back where the fixture put it");
    },
  },

  {
    id: "take-lanes-inline-comp",
    title: "take folders draw inline: T expands lanes, click picks a take, swipe comps a range",
    area: "timeline-takes",
    guards:
      "SPEC §8.7 — cmd/take.create moves clips OFF Track.clips, so a take folder used to render " +
      "as EMPTY space in the arrangement and the comp was editable only in the Inspector. The " +
      "swipe assertion is engine-verified: the comp boundaries must land where the drag went.",
    run: async (s, tt) => {
      const ZOOM_X = 32; // px per beat, pinned below
      await s.eval(`(() => {
        localStorage.setItem("mydaw.ui.tool", JSON.stringify("select"));
        localStorage.setItem("mydaw.ui.viewport", JSON.stringify({ zoomX: ${ZOOM_X}, zoomY: 16, scrollX: 0, scrollY: 0 }));
        return true;
      })()`);

      const hello = async () =>
        (await s.probe("session/hello", { clientName: "smoke" })).payload.project;

      // Seed engine-side (survives the reload): stack the fixture MIDI clip + a copy
      // as two takes of one folder.
      let proj = await hello();
      const mt = proj.tracks.find((t) => t.name === "MIDI 1");
      tt.ok(mt && mt.clips.length >= 1, "fixture MIDI clip is present");
      await s.probe("cmd/clip.duplicate", { clipIds: [mt.clips[0].id], atSource: true });
      proj = await hello();
      const clipIds = proj.tracks.find((t) => t.id === mt.id).clips.map((c) => c.id);
      tt.eq(clipIds.length, 2, "two stacked clips to fold into takes");
      const folder = (await s.probe("cmd/take.create", { trackId: mt.id, clipIds })).payload.folder;
      tt.eq(folder.lanes.length, 2, "the folder stacked them as two lanes");
      await s.reload();

      // The header grows a T toggle only for tracks WITH folders; expanding it adds
      // one .tlh-takelane header row per lane (the DOM half of the canvas rows).
      await s.untilEval("the takes toggle appears on the folder's track", () =>
        [...document.querySelectorAll(".tlh-row")].some(
          (r) => r.textContent.includes("MIDI 1") && r.querySelector(".tlh-takes-toggle"),
        ));
      const tRect = await s.eval(`(() => {
        const row = [...document.querySelectorAll(".tlh-row")].find((r) => r.textContent.includes("MIDI 1"));
        const b = row.querySelector(".tlh-takes-toggle").getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`);
      await s.click(tRect.x, tRect.y);
      await s.untilEval("expanding shows one lane row per take", () =>
        document.querySelectorAll(".tlh-takelane").length === 2);

      const geom = await s.eval(`(() => {
        const lanes = [...document.querySelectorAll(".tlh-takelane")].map((el) => {
          const b = el.getBoundingClientRect();
          return b.top + b.height / 2;
        });
        const cb = document.querySelector("canvas.tl-clipcanvas").getBoundingClientRect();
        return { lanes, left: cb.left };
      })()`);
      tt.eq(geom.lanes.length, 2, "located both take-lane bands");

      // Click take 2's lane at beat 1 → that take plays for the whole folder.
      await s.click(geom.left + 1 * ZOOM_X, geom.lanes[1]);
      await s.until("clicking a lane picks that take whole-span", async () => {
        const f = (await hello()).tracks.find((t) => t.id === mt.id)?.takeFolders?.[0];
        return !!f && f.comp.length === 1 && f.comp[0].lane === 1;
      });

      // Swipe take 1's lane across beats 2→4 → only that range comps to lane 0,
      // with take 2 restored after the range (paintComp semantics, engine-verified).
      await s.drag(
        [geom.left + 2 * ZOOM_X, geom.lanes[0]],
        [geom.left + 4 * ZOOM_X, geom.lanes[0]],
        12,
      );
      await s.until("the swipe comps [2,4) to take 1 and restores take 2 after", async () => {
        const f = (await hello()).tracks.find((t) => t.id === mt.id)?.takeFolders?.[0];
        return (
          !!f && f.comp.length === 3 &&
          f.comp[0].lane === 1 && f.comp[1].lane === 0 && f.comp[2].lane === 1
        );
      });
      const f = (await hello()).tracks.find((t) => t.id === mt.id).takeFolders[0];
      tt.near(f.comp[1].startBeat, 2, 0.1, "the swipe's press beat became the comp boundary");
      tt.near(f.comp[2].startBeat, 4, 0.1, "the swipe's release beat closed the range");

      // Tidy: flatten so a later check (or re-run against a live slot) sees the
      // fixture track without a folder.
      await s.probe("cmd/take.flatten", { trackId: mt.id, folderId: f.id });
    },
  },

  {
    // ⚠️ MUST STAY THE LAST CHECK: it exits the slot's engine FOR REAL. Anything
    // added after this line will find no engine to talk to.
    id: "file-exit-shuts-the-engine-down",
    title: "File → Exit saves, stops the engine cleanly, and shows the goodbye screen",
    area: "menu-exit",
    guards:
      "v1.0.0 shipped with NO quit path: closing the tab left the engine running forever, " +
      "and the only way out was a process kill — which leaves session.lock behind and " +
      "triggers a bogus crash-recovery offer on the next launch. File ▸ Exit must save " +
      "(autoSaveIfDirty house rule), broadcast event/shutdown (goodbye screen, reconnect " +
      "stopped), and self-exit cleanly.",
    run: async (s, tt) => {
      // Give the project a save path FIRST so the exit flow's save leg writes to temp
      // instead of auto-Save-As-ing into the real Documents folder, then dirty it so
      // that leg actually runs.
      const tmpProj = `${process.env.TEMP}\\mydaw-smoke-exit.mydaw`;
      await s.probe("project/saveAs", { path: tmpProj });
      await s.probe("cmd/track.add", { kind: "audio", name: "ExitDirty" });

      await s.eval(`(() => {
        const file = [...document.querySelectorAll(".ms-item")]
          .find((b) => b.getAttribute("aria-label") === "File");
        if (!file) return false;
        file.click();
        return true;
      })()`);
      await s.untilEval("the File menu offers Exit", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim() === "Exit"));
      await s.eval(`(() => {
        [...document.querySelectorAll(".ctx-item")]
          .find((i) => i.textContent.trim() === "Exit").click();
        return true;
      })()`);

      // The goodbye screen — not the "reconnecting…" spinner — must appear.
      await s.untilEval("the goodbye screen replaces the UI", () =>
        !!document.querySelector(".app-shutdown-card"));
      await s.untilEval("and it is not the offline spinner", () =>
        !document.querySelector(".app-offline .spin"));

      // The engine must actually be gone (the ok-reply/broadcast raced first, by design).
      let dead = false;
      for (let i = 0; i < 16 && !dead; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          await s.probe("session/hello", { clientName: "post-exit" });
        } catch {
          dead = true;
        }
      }
      tt.ok(dead, "the engine process exited — no listener answers the probe");
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
  // Comma-separated: --filter a,b runs everything matching a OR b, in SUITE order. Order
  // is the point — these checks share one slot, so reproducing an order-dependent failure
  // means replaying a prefix of the suite, not one check in isolation.
  const terms = filter.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const picked = terms.length
    ? checks.filter((c) => terms.some((t) => [c.id, c.title, c.area].some((f) => f.toLowerCase().includes(t))))
    : checks;
  if (picked.length === 0) {
    console.log(`no checks match --filter ${filter}`);
    process.exit(1);
  }

  if (!flag("allow-stale-dist")) refuseIfDistIsStale();

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
