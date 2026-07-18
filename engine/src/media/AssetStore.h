// MyDAW — media/AssetStore.h (E4)
// Decoded-audio cache + import pipeline (SPEC §5.5, §7).
//
// - PcmData: float32 planar audio. The pointer returned by pcm() is STABLE until clear()
//   (entries are heap-allocated and never replaced once inserted). pcm() is NOT called on
//   the RT thread — the graph (E2) resolves PcmData* at rebuild time on the main thread.
// - loadAsync()/ensurePeaks() run heavy work on a small internal worker pool (2 threads);
//   loadAsync completion callbacks are invoked on a worker thread (or inline on the calling
//   thread when the asset is already loaded / immediately fails).
// - importFile(): decode (Media Foundation, RIFF fallback) -> linear-resample to the session
//   sample rate (SPEC §4: resample at import, never at playback) -> write a canonical 32-bit
//   float WAV under <projectDir>/audio/ -> generate peaks -> fill the Asset record.
//
// Threading: all public methods are safe to call from any non-RT thread. Internal state is
// guarded by mutex_; callbacks are never invoked while a lock is held.

#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "project/Model.h" // Asset

namespace mydaw {

// Decoded audio: float32, planar (planes[channel][frame]), planes.size() == channels.
struct PcmData {
    int channels = 0;
    int sampleRate = 0;
    int64_t frames = 0;
    std::vector<std::vector<float>> planes;
};

class AssetStore {
public:
    AssetStore();
    ~AssetStore();
    AssetStore(const AssetStore&) = delete;
    AssetStore& operator=(const AssetStore&) = delete;

    // Decoded PCM for an asset, or nullptr if not loaded. Pointer is stable until clear().
    // Main/worker threads only (NOT RT — the graph resolves these at rebuild time).
    const PcmData* pcm(uint64_t assetId) const noexcept;

    // Decode the asset's file on a worker thread (resampled to Asset.sampleRate if the
    // source differs, e.g. after a relink) and cache it. `done(true)` once available
    // (called immediately if already cached), `done(false)` on failure (missing file,
    // decode error, or the store was clear()ed mid-load). Concurrent loads of the same
    // asset are coalesced. Callback runs on a worker thread (or inline, see above).
    void loadAsync(const Asset& asset, std::function<void(bool)> done);

    // Ensure <peaksDir>/<assetId>.pk exists AND matches the asset record, where peaksDir
    // is <projectDir>/peaks when a project dir is set, else the per-run fallback peaks
    // dir (see setFallbackDir; never-saved sessions). Generates from cached PCM (or by
    // decoding the file synchronously) when the file is missing or stale (validated
    // structurally — <id>.pk can be a leftover of an unrelated asset of this run). Also
    // records asset.channels/lengthSamples as the DECLARED values peaks are served with
    // (see readPeaks). Returns true if a valid peak file exists afterwards. Synchronous —
    // call from a worker/main thread, never RT.
    bool ensurePeaks(const Asset& asset);

    // Generation token for guarding deferred work against clear() (project switches).
    // Bumped by clear(); clear() is only ever called on the main thread.
    uint64_t generation() const;

    // As ensurePeaks(), but a no-op (returning false) when the store has been clear()ed
    // since `gen` was sampled — for worker-thread callers running after an async decode:
    // asset ids restart per model, so late work for a torn-down model must not decode or
    // write peaks under a recycled id.
    bool ensurePeaksFor(const Asset& asset, uint64_t gen);

    // Serve peak bytes for GET /api/peaks/<assetId>?lod=<n> (format: ui/src/lib/peaks.ts).
    // Returns a single-lod MPK1 blob. Looks under <projectDir>/peaks when a project dir
    // is set, else the per-run fallback peaks dir (see setFallbackDir); a missing/stale
    // file is regenerated when the asset's PCM is already loaded. Responses are parsed
    // by the client with the MODEL's channel count, so this never serves bytes
    // inconsistent with the declared channel count: it returns nullopt (HTTP 404; the
    // client evicts failures and retries) while the loaded PCM disagrees with the
    // declared count (e.g. a cpr import guessed it and the model is not reconciled yet —
    // App posts that right after decode) AND while nothing is declared at all (a bare
    // existing <id>.pk is never trusted — it can be another model's leftover).
    std::optional<std::vector<uint8_t>> readPeaks(uint64_t assetId, int lod);

