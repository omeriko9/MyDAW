// MyDAW — audio/AsioDriver.h (E1)
// ASIO driver (SPEC §3/§7/§10): a COMPLETE implementation that talks the ASIO C ABI via the
// Steinberg ASIO SDK headers (iasiodrv.h), compiled ONLY when MYDAW_HAVE_ASIO is defined
// (CMake sets it when -DMYDAW_ASIO_SDK_DIR=<path> points at a local SDK copy — we never
// ship the SDK). Without the define this class still exists and reports
// isAvailable() == false with the documented reason, so the §5.4 driver listing and the
// Settings UI can grey ASIO out honestly (stub policy §10).
//
// With MYDAW_HAVE_ASIO:
//   - enumerate(): CLSID registry walk of HKLM\SOFTWARE\ASIO (Description + CLSID values).
//     Drivers are NOT instantiated during enumeration (instantiating arbitrary ASIO drivers
//     can block or crash), so maxInputs/maxOutputs/sampleRates are unknown (0/empty) until
//     open(). DeviceInfo.id is the CLSID string.
//   - open(): CoCreateInstance(IASIO) -> init -> setSampleRate (canSampleRate first; if the
//     requested rate is refused, the device's current rate is adopted and reported in
//     actualConfig()) -> getBufferSize (honors min/max/preferred/granularity, closest to the
//     request) -> createBuffers (all inputs up to 16, first 2 outputs) + bufferSwitch
//     trampoline (static active-instance pointer: ONE ASIO stream at a time) ->
//     ASIOGetLatencies. Sample types converted: Int16/Int24/Int32(+LSB16/18/20/24
//     right-justified variants)/Float32/Float64, LSB (little-endian) only — MSB devices are
//     rejected at open() with a clear error.
//   - bufferSwitch/bufferSwitchTimeInfo: convert inputs to float planes, run the engine
//     callback in chunks of <= 2048 frames (plugin shm maxBlock), convert the stereo engine
//     output to the device type, then ASIOOutputReady() when supported. FTZ/DAZ set on the
//     driver's thread.
//   - asioMessage: kAsioResetRequest / kAsioBufferSizeChange -> error callback (DriverManager
//     restarts the stream); kAsioResyncRequest / kAsioOverload -> xrun count;
//     kAsioLatenciesChanged -> re-query ASIOGetLatencies; kAsioEngineVersion -> 2;
//     kAsioSupportsTimeInfo -> 1 (bufferSwitchTimeInfo forwards to the same processing).
//   - openControlPanel(): IASIO::controlPanel() of the open driver.
//
// Threading note: ASIO drivers expect control calls (init/createBuffers/start/stop) from a
// consistent COM-initialized thread. DriverManager performs open/close from its control
// paths (main thread or its restart worker); both initialize COM. See risks in the module
// hand-off notes.

#pragma once

#include "audio/IAudioDriver.h"

#include <memory>

namespace mydaw {

class AsioDriver final : public IAudioDriver {
public:
    AsioDriver();
    ~AsioDriver() override;

    AsioDriver(const AsioDriver&) = delete;
    AsioDriver& operator=(const AsioDriver&) = delete;

    DriverType type() const override { return DriverType::Asio; }
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

    // Opens the native ASIO control panel of the currently OPEN driver (Settings UI hook).
    // Fails with a reason when no ASIO stream is open or when built without the SDK.
    bool openControlPanel(std::string* errorOut = nullptr);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace mydaw
