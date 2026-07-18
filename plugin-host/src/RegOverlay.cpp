//
// plugin-host/src/RegOverlay.cpp — see RegOverlay.h (SPEC §8.5).
//
// Per-plugin capture virtualization for the dedicated single-plugin host. A capture bundle
// (install.reg and/or files\<DRIVE>\... mirror) is parsed into an in-memory tree; MinHook inline
// hooks on the Win32 Reg* API serve reads overlay-first with read-through to the real machine
// registry, route writes into the overlay only (never the machine), rebase absolute paths in
// the .reg onto the bundle, and redirect selected Win32 file APIs into the files mirror. The
// host hosts ONE plugin, so process-global hooking is safe.
//
// Mechanism notes:
//   * advapi32!Reg* are NOT forwarders to kernelbase on Win10/11 — they are independent
//     implementations, so we hook the export in BOTH modules (a plugin may bind to either).
//   * A per-thread recursion guard makes read-through trampoline calls (and the advapi32
//     wrapper -> kernelbase impl re-entry) pass straight through without re-running overlay
//     logic, avoiding self-recursion under the single overlay mutex.
//   * Synthetic HKEYs we hand out are the addresses of our own Ctx objects, tracked in a set;
//     any HKEY not in that set is a predefined root (served as overlay root) or a foreign real
//     handle (forwarded verbatim).
//
#include "RegOverlay.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winsock2.h>   // POS tunnel to the live dongle (MYDAW_POS_TUNNEL)
#include <ws2tcpip.h>
#include <objbase.h>
#include <oleauto.h>
#include <winuser.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <fstream>
#include <map>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "MinHook.h"
#include "PosReplayData.h"  // XP-captured IPOS::receiveTransferObject blobs (driverless replay)

namespace mydaw {
namespace {

// ===========================================================================
// Trace (mirrors MYDAW_VST2_TRACE)
// ===========================================================================
bool regTrace() {
  static const bool on = [] {
    char b[8];
    return GetEnvironmentVariableA("MYDAW_REG_TRACE", b, sizeof(b)) > 0;
  }();
  return on;
}
void tracef(const char* fmt, ...) {
  if (!regTrace()) return;
  va_list ap;
  va_start(ap, fmt);
  std::vfprintf(stderr, fmt, ap);
  va_end(ap);
}
bool dialogTrace() {
  static const bool on = [] {
    char b[8];
    return GetEnvironmentVariableA("MYDAW_DIALOG_TRACE", b, sizeof(b)) > 0;
  }();
  return on;
}
bool dialogAutoDismiss() {
  static const bool on = [] {
    char b[8];
    return GetEnvironmentVariableA("MYDAW_DIALOG_AUTODISMISS", b, sizeof(b)) > 0;
  }();
  return on;
}
void dialogf(const char* fmt, ...) {
  if (!dialogTrace()) return;
  va_list ap;
  va_start(ap, fmt);
  std::vfprintf(stderr, fmt, ap);
  va_end(ap);
}

// ===========================================================================
// Small string helpers
// ===========================================================================
std::wstring lc(std::wstring s) {
  for (wchar_t& c : s) c = (wchar_t)towlower(c);
  return s;
}
std::wstring aToW(const char* s, int len = -1) {
  if (!s) return {};
  int n = MultiByteToWideChar(CP_ACP, 0, s, len, nullptr, 0);
  if (n <= 0) return {};
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_ACP, 0, s, len, w.data(), n);
  if (len == -1 && !w.empty() && w.back() == L'\0') w.pop_back();
  return w;
}
std::string wToA(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_ACP, 0, w.c_str(), (int)w.size(), nullptr, 0,
                              nullptr, nullptr);
  std::string s(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_ACP, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr,
                      nullptr);
  return s;
}
std::vector<std::wstring> splitPath(const std::wstring& p) {
  std::vector<std::wstring> out;
  std::wstring cur;
  for (wchar_t c : p) {
    if (c == L'\\' || c == L'/') {
      if (!cur.empty()) { out.push_back(cur); cur.clear(); }
    } else {
      cur.push_back(c);
    }
  }
  if (!cur.empty()) out.push_back(cur);
  return out;
}
bool pathExists(const std::wstring& p) {
  return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES;
}
std::wstring joinComps(const std::vector<std::wstring>& comps) {
  std::wstring out;
  for (size_t i = 0; i < comps.size(); ++i) {
    if (i) out += L"\\";
    out += comps[i];
  }
  return out;
}
const wchar_t* traceRootName(HKEY r) {
  if (r == HKEY_LOCAL_MACHINE) return L"HKEY_LOCAL_MACHINE";
  if (r == HKEY_CURRENT_USER) return L"HKEY_CURRENT_USER";
  if (r == HKEY_CLASSES_ROOT) return L"HKEY_CLASSES_ROOT";
  if (r == HKEY_USERS) return L"HKEY_USERS";
  if (r == HKEY_CURRENT_CONFIG) return L"HKEY_CURRENT_CONFIG";
  return L"(null)";
}

// ===========================================================================
// Overlay model
// ===========================================================================
struct Val {
  std::wstring name;          // original-case value name ("" = default)
  DWORD type = REG_SZ;
  std::vector<BYTE> data;     // exact bytes as RegQueryValueEx would return (W form)
  bool tomb = false;          // deleted value
  bool local = false;         // written at runtime / loaded from .local (persisted)
};
struct Key {
  std::wstring name;          // original-case leaf name
  bool tombstone = false;     // deleted key
  bool local = false;
  std::map<std::wstring, Key> subkeys;  // key: lowercased leaf
  std::map<std::wstring, Val> values;   // key: lowercased value name ("" = default)
};

// Predefined roots we model (HKCR/HKCU/HKLM/HKU/HKCC).
bool isPredefRoot(HKEY h) {
  auto v = reinterpret_cast<ULONG_PTR>(h);
  return v >= 0x80000000 && v <= 0x80000005;
}

struct Ctx {
  HKEY root = nullptr;                  // predefined root this resolves under
  std::vector<std::wstring> path;       // lowercased components below root
  HKEY real = nullptr;                  // owned real handle for read-through, or null
  REGSAM sam = 0;
  bool enumKeysBuilt = false;
  std::vector<std::wstring> enumKeys;   // merged subkey names (original case)
  bool enumValsBuilt = false;
  std::vector<Val> enumVals;            // merged values (with W data)
};

// ===========================================================================
// Real Reg* trampolines (canonical originals — prefer kernelbase impl)
// ===========================================================================
struct RealApi {
  LSTATUS(WINAPI* RegOpenKeyExW)(HKEY, LPCWSTR, DWORD, REGSAM, PHKEY) = nullptr;
  LSTATUS(WINAPI* RegOpenKeyExA)(HKEY, LPCSTR, DWORD, REGSAM, PHKEY) = nullptr;
  LSTATUS(WINAPI* RegOpenKeyW)(HKEY, LPCWSTR, PHKEY) = nullptr;
  LSTATUS(WINAPI* RegOpenKeyA)(HKEY, LPCSTR, PHKEY) = nullptr;
  LSTATUS(WINAPI* RegCreateKeyExW)(HKEY, LPCWSTR, DWORD, LPWSTR, DWORD, REGSAM,
                                   const LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD) = nullptr;
  LSTATUS(WINAPI* RegCreateKeyExA)(HKEY, LPCSTR, DWORD, LPSTR, DWORD, REGSAM,
                                   const LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD) = nullptr;
  LSTATUS(WINAPI* RegCreateKeyW)(HKEY, LPCWSTR, PHKEY) = nullptr;
  LSTATUS(WINAPI* RegCreateKeyA)(HKEY, LPCSTR, PHKEY) = nullptr;
  LSTATUS(WINAPI* RegQueryValueExW)(HKEY, LPCWSTR, LPDWORD, LPDWORD, LPBYTE, LPDWORD) = nullptr;
  LSTATUS(WINAPI* RegQueryValueExA)(HKEY, LPCSTR, LPDWORD, LPDWORD, LPBYTE, LPDWORD) = nullptr;
  LSTATUS(WINAPI* RegQueryValueW)(HKEY, LPCWSTR, LPWSTR, PLONG) = nullptr;
  LSTATUS(WINAPI* RegQueryValueA)(HKEY, LPCSTR, LPSTR, PLONG) = nullptr;
  LSTATUS(WINAPI* RegGetValueW)(HKEY, LPCWSTR, LPCWSTR, DWORD, LPDWORD, PVOID, LPDWORD) = nullptr;
  LSTATUS(WINAPI* RegGetValueA)(HKEY, LPCSTR, LPCSTR, DWORD, LPDWORD, PVOID, LPDWORD) = nullptr;
  LSTATUS(WINAPI* RegSetValueExW)(HKEY, LPCWSTR, DWORD, DWORD, const BYTE*, DWORD) = nullptr;
  LSTATUS(WINAPI* RegSetValueExA)(HKEY, LPCSTR, DWORD, DWORD, const BYTE*, DWORD) = nullptr;
  LSTATUS(WINAPI* RegEnumKeyExW)(HKEY, DWORD, LPWSTR, LPDWORD, LPDWORD, LPWSTR, LPDWORD, PFILETIME) = nullptr;
  LSTATUS(WINAPI* RegEnumKeyExA)(HKEY, DWORD, LPSTR, LPDWORD, LPDWORD, LPSTR, LPDWORD, PFILETIME) = nullptr;
  LSTATUS(WINAPI* RegEnumKeyW)(HKEY, DWORD, LPWSTR, DWORD) = nullptr;
  LSTATUS(WINAPI* RegEnumKeyA)(HKEY, DWORD, LPSTR, DWORD) = nullptr;
  LSTATUS(WINAPI* RegEnumValueW)(HKEY, DWORD, LPWSTR, LPDWORD, LPDWORD, LPDWORD, LPBYTE, LPDWORD) = nullptr;
  LSTATUS(WINAPI* RegEnumValueA)(HKEY, DWORD, LPSTR, LPDWORD, LPDWORD, LPDWORD, LPBYTE, LPDWORD) = nullptr;
  LSTATUS(WINAPI* RegQueryInfoKeyW)(HKEY, LPWSTR, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD,
                                    LPDWORD, LPDWORD, LPDWORD, LPDWORD, PFILETIME) = nullptr;
  LSTATUS(WINAPI* RegQueryInfoKeyA)(HKEY, LPSTR, LPDWORD, LPDWORD, LPDWORD, LPDWORD, LPDWORD,
                                    LPDWORD, LPDWORD, LPDWORD, LPDWORD, PFILETIME) = nullptr;
  LSTATUS(WINAPI* RegDeleteValueW)(HKEY, LPCWSTR) = nullptr;
  LSTATUS(WINAPI* RegDeleteValueA)(HKEY, LPCSTR) = nullptr;
  LSTATUS(WINAPI* RegDeleteKeyW)(HKEY, LPCWSTR) = nullptr;
  LSTATUS(WINAPI* RegDeleteKeyA)(HKEY, LPCSTR) = nullptr;
  LSTATUS(WINAPI* RegOpenUserClassesRoot)(HANDLE, DWORD, REGSAM, PHKEY) = nullptr;
  LSTATUS(WINAPI* RegCloseKey)(HKEY) = nullptr;
  LSTATUS(WINAPI* RegFlushKey)(HKEY) = nullptr;
  HANDLE(WINAPI* CreateFileW)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD,
                              HANDLE) = nullptr;
  HANDLE(WINAPI* CreateFileA)(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD,
                              HANDLE) = nullptr;
  DWORD(WINAPI* GetFileAttributesW)(LPCWSTR) = nullptr;
  DWORD(WINAPI* GetFileAttributesA)(LPCSTR) = nullptr;
  BOOL(WINAPI* GetFileAttributesExW)(LPCWSTR, GET_FILEEX_INFO_LEVELS, LPVOID) = nullptr;
  BOOL(WINAPI* GetFileAttributesExA)(LPCSTR, GET_FILEEX_INFO_LEVELS, LPVOID) = nullptr;
  HANDLE(WINAPI* FindFirstFileW)(LPCWSTR, LPWIN32_FIND_DATAW) = nullptr;
  HANDLE(WINAPI* FindFirstFileA)(LPCSTR, LPWIN32_FIND_DATAA) = nullptr;
  HANDLE(WINAPI* FindFirstFileExW)(LPCWSTR, FINDEX_INFO_LEVELS, LPVOID, FINDEX_SEARCH_OPS,
                                   LPVOID, DWORD) = nullptr;
  HANDLE(WINAPI* FindFirstFileExA)(LPCSTR, FINDEX_INFO_LEVELS, LPVOID, FINDEX_SEARCH_OPS,
                                   LPVOID, DWORD) = nullptr;
  BOOL(WINAPI* DeleteFileW)(LPCWSTR) = nullptr;
  BOOL(WINAPI* DeleteFileA)(LPCSTR) = nullptr;
  HMODULE(WINAPI* LoadLibraryW)(LPCWSTR) = nullptr;
  HMODULE(WINAPI* LoadLibraryA)(LPCSTR) = nullptr;
  HMODULE(WINAPI* LoadLibraryExW)(LPCWSTR, HANDLE, DWORD) = nullptr;
  HMODULE(WINAPI* LoadLibraryExA)(LPCSTR, HANDLE, DWORD) = nullptr;
  HRESULT(WINAPI* CoCreateInstance)(REFCLSID, IUnknown*, DWORD, REFIID, LPVOID*) = nullptr;
  int(WINAPI* MessageBoxW)(HWND, LPCWSTR, LPCWSTR, UINT) = nullptr;
  int(WINAPI* MessageBoxA)(HWND, LPCSTR, LPCSTR, UINT) = nullptr;
};
RealApi g_real;

// ===========================================================================
// Global overlay state
// ===========================================================================
// These three are INTENTIONALLY immortal (leaked heap, never destructed): the Reg* hooks
// stay live for the whole process, including CRT/OLE static teardown (CoUninitialize reads
// the registry at exit). If this state were destroyed first, a late detour call would touch
// a dead mutex/map and crash on the way out. References keep every use site unchanged.
std::recursive_mutex& g_mu = *new std::recursive_mutex();  // guards the tree + handle table
bool g_armed = false;
std::map<HKEY, Key>& g_roots = *new std::map<HKEY, Key>();        // HKCR/HKCU/HKLM/HKU/HKCC
std::unordered_set<void*>& g_handles = *new std::unordered_set<void*>();  // cookies we issued
std::wstring g_regPath, g_localPath, g_bundleRoot, g_mirrorRoot, g_classesSidecar;
bool g_dirty = false;
bool g_regOverlayActive = false;
bool g_fileOverlayActive = false;
std::vector<std::wstring>& g_tempUserClassesLeaves = *new std::vector<std::wstring>();
std::unordered_set<std::wstring>& g_allowedUserClassesPaths =
    *new std::unordered_set<std::wstring>();

// Per-thread re-entrancy guard: while >0 we are inside our own overlay logic (or a
// read-through trampoline call), so detours pass straight through to the real API.
thread_local int g_depth = 0;
struct Reenter {
  Reenter() { ++g_depth; }
  ~Reenter() { --g_depth; }
};

struct NativeKeyNameInfo {
  ULONG NameLength;
  WCHAR Name[1];
};

