// MyDAW — project/Autosave.h (E3)
// Timer-driven autosave (SPEC §6): every settings.autosaveMinutes (default 2) while the
// project is dirty, rolling 5 slots (ProjectIO::autosaveNow). E9's main loop calls
// tick() frequently (any cadence >= ~1 s is fine); the interval check is internal.
// Main-thread only.

#pragma once

#include <chrono>

namespace mydaw {

class Model;
class ProjectIO;

class Autosave {
public:
    // Both must outlive the Autosave (process-lifetime singletons, E9).
    Autosave(Model& model, ProjectIO& io);

    // From settings.autosaveMinutes; <= 0 disables autosave.
    void setIntervalMinutes(int minutes);
    int intervalMinutes() const { return minutes_; }

    // Autosaves when the interval has elapsed AND the project is dirty; otherwise just
    // re-arms. Cheap when not due.
    void tick();

    // Restarts the countdown (e.g. after a manual save).
    void resetTimer();

private:
    Model& model_;
    ProjectIO& io_;
    int minutes_ = 2;
    std::chrono::steady_clock::time_point last_;
};

} // namespace mydaw
