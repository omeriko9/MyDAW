// MyDAW — media/AudioRecorder.h (E4)
// Audio capture sink (SPEC §5.5/§7): the RT driver callback pushes capture frames via
// pushFromRt() into a pre-allocated SPSC ring (interleaved float frames, lock-free,
// allocation-free); a worker thread drains the ring and streams each armed track's
// channel slice (RecordTarget.inputChannelOffset .. +channels) to its own 32f WAV under
// <projectDir>/audio/rec-<n>.wav. finalize() closes the files and reports what was
// recorded (fed to E3's "internal/recording.commit").
//
// Lifecycle/threading contract:
//   main thread:  begin(...) -> [E2 sets the record tap; RT pushes] -> finalize()
//   RT thread:    pushFromRt() — only effective between begin() and finalize()
//                 (guarded by an atomic; a block racing finalize() is dropped, never UB —
//                 the ring storage stays allocated until the next begin()/destruction).
// Ring overrun (worker too slow / disk stall): the whole block is dropped and counted;
// the worker logs a throttled warning (never logs on the RT thread).

#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "media/WavWriter.h"

namespace mydaw {

struct RecordTarget {
    uint64_t trackId = 0;
    int channels = 1;          // 1 | 2 (clamped to a sane range)
    int inputChannelOffset = 0; // first capture channel for this track
};

class AudioRecorder {
public:
    struct Recorded {
        uint64_t trackId = 0;
        std::string wavPath; // absolute path of the written wav
        int64_t startSample = 0;
        int64_t frames = 0;
    };

    AudioRecorder() = default;
    ~AudioRecorder(); // finalize()s an active session (results discarded)
    AudioRecorder(const AudioRecorder&) = delete;
    AudioRecorder& operator=(const AudioRecorder&) = delete;

    // Start a recording session. Allocates the ring, opens one streaming 32f WavWriter
    // per target (collision-safe audio/rec-<n>.wav) and starts the drain worker.
    // Main thread; must not race pushFromRt (arm the RT tap only after begin returns).
    void begin(const std::vector<RecordTarget>& targets, const std::string& projectDir,
               int sampleRate, int64_t startSample);

    // RT driver callback: append `frames` frames of the capture buffer (planar, numIn
    // channels; missing channels are zero-filled). Lock-free, allocation-free; drops the
    // block (counted) when the ring is full or no session is active.
    void pushFromRt(const float* const* in, int numIn, int frames,
                    int64_t playheadSamples) noexcept;

    // Stop the session: drain the ring, close the WAVs, return what was recorded.
    // Returns an empty list when no session is active. Main thread.
    std::vector<Recorded> finalize();

    bool isActive() const noexcept { return active_.load(std::memory_order_acquire); }
    int64_t droppedFrames() const noexcept {
        return droppedFrames_.load(std::memory_order_relaxed);
    }

private:
    struct TargetState {
        RecordTarget target;
        std::unique_ptr<WavWriter> writer; // null if the file failed to open
        std::string wavPath;
    };

    void workerLoop();
    size_t drainOnce(); // worker / post-join only; returns frames consumed
    void logDropsThrottled();

    static constexpr size_t kChunkFrames = 4096;

    std::vector<TargetState> targets_;
    int sampleRate_ = 0;
    int64_t startSample_ = 0;
    int ringChannels_ = 0;
    size_t capacityFrames_ = 0; // power of two
    size_t frameMask_ = 0;
    std::vector<float> ring_; // capacityFrames_ * ringChannels_ interleaved floats

    alignas(64) std::atomic<uint64_t> head_{0}; // written by RT producer (frames)
    alignas(64) std::atomic<uint64_t> tail_{0}; // written by worker consumer (frames)
    std::atomic<bool> active_{false};
    std::atomic<bool> stopWorker_{false};
    std::atomic<int64_t> droppedFrames_{0};

    std::thread worker_;
    std::vector<float> chunk_;                    // drain scratch (interleaved)
    std::vector<std::vector<float>> planarScratch_;
    std::vector<const float*> ptrScratch_;
    int64_t lastDropLogged_ = 0;
    std::chrono::steady_clock::time_point lastDropLogTime_{};
};

} // namespace mydaw
