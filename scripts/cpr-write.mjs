#!/usr/bin/env node
// cpr-write.mjs — Cubase .cpr WRITER, milestone 2 (record splicing).
//
// Generates a .cpr from a MyDAW-shaped JSON model by splicing generated records into a
// C5-era donor file (default: playground/cubase5-7track.cpr, Cubase 5.1.1):
//   - the donor MTrackList's track records are REPLACED by generated MMidiTrackEvent
//     records (name MListNode, MMidiPartEvent/MMidiPart parts with compact note events,
//     synthetic FF FE A4 C8 channel attr tree carrying Volume/Pan),
//   - the tempo map (MTempoTrackEvent) + 4/4 signature are regenerated inside the first
//     track's MListNode (where Cubase 5 keeps them),
//   - all container/record bookkeeping (chunk sizes, record sizes, interning ids) is
//     recomputed by the M1 library (scripts/cpr-container.mjs),
//   - donor back-refs whose interned name definition lived inside the deleted tracks are
//     HEALED: converted to full-form definitions in place (donor cubase5-7track has
//     exactly two: FAttributes v0 and MTrack v2, both referenced after the track list).
//
// Model JSON (docs/CPR_WRITER_M2_NOTES.md):
//   { tempo, tracks: [ { name, kind:"midi", volumeGain, pan,
//       clips: [ { startBeat, lengthBeats,
//                  notes: [ { pitch, velocity, startBeat, lengthBeats } ] } ] } ] }
// Note startBeat is CLIP-relative (MyDAW model convention; the part offsetTick is 0).
//
// Era/donor rationale + emitted grammar: docs/CPR_WRITER_M2_NOTES.md. The acceptance
// oracle is MyDAW's own importer (scripts/cpr-write-test.mjs); real-Cubase acceptance is
// milestone 3.
//
// usage: node scripts/cpr-write.mjs <model.json> <out.cpr> [--donor <donor.cpr>]
//
// PIPELINE v2 (default since the two real-Cubase 5.1.1 bisect runs, 2026-07-16 —
// docs/CPR_WRITER_M3_NOTES.md):
//   - keepDonorTracks DEFAULTS TO 1: the donor's track 1 (native tempo/signature
//     carrier, valid MRoot track-table entry 1) is kept and the generated MIDI tracks
//     are appended after it. This is the human-validated base (ladder v2 stages 20-22
//     all OPEN in Cubase 5.1.1, including notes + the synthetic channel tree); the
//     delete-ALL base is refused by C5 (v1 stage 03b). model.tempo is applied by
//     patching the kept track's MTempoTrackEvent floats in place (same-length).
//   - the donor's MRoot track table is left UNTOUCHED: C5 tolerates stale entries
//     (v1 03a, v2 20-22 OPEN) but refused a rebuilt/rebound table (v2 29 FAIL).
//   - stored-offset-id gate: record bodies may store object links as ABSOLUTE archive
//     offsets (id = target dataStart - (archDataOff+4)): the audio pool graph
//     (AudioCluster/AudioFile/AClusterSegment/GTreeEntry/PAudioProcessCommand) and
//     MAudioEvent's +26 clip link. Splicing shifts those targets, so the writer
//     REBASES every known-owner stored id past the edit point (validated: ladder v2
//     stage 24 OPEN vs 25/26 FAIL without rebase) and then VERIFIES every known-owner
//     site resolves to a record of the same class in the emitted bytes — it throws
//     rather than ship a dangling pool link.
//
// writeCpr(model, donorPath, opts):
//   opts.keepDonorTracks=N        default 1 (see above); 0 = legacy M2 delete-all base
//                                 (kept for the bisect-v1 builder; C5-refused).
//   opts.channelTree=false        omit the synthetic FF FE A4 C8 Volume/Pan tree.
//   opts.nativeFirstTrackHead     generated-tempo-carrier MListNode head in the native
//                                 shape (only relevant with keepDonorTracks:0).
// exported for the bisect builders + oracle: buildIdInfo, healArch, clsName,
// DONOR_BASE_TRACKS (what the default pipeline prepends to the model's tracks).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serialize, detectEra, firstDiff } from './cpr-container.mjs';

