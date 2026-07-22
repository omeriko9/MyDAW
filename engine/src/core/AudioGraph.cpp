// MyDAW — core/AudioGraph.cpp (E2)
// RenderPlan construction + the RT render loop. See AudioGraph.h for the contracts.

#include "core/AudioGraph.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <map>
#include <set>
#include <vector>

#if defined(_MSC_VER) || defined(__SSE2__)
#include <xmmintrin.h> // _mm_getcsr/_mm_setcsr (FTZ/DAZ)
#define MYDAW_HAVE_SSE_CSR 1
#endif

#include "core/AutomationEval.h"
#include "core/Meters.h"
#include "core/Metronome.h"
#include "core/Mixer.h"
#include "core/Pdc.h"
#include "core/TempoMap.h"
#include "core/TrackNode.h"
#include "core/Transport.h"
#include "media/AssetStore.h"
#include "media/AudioRecorder.h"
#include "core/IInsertNode.h"
#include "core/effects/BuiltinEffectManager.h"
#include "midi/MidiInput.h"
#include "plugins/HostProcess.h"
#include "plugins/PluginProxyNode.h"
#include "project/Model.h"
#include "util/Log.h"

namespace mydaw {

namespace {
constexpr int kMaxSends = 16;    // per-track send taps the RT pass binds
constexpr int kMaxCapture = 32;  // capture channels forwarded to nodes/recorder
constexpr float kClipGuard = 4.0f;

inline void enableFtzDaz() {
#if defined(MYDAW_HAVE_SSE_CSR)
    _mm_setcsr(_mm_getcsr() | 0x8040); // FTZ (0x8000) | DAZ (0x0040)
#endif
}

// Bake a model TrackEq into the RT coefficient cascade (control thread). Bypassed or
// band-less => count 0 (a true no-op). Disabled bands occupy a passthrough slot so the
// active band order matches the model (transient updates can re-enable them in place).
EqBandSet makeEqBandSet(const TrackEq& eq, int sampleRate) {
    EqBandSet set;
    if (eq.bypass || eq.bands.empty())
        return set; // count == 0
    const int n = std::min<int>(static_cast<int>(eq.bands.size()), kMaxEqBands);
    for (int i = 0; i < n; ++i) {
        const EqBand& b = eq.bands[static_cast<size_t>(i)];
        set.coeffs[i] =
            computeEqCoeffs(b.enabled, b.type, b.freqHz, b.gainDb, b.q, sampleRate);
    }
    set.count = n;
    return set;
}

// Binary-search a sorted (id -> T*) lookup table. Used by the RT param dispatch and by
// buildPlan (control thread) to find a track's predecessor node in the old plan.
template <typename T>
T* lookupById(const std::vector<std::pair<uint64_t, T*>>& v, uint64_t id) noexcept {
    size_t lo = 0, hi = v.size();
    while (lo < hi) {
        const size_t mid = (lo + hi) / 2;
        if (v[mid].first < id)
            lo = mid + 1;
        else
            hi = mid;
    }
    return (lo < v.size() && v[lo].first == id) ? v[lo].second : nullptr;
}
} // namespace

// ---------------------------------------------------------------------------
// GraphPlan — RenderPlan + everything the RT pass needs (buffer pool, tempo map
// snapshot, typed node pointers, param-dispatch lookups). Immutable once published.
// ---------------------------------------------------------------------------
struct GraphPlan {
    uint64_t gen = 0;
    RenderPlan base;
    TempoMap tempoMap;

    std::vector<float> storage;   // numBuffers * 2 * maxBlock
    std::vector<float*> chan;     // numBuffers * 2 channel pointers into storage

    std::vector<std::shared_ptr<TrackNode>> nodes; // ownership (base.entries alias these)
    std::vector<TrackNode*> typed;                 // parallel to base.entries

    std::vector<std::pair<uint64_t, TrackNode*>> trackLookup;          // sorted by id
    std::vector<std::pair<uint64_t, IInsertNode*>> pluginLookup;       // sorted by id
    std::vector<IInsertNode*> plugins;                                 // unique
};

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------
struct AudioGraph::Impl {
    // configure()
    int sampleRate = 0;
    int maxBlock = 0;
    Meters* meters = nullptr;
    AssetStore* assets = nullptr;
    HostProcessManager* host = nullptr;
    BuiltinEffectManager* builtin = nullptr;
    MidiInput* midiIn = nullptr;
    Metronome* metronome = nullptr;

    // Live-MIDI thru targets (the UI's track selection; setMidiThruTracks). Main
    // thread only: written by the setter, read by buildPlan.
    std::set<uint64_t> midiThru;

    // midi/preview injection: main thread (single producer) -> RT consumer.
    struct LiveInject {
        uint64_t trackId = 0;
        MidiEvent ev;
    };

    // Transient EQ coefficient delivery: main thread (single producer) -> RT consumer.
    struct EqMsg {
        uint64_t trackId = 0;
        EqBandSet set;
    };

    // main thread <-> RT
    ParamRing ring{4096};
    RtRing<LiveInject> injectRing{256};
    RtRing<EqMsg> eqRing{256};
    std::atomic<std::shared_ptr<const GraphPlan>> plan{};
    std::atomic<uint64_t> rtGenSeen{0};
    std::atomic<int> totalLatency{0};
    std::atomic<bool> panic{false};
    std::atomic<AudioRecorder*> recorder{nullptr};

    // main thread only
    uint64_t nextGen = 1;
    struct Retired {
        uint64_t gen = 0;
        std::chrono::steady_clock::time_point at{};
        std::shared_ptr<const GraphPlan> plan;
    };
    std::vector<Retired> graveyard;
    std::vector<uint64_t> meterIds;

    // RT scratch (single RT consumer; offline render uses none of these)
    MidiBuffer liveMidi;
    const float* liveScratch[kMaxCapture] = {};
    const float* capScratch[kMaxCapture] = {};

