// MyDAW — media/AssetStore.cpp (E4)
// Decoded-audio cache, async loads, peak serving, and the import pipeline.
// See AssetStore.h for the threading/lifetime contract.

#include "media/AssetStore.h"

#include "media/Decoder.h"
#include "media/PeakFile.h"
#include "media/WavWriter.h"
#include "util/Log.h"
#include "util/Paths.h"
#include "util/Strings.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <process.h> // _getpid

namespace mydaw {

namespace {

constexpr int kNumWorkers = 2;

bool isAbsolutePath(const std::string& p) {
    if (p.size() >= 2 && p[1] == ':')
        return true; // C:\...
    if (p.size() >= 2 && (p[0] == '\\' || p[0] == '/') && (p[1] == '\\' || p[1] == '/'))
        return true; // UNC
    return false;
}

// Sanitized base name for the canonical wav: keep [A-Za-z0-9 ._()-], strip the source
// extension, cap the length, never empty.
std::string sanitizeBaseName(const std::string& srcFileName) {
    std::string base = srcFileName;
    const std::string ext = fileExtension(base);
    if (!ext.empty() && base.size() > ext.size())
        base = base.substr(0, base.size() - ext.size());
    std::string out;
    out.reserve(base.size());
    for (char c : base) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (std::isalnum(u) || c == ' ' || c == '.' || c == '_' || c == '-' ||
            c == '(' || c == ')')
            out.push_back(c);
        else
            out.push_back('_');
    }
    out = trim(out);
    while (!out.empty() && out.back() == '.')
        out.pop_back(); // no trailing dots on Windows
    if (out.size() > 64)
        out.resize(64);
    if (out.empty())
        out = "audio";
    return out;
}

bool readFileBytes(const std::string& path, std::vector<uint8_t>& out) {
    FILE* f = _wfopen(utf8ToWide(path).c_str(), L"rb");
    if (!f)
        return false;
    _fseeki64(f, 0, SEEK_END);
    const int64_t size = _ftelli64(f);
    if (size < 0 || size > (int64_t(1) << 31)) { // peaks are small; 2 GiB sanity cap
        std::fclose(f);
        return false;
    }
    _fseeki64(f, 0, SEEK_SET);
    out.resize(static_cast<size_t>(size));
    const bool ok = size == 0 || std::fread(out.data(), 1, out.size(), f) == out.size();
    std::fclose(f);
    return ok;
}

uint32_t rdU32le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

// True when `path` is a complete MPK1 peak file consistent with `channels`/`frames`
// (frames <= 0 = unknown -> that check is skipped). The format does not store the
// channel count (ui/src/lib/peaks.ts is normative), so staleness — a leftover <id>.pk
// of an unrelated asset, or a file generated before an imported model's guessed channel
// count was corrected — can only be detected structurally: canonical lod table, payloads
// sized by `channels`, bucket counts implied by `frames`, no trailing bytes. Never trust
// mere existence: with channels <= 0 the layout is not checkable, so the file is NOT
// trusted (readPeaks then answers 404 until ensurePeaks declares the record). On success
// `bytesOut` (when non-null) receives the validated file bytes so the caller can serve
// from memory instead of re-reading a file a concurrent writer may have swapped.
bool validatePeakFile(const std::string& path, int channels, int64_t frames,
                      std::vector<uint8_t>* bytesOut = nullptr) {
    if (channels <= 0)
        return false; // layout is not checkable without a channel count
    std::vector<uint8_t> b;
    if (!readFileBytes(path, b) || b.size() < 8)
        return false;
    if (rdU32le(b.data()) != PeakFile::kMagic ||
        rdU32le(b.data() + 4) != static_cast<uint32_t>(PeakFile::kNumLods))
        return false;
    size_t off = 8;
    for (int l = 0; l < PeakFile::kNumLods; ++l) {
        if (off + 8 > b.size())
            return false;
        const uint32_t spb = rdU32le(b.data() + off);
        const uint64_t nb = rdU32le(b.data() + off + 4);
        if (spb != PeakFile::samplesPerBucket(l))
            return false;
        if (frames > 0 && nb != (static_cast<uint64_t>(frames) + spb - 1) / spb)
            return false;
        off += 8 + static_cast<size_t>(nb) * static_cast<size_t>(channels) * 2;
        if (off > b.size())
            return false;
    }
    if (off != b.size())
        return false;
    if (bytesOut)
        *bytesOut = std::move(b);
    return true;
}

// Best-effort cleanup of previous runs' leftovers under <fallbackDir>/peaks: per-run
// subdirs other than `keepToken` and loose pre-namespacing <id>.pk / *.tmp files written
// directly into the base by older builds. Peaks are pure derived data (regenerated from
// PCM on demand), so deleting another live instance's dir in the worst case only costs
// it a regenerate.
void pruneStaleFallbackPeaks(const std::string& peaksBase, const std::string& keepToken) {
    namespace fs = std::filesystem;
    std::error_code ec;
    const fs::path base = fs::path(utf8ToWide(peaksBase));
    for (fs::directory_iterator it(base, ec), end; !ec && it != end; it.increment(ec)) {
        const fs::path p = it->path();
        if (it->is_directory(ec)) {
            if (wideToUtf8(p.filename().wstring()) != keepToken)
                fs::remove_all(p, ec);
        } else {
            fs::remove(p, ec);
        }
        ec.clear();
    }
}

} // namespace

