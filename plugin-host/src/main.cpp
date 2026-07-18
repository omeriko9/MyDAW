//
// plugin-host/src/main.cpp — mydaw-host{64,32}.exe entry point (H1, SPEC §8).
//
// Two modes:
//
//   --scan <path> [--format vst2|vst3]
//       Scan.cpp: enumerate the plugins in the file, print one JSON result
//       line to stdout, exit 0/1. No window, no shm, no pipe (SPEC §8.3).
//
//   --serve --shm <name> --pipe <name> --plugin <path> --format vst2|vst3
//           [--uid <uid>] [--parent-pid <pid>]
//       Host ONE plugin instance (SPEC §8.1/§8.2). Threads:
//         * main thread     — creates/loads the adapter, runs the Win32
//           message pump (EditorWindow + a 20 ms thread timer for VST2
//           effIdle pumping while no editor window is open; EditorWindow's
//           own timer covers editorIdle/resizePending while open) and
//           executes control-pipe ops marshaled from the JsonRpc reader
//           thread via PostThreadMessage + blocking handoff,
//         * ShmServer audio thread — WaitForSingleObject(req, 500 ms) →
//           ProcessBlock from shm → adapter->process() under an SEH guard
//           (crash → shm state Crashed, log push, _exit(3); ShmServer.cpp),
//         * notifier thread — drains the ParamEditBuffer into `paramEdited`
//           pushes (throttled ~30 Hz per param) and watches plugin latency
//           for `latencyChanged` pushes,
//         * parent watcher  — _exit(2) the moment the engine process dies.
//
//       NOTE(spec): §8.2 lists a host-side latencyChanged push but only
//       Vst2Host exposes a host callback for it (HostCallbacks, from
//       audioMasterIoChanged). Vst3Host has no callback registration — its
//       latency lands in ShmHeader::latencySamples on every processed block
//       (PluginAdapter::ProcessBlock::latencySamples), so the notifier
//       thread polls the header once at least one block went through the
//       adapter and pushes on change. Both formats converge on the header
//       value; the VST2 callback only makes the push prompter while the
//       engine is not streaming blocks.
//
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>

#include <atomic>
#include <cctype>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

#include "../../shared/ipc/Pipe.h"
#include "../../shared/ipc/PluginIpc.h"
#include "../../shared/ipc/SharedMem.h"
#include "Base64.h"
#include "EditorWindow.h"
#include "PluginAdapter.h"
#include "RegOverlay.h" // optional per-plugin registry overlay (SPEC §8.5)
#include "Scan.h"
#include "ShmServer.h"
#include "Vst2Host.h" // HostCallbacks wiring (paramEdited/latencyChanged)

namespace {

using nlohmann::json;

constexpr UINT kMsgControl = WM_APP + 1;    // control op queued (wake the pump)
constexpr UINT kMsgPipeClosed = WM_APP + 2; // JsonRpc reader loop exited
constexpr UINT kIdleTimerMs = 20;           // ~50 Hz idle pump (SPEC §8.4)

// ---------------------------------------------------------------------------
// Control-op marshaling: JsonRpc reader thread → main thread.
//
// The op lives on the reader thread's stack; the reader blocks on `cv` until
// the main thread handled it (adapter calls must happen on the main thread,
// and replying from the main thread is fine — only request() is banned on
// the reader path). A queue (not the LPARAM) carries the pointer so shutdown
// can fail every queued op without racing PostThreadMessage delivery.
// ---------------------------------------------------------------------------
struct ControlOp {
  const std::string* type = nullptr;
  const json* payload = nullptr;
  int64_t requestId = -1;
  std::mutex m;
  std::condition_variable cv;
  bool done = false;
};

struct ControlQueue {
  std::mutex m;
  std::deque<ControlOp*> ops;
  bool shuttingDown = false;
};

void signalOp(ControlOp* op) {
  {
    std::lock_guard<std::mutex> lk(op->m);
    op->done = true;
  }
  op->cv.notify_one();
}

// ---------------------------------------------------------------------------
// Serve-mode state. Declaration order doubles as destruction order (reverse):
// editor → shm → adapter → rpc → pipe, so the editor and audio thread are
// gone before the adapter, and the rpc before its pipe.
// ---------------------------------------------------------------------------
struct ServeState {
  mydaw::Pipe pipe;
  std::unique_ptr<mydaw::JsonRpc> rpc;
  std::unique_ptr<mydaw::PluginAdapter> adapter;
  mydaw::Vst2Host* vst2 = nullptr; // adapter downcast, vst2 only
  mydaw::ShmServer shm;
  mydaw::EditorWindow editor;

