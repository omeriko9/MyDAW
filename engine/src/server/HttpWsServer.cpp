// MyDAW — server/HttpWsServer.cpp
// Hand-rolled HTTP/1.1 + WebSocket server on Winsock. See HttpWsServer.h for the
// contract. Single server thread, select() loop, non-blocking sockets, per-client
// queued writes; cross-thread sends (broadcast / respond) go through a mutex-guarded
// outbox and a loopback "self-pipe" socket pair that wakes select().

#ifndef FD_SETSIZE
#define FD_SETSIZE 256 // must precede winsock2.h; default 64 is tight (clients + listen + wake)
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include "server/HttpWsServer.h"

#include "server/Multipart.h"
#include "server/Sha1.h"
#include "server/StaticFiles.h"
#include "util/Log.h"
#include "util/Paths.h"
#include "util/Strings.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#pragma comment(lib, "ws2_32.lib")

namespace mydaw {

namespace {

constexpr size_t kMaxHeaderBytes = 64 * 1024;               // request line + headers cap
constexpr uint64_t kMaxWsFrame = 16ull * 1024 * 1024;       // single WS frame cap
constexpr uint64_t kMaxWsMessage = 16ull * 1024 * 1024;     // reassembled message cap
constexpr uint64_t kMaxUploadBytes = 2ull * 1024 * 1024 * 1024; // POST /api/upload body cap
constexpr uint64_t kMaxMcpBodyBytes = 8ull * 1024 * 1024;   // POST /mcp JSON-RPC body cap
constexpr size_t kMaxSendBuffer = 64 * 1024 * 1024;         // per-client outgoing queue cap
constexpr size_t kMaxClients = 100;
constexpr size_t kMaxFormFieldBytes = 64 * 1024;            // non-file multipart field cap

// json -> text without ever throwing (invalid UTF-8 replaced).
std::string dumpJson(const json& j) {
    return j.dump(-1, ' ', false, json::error_handler_t::replace);
}

int hexVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool percentDecode(std::string_view in, bool plusAsSpace, std::string& out) {
    out.clear();
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        const char c = in[i];
        if (c == '%') {
            if (i + 2 >= in.size())
                return false;
            const int hi = hexVal(in[i + 1]);
            const int lo = hexVal(in[i + 2]);
            if (hi < 0 || lo < 0)
                return false;
            out.push_back(static_cast<char>(hi * 16 + lo));
            i += 2;
        } else if (plusAsSpace && c == '+') {
            out.push_back(' ');
        } else {
            out.push_back(c);
        }
    }
    return true;
}

std::map<std::string, std::string> parseQuery(const std::string& raw) {
    std::map<std::string, std::string> out;
    for (const auto& pair : split(raw, '&')) {
        const size_t eq = pair.find('=');
        std::string k, v;
        if (eq == std::string::npos) {
            if (!percentDecode(pair, true, k))
                continue;
        } else {
            if (!percentDecode(std::string_view(pair).substr(0, eq), true, k) ||
                !percentDecode(std::string_view(pair).substr(eq + 1), true, v))
                continue;
        }
        if (!k.empty())
            out.emplace(std::move(k), std::move(v));
    }
    return out;
}

const char* statusText(int status) {
    switch (status) {
        case 101: return "Switching Protocols";
        case 200: return "OK";
        case 304: return "Not Modified";
        case 400: return "Bad Request";
        case 404: return "Not Found";
        case 500: return "Internal Server Error";
        default:  return "OK";
    }
}

// `extraHeaders`: zero or more complete "Name: value\r\n" lines (e.g. an ETag).
std::string buildHttpResponse(int status, const std::string& contentType,
                              const std::string& body, const std::string& cacheControl,
                              bool keepAlive, bool headOnly,
                              const std::string& extraHeaders = std::string()) {
    std::string r;
    r.reserve(256 + (headOnly ? 0 : body.size()));
    r += "HTTP/1.1 ";
    r += std::to_string(status);
    r += ' ';
    r += statusText(status);
    r += "\r\nContent-Type: ";
    r += contentType;
    if (status != 304) { // a 304 never carries a body; a Content-Length would mislead
        r += "\r\nContent-Length: ";
        r += std::to_string(body.size());
    }
    r += "\r\n";
    if (!cacheControl.empty()) {
        r += "Cache-Control: ";
        r += cacheControl;
        r += "\r\n";
    }
    r += extraHeaders;
    r += keepAlive ? "Connection: keep-alive\r\n" : "Connection: close\r\n";
    r += "Server: mydaw-engine\r\n\r\n";
    if (!headOnly)
        r += body;
    return r;
}

// Strong content-derived ETag for peak payloads (FNV-1a 64). Peaks for a recycled
// asset id change bytes across models/sessions, so revalidation can never confirm
// another asset's cached entry.
std::string contentEtag(const std::vector<uint8_t>& bytes) {
    uint64_t h = 1469598103934665603ull; // FNV offset basis
    for (uint8_t b : bytes)
        h = (h ^ b) * 1099511628211ull; // FNV prime
    char buf[24];
    std::snprintf(buf, sizeof(buf), "\"%016llx\"", static_cast<unsigned long long>(h));
    return buf;
}

// RFC6455 server frame (unmasked). opcode: 0x1 text, 0x8 close, 0x9 ping, 0xA pong.
std::string makeWsFrame(uint8_t opcode, const std::string& payload) {
    std::string f;
    const size_t n = payload.size();
    f.reserve(n + 10);
    f.push_back(static_cast<char>(0x80u | (opcode & 0x0Fu))); // FIN + opcode
    if (n < 126) {
        f.push_back(static_cast<char>(n));
    } else if (n <= 0xFFFF) {
        f.push_back(static_cast<char>(126));
        f.push_back(static_cast<char>((n >> 8) & 0xFF));
        f.push_back(static_cast<char>(n & 0xFF));
    } else {
        f.push_back(static_cast<char>(127));
        for (int i = 7; i >= 0; --i)
            f.push_back(static_cast<char>((static_cast<uint64_t>(n) >> (i * 8)) & 0xFF));
    }
    f += payload;
    return f;
}

struct HttpRequest {
    std::string method;
    std::string path;     // percent-decoded, starts with '/'
    std::string queryRaw; // raw query string (decoded per key/value by parseQuery)
    std::map<std::string, std::string> headers; // lowercased names
    uint64_t contentLength = 0;
    bool hasContentLength = false;
    bool http11 = true;

