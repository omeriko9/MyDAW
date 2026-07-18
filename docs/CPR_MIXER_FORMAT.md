# CPR Mixer Format Spec (per era)

> Consolidated from differential analysis of a controlled-save playground + a private
> 2004-2026 Cubase project corpus. Facts marked CONFIRMED are diff-proven with byte
> evidence; INFERRED items are flagged inline. Generated 2026-06-12.
>
> NOTE: validation harnesses referenced below as `scripts/cpr-*-test.mjs` /
> `cpr-taper-harvest.mjs` / `midi-route-render-test.mjs` are bound to that private
> corpus and are NOT included in the repository — the format facts they proved are.

## PART 2 — MIXER-FORMAT SPEC DRAFT (for the importer)

### 0. Container (all eras) — CONFIRMED
- RIFF container, form `NUND`. Streams come as ROOT+ARCH pairs. SX: `Arrangement1|PArrangement`, `Devices|FMemoryStream`, `WindowLayouts|UWindowLayout`, `Version|PAppVersion`.
- All structural integers **big-endian**. String (`lpstr`) = `u32be length (INCLUDING the NUL) + chars + NUL`. Modern names may carry a UTF-8 BOM suffix.
- Class-name interning per ARCH: first occurrence = full name; later = `u32be 0x80000000|id` where **id = byte offset of the name's length field relative to (archDataOff+4)**. Any upstream insertion rewrites every later back-ref (diff-proven: uniform +170 / +0x5B9 shifts). Cross-ARCH offsets do not shift.
- **Era detection rule (CONFIRMED):**
  1. Authoritative: `Version|PAppVersion` string — "Cubase SX Version 2.0.2" / "Cubase Version 5.1.1" / "Cubase Version 12.0.60".
  2. Structural cross-checks: SX = Version chunk **last**, Devices ARCH class `FMemoryStream`, legacy binary channel records. C5+ = Version chunk **first**, Devices class `FAttributes`, adds ProjectLayouts/Metadata, channel payload begins with sentinel `FF FE A4 C8`. C12 = additionally a `ComputerGuid|CmString` chunk, `InsertFolder.Slot` array of **16** (C5: 8), volatile `RuntimeID` ints at every level.

### 1. SX era (2.x, 2004) — channel mixer record — CONFIRMED
Audio-track channels serialize **inside `MAudioTrack`** (Arrangement ARCH), NOT in the mixer device (the "VST Mixer" device blob is byte-identical with/without track inserts). VSTi output channels use the identical grammar inside the "VST Mixer" device blob.

```
u16 1, lpstr "VST Multitrack", u32 1, u32 recordRemainder,
lpstr trackName, u8 0x60, 00 00 04, u32 bodySize,        <- bodySize is the trusted length
body:
  u32 0, u16 chanType (1=track, 7=bus), u32 channelID (sequential 0x4C,0x4D,...),
  u32 0x0D, io-config u32s (2/1 = stereo/mono widths),
  lpstr mixerDisplayName ("Audio N" — independent of track name), u8 2, u32 0,
  f32 16383.5 (InputGain neutral), u32 0, f32 25856.0 (Volume, 0 dB default),
  f64 -0.987872… (constant 0xBFEF9CA9E23A1511, unresolved), f64 1.0 (unresolved — see CONTRADICTIONS),
  u16 1,
  INSERT RACK:  u32 1, u32 rackLen, u32 Bypass=0, u32 SeparationPosition=6, u32 slotCount=8, slots
  EQ BLOCK:     u16 1, u32 6, u32 1, u32 size=0x5C, u32 bandCount=4, 4 × 22-byte band records
  SENDS:        u32 areaSize=0x1FC, u32 0, u32 6, u32 8, 8 × { u32 tag=1, u32 size=0x36, payload
                (zeros + f64 1.0 send level + f32 16383.5 ×2 …) }
  tail zeros…, ends u16 0x0020
```
(The byte sequence `46 7F FE 00 | 00 00 00 00 | 46 CA 00 00 | BFEF9CA9E23A1511 | 3FF0…` was re-verified directly at dblDelay1st.cpr offset 0x30b.)

**SX fader location — CONFIRMED; decode CONFIRMED (calibrated 2026-06-12, exact).** The channel fader is the bare **f32 (big-endian) `Volume Value`** at `InputGain_f32_offset + 8` — immediately after the `f32 16383.5 (InputGain) + u32 0 (separator)` pair (anchor `46 7F FE 00 | 00 00 00 00`). Byte-verified at `playground/ps041.cpr` offset 0x309c: `46 7F FE 00 | 00 00 00 00 | 46 CA 00 00` → InputGain 16383.5, sep 0, **Volume 25856.0 = 0 dB**. SX has **no `AnchorValue`** — the f32 is the only encoding.

