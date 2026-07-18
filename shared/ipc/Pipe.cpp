//
// shared/ipc/Pipe.cpp — see Pipe.h.
//
#include "Pipe.h"

#include "SharedMem.h" // ipcUtf8ToWide, win32ErrorString

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <vector>

namespace mydaw {

namespace {

constexpr DWORD kPipeBufferBytes = 256 * 1024;

DWORD remainingMs(uint64_t deadlineTick) {
  const uint64_t now = GetTickCount64();
  return (now >= deadlineTick) ? 0 : static_cast<DWORD>(deadlineTick - now);
}

// Serialize without throwing (invalid UTF-8 is replaced, never fatal).
std::string dumpJson(const nlohmann::json& j) {
  return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
}

} // namespace

// ===========================================================================
// Pipe
// ===========================================================================
Pipe::Pipe() {
  // The stop event exists for the whole object lifetime so cancelIo() works
  // even before/independently of a connection. Manual-reset → sticky.
  stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
}

Pipe::~Pipe() {
  close();
  if (stopEvent_) {
    CloseHandle(static_cast<HANDLE>(stopEvent_));
    stopEvent_ = nullptr;
  }
}

void Pipe::setError(const char* where, uint32_t errorCode) {
  setErrorMsg(std::string(where) + ": " + win32ErrorString(errorCode));
}

void Pipe::setErrorMsg(const std::string& msg) {
  std::lock_guard<std::mutex> lk(errMutex_);
  error_ = msg;
}

std::string Pipe::errorString() const {
  std::lock_guard<std::mutex> lk(errMutex_);
  return error_;
}

bool Pipe::createEvents() {
  readEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  writeEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  connectEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!readEvent_ || !writeEvent_ || !connectEvent_) {
    setError("CreateEventW", GetLastError());
    close();
    return false;
  }
  ResetEvent(static_cast<HANDLE>(stopEvent_)); // fresh connection, un-cancel
  return true;
}

bool Pipe::createServer(const std::string& pipeName) {
  close();
  const std::wstring wname = ipcUtf8ToWide(pipeName);
  HANDLE h = CreateNamedPipeW(
      wname.c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1, kPipeBufferBytes, kPipeBufferBytes, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    setError("CreateNamedPipeW", GetLastError());
    return false;
  }
  pipe_ = h;
  server_ = true;
  return createEvents();
}

PipeResult Pipe::waitForClient(uint32_t timeoutMs) {
  if (!pipe_ || !server_) {
    setErrorMsg("waitForClient: not a server pipe");
    return PipeResult::Error;
  }
  HANDLE h = static_cast<HANDLE>(pipe_);
  OVERLAPPED ov{};
  ov.hEvent = static_cast<HANDLE>(connectEvent_);
  ResetEvent(ov.hEvent);
  if (!ConnectNamedPipe(h, &ov)) {
    const DWORD err = GetLastError();
    if (err == ERROR_PIPE_CONNECTED) return PipeResult::Ok;
    if (err != ERROR_IO_PENDING) {
      setError("ConnectNamedPipe", err);
      return PipeResult::Error;
    }
  }
  HANDLE waits[2] = {ov.hEvent, static_cast<HANDLE>(stopEvent_)};
  const DWORD t = (timeoutMs == kInfinite) ? INFINITE : timeoutMs;
  const DWORD w = WaitForMultipleObjects(2, waits, FALSE, t);
  if (w == WAIT_OBJECT_0) {
    DWORD n = 0;
    if (GetOverlappedResult(h, &ov, &n, FALSE)) return PipeResult::Ok;
    const DWORD err = GetLastError();
    if (err == ERROR_PIPE_CONNECTED) return PipeResult::Ok;
    setError("ConnectNamedPipe(result)", err);
    return PipeResult::Error;
  }
  // stop or timeout: cancel and reap so OVERLAPPED can leave scope safely
  CancelIoEx(h, &ov);
  DWORD n = 0;
  if (GetOverlappedResult(h, &ov, &n, TRUE)) return PipeResult::Ok; // raced in
  if (w == WAIT_OBJECT_0 + 1) return PipeResult::Closed;
  if (w == WAIT_TIMEOUT) {
    setErrorMsg("waitForClient: timeout");
    return PipeResult::Timeout;
  }
  setError("WaitForMultipleObjects", GetLastError());
  return PipeResult::Error;
}

