// MyDAW — audio/DriverManager.cpp (E1)

#include "audio/DriverManager.h"

#include <thread>
#include <vector>

#include "server/EventBus.h"
#include "util/Log.h"

namespace mydaw {

namespace {
json deviceToJson(const DeviceInfo& d) {
    return json{{"id", d.id},
                {"name", d.name},
                {"isDefault", d.isDefault},
                {"maxInputs", d.maxInputs},
                {"maxOutputs", d.maxOutputs},
                {"sampleRates", d.sampleRates}};
}
} // namespace

DriverManager::DriverManager(EventBus* bus) : bus_(bus) {}

DriverManager::~DriverManager() {
    close();
}

IAudioDriver* DriverManager::driverFor(DriverType type) {
    switch (type) {
        case DriverType::Wasapi: return &wasapi_;
        case DriverType::Asio:   return &asio_;
        case DriverType::Null:   return &null_;
    }
    return &wasapi_;
}

bool DriverManager::open(const AudioConfig& config, AudioCallback cb, void* user,
                         std::string& err) {
    std::lock_guard<std::mutex> lock(mutex_);
    cb_ = cb;
    user_ = user;
    requested_ = config;
    return openLocked(config, err);
}

bool DriverManager::openLocked(const AudioConfig& config, std::string& err) {
    err.clear();
    if (!cb_) {
        err = "no audio callback registered";
        return false;
    }
    closeLocked();

    // Fallback chain: requested -> wasapi (same device) -> wasapi default -> null.
    std::vector<AudioConfig> attempts;
    attempts.push_back(config);
    if (config.driverType != DriverType::Wasapi) {
        AudioConfig c = config;
        c.driverType = DriverType::Wasapi;
        attempts.push_back(c);
    }
    {
        AudioConfig c = config;
        c.driverType = DriverType::Wasapi;
        c.deviceId.clear();
        c.exclusive = false;
        attempts.push_back(c);
    }
    {
        AudioConfig c = config;
        c.driverType = DriverType::Null;
        c.deviceId.clear();
        c.captureDeviceId.clear();
        c.exclusive = false;
        attempts.push_back(c);
    }

    std::string detail;
    for (size_t i = 0; i < attempts.size(); ++i) {
        const AudioConfig& c = attempts[i];
        // Skip exact duplicates of the previous attempt (e.g. wasapi requested first).
        if (i > 0 && c.driverType == attempts[i - 1].driverType &&
            c.deviceId == attempts[i - 1].deviceId &&
            c.exclusive == attempts[i - 1].exclusive)
            continue;
        IAudioDriver* d = driverFor(c.driverType);
        std::string reason;
        if (!d->isAvailable(&reason)) {
            detail += std::string(driverTypeToString(c.driverType)) + ": " + reason + "; ";
            continue;
        }
        std::string openErr;
        if (!d->open(c, cb_, user_, &openErr)) {
            detail += std::string(driverTypeToString(c.driverType)) + ": " +
                      (openErr.empty() ? "open failed" : openErr) + "; ";
            continue;
        }
        d->setErrorCallback(&DriverManager::onDriverErrorTramp, this);
        active_ = d;
        activeType_ = c.driverType;
        actual_ = d->actualConfig();
        if (i > 0) {
            const std::string msg = "audio: fell back to " +
                                    std::string(driverTypeToString(c.driverType)) +
                                    (c.deviceId.empty() ? " default device" : " device") +
                                    " (" + detail + ")";
            Log::warn("%s", msg.c_str());
            if (bus_)
                bus_->broadcast("event/log", json{{"level", "warn"}, {"msg", msg}});
        } else {
            Log::info("audio: opened %s device '%s' sr=%d block=%d",
                      driverTypeToString(c.driverType),
                      actual_.deviceId.empty() ? "(default)" : actual_.deviceId.c_str(),
                      actual_.sampleRate, actual_.bufferSize);
        }
        return true;
    }

    err = "no audio driver could be opened: " + detail;
    Log::error("%s", err.c_str());
    return false;
}

void DriverManager::start() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (active_) {
        if (active_->start())
            wantRunning_ = true;
        else
            Log::error("audio: start() failed on %s", driverTypeToString(activeType_));
    }
}

