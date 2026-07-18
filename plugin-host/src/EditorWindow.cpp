//
// plugin-host/src/EditorWindow.cpp — see EditorWindow.h.
//
#include "EditorWindow.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <cstdio>

#include "../../shared/ipc/SharedMem.h" // ipcUtf8ToWide
#include "../../shared/win/Foreground.h" // forceForegroundWindow (background-process raise)

namespace mydaw {

namespace {

constexpr UINT_PTR kIdleTimerId = 1;
constexpr UINT kIdleTimerMs = 20; // ~50 Hz editorIdle (SPEC §8.4)
constexpr wchar_t kClassName[] = L"MyDawEditorWindow";

// Fixed-size floating window: overlapped without maximize box or sizing
// frame (the editor decides its own size; resizes arrive via
// resizePending(), never from the user dragging a border).
constexpr DWORD kWinStyle =
    (WS_OVERLAPPEDWINDOW & ~(WS_MAXIMIZEBOX | WS_THICKFRAME)) | WS_CLIPCHILDREN;
constexpr DWORD kWinExStyle = WS_EX_APPWINDOW;

// Optional modern-DPI APIs, resolved dynamically so the binary also runs on
// older Windows 10 builds.
typedef UINT(WINAPI* GetDpiForWindowFn)(HWND);
typedef BOOL(WINAPI* AdjustWindowRectExForDpiFn)(LPRECT, DWORD, BOOL, DWORD,
                                                 UINT);

GetDpiForWindowFn pGetDpiForWindow() {
  static GetDpiForWindowFn fn = reinterpret_cast<GetDpiForWindowFn>(
      reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"user32.dll"),
                                             "GetDpiForWindow")));
  return fn;
}
AdjustWindowRectExForDpiFn pAdjustWindowRectExForDpi() {
  static AdjustWindowRectExForDpiFn fn =
      reinterpret_cast<AdjustWindowRectExForDpiFn>(reinterpret_cast<void*>(
          GetProcAddress(GetModuleHandleW(L"user32.dll"),
                         "AdjustWindowRectExForDpi")));
  return fn;
}

} // namespace

// Bridge so the file-scope wndproc can reach EditorWindow's private members.
struct EditorWindowAccess {
  static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wParam,
                                  LPARAM lParam) {
    auto* self = reinterpret_cast<EditorWindow*>(
        GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    switch (msg) {
      case WM_TIMER:
        if (self && wParam == kIdleTimerId) {
          self->onTimerTick();
          return 0;
        }
        break;
      case WM_CLOSE:
        if (self) {
          self->onUserClose();
          return 0;
        }
        break;
#ifndef WM_DPICHANGED
#define WM_DPICHANGED 0x02E0
#endif
      case WM_DPICHANGED: {
        // Use the system-suggested rect; the plugin child keeps its pixel
        // size (plugins handle DPI themselves or stay bitmap-scaled).
        const RECT* r = reinterpret_cast<const RECT*>(lParam);
        if (r) {
          SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left,
                       r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
        }
        return 0;
      }
      default:
        break;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
  }
};

namespace {

bool ensureClassRegistered() {
  static bool done = false;
  if (done) return true;
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.style = CS_DBLCLKS;
  wc.lpfnWndProc = &EditorWindowAccess::wndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512)); // IDC_ARROW
  wc.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  wc.lpszClassName = kClassName;
  wc.hIcon = LoadIconW(nullptr, MAKEINTRESOURCEW(32512)); // IDI_APPLICATION
  if (!RegisterClassExW(&wc)) {
    if (GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
  }
  done = true;
  return true;
}

} // namespace