bool Pipe::connect(const std::string& pipeName, uint32_t timeoutMs) {
  close();
  const std::wstring wname = ipcUtf8ToWide(pipeName);
  const uint64_t deadline =
      GetTickCount64() + ((timeoutMs == kInfinite) ? 0 : timeoutMs);
  const bool infinite = (timeoutMs == kInfinite);
  for (;;) {
    HANDLE h = CreateFileW(wname.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                           nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED,
                           nullptr);
    if (h != INVALID_HANDLE_VALUE) {
      pipe_ = h;
      server_ = false;
      return createEvents();
    }
    const DWORD err = GetLastError();
    if (err == ERROR_PIPE_BUSY) {
      const DWORD remain = infinite ? NMPWAIT_WAIT_FOREVER
                                    : remainingMs(deadline);
      if (!infinite && remain == 0) {
        setErrorMsg("connect: timeout (pipe busy)");
        return false;
      }
      if (!WaitNamedPipeW(wname.c_str(), remain == 0 ? 1 : remain)) {
        // busy instance went away or wait timed out; loop and re-check
      }
    } else if (err != ERROR_FILE_NOT_FOUND && err != ERROR_PATH_NOT_FOUND) {
      setError("CreateFileW(pipe)", err);
      return false;
    } else {
      Sleep(15); // server has not created the pipe yet
    }
    if (!infinite && GetTickCount64() >= deadline) {
      setErrorMsg("connect: timeout waiting for pipe \"" + pipeName + "\"");
      return false;
    }
    if (WaitForSingleObject(static_cast<HANDLE>(stopEvent_), 0) ==
        WAIT_OBJECT_0) {
      setErrorMsg("connect: canceled");
      return false;
    }
  }
}

void Pipe::cancelIo() {
  if (stopEvent_) SetEvent(static_cast<HANDLE>(stopEvent_));
}

void Pipe::close() {
  if (pipe_) {
    HANDLE h = static_cast<HANDLE>(pipe_);
    CancelIoEx(h, nullptr);
    if (server_) DisconnectNamedPipe(h);
    CloseHandle(h);
    pipe_ = nullptr;
  }
  for (void** ev : {&readEvent_, &writeEvent_, &connectEvent_}) {
    if (*ev) {
      CloseHandle(static_cast<HANDLE>(*ev));
      *ev = nullptr;
    }
  }
  server_ = false;
}

