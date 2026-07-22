// MyDAW — project/Serialize.cpp (E3)
// Bidirectional JSON <-> Model per SPEC §6 (project.json v1). Field names are exact.
// toJson emits canonical shapes; fromJson is tolerant: missing optional fields take the
// defaults of Model.h, unknown fields are ignored, and only structural problems
// (non-object root, unsupported formatVersion, malformed required containers) fail.

#include "project/Model.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <string>

#include "project/ModelOps.h"
#include "util/Json.h"

namespace mydaw {

// Forward decls: take-folder (de)serialization references clip helpers defined further down.
bool fromJson(const json& j, Clip& out, std::string* err);

// ---------------------------------------------------------------------------
// toJson
// ---------------------------------------------------------------------------

json toJson(const OutputTarget& o) {
    if (o.isMaster())
        return json("master");
    if (o.isNone())
        return json("none");
    return json(o.trackId);
}

json toJson(const Note& n) {
    json j = {
        {"id", n.id},
        {"pitch", n.pitch},
        {"velocity", n.velocity},
        {"startBeat", n.startBeat},
        {"lengthBeats", n.lengthBeats},
    };
    if (n.channel != 0)
        j["channel"] = n.channel;
    return j;
}

json toJson(const MidiCc& c) {
    return json{
        {"id", c.id},
        {"controller", c.controller},
        {"beat", c.beat},
        {"value", c.value},
    };
}

json toJson(const AudioClip& c) {
    json j = {
        {"id", c.id},
        {"type", "audio"},
        {"name", c.name},
        {"startBeat", c.startBeat},
        {"assetId", c.assetId},
        {"srcOffsetSamples", c.srcOffsetSamples},
        {"lengthSamples", c.lengthSamples},
        {"gain", c.gain},
        {"fadeInSec", c.fadeInSec},
        {"fadeOutSec", c.fadeOutSec},
    };
    if (c.muted)
        j["muted"] = true;
    if (!c.color.empty())
        j["color"] = c.color;
    return j;
}

json toJson(const MidiClip& c) {
    json notes = json::array();
    for (const Note& n : c.notes)
        notes.push_back(toJson(n));
    json j = {
        {"id", c.id},
        {"type", "midi"},
        {"name", c.name},
        {"startBeat", c.startBeat},
        {"lengthBeats", c.lengthBeats},
        {"notes", std::move(notes)},
    };
    if (!c.cc.empty()) { // optional in JSON ([] default)
        json cc = json::array();
        for (const MidiCc& e : c.cc)
            cc.push_back(toJson(e));
        j["cc"] = std::move(cc);
    }
    if (c.muted)
        j["muted"] = true;
    if (!c.color.empty())
        j["color"] = c.color;
    return j;
}

json toJson(const Clip& c) {
    if (const AudioClip* a = asAudio(&c))
        return toJson(*a);
    return toJson(*asMidi(&c));
}

json toJson(const PluginInstance& pi) {
    json j = {
        {"instanceId", pi.instanceId},
        {"uid", pi.uid},
        {"format", pi.format},
        {"path", pi.path},
        {"bitness", pi.bitness},
        {"name", pi.name},
        {"bypass", pi.bypass},
        {"wetDry", pi.wetDry},
    };
    if (!pi.version.empty())
        j["version"] = pi.version; // optional (SPEC §6) — omitted when unknown
    if (!pi.sourceHint.empty())
        j["sourceHint"] = pi.sourceHint; // optional import provenance — omitted when none
    if (!pi.stateFile.empty())
        j["stateFile"] = pi.stateFile;
    if (pi.sampleAssetId)
        j["sampleAssetId"] = pi.sampleAssetId; // built-in sampler's asset
    if (pi.sidechainSource)
        j["sidechainSource"] = pi.sidechainSource; // built-in compressor sidechain track
    if (!pi.paramValues.empty()) {
        json pv = json::object();
        for (const auto& [id, value] : pi.paramValues)
            pv[std::to_string(id)] = value; // decimal-string keys (SPEC §6)
        j["paramValues"] = std::move(pv);
    }
    return j;
}

json toJson(const EqBand& b) {
    return json{
        {"enabled", b.enabled},
        {"type", b.type},
        {"freqHz", b.freqHz},
        {"gainDb", b.gainDb},
        {"q", b.q},
    };
}

json toJson(const TrackEq& eq) {
    json bands = json::array();
    for (const EqBand& b : eq.bands)
        bands.push_back(toJson(b));
    return json{
        {"bypass", eq.bypass},
        {"bands", std::move(bands)},
    };
}

json toJson(const Send& s) {
    return json{
        {"destTrackId", s.destTrackId},
        {"level", s.level},
        {"pre", s.pre},
        {"enabled", s.enabled},
    };
}

json toJson(const AutomationPoint& pt) {
    json j = {
        {"id", pt.id},
        {"beat", pt.beat},
        {"value", pt.value},
    };
    if (pt.curve != 0.0)
        j["curve"] = pt.curve;
    return j;
}

json toJson(const AutomationLane& l) {
    json points = json::array();
    for (const AutomationPoint& pt : l.points)
        points.push_back(toJson(pt));
    return json{
        {"paramRef", l.paramRef},
        {"points", std::move(points)},
    };
}

json toJson(const Marker& m) {
    json j = {
        {"id", m.id},
        {"beat", m.beat},
        {"name", m.name},
    };
    if (!m.color.empty())
        j["color"] = m.color;
    return j;
}

json toJson(const Asset& a) {
    json j = {
        {"id", a.id},
        {"file", a.file},
        {"sampleRate", a.sampleRate},
        {"channels", a.channels},
        {"lengthSamples", a.lengthSamples},
    };
    if (!a.originalPath.empty())
        j["originalPath"] = a.originalPath;
    if (a.missing)
        j["missing"] = true;
    return j;
}

json toJson(const TakeFolder& f) {
    json lanes = json::array();
    for (const TakeLane& ln : f.lanes) {
        json clips = json::array();
        for (const Clip& c : ln.clips)
            clips.push_back(toJson(c));
        lanes.push_back({{"id", ln.id}, {"name", ln.name}, {"clips", std::move(clips)}});
    }
    json comp = json::array();
    for (const CompSegment& s : f.comp)
        comp.push_back({{"startBeat", s.startBeat}, {"lane", s.lane}});
    return json{{"id", f.id},
                {"name", f.name},
                {"startBeat", f.startBeat},
                {"endBeat", f.endBeat},
                {"lanes", std::move(lanes)},
                {"comp", std::move(comp)}};
}

bool fromJson(const json& j, TakeFolder& out, std::string* /*err*/) {
    if (!j.is_object())
        return false;
    out = TakeFolder{};
    out.id = getOr<uint64_t>(j, "id", 0);
    out.name = getOr(j, "name", "");
    out.startBeat = getOr<double>(j, "startBeat", 0.0);
    out.endBeat = getOr<double>(j, "endBeat", 0.0);
    if (hasKey(j, "lanes") && j.find("lanes")->is_array()) {
        for (const json& lj : *j.find("lanes")) {
            if (!lj.is_object())
                continue;
            TakeLane ln;
            ln.id = getOr<uint64_t>(lj, "id", 0);
            ln.name = getOr(lj, "name", "");
            if (hasKey(lj, "clips") && lj.find("clips")->is_array())
                for (const json& cj : *lj.find("clips")) {
                    Clip c;
                    if (fromJson(cj, c, nullptr))
                        ln.clips.push_back(std::move(c));
                }
            out.lanes.push_back(std::move(ln));
        }
    }
    if (hasKey(j, "comp") && j.find("comp")->is_array())
        for (const json& sj : *j.find("comp")) {
            if (!sj.is_object())
                continue;
            out.comp.push_back(
                CompSegment{getOr<double>(sj, "startBeat", 0.0), getOr<int>(sj, "lane", 0)});
        }
    return true;
}

json toJson(const TrackVersion& v) {
    json clips = json::array();
    for (const Clip& c : v.clips)
        clips.push_back(toJson(c));
    json folders = json::array();
    for (const TakeFolder& f : v.takeFolders)
        folders.push_back(toJson(f));
    return json{{"id", v.id},
                {"name", v.name},
                {"clips", std::move(clips)},
                {"takeFolders", std::move(folders)}};
}

bool fromJson(const json& j, TrackVersion& out, std::string* /*err*/) {
    if (!j.is_object())
        return false;
    out = TrackVersion{};
    out.id = getOr<uint64_t>(j, "id", 0);
    out.name = getOr(j, "name", "");
    if (hasKey(j, "clips") && j.find("clips")->is_array())
        for (const json& cj : *j.find("clips")) {
            Clip c;
            if (fromJson(cj, c, nullptr))
                out.clips.push_back(std::move(c));
        }
    if (hasKey(j, "takeFolders") && j.find("takeFolders")->is_array())
        for (const json& fj : *j.find("takeFolders")) {
            TakeFolder f;
            if (fromJson(fj, f, nullptr))
                out.takeFolders.push_back(std::move(f));
        }
    return true;
}

json toJson(const Track& t) {
    json inserts = json::array();
    for (const PluginInstance& pi : t.inserts)
        inserts.push_back(toJson(pi));
    json sends = json::array();
    for (const Send& s : t.sends)
        sends.push_back(toJson(s));
    json automation = json::array();
    for (const AutomationLane& l : t.automation)
        automation.push_back(toJson(l));
    json clips = json::array();
    for (const Clip& c : t.clips)
        clips.push_back(toJson(c));

    json j = {
        {"id", t.id},
        {"kind", trackKindToString(t.kind)},
        {"name", t.name},
        {"color", t.color},
        {"channels", t.channels},
        {"volume", t.volume},
        {"pan", t.pan},
        {"mute", t.mute},
        {"solo", t.solo},
        {"recordArm", t.recordArm},
        {"outputTarget", toJson(t.outputTarget)},
        {"inserts", std::move(inserts)},
        {"sends", std::move(sends)},
        {"automation", std::move(automation)},
        {"clips", std::move(clips)},
    };
    if (t.height > 0)
        j["height"] = t.height;
    if (t.parentId != 0)
        j["parentId"] = t.parentId;
    if (t.monitor)
        j["monitor"] = true;
    if (!t.inputDevice.empty())
        j["inputDevice"] = t.inputDevice;
    if (t.inputChannel >= 0)
        j["inputChannel"] = t.inputChannel;
    if (t.frozen)
        j["frozen"] = true;
    if (t.frozenAssetId != 0)
        j["frozenAssetId"] = t.frozenAssetId;
    if (t.midiTarget != 0)
        j["midiTarget"] = t.midiTarget; // kind==Midi only (SPEC §6); omitted when 0
    if (t.vcaId != 0)
        j["vcaId"] = t.vcaId; // VCA-group membership; omitted when 0
    // track.eq: omit when there are no bands and EQ is not bypassed (SPEC §6).
    if (!t.eq.bands.empty() || t.eq.bypass)
        j["eq"] = toJson(t.eq);
    if (!t.takeFolders.empty()) { // comping: omitted when the track has no take folders
        json folders = json::array();
        for (const TakeFolder& f : t.takeFolders)
            folders.push_back(toJson(f));
        j["takeFolders"] = std::move(folders);
    }
    // Track versions: omitted when the feature is not engaged (old projects and old
    // engines never see the field; an old engine loading a new project drops the
    // inactive versions but keeps playing the active material — documented one-way loss).
    if (!t.versions.empty()) {
        j["activeVersionId"] = t.activeVersionId;
        json versions = json::array();
        for (const TrackVersion& v : t.versions)
            versions.push_back(toJson(v));
        j["versions"] = std::move(versions);
    }
    return j;
}

json toJson(const Project& p) {
    json tempoMap = json::array();
    for (const TempoEntry& e : p.tempoMap)
        tempoMap.push_back(json{{"beat", e.beat}, {"bpm", e.bpm}});
    json timeSigMap = json::array();
    for (const TimeSigEntry& e : p.timeSigMap)
        timeSigMap.push_back(json{{"bar", e.bar}, {"num", e.num}, {"den", e.den}});
    json markers = json::array();
    for (const Marker& m : p.markers)
        markers.push_back(toJson(m));
    json tracks = json::array();
    for (const Track& t : p.tracks)
        tracks.push_back(toJson(t));
    json assets = json::array();
    for (const Asset& a : p.assets)
        assets.push_back(toJson(a));
    json vcas = json::array();
    for (const Vca& v : p.vcas)
        vcas.push_back(json{{"id", v.id}, {"name", v.name}, {"gain", v.gain}});
    json midiMaps = json::array();
    for (const MidiMap& mm : p.midiMaps)
        midiMaps.push_back(json{{"cc", mm.cc}, {"channel", mm.channel}, {"paramRef", mm.paramRef}});

    json j = {
        {"formatVersion", p.formatVersion},
        {"name", p.name},
        {"sampleRate", p.sampleRate},
        {"tempoMap", std::move(tempoMap)},
        {"timeSigMap", std::move(timeSigMap)},
        {"loop", json{{"startBeat", p.loop.startBeat},
                      {"endBeat", p.loop.endBeat},
                      {"enabled", p.loop.enabled}}},
        {"grid", json{{"division", p.grid.division},
                      {"snap", p.grid.snap},
                      {"triplet", p.grid.triplet},
                      {"swing", p.grid.swing}}},
        {"markers", std::move(markers)},
        {"tracks", std::move(tracks)},
        {"masterTrack", toJson(p.masterTrack)},
        {"assets", std::move(assets)},
        {"vcas", std::move(vcas)},
        {"midiMaps", std::move(midiMaps)},
        {"nextId", p.nextId},
    };
    if (!p.ui.is_null() && !(p.ui.is_object() && p.ui.empty()))
        j["ui"] = p.ui; // opaque round-trip (SPEC §6)
    return j;
}

// ---------------------------------------------------------------------------
// fromJson
// ---------------------------------------------------------------------------

namespace {
bool failWith(std::string* err, const char* msg) {
    if (err)
        *err = msg;
    return false;
}
} // namespace

bool fromJson(const json& j, OutputTarget& out, std::string* err) {
    (void)err;
    if (j.is_string()) {
        const std::string s = j.get<std::string>();
        if (s == "none")
            out = OutputTarget::none();
        else
            out = OutputTarget::master(); // "master" and anything unknown
        return true;
    }
    if (j.is_number()) {
        out = OutputTarget::track(j.get<uint64_t>());
        return true;
    }
    out = OutputTarget::master(); // tolerant default
    return true;
}

bool fromJson(const json& j, Note& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "note: not a JSON object");
    out = Note{};
    out.id = getOr<uint64_t>(j, "id", 0);
    out.pitch = getOr<int>(j, "pitch", 60);
    out.velocity = getOr<int>(j, "velocity", 100);
    out.startBeat = getOr<double>(j, "startBeat", 0.0);
    out.lengthBeats = getOr<double>(j, "lengthBeats", 1.0);
    out.channel = getOr<int>(j, "channel", 0);
    return true;
}

