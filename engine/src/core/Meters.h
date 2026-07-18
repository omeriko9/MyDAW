// MyDAW — core/Meters.h
// Per-track level meters (SPEC §5.4 event/meters): atomic peak/RMS slots written by the
// RT thread, drained ~15 Hz by the server timer.
//
// Threading model:
//   - acquire()/release()/clear(): main thread only (during plan rebuild / track removal),
//     guarded by an internal mutex (never touched by RT).
//   - MeterSlot::writeFromRt(): RT thread, lock-free (atomic max accumulate). The slot
//     pointer is captured at plan-build time and stays valid forever (fixed slot pool).
//   - drain(): server thread; takes the registry mutex (not the RT path), reads values
//     and resets the peak/rms accumulators to 0 (UI applies fall-back ballistics).

#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <vector>

namespace mydaw {

struct MeterSlot {
    std::atomic<float> peakL{0.0f};
    std::atomic<float> peakR{0.0f};
    std::atomic<float> rmsL{0.0f};
    std::atomic<float> rmsR{0.0f};

    // RT: accumulate block maxima since the last drain (linear, 0..~1.4 per SPEC §5.4).
    void writeFromRt(float pL, float pR, float rL, float rR) {
        atomicMax(peakL, pL);
        atomicMax(peakR, pR);
        atomicMax(rmsL, rL);
        atomicMax(rmsR, rR);
    }

private:
    friend class Meters;

    static void atomicMax(std::atomic<float>& slot, float v) {
        float cur = slot.load(std::memory_order_relaxed);
        while (v > cur &&
               !slot.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {
            // cur reloaded by compare_exchange_weak
        }
    }

    // Registry bookkeeping — main/server threads under Meters::mutex_ only.
    uint64_t trackId = 0;
    bool active = false;
};

class Meters {
public:
    static constexpr int kMaxSlots = 512;

    struct Reading {
        uint64_t trackId = 0;
        float peakL = 0.0f, peakR = 0.0f, rmsL = 0.0f, rmsR = 0.0f;
    };

    // Main thread (plan rebuild): returns the slot for trackId, allocating one if needed.
    // The returned pointer is stable for the process lifetime (fixed pool) — hand it to
    // the TrackNode for RT writes. nullptr if the pool is exhausted (meters then absent
    // for that track; functionally harmless).
    MeterSlot* acquire(uint64_t trackId) {
        std::lock_guard<std::mutex> lock(mutex_);
        MeterSlot* free = nullptr;
        for (auto& slot : slots_) {
            if (slot.active && slot.trackId == trackId)
                return &slot;
            if (!slot.active && !free)
                free = &slot;
        }
        if (!free)
            return nullptr;
        free->trackId = trackId;
        free->active = true;
        zero(*free);
        return free;
    }

    // Main thread: track removed. The slot is recycled; any stale RT writer must be gone
    // first (the graph swaps the plan before releasing — E2/E9 ordering).
    void release(uint64_t trackId) {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& slot : slots_) {
            if (slot.active && slot.trackId == trackId) {
                slot.active = false;
                slot.trackId = 0;
                zero(slot);
                return;
            }
        }
    }

    // Main thread: project load/new — drop all registrations.
    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& slot : slots_) {
            slot.active = false;
            slot.trackId = 0;
            zero(slot);
        }
    }

    // Server thread (~15 Hz): collect all active slots (master included — E8 splits it
    // out by track id) and reset the accumulators.
    void drain(std::vector<Reading>& out) {
        out.clear();
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& slot : slots_) {
            if (!slot.active)
                continue;
            Reading r;
            r.trackId = slot.trackId;
            r.peakL = slot.peakL.exchange(0.0f, std::memory_order_relaxed);
            r.peakR = slot.peakR.exchange(0.0f, std::memory_order_relaxed);
            r.rmsL = slot.rmsL.exchange(0.0f, std::memory_order_relaxed);
            r.rmsR = slot.rmsR.exchange(0.0f, std::memory_order_relaxed);
            out.push_back(r);
        }
    }

private:
    static void zero(MeterSlot& s) {
        s.peakL.store(0.0f, std::memory_order_relaxed);
        s.peakR.store(0.0f, std::memory_order_relaxed);
        s.rmsL.store(0.0f, std::memory_order_relaxed);
        s.rmsR.store(0.0f, std::memory_order_relaxed);
    }

    std::mutex mutex_; // protects slot registry fields (trackId/active); never on RT path
    MeterSlot slots_[kMaxSlots];
};

} // namespace mydaw
