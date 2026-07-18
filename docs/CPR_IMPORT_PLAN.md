# CPR Import Provider — Implementation Plan

> Cubase .cpr (SX2 / 2.0.2) project file import into MyDAW.
> Uses knowledge from reverse engineering + CubaseFileFormat/Parse projects.

> **STATUS: IMPLEMENTED 2026-06-12** — `engine/src/import/CprImportProvider.cpp`,
> verified against a 60-file corpus spanning Cubase SX 2 (2004) → Cubase 13 (2026).
> Key corrections found during implementation (this plan predates them):
> sizes and string length prefixes are **BIG-endian** (no LE pointer-chasing);
> the body is ROOT/ARCH chunk pairs, not a sibling/child pointer tree; MIDI events
> live in MMidiPart event streams (480 PPQN); tempo decodes from fixed-mode flag or
> tempo-track points; `AudioFile` channel count lives at +12 (the +10 u16 is
> bytesPerFrame). See `scripts/cpr-analyze.mjs` (object-tree dumper) and
> `scripts/cpr-import-test.mjs` (corpus test).

---

## 1. Goal

Read a `*.cpr` file and create a new MyDAW project with:
- **MIDI tracks** → `TrackKind::Midi` + `MidiClip` + `Note`/`MidiCc`
- **Audio tracks** → `TrackKind::Audio` + `AudioClip` + `Asset` (imported WAV)
- **Tempo / time signature** from tempo tracks
- **Markers** from marker sections
- **Track names and colors** preserved

We do **not** implement VST plugin recreation (VST state is proprietary and version-dependent). VST references are logged but not imported.

---

## 2. Architecture Overview

```
Cubase.cpr
    │
    │  CPRImporter::parse(path, err)
    │  ┌─────────────────────────────────────────────┐
    │  │ 1. Read all bytes into std::vector<uint8_t>  │
    │  │ 2. Walk section tree: ROOT → ARCH → children │
    │  │ 3. Collect:                                    │
    │  │    - MTrackList → tracks (name, type, data ptr)│
    │  │    - MMidiTrackEvent → MIDI note/CC data       │
    │  │    - MAudioTrackEvent → audio clips, SSnd refs │
    │  │    - MTempoTrackEvent → tempo map entries      │
    │  │    - MSignatureTrackEvent → time sig           │
    │  │    - PAudioClip + FNPath → WAV path            │
    │  │ 4. Convert to Model                            │
    │  │ 5. Call AssetStore::importFile for WAV files   │
    │  │ 6. Return (out nextId used for all allocations)│
    │  └─────────────────────────────────────────────┘
    │
    │  MyDAW adoption: stop transport → swap model →
    │  recreate plugins → AssetStore::loadAsync → markDirty
    │
    ▼
   Model { project.tracks, project.assets, project.tempoMap, ... }
```

**Header**: `CPRImporter.h` — pure-declare class, no external deps beyond Model/AssetStore
**Source**: `CPRImporter.cpp` — parsing + model conversion logic

---

## 3. CPR File Format Reference (from reverse engineering)

### 3.1 File Header
```
Offset 0x00: "RIFF" or "NUND" magic (4 bytes)
Offset 0x04: file size or "0000" (4 bytes)
Offset 0x08: "NUND" / "NUNDROOT" root object type (4 ASCII)
Offset 0x0C: NUND object size (4 bytes, LE)
Offset 0x10: first child object — typically "Arrangement1"
```

### 3.2 Section Object Layout
Each object in the tree:
```
[4-byte ASCII type ID]
  ↓ then, after the type name (variable, null-padded to 4):
[4-byte pointer to next sibling] (LE uint32, 0xFFFFFFFF = end)
[4-byte pointer to child objects] (LE uint32, 0xFFFFFFFF = no children)
[4-byte data size / padding] (LE uint32)
[optional 4-byte padding]
```

**Key separators**: `0xFF 0xFF 0xFF 0xFF` (end of children), `0xFF 0xFF 0xFF 0xFE` (end of siblings)

### 3.3 Section Name Back-References
Names can appear as literal strings OR back-references. A back-ref is an int32 >= 0x80000000,
decoded by subtracting 0x80000000 and adding 0x43 to get the offset of the 4-byte size field
for that name in the file. The constant `0x43` is the offset between the encoded value
and the actual name location.

