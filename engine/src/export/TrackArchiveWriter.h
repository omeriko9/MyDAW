// MyDAW — export/TrackArchiveWriter.h
// Cubase "Track Archive" XML exporter (File > Import > Track Archive on the Cubase side).
// Emits the labeled twin of the .cpr binary attr-tree following the byte-verified grammar in
// docs/CPR_TRACK_ARCHIVE_WRITER_SPEC.md (derived from a Cubase 5.1.1 export). Everything the
// sample evidences (envelope, MAudioTrackEvent skeleton, formatting, taper) is emitted
// verbatim; constructs the spec marks OPEN (MIDI parts, insert slots, MIDI/Instrument track
// shapes) are emitted as best-effort INFERRED constructs and reported via `warnings`.
//
// Non-RT, main thread use only (may query the plugin host for live insert state).

#pragma once

#include <string>
#include <vector>

namespace mydaw {

class Model;
class HostProcessManager;

class TrackArchiveWriter {
public:
    // Writes `model` as a Cubase Track Archive XML to `path` (absolute, UTF-8).
    // `host` (nullable) captures live insert state; `projectDir` ("" = unsaved) resolves
    // dormant PluginInstance::stateFile blobs. Non-fatal caveats (inferred XML shapes,
    // skipped content) are appended to `warnings`; returns false + `err` only on hard
    // failures (unwritable path).
    static bool write(const Model& model, HostProcessManager* host,
                      const std::string& projectDir, const std::string& path,
                      std::vector<std::string>& warnings, std::string& err);
};

} // namespace mydaw
