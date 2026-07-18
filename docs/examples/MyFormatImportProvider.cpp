// MyDAW — docs/examples/MyFormatImportProvider.cpp
// =============================================================================
// SKELETON ImportProvider for a fictional ".myf" project format.
//
// This file COMPILES as-is once copied to engine/src/import/ (the engine CMake
// globs engine/src recursively with CONFIGURE_DEPENDS — no build-file edits).
// It is NOT built from docs/. Full guide: docs/IMPORT_PROJECT.md.
//
// To adapt it:
//   1. Copy to engine/src/import/MyFormatImportProvider.cpp (rename as you like).
//   2. Rename the class + id() + displayName() + extensions().
//   3. Replace the "PARSE YOUR FORMAT" block with a real parser, keep the
//      conversion patterns (nextId for every entity, beats not seconds, clamps).
//   4. Register it in engine/src/import/Providers.cpp — exact lines at the
//      bottom of this file.
//   5. pwsh scripts/rebuild.ps1 -Engine, then File > Import Project.
//
// Contract reminders (ImportProvider.h):
//   - import() runs synchronously on the engine MAIN thread (like project/load),
//     never the RT audio thread. Do NOT touch engine state — only fill `out`.
//   - `out` arrives as Model::defaultProject(): master track (id 1) exists,
//     tempo 120 bpm at beat 0, 4/4 at bar 0, nextId == 2. Mutate it.
//   - ctx.progress MAY BE NULL — always null-check before calling.
//   - On failure: fill `err` with a USER-READABLE message and return false.
//     Partial mutation of `out` is fine; the scratch model is discarded.
// =============================================================================

#include <algorithm> // std::clamp, std::max
#include <cstdint>
#include <cstdio>    // FILE*, fread — the codebase uses C stdio + _wfopen, not fstream
#include <cstring>   // std::memcmp for magic-byte checks
#include <memory>
#include <string>
#include <vector>

#include "import/ImportProvider.h"
#include "project/Model.h"
#include "util/Paths.h" // utf8ToWide (all engine strings are UTF-8; Win32 wants wide), fileName
// #include "media/AssetStore.h" // uncomment if you import referenced audio (section D below)

namespace mydaw {

namespace {

// ---------------------------------------------------------------------------
// File helpers — the codebase pattern for opening user paths on Windows:
// engine-internal strings are UTF-8, so convert with utf8ToWide() and use the
// wide CRT (_wfopen). Never pass UTF-8 to fopen() — non-ASCII paths would fail.
// ---------------------------------------------------------------------------

// "C:\songs\demo.myf" -> "demo" (used as the imported project's name).
std::string fileStem(const std::string& path) {
    std::string name = fileName(path); // util/Paths.h: final path component
    const size_t dot = name.find_last_of('.');
    if (dot != std::string::npos && dot > 0)
        name.resize(dot);
    return name;
}

// Read up to `want` bytes from the start of the file (for probe()).
bool readHead(const std::string& path, uint8_t* buf, size_t want, size_t& got) {
    FILE* f = _wfopen(utf8ToWide(path).c_str(), L"rb");
    if (!f)
        return false;
    got = std::fread(buf, 1, want, f);
    std::fclose(f);
    return true;
}

// Slurp the whole file (fine for project files; they are small).
bool readAllBytes(const std::string& path, std::vector<uint8_t>& bytes) {
    FILE* f = _wfopen(utf8ToWide(path).c_str(), L"rb");
    if (!f)
        return false;
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (size < 0) {
        std::fclose(f);
        return false;
    }
    bytes.resize(static_cast<size_t>(size));
    const size_t got = size > 0 ? std::fread(bytes.data(), 1, bytes.size(), f) : 0;
    std::fclose(f);
    bytes.resize(got);
    return true;
}

// Fictional ".myf" magic: the first 4 bytes are "MYF1".
constexpr uint8_t kMagic[4] = {'M', 'Y', 'F', '1'};

} // namespace

// =============================================================================
// The provider
// =============================================================================
class MyFormatImportProvider : public ImportProvider {
public:
    // Stable lowercase id — appears in project/getImportFormats and log lines.
    // Never change it once shipped.
    std::string id() const override { return "myformat"; }

    // Human-readable name — becomes the native file dialog's filter label.
    std::string displayName() const override { return "My Format (example)"; }

    // Lowercase, NO dot. Drives both the dialog filter ("*.myf") and
    // ImportProviderRegistry::forPath() candidate matching (case-insensitive).
    std::vector<std::string> extensions() const override { return {"myf"}; }