### 3.4 Track Structure (inside MTrackList)

**MTrackList header** (observed pattern):
```
<string size=9> "Untitled"
00 00              (constant)
00 01 3F F0        (metadata, constant)
00 00 00 00 00 00 00 00   (8 zero bytes)
<string size=N count of tracks>
FF FF FF FE        (delimiter)
```

**Each track** (MMidiTrackEvent or MAudioTrackEvent):
```
4 bytes: track header (includes MListNode back-ref or literal)
26 bytes skip before MListNode
  MListNode:
    [string size 4]
    "MListNode"
    00 00              (constant)
    [section size]
    [string size]
    "<track name>"     (e.g. "MIDI 01", "Audio 05_00")
    00 x 5             (padding)
    FF FF FF FF        (delimiter)
  MTempoTrackEvent (sometimes)
  MSignatureTrackEvent (sometimes)
  MTrack (sometimes)
```

### 3.5 MIDI Track Data (MMidiTrackEvent)

Inside each MIDI track, notes are structured as:
```
MMidiTrackEvent
  MListNode              (track name)
  MMidiPartEvent         (note container)
    MMidiPart
      [track name back-ref]
      [section size]
      MIDI event data...
      FF FF FF FF        (delimiter)
  MMidiEvent             (individual events)
    ...                  (variable events)
  MMidiNote              (note on/off)
  MMidiController        (CC)
  MMidiPitchBend
  MMidiProgramChange
  MMidiAfterTouch
  MMidiPolyPressure
  MMidiSysEx
```

**MIDI note timing**: stored as 8-byte doubles (ticks), with event data at 16-byte intervals.
Tick values range from 0 to ~16384 (2^14). The PPQN (ticks per quarter note) is stored
in the tempo track data.

### 3.6 Audio Track Data (MAudioTrackEvent)

```
MAudioTrackEvent
  MListNode
    track name (e.g. "Audio 05_00")
  MTempoTrackEvent
  MSignatureTrackEvent
  PAudioClip             (audio clip container)
    [1-byte name length at offset +20]
    [name string at offset +21]  (ASCII, e.g. "synth1", "drumbass", "morph-01")
    FPath                (relative path)
    FNPath               (absolute path, e.g. "D:\Projects\...Audio\")
    Wave File            (filename reference)
    AudioStream
    AudioCluster
    AudioFile
    AClusterSegment
  SSnd <section>         (sound chunk, version header)
    [uint32 version]     (1-3)
    [uint32 sample format] = 1 (16-bit)
    [uint32 channels]
    [uint32 sample rate] (e.g. 44100)
    [ssnd data chunk with raw 16-bit PCM]
  Mark <section>         (marker positions)
```

### 3.7 Tempo & Time Signature

```
MTempoTrackEvent:
  00 00 01              (flags/version)
  [4-byte section size]
  [tempo data — raw, unparseable without more analysis]

MSignatureTrackEvent:
  00 00 01              (flags/version)
  [4-byte section size]
  [signature data — raw]
```

### 3.8 VST Mixer (FMemoryStream → "VST Mixer")

Contains VST plugin channels with names, preset names, and effect chains.
Not implemented in import (too proprietary and version-specific).

---

## 4. Implementation Steps

### Step 1 — Skeleton (day 0.5)

**Create files:**
- `engine/src/import/CPRImporter.h` — class definition
- `engine/src/import/CPRImporter.cpp` — stub implementation

```cpp
// CPRImporter.h
class CPRImporter : public ImportProvider {
public:
    std::string id() const override { return "cpr"; }
    std::string displayName() const override { return "Cubase Project"; }
    std::vector<std::string> extensions() const override { return {"cpr"}; }
    bool probe(const std::string& absPath, std::string& whyNot) const override;
    bool import(const std::string& absPath, const ImportContext& ctx, Model& out,
                std::string& err) override;
};
```

**Register in `Providers.cpp`:**
```cpp
#include "import/CPRImporter.h"
// ...
reg.add(std::make_unique<CPRImporter>());
```

**Build:** `pwsh scripts/rebuild.ps1 -Engine` — must compile with zero changes.

---

### Step 2 — Low-level helpers (day 0.5)

Add private static helpers to the `.cpp` file (following `SmfImportProvider` pattern):

