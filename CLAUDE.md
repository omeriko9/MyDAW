# Working on MyDAW

Read [docs/BUILDING.md](docs/BUILDING.md) for how to build and [docs/SPEC.md](docs/SPEC.md) for
what the thing is supposed to do. SPEC.md is binding: if the code and the spec disagree, say so
rather than quietly picking one.

This file is the short list of things that have actually gone wrong here. Every rule below cost
someone a debugging session.

## Done means the gate is green

`node scripts/gate.mjs` (fast tier) is the definition of done; `--full` before a merge or
release. A missing prerequisite reports SKIP, not FAIL — that is deliberate, don't "fix" it.

**Never run two `gate.mjs` invocations at once.** The suites hard-code engine ports and several
collide; a second concurrent run produces failures that look exactly like flaky tests. The fast
tier is ~1 minute — just wait. (Paid for 2026-08-10: a spurious `recovery` failure chased for
half an hour, caused by nothing but a background gate still running.)

## Verification honesty

The recurring failure mode here is not writing bad code, it is **believing a green test that
proved nothing**. Three specific traps:

- **`ui/dist` is gitignored, so `ui-smoke` tests whatever was last built, not `ui/src`.** A
  green run against a stale bundle is a lie about current source. `ui-smoke.mjs` now refuses to
  run when dist is older than src, but the general lesson stands: before believing any result,
  ask what artifact it actually exercised. (2026-08-10: a whole session of "green" was testing an
  hours-old bundle that was hiding 7 real failures on main.)
- **A repeated, identical failure set is evidence of DETERMINISM, not flake.** Real flake moves
  around. If the same checks fail the same way twice, that is a reproducer — bisect it. Do not
  reach for "load" or "Dropbox" as an explanation; that call was made twice on 2026-08-10 and was
  wrong both times.
- **"Passes in isolation, fails in the suite" means ORDER DEPENDENCE, not a broken check.**
  Reproduce it with a prefix of the suite, not one check alone —
  `ui-smoke.mjs --filter <earlier-check>,<failing-check>` runs both in suite order.

Before claiming something works, state what you actually ran. If you only tested playback, say
so — don't imply recording was covered. (2026-08-10: automation write was reported working while
only the play path had been tested; the user's actual workflow was record.)

## Deciding "is this mine?"

When a test fails during your change, prove ownership before theorising: `git stash`, rebuild,
re-run. That one command settled three separate "is this pre-existing?" questions on 2026-08-10 —
two were pre-existing, one was not. Rebuild after stashing, or you are testing your own binary
against stashed sources.

## Editing gotcha: `//` renders as `\`

The file-reading tool displays some C++ `//` comments as `\`. **Never copy that back into a
file** — `\ comment` is not a comment and the compile error it produces (`expected member name`)
looks nothing like the cause. Type `//` yourself.

## Editing gotcha: CRLF vs scripted replace

Several engine sources are CRLF. A Python/Node `str.replace` with a multi-line `\n`-joined
pattern **silently no-ops** on them — it prints success and changes nothing, and the first
symptom is a linker error much later (paid for 2026-08-11). Use the Edit tool for multi-line
edits; scripted rewrites only for single-line or line-array surgery, and verify with grep after.

## Writing tests

- **Restore anything that changes layout.** ui-smoke checks share one browser; a check that
  leaves a track armed, a lane expanded or a dialog open shifts the geometry every later
  coordinate-driven check depends on. Put the rig back as you found it.
- Own your preconditions rather than inheriting them — the runner reloads the DOM between
  checks, but engine state carries over on purpose.
- A check authored from source and never run is a hypothesis, not evidence.

More detail on the browser rig: [docs/DEBUGGING_UI.md](docs/DEBUGGING_UI.md) and
[docs/UI_TEST_SUITE.md](docs/UI_TEST_SUITE.md#two-ways-this-suite-can-lie-to-you).
