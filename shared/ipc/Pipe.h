#pragma once
//
// shared/ipc/Pipe.h
//
// Named-pipe control channel between engine and plugin host processes
// (SPEC §8.2): blocking, length-prefixed (uint32 LE) JSON string messages
// with real timeouts (overlapped IO + event waits), plus a small JsonRpc
// request/reply + push layer.
//
// Threading model:
//   * sendMessage() is thread-safe (internal mutex serializes writers).
//   * recvMessage() must be called from a single reader thread.
//   * cancelIo() may be called from any thread to permanently unblock all
//     pending and future waits (used for shutdown); afterwards operations
//     return PipeResult::Closed.
//   * close() must only be called once no thread is inside send/recv.
//
// Framing caveat: a Timeout from recvMessage() is only retry-safe when no
// bytes of the next frame were consumed (the implementation guarantees this
// distinction: a mid-frame timeout is reported as Error because the stream
// is desynchronized and the connection must be dropped). A Timeout from
// sendMessage() after a partial write similarly poisons the stream; treat
// send timeouts as fatal.
//
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#include <nlohmann/json.hpp> // vendored: third_party/nlohmann/json.hpp

namespace mydaw {

enum class PipeResult { Ok, Timeout, Closed, Error };

class Pipe {
public:
  static constexpr uint32_t kInfinite = 0xFFFFFFFFu;
  static constexpr uint32_t kMaxMessageBytes = 64u * 1024u * 1024u;

  Pipe();
  ~Pipe();
  Pipe(const Pipe&) = delete;
  Pipe& operator=(const Pipe&) = delete;

  // Server (engine): create the single-instance duplex pipe, then wait for
  // the spawned host to connect. pipeName is the full "\\.\pipe\..." path
  // (see ipcPipeName() in PluginIpc.h).
  bool createServer(const std::string& pipeName);
  PipeResult waitForClient(uint32_t timeoutMs);

  // Client (host): connect, retrying while the pipe does not exist yet or
  // is busy, until timeoutMs elapses.
  bool connect(const std::string& pipeName, uint32_t timeoutMs);

  // Send one length-prefixed message (4-byte little-endian byte count, then
  // the UTF-8 JSON payload). Thread-safe.
  PipeResult sendMessage(const std::string& msg, uint32_t timeoutMs = 10000);

  // Receive one message. Single reader thread only. timeoutMs may be
  // kInfinite; see the framing caveat above for Timeout semantics.
  PipeResult recvMessage(std::string& out, uint32_t timeoutMs);

  // Permanently unblock all waits (sticky until the next createServer/
  // connect). Safe from any thread.
  void cancelIo();
  void close();

  bool valid() const { return pipe_ != nullptr; }
  bool isServer() const { return server_; }
  std::string errorString() const;

private:
  bool createEvents();
  void setError(const char* where, uint32_t errorCode);
  void setErrorMsg(const std::string& msg);
  // readAll/writeAll loop overlapped IO with deadline; `progressed` (read
  // path) reports whether any byte was consumed before a timeout.
  PipeResult readAll(uint8_t* buf, uint32_t size, uint64_t deadlineTick,
                     bool infinite, bool* progressed);
  PipeResult writeAll(const uint8_t* buf, uint32_t size, uint32_t timeoutMs);

  void* pipe_ = nullptr;         // HANDLE
  void* readEvent_ = nullptr;    // manual-reset, owned by the reader
  void* writeEvent_ = nullptr;   // manual-reset, owned by sendMutex_ holder
  void* connectEvent_ = nullptr; // manual-reset, ConnectNamedPipe
  void* stopEvent_ = nullptr;    // manual-reset, set by cancelIo()
  bool server_ = false;
  std::mutex sendMutex_;
  mutable std::mutex errMutex_;
  std::string error_;
};

// JsonRpc — request/reply + push messaging over a Pipe. Wire format
// (SPEC §8.2, mirrors the WS protocol envelope):
//   request : {"id": N, "type": "<name>", "payload": {...}}
//   reply   : {"replyTo": N, "ok": true,  "payload": {...}}
//           | {"replyTo": N, "ok": false, "error": {"code": "...", "message": "..."}}
//   push    : {"type": "<name>", "payload": {...}}          (no id, no reply)
//
// Usage: construct over a connected Pipe, start one dedicated thread running
// runReaderLoop(), then call request()/push()/replyOk()/replyError() from any
// other thread. The handler runs on the reader thread and receives both
// pushes (requestId < 0) and incoming requests (requestId >= 0 — answer with
// replyOk/replyError). Never call request() from inside the handler: the
// reader thread that would deliver the reply is the one blocked.
// Used by engine-side HostProcess and by the plugin-host main loop.
class JsonRpc {
public:
  using Handler = std::function<void(const std::string& type,
                                     const nlohmann::json& payload,
                                     int64_t requestId)>;

  explicit JsonRpc(Pipe& pipe); // pipe must outlive this object
  ~JsonRpc();                   // calls stop()
  JsonRpc(const JsonRpc&) = delete;
  JsonRpc& operator=(const JsonRpc&) = delete;

  void setHandler(Handler handler);

  // Send a request and block for its reply. Returns true if a reply arrived
  // (transport success — inspect reply["ok"] for the logical result); false
  // on send failure, timeout, stop(), or pipe closure, with `reply` set to a
  // synthesized {"ok":false,"error":{...}} describing the failure (codes:
  // "send_failed", "timeout", "pipe_closed").
  bool request(const std::string& type, const nlohmann::json& payload,
               nlohmann::json& reply, uint32_t timeoutMs = 10000);

  // Answer an incoming request received via the handler.
  bool replyOk(int64_t requestId, const nlohmann::json& payload);
  bool replyError(int64_t requestId, const std::string& code,
                  const std::string& message);

  // Fire-and-forget notification (no reply expected).
  bool push(const std::string& type, const nlohmann::json& payload);

  // Blocking read/dispatch loop; run from a dedicated thread. Returns when
  // the pipe closes/fails or stop() is called; on exit all in-flight
  // request() calls fail with code "pipe_closed".
  void runReaderLoop();

  // Unblocks the reader loop and fails all pending requests. Idempotent,
  // safe from any thread.
  void stop();

  bool running() const { return running_.load(std::memory_order_acquire); }

private:
  struct Pending {
    nlohmann::json reply;
    bool done = false;
    // True when `reply` was synthesized locally (stop() / reader-loop exit)
    // rather than received from the peer — request() then returns false.
    bool synthesized = false;
  };

  bool sendJson(const nlohmann::json& msg);
  void failAllPendingLocked(const char* code, const char* message);

  Pipe& pipe_;
  std::mutex handlerMutex_;
  Handler handler_;
  std::mutex pendingMutex_;
  std::condition_variable cv_;
  std::unordered_map<int64_t, std::shared_ptr<Pending>> pending_;
  bool stopped_ = false; // guarded by pendingMutex_
  std::atomic<int64_t> nextId_{1};
  std::atomic<bool> running_{false};
};

} // namespace mydaw
