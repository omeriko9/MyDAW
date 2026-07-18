// MyDAW — plugins/HostProcess.cpp (E7)
// HostProcessManager implementation: per-instance shm/events/pipe/process lifecycle,
// JSON-RPC control plane, crash detection + auto-restart. See HostProcess.h.

#include "plugins/HostProcess.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <chrono>
#include <cstring>
#include <map>
#include <utility>

#include "plugins/PluginProxyNode.h"
#include "plugins/PluginRegistry.h"
#include "project/Model.h"
#include "shared/ipc/Pipe.h"
#include "shared/ipc/PluginIpc.h"
#include "shared/ipc/SharedMem.h"
#include "util/Log.h"
#include "util/Paths.h"

namespace mydaw {

namespace {

// --- timeouts (E7 brief: state ops 10 s, others 3 s; init/connect generous) ----------
constexpr uint32_t kOpTimeoutMs = 3000;         // setParam/getParams/getPresets/loadPreset/closeEditor
constexpr uint32_t kStateOpTimeoutMs = 10000;   // getState/setState
// Recreate is user-triggered (not RT): some plugins load a soundbank inside effSetChunk
// (e.g. UVI PlugSound) and legitimately exceed the 10 s state-op budget. Use a generous
// timeout so a slow-but-successful restore reports ok rather than a spurious failure. (A
// plugin whose effSetChunk needs the host message pump — which the bridge does not run
// during a synchronous dispatch — will never complete and is reported as timeout-alive,
// retryable, by setStateForRecreate regardless of how high this is set.)
constexpr uint32_t kRecreateStateTimeoutMs = 60000;
constexpr uint32_t kOpenEditorTimeoutMs = 10000; // first GUI open loads resources; 3 s is too tight
constexpr uint32_t kInitTimeoutMs = 30000;      // plugin DLL load + instantiation can be slow
constexpr uint32_t kConnectTimeoutMs = 15000;   // host spawn -> pipe connect
constexpr uint32_t kQuitGraceMs = 2000;         // polite quit before TerminateProcess
constexpr int kMaxAutoRestarts = 2;             // SPEC §8.1
constexpr auto kChunkCaptureInterval = std::chrono::seconds(30);

// Drain delays for in-flight processRt() after disabling the node: the RT wait is at
// most 2 x block duration (<= ~93 ms at 2048 frames / 44.1 kHz); offline mode waits up
// to 2000 ms. Sleeping these out (off the RT thread) guarantees no thread is still
// touching the shm view / events when we unmap them.
constexpr uint32_t kRtDrainMs = 150;
constexpr uint32_t kOfflineDrainMs = 2200;

// --- base64 (state chunks travel as chunkB64 on the pipe, SPEC §8.2) -----------------
const char kB64Chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string b64Encode(const std::vector<uint8_t>& data) {
    std::string out;
    out.reserve(((data.size() + 2) / 3) * 4);
    size_t i = 0;
    while (i + 2 < data.size()) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) |
                           static_cast<uint32_t>(data[i + 2]);
        out.push_back(kB64Chars[(v >> 18) & 63]);
        out.push_back(kB64Chars[(v >> 12) & 63]);
        out.push_back(kB64Chars[(v >> 6) & 63]);
        out.push_back(kB64Chars[v & 63]);
        i += 3;
    }
    const size_t rem = data.size() - i;
    if (rem == 1) {
        const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kB64Chars[(v >> 18) & 63]);
        out.push_back(kB64Chars[(v >> 12) & 63]);
        out.push_back('=');
        out.push_back('=');
    } else if (rem == 2) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kB64Chars[(v >> 18) & 63]);
        out.push_back(kB64Chars[(v >> 12) & 63]);
        out.push_back(kB64Chars[(v >> 6) & 63]);
        out.push_back('=');
    }
    return out;
}

bool b64Decode(const std::string& s, std::vector<uint8_t>& out) {
    out.clear();
    out.reserve((s.size() / 4) * 3);
    int8_t rev[256];
    std::memset(rev, -1, sizeof(rev));
    for (int i = 0; i < 64; ++i)
        rev[static_cast<unsigned char>(kB64Chars[i])] = static_cast<int8_t>(i);
    uint32_t acc = 0;
    int bits = 0;
    for (const char ch : s) {
        if (ch == '=' || ch == '\r' || ch == '\n' || ch == ' ')
            continue;
        const int8_t v = rev[static_cast<unsigned char>(ch)];
        if (v < 0)
            return false;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<uint8_t>((acc >> bits) & 0xFF));
        }
    }
    return true;
}

// Human-readable failure out of a JsonRpc reply envelope (peer or synthesized).
std::string replyErrorMessage(const json& reply, const char* fallback) {
    if (reply.is_object() && reply.contains("error")) {
        const json& e = reply["error"];
        if (e.is_string())
            return e.get<std::string>();
        if (e.is_object()) {
            const std::string msg = getOr(e, "message", "");
            if (!msg.empty())
                return msg;
            const std::string code = getOr(e, "code", "");
            if (!code.empty())
                return code;
        }
    }
    return fallback;
}

} // namespace

// ===========================================================================
// Internal structs
// ===========================================================================

const char* pluginRuntimeStateName(PluginRuntimeState s) {
    switch (s) {
        case PluginRuntimeState::Ok:         return "ok";
        case PluginRuntimeState::Loading:    return "loading";
        case PluginRuntimeState::Crashed:    return "crashed";
        case PluginRuntimeState::Timeout:    return "timeout";
        case PluginRuntimeState::Restarting: return "restarting";
        case PluginRuntimeState::Failed:     return "failed";
    }
    return "failed";
}

// Pipe + JsonRpc + reader thread for one spawn. shared_ptr so a control op blocked in
// request() keeps the link alive while a restart replaces it (the op then fails fast
// because teardown calls rpc->stop()). Member order matters: pipe outlives rpc.
struct HostProcessManager::RpcLink {
    std::unique_ptr<Pipe> pipe;
    std::unique_ptr<JsonRpc> rpc;
    std::thread reader;

