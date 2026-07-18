# Cubase Track Archive XML — WRITER SPEC

> Derived 2026-07-16 from a single Cubase-exported sample read in full (1901 lines,
> 102,093 B; a private fixture outside the repo — a native Cubase Track Archive export
> with 2 audio tracks, "Audio 01" @ 0 dB and "Audio 02" @ −6.97 dB, no clips/plugins/MIDI).
> Cross-referenced against `docs/CPR_MIXER_FORMAT.md` §0/§3/§5/§7.5/§8 and the reader oracle
> `scripts/trackarchive-xml.mjs`. Everything not quoted from the sample is marked **INFERRED**.
> Goal: a C++ writer whose output Cubase (File > Import > Track Archive) accepts.

---

## 1. FILE ENVELOPE

```xml
<?xml version="1.0" encoding="utf-8"?>
<tracklist>
   <list name="track" type="obj">
      <obj class="MAudioTrackEvent" ID="385772984">
```
- Declaration: exactly `<?xml version="1.0" encoding="utf-8"?>`. File content is pure ASCII,
  **no BOM**, **CRLF** line endings on every line (1901 CR = 1901 LF, byte-verified), trailing
  newline at EOF.
- Root: `<tracklist>` — **no attributes**. Exactly two children, in order:
  1. `<list name="track" type="obj">` — one `<obj>` per exported track.
  2. `<obj class="PArrangeSetup" name="Setup" ID="…">` — project-frame settings (see §3.6).
- **No version/app stamp anywhere** (grep for `cubase|version|appversion` hits only the XML
  declaration). Exporting version is therefore INFERRED from structure: `InsertFolder.Slot`
  count = **8** (C12 uses 16), `Volume.AnchorValue` left at `0` while `Value` carries the fader
  (the documented Cubase 5 quirk, CPR_MIXER_FORMAT §5), per-plugin `Editor Width/Height`
  members (C12 replaces these), no `RuntimeID` ints, and the file sits beside the C5.1.1
  `Mixer Volume/volume.cpr` fixture whose "Audio 02 = −6.97 dB" matches this sample's
  `Value="17694.07421875"` exactly ⇒ **exported by Cubase 5.1.1** (INFERRED, high confidence).
- Indentation: **3 spaces per nesting level** (root children at 3, their children at 6, …).
  Exception: `<bin>` content lines use TABS (§2.6).

## 2. ELEMENT GRAMMAR

Complete tag vocabulary (census of the whole file — nothing else occurs):
`tracklist`(1) `list`(125) `obj`(49) `member`(194) `int`(440) `float`(92) `string`(196)
`item`(216) `bin`(52).

This is the labeled twin of the .cpr binary attr-tree (CPR_MIXER_FORMAT §5/§8). Mapping for a
writer that already knows the binary encoding:

| XML                              | binary attr-tree type            |
|----------------------------------|----------------------------------|
| `<int name value/>`              | 0x01 i64BE                       |
| `<float name value/>`            | 0x04 f64BE                       |
| `<string name value [wide]/>`    | 0x08 lpstr (wide = UTF-16 field) |
| `<member name>` … `</member>`    | 0x02 sub 0x06 named container    |
| `<list name type="list">`        | 0x02 sub 0x05 array of entry-lists (`<item>` containers) |
| `<list name type="int">`         | 0x02 sub 0x02 i64 array (`<item value="N"/>`) |
| `<list name type="string">`      | 0x02 sub 0x04 lpstr array (`<item value="…"/>`) |
| `<bin name>` hex `</bin>`        | 0x02 sub 0x07 raw bytes          |
| `<obj class [name] ID>`          | 0x14 owned object                |
| `<obj name ID/>` (no class)      | 0x15 object reference            |
| `<list name type="obj">`         | 0xC9 owned-object list           |

### 2.1 `obj` — definitions and references
- **Definition**: `<obj class="…" [name="…"] ID="…">` children `</obj>`. Attribute order is
  always `class`, then `name` (only when the obj is a *named member* of its parent; objs inside
  a `type="obj"` list carry no `name`), then `ID`.
- **Reference**: self-closing, **no `class`**, keeps the definition's `name`:
  `<obj name="Tempo Track" ID="385772864"/>` (5 such refs to the one definition in the sample).
