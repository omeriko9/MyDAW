#!/usr/bin/env node
// cpr-analyze.mjs — Cubase .cpr reverse-engineering / debug tool.
//
// Container: "RIFF" u32be totalSize, form "NUND", then chunks [4cc][u32be size][data]
//            (NO even-padding between chunks). Pairs: ROOT (names the archive:
//            two strings, len-prefixed WITHOUT nul) then ARCH (serialized object tree).
//
// ARCH record grammar (empirically verified 2004..2026):
//   first occurrence of a class:
//     [FFFFFFFE u32len "Base\0" u16ver]*  FFFFFFFF u32len "Class\0" u16ver  u32size data[size]
//   later occurrences:
//     u32 (0x80000000 | id)  u32size  data[size]          (no marker, no version)
//   id of a name = offset_of_its_u32len_field - (archDataOff + 4)
//   size = exact byte length of data (nested child records included).
//   Strings inside data: u32be len (incl. NUL) + chars + NUL.
//
// Usage: node scripts/cpr-analyze.mjs <file.cpr> <cmd> [args]
//   chunks                     list RIFF chunks
//   strings [minlen]           scan ARCH chunks for length-prefixed names
//   refs                       scan for u32 >= 0x80000000 back-ref candidates
//   hex <hexoff> <hexlen>      hex dump at absolute file offset
//   tree [depth] [gapBytes] [archIdx]   structural tree of ARCH chunk(s)
//   rec <Class> [max] [archIdx]         full hexdump of data of each instance of Class

import fs from 'node:fs';

const [, , file, cmd = 'chunks', ...args] = process.argv;
if (!file) { console.error('usage: cpr-analyze.mjs <file.cpr> <cmd> [args]'); process.exit(1); }
const buf = fs.readFileSync(file);

export function parseContainer(b) {
  if (b.toString('latin1', 0, 4) !== 'RIFF') throw new Error('not RIFF');
  const riffSize = b.readUInt32BE(4);
  const form = b.toString('latin1', 8, 12); // 'NUND'
  const chunks = [];
  let p = 12;
  while (p + 8 <= 12 + riffSize && p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4);
    const size = b.readUInt32BE(p + 4);
    chunks.push({ id, size, dataOff: p + 8 });
    p += 8 + size;
  }
  return { riffSize, form, chunks };
}

function isNameChar(c) { return c >= 0x20 && c < 0x7f; }