// ===========================================================================
// File mirror redirection
// ===========================================================================
bool isDriveAbs(const std::wstring& p) {
  return p.size() >= 3 && iswalpha(p[0]) && p[1] == L':' &&
         (p[2] == L'\\' || p[2] == L'/');
}
std::wstring parentOf(const std::wstring& p) {
  size_t s = p.find_last_of(L"\\/");
  return s == std::wstring::npos ? std::wstring() : p.substr(0, s);
}
bool hasWildcard(const std::wstring& p) {
  return p.find_first_of(L"*?") != std::wstring::npos;
}
bool realPathExists(const std::wstring& p) {
  Reenter re;
  if (g_real.GetFileAttributesW)
    return g_real.GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES;
  return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES;
}
HANDLE realFindFirstFileW(const std::wstring& pattern, WIN32_FIND_DATAW* data) {
  Reenter re;
  if (g_real.FindFirstFileW) return g_real.FindFirstFileW(pattern.c_str(), data);
  return FindFirstFileW(pattern.c_str(), data);
}
std::wstring mirrorCandidate(const std::wstring& p) {
  if (g_mirrorRoot.empty() || !isDriveAbs(p)) return {};
  return g_mirrorRoot + L"\\" + p[0] + p.substr(2);
}
bool resolveMirrorChild(const std::wstring& parent, const std::wstring& leaf,
                        std::wstring& resolvedLeaf) {
  WIN32_FIND_DATAW data{};
  HANDLE h = realFindFirstFileW(parent + L"\\*", &data);
  if (h == INVALID_HANDLE_VALUE) return false;
  const std::wstring want = lc(leaf);
  bool found = false;
  do {
    if (data.cFileName[0] == 0) continue;
    if (std::wcscmp(data.cFileName, L".") == 0 ||
        std::wcscmp(data.cFileName, L"..") == 0)
      continue;
    const std::wstring name = lc(data.cFileName);
    const std::wstring alias =
        data.cAlternateFileName[0] ? lc(data.cAlternateFileName) : std::wstring();
    if (name == want || (!alias.empty() && alias == want)) {
      resolvedLeaf = data.cFileName;
      found = true;
      break;
    }
  } while (FindNextFileW(h, &data));
  FindClose(h);
  return found;
}
bool resolveMirrorPath(const std::wstring& candidate, bool allowMissingLeaf,
                       std::wstring& resolved) {
  if (candidate.empty()) return false;
  if (candidate.size() < g_mirrorRoot.size()) return false;
  std::wstring rel = candidate.substr(g_mirrorRoot.size());
  while (!rel.empty() && (rel[0] == L'\\' || rel[0] == L'/')) rel.erase(rel.begin());
  std::vector<std::wstring> comps = splitPath(rel);
  if (comps.empty()) return false;

  std::wstring cur = g_mirrorRoot;
  for (size_t i = 0; i < comps.size(); ++i) {
    const bool last = i + 1 == comps.size();
    const std::wstring direct = cur + L"\\" + comps[i];
    if (realPathExists(direct)) {
      cur = direct;
      continue;
    }
    std::wstring mapped;
    if (resolveMirrorChild(cur, comps[i], mapped)) {
      cur += L"\\" + mapped;
      continue;
    }
    if (allowMissingLeaf && last && realPathExists(cur)) {
      resolved = cur + L"\\" + comps[i];
      return true;
    }
    return false;
  }
  resolved = cur;
  return true;
}
bool redirectFilePathW(LPCWSTR path, std::wstring& out) {
  if (!path || !g_fileOverlayActive || g_mirrorRoot.empty()) return false;
  std::wstring original(path);
  std::wstring cand = mirrorCandidate(original);
  if (cand.empty()) return false;

  if (hasWildcard(cand)) {
    std::wstring parent = parentOf(cand), resolvedParent;
    if (!parent.empty() && resolveMirrorPath(parent, false, resolvedParent)) {
      out = resolvedParent + L"\\" + cand.substr(parent.size() + 1);
      tracef("[fileov] redirect %ls -> %ls\n", original.c_str(), out.c_str());
      return true;
    }
    return false;
  }

  if (resolveMirrorPath(cand, false, out)) {
    tracef("[fileov] redirect %ls -> %ls\n", original.c_str(), out.c_str());
    return true;
  }

  return false;
}
bool redirectFilePathA(LPCSTR path, std::string& outA) {
  if (!path) return false;
  std::wstring outW;
  if (!redirectFilePathW(aToW(path).c_str(), outW)) return false;
  outA = wToA(outW);
  return true;
}

// ===========================================================================
// .reg parsing
// ===========================================================================
std::wstring readRegFileAsWide(const std::wstring& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return {};
  std::string raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  if (raw.size() >= 2 && (BYTE)raw[0] == 0xFF && (BYTE)raw[1] == 0xFE) {
    // UTF-16LE
    const wchar_t* p = reinterpret_cast<const wchar_t*>(raw.data() + 2);
    size_t n = (raw.size() - 2) / sizeof(wchar_t);
    return std::wstring(p, n);
  }
  UINT cp = CP_ACP;
  size_t off = 0;
  if (raw.size() >= 3 && (BYTE)raw[0] == 0xEF && (BYTE)raw[1] == 0xBB && (BYTE)raw[2] == 0xBF) {
    cp = CP_UTF8;
    off = 3;
  }
  int n = MultiByteToWideChar(cp, 0, raw.data() + off, (int)(raw.size() - off), nullptr, 0);
  std::wstring w(static_cast<size_t>(n < 0 ? 0 : n), L'\0');
  if (n > 0)
    MultiByteToWideChar(cp, 0, raw.data() + off, (int)(raw.size() - off), w.data(), n);
  return w;
}

std::wstring trim(const std::wstring& s) {
  size_t a = s.find_first_not_of(L" \t\r\n");
  if (a == std::wstring::npos) return {};
  size_t b = s.find_last_not_of(L" \t\r\n");
  return s.substr(a, b - a + 1);
}

HKEY rootFromName(const std::wstring& nameUpper) {
  if (nameUpper == L"HKEY_LOCAL_MACHINE" || nameUpper == L"HKLM") return HKEY_LOCAL_MACHINE;
  if (nameUpper == L"HKEY_CURRENT_USER" || nameUpper == L"HKCU") return HKEY_CURRENT_USER;
  if (nameUpper == L"HKEY_CLASSES_ROOT" || nameUpper == L"HKCR") return HKEY_CLASSES_ROOT;
  if (nameUpper == L"HKEY_USERS" || nameUpper == L"HKU") return HKEY_USERS;
  if (nameUpper == L"HKEY_CURRENT_CONFIG" || nameUpper == L"HKCC") return HKEY_CURRENT_CONFIG;
  return nullptr;
}

// Rebase a path-like string onto the bundle: %BUNDLE%/%MIRROR% macros, then X:\... ->
// <mirror>\X\... when that target exists on disk (auto-rebase only when present).
std::wstring rebase(std::wstring v) {
  auto replaceAll = [](std::wstring s, const std::wstring& from, const std::wstring& to) {
    if (from.empty()) return s;
    for (size_t p = s.find(from); p != std::wstring::npos; p = s.find(from, p + to.size()))
      s.replace(p, from.size(), to);
    return s;
  };
  v = replaceAll(v, L"%BUNDLE%", g_bundleRoot);
  v = replaceAll(v, L"%MIRROR%", g_mirrorRoot);
  if (!g_mirrorRoot.empty() && v.size() >= 3 && iswalpha(v[0]) && v[1] == L':' &&
      (v[2] == L'\\' || v[2] == L'/')) {
    std::wstring cand = g_mirrorRoot + L"\\" + v[0] + v.substr(2);
    std::wstring resolved;
    if (resolveMirrorPath(cand, false, resolved)) return resolved;
  }
  return v;
}

void encodeString(Val& val, std::wstring s, DWORD type) {
  if (type == REG_SZ || type == REG_EXPAND_SZ) s = rebase(s);
  val.type = type;
  val.data.assign(reinterpret_cast<const BYTE*>(s.c_str()),
                  reinterpret_cast<const BYTE*>(s.c_str()) + (s.size() + 1) * sizeof(wchar_t));
}

std::vector<BYTE> parseHexBytes(const std::wstring& s) {
  std::vector<BYTE> out;
  int hi = -1;
  for (wchar_t c : s) {
    int d = -1;
    if (c >= L'0' && c <= L'9') d = c - L'0';
    else if (c >= L'a' && c <= L'f') d = c - L'a' + 10;
    else if (c >= L'A' && c <= L'F') d = c - L'A' + 10;
    else continue;
    if (hi < 0) hi = d;
    else { out.push_back((BYTE)((hi << 4) | d)); hi = -1; }
  }
  return out;
}

// Parse one value spec (RHS of '='); already line-joined for hex continuations.
void parseValueSpec(std::wstring spec, Val& val) {
  spec = trim(spec);
  if (spec == L"-") { val.tomb = true; return; }
  if (!spec.empty() && spec[0] == L'"') {
    // quoted string with \\ and \" escapes
    std::wstring out;
    for (size_t i = 1; i < spec.size(); ++i) {
      wchar_t c = spec[i];
      if (c == L'\\' && i + 1 < spec.size()) { out.push_back(spec[++i]); continue; }
      if (c == L'"') break;
      out.push_back(c);
    }
    encodeString(val, out, REG_SZ);
    return;
  }
  if (spec.rfind(L"dword:", 0) == 0) {
    DWORD d = (DWORD)wcstoul(spec.c_str() + 6, nullptr, 16);
    val.type = REG_DWORD;
    val.data.assign(reinterpret_cast<BYTE*>(&d), reinterpret_cast<BYTE*>(&d) + 4);
    return;
  }
  if (spec.rfind(L"hex(", 0) == 0) {
    size_t close = spec.find(L')');
    DWORD t = (DWORD)wcstoul(spec.c_str() + 4, nullptr, 16);
    size_t colon = spec.find(L':', close == std::wstring::npos ? 0 : close);
    std::vector<BYTE> bytes =
        colon == std::wstring::npos ? std::vector<BYTE>() : parseHexBytes(spec.substr(colon + 1));
    val.type = t;
    val.data = std::move(bytes);
    // Rebase strings stored as hex (EXPAND_SZ/SZ): decode, rebase, re-encode.
    if ((t == REG_EXPAND_SZ || t == REG_SZ) && val.data.size() >= sizeof(wchar_t)) {
      std::wstring s(reinterpret_cast<const wchar_t*>(val.data.data()),
                     val.data.size() / sizeof(wchar_t));
      if (!s.empty() && s.back() == L'\0') s.pop_back();
      encodeString(val, s, t);
    }
    return;
  }
  if (spec.rfind(L"hex:", 0) == 0) {
    val.type = REG_BINARY;
    val.data = parseHexBytes(spec.substr(4));
    return;
  }
  // Unknown form — keep as a literal string, best effort.
  encodeString(val, spec, REG_SZ);
}

Key* descend(HKEY root, const std::vector<std::wstring>& comps, bool create) {
  auto it = g_roots.find(root);
  if (it == g_roots.end()) return nullptr;
  Key* cur = &it->second;
  for (const std::wstring& c : comps) {
    std::wstring key = lc(c);
    auto sub = cur->subkeys.find(key);
    if (sub == cur->subkeys.end()) {
      if (!create) return nullptr;
      Key& nk = cur->subkeys[key];
      nk.name = c;
      cur = &nk;
    } else {
      cur = &sub->second;
    }
  }
  return cur;
}

void parseRegInto(const std::wstring& path, bool markLocal) {
  std::wstring text = readRegFileAsWide(path);
  if (text.empty()) return;

  // Split into raw lines, then join hex-continuation lines (trailing backslash).
  std::vector<std::wstring> raw;
  {
    std::wstring cur;
    for (wchar_t c : text) {
      if (c == L'\n') { raw.push_back(cur); cur.clear(); }
      else if (c != L'\r') cur.push_back(c);
    }
    if (!cur.empty()) raw.push_back(cur);
  }
  std::vector<std::wstring> lines;
  for (size_t i = 0; i < raw.size(); ++i) {
    std::wstring ln = raw[i];
    std::wstring rt = ln;
    // strip trailing whitespace for continuation detection
    while (!rt.empty() && (rt.back() == L' ' || rt.back() == L'\t')) rt.pop_back();
    while (!rt.empty() && rt.back() == L'\\' && i + 1 < raw.size()) {
      rt.pop_back();
      std::wstring nxt = raw[++i];
      // left-trim the continuation
      size_t a = nxt.find_first_not_of(L" \t");
      rt += (a == std::wstring::npos ? L"" : nxt.substr(a));
      while (!rt.empty() && (rt.back() == L' ' || rt.back() == L'\t')) rt.pop_back();
    }
    lines.push_back(rt);
  }

  std::vector<Key*> curs;
  for (std::wstring ln : lines) {
    std::wstring t = trim(ln);
    if (t.empty() || t[0] == L';') continue;
    if (t[0] == L'[') {
      size_t end = t.rfind(L']');
      if (end == std::wstring::npos) continue;
      std::wstring body = t.substr(1, end - 1);
      bool del = false;
      if (!body.empty() && body[0] == L'-') { del = true; body = body.substr(1); }
      auto comps = splitPath(body);
      curs.clear();
      if (comps.empty()) continue;
      std::wstring rootName = comps[0];
      for (wchar_t& c : rootName) c = (wchar_t)towupper(c);
      HKEY root = rootFromName(rootName);
      if (!root) continue;
      std::vector<std::wstring> sub(comps.begin() + 1, comps.end());
      if (Key* cur = descend(root, sub, true)) curs.push_back(cur);
      if (root == HKEY_CLASSES_ROOT) {
        std::vector<std::wstring> clsPath{L"Software", L"Classes"};
        clsPath.insert(clsPath.end(), sub.begin(), sub.end());
        if (Key* cur = descend(HKEY_LOCAL_MACHINE, clsPath, true)) curs.push_back(cur);
        if (Key* cur = descend(HKEY_CURRENT_USER, clsPath, true)) curs.push_back(cur);
      } else if ((root == HKEY_LOCAL_MACHINE || root == HKEY_CURRENT_USER) &&
                 sub.size() >= 2 && lc(sub[0]) == L"software" && lc(sub[1]) == L"classes") {
        // Reverse mirror: HKLM/HKCU\Software\Classes\X is the machine/user class store that
        // HKEY_CLASSES_ROOT merges. Old installers (e.g. Waves' DirectX CLSIDs) register there,
        // but plugins and ole32's own CoCreateInstance lookups open HKCR\CLSID\{...} — so mirror
        // the entry into the HKCR overlay tree too, keeping the views consistent.
        std::vector<std::wstring> hkcrPath(sub.begin() + 2, sub.end());
        if (Key* cur = descend(HKEY_CLASSES_ROOT, hkcrPath, true)) curs.push_back(cur);
      }
      for (Key* cur : curs) {
        if (!cur) continue;
        if (markLocal) cur->local = true;
        cur->tombstone = del ? true : false;
      }
      continue;
    }
    if (curs.empty()) continue;
    // value line: <name>=<spec>, name is "..." or @
    size_t eq;
    std::wstring name;
    if (t[0] == L'@') {
      name.clear();
      eq = t.find(L'=');
    } else if (t[0] == L'"') {
      // find closing quote honoring escapes
      size_t i = 1;
      std::wstring nm;
      for (; i < t.size(); ++i) {
        if (t[i] == L'\\' && i + 1 < t.size()) { nm.push_back(t[++i]); continue; }
        if (t[i] == L'"') break;
        nm.push_back(t[i]);
      }
      name = nm;
      eq = t.find(L'=', i);
    } else {
      continue;
    }
    if (eq == std::wstring::npos) continue;
    Val v;
    v.name = name;
    v.local = markLocal;
    parseValueSpec(t.substr(eq + 1), v);
    for (Key* cur : curs) {
      if (!cur) continue;
      cur->values[lc(name)] = v;
    }
  }
}

// ===========================================================================
// Lookup helpers (lock held)
// ===========================================================================
// Returns the overlay key for (root, comps) if present AND not deleted along the chain.
const Key* findKey(HKEY root, const std::vector<std::wstring>& comps) {
  auto it = g_roots.find(root);
  if (it == g_roots.end()) return nullptr;
  const Key* cur = &it->second;
  if (cur->tombstone) return nullptr;
  for (const std::wstring& c : comps) {
    auto sub = cur->subkeys.find(lc(c));
    if (sub == cur->subkeys.end()) return nullptr;
    cur = &sub->second;
    if (cur->tombstone) return nullptr;
  }
  return cur;
}
const Val* findValue(HKEY root, const std::vector<std::wstring>& comps,
                     const std::wstring& nameLower) {
  const Key* k = findKey(root, comps);
  if (!k) return nullptr;
  auto it = k->values.find(nameLower);
  if (it == k->values.end() || it->second.tomb) return nullptr;
  return &it->second;
}

