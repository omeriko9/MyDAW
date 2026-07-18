import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGES_PER_THREAD,
  MAX_THREADS_PER_PROJECT,
  parseCustomScripts,
  parseHistories,
  projectKey,
  pruneProjectHistory,
  stringifyHistories,
  upsertThread,
  type ChatThread,
} from "./agentPersistence";

const thread = (id: string, updatedAt: number, messages = 1): ChatThread => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt,
  messages: Array.from({ length: messages }, (_, i) => ({
    role: "user" as const,
    content: `m${i}`,
  })),
});

describe("projectKey", () => {
  it("is stable and case/slash-insensitive for a saved path", () => {
    expect(projectKey("C:/Songs/My.mydaw")).toBe(projectKey("c:\\Songs\\My.mydaw\\"));
    expect(projectKey("C:/Songs/My.mydaw")).not.toBe(projectKey("C:/Songs/Other.mydaw"));
  });
  it("buckets unsaved projects together", () => {
    expect(projectKey(null)).toBe("session:unsaved");
    expect(projectKey("")).toBe("session:unsaved");
  });
});

describe("pruneProjectHistory", () => {
  it("caps threads to the newest MAX_THREADS_PER_PROJECT", () => {
    const threads = Array.from({ length: MAX_THREADS_PER_PROJECT + 5 }, (_, i) =>
      thread(`t${i}`, i),
    );
    const pruned = pruneProjectHistory({ threads });
    expect(pruned.threads).toHaveLength(MAX_THREADS_PER_PROJECT);
    expect(pruned.threads[0].id).toBe(`t${MAX_THREADS_PER_PROJECT + 4}`); // newest first
  });

  it("caps messages per thread to the newest MAX_MESSAGES_PER_THREAD", () => {
    const pruned = pruneProjectHistory({
      threads: [thread("t", 1, MAX_MESSAGES_PER_THREAD + 10)],
    });
    expect(pruned.threads[0].messages).toHaveLength(MAX_MESSAGES_PER_THREAD);
    expect(pruned.threads[0].messages[0].content).toBe("m10"); // oldest dropped
  });
});

describe("upsertThread", () => {
  it("replaces a thread by id rather than duplicating", () => {
    let h = upsertThread({}, "k", thread("a", 1));
    h = upsertThread(h, "k", { ...thread("a", 2), title: "renamed" });
    expect(h.k.threads).toHaveLength(1);
    expect(h.k.threads[0].title).toBe("renamed");
  });
});

describe("parseHistories (corruption recovery)", () => {
  it("recovers from a JSON string and drops corrupt threads", () => {
    const raw = JSON.stringify({
      k: { threads: [thread("good", 1), { id: 123 }, "garbage", { messages: [] }] },
    });
    const parsed = parseHistories(raw);
    expect(parsed.k.threads).toHaveLength(1);
    expect(parsed.k.threads[0].id).toBe("good");
  });
  it("returns empty on unparseable input", () => {
    expect(parseHistories("{not json")).toEqual({});
    expect(parseHistories(42)).toEqual({});
  });
  it("round-trips through stringify", () => {
    const h = upsertThread({}, "k", thread("a", 1));
    expect(parseHistories(stringifyHistories(h))).toEqual(h);
  });
});

describe("parseCustomScripts", () => {
  it("drops invalid entries and deduplicates ids", () => {
    const scripts = parseCustomScripts([
      { id: "a", title: "A", category: "c", prompt: "p" },
      { id: "a", title: "dup", category: "c", prompt: "p" }, // duplicate id -> dropped
      { id: "b", title: "B", category: "c" }, // missing prompt -> dropped
      { title: "no id", category: "c", prompt: "p" }, // missing id -> dropped
      "garbage",
    ]);
    expect(scripts.map((s) => s.id)).toEqual(["a"]);
  });
  it("accepts a JSON string and preserves string tags", () => {
    const scripts = parseCustomScripts(
      JSON.stringify([{ id: "x", title: "X", category: "c", prompt: "p", tags: ["t", 1] }]),
    );
    expect(scripts[0].tags).toEqual(["t"]);
  });
});
