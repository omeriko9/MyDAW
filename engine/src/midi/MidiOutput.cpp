// MyDAW — midi/MidiOutput.cpp (see header for the contract).

#include "midi/MidiOutput.h"

#include <algorithm>
#include <chrono>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mmsystem.h>

#include "util/Log.h"

namespace mydaw {

namespace {
inline uint32_t packShort(const MidiEvent& e) {
    // status | data1<<8 | data2<<16 — winmm dwMsg layout for midiOutShortMsg.
    uint32_t m = e.data[0];
    if (e.size > 1) m |= static_cast<uint32_t>(e.data[1]) << 8;
    if (e.size > 2) m |= static_cast<uint32_t>(e.data[2]) << 16;
    return m;
}
} // namespace

MidiOutput::~MidiOutput() { stop(); }

void MidiOutput::start() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (running_.load(std::memory_order_relaxed))
        return;
    running_.store(true, std::memory_order_release);
    sender_ = std::thread([this] { senderLoop_(); });
}

void MidiOutput::stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!running_.load(std::memory_order_relaxed) && usedSlots_ == 0)
            return;
        allNotesOffLocked_();
        running_.store(false, std::memory_order_release);
    }
    if (sender_.joinable())
        sender_.join();
    std::lock_guard<std::mutex> lock(mutex_);
    for (Slot& s : slots_) {
        if (s.handle != nullptr) {
            s.rtHandle.store(nullptr, std::memory_order_release);
            midiOutClose(static_cast<HMIDIOUT>(s.handle));
            s.handle = nullptr;
        }
    }
    usedSlots_ = 0;
}

std::vector<MidiOutDeviceInfo> MidiOutput::devices() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<MidiOutDeviceInfo> out;
    if (nullDevice_.load(std::memory_order_relaxed)) {
        MidiOutDeviceInfo d;
        d.id = "null";
        d.name = kNullDeviceName;
        for (int s = 0; s < usedSlots_; ++s) {
            if (slots_[static_cast<size_t>(s)].name == d.name) {
                d.open = true;
                d.sent = slots_[static_cast<size_t>(s)].sent.load(std::memory_order_relaxed);
            }
        }
        out.push_back(std::move(d));
    }
    const UINT n = midiOutGetNumDevs();
    for (UINT i = 0; i < n; ++i) {
        MIDIOUTCAPSA caps{};
        if (midiOutGetDevCapsA(i, &caps, sizeof(caps)) != MMSYSERR_NOERROR)
            continue;
        MidiOutDeviceInfo d;
        d.id = std::to_string(i);
        d.name = caps.szPname;
        for (int s = 0; s < usedSlots_; ++s) {
            if (slots_[static_cast<size_t>(s)].name == d.name &&
                slots_[static_cast<size_t>(s)].handle != nullptr) {
                d.open = true;
                d.sent = slots_[static_cast<size_t>(s)].sent.load(std::memory_order_relaxed);
            }
        }
        out.push_back(std::move(d));
    }
    return out;
}

