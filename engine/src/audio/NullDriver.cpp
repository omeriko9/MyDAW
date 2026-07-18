// MyDAW — audio/NullDriver.cpp (E1). See NullDriver.h for the contract.

#include "audio/NullDriver.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <xmmintrin.h>

#include <algorithm>
#include <cstring>

namespace mydaw {

namespace {

constexpr int kNullChannels = 2;

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

void setError(std::string* errorOut, const char* msg) {
    if (errorOut)
        *errorOut = msg ? msg : "";
}

} // namespace

NullDriver::NullDriver() = default;

NullDriver::~NullDriver() {
    close();
}

bool NullDriver::isAvailable(std::string* reasonOut) const {
    if (reasonOut)
        reasonOut->clear();
    return true;
}

std::vector<DeviceInfo> NullDriver::enumerate() {
    DeviceInfo d;
    d.id = "null";
    d.name = "Null (silent, real-time paced)";
    d.isDefault = true;
    d.maxInputs = 0;
    d.maxOutputs = kNullChannels;
    d.sampleRates = {44100, 48000, 88200, 96000, 176400, 192000};
    return {d};
}

bool NullDriver::open(const AudioConfig& config, AudioCallback callback, void* user,
                      std::string* errorOut) {
    if (opened_) {
        setError(errorOut, "null driver already open (close() first)");
        return false;
    }
    if (!callback) {
        setError(errorOut, "null driver: no audio callback supplied");
        return false;
    }

    callback_ = callback;
    user_ = user;

    actual_ = config;
    actual_.driverType = DriverType::Null;
    actual_.deviceId = "null";
    actual_.captureDeviceId.clear();
    actual_.exclusive = false;
    actual_.sampleRate = std::clamp(config.sampleRate, 8000, 384000);
    // Engine blocks must respect the shm/plugin maxBlock of 2048 (SPEC §8.1).
    actual_.bufferSize = std::clamp(config.bufferSize, 32, 2048);

    outPlanes_.assign(static_cast<size_t>(kNullChannels),
                      std::vector<float>(static_cast<size_t>(actual_.bufferSize), 0.0f));
    outPtrs_.resize(static_cast<size_t>(kNullChannels));
    for (int c = 0; c < kNullChannels; ++c)
        outPtrs_[static_cast<size_t>(c)] = outPlanes_[static_cast<size_t>(c)].data();

    xruns_.store(0, std::memory_order_relaxed);
    opened_ = true;
    return true;
}

bool NullDriver::start() {
    if (!opened_ || running_.load(std::memory_order_acquire))
        return false;
    stopRequested_.store(false, std::memory_order_release);
    running_.store(true, std::memory_order_release);
    thread_ = std::thread(&NullDriver::threadMain, this);
    return true;
}

void NullDriver::stop() {
    stopRequested_.store(true, std::memory_order_release);
    if (thread_.joinable())
        thread_.join();
    running_.store(false, std::memory_order_release);
}

void NullDriver::close() {
    stop();
    opened_ = false;
    callback_ = nullptr;
    user_ = nullptr;
    outPlanes_.clear();
    outPtrs_.clear();
}

int NullDriver::latencyFramesIn() const {
    return 0;
}

int NullDriver::latencyFramesOut() const {
    return opened_ ? actual_.bufferSize : 0;
}

AudioConfig NullDriver::actualConfig() const {
    return actual_;
}

void NullDriver::setErrorCallback(AudioErrorCallback callback, void* user) {
    errorCb_ = callback;
    errorUser_ = user;
}

int NullDriver::xrunCount() const {
    return xruns_.load(std::memory_order_relaxed);
}

bool NullDriver::isRunning() const {
    return running_.load(std::memory_order_acquire);
}

void NullDriver::threadMain() {
    // Denormals: flush-to-zero + denormals-are-zero on this thread.
    _mm_setcsr(_mm_getcsr() | 0x8040u);

    // High-resolution waitable timer; the flag is Win10 1803+, fall back gracefully.
    HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr,
                                          CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                          TIMER_ALL_ACCESS);
    if (!timer)
        timer = CreateWaitableTimerW(nullptr, FALSE, nullptr);

    LARGE_INTEGER freq{};
    QueryPerformanceFrequency(&freq);
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);

    const int block = actual_.bufferSize;
    const int sr = actual_.sampleRate;
    const long long periodQpc =
        static_cast<long long>(static_cast<double>(block) * static_cast<double>(freq.QuadPart) /
                               static_cast<double>(sr));
    long long deadline = now.QuadPart;

    const size_t blockBytes = static_cast<size_t>(block) * sizeof(float);

    while (!stopRequested_.load(std::memory_order_acquire)) {
        deadline += periodQpc;
        QueryPerformanceCounter(&now);
        const long long behind = now.QuadPart - deadline;
        if (behind > 4 * periodQpc) {
            // Way behind real time (machine stall): drop the missed blocks, resync.
            deadline = now.QuadPart;
            xruns_.fetch_add(1, std::memory_order_relaxed);
        } else if (behind > periodQpc) {
            // Late by more than one block but recoverable: count, keep catching up.
            xruns_.fetch_add(1, std::memory_order_relaxed);
        } else if (behind < 0 && timer) {
            const long long due100ns = static_cast<long long>(
                static_cast<double>(-behind) * 1e7 / static_cast<double>(freq.QuadPart));
            if (due100ns > 0) {
                LARGE_INTEGER li;
                li.QuadPart = -due100ns; // relative
                if (SetWaitableTimer(timer, &li, 0, nullptr, nullptr, FALSE))
                    WaitForSingleObject(timer,
                                        static_cast<DWORD>(due100ns / 10000 + 50));
            }
        }
        if (stopRequested_.load(std::memory_order_acquire))
            break;

        for (auto& plane : outPlanes_)
            std::memset(plane.data(), 0, blockBytes);
        callback_(user_, nullptr, 0, outPtrs_.data(), kNullChannels, block);
        // Output discarded.
    }

    if (timer)
        CloseHandle(timer);
}

} // namespace mydaw
