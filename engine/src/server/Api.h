// MyDAW — server/Api.h (E9)
// Full WebSocket protocol router (SPEC §5): every client message type is dispatched to
// the owning module and answered with the §5 envelope
//   {replyTo, ok:true, payload} | {replyTo, ok:false, error:{code,message}}.
// Unknown types -> "unknown_type"; while an export runs, mutating cmd/*, edit/*,
// media/*, project loads and transport/play|record fail with "busy_exporting".
//
// Threading: handleMessage runs on the MAIN thread (E9 posts every WS message into the
// App job queue). Long operations (media/import decode, export/render) run on App
// workers and reply later via the thread-safe RespondFn. handleUpload runs on the
// SERVER thread (synchronous HTTP body) and marshals model access through
// App::postAndWait.

#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "server/HttpWsServer.h"
#include "util/Json.h"

namespace mydaw {

class App;

class Api {
public:
    explicit Api(App& app);

    // Main thread. Parses the envelope, dispatches, responds (possibly later).
    void handleMessage(const json& msg, HttpWsServer::RespondFn respond);

    // SERVER thread (POST /api/upload, SPEC §5.5). `query` carries trackId/atBeat plus
    // "file0".."fileN" original client filenames. On success this handler owns (deletes)
    // the temp files. Returns the HTTP 200 response body.
    json handleUpload(const std::vector<std::string>& tempFiles,
                      const std::map<std::string, std::string>& query);

private:
    struct ImportSpec {
        std::vector<std::string> paths;        // absolute source paths
        std::vector<std::string> displayNames; // progress/UI names (parallel to paths)
        uint64_t trackId = 0;                  // 0 = no clip creation target
        double atBeat = 0.0;
        bool deleteSources = false;            // uploads: temp files removed afterwards
    };

    // Returns the reply payload or null with ec/em set. `deferred`=true means a worker
    // owns the reply.
    json dispatch(const std::string& type, const json& payload, const json& msg, int64_t id,
                  HttpWsServer::RespondFn& respond, bool& deferred, std::string& ec,
                  std::string& em);

    // ----- grouped handlers (main thread) -------------------------------------
    json sessionHello();
    json loadProjectPath(const std::string& path, std::string& ec, std::string& em);
    json importForeignPath(const std::string& path, std::string& ec, std::string& em);
    json unresolvedPluginsJson(); // project/getUnresolvedPlugins (§5.6)
    json handleTransport(const std::string& type, const json& p, std::string& ec,
                         std::string& em);
    json handleEngine(const std::string& type, const json& p, std::string& ec,
                      std::string& em);
    json handlePlugins(const std::string& type, const json& p, std::string& ec,
                       std::string& em);
    json handlePluginInstance(const std::string& type, const json& p, std::string& ec,
                              std::string& em);
    json handleDialog(const std::string& type, std::string& ec, std::string& em);

    // ----- import / export ------------------------------------------------------
    // Blocking; callable from any non-main thread (worker / server thread) or main.
    json runImportBlocking(const ImportSpec& spec, std::string& ec, std::string& em);
    // Main thread: inserts decoded results into the model, emits projectChanged.
    struct ImportItem; // defined in Api.cpp
    json commitImport(std::vector<ImportItem>& items, const ImportSpec& spec);
    void startMediaImport(const json& p, int64_t id, HttpWsServer::RespondFn respond,
                          bool& deferred, std::string& ec, std::string& em);
    void startExport(const json& p, int64_t id, HttpWsServer::RespondFn respond,
                     bool& deferred, std::string& ec, std::string& em);

    static json okEnv(int64_t id, json payload);
    static json errEnv(int64_t id, const std::string& code, const std::string& msg);
    static bool isBusyGuarded(const std::string& type);

    App& app_;
};

} // namespace mydaw