- Every one of the 49 `obj` elements carries an `ID`. IDs are decimal unsigned 32-bit values
  that look like heap pointers (101157624 … 387431928). Cross-referenced IDs in the sample:
  Tempo Track (1 def + 5 refs), Signature Track (1 def + 5 refs), each track's
  `MAutomationTrack` (1 def + 1 ref inside its own `MAutomationNode`). All definition IDs are
  unique file-wide. Define-on-first-use: the FIRST track's `Node > Domain` defines the
  Tempo/Signature tracks; every later `Domain` references them by ID.

### 2.2 `member`
`<member name="…">` — only attribute is `name`. May be empty (open+close on separate lines):
```xml
<member name="Insp">
</member>
```

### 2.3 Scalars & booleans
- `<int name="…" value="…"/>` — plain decimal, negatives allowed (`value="-1"` in
  `ParameterTag`). **Booleans are `<int>` 0/1** (Bypass, Enable, Active, ownership…).
- `<float name="…" value="…"/>` — shortest decimal that round-trips the IEEE double, up to 17
  significant digits, **no exponent notation, no trailing zeros, integer-valued doubles
  printed without a decimal point**. Complete set of distinct floats in the sample:
  `0 1 120 2000 44100 576000 600 16383.5 25856 17694.07421875 12000.0009765625
  99.999992370605469 799.99981689453125 0.59093010425567627 0.027763502672314644`.
  C++ recipe: `std::to_chars(double)` (shortest round-trip) reproduces all of these.
- `<string name="…" value="…" [wide="true"]/>` — `wide="true"` marks fields stored as UTF-16
  in the binary twin. Which fields are wide is fixed per schema slot, not per content:
  - wide in sample: `Name` (MListNode/Automation), `String`, `GUID`, `Plugin Name`,
    `IDString` (of Panner blocks), `Bay Program`, `DeviceNode Name`, `NodePath`, `OriginalName`.
  - NOT wide: `Device Name` ("VST Multitrack"), channel `IDString` ("Audio 1"),
    `OwnInputBus > Name`, `ClassName`, Quick-Controls `IDString`, `ClassIDs` items.
  Emit exactly as per the skeletons in §3.
- XML escaping: no escaped entities occur in the sample; standard `&amp; &lt; &gt; &quot;`
  escaping for attribute values is INFERRED (the oracle unescapes these five).

### 2.4 `list` + `item`
`<list name="…" type="obj|list|int|string">`.
- `type="obj"` → children are `<obj>` definitions.
- `type="list"` → children are `<item>` containers holding members/scalars.
- `type="int"` / `type="string"` → children are value-only self-closed items:
```xml
<list name="Type" type="int">
   <item value="1"/>
   <item value="2"/>
</list>
```
All 11 list heads in the sample: `track`(obj) `TempoEvent`(obj) `SignatureEvent`(obj)
`Tracks`(obj) `obj`(obj, inside CmArray) `Slot`(list) `Band`(list)
`Audio Input Arrangement`(list) `Audio Output Arrangement`(list) `Type`(int) `ClassIDs`(string).

### 2.5 Channel-width `Type` lists
`[1,2]` = the stereo speaker-arrangement pair used everywhere (bus + panner I/O). Mono form
not present in sample (INFERRED `[1]`).

### 2.6 `bin` — binary blobs
Uppercase hex pairs, no spaces, content on its own line. Byte-verified framing quirk: the open
tag ends the line normally (CRLF), the **content line is indented with TABS, count =
element depth + 1** (send-panner `bin` at depth 9 → 10 tabs, 24 such lines; channel-panner
`bin` at depth 6 → 7 tabs, 2 lines — the only tabs in the file), then CRLF, then the close tag
at normal 3-space indentation:
```
<bin name="audioComponent">\r\n
\t\t\t\t\t\t\t\t\t\t0000003F0000003F010000000200000000000000\r\n
                              </bin>\r\n
```
Empty blob = open tag, CRLF, indent, close tag (all `editController` bins are empty):
```xml
<bin name="editController">
</bin>
```
All blobs in the sample are 20 bytes / 40 hex chars on ONE line. **Line-wrap width for larger
blobs is NOT evidenced — OPEN** (risk item, §7).

## 3. TRACK SKELETONS

Only ONE track class exists in the sample: `MAudioTrackEvent` (×2). No
MInstrumentTrackEvent / MMidiTrackEvent / standalone tempo track — their XML shapes are
**OPEN** (the binary twins are in CPR_MIXER_FORMAT §7.2/§7.3/§7.7; class/member names carry
over 1:1 per §8, but child order in XML is unverified).

