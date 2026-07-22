// MyDAW — project/Commands.cpp (E3)
// CommandProcessor implementation. See Commands.h for the per-command flow.

#include "project/Commands.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <initializer_list>
#include <limits>
#include <set>
#include <utility>

#include "EngineContext.h"
#include "agent/AgentCatalog.gen.h"
#include "core/AudioGraph.h"      // E2
#include "core/Transport.h"
#include "media/AssetStore.h"     // E4
#include "media/TimeStretch.h"    // WSOLA stretch / transpose
#include "core/effects/BuiltinEffectManager.h" // in-engine stock effects
#include "plugins/HostProcess.h"  // E7
#include "plugins/PluginProxyNode.h"
#include "plugins/PluginRegistry.h" // E6
#include "project/ModelOps.h"
#include "project/ProjectIO.h"
#include "project/UndoStack.h"
#include "server/EventBus.h"
#include "util/Log.h"
#include "util/Paths.h"
#include "util/Strings.h"

namespace mydaw {

namespace {

constexpr double kMinClipBeats = 1e-3;
constexpr double kMinNoteBeats = 1e-3;

// 12-color track palette — mirrors ui/src/lib/canvas.ts TRACK_COLORS exactly.
constexpr const char* kTrackColors[] = {
    "#e25d5d", "#e2814d", "#d8a14a", "#bdb84f", "#8fc457", "#56c596",
    "#4dc3cd", "#54a3e8", "#7a82f0", "#a06ee8", "#d165d6", "#e0639c",
};
constexpr size_t kNumTrackColors = sizeof(kTrackColors) / sizeof(kTrackColors[0]);

double clampd(double v, double lo, double hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}
int clampi(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

std::vector<uint64_t> idArray(const json& j, const char* key) {
    std::vector<uint64_t> out;
    if (!j.is_object())
        return out;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_array())
        return out;
    for (const json& e : *it)
        if (e.is_number())
            out.push_back(e.get<uint64_t>());
    return out;
}

bool containsId(const std::vector<uint64_t>& v, uint64_t id) {
    for (uint64_t x : v)
        if (x == id)
            return true;
    return false;
}

void sortClipsByStart(Track& t) {
    std::stable_sort(t.clips.begin(), t.clips.end(), [](const Clip& a, const Clip& b) {
        return clipStartBeat(a) < clipStartBeat(b);
    });
}

void sortNotes(MidiClip& c) {
    std::stable_sort(c.notes.begin(), c.notes.end(),
                     [](const Note& a, const Note& b) { return a.startBeat < b.startBeat; });
}

void sortCc(MidiClip& c) {
    std::stable_sort(c.cc.begin(), c.cc.end(), [](const MidiCc& a, const MidiCc& b) {
        return a.controller != b.controller ? a.controller < b.controller
                                            : a.beat < b.beat;
    });
}

void sortLanePoints(AutomationLane& l) {
    std::stable_sort(l.points.begin(), l.points.end(),
                     [](const AutomationPoint& a, const AutomationPoint& b) {
                         return a.beat < b.beat;
                     });
}

// Deep fresh-id remap for duplicated material (asset records stay shared — only the
// project-unique ids are renewed). Used by track duplicate and version copies.
void freshClipIds(Model& m, Clip& c) {
    if (AudioClip* a = asAudio(&c)) {
        a->id = m.nextId();
    } else if (MidiClip* mc = asMidi(&c)) {
        mc->id = m.nextId();
        for (Note& n : mc->notes)
            n.id = m.nextId();
        for (MidiCc& cev : mc->cc)
            cev.id = m.nextId();
    }
}

void freshTakeFolderIds(Model& m, TakeFolder& f) {
    f.id = m.nextId();
    for (TakeLane& ln : f.lanes) {
        ln.id = m.nextId();
        for (Clip& c : ln.clips)
            freshClipIds(m, c);
    }
}

TrackVersion* versionById(Track& t, uint64_t id) {
    for (TrackVersion& v : t.versions)
        if (v.id == id)
            return &v;
    return nullptr;
}

// Removes Track::sends[idx] and keeps "send:<n>" automation lanes consistent:
// the removed index's lane is dropped and higher indices shift down by one.
void eraseSendAndFixLanes(Track& t, int idx) {
    t.sends.erase(t.sends.begin() + idx);
    const std::string exact = "send:" + std::to_string(idx);
    for (auto it = t.automation.begin(); it != t.automation.end();) {
        if (it->paramRef == exact) {
            it = t.automation.erase(it);
            continue;
        }
        if (startsWith(it->paramRef, "send:")) {
            const int k = std::atoi(it->paramRef.c_str() + 5);
            if (k > idx)
                it->paramRef = "send:" + std::to_string(k - 1);
        }
        ++it;
    }
}

void erasePluginLanes(Track& t, uint64_t instanceId) {
    const std::string prefix = "plugin:" + std::to_string(instanceId) + ":";
    for (auto it = t.automation.begin(); it != t.automation.end();) {
        if (startsWith(it->paramRef, prefix))
            it = t.automation.erase(it);
        else
            ++it;
    }
}

// Moves the instance's "plugin:<id>:<param>" automation lanes from `from` to `to` when a
// cross-channel plugin.move changes the insert's owner — a lane must live on the track
// that owns the instance (the graph bake and erasePluginLanes both assume it).
void movePluginLanes(Track& from, Track& to, uint64_t instanceId) {
    const std::string prefix = "plugin:" + std::to_string(instanceId) + ":";
    for (auto it = from.automation.begin(); it != from.automation.end();) {
        if (startsWith(it->paramRef, prefix)) {
            to.automation.push_back(std::move(*it));
            it = from.automation.erase(it);
        } else {
            ++it;
        }
    }
}

// Removes the clip with `id` from `t`, moving it into `out`. False if absent.
bool takeClip(Track& t, uint64_t id, Clip& out) {
    for (size_t i = 0; i < t.clips.size(); ++i) {
        if (clipId(t.clips[i]) == id) {
            out = std::move(t.clips[i]);
            t.clips.erase(t.clips.begin() + static_cast<ptrdiff_t>(i));
            return true;
        }
    }
    return false;
}

std::string fileStem(const std::string& path) {
    const std::string base = fileName(path);
    const std::string ext = fileExtension(base);
    return ext.empty() ? base : base.substr(0, base.size() - ext.size());
}

// Minimal RIFF/WAVE fmt-chunk reader (canonical wavs written by our own WavWriter).
bool readWavFormat(const std::string& path, int& channels, int& sampleRate) {
    std::ifstream f(utf8ToWide(path).c_str(), std::ios::binary);
    if (!f.is_open())
        return false;
    char hdr[12];
    if (!f.read(hdr, 12))
        return false;
    if (std::memcmp(hdr, "RIFF", 4) != 0 || std::memcmp(hdr + 8, "WAVE", 4) != 0)
        return false;
    char chunk[8];
    while (f.read(chunk, 8)) {
        uint32_t size = 0;
        std::memcpy(&size, chunk + 4, 4);
        if (std::memcmp(chunk, "fmt ", 4) == 0) {
            if (size < 16)
                return false;
            char fmt[16];
            if (!f.read(fmt, 16))
                return false;
            uint16_t ch = 0;
            uint32_t sr = 0;
            std::memcpy(&ch, fmt + 2, 2);
            std::memcpy(&sr, fmt + 4, 4);
            channels = static_cast<int>(ch);
            sampleRate = static_cast<int>(sr);
            return channels > 0 && sampleRate > 0;
        }
        f.seekg(size + (size & 1u), std::ios::cur); // chunks are word-aligned
    }
    return false;
}

bool readBinaryFile(const std::string& path, std::vector<uint8_t>& out) {
    std::ifstream f(utf8ToWide(path).c_str(), std::ios::binary | std::ios::ate);
    if (!f.is_open())
        return false;
    const std::streamsize size = f.tellg();
    f.seekg(0, std::ios::beg);
    out.resize(static_cast<size_t>(size));
    if (size > 0 && !f.read(reinterpret_cast<char*>(out.data()), size))
        return false;
    return true;
}

std::string normPathLower(std::string_view p) {
    std::string out = lower(p);
    for (char& c : out)
        if (c == '/')
            c = '\\';
    while (!out.empty() && out.back() == '\\')
        out.pop_back();
    return out;
}

// Project-relative form ("audio/rec-1.wav", forward slashes) when `abs` is inside
// `projectDir`; otherwise `abs` verbatim.
std::string relativizeToProject(const std::string& abs, const std::string& projectDir) {
    if (projectDir.empty())
        return abs;
    const std::string a = normPathLower(abs);
    const std::string d = normPathLower(projectDir) + "\\";
    if (a.size() <= d.size() || a.compare(0, d.size(), d) != 0)
        return abs;
    std::string rel = abs.substr(projectDir.size());
    while (!rel.empty() && (rel.front() == '\\' || rel.front() == '/'))
        rel.erase(rel.begin());
    for (char& c : rel)
        if (c == '\\')
            c = '/';
    return rel;
}

void collectInstances(const Project& p, std::map<uint64_t, PluginInstance>& out) {
    auto scan = [&](const Track& t) {
        for (const PluginInstance& pi : t.inserts)
            out[pi.instanceId] = pi;
    };
    for (const Track& t : p.tracks)
        scan(t);
    scan(p.masterTrack);
}

void appendRestoreError(std::string* error, const std::string& message) {
    if (!error)
        return;
    if (!error->empty())
        *error += "; ";
    *error += message;
}

std::set<uint64_t> changedEqTracks(const Project& before, const Project& after) {
    std::map<uint64_t, const Track*> beforeTracks;
    for (const Track& track : before.tracks)
        beforeTracks[track.id] = &track;
    beforeTracks[before.masterTrack.id] = &before.masterTrack;

    std::set<uint64_t> changed;
    auto inspect = [&](const Track& track) {
        const auto it = beforeTracks.find(track.id);
        if (it != beforeTracks.end() && toJson(it->second->eq) != toJson(track.eq))
            changed.insert(track.id);
    };
    for (const Track& track : after.tracks)
        inspect(track);
    inspect(after.masterTrack);
    return changed;
}

bool validBatchAlias(const std::string& alias) {
    if (alias.empty() || alias.size() > 64 ||
        !std::isalpha(static_cast<unsigned char>(alias.front())))
        return false;
    for (const char c : alias)
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '-')
            return false;
    return true;
}

bool hasOnlyKeys(const json& object, std::initializer_list<const char*> allowed) {
    for (auto it = object.begin(); it != object.end(); ++it) {
        bool found = false;
        for (const char* key : allowed)
            if (it.key() == key) {
                found = true;
                break;
            }
        if (!found)
            return false;
    }
    return true;
}

// Validate result-reference syntax and ordering before any command mutates the model.
bool validateBatchReferences(const json& value, const std::set<std::string>& available,
                             std::string& err, int depth = 0) {
    if (depth > 64) {
        err = "result reference nesting exceeds 64 levels";
        return false;
    }
    if (value.is_object()) {
        if (value.contains("$result")) {
            if (!hasOnlyKeys(value, {"$result", "pointer"}) ||
                !value["$result"].is_string()) {
                err = "a result reference must be {$result:string, pointer?:string}";
                return false;
            }
            const std::string alias = value["$result"].get<std::string>();
            if (available.find(alias) == available.end()) {
                err = "result alias is unavailable or forward-referenced: " + alias;
                return false;
            }
            if (value.contains("pointer")) {
                if (!value["pointer"].is_string()) {
                    err = "result reference pointer must be a string";
                    return false;
                }
                try {
                    (void)json::json_pointer(value["pointer"].get<std::string>());
                } catch (const std::exception& e) {
                    err = std::string("invalid JSON Pointer: ") + e.what();
                    return false;
                }
            }
            return true;
        }
        for (auto it = value.begin(); it != value.end(); ++it)
            if (!validateBatchReferences(it.value(), available, err, depth + 1))
                return false;
    } else if (value.is_array()) {
        for (const json& child : value)
            if (!validateBatchReferences(child, available, err, depth + 1))
                return false;
    }
    return true;
}

// Replace every result-reference sentinel with the exact JSON value addressed in a prior
// aliased reply. The replacement preserves scalar/object/array type.
bool resolveBatchReferences(json& value, const std::map<std::string, json>& results,
                            std::string& err, int depth = 0) {
    if (depth > 64) {
        err = "result reference nesting exceeds 64 levels";
        return false;
    }
    if (value.is_object()) {
        if (value.contains("$result")) {
            const std::string alias = value["$result"].get<std::string>();
            const auto result = results.find(alias);
            if (result == results.end()) {
                err = "unknown result alias: " + alias;
                return false;
            }
            const std::string pointer =
                value.contains("pointer") ? value["pointer"].get<std::string>() : "";
            try {
                if (pointer.empty()) {
                    value = result->second;
                } else {
                    const json::json_pointer jp(pointer);
                    if (!result->second.contains(jp)) {
                        err = "JSON Pointer " + pointer + " does not exist in result " + alias;
                        return false;
                    }
                    value = result->second.at(jp);
                }
            } catch (const std::exception& e) {
                err = "could not resolve result " + alias + " at " + pointer + ": " + e.what();
                return false;
            }
            return true;
        }
        for (auto it = value.begin(); it != value.end(); ++it)
            if (!resolveBatchReferences(it.value(), results, err, depth + 1))
                return false;
    } else if (value.is_array()) {
        for (json& child : value)
            if (!resolveBatchReferences(child, results, err, depth + 1))
                return false;
    }
    return true;
}

} // namespace

// ---------------------------------------------------------------------------
// Construction / wiring
// ---------------------------------------------------------------------------

CommandProcessor::CommandProcessor(EngineContext& ctx) : ctx_(ctx) {}

void CommandProcessor::setAudioFormat(int sampleRate, int maxBlock) {
    if (sampleRate > 0)
        sampleRate_ = sampleRate;
    if (maxBlock > 0)
        maxBlock_ = maxBlock;
}

Model& CommandProcessor::model() {
    return *ctx_.model;
}

