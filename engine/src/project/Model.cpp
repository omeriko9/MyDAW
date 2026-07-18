// MyDAW — project/Model.cpp (E3)
// Definitions for project/ModelOps.h. All lookup/validation helpers of Model.h are inline
// in the header; serialization lives in project/Serialize.cpp.

#include "project/ModelOps.h"

#include <algorithm>
#include <cmath>

#include "core/Mixer.h" // canonical solo-in-place closure (shared with AudioGraph::buildPlan)
#include "core/TempoMap.h"

namespace mydaw {

double clipLengthBeats(const Clip& c, const TempoMap& tm) {
    if (const MidiClip* mc = asMidi(&c))
        return mc->lengthBeats;
    const AudioClip* ac = asAudio(&c);
    if (!ac)
        return 0.0;
    const double startSample = tm.beatsToSamplesF(ac->startBeat);
    const double endBeat = tm.samplesToBeats(startSample + static_cast<double>(ac->lengthSamples));
    return std::max(0.0, endBeat - ac->startBeat);
}

double clipEndBeat(const Clip& c, const TempoMap& tm) {
    return clipStartBeat(c) + clipLengthBeats(c, tm);
}

double trackEndBeat(const Track& t, const TempoMap& tm) {
    double end = 0.0;
    for (const Clip& c : t.clips)
        end = std::max(end, clipEndBeat(c, tm));
    return end;
}

std::vector<std::pair<uint64_t, bool>> computeEffectiveMutes(const Model& m) {
    // Solo-in-place audibility has ONE canonical implementation — computeSoloAudibleSet /
    // soloAudible (core/Mixer.cpp) — which AudioGraph::buildPlan already uses to bake
    // TrackNode::Config::muted. This function feeds the ParamMsg fast path, so it MUST agree
    // with buildPlan exactly. It used to hand-roll a second closure that diverged: it missed
    // folder-root expansion, master solo, and (the user-visible bug) the rule that a soloed
    // BUS keeps the tracks feeding it audible — so soloing a bus implicit-muted everything
    // upstream and the bus received silence.
    const Project& p = m.project;
    const SoloState solo = computeSoloAudibleSet(p);

    std::vector<std::pair<uint64_t, bool>> out;
    out.reserve(p.tracks.size() + 1);
    for (const Track& t : p.tracks)
        out.emplace_back(t.id, t.mute || !soloAudible(solo, t.id));
    out.emplace_back(p.masterTrack.id, p.masterTrack.mute); // master is never implicit-muted
    return out;
}

namespace {
void scanTrackIds(const Track& t, uint64_t& maxId) {
    maxId = std::max(maxId, t.id);
    maxId = std::max(maxId, t.frozenAssetId);
    for (const PluginInstance& pi : t.inserts)
        maxId = std::max(maxId, pi.instanceId);
    for (const AutomationLane& l : t.automation)
        for (const AutomationPoint& pt : l.points)
            maxId = std::max(maxId, pt.id);
    for (const Clip& c : t.clips) {
        maxId = std::max(maxId, clipId(c));
        if (const MidiClip* mc = asMidi(&c)) {
            for (const Note& n : mc->notes)
                maxId = std::max(maxId, n.id);
            for (const MidiCc& cc : mc->cc)
                maxId = std::max(maxId, cc.id);
        }
    }
}
} // namespace

uint64_t maxIdInProject(const Project& p) {
    uint64_t maxId = 0;
    for (const Track& t : p.tracks)
        scanTrackIds(t, maxId);
    scanTrackIds(p.masterTrack, maxId);
    for (const Marker& mk : p.markers)
        maxId = std::max(maxId, mk.id);
    for (const Asset& a : p.assets)
        maxId = std::max(maxId, a.id);
    return maxId;
}

} // namespace mydaw
