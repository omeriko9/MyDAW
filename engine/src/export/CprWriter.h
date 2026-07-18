// MyDAW — export/CprWriter.h
// Cubase .cpr project exporter: a faithful C++ port of the VALIDATED Node writer
// (scripts/cpr-write.mjs PIPELINE v2 on top of the scripts/cpr-container.mjs record
// layer — real Cubase 5.1.1 + 13 open its output; docs/CPR_WRITER_M1..M3_NOTES.md).
//
// Pipeline (v2, human-validated in Cubase 5.1.1 — M3 notes):
//   - splice generated MMidiTrackEvent records into the embedded C5.1.1 donor
//     (engine/assets/cpr-donor-c5.cpr via CprDonor.gen.h), KEEPING donor track 1
//     (native tempo/signature carrier — the delete-all base is refused by C5),
//   - model tempo applied by a same-length in-place f32 patch of the kept
//     MTempoTrackEvent,
//   - the donor's MRoot track table is left UNTOUCHED (C5 tolerates stale entries but
//     refuses a rebuilt table),
//   - stored-offset-id gate: known id-bearing record bodies (audio-pool graph +
//     MAudioEvent clip links) are rebased past the edit point and re-verified against
//     the emitted bytes — the writer fails rather than ship a dangling link,
//   - post-splice verifier: the output must re-parse + re-serialize byte-identically,
//     still detect as C5, and contain exactly the generated records.
//
// Model mapping: MIDI- and Instrument-kind tracks are exported as Cubase MIDI tracks
// (notes from MidiClips; an instrument's plugin is NOT exported). AUDIO tracks are
// exported as MAudioTrackEvent records whose events carry INLINE PAudioClip records
// (FNPath referencing the project's wav on disk — no pool/AudioCluster records, so no
// stored-offset ids are generated). VST2/VST3 channel INSERTS are exported into each
// track's channel attr tree (InsertFolder/Slot/Plugin with Plugin UID GUID + fxb /
// MD3S-framed state blobs — the exact shapes CprImportProvider parses back). Volume
// uses the calibrated inverse fader taper + AnchorValue dB; pan is blob-only (§5a).
// Built-in inserts, sends, CC, automation: skipped with warnings.
// Multi-entry tempo maps export the first entry only (warning).
//
// Non-RT, main thread use only.

#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "util/Json.h"

namespace mydaw {

class Model;

class CprWriter {
public:
    // Fetch the CURRENT state chunk for a plugin instanceId (live host first, then
    // orphan store / saved stateFile — the same priority save uses). Null = no states.
    using StateFn = std::function<bool(uint64_t instanceId, std::vector<uint8_t>& out)>;

    // Writes `model` as a Cubase 5-era .cpr to `path` (absolute, UTF-8). Non-fatal
    // caveats (skipped tracks/plugins/sends, multi-tempo) are appended to `warnings`;
    // returns false + `err` on hard failures (no exportable tracks, verifier failure,
    // unwritable path). Never leaves a bad file behind: bytes are fully built and
    // verified in memory before the file is written. `projectDir` resolves relative
    // asset paths for audio-clip references (may be empty — assets then export via
    // their originalPath only); `stateFor` supplies insert state chunks (may be null).
    static bool write(const Model& model, const std::string& path,
                      std::vector<std::string>& warnings, std::string& err,
                      const std::string& projectDir = std::string(),
                      const StateFn& stateFor = nullptr);

    // Byte-parity test entry (mydaw-engine --cpr-write): consumes the writer-model JSON
    // shape of scripts/cpr-write.mjs ({tempo, tracks:[{name, kind:"midi", volumeGain,
    // pan, clips:[{startBeat, lengthBeats, notes:[{pitch,velocity,startBeat,
    // lengthBeats}]}]}]}) and produces bytes that must equal the Node writer's output
    // for the same model + donor.
    static bool writeModelJson(const json& model, std::vector<uint8_t>& out,
                               std::string& err);
};

} // namespace mydaw
