/**
 * dedupePlugins (SPEC §8.3a) — one row per distinct plugin BINARY.
 *
 * Omer's machine carries the same DLL in many places (installers, capture folders,
 * Dropbox backups): 416 scanned files were 269 actual plugins, and Orchestral.dll alone
 * appeared 12 times identically plus twice as a DIFFERENT build. Those two facts are the
 * whole specification: collapse byte-identical copies, never collapse different builds.
 */

import { describe, expect, it } from "vitest";
import { dedupePlugins } from "./store";
import type { PluginInfo } from "../protocol/types";

const p = (over: Partial<PluginInfo>): PluginInfo => ({
  uid: "u",
  format: "vst2",
  path: "C:/a.dll",
  bitness: 64,
  name: "P",
  vendor: "",
  category: "",
  isInstrument: false,
  numInputs: 2,
  numOutputs: 2,
  ...over,
});

describe("dedupePlugins", () => {
  it("keeps one row per content key and drops the marked copies", () => {
    const out = dedupePlugins([
      p({ path: "C:/vst/Orchestral.dll", contentKey: "9556033-aa" }),
      p({ path: "C:/backup/Orchestral.dll", contentKey: "9556033-aa", duplicateOf: "C:/vst/Orchestral.dll" }),
      p({ path: "C:/temp/Orchestral.dll", contentKey: "9556033-aa", duplicateOf: "C:/vst/Orchestral.dll" }),
    ]);
    expect(out.map((x) => x.path)).toEqual(["C:/vst/Orchestral.dll"]);
  });

  it("keeps every plugin inside a SHELL binary", () => {
    // WaveShell hosts the entire Waves catalogue from ONE file: same path, same
    // contentKey, different uids. Keying the dedupe on the file alone kept exactly one
    // of them, so "Enigma" was missing from the browser everywhere (Omer, 2026-08-13).
    const shell = { path: "C:/VST3/WaveShell1-VST3 15.0_x64.vst3", contentKey: "8410624-ws" };
    const out = dedupePlugins([
      p({ ...shell, uid: "565354454E4753656E69676D61207374", name: "Enigma Stereo" }),
      p({ ...shell, uid: "565354454E4758656E69676D61206D6F", name: "Enigma Mono/Stereo" }),
      p({ ...shell, uid: "565354454E475271313073746572656F", name: "Q10 Stereo" }),
    ]);
    expect(out.map((x) => x.name)).toEqual(["Enigma Stereo", "Enigma Mono/Stereo", "Q10 Stereo"]);
  });

  it("still collapses COPIES of a shell binary, per hosted plugin", () => {
    const a = { contentKey: "8410624-ws", path: "C:/VST3/WaveShell.vst3" };
    const b = { contentKey: "8410624-ws", path: "C:/backup/WaveShell.vst3", duplicateOf: "C:/VST3/WaveShell.vst3" };
    const out = dedupePlugins([
      p({ ...a, uid: "enigma", name: "Enigma" }),
      p({ ...a, uid: "q10", name: "Q10" }),
      p({ ...b, uid: "enigma", name: "Enigma" }),
      p({ ...b, uid: "q10", name: "Q10" }),
    ]);
    expect(out.map((x) => `${x.name}@${x.path}`)).toEqual([
      "Enigma@C:/VST3/WaveShell.vst3",
      "Q10@C:/VST3/WaveShell.vst3",
    ]);
  });

  it("never collapses a DIFFERENT build of the same plugin", () => {
    // The v1.03 Orchestral: same name, same uid, different bytes — two real choices.
    const out = dedupePlugins([
      p({ path: "C:/vst/Orchestral.dll", contentKey: "9556033-aa" }),
      p({ path: "C:/vst2/Orchestral.dll", contentKey: "9564241-bb" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps everything when the engine sends no identity (older engine)", () => {
    const out = dedupePlugins([
      p({ path: "C:/a/X.dll" }),
      p({ path: "C:/b/X.dll" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps a blacklisted copy visible next to a healthy one", () => {
    // Blacklisting is per PATH, so one copy can be disabled while another works; hiding
    // the disabled row would make the blacklist look like it silently did nothing.
    const out = dedupePlugins([
      p({ path: "C:/ok/X.dll", contentKey: "1-a" }),
      p({ path: "C:/bad/X.dll", contentKey: "1-a", duplicateOf: "C:/ok/X.dll", blacklisted: true }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("shows a duplicate whose canonical copy is not in the list", () => {
    // A filtered/targeted list can contain the copy but not its canonical row; dropping
    // it would make the plugin vanish from the UI entirely.
    const out = dedupePlugins([
      p({ path: "C:/backup/X.dll", contentKey: "1-a", duplicateOf: "C:/gone/X.dll" }),
    ]);
    expect(out).toHaveLength(1);
  });
});
