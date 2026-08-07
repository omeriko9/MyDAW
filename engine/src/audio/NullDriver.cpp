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
// Synthetic capture is a test affordance, not a virtual interface: two channels covers
// mono and stereo arming, and the cap keeps a typo in --null-input from allocating wildly.
constexpr int kMaxTestInputChannels = 8;

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
    // Zero unless --null-input asked for a synthetic capture source: the engine opens a
    // capture path only when an endpoint advertises inputs.
    d.maxInputs = testInputChannels_;
    d.maxOutputs = kNullChannels;
    d.sampleRates = {44100, 48000, 88200, 96000, 176400, 192000};
    std::vector<DeviceInfo> out{d};
    if (testInputChannels_ > 0) {
        // Second synthetic capture device (multi-endpoint tests): negated ramp.
        DeviceInfo b;
        b.id = "null-b";
        b.name = "Null capture B (test, negated ramp)";
        b.maxInputs = testInputChannels_;
        b.maxOutputs = 0;
        b.sampleRates = d.sampleRates;
        out.push_back(b);
    }
    return out;
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
    actual_.captureSlots.clear();
    actual_.exclusive = false;
    actual_.sampleRate = std::clamp(config.sampleRate, 8000, 384000);
    // Engine blocks must respect the shm/plugin maxBlock of 2048 (SPEC §8.1).
    actual_.bufferSize = std::clamp(config.bufferSize, 32, 2048);

    outPlanes_.assign(static_cast<size_t>(kNullChannels),
                      std::vector<float>(static_cast<size_t>(actual_.bufferSize), 0.0f));
    outPtrs_.resize(static_cast<size_t>(kNullChannels));
    for (int c = 0; c < kNullChannels; ++c)
        outPtrs_[static_cast<size_t>(c)] = outPlanes_[static_cast<size_t>(c)].data();

    // Synthetic capture (multi-endpoint): grant one slot per REQUESTED id that names a
    // synthetic device ("null"/"default"/"" → ramp, "null-b" → negated ramp); anything
    // else fails to open exactly like a device that is not there. Each open device is
    // opened once (first request wins), in request order — matching the WASAPI contract.
    slotIsB_.clear();
    inPlanes_.clear();
    inPtrs_.clear();
    if (testInputChannels_ > 0) {
        bool haveA = false, haveB = false;
        for (const std::string& id : config.captureDeviceIds) {
            const bool isA = id.empty() || id == "default" || id == "null";
            const bool isB = id == "null-b";
            if ((isA && haveA) || (isB && haveB) || (!isA && !isB))
                continue; // duplicate or unknown device — unknown = unavailable
            (isA ? haveA : haveB) = true;
            actual_.captureSlots.push_back(CaptureSlot{
                id.empty() ? std::string("default") : id, testInputChannels_,
                static_cast<int>(slotIsB_.size()) * testInputChannels_});
            slotIsB_.push_back(isB);
        }
        const size_t totalCh =
            slotIsB_.size() * static_cast<size_t>(testInputChannels_);
        inPlanes_.assign(totalCh,
                         std::vector<float>(static_cast<size_t>(actual_.bufferSize), 0.0f));
        inPtrs_.resize(totalCh);
        for (size_t c = 0; c < totalCh; ++c)
            inPtrs_[c] = inPlanes_[c].data();
    }
    inFrame_ = 0;

    xruns_.store(0, std::memory_order_relaxed);
    opened_ = true;
    return true;
}

void NullDriver::setTestInput(int channels) {
    // Before open(): enumerate() has to advertise it, and the planes are sized in open().
    testInputChannels_ = std::clamp(channels, 0, kMaxTestInputChannels);
}

void NullDriver::fillTestInput(int64_t frame, int n) noexcept {
    // 1 Hz sawtooth over [-1, 1): period == sampleRate, so the phase of any captured
    // sample identifies its absolute frame index modulo one second. That is what makes a
    // sample-accurate punch assertion possible — a periodic tone would not. Slot "null-b"
    // carries the NEGATED ramp so a per-device routing test can tell devices apart.
    const int64_t period = actual_.sampleRate > 0 ? actual_.sampleRate : 48000;
    const float inv = 2.0f / static_cast<float>(period);
    for (size_t slot = 0; slot < slotIsB_.size(); ++slot) {
        const float sign = slotIsB_[slot] ? -1.0f : 1.0f;
        for (int c = 0; c < testInputChannels_; ++c) {
            float* dst =
                inPlanes_[slot * static_cast<size_t>(testInputChannels_) +
                          static_cast<size_t>(c)]
                    .data();
            const float scale =
                sign / static_cast<float>(c + 1); // channel identity by amplitude
            for (int i = 0; i < n; ++i) {
                const int64_t k = (frame + i) % period;
                dst[i] = (static_cast<float>(k) * inv - 1.0f) * scale;
            }
        }
    }
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
        if (!inPtrs_.empty()) {
            fillTestInput(inFrame_, block);
            inFrame_ += block;
            callback_(user_, inPtrs_.data(), static_cast<int>(inPtrs_.size()),
                      outPtrs_.data(), kNullChannels, block);
        } else {
            callback_(user_, nullptr, 0, outPtrs_.data(), kNullChannels, block);
        }
        // Output discarded.
    }

    if (timer)
        CloseHandle(timer);
}

} // namespace mydaw