    std::shared_ptr<GraphPlan> buildPlan(const Model& model,
                                         const std::vector<uint64_t>* soloRoots,
                                         bool offline, int blockSize);
    void publish(std::shared_ptr<GraphPlan> p);
    void collectGraveyard();
    void dispatchParam(const GraphPlan& P, const ParamMsg& m) noexcept;
    void runPass(const GraphPlan& P, ProcessContext& ctx, const float* const* liveInBase,
                 int numLiveIn, int sampleOffset, const MidiBuffer* liveMidiPtr,
                 float* const* out, int numOut) noexcept;
};

// ---------------------------------------------------------------------------
// Plan building (main thread / offline caller thread)
// ---------------------------------------------------------------------------

std::shared_ptr<GraphPlan> AudioGraph::Impl::buildPlan(
    const Model& model, const std::vector<uint64_t>* soloRoots, bool offline,
    int blockSize) {
    const Project& p = model.project;
    auto plan = std::make_shared<GraphPlan>();

    plan->tempoMap.setSampleRate(static_cast<double>(sampleRate));
    plan->tempoMap.setMap(p.tempoMap, p.timeSigMap);
    const TempoMap& map = plan->tempoMap;

    const SoloState solo =
        soloRoots ? computeSoloClosure(p, *soloRoots) : computeSoloAudibleSet(p);

    // --- buffer assignment: one stereo accumulation buffer per bus + master -------
    std::map<uint64_t, int> busBuf;
    std::vector<const Track*> buses;
    for (const Track& t : p.tracks) {
        if (t.kind == TrackKind::Bus) {
            busBuf[t.id] = static_cast<int>(buses.size());
            buses.push_back(&t);
        }
    }
    const int masterBuf = static_cast<int>(buses.size());
    plan->base.numBuffers = masterBuf + 1;
    plan->base.masterBufferIndex = masterBuf;
    plan->base.maxBlock = blockSize;
    plan->base.sampleRate = sampleRate;

    // --- topological order of buses (edges: A feeds B via outputTarget/sends) -----
    const size_t nb = buses.size();
    std::vector<int> indeg(nb, 0);
    std::vector<std::vector<int>> adj(nb);
    auto busIdx = [&](uint64_t id) -> int {
        const auto it = busBuf.find(id);
        return it == busBuf.end() ? -1 : it->second;
    };
    for (size_t a = 0; a < nb; ++a) {
        const Track& t = *buses[a];
        auto addEdge = [&](uint64_t destId) {
            const int b = busIdx(destId);
            if (b >= 0 && b != static_cast<int>(a)) {
                adj[a].push_back(b);
                ++indeg[static_cast<size_t>(b)];
            }
        };
        if (t.outputTarget.isTrack())
            addEdge(t.outputTarget.trackId);
        for (const Send& s : t.sends)
            if (s.enabled && s.destTrackId != 0)
                addEdge(s.destTrackId);
    }
    std::vector<int> topo;
    topo.reserve(nb);
    std::vector<int> queue;
    for (size_t i = 0; i < nb; ++i)
        if (indeg[i] == 0)
            queue.push_back(static_cast<int>(i));
    while (!queue.empty()) {
        const int a = queue.back();
        queue.pop_back();
        topo.push_back(a);
        for (const int b : adj[static_cast<size_t>(a)])
            if (--indeg[static_cast<size_t>(b)] == 0)
                queue.push_back(b);
    }
    std::vector<bool> inCycle(nb, false);
    if (topo.size() < nb) {
        // SPEC §7 (loaded-project safety net): cycle members get routed to master + log.
        std::vector<bool> placed(nb, false);
        for (const int a : topo)
            placed[static_cast<size_t>(a)] = true;
        for (size_t i = 0; i < nb; ++i) {
            if (!placed[i]) {
                inCycle[i] = true;
                topo.push_back(static_cast<int>(i));
                Log::warn("graph: routing cycle through bus '%s' (id %llu) — routed to master",
                          buses[i]->name.c_str(),
                          static_cast<unsigned long long>(buses[i]->id));
            }
        }
    }

    // --- MIDI feeder routing (Track::midiTarget, SPEC §5.2) -------------------------
    // A Midi track with a live midiTarget becomes a FEEDER: its node delivers this
    // block's MIDI into the target instrument node's merge buffer and contributes no
    // audio. A target is live when it exists and is Instrument-kind; anything else
    // degrades to "unrouted" (the track plays through its own inserts) with a warning.
    std::map<uint64_t, uint64_t> feedTarget; // feeder track id -> instrument track id
    for (const Track& t : p.tracks) {
        if (t.kind != TrackKind::Midi || t.midiTarget == 0)
            continue;
        const Track* tgt = nullptr;
        for (const Track& x : p.tracks)
            if (x.id == t.midiTarget) {
                tgt = &x;
                break;
            }
        if (tgt && tgt->kind == TrackKind::Instrument)
            feedTarget[t.id] = tgt->id;
        else
            Log::warn("graph: track '%s' midiTarget %llu is not a live instrument "
                      "track — playing unrouted",
                      t.name.c_str(), static_cast<unsigned long long>(t.midiTarget));
    }

    // --- flattened render order: clip tracks -> buses (topo) -> master -------------
    // Feeders must process BEFORE their target instrument node. The RT pass (runPass)
    // executes entries strictly sequentially, and only Midi tracks feed while only
    // Instrument tracks are fed (no chains/cycles by construction), so emitting all
    // feeders first is a valid topological extension of the bus ordering. Clip-track
    // relative order is otherwise irrelevant: they only accumulate into bus/master
    // buffers, which are all processed later.
    std::vector<const Track*> ordered;
    for (const Track& t : p.tracks)
        if (t.canHoldClips() && feedTarget.count(t.id))
            ordered.push_back(&t);
    for (const Track& t : p.tracks)
        if (t.canHoldClips() && !feedTarget.count(t.id))
            ordered.push_back(&t);
    for (const int a : topo)
        ordered.push_back(buses[static_cast<size_t>(a)]);
    ordered.push_back(&p.masterTrack);

    std::map<uint64_t, int> posOf;
    for (size_t i = 0; i < ordered.size(); ++i)
        posOf[ordered[i]->id] = static_cast<int>(i);

    // --- per-track configs + entries (nodes constructed after PDC) -----------------
    const size_t count = ordered.size();
    std::vector<TrackNode::Config> cfgs(count);
    plan->base.entries.resize(count);

    // Sidechain wiring, resolved to node pointers after all nodes are constructed
    // (destIdx = the track whose insert reads the sidechain; insertK = insert index;
    // srcTrackId = the source track supplying the detector signal). Mirrors feeder wiring.
    struct ScWire { size_t destIdx; size_t insertK; uint64_t srcTrackId; };
    std::vector<ScWire> scWiring;

    for (size_t idx = 0; idx < count; ++idx) {
        const Track& t = *ordered[idx];
        const bool isMaster = t.kind == TrackKind::Master;
        const bool busLike = t.isBusLike();
        TrackNode::Config& cfg = cfgs[idx];
        RenderEntry& entry = plan->base.entries[idx];

        cfg.trackId = t.id;
        cfg.busLike = busLike;
        cfg.trackChannels = t.channels;
        cfg.volume = static_cast<float>(t.volume);
        cfg.vcaGain = static_cast<float>(model.vcaGainFor(t.vcaId)); // VCA-group multiplier
        cfg.pan = static_cast<float>(t.pan);
        cfg.muted = t.mute || !soloAudible(solo, t.id);

        // ---- clip sources (audio + baked MIDI) ----------------------------------
        const bool frozen = !busLike && t.frozen && t.frozenAssetId != 0;
        if (!busLike) {
            if (frozen) {
                // Frozen: play the rendered asset from beat 0, inserts skipped.
                const PcmData* pcm = assets ? assets->pcm(t.frozenAssetId) : nullptr;
                if (pcm) {
                    TrackNode::ResolvedAudioClip rc;
                    rc.pcm = pcm;
                    rc.startSample = 0;
                    rc.srcOffsetSamples = 0;
                    rc.lengthSamples = pcm->frames;
                    rc.gain = 1.0f;
                    cfg.audioClips.push_back(rc);
                } else {
                    Log::warn("graph: frozen asset %llu of track '%s' not loaded yet",
                              static_cast<unsigned long long>(t.frozenAssetId),
                              t.name.c_str());
                }
            } else {
                for (const Clip& c : t.clips) {
                    if (const AudioClip* a = asAudio(&c)) {
                        if (a->muted || a->assetId == 0 || a->lengthSamples <= 0)
                            continue;
                        const PcmData* pcm = assets ? assets->pcm(a->assetId) : nullptr;
                        if (!pcm)
                            continue; // still loading/missing; rebuild fires again (E9)
                        TrackNode::ResolvedAudioClip rc;
                        rc.pcm = pcm;
                        rc.startSample = map.beatsToSamples(a->startBeat);
                        rc.srcOffsetSamples = a->srcOffsetSamples;
                        rc.lengthSamples = a->lengthSamples;
                        rc.gain = static_cast<float>(a->gain);
                        rc.fadeInSamples =
                            static_cast<int64_t>(a->fadeInSec * sampleRate + 0.5);
                        rc.fadeOutSamples =
                            static_cast<int64_t>(a->fadeOutSec * sampleRate + 0.5);
                        cfg.audioClips.push_back(rc);
                    } else if (const MidiClip* mc = asMidi(&c)) {
                        if (mc->muted)
                            continue;
                        const double clipEnd = mc->startBeat + mc->lengthBeats;
                        for (const Note& note : mc->notes) {
                            if (note.startBeat < 0.0 || note.startBeat >= mc->lengthBeats)
                                continue;
                            const double onB = mc->startBeat + note.startBeat;
                            const double offB =
                                std::min(onB + note.lengthBeats, clipEnd);
                            if (offB <= onB)
                                continue;
                            const int64_t on = map.beatsToSamples(onB);
                            int64_t off = map.beatsToSamples(offB);
                            if (off <= on)
                                off = on + 1;
                            TrackNode::NoteEvent ev;
                            ev.pitch = static_cast<uint8_t>(std::clamp(note.pitch, 0, 127));
                            ev.channel =
                                static_cast<uint8_t>(std::clamp(note.channel, 0, 15));
                            ev.sample = on;
                            ev.on = 1;
                            ev.velocity =
                                static_cast<uint8_t>(std::clamp(note.velocity, 1, 127));
                            cfg.noteEvents.push_back(ev);
                            ev.sample = off;
                            ev.on = 0;
                            ev.velocity = 0;
                            cfg.noteEvents.push_back(ev);
                        }
                        // CC / pitch bend / channel aftertouch points, pre-formed as
                        // wire bytes (channel 0). Points outside the clip are skipped.
                        for (const MidiCc& pt : mc->cc) {
                            if (pt.controller < 0 || pt.controller > 129)
                                continue;
                            if (pt.beat < 0.0 || pt.beat >= mc->lengthBeats)
                                continue;
                            const double v = std::clamp(pt.value, 0.0, 1.0);
                            TrackNode::CcEvent ce;
                            ce.sample = map.beatsToSamples(mc->startBeat + pt.beat);
                            ce.controller = static_cast<uint8_t>(pt.controller);
                            if (pt.controller == 128) { // pitch bend (0.5 = center)
                                const int raw =
                                    static_cast<int>(std::lround(v * 16383.0));
                                ce.data[0] = 0xE0;
                                ce.data[1] = static_cast<uint8_t>(raw & 0x7F);
                                ce.data[2] = static_cast<uint8_t>((raw >> 7) & 0x7F);
                            } else if (pt.controller == 129) { // channel aftertouch
                                ce.data[0] = 0xD0;
                                ce.data[1] = static_cast<uint8_t>(
                                    std::lround(v * 127.0));
                                ce.size = 2;
                            } else {
                                ce.data[0] = 0xB0;
                                ce.data[1] = static_cast<uint8_t>(pt.controller);
                                ce.data[2] = static_cast<uint8_t>(
                                    std::lround(v * 127.0));
                            }
                            cfg.ccEvents.push_back(ce);
                        }
                    }
                }

                // ---- take folders / comping -----------------------------------------
                // For each comp segment [segStart, segEnd) play ONLY the selected lane's
                // material, windowed to the segment (sample-accurate for audio; a MIDI note
                // plays if its onset falls in the segment, clamped to the segment end). Lane
                // -1 (or out-of-range) is a silent gap.
                for (const TakeFolder& folder : t.takeFolders) {
                    if (folder.lanes.empty() || folder.endBeat <= folder.startBeat)
                        continue;
                    // Segment boundaries: comp startBeats (clamped into the span) + folder end.
                    struct Seg { double s, e; int lane; };
                    std::vector<Seg> segs;
                    if (folder.comp.empty()) {
                        segs.push_back({folder.startBeat, folder.endBeat, 0});
                    } else {
                        for (size_t si = 0; si < folder.comp.size(); ++si) {
                            double s = si == 0 ? folder.startBeat
                                               : std::max(folder.comp[si].startBeat, folder.startBeat);
                            double e = si + 1 < folder.comp.size()
                                           ? std::max(folder.comp[si + 1].startBeat, s)
                                           : folder.endBeat;
                            e = std::min(e, folder.endBeat);
                            if (e > s)
                                segs.push_back({s, e, folder.comp[si].lane});
                        }
                    }
                    for (const Seg& sg : segs) {
                        if (sg.lane < 0 || sg.lane >= static_cast<int>(folder.lanes.size()))
                            continue; // silent gap
                        const int64_t winS = map.beatsToSamples(sg.s);
                        const int64_t winE = map.beatsToSamples(sg.e);
                        for (const Clip& c : folder.lanes[static_cast<size_t>(sg.lane)].clips) {
                            if (const AudioClip* a = asAudio(&c)) {
                                if (a->muted || a->assetId == 0 || a->lengthSamples <= 0)
                                    continue;
                                const PcmData* pcm = assets ? assets->pcm(a->assetId) : nullptr;
                                if (!pcm)
                                    continue;
                                const int64_t cs = map.beatsToSamples(a->startBeat);
                                const int64_t ce = cs + a->lengthSamples;
                                const int64_t ns = std::max(cs, winS);
                                const int64_t ne = std::min(ce, winE);
                                if (ne <= ns)
                                    continue; // clip outside this segment
                                TrackNode::ResolvedAudioClip rc;
                                rc.pcm = pcm;
                                rc.startSample = ns;
                                rc.srcOffsetSamples = a->srcOffsetSamples + (ns - cs);
                                rc.lengthSamples = ne - ns;
                                rc.gain = static_cast<float>(a->gain);
                                // Fades anchor to the clip edges; keep them only when the window
                                // doesn't trim that edge (avoids a mis-placed fade mid-segment).
                                rc.fadeInSamples = ns == cs
                                    ? static_cast<int64_t>(a->fadeInSec * sampleRate + 0.5) : 0;
                                rc.fadeOutSamples = ne == ce
                                    ? static_cast<int64_t>(a->fadeOutSec * sampleRate + 0.5) : 0;
                                cfg.audioClips.push_back(rc);
                            } else if (const MidiClip* mc = asMidi(&c)) {
                                if (mc->muted)
                                    continue;
                                const double clipEnd = mc->startBeat + mc->lengthBeats;
                                for (const Note& note : mc->notes) {
                                    if (note.startBeat < 0.0 || note.startBeat >= mc->lengthBeats)
                                        continue;
                                    const double onB = mc->startBeat + note.startBeat;
                                    if (onB < sg.s || onB >= sg.e)
                                        continue; // note belongs to the segment of its onset
                                    const double offB =
                                        std::min({onB + note.lengthBeats, clipEnd, sg.e});
                                    if (offB <= onB)
                                        continue;
                                    const int64_t on = map.beatsToSamples(onB);
                                    int64_t off = map.beatsToSamples(offB);
                                    if (off <= on)
                                        off = on + 1;
                                    TrackNode::NoteEvent ev;
                                    ev.pitch = static_cast<uint8_t>(std::clamp(note.pitch, 0, 127));
                                    ev.channel =
                                        static_cast<uint8_t>(std::clamp(note.channel, 0, 15));
                                    ev.sample = on;
                                    ev.on = 1;
                                    ev.velocity =
                                        static_cast<uint8_t>(std::clamp(note.velocity, 1, 127));
                                    cfg.noteEvents.push_back(ev);
                                    ev.sample = off;
                                    ev.on = 0;
                                    ev.velocity = 0;
                                    cfg.noteEvents.push_back(ev);
                                }
                            }
                        }
                    }
                }

                std::sort(cfg.noteEvents.begin(), cfg.noteEvents.end(),
                          [](const TrackNode::NoteEvent& a, const TrackNode::NoteEvent& b) {
                              if (a.sample != b.sample)
                                  return a.sample < b.sample;
                              return a.on < b.on; // offs before ons at equal sample
                          });
                std::stable_sort(cfg.ccEvents.begin(), cfg.ccEvents.end(),
                                 [](const TrackNode::CcEvent& a,
                                    const TrackNode::CcEvent& b) {
                                     return a.sample < b.sample;
                                 });
            }
        }

        // ---- insert chain (skipped on frozen tracks AND on feeders: a feeder's MIDI
        // goes to its target's chain and it contributes no audio, so its own inserts
        // are not processed — they stay dormant-by-routing and report no latency) ----
        const bool isFeeder = feedTarget.count(t.id) != 0;
        if (!frozen && !isFeeder) {
            bool trackHasSc = false;
            for (const PluginInstance& pi : t.inserts) {
                IInsertNode* node = host ? host->node(pi.instanceId) : nullptr;
                if (!node && builtin) {
                    node = builtin->node(pi.instanceId); // in-engine stock effect
                    // A fresh plan (rebuild / offline render) is built without draining the RT
                    // param ring, so sync the in-engine node from the model — its params/
                    // bypass/wetDry are the source of truth (mirrors how EQ bakes t.eq).
                    if (node) {
                        for (const auto& [pid, val] : pi.paramValues)
                            node->setParamRt(pid, static_cast<float>(val));
                        node->setBypass(pi.bypass);
                        node->setWetDry(static_cast<float>(pi.wetDry));
                        if (pi.sampleAssetId) // sampler: (re)bind PCM once the asset is loaded
                            builtin->bindSample(pi.instanceId, pi.sampleAssetId);
                    }
                }
                if (!node)
                    continue;
                cfg.inserts.push_back(node);
                cfg.chainLatency += node->latencySamples();
                plan->pluginLookup.emplace_back(pi.instanceId, node);
                plan->plugins.push_back(node);
                // Sidechain: record the (dest insert -> source track) wire; resolve to a
                // node pointer once every node exists (a source track may not be built yet).
                if (pi.sidechainSource != 0) {
                    scWiring.push_back({idx, cfg.inserts.size() - 1, pi.sidechainSource});
                    trackHasSc = true;
                }
            }
            if (trackHasSc)
                cfg.insertSidechain.assign(cfg.inserts.size(), nullptr);
        }

        // ---- channel EQ (post-inserts, pre-fader) ----------------------------------
        // Coefficients are computed on this (control) thread and baked into the plan;
        // empty/bypassed => count 0 (a true RT no-op).
        cfg.eq = makeEqBandSet(t.eq, sampleRate);

        // ---- automation lanes ------------------------------------------------------
        std::map<int, std::vector<AutomationPoint>> sendAuto;
        for (const AutomationLane& lane : t.automation) {
            if (lane.points.empty())
                continue;
            const ParamRef ref = parseParamRef(lane.paramRef);
            std::vector<AutomationPoint> pts = lane.points;
            std::sort(pts.begin(), pts.end(),
                      [](const AutomationPoint& a, const AutomationPoint& b) {
                          return a.beat < b.beat;
                      });
            switch (ref.kind) {
                case ParamRef::Kind::Volume:
                    cfg.volumeAuto = std::move(pts);
                    break;
                case ParamRef::Kind::Pan:
                    cfg.panAuto = std::move(pts);
                    break;
                case ParamRef::Kind::Send:
                    sendAuto[ref.sendIndex] = std::move(pts);
                    break;
                case ParamRef::Kind::Plugin: {
                    if (frozen)
                        break;
                    IInsertNode* node = host ? host->node(ref.instanceId) : nullptr;
                    if (!node && builtin)
                        node = builtin->node(ref.instanceId);
                    if (node &&
                        std::find(cfg.inserts.begin(), cfg.inserts.end(), node) !=
                            cfg.inserts.end()) {
                        TrackNode::PluginAutoLane pl;
                        pl.node = node;
                        pl.paramId = ref.paramId;
                        pl.points = std::move(pts);
                        cfg.pluginAuto.push_back(std::move(pl));
                    }
                    break;
                }
                case ParamRef::Kind::Invalid:
                    break;
            }
        }

        // ---- routing ----------------------------------------------------------------
        entry.trackId = t.id;
        entry.inputBufferIndex = busLike ? (isMaster ? masterBuf : busBuf[t.id]) : -1;
        if (isMaster) {
            entry.outputBufferIndex = masterBuf; // processes in place
        } else if (t.outputTarget.isNone()) {
            entry.outputBufferIndex = -1;
        } else if (t.outputTarget.isTrack()) {
            const int b = busIdx(t.outputTarget.trackId);
            const auto posIt = posOf.find(t.outputTarget.trackId);
            const bool forward =
                b >= 0 && posIt != posOf.end() && posIt->second > static_cast<int>(idx);
            if (forward) {
                entry.outputBufferIndex = b;
            } else {
                entry.outputBufferIndex = masterBuf;
                if (b >= 0) // cycle remnant — already logged above for buses
                    Log::warn("graph: track '%s' output rerouted to master", t.name.c_str());
            }
        } else {
            entry.outputBufferIndex = masterBuf;
        }

        // ---- sends -------------------------------------------------------------------
        for (size_t sIdx = 0; sIdx < t.sends.size(); ++sIdx) {
            const Send& s = t.sends[sIdx];
            if (!s.enabled || s.destTrackId == 0)
                continue;
            const int b = busIdx(s.destTrackId);
            if (b < 0)
                continue;
            const auto posIt = posOf.find(s.destTrackId);
            if (posIt == posOf.end() || posIt->second <= static_cast<int>(idx)) {
                Log::warn("graph: dropping feedback send %d of track '%s'",
                          static_cast<int>(sIdx), t.name.c_str());
                continue;
            }
            if (static_cast<int>(entry.sends.size()) >= kMaxSends)
                break;
            SendTap tap;
            tap.sendIndex = static_cast<int>(sIdx);
            tap.destBufferIndex = b;
            entry.sends.push_back(tap);

            TrackNode::SendInit si;
            si.modelIndex = static_cast<int>(sIdx);
            si.pre = s.pre;
            si.level = static_cast<float>(s.level);
            const auto autoIt = sendAuto.find(static_cast<int>(sIdx));
            if (autoIt != sendAuto.end())
                si.autoPoints = autoIt->second;
            cfg.sends.push_back(std::move(si));
        }

        // ---- meters / live input -------------------------------------------------------
        cfg.meter = (!offline && meters) ? meters->acquire(t.id) : nullptr;
        if (!offline) {
            if (t.kind == TrackKind::Audio) {
                cfg.liveAudioMonitor = t.monitor;
                // Input monitoring follows the per-track monitor toggle ONLY. Do NOT force
                // it on while recording an armed track — monitor off must mean silence even
                // during a take (otherwise users monitoring through their interface get a
                // doubled/latent signal they explicitly disabled).
                cfg.liveAudioWhenRecording = false;
                cfg.inputChannelOffset = std::max(0, t.inputChannel);
            }
            // Live-MIDI thru follows the UI's track SELECTION (midiThru, spec
            // 2026-07-22) plus the explicit monitor toggle. Arming does NOT imply
            // thru — arming is for recording (multi-selection layers instruments).
            if (t.kind == TrackKind::Midi || t.kind == TrackKind::Instrument)
                cfg.liveMidi = midiThru.count(t.id) > 0 || t.monitor;
        }
    }

    // --- PDC: align every route to master (SPEC §7) ------------------------------------
    std::vector<int> bufferOwner(static_cast<size_t>(plan->base.numBuffers), -1);
    for (size_t idx = 0; idx < count; ++idx)
        if (plan->base.entries[idx].inputBufferIndex >= 0)
            bufferOwner[static_cast<size_t>(plan->base.entries[idx].inputBufferIndex)] =
                static_cast<int>(idx);
    std::vector<PdcNode> pdcNodes(count);
    for (size_t idx = 0; idx < count; ++idx) {
        const RenderEntry& e = plan->base.entries[idx];
        pdcNodes[idx].chainLatency = cfgs[idx].chainLatency;
        const bool isMaster = static_cast<int>(idx) == static_cast<int>(count) - 1;
        pdcNodes[idx].outputIndex =
            (!isMaster && e.outputBufferIndex >= 0)
                ? bufferOwner[static_cast<size_t>(e.outputBufferIndex)]
                : -1;
    }
    const PdcResult pdc = computePdc(pdcNodes, static_cast<int>(count) - 1);
    plan->base.totalLatencySamples = pdc.totalLatency;

    // --- construct + prepare nodes -------------------------------------------------------
    // Carry live EQ filter state forward across the rebuild: snap() (in prepare) zeroes the
    // biquad history, so a structural rebuild during playback would click every track's EQ
    // (and reset ALL tracks' EQ state on ANY structural command). For each new node we look
    // up the SAME trackId's node in the currently-published (old) plan and adopt its filter
    // history. The old plan is still the live RT plan (we have not exchanged yet), so this
    // reads state the RT thread may concurrently write — a benign float race (≤1-sample
    // glitch), far better than a guaranteed click. See EqProcessor::adoptState.
    // `plan` (the local) shadows the Impl member of the same name — reach the live plan
    // through `this`. Offline rebuilds (separate plan, shared plugins) also adopt state.
    // Mark every sidechain SOURCE track before construction so prepare() sizes its capture
    // buffers. posOf maps track id -> ordered index (== cfgs index).
    for (const ScWire& w : scWiring) {
        const auto pit = posOf.find(w.srcTrackId);
        if (pit != posOf.end() && pit->second >= 0 &&
            static_cast<size_t>(pit->second) < count)
            cfgs[static_cast<size_t>(pit->second)].keepSidechain = true;
    }

    std::shared_ptr<const GraphPlan> prevPlan = this->plan.load(std::memory_order_acquire);
    plan->nodes.reserve(count);
    plan->typed.reserve(count);
    for (size_t idx = 0; idx < count; ++idx) {
        cfgs[idx].pdcDelaySamples = pdc.delays[idx];
        auto node = std::make_shared<TrackNode>(std::move(cfgs[idx]));
        node->prepare(sampleRate, blockSize);
        if (prevPlan) {
            if (TrackNode* prev =
                    lookupById(prevPlan->trackLookup, plan->base.entries[idx].trackId)) {
                node->adoptEqState(*prev);
                // Note-ledger continuity: notes sounding across a rebuild (every edit,
                // undo, even a selection change rebuilds) must keep their note-offs —
                // a fresh node with an empty ledger silently drops them, which was THE
                // dominant stuck-note cause.
                node->adoptMidiState(*prev);
            }
        }
        plan->base.entries[idx].node = node;
        plan->typed.push_back(node.get());
        plan->trackLookup.emplace_back(plan->base.entries[idx].trackId, node.get());
        plan->nodes.push_back(std::move(node));
    }

    // --- buffer pool ----------------------------------------------------------------------
    const size_t chanCount = static_cast<size_t>(plan->base.numBuffers) * 2;
    plan->storage.assign(chanCount * static_cast<size_t>(blockSize), 0.0f);
    plan->chan.resize(chanCount);
    for (size_t i = 0; i < chanCount; ++i)
        plan->chan[i] = plan->storage.data() + i * static_cast<size_t>(blockSize);

    // --- lookup tables ----------------------------------------------------------------------
    std::sort(plan->trackLookup.begin(), plan->trackLookup.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });
    std::sort(plan->pluginLookup.begin(), plan->pluginLookup.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });
    plan->pluginLookup.erase(
        std::unique(plan->pluginLookup.begin(), plan->pluginLookup.end()),
        plan->pluginLookup.end());
    std::sort(plan->plugins.begin(), plan->plugins.end());
    plan->plugins.erase(std::unique(plan->plugins.begin(), plan->plugins.end()),
                        plan->plugins.end());

    // --- feeder -> target wiring (midiTarget routing) -----------------------------
    // Control thread, pre-publish: both nodes live in (and are owned by) this plan, so
    // the raw pointer is immutable for the plan's lifetime. Feeders precede their
    // target in plan order (above), so delivery happens within the same RT pass.
    for (size_t idx = 0; idx < count; ++idx) {
        const auto it = feedTarget.find(plan->base.entries[idx].trackId);
        if (it == feedTarget.end())
            continue;
        if (TrackNode* tgt = lookupById(plan->trackLookup, it->second))
            plan->typed[idx]->setMidiSink(tgt);
    }

    // --- sidechain source wiring ---------------------------------------------------
    // Resolve each recorded (dest insert -> source track) wire to the source node pointer.
    // Both nodes are owned by this plan, so the pointer is immutable for the plan's lifetime.
    // A missing/self source silently leaves the insert unsidechained (compressor self-detects).
    for (const ScWire& w : scWiring) {
        if (w.destIdx >= count)
            continue;
        TrackNode* src = lookupById(plan->trackLookup, w.srcTrackId);
        if (src && src != plan->typed[w.destIdx])
            plan->typed[w.destIdx]->setInsertSidechainSource(w.insertK, src);
    }
    return plan;
}

