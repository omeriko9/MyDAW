// MyDAW — server/Api.cpp (E9). See Api.h.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include "server/Api.h"

#include <windows.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <vector>

#include "App.h"
#include "agent/AgentQuery.h"
#include "export/CprWriter.h"
#include "export/TrackArchiveWriter.h"
#include "import/ImportProvider.h"
#include "media/AudioEncoder.h"
#include "media/Loudness.h"
#include "media/WavWriter.h"
#include "midi/SmfReader.h"
#include "midi/SmfTrackPlan.h"
#include "midi/SmfWriter.h"
#include "core/effects/BuiltinEffectManager.h"
#include "core/effects/Effects.h" // builtinFactoryPresets
#include "plugins/HostProcess.h"
#include "util/Dialogs.h"
#include "util/Log.h"
#include "util/Paths.h"
#include "util/Spawn.h"

namespace mydaw {

namespace {

std::string fileStem(const std::string& path) {
    std::string name = fileName(path);
    const size_t dot = name.find_last_of('.');
    if (dot != std::string::npos && dot > 0)
        name.resize(dot);
    return name;
}

bool isMidiFileExt(const std::string& path) {
    const std::string ext = fileExtension(path);
    return ext == ".mid" || ext == ".midi";
}

// Extensions media-import (AssetStore + SMF) already handles. A foreign-project provider
// whose extension is NOT in here is "project-only" — importing it as a clip is the .cpr bug.
bool isMediaOrMidiExt(const std::string& extNoDot) {
    static const char* kHandled[] = {
        "wav", "wave", "bwf", "mp3", "flac", "aif", "aiff", "aifc", "m4a",  "aac",
        "ogg", "oga",  "wma", "mid", "midi", "smf",  "rmi"}; // mirrors UI MEDIA_EXTS + MIDI
    for (const char* h : kHandled)
        if (extNoDot == h)
            return true;
    return false;
}

// If `path`'s extension is claimed by a registered foreign-project provider AND is not a
// media/MIDI format, returns that provider's display name (it must be opened via Import
// Project, not Import Files). Empty string otherwise.
std::string projectOnlyProviderName(const std::string& path) {
    std::string ext = fileExtension(path); // ".cpr"
    if (ext.size() > 1 && ext.front() == '.')
        ext.erase(ext.begin());
    if (ext.empty() || isMediaOrMidiExt(ext))
        return std::string();
    for (const ImportProvider* prov : ImportProviderRegistry::instance().all())
        for (const std::string& e : prov->extensions())
            if (e == ext)
                return prov->displayName();
    return std::string();
}

// Brief, greppable, single-line payload summary for the [ws] action log. NEVER dumps large
// blobs/base64/audio: known big fields (chunk/state/pcm/data/base64/bytes) are reduced to
// their byte size; everything else is the compact JSON, then truncated to ~200 chars.
std::string summarizePayload(const json& p) {
    if (!p.is_object() || p.empty())
        return "{}";
    static const char* kBigFields[] = {"chunk",  "chunks", "state", "pcm",
                                       "data",   "base64", "bytes", "blob"};
    json brief = json::object();
    for (auto it = p.begin(); it != p.end(); ++it) {
        const std::string& key = it.key();
        bool big = false;
        for (const char* bf : kBigFields)
            if (key == bf) {
                big = true;
                break;
            }
        if (big && it.value().is_string())
            brief[key] = "<" + std::to_string(it.value().get_ref<const std::string&>().size()) +
                         "B>";
        else if (big)
            brief[key] = "<blob>";
        else if (it.value().is_string() && it.value().get_ref<const std::string&>().size() > 120)
            brief[key] = it.value().get_ref<const std::string&>().substr(0, 120) + "...";
        else
            brief[key] = it.value();
    }
    // replace handler: the substr(0, 120) above can split a multi-byte UTF-8 character —
    // a strict dump would throw on the main thread for ANY message carrying such a string.
    std::string s = brief.dump(-1, ' ', false, json::error_handler_t::replace);
    if (s.size() > 200)
        s = s.substr(0, 200) + "...";
    return s;
}

} // namespace

// One decoded import source (audio asset OR parsed SMF).
struct Api::ImportItem {
    bool isMid = false;
    bool ok = false;
    Asset asset;         // audio: filled by AssetStore::importFile (id pre-assigned)
    SmfData smf;         // midi
    std::string display; // progress/clip naming
    std::string err;
};

Api::Api(App& app) : app_(app) {}

json Api::okEnv(int64_t id, json payload) {
    return json{{"replyTo", id}, {"ok", true}, {"payload", std::move(payload)}};
}

json Api::errEnv(int64_t id, const std::string& code, const std::string& msg) {
    return json{{"replyTo", id},
                {"ok", false},
                {"error", json{{"code", code}, {"message", msg.empty() ? code : msg}}}};
}

bool Api::isBusyGuarded(const std::string& type) {
    if (type.rfind("cmd/", 0) == 0 || type.rfind("edit/", 0) == 0 ||
        type.rfind("media/", 0) == 0 || type == "agent/batch")
        return true;
    return type == "transport/play" || type == "transport/record" ||
           type == "project/load" || type == "project/loadRecent" ||
           type == "project/new" || type == "project/recover" ||
           type == "project/saveAs" || type == "project/importForeign" ||
           type == "plugins/recreate";
}

void Api::handleMessage(const json& msg, HttpWsServer::RespondFn respond) {
    const int64_t id = getOr<int64_t>(msg, "id", -1);
    const std::string type = getOr(msg, "type", "");
    json payload = json::object();
    if (msg.is_object() && msg.contains("payload") && msg["payload"].is_object())
        payload = msg["payload"];

    // [ws] action log (always at info): inbound request + outcome + duration. The respond
    // wrapper reports the completion for BOTH synchronous and deferred (worker) replies,
    // since every reply flows through respond(); duration is measured to that call.
    Log::info("[ws] -> %s%s", type.empty() ? "<no-type>" : type.c_str(),
              (" " + summarizePayload(payload)).c_str());
    const auto t0 = std::chrono::steady_clock::now();
    HttpWsServer::RespondFn loggedRespond = [type, t0, respond](json reply) {
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - t0)
                            .count();
        const bool ok = reply.is_object() && reply.value("ok", false);
        if (ok) {
            Log::info("[ws] %s ok %lldms", type.c_str(), static_cast<long long>(ms));
        } else {
            std::string code = "error";
            if (reply.is_object() && reply.contains("error") && reply["error"].is_object())
                code = reply["error"].value("code", code);
            Log::info("[ws] %s ERR %s %lldms", type.c_str(), code.c_str(),
                      static_cast<long long>(ms));
        }
        respond(std::move(reply));
    };

