// MyDAW — App.h (E9)
// Engine composition root: owns every long-lived module (SPEC §7 ownership), wires the
// EngineContext, runs the main-thread job loop (mutex+cv queue, 5 ms tick) and the
// periodic timers (autosave, event/transport 20 Hz, event/meters 15 Hz, host pump 30 Hz,
// MIDI-recorder pump 50 Hz, export progress). Constructed and driven by main.cpp.
//
// Threading: init()/run() and every module-mutating helper are MAIN thread. post()/
// postAndWait()/spawnWorker()/broadcastEvent()/requestStop()/requestGraphRebuild() are
// thread-safe. Heavy headers under concurrent construction (core/AudioGraph.h,
// core/Metronome.h, audio/DriverManager.h) are forward-declared here and included only
// in App.cpp, so every other TU compiles independently of them.

#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "EngineContext.h"
#include "Settings.h"
#include "audio/IAudioDriver.h" // AudioConfig
#include "core/GraphNode.h"     // RtRing<ParamMsg>
#include "core/Meters.h"
#include "core/TempoMap.h"
#include "core/Transport.h"
#include "media/AssetStore.h"
#include "media/AudioRecorder.h"
#include "midi/MidiInput.h"
#include "midi/MidiRecorder.h"
#include "plugins/Blacklist.h"
#include "plugins/PluginRegistry.h"
#include "plugins/PluginScanner.h"
#include "project/Autosave.h"
#include "project/Commands.h"
#include "project/Model.h"
#include "project/ProjectIO.h"
#include "project/UndoStack.h"
#include "server/EventBus.h"
#include "server/HttpWsServer.h"
#include "util/Json.h"

namespace mydaw {

class Api;                // server/Api.h (E9)
class McpServer;          // server/McpServer.h (embedded MCP over /mcp)
class AudioGraph;         // core/AudioGraph.h (E2, concurrent)
class DriverManager;      // audio/DriverManager.h (E1, concurrent)
class HostProcessManager;    // plugins/HostProcess.h (E7)
class BuiltinEffectManager;  // core/effects/BuiltinEffectManager.h (in-engine stock effects)
class Metronome;          // core/Metronome.h (E2, concurrent)

// Command-line options (SPEC §3 + E9 brief).
struct AppOptions {
    int port = 8417;
    bool portExplicit = false; // true when --port was passed (CLI wins over settings)
    std::string driver;      // "wasapi" | "asio" | "null" override ("" = settings)
    std::string uiRoot;      // --ui-root override
    std::string host32Path;  // --host32-path
    std::string host64Path;  // --host64-path
    std::string projectPath; // --project: load after startup
    bool noBrowser = false;  // --no-browser
    // --exit-when-idle: child "new window" instances self-terminate a short while after
    // their last browser tab disconnects (and skip autosave/crash-recovery on the shared
    // %APPDATA% so they never clobber the primary instance). The primary never sets this.
    bool exitWhenIdle = false;
};

class App {
public:
    explicit App(AppOptions options);
    ~App(); // out-of-line: unique_ptr members of forward-declared types

    App(const App&) = delete;
    App& operator=(const App&) = delete;

    // Constructs/wires every module in dependency order, opens the audio stream and
    // starts the HTTP/WS server. False + err on fatal failure (port in use, ...).
    bool init(std::string& err);

    // Main-thread job/timer loop; returns the process exit code after shutdown.
    int run();

    // Thread-safe; the loop exits, runs a clean shutdown and run() returns.
    void requestStop();

    // ----- MIDI control surface / learn (SPEC §5.2) --------------------------
    // Arm learn for `paramRef` (the next incoming CC binds to it); "" clears the arm.
    void setMidiLearnArm(std::string paramRef);
    const std::string& midiLearnArm() const { return midiLearnArm_; }
    // Remove the mapping for `paramRef` (returns true if one existed).
    bool removeMidiMap(const std::string& paramRef);
    // {maps:[{cc,channel,paramRef}], armed: string|null} — for session/hello + event/midiMaps.
    json midiMapsJson() const;
    // Feed one CC through the control path (real MIDI callback + midimap/feedCc test/OSC hook).
    void feedMidiCc(int cc, int channel, int value) { handleMidiControl(cc, channel, value); }