PipeResult Pipe::readAll(uint8_t* buf, uint32_t size, uint64_t deadlineTick,
                         bool infinite, bool* progressed) {
  HANDLE h = static_cast<HANDLE>(pipe_);
  HANDLE ev = static_cast<HANDLE>(readEvent_);
  uint32_t done = 0;
  while (done < size) {
    OVERLAPPED ov{};
    ov.hEvent = ev;
    ResetEvent(ev);
    if (!ReadFile(h, buf + done, size - done, nullptr, &ov)) {
      const DWORD err = GetLastError();
      if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED ||
          err == ERROR_INVALID_HANDLE || err == ERROR_HANDLE_EOF)
        return PipeResult::Closed;
      if (err != ERROR_IO_PENDING) {
        setError("ReadFile", err);
        return PipeResult::Error;
      }
    }
    HANDLE waits[2] = {ev, static_cast<HANDLE>(stopEvent_)};
    const DWORD t = infinite ? INFINITE : remainingMs(deadlineTick);
    const DWORD w = WaitForMultipleObjects(2, waits, FALSE, t);
    DWORD n = 0;
    if (w == WAIT_OBJECT_0) {
      if (!GetOverlappedResult(h, &ov, &n, FALSE)) {
        const DWORD err = GetLastError();
        if (err == ERROR_IO_INCOMPLETE) continue; // spurious; keep waiting
        if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED ||
            err == ERROR_HANDLE_EOF)
          return PipeResult::Closed;
        setError("ReadFile(result)", err);
        return PipeResult::Error;
      }
      done += n;
      if (progressed && done > 0) *progressed = true;
      continue;
    }
    // stop requested or timed out: cancel and reap before OVERLAPPED dies
    CancelIoEx(h, &ov);
    if (GetOverlappedResult(h, &ov, &n, TRUE)) {
      done += n;
      if (progressed && done > 0) *progressed = true;
      if (done >= size) return PipeResult::Ok; // completed despite cancel
    } else if (GetLastError() == ERROR_BROKEN_PIPE) {
      return PipeResult::Closed;
    }
    if (w == WAIT_OBJECT_0 + 1) return PipeResult::Closed; // canceled
    if (w == WAIT_TIMEOUT) return PipeResult::Timeout;
    setError("WaitForMultipleObjects", GetLastError());
    return PipeResult::Error;
  }
  return PipeResult::Ok;
}

PipeResult Pipe::writeAll(const uint8_t* buf, uint32_t size,
                          uint32_t timeoutMs) {
  HANDLE h = static_cast<HANDLE>(pipe_);
  HANDLE ev = static_cast<HANDLE>(writeEvent_);
  const bool infinite = (timeoutMs == kInfinite);
  const uint64_t deadline =
      GetTickCount64() + (infinite ? 0 : timeoutMs);
  uint32_t done = 0;
  while (done < size) {
    OVERLAPPED ov{};
    ov.hEvent = ev;
    ResetEvent(ev);
    if (!WriteFile(h, buf + done, size - done, nullptr, &ov)) {
      const DWORD err = GetLastError();
      if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED ||
          err == ERROR_NO_DATA || err == ERROR_INVALID_HANDLE)
        return PipeResult::Closed;
      if (err != ERROR_IO_PENDING) {
        setError("WriteFile", err);
        return PipeResult::Error;
      }
    }
    HANDLE waits[2] = {ev, static_cast<HANDLE>(stopEvent_)};
    const DWORD t = infinite ? INFINITE : remainingMs(deadline);
    const DWORD w = WaitForMultipleObjects(2, waits, FALSE, t);
    DWORD n = 0;
    if (w == WAIT_OBJECT_0) {
      if (!GetOverlappedResult(h, &ov, &n, FALSE)) {
        const DWORD err = GetLastError();
        if (err == ERROR_IO_INCOMPLETE) continue;
        if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED ||
            err == ERROR_NO_DATA)
          return PipeResult::Closed;
        setError("WriteFile(result)", err);
        return PipeResult::Error;
      }
      done += n;
      continue;
    }
    CancelIoEx(h, &ov);
    if (GetOverlappedResult(h, &ov, &n, TRUE)) {
      done += n;
      if (done >= size) return PipeResult::Ok;
    } else if (GetLastError() == ERROR_BROKEN_PIPE) {
      return PipeResult::Closed;
    }
    if (w == WAIT_OBJECT_0 + 1) return PipeResult::Closed;
    if (w == WAIT_TIMEOUT) {
      setErrorMsg(done ? "sendMessage: timeout mid-frame (stream poisoned)"
                       : "sendMessage: timeout");
      return PipeResult::Timeout;
    }
    setError("WaitForMultipleObjects", GetLastError());
    return PipeResult::Error;
  }
  return PipeResult::Ok;
}

