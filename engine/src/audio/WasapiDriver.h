// MyDAW — audio/WasapiDriver.h (E1)
// WASAPI driver (SPEC §5.4/§7):
//   - IMMDeviceEnumerator enumeration of render AND capture endpoints (friendly names,
//     default flags, probed sample-rate list). enumerate() returns render endpoints
//     followed by capture endpoints (render: maxOutputs>0, capture: maxInputs>0); the ids
//     are the IMMDevice id strings (UTF-8).
//   - Shared-mode event-driven render with AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
//     SRC_DEFAULT_QUALITY, so ANY requested session sample rate works (the OS converts).
//   - Optional exclusive mode: tries float32 / int32 / 24-in-32 / packed 24 / int16 at the
//     requested rate and falls back gracefully to shared mode with a recorded reason
//     (openFallbackInfo()).
//   - Engine always sees non-interleaved float32, a fixed block of actualConfig().bufferSize
//     frames per callback (a small single-threaded FIFO decouples the engine quantum from
//     the variable device-buffer fill); the driver converts to the device format
//     (16/24/32-bit int + float handled).
//   - RT thread: MMCSS AvSetMmThreadCharacteristics("Pro Audio") + FTZ/DAZ (_mm_setcsr).
//   - Xrun detection: render event timeout, empty-buffer (full drain) heuristic, capture
//     AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.
//   - Device invalidation (AUDCLNT_E_DEVICE_INVALIDATED & friends) -> the error callback
//     fires once from a dedicated (non-RT) fault thread; DriverManager then restarts on the
//     default device.
//
// Capture: opened only when AudioConfig.captureDeviceId is non-empty.
//   NOTE(spec): "" means "no capture" (the engine opens capture only while a track is
//   armed/monitoring, §7); the sentinel "default" selects the default capture endpoint;
//   anything else is a capture endpoint id from enumerate(). Capture runs shared-mode
//   event-driven at the session rate (AUTOCONVERTPCM) on its own thread and feeds the
//   render thread through a lock-free SPSC ring. Clock drift between the two devices is
//   handled by zero-filling on ring underflow and dropping on ring overflow (see .cpp).
//
// Threading: open/start/stop/close on non-RT threads (DriverManager). One open() per
// close(). The instance is reusable (open/close cycles).

#pragma once

#include "audio/IAudioDriver.h"

#include <memory>

namespace mydaw {

class WasapiDriver final : public IAudioDriver {
public:
    WasapiDriver();
    ~WasapiDriver() override;

    WasapiDriver(const WasapiDriver&) = delete;
    WasapiDriver& operator=(const WasapiDriver&) = delete;

    DriverType type() const override { return DriverType::Wasapi; }
    bool isAvailable(std::string* reasonOut = nullptr) const override;

    // Render endpoints followed by capture endpoints (see header comment).
    std::vector<DeviceInfo> enumerate() override;
    // Convenience splits (E9: output picker / per-track input pickers).
    std::vector<DeviceInfo> enumerateRender();
    std::vector<DeviceInfo> enumerateCapture();

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

    // Non-empty when open() succeeded but deviated from the request (exclusive->shared
    // fallback, capture unavailable, sample-rate adjustments). For logs/UI.
    std::string openFallbackInfo() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace mydaw
