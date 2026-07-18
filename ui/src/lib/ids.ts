/**
 * Client-side temporary ids for optimistic operations.
 *
 * Engine ids are uint64, monotonically increasing, always > 0 (SPEC §4, Model::nextId).
 * The UI uses NEGATIVE ids for objects it creates optimistically before the engine reply
 * arrives (e.g. a note drawn while cmd/notes.edit is in flight). Negative ids never clash
 * with engine ids and are trivially detectable.
 */

let nextTemp = -1;

/** Allocate a new temporary (negative) id. */
export function tempId(): number {
  return nextTemp--;
}

/** True if `id` is a client-side temporary id (negative). */
export function isTempId(id: number): boolean {
  return id < 0;
}

/** Reset the counter (tests / full project replace). */
export function resetTempIds(): void {
  nextTemp = -1;
}

/**
 * Stable, UNIQUE React key / identity for a registry plugin.
 *
 * uid alone is NOT unique: a VST2 shell (Waves WaveShell, Kontakt, …) reports the same uid
 * for every copy of the shell DLL found, so a uid-only key produces duplicate React keys and
 * rows render on top of each other. The file path disambiguates them.
 */
export function pluginKey(p: {
  format: string;
  uid: string;
  bitness: number;
  path: string;
}): string {
  return `${p.format}|${p.uid}|${p.bitness}|${p.path}`;
}
