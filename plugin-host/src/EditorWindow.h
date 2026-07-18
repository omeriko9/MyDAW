#pragma once
//
// plugin-host/src/EditorWindow.h
//
// Floating top-level window hosting the plugin's native editor (SPEC §5.6
// plugin/openEditor, §8.2 openEditor/closeEditor). Owned by the host process
// main thread:
//   * WS_OVERLAPPEDWINDOW without maximize (and without a sizing frame —
//     plugin editors are fixed-size; programmatic resizes go through
//     resizePending()), title "<plugin name> — MyDAW",
//   * client area sized to the adapter's openEditor size, DPI-aware
//     (per-monitor-v2 awareness is set process-wide in main.cpp),
//   * a 20 ms WM_TIMER calls adapter->editorIdle() (~50 Hz) and polls
//     adapter->resizePending() to grow/shrink the window,
//   * WM_CLOSE (user clicked X) → adapter->closeEditor() + destroy +
//     onUserClosed callback (main.cpp pushes an informational log).
//
// All methods must be called on the thread that runs the message pump
// (the host main thread). No Win32 types in this header.
//
#include <functional>
#include <string>

#include "PluginAdapter.h"

namespace mydaw {

class EditorWindow {
public:
  EditorWindow() = default;
  ~EditorWindow() { close(); }
  EditorWindow(const EditorWindow&) = delete;
  EditorWindow& operator=(const EditorWindow&) = delete;

  // Invoked on the main thread when the plugin requested a new editor size
  // (after the window was adjusted) — main.cpp pushes `resized` (§8.2).
  std::function<void(int width, int height)> onResized;
  // Invoked when the user closed the window (WM_CLOSE path only).
  std::function<void()> onUserClosed;

  // Create the window and attach the plugin editor. Returns false + err
  // (adapter->lastError() based) if the plugin has no editor or attach
  // failed. No-op returning true when already open.
  bool open(PluginAdapter* adapter, const std::string& pluginNameUtf8,
            std::string& err);

  // Detach the editor and destroy the window (pipe closeEditor / shutdown).
  void close();

  bool isOpen() const { return hwnd_ != nullptr; }
  void focus(); // bring to front (openEditor while already open)

  int width() const { return width_; }
  int height() const { return height_; }

private:
  friend struct EditorWindowAccess; // .cpp-side wndproc bridge
  void onTimerTick();
  void onUserClose();
  void closeImpl(bool notifyUser);
  void applyClientSize(int w, int h);

  void* hwnd_ = nullptr; // HWND
  PluginAdapter* adapter_ = nullptr;
  bool closing_ = false;
  int width_ = 0;
  int height_ = 0;
};

} // namespace mydaw