void AudioGraph::Impl::publish(std::shared_ptr<GraphPlan> p) {
    p->gen = nextGen++;
    totalLatency.store(p->base.totalLatencySamples, std::memory_order_release);
    std::shared_ptr<const GraphPlan> immutable = std::move(p);
    std::shared_ptr<const GraphPlan> old = plan.exchange(immutable);
    if (old)
        graveyard.push_back(Retired{old->gen, std::chrono::steady_clock::now(), std::move(old)});
    collectGraveyard();
}

void AudioGraph::Impl::collectGraveyard() {
    const uint64_t seen = rtGenSeen.load(std::memory_order_acquire);
    const auto now = std::chrono::steady_clock::now();
    graveyard.erase(
        std::remove_if(graveyard.begin(), graveyard.end(),
                       [&](const Retired& r) {
                           if (seen > r.gen)
                               return true; // RT observed a newer plan
                           return now - r.at > std::chrono::seconds(2);
                       }),
        graveyard.end());
}

// ---------------------------------------------------------------------------
// RT helpers
// ---------------------------------------------------------------------------

void AudioGraph::Impl::dispatchParam(const GraphPlan& P, const ParamMsg& m) noexcept {
    switch (m.target) {
        case ParamMsg::Target::Volume:
        case ParamMsg::Target::Pan:
        case ParamMsg::Target::SendLevel:
        case ParamMsg::Target::VcaGain:
        case ParamMsg::Target::Mute: {
            TrackNode* tn = lookupById(P.trackLookup, m.trackId);
            if (!tn)
                return;
            if (m.target == ParamMsg::Target::Volume)
                tn->applyVolumeRt(m.value);
            else if (m.target == ParamMsg::Target::Pan)
                tn->applyPanRt(m.value);
            else if (m.target == ParamMsg::Target::SendLevel)
                tn->applySendLevelRt(m.index, m.value);
            else if (m.target == ParamMsg::Target::VcaGain)
                tn->applyVcaGainRt(m.value);
            else
                tn->applyMuteRt(m.value >= 0.5f);
            return;
        }
        case ParamMsg::Target::PluginParam:
        case ParamMsg::Target::PluginBypass:
        case ParamMsg::Target::WetDry: {
            IInsertNode* pn = lookupById(P.pluginLookup, m.instanceId);
            if (!pn)
                return;
            if (m.target == ParamMsg::Target::PluginParam)
                pn->setParamRt(static_cast<uint32_t>(m.index), m.value);
            else if (m.target == ParamMsg::Target::PluginBypass)
                pn->setBypass(m.value >= 0.5f);
            else
                pn->setWetDry(m.value);
            return;
        }
    }
}