```cpp
namespace {
    // Read operations (reuse SmfImportProvider patterns):
    bool readHead(...);
    bool readAllBytes(...);
    uint32_t readU32le(...);
    uint32_t readU32be(...);  // big-endian for section sizes
    uint16_t readU16le(...);
    uint16_t readU16be(...);
    float readFloat(...);

    // Type ID reading:
    std::string readTypeId(const uint8_t* data, size_t offset, size_t& typeIdLen);
    // Reads ASCII chars until null/termination, returns the type string.

    // Back-reference resolution:
    std::string resolveBackRef(const std::vector<uint8_t>& fileBytes, int32_t refValue);
    // if ref >= 0x80000000: offset = ref - 0x80000000 + 0x43

    // Safe string read:
    std::string readAsciiString(const uint8_t* data, size_t offset, size_t maxLen = 128);
    std::string readSizePrefixedString(const uint8_t* data, size_t offset, size_t& bytesRead);
    // Reads 4-byte LE size, then that many ASCII bytes.
}
```

Also: `fileStem()` function (from SmfImportProvider).

---

### Step 3 — Section tree walker (day 1.5)

The core parsing engine. Walk the CPR object tree recursively.

**`SectionNode` struct** (internal):
```cpp
struct SectionNode {
    std::string name;           // parsed section type ID (e.g. "MIDI 01", "MMidiNote")
    size_t offset;              // offset in file where section starts
    size_t dataStart;           // offset where name-payload starts
    size_t dataLen;             // length of payload data
    std::vector<SectionNode> children;
    std::string siblingName;    // track name if this is a track node
};
```

**`parseSectionTree(fileBytes, topOffset, parent)`** function:
1. At current position, read the 4-byte section name size (LE uint32)
2. If size > 0 and size < 64 and name is printable ASCII:
   - Read the type ID string
   - Read siblings/children pointer pattern
3. If pointer is valid (not 0xFFFFFFFF) and within file bounds:
   - Recursively parse children
4. Check for terminator patterns (`0xFF 0xFF 0xFF 0xFF` or `0xFF 0xFF 0xFF 0xFE`)
5. Build a flat/structured tree mapping section name → children

This is the heaviest part. Key challenge: the CPR format uses variable-length
type IDs that are null-padded to multiples of 4. The "pointer after name"
pattern is: after the 4-byte name-size + N bytes of name text + padding NULs,
there are 4 uint32 values: sibling ptr, child ptr, data ptr, padding.

**Algorithm strategy (two-pass recommended):**

**Pass 1 — Flat index:** Scan file for all recognizable section patterns.
For each known section type (MMidiTrackEvent, MAudioTrackEvent, MTrackList,
PAudioClip, MTempoTrackEvent, MSignatureTrackEvent, MMidiNote, etc.),
record its offset, type ID, and raw payload data.

**Pass 2 — Convert to Model:** Walk the flat index and convert to track/clips/notes.
This avoids pointer-chasing and is more predictable for error recovery.

---

### Step 4 — Track extraction (day 1.5)

From the flat index, extract:

**Track extraction** (MTrackList):
1. Find `MTrackList` section
2. Parse its header: "Untitled" string, metadata bytes, track count
3. Walk through each track event: `MMidiTrackEvent` or `MAudioTrackEvent`
4. For each track, find the `MListNode` child and extract:
   - Track name from size-prefixed string
   - Track index (ordinal)

**Track name extraction:**
```
Track name location: inside MListNode (back-ref or literal string "MListNode"
followed by 00 00, section size, 4-byte string size, name string, padding, FF FF FF FF)
```

Track name patterns:
- `"MIDI 00"` through `"MIDI 99"` (zero-padded)
- `"Audio 05_00"` (audio clips)
- `"DirectMusic"` (MIDI device tracks)
- FM preset names like `"FM8"`, `"Battery"` (VST instrument slots)
- Named audio tracks like `"Alya"`, `"bass drum"`

**Track kind determination:**
- If name starts with `"MIDI "` → `TrackKind::Midi`
- If name is `"DirectMusic"` or contains VST instrument name → `TrackKind::Instrument`
- Otherwise → `TrackKind::Audio`

---

### Step 5 — MIDI note extraction (day 2)

**Strategy:** Search within each MIDI track's payload for all note/event patterns.

Two approaches to consider (start simple, improve later):