bool fromJson(const json& j, MidiCc& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "midiCc: not a JSON object");
    out = MidiCc{};
    out.id = getOr<uint64_t>(j, "id", 0);
    out.controller = getOr<int>(j, "controller", 0);
    out.beat = getOr<double>(j, "beat", 0.0);
    out.value = getOr<double>(j, "value", 0.0);
    return true;
}

bool fromJson(const json& j, PluginInstance& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "pluginInstance: not a JSON object");
    out = PluginInstance{};
    out.instanceId = getOr<uint64_t>(j, "instanceId", 0);
    out.uid = getOr(j, "uid", "");
    out.format = getOr(j, "format", "vst2");
    out.path = getOr(j, "path", "");
    out.bitness = getOr<int>(j, "bitness", 64);
    out.name = getOr(j, "name", "");
    out.version = getOr(j, "version", "");
    out.sourceHint = getOr(j, "sourceHint", "");
    out.bypass = getOr<bool>(j, "bypass", false);
    out.wetDry = getOr<double>(j, "wetDry", 1.0);
    out.stateFile = getOr(j, "stateFile", "");
    out.sampleAssetId = getOr<uint64_t>(j, "sampleAssetId", 0);
    out.sidechainSource = getOr<uint64_t>(j, "sidechainSource", 0);
    if (hasKey(j, "paramValues") && j.find("paramValues")->is_object()) {
        for (const auto& [key, value] : j.find("paramValues")->items()) {
            if (!value.is_number())
                continue;
            char* end = nullptr;
            const unsigned long id = std::strtoul(key.c_str(), &end, 10);
            if (end && *end == '\0')
                out.paramValues[static_cast<uint32_t>(id)] = value.get<double>();
        }
    }
    return true;
}

