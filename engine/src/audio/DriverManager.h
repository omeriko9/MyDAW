// MyDAW — audio/DriverManager.h (E1)
// Owns the audio backends (WASAPI / ASIO / Null) and the active stream (SPEC §5.4/§7).
//
// open() fallback chain: the requested driver/device -> WASAPI with the same config ->
// WASAPI default device (shared mode) -> NullDriver (real-time clock, discards output),
// so the engine always has a clock. Fallbacks are logged + broadcast as event/log.
//
// Device invalidation: the active driver's error callback fires (non-RT driver thread);
// the manager restarts on the default WASAPI device from a short-lived detached thread
// (never from inside the driver callback itself) and broadcasts event/log.
//
// devicesJson() returns the exact engine/getDevices payload (SPEC §5.4):
//   {drivers:[{type:"wasapi"|"asio", available, reason?, devices:[{id,name,isDefault,
//    maxInputs,maxOutputs,sampleRates:[]}]}]}
// — ASIO is listed available:false with the honest build reason until the SDK-backed
// driver is enabled (stub policy §10).
//
// Threading: all public methods are non-RT (main thread or E9 helpers); internal state is
// guarded by one mutex. The audio callback itself goes straight from the driver to the
// engine callback registered at open() — the manager is not on the RT path.

#pragma once

#include <atomic>
#include <mutex>
#include <string>

#include "audio/AsioDriver.h"
#include "audio/IAudioDriver.h"
#include "audio/NullDriver.h"
#include "audio/WasapiDriver.h"
#include "util/Json.h"

namespace mydaw {

class EventBus;

class DriverManager {
public:
    explicit DriverManager(EventBus* bus);
    ~DriverManager();
    DriverManager(const DriverManager&) = delete;
    DriverManager& operator=(const DriverManager&) = delete;

    // Opens a stream (fallback chain above) without starting callbacks. The callback +
    // user pointer are kept for restarts/reconfigure. False + err only if even the
    // NullDriver failed (practically never).
    bool open(const AudioConfig& config, AudioCallback cb, void* user, std::string& err);

    void start();
    void stop();
    void close();

    // engine/setAudioConfig: stop + close + reopen with `config` (same fallback chain);
    // restarts callback delivery if the stream was running. False + err on total failure.
    bool reconfigure(const AudioConfig& config, std::string& err);

    // engine/getDevices reply payload (see header comment).
    json devicesJson() const;

    AudioConfig actual() const;     // what the device granted (valid after open)
    double latencyMs() const;       // output latency of the active stream
    int xruns() const;              // cumulative since open
    bool running() const;
    DriverType activeType() const;  // Null until something is open

private:
    bool openLocked(const AudioConfig& config, std::string& err);
    void closeLocked();
    IAudioDriver* driverFor(DriverType type);
    static void onDriverErrorTramp(void* user, const char* message);
    void onDriverError(const char* message);

    EventBus* bus_ = nullptr;

    mutable std::mutex mutex_;
    mutable WasapiDriver wasapi_; // mutable: enumerate() in const devicesJson()
    mutable AsioDriver asio_;
    NullDriver null_;

    IAudioDriver* active_ = nullptr; // guarded by mutex_
    AudioCallback cb_ = nullptr;
    void* user_ = nullptr;
    AudioConfig requested_{};
    AudioConfig actual_{};
    DriverType activeType_ = DriverType::Null;
    bool wantRunning_ = false;

    std::atomic<bool> restartInFlight_{false};
};

} // namespace mydaw