Legend: `←DATA` = varies per export; everything else = constant boilerplate to emit verbatim.

### 3.1 `MAudioTrackEvent` (track container)

```xml
<obj class="MAudioTrackEvent" ID="385772984">            ←DATA (unique ID)
   <int name="Flags" value="1"/>
   <float name="Start" value="0"/>
   <float name="Length" value="576000"/>                 ←DATA (ticks, 480 PPQ; here 1200 quarters = project length)
   <obj class="MListNode" name="Node" ID="385232032">    ←DATA (unique ID)
      <string name="Name" value="Audio 01" wide="true"/> ←DATA (track name)
      <member name="Domain">
         <int name="Type" value="0"/>
         … tempo+signature: FULL DEFS in the first track (§3.2), ID REFS in all later tracks:
         <obj name="Tempo Track" ID="385772864"/>
         <obj name="Signature Track" ID="112678464"/>
      </member>
   </obj>
   <member name="Additional Attributes">
      <member name="Insp">
      </member>
   </member>
   <obj class="MAudioTrack" name="Track Device" ID="385333840">   ←DATA (unique ID) — §3.3
      …
   </obj>
   <int name="Height" value="42"/>
   <obj class="MAutomationNode" name="Automation" ID="386021152"> ←DATA (unique ID) — §3.5
      …
   </obj>
</obj>
```
Child order is fixed: Flags, Start, Length, Node, Additional Attributes, Track Device, Height,
Automation. `Start`/`Length` are the track-event span in ticks (no audio clips present; see §6).

### 3.2 Tempo / Signature definitions (first track's `Node > Domain` only)

```xml
<obj class="MTempoTrackEvent" name="Tempo Track" ID="385772864">
   <list name="TempoEvent" type="obj">
      <obj class="MTempoEvent" ID="111727904">
         <float name="BPM" value="120"/>                 ←DATA
         <float name="PPQ" value="0"/>                   (event position, ticks)
      </obj>
   </list>
   <float name="RehearsalTempo" value="120"/>
</obj>
<obj class="MSignatureTrackEvent" name="Signature Track" ID="112678464">
   <list name="SignatureEvent" type="obj">
      <obj class="MTimeSignatureEvent" ID="111729056">
         <int name="Bar" value="0"/>
         <int name="Numerator" value="4"/>               ←DATA
         <int name="Denominator" value="4"/>             ←DATA
         <int name="Position" value="0"/>
      </obj>
   </list>
</obj>
```
These two objects are referenced by ID from EVERY later `Domain` (track nodes, automation
nodes, auto-list nodes) — 5 refs each in the 2-track sample.

### 3.3 `MAudioTrack` "Track Device" (the channel strip)

```xml
<obj class="MAudioTrack" name="Track Device" ID="385333840">
   <int name="Connection Type" value="1"/>
   <string name="Device Name" value="VST Multitrack"/>      (narrow!)
   <int name="Channel ID" value="1"/>                       (BOTH tracks have 1 — not unique)
   <member name="DeviceAttributes">
      … §3.4 …
   </member>
   <int name="Flags" value="0"/>
</obj>
```

### 3.4 `DeviceAttributes` — full child order with constants