const TempoMap& CommandProcessor::tm() {
    if (ctx_.tempoMap)
        return *ctx_.tempoMap;
    localTm_.setSampleRate(model().project.sampleRate);
    localTm_.setMap(model().project.tempoMap, model().project.timeSigMap);
    return localTm_;
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

void CommandProcessor::pushParam(const ParamMsg& m) {
    if (!ctx_.paramRing)
        return;
    if (!ctx_.paramRing->push(m))
        Log::warn("CommandProcessor: param ring full, message dropped");
}

void CommandProcessor::pushEffectiveMutes() {
    for (const auto& [trackId, muted] : computeEffectiveMutes(model())) {
        ParamMsg msg;
        msg.target = ParamMsg::Target::Mute;
        msg.trackId = trackId;
        msg.value = muted ? 1.0f : 0.0f;
        pushParam(msg);
    }
}

void CommandProcessor::drainPendingParams() {
    if (!ctx_.paramRing)
        return;
    // Command execution and this drain share App's main thread, which is the ring's sole
    // consumer. Snapshot replacement makes every queued value suspect; the restored model
    // is re-published below.
    ParamMsg stale;
    while (ctx_.paramRing->pop(stale)) {}
}

void CommandProcessor::restoreLiveControls(
    const std::map<uint64_t, PluginInstance>& controlsBefore,
    const std::set<uint64_t>& eqTrackIds) {
    std::map<uint64_t, PluginInstance> restored;
    collectInstances(model().project, restored);

    for (const auto& [instanceId, instance] : restored) {
        IInsertNode* node = nullptr;
        if (instance.format == "builtin")
            node = builtin_ ? builtin_->node(instanceId) : nullptr;
        else
            node = host_ ? host_->node(instanceId) : nullptr;

        // Directly seed every surviving node. This also repairs unrelated ParamMsgs that
        // were ahead of the failed batch in ctx_.paramRing and were discarded with it.
        if (node) {
            for (const auto& [paramId, value] : instance.paramValues)
                node->setParamRt(paramId, static_cast<float>(value));
            node->setBypass(instance.bypass);
            node->setWetDry(static_cast<float>(instance.wetDry));
        }
        if (instance.format == "builtin" && builtin_)
            builtin_->bindSample(instanceId, instance.sampleAssetId); // 0 explicitly unbinds

        const auto prior = controlsBefore.find(instanceId);
        if (prior == controlsBefore.end() || prior->second.path != instance.path ||
            prior->second.uid != instance.uid || prior->second.bitness != instance.bitness)
            continue; // a newly reconciled node was seeded from the restored model

        // Defensive fallback for undo entries created before first-edit seeding (or when a
        // host did not answer that seed query): absence from paramValues means the plugin's
        // declared default. Restore it explicitly instead of leaving the edited live value.
        json metadata;
        bool loadedMetadata = false;
        for (const auto& [paramId, ignored] : prior->second.paramValues) {
            (void)ignored;
            if (instance.paramValues.find(paramId) != instance.paramValues.end())
                continue;
            if (!loadedMetadata) {
                if (builtin_ && builtin_->has(instanceId))
                    metadata = builtin_->getParams(instanceId);
                else if (host_ && host_->node(instanceId))
                    metadata = host_->getParams(instanceId);
                loadedMetadata = true;
            }
            if (!metadata.is_array())
                continue;
            for (const json& param : metadata) {
                if (!param.is_object() || !param.contains("id") ||
                    !param.contains("defaultValue") || !param["id"].is_number() ||
                    !param["defaultValue"].is_number())
                    continue;
                if (getOr<uint64_t>(param, "id", std::numeric_limits<uint64_t>::max()) !=
                    paramId)
                    continue;
                const double defaultValue = param["defaultValue"].get<double>();
                if (!std::isfinite(defaultValue))
                    break;
                const float restoredDefault =
                    static_cast<float>(clampd(defaultValue, 0.0, 1.0));
                if (node)
                    node->setParamRt(paramId, restoredDefault);
                ParamMsg msg;
                msg.target = ParamMsg::Target::PluginParam;
                msg.instanceId = instanceId;
                msg.index = static_cast<int>(paramId);
                msg.value = restoredDefault;
                pushParam(msg);
                break;
            }
        }

        // AudioGraph may already hold fast-path messages from an earlier main-loop pass.
        // Queue restored values after those stale messages so the final RT-observed value
        // is deterministic. Only changed controls need this ordering barrier.
        if (prior->second.bypass != instance.bypass) {
            ParamMsg msg;
            msg.target = ParamMsg::Target::PluginBypass;
            msg.instanceId = instanceId;
            msg.value = instance.bypass ? 1.0f : 0.0f;
            pushParam(msg);
        }
        if (prior->second.wetDry != instance.wetDry) {
            ParamMsg msg;
            msg.target = ParamMsg::Target::WetDry;
            msg.instanceId = instanceId;
            msg.value = static_cast<float>(instance.wetDry);
            pushParam(msg);
        }
        for (const auto& [paramId, value] : instance.paramValues) {
            const auto oldValue = prior->second.paramValues.find(paramId);
            if (oldValue != prior->second.paramValues.end() && oldValue->second == value)
                continue;
            ParamMsg msg;
            msg.target = ParamMsg::Target::PluginParam;
            msg.instanceId = instanceId;
            msg.index = static_cast<int>(paramId);
            msg.value = static_cast<float>(value);
            pushParam(msg);
        }
    }

    // track.setEq writes AudioGraph's own queue directly. Publishing the restored bands
    // after any stale entries guarantees that the restored plan wins at the next block.
    if (ctx_.audioGraph) {
        for (const uint64_t trackId : eqTrackIds) {
            const Track* track = model().trackById(trackId);
            if (!track)
                continue;
            EqBandSet set;
            if (track->eq.isActive()) {
                const int count =
                    std::min<int>(static_cast<int>(track->eq.bands.size()), kMaxEqBands);
                for (int i = 0; i < count; ++i) {
                    const EqBand& band = track->eq.bands[static_cast<size_t>(i)];
                    set.coeffs[i] =
                        computeEqCoeffs(band.enabled, band.type, band.freqHz, band.gainDb,
                                        band.q, sampleRate_);
                }
                set.count = count;
            }
            ctx_.audioGraph->applyEqCoeffs(trackId, set);
        }
    }
}

void CommandProcessor::rebuildGraph() {
    if (ctx_.audioGraph && ctx_.model)
        ctx_.audioGraph->rebuild(*ctx_.model);
}

void CommandProcessor::markDirty() {
    if (projectIO_) {
        projectIO_->markDirty();
    } else if (ctx_.eventBus) {
        ctx_.eventBus->broadcast("event/dirty", json{{"dirty", true}});
    }
}

void CommandProcessor::broadcastChanges(const CmdResult& r) {
    ++revision_;
    if (!ctx_.eventBus)
        return;
    Model& m = model();
    json ev = json::object();
    ev["revision"] = revision_;
    if (r.fullEvent) {
        ev["scope"] = "project";
        ev["full"] = toJson(m.project);
    } else {
        ev["scope"] = r.scope;
        if (r.allTracksEvent) {
            json arr = json::array();
            for (const Track& t : m.project.tracks) // model order (binding contract)
                arr.push_back(toJson(t));
            ev["tracks"] = std::move(arr);
        } else if (!r.eventTrackIds.empty()) {
            json arr = json::array();
            for (const Track& t : m.project.tracks)
                if (containsId(r.eventTrackIds, t.id))
                    arr.push_back(toJson(t));
            if (containsId(r.eventTrackIds, m.project.masterTrack.id))
                arr.push_back(toJson(m.project.masterTrack));
            if (!arr.empty())
                ev["tracks"] = std::move(arr);
        }
        if (!r.eventClips.empty()) {
            json arr = json::array();
            for (const auto& [trackId, cid] : r.eventClips) {
                (void)trackId;
                const ConstClipRef ref = static_cast<const Model&>(m).clipById(cid);
                if (ref)
                    arr.push_back(json{{"trackId", ref.track->id}, {"clip", toJson(*ref.clip)}});
            }
            if (!arr.empty())
                ev["clips"] = std::move(arr);
        }
        if (!r.removedTrackIds.empty())
            ev["removedTrackIds"] = r.removedTrackIds;
        if (!r.removedClipIds.empty())
            ev["removedClipIds"] = r.removedClipIds;
    }
    ctx_.eventBus->broadcast("event/projectChanged", std::move(ev));
}

void CommandProcessor::emitFullProjectChanged() {
    if (!ctx_.model)
        return;
    // Model was wholesale replaced (load/new/recover/undo/redo) — a pending gesture
    // baseline taken against the previous project state is meaningless now.
    gestureBefore_.reset();
    ++revision_;
    if (!ctx_.eventBus)
        return;
    ctx_.eventBus->broadcast("event/projectChanged",
                             json{{"revision", revision_},
                                  {"scope", "project"},
                                  {"full", toJson(ctx_.model->project)}});
}

void CommandProcessor::syncEngineFromModel() {
    if (!ctx_.model)
        return;
    const Project& p = ctx_.model->project;
    if (ctx_.tempoMap)
        ctx_.tempoMap->setMap(p.tempoMap, p.timeSigMap);
    if (ctx_.transport)
        ctx_.transport->setLoopBeats(p.loop.startBeat, p.loop.endBeat, p.loop.enabled);
    pushEffectiveMutes();
    rebuildGraph();
}

// ---------------------------------------------------------------------------
// execute / dispatch
// ---------------------------------------------------------------------------

json CommandProcessor::execute(const std::string& type, const json& payload,
                               bool transient, std::string& errCode,
                               std::string& errMsg) {
    errCode.clear();
    errMsg.clear();
    if (!ctx_.model) {
        errCode = "no_model";
        errMsg = "engine model not ready";
        return json();
    }
    if (type == "edit/undo")
        return handleUndoRedo(false, errCode, errMsg);
    if (type == "edit/redo")
        return handleUndoRedo(true, errCode, errMsg);

    // Transient gesture undo baseline: the FIRST transient command of a drag gesture
    // snapshots the project; the gesture's closing non-transient commit uses it as the
    // undo "before" (a fresh pre-commit snapshot would equal "after" — undo would be a
    // silent no-op). Accepted quirk: an abandoned transient stream (no commit) folds
    // into the NEXT command's undo entry, which reverts the abandoned drag too — the
    // desired revert anyway. gestureBefore_ is only consumed when an undo entry is
    // actually pushed below, so failed commands (r.fail) and non-mutating commits
    // leave the gesture baseline pending instead of losing it.
    if (transient && !gestureBefore_)
        gestureBefore_ = toJson(model().project);

    json before;
    if (!transient)
        before = gestureBefore_ ? *gestureBefore_ : toJson(model().project);

    CmdResult r;
    json reply = dispatch(type, payload, transient, r);
    if (!r.errCode.empty()) {
        errCode = r.errCode;
        errMsg = r.errMsg.empty() ? r.errCode : r.errMsg;
        return json();
    }

    if (r.structural)
        rebuildGraph();
    if (transient || !r.mutated)
        return reply;

    if (ctx_.undoStack) {
        UndoEntry e;
        e.label = r.label.empty() ? type : r.label;
        e.before = std::move(before);
        e.after = toJson(model().project);
        e.pluginChunks = std::move(r.pluginChunks);
        ctx_.undoStack->push(std::move(e));
    }
    gestureBefore_.reset(); // gesture committed (or unrelated command absorbed it)
    markDirty();
    broadcastChanges(r);
    return reply;
}

json CommandProcessor::executeBatch(const json& payload, std::string& errCode,
                                    std::string& errMsg) {
    errCode.clear();
    errMsg.clear();
    auto fail = [&](const char* code, const std::string& message) {
        errCode = code;
        errMsg = message;
        return json();
    };

    if (!ctx_.model)
        return fail("no_model", "engine model not ready");
    if (!payload.is_object())
        return fail("bad_request", "batch payload must be an object");
    if (payload.contains("transient"))
        return fail("batch_not_supported", "transient gestures cannot run in an atomic batch");
    if (!hasOnlyKeys(payload, {"operations", "expectedRevision", "label"}))
        return fail("bad_request", "batch accepts only operations, expectedRevision, and label");
    if (!payload.contains("operations") || !payload["operations"].is_array())
        return fail("bad_request", "batch operations must be an array");
    const json& operations = payload["operations"];
    if (operations.empty() || operations.size() > 64)
        return fail("bad_request", "batch must contain between 1 and 64 operations");

    if (payload.contains("expectedRevision")) {
        const json& expected = payload["expectedRevision"];
        uint64_t expectedRevision = 0;
        if (expected.is_number_unsigned()) {
            expectedRevision = expected.get<uint64_t>();
        } else if (expected.is_number_integer() && expected.get<int64_t>() >= 0) {
            expectedRevision = static_cast<uint64_t>(expected.get<int64_t>());
        } else {
            return fail("bad_request", "expectedRevision must be a non-negative integer");
        }
        if (expectedRevision != revision_) {
            return fail("stale_revision",
                        "expected revision " + std::to_string(expectedRevision) +
                            ", current revision is " + std::to_string(revision_));
        }
    }

    std::string label = "Agent Batch";
    if (payload.contains("label")) {
        if (!payload["label"].is_string())
            return fail("bad_request", "batch label must be a string");
        label = payload["label"].get<std::string>();
        if (label.empty() || label.size() > 120)
            return fail("bad_request", "batch label must contain 1..120 characters");
    }

    // Validate the complete envelope, batchability, aliases, and reference ordering before
    // dispatching the first operation. Pointer existence is checked later against the actual
    // reply that produced it.
    std::set<std::string> declaredAliases;
    for (size_t index = 0; index < operations.size(); ++index) {
        const json& operation = operations[index];
        const std::string where = "batch operation " + std::to_string(index);
        if (!operation.is_object())
            return fail("bad_request", where + " must be an object");
        if (operation.contains("transient"))
            return fail("batch_not_supported", where + " cannot be transient");
        if (!hasOnlyKeys(operation, {"type", "payload", "as"}))
            return fail("bad_request", where + " accepts only type, payload, and as");
        if (!operation.contains("type") || !operation["type"].is_string())
            return fail("bad_request", where + " type must be a string");
        if (!operation.contains("payload") || !operation["payload"].is_object())
            return fail("bad_request", where + " payload must be an object");
        const std::string type = operation["type"].get<std::string>();
        if (!startsWith(type, "cmd/"))
            return fail("batch_not_supported", where + " must use a cmd/* operation");
        if (!agent::isAgentBatchableOperation(type))
            return fail("batch_not_supported", type + " is not catalog-approved for batching");

        std::string referenceError;
        if (!validateBatchReferences(operation["payload"], declaredAliases, referenceError))
            return fail("bad_result_reference", where + ": " + referenceError);
        if (operation.contains("as")) {
            if (!operation["as"].is_string())
                return fail("bad_request", where + " alias must be a string");
            const std::string alias = operation["as"].get<std::string>();
            if (!validBatchAlias(alias))
                return fail("bad_request",
                            where + " alias must start with a letter and contain at most 64 "
                                    "letters, digits, underscores, or hyphens");
            if (!declaredAliases.insert(alias).second)
                return fail("bad_request", where + " duplicates result alias " + alias);
        }
    }

    // Rollback restores the immediate pre-batch state. The older gesture baseline, when
    // present, is intentionally kept separate and is used only as the successful undo
    // entry's before image (matching execute()).
    const Project rollbackProject = model().project;
    const json undoBefore =
        gestureBefore_ ? *gestureBefore_ : toJson(rollbackProject);
    std::map<uint64_t, std::vector<uint8_t>> pluginChunks;
    std::map<std::string, json> aliasedResults;
    std::set<uint64_t> touchedEqTracks;
    json results = json::array();
    bool attemptedDispatch = false;
    bool anyMutated = false;
    bool anyStructural = false;

    auto mergeChunks = [&](CmdResult& result) {
        for (auto& [instanceId, chunk] : result.pluginChunks)
            pluginChunks.insert_or_assign(instanceId, std::move(chunk));
    };

    std::string rollbackError;
    auto rollback = [&]() {
        drainPendingParams();
        std::map<uint64_t, PluginInstance> mutatedInstances;
        collectInstances(model().project, mutatedInstances);
        model().project = rollbackProject;

        UndoEntry restoreEntry;
        restoreEntry.pluginChunks = pluginChunks;
        rollbackError.clear();
        const bool pluginsRestored =
            reconcilePlugins(mutatedInstances, &restoreEntry, &rollbackError);
        syncEngineFromModel();
        restoreLiveControls(mutatedInstances, touchedEqTracks);
        return pluginsRestored;
    };

    for (size_t index = 0; index < operations.size(); ++index) {
        const json& operation = operations[index];
        const std::string type = operation["type"].get<std::string>();
        json resolvedPayload = operation["payload"];
        std::string referenceError;
        if (!resolveBatchReferences(resolvedPayload, aliasedResults, referenceError)) {
            if (attemptedDispatch && !rollback())
                return fail("rollback_failed",
                            "batch operation " + std::to_string(index) +
                                " failed with bad_result_reference (" + referenceError +
                                "); plugin rollback was incomplete: " + rollbackError);
            return fail("bad_result_reference",
                        "batch operation " + std::to_string(index) + ": " + referenceError);
        }

        if (type == "cmd/track.setEq")
            touchedEqTracks.insert(getOr<uint64_t>(resolvedPayload, "trackId", 0));

        CmdResult result;
        attemptedDispatch = true;
        json reply = dispatch(type, resolvedPayload, false, result);
        mergeChunks(result);
        if (!result.errCode.empty()) {
            const std::string originalCode = result.errCode;
            const std::string originalMessage =
                result.errMsg.empty() ? result.errCode : result.errMsg;
            if (!rollback())
                return fail("rollback_failed",
                            "batch operation " + std::to_string(index) + " (" + type +
                                ") failed with " + originalCode + " (" + originalMessage +
                                "); plugin rollback was incomplete: " + rollbackError);
            return fail(result.errCode.c_str(),
                        "batch operation " + std::to_string(index) + " (" + type +
                            ") failed: " +
                            (result.errMsg.empty() ? result.errCode : result.errMsg));
        }

        anyMutated = anyMutated || result.mutated;
        anyStructural = anyStructural || result.structural;
        json resultRecord{
            {"type", type},
            {"payload", resolvedPayload},
            {"result", reply},
        };
        if (operation.contains("as")) {
            const std::string alias = operation["as"].get<std::string>();
            resultRecord["as"] = alias;
            aliasedResults[alias] = reply;
        }
        results.push_back(std::move(resultRecord));
    }

    if (!anyMutated)
        return json{{"label", label}, {"revision", revision_}, {"results", std::move(results)}};

    if (anyStructural)
        rebuildGraph();
    if (ctx_.undoStack) {
        UndoEntry entry;
        entry.label = label;
        entry.before = undoBefore;
        entry.after = toJson(model().project);
        entry.pluginChunks = std::move(pluginChunks);
        ctx_.undoStack->push(std::move(entry));
    }
    gestureBefore_.reset();
    markDirty();
    emitFullProjectChanged();
    return json{{"label", label}, {"revision", revision_}, {"results", std::move(results)}};
}

json CommandProcessor::dispatch(const std::string& type, const json& p, bool transient,
                                CmdResult& r) {
    // §5.2 tracks
    if (type == "cmd/track.add")        return trackAdd(p, r);
    if (type == "cmd/track.remove")     return trackRemove(p, r);
    if (type == "cmd/track.reorder")    return trackReorder(p, r);
    if (type == "cmd/track.set")        return trackSet(p, transient, r);
    if (type == "cmd/track.setEq")      return trackSetEq(p, transient, r);
    if (type == "cmd/track.addSend")    return trackAddSend(p, r);
    if (type == "cmd/track.removeSend") return trackRemoveSend(p, r);
    if (type == "cmd/track.setSend")    return trackSetSend(p, transient, r);
    if (type == "cmd/track.bounce")     return trackBounce(p, r);
    if (type == "cmd/track.unfreeze")   return trackUnfreeze(p, r);
    if (type == "cmd/track.duplicate")  return trackDuplicate(p, r);
    // §5.3 clips / notes / automation / arrangement
    if (type == "cmd/clip.addMidi")     return clipAddMidi(p, r);
    if (type == "cmd/clip.addAudio")    return clipAddAudio(p, r);
    if (type == "cmd/clip.move")        return clipMove(p, r);
    if (type == "cmd/clip.resize")      return clipResize(p, r);
    if (type == "cmd/clip.stretch")     return clipStretch(p, r);
    if (type == "cmd/clip.processAudio") return clipProcessAudio(p, r);
    if (type == "cmd/clip.split")       return clipSplit(p, r);
    if (type == "cmd/clip.join")        return clipJoin(p, r);
    if (type == "cmd/clip.delete")      return clipDelete(p, r);
    if (type == "cmd/clip.duplicate")   return clipDuplicate(p, r);
    if (type == "cmd/clip.set")         return clipSet(p, r);
    if (type == "cmd/notes.edit")       return notesEdit(p, r);
    if (type == "cmd/notes.quantize")   return notesQuantize(p, r);
    if (type == "cmd/cc.edit")          return ccEdit(p, r);
    if (type == "cmd/automation.set")   return automationSet(p, r);
    if (type == "cmd/automation.ramp")  return automationRamp(p, r);
    if (type == "cmd/automation.clear") return automationClear(p, r);
    if (type == "cmd/marker.add")       return markerAdd(p, r);
    if (type == "cmd/marker.set")       return markerSet(p, r);
    if (type == "cmd/marker.remove")    return markerRemove(p, r);
    if (type == "cmd/tempo.set")        return tempoSet(p, r);
    if (type == "cmd/timesig.set")      return timesigSet(p, r);
    if (type == "cmd/tempoMap.set")     return tempoMapSet(p, r);
    if (type == "cmd/timeSigMap.set")   return timeSigMapSet(p, r);
    if (type == "cmd/loop.set")         return loopSet(p, r);
    if (type == "cmd/grid.set")         return gridSet(p, r);
    // §5.6 plugins
    if (type == "cmd/plugin.add")       return pluginAdd(p, r);
    if (type == "cmd/plugin.remove")    return pluginRemove(p, r);
    if (type == "cmd/plugin.move")      return pluginMove(p, r);
    if (type == "cmd/plugin.set")       return pluginSet(p, transient, r);
    if (type == "cmd/plugin.setParam")  return pluginSetParam(p, transient, r);
    if (type == "cmd/plugin.setSample") return pluginSetSample(p, r);
    if (type == "cmd/vca.add")          return vcaAdd(p, r);
    if (type == "cmd/vca.remove")       return vcaRemove(p, r);
    if (type == "cmd/vca.set")          return vcaSet(p, transient, r);
    if (type == "cmd/take.create")      return takeCreate(p, r);
    if (type == "cmd/take.setComp")     return takeSetComp(p, r);
    if (type == "cmd/take.flatten")     return takeFlatten(p, r);
    if (type == "cmd/version.add")      return versionAdd(p, r);
    if (type == "cmd/version.switch")   return versionSwitch(p, r);
    if (type == "cmd/version.rename")   return versionRename(p, r);
    if (type == "cmd/version.delete")   return versionDelete(p, r);
    // internal
    if (type == "internal/recording.commit") return recordingCommit(p, r);

    return r.fail("unknown_command", "unknown command type: " + type);
}

// ---------------------------------------------------------------------------
// §5.2 — tracks
// ---------------------------------------------------------------------------

json CommandProcessor::trackAdd(const json& p, CmdResult& r) {
    Model& m = model();
    const std::string kindStr = getOr(p, "kind", "audio");
    TrackKind kind = TrackKind::Audio;
    if (!trackKindFromString(kindStr, kind) || kind == TrackKind::Master)
        return r.fail("bad_request", "invalid track kind: " + kindStr);

    Track t;
    t.id = m.nextId();
    t.kind = kind;
    t.channels = getOr<int>(p, "channels", 2) == 1 ? 1 : 2;
    t.color = kTrackColors[m.project.tracks.size() % kNumTrackColors];
    t.outputTarget =
        kind == TrackKind::Folder ? OutputTarget::none() : OutputTarget::master();

    std::string name = getOr(p, "name", "");
    if (name.empty()) {
        const char* base = "Audio";
        switch (kind) {
            case TrackKind::Midi:       base = "MIDI"; break;
            case TrackKind::Instrument: base = "Instrument"; break;
            case TrackKind::Folder:     base = "Folder"; break;
            case TrackKind::Bus:        base = "Bus"; break;
            default: break;
        }
        int count = 1;
        for (const Track& x : m.project.tracks)
            if (x.kind == kind)
                ++count;
        name = std::string(base) + " " + std::to_string(count);
    }
    t.name = std::move(name);

    int index = getOr<int>(p, "index", static_cast<int>(m.project.tracks.size()));
    index = clampi(index, 0, static_cast<int>(m.project.tracks.size()));
    m.project.tracks.insert(m.project.tracks.begin() + index, std::move(t));

    r.label = "Add Track";
    r.structural = true;
    r.scope = "track";
    r.allTracksEvent = true; // ordering matters; UI adopts the complete list
    return json{{"track", toJson(m.project.tracks[static_cast<size_t>(index)])}};
}

json CommandProcessor::trackRemove(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    if (id == m.project.masterTrack.id)
        return r.fail("bad_request", "cannot remove the master track");
    const int idx = m.trackIndex(id);
    if (idx < 0)
        return r.fail("not_found", "unknown trackId");

    Track& t = m.project.tracks[static_cast<size_t>(idx)];
    // Capture plugin chunks for undo, then destroy the live insert nodes (host or built-in).
    for (const PluginInstance& pi : t.inserts) {
        std::vector<uint8_t> chunk;
        if (host_ && host_->getState(pi.instanceId, chunk) && !chunk.empty())
            r.pluginChunks[pi.instanceId] = std::move(chunk);
        destroyInsertNode(pi.instanceId);
    }
    const uint64_t parentOfRemoved = t.parentId;
    m.project.tracks.erase(m.project.tracks.begin() + idx);

    // Reparent children of a removed folder; fix routing references everywhere.
    for (Track& x : m.project.tracks)
        if (x.parentId == id)
            x.parentId = parentOfRemoved;
    auto fixRouting = [&](Track& x) {
        if (x.outputTarget.isTrack() && x.outputTarget.trackId == id)
            x.outputTarget = OutputTarget::master();
        if (x.midiTarget == id)
            x.midiTarget = 0; // routed instrument removed -> feeder plays unrouted
        for (int i = static_cast<int>(x.sends.size()) - 1; i >= 0; --i)
            if (x.sends[static_cast<size_t>(i)].destTrackId == id)
                eraseSendAndFixLanes(x, i);
    };
    for (Track& x : m.project.tracks)
        fixRouting(x);
    fixRouting(m.project.masterTrack);

    pushEffectiveMutes(); // solo/mute topology may have changed
    r.label = "Remove Track";
    r.structural = true;
    r.scope = "track";
    r.allTracksEvent = true; // routing fixes may touch many tracks
    r.removedTrackIds.push_back(id);
    return json::object();
}

json CommandProcessor::trackReorder(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    if (id == m.project.masterTrack.id)
        return r.fail("bad_request", "master track cannot be reordered");
    const int idx = m.trackIndex(id);
    if (idx < 0)
        return r.fail("not_found", "unknown trackId");

    // Folder move. Validate against the CURRENT tree (before the splice).
    // Contract note: an OMITTED parentId means "move to root" (the UI omits it for
    // root), exactly like an explicit null/0 — it does NOT mean "keep current parent".
    uint64_t newParent = 0;
    if (p.is_object() && p.contains("parentId")) {
        const json& pj = p["parentId"];
        if (pj.is_number())
            newParent = pj.get<uint64_t>();
        if (newParent != 0) {
            const Track* parent = m.trackById(newParent);
            if (!parent || parent->kind != TrackKind::Folder)
                return r.fail("bad_request", "parentId must reference a folder track");
            // No folder cycles: the new parent chain must not pass through `id`.
            uint64_t cur = newParent;
            int guard = 0;
            while (cur != 0 && guard++ < 1024) {
                if (cur == id)
                    return r.fail("bad_request", "cannot nest a folder inside itself");
                const Track* ct = m.trackById(cur);
                cur = ct ? ct->parentId : 0;
            }
        }
    }

    Track moved = std::move(m.project.tracks[static_cast<size_t>(idx)]);
    m.project.tracks.erase(m.project.tracks.begin() + idx);
    moved.parentId = newParent;
    int newIndex = getOr<int>(p, "newIndex", idx);
    newIndex = clampi(newIndex, 0, static_cast<int>(m.project.tracks.size()));
    m.project.tracks.insert(m.project.tracks.begin() + newIndex, std::move(moved));

    r.label = "Reorder Tracks";
    r.structural = true;
    r.scope = "track";
    r.allTracksEvent = true;
    return json::object();
}

void CommandProcessor::captureAutomation(uint64_t trackId, const std::string& paramRef,
                                         double value, bool transient, CmdResult& r) {
    if (!ctx_.transport || !ctx_.transport->automationWrite() || !ctx_.transport->isPlaying())
        return;
    const double beat = std::max(0.0, ctx_.transport->playheadBeats());
    AutomationLane* lane = model().automationLane(trackId, paramRef, /*createIfMissing=*/true);
    if (!lane)
        return;
    // Thin: one point per small beat window while dragging past it.
    constexpr double kWriteEps = 1.0 / 96.0;
    AutomationPoint* hit = nullptr;
    for (AutomationPoint& q : lane->points)
        if (std::abs(q.beat - beat) < kWriteEps) { hit = &q; break; }
    if (hit) {
        hit->value = value;
    } else {
        AutomationPoint pt;
        pt.id = model().nextId();
        pt.beat = beat;
        pt.value = value;
        pt.curve = 0.0;
        lane->points.push_back(pt);
        sortLanePoints(*lane);
    }
    // Bake at the gesture commit only — the live value already reaches the RT node via the
    // ParamMsg ring during the drag, so a rebuild per transient message is unnecessary.
    if (!transient)
        r.structural = true;
}

json CommandProcessor::trackSet(const json& p, bool transient, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(id);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    if (!p.is_object() || !p.contains("patch") || !p["patch"].is_object())
        return r.fail("bad_request", "missing patch object");
    const json& patch = p["patch"];
    const bool isMaster = (t->kind == TrackKind::Master);

    // Pre-validate the only failing field so failures never partially apply.
    OutputTarget newTarget;
    bool hasTarget = false;
    if (hasKey(patch, "outputTarget")) {
        if (isMaster)
            return r.fail("bad_request", "master output routing is fixed");
        fromJson(*patch.find("outputTarget"), newTarget, nullptr);
        if (!m.isValidOutputTarget(newTarget))
            return r.fail("bad_request", "outputTarget must be a bus, \"master\" or \"none\"");
        if (newTarget.isTrack() &&
            (newTarget.trackId == id || m.wouldCreateRoutingCycle(id, newTarget.trackId)))
            return r.fail("routing_cycle", "output routing would create a cycle");
        hasTarget = true;
    }

    // midiTarget (SPEC §5.2): only midi tracks may route their MIDI into an Instrument
    // track; 0 (clear) is always accepted. Instrument tracks can never carry a
    // midiTarget, so feeder->target edges are acyclic by construction.
    uint64_t newMidiTarget = 0;
    bool hasMidiTarget = false;
    if (hasKey(patch, "midiTarget")) {
        newMidiTarget = getOr<uint64_t>(patch, "midiTarget", 0);
        if (newMidiTarget != 0) {
            if (t->kind != TrackKind::Midi)
                return r.fail("bad_request", "midiTarget may only be set on midi tracks");
            const Track* tgt = m.trackById(newMidiTarget);
            if (!tgt || tgt->kind != TrackKind::Instrument)
                return r.fail("bad_request",
                              "midiTarget must reference an instrument track");
        }
        hasMidiTarget = true;
    }

    bool any = false;
    bool mixerOnly = true;
    bool muteSolo = false;
    if (hasKey(patch, "name")) {
        t->name = getOr(patch, "name", t->name.c_str());
        any = true;
        mixerOnly = false;
    }
    if (hasKey(patch, "color")) {
        t->color = getOr(patch, "color", t->color.c_str());
        any = true;
        mixerOnly = false;
    }
    if (hasKey(patch, "height")) {
        t->height = std::max(0, getOr<int>(patch, "height", t->height));
        any = true;
        mixerOnly = false;
    }
    if (hasKey(patch, "volume")) {
        t->volume = clampd(getOr<double>(patch, "volume", t->volume), 0.0, 8.0);
        ParamMsg msg;
        msg.target = ParamMsg::Target::Volume;
        msg.trackId = id;
        msg.value = static_cast<float>(t->volume);
        pushParam(msg);
        captureAutomation(id, "volume", t->volume, transient, r);
        any = true;
    }
    if (hasKey(patch, "pan")) {
        t->pan = clampd(getOr<double>(patch, "pan", t->pan), -1.0, 1.0);
        ParamMsg msg;
        msg.target = ParamMsg::Target::Pan;
        msg.trackId = id;
        msg.value = static_cast<float>(t->pan);
        pushParam(msg);
        captureAutomation(id, "pan", t->pan, transient, r);
        any = true;
    }
    if (hasKey(patch, "vcaId")) {
        const uint64_t vid = getOr<uint64_t>(patch, "vcaId", 0);
        if (vid != 0 && !m.vcaById(vid))
            return r.fail("not_found", "unknown vcaId");
        t->vcaId = vid;
        r.structural = true; // rebuild re-bakes cfg.vcaGain for this track
        any = true;
        mixerOnly = false;
    }
    if (hasKey(patch, "mute")) {
        t->mute = getOr<bool>(patch, "mute", t->mute);
        muteSolo = true;
        any = true;
    }
    if (hasKey(patch, "solo")) {
        t->solo = getOr<bool>(patch, "solo", t->solo);
        muteSolo = true;
        any = true;
    }
    bool inputChanged = false;
    if (hasKey(patch, "recordArm")) {
        t->recordArm = getOr<bool>(patch, "recordArm", t->recordArm);
        any = true;
        mixerOnly = false;
        inputChanged = t->kind == TrackKind::Audio; // audio arming (re)opens capture
    }
    if (hasKey(patch, "monitor")) {
        t->monitor = getOr<bool>(patch, "monitor", t->monitor);
        any = true;
        mixerOnly = false;
        r.structural = true; // live-monitor routing is graph-visible (E2)
        if (t->kind == TrackKind::Audio)
            inputChanged = true;
    }
    if (hasKey(patch, "inputDevice")) {
        t->inputDevice = getOr(patch, "inputDevice", t->inputDevice.c_str());
        any = true;
        mixerOnly = false;
        if (t->kind == TrackKind::Audio)
            inputChanged = true;
    }
    if (hasKey(patch, "inputChannel")) {
        t->inputChannel = getOr<int>(patch, "inputChannel", t->inputChannel);
        any = true;
        mixerOnly = false;
    }
    if (hasTarget) {
        t->outputTarget = newTarget;
        any = true;
        mixerOnly = false;
        r.structural = true;
    }
    if (hasMidiTarget) {
        if (t->midiTarget != newMidiTarget) {
            t->midiTarget = newMidiTarget;
            r.structural = true; // feeder->target edges live in the RenderPlan
            muteSolo = true;     // solo closure follows midiTarget (effective mutes)
        }
        any = true;
        mixerOnly = false;
    }

    if (muteSolo)
        pushEffectiveMutes();
    if (!any) {
        r.mutated = false;
        return json::object();
    }
    (void)transient; // transient handling (no undo/no events) is done by execute()
    // Arming / monitoring / re-pointing an audio input reopens the capture stream so the
    // microphone is actually captured (SPEC §7: capture opens only while armed/monitoring).
    if (inputChanged && captureReconcileHook)
        captureReconcileHook();
    r.label = "Edit Track";
    r.scope = mixerOnly ? "mixer" : "track";
    r.eventTrackIds.push_back(id);
    return json::object();
}

// cmd/track.setEq {trackId, patch:{bypass?, bands?}} -> {} (SPEC §5.3).
// `bands`, when present, REPLACES the whole band list. Each band is clamped to the
// contract ranges (freqHz 20..20000, gainDb -24..+24, q 0.1..18, type 0..5 else 0).
// Transient (knob/slider drag): merge + recompute coefficients + publish them to the RT
// node via AudioGraph::applyEqCoeffs (NO rebuild, NO undo/events — execute() returns early,
// coalescing the drag like cmd/track.set). Non-transient commit: same RT-safe coefficient
// push (an EQ change touches neither PDC nor topology, so NO graph rebuild — rebuilding
// would click the audio) + undo entry + projectChanged.
json CommandProcessor::trackSetEq(const json& p, bool transient, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(id);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    // Only tracks that get a processing node in buildPlan can hold an EQ; folders (and any
    // other node-less kind) would serialize a dead eq block and a dead undo entry. Mirror
    // the canHoldClips()/isBusLike() guard used by bounce/addMidiClip.
    if (!t->canHoldClips() && !t->isBusLike())
        return r.fail("bad_request",
                      "EQ is only available on audio/midi/instrument/bus/master tracks");
    if (!p.is_object() || !p.contains("patch") || !p["patch"].is_object())
        return r.fail("bad_request", "missing patch object");
    const json& patch = p["patch"];

    bool any = false;
    if (hasKey(patch, "bypass")) {
        t->eq.bypass = getOr<bool>(patch, "bypass", t->eq.bypass);
        any = true;
    }
    if (hasKey(patch, "bands")) {
        const auto it = patch.find("bands");
        if (!it->is_array())
            return r.fail("bad_request", "bands must be an array");
        // Strict on the live command path: a malformed element is a client bug, not
        // something to silently drop (the tolerant file-load path stays lenient).
        std::vector<EqBand> bands;
        for (const json& bj : *it) {
            EqBand b;
            std::string be;
            if (!fromJson(bj, b, &be)) // clamps/validates to the contract ranges
                return r.fail("bad_request", "invalid eq band: " + be);
            bands.push_back(b);
        }
        // Cap to the engine maximum so publish-side truncation can't silently drop bands.
        if (static_cast<int>(bands.size()) > kMaxEqBands)
            return r.fail("bad_request", "too many eq bands (max " +
                                             std::to_string(kMaxEqBands) + ")");
        t->eq.bands = std::move(bands); // replaces the whole list
        any = true;
    }
    if (!any) {
        r.mutated = false;
        return json::object();
    }

    // Recompute the coefficient cascade on this (control) thread and publish it RT-safely
    // to the live node (state-preserving setActiveRt) for BOTH transient and committed
    // edits. An EQ coefficient/bypass change affects neither PDC nor topology, so it does
    // NOT need a graph rebuild — and rebuilding would click the audio. The non-transient
    // commit still produces an undo entry + projectChanged below (undoable, UI syncs); a
    // later structural rebuild (e.g. undo) re-bakes these coeffs from the model and carries
    // filter state forward (EqProcessor::adoptState), so it stays click-free too. A
    // bypassed/band-less EQ publishes count 0 (a true RT no-op).
    if (ctx_.audioGraph) {
        EqBandSet set;
        if (t->eq.isActive()) {
            const int n = std::min<int>(static_cast<int>(t->eq.bands.size()), kMaxEqBands);
            for (int i = 0; i < n; ++i) {
                const EqBand& b = t->eq.bands[static_cast<size_t>(i)];
                set.coeffs[i] = computeEqCoeffs(b.enabled, b.type, b.freqHz, b.gainDb, b.q,
                                                sampleRate_);
            }
            set.count = n;
        }
        ctx_.audioGraph->applyEqCoeffs(id, set);
    }

    r.label = "Edit EQ";
    r.scope = "mixer";
    r.eventTrackIds.push_back(id);
    return json::object();
}

json CommandProcessor::trackAddSend(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    const uint64_t dest = getOr<uint64_t>(p, "destTrackId", 0);
    Track* t = m.trackById(id);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    if (t->kind == TrackKind::Master || t->kind == TrackKind::Folder)
        return r.fail("bad_request", "this track kind cannot have sends");
    if (!m.isValidSendDest(dest))
        return r.fail("bad_request", "send destination must be a bus track");
    if (dest == id || m.wouldCreateRoutingCycle(id, dest))
        return r.fail("routing_cycle", "send would create a routing cycle");

    Send s;
    s.destTrackId = dest;
    s.level = clampd(getOr<double>(p, "level", 1.0), 0.0, 8.0);
    s.pre = getOr<bool>(p, "pre", false);
    s.enabled = true;
    t->sends.push_back(s);

    r.label = "Add Send";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(id);
    return json::object();
}

json CommandProcessor::trackRemoveSend(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(id);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    const int idx = getOr<int>(p, "sendIndex", -1);
    if (idx < 0 || idx >= static_cast<int>(t->sends.size()))
        return r.fail("not_found", "sendIndex out of range");
    eraseSendAndFixLanes(*t, idx);

    r.label = "Remove Send";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(id);
    return json::object();
}

json CommandProcessor::trackSetSend(const json& p, bool transient, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(id);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    const int idx = getOr<int>(p, "sendIndex", -1);
    if (idx < 0 || idx >= static_cast<int>(t->sends.size()))
        return r.fail("not_found", "sendIndex out of range");
    if (!p.is_object() || !p.contains("patch") || !p["patch"].is_object())
        return r.fail("bad_request", "missing patch object");
    const json& patch = p["patch"];
    Send& s = t->sends[static_cast<size_t>(idx)];

    bool any = false;
    if (hasKey(patch, "level")) {
        s.level = clampd(getOr<double>(patch, "level", s.level), 0.0, 8.0);
        ParamMsg msg;
        msg.target = ParamMsg::Target::SendLevel;
        msg.trackId = id;
        msg.index = idx;
        msg.value = static_cast<float>(s.level);
        pushParam(msg);
        captureAutomation(id, "send:" + std::to_string(idx), s.level, transient, r);
        any = true;
    }
    if (hasKey(patch, "pre")) {
        s.pre = getOr<bool>(patch, "pre", s.pre);
        r.structural = true; // tap point changes the plan
        any = true;
    }
    if (hasKey(patch, "enabled")) {
        s.enabled = getOr<bool>(patch, "enabled", s.enabled);
        r.structural = true;
        any = true;
    }
    if (!any) {
        r.mutated = false;
        return json::object();
    }
    (void)transient;
    r.label = "Edit Send";
    r.scope = "mixer";
    r.eventTrackIds.push_back(id);
    return json::object();
}

json CommandProcessor::trackBounce(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    const bool freeze = getOr<bool>(p, "freeze", false);
    Track* t = m.trackById(id);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    if (!t->canHoldClips())
        return r.fail("bad_request", "only audio/midi/instrument tracks can be bounced");
    if (freeze && t->frozen)
        return r.fail("bad_request", "track is already frozen");
    const double endBeat = trackEndBeat(*t, tm()); // freeze renders [0, trackEnd] (contract)
    if (endBeat <= 0.0)
        return r.fail("nothing_to_bounce", "track has no clips to bounce");
    if (!bounceRenderHook)
        return r.fail("not_supported", "bounce/freeze rendering is not wired");

    Asset a;
    std::string err;
    if (!bounceRenderHook(id, endBeat, a, err))
        return r.fail("render_failed", err.empty() ? "offline render failed" : err);
    a.id = m.nextId();
    a.missing = false;
    m.project.assets.push_back(a);
    if (ctx_.assetStore) {
        ctx_.assetStore->loadAsync(a, std::function<void(bool)>());
        ctx_.assetStore->ensurePeaks(a);
    }
    t = m.trackById(id); // re-lookup in case the hook touched the model
    if (freeze && t) {
        t->frozen = true;
        t->frozenAssetId = a.id;
    }

    r.label = freeze ? "Freeze Track" : "Bounce Track";
    r.structural = true;
    r.fullEvent = true; // asset list changed -> full snapshot (granular has no assets)
    return json{{"assetId", a.id}};
}

json CommandProcessor::trackUnfreeze(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(id);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    if (!t->frozen)
        return r.fail("bad_request", "track is not frozen");
    const uint64_t assetId = t->frozenAssetId;
    t->frozen = false;
    t->frozenAssetId = 0;
    for (size_t i = 0; i < m.project.assets.size(); ++i) {
        if (m.project.assets[i].id == assetId) {
            m.project.assets.erase(m.project.assets.begin() +
                                   static_cast<ptrdiff_t>(i));
            break; // file stays on disk (undo restores the record)
        }
    }
    r.label = "Unfreeze Track";
    r.structural = true;
    r.fullEvent = true;
    return json::object();
}

// cmd/track.duplicate {trackId} → {track} — deep copy inserted right after the source
// subtree. Every model object gets a fresh id (track/clips/notes/cc/automation points);
// plugin inserts get new instances with the source state transferred; folders clone
// their whole descendant tree (cloned children reparented onto the cloned folders).
// sends/outputTarget aimed inside the subtree are remapped onto the clones; frozen
// state resets on the copy (frozen asset records are single-owner).
json CommandProcessor::trackDuplicate(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "trackId", 0);
    if (id == m.project.masterTrack.id)
        return r.fail("bad_request", "master track cannot be duplicated");
    if (m.trackIndex(id) < 0)
        return r.fail("bad_request", "unknown trackId");

    // Source subtree = the track + all folder descendants, in model order. Fixed-point
    // membership scan so a child listed before its parent is still picked up.
    std::set<uint64_t> subtree{id};
    bool grew = true;
    while (grew) {
        grew = false;
        for (const Track& t : m.project.tracks)
            if (t.parentId != 0 && subtree.count(t.parentId) && !subtree.count(t.id)) {
                subtree.insert(t.id);
                grew = true;
            }
    }
    std::vector<size_t> srcIndices;
    for (size_t i = 0; i < m.project.tracks.size(); ++i)
        if (subtree.count(m.project.tracks[i].id))
            srcIndices.push_back(i);

    // Pass 1: allocate the clone track ids up front so children can be reparented onto
    // cloned folders regardless of list order.
    std::map<uint64_t, uint64_t> trackIdMap; // src track id -> clone track id
    for (size_t i : srcIndices)
        trackIdMap[m.project.tracks[i].id] = m.nextId();

    // Pass 2: deep-copy each subtree member with fresh ids everywhere.
    std::vector<Track> clones;
    clones.reserve(srcIndices.size());
    for (size_t i : srcIndices) {
        Track copy = m.project.tracks[i];
        copy.id = trackIdMap[copy.id];
        copy.name += " copy";
        copy.recordArm = false; // avoid surprise double-record/monitor on the copy
        copy.monitor = false;
        // The copy must NOT share the source's frozen asset record: trackUnfreeze
        // erases that record, which would break the other track. The copy has the full
        // clip+insert data and renders live; the user can re-freeze it.
        copy.frozen = false;
        copy.frozenAssetId = 0;
        const auto pit = trackIdMap.find(copy.parentId);
        if (pit != trackIdMap.end())
            copy.parentId = pit->second; // child of a cloned folder

        // Intra-subtree routing follows the clones; targets outside the cloned
        // subtree stay pointed at the original destinations.
        for (Send& s : copy.sends) {
            const auto sit = trackIdMap.find(s.destTrackId);
            if (sit != trackIdMap.end())
                s.destTrackId = sit->second;
        }
        if (copy.outputTarget.isTrack()) {
            const auto oit = trackIdMap.find(copy.outputTarget.trackId);
            if (oit != trackIdMap.end())
                copy.outputTarget.trackId = oit->second;
        }
        if (copy.midiTarget != 0) { // feeder->instrument routing follows the clones too
            const auto mit = trackIdMap.find(copy.midiTarget);
            if (mit != trackIdMap.end())
                copy.midiTarget = mit->second;
        }

        for (Clip& c : copy.clips)
            freshClipIds(m, c); // assets are shared between source and copy
        // Comping takes and parked track versions carry real clip/lane ids too
        // (takeFolders were previously missed — the copy shared take ids with the source).
        for (TakeFolder& f : copy.takeFolders)
            freshTakeFolderIds(m, f);
        for (TrackVersion& v : copy.versions) {
            const uint64_t newVid = m.nextId();
            if (copy.activeVersionId == v.id)
                copy.activeVersionId = newVid;
            v.id = newVid;
            for (Clip& c : v.clips)
                freshClipIds(m, c);
            for (TakeFolder& f : v.takeFolders)
                freshTakeFolderIds(m, f);
        }

        // New plugin instances; transfer the live state from the source instance and
        // capture the copy's chunk for undo/redo + save (mirrors pluginAdd). A failed
        // create keeps the insert in the model, exactly like project load (§5.6 — the
        // state callback already broadcast failed).
        std::map<uint64_t, uint64_t> instanceIdMap; // src instanceId -> clone instanceId
        for (PluginInstance& pi : copy.inserts) {
            const uint64_t oldId = pi.instanceId;
            pi.instanceId = m.nextId();
            pi.stateFile.clear(); // clone has no saved chunk yet; paramValues kept
            instanceIdMap[oldId] = pi.instanceId;
            std::string err;
            if (!createInsertNode(pi, err)) {
                Log::error("track.duplicate: plugin '%s' failed to load: %s",
                           pi.name.c_str(), err.c_str());
                continue;
            }
            // Host plugins copy the opaque chunk src->clone; built-ins already cloned params.
            std::vector<uint8_t> chunk;
            if (host_ && host_->getState(oldId, chunk) && !chunk.empty())
                host_->setState(pi.instanceId, chunk);
            chunk.clear();
            if (host_ && host_->getState(pi.instanceId, chunk) && !chunk.empty())
                r.pluginChunks[pi.instanceId] = std::move(chunk);
        }

        // Automation: fresh point ids; "plugin:<src>:<param>" refs follow the clone's
        // instance ids. Other paramRefs (volume/pan/send:<n>) carry over unchanged.
        for (AutomationLane& l : copy.automation) {
            if (startsWith(l.paramRef, "plugin:")) {
                const size_t colon = l.paramRef.find(':', 7);
                const uint64_t srcInst = std::strtoull(l.paramRef.c_str() + 7, nullptr, 10);
                const auto it = instanceIdMap.find(srcInst);
                if (colon != std::string::npos && it != instanceIdMap.end())
                    l.paramRef =
                        "plugin:" + std::to_string(it->second) + l.paramRef.substr(colon);
            }
            for (AutomationPoint& pt : l.points)
                pt.id = m.nextId();
        }
        clones.push_back(std::move(copy));
    }

    // Insert the cloned subtree immediately after the last source subtree row,
    // preserving relative order.
    const size_t insertPos = srcIndices.back() + 1;
    m.project.tracks.insert(m.project.tracks.begin() + static_cast<ptrdiff_t>(insertPos),
                            clones.begin(), clones.end());

    pushEffectiveMutes(); // the copy inherits solo — topology may have changed
    r.label = "Duplicate Track";
    r.structural = true;
    r.scope = "track";
    r.allTracksEvent = true; // ordering changed; UI adopts the complete list
    return json{{"track", toJson(m.project.tracks[insertPos])}};
}