// ===========================================================================
// Handle table
// ===========================================================================
Ctx* makeCtx(HKEY root, std::vector<std::wstring> path, HKEY real, REGSAM sam) {
  Ctx* c = new Ctx();
  c->root = root;
  c->path = std::move(path);
  c->real = real;
  c->sam = sam;
  g_handles.insert(c);
  return c;
}
Ctx* asCtx(HKEY h) {
  auto it = g_handles.find(reinterpret_cast<void*>(h));
  return it == g_handles.end() ? nullptr : reinterpret_cast<Ctx*>(h);
}
void freeCtx(Ctx* c) {
  g_handles.erase(c);
  if (c->real && !isPredefRoot(c->real) && g_real.RegCloseKey) g_real.RegCloseKey(c->real);
  delete c;
}

// Resolve an incoming HKEY to (overlay root, base path, real handle for read-through).
struct Base {
  bool foreign = false;  // a real handle we did not issue → forward verbatim
  HKEY root = nullptr;
  std::vector<std::wstring> path;
  HKEY real = nullptr;
  REGSAM sam = 0;
};
Base resolveBase(HKEY h) {
  Base b;
  if (Ctx* c = asCtx(h)) {
    b.root = c->root;
    b.path = c->path;
    b.real = c->real;
    b.sam = c->sam;
    return b;
  }
  if (isPredefRoot(h)) {
    b.root = h;
    b.real = h;  // read-through goes against the real predefined root
    return b;
  }
  auto queryNativeKeyPath = [](HKEY key) -> std::wstring {
    using NtQueryKeyFn = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    static NtQueryKeyFn fn = []() -> NtQueryKeyFn {
      HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
      return ntdll ? reinterpret_cast<NtQueryKeyFn>(GetProcAddress(ntdll, "NtQueryKey")) : nullptr;
    }();
    if (!fn) return {};
    ULONG need = 0;
    LONG st = fn(key, 3 /* KeyNameInformation */, nullptr, 0, &need);
    if (need < sizeof(NativeKeyNameInfo)) return {};
    std::vector<BYTE> buf(need);
    st = fn(key, 3 /* KeyNameInformation */, buf.data(), need, &need);
    if (st < 0) return {};
    auto* info = reinterpret_cast<NativeKeyNameInfo*>(buf.data());
    return std::wstring(info->Name, info->NameLength / sizeof(WCHAR));
  };
  auto tryMapForeignPath = [&](const std::wstring& nativePath) -> bool {
    const std::wstring up = lc(nativePath);
    const std::wstring mach = L"\\registry\\machine\\";
    const std::wstring user = L"\\registry\\user\\";
    if (up.rfind(mach, 0) == 0) {
      std::wstring rel = nativePath.substr(mach.size());
      auto comps = splitPath(rel);
      if (comps.empty()) return false;
      if (lc(comps[0]) == L"software" && comps.size() >= 2 && lc(comps[1]) == L"classes") {
        b.root = HKEY_LOCAL_MACHINE;
        b.path.clear();
        for (const auto& c : comps) b.path.push_back(lc(c));
        b.real = h;
        return true;
      }
      b.root = HKEY_LOCAL_MACHINE;
      b.path.clear();
      for (const auto& c : comps) b.path.push_back(lc(c));
      b.real = h;
      return true;
    }
    if (up.rfind(user, 0) == 0) {
      std::wstring rel = nativePath.substr(user.size());
      auto comps = splitPath(rel);
      if (comps.size() < 2) return false;
      const std::wstring sid = lc(comps[0]);
      std::vector<std::wstring> rest(comps.begin() + 1, comps.end());
      if (sid.size() > 8 && sid.find(L"_classes") == sid.size() - 8) {
        b.root = HKEY_CURRENT_USER;
        b.path.clear();
        b.path.push_back(L"software");
        b.path.push_back(L"classes");
        for (const auto& c : rest) b.path.push_back(lc(c));
        b.real = h;
        return true;
      }
      b.root = HKEY_CURRENT_USER;
      b.path.clear();
      for (const auto& c : rest) b.path.push_back(lc(c));
      b.real = h;
      return true;
    }
    return false;
  };
  const std::wstring nativePath = queryNativeKeyPath(h);
  if (!nativePath.empty() && tryMapForeignPath(nativePath)) {
    tracef("[regov] foreign handle mapped %ls -> %ls\\%ls\n", nativePath.c_str(),
           traceRootName(b.root), joinComps(b.path).c_str());
    return b;
  }
  b.foreign = true;
  b.real = h;
  return b;
}

std::vector<std::wstring> joinLower(const std::vector<std::wstring>& base,
                                    const std::wstring& sub) {
  std::vector<std::wstring> out;
  for (const std::wstring& c : base) out.push_back(c);  // already lowercased
  for (const std::wstring& c : splitPath(sub)) out.push_back(lc(c));
  return out;
}

// ===========================================================================
// Two-call buffer protocol helpers
// ===========================================================================
LSTATUS serveBytes(const BYTE* src, DWORD srcLen, DWORD type, LPDWORD pType, LPBYTE data,
                   LPDWORD pcb) {
  if (pType) *pType = type;
  if (!data) {
    if (pcb) *pcb = srcLen;
    return ERROR_SUCCESS;
  }
  if (!pcb) return ERROR_INVALID_PARAMETER;
  DWORD avail = *pcb;
  *pcb = srcLen;
  if (avail < srcLen) return ERROR_MORE_DATA;
  if (srcLen) memcpy(data, src, srcLen);
  return ERROR_SUCCESS;
}

// Serve an overlay value to an ANSI caller (convert string types to CP_ACP).
LSTATUS serveValueA(const Val& v, LPDWORD pType, LPBYTE data, LPDWORD pcb) {
  if (v.type == REG_SZ || v.type == REG_EXPAND_SZ) {
    std::wstring w(reinterpret_cast<const wchar_t*>(v.data.data()),
                   v.data.size() / sizeof(wchar_t));
    if (!w.empty() && w.back() == L'\0') w.pop_back();
    std::string a = wToA(w);
    a.push_back('\0');
    return serveBytes(reinterpret_cast<const BYTE*>(a.data()), (DWORD)a.size(), v.type, pType,
                      data, pcb);
  }
  return serveBytes(v.data.data(), (DWORD)v.data.size(), v.type, pType, data, pcb);
}

// ===========================================================================
// Enumeration snapshot (lock held)
// ===========================================================================
void buildEnumKeys(Ctx* c) {
  if (c->enumKeysBuilt) return;
  c->enumKeysBuilt = true;
  std::unordered_set<std::wstring> seen;
  const Key* node = findKey(c->root, c->path);
  if (node) {
    for (const auto& [klc, sk] : node->subkeys) {
      if (sk.tombstone) { seen.insert(klc); continue; }
      c->enumKeys.push_back(sk.name);
      seen.insert(klc);
    }
  }
  if (c->real && g_real.RegEnumKeyExW) {
    for (DWORD i = 0;; ++i) {
      wchar_t nm[512];
      DWORD cch = 512;
      LSTATUS r = g_real.RegEnumKeyExW(c->real, i, nm, &cch, nullptr, nullptr, nullptr, nullptr);
      if (r != ERROR_SUCCESS) break;
      if (seen.insert(lc(nm)).second) c->enumKeys.emplace_back(nm);
    }
  }
}
void buildEnumVals(Ctx* c) {
  if (c->enumValsBuilt) return;
  c->enumValsBuilt = true;
  std::unordered_set<std::wstring> seen;
  const Key* node = findKey(c->root, c->path);
  if (node) {
    for (const auto& [nlc, v] : node->values) {
      if (v.tomb) { seen.insert(nlc); continue; }
      c->enumVals.push_back(v);
      seen.insert(nlc);
    }
  }
  if (c->real && g_real.RegEnumValueW) {
    for (DWORD i = 0;; ++i) {
      wchar_t nm[512];
      DWORD cch = 512, type = 0, cb = 0;
      LSTATUS r = g_real.RegEnumValueW(c->real, i, nm, &cch, nullptr, &type, nullptr, &cb);
      if (r != ERROR_SUCCESS && r != ERROR_MORE_DATA) break;
      std::wstring nameLc = lc(nm);
      if (!seen.insert(nameLc).second) continue;
      Val v;
      v.name = nm;
      v.type = type;
      v.data.resize(cb);
      DWORD cb2 = cb;
      if (g_real.RegQueryValueExW(c->real, nm, nullptr, &v.type,
                                  cb ? v.data.data() : nullptr, &cb2) == ERROR_SUCCESS)
        v.data.resize(cb2);
      c->enumVals.push_back(std::move(v));
    }
  }
}

// Fill a name buffer per the RegEnum* convention (*pcch = chars excl. null, in/out).
LSTATUS fillNameW(const std::wstring& name, LPWSTR buf, LPDWORD pcch) {
  if (!pcch) return ERROR_INVALID_PARAMETER;
  DWORD need = (DWORD)name.size();
  if (!buf) { *pcch = need; return ERROR_SUCCESS; }
  if (*pcch <= need) { *pcch = need; return ERROR_MORE_DATA; }
  memcpy(buf, name.c_str(), (need + 1) * sizeof(wchar_t));
  *pcch = need;
  return ERROR_SUCCESS;
}
LSTATUS fillNameA(const std::wstring& nameW, LPSTR buf, LPDWORD pcch) {
  if (!pcch) return ERROR_INVALID_PARAMETER;
  std::string a = wToA(nameW);
  DWORD need = (DWORD)a.size();
  if (!buf) { *pcch = need; return ERROR_SUCCESS; }
  if (*pcch <= need) { *pcch = need; return ERROR_MORE_DATA; }
  memcpy(buf, a.c_str(), need + 1);
  *pcch = need;
  return ERROR_SUCCESS;
}

// ===========================================================================
// Detours
// ===========================================================================
// open/create core (wide). create=true materializes the overlay node.
LSTATUS openCore(HKEY h, const std::wstring& subW, REGSAM sam, DWORD opt, PHKEY out,
                 bool create, LPDWORD disp) {
  Base b = resolveBase(h);
  if (regTrace()) {
    tracef("[regov] openCore base=%ls\\%ls sub=%ls foreign=%d create=%d\n",
           traceRootName(b.root), joinComps(b.path).c_str(), subW.c_str(),
           b.foreign ? 1 : 0, create ? 1 : 0);
  }
  if (b.foreign) {
    // Unknown real handle: forward verbatim (no overlay context to apply).
    if (create)
      return g_real.RegCreateKeyExW(h, subW.c_str(), 0, nullptr, opt, sam, nullptr, out, disp);
    return g_real.RegOpenKeyExW(h, subW.c_str(), opt, sam, out);
  }
  std::vector<std::wstring> path = joinLower(b.path, subW);
  const Key* node = findKey(b.root, path);
  bool overlayHas = node != nullptr;

  // Try to open the real counterpart for read-through (never create in the real registry).
  HKEY realOut = nullptr;
  if (b.real && g_real.RegOpenKeyExW) {
    LSTATUS rr = g_real.RegOpenKeyExW(b.real, subW.empty() ? nullptr : subW.c_str(), opt,
                                      sam ? sam : KEY_READ, &realOut);
    if (rr != ERROR_SUCCESS) realOut = nullptr;
  }

  if (create && !overlayHas) {
    Key* nk = descend(b.root, path, true);
    if (nk) { nk->local = true; nk->tombstone = false; g_dirty = true; }
    overlayHas = true;
    if (disp) *disp = realOut ? REG_OPENED_EXISTING_KEY : REG_CREATED_NEW_KEY;
  } else if (disp) {
    *disp = REG_OPENED_EXISTING_KEY;
  }

  if (!overlayHas && !realOut) return ERROR_FILE_NOT_FOUND;
  if (b.root == HKEY_CLASSES_ROOT && realOut) {
    *out = realOut;
    return ERROR_SUCCESS;
  }
  Ctx* c = makeCtx(b.root, path, realOut, sam);
  *out = reinterpret_cast<HKEY>(c);
  return ERROR_SUCCESS;
}

LSTATUS WINAPI Det_RegOpenKeyExW(HKEY h, LPCWSTR sub, DWORD opt, REGSAM sam, PHKEY out) {
  if (g_depth > 0 || !g_armed) return g_real.RegOpenKeyExW(h, sub, opt, sam, out);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (!out) return ERROR_INVALID_PARAMETER;
  LSTATUS r = openCore(h, sub ? sub : L"", sam, opt, out, false, nullptr);
  tracef("[regov] OpenKeyExW(%ls) -> %ld\n", sub ? sub : L"(self)", r);
  return r;
}
LSTATUS WINAPI Det_RegOpenKeyExA(HKEY h, LPCSTR sub, DWORD opt, REGSAM sam, PHKEY out) {
  if (g_depth > 0 || !g_armed) return g_real.RegOpenKeyExA(h, sub, opt, sam, out);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (!out) return ERROR_INVALID_PARAMETER;
  LSTATUS r = openCore(h, sub ? aToW(sub) : L"", sam, opt, out, false, nullptr);
  tracef("[regov] OpenKeyExA(%hs) -> %ld\n", sub ? sub : "(self)", r);
  return r;
}
LSTATUS WINAPI Det_RegOpenKeyW(HKEY h, LPCWSTR sub, PHKEY out) {
  if (g_depth > 0 || !g_armed) return g_real.RegOpenKeyW(h, sub, out);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (!out) return ERROR_INVALID_PARAMETER;
  return openCore(h, sub ? sub : L"", MAXIMUM_ALLOWED, 0, out, false, nullptr);
}
LSTATUS WINAPI Det_RegOpenKeyA(HKEY h, LPCSTR sub, PHKEY out) {
  if (g_depth > 0 || !g_armed) return g_real.RegOpenKeyA(h, sub, out);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (!out) return ERROR_INVALID_PARAMETER;
  return openCore(h, sub ? aToW(sub) : L"", MAXIMUM_ALLOWED, 0, out, false, nullptr);
}
LSTATUS WINAPI Det_RegCreateKeyExW(HKEY h, LPCWSTR sub, DWORD, LPWSTR, DWORD, REGSAM sam,
                                   const LPSECURITY_ATTRIBUTES, PHKEY out, LPDWORD disp) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegCreateKeyExW(h, sub, 0, nullptr, 0, sam, nullptr, out, disp);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (!out) return ERROR_INVALID_PARAMETER;
  LSTATUS r = openCore(h, sub ? sub : L"", sam, 0, out, true, disp);
  tracef("[regov] CreateKeyExW(%ls) -> %ld\n", sub ? sub : L"", r);
  return r;
}
LSTATUS WINAPI Det_RegCreateKeyExA(HKEY h, LPCSTR sub, DWORD, LPSTR, DWORD, REGSAM sam,
                                   const LPSECURITY_ATTRIBUTES, PHKEY out, LPDWORD disp) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegCreateKeyExA(h, sub, 0, nullptr, 0, sam, nullptr, out, disp);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (!out) return ERROR_INVALID_PARAMETER;
  return openCore(h, sub ? aToW(sub) : L"", sam, 0, out, true, disp);
}
LSTATUS WINAPI Det_RegCreateKeyW(HKEY h, LPCWSTR sub, PHKEY out) {
  if (g_depth > 0 || !g_armed) return g_real.RegCreateKeyW(h, sub, out);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (!out) return ERROR_INVALID_PARAMETER;
  return openCore(h, sub ? sub : L"", MAXIMUM_ALLOWED, 0, out, true, nullptr);
}
LSTATUS WINAPI Det_RegCreateKeyA(HKEY h, LPCSTR sub, PHKEY out) {
  if (g_depth > 0 || !g_armed) return g_real.RegCreateKeyA(h, sub, out);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (!out) return ERROR_INVALID_PARAMETER;
  return openCore(h, sub ? aToW(sub) : L"", MAXIMUM_ALLOWED, 0, out, true, nullptr);
}
LSTATUS WINAPI Det_RegOpenUserClassesRoot(HANDLE token, DWORD options, REGSAM sam, PHKEY out) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegOpenUserClassesRoot(token, options, sam, out);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (!out) return ERROR_INVALID_PARAMETER;
  (void)token;
  (void)options;
  (void)sam;
  *out = HKEY_CLASSES_ROOT;
  tracef("[regov] RegOpenUserClassesRoot -> HKEY_CLASSES_ROOT\n");
  return ERROR_SUCCESS;
}

