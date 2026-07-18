// MyDAW — audio/IAudioDriver.h
// Audio driver contract (SPEC §7). Implementations: WasapiDriver, AsioDriver (behind
// MYDAW_HAVE_ASIO), NullDriver (headless/CI, real clock, discards output) — all E1.
// DriverManager (E1) owns the active driver and exposes the §5.4 device listing.
//
// RT contract: the driver invokes AudioCallback on its own RT thread. The callback is a
// plain function pointer (+ user data) — NO std::function on the RT path. Buffers are
// non-interleaved float32, one pointer per channel, valid for `frames` samples.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mydaw {

enum class DriverType { Wasapi, Asio, Null };

inline const char* driverTypeToString(DriverType t) {
    switch (t) {
        case DriverType::Wasapi: return "wasapi";
        case DriverType::Asio:   return "asio";
        case DriverType::Null:   return "null";
    }
    return "wasapi";
}

inline bool driverTypeFromString(const std::string& s, DriverType& out) {
    if (s == "wasapi") { out = DriverType::Wasapi; return true; }
    if (s == "asio")   { out = DriverType::Asio; return true; }
    if (s == "null")   { out = DriverType::Null; return true; }
    return false;
}

// engine/setAudioConfig payload + persisted audio settings.
struct AudioConfig {
    DriverType driverType = DriverType::Wasapi;
    std::string deviceId;      // render/output device id ("" = system default)
    int sampleRate = 48000;
    int bufferSize = 512;      // frames per callback (requested; see actualConfig())
    bool exclusive = false;    // WASAPI exclusive mode
    // NOTE(spec): capture device is not part of §5.4 setAudioConfig; the engine opens
    // capture only while a track is armed/monitoring (§7). "" = default capture device.
    std::string captureDeviceId;
};

// One device as reported by engine/getDevices (SPEC §5.4).
struct DeviceInfo {
    std::string id;
    std::string name;
    bool isDefault = false;
    int maxInputs = 0;
    int maxOutputs = 0;
    std::vector<int> sampleRates; // supported rates, e.g. {44100, 48000, ...}
};

// RT audio callback. in/out are arrays of channel pointers (non-interleaved float32).
// numIn == 0 / in == nullptr when no capture is open. Implementations must call this on
// exactly one RT thread at a time.
using AudioCallback = void (*)(void* user,
                               const float* const* in, int numIn,
                               float* const* out, int numOut,
                               int frames);

// Driver fault notification (device invalidated, stream died, ...). Invoked from a
// non-RT driver thread; the engine reacts by restarting / falling back to the default
// device (§7) and emitting event/log.
using AudioErrorCallback = void (*)(void* user, const char* message);

class IAudioDriver {
public:
    virtual ~IAudioDriver() = default;

    virtual DriverType type() const = 0;

    // Driver-level availability for the §5.4 listing. Returns false with a human-readable
    // reason (e.g. "built without ASIO SDK") when this backend cannot be used.
    virtual bool isAvailable(std::string* reasonOut = nullptr) const = 0;

    // Enumerates devices for this backend. Non-RT. Empty when unavailable.
    virtual std::vector<DeviceInfo> enumerate() = 0;

    // Opens a stream with (as close as possible to) `config`. Does not start callbacks.
    // Non-RT. Returns false and fills errorOut on failure. Re-opening requires close().
    virtual bool open(const AudioConfig& config, AudioCallback callback, void* user,
                      std::string* errorOut = nullptr) = 0;

    // Starts/stops callback delivery. start() after open(); stop() blocks until the RT
    // thread has exited the callback. Non-RT.
    virtual bool start() = 0;
    virtual void stop() = 0;

    // Releases the device. Implies stop(). Non-RT.
    virtual void close() = 0;

    // Stream latency in frames (valid after open()).
    virtual int latencyFramesIn() const = 0;
    virtual int latencyFramesOut() const = 0;

    // What the device actually granted (sampleRate/bufferSize may differ from request).
    // Valid after open().
    virtual AudioConfig actualConfig() const = 0;

    // Registers the fault callback (call before start()). Pass nullptr to clear.
    virtual void setErrorCallback(AudioErrorCallback callback, void* user) = 0;

    // Cumulative xrun (glitch/underrun) count since open(), for engine/getStatus.
    virtual int xrunCount() const { return 0; }

    // True between successful start() and stop()/close()/fatal error.
    virtual bool isRunning() const = 0;
};

} // namespace mydaw
