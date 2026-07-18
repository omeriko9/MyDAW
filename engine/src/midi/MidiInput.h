// MyDAW — midi/MidiInput.h
// Manager of winmm MIDI inputs (SPEC §5.5). One midiInOpen handle per enabled device,
// MIM_DATA callback -> per-device lock-free SPSC ring -> drainLive() merges the enabled
// rings on the RT audio thread.
//
// Timestamping / jitter (documented per SPEC §5.5 + E5 brief): live events are stamped
// sampleOffset = 0 within the NEXT processed audio block, i.e. up to one block of jitter
// (plus winmm driver latency) on the live/monitoring path. The RECORDING path does not
// share that jitter: every event is also pushed to a second "mirror" ring together with a
// QueryPerformanceCounter timestamp; the MidiRecorder (non-RT consumer) converts QPC age
// to beats, so recorded notes land at their actual arrival time, not at block boundaries.
//
// Device ids are STRINGS: the winmm device index stringified ("0", "1", ...). Hot device
// list refresh: devices() polls midiInGetNumDevs() and re-enumerates when the count
// changes (enabled state is preserved by device NAME across re-enumeration; new devices
// default to enabled). SysEx is ignored (logged once). Activity callback is throttled to
// >= 100 ms per device and is invoked on the winmm callback thread (non-RT) — the
// receiver must marshal to its own thread if needed and must not re-enter MidiInput's
// blocking control API from inside the callback.
//
// Threading:
//   - start/stop/devices/setEnabled/setActivityCallback: any non-RT thread (mutexed).
//   - drainLive: RT audio thread ONLY (lock-free, no allocation).
//   - popMirror/clearMirror: ONE non-RT consumer thread (the MidiRecorder pump / main).

#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "core/RtRing.h"
#include "midi/MidiEvent.h"

namespace mydaw {

// midi/getInputs element (SPEC §5.5). id = winmm device index stringified.
struct MidiInDeviceInfo {
    std::string id;
    std::string name;
    bool enabled = false;
};

// Mirror-ring element for the recording path: the raw event plus the QPC tick count at
// the moment the winmm callback delivered it. sampleOffset inside `ev` is meaningless
// here (always 0); timing comes from `qpc`.
struct TimedMidiEvent {
    MidiEvent ev;
    int64_t qpc = 0;
};

class MidiInput {
public:
    static constexpr int kMaxSlots = 32;       // winmm device indices we manage (0..31)
    static constexpr int kActivityThrottleMs = 100;

    MidiInput();
    ~MidiInput();
    MidiInput(const MidiInput&) = delete;
    MidiInput& operator=(const MidiInput&) = delete;

    // Begins operation: enumerates devices and opens every enabled one. Idempotent.
    void start();

    // Closes all open device handles. Enabled state is remembered for the next start().
    void stop();

    // Current device list (polls midiInGetNumDevs and re-enumerates on change).
    std::vector<MidiInDeviceInfo> devices() const;

    // Enables/disables a device by id ("<winmm-index>"). Opens/closes the handle
    // immediately when started. Returns false for an unknown id.
    bool setEnabled(const std::string& id, bool enabled);

    // RT audio thread: appends all pending live events from enabled devices to `out`
    // with sampleOffset = 0 (caller clears `out`; see jitter note above). Events queued
    // by devices that were disabled meanwhile are drained and discarded (self-flush).
    void drainLive(MidiBuffer& out) noexcept;

    // `cb(deviceId)` fires on incoming data, throttled to >= kActivityThrottleMs per
    // device, on the winmm callback thread (non-RT). Pass an empty function to clear.
    void setActivityCallback(std::function<void(const std::string& deviceId)> cb);

    // Control-surface hook: invoked (non-RT, winmm thread) for EVERY channel-voice message
    // (not throttled) so MIDI-learn / CC→param mapping sees all values. Marshal to your loop.
    void setControlCallback(std::function<void(const MidiEvent& ev)> cb);

    // ---- recorder mirror (E5-internal: consumed by MidiRecorder) ------------------
    // Single-consumer pop of the QPC-timestamped mirror ring (all devices merged).
    bool popMirror(TimedMidiEvent& out) noexcept;
    // Drains and discards everything queued so far (same consumer thread as popMirror;
    // called at record start to drop stale events).
    void clearMirror() noexcept;

    // QueryPerformanceCounter helpers (shared with MidiRecorder for age computation).
    static int64_t qpcNow() noexcept;
    static int64_t qpcFrequency() noexcept;

    // ---- internal plumbing (public only for the winmm C callback; do not call) -----
    struct CallbackCookie {
        MidiInput* owner = nullptr;
        int slot = -1;
    };
    void onWinmmData_(int slotIndex, uint32_t packedMsg) noexcept; // MIM_DATA
    void onWinmmLong_() noexcept;                                  // MIM_LONGDATA/-ERROR

private:
    struct Slot {
        std::string name;                 // guarded by mutex_
        bool userEnabled = false;         // desired state, guarded by mutex_
        void* handle = nullptr;           // HMIDIIN, guarded by mutex_
        CallbackCookie cookie;            // stable address passed to midiInOpen
        // Allocated on first open, never freed until destruction (RT reads the pointer
        // after observing hasRing == true; slots never move — std::array member).
        std::unique_ptr<RtRing<MidiEvent>> ring;
        std::atomic<bool> hasRing{false};
        std::atomic<bool> rtEnabled{false};      // open + enabled: RT forwards events
        std::atomic<int64_t> lastActivityMs{0};  // QPC-derived ms, activity throttle
    };

    void refreshLocked(bool force);   // re-enumerate on midiInGetNumDevs change
    void openSlotLocked(int i);
    void closeSlotLocked(int i);
    void maybeLogSysexLocked();

    mutable std::mutex mutex_;
    std::array<Slot, kMaxSlots> slots_;
    std::map<std::string, bool> enabledByName_; // survives index shuffles on hot-plug
    int knownCount_ = -1;                        // -1 forces first enumeration
    bool started_ = false;
    bool sysexLogged_ = false;
    std::atomic<bool> sysexSeen_{false};

    using ActivityFn = std::function<void(const std::string&)>;
    std::atomic<std::shared_ptr<const ActivityFn>> activityCb_{nullptr};
    using ControlFn = std::function<void(const MidiEvent&)>;
    std::atomic<std::shared_ptr<const ControlFn>> controlCb_{nullptr};

    // All winmm callback threads push (MPSC); the MidiRecorder pump pops.
    MpscRing<TimedMidiEvent> mirror_{4096};
};

} // namespace mydaw