bool fromJson(const json& j, EqBand& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "eqBand: not a JSON object");
    out = EqBand{};
    out.enabled = getOr<bool>(j, "enabled", true);
    int type = getOr<int>(j, "type", 0);
    out.type = (type < 0 || type > 5) ? 0 : type; // contract: 0..5 else 0
    // Finiteness-checked clamps: std::clamp / ternary comparisons are NaN no-ops, so a
    // tampered project.json could otherwise inject NaN straight into the live filter state.
    const double freq = getOr<double>(j, "freqHz", 1000.0);
    out.freqHz = std::isfinite(freq) ? std::clamp(freq, 20.0, 20000.0) : 1000.0;
    const double gain = getOr<double>(j, "gainDb", 0.0);
    out.gainDb = std::isfinite(gain) ? std::clamp(gain, -24.0, 24.0) : 0.0;
    const double q = getOr<double>(j, "q", 1.0);
    out.q = std::isfinite(q) ? std::clamp(q, 0.1, 18.0) : 1.0;
    return true;
}

bool fromJson(const json& j, TrackEq& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "trackEq: not a JSON object");
    out = TrackEq{};
    out.bypass = getOr<bool>(j, "bypass", false);
    if (hasKey(j, "bands") && j.find("bands")->is_array()) {
        for (const json& bj : *j.find("bands")) {
            EqBand b;
            if (fromJson(bj, b, nullptr))
                out.bands.push_back(b);
        }
    }
    return true;
}

