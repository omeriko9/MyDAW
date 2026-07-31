# UI test suite

A browser-driven test suite for the web UI: 196 agent-executed cases across 14 areas,
plus a small unattended regression runner, both against a real Chrome over CDP. This
file is the map — the mechanics of driving the browser live in
[DEBUGGING_UI.md](DEBUGGING_UI.md), which you should read first.

```bash
node scripts/ui-smoke.mjs                     # unattended: every check, non-zero on failure
node scripts/ui-smoke.mjs --filter transport  # by check id, title or area
node scripts/ui-smoke.mjs --headful --keep    # watch it, and leave the slot up to poke at
```

## Status, honestly

| | |
|---|---|
| Cases authored | 196 (14 areas × 14) — [ui-cases.json](../scripts/ui-cases.json) |
| Executed in a real browser | **196 / 196** — 161 PASS, 34 FAIL, 1 BLOCKED |
| Bugs found by execution | **46 app bugs** (2 high, 16 medium, 25 low, 3 cosmetic) + 26 cases that were themselves wrong |
| Bug hypotheses raised by source review | 161 (45 high-confidence) |
| High-confidence hypotheses adversarially verified | 45 → **42 confirmed, 3 refuted** |
| Fixed and verified | 60+ — see the ledger below |
| Second sweep (areas with no cases) | 126 checks — 113 PASS, 11 FAIL, 2 BLOCKED, **15 more bugs** |
| Kept from regressing, unattended | **18 checks** — [ui-smoke.mjs](../scripts/ui-smoke.mjs), 11 of 14 areas, ~16 s |

That "26 cases were themselves wrong" number is the important one: better than a
quarter of the failures were the *case* being mistaken, not the app. A case authored
from source and never run is a hypothesis, not evidence — which is exactly why the
execution pass mattered, and why anyone re-running these should keep separating "the
app is wrong" from "the case is wrong".

## Running it in parallel

