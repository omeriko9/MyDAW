# Debugging the UI

How to inspect and drive the web UI — console, network, performance, and full
interactive control of a real browser.

## Where the UI runs

| Surface | URL | Use for |
|---|---|---|
| Engine-served build | `http://127.0.0.1:8417` | Debugging what ships. Serves `ui/dist`; rebuild with `cd ui; npm run build` |
| Vite dev server | `http://localhost:5173` | Iterating on UI code — HMR, real sourcemaps. Proxies `/ws` and `/api` to the engine on 8417 |
| vitest | — | Component/logic tests, no browser: `cd ui; npm test` |

Start the pair with `.\scripts\dev.ps1`. Two engine flags matter when debugging:
`--no-browser` (don't let the engine open a competing tab) and `--port N` (run an
isolated instance instead of clobbering a live session — `smoke-test.mjs` uses 8517).

### Isolate the data, not just the port

`--port` alone is **not** isolation: every instance still shares one `%APPDATA%\MyDAW`
— the same `settings.json`, `recent.json`, `session.lock`, and the rotating
`autosave\project-1..5.json`. A test engine left running for five minutes will
rotate right through those five slots and overwrite real recovery data. Worse, the
destructive project flows *auto-save* rather than prompting, so a stray "open recent"
during a test writes a real project to `Documents\MyDAW Projects`.

`appDataDir()` ([Paths.cpp](../engine/src/util/Paths.cpp)) reads the `APPDATA`
environment variable, so redirecting it per-process gives genuine isolation:

```powershell
$iso = "$env:TEMP\mydaw-uitest"
New-Item -ItemType Directory -Force "$iso\MyDAW" | Out-Null
# copy only what makes the instance useful — settings + the plugin cache.
# Deliberately NOT autosave/recent/session.lock: you want a clean, empty project.
Copy-Item "$env:APPDATA\MyDAW\settings.json","$env:APPDATA\MyDAW\plugin-cache.json" "$iso\MyDAW"
$env:APPDATA = $iso
.\build\bin\Release\mydaw-engine.exe --port 8617 --no-browser --driver null --ui-root .\ui\dist
```

