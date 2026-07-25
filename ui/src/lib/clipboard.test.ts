/**
 * Clipboard paste-targeting contract (Cubase-style Ctrl+C/Ctrl+V):
 *  - different track selected than the copy's anchor → clips land on the SELECTED track
 *    at the SAME time mark as the source
 *  - same/no track selected → original tracks at the playhead
 *  - explicit beat (context-menu "Paste here") always wins
 *  - multi-clip selections keep relative beat offsets and track spacing
 *  - kind-incompatible mappings (midi clip → audio track) are skipped
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
let nextClipId = 1000;
vi.mock("../protocol/ws", () => ({
  ws: {
    request: (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      return Promise.resolve({ clip: { id: nextClipId++ } });
    },
    // store.ts wires these at module load
    on: () => () => undefined,
    onReconnect: () => () => undefined,
    onStateChange: () => () => undefined,
    state: () => "disconnected",
  },
}));

// store persistence stubs (node env has no window/localStorage)
const mem = new Map<string, string>();
type G = Record<string, unknown>;
(globalThis as G).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
(globalThis as G).window = globalThis;

import { copySelection, pasteAt } from "./clipboard";
import { useStore } from "../store/store";
import type { Project, Track } from "../protocol/types";

const midiClip = (id: number, startBeat: number, lengthBeats = 4) => ({
  id,
  type: "midi" as const,
  name: `clip${id}`,
  startBeat,
  lengthBeats,
  muted: false,
  notes: [{ id: id * 10, pitch: 60, velocity: 100, startBeat: 0, lengthBeats: 1 }],
  cc: [],
});

const track = (id: number, kind: Track["kind"], clips: ReturnType<typeof midiClip>[] = []): Track =>
  ({
    id,
    kind,
    name: `T${id}`,
    color: "#888",
    channels: 2,
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    recordArm: false,
    outputTarget: "master",
    inserts: [],
    sends: [],
    automation: [],
    clips,
  }) as unknown as Track;

function loadProject(): void {
  const project = {
    formatVersion: 1,
    name: "t",
    sampleRate: 48000,
    tempoMap: [{ beat: 0, bpm: 120 }],
    timeSigMap: [{ bar: 0, num: 4, den: 4 }],
    loop: { startBeat: 0, endBeat: 8, enabled: false },
    grid: { division: 0.25, snap: true, triplet: false, swing: 0 },
    markers: [],
    tracks: [
      track(1, "midi", [midiClip(11, 8), midiClip(12, 12)]),
      track(2, "midi"),
      track(3, "audio"),
      track(4, "instrument"),
    ],
    masterTrack: track(99, "master" as Track["kind"]),
    assets: [],
    nextId: 500,
  } as unknown as Project;
  useStore.setState({ project });
}

beforeEach(() => {
  sent.length = 0;
  nextClipId = 1000;
  loadProject();
});

const select = (trackIds: number[], clipIds: number[]) =>
  useStore.setState({ selection: { trackIds, clipIds, noteIds: [] } });

describe("pasteAt targeting", () => {
  it("different selected track → SAME time mark on that track", async () => {
    select([1], [11]);
    copySelection();
    select([2], []); // user clicks channel 2
    await pasteAt();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("cmd/clip.addMidi");
    expect(sent[0].payload.trackId).toBe(2);
    expect(sent[0].payload.startBeat).toBe(8); // same time mark as the source
  });

  it("same track selected → original track at the playhead (classic paste)", async () => {
    select([1], [11]);
    copySelection();
    await pasteAt(); // playhead defaults to 0 (no transport event yet)
    expect(sent[0].payload.trackId).toBe(1);
    expect(sent[0].payload.startBeat).toBe(0);
  });

  it("explicit beat always wins", async () => {
    select([1], [11]);
    copySelection();
    select([2], []);
    await pasteAt(32);
    expect(sent[0].payload.trackId).toBe(2);
    expect(sent[0].payload.startBeat).toBe(32);
  });

  it("multi-clip: relative offsets kept, same time mark on the target track", async () => {
    select([1], [11, 12]);
    copySelection();
    select([4], []); // instrument track takes midi clips
    await pasteAt();
    expect(sent.map((r) => r.payload.startBeat)).toEqual([8, 12]);
    expect(sent.every((r) => r.payload.trackId === 4)).toBe(true);
  });

  it("kind-incompatible target (midi clip → audio track) is skipped", async () => {
    select([1], [11]);
    copySelection();
    select([3], []); // audio track can't take a midi clip
    const ids = await pasteAt();
    expect(ids).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