// ---------------------------------------------------------------------------
// §5.3 — clips
// ---------------------------------------------------------------------------

json CommandProcessor::clipAddMidi(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    if (!t->canHoldClips() || t->kind == TrackKind::Audio)
        return r.fail("bad_request", "midi clips require a midi/instrument track");
    const double lengthBeats = getOr<double>(p, "lengthBeats", 0.0);
    if (lengthBeats < kMinClipBeats)
        return r.fail("bad_request", "lengthBeats must be > 0");

    MidiClip c;
    c.id = m.nextId();
    c.startBeat = std::max(0.0, getOr<double>(p, "startBeat", 0.0));
    c.lengthBeats = lengthBeats;
    c.name = getOr(p, "name", "");
    if (c.name.empty())
        c.name = t->name;
    c.color = getOr(p, "color", "");
    if (p.is_object() && p.contains("notes") && p["notes"].is_array()) {
        for (const json& nj : p["notes"]) { // pinned UI-paste extension
            if (!nj.is_object())
                continue;
            Note n;
            n.id = m.nextId();
            n.pitch = clampi(getOr<int>(nj, "pitch", 60), 0, 127);
            n.velocity = clampi(getOr<int>(nj, "velocity", 100), 1, 127);
            n.startBeat = std::max(0.0, getOr<double>(nj, "startBeat", 0.0));
            n.lengthBeats = std::max(kMinNoteBeats, getOr<double>(nj, "lengthBeats", 1.0));
            n.channel = clampi(getOr<int>(nj, "channel", 0), 0, 15);
            c.notes.push_back(n);
        }
        sortNotes(c);
    }
    const uint64_t cid = c.id;
    t->clips.emplace_back(std::move(c));
    sortClipsByStart(*t);

    r.label = "Add Clip";
    r.structural = true;
    r.scope = "clip";
    r.eventClips.emplace_back(trackId, cid);
    const ConstClipRef ref = static_cast<const Model&>(m).clipById(cid);
    return json{{"clip", toJson(*ref.clip)}};
}