The first full pass ran through the Chrome DevTools MCP, which exposes one browser with
one selected page — so areas had to run one at a time: **3.4 hours, 2,075 tool calls**,
almost all of it serialization. Use [ui-drive.mjs](../scripts/ui-drive.mjs) instead
(documented in [DEBUGGING_UI.md](DEBUGGING_UI.md#running-many-browsers-at-once-scriptsui-drivemjs)):
each agent gets its own slot — own engine, own Chrome, own throwaway `APPDATA` — so a
pass costs roughly the slowest area rather than the sum of all of them. Its input also
goes through CDP's Input domain, so keyboard events carry what a real layout sends;
synthetic events silently pass shortcuts that are dead in real use.

## What is mechanised, and what still needs an agent

Four layers, cheapest first. Push every check down to the cheapest layer that can hold
it — a browser is three orders of magnitude more expensive than a vitest case.

- **`ui/ npm test`** — 403 vitest cases over the pure logic (time math, fade curves,
  MIDI functions, clipboard, catalog). Sub-second, deterministic, and the right home
  for anything that does not need a DOM.
- **`scripts/*-test.mjs`** — 26 harnesses that speak the engine's WS/HTTP protocol
  directly. The right home for anything that does not need a *browser* — including
  contract properties, which is what
  [automation-paramref-test.mjs](../scripts/automation-paramref-test.mjs) does: it
  asserts `automation.set`/`.ramp`/`.clear` agree about every paramRef, because the
  grammar is stated in three places and drifting apart is exactly how cc: lanes once
  became uneditable.
- **`node scripts/ui-smoke.mjs`** — the unattended browser suite: one slot, every check
  in order, non-zero exit on failure. ~16 s for the current 18 checks, most of which
  cost under 400 ms — the slot is the expensive part, and it is paid once. This is where
  a bug goes once it has been fixed, so it cannot come back silently.
- **This suite (`ui-cases.json`)** — everything left: rendering, event wiring, focus,
  keyboard routing, cross-pane consistency. Driven by a *coding agent*.

The fourth layer stays agent-driven on purpose. The UI is canvas-heavy, so proving a
note landed on the right beat means reading pixels out of a `<canvas>` and interpreting
clusters, and the expected geometry shifts with zoom, theme and viewport. Encoding all
196 cases as assertions produces a suite that fails for the wrong reasons.

What `ui-smoke.mjs` is for is the narrower job the agent pass is *bad* at: making sure a
bug that was found and fixed stays fixed. A check there is written against a specific
commit and names it in `guards`, so a failure reads as "this regressed" rather than
"something about the piano roll looks off". Add one whenever a fix lands that a unit
test cannot reach.

### Writing a check

```js
{ id: "bars-1based", title: "...", area: "transport",
  guards: "the commit or bug this protects",
  run: async (s, t) => { ... } }
```

Throw to fail, return to pass, `throw new SkipError(why)` for a check that cannot run
here. `s` is the Slot from [ui-drive.mjs](../scripts/ui-drive.mjs)'s `openSlot()`; `t`
is `eq`/`ok`/`near`/`match`. The runner reloads between checks, so no check inherits
another's DOM — but **the engine keeps its project, transport position and selection
across a reload**, so each check must establish its own preconditions rather than
assume a virgin session. The file's header comment carries the full rule list.

The rule that bites hardest: **a page function is stringified, so it closes over
nothing.** Hoisting a selector to a `const` and using it inside `s.eval` raises a
`ReferenceError` in the page on every poll, which used to surface as a plain timeout
blaming whatever you were waiting for — a dialog that had in fact opened correctly.
`waitFor` now carries the last predicate error into its timeout message, so this
announces itself instead of costing an hour. The same trap wears a second hat:
`s.untilEval` polls **in the page**, `s.until` polls **here in Node** — so a wait on
engine state (`await s.probe(...)`) must use `until`, or it raises that ReferenceError
forever.

**Every check must be able to fail.** A check that cannot distinguish the bug from
correct behaviour is worse than none, because it reads as coverage. The habit that
catches this is a second leg proving the discrimination is live: the piano-roll check
repeats its drag with snapping off and requires the *raw* pitch, the refused-drop check
repeats the identical drag onto a legal lane and requires the move to commit, and the
add-track check asserts an enabled row beside the disabled one. Where the failing side
could be produced directly it was: the minor-key vitest case was confirmed by
reintroducing the bug and watching it go red.

### Deliberately not covered: `pluginmanager`

Favourites were keyed by a bare `uid`, which is not unique — one VST2 shell reports the
same uid for every copy — so starring one row starred them all. That logic is already
covered at the cheapest layer by `ui/src/lib/ids.test.ts` (all three read generations,
move-survival, un-star, read-modify-write). A browser check on top could only assert the
*wiring*, and on any realistic registry it cannot fail when the bug returns: no uid group
spans more than one `format|bitness`, so a bare-uid regression lights exactly the same
rows as the correct rule. The only discriminating signal is the persisted pref value, and
seeing it needs a multi-copy uid that exists on one developer's machine. Left out on
purpose rather than shipped as decorative coverage.

## Running an area

1. Start an **isolated** engine — never test against a live session. `node
   scripts/ui-drive.mjs up --slot N --fixture` does the whole thing (redirected
   `APPDATA`, `--driver null`, own Chrome) and seeds 4 tracks, a MIDI clip, an audio
   clip and a marker; the manual recipe is in [DEBUGGING_UI.md § Isolate the
   data](DEBUGGING_UI.md#isolate-the-data-not-just-the-port). Isolation matters more
   than it sounds: the destructive project flows *auto-save* rather than prompting, so
   a stray click during a test writes a real project to disk.
2. Drive it — `ui-drive.mjs`'s subcommands from a shell, or `openSlot()` from Node for
   anything with control flow.
3. Pull your area's cases out of `scripts/ui-cases.json` and work through them.
   Each case carries `steps`, `expected`, and an `assertion` you can hand straight to
   `evaluate_script`.
4. For anything that looks wrong, **check the engine before believing the UI**. Open a
   probe socket and compare. Half of what looks like a UI bug is a fixture mistake or
   a deliberate design choice, and the probe settles it in one call.

`risk` on each case is `safe` or `mutates-project`; nothing in the file is
`destructive`. Cases never open/close projects, rescan plugins, change the audio
device, or touch a native file dialog — those either block the browser on a modal or
write outside the sandbox.

## Second sweep: the areas that had no cases at all

The 196 cases covered 14 areas but left whole features untouched. A later pass authored
and executed checks for those in parallel slots — **126 checks, 113 PASS / 11 FAIL /
2 BLOCKED, and 15 bugs that nothing else had a chance of finding**, three of them high:

- MIDI-mapped volume/pan never reached the UI. `App::applyMidiMap` passes `transient=true`
  and the command processor returns before `broadcastChanges` when transient — correct for
  a UI fader drag (the browser is the source and already shows the value), wrong for a
  hardware controller, where nothing on screen knows. Fixed by echoing a granular
  `event/projectChanged` for externally-originated changes only, keeping the transient
  envelope so a CC sweep still does not push an undo entry per message.
  *Now guarded by [midi-learn-test.mjs](../scripts/midi-learn-test.mjs), which asserts both
  halves together — each is the other's failure mode.*
- Undoing an offline render freed an asset id that the next render reused while the engine
  kept serving the old material — every AssetStore cache is keyed by id alone.
  *Now guarded by [asset-recycle-test.mjs](../scripts/asset-recycle-test.mjs), which fails
  loudly if the two renders stop receiving the same id — otherwise it would pass while
  testing nothing.*
- CC automation lanes (from Extract MIDI Automation) rejected every edit: the lane is
  created with paramRef `cc:<n>`, but `automationSet`'s inline check and `validParamRef`
  each re-spelled the grammar as `volume|pan|send:*|plugin:*`.
  *Now guarded by [automation-paramref-test.mjs](../scripts/automation-paramref-test.mjs),
  and the third spelling is gone — `automationSet` calls `validParamRef` instead of
  restating it.*

All three of the sweep's high-severity findings now have tests. None of them needed a
browser: two are protocol harnesses and one is an assertion added to an existing harness
that had been discarding every broadcast.

Worth copying: coverage here was proven through the audio, not just the DOM. The transpose
row was verified by rendering offline and running Goertzel analysis — a sustained A4 read
440 Hz, then 880 Hz at +12, then 1760 Hz at +24 applied at the note's onset.

Still uncovered *in the browser*, and deliberately so: anything opening a native file
dialog (it blocks the browser), plugin rescan and audio-device switching, real VST editor
windows, recording from real devices, and audio correctness in general — the test engine
runs `--driver null`.

**Crash recovery used to be on that list and no longer is.** It was the only data-loss
path in the project with no test at all: seventeen harnesses call `project/saveAs` or
`project/load` as setup and not one had ever asked for `recoveryInfo`. It looked
untestable because in the UI it lives behind project open/close — but the browser was
never the obstacle, only the assumption. [recovery-test.mjs](../scripts/recovery-test.mjs)
kills the engine with `taskkill /F` (leaving the `session.lock` that makes recovery an
offer), restarts on the same redirected `APPDATA`, and asserts the edits that were never
saved come back — checked against the saved file, which still holds the older state, so a
plain reload could not pass. It also asserts the negative: a clean `--exit-when-idle`
shutdown leaves no offer at all.

It is the slowest harness in the repo at ~80 s, and unavoidably so: autosave is
timer-driven with no manual trigger and `setIntervalMinutes` takes an **int in minutes**,
so 60 s is the floor. The harness polls for the autosave file rather than sleeping blind,
so it waits exactly as long as the engine makes it.

## The 14 areas

`transport` · `timeline-tracks` · `timeline-clips` · `mixer` · `pianoroll` ·
`clipeditor` · `sheetmusic` · `browser-inspector` · `pluginmanager` ·
`dialogs-modals` · `palette-keyboard` · `menus-layout` · `settings` · `agent-store`

## Traps that produced false results

Recorded because each one cost real time and will cost it again:

- **A fixture bug looks exactly like a render bug.** `cmd/notes.edit` accepts an
  unknown `beat` key silently and defaults every note to `startBeat: 0`; the piano
  roll then correctly draws twelve notes stacked in a 12-pixel column. It reads as a
  broken renderer. The field is `startBeat`.
- **`press_key` does not reproduce a real keyboard.** The MCP delivered `key: "1"` for
  `Ctrl+Alt+Shift+1`, so a genuinely dead shortcut *passed* — a real US keyboard sends
  `key: "!"`. `ui-drive.mjs` goes through CDP's Input domain and gets this right
  (`key:"!"`, `code:"Digit1"`); through the MCP, dispatch a hand-built `KeyboardEvent`
  with the character a real layout produces and assert on `defaultPrevented`.
- **A character's ASCII code is not its virtual key.** It happens to be, for letters and
  digits only. `.` is ASCII 46, which is `VK_DELETE`; `'` is 39 (`End`), `-` is 45
  (`Insert`), `[` is 91 (`LWin`). Chrome dispatches the virtual key, not the character,
  so a harness that derives one from the other types text that silently vanishes and
  presses editing keys instead: `"3.1.000"` arrived in the locate field as `"31000"`,
  and the app dutifully jumped to bar 31000 — a *passing-looking* action with a wrong
  target, and 15 seconds of timeout before anything said so. Punctuation needs the real
  OEM codes (`.`→190/`Period`, `,`→188, `-`→189, `;`→186, `=`→187, `/`→191,
  `` ` ``→192, `[`→219, `\`→220, `]`→221, `'`→222), and they do **not** change under
  Shift — only `key`/`text` do, because the physical key is the same one.
- **Fixture construction is not evidence.** The live page reacts while the fixture is
  being built: the timeline requests waveform peaks the moment the upload lands, before
  the engine's worker has written them, and that 404 is logged at error level. Any check
  asserting "no console errors" then fails for something it did not cause. Fixed on both
  ends — `openSlot` waits for peaks to exist and hands the slot over with an empty
  console buffer — but the shape recurs: **clear the buffer at the boundary you are
  measuring from, not at the start of the process.**
- **Same-tick DOM reads lag React.** Reading `.mixer-strip` counts or overlay counts in
  the same `evaluate_script` that clicked something reports the *previous* render. An
  overlay that "leaked" was just an unflushed read. Split the click and the assertion
  into two calls.
- **Knobs are vertical.** A horizontal drag on a pan knob does nothing, correctly.
- **Internal consistency is not correctness.** The bar readout showed `0.1.000` at the
  project start and the ruler agreed with it, which reads as a deliberate 0-based
  convention. Sheet Music labelled the same bar `1`. Two panes disagreeing is the tell
  — see the ledger.

## Findings ledger

Everything below was confirmed against the code and, unless noted, reproduced in a
live browser. Verified-not-a-bug entries are kept deliberately: they are the ones
most likely to be re-reported.

### Fixed

| # | Bug | Files |
|---|---|---|
| 1 | **Bar numbers one too low everywhere.** The engine keys `timeSigMap` by a 0-based bar; `lib/time.ts` assumed 1-based. The project start displayed `0.1.000`, typing `3.1.000` located to the wrong bar, the ruler drew no line or label at beat 0, and Sheet Music (correctly `index + 1`) disagreed with the transport about the same bar. Its unit test hid it by feeding `{bar: 1}`, a shape the engine never sends. | `lib/time.ts`, `lib/time.test.ts`, `protocol/types.ts`, `Timeline/Ruler.tsx` |
| 2 | **Numeric dialogs showed one value and applied another.** Out-of-range entries were clamped only on Apply, so the field kept displaying the typed number: the fade dialog showed `99 s` and applied `3 s`; Process → Gain showed `999 dB` and applied `48 dB`. Shared by gain, normalize, resample, time-stretch, pitch-shift, the velocity ops, delete-notes and DOP edit. Now clamps on blur, so typing decimals still works but the display cannot lie. | `Dialogs/fields.tsx`, `Timeline/FadeProcessDialog.tsx` |
| 3 | **`Ctrl+Alt+Shift+1..4` (save layout) was dead on real keyboards.** The handler compared `e.key` against `"1".."4"`, but Shift makes that `"!@#$"`. Now keys off `e.code`, with `e.key` as fallback. | `lib/keyboard.ts` |
| 4 | **A reloaded tab believed a dirty project was clean.** `dirty` lived only client-side and `HelloReply` carried no such field, so after any reload the `●` marker cleared while the engine still held unsaved edits — and because `autoSaveIfDirty` is dirty-gated, File ▸ New / Open / Recent / Close then skipped the auto-save-before-replace and discarded them with no prompt. A real data-loss path; needed the engine half (`sessionHello` now emits `projectIO.isDirty()`) as well as the UI half. Guarded by the `dirty-survives-reload` smoke check. | `engine/src/server/Api.cpp`, `store/store.ts` |

And the batch applied from the verified list:

| Bug | File |
|---|---|
| Right-clicking an unselected note in Sheet Music ran every menu command against the *previous* selection — Delete removed other notes and left the clicked one, while the header claimed "1 note selected". Silent wrong-target edit. | `SheetMusic/SheetMusic.tsx` |
| A bare click (no drag) on any knob sent a full non-transient command with the unchanged value: a no-op undo entry whose before == after, project marked dirty, and the redo tail dropped. | `common/Knob.tsx` |
| One Escape closed *every* stacked modal — cancelling the fade chooser also tore down the Offline Processes dialog beneath it. Now only the topmost answers. | `common/Modal.tsx` |
| Escape while type-editing a field inside a dialog closed the whole dialog: `Modal` listened in the **capture** phase, so `NumberDrag`/`TextInput`'s `stopPropagation` was dead code. Moved to bubble phase, matching the two-Escape contract. | `common/Modal.tsx` |
| F / Bb / Eb minor were engraved with their **major** key signatures (1/2/3 flats instead of 4/5/6) — three values copy-pasted from the major table — so the score was three fifths too sharp and the toolbar named the wrong key. | `SheetMusic/notation.ts` |
| A real-but-empty MIDI clip rendered only a placeholder telling you to "write notes straight onto the staff" — with no staff to click, so the first note could never be entered there. | `SheetMusic/SheetMusic.tsx` |
| Drawing a note with a press-drag dropped scale snapping (only click-without-moving honoured it), contradicting the Snap toggle. | `PianoRoll/PianoRoll.tsx` |
| The Inspector let a clip fade exceed the clip's own length, so the gain never reached unity — a 25 s fade on a 2 s clip left it ~22 dB down while the timeline drew a normal fade. | `Inspector/ClipSection.tsx` |
| Clicking a track header kept a previously selected clip in the selection, so `M` muted that clip — possibly on another track — instead of the clicked track, and the header's M light never lit. | `Timeline/TrackHeaders.tsx` |
| Menu items the engine always refuses ("Add Marker/Arranger/Chord/Transpose Track" when one exists, "Duplicate Track" on a view row) were enabled and silently did nothing; rejections only reached `console.warn`. Now disabled with a reason, and failures toast. | `Timeline/TrackHeaders.tsx` |
| Expanded automation lanes became uncollapsible once the row fell under 44 px — reachable with one vertical zoom-out, which hid the control on every track. | `Timeline/TrackHeaders.tsx` |
| Row-height drag clamped its preview in display pixels but committed in unscaled ones, so at any vertical zoom ≠ 1:1 the row visibly snapped back on release. | `Timeline/TrackHeaders.tsx` |
| Engine `error` log lines were stored in `logLines` and read by nothing — device faults and driver fallbacks produced no visible message anywhere. Now surfaced as toasts. | `store/store.ts` |
| Settings ▸ Audio showed a fabricated WASAPI config while the engine ran on the Null driver (never enumerated), with the status strip below it reading "null". Pressing Apply would have switched the engine off Null. | `Settings/AudioTab.tsx` |
| Palette recents were emitted with the same React key as their grouped copies (duplicate-key warning; arrow-keying scrolled to the wrong row). | `CommandPalette/CommandPalette.tsx` |
| The palette's bar-jump row printed the raw typed beat while locating to a clamped one — "1.9" in 4/4 promised "beat 9" and went to beat 4. | `CommandPalette/CommandPalette.tsx` |
| Tab (or a click on the palette's own header/footer/padding) moved focus off the input, after which Escape, arrows and Enter were all dead — and since the palette carries `.modal-overlay`, every global shortcut was inert too, leaving the app keyboard-frozen. | `CommandPalette/CommandPalette.tsx` |
| The Visualizer re-created its WebGL renderer — two shader compiles, a program link, buffer uploads — on *every* re-render, because its `ref` callback had a new identity each time. | `Visualizer/Visualizer.tsx` |

### Confirmed, deliberately not fixed here

- `shared/agent/capabilities.json` still documents `timeSigMap.bar` as 1-based. Fixing
  it means regenerating the catalog, which rewrites generated engine C++ and the
  checked sha — left alone rather than desynchronising a prebuilt binary.
- Undo/Redo toolbar buttons never disable: no `canUndo`/`canRedo` exists in the UI, and
  the stacks live in the engine, so a real fix needs engine support.
- Volume faders carry no `aria-label` — only a value ("0.0 dB"), so nothing identifies
  which channel a fader belongs to.
- The mixer's empty state says "Add tracks in the arrangement" even when tracks exist
  but are all hidden MIDI channels.

### Verified NOT bugs

- **MIDI channels absent from the mixer** — by design; they carry no audio and are
  behind an opt-in toggle that only appears when `midiCount > 0`.
- **The command palette opening a project** — it matches recent projects as well as
  commands, so Enter on a fuzzy match can replace the session. But `autoSaveIfDirty`
  saves the dirty project first (confirmed: it wrote
  `Documents\MyDAW Projects\<name>.mydaw`), so nothing is lost.
- **Piano-roll notes drawn in a narrow column** — a fixture bug, see the traps above.
- **Menu automation via synthetic clicks** — works fine, contrary to the older advice
  in `DEBUGGING_UI.md`, which has been corrected.
- **Empty piano roll not setting `focusedPane`** — real code asymmetry, no behavioural
  consequence: the pane registers no key context when empty, so keys resolve to the
  timeline either way.