bool fromJson(const json& j, Send& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "send: not a JSON object");
    out = Send{};
    out.destTrackId = getOr<uint64_t>(j, "destTrackId", 0);
    out.level = getOr<double>(j, "level", 1.0);
    out.pre = getOr<bool>(j, "pre", false);
    out.enabled = getOr<bool>(j, "enabled", true);
    return true;
}

bool fromJson(const json& j, AutomationPoint& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "automationPoint: not a JSON object");
    out = AutomationPoint{};
    out.id = getOr<uint64_t>(j, "id", 0);
    out.beat = getOr<double>(j, "beat", 0.0);
    out.value = getOr<double>(j, "value", 0.0);
    out.curve = getOr<double>(j, "curve", 0.0);
    return true;
}

bool fromJson(const json& j, AutomationLane& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "automationLane: not a JSON object");
    out = AutomationLane{};
    out.paramRef = getOr(j, "paramRef", "");
    if (hasKey(j, "points") && j.find("points")->is_array()) {
        for (const json& pj : *j.find("points")) {
            AutomationPoint pt;
            if (fromJson(pj, pt, nullptr))
                out.points.push_back(pt);
        }
    }
    return true;
}

bool fromJson(const json& j, Marker& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "marker: not a JSON object");
    out = Marker{};
    out.id = getOr<uint64_t>(j, "id", 0);
    out.beat = getOr<double>(j, "beat", 0.0);
    out.name = getOr(j, "name", "");
    out.color = getOr(j, "color", "");
    return true;
}