    std::string header(const char* lowerName) const {
        const auto it = headers.find(lowerName);
        return it == headers.end() ? std::string() : it->second;
    }
};

bool parseRequest(const std::string& head, HttpRequest& out) {
    const size_t lineEnd = head.find("\r\n");
    const std::string requestLine =
        (lineEnd == std::string::npos) ? head : head.substr(0, lineEnd);
    const size_t sp1 = requestLine.find(' ');
    if (sp1 == std::string::npos)
        return false;
    const size_t sp2 = requestLine.find(' ', sp1 + 1);
    if (sp2 == std::string::npos)
        return false;
    out.method = requestLine.substr(0, sp1);
    std::string target = requestLine.substr(sp1 + 1, sp2 - sp1 - 1);
    const std::string version = trim(requestLine.substr(sp2 + 1));
    if (!startsWith(version, "HTTP/1."))
        return false;
    out.http11 = (version != "HTTP/1.0");

    const size_t q = target.find('?');
    const std::string rawPath = (q == std::string::npos) ? target : target.substr(0, q);
    out.queryRaw = (q == std::string::npos) ? std::string() : target.substr(q + 1);
    if (!percentDecode(rawPath, /*plusAsSpace=*/false, out.path))
        return false;
    if (out.path.empty() || out.path[0] != '/')
        return false;

    size_t cur = (lineEnd == std::string::npos) ? head.size() : lineEnd + 2;
    while (cur < head.size()) {
        size_t e = head.find("\r\n", cur);
        if (e == std::string::npos)
            e = head.size();
        const std::string line = head.substr(cur, e - cur);
        cur = (e == head.size()) ? e : e + 2;
        if (line.empty())
            continue;
        const size_t colon = line.find(':');
        if (colon == std::string::npos)
            continue;
        std::string name = lower(trim(line.substr(0, colon)));
        std::string value = trim(line.substr(colon + 1));
        auto it = out.headers.find(name);
        if (it == out.headers.end()) {
            out.headers.emplace(std::move(name), std::move(value));
        } else {
            it->second += ", ";
            it->second += value;
        }
    }

    const std::string cl = out.header("content-length");
    if (!cl.empty()) {
        char* end = nullptr;
        const unsigned long long v = std::strtoull(cl.c_str(), &end, 10);
        if (end == cl.c_str() || (end != nullptr && *end != '\0'))
            return false;
        out.contentLength = v;
        out.hasContentLength = true;
    }
    return true;
}

bool headerHasToken(const std::string& value, const char* token) {
    for (const auto& part : split(value, ','))
        if (iequals(trim(part), token))
            return true;
    return false;
}

bool isUpgradeRequest(const HttpRequest& req) {
    return headerHasToken(req.header("connection"), "upgrade") &&
           headerHasToken(req.header("upgrade"), "websocket");
}

std::string extractBoundary(const std::string& contentType) {
    const std::string lowerCt = lower(contentType);
    if (lowerCt.find("multipart/form-data") == std::string::npos)
        return std::string();
    const size_t pos = lowerCt.find("boundary=");
    if (pos == std::string::npos)
        return std::string();
    std::string v = contentType.substr(pos + 9); // original case (boundary is case-sensitive)
    const size_t sc = v.find(';');
    if (sc != std::string::npos)
        v = v.substr(0, sc);
    v = trim(v);
    if (v.size() >= 2 && v.front() == '"' && v.back() == '"')
        v = v.substr(1, v.size() - 2);
    return v;
}

void deleteFileUtf8(const std::string& path) {
    if (!path.empty())
        ::DeleteFileW(utf8ToWide(path).c_str());
}

// Keeps only short, purely alphanumeric extensions (".wav"); anything weird -> "".
std::string sanitizeExt(const std::string& ext) {
    if (ext.size() < 2 || ext.size() > 16 || ext[0] != '.')
        return std::string();
    for (size_t i = 1; i < ext.size(); ++i)
        if (!std::isalnum(static_cast<unsigned char>(ext[i])))
            return std::string();
    return ext;
}

// %TEMP%/mydaw-upload-<n>.<origext> — counter seeded from the pid so two concurrent
// engine instances never clobber each other's uploads.
std::string makeUploadTempPath(const std::string& origName) {
    wchar_t tmp[MAX_PATH + 2] = {0};
    const DWORD n = ::GetTempPathW(MAX_PATH + 1, tmp);
    const std::string dir =
        (n > 0) ? wideToUtf8(std::wstring_view(tmp, n)) : exeDir();
    static std::atomic<uint64_t> counter{
        static_cast<uint64_t>(::GetCurrentProcessId()) * 100000ull};
    const uint64_t id = counter.fetch_add(1, std::memory_order_relaxed);
    char name[80];
    std::snprintf(name, sizeof(name), "mydaw-upload-%llu",
                  static_cast<unsigned long long>(id));
    return pathJoin(dir, std::string(name) + sanitizeExt(fileExtension(origName)));
}

// Creates a connected loopback TCP pair used to wake select() from other threads.
bool makeWakePair(SOCKET& sendSide, SOCKET& recvSide, std::string& err) {
    sendSide = recvSide = INVALID_SOCKET;
    SOCKET listener = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) {
        err = "wake socket() failed";
        return false;
    }
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    bool ok = ::bind(listener, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0 &&
              ::listen(listener, 1) == 0;
    int alen = sizeof(addr);
    ok = ok && ::getsockname(listener, reinterpret_cast<sockaddr*>(&addr), &alen) == 0;
    if (ok) {
        sendSide = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        ok = sendSide != INVALID_SOCKET &&
             ::connect(sendSide, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
    }
    if (ok) {
        recvSide = ::accept(listener, nullptr, nullptr);
        ok = recvSide != INVALID_SOCKET;
    }
    ::closesocket(listener);
    if (!ok) {
        if (sendSide != INVALID_SOCKET)
            ::closesocket(sendSide);
        if (recvSide != INVALID_SOCKET)
            ::closesocket(recvSide);
        sendSide = recvSide = INVALID_SOCKET;
        err = "failed to create wake socket pair";
        return false;
    }
    u_long nb = 1;
    ::ioctlsocket(recvSide, FIONBIO, &nb);
    int one = 1;
    ::setsockopt(sendSide, IPPROTO_TCP, TCP_NODELAY,
                 reinterpret_cast<const char*>(&one), sizeof(one));
    return true;
}

// Cross-thread outgoing queue. respond()/broadcast() push here (any non-RT thread);
// the server thread drains and does all actual socket writes. Held via shared_ptr so
// respond closures stay safe after stop()/destruction (weak_ptr + `open` flag).
struct Outbox {
    struct Item {
        uint64_t clientId;   // 0 = broadcast (WS only)
        std::string payload; // WS: JSON text (framed on delivery). HTTP: full raw response.
        bool rawHttp;        // true = deliver verbatim to one HTTP client
        bool closeAfter;     // rawHttp only: close the connection once flushed
    };
    std::mutex mu;
    bool open = false;
    SOCKET wakeSend = INVALID_SOCKET;
    std::vector<Item> pending;

    void wake() {
        const char b = 1;
        ::send(wakeSend, &b, 1, 0); // wake select(); best-effort
    }
    void push(uint64_t clientId, std::string text) {
        std::lock_guard<std::mutex> lock(mu);
        if (!open)
            return; // server stopped — drop silently per contract
        pending.push_back(Item{clientId, std::move(text), false, false});
        wake();
    }
    void pushHttp(uint64_t clientId, std::string response, bool closeAfter) {
        std::lock_guard<std::mutex> lock(mu);
        if (!open)
            return;
        pending.push_back(Item{clientId, std::move(response), true, closeAfter});
        wake();
    }
};

struct UploadState {
    std::unique_ptr<MultipartParser> parser;
    uint64_t remaining = 0;
    std::vector<std::string> tempPaths;
    std::vector<std::string> origNames;
    std::map<std::string, std::string> query;  // from the URL query string
    std::map<std::string, std::string> fields; // non-file form fields
    FILE* curFile = nullptr;
    std::string curPath;
    std::string curOrigName;
    std::string curFieldName;
    std::string curFieldValue;
    bool curIsFile = false;
    bool active = false;
    bool failed = false;
    std::string failReason;
};

// Buffered POST body for a /mcp request awaiting an async handler response.
struct McpBodyState {
    bool active = false;
    uint64_t remaining = 0;
    std::string body;
    std::string method;
    std::string origin;
    std::string authorization;
    std::string contentType;
};

struct Client {
    enum class State { HttpHeaders, HttpBody, McpBody, Ws };

    SOCKET sock = INVALID_SOCKET;
    uint64_t id = 0;
    State state = State::HttpHeaders;
    std::string recvBuf;
    std::string sendBuf;
    size_t sendOff = 0;
    bool dead = false;
    bool closeAfterFlush = false;
    bool keepAlive = true;
    // While an async /mcp response is pending, buffer any further bytes but do not process
    // them (drainOutbox clears this and returns the client to HttpHeaders on delivery).
    bool awaitingAsync = false;
    // WebSocket
    bool wsCloseSent = false;
    int msgOpcode = 0;   // 0 = no fragmented message in progress
    std::string msgBuf;  // fragmented-message reassembly
    // Upload
    UploadState upload;
    // MCP
    McpBodyState mcp;
};

} // namespace

// ---------------------------------------------------------------------------

struct HttpWsServer::Impl {
    // Guarded by stateMu (accessed from start/stop/broadcast threads + server thread).
    std::mutex stateMu;
    std::shared_ptr<Outbox> outbox;