// ---- generic ARCH walker -------------------------------------------------
// Returns flat list of records {name, ver, hdrOff, dataStart, dataEnd, depth, ref, chain}
export function walkArch(b, archOff, archSize, opts = {}) {
  const base = archOff + 4;
  const end = archOff + archSize;
  const names = new Map();
  const records = [];

  function readName(p) {
    if (p + 4 > end) return null;
    const len = b.readUInt32BE(p);
    if (len < 2 || len > 100 || p + 4 + len + 2 > end) return null;
    if (b[p + 4 + len - 1] !== 0) return null;
    for (let j = 0; j < len - 1; j++) if (!isNameChar(b[p + 4 + j])) return null;
    return { name: b.toString('latin1', p + 4, p + 4 + len - 1), ver: b.readUInt16BE(p + 4 + len), id: p - base, next: p + 4 + len + 2 };
  }

  function tryHeader(p, parentEnd) {
    if (p + 8 > parentEnd) return null;
    const v = b.readUInt32BE(p);
    if (v === 0xfffffffe) {
      let q = p; const chain = [];
      while (q + 4 <= parentEnd && b.readUInt32BE(q) === 0xfffffffe) {
        const w = b.readUInt32BE(q + 4);
        if (w >= 0x80000000 && w !== 0xfffffffe && w !== 0xffffffff) {
          const id = w - 0x80000000;
          if (!names.has(id)) return null;
          chain.push(names.get(id).name); q += 8;
        } else {
          const n = readName(q + 4);
          if (!n) return null;
          names.set(n.id, { name: n.name, ver: n.ver });
          chain.push(n.name); q = n.next;
        }
      }
      if (q + 4 > parentEnd || b.readUInt32BE(q) !== 0xffffffff) return null;
      const r = tryHeader(q, parentEnd);
      if (!r) return null;
      r.chain = chain;
      return r;
    }
    if (v === 0xffffffff) {
      const n = readName(p + 4);
      if (!n || n.next + 4 > parentEnd) return null;
      const size = b.readUInt32BE(n.next);
      if (n.next + 4 + size > parentEnd) return null;
      names.set(n.id, { name: n.name, ver: n.ver });
      return { name: n.name, ver: n.ver, dataStart: n.next + 4, dataEnd: n.next + 4 + size, ref: false };
    }
    if (v >= 0x80000000) {
      const id = v - 0x80000000;
      if (!names.has(id) || p + 8 > parentEnd) return null;
      const size = b.readUInt32BE(p + 4);
      if (p + 8 + size > parentEnd) return null;
      const e = names.get(id);
      return { name: e.name, ver: e.ver, dataStart: p + 8, dataEnd: p + 8 + size, ref: true };
    }
    return null;
  }

  function walk(s, e, depth) {
    let p = s, gapStart = s;
    while (p < e) {
      const h = tryHeader(p, e);
      if (h) {
        if (gapStart < p) records.push({ name: '[raw]', hdrOff: gapStart, dataStart: gapStart, dataEnd: p, depth });
        records.push({ ...h, hdrOff: p, depth });
        if (h.dataEnd > h.dataStart) walk(h.dataStart, h.dataEnd, depth + 1);
        p = h.dataEnd; gapStart = p;
      } else p++;
    }
    if (gapStart < e) records.push({ name: '[raw]', hdrOff: gapStart, dataStart: gapStart, dataEnd: e, depth });
  }
  walk(archOff, end, 0);
  records.names = names; // id -> {name, ver}; id = lenFieldOff - (archOff+4)
  return records;
}

// Decode one event from a MMidiPart event stream at offset p.
// Two encodings: compact (u8 statusTag + fixed layout) and record-form
// (u8 0x00 + [ref|name header] + u32 size + same layout minus the tag byte).
export function readStreamEvent(b, p, names, base) {
  let tag = b[p], body, next, recName = null;
  if (tag === 0x00) {
    let q = p + 1;
    let v = b.readUInt32BE(q);
    while (v === 0xfffffffe) { // base-class decls (name or ref)
      const w = b.readUInt32BE(q + 4);
      if (w >= 0x80000000) q += 8;
      else q += 8 + b.readUInt32BE(q + 4) + 2;
      v = b.readUInt32BE(q);
    }
    if (v === 0xffffffff) {
      const len = b.readUInt32BE(q + 4);
      recName = b.toString('latin1', q + 8, q + 8 + len - 1);
      q += 8 + len + 2;
    } else if (v >= 0x80000000) {
      recName = names.get(v - 0x80000000)?.name ?? '?';
      q += 4;
    } else return null;
    const size = b.readUInt32BE(q);
    body = q + 4; next = q + 4 + size;
    tag = recName === 'MMidiNote' ? 0x90 :
      recName === 'MMidiController' ? 0xb0 : recName === 'MMidiPitchBend' ? 0xe0 :
      recName === 'MMidiProgramChange' ? 0xc0 : recName === 'MMidiAfterTouch' ? 0xd0 :
      recName === 'MMidiPolyPressure' ? 0xa0 : recName === 'MMidiSysex' ? 0xf0 : -1;
    if (tag === -1) return { kind: 'unknownRecord', recName, next };
  } else body = p + 1;
  if (tag === 0x90) {
    const nExt = b.readUInt16BE(body + 15);
    const q = body + 17 + 14 * nExt;
    if (next === undefined) next = q + 25;
    return { kind: 'note', tick: b.readDoubleBE(body), ch: b[body + 8], pitch: b[body + 9], vel: b[body + 10], len: b.readDoubleBE(q), next };
  }
  if (tag === 0xa0 || tag === 0xb0 || tag === 0xc0 || tag === 0xd0 || tag === 0xe0) {
    const nExt = b.readUInt16BE(body + 15);
    if (next === undefined) next = body + 17 + 14 * nExt;
    return { kind: 'short', tag, tick: b.readDoubleBE(body), ch: b[body + 8], d1: b[body + 9], d2: b[body + 10], next };
  }
  return null;
}

