// MyDAW — server/HttpWsServer.h
// Hand-rolled HTTP/1.1 + WebSocket (RFC 6455) server on Winsock (SPEC §5, §7).
//
// One server thread: listen on 127.0.0.1:<port>, select() loop, non-blocking sockets
// with per-client recv/send buffers (queued writes), graceful stop via a loopback
// socket pair ("self-pipe"). Multiple clients supported — every WS client receives all
// broadcast events (same UI in two tabs).
//
// Routes:
//   GET  /ws                      -> WebSocket upgrade (JSON text frames, SPEC §5)
//   GET  /api/peaks/<id>?lod=<n>  -> peaks provider (application/octet-stream,
//                                    Cache-Control: public, max-age=31536000, immutable)
//   POST /api/upload              -> multipart/form-data; parts with field name "files"
//                                    stream to %TEMP%/mydaw-upload-<n>.<origext>; the
//                                    upload handler is then called with the temp paths
//                                    and the URL query map AUGMENTED with
//                                    "file0".."fileN" -> original client filename (and
//                                    any non-file form fields by name, URL query wins).
//                                    Handler's json return is the 200 response body.
//                                    On SUCCESS the handler owns (deletes) the temp
//                                    files; on any failure before/at the handler call
//                                    the server deletes them. Body cap 2 GiB.
//   GET  <anything else>          -> static files from uiRoot (StaticFiles: sanitized,
//                                    SPA fallback to index.html, no-cache for
//                                    index.html / max-age=3600 others)
// Errors are JSON bodies: {"error":{"code":"...","message":"..."}} with 400/404/500.
//
// Threading:
//  - setMessageHandler: invoked on the SERVER thread for every parsed WS JSON message.
//    The `respond` closure is thread-safe, may be called later from any non-RT thread
//    (typically main), and is silently dropped if the client has disconnected or the
//    server stopped. Envelope construction (replyTo etc) is the handler's business —
//    the server delivers `msg` verbatim and sends back exactly what `respond` gets.
//  - broadcast(): thread-safe enqueue (mutex + self-pipe wake); actual socket writes
//    happen only on the server thread. Drops silently when not running.
//  - peaks/upload providers run on the server thread (they may block; WS traffic is
//    paused meanwhile — acceptable v1, uploads/peaks are short or rare).
//  - While running, the server installs a Log sink that broadcasts `event/log
//    {level,msg}` for warn/error lines (SPEC §5.7); removed on stop().
// NOT RT-safe anywhere. The RT thread never touches this class.

#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "util/Json.h"

namespace mydaw {

class HttpWsServer {
public:
    using RespondFn = std::function<void(json reply)>;
    using MessageHandler = std::function<void(json msg, RespondFn respond)>;
    using PeaksProvider =
        std::function<std::optional<std::vector<uint8_t>>(uint64_t assetId, int lod)>;
    using UploadHandler =
        std::function<json(const std::vector<std::string>& tempFilePaths,
                           const std::map<std::string, std::string>& query)>;

    // POST/GET /mcp (embedded Streamable HTTP MCP transport). The server buffers the whole
    // request body (bounded), then invokes the handler on the SERVER thread with the parsed
    // request and a thread-safe `respond`. Like RespondFn, `respond` may be called later
    // from any non-RT thread (typically main) and is silently dropped if the client
    // disconnected or the server stopped. Exactly one `respond` call is expected.
    struct McpRequest {
        std::string method;        // "POST" / "GET" / ...
        std::string origin;        // Origin header value ("" if absent)
        std::string authorization; // Authorization header value ("" if absent)
        std::string contentType;   // Content-Type header value ("" if absent)
        std::string body;          // request body (possibly empty)
    };
    // (status, contentType, body, extraHeaders) — extraHeaders is zero or more complete
    // "Name: value\r\n" lines.
    using McpRespondFn = std::function<void(int status, std::string contentType,
                                            std::string body, std::string extraHeaders)>;
    using McpHandler = std::function<void(McpRequest req, McpRespondFn respond)>;

    HttpWsServer();
    ~HttpWsServer(); // calls stop()

    HttpWsServer(const HttpWsServer&) = delete;
    HttpWsServer& operator=(const HttpWsServer&) = delete;

    // Binds 127.0.0.1:port and starts the server thread. False + err on failure (port
    // in use, Winsock init failure, ...). uiRoot = directory served for static GETs.
    bool start(int port, const std::string& uiRoot, std::string& err);

    // Stops the server thread, closes all connections. Idempotent. After stop(),
    // start() may be called again. Outstanding respond closures become no-ops.
    void stop();

    // Handlers may be set before or after start(); calls are internally synchronized.
    void setMessageHandler(MessageHandler handler);
    void setPeaksProvider(PeaksProvider provider);
    void setUploadHandler(UploadHandler handler);
    void setMcpHandler(McpHandler handler);

    // Sends a pre-built event object (e.g. {"type":"event/...","payload":{...}}) to
    // every connected WS client as one JSON text frame. Thread-safe, non-RT.
    void broadcast(const json& event);

    // Number of live WebSocket clients (upgraded /ws connections). Thread-safe; used by the
    // idle-exit timer of "new window" child instances. 0 before any tab connects.
    int wsClientCount() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace mydaw
