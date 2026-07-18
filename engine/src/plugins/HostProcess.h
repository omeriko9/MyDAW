// MyDAW — plugins/HostProcess.h (E7)
// HostProcessManager: lifecycle + control-plane owner of every out-of-process plugin
// instance (SPEC §8). One mydaw-host64/host32 process per instance:
//
//   create(instance, sr, maxBlock):
//     1. shared memory  "mydaw_<enginePid>_<instanceId>" (layout: shared/ipc/PluginIpc.h;
//        engine decides channel counts — stereo i/o in v1, instruments 0-in when the
//        attached PluginRegistry identifies the uid as an instrument),
//     2. named auto-reset events "<shm>_req" / "<shm>_done",
//     3. named-pipe JSON-RPC control channel "\\.\pipe\<shm>" (shared/ipc/Pipe.h),
//     4. spawn `mydaw-host{64|32}.exe --serve --shm <name> --pipe <path> --plugin <p>
//        --format vst2|vst3 --uid <uid> --parent-pid <pid>` (SPEC §8),
//     5. `init {sampleRate,maxBlock}` handshake -> InitInfo (latency/isInstrument fed to
//        the PluginProxyNode), restore cached params, register a kernel wait on the
//        process handle (RegisterWaitForSingleObject) for the crash flow.
//
// Crash/recovery (SPEC §8.1): host exit, host-reported fault, or 3 consecutive RT
// deadline misses transition the instance to Crashed/Timeout and schedule an async
// restart on the manager's worker thread (kill -> respawn -> init -> setState(last good
// chunk) -> restore cached params). Max 2 automatic restarts, then Failed until the user
// reloads the plugin. State transitions are reported through the state callback
// (event/pluginState semantics: ok|loading|crashed|timeout|restarting|failed).
//
// The "last good chunk" is captured opportunistically: after a successful init, after
// loadPreset, mirrored on every successful getState/setState, and refreshed every ~30 s
// by pump() (capture itself runs on the worker thread — pump never blocks).
//
// Threading:
//   * create/destroy/destroyAll      — main thread (multi-second; spawn + init are
//                                      synchronous by design, SPEC §7 command flow).
//   * control ops (getParams/setParam/getState/setState/getPresets/loadPreset/
//     openEditor/closeEditor)        — safe from the main thread (or any non-RT thread);
//                                      they block on the pipe with bounded timeouts
//                                      (state ops 10 s, openEditor 10 s, others 3 s).
//   * pump()                         — main thread, ~30 Hz: drains the shm paramOut MPSC
//                                      ring into the paramEdited callback, promotes RT
//                                      timeout requests to restarts, fires the latency
//                                      callback on change, schedules chunk captures.
//   * callbacks                      — may fire from the main thread (pump/create), the
//                                      per-instance pipe reader thread (pushes), the
//                                      manager worker thread (restarts), or a kernel
//                                      thread-pool thread (process-exit wait). They must
//                                      be cheap/thread-safe and MUST NOT call
//                                      create/destroy on the same manager synchronously.
//
// JsonRpc rule honored throughout: request() is never called from inside the pipe push
// handler (pushes only update state and fire engine callbacks).

#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "core/RtRing.h" // MpscRing
#include "util/Json.h"

namespace mydaw {

struct PluginInstance; // project/Model.h
class PluginProxyNode; // plugins/PluginProxyNode.h
class PluginRegistry;  // plugins/PluginRegistry.h (E6)

// Runtime state of one hosted plugin instance (event/pluginState, SPEC §5.6).
enum class PluginRuntimeState { Ok, Loading, Crashed, Timeout, Restarting, Failed };

// Wire name for event/pluginState: "ok"|"loading"|"crashed"|"timeout"|"restarting"|"failed".
const char* pluginRuntimeStateName(PluginRuntimeState s);

// Outcome of a recreate-path setState (a generously-timed, user-triggered restore).
// TimedOutAlive = the op exceeded even the long timeout but the host is still up — the
// insert is kept dormant and retryable (NOT a hard failure). Failed = the host rejected
// the state or died — the caller must destroy the half-spawned instance.
enum class SetStateResult { Ok, TimedOutAlive, Failed };

class HostProcessManager {
public:
    using StateCallback = std::function<void(uint64_t instanceId, PluginRuntimeState state,
                                             const std::string& message, int restartCount)>;
    using ParamEditedCallback = std::function<void(uint64_t instanceId, uint32_t paramId,
                                                   double value, const std::string& valueText)>;
    using LatencyCallback = std::function<void(uint64_t instanceId, int samples)>;

    HostProcessManager();
    ~HostProcessManager(); // stops the worker, then destroys every live instance

    HostProcessManager(const HostProcessManager&) = delete;
    HostProcessManager& operator=(const HostProcessManager&) = delete;

    // Absolute paths of mydaw-host64.exe / mydaw-host32.exe (E9 resolves per SPEC §3).
    // When host64 is unset, "<engine exe dir>\mydaw-host64.exe" is tried as a fallback;
    // an unset/missing host32 fails 32-bit creates with a clear reason.
    void setHostPaths(const std::string& host64, const std::string& host32);

    // EXTENSION (E7): optional registry attach so create() can allocate 0-input shm for
    // instruments (PluginInfo::isInstrument by uid). Without it every instance gets
    // stereo in/out — functionally fine, instruments just ignore their inputs.
    // Call once at startup, before the first create().
    void setRegistry(const PluginRegistry* registry);

    void setStateCallback(StateCallback cb);
    void setParamEditedCallback(ParamEditedCallback cb);
    void setLatencyCallback(LatencyCallback cb);

