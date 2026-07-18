// MyDAW — util/Dialogs.h (E9)
// Native Windows file dialogs (IFileDialog) for the dialog/* protocol messages and the
// no-path export/save flows (SPEC §5.1/§5.5). Each call spins up a dedicated STA thread
// (CoInitializeEx COINIT_APARTMENTTHREADED), shows the dialog, and joins — so callers may
// live on any non-RT thread regardless of its COM apartment state. BLOCKING.
//
// All paths UTF-8. Returns false on user-cancel or any COM failure (logged).

#pragma once

#include <string>
#include <vector>

namespace mydaw {

struct FileDialogFilter {
    std::string name;    // e.g. "WAV audio"
    std::string pattern; // e.g. "*.wav" or "*.wav;*.mp3"
};

class Dialogs {
public:
    // Single-file open dialog. False on cancel/failure.
    static bool openFile(const std::string& title,
                         const std::vector<FileDialogFilter>& filters, std::string& outPath);

    // Multi-select open dialog (dialog/importFiles). False on cancel/failure.
    static bool openFiles(const std::string& title,
                          const std::vector<FileDialogFilter>& filters,
                          std::vector<std::string>& outPaths);

    // Save dialog. defaultExt without dot ("wav", "mydaw"); defaultName pre-fills the
    // file-name box ("" = none). False on cancel/failure.
    static bool saveFile(const std::string& title,
                         const std::vector<FileDialogFilter>& filters,
                         const std::string& defaultExt, const std::string& defaultName,
                         std::string& outPath);
};

} // namespace mydaw