    ~RpcLink() {
        if (rpc)
            rpc->stop();
        if (pipe)
            pipe->cancelIo();
        if (reader.joinable())
            reader.join();
    }
};

// Heap context handed to RegisterWaitForSingleObject; owned by the Instance and freed
// only after a *blocking* UnregisterWaitEx guarantees the callback is not running.
struct HostProcessManager::ExitWaitCtx {
    HostProcessManager* mgr = nullptr;
    uint64_t instanceId = 0;
    uint64_t spawnGen = 0;
};

struct HostProcessManager::Instance {
    uint64_t id = 0;

    // Immutable identity (copied from PluginInstance at create()).
    std::string uid;
    std::string format; // "vst2" | "vst3"
    std::string path;
    std::string name;
    int bitness = 64;

    // Engine-decided session/IPC geometry.
    uint32_t numIn = 2;
    uint32_t numOut = 2;
    int sampleRate = 48000;
    int maxBlock = 512;
    std::string shmName; // ipcBaseName(enginePid, id)

    std::unique_ptr<PluginProxyNode> node; // stable create()..destroy(), survives restarts

    std::atomic<PluginRuntimeState> state{PluginRuntimeState::Loading};
    // Native-editor capability from the init reply (§8.2 hasEditor). Written by
    // spawnAndInit (main or worker thread on restart), read by hasEditor().
    std::atomic<bool> hasEditor{false};
    std::atomic<int> restartCount{0};
    std::atomic<bool> restartQueued{false};
    std::atomic<bool> destroyed{false};
    std::atomic<bool> expectingExit{false}; // deliberate teardown: ignore the exit wait
    std::atomic<uint64_t> spawnGen{0};

    // Serializes spawnAndInit / teardownIpc / restart / destroy for this instance.
    std::mutex lifeMutex;

    // IPC resources (mutated only under lifeMutex; node holds raw pointers).
    SharedMem shm;
    NamedEvent reqEvent;
    NamedEvent doneEvent;
    std::mutex rpcMutex; // guards link swap
    std::shared_ptr<RpcLink> link;
    void* process = nullptr;    // HANDLE
    void* waitHandle = nullptr; // RegisterWaitForSingleObject
    std::unique_ptr<ExitWaitCtx> waitCtx;

    // Restore data (dataMutex).
    std::mutex dataMutex;
    std::vector<uint8_t> lastGoodChunk;
    std::map<uint32_t, double> cachedParams;
    std::chrono::steady_clock::time_point lastChunkCapture{};

    // pump()-thread-only bookkeeping.
    int lastNotifiedLatency = 0;

    std::shared_ptr<RpcLink> getLink() {
        std::lock_guard<std::mutex> lk(rpcMutex);
        return link;
    }
};

// ===========================================================================
// Construction / destruction
// ===========================================================================

HostProcessManager::HostProcessManager() {
    enginePid_ = static_cast<uint32_t>(GetCurrentProcessId());
    worker_ = std::thread(&HostProcessManager::workerLoop, this);
}

HostProcessManager::~HostProcessManager() {
    shuttingDown_.store(true, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lk(jobMutex_);
        stopWorker_ = true;
        jobs_.clear();
    }
    jobCv_.notify_all();
    if (worker_.joinable())
        worker_.join();
    destroyAll();
}

void HostProcessManager::setHostPaths(const std::string& host64, const std::string& host32) {
    std::lock_guard<std::mutex> lk(pathMutex_);
    host64Path_ = host64;
    host32Path_ = host32;
}

void HostProcessManager::setRegistry(const PluginRegistry* registry) {
    registry_.store(registry, std::memory_order_release);
}

void HostProcessManager::setStateCallback(StateCallback cb) {
    std::lock_guard<std::mutex> lk(cbMutex_);
    stateCb_ = std::move(cb);
}

void HostProcessManager::setParamEditedCallback(ParamEditedCallback cb) {
    std::lock_guard<std::mutex> lk(cbMutex_);
    paramEditedCb_ = std::move(cb);
}

void HostProcessManager::setLatencyCallback(LatencyCallback cb) {
    std::lock_guard<std::mutex> lk(cbMutex_);
    latencyCb_ = std::move(cb);
}

// ===========================================================================
// Lookup helpers
// ===========================================================================

std::shared_ptr<HostProcessManager::Instance>
HostProcessManager::findInstance(uint64_t instanceId) const {
    std::lock_guard<std::mutex> lk(mapMutex_);
    const auto it = instances_.find(instanceId);
    return it == instances_.end() ? nullptr : it->second;
}

PluginRuntimeState HostProcessManager::state(uint64_t instanceId) const {
    const auto inst = findInstance(instanceId);
    return inst ? inst->state.load(std::memory_order_acquire) : PluginRuntimeState::Failed;
}

bool HostProcessManager::hasEditor(uint64_t instanceId) const {
    const auto inst = findInstance(instanceId);
    return inst && inst->hasEditor.load(std::memory_order_acquire);
}

PluginProxyNode* HostProcessManager::node(uint64_t instanceId) {
    const auto inst = findInstance(instanceId);
    return inst ? inst->node.get() : nullptr;
}

bool HostProcessManager::isInstrumentUid(const std::string& uid) const {
    const PluginRegistry* reg = registry_.load(std::memory_order_acquire);
    if (!reg)
        return false;
    // byUid pointer is valid until the next scan completes — copy the flag immediately.
    const PluginInfo* info = reg->byUid(uid);
    return info && info->isInstrument;
}

