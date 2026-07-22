// MyDAW — project/Model.h
// The COMPLETE authoritative data model, mirroring SPEC §6 (project.json v1) exactly.
// Pure data + lookup/validation helpers — no engine dependencies. All helpers are inline;
// Model.cpp (E3) may add command-level logic, and serialization (toJson/fromJson, declared
// at the bottom) is implemented by E3 in project/Serialize.cpp.
//
// Conventions (SPEC §4): ids are uint64, monotonically increasing per project via
// Model::nextId(); 0 is the "no id" sentinel (never allocated). Musical positions are
// double beats (quarter notes); audio offsets are int64 samples.

#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <variant>
#include <vector>

#include "core/TempoMap.h" // TempoEntry, TimeSigEntry (shared with the tempo engine)
#include "util/Json.h"

namespace mydaw {

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

enum class TrackKind { Audio, Midi, Instrument, Folder, Bus, Master };
enum class ClipType { Audio, Midi };

inline const char* trackKindToString(TrackKind k) {
    switch (k) {
        case TrackKind::Audio:      return "audio";
        case TrackKind::Midi:       return "midi";
        case TrackKind::Instrument: return "instrument";
        case TrackKind::Folder:     return "folder";
        case TrackKind::Bus:        return "bus";
        case TrackKind::Master:     return "master";
    }
    return "audio";
}

inline bool trackKindFromString(const std::string& s, TrackKind& out) {
    if (s == "audio")      { out = TrackKind::Audio; return true; }
    if (s == "midi")       { out = TrackKind::Midi; return true; }
    if (s == "instrument") { out = TrackKind::Instrument; return true; }
    if (s == "folder")     { out = TrackKind::Folder; return true; }
    if (s == "bus")        { out = TrackKind::Bus; return true; }
    if (s == "master")     { out = TrackKind::Master; return true; }
    return false;
}

// ---------------------------------------------------------------------------
// Leaf structs (field names match project.json keys, SPEC §6)
// ---------------------------------------------------------------------------

// MidiClip note. startBeat is relative to the clip start.
struct Note {
    uint64_t id = 0;
    int pitch = 60;        // 0..127
    int velocity = 100;    // 1..127
    double startBeat = 0.0;
    double lengthBeats = 1.0;
    int channel = 0;       // optional in JSON, default 0
};

// MidiClip controller event. beat is CLIP-RELATIVE; value is normalized 0..1 (CC sent as
// round(value*127)). controller: 0..127 = MIDI CC number; 128 = pitch bend (value 0..1,
// 0.5 = center, sent as 14-bit); 129 = channel aftertouch.
struct MidiCc {
    uint64_t id = 0;
    int controller = 0;
    double beat = 0.0;
    double value = 0.0;
};

struct AutomationPoint {
    uint64_t id = 0;
    double beat = 0.0;
    double value = 0.0;
    double curve = 0.0; // optional, -1..1 bend (SPEC §7: v = lerp^(2^curve))
};

// paramRef grammar (SPEC §5.3): "volume" | "pan" | "send:<index>" | "plugin:<instanceId>:<paramId>"
struct AutomationLane {
    std::string paramRef;
    std::vector<AutomationPoint> points; // kept sorted by beat
};

struct Send {
    uint64_t destTrackId = 0; // must reference a bus track
    double level = 1.0;       // linear
    bool pre = false;         // pre-fader tap
    bool enabled = true;
};

struct Marker {
    uint64_t id = 0;
    double beat = 0.0;
    std::string name;
    std::string color; // optional, "" = default
};

struct Asset {
    uint64_t id = 0;
    std::string file;         // project-folder-relative, e.g. "audio/rec-1.wav"
    std::string originalPath; // optional absolute import source, "" = none
    int sampleRate = 0;       // post-import (== session SR per SPEC §4 resample policy)
    int channels = 0;
    int64_t lengthSamples = 0;
    bool missing = false;     // optional in JSON (only serialized when true)
};

// VCA group: a control-only fader whose linear gain multiplies the fader of every track whose
// vcaId == this id. Not in the audio path (unlike a bus) — members keep their own routing.
struct Vca {
    uint64_t id = 0;
    std::string name;
    double gain = 1.0; // linear, 1 = 0 dB
};

// Hardware control-surface mapping: a MIDI CC controls a param (SPEC §5.2). paramRef grammar:
//   "track:<trackId>:volume" | "track:<trackId>:pan" | "plugin:<instanceId>:<paramId>".
struct MidiMap {
    int cc = 0;
    int channel = -1; // -1 = any channel
    std::string paramRef;
};

// Parametric EQ band (pinned cross-module contract). type enum:
//   0=peak(bell) 1=lowShelf 2=highShelf 3=highCut(lowpass) 4=lowCut(highpass) 5=notch.
// Ranges: freqHz 20..20000, gainDb -24..+24 (ignored for cut/notch), q 0.1..18.
struct EqBand {
    bool enabled = true;
    int type = 0;          // 0..5 (see enum above)
    double freqHz = 1000.0;
    double gainDb = 0.0;
    double q = 1.0;
};

// Per-track EQ chain. Empty bands OR bypass=true => no processing (default: no EQ).
struct TrackEq {
    bool bypass = false;
    std::vector<EqBand> bands;