  std::string loadError;       // why `adapter` is unusable (init replies)
  mydaw::InitInfo info;        // valid once inited
  std::atomic<bool> inited{false};
  std::atomic<bool> quitting{false};

  // Latency sources for the notifier thread (see NOTE(spec) in the header
  // comment): vst2 audioMasterIoChanged callback + shm header poll.
  std::atomic<uint32_t> cbLatency{0};
  std::atomic<bool> cbLatencySeen{false};
  std::atomic<uint32_t> lastLatency{0};

  DWORD mainThreadId = 0;
};

void enablePerMonitorV2Dpi() {
  // SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
  // resolved dynamically so old SDK headers / Windows versions are harmless.
  using Fn = BOOL(WINAPI*)(HANDLE);
  if (HMODULE u32 = GetModuleHandleW(L"user32.dll")) {
    if (auto fn = reinterpret_cast<Fn>(
            GetProcAddress(u32, "SetProcessDpiAwarenessContext"))) {
      fn(reinterpret_cast<HANDLE>(static_cast<INT_PTR>(-4))); // PER_MONITOR_AWARE_V2
    }
  }
}

// Wait (bounded) for an in-flight process() call to leave the plugin before
// a main-thread suspend touches it (the audio thread gate was just closed).
void waitBlockDrained(ServeState& s) {
  mydaw::ShmHeader* h = s.shm.header();
  if (!h) return;
  for (int i = 0; i < 100 && mydaw::shmLoadState(h) == mydaw::HostState::Processing; ++i)
    Sleep(1);
}

// ---------------------------------------------------------------------------
// Control op execution (main thread). Pipe messages per SPEC §8.2; payload
// shapes matched against the engine peer (HostProcess.cpp): init reply
// {info:{...,latency,...}}, getParams {params:[...]}, getState {chunkB64},
// getPresets {presets:[...]}. `quit` arrives as a push (requestId < 0).
// ---------------------------------------------------------------------------
void handleControlOp(ServeState& s, const std::string& type,
                     const json& rawPayload, int64_t requestId) {
  const json payload = rawPayload.is_object() ? rawPayload : json::object();
  auto ok = [&](const json& p) {
    if (requestId >= 0) s.rpc->replyOk(requestId, p);
  };
  auto fail = [&](const char* code, const std::string& msg) {
    if (requestId >= 0) s.rpc->replyError(requestId, code, msg);
  };

  try {
    if (type == "quit") {
      ok(json::object());
      if (!s.quitting.exchange(true)) PostQuitMessage(0);
      return;
    }

    if (type == "init") {
      if (!s.adapter) {
        fail("load_failed", s.loadError.empty() ? "plugin failed to load"
                                                : s.loadError);
        return;
      }
      if (!s.inited.load(std::memory_order_acquire)) {
        double sampleRate = payload.value("sampleRate", 0.0);
        uint32_t maxBlock = payload.value("maxBlock", mydaw::kMaxBlock);
        const mydaw::ShmHeader* h = s.shm.header();
        if (sampleRate <= 0.0 && h) sampleRate = double(h->sampleRate);
        if (sampleRate <= 0.0) sampleRate = 44100.0;
        if (maxBlock == 0 || maxBlock > mydaw::kMaxBlock) maxBlock = mydaw::kMaxBlock;

        mydaw::InitInfo info;
        if (!s.adapter->init(sampleRate, maxBlock, h, info)) {
          fail("init_failed", s.adapter->lastError().empty()
                                  ? "plugin init failed"
                                  : s.adapter->lastError());
          return;
        }
        s.info = info;
        s.lastLatency.store(info.latencySamples, std::memory_order_relaxed);
        s.inited.store(true, std::memory_order_release);
        s.shm.setAdapter(s.adapter.get()); // audio thread starts routing blocks
      }
      const mydaw::RegOverlayStatus overlay = mydaw::regOverlayStatus();
      ok(json{{"info", json{{"name", s.info.name},
                            {"vendor", s.info.vendor},
                            {"numParams", s.info.numParams},
                            {"latency", s.info.latencySamples},
                            {"isInstrument", s.info.isInstrument},
                            {"ins", s.info.numIns},
                            {"outs", s.info.numOuts},
                            {"hasEditor", s.info.hasEditor},
                            {"captureOverlay", json{{"armed", overlay.armed},
                                                     {"registry", overlay.registryActive},
                                                     {"files", overlay.fileActive},
                                                     {"registryPath", mydaw::ipcWideToUtf8(overlay.registryPath)},
                                                     {"mirrorPath", mydaw::ipcWideToUtf8(overlay.mirrorPath)}}}}}});
      return;
    }

    if (!s.adapter || !s.inited.load(std::memory_order_acquire)) {
      fail("not_initialized", s.loadError.empty() ? "plugin is not initialized"
                                                  : s.loadError);
      return;
    }

    if (type == "getParams") {
      json arr = json::array();
      for (const mydaw::ParamInfo& p : s.adapter->getParams()) {
        arr.push_back({{"id", p.id},
                       {"name", p.name},
                       {"label", p.label},
                       {"defaultValue", p.defaultValue},
                       {"steps", p.steps},
                       {"value", p.value},
                       {"valueText", p.valueText}});
      }
      ok(json{{"params", std::move(arr)}});
      return;
    }
    if (type == "setParam") {
      s.adapter->setParam(payload.value("id", 0u), payload.value("value", 0.0));
      ok(json::object());
      return;
    }
    if (type == "getState") {
      std::vector<uint8_t> chunk;
      if (!s.adapter->getState(chunk)) {
        fail("get_state_failed", s.adapter->lastError().empty()
                                     ? "plugin returned no state"
                                     : s.adapter->lastError());
        return;
      }
      ok(json{{"chunkB64", mydaw::base64Encode(chunk)}});
      return;
    }
    if (type == "setState") {
      std::vector<uint8_t> chunk;
      if (!mydaw::base64Decode(payload.value("chunkB64", ""), chunk)) {
        fail("bad_request", "chunkB64 is not valid base64");
        return;
      }
      if (!s.adapter->setState(chunk)) {
        fail("set_state_failed", s.adapter->lastError().empty()
                                     ? "plugin rejected the state chunk"
                                     : s.adapter->lastError());
        return;
      }
      ok(json::object());
      return;
    }
    if (type == "getPresets") {
      json arr = json::array();
      for (const mydaw::PresetInfo& p : s.adapter->getPresets())
        arr.push_back({{"id", p.id}, {"name", p.name}});
      ok(json{{"presets", std::move(arr)}});
      return;
    }
    if (type == "loadPreset") {
      if (!s.adapter->loadPreset(payload.value("id", 0))) {
        fail("load_preset_failed", s.adapter->lastError().empty()
                                       ? "preset load failed"
                                       : s.adapter->lastError());
        return;
      }
      ok(json::object());
      return;
    }
    if (type == "openEditor") {
      if (s.editor.isOpen()) {
        s.editor.focus();
        ok(json{{"width", s.editor.width()}, {"height", s.editor.height()}});
        return;
      }
      std::string err;
      if (!s.editor.open(s.adapter.get(),
                         s.info.name.empty() ? "Plugin" : s.info.name, err)) {
        fail("open_editor_failed", err.empty() ? "plugin has no editor" : err);
        return;
      }
      ok(json{{"width", s.editor.width()}, {"height", s.editor.height()}});
      return;
    }
    if (type == "closeEditor") {
      s.editor.close();
      ok(json::object());
      return;
    }
    if (type == "suspend") {
      s.shm.setProcessing(false); // audio thread answers silence from now on
      waitBlockDrained(s);
      s.adapter->suspend();
      ok(json::object());
      return;
    }
    if (type == "resume") {
      s.adapter->resume();
      s.shm.setProcessing(true);
      ok(json::object());
      return;
    }

    fail("unsupported", "unknown control message \"" + type + "\"");
  } catch (const std::exception& e) {
    fail("bad_request", e.what());
  }
}

void drainControlQueue(ServeState& s, ControlQueue& q) {
  for (;;) {
    ControlOp* op = nullptr;
    {
      std::lock_guard<std::mutex> lk(q.m);
      if (q.ops.empty()) return;
      op = q.ops.front();
      q.ops.pop_front();
    }
    handleControlOp(s, *op->type, *op->payload, op->requestId);
    signalOp(op);
  }
}

// ---------------------------------------------------------------------------
// Notifier thread: ParamEditBuffer → `paramEdited` pushes (throttled ~30 Hz
// per param id, leaving throttled edits dirty for the next tick) + latency
// watch → `latencyChanged {samples}` (see NOTE(spec) at the top).
// ---------------------------------------------------------------------------
void notifierMain(ServeState& s, std::atomic<bool>& quit) {
  std::unordered_map<uint32_t, uint64_t> lastPushMs;
  constexpr uint64_t kThrottleMs = 33; // ~30 Hz per param

  while (!quit.load(std::memory_order_acquire)) {
    Sleep(10);

    s.shm.edits().forEachDirty(
        [&](uint32_t id, double value, const char* text) -> bool {
          const uint64_t now = GetTickCount64();
          const auto it = lastPushMs.find(id);
          if (it != lastPushMs.end() && now - it->second < kThrottleMs)
            return false; // leave dirty; retried next tick
          lastPushMs[id] = now;
          s.rpc->push("paramEdited", json{{"id", id},
                                          {"value", value},
                                          {"valueText", text ? text : ""}});
          return true;
        });

    if (s.inited.load(std::memory_order_acquire)) {
      uint32_t cur = s.lastLatency.load(std::memory_order_relaxed);
      if (s.cbLatencySeen.load(std::memory_order_acquire))
        cur = s.cbLatency.load(std::memory_order_relaxed);
      // The header value is written by the adapter on every processed block;
      // it is only meaningful once at least one block went through the
      // adapter (ShmServer then sets state Ready/Processing; silence answers
      // leave the engine-initialized Starting state untouched).
      if (mydaw::ShmHeader* h = s.shm.header()) {
        const mydaw::HostState st = mydaw::shmLoadState(h);
        if (st == mydaw::HostState::Ready || st == mydaw::HostState::Processing)
          cur = h->latencySamples;
      }
      if (cur != s.lastLatency.load(std::memory_order_relaxed)) {
        s.lastLatency.store(cur, std::memory_order_relaxed);
        s.rpc->push("latencyChanged", json{{"samples", cur}});
      }
    }
  }
}

// ---------------------------------------------------------------------------
// --serve
// ---------------------------------------------------------------------------
int runServe(const std::wstring& pluginPath, const std::string& format,
             const std::string& shmName, const std::string& pipeName,
             const std::string& uid, uint32_t parentPid) {
  enablePerMonitorV2Dpi();

  ServeState s;
  s.mainThreadId = GetCurrentThreadId();

  // Force-create this thread's message queue before anyone can post to it.
  MSG forceQueue;
  PeekMessageW(&forceQueue, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

  // Parent watcher: the engine died → no one will send quit; just leave.
  if (parentPid != 0) {
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    if (!parent) {
      std::fprintf(stderr, "[host] cannot watch parent pid %lu: %s\n",
                   static_cast<unsigned long>(parentPid),
                   mydaw::win32ErrorString(GetLastError()).c_str());
    } else {
      std::thread([parent] {
        WaitForSingleObject(parent, INFINITE);
        _exit(2);
      }).detach();
    }
  }

  std::string err;
  if (!s.shm.open(shmName, err)) {
    std::fprintf(stderr, "[host] %s\n", err.c_str());
    return 2;
  }
  s.shm.start(); // answers req with silence until the adapter is set

  if (!s.pipe.connect(pipeName, 15000)) {
    std::fprintf(stderr, "[host] failed to connect control pipe \"%s\": %s\n",
                 pipeName.c_str(), s.pipe.errorString().c_str());
    return 2;
  }
  s.rpc = std::make_unique<mydaw::JsonRpc>(s.pipe);

  ControlQueue ctlq;
  mydaw::JsonRpc* rpcRaw = s.rpc.get();
  DWORD mainThreadId = s.mainThreadId;
  s.rpc->setHandler([&ctlq, rpcRaw, mainThreadId](const std::string& type,
                                                  const json& payload,
                                                  int64_t requestId) {
    ControlOp op;
    op.type = &type;
    op.payload = &payload;
    op.requestId = requestId;
    {
      std::lock_guard<std::mutex> lk(ctlq.m);
      if (ctlq.shuttingDown) {
        if (requestId >= 0)
          rpcRaw->replyError(requestId, "shutting_down", "host is shutting down");
        return;
      }
      ctlq.ops.push_back(&op);
    }
    // Wake the pump; if this post is ever lost the 20 ms timer drains the
    // queue anyway. NEVER call request() from here (JsonRpc contract).
    PostThreadMessageW(mainThreadId, kMsgControl, 0, 0);
    std::unique_lock<std::mutex> lk(op.m);
    op.cv.wait(lk, [&op] { return op.done; });
  });

  std::thread reader([&s] {
    s.rpc->runReaderLoop();
    PostThreadMessageW(s.mainThreadId, kMsgPipeClosed, 0, 0);
  });

  // Crash flow (§8.1): ShmServer set the shm state to Crashed; flush one log
  // push (sendMessage is synchronous) before it _exit(3)s the process.
  s.shm.setCrashNotifier([rpcRaw](uint32_t sehCode) {
    char msg[80];
    std::snprintf(msg, sizeof(msg), "plugin crashed in process() (SEH 0x%08X)",
                  sehCode);
    rpcRaw->push("log", json{{"level", "error"}, {"msg", msg}});
  });

  // --- create + load the adapter on the MAIN thread ------------------------
  if (format == "vst2")
    s.adapter = mydaw::createVst2Adapter();
  else if (format == "vst3")
    s.adapter = mydaw::createVst3Adapter(); // nullptr when built MYDAW_NO_VST3
  if (!s.adapter) {
    s.loadError = (format == "vst3")
                      ? "this host was built without VST3 support"
                  : (format == "vst2")
                      ? "failed to create the VST2 adapter"
                      : "unknown plugin format \"" + format + "\"";
  } else {
    // Wire VST2 host callbacks BEFORE load — audioMaster callbacks can fire
    // during plugin construction. Targets are cheap/lock-free as required.
    s.vst2 = dynamic_cast<mydaw::Vst2Host*>(s.adapter.get());
    if (s.vst2) {
      mydaw::Vst2Host::HostCallbacks cb;
      mydaw::ParamEditBuffer* edits = &s.shm.edits();
      cb.paramEdited = [edits](uint32_t id, double value, const char* text) {
        edits->note(id, value, text);
      };
      std::atomic<uint32_t>* lat = &s.cbLatency;
      std::atomic<bool>* seen = &s.cbLatencySeen;
      cb.latencyChanged = [lat, seen](uint32_t samples) {
        lat->store(samples, std::memory_order_relaxed);
        seen->store(true, std::memory_order_release);
      };
      s.vst2->setHostCallbacks(std::move(cb));
    }
    if (!s.adapter->load(pluginPath, uid)) {
      s.loadError = s.adapter->lastError().empty() ? "plugin failed to load"
                                                   : s.adapter->lastError();
      s.vst2 = nullptr;
      s.adapter.reset();
    }
  }
  if (!s.loadError.empty()) {
    // Stay alive: ShmServer keeps the engine's RT wait fed with silence and
    // the init request gets a clear error reply; the engine kills us.
    std::fprintf(stderr, "[host] load failed: %s\n", s.loadError.c_str());
    s.rpc->push("log",
                json{{"level", "error"}, {"msg", "load failed: " + s.loadError}});
  }

  s.editor.onResized = [rpcRaw](int width, int height) {
    rpcRaw->push("resized", json{{"width", width}, {"height", height}});
  };
  s.editor.onUserClosed = [rpcRaw] {
    rpcRaw->push("log",
                 json{{"level", "info"}, {"msg", "editor window closed by user"}});
  };

  std::atomic<bool> notifierQuit{false};
  std::thread notifier([&s, &notifierQuit] { notifierMain(s, notifierQuit); });

  const UINT_PTR timerId = SetTimer(nullptr, 0, kIdleTimerMs, nullptr);

  // --- main message pump ----------------------------------------------------
  MSG msg;
  for (;;) {
    const BOOL r = GetMessageW(&msg, nullptr, 0, 0);
    if (r == 0 || r == -1) break; // WM_QUIT or queue failure
    if (msg.hwnd == nullptr) {
      if (msg.message == kMsgControl || msg.message == WM_TIMER) {
        drainControlQueue(s, ctlq);
        if (msg.message == WM_TIMER && s.adapter &&
            s.inited.load(std::memory_order_acquire) && !s.editor.isOpen()) {
          // VST2 effIdle/needIdle pumping with no editor window; while the
          // editor is open EditorWindow's own 20 ms timer drives editorIdle
          // + resizePending (EditorWindow.h).
          s.adapter->editorIdle();
        }
        continue;
      }
      if (msg.message == kMsgPipeClosed) {
        if (!s.quitting.exchange(true)) PostQuitMessage(0);
        continue;
      }
    }
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  if (timerId) KillTimer(nullptr, timerId);

  // --- shutdown --------------------------------------------------------------
  // Fail queued/future control ops so the reader thread can never block on a
  // handoff the pump will no longer service, then stop the rpc/pipe.
  {
    std::deque<ControlOp*> pending;
    {
      std::lock_guard<std::mutex> lk(ctlq.m);
      ctlq.shuttingDown = true;
      pending.swap(ctlq.ops);
    }
    for (ControlOp* op : pending) {
      if (op->requestId >= 0)
        s.rpc->replyError(op->requestId, "shutting_down", "host is shutting down");
      signalOp(op);
    }
  }
  s.rpc->stop();
  s.pipe.cancelIo();
  if (reader.joinable()) reader.join();
  notifierQuit.store(true, std::memory_order_release);
  if (notifier.joinable()) notifier.join();

  s.editor.close();        // detach editor before the adapter goes away
  s.shm.setAdapter(nullptr);
  s.shm.stop();            // join the audio thread
  if (s.adapter && s.inited.load(std::memory_order_acquire))
    s.adapter->suspend();
  s.adapter.reset();       // unload the plugin on the main thread
  mydaw::flushRegOverlay(); // persist any runtime registry writes to <reg>.local (SPEC §8.5)
  s.pipe.close();
  return 0;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
std::string toLowerAscii(std::string v) {
  for (char& c : v)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return v;
}

int usage() {
  std::fprintf(stderr,
               "usage: mydaw-host --scan <path> [--format vst2|vst3]\n"
               "       mydaw-host --serve --shm <name> --pipe <name> "
               "--plugin <path> --format vst2|vst3 [--uid <uid>] "
               "[--parent-pid <pid>]\n");
  return 2;
}

} // namespace

int main() {
  int argc = 0;
  LPWSTR* argvW = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argvW) {
    std::fprintf(stderr, "[host] CommandLineToArgvW failed\n");
    return 2;
  }
  std::vector<std::wstring> args(argvW, argvW + argc);
  LocalFree(argvW);

  bool scan = false, serve = false;
  std::wstring scanPath, pluginPath;
  std::string format, shmName, pipeName, uid;
  uint32_t parentPid = 0;

  for (size_t i = 1; i < args.size(); ++i) {
    const std::wstring& a = args[i];
    auto next = [&](std::wstring& out) -> bool {
      if (i + 1 >= args.size()) return false;
      out = args[++i];
      return true;
    };
    std::wstring v;
    if (a == L"--scan") {
      scan = true;
      if (!next(scanPath)) return usage();
    } else if (a == L"--serve") {
      serve = true;
    } else if (a == L"--format") {
      if (!next(v)) return usage();
      format = toLowerAscii(mydaw::ipcWideToUtf8(v));
    } else if (a == L"--shm") {
      if (!next(v)) return usage();
      shmName = mydaw::ipcWideToUtf8(v);
    } else if (a == L"--pipe") {
      if (!next(v)) return usage();
      pipeName = mydaw::ipcWideToUtf8(v);
    } else if (a == L"--plugin") {
      if (!next(pluginPath)) return usage();
    } else if (a == L"--uid") {
      if (!next(v)) return usage();
      uid = mydaw::ipcWideToUtf8(v);
    } else if (a == L"--parent-pid") {
      if (!next(v)) return usage();
      parentPid = static_cast<uint32_t>(wcstoul(v.c_str(), nullptr, 10));
    } else {
      std::fprintf(stderr, "[host] unknown argument \"%s\"\n",
                   mydaw::ipcWideToUtf8(a).c_str());
      return usage();
    }
  }

  // Optional per-plugin registry overlay (SPEC §8.5): arm it here — before runScan/runServe,
  // before any plugin DLL is loaded — so the plugin's DllMain and VST entry point see the
  // artificial registry. Covers BOTH modes; a no-op when the plugin has no sidecar .reg.
  if (scan != serve)
    mydaw::installRegOverlayIfPresent(scan ? scanPath : pluginPath);

  if (scan && !serve) {
    const int rc = mydaw::runScan(scanPath, format); // format "" → infer by extension
    // Scan mode materializes captured HKCR classes into HKCU\Software\Classes too
    // (installTempUserClasses); tear them down on the way out so a validation scan does not
    // leave volatile registry behind. A scan that crashes is self-healed on the next arm via
    // the .classes sidecar (SPEC §8.5).
    mydaw::flushRegOverlay();
    return rc;
  }

  if (serve && !scan) {
    if (shmName.empty() || pipeName.empty() || pluginPath.empty() ||
        (format != "vst2" && format != "vst3")) {
      return usage();
    }
    return runServe(pluginPath, format, shmName, pipeName, uid, parentPid);
  }

  return usage();
}
