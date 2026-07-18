// MyDAW — midi/MidiInput.cpp
// winmm implementation of the MIDI input manager. See MidiInput.h for the threading and
// timestamping contract.

#include "midi/MidiInput.h"

#include <windows.h>
#include <mmsystem.h> // not pulled in by windows.h under WIN32_LEAN_AND_MEAN

#include <cctype>
#include <cstdio>

#include "util/Log.h"
#include "util/Paths.h"

#pragma comment(lib, "winmm.lib")

namespace mydaw {

// ---------------------------------------------------------------------------
// QPC helpers
// ---------------------------------------------------------------------------

int64_t MidiInput::qpcNow() noexcept {
    LARGE_INTEGER li;
    QueryPerformanceCounter(&li);
    return li.QuadPart;
}

int64_t MidiInput::qpcFrequency() noexcept {
    static const int64_t freq = [] {
        LARGE_INTEGER li;
        QueryPerformanceFrequency(&li);
        return li.QuadPart > 0 ? li.QuadPart : 1;
    }();
    return freq;
}

namespace {

// Milliseconds derived from QPC without overflowing (freq >= 1000 on any real system).
int64_t qpcMillis() {
    const int64_t freq = MidiInput::qpcFrequency();
    const int64_t perMs = freq >= 1000 ? freq / 1000 : 1;
    return MidiInput::qpcNow() / perMs;
}

// winmm MIM_* callback. Per MSDN this runs on a driver-owned thread; only a restricted
// set of system calls is officially allowed, but pushing to lock-free rings and invoking
// the (non-blocking) activity callback is the standard, widely used pattern (non-RT).
void CALLBACK midiInThunk(HMIDIIN /*hmi*/, UINT wMsg, DWORD_PTR dwInstance,
                          DWORD_PTR dwParam1, DWORD_PTR /*dwParam2*/) {
    auto* cookie = reinterpret_cast<MidiInput::CallbackCookie*>(dwInstance);
    if (!cookie || !cookie->owner)
        return;
    switch (wMsg) {
        case MIM_DATA:
            cookie->owner->onWinmmData_(cookie->slot, static_cast<uint32_t>(dwParam1));
            break;
        case MIM_LONGDATA:
        case MIM_LONGERROR:
            cookie->owner->onWinmmLong_(); // SysEx ignored in v1 (logged once, non-RT side)
            break;
        default:
            break; // MIM_OPEN / MIM_CLOSE / MIM_ERROR / MIM_MOREDATA — nothing to do
    }
}

} // namespace

// ---------------------------------------------------------------------------
// Construction / teardown
// ---------------------------------------------------------------------------

MidiInput::MidiInput() {
    qpcFrequency(); // pre-warm the static so callback threads never race the init
}

MidiInput::~MidiInput() {
    stop();
}

// ---------------------------------------------------------------------------
// Control API (mutexed, non-RT)
// ---------------------------------------------------------------------------

void MidiInput::start() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (started_)
        return;
    started_ = true;
    refreshLocked(/*force=*/true); // enumerates + opens enabled devices
    Log::info("MidiInput: started (%d device%s)", knownCount_, knownCount_ == 1 ? "" : "s");
}

void MidiInput::stop() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!started_)
        return;
    for (int i = 0; i < kMaxSlots; ++i)
        closeSlotLocked(i);
    started_ = false;
    maybeLogSysexLocked();
    Log::info("MidiInput: stopped");
}

std::vector<MidiInDeviceInfo> MidiInput::devices() const {
    // Contractually const; hot-plug refresh mutates internal state (documented poll).
    MidiInput* self = const_cast<MidiInput*>(this);
    std::lock_guard<std::mutex> lock(self->mutex_);
    self->refreshLocked(/*force=*/false);
    self->maybeLogSysexLocked();
    std::vector<MidiInDeviceInfo> out;
    out.reserve(static_cast<size_t>(self->knownCount_ > 0 ? self->knownCount_ : 0));
    for (int i = 0; i < self->knownCount_; ++i)
        out.push_back(MidiInDeviceInfo{std::to_string(i), self->slots_[static_cast<size_t>(i)].name,
                                       self->slots_[static_cast<size_t>(i)].userEnabled});
    return out;
}

