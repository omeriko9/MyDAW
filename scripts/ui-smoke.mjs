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
      await s.click(menu.x, menu.y);
      await s.untilEval("the File menu opens", () =>
        [...document.querySelectorAll(".ctx-item")].some((i) => i.textContent.trim() === "Settings…"));
      const entry = await s.eval(() => {
        const el = [...document.querySelectorAll(".ctx-item")]
          .find((i) => i.textContent.trim() === "Settings…");
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
        const el = document.querySelector('.tl-corner [aria-label="Add track"], .tl-corner button');
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
