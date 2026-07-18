# CPR Writer — Milestone 1 notes (container layer, lossless round-trip)

> Written 2026-07-16. Deliverables: `scripts/cpr-container.mjs` (parse/serialize library),
> `scripts/cpr-roundtrip-test.mjs` (corpus acceptance test). Success criterion: byte-identical
> round-trip across the corpus. Format authority: [CPR_MIXER_FORMAT.md](CPR_MIXER_FORMAT.md) §0.

## Results

60-file corpus selection (playground trees + non-`all_cprs` corpus files + evenly spaced
`all_cprs`; empty and >50 MB files skipped — the 9 zero-byte `all_cprs` stubs are excluded
by the size filter):

| era | files | shallow (chunks opaque) | deep (record/interning layer) |
|---|---|---|---|
| SX (2.x, 2004) | 47 | 47/47 | 47/47 |
| C5 (5.1) | 10 | 10/10 | 10/10 |
| C12 (12.0) | 2 | 2/2 | 2/2 |
| unknown (corrupt experiment `a_.cpr`, see below) | 1 | 1/1 | 1/1 |
| **total** | **60** | **60/60** | **60/60** |

Recomputed (NOT copied) at the deep level, across the corpus: **49,639 record `size`
fields, 45,835 back-ref ids (pointing at 1,066 distinct name definitions), 5,589 interned
name length fields**, plus every chunk size, ROOT string length and the riffSize. The
remaining ~99% of ARCH bytes are record *bodies* (lpstrs, floats, fxb plugin state,
attr-tree payloads, stale-save garbage) kept as verbatim `raw` spans — by design at M1;
those are the layers M3+ will progressively structure.

Deep-representative detail (era picked by the §0 detection rules): all three round-trip
byte-identical with the full record layer recomputed on every ARCH stream —

- **SX** `playground/Play2/dblDelay1st.cpr` ("Cubase SX / Version 2.0.2"): 171 records over
  4 ARCHes (Arrangement 164 records to depth 7, 137 back-refs).
- **C5** `playground/cubase5-7track.cpr` ("Cubase / Version 5.1.1"): 291 records over
  6 ARCHes (Arrangement 267 records, 186 back-refs).
- **C12** `playground/only_effects_5_tracks_cubase12.cpr` ("Cubase / Version 12.0.60"):
  346 records over 7 ARCHes (Arrangement 312 records to depth 8, 203 back-refs).

**Recomputation proof (mutation self-test, `--deep` mode):** growing one interned class
name by 1 byte re-serializes with every later back-ref id shifted by exactly +1 (earlier
ids untouched), ancestor record sizes grown, and the output re-parses isomorphically —
matching the diff-proven Cubase behavior ("insertions shift every later back-ref
uniformly"). PASS on all three era representatives (SX 136/137 refs shifted — the
exception is a ref *to* the mutated first def itself; C5 186/186; C12 197/203, the 6
unshifted being refs to id 0).

## Container grammar — edge cases hit

1. **riffSize excludes the form fourcc.** `riffSize = fileSize − 12` on every well-formed
   file (= Σ per chunk (8 + size)); standard RIFF would be `fileSize − 8`. The writer
   recomputes it that way. No even-byte padding exists anywhere — chunk sizes are
   frequently odd and the next chunk starts immediately.
2. **ROOT strings have no NUL** (`u32be len + chars`), unlike `lpstr` inside record data
   (`u32be len INCLUDING the NUL + chars + NUL`). ROOT payload = exactly two such strings
   in every corpus file; the parser accepts any count that exactly tiles the payload and
   otherwise keeps the chunk opaque.
3. **Interning id base**: id = length-field offset − (archDataOff + 4). ARCH payloads open
   directly with a `FFFFFFFE` chain, so the very first class name of the stream has id
   **exactly 0** — i.e. `0x80000000` itself is a valid back-ref (id 0), seen 7,706 times
   across the corpus. Only `0xFFFFFFFE`/`0xFFFFFFFF` are reserved markers.
