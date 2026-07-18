// MyDAW — core/Mixer.cpp (E2)
// Pan laws + solo-in-place audible-set computation (see Mixer.h for the contracts).

#include "core/Mixer.h"

#include <algorithm>
#include <cmath>

#include "project/Model.h"

namespace mydaw {

namespace {
constexpr double kHalfPi = 1.5707963267948966192313216916398;

// -4.5 dB compromise taper for t in [0,1]: sqrt(linear * constant-power).
inline double taper(double linear, double constPower) {
    const double v = linear * constPower;
    return v > 0.0 ? std::sqrt(v) : 0.0;
}
} // namespace

PanGains monoPanGains(float pan) {
    const double p = std::clamp(static_cast<double>(pan), -1.0, 1.0);
    const double x = (p + 1.0) * 0.5; // 0 = hard left, 1 = hard right
    PanGains g;
    g.l = static_cast<float>(taper(1.0 - x, std::cos(x * kHalfPi)));
    g.r = static_cast<float>(taper(x, std::sin(x * kHalfPi)));
    return g;
}

PanGains stereoBalanceGains(float pan) {
    const double p = std::clamp(static_cast<double>(pan), -1.0, 1.0);
    PanGains g;
    if (p > 0.0) {
        // Pan right: taper the LEFT channel along the same compromise curve,
        // normalized so t=0 -> 1 (sqrt((1-t) * cos(t*pi/2)) starts at 1).
        g.l = static_cast<float>(taper(1.0 - p, std::cos(p * kHalfPi)));
        g.r = 1.0f;
    } else if (p < 0.0) {
        const double t = -p;
        g.l = 1.0f;
        g.r = static_cast<float>(taper(1.0 - t, std::cos(t * kHalfPi)));
    }
    return g;
}

// ---------------------------------------------------------------------------
// Solo-in-place
// ---------------------------------------------------------------------------

namespace {

const Track* findTrack(const Project& p, uint64_t id) {
    if (id == 0)
        return nullptr;
    if (p.masterTrack.id == id)
        return &p.masterTrack;
    for (const Track& t : p.tracks)
        if (t.id == id)
            return &t;
    return nullptr;
}

bool contains(const std::vector<uint64_t>& v, uint64_t id) {
    return std::find(v.begin(), v.end(), id) != v.end();
}

void addUnique(std::vector<uint64_t>& v, uint64_t id) {
    if (!contains(v, id))
        v.push_back(id);
}

// Folder roots expand to all (transitive) non-folder descendants.
void expandRoot(const Project& p, uint64_t id, std::vector<uint64_t>& out, int depth = 0) {
    if (depth > 32)
        return;
    const Track* t = findTrack(p, id);
    if (!t)
        return;
    if (t->kind != TrackKind::Folder) {
        addUnique(out, id);
        return;
    }
    for (const Track& c : p.tracks)
        if (c.parentId == id)
            expandRoot(p, c.id, out, depth + 1);
}

// True when `from`'s outputTarget chain passes through `busId`.
bool feedsBusViaOutput(const Project& p, const Track& from, uint64_t busId) {
    const Track* cur = &from;
    for (int hops = 0; hops < 64; ++hops) {
        if (!cur->outputTarget.isTrack())
            return false;
        const uint64_t next = cur->outputTarget.trackId;
        if (next == busId)
            return true;
        cur = findTrack(p, next);
        if (!cur)
            return false;
    }
    return false;
}

} // namespace

SoloState computeSoloClosure(const Project& p, const std::vector<uint64_t>& soloRoots) {
    SoloState st;
    if (soloRoots.empty())
        return st;
    st.anySolo = true;

    std::vector<uint64_t> roots;
    for (uint64_t id : soloRoots)
        expandRoot(p, id, roots);

    std::vector<uint64_t> set = roots;

    // Soloed buses pull in everything upstream that feeds them via outputTarget.
    // Soloed Instrument tracks pull in their MIDI feeders (Track::midiTarget) — without
    // the feeders' events the soloed instrument would be silent.
    for (uint64_t r : roots) {
        const Track* t = findTrack(p, r);
        if (!t)
            continue;
        if (t->kind == TrackKind::Bus) {
            for (const Track& cand : p.tracks)
                if (cand.id != r && feedsBusViaOutput(p, cand, r))
                    addUnique(set, cand.id);
        } else if (t->kind == TrackKind::Instrument) {
            for (const Track& cand : p.tracks)
                if (cand.kind == TrackKind::Midi && cand.midiTarget == r)
                    addUnique(set, cand.id);
        }
    }

    // Downstream closure: outputTarget chain + enabled send destinations, transitively.
    std::vector<uint64_t> work = set;
    while (!work.empty()) {
        const uint64_t id = work.back();
        work.pop_back();
        const Track* t = findTrack(p, id);
        if (!t)
            continue;
        if (t->outputTarget.isTrack()) {
            const uint64_t d = t->outputTarget.trackId;
            if (!contains(set, d)) {
                set.push_back(d);
                work.push_back(d);
            }
        }
        // A MIDI feeder sounds through its TARGET instrument track: soloing a feeder
        // keeps the instrument (and the instrument's downstream chain) audible.
        if (t->kind == TrackKind::Midi && t->midiTarget != 0 &&
            !contains(set, t->midiTarget)) {
            set.push_back(t->midiTarget);
            work.push_back(t->midiTarget);
        }
        for (const Send& s : t->sends) {
            if (!s.enabled || s.destTrackId == 0)
                continue;
            if (!contains(set, s.destTrackId)) {
                set.push_back(s.destTrackId);
                work.push_back(s.destTrackId);
            }
        }
    }

    addUnique(set, p.masterTrack.id); // master always audible

    std::sort(set.begin(), set.end());
    set.erase(std::unique(set.begin(), set.end()), set.end());
    st.audible = std::move(set);
    return st;
}

SoloState computeSoloAudibleSet(const Project& p) {
    std::vector<uint64_t> roots;
    for (const Track& t : p.tracks)
        if (t.solo)
            roots.push_back(t.id);
    if (p.masterTrack.solo)
        roots.push_back(p.masterTrack.id);
    if (roots.empty())
        return SoloState{};
    return computeSoloClosure(p, roots);
}

bool soloAudible(const SoloState& s, uint64_t trackId) {
    if (!s.anySolo)
        return true;
    return std::binary_search(s.audible.begin(), s.audible.end(), trackId);
}

} // namespace mydaw