const PPQ = 480;
// The same donor project the C++ writer embeds (engine/assets), resolved repo-relative.
const DEFAULT_DONOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'assets', 'cpr-donor-c5.cpr');

// tracks the DEFAULT pipeline (keepDonorTracks 1 on the default donor) prepends before
// the model's tracks — the oracle test uses this to build its expectations.
export const DONOR_BASE_TRACKS = [{ name: 'Track1', kind: 'audio' }];

// record classes whose raw bodies are KNOWN to store archive-offset object ids
// (decoded 2026-07-16 from tapetim/isi-good; docs/CPR_WRITER_M3_NOTES.md). Only these
// owners get their stored ids rebased/verified — value-matches inside other classes
// are treated as coincidences (e.g. editor-geometry u32 pairs matching low record ids).
const STORED_ID_OWNERS = new Set([
  'AudioCluster', 'AudioFile', 'AClusterSegment', 'GTreeEntry',
  'PAudioProcessCommand', 'MAudioEvent',
]);

// ---------------------------------------------------------------------------
// byte builders (all structural ints big-endian)
// ---------------------------------------------------------------------------

class Bytes {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(Buffer.from([v & 0xff])); return this; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v >>> 0); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); this.parts.push(b); return this; }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(Math.trunc(v))); this.parts.push(b); return this; }
  f32(v) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.parts.push(b); return this; }
  f64(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.parts.push(b); return this; }
  buf(b) { this.parts.push(b); return this; }
  // lpstr with UTF-8 BOM suffix (record-data strings: u32 len INCL. NUL+BOM, chars, NUL, EF BB BF)
  lpstrBom(text) {
    const chars = Buffer.from(text, 'utf8');
    this.u32(chars.length + 4).buf(chars).u8(0).buf(Buffer.from([0xef, 0xbb, 0xbf]));
    return this;
  }
  // plain lpstr (attr-tree keys: u32 len INCL. NUL, chars, NUL)
  lpstr(text) {
    const chars = Buffer.from(text, 'utf8');
    this.u32(chars.length + 1).buf(chars).u8(0);
    return this;
  }
  out() { return Buffer.concat(this.parts); }
}

// full-form archive record header bytes (used only inside raw spans, e.g. the MMidiPart
// class registry): [FFFFFFFE len base NUL ver]* FFFFFFFF len name NUL ver, u32 size, data
function fullRecordBytes(chain, name, ver, data) {
  const b = new Bytes();
  for (const [cn, cv] of chain) {
    b.u32(0xfffffffe).u32(cn.length + 1).buf(Buffer.from(cn, 'latin1')).u8(0).u16(cv);
  }
  b.u32(0xffffffff).u32(name.length + 1).buf(Buffer.from(name, 'latin1')).u8(0).u16(ver);
  b.u32(data.length).buf(data);
  return b.out();
}

// ---------------------------------------------------------------------------
// M1-library node builders ({t:'rec'|'raw'} shapes cpr-container.mjs serializes)
// ---------------------------------------------------------------------------

const rec = (name, ver, children, chain = null) => ({
  t: 'rec',
  chain: chain ? chain.map(([n, v]) => ({ full: true, name: n, ver: v })) : null,
  cls: { full: true, name, ver },
  children,
  anchors: [],
});
const raw = (bytes) => ({ t: 'raw', bytes, anchors: [] });

// ---------------------------------------------------------------------------
// fader taper (inverse of scripts/cpr-taper.mjs cubaseValueToGain — calibrated exact)
// ---------------------------------------------------------------------------

export function gainToCubaseValue(g) {
  if (!Number.isFinite(g) || g <= 0) return -1; // modern -inf sentinel (Value -1)
  if (g >= 1) return 25856 + (g - 1) * 6911;
  if (g >= 0.5) return 18688 + (g - 0.5) * 14336;
  return 18688 * Math.sqrt(2 * g);
}

const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -200); // -200 = modern -inf AnchorValue

// ---------------------------------------------------------------------------
// generated record content
// ---------------------------------------------------------------------------