std::string HostProcessManager::hostExeFor(int bitness, std::string& err) const {
    std::string path;
    {
        std::lock_guard<std::mutex> lk(pathMutex_);
        path = (bitness == 32) ? host32Path_ : host64Path_;
    }
    if (bitness == 32) {
        if (path.empty()) {
            err = "mydaw-host32.exe is not configured — build the host32-release preset "
                  "(build32/) to use 32-bit plugins";
            return {};
        }
    } else if (path.empty()) {
        path = pathJoin(exeDir(), "mydaw-host64.exe"); // SPEC §3: same dir as engine first
    }
    if (!fileExists(path)) {
        err = std::string(bitness == 32 ? "mydaw-host32.exe" : "mydaw-host64.exe") +
              " not found at \"" + path + "\"";
        return {};
    }
    return path;
}

void HostProcessManager::setStateAndNotify(const std::shared_ptr<Instance>& inst,
                                           PluginRuntimeState s, const std::string& message) {
    inst->state.store(s, std::memory_order_release);
    const int restarts = inst->restartCount.load(std::memory_order_relaxed);
    if (s == PluginRuntimeState::Crashed || s == PluginRuntimeState::Timeout ||
        s == PluginRuntimeState::Failed) {
        Log::warn("plugin %llu (%s): %s%s%s",
                  static_cast<unsigned long long>(inst->id), inst->name.c_str(),
                  pluginRuntimeStateName(s), message.empty() ? "" : " — ", message.c_str());
    } else {
        Log::info("plugin %llu (%s): %s%s%s",
                  static_cast<unsigned long long>(inst->id), inst->name.c_str(),
                  pluginRuntimeStateName(s), message.empty() ? "" : " — ", message.c_str());
    }
    StateCallback cb;
    {
        std::lock_guard<std::mutex> lk(cbMutex_);
        cb = stateCb_;
    }
    if (cb)
        cb(inst->id, s, message, restarts);
}

// ===========================================================================
// create / destroy
// ===========================================================================

bool HostProcessManager::create(const PluginInstance& instance, int sampleRate, int maxBlock,
                                std::string& err) {
    err.clear();
    if (instance.instanceId == 0) {
        err = "invalid instanceId 0";
        return false;
    }
    if (shuttingDown_.load(std::memory_order_acquire)) {
        err = "engine is shutting down";
        return false;
    }
    if (findInstance(instance.instanceId)) {
        Log::warn("HostProcessManager::create: instance %llu already exists — recreating",
                  static_cast<unsigned long long>(instance.instanceId));
        destroy(instance.instanceId);
    }

    auto inst = std::make_shared<Instance>();
    inst->id = instance.instanceId;
    inst->uid = instance.uid;
    inst->format = instance.format;
    inst->path = instance.path;
    inst->name = instance.name.empty() ? instance.path : instance.name;
    inst->bitness = instance.bitness == 32 ? 32 : 64;
    inst->numIn = isInstrumentUid(instance.uid) ? 0u : 2u; // E7 brief: instruments 0-in
    inst->numOut = 2;
    inst->sampleRate = sampleRate > 0 ? sampleRate : 48000;
    inst->maxBlock = (maxBlock > 0 && maxBlock <= static_cast<int>(kMaxBlock))
                         ? maxBlock
                         : static_cast<int>(kMaxBlock);
    inst->shmName = ipcBaseName(enginePid_, inst->id);
    inst->node = std::make_unique<PluginProxyNode>(*this, inst->id);
    inst->node->setBypass(instance.bypass);
    inst->node->setWetDry(static_cast<float>(instance.wetDry));
    {
        std::lock_guard<std::mutex> lk(inst->dataMutex);
        inst->cachedParams = instance.paramValues;
    }
    {
        std::lock_guard<std::mutex> lk(mapMutex_);
        instances_[inst->id] = inst;
    }
    setStateAndNotify(inst, PluginRuntimeState::Loading, "loading " + inst->name);

    bool ok;
    {
        std::lock_guard<std::mutex> lk(inst->lifeMutex);
        ok = spawnAndInit(*inst, err);
        if (!ok)
            teardownIpc(*inst, 0);
    }
    if (!ok) {
        setStateAndNotify(inst, PluginRuntimeState::Failed, err);
        std::lock_guard<std::mutex> lk(mapMutex_);
        instances_.erase(inst->id);
        return false;
    }
    setStateAndNotify(inst, PluginRuntimeState::Ok, "");
    return true;
}

void HostProcessManager::destroy(uint64_t instanceId) {
    std::shared_ptr<Instance> inst;
    {
        std::lock_guard<std::mutex> lk(mapMutex_);
        const auto it = instances_.find(instanceId);
        if (it == instances_.end())
            return;
        inst = it->second;
        instances_.erase(it);
    }
    std::lock_guard<std::mutex> lk(inst->lifeMutex);
    inst->destroyed.store(true, std::memory_order_release);
    teardownIpc(*inst, kQuitGraceMs);
    // The Instance (and its node) dies when the last shared_ptr drops — here, unless a
    // queued job still holds a lookup copy momentarily (it will see destroyed=true).
}

void HostProcessManager::destroyAll() {
    std::vector<uint64_t> ids;
    {
        std::lock_guard<std::mutex> lk(mapMutex_);
        ids.reserve(instances_.size());
        for (const auto& [id, inst] : instances_)
            ids.push_back(id);
    }
    for (const uint64_t id : ids)
        destroy(id);
}

// ===========================================================================
// spawn + init (inst.lifeMutex held)
// ===========================================================================

