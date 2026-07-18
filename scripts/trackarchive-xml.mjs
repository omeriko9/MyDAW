#!/usr/bin/env node
// trackarchive-xml.mjs — Cubase "Track Archive" XML oracle for mixer-import validation.
//
// A Track Archive (.xml, File > Export > Selected Tracks) is the LABELED twin of the
// .cpr binary attr-tree: identical class names, member names and IDs, but human-readable.
// We use it as ground truth for the .cpr mixer importer (channel Volume / Pan / EQ / sends).
//
// Per audio/instrument track we emit the channel-strip values that live in
//   <obj class="M{Instrument,Audio}Track" name="Track Device"> (Device Name "VST Multitrack")
//     <member name="DeviceAttributes">
//        <member name="Volume"> <float Value> <float AnchorValue=dB> </member>
//        [<member name="Pan"> <int Value> <int Min=-64> <int Max=63> </member>]   // omitted = center
//        <member name="EQ"> <int Bypass> <list Band>{<int Enable>,...} </member>
//        <member name="SendFolder"> <list Slot>{ <Volume>, <Output>, <int OldOn> } </member>
//
// IMPORTANT: this is a deliberately small, dependency-free XML reader tuned to the Cubase
// Track Archive grammar (obj / member / list / int / float / string / bin / item). It is a
// validation oracle, not a general XML parser.
//
// Usage:
//   node scripts/trackarchive-xml.mjs <tracks.xml> [--json]
//
// Output: one row per audio/instrument track:
//   { name, volumeDb, pan, eqEnabled, sendCount, activeSendCount }
//     volumeDb        channel-strip Volume.AnchorValue (dB).   linear = 10^(dB/20)
//     pan             channel-strip Pan.Value (raw int -64..63) or null when the Pan member
//                     is absent (= centre). MyDAW pan = v<0 ? v/64 : v/63 (clamped [-1,1]).
//     eqEnabled       true if EQ.Bypass==0 AND >=1 Band has Enable==1
//     sendCount       number of SendFolder slots present
//     activeSendCount slots with OldOn==1 (an actually-enabled send)

import fs from 'node:fs';
import { cubaseValueToDb } from './cpr-taper.mjs';

const [, , file, ...rest] = process.argv;
if (!file) {
  console.error('usage: trackarchive-xml.mjs <tracks.xml> [--json]');
  process.exit(1);
}
const asJson = rest.includes('--json');
const xml = fs.readFileSync(file, 'utf8');

// ---- minimal tokenizer over the Track Archive element grammar -----------------------------
// We build a lightweight DOM of nodes: { tag, attrs{}, children[] }. Self-closing and
// text-only <bin> elements are handled. Attribute values may contain XML entities.
function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let m;
  let lastEnd = 0;
  while ((m = tagRe.exec(text)) !== null) {
    const [, close, tag, attrStr, selfClose] = m;
    if (close) {
      // text content of leaf elements (the hex payload of <bin> blocks)
      const top = stack[stack.length - 1];
      if (top.children.length === 0 && top.text === undefined)
        top.text = text.slice(lastEnd, m.index).trim();
      if (stack.length > 1) stack.pop();
      lastEnd = tagRe.lastIndex;
      continue;
    }
    const attrs = {};
    const aRe = /([\w.-]+)\s*=\s*"([^"]*)"/g;
    let am;
    while ((am = aRe.exec(attrStr)) !== null) attrs[am[1]] = unescapeXml(am[2]);
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    lastEnd = tagRe.lastIndex;
  }
  return root;
}

// ---- helpers to query the DOM by Cubase conventions ---------------------------------------
const nameAttr = n => n.attrs.name;

// direct child <member name="X"> / <obj ...> / <int|float|string name="X">
function childByName(node, name) {
  return node.children.find(c => nameAttr(c) === name);
}
function childObjClass(node, cls) {
  return node.children.find(c => c.tag === 'obj' && c.attrs.class === cls);
}
function scalar(node) {
  // returns numeric/string value of an <int>/<float>/<string> element
  if (node == null) return null;
  if (node.tag === 'int') return parseInt(node.attrs.value, 10);
  if (node.tag === 'float') return Number(node.attrs.value);
  if (node.tag === 'string') return node.attrs.value;
  return null;
}
// <member name="Volume"><float name="Value"/><float name="AnchorValue"/></member>
function memberFloat(memberNode, field) {
  if (!memberNode) return null;
  const f = memberNode.children.find(c => nameAttr(c) === field);
  return f ? Number(f.attrs.value) : null;
}
function memberInt(memberNode, field) {
  if (!memberNode) return null;
  const f = memberNode.children.find(c => nameAttr(c) === field);
  return f ? parseInt(f.attrs.value, 10) : null;
}