// MMidiPart event-class registry: 7 empty full-form records (byte shape copied from a
// native C5 5.1.1 save, "haolam sheani metzayer.cpr" @0x63a9 — all names full-form, so the
// bytes are position-independent).
const REGISTRY = Buffer.concat([
  fullRecordBytes([['MMidiEvent', 2]], 'MMidiNote', 1, Buffer.alloc(0)),
  fullRecordBytes([], 'MMidiPolyPressure', 0, Buffer.alloc(0)),
  fullRecordBytes([], 'MMidiAfterTouch', 0, Buffer.alloc(0)),
  fullRecordBytes([], 'MMidiProgramChange', 0, Buffer.alloc(0)),
  fullRecordBytes([], 'MMidiController', 0, Buffer.alloc(0)),
  fullRecordBytes([], 'MMidiPitchBend', 0, Buffer.alloc(0)),
  fullRecordBytes([], 'MMidiSysex', 0, Buffer.alloc(0)),
]);

// compact note event (43 B): u8 0x90, f64 tick, u8 ch, u8 pitch, u8 vel, u32 flags,
// u16 nExt=0, f64 lengthTicks, f64 0, u8[9] 0. flags 0x02000000 = the constant every
// corpus note carries (meaning unknown — donor-copied).
function noteBytes(n) {
  return new Bytes()
    .u8(0x90).f64(n.startBeat * PPQ).u8(0).u8(n.pitch & 0x7f).u8(n.velocity & 0x7f)
    .u32(0x02000000).u16(0)
    .f64(n.lengthBeats * PPQ).f64(0).buf(Buffer.alloc(9))
    .out();
}

// MMidiPartEvent { raw 26B: u16 flags, f64 startTick, f64 lengthTicks, f64 offsetTick;
//   MMidiPart:MPartNode { lpstr name, u32 0, u32 0x208, u32 0x24F, u32 evCount,
//     u8 7 + registry, evCount compact notes } }
function buildPartNode(partName, clip) {
  const notes = [...(clip.notes ?? [])].sort((a, b) => a.startBeat - b.startBeat);
  const head = new Bytes()
    .lpstrBom(partName).u32(0).u32(0x208).u32(0x24f).u32(notes.length);
  const body = [head.out()];
  if (notes.length > 0) {
    body.push(Buffer.from([7]), REGISTRY);
    for (const n of notes) body.push(noteBytes(n));
  }
  // NOTE: the u8 registry-count byte is absent when the part is empty (importer contract).
  const partData = raw(Buffer.concat(body));
  const evHead = raw(new Bytes()
    .u16(0).f64(clip.startBeat * PPQ).f64(clip.lengthBeats * PPQ).f64(0)
    .out());
  return rec('MMidiPartEvent', 2, [
    evHead,
    rec('MMidiPart', 2, [partData], [['MPartNode', 0]]),
  ]);
}

// MTempoTrackEvent v2, donor-shaped 36 B: u32 1, {f32 secondsPerQuarter, f64 0, f64 0,
// u16 curve 0}, f32 fixedBPM, u16 modeFlag 0, u32 0 (trailing pad as in the donor).
function buildTempoNode(bpm) {
  return rec('MTempoTrackEvent', 2, [raw(new Bytes()
    .u32(1).f32(60 / bpm).f64(0).f64(0).u16(0)
    .f32(bpm).u16(0).u32(0)
    .out())]);
}

// MSignatureTrackEvent v2, donor-shaped 24 B: u32 1, {u32 ticks 0, u16 4, u16 4, u32 0,
// u32 0}, u32 0 pad. (4/4 fixed — the M2 model carries no signature.)
function buildSignatureNode() {
  return rec('MSignatureTrackEvent', 2, [raw(new Bytes()
    .u32(1).u32(0).u16(4).u16(4).u32(0).u32(0).u32(0)
    .out())]);
}