**Decode — the calibrated Cubase fader taper.** The historical `(Value/25856)^2` square-law guess is **CONFIRMED WRONG** (its "≤~0.1 dB" claim was circular — the XML oracle derived dB from Value with the same assumed law; the true error reaches ~0.4 dB near −7 dB and ~1.9 dB at the +6 dB fader top, and the C5.1.1 `Mixer Volume/volume.cpr` fixture with user-read mixer dB falsified it outright: a single power law cannot fit Value 24271.85→−1.02 dB and 17694.07→−6.97 dB, implied exponents 1.86 vs 2.12). **Calibration method** (`scripts/cpr-taper-harvest.mjs`): modern saves store BOTH `Volume.Value` (taper) and `Volume.AnchorValue` (true dB), so every modern channel whose fader was moved is a free ground-truth point; harvesting the 2004–2026 corpus (~1476 cpr/bak + Track Archives) yielded 700+ unique pairs spanning Value 1717..32767. They ALL (minus ~11 stale Value/Anchor desyncs in .bak files) match this closed form to **< 1e-6 dB** — piecewise in **linear gain** with round hex knots:
```
Value 32767 (0x7fff) -> gain 2.0  (+6.02 dB, fader top)    gain = 1 + (v-25856)/6911     for v >= 25856
Value 25856 (0x6500) -> gain 1.0  (0 dB)                   gain = 0.5 + (v-18688)/14336  for 18688 <= v < 25856
Value 18688 (0x4900) -> gain 0.5  (-6.02 dB)               gain = 0.5*(v/18688)^2        for v < 18688  (gain(0)=0)
```
Single source of truth: `scripts/cpr-taper.mjs` (used by the XML oracle + tests); the importer embeds the identical form (`applyVolumeValue25856` in CprImportProvider.cpp, used for SX f32 AND the C5 modern fallback). Fixture spot-checks: 17694.07421875 → −6.9700 dB, 24271.8515625 → −1.0171 dB (user read −6.97 / −1.02 off the C5 mixer). Values > 32767 never occur in the corpus (C5-era fader tops at +6 dB); the top line extrapolates and the importer clamps gain at 4.0 (+12 dB). Modern saves mark a fader at −∞ as `Value −1 / AnchorValue −200`; `Value ≤ 0` decodes to gain 0. **SX pan field is NOT identified** — the importer leaves SX channels centered and logs once.

Rack-header naming via the modern mapping (A4): `0 / 6 / 8` = `Bypass / SeparationPosition / slotCount` — this resolves A1's "6 = unknown section id".

### 2. SX insert slot — CONFIRMED (the core target)
```
slot  := u32 tag=2, u32 payloadSize, payload
empty := payloadSize=9, payload 00 00 | 00 00 00 00 | 00 01 00   (u16 occupied=0 + 7 const bytes)
loaded payload:
  u16 0x0001                      occupied
  lpstr idString                  PLUGIN IDENTITY (below)
  u32 1, u32 0, u32 0             unresolved (bypass/program suspected; all-default in corpus)
  u32 stateLen                    = 8 + CcnK byteSize (counts the whole fxb image)
  state                           verbatim VST2 .fxb image (below)
  tail (~110–125 B)               routing/connection ints: u32 0, u32 N, N × u32 (-1,-2,…,-N),
                                  channel-width pairs (2/1; 0xFFFFFFFE = unassigned), u16 0,
                                  then lpstr displayName, u8 0     — only partially decoded
```
- Moving an insert = pure reorder of slot records (state byte-identical) — diff-proven across dblDelay1st–4th.
- **VSTi rack** ("VST Mixer" device blob): introduced by magic `u32 0xAB19CD2B`, then `u32 1, u32 rackLen, u32 0, u32 6, u32 64 (slots)`, then 64 slot records of the same grammar; each **rack** slot additionally carries a trailing `u16 channelCount` + output-channel blocks (empty rack slot = 19 B; audio insert slot = 17 B — context-dependent, both arithmetic-proven). Loaded instrument followed by `02 FF…FF FE` table + lpstr name + output channel(s) in channel-strip grammar; N of the −1…−N table = 2 for most, 64 for Kontakt 5 (≈ output/MIDI capacity, INFERRED).

### 3. Plugin identity — CONFIRMED (≥11 plugins, both effects and instruments)
- SX `idString` = ASCII `"11"` + `%08X` of the **byte-swapped (little-endian memory order) VST2 uniqueID**, space-padded to a 34-char field, then display name. E.g. `11594C4444`→'DDLY', `113866694E`→'Nif8' (FM8), `1101345350`→'PS4\x01', `114D504D43`→'CMPM' (C1). Prefix "11" constant, meaning unknown. Empty audio-insert placeholder ID exists: `"22334455005566770661098800000774"`.
- The **authoritative** uniqueID is the big-endian fxID inside the fxb `CcnK` header — always matched the idString.
- **Registry-match detail (signed int32):** the plugin registry keys VST2 by `std::to_string` of the uniqueID **as a signed `int32_t`** (matching `Vst2Host`), so the importer must emit `std::to_string(static_cast<int32_t>(uniqueID))` for `PluginRegistry::byUid` to match. A uniqueID with the high bit set (fourcc first byte ≥ 0x80) stringifies negative (e.g. `0xFFFFFFFE` → `"-2"`); emitting the unsigned form silently fails recreation for those plugins. Same for the modern `'VST'+fourcc` GUID path.
- C5/C12: `Plugin UID{GUID}` = 32 uppercase hex chars = 16 bytes **`'VST' + fourcc + lowercased plugin name, NUL-padded`** (e.g. DaTube → `56535444615475646174756265000000`); `IDString` = GUID + "-0" instance suffix; `Plugin Name` = display name. GUIDs byte-identical between C5 and C12. Native VST3 plugins (EQ, panner, Input Filter) use real VST3 class GUIDs instead.

