import { describe, expect, it, vi } from "vitest";
import { withBusyIndicator } from "./busy";

/** A recording stand-in for showBusyToast: [label, closed?] per call. */
function recorder() {
  const shown: Array<{ label: string; closed: boolean }> = [];
  const show = (label: string) => {
    const entry = { label, closed: false };
    shown.push(entry);
    return () => {
      entry.closed = true;
    };
  };
  return { shown, show };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("withBusyIndicator", () => {
  it("stays silent for work that finishes before the delay", async () => {
    vi.useFakeTimers();
    const r = recorder();
    const p = withBusyIndicator("Closing…", async () => "done", { delayMs: 400, show: r.show });
    await tick(1000);
    await expect(p).resolves.toBe("done");
    expect(r.shown).toEqual([]);
    vi.useRealTimers();
  });

  it("shows the indicator once the work outlives the delay, then closes it", async () => {
    vi.useFakeTimers();
    const r = recorder();
    let release!: (v: string) => void;
    const p = withBusyIndicator("Closing project…", () => new Promise<string>((res) => { release = res; }),
      { delayMs: 400, show: r.show });
    await tick(500);
    expect(r.shown.map((s) => s.label)).toEqual(["Closing project…"]);
    expect(r.shown[0].closed).toBe(false); // still working
    release("ok");
    await expect(p).resolves.toBe("ok");
    expect(r.shown[0].closed).toBe(true);
    vi.useRealTimers();
  });

  it("closes the indicator when the work FAILS", async () => {
    // Otherwise a failed Close leaves a spinner on screen forever — worse than no spinner.
    vi.useFakeTimers();
    const r = recorder();
    let boom!: (e: Error) => void;
    const p = withBusyIndicator("Closing…", () => new Promise<never>((_, rej) => { boom = rej; }),
      { delayMs: 100, show: r.show });
    await tick(200);
    expect(r.shown).toHaveLength(1);
    boom(new Error("engine said no"));
    await expect(p).rejects.toThrow("engine said no");
    expect(r.shown[0].closed).toBe(true);
    vi.useRealTimers();
  });

  it("never shows anything for fast work that throws", async () => {
    vi.useFakeTimers();
    const r = recorder();
    const p = withBusyIndicator("Closing…", async () => { throw new Error("nope"); },
      { delayMs: 400, show: r.show });
    await expect(p).rejects.toThrow("nope");
    await tick(1000);
    expect(r.shown).toEqual([]);
    vi.useRealTimers();
  });
});