AssetStore::AssetStore() {
    workers_.reserve(kNumWorkers);
    for (int i = 0; i < kNumWorkers; ++i)
        workers_.emplace_back(&AssetStore::workerLoop, this);
}

AssetStore::~AssetStore() {
    {
        std::lock_guard<std::mutex> lock(taskMutex_);
        stop_ = true;
        // Pending tasks are dropped (their callbacks are never invoked — the engine is
        // shutting down); an in-progress decode completes before its worker exits.
        tasks_.clear();
    }
    taskCv_.notify_all();
    for (std::thread& w : workers_)
        if (w.joinable())
            w.join();
}

bool AssetStore::enqueue(std::function<void()> task) {
    {
        std::lock_guard<std::mutex> lock(taskMutex_);
        if (stop_)
            return false;
        tasks_.push_back(std::move(task));
    }
    taskCv_.notify_one();
    return true;
}

void AssetStore::workerLoop() {
    for (;;) {
        std::function<void()> task;
        {
            std::unique_lock<std::mutex> lock(taskMutex_);
            taskCv_.wait(lock, [this] { return stop_ || !tasks_.empty(); });
            if (stop_)
                return;
            task = std::move(tasks_.front());
            tasks_.pop_front();
        }
        task();
    }
}

const PcmData* AssetStore::pcm(uint64_t assetId) const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = pcmById_.find(assetId);
    return it != pcmById_.end() ? it->second.get() : nullptr;
}

std::string AssetStore::resolveSourcePath(const Asset& asset) const {
    std::string projectDir;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        projectDir = projectDir_;
    }
    if (!asset.file.empty()) {
        const std::string p = isAbsolutePath(asset.file)
                                  ? asset.file
                                  : (projectDir.empty()
                                         ? std::string()
                                         : pathJoin(projectDir, asset.file));
        if (!p.empty() && fileExists(p))
            return p;
    }
    if (!asset.originalPath.empty() && fileExists(asset.originalPath))
        return asset.originalPath;
    return {};
}

