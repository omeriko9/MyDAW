// MyDAW agent bounded read/query primitive. See AgentQuery.h.

#include "agent/AgentQuery.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include "App.h"
#include "core/effects/BuiltinEffectManager.h"
#include "core/effects/Effects.h" // builtinFactoryPresets
#include "plugins/HostProcess.h"
#include "util/Log.h"

namespace mydaw {
namespace {

constexpr std::size_t kDefaultLimit = 100;
constexpr std::size_t kMaxLimit = 500;
constexpr std::size_t kMaxFields = 64;
constexpr std::size_t kMaxResultBytes = 256 * 1024;
constexpr std::size_t kMaxInspectedCandidates = 100000;
constexpr std::size_t kMaxMatchedItems = 20000;
constexpr std::size_t kMaxAccumulatedBytes = 4 * 1024 * 1024;
constexpr std::size_t kMaxAccumulatedNodes = 200000;

using FieldSet = std::set<std::string>;

struct QueryArgs {
    std::string view;
    json where = json::object();
    std::vector<std::string> fields;
    bool hasFields = false;
    std::size_t limit = kDefaultLimit;
    std::size_t offset = 0;
};

class QueryLimitExceeded final : public std::runtime_error {
public:
    explicit QueryLimitExceeded(const std::string& message) : std::runtime_error(message) {}
};

class QueryBudget {
public:
    void inspect(std::size_t count, const char* what) {
        if (count > kMaxInspectedCandidates - inspected_)
            throw QueryLimitExceeded(
                "query would inspect more than 100000 candidates while scanning " +
                std::string(what) + "; narrow where filters or query a specific entity ID");
        inspected_ += count;
    }

    void accountMatch(const json& item) {
        if (matched_ >= kMaxMatchedItems)
            throw QueryLimitExceeded(
                "query matched more than 20000 items; narrow where filters before paginating");
        ++matched_;
        accountJson(item);
    }

    void inspectSourceBytes(std::size_t count, const char* what) {
        if (count > kMaxAccumulatedBytes - sourceBytes_)
            throw QueryLimitExceeded("query source exceeds 4 MiB while reading " +
                                     std::string(what) + "; request a narrower view");
        sourceBytes_ += count;
    }

private:
    void addBytes(std::size_t count) {
        if (count > kMaxAccumulatedBytes - accumulatedBytes_)
            throw QueryLimitExceeded(
                "query accumulated more than 4 MiB before pagination; narrow where filters");
        accumulatedBytes_ += count;
    }

    void accountJson(const json& value, std::size_t depth = 0) {
        if (depth > 64)
            throw QueryLimitExceeded(
                "query item nesting exceeds 64 levels; request a flatter view");
        if (accumulatedNodes_ >= kMaxAccumulatedNodes)
            throw QueryLimitExceeded(
                "query accumulated more than 200000 JSON values before pagination; narrow where filters");
        ++accumulatedNodes_;
        if (value.is_string()) {
            addBytes(value.get_ref<const std::string&>().size() + 8);
        } else if (value.is_array()) {
            addBytes(8);
            for (const json& child : value)
                accountJson(child, depth + 1);
        } else if (value.is_object()) {
            addBytes(8);
            for (auto it = value.begin(); it != value.end(); ++it) {
                addBytes(it.key().size() + 4);
                accountJson(*it, depth + 1);
            }
        } else {
            addBytes(16);
        }
    }

    std::size_t inspected_ = 0;
    std::size_t matched_ = 0;
    std::size_t accumulatedBytes_ = 0;
    std::size_t accumulatedNodes_ = 0;
    std::size_t sourceBytes_ = 0;
};

class BoundedItems : public std::vector<json> {
public:
    explicit BoundedItems(QueryBudget& budget) : budget_(budget) {}

