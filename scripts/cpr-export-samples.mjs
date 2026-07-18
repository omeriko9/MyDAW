#!/usr/bin/env node
// cpr-export-samples.mjs — regenerate the user-facing .cpr samples in
// out/cpr-export-samples/ with the current writer pipeline (scripts/cpr-write.mjs).
// The models match the descriptions in out/cpr-export-samples/README.md.
//
// usage: node scripts/cpr-export-samples.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCpr } from './cpr-write.mjs';

const OUT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  'out', 'cpr-export-samples');
fs.mkdirSync(OUT, { recursive: true });

const db = (x) => Math.pow(10, x / 20);
const note = (pitch, velocity, startBeat, lengthBeats) => ({ pitch, velocity, startBeat, lengthBeats });

const SAMPLES = [
  {
    file: 'minimal-1track.cpr',
    model: {
      tempo: 120,
      tracks: [{
        name: 'Test Piano', kind: 'midi', volumeGain: 1.0, pan: 0,
        clips: [{
          startBeat: 0, lengthBeats: 8, notes: [
            note(60, 100, 0, 1), note(64, 110, 1, 1), note(67, 100, 2, 1), note(72, 110, 3, 1),
            note(60, 80, 4, 4), note(64, 80, 4, 4), note(67, 80, 4, 4),
          ],
        }],
      }],
    },
  },
  {
    file: 'band-3tracks.cpr',
    model: {
      tempo: 110,
      tracks: [
        {
          name: 'Piano', kind: 'midi', volumeGain: 1.0, pan: 0,
          clips: [
            { startBeat: 0, lengthBeats: 4, notes: [note(60, 64, 0, 2), note(64, 80, 0, 2), note(67, 127, 0, 2), note(65, 96, 2, 2)] },
            { startBeat: 16, lengthBeats: 4, notes: [note(62, 90, 0, 2), note(65, 90, 0, 2), note(69, 90, 0, 2)] },
          ],
        },
        {
          name: 'Bass', kind: 'midi', volumeGain: 1.0, pan: 0,
          clips: [{ startBeat: 0, lengthBeats: 8, notes: [note(36, 112, 0, 1), note(43, 96, 1, 1), note(36, 112, 2, 1), note(41, 96, 3, 1), note(36, 112, 4, 2), note(38, 100, 6, 2)] }],
        },
        {
          name: 'Strings', kind: 'midi', volumeGain: 1.0, pan: 0,
          clips: [{ startBeat: 8, lengthBeats: 8, notes: [note(72, 70, 0, 8), note(76, 70, 0, 6), note(79, 70, 2, 6)] }],
        },
      ],
    },
  },
  {
    file: 'mixer-faders.cpr',
    model: {
      tempo: 100,
      tracks: [
        { name: 'Fader -6.97dB L100', kind: 'midi', volumeGain: db(-6.97), pan: -1,
          clips: [{ startBeat: 0, lengthBeats: 4, notes: [note(60, 96, 0, 4)] }] },
        { name: 'Fader +3.5dB R33', kind: 'midi', volumeGain: db(3.5), pan: 0.33,
          clips: [{ startBeat: 0, lengthBeats: 4, notes: [note(64, 96, 0, 4)] }] },
        { name: 'Fader -20dB C', kind: 'midi', volumeGain: db(-20), pan: 0,
          clips: [{ startBeat: 0, lengthBeats: 4, notes: [note(67, 96, 0, 4)] }] },
      ],
    },
  },
];

for (const s of SAMPLES) {
  const out = writeCpr(s.model); // pipeline defaults (keep donor track 1, rebase+verify)
  fs.writeFileSync(path.join(OUT, s.file), out);
  console.log(`${s.file.padEnd(24)} ${String(out.stats.bytes).padStart(7)} B  ` +
    `${out.stats.keptDonorTracks}+${out.stats.tracks} tracks, ${out.stats.parts} parts, ` +
    `${out.stats.notes} notes, ids rebased=${out.stats.rebasedIds} verified=${out.stats.verifiedIds} ` +
    `staleTable=${out.stats.staleTableIds}`);
}
console.log('done -> ' + OUT);
