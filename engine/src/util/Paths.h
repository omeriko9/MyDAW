// MyDAW — util/Paths.h
// Filesystem path helpers: executable location, %APPDATA%/MyDAW app dir (created on demand),
// UTF-8 <-> UTF-16 conversion (all engine-internal strings are UTF-8; Win32 calls use wide),
// and path joining. Implemented in Paths.cpp. Non-RT only.

#pragma once

#include <string>
#include <string_view>

namespace mydaw {

// UTF-8 -> UTF-16 (Win32 wide). Invalid sequences are replaced, never throws.
std::wstring utf8ToWide(std::string_view utf8);

// UTF-16 -> UTF-8.
std::string wideToUtf8(std::wstring_view wide);

// Full path of the running executable (UTF-8, backslash separators).
std::string exePath();

// Directory containing the running executable (UTF-8, no trailing separator).
std::string exeDir();

// %APPDATA%/MyDAW (UTF-8, no trailing separator). Created (recursively) on first call.
// Falls back to exeDir() if APPDATA cannot be resolved.
std::string appDataDir();

// Joins two path fragments with a single backslash, tolerating trailing/leading
// separators on either side. Empty `a` returns `b` and vice versa.
std::string pathJoin(std::string_view a, std::string_view b);

// Recursively creates a directory. Returns true if it exists afterwards.
bool ensureDir(const std::string& utf8Path);

bool fileExists(const std::string& utf8Path);
bool dirExists(const std::string& utf8Path);

// Parent directory of `path` (no trailing separator); "" if none.
std::string parentDir(std::string_view path);

// Final component of `path` (after the last slash/backslash).
std::string fileName(std::string_view path);

// Lowercased extension including the dot (".wav"); "" if none.
std::string fileExtension(std::string_view path);

} // namespace mydaw