| # | member (in order) | content |
|---|---|---|
| 1 | `member Name` | `<string name="String" value="Audio 01" wide="true"/>` ←DATA (mixer label) |
| 2 | `int Type` | `1` (audio track channel; buses would be 7 — INFERRED from §1/§5 of CPR_MIXER_FORMAT) |
| 3 | `member InputGain` | `<float name="Value" value="16383.5"/>` (neutral) |
| 4 | `int InputPhase` | `0` |
| 5 | `member Volume` | `<float name="Value" value="25856"/>` ←DATA (fader, 25856-taper) + `<float name="AnchorValue" value="0"/>` (C5 leaves 0! see §7) |
| 6 | `member InsertFolder` | `Bypass=0`, `SeparationPosition=6`, `list Slot type="list"` × **8** items, each empty slot = `<item><int name="State" value="0"/></item>` |
| 7 | `int EQPosition` | `6` |
| 8 | `member EQ` | `Bypass=0` + `list Band type="list"` × 4, per-band `Enable,Type,Gain,Freq,Q` — defaults below |
| 9 | `member SendFolder` | `Bypass=0`, `SeparationPosition=6`, `list Slot type="list"` × **8**, per-slot §3.4.2 |
| 10 | `member Panner` | channel panner block §3.4.3 with `PannerType.Value=2`, `Active=1`, audioComponent `…04…` variant |
| 11 | `int VUSelect` | `1` |
| 12 | `int VURange` | `0` |
| 13 | `member Monitor` | `Value=0, Min=0, Max=2` (ints) |
| 14 | `member OwnInputBus` | §3.4.4 ←DATA (name + Bus UID) |
| 15 | `member InputBusValue` | `<int name="Value" value="2000002"/>` (opaque bus binding) |
| 16 | `member OutputBusValue` | `<int name="Value" value="6"/>` (opaque; both tracks → same output bus) |
| 17 | `int FreezePosition` | `5` |
| 18 | `int Listen Mode` | `0` |
| 19 | `int LinkedPanner` | `0` |
| 20 | `string IDString` | `value="Audio 1"` (narrow) ←DATA — matches `OwnInputBus.Name`, NOT the track name ("Audio 1" vs track "Audio 01") |
| 21 | `member foldbackSendFolder` | `Bypass=0`, `SeparationPosition=6`, `list Slot` × **4** (same slot grammar as SendFolder — cue sends) |
| 22 | `member Quick Controls` | §3.4.5 |
| 23 | `int InputBusArrangementType` | `1` |

NOTE: **no `Pan` member — EVER** (updated 2026-07-17). The old inference that a
non-centered channel would carry `Pan{Value -64..63, Min, Max}` is **falsified** by the
C5.1.1 labeled archives (`C:\Temp\cpr_stereo\cubase5`, channels panned L33/R7): native
Cubase NEVER writes a channel-level `Pan` member in any observed era (C5.1.1, C12, C13) —
the channel pan lives ONLY in the Panner block's `audioComponent` first f32le (§3.4.3,
CPR_MIXER_FORMAT §5a). The only `Pan{Value,Min,Max}` members in archives are the
MIDI-splitter ones (`Max` = 64 on C5, 63 on C12 — era-dependent per §8). The writer
therefore emits no Pan member and puts the pan in the Panner component state.

#### 3.4.1 EQ band defaults (emit verbatim; all 4 bands `Enable=0`, `Gain=0`)
```xml
<item>                                                        band 1
   <int name="Enable" value="0"/>
   <int name="Type" value="5"/>
   <float name="Gain" value="0"/>
   <float name="Freq" value="99.999992370605469"/>
   <float name="Q" value="0.59093010425567627"/>
</item>
```
band 2: `Type=1, Freq=799.99981689453125, Q=0.027763502672314644`
band 3: `Type=1, Freq=2000, Q=0.027763502672314644`
band 4: `Type=5, Freq=12000.0009765625, Q=0.59093010425567627`
(Type→shape mapping unverified — CPR_MIXER_FORMAT §7.5; these exact doubles are what C5 wrote.)

#### 3.4.2 SendFolder / foldbackSendFolder slot (all inactive in sample)
```xml
<item>
   <member name="Volume">
      <float name="Value" value="0"/>
      <float name="AnchorValue" value="0"/>
   </member>
   <member name="Output">
      <int name="Value" value="0"/>
   </member>
   <member name="Panner">
      … §3.4.3 send variant: PannerType.Value=3, Active=0,
        audioComponent 0000003F0000003F010000000200000000000000 …
   </member>
</item>
```
**No `OldOn`, no destination string** — 0 occurrences file-wide. An *activated* send's members
(`OldOn=1`, real `Output.Value`) are INFERRED from the oracle/corpus, not evidenced here — OPEN.