    void push_back(const json& item) {
        budget_.accountMatch(item);
        std::vector<json>::push_back(item);
    }
    void push_back(json&& item) {
        budget_.accountMatch(item);
        std::vector<json>::push_back(std::move(item));
    }

private:
    QueryBudget& budget_;
};

bool fail(std::string& code, std::string& message, const std::string& useCode,
          const std::string& useMessage) {
    code = useCode;
    message = useMessage;
    return false;
}

bool parseNonNegativeInteger(const json& value, uint64_t& out) {
    if (value.is_number_unsigned()) {
        out = value.get<uint64_t>();
        return true;
    }
    if (!value.is_number_integer())
        return false;
    const int64_t signedValue = value.get<int64_t>();
    if (signedValue < 0)
        return false;
    out = static_cast<uint64_t>(signedValue);
    return true;
}

bool parseCursor(const json& value, std::size_t& out) {
    if (value.is_null()) {
        out = 0;
        return true;
    }
    if (!value.is_string())
        return false;
    const std::string text = value.get<std::string>();
    if (text.empty() || (text.size() > 1 && text.front() == '0'))
        return false;
    std::size_t parsed = 0;
    for (char ch : text) {
        if (ch < '0' || ch > '9')
            return false;
        const unsigned digit = static_cast<unsigned>(ch - '0');
        if (parsed > (std::numeric_limits<std::size_t>::max() - digit) / 10)
            return false;
        parsed = parsed * 10 + digit;
    }
    out = parsed;
    return true;
}

bool parseQueryArgs(const json& payload, QueryArgs& out, std::string& ec, std::string& em) {
    if (!payload.is_object())
        return fail(ec, em, "invalid_arguments", "query payload must be an object");
    static const FieldSet topLevel{"view", "where", "fields", "limit", "cursor"};
    for (auto it = payload.begin(); it != payload.end(); ++it)
        if (topLevel.count(it.key()) == 0)
            return fail(ec, em, "invalid_arguments", "unknown query field: " + it.key());

    if (!payload.contains("view") || !payload["view"].is_string() ||
        payload["view"].get_ref<const std::string&>().empty())
        return fail(ec, em, "invalid_arguments", "view must be a non-empty string");
    out.view = payload["view"].get<std::string>();

    if (payload.contains("where")) {
        if (!payload["where"].is_object())
            return fail(ec, em, "invalid_arguments", "where must be an object");
        out.where = payload["where"];
    }

    if (payload.contains("fields")) {
        const json& fields = payload["fields"];
        if (!fields.is_array() || fields.empty() || fields.size() > kMaxFields)
            return fail(ec, em, "invalid_arguments", "fields must contain 1 to 64 names");
        std::set<std::string> unique;
        for (const json& field : fields) {
            if (!field.is_string() || field.get_ref<const std::string&>().empty())
                return fail(ec, em, "invalid_arguments", "every field must be a non-empty string");
            const std::string name = field.get<std::string>();
            if (!unique.insert(name).second)
                return fail(ec, em, "invalid_arguments", "duplicate field: " + name);
            out.fields.push_back(name);
        }
        out.hasFields = true;
    }

    if (payload.contains("limit")) {
        uint64_t limit = 0;
        if (!parseNonNegativeInteger(payload["limit"], limit) || limit < 1 ||
            limit > kMaxLimit)
            return fail(ec, em, "invalid_arguments", "limit must be an integer from 1 to 500");
        out.limit = static_cast<std::size_t>(limit);
    }
    if (payload.contains("cursor") && !parseCursor(payload["cursor"], out.offset))
        return fail(ec, em, "invalid_arguments", "cursor must be a canonical decimal offset string");
    return true;
}

bool validateWhereKeys(const json& where, const FieldSet& allowed, std::string& ec,
                       std::string& em) {
    for (auto it = where.begin(); it != where.end(); ++it)
        if (allowed.count(it.key()) == 0)
            return fail(ec, em, "invalid_arguments", "unsupported where field: " + it.key());
    return true;
}

bool readId(const json& where, const char* key, bool required, bool allowZero,
            uint64_t& value, bool& present, std::string& ec, std::string& em) {
    present = where.contains(key);
    if (!present) {
        if (required)
            return fail(ec, em, "invalid_arguments", std::string("where.") + key + " is required");
        value = 0;
        return true;
    }
    if (!parseNonNegativeInteger(where[key], value) || (!allowZero && value == 0))
        return fail(ec, em, "invalid_arguments", std::string("where.") + key +
                                                   (allowZero ? " must be a non-negative integer"
                                                              : " must be a positive integer"));
    return true;
}

bool readInteger(const json& where, const char* key, int minimum, int maximum, int& value,
                 bool& present, std::string& ec, std::string& em) {
    present = where.contains(key);
    if (!present)
        return true;
    if (!where[key].is_number_integer())
        return fail(ec, em, "invalid_arguments", std::string("where.") + key + " must be an integer");
    if (where[key].is_number_unsigned()) {
        const uint64_t parsed = where[key].get<uint64_t>();
        if (parsed < static_cast<uint64_t>(std::max(0, minimum)) ||
            parsed > static_cast<uint64_t>(maximum))
            return fail(ec, em, "invalid_arguments", std::string("where.") + key + " is out of range");
        value = static_cast<int>(parsed);
        return true;
    }
    const int64_t parsed = where[key].get<int64_t>();
    if (parsed < static_cast<int64_t>(minimum) || parsed > static_cast<int64_t>(maximum))
        return fail(ec, em, "invalid_arguments", std::string("where.") + key + " is out of range");
    value = static_cast<int>(parsed);
    return true;
}

bool readNumber(const json& where, const char* key, double minimum, double& value,
                bool& present, std::string& ec, std::string& em) {
    present = where.contains(key);
    if (!present)
        return true;
    if (!where[key].is_number())
        return fail(ec, em, "invalid_arguments", std::string("where.") + key + " must be numeric");
    value = where[key].get<double>();
    if (!std::isfinite(value) || value < minimum)
        return fail(ec, em, "invalid_arguments", std::string("where.") + key + " is out of range");
    return true;
}

bool readString(const json& where, const char* key, std::string& value, bool& present,
                std::string& ec, std::string& em, bool allowEmpty = false) {
    present = where.contains(key);
    if (!present)
        return true;
    if (!where[key].is_string() || (!allowEmpty && where[key].get_ref<const std::string&>().empty()))
        return fail(ec, em, "invalid_arguments", std::string("where.") + key +
                                                   " must be a non-empty string");
    value = where[key].get<std::string>();
    return true;
}

bool readNumberOrStringId(const json& where, const char* key, json& value, bool& present,
                          std::string& ec, std::string& em) {
    present = where.contains(key);
    if (!present)
        return true;
    const json& candidate = where[key];
    if (candidate.is_string()) {
        if (candidate.get_ref<const std::string&>().empty())
            return fail(ec, em, "invalid_arguments",
                        std::string("where.") + key + " must not be an empty string");
        value = candidate;
        return true;
    }
    uint64_t numeric = 0;
    if (!parseNonNegativeInteger(candidate, numeric))
        return fail(ec, em, "invalid_arguments",
                    std::string("where.") + key + " must be a non-negative integer or string");
    value = candidate;
    return true;
}

bool readBool(const json& where, const char* key, bool& value, bool& present,
              std::string& ec, std::string& em) {
    present = where.contains(key);
    if (!present)
        return true;
    if (!where[key].is_boolean())
        return fail(ec, em, "invalid_arguments", std::string("where.") + key + " must be boolean");
    value = where[key].get<bool>();
    return true;
}

void addTrackFields(FieldSet& fields) {
    static const char* names[] = {
        "id", "index", "kind", "name", "color", "height", "parentId", "channels", "volume",
        "pan", "mute", "solo", "recordArm", "monitor", "inputDevice", "inputChannel",
        "outputTarget", "frozen", "frozenAssetId", "midiTarget", "vcaId", "eq",
        "clipCount", "insertCount", "sendCount", "automationLaneCount", "takeFolderCount",
        "activeVersionId", "versions",
    };
    fields.insert(std::begin(names), std::end(names));
}

// index is the track's 1-based position in the arrangement — what a user means by
// "channel 3". It is not stored on the track (order is the vector's), so the callers
// below stamp it while walking the list.
json trackSummary(const Track& track) {
    json item{{"id", track.id}, {"kind", trackKindToString(track.kind)},
              {"name", track.name}, {"color", track.color}, {"channels", track.channels},
              {"volume", track.volume}, {"pan", track.pan}, {"mute", track.mute},
              {"solo", track.solo}, {"recordArm", track.recordArm},
              {"outputTarget", toJson(track.outputTarget)}};
    if (track.height > 0)
        item["height"] = track.height;
    if (track.parentId != 0)
        item["parentId"] = track.parentId;
    if (track.monitor)
        item["monitor"] = true;
    if (!track.inputDevice.empty())
        item["inputDevice"] = track.inputDevice;
    if (track.inputChannel >= 0)
        item["inputChannel"] = track.inputChannel;
    if (track.frozen)
        item["frozen"] = true;
    if (track.frozenAssetId != 0)
        item["frozenAssetId"] = track.frozenAssetId;
    if (track.midiTarget != 0)
        item["midiTarget"] = track.midiTarget;
    if (track.vcaId != 0)
        item["vcaId"] = track.vcaId;
    item["eq"] = toJson(track.eq);
    item["clipCount"] = track.clips.size();
    item["insertCount"] = track.inserts.size();
    item["sendCount"] = track.sends.size();
    item["automationLaneCount"] = track.automation.size();
    item["takeFolderCount"] = track.takeFolders.size();
    if (!track.versions.empty()) {
        // Enumerable ids so cmd/version.switch/rename/delete can be driven from a
        // query. Parked material stays summarized — a clipCount per entry suffices.
        item["activeVersionId"] = track.activeVersionId;
        json versions = json::array();
        for (const TrackVersion& v : track.versions)
            versions.push_back(json{{"id", v.id},
                                    {"name", v.name},
                                    {"active", v.id == track.activeVersionId},
                                    {"clipCount", v.clips.size()}});
        item["versions"] = std::move(versions);
    }
    return item;
}

json clipSummary(const Track& track, const Clip& clip) {
    json item;
    if (const AudioClip* audio = asAudio(&clip)) {
        item = toJson(*audio);
    } else {
        const MidiClip* midi = asMidi(&clip);
        item = json{{"id", midi->id}, {"type", "midi"}, {"name", midi->name},
                    {"startBeat", midi->startBeat}, {"lengthBeats", midi->lengthBeats},
                    {"noteCount", midi->notes.size()}, {"controllerCount", midi->cc.size()}};
        if (midi->muted)
            item["muted"] = true;
        if (!midi->color.empty())
            item["color"] = midi->color;
    }
    item["trackId"] = track.id;
    item["trackName"] = track.name;
    return item;
}

json pluginSummary(const PluginInstance& plugin) {
    json item{{"instanceId", plugin.instanceId}, {"uid", plugin.uid},
              {"format", plugin.format}, {"path", plugin.path}, {"bitness", plugin.bitness},
              {"name", plugin.name}, {"bypass", plugin.bypass}, {"wetDry", plugin.wetDry}};
    if (!plugin.version.empty())
        item["version"] = plugin.version;
    if (!plugin.sourceHint.empty())
        item["sourceHint"] = plugin.sourceHint;
    if (!plugin.stateFile.empty())
        item["stateFile"] = plugin.stateFile;
    if (plugin.sampleAssetId != 0)
        item["sampleAssetId"] = plugin.sampleAssetId;
    if (plugin.sidechainSource != 0)
        item["sidechainSource"] = plugin.sidechainSource;
    item["parameterValueCount"] = plugin.paramValues.size();
    return item;
}

std::string asciiLower(std::string value) {
    for (char& ch : value)
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    return value;
}

json boundedRedactedCopy(const json& value, QueryBudget& budget, std::size_t depth = 0) {
    if (depth > 64)
        throw QueryLimitExceeded(
            "settings nesting exceeds 64 levels; query cannot safely copy it");
    budget.inspect(1, "settings JSON values");
    if (value.is_string()) {
        budget.inspectSourceBytes(value.get_ref<const std::string&>().size() + 8,
                                  "settings strings");
        return value;
    }
    if (value.is_array()) {
        json out = json::array();
        for (const json& item : value)
            out.push_back(boundedRedactedCopy(item, budget, depth + 1));
        return out;
    }
    if (!value.is_object()) {
        budget.inspectSourceBytes(16, "settings values");
        return value;
    }
    json out = json::object();
    for (auto it = value.begin(); it != value.end(); ++it) {
        budget.inspectSourceBytes(it.key().size() + 4, "settings keys");
        std::string normalized;
        normalized.reserve(it.key().size());
        for (unsigned char ch : it.key())
            if (std::isalnum(ch))
                normalized.push_back(static_cast<char>(std::tolower(ch)));
        if (normalized == "apikey" || normalized == "mcptoken") {
            out[it.key()] = "[REDACTED]";
        } else {
            out[it.key()] = boundedRedactedCopy(*it, budget, depth + 1);
        }
    }
    return out;
}

FieldSet objectFields(const json& object) {
    FieldSet result;
    if (object.is_object())
        for (auto it = object.begin(); it != object.end(); ++it)
            result.insert(it.key());
    return result;
}

bool applyFields(std::vector<json>& items, const QueryArgs& args, const FieldSet& allowed,
                 std::string& ec, std::string& em) {
    (void)ec;
    (void)em;
    if (!args.hasFields)
        return true;
    // Be lenient with model-supplied field names: keep the requested fields that exist for
    // this view and silently ignore unknown ones, rather than hard-failing the whole query
    // (which strands an LLM that guessed a near-miss name like "note" for "pitch"). If NONE
    // of the requested names are known, return the full items so the model can discover the
    // real field names from the data.
    std::vector<std::string> known;
    known.reserve(args.fields.size());
    for (const std::string& field : args.fields)
        if (allowed.count(field) != 0)
            known.push_back(field);
    if (known.empty())
        return true;
    for (json& item : items) {
        json projected = json::object();
        for (const std::string& field : known)
            if (item.is_object() && item.contains(field))
                projected[field] = item[field];
        item = std::move(projected);
    }
    return true;
}

json finishQuery(App& app, const QueryArgs& args, std::vector<json> items,
                 const FieldSet& allowedFields, std::string& ec, std::string& em) {
    if (!applyFields(items, args, allowedFields, ec, em))
        return json();
    const std::size_t total = items.size();
    const std::size_t begin = std::min(args.offset, total);
    const std::size_t wantedEnd = std::min(total, begin + args.limit);
    json page = json::array();
    for (std::size_t i = begin; i < wantedEnd; ++i)
        page.push_back(std::move(items[i]));

    auto makeResponse = [&](const json& usePage) {
        const std::size_t consumed = usePage.size();
        const std::size_t nextOffset = begin + consumed;
        json next = nextOffset < total ? json(std::to_string(nextOffset)) : json();
        const uint64_t revision = app.cmd ? app.cmd->revision() : 0;
        return json{{"view", args.view},
                    {"revision", revision},
                    {"items", usePage},
                    {"total", total},
                    {"nextCursor", std::move(next)}};
    };

    json response = makeResponse(page);
    while (response.dump().size() > kMaxResultBytes && !page.empty()) {
        page.erase(page.end() - 1);
        response = makeResponse(page);
    }
    if (response.dump().size() > kMaxResultBytes || (page.empty() && begin < wantedEnd)) {
        fail(ec, em, "result_too_large",
             "one result item exceeds the query size budget; request fewer fields");
        return json();
    }
    return response;
}

template <typename Fn>
void forEachTrack(App& app, Fn&& fn, bool includeMaster = true) {
    for (Track& track : app.model.project.tracks)
        fn(track);
    if (includeMaster)
        fn(app.model.project.masterTrack);
}

void inspectTracks(App& app, QueryBudget& budget) {
    budget.inspect(app.model.project.tracks.size() + 1, "project tracks");
}

void inspectClipsForLookup(App& app, QueryBudget& budget) {
    inspectTracks(app, budget);
    for (const Track& track : app.model.project.tracks)
        budget.inspect(track.clips.size(), "project clips");
}

void inspectPluginsForLookup(App& app, QueryBudget& budget) {
    inspectTracks(app, budget);
    for (const Track& track : app.model.project.tracks)
        budget.inspect(track.inserts.size(), "plugin instances");
    budget.inspect(app.model.project.masterTrack.inserts.size(), "plugin instances");
}

bool ensureTrack(App& app, uint64_t id, std::string& ec, std::string& em) {
    if (app.model.trackById(id))
        return true;
    return fail(ec, em, "not_found", "trackId not found: " + std::to_string(id));
}

bool ensureClip(App& app, uint64_t id, ConstClipRef& out, std::string& ec, std::string& em) {
    out = static_cast<const Model&>(app.model).clipById(id);
    if (out)
        return true;
    return fail(ec, em, "not_found", "clipId not found: " + std::to_string(id));
}

bool pluginIsLive(App& app, uint64_t instanceId) {
    return (app.host && app.host->node(instanceId) != nullptr) ||
           (app.builtin && app.builtin->has(instanceId));
}

json projectSummary(App& app, QueryBudget& budget) {
    const Project& project = app.model.project;
    inspectClipsForLookup(app, budget);
    std::size_t clipCount = 0;
    std::size_t noteCount = 0;
    std::size_t controllerCount = 0;
    std::size_t pluginCount = project.masterTrack.inserts.size();
    for (const Track& track : project.tracks) {
        clipCount += track.clips.size();
        pluginCount += track.inserts.size();
        for (const Clip& clip : track.clips)
            if (const MidiClip* midi = asMidi(&clip)) {
                noteCount += midi->notes.size();
                controllerCount += midi->cc.size();
            }
    }
    const json tempo = project.tempoMap.empty()
                           ? json()
                           : json{{"beat", project.tempoMap.front().beat},
                                  {"bpm", project.tempoMap.front().bpm}};
    const json timeSignature = project.timeSigMap.empty()
                                   ? json()
                                   : json{{"bar", project.timeSigMap.front().bar},
                                          {"num", project.timeSigMap.front().num},
                                          {"den", project.timeSigMap.front().den}};
    return json{{"name", project.name},
                {"formatVersion", project.formatVersion},
                {"sampleRate", project.sampleRate},
                {"path", app.projectIO.hasPath() ? json(app.projectIO.projectJsonPath()) : json()},
                {"dirty", app.projectIO.isDirty()},
                {"trackCount", project.tracks.size() + 1},
                {"clipCount", clipCount},
                {"noteCount", noteCount},
                {"controllerCount", controllerCount},
                {"assetCount", project.assets.size()},
                {"markerCount", project.markers.size()},
                {"pluginInstanceCount", pluginCount},
                {"vcaCount", project.vcas.size()},
                {"tempoMapCount", project.tempoMap.size()},
                {"timeSigMapCount", project.timeSigMap.size()},
                {"tempo", tempo},
                {"timeSignature", timeSignature},
                {"loop", json{{"startBeat", project.loop.startBeat},
                              {"endBeat", project.loop.endBeat},
                              {"enabled", project.loop.enabled}}},
                {"grid", json{{"division", project.grid.division},
                              {"snap", project.grid.snap},
                              {"triplet", project.grid.triplet},
                              {"swing", project.grid.swing}}}};
}

FieldSet projectSummaryFields() {
    return FieldSet{"name", "formatVersion", "sampleRate", "path", "dirty", "trackCount",
                    "clipCount", "noteCount", "controllerCount", "assetCount", "markerCount",
                    "pluginInstanceCount", "vcaCount", "tempoMapCount", "timeSigMapCount",
                    "tempo", "timeSignature", "loop", "grid"};
}

FieldSet clipFields() {
    return FieldSet{"id", "type", "trackId", "trackName", "name", "startBeat", "muted",
                    "color", "assetId", "srcOffsetSamples", "lengthSamples", "gain",
                    "fadeInSec", "fadeOutSec", "lengthBeats", "noteCount", "controllerCount"};
}

} // namespace

json runAgentQuery(App& app, const json& payload, std::string& errCode,
                   std::string& errMsg) {
    errCode.clear();
    errMsg.clear();
    QueryArgs args;
    if (!parseQueryArgs(payload, args, errCode, errMsg))
        return json();

    QueryBudget budget;
    BoundedItems items(budget);
    FieldSet fields;

    try {
    if (args.view == "project_summary") {
        if (!validateWhereKeys(args.where, {}, errCode, errMsg))
            return json();
        items.push_back(projectSummary(app, budget));
        fields = projectSummaryFields();
    } else if (args.view == "tempo_map") {
        if (!validateWhereKeys(args.where, {"beat"}, errCode, errMsg))
            return json();
        double beat = 0.0;
        bool hasBeat = false;
        if (!readNumber(args.where, "beat", 0.0, beat, hasBeat, errCode, errMsg))
            return json();
        budget.inspect(app.model.project.tempoMap.size(), "tempo-map entries");
        for (const TempoEntry& entry : app.model.project.tempoMap) {
            if (hasBeat && entry.beat != beat)
                continue;
            items.push_back(json{{"beat", entry.beat}, {"bpm", entry.bpm}});
        }
        fields = {"beat", "bpm"};
    } else if (args.view == "time_signature_map") {
        if (!validateWhereKeys(args.where, {"bar"}, errCode, errMsg))
            return json();
        int bar = 0;
        bool hasBar = false;
        if (!readInteger(args.where, "bar", 0, std::numeric_limits<int>::max(), bar,
                         hasBar, errCode, errMsg))
            return json();
        budget.inspect(app.model.project.timeSigMap.size(), "time-signature entries");
        for (const TimeSigEntry& entry : app.model.project.timeSigMap) {
            if (hasBar && entry.bar != bar)
                continue;
            items.push_back(json{{"bar", entry.bar}, {"num", entry.num}, {"den", entry.den}});
        }
        fields = {"bar", "num", "den"};
    } else if (args.view == "grid") {
        if (!validateWhereKeys(args.where, {}, errCode, errMsg))
            return json();
        const GridSettings& grid = app.model.project.grid;
        items.push_back(json{{"division", grid.division}, {"snap", grid.snap},
                             {"triplet", grid.triplet}, {"swing", grid.swing}});
        fields = {"division", "snap", "triplet", "swing"};
    } else if (args.view == "loop") {
        if (!validateWhereKeys(args.where, {}, errCode, errMsg))
            return json();
        const LoopRegion& loop = app.model.project.loop;
        items.push_back(json{{"startBeat", loop.startBeat}, {"endBeat", loop.endBeat},
                             {"enabled", loop.enabled}});
        fields = {"startBeat", "endBeat", "enabled"};
    } else if (args.view == "tracks" || args.view == "track") {
        const bool single = args.view == "track";
        if (!validateWhereKeys(args.where,
                               single ? FieldSet{"trackId"}
                                      : FieldSet{"trackId", "kind", "parentId", "name", "includeMaster"},
                               errCode, errMsg))
            return json();
        uint64_t trackId = 0;
        bool hasTrackId = false;
        if (!readId(args.where, "trackId", single, false, trackId, hasTrackId, errCode, errMsg))
            return json();
        inspectTracks(app, budget);
        if (hasTrackId && !ensureTrack(app, trackId, errCode, errMsg))
            return json();
        // 1-based arrangement position, so "channel 3" is answerable. Master is not
        // numbered — it is not a channel in the strip-counting sense.
        const auto indexOf = [&](const Track& t) -> int {
            const auto& list = app.model.project.tracks;
            for (size_t i = 0; i < list.size(); ++i)
                if (list[i].id == t.id)
                    return static_cast<int>(i) + 1;
            return 0;
        };
        if (single) {
            Track* track = app.model.trackById(trackId);
            budget.inspect(track->eq.bands.size(), "track EQ bands");
            json item = trackSummary(*track);
            if (const int ix = indexOf(*track))
                item["index"] = ix;
            items.push_back(std::move(item));
        } else {
            std::string kind;
            std::string name;
            bool hasKind = false, hasName = false;
            uint64_t parentId = 0;
            bool hasParentId = false;
            bool includeMaster = true, hasIncludeMaster = false;
            if (!readString(args.where, "kind", kind, hasKind, errCode, errMsg) ||
                !readString(args.where, "name", name, hasName, errCode, errMsg) ||
                !readId(args.where, "parentId", false, true, parentId, hasParentId, errCode, errMsg) ||
                !readBool(args.where, "includeMaster", includeMaster, hasIncludeMaster, errCode, errMsg))
                return json();
            if (hasKind) {
                TrackKind parsed = TrackKind::Audio;
                if (!trackKindFromString(kind, parsed)) {
                    fail(errCode, errMsg, "invalid_arguments", "where.kind is not a track kind");
                    return json();
                }
            }
            if (hasParentId && parentId != 0) {
                Track* parent = app.model.trackById(parentId);
                if (!parent) {
                    fail(errCode, errMsg, "not_found", "parentId not found: " + std::to_string(parentId));
                    return json();
                }
                if (parent->kind != TrackKind::Folder) {
                    fail(errCode, errMsg, "invalid_target", "parentId does not identify a folder track");
                    return json();
                }
            }
            auto add = [&](Track& track) {
                if (hasTrackId && track.id != trackId)
                    return;
                if (hasKind && kind != trackKindToString(track.kind))
                    return;
                if (hasParentId && track.parentId != parentId)
                    return;
                if (hasName && track.name != name)
                    return;
                budget.inspect(track.eq.bands.size(), "track EQ bands");
                json item = trackSummary(track);
                if (const int ix = indexOf(track))
                    item["index"] = ix;
                items.push_back(std::move(item));
            };
            for (Track& track : app.model.project.tracks)
                add(track);
            if (includeMaster)
                add(app.model.project.masterTrack);
        }
        addTrackFields(fields);
    } else if (args.view == "clips" || args.view == "clip") {
        const bool single = args.view == "clip";
        if (!validateWhereKeys(args.where,
                               single ? FieldSet{"clipId"}
                                      : FieldSet{"clipId", "trackId", "type", "name"},
                               errCode, errMsg))
            return json();
        uint64_t clipIdValue = 0;
        bool hasClipId = false;
        if (!readId(args.where, "clipId", single, false, clipIdValue, hasClipId, errCode, errMsg))
            return json();
        inspectClipsForLookup(app, budget);
        ConstClipRef clipRef;
        if (hasClipId && !ensureClip(app, clipIdValue, clipRef, errCode, errMsg))
            return json();
        if (single) {
            items.push_back(clipSummary(*clipRef.track, *clipRef.clip));
        } else {
            uint64_t trackId = 0;
            bool hasTrackId = false;
            std::string type, name;
            bool hasType = false, hasName = false;
            if (!readId(args.where, "trackId", false, false, trackId, hasTrackId, errCode, errMsg) ||
                !readString(args.where, "type", type, hasType, errCode, errMsg) ||
                !readString(args.where, "name", name, hasName, errCode, errMsg))
                return json();
            if (hasTrackId && !ensureTrack(app, trackId, errCode, errMsg))
                return json();
            if (hasType && type != "audio" && type != "midi") {
                fail(errCode, errMsg, "invalid_arguments", "where.type must be audio or midi");
                return json();
            }
            for (Track& track : app.model.project.tracks) {
                if (hasTrackId && track.id != trackId)
                    continue;
                for (const Clip& clip : track.clips) {
                    if (hasClipId && clipId(clip) != clipIdValue)
                        continue;
                    if (hasType && (type == "audio") != (asAudio(&clip) != nullptr))
                        continue;
                    const std::string& clipName = std::visit([](const auto& value) -> const std::string& {
                        return value.name;
                    }, clip);
                    if (hasName && clipName != name)
                        continue;
                    items.push_back(clipSummary(track, clip));
                }
            }
        }
        fields = clipFields();
    } else if (args.view == "notes") {
        if (!validateWhereKeys(args.where, {"clipId", "noteId", "pitch", "channel"}, errCode, errMsg))
            return json();
        uint64_t clipIdValue = 0, noteId = 0;
        bool hasClipId = false, hasNoteId = false;
        int pitch = 0, channel = 0;
        bool hasPitch = false, hasChannel = false;
        if (!readId(args.where, "clipId", true, false, clipIdValue, hasClipId, errCode, errMsg) ||
            !readId(args.where, "noteId", false, false, noteId, hasNoteId, errCode, errMsg) ||
            !readInteger(args.where, "pitch", 0, 127, pitch, hasPitch, errCode, errMsg) ||
            !readInteger(args.where, "channel", 0, 15, channel, hasChannel, errCode, errMsg))
            return json();
        inspectClipsForLookup(app, budget);
        ConstClipRef ref;
        if (!ensureClip(app, clipIdValue, ref, errCode, errMsg))
            return json();
        const MidiClip* midi = asMidi(ref.clip);
        if (!midi) {
            fail(errCode, errMsg, "invalid_target", "notes view requires a MIDI clip");
            return json();
        }
        budget.inspect(midi->notes.size(), "MIDI notes");
        bool foundId = !hasNoteId;
        for (const Note& note : midi->notes) {
            if (hasNoteId && note.id != noteId)
                continue;
            foundId = true;
            if (hasPitch && note.pitch != pitch)
                continue;
            if (hasChannel && note.channel != channel)
                continue;
            json item = toJson(note);
            item["clipId"] = clipIdValue;
            items.push_back(std::move(item));
        }
        if (!foundId) {
            fail(errCode, errMsg, "not_found", "noteId not found in clip: " + std::to_string(noteId));
            return json();
        }
        fields = {"id", "clipId", "pitch", "velocity", "startBeat", "lengthBeats", "channel"};
    } else if (args.view == "controllers") {
        if (!validateWhereKeys(args.where, {"clipId", "controllerId", "controller"}, errCode, errMsg))
            return json();
        uint64_t clipIdValue = 0, controllerId = 0;
        bool hasClipId = false, hasControllerId = false;
        int controller = 0;
        bool hasController = false;
        if (!readId(args.where, "clipId", true, false, clipIdValue, hasClipId, errCode, errMsg) ||
            !readId(args.where, "controllerId", false, false, controllerId, hasControllerId, errCode, errMsg) ||
            !readInteger(args.where, "controller", 0, 129, controller, hasController, errCode, errMsg))
            return json();
        inspectClipsForLookup(app, budget);
        ConstClipRef ref;
        if (!ensureClip(app, clipIdValue, ref, errCode, errMsg))
            return json();
        const MidiClip* midi = asMidi(ref.clip);
        if (!midi) {
            fail(errCode, errMsg, "invalid_target", "controllers view requires a MIDI clip");
            return json();
        }
        budget.inspect(midi->cc.size(), "MIDI controller events");
        bool foundId = !hasControllerId;
        for (const MidiCc& event : midi->cc) {
            if (hasControllerId && event.id != controllerId)
                continue;
            foundId = true;
            if (hasController && event.controller != controller)
                continue;
            json item = toJson(event);
            item["clipId"] = clipIdValue;
            items.push_back(std::move(item));
        }
        if (!foundId) {
            fail(errCode, errMsg, "not_found",
                 "controllerId not found in clip: " + std::to_string(controllerId));
            return json();
        }
        fields = {"id", "clipId", "controller", "beat", "value"};
    } else if (args.view == "automation") {
        if (!validateWhereKeys(args.where, {"trackId", "paramRef", "pointId"}, errCode, errMsg))
            return json();
        uint64_t trackId = 0, pointId = 0;
        bool hasTrackId = false, hasPointId = false;
        std::string paramRef;
        bool hasParamRef = false;
        if (!readId(args.where, "trackId", false, false, trackId, hasTrackId, errCode, errMsg) ||
            !readId(args.where, "pointId", false, false, pointId, hasPointId, errCode, errMsg) ||
            !readString(args.where, "paramRef", paramRef, hasParamRef, errCode, errMsg))
            return json();
        inspectTracks(app, budget);
        if (hasTrackId && !ensureTrack(app, trackId, errCode, errMsg))
            return json();
        bool foundPoint = !hasPointId;
        forEachTrack(app, [&](Track& track) {
            if (hasTrackId && track.id != trackId)
                return;
            budget.inspect(track.automation.size(), "automation lanes");
            for (const AutomationLane& lane : track.automation) {
                if (hasParamRef && lane.paramRef != paramRef)
                    continue;
                budget.inspect(lane.points.size(), "automation points");
                for (const AutomationPoint& point : lane.points) {
                    if (hasPointId && point.id != pointId)
                        continue;
                    foundPoint = true;
                    json item = toJson(point);
                    item["trackId"] = track.id;
                    item["trackName"] = track.name;
                    item["paramRef"] = lane.paramRef;
                    items.push_back(std::move(item));
                }
            }
        });
        if (!foundPoint) {
            fail(errCode, errMsg, "not_found", "pointId not found: " + std::to_string(pointId));
            return json();
        }
        fields = {"id", "trackId", "trackName", "paramRef", "beat", "value", "curve"};
    } else if (args.view == "markers") {
        if (!validateWhereKeys(args.where, {"markerId", "name"}, errCode, errMsg))
            return json();
        uint64_t markerId = 0;
        bool hasMarkerId = false;
        std::string name;
        bool hasName = false;
        if (!readId(args.where, "markerId", false, false, markerId, hasMarkerId, errCode, errMsg) ||
            !readString(args.where, "name", name, hasName, errCode, errMsg))
            return json();
        budget.inspect(app.model.project.markers.size(), "markers");
        if (hasMarkerId && !app.model.markerById(markerId)) {
            fail(errCode, errMsg, "not_found", "markerId not found: " + std::to_string(markerId));
            return json();
        }
        for (const Marker& marker : app.model.project.markers) {
            if (hasMarkerId && marker.id != markerId)
                continue;
            if (hasName && marker.name != name)
                continue;
            items.push_back(toJson(marker));
        }
        fields = {"id", "beat", "name", "color"};
    } else if (args.view == "assets") {
        if (!validateWhereKeys(args.where, {"assetId", "missing"}, errCode, errMsg))
            return json();
        uint64_t assetId = 0;
        bool hasAssetId = false;
        bool missing = false, hasMissing = false;
        if (!readId(args.where, "assetId", false, false, assetId, hasAssetId, errCode, errMsg) ||
            !readBool(args.where, "missing", missing, hasMissing, errCode, errMsg))
            return json();
        budget.inspect(app.model.project.assets.size(), "assets");
        if (hasAssetId && !app.model.assetById(assetId)) {
            fail(errCode, errMsg, "not_found", "assetId not found: " + std::to_string(assetId));
            return json();
        }
        for (const Asset& asset : app.model.project.assets) {
            if (hasAssetId && asset.id != assetId)
                continue;
            if (hasMissing && asset.missing != missing)
                continue;
            items.push_back(toJson(asset));
        }
        fields = {"id", "file", "originalPath", "sampleRate", "channels", "lengthSamples", "missing"};
    } else if (args.view == "vcas" || args.view == "vca") {
        if (!validateWhereKeys(args.where, {"vcaId", "name"}, errCode, errMsg))
            return json();
        uint64_t vcaId = 0;
        bool hasVcaId = false;
        std::string name;
        bool hasName = false;
        if (!readId(args.where, "vcaId", false, false, vcaId, hasVcaId, errCode, errMsg) ||
            !readString(args.where, "name", name, hasName, errCode, errMsg))
            return json();
        budget.inspect(app.model.project.vcas.size(), "VCAs");
        if (hasVcaId && !app.model.vcaById(vcaId)) {
            fail(errCode, errMsg, "not_found", "vcaId not found: " + std::to_string(vcaId));
            return json();
        }
        for (const Vca& vca : app.model.project.vcas) {
            if (hasVcaId && vca.id != vcaId)
                continue;
            if (hasName && vca.name != name)
                continue;
            items.push_back(json{{"id", vca.id}, {"name", vca.name}, {"gain", vca.gain}});
        }
        fields = {"id", "name", "gain"};
    } else if (args.view == "take_folders" || args.view == "takes") {
        if (!validateWhereKeys(args.where, {"trackId", "folderId"}, errCode, errMsg))
            return json();
        uint64_t trackId = 0, folderId = 0;
        bool hasTrackId = false, hasFolderId = false;
        if (!readId(args.where, "trackId", false, false, trackId, hasTrackId, errCode, errMsg) ||
            !readId(args.where, "folderId", false, false, folderId, hasFolderId, errCode, errMsg))
            return json();
        inspectTracks(app, budget);
        if (hasTrackId && !ensureTrack(app, trackId, errCode, errMsg))
            return json();
        bool foundFolder = !hasFolderId;
        forEachTrack(app, [&](Track& track) {
            if (hasTrackId && track.id != trackId)
                return;
            budget.inspect(track.takeFolders.size(), "take folders");
            for (const TakeFolder& folder : track.takeFolders) {
                if (hasFolderId && folder.id != folderId)
                    continue;
                foundFolder = true;
                budget.inspect(folder.lanes.size(), "take lanes");
                budget.inspect(folder.comp.size(), "take comp segments");
                json lanes = json::array();
                std::size_t clipCount = 0;
                for (const TakeLane& lane : folder.lanes) {
                    budget.inspect(lane.clips.size(), "take-lane clips");
                    json clipIds = json::array();
                    for (const Clip& clip : lane.clips) {
                        clipIds.push_back(clipId(clip));
                        ++clipCount;
                    }
                    lanes.push_back(json{{"id", lane.id}, {"name", lane.name},
                                         {"clipIds", std::move(clipIds)}});
                }
                json comp = json::array();
                for (const CompSegment& segment : folder.comp)
                    comp.push_back(json{{"startBeat", segment.startBeat}, {"lane", segment.lane}});
                items.push_back(json{{"id", folder.id}, {"trackId", track.id},
                                     {"trackName", track.name}, {"name", folder.name},
                                     {"startBeat", folder.startBeat}, {"endBeat", folder.endBeat},
                                     {"laneCount", folder.lanes.size()}, {"clipCount", clipCount},
                                     {"lanes", std::move(lanes)}, {"comp", std::move(comp)}});
            }
        });
        if (!foundFolder) {
            fail(errCode, errMsg, "not_found", "folderId not found: " + std::to_string(folderId));
            return json();
        }
        fields = {"id", "trackId", "trackName", "name", "startBeat", "endBeat",
                  "laneCount", "clipCount", "lanes", "comp"};
    } else if (args.view == "routing") {
        if (!validateWhereKeys(args.where, {"trackId", "type"}, errCode, errMsg))
            return json();
        uint64_t trackId = 0;
        bool hasTrackId = false;
        std::string type;
        bool hasType = false;
        if (!readId(args.where, "trackId", false, false, trackId, hasTrackId, errCode, errMsg) ||
            !readString(args.where, "type", type, hasType, errCode, errMsg))
            return json();
        inspectTracks(app, budget);
        if (hasTrackId && !ensureTrack(app, trackId, errCode, errMsg))
            return json();
        if (hasType && type != "output" && type != "midi" && type != "vca" && type != "send") {
            fail(errCode, errMsg, "invalid_arguments",
                 "where.type must be output, midi, vca, or send");
            return json();
        }
        forEachTrack(app, [&](Track& track) {
            if (hasTrackId && track.id != trackId)
                return;
            if (!hasType || type == "output")
                items.push_back(json{{"trackId", track.id}, {"trackName", track.name},
                                     {"type", "output"}, {"target", toJson(track.outputTarget)}});
            if (track.midiTarget != 0 && (!hasType || type == "midi"))
                items.push_back(json{{"trackId", track.id}, {"trackName", track.name},
                                     {"type", "midi"}, {"target", track.midiTarget}});
            if (track.vcaId != 0 && (!hasType || type == "vca"))
                items.push_back(json{{"trackId", track.id}, {"trackName", track.name},
                                     {"type", "vca"}, {"target", track.vcaId}});
            if (!hasType || type == "send") {
                budget.inspect(track.sends.size(), "track sends");
                for (std::size_t index = 0; index < track.sends.size(); ++index) {
                    const Send& send = track.sends[index];
                    items.push_back(json{{"trackId", track.id}, {"trackName", track.name},
                                         {"type", "send"}, {"target", send.destTrackId},
                                         {"sendIndex", index}, {"level", send.level},
                                         {"pre", send.pre}, {"enabled", send.enabled}});
                }
            }
        });
        fields = {"trackId", "trackName", "type", "target", "sendIndex", "level", "pre", "enabled"};
    } else if (args.view == "sends") {
        if (!validateWhereKeys(args.where, {"trackId", "sendIndex", "destTrackId"},
                               errCode, errMsg))
            return json();
        uint64_t trackId = 0, sendIndexValue = 0, destTrackId = 0;
        bool hasTrackId = false, hasSendIndex = false, hasDestTrackId = false;
        if (!readId(args.where, "trackId", false, false, trackId, hasTrackId, errCode, errMsg) ||
            !readId(args.where, "sendIndex", false, true, sendIndexValue, hasSendIndex,
                    errCode, errMsg) ||
            !readId(args.where, "destTrackId", false, false, destTrackId, hasDestTrackId,
                    errCode, errMsg))
            return json();
        inspectTracks(app, budget);
        if (hasTrackId && !ensureTrack(app, trackId, errCode, errMsg))
            return json();
        if (hasDestTrackId && !ensureTrack(app, destTrackId, errCode, errMsg))
            return json();
        bool foundIndex = !hasSendIndex;
        forEachTrack(app, [&](Track& track) {
            if (hasTrackId && track.id != trackId)
                return;
            budget.inspect(track.sends.size(), "track sends");
            for (std::size_t index = 0; index < track.sends.size(); ++index) {
                if (hasSendIndex && index != sendIndexValue)
                    continue;
                foundIndex = true;
                const Send& send = track.sends[index];
                if (hasDestTrackId && send.destTrackId != destTrackId)
                    continue;
                items.push_back(json{{"trackId", track.id}, {"trackName", track.name},
                                     {"sendIndex", index}, {"destTrackId", send.destTrackId},
                                     {"level", send.level}, {"pre", send.pre},
                                     {"enabled", send.enabled}});
            }
        });
        if (!foundIndex) {
            fail(errCode, errMsg, "not_found",
                 "sendIndex not found" + (hasTrackId ? " on trackId " + std::to_string(trackId)
                                                         : std::string()));
            return json();
        }
        fields = {"trackId", "trackName", "sendIndex", "destTrackId", "level", "pre", "enabled"};
    } else if (args.view == "plugin_instances") {
        if (!validateWhereKeys(args.where, {"instanceId", "trackId", "uid", "format"}, errCode, errMsg))
            return json();
        uint64_t instanceId = 0, trackId = 0;
        bool hasInstanceId = false, hasTrackId = false;
        std::string uid, format;
        bool hasUid = false, hasFormat = false;
        if (!readId(args.where, "instanceId", false, false, instanceId, hasInstanceId, errCode, errMsg) ||
            !readId(args.where, "trackId", false, false, trackId, hasTrackId, errCode, errMsg) ||
            !readString(args.where, "uid", uid, hasUid, errCode, errMsg) ||
            !readString(args.where, "format", format, hasFormat, errCode, errMsg))
            return json();
        inspectPluginsForLookup(app, budget);
        if (hasTrackId && !ensureTrack(app, trackId, errCode, errMsg))
            return json();
        if (hasInstanceId && !app.model.pluginByInstanceId(instanceId)) {
            fail(errCode, errMsg, "not_found", "instanceId not found: " + std::to_string(instanceId));
            return json();
        }
        if (hasFormat && format != "vst2" && format != "vst3" && format != "builtin") {
            fail(errCode, errMsg, "invalid_arguments", "where.format is not a plugin format");
            return json();
        }
        forEachTrack(app, [&](Track& track) {
            if (hasTrackId && track.id != trackId)
                return;
            for (std::size_t index = 0; index < track.inserts.size(); ++index) {
                const PluginInstance& plugin = track.inserts[index];
                if (hasInstanceId && plugin.instanceId != instanceId)
                    continue;
                if (hasUid && plugin.uid != uid)
                    continue;
                if (hasFormat && plugin.format != format)
                    continue;
                json item = pluginSummary(plugin);
                item["trackId"] = track.id;
                item["trackName"] = track.name;
                item["slotIndex"] = index;
                item["live"] = pluginIsLive(app, plugin.instanceId);
                items.push_back(std::move(item));
            }
        });
        fields = {"instanceId", "uid", "format", "path", "bitness", "name", "version",
                  "sourceHint", "bypass", "wetDry", "stateFile", "sampleAssetId",
                  "sidechainSource", "parameterValueCount", "trackId", "trackName",
                  "slotIndex", "live"};
    } else if (args.view == "plugin_params") {
        if (!validateWhereKeys(args.where, {"instanceId", "paramId"}, errCode, errMsg))
            return json();
        uint64_t instanceId = 0, paramId = 0;
        bool hasInstanceId = false, hasParamId = false;
        if (!readId(args.where, "instanceId", true, false, instanceId, hasInstanceId,
                    errCode, errMsg) ||
            !readId(args.where, "paramId", false, true, paramId, hasParamId, errCode, errMsg))
            return json();
        inspectPluginsForLookup(app, budget);
        Track* owner = nullptr;
        PluginInstance* plugin = app.model.pluginByInstanceId(instanceId, &owner);
        if (!plugin || !owner) {
            fail(errCode, errMsg, "not_found", "instanceId not found: " + std::to_string(instanceId));
            return json();
        }
        json liveParams = json::array();
        if (app.builtin && app.builtin->has(instanceId))
            liveParams = app.builtin->getParams(instanceId);
        else if (app.host && app.host->node(instanceId))
            liveParams = app.host->getParams(instanceId);
        bool foundParam = !hasParamId;
        if (liveParams.is_array() && !liveParams.empty()) {
            budget.inspect(liveParams.size(), "live plugin parameters");
            for (const json& param : liveParams) {
                if (!param.is_object() || !param.contains("id"))
                    continue;
                uint64_t id = 0;
                if (!parseNonNegativeInteger(param["id"], id))
                    continue;
                if (hasParamId && id != paramId)
                    continue;
                foundParam = true;
                json item = param;
                item["instanceId"] = instanceId;
                item["trackId"] = owner->id;
                item["trackName"] = owner->name;
                item["source"] = "live";
                items.push_back(std::move(item));
            }
        } else {
            budget.inspect(plugin->paramValues.size(), "model plugin parameters");
            for (const auto& [id, value] : plugin->paramValues) {
                if (hasParamId && id != paramId)
                    continue;
                foundParam = true;
                items.push_back(json{{"id", id}, {"value", value}, {"instanceId", instanceId},
                                     {"trackId", owner->id}, {"trackName", owner->name},
                                     {"source", "model"}});
            }
        }
        if (!foundParam) {
            fail(errCode, errMsg, "not_found", "paramId not found: " + std::to_string(paramId));
            return json();
        }
        fields = {"id", "instanceId", "trackId", "trackName", "name", "label", "value",
                  "defaultValue", "steps", "valueText", "source"};
    } else if (args.view == "plugin_presets") {
        if (!validateWhereKeys(args.where, {"instanceId", "presetId"}, errCode, errMsg))
            return json();
        uint64_t instanceId = 0;
        json presetId;
        bool hasInstanceId = false, hasPresetId = false;
        if (!readId(args.where, "instanceId", true, false, instanceId, hasInstanceId,
                    errCode, errMsg) ||
            !readNumberOrStringId(args.where, "presetId", presetId, hasPresetId,
                                  errCode, errMsg))
            return json();
        inspectPluginsForLookup(app, budget);
        Track* owner = nullptr;
        PluginInstance* plugin = app.model.pluginByInstanceId(instanceId, &owner);
        if (!plugin || !owner) {
            fail(errCode, errMsg, "not_found", "instanceId not found: " + std::to_string(instanceId));
            return json();
        }
        bool foundPreset = !hasPresetId;
        if (app.builtin && app.builtin->has(instanceId)) {
            // Built-ins expose factory presets (id = table index; loadable via
            // plugin/loadPreset like hosted-plugin presets).
            const auto& fp = builtinFactoryPresets(plugin->uid);
            if (fp.empty()) {
                if (!hasPresetId)
                    items.push_back(json{{"instanceId", instanceId}, {"trackId", owner->id},
                                         {"trackName", owner->name}, {"supported", false},
                                         {"reason", "this built-in plugin has no presets"}});
            } else {
                budget.inspect(fp.size(), "plugin presets");
                for (size_t i = 0; i < fp.size(); ++i) {
                    const json idJ = static_cast<int>(i);
                    if (hasPresetId && idJ != presetId)
                        continue;
                    foundPreset = true;
                    items.push_back(json{{"id", idJ}, {"instanceId", instanceId},
                                         {"trackId", owner->id}, {"trackName", owner->name},
                                         {"name", fp[i].name}, {"supported", true}});
                }
            }
        } else if (app.host && app.host->node(instanceId)) {
            const json presets = app.host->getPresets(instanceId);
            if (presets.is_array() && !presets.empty()) {
                budget.inspect(presets.size(), "plugin presets");
                for (const json& preset : presets) {
                    if (!preset.is_object() || !preset.contains("id"))
                        continue;
                    const json& id = preset["id"];
                    uint64_t numericId = 0;
                    const bool validStringId = id.is_string() && !id.get_ref<const std::string&>().empty();
                    const bool validNumberId = parseNonNegativeInteger(id, numericId);
                    if (!validStringId && !validNumberId)
                        continue;
                    if (hasPresetId && id != presetId)
                        continue;
                    foundPreset = true;
                    json item = preset;
                    item["instanceId"] = instanceId;
                    item["trackId"] = owner->id;
                    item["trackName"] = owner->name;
                    item["supported"] = true;
                    items.push_back(std::move(item));
                }
            } else if (!hasPresetId) {
                items.push_back(json{{"instanceId", instanceId}, {"trackId", owner->id},
                                     {"trackName", owner->name}, {"supported", json()},
                                     {"reason", "live plugin returned no preset metadata"}});
            }
        } else if (!hasPresetId) {
            items.push_back(json{{"instanceId", instanceId}, {"trackId", owner->id},
                                 {"trackName", owner->name}, {"supported", false},
                                 {"reason", "plugin instance is not live"}});
        }
        if (!foundPreset) {
            fail(errCode, errMsg, "not_found", "presetId not found: " + presetId.dump());
            return json();
        }
        fields = {"id", "instanceId", "trackId", "trackName", "name", "supported", "reason"};
    } else if (args.view == "plugin_registry") {
        if (!validateWhereKeys(args.where,
                               {"uid", "format", "bitness", "isInstrument", "blacklisted",
                                "name", "search"},
                               errCode, errMsg))
            return json();
        std::string uid, format, name, search;
        bool hasUid = false, hasFormat = false, hasName = false, hasSearch = false;
        int bitness = 0;
        bool hasBitness = false;
        bool instrument = false, blacklisted = false;
        bool hasInstrument = false, hasBlacklisted = false;
        if (!readString(args.where, "uid", uid, hasUid, errCode, errMsg) ||
            !readString(args.where, "format", format, hasFormat, errCode, errMsg) ||
            !readString(args.where, "name", name, hasName, errCode, errMsg) ||
            !readString(args.where, "search", search, hasSearch, errCode, errMsg) ||
            !readInteger(args.where, "bitness", 32, 64, bitness, hasBitness, errCode, errMsg) ||
            !readBool(args.where, "isInstrument", instrument, hasInstrument, errCode, errMsg) ||
            !readBool(args.where, "blacklisted", blacklisted, hasBlacklisted, errCode, errMsg))
            return json();
        if (hasBitness && bitness != 32 && bitness != 64) {
            fail(errCode, errMsg, "invalid_arguments", "where.bitness must be 32 or 64");
            return json();
        }
        if (hasFormat && format != "vst2" && format != "vst3" && format != "builtin") {
            fail(errCode, errMsg, "invalid_arguments", "where.format is not a plugin format");
            return json();
        }
        const std::string searchLower = hasSearch ? asciiLower(search) : std::string();
        budget.inspect(app.registry.size(), "plugin registry entries");
        const std::vector<PluginInfo> registry = app.registry.list();
        for (const PluginInfo& plugin : registry) {
            if (hasUid && plugin.uid != uid)
                continue;
            if (hasFormat && plugin.format != format)
                continue;
            if (hasName && plugin.name != name)
                continue;
            if (hasSearch) {
                const bool matches = asciiLower(plugin.name).find(searchLower) != std::string::npos ||
                                     asciiLower(plugin.vendor).find(searchLower) != std::string::npos ||
                                     asciiLower(plugin.category).find(searchLower) != std::string::npos ||
                                     asciiLower(plugin.uid).find(searchLower) != std::string::npos;
                if (!matches)
                    continue;
            }
            if (hasBitness && plugin.bitness != bitness)
                continue;
            if (hasInstrument && plugin.isInstrument != instrument)
                continue;
            if (hasBlacklisted && plugin.blacklisted != blacklisted)
                continue;
            items.push_back(plugin.toJson());
        }
        fields = {"uid", "format", "path", "bitness", "name", "vendor", "category",
                  "isInstrument", "numInputs", "numOutputs", "blacklisted", "blacklistReason"};
    } else if (args.view == "transport") {
        if (!validateWhereKeys(args.where, {}, errCode, errMsg))
            return json();
        items.push_back(app.transportJson());
        fields = objectFields(items.front());
    } else if (args.view == "engine_status") {
        if (!validateWhereKeys(args.where, {}, errCode, errMsg))
            return json();
        items.push_back(app.engineStatus());
        fields = objectFields(items.front());
    } else if (args.view == "audio_devices") {
        if (!validateWhereKeys(args.where, {"type", "available"}, errCode, errMsg))
            return json();
        std::string type;
        bool hasType = false;
        bool available = false, hasAvailable = false;
        if (!readString(args.where, "type", type, hasType, errCode, errMsg) ||
            !readBool(args.where, "available", available, hasAvailable, errCode, errMsg))
            return json();
        if (hasType && type != "wasapi" && type != "asio") {
            fail(errCode, errMsg, "invalid_arguments", "where.type must be wasapi or asio");
            return json();
        }
        const json snapshot = app.devicesJson();
        if (snapshot.is_object() && snapshot.contains("drivers") && snapshot["drivers"].is_array()) {
            budget.inspect(snapshot["drivers"].size(), "audio drivers");
            for (const json& driver : snapshot["drivers"]) {
                if (!driver.is_object())
                    continue;
                if (hasType && getOr(driver, "type", "") != type)
                    continue;
                if (hasAvailable && getOr<bool>(driver, "available", false) != available)
                    continue;
                items.push_back(driver);
            }
        }
        fields = {"type", "available", "reason", "devices"};
    } else if (args.view == "midi_inputs") {
        if (!validateWhereKeys(args.where, {"id", "name", "enabled"}, errCode, errMsg))
            return json();
        std::string id, name;
        bool hasId = false, hasName = false;
        bool enabled = false, hasEnabled = false;
        if (!readString(args.where, "id", id, hasId, errCode, errMsg) ||
            !readString(args.where, "name", name, hasName, errCode, errMsg) ||
            !readBool(args.where, "enabled", enabled, hasEnabled, errCode, errMsg))
            return json();
        bool foundId = !hasId;
        const std::vector<MidiInDeviceInfo> midiInputs = app.midiInput.devices();
        budget.inspect(midiInputs.size(), "MIDI inputs");
        for (const MidiInDeviceInfo& device : midiInputs) {
            if (hasId && device.id != id)
                continue;
            foundId = true;
            if (hasName && device.name != name)
                continue;
            if (hasEnabled && device.enabled != enabled)
                continue;
            items.push_back(json{{"id", device.id}, {"name", device.name},
                                 {"enabled", device.enabled}});
        }
        if (!foundId) {
            fail(errCode, errMsg, "not_found", "MIDI input id not found: " + id);
            return json();
        }
        fields = {"id", "name", "enabled"};
    } else if (args.view == "midi_maps") {
        if (!validateWhereKeys(args.where, {"type", "paramRef"}, errCode, errMsg))
            return json();
        std::string type, paramRef;
        bool hasType = false, hasParamRef = false;
        if (!readString(args.where, "type", type, hasType, errCode, errMsg) ||
            !readString(args.where, "paramRef", paramRef, hasParamRef, errCode, errMsg))
            return json();
        if (hasType && type != "mapping" && type != "learn_arm") {
            fail(errCode, errMsg, "invalid_arguments", "where.type must be mapping or learn_arm");
            return json();
        }
        const std::string& armed = app.midiLearnArm();
        budget.inspect(app.model.project.midiMaps.size() + 1, "MIDI maps and learn arm");
        if ((!hasType || type == "learn_arm") && (!hasParamRef || armed == paramRef))
            items.push_back(json{{"type", "learn_arm"},
                                 {"paramRef", armed.empty() ? json() : json(armed)},
                                 {"armed", !armed.empty()}});
        if (!hasType || type == "mapping")
            for (const MidiMap& mapping : app.model.project.midiMaps) {
                if (hasParamRef && mapping.paramRef != paramRef)
                    continue;
                items.push_back(json{{"type", "mapping"}, {"cc", mapping.cc},
                                     {"channel", mapping.channel}, {"paramRef", mapping.paramRef},
                                     {"armed", !armed.empty() && armed == mapping.paramRef}});
            }
        fields = {"type", "cc", "channel", "paramRef", "armed"};
    } else if (args.view == "recent_projects") {
        if (!validateWhereKeys(args.where, {"path", "name"}, errCode, errMsg))
            return json();
        std::string path, name;
        bool hasPath = false, hasName = false;
        if (!readString(args.where, "path", path, hasPath, errCode, errMsg) ||
            !readString(args.where, "name", name, hasName, errCode, errMsg))
            return json();
        const json recent = app.projectIO.recentProjects();
        if (recent.is_array()) {
            budget.inspect(recent.size(), "recent projects");
            for (const json& project : recent) {
                if (!project.is_object())
                    continue;
                if (hasPath && getOr(project, "path", "") != path)
                    continue;
                if (hasName && getOr(project, "name", "") != name)
                    continue;
                items.push_back(project);
            }
        }
        fields = {"path", "name", "mtime"};
    } else if (args.view == "settings") {
        if (!validateWhereKeys(args.where, {}, errCode, errMsg))
            return json();
        json settings = boundedRedactedCopy(app.settings.get(), budget);
        fields = objectFields(settings);
        items.push_back(std::move(settings));
    } else if (args.view == "unresolved_plugins") {
        if (!validateWhereKeys(args.where, {"instanceId", "trackId", "uid"}, errCode, errMsg))
            return json();
        uint64_t instanceId = 0, trackId = 0;
        bool hasInstanceId = false, hasTrackId = false;
        std::string uid;
        bool hasUid = false;
        if (!readId(args.where, "instanceId", false, false, instanceId, hasInstanceId, errCode, errMsg) ||
            !readId(args.where, "trackId", false, false, trackId, hasTrackId, errCode, errMsg) ||
            !readString(args.where, "uid", uid, hasUid, errCode, errMsg))
            return json();
        inspectPluginsForLookup(app, budget);
        if (hasTrackId && !ensureTrack(app, trackId, errCode, errMsg))
            return json();
        if (hasInstanceId && !app.model.pluginByInstanceId(instanceId)) {
            fail(errCode, errMsg, "not_found", "instanceId not found: " + std::to_string(instanceId));
            return json();
        }
        forEachTrack(app, [&](Track& track) {
            if (hasTrackId && track.id != trackId)
                return;
            for (std::size_t index = 0; index < track.inserts.size(); ++index) {
                const PluginInstance& plugin = track.inserts[index];
                if (pluginIsLive(app, plugin.instanceId))
                    continue;
                if (hasInstanceId && plugin.instanceId != instanceId)
                    continue;
                if (hasUid && plugin.uid != uid)
                    continue;
                const bool hasState = app.orphanPluginStates.count(plugin.instanceId) > 0 ||
                                      !plugin.stateFile.empty() || !plugin.paramValues.empty();
                const PluginInfo* registered = app.registry.byUid(plugin.uid);
                json item{{"instanceId", plugin.instanceId}, {"name", plugin.name},
                          {"uid", plugin.uid}, {"format", plugin.format},
                          {"bitness", plugin.bitness}, {"trackId", track.id},
                          {"trackName", track.name}, {"slotIndex", index},
                          {"hasState", hasState}, {"inRegistry", registered != nullptr}};
                if (!plugin.version.empty())
                    item["version"] = plugin.version;
                if (!plugin.sourceHint.empty())
                    item["source"] = plugin.sourceHint;
                items.push_back(std::move(item));
            }
        });
        fields = {"instanceId", "name", "uid", "format", "bitness", "trackId", "trackName",
                  "slotIndex", "hasState", "inRegistry", "version", "source"};
    } else if (args.view == "logs") {
        if (!validateWhereKeys(args.where, {"level", "contains"}, errCode, errMsg))
            return json();
        std::string level, contains;
        bool hasLevel = false, hasContains = false;
        if (!readString(args.where, "level", level, hasLevel, errCode, errMsg) ||
            !readString(args.where, "contains", contains, hasContains, errCode, errMsg))
            return json();
        if (hasLevel && level != "info" && level != "warn" && level != "error") {
            fail(errCode, errMsg, "invalid_arguments", "where.level must be info, warn, or error");
            return json();
        }
        const std::vector<std::string> logLines = Log::tail(Log::kRingCapacity);
        budget.inspect(logLines.size(), "log lines");
        for (const std::string& line : logLines) {
            std::string lineLevel = "info";
            if (line.find(" [warn ] ") != std::string::npos)
                lineLevel = "warn";
            else if (line.find(" [error] ") != std::string::npos)
                lineLevel = "error";
            if (hasLevel && lineLevel != level)
                continue;
            if (hasContains && line.find(contains) == std::string::npos)
                continue;
            items.push_back(json{{"level", lineLevel}, {"line", line}});
        }
        fields = {"level", "line"};
    } else {
        fail(errCode, errMsg, "unknown_view", "unknown query view: " + args.view);
        return json();
    }

    return finishQuery(app, args,
                       std::move(static_cast<std::vector<json>&>(items)), fields,
                       errCode, errMsg);
    } catch (const QueryLimitExceeded& error) {
        fail(errCode, errMsg, "query_too_broad", error.what());
        return json();
    }
}

} // namespace mydaw
