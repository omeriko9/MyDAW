// MyDAW — shared/win/Foreground.h
//
// Force a top-level window to the foreground WITH keyboard focus from a process that Windows
// does NOT consider foreground-capable.
//
// Both mydaw-engine.exe (a console app that owns no HWND) and the plugin hosts (spawned with
// CREATE_NO_WINDOW) are background processes while the browser holds the foreground. Windows
// therefore demotes a bare SetForegroundWindow() to a taskbar flash — which is why the native
// file dialogs and VST editor windows opened BEHIND the browser and without focus.
//
// The supported workaround: temporarily attach our input queue to the current foreground
// thread's queue. For the duration of that attachment the foreground restrictions are lifted,
// so SetForegroundWindow/SetFocus actually take effect.
//
// Call on the thread that OWNS `hwnd` (the thread running its message pump).

#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

namespace mydaw {

inline void forceForegroundWindow(HWND hwnd) {
    if (!hwnd || !::IsWindow(hwnd))
        return;

    const HWND fg = ::GetForegroundWindow();
    const DWORD fgThread = fg ? ::GetWindowThreadProcessId(fg, nullptr) : 0;
    const DWORD myThread = ::GetCurrentThreadId();
    const bool attached =
        fgThread != 0 && fgThread != myThread && ::AttachThreadInput(fgThread, myThread, TRUE);

    if (::IsIconic(hwnd))
        ::ShowWindow(hwnd, SW_RESTORE);
    else
        ::ShowWindow(hwnd, SW_SHOW);

    // Cross in front of the browser via a momentary topmost, then drop back to normal
    // z-order so the window does not stay pinned above everything afterwards.
    ::SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    ::SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);

    ::BringWindowToTop(hwnd);
    ::SetForegroundWindow(hwnd);
    ::SetActiveWindow(hwnd);
    ::SetFocus(hwnd);

    if (attached)
        ::AttachThreadInput(fgThread, myThread, FALSE);
}

/**
 * A transient, invisible top-level window used as the OWNER of a modal shell dialog.
 *
 * IFileDialog::Show(nullptr) creates an unowned dialog, which a background process cannot
 * raise reliably. Giving it a real owner that we have just forced to the foreground makes the
 * dialog open in front and focused. Must be created/destroyed on the dialog's STA thread.
 */
class ForegroundOwnerWindow {
public:
    ForegroundOwnerWindow() {
        static const wchar_t* kClass = L"MyDawDialogOwner";
        static bool registered = false;
        if (!registered) {
            WNDCLASSEXW wc{};
            wc.cbSize = sizeof(wc);
            wc.lpfnWndProc = ::DefWindowProcW;
            wc.hInstance = ::GetModuleHandleW(nullptr);
            wc.lpszClassName = kClass;
            ::RegisterClassExW(&wc); // ignore "already registered"
            registered = true;
        }
        // 0x0, off-screen, tool window so it never shows in the taskbar or alt-tab.
        hwnd_ = ::CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, kClass, L"", WS_POPUP,
                                  -32000, -32000, 0, 0, nullptr, nullptr,
                                  ::GetModuleHandleW(nullptr), nullptr);
        if (hwnd_) {
            ::ShowWindow(hwnd_, SW_SHOWNA);
            forceForegroundWindow(hwnd_);
        }
    }

    ~ForegroundOwnerWindow() {
        if (hwnd_)
            ::DestroyWindow(hwnd_);
    }

    ForegroundOwnerWindow(const ForegroundOwnerWindow&) = delete;
    ForegroundOwnerWindow& operator=(const ForegroundOwnerWindow&) = delete;

    HWND get() const { return hwnd_; }

private:
    HWND hwnd_ = nullptr;
};

} // namespace mydaw