json CommandProcessor::clipAddAudio(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    if (t->kind != TrackKind::Audio)
        return r.fail("bad_request", "audio clips require an audio track");
    const uint64_t assetId = getOr<uint64_t>(p, "assetId", 0);
    const Asset* a = m.assetById(assetId);
    if (!a)
        return r.fail("not_found", "unknown assetId");

    AudioClip c;
    c.id = m.nextId();
    c.assetId = assetId;
    c.startBeat = std::max(0.0, getOr<double>(p, "startBeat", 0.0));
    // Pinned UI-paste extension fields:
    c.srcOffsetSamples = std::max<int64_t>(0, getOr<int64_t>(p, "srcOffsetSamples", 0));
    if (a->lengthSamples > 0 && c.srcOffsetSamples >= a->lengthSamples)
        c.srcOffsetSamples = a->lengthSamples - 1;
    const int64_t maxLen = a->lengthSamples > 0
                               ? a->lengthSamples - c.srcOffsetSamples
                               : std::numeric_limits<int64_t>::max();
    int64_t len = getOr<int64_t>(p, "lengthSamples", maxLen);
    c.lengthSamples = std::max<int64_t>(1, std::min(len, maxLen));
    c.gain = clampd(getOr<double>(p, "gain", 1.0), 0.0, 8.0);
    c.fadeInSec = std::max(0.0, getOr<double>(p, "fadeInSec", 0.0));
    c.fadeOutSec = std::max(0.0, getOr<double>(p, "fadeOutSec", 0.0));
    c.name = getOr(p, "name", "");
    if (c.name.empty())
        c.name = fileStem(a->file.empty() ? a->originalPath : a->file);
    c.color = getOr(p, "color", "");

    const uint64_t cid = c.id;
    t->clips.emplace_back(std::move(c));
    sortClipsByStart(*t);

    r.label = "Add Clip";
    r.structural = true;
    r.scope = "clip";
    r.eventClips.emplace_back(trackId, cid);
    const ConstClipRef ref = static_cast<const Model&>(m).clipById(cid);
    return json{{"clip", toJson(*ref.clip)}};
}

json CommandProcessor::clipMove(const json& p, CmdResult& r) {
    Model& m = model();
    const std::vector<uint64_t> ids = idArray(p, "clipIds");
    if (ids.empty())
        return r.fail("bad_request", "clipIds is empty");
    double delta = getOr<double>(p, "deltaBeats", 0.0);
    const uint64_t targetId = getOr<uint64_t>(p, "targetTrackId", 0);
    Track* target = nullptr;
    if (targetId != 0) {
        target = m.trackById(targetId);
        if (!target || !target->canHoldClips())
            return r.fail("bad_request", "invalid target track");
    }

    // Validate everything first; clamp delta so nothing crosses beat 0.
    double minStart = std::numeric_limits<double>::max();
    for (uint64_t id : ids) {
        const ClipRef ref = m.clipById(id);
        if (!ref)
            return r.fail("not_found", "unknown clipId");
        minStart = std::min(minStart, clipStartBeat(*ref.clip));
        if (target) {
            const bool isAudioClip = clipType(*ref.clip) == ClipType::Audio;
            const bool targetIsAudio = target->kind == TrackKind::Audio;
            if (isAudioClip != targetIsAudio)
                return r.fail("bad_request", "clip kind does not match target track");
        }
    }
    if (minStart + delta < 0.0)
        delta = -minStart;

    std::set<Track*> touched;
    for (uint64_t id : ids) {
        ClipRef ref = m.clipById(id); // fresh lookup; earlier moves shift vectors
        Track* dst = target ? target : ref.track;
        const double ns = clipStartBeat(*ref.clip) + delta;
        if (dst != ref.track) {
            Clip moved;
            takeClip(*ref.track, id, moved);
            setClipStartBeat(moved, ns);
            touched.insert(ref.track);
            dst->clips.push_back(std::move(moved));
        } else {
            setClipStartBeat(*ref.clip, ns);
        }
        touched.insert(dst);
        r.eventClips.emplace_back(dst->id, id);
    }
    for (Track* t : touched)
        sortClipsByStart(*t);

    r.label = "Move Clips";
    r.structural = true;
    r.scope = "clip";
    return json::object();
}

json CommandProcessor::clipResize(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "clipId", 0);
    const ClipRef ref = m.clipById(id);
    if (!ref)
        return r.fail("not_found", "unknown clipId");
    const std::string edge = getOr(p, "edge", "");
    if (edge != "l" && edge != "r")
        return r.fail("bad_request", "edge must be \"l\" or \"r\"");
    const TempoMap& T = tm();

    if (MidiClip* mc = asMidi(ref.clip)) {
        if (edge == "r") {
            if (!hasKey(p, "newLengthBeats"))
                return r.fail("bad_request", "newLengthBeats required for edge \"r\"");
            mc->lengthBeats =
                std::max(kMinClipBeats, getOr<double>(p, "newLengthBeats", mc->lengthBeats));
        } else {
            if (!hasKey(p, "newStartBeat"))
                return r.fail("bad_request", "newStartBeat required for edge \"l\"");
            double ns = std::max(0.0, getOr<double>(p, "newStartBeat", mc->startBeat));
            double delta = ns - mc->startBeat;
            delta = std::min(delta, mc->lengthBeats - kMinClipBeats);
            mc->startBeat += delta;
            mc->lengthBeats -= delta;
            // Left-edge resize shifts note content so it stays at absolute position.
            for (auto it = mc->notes.begin(); it != mc->notes.end();) {
                it->startBeat -= delta;
                if (it->startBeat < 0.0) {
                    it->lengthBeats += it->startBeat;
                    it->startBeat = 0.0;
                }
                if (it->lengthBeats < kMinNoteBeats)
                    it = mc->notes.erase(it);
                else
                    ++it;
            }
            for (auto it = mc->cc.begin(); it != mc->cc.end();) {
                it->beat -= delta;
                if (it->beat < 0.0)
                    it = mc->cc.erase(it); // cc trimmed off the clip start is dropped
                else
                    ++it;
            }
        }
    } else {
        AudioClip* a = asAudio(ref.clip);
        const Asset* asset = m.assetById(a->assetId);
        if (edge == "l") {
            if (!hasKey(p, "newStartBeat"))
                return r.fail("bad_request", "newStartBeat required for edge \"l\"");
            const double ns = std::max(0.0, getOr<double>(p, "newStartBeat", a->startBeat));
            const int64_t oldStartSample = llround(T.beatsToSamplesF(a->startBeat));
            const int64_t newStartSample = llround(T.beatsToSamplesF(ns));
            int64_t delta = newStartSample - oldStartSample;
            delta = std::max(delta, -a->srcOffsetSamples);  // no material before start
            delta = std::min(delta, a->lengthSamples - 1);  // keep >= 1 sample
            a->srcOffsetSamples += delta;
            a->lengthSamples -= delta;
            a->startBeat = T.samplesToBeats(oldStartSample + delta);
        } else {
            if (!hasKey(p, "newLengthBeats"))
                return r.fail("bad_request", "newLengthBeats required for edge \"r\"");
            const double nl = std::max(0.0, getOr<double>(p, "newLengthBeats", 0.0));
            const int64_t startSample = llround(T.beatsToSamplesF(a->startBeat));
            const int64_t endSample = llround(T.beatsToSamplesF(a->startBeat + nl));
            int64_t newLen = endSample - startSample;
            if (asset && asset->lengthSamples > 0) // trim only — never stretch (v1)
                newLen = std::min(newLen, asset->lengthSamples - a->srcOffsetSamples);
            a->lengthSamples = std::max<int64_t>(1, newLen);
        }
    }
    sortClipsByStart(*ref.track);

    r.label = "Resize Clip";
    r.structural = true;
    r.scope = "clip";
    r.eventClips.emplace_back(ref.track->id, id);
    return json::object();
}

json CommandProcessor::clipStretch(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "clipId", 0);
    const ClipRef ref = m.clipById(id);
    if (!ref)
        return r.fail("not_found", "unknown clipId");
    AudioClip* ac = asAudio(ref.clip);
    if (!ac)
        return r.fail("bad_request", "time-stretch requires an audio clip");
    const double ratio = std::clamp(getOr<double>(p, "ratio", 1.0), 0.25, 4.0);
    const bool transpose = getOr<bool>(p, "transpose", false); // preserve length, shift pitch
    if (!ctx_.assetStore || !pcmToAssetHook)
        return r.fail("not_supported", "time-stretch is not wired");
    const PcmData* pcm = ctx_.assetStore->pcm(ac->assetId);
    if (!pcm || pcm->planes.empty())
        return r.fail("bad_request", "clip audio not loaded");

    const int nch = static_cast<int>(pcm->planes.size());
    const int64_t total = pcm->frames;
    const int64_t off = std::clamp<int64_t>(ac->srcOffsetSamples, 0, total);
    const int64_t len = std::clamp<int64_t>(ac->lengthSamples, 0, total - off);
    if (len < 8)
        return r.fail("bad_request", "clip is too short to stretch");
    std::vector<std::vector<float>> seg(static_cast<size_t>(nch));
    for (int ch = 0; ch < nch; ++ch)
        seg[static_cast<size_t>(ch)].assign(pcm->planes[static_cast<size_t>(ch)].begin() + off,
                                            pcm->planes[static_cast<size_t>(ch)].begin() + off + len);

    const int sr = m.project.sampleRate;
    std::vector<std::vector<float>> outPcm;
    if (transpose) {
        auto stretched = wsolaStretch(seg, len, ratio, sr); // longer, same pitch
        outPcm = resampleLinear(stretched, static_cast<int64_t>(stretched[0].size()), ratio); // back to len, pitch*ratio
    } else {
        outPcm = wsolaStretch(seg, len, ratio, sr);
    }
    const int64_t newLen = static_cast<int64_t>(outPcm.empty() ? 0 : outPcm[0].size());

    Asset a;
    std::string err;
    if (!pcmToAssetHook(outPcm, ac->name.empty() ? std::string("stretch") : ac->name, a, err))
        return r.fail("render_failed", err.empty() ? "stretch write failed" : err);
    a.id = m.nextId();
    a.missing = false;
    m.project.assets.push_back(a);
    ctx_.assetStore->loadAsync(a, std::function<void(bool)>());
    ctx_.assetStore->ensurePeaks(a);

    ac->assetId = a.id;
    ac->srcOffsetSamples = 0;
    ac->lengthSamples = newLen; // timeline length derives from this + tempo (a 2x stretch → 2x wide)

    r.label = transpose ? "Transpose Clip" : "Time-Stretch Clip";
    r.structural = true;
    r.fullEvent = true; // asset list changed → full snapshot
    return json{{"assetId", a.id}, {"lengthSamples", newLen}};
}

// cmd/clip.processAudio — destructive Cubase-style Audio→Process on an audio clip's
// span: gain / normalize / fadeIn / fadeOut / reverse / invert / silence / dcRemove.
// The processed span is written as a NEW "edit" asset (pcmToAssetHook — project audio/
// dir, fallback media dir for never-saved sessions) and the clip is repointed at offset
// 0 with the same length; undo repoints back (the edit file stays on disk, like stretch).
json CommandProcessor::clipProcessAudio(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "clipId", 0);
    const ClipRef ref = m.clipById(id);
    if (!ref)
        return r.fail("not_found", "unknown clipId");
    AudioClip* ac = asAudio(ref.clip);
    if (!ac)
        return r.fail("bad_request", "audio processing requires an audio clip");
    const std::string op = getOr(p, "op", "");
    const char* label = op == "gain"        ? "Gain"
                        : op == "normalize" ? "Normalize"
                        : op == "fadeIn"    ? "Fade In"
                        : op == "fadeOut"   ? "Fade Out"
                        : op == "reverse"   ? "Reverse"
                        : op == "invert"    ? "Invert Phase"
                        : op == "silence"   ? "Silence"
                        : op == "dcRemove"  ? "Remove DC Offset"
                                            : nullptr;
    if (!label)
        return r.fail("bad_request", "unknown op: " + op);
    if (!ctx_.assetStore || !pcmToAssetHook)
        return r.fail("not_supported", "audio processing is not wired");
    const PcmData* pcm = ctx_.assetStore->pcm(ac->assetId);
    if (!pcm || pcm->planes.empty())
        return r.fail("bad_request", "clip audio not loaded");

    const int nch = static_cast<int>(pcm->planes.size());
    const int64_t total = pcm->frames;
    const int64_t off = std::clamp<int64_t>(ac->srcOffsetSamples, 0, total);
    const int64_t len = std::clamp<int64_t>(ac->lengthSamples, 0, total - off);
    if (len < 1)
        return r.fail("bad_request", "clip span is empty");
    std::vector<std::vector<float>> seg(static_cast<size_t>(nch));
    for (int ch = 0; ch < nch; ++ch)
        seg[static_cast<size_t>(ch)].assign(pcm->planes[static_cast<size_t>(ch)].begin() + off,
                                            pcm->planes[static_cast<size_t>(ch)].begin() + off + len);

    const auto n = static_cast<size_t>(len);
    if (op == "gain") {
        const float g = static_cast<float>(
            std::pow(10.0, std::clamp(getOr<double>(p, "gainDb", 0.0), -48.0, 48.0) / 20.0));
        for (auto& ch : seg)
            for (float& s : ch) s *= g;
    } else if (op == "normalize") {
        const double targetDb = std::clamp(getOr<double>(p, "targetDb", -1.0), -48.0, 0.0);
        float peak = 0.f;
        for (const auto& ch : seg)
            for (const float s : ch) peak = std::max(peak, std::fabs(s));
        if (peak > 1e-9f) {
            const float g = static_cast<float>(std::pow(10.0, targetDb / 20.0)) / peak;
            for (auto& ch : seg)
                for (float& s : ch) s *= g;
        }
    } else if (op == "fadeIn" || op == "fadeOut") {
        // Full-span linear fade (Cubase Process semantics; the clip's non-destructive
        // fade handles remain available on top).
        const bool in = op == "fadeIn";
        const double denom = std::max<size_t>(1, n - 1);
        for (auto& ch : seg)
            for (size_t i = 0; i < n; ++i) {
                const double t = static_cast<double>(i) / denom;
                ch[i] *= static_cast<float>(in ? t : 1.0 - t);
            }
    } else if (op == "reverse") {
        for (auto& ch : seg)
            std::reverse(ch.begin(), ch.end());
    } else if (op == "invert") {
        for (auto& ch : seg)
            for (float& s : ch) s = -s;
    } else if (op == "silence") {
        for (auto& ch : seg)
            std::fill(ch.begin(), ch.end(), 0.f);
    } else { // dcRemove
        for (auto& ch : seg) {
            double mean = 0.0;
            for (const float s : ch) mean += s;
            mean /= static_cast<double>(n);
            const float dc = static_cast<float>(mean);
            for (float& s : ch) s -= dc;
        }
    }

    Asset a;
    std::string err;
    if (!pcmToAssetHook(seg, (ac->name.empty() ? std::string("clip") : ac->name) + "-" + op,
                        a, err))
        return r.fail("render_failed", err.empty() ? "edit write failed" : err);
    a.id = m.nextId();
    a.missing = false;
    m.project.assets.push_back(a);
    ctx_.assetStore->loadAsync(a, std::function<void(bool)>());
    ctx_.assetStore->ensurePeaks(a);

    ac->assetId = a.id;
    ac->srcOffsetSamples = 0;
    ac->lengthSamples = len; // span (and timeline length) unchanged

    r.label = std::string("Process: ") + label;
    r.structural = true;
    r.fullEvent = true; // asset list changed → full snapshot
    return json{{"assetId", a.id}};
}

json CommandProcessor::clipSplit(const json& p, CmdResult& r) {
    Model& m = model();
    const std::vector<uint64_t> ids = idArray(p, "clipIds");
    if (ids.empty())
        return r.fail("bad_request", "clipIds is empty");
    const double atBeat = getOr<double>(p, "atBeat", -1.0);
    const TempoMap& T = tm();

    json newIds = json::array();
    std::set<Track*> touched;
    for (uint64_t id : ids) {
        const ClipRef ref = m.clipById(id);
        if (!ref)
            return r.fail("not_found", "unknown clipId");
        Track& t = *ref.track;
        const double start = clipStartBeat(*ref.clip);
        const double end = clipEndBeat(*ref.clip, T);
        if (atBeat <= start + kMinClipBeats || atBeat >= end - kMinClipBeats)
            continue; // split point outside this clip

        if (AudioClip* a = asAudio(ref.clip)) {
            const int64_t startSample = llround(T.beatsToSamplesF(start));
            const int64_t splitSample = llround(T.beatsToSamplesF(atBeat));
            int64_t leftLen = splitSample - startSample;
            leftLen = std::max<int64_t>(1, std::min(leftLen, a->lengthSamples - 1));
            AudioClip right = *a;
            right.id = m.nextId();
            right.startBeat = T.samplesToBeats(startSample + leftLen);
            right.srcOffsetSamples = a->srcOffsetSamples + leftLen;
            right.lengthSamples = a->lengthSamples - leftLen;
            right.fadeInSec = 0.0;
            a->lengthSamples = leftLen;
            a->fadeOutSec = 0.0;
            newIds.push_back(right.id);
            r.eventClips.emplace_back(t.id, id);
            r.eventClips.emplace_back(t.id, right.id);
            t.clips.emplace_back(std::move(right)); // invalidates `a` — done with it
        } else {
            MidiClip* mc = asMidi(ref.clip);
            const double rel = atBeat - start;
            MidiClip right;
            right.id = m.nextId();
            right.name = mc->name;
            right.color = mc->color;
            right.muted = mc->muted;
            right.startBeat = atBeat;
            right.lengthBeats = mc->lengthBeats - rel;
            std::vector<Note> leftNotes;
            for (Note n : mc->notes) {
                if (n.startBeat >= rel) {
                    n.startBeat -= rel;
                    right.notes.push_back(n);
                } else {
                    if (n.startBeat + n.lengthBeats > rel)
                        n.lengthBeats = rel - n.startBeat; // crossing notes truncated
                    if (n.lengthBeats >= kMinNoteBeats)
                        leftNotes.push_back(n);
                }
            }
            mc->notes = std::move(leftNotes);
            std::vector<MidiCc> leftCc; // partition preserves (controller, beat) order
            for (MidiCc cev : mc->cc) {
                if (cev.beat >= rel) {
                    cev.beat -= rel;
                    right.cc.push_back(cev);
                } else {
                    leftCc.push_back(cev);
                }
            }
            mc->cc = std::move(leftCc);
            mc->lengthBeats = rel;
            newIds.push_back(right.id);
            r.eventClips.emplace_back(t.id, id);
            r.eventClips.emplace_back(t.id, right.id);
            t.clips.emplace_back(std::move(right)); // invalidates `mc`
        }
        touched.insert(&t);
    }
    for (Track* t : touched)
        sortClipsByStart(*t);

    if (newIds.empty()) {
        r.mutated = false;
        return json{{"newClipIds", newIds}};
    }
    r.label = "Split Clips";
    r.structural = true;
    r.scope = "clip";
    return json{{"newClipIds", newIds}};
}