void AudioGraph::Impl::runPass(const GraphPlan& P, ProcessContext& ctx,
                               const float* const* liveInBase, int numLiveIn,
                               int sampleOffset, const MidiBuffer* liveMidiPtr,
                               float* const* out, int numOut) noexcept {
    const int n = ctx.frames;
    if (n <= 0 || n > P.base.maxBlock)
        return;

    // Buffer-pool contract (GraphNode.h): the graph zeroes all buffers at pass start.
    for (float* c : P.chan)
        std::memset(c, 0, static_cast<size_t>(n) * sizeof(float));

    // Live capture pointers, advanced to this pass's offset within the device block.
    const float* const* liveIn = nullptr;
    int nLive = 0;
    if (liveInBase && numLiveIn > 0) {
        nLive = std::min(numLiveIn, kMaxCapture);
        for (int c = 0; c < nLive; ++c)
            liveScratch[c] = liveInBase[c] ? liveInBase[c] + sampleOffset : nullptr;
        liveIn = liveScratch;
    }

    float* sendL[kMaxSends];
    float* sendR[kMaxSends];
    for (size_t i = 0; i < P.base.entries.size(); ++i) {
        const RenderEntry& e = P.base.entries[i];
        TrackNode* tn = P.typed[i];

        const float* ins[2];
        int nin = 0;
        if (e.inputBufferIndex >= 0) {
            ins[0] = P.chan[static_cast<size_t>(e.inputBufferIndex) * 2];
            ins[1] = P.chan[static_cast<size_t>(e.inputBufferIndex) * 2 + 1];
            nin = 2;
        }
        float* outs[2];
        int nout = 0;
        if (e.outputBufferIndex >= 0) {
            outs[0] = P.chan[static_cast<size_t>(e.outputBufferIndex) * 2];
            outs[1] = P.chan[static_cast<size_t>(e.outputBufferIndex) * 2 + 1];
            nout = 2;
        }
        const int ns = std::min(static_cast<int>(e.sends.size()), kMaxSends);
        for (int k = 0; k < ns; ++k) {
            const int b = e.sends[static_cast<size_t>(k)].destBufferIndex;
            sendL[k] = P.chan[static_cast<size_t>(b) * 2];
            sendR[k] = P.chan[static_cast<size_t>(b) * 2 + 1];
        }
        tn->processTrackRt(ctx, nin ? ins : nullptr, nin, nout ? outs : nullptr, nout,
                           sendL, sendR, ns, liveIn, nLive, liveMidiPtr);
    }

    // Master buffer -> device output (accumulate; the caller zeroed the device block).
    if (out && numOut >= 1 && out[0]) {
        const float* mL = P.chan[static_cast<size_t>(P.base.masterBufferIndex) * 2];
        const float* mR = P.chan[static_cast<size_t>(P.base.masterBufferIndex) * 2 + 1];
        if (numOut == 1) {
            float* d = out[0] + sampleOffset;
            for (int i = 0; i < n; ++i)
                d[i] += 0.5f * (mL[i] + mR[i]);
        } else {
            float* dL = out[0] + sampleOffset;
            for (int i = 0; i < n; ++i)
                dL[i] += mL[i];
            if (out[1]) {
                float* dR = out[1] + sampleOffset;
                for (int i = 0; i < n; ++i)
                    dR[i] += mR[i];
            }
        }
    }
}

