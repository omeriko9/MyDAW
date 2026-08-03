import { describe, expect, it } from "vitest";
import type { Project, Track, TrackKind } from "../../protocol/types";
import { instrumentFeeders } from "./instrumentAssign";

const track = (id: number, kind: TrackKind, midiTarget = 0): Track =>
  ({ id, kind, midiTarget } as Track);

describe("shared instrument routing", () => {
  it("returns every MIDI feeder for one host and excludes other track kinds", () => {
    const project = {
      tracks: [
        track(10, "instrument"),
        track(11, "instrument"),
        track(1, "midi", 10),
        track(2, "midi", 10),
        track(3, "midi", 11),
        track(4, "audio", 10),
      ],
    } as Project;

    expect(instrumentFeeders(project, 10).map((t) => t.id)).toEqual([1, 2]);
    expect(instrumentFeeders(project, 11).map((t) => t.id)).toEqual([3]);
  });
});
