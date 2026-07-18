// MyDAW — midi/SmfTrackPlan.h
// Shared SMF -> model-track planning for the two SMF import paths (SmfImportProvider,
// SPEC §5.1; Api media/import commit, SPEC §5.5).
//
// Logic Platinum exports format-1 files with ONE MTrk PER REGION: dozens of chunks that
// share a (sanitized) track name + channel and carry FF 20 channel-prefix / C0 program
// metas. Naively mapping one model track per MTrk yields ~75 duplicate tracks.
// groupSmfTracks() groups a format-1 file's ImportedTracks by (sanitized name, primary
// channel); a group with >= 2 members is CONSOLIDATED — one model track, one MidiClip per
// source MTrk positioned at its content (start floored / end ceiled to the file's bar
// grid; clips may overlap, the model and scheduler tolerate that). Groups of one member
// (every normal export — distinct names/channels per track) keep the legacy one-track/
// one-clip-at-beat-0 behavior, decided by the CALLER on `consolidated == false`.
//
// buildConsolidatedClip() materializes one member MTrk into a MidiClip: allocates real
// ids via Model::nextId, converts the reader's ABSOLUTE file beats to CLIP-RELATIVE
// note/cc positions (Model.h: Note.startBeat / MidiCc.beat are relative to clip start),
// clamps ranges and sorts cc by (controller, beat). Callers add any placement offset
// (e.g. media/import atBeat) AFTER, to clip.startBeat only.
//
// Non-RT, main/worker thread use only.

#pragma once

#include <string>
#include <vector>

#include "midi/SmfReader.h"
#include "project/Model.h"

namespace mydaw {

// One planned model track: 1..N source MTrks that share (name, channel).
struct SmfTrackGroup {
    std::string name; // sanitized group name (never empty; reader applies fallback)
    int channel = -1; // primary channel shared by the members, -1 = none recorded
    int program = -1; // first program change among members (file order), -1 = none
    bool consolidated = false; // true => >= 2 members: one clip per member at its
                               // content position; false => caller keeps legacy layout
    std::vector<const SmfData::ImportedTrack*> members; // file order, never empty
};

// Groups data.tracks for model-track creation. Format-1 files group by
// (name, primaryChannel); other formats (and groups of one) pass through one-to-one.
// Group order follows the first member's file order. Pointers alias data.tracks.
std::vector<SmfTrackGroup> groupSmfTracks(const SmfData& data);

// Bar-grid helpers over a TimeSigEntry map (TempoMap.h conventions: sorted, first entry
// at bar 0 — SmfData::timeSigMap guarantees this). Positions are in beats.
double barFloorBeat(const std::vector<TimeSigEntry>& sigs, double beat);
double barCeilBeat(const std::vector<TimeSigEntry>& sigs, double beat);

// Materializes one consolidated-group member as a MidiClip named `name`, placed on
// `sigs`' bar grid: startBeat = firstEventBeat floored to a bar, end = content end
// ceiled to a bar (degenerate spans get one full bar so no event sits at/past the clip
// end, which the scheduler would drop). Ids allocated from `m`.
MidiClip buildConsolidatedClip(Model& m, const SmfData::ImportedTrack& src,
                               const std::string& name,
                               const std::vector<TimeSigEntry>& sigs);

} // namespace mydaw
