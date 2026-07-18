// MyDAW — midi/SmfReader.h
// Standard MIDI File (.mid) parser for media/import (SPEC §5.5). Supports format 0 and 1
// with PPQN (ticks-per-quarter) division; SMPTE division and format 2 are rejected with a
// clear error. Variable-length quantities, running status, tempo / time-signature / track-
// name / channel-prefix meta events, per-track-per-channel note pairing, the first program
// change, and CC / pitch-bend / channel-aftertouch capture are handled; SysEx and all
// other events are skipped.
//
// Track names are SANITIZED for model/JSON use: truncated at the first control byte
// (< 0x20 — Logic Platinum embeds NULs mid-name), trailing whitespace trimmed, a
// trailing Logic region-operation suffix "*recorded" / "*copied" / "*merged" /
// "*divided" / "*created" (case-insensitive) stripped, and the result GUARANTEED to be
// valid UTF-8 (names that fail validation are legacy 8-bit and transcode Latin-1 ->
// UTF-8; nlohmann::json's strict dump throws on invalid UTF-8, so an unsanitized name
// would crash project save/autosave). The unsanitized bytes are kept in `rawName` for
// diagnostics only — never put them in the model or on the wire.
//
// Tempo/time-signature mapping: ALL tempo and time-signature metas (any track) are
// collected into `tempoMap`/`timeSigMap` (TempoMap.h conventions: TempoEntry{beat,bpm},
// TimeSigEntry{bar,num,den}, sorted, first entry at beat 0 / bar 0 — synthesized from
// the first meta, or 120 bpm / 4/4 when the file has none). `bpm`/`tsNum`/`tsDen`
// mirror the first map entries (legacy single-tempo consumers). Ticks convert to beats
// as ticks / division (beat = quarter note, SPEC §4).
//
// Tracks with neither notes nor cc (e.g. the conductor track of a format-1 file) are
// skipped — a well-formed file can therefore legally yield zero tracks; callers should
// treat `tracks.empty()` as "nothing to import". Note/cc ids are left 0 (the importer
// allocates real ids via Model::nextId when creating clips).
//
// Non-RT, main/worker thread use only.

#pragma once

#include <string>
#include <vector>

#include "project/Model.h" // Note, MidiCc

namespace mydaw {

// Parsed contents of one Standard MIDI File.
struct SmfData {
    int format = 0;     // MThd format word (0 or 1; others rejected)
    double bpm = 120.0; // tempoMap.front().bpm; 120 when absent
    int tsNum = 4;      // timeSigMap.front(); 4/4 when absent
    int tsDen = 4;

    std::vector<TempoEntry> tempoMap;     // full map; >= 1 entry, first at beat 0
    std::vector<TimeSigEntry> timeSigMap; // full map; >= 1 entry, first at bar 0

    struct ImportedTrack {
        std::string name;    // meta 0x03, SANITIZED (header); "Track <n>" fallback
        std::string rawName; // meta 0x03 verbatim (may hold NULs); diagnostics only
        std::vector<Note> notes; // sorted by startBeat; startBeat from file start, ids 0
        // CC (0..127), pitch bend (128) and channel aftertouch (129) points, ABSOLUTE
        // beats from file start, values normalized 0..1, ids 0, sorted by
        // (controller, beat). Sysex / poly-AT are dropped.
        std::vector<MidiCc> cc;
        double lengthBeats = 0.0;    // end of the last note / cc point
        double firstEventBeat = 0.0; // start of the earliest note / cc point
        int channelPrefix = -1;      // first FF 20 meta (0..15), -1 = none
        int primaryChannel = -1;     // channel of the first channel-voice event, -1 = none
                                     // (always >= 0 on emitted tracks — they have events)
        int program = -1; // first program change (C0) value, -1 = none. Parsed for future
                          // use (instrument mapping); not represented in the model yet.
    };
    std::vector<ImportedTrack> tracks; // tracks with neither notes nor cc skipped
};

class SmfReader {
public:
    // Parses `path` into `out`. Returns false with a human-readable `err` on failure
    // (unreadable file, bad header, SMPTE division, format 2). Malformed data INSIDE a
    // track chunk is tolerated: a warning is logged and the notes parsed so far are kept.
    static bool read(const std::string& path, SmfData& out, std::string& err);
};

} // namespace mydaw