    // ----- job queue (thread-safe) -------------------------------------------
    void post(std::function<void()> job);
    // Runs `job` on the main thread and blocks until done (runs inline when already on
    // the main thread). False when the app is stopping.
    bool postAndWait(std::function<void()> job);
    bool isMainThread() const;
    // Detached-style worker (import/export); joined at shutdown.
    void spawnWorker(std::function<void()> fn);

    // ----- events --------------------------------------------------------------
    void broadcastEvent(const std::string& type, json payload); // thread-safe
    void broadcastTransportEvent();                             // main thread
    json transportJson() const;

    // ----- audio engine helpers (wrap the concurrently-built E1/E2 APIs) -------
    json devicesJson() const;                       // engine/getDevices payload
    json engineStatus();                            // engine/getStatus payload
    json engineHelloInfo();                         // session/hello "engine" object
    // Stops the stream, applies `cfg`, re-prepares the graph, restarts. `actualOut`
    // receives {sampleRate,bufferSize,latencyMs}.
    bool reconfigureAudio(const AudioConfig& cfg, json& actualOut, std::string& err);
    void panic();                                   // engine/panic
    // Offline render of [startSample, endSample) through the full graph (caller thread).
    bool renderRange(int64_t startSample, int64_t endSample, int blockSize,
                     const std::function<void(const float* const* ch, int numCh, int frames)>& sink,
                     std::atomic<float>* progress, std::string& err);
    // midi/preview: inject a live note on/off (channel 0) into `trackId`'s MIDI path via
    // AudioGraph::injectLiveMidi — audible while stopped and regardless of arm. Main thread.
    void previewNote(uint64_t trackId, int pitch, int velocity, bool on);
    void requestGraphRebuild(); // thread-safe, coalesced on the main loop
    int currentSampleRate() const { return currentSampleRate_; }
    AudioConfig currentAudioConfig() const { return currentConfig_; }
    // The capture endpoint the model currently needs open: the inputDevice of the first
    // armed / monitored audio track ("" model selection -> "default"), or "" when no audio
    // track wants input (capture stays closed). Main thread.
    std::string desiredCaptureDeviceId() const;
    // Open / close / repoint the WASAPI capture stream so it matches desiredCaptureDeviceId().
    // No-op when it already matches. Reconfigures the driver otherwise. Main thread.
    void reconcileCaptureDevice();

    // Spawn a detached child engine (a "new project window") on a free loopback port,
    // serving the same UI and self-exiting when its browser tab closes (--exit-when-idle).
    // Fills `port` and returns true on success. Main thread (brief; the browser tab is
    // opened by the caller once the port is serving).
    bool launchChildWindow(int& port, std::string& err);

    // ----- recording (SPEC §5.5, main thread) ----------------------------------
    bool startRecording(std::string& err); // begin recorders + Transport::record()
    void stopRecordingAndCommit();         // finalize -> internal/recording.commit
    bool isRecordingSession() const { return recordingActive_; }

    // ----- project lifecycle (main thread) -------------------------------------
    // Stops transport, swaps in an empty model, rebuilds (releasing plugin/PCM refs),
    // destroys plugin instances, clears asset cache / meters / undo.
    void prepareForModelReplace();
    // Recreates plugin instances (+ saved state chunks), syncs engine state, kicks
    // async asset loads (graph rebuilt as each finishes; peaks generated post-decode and
    // the asset record reconciled with the decoded channels/length — cpr imports guess
    // them), emits full projectChanged, clears dirty, re-arms autosave.
    void afterModelReplaced();

    // ----- export state ---------------------------------------------------------
    bool isExporting() const { return exporting_.load(std::memory_order_acquire); }
    void beginExport() { exportProgress_.store(0.0f); exporting_.store(true); }
    void endExport() { exporting_.store(false); }
    std::atomic<float>& exportProgressRef() { return exportProgress_; }

    // ----- misc ------------------------------------------------------------------
    void applySettings();           // autosave interval, plugin folders, host paths
    std::string fallbackMediaDir(); // %APPDATA%/MyDAW/media (recordings/bounces/imports
                                    // for never-saved projects); created on demand
    double cpuPercent();            // process CPU% normalized by core count

