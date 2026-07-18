/**
 * Multi-step agent tool loop (Increment 4).
 *
 * Drives the OpenAI-style conversation: ask the model, execute any tool calls, feed the
 * results back, and repeat until the model answers without tools or a guard trips
 * (max-steps, abort). Read-only tool calls run in parallel; mutations are serialized and
 * pass through approval unless YOLO mode is on. Tool failures are returned to the model as
 * tool messages — the loop never converts a failure into an apparent success.
 */

import {
  AGENT_TOOL_DEFS,
  executeTool,
  isReadOnlyTool,
  operationsForCall,
  type UiExecutor,
} from "./agentTools";
import { classifyOperations, needsApproval } from "./agentApprovals";
import type { ChatResponse } from "./agentClient";
import type {
  AgentEvent,
  AgentTransport,
  ApprovalRequester,
  ChatMessage,
  ToolCall,
  ToolDef,
  ToolResult,
} from "./agentTypes";

export interface ChatClient {
  chat(req: {
    messages: ChatMessage[];
    tools?: ToolDef[];
    temperature?: number;
    stream?: boolean;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  }): Promise<ChatResponse>;
}

export interface RunAgentTurnOptions {
  client: ChatClient;
  messages: ChatMessage[]; // conversation so far (not mutated; a new array is returned)
  transport: AgentTransport;
  tools?: ToolDef[];
  approve?: ApprovalRequester;
  yolo?: boolean;
  maxSteps?: number;
  temperature?: number;
  stream?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  uiExecutor?: UiExecutor;
}

export type StopReason = "complete" | "max-steps" | "aborted" | "error";

export interface RunAgentTurnResult {
  messages: ChatMessage[];
  steps: number;
  stopped: StopReason;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = raw.trim() ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolMessage(call: ToolCall, result: ToolResult): ChatMessage {
  return {
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content: result.content,
  };
}

/**
 * Run one user turn to completion: the model may take several tool steps before it produces
 * a final assistant message. Returns the full conversation including every new message.
 */
export async function runAgentTurn(
  options: RunAgentTurnOptions,
): Promise<RunAgentTurnResult> {
  const {
    client,
    transport,
    approve,
    yolo = false,
    maxSteps = 12,
    temperature,
    stream,
    signal,
    onEvent,
    uiExecutor,
  } = options;
  const tools = options.tools ?? AGENT_TOOL_DEFS;
  const emit = (e: AgentEvent) => onEvent?.(e);

  const messages: ChatMessage[] = [...options.messages];
  let steps = 0;

  // Guard against a weak model spinning on the same failing tool call: track how often each
  // (name+arguments) signature has errored this turn and stop once it repeats.
  const REPEAT_LIMIT = 3;
  const failureCounts = new Map<string, number>();
  let stalledSignature: string | null = null;

  const finish = (stopped: StopReason): RunAgentTurnResult => {
    emit({ kind: "done", steps, stopped });
    return { messages, steps, stopped };
  };

  try {
    for (;;) {
      if (signal?.aborted) return finish("aborted");
      if (steps >= maxSteps) {
        emit({ kind: "status", text: `stopped after ${maxSteps} steps` });
        return finish("max-steps");
      }
      steps += 1;

      const response = await client.chat({
        messages,
        tools,
        temperature,
        stream,
        signal,
        onDelta: (text) => emit({ kind: "assistant-delta", text }),
      });
      messages.push(response.message);
      emit({ kind: "assistant-message", message: response.message });

      const calls = response.message.tool_calls ?? [];
      if (calls.length === 0) return finish("complete");

      // Slot the tool replies by original index so message order is preserved regardless of
      // which calls run in parallel.
      const replies: (ChatMessage | null)[] = new Array(calls.length).fill(null);

      const runOne = async (call: ToolCall, index: number): Promise<void> => {
        emit({
          kind: "tool-start",
          toolCallId: call.id,
          name: call.function.name,
          args: parseArgs(call.function.arguments),
        });
        const result = await executeTool(
          call.function.name,
          call.function.arguments,
          transport,
          uiExecutor,
        );
        emit({ kind: "tool-result", toolCallId: call.id, name: call.function.name, result });
        if (result.isError) {
          const sig = `${call.function.name}:${call.function.arguments}`;
          const n = (failureCounts.get(sig) ?? 0) + 1;
          failureCounts.set(sig, n);
          if (n >= REPEAT_LIMIT) stalledSignature = call.function.name;
        }
        replies[index] = toolMessage(call, result);
      };

      // Pass 1: read-only calls run concurrently.
      const readOnly: Array<Promise<void>> = [];
      const mutating: Array<{ call: ToolCall; index: number }> = [];
      calls.forEach((call, index) => {
        if (isReadOnlyTool(call.function.name)) {
          readOnly.push(runOne(call, index));
        } else {
          mutating.push({ call, index });
        }
      });
      await Promise.all(readOnly);

      // Pass 2: mutating calls are serialized and gated by approval.
      for (const { call, index } of mutating) {
        if (signal?.aborted) return finish("aborted");
        const args = parseArgs(call.function.arguments);
        const ops = operationsForCall(call.function.name, args);
        const classification = classifyOperations(ops);
        if (needsApproval(classification, yolo)) {
          const decision = approve
            ? await approve({
                toolName: call.function.name,
                operations: ops,
                classification,
                args,
              })
            : "denied";
          if (decision === "denied") {
            emit({ kind: "approval-denied", toolCallId: call.id, name: call.function.name });
            replies[index] = toolMessage(call, {
              content:
                "user_denied: the user declined this action. Do not retry the same action; " +
                "propose a safer alternative or ask what to do.",
              isError: true,
            });
            continue;
          }
        }
        await runOne(call, index);
      }

      for (const reply of replies) {
        if (reply) messages.push(reply);
      }

      if (stalledSignature) {
        emit({
          kind: "error",
          message:
            `The model repeated the same failing ${stalledSignature} call ${REPEAT_LIMIT} times ` +
            "without making progress, so I stopped. Try rephrasing, or check the LLM model in " +
            "Settings → LLM (small models often struggle with tool use).",
        });
        return finish("error");
      }
    }
  } catch (error) {
    if (signal?.aborted) return finish("aborted");
    emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    return finish("error");
  }
}