#### 3.4.3 Panner block (shared grammar; the only "plugin" in the sample)
```xml
<member name="Panner">
   <member name="Default SurroundPan UID">
      <string name="GUID" value="56535453506132737572726F756E6470" wide="true"/>
   </member>
   <member name="PannerType">
      <int name="Value" value="3"/>      ← 3 in send/foldback slots, 2 for the channel panner
      <int name="Min" value="0"/>
      <int name="Max" value="11"/>
   </member>
   <member name="Plugin UID">
      <string name="GUID" value="44E1149EDB3E4387BDD827FEA3A39EE7" wide="true"/>
   </member>
   <string name="Plugin Name" value="Standard Panner" wide="true"/>
   <int name="Audio Input Count" value="1"/>
   <list name="Audio Input Arrangement" type="list">
      <item>
         <list name="Type" type="int">
            <item value="1"/>
            <item value="2"/>
         </list>
      </item>
   </list>
   <int name="Audio Output Count" value="1"/>
   <list name="Audio Output Arrangement" type="list">     (identical body)
   …
   <int name="Event Input Count" value="0"/>
   <int name="Event Output Count" value="0"/>
   <bin name="audioComponent">
      0000003F0000003F010000000200000000000000              ← send variant (tab-indented line)
   </bin>
   <bin name="editController">
   </bin>
   <int name="Editor Width" value="0"/>
   <int name="Editor Height" value="0"/>
   <int name="Active" value="0"/>       ← 0 in send slots, 1 for the channel panner
   <string name="IDString" value="Panner" wide="true"/>
   <string name="Bay Program" value="" wide="true"/>
</member>
```
Channel-panner deltas: `PannerType.Value=2`, `Active=1`, audioComponent
`0000003F0000003F040000000200000000000000` (third LE dword 04 instead of 01). Decoded
(NO LONGER opaque — CPR_MIXER_FORMAT.md §5a, calibrated 2026-07-17 against the
C:\Temp\cpr_stereo user fixtures): dwords LE = **f32 pan position** (0 = hard L,
0.5 = C, 1 = hard R; Cubase UI shows `(pos-0.5)*200`), f32 0.5 (right-channel position,
balance panner), u32 mode (channel 4 / send 1), u32 channelCount 2, u32 0. Modern Cubase
(13+) reads the channel pan ONLY from this blob, so the writer puts the track pan into
the first dword (`pannerComponentHex` in TrackArchiveWriter.cpp — a hardcoded centered
constant would erase the pan on import into C13+); send panners stay centered.

#### 3.4.4 OwnInputBus (per-track input bus)
```xml
<member name="OwnInputBus">
   <string name="Name" value="Audio 1"/>            ←DATA (narrow; "Audio 2" on track 2)
   <int name="Bus UID" value="12"/>                 ←DATA (unique: 12, 13)
   <int name="Bus Type" value="13"/>
   <member name="Input Arrangement">
      <list name="Type" type="int"> [1,2] </list>
   </member>
   <member name="Output Arrangement">
      <list name="Type" type="int"> [1,2] </list>
   </member>
</member>
```

#### 3.4.5 Quick Controls (pure boilerplate — 8 empty destinations)
```xml
<member name="Quick Controls">
   <int name="NumberOfQuickControls" value="8"/>
   <obj class="CmArray" name="QCDestinations" ID="111566060">     ←DATA (unique ID)
      <int name="ownership" value="1"/>
      <list name="obj" type="obj">
         <obj class="QCDestinationValue" ID="111868176">          ←DATA (×8, unique IDs)
            <int name="ParameterTag" value="-1"/>
            <string name="NodePath" value="" wide="true"/>
            <string name="OriginalName" value="" wide="true"/>
            <int name="IsRelativePath" value="0"/>
            <string name="String" value="" wide="true"/>
         </obj>
         … ×8 total …
      </list>
   </obj>
   <string name="DeviceNode Name" value="Quick Controls" wide="true"/>
   <string name="ClassName" value="Quick Controls"/>
   <string name="IDString" value="Quick Controls"/>
   <int name="NodeFlags" value="0"/>
   <int name="NumberClassIDs" value="2"/>
   <list name="ClassIDs" type="string">
      <item value="AB9705CD467B4D7A946C8860C504F492"/>
      <item value="CA1729D088FC4857937F78CC37D45B48"/>
   </list>
</member>
```

