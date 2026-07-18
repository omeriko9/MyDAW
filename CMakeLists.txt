# MyDAW superbuild — engine (x64) + plugin host (host64 in this tree; host32 via preset
# host32-release into build32/). See docs/SPEC.md §3 for the binding build contract.
#
#   Engine x64 : cmake -S . -B build   -A x64                       && cmake --build build   --config Release
#   Host32     : cmake -S . -B build32 -A Win32 -DMYDAW_HOST_ONLY=ON && cmake --build build32 --config Release
#
# Artifacts land in <build>/bin/<Config>/ (e.g. build/bin/Release/mydaw-engine.exe).

# 3.25 floor matches CMakePresets.json (presets schema v6 itself needs CMake 3.25).
cmake_minimum_required(VERSION 3.25)

# C is enabled for the vendored MinHook sources (third_party/minhook, MIT) used by the
# plugin host's optional per-plugin registry overlay (SPEC §8.5).
project(MyDAW VERSION 0.1.0 LANGUAGES C CXX)

# ---------------------------------------------------------------------------- options
option(MYDAW_HOST_ONLY  "Build only the plugin host (skip engine; used for the Win32/host32 tree)" OFF)
option(MYDAW_NO_VST3    "Disable VST3 hosting: skip the vst3sdk FetchContent entirely, hosts build VST2-only" OFF)
option(MYDAW_HOST32_VST2_ONLY
       "Win32 host without VST3 (auto-set when the vst3sdk fails to configure for Win32, see SPEC §3)" OFF)
set(MYDAW_ASIO_SDK_DIR "" CACHE PATH
    "Path to the Steinberg ASIO SDK. When set and the directory exists, MYDAW_HAVE_ASIO is defined and the SDK include dirs are added (driver code lives in engine/src/audio).")

if(NOT WIN32)
  message(FATAL_ERROR "MyDAW is Windows-only (WASAPI/winmm/Media Foundation/Win32 IPC).")
endif()
if(NOT MSVC)
  message(FATAL_ERROR "MyDAW requires the MSVC toolchain (Visual Studio generator). Got: ${CMAKE_CXX_COMPILER_ID}")
endif()

if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  set(MYDAW_ARCH_X64 TRUE)
else()
  set(MYDAW_ARCH_X64 FALSE)
  if(NOT MYDAW_HOST_ONLY)
    # NOTE(spec): SPEC §1 mandates mydaw-engine.exe is x64-only; the 32-bit tree exists solely
    # for mydaw-host32. Fail fast instead of silently producing an unsupported x86 engine.
    message(FATAL_ERROR
      "32-bit configuration only builds mydaw-host32. Re-run with -DMYDAW_HOST_ONLY=ON "
      "(or use the 'host32-release' preset).")
  endif()
endif()

# ---------------------------------------------------------------------------- global build env
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Static CRT (/MT, /MTd) so the exes are portable (no VC redist needed). Applies to the
# vst3sdk subbuild too (it additionally honors SMTG_USE_STATIC_CRT, set in plugin-host/).
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Output layout per SPEC §3: <build>/bin/<Config>/ — multi-config generators append /<Config>.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)

# Shared compile environment for both MyDAW executables (the vst3sdk keeps its own flags).
add_library(mydaw_common INTERFACE)
target_compile_features(mydaw_common INTERFACE cxx_std_20)
target_compile_options(mydaw_common INTERFACE /W3 /permissive- /utf-8)
target_compile_definitions(mydaw_common INTERFACE
  NOMINMAX
  WIN32_LEAN_AND_MEAN
  _CRT_SECURE_NO_WARNINGS)
target_include_directories(mydaw_common INTERFACE
  ${CMAKE_SOURCE_DIR}
  ${CMAKE_SOURCE_DIR}/engine/src
  ${CMAKE_SOURCE_DIR}/shared
  ${CMAKE_SOURCE_DIR}/third_party)

# Sources shared by engine and plugin hosts (compiled into BOTH targets, SPEC §3).
file(GLOB MYDAW_SHARED_IPC_SOURCES CONFIGURE_DEPENDS
  ${CMAKE_SOURCE_DIR}/shared/ipc/*.cpp
  ${CMAKE_SOURCE_DIR}/shared/ipc/*.h)

# ---------------------------------------------------------------------------- targets
if(NOT MYDAW_HOST_ONLY)
  add_subdirectory(engine)
endif()
add_subdirectory(plugin-host)