export function hexdump(b, off, len, print = console.log) {
  const end = Math.min(off + len, b.length);
  for (let i = off; i < end; i += 16) {
    const slice = b.subarray(i, Math.min(i + 16, end));
    const hex = [...slice].map((x, k) => x.toString(16).padStart(2, '0') + (k % 2 ? ' ' : '')).join('');
    const asc = [...slice].map(x => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
    print(i.toString(16).padStart(8, '0') + '  ' + hex.padEnd(40) + ' ' + asc);
  }
}

const cont = parseContainer(buf);
const arches = cont.chunks.filter(c => c.id === 'ARCH');

if (cmd === 'chunks') {
  console.log(`form=${cont.form} riffSize=${cont.riffSize} fileSize=${buf.length}`);
  for (const c of cont.chunks) {
    let extra = '';
    if (c.id === 'ROOT') {
      let p = c.dataOff; const parts = [];
      while (p + 4 <= c.dataOff + c.size) {
        const l = buf.readUInt32BE(p);
        if (l > 256) break;
        parts.push(buf.toString('latin1', p + 4, p + 4 + l));
        p += 4 + l;
      }
      extra = ' :: ' + parts.join(' | ');
    }
    console.log(`${c.id} off=0x${c.dataOff.toString(16)} size=0x${c.size.toString(16)} (${c.size})${extra}`);
  }
} else if (cmd === 'strings') {
  const minLen = args[0] ? parseInt(args[0]) : 2;
  for (const c of arches) {
    for (let i = c.dataOff; i + 4 < c.dataOff + c.size; i++) {
      const len = buf.readUInt32BE(i);
      if (len < minLen || len > 200 || i + 4 + len > c.dataOff + c.size) continue;
      if (buf[i + 4 + len - 1] !== 0) continue;
      let ok = len > 1;
      for (let j = 0; j < len - 1; j++) if (!isNameChar(buf[i + 4 + j])) { ok = false; break; }
      if (ok) console.log(`0x${i.toString(16)}\t${buf.toString('latin1', i + 4, i + 4 + len - 1)}`);
    }
  }
} else if (cmd === 'refs') {
  for (const c of arches) {
    for (let i = c.dataOff; i + 4 <= c.dataOff + c.size; i++) {
      const v = buf.readUInt32BE(i);
      if (v >= 0x80000000 && v < 0x80000000 + buf.length && v !== 0xfffffffe && v !== 0xffffffff)
        console.log(`0x${i.toString(16)}\tref=0x${(v - 0x80000000).toString(16)}`);
    }
  }
} else if (cmd === 'hex') {
  hexdump(buf, parseInt(args[0], 16), parseInt(args[1] ?? '100', 16));
} else if (cmd === 'around') {
  const needle = Buffer.from(args[0], 'latin1');
  const max = args[1] ? parseInt(args[1]) : 5;
  const win = args[2] ? parseInt(args[2]) : 96;
  let idx = 0, count = 0;
  while ((idx = buf.indexOf(needle, idx)) !== -1 && count < max) {
    console.log(`--- occurrence at 0x${idx.toString(16)} ---`);
    hexdump(buf, Math.max(0, idx - 16), win);
    idx += needle.length; count++;
  }
} else if (cmd === 'tree') {
  const maxDepth = args[0] ? parseInt(args[0]) : 99;
  const gapBytes = args[1] ? parseInt(args[1]) : 24;
  const filtIdx = args[2] !== undefined ? parseInt(args[2]) : -1;
  arches.forEach((c, i) => {
    if (filtIdx >= 0 && i !== filtIdx) return;
    console.log(`### ARCH[${i}] off=0x${c.dataOff.toString(16)} size=0x${c.size.toString(16)}`);
    for (const r of walkArch(buf, c.dataOff, c.size)) {
      if (r.depth >= maxDepth) continue;
      const ind = '  '.repeat(r.depth);
      if (r.name === '[raw]') {
        const n = Math.min(gapBytes, r.dataEnd - r.dataStart);
        let h = [...buf.subarray(r.dataStart, r.dataStart + n)].map(x => x.toString(16).padStart(2, '0')).join(' ');
        if (r.dataEnd - r.dataStart > n) h += ` ...(+${r.dataEnd - r.dataStart - n})`;
        console.log(`${ind}[raw ${r.dataEnd - r.dataStart}B @0x${r.dataStart.toString(16)}] ${h}`);
      } else {
        console.log(`${ind}${r.name} v${r.ver} @0x${r.hdrOff.toString(16)} data=0x${r.dataStart.toString(16)}+${r.dataEnd - r.dataStart}${r.chain ? ' :' + r.chain.join('<') : ''}${r.ref ? ' (ref)' : ''}`);
      }
    }
  });
} else if (cmd === 'rec') {
  const cls = args[0];
  const max = args[1] ? parseInt(args[1]) : 8;
  const filtIdx = args[2] !== undefined ? parseInt(args[2]) : -1;
  let count = 0;
  arches.forEach((c, i) => {
    if (filtIdx >= 0 && i !== filtIdx) return;
    for (const r of walkArch(buf, c.dataOff, c.size)) {
      if (r.name !== cls) continue;
      count++;
      if (count > max) continue;
      console.log(`--- ${r.name} v${r.ver} ARCH[${i}] @0x${r.hdrOff.toString(16)} data=0x${r.dataStart.toString(16)} size=${r.dataEnd - r.dataStart}`);
      hexdump(buf, r.dataStart, Math.min(r.dataEnd - r.dataStart, 512));
    }
  });
  console.log(`total ${count} instance(s)`);
} else if (cmd === 'parts') {
  // Extract MIDI parts + decode their event streams.
  // MMidiPartEvent v2 data: u16, f64 startTick, f64 lengthTicks, f64 offsetTick, then MMidiPart record.
  // MMidiPart v2 data: lpstr name, u32 a, u32 b, u32 c, u32 eventCount, u8 nRegistry,
  //                    nRegistry empty class records, then eventCount tagged events.
  // Event: u8 tag (MIDI status nibble style); note=0x90:
  //   f64 start, u8 ch, u8 pitch, u8 vel, u32 ?, u16 nExt, nExt*{4cc,u16,u8[8]},
  //   f64 length, f64 q, u8[8], u8     (= 43 + 14*nExt bytes)
  const verbose = args[0] === '-v';
  const maxEv = args[1] ? parseInt(args[1]) : 10;
  arches.forEach((c, ai) => {
    const recs = walkArch(buf, c.dataOff, c.size);
    for (const r of recs) {
      if (r.name !== 'MMidiPartEvent') continue;
      const d = r.dataStart;
      const u16 = buf.readUInt16BE(d);
      const start = buf.readDoubleBE(d + 2), length = buf.readDoubleBE(d + 10), offset = buf.readDoubleBE(d + 18);
      // find nested MMidiPart record (first child record at d+26)
      const part = recs.find(x => x.name === 'MMidiPart' && x.hdrOff >= d + 26 && x.hdrOff < r.dataEnd);
      console.log(`ARCH[${ai}] MMidiPartEvent v${r.ver} @0x${r.hdrOff.toString(16)} u16=${u16} start=${start} len=${length} offset=${offset}`);
      if (!part) { console.log('  !! no MMidiPart found'); continue; }
      let p = part.dataStart;
      const nameLen = buf.readUInt32BE(p);
      const pname = buf.toString('latin1', p + 4, p + 4 + nameLen - 1);
      p += 4 + nameLen;
      const a = buf.readUInt32BE(p), b = buf.readUInt32BE(p + 4), c2 = buf.readUInt32BE(p + 8), evCount = buf.readUInt32BE(p + 12);
      p += 16;
      let nReg = 0;
      if (evCount > 0) { nReg = buf[p]; p += 1; } // registry-count byte absent when part is empty
      // skip registry records
      for (let i = 0; i < nReg; i++) {
        const v = buf.readUInt32BE(p);
        if (v === 0xfffffffe || v === 0xffffffff) {
          // skip chain decls then concrete header
          while (buf.readUInt32BE(p) === 0xfffffffe) {
            const w = buf.readUInt32BE(p + 4);
            if (w >= 0x80000000) p += 8;
            else p += 4 + 4 + buf.readUInt32BE(p + 4) + 2;
          }
          // ffffffff
          const w = buf.readUInt32BE(p + 4);
          if (w >= 0x80000000) p += 4 + 4 + 4 + buf.readUInt32BE(p + 8);
          else { const l = buf.readUInt32BE(p + 4); const sz = buf.readUInt32BE(p + 4 + 4 + l + 2); p += 4 + 4 + l + 2 + 4 + sz; }
        } else if (v >= 0x80000000) { p += 8 + buf.readUInt32BE(p + 4); }
        else { console.log(`  !! registry parse fail @0x${p.toString(16)}`); break; }
      }
      console.log(`  part "${pname}" a=${a} b=0x${b.toString(16)} c=0x${c2.toString(16)} events=${evCount} nReg=${nReg} stream=0x${p.toString(16)}..0x${part.dataEnd.toString(16)}`);
      const tags = {};
      let shown = 0, ok = true;
      for (let i = 0; i < evCount; i++) {
        if (p >= part.dataEnd) { console.log(`  !! stream overrun at event ${i}`); ok = false; break; }
        const ev = readStreamEvent(buf, p, recs.names, c.dataOff + 4);
        if (!ev) {
          console.log(`  !! unknown tag 0x${buf[p].toString(16)} at event ${i} @0x${p.toString(16)}:`);
          hexdump(buf, p, 96);
          ok = false; break;
        }
        const key = ev.kind === 'note' ? '90' : ev.kind === 'short' ? ev.tag.toString(16) : ev.recName;
        tags[key] = (tags[key] || 0) + 1;
        if (verbose && shown < maxEv) {
          if (ev.kind === 'note') console.log(`    note t=${ev.tick} ch=${ev.ch} p=${ev.pitch} v=${ev.vel} len=${ev.len}`);
          else if (ev.kind === 'short') console.log(`    ev${ev.tag.toString(16)} t=${ev.tick} ch=${ev.ch} d1=${ev.d1} d2=${ev.d2}`);
          else console.log(`    record ${ev.recName}`);
          shown++;
        }
        p = ev.next;
      }
      if (ok) console.log(`  stream end=0x${p.toString(16)} partEnd=0x${part.dataEnd.toString(16)} ${p === part.dataEnd ? 'EXACT' : 'DIFF ' + (part.dataEnd - p)} tags=${JSON.stringify(tags)}`);
    }
  });
} else if (cmd === 'tracks') {
  // Track list: order, kind, name, nesting; counts of parts/audio events per track.
  // String rule: lpstr = u32 len + bytes; text = bytes up to NUL;
  //   if bytes after NUL begin EF BB BF -> UTF-8, else ANSI (cp1255 for this user's Hebrew).
  const cp1255 = b => [...b].map(x => x >= 0xe0 && x <= 0xfa ? String.fromCharCode(0x5d0 + x - 0xe0) : String.fromCharCode(x)).join('');
  function lpstr(p) {
    const len = buf.readUInt32BE(p);
    if (len === 0) return { text: '', next: p + 4 };
    const bytes = buf.subarray(p + 4, p + 4 + len);
    const nul = bytes.indexOf(0);
    const core = nul >= 0 ? bytes.subarray(0, nul) : bytes;
    const isUtf8 = nul >= 0 && bytes.length >= nul + 4 && bytes[nul + 1] === 0xef && bytes[nul + 2] === 0xbb && bytes[nul + 3] === 0xbf;
    return { text: isUtf8 ? core.toString('utf8') : cp1255(core), next: p + 4 + len };
  }
  arches.forEach((c, ai) => {
    const recs = walkArch(buf, c.dataOff, c.size);
    const tl = recs.find(r => r.name === 'MTrackList');
    if (!tl) return;
    console.log(`### ARCH[${ai}]`);
    // containment-based hierarchy (robust against scanner false positives skewing depths)
    const isTrack = r => (r.name.endsWith('TrackEvent') && r.name !== 'MTempoTrackEvent' && r.name !== 'MSignatureTrackEvent' && r.name !== 'MAutomationTrackEvent') || r.name === 'MFolderTrack';
    const trackRecs = recs.filter(r => isTrack(r) && r.hdrOff >= tl.dataStart && r.dataEnd <= tl.dataEnd)
      .sort((x, y) => x.hdrOff - y.hdrOff);
    function listTracks(rangeStart, rangeEnd, indent) {
      let pos = rangeStart;
      for (const k of trackRecs) {
        if (k.hdrOff < pos || k.dataEnd > rangeEnd) continue;
        const inside = recs.filter(r => r.hdrOff > k.dataStart && r.dataEnd <= k.dataEnd);
        let name = '?';
        const nodes = inside.filter(r => r.name === 'MListNode' || r.name === 'MTrackList').sort((x, y) => x.hdrOff - y.hdrOff);
        if (nodes.length) name = lpstr(nodes[0].dataStart).text;
        const parts = inside.filter(r => r.name === 'MMidiPartEvent').length;
        const audio = inside.filter(r => r.name === 'MAudioEvent' || r.name === 'MAudioPartEvent').length;
        const autom = inside.filter(r => r.name === 'MAutomationTrackEvent').length;
        console.log(`${indent}${k.name} v${k.ver} @0x${k.hdrOff.toString(16)} "${name}" midiParts=${parts} audioEvents=${audio} autom=${autom}`);
        if (k.name === 'MFolderTrack') listTracks(k.dataStart, k.dataEnd, indent + '  ');
        pos = k.dataEnd;
      }
    }
    listTracks(tl.dataStart, tl.dataEnd, '');
  });
} else if (cmd === 'summary') {
  // Full project extraction as JSON: app version, tempo, signatures, tracks/parts/notes, audio events+clips.
  const cp1255 = b => [...b].map(x => x >= 0xe0 && x <= 0xfa ? String.fromCharCode(0x5d0 + x - 0xe0) : String.fromCharCode(x)).join('');
  function lpstr(p) {
    const len = buf.readUInt32BE(p);
    if (len === 0 || len > 4096) return { text: '', next: p + 4 };
    const bytes = buf.subarray(p + 4, p + 4 + len);
    const nul = bytes.indexOf(0);
    const core = nul >= 0 ? bytes.subarray(0, nul) : bytes;
    const isUtf8 = nul >= 0 && bytes.length >= nul + 4 && bytes[nul + 1] === 0xef && bytes[nul + 2] === 0xbb && bytes[nul + 3] === 0xbf;
    return { text: isUtf8 ? core.toString('utf8') : cp1255(core), next: p + 4 + len };
  }
  const out = { file, app: null, tempo: null, signatures: [], tracks: [] };

  // app version
  {
    const i = buf.indexOf(Buffer.from('PAppVersion\0', 'latin1'));
    if (i >= 0) {
      let p = i + 12 + 2 + 4;
      const a = lpstr(p), v = lpstr(a.next);
      out.app = a.text + ' ' + v.text;
    }
  }

  const arr = arches.map((c, i) => ({ c, i })).find(({ c }) => {
    const r = walkArch(buf, c.dataOff, c.size, {});
    return r.some(x => x.name === 'MTrackList');
  });
  if (!arr) { console.log(JSON.stringify(out)); process.exit(0); }
  const recs = walkArch(buf, arr.c.dataOff, arr.c.size);
  const base = arr.c.dataOff + 4;

  // tempo: first MTempoTrackEvent
  const te = recs.find(r => r.name === 'MTempoTrackEvent');
  if (te) {
    let p = te.dataStart;
    const n = buf.readUInt32BE(p); p += 4;
    const points = [];
    for (let i = 0; i < n; i++) {
      const spq = buf.readFloatBE(p), time = buf.readDoubleBE(p + 4), tick = buf.readDoubleBE(p + 12), type = buf.readUInt16BE(p + 20);
      points.push({ tick, bpm: +(60 / spq).toFixed(3), timeSec: +time.toFixed(3), type });
      p += 22;
    }
    const fixedBpm = buf.readFloatBE(p), flag = buf.readUInt16BE(p + 4);
    out.tempo = { points, fixedBpm, fixedMode: flag === 1 };
  }
  // signature: first MSignatureTrackEvent
  const se = recs.find(r => r.name === 'MSignatureTrackEvent');
  if (se) {
    let p = se.dataStart;
    const n = buf.readUInt32BE(p); p += 4;
    for (let i = 0; i < n; i++) {
      out.signatures.push({ tick: buf.readUInt32BE(p), num: buf.readUInt16BE(p + 4), den: buf.readUInt16BE(p + 6) });
      p += 16;
    }
  }

  // clip map: PAudioClip dataStart-id -> {name, path}
  const clips = new Map();
  function parseClip(r) {
    if (clips.has(r.dataStart - base)) return clips.get(r.dataStart - base);
    const name = lpstr(r.dataStart).text;
    let path = null;
    const fnp = recs.find(x => x.name === 'FNPath' && x.hdrOff > r.dataStart && x.dataEnd <= r.dataEnd);
    if (fnp) {
      const fname = lpstr(fnp.dataStart).text;
      let dir = '';
      for (let p = fnp.dataStart; p < fnp.dataEnd - 8; p++) {
        const len = buf.readUInt32BE(p);
        if (len > 4 && len < 300 && p + 4 + len <= fnp.dataEnd && buf[p + 4 + len - 1] !== undefined) {
          const s = lpstr(p).text;
          if (/^[A-Za-z]:[\\/]/.test(s)) { dir = s; }
        }
      }
      path = dir + fname;
    }
    const info = { name, path };
    clips.set(r.dataStart - base, info);
    return info;
  }
  recs.filter(r => r.name === 'PAudioClip').forEach(parseClip);

  function parseMidiPartEvent(r) {
    const d = r.dataStart;
    const part = { start: buf.readDoubleBE(d + 2), length: buf.readDoubleBE(d + 10), offset: buf.readDoubleBE(d + 18) };
    const mp = recs.find(x => x.name === 'MMidiPart' && x.hdrOff >= d + 26 && x.hdrOff < r.dataEnd);
    if (!mp) return part;
    let p = mp.dataStart;
    const nm = lpstr(p); part.name = nm.text; p = nm.next;
    const evCount = buf.readUInt32BE(p + 12);
    p += 16;
    let nReg = 0;
    if (evCount > 0) { nReg = buf[p]; p += 1; }
    for (let i = 0; i < nReg; i++) {
      const v = buf.readUInt32BE(p);
      if (v === 0xfffffffe || v === 0xffffffff) {
        while (buf.readUInt32BE(p) === 0xfffffffe) {
          const w = buf.readUInt32BE(p + 4);
          p = w >= 0x80000000 ? p + 8 : p + 4 + 4 + buf.readUInt32BE(p + 4) + 2;
        }
        const w = buf.readUInt32BE(p + 4);
        if (w >= 0x80000000) p += 12 + buf.readUInt32BE(p + 8);
        else { const l = buf.readUInt32BE(p + 4); p += 4 + 4 + l + 2 + 4 + buf.readUInt32BE(p + 4 + 4 + l + 2); }
      } else if (v >= 0x80000000) p += 8 + buf.readUInt32BE(p + 4);
    }
    part.notes = 0; part.cc = 0; part.bend = 0; part.other = 0; part.firstNotes = [];
    for (let i = 0; i < evCount; i++) {
      const ev = readStreamEvent(buf, p, recs.names, base);
      if (!ev) { part.parseError = `tag 0x${buf[p].toString(16)} @0x${p.toString(16)} ev ${i}`; break; }
      if (ev.kind === 'note') {
        if (part.firstNotes.length < 8) part.firstNotes.push([+ev.tick.toFixed(1), ev.pitch, ev.vel, +ev.len.toFixed(1), ev.ch]);
        part.notes++;
      } else if (ev.kind === 'short') {
        if (ev.tag === 0xb0) part.cc++; else if (ev.tag === 0xe0) part.bend++; else part.other++;
      } else part.other++;
      p = ev.next;
    }
    return part;
  }

  function parseAudioEvent(r) {
    const d = r.dataStart;
    const ev = { start: buf.readDoubleBE(d + 2), lengthSamples: buf.readDoubleBE(d + 10), offsetSamples: buf.readDoubleBE(d + 18) };
    // clip: embedded record or u32 id at d+26
    const v = buf.readUInt32BE(d + 26);
    let clip = null;
    if (v < 0x80000000) clip = clips.get(v) || null;
    else {
      const cr = recs.find(x => x.name === 'PAudioClip' && x.hdrOff >= d + 26 && x.dataEnd <= r.dataEnd);
      if (cr) clip = parseClip(cr);
    }
    if (clip) { ev.clip = clip.name; ev.path = clip.path; }
    return ev;
  }

  const tl = recs.find(r => r.name === 'MTrackList');
  const isTrack = r => (r.name.endsWith('TrackEvent') && !['MTempoTrackEvent', 'MSignatureTrackEvent', 'MAutomationTrackEvent'].includes(r.name)) || r.name === 'MFolderTrack';
  const trackRecs = recs.filter(r => isTrack(r) && r.hdrOff >= tl.dataStart && r.dataEnd <= tl.dataEnd).sort((x, y) => x.hdrOff - y.hdrOff);
  const kindMap = { MMidiTrackEvent: 'midi', MInstrumentTrackEvent: 'instrument', MAudioTrackEvent: 'audio', MDeviceTrackEvent: 'device', MFolderTrack: 'folder', MPlayRangeTrackEvent: 'arranger', MVideoTrackEvent: 'video' };
  function listTracks(rangeStart, rangeEnd) {
    const res = [];
    let pos = rangeStart;
    for (const k of trackRecs) {
      if (k.hdrOff < pos || k.dataEnd > rangeEnd) continue;
      const inside = recs.filter(r => r.hdrOff > k.dataStart && r.dataEnd <= k.dataEnd);
      const t = { kind: kindMap[k.name] || k.name, name: '?' };
      const nodes = inside.filter(r => r.name === 'MListNode' || r.name === 'MTrackList').sort((x, y) => x.hdrOff - y.hdrOff);
      if (nodes.length) t.name = lpstr(nodes[0].dataStart).text;
      if (k.name === 'MFolderTrack') t.children = listTracks(k.dataStart, k.dataEnd);
      else {
        const parts = inside.filter(r => r.name === 'MMidiPartEvent').sort((x, y) => x.hdrOff - y.hdrOff).map(parseMidiPartEvent);
        if (parts.length) t.parts = parts;
        const aevs = inside.filter(r => r.name === 'MAudioEvent' || r.name === 'MAudioPartEvent').sort((x, y) => x.hdrOff - y.hdrOff).map(parseAudioEvent);
        if (aevs.length) t.audioEvents = aevs;
      }
      res.push(t);
      pos = k.dataEnd;
    }
    return res;
  }
  out.tracks = listTracks(tl.dataStart, tl.dataEnd);
  console.log(JSON.stringify(out, null, args[0] === '-c' ? 0 : 1));
} else {
  console.error('unknown cmd');
}
