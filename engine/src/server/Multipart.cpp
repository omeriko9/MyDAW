// MyDAW — server/Multipart.cpp
// Streaming multipart/form-data parser implementation. See Multipart.h.

#include "server/Multipart.h"

#include "util/Strings.h"

#include <vector>

namespace mydaw {

namespace {

constexpr size_t kMaxPartHeaderBytes = 16 * 1024;

// Parses a Content-Disposition parameter value starting at `pos` (just past '=').
// Handles quoted-string (with backslash escapes) and bare tokens. Returns the value and
// advances pos past it.
std::string parseParamValue(const std::string& s, size_t& pos) {
    std::string out;
    if (pos < s.size() && s[pos] == '"') {
        ++pos;
        while (pos < s.size()) {
            const char c = s[pos];
            if (c == '\\' && pos + 1 < s.size()) {
                out.push_back(s[pos + 1]);
                pos += 2;
                continue;
            }
            if (c == '"') {
                ++pos;
                break;
            }
            out.push_back(c);
            ++pos;
        }
    } else {
        while (pos < s.size() && s[pos] != ';')
            out.push_back(s[pos++]);
        out = trim(out);
    }
    return out;
}

} // namespace

MultipartParser::MultipartParser(std::string boundary)
    : delim_("\r\n--" + boundary) {
    // Virtual leading CRLF so the very first boundary ("--boundary" at body offset 0)
    // matches the uniform delimiter "\r\n--boundary". RFC-permitted preambles are
    // discarded by the Preamble state.
    buf_ = "\r\n";
    if (boundary.empty())
        state_ = State::Failed;
}

void MultipartParser::fail() {
    if (inPart_) {
        inPart_ = false;
        // No onPartEnd for a truncated/failed part; the owner cleans up via failure path.
    }
    state_ = State::Failed;
    buf_.clear();
}

bool MultipartParser::feed(const char* data, size_t len) {
    if (state_ == State::Failed)
        return false;
    if (state_ == State::Done) {
        // Epilogue: ignored per RFC 2046.
        return true;
    }
    if (len > 0 && data != nullptr)
        buf_.append(data, len);
    process();
    return state_ != State::Failed;
}

bool MultipartParser::finish() const {
    return state_ == State::Done;
}

void MultipartParser::process() {
    for (;;) {
        switch (state_) {
            case State::Preamble: {
                const size_t pos = buf_.find(delim_);
                if (pos == std::string::npos) {
                    // Keep only a delimiter-sized tail so a split match still completes.
                    if (buf_.size() > delim_.size())
                        buf_.erase(0, buf_.size() - delim_.size());
                    return;
                }
                buf_.erase(0, pos + delim_.size());
                state_ = State::BoundaryTail;
                break;
            }

            case State::BoundaryTail: {
                // After "--boundary": optional linear whitespace, then CRLF (next part)
                // or "--" (final boundary).
                size_t i = 0;
                while (i < buf_.size() && (buf_[i] == ' ' || buf_[i] == '\t'))
                    ++i;
                if (buf_.size() - i < 2)
                    return; // need more bytes
                if (buf_[i] == '\r' && buf_[i + 1] == '\n') {
                    buf_.erase(0, i + 2);
                    state_ = State::PartHeaders;
                    break;
                }
                if (buf_[i] == '-' && buf_[i + 1] == '-') {
                    state_ = State::Done;
                    buf_.clear();
                    return;
                }
                fail();
                return;
            }

            case State::PartHeaders: {
                // An empty header block is a lone CRLF immediately after the boundary
                // line — check before searching, so part DATA containing CRLFCRLF is
                // never mistaken for headers.
                if (buf_.size() >= 2 && buf_[0] == '\r' && buf_[1] == '\n') {
                    buf_.erase(0, 2);
                    cur_ = PartInfo{};
                    inPart_ = true;
                    if (beginFn_)
                        beginFn_(cur_);
                    state_ = State::PartData;
                    break;
                }
                if (buf_.size() < 2)
                    return;
                const size_t pos = buf_.find("\r\n\r\n");
                if (pos == std::string::npos) {
                    if (buf_.size() > kMaxPartHeaderBytes) {
                        fail();
                        return;
                    }
                    return;
                }
                if (pos > kMaxPartHeaderBytes) {
                    fail();
                    return;
                }
                const std::string block = buf_.substr(0, pos);
                buf_.erase(0, pos + 4);
                if (!parsePartHeaders(block)) {
                    fail();
                    return;
                }
                inPart_ = true;
                if (beginFn_)
                    beginFn_(cur_);
                state_ = State::PartData;
                break;
            }

            case State::PartData: {
                const size_t pos = buf_.find(delim_);
                if (pos == std::string::npos) {
                    // Emit everything except a delimiter-sized tail (a delimiter may be
                    // split across feed() calls).
                    if (buf_.size() > delim_.size()) {
                        const size_t emit = buf_.size() - delim_.size();
                        if (dataFn_)
                            dataFn_(buf_.data(), emit);
                        buf_.erase(0, emit);
                    }
                    return;
                }
                if (pos > 0 && dataFn_)
                    dataFn_(buf_.data(), pos);
                buf_.erase(0, pos + delim_.size());
                inPart_ = false;
                if (endFn_)
                    endFn_();
                state_ = State::BoundaryTail;
                break;
            }

            case State::Done:
                buf_.clear();
                return;

            case State::Failed:
                return;
        }
    }
}

bool MultipartParser::parsePartHeaders(const std::string& block) {
    cur_ = PartInfo{};
    // Split into lines on CRLF; tolerate bare LF defensively.
    size_t lineStart = 0;
    while (lineStart < block.size()) {
        size_t lineEnd = block.find("\r\n", lineStart);
        if (lineEnd == std::string::npos)
            lineEnd = block.size();
        const std::string line = block.substr(lineStart, lineEnd - lineStart);
        lineStart = (lineEnd == block.size()) ? block.size() : lineEnd + 2;
        if (line.empty())
            continue;

        const size_t colon = line.find(':');
        if (colon == std::string::npos)
            return false;
        const std::string name = trim(line.substr(0, colon));
        const std::string value = trim(line.substr(colon + 1));
        if (!iequals(name, "content-disposition"))
            continue; // Content-Type etc: ignored

        // value: form-data; name="files"; filename="kick 01.wav"
        size_t pos = 0;
        // Skip the disposition type token.
        while (pos < value.size() && value[pos] != ';')
            ++pos;
        while (pos < value.size()) {
            ++pos; // skip ';'
            while (pos < value.size() && (value[pos] == ' ' || value[pos] == '\t'))
                ++pos;
            size_t keyStart = pos;
            while (pos < value.size() && value[pos] != '=' && value[pos] != ';')
                ++pos;
            const std::string key = lower(trim(value.substr(keyStart, pos - keyStart)));
            if (pos >= value.size() || value[pos] != '=')
                continue; // parameter without value
            ++pos; // skip '='
            const std::string v = parseParamValue(value, pos);
            if (key == "name")
                cur_.name = v;
            else if (key == "filename")
                cur_.filename = v;
            // "filename*" (RFC 5987) intentionally not handled in v1.
        }
    }
    return true;
}

} // namespace mydaw
