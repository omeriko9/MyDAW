import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_DEFS,
  executeTool,
  isReadOnlyTool,
  operationsForCall,
} from "./agentTools";
import type { AgentTransport } from "./agentTypes";

function transportOf(
  impl: (type: string, payload: unknown) => unknown,
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

describe("tool metadata", () => {
  it("advertises exactly the six tools", () => {
    expect(AGENT_TOOL_DEFS.map((t) => t.function.name).sort()).toEqual([
      "mydaw_batch",
      "mydaw_context",
      "mydaw_describe",
      "mydaw_execute",
      "mydaw_query",
      "mydaw_ui",
    ]);
  });
  it("classifies read-only tools and resolves operation names", () => {
    expect(isReadOnlyTool("mydaw_query")).toBe(true);
    expect(isReadOnlyTool("mydaw_execute")).toBe(false);
    expect(operationsForCall("mydaw_execute", { operation: "cmd/track.add" })).toEqual([
      "cmd/track.add",
    ]);
    expect(
      operationsForCall("mydaw_batch", {
        operations: [{ type: "cmd/marker.add" }, { type: "cmd/marker.add" }],
      }),
    ).toEqual(["cmd/marker.add", "cmd/marker.add"]);
    // approval classification also sees ops that used the 'operation' alias key
    expect(
      operationsForCall("mydaw_batch", {
        operations: [{ operation: "cmd/track.set" }, { type: "cmd/plugin.add" }],
      }),
    ).toEqual(["cmd/track.set", "cmd/plugin.add"]);
  });
});

describe("executeTool routing", () => {
  it("routes mydaw_query to agent/query", async () => {
    const t = transportOf(() => ({ view: "tracks", revision: 3, items: [] }));
    const res = await executeTool("mydaw_query", '{"view":"tracks"}', t);
    expect(res.isError).toBeFalsy();
    expect(t.calls[0]).toEqual(["agent/query", { view: "tracks" }]);
  });

  it("routes mydaw_batch to agent/batch", async () => {
    const t = transportOf(() => ({ revision: 5, results: [] }));
    await executeTool("mydaw_batch", '{"operations":[]}', t);
    expect(t.calls[0][0]).toBe("agent/batch");
  });

  it("normalizes batch item 'operation' key to the engine's 'type'", async () => {
    const t = transportOf(() => ({ revision: 6, results: [] }));
    await executeTool(
      "mydaw_batch",
      '{"operations":[{"operation":"cmd/plugin.add","payload":{"trackId":4}},' +
        '{"type":"cmd/marker.add","payload":{"beat":0}}]}',
      t,
    );
    const sent = t.calls[0][1] as { operations: Array<Record<string, unknown>> };
    expect(sent.operations[0]).toEqual({ type: "cmd/plugin.add", payload: { trackId: 4 } });
    expect(sent.operations[0]).not.toHaveProperty("operation");
    expect(sent.operations[1]).toEqual({ type: "cmd/marker.add", payload: { beat: 0 } });
  });

  it("routes mydaw_execute to the operation type", async () => {
    const t = transportOf(() => ({ track: { id: 9 } }));
    const res = await executeTool(
      "mydaw_execute",
      '{"operation":"cmd/track.add","payload":{"kind":"midi"}}',
      t,
    );
    expect(t.calls[0]).toEqual(["cmd/track.add", { kind: "midi" }]);
    expect((res.structured as { track: { id: number } }).track.id).toBe(9);
  });

  it("prechecks expectedRevision and reports stale without mutating", async () => {
    const t = transportOf((type) =>
      type === "agent/query" ? { revision: 2 } : { track: { id: 1 } },
    );
    const res = await executeTool(
      "mydaw_execute",
      '{"operation":"cmd/track.add","payload":{},"expectedRevision":1}',
      t,
    );
    expect(res.isError).toBe(true);
    expect((res.structured as { code: string }).code).toBe("stale_revision");
    expect(t.calls.some(([type]) => type === "cmd/track.add")).toBe(false);
  });

  it("surfaces a transport error as an isError tool result", async () => {
    const t = transportOf(() => {
      throw { code: "not_found", message: "unknown instanceId" };
    });
    const res = await executeTool("mydaw_query", '{"view":"plugin_params"}', t);
    expect(res.isError).toBe(true);
    expect((res.structured as { code: string }).code).toBe("not_found");
  });

  it("rejects invalid JSON arguments", async () => {
    const t = transportOf(() => ({}));
    const res = await executeTool("mydaw_query", "{not json", t);
    expect(res.isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  it("reports mydaw_ui as unavailable (no controller yet)", async () => {
    const t = transportOf(() => ({}));
    const res = await executeTool("mydaw_ui", '{"operation":"ui/theme.set"}', t);
    expect(res.isError).toBe(true);
    expect((res.structured as { code: string }).code).toBe("ui_unavailable");
  });
});

describe("mydaw_describe (local, no transport)", () => {
  const t = transportOf(() => {
    throw new Error("describe must not hit the transport");
  });

  it("returns a self-contained (ref-inlined) schema for a named op", async () => {
    const res = await executeTool("mydaw_describe", '{"name":"cmd/track.add"}', t);
    const ops = (res.structured as { operations: Array<{ name: string; input: unknown }> })
      .operations;
    expect(ops[0].name).toBe("cmd/track.add");
    expect(JSON.stringify(ops[0].input)).not.toContain("$ref");
  });

  it("resolves a name without the cmd/ prefix (forgiving describe)", async () => {
    const res = await executeTool("mydaw_describe", '{"name":"track.add"}', t);
    const ops = (res.structured as { operations: Array<{ name: string; input: unknown }> })
      .operations;
    expect(ops.some((o) => o.name === "cmd/track.add")).toBe(true);
    expect(ops[0].input).toBeTruthy(); // full schema returned for a name lookup
  });

  it("searches by query", async () => {
    const res = await executeTool("mydaw_describe", '{"query":"marker","limit":5}', t);
    const ops = (res.structured as { operations: Array<{ name: string }> }).operations;
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => JSON.stringify(o).toLowerCase().includes("marker"))).toBe(true);
  });
});

describe("mydaw_context", () => {
  it("aggregates queries and capability categories", async () => {
    const t = transportOf((_type, payload) => {
      const view = (payload as { view: string }).view;
      return { view, revision: 7, items: [{ view }] };
    });
    const res = await executeTool("mydaw_context", "{}", t);
    const ctx = res.structured as {
      revision: number;
      capabilityCategories: Record<string, number>;
      availability: { uiController: boolean };
    };
    expect(ctx.revision).toBe(7);
    expect(Object.keys(ctx.capabilityCategories).length).toBeGreaterThan(0);
    expect(ctx.availability.uiController).toBe(false);
  });
});
