// MyDAW — project/Autosave.cpp (E3)

#include "project/Autosave.h"

#include <string>

#include "project/ProjectIO.h"
#include "util/Log.h"

namespace mydaw {

Autosave::Autosave(Model& model, ProjectIO& io)
    : model_(model), io_(io), last_(std::chrono::steady_clock::now()) {}

void Autosave::setIntervalMinutes(int minutes) {
    minutes_ = minutes;
}

void Autosave::resetTimer() {
    last_ = std::chrono::steady_clock::now();
}

void Autosave::tick() {
    if (minutes_ <= 0)
        return;
    const auto now = std::chrono::steady_clock::now();
    if (now - last_ < std::chrono::minutes(minutes_))
        return;
    last_ = now; // re-arm whether or not we save (avoids save storms when clean)
    if (!io_.isDirty())
        return;
    std::string err;
    if (!io_.autosaveNow(model_, err))
        Log::warn("Autosave: failed (%s)", err.c_str());
}

} // namespace mydaw
