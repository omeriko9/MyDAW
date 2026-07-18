// MyDAW — project/UndoStack.cpp (E3)

#include "project/UndoStack.h"

#include <utility>

#include "project/Model.h"
#include "util/Log.h"

namespace mydaw {

UndoStack::UndoStack(Model& model) : model_(model) {}

void UndoStack::push(UndoEntry entry) {
    entries_.resize(cursor_); // drop redo tail
    entries_.push_back(std::move(entry));
    if (entries_.size() > kMaxEntries)
        entries_.erase(entries_.begin()); // evict oldest
    cursor_ = entries_.size();
    lastApplied_ = nullptr; // vector may have reallocated
}

std::string UndoStack::undoLabel() const {
    return canUndo() ? entries_[cursor_ - 1].label : std::string();
}

std::string UndoStack::redoLabel() const {
    return canRedo() ? entries_[cursor_].label : std::string();
}

bool UndoStack::applySnapshot(const json& snapshot) {
    Project p;
    std::string err;
    if (!fromJson(snapshot, p, &err)) {
        Log::error("UndoStack: snapshot restore failed: %s", err.c_str());
        return false;
    }
    model_.project = std::move(p);
    return true;
}

bool UndoStack::undo(std::string& outLabel) {
    if (!canUndo())
        return false;
    UndoEntry& e = entries_[cursor_ - 1];
    if (!applySnapshot(e.before))
        return false;
    --cursor_;
    lastApplied_ = &entries_[cursor_];
    outLabel = e.label;
    return true;
}

bool UndoStack::redo(std::string& outLabel) {
    if (!canRedo())
        return false;
    UndoEntry& e = entries_[cursor_];
    if (!applySnapshot(e.after))
        return false;
    ++cursor_;
    lastApplied_ = &entries_[cursor_ - 1];
    outLabel = e.label;
    return true;
}

void UndoStack::clear() {
    entries_.clear();
    cursor_ = 0;
    lastApplied_ = nullptr;
}

} // namespace mydaw