void AssetStore::loadAsync(const Asset& asset, std::function<void(bool)> done) {
    if (asset.id == 0) {
        if (done)
            done(false);
        return;
    }

    uint64_t gen = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (pcmById_.find(asset.id) != pcmById_.end()) {
            // Already cached — fall through to the immediate callback below.
        } else {
            auto it = inflight_.find(asset.id);
            if (it != inflight_.end()) {
                it->second.push_back(std::move(done));
                return; // coalesced with the load already in flight
            }
            inflight_[asset.id].push_back(std::move(done));
            gen = generation_;
            done = nullptr; // ownership moved into inflight_
        }
    }

    if (done) { // cached path
        done(true);
        return;
    }

    const Asset copy = asset;
    const bool queued = enqueue([this, copy, gen]() {
        PcmData pcm;
        std::string err;
        bool ok = false;
        const std::string src = resolveSourcePath(copy);
        if (src.empty()) {
            err = "file missing (checked project-relative path and originalPath)";
        } else {
            ok = Decoder::decodeFile(src, pcm, err);
            // Canonical assets are already at the session rate; a relinked original may
            // not be — resample to the asset's recorded rate (import policy, SPEC §4).
            if (ok && copy.sampleRate > 0 && pcm.sampleRate != copy.sampleRate)
                Decoder::resampleLinear(pcm, copy.sampleRate);
        }

        std::vector<std::function<void(bool)>> cbs;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            auto it = inflight_.find(copy.id);
            if (it != inflight_.end()) {
                cbs = std::move(it->second);
                inflight_.erase(it);
            }
            if (gen != generation_) {
                ok = false; // store was clear()ed while decoding — discard
            } else if (ok) {
                if (pcmById_.find(copy.id) == pcmById_.end())
                    pcmById_[copy.id] = std::make_shared<PcmData>(std::move(pcm));
                // channelsById_ is NOT updated here: it mirrors the MODEL's asset record
                // (via ensurePeaks), and peaks must not serve with the decoded count
                // until the model is reconciled with it (see readPeaks).
            }
        }
        if (!ok)
            Log::warn("AssetStore: load failed for asset %llu ('%s'): %s",
                      static_cast<unsigned long long>(copy.id), copy.file.c_str(),
                      err.c_str());
        for (auto& cb : cbs)
            if (cb)
                cb(ok);
    });

    if (!queued) { // shutting down
        std::vector<std::function<void(bool)>> cbs;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            auto it = inflight_.find(asset.id);
            if (it != inflight_.end()) {
                cbs = std::move(it->second);
                inflight_.erase(it);
            }
        }
        for (auto& cb : cbs)
            if (cb)
                cb(false);
    }
}

uint64_t AssetStore::generation() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return generation_;
}

bool AssetStore::ensurePeaks(const Asset& asset) {
    return ensurePeaksFor(asset, generation());
}

bool AssetStore::ensurePeaksFor(const Asset& asset, uint64_t gen) {
    if (asset.id == 0)
        return false;

    std::string pkDir;
    std::shared_ptr<const PcmData> p; // keeps PCM alive across a concurrent clear()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (gen != generation_)
            return false; // store clear()ed since `gen` — the asset's model is gone
        pkDir = peaksDirLocked();
        // Declare the MODEL-record values peaks are served with — readPeaks refuses to
        // hand out bytes the client (which parses with the model's channel count) could
        // mis-parse and cache immutably.
        if (asset.channels > 0)
            channelsById_[asset.id] = asset.channels;
        if (asset.lengthSamples > 0)
            framesById_[asset.id] = asset.lengthSamples;
        const auto it = pcmById_.find(asset.id);
        if (it != pcmById_.end())
            p = it->second;
    }
    if (pkDir.empty())
        return false; // no project dir AND no fallback dir configured

    const std::string pkPath = pathJoin(pkDir, std::to_string(asset.id) + ".pk");
    if (validatePeakFile(pkPath, asset.channels, asset.lengthSamples))
        return true;

    if (!p) {
        const std::string src = resolveSourcePath(asset);
        if (src.empty()) {
            Log::warn("AssetStore: ensurePeaks — asset %llu file missing",
                      static_cast<unsigned long long>(asset.id));
            return false;
        }
        PcmData local;
        std::string err;
        if (!Decoder::decodeFile(src, local, err)) {
            Log::warn("AssetStore: ensurePeaks — decode failed for asset %llu: %s",
                      static_cast<unsigned long long>(asset.id), err.c_str());
            return false;
        }
        if (asset.sampleRate > 0 && local.sampleRate != asset.sampleRate)
            Decoder::resampleLinear(local, asset.sampleRate);
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (gen != generation_)
                return false; // store was clear()ed while decoding — different model now
            auto it = pcmById_.find(asset.id);
            if (it == pcmById_.end())
                it = pcmById_
                         .emplace(asset.id, std::make_shared<PcmData>(std::move(local)))
                         .first;
            p = it->second;
        }
    }

    if (!ensureDir(pkDir)) {
        Log::error("AssetStore: cannot create peaks dir '%s'", pkDir.c_str());
        return false;
    }
    // Two-phase publish: serialize + write a unique temp UNLOCKED (slow), then commit
    // (a fast rename) under the SAME lock that guards generation_. clear() serializes
    // on mutex_, so the check+rename is atomic w.r.t. generation bumps and a straggler
    // can never publish a torn-down model's peaks under a recycled asset id — a bare
    // pre-write gen check would leave the whole (long) generate as a race window.
    std::vector<uint8_t> bytes;
    if (!PeakFile::serialize(*p, bytes))
        return false;
    std::string tmp;
    if (!PeakFile::writeTemp(pkPath, bytes, tmp)) {
        Log::error("PeakFile: failed to write '%s'", pkPath.c_str());
        return false;
    }
    bool committed = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (gen == generation_)
            committed = PeakFile::commitTemp(tmp, pkPath);
    }
    if (!committed)
        PeakFile::discardTemp(tmp); // gen mismatch (ids recycle per model) / rename failed
    return committed;
}