    std::atomic<bool> running{false};
    bool wsaInit = false;
    bool logSinkInstalled = false;
    SOCKET listenSock = INVALID_SOCKET;
    SOCKET wakeRecv = INVALID_SOCKET;
    SOCKET wakeSend = INVALID_SOCKET;
    std::thread thread;
    StaticFiles staticFiles;

    std::mutex handlersMu;
    MessageHandler messageHandler;
    PeaksProvider peaksProvider;
    UploadHandler uploadHandler;
    McpHandler mcpHandler;

    // Server-thread-only state.
    std::map<uint64_t, std::unique_ptr<Client>> clients;
    uint64_t nextClientId = 1;
    // Live upgraded WS clients — read cross-thread by wsClientCount() (idle-exit timer).
    std::atomic<int> wsClients{0};

    ~Impl() { stopImpl(); }

    std::shared_ptr<Outbox> outboxRef() {
        std::lock_guard<std::mutex> lock(stateMu);
        return outbox;
    }

    // ---- lifecycle -------------------------------------------------------

    bool startImpl(int port, const std::string& uiRoot, std::string& err) {
        if (running.load()) {
            err = "server already running";
            return false;
        }
        WSADATA wsa;
        if (::WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
            err = "WSAStartup failed";
            return false;
        }
        wsaInit = true;

        listenSock = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (listenSock == INVALID_SOCKET) {
            err = "socket() failed: " + std::to_string(::WSAGetLastError());
            cleanupSockets();
            return false;
        }
        // Fail loudly if another engine instance already owns the port.
        BOOL excl = TRUE;
        ::setsockopt(listenSock, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
                     reinterpret_cast<const char*>(&excl), sizeof(excl));
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons(static_cast<u_short>(port));
        if (::bind(listenSock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
            err = "cannot bind 127.0.0.1:" + std::to_string(port) +
                  " (already in use?) — WSA error " + std::to_string(::WSAGetLastError());
            cleanupSockets();
            return false;
        }
        if (::listen(listenSock, SOMAXCONN) != 0) {
            err = "listen() failed: " + std::to_string(::WSAGetLastError());
            cleanupSockets();
            return false;
        }
        u_long nb = 1;
        ::ioctlsocket(listenSock, FIONBIO, &nb);

        if (!makeWakePair(wakeSend, wakeRecv, err)) {
            cleanupSockets();
            return false;
        }

        auto ob = std::make_shared<Outbox>();
        ob->open = true;
        ob->wakeSend = wakeSend;
        {
            std::lock_guard<std::mutex> lock(stateMu);
            outbox = ob;
        }

        staticFiles.setRoot(uiRoot);
        running.store(true);
        thread = std::thread([this] { run(); });

        // SPEC §5.7: `event/log {level,msg}` for warn+error lines, to every WS client.
        // NOTE(spec): Log has a single sink slot; if E9 installs its own sink it simply
        // replaces this one (and should then broadcast event/log itself).
        std::weak_ptr<Outbox> weakOb = ob;
        Log::setSink([weakOb](Log::Level level, const std::string& line) {
            if (level < Log::kWarn)
                return;
            const auto obx = weakOb.lock();
            if (!obx)
                return;
            json ev;
            ev["type"] = "event/log";
            ev["payload"] = json{{"level", Log::levelName(level)}, {"msg", line}};
            obx->push(0, dumpJson(ev));
        });
        logSinkInstalled = true;

        Log::info("[server] listening on http://127.0.0.1:%d (ui root: %s)", port,
                  uiRoot.c_str());
        return true;
    }

    void stopImpl() {
        const bool wasRunning = running.exchange(false);
        std::shared_ptr<Outbox> ob;
        {
            std::lock_guard<std::mutex> lock(stateMu);
            ob = outbox;
        }
        if (ob) {
            std::lock_guard<std::mutex> lock(ob->mu);
            ob->open = false; // respond()/broadcast() become no-ops
        }
        if (logSinkInstalled) {
            Log::setSink(nullptr);
            logSinkInstalled = false;
        }
        if (wasRunning && wakeSend != INVALID_SOCKET) {
            const char b = 0;
            ::send(wakeSend, &b, 1, 0); // break select()
        }
        if (thread.joinable())
            thread.join();
        {
            std::lock_guard<std::mutex> lock(stateMu);
            outbox.reset();
        }
        cleanupSockets();
        if (wsaInit) {
            ::WSACleanup();
            wsaInit = false;
        }
    }

    void cleanupSockets() {
        if (listenSock != INVALID_SOCKET) {
            ::closesocket(listenSock);
            listenSock = INVALID_SOCKET;
        }
        if (wakeRecv != INVALID_SOCKET) {
            ::closesocket(wakeRecv);
            wakeRecv = INVALID_SOCKET;
        }
        if (wakeSend != INVALID_SOCKET) {
            ::closesocket(wakeSend);
            wakeSend = INVALID_SOCKET;
        }
    }

    // ---- server thread ----------------------------------------------------

    void run() {
        while (running.load()) {
            fd_set rfds, wfds;
            FD_ZERO(&rfds);
            FD_ZERO(&wfds);
            FD_SET(listenSock, &rfds);
            FD_SET(wakeRecv, &rfds);
            for (auto& [id, c] : clients) {
                (void)id;
                if (c->dead)
                    continue;
                FD_SET(c->sock, &rfds);
                if (c->sendOff < c->sendBuf.size())
                    FD_SET(c->sock, &wfds);
            }
            timeval tv{1, 0}; // safety net; the wake pair handles prompt wakeups
            const int rc = ::select(0, &rfds, &wfds, nullptr, &tv);
            if (!running.load())
                break;
            if (rc == SOCKET_ERROR) {
                Log::warn("[server] select() failed: %d", ::WSAGetLastError());
                ::Sleep(50);
                continue;
            }
            if (FD_ISSET(wakeRecv, &rfds))
                drainWake();
            drainOutbox(); // also covers wake bytes raced past the timeout
            if (FD_ISSET(listenSock, &rfds))
                acceptClients();
            for (auto& [id, c] : clients) {
                (void)id;
                if (!c->dead && FD_ISSET(c->sock, &rfds))
                    onReadable(*c);
            }
            drainOutbox(); // responds enqueued synchronously by message handlers
            for (auto& [id, c] : clients) {
                (void)id;
                if (!c->dead && (c->sendOff < c->sendBuf.size() || c->closeAfterFlush))
                    flushSend(*c);
            }
            sweepDead();
        }
        for (auto& [id, c] : clients) {
            (void)id;
            if (c->upload.active)
                cleanupUpload(*c);
            ::closesocket(c->sock);
        }
        clients.clear();
    }

    void drainWake() {
        char tmp[256];
        while (::recv(wakeRecv, tmp, sizeof(tmp), 0) > 0) {
        }
    }

    void acceptClients() {
        for (;;) {
            SOCKET s = ::accept(listenSock, nullptr, nullptr);
            if (s == INVALID_SOCKET)
                break; // WSAEWOULDBLOCK -> done
            if (clients.size() >= kMaxClients) {
                Log::warn("[server] refusing connection: client limit (%zu) reached",
                          kMaxClients);
                ::closesocket(s);
                continue;
            }
            u_long nb = 1;
            ::ioctlsocket(s, FIONBIO, &nb);
            int one = 1;
            ::setsockopt(s, IPPROTO_TCP, TCP_NODELAY,
                         reinterpret_cast<const char*>(&one), sizeof(one));
            auto client = std::make_unique<Client>();
            client->sock = s;
            client->id = nextClientId++;
            clients.emplace(client->id, std::move(client));
        }
    }

    void onReadable(Client& c) {
        if (c.closeAfterFlush) {
            // Response queued, connection ending: discard whatever else arrives
            // (e.g. the rest of a rejected upload body). Bounded per round so the
            // pending response still gets flushed.
            char tmp[16384];
            for (int rounds = 0; rounds < 1024; ++rounds) {
                const int n = ::recv(c.sock, tmp, sizeof(tmp), 0);
                if (n > 0)
                    continue;
                if (n == 0)
                    c.dead = true;
                else if (::WSAGetLastError() != WSAEWOULDBLOCK)
                    c.dead = true;
                break;
            }
            return;
        }
        char buf[16384];
        int rounds = 0;
        for (;;) {
            const int n = ::recv(c.sock, buf, sizeof(buf), 0);
            if (n > 0) {
                c.recvBuf.append(buf, static_cast<size_t>(n));
                processBuffered(c);
                if (c.dead || c.closeAfterFlush)
                    return;
                if (++rounds >= 256)
                    return; // fairness: let other clients run; select() refires
                continue;
            }
            if (n == 0) {
                c.dead = true;
                return;
            }
            if (::WSAGetLastError() != WSAEWOULDBLOCK)
                c.dead = true;
            return;
        }
    }

    void processBuffered(Client& c) {
        for (;;) {
            if (c.dead || c.closeAfterFlush)
                return;
            if (c.awaitingAsync)
                return; // an async /mcp response is pending — buffer, do not process
            switch (c.state) {
                case Client::State::HttpHeaders: {
                    if (c.recvBuf.empty())
                        return;
                    const size_t pos = c.recvBuf.find("\r\n\r\n");
                    if (pos == std::string::npos) {
                        if (c.recvBuf.size() > kMaxHeaderBytes) {
                            queueJsonError(c, 400, "bad_request", "request headers too large");
                            c.closeAfterFlush = true;
                        }
                        return;
                    }
                    if (pos > kMaxHeaderBytes) {
                        queueJsonError(c, 400, "bad_request", "request headers too large");
                        c.closeAfterFlush = true;
                        return;
                    }
                    const std::string head = c.recvBuf.substr(0, pos);
                    c.recvBuf.erase(0, pos + 4);
                    HttpRequest req;
                    if (!parseRequest(head, req)) {
                        queueJsonError(c, 400, "bad_request", "malformed HTTP request");
                        c.closeAfterFlush = true;
                        return;
                    }
                    dispatchRequest(c, req);
                    break; // loop: body bytes or a pipelined request may be buffered
                }
                case Client::State::HttpBody: {
                    if (!feedUploadBody(c))
                        return; // need more body bytes (or failed -> closing)
                    break;
                }
                case Client::State::McpBody:
                    feedMcpBody(c); // completes -> awaiting async, or waits for more bytes
                    return;
                case Client::State::Ws:
                    processWsFrames(c);
                    return;
            }
        }
    }

    // ---- HTTP ---------------------------------------------------------------

    void queueRaw(Client& c, const std::string& data) {
        if (c.dead)
            return;
        if ((c.sendBuf.size() - c.sendOff) + data.size() > kMaxSendBuffer) {
            Log::warn("[server] client #%llu send queue overflow — dropping client",
                      static_cast<unsigned long long>(c.id));
            c.dead = true;
            return;
        }
        if (c.sendOff > 0 && c.sendOff == c.sendBuf.size()) {
            c.sendBuf.clear();
            c.sendOff = 0;
        }
        c.sendBuf += data;
    }

    void queueHttp(Client& c, int status, const std::string& contentType,
                   const std::string& body, const std::string& cacheControl,
                   bool headOnly, const std::string& extraHeaders = std::string()) {
        const bool keep = c.keepAlive && !c.closeAfterFlush;
        queueRaw(c, buildHttpResponse(status, contentType, body, cacheControl, keep,
                                      headOnly, extraHeaders));
        if (!keep)
            c.closeAfterFlush = true;
    }

    void queueJsonError(Client& c, int status, const char* code,
                        const std::string& message) {
        json body;
        body["error"] = json{{"code", code}, {"message", message}};
        queueHttp(c, status, "application/json; charset=utf-8", dumpJson(body),
                  "no-cache", false);
    }

    void dispatchRequest(Client& c, HttpRequest& req) {
        const bool isGet = iequals(req.method, "GET");
        const bool isHead = iequals(req.method, "HEAD");
        const bool isPost = iequals(req.method, "POST");
        const bool isUpload = isPost && req.path == "/api/upload";
        const bool isMcp = req.path == "/mcp";
        const bool isMcpPost = isPost && isMcp;

        bool keep = req.http11;
        const std::string conn = req.header("connection");
        if (headerHasToken(conn, "close"))
            keep = false;
        if (!req.http11 && headerHasToken(conn, "keep-alive"))
            keep = true;
        // Any request carrying a body we will not consume desyncs the stream -> close.
        if (!isUpload && !isMcpPost && req.hasContentLength && req.contentLength > 0)
            keep = false;
        c.keepAlive = keep;

        if (isMcp) {
            beginMcp(c, req, isMcpPost);
            return;
        }
        if (req.path == "/ws") {
            if (isGet && isUpgradeRequest(req)) {
                doWsHandshake(c, req);
            } else {
                queueJsonError(c, 400, "bad_request", "expected WebSocket upgrade at /ws");
            }
            return;
        }
        if (isGet || isHead) {
            if (startsWith(req.path, "/api/")) {
                handleApiGet(c, req, isHead);
                return;
            }
            const auto file = staticFiles.get(req.path);
            if (file)
                queueHttp(c, 200, file->contentType, file->body, file->cacheControl,
                          isHead);
            else
                queueJsonError(c, 404, "not_found", "no such file: " + req.path);
            return;
        }
        if (isUpload) {
            beginUpload(c, req);
            return;
        }
        if (isPost) {
            queueJsonError(c, 404, "not_found", "no such endpoint: " + req.path);
            c.closeAfterFlush = true;
            return;
        }
        queueJsonError(c, 400, "bad_request", "unsupported method: " + req.method);
        c.closeAfterFlush = true;
    }

    void handleApiGet(Client& c, const HttpRequest& req, bool headOnly) {
        static const char kPeaksPrefix[] = "/api/peaks/";
        if (startsWith(req.path, kPeaksPrefix)) {
            const std::string idStr = req.path.substr(sizeof(kPeaksPrefix) - 1);
            char* end = nullptr;
            const unsigned long long assetId = std::strtoull(idStr.c_str(), &end, 10);
            if (idStr.empty() || end == idStr.c_str() || (end != nullptr && *end != '\0')) {
                queueJsonError(c, 400, "bad_request", "bad asset id: " + idStr);
                return;
            }
            const auto query = parseQuery(req.queryRaw);
            int lod = 0;
            const auto it = query.find("lod");
            if (it != query.end())
                lod = std::atoi(it->second.c_str());

            PeaksProvider provider;
            {
                std::lock_guard<std::mutex> lock(handlersMu);
                provider = peaksProvider;
            }
            if (!provider) {
                queueJsonError(c, 404, "not_found", "peaks provider unavailable");
                return;
            }
            const auto data = provider(static_cast<uint64_t>(assetId), lod);
            if (!data) {
                queueJsonError(c, 404, "not_found",
                               "no peaks for asset " + std::to_string(assetId));
                return;
            }
            // NOT immutable: asset ids recycle per model, so a long-lived cache entry
            // could serve another project's waveform for a colliding id. no-cache makes
            // the browser revalidate every hit; the content-derived ETag turns an
            // unchanged file into a cheap 304 (localhost round-trip) and a changed one
            // into fresh bytes.
            const std::string etag = contentEtag(*data);
            const std::string inm = req.header("if-none-match");
            if (!inm.empty() && inm.find(etag) != std::string::npos) {
                queueHttp(c, 304, "application/octet-stream", "", "no-cache",
                          /*headOnly=*/true, "ETag: " + etag + "\r\n");
                return;
            }
            std::string body(reinterpret_cast<const char*>(data->data()), data->size());
            queueHttp(c, 200, "application/octet-stream", body, "no-cache", headOnly,
                      "ETag: " + etag + "\r\n");
            return;
        }
        queueJsonError(c, 404, "not_found", "unknown api endpoint: " + req.path);
    }

    // ---- MCP (embedded Streamable HTTP transport) ---------------------------

    void beginMcp(Client& c, const HttpRequest& req, bool isPost) {
        if (!isPost) {
            // No SSE stream in this version; a GET is answered 405 per the MCP spec.
            const bool headOnly = iequals(req.method, "HEAD");
            json body;
            body["error"] = json{{"code", "method_not_allowed"},
                                 {"message", "MCP endpoint accepts POST JSON-RPC only"}};
            queueHttp(c, 405, "application/json; charset=utf-8", dumpJson(body), "no-cache",
                      headOnly, "Allow: POST\r\n");
            return;
        }
        const std::string te = lower(req.header("transfer-encoding"));
        if (!te.empty() && te != "identity") {
            queueJsonError(c, 400, "bad_request", "chunked MCP requests are not supported");
            c.closeAfterFlush = true;
            return;
        }
        if (req.contentLength > kMaxMcpBodyBytes) {
            queueJsonError(c, 413, "too_large", "MCP request body exceeds the limit");
            c.closeAfterFlush = true;
            return;
        }
        if (iequals(trim(req.header("expect")), "100-continue"))
            queueRaw(c, "HTTP/1.1 100 Continue\r\n\r\n");

        c.mcp = McpBodyState{};
        c.mcp.active = true;
        c.mcp.remaining = req.hasContentLength ? req.contentLength : 0;
        c.mcp.method = req.method;
        c.mcp.origin = req.header("origin");
        c.mcp.authorization = req.header("authorization");
        c.mcp.contentType = req.header("content-type");
        c.state = Client::State::McpBody;
        if (c.mcp.remaining == 0)
            invokeMcp(c);
    }

    // Returns true when the body completed (handler invoked); false = wait for more bytes.
    bool feedMcpBody(Client& c) {
        auto& m = c.mcp;
        const size_t take =
            static_cast<size_t>(std::min<uint64_t>(c.recvBuf.size(), m.remaining));
        if (take > 0) {
            m.body.append(c.recvBuf.data(), take);
            m.remaining -= take;
            c.recvBuf.erase(0, take);
        }
        if (m.remaining > 0)
            return false;
        invokeMcp(c);
        return true;
    }

    void invokeMcp(Client& c) {
        McpHandler handler;
        {
            std::lock_guard<std::mutex> lock(handlersMu);
            handler = mcpHandler;
        }
        auto& m = c.mcp;
        if (!handler) {
            queueJsonError(c, 503, "unavailable", "MCP handler not installed");
            c.closeAfterFlush = true;
            m = McpBodyState{};
            return;
        }
        McpRequest req;
        req.method = std::move(m.method);
        req.origin = std::move(m.origin);
        req.authorization = std::move(m.authorization);
        req.contentType = std::move(m.contentType);
        req.body = std::move(m.body);
        m = McpBodyState{}; // consumed; the response arrives later via the outbox
        c.awaitingAsync = true;

        std::weak_ptr<Outbox> weakOb = outboxRef();
        const uint64_t clientId = c.id;
        const bool keep = c.keepAlive;
        McpRespondFn respond = [weakOb, clientId, keep](int status, std::string contentType,
                                                        std::string body,
                                                        std::string extraHeaders) {
            if (const auto ob = weakOb.lock()) {
                std::string resp = buildHttpResponse(status, contentType, body, "no-cache",
                                                     keep, /*headOnly=*/false, extraHeaders);
                ob->pushHttp(clientId, std::move(resp), /*closeAfter=*/!keep);
            }
        };
        handler(std::move(req), std::move(respond));
    }

    // ---- upload -------------------------------------------------------------

    void beginUpload(Client& c, const HttpRequest& req) {
        const std::string te = lower(req.header("transfer-encoding"));
        if (!te.empty() && te != "identity") {
            queueJsonError(c, 400, "bad_request", "chunked uploads not supported");
            c.closeAfterFlush = true;
            return;
        }
        const std::string boundary = extractBoundary(req.header("content-type"));
        if (boundary.empty()) {
            queueJsonError(c, 400, "bad_request",
                           "expected multipart/form-data with a boundary");
            c.closeAfterFlush = true;
            return;
        }
        if (!req.hasContentLength || req.contentLength == 0) {
            queueJsonError(c, 400, "bad_request", "missing Content-Length");
            c.closeAfterFlush = true;
            return;
        }
        if (req.contentLength > kMaxUploadBytes) {
            queueJsonError(c, 400, "too_large", "upload exceeds the 2 GiB limit");
            c.closeAfterFlush = true;
            return;
        }
        if (iequals(trim(req.header("expect")), "100-continue"))
            queueRaw(c, "HTTP/1.1 100 Continue\r\n\r\n");

        c.upload = UploadState{};
        auto& u = c.upload;
        u.active = true;
        u.remaining = req.contentLength;
        u.query = parseQuery(req.queryRaw);
        u.parser = std::make_unique<MultipartParser>(boundary);
        Client* cp = &c; // stable: clients are heap-allocated (unique_ptr in the map)
        u.parser->onPartBegin([this, cp](const MultipartParser::PartInfo& info) {
            uploadPartBegin(*cp, info);
        });
        u.parser->onPartData([this, cp](const char* d, size_t n) {
            uploadPartData(*cp, d, n);
        });
        u.parser->onPartEnd([this, cp]() { uploadPartEnd(*cp); });
        c.state = Client::State::HttpBody;
    }

    // Returns true when the request completed (state advanced); false = wait for bytes.
    bool feedUploadBody(Client& c) {
        auto& u = c.upload;
        const size_t take = static_cast<size_t>(
            std::min<uint64_t>(c.recvBuf.size(), u.remaining));
        if (take > 0) {
            if (!u.failed && u.parser) {
                if (!u.parser->feed(c.recvBuf.data(), take) && !u.failed) {
                    u.failed = true;
                    u.failReason = "malformed multipart body";
                }
            }
            u.remaining -= take;
            c.recvBuf.erase(0, take);
        }
        if (u.failed) {
            const std::string reason =
                u.failReason.empty() ? "upload failed" : u.failReason;
            cleanupUpload(c);
            c.upload = UploadState{};
            c.state = Client::State::HttpHeaders;
            queueJsonError(c, 400, "bad_upload", reason);
            c.closeAfterFlush = true; // unread body remains -> cannot keep alive
            return true;
        }
        if (u.remaining > 0)
            return false;
        c.state = Client::State::HttpHeaders;
        finalizeUpload(c);
        return true;
    }

    void uploadPartBegin(Client& c, const MultipartParser::PartInfo& info) {
        auto& u = c.upload;
        if (u.failed)
            return;
        u.curIsFile = false;
        u.curFieldName.clear();
        u.curFieldValue.clear();
        if (info.name == "files" && !info.filename.empty()) {
            const std::string orig = fileName(info.filename); // strip client-side path
            const std::string path = makeUploadTempPath(orig);
            FILE* f = _wfopen(utf8ToWide(path).c_str(), L"wb");
            if (!f) {
                u.failed = true;
                u.failReason = "cannot create temp file for upload";
                return;
            }
            u.curFile = f;
            u.curPath = path;
            u.curOrigName = orig;
            u.curIsFile = true;
        } else {
            u.curFieldName = info.name;
        }
    }

    void uploadPartData(Client& c, const char* data, size_t len) {
        auto& u = c.upload;
        if (u.failed || len == 0)
            return;
        if (u.curIsFile && u.curFile) {
            if (std::fwrite(data, 1, len, u.curFile) != len) {
                u.failed = true;
                u.failReason = "temp file write failed (disk full?)";
            }
        } else if (!u.curFieldName.empty() && u.curFieldValue.size() < kMaxFormFieldBytes) {
            u.curFieldValue.append(
                data, std::min(len, kMaxFormFieldBytes - u.curFieldValue.size()));
        }
    }

    void uploadPartEnd(Client& c) {
        auto& u = c.upload;
        if (u.curIsFile) {
            if (u.curFile) {
                std::fclose(u.curFile);
                u.curFile = nullptr;
            }
            if (!u.failed) {
                u.tempPaths.push_back(u.curPath);
                u.origNames.push_back(u.curOrigName);
            } else {
                deleteFileUtf8(u.curPath);
            }
            u.curIsFile = false;
            u.curPath.clear();
            u.curOrigName.clear();
        } else if (!u.curFieldName.empty()) {
            u.fields.emplace(u.curFieldName, u.curFieldValue);
            u.curFieldName.clear();
            u.curFieldValue.clear();
        }
    }

    void cleanupUpload(Client& c) {
        auto& u = c.upload;
        if (u.curFile) {
            std::fclose(u.curFile);
            u.curFile = nullptr;
        }
        if (!u.curPath.empty()) {
            deleteFileUtf8(u.curPath);
            u.curPath.clear();
        }
        for (const auto& p : u.tempPaths)
            deleteFileUtf8(p);
        u.tempPaths.clear();
        u.parser.reset();
        u.active = false;
    }

    void finalizeUpload(Client& c) {
        auto& u = c.upload;
        const bool wellFormed = !u.failed && u.parser && u.parser->finish();
        if (!wellFormed) {
            const std::string reason =
                u.failReason.empty() ? "malformed multipart body" : u.failReason;
            cleanupUpload(c);
            c.upload = UploadState{};
            queueJsonError(c, 400, "bad_upload", reason);
            return;
        }
        if (u.tempPaths.empty()) {
            cleanupUpload(c);
            c.upload = UploadState{};
            queueJsonError(c, 400, "no_files", "no parts with field name \"files\"");
            return;
        }

        std::map<std::string, std::string> query = u.query;
        for (size_t i = 0; i < u.tempPaths.size(); ++i)
            query.emplace("file" + std::to_string(i),
                          i < u.origNames.size() ? u.origNames[i] : std::string());
        for (const auto& f : u.fields)
            query.emplace(f.first, f.second); // URL query wins on key collision

        UploadHandler handler;
        {
            std::lock_guard<std::mutex> lock(handlersMu);
            handler = uploadHandler;
        }
        if (!handler) {
            cleanupUpload(c);
            c.upload = UploadState{};
            queueJsonError(c, 500, "no_upload_handler",
                           "engine upload handler not installed");
            return;
        }
        json reply;
        bool ok = true;
        try {
            reply = handler(u.tempPaths, query); // server thread; may take a while
        } catch (...) {
            ok = false;
        }
        if (!ok) {
            cleanupUpload(c); // handler threw -> the server deletes the temp files
            c.upload = UploadState{};
            queueJsonError(c, 500, "upload_failed", "upload handler error");
            return;
        }
        // Success: the handler now owns (and deletes) the temp files.
        c.upload = UploadState{};
        queueHttp(c, 200, "application/json; charset=utf-8", dumpJson(reply), "no-cache",
                  false);
    }

    // ---- WebSocket ----------------------------------------------------------

    void doWsHandshake(Client& c, const HttpRequest& req) {
        const std::string key = trim(req.header("sec-websocket-key"));
        if (key.empty()) {
            queueJsonError(c, 400, "bad_request", "missing Sec-WebSocket-Key");
            c.closeAfterFlush = true;
            return;
        }
        const std::string version = trim(req.header("sec-websocket-version"));
        if (version != "13") {
            queueJsonError(c, 400, "bad_request", "unsupported Sec-WebSocket-Version");
            c.closeAfterFlush = true;
            return;
        }
        std::string resp = "HTTP/1.1 101 Switching Protocols\r\n"
                           "Upgrade: websocket\r\n"
                           "Connection: Upgrade\r\n"
                           "Sec-WebSocket-Accept: ";
        resp += webSocketAccept(key);
        resp += "\r\n\r\n";
        queueRaw(c, resp);
        c.state = Client::State::Ws;
        wsClients.fetch_add(1, std::memory_order_relaxed);
        Log::info("[server] ws client #%llu connected",
                  static_cast<unsigned long long>(c.id));
    }

    void wsFail(Client& c, uint16_t code, const char* reason) {
        std::string payload;
        payload.push_back(static_cast<char>((code >> 8) & 0xFF));
        payload.push_back(static_cast<char>(code & 0xFF));
        payload += reason;
        if (payload.size() > 125)
            payload.resize(125);
        if (!c.wsCloseSent) {
            queueRaw(c, makeWsFrame(0x8, payload));
            c.wsCloseSent = true;
        }
        c.closeAfterFlush = true;
    }

    void processWsFrames(Client& c) {
        for (;;) {
            std::string& b = c.recvBuf;
            if (b.size() < 2)
                return;
            const uint8_t b0 = static_cast<uint8_t>(b[0]);
            const uint8_t b1 = static_cast<uint8_t>(b[1]);
            const bool fin = (b0 & 0x80u) != 0;
            if ((b0 & 0x70u) != 0) { // RSV bits: no extensions negotiated
                wsFail(c, 1002, "reserved bits set");
                return;
            }
            const int opcode = b0 & 0x0F;
            const bool masked = (b1 & 0x80u) != 0;
            uint64_t plen = static_cast<uint64_t>(b1 & 0x7Fu);
            size_t pos = 2;
            if (plen == 126) {
                if (b.size() < 4)
                    return;
                plen = (static_cast<uint64_t>(static_cast<uint8_t>(b[2])) << 8) |
                       static_cast<uint64_t>(static_cast<uint8_t>(b[3]));
                pos = 4;
            } else if (plen == 127) {
                if (b.size() < 10)
                    return;
                plen = 0;
                for (int i = 0; i < 8; ++i)
                    plen = (plen << 8) | static_cast<uint64_t>(static_cast<uint8_t>(b[2 + i]));
                pos = 10;
            }
            if (plen > kMaxWsFrame) {
                wsFail(c, 1009, "frame too large");
                return;
            }
            if (!masked) { // RFC 6455 §5.1: client frames MUST be masked
                wsFail(c, 1002, "client frames must be masked");
                return;
            }
            if (b.size() < pos + 4 + static_cast<size_t>(plen))
                return; // wait for the full frame
            uint8_t mask[4] = {
                static_cast<uint8_t>(b[pos]), static_cast<uint8_t>(b[pos + 1]),
                static_cast<uint8_t>(b[pos + 2]), static_cast<uint8_t>(b[pos + 3])};
            pos += 4;
            std::string payload = b.substr(pos, static_cast<size_t>(plen));
            for (size_t i = 0; i < payload.size(); ++i)
                payload[i] = static_cast<char>(static_cast<uint8_t>(payload[i]) ^ mask[i & 3]);
            b.erase(0, pos + static_cast<size_t>(plen));

            switch (opcode) {
                case 0x8: { // close handshake
                    if (!c.wsCloseSent) {
                        const std::string echo =
                            payload.substr(0, std::min<size_t>(payload.size(), 125));
                        queueRaw(c, makeWsFrame(0x8, echo));
                        c.wsCloseSent = true;
                    }
                    c.closeAfterFlush = true;
                    return;
                }
                case 0x9: // ping -> pong
                    if (payload.size() > 125 || !fin) {
                        wsFail(c, 1002, "bad control frame");
                        return;
                    }
                    queueRaw(c, makeWsFrame(0xA, payload));
                    break;
                case 0xA: // pong: ignore
                    break;
                case 0x0:   // continuation
                case 0x1:   // text
                case 0x2: { // binary
                    if (opcode == 0x0) {
                        if (c.msgOpcode == 0) {
                            wsFail(c, 1002, "unexpected continuation frame");
                            return;
                        }
                    } else {
                        if (c.msgOpcode != 0) {
                            wsFail(c, 1002, "new message inside fragmented message");
                            return;
                        }
                        c.msgOpcode = opcode;
                        c.msgBuf.clear();
                    }
                    if (c.msgBuf.size() + payload.size() > kMaxWsMessage) {
                        wsFail(c, 1009, "message too large");
                        return;
                    }
                    c.msgBuf += payload;
                    if (fin) {
                        const int op = c.msgOpcode;
                        c.msgOpcode = 0;
                        std::string msg = std::move(c.msgBuf);
                        c.msgBuf = std::string();
                        if (op == 0x1) {
                            onWsMessage(c, msg);
                        } else {
                            wsFail(c, 1003, "binary frames not supported");
                            return;
                        }
                    }
                    break;
                }
                default:
                    wsFail(c, 1002, "unknown opcode");
                    return;
            }
            if (c.dead || c.closeAfterFlush)
                return;
        }
    }

    void onWsMessage(Client& c, const std::string& text) {
        json msg = parseJson(text);
        if (msg.is_discarded()) {
            Log::warn("[server] ws client #%llu sent invalid JSON (%zu bytes) — ignored",
                      static_cast<unsigned long long>(c.id), text.size());
            return;
        }
        MessageHandler handler;
        {
            std::lock_guard<std::mutex> lock(handlersMu);
            handler = messageHandler;
        }
        if (!handler) {
            Log::warn("[server] ws message dropped: no message handler installed");
            return;
        }
        std::weak_ptr<Outbox> weakOb = outboxRef();
        const uint64_t clientId = c.id;
        RespondFn respond = [weakOb, clientId](json reply) {
            if (const auto ob = weakOb.lock())
                ob->push(clientId, dumpJson(reply)); // dropped if server stopped
        };
        handler(std::move(msg), std::move(respond));
    }

    // ---- outgoing -----------------------------------------------------------

    void drainOutbox() {
        std::vector<Outbox::Item> items;
        const auto ob = outboxRef();
        if (!ob)
            return;
        {
            std::lock_guard<std::mutex> lock(ob->mu);
            if (ob->pending.empty())
                return;
            items.swap(ob->pending);
        }
        for (auto& item : items) {
            if (item.rawHttp) { // async /mcp response to one HTTP client
                const auto it = clients.find(item.clientId);
                if (it == clients.end() || it->second->dead)
                    continue; // client disconnected — response dropped per contract
                Client& cl = *it->second;
                queueRaw(cl, item.payload);
                cl.awaitingAsync = false;
                if (item.closeAfter) {
                    cl.closeAfterFlush = true;
                } else {
                    cl.state = Client::State::HttpHeaders; // ready for the next request
                    if (!cl.recvBuf.empty())
                        processBuffered(cl); // a pipelined request may already be buffered
                }
                continue;
            }
            const std::string frame = makeWsFrame(0x1, item.payload);
            if (item.clientId == 0) { // broadcast: every open WS client (multi-tab)
                for (auto& [id, c] : clients) {
                    (void)id;
                    if (!c->dead && c->state == Client::State::Ws && !c->wsCloseSent)
                        queueRaw(*c, frame);
                }
            } else {
                const auto it = clients.find(item.clientId);
                if (it != clients.end() && !it->second->dead &&
                    it->second->state == Client::State::Ws && !it->second->wsCloseSent)
                    queueRaw(*it->second, frame);
                // else: client disconnected — respond dropped per contract
            }
        }
    }

    void flushSend(Client& c) {
        if (c.dead)
            return;
        while (c.sendOff < c.sendBuf.size()) {
            const size_t chunk =
                std::min<size_t>(c.sendBuf.size() - c.sendOff, 256 * 1024);
            const int n = ::send(c.sock, c.sendBuf.data() + c.sendOff,
                                 static_cast<int>(chunk), 0);
            if (n == SOCKET_ERROR) {
                if (::WSAGetLastError() == WSAEWOULDBLOCK)
                    break;
                c.dead = true;
                return;
            }
            if (n <= 0)
                break;
            c.sendOff += static_cast<size_t>(n);
        }
        if (c.sendOff >= c.sendBuf.size()) {
            c.sendBuf.clear();
            c.sendOff = 0;
            if (c.closeAfterFlush)
                c.dead = true; // fully flushed: close now
        } else if (c.sendOff > (4u << 20)) {
            c.sendBuf.erase(0, c.sendOff); // compact occasionally
            c.sendOff = 0;
        }
    }

    void sweepDead() {
        for (auto it = clients.begin(); it != clients.end();) {
            Client& c = *it->second;
            if (!c.dead) {
                ++it;
                continue;
            }
            if (c.upload.active)
                cleanupUpload(c);
            if (c.state == Client::State::Ws) {
                wsClients.fetch_sub(1, std::memory_order_relaxed);
                Log::info("[server] ws client #%llu disconnected",
                          static_cast<unsigned long long>(c.id));
            }
            ::closesocket(c.sock);
            it = clients.erase(it);
        }
    }
};

// ---------------------------------------------------------------------------

HttpWsServer::HttpWsServer() : impl_(std::make_unique<Impl>()) {}

HttpWsServer::~HttpWsServer() {
    stop();
}

bool HttpWsServer::start(int port, const std::string& uiRoot, std::string& err) {
    return impl_->startImpl(port, uiRoot, err);
}

void HttpWsServer::stop() {
    impl_->stopImpl();
}

void HttpWsServer::setMessageHandler(MessageHandler handler) {
    std::lock_guard<std::mutex> lock(impl_->handlersMu);
    impl_->messageHandler = std::move(handler);
}

void HttpWsServer::setPeaksProvider(PeaksProvider provider) {
    std::lock_guard<std::mutex> lock(impl_->handlersMu);
    impl_->peaksProvider = std::move(provider);
}

void HttpWsServer::setMcpHandler(McpHandler handler) {
    std::lock_guard<std::mutex> lock(impl_->handlersMu);
    impl_->mcpHandler = std::move(handler);
}

void HttpWsServer::setUploadHandler(UploadHandler handler) {
    std::lock_guard<std::mutex> lock(impl_->handlersMu);
    impl_->uploadHandler = std::move(handler);
}

void HttpWsServer::broadcast(const json& event) {
    const auto ob = impl_->outboxRef();
    if (ob)
        ob->push(0, dumpJson(event)); // no-op when stopped
}

int HttpWsServer::wsClientCount() const {
    return impl_->wsClients.load(std::memory_order_relaxed);
}

} // namespace mydaw
