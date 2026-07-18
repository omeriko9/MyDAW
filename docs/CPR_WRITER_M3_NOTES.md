# CPR Writer — Milestone 3 notes (real-Cubase failure diagnosis + bisect ladder)

> Written 2026-07-16, updated same day with the ladder-v1 verdict (§"v1 results"),
> ladder v2 (`scripts/cpr-bisect-build2.mjs`) and its verdict (§"v2 results"), and the
> resulting PIPELINE v2 now default in `scripts/cpr-write.mjs`.
> Status: **RESOLVED for the writer pipeline** (v2 mechanisms human-validated in
> Cubase 5.1.1); open items: C13 behavior, MRoot-table row visibility, tempo-patch
> confirmation (`out/cpr-bisect-v3/`), track-duplication (28-hang, not pipeline-used). Real-Cubase results on the M2 output
> (donor `playground/cubase5-7track.cpr`): **Cubase 5.1.1 → "Invalid project file";
> Cubase 13 and Cubase 7-32bit → "created with Cubase Version 5.1.1 — this program
> version cannot load it."** Deliverables: `scripts/cpr-bisect-build.mjs` +
> `out/cpr-bisect/` (12-stage ladder + README checklist for ONE more manual run),
> two real user projects added to round-trip coverage, and the ranked suspect list
> below (from a byte-level diff of generated tracks vs native C5 MIDI tracks).

## New real-file round-trip status (M1 library)

Both new REAL user projects round-trip **byte-identically at both levels with zero
library changes** — they exposed no new container/record grammar:

| file | size | era detected | app / version stream |
|---|---|---|---|
| `Cubase Projects/2007/marh-april/tapetim.cpr` | 3,581,183 B | **sx** | "Cubase SX" / "Version 2.0.2" |
| `Cubase Projects/2025/08-02 Rony Mix/rony3.cpr` | 783,983 B | c12 | "Cubase" / "Version 13.0.30" |

They are user files (read-only, not copied into the corpus); regression coverage is via
explicit args: `node scripts/cpr-roundtrip-test.mjs "<tapetim path>" "<rony3 path>"`
(2/2 PASS) alongside the unchanged default corpus run (60/60 PASS). The M2 oracle
(`scripts/cpr-write-test.mjs`) also still passes 4/4 after this milestone's writer
changes (which are default-off; default output stayed byte-identical).

**Surprise: tapetim is NOT a C5 project.** It's a real Cubase SX 2.0.2 save
(2007 folder, SX-era streams: `Devices|FMemoryStream`, Version chunk LAST, `PArrangement`
chain `GDocument:GModel:FShared:CmObject`, `MMidiTrackEvent` **v2**, no-BOM lpstrs). So it
cannot replace the C5 donor for the generator; in the ladder it serves as a real-file
identity control (stage 10) and a splice-machinery test (stage 11, duplicate its own track).

## Version|PAppVersion — donor vs tapetim vs rony3

Byte-level (see stage 00/10 rationale in the ladder README):

```
donor  (C5):  PAppVersion v2, chain CmObject:      "Cubase"    "Version 5.1.1"   "Nov 23 2009"  u32 0x190  "WIN32"  u32 0  "UTF-8"  "us"
rony3 (C13):  PAppVersion v2, chain CmObject:      "Cubase"    "Version 13.0.30" "Mar 13 2024"  u32 0x190  "WIN64"  u32 0  "UTF-8"  "us"
tapetim (SX): PAppVersion v0, chain FShared:CmObject: "Cubase SX" "Version 2.0.2"  "Mar 12 2004"  u32 0xdc   (record ends)
```

- The donor's Version stream is **retail-clean**: app string is exactly "Cubase" (no
  LE/Essential/Studio/AI marker anywhere in the file), build date Nov 23 2009 is the
  genuine 5.1.1 build, and the v2 field layout is identical to a real C13 save
  (same mystery `u32 0x190`). **No app-variant marker exists that would explain a C13
  version gate** — which is why the ladder's stage 00-in-C13 test matters: if verbatim
  donor bytes open in C13, the "cannot load it" dialog on generated files is simply
  Cubase's parse-failure dialog quoting the creator version, i.e. the SAME bug as C5's
  "Invalid project file", not a second (gate) bug.
