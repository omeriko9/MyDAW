// MyDAW — audio/AsioDriver.cpp (E1)
// Linker-complete ASIO driver shell. Per SPEC §10 (stub honesty) the backend reports
// isAvailable() == false with a clear reason, so engine/getDevices lists ASIO greyed out
// and DriverManager's fallback chain skips it.
//
// NOTE(spec deviation, v1): AsioDriver.h documents a full SDK-backed implementation
// behind MYDAW_HAVE_ASIO. That implementation is deferred post-MVP — even when the
// define is set this file keeps the honest unavailable path (with a reason that says
// so), rather than shipping a fake driver.

#include "audio/AsioDriver.h"

namespace mydaw {

namespace {
const char* kAsioUnavailableReason =
#if defined(MYDAW_HAVE_ASIO)
    "ASIO SDK configured, but the ASIO backend is deferred in this build (post-MVP)";
#else
    "built without ASIO SDK (set MYDAW_ASIO_SDK_DIR)";
#endif
} // namespace

struct AsioDriver::Impl {
    AudioConfig actual{};
};

AsioDriver::AsioDriver() : impl_(std::make_unique<Impl>()) {
    impl_->actual.driverType = DriverType::Asio;
}

AsioDriver::~AsioDriver() = default;

bool AsioDriver::isAvailable(std::string* reasonOut) const {
    if (reasonOut)
        *reasonOut = kAsioUnavailableReason;
    return false;
}

std::vector<DeviceInfo> AsioDriver::enumerate() {
    return {};
}

bool AsioDriver::open(const AudioConfig&, AudioCallback, void*, std::string* errorOut) {
    if (errorOut)
        *errorOut = kAsioUnavailableReason;
    return false;
}

bool AsioDriver::start() {
    return false;
}

void AsioDriver::stop() {}

void AsioDriver::close() {}

int AsioDriver::latencyFramesIn() const {
    return 0;
}

int AsioDriver::latencyFramesOut() const {
    return 0;
}

AudioConfig AsioDriver::actualConfig() const {
    return impl_->actual;
}

void AsioDriver::setErrorCallback(AudioErrorCallback, void*) {}

int AsioDriver::xrunCount() const {
    return 0;
}

bool AsioDriver::isRunning() const {
    return false;
}

bool AsioDriver::openControlPanel(std::string* errorOut) {
    if (errorOut)
        *errorOut = kAsioUnavailableReason;
    return false;
}

} // namespace mydaw