LSTATUS WINAPI Det_RegQueryValueExW(HKEY h, LPCWSTR name, LPDWORD res, LPDWORD type,
                                    LPBYTE data, LPDWORD pcb) {
  if (g_depth > 0 || !g_armed) return g_real.RegQueryValueExW(h, name, res, type, data, pcb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  if (!b.foreign) {
    if (const Val* v = findValue(b.root, b.path, lc(name ? name : L""))) {
      tracef("[regov] QueryValueExW(%ls) -> overlay\n", name ? name : L"(default)");
      return serveBytes(v->data.data(), (DWORD)v->data.size(), v->type, type, data, pcb);
    }
  }
  HKEY real = b.foreign ? h : b.real;
  if (!real) return ERROR_FILE_NOT_FOUND;
  tracef("[regov] QueryValueExW(%ls) -> real\n", name ? name : L"(default)");
  return g_real.RegQueryValueExW(real, name, res, type, data, pcb);
}
LSTATUS WINAPI Det_RegQueryValueExA(HKEY h, LPCSTR name, LPDWORD res, LPDWORD type,
                                    LPBYTE data, LPDWORD pcb) {
  if (g_depth > 0 || !g_armed) return g_real.RegQueryValueExA(h, name, res, type, data, pcb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  if (!b.foreign) {
    if (const Val* v = findValue(b.root, b.path, lc(name ? aToW(name) : L""))) {
      tracef("[regov] QueryValueExA(%hs) -> overlay\n", name ? name : "(default)");
      return serveValueA(*v, type, data, pcb);
    }
  }
  HKEY real = b.foreign ? h : b.real;
  if (!real) return ERROR_FILE_NOT_FOUND;
  return g_real.RegQueryValueExA(real, name, res, type, data, pcb);
}

// Legacy RegQueryValue: reads the DEFAULT value (as a string) of hKey\subkey.
LSTATUS WINAPI Det_RegQueryValueW(HKEY h, LPCWSTR sub, LPWSTR data, PLONG pcb) {
  if (g_depth > 0 || !g_armed) return g_real.RegQueryValueW(h, sub, data, pcb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  if (!b.foreign) {
    std::vector<std::wstring> path = joinLower(b.path, sub ? sub : L"");
    if (const Val* v = findValue(b.root, path, L"")) {
      DWORD cb = (DWORD)v->data.size();
      LONG avail = pcb ? *pcb : 0;
      if (pcb) *pcb = cb;
      if (!data) return ERROR_SUCCESS;
      if ((DWORD)avail < cb) return ERROR_MORE_DATA;
      memcpy(data, v->data.data(), cb);
      return ERROR_SUCCESS;
    }
  }
  return g_real.RegQueryValueW(b.foreign ? h : b.real, sub, data, pcb);
}
LSTATUS WINAPI Det_RegQueryValueA(HKEY h, LPCSTR sub, LPSTR data, PLONG pcb) {
  if (g_depth > 0 || !g_armed) return g_real.RegQueryValueA(h, sub, data, pcb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  if (!b.foreign) {
    std::vector<std::wstring> path = joinLower(b.path, sub ? aToW(sub) : L"");
    if (const Val* v = findValue(b.root, path, L"")) {
      std::wstring w(reinterpret_cast<const wchar_t*>(v->data.data()),
                     v->data.size() / sizeof(wchar_t));
      if (!w.empty() && w.back() == L'\0') w.pop_back();
      std::string a = wToA(w);
      a.push_back('\0');
      DWORD cb = (DWORD)a.size();
      LONG avail = pcb ? *pcb : 0;
      if (pcb) *pcb = cb;
      if (!data) return ERROR_SUCCESS;
      if ((DWORD)avail < cb) return ERROR_MORE_DATA;
      memcpy(data, a.data(), cb);
      return ERROR_SUCCESS;
    }
  }
  return g_real.RegQueryValueA(b.foreign ? h : b.real, sub, data, pcb);
}

LSTATUS WINAPI Det_RegGetValueW(HKEY h, LPCWSTR sub, LPCWSTR value, DWORD flags, LPDWORD type,
                                PVOID data, LPDWORD pcb) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegGetValueW(h, sub, value, flags, type, data, pcb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  if (!b.foreign) {
    std::vector<std::wstring> path = joinLower(b.path, sub ? sub : L"");
    if (const Val* v = findValue(b.root, path, lc(value ? value : L""))) {
      DWORD t = v->type;
      std::vector<BYTE> bytes = v->data;
      if (t == REG_EXPAND_SZ && !(flags & RRF_NOEXPAND)) {
        std::wstring w(reinterpret_cast<const wchar_t*>(bytes.data()),
                       bytes.size() / sizeof(wchar_t));
        if (!w.empty() && w.back() == L'\0') w.pop_back();
        wchar_t exp[1024];
        DWORD n = ExpandEnvironmentStringsW(w.c_str(), exp, 1024);
        if (n > 0 && n <= 1024) {
          bytes.assign(reinterpret_cast<BYTE*>(exp), reinterpret_cast<BYTE*>(exp + n));
          t = REG_SZ;
        }
      }
      return serveBytes(bytes.data(), (DWORD)bytes.size(), t, type, (LPBYTE)data, pcb);
    }
  }
  return g_real.RegGetValueW(b.foreign ? h : b.real, sub, value, flags, type, data, pcb);
}
LSTATUS WINAPI Det_RegGetValueA(HKEY h, LPCSTR sub, LPCSTR value, DWORD flags, LPDWORD type,
                                PVOID data, LPDWORD pcb) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegGetValueA(h, sub, value, flags, type, data, pcb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  if (!b.foreign) {
    std::vector<std::wstring> path = joinLower(b.path, sub ? aToW(sub) : L"");
    if (const Val* v = findValue(b.root, path, lc(value ? aToW(value) : L"")))
      return serveValueA(*v, type, (LPBYTE)data, pcb);
  }
  return g_real.RegGetValueA(b.foreign ? h : b.real, sub, value, flags, type, data, pcb);
}

// Writes — overlay only; the real machine registry is never touched.
void setOverlayValue(const Base& b, const std::wstring& nameW, DWORD type, const BYTE* data,
                     DWORD cb) {
  Key* k = descend(b.root, b.path, true);
  if (!k) return;
  Val v;
  v.name = nameW;
  v.type = type;
  v.local = true;
  if (data && cb) v.data.assign(data, data + cb);
  k->values[lc(nameW)] = std::move(v);
  g_dirty = true;
}
LSTATUS WINAPI Det_RegSetValueExW(HKEY h, LPCWSTR name, DWORD res, DWORD type, const BYTE* data,
                                  DWORD cb) {
  if (g_depth > 0 || !g_armed) return g_real.RegSetValueExW(h, name, res, type, data, cb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  tracef("[regov] SetValueExW(%ls) -> overlay (swallowed)\n", name ? name : L"(default)");
  if (b.foreign) return ERROR_SUCCESS;  // swallow: never write the machine registry
  setOverlayValue(b, name ? name : L"", type, data, cb);
  return ERROR_SUCCESS;
}
LSTATUS WINAPI Det_RegSetValueExA(HKEY h, LPCSTR name, DWORD res, DWORD type, const BYTE* data,
                                  DWORD cb) {
  if (g_depth > 0 || !g_armed) return g_real.RegSetValueExA(h, name, res, type, data, cb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  if (b.foreign) return ERROR_SUCCESS;
  // ANSI string payloads → store as wide to match the W read path.
  if ((type == REG_SZ || type == REG_EXPAND_SZ || type == REG_MULTI_SZ) && data) {
    std::wstring w = aToW(reinterpret_cast<const char*>(data), cb ? (int)cb : -1);
    std::vector<BYTE> wb(reinterpret_cast<const BYTE*>(w.c_str()),
                         reinterpret_cast<const BYTE*>(w.c_str()) + (w.size() + 1) * sizeof(wchar_t));
    setOverlayValue(b, name ? aToW(name) : L"", type, wb.data(), (DWORD)wb.size());
  } else {
    setOverlayValue(b, name ? aToW(name) : L"", type, data, cb);
  }
  return ERROR_SUCCESS;
}

LSTATUS WINAPI Det_RegEnumKeyExW(HKEY h, DWORD idx, LPWSTR name, LPDWORD pcch, LPDWORD resv,
                                 LPWSTR cls, LPDWORD pccls, PFILETIME ft) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegEnumKeyExW(h, idx, name, pcch, resv, cls, pccls, ft);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Ctx* c = asCtx(h);
  if (!c) {
    if (isPredefRoot(h)) return g_real.RegEnumKeyExW(h, idx, name, pcch, resv, cls, pccls, ft);
    return g_real.RegEnumKeyExW(h, idx, name, pcch, resv, cls, pccls, ft);
  }
  buildEnumKeys(c);
  if (idx >= c->enumKeys.size()) return ERROR_NO_MORE_ITEMS;
  if (pccls) *pccls = 0;
  if (ft) { ft->dwLowDateTime = 0; ft->dwHighDateTime = 0; }
  return fillNameW(c->enumKeys[idx], name, pcch);
}
LSTATUS WINAPI Det_RegEnumKeyExA(HKEY h, DWORD idx, LPSTR name, LPDWORD pcch, LPDWORD resv,
                                 LPSTR cls, LPDWORD pccls, PFILETIME ft) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegEnumKeyExA(h, idx, name, pcch, resv, cls, pccls, ft);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Ctx* c = asCtx(h);
  if (!c) return g_real.RegEnumKeyExA(h, idx, name, pcch, resv, cls, pccls, ft);
  buildEnumKeys(c);
  if (idx >= c->enumKeys.size()) return ERROR_NO_MORE_ITEMS;
  if (pccls) *pccls = 0;
  if (ft) { ft->dwLowDateTime = 0; ft->dwHighDateTime = 0; }
  return fillNameA(c->enumKeys[idx], name, pcch);
}
LSTATUS WINAPI Det_RegEnumKeyW(HKEY h, DWORD idx, LPWSTR name, DWORD cch) {
  if (g_depth > 0 || !g_armed) return g_real.RegEnumKeyW(h, idx, name, cch);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Ctx* c = asCtx(h);
  if (!c) return g_real.RegEnumKeyW(h, idx, name, cch);
  buildEnumKeys(c);
  if (idx >= c->enumKeys.size()) return ERROR_NO_MORE_ITEMS;
  DWORD cap = cch;
  return fillNameW(c->enumKeys[idx], name, &cap);
}
LSTATUS WINAPI Det_RegEnumKeyA(HKEY h, DWORD idx, LPSTR name, DWORD cch) {
  if (g_depth > 0 || !g_armed) return g_real.RegEnumKeyA(h, idx, name, cch);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Ctx* c = asCtx(h);
  if (!c) return g_real.RegEnumKeyA(h, idx, name, cch);
  buildEnumKeys(c);
  if (idx >= c->enumKeys.size()) return ERROR_NO_MORE_ITEMS;
  DWORD cap = cch;
  return fillNameA(c->enumKeys[idx], name, &cap);
}
LSTATUS WINAPI Det_RegEnumValueW(HKEY h, DWORD idx, LPWSTR name, LPDWORD pcch, LPDWORD resv,
                                 LPDWORD type, LPBYTE data, LPDWORD pcb) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegEnumValueW(h, idx, name, pcch, resv, type, data, pcb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Ctx* c = asCtx(h);
  if (!c) return g_real.RegEnumValueW(h, idx, name, pcch, resv, type, data, pcb);
  buildEnumVals(c);
  if (idx >= c->enumVals.size()) return ERROR_NO_MORE_ITEMS;
  const Val& v = c->enumVals[idx];
  LSTATUS rn = fillNameW(v.name, name, pcch);
  if (rn != ERROR_SUCCESS) return rn;
  return serveBytes(v.data.data(), (DWORD)v.data.size(), v.type, type, data, pcb);
}
LSTATUS WINAPI Det_RegEnumValueA(HKEY h, DWORD idx, LPSTR name, LPDWORD pcch, LPDWORD resv,
                                 LPDWORD type, LPBYTE data, LPDWORD pcb) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegEnumValueA(h, idx, name, pcch, resv, type, data, pcb);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Ctx* c = asCtx(h);
  if (!c) return g_real.RegEnumValueA(h, idx, name, pcch, resv, type, data, pcb);
  buildEnumVals(c);
  if (idx >= c->enumVals.size()) return ERROR_NO_MORE_ITEMS;
  const Val& v = c->enumVals[idx];
  LSTATUS rn = fillNameA(v.name, name, pcch);
  if (rn != ERROR_SUCCESS) return rn;
  return serveValueA(v, type, data, pcb);
}
LSTATUS WINAPI Det_RegQueryInfoKeyW(HKEY h, LPWSTR cls, LPDWORD pccls, LPDWORD resv,
                                    LPDWORD nSub, LPDWORD maxSub, LPDWORD maxCls, LPDWORD nVals,
                                    LPDWORD maxValName, LPDWORD maxValLen, LPDWORD secDesc,
                                    PFILETIME ft) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegQueryInfoKeyW(h, cls, pccls, resv, nSub, maxSub, maxCls, nVals, maxValName,
                                   maxValLen, secDesc, ft);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Ctx* c = asCtx(h);
  if (!c)
    return g_real.RegQueryInfoKeyW(h, cls, pccls, resv, nSub, maxSub, maxCls, nVals, maxValName,
                                   maxValLen, secDesc, ft);
  buildEnumKeys(c);
  buildEnumVals(c);
  DWORD mSub = 0, mvn = 0, mvl = 0;
  for (const auto& k : c->enumKeys) mSub = (DWORD)std::max<size_t>(mSub, k.size());
  for (const auto& v : c->enumVals) {
    mvn = (DWORD)std::max<size_t>(mvn, v.name.size());
    mvl = (DWORD)std::max<size_t>(mvl, v.data.size());
  }
  if (pccls) *pccls = 0;
  if (nSub) *nSub = (DWORD)c->enumKeys.size();
  if (maxSub) *maxSub = mSub;
  if (maxCls) *maxCls = 0;
  if (nVals) *nVals = (DWORD)c->enumVals.size();
  if (maxValName) *maxValName = mvn;
  if (maxValLen) *maxValLen = mvl;
  if (secDesc) *secDesc = 0;
  if (ft) { ft->dwLowDateTime = 0; ft->dwHighDateTime = 0; }
  return ERROR_SUCCESS;
}
LSTATUS WINAPI Det_RegQueryInfoKeyA(HKEY h, LPSTR cls, LPDWORD pccls, LPDWORD resv, LPDWORD nSub,
                                    LPDWORD maxSub, LPDWORD maxCls, LPDWORD nVals,
                                    LPDWORD maxValName, LPDWORD maxValLen, LPDWORD secDesc,
                                    PFILETIME ft) {
  if (g_depth > 0 || !g_armed)
    return g_real.RegQueryInfoKeyA(h, cls, pccls, resv, nSub, maxSub, maxCls, nVals, maxValName,
                                   maxValLen, secDesc, ft);
  // Delegate counting to the W path (counts are identical; A only affects class string).
  return Det_RegQueryInfoKeyW(h, nullptr, pccls, resv, nSub, maxSub, maxCls, nVals, maxValName,
                              maxValLen, secDesc, ft);
}

// File API hooks — hard-coded drive paths are mapped into <bundle>\files\<DRIVE>\...
// when the mirrored target or its parent exists. This catches legacy plugins that bypass
// the registry and open their original install paths directly.
HANDLE WINAPI Det_CreateFileW(LPCWSTR path, DWORD access, DWORD share,
                              LPSECURITY_ATTRIBUTES sa, DWORD createDisp, DWORD flags,
                              HANDLE tmpl) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive)
    return g_real.CreateFileW(path, access, share, sa, createDisp, flags, tmpl);
  std::wstring redir;
  if (redirectFilePathW(path, redir)) {
    Reenter re;
    return g_real.CreateFileW(redir.c_str(), access, share, sa, createDisp, flags, tmpl);
  }
  return g_real.CreateFileW(path, access, share, sa, createDisp, flags, tmpl);
}
HANDLE WINAPI Det_CreateFileA(LPCSTR path, DWORD access, DWORD share,
                              LPSECURITY_ATTRIBUTES sa, DWORD createDisp, DWORD flags,
                              HANDLE tmpl) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive)
    return g_real.CreateFileA(path, access, share, sa, createDisp, flags, tmpl);
  std::string redir;
  if (redirectFilePathA(path, redir)) {
    Reenter re;
    return g_real.CreateFileA(redir.c_str(), access, share, sa, createDisp, flags, tmpl);
  }
  return g_real.CreateFileA(path, access, share, sa, createDisp, flags, tmpl);
}
DWORD WINAPI Det_GetFileAttributesW(LPCWSTR path) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive) return g_real.GetFileAttributesW(path);
  std::wstring redir;
  if (redirectFilePathW(path, redir)) {
    Reenter re;
    return g_real.GetFileAttributesW(redir.c_str());
  }
  return g_real.GetFileAttributesW(path);
}
DWORD WINAPI Det_GetFileAttributesA(LPCSTR path) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive) return g_real.GetFileAttributesA(path);
  std::string redir;
  if (redirectFilePathA(path, redir)) {
    Reenter re;
    return g_real.GetFileAttributesA(redir.c_str());
  }
  return g_real.GetFileAttributesA(path);
}
BOOL WINAPI Det_GetFileAttributesExW(LPCWSTR path, GET_FILEEX_INFO_LEVELS level, LPVOID data) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive)
    return g_real.GetFileAttributesExW(path, level, data);
  std::wstring redir;
  if (redirectFilePathW(path, redir)) {
    Reenter re;
    return g_real.GetFileAttributesExW(redir.c_str(), level, data);
  }
  return g_real.GetFileAttributesExW(path, level, data);
}
BOOL WINAPI Det_GetFileAttributesExA(LPCSTR path, GET_FILEEX_INFO_LEVELS level, LPVOID data) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive)
    return g_real.GetFileAttributesExA(path, level, data);
  std::string redir;
  if (redirectFilePathA(path, redir)) {
    Reenter re;
    return g_real.GetFileAttributesExA(redir.c_str(), level, data);
  }
  return g_real.GetFileAttributesExA(path, level, data);
}
HANDLE WINAPI Det_FindFirstFileW(LPCWSTR path, LPWIN32_FIND_DATAW data) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive) return g_real.FindFirstFileW(path, data);
  std::wstring redir;
  if (redirectFilePathW(path, redir)) {
    Reenter re;
    return g_real.FindFirstFileW(redir.c_str(), data);
  }
  return g_real.FindFirstFileW(path, data);
}
HANDLE WINAPI Det_FindFirstFileA(LPCSTR path, LPWIN32_FIND_DATAA data) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive) return g_real.FindFirstFileA(path, data);
  std::string redir;
  if (redirectFilePathA(path, redir)) {
    Reenter re;
    return g_real.FindFirstFileA(redir.c_str(), data);
  }
  return g_real.FindFirstFileA(path, data);
}
HANDLE WINAPI Det_FindFirstFileExW(LPCWSTR path, FINDEX_INFO_LEVELS level, LPVOID data,
                                   FINDEX_SEARCH_OPS searchOp, LPVOID filter, DWORD flags) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive)
    return g_real.FindFirstFileExW(path, level, data, searchOp, filter, flags);
  std::wstring redir;
  if (redirectFilePathW(path, redir)) {
    Reenter re;
    return g_real.FindFirstFileExW(redir.c_str(), level, data, searchOp, filter, flags);
  }
  return g_real.FindFirstFileExW(path, level, data, searchOp, filter, flags);
}
HANDLE WINAPI Det_FindFirstFileExA(LPCSTR path, FINDEX_INFO_LEVELS level, LPVOID data,
                                   FINDEX_SEARCH_OPS searchOp, LPVOID filter, DWORD flags) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive)
    return g_real.FindFirstFileExA(path, level, data, searchOp, filter, flags);
  std::string redir;
  if (redirectFilePathA(path, redir)) {
    Reenter re;
    return g_real.FindFirstFileExA(redir.c_str(), level, data, searchOp, filter, flags);
  }
  return g_real.FindFirstFileExA(path, level, data, searchOp, filter, flags);
}
BOOL WINAPI Det_DeleteFileW(LPCWSTR path) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive) return g_real.DeleteFileW(path);
  std::wstring redir;
  if (redirectFilePathW(path, redir)) {
    Reenter re;
    return g_real.DeleteFileW(redir.c_str());
  }
  return g_real.DeleteFileW(path);
}
BOOL WINAPI Det_DeleteFileA(LPCSTR path) {
  if (g_depth > 0 || !g_armed || !g_fileOverlayActive) return g_real.DeleteFileA(path);
  std::string redir;
  if (redirectFilePathA(path, redir)) {
    Reenter re;
    return g_real.DeleteFileA(redir.c_str());
  }
  return g_real.DeleteFileA(path);
}
HMODULE WINAPI Det_LoadLibraryW(LPCWSTR path) {
  if (g_depth > 0 || !g_armed || !path)
    return g_real.LoadLibraryW(path);
  tracef("[fileov] LoadLibraryW req=%ls\n", path);
  if (!g_fileOverlayActive) return g_real.LoadLibraryW(path);
  std::wstring redir;
  if (redirectFilePathW(path, redir)) {
    Reenter re;
    HMODULE mod = g_real.LoadLibraryW(redir.c_str());
    tracef("[fileov] LoadLibraryW use=%ls -> %p err=%lu\n", redir.c_str(),
           static_cast<void*>(mod), GetLastError());
    return mod;
  }
  HMODULE mod = g_real.LoadLibraryW(path);
  tracef("[fileov] LoadLibraryW use=%ls -> %p err=%lu\n", path,
         static_cast<void*>(mod), GetLastError());
  return mod;
}
HMODULE WINAPI Det_LoadLibraryA(LPCSTR path) {
  if (g_depth > 0 || !g_armed || !path)
    return g_real.LoadLibraryA(path);
  tracef("[fileov] LoadLibraryA req=%s\n", path);
  if (!g_fileOverlayActive) return g_real.LoadLibraryA(path);
  std::string redir;
  if (redirectFilePathA(path, redir)) {
    Reenter re;
    HMODULE mod = g_real.LoadLibraryA(redir.c_str());
    tracef("[fileov] LoadLibraryA use=%s -> %p err=%lu\n", redir.c_str(),
           static_cast<void*>(mod), GetLastError());
    return mod;
  }
  HMODULE mod = g_real.LoadLibraryA(path);
  tracef("[fileov] LoadLibraryA use=%s -> %p err=%lu\n", path,
         static_cast<void*>(mod), GetLastError());
  return mod;
}
HMODULE WINAPI Det_LoadLibraryExW(LPCWSTR path, HANDLE file, DWORD flags) {
  if (g_depth > 0 || !g_armed || !path)
    return g_real.LoadLibraryExW(path, file, flags);
  tracef("[fileov] LoadLibraryExW req=%ls flags=0x%08lX\n", path, flags);
  if (!g_fileOverlayActive) return g_real.LoadLibraryExW(path, file, flags);
  std::wstring redir;
  if (redirectFilePathW(path, redir)) {
    Reenter re;
    HMODULE mod = g_real.LoadLibraryExW(redir.c_str(), file, flags);
    tracef("[fileov] LoadLibraryExW use=%ls -> %p err=%lu\n", redir.c_str(),
           static_cast<void*>(mod), GetLastError());
    return mod;
  }
  HMODULE mod = g_real.LoadLibraryExW(path, file, flags);
  tracef("[fileov] LoadLibraryExW use=%ls -> %p err=%lu\n", path,
         static_cast<void*>(mod), GetLastError());
  return mod;
}
HMODULE WINAPI Det_LoadLibraryExA(LPCSTR path, HANDLE file, DWORD flags) {
  if (g_depth > 0 || !g_armed || !path)
    return g_real.LoadLibraryExA(path, file, flags);
  tracef("[fileov] LoadLibraryExA req=%s flags=0x%08lX\n", path, flags);
  if (!g_fileOverlayActive) return g_real.LoadLibraryExA(path, file, flags);
  std::string redir;
  if (redirectFilePathA(path, redir)) {
    Reenter re;
    HMODULE mod = g_real.LoadLibraryExA(redir.c_str(), file, flags);
    tracef("[fileov] LoadLibraryExA use=%s -> %p err=%lu\n", redir.c_str(),
           static_cast<void*>(mod), GetLastError());
    return mod;
  }
  HMODULE mod = g_real.LoadLibraryExA(path, file, flags);
  tracef("[fileov] LoadLibraryExA use=%s -> %p err=%lu\n", path,
         static_cast<void*>(mod), GetLastError());
  return mod;
}
int WINAPI Det_MessageBoxW(HWND hwnd, LPCWSTR text, LPCWSTR caption, UINT type) {
  dialogf("[dlg] MessageBoxW cap=%ls text=%ls type=0x%08X\n",
          caption ? caption : L"", text ? text : L"", static_cast<unsigned>(type));
  if (dialogAutoDismiss()) return IDOK;
  return g_real.MessageBoxW(hwnd, text, caption, type);
}
int WINAPI Det_MessageBoxA(HWND hwnd, LPCSTR text, LPCSTR caption, UINT type) {
  dialogf("[dlg] MessageBoxA cap=%s text=%s type=0x%08X\n",
          caption ? caption : "", text ? text : "", static_cast<unsigned>(type));
  if (dialogAutoDismiss()) return IDOK;
  return g_real.MessageBoxA(hwnd, text, caption, type);
}
// ===========================================================================
// eLicenser POS DCOM replay (driverless content decryption).
//
// SYNSOACC reaches the dongle ONLY through DCOM: CoCreateInstance(CLSID_POS,
// IID_IUnknown, LOCAL_SERVER) -> QueryInterface(IID_IPOS) -> drives the whole
// license + dongle + encryption-context setup through a single method
//   HRESULT IPOS::receiveTransferObject([in]SAFEARRAY(UI1) req,[out]SAFEARRAY(UI1)* rsp)
// On Win11 there is no SYNSOPOS.exe, so the real create returns 0x80070057 and
// SYNSOACC NULL-derefs. We instead return an in-proc IPOS that replays the
// XP-captured setup responses (proven byte-identical across cold starts), so the
// real SYNSOACC derives its working key and decrypts content in-process.
// (See the synsoacc-pos-com-contract note; data in PosReplayData.h.)
// ===========================================================================
// {E3B4B744-A654-11D3-A1A3-005004EA089A}
static const GUID kCLSID_POS =
    {0xE3B4B744,0xA654,0x11D3,{0xA1,0xA3,0x00,0x50,0x04,0xEA,0x08,0x9A}};