int MidiOutput::ensureOpenByName(const std::string& name) {
    if (name.empty())
        return -1;
    std::lock_guard<std::mutex> lock(mutex_);
    for (int s = 0; s < usedSlots_; ++s) {
        if (slots_[static_cast<size_t>(s)].name == name) {
            if (slots_[static_cast<size_t>(s)].isNull.load(std::memory_order_relaxed))
                return s; // the null sink is "open" without a handle
            return slots_[static_cast<size_t>(s)].handle != nullptr ? s : -1;
        }
    }
    // The synthetic sink (--null-midi-out): claim a slot, no winmm call at all.
    if (nullDevice_.load(std::memory_order_relaxed) && name == kNullDeviceName) {
        if (usedSlots_ >= kMaxSlots)
            return -1;
        const int slot = usedSlots_++;
        Slot& s = slots_[static_cast<size_t>(slot)];
        s.name = name;
        s.handle = nullptr;
        s.isNull.store(true, std::memory_order_release);
        s.sent.store(0, std::memory_order_relaxed);
        Log::info("midiOut: opened null sink (slot %d) — events are counted, not sent", slot);
        return slot;
    }
    // find the winmm index carrying this name right now
    const UINT n = midiOutGetNumDevs();
    int devIndex = -1;
    for (UINT i = 0; i < n; ++i) {
        MIDIOUTCAPSA caps{};
        if (midiOutGetDevCapsA(i, &caps, sizeof(caps)) == MMSYSERR_NOERROR &&
            name == caps.szPname) {
            devIndex = static_cast<int>(i);
            break;
        }
    }
    const bool loggedBefore =
        std::find(failedNames_.begin(), failedNames_.end(), name) != failedNames_.end();
    if (devIndex < 0) {
        if (!loggedBefore) {
            Log::warn("midiOut: device '%s' not present — track output stays silent", name.c_str());
            failedNames_.push_back(name);
        }
        return -1;
    }
    if (usedSlots_ >= kMaxSlots) {
        if (!loggedBefore) {
            Log::warn("midiOut: slot table full (%d) — cannot open '%s'", kMaxSlots, name.c_str());
            failedNames_.push_back(name);
        }
        return -1;
    }
    HMIDIOUT h = nullptr;
    const MMRESULT rc =
        midiOutOpen(&h, static_cast<UINT>(devIndex), 0, 0, CALLBACK_NULL);
    if (rc != MMSYSERR_NOERROR) {
        if (!loggedBefore) {
            Log::warn("midiOut: open '%s' failed (mmresult=%u)", name.c_str(), rc);
            failedNames_.push_back(name);
        }
        return -1;
    }
    const int slot = usedSlots_++;
    Slot& s = slots_[static_cast<size_t>(slot)];
    s.name = name;
    s.handle = h;
    s.sent.store(0, std::memory_order_relaxed);
    s.rtHandle.store(h, std::memory_order_release);
    Log::info("midiOut: opened '%s' (slot %d)", name.c_str(), slot);
    return slot;
}

void MidiOutput::queueFromRt(int slot, const MidiBuffer& buf) noexcept {
    if (slot < 0 || slot >= kMaxSlots)
        return;
    for (const MidiEvent& e : buf) {
        if (e.size == 0 || e.data[0] < 0x80 || e.data[0] >= 0xF0)
            continue; // channel-voice only — no realtime/sysex on this path
        if (!ring_.push(Msg{packShort(e), slot}))
            dropped_.fetch_add(1, std::memory_order_relaxed);
    }
}

void MidiOutput::allNotesOff() {
    std::lock_guard<std::mutex> lock(mutex_);
    allNotesOffLocked_();
}

void MidiOutput::allNotesOffLocked_() {
    for (int s = 0; s < usedSlots_; ++s) {
        Slot& slot = slots_[static_cast<size_t>(s)];
        // Null sink: no handle to write to, but it still ACCOUNTS for the flush — the
        // counter is the only observable this path has, and a sink that silently
        // skipped it would hide a regression in the real one.
        if (slot.isNull.load(std::memory_order_relaxed)) {
            slot.sent.fetch_add(3 * 16, std::memory_order_relaxed);
            continue;
        }
        if (slot.handle == nullptr)
            continue;
        HMIDIOUT h = static_cast<HMIDIOUT>(slot.handle);
        for (uint32_t ch = 0; ch < 16; ++ch) {
            const uint32_t status = 0xB0u | ch;
            midiOutShortMsg(h, status | (64u << 8));           // sustain off
            midiOutShortMsg(h, status | (120u << 8));          // all sound off
            midiOutShortMsg(h, status | (123u << 8));          // all notes off
            slot.sent.fetch_add(3, std::memory_order_relaxed);
        }
    }
}

void MidiOutput::senderLoop_() {
    // Non-RT consumer: drain the ring every millisecond. Block-boundary timing
    // dominates the jitter budget (SPEC §5.5 note); 1 ms of sender delay is noise.
    Msg m;
    while (running_.load(std::memory_order_acquire)) {
        bool did = false;
        while (ring_.pop(m)) {
            did = true;
            if (m.slot < 0 || m.slot >= kMaxSlots)
                continue;
            Slot& slot = slots_[static_cast<size_t>(m.slot)];
            // Null sink: count it and drop it — there is no handle to write to.
            if (slot.isNull.load(std::memory_order_acquire)) {
                slot.sent.fetch_add(1, std::memory_order_relaxed);
                continue;
            }
            void* h = slot.rtHandle.load(std::memory_order_acquire);
            if (h == nullptr)
                continue;
            if (midiOutShortMsg(static_cast<HMIDIOUT>(h), m.packed) == MMSYSERR_NOERROR)
                slot.sent.fetch_add(1, std::memory_order_relaxed);
        }
        if (!did)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    while (ring_.pop(m)) { /* drain leftovers on shutdown — handles close after join */ }
}

} // namespace mydaw
