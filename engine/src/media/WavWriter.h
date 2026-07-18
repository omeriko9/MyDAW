// MyDAW — media/WavWriter.h (E4)
// RIFF/WAVE writing.
//
// - One-shot: WavWriter::write(path, planar channels, frames, sr, bitDepth) — bitDepth
//   16 | 24 (integer PCM, TPDF-dithered) or 32 (IEEE float32, written verbatim).
// - Streaming: open() / appendInterleaved() / appendPlanar() / finalize(). finalize()
//   patches the RIFF/data (+fact for float) sizes; the destructor finalizes if needed.
//   Recording (E4 AudioRecorder) streams bitDepth 32 (float).
//
// All methods are non-RT (buffered stdio). One writer = one thread at a time.
// Data chunk is capped just under 4 GiB (classic RIFF limit) — appends past the cap fail
// with a logged warning; finalize() still produces a valid file with what was written.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mydaw {

class WavWriter {
public:
    WavWriter() = default;
    ~WavWriter(); // finalize()s a still-open file
    WavWriter(const WavWriter&) = delete;
    WavWriter& operator=(const WavWriter&) = delete;

    // One-shot write of planar float32 channels (ch[c][0..frames)).
    // bitDepth: 16 | 24 (PCM, TPDF dither) | 32 (float32). Returns false + *err on failure.
    static bool write(const std::string& path, const float* const* ch, int numCh,
                      int64_t frames, int sampleRate, int bitDepth,
                      std::string* err = nullptr);

    // Streaming API ---------------------------------------------------------
    bool open(const std::string& path, int numCh, int sampleRate, int bitDepth,
              std::string* err = nullptr);
    // samples = frames*numCh interleaved float32 samples.
    bool appendInterleaved(const float* samples, int frames);
    // ch = numCh planar channel pointers, frames each.
    bool appendPlanar(const float* const* ch, int frames);
    // Patch RIFF sizes and close. Returns false if any write failed along the way
    // (the file is still closed). Safe to call when not open (returns false).
    bool finalize();

    bool isOpen() const { return file_ != nullptr; }
    int64_t framesWritten() const { return framesWritten_; }
    const std::string& path() const { return path_; }

private:
    bool writeHeader();
    bool appendImpl(const float* const* planar, const float* interleaved, int frames);
    double tpdf(); // triangular dither in [-1, 1] LSB

    void* file_ = nullptr; // FILE*
    std::string path_;
    int numCh_ = 0;
    int sampleRate_ = 0;
    int bitDepth_ = 32;
    int bytesPerSample_ = 4;
    bool isFloat_ = true;
    bool failed_ = false;
    bool capWarned_ = false;
    int64_t framesWritten_ = 0;
    int64_t dataStart_ = 0; // file offset of the first data byte
    int64_t factPos_ = -1;  // offset of fact.dwSampleLength (float only), -1 = none
    uint32_t rng_ = 0x6d796461u; // TPDF dither state ('myda')
    std::vector<uint8_t> scratch_;
};

} // namespace mydaw