std::optional<std::vector<uint8_t>> AssetStore::readPeaks(uint64_t assetId, int lod) {
    std::string pkDir;
    int declared = 0;        // model-record channel count (via ensurePeaks)
    int64_t declaredFrames = 0;
    uint64_t gen = 0;
    std::shared_ptr<const PcmData> p; // keeps PCM alive across a concurrent clear()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        pkDir = peaksDirLocked();
        gen = generation_;
        const auto cit = channelsById_.find(assetId);
        if (cit != channelsById_.end())
            declared = cit->second;
        const auto fit = framesById_.find(assetId);
        if (fit != framesById_.end())
            declaredFrames = fit->second;
        const auto it = pcmById_.find(assetId);
        if (it != pcmById_.end())
            p = it->second;
    }
    if (pkDir.empty())
        return std::nullopt;

    // Responses are parsed by the client with the MODEL's channel count. While the
    // decoded PCM disagrees with the declared count (imported model not reconciled yet —
    // App posts the fix right after decode) answer 404; the client evicts failures and
    // retries.
    if (p && declared > 0 && p->channels != declared)
        return std::nullopt;

    // declared == 0 && !p: nothing is known about the asset yet (e.g. a cpr import
    // still decoding) — validatePeakFile refuses existence-only trust, so an existing
    // <id>.pk (possibly another model's leftover) is never served; 404 until
    // ensurePeaks declares the record.
    const int channels = p ? p->channels : declared;
    const int64_t frames = p ? p->frames : declaredFrames;
    const std::string pkPath = pathJoin(pkDir, std::to_string(assetId) + ".pk");
    std::vector<uint8_t> fileBytes;
    if (validatePeakFile(pkPath, channels, frames, &fileBytes))
        return PeakFile::sliceLod(fileBytes, lod, channels); // serve the validated bytes

    // Missing or stale (pre-reconcile leftover) — regenerate on demand when the PCM is
    // already loaded. Same two-phase publish as ensurePeaksFor: write a unique temp
    // unlocked, commit under mutex_ only while `gen` is still current (ids recycle per
    // model), and serve straight from the in-memory bytes — never re-read the file (a
    // concurrent writer for a recycled id could swap it between rename and read).
    if (!p || !ensureDir(pkDir))
        return std::nullopt;
    std::vector<uint8_t> bytes;
    if (!PeakFile::serialize(*p, bytes))
        return std::nullopt;
    std::string tmp;
    const bool wrote = PeakFile::writeTemp(pkPath, bytes, tmp); // !wrote: serve anyway
    bool current = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        current = gen == generation_;
        if (current && wrote)
            PeakFile::commitTemp(tmp, pkPath); // deletes the temp itself on failure
    }
    if (!current) {
        PeakFile::discardTemp(tmp);
        return std::nullopt; // cleared while we worked — stale asset id
    }
    return PeakFile::sliceLod(bytes, lod, channels);
}

