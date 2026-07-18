// MyDAW — project/UndoStack.h (E3)
// Undo model per SPEC §5: full-project JSON snapshot pairs {label, before, after},
// capped at 200 entries. undo()/redo() restore the bound Model via fromJson and return
// the entry label; the CommandProcessor then reconciles plugin instances (using the
// pluginChunks captured in the entry) and emits a full event/projectChanged.
//
// Main-thread only (commands are processed on the main thread, SPEC §7).

#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "util/Json.h"

namespace mydaw {

class Model;

struct UndoEntry {
    std::string label;
    json before; // full project JSON prior to the command (toJson(Project))
    json after;  // full project JSON after the command
    // Plugin state chunks captured at command time for instances this command created or
    // destroyed (plugin.add / plugin.remove / track.remove), keyed by instanceId. Used by
    // CommandProcessor::reconcile when undo/redo re-creates those instances.
    std::map<uint64_t, std::vector<uint8_t>> pluginChunks;
};

class UndoStack {
public:
    static constexpr size_t kMaxEntries = 200;

    // `model` must outlive the stack (both are process-lifetime singletons, E9).
    explicit UndoStack(Model& model);

    // Records a completed command. Drops any redo tail; evicts the oldest entry past cap.
    void push(UndoEntry entry);

    bool canUndo() const { return cursor_ > 0; }
    bool canRedo() const { return cursor_ < entries_.size(); }
    std::string undoLabel() const; // label of the next undo ("" if none)
    std::string redoLabel() const; // label of the next redo ("" if none)
    size_t depth() const { return entries_.size(); }

    // Restores the model to the entry's `before` (undo) / `after` (redo) snapshot via
    // fromJson. Returns false when there is nothing to undo/redo or the snapshot fails
    // to parse (never happens for snapshots produced by toJson; logged defensively).
    bool undo(std::string& outLabel);
    bool redo(std::string& outLabel);

    // Entry applied by the most recent successful undo()/redo(); nullptr after
    // push()/clear() or before any undo/redo. Valid until the next push()/clear().
    const UndoEntry* lastApplied() const { return lastApplied_; }

    void clear(); // project load/new (E9)

private:
    bool applySnapshot(const json& snapshot);

    Model& model_;
    std::vector<UndoEntry> entries_;
    size_t cursor_ = 0; // entries_[cursor_-1] is the next undo; entries_[cursor_] next redo
    const UndoEntry* lastApplied_ = nullptr;
};

} // namespace mydaw