// {E3B4B742-A654-11D3-A1A3-005004EA089A}
static const GUID kIID_IPOS =
    {0xE3B4B742,0xA654,0x11D3,{0xA1,0xA3,0x00,0x50,0x04,0xEA,0x08,0x9A}};
static const GUID kIID_IUnknown =
    {0x00000000,0x0000,0x0000,{0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46}};

// POS replay is opt-out (default on): CLSID_POS is eLicenser-specific, so
// intercepting it never affects an unrelated plugin. MYDAW_POS_REPLAY=0 disables.
bool posReplayEnabled() {
  static const bool on = [] {
    char b[8];
    DWORD n = GetEnvironmentVariableA("MYDAW_POS_REPLAY", b, sizeof(b));
    return !(n == 1 && b[0] == '0');
  }();
  return on;
}

struct PosReplayObj;
struct PosVtbl {
  HRESULT(STDMETHODCALLTYPE* QueryInterface)(PosReplayObj*, REFIID, void**);
  ULONG(STDMETHODCALLTYPE* AddRef)(PosReplayObj*);
  ULONG(STDMETHODCALLTYPE* Release)(PosReplayObj*);
  HRESULT(STDMETHODCALLTYPE* receiveTransferObject)(PosReplayObj*, SAFEARRAY*, SAFEARRAY**);
};
struct PosReplayObj {
  const PosVtbl* vtbl;
  LONG ref;
  int idx;         // sequential replay cursor into g_posReplay
  SOCKET sock;     // POS tunnel socket (INVALID_SOCKET until connected)
};

// ---- POS tunnel: forward receiveTransferObject to the live dongle on XP ----
// Set MYDAW_POS_TUNNEL=host[:port] (default port 5599) to tunnel; unset = offline replay.
constexpr unsigned kPosMaxTunnelFrame = 1024u * 1024u;
constexpr DWORD kPosSocketTimeoutMs = 5000;
constexpr long kPosConnectTimeoutMs = 1000;

const char* posTunnelTarget() {
  static const std::string target = [] {
    char buf[256]{};
    const DWORD n = GetEnvironmentVariableA("MYDAW_POS_TUNNEL", buf, sizeof buf);
    if (n == 0 || n >= sizeof buf) return std::string();
    return std::string(buf, n);
  }();
  return target.empty() ? nullptr : target.c_str();
}
std::recursive_mutex& g_tunMu = *new std::recursive_mutex();
bool g_wsaUp = false;
static bool sockRecvAll(SOCKET s, char* b, int n);
static bool sockSendAll(SOCKET s, const char* b, int n);

struct PosTunnelEndpoint {
  sockaddr_in address{};
  std::string host;
  unsigned short port = 5599;
};

bool parsePosTunnelEndpoint(const char* target, PosTunnelEndpoint& endpoint) {
  if (!target || !*target) return false;
  std::string host(target);
  if (host.find_first_of(" \t\r\n") != std::string::npos) return false;

  long port = 5599;
  const size_t colon = host.rfind(':');
  if (colon != std::string::npos) {
    // The diagnostic protocol is IPv4-only. Reject ambiguous IPv6-style targets
    // instead of silently parsing the final component as a port.
    if (host.find(':') != colon) return false;
    const std::string portText = host.substr(colon + 1);
    char* end = nullptr;
    port = std::strtol(portText.c_str(), &end, 10);
    if (portText.empty() || !end || *end != '\0' || port < 1 || port > 65535)
      return false;
    host.resize(colon);
  }
  if (host.empty()) return false;

  addrinfo hints{};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_protocol = IPPROTO_TCP;
  addrinfo* results = nullptr;
  if (getaddrinfo(host.c_str(), nullptr, &hints, &results) != 0 || !results) return false;
  bool found = false;
  for (addrinfo* it = results; it; it = it->ai_next) {
    if (it->ai_family != AF_INET || it->ai_addrlen < static_cast<int>(sizeof(sockaddr_in)))
      continue;
    memcpy(&endpoint.address, it->ai_addr, sizeof(sockaddr_in));
    found = true;
    break;
  }
  freeaddrinfo(results);
  if (!found) return false;
  endpoint.address.sin_port = htons(static_cast<unsigned short>(port));
  endpoint.host = std::move(host);
  endpoint.port = static_cast<unsigned short>(port);
  return true;
}

bool configurePosSocketTimeouts(SOCKET s) {
  const DWORD timeout = kPosSocketTimeoutMs;
  return setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout),
                    sizeof(timeout)) == 0 &&
         setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout),
                    sizeof(timeout)) == 0;
}

