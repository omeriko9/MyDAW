# CPR Writer — Milestone 2 notes (record splicing, importer-oracle round-trip)

> Written 2026-07-16. Deliverables: `scripts/cpr-write.mjs` (model → .cpr via donor
> splice, built on the M1 library `scripts/cpr-container.mjs`) and
> `scripts/cpr-write-test.mjs` (automated oracle). Scope: MIDI-only projects
> `{tempo, tracks:[{name, kind:"midi", volumeGain, pan, clips:[{startBeat, lengthBeats,
> notes:[{pitch,velocity,startBeat,lengthBeats}]}]}]}`. Audio/plugins/sends: M3+.

## Results

Oracle = MyDAW's own CPR importer (`engine/src/import/CprImportProvider.cpp`) re-importing
the written file through a throwaway isolated engine (scratch `APPDATA`, `--driver null
--no-browser`, port 8434; `project/importForeign` then `session/hello`, killed by pid):

| case | oracle |
|---|---|
| 1 track / 1 note | PASS |
| 3 tracks, chords + velocities (12 notes incl. velocity 1/127 edges) | PASS |
| moved faders/pans (−6.97/+3.5/−6.02/0/−20 dB; pan −1/+1/0.33/−0.25) | PASS |
| 2 clips per track (2 tracks × 2 parts) | PASS |

Tolerances: names/kinds/pitches/velocities exact, beats ≤ 1e-6, tempo ≤ 0.01 bpm,
volume ≤ 0.01 dB, pan ≤ 0.02. Byte sanity: every written file re-parses with
`cpr-container.mjs` and re-serializes **byte-identically**; era still detects as `c5`.
M1 regression: `cpr-roundtrip-test.mjs` still 60/60 at both levels.

## Donor + era choice: **C5 (Cubase 5.1.1), `playground/cubase5-7track.cpr`**

- **The SX era cannot pass the faders/pans oracle case for MIDI tracks at all.** The
  importer reads SX faders only from `MAudioTrack` channel bodies (audio tracks), the SX
  pan field is unidentified (channels left centered), and SX MIDI tracks get no
  volume/pan whatsoever. The modern path (`modernExtractTracks`) reads Volume/Pan from a
  `FF FE A4 C8` attr tree found anywhere inside a track record — era-gated to non-SX.
  So the donor **must** detect as modern (`Devices|FAttributes`).
- The C5 record grammar around MIDI is fully known from a same-version native save
  (`2010/1h/26-2/haolam sheani metzayer.cpr`, Cubase 5.1.1): §7.4 event stream, part/list
  node layouts, header shapes — everything generated below was byte-modeled on it.
- The donor itself is small (133 KB), C5 5.1.1, 7 audio tracks, **no clips, no loaded
  Synth-Rack slots** (`VstCtrlInternalEffect` count 0) — so replacing its tracks leaves
  no MAudioEvent→clipId body-offset links (the M1 watch-for) and re-import fabricates no
  extra instrument tracks. C12 was rejected: same importer path, but donors carry
  volatile `RuntimeID`s, 16-slot folders and a `ComputerGuid` chunk — more moving parts
  for zero oracle gain.

## Record grammar actually emitted (vs donor-copied)

Everything below is **generated from scratch** inside the donor's `MTrackList` (its 22-byte
raw header is kept, with the trailing `u16` patched — it is the track count, donor 7):

```
MMidiTrackEvent v3 (full name, NO chain — native C5 writes it chainless)
  raw 26B: u16 0, f64 startTick 0, f64 lengthTicks 576000 (donor value), f64 0
  MListNode v0 (full name)
    raw: lpstrBOM trackName, u32 0, u32 0x208, u32 0x24F
    [first track only] MTempoTrackEvent v2 (36B: u32 1, {f32 60/bpm, f64 0, f64 0, u16 0},
                        f32 bpm, u16 modeFlag 0, u32 0)
                       MSignatureTrackEvent v2 (24B: u32 1, {u32 0, u16 4, u16 4, u32 0,
                        u32 0}, u32 0)  — 4/4 fixed
    raw: u32 partCount
    MMidiPartEvent v2 (full, chainless) ×N
      raw 26B: u16 0, f64 startTick(=startBeat*480), f64 lengthTicks, f64 offsetTick 0
      MMidiPart v2 : MPartNode v0
        raw: lpstrBOM partName, u32 0, u32 0x208, u32 0x24F, u32 eventCount,
             u8 7 + 7-class registry (empty full-form records: MMidiNote:MMidiEvent v1/v2,
             MMidiPolyPressure/AfterTouch/ProgramChange/Controller/PitchBend/Sysex v0),
             eventCount × 43B compact notes:
               u8 0x90, f64 tick, u8 ch 0, u8 pitch, u8 vel, u32 0x02000000, u16 nExt 0,
               f64 lengthTicks, f64 0, u8[9] 0
  raw: SYNTHETIC channel attr tree — FF FE A4 C8, u32 topCount,
       Volume{Value: f64 25856-taper (inverse of scripts/cpr-taper.mjs, exact),
              AnchorValue: f64 dB}
       [pan≠0 only] Pan{Value: i64 (pan<0 ? round(p*64) : round(p*63)), Min −64, Max 64}
```

