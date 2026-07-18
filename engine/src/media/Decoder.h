// MyDAW — media/Decoder.h (E4)
// Audio file decoding (SPEC §1/§5.5): Windows Media Foundation Source Reader decodes any
// MF-supported container/codec (wav/mp3/flac/m4a/wma, ...) to float32 planar PcmData at
// the file's native sample rate. A direct RIFF/WAVE parser (plain PCM 16/24/32-int and
// 32-float) is used as a fallback so .wav import keeps working even when MF chokes or the
// Media Feature Pack is absent. Channel counts > 2 are kept as-is.
//
// resampleLinear(): plain linear interpolation. NOTE(spec): SPEC §4 pins the v1 policy —
// assets are resampled ONCE at import time (never at playback), and simple linear
// interpolation is the chosen v1 quality tradeoff (no windowed-sinc).
//
// MFStartup/MFShutdown are ref-counted internally (started on first decode). All entry
// points are non-RT (they allocate and block on IO) and thread-safe.

#pragma once

#include <string>

namespace mydaw {

struct PcmData; // defined in media/AssetStore.h

class Decoder {
public:
    // Decode `absPath` into float32 planar PCM at the file's NATIVE sample rate.
    // Tries Media Foundation first, then the RIFF/WAVE fallback for wav content.
    // Returns false and fills `err` (stage + HRESULT where applicable) on failure.
    static bool decodeFile(const std::string& absPath, PcmData& out, std::string& err);

    // Direct RIFF/WAVE parser for plain PCM wav: 16/24/32-bit integer and 32-bit float,
    // including WAVE_FORMAT_EXTENSIBLE wrappers. Exposed for direct use/testing.
    static bool decodeWavRiff(const std::string& absPath, PcmData& out, std::string& err);

    // In-place linear resample to targetSampleRate (no-op when rates match or input is
    // empty). SPEC §4: import-time only, linear interpolation (documented v1 tradeoff).
    static void resampleLinear(PcmData& pcm, int targetSampleRate);
};

} // namespace mydaw
