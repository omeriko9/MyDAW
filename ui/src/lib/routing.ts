/**
 * Send/output routing predicates — the UI mirror of the engine's own checks.
 *
 * The engine is the authority (Model::wouldCreateRoutingCycle refuses the command with
 * `routing_cycle`), but a menu that offers a destination and then fails is worse than one
 * that greys it out and says why. Both send menus — the mixer strip's SENDS "+" and the
 * Inspector's — use this so they agree; they used to disagree, which read as one of them
 * being broken.
 */

import type { Track } from "../protocol/types";

/**
 * Would routing `srcId` into `destId` close a loop?
 *
 * Walks forward from the destination through each bus's outputTarget and its sends,
 * looking for the source. Only buses can be a send destination or a numeric output
 * target, so walking `buses` visits every node the engine would.
 */
export function wouldCycle(buses: Track[], srcId: number, destId: number): boolean {
  if (srcId === destId) return true;
  const byId = new Map(buses.map((b) => [b.id, b]));
  const seen = new Set<number>();
  const stack: number[] = [destId];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    if (cur === srcId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const t = byId.get(cur);
    if (!t) continue;
    if (typeof t.outputTarget === "number") stack.push(t.outputTarget);
    for (const s of t.sends) if (s.destTrackId) stack.push(s.destTrackId);
  }
  return false;
}

/** Tooltip for a destination rejected by {@link wouldCycle}. Shared so both menus say
 *  the same thing. */
export function cycleReason(destName: string): string {
  return `${destName} already feeds this channel — a send would create a routing cycle`;
}