// Standard Panner channel member — byte-replica of the C5 donor's own channel-level
// Panner (cpr-donor-c5.cpr @0x232d, 17 members) with the pan written into the component
// state. The 20-byte audioComponent blob is LITTLE-endian (plugin-private state):
// f32 pos (0 = hard L, 0.5 = C, 1 = hard R; Cubase UI shows (pos-0.5)*200), f32 rightPos
// (0.5 = balance panner), u32 mode 4 (engaged — donor channel value), u32 channelCount 2,
// u32 0. Modern Cubase (13+) reads the channel pan ONLY from this blob
// (CPR_MIXER_FORMAT.md §5a); C5-era readers use the Pan member.
// MUST stay byte-identical to CprWriter.cpp appendPannerMember.
function appendPannerMember(b, pan) {
  const arrangement = (key) => {
    b.lpstr(key).u16(0x0002).u16(0x0005).u32(1); // array, 1 item
    b.u32(1);                                    // 1 member in the item
    b.lpstr('Type').u16(0x0002).u16(0x0002).u32(2).i64(1).i64(2); // i64s [1, 2]
  };
  b.lpstr('Panner').u16(0x0002).u16(0x0006).u32(17);
  b.lpstr('Default SurroundPan UID').u16(0x0002).u16(0x0006).u32(1);
  b.lpstr('GUID').u16(0x0008).lpstrBom('56535453506132737572726F756E6470');
  b.lpstr('PannerType').u16(0x0002).u16(0x0006).u32(3);
  b.lpstr('Value').u16(0x0001).i64(2);
  b.lpstr('Min').u16(0x0001).i64(0);
  b.lpstr('Max').u16(0x0001).i64(11);
  b.lpstr('Plugin UID').u16(0x0002).u16(0x0006).u32(1);
  b.lpstr('GUID').u16(0x0008).lpstrBom('44E1149EDB3E4387BDD827FEA3A39EE7');
  b.lpstr('Plugin Name').u16(0x0008).lpstrBom('Standard Panner');
  b.lpstr('Audio Input Count').u16(0x0001).i64(1);
  arrangement('Audio Input Arrangement');
  b.lpstr('Audio Output Count').u16(0x0001).i64(1);
  arrangement('Audio Output Arrangement');
  b.lpstr('Event Input Count').u16(0x0001).i64(0);
  b.lpstr('Event Output Count').u16(0x0001).i64(0);
  b.lpstr('audioComponent').u16(0x0002).u16(0x0007).u32(20);
  const blob = Buffer.alloc(20);
  blob.writeFloatLE(0.5 + Math.max(-1, Math.min(1, pan)) * 0.5, 0); // pan position
  blob.writeFloatLE(0.5, 4);  // right position (balance panner)
  blob.writeUInt32LE(4, 8);   // mode 4 (engaged)
  blob.writeUInt32LE(2, 12);  // channelCount
  b.buf(blob);
  b.lpstr('editController').u16(0x0002).u16(0x0007).u32(0);
  b.lpstr('Editor Width').u16(0x0001).i64(0);
  b.lpstr('Editor Height').u16(0x0001).i64(0);
  b.lpstr('Active').u16(0x0001).i64(1);
  b.lpstr('IDString').u16(0x0008).lpstrBom('Panner');
  b.lpstr('Bay Program').u16(0x0008).u32(0); // empty plain lpstr (donor byte-exact)
}

// Synthetic modern channel attr tree: FF FE A4 C8, u32 topCount, then self-labeled
// entries (CPR_MIXER_FORMAT.md §5). Emitted members: Volume{Value (25856-taper),
// AnchorValue (dB)} and — when pan != 0 — the Standard Panner member carrying the pan
// in its component blob (§5a). NO era of native Cubase writes a channel-level
// Pan{Value} member (C5.1.1, C12 and C13 labeled fixtures are all blob-only), so
// neither do we: the blob is the one store every Cubase reads. MyDAW's importer reads
// these via modernExtractTracks/applyModernVolume/applyChannelPan (Pan{Value} is kept
// as an import FALLBACK for pre-2026-07-17 MyDAW exports only). REAL C5 MIDI tracks do
// NOT carry this tree (their fader lives in the undecoded PMidiChannel blob) — this is
// an importer-oriented synthesis, flagged as a Cubase-acceptance risk for M3.
function channelTreeBytes(volumeGain, pan) {
  const b = new Bytes().buf(Buffer.from([0xff, 0xfe, 0xa4, 0xc8]));
  const hasPan = Number.isFinite(pan) && pan !== 0;
  b.u32(hasPan ? 2 : 1);
  // Volume (type 0x02 container, sub 0x06 named object, 2 members)
  b.lpstr('Volume').u16(0x0002).u16(0x0006).u32(2);
  b.lpstr('Value').u16(0x0004).f64(gainToCubaseValue(volumeGain));
  b.lpstr('AnchorValue').u16(0x0004).f64(gainToDb(volumeGain));
  if (hasPan) appendPannerMember(b, pan);
  return b.out();
}