bool EditorWindow::open(PluginAdapter* adapter,
                        const std::string& pluginNameUtf8, std::string& err) {
  if (hwnd_) return true;
  if (!adapter) {
    err = "no plugin adapter";
    return false;
  }
  if (!ensureClassRegistered()) {
    err = "RegisterClassEx failed: " + win32ErrorString(GetLastError());
    return false;
  }

  // "<plugin name> — MyDAW" (source is UTF-8; built with /utf-8).
  const std::wstring title = ipcUtf8ToWide(pluginNameUtf8) + L" — MyDAW";
  HWND hwnd = CreateWindowExW(kWinExStyle, kClassName, title.c_str(),
                              kWinStyle, CW_USEDEFAULT, CW_USEDEFAULT, 640,
                              480, nullptr, nullptr,
                              GetModuleHandleW(nullptr), nullptr);
  if (!hwnd) {
    err = "CreateWindowEx failed: " + win32ErrorString(GetLastError());
    return false;
  }
  SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
  hwnd_ = hwnd;
  adapter_ = adapter;

  EditorSize size;
  if (!adapter->openEditor(reinterpret_cast<HWND>(hwnd_), size)) {
    err = adapter->lastError().empty() ? "plugin failed to open its editor"
                                       : adapter->lastError();
    adapter_ = nullptr;
    hwnd_ = nullptr;
    DestroyWindow(hwnd);
    return false;
  }
  if (size.width <= 0 || size.height <= 0) {
    size.width = 640; // plugin gave no usable rect — pick a sane default
    size.height = 480;
  }
  applyClientSize(size.width, size.height);

  // Center on the work area of the monitor the window landed on.
  HMONITOR mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  RECT wr{};
  if (GetMonitorInfoW(mon, &mi) && GetWindowRect(hwnd, &wr)) {
    const int ww = wr.right - wr.left, wh = wr.bottom - wr.top;
    const int x = mi.rcWork.left +
                  ((mi.rcWork.right - mi.rcWork.left) - ww) / 2;
    const int y = mi.rcWork.top +
                  ((mi.rcWork.bottom - mi.rcWork.top) - wh) / 2;
    SetWindowPos(hwnd, nullptr, x, y, 0, 0,
                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  }

  ShowWindow(hwnd, SW_SHOWNORMAL);
  // The host is spawned CREATE_NO_WINDOW from a background console engine, so a plain
  // SetForegroundWindow() is demoted to a taskbar flash and the editor opens behind the
  // browser. forceForegroundWindow() lifts the restriction (AttachThreadInput).
  mydaw::forceForegroundWindow(hwnd);
  SetTimer(hwnd, kIdleTimerId, kIdleTimerMs, nullptr);
  return true;
}

void EditorWindow::close() { closeImpl(false); }

void EditorWindow::onUserClose() { closeImpl(true); }

void EditorWindow::closeImpl(bool notifyUser) {
  if (!hwnd_ || closing_) return;
  closing_ = true;
  HWND hwnd = reinterpret_cast<HWND>(hwnd_);
  KillTimer(hwnd, kIdleTimerId);
  if (adapter_) adapter_->closeEditor();
  adapter_ = nullptr;
  SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
  hwnd_ = nullptr;
  width_ = height_ = 0;
  DestroyWindow(hwnd);
  closing_ = false;
  if (notifyUser && onUserClosed) onUserClosed();
}

void EditorWindow::focus() {
  if (!hwnd_) return;
  // Re-opening an already-open editor routes here (host main.cpp): raise + focus it for real.
  mydaw::forceForegroundWindow(reinterpret_cast<HWND>(hwnd_));
}

void EditorWindow::onTimerTick() {
  if (!adapter_ || !hwnd_) return;
  adapter_->editorIdle();
  if (!adapter_ || !hwnd_) return; // editorIdle may have triggered a close
  EditorSize ns;
  if (adapter_->resizePending(ns) && ns.width > 0 && ns.height > 0) {
    applyClientSize(ns.width, ns.height);
    if (onResized) onResized(ns.width, ns.height);
  }
}

void EditorWindow::applyClientSize(int w, int h) {
  if (!hwnd_) return;
  HWND hwnd = reinterpret_cast<HWND>(hwnd_);
  RECT rc{0, 0, w, h};
  UINT dpi = 96;
  if (auto fn = pGetDpiForWindow()) dpi = fn(hwnd);
  if (auto fn = pAdjustWindowRectExForDpi())
    fn(&rc, kWinStyle, FALSE, kWinExStyle, dpi);
  else
    AdjustWindowRectEx(&rc, kWinStyle, FALSE, kWinExStyle);
  SetWindowPos(hwnd, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top,
               SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  width_ = w;
  height_ = h;
}

} // namespace mydaw