    // ------------------------------------------------------------------------
    // probe() — cheap content sniff, called AFTER an extension match.
    //
    // The base-class default returns true (extension match suffices). Override
    // it when your extension is generic or shared: check a few magic bytes and
    // decline with a one-line `whyNot`. A rejection is logged and the registry
    // FALLS THROUGH to the next provider registered for the same extension —
    // so honest probes are what resolve extension collisions.
    // Keep it fast: read a handful of bytes, never parse the whole file here.
    // ------------------------------------------------------------------------
    bool probe(const std::string& absPath, std::string& whyNot) const override {
        uint8_t head[4] = {};
        size_t got = 0;
        if (!readHead(absPath, head, sizeof(head), got)) {
            whyNot = "cannot open file";
            return false;
        }
        if (got < sizeof(kMagic) || std::memcmp(head, kMagic, sizeof(kMagic)) != 0) {
            whyNot = "not a My Format file (missing MYF1 header)";
            return false;
        }
        return true;
    }

    // ------------------------------------------------------------------------
    // import() — parse the foreign file and build the project in `out`.
    // ------------------------------------------------------------------------
    bool import(const std::string& absPath, const ImportContext& ctx, Model& out,
                std::string& err) override {
        // Progress contract: 0..1, monotonically increasing, MAY BE NULL.
        // Each call is broadcast to the UI as event/importProgress {path, pct}.
        if (ctx.progress)
            ctx.progress(0.0f);

        // ====================================================================
        // A. OPEN + PARSE YOUR FORMAT
        // ====================================================================
        std::vector<uint8_t> bytes;
        if (!readAllBytes(absPath, bytes)) {
            err = "cannot open file: " + absPath; // shown to the user verbatim
            return false;
        }
        if (bytes.size() < sizeof(kMagic) ||
            std::memcmp(bytes.data(), kMagic, sizeof(kMagic)) != 0) {
            err = "not a My Format file (missing MYF1 header)";
            return false;
        }

        // >>> PARSE YOUR FORMAT HERE <<<
        //
        // Walk `bytes` and extract whatever your format stores: tempo, time
        // signature, tracks, events, referenced audio files, markers...
        // Two rules that matter during parsing:
        //   - Convert ALL musical positions to BEATS (quarter notes, double).
        //     If your format uses ticks: beats = ticks / ticksPerQuarter.
        //     If it uses seconds:        beats = seconds * bpm / 60.0.
        //   - Be deterministic: same file in, same project out (tests rely on
        //     it). No RNG, no wall clock, no unordered-container iteration when
        //     emitting tracks/clips.
        //
        // The hardcoded values below stand in for your parse results so this
        // skeleton compiles and demonstrates every conversion pattern.
        const double parsedBpm = 95.0;     // <- from your file
        const int parsedTsNum = 4;         // <- from your file
        const int parsedTsDen = 4;         // <- from your file

        if (ctx.progress)
            ctx.progress(0.3f); // parsing done, conversion next

        // ====================================================================
        // B. PROJECT-LEVEL FIELDS
        // ====================================================================
        // `out.project` is already Model::defaultProject() — overwrite what the
        // file defines, leave the rest (grid, ui block, formatVersion) alone.
        out.project.name = fileStem(absPath); // imported projects are named after the file
        // Audio assets are resampled to the session rate at import (SPEC §4),
        // so the project adopts the CURRENT session sample rate, not the file's.
        out.project.sampleRate = ctx.sessionSampleRate;
        // Importing a foreign PROJECT adopts the file's musical timeline — the
        // tempo/timesig REPLACE the 120bpm/4-4 defaults. v1 maps hold a single
        // entry: tempo at beat 0, time signature at bar 0 (bar is 0-based).
        out.project.tempoMap = {TempoEntry{0.0, parsedBpm}};
        out.project.timeSigMap = {TimeSigEntry{0, parsedTsNum, parsedTsDen}};

        // ====================================================================
        // C. TRACKS, CLIPS, NOTES
        // ====================================================================
        Track t;
        t.id = out.nextId();        // EVERY entity id comes from out.nextId().
                                    // Hardcoded/reused ids corrupt undo + lookups.
        t.kind = TrackKind::Midi;   // Audio | Midi | Instrument | Folder | Bus.
                                    // NEVER Master — out.project.masterTrack (id 1)
                                    // already exists; do not add another or mutate
                                    // its kind/id (rename/recolor is fine).
        t.name = "Imported Track";  // fall back to "Track <n>" for unnamed tracks
        t.color = "#54a3e8";        // hex color; SmfImportProvider.cpp has the
                                    // 12-color palette the rest of the app uses.
        // t.volume = 1.0;          // LINEAR gain, 1.0 == 0 dB (not dB!) — default.
        // t.pan = 0.0;             // -1 (left) .. +1 (right) — default center.
        // t.outputTarget defaults to OutputTarget::master() — correct for normal
        // tracks. Only set ::track(id) when routing to a TrackKind::Bus you also
        // created; dangling/cyclic routing is invalid.

        MidiClip clip;
        clip.id = out.nextId();
        clip.name = t.name;
        clip.startBeat = 0.0;       // timeline position, in beats from project start
        clip.lengthBeats = 4.0;     // grow below to cover the notes (whole bars look
                                    // tidiest — see SmfImportProvider's bar rounding)

        // One demo note per conversion rule. In real code: loop your parsed events.
        {
            Note n;
            n.id = out.nextId();                    // yes, notes get ids too
            n.pitch = std::clamp(60, 0, 127);       // MIDI note number, 60 = C4.
                                                    // CLAMP — foreign files lie.
            n.velocity = std::clamp(100, 1, 127);   // 1..127 (0 is not a valid
                                                    // stored velocity — clamp up
                                                    // or drop the note).
            n.startBeat = 0.0;                      // RELATIVE TO THE CLIP START,
                                                    // not the project timeline.
            n.lengthBeats = 1.0;                    // a quarter note
            // n.channel = 0;                       // optional, 0..15, default 0
            clip.notes.push_back(n);                // keep notes sorted by startBeat
            clip.lengthBeats = std::max(clip.lengthBeats, n.startBeat + n.lengthBeats);
        }

        t.clips.emplace_back(std::move(clip)); // Clip is std::variant<AudioClip, MidiClip>
        out.project.tracks.push_back(std::move(t));

        if (ctx.progress)
            ctx.progress(0.8f);

        // ====================================================================
        // D. REFERENCED AUDIO (uncomment + adapt if your format references or
        //    embeds audio; pure-MIDI formats skip this entirely)
        // ====================================================================
        // Route external audio through the AssetStore so it is decoded,
        // resampled to the session rate and copied into the project folder
        // (needs: #include "media/AssetStore.h" at the top of this file).
        //
        // Asset asset;
        // asset.id = out.nextId(); // assign BEFORE importFile — with a non-zero
        //                          // id it also generates peaks + caches the PCM.
        // std::string aerr;
        // // NOTE: ctx.projectDirHint MAY BE EMPTY (previous project never
        // // saved); importFile then fails with "no project directory". See
        // // docs/IMPORT_PROJECT.md §4 for the originalPath fallback pattern.
        // if (!ctx.assetStore->importFile(absReferencedWavPath, ctx.projectDirHint,
        //                                 ctx.sessionSampleRate, asset, aerr)) {
        //     err = "cannot import referenced audio '" + absReferencedWavPath +
        //           "': " + aerr;
        //     return false; // or skip just this clip — your call, but log it
        // }
        // out.project.assets.push_back(asset);
        //
        // AudioClip ac;
        // ac.id = out.nextId();
        // ac.name = fileStem(absReferencedWavPath);
        // ac.startBeat = 0.0;                      // position: beats (musical)
        // ac.assetId = asset.id;                   // must reference project.assets
        // ac.srcOffsetSamples = 0;                 // contents: samples (audio)
        // ac.lengthSamples = asset.lengthSamples;  // play the whole asset
        // ac.gain = 1.0;                           // linear
        // // ac.fadeInSec / ac.fadeOutSec are SECONDS — the deliberate exception.
        // audioTrack.clips.emplace_back(std::move(ac));
        //
        // (After adoption the engine loadAsync()s every asset automatically —
        //  never call AssetStore::loadAsync/setProjectDir/clear yourself.)

        // ====================================================================
        // E. FINISH
        // ====================================================================
        if (out.project.tracks.empty()) {
            err = "file contains no usable tracks"; // empty imports are an error,
            return false;                           // not a silent blank project
        }
        // Optional niceties: a loop region spanning the song, markers, ...
        // out.project.loop = LoopRegion{0.0, songEndBeat, false};

        if (ctx.progress)
            ctx.progress(1.0f);
        return true;
    }
};

// Factory — keeps this provider a single self-contained .cpp (no header needed).
// Alternatively, split into .h/.cpp like import/SmfImportProvider.{h,cpp} and
// include the header from Providers.cpp instead.
std::unique_ptr<ImportProvider> makeMyFormatImportProvider() {
    return std::make_unique<MyFormatImportProvider>();
}

} // namespace mydaw

// =============================================================================
// REGISTRATION — providers are explicitly registered, never self-registering.
// Paste into engine/src/import/Providers.cpp:
//
//   // near the top, with the other declarations/includes (namespace mydaw):
//   std::unique_ptr<ImportProvider> makeMyFormatImportProvider(); // MyFormatImportProvider.cpp
//
//   // inside registerAllImportProviders(), in the marked block:
//   reg.add(makeMyFormatImportProvider());
//
// Then: pwsh scripts/rebuild.ps1 -Engine
// =============================================================================
