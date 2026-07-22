// MyDAW — core/TrackNode.cpp (E2)

#include "core/TrackNode.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "core/AutomationEval.h"
#include "core/Meters.h"
#include "media/AssetStore.h" // PcmData
#include "core/IInsertNode.h"

namespace mydaw {

TrackNode::TrackNode(Config&& cfg) : cfg_(std::move(cfg)) {
    sendLevel_.resize(cfg_.sends.size());
    pluginAutoLast_.assign(cfg_.pluginAuto.size(), -1.0e9);
    for (const CcEvent& e : cfg_.ccEvents)
        if (e.controller == 128) {
            hasPitchBend_ = true;
            break;
        }
}

void TrackNode::prepare(int sampleRate, int maxBlock) {
    sampleRate_ = std::max(1, sampleRate);
    maxBlock_ = std::max(1, maxBlock);
    workL_.assign(static_cast<size_t>(maxBlock_), 0.0f);
    workR_.assign(static_cast<size_t>(maxBlock_), 0.0f);
    if (cfg_.keepSidechain) {
        scOutL_.assign(static_cast<size_t>(maxBlock_), 0.0f);
        scOutR_.assign(static_cast<size_t>(maxBlock_), 0.0f);
    }
    scFrames_ = 0;

    vol_.prepare(sampleRate_);
    vol_.snap(std::max(0.0f, cfg_.volume));
    vcaGain_.store(std::max(0.0f, cfg_.vcaGain), std::memory_order_relaxed);
    mute_.prepare(sampleRate_);
    mute_.snap(cfg_.muted ? 0.0f : 1.0f);
    pan_.prepare(sampleRate_);
    pan_.snap(std::clamp(cfg_.pan, -1.0f, 1.0f));
    for (size_t k = 0; k < sendLevel_.size(); ++k) {
        sendLevel_[k].prepare(sampleRate_);
        sendLevel_[k].snap(std::max(0.0f, cfg_.sends[k].level));
    }

    eq_.snap(cfg_.eq); // channel EQ coefficients (control-thread baked); state cleared

    delay_.prepare(cfg_.pdcDelaySamples, 2);
    delay_.setDelay(cfg_.pdcDelaySamples);

    clipNotes_.clear();
    liveNotes_.clear();
    pendingOffs_.clear();
    lastEndSample_ = -1;
    adoptedHandoff_ = false;
    handoffToleranceSamples_ = sampleRate_ / 5; // rebuild latency tolerance, ~200 ms
}

void TrackNode::process(ProcessContext& ctx, const float* const* inputs, int numInputs,
                        float* const* outputs, int numOutputs) {
    processTrackRt(ctx, inputs, numInputs, outputs, numOutputs, nullptr, nullptr, 0,
                   nullptr, 0, nullptr);
}

void TrackNode::reset() {
    clipNotes_.clear();
    liveNotes_.clear();
    pendingOffs_.clear();
    adoptedHandoff_ = false;
    lastEndSample_ = -1;
    midiScratch_.clear();
    injectedMidi_.clear();
    feederMidi_.clear();
    eq_.reset();
    delay_.reset();
    vol_.snap(vol_.target());
    mute_.snap(mute_.target());
    pan_.snap(pan_.target());
    for (auto& s : sendLevel_)
        s.snap(s.target());
}

void TrackNode::applyPanRt(float v) noexcept {
    pan_.setTarget(std::clamp(v, -1.0f, 1.0f));
}

void TrackNode::applySendLevelRt(int modelIndex, float v) noexcept {
    for (size_t k = 0; k < cfg_.sends.size(); ++k) {
        if (cfg_.sends[k].modelIndex == modelIndex) {
            sendLevel_[k].setTarget(v < 0.0f ? 0.0f : v);
            return;
        }
    }
}

void TrackNode::flushClipNotesRt(int sampleOffset) noexcept {
    if (clipNotes_.total <= 0)
        return;
    bool full = false;
    for (int pitch = 0; pitch < 128 && !full; ++pitch) {
        for (int ch = 0; ch < 16 && !full; ++ch) {
            uint8_t& c = clipNotes_.count[pitch][ch];
            while (c > 0) {
                if (!midiScratch_.add(MidiEvent::noteOff(ch, pitch, sampleOffset))) {
                    full = true; // scratch full — keep the rest tracked; next block retries
                    break;
                }
                --c;
            }
        }
    }
    // Recompute the total from the cells: adoption may have raced count vs total
    // (benign-race contract), and a full scratch keeps a remainder tracked.
    int t = 0;
    for (int pitch = 0; pitch < 128; ++pitch)
        for (int ch = 0; ch < 16; ++ch)
            t += clipNotes_.count[pitch][ch];
    clipNotes_.total = t;
}

void TrackNode::flushLiveNotesRt(int sampleOffset) noexcept {
    if (liveNotes_.total <= 0)
        return;
    bool full = false;
    for (int pitch = 0; pitch < 128 && !full; ++pitch) {
        for (int ch = 0; ch < 16 && !full; ++ch) {
            uint8_t& c = liveNotes_.count[pitch][ch];
            while (c > 0) {
                if (!midiScratch_.add(MidiEvent::noteOff(ch, pitch, sampleOffset))) {
                    full = true;
                    break;
                }
                --c;
            }
        }
    }
    int t = 0;
    for (int pitch = 0; pitch < 128; ++pitch)
        for (int ch = 0; ch < 16; ++ch)
            t += liveNotes_.count[pitch][ch];
    liveNotes_.total = t;
}

void TrackNode::drainPendingOffsRt() noexcept {
    if (pendingOffs_.overflow) {
        // Pathological (>32 failed releases in flight): release everything tracked.
        // An over-release is audible once; a stuck note is audible until panic.
        flushClipNotesRt(0);
        flushLiveNotesRt(0);
        pendingOffs_.clear();
        return;
    }
    int keep = 0;
    for (int i = 0; i < pendingOffs_.count; ++i) {
        const PendingOffs::Cell c = pendingOffs_.cells[i];
        if (midiScratch_.add(MidiEvent::noteOff(c.ch, c.pitch, 0))) {
            // Keep the ledger consistent with the emitted off (noteOff no-ops at 0 —
            // a stop-flush may already have released and zeroed the cell meanwhile).
            if (c.fromClip)
                clipNotes_.noteOff(c.pitch, c.ch);
            else
                liveNotes_.noteOff(c.pitch, c.ch);
        } else {
            pendingOffs_.cells[keep++] = c; // still full — retry next block
        }
    }
    pendingOffs_.count = keep;
}

void TrackNode::adoptMidiState(const TrackNode& prev) noexcept {
    std::memcpy(clipNotes_.count, prev.clipNotes_.count, sizeof(clipNotes_.count));
    std::memcpy(liveNotes_.count, prev.liveNotes_.count, sizeof(liveNotes_.count));
    // Totals are recomputed from the copied cells, never copied: prev's total mutates
    // on the RT thread and a torn total could pin a flush unreachable.
    int ct = 0;
    int lt = 0;
    for (int pitch = 0; pitch < 128; ++pitch) {
        for (int ch = 0; ch < 16; ++ch) {
            ct += clipNotes_.count[pitch][ch];
            lt += liveNotes_.count[pitch][ch];
        }
    }
    clipNotes_.total = ct;
    liveNotes_.total = lt;
    lastEndSample_ = prev.lastEndSample_;
    feederWasMuted_ = prev.feederWasMuted_;
    adoptedHandoff_ = true;

    // Rebuild-orphan scan (control thread, non-RT — we are pre-publish): a tracked
    // clip note with NO matching note-off at/after the playhead in the NEW baked
    // events belongs to a clip that was deleted or moved away — queue its release
    // now, otherwise it drones until the stop flush.
    if (lastEndSample_ >= 0 && clipNotes_.total > 0) {
        const auto& ev = cfg_.noteEvents;
        size_t lo = 0;
        size_t hi = ev.size();
        while (lo < hi) { // first event at/after the adopted playhead (sorted)
            const size_t mid = (lo + hi) / 2;
            if (ev[mid].sample < lastEndSample_)
                lo = mid + 1;
            else
                hi = mid;
        }
        for (int pitch = 0; pitch < 128; ++pitch) {
            for (int ch = 0; ch < 16; ++ch) {
                const uint8_t c = clipNotes_.count[pitch][ch];
                if (c == 0)
                    continue;
                bool hasOff = false;
                for (size_t i = lo; i < ev.size(); ++i) {
                    if (!ev[i].on && ev[i].pitch == pitch && (ev[i].channel & 0x0F) == ch) {
                        hasOff = true;
                        break;
                    }
                }
                if (!hasOff)
                    for (int k = 0; k < c; ++k)
                        pendingOffs_.push(pitch, ch, /*fromClip=*/true);
            }
        }
    }
}

void TrackNode::trackLiveNoteRt(const MidiEvent& e) noexcept {
    if (e.isNoteOn())
        liveNotes_.noteOn(e.data[1], e.data[0] & 0x0F);
    else if (e.isNoteOff())
        liveNotes_.noteOff(e.data[1], e.data[0] & 0x0F);
    else if (e.isAllNotesOff() || e.isAllSoundOff())
        liveNotes_.clear(); // the chain releases everything; the ledger must agree
}

// CC chase (play start / locate / loop-wrap): send the latest baked point strictly
// before s0 per controller, at offset 0 — events AT s0 are scheduled by the in-block
// loop. Pitch bend re-centers when the track has bend points but none before s0.
// Bounded linear scan over the immutable baked array — no allocation, no locks.
void TrackNode::scheduleCcChaseRt(int64_t s0) noexcept {
    const auto& cc = cfg_.ccEvents;
    if (cc.empty())
        return;
    int last[130];
    for (int i = 0; i < 130; ++i)
        last[i] = -1;
    for (size_t i = 0; i < cc.size() && cc[i].sample < s0; ++i)
        last[cc[i].controller] = static_cast<int>(i);
    for (int ctl = 0; ctl < 130; ++ctl) {
        if (last[ctl] < 0)
            continue;
        const CcEvent& e = cc[static_cast<size_t>(last[ctl])];
        MidiEvent m = MidiEvent::make3(e.data[0], e.data[1], e.data[2], 0);
        m.size = e.size;
        midiScratch_.add(m);
    }
    if (hasPitchBend_ && last[128] < 0)
        midiScratch_.add(MidiEvent::pitchBend(0, 0, 0)); // re-center before first point
}

void TrackNode::scheduleMidiRt(const ProcessContext& ctx) noexcept {
    if (cfg_.noteEvents.empty() && cfg_.ccEvents.empty() && clipNotes_.total == 0)
        return;

    if (!ctx.playing) {
        // Stop chasing: release every sounding CLIP note (live-held notes are the
        // player's — a chord held on the keyboard survives stop). Re-runs while the
        // ledger is non-empty, so a full scratch buffer retries next block.
        flushClipNotesRt(0);
        lastEndSample_ = -1;
        return;
    }

    const int64_t s0 = ctx.playheadSamples;
    const int64_t s1 = s0 + ctx.frames;

    // Locate / loop-wrap chasing: a position discontinuity releases held notes first;
    // play start (lastEndSample_ < 0) and discontinuities re-chase CC state.
    bool chase = lastEndSample_ < 0 || lastEndSample_ != s0;
    if (chase && adoptedHandoff_ && lastEndSample_ >= 0 && s0 > lastEndSample_ &&
        s0 - lastEndSample_ <= handoffToleranceSamples_) {
        // NOT a locate: the RT thread advanced the OLD node between the adoption copy
        // and the plan swap (rebuild latency). The old node played the gap's events —
        // treat the position as continuous; flushing here would cut every note the
        // adoption just preserved.
        chase = false;
    }
    adoptedHandoff_ = false;
    if (chase && lastEndSample_ >= 0)
        flushClipNotesRt(0);
    if (chase)
        scheduleCcChaseRt(s0);

    // In-block CC events, appended before the note events so equal-offset CCs land
    // ahead of note-ons after the stable sortByOffset.
    {
        const auto& cc = cfg_.ccEvents;
        size_t lo = 0;
        size_t hi = cc.size();
        while (lo < hi) {
            const size_t mid = (lo + hi) / 2;
            if (cc[mid].sample < s0)
                lo = mid + 1;
            else
                hi = mid;
        }
        for (size_t i = lo; i < cc.size() && cc[i].sample < s1; ++i) {
            const CcEvent& e = cc[i];
            MidiEvent m = MidiEvent::make3(e.data[0], e.data[1], e.data[2],
                                           static_cast<int>(e.sample - s0));
            m.size = e.size;
            midiScratch_.add(m);
        }
    }

    const auto& ev = cfg_.noteEvents;

    // First event with sample >= s0 (events sorted by sample).
    size_t lo = 0;
    size_t hi = ev.size();
    while (lo < hi) {
        const size_t mid = (lo + hi) / 2;
        if (ev[mid].sample < s0)
            lo = mid + 1;
        else
            hi = mid;
    }
    for (size_t i = lo; i < ev.size() && ev[i].sample < s1; ++i) {
        const NoteEvent& e = ev[i];
        const int off = static_cast<int>(e.sample - s0);
        const int ch = e.channel & 0x0F;
        if (e.on) {
            if (midiScratch_.add(MidiEvent::noteOn(ch, e.pitch, e.velocity, off)))
                clipNotes_.noteOn(e.pitch, ch); // counted per on — overlaps release cleanly
        } else {
            // Note-offs are emitted UNCONDITIONALLY: after a rebuild the adopted
            // ledger can miss a note that started between the adoption copy and the
            // plan swap (the old node tracked it), and an off for a non-sounding
            // pitch is harmless. The ledger only gates flushes; noteOff() no-ops at
            // zero. A full scratch queues the release for the next block's drain.
            if (midiScratch_.add(MidiEvent::noteOff(ch, e.pitch, off)))
                clipNotes_.noteOff(e.pitch, ch);
            else
                pendingOffs_.push(e.pitch, ch, /*fromClip=*/true);
        }
    }
    lastEndSample_ = s1;
}

void TrackNode::renderClipsRt(const ProcessContext& ctx, float* wl, float* wr) noexcept {
    const int64_t s0 = ctx.playheadSamples;
    const int64_t s1 = s0 + ctx.frames;
    for (const ResolvedAudioClip& c : cfg_.audioClips) {
        if (!c.pcm || c.pcm->channels <= 0 || c.lengthSamples <= 0)
            continue;
        const int64_t cs = c.startSample;
        const int64_t ce = cs + c.lengthSamples;
        const int64_t ovS = std::max(s0, cs);
        const int64_t ovE = std::min(s1, ce);
        if (ovE <= ovS)
            continue;
        const float* srcL = c.pcm->planes[0].data();
        const float* srcR =
            c.pcm->channels >= 2 ? c.pcm->planes[1].data() : srcL;
        const int64_t pcmFrames = c.pcm->frames;
        for (int64_t pos = ovS; pos < ovE; ++pos) {
            const int64_t inClip = pos - cs;
            const int64_t src = c.srcOffsetSamples + inClip;
            if (src < 0 || src >= pcmFrames)
                continue;
            float g = c.gain;
            if (c.fadeInSamples > 0 && inClip < c.fadeInSamples)
                g *= static_cast<float>(inClip + 1) / static_cast<float>(c.fadeInSamples);
            if (c.fadeOutSamples > 0 && (ce - pos) <= c.fadeOutSamples)
                g *= static_cast<float>(ce - pos) / static_cast<float>(c.fadeOutSamples);
            const int i = static_cast<int>(pos - s0);
            wl[i] += srcL[src] * g;
            wr[i] += srcR[src] * g;
        }
    }
}

void TrackNode::processTrackRt(ProcessContext& ctx, const float* const* inputs,
                               int numInputs, float* const* outputs, int numOutputs,
                               float* const* sendL, float* const* sendR, int numSends,
                               const float* const* liveIn, int numLiveIn,
                               const MidiBuffer* liveMidi) noexcept {
    const int n = ctx.frames;
    if (n <= 0 || n > maxBlock_)
        return;
    float* wl = workL_.data();
    float* wr = workR_.data();
    std::memset(wl, 0, static_cast<size_t>(n) * sizeof(float));
    std::memset(wr, 0, static_cast<size_t>(n) * sizeof(float));

    midiScratch_.clear();

    // engine/panic: clear the active-note table and tell the chain to silence. A
    // feeder forwards the panic CCs to its target's chain (its own inserts are empty).
    if (panic_.exchange(false, std::memory_order_acq_rel)) {
        clipNotes_.clear();
        liveNotes_.clear();
        pendingOffs_.clear();
        if (!cfg_.inserts.empty() || midiSink_) {
            for (int ch = 0; ch < 16; ++ch) {
                midiScratch_.add(MidiEvent::controlChange(ch, 64, 0, 0)); // sustain off
                midiScratch_.add(MidiEvent::allSoundOff(ch, 0));
                midiScratch_.add(MidiEvent::allNotesOff(ch, 0));
            }
        }
    }

    // ---- source -----------------------------------------------------------
    if (cfg_.busLike) {
        if (inputs && numInputs >= 1 && inputs[0]) {
            std::memcpy(wl, inputs[0], static_cast<size_t>(n) * sizeof(float));
            const float* inR = (numInputs >= 2 && inputs[1]) ? inputs[1] : inputs[0];
            std::memcpy(wr, inR, static_cast<size_t>(n) * sizeof(float));
        }
        // Master processes in place (input buffer == output buffer): clear the raw
        // accumulation so the processed signal below doesn't double on top of it.
        if (outputs && numOutputs >= 1 && inputs && numInputs >= 1 &&
            outputs[0] == inputs[0]) {
            for (int c = 0; c < numOutputs; ++c)
                if (outputs[c])
                    std::memset(outputs[c], 0, static_cast<size_t>(n) * sizeof(float));
        }
    } else {
        if (ctx.playing && !midiSink_) // feeders contribute no audio
            renderClipsRt(ctx, wl, wr);
        scheduleMidiRt(ctx);
    }

    // Queued releases first (failed scratch adds from earlier blocks + rebuild-orphan
    // releases queued by adoptMidiState) — nothing may starve a note-off.
    if (pendingOffs_.count > 0 || pendingOffs_.overflow)
        drainPendingOffsRt();

    // Live MIDI merge (selected / monitoring midi + instrument tracks). RELEASES
    // (note-off / all-notes-off / all-sound-off) pass EVEN when cfg_.liveMidi is off,
    // and unconditionally — deselecting the track mid-note must never orphan the
    // release, and after a rebuild the adopted ledger may not know a note the old
    // plan's node was tracking (a spurious off is harmless). Ons stay gated.
    if (liveMidi) {
        for (const MidiEvent& e : *liveMidi) {
            if (cfg_.liveMidi || e.isNoteOff() || e.isAllNotesOff() || e.isAllSoundOff()) {
                if (midiScratch_.add(e))
                    trackLiveNoteRt(e);
                else if (e.isNoteOff())
                    pendingOffs_.push(e.data[1], e.data[0] & 0x0F, /*fromClip=*/false);
            }
        }
    }
    // Injected live MIDI (midi/preview): plays regardless of arm/monitor/transport.
    if (!injectedMidi_.empty()) {
        for (MidiEvent e : injectedMidi_) {
            e.sampleOffset = 0;
            if (midiScratch_.add(e))
                trackLiveNoteRt(e);
            else if (e.isNoteOff())
                pendingOffs_.push(e.data[1], e.data[0] & 0x0F, /*fromClip=*/false);
        }
        injectedMidi_.clear();
    }

    // ---- MIDI feeder (Track::midiTarget): deliver this span's events into the target
    // instrument node's merge buffer and contribute NO audio. The target processes
    // LATER in this same sequential pass and sorts the merged events itself. Muting the
    // feeder gates only its events: note-offs/all-notes-off/all-sound-off still pass,
    // and held notes are released once at the mute edge, so the target never hangs.
    if (midiSink_) {
        const bool gateMuted = mute_.target() < 0.5f;
        if (gateMuted && !feederWasMuted_)
            flushClipNotesRt(0); // release held notes; the offs pass the gate below
        feederWasMuted_ = gateMuted;
        for (const MidiEvent& e : midiScratch_) {
            if (gateMuted && !(e.isNoteOff() || e.isAllNotesOff() || e.isAllSoundOff()))
                continue;
            midiSink_->acceptFeederMidiRt(e);
        }
        midiScratch_.clear();
        if (cfg_.meter) // no audio contribution — keep the meter decaying to silence
            cfg_.meter->writeFromRt(0.0f, 0.0f, 0.0f, 0.0f);
        return;
    }

    // Feeder-delivered MIDI (midiTarget routing): merged before the sort; the feeders
    // already ran for this span (the graph orders feeders before their target). Tracked
    // in the live ledger so offline renders and diagnostics see the target's true state.
    if (!feederMidi_.empty()) {
        for (const MidiEvent& e : feederMidi_) {
            if (midiScratch_.add(e))
                trackLiveNoteRt(e);
            else if (e.isNoteOff())
                pendingOffs_.push(e.data[1], e.data[0] & 0x0F, /*fromClip=*/false);
        }
        feederMidi_.clear();
    }
    midiScratch_.sortByOffset();

    // Live capture monitoring (bypasses PDC, SPEC §7).
    bool liveAudioActive = false;
    if (liveIn && numLiveIn > 0 &&
        (cfg_.liveAudioMonitor || (cfg_.liveAudioWhenRecording && ctx.recording))) {
        const int c0 = std::max(0, cfg_.inputChannelOffset);
        if (c0 < numLiveIn && liveIn[c0]) {
            liveAudioActive = true;
            const float* a = liveIn[c0];
            const float* b = (cfg_.trackChannels >= 2 && c0 + 1 < numLiveIn && liveIn[c0 + 1])
                                 ? liveIn[c0 + 1]
                                 : a;
            for (int i = 0; i < n; ++i) {
                wl[i] += a[i];
                wr[i] += b[i];
            }
        }
    }

    // ---- insert chain -------------------------------------------------------
    if (!cfg_.inserts.empty()) {
        float* io[2] = {wl, wr};
        const size_t nsc = cfg_.insertSidechain.size();
        for (size_t k = 0; k < cfg_.inserts.size(); ++k) {
            IInsertNode* p = cfg_.inserts[k];
            if (!p)
                continue;
            // Hand a wired compressor its source's captured pre-fader signal for THIS block
            // (pointers valid only through processRt; may lag one block if the source runs
            // later in the sequential pass — accepted detector latency, never a crash).
            if (k < nsc) {
                TrackNode* src = cfg_.insertSidechain[k];
                if (src && src->scFrames() > 0)
                    p->setSidechainRt(src->scL(), src->scR(), src->scFrames());
            }
            p->processRt(ctx, io, 2, midiScratch_);
        }
    }

    // ---- plugin-param automation (once per block, SPEC §7) -------------------
    if (ctx.playing) {
        for (size_t k = 0; k < cfg_.pluginAuto.size(); ++k) {
            const PluginAutoLane& lane = cfg_.pluginAuto[k];
            if (!lane.node || lane.points.empty())
                continue;
            const double v =
                std::clamp(evalAutomation(lane.points, ctx.ppqPos), 0.0, 1.0);
            if (std::fabs(v - pluginAutoLast_[k]) > 1e-6) {
                lane.node->setParamRt(lane.paramId, static_cast<float>(v));
                pluginAutoLast_[k] = v;
            }
        }
    }

    // ---- channel EQ (post-inserts, pre-fader; true no-op when bypassed/empty) -
    if (!eq_.isNoOp())
        eq_.processRt(wl, wr, n);

    // ---- PDC alignment delay (skipped while live input is monitored) ---------
    if (delay_.delay() > 0 && !liveAudioActive) {
        float* ch[2] = {wl, wr};
        delay_.processRt(ch, 2, n);
    }

    // ---- sidechain source tap (pre-fader, post-insert/EQ) --------------------
    // Publish this block's processed signal so destination tracks' compressors can detect from
    // it. Captured pre-fader so the source's own automation/mute doesn't gate the key signal.
    if (cfg_.keepSidechain && !scOutL_.empty()) {
        const int cn = std::min(n, static_cast<int>(scOutL_.size()));
        std::copy(wl, wl + cn, scOutL_.begin());
        std::copy(wr, wr + cn, scOutR_.begin());
        scFrames_ = cn;
    }

    // ---- automation (64-sample steps) + fader/pan + sends + meter ------------
    const double beatsPerSample =
        ctx.tempo / (60.0 * static_cast<double>(ctx.sampleRate > 0 ? ctx.sampleRate : 1));
    const int ns = std::min<int>(numSends, static_cast<int>(cfg_.sends.size()));
    float peakL = 0.0f, peakR = 0.0f;
    double sumL = 0.0, sumR = 0.0;

    for (int cs = 0; cs < n; cs += 64) {
        const int cn = std::min(64, n - cs);
        if (ctx.playing) {
            const double beat = ctx.ppqPos + static_cast<double>(cs) * beatsPerSample;
            if (!cfg_.volumeAuto.empty())
                vol_.setTarget(static_cast<float>(
                    std::max(0.0, evalAutomation(cfg_.volumeAuto, beat))));
            if (!cfg_.panAuto.empty())
                pan_.setTarget(static_cast<float>(
                    std::clamp(evalAutomation(cfg_.panAuto, beat), -1.0, 1.0)));
            for (int k = 0; k < ns; ++k)
                if (!cfg_.sends[k].autoPoints.empty())
                    sendLevel_[k].setTarget(static_cast<float>(
                        std::max(0.0, evalAutomation(cfg_.sends[k].autoPoints, beat))));
        }
        // Advance the pan smoother through this step; gains held constant per step.
        float pv = pan_.current();
        for (int j = 0; j < cn; ++j)
            pv = pan_.next();
        const PanGains pg =
            cfg_.trackChannels == 1 ? monoPanGains(pv) : stereoBalanceGains(pv);

        const float vca = vcaGain_.load(std::memory_order_relaxed); // VCA group multiplier
        for (int j = 0; j < cn; ++j) {
            const int i = cs + j;
            const float dryL = wl[i];
            const float dryR = wr[i];
            const float g = vol_.next() * mute_.next() * vca;
            const float outL = dryL * g * pg.l;
            const float outR = dryR * g * pg.r;
            for (int k = 0; k < ns; ++k) {
                const float s = sendLevel_[k].next();
                if (!sendL[k] || !sendR[k])
                    continue;
                if (cfg_.sends[k].pre) {
                    sendL[k][i] += dryL * s;
                    sendR[k][i] += dryR * s;
                } else {
                    sendL[k][i] += outL * s;
                    sendR[k][i] += outR * s;
                }
            }
            wl[i] = outL;
            wr[i] = outR;
            const float aL = outL < 0.0f ? -outL : outL;
            const float aR = outR < 0.0f ? -outR : outR;
            if (aL > peakL)
                peakL = aL;
            if (aR > peakR)
                peakR = aR;
            sumL += static_cast<double>(outL) * outL;
            sumR += static_cast<double>(outR) * outR;
        }
    }

    if (cfg_.meter)
        cfg_.meter->writeFromRt(peakL, peakR,
                                static_cast<float>(std::sqrt(sumL / n)),
                                static_cast<float>(std::sqrt(sumR / n)));

    // ---- accumulate into the output bus -------------------------------------
    if (outputs && numOutputs >= 1 && outputs[0]) {
        float* oL = outputs[0];
        float* oR = (numOutputs >= 2 && outputs[1]) ? outputs[1] : nullptr;
        for (int i = 0; i < n; ++i) {
            oL[i] += wl[i];
            if (oR)
                oR[i] += wr[i];
        }
    }
}

} // namespace mydaw