bool connectPosSocket(SOCKET s, const sockaddr_in& address) {
  u_long nonBlocking = 1;
  if (ioctlsocket(s, FIONBIO, &nonBlocking) != 0) return false;

  bool connected = connect(s, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == 0;
  if (!connected) {
    const int err = WSAGetLastError();
    if (err == WSAEWOULDBLOCK || err == WSAEINPROGRESS || err == WSAEALREADY) {
      fd_set writable;
      fd_set failed;
      FD_ZERO(&writable);
      FD_ZERO(&failed);
      FD_SET(s, &writable);
      FD_SET(s, &failed);
      timeval timeout{};
      timeout.tv_sec = kPosConnectTimeoutMs / 1000;
      timeout.tv_usec = (kPosConnectTimeoutMs % 1000) * 1000;
      if (select(0, nullptr, &writable, &failed, &timeout) > 0 && FD_ISSET(s, &writable) &&
          !FD_ISSET(s, &failed)) {
        int socketError = 0;
        int errorSize = sizeof(socketError);
        connected = getsockopt(s, SOL_SOCKET, SO_ERROR,
                               reinterpret_cast<char*>(&socketError), &errorSize) == 0 &&
                    socketError == 0;
      }
    }
  }

  u_long blocking = 0;
  if (ioctlsocket(s, FIONBIO, &blocking) != 0) return false;
  return connected && configurePosSocketTimeouts(s);
}

void resetPosTunnel(PosReplayObj* self) {
  if (self->sock == INVALID_SOCKET) return;
  shutdown(self->sock, SD_BOTH);
  closesocket(self->sock);
  self->sock = INVALID_SOCKET;
}

bool posTunnelConnect(PosReplayObj* self) {
  if (self->sock != INVALID_SOCKET) return true;
  const char* tgt = posTunnelTarget();
  if (!tgt) return false;
  // Winsock init + connect read the Winsock catalog from the registry / load
  // provider DLLs; the capture overlay must NOT virtualize those. Suppress the
  // Reg/file hooks for this thread while we set up the socket.
  Reenter re;
  if (!g_wsaUp) {
    WSADATA w;
    int wr = WSAStartup(MAKEWORD(2, 2), &w);
    if (wr == 0) g_wsaUp = true;
    else { tracef("[postunnel] WSAStartup FAILED %d\n", wr); return false; }
  }
  PosTunnelEndpoint endpoint;
  if (!parsePosTunnelEndpoint(tgt, endpoint)) {
    tracef("[postunnel] invalid MYDAW_POS_TUNNEL target: %s\n", tgt);
    return false;
  }
  // Retry: possrv does a per-connection CoCreateInstance that briefly stalls its
  // accept loop while SYNSOPOS launches; also survive a not-yet-ready server.
  for (int attempt = 0; attempt < 10; ++attempt) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) { tracef("[postunnel] socket() err %d\n", WSAGetLastError()); Sleep(200); continue; }
    if (connectPosSocket(s, endpoint.address)) {
      // Handshake: send our OS pid so possrv can rewrite it to a real XP process
      // (the dongle validates the pid embedded in POS requests).
      unsigned pid = GetCurrentProcessId();
      if (sockSendAll(s, (const char*)&pid, 4)) {
        self->sock = s;
        tracef("[postunnel] connected to %s:%u pid=0x%X (attempt %d)\n",
               endpoint.host.c_str(), static_cast<unsigned>(endpoint.port), pid, attempt);
        return true;
      }
      closesocket(s);
      Sleep(300);
      continue;
    }
    tracef("[postunnel] connect err %d (attempt %d)\n", WSAGetLastError(), attempt);
    closesocket(s);
    Sleep(300);
  }
  return false;
}
static bool sockRecvAll(SOCKET s, char* b, int n) {
  if (n < 0) return false;
  int received = 0;
  while (received < n) {
    const int r = recv(s, b + received, n - received, 0);
    if (r <= 0) return false;
    received += r;
  }
  return true;
}
static bool sockSendAll(SOCKET s, const char* b, int n) {
  if (n < 0) return false;
  int sent = 0;
  while (sent < n) {
    const int r = send(s, b + sent, n - sent, 0);
    if (r <= 0) return false;
    sent += r;
  }
  return true;
}

static SAFEARRAY* posMakeSA(const unsigned char* data, unsigned len) {
  SAFEARRAY* sa = SafeArrayCreateVector(VT_UI1, 0, len);
  if (!sa) return nullptr;
  void* p = nullptr;
  if (SafeArrayAccessData(sa, &p) != S_OK) {
    SafeArrayDestroy(sa);
    return nullptr;
  }
  if (len && data) memcpy(p, data, len);
  SafeArrayUnaccessData(sa);
  return sa;
}

bool posReplayPidPatchingEnabled() {
  // Generated captures have not always contained the capture PID advertised by
  // their metadata. Never scan-and-rewrite arbitrary response bytes unless the
  // marker is demonstrably present in this exact generated data set.
  static const bool enabled = [] {
    if (g_vstCapturePid == 0) return false;
    const unsigned char p0 = static_cast<unsigned char>(g_vstCapturePid);
    const unsigned char p1 = static_cast<unsigned char>(g_vstCapturePid >> 8);
    const unsigned char p2 = static_cast<unsigned char>(g_vstCapturePid >> 16);
    const unsigned char p3 = static_cast<unsigned char>(g_vstCapturePid >> 24);
    for (int call = 0; call < g_vstSeqCount; ++call) {
      const unsigned char* bytes = g_vstSeq[call].rsp;
      const unsigned len = g_vstSeq[call].rspLen;
      for (unsigned i = 0; len >= 4 && i + 4 <= len; ++i)
        if (bytes[i] == p0 && bytes[i + 1] == p1 && bytes[i + 2] == p2 &&
            bytes[i + 3] == p3)
          return true;
    }
    return false;
  }();
  return enabled;
}

// Like posMakeSA, but rewrite the capture-time pid echoed in the response to this
// process's pid (the exchange was captured under a different render pid).
static SAFEARRAY* posMakeSAPatched(const unsigned char* data, unsigned len) {
  if (!posReplayPidPatchingEnabled()) return posMakeSA(data, len);
  SAFEARRAY* sa = SafeArrayCreateVector(VT_UI1, 0, len);
  if (!sa) return nullptr;
  void* p = nullptr;
  if (SafeArrayAccessData(sa, &p) != S_OK) {
    SafeArrayDestroy(sa);
    return nullptr;
  }
  if (len && data) memcpy(p, data, len);
  unsigned cap = g_vstCapturePid, cur = GetCurrentProcessId();
  unsigned char* b = (unsigned char*)p;
  for (unsigned i = 0; len >= 4 && i + 4 <= len; ++i)
    if (b[i] == (unsigned char)cap && b[i + 1] == (unsigned char)(cap >> 8) &&
        b[i + 2] == (unsigned char)(cap >> 16) && b[i + 3] == (unsigned char)(cap >> 24)) {
      b[i] = (unsigned char)cur; b[i + 1] = (unsigned char)(cur >> 8);
      b[i + 2] = (unsigned char)(cur >> 16); b[i + 3] = (unsigned char)(cur >> 24);
      i += 3;
    }
  SafeArrayUnaccessData(sa);
  return sa;
}