    bool isActive() const { return !bypass && !bands.empty(); }
};

struct PluginInstance {
    uint64_t instanceId = 0;
    std::string uid;     // vst2: decimal uniqueID string; vst3: class GUID string (§5.6)
    std::string format;  // "vst2" | "vst3"
    std::string path;
    int bitness = 64;    // 32 | 64
    std::string name;
    std::string version; // optional plugin version string (e.g. from import); "" = unknown
    // Optional provenance of an imported (dormant) insert, for the Recreate dialog —
    // e.g. "Cubase 5.1.1 project, 2009; 32-bit era". "" = none. Serialized as
    // "sourceHint" in project.json; surfaced as "source" by project/getUnresolvedPlugins.
    std::string sourceHint;
    bool bypass = false;
    double wetDry = 1.0; // engine-side mix, 0..1 (1 = fully wet)
    std::string stateFile; // optional: "plugin-states/<instanceId>.bin", "" = none
    // optional {[paramId]: number}; keys serialize as decimal strings (JSON object keys).
    std::map<uint32_t, double> paramValues;
    // built-in sampler: the asset whose PCM it plays (0 = none). The asset lives in
    // project.assets so it is copied into the project on save (survives reload).
    uint64_t sampleAssetId = 0;
    // built-in compressor sidechain: the track whose pre-fader signal drives the detector
    // (0 = none/self). Structural (re-wires the graph). Detector reads the source's previous
    // block when it renders after this insert's track (≤1 block latency — fine for detection).
    uint64_t sidechainSource = 0;
};

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

struct AudioClip {
    uint64_t id = 0;
    // type: "audio" (implied by alternative)
    std::string name;
    double startBeat = 0.0;
    uint64_t assetId = 0;
    int64_t srcOffsetSamples = 0;
    int64_t lengthSamples = 0;
    double gain = 1.0; // linear
    double fadeInSec = 0.0;
    double fadeOutSec = 0.0;
    bool muted = false;  // optional in JSON
    std::string color;   // optional, "" = inherit track color
};

struct MidiClip {
    uint64_t id = 0;
    // type: "midi" (implied by alternative)
    std::string name;
    double startBeat = 0.0;
    double lengthBeats = 4.0;
    bool muted = false;
    std::string color;
    std::vector<Note> notes; // kept sorted by startBeat (helpers don't enforce; E3 does)
    std::vector<MidiCc> cc;  // kept sorted by (controller, beat)
};

// Track.clips element: ordered (AudioClip|MidiClip)[] per SPEC §6.
using Clip = std::variant<AudioClip, MidiClip>;

// --- Clip accessors (visit-free hot helpers) -------------------------------
inline ClipType clipType(const Clip& c) {
    return std::holds_alternative<AudioClip>(c) ? ClipType::Audio : ClipType::Midi;
}
inline AudioClip* asAudio(Clip* c) { return c ? std::get_if<AudioClip>(c) : nullptr; }
inline const AudioClip* asAudio(const Clip* c) { return c ? std::get_if<AudioClip>(c) : nullptr; }
inline MidiClip* asMidi(Clip* c) { return c ? std::get_if<MidiClip>(c) : nullptr; }
inline const MidiClip* asMidi(const Clip* c) { return c ? std::get_if<MidiClip>(c) : nullptr; }

inline uint64_t clipId(const Clip& c) {
    return std::visit([](const auto& v) { return v.id; }, c);
}
inline double clipStartBeat(const Clip& c) {
    return std::visit([](const auto& v) { return v.startBeat; }, c);
}
inline void setClipStartBeat(Clip& c, double beat) {
    std::visit([beat](auto& v) { v.startBeat = beat; }, c);
}
inline const std::string& clipName(const Clip& c) {
    return std::visit([](const auto& v) -> const std::string& { return v.name; }, c);
}
inline void setClipName(Clip& c, std::string name) {
    std::visit([&name](auto& v) { v.name = std::move(name); }, c);
}
inline bool clipMuted(const Clip& c) {
    return std::visit([](const auto& v) { return v.muted; }, c);
}
inline void setClipMuted(Clip& c, bool m) {
    std::visit([m](auto& v) { v.muted = m; }, c);
}
inline const std::string& clipColor(const Clip& c) {
    return std::visit([](const auto& v) -> const std::string& { return v.color; }, c);
}
inline void setClipColor(Clip& c, std::string color) {
    std::visit([&color](auto& v) { v.color = std::move(color); }, c);
}

// ---------------------------------------------------------------------------
// Take folders / comping (SPEC §6 Comping)
// ---------------------------------------------------------------------------
// A take folder holds alternative recordings ("takes") of the same passage stacked in lanes,
// plus a comp: an ordered list of segments that each select one lane to play. Loop-recording
// appends one lane per lap. Playback (AudioGraph::buildPlan) emits, per comp segment, only the
// selected lane's material clipped to the segment window — non-selected lanes stay silent.
struct TakeLane {
    uint64_t id = 0;
    std::string name;        // "Take 1", "Take 2", …
    std::vector<Clip> clips; // this take's material (audio or midi); loop-record: one clip per lap
};

struct CompSegment {
    double startBeat = 0.0;  // plays from here until the next segment's startBeat (or folder end)
    int lane = 0;            // index into TakeFolder::lanes; -1 = silent gap
};

struct TakeFolder {
    uint64_t id = 0;
    std::string name;
    double startBeat = 0.0;  // folder span on the timeline
    double endBeat = 0.0;
    std::vector<TakeLane> lanes;
    // Sorted ascending by startBeat. Empty ⇒ lane 0 for the whole span. The first segment's
    // startBeat is treated as the folder start regardless of its stored value.
    std::vector<CompSegment> comp;
};

// The lane selected for `beat` given a folder's comp (‑1 = silent/none, or out of span).
inline int compLaneAt(const TakeFolder& f, double beat) {
    if (beat < f.startBeat || beat >= f.endBeat) return -1;
    if (f.comp.empty()) return f.lanes.empty() ? -1 : 0;
    int lane = f.comp.front().lane; // covers [start, first boundary)
    for (const CompSegment& s : f.comp)
        if (beat >= s.startBeat) lane = s.lane; else break;
    return lane;
}

// ---------------------------------------------------------------------------
// Track versions (Cubase-style): alternative clip sets for one track, exactly one
// active. CLIPS-IN-PLACE representation: the ACTIVE version's material lives in
// Track::clips/takeFolders (so playback, clip commands, recording and the UI need
// no indirection); INACTIVE versions park their material here. The entry whose id
// equals Track::activeVersionId is a NAME-ONLY placeholder (empty arrays) — its
// content IS the track's live clips. versions.empty() = feature not engaged.
// Parked clips keep their project-unique ids but are unaddressable by clipById —
// inactive material is deliberately uneditable.
// ---------------------------------------------------------------------------

struct TrackVersion {
    uint64_t id = 0;
    std::string name;
    std::vector<Clip> clips;             // empty on the active placeholder
    std::vector<TakeFolder> takeFolders; // empty on the active placeholder
};

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

// Track.outputTarget JSON value is number | "master" | "none" (SPEC §5.2/§6).
struct OutputTarget {
    enum class Kind { Master, None, Track };
    Kind kind = Kind::Master;
    uint64_t trackId = 0; // valid when kind == Track (must be a bus)