// ---------------------------------------------------------------------------
// AudioGraph public API
// ---------------------------------------------------------------------------

AudioGraph::AudioGraph() : impl_(std::make_unique<Impl>()) {}
AudioGraph::~AudioGraph() = default;

void AudioGraph::configure(int sampleRate, int maxBlock, Meters* meters,
                           AssetStore* assets, HostProcessManager* host,
                           BuiltinEffectManager* builtin, MidiInput* midiInput,
                           Metronome* metronome) {
    Impl& im = *impl_;
    im.sampleRate = sampleRate;
    im.maxBlock = maxBlock;
    im.meters = meters;
    im.assets = assets;
    im.host = host;
    im.builtin = builtin;
    im.midiIn = midiInput;
    im.metronome = metronome;
    if (metronome)
        metronome->prepare(sampleRate);
    // The current plan (if any) was built for the old format — drop it; the caller
    // rebuilds right after configure (E9 prepareGraphFormat).
    std::shared_ptr<const GraphPlan> old = im.plan.exchange(nullptr);
    if (old)
        im.graveyard.push_back(
            Impl::Retired{old->gen, std::chrono::steady_clock::now(), std::move(old)});
    im.collectGraveyard();
}

void AudioGraph::setMidiThruTracks(std::vector<uint64_t> trackIds) {
    impl_->midiThru = std::set<uint64_t>(trackIds.begin(), trackIds.end());
}

