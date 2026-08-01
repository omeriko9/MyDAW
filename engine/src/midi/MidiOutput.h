// MyDAW — midi/MidiOutput.h
// Manager of winmm MIDI OUTPUTS (SPEC §5.5) — the midiOutOpen sibling of MidiInput.
// Tracks reference a device by NAME (Track::midiOutDevice); the graph rebuild resolves
// the name to a slot via ensureOpenByName() (control thread, opens on demand), and
// TrackNode's RT path queues each block's channel-voice events through a lock-free
// MPSC ring. A dedicated non-RT sender thread drains the ring every millisecond and
// calls midiOutShortMsg — winmm is never touched from the audio thread.
//
// Timing honesty (documented in SPEC §5.5): events are sent when their block is
// RENDERED, i.e. they lead the speakers by the output latency and carry up to one
// block plus ~1 ms of sender jitter. Good enough to sequence outboard gear (v1);
// sample-accurate hardware timing would need QPC scheduling against the stream clock.
//
// Note hygiene: allNotesOff() sends sustain-off + all-sound-off + all-notes-off on all
// 16 channels of every OPEN device — App calls it on transport stop and engine/panic,
// and stop() calls it before closing handles, so external synths never hang notes.
//
// Threading:
//   - start/stop/devices/ensureOpenByName/allNotesOff: any non-RT thread (mutexed).
//   - queueFromRt: RT audio thread ONLY (lock-free push; full ring drops + counts).

#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "core/RtRing.h"
#include "midi/MidiEvent.h"

namespace mydaw {

// midi/getOutputs element. id = winmm device index stringified; `sent` is the total
// short messages delivered to the device since open (the headless test's observable).
struct MidiOutDeviceInfo {
    std::string id;
    std::string name;
    bool open = false;
    uint64_t sent = 0;
};

class MidiOutput {
public:
    static constexpr int kMaxSlots = 16;

    MidiOutput() = default;
    ~MidiOutput();
    MidiOutput(const MidiOutput&) = delete;
    MidiOutput& operator=(const MidiOutput&) = delete;

    // Launches the sender thread. Idempotent. Devices open lazily (ensureOpenByName).
    void start();

    // allNotesOff(), closes every handle, joins the sender thread.
    void stop();

    // Current device list (fresh midiOutGetNumDevs enumeration) + open/sent state.
    std::vector<MidiOutDeviceInfo> devices() const;

    // Resolve a device NAME to a slot, opening the handle if needed. Returns -1 when
    // no such device exists or the open failed (logged once per name). Control thread.
    int ensureOpenByName(const std::string& name);

    // RT audio thread: queue every channel-voice event of `buf` for `slot`. sampleOffset
    // is dropped (see timing note above). A full ring drops and counts, never blocks.
    void queueFromRt(int slot, const MidiBuffer& buf) noexcept;

    // Immediate (non-RT): sustain off + all-sound-off + all-notes-off, ch 1..16, every
    // open device. Bypasses the ring so a stop always silences even a saturated queue.
    void allNotesOff();

    uint64_t droppedEvents() const noexcept { return dropped_.load(std::memory_order_relaxed); }

private:
    struct Slot {
        std::string name;                 // guarded by mutex_
        void* handle = nullptr;           // HMIDIOUT, guarded by mutex_ (sender reads via atomic below)
        std::atomic<void*> rtHandle{nullptr}; // sender-thread view of the handle
        std::atomic<uint64_t> sent{0};
    };
    struct Msg {
        uint32_t packed = 0;
        int32_t slot = -1;
    };

    void senderLoop_();
    void allNotesOffLocked_();

    mutable std::mutex mutex_;
    std::array<Slot, kMaxSlots> slots_;
    int usedSlots_ = 0;                   // slots 0..usedSlots_-1 are assigned names
    std::vector<std::string> failedNames_; // open failures logged once per name
    std::thread sender_;
    std::atomic<bool> running_{false};
    std::atomic<uint64_t> dropped_{0};
    MpscRing<Msg> ring_{4096};
};

} // namespace mydaw