- The `u32` after the date (0x190 = 400 in both C5.1.1 and C13.0.30; 0xdc = 220 in
  SX 2.0.2) is NOT a monotonic format-version — meaning undecoded, but identical
  donor-vs-C13 values make it an unlikely refusal trigger.

## Static divergence: generated track vs native C5.1.1 MIDI track

Reference: `all_cprs/haolam sheani metzayer.cpr` (native Cubase 5.1.1 save with 5 real
`MMidiTrackEvent v3` tracks) vs `writeCpr` output. Native track layout:

```
MMidiTrackEvent v3 {                       (chainless — matches ours)
  raw 26B  u16, f64 start, f64 len, f64 0  (matches ours)
  MListNode v0 { lpstrBOM name, u32 0, u32 0x208, u32 0x24F, u32 partCount, parts… }
  raw: u32 tagCount(=4), 'aLoC' v0x22 → PControllerLaneSetup rec,
       'braF' v1 + u32, 'otuA' v1 + 8B, 'psnI' v0x22 → FAttributes rec
  MMidiTrack v5 { 116B head (output-device GUID lpstr, "Input 1", …),
                  PMidiChannel v0 chain[PMixerChannel:PChannel:PDeviceNode:FNode]
                  (~4KB: 2 splitters, MIDI Modifiers, 4 insert slots, sends, fader) }
  raw 12B  (u32 0x26, u32 0, u32 0)
  MAutomationNode v1 { lpstrBOM "Automation", …, MAutomationTrack v2 }
  raw 13B  FF FF FF FF FF FF FF FF 00 00 00 00 00   (trailer; -1/-1 device ids?)
}
```

The donor's own `MAudioTrackEvent`s follow the same skeleton (tag list = otuA+psnI,
`MAudioTrack v0 chain[MTrack v2]` whose body opens `00 01, lpstr "VST Multitrack",
u32 0, u8 1, FF FE A4 C8 <channel attr tree>`, then `MAutomationNode`, then a 6-byte
tail). Scanned: **`FF FE A4 C8` appears exactly once per audio/device-channel track,
inside the `MAudioTrack` body — and ZERO times in any native MIDI track** (all 5
haolam MIDI tracks, all tapetim MIDI tracks).

### Ranked suspects for the C5 "Invalid project file"

1. **Missing native members after `MListNode` — the sequential reader lands on our
   synthetic tree.** After reading the part list, C5's `MMidiTrackEvent::read` expects
   `u32 tagCount` + tagged members + an `MMidiTrack` record + automation node + 13-B
   trailer. Our generated track supplies NONE of these; the very next bytes are the
   synthetic `FF FE A4 C8` blob (or, without it, the record just ends). Reading
   `FF FE A4 C8` as tagCount (4,294,616,264) or hitting end-of-record mid-member is an
   immediate misparse ⇒ "Invalid project file". *Ladder: stage 04 fails even without
   the tree if the members are mandatory; stage 08 proves native members splice fine.*