bool HostProcessManager::spawnAndInit(Instance& inst, std::string& err) {
    inst.expectingExit.store(false, std::memory_order_relaxed);
    const uint64_t gen = inst.spawnGen.fetch_add(1, std::memory_order_acq_rel) + 1;

    // --- 1. shared memory + events ----------------------------------------------------
    inst.shm.close();
    if (!inst.shm.create(inst.shmName, shmTotalSize(inst.numIn, inst.numOut))) {
        err = "shared memory create failed: " + inst.shm.errorString();
        return false;
    }
    shmInitHeader(shmHeader(inst.shm.data()), inst.numIn, inst.numOut,
                  static_cast<uint32_t>(inst.sampleRate));
    inst.reqEvent.close();
    inst.doneEvent.close();
    if (!inst.reqEvent.create(shmReqEventName(inst.shmName)) ||
        !inst.doneEvent.create(shmDoneEventName(inst.shmName))) {
        err = "IPC event create failed: " +
              (inst.reqEvent.valid() ? inst.doneEvent.errorString() : inst.reqEvent.errorString());
        return false;
    }
    // A previous (killed) host may have left the auto-reset done event signaled.
    (void)inst.doneEvent.wait(0);

    // --- 2. control pipe server --------------------------------------------------------
    auto link = std::make_shared<RpcLink>();
    link->pipe = std::make_unique<Pipe>();
    const std::string pipeName = ipcPipeName(inst.shmName);
    if (!link->pipe->createServer(pipeName)) {
        err = "pipe create failed: " + link->pipe->errorString();
        return false;
    }

    // --- 3. spawn the host process (SPEC §8 command line) -------------------------------
    const std::string hostExe = hostExeFor(inst.bitness, err);
    if (hostExe.empty())
        return false;
    const std::wstring wExe = utf8ToWide(hostExe);
    std::wstring cmd = L"\"" + wExe + L"\" --serve --shm " + utf8ToWide(inst.shmName) +
                       L" --pipe " + utf8ToWide(pipeName) + L" --plugin \"" +
                       utf8ToWide(inst.path) + L"\" --format " + utf8ToWide(inst.format) +
                       L" --uid \"" + utf8ToWide(inst.uid) + L"\" --parent-pid " +
                       std::to_wstring(enginePid_);
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};

    // Opt-in diagnostic: MYDAW_HOST_LOG_DIR redirects each host's stdout+stderr (the VST2/
    // registry trace) to <dir>\host-<instanceId>.log so out-of-process load crashes are visible.
    HANDLE logFile = INVALID_HANDLE_VALUE;
    BOOL inheritHandles = FALSE;
    const DWORD createFlags = CREATE_NO_WINDOW; // stays valid with redirected std handles
    {
        wchar_t dirBuf[MAX_PATH] = {};
        const DWORD n = GetEnvironmentVariableW(L"MYDAW_HOST_LOG_DIR", dirBuf, MAX_PATH);
        if (n > 0 && n < MAX_PATH) {
            CreateDirectoryW(dirBuf, nullptr);
            std::wstring logPath = std::wstring(dirBuf) + L"\\host-" +
                                   std::to_wstring(inst.id) + L".log";
            SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
            // OPEN_ALWAYS + append so a crash-restart of the same instance keeps prior output.
            logFile = CreateFileW(logPath.c_str(), FILE_APPEND_DATA,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_ALWAYS,
                                  FILE_ATTRIBUTE_NORMAL, nullptr);
            if (logFile != INVALID_HANDLE_VALUE) {
                si.dwFlags |= STARTF_USESTDHANDLES;
                si.hStdOutput = logFile;
                si.hStdError = logFile;
                si.hStdInput = INVALID_HANDLE_VALUE;
                inheritHandles = TRUE;
            }
        }
    }

    if (!CreateProcessW(wExe.c_str(), cmdBuf.data(), nullptr, nullptr, inheritHandles,
                        createFlags, nullptr, nullptr, &si, &pi)) {
        err = "CreateProcess(\"" + hostExe + "\") failed: " +
              win32ErrorString(GetLastError());
        if (logFile != INVALID_HANDLE_VALUE)
            CloseHandle(logFile);
        return false;
    }
    if (logFile != INVALID_HANDLE_VALUE)
        CloseHandle(logFile); // the child holds its own inherited copy
    CloseHandle(pi.hThread);
    inst.process = pi.hProcess;
    Log::info("plugin %llu: spawned %s (pid %lu) for \"%s\"",
              static_cast<unsigned long long>(inst.id), hostExe.c_str(),
              static_cast<unsigned long>(pi.dwProcessId), inst.path.c_str());

    // --- 4. wait for the host to connect (slice so we notice early exits) ---------------
    bool connected = false;
    const uint64_t deadline = GetTickCount64() + kConnectTimeoutMs;
    while (GetTickCount64() < deadline) {
        const PipeResult r = link->pipe->waitForClient(250);
        if (r == PipeResult::Ok) {
            connected = true;
            break;
        }
        if (r != PipeResult::Timeout) {
            err = "pipe accept failed: " + link->pipe->errorString();
            break;
        }
        if (WaitForSingleObject(static_cast<HANDLE>(inst.process), 0) == WAIT_OBJECT_0) {
            DWORD code = 0;
            GetExitCodeProcess(static_cast<HANDLE>(inst.process), &code);
            err = "host process exited during startup (exit code " +
                  std::to_string(code) + ")";
            break;
        }
        if (shuttingDown_.load(std::memory_order_acquire)) {
            err = "engine is shutting down";
            break;
        }
    }
    if (!connected) {
        if (err.empty())
            err = "timed out waiting for the host process to connect";
        return false; // caller runs teardownIpc (kills the process)
    }

    // --- 5. JSON-RPC + reader thread -----------------------------------------------------
    link->rpc = std::make_unique<JsonRpc>(*link->pipe);
    JsonRpc* rpcRaw = link->rpc.get();
    const uint64_t id = inst.id;
    link->rpc->setHandler([this, id, rpcRaw](const std::string& type, const json& payload,
                                             int64_t requestId) {
        if (requestId >= 0) {
            // The engine accepts no requests from hosts (§8.2: host only pushes).
            // Reply is fine here — only request() is banned inside the handler.
            rpcRaw->replyError(requestId, "unsupported", "engine accepts no host requests");
            return;
        }
        handlePush(id, type, payload);
    });
    link->reader = std::thread([rpcRaw] { rpcRaw->runReaderLoop(); });
    {
        std::lock_guard<std::mutex> lk(inst.rpcMutex);
        inst.link = link;
    }

    // --- 6. init handshake ----------------------------------------------------------------
    json reply;
    const bool transportOk = link->rpc->request(
        "init", json{{"sampleRate", inst.sampleRate}, {"maxBlock", inst.maxBlock}}, reply,
        kInitTimeoutMs);
    bool okFlag = transportOk && reply.is_object() && reply.value("ok", false);
    json info = (reply.is_object() && reply.contains("payload")) ? reply["payload"]
                                                                 : json::object();
    if (okFlag && info.is_object()) {
        // Tolerate hosts replying payload = {ok, info:{...}} (the literal §8.2 shape)
        // as well as payload = {info:{...}} / payload = info.
        if (info.contains("ok") && info["ok"].is_boolean() && !info["ok"].get<bool>())
            okFlag = false;
        if (info.contains("info") && info["info"].is_object())
            info = info["info"];
    }
    if (!okFlag) {
        err = "plugin init failed: " +
              (transportOk ? replyErrorMessage(info.is_object() ? info : reply,
                                               replyErrorMessage(reply, "host reported failure")
                                                   .c_str())
                           : replyErrorMessage(reply, "no reply"));
        return false;
    }

    const bool isInstrument = getOr<bool>(info, "isInstrument", false);
    inst.node->setIsInstrument(isInstrument);
    inst.node->setLatencyFromHost(getOr<int>(info, "latency", 0));
    // §8.2 hasEditor (absent from older hosts → false, the safe default).
    inst.hasEditor.store(getOr<bool>(info, "hasEditor", false),
                         std::memory_order_release);
    // The host reports this only after its capture hooks have been installed,
    // so this is an affirmative, per-instance audit record rather than an
    // inference from the plugin's folder layout.
    const json overlay = info.value("captureOverlay", json::object());
    if (overlay.is_object() && overlay.value("registry", false)) {
        const std::string registryPath = overlay.value("registryPath", "");
        if (overlay.value("armed", false)) {
            Log::info("plugin %llu (%s): capture registry mock active from \"%s\"",
                      static_cast<unsigned long long>(inst.id), inst.name.c_str(),
                      registryPath.c_str());
        } else {
            Log::warn("plugin %llu (%s): capture registry \"%s\" was found but its mock did not arm",
                      static_cast<unsigned long long>(inst.id), inst.name.c_str(),
                      registryPath.c_str());
        }
    }
    if (overlay.is_object() && overlay.value("files", false) && overlay.value("armed", false)) {
        Log::info("plugin %llu (%s): capture file mirror active from \"%s\"",
                  static_cast<unsigned long long>(inst.id), inst.name.c_str(),
                  overlay.value("mirrorPath", "").c_str());
    }
    if (!isInstrument && inst.numIn == 0) {
        Log::warn("plugin %llu: registry said instrument but \"%s\" reports effect — it "
                  "receives no audio input until removed and re-added after a rescan",
                  static_cast<unsigned long long>(inst.id), inst.name.c_str());
    }

    // --- 7. restore state chunk, then cached params (SPEC §8.1 restart order) ------------
    std::vector<uint8_t> chunk;
    std::map<uint32_t, double> params;
    {
        std::lock_guard<std::mutex> lk(inst.dataMutex);
        chunk = inst.lastGoodChunk;
        params = inst.cachedParams;
    }
    if (!chunk.empty()) {
        json r;
        if (!link->rpc->request("setState", json{{"chunkB64", b64Encode(chunk)}}, r,
                                kStateOpTimeoutMs) ||
            !r.value("ok", false)) {
            Log::warn("plugin %llu: state restore failed: %s",
                      static_cast<unsigned long long>(inst.id),
                      replyErrorMessage(r, "host error").c_str());
        }
    }
    for (const auto& [paramId, value] : params) {
        json r;
        (void)link->rpc->request("setParam", json{{"id", paramId}, {"value", value}}, r,
                                 kOpTimeoutMs);
    }

    // --- 8. crash detection: registered wait on the process handle ------------------------
    auto ctx = std::make_unique<ExitWaitCtx>();
    ctx->mgr = this;
    ctx->instanceId = inst.id;
    ctx->spawnGen = gen;
    HANDLE waitHandle = nullptr;
    if (RegisterWaitForSingleObject(&waitHandle, static_cast<HANDLE>(inst.process),
                                    reinterpret_cast<WAITORTIMERCALLBACK>(&HostProcessManager::onHostExit),
                                    ctx.get(), INFINITE, WT_EXECUTEONLYONCE)) {
        inst.waitHandle = waitHandle;
        inst.waitCtx = std::move(ctx);
    } else {
        Log::warn("plugin %llu: RegisterWaitForSingleObject failed (%s) — crash detection "
                  "falls back to RT deadline misses",
                  static_cast<unsigned long long>(inst.id),
                  win32ErrorString(GetLastError()).c_str());
    }

    // --- 9. wire + enable the RT node ------------------------------------------------------
    inst.node->setIpcRt(inst.shm.data(), inst.numIn, inst.numOut, &inst.reqEvent,
                        &inst.doneEvent, inst.sampleRate);
    inst.node->enableRt();

    // Opportunistic "last good chunk" capture (worker thread, never blocks here).
    {
        std::lock_guard<std::mutex> lk(inst.dataMutex);
        inst.lastChunkCapture = std::chrono::steady_clock::now();
    }
    queueJob([this, id] { captureChunkJob(id); });
    return true;
}

