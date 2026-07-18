// MyDAW — midi/MidiEvent.h
// MIDI event value type + fixed-capacity RT-safe MidiBuffer.
// 3-byte channel-voice messages only (SysEx is dropped at the input boundary in v1).
// sampleOffset is relative to the start of the current audio block.

#pragma once

#include <cstdint>

namespace mydaw {

struct MidiEvent {
    int sampleOffset = 0;
    uint8_t data[3] = {0, 0, 0};
    uint8_t size = 0; // valid bytes in data (1..3)

    // --- accessors -------------------------------------------------------
    uint8_t status() const { return static_cast<uint8_t>(data[0] & 0xF0u); }
    uint8_t channel() const { return static_cast<uint8_t>(data[0] & 0x0Fu); } // 0..15

    bool isNoteOn() const { return status() == 0x90 && data[2] > 0; }
    bool isNoteOff() const { return status() == 0x80 || (status() == 0x90 && data[2] == 0); }
    bool isPolyAftertouch() const { return status() == 0xA0; }
    bool isController() const { return status() == 0xB0; }
    bool isProgramChange() const { return status() == 0xC0; }
    bool isChannelAftertouch() const { return status() == 0xD0; }
    bool isPitchBend() const { return status() == 0xE0; }
    bool isAllNotesOff() const { return status() == 0xB0 && data[1] == 123; }
    bool isAllSoundOff() const { return status() == 0xB0 && data[1] == 120; }

    uint8_t note() const { return data[1]; }       // note on/off/poly-AT
    uint8_t velocity() const { return data[2]; }   // note on/off
    uint8_t controller() const { return data[1]; } // CC number
    uint8_t ccValue() const { return data[2]; }    // CC value
    uint8_t program() const { return data[1]; }    // program change
    // Pitch bend, centered: -8192..8191.
    int pitchBendValue() const {
        return ((static_cast<int>(data[2]) << 7) | static_cast<int>(data[1])) - 8192;
    }

    // --- factories (ch: 0..15, note: 0..127, vel: 1..127) ----------------
    static MidiEvent make3(uint8_t b0, uint8_t b1, uint8_t b2, int sampleOffset = 0) {
        MidiEvent e;
        e.sampleOffset = sampleOffset;
        e.data[0] = b0; e.data[1] = b1; e.data[2] = b2;
        e.size = 3;
        return e;
    }
    static MidiEvent noteOn(int ch, int note, int vel, int sampleOffset = 0) {
        return make3(static_cast<uint8_t>(0x90 | (ch & 0x0F)),
                     static_cast<uint8_t>(note & 0x7F),
                     static_cast<uint8_t>(vel & 0x7F), sampleOffset);
    }
    static MidiEvent noteOff(int ch, int note, int sampleOffset = 0) {
        return make3(static_cast<uint8_t>(0x80 | (ch & 0x0F)),
                     static_cast<uint8_t>(note & 0x7F), 0, sampleOffset);
    }
    static MidiEvent controlChange(int ch, int cc, int value, int sampleOffset = 0) {
        return make3(static_cast<uint8_t>(0xB0 | (ch & 0x0F)),
                     static_cast<uint8_t>(cc & 0x7F),
                     static_cast<uint8_t>(value & 0x7F), sampleOffset);
    }
    static MidiEvent pitchBend(int ch, int centered /*-8192..8191*/, int sampleOffset = 0) {
        const int raw = centered + 8192;
        return make3(static_cast<uint8_t>(0xE0 | (ch & 0x0F)),
                     static_cast<uint8_t>(raw & 0x7F),
                     static_cast<uint8_t>((raw >> 7) & 0x7F), sampleOffset);
    }
    static MidiEvent allNotesOff(int ch, int sampleOffset = 0) {
        return controlChange(ch, 123, 0, sampleOffset);
    }
    static MidiEvent allSoundOff(int ch, int sampleOffset = 0) {
        return controlChange(ch, 120, 0, sampleOffset);
    }
};

static_assert(sizeof(MidiEvent) == 8, "MidiEvent expected to pack to 8 bytes");

// Fixed-capacity event list. RT-safe: no allocation, value semantics, capacity matches
// the shm MidiMsg array size (SPEC §8.1). add() drops (returns false) when full.
// Single-threaded use (fill then consume within one block) — not internally synchronized.
class MidiBuffer {
public:
    static constexpr int kCapacity = 1024;

    bool add(const MidiEvent& e) {
        if (size_ >= kCapacity)
            return false;
        events_[size_++] = e;
        return true;
    }

    void clear() { size_ = 0; }
    int size() const { return size_; }
    bool empty() const { return size_ == 0; }
    static constexpr int capacity() { return kCapacity; }

    MidiEvent& operator[](int i) { return events_[i]; }
    const MidiEvent& operator[](int i) const { return events_[i]; }

    MidiEvent* begin() { return events_; }
    MidiEvent* end() { return events_ + size_; }
    const MidiEvent* begin() const { return events_; }
    const MidiEvent* end() const { return events_ + size_; }

    // Stable insertion sort by sampleOffset (RT-safe: no allocation; stability preserves
    // note-off-before-note-on ordering produced at the same offset).
    void sortByOffset() {
        for (int i = 1; i < size_; ++i) {
            const MidiEvent key = events_[i];
            int j = i - 1;
            while (j >= 0 && events_[j].sampleOffset > key.sampleOffset) {
                events_[j + 1] = events_[j];
                --j;
            }
            events_[j + 1] = key;
        }
    }

private:
    MidiEvent events_[kCapacity];
    int size_ = 0;
};

} // namespace mydaw
