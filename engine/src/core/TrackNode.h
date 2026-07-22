// MyDAW — core/TrackNode.h (E2)
// The per-track render node (SPEC §7 "Tracks render"). One TrackNode per RenderEntry; the
// graph constructs a fresh, fully-baked node set at every rebuild (main thread) and only
// then publishes the plan — all Config data is immutable on the RT thread.
//
// Render pipeline (processTrackRt, per span):
//   source (clip playback / frozen audio / bus input copy)
//     + live capture monitoring (armed/monitoring audio tracks; bypasses PDC)
//     + MIDI schedule (clip notes + CC/pitch-bend/aftertouch baked to absolute samples,
//       note-off chasing on stop/locate/loop-wrap, CC chase — latest point at-or-before
//       the position per controller — on play start/locate/loop-wrap)
//     + live MIDI merge (armed/monitoring midi+instrument tracks)
//     + injected live MIDI (midi/preview; plays regardless of arm/monitor, also stopped)
//     + feeder MIDI merge (events delivered by MIDI tracks routed here via midiTarget)
//   -> insert chain (PluginProxyNode; skipped entirely when frozen)
//   -> plugin-param automation (once per block) -> PDC alignment delay
//   -> 64-sample-step volume/pan/send automation, 5 ms ramped fader/mute, equal-power pan
//   -> pre/post-fader send taps -> meter tap -> ACCUMULATE into the output bus buffer.
//
// MIDI FEEDER mode (Track::midiTarget routing, SPEC §5.2): when setMidiSink() wired a
// target instrument node at plan-build time, the node still produces ALL of its MIDI
// (clip schedule + chase, live MIDI, midi/preview injection, panic CCs) but delivers the
// events into the TARGET node's preallocated per-block merge buffer and contributes NO
// audio (its own inserts/EQ/fader/sends are bypassed; the graph orders feeders before
// their target in the sequential RT pass). Muting a feeder gates only its events —
// note-offs/all-notes-off still pass (and held notes are released at the mute edge) so
// the target never hangs notes.
//
// Threading: construction/prepare() main thread (pre-publish); processTrackRt()/process()
// RT only; applyXxxRt() are called from the graph's param-ring drain at block start (same
// RT thread); panicRt() may be flagged from any thread (atomic).

#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>
#include <vector>

#include "core/Eq.h" // EqProcessor, EqBandSet
#include "core/GraphNode.h"
#include "core/Mixer.h"
#include "core/Pdc.h"
#include "midi/MidiEvent.h"
#include "project/Model.h" // AutomationPoint

namespace mydaw {

class IInsertNode; // core/IInsertNode.h — insert node (PluginProxyNode or BuiltinEffectNode)
struct MeterSlot;
struct PcmData;

class TrackNode final : public GraphNode {
public:
    // Audio clip with everything resolved at rebuild time (PcmData*, samples, fades).
    struct ResolvedAudioClip {
        const PcmData* pcm = nullptr;
        int64_t startSample = 0;      // timeline position of the clip start
        int64_t srcOffsetSamples = 0; // offset into the asset
        int64_t lengthSamples = 0;
        float gain = 1.0f;
        int64_t fadeInSamples = 0;
        int64_t fadeOutSamples = 0;
    };

    // Baked MIDI event (clip notes flattened to absolute timeline samples). Sorted by
    // sample, note-offs before note-ons at equal sample.
    struct NoteEvent {
        int64_t sample = 0;
        uint8_t on = 0; // 1 = note-on, 0 = note-off
        uint8_t pitch = 0;
        uint8_t velocity = 0;
        uint8_t channel = 0;
    };

    // Baked MIDI CC/pitch-bend/channel-aftertouch event (MidiClip.cc flattened to
    // absolute timeline samples, message bytes pre-formed at rebuild). Sorted by sample.
    // controller follows the pinned MidiCc convention: 0..127 = CC, 128 = pitch bend,
    // 129 = channel aftertouch (used by the chase table, not sent on the wire).
    struct CcEvent {
        int64_t sample = 0;
        uint8_t data[3] = {0, 0, 0};
        uint8_t size = 3; // 2 for channel aftertouch (0xD0)
        uint8_t controller = 0;
    };