// ===========================================================================
// teardown (inst.lifeMutex held)
// ===========================================================================

void HostProcessManager::teardownIpc(Instance& inst, uint32_t processGraceMs) {
    inst.expectingExit.store(true, std::memory_order_release);

    // 1. Disable the RT node and wait out any in-flight processRt() (see kRtDrainMs).
    const bool wasEnabled = inst.node && inst.node->disableRt();
    if (wasEnabled)
        Sleep(inst.node->offlineMode() ? kOfflineDrainMs : kRtDrainMs);

    // 2. Stop crash detection BEFORE killing the process (blocking unregister so the
    //    callback can't fire after the ctx is freed). Never called while holding
    //    mapMutex_ — the callback itself takes it.
    if (inst.waitHandle) {
        UnregisterWaitEx(static_cast<HANDLE>(inst.waitHandle), INVALID_HANDLE_VALUE);
        inst.waitHandle = nullptr;
        inst.waitCtx.reset();
    }

    // 3. Ask the host to quit politely, then stop the RPC machinery.
    std::shared_ptr<RpcLink> link;
    {
        std::lock_guard<std::mutex> lk(inst.rpcMutex);
        link = std::move(inst.link);
        inst.link.reset();
    }
    if (link) {
        if (link->rpc && link->rpc->running())
            (void)link->rpc->push("quit", json::object());
        if (link->rpc)
            link->rpc->stop();
        link->pipe->cancelIo();
        if (link->reader.joinable())
            link->reader.join();
        link.reset(); // last engine-side reference unless a control op holds one
    }

    // 4. The process: grace period, then terminate; always reap before reusing names.
    if (inst.process) {
        HANDLE h = static_cast<HANDLE>(inst.process);
        if (WaitForSingleObject(h, processGraceMs) != WAIT_OBJECT_0) {
            TerminateProcess(h, 1);
            WaitForSingleObject(h, 5000);
        }
        CloseHandle(h);
        inst.process = nullptr;
    }

    // 5. Unmap/close IPC objects (safe: node disabled + drained, host dead).
    if (inst.node)
        inst.node->clearIpcRt();
    inst.reqEvent.close();
    inst.doneEvent.close();
    inst.shm.close();
}

