// MyDAW — midi/SmfWriter.h
// Standard MIDI File (.mid) writer for export/midi (SPEC §5.5). Writes format 1 at
// 480 PPQN: track 0 carries the full tempo map (set-tempo metas, microseconds per
// quarter) and time-signature map (bar starts resolved through TempoMap::beatAtBar);
// then one MTrk per midi/instrument track in model order — track-name meta plus all
// UNMUTED clips' notes and cc points flattened to absolute ticks on channel 0
// (MidiCc controller 128 -> pitch bend, 129 -> channel aftertouch). Notes/cc outside
// their clip bounds are clamped/skipped exactly like playback baking. Full status
// bytes are written for every event (no running status); every track ends with an
// end-of-track meta.
//
// Non-RT, main/worker thread use only.

#pragma once

#include <string>

namespace mydaw {

class Model;

class SmfWriter {
public:
    // Writes `model` to `absPath`. Returns false with a human-readable `err` on
    // failure (unwritable path, disk error). A project without midi/instrument tracks
    // still produces a valid file containing only the conductor track.
    static bool write(const Model& model, const std::string& absPath, std::string& err);
};

} // namespace mydaw