### 4. State chunk — CONFIRMED
- SX: `u32 stateLen` + standard **VST2 .fxb image, all big-endian**: `'CcnK', u32 byteSize(=stateLen−8), fxMagic 'FBCh'(chunked)|'FxBk'(param bank), u32 version=1, u32 fxID, u32 fxVersion, u32 numPrograms, 128 B reserved`, then FBCh: `u32 chunkSize + opaque plugin chunk`; FxBk: numPrograms × `'CcnK'…'FxCk'` fxProgram records (`u32 numParams, 28 B name, f32be params`).
- C5/C12: state lives in attr key **`audioComponent`** (type 0x02 sub 0x07: `u32 len + raw bytes`). Loaded VST2 → 16-byte `'VstW'` header (`u32be 8, u32be version=1, u32be bypass=0`) + the same fxb (version byte 1→2). **Unloaded plugin → SX fxb copied byte-identical** (Overdrive: 928 B identical across 2004/2009/2022 saves). VST3 → raw component state (Waves: SX chunk + appended `<Bypass Version="1.0" Bypass="0"/>` tail). C12 adds an (empty here) `editController` blob.
- **How the importer hands state to the host (`modToXPlugin`, CprImportProvider.cpp ~2289):** it strips the Cubase framing so the bytes match what the plugin's `setState`/`effSetChunk` expects: `'VstW'`-wrapped → unwrap to the inner fxb; `'CcnK'/'FBCh'` → the inner opaque chunk; `'FxBk'` (param bank, no chunk) → fill `paramValues` from program 0; **VST3** → repacked as **`'MD3S'`** (`u32le magic 0x5333444D, u32le compLen, component bytes, u32le ctrlLen, controller bytes`). **VST3 detection:** when the `audioComponent` GUID is the `'VST'+fourcc` wrapper form but the state magic is **NOT** `'VstW'`/`'CcnK'`, the plugin is a *real* VST3 (e.g. Waves WaveShell, H-Delay) reusing the wrapper GUID — classify it `vst3`, not `vst2`.
- Loaded plugins MAY rewrite state on re-save (DaTube 1260→244 B C5→C12); only unloaded states are round-trip-stable.

### 5. Modern (C5/C12) channel + attr encoding — CONFIRMED
- Channel: same `"VST Multitrack"` outer wrapper, then sentinel `FF FE A4 C8`, `u32 topCount`, self-labeled attribute tree. Entry = `lpstr key + u16 type`: 0x01 i64BE, 0x04 f64BE, 0x08 lpstr, 0x02 container → `u16 sub, u32 n` (sub 0x06 named entries; 0x05 array of entry-lists; 0x02 i64s; 0x04 lpstrs; 0x07 raw bytes). **Three more entry types, decoded 2026-06 from corpus `QCDestinations`/`filterDefaults` hexdumps (needed or the whole Synth-Rack/Slot subtree aborts):** **0x14** owned object = `lpstr className + u32 0 + u32 objId + u32 n + n entries`; **0x15** object reference = `u32 0 + u32 objId` (8 bytes); **0xC9** owned-object list = `u32 n` then `n` tagged owned objects (each `0x14` or null). Devices `FAttributes` has no sentinel.
- Mixer schema: `InsertFolder{Bypass, SeparationPosition, Slot:arr[8|16]}`; slot item `{Plugin isA:"VstCtrlInternalEffect", Plugin{UID,Name,audioComponent,…}, Patcher{routing}, WasEnableBeforeFreeze, State:1}`; empty = `{State:0}`. `InputGain{Value:16383.5}`, `Volume{Value:25856, AnchorValue:0}` (same constants migrated from SX — 25856 = 0 dB default, proven on native-C5 baseline). `EQ{Bypass, Band:arr[4]{Enable,Type,Gain,Freq,Q}}, EQPosition:6`. `SendFolder{…Slot[8]}`. Buses use the identical channel schema (Type 7). C12 adds `RuntimeID` (volatile per save), `InputFilter`, `StripFolder`, `ChannelStripsPreInserts`; per-plugin `Version` / `Editor Size Count` replace C5's `Editor Width/Height`. Migration adds key `hasAudioInserts` (native-C5 file lacks it).
- **Modern Volume + Pan decode — CONFIRMED (XML↔binary byte-cross-checked, Δ = 0.000000 dB at full f64 precision).** The channel fader and pan are **top-level members** of the channel attr tree (siblings of `InsertFolder`, appearing BEFORE it), reached at `path_` depth 1 under their own container:
  - **`Volume`** (type 0x02 sub 0x06) → child **`AnchorValue`** (type 0x04, f64BE) = **gain in dB** (the value the user sees) on Cubase 12; `MyDAW Track.volume = pow(10, AnchorValue/20)`. **Cubase 5 quirk (CONFIRMED via the `r2-cubase5` pair):** C5 leaves `AnchorValue` at **0 for every channel** and stores the fader only in the sibling child `Value` (the 25856-based taper, `25856 = 0 dB`). So the importer keeps BOTH children and decides (`applyModernVolume`): use `AnchorValue` when it looks populated (|dB| > 1e-4, OR `Value` ≈ 25856 = genuine 0 dB), else fall back to the **calibrated taper** (§1) — the same law as the SX path, and on modern saves the two encodings agree to < 1e-6 dB (700+ corpus pairs, `scripts/cpr-taper-harvest.mjs`), so the fallback is exact, not approximate. Validated: C5 "Monologue 02" `Value=23058.26` → −1.886 dB via the calibrated taper (the old square law said −1.99 — circularly "confirmed" by the pre-fix oracle), and the C5.1.1 taper fixture (`Reversing/CubaseFileFormat/Mixer Volume/volume.cpr`) pins user-READ mixer dB: `Audio 02` −6.97, `Stereo Out` −1.02. Reading `AnchorValue` on C5 would have given a wrong 0 dB.
  - **`Pan`** (type 0x02 sub 0x06) → child **`Value`** (type 0x01, i64BE), with `Min`(-64)/`Max`(63). **CORRECTED 2026-07-17: native Cubase NEVER writes this member on audio channels — in ANY era.** The C5.1.1 + C13 labeled pan fixtures (§5a) and re-examination of the corpus pairs show every `Pan{Value,Min,Max}` in a project/archive is a **MIDI-splitter/MIDI-channel** pan (the §8 hazard); the audio-channel pan lives ONLY in the Standard Panner component blob, C5→C13. The `-64..63` shape above remains correct as an import FALLBACK (pre-2026-07-17 MyDAW exports wrote it): `MyDAW Track.pan = v<0 ? v/64 : v/63` (clamp [-1,1]). See §5a for the blob decode and the importer precedence.
  - Calibration (corpus `test.cpr` ↔ `tracks.xml`, 3 instrument tracks): PS01 −3.8651589211440136 dB, PS02 −4.306456881835768 dB, PS03 −2.661686846140409 dB — all read byte-exact by the importer (`scripts/cpr-mixer-test.mjs` asserts ≤0.1 dB). All three omit Pan (centered). The importer applies these to the owning track strip even when the channel has no inserts (`applyVolumeDb`/`applyChannelPan` in CprImportProvider.cpp); gain is clamped to ≤ +12 dB (4.0 linear) with an out-of-range warning.
  - The VSTi's own `Output Channel` (nested under `Synth Slot`/`Plugin`) reuses the identical `VST Multitrack` grammar with its own `Volume`/`Pan`, but lives deeper in the tree (`path_.size() > 1`) and is NOT mistaken for the track fader.

