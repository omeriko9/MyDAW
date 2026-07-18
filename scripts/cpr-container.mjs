#!/usr/bin/env node
// cpr-container.mjs — Cubase .cpr container-layer library: lossless parse -> tree,
// serialize(tree) -> byte-identical buffer. Foundation for the .cpr WRITER (M1).
//
// Container: "RIFF" u32be riffSize "NUND", then chunks [4cc][u32be size][data],
//   NO even-padding. NOTE: riffSize EXCLUDES the 4-byte form fourcc (riffSize =
//   fileSize - 12 on well-formed files) — non-standard RIFF.
// Chunks come in ROOT/ARCH pairs; ROOT data = two strings (u32be len + chars,
//   NO trailing NUL) naming the following ARCH: "name | className".
//
// ARCH object-stream grammar (validated 2004..2026; reference readers:
// scripts/cpr-analyze.mjs walkArch + engine/src/import/CprImportProvider.cpp):
//   first occurrence of a class:
//     [FFFFFFFE nameField(+u16 ver if full)]*  FFFFFFFF u32len "Class\0" u16 ver  u32 size  data
//   later occurrences:
//     u32 (0x80000000|id)  u32 size  data                (no marker, no version)
//   nameField: u32 len (incl. trailing NUL) + chars + NUL + u16 ver, OR
//              u32 (0x80000000|id) back-reference (4 bytes, NO version).
//   id of a name = byte offset of its u32 len field - (archDataOff + 4).
//   size = exact byte length of data (nested child records included).
//
// Losslessness strategy: everything the scanner does NOT positively recognize is
// kept verbatim as opaque `raw` spans. Everything it DOES recognize is stored
// symbolically and RECOMPUTED on serialize:
//   - riffSize, chunk sizes            recomputed from emitted payloads
//   - ROOT string lengths              recomputed from the string bytes
//   - record name lengths              recomputed from the class-name string
//   - record `size` fields             recomputed from emitted children
//   - back-ref ids                     recomputed from the actual emitted offset
//                                      of the referenced name's length field
// Back-ref targets that live inside raw spans (names registered by the scanner's
// speculative header attempts) are anchored as (node, delta) and recomputed from
// the node's emitted position, so upstream insertions shift them correctly.
//
// Usage as CLI: node scripts/cpr-container.mjs <file.cpr> [tree|streams|verify]

import fs from 'node:fs';

const MAX_NAME = 100;
const MAX_DEPTH = 96;

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

// opts.archLevel: 'records' (default) = full record/interning layer;
//                 'opaque'  = keep ARCH payloads as verbatim blobs (shallow).
export function parse(buf, opts = {}) {
  const archLevel = opts.archLevel ?? 'records';
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF')
    throw new Error('not RIFF');
  const form = buf.toString('latin1', 8, 12);
  if (form !== 'NUND')
    throw new Error(`not NUND (form=${JSON.stringify(form)})`);
  const origRiffSize = buf.readUInt32BE(4);

  const tree = { form, chunks: [], tail: Buffer.alloc(0), origRiffSize, riffSizeMode: 'computed' };

  // --- chunk layer ---
  const limit = Math.min(12 + origRiffSize, buf.length);
  let p = 12;
  while (p + 8 <= limit) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32BE(p + 4);
    if (p + 8 + size > buf.length) {
      // corrupt/truncated chunk: keep the rest verbatim, don't guess
      break;
    }
    tree.chunks.push({ id, dataOff: p + 8, size, data: buf.subarray(p + 8, p + 8 + size) });
    p += 8 + size;
  }
  tree.tail = buf.subarray(p); // leftover (<8 bytes inside riff region, or trailing garbage)

  // riffSize: recompute; if the file disagrees, remember the original verbatim
  const computed = computedRiffSize(tree);
  if (computed !== origRiffSize) tree.riffSizeMode = 'stored';

  // --- name each chunk / pair ROOT->ARCH ---
  for (let i = 0; i < tree.chunks.length; i++) {
    const c = tree.chunks[i];
    if (c.id === 'ROOT') {
      c.root = parseRoot(c.data);
      if (i + 1 < tree.chunks.length && tree.chunks[i + 1].id === 'ARCH' && c.root)
        tree.chunks[i + 1].streamName = c.root.parts.map(b => b.toString('latin1')).join('|');
    }
  }

  // --- ARCH record layer ---
  for (const c of tree.chunks) {
    if (c.id !== 'ARCH') continue;
    if (archLevel === 'records') c.arch = parseArch(buf, c.dataOff, c.size);
  }
  return tree;
}