    static OutputTarget master() { return OutputTarget{Kind::Master, 0}; }
    static OutputTarget none() { return OutputTarget{Kind::None, 0}; }
    static OutputTarget track(uint64_t id) { return OutputTarget{Kind::Track, id}; }

    bool isMaster() const { return kind == Kind::Master; }
    bool isNone() const { return kind == Kind::None; }
    bool isTrack() const { return kind == Kind::Track; }
    bool operator==(const OutputTarget& o) const {
        return kind == o.kind && (kind != Kind::Track || trackId == o.trackId);
    }
};

struct Track {
    uint64_t id = 0;
    TrackKind kind = TrackKind::Audio;
    std::string name;
    std::string color;
    int height = 0;        // optional UI px, 0 = default
    uint64_t parentId = 0; // folder track id, 0 = root (optional in JSON)
    int channels = 2;      // 1 | 2

    double volume = 1.0;   // linear, 1 = 0 dB
    double pan = 0.0;      // -1..1
    bool mute = false;
    bool solo = false;
    bool recordArm = false;
    bool monitor = false;          // optional
    std::string inputDevice;       // optional capture device id, "" = none/default
    int inputChannel = -1;         // optional, -1 = unset
    OutputTarget outputTarget = OutputTarget::master();

    bool frozen = false;           // optional
    uint64_t frozenAssetId = 0;    // optional, 0 = none