### 5a. Channel pan — the Standard Panner component blob (ALL eras) — CONFIRMED (2026-07-17)
Decoded from the user-made calibration pair `C:\Temp\cpr_stereo\{stereo,stereo2}.cpr` +
labeled Track Archive twins `{tracks,tracks2}.xml` (Cubase **13.0.30**, `PAppVersion`
"Version 13.0.30 … Mar 13 2024"), ground truth READ off the Cubase mixer by the user:
channel 1 **L18**, channel 2 **R85** (stereo.cpr) / **R13** (stereo2.cpr), input bus
"Stereo In" **R15**. Between the two .cprs ONLY channel 2's pan differs.
**Era-confirmed on Cubase 5.1.1** with a second user-made pair,
`C:\Temp\cpr_stereo\cubase5\cubase5_first_inst_L33_second_inst_{R7,exactly_center}.{cpr,xml}`
(filenames are the labels): same blob, same law — inst 1 `pos=0.333333` (UI −33.3 → **L33**),
inst 2 `pos=0.536232` (UI +7.2 → **R7**) vs `pos=0.5` exactly (**C**); the C5 channel Panner
member is the identical 17-member shape (`Editor Width/Height` instead of C12's
`Version`/`Editor Size Count`), `PannerType 2`, blob `mode=4`, `Active 1`. **No era writes a
channel-level `Pan` member** — C5's archives, like C13's, carry only the MIDI-splitter
`Pan{-64, Min -64, Max 64}`. Re-examining the older corpus pairs with the blob-aware oracle
exposed two pans the pre-fix importer silently lost: r2-cubase5 "Monologue 02" blob 0.666667
(R33) and C12 `test.cpr` "PS01" blob 0.404762 (L19) — both previously "passed" circularly at
center because neither oracle nor importer read the blob.

- **Where:** every channel attr tree has a top-level **`Panner`** member (sibling of
  `Volume`/`InsertFolder`; C13 track trees put the whole track in ONE `FF FE A4 C8` tree —
  2 sentinels in the whole fixture file, one per instrument track). `Panner` (0x02 sub 0x06,
  17 members: `Default SurroundPan UID{GUID}`, `PannerType{Value 2, Min 0, Max 11}`,
  `Plugin UID{GUID 44E1149EDB3E4387BDD827FEA3A39EE7}`, `Plugin Name "Standard Panner"`,
  I/O counts + arrangements, **`audioComponent`** (0x02 sub 0x07, len 0x14), `editController`,
  `Version`/`Editor Size Count` (C5: `Editor Width/Height`), `Active 1`, `IDString "Panner"`,
  `BypassTag`, `RuntimeID`). The C5 donor (`engine/assets/cpr-donor-c5.cpr` @0x232d) carries
  the byte-identical member shape — this grammar is era-stable.