void AudioGraph::rebuild(const Model& model) {
    Impl& im = *impl_;
    if (im.sampleRate <= 0 || im.maxBlock <= 0) {
        Log::warn("graph: rebuild ignored — configure() not called yet");
        return;
    }
    std::shared_ptr<GraphPlan> plan = im.buildPlan(model, nullptr, false, im.maxBlock);

    // Release meter slots of tracks that disappeared (acquire happened in buildPlan).
    std::vector<uint64_t> newIds;
    newIds.reserve(plan->base.entries.size());
    for (const RenderEntry& e : plan->base.entries)
        newIds.push_back(e.trackId);
    std::sort(newIds.begin(), newIds.end());
    if (im.meters)
        for (const uint64_t id : im.meterIds)
            if (!std::binary_search(newIds.begin(), newIds.end(), id))
                im.meters->release(id);
    im.meterIds = std::move(newIds);

    im.publish(std::move(plan));
}

void AudioGraph::processBlock(const float* const* in, int numIn, float* const* out,
                              int numOut, int frames, Transport& transport) {
    Impl& im = *impl_;
    enableFtzDaz();

    if (!out || numOut <= 0 || frames <= 0)
        return;
    for (int c = 0; c < numOut; ++c)
        if (out[c])
            std::memset(out[c], 0, static_cast<size_t>(frames) * sizeof(float));

    const std::shared_ptr<const GraphPlan> plan = im.plan.load(std::memory_order_acquire);
    if (!plan)
        return;
    im.rtGenSeen.store(plan->gen, std::memory_order_release);
    const GraphPlan& P = *plan;
    if (P.base.entries.empty())
        return;

    if (im.panic.exchange(false, std::memory_order_acq_rel)) {
        for (TrackNode* tn : P.typed)
            tn->panicRt();
        if (im.metronome)
            im.metronome->resetRt();
    }

    // Param fast path: drained at block start (SPEC §7).
    ParamMsg msg;
    for (int guard = 0; guard < 4096 && im.ring.pop(msg); ++guard)
        im.dispatchParam(P, msg);

    // EQ coefficient fast path (transient drags): swap live cascades in place.
    Impl::EqMsg eqm;
    for (int guard = 0; guard < 256 && im.eqRing.pop(eqm); ++guard)
        if (TrackNode* tn = lookupById(P.trackLookup, eqm.trackId))
            tn->applyEqRt(eqm.set);

    // midi/preview injection: route into the target track's node (merged on its first
    // pass this block, regardless of arm/monitor and of the transport state).
    Impl::LiveInject li;
    for (int guard = 0; guard < 256 && im.injectRing.pop(li); ++guard)
        if (TrackNode* tn = lookupById(P.trackLookup, li.trackId))
            tn->injectMidiRt(li.ev);

    // Live MIDI: drainLive APPENDS — clear first; merged into the FIRST pass only.
    const MidiBuffer* liveMidi = nullptr;
    if (im.midiIn) {
        im.liveMidi.clear();
        im.midiIn->drainLive(im.liveMidi);
        liveMidi = &im.liveMidi;
    }

    AudioRecorder* rec = im.recorder.load(std::memory_order_acquire);
    const TempoMap& map = P.tempoMap;
    const int sr = P.base.sampleRate;

    int done = 0;
    while (done < frames) {
        const int chunk = std::min(frames - done, P.base.maxBlock);
        const int64_t ciBefore = transport.countInRemainingSamples();
        BlockSpan spans[2];
        const int nspans = transport.nextSpans(chunk, spans);
        const int64_t ciAfter = transport.countInRemainingSamples();
        const int ciConsumed = static_cast<int>(std::max<int64_t>(0, ciBefore - ciAfter));

        // Count-in clicks while the playhead is held (SPEC §7).
        if (ciConsumed > 0 && im.metronome) {
            const double anchorBeat = map.samplesToBeats(transport.playheadSamples());
            const double bpm = std::max(1.0, map.bpmAtBeat(anchorBeat));
            const TimeSigEntry sig = map.timeSigAtBeat(anchorBeat);
            const double unitQ = 4.0 / static_cast<double>(sig.den > 0 ? sig.den : 4);
            const double samplesPerClick = (60.0 / bpm) * sr * unitQ;
            const int64_t elapsed = transport.countInTotalSamples() - ciBefore;
            im.metronome->scheduleCountInClicksRt(samplesPerClick,
                                                  sig.num > 0 ? sig.num : 4, elapsed,
                                                  ciConsumed, done);
        }

        const bool recording = transport.isRecording();

        if (nspans == 0) {
            // Stopped or fully inside count-in: idle pass keeps live monitoring, live
            // MIDI playing, plugin tails ringing, meters moving — and chases note-offs.
            ProcessContext ctx;
            ctx.frames = chunk;
            ctx.playheadSamples = transport.playheadSamples();
            ctx.ppqPos = map.samplesToBeats(ctx.playheadSamples);
            ctx.tempo = map.bpmAtBeat(ctx.ppqPos);
            ctx.playing = false;
            ctx.recording = recording;
            ctx.looping = transport.loopEnabled();
            ctx.sampleRate = sr;
            im.runPass(P, ctx, in, numIn, done, liveMidi, out, numOut);
            liveMidi = nullptr;
            done += chunk;
            continue;
        }

        int outOffset = done + ciConsumed;
        for (int s = 0; s < nspans; ++s) {
            ProcessContext ctx;
            ctx.frames = spans[s].frames;
            ctx.playheadSamples = spans[s].startSample;
            ctx.ppqPos = map.samplesToBeats(ctx.playheadSamples);
            ctx.tempo = map.bpmAtBeat(ctx.ppqPos);
            ctx.playing = true;
            ctx.recording = recording;
            ctx.looping = transport.loopEnabled();
            ctx.sampleRate = sr;

            // Recording tap (SPEC §7): capture -> AudioRecorder ring.
            if (recording && rec) {
                const int nc = std::min(numIn, kMaxCapture);
                for (int c = 0; c < nc; ++c)
                    im.capScratch[c] = (in && in[c]) ? in[c] + outOffset : nullptr;
                rec->pushFromRt(nc > 0 ? im.capScratch : nullptr, nc, ctx.frames,
                                ctx.playheadSamples);
            }

            im.runPass(P, ctx, in, numIn, outOffset, liveMidi, out, numOut);
            liveMidi = nullptr;

            if (im.metronome && transport.metronomeEnabled())
                im.metronome->scheduleBeatClicksRt(map, ctx.playheadSamples, ctx.frames,
                                                   outOffset);
            outOffset += ctx.frames;
        }
        done += chunk;
    }

    // Metronome renders post-master, directly into the device output.
    if (im.metronome)
        im.metronome->renderRt(numOut > 0 ? out[0] : nullptr,
                               numOut > 1 ? out[1] : nullptr, frames);

    // Hard clip guard (±4).
    for (int c = 0; c < numOut; ++c) {
        float* o = out[c];
        if (!o)
            continue;
        for (int i = 0; i < frames; ++i) {
            if (o[i] > kClipGuard)
                o[i] = kClipGuard;
            else if (o[i] < -kClipGuard)
                o[i] = -kClipGuard;
        }
    }
}

