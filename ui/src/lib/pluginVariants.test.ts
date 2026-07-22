import { describe, expect, it } from "vitest";
import { groupPluginVariants, pluginBaseName } from "./pluginVariants";
import type { PluginInfo } from "../protocol/types";

function pi(name: string, over: Partial<PluginInfo> = {}): PluginInfo {
  return {
    uid: over.uid ?? name,
    format: "vst2",
    path: over.path ?? "C:/waves/shell.dll",
    bitness: 32,
    name,
    vendor: "Waves",
    category: "Fx",
    isInstrument: false,
    numInputs: 2,
    numOutputs: 2,
    blacklisted: false,
    blacklistReason: "",
    ...over,
  } as PluginInfo;
}

describe("pluginBaseName", () => {
  it("strips trailing channel-config tokens", () => {
    expect(pluginBaseName("C1 comp Mono")).toBe("C1 comp");
    expect(pluginBaseName("PS01 - Keyboards stereo2stereo")).toBe("PS01 - Keyboards");
    expect(pluginBaseName("TrueVerb Stereo")).toBe("TrueVerb");
    expect(pluginBaseName("L1 limiter m2s")).toBe("L1 limiter");
  });
  it("keeps names without config suffixes (and lone tokens)", () => {
    expect(pluginBaseName("Serum")).toBe("Serum");
    expect(pluginBaseName("Stereo Delay")).toBe("Stereo Delay"); // "Delay" is no config token
    expect(pluginBaseName("Mono")).toBe("Mono"); // never strip down to nothing
  });
});

describe("groupPluginVariants", () => {
  it("collapses Waves routing + bitness twins into one representative", () => {
    const list = [
      pi("C1 comp Mono", { uid: "a" }),
      pi("C1 comp Stereo", { uid: "b" }),
      pi("C1 comp stereo2stereo", { uid: "c" }),
      pi("C1 comp stereo2stereo", { uid: "c", bitness: 64, path: "C:/waves/shell64.dll" }),
      pi("TrueVerb Mono", { uid: "d" }),
    ];
    const { plugins, variantsByKey } = groupPluginVariants(list);
    expect(plugins).toHaveLength(2);
    const c1 = plugins.find((p) => p.name.startsWith("C1"))!;
    expect(c1.name).toBe("C1 comp stereo2stereo"); // best routing…
    expect(c1.bitness).toBe(64); // …at the highest bitness
    expect(variantsByKey.get(`${c1.format}|${c1.uid}|${c1.bitness}|${c1.path}`)).toHaveLength(4);
    expect(plugins.find((p) => p.name.startsWith("TrueVerb"))).toBeTruthy();
  });

  it("keeps different formats and unrelated plugins separate", () => {
    const list = [
      pi("C1 comp Stereo", { uid: "a" }),
      pi("C1 comp", { uid: "g", format: "vst3", path: "C:/vst3/c1.vst3", bitness: 64 }),
      pi("Serum", { uid: "s", isInstrument: true }),
    ];
    const { plugins } = groupPluginVariants(list);
    expect(plugins).toHaveLength(3);
  });

  it("prefers non-blacklisted variants", () => {
    const list = [
      pi("C1 comp stereo2stereo", { uid: "a", blacklisted: true }),
      pi("C1 comp Mono", { uid: "b" }),
    ];
    const { plugins } = groupPluginVariants(list);
    expect(plugins[0].uid).toBe("b");
  });

  it("×N badge counts only USABLE variants — disabled ones drop out", () => {
    // "disabled 3 of 4 Addictive Drums but the tab still said ×4"
    const list = [
      pi("Addictive Drums", { uid: "ad", path: "C:/a/AD.dll", blacklisted: true }),
      pi("Addictive Drums", { uid: "ad", path: "C:/b/AD.dll", blacklisted: true }),
      pi("Addictive Drums", { uid: "ad", path: "C:/c/AD.dll", blacklisted: true }),
      pi("Addictive Drums", { uid: "ad", path: "C:/d/AD.dll" }),
    ];
    const { plugins, variantsByKey } = groupPluginVariants(list);
    expect(plugins).toHaveLength(1);
    const rep = plugins[0];
    expect(rep.blacklisted).toBe(false); // the one usable variant represents the group
    // one usable variant left => no ×N badge at all
    expect(variantsByKey.size).toBe(0);
  });

  it("×N badge shows two usable of four", () => {
    const list = [
      pi("Addictive Drums", { uid: "ad", path: "C:/a/AD.dll", blacklisted: true }),
      pi("Addictive Drums", { uid: "ad", path: "C:/b/AD.dll" }),
      pi("Addictive Drums", { uid: "ad", path: "C:/c/AD.dll", blacklisted: true }),
      pi("Addictive Drums", { uid: "ad", path: "C:/d/AD.dll" }),
    ];
    const { plugins, variantsByKey } = groupPluginVariants(list);
    const rep = plugins[0];
    expect(variantsByKey.get(`${rep.format}|${rep.uid}|${rep.bitness}|${rep.path}`)).toHaveLength(2);
  });

  it("a fully-disabled group keeps its complete variant list", () => {
    const list = [
      pi("Old Shell Mono", { uid: "a", path: "C:/x/1.dll", blacklisted: true }),
      pi("Old Shell Stereo", { uid: "b", path: "C:/x/2.dll", blacklisted: true }),
    ];
    const { plugins, variantsByKey } = groupPluginVariants(list);
    const rep = plugins[0];
    expect(rep.blacklisted).toBe(true);
    expect(variantsByKey.get(`${rep.format}|${rep.uid}|${rep.bitness}|${rep.path}`)).toHaveLength(2);
  });
});
