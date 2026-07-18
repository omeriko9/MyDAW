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

private:
    void threadMain();

    AudioConfig actual_{};
    AudioCallback callback_ = nullptr;
    void* user_ = nullptr;
    AudioErrorCallback errorCb_ = nullptr;
    void* errorUser_ = nullptr;

    // Pre-allocated output planes (stereo), zeroed each block, discarded after the callback.
    std::vector<std::vector<float>> outPlanes_;
    std::vector<float*> outPtrs_;

    std::thread thread_;
    std::atomic<bool> stopRequested_{false};
    std::atomic<bool> running_{false};
    std::atomic<int> xruns_{0};
    bool opened_ = false;
};

} // namespace mydaw