json CommandProcessor::clipJoin(const json& p, CmdResult& r) {
    Model& m = model();
    std::vector<uint64_t> ids = idArray(p, "clipIds");
    if (ids.size() < 2)
        return r.fail("bad_request", "clip.join needs at least two clips");

    // All clips must exist, live on one track and share a type.
    Track* track = nullptr;
    for (uint64_t id : ids) {
        const ClipRef ref = m.clipById(id);
        if (!ref)
            return r.fail("not_found", "unknown clipId");
        if (!track)
            track = ref.track;
        else if (track != ref.track)
            return r.fail("bad_request", "clips must be on the same track");
    }
    std::sort(ids.begin(), ids.end(), [&](uint64_t a, uint64_t b) {
        return clipStartBeat(*m.clipById(a).clip) < clipStartBeat(*m.clipById(b).clip);
    });
    const ClipType type = clipType(*m.clipById(ids[0]).clip);
    for (uint64_t id : ids)
        if (clipType(*m.clipById(id).clip) != type)
            return r.fail("bad_request", "cannot join audio and midi clips");

    const TempoMap& T = tm();
    Clip merged;
    if (type == ClipType::Midi) {
        MidiClip base = *asMidi(m.clipById(ids[0]).clip);
        double maxEnd = base.startBeat + base.lengthBeats;
        for (size_t i = 1; i < ids.size(); ++i) {
            const MidiClip& other = *asMidi(m.clipById(ids[i]).clip);
            const double offset = other.startBeat - base.startBeat;
            for (Note n : other.notes) {
                n.startBeat += offset;
                base.notes.push_back(n);
            }
            for (MidiCc cev : other.cc) {
                cev.beat += offset;
                base.cc.push_back(cev);
            }
            maxEnd = std::max(maxEnd, other.startBeat + other.lengthBeats);
        }
        base.lengthBeats = maxEnd - base.startBeat;
        sortNotes(base);
        sortCc(base);
        merged = std::move(base);
    } else {
        // Audio join only when contiguous in source material AND on the timeline.
        AudioClip base = *asAudio(m.clipById(ids[0]).clip);
        const AudioClip* prev = asAudio(m.clipById(ids[0]).clip);
        for (size_t i = 1; i < ids.size(); ++i) {
            const AudioClip* cur = asAudio(m.clipById(ids[i]).clip);
            if (cur->assetId != prev->assetId)
                return r.fail("not_contiguous", "clips reference different assets");
            if (cur->srcOffsetSamples != prev->srcOffsetSamples + prev->lengthSamples)
                return r.fail("not_contiguous", "clips are not contiguous in the source");
            const int64_t prevStart = llround(T.beatsToSamplesF(prev->startBeat));
            const int64_t curStart = llround(T.beatsToSamplesF(cur->startBeat));
            if (std::llabs(curStart - (prevStart + prev->lengthSamples)) > 1)
                return r.fail("not_contiguous", "clips are not adjacent on the timeline");
            prev = cur;
        }
        const AudioClip* last = asAudio(m.clipById(ids.back()).clip);
        base.lengthSamples =
            last->srcOffsetSamples + last->lengthSamples - base.srcOffsetSamples;
        base.fadeOutSec = last->fadeOutSec;
        merged = std::move(base);
    }

    // Replace: drop every joined clip, re-insert the merged one under the first id.
    for (uint64_t id : ids) {
        Clip dropped;
        takeClip(*track, id, dropped);
        if (id != ids[0])
            r.removedClipIds.push_back(id);
    }
    const uint64_t mergedId = ids[0];
    track->clips.emplace_back(std::move(merged));
    sortClipsByStart(*track);

    r.label = "Join Clips";
    r.structural = true;
    r.scope = "clip";
    r.eventClips.emplace_back(track->id, mergedId);
    const ConstClipRef ref = static_cast<const Model&>(m).clipById(mergedId);
    return json{{"clip", toJson(*ref.clip)}};
}

json CommandProcessor::clipDelete(const json& p, CmdResult& r) {
    Model& m = model();
    const std::vector<uint64_t> ids = idArray(p, "clipIds");
    if (ids.empty())
        return r.fail("bad_request", "clipIds is empty");
    bool any = false;
    for (uint64_t id : ids) {
        const ClipRef ref = m.clipById(id);
        if (!ref)
            continue; // tolerate already-gone clips in batch deletes
        Clip dropped;
        takeClip(*ref.track, id, dropped);
        r.removedClipIds.push_back(id);
        any = true;
    }
    if (!any)
        return r.fail("not_found", "no matching clips");
    r.label = "Delete Clips";
    r.structural = true;
    r.scope = "clip";
    return json::object();
}

json CommandProcessor::clipDuplicate(const json& p, CmdResult& r) {
    Model& m = model();
    const std::vector<uint64_t> ids = idArray(p, "clipIds");
    if (ids.empty())
        return r.fail("bad_request", "clipIds is empty");
    const TempoMap& T = tm();

    json clipsOut = json::array();
    std::set<Track*> touched;
    for (uint64_t id : ids) {
        const ClipRef ref = m.clipById(id);
        if (!ref)
            return r.fail("not_found", "unknown clipId");
        Clip copy = *ref.clip;
        const double len = clipLengthBeats(*ref.clip, T);
        setClipStartBeat(copy, clipStartBeat(*ref.clip) + len); // right after original
        uint64_t newId = m.nextId();
        if (AudioClip* a = asAudio(&copy)) {
            a->id = newId;
        } else if (MidiClip* mc = asMidi(&copy)) {
            mc->id = newId;
            for (Note& n : mc->notes)
                n.id = m.nextId();
            for (MidiCc& cev : mc->cc)
                cev.id = m.nextId();
        }
        clipsOut.push_back(toJson(copy));
        r.eventClips.emplace_back(ref.track->id, newId);
        Track* t = ref.track;
        t->clips.emplace_back(std::move(copy)); // invalidates ref
        touched.insert(t);
    }
    for (Track* t : touched)
        sortClipsByStart(*t);

    r.label = "Duplicate Clips";
    r.structural = true;
    r.scope = "clip";
    return json{{"clips", clipsOut}};
}

json CommandProcessor::clipSet(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "clipId", 0);
    const ClipRef ref = m.clipById(id);
    if (!ref)
        return r.fail("not_found", "unknown clipId");
    if (!p.is_object() || !p.contains("patch") || !p["patch"].is_object())
        return r.fail("bad_request", "missing patch object");
    const json& patch = p["patch"];

    bool any = false;
    bool audible = false;
    if (hasKey(patch, "name")) {
        setClipName(*ref.clip, getOr(patch, "name", clipName(*ref.clip).c_str()));
        any = true;
    }
    if (hasKey(patch, "color")) {
        setClipColor(*ref.clip, getOr(patch, "color", clipColor(*ref.clip).c_str()));
        any = true;
    }
    if (hasKey(patch, "muted")) {
        setClipMuted(*ref.clip, getOr<bool>(patch, "muted", clipMuted(*ref.clip)));
        any = true;
        audible = true;
    }
    if (AudioClip* a = asAudio(ref.clip)) {
        if (hasKey(patch, "gain")) {
            a->gain = clampd(getOr<double>(patch, "gain", a->gain), 0.0, 8.0);
            any = true;
            audible = true;
        }
        if (hasKey(patch, "fadeInSec")) {
            a->fadeInSec = std::max(0.0, getOr<double>(patch, "fadeInSec", a->fadeInSec));
            any = true;
            audible = true;
        }
        if (hasKey(patch, "fadeOutSec")) {
            a->fadeOutSec =
                std::max(0.0, getOr<double>(patch, "fadeOutSec", a->fadeOutSec));
            any = true;
            audible = true;
        }
    }
    if (!any) {
        r.mutated = false;
        return json::object();
    }
    r.label = "Edit Clip";
    r.structural = audible; // name/color are cosmetic
    r.scope = "clip";
    r.eventClips.emplace_back(ref.track->id, id);
    return json::object();
}

// ---------------------------------------------------------------------------
// §5.3 — notes / automation / arrangement
// ---------------------------------------------------------------------------

json CommandProcessor::notesEdit(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t clipIdv = getOr<uint64_t>(p, "clipId", 0);
    const ClipRef ref = m.clipById(clipIdv);
    if (!ref)
        return r.fail("not_found", "unknown clipId");
    MidiClip* mc = asMidi(ref.clip);
    if (!mc)
        return r.fail("bad_request", "notes.edit requires a midi clip");

    bool any = false;
    if (p.is_object() && p.contains("add") && p["add"].is_array()) {
        for (const json& nj : p["add"]) {
            if (!nj.is_object())
                continue;
            Note n; // incoming ids ignored — engine assigns (negative temp ids allowed)
            n.id = m.nextId();
            n.pitch = clampi(getOr<int>(nj, "pitch", 60), 0, 127);
            n.velocity = clampi(getOr<int>(nj, "velocity", 100), 1, 127);
            n.startBeat = std::max(0.0, getOr<double>(nj, "startBeat", 0.0));
            n.lengthBeats = std::max(kMinNoteBeats, getOr<double>(nj, "lengthBeats", 1.0));
            n.channel = clampi(getOr<int>(nj, "channel", 0), 0, 15);
            mc->notes.push_back(n);
            any = true;
        }
    }
    if (p.is_object() && p.contains("remove") && p["remove"].is_array()) {
        for (const json& ij : p["remove"]) {
            if (!ij.is_number())
                continue;
            const uint64_t nid = ij.get<uint64_t>();
            for (auto it = mc->notes.begin(); it != mc->notes.end(); ++it) {
                if (it->id == nid) {
                    mc->notes.erase(it);
                    any = true;
                    break;
                }
            }
        }
    }
    if (p.is_object() && p.contains("update") && p["update"].is_array()) {
        for (const json& uj : p["update"]) {
            if (!uj.is_object())
                continue;
            const uint64_t nid = getOr<uint64_t>(uj, "noteId", 0);
            if (!hasKey(uj, "patch"))
                continue;
            const json& np = *uj.find("patch");
            for (Note& n : mc->notes) {
                if (n.id != nid)
                    continue;
                if (hasKey(np, "pitch"))
                    n.pitch = clampi(getOr<int>(np, "pitch", n.pitch), 0, 127);
                if (hasKey(np, "velocity"))
                    n.velocity = clampi(getOr<int>(np, "velocity", n.velocity), 1, 127);
                if (hasKey(np, "startBeat"))
                    n.startBeat = std::max(0.0, getOr<double>(np, "startBeat", n.startBeat));
                if (hasKey(np, "lengthBeats"))
                    n.lengthBeats =
                        std::max(kMinNoteBeats, getOr<double>(np, "lengthBeats", n.lengthBeats));
                if (hasKey(np, "channel"))
                    n.channel = clampi(getOr<int>(np, "channel", n.channel), 0, 15);
                any = true;
                break;
            }
        }
    }
    if (!any) {
        r.mutated = false;
        return json::object();
    }
    sortNotes(*mc);
    r.label = "Edit Notes"; // batch = ONE undo entry
    r.structural = true;
    r.scope = "clip";
    r.eventClips.emplace_back(ref.track->id, clipIdv);
    return json::object();
}

json CommandProcessor::notesQuantize(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t clipIdv = getOr<uint64_t>(p, "clipId", 0);
    const ClipRef ref = m.clipById(clipIdv);
    if (!ref)
        return r.fail("not_found", "unknown clipId");
    MidiClip* mc = asMidi(ref.clip);
    if (!mc)
        return r.fail("bad_request", "notes.quantize requires a midi clip");
    const double grid = getOr<double>(p, "grid", 0.0);
    if (grid <= 0.0)
        return r.fail("bad_request", "grid must be > 0");
    const double strength = clampd(getOr<double>(p, "strength", 1.0), 0.0, 1.0);
    const double swing = clampd(getOr<double>(p, "swing", 0.0), 0.0, 1.0);
    const std::vector<uint64_t> noteIds = idArray(p, "noteIds"); // empty = all

    bool any = false;
    for (Note& n : mc->notes) {
        if (!noteIds.empty() && !containsId(noteIds, n.id))
            continue;
        const double pos = n.startBeat;
        const long long slot = llround(pos / grid);
        double target = static_cast<double>(slot) * grid;
        if (slot % 2 != 0)
            target += swing * grid * 0.5; // odd slots pushed later
        n.startBeat = std::max(0.0, pos + (target - pos) * strength); // starts only
        any = true;
    }
    if (!any) {
        r.mutated = false;
        return json::object();
    }
    sortNotes(*mc);
    r.label = "Quantize Notes";
    r.structural = true;
    r.scope = "clip";
    r.eventClips.emplace_back(ref.track->id, clipIdv);
    return json::object();
}

// cmd/cc.edit {clipId, add?, remove?, update?} — batched controller-event edit, ONE undo
// entry (mirrors notes.edit). controller clamps to 0..129 (128 = pitch bend, 129 = chan
// aftertouch), value to 0..1, beat to >= 0.
json CommandProcessor::ccEdit(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t clipIdv = getOr<uint64_t>(p, "clipId", 0);
    const ClipRef ref = m.clipById(clipIdv);
    if (!ref)
        return r.fail("not_found", "unknown clipId");
    MidiClip* mc = asMidi(ref.clip);
    if (!mc)
        return r.fail("bad_request", "cc.edit requires a midi clip");

    bool any = false;
    if (p.is_object() && p.contains("add") && p["add"].is_array()) {
        for (const json& cj : p["add"]) {
            if (!cj.is_object())
                continue;
            MidiCc c; // incoming ids ignored — engine assigns
            c.id = m.nextId();
            c.controller = clampi(getOr<int>(cj, "controller", 0), 0, 129);
            c.beat = std::max(0.0, getOr<double>(cj, "beat", 0.0));
            c.value = clampd(getOr<double>(cj, "value", 0.0), 0.0, 1.0);
            mc->cc.push_back(c);
            any = true;
        }
    }
    if (p.is_object() && p.contains("remove") && p["remove"].is_array()) {
        for (const json& ij : p["remove"]) {
            if (!ij.is_number())
                continue;
            const uint64_t cid = ij.get<uint64_t>();
            for (auto it = mc->cc.begin(); it != mc->cc.end(); ++it) {
                if (it->id == cid) {
                    mc->cc.erase(it);
                    any = true;
                    break;
                }
            }
        }
    }
    if (p.is_object() && p.contains("update") && p["update"].is_array()) {
        for (const json& uj : p["update"]) {
            if (!uj.is_object())
                continue;
            const uint64_t cid = getOr<uint64_t>(uj, "ccId", 0);
            if (!hasKey(uj, "patch"))
                continue;
            const json& cp = *uj.find("patch");
            for (MidiCc& c : mc->cc) {
                if (c.id != cid)
                    continue;
                if (hasKey(cp, "beat"))
                    c.beat = std::max(0.0, getOr<double>(cp, "beat", c.beat));
                if (hasKey(cp, "value"))
                    c.value = clampd(getOr<double>(cp, "value", c.value), 0.0, 1.0);
                any = true;
                break;
            }
        }
    }
    if (!any) {
        r.mutated = false;
        return json::object();
    }
    sortCc(*mc);
    r.label = "Edit CC"; // batch = ONE undo entry
    r.structural = true;
    r.scope = "clip";
    r.eventClips.emplace_back(ref.track->id, clipIdv);
    return json::object();
}

json CommandProcessor::automationSet(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    if (!m.trackById(trackId))
        return r.fail("not_found", "unknown trackId");
    const std::string paramRef = getOr(p, "paramRef", "");
    const bool valid = paramRef == "volume" || paramRef == "pan" ||
                       startsWith(paramRef, "send:") || startsWith(paramRef, "plugin:");
    if (!valid)
        return r.fail("bad_request", "bad paramRef: " + paramRef);

    const bool laneExisted = m.automationLane(trackId, paramRef, false) != nullptr;
    AutomationLane* lane = m.automationLane(trackId, paramRef, true); // ensure (contract)

    bool anyOp = false;
    if (p.is_object() && p.contains("add") && p["add"].is_array()) {
        for (const json& aj : p["add"]) {
            if (!aj.is_object())
                continue;
            AutomationPoint pt;
            pt.id = m.nextId();
            // t/v aliases per types.ts; beat/value accepted too.
            pt.beat = std::max(0.0, hasKey(aj, "t") ? getOr<double>(aj, "t", 0.0)
                                                    : getOr<double>(aj, "beat", 0.0));
            pt.value = hasKey(aj, "v") ? getOr<double>(aj, "v", 0.0)
                                       : getOr<double>(aj, "value", 0.0);
            pt.curve = clampd(getOr<double>(aj, "curve", 0.0), -1.0, 1.0);
            lane->points.push_back(pt);
            anyOp = true;
        }
    }
    if (p.is_object() && p.contains("remove") && p["remove"].is_array()) {
        for (const json& ij : p["remove"]) {
            if (!ij.is_number())
                continue;
            const uint64_t pid = ij.get<uint64_t>();
            for (auto it = lane->points.begin(); it != lane->points.end(); ++it) {
                if (it->id == pid) {
                    lane->points.erase(it);
                    anyOp = true;
                    break;
                }
            }
        }
    }
    if (p.is_object() && p.contains("update") && p["update"].is_array()) {
        for (const json& uj : p["update"]) {
            if (!uj.is_object() || !hasKey(uj, "patch"))
                continue;
            const uint64_t pid = getOr<uint64_t>(uj, "pointId", 0);
            const json& pp = *uj.find("patch");
            for (AutomationPoint& pt : lane->points) {
                if (pt.id != pid)
                    continue;
                if (hasKey(pp, "beat"))
                    pt.beat = std::max(0.0, getOr<double>(pp, "beat", pt.beat));
                if (hasKey(pp, "value"))
                    pt.value = getOr<double>(pp, "value", pt.value);
                if (hasKey(pp, "curve"))
                    pt.curve = clampd(getOr<double>(pp, "curve", pt.curve), -1.0, 1.0);
                anyOp = true;
                break;
            }
        }
    }
    sortLanePoints(*lane);

    // Contract (§5.3): a set that leaves the lane with zero points removes the lane —
    // an emptied lane would otherwise be un-removable from the UI and serialize
    // forever. (Lanes for removed sends/plugins are pruned elsewhere; this complements
    // that.)
    const bool laneRemoved = lane->points.empty();
    if (laneRemoved) {
        Track* t = m.trackById(trackId);
        for (auto it = t->automation.begin(); it != t->automation.end(); ++it) {
            if (it->paramRef == paramRef) {
                t->automation.erase(it); // `lane` dangles past this point
                break;
            }
        }
    }

    // Mutated unless the lane's net existence and points are unchanged: an empty-op
    // call now creates-then-removes the lane (no net change); removing a legacy
    // already-empty lane IS a change.
    r.mutated = anyOp || laneExisted == laneRemoved;
    r.label = "Edit Automation";
    r.structural = r.mutated;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json::object();
}

namespace {

/** True for the paramRefs an automation lane may address (SPEC §5.3). */
bool validParamRef(const std::string& ref) {
    return ref == "volume" || ref == "pan" || startsWith(ref, "send:") || startsWith(ref, "plugin:");
}

/**
 * Beat where a 0-based bar starts, honouring every time-signature change. Mirrors
 * TempoMap::beatAtBar, recomputed from the model so commands do not need the runtime map.
 */
double beatAtBar0(const Model& m, int bar) {
    const auto& sigs = m.project.timeSigMap;
    if (sigs.empty())
        return static_cast<double>(bar) * 4.0;
    double startBeat = 0.0;
    size_t k = 0;
    for (size_t i = 1; i < sigs.size(); ++i) {
        if (sigs[i].bar > bar)
            break;
        const double bpb = static_cast<double>(sigs[i - 1].num) * 4.0 / static_cast<double>(sigs[i - 1].den);
        startBeat += static_cast<double>(sigs[i].bar - sigs[i - 1].bar) * bpb;
        k = i;
    }
    const double bpb = static_cast<double>(sigs[k].num) * 4.0 / static_cast<double>(sigs[k].den);
    return startBeat + static_cast<double>(bar - sigs[k].bar) * bpb;
}

/**
 * Resolve a musical position given as either beats or a bar number. Bars are 1-BASED
 * here — "bar 4" is what the user says and what the ruler shows, while the model counts
 * from 0. Returns false when neither key is present.
 */
bool positionOf(const Model& m, const json& p, const char* beatKey, const char* barKey,
                double& out) {
    if (hasKey(p, beatKey)) {
        out = std::max(0.0, getOr<double>(p, beatKey, 0.0));
        return true;
    }
    if (hasKey(p, barKey)) {
        const int bar1 = static_cast<int>(std::lround(getOr<double>(p, barKey, 1.0)));
        out = std::max(0.0, beatAtBar0(m, std::max(0, bar1 - 1)));
        return true;
    }
    return false;
}

/** Drop every point of `lane` inside [from, to] (inclusive). Returns how many went. */
int erasePointsInRange(AutomationLane& lane, double from, double to) {
    const size_t before = lane.points.size();
    lane.points.erase(std::remove_if(lane.points.begin(), lane.points.end(),
                                     [&](const AutomationPoint& pt) {
                                         return pt.beat >= from - 1e-9 && pt.beat <= to + 1e-9;
                                     }),
                      lane.points.end());
    return static_cast<int>(before - lane.points.size());
}

/** Remove a lane that has been left with no points (§5.3 contract). */
void dropEmptyLane(Model& m, uint64_t trackId, const std::string& paramRef) {
    Track* t = m.trackById(trackId);
    if (!t)
        return;
    for (auto it = t->automation.begin(); it != t->automation.end(); ++it) {
        if (it->paramRef == paramRef && it->points.empty()) {
            t->automation.erase(it);
            return;
        }
    }
}

} // namespace

