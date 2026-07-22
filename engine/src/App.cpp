// MyDAW — App.cpp (E9). See App.h.
//
// NOTE(spec, ParamMsg ring): EngineContext::paramRing is owned here and documented as
// "drained by the graph", but the pinned AudioGraph API receives params via
// applyParam(const ParamMsg&) and configure() takes no ring. Adaptation: the main loop
// drains ctx.paramRing and forwards each message to AudioGraph::applyParam (producer and
// consumer are both the main thread, satisfying the SPSC contract).

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include "App.h"

#include <windows.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <future>
#include <random>

#include "audio/DriverManager.h" // E1 (concurrent build)
#include "core/AudioGraph.h"     // E2 (concurrent build)
#include "core/Metronome.h"      // E2 (concurrent build)
#include "import/ImportProvider.h"
#include "media/WavWriter.h"
#include "midi/MidiEvent.h"
#include "core/effects/BuiltinEffectManager.h"
#include "plugins/HostProcess.h"
#include "server/Api.h"
#include "server/McpServer.h"
#include "util/Log.h"
#include "util/Paths.h"
#include "util/Spawn.h"

namespace mydaw {

using namespace std::chrono_literals;

namespace {

constexpr const char* kEngineVersion = "0.1.0";

bool readFileBytes(const std::string& path, std::vector<uint8_t>& out) {
    FILE* f = _wfopen(utf8ToWide(path).c_str(), L"rb");
    if (!f)
        return false;
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (size < 0) {
        std::fclose(f);
        return false;
    }
    out.resize(static_cast<size_t>(size));
    const size_t got = size > 0 ? std::fread(out.data(), 1, out.size(), f) : 0;
    std::fclose(f);
    out.resize(got);
    return true;
}

} // namespace

App::App(AppOptions options) : opts(std::move(options)) {
    mainThreadId_ = std::this_thread::get_id();
}

App::~App() = default;

// ---------------------------------------------------------------------------
// init — construct/wire modules in dependency order (E9 brief)
// ---------------------------------------------------------------------------

bool App::init(std::string& err) {
    // 1. settings (member ctor) -> eventbus (member) -> model(default, member) ->
    //    assets/transport/tempomap/meters (members).
    //    Port precedence: --port flag > settings.json "port" > 8417 default.
    if (!opts.portExplicit)
        opts.port = settings.port();

    // 2. HostProcessManager + host exe discovery (exe dir -> dev layout -> settings;
    //    CLI flags override, SPEC §3).
    host = std::make_unique<HostProcessManager>();
    builtin = std::make_unique<BuiltinEffectManager>();
    builtin->setAssetStore(&assetStore); // samplers resolve their PCM here
    resolveHostPaths();
    host->setHostPaths(host64Path_, host32Path_);
    host->setRegistry(&registry);

    // 3. MIDI input + recorder mirror wiring (E5 requirement).
    midiInput.start();
    midiRecorder.setInput(&midiInput);
    midiInput.setActivityCallback([this](const std::string& deviceId) {
        // winmm callback thread -> marshal to main (model read for trackId).
        post([this, deviceId] {
            json ev{{"deviceId", deviceId}};
            for (const Track& t : model.project.tracks) {
                const bool midiKind =
                    t.kind == TrackKind::Midi || t.kind == TrackKind::Instrument;
                // Thru follows SELECTION (midiThruTracks) + explicit monitor —
                // same predicate as AudioGraph cfg.liveMidi (spec 2026-07-22).
                if (midiKind && (midiThruTracks.count(t.id) > 0 || t.monitor) &&
                    (t.inputDevice.empty() || t.inputDevice == deviceId)) {
                    ev["trackId"] = t.id;
                    break;
                }
            }
            broadcastEvent("event/midiActivity", std::move(ev));
        });
    });
    midiInput.setControlCallback([this](const MidiEvent& e) {
        if (!e.isController())
            return;
        const int cc = e.controller();
        const int ch = e.channel();
        const int val = e.ccValue();
        post([this, cc, ch, val] { handleMidiControl(cc, ch, val); }); // winmm → main loop
    });

    // 4. Audio graph + metronome.
    metronome = std::make_unique<Metronome>();
    graph = std::make_unique<AudioGraph>();

    // 5. Driver (open with settings config, --driver override; internal fallback chain
    //    requested -> wasapi default -> null).
    driver = std::make_unique<DriverManager>(&eventBus);
    currentConfig_ = settings.audioConfig();
    if (!opts.driver.empty()) {
        DriverType t = currentConfig_.driverType;
        if (driverTypeFromString(opts.driver, t))
            currentConfig_.driverType = t;
        else
            Log::warn("App: unknown --driver '%s' ignored", opts.driver.c_str());
    }
    if (!driver->open(currentConfig_, &App::audioCallback, this, err)) {
        err = "audio driver open failed: " + err;
        return false;
    }
    const AudioConfig actual = driver->actual();
    // Fresh default project adopts the device rate (project stores preferred SR, §4).
    model.project.sampleRate = actual.sampleRate;

    // 6. Plugin registry folders from settings (scanner member already preloaded the
    //    plugin cache in its ctor — NO boot scan, SPEC §8.3). The ctor populated the registry
    //    before the folders were known, so re-derive it now that they are: the cache remembers
    //    every file ever scanned, and folders the user has REMOVED must not come back.
    registry.setFolders(settings.pluginFoldersVst2(), settings.pluginFoldersVst3());
    registry.setBuiltins(BuiltinEffectManager::builtinPluginInfos()); // stock effects (always listed)
    scanner.refreshFromCache();
    scanner.setHostPaths(host64Path_, host32Path_);

    // 7. ProjectIO wiring + crash-recovery probe (§6).
    projectIO.setEventBus(&eventBus);
    projectIO.setHostProcessManager(host.get());
    projectIO.setAssetStore(&assetStore);
    projectIO.setOrphanStates(&orphanPluginStates);
    // Never-saved sessions (every cpr import, File > New + Import Files) have no project
    // dir — peaks then live under <fallbackMediaDir>/peaks/<pid>-<startupMillis>/ (per-run
    // subdir: asset ids restart per model, so a previous run's leftover <id>.pk must never
    // be reachable); media-import writes there too and older run dirs are pruned now.
    assetStore.setFallbackDir(fallbackMediaDir());
    {
        const ProjectIO::RecoveryInfo ri = projectIO.recoveryInfo();
        if (ri.available)
            Log::warn("App: previous session left autosave data (%s) — recovery available",
                      ri.autosavePath.c_str());
    }

    // 8. EngineContext + CommandProcessor (+ bounce/freeze render hook).
    ctx.model = &model;
    ctx.undoStack = &undoStack;
    ctx.autosave = &autosave;
    ctx.tempoMap = &tempoMap;
    ctx.transport = &transport;
    ctx.audioGraph = graph.get();
    ctx.metronome = metronome.get();
    ctx.meters = &meters;
    ctx.driverManager = driver.get();
    ctx.midiInput = &midiInput;
    ctx.midiRecorder = &midiRecorder;
    ctx.assetStore = &assetStore;
    ctx.pluginRegistry = &registry;
    ctx.pluginScanner = &scanner;
    ctx.blacklist = &blacklist;
    ctx.eventBus = &eventBus;
    ctx.server = &server;
    ctx.paramRing = &paramRing;

    cmd = std::make_unique<CommandProcessor>(ctx);
    cmd->setHostProcessManager(host.get());
    cmd->setBuiltinManager(builtin.get());
    cmd->setProjectIO(&projectIO);
    cmd->setOrphanStates(&orphanPluginStates);
    cmd->captureReconcileHook = [this] { reconcileCaptureDevice(); };
    cmd->bounceRenderHook = [this](uint64_t trackId, double endBeat, Asset& out,
                                   std::string& herr) -> bool {
        const int64_t endSample = tempoMap.beatsToSamples(std::max(endBeat, 1.0));
        const bool hasProject = projectIO.hasPath();
        const std::string dir =
            hasProject ? pathJoin(projectIO.projectDir(), "audio") : fallbackMediaDir();
        ensureDir(dir);
        std::string path;
        for (int n = 1; n < 10000; ++n) {
            char name[64];
            std::snprintf(name, sizeof(name), "bounce-%llu-%d.wav",
                          static_cast<unsigned long long>(trackId), n);
            path = pathJoin(dir, name);
            if (!fileExists(path))
                break;
        }
        WavWriter w;
        bool opened = false;
        int channels = 2;
        const int sr = currentSampleRate_;
        auto sink = [&](const float* const* ch, int numCh, int frames) {
            if (!opened) {
                std::string werr;
                opened = w.open(path, numCh, sr, 32, &werr);
                channels = numCh;
                if (!opened)
                    Log::error("bounce: %s", werr.c_str());
            }
            if (opened)
                w.appendPlanar(ch, frames);
        };
        // NOTE(pinned-api): solo-track overload assumed as trailing soloTrackId param.
        if (!graph->renderOffline(model, 0, endSample, 2048, sink, nullptr, herr, trackId)) {
            w.finalize();
            return false;
        }
        if (!opened) {
            herr = "render produced no audio";
            return false;
        }
        const int64_t frames = w.framesWritten();
        if (!w.finalize()) {
            herr = "wav write failed: " + path;
            return false;
        }
        out.file = hasProject ? ("audio/" + fileName(path)) : path;
        out.originalPath = "";
        out.sampleRate = sr;
        out.channels = channels;
        out.lengthSamples = frames;
        out.missing = false;
        return true;
    };

    // PCM → asset (cmd/clip.stretch): write planar float PCM to a wav + fill the Asset record.
    cmd->pcmToAssetHook = [this](const std::vector<std::vector<float>>& planes,
                                 const std::string& baseName, Asset& out,
                                 std::string& herr) -> bool {
        if (planes.empty() || planes[0].empty()) {
            herr = "empty pcm";
            return false;
        }
        const int channels = static_cast<int>(planes.size());
        const int64_t frames = static_cast<int64_t>(planes[0].size());
        const int sr = currentSampleRate_;
        const bool hasProject = projectIO.hasPath();
        const std::string dir =
            hasProject ? pathJoin(projectIO.projectDir(), "audio") : fallbackMediaDir();
        ensureDir(dir);
        std::string base = baseName.empty() ? std::string("stretch") : baseName;
        for (char& c : base)
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')))
                c = '_';
        std::string path;
        for (int n = 1; n < 100000; ++n) {
            char name[160];
            std::snprintf(name, sizeof(name), "%s-%d.wav", base.c_str(), n);
            path = pathJoin(dir, name);
            if (!fileExists(path))
                break;
        }
        std::vector<const float*> ptrs(static_cast<size_t>(channels));
        for (int c = 0; c < channels; ++c)
            ptrs[static_cast<size_t>(c)] = planes[static_cast<size_t>(c)].data();
        std::string werr;
        if (!WavWriter::write(path, ptrs.data(), channels, frames, sr, 32, &werr)) {
            herr = "wav write failed: " + werr;
            return false;
        }
        out.file = hasProject ? ("audio/" + fileName(path)) : path;
        out.originalPath = "";
        out.sampleRate = sr;
        out.channels = channels;
        out.lengthSamples = frames;
        out.missing = false;
        return true;
    };

    // 9. Autosave interval from settings. Child "new window" instances share the primary's
    //    %APPDATA% recovery slot, so they never autosave — they'd clobber the primary's
    //    crash-recovery data. (Explicit File > Save still works; that writes a chosen path.)
    autosave.setIntervalMinutes(opts.exitWhenIdle ? 0 : settings.autosaveMinutes());

    // 10. Graph format + initial plan, then start the stream.
    prepareGraphFormat(actual);
    cmd->syncEngineFromModel();
    wireHostCallbacks();
    driver->start();

    // 11. HTTP/WS server (ui root per SPEC §3) + protocol Api.
    registerAllImportProviders(); // project/importForeign provider registry (§5.1)
    api = std::make_unique<Api>(*this);
    server.setMessageHandler([this](json msg, HttpWsServer::RespondFn respond) {
        // server thread -> main-thread job queue
        post([this, m = std::move(msg), r = std::move(respond)]() mutable {
            api->handleMessage(m, std::move(r));
        });
    });
    server.setPeaksProvider([this](uint64_t assetId, int lod) {
        return assetStore.readPeaks(assetId, lod); // AssetStore is thread-safe
    });
    server.setUploadHandler([this](const std::vector<std::string>& files,
                                   const std::map<std::string, std::string>& query) {
        return api->handleUpload(files, query); // runs on the server thread
    });

    // Embedded MCP server (POST /mcp). Ensure a per-user bearer token exists (generated on
    // first run, stored under llm.mcpToken so agent/query redaction covers it), then route
    // each /mcp request into the main-thread job queue exactly like the WebSocket path.
    {
        const json& s = settings.get();
        const bool haveToken = s.contains("llm") && s["llm"].is_object() &&
                               s["llm"].contains("mcpToken") &&
                               s["llm"]["mcpToken"].is_string() &&
                               !s["llm"]["mcpToken"].get<std::string>().empty();
        if (!haveToken) {
            std::random_device rd;
            std::mt19937_64 gen((static_cast<uint64_t>(rd()) << 32) ^ rd());
            static const char kHex[] = "0123456789abcdef";
            std::string tok;
            tok.reserve(32);
            for (int i = 0; i < 32; ++i)
                tok.push_back(kHex[gen() & 0xF]);
            settings.set(json{{"llm", json{{"mcpToken", tok}}}});
        }
    }
    mcp = std::make_unique<McpServer>(*this);
    server.setMcpHandler([this](HttpWsServer::McpRequest req,
                                HttpWsServer::McpRespondFn respond) {
        // server thread -> main-thread job queue (async reply via respond)
        post([this, r = std::move(req), rp = std::move(respond)]() mutable {
            mcp->handle(std::move(r), std::move(rp));
        });
    });

    const std::string uiRoot = resolveUiRoot();
    if (!server.start(opts.port, uiRoot, err)) {
        err = "server start failed: " + err;
        return false;
    }
    eventBus.subscribe([this](const json& ev) { server.broadcast(ev); });
    Log::info("MyDAW engine %s — http://127.0.0.1:%d/ (ui: %s, driver: %s)", kEngineVersion,
              opts.port, uiRoot.c_str(), driverTypeToString(driver->activeType()));

    // 12. Optional --project load (after the loop starts).
    if (!opts.projectPath.empty()) {
        const std::string path = opts.projectPath;
        post([this, path] {
            prepareForModelReplace();
            std::vector<uint64_t> missing;
            std::string lerr;
            if (!projectIO.load(path, model, missing, lerr)) {
                Log::error("App: --project load failed: %s", lerr.c_str());
                std::string nerr;
                projectIO.newProject(model, nerr);
            }
            afterModelReplaced();
        });
    }
    return true;
}

// ---------------------------------------------------------------------------
// discovery helpers
// ---------------------------------------------------------------------------

void App::resolveHostPaths() {
    const std::string exe = exeDir();
    const std::string cfg = fileName(exe); // "Release"/"Debug" in the dev layout
    const std::string root = parentDir(parentDir(parentDir(exe)));
    auto resolve = [&](const std::string& cli, const char* exeName,
                       const std::string& fromSettings) -> std::string {
        if (!cli.empty()) {
            if (fileExists(cli))
                return cli;
            Log::warn("App: host path '%s' does not exist", cli.c_str());
        }
        const std::string sameDir = pathJoin(exe, exeName);
        if (fileExists(sameDir))
            return sameDir;
        // ROOT-relative dev layout: build/bin/<cfg> and build32/bin/<cfg> (SPEC §3).
        for (const char* bdir : {"build", "build32"}) {
            for (const std::string& c : {cfg, std::string("Release")}) {
                const std::string p =
                    pathJoin(pathJoin(pathJoin(pathJoin(root, bdir), "bin"), c), exeName);
                if (fileExists(p))
                    return p;
            }
        }
        if (!fromSettings.empty() && fileExists(fromSettings))
            return fromSettings;
        return "";
    };
    host64Path_ = resolve(opts.host64Path, "mydaw-host64.exe", settings.host64Path());
    host32Path_ = resolve(opts.host32Path, "mydaw-host32.exe", settings.host32Path());
    if (host64Path_.empty())
        Log::warn("App: mydaw-host64.exe not found — 64-bit plugins unavailable");
    if (host32Path_.empty())
        Log::warn("App: mydaw-host32.exe not found — 32-bit plugins unavailable");
}

std::string App::resolveUiRoot() const {
    if (!opts.uiRoot.empty())
        return opts.uiRoot;
    const std::string exe = exeDir();
    const std::string candidates[] = {
        pathJoin(exe, "..\\..\\ui\\dist"),       // SPEC §3 layout
        pathJoin(exe, "..\\..\\..\\ui\\dist"),   // build/bin/<config> dev layout
        pathJoin(exe, "ui"),                     // SPEC §3 fallback
    };
    for (const std::string& c : candidates)
        if (dirExists(c))
            return c;
    Log::warn("App: no ui/dist found near %s — serving ./ui", exe.c_str());
    return pathJoin(exe, "ui");
}

bool App::launchChildWindow(int& port, std::string& err) {
    port = findFreeLoopbackPort(err);
    if (port <= 0) {
        if (err.empty())
            err = "no free port available";
        return false;
    }
    const std::string exe = exePath();
    const std::string ui = resolveUiRoot();
    // --no-browser: the requesting UI opens the new tab itself (reliable, same window).
    // --exit-when-idle: the child self-terminates when that tab closes.
    const std::string args = "--port " + std::to_string(port) + " --ui-root \"" + ui +
                             "\" --exit-when-idle --no-browser";
    if (!launchDetached(exe, args, err))
        return false;
    Log::info("engine: launched child window on port %d", port);
    return true;
}

std::string App::fallbackMediaDir() {
    const std::string dir = pathJoin(appDataDir(), "media");
    ensureDir(dir);
    return dir;
}

// ---------------------------------------------------------------------------
// audio path
// ---------------------------------------------------------------------------

void App::audioCallback(void* user, const float* const* in, int numIn, float* const* out,
                        int numOut, int frames) {
    App* a = static_cast<App*>(user);
    a->graph->processBlock(in, numIn, out, numOut, frames, a->transport);
}

void App::prepareGraphFormat(const AudioConfig& actual) {
    currentSampleRate_ = actual.sampleRate > 0 ? actual.sampleRate : 48000;
    currentMaxBlock_ = std::max(actual.bufferSize, 2048);
    tempoMap.setSampleRate(static_cast<double>(currentSampleRate_));
    graph->configure(currentSampleRate_, currentMaxBlock_, &meters, &assetStore, host.get(),
                     builtin.get(), &midiInput, metronome.get());
    graph->setRecordTap(&audioRecorder);
    if (cmd) {
        cmd->setAudioFormat(currentSampleRate_, currentMaxBlock_);
        cmd->syncEngineFromModel(); // re-derives loop samples + rebuilds the plan
    } else {
        transport.setLoopBeats(model.project.loop.startBeat, model.project.loop.endBeat,
                               model.project.loop.enabled);
        graph->rebuild(model);
    }
}

bool App::reconfigureAudio(const AudioConfig& cfg, json& actualOut, std::string& err) {
    driver->stop();
    if (!driver->reconfigure(cfg, err)) {
        // Try to resurrect the previous configuration.
        std::string err2;
        if (driver->reconfigure(currentConfig_, err2))
            driver->start();
        return false;
    }
    currentConfig_ = cfg;
    const AudioConfig actual = driver->actual();
    prepareGraphFormat(actual);
    if (!driver->running())
        driver->start();
    actualOut = json{{"sampleRate", actual.sampleRate},
                     {"bufferSize", actual.bufferSize},
                     {"latencyMs", driver->latencyMs()}};
    return true;
}

std::string App::desiredCaptureDeviceId() const {
    // The first armed/monitored audio track picks the capture endpoint. An empty model
    // selection means "system default"; map it to the "default" sentinel so WASAPI actually
    // opens it (an empty captureDeviceId means "no capture at all").
    for (const Track& t : model.project.tracks) {
        if (t.kind != TrackKind::Audio)
            continue;
        if (!(t.recordArm || t.monitor))
            continue;
        return t.inputDevice.empty() ? std::string("default") : t.inputDevice;
    }
    return {};
}

void App::reconcileCaptureDevice() {
    const std::string desired = desiredCaptureDeviceId();
    if (desired == currentConfig_.captureDeviceId)
        return; // capture stream already matches what the model needs
    AudioConfig cfg = currentConfig_;
    cfg.captureDeviceId = desired;
    json actual;
    std::string err;
    if (!reconfigureAudio(cfg, actual, err)) {
        Log::warn("capture reconcile failed (%s) — input recording/monitoring may be silent",
                  err.c_str());
        return;
    }
    if (desired.empty())
        Log::info("capture closed (no audio track armed/monitoring)");
    else
        Log::info("capture opened on '%s'", desired.c_str());
}

json App::devicesJson() const { return driver->devicesJson(); }

json App::engineStatus() {
    const AudioConfig a = driver->actual();
    return json{{"running", driver->running()},
                {"driver", driverTypeToString(driver->activeType())},
                {"device", a.deviceId},
                {"sampleRate", a.sampleRate},
                {"bufferSize", a.bufferSize},
                {"latencyMs", driver->latencyMs()},
                {"xruns", driver->xruns()},
                {"cpuPercent", cpuPercent()},
                {"pdcSamples", graph->latencyTotal()}};
}

json App::engineHelloInfo() {
    const AudioConfig a = driver->actual();
    bool asio = false;
    const json devs = driver->devicesJson();
    if (devs.is_object() && devs.contains("drivers") && devs["drivers"].is_array())
        for (const json& d : devs["drivers"])
            if (getOr(d, "type", "") == "asio")
                asio = getOr<bool>(d, "available", false);
    return json{{"version", kEngineVersion},
                {"sampleRate", a.sampleRate},
                {"blockSize", a.bufferSize},
                {"driver", driverTypeToString(driver->activeType())},
                {"latencyMs", driver->latencyMs()},
                {"asioAvailable", asio},
                // NOTE(spec): true when the 64-bit host exe was located; per-build VST3
                // support is not introspectable from the engine in v1.
                {"vst3Available", !host64Path_.empty()}};
}

void App::panic() {
    graph->allNotesOff();
}

void App::previewNote(uint64_t trackId, int pitch, int velocity, bool on) {
    graph->injectLiveMidi(trackId, on ? MidiEvent::noteOn(0, pitch, velocity)
                                      : MidiEvent::noteOff(0, pitch));
}

void App::setMidiThruTracks(std::vector<uint64_t> trackIds) {
    midiThruTracks = std::set<uint64_t>(trackIds.begin(), trackIds.end());
    if (graph)
        graph->setMidiThruTracks(std::move(trackIds));
    requestGraphRebuild();
}

bool App::renderRange(int64_t startSample, int64_t endSample, int blockSize,
                      const std::function<void(const float* const*, int, int)>& sink,
                      std::atomic<float>* progress, std::string& err) {
    return graph->renderOffline(model, startSample, endSample, blockSize, sink, progress, err);
}

void App::requestGraphRebuild() {
    pendingRebuild_.store(true, std::memory_order_release);
    jobCv_.notify_all();
}

// ---------------------------------------------------------------------------
// host process callback relays (foreign threads -> job queue, SPEC §5.6 events)
// ---------------------------------------------------------------------------

void App::wireHostCallbacks() {
    host->setStateCallback([this](uint64_t instanceId, PluginRuntimeState state,
                                  const std::string& message, int restartCount) {
        const std::string name = pluginRuntimeStateName(state);
        post([this, instanceId, name, message, restartCount] {
            json ev{{"instanceId", instanceId},
                    {"state", name},
                    {"restartCount", restartCount}};
            if (!message.empty())
                ev["message"] = message;
            broadcastEvent("event/pluginState", std::move(ev));
        });
    });
    host->setParamEditedCallback([this](uint64_t instanceId, uint32_t paramId, double value,
                                        const std::string& valueText) {
        post([this, instanceId, paramId, value, valueText] {
            if (PluginInstance* pi = model.pluginByInstanceId(instanceId))
                pi->paramValues[paramId] = value; // mirror native-editor edits
            broadcastEvent("event/pluginParams",
                           json{{"instanceId", instanceId},
                                {"changed", json::array({json{{"id", paramId},
                                                              {"value", value},
                                                              {"valueText", valueText}}})}});
        });
    });
    host->setLatencyCallback([this](uint64_t, int) {
        requestGraphRebuild(); // PDC delay lines recomputed at rebuild (SPEC §7)
    });
}

// ---------------------------------------------------------------------------
// recording (SPEC §5.5)
// ---------------------------------------------------------------------------

bool App::startRecording(std::string& err) {
    (void)err;
    if (recordingActive_)
        return true;
    reconcileCaptureDevice(); // ensure the capture stream is open before we start tapping it
    std::vector<RecordTarget> targets;
    bool anyMidi = false;
    for (const Track& t : model.project.tracks) {
        if (!t.recordArm)
            continue;
        if (t.kind == TrackKind::Audio) {
            RecordTarget rt;
            rt.trackId = t.id;
            rt.channels = t.channels;
            rt.inputChannelOffset = t.inputChannel >= 0 ? t.inputChannel : 0;
            targets.push_back(rt);
        } else if (t.kind == TrackKind::Midi || t.kind == TrackKind::Instrument) {
            anyMidi = true;
        }
    }
    const std::string dir = projectIO.hasPath() ? projectIO.projectDir() : fallbackMediaDir();
    if (!targets.empty())
        audioRecorder.begin(targets, dir, currentSampleRate_, transport.playheadSamples());
    if (anyMidi)
        midiRecorder.begin(transport.playheadBeats()); // count-in presses clamp to start
    recordingActive_ = true;
    transport.record(); // arms count-in internally (Transport+Metronome, §5.4)
    broadcastTransportEvent();
    return true;
}

void App::broadcastRecordingNotes() {
    if (!recordingActive_ || !midiRecorder.active())
        return;
    // The take is mirrored to every armed MIDI/instrument track on commit; draw the live
    // preview on the same set.
    json trackIds = json::array();
    for (const Track& t : model.project.tracks)
        if (t.recordArm && (t.kind == TrackKind::Midi || t.kind == TrackKind::Instrument))
            trackIds.push_back(t.id);
    if (trackIds.empty())
        return;
    const double start = midiRecorder.startBeat();
    const double lenSoFar = std::max(0.0, transport.playheadBeats() - start);
    json notes = json::array();
    for (const Note& n : midiRecorder.liveNotes()) {
        // Open notes (lengthBeats 0) grow to the current playhead; clip-relative beats.
        const double len =
            n.lengthBeats > 0.0 ? n.lengthBeats : std::max(0.0, lenSoFar - n.startBeat);
        notes.push_back(json{{"pitch", n.pitch},
                             {"startBeat", n.startBeat},
                             {"lengthBeats", len},
                             {"velocity", n.velocity}});
    }
    broadcastEvent("event/recordingNotes", json{{"startBeat", start},
                                                {"lengthBeats", lenSoFar},
                                                {"trackIds", std::move(trackIds)},
                                                {"notes", std::move(notes)}});
}

void App::stopRecordingAndCommit() {
    if (!recordingActive_)
        return;
    recordingActive_ = false;

    json audioArr = json::array();
    for (const AudioRecorder::Recorded& r : audioRecorder.finalize())
        audioArr.push_back(json{{"trackId", r.trackId},
                                {"wavPath", r.wavPath},
                                {"startSample", r.startSample},
                                {"frames", r.frames}});

    json midiArr = json::array();
    if (midiRecorder.active()) {
        midiRecorder.pump(tempoMap, transport.playheadBeats()); // final drain
        const MidiRecorder::RecordedNotes rec = midiRecorder.finalize(tempoMap);
        if (!rec.notes.empty() || !rec.cc.empty()) {
            json notes = json::array();
            for (const Note& n : rec.notes)
                notes.push_back(json{{"pitch", n.pitch},
                                     {"velocity", n.velocity},
                                     {"startBeat", n.startBeat},
                                     {"lengthBeats", n.lengthBeats},
                                     {"channel", n.channel}});
            json cc = json::array();
            for (const MidiCc& e : rec.cc) // clip-relative beats, normalized values
                cc.push_back(json{{"controller", e.controller},
                                  {"beat", e.beat},
                                  {"value", e.value}});
            for (const Track& t : model.project.tracks)
                if (t.recordArm &&
                    (t.kind == TrackKind::Midi || t.kind == TrackKind::Instrument))
                    midiArr.push_back(json{{"trackId", t.id},
                                           {"startBeat", rec.startBeat},
                                           {"endBeat", rec.endBeat},
                                           {"notes", notes},
                                           {"cc", cc}});
        }
    }

    if (!audioArr.empty() || !midiArr.empty()) {
        std::string ec, em;
        cmd->execute("internal/recording.commit",
                     json{{"audio", std::move(audioArr)}, {"midi", std::move(midiArr)}},
                     false, ec, em);
        if (!ec.empty())
            Log::error("recording.commit failed: %s", em.c_str());
    }
}

// ---------------------------------------------------------------------------
// project lifecycle
// ---------------------------------------------------------------------------

void App::prepareForModelReplace() {
    ++modelEpoch_; // drop posted asset-reconcile jobs that belong to the outgoing model
    transport.stop();
    transport.locate(0.0);
    if (recordingActive_) { // discard an in-flight take
        recordingActive_ = false;
        audioRecorder.finalize();
        if (midiRecorder.active())
            midiRecorder.finalize(tempoMap);
    }
    // Publish a plan without plugin/PCM references BEFORE tearing those down
    // (HostProcessManager::destroy + AssetStore::clear contracts).
    model.project = Model::defaultProject();
    graph->rebuild(model);
    host->destroyAll();
    builtin->destroyAll();
    assetStore.clear();
    meters.clear();
    undoStack.clear();
    orphanPluginStates.clear(); // dormant-insert states belong to the outgoing model
}

void App::recreatePluginInstances() {
    // Hosted (out-of-process) creations are the slow part — count them up front so the
    // UI's loading modal (event/pluginLoadProgress) can show "N of M: <plugin>".
    int total = 0;
    for (Track* t : model.allTracks(true))
        for (PluginInstance& pi : t->inserts)
            if (pi.format != "builtin" && !pi.path.empty())
                ++total;
    int current = 0;
    for (Track* t : model.allTracks(true)) {
        for (PluginInstance& pi : t->inserts) {
            if (pi.format == "builtin") {
                // In-engine stock effect: no host process, no state chunk — params are
                // restored from pi.paramValues inside create().
                std::string berr;
                if (!builtin->create(pi, currentSampleRate_, currentMaxBlock_, berr))
                    Log::error("built-in effect '%s' failed: %s", pi.name.c_str(), berr.c_str());
                continue;
            }
            if (pi.path.empty()) {
                // Dormant insert (foreign import, plugin not resolved yet) — left for
                // project/getUnresolvedPlugins + plugins/recreate (SPEC §5.6).
                Log::info("plugin '%s' (uid %s) is dormant — use plugins/recreate",
                          pi.name.c_str(), pi.uid.c_str());
                continue;
            }
            broadcastEvent("event/pluginLoadProgress",
                           json{{"current", ++current},
                                {"total", total},
                                {"name", pi.name},
                                {"done", false}});
            std::string cerr;
            if (!host->create(pi, currentSampleRate_, currentMaxBlock_, cerr)) {
                Log::error("plugin '%s' failed to load: %s", pi.name.c_str(), cerr.c_str());
                continue; // state callback already broadcast failed (§5.6)
            }
            // State restore (SPEC §5.6): the orphan store FIRST (imported / never-saved /
            // crash-recovered foreign state — kept for the session and the authoritative
            // source with no project dir), else the saved plugin-states/<id>.bin when a
            // project dir exists to resolve stateFile against. Without the orphan-first
            // check, a no-path crash recovery (ProjectIO::recover moved the autosave .bin
            // into the orphan store and cleared stateFile) would silently lose its state.
            std::vector<uint8_t> bytes;
            const auto oit = orphanPluginStates.find(pi.instanceId);
            if (oit != orphanPluginStates.end() && !oit->second.empty()) {
                bytes = oit->second;
            } else if (!pi.stateFile.empty() && projectIO.hasPath()) {
                const std::string sp = pathJoin(projectIO.projectDir(), pi.stateFile);
                if (!readFileBytes(sp, bytes) || bytes.empty())
                    Log::warn("plugin state chunk missing: %s", sp.c_str());
            }
            if (!bytes.empty())
                host->setState(pi.instanceId, bytes);
        }
    }
    if (total > 0)
        broadcastEvent("event/pluginLoadProgress",
                       json{{"current", total}, {"total", total}, {"name", ""},
                            {"done", true}});
}

void App::afterModelReplaced() {
    if (model.project.sampleRate <= 0)
        model.project.sampleRate = currentSampleRate_;
    recreatePluginInstances();
    cmd->syncEngineFromModel(); // tempo/loop/mutes + rebuild
    // PCM arrives asynchronously; rebuild the plan as each asset becomes available so
    // TrackNodes resolve their PcmData (coalesced via pendingRebuild_). Once decoded,
    // generate peaks (AssetStore worker/main thread — never RT, SPEC §1) so cpr in-place
    // assets (file == "", originalPath set) get their .pk, and reconcile the model's
    // asset record with the decoded channel count/length: cpr imports guess them
    // (CprImportProvider falls back to stereo), and the UI parses peak payloads with the
    // MODEL's channel count — readPeaks withholds peaks until record and PCM agree.
    const uint64_t assetGen = assetStore.generation(); // clear() is main-thread only
    for (const Asset& a : model.project.assets)
        if (!a.missing)
            assetStore.loadAsync(a, [this, a, assetGen, epoch = modelEpoch_](bool ok) {
                if (!ok)
                    return;
                requestGraphRebuild();
                assetStore.ensurePeaksFor(a, assetGen); // no-op once the store is cleared
                int ch = 0;
                int64_t frames = 0;
                if (!assetStore.decodedInfo(a.id, ch, frames))
                    return; // store cleared since — the asset id belongs to another model
                if (ch == a.channels && frames == a.lengthSamples)
                    return;
                post([this, epoch, id = a.id, ch, frames] {
                    if (epoch != modelEpoch_)
                        return; // model replaced since the decode — ids are not stable
                    Asset* ma = model.assetById(id);
                    if (!ma || (ma->channels == ch && ma->lengthSamples == frames))
                        return;
                    ma->channels = ch;
                    ma->lengthSamples = frames;
                    // Re-declare the (now correct) record so readPeaks starts serving,
                    // and tell clients — they re-parse peaks with the new channel count.
                    // The record now differs from what is on disk -> dirty (Save must
                    // persist the reconciled values). Undo/redo snapshots may still
                    // carry the pre-reconcile guesses; handleUndoRedo re-imposes the
                    // decoded facts on every restored model.
                    assetStore.ensurePeaks(*ma);
                    projectIO.markDirty();
                    cmd->emitFullProjectChanged();
                });
            });
    cmd->emitFullProjectChanged();
    projectIO.clearDirty();
    autosave.resetTimer();
    broadcastTransportEvent();
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

void App::broadcastEvent(const std::string& type, json payload) {
    eventBus.broadcast(type, std::move(payload));
}

json App::transportJson() const {
    const Transport::Snapshot s = transport.snapshot();
    // PINNED CONTRACT: "metronome" {enabled, countInBars} rides in event/transport and
    // every transport/* reply (and session/hello carries the same object) — exact key
    // names; the UI metronome toggle is built against them.
    return json{{"state", transportStateToString(s.state)},
                {"beat", s.beat},
                {"timeSec", s.seconds},
                {"loop", json{{"startBeat", s.loopStartBeat},
                              {"endBeat", s.loopEndBeat},
                              {"enabled", s.loopEnabled}}},
                {"metronome", json{{"enabled", transport.metronomeEnabled()},
                                   {"countInBars", transport.countInBars()}}},
                {"automationWrite", transport.automationWrite()}};
}

void App::broadcastTransportEvent() {
    broadcastEvent("event/transport", transportJson());
}

void App::broadcastMeters() {
    std::vector<Meters::Reading> readings;
    meters.drain(readings);
    if (readings.empty())
        return;
    const uint64_t masterId = model.project.masterTrack.id;
    json tracks = json::object();
    json master = json::array({0.0f, 0.0f, 0.0f, 0.0f});
    for (const Meters::Reading& r : readings) {
        json v = json::array({r.peakL, r.peakR, r.rmsL, r.rmsR});
        if (r.trackId == masterId)
            master = std::move(v);
        else
            tracks[std::to_string(r.trackId)] = std::move(v);
    }
    broadcastEvent("event/meters", json{{"tracks", std::move(tracks)}, {"master", std::move(master)}});
}

// ---------------------------------------------------------------------------
// job queue / workers
// ---------------------------------------------------------------------------

void App::post(std::function<void()> job) {
    {
        std::lock_guard<std::mutex> lk(jobMutex_);
        jobs_.push_back(std::move(job));
    }
    jobCv_.notify_all();
}

// --- MIDI control surface / learn (SPEC §5.2) ----------------------------------------------
void App::handleMidiControl(int cc, int channel, int value) {
    if (!midiLearnArm_.empty()) {
        MidiMap mm;
        mm.cc = cc;
        mm.channel = -1; // learn binds to any channel
        mm.paramRef = midiLearnArm_;
        auto& maps = model.project.midiMaps;
        maps.erase(std::remove_if(maps.begin(), maps.end(),
                                  [&](const MidiMap& m) { return m.paramRef == mm.paramRef; }),
                   maps.end());
        maps.push_back(std::move(mm));
        midiLearnArm_.clear();
        broadcastMidiMaps();
        return;
    }
    for (const MidiMap& m : model.project.midiMaps) {
        if (m.cc != cc)
            continue;
        if (m.channel >= 0 && m.channel != channel)
            continue;
        applyMidiMap(m, value);
    }
}

void App::applyMidiMap(const MidiMap& m, int value) {
    if (!cmd)
        return;
    const double norm = std::clamp(value / 127.0, 0.0, 1.0);
    std::string ec, em;
    if (m.paramRef.rfind("track:", 0) == 0) {
        const size_t colon = m.paramRef.find(':', 6);
        if (colon == std::string::npos)
            return;
        const uint64_t trackId = std::strtoull(m.paramRef.substr(6, colon - 6).c_str(), nullptr, 10);
        const std::string field = m.paramRef.substr(colon + 1);
        json patch;
        if (field == "volume")
            patch["volume"] = norm; // 0..1 gain (127 = 0 dB)
        else if (field == "pan")
            patch["pan"] = norm * 2.0 - 1.0; // -1..1
        else
            return;
        cmd->execute("cmd/track.set", json{{"trackId", trackId}, {"patch", patch}}, true, ec, em);
    } else if (m.paramRef.rfind("plugin:", 0) == 0) {
        const size_t colon = m.paramRef.find(':', 7);
        if (colon == std::string::npos)
            return;
        const uint64_t iid = std::strtoull(m.paramRef.substr(7, colon - 7).c_str(), nullptr, 10);
        const uint32_t pid =
            static_cast<uint32_t>(std::strtoul(m.paramRef.substr(colon + 1).c_str(), nullptr, 10));
        cmd->execute("cmd/plugin.setParam",
                     json{{"instanceId", iid}, {"paramId", pid}, {"value", norm}}, true, ec, em);
    }
}

json App::midiMapsJson() const {
    json maps = json::array();
    for (const MidiMap& m : model.project.midiMaps)
        maps.push_back(json{{"cc", m.cc}, {"channel", m.channel}, {"paramRef", m.paramRef}});
    json j{{"maps", std::move(maps)}};
    if (midiLearnArm_.empty())
        j["armed"] = nullptr;
    else
        j["armed"] = midiLearnArm_;
    return j;
}

void App::broadcastMidiMaps() { broadcastEvent("event/midiMaps", midiMapsJson()); }

void App::setMidiLearnArm(std::string paramRef) {
    midiLearnArm_ = std::move(paramRef);
    broadcastMidiMaps();
}

bool App::removeMidiMap(const std::string& paramRef) {
    auto& maps = model.project.midiMaps;
    const size_t before = maps.size();
    maps.erase(std::remove_if(maps.begin(), maps.end(),
                              [&](const MidiMap& m) { return m.paramRef == paramRef; }),
               maps.end());
    const bool removed = maps.size() != before;
    if (removed)
        broadcastMidiMaps();
    return removed;
}

bool App::postAndWait(std::function<void()> job) {
    if (isMainThread()) {
        job();
        return true;
    }
    if (stopping_.load(std::memory_order_acquire))
        return false;
    std::promise<void> done;
    std::future<void> fut = done.get_future();
    post([&job, &done] {
        job();
        done.set_value();
    });
    fut.wait(); // run() drains remaining jobs before shutdown, so this always completes
    return true;
}

bool App::isMainThread() const {
    return std::this_thread::get_id() == mainThreadId_;
}

void App::spawnWorker(std::function<void()> fn) {
    std::lock_guard<std::mutex> lk(workerMutex_);
    workers_.emplace_back(std::move(fn));
}

void App::joinWorkers() {
    std::vector<std::thread> mine;
    {
        std::lock_guard<std::mutex> lk(workerMutex_);
        mine.swap(workers_);
    }
    for (std::thread& t : mine)
        if (t.joinable())
            t.join();
}

void App::requestStop() {
    stopping_.store(true, std::memory_order_release);
    jobCv_.notify_all();
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

int App::run() {
    mainThreadId_ = std::this_thread::get_id();
    using clock = std::chrono::steady_clock;
    auto now = clock::now();
    auto lastTransport = now, lastMeters = now, lastPump = now, lastAutosave = now,
         lastMidiPump = now, lastExport = now, lastRecNotes = now;
    auto lastClientPresent = now; // for --exit-when-idle child instances
    bool everConnected = false;
    TransportState lastState = transport.state();

    while (!stopping_.load(std::memory_order_acquire)) {
        std::vector<std::function<void()>> jobs;
        {
            std::unique_lock<std::mutex> lk(jobMutex_);
            jobCv_.wait_for(lk, 5ms, [this] {
                return stopping_.load(std::memory_order_relaxed) || !jobs_.empty() ||
                       pendingRebuild_.load(std::memory_order_relaxed);
            });
            jobs.assign(std::make_move_iterator(jobs_.begin()),
                        std::make_move_iterator(jobs_.end()));
            jobs_.clear();
        }
        for (auto& j : jobs)
            j();
        if (stopping_.load(std::memory_order_acquire))
            break;

        // Param fast path: drain the engine ring into the graph (see file-top note).
        ParamMsg pm;
        while (paramRing.pop(pm))
            graph->applyParam(pm);

        if (pendingRebuild_.exchange(false, std::memory_order_acq_rel))
            graph->rebuild(model);

        now = clock::now();

        const TransportState st = transport.state();
        if (st != lastState) {
            lastState = st;
            lastTransport = now;
            broadcastTransportEvent(); // "+ on change" (§5.4)
        } else if (st != TransportState::Stopped && now - lastTransport >= 50ms) {
            lastTransport = now;
            broadcastTransportEvent(); // ~20 Hz while playing
        }

        if (now - lastMeters >= 66ms) { // ~15 Hz
            lastMeters = now;
            broadcastMeters();
        }

        if (now - lastPump >= 33ms) { // ~30 Hz
            lastPump = now;
            host->pump();
        }

        if (recordingActive_ && midiRecorder.active() && now - lastMidiPump >= 20ms) {
            lastMidiPump = now; // ~50 Hz (E5 brief)
            midiRecorder.pump(tempoMap, transport.playheadBeats());
        }

        if (recordingActive_ && midiRecorder.active() && now - lastRecNotes >= 66ms) {
            lastRecNotes = now; // ~15 Hz live take preview
            broadcastRecordingNotes();
        }

        if (now - lastAutosave >= 1s) {
            lastAutosave = now;
            autosave.tick();
        }

        // Child "new window" instances self-terminate once their browser tab goes away, so
        // closing the tab doesn't leave an orphan engine running. A longer grace before the
        // first tab ever connects covers a browser that failed to open.
        if (opts.exitWhenIdle) {
            if (server.wsClientCount() > 0) {
                everConnected = true;
                lastClientPresent = now;
            } else if (now - lastClientPresent >= (everConnected ? 15s : 45s)) {
                Log::info("engine: idle child window (no clients) — exiting");
                requestStop();
            }
        }

        if (exporting_.load(std::memory_order_acquire) && now - lastExport >= 100ms) {
            lastExport = now;
            broadcastEvent("event/exportProgress",
                           json{{"pct", 100.0 * exportProgress_.load(std::memory_order_acquire)}});
        }
    }

    // Drain remaining jobs so postAndWait() callers (server/worker threads) unblock.
    {
        std::vector<std::function<void()>> jobs;
        {
            std::lock_guard<std::mutex> lk(jobMutex_);
            jobs.assign(std::make_move_iterator(jobs_.begin()),
                        std::make_move_iterator(jobs_.end()));
            jobs_.clear();
        }
        for (auto& j : jobs)
            j();
    }

    shutdown();
    return 0;
}

void App::shutdown() {
    Log::info("App: shutting down");
    server.stop();
    if (driver) {
        driver->stop();
        driver->close();
    }
    joinWorkers(); // export/import workers
    if (recordingActive_) {
        recordingActive_ = false;
        audioRecorder.finalize(); // discard
        if (midiRecorder.active())
            midiRecorder.finalize(tempoMap);
    }
    if (host)
        host->destroyAll();
    builtin->destroyAll();
    midiInput.setActivityCallback({});
    midiInput.stop();
    projectIO.clearSessionLock(); // clean shutdown — no recovery offer next run (§6)
}

// ---------------------------------------------------------------------------
// settings / misc
// ---------------------------------------------------------------------------

void App::applySettings() {
    autosave.setIntervalMinutes(settings.autosaveMinutes());
    registry.setFolders(settings.pluginFoldersVst2(), settings.pluginFoldersVst3());
    resolveHostPaths();
    host->setHostPaths(host64Path_, host32Path_);
    scanner.setHostPaths(host64Path_, host32Path_);
}

double App::cpuPercent() {
    FILETIME c{}, e{}, k{}, u{};
    if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u))
        return 0.0;
    auto toU64 = [](const FILETIME& f) {
        return (static_cast<uint64_t>(f.dwHighDateTime) << 32) | f.dwLowDateTime;
    };
    const uint64_t proc = toU64(k) + toU64(u); // 100 ns units
    const auto now = std::chrono::steady_clock::now();
    if (lastCpuProc_ == 0) {
        lastCpuProc_ = proc;
        lastCpuWall_ = now;
        return 0.0;
    }
    const double dProc = static_cast<double>(proc - lastCpuProc_) / 1e7;
    const double dWall = std::chrono::duration<double>(now - lastCpuWall_).count();
    lastCpuProc_ = proc;
    lastCpuWall_ = now;
    if (dWall <= 0.0)
        return 0.0;
    const unsigned cores = std::max(1u, std::thread::hardware_concurrency());
    return std::clamp(100.0 * dProc / dWall / cores, 0.0, 100.0);
}

} // namespace mydaw