bool MidiInput::setEnabled(const std::string& id, bool enabled) {
    std::lock_guard<std::mutex> lock(mutex_);
    refreshLocked(/*force=*/false);
    maybeLogSysexLocked();

    // Parse "<winmm-index>".
    if (id.empty())
        return false;
    int idx = 0;
    for (char c : id) {
        if (!std::isdigit(static_cast<unsigned char>(c)))
            return false;
        idx = idx * 10 + (c - '0');
        if (idx >= kMaxSlots)
            return false;
    }
    if (idx >= knownCount_)
        return false;

    Slot& s = slots_[static_cast<size_t>(idx)];
    s.userEnabled = enabled;
    enabledByName_[s.name] = enabled;
    if (started_) {
        if (enabled)
            openSlotLocked(idx);
        else
            closeSlotLocked(idx);
    }
    Log::info("MidiInput: device %d '%s' %s", idx, s.name.c_str(),
              enabled ? "enabled" : "disabled");
    return true;
}

void MidiInput::setControlCallback(std::function<void(const MidiEvent&)> cb) {
    controlCb_.store(std::make_shared<const ControlFn>(std::move(cb)), std::memory_order_release);
}

void MidiInput::setActivityCallback(std::function<void(const std::string&)> cb) {
    activityCb_.store(std::make_shared<const ActivityFn>(std::move(cb)),
                      std::memory_order_release);
}

// ---------------------------------------------------------------------------
// Device enumeration / open / close (mutex_ held)
// ---------------------------------------------------------------------------

void MidiInput::refreshLocked(bool force) {
    const int present = static_cast<int>(midiInGetNumDevs());
    const int usable = present > kMaxSlots ? kMaxSlots : present;
    if (!force && usable == knownCount_)
        return; // hot-plug poll: count unchanged -> keep current list (cheap fast path)
    if (present > kMaxSlots)
        Log::warn("MidiInput: %d MIDI inputs present, only the first %d are managed",
                  present, kMaxSlots);

    // Indices shuffle on hot-plug: close everything, re-enumerate, restore enabled state
    // by device name (new/unknown names default to enabled), reopen if running.
    for (int i = 0; i < kMaxSlots; ++i)
        closeSlotLocked(i);

    for (int i = 0; i < usable; ++i) {
        Slot& s = slots_[static_cast<size_t>(i)];
        MIDIINCAPSW caps{};
        std::string name = "MIDI Input " + std::to_string(i);
        if (midiInGetDevCapsW(static_cast<UINT_PTR>(i), &caps, sizeof(caps)) ==
            MMSYSERR_NOERROR)
            name = wideToUtf8(caps.szPname);
        s.name = name;
        const auto it = enabledByName_.find(name);
        s.userEnabled = (it == enabledByName_.end()) ? true : it->second;
        enabledByName_[name] = s.userEnabled;
    }
    for (int i = usable; i < kMaxSlots; ++i) {
        slots_[static_cast<size_t>(i)].name.clear();
        slots_[static_cast<size_t>(i)].userEnabled = false;
    }
    knownCount_ = usable;

    if (started_) {
        for (int i = 0; i < usable; ++i)
            if (slots_[static_cast<size_t>(i)].userEnabled)
                openSlotLocked(i);
    }
}

void MidiInput::openSlotLocked(int i) {
    Slot& s = slots_[static_cast<size_t>(i)];
    if (s.handle)
        return;
    if (!s.ring) {
        // Allocation happens here on a non-RT thread; the ring then lives until ~MidiInput
        // so the RT thread can keep a stable view of it.
        s.ring = std::make_unique<RtRing<MidiEvent>>(512);
        s.hasRing.store(true, std::memory_order_release);
    }
    s.cookie.owner = this;
    s.cookie.slot = i;
    HMIDIIN h = nullptr;
    const MMRESULT r =
        midiInOpen(&h, static_cast<UINT>(i), reinterpret_cast<DWORD_PTR>(&midiInThunk),
                   reinterpret_cast<DWORD_PTR>(&s.cookie), CALLBACK_FUNCTION);
    if (r != MMSYSERR_NOERROR) {
        Log::warn("MidiInput: midiInOpen failed for device %d '%s' (error %u)", i,
                  s.name.c_str(), static_cast<unsigned>(r));
        return;
    }
    midiInStart(h);
    s.handle = h;
    s.rtEnabled.store(true, std::memory_order_release);
    Log::info("MidiInput: opened device %d '%s'", i, s.name.c_str());
}