    bool deferred = false;
    std::string ec, em;
    json reply = dispatch(type, payload, msg, id, loggedRespond, deferred, ec, em);
    if (deferred)
        return; // a worker owns the reply (and the loggedRespond wrapper logs its outcome)
    if (!ec.empty())
        loggedRespond(errEnv(id, ec, em));
    else
        loggedRespond(okEnv(id, std::move(reply)));
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

json Api::dispatch(const std::string& type, const json& p, const json& msg, int64_t id,
                   HttpWsServer::RespondFn& respond, bool& deferred, std::string& ec,
                   std::string& em) {
    if (type.empty()) {
        ec = "bad_request";
        em = "missing message type";
        return json();
    }

    if (app_.isExporting() && isBusyGuarded(type)) {
        ec = "busy_exporting";
        em = "an export is in progress";
        return json();
    }

    // Internal agent primitives. These intentionally remain outside RequestMap and the
    // public capability catalog: the MCP/LLM tool layer is their typed external surface.
    if (type == "agent/query")
        return runAgentQuery(app_, p, ec, em);
    if (type == "agent/batch")
        return app_.cmd->executeBatch(p, ec, em);

    // --- §5.2/§5.3/§5.6 commands + edit/undo|redo: CommandProcessor owns them ----
    if (type.rfind("cmd/", 0) == 0 || type == "edit/undo" || type == "edit/redo") {
        const bool transient = getOr<bool>(msg, "transient", false);
        return app_.cmd->execute(type, p, transient, ec, em);
    }

    // --- §5.2 MIDI control surface / learn ----------------------------------------
    if (type == "midimap/learn") {
        app_.setMidiLearnArm(getOr<std::string>(p, "paramRef", ""));
        return app_.midiMapsJson();
    }
    if (type == "midimap/remove") {
        app_.removeMidiMap(getOr<std::string>(p, "paramRef", ""));
        return app_.midiMapsJson();
    }
    if (type == "midimap/feedCc") { // real MIDI or a software control surface / test
        app_.feedMidiCc(getOr<int>(p, "cc", 0), getOr<int>(p, "channel", -1),
                        std::clamp(getOr<int>(p, "value", 0), 0, 127));
        return json::object();
    }

    // --- §5.1 session & project ---------------------------------------------------
    if (type == "session/hello")
        return sessionHello();

    // Spawn a detached child engine on a free port for a new project window, then reply with
    // its URL once it is actually serving (worker thread so the main loop keeps ticking while
    // the child boots ~1-2 s). The requesting UI opens the tab from the returned url.
    if (type == "session/newWindow") {
        int port = 0;
        std::string werr;
        if (!app_.launchChildWindow(port, werr)) {
            ec = "spawn_failed";
            em = werr;
            return json();
        }
        deferred = true;
        HttpWsServer::RespondFn r = respond;
        app_.spawnWorker([this, id, port, r]() mutable {
            std::string e;
            if (waitForLoopbackPort(port, 8000, e))
                r(okEnv(id, json{{"url", "http://127.0.0.1:" + std::to_string(port) + "/"},
                                 {"port", port}}));
            else
                r(errEnv(id, "spawn_timeout", "new window did not start listening: " + e));
        });
        return json();
    }

    if (type == "project/new") {
        app_.prepareForModelReplace();
        std::string err;
        if (!app_.projectIO.newProject(app_.model, err))
            Log::warn("project/new: %s", err.c_str());
        app_.afterModelReplaced();
        return json{{"project", toJson(app_.model.project)}};
    }
    if (type == "project/load" || type == "project/loadRecent") {
        const std::string path = getOr(p, "path", "");
        if (path.empty()) {
            ec = "bad_request";
            em = "path required";
            return json();
        }
        return loadProjectPath(path, ec, em);
    }
    if (type == "project/save") {
        std::string err;
        if (!app_.projectIO.save(app_.model, err)) {
            ec = (err == "no_path") ? "no_path" : "save_failed";
            em = err;
            return json();
        }
        app_.projectIO.clearDirty();
        app_.autosave.resetTimer();
        return json{{"path", app_.projectIO.projectJsonPath()}};
    }
    if (type == "project/saveAs") {
        std::string path = getOr(p, "path", "");
        // auto:true — engine picks <Documents>\MyDAW Projects\<name> (deduped). Used by
        // the UI to silently save a never-saved project before load/import replaces it.
        if (path.empty() && getOr(p, "auto", false))
            path = app_.projectIO.defaultSaveAsDir(app_.model.project.name);
        if (path.empty()) {
            ec = "bad_request";
            em = "path required";
            return json();
        }
        std::string err;
        if (!app_.projectIO.saveAs(app_.model, path, err)) {
            ec = "save_failed";
            em = err;
            return json();
        }
        app_.projectIO.clearDirty();
        app_.autosave.resetTimer();
        app_.cmd->emitFullProjectChanged(); // project renamed after the folder
        return json{{"path", app_.projectIO.projectJsonPath()},
                    {"project", toJson(app_.model.project)}};
    }
    if (type == "project/recoveryInfo") {
        const ProjectIO::RecoveryInfo ri = app_.projectIO.recoveryInfo();
        return json{{"available", ri.available},
                    {"autosavePath", ri.autosavePath},
                    {"mtime", ri.mtime}};
    }
    if (type == "project/recover") {
        if (!app_.projectIO.recoveryInfo().available) {
            ec = "not_found";
            em = "no recovery data available";
            return json();
        }
        app_.prepareForModelReplace();
        std::string err;
        if (!app_.projectIO.recover(app_.model, err)) {
            std::string nerr;
            app_.projectIO.newProject(app_.model, nerr);
            app_.afterModelReplaced();
            ec = "recover_failed";
            em = err;
            return json();
        }
        app_.afterModelReplaced();
        app_.projectIO.markDirty(); // recovered changes are unsaved by definition
        return json{{"project", toJson(app_.model.project)}};
    }
    if (type == "project/getImportFormats") {
        json formats = json::array();
        for (const ImportProvider* prov : ImportProviderRegistry::instance().all())
            formats.push_back(json{{"id", prov->id()},
                                   {"name", prov->displayName()},
                                   {"extensions", prov->extensions()}});
        return json{{"formats", std::move(formats)}};
    }
    if (type == "project/importForeign") {
        const std::string path = getOr(p, "path", "");
        if (path.empty()) {
            ec = "bad_request";
            em = "path required";
            return json();
        }
        return importForeignPath(path, ec, em);
    }
    if (type == "project/getUnresolvedPlugins")
        return unresolvedPluginsJson();

    // --- §5.4 transport & engine ---------------------------------------------------
    if (type.rfind("transport/", 0) == 0)
        return handleTransport(type, p, ec, em);
    if (type.rfind("engine/", 0) == 0)
        return handleEngine(type, p, ec, em);

    // --- §5.5 recording & media ------------------------------------------------------
    if (type == "midi/getInputs") {
        json inputs = json::array();
        for (const MidiInDeviceInfo& d : app_.midiInput.devices())
            inputs.push_back(json{{"id", d.id}, {"name", d.name}, {"enabled", d.enabled}});
        return json{{"inputs", std::move(inputs)}};
    }
    if (type == "midi/setInputEnabled") {
        if (!app_.midiInput.setEnabled(getOr(p, "id", ""), getOr<bool>(p, "enabled", true))) {
            ec = "not_found";
            em = "unknown midi input id";
            return json();
        }
        return json::object();
    }
    if (type == "midi/preview") {
        // Live note injection into the track's MIDI path (audible while stopped,
        // regardless of arm). NOT undoable; no projectChanged.
        const uint64_t trackId = getOr<uint64_t>(p, "trackId", 0);
        if (!app_.model.trackById(trackId)) {
            ec = "not_found";
            em = "unknown trackId";
            return json();
        }
        const int pitch = std::clamp(getOr<int>(p, "pitch", 60), 0, 127);
        const int velocity = std::clamp(getOr<int>(p, "velocity", 100), 1, 127);
        app_.previewNote(trackId, pitch, velocity, getOr<bool>(p, "on", true));
        return json::object();
    }
    if (type == "media/import") {
        startMediaImport(p, id, respond, deferred, ec, em);
        return json();
    }
    if (type == "media/relink") {
        const uint64_t assetId = getOr<uint64_t>(p, "assetId", 0);
        const std::string newPath = getOr(p, "newPath", "");
        std::string err;
        if (!app_.projectIO.relink(app_.model, assetId, newPath, err)) {
            ec = "relink_failed";
            em = err;
            return json();
        }
        if (const Asset* a = app_.model.assetById(assetId)) {
            App* app = &app_;
            app_.assetStore.loadAsync(*a, [app](bool ok) {
                if (ok)
                    app->requestGraphRebuild();
            });
        }
        app_.cmd->emitFullProjectChanged();
        return json::object();
    }
    if (type == "export/render") {
        startExport(p, id, respond, deferred, ec, em);
        return json();
    }
    if (type == "export/midi") {
        // Fast synchronous SMF write — no busy_exporting guard needed (pinned).
        std::string path = getOr(p, "path", "");
        if (path.empty()) {
            // Native save dialog (blocks the main loop while open — audio keeps running).
            if (!Dialogs::saveFile("Export MIDI", {{"Standard MIDI File", "*.mid"}}, "mid",
                                   app_.model.project.name + ".mid", path)) {
                ec = "cancelled";
                em = "export cancelled";
                return json();
            }
        }
        std::string err;
        if (!SmfWriter::write(app_.model, path, err)) {
            ec = "export_failed";
            em = err.empty() ? "midi export failed" : err;
            return json();
        }
        Log::info("export: wrote %s", path.c_str());
        return json{{"path", path}};
    }
    if (type == "export/trackArchive") {
        // Cubase Track Archive XML (File > Import > Track Archive on the Cubase side).
        // Fast synchronous write — same shape as export/midi.
        std::string path = getOr(p, "path", "");
        if (path.empty()) {
            // Native save dialog (blocks the main loop while open — audio keeps running).
            if (!Dialogs::saveFile("Export Cubase Track Archive",
                                   {{"Cubase Track Archive", "*.xml"}}, "xml",
                                   app_.model.project.name + ".xml", path)) {
                ec = "cancelled";
                em = "export cancelled";
                return json();
            }
        }
        std::vector<std::string> warnings;
        std::string err;
        if (!TrackArchiveWriter::write(app_.model, app_.host.get(),
                                       app_.projectIO.projectDir(), path, warnings, err)) {
            ec = "export_failed";
            em = err.empty() ? "track archive export failed" : err;
            return json();
        }
        json warns = json::array();
        for (const std::string& w : warnings) {
            Log::info("export: trackArchive warning: %s", w.c_str());
            warns.push_back(w);
        }
        Log::info("export: wrote %s (%zu warnings)", path.c_str(), warnings.size());
        return json{{"path", path}, {"warnings", std::move(warns)}};
    }
    if (type == "export/cpr") {
        // Cubase .cpr project export (donor-splice writer, real-Cubase-validated
        // pipeline — docs/CPR_WRITER_M3_NOTES.md). Fast synchronous write — same shape
        // as export/trackArchive.
        std::string path = getOr(p, "path", "");
        if (path.empty()) {
            // Native save dialog (blocks the main loop while open — audio keeps running).
            if (!Dialogs::saveFile("Export Cubase Project", {{"Cubase Project", "*.cpr"}},
                                   "cpr", app_.model.project.name + ".cpr", path)) {
                ec = "cancelled";
                em = "export cancelled";
                return json();
            }
        }
        std::vector<std::string> warnings;
        std::string err;
        // Insert state chunks for the export: live host first, then the session orphan
        // store, then the saved plugin-states/<id>.bin (same priority as save/recreate).
        const std::string pdir =
            app_.projectIO.hasPath() ? app_.projectIO.projectDir() : std::string();
        CprWriter::StateFn stateFor = [this, &pdir](uint64_t iid,
                                                    std::vector<uint8_t>& out) -> bool {
            out.clear();
            if (app_.host && app_.host->getState(iid, out) && !out.empty())
                return true;
            out.clear();
            const auto oit = app_.orphanPluginStates.find(iid);
            if (oit != app_.orphanPluginStates.end() && !oit->second.empty()) {
                out = oit->second;
                return true;
            }
            if (const PluginInstance* pi = app_.model.pluginByInstanceId(iid))
                if (!pi->stateFile.empty() && !pdir.empty()) {
                    std::ifstream f(utf8ToWide(pathJoin(pdir, pi->stateFile)).c_str(),
                                    std::ios::binary);
                    if (!f.is_open())
                        return false;
                    out.assign(std::istreambuf_iterator<char>(f),
                               std::istreambuf_iterator<char>());
                    return !out.empty();
                }
            return false;
        };
        if (!CprWriter::write(app_.model, path, warnings, err, pdir, stateFor)) {
            ec = "export_failed";
            em = err.empty() ? "cpr export failed" : err;
            return json();
        }
        json warns = json::array();
        for (const std::string& w : warnings) {
            Log::info("export: cpr warning: %s", w.c_str());
            warns.push_back(w);
        }
        Log::info("export: wrote %s (%zu warnings)", path.c_str(), warnings.size());
        return json{{"path", path}, {"warnings", std::move(warns)}};
    }

    // --- §5.6 plugins ------------------------------------------------------------------
    if (type.rfind("plugins/", 0) == 0)
        return handlePlugins(type, p, ec, em);
    if (type.rfind("plugin/", 0) == 0)
        return handlePluginInstance(type, p, ec, em);

    // --- §5.1 dialogs / §5.7 misc ---------------------------------------------------
    if (type.rfind("dialog/", 0) == 0)
        return handleDialog(type, ec, em);
    if (type == "settings/get")
        return app_.settings.get();
    if (type == "settings/set") {
        const json patch = getOr<json>(p, "patch", p);
        app_.settings.set(patch);
        app_.applySettings();
        return app_.settings.get();
    }

    ec = "unknown_type";
    em = "unknown message type: " + type;
    return json();
}

// ---------------------------------------------------------------------------
// session/hello (§5.1)
// ---------------------------------------------------------------------------

json Api::sessionHello() {
    json midiInputs = json::array();
    for (const MidiInDeviceInfo& d : app_.midiInput.devices())
        midiInputs.push_back(json{{"id", d.id}, {"name", d.name}});
    // PINNED CONTRACT: top-level "metronome" {enabled, countInBars} — same object as in
    // transportJson() (event/transport + transport/* replies); the UI syncs its toggle
    // from here at connect time.
    return json{{"engine", app_.engineHelloInfo()},
                {"project", toJson(app_.model.project)},
                {"pluginRegistry", app_.registry.listJson()},
                {"recentProjects", app_.projectIO.recentProjects()},
                {"audioDevices", app_.devicesJson()},
                {"midiInputs", std::move(midiInputs)},
                {"metronome", json{{"enabled", app_.transport.metronomeEnabled()},
                                   {"countInBars", app_.transport.countInBars()}}},
                {"automationWrite", app_.transport.automationWrite()},
                {"midiMaps", app_.midiMapsJson()}};
}

json Api::loadProjectPath(const std::string& path, std::string& ec, std::string& em) {
    // Open Recent also lists imported foreign projects (.cpr / .mid) — those re-run
    // the importer rather than the project loader.
    if (ImportProviderRegistry::instance().forPath(path))
        return importForeignPath(path, ec, em);
    app_.prepareForModelReplace();
    std::vector<uint64_t> missing;
    std::string err;
    if (!app_.projectIO.load(path, app_.model, missing, err)) {
        std::string nerr;
        app_.projectIO.newProject(app_.model, nerr);
        app_.afterModelReplaced();
        ec = "load_failed";
        em = err;
        return json();
    }
    app_.afterModelReplaced();
    json mj = json::array();
    for (uint64_t mid : missing)
        mj.push_back(mid);
    return json{{"project", toJson(app_.model.project)}, {"missingAssets", std::move(mj)}};
}

// project/importForeign (§5.1): run the matching ImportProvider, then adopt the resulting
// model exactly like project/load. Synchronous on the main thread (matching
// loadProjectPath); the current project is only replaced once the provider succeeded.
json Api::importForeignPath(const std::string& path, std::string& ec, std::string& em) {
    const ImportProvider* prov = ImportProviderRegistry::instance().forPath(path);
    if (!prov) {
        ec = "no_provider";
        em = "no import provider for: " + fileName(path);
        return json();
    }

    // Run the provider into a scratch model first — the current project survives failure.
    Model imported;
    std::map<uint64_t, std::vector<uint8_t>> pluginStates; // instanceId -> setState bytes
    ImportContext ictx;
    ictx.sessionSampleRate = app_.model.project.sampleRate;
    // No projectDirHint even when a project is open: the imported project never belongs
    // to the CURRENT project's directory (the import replaces the session and the user
    // must Save As) — a hint would copy the foreign audio into the OLD project's audio/
    // as orphan wavs. With an empty hint providers reference audio in place
    // (file == "", originalPath set); Save-As copies it via originalPath (§6).
    ictx.projectDirHint = "";
    ictx.assetStore = &app_.assetStore;
    ictx.pluginStates = &pluginStates;
    App* app = &app_;
    const std::string display = fileName(path);
    ictx.progress = [app, display](float pct) {
        app->broadcastEvent("event/importProgress",
                            json{{"path", display},
                                 {"pct", static_cast<int>(std::lround(pct * 100.0f))}});
    };
    std::string err;
    // forPath() hands out const pointers; import() is non-const by contract (providers may
    // keep scratch state). The registry owns the provider mutably — cast is sound.
    if (!const_cast<ImportProvider*>(prov)->import(path, ictx, imported, err)) {
        ec = "import_failed";
        em = err.empty() ? "import failed" : err;
        return json();
    }

    // Adopt like project/load — but an imported project has NO save path and starts dirty
    // (the user must Save As). newProject clears ProjectIO's path before the swap.
    app_.prepareForModelReplace(); // also clears app_.orphanPluginStates
    std::string nerr;
    if (!app_.projectIO.newProject(app_.model, nerr))
        Log::warn("project/importForeign: %s", nerr.c_str());
    app_.model.project = std::move(imported.project);
    app_.afterModelReplaced(); // plugin recreate + asset loadAsync + rebuild + projectChanged

    // Source project's metronome/click state (SPEC §5.4): providers surface it on the
    // scratch model (transient — not part of project.json). Apply after the swap and
    // broadcast ONE event/transport — it otherwise only streams during playback, so the
    // UI metronome toggle would stay stale until the next transport op. Absent (-1) =
    // leave the current engine state untouched.
    if (imported.importMetronomeEnabled >= 0) {
        app_.transport.setMetronomeEnabled(imported.importMetronomeEnabled != 0);
        app_.broadcastTransportEvent();
    }

    // Imported plugin state (SPEC §5.6): instances that came alive get it now; ALL
    // captured chunks go to the orphan store so the state survives until plugins/recreate
    // consumes it or the first save writes plugin-states/<id>.bin.
    for (const auto& [instanceId, bytes] : pluginStates) {
        if (bytes.empty())
            continue;
        if (app_.host->node(instanceId) && !app_.host->setState(instanceId, bytes))
            Log::warn("project/importForeign: setState failed for instance %llu",
                      static_cast<unsigned long long>(instanceId));
    }
    app_.orphanPluginStates = std::move(pluginStates);

    app_.projectIO.markDirty();
    // Remember the import in Open Recent (re-opening re-imports via loadProjectPath's
    // provider routing). addRecent's temp-dir filter still applies.
    app_.projectIO.addRecent(path, fileName(path));
    return json{{"project", toJson(app_.model.project)}};
}

// ---------------------------------------------------------------------------
// Fuzzy plugin-name matching for recreate substitution suggestions.
// ---------------------------------------------------------------------------
namespace {

// Channel-config tokens some hosts bake into sub-plugin names (Waves VST2 shells expose
// one sub-plugin per routing: "C1 comp Mono", "PS01 - Keyboards stereo2stereo", …).
// Dropping them lets "PS01 - Keyboards" meet "PS01 - Keyboards stereo2stereo".
bool isConfigToken(const std::string& t) {
    static const char* kTokens[] = {"mono",          "stereo",       "mono2mono",
                                    "mono2stereo",   "stereo2stereo", "stereo2mono",
                                    "m2s",           "s2s",           "m2m",
                                    "s2m",           "x64",           "x86"};
    for (const char* k : kTokens)
        if (t == k) return true;
    return false;
}

std::vector<std::string> nameTokens(const std::string& in) {
    std::vector<std::string> out;
    std::string cur;
    for (const char c : in) {
        const char lc = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (std::isalnum(static_cast<unsigned char>(lc))) {
            cur.push_back(lc);
        } else if (!cur.empty()) {
            out.push_back(cur);
            cur.clear();
        }
    }
    if (!cur.empty())
        out.push_back(cur);
    out.erase(std::remove_if(out.begin(), out.end(), isConfigToken), out.end());
    return out;
}

std::string joinTokens(const std::vector<std::string>& v) {
    std::string s;
    for (const auto& t : v)
        s += t;
    return s;
}

// 0..100: 100 exact (ignoring config suffixes/punctuation), 86 one-contains-the-other,
// else token-overlap (Jaccard) scaled to 0..70.
int nameSimilarity(const std::vector<std::string>& a, const std::vector<std::string>& b) {
    if (a.empty() || b.empty())
        return 0;
    if (a == b)
        return 100;
    const std::string ja = joinTokens(a);
    const std::string jb = joinTokens(b);
    if (ja.size() >= 3 && jb.size() >= 3 &&
        (ja.find(jb) != std::string::npos || jb.find(ja) != std::string::npos))
        return 86;
    int inter = 0;
    for (const auto& t : a)
        if (std::find(b.begin(), b.end(), t) != b.end())
            ++inter;
    const int uni = static_cast<int>(a.size() + b.size()) - inter;
    return uni <= 0 ? 0 : (70 * inter) / uni;
}

bool hasAnyToken(const std::vector<std::string>& toks,
                 std::initializer_list<const char*> keys) {
    for (const auto& t : toks)
        for (const char* k : keys)
            if (t == k)
                return true;
    return false;
}

} // namespace

// project/getUnresolvedPlugins (§5.6): every model insert (incl. instrument slots — they
// are inserts on Instrument tracks) that has NO live host instance.
json Api::unresolvedPluginsJson() {
    json plugins = json::array();
    const std::vector<PluginInfo> reg = app_.registry.list(); // incl. built-ins
    auto scan = [&](const Track& t) {
        for (size_t i = 0; i < t.inserts.size(); ++i) {
            const PluginInstance& pi = t.inserts[i];
            if (app_.host->node(pi.instanceId))
                continue; // live (hosted)
            if (app_.builtin && app_.builtin->has(pi.instanceId))
                continue; // live (built-in)
            const bool hasState =
                app_.orphanPluginStates.count(pi.instanceId) > 0 ||
                !pi.stateFile.empty() || !pi.paramValues.empty();
            const PluginInfo* info = app_.registry.byUid(pi.uid);
            json entry = {{"instanceId", pi.instanceId},
                          {"name", pi.name},
                          {"uid", pi.uid},
                          {"format", pi.format},
                          {"bitness", pi.bitness},
                          {"trackId", t.id},
                          {"trackName", t.name},
                          {"slotIndex", static_cast<int>(i)},
                          {"hasState", hasState},
                          {"inRegistry", info != nullptr}};
            if (!pi.version.empty())
                entry["version"] = pi.version; // exact plugin version (optional, §5.6)
            if (!pi.sourceHint.empty())
                entry["source"] = pi.sourceHint; // PINNED wire name: import provenance

            // Substitution suggestions for plugins the registry can't resolve by uid:
            // fuzzy name matches first (config-suffix/format/bitness agnostic — a VST3
            // 64-bit "C1 comp Mono" meets the VST2 32-bit one), then an in-spirit
            // built-in when nothing similar is installed.
            if (!info) {
                const bool wantInstrument = t.kind == TrackKind::Instrument && i == 0;
                const auto toks = nameTokens(pi.name);
                struct Cand {
                    const PluginInfo* p;
                    int score;
                };
                std::vector<Cand> cands;
                for (const PluginInfo& r : reg) {
                    if (r.blacklisted || r.isInstrument != wantInstrument)
                        continue;
                    int score = nameSimilarity(toks, nameTokens(r.name));
                    if (score < 45)
                        continue;
                    if (r.format == pi.format)
                        score += 4;
                    if (r.bitness == pi.bitness)
                        score += 2;
                    cands.push_back({&r, score});
                }
                if (cands.empty()) { // nothing similar in name — offer a stand-in
                    const char* uid = nullptr;
                    if (wantInstrument)
                        uid = hasAnyToken(toks, {"piano", "keys", "keyboard", "keyboards",
                                                 "grand", "rhodes", "organ", "ep"})
                                  ? "builtin:piano"
                                  : "builtin:polysynth";
                    else if (hasAnyToken(toks, {"comp", "compressor", "c1", "c4", "rcomp"}))
                        uid = "builtin:compressor";
                    else if (hasAnyToken(toks, {"limiter", "l1", "l2", "l3", "maximizer"}))
                        uid = "builtin:limiter";
                    else if (hasAnyToken(toks, {"verb", "reverb", "rverb", "trueverb",
                                                "room", "hall"}))
                        uid = "builtin:reverb";
                    else if (hasAnyToken(toks, {"delay", "echo", "dly"}))
                        uid = "builtin:delay";
                    else if (hasAnyToken(toks, {"gate", "expander"}))
                        uid = "builtin:gate";
                    if (uid)
                        if (const PluginInfo* b = app_.registry.byUid(uid))
                            cands.push_back({b, 20});
                }
                std::sort(cands.begin(), cands.end(), [](const Cand& a, const Cand& b) {
                    if (a.score != b.score) return a.score > b.score;
                    if (a.p->bitness != b.p->bitness) return a.p->bitness > b.p->bitness;
                    return a.p->name < b.p->name;
                });
                json sugg = json::array();
                for (size_t s = 0; s < cands.size() && s < 3; ++s)
                    sugg.push_back(json{{"uid", cands[s].p->uid},
                                        {"name", cands[s].p->name},
                                        {"format", cands[s].p->format},
                                        {"bitness", cands[s].p->bitness},
                                        {"score", cands[s].score}});
                if (!sugg.empty())
                    entry["suggestions"] = std::move(sugg);
            }
            plugins.push_back(std::move(entry));
        }
    };
    for (const Track& t : app_.model.project.tracks)
        scan(t);
    scan(app_.model.project.masterTrack);
    return json{{"plugins", std::move(plugins)}};
}

// ---------------------------------------------------------------------------
// transport (§5.4)
// ---------------------------------------------------------------------------

json Api::handleTransport(const std::string& type, const json& p, std::string& ec,
                          std::string& em) {
    if (type == "transport/play") {
        app_.transport.play();
    } else if (type == "transport/stop") {
        if (app_.isRecordingSession())
            app_.stopRecordingAndCommit();
        app_.transport.stop();
    } else if (type == "transport/pause") {
        if (app_.isRecordingSession())
            app_.stopRecordingAndCommit();
        app_.transport.pause();
    } else if (type == "transport/record") {
        std::string err;
        if (!app_.startRecording(err)) {
            ec = "record_failed";
            em = err;
            return json();
        }
    } else if (type == "transport/locate") {
        app_.transport.locate(getOr<double>(p, "beat", 0.0));
    } else if (type == "transport/setMetronome") {
        app_.transport.setMetronomeEnabled(getOr<bool>(p, "enabled", true));
        if (hasKey(p, "countInBars"))
            app_.transport.setCountInBars(std::clamp(getOr<int>(p, "countInBars", 0), 0, 2));
    } else if (type == "transport/setAutomationWrite") {
        app_.transport.setAutomationWrite(getOr<bool>(p, "enabled", false));
    } else {
        ec = "unknown_type";
        em = "unknown message type: " + type;
        return json();
    }
    app_.broadcastTransportEvent();
    return app_.transportJson();
}

// ---------------------------------------------------------------------------
// engine (§5.4/§5.7)
// ---------------------------------------------------------------------------

json Api::handleEngine(const std::string& type, const json& p, std::string& ec,
                       std::string& em) {
    if (type == "engine/getDevices")
        return app_.devicesJson();
    if (type == "engine/getStatus")
        return app_.engineStatus();
    if (type == "engine/panic") {
        app_.panic();
        return json::object();
    }
    if (type == "engine/getLog")
        return json{{"lines", Log::tail(getOr<int>(p, "tail", 0))}};
    if (type == "engine/setAudioConfig") {
        AudioConfig cfg = app_.currentAudioConfig();
        if (hasKey(p, "driver")) {
            DriverType t = cfg.driverType;
            if (!driverTypeFromString(getOr(p, "driver", ""), t)) {
                ec = "bad_request";
                em = "unknown driver type";
                return json();
            }
            cfg.driverType = t;
        }
        if (hasKey(p, "deviceId"))
            cfg.deviceId = getOr(p, "deviceId", "");
        if (hasKey(p, "sampleRate"))
            cfg.sampleRate = getOr<int>(p, "sampleRate", cfg.sampleRate);
        if (hasKey(p, "bufferSize"))
            cfg.bufferSize = getOr<int>(p, "bufferSize", cfg.bufferSize);
        if (hasKey(p, "exclusive"))
            cfg.exclusive = getOr<bool>(p, "exclusive", false);
        // Keep any capture stream that armed/monitoring tracks need open across this I/O
        // change — setAudioConfig only carries render fields, so without this a buffer/device
        // switch would silently drop the microphone.
        cfg.captureDeviceId = app_.desiredCaptureDeviceId();
        json actual;
        std::string err;
        if (!app_.reconfigureAudio(cfg, actual, err)) {
            ec = "audio_config_failed";
            em = err;
            return json();
        }
        AudioConfig persisted = cfg;
        persisted.captureDeviceId.clear(); // capture is runtime state, not persisted (SPEC §7)
        app_.settings.storeAudioConfig(persisted);
        return json{{"actual", std::move(actual)}};
    }
    ec = "unknown_type";
    em = "unknown message type: " + type;
    return json();
}

// ---------------------------------------------------------------------------
// plugins (§5.6)
// ---------------------------------------------------------------------------

json Api::handlePlugins(const std::string& type, const json& p, std::string& ec,
                        std::string& em) {
    if (type == "plugins/scan") {
        const bool full = getOr<bool>(p, "full", false);
        const bool alreadyRunning = app_.scanner.scanning();
        App* app = &app_;
        // Callbacks fire on the scanner worker thread; EventBus broadcast is thread-safe.
        app_.scanner.scanAsync(
            full,
            [app](int cur, int total, const std::string& path, int found) {
                app->broadcastEvent("event/scanProgress", json{{"current", cur},
                                                               {"total", total},
                                                               {"path", path},
                                                               {"found", found}});
            },
            [app] {
                app->broadcastEvent("event/scanDone",
                                    json{{"registry", app->registry.listJson()}});
            });
        return json{{"started", !alreadyRunning}};
    }
    if (type == "plugins/getRegistry")
        return json{{"registry", app_.registry.listJson()}};
    if (type == "plugins/setFolders") {
        const auto vst2 = getOr<std::vector<std::string>>(p, "vst2", {});
        const auto vst3 = getOr<std::vector<std::string>>(p, "vst3", {});
        app_.registry.setFolders(vst2, vst3);
        app_.settings.storePluginFolders(vst2, vst3);
        // Re-derive the registry from the cache under the NEW folder set: a removed folder's
        // plugins disappear at once, and a re-added folder's come straight back (no rescan).
        // Reuse the scan-completed event so every client refreshes its registry view.
        app_.scanner.refreshFromCache();
        app_.broadcastEvent("event/scanDone", json{{"registry", app_.registry.listJson()}});
        const auto [v2, v3] = app_.registry.folders();
        return json{{"vst2", v2}, {"vst3", v3}};
    }
    if (type == "plugins/getFolders") {
        const auto [v2, v3] = app_.registry.folders();
        return json{{"vst2", v2}, {"vst3", v3}};
    }
    if (type == "plugins/getDefaultFolders") {
        return json{{"vst2", PluginRegistry::defaultVst2Folders()},
                    {"vst3", PluginRegistry::defaultVst3Folders()}};
    }
    if (type == "plugins/unblacklist") {
        const std::string uid = getOr(p, "uid", "");
        return json{{"removed", app_.blacklist.removeByUid(uid)}};
    }
    if (type == "plugins/recreate") // §5.6: resource resolution; UNDOABLE (pushes an entry)
        return app_.cmd->recreatePlugins(p, ec, em);
    ec = "unknown_type";
    em = "unknown message type: " + type;
    return json();
}

json Api::handlePluginInstance(const std::string& type, const json& p, std::string& ec,
                               std::string& em) {
    const uint64_t iid = getOr<uint64_t>(p, "instanceId", 0);
    if (iid == 0) {
        ec = "bad_request";
        em = "instanceId required";
        return json();
    }
    HostProcessManager* host = app_.host.get();
    BuiltinEffectManager* builtin = app_.builtin.get();
    // Built-in effects are in-engine: params come from the effect, no native editor/presets.
    const bool isBuiltin = builtin && builtin->has(iid);
    if (type == "plugin/getParams") {
        if (isBuiltin)
            return json{{"params", builtin->getParams(iid)}, {"hasEditor", false}};
        // hasEditor (§5.6): the UI offers the native-editor button even when
        // params is empty (e.g. PlugSound genuinely exposes 0 parameters).
        return json{{"params", host->getParams(iid)},
                    {"hasEditor", host->hasEditor(iid)}};
    }
    if (type == "plugin/getPresets") {
        if (isBuiltin) {
            // Built-ins expose their FACTORY presets (id = table index).
            json arr = json::array();
            if (const PluginInstance* pi = app_.model.pluginByInstanceId(iid)) {
                const auto& fp = builtinFactoryPresets(pi->uid);
                for (size_t i = 0; i < fp.size(); ++i)
                    arr.push_back(json{{"id", static_cast<int>(i)}, {"name", fp[i].name}});
            }
            return json{{"presets", std::move(arr)}};
        }
        return json{{"presets", host->getPresets(iid)}};
    }
    if (type == "plugin/loadPreset") {
        if (isBuiltin) {
            PluginInstance* pi = app_.model.pluginByInstanceId(iid);
            const int id = getOr<int>(p, "id", -1);
            if (!pi) {
                ec = "not_found";
                em = "unknown instanceId";
                return json();
            }
            const auto& fp = builtinFactoryPresets(pi->uid);
            if (id < 0 || id >= static_cast<int>(fp.size())) {
                ec = "bad_request";
                em = "unknown preset id";
                return json();
            }
            // Apply into the model (saves with the project) AND the live node. Like
            // hosted-plugin preset loads this is not undoable.
            IInsertNode* node = builtin->node(iid);
            for (const auto& [pid, norm] : fp[static_cast<size_t>(id)].norms) {
                pi->paramValues[pid] = norm;
                if (node) node->setParamRt(pid, norm);
            }
            app_.projectIO.markDirty();
            // Refresh any open editor for this instance (same event the native-editor
            // edit path uses).
            json changed = json::array();
            for (const auto& row : builtin->getParams(iid))
                changed.push_back(json{{"id", row["id"]},
                                       {"value", row["value"]},
                                       {"valueText", row["valueText"]}});
            app_.broadcastEvent("event/pluginParams",
                                json{{"instanceId", iid}, {"changed", std::move(changed)}});
            return json::object();
        }
        if (!host->loadPreset(iid, getOr<int>(p, "id", 0))) {
            ec = "plugin_op_failed";
            em = "loadPreset failed";
            return json();
        }
        return json::object();
    }
    if (type == "plugin/savePreset") {
        // NOTE(spec): HostProcessManager exposes no savePreset op in v1; honest error
        // rather than a fake success (SPEC §10).
        ec = "unsupported";
        em = "plugin preset saving is not supported in v1";
        return json();
    }
    if (type == "plugin/openEditor") {
        std::string err;
        if (!host->openEditor(iid, &err)) {
            ec = "plugin_op_failed";
            em = err.empty() ? "openEditor failed" : err;
            return json();
        }
        return json::object();
    }
    if (type == "plugin/closeEditor") {
        host->closeEditor(iid);
        return json::object();
    }
    ec = "unknown_type";
    em = "unknown message type: " + type;
    return json();
}

// ---------------------------------------------------------------------------
// dialogs (§5.1, native IFileDialog on a per-call STA thread)
// ---------------------------------------------------------------------------

json Api::handleDialog(const std::string& type, std::string& ec, std::string& em) {
    if (type == "dialog/openProject") {
        std::string path;
        const bool ok = Dialogs::openFile(
            "Open Project",
            {{"MyDAW Project", "project.json;*.mydaw"}, {"All Files", "*.*"}}, path);
        return json{{"path", ok ? json(path) : json()}};
    }
    if (type == "dialog/saveProject") {
        std::string path;
        const bool ok = Dialogs::saveFile("Save Project", {{"MyDAW Project", "*.mydaw"}},
                                          "mydaw", app_.model.project.name, path);
        return json{{"path", ok ? json(path) : json()}};
    }
    if (type == "dialog/importProject") {
        // Filter list from the provider registry: every supported extension first, then
        // one entry per provider (registration order), then All Files.
        std::vector<FileDialogFilter> filters;
        std::string allPattern;
        for (const ImportProvider* prov : ImportProviderRegistry::instance().all()) {
            std::string pattern;
            for (const std::string& ext : prov->extensions()) {
                if (!pattern.empty())
                    pattern += ";";
                pattern += "*." + ext;
            }
            if (pattern.empty())
                continue;
            if (!allPattern.empty())
                allPattern += ";";
            allPattern += pattern;
            filters.push_back({prov->displayName(), pattern});
        }
        filters.insert(filters.begin(),
                       {"All supported project formats",
                        allPattern.empty() ? std::string("*.*") : allPattern});
        filters.push_back({"All Files", "*.*"});
        std::string path;
        const bool ok = Dialogs::openFile("Import Project", filters, path);
        return json{{"path", ok ? json(path) : json()}};
    }
    if (type == "dialog/importFiles") {
        std::vector<std::string> paths;
        const bool ok = Dialogs::openFiles(
            "Import Files",
            {{"Audio / MIDI", "*.wav;*.mp3;*.flac;*.m4a;*.wma;*.aif;*.aiff;*.mid;*.midi"},
             {"All Files", "*.*"}},
            paths);
        return json{{"paths", ok ? json(paths) : json()}};
    }
    ec = "unknown_type";
    em = "unknown message type: " + type;
    return json();
}

// ---------------------------------------------------------------------------
// media/import (§5.5) — WS path (worker) and POST /api/upload (server thread)
// ---------------------------------------------------------------------------

void Api::startMediaImport(const json& p, int64_t id, HttpWsServer::RespondFn respond,
                           bool& deferred, std::string& ec, std::string& em) {
    ImportSpec spec;
    if (p.contains("paths") && p["paths"].is_array())
        for (const json& pj : p["paths"])
            if (pj.is_string()) {
                spec.paths.push_back(pj.get<std::string>());
                spec.displayNames.push_back(fileName(spec.paths.back()));
            }
    if (spec.paths.empty()) {
        ec = "bad_request";
        em = "paths required";
        return;
    }
    spec.trackId = getOr<uint64_t>(p, "trackId", 0);
    spec.atBeat = std::max(0.0, getOr<double>(p, "atBeat", 0.0));
    deferred = true;
    app_.spawnWorker([this, spec, id, respond]() mutable {
        std::string wec, wem;
        json payload = runImportBlocking(spec, wec, wem);
        if (!wec.empty())
            respond(errEnv(id, wec, wem));
        else
            respond(okEnv(id, std::move(payload)));
    });
}

json Api::handleUpload(const std::vector<std::string>& tempFiles,
                       const std::map<std::string, std::string>& query) {
    auto fail = [](const std::string& code, const std::string& msg) {
        return json{{"ok", false}, {"error", json{{"code", code}, {"message", msg}}}};
    };
    if (app_.isExporting())
        return fail("busy_exporting", "an export is in progress");
    if (tempFiles.empty())
        return fail("bad_request", "no files uploaded");

    ImportSpec spec;
    spec.deleteSources = true; // handler owns the temp files on success
    for (size_t i = 0; i < tempFiles.size(); ++i) {
        std::string orig;
        const auto it = query.find("file" + std::to_string(i));
        if (it != query.end())
            orig = fileName(it->second);
        std::string use = tempFiles[i];
        if (!orig.empty()) {
            // Rename so the imported asset keeps the client filename (collision-safe).
            const std::string dir = parentDir(tempFiles[i]);
            const std::string stem = fileStem(orig);
            const std::string ext = fileExtension(orig);
            std::string cand = pathJoin(dir, orig);
            for (int n = 1; fileExists(cand) && n < 1000; ++n)
                cand = pathJoin(dir, stem + "-" + std::to_string(n) + ext);
            if (MoveFileExW(utf8ToWide(tempFiles[i]).c_str(), utf8ToWide(cand).c_str(),
                            MOVEFILE_REPLACE_EXISTING))
                use = cand;
        }
        spec.paths.push_back(use);
        spec.displayNames.push_back(orig.empty() ? fileName(tempFiles[i]) : orig);
    }
    {
        const auto it = query.find("trackId");
        if (it != query.end())
            spec.trackId = std::strtoull(it->second.c_str(), nullptr, 10);
    }
    {
        const auto it = query.find("atBeat");
        if (it != query.end())
            spec.atBeat = std::max(0.0, std::strtod(it->second.c_str(), nullptr));
    }

    std::string ec, em;
    json payload = runImportBlocking(spec, ec, em); // blocks the server thread (doc'd ok)
    if (!ec.empty())
        return fail(ec, em);
    return json{{"ok", true}, {"payload", std::move(payload)}};
}

json Api::runImportBlocking(const ImportSpec& spec, std::string& ec, std::string& em) {
    // Phase 1 (main thread): id allocation + context snapshot.
    std::string projectDir;
    bool hasProject = false;
    int sessionSr = 48000;
    std::vector<uint64_t> ids(spec.paths.size(), 0);
    const bool alive = app_.postAndWait([&] {
        hasProject = app_.projectIO.hasPath();
        projectDir = hasProject ? app_.projectIO.projectDir() : app_.fallbackMediaDir();
        sessionSr = app_.model.project.sampleRate;
        for (size_t i = 0; i < spec.paths.size(); ++i)
            if (!isMidiFileExt(spec.paths[i]))
                ids[i] = app_.model.nextId();
    });
    if (!alive) {
        ec = "shutting_down";
        em = "engine is shutting down";
        return json();
    }

    // Phase 2 (this thread): decode.
    std::vector<ImportItem> items(spec.paths.size());
    int okCount = 0;
    std::string firstErr;
    for (size_t i = 0; i < spec.paths.size(); ++i) {
        ImportItem& it = items[i];
        it.display = (i < spec.displayNames.size() && !spec.displayNames[i].empty())
                         ? spec.displayNames[i]
                         : fileName(spec.paths[i]);
        app_.broadcastEvent("event/importProgress", json{{"path", it.display}, {"pct", 0}});
        if (isMidiFileExt(spec.paths[i])) {
            it.isMid = true;
            it.ok = SmfReader::read(spec.paths[i], it.smf, it.err);
            if (it.ok && it.smf.tracks.empty()) {
                it.ok = false;
                it.err = "midi file contains no notes";
            }
        } else if (const std::string provName = projectOnlyProviderName(spec.paths[i]);
                   !provName.empty()) {
            // .cpr-as-media bug: a foreign-project file reached media-import. Don't feed it
            // to Media Foundation (cryptic MFCreateSourceReaderFromURL hr=0xC00D36C4) —
            // give an actionable error pointing at File > Import Project (§5.1).
            it.ok = false;
            it.err = "is a " + provName +
                     " file — open it with File > Import Project (it replaces the "
                     "session), not Import Files.";
        } else {
            it.asset.id = ids[i];
            it.ok = app_.assetStore.importFile(spec.paths[i], projectDir, sessionSr,
                                               it.asset, it.err);
            if (it.ok && !hasProject) {
                // Never-saved project: keep the asset path absolute so it stays
                // resolvable; project/save copies external audio into audio/ (§6).
                it.asset.file = pathJoin(projectDir, it.asset.file);
            }
        }
        if (!it.ok) {
            Log::warn("import: %s failed: %s", it.display.c_str(), it.err.c_str());
            if (firstErr.empty())
                firstErr = it.display + ": " + it.err;
        } else {
            ++okCount;
        }
        app_.broadcastEvent("event/importProgress", json{{"path", it.display}, {"pct", 100}});
    }

    json out;
    if (okCount == 0) {
        ec = "import_failed";
        em = firstErr.empty() ? "no files could be imported" : firstErr;
    } else {
        // Phase 3 (main thread): commit into the model + broadcast.
        if (!app_.postAndWait([&] { out = commitImport(items, spec); })) {
            ec = "shutting_down";
            em = "engine is shutting down";
        }
    }

    // Phase 4: uploads own their (renamed) temp files.
    if (spec.deleteSources)
        for (const std::string& path : spec.paths)
            DeleteFileW(utf8ToWide(path).c_str());
    return out;
}

json Api::commitImport(std::vector<ImportItem>& items, const ImportSpec& spec) {
    Model& m = app_.model;
    App* app = &app_;
    json assetsOut = json::array();
    json clipsOut = json::array();
    std::vector<uint64_t> newTrackIds;
    bool any = false;
    bool usedTargetForMidi = false;

    for (ImportItem& it : items) {
        if (!it.ok)
            continue;
        if (!it.isMid) {
            m.project.assets.push_back(it.asset);
            assetsOut.push_back(toJson(it.asset));
            app_.assetStore.loadAsync(it.asset, [app](bool ok) {
                if (ok)
                    app->requestGraphRebuild(); // PCM resolved at next plan rebuild
            });
            Track* target = spec.trackId ? m.trackById(spec.trackId) : nullptr;
            if (target && target->kind == TrackKind::Audio) {
                AudioClip c;
                c.id = m.nextId();
                c.name = fileStem(it.display);
                c.startBeat = spec.atBeat;
                c.assetId = it.asset.id;
                c.srcOffsetSamples = 0;
                c.lengthSamples = it.asset.lengthSamples;
                clipsOut.push_back(toJson(c));
                target->clips.emplace_back(std::move(c));
            }
            any = true;
        } else {
            double bpb = app_.tempoMap.beatsPerBarAt(0.0);
            if (bpb <= 0.0)
                bpb = 4.0;
            // Logic-region consolidation (SmfTrackPlan.h): format-1 MTrks sharing a
            // (sanitized name, channel) become ONE track with one clip per source MTrk at
            // its content position (file bar grid, shifted by atBeat); single-member
            // groups (every normal export) keep the legacy one-clip-at-atBeat layout.
            for (const SmfTrackGroup& g : groupSmfTracks(it.smf)) {
                uint64_t dstId = 0;
                Track* target = spec.trackId ? m.trackById(spec.trackId) : nullptr;
                if (target && !usedTargetForMidi &&
                    (target->kind == TrackKind::Midi ||
                     target->kind == TrackKind::Instrument)) {
                    dstId = target->id;
                    usedTargetForMidi = true;
                } else {
                    Track nt;
                    nt.id = m.nextId();
                    nt.kind = TrackKind::Midi;
                    nt.name = g.name.empty() ? fileStem(it.display) : g.name;
                    nt.color = "#8f6fd8";
                    m.project.tracks.push_back(std::move(nt));
                    dstId = m.project.tracks.back().id;
                    newTrackIds.push_back(dstId);
                }
                const std::string cname = g.name.empty() ? fileStem(it.display) : g.name;
                if (g.consolidated) {
                    for (const SmfData::ImportedTrack* st : g.members) {
                        MidiClip c =
                            buildConsolidatedClip(m, *st, cname, it.smf.timeSigMap);
                        c.startBeat += spec.atBeat;
                        clipsOut.push_back(toJson(c));
                        if (Track* dst = m.trackById(dstId)) // re-lookup after push_back
                            dst->clips.emplace_back(std::move(c));
                        any = true;
                    }
                    continue;
                }
                const SmfData::ImportedTrack& st = *g.members.front();
                MidiClip c;
                c.id = m.nextId();
                c.name = cname;
                c.startBeat = spec.atBeat;
                const double len = std::max(st.lengthBeats, bpb);
                c.lengthBeats = std::ceil(len / bpb - 1e-9) * bpb; // whole bars
                for (const Note& src : st.notes) {
                    Note n = src;
                    n.id = m.nextId();
                    c.notes.push_back(n);
                }
                for (const MidiCc& src : st.cc) { // file beats are clip-relative here
                    MidiCc cev = src;
                    cev.id = m.nextId();
                    cev.controller = std::clamp(cev.controller, 0, 129);
                    cev.beat = std::max(0.0, cev.beat);
                    cev.value = std::clamp(cev.value, 0.0, 1.0);
                    c.cc.push_back(cev);
                }
                std::stable_sort(c.cc.begin(), c.cc.end(),
                                 [](const MidiCc& a, const MidiCc& b) {
                                     return a.controller != b.controller
                                                ? a.controller < b.controller
                                                : a.beat < b.beat;
                                 });
                clipsOut.push_back(toJson(c));
                if (Track* dst = m.trackById(dstId)) // re-lookup: push_back may realloc
                    dst->clips.emplace_back(std::move(c));
                any = true;
            }
        }
    }

    json tracksOut = json::array();
    for (uint64_t tid : newTrackIds)
        if (const Track* t = m.trackById(tid))
            tracksOut.push_back(toJson(*t));

    if (any) {
        app_.projectIO.markDirty();
        app_.cmd->syncEngineFromModel(); // structural: rebuild plan
        app_.cmd->emitFullProjectChanged();
    }
    return json{{"assets", std::move(assetsOut)},
                {"clips", std::move(clipsOut)},
                {"tracks", std::move(tracksOut)}};
}

// ---------------------------------------------------------------------------
// export/render (§5.5) — offline render on a worker thread
// ---------------------------------------------------------------------------

void Api::startExport(const json& p, int64_t id, HttpWsServer::RespondFn respond,
                      bool& deferred, std::string& ec, std::string& em) {
    if (app_.isExporting()) {
        ec = "busy_exporting";
        em = "an export is already in progress";
        return;
    }
    const double startBeat = getOr<double>(p, "startBeat", 0.0);
    const double endBeat = getOr<double>(p, "endBeat", 0.0);
    if (endBeat <= startBeat) {
        ec = "bad_request";
        em = "endBeat must be greater than startBeat";
        return;
    }
    const json fmt = getOr<json>(p, "format", json::object());
    std::string fmtType = getOr<std::string>(fmt, "type", "wav");
    std::transform(fmtType.begin(), fmtType.end(), fmtType.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const bool encoded = MfAudioEncoder::isEncodedFormat(fmtType);
    if (fmtType != "wav" && !encoded) {
        ec = "bad_request";
        em = "unsupported export format: " + fmtType + " (wav, mp3, flac, m4a)";
        return;
    }
    int bitDepth = getOr<int>(fmt, "bitDepth", 24);
    if (bitDepth != 16 && bitDepth != 24 && bitDepth != 32)
        bitDepth = 24;
    const int kbps = std::clamp(getOr<int>(fmt, "kbps", 320), 64, 320); // lossy bitrate
    const bool normalize = getOr<bool>(p, "normalize", false);
    const bool hasLoud = hasKey(p, "loudnessTarget"); // e.g. -14 LUFS (streaming target)
    const double loudTarget = std::clamp(getOr<double>(p, "loudnessTarget", -14.0), -40.0, 0.0);
    const std::string ext = fmtType == "mp3"    ? "mp3"
                            : fmtType == "flac"  ? "flac"
                            : (fmtType == "aac" || fmtType == "m4a") ? "m4a"
                                                 : "wav";

    std::string path = getOr(p, "path", "");
    if (path.empty()) {
        // Native save dialog (blocks the main loop while open — audio keeps running).
        if (!Dialogs::saveFile("Export Audio", {{ext + " audio", "*." + ext}}, ext,
                               app_.model.project.name + "." + ext, path)) {
            ec = "cancelled";
            em = "export cancelled";
            return;
        }
    }

    const int64_t startSample = app_.tempoMap.beatsToSamples(startBeat);
    const int64_t endSample = app_.tempoMap.beatsToSamples(endBeat);
    const int sr = app_.currentSampleRate();
    app_.beginExport();
    deferred = true;

    app_.spawnWorker([this, id, respond, path, startSample, endSample, bitDepth, kbps, normalize,
                      hasLoud, loudTarget, sr, fmtType, encoded]() mutable {
        std::string err;
        bool ok = true;
        double gain = 1.0;

        if (hasLoud) { // measure integrated LUFS, then scale to the target
            LoudnessMeter meter(sr);
            auto scan = [&meter](const float* const* ch, int numCh, int frames) {
                meter.process(ch, numCh, frames);
            };
            ok = app_.renderRange(startSample, endSample, 2048, scan,
                                  &app_.exportProgressRef(), err);
            if (ok) {
                const double measured = meter.integratedLufs();
                if (measured > -70.0)
                    gain = std::pow(10.0, (loudTarget - measured) / 20.0);
            }
        } else if (normalize) { // two-pass: peak scan, then scaled write
            float peak = 0.0f;
            auto scan = [&peak](const float* const* ch, int numCh, int frames) {
                for (int c = 0; c < numCh; ++c)
                    for (int i = 0; i < frames; ++i)
                        peak = std::max(peak, std::fabs(ch[c][i]));
            };
            ok = app_.renderRange(startSample, endSample, 2048, scan,
                                  &app_.exportProgressRef(), err);
            if (ok && peak > 1e-9f)
                gain = 1.0 / static_cast<double>(peak);
        }

        LoudnessMeter finalMeter(sr); // measure the actually-written signal for the reply
        WavWriter wav;
        MfAudioEncoder enc; // used only when `encoded`
        bool opened = false;
        std::vector<std::vector<float>> scratch;
        std::vector<const float*> ptrs;
        auto sink = [&](const float* const* ch, int numCh, int frames) {
            if (!opened) {
                std::string werr;
                opened = encoded ? enc.open(path, numCh, sr, fmtType, kbps, &werr)
                                 : wav.open(path, numCh, sr, bitDepth, &werr);
                if (!opened && err.empty())
                    err = werr;
                scratch.resize(static_cast<size_t>(numCh));
                ptrs.resize(static_cast<size_t>(numCh));
            }
            if (!opened)
                return;
            const float* const* out = ch;
            if (gain != 1.0) {
                for (int c = 0; c < numCh; ++c) {
                    scratch[c].assign(ch[c], ch[c] + frames);
                    for (float& v : scratch[c])
                        v = static_cast<float>(v * gain);
                    ptrs[c] = scratch[c].data();
                }
                out = ptrs.data();
            }
            finalMeter.process(out, numCh, frames); // loudness/peak of the written signal
            if (encoded)
                enc.appendPlanar(out, frames);
            else
                wav.appendPlanar(out, frames);
        };
        if (ok)
            ok = app_.renderRange(startSample, endSample, 2048, sink,
                                  &app_.exportProgressRef(), err);
        if (ok && !opened) {
            ok = false;
            if (err.empty())
                err = "render produced no audio";
        }
        const bool finalized = encoded ? enc.finalize() : wav.finalize();
        if (ok && !finalized) {
            ok = false;
            if (err.empty())
                err = (encoded ? "encode failed: " : "wav write failed: ") + path;
        }

        const double seconds =
            sr > 0 ? static_cast<double>(endSample - startSample) / sr : 0.0;
        app_.endExport();
        app_.broadcastEvent("event/exportProgress", json{{"pct", 100}});
        if (ok) {
            const double lufs = finalMeter.integratedLufs();
            const double peakDb = finalMeter.peakDb();
            Log::info("export: wrote %s (%.2f s, %s, %.1f LUFS, %.1f dBFS peak)", path.c_str(),
                      seconds, fmtType.c_str(), lufs, peakDb);
            respond(okEnv(id, json{{"path", path},
                                   {"seconds", seconds},
                                   {"format", fmtType},
                                   {"lufs", lufs},
                                   {"peakDb", peakDb}}));
        } else {
            respond(errEnv(id, "export_failed", err));
        }
    });
}

} // namespace mydaw
