import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store/store";
import type { Project, Track } from "../protocol/types";
import {
  moveTrackSelection,
  resetTrackSelectionAnchor,
  selectTrack,
} from "./trackSelection";

const order = [1, 2, 3, 4, 5];

beforeEach(() => {
  resetTrackSelectionAnchor();
  useStore.setState({ project: null, selection: { trackIds: [], clipIds: [], noteIds: [], scope: "none" } });
});

describe("track selection", () => {
  it("keeps a stable anchor while Shift changes the range end", () => {
    selectTrack(2, order);
    selectTrack(5, order, { range: true });
    expect(useStore.getState().selection.trackIds).toEqual([2, 3, 4, 5]);

    selectTrack(4, order, { range: true });
    expect(useStore.getState().selection.trackIds).toEqual([2, 3, 4]);
  });

  it("supports toggle and additive range selection", () => {
    selectTrack(2, order);
    selectTrack(4, order, { toggle: true });
    selectTrack(5, order, { range: true, additiveRange: true });
    expect(useStore.getState().selection.trackIds).toEqual([2, 4, 5]);
  });

  it("moves with arrows and extends from the keyboard anchor", () => {
    expect(moveTrackSelection(order, 1, false)).toBe(1);
    expect(moveTrackSelection(order, 1, false)).toBe(2);
    expect(moveTrackSelection(order, 1, true)).toBe(3);
    expect(useStore.getState().selection.trackIds).toEqual([2, 3]);
    expect(moveTrackSelection(order, -1, true)).toBe(2);
    expect(useStore.getState().selection.trackIds).toEqual([2]);
  });

  it("selects every sequence on the selected track range", () => {
    useStore.setState({
      project: {
        tracks: [
          { id: 1, clips: [{ id: 101 }, { id: 102 }] } as Track,
          { id: 2, clips: [{ id: 201 }] } as Track,
          { id: 3, clips: [] } as unknown as Track,
        ],
      } as Project,
    });

    selectTrack(1, [1, 2, 3]);
    selectTrack(2, [1, 2, 3], { range: true });
    expect(useStore.getState().selection).toMatchObject({
      trackIds: [1, 2],
      clipIds: [101, 102, 201],
      scope: "tracks",
    });
  });
});
