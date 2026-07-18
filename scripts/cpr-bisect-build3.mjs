#!/usr/bin/env node
// cpr-bisect-build3.mjs — bisect ladder v3: ONE confirmation file.
//
// After the v2 run, every mechanism of the default writer pipeline is human-validated
// in Cubase 5.1.1 EXCEPT the in-place tempo patch of the kept donor track's
// MTempoTrackEvent (v2 stages 20-22 used tempo 120 = the donor's own value, so the
// patch was byte-neutral there; the M2 oracle validated non-120 tempos only through
// MyDAW's importer). This stage isolates exactly that: the default pipeline with
// tempo 96.5 and one note.
//
// usage: node scripts/cpr-bisect-build3.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serialize, firstDiff } from './cpr-container.mjs';
import { writeCpr } from './cpr-write.mjs';

const OUT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  'out', 'cpr-bisect-v3');
fs.mkdirSync(OUT, { recursive: true });

const out = writeCpr({
  tempo: 96.5,
  tracks: [{
    name: 'Tempo Probe', kind: 'midi', volumeGain: 1, pan: 0,
    clips: [{ startBeat: 0, lengthBeats: 4, notes: [{ pitch: 60, velocity: 100, startBeat: 0, lengthBeats: 4 }] }],
  }],
});
const diff = firstDiff(out, serialize(parse(out)));
if (diff >= 0) throw new Error('not re-serialize-stable @0x' + diff.toString(16));
fs.writeFileSync(path.join(OUT, '30-keep1-tempo-96.5.cpr'), out);
console.log(`30-keep1-tempo-96.5.cpr ${out.length} B — default pipeline, tempo 96.5 (in-place MTempoTrackEvent float patch)`);