// ===========================================================================
// Crash flow
// ===========================================================================

void __stdcall HostProcessManager::onHostExit(void* context, unsigned char /*timedOut*/) {
    // Kernel thread-pool thread. ctx stays valid: it is freed only after a blocking
    // UnregisterWaitEx, which cannot complete while we are still in here.
    auto* ctx = static_cast<ExitWaitCtx*>(context);
    if (ctx && ctx->mgr)
        ctx->mgr->handleHostExit(ctx->instanceId, ctx->spawnGen);
}

void HostProcessManager::handleHostExit(uint64_t instanceId, uint64_t spawnGen) {
    const auto inst = findInstance(instanceId);
    if (!inst)
        return;
    if (inst->spawnGen.load(std::memory_order_acquire) != spawnGen)
        return; // stale wait from a previous spawn
    if (inst->expectingExit.load(std::memory_order_acquire) ||
        inst->destroyed.load(std::memory_order_acquire))
        return;
    const PluginRuntimeState s = inst->state.load(std::memory_order_acquire);
    if (s == PluginRuntimeState::Restarting || s == PluginRuntimeState::Failed)
        return;
    if (inst->node)
        inst->node->disableRt();
    setStateAndNotify(inst, PluginRuntimeState::Crashed, "host process exited unexpectedly");
    queueRestart(instanceId);
}

void HostProcessManager::queueRestart(uint64_t instanceId) {
    if (shuttingDown_.load(std::memory_order_acquire))
        return;
    const auto inst = findInstance(instanceId);
    if (!inst || inst->destroyed.load(std::memory_order_acquire))
        return;
    if (inst->restartQueued.exchange(true, std::memory_order_acq_rel))
        return; // a restart is already queued/running
    queueJob([this, instanceId] { restartJob(instanceId); });
}

void HostProcessManager::restartJob(uint64_t instanceId) {
    const auto inst = findInstance(instanceId);
    if (!inst)
        return;
    std::lock_guard<std::mutex> lk(inst->lifeMutex);
    inst->restartQueued.store(false, std::memory_order_release);
    if (inst->destroyed.load(std::memory_order_acquire) ||
        shuttingDown_.load(std::memory_order_acquire))
        return;

    const int priorRestarts = inst->restartCount.load(std::memory_order_relaxed);
    if (priorRestarts >= kMaxAutoRestarts) {
        teardownIpc(*inst, 0);
        setStateAndNotify(inst, PluginRuntimeState::Failed,
                          "crashed again after " + std::to_string(kMaxAutoRestarts) +
                              " automatic restarts — remove and re-add the plugin to retry");
        return;
    }
    inst->restartCount.store(priorRestarts + 1, std::memory_order_relaxed);
    setStateAndNotify(inst, PluginRuntimeState::Restarting,
                      "restarting (attempt " + std::to_string(priorRestarts + 1) + " of " +
                          std::to_string(kMaxAutoRestarts) + ")");
    teardownIpc(*inst, 500);

    std::string err;
    if (spawnAndInit(*inst, err)) {
        setStateAndNotify(inst, PluginRuntimeState::Ok, "recovered after restart");
        return;
    }
    teardownIpc(*inst, 0);
    if (inst->restartCount.load(std::memory_order_relaxed) >= kMaxAutoRestarts) {
        setStateAndNotify(inst, PluginRuntimeState::Failed, err);
    } else {
        setStateAndNotify(inst, PluginRuntimeState::Crashed, "restart failed: " + err);
        queueRestart(instanceId);
    }
}

void HostProcessManager::captureChunkJob(uint64_t instanceId) {
    const auto inst = findInstance(instanceId);
    if (!inst || inst->state.load(std::memory_order_acquire) != PluginRuntimeState::Ok)
        return;
    const auto link = inst->getLink();
    if (!link || !link->rpc)
        return;
    json reply;
    if (!link->rpc->request("getState", json::object(), reply, kStateOpTimeoutMs) ||
        !reply.value("ok", false))
        return;
    const json payload = reply.value("payload", json::object());
    std::vector<uint8_t> chunk;
    if (!b64Decode(getOr(payload, "chunkB64", ""), chunk) || chunk.empty())
        return;
    std::lock_guard<std::mutex> lk(inst->dataMutex);
    inst->lastGoodChunk = std::move(chunk);
}

