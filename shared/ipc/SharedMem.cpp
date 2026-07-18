//
// shared/ipc/SharedMem.cpp — see SharedMem.h.
//
#include "SharedMem.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <utility>

namespace mydaw {

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
std::wstring ipcUtf8ToWide(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(),
                                    static_cast<int>(s.size()), nullptr, 0);
  if (n <= 0) return {};
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                      out.data(), n);
  return out;
}

std::string ipcWideToUtf8(const std::wstring& s) {
  if (s.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, s.data(),
                                    static_cast<int>(s.size()), nullptr, 0,
                                    nullptr, nullptr);
  if (n <= 0) return {};
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                      out.data(), n, nullptr, nullptr);
  return out;
}

std::string win32ErrorString(uint32_t errorCode) {
  wchar_t* buf = nullptr;
  const DWORD len = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, errorCode, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      reinterpret_cast<wchar_t*>(&buf), 0, nullptr);
  std::string msg;
  if (len && buf) {
    std::wstring w(buf, len);
    while (!w.empty() && (w.back() == L'\r' || w.back() == L'\n' ||
                          w.back() == L' ' || w.back() == L'.'))
      w.pop_back();
    msg = ipcWideToUtf8(w);
  }
  if (buf) LocalFree(buf);
  if (msg.empty()) msg = "unknown error";
  return msg + " (code " + std::to_string(errorCode) + ")";
}

namespace {
std::string makeError(const char* where, DWORD err) {
  return std::string(where) + ": " + win32ErrorString(err);
}
} // namespace

// ---------------------------------------------------------------------------
// SharedMem
// ---------------------------------------------------------------------------
SharedMem::~SharedMem() { close(); }

SharedMem::SharedMem(SharedMem&& other) noexcept
    : mapping_(std::exchange(other.mapping_, nullptr)),
      view_(std::exchange(other.view_, nullptr)),
      size_(std::exchange(other.size_, 0)),
      alreadyExisted_(std::exchange(other.alreadyExisted_, false)),
      error_(std::move(other.error_)) {}

SharedMem& SharedMem::operator=(SharedMem&& other) noexcept {
  if (this != &other) {
    close();
    mapping_ = std::exchange(other.mapping_, nullptr);
    view_ = std::exchange(other.view_, nullptr);
    size_ = std::exchange(other.size_, 0);
    alreadyExisted_ = std::exchange(other.alreadyExisted_, false);
    error_ = std::move(other.error_);
  }
  return *this;
}

bool SharedMem::create(const std::string& name, uint32_t sizeBytes) {
  close();
  error_.clear();
  if (sizeBytes == 0) {
    error_ = "SharedMem::create: zero size";
    return false;
  }
  const std::wstring wname = ipcUtf8ToWide(name);
  HANDLE h = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                0, sizeBytes, wname.c_str());
  if (!h) {
    error_ = makeError("CreateFileMappingW", GetLastError());
    return false;
  }
  alreadyExisted_ = (GetLastError() == ERROR_ALREADY_EXISTS);
  void* v = MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, 0);
  if (!v) {
    error_ = makeError("MapViewOfFile", GetLastError());
    CloseHandle(h);
    return false;
  }
  mapping_ = h;
  view_ = v;
  size_ = sizeBytes;
  return true;
}

bool SharedMem::open(const std::string& name) {
  close();
  error_.clear();
  const std::wstring wname = ipcUtf8ToWide(name);
  HANDLE h = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, wname.c_str());
  if (!h) {
    error_ = makeError("OpenFileMappingW", GetLastError());
    return false;
  }
  void* v = MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, 0);
  if (!v) {
    error_ = makeError("MapViewOfFile", GetLastError());
    CloseHandle(h);
    return false;
  }
  MEMORY_BASIC_INFORMATION mbi{};
  if (VirtualQuery(v, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    size_ = static_cast<uint32_t>(mbi.RegionSize); // page-rounded
  } else {
    size_ = 0;
  }
  mapping_ = h;
  view_ = v;
  alreadyExisted_ = true;
  return true;
}

void SharedMem::close() {
  if (view_) {
    UnmapViewOfFile(view_);
    view_ = nullptr;
  }
  if (mapping_) {
    CloseHandle(static_cast<HANDLE>(mapping_));
    mapping_ = nullptr;
  }
  size_ = 0;
  alreadyExisted_ = false;
}

// ---------------------------------------------------------------------------
// NamedEvent
// ---------------------------------------------------------------------------
NamedEvent::~NamedEvent() { close(); }

NamedEvent::NamedEvent(NamedEvent&& other) noexcept
    : handle_(std::exchange(other.handle_, nullptr)),
      alreadyExisted_(std::exchange(other.alreadyExisted_, false)),
      error_(std::move(other.error_)) {}

NamedEvent& NamedEvent::operator=(NamedEvent&& other) noexcept {
  if (this != &other) {
    close();
    handle_ = std::exchange(other.handle_, nullptr);
    alreadyExisted_ = std::exchange(other.alreadyExisted_, false);
    error_ = std::move(other.error_);
  }
  return *this;
}

bool NamedEvent::create(const std::string& name, bool manualReset) {
  close();
  error_.clear();
  const std::wstring wname = ipcUtf8ToWide(name);
  HANDLE h = CreateEventW(nullptr, manualReset ? TRUE : FALSE, FALSE,
                          wname.empty() ? nullptr : wname.c_str());
  if (!h) {
    error_ = makeError("CreateEventW", GetLastError());
    return false;
  }
  alreadyExisted_ = (GetLastError() == ERROR_ALREADY_EXISTS);
  handle_ = h;
  return true;
}

bool NamedEvent::open(const std::string& name) {
  close();
  error_.clear();
  const std::wstring wname = ipcUtf8ToWide(name);
  HANDLE h = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, wname.c_str());
  if (!h) {
    error_ = makeError("OpenEventW", GetLastError());
    return false;
  }
  handle_ = h;
  alreadyExisted_ = true;
  return true;
}

void NamedEvent::close() {
  if (handle_) {
    CloseHandle(static_cast<HANDLE>(handle_));
    handle_ = nullptr;
  }
  alreadyExisted_ = false;
}

bool NamedEvent::set() {
  if (!handle_) return false;
  if (!SetEvent(static_cast<HANDLE>(handle_))) {
    error_ = makeError("SetEvent", GetLastError());
    return false;
  }
  return true;
}

bool NamedEvent::reset() {
  if (!handle_) return false;
  if (!ResetEvent(static_cast<HANDLE>(handle_))) {
    error_ = makeError("ResetEvent", GetLastError());
    return false;
  }
  return true;
}

NamedEvent::WaitResult NamedEvent::wait(uint32_t timeoutMs) {
  if (!handle_) return WaitResult::Failed;
  const DWORD t = (timeoutMs == kInfinite) ? INFINITE : timeoutMs;
  switch (WaitForSingleObject(static_cast<HANDLE>(handle_), t)) {
    case WAIT_OBJECT_0:
      return WaitResult::Signaled;
    case WAIT_TIMEOUT:
      return WaitResult::Timeout;
    default:
      error_ = makeError("WaitForSingleObject", GetLastError());
      return WaitResult::Failed;
  }
}

} // namespace mydaw