/**
 * cmd/automation.ramp — write a value ramp over a span of musical time.
 *
 * This exists because "fade the cutoff up from bar 4 to bar 8" is one intention, and
 * expressing it as hand-placed points is where callers (agents especially) go wrong: they
 * either emit one point and expect a range fill, or emit dozens to fake a slope. Two
 * points and the engine's own interpolation ARE a ramp; `steps` is only for shapes that
 * interpolation cannot express.
 *
 * Positions may be given in beats (fromBeat/toBeat) or in 1-based bars (fromBar/toBar),
 * converted here against the real time-signature map — callers should not be re-deriving
 * bar arithmetic, and getting it wrong after a meter change is silent.
 */
json CommandProcessor::automationRamp(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    if (!m.trackById(trackId))
        return r.fail("not_found", "unknown trackId");
    const std::string paramRef = getOr(p, "paramRef", "");
    if (!validParamRef(paramRef))
        return r.fail("bad_request",
                      "bad paramRef: " + paramRef +
                          " (expected \"volume\", \"pan\", \"send:<index>\" or "
                          "\"plugin:<instanceId>:<paramId>\")");

    double fromBeat = 0.0;
    double toBeat = 0.0;
    if (!positionOf(m, p, "fromBeat", "fromBar", fromBeat))
        return r.fail("bad_request", "fromBeat or fromBar required");
    if (!positionOf(m, p, "toBeat", "toBar", toBeat))
        return r.fail("bad_request", "toBeat or toBar required");
    if (toBeat < fromBeat)
        std::swap(fromBeat, toBeat);
    if (!hasKey(p, "fromValue") || !hasKey(p, "toValue"))
        return r.fail("bad_request", "fromValue and toValue required");

    const double fromValue = getOr<double>(p, "fromValue", 0.0);
    const double toValue = getOr<double>(p, "toValue", 0.0);
    const double curve = clampd(getOr<double>(p, "curve", 0.0), -1.0, 1.0);
    const int steps = std::max(0, std::min(512, static_cast<int>(getOr<double>(p, "steps", 0.0))));
    const bool replaceRange = getOr<bool>(p, "replaceRange", true);

    AutomationLane* lane = m.automationLane(trackId, paramRef, true);
    if (replaceRange)
        erasePointsInRange(*lane, fromBeat, toBeat);

    const auto addPoint = [&](double beat, double value, double bend) {
        AutomationPoint pt;
        pt.id = m.nextId();
        pt.beat = std::max(0.0, beat);
        pt.value = value;
        pt.curve = bend;
        lane->points.push_back(pt);
    };

    if (steps <= 1 || toBeat <= fromBeat) {
        // The straight case: two points. The engine interpolates between them, so the
        // bend lives on the FIRST point.
        addPoint(fromBeat, fromValue, curve);
        if (toBeat > fromBeat)
            addPoint(toBeat, toValue, 0.0);
    } else {
        for (int i = 0; i <= steps; ++i) {
            const double f = static_cast<double>(i) / static_cast<double>(steps);
            addPoint(fromBeat + (toBeat - fromBeat) * f, fromValue + (toValue - fromValue) * f,
                     curve);
        }
    }

    sortLanePoints(*lane);
    r.mutated = true;
    r.label = "Automation Ramp";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json::object();
}

/**
 * cmd/automation.clear — remove automation from a lane, optionally only within a span.
 * Without a range the whole lane goes (which the point-by-point API could only do by
 * reading every id first).
 */
json CommandProcessor::automationClear(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    if (!m.trackById(trackId))
        return r.fail("not_found", "unknown trackId");
    const std::string paramRef = getOr(p, "paramRef", "");
    if (!validParamRef(paramRef))
        return r.fail("bad_request", "bad paramRef: " + paramRef);

    AutomationLane* lane = m.automationLane(trackId, paramRef, false);
    if (!lane) {
        r.mutated = false;
        r.label = "Clear Automation";
        return json::object();
    }

    double fromBeat = 0.0;
    double toBeat = 0.0;
    const bool hasFrom = positionOf(m, p, "fromBeat", "fromBar", fromBeat);
    const bool hasTo = positionOf(m, p, "toBeat", "toBar", toBeat);
    int removed = 0;
    if (hasFrom || hasTo) {
        if (!hasFrom)
            fromBeat = 0.0;
        if (!hasTo)
            toBeat = std::numeric_limits<double>::max();
        if (toBeat < fromBeat)
            std::swap(fromBeat, toBeat);
        removed = erasePointsInRange(*lane, fromBeat, toBeat);
    } else {
        removed = static_cast<int>(lane->points.size());
        lane->points.clear();
    }
    dropEmptyLane(m, trackId, paramRef);

    r.mutated = removed > 0;
    r.label = "Clear Automation";
    r.structural = r.mutated;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json::object();
}

json CommandProcessor::markerAdd(const json& p, CmdResult& r) {
    Model& m = model();
    Marker mk;
    mk.id = m.nextId();
    mk.beat = std::max(0.0, getOr<double>(p, "beat", 0.0));
    mk.name = getOr(p, "name", "Marker");
    mk.color = getOr(p, "color", "");
    m.project.markers.push_back(mk);
    std::stable_sort(m.project.markers.begin(), m.project.markers.end(),
                     [](const Marker& a, const Marker& b) { return a.beat < b.beat; });
    r.label = "Add Marker";
    r.fullEvent = true; // markers have no granular event shape
    return json{{"marker", toJson(mk)}};
}

json CommandProcessor::markerSet(const json& p, CmdResult& r) {
    Model& m = model();
    Marker* mk = m.markerById(getOr<uint64_t>(p, "markerId", 0));
    if (!mk)
        return r.fail("not_found", "unknown markerId");
    if (!p.is_object() || !p.contains("patch") || !p["patch"].is_object())
        return r.fail("bad_request", "missing patch object");
    const json& patch = p["patch"];
    if (hasKey(patch, "beat"))
        mk->beat = std::max(0.0, getOr<double>(patch, "beat", mk->beat));
    if (hasKey(patch, "name"))
        mk->name = getOr(patch, "name", mk->name.c_str());
    if (hasKey(patch, "color"))
        mk->color = getOr(patch, "color", mk->color.c_str());
    std::stable_sort(m.project.markers.begin(), m.project.markers.end(),
                     [](const Marker& a, const Marker& b) { return a.beat < b.beat; });
    r.label = "Edit Marker";
    r.fullEvent = true;
    return json::object();
}

json CommandProcessor::markerRemove(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "markerId", 0);
    for (size_t i = 0; i < m.project.markers.size(); ++i) {
        if (m.project.markers[i].id == id) {
            m.project.markers.erase(m.project.markers.begin() +
                                    static_cast<ptrdiff_t>(i));
            r.label = "Remove Marker";
            r.fullEvent = true;
            return json::object();
        }
    }
    return r.fail("not_found", "unknown markerId");
}

json CommandProcessor::tempoSet(const json& p, CmdResult& r) {
    Model& m = model();
    const double bpm = clampd(getOr<double>(p, "bpm", 120.0), 20.0, 400.0); // SPEC clamp
    // Back-compat single-value form: rewrites entry 0 only — later map entries
    // (cmd/tempoMap.set) are preserved.
    if (m.project.tempoMap.empty())
        m.project.tempoMap.push_back(TempoEntry{0.0, bpm});
    else
        m.project.tempoMap[0].bpm = bpm;
    if (ctx_.tempoMap)
        ctx_.tempoMap->setMap(m.project.tempoMap, m.project.timeSigMap);
    if (ctx_.transport) // loop region is stored in beats; sample window must follow tempo
        ctx_.transport->rederiveLoop(m.project.loop.startBeat, m.project.loop.endBeat);
    r.label = "Set Tempo";
    r.structural = true; // audio clip beat lengths shift; plan re-derives sample positions
    r.fullEvent = true;
    return json::object();
}

json CommandProcessor::timesigSet(const json& p, CmdResult& r) {
    Model& m = model();
    const int num = clampi(getOr<int>(p, "num", 4), 1, 32);
    const int den = getOr<int>(p, "den", 4);
    if (den != 1 && den != 2 && den != 4 && den != 8 && den != 16 && den != 32)
        return r.fail("bad_request", "den must be a power of two (1..32)");
    // Back-compat single-value form: rewrites entry 0 only (see tempoSet).
    if (m.project.timeSigMap.empty()) {
        m.project.timeSigMap.push_back(TimeSigEntry{0, num, den});
    } else {
        m.project.timeSigMap[0].num = num;
        m.project.timeSigMap[0].den = den;
    }
    if (ctx_.tempoMap)
        ctx_.tempoMap->setMap(m.project.tempoMap, m.project.timeSigMap);
    r.label = "Set Time Signature";
    r.fullEvent = true;
    return json::object();
}

// cmd/tempoMap.set {entries:[{beat,bpm}]} — replaces the whole tempo map. Validation:
// >= 1 entry, first beat == 0, beats strictly ascending; bpm clamped 20..400. Loop region
// BEATS are unchanged; the sample window is re-derived and the graph rebuilt.
json CommandProcessor::tempoMapSet(const json& p, CmdResult& r) {
    Model& m = model();
    if (!p.is_object() || !p.contains("entries") || !p["entries"].is_array())
        return r.fail("bad_request", "entries array required");
    std::vector<TempoEntry> entries;
    for (const json& ej : p["entries"]) {
        if (!ej.is_object())
            return r.fail("bad_request", "tempo entries must be objects");
        entries.push_back(TempoEntry{getOr<double>(ej, "beat", 0.0),
                                     clampd(getOr<double>(ej, "bpm", 120.0), 20.0, 400.0)});
    }
    if (entries.empty())
        return r.fail("bad_request", "tempo map needs at least one entry");
    if (entries.front().beat != 0.0)
        return r.fail("bad_request", "first tempo entry must be at beat 0");
    for (size_t i = 1; i < entries.size(); ++i)
        if (entries[i].beat <= entries[i - 1].beat)
            return r.fail("bad_request", "tempo entries must be sorted ascending by beat");

    m.project.tempoMap = std::move(entries);
    if (ctx_.tempoMap)
        ctx_.tempoMap->setMap(m.project.tempoMap, m.project.timeSigMap);
    if (ctx_.transport) // loop region is stored in beats; sample window must follow tempo
        ctx_.transport->rederiveLoop(m.project.loop.startBeat, m.project.loop.endBeat);
    r.label = "Set Tempo Map";
    r.structural = true; // sample positions of every beat-anchored object change
    r.fullEvent = true;
    return json::object();
}

// cmd/timeSigMap.set {entries:[{bar,num,den}]} — replaces the whole time-signature map.
// Validation: >= 1 entry, first bar == 0, bars strictly ascending, num clamped 1..32,
// den in {1,2,4,8,16,32}.
json CommandProcessor::timeSigMapSet(const json& p, CmdResult& r) {
    Model& m = model();
    if (!p.is_object() || !p.contains("entries") || !p["entries"].is_array())
        return r.fail("bad_request", "entries array required");
    std::vector<TimeSigEntry> entries;
    for (const json& ej : p["entries"]) {
        if (!ej.is_object())
            return r.fail("bad_request", "time-signature entries must be objects");
        const int den = getOr<int>(ej, "den", 4);
        if (den != 1 && den != 2 && den != 4 && den != 8 && den != 16 && den != 32)
            return r.fail("bad_request", "den must be a power of two (1..32)");
        entries.push_back(TimeSigEntry{getOr<int>(ej, "bar", 0),
                                       clampi(getOr<int>(ej, "num", 4), 1, 32), den});
    }
    if (entries.empty())
        return r.fail("bad_request", "time-signature map needs at least one entry");
    if (entries.front().bar != 0)
        return r.fail("bad_request", "first time-signature entry must be at bar 0");
    for (size_t i = 1; i < entries.size(); ++i)
        if (entries[i].bar <= entries[i - 1].bar)
            return r.fail("bad_request",
                          "time-signature entries must be sorted ascending by bar");

    m.project.timeSigMap = std::move(entries);
    if (ctx_.tempoMap)
        ctx_.tempoMap->setMap(m.project.tempoMap, m.project.timeSigMap);
    r.label = "Set Time Signature Map";
    r.fullEvent = true;
    return json::object();
}

json CommandProcessor::loopSet(const json& p, CmdResult& r) {
    Model& m = model();
    double start = std::max(0.0, getOr<double>(p, "startBeat", 0.0));
    double end = std::max(0.0, getOr<double>(p, "endBeat", 0.0));
    if (end < start)
        std::swap(start, end);
    const bool enabled = getOr<bool>(p, "enabled", false);
    m.project.loop.startBeat = start;
    m.project.loop.endBeat = end;
    m.project.loop.enabled = enabled && end > start;
    if (ctx_.transport)
        ctx_.transport->setLoopBeats(start, end, m.project.loop.enabled);
    r.label = "Set Loop";
    r.fullEvent = true;
    return json::object();
}

// cmd/grid.set {division?,snap?,triplet?,swing?} — patch semantics onto project.grid
// (persisted + undoable; the UI keeps an optimistic local mirror). division must be
// in (0, 128] beats (snap mode "Bar" sends beatsPerBar, e.g. 32 for 32/1); swing
// clamps to 0..1.
json CommandProcessor::gridSet(const json& p, CmdResult& r) {
    Model& m = model();
    GridSettings& g = m.project.grid;
    if (hasKey(p, "division")) {
        const double d = getOr<double>(p, "division", g.division);
        if (!(d > 0.0) || d > 128.0) // !(d>0) also rejects NaN
            return r.fail("bad_request", "division must be in (0, 128] beats");
    }

    bool any = false;
    if (hasKey(p, "division")) {
        g.division = getOr<double>(p, "division", g.division);
        any = true;
    }
    if (hasKey(p, "snap")) {
        g.snap = getOr<bool>(p, "snap", g.snap);
        any = true;
    }
    if (hasKey(p, "triplet")) {
        g.triplet = getOr<bool>(p, "triplet", g.triplet);
        any = true;
    }
    if (hasKey(p, "swing")) {
        g.swing = clampd(getOr<double>(p, "swing", g.swing), 0.0, 1.0);
        any = true;
    }
    if (!any) {
        r.mutated = false;
        return json::object();
    }
    r.label = "Set Grid";
    r.fullEvent = true; // mirror loop.set: project-level settings, no granular shape
    return json::object();
}

// ---------------------------------------------------------------------------
// §5.6 — plugins
// ---------------------------------------------------------------------------

bool CommandProcessor::createInsertNode(const PluginInstance& pi, std::string& err) {
    if (pi.format == "builtin") {
        if (!builtin_) {
            err = "built-in effects unavailable";
            return false;
        }
        return builtin_->create(pi, sampleRate_, maxBlock_, err);
    }
    if (!host_) {
        err = "plugin hosting unavailable";
        return false;
    }
    return host_->create(pi, sampleRate_, maxBlock_, err);
}

void CommandProcessor::destroyInsertNode(uint64_t instanceId) {
    if (builtin_ && builtin_->has(instanceId)) {
        builtin_->destroy(instanceId);
        return;
    }
    if (host_)
        host_->destroy(instanceId);
}

json CommandProcessor::pluginAdd(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    if (t->kind == TrackKind::Folder)
        return r.fail("bad_request", "folder tracks cannot have inserts");
    if (t->kind == TrackKind::Midi)
        return r.fail("bad_request",
                      "MIDI tracks cannot host plugins — use an Instrument or Audio track");
    // Optional `copyFrom`: clone that existing instance's settings into the new one
    // (mixer Alt+drag copy) — model fields here, the live state chunk after the node
    // exists below (mirrors trackDuplicate's per-insert cloning).
    const uint64_t copyFrom = getOr<uint64_t>(p, "copyFrom", 0);
    const PluginInstance* src = nullptr;
    if (copyFrom != 0) {
        src = m.pluginByInstanceId(copyFrom);
        if (!src)
            return r.fail("not_found", "unknown copyFrom instanceId");
    }
    const std::string uid = getOr(p, "uid", src ? src->uid : "");
    if (!ctx_.pluginRegistry)
        return r.fail("plugin_load_failed", "plugin registry unavailable");
    const PluginInfo* info = ctx_.pluginRegistry->byUid(uid);
    if (!info)
        return r.fail("unknown_plugin", "uid not in plugin registry: " + uid);
    const bool isBuiltin = info->format == "builtin";
    if (!isBuiltin && !host_)
        return r.fail("plugin_load_failed", "plugin hosting unavailable");

    PluginInstance pi;
    if (src) {
        pi = *src;            // bypass/wetDry/paramValues/sidechainSource travel with the copy
        pi.stateFile.clear(); // the copy has no saved chunk of its own yet
    }
    pi.instanceId = m.nextId();
    pi.uid = info->uid;
    pi.format = info->format;
    pi.path = info->path;
    pi.bitness = info->bitness;
    pi.name = info->name;
    if (!src) {
        pi.bypass = false;
        pi.wetDry = 1.0;
    }

    std::string err;
    if (!createInsertNode(pi, err))
        return r.fail("plugin_load_failed",
                      err.empty() ? ("failed to load " + pi.name) : err);
    if (src && !isBuiltin && host_) {
        // Clone the source's opaque state chunk: live host first, then the session orphan
        // store, then the saved plugin-states .bin (same priority as restorePluginState).
        // Built-ins need none of this — create() seeded the copied pi.paramValues.
        std::vector<uint8_t> srcChunk;
        if (!host_->getState(copyFrom, srcChunk) || srcChunk.empty()) {
            srcChunk.clear();
            if (orphanStates_) {
                const auto it = orphanStates_->find(copyFrom);
                if (it != orphanStates_->end())
                    srcChunk = it->second;
            }
            if (srcChunk.empty() && !src->stateFile.empty() && projectIO_ &&
                projectIO_->hasPath())
                readBinaryFile(pathJoin(projectIO_->projectDir(), src->stateFile), srcChunk);
        }
        if (!srcChunk.empty() && !host_->setState(pi.instanceId, srcChunk))
            Log::warn("plugin.add: state copy %llu -> %llu failed",
                      static_cast<unsigned long long>(copyFrom),
                      static_cast<unsigned long long>(pi.instanceId));
    }
    // Capture the freshly-created state so redo after undo restores it exactly (for a
    // copy this runs AFTER the state transfer, so redo restores the copied settings).
    // Built-in effects carry no opaque chunk — their params round-trip via pi.paramValues.
    std::vector<uint8_t> chunk;
    if (host_ && host_->getState(pi.instanceId, chunk) && !chunk.empty())
        r.pluginChunks[pi.instanceId] = std::move(chunk);

    int index = getOr<int>(p, "index", static_cast<int>(t->inserts.size()));
    index = clampi(index, 0, static_cast<int>(t->inserts.size()));
    t->inserts.insert(t->inserts.begin() + index, pi);

    r.label = src ? "Copy Plugin" : "Add Plugin";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json{{"instance", toJson(pi)}};
}