    struct SendInit {
        int modelIndex = -1; // index into Track::sends (ParamMsg::index)
        bool pre = false;
        float level = 1.0f;
        std::vector<AutomationPoint> autoPoints; // "send:<modelIndex>" lane, may be empty
    };

    struct PluginAutoLane {
        IInsertNode* node = nullptr;
        uint32_t paramId = 0;
        std::vector<AutomationPoint> points;
    };

    struct Config {
        uint64_t trackId = 0;
        bool busLike = false; // bus/master: consumes an accumulation buffer
        int trackChannels = 2;

        float volume = 1.0f;
        float vcaGain = 1.0f; // VCA-group multiplier (1 = no group), applied after the fader
        float pan = 0.0f;
        bool muted = false; // effective mute (Track::mute OR solo-in-place implicit)

        std::vector<ResolvedAudioClip> audioClips; // frozen tracks: single clip at 0
        std::vector<NoteEvent> noteEvents;
        std::vector<CcEvent> ccEvents; // unmuted clips' cc, sorted by sample
        std::vector<IInsertNode*> inserts; // empty when frozen
        // Parallel to inserts: insertSidechain[k] is the source TrackNode feeding inserts[k]'s
        // sidechain detector (nullptr = none). The source's captured pre-fader buffer is handed
        // to the insert right before its processRt (built-in compressor only reads it).
        std::vector<TrackNode*> insertSidechain;
        bool keepSidechain = false; // this track is a sidechain source: capture its pre-fader signal
        EqBandSet eq;                          // channel EQ (post-inserts, pre-fader); count 0 = no-op
        std::vector<SendInit> sends;           // enabled sends, same order as RenderEntry::sends

        std::vector<AutomationPoint> volumeAuto;
        std::vector<AutomationPoint> panAuto;
        std::vector<PluginAutoLane> pluginAuto;

        MeterSlot* meter = nullptr;  // nullptr offline / pool exhausted
        int pdcDelaySamples = 0;     // alignment delay (computePdc)
        int chainLatency = 0;        // sum of insert latencies (latencySamples())

        bool liveAudioMonitor = false;       // monitor flag: input audible whenever set
        bool liveAudioWhenRecording = false; // armed: input audible while recording
        int inputChannelOffset = 0;          // first capture channel
        bool liveMidi = false;               // merge live MIDI (armed/monitoring midi/instr)
    };

    explicit TrackNode(Config&& cfg);

    uint64_t trackId() const { return cfg_.trackId; }

    // ---- GraphNode -----------------------------------------------------------
    void prepare(int sampleRate, int maxBlock) override;
    void process(ProcessContext& ctx, const float* const* inputs, int numInputs,
                 float* const* outputs, int numOutputs) override;
    int latencySamples() const override { return cfg_.chainLatency; }
    MidiBuffer* midiInput() override { return &midiScratch_; }
    void reset() override;

    // ---- full RT entry point (AudioGraph) -------------------------------------
    // sendL/sendR[k] are the destination-bus channel pointers for cfg_.sends[k]
    // (numSends may be smaller than cfg_.sends.size(); extra sends are skipped).
    // liveIn = capture channel pointers for this span (nullptr when none).
    // liveMidi = this block's live events (already drained; nullptr after the first span).
    void processTrackRt(ProcessContext& ctx, const float* const* inputs, int numInputs,
                        float* const* outputs, int numOutputs, float* const* sendL,
                        float* const* sendR, int numSends, const float* const* liveIn,
                        int numLiveIn, const MidiBuffer* liveMidi) noexcept;

    // ---- param-ring dispatch (RT, graph drain) ---------------------------------
    void applyVolumeRt(float v) noexcept { vol_.setTarget(v < 0.0f ? 0.0f : v); }
    void applyVcaGainRt(float g) noexcept { vcaGain_.store(g < 0.0f ? 0.0f : g, std::memory_order_relaxed); }
    void applyPanRt(float v) noexcept;
    void applyMuteRt(bool muted) noexcept { mute_.setTarget(muted ? 0.0f : 1.0f); }
    void applySendLevelRt(int modelIndex, float v) noexcept;
    // Transient EQ knob-drag fast path: swap the live coefficient cascade in place
    // (state preserved, no rebuild). Called from the graph's param-ring drain at block
    // start (same RT thread). Coefficients are computed on the control thread.
    void applyEqRt(const EqBandSet& set) noexcept { eq_.setActiveRt(set); }
    // Control thread (graph rebuild): carry the predecessor node's EQ filter history into
    // this freshly prepared node so a rebuild doesn't click the EQ. Coefficients are NOT
    // copied (they came from this node's config via snap). See EqProcessor::adoptState.
    void adoptEqState(const TrackNode& prev) noexcept { eq_.adoptState(prev.eq_); }