All generated class names are **full-form** (duplicate definitions are legal, M1 edge
case 4) — no dependence on donor interning survives inside generated records. PPQ = 480.

**Ref healing (new in M2, generic):** deleting the donor tracks kills interned name
definitions that later donor records back-reference. `healArch` walks the ARCH in emit
order and converts any ref whose definition no longer precedes it into a full-form
definition in place, then rebuilds every rec-node anchor (name-length-field deltas
recomputed from the healed elem layout) so the M1 serializer can recompute all ids.
On this donor exactly **2 refs heal**: `FAttributes v0` (@0x1bbba) and `MTrack v2`
(marker track's channel node) — both defined inside deleted track 1. Verified: running
heal on the *unmodified* donor still serializes byte-identically.

## Unknowns punted with donor/native-save bytes

- `u32 0x208, u32 0x24F` pair in `MListNode`/`MMidiPart` heads (editor view state?) —
  copied from native C5 saves; donor track 1's own list node lacks the pair (layout
  variant, undecoded).
- note/event `u32 flags = 0x02000000` — constant on every corpus note; meaning unknown.
- note tail `f64 0 + u8[9] 0` after lengthTicks — all zeros in corpus; meaning unknown.
- track-event `f64 lengthTicks 576000` (donor's value; importer ignores it for MIDI).
- tempo record trailing `u32 0` + signature trailing `u32 0` pads (donor-shaped).
- `u16` after the 22B MTrackList head assumed = track count (7→N; consistent with donor).
- `MMidiPartEvent`/`MMidiTrackEvent` emitted chainless, `MMidiPart : MPartNode` with
  chain — byte-modeled on the native C5 save, not understood structurally.

## What M3 / real-Cubase validation must check

1. **The synthetic channel tree is the #1 acceptance risk.** Real C5 MIDI tracks carry
   NO `FF FE A4 C8` tree — their fader/pan live in the undecoded binary `MMidiTrack` →
   `PMidiChannel` blob (0..127 MIDI volume, not the 25856 taper). A generated
   `MMidiTrackEvent` also *omits* `PMidiChannel`, `FAttributes`, `PControllerLaneSetup`
   entirely. Cubase may (a) reject the file, (b) drop/reset the MIDI channel strip, or
   (c) desync its sequential body reader. M3 must either decode `PMidiChannel` and write
   the real thing, or validate Cubase tolerates the missing/extra members.
2. **`MListNode` head variants**: donor track 1 (`lpstr + u32 0` + tempo/sig + `u32 0`)
   vs everything else (`lpstr + 3×u32 [+recs] + u32 partCount`). The writer uses the
   second shape everywhere incl. the tempo-bearing first track — matches the native-C5
   `haolam` first track, but Cubase must confirm.
3. **partCount semantics** when >1 (native saves observed only 0/1 in the examined
   files; the 2-clips case writes 2).
4. Whether Cubase requires the deleted donor extras (`MAudioTrack` channels count in
   some device-side table? `PArrangeSetup` selection referencing track ids?) — the
   donor's `PArrangeSetup`/window layouts still describe 7 audio tracks.
5. Tempo written as a 1-point map with `modeFlag 0`; Cubase's tempo-track editor should
   show exactly one point at 120→N bpm (donor pad u32 meaning unverified).
6. Healed full-form re-definitions (`FAttributes`, `MTrack` mid-stream): Cubase's reader
   interns by offset so duplicates are grammatically fine (1,860 duplicates across the
   corpus), but a real load test should confirm these two specific sites.
7. False-positive record recognition inside generated note streams: a note whose
   `lengthTicks` low bytes form `0x80000000|liveId` would get its bytes rewritten by a
   *future* re-splice (not by this writer's single pass — byte-sanity guards it). Any M3
   pipeline that re-parses + re-splices generated files must re-run the byte-sanity gate.

## Oracle mechanics (for reuse)

`scripts/cpr-write-test.mjs`: writes the 4 case files to a temp dir, boots
`build/bin/Release/mydaw-engine.exe` with `APPDATA`/`LOCALAPPDATA` pointed at a scratch
dir (fresh settings, no plugin folders), WS envelope `{id,type,payload}` →
`{replyTo,ok,payload}`; `project/importForeign {path}` (reply carries the project, and
the session adopts it) then `session/hello` re-fetches it for comparison; the engine
child is killed by **its recorded pid** only. Wall time ≈ 3 s incl. the 60-file corpus
regression.