// One generated track record:
// MMidiTrackEvent v3 (no chain — matches native C5 bytes) {
//   raw 26B: u16 0, f64 0, f64 576000 (donor track-event length), f64 0;
//   MListNode v0 { lpstr name, u32 0, u32 0x208, u32 0x24F,
//                  [first track only: MTempoTrackEvent, MSignatureTrackEvent],
//                  u32 nParts, MMidiPartEvent... };
//   raw: synthetic channel tree (Volume/Pan) }
function buildTrackNode(track, isFirst, bpm, opts = {}) {
  const nativeHead = isFirst && opts.nativeFirstTrackHead === true;
  const listChildren = [
    nativeHead
      ? raw(new Bytes().lpstrBom(track.name).u32(0).out())
      : raw(new Bytes().lpstrBom(track.name).u32(0).u32(0x208).u32(0x24f).out()),
  ];
  if (isFirst) {
    listChildren.push(buildTempoNode(bpm));
    listChildren.push(buildSignatureNode());
  }
  const clips = track.clips ?? [];
  listChildren.push(raw(new Bytes().u32(clips.length).out()));
  clips.forEach((clip, i) => {
    listChildren.push(buildPartNode(`${track.name}`, clip, i));
  });
  const children = [
    raw(new Bytes().u16(0).f64(0).f64(576000).f64(0).out()),
    rec('MListNode', 0, listChildren),
  ];
  if (opts.channelTree !== false)
    children.push(raw(channelTreeBytes(track.volumeGain ?? 1.0, track.pan ?? 0)));
  return rec('MMidiTrackEvent', 3, children);
}

// ---------------------------------------------------------------------------
// donor-tree surgery
// ---------------------------------------------------------------------------

// origId -> {name, ver} from every full elem; fallback reads the name straight out of
// the donor buffer at base+origId (covers defs registered by speculative scans).
export function buildIdInfo(archNode, buf, base) {
  const map = new Map();
  (function walk(list) {
    for (const n of list) {
      if (n.t !== 'rec') continue;
      for (const e of [...(n.chain ?? []), n.cls])
        if (e.full && e.origId !== undefined) map.set(e.origId, { name: e.name, ver: e.ver });
      walk(n.children);
    }
  })(archNode.nodes);
  return (origId) => {
    const hit = map.get(origId);
    if (hit) return hit;
    const p = base + origId;
    const len = buf.readUInt32BE(p);
    if (len < 2 || len > 100) throw new Error(`unresolvable name def id=0x${origId.toString(16)}`);
    return {
      name: buf.toString('latin1', p + 4, p + 4 + len - 1),
      ver: buf.readUInt16BE(p + 4 + len),
    };
  };
}

export const clsName = (n, idInfo) => (n.cls.full ? n.cls.name : idInfo(n.cls.refOrigId).name);

// offset (from record-header start) of the u32 name-length field of elems[i]
// (elems = [...chain, cls]; must mirror cpr-container.mjs emitElem exactly)
function elemLenFieldDelta(elems, i) {
  let off = 0;
  for (let k = 0; k < i; k++) {
    const e = elems[k];
    off += e.full ? 4 + 4 + e.name.length + 1 + 2 : 8; // k<i => always a chain elem
  }
  return off + 4; // marker (FFFFFFFE/FFFFFFFF), then the len field
}