// ---- find every channel-strip ("Track Device") record -------------------------------------
// A track's own channel strip is the <obj class="M*Track" name="Track Device"> whose
// Device Name == "VST Multitrack", carrying <member name="DeviceAttributes">.
// (Instrument-plugin OUTPUT channels also use this grammar but live under
//  "Synth Slot"/"Output Channel"; we anchor on name=="Track Device" to take only the
//  track's own strip — its Volume is the fader the user sees.)
function collectChannelStrips(root) {
  const out = [];
  (function walk(node) {
    if (node.tag === 'obj' &&
        node.attrs.name === 'Track Device' &&
        /^M(Instrument|Audio|Midi)Track$/.test(node.attrs.class || '')) {
      const devName = scalar(childByName(node, 'Device Name'));
      const da = childByName(node, 'DeviceAttributes');
      if (devName === 'VST Multitrack' && da) out.push({ device: node, da });
    }
    for (const c of node.children) walk(c);
  })(root);
  return out;
}

// The track display name: nearest enclosing M*TrackEvent's MListNode > Name.
// We capture it by walking the event tree top-down instead.
function collectTracks(root) {
  const tracks = [];
  (function walk(node) {
    if (node.tag === 'obj' && /^M(Instrument|Audio|Midi)TrackEvent$/.test(node.attrs.class || '')) {
      // name: <obj class="MListNode" name="Node"><string name="Name">
      let name = null;
      const node2 = node.children.find(c => c.tag === 'obj' && c.attrs.name === 'Node');
      if (node2) name = scalar(childByName(node2, 'Name'));
      // channel strip: the descendant Track Device w/ DeviceAttributes (VST Multitrack)
      let strip = null;
      (function find(n) {
        if (strip) return;
        if (n.tag === 'obj' && n.attrs.name === 'Track Device' &&
            /^M(Instrument|Audio|Midi)Track$/.test(n.attrs.class || '')) {
          const dn = scalar(childByName(n, 'Device Name'));
          const da = childByName(n, 'DeviceAttributes');
          if (dn === 'VST Multitrack' && da) { strip = { device: n, da }; return; }
        }
        for (const c of n.children) find(c);
      })(node);
      tracks.push({ kind: node.attrs.class, name, strip });
      return; // don't descend into nested track events (none expected, but be safe)
    }
    for (const c of node.children) walk(c);
  })(root);
  return tracks;
}