**Approach A — Name-based search (fast, already working in Python parser):**
Scan the raw file bytes for patterns like:
- `"MIDI 01"` → indicates MIDI track
- `MMidiNote` → note event section
- `MMidiController` → CC event section
- `MMidiPitchBend` → pitch bend

**Approach B — Structural parsing (accurate but complex):**
Inside MMidiPartEvent → MMidiPart → event data:
```
[double tick = 8 bytes]
[event-specific data — variable]
[double tick = 8 bytes]
[event data]
...
```

**Note extraction algorithm:**
```cpp
for each MMidiNote section:
    read 8-byte double → tick
    read note data:
        typically note number (1 byte), velocity (1 byte), duration (variable)
    convert tick → beat:
        beat = tick / ticksPerQuarter (from tempo data)
    create Note with:
        id = out.nextId()
        pitch = std::clamp(note_number, 0, 127)
        velocity = std::clamp(velocity, 1, 127)
        startBeat = clip-relative beat
        lengthBeats = note duration (estimate from next note or known duration)
        channel = channel (0-based, from event data)
```

**CC extraction:** Similar pattern, read controller number (0-127) and value (0-255 normalized to 0-1).

**Handling unknown MIDI structure:** The existing Parse project could not parse
the internal MIDI Part structure. We'll start with a simple approach: scan for
`MMidiNote` sections followed by 8-byte doubles (ticks) and small integer pairs.

---

### Step 6 — Tempo & time signature (day 1)

**Tempo extraction:**
1. Find all `MTempoTrackEvent` sections
2. Parse the section header: `00 00 01` flags + 4-byte section size
3. Tempo data is stored raw (unknown byte-level format without further analysis)

**Fallback strategy:** If tempo data cannot be parsed, use the default 120 BPM.
The MTrackList header contains `3F F0` = 16368 which may encode tempo. Attempt to
decode it:
```cpp
// If 0x3FF0 is a fixed-point or BCD-encoded BPM, decode it
// Otherwise, log warning and use 120 BPM
```

**Time signature extraction:**
Similar approach — find `MSignatureTrackEvent`, parse signature data.
If unparsable, use default 4/4.

---

### Step 7 — Audio track extraction (day 1.5)

**Audio clip extraction:**
1. Find all `PAudioClip` sections
2. Extract clip name: `data[pos + 20]` = 1-byte length, `data[pos + 21:pos+21+len]` = ASCII name
3. Search for WAV path: look for `FNPath` sibling, then search for `.wav` filenames
   in the 500-byte vicinity (existing parser approach)
4. Extract position/volume/duration from floating-point values at known offsets:
   - `pos + 0x150` = position (float)
   - `pos + 0x15A` = volume (float)
   - `pos + 0x190` = duration (float)

**WAV path extraction:**
```
For each PAudioClip:
    Scan nearby area for strings ending with ".wav"
    Skip strings containing "Wave File" (type ID marker)
    Accept ASCII strings 4-100 chars long
    Store as absolute path if found near FNPath
```

**Audio clip creation:**
```cpp
// For each audio clip:
Asset asset;
asset.id = out.nextId();    // before importFile!
std::string aerr;

// Try to import the WAV file
if (ctx.assetStore && !ctx.projectDirHint.empty()) {
    bool ok = ctx.assetStore->importFile(absWavPath, ctx.projectDirHint,
                                         ctx.sessionSampleRate, asset, aerr);
    if (!ok) {
        // Fallback: try using source file in place
        asset.file = "";
        asset.originalPath = absWavPath;
        // Need to know channels/length from SSnd header
        // If unavailable, asset will be marked missing at playback
    }
    out.project.assets.push_back(asset);
}

AudioClip clip;
clip.id = out.nextId();
clip.name = clipName;
clip.assetId = asset.id;
clip.startBeat = positionInBeats;  // convert if needed
clip.lengthSamples = asset.lengthSamples;  // from imported asset
clip.gain = volLinear;  // convert dB to linear if needed
clip.fadeInSec = 0.0;
clip.fadeOutSec = 0.0;

t.clips.push_back(std::move(clip));
```

**SSnd section parsing (for sample rate / channels / length):**
```
SSnd[0x00]: uint32 version (1-3)
SSnd[0x04]: uint32 sample_format = 1 (16-bit)
SSnd[0x08]: uint32 channels
SSnd[0x0C]: uint32 sample_rate (e.g. 44100)
SSnd[0x10]: sub-chunks (ssnd, ssrf, ssst, ... each with size prefix)
```

