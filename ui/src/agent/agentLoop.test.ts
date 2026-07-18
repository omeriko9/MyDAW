import { describe, expect, it } from "vitest";
import { runAgentTurn, type ChatClient } from "./agentLoop";
import type { ChatResponse } from "./agentClient";
import type {
  AgentEvent,
  AgentTransport,
  ChatMessage,
  ToolCall,
} from "./agentTypes";

const asst = (content: string | null, toolCalls?: ToolCall[]): ChatResponse => ({
  message: {
    role: "assistant",
    content,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  },
  finishReason: toolCalls ? "tool_calls" : "stop",
});

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** Client that replays a scripted list of responses (repeats the last one). */
function scripted(responses: ChatResponse[]): ChatClient {
  let i = 0;
  return {
    async chat() {
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
}

function transportOf(
  impl: (type: string, payload: unknown) => unknown = () => ({ items: [], revision: 1 }),
): AgentTransport & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    async send(type, payload) {
      calls.push([type, payload]);
      return impl(type, payload);
    },
  };
}

const base = (messages: ChatMessage[] = [{ role: "user", content: "hi" }]) => ({
  messages,
  transport: transportOf(),
});

describe("runAgentTurn", () => {
  it("returns a plain answer with no tools", async () => {
    const events: AgentEvent[] = [];
    const r = await runAgentTurn({
      ...base(),
      client: scripted([asst("hello")]),
      onEvent: (e) => events.push(e),
    });
    expect(r.stopped).toBe("complete");
    expect(r.steps).toBe(1);
    expect(r.messages.at(-1)).toMatchObject({ role: "assistant", content: "hello" });
    expect(events.at(-1)).toMatchObject({ kind: "done", stopped: "complete" });
  });

  it("executes one tool call and feeds the result back", async () => {
    const transport = transportOf(() => ({ view: "tracks", revision: 2, items: [{ id: 1 }] }));
    const r = await runAgentTurn({
      messages: [{ role: "user", content: "list tracks" }],
      transport,
      client: scripted([asst(null, [call("c1", "mydaw_query", { view: "tracks" })]), asst("2 tracks")]),
    });
    expect(r.stopped).toBe("complete");
    expect(r.steps).toBe(2);
    expect(transport.calls[0]).toEqual(["agent/query", { view: "tracks" }]);
    const toolMsg = r.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("c1");
    expect(toolMsg?.content).toContain('"id":1');
  });

  it("runs multiple read-only calls in one step", async () => {
    const transport = transportOf((_t, p) => ({ view: (p as { view: string }).view, items: [] }));
    const r = await runAgentTurn({
      messages: [{ role: "user", content: "x" }],
      transport,
      client: scripted([
        asst(null, [
          call("a", "mydaw_query", { view: "tracks" }),
          call("b", "mydaw_query", { view: "markers" }),
        ]),
        asst("done"),
      ]),
    });
    expect(transport.calls).toHaveLength(2);
    expect(r.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("returns a tool failure to the model instead of faking success", async () => {
    const transport = transportOf((type) => {
      if (type === "cmd/track.add") throw { code: "denied_by_engine", message: "nope" };
      return {};
    });
    const r = await runAgentTurn({
      messages: [{ role: "user", content: "add" }],
      transport,
      yolo: true, // skip approval so we test the failure path
      client: scripted([
        asst(null, [call("c1", "mydaw_execute", { operation: "cmd/track.add", payload: {} })]),
        asst("handled"),
      ]),
    });
    const toolMsg = r.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("denied_by_engine");
    expect(r.stopped).toBe("complete");
  });

  it("stops at the max-step guard", async () => {
    const r = await runAgentTurn({
      ...base(),
      maxSteps: 2,
      client: scripted([asst(null, [call("c", "mydaw_query", { view: "tracks" })])]), // never finishes
    });
    expect(r.stopped).toBe("max-steps");
    expect(r.steps).toBe(2);
  });

  it("stops when the model repeats the same failing call (anti-spin guard)", async () => {
    const transport = transportOf(() => {
      throw { code: "invalid_arguments", message: "notes requires where.clipId" };
    });
    const events: AgentEvent[] = [];
    const r = await runAgentTurn({
      messages: [{ role: "user", content: "notes" }],
      transport,
      // read-only query — no approval needed; the model keeps repeating the same bad call
      client: scripted([asst(null, [call("c", "mydaw_query", { view: "notes" })])]),
      onEvent: (e) => events.push(e),
    });
    expect(r.stopped).toBe("error");
    expect(r.steps).toBe(3); // fails 3x then the guard trips
    expect(events.some((e) => e.kind === "error" && /repeated the same failing/.test(e.message))).toBe(true);
  });

  it("stops immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runAgentTurn({
      ...base(),
      client: scripted([asst("unused")]),
      signal: controller.signal,
    });
    expect(r.stopped).toBe("aborted");
    expect(r.steps).toBe(0);
  });

  it("stops after an abort raised mid-turn", async () => {
    const controller = new AbortController();
    const client: ChatClient = {
      async chat() {
        controller.abort(); // abort while producing the assistant message
        return asst(null, [call("c", "mydaw_query", { view: "tracks" })]);
      },
    };
    const r = await runAgentTurn({
      ...base(),
      client,
      signal: controller.signal,
    });
    expect(r.stopped).toBe("aborted");
    expect(r.steps).toBe(1);
  });

  describe("approval gating", () => {
    const mutating = () =>
      scripted([
        asst(null, [call("c1", "mydaw_execute", { operation: "cmd/track.add", payload: {} })]),
        asst("after"),
      ]);

    it("blocks a mutation when the user denies it", async () => {
      const transport = transportOf();
      const events: AgentEvent[] = [];
      const r = await runAgentTurn({
        messages: [{ role: "user", content: "add" }],
        transport,
        client: mutating(),
        approve: async () => "denied",
        onEvent: (e) => events.push(e),
      });
      expect(transport.calls.some(([t]) => t === "cmd/track.add")).toBe(false);
      expect(events.some((e) => e.kind === "approval-denied")).toBe(true);
      const toolMsg = r.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("user_denied");
    });

    it("runs a mutation when the user approves it", async () => {
      const transport = transportOf(() => ({ track: { id: 3 } }));
      await runAgentTurn({
        messages: [{ role: "user", content: "add" }],
        transport,
        client: mutating(),
        approve: async () => "approved",
      });
      expect(transport.calls.some(([t]) => t === "cmd/track.add")).toBe(true);
    });

    it("bypasses approval under YOLO with no approver", async () => {
      const transport = transportOf(() => ({ track: { id: 3 } }));
      await runAgentTurn({
        messages: [{ role: "user", content: "add" }],
        transport,
        client: mutating(),
        yolo: true,
      });
      expect(transport.calls.some(([t]) => t === "cmd/track.add")).toBe(true);
    });

    it("denies a mutation by default when no approver is provided", async () => {
      const transport = transportOf();
      const r = await runAgentTurn({
        messages: [{ role: "user", content: "add" }],
        transport,
        client: mutating(),
      });
      expect(transport.calls.some(([t]) => t === "cmd/track.add")).toBe(false);
      expect(r.messages.find((m) => m.role === "tool")?.content).toContain("user_denied");
    });
  });
});