bool fromJson(const json& j, Asset& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "asset: not a JSON object");
    out = Asset{};
    out.id = getOr<uint64_t>(j, "id", 0);
    out.file = getOr(j, "file", "");
    out.originalPath = getOr(j, "originalPath", "");
    out.sampleRate = getOr<int>(j, "sampleRate", 0);
    out.channels = getOr<int>(j, "channels", 0);
    out.lengthSamples = getOr<int64_t>(j, "lengthSamples", 0);
    out.missing = getOr<bool>(j, "missing", false);
    return true;
}

bool fromJson(const json& j, Clip& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "clip: not a JSON object");
    // Discriminated on "type"; tolerant fallback infers midi from notes/lengthBeats.
    std::string type = getOr(j, "type", "");
    if (type.empty())
        type = (hasKey(j, "notes") || hasKey(j, "lengthBeats")) ? "midi" : "audio";

    if (type == "audio") {
        AudioClip c;
        c.id = getOr<uint64_t>(j, "id", 0);
        c.name = getOr(j, "name", "");
        c.startBeat = getOr<double>(j, "startBeat", 0.0);
        c.assetId = getOr<uint64_t>(j, "assetId", 0);
        c.srcOffsetSamples = getOr<int64_t>(j, "srcOffsetSamples", 0);
        c.lengthSamples = getOr<int64_t>(j, "lengthSamples", 0);
        c.gain = getOr<double>(j, "gain", 1.0);
        c.fadeInSec = getOr<double>(j, "fadeInSec", 0.0);
        c.fadeOutSec = getOr<double>(j, "fadeOutSec", 0.0);
        c.muted = getOr<bool>(j, "muted", false);
        c.color = getOr(j, "color", "");
        out = std::move(c);
        return true;
    }
    if (type == "midi") {
        MidiClip c;
        c.id = getOr<uint64_t>(j, "id", 0);
        c.name = getOr(j, "name", "");
        c.startBeat = getOr<double>(j, "startBeat", 0.0);
        c.lengthBeats = getOr<double>(j, "lengthBeats", 4.0);
        c.muted = getOr<bool>(j, "muted", false);
        c.color = getOr(j, "color", "");
        if (hasKey(j, "notes") && j.find("notes")->is_array()) {
            for (const json& nj : *j.find("notes")) {
                Note n;
                if (fromJson(nj, n, nullptr))
                    c.notes.push_back(n);
            }
        }
        if (hasKey(j, "cc") && j.find("cc")->is_array()) { // optional, tolerant
            for (const json& cj : *j.find("cc")) {
                MidiCc e;
                if (fromJson(cj, e, nullptr))
                    c.cc.push_back(e);
            }
        }
        out = std::move(c);
        return true;
    }
    return failWith(err, "clip: unknown type");
}