    // ----- modules (public composition surface for Api; main thread unless the
    //        individual module documents otherwise) ------------------------------
    AppOptions opts;
    Settings settings;
    EventBus eventBus;
    Model model;
    UndoStack undoStack{model};
    AssetStore assetStore;
    TempoMap tempoMap;
    Transport transport{tempoMap};
    Meters meters;
    PluginRegistry registry;
    Blacklist blacklist;
    PluginScanner scanner{registry, blacklist}; // preloads plugin cache; no boot scan
    MidiInput midiInput;
    MidiRecorder midiRecorder;
    AudioRecorder audioRecorder;
    ProjectIO projectIO; // ctor snapshots the previous run's session.lock (§6 recovery)
    Autosave autosave{model, projectIO};

    std::unique_ptr<HostProcessManager> host;
    std::unique_ptr<BuiltinEffectManager> builtin; // in-engine stock effect inserts
    std::unique_ptr<Metronome> metronome;
    std::unique_ptr<AudioGraph> graph;
    std::unique_ptr<DriverManager> driver;
    std::unique_ptr<CommandProcessor> cmd;
    std::unique_ptr<Api> api;
    std::unique_ptr<McpServer> mcp; // embedded MCP server (POST /mcp)
    HttpWsServer server;

    RtRing<ParamMsg> paramRing{4096}; // EngineContext::paramRing (drained on main loop
                                      // into AudioGraph::applyParam — see App.cpp note)
    EngineContext ctx;

    // Orphan plugin-state store (SPEC §5.6): state chunks of DORMANT inserts (imported
    // foreign-project plugins with no live host instance), keyed by instanceId. Used as the
    // state source by plugins/recreate, by App::recreatePluginInstances on load/recover, and
    // as the save/autosave fallback (written to plugin-states/<id>.bin when the host has no
    // live state to give). The entry is RETAINED for the whole session — it is NEVER erased
    // per-instance once "durable" (a live host always takes priority over it, so a kept
    // entry is harmless), because Save-As-to-a-new-dir, re-saves, undo/redo of recreate, and
    // retry all need to re-emit it from these in-RAM bytes. Dropped only on model
    // replacement (cleared wholesale). Main thread only.
    std::map<uint64_t, std::vector<uint8_t>> orphanPluginStates;

private:
    std::string midiLearnArm_; // paramRef being learned ("" = not armed); main thread only
    void handleMidiControl(int cc, int channel, int value); // main thread
    void applyMidiMap(const MidiMap& m, int value);
    void broadcastMidiMaps();

    static void audioCallback(void* user, const float* const* in, int numIn,
                              float* const* out, int numOut, int frames);

    void resolveHostPaths();
    std::string resolveUiRoot() const;
    void prepareGraphFormat(const AudioConfig& actual); // configure graph + deps
    void recreatePluginInstances();
    void wireHostCallbacks();
    void broadcastMeters();
    // event/recordingNotes — throttled in-progress MIDI take (armed track ids + live notes)
    // for real-time timeline feedback while recording. Main thread.
    void broadcastRecordingNotes();
    void shutdown();
    void joinWorkers();

    // Resolved host exe paths ("" = unavailable).
    std::string host64Path_;
    std::string host32Path_;
    AudioConfig currentConfig_;   // last requested config
    int currentSampleRate_ = 48000;
    int currentMaxBlock_ = 2048;

    // job queue
    std::thread::id mainThreadId_;
    std::mutex jobMutex_;
    std::condition_variable jobCv_;
    std::deque<std::function<void()>> jobs_;
    std::atomic<bool> stopping_{false};

    // workers (import/export)
    std::mutex workerMutex_;
    std::vector<std::thread> workers_;

    // recording session
    bool recordingActive_ = false;

    // Bumped by prepareForModelReplace (main thread): posted per-asset reconcile jobs
    // captured under an older epoch are dropped instead of mutating the NEW model
    // (asset ids restart per project, so an id lookup alone could hit a stranger).
    uint64_t modelEpoch_ = 0;

    // export
    std::atomic<bool> exporting_{false};
    std::atomic<float> exportProgress_{0.0f};

    std::atomic<bool> pendingRebuild_{false};

    // cpu meter
    uint64_t lastCpuProc_ = 0;
    std::chrono::steady_clock::time_point lastCpuWall_{};
};

} // namespace mydaw