### 3.5 `MAutomationNode` "Automation" (one per track, all defaults)
```xml
<obj class="MAutomationNode" name="Automation" ID="386021152">    ←DATA (unique ID)
   <string name="Name" value="Automation" wide="true"/>
   <member name="Domain">
      <int name="Type" value="0"/>
      <obj name="Tempo Track" ID="385772864"/>
      <obj name="Signature Track" ID="112678464"/>
   </member>
   <list name="Tracks" type="obj">
      <obj class="MAutomationTrackEvent" ID="386022808">          ←DATA (unique ID)
         <int name="Flags" value="32"/>
         <float name="Start" value="0"/>
         <float name="Length" value="576000"/>                    (= track Length)
         <obj class="MAutoListNode" name="Node" ID="385230736">   ←DATA (unique ID)
            <member name="Domain">
               <int name="Type" value="0"/>
               <obj name="Tempo Track" ID="385772864"/>
               <obj name="Signature Track" ID="112678464"/>
            </member>
         </obj>
         <obj class="MAutomationTrack" name="Track Device" ID="386018576">  ←DATA (unique ID)
            <int name="Connection Type" value="2"/>
            <int name="Read" value="0"/>
            <int name="Write" value="0"/>
         </obj>
         <int name="Tag" value="1025"/>
      </obj>
   </list>
   <obj name="Track Device" ID="386018576"/>     ← REF back to the MAutomationTrack just defined
   <int name="Expanded" value="0"/>
</obj>
```
`Tag=1025` is the automation-parameter tag of the default (volume) lane — value is a constant
in the sample; semantics INFERRED.

### 3.6 `PArrangeSetup` (root child #2)
```xml
<obj class="PArrangeSetup" name="Setup" ID="111125728">
   <member name="Length">
      <float name="Time" value="600"/>          ←DATA (project length, SECONDS)
      <member name="Domain">
         <int name="Type" value="1"/>           (1 = time-linear domain; track Domains use 0 = musical)
         <float name="Period" value="1"/>
      </member>
   </member>
   <int name="BarOffset" value="0"/>
   <int name="FrameType" value="5"/>
   <int name="TimeType" value="0"/>
   <float name="SampleRate" value="44100"/>     ←DATA
   <int name="SampleSize" value="24"/>          ←DATA (bit depth)
   <int name="PanLaw" value="6"/>
</obj>
```
Consistency check the writer should preserve: track `Length` 576000 ticks / 480 PPQ = 1200
quarters = 600 s @ 120 BPM = `Length.Time` — the two lengths agree through the tempo.

## 4. MIDI CONTENT

**Not present — OPEN.** The sample contains zero MIDI parts, notes, or CC events (grep for
`MMidi|MidiPart|MInstrument` = 0 matches). The binary twin's event stream is documented
(CPR_MIXER_FORMAT §7.4) and class/member names carry into XML 1:1 (§8), but the XML shape of
`MMidiTrackEvent`/`MMidiPart`/note lists is unevidenced. A writer must NOT guess it — export a
Track Archive of a project with one MIDI part to pin it before emitting MIDI.

## 5. PLUGIN STATE

No instrument or insert-effect plugins in the sample (all 16 `InsertFolder` slots across both
tracks are `<item><int name="State" value="0"/></item>`). The **Standard Panner** blocks
(§3.4.3) are the only plugin-shaped objects and confirm the CPR_MIXER_FORMAT §3 conventions
in XML form:
- `Plugin UID > GUID` = 32 uppercase hex chars in a `wide="true"` string. Here
  `44E1149EDB3E4387BDD827FEA3A39EE7` = the Standard Panner's **real VST3 class ID** (native
  plugins use real GUIDs).
- `Default SurroundPan UID > GUID` = `56535453506132737572726F756E6470` = ASCII
  `VST` + fourcc `SPa2` + `surroundp` — the **'VST'+fourcc+lowercased-name wrapper GUID**
  form of §3, hex of the 16 raw bytes.
- `Plugin Name` = display name, wide.
- `bin audioComponent` = the raw component state, uppercase hex (here 20 B, little-endian
  internals). `bin editController` empty on C5.
- `IDString` here is `"Panner"` — NOT the `GUID + "-0"` instance-suffix form §3 documents for
  insert slots. So the suffix convention applies to insert/instrument slots only (INFERRED).
- A **loaded insert slot's XML shape is OPEN**: from the binary schema (§5:
  `Slot{Plugin isA:"VstCtrlInternalEffect", Plugin{UID,Name,audioComponent…}, Patcher,
  WasEnableBeforeFreeze, State:1}`) one can predict the member names, but order/nesting in XML
  is unevidenced. For VST2-under-wrapper plugins expect `audioComponent` hex = `'VstW'` header
  + fxb image (§4); registry matching per §3 (signed-int32 uid stringification).

## 6. MEDIA / AUDIO REFERENCES