    // Meaningful ONLY on kind==Midi: route this track's MIDI into the Instrument-kind
    // track with this id (one shared instrument instance can serve several MIDI tracks,
    // SPEC §5.2/§6). 0 = none — the track plays through its own inserts. Instrument
    // tracks never carry a midiTarget, so routing cycles are impossible by construction.
    uint64_t midiTarget = 0;

    // VCA group membership (0 = none). The VCA's gain multiplies this track's fader.
    uint64_t vcaId = 0;

    std::vector<PluginInstance> inserts;
    TrackEq eq;            // per-track channel EQ (default empty/inactive)
    std::vector<Send> sends;
    std::vector<AutomationLane> automation;
    std::vector<Clip> clips;
    std::vector<TakeFolder> takeFolders; // comping: stacked takes + per-segment comp selection
    // Track versions (see TrackVersion above): empty vector = feature not engaged.
    std::vector<TrackVersion> versions;
    uint64_t activeVersionId = 0;

    bool isBusLike() const { return kind == TrackKind::Bus || kind == TrackKind::Master; }
    bool canHoldClips() const {
        return kind == TrackKind::Audio || kind == TrackKind::Midi ||
               kind == TrackKind::Instrument;
    }
};

// ---------------------------------------------------------------------------
// Project root
// ---------------------------------------------------------------------------

struct LoopRegion {
    double startBeat = 0.0;
    double endBeat = 8.0;
    bool enabled = false;
};

struct GridSettings { // project.json "grid"
    double division = 0.25; // beats (default 1/16th)
    bool snap = true;
    bool triplet = false;
    double swing = 0.0; // 0..1
};

struct Project {
    int formatVersion = 1;
    std::string name = "Untitled";
    int sampleRate = 48000;
    std::vector<TempoEntry> tempoMap;     // v1: single entry at beat 0
    std::vector<TimeSigEntry> timeSigMap; // v1: single entry at bar 0
    LoopRegion loop;
    GridSettings grid;
    std::vector<Marker> markers;
    std::vector<Track> tracks; // ordered; tree via parentId (folders)
    Track masterTrack;         // kind == Master
    std::vector<Asset> assets;
    std::vector<Vca> vcas;         // VCA control-group faders (SPEC §6)
    std::vector<MidiMap> midiMaps; // hardware CC → param mappings (SPEC §5.2)
    uint64_t nextId = 1;       // next id to allocate (ids start at 1; 0 = sentinel)
    json ui = json::object();  // opaque UI state, round-tripped verbatim
};

// ---------------------------------------------------------------------------
// Model — wraps a Project with id allocation, lookups and validation.
// Main-thread only (commands are processed on the main thread, SPEC §7).
// ---------------------------------------------------------------------------

struct ClipRef {
    Track* track = nullptr;
    Clip* clip = nullptr;
    explicit operator bool() const { return clip != nullptr; }
};

struct ConstClipRef {
    const Track* track = nullptr;
    const Clip* clip = nullptr;
    explicit operator bool() const { return clip != nullptr; }
};

class Model {
public:
    Project project;

    // Transient foreign-import transport hint (project/importForeign, SPEC §5.1/§5.4):
    // the source project's metronome/click state. NOT part of project.json (never
    // serialized). Import providers fill it on the scratch model; Api::importForeignPath
    // applies it to the Transport after adoption. -1 = source didn't say (leave the
    // current engine state untouched), 0/1 = explicit off/on.
    int importMetronomeEnabled = -1;