json CommandProcessor::pluginRemove(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    const uint64_t instanceId = getOr<uint64_t>(p, "instanceId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    int idx = -1;
    for (size_t i = 0; i < t->inserts.size(); ++i)
        if (t->inserts[i].instanceId == instanceId)
            idx = static_cast<int>(i);
    if (idx < 0)
        return r.fail("not_found", "unknown instanceId on this track");

    std::vector<uint8_t> chunk; // capture for undo restore (host plugins only)
    if (host_ && host_->getState(instanceId, chunk) && !chunk.empty())
        r.pluginChunks[instanceId] = std::move(chunk);
    destroyInsertNode(instanceId);
    t->inserts.erase(t->inserts.begin() + idx);
    erasePluginLanes(*t, instanceId);

    r.label = "Remove Plugin";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json::object();
}

json CommandProcessor::pluginMove(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    const uint64_t instanceId = getOr<uint64_t>(p, "instanceId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    int idx = -1;
    for (size_t i = 0; i < t->inserts.size(); ++i)
        if (t->inserts[i].instanceId == instanceId)
            idx = static_cast<int>(i);
    if (idx < 0)
        return r.fail("not_found", "unknown instanceId on this track");

    const uint64_t destTrackId = getOr<uint64_t>(p, "destTrackId", trackId);
    if (destTrackId != trackId) {
        // Cross-channel MOVE (mixer drag & drop): the SAME live instance changes owner —
        // no destroy/create, so its full plugin state survives by construction; the graph
        // rebuild just rewires the node into the destination chain. Here `newIndex` is the
        // INSERTION index in the destination (0..size), unlike the same-channel reorder
        // below where it addresses the post-removal list.
        Track* dest = m.trackById(destTrackId);
        if (!dest)
            return r.fail("not_found", "unknown destTrackId");
        if (dest->kind == TrackKind::Folder)
            return r.fail("bad_request", "folder tracks cannot have inserts");
        if (dest->kind == TrackKind::Midi)
            return r.fail("bad_request",
                          "MIDI tracks cannot host plugins — use an Instrument or Audio track");
        int newIndex = getOr<int>(p, "newIndex", static_cast<int>(dest->inserts.size()));
        newIndex = clampi(newIndex, 0, static_cast<int>(dest->inserts.size()));
        PluginInstance moved = std::move(t->inserts[static_cast<size_t>(idx)]);
        t->inserts.erase(t->inserts.begin() + idx);
        dest->inserts.insert(dest->inserts.begin() + newIndex, std::move(moved));
        movePluginLanes(*t, *dest, instanceId); // "plugin:<id>:*" lanes follow the insert

        r.label = "Move Plugin";
        r.structural = true;
        r.scope = "track";
        r.eventTrackIds.push_back(trackId);
        r.eventTrackIds.push_back(destTrackId);
        return json::object();
    }

    int newIndex = getOr<int>(p, "newIndex", idx);
    newIndex = clampi(newIndex, 0, static_cast<int>(t->inserts.size()) - 1);
    if (newIndex == idx) {
        r.mutated = false;
        return json::object();
    }
    PluginInstance moved = std::move(t->inserts[static_cast<size_t>(idx)]);
    t->inserts.erase(t->inserts.begin() + idx);
    t->inserts.insert(t->inserts.begin() + newIndex, std::move(moved));

    r.label = "Move Plugin";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json::object();
}

json CommandProcessor::pluginSet(const json& p, bool transient, CmdResult& r) {
    Model& m = model();
    const uint64_t instanceId = getOr<uint64_t>(p, "instanceId", 0);
    Track* owner = nullptr;
    PluginInstance* pi = m.pluginByInstanceId(instanceId, &owner);
    if (!pi)
        return r.fail("not_found", "unknown instanceId");
    if (!p.is_object() || !p.contains("patch") || !p["patch"].is_object())
        return r.fail("bad_request", "missing patch object");
    const json& patch = p["patch"];

    bool any = false;
    if (hasKey(patch, "bypass")) {
        pi->bypass = getOr<bool>(patch, "bypass", pi->bypass);
        ParamMsg msg;
        msg.target = ParamMsg::Target::PluginBypass;
        msg.instanceId = instanceId;
        msg.value = pi->bypass ? 1.0f : 0.0f;
        pushParam(msg);
        any = true;
    }
    if (hasKey(patch, "wetDry")) {
        pi->wetDry = clampd(getOr<double>(patch, "wetDry", pi->wetDry), 0.0, 1.0);
        ParamMsg msg;
        msg.target = ParamMsg::Target::WetDry;
        msg.instanceId = instanceId;
        msg.value = static_cast<float>(pi->wetDry);
        pushParam(msg);
        any = true;
    }
    if (hasKey(patch, "sidechainSource")) {
        // Routing change: which track feeds this insert's sidechain detector (0 = none).
        // Structural — the graph resolves the source track pointer and sizes its capture
        // buffer at rebuild; there is no RT param for it.
        pi->sidechainSource = getOr<uint64_t>(patch, "sidechainSource", pi->sidechainSource);
        r.structural = true;
        any = true;
    }
    if (!any) {
        r.mutated = false;
        return json::object();
    }
    (void)transient;
    r.label = "Edit Plugin";
    r.scope = "track";
    r.eventTrackIds.push_back(owner->id);
    return json::object();
}

json CommandProcessor::pluginSetParam(const json& p, bool transient, CmdResult& r) {
    Model& m = model();
    const uint64_t instanceId = getOr<uint64_t>(p, "instanceId", 0);
    Track* owner = nullptr;
    PluginInstance* pi = m.pluginByInstanceId(instanceId, &owner);
    if (!pi)
        return r.fail("not_found", "unknown instanceId");
    const uint32_t paramId = static_cast<uint32_t>(getOr<uint64_t>(p, "paramId", 0));
    const double value = clampd(getOr<double>(p, "value", 0.0), 0.0, 1.0);
    pi->paramValues[paramId] = value; // old value preserved by the undo snapshot

    ParamMsg msg;
    msg.target = ParamMsg::Target::PluginParam;
    msg.instanceId = instanceId;
    msg.index = static_cast<int>(paramId);
    msg.value = static_cast<float>(value);
    pushParam(msg);

    // Seed the live node synchronously so main-thread readers (the agent plugin_params query,
    // the generic editor) observe the new value immediately instead of waiting for the RT
    // thread to drain the param ring — which never happens while the transport is idle. This
    // mirrors restoreLiveControls()'s direct seeding; setParamRt is safe to call on these
    // nodes from the main thread.
    IInsertNode* liveNode = nullptr;
    if (pi->format == "builtin")
        liveNode = builtin_ ? builtin_->node(instanceId) : nullptr;
    else
        liveNode = host_ ? host_->node(instanceId) : nullptr;
    if (liveNode)
        liveNode->setParamRt(paramId, static_cast<float>(value));

    captureAutomation(owner->id,
                      "plugin:" + std::to_string(instanceId) + ":" + std::to_string(paramId),
                      value, transient, r);
    r.label = "Edit Plugin Parameter";
    r.scope = "track";
    r.eventTrackIds.push_back(owner->id);
    return json::object();
}

json CommandProcessor::pluginSetSample(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t instanceId = getOr<uint64_t>(p, "instanceId", 0);
    Track* owner = nullptr;
    PluginInstance* pi = m.pluginByInstanceId(instanceId, &owner);
    if (!pi)
        return r.fail("not_found", "unknown instanceId");
    if (pi->format != "builtin")
        return r.fail("bad_request", "setSample is only valid for built-in instruments");
    const uint64_t assetId = getOr<uint64_t>(p, "assetId", 0);
    if (assetId != 0 && !m.assetById(assetId))
        return r.fail("not_found", "unknown assetId");
    pi->sampleAssetId = assetId;
    if (builtin_)
        builtin_->bindSample(instanceId, assetId); // update the live node now (asset is cached)

    r.label = "Set Sampler Sample";
    r.scope = "track";
    r.structural = true; // rebuild so the plan re-binds the sample deterministically
    r.eventTrackIds.push_back(owner->id);
    return json::object();
}

json CommandProcessor::vcaAdd(const json& p, CmdResult& r) {
    Model& m = model();
    Vca v;
    v.id = m.nextId();
    v.name = getOr(p, "name", std::string("VCA ") + std::to_string(m.project.vcas.size() + 1));
    v.gain = 1.0;
    m.project.vcas.push_back(v);
    r.label = "Add VCA";
    r.fullEvent = true; // vcas ride the full project snapshot
    return json{{"vca", json{{"id", v.id}, {"name", v.name}, {"gain", v.gain}}}};
}

json CommandProcessor::vcaRemove(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "id", 0);
    auto& vs = m.project.vcas;
    const auto it = std::find_if(vs.begin(), vs.end(), [&](const Vca& v) { return v.id == id; });
    if (it == vs.end())
        return r.fail("not_found", "unknown vcaId");
    vs.erase(it);
    for (Track* t : m.allTracks(true)) // detach members + reset their live multiplier
        if (t->vcaId == id) {
            t->vcaId = 0;
            ParamMsg msg;
            msg.target = ParamMsg::Target::VcaGain;
            msg.trackId = t->id;
            msg.value = 1.0f;
            pushParam(msg);
        }
    r.label = "Remove VCA";
    r.structural = true;
    r.fullEvent = true;
    return json::object();
}

json CommandProcessor::vcaSet(const json& p, bool transient, CmdResult& r) {
    Model& m = model();
    const uint64_t id = getOr<uint64_t>(p, "id", 0);
    Vca* v = m.vcaById(id);
    if (!v)
        return r.fail("not_found", "unknown vcaId");
    const json& patch = (p.contains("patch") && p["patch"].is_object()) ? p["patch"] : p;
    if (hasKey(patch, "name"))
        v->name = getOr(patch, "name", v->name);
    if (hasKey(patch, "gain")) {
        v->gain = clampd(getOr<double>(patch, "gain", v->gain), 0.0, 8.0);
        for (Track* t : m.allTracks(true)) // live: push the multiplier to every member track
            if (t->vcaId == id) {
                ParamMsg msg;
                msg.target = ParamMsg::Target::VcaGain;
                msg.trackId = t->id;
                msg.value = static_cast<float>(v->gain);
                pushParam(msg);
            }
    }
    r.label = "Set VCA";
    r.fullEvent = !transient; // commit → snapshot (persist + UI); transient drag → optimistic
    return json::object();
}

// ---------------------------------------------------------------------------
// §5.3 comping — take folders
// ---------------------------------------------------------------------------

// cmd/take.create {trackId, clipIds[], name?} — move the listed clips off Track::clips into a
// new take folder, one lane (take) per clip. Folder span = union of the clips' ranges; the comp
// defaults to lane 0 for the whole span. Returns {folder}.
json CommandProcessor::takeCreate(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(trackId);
    if (!t || !t->canHoldClips())
        return r.fail("bad_request", "track cannot hold clips");
    const std::vector<uint64_t> ids = idArray(p, "clipIds");
    if (ids.size() < 1)
        return r.fail("bad_request", "clipIds is empty");
    const TempoMap& T = tm();

    TakeFolder folder;
    folder.id = m.nextId();
    folder.name = getOr(p, "name", std::string("Comp"));
    double sMin = 1e300, eMax = -1e300;
    int lane = 0;
    for (uint64_t id : ids) {
        const ClipRef ref = m.clipById(id);
        if (!ref || ref.track->id != trackId)
            continue; // only clips on this track
        Clip c;
        if (!takeClip(*t, id, c))
            continue;
        sMin = std::min(sMin, clipStartBeat(c));
        eMax = std::max(eMax, clipEndBeat(c, T));
        TakeLane ln;
        ln.id = m.nextId();
        ln.name = "Take " + std::to_string(++lane);
        ln.clips.push_back(std::move(c));
        folder.lanes.push_back(std::move(ln));
    }
    if (folder.lanes.empty())
        return r.fail("not_found", "no matching clips on the track");
    folder.startBeat = sMin;
    folder.endBeat = eMax;
    t->takeFolders.push_back(std::move(folder));

    r.label = "Create Take Folder";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json{{"folder", toJson(t->takeFolders.back())}};
}

// cmd/take.setComp {trackId, folderId, activeLane?|comp:[{startBeat,lane}]} — set which lane
// plays. `activeLane` selects one lane for the whole span (the common "pick this take"); `comp`
// sets explicit per-segment boundaries (the swipe-comp result). Segments are sorted ascending.
json CommandProcessor::takeSetComp(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    const uint64_t folderId = getOr<uint64_t>(p, "folderId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    TakeFolder* f = nullptr;
    for (TakeFolder& tf : t->takeFolders)
        if (tf.id == folderId) { f = &tf; break; }
    if (!f)
        return r.fail("not_found", "unknown folderId");
    const int nLanes = static_cast<int>(f->lanes.size());

    if (hasKey(p, "activeLane")) {
        int lane = getOr<int>(p, "activeLane", 0);
        if (lane < -1 || lane >= nLanes)
            return r.fail("bad_request", "activeLane out of range");
        f->comp.clear();
        f->comp.push_back(CompSegment{f->startBeat, lane});
    } else if (hasKey(p, "comp") && p.find("comp")->is_array()) {
        std::vector<CompSegment> segs;
        for (const json& sj : *p.find("comp")) {
            if (!sj.is_object())
                continue;
            int lane = getOr<int>(sj, "lane", 0);
            if (lane < -1 || lane >= nLanes)
                lane = -1; // clamp unknown lanes to a silent gap rather than reject
            segs.push_back(CompSegment{getOr<double>(sj, "startBeat", f->startBeat), lane});
        }
        std::stable_sort(segs.begin(), segs.end(),
                         [](const CompSegment& a, const CompSegment& b) {
                             return a.startBeat < b.startBeat;
                         });
        f->comp = std::move(segs);
    } else {
        return r.fail("bad_request", "expected activeLane or comp[]");
    }

    r.label = "Set Comp";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json::object();
}

// cmd/take.flatten {trackId, folderId} — bounce the current comp to plain clips on the track and
// remove the folder. Per comp segment, the selected lane's clips are copied windowed to the
// segment (sample-accurate for audio; MIDI notes kept by onset). Returns {clipIds}.
json CommandProcessor::takeFlatten(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    const uint64_t folderId = getOr<uint64_t>(p, "folderId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    size_t fi = t->takeFolders.size();
    for (size_t i = 0; i < t->takeFolders.size(); ++i)
        if (t->takeFolders[i].id == folderId) { fi = i; break; }
    if (fi == t->takeFolders.size())
        return r.fail("not_found", "unknown folderId");
    const TakeFolder folder = t->takeFolders[fi]; // copy; we mutate t->clips below
    const TempoMap& T = tm();

    // Build segment list identical to AudioGraph's comp resolution.
    struct Seg { double s, e; int lane; };
    std::vector<Seg> segs;
    if (folder.comp.empty()) {
        if (!folder.lanes.empty())
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

    json clipIds = json::array();
    for (const Seg& sg : segs) {
        if (sg.lane < 0 || sg.lane >= static_cast<int>(folder.lanes.size()))
            continue;
        for (const Clip& c : folder.lanes[static_cast<size_t>(sg.lane)].clips) {
            if (const AudioClip* a = asAudio(&c)) {
                const double cs = clipStartBeat(c), ce = clipEndBeat(c, T);
                const double ns = std::max(cs, sg.s), ne = std::min(ce, sg.e);
                if (ne <= ns)
                    continue;
                const int64_t csS = T.beatsToSamples(cs);
                const int64_t nsS = T.beatsToSamples(ns), neS = T.beatsToSamples(ne);
                AudioClip nc = *a;
                nc.id = m.nextId();
                nc.startBeat = ns;
                nc.srcOffsetSamples = a->srcOffsetSamples + (nsS - csS);
                nc.lengthSamples = neS - nsS;
                nc.fadeInSec = ns == cs ? a->fadeInSec : 0.0;
                nc.fadeOutSec = ne == ce ? a->fadeOutSec : 0.0;
                clipIds.push_back(nc.id);
                t->clips.emplace_back(std::move(nc));
            } else if (const MidiClip* mc = asMidi(&c)) {
                MidiClip nc;
                nc.id = m.nextId();
                nc.name = mc->name;
                nc.startBeat = sg.s;
                nc.lengthBeats = sg.e - sg.s;
                nc.color = mc->color;
                for (const Note& note : mc->notes) {
                    const double onB = mc->startBeat + note.startBeat;
                    if (onB < sg.s || onB >= sg.e)
                        continue;
                    Note nn = note;
                    nn.id = m.nextId();
                    nn.startBeat = onB - sg.s; // rebase to the new clip
                    if (nn.startBeat + nn.lengthBeats > nc.lengthBeats)
                        nn.lengthBeats = std::max(0.0, nc.lengthBeats - nn.startBeat);
                    nc.notes.push_back(nn);
                }
                clipIds.push_back(nc.id);
                t->clips.emplace_back(std::move(nc));
            }
        }
    }
    t->takeFolders.erase(t->takeFolders.begin() + static_cast<ptrdiff_t>(fi));
    sortClipsByStart(*t);

    r.label = "Flatten Comp";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json{{"clipIds", clipIds}};
}

// ---------------------------------------------------------------------------
// §5.3 — track versions (Cubase-style alternative playlists)
// ---------------------------------------------------------------------------
// Track::versions parks the INACTIVE versions' material; the active version's
// clips/takeFolders always stay in Track::clips/Track::takeFolders and the entry whose
// id == activeVersionId is a name-only placeholder. The graph, clip commands, recording
// and rendering never look at versions — they only ever see the active material in place.

// cmd/version.add {trackId, name?, copy?} — create a new version and switch to it. The
// first add lazily names the existing material "v1". copy=true starts the new version as
// a fresh-id deep copy of the current material; otherwise it starts empty. Returns
// {versionId, track}.
json CommandProcessor::versionAdd(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    Track* t = m.trackById(trackId);
    if (!t || !t->canHoldClips())
        return r.fail("bad_request", "track cannot hold clips");
    if (t->frozen)
        return r.fail("bad_request", "track is frozen — unfreeze it to change versions");

    if (t->versions.empty()) {
        TrackVersion v1;
        v1.id = m.nextId();
        v1.name = "v1";
        t->activeVersionId = v1.id;
        t->versions.push_back(std::move(v1));
    }

    TrackVersion fresh;
    fresh.id = m.nextId();
    fresh.name = getOr(p, "name", "");
    if (fresh.name.empty()) { // default: the lowest free "vN" (deletes leave gaps)
        int k = static_cast<int>(t->versions.size()) + 1;
        const auto taken = [&](const std::string& n) {
            for (const TrackVersion& v : t->versions)
                if (v.name == n)
                    return true;
            return false;
        };
        while (taken("v" + std::to_string(k)))
            ++k;
        fresh.name = "v" + std::to_string(k);
    }

    TrackVersion* cur = versionById(*t, t->activeVersionId);
    if (cur) { // park the current material into the active placeholder
        cur->clips = std::move(t->clips);
        cur->takeFolders = std::move(t->takeFolders);
    }
    t->clips.clear();
    t->takeFolders.clear();
    if (getOr<bool>(p, "copy", false) && cur) {
        t->clips = cur->clips;
        t->takeFolders = cur->takeFolders;
        for (Clip& c : t->clips)
            freshClipIds(m, c);
        for (TakeFolder& f : t->takeFolders)
            freshTakeFolderIds(m, f);
    }
    t->activeVersionId = fresh.id;
    t->versions.push_back(std::move(fresh));

    r.label = "New Track Version";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json{{"versionId", t->activeVersionId}, {"track", toJson(*t)}};
}

// cmd/version.switch {trackId, versionId} — park the active material and bring the target
// version's parked material into place. Same-version switch is a mutation-free no-op.
json CommandProcessor::versionSwitch(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    const uint64_t versionId = getOr<uint64_t>(p, "versionId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    if (t->frozen)
        return r.fail("bad_request", "track is frozen — unfreeze it to change versions");
    TrackVersion* target = versionById(*t, versionId);
    if (!target)
        return r.fail("not_found", "unknown versionId");
    if (versionId == t->activeVersionId) {
        r.mutated = false; // already active — no undo entry, no events
        return json{{"track", toJson(*t)}};
    }

    if (TrackVersion* cur = versionById(*t, t->activeVersionId)) {
        cur->clips = std::move(t->clips);
        cur->takeFolders = std::move(t->takeFolders);
    }
    t->clips = std::move(target->clips);
    t->takeFolders = std::move(target->takeFolders);
    target->clips.clear(); // the new active entry becomes the placeholder
    target->takeFolders.clear();
    t->activeVersionId = versionId;

    r.label = "Switch Track Version";
    r.structural = true;
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json{{"track", toJson(*t)}};
}

// cmd/version.rename {trackId, versionId, name} — model-only; allowed on frozen tracks.
json CommandProcessor::versionRename(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    const uint64_t versionId = getOr<uint64_t>(p, "versionId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    TrackVersion* v = versionById(*t, versionId);
    if (!v)
        return r.fail("not_found", "unknown versionId");
    const std::string name = getOr(p, "name", "");
    if (name.empty())
        return r.fail("bad_request", "name is empty");
    v->name = name;

    r.label = "Rename Track Version";
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json::object();
}

// cmd/version.delete {trackId, versionId} — drop a parked version (the active one must be
// switched away from first). Deleting the last inactive version disengages the feature.
// Allowed on frozen tracks: parked material is not audible.
json CommandProcessor::versionDelete(const json& p, CmdResult& r) {
    Model& m = model();
    const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
    const uint64_t versionId = getOr<uint64_t>(p, "versionId", 0);
    Track* t = m.trackById(trackId);
    if (!t)
        return r.fail("not_found", "unknown trackId");
    if (!versionById(*t, versionId))
        return r.fail("not_found", "unknown versionId");
    if (versionId == t->activeVersionId)
        return r.fail("bad_request", "cannot delete the active version — switch away first");

    t->versions.erase(std::remove_if(t->versions.begin(), t->versions.end(),
                                     [&](const TrackVersion& v) { return v.id == versionId; }),
                      t->versions.end());
    if (t->versions.size() == 1) { // only the active placeholder left — feature disengaged
        t->versions.clear();
        t->activeVersionId = 0;
    }

    r.label = "Delete Track Version";
    r.scope = "track";
    r.eventTrackIds.push_back(trackId);
    return json::object();
}

// ---------------------------------------------------------------------------
// plugins/recreate (SPEC §5.6) — resolve dormant inserts against the registry
// ---------------------------------------------------------------------------
// Reply: {results: [{instanceId, ok, error?}]}. Omitted instanceIds = recreate ALL
// unresolved (= inserts with no live host instance). Per instance: registry byUid ->
// refresh path/bitness/name -> host create -> restore state from the App orphan store
// (falling back to stateFile bytes).
//
// UNDOABLE: a successful recreate resolves the insert (pi.path set, host node spawned), so
// it pushes a normal undo entry mirroring cmd/plugin.add (snapshot before/after + the
// restored state chunk). With reconcilePlugins now liveness+identity aware, undo of a
// recreate sees the restored snapshot's DORMANT insert (path empty) + a live node and tears
// the node down (insert returns to unresolved); redo recreates it and restores state from
// the captured chunk / the KEPT orphan store. A FAILED recreate mutates nothing, so no undo
// entry is pushed for it. It does its own graph rebuild + granular projectChanged + markDirty.
//
// The orphan-state entry is KEPT after a successful restore: a live host takes priority in
// capturePluginStates, and the orphan bytes remain the durable fallback for re-save /
// Save-As-to-a-new-dir / retry / redo. setState honesty: a genuine host rejection/death
// reports ok:false and DESTROYS the half-spawned instance (insert stays dormant + retryable);
// a merely-slow setState (soundbank load) uses a generous timeout so it reports ok:true.
json CommandProcessor::recreatePlugins(const json& p, std::string& ec, std::string& em) {
    Model& m = model();
    if (!host_) {
        ec = "plugin_load_failed";
        em = "plugin hosting unavailable";
        return json();
    }
    if (!ctx_.pluginRegistry) {
        ec = "plugin_load_failed";
        em = "plugin registry unavailable";
        return json();
    }

    const bool all =
        !(p.is_object() && p.contains("instanceIds") && p["instanceIds"].is_array());
    const std::vector<uint64_t> want = idArray(p, "instanceIds");

    // Optional substitutions: [{instanceId, uid}] — recreate that insert as a DIFFERENT
    // registry plugin (fuzzy / in-spirit match picked in the recreate dialog). The saved
    // state blob carries over only within the same format: a VST2 chunk means nothing to
    // a VST3 build of the plugin or to a built-in.
    std::map<uint64_t, std::string> subs;
    if (p.is_object() && p.contains("substitutions") && p["substitutions"].is_array())
        for (const json& s : p["substitutions"])
            if (s.is_object() && s.contains("instanceId") && s.contains("uid") &&
                s["uid"].is_string())
                subs[getOr<uint64_t>(s, "instanceId", 0)] = s["uid"].get<std::string>();

    json beforeSnapshot = toJson(m.project); // undo "before" (only used if any resolve)
    std::map<uint64_t, std::vector<uint8_t>> restoredChunks; // for the undo entry / redo
    json results = json::array();
    std::set<uint64_t> seen;
    std::vector<uint64_t> eventTrackIds;
    bool any = false;

    // Attempt count for the UI's loading modal (event/pluginLoadProgress): every wanted
    // insert without a live instance — failures advance the bar too.
    int progressTotal = 0;
    {
        auto countOne = [&](const PluginInstance& pi) {
            if (!all && !containsId(want, pi.instanceId))
                return;
            if (host_->node(pi.instanceId) || (builtin_ && builtin_->has(pi.instanceId)))
                return;
            ++progressTotal;
        };
        for (Track& t : m.project.tracks)
            for (PluginInstance& pi : t.inserts)
                countOne(pi);
        for (PluginInstance& pi : m.project.masterTrack.inserts)
            countOne(pi);
    }
    int progressCurrent = 0;
    auto progress = [&](const std::string& name) {
        if (ctx_.eventBus)
            ctx_.eventBus->broadcast("event/pluginLoadProgress",
                                     json{{"current", ++progressCurrent},
                                          {"total", progressTotal},
                                          {"name", name},
                                          {"done", false}});
    };

    auto handle = [&](Track& t, PluginInstance& pi) {
        if (!all && !containsId(want, pi.instanceId))
            return;
        seen.insert(pi.instanceId);
        if (host_->node(pi.instanceId) || (builtin_ && builtin_->has(pi.instanceId))) {
            // Already live — not unresolved. Idempotent success for explicit requests.
            if (!all)
                results.push_back(json{{"instanceId", pi.instanceId}, {"ok", true}});
            return;
        }
        progress(pi.name);
        auto failOne = [&](const std::string& msg) {
            results.push_back(
                json{{"instanceId", pi.instanceId}, {"ok", false}, {"error", msg}});
        };
        const auto subIt = subs.find(pi.instanceId);
        const bool substituted =
            subIt != subs.end() && !subIt->second.empty() && subIt->second != pi.uid;
        const PluginInfo* info =
            ctx_.pluginRegistry->byUid(substituted ? subIt->second : pi.uid);
        if (!info) {
            failOne(substituted
                        ? ("substitute plugin not in registry: " + subIt->second)
                        : ("plugin not in registry: " + pi.name + " (" + pi.format +
                           " uid " + pi.uid + ") — install it or add its folder and rescan"));
            return;
        }
        if (info->blacklisted) {
            failOne("plugin is blacklisted: " + info->name +
                    (info->blacklistReason.empty() ? "" : " (" + info->blacklistReason + ")"));
            return;
        }
        PluginInstance cand = pi; // mutate the model only on success
        cand.path = info->path;
        cand.bitness = info->bitness;
        if (!info->name.empty())
            cand.name = info->name;
        if (substituted) {
            cand.uid = info->uid;
            cand.format = info->format;
            if (cand.format != pi.format) {
                // Param ids and state blobs are format-specific — the substitute starts clean.
                cand.paramValues.clear();
                cand.stateFile.clear();
            }
        }
        std::string err;
        if (!createInsertNode(cand, err)) { // routes builtin substitutes too
            failOne(err.empty() ? ("failed to load " + cand.name) : err);
            return;
        }
        // State restore: orphan store first (imported foreign state), else the saved
        // plugin-states/<id>.bin. The orphan entry is NEVER erased (durable fallback).
        // Only meaningful within the same plugin format (and never for built-ins).
        std::vector<uint8_t> chunk;
        const bool stateCompatible = cand.format != "builtin" && cand.format == pi.format;
        if (stateCompatible) {
            if (orphanStates_) {
                const auto it = orphanStates_->find(pi.instanceId);
                if (it != orphanStates_->end() && !it->second.empty())
                    chunk = it->second;
            }
            if (chunk.empty() && !pi.stateFile.empty() && projectIO_ && projectIO_->hasPath())
                readBinaryFile(pathJoin(projectIO_->projectDir(), pi.stateFile), chunk);
        }
        if (!chunk.empty()) {
            std::string serr;
            const SetStateResult sr =
                host_->setStateForRecreate(cand.instanceId, chunk, serr);
            if (sr != SetStateResult::Ok) {
                // Host rejected the state, died, or timed out: destroy the half-spawned
                // instance. For the ORIGINAL plugin the insert stays dormant + retryable
                // (do NOT commit a node whose state we cannot vouch for). For a
                // SUBSTITUTE the old state was best-effort anyway — bring it up clean.
                host_->destroy(cand.instanceId);
                if (substituted) {
                    std::string err2;
                    if (!createInsertNode(cand, err2)) {
                        failOne(err2.empty() ? ("failed to load " + cand.name) : err2);
                        return;
                    }
                    chunk.clear();
                } else if (sr == SetStateResult::Failed) {
                    failOne("failed to restore state for " + cand.name + ": " + serr);
                    return;
                } else { // TimedOutAlive: slow load exceeded even the generous timeout
                    Log::warn("plugins/recreate: setState timed out (host alive) for '%s' "
                              "(%llu) — left dormant, retry",
                              cand.name.c_str(),
                              static_cast<unsigned long long>(cand.instanceId));
                    failOne("state restore is taking too long for " + cand.name +
                            " — left dormant, try again");
                    return;
                }
            }
        }
        pi = cand; // commit the resolved insert only on a confirmed-good (or stateless) load
        if (!chunk.empty())
            restoredChunks[pi.instanceId] = std::move(chunk); // redo restores this exactly
        results.push_back(json{{"instanceId", pi.instanceId}, {"ok", true}});
        eventTrackIds.push_back(t.id);
        any = true;
    };

    for (Track& t : m.project.tracks)
        for (PluginInstance& pi : t.inserts)
            handle(t, pi);
    for (PluginInstance& pi : m.project.masterTrack.inserts)
        handle(m.project.masterTrack, pi);

    if (progressTotal > 0 && ctx_.eventBus)
        ctx_.eventBus->broadcast("event/pluginLoadProgress",
                                 json{{"current", progressTotal},
                                      {"total", progressTotal},
                                      {"name", ""},
                                      {"done", true}});

    if (!all)
        for (uint64_t id : want)
            if (!seen.count(id))
                results.push_back(json{
                    {"instanceId", id}, {"ok", false}, {"error", "unknown instanceId"}});

    if (any) {
        // Rebuild the graph to pick up the recreated nodes, push an undo entry (the model
        // changed: inserts resolved), then broadcast a granular projectChanged + mark dirty.
        rebuildGraph();
        if (ctx_.undoStack) {
            UndoEntry e;
            e.label = "Recreate Plugins";
            e.before = std::move(beforeSnapshot);
            e.after = toJson(m.project);
            e.pluginChunks = std::move(restoredChunks);
            ctx_.undoStack->push(std::move(e));
        }
        CmdResult r;
        r.scope = "track";
        r.eventTrackIds = std::move(eventTrackIds);
        broadcastChanges(r);
        markDirty();
    }
    return json{{"results", std::move(results)}};
}

// ---------------------------------------------------------------------------
// internal/recording.commit — assets + clips for a finished take, ONE undo entry
// ---------------------------------------------------------------------------

json CommandProcessor::recordingCommit(const json& p, CmdResult& r) {
    Model& m = model();
    const TempoMap& T = tm();
    const std::string pdir = projectIO_ ? projectIO_->projectDir() : std::string();

    json assetsOut = json::array();
    json clipsOut = json::array();
    bool any = false;

    if (p.is_object() && p.contains("audio") && p["audio"].is_array()) {
        for (const json& ej : p["audio"]) {
            if (!ej.is_object())
                continue;
            const uint64_t trackId = getOr<uint64_t>(ej, "trackId", 0);
            Track* t = m.trackById(trackId);
            const std::string wavPath = getOr(ej, "wavPath", "");
            const int64_t startSample = getOr<int64_t>(ej, "startSample", 0);
            const int64_t frames = getOr<int64_t>(ej, "frames", 0);
            if (!t || !t->canHoldClips() || wavPath.empty() || frames <= 0) {
                Log::warn("recording.commit: skipping invalid audio entry");
                continue;
            }
            int channels = t->channels;
            int sampleRate = m.project.sampleRate;
            readWavFormat(wavPath, channels, sampleRate); // best effort

            Asset a;
            a.id = m.nextId();
            a.file = relativizeToProject(wavPath, pdir);
            a.originalPath = "";
            a.sampleRate = sampleRate;
            a.channels = channels;
            a.lengthSamples = frames;
            m.project.assets.push_back(a);
            if (ctx_.assetStore) {
                ctx_.assetStore->loadAsync(a, std::function<void(bool)>());
                ctx_.assetStore->ensurePeaks(a);
            }

            const double startBeat = std::max(0.0, T.samplesToBeats(startSample));
            assetsOut.push_back(toJson(a));

            // Loop-record → comping: a continuous take that spans >1 loop length is sliced by
            // loop length into one lane (take) per lap, all pointing into the same recorded
            // asset at increasing source offsets, stacked at the loop start. The comp defaults
            // to the last (most recent) lap.
            const int64_t loopLen =
                m.project.loop.enabled
                    ? (T.beatsToSamples(m.project.loop.endBeat) -
                       T.beatsToSamples(m.project.loop.startBeat))
                    : 0;
            const int laps =
                loopLen > 0 ? static_cast<int>((frames + loopLen - 1) / loopLen) : 1;
            if (laps >= 2) {
                TakeFolder folder;
                folder.id = m.nextId();
                folder.name = fileStem(wavPath);
                folder.startBeat = startBeat;
                folder.endBeat = startBeat + m.project.loop.endBeat - m.project.loop.startBeat;
                for (int k = 0; k < laps; ++k) {
                    AudioClip c;
                    c.id = m.nextId();
                    c.name = "Take " + std::to_string(k + 1);
                    c.startBeat = startBeat;
                    c.assetId = a.id;
                    c.srcOffsetSamples = static_cast<int64_t>(k) * loopLen;
                    c.lengthSamples = std::min(loopLen, frames - c.srcOffsetSamples);
                    TakeLane ln;
                    ln.id = m.nextId();
                    ln.name = c.name;
                    ln.clips.push_back(std::move(c));
                    folder.lanes.push_back(std::move(ln));
                }
                folder.comp.push_back(
                    CompSegment{folder.startBeat, static_cast<int>(folder.lanes.size()) - 1});
                t->takeFolders.push_back(std::move(folder));
            } else {
                AudioClip c;
                c.id = m.nextId();
                c.name = fileStem(wavPath);
                c.startBeat = startBeat;
                c.assetId = a.id;
                c.srcOffsetSamples = 0;
                c.lengthSamples = frames;
                clipsOut.push_back(toJson(c));
                t->clips.emplace_back(std::move(c));
                sortClipsByStart(*t);
            }
            any = true;
        }
    }
    if (p.is_object() && p.contains("midi") && p["midi"].is_array()) {
        for (const json& ej : p["midi"]) {
            if (!ej.is_object())
                continue;
            const uint64_t trackId = getOr<uint64_t>(ej, "trackId", 0);
            Track* t = m.trackById(trackId);
            if (!t || !t->canHoldClips() || t->kind == TrackKind::Audio) {
                Log::warn("recording.commit: skipping invalid midi entry");
                continue;
            }
            const double startBeat = std::max(0.0, getOr<double>(ej, "startBeat", 0.0));
            const double endBeat = getOr<double>(ej, "endBeat", startBeat);

            MidiClip c;
            c.id = m.nextId();
            c.name = t->name;
            c.startBeat = startBeat;
            double maxNoteEnd = 0.0;
            if (ej.contains("notes") && ej["notes"].is_array()) {
                for (const json& nj : ej["notes"]) {
                    if (!nj.is_object())
                        continue;
                    Note n;
                    n.id = m.nextId();
                    n.pitch = clampi(getOr<int>(nj, "pitch", 60), 0, 127);
                    n.velocity = clampi(getOr<int>(nj, "velocity", 100), 1, 127);
                    n.startBeat = std::max(0.0, getOr<double>(nj, "startBeat", 0.0));
                    n.lengthBeats =
                        std::max(kMinNoteBeats, getOr<double>(nj, "lengthBeats", 0.25));
                    n.channel = clampi(getOr<int>(nj, "channel", 0), 0, 15);
                    maxNoteEnd = std::max(maxNoteEnd, n.startBeat + n.lengthBeats);
                    c.notes.push_back(n);
                }
            }
            if (ej.contains("cc") && ej["cc"].is_array()) { // optional (clip-relative beats)
                for (const json& cj : ej["cc"]) {
                    if (!cj.is_object())
                        continue;
                    MidiCc cev;
                    cev.id = m.nextId();
                    cev.controller = clampi(getOr<int>(cj, "controller", 0), 0, 129);
                    cev.beat = std::max(0.0, getOr<double>(cj, "beat", 0.0));
                    cev.value = clampd(getOr<double>(cj, "value", 0.0), 0.0, 1.0);
                    maxNoteEnd = std::max(maxNoteEnd, cev.beat);
                    c.cc.push_back(cev);
                }
            }
            c.lengthBeats = std::max({kMinClipBeats, endBeat - startBeat, maxNoteEnd});
            sortNotes(c);
            sortCc(c);
            clipsOut.push_back(toJson(c));
            t->clips.emplace_back(std::move(c));
            sortClipsByStart(*t);
            any = true;
        }
    }

    if (!any) {
        r.mutated = false;
        return json{{"assets", assetsOut}, {"clips", clipsOut}};
    }
    r.label = "Record";
    r.structural = true;
    r.fullEvent = true; // assets changed -> full snapshot
    return json{{"assets", assetsOut}, {"clips", clipsOut}};
}

// ---------------------------------------------------------------------------
// edit/undo, edit/redo
// ---------------------------------------------------------------------------

bool CommandProcessor::restorePluginState(const PluginInstance& pi, const UndoEntry* entry,
                                          std::string* error) {
    if (!host_) {
        appendRestoreError(error, "plugin host unavailable for " + pi.name);
        return false;
    }
    bool restored = true;
    std::vector<uint8_t> chunk;
    // Priority: undo-entry chunk (captured at command time) -> App orphan store (imported /
    // never-saved foreign state) -> the saved plugin-states/<id>.bin (only with a project
    // dir to resolve it against). The orphan entry is the durable session fallback (never
    // erased) and is checked regardless of hasPath() so no-path recovery still restores.
    if (entry) {
        const auto it = entry->pluginChunks.find(pi.instanceId);
        if (it != entry->pluginChunks.end() && !it->second.empty())
            chunk = it->second;
    }
    if (chunk.empty() && orphanStates_) {
        const auto it = orphanStates_->find(pi.instanceId);
        if (it != orphanStates_->end() && !it->second.empty())
            chunk = it->second;
    }
    if (chunk.empty() && !pi.stateFile.empty() && projectIO_ && projectIO_->hasPath())
        readBinaryFile(pathJoin(projectIO_->projectDir(), pi.stateFile), chunk);
    if (!chunk.empty() && !host_->setState(pi.instanceId, chunk)) {
        appendRestoreError(error, "state restore failed for " + pi.name + " (" +
                                      std::to_string(pi.instanceId) + ")");
        restored = false;
    }
    for (const auto& [paramId, value] : pi.paramValues)
        if (!host_->setParam(pi.instanceId, paramId, value)) {
            appendRestoreError(error, "parameter " + std::to_string(paramId) +
                                          " restore failed for " + pi.name + " (" +
                                          std::to_string(pi.instanceId) + ")");
            restored = false;
        }
    return restored;
}

// Reconcile every live host instance against the model an undo/redo just restored. The
// model is the source of truth: pi.path empty == DORMANT (no live host, matching App-load
// semantics in App::recreatePluginInstances); non-empty == a live host with this identity
// must exist. Without this, a dormant insert that plugins/recreate brought live (same
// instanceId, path resolved, host node spawned) would keep processing after an undo to a
// snapshot where it is dormant again — the model/host desync the adversarial review found.
bool CommandProcessor::reconcilePlugins(const std::map<uint64_t, PluginInstance>& before,
                                        const UndoEntry* entry, std::string* error) {
    if (!host_ && !builtin_)
        return true;
    bool restored = true;
    std::map<uint64_t, PluginInstance> after;
    collectInstances(model().project, after);

    // Ids gone from the model entirely (plugin/track removal undone-into): tear down.
    for (const auto& [id, pi] : before) {
        (void)pi;
        if (after.find(id) == after.end())
            destroyInsertNode(id);
    }

    for (const auto& [id, pi] : after) {
        const bool isBuiltin = pi.format == "builtin";
        // Built-in effects are never dormant; host plugins are dormant when path is empty.
        const bool desiredLive = isBuiltin || !pi.path.empty();
        const bool haveLive = isBuiltin ? (builtin_ && builtin_->has(id))
                                        : (host_ && host_->node(id) != nullptr);

        if (!desiredLive) {
            // The model says dormant, so any live node (e.g. one plugins/recreate spawned,
            // now undone) must go — otherwise buildPlan keeps wiring it while it should sleep.
            if (haveLive)
                destroyInsertNode(id);
            continue;
        }

        // Identity comparison against the before-snapshot (no host-side identity accessor):
        // a path/uid/bitness change means the live node, if any, is the WRONG plugin.
        const auto bit = before.find(id);
        const bool identityChanged =
            bit == before.end() || bit->second.path != pi.path ||
            bit->second.uid != pi.uid || bit->second.bitness != pi.bitness;

        if (haveLive && !identityChanged)
            continue; // unchanged live insert — preserve audio continuity, no churn

        if (haveLive)
            destroyInsertNode(id); // wrong identity — replace
        std::string err;
        if (!createInsertNode(pi, err)) {
            Log::error("undo/redo: failed to recreate plugin '%s' (%s)",
                       pi.name.c_str(), err.c_str());
            appendRestoreError(error, "failed to recreate " + pi.name + " (" +
                                          std::to_string(id) + "): " + err);
            restored = false;
            continue;
        }
        if (!isBuiltin && !restorePluginState(pi, entry, error))
            restored = false; // built-ins restored their params inside create()
    }
    return restored;
}

json CommandProcessor::handleUndoRedo(bool isRedo, std::string& errCode,
                                      std::string& errMsg) {
    UndoStack* us = ctx_.undoStack;
    if (!us || (isRedo ? !us->canRedo() : !us->canUndo())) {
        errCode = isRedo ? "nothing_to_redo" : "nothing_to_undo";
        errMsg = isRedo ? "nothing to redo" : "nothing to undo";
        return json();
    }
    const Project projectBefore = model().project;
    std::map<uint64_t, PluginInstance> controlsBefore;
    collectInstances(projectBefore, controlsBefore);

    // App drains ParamMsgs after all jobs in one main-loop iteration. Undo may therefore
    // be queued behind the edit it is reverting; discard those values before replacing the
    // model, then publish restored controls after the replacement.
    drainPendingParams();
    std::string label;
    const bool ok = isRedo ? us->redo(label) : us->undo(label);
    if (!ok) {
        restoreLiveControls(controlsBefore, {});
        errCode = "undo_failed";
        errMsg = "snapshot restore failed";
        return json();
    }
    std::string pluginRestoreError;
    const bool pluginsRestored =
        reconcilePlugins(controlsBefore, us->lastApplied(), &pluginRestoreError);
    const std::set<uint64_t> eqChanges =
        changedEqTracks(projectBefore, model().project);
    // Engine-derived asset facts live OUTSIDE the undo timeline: Asset.channels/
    // lengthSamples are reconciled with the decoded PCM after the async decode
    // (App::afterModelReplaced posts it), so snapshots taken during the decode window
    // still carry the import-time guesses. Re-impose the decoded values on every
    // restored model — otherwise readPeaks withholds peak payloads (declared channel
    // count disagrees with the PCM) and a save persists the stale guesses. decodedInfo
    // is a cheap map lookup; ensurePeaks re-declares the record and validates the
    // existing .pk.
    if (ctx_.assetStore) {
        for (Asset& a : model().project.assets) {
            int ch = 0;
            int64_t frames = 0;
            if (ctx_.assetStore->decodedInfo(a.id, ch, frames) &&
                (a.channels != ch || a.lengthSamples != frames)) {
                a.channels = ch;
                a.lengthSamples = frames;
                ctx_.assetStore->ensurePeaks(a);
            }
        }
    }
    syncEngineFromModel();
    restoreLiveControls(controlsBefore, eqChanges);
    markDirty();
    emitFullProjectChanged(); // undo/redo always send scope:"project", full (§5.8)
    if (!pluginsRestored) {
        errCode = isRedo ? "redo_restore_failed" : "undo_restore_failed";
        errMsg = std::string(isRedo ? "redo" : "undo") +
                 " restored the authoritative project model, but live plugin restoration "
                 "was incomplete: " + pluginRestoreError;
        return json();
    }
    return json{{"label", label}};
}

} // namespace mydaw
