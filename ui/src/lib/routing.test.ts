import { describe, it, expect } from "vitest";
import { wouldCycle } from "./routing";
import type { Track } from "../protocol/types";

/** Minimal bus: only the fields wouldCycle walks (id, outputTarget, sends). */
function bus(id: number, outputTarget?: number, sendTo: number[] = []): Track {
  return {
    id,
    name: `Bus ${id}`,
    kind: "bus",
    outputTarget,
    sends: sendTo.map((destTrackId) => ({ destTrackId, level: 0.5 })),
  } as unknown as Track;
}

describe("wouldCycle", () => {
  it("refuses a send to the track itself", () => {
    expect(wouldCycle([], 1, 1)).toBe(true);
  });

  it("allows a bus that routes nowhere near the source", () => {
    expect(wouldCycle([bus(100), bus(101)], 1, 100)).toBe(false);
  });

  it("catches a one-hop loop through outputTarget", () => {
    // FX-A outputs back into the track that wants to send to it.
    expect(wouldCycle([bus(100, 1)], 1, 100)).toBe(true);
  });

  it("catches a loop that closes through a send rather than the output", () => {
    expect(wouldCycle([bus(100, undefined, [1])], 1, 100)).toBe(true);
  });

  it("follows a multi-hop chain back to the source", () => {
    // dest 102 -> 101 -> 100 -> track 1: still a cycle, three edges out.
    const buses = [bus(100, 1), bus(101, 100), bus(102, 101)];
    expect(wouldCycle(buses, 1, 102)).toBe(true);
  });

  it("terminates on a loop that does not involve the source", () => {
    // 100 <-> 101 feed each other; the source is not reachable, and the `seen`
    // set is what stops this from spinning forever.
    const buses = [bus(100, 101), bus(101, 100)];
    expect(wouldCycle(buses, 1, 100)).toBe(false);
  });

  it("ignores dangling destinations that no longer exist", () => {
    // A send pointing at a deleted bus must not be treated as reaching the source.
    expect(wouldCycle([bus(100, undefined, [999])], 1, 100)).toBe(false);
  });
});
