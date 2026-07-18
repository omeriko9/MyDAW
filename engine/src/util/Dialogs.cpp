// MyDAW — util/Dialogs.cpp (E9). See Dialogs.h.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include "util/Dialogs.h"

#include <windows.h>

#include <shobjidl.h>

#include <thread>

#include "shared/win/Foreground.h"
#include "util/Log.h"
#include "util/Paths.h"

namespace mydaw {

namespace {

// Runs on the per-call STA thread.
bool runDialog(bool save, bool multi, const std::string& title,
               const std::vector<FileDialogFilter>& filters, const std::string& defaultExt,
               const std::string& defaultName, std::vector<std::string>& outPaths) {
    const HRESULT coHr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    const bool coInit = SUCCEEDED(coHr);
    bool ok = false;

    {
        IFileDialog* dlg = nullptr;
        HRESULT hr = CoCreateInstance(save ? CLSID_FileSaveDialog : CLSID_FileOpenDialog,
                                      nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg));
        if (FAILED(hr) || !dlg) {
            Log::error("Dialogs: CoCreateInstance failed (0x%08lX)", static_cast<unsigned long>(hr));
        } else {
            // Filters (wide-string storage must outlive Show()).
            std::vector<std::wstring> wideStore;
            std::vector<COMDLG_FILTERSPEC> specs;
            wideStore.reserve(filters.size() * 2);
            for (const FileDialogFilter& f : filters) {
                wideStore.push_back(utf8ToWide(f.name));
                wideStore.push_back(utf8ToWide(f.pattern));
                COMDLG_FILTERSPEC s;
                s.pszName = wideStore[wideStore.size() - 2].c_str();
                s.pszSpec = wideStore[wideStore.size() - 1].c_str();
                specs.push_back(s);
            }
            if (!specs.empty())
                dlg->SetFileTypes(static_cast<UINT>(specs.size()), specs.data());
            if (!title.empty())
                dlg->SetTitle(utf8ToWide(title).c_str());
            if (!defaultExt.empty())
                dlg->SetDefaultExtension(utf8ToWide(defaultExt).c_str());
            if (!defaultName.empty())
                dlg->SetFileName(utf8ToWide(defaultName).c_str());

            DWORD opts = 0;
            if (SUCCEEDED(dlg->GetOptions(&opts))) {
                opts |= FOS_FORCEFILESYSTEM;
                if (multi)
                    opts |= FOS_ALLOWMULTISELECT;
                dlg->SetOptions(opts);
            }

            // The engine is a background console process, so an UNOWNED shell dialog opens
            // behind the browser and unfocused. Own it with a transient window we force to
            // the foreground first, so the dialog comes up in front, focused, and modal to it.
            ForegroundOwnerWindow owner;
            hr = dlg->Show(owner.get());
            if (SUCCEEDED(hr)) {
                if (multi) {
                    IFileOpenDialog* open = nullptr;
                    if (SUCCEEDED(dlg->QueryInterface(IID_PPV_ARGS(&open))) && open) {
                        IShellItemArray* items = nullptr;
                        if (SUCCEEDED(open->GetResults(&items)) && items) {
                            DWORD count = 0;
                            items->GetCount(&count);
                            for (DWORD i = 0; i < count; ++i) {
                                IShellItem* item = nullptr;
                                if (SUCCEEDED(items->GetItemAt(i, &item)) && item) {
                                    PWSTR psz = nullptr;
                                    if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &psz)) && psz) {
                                        outPaths.push_back(wideToUtf8(psz));
                                        CoTaskMemFree(psz);
                                    }
                                    item->Release();
                                }
                            }
                            items->Release();
                            ok = !outPaths.empty();
                        }
                        open->Release();
                    }
                } else {
                    IShellItem* item = nullptr;
                    if (SUCCEEDED(dlg->GetResult(&item)) && item) {
                        PWSTR psz = nullptr;
                        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &psz)) && psz) {
                            outPaths.push_back(wideToUtf8(psz));
                            CoTaskMemFree(psz);
                            ok = true;
                        }
                        item->Release();
                    }
                }
            } else if (hr != HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
                Log::warn("Dialogs: IFileDialog::Show failed (0x%08lX)", static_cast<unsigned long>(hr));
            }
            dlg->Release();
        }
    }

    if (coInit)
        CoUninitialize();
    return ok;
}

// Spawns the STA thread and blocks until the dialog is dismissed.
bool runOnStaThread(bool save, bool multi, const std::string& title,
                    const std::vector<FileDialogFilter>& filters,
                    const std::string& defaultExt, const std::string& defaultName,
                    std::vector<std::string>& outPaths) {
    bool result = false;
    std::thread t([&] {
        result = runDialog(save, multi, title, filters, defaultExt, defaultName, outPaths);
    });
    t.join();
    return result;
}

} // namespace

bool Dialogs::openFile(const std::string& title, const std::vector<FileDialogFilter>& filters,
                       std::string& outPath) {
    std::vector<std::string> paths;
    if (!runOnStaThread(false, false, title, filters, "", "", paths) || paths.empty())
        return false;
    outPath = paths.front();
    return true;
}

bool Dialogs::openFiles(const std::string& title, const std::vector<FileDialogFilter>& filters,
                        std::vector<std::string>& outPaths) {
    outPaths.clear();
    return runOnStaThread(false, true, title, filters, "", "", outPaths) && !outPaths.empty();
}

bool Dialogs::saveFile(const std::string& title, const std::vector<FileDialogFilter>& filters,
                       const std::string& defaultExt, const std::string& defaultName,
                       std::string& outPath) {
    std::vector<std::string> paths;
    if (!runOnStaThread(true, false, title, filters, defaultExt, defaultName, paths) ||
        paths.empty())
        return false;
    outPath = paths.front();
    return true;
}

} // namespace mydaw