2. **First-track MListNode head shape.** Every native tempo-carrier observed (donor
   track 1, haolam's folder→`MDeviceTrackEvent`) uses `lpstrBOM + u32 0` then the
   tempo/signature records then `u32 partCount` — **no `0x208/0x24F` pair**. Nodes
   that DO carry the pair never contain event records. Our writer emits
   pair **+** tempo/sig **+** partCount in one node — a hybrid never produced by
   Cubase. (M2's note that this "matches the native-C5 haolam first track" was wrong —
   haolam keeps its tempo in a device track inside the first folder, pairless.)
   The pair values are editor-view geometry (donor automation nodes use 0x19a/0x1e1),
   so a positional reader would consume tempo-record header bytes as geometry.
   *Ladder: stage 07.*
3. **The synthetic `FF FE A4 C8` Volume/Pan tree itself.** Attested nowhere in a native
   C5 MIDI track (fader/pan live inside `PMidiChannel`, MIDI-scaled 0..127, not the
   25856 taper). Even if suspects 1–2 were fixed, C5 would still meet an unexpected
   blob where the track record should have ended. It exists purely for MyDAW's
   importer oracle. *Ladder: 05 vs 06 isolates it.*

Secondary (kept on the list, not ranked-top): empty `MTrackList` legality (03b),
donor leftovers describing 7 audio channels (`PArrangeSetup`, WindowLayouts,
`Devices|FAttributes` VST-mixer state) while the track list holds MIDI tracks, and
mid-stream healed duplicate defs (02) — each has its own ladder stage, so the single
manual run adjudicates all of them.

## The bisect ladder (deliverable)

`node scripts/cpr-bisect-build.mjs` → `out/cpr-bisect/` — 12 files, each adding one
mechanism (00 donor verbatim → 01 identity → 02 heal-only → 03a/03b deletion →
04 +1 track → 05 +notes → 06 +channel tree (= the failed M2 output, byte-identical) →
07 native-head fix probe → 08 real-native-track transplant → 10 tapetim identity →
11 tapetim self-duplicate). Test procedure + interpretation table:
`out/cpr-bisect/README.md`. Every stage is asserted byte-stable through the M1 library
at build time.

Writer additions for the ladder (backward-compatible, `scripts/cpr-write.mjs`):
`writeCpr(model, donor, opts)` with `opts.channelTree=false` (omit synthetic tree) and
`opts.nativeFirstTrackHead=true` (pairless tempo-carrier head); `buildIdInfo`,
`healArch`, `clsName` are now exported. Defaults reproduce M2 output byte-for-byte
(verified by cmp + oracle 4/4).

## v1 results (Cubase 5.1.1 manual run, 2026-07-16) + what they changed

| stage | result |
|---|---|
| 00 donor verbatim, 01 identity, 02 heal-only, 03a delete-keep-first | **OPEN** |
| 03b delete-ALL + 04..08 (all were built on the delete-ALL base) | FAIL "Invalid project file" |
| 10 tapetim identity | **OPEN** |
| 11 tapetim + duplicated own track | FAIL "Invalid project file" |

**Exonerated:** the whole M1 container layer, ref healing (+31 B id cascade, 02), and
track deletion per se (03a). **Confounded:** every v1 stage 04–08 stacked on 03b's
delete-ALL base (`writeCpr` replaces the child list wholesale; 08 likewise kept only
the transplant), so their failures are likely inherited — none of them tested the
generated grammar in isolation. C13/C7-32 results for stage 00 still pending.

### Two id systems decoded while diagnosing 11 (both offset-valued, both splice hazards)

1. **Audio-pool object ids** (tapetim, isi-good — any project with audio clips): record
   bodies store *absolute archive offsets* (`dataStart − base` of the target record) as
   object links — measured in tapetim: `AClusterSegment→AudioFile` ×69,
   `AudioCluster→FNPath` ×65, `AudioFile→FNPath` ×63, `GTreeEntry→PAudioClip` ×6,
   `PAudioProcessCommand→PAudioClip` ×2, plus the known `MAudioEvent`+26 clip links.
   The reader derives identities from *current* positions (our importer mirrors this —
   the diff-proven `clipId = dataStart − base` rule), so ANY insertion/deletion before
   the pool dangles every stored link after the edit point. This alone explains v1-11:
   the appended 3,486 B clone shifted 63 pool clips + their cluster graph.
   The duplicated MIDI track itself carries **no** genuine unique ids (all candidate
   u32s in its body are editor-geometry values, e.g. tapetim's pair 0x27E/0x2C5 —
   the `0x208/0x24F` pair by another window size).
2. **The MRoot track table**: `MRoot`'s trailing raw is `u16 count + count × {u16
   rowKey, u32 id}` where every id is a *track-event record's* `dataStart − base` —
   verified exactly across donor (7×MAudioTrackEvent), isi-good (13 entries: audio,
   MIDI, folders, device tracks, even an MMidiPartEvent), not-important, s-01.
   v1's 03a (OPEN) proves dangling entries are tolerated *as long as… something*
   (entry 1 stayed valid there); in 03b/04+ **all** entries dangled. Generated tracks
   are absent from the table in every v1 stage. Ladder v2 stage 29 probes rebuilding it.

**Revised suspect ranking for the remaining C5 failures** (was: missing-members #1,
hybrid head #2, synthetic tree #3 — all three are now UNTESTED rather than implicated,
because of the base confound):

1. **The 03b base itself** (empty track list / no tempo carrier / fully-dangled MRoot
   table) — explains 03b..08 in one stroke; v2 stages 20–23 re-test every generated
   mechanism on the proven 03a base.
2. **Stale stored-offset ids after ANY insertion into id-rich files** — proven present
   in tapetim (v1-11) and isi-good; v2 stages 24/25/26 (rebase vs position vs track
   type) and 28 (rebase on genuine C5) adjudicate; the rebase pass (value-exact bump of
   ids ≥ insertion point, 171 ids in tapetim / 66 in isi-good) is the fix candidate.
3. **Generated MMidiTrackEvent grammar** (missing tag list + `MMidiTrack`/`PMidiChannel`
   + automation node + trailer; hybrid tempo head; synthetic tree) — still plausible,
   now cleanly isolated by v2 20→21→22 vs 23 (native transplant on the same base).

### New real files (all READ-ONLY, covered via explicit-args round-trip — all PASS)

| file | size | era | version stream |
|---|---|---|---|
| `2009/December/Isi/isi-good.cpr` | 657,404 B | c5 | "Cubase" / **"Version 5.1.0"** |
| `2011 - Back to root/April 16/not important.cpr` | 212,696 B | c5 | "Cubase" / "Version 5.1.1" |
| `2013/Stam/s-01.cpr` | 107,689 B | c5 | "Cubase" / "Version 5.1.1" |

isi-good as replacement donor: genuine C5 save, 9 top-level tracks incl. **1 real
`MMidiTrackEvent`** (grammar reference!), marker+folders+device tracks, 37 `PAudioClip`s.
Verdict: **better acceptance target, worse splice donor** — its clip-rich pool means any
track splice must run the stored-id rebase (the playground donor has an empty pool, which
is exactly why v1's 02/03a splices survived). v2 stage 28 tests precisely this; if it
opens, isi-good becomes the M4 donor with rebase-on-splice mandatory.

### Ladder v2 (`out/cpr-bisect-v2/`, 10 files — one more manual run)

20 keep1+track → 21 +notes → 22 +tree (M2 grammar on the good base); 23 keep1+native
transplant; 24 tapetim-dup **with id rebase** / 25 dup-first no-rebase / 26 dup-folder
no-rebase; 27 isi identity / 28 isi dup-MIDI-track with rebase; 29 = 20 + MRoot table
rebuilt (7→2 entries pointing at the real tracks). Writer gained
`opts.keepDonorTracks` (append after kept donor tracks; kept track 1 stays tempo
carrier) — default output still byte-identical to M2; oracle 4/4.

## v2 results (Cubase 5.1.1 manual run, 2026-07-16) — root causes closed

| stage | result | meaning |
|---|---|---|
| 20 keep1+track, 21 +notes, 22 +channel tree | **OPEN** | the generated MIDI grammar — incl. notes, part registry, and the synthetic `FF FE A4 C8` tree — is ACCEPTED by C5 on the keep-donor-track-1 base. v1's grammar suspects (missing PMidiChannel members, hybrid tempo head, synthetic tree) are all *non-fatal*. |
| 23 keep1+native transplant | **OPEN** | cross-file transplant machinery fine |
| 24 tapetim dup **with id rebase** | **OPEN** | stored-offset-id rebase VALIDATED — id-rich (clip-bearing) files survive splices when pool ids are rebased |
| 25 dup-first no-rebase, 26 dup-folder no-rebase | FAIL | confirms the pool ids (not insert position, not track type) were v1-11's cause |
| 27 isi identity | **OPEN** | genuine C5.1.0 identity control |
| 28 isi dup-MIDI-track + rebase | **HANG** (not refused) | open: C5-era duplication leaves something cyclic/inconsistent (suspect: duplicated internal object identities — NOT hit by the writer pipeline, which generates rather than duplicates) |
| 29 = 20 + MRoot table rebuilt 7→2 | FAIL | rebinding table rows is WORSE than leaving them stale |

**Final root-cause writeup (C5 "Invalid project file" on M2 output):** deleting ALL
donor tracks (M2's splice base) is what C5 refused — 03b fails with zero generated
bytes, and every mechanism M2 layered on top was acceptable once the base kept donor
track 1 (v2 20–22). Contributing-but-independent: any insertion into clip-bearing
projects dangles the pool's stored offset-ids (v1-11 / v2 24-vs-25/26), and rebuilding
the MRoot track table breaks files that its stale version does not (v2 29 vs 20).
Why 03b specifically dies — empty `MTrackList`, absent tempo carrier, or a fully
dangling track table — remains formally unresolved (and no longer matters for the
writer, whose base always keeps the carrier).

**MRoot track-table semantics (from real saves + v2):** entries = `{u16 rowKey
(persistent track UID: gaps where tracks were deleted, order ≠ list order), u32 id
(track record dataStart − base)}` covering real tracks incl. nested folder/device
tracks — NOT automation lanes, NOT the marker track. Real Cubase saves themselves
contain stale/mistyped entries (isi-good has one pointing at an `MMidiPartEvent`), and
C5 opens files whose entries dangle (v1-03a, v2-20..22) or whose tracks are missing
from the table — but refuses a table REBOUND to different track content under an
existing rowKey (v2-29: key 2, previously an audio track, pointed at the generated
MIDI track; per-row state elsewhere — window layouts/inspector/mixer — presumably
still describes the old track). Writer policy: **never touch the table**.

## PIPELINE v2 (now the `scripts/cpr-write.mjs` DEFAULT)

- `keepDonorTracks` defaults to **1**: donor track 1 (native tempo/signature carrier +
  valid table entry 1) kept; generated tracks appended after it. `model.tempo` is
  applied by a same-length in-place float patch of the kept `MTempoTrackEvent`
  (f32 secondsPerQuarter @+4, f32 bpm @+26) — importer-validated; real-C5
  confirmation file: `out/cpr-bisect-v3/30-keep1-tempo-96.5.cpr`.
- **Stored-offset-id gate** (always on): known id-bearing owners
  (`AudioCluster`, `AudioFile`, `AClusterSegment`, `GTreeEntry`,
  `PAudioProcessCommand`, `MAudioEvent`) are value-scanned in the donor; ids at/after
  the edit boundary are rebased by the uniform edit delta, and after serialization
  every known-owner site is re-resolved and must map to a record of the original
  class — `writeCpr` throws rather than ship a dangling pool link (this is the gate
  the 28-hang demanded; it runs inside every `cpr-write-test.mjs` case via the
  writer). MRoot-table sites are exempt-but-verified-when-alive; other value matches
  are counted as coincidences (`stats.ignoredIdMatches`).
- Stats now report `keptDonorTracks, rebasedIds, verifiedIds, staleTableIds,
  ignoredIdMatches`.
- Legacy M2 behavior = `keepDonorTracks: 0` (kept ONLY so
  `scripts/cpr-bisect-build.mjs` reproduces the v1 artifacts byte-identically; both
  ladder builders were re-run and reproduce the human-tested files exactly).
- User-facing samples regenerated (`scripts/cpr-export-samples.mjs` →
  `out/cpr-export-samples/`, README updated: every sample now carries the kept audio
  "Track1"; asks the user to check generated-row visibility, non-120 tempos, and to
  try one sample in Cubase 13).

## What the next milestone implements once the ladder verdict is in

- Predicted: generate the native member sequence — tag list (`aLoC` +
  `PControllerLaneSetup`, `braF`, `otuA`, `psnI` + `FAttributes`), a minimal
  `MMidiTrack v5`/`PMidiChannel` (decode the ~4KB channel body; stage 08's transplant
  is the byte reference), `MAutomationNode`, and the 13-B trailer — and drop the
  synthetic tree in favour of writing volume/pan into `PMidiChannel` (keeping the
  importer's modern reader in sync).
- If C13 also refuses stage 00: re-save the donor in C5.1.1 (or pick a corpus donor
  that C13 provably opens) and re-base.
- Regardless of the v2 verdict, two writer invariants are already established: (a) any
  splice into a file with audio clips must rebase the pool's stored offset-ids (and the
  `MAudioEvent`+26 clip links) past the edit point; (b) the writer should maintain the
  MRoot track table (count + `{rowKey, trackRecordId}` entries) to match the emitted
  track records — pending 29's verdict on whether it is load-bearing or hygiene.

## C++ port (2026-07-16 — in-engine writer + UI wiring)

PIPELINE v2 is now ported into the MyDAW engine as
`engine/src/export/CprWriter.h/.cpp` (container layer + writer + post-splice verifier
in one translation unit, `export/cpr` endpoint in `engine/src/server/Api.cpp`,
File > Export > "Export Cubase Project (.cpr)…" in `ui/src/components/Transport/
MenuBar.tsx`, agent-catalog exclusion like `export/trackArchive`). The port is
v2-defaults-only: `keepDonorTracks` fixed at 1, channel tree always emitted, no
generated tempo/signature records (unreachable with a kept carrier), no ladder opts.

**Correctness bar = byte parity with `scripts/cpr-write.mjs`** for the same model JSON
+ donor, via the hidden test mode `mydaw-engine --cpr-write <model.json> <out.cpr>`
(bypasses engine boot; `CprWriter::writeModelJson` consumes the exact M2 model shape):

| model | bytes | parity |
|---|---|---|
| 1 track / 1 note (tempo 120) | 43,337 | **byte-identical** |
| 3 tracks chords+velocities (tempo 96.5) | 44,874 | **byte-identical** |
| moved faders/pans (−6.97/+3.5/0.5/1.0/0.1 gain; pan ±1/0.33/−0.25) | 45,945 | **byte-identical** |
| 2 clips per track | 45,025 | **byte-identical** |
| tempo 96.5, 1 track (−6.02 dB, pan 0.25, fractional beats) | 43,462 | **byte-identical** |

Parity gotcha worth remembering: **MSVC `std::log10` ≠ V8 `Math.log10`** (1–2 ulp on
e.g. `10^(3.5/20)` and `10^(-6.02/20)`), which flipped low AnchorValue bytes. Fix:
`CprWriter.cpp` embeds a verbatim port of the fdlibm `log10`/`log` pair V8 actually
ships (`v8/src/base/ieee754.cc` = the **classic SunSoft `e_log10.c`**, computing
`y*log10_2lo + ivln10*log(x)` — NOT FreeBSD msun's `k_log1p` rewrite, which was tried
first and differs from V8 by up to ~2e-7). Also mirrored: JS `Math.round` tie-breaking
(`floor(x+0.5)`) for the pan i64, stable note sort, `writeFloatBE` double→float
rounding. `std::sqrt` needed no shim (IEEE-exact in both).

**Donor shipping:** the exact M2 donor (`playground/cubase5-7track.cpr`, sha256
`a823c1fd…7f44`, 133,463 B) is checked in at `engine/assets/cpr-donor-c5.cpr` and
embedded into the engine as a generated byte array (`engine/src/export/CprDonor.gen.h`
via `scripts/generate-cpr-donor-header.mjs`; `--check` verifies freshness) — no runtime
asset resolution or packaging concerns.

**Model mapping** (MyDAW `Project` → writer model): MIDI- and Instrument-kind tracks
export as MIDI tracks (notes from MidiClips; instrument plugin NOT exported — warning);
volume through the inverse 25856 taper + AnchorValue dB, pan i64 omit-centered; audio/
bus/folder tracks, inserts, sends, CC, automation, EQ, take folders → warnings +
skipped; multi-entry tempo map → first entry + warning. The verifier throws into the
export error path — a bad file is never written.

**E2E oracle (PASS):** isolated engine (scratch APPDATA, `--port 8435 --driver null
--no-browser`, killed by recorded pid), mixed project seeded over WS (3 MIDI/Instrument
tracks incl. 2-clip track + audio track + bus + send + 2-entry tempo map),
`export/cpr` → 45,114 B, re-parses byte-stable through `cpr-container.mjs` as c5,
`project/importForeign` round-trip matches (names/kinds/notes exact, tempo 96.5,
volume ≤ 0.01 dB, pan ≤ 0.02) with the expected 5 warnings. Regressions all green:
`cpr-write-test.mjs` 4/4 + corpus 60/60 against the new binary; UI `tsc --noEmit`,
`npm run build`, `npm test` (201 tests incl. the updated catalog coverage; exclusions
are now 4 — `scripts/generate-agent-catalog.mjs` count bumped).