static HRESULT STDMETHODCALLTYPE Pos_QI(PosReplayObj* self, REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  if (IsEqualIID(riid, kIID_IUnknown) || IsEqualIID(riid, kIID_IPOS)) {
    *ppv = self;
    InterlockedIncrement(&self->ref);
    return S_OK;
  }
  *ppv = nullptr;
  return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE Pos_AddRef(PosReplayObj* self) {
  return (ULONG)InterlockedIncrement(&self->ref);
}
static ULONG STDMETHODCALLTYPE Pos_Release(PosReplayObj* self) {
  LONG r = InterlockedDecrement(&self->ref);
  if (r == 0) {
    resetPosTunnel(self);
    delete self;
  }
  return (ULONG)r;
}
static HRESULT STDMETHODCALLTYPE Pos_receive(PosReplayObj* self, SAFEARRAY* in,
                                             SAFEARRAY** out) {
  if (!out) return E_POINTER;
  *out = nullptr;

  // Read the request bytes once (needed by both the tunnel and the logger).
  std::vector<unsigned char> req;
  if (in) {
    LONG lb = 0, ub = -1;
    if (SafeArrayGetLBound(in, 1, &lb) == S_OK && SafeArrayGetUBound(in, 1, &ub) == S_OK &&
        ub >= lb) {
      const unsigned long long count =
          static_cast<unsigned long long>(static_cast<long long>(ub) - lb + 1);
      if (count > kPosMaxTunnelFrame) {
        tracef("[postunnel] rejected oversized request: %llu bytes\n", count);
        return E_INVALIDARG;
      }
      const unsigned n = static_cast<unsigned>(count);
      void* p = nullptr;
      if (SafeArrayAccessData(in, &p) == S_OK) {
        req.assign((unsigned char*)p, (unsigned char*)p + n);
        SafeArrayUnaccessData(in);
      }
    }
  }
  unsigned rn = (unsigned)req.size();
  if (rn > kPosMaxTunnelFrame) {
    tracef("[postunnel] rejected oversized request: %u bytes\n", rn);
    return E_INVALIDARG;
  }

  // Tunnel mode: forward to the live dongle on XP and return the real response.
  // Hybrid (MYDAW_POS_HYBRID): tunnel ONLY the 155-byte heartbeats (random
  // challenge/response), replay everything else offline — to prove the heartbeat
  // is the last piece that needs the dongle.
  static const bool hybrid = [] {
    char b[8]; return GetEnvironmentVariableA("MYDAW_POS_HYBRID", b, sizeof b) > 0;
  }();
  if (posTunnelTarget() && (!hybrid || rn == 155)) {
    std::lock_guard<std::recursive_mutex> lk(g_tunMu);
    if (!posTunnelConnect(self)) { tracef("[postunnel] connect FAILED\n"); return E_FAIL; }
    const unsigned len = rn;
    if (!sockSendAll(self->sock, reinterpret_cast<const char*>(&len),
                     static_cast<int>(sizeof(len))) ||
        (len != 0 &&
         !sockSendAll(self->sock, reinterpret_cast<const char*>(req.data()),
                      static_cast<int>(len)))) {
      tracef("[postunnel] send FAILED err=%d\n", WSAGetLastError());
      resetPosTunnel(self);
      return E_FAIL;
    }
    unsigned remoteHr = 0;
    unsigned responseLen = 0;
    if (!sockRecvAll(self->sock, reinterpret_cast<char*>(&remoteHr),
                     static_cast<int>(sizeof(remoteHr))) ||
        !sockRecvAll(self->sock, reinterpret_cast<char*>(&responseLen),
                     static_cast<int>(sizeof(responseLen)))) {
      tracef("[postunnel] response header FAILED err=%d\n", WSAGetLastError());
      resetPosTunnel(self);
      return E_FAIL;
    }
    if (responseLen > kPosMaxTunnelFrame) {
      tracef("[postunnel] rejected oversized response: %u bytes\n", responseLen);
      resetPosTunnel(self);
      return E_FAIL;
    }
    std::vector<unsigned char> response(responseLen);
    if (responseLen != 0 &&
        !sockRecvAll(self->sock, reinterpret_cast<char*>(response.data()),
                     static_cast<int>(responseLen))) {
      tracef("[postunnel] response body FAILED err=%d\n", WSAGetLastError());
      resetPosTunnel(self);
      return E_FAIL;
    }
    SAFEARRAY* result = posMakeSA(response.data(), responseLen);
    if (!result) return E_OUTOFMEMORY;
    *out = result;
    tracef("[postunnel] req=%u -> hr=0x%08lX rsp=%u\n", rn,
           static_cast<unsigned long>(remoteHr), responseLen);
    return static_cast<HRESULT>(remoteHr);
  }

  // Offline replay from the captured live VST<->dongle exchange (deterministic):
  // each request advances to the next captured call with the same request length.
  // A request that cannot be matched fails closed; returning an unrelated or null
  // response with S_OK makes the caller consume corrupt licensing state.
  // TheGrand2 issues POS calls from several threads while loading a model, so the
  // cursor read/increment must be serialized — but keep the critical section
  // tiny (no SAFEARRAY build, no blocking) to avoid deadlocking the plugin's own
  // cross-thread work.
  const unsigned char* rsp = nullptr;
  unsigned rl = 0;
  int served = -1;
  {
    std::lock_guard<std::recursive_mutex> lk(g_tunMu);
    const int cursor = self->idx;
    int i = -1;
    // If the request length doesn't match the cursor's expected call, resync
    // forward to the next captured call of this length (absorbs the occasional
    // extra small-block decrypt that shifts the sequence between sessions).
    for (int k = cursor; k < g_vstSeqCount; ++k)
      if (g_vstSeq[k].reqLen == rn) {
        i = k;
        break;
      }
    if (i >= 0) {
      rsp = g_vstSeq[i].rsp; rl = g_vstSeq[i].rspLen; self->idx = i + 1; served = i;
    }
  }
  tracef("[posreplay] recv reqLen=%u -> rspLen=%u (seq#%d)\n", rn, rl, served);
  if (!rsp) return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
  SAFEARRAY* result = posMakeSAPatched(rsp, rl);
  if (!result) return E_OUTOFMEMORY;
  *out = result;
  return S_OK;
}
static const PosVtbl g_posVtbl = {Pos_QI, Pos_AddRef, Pos_Release, Pos_receive};

HRESULT WINAPI Det_CoCreateInstance(REFCLSID rclsid, IUnknown* outer, DWORD clsCtx,
                                    REFIID riid, LPVOID* out) {
  if (posReplayEnabled() && IsEqualCLSID(rclsid, kCLSID_POS)) {
    tracef("[posreplay] intercept CoCreateInstance(CLSID_POS) ctx=0x%08lX\n", clsCtx);
    if (!out) return E_POINTER;
    PosReplayObj* o = new PosReplayObj{&g_posVtbl, 1, 0, INVALID_SOCKET};
    HRESULT hr = Pos_QI(o, riid, out);  // satisfy the requested riid (usually IID_IUnknown)
    Pos_Release(o);                     // drop our creation ref; QI took its own
    return hr;
  }
  LPOLESTR clsidStr = nullptr;
  LPOLESTR iidStr = nullptr;
  StringFromCLSID(rclsid, &clsidStr);
  StringFromIID(riid, &iidStr);
  tracef("[regov] CoCreateInstance clsid=%ls iid=%ls ctx=0x%08lX\n",
         clsidStr ? clsidStr : L"(null)", iidStr ? iidStr : L"(null)", clsCtx);
  HRESULT hr = g_real.CoCreateInstance(rclsid, outer, clsCtx, riid, out);
  tracef("[regov] CoCreateInstance -> 0x%08lX out=%p\n", static_cast<unsigned long>(hr),
         out ? *out : nullptr);
  if (clsidStr) CoTaskMemFree(clsidStr);
  if (iidStr) CoTaskMemFree(iidStr);
  return hr;
}

LSTATUS WINAPI Det_RegDeleteValueW(HKEY h, LPCWSTR name) {
  if (g_depth > 0 || !g_armed) return g_real.RegDeleteValueW(h, name);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  if (b.foreign) return ERROR_SUCCESS;
  Key* k = descend(b.root, b.path, true);
  if (k) {
    Val& v = k->values[lc(name ? name : L"")];
    v.name = name ? name : L"";
    v.tomb = true;
    v.local = true;
    g_dirty = true;
  }
  return ERROR_SUCCESS;
}
LSTATUS WINAPI Det_RegDeleteValueA(HKEY h, LPCSTR name) {
  if (g_depth > 0 || !g_armed) return g_real.RegDeleteValueA(h, name);
  return Det_RegDeleteValueW(h, name ? aToW(name).c_str() : nullptr);
}
LSTATUS WINAPI Det_RegDeleteKeyW(HKEY h, LPCWSTR sub) {
  if (g_depth > 0 || !g_armed) return g_real.RegDeleteKeyW(h, sub);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  Base b = resolveBase(h);
  if (b.foreign) return ERROR_SUCCESS;
  std::vector<std::wstring> path = joinLower(b.path, sub ? sub : L"");
  Key* k = descend(b.root, path, true);
  if (k) { k->tombstone = true; k->local = true; g_dirty = true; }
  return ERROR_SUCCESS;
}
LSTATUS WINAPI Det_RegDeleteKeyA(HKEY h, LPCSTR sub) {
  if (g_depth > 0 || !g_armed) return g_real.RegDeleteKeyA(h, sub);
  return Det_RegDeleteKeyW(h, sub ? aToW(sub).c_str() : nullptr);
}

LSTATUS WINAPI Det_RegCloseKey(HKEY h) {
  if (g_depth > 0 || !g_armed) return g_real.RegCloseKey(h);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (Ctx* c = asCtx(h)) { freeCtx(c); return ERROR_SUCCESS; }
  if (isPredefRoot(h)) return ERROR_SUCCESS;
  return g_real.RegCloseKey(h);
}
LSTATUS WINAPI Det_RegFlushKey(HKEY h) {
  if (g_depth > 0 || !g_armed) return g_real.RegFlushKey(h);
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  Reenter re;
  if (asCtx(h) || isPredefRoot(h)) return ERROR_SUCCESS;
  return g_real.RegFlushKey(h);
}

// ===========================================================================
// .local serialization (persist runtime writes)
// ===========================================================================
void serializeKey(std::wofstream& f, const std::wstring& fullPath, const Key& k) {
  bool anyLocalVal = false;
  for (const auto& [nlc, v] : k.values)
    if (v.local) { anyLocalVal = true; break; }
  if (k.local && k.tombstone) {
    f << L"[-" << fullPath << L"]\r\n\r\n";
  } else if (k.local || anyLocalVal) {
    f << L"[" << fullPath << L"]\r\n";
    for (const auto& [nlc, v] : k.values) {
      if (!v.local) continue;
      std::wstring nm = v.name.empty() ? L"@" : (L"\"" + v.name + L"\"");
      if (v.tomb) { f << nm << L"=-\r\n"; continue; }
      if (v.type == REG_SZ) {
        std::wstring s(reinterpret_cast<const wchar_t*>(v.data.data()),
                       v.data.size() / sizeof(wchar_t));
        if (!s.empty() && s.back() == L'\0') s.pop_back();
        std::wstring esc;
        for (wchar_t c : s) { if (c == L'\\' || c == L'"') esc.push_back(L'\\'); esc.push_back(c); }
        f << nm << L"=\"" << esc << L"\"\r\n";
      } else if (v.type == REG_DWORD && v.data.size() == 4) {
        DWORD d = *reinterpret_cast<const DWORD*>(v.data.data());
        wchar_t buf[16];
        swprintf(buf, 16, L"dword:%08x", d);
        f << nm << L"=" << buf << L"\r\n";
      } else {
        f << nm << L"=hex(" << std::hex << v.type << std::dec << L"):";
        for (size_t i = 0; i < v.data.size(); ++i) {
          wchar_t b[4];
          swprintf(b, 4, L"%02x", v.data[i]);
          f << b;
          if (i + 1 < v.data.size()) f << L",";
        }
        f << L"\r\n";
      }
    }
    f << L"\r\n";
  }
  for (const auto& [klc, sk] : k.subkeys)
    serializeKey(f, fullPath + L"\\" + sk.name, sk);
}

const wchar_t* rootName(HKEY r) {
  if (r == HKEY_LOCAL_MACHINE) return L"HKEY_LOCAL_MACHINE";
  if (r == HKEY_CURRENT_USER) return L"HKEY_CURRENT_USER";
  if (r == HKEY_CLASSES_ROOT) return L"HKEY_CLASSES_ROOT";
  if (r == HKEY_USERS) return L"HKEY_USERS";
  if (r == HKEY_CURRENT_CONFIG) return L"HKEY_CURRENT_CONFIG";
  return L"HKEY_LOCAL_MACHINE";
}
constexpr wchar_t kClassesOwnerValue[] = L"MyDAW.CaptureOverlayOwner";

void materializeValueToRealKey(HKEY h, const Val& v) {
  if (v.tomb) return;
  // Ownership metadata is generated by MyDAW, never accepted from an imported
  // capture. Otherwise a crafted .reg plus sidecar could forge deletion rights.
  if (lc(v.name) == lc(kClassesOwnerValue)) return;
  const wchar_t* name = v.name.empty() ? nullptr : v.name.c_str();
  if (v.data.empty()) {
    RegSetValueExW(h, name, 0, v.type, nullptr, 0);
    return;
  }
  RegSetValueExW(h, name, 0, v.type, v.data.data(), (DWORD)v.data.size());
}
std::wstring classesOwnerToken() {
  return L"MyDAW capture overlay: " + lc(g_regPath);
}

void collectAllowedUserClassesPaths(const Key& key, const std::wstring& relPath) {
  if (key.tombstone) return;
  if (!relPath.empty()) g_allowedUserClassesPaths.insert(lc(relPath));
  for (const auto& [_, child] : key.subkeys) {
    const std::wstring childPath = relPath.empty() ? child.name : relPath + L"\\" + child.name;
    collectAllowedUserClassesPaths(child, childPath);
  }
}

bool isBroadUserClassesContainer(const std::vector<std::wstring>& comps) {
  if (comps.empty()) return true;
  const std::wstring first = lc(comps[0]);
  const auto isBroad = [](const std::wstring& name) {
    return name == L"clsid" || name == L"interface" || name == L"typelib" ||
           name == L"appid" || name == L"wow6432node" || name == L"mime" ||
           name == L"protocols" || name == L"activatableclasses" ||
           name == L"systemfileassociations";
  };
  if (comps.size() == 1) return isBroad(first);
  return comps.size() == 2 && first == L"wow6432node" && isBroad(lc(comps[1]));
}

bool allowedUserClassesCleanupPath(const std::wstring& rawPath, std::wstring& normalized) {
  if (rawPath.empty() || rawPath.size() > 2048 || rawPath.front() == L'\\' ||
      rawPath.back() == L'\\' || rawPath.find(L'/') != std::wstring::npos)
    return false;
  const std::vector<std::wstring> comps = splitPath(rawPath);
  if (comps.empty() || isBroadUserClassesContainer(comps)) return false;
  for (const std::wstring& comp : comps)
    if (comp.empty() || comp == L"." || comp == L"..") return false;
  normalized = joinComps(comps);
  if (normalized != rawPath) return false;  // rejects duplicate separators and odd spellings
  return g_allowedUserClassesPaths.find(lc(normalized)) != g_allowedUserClassesPaths.end();
}

bool writeUserClassesOwner(HKEY key) {
  const std::wstring owner = classesOwnerToken();
  return RegSetValueExW(key, kClassesOwnerValue, 0, REG_SZ,
                        reinterpret_cast<const BYTE*>(owner.c_str()),
                        static_cast<DWORD>((owner.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS;
}

bool userClassesKeyHasOwner(HKEY classesRoot, const std::wstring& path) {
  const std::wstring expected = classesOwnerToken();
  DWORD type = 0;
  DWORD bytes = 0;
  LSTATUS status = RegGetValueW(classesRoot, path.c_str(), kClassesOwnerValue,
                                RRF_RT_REG_SZ | RRF_NOEXPAND, &type, nullptr, &bytes);
  const DWORD expectedBytes = static_cast<DWORD>((expected.size() + 1) * sizeof(wchar_t));
  if (status != ERROR_SUCCESS || type != REG_SZ || bytes != expectedBytes) return false;
  std::vector<BYTE> value(bytes);
  status = RegGetValueW(classesRoot, path.c_str(), kClassesOwnerValue,
                        RRF_RT_REG_SZ | RRF_NOEXPAND, &type, value.data(), &bytes);
  return status == ERROR_SUCCESS && bytes == expectedBytes &&
         memcmp(value.data(), expected.c_str(), expectedBytes) == 0;
}

// Materialize `key` (and its subtree) as leaf `name` under `parent`. `relPath` is the FULL
// path from HKCU\Software\Classes down to and including this key. Keys created by MyDAW are
// stamped with a capture-specific owner value before their paths enter the crash sidecar;
// stale cleanup requires both that stamp and membership in the current capture tree.
void materializeKeyToUserClasses(HKEY parent, const std::wstring& name,
                                 const std::wstring& relPath, const Key& key) {
  if (key.tombstone) return;
  HKEY h = nullptr;
  DWORD disp = 0;
  if (RegCreateKeyExW(parent, name.c_str(), 0, nullptr, REG_OPTION_VOLATILE,
                      KEY_READ | KEY_WRITE, nullptr, &h, &disp) != ERROR_SUCCESS || !h)
    return;
  std::wstring cleanupPath;
  const bool track = disp == REG_CREATED_NEW_KEY &&
                     allowedUserClassesCleanupPath(relPath, cleanupPath);
  if (track && !writeUserClassesOwner(h)) {
    // The key is still empty, so fail closed rather than create an unowned key
    // that a future sidecar cleanup cannot authenticate.
    RegCloseKey(h);
    RegDeleteKeyW(parent, name.c_str());
    return;
  }
  for (const auto& [_, v] : key.values) materializeValueToRealKey(h, v);
  for (const auto& [_, sk] : key.subkeys)
    materializeKeyToUserClasses(h, sk.name, relPath + L"\\" + sk.name, sk);
  if (track) {
    // Re-assert the marker after captured values are written so even a colliding
    // value name in an imported .reg cannot replace the ownership proof.
    if (writeUserClassesOwner(h)) g_tempUserClassesLeaves.push_back(cleanupPath);
  }
  RegCloseKey(h);
}
using RegDeleteTreeWFn = LSTATUS(WINAPI*)(HKEY, LPCWSTR);
RegDeleteTreeWFn resolveRegDeleteTreeW() {
  static RegDeleteTreeWFn fn = []() -> RegDeleteTreeWFn {
    HMODULE adv = GetModuleHandleW(L"advapi32.dll");
    return adv ? reinterpret_cast<RegDeleteTreeWFn>(GetProcAddress(adv, "RegDeleteTreeW")) : nullptr;
  }();
  return fn;
}
// Open (creating if absent) HKCU\Software\Classes. Caller closes both handles.
bool openUserClassesRoot(HKEY& software, HKEY& classesRoot) {
  software = classesRoot = nullptr;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software", 0, nullptr, REG_OPTION_NON_VOLATILE,
                      KEY_READ | KEY_WRITE, nullptr, &software, nullptr) != ERROR_SUCCESS ||
      !software)
    return false;
  if (RegCreateKeyExW(software, L"Classes", 0, nullptr, REG_OPTION_NON_VOLATILE,
                      KEY_READ | KEY_WRITE, nullptr, &classesRoot, nullptr) != ERROR_SUCCESS ||
      !classesRoot) {
    RegCloseKey(software);
    software = nullptr;
    return false;
  }
  return true;
}
// RegDeleteTree each path (relative to HKCU\Software\Classes), deepest first so a child is
// removed before its parent. Bypasses the overlay hooks (Reenter) — this touches the REAL
// registry only.
std::vector<std::wstring> deleteUserClassesKeys(HKEY classesRoot,
                                                const std::vector<std::wstring>& paths) {
  auto del = resolveRegDeleteTreeW();
  std::vector<std::wstring> safePaths;
  std::unordered_set<std::wstring> seen;
  for (const std::wstring& rawPath : paths) {
    std::wstring path;
    if (!allowedUserClassesCleanupPath(rawPath, path)) {
      tracef("[regov] rejected unowned classes cleanup path: %ls\n", rawPath.c_str());
      continue;
    }
    if (seen.insert(lc(path)).second) safePaths.push_back(std::move(path));
  }
  std::sort(safePaths.begin(), safePaths.end(),
            [](const std::wstring& a, const std::wstring& b) { return a.size() > b.size(); });
  std::vector<std::wstring> retry;
  for (const std::wstring& path : safePaths) {
    if (!userClassesKeyHasOwner(classesRoot, path)) {
      tracef("[regov] refused classes cleanup without matching owner: %ls\n", path.c_str());
      continue;
    }
    if (!del) {
      retry.push_back(path);
      continue;
    }
    const LSTATUS status = del(classesRoot, path.c_str());
    if (status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND &&
        status != ERROR_PATH_NOT_FOUND) {
      tracef("[regov] classes cleanup failed (%ld): %ls\n", static_cast<long>(status),
             path.c_str());
      retry.push_back(path);
    }
  }
  return retry;
}
std::vector<std::wstring> readClassesSidecar() {
  std::vector<std::wstring> out;
  if (g_classesSidecar.empty() || !pathExists(g_classesSidecar)) return out;
  std::wstring text = readRegFileAsWide(g_classesSidecar);
  std::wstring cur;
  for (wchar_t c : text) {
    if (c == L'\n') {
      std::wstring t = trim(cur);
      if (!t.empty()) out.push_back(t);
      cur.clear();
    } else if (c != L'\r') {
      cur.push_back(c);
    }
  }
  std::wstring t = trim(cur);
  if (!t.empty()) out.push_back(t);
  return out;
}
void writeClassesSidecar() {
  if (g_classesSidecar.empty()) return;
  if (g_tempUserClassesLeaves.empty()) {
    DeleteFileW(g_classesSidecar.c_str());
    return;
  }
  // Narrow (CP_ACP) one-path-per-line — class key names are ASCII. NOT std::wofstream: its
  // default "C"-locale codecvt cannot encode wide output and silently drops everything.
  // readRegFileAsWide() reads a BOM-less file back as CP_ACP, so this round-trips.
  std::ofstream f(g_classesSidecar, std::ios::binary | std::ios::trunc);
  if (!f) return;
  for (const std::wstring& p : g_tempUserClassesLeaves) {
    const std::string a = wToA(p);
    f.write(a.data(), static_cast<std::streamsize>(a.size()));
    f.write("\r\n", 2);
  }
}
void installTempUserClasses() {
  Reenter re; // stale-cleanup + materialize touch the REAL registry; never re-enter the overlay
  // Load the retry journal before opening HKCU. If the registry is temporarily
  // unavailable, flushRegOverlay must retain this journal rather than treating
  // an empty in-memory list as proof that there is nothing left to clean.
  g_tempUserClassesLeaves = readClassesSidecar();
  g_allowedUserClassesPaths.clear();
  const Key* classes = findKey(HKEY_CLASSES_ROOT, {});
  if (classes)
    for (const auto& [_, child] : classes->subkeys)
      collectAllowedUserClassesPaths(child, child.name);

  HKEY software = nullptr;
  HKEY classesRoot = nullptr;
  if (!openUserClassesRoot(software, classesRoot)) return;

  // Crash resilience: a prior run of THIS capture that died before cleanup (very common with
  // these old plugins) left our volatile keys behind — they persist until logoff and can shadow
  // a real installed component. Delete only authenticated paths that also belong to this
  // capture; retain any safe deletion failures for a later retry.
  g_tempUserClassesLeaves = deleteUserClassesKeys(classesRoot, g_tempUserClassesLeaves);

  if (classes && !classes->subkeys.empty()) {
    for (const auto& [_, sk] : classes->subkeys)
      materializeKeyToUserClasses(classesRoot, sk.name, sk.name, sk);
    tracef("[regov] materialized %zu HKCR leaf key(s) into HKCU\\\\Software\\\\Classes\n",
           g_tempUserClassesLeaves.size());
  }
  // This both records newly created keys and retains authenticated keys whose
  // deletion failed, so the next run can retry instead of orphaning them.
  writeClassesSidecar();
  RegCloseKey(classesRoot);
  RegCloseKey(software);
}
void cleanupTempUserClasses() {
  if (g_tempUserClassesLeaves.empty()) {
    if (!g_classesSidecar.empty()) DeleteFileW(g_classesSidecar.c_str());
    return;
  }
  Reenter re;
  HKEY software = nullptr;
  HKEY classesRoot = nullptr;
  if (openUserClassesRoot(software, classesRoot)) {
    g_tempUserClassesLeaves = deleteUserClassesKeys(classesRoot, g_tempUserClassesLeaves);
    RegCloseKey(classesRoot);
    RegCloseKey(software);
  }
  writeClassesSidecar();
}

// ===========================================================================
// Bundle discovery
// ===========================================================================
std::wstring dirOf(const std::wstring& p) {
  size_t s = p.find_last_of(L"\\/");
  return s == std::wstring::npos ? std::wstring() : p.substr(0, s);
}
std::wstring fileOf(const std::wstring& p) {
  size_t s = p.find_last_of(L"\\/");
  return s == std::wstring::npos ? p : p.substr(s + 1);
}
bool isFile(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}
bool isDir(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

// Find the capture bundle: a flat <dll>.reg / <stem>.reg next to the plugin, else the nearest
// ancestor with install.reg or files\. Sets g_regPath/g_bundleRoot/g_mirrorRoot.
bool discoverBundle(const std::wstring& pluginPath) {
  std::wstring dir = dirOf(pluginPath);
  std::wstring file = fileOf(pluginPath);
  std::wstring stem = file;
  size_t dot = stem.find_last_of(L'.');
  if (dot != std::wstring::npos) stem.resize(dot);

  // Flat: <dll>.reg or <stem>.reg next to the plugin.
  for (const std::wstring& cand : {dir + L"\\" + file + L".reg", dir + L"\\" + stem + L".reg"}) {
    if (isFile(cand)) {
      g_regPath = cand;
      g_bundleRoot = dir;
      g_mirrorRoot = isDir(dir + L"\\files") ? (dir + L"\\files") : std::wstring();
      return true;
    }
  }
  // Flat bundle next to the plugin.
  if (isDir(dir + L"\\files")) {
    std::wstring cand = dir + L"\\install.reg";
    g_regPath = isFile(cand) ? cand : std::wstring();
    g_bundleRoot = dir;
    g_mirrorRoot = dir + L"\\files";
    return true;
  }

  // Bundle: nearest ancestor install.reg or files\.
  std::wstring cur = dir;
  for (int i = 0; i < 16 && !cur.empty(); ++i) {
    std::wstring cand = cur + L"\\install.reg";
    std::wstring files = cur + L"\\files";
    if (isFile(cand) || isDir(files)) {
      g_regPath = isFile(cand) ? cand : std::wstring();
      g_bundleRoot = cur;
      g_mirrorRoot = isDir(files) ? files : std::wstring();
      return true;
    }
    std::wstring up = dirOf(cur);
    if (up == cur) break;
    cur = up;
  }
  return false;
}

// ===========================================================================
// Bundle DLL search (M2): old plugins load helper DLLs BY NAME from the captured
// C\WINDOWS\system32 (e.g. NI Kontakt's NI_DFD/NI_IRC/REX, or Waves' msvcr71). Make those
// resolve out of the bundle by PREPENDING the mirror's system dirs to this process's PATH —
// purely additive, so the legacy search order (CWD/PATH) old plugins rely on is preserved
// (unlike SetDefaultDllDirectories, which would strip it). AddDllDirectory too, for callers
// that opt into LOAD_LIBRARY_SEARCH_USER_DIRS.
std::wstring getEnvW(const wchar_t* key) {
  DWORD n = GetEnvironmentVariableW(key, nullptr, 0);
  if (!n) return {};
  std::wstring v(n, L'\0');
  DWORD m = GetEnvironmentVariableW(key, v.data(), n);
  v.resize(m);
  return v;
}
void setupBundleDllSearch() {
  if (g_mirrorRoot.empty()) return;
  const std::wstring dirs[] = {
      g_mirrorRoot + L"\\C\\WINDOWS\\system32",
      g_mirrorRoot + L"\\C\\WINDOWS\\SysWOW64",
      g_mirrorRoot + L"\\C\\WINDOWS",
  };
  using AddDllDirFn = PVOID(WINAPI*)(PCWSTR);  // AddDllDirectory (Win8+); resolve dynamically
  auto addDllDir = reinterpret_cast<AddDllDirFn>(
      GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "AddDllDirectory"));
  std::wstring prefix;
  for (const std::wstring& d : dirs) {
    if (!isDir(d)) continue;
    prefix += d + L";";
    if (addDllDir) addDllDir(d.c_str());
  }
  if (prefix.empty()) return;
  SetEnvironmentVariableW(L"PATH", (prefix + getEnvW(L"PATH")).c_str());
  tracef("[regov] bundle DLL search: prepended %ls\n", prefix.c_str());
}

// ===========================================================================
// Hook install
// ===========================================================================
void* hookBoth(const char* name, void* detour) {
  void* origK = nullptr;
  void* origA = nullptr;
  MH_STATUS sk = MH_CreateHookApi(L"kernelbase.dll", name, detour, &origK);
  MH_STATUS sa = MH_CreateHookApi(L"advapi32.dll", name, detour, &origA);
  tracef("[regov] hook %-18s kbase=%s advapi=%s\n", name, MH_StatusToString(sk),
         MH_StatusToString(sa));
  return origK ? origK : origA;  // prefer the kernelbase implementation for fall-through
}
void* hookKernelFile(const char* name, void* detour) {
  void* origK = nullptr;
  void* orig32 = nullptr;
  MH_STATUS sk = MH_CreateHookApi(L"kernelbase.dll", name, detour, &origK);
  MH_STATUS s32 = MH_CreateHookApi(L"kernel32.dll", name, detour, &orig32);
  tracef("[fileov] hook %-18s kbase=%s k32=%s\n", name, MH_StatusToString(sk),
         MH_StatusToString(s32));
  return origK ? origK : orig32;
}
void* hookUser32(const char* name, void* detour) {
  void* orig = nullptr;
  MH_STATUS s = MH_CreateHookApi(L"user32.dll", name, detour, &orig);
  dialogf("[dlg] hook %-18s user32=%s\n", name, MH_StatusToString(s));
  return orig;
}
void* hookOle32(const char* name, void* detour) {
  void* orig = nullptr;
  MH_STATUS s = MH_CreateHookApi(L"ole32.dll", name, detour, &orig);
  tracef("[regov] hook %-18s ole32=%s\n", name, MH_StatusToString(s));
  return orig;
}

} // namespace

// ===========================================================================
// Public API
// ===========================================================================
bool installRegOverlayIfPresent(const std::wstring& pluginPath) {
  if (g_armed) return true;
  if (!discoverBundle(pluginPath)) return false;

  g_regOverlayActive = !g_regPath.empty();
  g_fileOverlayActive = !g_mirrorRoot.empty();
  g_localPath = g_regOverlayActive ? g_regPath + L".local" : std::wstring();
  // Sidecar listing the HKCU\Software\Classes keys we materialize (installTempUserClasses),
  // so a run that crashes before cleanup can be self-healed on the next arm (SPEC §8.5).
  g_classesSidecar = g_regOverlayActive ? g_regPath + L".classes" : std::wstring();
  tracef("[regov] bundle: reg=%ls\n         root=%ls\n         mirror=%ls\n", g_regPath.c_str(),
         g_bundleRoot.c_str(), g_mirrorRoot.empty() ? L"(none)" : g_mirrorRoot.c_str());

  if (g_regOverlayActive) {
    g_roots[HKEY_LOCAL_MACHINE];
    g_roots[HKEY_CURRENT_USER];
    g_roots[HKEY_CLASSES_ROOT];
    g_roots[HKEY_USERS];
    g_roots[HKEY_CURRENT_CONFIG];

    parseRegInto(g_regPath, /*markLocal=*/false);
    if (isFile(g_localPath)) parseRegInto(g_localPath, /*markLocal=*/true);
    installTempUserClasses();
  }

  // M2: make the bundle's captured system DLLs (loaded BY NAME by the plugin) resolvable.
  setupBundleDllSearch();

  // advapi32/kernelbase/kernel32 are already loaded; ensure handles for MinHook.
  LoadLibraryW(L"advapi32.dll");
  LoadLibraryW(L"kernelbase.dll");
  LoadLibraryW(L"kernel32.dll");
  LoadLibraryW(L"ole32.dll");
  LoadLibraryW(L"user32.dll");

  if (MH_Initialize() != MH_OK) {
    std::fprintf(stderr, "[regov] MH_Initialize failed — overlay disabled\n");
    cleanupTempUserClasses();
    return false;
  }

  if (g_regOverlayActive) {
    g_real.RegOpenKeyExW = (decltype(g_real.RegOpenKeyExW))hookBoth("RegOpenKeyExW", (void*)&Det_RegOpenKeyExW);
    g_real.RegOpenKeyExA = (decltype(g_real.RegOpenKeyExA))hookBoth("RegOpenKeyExA", (void*)&Det_RegOpenKeyExA);
    g_real.RegOpenKeyW = (decltype(g_real.RegOpenKeyW))hookBoth("RegOpenKeyW", (void*)&Det_RegOpenKeyW);
    g_real.RegOpenKeyA = (decltype(g_real.RegOpenKeyA))hookBoth("RegOpenKeyA", (void*)&Det_RegOpenKeyA);
    g_real.RegCreateKeyExW = (decltype(g_real.RegCreateKeyExW))hookBoth("RegCreateKeyExW", (void*)&Det_RegCreateKeyExW);
    g_real.RegCreateKeyExA = (decltype(g_real.RegCreateKeyExA))hookBoth("RegCreateKeyExA", (void*)&Det_RegCreateKeyExA);
    g_real.RegCreateKeyW = (decltype(g_real.RegCreateKeyW))hookBoth("RegCreateKeyW", (void*)&Det_RegCreateKeyW);
    g_real.RegCreateKeyA = (decltype(g_real.RegCreateKeyA))hookBoth("RegCreateKeyA", (void*)&Det_RegCreateKeyA);
    g_real.RegQueryValueExW = (decltype(g_real.RegQueryValueExW))hookBoth("RegQueryValueExW", (void*)&Det_RegQueryValueExW);
    g_real.RegQueryValueExA = (decltype(g_real.RegQueryValueExA))hookBoth("RegQueryValueExA", (void*)&Det_RegQueryValueExA);
    g_real.RegQueryValueW = (decltype(g_real.RegQueryValueW))hookBoth("RegQueryValueW", (void*)&Det_RegQueryValueW);
    g_real.RegQueryValueA = (decltype(g_real.RegQueryValueA))hookBoth("RegQueryValueA", (void*)&Det_RegQueryValueA);
    g_real.RegGetValueW = (decltype(g_real.RegGetValueW))hookBoth("RegGetValueW", (void*)&Det_RegGetValueW);
    g_real.RegGetValueA = (decltype(g_real.RegGetValueA))hookBoth("RegGetValueA", (void*)&Det_RegGetValueA);
    g_real.RegSetValueExW = (decltype(g_real.RegSetValueExW))hookBoth("RegSetValueExW", (void*)&Det_RegSetValueExW);
    g_real.RegSetValueExA = (decltype(g_real.RegSetValueExA))hookBoth("RegSetValueExA", (void*)&Det_RegSetValueExA);
    g_real.RegEnumKeyExW = (decltype(g_real.RegEnumKeyExW))hookBoth("RegEnumKeyExW", (void*)&Det_RegEnumKeyExW);
    g_real.RegEnumKeyExA = (decltype(g_real.RegEnumKeyExA))hookBoth("RegEnumKeyExA", (void*)&Det_RegEnumKeyExA);
    g_real.RegEnumKeyW = (decltype(g_real.RegEnumKeyW))hookBoth("RegEnumKeyW", (void*)&Det_RegEnumKeyW);
    g_real.RegEnumKeyA = (decltype(g_real.RegEnumKeyA))hookBoth("RegEnumKeyA", (void*)&Det_RegEnumKeyA);
    g_real.RegEnumValueW = (decltype(g_real.RegEnumValueW))hookBoth("RegEnumValueW", (void*)&Det_RegEnumValueW);
    g_real.RegEnumValueA = (decltype(g_real.RegEnumValueA))hookBoth("RegEnumValueA", (void*)&Det_RegEnumValueA);
    g_real.RegQueryInfoKeyW = (decltype(g_real.RegQueryInfoKeyW))hookBoth("RegQueryInfoKeyW", (void*)&Det_RegQueryInfoKeyW);
    g_real.RegQueryInfoKeyA = (decltype(g_real.RegQueryInfoKeyA))hookBoth("RegQueryInfoKeyA", (void*)&Det_RegQueryInfoKeyA);
    g_real.RegDeleteValueW = (decltype(g_real.RegDeleteValueW))hookBoth("RegDeleteValueW", (void*)&Det_RegDeleteValueW);
    g_real.RegDeleteValueA = (decltype(g_real.RegDeleteValueA))hookBoth("RegDeleteValueA", (void*)&Det_RegDeleteValueA);
    g_real.RegDeleteKeyW = (decltype(g_real.RegDeleteKeyW))hookBoth("RegDeleteKeyW", (void*)&Det_RegDeleteKeyW);
    g_real.RegDeleteKeyA = (decltype(g_real.RegDeleteKeyA))hookBoth("RegDeleteKeyA", (void*)&Det_RegDeleteKeyA);
    g_real.RegOpenUserClassesRoot = (decltype(g_real.RegOpenUserClassesRoot))hookBoth("RegOpenUserClassesRoot", (void*)&Det_RegOpenUserClassesRoot);
    g_real.RegCloseKey = (decltype(g_real.RegCloseKey))hookBoth("RegCloseKey", (void*)&Det_RegCloseKey);
    g_real.RegFlushKey = (decltype(g_real.RegFlushKey))hookBoth("RegFlushKey", (void*)&Det_RegFlushKey);
  }
  if (g_fileOverlayActive) {
    g_real.CreateFileW = (decltype(g_real.CreateFileW))hookKernelFile("CreateFileW", (void*)&Det_CreateFileW);
    g_real.CreateFileA = (decltype(g_real.CreateFileA))hookKernelFile("CreateFileA", (void*)&Det_CreateFileA);
    g_real.GetFileAttributesW = (decltype(g_real.GetFileAttributesW))hookKernelFile("GetFileAttributesW", (void*)&Det_GetFileAttributesW);
    g_real.GetFileAttributesA = (decltype(g_real.GetFileAttributesA))hookKernelFile("GetFileAttributesA", (void*)&Det_GetFileAttributesA);
    g_real.GetFileAttributesExW = (decltype(g_real.GetFileAttributesExW))hookKernelFile("GetFileAttributesExW", (void*)&Det_GetFileAttributesExW);
    g_real.GetFileAttributesExA = (decltype(g_real.GetFileAttributesExA))hookKernelFile("GetFileAttributesExA", (void*)&Det_GetFileAttributesExA);
    g_real.FindFirstFileW = (decltype(g_real.FindFirstFileW))hookKernelFile("FindFirstFileW", (void*)&Det_FindFirstFileW);
    g_real.FindFirstFileA = (decltype(g_real.FindFirstFileA))hookKernelFile("FindFirstFileA", (void*)&Det_FindFirstFileA);
    g_real.FindFirstFileExW = (decltype(g_real.FindFirstFileExW))hookKernelFile("FindFirstFileExW", (void*)&Det_FindFirstFileExW);
    g_real.FindFirstFileExA = (decltype(g_real.FindFirstFileExA))hookKernelFile("FindFirstFileExA", (void*)&Det_FindFirstFileExA);
    g_real.DeleteFileW = (decltype(g_real.DeleteFileW))hookKernelFile("DeleteFileW", (void*)&Det_DeleteFileW);
    g_real.DeleteFileA = (decltype(g_real.DeleteFileA))hookKernelFile("DeleteFileA", (void*)&Det_DeleteFileA);
    g_real.LoadLibraryW = (decltype(g_real.LoadLibraryW))hookKernelFile("LoadLibraryW", (void*)&Det_LoadLibraryW);
    g_real.LoadLibraryA = (decltype(g_real.LoadLibraryA))hookKernelFile("LoadLibraryA", (void*)&Det_LoadLibraryA);
    g_real.LoadLibraryExW = (decltype(g_real.LoadLibraryExW))hookKernelFile("LoadLibraryExW", (void*)&Det_LoadLibraryExW);
    g_real.LoadLibraryExA = (decltype(g_real.LoadLibraryExA))hookKernelFile("LoadLibraryExA", (void*)&Det_LoadLibraryExA);
  }
  g_real.CoCreateInstance = (decltype(g_real.CoCreateInstance))hookOle32("CoCreateInstance", (void*)&Det_CoCreateInstance);
  g_real.MessageBoxW = (decltype(g_real.MessageBoxW))hookUser32("MessageBoxW", (void*)&Det_MessageBoxW);
  g_real.MessageBoxA = (decltype(g_real.MessageBoxA))hookUser32("MessageBoxA", (void*)&Det_MessageBoxA);

  if (MH_EnableHook(MH_ALL_HOOKS) != MH_OK) {
    std::fprintf(stderr, "[regov] MH_EnableHook failed — overlay disabled\n");
    MH_DisableHook(MH_ALL_HOOKS);
    MH_Uninitialize();
    cleanupTempUserClasses();
    return false;
  }
  g_armed = true;
  if (g_regOverlayActive)
    std::fprintf(stderr, "[regov] registry overlay armed from \"%ls\"\n", g_regPath.c_str());
  if (g_fileOverlayActive)
    std::fprintf(stderr, "[fileov] file overlay armed from \"%ls\"\n", g_mirrorRoot.c_str());
  return true;
}

RegOverlayStatus regOverlayStatus() {
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  return {g_armed, g_regOverlayActive, g_fileOverlayActive, g_regPath, g_mirrorRoot};
}

void flushRegOverlay() {
  std::lock_guard<std::recursive_mutex> lk(g_mu);
  if (g_armed && g_dirty && !g_localPath.empty()) {
    std::wofstream f(g_localPath, std::ios::binary | std::ios::trunc);
    if (f) {
      f << L"\xFEFF";  // UTF-16LE BOM (wofstream writes wchar_t units on Windows)
      f << L"Windows Registry Editor Version 5.00\r\n\r\n";
      for (auto& [root, key] : g_roots) serializeKey(f, rootName(root), key);
      g_dirty = false;
    }
  }
  cleanupTempUserClasses();
}

} // namespace mydaw