**Not present — OPEN.** Both `MAudioTrackEvent`s carry only `Start`/`Length` (the lane span);
there are no audio parts/events, no pool entries, no file paths anywhere (grep `Pool|File|
AudioEvent` = 0). How a Track Archive references wav files (and whether the exporter writes a
sibling media folder) must be pinned with a new export before the writer emits clips.

## 7. WRITER RULES

1. **Emission order is fixed** — emit members exactly in the §3 orders. The binary twin is a
   schema-driven attr-tree; Cubase's XML reader is presumed positional-tolerant but this is
   unverified (INFERRED) — matching the sample costs nothing.
2. **ID allocation**: any unique decimal uint32 per `<obj>` definition works as a hypothesis
   (sample values are heap pointers, so Cubase can't require specific values — INFERRED;
   uniqueness of definition IDs is evidenced). Simple strategy: monotonically increasing
   counter starting at e.g. 100000000. Rules:
   - every `<obj>` definition gets a fresh ID; attribute order `class, name, ID`;
   - a cross-reference re-emits `name` + the target's `ID`, self-closing, no `class`;
   - define tempo/signature in the FIRST track's `Node > Domain`, reference everywhere after;
   - inside each `MAutomationNode`, emit the `Track Device` REF after the `Tracks` list,
     pointing at the `MAutomationTrack` defined within it.
3. **Volume**: target-C5-faithful = fader in `Volume.Value` via the calibrated 25856-taper
   (inverse of `scripts/cpr-taper.mjs`; 25856 = 0 dB), `AnchorValue = 0` (exactly what the
   sample does: `Value="17694.07421875"`, `AnchorValue="0"` = −6.97 dB). Modern-Cubase-friendly
   = write BOTH consistently (`Value` = taper, `AnchorValue` = dB) — modern saves in the corpus
   always keep the pair in sync (700+ harvested pairs incl. Track Archives), so a consistent
   pair should satisfy any era (INFERRED).
4. **Omissions**: `Pan` omitted when centered (evidenced). Everything else in the §3.4 table
   was emitted by Cubase even at defaults — do NOT omit boilerplate members; no evidence any
   are optional.
5. **Per-track data points**: track name (Node `Name`, wide), mixer label (`DeviceAttributes >
   Name > String`, wide), `OwnInputBus.Name` + channel `IDString` (narrow, "Audio N"
   numbering), `Bus UID` (unique, sample starts at 12), Volume, pan (in the Panner
   component blob, §3.4.3 — never a `Pan` member), EQ bands, event
   `Length`. Everything else: constants from §3.
6. **Formatting**: CRLF everywhere; 3-space indent per depth; `<bin>` content line = depth+1
   TABS + uppercase hex; floats via shortest-round-trip (`std::to_chars`); no BOM.
7. **Minimum viable subset (hypothesis, untested)**: `tracklist > list track` with one
   `MAudioTrackEvent` (Flags/Start/Length, Node w/ Name + Domain incl. tempo+signature defs,
   Additional Attributes, full Track Device, Height, Automation node) + `PArrangeSetup`.
   First importable-file experiment should be a byte-faithful re-emission of this sample with
   only names/IDs changed; then delete candidates (Quick Controls, foldbackSendFolder,
   Automation, send Panner blocks) one at a time against a real Cubase import.

### Riskiest guesses (not evidenced in the sample)
1. **Import acceptance at all** — no positive control exists yet that ANY hand-written file
   (even a byte-identical clone with new IDs) passes File > Import > Track Archive; the reader
   may validate IDs, ordering, or member completeness in unknown ways.
2. **No version stamp ⇒ era ambiguity** — a modern (C12+) Cubase importing this C5-shaped
   grammar (8 insert slots, `Editor Width/Height`, `AnchorValue=0`) is unproven; conversely
   which members a C5-era import *requires* is unproven. Related: `Pan.Max` 64 vs 63 per era.
3. **Everything absent from the sample**: MIDI parts/notes (§4), audio-clip/pool references
   (§6), loaded insert-slot + instrument XML shape and `bin` line-wrapping for multi-KB
   `audioComponent` blobs (§2.6, §5), and active-send members (`OldOn`, real `Output.Value`) —
   all must be pinned with fresh Cubase exports before the writer can emit them.
4. **Opaque bus bindings** — `InputBusValue.Value=2000002`, `OutputBusValue.Value=6`,
   `Bus UID` numbering: how these resolve against the *importing* project's bus table is
   unknown; wrong values may import silently mis-routed or be rejected.