bool fromJson(const json& j, Track& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "track: not a JSON object");
    out = Track{};
    out.id = getOr<uint64_t>(j, "id", 0);
    TrackKind kind = TrackKind::Audio;
    trackKindFromString(getOr(j, "kind", "audio"), kind); // unknown -> audio (tolerant)
    out.kind = kind;
    out.name = getOr(j, "name", "");
    out.color = getOr(j, "color", "");
    out.height = getOr<int>(j, "height", 0);
    out.parentId = getOr<uint64_t>(j, "parentId", 0);
    out.channels = getOr<int>(j, "channels", 2) == 1 ? 1 : 2;
    out.volume = getOr<double>(j, "volume", 1.0);
    out.pan = getOr<double>(j, "pan", 0.0);
    out.mute = getOr<bool>(j, "mute", false);
    out.solo = getOr<bool>(j, "solo", false);
    out.recordArm = getOr<bool>(j, "recordArm", false);
    out.monitor = getOr<bool>(j, "monitor", false);
    out.inputDevice = getOr(j, "inputDevice", "");
    out.inputChannel = getOr<int>(j, "inputChannel", -1);
    if (hasKey(j, "outputTarget"))
        fromJson(*j.find("outputTarget"), out.outputTarget, nullptr);
    out.frozen = getOr<bool>(j, "frozen", false);
    out.frozenAssetId = getOr<uint64_t>(j, "frozenAssetId", 0);
    out.midiTarget = getOr<uint64_t>(j, "midiTarget", 0); // validated at Project level
    out.vcaId = getOr<uint64_t>(j, "vcaId", 0);

    if (hasKey(j, "inserts") && j.find("inserts")->is_array()) {
        for (const json& ij : *j.find("inserts")) {
            PluginInstance pi;
            if (fromJson(ij, pi, nullptr))
                out.inserts.push_back(std::move(pi));
        }
    }
    if (hasKey(j, "eq") && j.find("eq")->is_object())
        fromJson(*j.find("eq"), out.eq, nullptr);
    if (hasKey(j, "sends") && j.find("sends")->is_array()) {
        for (const json& sj : *j.find("sends")) {
            Send s;
            if (fromJson(sj, s, nullptr))
                out.sends.push_back(s);
        }
    }
    if (hasKey(j, "automation") && j.find("automation")->is_array()) {
        for (const json& lj : *j.find("automation")) {
            AutomationLane l;
            if (fromJson(lj, l, nullptr))
                out.automation.push_back(std::move(l));
        }
    }
    if (hasKey(j, "clips") && j.find("clips")->is_array()) {
        for (const json& cj : *j.find("clips")) {
            Clip c;
            if (fromJson(cj, c, nullptr)) // unparseable clips skipped (tolerant load)
                out.clips.push_back(std::move(c));
        }
    }
    if (hasKey(j, "takeFolders") && j.find("takeFolders")->is_array()) {
        for (const json& fj : *j.find("takeFolders")) {
            TakeFolder f;
            if (fromJson(fj, f, nullptr))
                out.takeFolders.push_back(std::move(f));
        }
    }
    if (hasKey(j, "versions") && j.find("versions")->is_array()) {
        for (const json& vj : *j.find("versions")) {
            TrackVersion v;
            if (!fromJson(vj, v, nullptr))
                continue;
            if (v.id == 0)
                continue; // ids are load-bearing (switch/delete address by id)
            bool dup = false;
            for (const TrackVersion& ex : out.versions)
                if (ex.id == v.id) {
                    dup = true; // keep the first — a duplicate id would make
                    break;      // versionDelete erase BOTH entries
                }
            if (dup)
                continue;
            out.versions.push_back(std::move(v));
        }
        out.activeVersionId = getOr<uint64_t>(j, "activeVersionId", 0);
        // Invariant repair (tolerant load): the active entry must exist and be a
        // name-only placeholder — its material lives in Track::clips/takeFolders.
        if (out.versions.empty()) {
            out.activeVersionId = 0; // zero valid entries parsed — feature disengaged
        } else {
            auto active =
                std::find_if(out.versions.begin(), out.versions.end(),
                             [&](const TrackVersion& v) { return v.id == out.activeVersionId; });
            if (active == out.versions.end()) {
                // Corrupt/hand-edited id: synthesize a placeholder for the in-place
                // material instead of clearing a PARKED version (never drop data).
                TrackVersion ph;
                for (const TrackVersion& v : out.versions)
                    ph.id = std::max(ph.id, v.id);
                ph.id += 1; // unique within the track; scanTrackIds keeps nextId above it
                ph.name = "v?";
                out.activeVersionId = ph.id;
                out.versions.push_back(std::move(ph));
            } else {
                active->clips.clear();
                active->takeFolders.clear();
            }
        }
    }
    return true;
}