void AudioGraph::applyParam(const ParamMsg& msg) {
    impl_->ring.push(msg); // full ring -> drop; the value also lives in the Model
}

void AudioGraph::applyEqCoeffs(uint64_t trackId, const EqBandSet& set) {
    impl_->eqRing.push(Impl::EqMsg{trackId, set}); // full ring -> drop (Model has the bands)
}

bool AudioGraph::renderOffline(
    const Model& model, int64_t startSample, int64_t endSample, int blockSize,
    const std::function<void(const float* const* ch, int numCh, int frames)>& sink,
    std::atomic<float>* progress, std::string& err) {
    return renderOffline(model, startSample, endSample, blockSize, sink, progress, err,
                         0);
}

bool AudioGraph::renderOffline(
    const Model& model, int64_t startSample, int64_t endSample, int blockSize,
    const std::function<void(const float* const* ch, int numCh, int frames)>& sink,
    std::atomic<float>* progress, std::string& err, uint64_t soloTrackId) {
    Impl& im = *impl_;
    if (im.sampleRate <= 0) {
        err = "audio engine not configured";
        return false;
    }
    if (blockSize <= 0) {
        err = "invalid render block size";
        return false;
    }
    if (startSample < 0)
        startSample = 0;
    if (endSample <= startSample) {
        err = "empty render range";
        return false;
    }
    if (!sink) {
        err = "no render sink";
        return false;
    }

    std::vector<uint64_t> roots;
    const std::vector<uint64_t>* rootsPtr = nullptr;
    if (soloTrackId != 0) {
        roots.push_back(soloTrackId);
        rootsPtr = &roots;
    }

    // Separate offline plan: fresh TrackNodes; PluginProxyNodes are shared with the
    // realtime plan — the caller suppresses the driver for the duration (SPEC §7).
    const std::shared_ptr<GraphPlan> plan = im.buildPlan(model, rootsPtr, true, blockSize);
    if (!plan) {
        err = "failed to build render graph";
        return false;
    }

    for (IInsertNode* p : plan->plugins)
        p->setOfflineMode(true);

    enableFtzDaz();
    const TempoMap& map = plan->tempoMap;
    const float* masterCh[2] = {
        plan->chan[static_cast<size_t>(plan->base.masterBufferIndex) * 2],
        plan->chan[static_cast<size_t>(plan->base.masterBufferIndex) * 2 + 1]};
    const double total = static_cast<double>(endSample - startSample);

    int64_t pos = startSample;
    while (pos < endSample) {
        const int n = static_cast<int>(std::min<int64_t>(blockSize, endSample - pos));
        ProcessContext ctx;
        ctx.frames = n;
        ctx.playheadSamples = pos;
        ctx.ppqPos = map.samplesToBeats(pos);
        ctx.tempo = map.bpmAtBeat(ctx.ppqPos);
        ctx.playing = true;
        ctx.recording = false;
        ctx.looping = false;
        ctx.sampleRate = im.sampleRate;

        im.runPass(*plan, ctx, nullptr, 0, 0, nullptr, nullptr, 0);
        sink(masterCh, 2, n);

        pos += n;
        if (progress)
            progress->store(static_cast<float>(static_cast<double>(pos - startSample) / total),
                            std::memory_order_release);
    }

    // Release pass: the offline plan's nodes share LIVE plugin instances with the
    // realtime plan — a render range that cuts a note mid-sound would leave that
    // voice sustaining in the session. One !playing pass flushes every node's clip
    // ledger as plain note-offs (tails-safe) into the shared instances.
    {
        ProcessContext ctx;
        ctx.frames = std::min(blockSize, im.maxBlock > 0 ? im.maxBlock : blockSize);
        ctx.playheadSamples = endSample;
        ctx.ppqPos = map.samplesToBeats(endSample);
        ctx.tempo = map.bpmAtBeat(ctx.ppqPos);
        ctx.playing = false;
        ctx.recording = false;
        ctx.looping = false;
        ctx.sampleRate = im.sampleRate;
        im.runPass(*plan, ctx, nullptr, 0, 0, nullptr, nullptr, 0);
    }

    for (IInsertNode* p : plan->plugins)
        p->setOfflineMode(false);
    if (progress)
        progress->store(1.0f, std::memory_order_release);
    return true;
}

int AudioGraph::latencyTotal() const {
    return impl_->totalLatency.load(std::memory_order_acquire);
}

void AudioGraph::setRecordTap(AudioRecorder* recorder) {
    impl_->recorder.store(recorder, std::memory_order_release);
}

void AudioGraph::allNotesOff() {
    impl_->panic.store(true, std::memory_order_release);
}

void AudioGraph::injectLiveMidi(uint64_t trackId, const MidiEvent& e) {
    impl_->injectRing.push(Impl::LiveInject{trackId, e}); // full ring -> drop (preview)
}

} // namespace mydaw