- **The 20-byte `audioComponent` blob is LITTLE-endian** (plugin-private state, unlike the
  BE attr tree): `f32 pos, f32 rightPos, u32 mode, u32 channelCount(2), u32 0`.
  **`pos` IS the channel pan**: 0 = hard L, 0.5 = C, 1 = hard R; **Cubase UI shows
  `round((pos−0.5)×200)`** (mixer slider quantizes to 1/78 GUI steps — the fixtures hold
  exact n/78 fractions). `rightPos` stays 0.5 on the balance panner (a stereo-combined
  panner would move it — none in the corpus; the importer approximates with `pos` and
  warns). `mode`: 1 = factory default / 4 = engaged (the C5 donor channel writes 4 even
  centered; sends write 1). `MyDAW Track.pan = (pos − 0.5) × 2`.
- **Evidence (byte-quoted, stereo.cpr):** L18 → `21 0D D2 3E` = 0.410256 (= 32/78, UI
  −17.95→−18) @0x5f59; R85 → `C5 4E 6C 3F` = 0.923077 (= 72/78, UI +84.6→85) @0x7f2a3;
  input bus "Stereo In" R15 → `45/78` = 0.576923 @0xfff81 (Devices → `VST Mixer` →
  `Input Channels`). stereo.cpr↔stereo2.cpr byte-diff: the ONLY semantic change is
  `C54E6C3F` → `07 69 10 3F` = 0.564103 (= 22/78, UI +12.8→13) at 0x7f2a3 (track tree)
  and 0xef69f (mirror) — everything else is filename/RuntimeID churn.
- **NO era's channel has a `Pan` member** (the only `Pan{Value:-64,Min:-64,Max:63|64}` in
  the fixtures is `Midi Channel/Pan` at depth 2 — the MIDI-splitter pan of §8, NOT the
  audio pan). **Importer precedence** (`scanChannelPan`): blob wins when `Pan.Value` is
  absent or agrees within 1.5/64 (f32 precision beats the 127-step int); an explicit
  disagreeing `Pan.Value` wins. The `Pan.Value` path survives ONLY as a fallback for
  pre-2026-07-17 MyDAW exports (native Cubase never wrote it). Send panners
  (`SendFolder.Slot[i].Panner`) and track-variation snapshots live deeper than the
  top-level path and are not confused with the channel pan.
- **Writers:** CprWriter/`scripts/cpr-write.mjs` (byte-identical pair) emit the donor-shaped
  `Panner` member with the pan in the blob (`appendPannerMember`, only when pan ≠ 0) and —
  matching native shape in every era — NO `Pan` member; the emitted 776-byte Panner member
  is **byte-identical to the native C5.1.1 fixture's** (verified against
  `cubase5_first_inst_L33_second_inst_R7.cpr` @0x23fc for the same pan bits).
  TrackArchiveWriter writes the same blob hex (`pannerComponentHex`), also with no Pan
  member. Round-trip export→import is f32-exact.
- **Input-bus pan is NOT representable in MyDAW** (no input-bus strip) — the importer logs
  `input bus 'Stereo In' is panned R15 … NOT imported` (`modernWarnInputBusPans`).
- Validation: `scripts/cpr-mixer-test.mjs` "C13 stereo pan"/"C13 stereo2 pan" pairs assert
  importer == XML oracle (`trackarchive-xml.mjs` `panNorm`, blob-aware) AND the user-read
  labeled UI values (±0.02).

### 6. Reader hazards — CONFIRMED
- **Stale-garbage hazard:** on insert removal, `MAudioTrack`'s outer record size did NOT shrink; only the inner `bodySize` changed; a 1301-byte byte-identical remnant of the previous save remains in the gap. **Always honor inner length fields; never scan to record end.**
- Save-nondeterminism census (ignore in diffs): own filename inside PPool/FNPath; "Vst ASIO Device" blob raw Win32 pointers (2–46 B churn/save); exactly 4 uninitialized bytes after `</PresetChunkXMLTree>` inside Waves FBCh chunks (within declared length).
- PlugSound chunks are fixed-size dumps with stale-buffer slack; chunk-internal record format `[4CC LE][u32le type][u32le size][value LE]` — plugin-private.

### CONTRADICTIONS BETWEEN AGENTS
1. **Which SX field is the fader** — A2/A3: the `f64 1.0` is "unity volume/fader". A4: the `f32 25856.0` is the fader (migrates to modern `Volume.Value`; migration-proven). **RESOLVED in favor of A4 (the f32):** the modern XML↔binary cross-check proves the modern fader is `Volume.AnchorValue`/`Value`, and the SX `f32 25856 = 0 dB` migrates to exactly that `Volume.Value` — so the f32 is the SX fader. The f64 1.0 is unrelated (pan-law / GUI). The importer reads the f32 (decode law calibrated exact via modern Value↔AnchorValue pairs; see §1).
2. **`u32 0` between InputGain and Volume** — A3 omitted it; A4 included it. **Resolved by direct byte read** (dblDelay1st @0x30b): A4 correct, the zero field exists.
3. **Channel preamble splits** — A3 `…"VST Multitrack", u32 1` vs A4 `…, u32 0, u8 1`; A1/A3 `60 00 00 04` vs A4 `00 60 00 00 04`. **Not real contradictions**: identical bytes, different accounting of the lpstr NUL (lpstr length includes the NUL; the spec above uses that convention).
4. **Empty-slot record size 17 vs 19 bytes** — context-dependent, not a contradiction: audio insert slots (A1, 17 B) lack the trailing `u16 channelCount` that VSTi rack slots carry (A2, 19 B, arithmetic-proven).
5. **Slot tail decoding** — A2 (u32 0, u32 N, −1…−N table, u16 0) vs A3 ("0x48-byte connection sub-block", pin ints) vs A4 (channel-width pairs + flags): overlapping partial decodes, possibly genuinely different for effect vs instrument slots. Treat the tail as length-delimited opaque (recover displayName from its lpstr at the end).
6. **`u32 0x4C/0x75` in channel header** — A3: unknown; A4: sequential channelID. A4's is the more specific claim but only inferred.
7. **p6-fm naming vs content** — file names imply A1 was added between the pair; bytes prove both already contain FM8+A1 (A2, diff-proven). Bytes win.

