// MyDAW — server/McpServer.h
// Embedded Model Context Protocol server (Streamable HTTP transport, stable revision
// 2025-11-25) exposed at POST /mcp. JSON-RPC 2.0 over one HTTP endpoint; stateless JSON
// responses (no SSE stream, no session id) for this version.
//
// The model-facing surface is six logical tools — mydaw_context, mydaw_describe,
// mydaw_query, mydaw_execute, mydaw_batch, mydaw_ui — plus read-only resources and the
// prepared-script prompts. Every engine mutation still flows through the existing
// Api/CommandProcessor boundary; nothing here touches the real-time audio thread.
//
// Threading: handle() runs on the MAIN thread (App posts each /mcp request into the job
// queue, mirroring the WebSocket path). Deferred engine work (export/import) replies later
// through the same thread-safe McpRespondFn. handle() calls `respond` exactly once.

#pragma once

#include <string>

#include "server/HttpWsServer.h"
#include "util/Json.h"

namespace mydaw {

class App;

class McpServer {
public:
    explicit McpServer(App& app);

    // Main thread. Validates origin + bearer auth, parses the JSON-RPC envelope, dispatches
    // the method/tool, and responds (possibly later for deferred engine operations).
    void handle(HttpWsServer::McpRequest req, HttpWsServer::McpRespondFn respond);

private:
    // Lazily parsed embedded capability catalog / prepared prompts (main thread only).
    const json& catalog() const;
    const json& prompts() const;

    // JSON-RPC method handlers. Each is responsible for calling `respond` exactly once.
    void dispatchMethod(const std::string& method, const json& id, const json& params,
                        HttpWsServer::McpRespondFn& respond);
    void toolsCall(const json& id, const json& params, HttpWsServer::McpRespondFn& respond);

    // Individual tools (each calls `respond` exactly once).
    void toolContext(const json& id, HttpWsServer::McpRespondFn& respond);
    void toolDescribe(const json& id, const json& args, HttpWsServer::McpRespondFn& respond);
    void toolExecuteEnvelope(const json& id, const std::string& type, const json& payload,
                             HttpWsServer::McpRespondFn& respond);
    void toolUi(const json& id, const json& args, HttpWsServer::McpRespondFn& respond);

    // Read-only MCP resources.
    void resourcesRead(const json& id, const json& params,
                       HttpWsServer::McpRespondFn& respond);

    App& app_;
    int64_t internalId_ = 0; // monotonically decreasing envelope id for reused Api dispatch
    mutable json catalog_;
    mutable json prompts_;
    mutable bool catalogParsed_ = false;
    mutable bool promptsParsed_ = false;
};

} // namespace mydaw