bool AssetStore::importFile(const std::string& absPath, const std::string& projectDir,
                            int sessionSr, Asset& out, std::string& err) {
    if (projectDir.empty()) {
        err = "no project directory";
        return false;
    }

    PcmData pcm;
    if (!Decoder::decodeFile(absPath, pcm, err))
        return false;
    if (pcm.frames <= 0 || pcm.channels <= 0) {
        err = "decoded no audio from " + absPath;
        return false;
    }
    if (sessionSr > 0 && pcm.sampleRate != sessionSr)
        Decoder::resampleLinear(pcm, sessionSr); // SPEC §4: resample at import only

    const std::string audioDir = pathJoin(projectDir, "audio");
    if (!ensureDir(audioDir)) {
        err = "cannot create audio directory: " + audioDir;
        return false;
    }

    // Collision-safe canonical name: <name>.wav, then <name>-2.wav, <name>-3.wav, ...
    const std::string base = sanitizeBaseName(fileName(absPath));
    std::string fname = base + ".wav";
    for (int n = 2; fileExists(pathJoin(audioDir, fname)); ++n)
        fname = base + "-" + std::to_string(n) + ".wav";
    const std::string wavPath = pathJoin(audioDir, fname);

    std::vector<const float*> chPtrs(static_cast<size_t>(pcm.channels));
    for (int c = 0; c < pcm.channels; ++c)
        chPtrs[static_cast<size_t>(c)] = pcm.planes[static_cast<size_t>(c)].data();
    if (!WavWriter::write(wavPath, chPtrs.data(), pcm.channels, pcm.frames,
                          pcm.sampleRate, 32, &err))
        return false;

    out.file = "audio/" + fname; // folder-relative, forward slashes (SPEC §6)
    out.originalPath = absPath;
    out.sampleRate = pcm.sampleRate; // == sessionSr after resample
    out.channels = pcm.channels;
    out.lengthSamples = pcm.frames;
    out.missing = false;

    if (out.id != 0) {
        // Peaks + PCM cache keyed by the caller-assigned asset id. (With id == 0 they
        // are generated lazily later via ensurePeaks()/loadAsync().) media/import into a
        // never-saved session passes the fallback dir as projectDir — peaks must then
        // land in the per-run subdir where readPeaks looks, not the shared base.
        std::string pkDir;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            pkDir = (!fallbackDir_.empty() && projectDir == fallbackDir_)
                        ? fallbackPeaksDirLocked()
                        : pathJoin(projectDir, "peaks");
        }
        if (ensureDir(pkDir)) {
            if (!PeakFile::generate(pcm, pathJoin(pkDir, std::to_string(out.id) + ".pk")))
                Log::warn("AssetStore: peak generation failed for asset %llu (import)",
                          static_cast<unsigned long long>(out.id));
        }
        std::lock_guard<std::mutex> lock(mutex_);
        channelsById_[out.id] = pcm.channels; // == the asset record filled above
        framesById_[out.id] = out.lengthSamples;
        if (pcmById_.find(out.id) == pcmById_.end())
            pcmById_[out.id] = std::make_shared<PcmData>(std::move(pcm));
    }

    Log::info("AssetStore: imported '%s' -> '%s' (%d ch, %lld frames @ %d Hz)",
              absPath.c_str(), out.file.c_str(), out.channels,
              static_cast<long long>(out.lengthSamples), out.sampleRate);
    return true;
}

void AssetStore::setProjectDir(const std::string& dir) {
    std::lock_guard<std::mutex> lock(mutex_);
    projectDir_ = dir;
}

void AssetStore::setFallbackDir(const std::string& dir) {
    std::string token;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        fallbackDir_ = dir;
        if (fallbackRunToken_.empty()) {
            // Per-process-unique namespace for fallback peaks: the base dir is shared
            // across runs while asset ids restart per model, so without it a recycled
            // <id>.pk could resolve to a previous session's file. pid alone recycles
            // too — add the startup time.
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::system_clock::now().time_since_epoch())
                                .count();
            fallbackRunToken_ =
                std::to_string(_getpid()) + "-" + std::to_string(ms);
        }
        token = fallbackRunToken_;
    }
    if (!dir.empty())
        pruneStaleFallbackPeaks(pathJoin(dir, "peaks"), token);
}

std::string AssetStore::peaksDirLocked() const {
    if (!projectDir_.empty())
        return pathJoin(projectDir_, "peaks");
    return fallbackDir_.empty() ? std::string() : fallbackPeaksDirLocked();
}

std::string AssetStore::fallbackPeaksDirLocked() const {
    return pathJoin(pathJoin(fallbackDir_, "peaks"), fallbackRunToken_);
}

bool AssetStore::decodedInfo(uint64_t assetId, int& channels, int64_t& frames) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = pcmById_.find(assetId);
    if (it == pcmById_.end())
        return false;
    channels = it->second->channels;
    frames = it->second->frames;
    return true;
}

void AssetStore::clear() {
    std::vector<std::function<void(bool)>> cbs;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        ++generation_;
        pcmById_.clear();
        channelsById_.clear();
        framesById_.clear();
        for (auto& [id, list] : inflight_)
            for (auto& cb : list)
                cbs.push_back(std::move(cb));
        inflight_.clear();
    }
    for (auto& cb : cbs)
        if (cb)
            cb(false);
}

} // namespace mydaw
