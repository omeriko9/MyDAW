// MyDAW — project/Commands.h (E3)
// CommandProcessor: the single entry point for every mutating `cmd/*` message of SPEC
// §5.2-§5.3 (+ plugin commands §5.6, bounce/freeze §5.5, internal/recording.commit) and
// edit/undo / edit/redo. Main thread ONLY (SPEC §7).
//
// Flow per non-transient command: validate -> snapshot before -> mutate model -> snapshot
// after -> push UndoEntry -> apply engine side effects (ParamMsg fast path for
// param-only changes; AudioGraph::rebuild for structural ones) -> broadcast granular
// event/projectChanged (§5.8) + event/dirty. Transient commands (envelope
// "transient":true) apply to model + ParamMsg only: no undo entry, no broadcasts; the
// first transient of a gesture snapshots the project so the closing non-transient
// commit's undo entry reverts the whole drag (gestureBefore_).

#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "core/GraphNode.h" // ParamMsg / ParamRing (lock-free param fast path, SPEC §7)
#include "core/TempoMap.h"
#include "project/Model.h"
#include "util/Json.h"

namespace mydaw {

struct EngineContext;
class HostProcessManager;   // plugins/HostProcess.h (E7) — not part of EngineContext
class BuiltinEffectManager; // core/effects/BuiltinEffectManager.h — in-engine stock effects
class ProjectIO;
struct UndoEntry;

class CommandProcessor {
public:
    explicit CommandProcessor(EngineContext& ctx);

    // Executes `type` with `payload`. Returns the reply payload (json object). On
    // failure returns a null json and fills errCode/errMsg (errCode examples:
    // "unknown_command", "not_found", "bad_request", "routing_cycle",
    // "plugin_load_failed", "nothing_to_undo"). Main thread only.
    json execute(const std::string& type, const json& payload, bool transient,
                 std::string& errCode, std::string& errMsg);

    // Executes 1..64 catalog-approved cmd/* operations as one atomic model change.
    // Individual dispatches do not rebuild, broadcast, or push undo; success performs
    // those side effects once and returns {label, revision, results}. A failed step
    // restores the exact pre-batch project and live plugin topology. Later payloads may
    // reference an earlier aliased reply with
    // {"$result":"alias","pointer":"/json/pointer"}.
    json executeBatch(const json& payload, std::string& errCode, std::string& errMsg);

    // ----- wiring (E9, once at startup; everything tolerates null) -----------
    void setHostProcessManager(HostProcessManager* h) { host_ = h; }
    void setBuiltinManager(BuiltinEffectManager* b) { builtin_ = b; }
    void setProjectIO(ProjectIO* io) { projectIO_ = io; }
    // App-level orphan plugin-state store (SPEC §5.6): plugins/recreate (and undo/redo
    // reconcile) restore a recreated instance's state from here (falling back to stateFile
    // bytes). The entry is RETAINED for the whole session — never erased per-instance — so
    // re-save / Save-As-to-a-new-dir / retry / redo-of-recreate can all re-emit it. Dropped
    // only when the model is replaced.
    void setOrphanStates(std::map<uint64_t, std::vector<uint8_t>>* m) { orphanStates_ = m; }
    // Session audio format used when creating plugin host processes (defaults
    // 48000/2048; E9 updates on driver (re)start).
    void setAudioFormat(int sampleRate, int maxBlock);

    // cmd/track.bounce / freeze render hook, injected by E9: render `trackId` solo'd
    // offline over beats [0, endBeat] (SPEC: freeze renders from beat 0 so playback
    // offset is 0), write the wav under <projectDir>/audio/, fill every field of `out`
    // except `id`, return true. On false, `err` carries the reason.
    std::function<bool(uint64_t trackId, double endBeat, Asset& out, std::string& err)>
        bounceRenderHook;

    // PCM → asset hook, injected by E9: write planar float `planes` (session rate) to a wav
    // under the project audio dir, fill every field of `out` except `id`, return true. Used by
    // cmd/clip.stretch to persist a stretched/transposed derivative.
    std::function<bool(const std::vector<std::vector<float>>& planes, const std::string& baseName,
                       Asset& out, std::string& err)>
        pcmToAssetHook;

    // Injected by E9: reconcile the open WASAPI capture stream against the model's armed /
    // monitored audio tracks (opens capture on the selected input device, closes it when
    // nothing needs it). Called after a track's recordArm / monitor / inputDevice changes so
    // arming a track actually turns the microphone on. Null-tolerant.
    std::function<void()> captureReconcileHook;

