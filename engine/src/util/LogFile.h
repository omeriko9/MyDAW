// MyDAW — util/LogFile.h
// Persistent on-disk log: installs a Log::FileSink that appends every formatted line to a
// daily, size-rotated file under %APPDATA%/MyDAW/logs/ (mydaw-YYYYMMDD.log). Distinct from
// Log's single event/log Sink, so the console, the in-memory ring, the event/log broadcast
// and the file all receive every line independently.
//
// Non-RT only (Log itself is non-RT). The sink runs under Log's mutex; writes are buffered
// FILE* appends + periodic flush. Call initFileLog() ONCE at startup.

#pragma once

#include <string>

namespace mydaw {

// Opens (creating dirs as needed) today's log file and installs the Log file sink. Returns
// the absolute path of the active log file, or "" if it could not be opened (logging then
// continues to console/ring only). Safe to call once; subsequent calls are no-ops.
std::string initFileLog();

} // namespace mydaw