    Model() { project = defaultProject(); }

    // Fresh project with a master track (id 1) and v1 defaults.
    static Project defaultProject(std::string name = "Untitled", int sampleRate = 48000) {
        Project p;
        p.name = std::move(name);
        p.sampleRate = sampleRate;
        p.tempoMap.push_back(TempoEntry{0.0, 120.0});
        p.timeSigMap.push_back(TimeSigEntry{0, 4, 4});
        p.masterTrack.id = 1;
        p.masterTrack.kind = TrackKind::Master;
        p.masterTrack.name = "Master";
        p.masterTrack.color = "#5b8cff";
        p.masterTrack.outputTarget = OutputTarget::none(); // master feeds the device
        p.nextId = 2;
        return p;
    }

    uint64_t nextId() { return project.nextId++; }

    // --- track lookups -----------------------------------------------------
    Track* trackById(uint64_t id) {
        if (id == 0)
            return nullptr;
        if (project.masterTrack.id == id)
            return &project.masterTrack;
        for (Track& t : project.tracks)
            if (t.id == id)
                return &t;
        return nullptr;
    }
    const Track* trackById(uint64_t id) const {
        return const_cast<Model*>(this)->trackById(id);
    }

    // Index within project.tracks (master excluded); -1 if absent.
    int trackIndex(uint64_t id) const {
        for (size_t i = 0; i < project.tracks.size(); ++i)
            if (project.tracks[i].id == id)
                return static_cast<int>(i);
        return -1;
    }

    // All tracks, optionally including master (master last).
    std::vector<Track*> allTracks(bool includeMaster = true) {
        std::vector<Track*> out;
        out.reserve(project.tracks.size() + 1);
        for (Track& t : project.tracks)
            out.push_back(&t);
        if (includeMaster)
            out.push_back(&project.masterTrack);
        return out;
    }

    std::vector<Track*> childrenOf(uint64_t folderId) {
        std::vector<Track*> out;
        for (Track& t : project.tracks)
            if (t.parentId == folderId)
                out.push_back(&t);
        return out;
    }

    // --- clip lookups --------------------------------------------------------
    ClipRef clipById(uint64_t id) {
        if (id == 0)
            return {};
        for (Track& t : project.tracks)
            for (Clip& c : t.clips)
                if (clipId(c) == id)
                    return ClipRef{&t, &c};
        return {};
    }
    ConstClipRef clipById(uint64_t id) const {
        const ClipRef r = const_cast<Model*>(this)->clipById(id);
        return ConstClipRef{r.track, r.clip};
    }

    // --- other lookups -------------------------------------------------------
    Asset* assetById(uint64_t id) {
        if (id == 0)
            return nullptr;
        for (Asset& a : project.assets)
            if (a.id == id)
                return &a;
        return nullptr;
    }
    Vca* vcaById(uint64_t id) {
        if (id == 0)
            return nullptr;
        for (Vca& v : project.vcas)
            if (v.id == id)
                return &v;
        return nullptr;
    }
    // Linear gain of the VCA a track belongs to (1.0 if none / not found).
    double vcaGainFor(uint64_t vcaId) const {
        if (vcaId == 0)
            return 1.0;
        for (const Vca& v : project.vcas)
            if (v.id == vcaId)
                return v.gain;
        return 1.0;
    }
    const Asset* assetById(uint64_t id) const {
        return const_cast<Model*>(this)->assetById(id);
    }

    Marker* markerById(uint64_t id) {
        if (id == 0)
            return nullptr;
        for (Marker& m : project.markers)
            if (m.id == id)
                return &m;
        return nullptr;
    }

    // Finds an insert by instanceId across all tracks (incl. master).
    // outTrack (optional) receives the owning track.
    PluginInstance* pluginByInstanceId(uint64_t instanceId, Track** outTrack = nullptr) {
        if (instanceId == 0)
            return nullptr;
        auto scan = [&](Track& t) -> PluginInstance* {
            for (PluginInstance& pi : t.inserts)
                if (pi.instanceId == instanceId) {
                    if (outTrack)
                        *outTrack = &t;
                    return &pi;
                }
            return nullptr;
        };
        for (Track& t : project.tracks)
            if (PluginInstance* pi = scan(t))
                return pi;
        return scan(project.masterTrack);
    }