// Heal pass: walk the whole ARCH in emit order. Refs whose interned definition no
// longer precedes them (deleted with the donor tracks) are converted to full-form
// definitions in place; rec-node anchors are rebuilt from the (possibly healed) elems
// so the serializer can recompute every surviving back-ref id.
export function healArch(arch, idInfo) {
  // 1. which origIds are still referenced anywhere (post-mutation)
  const needed = new Set();
  (function collect(list) {
    for (const n of list) {
      if (n.t !== 'rec') continue;
      for (const e of [...(n.chain ?? []), n.cls]) if (!e.full) needed.add(e.refOrigId);
      collect(n.children);
    }
  })(arch.nodes);

  const live = new Set();
  let healed = 0;
  (function walk(list) {
    for (const n of list) {
      if (n.t === 'raw') {
        for (const a of n.anchors) live.add(a.origId); // raw bytes unchanged, deltas valid
        continue;
      }
      const elems = [...(n.chain ?? []), n.cls];
      // rec-node anchors always sit on header name defs => rebuild below; anything else
      // would mean a speculative def inside a header span, absent from this donor.
      for (const a of n.anchors)
        if (!elems.some((e) => e.full && e.origId === a.origId))
          throw new Error(`unexpected non-elem anchor on rec @0x${(n.hdrOff ?? 0).toString(16)}`);
      for (const e of elems) {
        if (!e.full && !live.has(e.refOrigId)) {
          const info = idInfo(e.refOrigId); // def was deleted — re-define in place
          e.full = true;
          e.name = info.name;
          e.ver = info.ver;
          e.origId = e.refOrigId;
          delete e.refOrigId;
          healed++;
        }
        if (e.full && e.origId !== undefined) live.add(e.origId);
      }
      n.anchors = [];
      elems.forEach((e, i) => {
        if (e.full && e.origId !== undefined && needed.has(e.origId))
          n.anchors.push({ origId: e.origId, delta: elemLenFieldDelta(elems, i) });
      });
      walk(n.children);
    }
  })(arch.nodes);
  return healed;
}

// ---------------------------------------------------------------------------
// writeCpr(model, donorPath) -> Buffer
// ---------------------------------------------------------------------------