4. **First-use interning is NOT strict.** The same class name is *re-defined in full*
   multiple times inside a single ARCH — 1,860 duplicate definitions across 59/60 files
   (e.g. `CmObject` twice in an SX `Devices|FMemoryStream` ARCH: each embedded device
   memory-stream was serialized in its own interning context before being pasted into the
   ARCH). Back-refs may target *any* of the same-named definitions, so definitions must be
   keyed by byte offset (identity), never canonicalized by name, and each occurrence's
   full-vs-ref *form* must be preserved as parsed. A writer that re-derives
   "full-on-first-use" from a name set would corrupt these files.
5. **Name definitions can live outside recognized records.** The reference scanner
   registers class names during *speculative* header attempts that ultimately fail, so a
   later genuine back-ref can point into what the tree keeps as a raw span. The serializer
   anchors every referenced definition as (containing atom, byte delta) and recomputes its
   id from the atom's emitted position. Not exercised by the 60-file corpus (all 1,066
   referenced defs sit inside recognized record headers) but kept — the walker is a
   heuristic and deeper structuring in M3+ will shift the recognized/raw boundary.
6. **Base-class chain elements carry a version only in full form**: `FFFFFFFE + name + u16
   ver` vs `FFFFFFFE + u32 (0x80000000|id)` (no version). The concrete record after a
   chain is always full-form (`FFFFFFFF …`); back-ref record occurrences (`(0x80000000|id)
   + u32 size`) never carry chain or version.
7. **Stream ordering differs by era** (confirmed writer-side): SX = Arrangement, Devices
   (`FMemoryStream`), WindowLayouts, Version **last**; C5 = Version **first**, Devices
   (`FAttributes`), + ProjectLayouts + `Metadata|StMedia::PAttributes` (class names may
   contain `::`); C12 additionally `ComputerGuid|CmString` after Arrangement. Chunk order
   is preserved as parsed, never normalized.
8. **Corrupt/experimental container**: `playground/a_.cpr` is `a.cpr` with structural u32s
   byte-swapped to little-endian (a historical experiment file). The chunk loop detects
   the first chunk overrunning the file and falls back to keeping everything after the
   12-byte header as a verbatim tail — still a byte-identical round-trip. Era detection
   reports `unknown`.
9. **Max nesting observed**: record depth 8 (C12 Arrangement). The walker caps at 96;
   beyond the cap a subtree would degrade safely to a verbatim raw span.
10. **Stale-save garbage** (CPR_MIXER_FORMAT.md §6: outer record sizes that didn't shrink,
    remnant bytes of previous saves inside the gap) lands in raw spans and round-trips
    untouched. Trusting inner `size` fields and keeping gaps verbatim is exactly right for
    a writer, too.

## What M2 (record splicing) needs to watch for

- **Insertion shifts ids ARCH-locally.** Recomputed back-ref ids already handle this
  (mutation test), but any *numeric id stored inside record bodies* (raw spans) will NOT
  shift — e.g. `MAudioEvent`'s clip link at +26 is `u32 clipId = clip record dataStart −
  (archDataOff+4)` (CprImportProvider.cpp ~1006). Splicing records before a `PAudioClip`
  breaks such body-level offset links unless M2 structures them. Inventory needed of every
  body field that encodes an archive offset (clip links are the known one).
- **Duplicate-name contexts** (edge case 4): when generating a new record, referencing the
  interning entry Cubase would reference means picking the *right* definition among
  same-named ones; inside `FMemoryStream` device blobs interning appears context-local.
  Safest: splice only inside the Arrangement ARCH where interning is flat, and emit full
  names for classes whose prior definitions are inside device sub-blobs.
- **Refs to id 0 are common** — never use 0/0x80000000 as a sentinel.
- **Record `size` cascades**: ancestor sizes are recomputed automatically by this layer;
  but SX outer records tolerate slack (garbage gap, §6) — after splicing, inner records
  moved within a slack-bearing parent must keep the parent's *original* outer size only if
  we choose bit-exact conservatism; Cubase itself re-tightens on save. M2 should decide
  policy per record class and verify against real Cubase re-saves.
- **Era-specific stream sets** (edge case 7) when creating streams from scratch, and the
  `Version|PAppVersion` position rule for era detection by other readers.