    // Import an external audio file into the project (SPEC §5.5 media/import):
    // decode wav/mp3/flac/m4a/wma via Media Foundation (plain-PCM RIFF fallback for wav),
    // linear-resample to sessionSr, write canonical 32f wav as
    // <projectDir>/audio/<sanitized-name>[-<n>].wav (collision-safe), generate peaks
    // (when out.id is pre-assigned by the caller), and fill out.file (folder-relative,
    // forward slashes) / originalPath / sampleRate / channels / lengthSamples.
    // When out.id != 0 the decoded PCM is also cached so playback needs no re-decode.
    // Returns false + err on any failure. Synchronous (worker thread recommended).
    bool importFile(const std::string& absPath, const std::string& projectDir,
                    int sessionSr, Asset& out, std::string& err);

    // Project folder used to resolve Asset.file and locate peaks/. Does NOT clear the
    // cache — callers pair it with clear() on project switch.
    void setProjectDir(const std::string& dir);

    // Fallback base dir for peaks when NO project dir is set (never-saved sessions).
    // Peaks then live in <dir>/peaks/<pid>-<startupMillis>/ — the base dir is shared
    // across runs while asset ids restart per model, so each run gets its own subdir
    // (importFile(projectDir = <dir>) writes there too) and older runs' leftovers are
    // pruned here; a recycled id can therefore never resolve to a previous session's
    // file. App wires this to fallbackMediaDir() (%APPDATA%/MyDAW/media) at startup.
    void setFallbackDir(const std::string& dir);

    // Decoded channel count / frame count of a cached asset. False when its PCM is not
    // (or no longer) cached. Any non-RT thread.
    bool decodedInfo(uint64_t assetId, int& channels, int64_t& frames) const;

    // Drop all cached PCM (invalidates every pointer previously returned by pcm() — the
    // caller must have rebuilt/stopped the graph first) and fail pending loads.
    void clear();

private:
    bool enqueue(std::function<void()> task);
    void workerLoop();
    // Absolute path of the asset's audio file: projectDir-relative Asset.file first,
    // falling back to Asset.originalPath; "" if neither exists (missing file).
    std::string resolveSourcePath(const Asset& asset) const;
    // Peaks directory per the projectDir_/fallbackDir_ policy ("" when neither is set).
    // mutex_ must be held.
    std::string peaksDirLocked() const;
    // <fallbackDir_>/peaks/<fallbackRunToken_> — the per-run fallback peaks dir.
    // mutex_ must be held; fallbackDir_ must be non-empty.
    std::string fallbackPeaksDirLocked() const;

    mutable std::mutex mutex_;
    std::string projectDir_;
    std::string fallbackDir_; // peaks base for never-saved sessions ("" = none)
    std::string fallbackRunToken_; // "<pid>-<startupMillis>" — set by setFallbackDir
    // shared_ptr (not unique_ptr) so ensurePeaks/readPeaks can keep the PCM alive across
    // a concurrent clear() while generating peaks; pcm() raw pointers keep the documented
    // stable-until-clear() contract (entries are never replaced once inserted).
    std::map<uint64_t, std::shared_ptr<PcmData>> pcmById_;
    std::map<uint64_t, int> channelsById_;   // DECLARED (model-record) channel counts
    std::map<uint64_t, int64_t> framesById_; // DECLARED (model-record) lengths in samples
    std::map<uint64_t, std::vector<std::function<void(bool)>>> inflight_;
    uint64_t generation_ = 0; // bumped by clear(); stale loads are discarded

    std::mutex taskMutex_;
    std::condition_variable taskCv_;
    std::deque<std::function<void()>> tasks_;
    bool stop_ = false;
    std::vector<std::thread> workers_;
};

} // namespace mydaw