export function writeCpr(model, donorPath = DEFAULT_DONOR, opts = {}) {
  if (!Number.isFinite(model.tempo) || model.tempo < 20 || model.tempo > 400)
    throw new Error(`model.tempo out of range: ${model.tempo}`);
  if (!Array.isArray(model.tracks) || model.tracks.length === 0)
    throw new Error('model.tracks must be a non-empty array');
  for (const t of model.tracks)
    if (t.kind !== 'midi') throw new Error(`M2 writes only kind:"midi" tracks (got ${t.kind})`);

  const donorBuf = fs.readFileSync(donorPath);
  const tree = parse(donorBuf);
  const arch = tree.chunks.find((c) => c.id === 'ARCH' && /\|PArrangement$/.test(c.streamName ?? ''));
  if (!arch || !arch.arch) throw new Error('donor has no parsed Arrangement ARCH');
  const idInfo = buildIdInfo(arch.arch, donorBuf, arch.dataOff + 4);

  // find the MTrackList record
  let trackList = null;
  (function find(list) {
    for (const n of list) {
      if (n.t !== 'rec') continue;
      if (!trackList && clsName(n, idInfo) === 'MTrackList') trackList = n;
      find(n.children);
    }
  })(arch.arch.nodes);
  if (!trackList) throw new Error('donor has no MTrackList');

  // MTrackList children = [raw 22B header, track records...]; the header's trailing u16
  // is the track count (donor: 7).
  const head = trackList.children[0];
  if (!head || head.t !== 'raw' || head.bytes.length !== 22)
    throw new Error('unexpected MTrackList header shape');
  const donorCount = head.bytes.readUInt16BE(20);
  const donorRecs = trackList.children.filter((c) => c.t === 'rec');
  if (donorCount !== donorRecs.length)
    throw new Error(`MTrackList count u16 ${donorCount} != ${donorRecs.length} track records`);
  const keep = opts.keepDonorTracks ?? 1;
  if (keep < 0 || keep > donorRecs.length)
    throw new Error(`keepDonorTracks ${keep} out of range (donor has ${donorRecs.length})`);
  const keptRecs = donorRecs.slice(0, keep);
  const removedRecs = donorRecs.slice(keep);
  const base = arch.dataOff + 4;

  // --- stored-offset-id inventory (BEFORE mutation; header comment "PIPELINE v2") ---
  // donor record ids -> class, edit boundary, spans of removed records
  const donorRecords = new Map(); // id -> class name
  (function inv(list) {
    for (const n of list) {
      if (n.t !== 'rec') continue;
      donorRecords.set(n.dataStart - base, clsName(n, idInfo));
      inv(n.children);
    }
  })(arch.arch.nodes);
  const boundaryId = trackList.dataEnd - base; // ids >= boundary shift by the edit delta
  const removedSpans = removedRecs.map((n) => [n.hdrOff - base, n.dataEnd - base]);
  const isRemovedId = (id) => removedSpans.some(([a, b]) => id >= a && id < b);
  const removedNodes = new Set(removedRecs);

  // scan raw spans (skipping the MTrackList head we replace and the removed tracks)
  // for u32be values equal to a known record id
  const sites = []; // { node, off, oldId, targetCls, owner }
  (function scan(list, owner) {
    for (const n of list) {
      if (removedNodes.has(n) || n === head) continue;
      if (n.t === 'raw') {
        for (let i = 0; i + 4 <= n.bytes.length; i++) {
          const v = n.bytes.readUInt32BE(i);
          if (v < 0x40 || !donorRecords.has(v)) continue;
          sites.push({ node: n, off: i, oldId: v, targetCls: donorRecords.get(v), owner });
          i += 3;
        }
        continue;
      }
      scan(n.children, clsName(n, idInfo));
    }
  })(arch.arch.nodes, 'TOP');

  // --- model.tempo onto the kept donor tempo carrier (same-length float patch) ---
  if (keep > 0) {
    let tempoRec = null;
    (function find(list) {
      for (const n of list) {
        if (n.t !== 'rec') continue;
        if (!tempoRec && clsName(n, idInfo) === 'MTempoTrackEvent') tempoRec = n;
        find(n.children);
      }
    })(keptRecs[0].children);
    if (!tempoRec) throw new Error('kept donor track 1 has no MTempoTrackEvent to carry model.tempo');
    const traw = tempoRec.children[0];
    if (!traw || traw.t !== 'raw' || traw.bytes.length !== 36 || traw.bytes.readUInt32BE(0) !== 1)
      throw new Error('unexpected donor MTempoTrackEvent shape (want 36B, u32 pointCount 1)');
    const tb = Buffer.from(traw.bytes);
    tb.writeFloatBE(60 / model.tempo, 4); // point 0 secondsPerQuarter
    tb.writeFloatBE(model.tempo, 26);     // fixed/rehearsal BPM
    traw.bytes = tb;
  }

  const newHead = Buffer.from(head.bytes);
  newHead.writeUInt16BE(keep + model.tracks.length, 20);

  trackList.children = [
    raw(newHead),
    ...keptRecs,
    // with kept donor tracks, the donor's own track 1 stays the tempo/sig carrier
    ...model.tracks.map((t, i) => buildTrackNode(t, keep === 0 && i === 0, model.tempo, opts)),
  ];

  const healed = healArch(arch.arch, idInfo);

  let out = serialize(tree);

  // --- stored-offset-id rebase + verification gate ---
  // classify sites; patch known-owner ids past the boundary by the (uniform) edit delta
  const delta = out.length - donorBuf.length;
  let rebasedIds = 0, staleTableIds = 0, ignoredIdMatches = 0;
  const verifySites = []; // { newId, targetCls, owner }
  for (const s of sites) {
    if (isRemovedId(s.oldId)) {
      // target record was deleted with the donor tracks
      if (s.owner === 'MRoot') { staleTableIds++; continue; } // C5-tolerated stale table
      if (STORED_ID_OWNERS.has(s.owner))
        throw new Error(`stored ${s.owner} id 0x${s.oldId.toString(16)} targets a deleted track record — donor unsupported without deep rebase`);
      ignoredIdMatches++; // value coincidence inside an unknown owner
      continue;
    }
    if (!STORED_ID_OWNERS.has(s.owner)) {
      if (s.owner !== 'MRoot') { ignoredIdMatches++; continue; }
      verifySites.push({ newId: s.oldId, targetCls: s.targetCls, owner: s.owner }); // table entry to a kept track
      continue;
    }
    if (s.oldId >= boundaryId) {
      if (healed > 0)
        throw new Error('stored-id rebase with healed refs is unsupported (non-uniform shift)');
      const b = Buffer.from(s.node.bytes);
      b.writeUInt32BE(s.oldId + delta, s.off);
      s.node.bytes = b;
      rebasedIds++;
      verifySites.push({ newId: s.oldId + delta, targetCls: s.targetCls, owner: s.owner });
    } else {
      verifySites.push({ newId: s.oldId, targetCls: s.targetCls, owner: s.owner });
    }
  }
  if (rebasedIds > 0) {
    const out2 = serialize(tree);
    if (out2.length !== out.length) throw new Error('rebase changed layout length');
    out = out2;
  }

  // --- self-checks -----------------------------------------------------------
  // byte sanity: the output must re-parse and re-serialize byte-identically, stay C5,
  // and contain exactly the generated track records.
  const re = parse(out);
  const diff = firstDiff(out, serialize(re));
  if (diff >= 0) throw new Error(`written file not re-serialize-stable (first diff @0x${diff.toString(16)})`);
  if (detectEra(re).era !== 'c5') throw new Error('written file no longer detects as C5');
  const reArch = re.chunks.find((c) => c.id === 'ARCH' && /\|PArrangement$/.test(c.streamName ?? ''));
  const reIdInfo = buildIdInfo(reArch.arch, out, reArch.dataOff + 4);
  let reTracks = 0, reParts = 0, reTempo = 0;
  (function count(list) {
    for (const n of list) {
      if (n.t !== 'rec') continue;
      const nm = clsName(n, reIdInfo);
      if (nm === 'MMidiTrackEvent') reTracks++;
      else if (nm === 'MMidiPartEvent') reParts++;
      else if (nm === 'MTempoTrackEvent') reTempo++;
      count(n.children);
    }
  })(reArch.arch.nodes);
  const wantParts = model.tracks.reduce((a, t) => a + (t.clips?.length ?? 0), 0);
  if (reTracks !== model.tracks.length || reParts !== wantParts || reTempo !== 1)
    throw new Error(`re-parse structure mismatch: tracks ${reTracks}/${model.tracks.length}, ` +
      `parts ${reParts}/${wantParts}, tempo ${reTempo}/1`);

  // stored-id verification: every known-owner site (and every MRoot table entry whose
  // target survived) must resolve, in the EMITTED bytes, to a record of the class it
  // pointed at in the donor. Throws rather than ship a dangling/mistyped pool link.
  const reBase = reArch.dataOff + 4;
  const outById = new Map(); // id -> class
  (function collect(list) {
    for (const n of list) {
      if (n.t !== 'rec') continue;
      outById.set(n.dataStart - reBase, clsName(n, reIdInfo));
      collect(n.children);
    }
  })(reArch.arch.nodes);
  for (const v of verifySites) {
    const got = outById.get(v.newId);
    if (got !== v.targetCls)
      throw new Error(`stored-id verify failed: ${v.owner} id 0x${v.newId.toString(16)} ` +
        `resolves to ${got ?? 'NOTHING'}, expected ${v.targetCls}`);
  }

  out.stats = {
    bytes: out.length,
    donorBytes: donorBuf.length,
    tracks: model.tracks.length,
    keptDonorTracks: keep,
    parts: wantParts,
    notes: model.tracks.reduce((a, t) => a + (t.clips ?? []).reduce((x, c) => x + (c.notes?.length ?? 0), 0), 0),
    healedRefs: healed,
    rebasedIds,
    verifiedIds: verifySites.length,
    staleTableIds,
    ignoredIdMatches,
  };
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--donor');
  const donor = di >= 0 ? args.splice(di, 2)[1] : DEFAULT_DONOR;
  const [modelPath, outPath] = args;
  if (!modelPath || !outPath) {
    console.error('usage: cpr-write.mjs <model.json> <out.cpr> [--donor <donor.cpr>]');
    process.exit(1);
  }
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const out = writeCpr(model, donor);
  fs.writeFileSync(outPath, out);
  console.log(`wrote ${outPath}: ${out.stats.bytes} bytes (donor ${out.stats.donorBytes}), ` +
    `${out.stats.tracks} tracks, ${out.stats.parts} parts, ${out.stats.notes} notes, ` +
    `${out.stats.healedRefs} donor back-refs healed to full defs`);
}
