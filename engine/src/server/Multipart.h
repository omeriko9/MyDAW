// MyDAW — server/Multipart.h
// Streaming multipart/form-data parser (RFC 7578) for POST /api/upload. Push-based:
// the HTTP server feeds raw body bytes as they arrive; the parser emits part-begin /
// part-data / part-end callbacks, so multi-gigabyte uploads never accumulate in memory
// (internal buffer is bounded to part headers + a delimiter-sized lookback tail).
//
// Usage:
//   MultipartParser p(boundary);                 // boundary WITHOUT the leading "--"
//   p.onPartBegin(...); p.onPartData(...); p.onPartEnd(...);
//   for each chunk: if (!p.feed(data, len)) -> malformed (sticky failure);
//   after the full body: p.finish() -> true iff the closing "--boundary--" was seen.
//
// Non-RT, server thread only. Callbacks are invoked synchronously from feed().

#pragma once

#include <cstddef>
#include <functional>
#include <string>

namespace mydaw {

class MultipartParser {
public:
    struct PartInfo {
        std::string name;     // Content-Disposition `name` parameter ("" if absent)
        std::string filename; // Content-Disposition `filename` parameter ("" for plain fields)
    };

    using PartBeginFn = std::function<void(const PartInfo&)>;
    using PartDataFn = std::function<void(const char* data, size_t len)>;
    using PartEndFn = std::function<void()>;

    explicit MultipartParser(std::string boundary);

    void onPartBegin(PartBeginFn fn) { beginFn_ = std::move(fn); }
    void onPartData(PartDataFn fn) { dataFn_ = std::move(fn); }
    void onPartEnd(PartEndFn fn) { endFn_ = std::move(fn); }

    // Feeds body bytes. Returns false once the stream is malformed (failure is sticky;
    // further feeds are ignored). Safe with len == 0.
    bool feed(const char* data, size_t len);

    // True iff the terminating boundary ("--<boundary>--") was reached.
    bool finish() const;

    bool failed() const { return state_ == State::Failed; }

private:
    enum class State {
        Preamble,     // before the first boundary
        BoundaryTail, // just matched "--boundary"; expecting CRLF (next part) or "--" (end)
        PartHeaders,  // accumulating part headers until CRLF CRLF
        PartData,     // streaming part body until the next delimiter
        Done,         // final boundary seen; epilogue ignored
        Failed,
    };

    void process();
    bool parsePartHeaders(const std::string& block); // fills cur_, false = malformed
    void fail();

    std::string delim_; // "\r\n--" + boundary
    std::string buf_;   // bounded working buffer
    State state_ = State::Preamble;
    PartInfo cur_;
    bool inPart_ = false;

    PartBeginFn beginFn_;
    PartDataFn dataFn_;
    PartEndFn endFn_;
};

} // namespace mydaw
