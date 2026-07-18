/**
 * Agent tool definitions and executor (Increment 4).
 *
 * The in-app agent sees the same six logical tools as the MCP surface, but executes them
 * itself: read/query/execute/batch go through the engine WebSocket (injected transport);
 * context/describe are computed locally from the canonical catalog; mydaw_ui is routed to a
 * typed UI executor in Increment 5 (until then it reports ui_unavailable).
 */

import { AGENT_CATALOG } from "./catalog.gen";
import type { AgentTransport, ToolDef, ToolResult } from "./agentTypes";

const SCHEMAS = AGENT_CATALOG.schemas as Record<string, Record<string, unknown>>;

/** Recursively inline "#/schemas/X" refs so a described op has a self-contained schema. */
function inlineSchema(schema: unknown, depth = 0): unknown {
  if (depth > 12 || schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((s) => inlineSchema(s, depth + 1));
  const obj = schema as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const m = /^#\/schemas\/(.+)$/.exec(obj.$ref);
    if (m && SCHEMAS[m[1]]) return inlineSchema(SCHEMAS[m[1]], depth + 1);
    return schema;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = inlineSchema(v, depth + 1);
  return out;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length ? { required } : {}),
});

/** OpenAI function-tool schemas advertised to the model (mirror the MCP tools). */
export const AGENT_TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "mydaw_context",
      description:
        "Compact snapshot of the current project, revision, transport, and capability " +
        "categories. Call this first.",
      parameters: obj({}),
    },
  },
  {
    type: "function",
    function: {
      name: "mydaw_describe",
      description:
        "Search capabilities and, for a specific operation name, retrieve its exact input " +
        "schema and examples.",
      parameters: obj({
        query: { type: "string" },
        category: { type: "string" },
        name: { type: "string" },
        limit: { type: "integer" },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "mydaw_query",
      description:
        "Read filtered, paginated project/runtime data by view (tracks, clips, notes, " +
        "plugin_instances, transport, …). Every response carries the engine revision.",
      parameters: obj(
        {
          view: { type: "string" },
          where: { type: "object" },
          fields: { type: "array", items: { type: "string" } },
          limit: { type: "integer" },
          cursor: { type: ["string", "null"] },
        },
        ["view"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "mydaw_execute",
      description:
        "Execute one catalog operation (use mydaw_describe for its schema). Optional " +
        "expectedRevision guards against stale writes.",
      parameters: obj(
        {
          operation: { type: "string" },
          payload: { type: "object" },
          expectedRevision: { type: "integer" },
        },
        ["operation"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "mydaw_batch",
      description:
        "Validate and execute an ordered atomic group of up to 64 undoable cmd/* edits as " +
        "one undo checkpoint; rolls back entirely on any failure. Each item is " +
        '{ type: "cmd/…", payload: {…}, as?: "alias" } — note the key is "type" (not ' +
        '"operation" as in mydaw_execute).',
      parameters: obj(
        {
          operations: { type: "array" },
          expectedRevision: { type: "integer" },
          label: { type: "string" },
        },
        ["operations"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "mydaw_ui",
      description:
        "Invoke a typed high-level UI action (selection, reveal, focus, panels, tools, " +
        "theme). Returns ui_unavailable when no MyDAW window is controllable.",
      parameters: obj({ operation: { type: "string" }, payload: { type: "object" } }, [
        "operation",
      ]),
    },
  },
];

export const AGENT_TOOL_NAMES = new Set(AGENT_TOOL_DEFS.map((t) => t.function.name));

/** Whether the tool call can run without an approval (read-only tools). */
export function isReadOnlyTool(name: string): boolean {
  return name === "mydaw_context" || name === "mydaw_describe" || name === "mydaw_query";
}

/**
 * Normalize a mydaw_batch argument object so each operation item uses `type` (the engine's
 * required key). Models routinely reuse the `operation` key from mydaw_execute, so accept it
 * as an alias — otherwise the engine rejects the whole batch with an opaque "accepts only
 * type, payload, and as" error the model can't map back to its mistake.
 */
export function normalizeBatchArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(args.operations)) return args;
  const operations = args.operations.map((o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return o;
    const item = o as Record<string, unknown>;
    if (item.type === undefined && typeof item.operation === "string") {
      const { operation, ...rest } = item;
      return { type: operation, ...rest };
    }
    return item;
  });
  return { ...args, operations };
}

/**
 * The catalog operation name(s) a tool call would run, for approval classification.
 * Read-only meta tools return [].
 */
export function operationsForCall(name: string, args: Record<string, unknown>): string[] {
  if (name === "mydaw_execute" || name === "mydaw_ui") {
    return typeof args.operation === "string" ? [args.operation] : [];
  }
  if (name === "mydaw_batch") {
    const ops = Array.isArray(args.operations) ? args.operations : [];
    return ops
      .map((o) => {
        if (!o || typeof o !== "object") return undefined;
        const item = o as { type?: unknown; operation?: unknown };
        return typeof item.type === "string"
          ? item.type
          : typeof item.operation === "string"
            ? item.operation
            : undefined;
      })
      .filter((t): t is string => typeof t === "string");
  }
  return [];
}

function ok(structured: unknown, content?: string): ToolResult {
  return { content: content ?? summarize(structured), structured };
}

function fail(code: string, message: string): ToolResult {
  return { content: `${code}: ${message}`, isError: true, structured: { code, message } };
}

function summarize(value: unknown): string {
  const s = JSON.stringify(value);
  return s.length > 12000 ? `${s.slice(0, 12000)} …(truncated)` : s;
}

interface ErrLike {
  code?: string;
  message?: string;
}

function transportError(e: unknown): ToolResult {
  const err = e as ErrLike;
  return fail(err?.code ?? "error", err?.message ?? String(e));
}

/** A typed UI executor for ui/* operations (injected so the loop stays store-decoupled). */
export type UiExecutor = (operation: string, payload: unknown) => unknown;

/** Execute one tool call. `argsRaw` is the model-supplied JSON string. Never throws. */
export async function executeTool(
  name: string,
  argsRaw: string,
  transport: AgentTransport,
  uiExecutor?: UiExecutor,
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    const parsed = argsRaw.trim() ? JSON.parse(argsRaw) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("invalid_arguments", "tool arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return fail("invalid_arguments", "tool arguments were not valid JSON");
  }

  switch (name) {
    case "mydaw_context":
      return toolContext(transport);
    case "mydaw_describe":
      return toolDescribe(args);
    case "mydaw_query":
      try {
        return ok(await transport.send("agent/query", args));
      } catch (e) {
        return transportError(e);
      }
    case "mydaw_batch":
      try {
        return ok(await transport.send("agent/batch", normalizeBatchArgs(args)));
      } catch (e) {
        return transportError(e);
      }
    case "mydaw_execute": {
      if (typeof args.operation !== "string") {
        return fail("invalid_arguments", "mydaw_execute requires an operation string");
      }
      const payload =
        args.payload && typeof args.payload === "object" && !Array.isArray(args.payload)
          ? (args.payload as Record<string, unknown>)
          : {};
      if (typeof args.expectedRevision === "number") {
        try {
          const summaryRes = (await transport.send("agent/query", {
            view: "project_summary",
            fields: ["name"],
          })) as { revision?: number };
          const current = summaryRes?.revision ?? 0;
          if (current !== args.expectedRevision) {
            return fail(
              "stale_revision",
              `expected revision ${args.expectedRevision}, current revision is ${current}`,
            );
          }
        } catch (e) {
          return transportError(e);
        }
      }
      try {
        return ok(await transport.send(args.operation, payload));
      } catch (e) {
        return transportError(e);
      }
    }
    case "mydaw_ui": {
      if (!uiExecutor) {
        return fail("ui_unavailable", "no UI controller is registered");
      }
      if (typeof args.operation !== "string") {
        return fail("invalid_arguments", "mydaw_ui requires an operation string");
      }
      try {
        const result = uiExecutor(args.operation, args.payload ?? {});
        return ok(result);
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return fail(err?.code ?? "ui_error", err?.message ?? String(e));
      }
    }
    default:
      return fail("unknown_tool", `unknown tool: ${name}`);
  }
}

async function toolContext(transport: AgentTransport): Promise<ToolResult> {
  const read = async (view: string): Promise<unknown> => {
    try {
      const res = (await transport.send("agent/query", { view })) as {
        items?: unknown[];
        revision?: number;
      };
      const item =
        Array.isArray(res?.items) && res.items.length > 0 ? res.items[0] : res;
      return { value: item, revision: res?.revision ?? 0 };
    } catch (e) {
      return { error: (e as ErrLike)?.message ?? String(e) };
    }
  };
  const summary = (await read("project_summary")) as { value?: unknown; revision?: number };
  const transportView = await read("transport");
  const engine = await read("engine_status");

  const categories: Record<string, number> = {};
  for (const op of AGENT_CATALOG.operations) {
    categories[op.category] = (categories[op.category] ?? 0) + 1;
  }

  return ok({
    revision: summary?.revision ?? 0,
    project: summary?.value ?? null,
    transport: (transportView as { value?: unknown })?.value ?? null,
    engine: (engine as { value?: unknown })?.value ?? null,
    availability: { project: true, uiController: false },
    capabilityCategories: categories,
    hint:
      "Use mydaw_describe for schemas, mydaw_query to read ids/values, mydaw_execute or " +
      "mydaw_batch to edit.",
  });
}

function toolDescribe(args: Record<string, unknown>): ToolResult {
  const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
  const category = typeof args.category === "string" ? args.category : "";
  const name = typeof args.name === "string" ? args.name : "";
  const limit = Math.max(1, Math.min(typeof args.limit === "number" ? args.limit : 25, 100));

  const brief = (op: (typeof AGENT_CATALOG.operations)[number]) => ({
    name: op.name,
    category: op.category,
    description: op.description,
    target: op.target,
    mode: op.mode,
    traits: op.traits,
    supports: op.supports,
    requires: op.requires,
  });

  const full = (op: (typeof AGENT_CATALOG.operations)[number]) => ({
    ...brief(op),
    input: inlineSchema(op.input),
    output: inlineSchema(op.output),
    examples: op.examples,
  });

  let operations: unknown[] = [];
  if (name) {
    // Be forgiving: an exact operation name first, else any op whose name contains it (so
    // "track.add" resolves to "cmd/track.add" without the model having to know the prefix).
    const lname = name.toLowerCase();
    let matches = AGENT_CATALOG.operations.filter((o) => o.name === name);
    if (matches.length === 0) {
      matches = AGENT_CATALOG.operations.filter((o) => o.name.toLowerCase().includes(lname));
    }
    operations = matches.slice(0, limit).map(full);
  } else {
    for (const op of AGENT_CATALOG.operations) {
      if (category && op.category !== category) continue;
      if (query) {
        const hay = `${op.name} ${op.category} ${op.description}`.toLowerCase();
        if (!hay.includes(query)) continue;
      }
      operations.push(brief(op));
      if (operations.length >= limit) break;
    }
  }
  return ok({ total: operations.length, operations });
}
