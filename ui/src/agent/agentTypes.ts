/**
 * Shared types for the in-app agent runtime (Increment 4).
 *
 * The agent talks to an OpenAI-compatible /chat/completions endpoint directly from the
 * browser and executes tool calls itself through the engine WebSocket (agent/query,
 * agent/batch, catalog operations) and, later, a typed UI executor. Nothing here touches
 * MCP — MCP is the separate external surface (Increment 3).
 */

/** OpenAI-style chat roles used in the conversation array sent to the model. */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** One tool call requested by the assistant. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string }; // arguments is a JSON string
}

/** One message in the OpenAI conversation array. */
export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** assistant messages may request tool calls */
  tool_calls?: ToolCall[];
  /** tool messages answer a specific tool call */
  tool_call_id?: string;
  /** optional display name (tool messages) */
  name?: string;
}

/** OpenAI function-tool definition advertised to the model. */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/** Per-user LLM configuration (persisted under settings.llm). */
export interface LlmConfig {
  endpoint: string; // OpenAI-compatible base, e.g. http://localhost:8038/v1
  model: string;
  apiKey: string; // optional; local plaintext (documented in the UI)
  temperature: number;
  maxSteps: number;
  yolo: boolean;
}

/** Result of executing one tool call. `isError` mirrors the MCP tool-error convention. */
export interface ToolResult {
  content: string; // text summary returned to the model
  structured?: unknown; // machine-readable payload (not sent to the model verbatim)
  isError?: boolean;
}

/** Engine transport used by the tool executor (injected so the loop is unit-testable). */
export interface AgentTransport {
  send(type: string, payload: unknown): Promise<unknown>;
}

/**
 * Approval decision for a mutating tool call. The runtime pauses and asks the host
 * (the panel, in Increment 5) unless YOLO mode is on or the call is read-only.
 */
export type ApprovalDecision = "approved" | "denied";
export type ApprovalRequester = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface ApprovalRequest {
  toolName: string;
  /** the resolved operation name(s) the call would run */
  operations: string[];
  /** human-facing classification of the effect */
  classification: OperationClassification;
  /** the raw arguments the model supplied */
  args: unknown;
}

/** Catalog-derived risk classification of an operation. */
export interface OperationClassification {
  mutating: boolean;
  undoable: boolean;
  destructive: boolean;
  external: boolean;
  fileSystem: boolean;
  uiOnly: boolean;
  known: boolean; // false when the operation name is not in the catalog
}

/** Events emitted by the tool loop so a host UI can render progress. */
export type AgentEvent =
  | { kind: "assistant-delta"; text: string }
  | { kind: "assistant-message"; message: ChatMessage }
  | { kind: "tool-start"; toolCallId: string; name: string; args: unknown }
  | { kind: "tool-result"; toolCallId: string; name: string; result: ToolResult }
  | { kind: "approval-denied"; toolCallId: string; name: string }
  | { kind: "status"; text: string }
  | { kind: "error"; message: string }
  | { kind: "done"; steps: number; stopped: "complete" | "max-steps" | "aborted" | "error" };