PipeResult Pipe::sendMessage(const std::string& msg, uint32_t timeoutMs) {
  if (!valid()) {
    setErrorMsg("sendMessage: pipe not connected");
    return PipeResult::Error;
  }
  if (msg.size() > kMaxMessageBytes) {
    setErrorMsg("sendMessage: message exceeds kMaxMessageBytes");
    return PipeResult::Error;
  }
  const uint32_t len = static_cast<uint32_t>(msg.size());
  std::vector<uint8_t> frame(4 + msg.size());
  frame[0] = static_cast<uint8_t>(len & 0xFF);
  frame[1] = static_cast<uint8_t>((len >> 8) & 0xFF);
  frame[2] = static_cast<uint8_t>((len >> 16) & 0xFF);
  frame[3] = static_cast<uint8_t>((len >> 24) & 0xFF);
  if (len) std::memcpy(frame.data() + 4, msg.data(), msg.size());
  std::lock_guard<std::mutex> lk(sendMutex_);
  return writeAll(frame.data(), static_cast<uint32_t>(frame.size()),
                  timeoutMs);
}

PipeResult Pipe::recvMessage(std::string& out, uint32_t timeoutMs) {
  out.clear();
  if (!valid()) {
    setErrorMsg("recvMessage: pipe not connected");
    return PipeResult::Error;
  }
  const bool infinite = (timeoutMs == kInfinite);
  const uint64_t deadline = GetTickCount64() + (infinite ? 0 : timeoutMs);

  uint8_t hdr[4];
  bool progressed = false;
  PipeResult r = readAll(hdr, 4, deadline, infinite, &progressed);
  if (r == PipeResult::Timeout && progressed) {
    setErrorMsg("recvMessage: timeout mid-frame (stream desynchronized)");
    return PipeResult::Error;
  }
  if (r != PipeResult::Ok) return r; // Timeout here is retry-safe

  const uint32_t len = static_cast<uint32_t>(hdr[0]) |
                       (static_cast<uint32_t>(hdr[1]) << 8) |
                       (static_cast<uint32_t>(hdr[2]) << 16) |
                       (static_cast<uint32_t>(hdr[3]) << 24);
  if (len > kMaxMessageBytes) {
    setErrorMsg("recvMessage: oversized frame (" + std::to_string(len) +
                " bytes)");
    return PipeResult::Error;
  }
  if (len == 0) return PipeResult::Ok;

  out.resize(len);
  r = readAll(reinterpret_cast<uint8_t*>(out.data()), len, deadline, infinite,
              nullptr);
  if (r == PipeResult::Timeout) {
    out.clear();
    setErrorMsg("recvMessage: timeout mid-frame (stream desynchronized)");
    return PipeResult::Error;
  }
  if (r != PipeResult::Ok) out.clear();
  return r;
}

// ===========================================================================
// JsonRpc
// ===========================================================================
JsonRpc::JsonRpc(Pipe& pipe) : pipe_(pipe) {}

JsonRpc::~JsonRpc() { stop(); }

void JsonRpc::setHandler(Handler handler) {
  std::lock_guard<std::mutex> lk(handlerMutex_);
  handler_ = std::move(handler);
}

bool JsonRpc::sendJson(const nlohmann::json& msg) {
  return pipe_.sendMessage(dumpJson(msg)) == PipeResult::Ok;
}

void JsonRpc::failAllPendingLocked(const char* code, const char* message) {
  for (auto& [id, p] : pending_) {
    if (!p->done) {
      p->reply = nlohmann::json{
          {"ok", false},
          {"error", {{"code", code}, {"message", message}}}};
      p->done = true;
      p->synthesized = true; // request() must report transport failure (false)
    }
  }
}

