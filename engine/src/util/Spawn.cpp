// MyDAW — util/Spawn.cpp (Win32)

#include "util/Spawn.h"

// winsock2 must precede windows.h.
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <string>
#include <vector>

namespace mydaw {
namespace {

std::wstring toWide(const std::string& s) {
    if (s.empty())
        return {};
    const int n =
        MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

// Ref-counted Winsock init (safe even though the HTTP server already started Winsock).
struct WsaGuard {
    bool ok = false;
    WsaGuard() {
        WSADATA d;
        ok = WSAStartup(MAKEWORD(2, 2), &d) == 0;
    }
    ~WsaGuard() {
        if (ok)
            WSACleanup();
    }
};

} // namespace

bool launchDetached(const std::string& exeUtf8, const std::string& argsAfterExeUtf8,
                    std::string& err) {
    const std::wstring wExe = toWide(exeUtf8);
    std::wstring cmd = L"\"" + wExe + L"\" " + toWide(argsAfterExeUtf8);
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    // New process group so a Ctrl+C in the parent's console does not also kill the child;
    // no CREATE_NO_WINDOW — the child is a peer engine with its own console-ctrl shutdown.
    if (!CreateProcessW(wExe.c_str(), cmdBuf.data(), nullptr, nullptr, /*inherit*/ FALSE,
                        CREATE_NEW_PROCESS_GROUP, nullptr, nullptr, &si, &pi)) {
        err = "CreateProcess failed (" + std::to_string(GetLastError()) + ")";
        return false;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess); // fully independent; we keep no handle
    return true;
}

int findFreeLoopbackPort(std::string& err) {
    WsaGuard wsa;
    if (!wsa.ok) {
        err = "WSAStartup failed";
        return 0;
    }
    const SOCKET s = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) {
        err = "socket() failed";
        return 0;
    }
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0; // let the OS assign
    int port = 0;
    if (::bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) {
        int len = sizeof(addr);
        if (::getsockname(s, reinterpret_cast<sockaddr*>(&addr), &len) == 0)
            port = ntohs(addr.sin_port);
        else
            err = "getsockname() failed";
    } else {
        err = "bind() failed";
    }
    ::closesocket(s);
    return port;
}

bool waitForLoopbackPort(int port, int timeoutMs, std::string& err) {
    WsaGuard wsa;
    if (!wsa.ok) {
        err = "WSAStartup failed";
        return false;
    }
    const ULONGLONG deadline = GetTickCount64() + static_cast<ULONGLONG>(timeoutMs);
    for (;;) {
        const SOCKET s = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (s != INVALID_SOCKET) {
            sockaddr_in addr{};
            addr.sin_family = AF_INET;
            addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            addr.sin_port = htons(static_cast<u_short>(port));
            const int r = ::connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
            ::closesocket(s);
            if (r == 0)
                return true;
        }
        if (GetTickCount64() >= deadline) {
            err = "timed out waiting for 127.0.0.1:" + std::to_string(port);
            return false;
        }
        ::Sleep(50);
    }
}

} // namespace mydaw
