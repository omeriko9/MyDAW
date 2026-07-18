// MyDAW — server/EventBus.cpp
// Implementation of the EventBus declared in server/EventBus.h (foundation contract).
//
// Snapshot dispatch: broadcast() copies the current handler list under the mutex, then
// invokes the copies OUTSIDE the lock — so a handler may subscribe/unsubscribe (itself
// included) without deadlock. Consequence (documented contract): a handler removed
// during a broadcast that already snapshotted it may still receive that one event.
// Thread-safe, non-RT (handlers allocate; std::function copies allocate).

#include "server/EventBus.h"

#include <mutex>
#include <utility>
#include <vector>

namespace mydaw {

struct EventBus::Impl {
    std::mutex mutex;
    uint64_t nextToken = 1;
    std::vector<std::pair<uint64_t, Handler>> handlers; // insertion order preserved
};

EventBus::EventBus() : impl_(std::make_unique<Impl>()) {}

EventBus::~EventBus() = default;

uint64_t EventBus::subscribe(Handler handler) {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    const uint64_t token = impl_->nextToken++;
    impl_->handlers.emplace_back(token, std::move(handler));
    return token;
}

void EventBus::unsubscribe(uint64_t token) {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    auto& v = impl_->handlers;
    for (auto it = v.begin(); it != v.end(); ++it) {
        if (it->first == token) {
            v.erase(it);
            return;
        }
    }
    // Unknown / already removed token: silently ignored per contract.
}

void EventBus::broadcast(const std::string& type, json payload) {
    json event;
    event["type"] = type;
    event["payload"] = std::move(payload);
    broadcast(std::move(event));
}

void EventBus::broadcast(json event) {
    std::vector<Handler> snapshot;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        snapshot.reserve(impl_->handlers.size());
        for (const auto& [token, handler] : impl_->handlers) {
            (void)token;
            snapshot.push_back(handler);
        }
    }
    for (const auto& handler : snapshot) {
        if (handler)
            handler(event);
    }
}

} // namespace mydaw