---

### Step 8 — Markers (day 0.5)

**Marker extraction:**
Search for `Mark` sections (used for timeline markers in CPR files).

If marker section can't be fully decoded, skip markers. Markers are optional.

---

### Step 9 — Integration test (day 0.5)

Build the provider and test with available CPR files:
- `proj2/morphing.cpr` (1.37 MB, 3 MIDI tracks, audio clips)
- `proj/lior.cpr` (4.02 MB, 8 MIDI tracks, audio clips)

Write a test script similar to `scripts/import-test.mjs` that:
1. Spawns the engine
2. Calls `project/importForeign` with a CPR file
3. Verifies: track count, track names, notes/clip count, audio tracks

---

### Step 10 — Edge cases & error handling (day 0.5)

Handle these cases gracefully:
- **Unknown sections:** Log with `Log::warn`, skip over them, continue parsing
- **Missing WAV files:** Log warning, create placeholder Asset with `originalPath`
- **Corrupt CPR:** Return early with descriptive error ("corrupt CPR at offset 0x...")
- **Empty project:** Reject with "CPR file contains no MIDI or audio tracks"
- **Version mismatch:** CPR2 vs CPR5 detection (check for "Version 5.1.1" in file)

---

## 5. Implementation Priority & Risks

### Priority order (what to build first, what to defer)

| Priority | Component | Risk | Time |
|----------|-----------|------|------|
| **P0** | Skeleton + track name extraction | Low | 0.5d |
| **P0** | MIDI note extraction (basic) | **Medium** — internal structure not fully known | 1.5d |
| **P1** | Audio clip extraction (names from PAudioClip) | Low | 0.5d |
| **P1** | WAV import via AssetStore | Medium — paths are absolute, may not resolve | 1d |
| **P2** | Tempo/time signature parsing | **High** — raw format unknown | 1.5d |
| **P2** | Markers | Low (if parsing works) | 0.5d |
| **P3** | VST plugin state recreation | **Blocked** — proprietary XML format, version-specific | Skip |
| **P3** | Track routing/bus structure | Medium — folder hierarchy | 1d |

### Key risks

1. **MIDI internal structure unknown.** The Parse project couldn't fully reverse-engineer
   the MMidiPartEvent/MMidiPart internal layout. We may need to experiment with
   different byte-offset interpretations (ticks as doubles, event data bytes, etc.).

2. **WAV file paths are absolute Windows paths.** `D:\Projects\OCTOBER\29-10\Audio\synth1.wav`
   won't exist on most machines. The AssetStore `importFile` will fail; we need a fallback
   (create Asset with `originalPath`, or use `ctx.projectDirHint` as a base path).

3. **CPR version differences.** Cubase 5.1.1 (CPR5) may differ from Cubase SX 2.0.2 (CPR2).
   Handle gracefully — log warnings on unknown sections, don't crash.

4. **Tempo/time signature data is raw/unparsed.** We may need to leave tempo at default
   120 BPM and 4/4 if we can't crack the encoding. The `0x3FF0` constant in the
   MTrackList header might be a clue for default values.

5. **Performance.** CPR files can be 4MB+. File reading must be efficient. Avoid
   repeated string allocations. The whole read can be done in one `readAllBytes()`.

---

## 6. File layout

```
engine/src/import/
├── ImportProvider.h          (existing — no changes)
├── ImportProvider.cpp        (existing — no changes)
├── Providers.cpp             ( MODIFY: add CPR include + registration)
├── SmfImportProvider.h       (reference)
├── SmfImportProvider.cpp     (reference)
├── CPRImporter.h             (NEW)
└── CPRImporter.cpp           (NEW)
```

**CPRImporter.h** (~60 lines):
- `#pragma once`
- `#include "import/ImportProvider.h"`
- `CPRImporter` class declaration
- `std::unique_ptr<ImportProvider> makeCPRImporter()` declaration

**CPRImporter.cpp** (~600-900 lines):
- Includes + `namespace {` for helpers
- Low-level byte read helpers (copy from SmfImportProvider pattern)
- `parseSectionTree()` — recursive tree walker
- `extractTracks()` — find MTrackList, walk tracks
- `extractMIDI()` — find MMidi tracks, parse notes/CCs
- `extractAudioClips()` — find PAudioClip, extract names/WAV refs
- `extractTempo()` — find MTempoTrackEvent
- `CPRImporter::probe()` — check for "NUND" or "NUNDROOT" magic bytes
- `CPRImporter::import()` — orchestrator: read → parse → convert → return true