bool fromJson(const json& j, Project& out, std::string* err) {
    if (!j.is_object())
        return failWith(err, "project: not a JSON object");
    const int fv = getOr<int>(j, "formatVersion", 1);
    if (fv > 1)
        return failWith(err, "project: unsupported formatVersion (newer than this engine)");

    Project p;
    p.formatVersion = 1;
    p.name = getOr(j, "name", "Untitled");
    p.sampleRate = getOr<int>(j, "sampleRate", 48000);
    if (p.sampleRate <= 0)
        p.sampleRate = 48000;

    if (hasKey(j, "tempoMap") && j.find("tempoMap")->is_array()) {
        for (const json& ej : *j.find("tempoMap")) {
            if (!ej.is_object())
                continue;
            p.tempoMap.push_back(TempoEntry{getOr<double>(ej, "beat", 0.0),
                                            getOr<double>(ej, "bpm", 120.0)});
        }
    }
    if (p.tempoMap.empty())
        p.tempoMap.push_back(TempoEntry{0.0, 120.0});

    if (hasKey(j, "timeSigMap") && j.find("timeSigMap")->is_array()) {
        for (const json& ej : *j.find("timeSigMap")) {
            if (!ej.is_object())
                continue;
            p.timeSigMap.push_back(TimeSigEntry{getOr<int>(ej, "bar", 0),
                                                getOr<int>(ej, "num", 4),
                                                getOr<int>(ej, "den", 4)});
        }
    }
    if (p.timeSigMap.empty())
        p.timeSigMap.push_back(TimeSigEntry{0, 4, 4});

    if (hasKey(j, "loop")) {
        const json& lj = *j.find("loop");
        p.loop.startBeat = getOr<double>(lj, "startBeat", 0.0);
        p.loop.endBeat = getOr<double>(lj, "endBeat", 8.0);
        p.loop.enabled = getOr<bool>(lj, "enabled", false);
    }
    if (hasKey(j, "grid")) {
        const json& gj = *j.find("grid");
        p.grid.division = getOr<double>(gj, "division", 0.25);
        p.grid.snap = getOr<bool>(gj, "snap", true);
        p.grid.triplet = getOr<bool>(gj, "triplet", false);
        p.grid.swing = getOr<double>(gj, "swing", 0.0);
    }
    if (hasKey(j, "markers") && j.find("markers")->is_array()) {
        for (const json& mj : *j.find("markers")) {
            Marker m;
            if (fromJson(mj, m, nullptr))
                p.markers.push_back(std::move(m));
        }
    }
    if (hasKey(j, "tracks")) {
        const json& tj = *j.find("tracks");
        if (!tj.is_array())
            return failWith(err, "project: tracks is not an array");
        for (const json& t : tj) {
            Track track;
            std::string terr;
            if (!fromJson(t, track, &terr))
                return failWith(err, "project: malformed track entry");
            p.tracks.push_back(std::move(track));
        }
    }
    if (hasKey(j, "masterTrack")) {
        if (!fromJson(*j.find("masterTrack"), p.masterTrack, nullptr))
            return failWith(err, "project: malformed masterTrack");
        p.masterTrack.kind = TrackKind::Master;
    } else {
        p.masterTrack = Model::defaultProject().masterTrack;
    }
    if (hasKey(j, "assets") && j.find("assets")->is_array()) {
        for (const json& aj : *j.find("assets")) {
            Asset a;
            if (fromJson(aj, a, nullptr))
                p.assets.push_back(std::move(a));
        }
    }
    if (hasKey(j, "vcas") && j.find("vcas")->is_array()) {
        for (const json& vj : *j.find("vcas")) {
            if (!vj.is_object())
                continue;
            Vca v;
            v.id = getOr<uint64_t>(vj, "id", 0);
            v.name = getOr(vj, "name", "");
            v.gain = std::clamp(getOr<double>(vj, "gain", 1.0), 0.0, 8.0);
            if (v.id != 0)
                p.vcas.push_back(std::move(v));
        }
    }
    if (hasKey(j, "midiMaps") && j.find("midiMaps")->is_array()) {
        for (const json& mj : *j.find("midiMaps")) {
            if (!mj.is_object())
                continue;
            MidiMap mm;
            mm.cc = getOr<int>(mj, "cc", -1);
            mm.channel = getOr<int>(mj, "channel", -1);
            mm.paramRef = getOr(mj, "paramRef", "");
            if (mm.cc >= 0 && !mm.paramRef.empty())
                p.midiMaps.push_back(std::move(mm));
        }
    }
    p.nextId = getOr<uint64_t>(j, "nextId", 1);
    if (hasKey(j, "ui"))
        p.ui = *j.find("ui");
    else
        p.ui = json::object();

    // Fixups: midiTarget is meaningful only on midi tracks and must reference an
    // existing instrument track — anything else is cleared (defensive load; the graph
    // would only degrade it to "unrouted" with a warning anyway).
    for (Track& t : p.tracks) {
        if (t.midiTarget == 0)
            continue;
        const Track* tgt = nullptr;
        for (const Track& x : p.tracks)
            if (x.id == t.midiTarget) {
                tgt = &x;
                break;
            }
        if (t.kind != TrackKind::Midi || !tgt || tgt->kind != TrackKind::Instrument)
            t.midiTarget = 0;
    }

    // Fixups: master must have a valid id; nextId must exceed every referenced id.
    const uint64_t maxId = maxIdInProject(p);
    if (p.masterTrack.id == 0)
        p.masterTrack.id = maxId + 1;
    if (p.nextId <= maxIdInProject(p))
        p.nextId = maxIdInProject(p) + 1;

    out = std::move(p);
    return true;
}

} // namespace mydaw
