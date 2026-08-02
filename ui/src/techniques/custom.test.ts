import { describe, expect, it } from "vitest";
import { resolveCustom, type CustomTechniqueData } from "./custom";
import { TECHNIQUES } from "./catalog";
import { loadCatOrder, moveCategory } from "./userPrefs";
import { CATEGORY_ORDER } from "./types";

describe("custom techniques (builder remixes)", () => {
  it("resolves borrowed stages with source-labelled titles and unique ids", () => {
    const data: CustomTechniqueData = {
      id: "custom-1",
      title: "My lift",
      tagline: "",
      description: "",
      steps: [
        { tech: "sidechain-pump", stage: "key" },
        { tech: "master-glue", stage: "glue" },
        { tech: "sidechain-pump", stage: "key" }, // same stage borrowed twice
      ],
    };
    const { def, missing } = resolveCustom(data, TECHNIQUES);
    expect(missing).toEqual([]);
    expect(def.category).toBe("custom");
    expect(def.stages).toHaveLength(3);
    expect(new Set(def.stages.map((s) => s.id)).size).toBe(3);
    expect(def.stages[0].title).toContain("Sidechain Pump");
    expect(def.stages[1].title).toContain("Master Glue");
  });

  it("reports missing refs instead of silently dropping them", () => {
    const { def, missing } = resolveCustom(
      {
        id: "custom-2",
        title: "Stale",
        tagline: "",
        description: "",
        steps: [
          { tech: "no-such-technique", stage: "x" },
          { tech: "master-glue", stage: "no-such-stage" },
          { tech: "master-glue", stage: "ceiling" },
        ],
      },
      TECHNIQUES,
    );
    expect(missing).toHaveLength(2);
    expect(def.stages).toHaveLength(1);
  });

  it("unions the source techniques' requirements, deduped by label", () => {
    const { def } = resolveCustom(
      {
        id: "custom-3",
        title: "Two pumps",
        tagline: "",
        description: "",
        steps: [
          { tech: "sidechain-pump", stage: "key" },
          { tech: "sidechain-pump", stage: "depth" },
          { tech: "chop-sampler", stage: "sampler" },
        ],
      },
      TECHNIQUES,
    );
    const pump = TECHNIQUES.find((t) => t.id === "sidechain-pump")!;
    const chop = TECHNIQUES.find((t) => t.id === "chop-sampler")!;
    const fake = {
      project: { tracks: [], chordEvents: [], masterTrack: { inserts: [] } },
      selection: { trackIds: [], clipIds: [], noteIds: [] },
      bpm: 120,
      beatsPerBar: 4,
      playheadBeat: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const labels = def.requirements(fake).map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length); // deduped
    const srcLabels = [...pump.requirements(fake), ...chop.requirements(fake)].map((r) => r.label);
    for (const l of labels) expect(srcLabels).toContain(l);
  });
});

describe("technique browser user prefs", () => {
  it("category reorder moves entries and stays a permutation", () => {
    const base = [...CATEGORY_ORDER];
    const up = moveCategory(base, "macros", "top");
    expect(up[0]).toBe("macros");
    expect([...up].sort()).toEqual([...base].sort());
    expect(moveCategory(base, "transitions", "up")[0]).toBe("transitions"); // already first
  });

  it("loadCatOrder always yields every category exactly once", () => {
    const order = loadCatOrder();
    expect([...order].sort()).toEqual([...CATEGORY_ORDER].sort());
  });
});
