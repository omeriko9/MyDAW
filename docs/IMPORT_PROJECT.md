# Import Project — provider author guide

"Import Project" (File menu) opens a **foreign session/project file** — a Standard MIDI
File or a Cubase `.cpr` project today, your format tomorrow — and turns it into a
complete **new MyDAW project**, exactly as if the user had run File > Open on a `.mydaw`
project (except the imported project has no save path and starts dirty, so the user must
Save As).

Shipped providers (both in `engine/src/import/`, registered in `Providers.cpp`):

| Provider | Extensions | Notes |
|---|---|---|
| `SmfImportProvider` | `.mid .midi .smf .rmi` | Format 0/1 SMF: notes, CC/pitch-bend, tempo + time-signature maps, track names |
| `CprImportProvider` | `.cpr` | Cubase SX 2 (2004) through Cubase 13: tracks/folders, MIDI notes + CC/bend/aftertouch, tempo + signature maps, audio clips with relinkable assets, cp1255 Hebrew name transcoding, mixer insert chains + rack/track instruments with their saved VST2/VST3 state chunks (imported as dormant inserts; restore via File > Recreate Plugins…). Debug tools: `scripts/cpr-analyze.mjs` (object-tree dumper), `scripts/cpr-import-test.mjs` (corpus test, `--file` for ad-hoc imports), `scripts/recreate-test.mjs` (end-to-end plugin recreation). Format reference: `docs/CPR_MIXER_FORMAT.md`, history: `docs/CPR_IMPORT_PLAN.md` |

This is different from **media import** (`media/import`, drag-and-drop / File > Import
Files), which drops audio/MIDI *clips into the existing project*. Import Project replaces
the whole session: tracks, tempo, time signature, everything.

The feature is built around a tiny plugin interface, `ImportProvider`
(`engine/src/import/ImportProvider.h`). Adding support for a new format means writing one
class and one registration line — no protocol, UI, or build-system changes. The skeleton
in [`docs/examples/MyFormatImportProvider.cpp`](examples/MyFormatImportProvider.cpp)
compiles as-is once copied into `engine/src/import/`.

---

## 1. End-to-end flow

```
            browser UI (React)                         engine (mydaw-engine.exe)
  ┌────────────────────────────────┐          ┌──────────────────────────────────────┐
  │ File > Import Project          │          │                                      │
  │  (importProjectFlow,           │          │                                      │
  │   ui/.../projectFlows.ts)      │          │                                      │
  │        │                       │          │                                      │
  │        │ confirm-if-dirty      │          │                                      │
  │        ▼                       │   WS     │                                      │
  │  "dialog/importProject" {} ────┼─────────►│ native IFileOpenDialog; filter list  │
  │        ▲                       │          │ built from ImportProviderRegistry    │
  │        └── {path | null} ◄─────┼──────────┤ ("All supported project formats",    │
  │        │                       │          │  one entry per provider, "All Files")│
  │        ▼                       │          │                                      │
  │  "project/importForeign"       │          │ Api::importForeignPath (Api.cpp):    │
  │      {path} ───────────────────┼─────────►│  1. Registry::forPath(path)          │
  │                                │          │     ext match (case-insens.)+probe() │
  │                                │          │     -> nullptr => error no_provider  │
  │   event/importProgress ◄───────┼──────────┤  2. provider->import(path, ctx,      │
  │      {path, pct} (0..100)      │          │       scratchModel, err)             │
  │                                │          │     -> false => error import_failed  │
  │                                │          │  3. adopt like project/load:         │
  │                                │          │     stop transport, destroy plugin   │
  │                                │          │     instances, swap in the model,    │
  │                                │          │     recreate plugins, AssetStore     │
  │                                │          │     loadAsync, graph rebuild,        │
  │                                │          │     dirty=true, NO save path         │
  │   reply {project} +            │          │                                      │
  │   event/projectChanged ◄───────┼──────────┤  full project broadcast              │
  └────────────────────────────────┘          └──────────────────────────────────────┘
```

Key points:

