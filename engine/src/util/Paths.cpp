// MyDAW — util/Paths.cpp

#include "util/Paths.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <algorithm>
#include <cctype>
#include <vector>

namespace mydaw {

namespace {

bool isSep(char c) { return c == '\\' || c == '/'; }
bool isSepW(wchar_t c) { return c == L'\\' || c == L'/'; }

} // namespace

std::wstring utf8ToWide(std::string_view utf8) {
    if (utf8.empty())
        return std::wstring();
    const int len = ::MultiByteToWideChar(CP_UTF8, 0, utf8.data(),
                                          static_cast<int>(utf8.size()), nullptr, 0);
    if (len <= 0)
        return std::wstring();
    std::wstring out(static_cast<size_t>(len), L'\0');
    ::MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()),
                          out.data(), len);
    return out;
}

std::string wideToUtf8(std::wstring_view wide) {
    if (wide.empty())
        return std::string();
    const int len = ::WideCharToMultiByte(CP_UTF8, 0, wide.data(),
                                          static_cast<int>(wide.size()),
                                          nullptr, 0, nullptr, nullptr);
    if (len <= 0)
        return std::string();
    std::string out(static_cast<size_t>(len), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                          out.data(), len, nullptr, nullptr);
    return out;
}

std::string exePath() {
    std::vector<wchar_t> buf(MAX_PATH);
    for (;;) {
        const DWORD n = ::GetModuleFileNameW(nullptr, buf.data(),
                                             static_cast<DWORD>(buf.size()));
        if (n == 0)
            return std::string();
        if (n < buf.size() - 1)
            return wideToUtf8(std::wstring_view(buf.data(), n));
        buf.resize(buf.size() * 2); // path was truncated; grow and retry
    }
}

std::string exeDir() {
    return parentDir(exePath());
}

std::string appDataDir() {
    static std::string cached = [] {
        std::wstring appData;
        DWORD need = ::GetEnvironmentVariableW(L"APPDATA", nullptr, 0);
        if (need > 0) {
            appData.resize(need);
            const DWORD got = ::GetEnvironmentVariableW(L"APPDATA", appData.data(), need);
            appData.resize(got);
        }
        std::string base = appData.empty() ? exeDir() : wideToUtf8(appData);
        std::string dir = pathJoin(base, "MyDAW");
        ensureDir(dir);
        return dir;
    }();
    return cached;
}

std::string pathJoin(std::string_view a, std::string_view b) {
    while (!b.empty() && isSep(b.front()))
        b.remove_prefix(1);
    if (a.empty())
        return std::string(b);
    if (b.empty())
        return std::string(a);
    std::string out(a);
    while (!out.empty() && isSep(out.back()))
        out.pop_back();
    out.push_back('\\');
    out.append(b);
    return out;
}

bool ensureDir(const std::string& utf8Path) {
    if (utf8Path.empty())
        return false;
    const std::wstring wide = utf8ToWide(utf8Path);
    if (wide.empty())
        return false;
    if (dirExists(utf8Path))
        return true;
    // Walk components, creating each level. Skip drive root ("C:") and UNC prefixes.
    size_t i = 0;
    if (wide.size() >= 2 && wide[1] == L':')
        i = 2;
    else if (wide.size() >= 2 && isSepW(wide[0]) && isSepW(wide[1])) {
        // \\server\share — skip server and share names.
        i = 2;
        int comps = 0;
        while (i < wide.size() && comps < 2) {
            while (i < wide.size() && !isSepW(wide[i])) ++i;
            ++comps;
            while (i < wide.size() && isSepW(wide[i])) ++i;
        }
    }
    while (i < wide.size()) {
        while (i < wide.size() && isSepW(wide[i])) ++i;
        while (i < wide.size() && !isSepW(wide[i])) ++i;
        const std::wstring partial = wide.substr(0, i);
        if (partial.empty())
            continue;
        if (!::CreateDirectoryW(partial.c_str(), nullptr)) {
            const DWORD err = ::GetLastError();
            if (err != ERROR_ALREADY_EXISTS && err != ERROR_ACCESS_DENIED)
                return false;
            // ERROR_ACCESS_DENIED can occur for roots like "C:\" — keep walking;
            // the final dirExists() check decides success.
        }
    }
    return dirExists(utf8Path);
}

bool fileExists(const std::string& utf8Path) {
    const DWORD attrs = ::GetFileAttributesW(utf8ToWide(utf8Path).c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}

bool dirExists(const std::string& utf8Path) {
    const DWORD attrs = ::GetFileAttributesW(utf8ToWide(utf8Path).c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY);
}

std::string parentDir(std::string_view path) {
    size_t end = path.size();
    while (end > 0 && isSep(path[end - 1])) --end; // ignore trailing separators
    size_t i = end;
    while (i > 0 && !isSep(path[i - 1])) --i;
    while (i > 0 && isSep(path[i - 1])) --i; // drop the separator itself
    if (i == 0) {
        // Keep drive roots intact: parentDir("C:\\foo") -> "C:\\".
        if (path.size() >= 2 && path[1] == ':')
            return std::string(path.substr(0, 2)) + "\\";
        return std::string();
    }
    // Re-add backslash for bare drive ("C:" -> "C:\").
    if (i == 2 && path[1] == ':')
        return std::string(path.substr(0, 2)) + "\\";
    return std::string(path.substr(0, i));
}

std::string fileName(std::string_view path) {
    size_t end = path.size();
    while (end > 0 && isSep(path[end - 1])) --end;
    size_t i = end;
    while (i > 0 && !isSep(path[i - 1])) --i;
    return std::string(path.substr(i, end - i));
}

std::string fileExtension(std::string_view path) {
    const std::string name = fileName(path);
    const size_t dot = name.find_last_of('.');
    if (dot == std::string::npos || dot == 0)
        return std::string();
    std::string ext = name.substr(dot);
    std::transform(ext.begin(), ext.end(), ext.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return ext;
}

} // namespace mydaw