// ===========================================================================
// Pipe pushes (per-instance reader thread)
// ===========================================================================

void HostProcessManager::handlePush(uint64_t instanceId, const std::string& type,
                                    const json& payload) {
    if (type == "paramEdited") {
        const uint32_t paramId = getOr<uint32_t>(payload, "id", 0);
        const double value = getOr<double>(payload, "value", 0.0);
        const std::string valueText = getOr(payload, "valueText", "");
        if (const auto inst = findInstance(instanceId)) {
            std::lock_guard<std::mutex> lk(inst->dataMutex);
            inst->cachedParams[paramId] = value;
        }
        ParamEditedCallback cb;
        {
            std::lock_guard<std::mutex> lk(cbMutex_);
            cb = paramEditedCb_;
        }
        if (cb)
            cb(instanceId, paramId, value, valueText);
        return;
    }
    if (type == "latencyChanged") {
        const int samples = getOr<int>(payload, "samples", 0);
        if (const auto inst = findInstance(instanceId)) {
            if (inst->node)
                inst->node->setLatencyFromHost(samples); // pump() fires the callback
        }
        return;
    }
    if (type == "log") {
        std::string level = "info";
        if (payload.is_object() && payload.contains("level")) {
            if (payload["level"].is_string())
                level = payload["level"].get<std::string>();
            else if (payload["level"].is_number_integer())
                level = payload["level"].get<int>() >= 2   ? "error"
                        : payload["level"].get<int>() == 1 ? "warn"
                                                           : "info";
        }
        const std::string msg = getOr(payload, "msg", "");
        if (level == "error")
            Log::error("[host %llu] %s", static_cast<unsigned long long>(instanceId),
                       msg.c_str());
        else if (level == "warn")
            Log::warn("[host %llu] %s", static_cast<unsigned long long>(instanceId),
                      msg.c_str());
        else
            Log::info("[host %llu] %s", static_cast<unsigned long long>(instanceId),
                      msg.c_str());
        return;
    }
    if (type == "resized")
        return; // host owns its editor window; nothing for the engine to do
    Log::info("[host %llu] unhandled push \"%s\"",
              static_cast<unsigned long long>(instanceId), type.c_str());
}

// ===========================================================================
// Control ops (main thread; bounded pipe timeouts)
// ===========================================================================

bool HostProcessManager::requestOnInstance(uint64_t instanceId, const char* type,
                                           const json& payload, json& reply,
                                           uint32_t timeoutMs) {
    const auto inst = findInstance(instanceId);
    if (!inst)
        return false;
    const auto link = inst->getLink();
    if (!link || !link->rpc)
        return false;
    if (!link->rpc->request(type, payload, reply, timeoutMs))
        return false;
    return reply.is_object() && reply.value("ok", false);
}

json HostProcessManager::getParams(uint64_t instanceId) {
    json reply;
    if (!requestOnInstance(instanceId, "getParams", json::object(), reply, kOpTimeoutMs))
        return json::array();
    json p = reply.value("payload", json::object());
    if (p.is_object() && p.contains("params") && p["params"].is_array())
        p = p["params"];
    if (!p.is_array())
        return json::array();
    // Refresh the restore cache so a restart reproduces current values even if the
    // host has no state chunk.
    if (const auto inst = findInstance(instanceId)) {
        std::lock_guard<std::mutex> lk(inst->dataMutex);
        for (const json& param : p) {
            if (param.is_object() && param.contains("id") && param.contains("value") &&
                param["id"].is_number() && param["value"].is_number()) {
                inst->cachedParams[param["id"].get<uint32_t>()] =
                    param["value"].get<double>();
            }
        }
    }
    return p;
}

bool HostProcessManager::setParam(uint64_t instanceId, uint32_t paramId, double value) {
    json reply;
    if (!requestOnInstance(instanceId, "setParam",
                           json{{"id", paramId}, {"value", value}}, reply, kOpTimeoutMs))
        return false;
    if (const auto inst = findInstance(instanceId)) {
        std::lock_guard<std::mutex> lk(inst->dataMutex);
        inst->cachedParams[paramId] = value;
    }
    return true;
}

bool HostProcessManager::getState(uint64_t instanceId, std::vector<uint8_t>& out) {
    out.clear();
    json reply;
    if (!requestOnInstance(instanceId, "getState", json::object(), reply, kStateOpTimeoutMs))
        return false;
    const json payload = reply.value("payload", json::object());
    if (!b64Decode(getOr(payload, "chunkB64", ""), out))
        return false;
    if (!out.empty()) {
        if (const auto inst = findInstance(instanceId)) {
            std::lock_guard<std::mutex> lk(inst->dataMutex);
            inst->lastGoodChunk = out;
        }
    }
    return true;
}

bool HostProcessManager::setState(uint64_t instanceId, const std::vector<uint8_t>& data) {
    json reply;
    if (!requestOnInstance(instanceId, "setState", json{{"chunkB64", b64Encode(data)}},
                           reply, kStateOpTimeoutMs))
        return false;
    if (const auto inst = findInstance(instanceId)) {
        std::lock_guard<std::mutex> lk(inst->dataMutex);
        inst->lastGoodChunk = data;
    }
    return true;
}

