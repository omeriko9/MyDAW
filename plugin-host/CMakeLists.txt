# mydaw-host — console app hosting ONE VST2/VST3 plugin out-of-process (SPEC §3, §8).
# Built twice: x64 in build/ (OUTPUT_NAME mydaw-host64) and x86 in build32/ via the
# host32-release preset (OUTPUT_NAME mydaw-host32).

file(GLOB_RECURSE MYDAW_HOST_SOURCES CONFIGURE_DEPENDS
  ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/*.h)

# ---------------------------------------------------------------------------- MinHook
# Vendored MinHook (third_party/minhook, MIT) — the inline-hook engine behind the optional
# per-plugin registry overlay (RegOverlay.{h,cpp}, SPEC §8.5). Built as an in-tree static
# lib so it inherits the global /MT (CMAKE_MSVC_RUNTIME_LIBRARY) and compiles for BOTH the
# x64 host (build/) and the Win32 host (build32/) from this one shared CMakeLists. hde32.c
# and hde64.c both compile; MinHook selects the matching disassembler per _M_IX86/_M_X64.
add_library(mydaw_minhook STATIC
  ${CMAKE_SOURCE_DIR}/third_party/minhook/src/buffer.c
  ${CMAKE_SOURCE_DIR}/third_party/minhook/src/hook.c
  ${CMAKE_SOURCE_DIR}/third_party/minhook/src/trampoline.c
  ${CMAKE_SOURCE_DIR}/third_party/minhook/src/hde/hde32.c
  ${CMAKE_SOURCE_DIR}/third_party/minhook/src/hde/hde64.c)
target_include_directories(mydaw_minhook PUBLIC ${CMAKE_SOURCE_DIR}/third_party/minhook/include)

add_executable(mydaw-host
  ${MYDAW_HOST_SOURCES}
  ${MYDAW_SHARED_IPC_SOURCES})

if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  set_target_properties(mydaw-host PROPERTIES OUTPUT_NAME mydaw-host64)
else()
  set_target_properties(mydaw-host PROPERTIES OUTPUT_NAME mydaw-host32)
endif()

target_link_libraries(mydaw-host PRIVATE
  mydaw_common
  mydaw_minhook  # registry-overlay inline hooks (RegOverlay.cpp, SPEC §8.5)
  advapi32       # real Reg* trampolines for the overlay read-through path
  user32   # editor window + message pump
  gdi32
  ole32
  oleaut32 # POS DCOM replay: SafeArray* for IPOS::receiveTransferObject
  ws2_32   # POS tunnel to the live dongle (diagnostic; MYDAW_POS_TUNNEL)
  shell32)

# ============================================================================ VST3 SDK
# FetchContent of steinbergmedia/vst3sdk v3.7.12_build_20 (GPLv3 — see SPEC §1 caveat).
# We only need the hosting libs; the goal is to link target `sdk_hosting` into mydaw-host.
# Fallback ladder (SPEC §3):
#   * -DMYDAW_NO_VST3=ON      -> skip the fetch entirely, compile define MYDAW_NO_VST3 (VST2-only).
#   * Win32 + SDK fails to    -> auto-set MYDAW_HOST32_VST2_ONLY, compile defines MYDAW_NO_VST3 +
#     configure                  MYDAW_HOST32_VST2_ONLY, keep going (host32 is VST2-only).
#   * fetch/download fails    -> configure aborts; re-run with -DMYDAW_NO_VST3=ON (clear message).

set(MYDAW_VST3_ENABLED FALSE)

if(MYDAW_NO_VST3)
  message(STATUS "MyDAW: MYDAW_NO_VST3=ON — VST3 hosting compiled out, host is VST2-only.")
elseif(MYDAW_HOST32_VST2_ONLY AND NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(STATUS "MyDAW: MYDAW_HOST32_VST2_ONLY=ON — Win32 host built VST2-only (no vst3sdk).")
else()
  include(FetchContent)

  # vst3sdk v3.7.12_build_20 option names (verified against that tag's top-level CMakeLists.txt):
  set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES  OFF CACHE BOOL "" FORCE)
  set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(SMTG_ENABLE_VSTGUI_SUPPORT        OFF CACHE BOOL "" FORCE)
  set(SMTG_CREATE_PLUGIN_LINK           OFF CACHE BOOL "" FORCE)
  set(SMTG_RUN_VST_VALIDATOR            OFF CACHE BOOL "" FORCE)
  set(SMTG_CREATE_MODULE_INFO           OFF CACHE BOOL "" FORCE)
  set(SMTG_USE_STATIC_CRT               ON  CACHE BOOL "" FORCE)  # match /MT above
  # Older option spellings used by earlier SDK tags — harmless if this tag ignores them:
  set(SMTG_ADD_VST3_HOSTING_SAMPLES     OFF CACHE BOOL "" FORCE)
  set(SMTG_ADD_VST3_PLUGINS_SAMPLES     OFF CACHE BOOL "" FORCE)
  set(SMTG_ADD_VSTGUI                   OFF CACHE BOOL "" FORCE)

  # SOURCE_SUBDIR points at a directory that does not exist on purpose: FetchContent then
  # populates the sources but does NOT call add_subdirectory(); we do that ourselves below
  # so the Win32 tree can probe the SDK configure first and fall back instead of aborting.
  FetchContent_Declare(vst3sdk
    GIT_REPOSITORY https://github.com/steinbergmedia/vst3sdk
    GIT_TAG        v3.7.12_build_20
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE
    GIT_SUBMODULES base cmake pluginterfaces public.sdk
    SOURCE_SUBDIR  mydaw-populate-only-no-add-subdirectory)
  message(STATUS "MyDAW: fetching vst3sdk v3.7.12_build_20 (first run clones ~4 submodules; "
                 "on failure re-run with -DMYDAW_NO_VST3=ON)")
  FetchContent_MakeAvailable(vst3sdk)

  set(_mydaw_vst3_ok TRUE)

  if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    # Win32: probe the SDK configure in an isolated scratch dir. If it breaks, auto-set
    # MYDAW_HOST32_VST2_ONLY and keep going (SPEC §3). Probe result is cached.
    if(NOT DEFINED CACHE{MYDAW_VST3_WIN32_PROBE})
      message(STATUS "MyDAW: probing vst3sdk configure for Win32 (one-time, may take a minute)...")
      execute_process(
        COMMAND ${CMAKE_COMMAND}
          -S "${vst3sdk_SOURCE_DIR}"
          -B "${CMAKE_BINARY_DIR}/_vst3sdk-win32-probe"
          -G "${CMAKE_GENERATOR}" -A Win32
          "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>"
          -DSMTG_ENABLE_VST3_PLUGIN_EXAMPLES=OFF
          -DSMTG_ENABLE_VST3_HOSTING_EXAMPLES=OFF
          -DSMTG_ENABLE_VSTGUI_SUPPORT=OFF
          -DSMTG_CREATE_PLUGIN_LINK=OFF
          -DSMTG_RUN_VST_VALIDATOR=OFF
          -DSMTG_CREATE_MODULE_INFO=OFF
          -DSMTG_USE_STATIC_CRT=ON
        RESULT_VARIABLE _mydaw_probe_rc
        OUTPUT_VARIABLE _mydaw_probe_out
        ERROR_VARIABLE  _mydaw_probe_err)
      if(_mydaw_probe_rc EQUAL 0)
        set(MYDAW_VST3_WIN32_PROBE "ok" CACHE INTERNAL "vst3sdk Win32 configure probe result")
      else()
        set(MYDAW_VST3_WIN32_PROBE "failed" CACHE INTERNAL "vst3sdk Win32 configure probe result")
        message(WARNING "MyDAW: vst3sdk Win32 probe configure failed (rc=${_mydaw_probe_rc}):\n"
                        "${_mydaw_probe_err}")
      endif()
    endif()
    if(NOT "$CACHE{MYDAW_VST3_WIN32_PROBE}" STREQUAL "ok")
      message(WARNING "MyDAW: vst3sdk does not configure on Win32 — auto-setting "
                      "MYDAW_HOST32_VST2_ONLY=ON; mydaw-host32 will be VST2-only (SPEC §3).")
      set(MYDAW_HOST32_VST2_ONLY ON CACHE BOOL
          "Win32 host without VST3 (auto-set when the vst3sdk fails to configure on Win32)" FORCE)
      set(_mydaw_vst3_ok FALSE)
    endif()
  endif()

  if(_mydaw_vst3_ok)
    # EXCLUDE_FROM_ALL: only the SDK libs mydaw-host actually links get built.
    add_subdirectory("${vst3sdk_SOURCE_DIR}" "${vst3sdk_BINARY_DIR}" EXCLUDE_FROM_ALL)
    if(TARGET sdk_hosting)
      set(MYDAW_VST3_ENABLED TRUE)
    else()
      message(WARNING "MyDAW: vst3sdk configured but target 'sdk_hosting' is missing — "
                      "building host VST2-only (MYDAW_NO_VST3 define set).")
    endif()
  endif()
endif()

if(MYDAW_VST3_ENABLED)
  target_link_libraries(mydaw-host PRIVATE sdk_hosting)
  # The SDK does not export interface include dirs on all targets; headers are included as
  # <pluginterfaces/...>, <public.sdk/...>, <base/...> relative to the SDK root.
  target_include_directories(mydaw-host PRIVATE "${vst3sdk_SOURCE_DIR}")
  # vst3sdk headers key off DEVELOPMENT/RELEASE (its own targets get these from its cmake
  # modules; consumers must define them too).
  target_compile_definitions(mydaw-host PRIVATE
    $<$<CONFIG:Debug>:DEVELOPMENT=1>
    $<$<NOT:$<CONFIG:Debug>>:RELEASE=1>)
  message(STATUS "MyDAW: VST3 hosting ENABLED (sdk_hosting linked into mydaw-host)")
else()
  target_compile_definitions(mydaw-host PRIVATE MYDAW_NO_VST3)
  if(MYDAW_HOST32_VST2_ONLY AND NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    target_compile_definitions(mydaw-host PRIVATE MYDAW_HOST32_VST2_ONLY)
  endif()
  message(STATUS "MyDAW: VST3 hosting DISABLED (compile define MYDAW_NO_VST3; host is VST2-only)")
endif()