    // Spawns + initializes the host process for `instance` (instance.paramValues seeds
    // the restore cache and is applied after init; bypass/wetDry seed the node; the
    // saved state chunk is NOT loaded here — the caller reads plugin-states/<id>.bin
    // and calls setState()). Blocking, main thread. False + err on failure (no instance
    // is left registered; a failed/loading state callback pair will have fired).
    bool create(const PluginInstance& instance, int sampleRate, int maxBlock,
                std::string& err);

    // Tears the instance down: disables the RT node, waits out any in-flight processRt,
    // asks the host to quit (then kills it), closes IPC, frees the node. The caller must
    // have published a RenderPlan that no longer references node(instanceId).
    void destroy(uint64_t instanceId);

    // destroy() for every live instance (engine shutdown / project close).
    void destroyAll();

    // Current runtime state; Failed for unknown ids.
    PluginRuntimeState state(uint64_t instanceId) const;

    // True when the plugin reported a native editor in its init reply (§8.2
    // `hasEditor`: vst2 effFlagsHasEditor, vst3 createView probe). False for
    // unknown ids, before a successful init, or hosts predating the field.
    bool hasEditor(uint64_t instanceId) const;

    // RT proxy node; pointer is stable from create() until destroy() (it survives
    // restarts). nullptr for unknown ids. E2 resolves this at graph rebuild time.
    PluginProxyNode* node(uint64_t instanceId);

    // --- control ops (pipe JSON-RPC, SPEC §8.2) --------------------------------------
    // getParams/getPresets return the json ARRAY from the host reply ([{id,name,label,
    // value,defaultValue,steps,valueText}] / [{id,name}]); empty array on any failure.
    json getParams(uint64_t instanceId);
    bool setParam(uint64_t instanceId, uint32_t paramId, double value);
    bool getState(uint64_t instanceId, std::vector<uint8_t>& out);
    bool setState(uint64_t instanceId, const std::vector<uint8_t>& data);
    // Recreate-path restore (plugins/recreate): generous timeout for slow soundbank loads;
    // distinguishes a still-alive timeout (retry) from a host death/rejection (destroy).
    // `err` is filled on TimedOutAlive/Failed.
    SetStateResult setStateForRecreate(uint64_t instanceId,
                                       const std::vector<uint8_t>& data, std::string& err);
    json getPresets(uint64_t instanceId);
    bool loadPreset(uint64_t instanceId, int presetId);
    // On failure `errOut` (when given) receives the host's real error text
    // (e.g. "plugin does not provide an editor view"), or a transport reason.
    bool openEditor(uint64_t instanceId, std::string* errOut = nullptr);
    bool closeEditor(uint64_t instanceId);

    // Main thread, ~30 Hz (E9 main loop). See threading notes above.
    void pump();

private:
    struct Instance;
    struct RpcLink;
    struct ExitWaitCtx;
    struct ParamOutMsg {
        uint64_t instanceId = 0;
        uint32_t paramId = 0;
        float value = 0.0f;
    };
    friend class PluginProxyNode; // pushes ParamOutMsg from processRt()

    std::shared_ptr<Instance> findInstance(uint64_t instanceId) const;

    // Lifecycle internals. spawnAndInit/teardownIpc run with inst->lifeMutex held.
    bool spawnAndInit(Instance& inst, std::string& err);
    void teardownIpc(Instance& inst, uint32_t processGraceMs);
    void setStateAndNotify(const std::shared_ptr<Instance>& inst, PluginRuntimeState s,
                           const std::string& message);

    // Crash flow.
    static void __stdcall onHostExit(void* context, unsigned char timedOut);
    void handleHostExit(uint64_t instanceId, uint64_t spawnGen);
    void queueRestart(uint64_t instanceId);
    void restartJob(uint64_t instanceId);
    void captureChunkJob(uint64_t instanceId);

    // Pipe push dispatch (reader thread).
    void handlePush(uint64_t instanceId, const std::string& type, const json& payload);

    // Sends `type` to the instance's host and returns true only when the host replied
    // with ok:true within timeoutMs. reply receives the full envelope.
    bool requestOnInstance(uint64_t instanceId, const char* type, const json& payload,
                           json& reply, uint32_t timeoutMs);

    bool isInstrumentUid(const std::string& uid) const;
    std::string hostExeFor(int bitness, std::string& err) const;

    void queueJob(std::function<void()> job);
    void workerLoop();

    uint32_t enginePid_ = 0;

    mutable std::mutex mapMutex_;
    std::unordered_map<uint64_t, std::shared_ptr<Instance>> instances_;

    std::mutex cbMutex_;
    StateCallback stateCb_;
    ParamEditedCallback paramEditedCb_;
    LatencyCallback latencyCb_;

    mutable std::mutex pathMutex_;
    std::string host64Path_;
    std::string host32Path_;
    std::atomic<const PluginRegistry*> registry_{nullptr};

    // shm paramOut (native-editor edits) -> pump(). MPSC: the RT thread and the
    // offline-render thread can both produce (for different instances) concurrently.
    MpscRing<ParamOutMsg> paramOutRing_{8192};

    // Worker thread: restarts + chunk captures (never the main thread, never RT).
    std::atomic<bool> shuttingDown_{false};
    std::thread worker_;
    std::mutex jobMutex_;
    std::condition_variable jobCv_;
    std::deque<std::function<void()>> jobs_;
    bool stopWorker_ = false; // guarded by jobMutex_
};

} // namespace mydaw
