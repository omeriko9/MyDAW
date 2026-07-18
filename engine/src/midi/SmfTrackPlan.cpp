// MyDAW — midi/SmfTrackPlan.cpp. See SmfTrackPlan.h for scope and conventions.

#include "midi/SmfTrackPlan.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <utility>

namespace mydaw {

namespace {

// Resolves the time-signature segment containing `beat`: its start beat and bar length.
// `sigs` follows SmfData::timeSigMap guarantees (sorted, first entry at bar 0); entries
// land on bar lines, so segment boundaries are themselves bar boundaries.
void segmentAt(const std::vector<TimeSigEntry>& sigs, double beat, double& segStart,
               double& bpb) {
    segStart = 0.0;
    bpb = 4.0;
    int segBar = 0;
    for (const TimeSigEntry& e : sigs) {
        const double entryStart =
            segStart + static_cast<double>(e.bar - segBar) * bpb;
        if (entryStart > beat + 1e-9)
            break; // first entry is bar 0 / beat 0, so at least one always applies
        segStart = entryStart;
        segBar = e.bar;
        bpb = (e.num > 0 && e.den > 0) ? static_cast<double>(e.num) * 4.0 /
                                             static_cast<double>(e.den)
                                       : 4.0;
        if (bpb <= 0.0)
            bpb = 4.0;
    }
}

} // namespace

double barFloorBeat(const std::vector<TimeSigEntry>& sigs, double beat) {
    if (beat <= 0.0)
        return 0.0;
    double segStart = 0.0, bpb = 4.0;
    segmentAt(sigs, beat, segStart, bpb);
    const double bars = std::floor((beat - segStart) / bpb + 1e-9);
    return std::max(0.0, segStart + std::max(0.0, bars) * bpb);
}

double barCeilBeat(const std::vector<TimeSigEntry>& sigs, double beat) {
    if (beat <= 0.0)
        return 0.0;
    double segStart = 0.0, bpb = 4.0;
    segmentAt(sigs, beat, segStart, bpb);
    const double bars = std::ceil((beat - segStart) / bpb - 1e-9);
    return segStart + std::max(0.0, bars) * bpb;
}

std::vector<SmfTrackGroup> groupSmfTracks(const SmfData& data) {
    std::vector<SmfTrackGroup> groups;
    groups.reserve(data.tracks.size());
    if (data.format != 1) { // format 0: single MTrk, nothing to consolidate
        for (const SmfData::ImportedTrack& t : data.tracks) {
            SmfTrackGroup g;
            g.name = t.name;
            g.channel = t.primaryChannel;
            g.program = t.program;
            g.members.push_back(&t);
            groups.push_back(std::move(g));
        }
        return groups;
    }
    std::map<std::pair<std::string, int>, size_t> index; // key -> groups index
    for (const SmfData::ImportedTrack& t : data.tracks) {
        const auto key = std::make_pair(t.name, t.primaryChannel);
        const auto it = index.find(key);
        if (it == index.end()) {
            index.emplace(key, groups.size());
            SmfTrackGroup g;
            g.name = t.name;
            g.channel = t.primaryChannel;
            g.program = t.program;
            g.members.push_back(&t);
            groups.push_back(std::move(g));
        } else {
            SmfTrackGroup& g = groups[it->second];
            g.members.push_back(&t);
            g.consolidated = true; // >= 2 members
            if (g.program < 0)
                g.program = t.program;
        }
    }
    return groups;
}

MidiClip buildConsolidatedClip(Model& m, const SmfData::ImportedTrack& src,
                               const std::string& name,
                               const std::vector<TimeSigEntry>& sigs) {
    MidiClip c;
    c.id = m.nextId();
    c.name = name;
    const double start = barFloorBeat(sigs, src.firstEventBeat);
    double end = barCeilBeat(sigs, src.lengthBeats);
    // The scheduler drops events at beat >= clip length (AudioGraph), so a degenerate
    // span (lone point on a bar line) or a cc sitting exactly on the end bar line gets
    // one more bar of clip.
    bool ccAtEnd = false;
    for (const MidiCc& p : src.cc)
        if (p.beat >= end - 1e-9) {
            ccAtEnd = true;
            break;
        }
    if (end - start < 1e-9 || ccAtEnd)
        end = barCeilBeat(sigs, end + 1e-3); // next bar line (min bar = 4/128 beats)
    c.startBeat = start;
    c.lengthBeats = end - start;

    c.notes.reserve(src.notes.size());
    for (const Note& s : src.notes) {
        Note n = s;
        n.id = m.nextId();
        n.pitch = std::clamp(n.pitch, 0, 127);
        n.velocity = std::clamp(n.velocity, 1, 127);
        n.startBeat = std::max(0.0, s.startBeat - start); // absolute -> clip-relative
        c.notes.push_back(n);
    }
    c.cc.reserve(src.cc.size());
    for (const MidiCc& s : src.cc) {
        MidiCc cev = s;
        cev.id = m.nextId();
        cev.controller = std::clamp(cev.controller, 0, 129);
        cev.beat = std::max(0.0, s.beat - start); // absolute -> clip-relative
        cev.value = std::clamp(cev.value, 0.0, 1.0);
        c.cc.push_back(cev);
    }
    std::stable_sort(c.cc.begin(), c.cc.end(), [](const MidiCc& a, const MidiCc& b) {
        return a.controller != b.controller ? a.controller < b.controller
                                            : a.beat < b.beat;
    });
    return c;
}

} // namespace mydaw