SetStateResult HostProcessManager::setStateForRecreate(uint64_t instanceId,
                                                       const std::vector<uint8_t>& data,
                                                       std::string& err) {
    const auto inst = findInstance(instanceId);
    if (!inst) {
        err = "no such instance";
        return SetStateResult::Failed;
    }
    const auto link = inst->getLink();
    if (!link || !link->rpc) {
        err = "host link unavailable";
        return SetStateResult::Failed;
    }
    json reply;
    const bool transportOk =
        link->rpc->request("setState", json{{"chunkB64", b64Encode(data)}}, reply,
                           kRecreateStateTimeoutMs);
    if (transportOk && reply.is_object() && reply.value("ok", false)) {
        std::lock_guard<std::mutex> lk(inst->dataMutex);
        inst->lastGoodChunk = data;
        return SetStateResult::Ok;
    }
    err = replyErrorMessage(reply, "setState failed");
    // Synthesized "timeout" with a live host = slow-but-alive: keep dormant, retryable.
    // "pipe_closed"/"send_failed" or a peer ok:false rejection = the host is gone/refused.
    const std::string code =
        (reply.is_object() && reply.contains("error") && reply["error"].is_object())
            ? getOr(reply["error"], "code", "")
            : "";
    if (!transportOk && code == "timeout")
        return SetStateResult::TimedOutAlive;
    return SetStateResult::Failed;
}

json HostProcessManager::getPresets(uint64_t instanceId) {
    json reply;
    if (!requestOnInstance(instanceId, "getPresets", json::object(), reply, kOpTimeoutMs))
        return json::array();
    json p = reply.value("payload", json::object());
    if (p.is_object() && p.contains("presets") && p["presets"].is_array())
        p = p["presets"];
    return p.is_array() ? p : json::array();
}

bool HostProcessManager::loadPreset(uint64_t instanceId, int presetId) {
    json reply;
    if (!requestOnInstance(instanceId, "loadPreset", json{{"id", presetId}}, reply,
                           kOpTimeoutMs))
        return false;
    // Preset changed the whole state — refresh the last good chunk opportunistically.
    queueJob([this, instanceId] { captureChunkJob(instanceId); });
    return true;
}

bool HostProcessManager::openEditor(uint64_t instanceId, std::string* errOut) {
    json reply;
    if (requestOnInstance(instanceId, "openEditor", json::object(), reply,
                          kOpenEditorTimeoutMs))
        return true;
    if (errOut) {
        // reply is untouched (null) only when the instance/link lookup failed;
        // otherwise it carries the host's error envelope ("plugin has no
        // editor", attach failures, ...) or the synthesized transport failure.
        *errOut = reply.is_null() ? "plugin instance is not running"
                                  : replyErrorMessage(reply, "openEditor failed");
    }
    return false;
}

bool HostProcessManager::closeEditor(uint64_t instanceId) {
    json reply;
    return requestOnInstance(instanceId, "closeEditor", json::object(), reply, kOpTimeoutMs);
}

// ===========================================================================
// pump() — main thread, ~30 Hz
// ===========================================================================

void HostProcessManager::pump() {
    // 1. shm-path native-editor param edits -> paramEdited callback (coalesced per
    //    (instance,param): only the latest value of this pump interval is reported).
    {
        ParamOutMsg m;
        std::map<std::pair<uint64_t, uint32_t>, float> latest;
        while (paramOutRing_.pop(m))
            latest[{m.instanceId, m.paramId}] = m.value;
        if (!latest.empty()) {
            ParamEditedCallback cb;
            {
                std::lock_guard<std::mutex> lk(cbMutex_);
                cb = paramEditedCb_;
            }
            for (const auto& [key, value] : latest) {
                if (const auto inst = findInstance(key.first)) {
                    std::lock_guard<std::mutex> lk(inst->dataMutex);
                    inst->cachedParams[key.second] = static_cast<double>(value);
                }
                // valueText unknown on the shm path; hosts push pipe `paramEdited`
                // (with text) for displayed edits — this covers the rest.
                if (cb)
                    cb(key.first, key.second, static_cast<double>(value), std::string());
            }
        }
    }

    // 2. Per-instance: timeout promotion, latency-change notification, chunk refresh.
    std::vector<std::shared_ptr<Instance>> snapshot;
    {
        std::lock_guard<std::mutex> lk(mapMutex_);
        snapshot.reserve(instances_.size());
        for (const auto& [id, inst] : instances_)
            snapshot.push_back(inst);
    }
    const auto now = std::chrono::steady_clock::now();
    for (const auto& inst : snapshot) {
        if (!inst->node)
            continue;
        if (inst->node->restartRequested_.exchange(false, std::memory_order_acq_rel)) {
            if (inst->state.load(std::memory_order_acquire) == PluginRuntimeState::Ok) {
                setStateAndNotify(inst, PluginRuntimeState::Timeout,
                                  "missed 3 consecutive audio deadlines");
                queueRestart(inst->id);
            }
        }
        const int lat = inst->node->latencySamples();
        if (lat != inst->lastNotifiedLatency) {
            inst->lastNotifiedLatency = lat;
            LatencyCallback cb;
            {
                std::lock_guard<std::mutex> lk(cbMutex_);
                cb = latencyCb_;
            }
            if (cb)
                cb(inst->id, lat);
        }
        if (inst->state.load(std::memory_order_acquire) == PluginRuntimeState::Ok) {
            bool capture = false;
            {
                std::lock_guard<std::mutex> lk(inst->dataMutex);
                if (now - inst->lastChunkCapture >= kChunkCaptureInterval) {
                    inst->lastChunkCapture = now;
                    capture = true;
                }
            }
            if (capture)
                queueJob([this, id = inst->id] { captureChunkJob(id); });
        }
    }
}

// ===========================================================================
// Worker thread
// ===========================================================================

void HostProcessManager::queueJob(std::function<void()> job) {
    {
        std::lock_guard<std::mutex> lk(jobMutex_);
        if (stopWorker_)
            return;
        jobs_.push_back(std::move(job));
    }
    jobCv_.notify_one();
}

void HostProcessManager::workerLoop() {
    for (;;) {
        std::function<void()> job;
        {
            std::unique_lock<std::mutex> lk(jobMutex_);
            jobCv_.wait(lk, [this] { return stopWorker_ || !jobs_.empty(); });
            if (stopWorker_)
                return;
            job = std::move(jobs_.front());
            jobs_.pop_front();
        }
        job();
    }
}

} // namespace mydaw
