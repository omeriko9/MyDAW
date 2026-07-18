// MyDAW — core/RtRing.h
// Header-only lock-free ring buffers (SPEC §7).
//
// RtRing<T>  — single-producer / single-consumer (SPSC) bounded queue.
//              BOTH sides are RT-safe: no locks, no allocation after construction, wait-free.
//              Engine use: main thread pushes ParamMsg, RT audio thread pops; also driver
//              capture -> recording-drain worker.
//
// MpscRing<T> — multi-producer / single-consumer bounded queue (Vyukov-style, per-cell
//              sequence numbers). push() is callable from ANY non-RT thread: lock-free
//              (a short CAS retry loop, no mutex, no allocation) — it is not strictly
//              wait-free, so treat it as non-RT producer side. pop() is single-consumer,
//              wait-free and RT-safe (the consumer may also be the main thread, e.g. the
//              command queue of SPEC §7 where server/worker threads produce).
//              If a producer is preempted mid-publish, the consumer simply sees "empty"
//              for that cell until the producer finishes — it never blocks.
//
// Both rings require trivially copyable T (commands carrying heap payloads should be
// passed as raw pointers and ownership-transferred through the ring).
// Capacity is rounded up to a power of two; construction allocates (do it at setup time).

#pragma once

#include <atomic>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <type_traits>

namespace mydaw {

namespace detail {
inline size_t ceilPow2(size_t v) {
    if (v < 2)
        return 2;
    --v;
    v |= v >> 1; v |= v >> 2; v |= v >> 4;
    v |= v >> 8; v |= v >> 16;
#if INTPTR_MAX == INT64_MAX
    v |= v >> 32;
#endif
    return v + 1;
}
} // namespace detail

// ---------------------------------------------------------------------------
// SPSC ring. Producer thread calls push(), consumer thread calls pop(). RT-safe both sides.
// ---------------------------------------------------------------------------
template <typename T>
class RtRing {
    static_assert(std::is_trivially_copyable_v<T>,
                  "RtRing requires trivially copyable T (pass pointers for heavy payloads)");

public:
    explicit RtRing(size_t capacity = 1024)
        : mask_(detail::ceilPow2(capacity) - 1),
          buf_(std::make_unique<T[]>(detail::ceilPow2(capacity))) {}

    RtRing(const RtRing&) = delete;
    RtRing& operator=(const RtRing&) = delete;

    // Producer side only. Returns false when full (caller decides: drop or retry later).
    bool push(const T& v) {
        const uint64_t h = head_.load(std::memory_order_relaxed);
        const uint64_t t = tail_.load(std::memory_order_acquire);
        if (h - t > mask_) // full: capacity items in flight
            return false;
        buf_[static_cast<size_t>(h) & mask_] = v;
        head_.store(h + 1, std::memory_order_release);
        return true;
    }

    // Consumer side only. Returns false when empty.
    bool pop(T& out) {
        const uint64_t t = tail_.load(std::memory_order_relaxed);
        const uint64_t h = head_.load(std::memory_order_acquire);
        if (t == h)
            return false;
        out = buf_[static_cast<size_t>(t) & mask_];
        tail_.store(t + 1, std::memory_order_release);
        return true;
    }

    // Approximate (racy) — fine for diagnostics/back-pressure heuristics.
    size_t approxSize() const {
        const uint64_t h = head_.load(std::memory_order_acquire);
        const uint64_t t = tail_.load(std::memory_order_acquire);
        return static_cast<size_t>(h - t);
    }

    size_t capacity() const { return mask_ + 1; }

private:
    const size_t mask_;
    std::unique_ptr<T[]> buf_;
    alignas(64) std::atomic<uint64_t> head_{0}; // written by producer
    alignas(64) std::atomic<uint64_t> tail_{0}; // written by consumer
};

// ---------------------------------------------------------------------------
// MPSC ring (bounded Vyukov queue). push(): any non-RT thread. pop(): one consumer, RT-safe.
// ---------------------------------------------------------------------------
template <typename T>
class MpscRing {
    static_assert(std::is_trivially_copyable_v<T>,
                  "MpscRing requires trivially copyable T (pass pointers for heavy payloads)");

public:
    explicit MpscRing(size_t capacity = 256)
        : mask_(detail::ceilPow2(capacity) - 1),
          cells_(std::make_unique<Cell[]>(detail::ceilPow2(capacity))) {
        for (size_t i = 0; i <= mask_; ++i)
            cells_[i].seq.store(static_cast<uint64_t>(i), std::memory_order_relaxed);
    }

    MpscRing(const MpscRing&) = delete;
    MpscRing& operator=(const MpscRing&) = delete;

    // Multi-producer enqueue. Lock-free CAS loop; returns false when full.
    bool push(const T& v) {
        uint64_t pos = enqueuePos_.load(std::memory_order_relaxed);
        for (;;) {
            Cell& cell = cells_[static_cast<size_t>(pos) & mask_];
            const uint64_t seq = cell.seq.load(std::memory_order_acquire);
            const intptr_t dif = static_cast<intptr_t>(seq) - static_cast<intptr_t>(pos);
            if (dif == 0) {
                if (enqueuePos_.compare_exchange_weak(pos, pos + 1,
                                                      std::memory_order_relaxed)) {
                    cell.value = v;
                    cell.seq.store(pos + 1, std::memory_order_release);
                    return true;
                }
                // CAS failed: pos was refreshed by compare_exchange_weak; retry.
            } else if (dif < 0) {
                return false; // full
            } else {
                pos = enqueuePos_.load(std::memory_order_relaxed);
            }
        }
    }

    // Single-consumer dequeue. Wait-free; returns false when empty (or the next cell's
    // producer has claimed but not yet published — treated as empty, never blocks).
    bool pop(T& out) {
        const uint64_t pos = dequeuePos_.load(std::memory_order_relaxed);
        Cell& cell = cells_[static_cast<size_t>(pos) & mask_];
        const uint64_t seq = cell.seq.load(std::memory_order_acquire);
        const intptr_t dif = static_cast<intptr_t>(seq) - static_cast<intptr_t>(pos + 1);
        if (dif < 0)
            return false;
        out = cell.value;
        cell.seq.store(pos + mask_ + 1, std::memory_order_release);
        dequeuePos_.store(pos + 1, std::memory_order_relaxed);
        return true;
    }

    size_t approxSize() const {
        const uint64_t e = enqueuePos_.load(std::memory_order_acquire);
        const uint64_t d = dequeuePos_.load(std::memory_order_acquire);
        return e >= d ? static_cast<size_t>(e - d) : 0;
    }

    size_t capacity() const { return mask_ + 1; }

private:
    struct Cell {
        std::atomic<uint64_t> seq{0};
        T value{};
    };

    const size_t mask_;
    std::unique_ptr<Cell[]> cells_;
    alignas(64) std::atomic<uint64_t> enqueuePos_{0};
    alignas(64) std::atomic<uint64_t> dequeuePos_{0};
};

} // namespace mydaw