`--driver null` ([NullDriver.cpp](../engine/src/audio/NullDriver.cpp)) is the other
half: it keeps the test instance off WASAPI so it neither fights the real device nor
makes noise. Confirm isolation by checking that only `logs\` and `media\` appear in
the throwaway dir afterwards.

## Browser control (Chrome DevTools MCP)

The `scripts/*-test.mjs` harnesses drive the engine's WS/HTTP protocol directly —
28 of them speak WebSocket — and never open a browser. Nothing in this repo
inspects the DOM. [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
fills that gap: it gives a coding agent a live Chrome over CDP.

Configured in [.mcp.json](../.mcp.json) at project scope. It is launched on demand
via `npx` — no repo dependency is added. Requires Node LTS and stable Chrome;
approve the server on first load after a restart.

29 tools, by category:

| Category | Tools |
|---|---|
| Navigation | `navigate_page` `new_page` `select_page` `list_pages` `close_page` `resize_page` |
| Input | `click` `hover` `drag` `fill` `fill_form` `type_text` `press_key` `upload_file` `handle_dialog` `wait_for` |
| Inspection | `take_screenshot` `take_snapshot` `evaluate_script` |
| Console | `list_console_messages` `get_console_message` |
| Network | `list_network_requests` `get_network_request` |
| Performance | `performance_start_trace` `performance_stop_trace` `performance_analyze_insight` `lighthouse_audit` `take_heapsnapshot` |
| Emulation | `emulate` |

Console messages carry source-mapped stack traces, so a `dist` build still points
at real `ui/src` lines (`vite.config.ts` sets `sourcemap: true`, and the `.map` files
ship in `dist/assets`). Screenshots are WebP capped at 1600px wide. Usage statistics
and CrUX reporting are disabled.

> **The viewport is not what `--viewport` says.** Measured on this machine the page
> reports 1920×889 regardless of the `--viewport 1600x1000` arg, and `resize_page`
> does not move it either — you get whatever the launched Chrome window provides.
> Never assert on absolute pixel positions or a fixed viewport size; measure with
> `getBoundingClientRect()` and assert on relative geometry.

Memory-debugging and extension tools are opt-in behind `--memoryDebugging` and
`--categoryExtensions`; add them to the args array if you need them.

## Running many browsers at once (`scripts/ui-drive.mjs`)

The MCP server hands out ONE browser with one "selected page". Two agents driving it
concurrently clobber each other's page selection mid-action, so an MCP-driven test pass
has to run strictly sequentially — a 14-area pass took 3.4 hours and 2,075 tool calls,
almost all of it waiting.

[ui-drive.mjs](../scripts/ui-drive.mjs) removes that limit. Each **slot** is a fully
isolated world — its own engine port (`8620+slot`), its own throwaway `APPDATA`, its own
Chrome with its own `--user-data-dir` and debug port (`9230+slot`) — so N agents run in
parallel. It uses only Node built-ins (Node 22's global `fetch` + `WebSocket`); no
puppeteer/playwright dependency is added to the repo.

```bash
node scripts/ui-drive.mjs up    --slot 2 --fixture   # engine + Chrome + 4 tracks, MIDI clip, audio clip, marker
node scripts/ui-drive.mjs eval  --slot 2 --code "document.title"
node scripts/ui-drive.mjs eval  --slot 2 --file snippet.js      # multi-line
node scripts/ui-drive.mjs key   --slot 2 --key "Control+Alt+Shift+1"
node scripts/ui-drive.mjs click --slot 2 --x 640 --y 285 [--button right] [--clicks 2]
node scripts/ui-drive.mjs drag  --slot 2 --from 100,200 --to 300,200 [--steps 12]
node scripts/ui-drive.mjs shot  --slot 2 --out shot.png
node scripts/ui-drive.mjs down  --slot 2                        # always, even on failure
```

Each command prints one JSON line. `eval` evaluates an *expression* and awaits promises,
so wrap async work as `(async () => { ... })()`.

**Input goes through CDP's Input domain, so events are TRUSTED and carry what a real
layout would send.** This is not a nicety — `Control+Alt+Shift+1` arrives as `key:"!"`,
`code:"Digit1"`, exactly like a physical US keyboard. The MCP's `press_key` delivers
`key:"1"` for the same combo, which silently *passes* shortcuts that are dead in real
use; that difference hid a broken save-layout shortcut here. Note the same class of trap
inside the harness itself: space must be sent as `key:" "` with `code:"Space"`, not
`key:"Space"`, or every Space-driven check is a silent no-op.

Two operational notes: `--user-data-dir` is mandatory (see the warning below), and you
must not rebuild `ui/dist` or the engine binary while slots are running — the agents are
serving that directory and holding that exe, and a link will fail with LNK1104.

## Taking control of your own browser

By default the server launches its own Chrome with its own profile directory. That
is the reliable path and needs no setup — the UI is local and has nothing to log
into. To instead drive a browser **you** control (your extensions, your devtools
windows, your session), start Chrome with remote debugging and attach:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
    --remote-debugging-port=9222 `
    --user-data-dir="$env:TEMP\mydaw-debug-profile" `
    "http://127.0.0.1:8417"
```

Then add `--browserUrl http://127.0.0.1:9222` to the args in `.mcp.json`.

> `--user-data-dir` is not optional here. Launching with
> `--remote-debugging-port` while a Chrome instance is already running on the
> **default** profile silently does nothing: the new process hands off to the
> existing one and drops the flag. The port stays closed and the attach fails with
> no useful error. A distinct profile dir forces a separate browser process.

Related flags: `--isolated` (throwaway profile, cleaned up on exit), `--headless`,
`--channel canary|dev|beta|stable`, `--viewport WxH`, `--acceptInsecureCerts`.

## Driving the UI reliably

The UI is keyboard-first and pointer-heavy, which makes some interactions awkward
to automate. What works:

- **Menus do drive fine from synthetic clicks** — the older "keyboard only" advice
  here was too pessimistic. The menu bar opens from a `click` on its `menuitem`, and
  entries (including submenu parents like `Process`) are `div.ctx-item` nodes you can
  match by exact text and `.click()`. Right-click menus need a `contextmenu` event
  preceded by `pointerdown`/`mousedown` at the target point. Keyboard navigation
  remains a fine alternative, not a requirement.
- **`Ctrl+K` opens the command palette** ([lib/keyboard.ts](../ui/src/lib/keyboard.ts)) —
  usually the shortest route to an action, and far more stable than walking the
  menu bar.
- **Jump straight to a sub-page by URL.** `?page=plugins` renders the Plugin
  Manager standalone ([main.tsx](../ui/src/main.tsx)). Note those entries are lazy
  imports on purpose: importing `store/store.ts` runs module-level engine wiring
  and would clear a live session's MIDI-thru routing.
- **`Ctrl+Alt+1..4` apply layout presets** (`Ctrl+Alt+Shift+N` saves) — a cheap
  way to force a known pane arrangement before a visual check.
- **Drags need movement, not just a press.** Clip and fader interactions call
  `setPointerCapture` on a movement threshold rather than on pointerdown, because
  capturing on press kills child `dblclick`. A press-release with no motion in
  between won't start a drag.
- **Open modals swallow transport keys** unless the overlay opts in with
  `data-transport-keys="allow"` ([Modal.tsx](../ui/src/components/common/Modal.tsx)).
  The command palette also carries `.modal-overlay` purely so the keyboard layer
  treats the app as inert. If a keystroke seems ignored, check for an open overlay.

- **Knobs read *vertical* movement.** Dragging a pan knob sideways does nothing at
  all; drag along Y. (Verified: a 40px horizontal drag left pan at `C`, a 40px
  vertical drag moved it to `R53` and the engine agreed.)
- **`Ctrl+Alt+1..4` do nothing until a preset is saved.** On a fresh profile they
  only toast "Layout N is empty" — save one with `Ctrl+Alt+Shift+N` first.
- **The command palette also matches recent *projects*, markers, track names and bar
  numbers — not just commands.** Typing a word and pressing Enter can therefore
  *switch projects*: `Sheet` matched a recent project named "…sheet notes" and opened
  it. Nothing is lost (`autoSaveIfDirty` in
  [projectFlows.ts](../ui/src/components/Transport/projectFlows.ts) auto-saves a dirty
  project to `Documents\MyDAW Projects` first), but the session is replaced. Type the
  exact command name and check the highlighted row before hitting Enter.

## Reaching state the DOM does not expose

`evaluate_script` reaches into the page directly, which is often faster than clicking
through. Two things it cannot do naively, and the ways around them:

**There is no store global.** Nothing assigns `useStore` to `window`, so you cannot
read Zustand state from the page. Assert on the DOM, computed styles, element geometry,
or aria attributes instead — the UI is well labelled (see the a11y notes above).

**For authoritative state, open your own WebSocket to the engine.** This is the
reliable way to check that what the UI *shows* matches what the engine *holds*:

```js
// paste once per page; then await __probe(type, payload)
window.__probe = async (type, payload = {}) => {
  const ws = new WebSocket('ws://127.0.0.1:8617/ws');
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(Error('ws')); });
  const id = Math.floor(Math.random() * 1e6);
  const out = new Promise((ok) => {
    ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.replyTo === id) ok(j); };
  });
  ws.send(JSON.stringify({ id, type, payload }));
  const r = await out; ws.close(); return r;
};
const proj = (await __probe('session/hello', { clientName: 'probe' })).payload.project;
```

Two gotchas that will cost you an hour: replies correlate on **`replyTo`**, not `id`
(there is no `id` on the reply), and the socket is flooded with `event/meters` at
~30 Hz — filter those out before looking for anything else.

**Canvas surfaces have no accessibility nodes.** The arrange clips, ruler, minimap,
piano-roll notes and waveforms are all painted into `<canvas>`, so `take_snapshot`
never lists them and `click`/`drag` by `uid` cannot reach them. Two consequences:

- *Input*: dispatch coordinate `PointerEvent`s from `evaluate_script` against
  `document.elementFromPoint(x, y)`. Synthetic events do drive real drags (no
  `setPointerCapture` trouble) as long as you cross the movement threshold on the
  axis the control reads. A double-click needs the full down/up/click ×2 + `dblclick`
  sequence.
- *Assertions*: read the pixels. `canvas.getContext('2d').getImageData(...)` then
  cluster the columns that contain saturated (non-grid) pixels — that is how you
  prove notes landed at the right beats or a fade shaded the right region.

## Building fixtures without a file dialog

An empty project makes for thin tests, and `Import Files…` opens an engine-native
dialog that will block the browser. Instead `POST /api/upload` — the same endpoint the
UI's own drop handler uses. Generate a WAV in the page, post it, and the engine
imports it and creates the clip:

```js
const fd = new FormData();
fd.append('files', new Blob([wavArrayBuffer], { type: 'audio/wav' }), 'fixture.wav');
await fetch('/api/upload?trackId=4&atBeat=0&file0=fixture.wav', { method: 'POST', body: fd });
```

`trackId` is optional — omit it and the asset lands in the pool with **no clip**
(`clips: []`), which is rarely what you want. MIDI material goes in over the probe
socket: `cmd/clip.addMidi` then `cmd/notes.edit`. Note the note field is
**`startBeat`**, not `beat`; an unknown key is accepted silently and every note
defaults to beat 0, which looks exactly like a broken renderer.

## What this does not cover

- **`/ws` protocol traffic.** The network tools surface HTTP requests. For
  frame-level protocol work, the `scripts/*-test.mjs` harnesses are the
  established path and run headlessly against a spawned engine.
- **Audio.** Nothing here verifies what you hear. Use the meters-based
  verification approach (see [SPEC.md](SPEC.md) and the stock-effects/loudness
  test harnesses) for anything audible.

## Cross-platform note

`.mcp.json` wraps the launch in `cmd /c`, because an MCP client spawns `npx`
without a shell and Windows fails that with `ENOENT` (`npx` is `npx.cmd`). That
makes the committed config Windows-only. On a POSIX host, drop the `cmd` command
and the `/c` argument so `npx` is invoked directly — or move the server to local
scope (`claude mcp add --scope local ...`) to keep it out of the repo entirely.