void DriverManager::stop() {
    std::lock_guard<std::mutex> lock(mutex_);
    wantRunning_ = false;
    if (active_)
        active_->stop();
}

void DriverManager::close() {
    std::lock_guard<std::mutex> lock(mutex_);
    wantRunning_ = false;
    closeLocked();
}

void DriverManager::closeLocked() {
    if (!active_)
        return;
    active_->setErrorCallback(nullptr, nullptr);
    active_->close();
    active_ = nullptr;
}

bool DriverManager::reconfigure(const AudioConfig& config, std::string& err) {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool wasRunning = wantRunning_ || (active_ && active_->isRunning());
    closeLocked();
    requested_ = config;
    if (!openLocked(config, err))
        return false;
    if (wasRunning && active_) {
        if (active_->start())
            wantRunning_ = true;
    }
    return true;
}

json DriverManager::devicesJson() const {
    std::lock_guard<std::mutex> lock(mutex_);
    json drivers = json::array();
    {
        std::string reason;
        const bool avail = wasapi_.isAvailable(&reason);
        json devs = json::array();
        if (avail)
            for (const DeviceInfo& d : wasapi_.enumerate())
                devs.push_back(deviceToJson(d));
        json entry = {{"type", "wasapi"}, {"available", avail}, {"devices", devs}};
        if (!avail)
            entry["reason"] = reason;
        drivers.push_back(entry);
    }
    {
        std::string reason;
        const bool avail = asio_.isAvailable(&reason);
        json devs = json::array();
        if (avail)
            for (const DeviceInfo& d : asio_.enumerate())
                devs.push_back(deviceToJson(d));
        json entry = {{"type", "asio"}, {"available", avail}, {"devices", devs}};
        if (!avail)
            entry["reason"] = reason;
        drivers.push_back(entry);
    }
    return json{{"drivers", drivers}};
}

AudioConfig DriverManager::actual() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return actual_;
}

double DriverManager::latencyMs() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!active_)
        return 0.0;
    int lf = active_->latencyFramesOut();
    if (lf <= 0)
        lf = actual_.bufferSize;
    const int sr = actual_.sampleRate > 0 ? actual_.sampleRate : 48000;
    return 1000.0 * static_cast<double>(lf) / static_cast<double>(sr);
}

int DriverManager::xruns() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return active_ ? active_->xrunCount() : 0;
}

bool DriverManager::running() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return active_ && active_->isRunning();
}

DriverType DriverManager::activeType() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return active_ ? activeType_ : DriverType::Null;
}

void DriverManager::onDriverErrorTramp(void* user, const char* message) {
    static_cast<DriverManager*>(user)->onDriverError(message);
}

void DriverManager::onDriverError(const char* message) {
    // Fires on a non-RT driver fault thread. Restart from a detached thread so we never
    // close/join a driver from one of its own threads (SPEC §7 device-invalidation flow).
    if (restartInFlight_.exchange(true, std::memory_order_acq_rel))
        return;
    const std::string msg = message ? message : "audio device fault";
    Log::error("audio: device fault: %s — restarting on the default device", msg.c_str());
    if (bus_)
        bus_->broadcast("event/log",
                        json{{"level", "error"},
                             {"msg", "audio device fault: " + msg +
                                         " — restarting on the default device"}});
    std::thread([this]() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            const bool wasRunning = wantRunning_;
            closeLocked();
            AudioConfig c = requested_;
            c.driverType = DriverType::Wasapi;
            c.deviceId.clear();
            c.exclusive = false;
            std::string err;
            if (openLocked(c, err) && wasRunning && active_) {
                if (active_->start())
                    wantRunning_ = true;
            }
        }
        restartInFlight_.store(false, std::memory_order_release);
    }).detach();
}

} // namespace mydaw