    /// Rebuild continuity (AudioGraph::buildPlan): carry the note ledgers + chase
    /// state from the same-track node of the previous plan, so notes sounding across
    /// a graph rebuild still receive their note-offs. Same benign-race contract as
    /// adoptEqState — the RT thread may still mutate `prev` while we copy; a stray or
    /// duplicate note-off is harmless, a permanently stuck note is not. Totals are
    /// recomputed from the copied cells (never copied — they could tear against the
    /// RT thread). Also queues releases for rebuild-orphaned notes (tracked notes
    /// whose note-off no longer exists in this node's baked events — deleted/moved
    /// clips) and arms the handoff-gap tolerance for the first block after the swap.
    void adoptMidiState(const TrackNode& prev) noexcept;

    // Any thread: request all-notes-off + active-note clear on the next RT pass.
    void panicRt() noexcept { panic_.store(true, std::memory_order_release); }

    // ---- midiTarget feeder routing (SPEC §5.2) ---------------------------------
    // Control thread, pre-publish only (AudioGraph::buildPlan wires feeder -> target
    // after constructing the plan's nodes; both live in the same immutable plan).
    void setMidiSink(TrackNode* sink) noexcept { midiSink_ = sink; }
    // Control thread, pre-publish: wire insert[index]'s sidechain detector to source's capture
    // (paired with cfg_.keepSidechain on the source). Out-of-range index is ignored.
    void setInsertSidechainSource(size_t index, TrackNode* src) noexcept {
        if (index < cfg_.insertSidechain.size())
            cfg_.insertSidechain[index] = src;
    }
    // RT, called by feeder nodes that process EARLIER in the same sequential pass.
    // Capped by MidiBuffer::kCapacity — overflow drops the event and counts it
    // (never overruns).
    void acceptFeederMidiRt(const MidiEvent& e) noexcept {
        if (!feederMidi_.add(e))
            ++feederOverflow_;
    }

    // RT only (AudioGraph drains its midi/preview injection ring at block start, same RT
    // thread, before the node's pass). Merged into the next pass regardless of
    // cfg_.liveMidi and of the transport state; drops when the scratch buffer is full.
    void injectMidiRt(const MidiEvent& e) noexcept { injectedMidi_.add(e); }

    // ---- sidechain source tap (RT, read by destination tracks' insert loop) ----
    // Valid when cfg_.keepSidechain: the most recent block's pre-fader (post-insert, post-EQ)
    // signal. A destination track may run before this source in the sequential pass, in which
    // case it reads last block's capture (≤1 block detector latency, never a crash). scFrames()
    // is 0 until the first capture.
    const float* scL() const noexcept { return scOutL_.data(); }
    const float* scR() const noexcept { return scOutR_.data(); }
    int scFrames() const noexcept { return scFrames_; }

private:
    void renderClipsRt(const ProcessContext& ctx, float* wl, float* wr) noexcept;
    void scheduleMidiRt(const ProcessContext& ctx) noexcept;
    void scheduleCcChaseRt(int64_t s0) noexcept;
    /// Release every tracked CLIP note as a plain note-off (tails-safe). Buffer-full
    /// keeps the remainder tracked so the next block retries; totals recomputed.
    void flushClipNotesRt(int sampleOffset) noexcept;
    /// Release every tracked LIVE note (pending-offs overflow fallback only — live
    /// notes normally end with the player's own note-off).
    void flushLiveNotesRt(int sampleOffset) noexcept;
    /// Re-emit queued releases (failed scratch adds + rebuild-orphan releases).
    void drainPendingOffsRt() noexcept;
    /// Ledger-track a live/injected/feeder event (note on/off + CC123/CC120 clears).
    void trackLiveNoteRt(const MidiEvent& e) noexcept;

    Config cfg_;

    GainSmoother vol_;
    GainSmoother mute_;
    GainSmoother pan_; // smooths the pan VALUE (-1..1); gains derived per 64-sample step
    std::vector<GainSmoother> sendLevel_;
    std::vector<double> pluginAutoLast_;