- **The provider never touches the live project.** `import()` fills a scratch `Model`;
  the engine only adopts it after the provider returned `true`. A failed import leaves
  the current session completely untouched.
- **Adoption is identical to `project/load`** (`Api::importForeignPath`,
  `engine/src/server/Api.cpp`): `prepareForModelReplace()` (stop transport, tear down
  plugin instances), swap the model, `afterModelReplaced()` (recreate plugin instances if
  the model has any, `AssetStore::loadAsync` for every asset, graph rebuild,
  `event/projectChanged` broadcast), then `markDirty()`. The imported project has **no
  save path** — Save triggers the Save As flow.
- Providers are registered once at startup: `App::init` calls
  `registerAllImportProviders()` (`engine/src/import/Providers.cpp`).

### WebSocket messages (SPEC §5 conventions)

| Message | Payload | Reply |
|---|---|---|
| `project/getImportFormats` | `{}` | `{formats: [{id, name, extensions: string[]}]}` — registration order |
| `dialog/importProject` | `{}` | `{path: string \| null}` (null = user cancelled) |
| `project/importForeign` | `{path: string}` | `{project: Project}` + full `event/projectChanged` broadcast |

`project/importForeign` error codes:

- `no_provider` — no registered provider claims the file (extension mismatch, or every
  extension-matching provider's `probe()` rejected it).
- `import_failed` — a provider matched but its `import()` returned false; the message is
  the provider's `err` string verbatim, so **make your error messages user-readable**
  (they land in the UI).
- `bad_request` — empty/missing `path`.

While `import()` runs, every `ctx.progress(pct)` call is broadcast as
`event/importProgress {path: <file name>, pct: 0..100}`.

---

## 2. The `ImportProvider` interface

`engine/src/import/ImportProvider.h` (namespace `mydaw`):

```cpp
struct ImportContext {
    int sessionSampleRate = 48000;
    std::string projectDirHint;          // may be empty (project not saved yet)
    AssetStore* assetStore = nullptr;    // import referenced/embedded audio via importFile(...)
    std::function<void(float)> progress; // 0..1, MAY BE NULL — always null-check
};

class ImportProvider {
public:
    virtual ~ImportProvider() = default;
    virtual std::string id() const = 0;          // stable lowercase id, e.g. "smf"
    virtual std::string displayName() const = 0; // e.g. "Standard MIDI File"
    virtual std::vector<std::string> extensions() const = 0; // lowercase, no dot, e.g. {"mid","midi"}
    virtual bool probe(const std::string& absPath, std::string& whyNot) const; // default: return true
    virtual bool import(const std::string& absPath, const ImportContext& ctx, Model& out,
                        std::string& err) = 0;
    // 'out' arrives as Model::defaultProject() (master track exists, 120bpm 4/4) — mutate it.
};
```

### Method by method

**`id()`** — stable lowercase identifier (`"smf"`, `"myformat"`). Surfaced through
`project/getImportFormats` and used in log lines. Never change it once shipped.

**`displayName()`** — human-readable format name (`"Standard MIDI File"`). Becomes the
file-dialog filter label and the `name` field of `project/getImportFormats`.

**`extensions()`** — lowercase extensions **without the dot** (`{"mid", "midi"}`). Used
for two things: the native dialog's filter patterns (`*.mid;*.midi`) and the registry's
candidate matching in `forPath()` (case-insensitive against the file's real extension).

**`probe(absPath, whyNot)`** — cheap content sniff, called after an extension match.
Default implementation returns `true` (extension match suffices). Override it to read a
few magic bytes when your extension is generic or shared with other formats. Return
`false` with a one-line `whyNot` to decline; `forPath()` logs the rejection
(`Log::warn`) and **falls through to the next registered provider** with the same
extension. Keep it fast — it runs while resolving which provider handles a file, do not
parse the whole file here.

**`import(absPath, ctx, out, err)`** — the actual conversion. `out` arrives as
`Model::defaultProject()`: master track (id 1) exists, tempo map `[{beat 0, 120 bpm}]`,
time-signature map `[{bar 0, 4/4}]`, `nextId == 2`. Mutate it into the imported project
(see the Model cheat-sheet below). On success return `true`; on failure fill `err` with
a user-readable message and return `false` — partial mutations of `out` are fine, the
scratch model is simply discarded.

### Threading & engine-state rules

- `import()` runs **synchronously on the engine main thread**, exactly like
  `project/load` (the WS server posts every message to the main-thread job queue — see
  `App::init` in `engine/src/App.cpp`). It never runs on the RT audio thread, and the
  browser UI lives in another process entirely, so a slow import never glitches audio or
  freezes the page — but the engine processes no other protocol messages until you
  return. For large files, report `ctx.progress` so the UI can show movement.
- **Do not touch engine state.** No transport, no graph, no plugin instances, no
  `App`/`AssetStore::setProjectDir`/anything global. Your only outputs are the `Model`
  you fill, optional assets imported through `ctx.assetStore->importFile(...)`, and the
  `err` string. The engine performs the adoption itself after you return.
- `ctx.progress` **may be null** — always `if (ctx.progress) ctx.progress(x);`. Values
  are 0..1, monotonically increasing; the engine converts them to percent for
  `event/importProgress`.
- The registry itself is thread-safe (mutex-guarded); providers may keep scratch members
  during a single `import()` call (the registry owns each provider instance and calls
  are serialized on the main thread).
- Keep `import()` **deterministic**: same input file → same output project (no RNG, no
  wall-clock-dependent values). The smoke/import tests depend on it.

### Registry semantics

`ImportProviderRegistry::forPath()` walks providers in **registration order**, picks the
first one whose `extensions()` contains the file's extension (case-insensitive) *and*
whose `probe()` accepts the content, and returns `nullptr` if none do (→ `no_provider`).
So when two providers share an extension, the earlier registration wins unless its
`probe()` declines — implement `probe()` honestly so the file can fall through to the
right provider.

For a complete production reference, read `engine/src/import/SmfImportProvider.{h,cpp}`
(SMF + RMID container handling, probe via magic bytes, progress reporting, whole-bar clip
lengths, the 12-color track palette).

---

## 3. Model cheat-sheet for conversion authors

The full, authoritative schema is `engine/src/project/Model.h` (it mirrors
`project.json` v1 — SPEC §6 — field for field). This section is the working subset a
converter needs. Units, once and for all:

| Unit | Meaning |
|---|---|
| **beats** | quarter notes (`double`). 1 beat = one quarter note regardless of time signature. |
| **samples** | audio frames at the *project* sample rate (`int64_t`). |
| **gain / volume / level** | linear (1.0 = 0 dB). |
| **pan** | -1.0 (left) .. 1.0 (right). |
| **ids** | `uint64_t`, allocated by `Model::nextId()`. 0 is the "no id" sentinel — never use it. |

### Ground rules

- **Every new entity id comes from `out.nextId()`** — tracks, clips, notes, markers,
  assets, automation points, plugin instances. Never hardcode ids, never reuse them.
  `nextId()` post-increments `project.nextId`, which is serialized, so collisions
  corrupt undo/lookup/persistence.
- **The master track already exists** (`out.project.masterTrack`, id 1,
  `TrackKind::Master`, output `none` because master feeds the device). You may rename or
  recolor it; do **not** change its `kind`, `id`, or push it into `project.tracks`.
- `out` starts as `Model::defaultProject()` — name "Untitled", 48000 Hz, 120 bpm, 4/4,
  empty tracks/assets/markers, `nextId == 2`.

### `Project` (the root, `out.project`)

| Field | Set it to |
|---|---|
| `name` | the imported project's name (file stem is a fine default). |
| `sampleRate` | `ctx.sessionSampleRate` (audio assets are resampled to this at import). |
| `tempoMap` | `{TempoEntry{0.0, bpm}}` — v1 expects a **single entry at beat 0** (`beat`, `bpm`). |
| `timeSigMap` | `{TimeSigEntry{0, num, den}}` — single entry at bar 0 (`bar` is 0-based). |
| `loop` | optional: `LoopRegion{startBeat, endBeat, enabled}` — SMF import spans the song, disabled. |
| `tracks` | your imported tracks, in display order (top to bottom). |
| `assets` | one `Asset` per imported audio file (see §4). |
| `markers` | optional: `Marker{id, beat, name, color}`. |

Leave alone: `formatVersion`, `grid`, `ui` (opaque UI state), `masterTrack.kind/id`,
and `nextId` (only ever advance it through `out.nextId()`).

### `Track`

```cpp
Track t;
t.id   = out.nextId();
t.kind = TrackKind::Midi;          // Audio | Midi | Instrument | Folder | Bus (never Master)
t.name = "Lead";
t.color = "#54a3e8";               // hex string; SmfImportProvider has a 12-color palette
```

Useful fields with their defaults already sensible: `volume` (1.0 linear), `pan` (0.0),
`mute/solo/recordArm` (false), `channels` (2), `height` (0 = default UI height),
`parentId` (0 = root; set to a Folder track's id to nest). Only `Audio`, `Midi`, and
`Instrument` tracks can hold clips (`Track::canHoldClips()`).

**Routing — `outputTarget`:** defaults to `OutputTarget::master()` (track feeds the
master bus), which is what you want for ordinary imported tracks. The alternatives are
`OutputTarget::track(busId)` (must reference a `TrackKind::Bus` track — validated by
`Model::isValidOutputTarget`, and routing cycles are rejected) and
`OutputTarget::none()` (silent). `sends` likewise may only target Bus tracks.

`inserts` (plugin instances) are best left empty on import unless your format records
plugin paths/state that genuinely map to installed plugins — a wrong `PluginInstance`
produces load errors the user has to dismiss.

### `MidiClip` and `Note` (clip lives in `track.clips`, a `std::vector<Clip>` where `Clip = std::variant<AudioClip, MidiClip>`)

```cpp
MidiClip c;
c.id          = out.nextId();
c.name        = t.name;
c.startBeat   = 0.0;     // timeline position, in beats from project start
c.lengthBeats = 8.0;     // clip length in beats (SMF import rounds up to whole bars)

Note n;
n.id          = out.nextId();
n.pitch       = std::clamp(pitch, 0, 127);    // MIDI note number, 60 = C4
n.velocity    = std::clamp(velocity, 1, 127); // 1..127 (0 is not a valid stored velocity)
n.startBeat   = 0.0;     // RELATIVE TO THE CLIP START, not the project
n.lengthBeats = 1.0;
n.channel     = 0;       // optional, 0..15
c.notes.push_back(n);    // keep notes sorted by startBeat

t.clips.emplace_back(std::move(c));
```

### `AudioClip`

```cpp
AudioClip a;
a.id               = out.nextId();
a.name             = asset-or-file name;
a.startBeat        = 4.0;        // timeline position in beats
a.assetId          = asset.id;   // must reference an Asset in project.assets
a.srcOffsetSamples = 0;          // play from this offset within the asset
a.lengthSamples    = asset.lengthSamples; // played length, in samples (post-import SR)
a.gain             = 1.0;        // linear
a.fadeInSec        = 0.0;        // fades are in SECONDS, not beats
a.fadeOutSec       = 0.0;
```

Note the mixed units by design: audio clip *position* is musical (beats), its *contents*
are sample-accurate (samples at the project sample rate).

---

## 4. Importing audio the foreign project references

If the foreign format references (or embeds) audio, route it through the `AssetStore` so
it is decoded, resampled and copied into the project like any other media import.
Signature (`engine/src/media/AssetStore.h`):

```cpp
bool AssetStore::importFile(const std::string& absPath, const std::string& projectDir,
                            int sessionSr, Asset& out, std::string& err);
```

What it does (synchronous): decode wav/mp3/flac/m4a/wma via Media Foundation (plain-PCM
RIFF fallback for wav) → linear-resample to `sessionSr` (SPEC §4: resample at import,
never at playback) → write a canonical 32-bit-float WAV as
`<projectDir>/audio/<sanitized-name>[-<n>].wav` (collision-safe) → fill
`out.file` (project-folder-relative, forward slashes), `out.originalPath`,
`out.sampleRate`, `out.channels`, `out.lengthSamples`. When `out.id != 0` it also
generates the peak file and caches the decoded PCM so playback needs no re-decode —
**assign the id first**. Returns `false` + `err` on any failure.

The pattern inside `import()`:

```cpp
Asset asset;
asset.id = out.nextId(); // BEFORE importFile — enables peaks + PCM caching
std::string aerr;
if (!ctx.assetStore->importFile(absWavPath, ctx.projectDirHint,
                                ctx.sessionSampleRate, asset, aerr)) {
    err = "cannot import referenced audio '" + absWavPath + "': " + aerr;
    return false;                  // or skip the clip — your call, but tell the user
}
out.project.assets.push_back(asset);
// ... then reference asset.id / asset.lengthSamples from an AudioClip (§3).
```

**`ctx.projectDirHint` may be empty** — it is the directory of the project that was open
when the user invoked Import (the imported project itself has no folder until Save As).
If it is empty (the previous project was never saved), `importFile` **fails immediately
with `err = "no project directory"`** — it has nowhere to write the canonical WAV. Your
options, in order of preference:

1. Reference the source file in place: fill the `Asset` yourself with `file = ""`,
   `originalPath = <absolute source path>`, `sampleRate = ctx.sessionSampleRate`, plus
   `channels`/`lengthSamples` if your format records them. `AssetStore` resolves assets
   by `file` first and **falls back to `originalPath`**, and `loadAsync` resamples to
   `Asset.sampleRate` on decode, so such assets still load and play. (Only viable when
   you know the channel count and length — clips need `lengthSamples`.)
2. Fail with a clear `err` explaining that the referenced audio could not be copied.

Pure-MIDI formats can ignore all of this — `SmfImportProvider` never touches the
`AssetStore`. After adoption the engine calls `loadAsync` for every asset in
`project.assets` automatically; never call `loadAsync`/`setProjectDir`/`clear` yourself.

---

## 5. Add a provider in 6 steps

1. **Copy the skeleton**: `docs/examples/MyFormatImportProvider.cpp` →
   `engine/src/import/MyFormatImportProvider.cpp`. The engine's CMake uses
   `file(GLOB_RECURSE ... CONFIGURE_DEPENDS)` over `engine/src`, so the new file is
   picked up automatically — **no build-file edits**.
2. **Rename**: class name, `id()` (stable lowercase), `displayName()`, `extensions()`.
3. **Register it** — one line inside `registerAllImportProviders()` in
   `engine/src/import/Providers.cpp` (the marked "ADD NEW IMPORT PROVIDERS HERE" block),
   plus the matching declaration/include at the top. The exact text to paste is in the
   comment at the bottom of the skeleton.
4. **Implement** `probe()` (magic bytes) and `import()` (parse → convert → finish),
   using §3/§4 above. Make every entity id come from `out.nextId()`.
5. **Rebuild**: `pwsh scripts/rebuild.ps1 -Engine` (incremental; stops a running engine
   if it locks the exe, see §6).
6. **Test**: launch `build\bin\Release\mydaw-engine.exe`, File > Import Project, pick
   one of your files. Then confirm nothing regressed:
   `node scripts/smoke-test.mjs` (full protocol smoke) and
   `node scripts/import-test.mjs` (generates an SMF, imports it via
   `project/importForeign`, verifies tempo/tracks/clips/notes — a good template for a
   test of *your* format).

---

## 6. Compiling

**Incremental (day-to-day): `scripts/rebuild.ps1`**

```powershell
pwsh scripts/rebuild.ps1            # default: engine only (target mydaw-engine)
pwsh scripts/rebuild.ps1 -Engine -Run   # rebuild engine, then relaunch it
pwsh scripts/rebuild.ps1 -Host64    # 64-bit plugin host (target mydaw-host, build/)
pwsh scripts/rebuild.ps1 -Host32    # 32-bit bridge host (target mydaw-host, build32/)
pwsh scripts/rebuild.ps1 -Ui        # npm run build in ui/ -> ui/dist
pwsh scripts/rebuild.ps1 -All       # everything
```

It runs `cmake --build` on the existing `build/` / `build32/` trees (configuring first
only if the tree is missing), so unchanged files are skipped. If a process locks a
binary being rebuilt (a running `mydaw-engine`, or host processes spawned by it), the
script warns and stops it first. Each step checks `$LASTEXITCODE` and fails loudly;
elapsed time and artifact paths are printed at the end.

**Full builds: `scripts/build.ps1`** — UI (`npm ci` + build) → CMake preset
`x64-release` (engine + host64 into `build/`) → preset `host32-release` (host32 into
`build32/`). `-Clean` wipes both build trees first. See `docs/BUILDING.md` for options
(ASIO SDK, VST3-less builds).

**Artifacts**: `build\bin\Release\mydaw-engine.exe`, `build\bin\Release\mydaw-host64.exe`,
`build32\bin\Release\mydaw-host32.exe`, `ui\dist\` (served by the engine at
`http://127.0.0.1:8417`).

### Debugging an import

`Log::info/warn/error` (`engine/src/util/Log.h`) go to the engine console (stderr) *and*
an in-memory ring buffer of the last 2000 lines served via the `engine/getLog` WS
message (fetchable from any WS client or the `getLog` action in
`ui/src/store/actions.ts`), so your log lines are reachable even without a console; the
UI status bar shows live engine health (xruns/CPU) while you test. The registry already
logs every `probe()` rejection
(`import: provider 'x' rejected <path>: <whyNot>`). For verbose parse tracing, follow
the codebase precedent of env-var-gated trace logging (`MYDAW_VST2_TRACE` in the plugin
host): gate noisy dumps behind your own `MYDAW_MYFORMAT_TRACE` check so normal runs stay
quiet. Remember the import runs in-process on the engine main thread — you can also just
attach a debugger to `mydaw-engine.exe` and break in your `import()`.

---

## 7. Pitfalls

- **Ids not from `nextId()`.** Hardcoded or duplicated ids break lookups, undo, and
  serialization. Every `Track`/`Clip`/`Note`/`Asset`/`Marker` id: `out.nextId()`.
- **Seconds where beats belong.** All musical positions/lengths are beats (quarter
  notes). Convert from your format's ticks/seconds using its tempo *before* writing the
  model. (Audio clip `lengthSamples`/`srcOffsetSamples` and clip fades — seconds — are
  the deliberate exceptions; see §3.)
- **Touching the master track's identity.** Rename/recolor is fine; changing
  `masterTrack.kind`, its id, or appending it to `project.tracks` is not.
- **Unclamped MIDI data.** Clamp `pitch` to 0..127 and `velocity` to 1..127 (velocity 0
  is not a valid stored value); skip or clamp out-of-range source events.
- **Extension collisions.** If your extension is also claimed by another provider,
  **registration order wins** — implement `probe()` with real magic-byte checks so files
  fall through to the right provider, and register the more specific provider first.
- **No progress on large files.** The import blocks the engine main thread; call
  `ctx.progress` (null-checked!) at sensible milestones so the UI shows movement.
- **Non-deterministic output.** No RNG, timestamps, or iteration over unordered
  containers when emitting tracks/clips — tests compare imported models.
- **Invalid routing.** `outputTarget`/`sends` may only reference `Bus` tracks (or
  master/none); dangling track ids or cycles will be rejected elsewhere — default
  `OutputTarget::master()` is right for almost everything.
- **Forgetting the empty `projectDirHint` case** when importing audio — see §4.
- **Error strings nobody can act on.** Your `err` is shown to the user verbatim
  (`import_failed`); say *what* and *where* ("bar 12: unknown chunk 'XyZ'"), not "error".