### TOP REMAINING UNKNOWNS blocking a plugin-recreation importer
1. **~~Fader/pan value encoding~~ — RESOLVED (2026-06-12; taper calibrated EXACT).** Modern: `Volume.AnchorValue` = dB (byte-exact f64, XML↔binary cross-checked Δ=0); `Pan.Value` = i64 −64..63, absent = center (§5); **C13+ pan lives ONLY in the Standard Panner component blob — decoded 2026-07-17, §5a**. SX/C5: f32/f64 `Volume Value` (25856 = 0 dB) decoded with the **calibrated piecewise-linear-in-gain taper** (§1; < 1e-6 dB against 700+ modern Value↔AnchorValue pairs — the earlier `(Value/25856)^2` approximation is CONFIRMED WRONG). Both imported by CprImportProvider (`scripts/cpr-mixer-test.mjs` validates against the XML oracle + user-read labeled fixture dB). *Still open:* the SX pan field is unidentified (SX channels left centered). Caveat: the calibration pairs all come from modern (C5+) saves; SX-era Values migrate byte-identical into modern `Volume.Value`, so the taper is era-stable by migration evidence, but no native-SX moved-fader save pair exists in the corpus.
2. **Slot bypass/program fields** — the `u32 1, u32 0, u32 0` triple before stateLen and which bit is per-slot bypass/active; all corpus slots are default-enabled.
3. **Slot tail / routing block semantics** (incl. the −1…−N table, 0xFFFFFFFE markers, modern `Patcher` IDs 0 vs −2 on mono Waves slots) — needed for correct channel I/O recreation.
4. **EQ — imported (modern era) since 2026-06-12; Type→shape mapping unverified.** MyDAW
   now has a per-track parametric EQ, so the modern C5/C12 channel EQ is decoded into
   `Track.eq` (see §7.5 for the attr-tree layout). The one open item: the Cubase **`Type`
   integer → EQ-shape mapping is inferred, not byte-verified** — the importer passes the raw
   `Type` (0..5) straight through to MyDAW's enum (peak/lowShelf/highShelf/highCut/lowCut/
   notch) and a channel with any *enabled* band logs an "unverified mapping" warning. Corpus
   EQs are almost all disabled, so this rarely bites; a Track Archive export of a project with
   an enabled channel EQ (see §8) would pin the mapping. The SX-era 22-byte band record's
   field→Gain/Freq/Q/Type layout is still undecoded (SX files import no EQ).
   **Sends — still NOT imported.** Every `SendFolder.Slot` in the corpus is empty/inactive
   (`OldOn=0`, `Output.Value=0`); active-send destinations resolve to FX/group channels, which
   v1 does not model as tracks — so send import is **blocked on FX/group-channel modeling**
   (the importer counts the empty slots and logs them, never creating dangling sends). A
   send-to-master would be importable but is absent here.
5. **VST3 bridging** — for plugins that exist only as VST3 in modern hosts, the `'VST'+fourcc` GUID covers wrapped VST2 only; mapping fourcc → real VST3 class ID must come from an external table.
6. **The `"11"` idString prefix** (constant in corpus; unknown whether other values exist, e.g. for shell/category variants) and the empty-placeholder ID `2233…0774`.
7. **Non-chunk (FxBk/FxCk) recreation** — parameter order/count is plugin-defined; importer can only replay f32 params blindly.
8. **Modern Quick-Controls region** (attr subtype 0x14, `QCDestinations`) and SX Devices `dFlt/hPos/inpu/mstr/xtnd` records — likely view-only, unconfirmed.

Tooling: `scripts/cpr-analyze.mjs` (in-repo record walker) plus one-off byte-diff scripts that lived outside the repo (anchored byte-diffs, rack/slot walkers, a modern attr-tree parser) and were not preserved. The private playground corpus was only ever read, never modified.

---

## 7. Record layouts & decoder notes (added 2026-06-12)

Byte-level structures that the importer (`engine/src/import/CprImportProvider.cpp`) actually
decodes but that were previously only in code comments. Endianness: structural ints are
**big-endian** (container/lpstr), but the **plugin-state chunks and PlugSound internal records
are little-endian** (plugin-private); the fields below note which.

### 7.0 PPQN / time base — CONFIRMED
PPQN is a constant **480** ticks/quarter across *all* versions (2004–2026). Musical positions
and lengths are `f64` ticks (fractional for live/quantized takes). `beats = ticks / 480`.
(`kPpq` in CprImportProvider.cpp.)