    EqProcessor eq_; // channel EQ cascade (post-inserts, pre-fader)
    DelayLine delay_;
    std::vector<float> workL_;
    std::vector<float> workR_;
    std::vector<float> scOutL_; // sidechain source capture (sized when cfg_.keepSidechain)
    std::vector<float> scOutR_;
    int scFrames_ = 0;          // frames in the last capture (0 = none yet)
    MidiBuffer midiScratch_;
    MidiBuffer injectedMidi_; // midi/preview events pending for the next pass

    // midiTarget routing (RT-only access; wired pre-publish on the control thread).
    TrackNode* midiSink_ = nullptr;  // set on FEEDER nodes: deliver MIDI here, no audio
    MidiBuffer feederMidi_;          // filled on TARGET nodes by earlier feeder passes
    uint32_t feederOverflow_ = 0;    // events dropped at the merge-buffer cap
    bool feederWasMuted_ = false;    // mute-edge detection (release held notes once)

    bool hasPitchBend_ = false; // any controller-128 entry in cfg_.ccEvents (chase)

    // Active-note ledger: COUNT per pitch×channel (counts, not bits, so overlapping
    // same-pitch notes emit matched note-offs). Two ledgers by note ORIGIN:
    //   clipNotes_  clip-scheduled notes — released by the stop / locate / loop-wrap
    //               flushes (the transport owns their lifetime)
    //   liveNotes_  live-input / injected-preview / feeder-delivered notes — NEVER cut
    //               by the transport (a chord held on the keyboard survives stop);
    //               their note-offs are accepted even after cfg_.liveMidi turns off
    //               (track deselected mid-note), so releases can't be orphaned
    struct NoteLedger {
        uint8_t count[128][16] = {};
        int total = 0;
        void noteOn(int pitch, int ch) noexcept {
            uint8_t& c = count[pitch & 0x7F][ch & 0x0F];
            if (c < 255) {
                ++c;
                ++total;
            }
        }
        /// true when a matching on was tracked (the off belongs to us).
        bool noteOff(int pitch, int ch) noexcept {
            uint8_t& c = count[pitch & 0x7F][ch & 0x0F];
            if (c == 0)
                return false;
            --c;
            --total;
            return true;
        }
        bool has(int pitch, int ch) const noexcept {
            return count[pitch & 0x7F][ch & 0x0F] > 0;
        }
        void clear() noexcept {
            std::memset(count, 0, sizeof(count));
            total = 0;
        }
    };
    NoteLedger clipNotes_;
    NoteLedger liveNotes_;
    int64_t lastEndSample_ = -1; // discontinuity detection (locate/wrap chasing)

    // Note-offs that could not enter a full scratch buffer, plus rebuild-orphaned
    // releases queued by adoptMidiState — re-emitted at the next block(s). Fixed
    // capacity; overflow falls back to a full ledger flush (an over-release is
    // audible once, a stuck note is audible forever).
    struct PendingOffs {
        struct Cell {
            uint8_t pitch, ch, fromClip;
        };
        Cell cells[32];
        int count = 0;
        bool overflow = false;
        void push(int pitch, int ch, bool fromClip) noexcept {
            if (count < 32)
                cells[count++] = {static_cast<uint8_t>(pitch & 0x7F),
                                  static_cast<uint8_t>(ch & 0x0F),
                                  static_cast<uint8_t>(fromClip ? 1 : 0)};
            else
                overflow = true;
        }
        void clear() noexcept {
            count = 0;
            overflow = false;
        }
    };
    PendingOffs pendingOffs_;

    // First playing block after a rebuild handoff: a small FORWARD position gap vs the
    // adopted lastEndSample_ is rebuild latency (the RT thread advanced the OLD node
    // between the adoption copy and the plan swap), NOT a user locate — flushing on it
    // would cut every note the adoption just preserved.
    bool adoptedHandoff_ = false;
    int64_t handoffToleranceSamples_ = 9600; // re-derived in prepare(): sampleRate/5

    std::atomic<bool> panic_{false};
    std::atomic<float> vcaGain_{1.0f}; // VCA multiplier (live via applyVcaGainRt / baked at prepare)

    int sampleRate_ = 48000;
    int maxBlock_ = 0;
};

} // namespace mydaw