// ROOT data = sequence of (u32be len + len bytes) strings covering the payload
// exactly (observed: always exactly two). Returns null when it doesn't parse
// cleanly -> caller keeps the chunk opaque.
function parseRoot(data) {
  const parts = [];
  let p = 0;
  while (p + 4 <= data.length) {
    const len = data.readUInt32BE(p);
    if (p + 4 + len > data.length) return null;
    parts.push(data.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  if (p !== data.length) return null;
  return { parts };
}

// --- ARCH object-stream walker ------------------------------------------------
// Faithful port of scripts/cpr-analyze.mjs walkArch (the validated reference),
// including its side effects: speculative header attempts register class names
// into the interning map even when the attempt ultimately fails. A later genuine
// back-ref may point at such a name, so the anchoring pass below must cover
// names living inside raw spans, not only recognized record headers.
//
// Node forms:
//   { t:'raw', bytes:Buffer, anchors:[{origId,delta}] }
//   { t:'rec', chain:[elem..]|null, cls:elem, children:[node..],
//     anchors:[{origId,delta}], hdrOff, dataStart, dataEnd }   (offsets for debug)
//   elem (full): { full:true, name:string(latin1), ver:u16, origId }
//   elem (ref):  { full:false, refOrigId }
function parseArch(buf, dataOff, size) {
  const base = dataOff + 4;
  const end = dataOff + size;
  const names = new Map(); // origId -> true (registration order irrelevant, offset is identity)
  const refIds = new Set(); // origIds actually referenced by recognized back-refs

  const isNameChar = c => c >= 0x20 && c < 0x7f;

  function readName(p) {
    if (p + 4 > end) return null;
    const len = buf.readUInt32BE(p);
    if (len < 2 || len > MAX_NAME || p + 4 + len + 2 > end) return null;
    if (buf[p + 4 + len - 1] !== 0) return null;
    for (let j = 0; j < len - 1; j++) if (!isNameChar(buf[p + 4 + j])) return null;
    return {
      name: buf.toString('latin1', p + 4, p + 4 + len - 1),
      ver: buf.readUInt16BE(p + 4 + len),
      id: p - base,
      next: p + 4 + len + 2,
    };
  }

  // Attempt to parse a record header at p. Returns
  // { chain, cls, dataStart, dataEnd } or null. Mirrors reference bounds exactly.
  function tryHeader(p, parentEnd) {
    if (p + 8 > parentEnd || p + 8 > buf.length) return null;
    const v = buf.readUInt32BE(p);
    if (v === 0xfffffffe) {
      let q = p;
      const chain = [];
      while (q + 8 <= buf.length && q + 4 <= parentEnd && buf.readUInt32BE(q) === 0xfffffffe) {
        const w = buf.readUInt32BE(q + 4);
        if (w >= 0x80000000 && w !== 0xfffffffe && w !== 0xffffffff) {
          const id = w - 0x80000000;
          if (!names.has(id)) return null;
          refIds.add(id);
          chain.push({ full: false, refOrigId: id });
          q += 8;
        } else {
          const n = readName(q + 4);
          if (!n) return null;
          names.set(n.id, true); // reference side effect: registered even if chain fails
          chain.push({ full: true, name: n.name, ver: n.ver, origId: n.id });
          q = n.next;
        }
      }
      if (q + 4 > parentEnd || q + 4 > buf.length || buf.readUInt32BE(q) !== 0xffffffff) return null;
      const r = tryHeader(q, parentEnd);
      if (!r) return null;
      r.chain = chain;
      return r;
    }
    if (v === 0xffffffff) {
      const n = readName(p + 4);
      if (!n || n.next + 4 > parentEnd) return null;
      const sz = buf.readUInt32BE(n.next);
      if (n.next + 4 + sz > parentEnd) return null;
      names.set(n.id, true);
      return {
        chain: null,
        cls: { full: true, name: n.name, ver: n.ver, origId: n.id },
        dataStart: n.next + 4, dataEnd: n.next + 4 + sz,
      };
    }
    if (v >= 0x80000000) {
      const id = v - 0x80000000;
      if (!names.has(id)) return null;
      const sz = buf.readUInt32BE(p + 4);
      if (p + 8 + sz > parentEnd) return null;
      refIds.add(id);
      return {
        chain: null,
        cls: { full: false, refOrigId: id },
        dataStart: p + 8, dataEnd: p + 8 + sz,
      };
    }
    return null;
  }

  function walk(s, e, depth) {
    const nodes = [];
    let p = s, gapStart = s;
    while (p < e) {
      const h = depth < MAX_DEPTH ? tryHeader(p, e) : null;
      if (h) {
        if (gapStart < p)
          nodes.push({ t: 'raw', start: gapStart, bytes: buf.subarray(gapStart, p), anchors: [] });
        nodes.push({
          t: 'rec', chain: h.chain, cls: h.cls,
          children: h.dataEnd > h.dataStart ? walk(h.dataStart, h.dataEnd, depth + 1) : [],
          anchors: [], hdrOff: p, dataStart: h.dataStart, dataEnd: h.dataEnd,
        });
        p = h.dataEnd;
        gapStart = p;
      } else p++;
    }
    if (gapStart < e)
      nodes.push({ t: 'raw', start: gapStart, bytes: buf.subarray(gapStart, e), anchors: [] });
    return nodes;
  }

  const nodes = walk(dataOff, end, 0);

  // --- anchor every referenced name definition to its containing atom ---
  // Atoms tile the payload: each rec's header span [hdrOff, dataStart) plus every
  // raw span. A name's length field sits at absolute offset base+origId; anchor
  // it as (node, delta from atom start) so serialize can recompute the id from
  // the atom's emitted position.
  const atoms = [];
  (function collect(list) {
    for (const n of list) {
      if (n.t === 'raw') atoms.push({ start: n.start, end: n.start + n.bytes.length, node: n });
      else { atoms.push({ start: n.hdrOff, end: n.dataStart, node: n }); collect(n.children); }
    }
  })(nodes);
  // atoms are in ascending, non-overlapping order by construction
  for (const origId of refIds) {
    const abs = base + origId;
    let lo = 0, hi = atoms.length - 1, found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (abs < atoms[mid].start) hi = mid - 1;
      else if (abs >= atoms[mid].end) lo = mid + 1;
      else { found = atoms[mid]; break; }
    }
    if (!found) throw new Error(`unanchorable back-ref target id=0x${origId.toString(16)}`);
    found.node.anchors.push({ origId, delta: abs - found.start });
  }

  return { nodes };
}

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

function computedRiffSize(tree) {
  let sz = 0;
  for (const c of tree.chunks) sz += 8 + chunkPayloadLength(c);
  return sz + tree.tail.length;
}

function chunkPayloadLength(c) {
  if (c.id === 'ARCH' && c.arch) return archLength(c.arch.nodes);
  if (c.id === 'ROOT' && c.root) {
    let n = 0;
    for (const part of c.root.parts) n += 4 + part.length;
    return n;
  }
  return c.data.length;
}

function elemLength(e, concrete) {
  // concrete full:  FFFFFFFF + len + name + NUL + ver          (marker included)
  // chain full:     FFFFFFFE + len + name + NUL + ver
  // concrete ref:   (0x80000000|id)                            (4 bytes, no marker)
  // chain ref:      FFFFFFFE + (0x80000000|id)
  if (e.full) return 4 + 4 + e.name.length + 1 + 2;
  return concrete ? 4 : 8;
}

function nodeLength(n) {
  if (n.t === 'raw') return n.bytes.length;
  let len = 0;
  if (n.chain) for (const e of n.chain) len += elemLength(e, false);
  len += elemLength(n.cls, true) + 4; // + u32 size field
  for (const ch of n.children) len += nodeLength(ch);
  return len;
}

function archLength(nodes) {
  let len = 0;
  for (const n of nodes) len += nodeLength(n);
  return len;
}

export function serialize(tree) {
  const total = 12 + computedRiffSize(tree);
  const out = Buffer.alloc(total);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32BE(tree.riffSizeMode === 'stored' ? tree.origRiffSize : total - 12, 4);
  out.write(tree.form, 8, 'latin1');
  let p = 12;
  for (const c of tree.chunks) {
    out.write(c.id, p, 'latin1');
    const payloadLen = chunkPayloadLength(c);
    out.writeUInt32BE(payloadLen, p + 4);
    p += 8;
    if (c.id === 'ARCH' && c.arch) p = emitArch(out, p, c.arch.nodes);
    else if (c.id === 'ROOT' && c.root) {
      for (const part of c.root.parts) {
        out.writeUInt32BE(part.length, p);
        part.copy(out, p + 4);
        p += 4 + part.length;
      }
    } else {
      c.data.copy(out, p);
      p += c.data.length;
    }
  }
  tree.tail.copy(out, p);
  p += tree.tail.length;
  if (p !== total) throw new Error(`serialize length mismatch: wrote ${p}, expected ${total}`);
  return out;
}

function emitArch(out, start, nodes) {
  // ids are relative to (archDataOff + 4); with payload-relative offset `rel`,
  // a length field emitted at rel has id = rel - 4.
  const newId = new Map(); // origId -> recomputed id
  let p = start;

  function emitElem(e, concrete) {
    if (e.full) {
      out.writeUInt32BE(concrete ? 0xffffffff : 0xfffffffe, p);
      out.writeUInt32BE(e.name.length + 1, p + 4);
      out.write(e.name, p + 8, 'latin1');
      out[p + 8 + e.name.length] = 0;
      out.writeUInt16BE(e.ver, p + 8 + e.name.length + 1);
      p += 4 + 4 + e.name.length + 1 + 2;
    } else {
      const id = newId.get(e.refOrigId);
      if (id === undefined) throw new Error(`back-ref to unemitted name id=0x${e.refOrigId.toString(16)}`);
      if (!concrete) { out.writeUInt32BE(0xfffffffe, p); p += 4; }
      out.writeUInt32BE((0x80000000 | id) >>> 0, p);
      p += 4;
    }
  }

  function emitNode(n) {
    // register anchored name definitions at their recomputed offsets first —
    // their bytes are about to be emitted as part of this atom, and any ref
    // to them occurs strictly later in the stream
    for (const a of n.anchors) newId.set(a.origId, (p - start) + a.delta - 4);
    if (n.t === 'raw') {
      n.bytes.copy(out, p);
      p += n.bytes.length;
      return;
    }
    if (n.chain) for (const e of n.chain) emitElem(e, false);
    emitElem(n.cls, true);
    const sizePos = p;
    p += 4;
    const dataStart = p;
    for (const ch of n.children) emitNode(ch);
    out.writeUInt32BE(p - dataStart, sizePos); // recomputed record size
  }

  for (const n of nodes) emitNode(n);
  return p;
}

// ---------------------------------------------------------------------------
// era detection (docs/CPR_MIXER_FORMAT.md §0)
// ---------------------------------------------------------------------------

// Returns { era: 'sx'|'c5'|'c12', app, version } (era 'unknown' if undecidable).
// 1. Authoritative: Version|PAppVersion record -> app + version strings.
// 2. Structural cross-checks: ComputerGuid|CmString chunk => c12;
//    Devices class FMemoryStream => sx, FAttributes => c5+.
export function detectEra(tree) {
  let app = '', version = '';
  for (const c of tree.chunks) {
    if (c.id !== 'ARCH' || c.streamName !== 'Version|PAppVersion') continue;
    // record data starts after "...FFFFFFFF [len]PAppVersion\0 [u16 ver] [u32 size]"
    const idx = c.data.indexOf(Buffer.from('PAppVersion\0', 'latin1'));
    if (idx < 0) continue;
    const s1 = lpstr(c.data, idx + 12 + 2 + 4);
    if (s1) {
      app = s1.text;
      const s2 = lpstr(c.data, s1.next);
      if (s2) version = s2.text;
    }
  }
  const hasGuid = tree.chunks.some(c => c.streamName === 'ComputerGuid|CmString');
  const devices = tree.chunks.find(c => c.streamName && c.streamName.startsWith('Devices|'));
  const devClass = devices ? devices.streamName.split('|')[1] : '';
  const major = (() => { const m = /(\d+)\./.exec(version); return m ? +m[1] : 0; })();

  let era = 'unknown';
  if (/\bS[XLE]\b/.test(app) || (major && major <= 3) || devClass === 'FMemoryStream') era = 'sx';
  else if (hasGuid || major >= 12) era = 'c12';
  else if (major >= 4 || devClass === 'FAttributes') era = 'c5';
  return { era, app, version };
}

function lpstr(data, p) {
  if (p + 4 > data.length) return null;
  const len = data.readUInt32BE(p);
  if (len === 0 || len > 4096 || p + 4 + len > data.length) return null;
  const bytes = data.subarray(p + 4, p + 4 + len);
  const nul = bytes.indexOf(0);
  return { text: bytes.subarray(0, nul >= 0 ? nul : bytes.length).toString('latin1'), next: p + 4 + len };
}

// ---------------------------------------------------------------------------
// stats / description helpers (used by the round-trip test's --deep report)
// ---------------------------------------------------------------------------

export function archStats(arch) {
  const s = { records: 0, fullNames: 0, backRefs: 0, sizeFields: 0, rawSpans: 0, rawBytes: 0, maxDepth: 0 };
  (function walk(list, depth) {
    for (const n of list) {
      if (n.t === 'raw') { s.rawSpans++; s.rawBytes += n.bytes.length; continue; }
      s.records++;
      s.sizeFields++;
      s.maxDepth = Math.max(s.maxDepth, depth);
      const elems = [...(n.chain ?? []), n.cls];
      for (const e of elems) e.full ? s.fullNames++ : s.backRefs++;
      walk(n.children, depth + 1);
    }
  })(arch.nodes, 1);
  return s;
}

export function describe(tree) {
  return tree.chunks.map(c => ({
    id: c.id,
    stream: c.streamName ?? (c.root ? c.root.parts.map(b => b.toString('latin1')).join('|') : ''),
    size: chunkPayloadLength(c),
    layer: c.id === 'ARCH' ? (c.arch ? 'records' : 'opaque') : c.id === 'ROOT' ? (c.root ? 'strings' : 'opaque') : 'opaque',
    stats: c.arch ? archStats(c.arch) : null,
  }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const [, , file, cmd = 'verify'] = process.argv;
  if (!file) { console.error('usage: cpr-container.mjs <file.cpr> [streams|verify]'); process.exit(1); }
  const buf = fs.readFileSync(file);
  const tree = parse(buf);
  if (cmd === 'streams') {
    console.log(JSON.stringify({ era: detectEra(tree), streams: describe(tree) }, null, 1));
  } else if (cmd === 'verify') {
    const out = serialize(tree);
    const diff = firstDiff(buf, out);
    if (diff < 0) console.log(`PASS ${buf.length} bytes byte-identical (era=${detectEra(tree).era})`);
    else { console.log(`FAIL first diff @0x${diff.toString(16)}`); process.exit(1); }
  }
}

export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