bool JsonRpc::request(const std::string& type, const nlohmann::json& payload,
                      nlohmann::json& reply, uint32_t timeoutMs) {
  const int64_t id = nextId_.fetch_add(1, std::memory_order_relaxed);
  auto pending = std::make_shared<Pending>();
  {
    std::lock_guard<std::mutex> lk(pendingMutex_);
    if (stopped_) {
      reply = nlohmann::json{
          {"ok", false},
          {"error",
           {{"code", "pipe_closed"}, {"message", "rpc is stopped"}}}};
      return false;
    }
    pending_[id] = pending;
  }

  const nlohmann::json msg{{"id", id}, {"type", type}, {"payload", payload}};
  if (pipe_.sendMessage(dumpJson(msg)) != PipeResult::Ok) {
    std::lock_guard<std::mutex> lk(pendingMutex_);
    pending_.erase(id);
    reply = nlohmann::json{
        {"ok", false},
        {"error",
         {{"code", "send_failed"}, {"message", pipe_.errorString()}}}};
    return false;
  }

  std::unique_lock<std::mutex> lk(pendingMutex_);
  cv_.wait_for(lk, std::chrono::milliseconds(timeoutMs),
               [&] { return pending->done || stopped_; });
  pending_.erase(id);
  if (!pending->done) {
    reply = nlohmann::json{
        {"ok", false},
        {"error",
         {{"code", stopped_ ? "pipe_closed" : "timeout"},
          {"message", "no reply to \"" + type + "\" within " +
                          std::to_string(timeoutMs) + " ms"}}}};
    return false;
  }
  reply = std::move(pending->reply);
  // A reply synthesized by stop()/reader-loop exit is a transport failure per
  // the contract in Pipe.h ("false on ... stop()"), not a peer reply.
  return !pending->synthesized;
}

bool JsonRpc::replyOk(int64_t requestId, const nlohmann::json& payload) {
  return sendJson(nlohmann::json{
      {"replyTo", requestId}, {"ok", true}, {"payload", payload}});
}

bool JsonRpc::replyError(int64_t requestId, const std::string& code,
                         const std::string& message) {
  return sendJson(nlohmann::json{
      {"replyTo", requestId},
      {"ok", false},
      {"error", {{"code", code}, {"message", message}}}});
}

bool JsonRpc::push(const std::string& type, const nlohmann::json& payload) {
  return sendJson(nlohmann::json{{"type", type}, {"payload", payload}});
}

void JsonRpc::runReaderLoop() {
  running_.store(true, std::memory_order_release);
  std::string raw;
  for (;;) {
    {
      std::lock_guard<std::mutex> lk(pendingMutex_);
      if (stopped_) break;
    }
    const PipeResult r = pipe_.recvMessage(raw, Pipe::kInfinite);
    if (r != PipeResult::Ok) break;

    nlohmann::json msg = nlohmann::json::parse(raw, nullptr, false);
    if (msg.is_discarded() || !msg.is_object()) {
      std::fprintf(stderr, "[JsonRpc] dropping unparsable pipe message (%zu bytes)\n",
                   raw.size());
      continue;
    }

    if (msg.contains("replyTo")) {
      const int64_t id = msg["replyTo"].is_number_integer()
                             ? msg["replyTo"].get<int64_t>()
                             : -1;
      std::lock_guard<std::mutex> lk(pendingMutex_);
      auto it = pending_.find(id);
      if (it != pending_.end()) {
        it->second->reply = std::move(msg);
        it->second->done = true;
        cv_.notify_all();
      }
      continue;
    }

    const std::string type = msg.value("type", std::string());
    const nlohmann::json payload =
        msg.contains("payload") ? msg["payload"] : nlohmann::json::object();
    const int64_t id =
        (msg.contains("id") && msg["id"].is_number_integer())
            ? msg["id"].get<int64_t>()
            : -1;
    Handler handler;
    {
      std::lock_guard<std::mutex> lk(handlerMutex_);
      handler = handler_;
    }
    if (handler) handler(type, payload, id);
  }
  {
    std::lock_guard<std::mutex> lk(pendingMutex_);
    failAllPendingLocked("pipe_closed", "connection lost");
  }
  cv_.notify_all();
  running_.store(false, std::memory_order_release);
}

void JsonRpc::stop() {
  {
    std::lock_guard<std::mutex> lk(pendingMutex_);
    stopped_ = true;
    failAllPendingLocked("pipe_closed", "rpc stopped");
  }
  cv_.notify_all();
  pipe_.cancelIo();
}

} // namespace mydaw
