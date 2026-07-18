#pragma once
//
// shared/ipc/SharedMem.h
//
// RAII wrappers around Windows named file mappings (CreateFileMappingW /
// OpenFileMappingW + MapViewOfFile) and named events, used for the engine ⇄
// plugin-host shared-memory audio path (SPEC §8.1). Engine creates, host
// opens. Header deliberately avoids <windows.h>; handles are stored as void*.
//
#include <cstdint>
#include <string>

namespace mydaw {

// Small shared utilities (implemented in SharedMem.cpp, also used by Pipe.cpp).
// `ipc`-prefixed so they never form an ambiguous overload set with the engine's
// utf8ToWide/wideToUtf8 (engine/src/util/Paths.h, string_view signatures) — both
// translation units are compiled into mydaw-engine.
std::wstring ipcUtf8ToWide(const std::string& s);
std::string  ipcWideToUtf8(const std::wstring& s);
std::string  win32ErrorString(uint32_t errorCode); // "<message> (code N)"

// A named, pagefile-backed shared memory mapping. Move-only.
class SharedMem {
public:
  SharedMem() = default;
  ~SharedMem();
  SharedMem(SharedMem&& other) noexcept;
  SharedMem& operator=(SharedMem&& other) noexcept;
  SharedMem(const SharedMem&) = delete;
  SharedMem& operator=(const SharedMem&) = delete;

  // Engine side: create (or reopen, see alreadyExisted()) a named mapping of
  // sizeBytes and map a read/write view. Returns false + errorString on fail.
  bool create(const std::string& name, uint32_t sizeBytes);

  // Host side: open an existing named mapping and map the full view.
  // size() then reports the page-rounded region size (≥ created size).
  bool open(const std::string& name);

  // Unmap and close. Safe to call repeatedly; called by the destructor.
  void close();

  void* data() const { return view_; }
  uint32_t size() const { return size_; }
  bool valid() const { return view_ != nullptr; }
  // True if create() attached to a mapping that already existed (e.g. the
  // engine recreating IPC for a restarted host with the same name).
  bool alreadyExisted() const { return alreadyExisted_; }
  const std::string& errorString() const { return error_; }

private:
  void* mapping_ = nullptr; // HANDLE
  void* view_ = nullptr;
  uint32_t size_ = 0;
  bool alreadyExisted_ = false;
  std::string error_;
};

// A named Windows event. Auto-reset by default (the §8.1 req/done events are
// auto-reset). Move-only.
class NamedEvent {
public:
  enum class WaitResult { Signaled, Timeout, Failed };
  static constexpr uint32_t kInfinite = 0xFFFFFFFFu;

  NamedEvent() = default;
  ~NamedEvent();
  NamedEvent(NamedEvent&& other) noexcept;
  NamedEvent& operator=(NamedEvent&& other) noexcept;
  NamedEvent(const NamedEvent&) = delete;
  NamedEvent& operator=(const NamedEvent&) = delete;

  bool create(const std::string& name, bool manualReset = false);
  bool open(const std::string& name);
  void close();

  bool set();   // SetEvent
  bool reset(); // ResetEvent (manual-reset events only)
  WaitResult wait(uint32_t timeoutMs);

  // Raw HANDLE for WaitForMultipleObjects-style composition.
  void* nativeHandle() const { return handle_; }
  bool valid() const { return handle_ != nullptr; }
  bool alreadyExisted() const { return alreadyExisted_; }
  const std::string& errorString() const { return error_; }

private:
  void* handle_ = nullptr; // HANDLE
  bool alreadyExisted_ = false;
  std::string error_;
};

} // namespace mydaw
