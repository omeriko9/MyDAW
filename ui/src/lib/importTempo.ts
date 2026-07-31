/**
 * Media-import tempo prompt (SPEC §5.5).
 *
 * An import is ONE undo entry, so the "apply the file's tempo?" decision must be made
 * BEFORE media/import runs. Two detection paths, one per transport:
 *   - picker paths (engine-side files): `media/probe` parses the SMF properly;
 *   - drops (client-side bytes): the byte sniff below — in a well-formed SMF, data
 *     bytes stay below 0x80, so 0xFF inside a track chunk is (almost always) a meta
 *     status byte; we look for FF 51 03 (set tempo) / FF 58 04 (time signature). A
 *     rare VLQ false positive only costs an unnecessary question — the engine adopts
 *     maps only when REAL metas exist (SmfData.hasTempoMeta).
 */

import { confirmDialog } from "../components/Dialogs/confirm";

export function sniffSmfTempo(bytes: Uint8Array): { has: boolean; bpm?: number } {
  if (bytes.length < 14) return { has: false };
  if (bytes[0] !== 0x4d || bytes[1] !== 0x54 || bytes[2] !== 0x68 || bytes[3] !== 0x64)
    return { has: false }; // not "MThd"
  for (let i = 14; i + 2 < bytes.length; i++) {
    if (bytes[i] !== 0xff) continue;
    if (bytes[i + 1] === 0x51 && bytes[i + 2] === 3 && i + 5 < bytes.length) {
      const us = (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5];
      if (us > 0) return { has: true, bpm: 60000000 / us };
    }
    if (bytes[i + 1] === 0x58 && bytes[i + 2] === 4) return { has: true };
  }
  return { has: false };
}

/** The shared question. Resolves false on cancel/Escape — import proceeds, tempo kept. */
export function askAdoptFileTempo(fileName: string, bpm?: number): Promise<boolean> {
  return confirmDialog({
    title: "Import Tempo?",
    message:
      `"${fileName}" carries its own tempo${bpm ? ` (≈${Math.round(bpm)} BPM)` : ""}. ` +
      "Apply the file's tempo and time-signature maps to the project? " +
      "Everything keeps its beat position, so audio clips shift in wall-clock time. " +
      "Undoing the import also restores the current tempo.",
    confirmLabel: "Apply Tempo",
  });
}

export const isMidiFileName = (name: string): boolean => /\.midi?$/i.test(name);
