import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("empty query matches everything with score 0", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, ranges: [] });
    expect(fuzzyMatch("   ", "anything")?.score).toBe(0);
  });

  it("returns null when a token is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "Export Audio")).toBeNull();
    expect(fuzzyMatch("audio zz", "Export Audio")).toBeNull();
  });

  it("matches case-insensitively and reports ranges", () => {
    const m = fuzzyMatch("audio", "Export Audio…");
    expect(m).not.toBeNull();
    expect(m!.ranges).toEqual([[7, 12]]);
  });

  it("ranks contiguous substring above scattered subsequence", () => {
    const sub = fuzzyMatch("export", "Export Audio")!;
    const scattered = fuzzyMatch("export", "Extra port done")!;
    expect(scattered).not.toBeNull();
    expect(sub.score).toBeGreaterThan(scattered.score);
  });

  it("ranks word-start matches above mid-word matches", () => {
    const wordStart = fuzzyMatch("port", "Port Settings")!;
    const midWord = fuzzyMatch("port", "Export list")!;
    expect(wordStart.score).toBeGreaterThan(midWord.score);
  });

  it("multi-token queries require all tokens and sum scores", () => {
    const m = fuzzyMatch("exp aud", "File › Export › Export Audio…");
    expect(m).not.toBeNull();
    expect(fuzzyMatch("exp zzz", "File › Export › Export Audio…")).toBeNull();
  });

  it("merges overlapping ranges", () => {
    const m = fuzzyMatch("export export", "Export")!;
    expect(m.ranges).toEqual([[0, 6]]);
  });

  it("prefers shorter labels on equal hits", () => {
    const short = fuzzyMatch("save", "Save")!;
    const long = fuzzyMatch("save", "Save As with a very long explanatory label")!;
    expect(short.score).toBeGreaterThan(long.score);
  });
});