### 7.1 `AudioFile` record — CONFIRMED (offsets verified against real wav headers)
From the record's `dataStart`:
| off | type | field |
|---|---|---|
| +0 | u64 | `totalSamples` (frames) |
| +10 | u16 | `bytesPerFrame` (NOT channels — common mis-read) |
| +12 | u16 | `channels` (1=mono, 2=stereo) |
| +14 | f32 | `sampleRate` (e.g. 44100) |
The `channels`-at-+12 fix was the key correction during implementation (the +10 u16 is
bytesPerFrame). Used to size/scale the imported asset before the wav itself is found.

### 7.2 `MTempoTrackEvent` — CONFIRMED
`u32 n` (point count); then `n × 22 B { f32 secondsPerQuarter, f64 cachedTimeSec,
f64 positionTicks, u16 curveType }`; then `f32 fixedModeBPM`; then `u16 modeFlag`.
`modeFlag == 1` ⇒ **fixed ("rehearsal") tempo** — the point list is inactive and the single
`fixedModeBPM` rules (bpm = 60 / secondsPerQuarter for points). First entry forced to beat 0;
bpm clamped 20..400.

### 7.3 `MSignatureTrackEvent` — CONFIRMED
`u32 n`; then `n × 18 B { f64 positionTicks, u8 numerator, u8 denominator, u16 curveType }`.
Bars are walked through the map itself (0-based first entry). Default 4/4 when absent.

### 7.4 MIDI event stream (`MMidiPart`) — CONFIRMED
A single stream mixes **compact** (`u8 statusTag`) and **record-form** (`u8 0x00` + lpstr
class header + `u32 size`) encodings. Event body: `f64 tick, u8 channel, u8 d1, u8 d2,
u32 flags, u16 nExt, nExt × 14 B tagged extensions`. **Notes** (`tag 0x90`) carry an
additional `f64 lengthTicks` (+ `f64`, `u8[9]`). Shorts — CC `0xB0`, pitch-bend `0xE0`
(14-bit → controller 128), channel-aftertouch `0xD0` (→129), program/poly-pressure
(skipped) — are fixed-length after the extensions. Sysex aborts the stream safely.
Abs time = `partStart + tick − partOffset`; a note starting >1 tick before a trimmed part
is dropped (hidden/unplayed in Cubase).

### 7.5 Modern channel **EQ** band (attr tree) — CONFIRMED layout, type-mapping INFERRED
`EQ` member (`Bypass:i64`, `Band:` array type 0x05). Each `Band[i]` element carries
`Enable (i64 bool), Type (i64), Gain (f64 dB), Freq (f64 Hz), Q (f64)`, reached at attr
path `[EQ, Band]` (depth 2). The importer maps these into `Track.eq.bands[]`; non-finite
Freq/Gain/Q skip the band. Raw `Type` codes seen in the corpus: **1 and 5** on disabled
default bands (plausibly lowShelf / notch). The `Type → MyDAW shape` enum mapping
(0=peak,1=lowShelf,2=highShelf,3=highCut,4=lowCut,5=notch) is a **pass-through guess** — see
§6 unknown #4; an enabled-band channel logs a warning.

### 7.6 SX insert-rack header / VSTi rack slot — CONFIRMED
SX insert area header ends with a discriminating tag: `u32 Bypass=0, u32 SeparationPosition=6,
u32 slotCount(1..8), u32 tag` where **`tag==2` = insert rack**, **`tag==1` = send area**.
SX **VSTi rack** (the `FMemoryStream` "VST Mixer" blob, magic `0xAB19CD2B`, 64 slots): a loaded
instrument slot is followed by `u16 channelCount` + output-channel blocks in the `VST Multitrack`
grammar; empty rack slot = 19 B, an audio-insert slot inside = 17 B (the 17/19 difference is just
the missing trailing `channelCount`). The `−1…−N` routing-table size N ≈ output/MIDI capacity
(2 for most, 64 for Kontakt 5) — INFERRED.

**Slot-tail displayName = the routing device name — CONFIRMED (2026-06-12).** The `lpstr
displayName` in a slot's tail (§2: the LAST printable lpstr inside the slot payload, after the
state chunk; `~end−25 B`) is the **disambiguated VST-rack device name** that MIDI tracks route
to — *not* the bare plugin display name from the `idString` field. When several instances of one
plugin are racked, the `idString` display is identical for all (e.g. all seven UVI PlugSound
drum instances read `"PS03 - Drums&Percs"`), but the slot-tail displayName carries Cubase's
auto-suffix: `"PS03 - Drums&Percs"`, `"PS03 - Drums&Percs 2"`, …`"PS03 - Drums&Percs 7"`. The
importer (`sxParseSlot`, `XPlugin::routeName`) extracts this slot-tail name and matches it
against each MIDI track's output Device Name (§7.7). Byte-verified on `jazz with omri.cpr`: all
nine rack slots' tail displayNames reproduce the nine MIDI-track routing targets exactly.

### 7.7 SX MIDI-track → VSTi-rack output routing — CONFIRMED (2026-06-12)
In Cubase SX a **VST instrument lives in the separate VST Rack** (the Devices "VST Mixer" blob,
§7.6), and each MIDI track *routes* to a rack instrument via an output assignment. MyDAW models
this directly: **`Track.midiTarget`** (SPEC §5.2/§6) routes a MIDI track's events into an
Instrument-kind track's instrument — one shared instance, no per-track duplication — so the
importer reproduces the original SX structure 1:1.

