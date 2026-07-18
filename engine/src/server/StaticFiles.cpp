// MyDAW — server/StaticFiles.cpp
// See StaticFiles.h.

#include "server/StaticFiles.h"

#include "util/Paths.h"
#include "util/Strings.h"

#include <cstdio>
#include <vector>

namespace mydaw {

namespace {

// Splits a decoded URL path into sanitized segments. Returns false on any traversal /
// invalid character attempt. Empty segments and "." are skipped.
bool sanitizeSegments(const std::string& urlPath, std::vector<std::string>& out) {
    out.clear();
    std::string current;
    auto push = [&]() -> bool {
        if (current == "..")
            return false; // traversal
        if (!current.empty() && current != ".")
            out.push_back(current);
        current.clear();
        return true;
    };
    for (const char ch : urlPath) {
        if (ch == '/') {
            if (!push())
                return false;
            continue;
        }
        // Reject anything that could escape the root or confuse Win32 paths
        // ('\0' is covered by the control-character check).
        if (ch == '\\' || ch == ':' || static_cast<unsigned char>(ch) < 0x20)
            return false;
        current.push_back(ch);
    }
    return push();
}

bool readWholeFile(const std::string& utf8Path, std::string& out) {
    const std::wstring wide = utf8ToWide(utf8Path);
    FILE* f = _wfopen(wide.c_str(), L"rb");
    if (!f)
        return false;
    if (std::fseek(f, 0, SEEK_END) != 0) {
        std::fclose(f);
        return false;
    }
    const long size = std::ftell(f);
    if (size < 0) {
        std::fclose(f);
        return false;
    }
    std::rewind(f);
    out.resize(static_cast<size_t>(size));
    size_t got = 0;
    if (size > 0)
        got = std::fread(out.data(), 1, static_cast<size_t>(size), f);
    std::fclose(f);
    if (got != static_cast<size_t>(size))
        return false;
    return true;
}

} // namespace

void StaticFiles::setRoot(std::string uiRoot) {
    root_ = std::move(uiRoot);
}

std::string StaticFiles::contentTypeFor(const std::string& fileNameStr) {
    const std::string ext = fileExtension(fileNameStr); // lowercased, includes dot
    if (ext == ".html" || ext == ".htm")
        return "text/html; charset=utf-8";
    if (ext == ".js" || ext == ".mjs")
        return "text/javascript; charset=utf-8";
    if (ext == ".css")
        return "text/css; charset=utf-8";
    if (ext == ".svg")
        return "image/svg+xml";
    if (ext == ".png")
        return "image/png";
    if (ext == ".woff2")
        return "font/woff2";
    if (ext == ".json")
        return "application/json; charset=utf-8";
    if (ext == ".map")
        return "application/json; charset=utf-8";
    // Safe extras commonly present in Vite output.
    if (ext == ".ico")
        return "image/x-icon";
    if (ext == ".txt")
        return "text/plain; charset=utf-8";
    if (ext == ".wasm")
        return "application/wasm";
    if (ext == ".jpg" || ext == ".jpeg")
        return "image/jpeg";
    if (ext == ".gif")
        return "image/gif";
    if (ext == ".webp")
        return "image/webp";
    if (ext == ".woff")
        return "font/woff";
    return "application/octet-stream";
}

std::optional<StaticFiles::File> StaticFiles::load(const std::string& relPath) const {
    if (root_.empty())
        return std::nullopt;
    const std::string full = pathJoin(root_, relPath);
    std::string body;
    if (!readWholeFile(full, body))
        return std::nullopt;
    File out;
    out.body = std::move(body);
    const std::string name = fileName(relPath);
    out.contentType = contentTypeFor(name);
    out.cacheControl = iequals(name, "index.html") ? "no-cache" : "public, max-age=3600";
    return out;
}

std::optional<StaticFiles::File> StaticFiles::get(const std::string& urlPath) const {
    std::vector<std::string> segments;
    if (!sanitizeSegments(urlPath, segments))
        return std::nullopt; // traversal attempt -> 404 at the caller

    if (segments.empty())
        return load("index.html"); // "/"

    std::string rel;
    for (const auto& s : segments) {
        if (!rel.empty())
            rel += '\\';
        rel += s;
    }

    if (auto f = load(rel))
        return f;

    // SPA fallback: unknown path whose final segment has no extension serves the app
    // shell (client-side routing). Paths WITH extensions are genuine 404s.
    if (fileExtension(segments.back()).empty())
        return load("index.html");

    return std::nullopt;
}

} // namespace mydaw
