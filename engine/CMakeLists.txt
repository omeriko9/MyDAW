# mydaw-engine — x64 console app: audio engine, project model, HTTP+WS server (SPEC §3).

file(GLOB_RECURSE MYDAW_ENGINE_SOURCES CONFIGURE_DEPENDS
  ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/*.h)

add_executable(mydaw-engine
  ${MYDAW_ENGINE_SOURCES}
  ${MYDAW_SHARED_IPC_SOURCES})

# The checked-in agent catalog is generated from one canonical JSON document. Make every
# engine build prove that the generated C++/TypeScript views and RequestMap coverage are
# current; host-only/Win32 builds never enter this CMake file and therefore need no Node.
find_program(MYDAW_NODE_EXECUTABLE NAMES node REQUIRED)
add_custom_target(mydaw-agent-catalog-check
  COMMAND "${MYDAW_NODE_EXECUTABLE}"
          "${CMAKE_SOURCE_DIR}/scripts/generate-agent-catalog.mjs" --check
  WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
  COMMENT "Checking canonical MyDAW agent capability catalog"
  VERBATIM)
add_dependencies(mydaw-engine mydaw-agent-catalog-check)

target_link_libraries(mydaw-engine PRIVATE
  mydaw_common
  ws2_32        # Winsock HTTP/WS server
  mfplat        # Media Foundation decode
  mfreadwrite
  mfuuid
  winmm         # MIDI in + timeBeginPeriod
  ole32         # COM (WASAPI, IFileDialog)
  avrt          # MMCSS ("Pro Audio") for the RT thread
  shell32
  shlwapi
  user32)

# ----------------------------------------------------------------------------
# ASIO (SPEC §3/§7/§10): full driver code lives in engine/src/audio/AsioDriver.* and is
# compiled only when MYDAW_HAVE_ASIO is defined. We never ship the Steinberg ASIO SDK;
# the user points MYDAW_ASIO_SDK_DIR at their local copy. Only include dirs + the define
# are wired here — no SDK sources are compiled (the driver talks the ASIO C ABI directly).
if(MYDAW_ASIO_SDK_DIR)
  if(EXISTS "${MYDAW_ASIO_SDK_DIR}")
    message(STATUS "MyDAW: ASIO SDK at '${MYDAW_ASIO_SDK_DIR}' -> defining MYDAW_HAVE_ASIO")
    target_compile_definitions(mydaw-engine PRIVATE MYDAW_HAVE_ASIO)
    target_include_directories(mydaw-engine PRIVATE "${MYDAW_ASIO_SDK_DIR}")
    foreach(_asio_sub common host host/pc)
      if(EXISTS "${MYDAW_ASIO_SDK_DIR}/${_asio_sub}")
        target_include_directories(mydaw-engine PRIVATE "${MYDAW_ASIO_SDK_DIR}/${_asio_sub}")
      endif()
    endforeach()
  else()
    message(WARNING
      "MyDAW: MYDAW_ASIO_SDK_DIR='${MYDAW_ASIO_SDK_DIR}' does not exist — building WITHOUT ASIO "
      "(driver list will report ASIO unavailable with a reason).")
  endif()
else()
  message(STATUS "MyDAW: building without ASIO (set -DMYDAW_ASIO_SDK_DIR=<path> to enable)")
endif()