The routing lives in the MIDI track's **"Track Device"** sub-object — the direct-child
`MMidiTrack` record of the `MMidiTrackEvent` (NOT the `MMidiTrack` channel record). Its body,
read sequentially from `dataStart` (all ints big-endian, `lpstr` = `u32 len incl. NUL + chars`):

| field | type | value (corpus) |
|---|---|---|
| Connection Type | `u16` | `3` |
| **Device Name** | `lpstr` | **the target rack-instrument name** (the routing key) |
| pad | `u8[3]` | `00 00 00` |
| Port Name | `lpstr` | duplicate of Device Name |
| Input Type | `u16` | `3` |
| Input Device Name | `lpstr` | e.g. `"All MIDI Inputs"` |
| input-port type | `u16` | `0x0002` |
| Input Port Name | `lpstr` | e.g. `"All MIDI Inputs"` |
| **Midi Channel** | `u32` | `0..15` |
| … | | `PMixerChannel`/`PDevice` sub-tree (`FFFFFFFE…` headers) |

The **Device Name is a literal `lpstr`** here (not a back-ref); it equals the routed rack
instrument's slot-tail displayName (§7.6). The **Midi Channel** is the `u32` immediately
following the (second) Input Port Name `lpstr`. Both fields decode byte-exact
(`decodeSxMidiRoute`): on `jazz with omri.cpr` all nine tracks reproduce the Track-Archive-XML
oracle — Device Name AND channel (`PS01 - Keyboards` ch 8, `PS02 - FRETTED` ch 1, the seven
`PS03 - Drums&Percs[ 2..7]` ch 0). The importer currently matches by **Device Name only** (the
channel is decoded and stored but not yet used to filter events — a 1:1 routing needs no channel
split).

**Importer behavior (`CprImportProvider.cpp`).** During the MIDI-track walk, each SX MIDI
track's output Device Name (+ channel) is captured into `CprCtx::midiRoutes`. In
`sxExtractVstiRack`, **every** rack instrument becomes exactly **one standalone Instrument
track** (named after the disambiguated slot-tail displayName when routed; bare plugin name when
unrouted) carrying the dormant instrument insert + its output-channel inserts (e.g. Waves REQ on
the PS03 track). The importer then looks up MIDI tracks whose Device Name matches the
instrument's slot-tail displayName (exact, then a trim/case/whitespace-normalized fallback):
- **Routed (1:1 and N:1)** — each matching MIDI track keeps `kind:"midi"` and its clips/notes,
  and gets `Track.midiTarget` set to the instrument track's id. N:1 (several MIDI tracks → one
  multitimbral instrument) simply points several midiTargets at the **same shared instance** —
  no insert/state duplication. Logged at `info`.
- **Unrouted** — a rack instrument with no matching MIDI track keeps the standalone Instrument
  track without feeders; only these are warned as needing manual re-routing
  (`cmd/track.set midiTarget`).
- The decoded **Midi Channel stays captured-but-unused** (`CprCtx::MidiRoute::channel`) — 1:1
  slot routing needs no channel split; kept for a future channel-filter feature.

Validated on `jazz with omri.cpr` (private): 9 MIDI tracks → 9 rack instruments by name
(`PS01 - Keyboards` ch 8, `PS02 - FRETTED` ch 1, `PS03 - Drums&Percs[ 2..7]` ch 0), 18 model
tracks (9 feeders + 9 instrument tracks), note counts preserved (`scripts/cpr-import-test.mjs`;
end-to-end render through the shared instances: `scripts/midi-route-render-test.mjs`).
**SX-specific:** modern `MInstrumentTrackEvent` tracks already self-contain their VSTi in a
"Synth Slot" and never reach this path (the importer guards the decode behind `isSxEra`).

## 8. Track Archive XML — the labeled twin / decoder key

A Cubase **Track Archive** (`File > Export > Selected Tracks` → `.xml`) is the human-readable
equivalent of the binary attr-tree: **identical class names, member names and object IDs**, just
labeled. It was the Rosetta stone for the volume/pan/EQ decode — `Volume.AnchorValue` (the dB),
`Pan.Value`, `EQ.Band[]`, and `SendFolder.Slot{Volume, Output, OldOn}` all appear by name, and
plugin state is a labeled `<bin name="audioComponent">` element (so a Track Archive is *also* a
potential plugin-state source). `scripts/trackarchive-xml.mjs` parses it; `scripts/cpr-mixer-test.mjs`
cross-validates the binary importer against it byte-exact (Δ = 0.000000 dB). **Recommended workflow
for decoding any new field:** export a Track Archive of a project that uses the field, read the
labeled value, then locate the same bytes in the `.cpr`. Note one era difference observed: the
`Pan` member's `Max` is **63 in C12** but **64 in C5**; the channel-level `Pan` is usually absent
(centered), and a `-64` `Pan` seen deeper in the tree is a **MIDI-splitter** pan (under
`PMidiEffectBase`), not the audio-channel fader — do not mistake it for the track pan.
**No era's archive has a channel `Pan` member** (C5.1.1 verified 2026-07-17) — the pan is
the first f32le of the channel `Panner`'s `<bin name="audioComponent">` (§5a);
`trackarchive-xml.mjs` decodes it as `panPos`/`panNorm` alongside the legacy `pan` int.