void MidiInput::closeSlotLocked(int i) {
    Slot& s = slots_[static_cast<size_t>(i)];
    if (!s.handle)
        return;
    s.rtEnabled.store(false, std::memory_order_release); // RT stops forwarding immediately
    HMIDIIN h = static_cast<HMIDIIN>(s.handle);
    midiInStop(h);
    midiInReset(h);
    midiInClose(h); // after this returns, no further callbacks for this handle
    s.handle = nullptr;
}

void MidiInput::maybeLogSysexLocked() {
    if (sysexLogged_ || !sysexSeen_.load(std::memory_order_relaxed))
        return;
    sysexLogged_ = true;
    Log::warn("MidiInput: SysEx received and ignored (not supported in v1)");
}

// ---------------------------------------------------------------------------
// winmm callback thread (non-RT, lock-free)
// ---------------------------------------------------------------------------

void MidiInput::onWinmmData_(int slotIndex, uint32_t packedMsg) noexcept {
    if (slotIndex < 0 || slotIndex >= kMaxSlots)
        return;
    Slot& s = slots_[static_cast<size_t>(slotIndex)];

    const uint8_t status = static_cast<uint8_t>(packedMsg & 0xFFu);
    if (status < 0x80)
        return; // not a status byte (winmm always delivers full messages; be defensive)
    const uint8_t hi = static_cast<uint8_t>(status & 0xF0u);
    if (hi == 0xF0)
        return; // system common/realtime (clock, active sensing, ...) ignored in v1

    MidiEvent e;
    e.sampleOffset = 0; // stamped into the next block; see jitter note in MidiInput.h
    e.data[0] = status;
    e.data[1] = static_cast<uint8_t>((packedMsg >> 8) & 0x7Fu);
    e.data[2] = static_cast<uint8_t>((packedMsg >> 16) & 0x7Fu);
    e.size = (hi == 0xC0 || hi == 0xD0) ? static_cast<uint8_t>(2) : static_cast<uint8_t>(3);

    if (s.ring)
        s.ring->push(e); // SPSC to the RT thread; drops when full (overrun)

    mirror_.push(TimedMidiEvent{e, qpcNow()}); // MPSC to the recorder; drops when full

    // Control-surface hook: every channel-voice message (unthrottled) for CC→param mapping.
    const std::shared_ptr<const ControlFn> ccb = controlCb_.load(std::memory_order_acquire);
    if (ccb && *ccb)
        (*ccb)(e); // non-RT winmm thread; receiver marshals to its loop

    // Activity callback, throttled per device.
    const std::shared_ptr<const ActivityFn> cb = activityCb_.load(std::memory_order_acquire);
    if (cb && *cb) {
        const int64_t nowMs = qpcMillis();
        int64_t last = s.lastActivityMs.load(std::memory_order_relaxed);
        if (nowMs - last >= kActivityThrottleMs &&
            s.lastActivityMs.compare_exchange_strong(last, nowMs, std::memory_order_relaxed)) {
            char buf[16];
            std::snprintf(buf, sizeof(buf), "%d", slotIndex);
            (*cb)(std::string(buf)); // non-RT thread; receiver marshals as needed
        }
    }
}

void MidiInput::onWinmmLong_() noexcept {
    sysexSeen_.store(true, std::memory_order_relaxed); // logged once from a control call
}

// ---------------------------------------------------------------------------
// RT + mirror consumers
// ---------------------------------------------------------------------------

void MidiInput::drainLive(MidiBuffer& out) noexcept {
    for (int i = 0; i < kMaxSlots; ++i) {
        Slot& s = slots_[static_cast<size_t>(i)];
        if (!s.hasRing.load(std::memory_order_acquire))
            continue;
        const bool forward = s.rtEnabled.load(std::memory_order_acquire);
        MidiEvent e;
        while (s.ring->pop(e)) {
            if (forward) {
                e.sampleOffset = 0;
                out.add(e); // drops when the (1024-event) block buffer is full
            }
            // disabled slot: pop-and-discard self-flushes stale events
        }
    }
}

bool MidiInput::popMirror(TimedMidiEvent& out) noexcept {
    return mirror_.pop(out);
}

void MidiInput::clearMirror() noexcept {
    TimedMidiEvent t;
    while (mirror_.pop(t)) {
    }
}

} // namespace mydaw