    // ----- helpers for E9 -----------------------------------------------------
    uint64_t revision() const { return revision_; }
    // Bumps revision and broadcasts {scope:"project", full:<Project>} — used after
    // project load/new/recover (and internally after undo/redo).
    void emitFullProjectChanged();
    // Re-applies model-derived engine state: TempoMap maps, Transport loop region,
    // solo-in-place effective mutes (ParamMsg), AudioGraph::rebuild. Used after
    // load/recover and internally after undo/redo.
    void syncEngineFromModel();

    // plugins/recreate (SPEC §5.6): resolve dormant inserts against the registry and spawn
    // live hosts. A successful resolve mutates the model (inserts gain a path + a live node),
    // so it is UNDOABLE: it pushes one undo entry mirroring cmd/plugin.add (before/after
    // snapshot + the restored state chunk). reconcilePlugins is liveness+identity aware, so
    // undo tears the recreated node back down (insert returns to unresolved) and redo
    // recreates it with state — the undo stack can never leave a live host wired while the
    // model says dormant. A FAILED recreate mutates nothing and pushes no entry. It rebuilds
    // the graph, broadcasts a granular event/projectChanged for the affected tracks, and
    // marks the project dirty. The orphan-state entry is KEPT (durable fallback for re-save /
    // Save-As / retry / redo). Returns {results:[{instanceId, ok, error?}]}; fills ec/em only
    // on a whole-op precondition failure (no host / no registry).
    json recreatePlugins(const json& p, std::string& ec, std::string& em);

private:
    // Per-command result accumulator (event shape, undo label, side-effect flags).
    struct CmdResult {
        std::string errCode;
        std::string errMsg;
        std::string label;       // undo label; "" -> command type used
        bool mutated = true;     // false: nothing changed (no undo entry / events)
        bool structural = false; // AudioGraph::rebuild required
        // event/projectChanged shape (§5.8):
        bool fullEvent = false;          // scope:"project" + full snapshot
        std::string scope = "track";     // "track" | "clip" | "mixer"
        bool allTracksEvent = false;     // tracks = complete ordered list
        std::vector<uint64_t> eventTrackIds;            // subset, model order kept
        std::vector<std::pair<uint64_t, uint64_t>> eventClips; // (trackId, clipId)
        std::vector<uint64_t> removedTrackIds;
        std::vector<uint64_t> removedClipIds;
        // plugin chunks captured for instances created/destroyed by this command
        std::map<uint64_t, std::vector<uint8_t>> pluginChunks;

        json fail(const char* code, const std::string& msg) {
            errCode = code;
            errMsg = msg;
            return json();
        }
    };

    json dispatch(const std::string& type, const json& p, bool transient, CmdResult& r);

