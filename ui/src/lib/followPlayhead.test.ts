import { describe, expect, it } from "vitest";
import { followScrollX } from "./followPlayhead";

const geo = (x: number, scrollX: number) => ({ x, scrollX, viewW: 1000, contentW: 5000 });

describe("followScrollX", () => {
  it("stays put while the playhead is inside the dead zone", () => {
    // dead zone defaults to 5%..80% of the viewport
    expect(followScrollX(geo(100, 0))).toBeNull();
    expect(followScrollX(geo(500, 0))).toBeNull();
    expect(followScrollX(geo(799, 0))).toBeNull();
    expect(followScrollX(geo(1300, 1000))).toBeNull();
  });

  it("pages forward once the playhead runs past the dead zone", () => {
    // playhead at 850 (>80%) → jump so it lands at 10% of the viewport
    expect(followScrollX(geo(850, 0))).toBe(750);
  });

  it("pages backward when the playhead is behind the view (a locate)", () => {
    expect(followScrollX(geo(1200, 2000))).toBe(1100);
  });

  it("clamps to the start of the content", () => {
    expect(followScrollX(geo(10, 900))).toBe(0);
  });

  it("clamps to the end of the content", () => {
    // near the end, the jump target would exceed contentW - viewW = 4000
    expect(followScrollX({ x: 4950, scrollX: 0, viewW: 1000, contentW: 5000 })).toBe(4000);
  });

  it("does nothing when the pane has no width yet (pre-layout)", () => {
    expect(followScrollX({ x: 100, scrollX: 0, viewW: 0, contentW: 5000 })).toBeNull();
  });

  it("returns null rather than a no-op scroll", () => {
    // already exactly where the jump would put it
    expect(followScrollX({ x: 4950, scrollX: 4000, viewW: 1000, contentW: 5000 })).toBeNull();
  });

  it("honours custom tuning", () => {
    // a wider lead pushes the playhead further into the viewport after the jump
    expect(followScrollX(geo(850, 0), { lead: 0.5 })).toBe(350);
  });
});
