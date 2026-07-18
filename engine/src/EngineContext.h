// MyDAW — EngineContext.h
// Composition glue: one struct of non-owning pointers to the engine's long-lived
// singletons, passed to modules so they can reference each other WITHOUT circular
// includes. Forward declarations ONLY — do not add #includes of module headers here.
//
// Ownership/lifetime: main.cpp (E9) constructs the real objects, fills one EngineContext,
// and keeps everything alive for the process lifetime. Pointers may be null during early
// startup; modules that run before full wiring must null-check. Not for RT use as a
// lookup mechanism — RT code receives the specific pointers it needs at prepare time.

#pragma once

#include <cstdint>

namespace mydaw {

// project/
class Model;
class UndoStack;     // project/UndoStack.* (E3)
class Autosave;      // project/Autosave.* (E3)
// core/
class TempoMap;
class Transport;
class AudioGraph;    // core/AudioGraph.* (E2)
class Metronome;     // core/Metronome.* (E2)
class Meters;
// audio/
class DriverManager; // audio/DriverManager.* (E1)
// midi/
class MidiInput;     // midi/MidiInput.* (E5) — manager of winmm inputs
class MidiRecorder;  // midi/MidiRecorder.* (E5)
// media/
class AssetStore;    // media/AssetStore.* (E4)
// plugins/
class PluginRegistry; // plugins/PluginRegistry.* (E6)
class PluginScanner;  // plugins/PluginScanner.* (E6)
class Blacklist;      // plugins/Blacklist.* (E6)
// server/
class EventBus;
class HttpWsServer;  // server/HttpWsServer.* (E8)
// core/GraphNode.h
template <typename T> class RtRing;
struct ParamMsg;

struct EngineContext {
    Model* model = nullptr;
    UndoStack* undoStack = nullptr;
    Autosave* autosave = nullptr;

    TempoMap* tempoMap = nullptr;
    Transport* transport = nullptr;
    AudioGraph* audioGraph = nullptr;
    Metronome* metronome = nullptr;
    Meters* meters = nullptr;

    DriverManager* driverManager = nullptr;

    MidiInput* midiInput = nullptr;
    MidiRecorder* midiRecorder = nullptr;

    AssetStore* assetStore = nullptr;

    PluginRegistry* pluginRegistry = nullptr;
    PluginScanner* pluginScanner = nullptr;
    Blacklist* blacklist = nullptr;

    EventBus* eventBus = nullptr;
    HttpWsServer* server = nullptr;

    // Main thread -> RT parameter path (SPEC §7); owned by E9, drained by the graph.
    RtRing<ParamMsg>* paramRing = nullptr;
};

} // namespace mydaw