function describeStrip(da) {
  const volMember = childByName(da, 'Volume');
  const anchorDb = memberFloat(volMember, 'AnchorValue');
  const volumeValue = memberFloat(volMember, 'Value');
  // Effective fader dB. AnchorValue is authoritative when populated; Cubase 5 leaves it 0 and
  // stores the fader only in Value (25856 = 0 dB taper), so fall back to the CALIBRATED taper
  // (scripts/cpr-taper.mjs — piecewise-linear-in-gain, derived from 700+ modern Value/Anchor
  // pairs, NOT the old (Value/25856)^2 guess) when AnchorValue looks unpopulated (exactly 0
  // while Value is not the unity point). Mirrors the importer's applyModernVolume exactly.
  const anchorMeaningful = anchorDb != null &&
    (Math.abs(anchorDb) > 1e-4 || volumeValue == null || Math.abs(volumeValue - 25856) < 1);
  let volumeDb = anchorDb;
  if (!anchorMeaningful && volumeValue != null && volumeValue > 0)
    volumeDb = cubaseValueToDb(volumeValue);

  const panMember = childByName(da, 'Pan');
  const pan = panMember ? memberInt(panMember, 'Value') : null; // null = centre (member absent)

  // Standard Panner component blob (channel-level <member name="Panner"> >
  // <bin name="audioComponent">, 20 bytes LITTLE-endian): f32 pos (0 = hard L,
  // 0.5 = C, 1 = hard R; Cubase UI shows (pos-0.5)*200), f32 rightPos, u32 mode
  // (1 = factory default, 4 = engaged). Modern Cubase (13+) drops the Pan member and
  // stores the channel pan ONLY here (CPR_MIXER_FORMAT.md §5a — calibration fixtures
  // C:\Temp\cpr_stereo: L18 -> 0.410256, R85 -> 0.923077, R13 -> 0.564103).
  let panPos = null, panPos2 = null;
  const panner = childByName(da, 'Panner');
  if (panner) {
    const binNode = panner.children.find(c => c.tag === 'bin' && nameAttr(c) === 'audioComponent');
    const hex = (binNode?.text ?? '').replace(/[^0-9A-Fa-f]/g, '');
    if (hex.length >= 16) {
      const buf = Buffer.from(hex, 'hex');
      const f1 = buf.readFloatLE(0), f2 = buf.readFloatLE(4);
      if (Number.isFinite(f1) && f1 >= 0 && f1 <= 1 && Number.isFinite(f2) && f2 >= 0 && f2 <= 1) {
        panPos = f1;
        panPos2 = f2;
      }
    }
  }

  // Effective pan in MyDAW units (-1..1) — mirrors the importer's scanChannelPan: the
  // Panner blob wins when it agrees with Pan.Value (full f32 precision vs the 127-step
  // int) and when Pan.Value is absent; an explicit disagreeing Pan.Value wins.
  const rawNorm = pan == null ? null : Math.max(-1, Math.min(1, pan < 0 ? pan / 64 : pan / 63));
  const blobNorm = panPos == null ? null : Math.max(-1, Math.min(1, (panPos - 0.5) * 2));
  let panNorm = 0;
  if (rawNorm != null)
    panNorm = (blobNorm != null && Math.abs(blobNorm - rawNorm) <= 1.5 / 64) ? blobNorm : rawNorm;
  else if (blobNorm != null)
    panNorm = blobNorm;

  // EQ enabled = not bypassed AND at least one band enabled
  const eq = childByName(da, 'EQ');
  let eqEnabled = false;
  if (eq) {
    const bypass = memberInt(eq, 'Bypass') ?? 0;
    const bandList = eq.children.find(c => c.tag === 'list' && c.attrs.name === 'Band');
    const anyBand = bandList
      ? bandList.children.some(item => {
          const en = item.children.find(c => nameAttr(c) === 'Enable');
          return en && parseInt(en.attrs.value, 10) === 1;
        })
      : false;
    eqEnabled = bypass === 0 && anyBand;
  }

  // sends
  const sf = childByName(da, 'SendFolder');
  let sendCount = 0, activeSendCount = 0;
  const sendDestinations = [];
  if (sf) {
    const slotList = sf.children.find(c => c.tag === 'list' && c.attrs.name === 'Slot');
    if (slotList) {
      for (const item of slotList.children) {
        if (item.tag !== 'item') continue;
        sendCount++;
        const on = item.children.find(c => nameAttr(c) === 'OldOn');
        const onVal = on ? parseInt(on.attrs.value, 10) : 0;
        const outMember = item.children.find(c => nameAttr(c) === 'Output');
        const outVal = memberInt(outMember, 'Value');
        const sendVolMember = item.children.find(c => nameAttr(c) === 'Volume');
        const sendDb = memberFloat(sendVolMember, 'AnchorValue');
        if (onVal === 1) {
          activeSendCount++;
          sendDestinations.push({ output: outVal, levelDb: sendDb });
        }
      }
    }
  }

  return { name: undefined, volumeDb, volumeValue, pan, panPos, panPos2, panNorm,
           eqEnabled, sendCount, activeSendCount, sendDestinations };
}

const root = parseXml(xml);
const tracks = collectTracks(root);

const rows = [];
for (const t of tracks) {
  if (!t.strip) continue; // MIDI tracks without a VST Multitrack strip
  const d = describeStrip(t.strip.da);
  rows.push({
    name: t.name,
    kind: t.kind.replace('MTrackEvent', '').replace('M', '').replace('TrackEvent', ''),
    volumeDb: d.volumeDb,
    volumeValue: d.volumeValue,
    pan: d.pan,
    panPos: d.panPos,
    panPos2: d.panPos2,
    panNorm: d.panNorm,
    eqEnabled: d.eqEnabled,
    sendCount: d.sendCount,
    activeSendCount: d.activeSendCount,
    sendDestinations: d.sendDestinations,
  });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('name', 28) + pad('kind', 12) + pad('volumeDb', 14) + pad('Value', 14) +
              pad('pan', 6) + pad('panNorm', 10) + pad('eqEn', 6) + pad('sends', 7) + 'active');
  console.log('-'.repeat(105));
  for (const r of rows) {
    console.log(
      pad(r.name, 28) +
      pad(r.kind, 12) +
      pad(r.volumeDb == null ? '-' : r.volumeDb.toFixed(6), 14) +
      pad(r.volumeValue == null ? '-' : r.volumeValue, 14) +
      pad(r.pan == null ? 'C' : r.pan, 6) +
      pad(r.panNorm === 0 ? 'C' : r.panNorm.toFixed(5), 10) +
      pad(r.eqEnabled ? 'yes' : 'no', 6) +
      pad(r.sendCount, 7) +
      r.activeSendCount,
    );
  }
}
