// MyDAW — media/AudioRecorder.cpp (E4)
// SPSC capture ring (RT producer) -> worker drain -> streaming 32f WavWriters.
// See AudioRecorder.h for the lifecycle/threading contract.

#include "media/AudioRecorder.h"

#include "core/RtRing.h" // detail::ceilPow2
#include "util/Log.h"
#include "util/Paths.h"

#include <algorithm>
#include <cstring>

namespace mydaw {

namespace {
constexpr int kMaxRingChannels = 32;
constexpr int kMaxTargetChannels = 8;
} // namespace

AudioRecorder::~AudioRecorder() {
    if (isActive() || worker_.joinable())
        (void)finalize();
}

void AudioRecorder::begin(const std::vector<RecordTarget>& targets,
                          const std::string& projectDir, int sampleRate,
                          int64_t startSample) {
    if (isActive() || worker_.joinable()) {
        Log::warn("AudioRecorder: begin() while a session is active — finalizing it");
        (void)finalize();
    }

    sampleRate_ = std::max(1, sampleRate);
    startSample_ = startSample;
    droppedFrames_.store(0, std::memory_order_relaxed);
    lastDropLogged_ = 0;
    lastDropLogTime_ = std::chrono::steady_clock::time_point{};
    targets_.clear();

    // Clamp targets and size the capture span (channels 0..ringChannels_ of the input).
    int needed = 1;
    int maxTargetCh = 1;
    std::vector<RecordTarget> clamped = targets;
    for (RecordTarget& t : clamped) {
        t.channels = std::clamp(t.channels, 1, kMaxTargetChannels);
        t.inputChannelOffset = std::max(0, t.inputChannelOffset);
        needed = std::max(needed, t.inputChannelOffset + t.channels);
        maxTargetCh = std::max(maxTargetCh, t.channels);
    }
    ringChannels_ = std::min(needed, kMaxRingChannels);

    // ~4 seconds of headroom (power of two frames).
    capacityFrames_ = detail::ceilPow2(
        static_cast<size_t>(std::max(sampleRate_ * 4, 65536)));
    frameMask_ = capacityFrames_ - 1;
    ring_.assign(capacityFrames_ * static_cast<size_t>(ringChannels_), 0.0f);
    chunk_.assign(kChunkFrames * static_cast<size_t>(ringChannels_), 0.0f);
    planarScratch_.assign(static_cast<size_t>(maxTargetCh),
                          std::vector<float>(kChunkFrames, 0.0f));
    ptrScratch_.assign(static_cast<size_t>(maxTargetCh), nullptr);
    head_.store(0, std::memory_order_relaxed);
    tail_.store(0, std::memory_order_relaxed);

    // One streaming 32f wav per target: <projectDir>/audio/rec-<n>.wav (SPEC §5.5),
    // collision-safe across sessions and within this one.
    const std::string audioDir = pathJoin(projectDir, "audio");
    if (!ensureDir(audioDir))
        Log::error("AudioRecorder: cannot create '%s' — recording will produce no files",
                   audioDir.c_str());
    int n = 1;
    for (const RecordTarget& t : clamped) {
        TargetState ts;
        ts.target = t;
        std::string path;
        for (;; ++n) {
            path = pathJoin(audioDir, "rec-" + std::to_string(n) + ".wav");
            if (!fileExists(path))
                break;
        }
        ++n; // next target starts after this name
        auto writer = std::make_unique<WavWriter>();
        std::string err;
        if (writer->open(path, t.channels, sampleRate_, 32, &err)) {
            ts.writer = std::move(writer);
            ts.wavPath = path;
        } else {
            Log::error("AudioRecorder: %s — track %llu will not be recorded",
                       err.c_str(), static_cast<unsigned long long>(t.trackId));
        }
        targets_.push_back(std::move(ts));
    }

    stopWorker_.store(false, std::memory_order_release);
    worker_ = std::thread(&AudioRecorder::workerLoop, this);
    active_.store(true, std::memory_order_release);
    Log::info("AudioRecorder: session started (%d target(s), %d capture ch, start %lld)",
              static_cast<int>(targets_.size()), ringChannels_,
              static_cast<long long>(startSample_));
}

void AudioRecorder::pushFromRt(const float* const* in, int numIn, int frames,
                               int64_t /*playheadSamples*/) noexcept {
    if (!active_.load(std::memory_order_acquire) || frames <= 0 || ringChannels_ <= 0)
        return;

    const uint64_t h = head_.load(std::memory_order_relaxed);
    const uint64_t t = tail_.load(std::memory_order_acquire);
    if (static_cast<size_t>(h - t) + static_cast<size_t>(frames) > capacityFrames_) {
        // Overrun: drop the whole block and count it (worker logs, never the RT thread).
        droppedFrames_.fetch_add(frames, std::memory_order_relaxed);
        return;
    }

    const int rc = ringChannels_;
    for (int f = 0; f < frames; ++f) {
        float* dst =
            &ring_[(static_cast<size_t>(h + static_cast<uint64_t>(f)) & frameMask_) *
                   static_cast<size_t>(rc)];
        for (int c = 0; c < rc; ++c)
            dst[c] = (in && c < numIn && in[c]) ? in[c][f] : 0.0f;
    }
    head_.store(h + static_cast<uint64_t>(frames), std::memory_order_release);
}

size_t AudioRecorder::drainOnce() {
    const uint64_t t = tail_.load(std::memory_order_relaxed);
    const uint64_t h = head_.load(std::memory_order_acquire);
    const size_t avail = static_cast<size_t>(h - t);
    if (avail == 0)
        return 0;
    const size_t n = std::min(avail, kChunkFrames);
    const size_t rc = static_cast<size_t>(ringChannels_);

    for (size_t f = 0; f < n; ++f) {
        const size_t idx =
            (static_cast<size_t>(t + static_cast<uint64_t>(f)) & frameMask_) * rc;
        std::memcpy(&chunk_[f * rc], &ring_[idx], rc * sizeof(float));
    }
    tail_.store(t + static_cast<uint64_t>(n), std::memory_order_release);

    for (TargetState& ts : targets_) {
        if (!ts.writer)
            continue;
        const int ch = ts.target.channels;
        const int off = ts.target.inputChannelOffset;
        for (int c = 0; c < ch; ++c) {
            float* dst = planarScratch_[static_cast<size_t>(c)].data();
            const size_t srcC = static_cast<size_t>(std::min(off + c, ringChannels_ - 1));
            const float* src = &chunk_[srcC];
            if (off + c < ringChannels_) {
                for (size_t f = 0; f < n; ++f)
                    dst[f] = src[f * rc];
            } else {
                std::memset(dst, 0, n * sizeof(float)); // out-of-range channel -> silence
            }
            ptrScratch_[static_cast<size_t>(c)] = dst;
        }
        ts.writer->appendPlanar(ptrScratch_.data(), static_cast<int>(n));
    }
    return n;
}

void AudioRecorder::logDropsThrottled() {
    const int64_t drops = droppedFrames_.load(std::memory_order_relaxed);
    if (drops == lastDropLogged_)
        return;
    const auto now = std::chrono::steady_clock::now();
    if (lastDropLogTime_ != std::chrono::steady_clock::time_point{} &&
        now - lastDropLogTime_ < std::chrono::seconds(1))
        return;
    Log::warn("AudioRecorder: capture ring overrun — %lld frames dropped so far",
              static_cast<long long>(drops));
    lastDropLogged_ = drops;
    lastDropLogTime_ = now;
}

void AudioRecorder::workerLoop() {
    for (;;) {
        const size_t n = drainOnce();
        logDropsThrottled();
        if (n == 0) {
            if (stopWorker_.load(std::memory_order_acquire))
                return;
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    }
}

std::vector<AudioRecorder::Recorded> AudioRecorder::finalize() {
    std::vector<Recorded> out;
    if (!worker_.joinable() && targets_.empty())
        return out;

    active_.store(false, std::memory_order_release); // stop accepting RT pushes first
    stopWorker_.store(true, std::memory_order_release);
    if (worker_.joinable())
        worker_.join();
    while (drainOnce() > 0) { // catch anything the worker left behind
    }

    for (TargetState& ts : targets_) {
        if (!ts.writer)
            continue;
        Recorded r;
        r.trackId = ts.target.trackId;
        r.wavPath = ts.wavPath;
        r.startSample = startSample_;
        r.frames = ts.writer->framesWritten();
        if (ts.writer->finalize())
            out.push_back(std::move(r));
        else
            Log::error("AudioRecorder: failed to finalize '%s' — recording discarded",
                       ts.wavPath.c_str());
    }
    targets_.clear();

    const int64_t drops = droppedFrames_.load(std::memory_order_relaxed);
    if (drops > 0)
        Log::warn("AudioRecorder: session ended with %lld dropped frames (ring overrun)",
                  static_cast<long long>(drops));
    Log::info("AudioRecorder: session finalized (%d file(s))",
              static_cast<int>(out.size()));
    return out;
}

} // namespace mydaw
