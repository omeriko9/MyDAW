# UI test suite

A browser-driven test suite for the web UI: 196 cases across 14 areas, executed
against a real Chrome over CDP. This file is the map — the mechanics of driving the
browser live in [DEBUGGING_UI.md](DEBUGGING_UI.md), which you should read first.

## Status, honestly

| | |
|---|---|
| Cases authored | 196 (14 areas × 14) — [ui-cases.json](../scripts/ui-cases.json) |
| Executed in a real browser | **196 / 196** — 161 PASS, 34 FAIL, 1 BLOCKED |
| Bugs found by execution | **46 app bugs** (2 high, 16 medium, 25 low, 3 cosmetic) + 26 cases that were themselves wrong |
| Bug hypotheses raised by source review | 161 (45 high-confidence) |
| High-confidence hypotheses adversarially verified | 45 → **42 confirmed, 3 refuted** |
| Fixed and verified | 60+ — see the ledger below |

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

## Why there is no `npm run test:ui`

The obvious shape — a script that drives Chrome and exits non-zero — is not what this
suite is. The cases need a *coding agent* in the loop because the UI is canvas-heavy:
proving a note landed on the right beat means reading pixels out of a `<canvas>` and
interpreting clusters, and the expected geometry shifts with zoom, theme and viewport.
Encoding that as brittle assertions produces a suite that fails for the wrong reasons.

What is mechanised instead:

- **`ui/ npm test`** — 390 vitest tests over the pure logic (time math, fade curves,
  MIDI functions, clipboard, catalog). Fast, deterministic, and the right home for
  anything that does not need a DOM.
- **`scripts/*-test.mjs`** — 28 harnesses that speak the engine's WS/HTTP protocol
  directly. The right home for anything that does not need a *browser*.
- **This suite** — everything left: rendering, event wiring, focus, keyboard routing,
  cross-pane consistency. Driven by an agent through the Chrome DevTools MCP.

## Running an area

1. Start an **isolated** engine — never test against a live session. The recipe is in
   [DEBUGGING_UI.md § Isolate the data](DEBUGGING_UI.md#isolate-the-data-not-just-the-port);
   the short version is a redirected `APPDATA`, `--port 8617 --no-browser --driver null`.
   This matters more than it sounds: the destructive project flows *auto-save* rather
   than prompting, so a stray click during a test writes a real project to disk.
2. Point the MCP browser at it and build a fixture (`/api/upload` for audio,
   `cmd/clip.addMidi` + `cmd/notes.edit` for MIDI — see the same doc).
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
- **`press_key` does not reproduce a real keyboard.** CDP delivered `key: "1"` for
  `Ctrl+Alt+Shift+1`, so a genuinely dead shortcut *passed* — a real US keyboard sends
  `key: "!"`. When a shortcut involves Shift and a digit or punctuation, dispatch a
  hand-built `KeyboardEvent` with the character a real layout produces, and assert on
  `defaultPrevented`.
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

- **`dirty` is never re-seeded after a reload or reconnect** (`store/store.ts`
  `sendHello`). `HelloReply` carries no `dirty` field — verified over a probe socket:
  the reply has no such key at top level or on `project`. So after any browser reload
  the UI believes the project is clean while the engine still holds unsaved edits; the
  `●` marker clears, and because `autoSaveIfDirty` is dirty-gated, File ▸ New / Open /
  Recent / Close then skip the auto-save-before-replace entirely and the edits are
  discarded with no prompt. **This is a data-loss path.** The fix needs an engine
  change (`Api::sessionHello` emitting `projectIO.isDirty()`) plus the UI half, so it
  is out of scope for a UI-only pass — but it is the most valuable thing left.
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
