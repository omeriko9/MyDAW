import { describe, expect, it, vi } from "vitest";
import {
  AgentClient,
  AgentClientError,
  StreamAccumulator,
  parseCompletion,
} from "./agentClient";

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

describe("StreamAccumulator", () => {
  it("accumulates content deltas and forwards them to onDelta", () => {
    const seen: string[] = [];
    const acc = new StreamAccumulator((t) => seen.push(t));
    acc.feed(sse({ choices: [{ delta: { content: "Hel" } }] }));
    acc.feed(sse({ choices: [{ delta: { content: "lo" } }] }));
    acc.feed("data: [DONE]\n\n");
    const { message, finishReason } = acc.result();
    expect(message.content).toBe("Hello");
    expect(message.tool_calls).toBeUndefined();
    expect(finishReason).toBe("stop");
    expect(seen).toEqual(["Hel", "lo"]);
  });

  it("merges tool-call deltas by index even when arguments are split", () => {
    const acc = new StreamAccumulator();
    acc.feed(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "mydaw_query", arguments: '{"vi' } },
              ],
            },
          },
        ],
      }),
    );
    acc.feed(
      sse({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ew":"tracks"}' } }] } }],
      }),
    );
    acc.feed(sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    const { message, finishReason } = acc.result();
    expect(finishReason).toBe("tool_calls");
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls![0]).toMatchObject({
      id: "call_a",
      function: { name: "mydaw_query", arguments: '{"view":"tracks"}' },
    });
  });

  it("handles a line split across two feed() chunks", () => {
    const acc = new StreamAccumulator();
    const line = sse({ choices: [{ delta: { content: "split" } }] });
    acc.feed(line.slice(0, 10));
    acc.feed(line.slice(10));
    expect(acc.result().message.content).toBe("split");
  });
});

describe("parseCompletion", () => {
  it("reads a non-streaming assistant message", () => {
    const { message, finishReason } = parseCompletion({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });
    expect(message.content).toBe("hi");
    expect(finishReason).toBe("stop");
  });
});

describe("AgentClient", () => {
  it("streams a chat completion through the accumulator", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      streamResponse([
        sse({ choices: [{ delta: { content: "hey" } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const client = new AgentClient("http://x/v1", "m", "", fetchImpl);
    const deltas: string[] = [];
    const res = await client.chat({
      messages: [{ role: "user", content: "hi" }],
      onDelta: (t) => deltas.push(t),
    });
    expect(res.message.content).toBe("hey");
    expect(deltas).toEqual(["hey"]);
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init?.body)).stream).toBe(true);
  });

  it("falls back to a non-streaming completion", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      }),
    })) as unknown as typeof fetch;
    const client = new AgentClient("http://x/v1", "m", "", fetchImpl as never);
    const res = await client.chat({ messages: [{ role: "user", content: "hi" }], stream: false });
    expect(res.message.content).toBe("done");
  });

  it("lists models and includes the bearer header when an api key is set", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }),
    })) as unknown as typeof fetch;
    const client = new AgentClient("http://x/v1", "", "secret", fetchImpl as never);
    expect(await client.listModels()).toEqual(["m1", "m2"]);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });

  it("throws AgentClientError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    })) as unknown as typeof fetch;
    const client = new AgentClient("http://x/v1", "m", "", fetchImpl as never);
    await expect(client.chat({ messages: [] })).rejects.toBeInstanceOf(AgentClientError);
  });
});