    // §5.2 tracks
    json trackAdd(const json& p, CmdResult& r);
    json trackRemove(const json& p, CmdResult& r);
    json trackReorder(const json& p, CmdResult& r);
    json trackSet(const json& p, bool transient, CmdResult& r);
    json trackSetEq(const json& p, bool transient, CmdResult& r);
    json trackAddSend(const json& p, CmdResult& r);
    json trackRemoveSend(const json& p, CmdResult& r);
    json trackSetSend(const json& p, bool transient, CmdResult& r);
    json trackBounce(const json& p, CmdResult& r);
    json trackUnfreeze(const json& p, CmdResult& r);
    json trackDuplicate(const json& p, CmdResult& r);
    // §5.3 clips / notes / automation / arrangement
    json clipAddMidi(const json& p, CmdResult& r);
    json clipAddAudio(const json& p, CmdResult& r);
    json clipMove(const json& p, CmdResult& r);
    json clipResize(const json& p, CmdResult& r);
    json clipStretch(const json& p, CmdResult& r);
    json clipProcessAudio(const json& p, CmdResult& r);
    json clipSplit(const json& p, CmdResult& r);
    json clipJoin(const json& p, CmdResult& r);
    json clipDelete(const json& p, CmdResult& r);
    json clipDuplicate(const json& p, CmdResult& r);
    json clipSet(const json& p, CmdResult& r);
    json notesEdit(const json& p, CmdResult& r);
    json notesQuantize(const json& p, CmdResult& r);
    json ccEdit(const json& p, CmdResult& r);
    json automationSet(const json& p, CmdResult& r);
    json automationRamp(const json& p, CmdResult& r);
    json automationClear(const json& p, CmdResult& r);
    json markerAdd(const json& p, CmdResult& r);
    json markerSet(const json& p, CmdResult& r);
    json markerRemove(const json& p, CmdResult& r);
    json tempoSet(const json& p, CmdResult& r);
    json timesigSet(const json& p, CmdResult& r);
    json tempoMapSet(const json& p, CmdResult& r);
    json timeSigMapSet(const json& p, CmdResult& r);
    json loopSet(const json& p, CmdResult& r);
    json gridSet(const json& p, CmdResult& r);
    // §5.6 plugins
    json pluginAdd(const json& p, CmdResult& r);
    json pluginRemove(const json& p, CmdResult& r);
    json pluginMove(const json& p, CmdResult& r);
    json pluginSet(const json& p, bool transient, CmdResult& r);
    json pluginSetParam(const json& p, bool transient, CmdResult& r);
    json pluginSetSample(const json& p, CmdResult& r);
    json vcaAdd(const json& p, CmdResult& r);
    json vcaRemove(const json& p, CmdResult& r);
    json vcaSet(const json& p, bool transient, CmdResult& r);
    // §5.3 comping (take folders)
    json takeCreate(const json& p, CmdResult& r);
    json takeSetComp(const json& p, CmdResult& r);
    json takeFlatten(const json& p, CmdResult& r);
    // §5.3 track versions
    json versionAdd(const json& p, CmdResult& r);
    json versionSwitch(const json& p, CmdResult& r);
    json versionRename(const json& p, CmdResult& r);
    json versionDelete(const json& p, CmdResult& r);
    // internal
    json recordingCommit(const json& p, CmdResult& r);
    json handleUndoRedo(bool isRedo, std::string& errCode, std::string& errMsg);

    // ----- side effects ---------------------------------------------------------
    Model& model();
    const TempoMap& tm(); // ctx_.tempoMap or a model-synced local fallback
    void pushParam(const ParamMsg& m);
    void pushEffectiveMutes();
    void rebuildGraph();
    void broadcastChanges(const CmdResult& r);
    void markDirty();
    bool reconcilePlugins(const std::map<uint64_t, PluginInstance>& before,
                          const UndoEntry* entry, std::string* error = nullptr);
    // Re-applies a just-created instance's saved state + cached params. Priority: the
    // undo-entry chunk (if any) -> the App orphan store -> the saved stateFile bytes (only
    // when projectIO has a path). The orphan entry is a kept session fallback.
    bool restorePluginState(const PluginInstance& pi, const UndoEntry* entry,
                            std::string* error = nullptr);
    // Snapshot replacement must supersede both pending main-thread ParamMsgs and any
    // fast-path values already queued inside AudioGraph.
    void drainPendingParams();
    void restoreLiveControls(
        const std::map<uint64_t, PluginInstance>& controlsBefore,
        const std::set<uint64_t>& eqTrackIds);

    // Create/destroy an insert's live RT node, routing built-in effects to the in-engine
    // manager and everything else to the out-of-process host. False + err on failure.
    bool createInsertNode(const PluginInstance& pi, std::string& err);
    void destroyInsertNode(uint64_t instanceId);

    // Automation write (SPEC §5.4): if the transport is armed + playing, record `value` into
    // trackId's `paramRef` lane at the playhead (thinning to one point per small beat window).
    // The graph rebuild that bakes the point is deferred to the gesture commit (!transient).
    void captureAutomation(uint64_t trackId, const std::string& paramRef, double value,
                           bool transient, CmdResult& r);

    EngineContext& ctx_;
    HostProcessManager* host_ = nullptr;
    BuiltinEffectManager* builtin_ = nullptr;
    ProjectIO* projectIO_ = nullptr;
    std::map<uint64_t, std::vector<uint8_t>>* orphanStates_ = nullptr;
    int sampleRate_ = 48000;
    int maxBlock_ = 2048;
    uint64_t revision_ = 0;
    TempoMap localTm_; // fallback when ctx_.tempoMap is not wired (tests)
    // Project snapshot taken at the FIRST transient command of a drag gesture; the
    // gesture's final non-transient commit uses it as the undo "before" so one undo
    // reverts the whole drag (see execute()).
    std::optional<json> gestureBefore_;
};

} // namespace mydaw