---

## 7. Testing Strategy

### Unit testing (during development)
- Test each helper (`readU32le`, `resolveBackRef`, `readAsciiString`)
- Test section tree walker against known CPR files (offset validation)

### Integration testing (with engine)
1. Launch `mydaw-engine.exe`
2. Use WebSocket to call `project/importForeign` with `proj2/morphing.cpr`
3. Verify: 3 MIDI tracks exist, names match, notes present
4. Test with `proj/lior.cpr`: 8 MIDI tracks, correct names
5. Test error path: import a non-CPR file → `no_provider` error

### Regression testing
- Existing SMF import still works (`smoke-test.mjs`, `import-test.mjs`)
- No engine crashes, no leaks

### Manual testing checklist
- [ ] Import CPR with only MIDI tracks (no audio)
- [ ] Import CPR with audio clips (WAV files missing)
- [ ] Import CPR with audio clips (WAV files present)
- [ ] Import large CPR (20+ tracks, 4MB+)
- [ ] Import corrupt/truncated CPR
- [ ] Import CPR that was never saved (projectDirHint empty)
- [ ] Import CPR with VST plugins (plugins not recreated, no crash)

---

## 8. Appendix: Known CPR Object Type IDs (for scanner)

When scanning/identifying sections in the file:

| Type ID / Pattern | Meaning | Import Action |
|-------------------|---------|---------------|
| `MIDI XX` | MIDI track | Create TrackKind::Midi + MidiClip |
| `MMidiTrackEvent` | MIDI track container | Track found |
| `MMidiNote` | Note event | Create Note |
| `MMidiController` | CC event | Create MidiCc |
| `MMidiPitchBend` | Pitch bend | Create MidiCc (controller 128) |
| `MAudioTrackEvent` | Audio track container | Create TrackKind::Audio |
| `PAudioClip` | Audio clip | Extract name, wav path, position |
| `FNPath` | File path (absolute) | Extract WAV reference |
| `SSnd` | Sound chunk | Audio data header |
| `MTempoTrackEvent` | Tempo change | Parse tempo |
| `MSignatureTrackEvent` | Time signature | Parse signature |
| `MTrackList` | Track list container | Start of track data |
| `MListNode` | List node (track name) | Extract track name |
| `Mark` | Timeline marker | Create Marker (if parseable) |
| `VST Mixer` | VST plugin data | **Skip** (not impl) |
| `FMemoryStream` | Container (VST, etc.) | Skip |
| `MMidiPartEvent` | Part event container | Skip (MIDI parts) |
| `MMidiPart` | MIDI part | Contains note data |

---

## 9. Open Questions (need research/reverse engineering)

1. **What is the exact binary format of `MTempoTrackEvent` data?**
   - We see `00 00 01 <4-byte size> <raw data> FF FF FF FF`
   - The raw data contains tempo values but the encoding is unknown
   - **Suggestion:** Try interpreting it as a list of `(beat, bpm)` pairs using
     the same double-float pattern found in MIDI note timestamps

2. **Where exactly in the MIDI track is note data stored?**
   - Inside `MMidiPartEvent MMidiPart`, the event data follows the track name
   - Pattern observed: `double tick`, some event data byte, `double nextTick`
   - Need to confirm byte-level event format (note number, velocity, duration)

3. **Is there a ticks-per-quarter (PPQN) stored in the CPR?**
   - SMF files store this in the MThd header; CPR files may not
   - The `0x3FF0` constant in MTrackList header could be it (16368 = 480 * 64 / 2?)
   - **If no PPQN:** assume Cubase uses 480 PPQN (standard Cubase default)

4. **Can audio track names be mapped to specific MIDI device names (VST instruments)?**
   - Named audio tracks like "Alya", "bass drum", "MIDI 01" suggest a relationship
   - This could be used for track naming in the MyDAW project

5. **Are there "folder" tracks (bus structure) in CPR?**
   - The Parse project showed nested `MTrackList` inside `MFolderTrack`
   - Would need to implement `TrackKind::Folder` and `Track::parentId`
