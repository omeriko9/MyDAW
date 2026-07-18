// MyDAW — server/EventBus.h
// Declaration only — implemented by E8 in server/EventBus.cpp.
//
// Fan-out for engine->client `event/*` messages (SPEC §5): any module broadcasts a JSON
// event; subscribers (the WS server, which serializes to all connected clients; tests)
// receive it. Thread-safe: broadcast/subscribe/unsubscribe may be called from any non-RT
// thread (main, server, workers). NEVER call from the RT audio thread — RT code publishes
// via rings/atomics (meters, transport) and a non-RT timer turns those into events.
//
// Handler contract: invoked synchronously on the broadcasting thread, outside the
// subscriber-list lock (snapshot dispatch — a handler may subscribe/unsubscribe, including
// itself, without deadlock). Handlers must be fast and must not block on the caller.

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "util/Json.h"

namespace mydaw {

class EventBus {
public:
    // Receives the full event object: {"type":"event/<name>","payload":{...}}.
    using Handler = std::function<void(const json& event)>;

    EventBus();
    ~EventBus();
    EventBus(const EventBus&) = delete;
    EventBus& operator=(const EventBus&) = delete;

    // Registers a handler; returns a token for unsubscribe(). Thread-safe.
    uint64_t subscribe(Handler handler);

    // Removes a handler. Safe to call with an unknown/already-removed token. Thread-safe.
    void unsubscribe(uint64_t token);

    // Builds {"type": type, "payload": payload} and dispatches to all subscribers.
    // `type` is the full event name, e.g. "event/projectChanged". Thread-safe, non-RT.
    void broadcast(const std::string& type, json payload);

    // Dispatches a pre-built event object verbatim. Thread-safe, non-RT.
    void broadcast(json event);

private:
    struct Impl; // defined in server/EventBus.cpp (E8)
    std::unique_ptr<Impl> impl_;
};

} // namespace mydaw
