// MyDAW — media/AudioEncoder.h (E4)
// Encoded audio export via Media Foundation (MP3 / FLAC / AAC-in-m4a). Mirrors WavWriter's
// streaming shape (open → appendPlanar → finalize) so the export worker can pick a sink by
// format. Input is planar float32; the encoder converts to 16-bit PCM and feeds an
// IMFSinkWriter whose container is inferred from the file extension.
//
// Non-RT (runs on the export worker thread). Honest failure: if the requested codec's encoder
// MFT is unavailable, open() returns false + a readable error (no silent format switch).
#pragma once

#include <cstdint>
#include <memory>
#include <string>

namespace mydaw {

// Formats accepted by MfAudioEncoder::formatSupported / open (lowercase).
//   "mp3"  -> .mp3   (MP3 encoder, lossy; bitrate via kbps)
//   "flac" -> .flac  (FLAC encoder, lossless 16-bit)
//   "aac" | "m4a" -> .m4a (AAC in MPEG-4, lossy; bitrate via kbps)
class MfAudioEncoder {
public:
    MfAudioEncoder();
    ~MfAudioEncoder();
    MfAudioEncoder(const MfAudioEncoder&) = delete;
    MfAudioEncoder& operator=(const MfAudioEncoder&) = delete;

    // True if `fmt` names a codec this encoder handles (not whether the MFT is installed).
    static bool isEncodedFormat(const std::string& fmt);

    // Open `path` for `fmt`. `kbps` is the target bitrate for lossy codecs (ignored by FLAC).
    // Returns false + *err on failure (unavailable encoder, bad params, IO).
    bool open(const std::string& path, int numCh, int sampleRate, const std::string& fmt,
              int kbps, std::string* err);
    // ch = numCh planar channel pointers, `frames` samples each.
    bool appendPlanar(const float* const* ch, int frames);
    // Flush + close. Returns false if any write failed. Safe when not open.
    bool finalize();

    bool isOpen() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace mydaw
