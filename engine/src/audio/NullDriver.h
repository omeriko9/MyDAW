// MyDAW — audio/NullDriver.h (E1)
// Headless/CI audio driver (SPEC §11): paces the engine callback in real time with a
// high-resolution waitable timer (CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, falling back to a
// plain waitable timer on older Windows), delivers zero inputs (numIn = 0) and discards the
// rendered output. Selected via `--driver null` and used as the last entry of the
// DriverManager fallback chain so the engine always has a clock.
//
// Threading: open/start/stop/close are non-RT (DriverManager threads). The callback runs on
// one dedicated driver thread; the loop allocates nothing and takes no locks (FTZ/DAZ set).
// Pacing: absolute QPC deadlines (deadline += period) so timer jitter does not accumulate;
// if the thread falls behind by more than one period an xrun is counted, and behind more
// than four periods the deadline resyncs to "now" (drops the missed blocks instead of
// bursting to catch up).

#pragma once

#include "audio/IAudioDriver.h"

#include <atomic>
#include <thread>
#include <vector>

namespace mydaw {

class NullDriver final : public IAudioDriver {
public:
    NullDriver();
    ~NullDriver() override;

    NullDriver(const NullDriver&) = delete;
    NullDriver& operator=(const NullDriver&) = delete;

    DriverType type() const override { return DriverType::Null; }
    bool isAvailable(std::string* reasonOut = nullptr) const override;
    std::vector<DeviceInfo> enumerate() override;
    bool open(const AudioConfig& config, AudioCallback callback, void* user,
              std::string* errorOut = nullptr) override;
    bool start() override;
    void stop() override;
    void close() override;
    int latencyFramesIn() const override;
    int latencyFramesOut() const override;
    AudioConfig actualConfig() const override;
    void setErrorCallback(AudioErrorCallback callback, void* user) override;
    int xrunCount() const override;
    bool isRunning() const override;

    /**
     * Synthesize `channels` capture channels instead of reporting none (`--null-input N`).
     * OPT-IN ONLY: default 0, so a user who falls back to the null driver never gets
     * phantom input. Must be called before open() — enumerate() reports it as maxInputs,
     * which is what makes the engine open a capture path at all.
     *
     * The signal is a 1 Hz sawtooth over [-1, 1), i.e. period == sampleRate frames, and
     * that choice is the whole point: it is POSITION-RECOVERABLE. From any captured sample
     * you can recover the absolute frame index modulo one second, so a test can assert
     * WHICH samples were recorded, not merely that something was. Sample-accurate punch
     * in/out cannot be tested against a signal you cannot locate yourself in. Channel c is
     * the same ramp scaled by 1/(c+1), so channels are told apart by amplitude.
     *
     * Multi-endpoint (2026-08-07): with test input on, TWO capture devices exist —
     * "null" (default; also matched by "default") carrying the ramp, and "null-b"
     * carrying the NEGATED ramp, so a two-device recording test can prove per-device
     * routing (which file got which device's signal). Any other requested capture id
     * fails to open, exactly like a device that is not there — which is what makes the
     * unavailable-device honesty path testable headlessly.
     */
    void setTestInput(int channels);

private:
    void threadMain();
    /** RT: fill inPlanes_ with the ramp for [frame, frame+n). Allocation- and lock-free. */
    void fillTestInput(int64_t frame, int n) noexcept;

    // Which synthetic devices open() actually granted, in slot order ("null" / "null-b").
    // Drives fillTestInput's sign per slot and actual_.captureSlots.
    std::vector<bool> slotIsB_;

    AudioConfig actual_{};
    AudioCallback callback_ = nullptr;
    void* user_ = nullptr;
    AudioErrorCallback errorCb_ = nullptr;
    void* errorUser_ = nullptr;

    // Pre-allocated output planes (stereo), zeroed each block, discarded after the callback.
    std::vector<std::vector<float>> outPlanes_;
    std::vector<float*> outPtrs_;

    // Synthetic capture (opt-in, see setTestInput). Planes are pre-allocated in open() so
    // the callback thread only writes into them.
    int testInputChannels_ = 0;
    std::vector<std::vector<float>> inPlanes_;
    std::vector<float*> inPtrs_;
    int64_t inFrame_ = 0; // absolute frames since start(), driver-thread only

    std::thread thread_;
    std::atomic<bool> stopRequested_{false};
    std::atomic<bool> running_{false};
    std::atomic<int> xruns_{0};
    bool opened_ = false;
};

} // namespace mydaw