    AutomationLane* automationLane(uint64_t trackId, const std::string& paramRef,
                                   bool createIfMissing = false) {
        Track* t = trackById(trackId);
        if (!t)
            return nullptr;
        for (AutomationLane& l : t->automation)
            if (l.paramRef == paramRef)
                return &l;
        if (!createIfMissing)
            return nullptr;
        t->automation.push_back(AutomationLane{paramRef, {}});
        return &t->automation.back();
    }

    // --- validation ----------------------------------------------------------
    // True if adding a routing edge srcTrackId -> destTrackId (outputTarget OR send)
    // would create a cycle through existing outputTarget/send edges (SPEC §7: buses can
    // feed buses; cycle => reject command). Routing to master/none never cycles.
    bool wouldCreateRoutingCycle(uint64_t srcTrackId, uint64_t destTrackId) const {
        if (srcTrackId == 0 || destTrackId == 0)
            return false;
        if (srcTrackId == destTrackId)
            return true;
        // DFS from dest through existing edges; cycle iff we can reach src.
        std::vector<uint64_t> stack{destTrackId};
        std::vector<uint64_t> visited;
        while (!stack.empty()) {
            const uint64_t cur = stack.back();
            stack.pop_back();
            if (cur == srcTrackId)
                return true;
            bool seen = false;
            for (uint64_t v : visited)
                if (v == cur) { seen = true; break; }
            if (seen)
                continue;
            visited.push_back(cur);
            const Track* t = trackById(cur);
            if (!t)
                continue;
            if (t->outputTarget.isTrack())
                stack.push_back(t->outputTarget.trackId);
            for (const Send& s : t->sends)
                if (s.destTrackId != 0)
                    stack.push_back(s.destTrackId);
        }
        return false;
    }

    // Convenience referential-integrity probes for commands (E3).
    bool isValidSendDest(uint64_t destTrackId) const {
        const Track* t = trackById(destTrackId);
        return t && t->kind == TrackKind::Bus;
    }
    bool isValidOutputTarget(const OutputTarget& target) const {
        if (!target.isTrack())
            return true;
        const Track* t = trackById(target.trackId);
        return t && t->kind == TrackKind::Bus;
    }
};

// ---------------------------------------------------------------------------
// Serialization — DECLARATIONS only; defined by E3 in project/Serialize.cpp.
// toJson produces project.json v1 shapes (SPEC §6); fromJson tolerates missing optionals
// (defaults above) and returns false + err on structural problems.
// ---------------------------------------------------------------------------

json toJson(const Project& p);
json toJson(const Track& t);
json toJson(const Clip& c);
json toJson(const AudioClip& c);
json toJson(const MidiClip& c);
json toJson(const Note& n);
json toJson(const MidiCc& c);
json toJson(const PluginInstance& pi);
json toJson(const EqBand& b);
json toJson(const TrackEq& eq);
json toJson(const Send& s);
json toJson(const AutomationLane& l);
json toJson(const AutomationPoint& pt);
json toJson(const Marker& m);
json toJson(const Asset& a);
json toJson(const TakeFolder& f);
json toJson(const TrackVersion& v);
json toJson(const OutputTarget& o); // number | "master" | "none"

bool fromJson(const json& j, Project& out, std::string* err = nullptr);
bool fromJson(const json& j, Track& out, std::string* err = nullptr);
bool fromJson(const json& j, Clip& out, std::string* err = nullptr);
bool fromJson(const json& j, Note& out, std::string* err = nullptr);
bool fromJson(const json& j, MidiCc& out, std::string* err = nullptr);
bool fromJson(const json& j, PluginInstance& out, std::string* err = nullptr);
bool fromJson(const json& j, EqBand& out, std::string* err = nullptr);
bool fromJson(const json& j, TrackEq& out, std::string* err = nullptr);
bool fromJson(const json& j, Send& out, std::string* err = nullptr);
bool fromJson(const json& j, AutomationLane& out, std::string* err = nullptr);
bool fromJson(const json& j, AutomationPoint& out, std::string* err = nullptr);
bool fromJson(const json& j, Marker& out, std::string* err = nullptr);
bool fromJson(const json& j, Asset& out, std::string* err = nullptr);
bool fromJson(const json& j, TakeFolder& out, std::string* err = nullptr);
bool fromJson(const json& j, TrackVersion& out, std::string* err = nullptr);
bool fromJson(const json& j, OutputTarget& out, std::string* err = nullptr);

} // namespace mydaw
