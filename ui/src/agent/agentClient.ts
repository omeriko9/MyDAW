/**
 * OpenAI-compatible chat client (Increment 4).
 *
 * Talks to a /chat/completions endpoint directly from the browser with a streaming SSE
 * parser and a non-streaming fallback. `fetch` is injectable so the tool loop and the
 * streaming parser are unit-testable without a network. The streaming tool-call delta
 * accumulator is exported (StreamAccumulator) and tested on raw SSE text.
 */

import type { ChatMessage, ToolCall, ToolDef } from "./agentTypes";

export class AgentClientError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AgentClientError";
    this.status = status;
  }
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  stream?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void; // streamed content tokens (streaming only)
}

export interface ChatResponse {
  message: ChatMessage; // assistant message (content and/or tool_calls)
  finishReason: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ToolCallAccum {
  id: string;
  name: string;
  args: string;
}

/**
 * Accumulates a streamed chat completion. Feed raw SSE text (as decoded from the response
 * body) via feed(); it tolerates chunk boundaries splitting lines or JSON. Content deltas
 * are forwarded to onDelta as they arrive; tool-call deltas are merged by index.
 */
export class StreamAccumulator {
  content = "";
  finishReason = "";
  private buffer = "";
  private toolCalls = new Map<number, ToolCallAccum>();
  private done = false;

  constructor(private readonly onDelta?: (text: string) => void) {}

  feed(text: string): void {
    this.buffer += text;
    let nl: number;
    // SSE events are newline-delimited "data: <json>" lines; process complete lines only.
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  /** Flush any trailing buffered line (streams that end without a final newline). */
  end(): void {
    const line = this.buffer.trim();
    this.buffer = "";
    if (line) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!line.startsWith("data:")) return; // ignore comments / other SSE fields
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      this.done = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // partial/invalid JSON line — skip defensively
    }
    this.consumeChunk(parsed);
  }

  private consumeChunk(chunk: unknown): void {
    const choice = (chunk as { choices?: unknown[] })?.choices?.[0] as
      | {
          delta?: {
            content?: unknown;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }
      | undefined;
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      this.content += delta.content;
      this.onDelta?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = typeof tc.index === "number" ? tc.index : 0;
      const acc = this.toolCalls.get(index) ?? { id: "", name: "", args: "" };
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name = tc.function.name;
      if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
      this.toolCalls.set(index, acc);
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  result(): ChatResponse {
    const toolCalls: ToolCall[] = [...this.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, tc]) => ({
        id: tc.id || `call_${index}`,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args },
      }));
    const message: ChatMessage = {
      role: "assistant",
      content: this.content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    return {
      message,
      finishReason: this.finishReason || (this.done ? "stop" : ""),
    };
  }
}

/** Parse a non-streaming completion body into a ChatResponse. */
export function parseCompletion(body: unknown): ChatResponse {
  const choice = (body as { choices?: unknown[] })?.choices?.[0] as
    | { message?: ChatMessage; finish_reason?: string }
    | undefined;
  const msg = choice?.message;
  const message: ChatMessage = {
    role: "assistant",
    content: typeof msg?.content === "string" ? msg.content : null,
    ...(msg?.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
  };
  return { message, finishReason: choice?.finish_reason ?? "stop" };
}

export class AgentClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly apiKey = "",
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey.trim()) h.authorization = `Bearer ${this.apiKey.trim()}`;
    return h;
  }

  /** GET /models — returns the model id list (empty on shape mismatch). */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetchImpl(`${this.endpoint}/models`, {
      method: "GET",
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new AgentClientError(res.status, await safeText(res));
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const stream = req.stream !== false; // default to streaming
    const payload = {
      model: this.model,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools, tool_choice: "auto" } : {}),
      temperature: req.temperature ?? 0.7,
      stream,
    };
    const res = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: req.signal,
    });
    if (!res.ok) throw new AgentClientError(res.status, await safeText(res));

    if (!stream || !res.body) {
      return parseCompletion(await res.json());
    }
    const acc = new StreamAccumulator(req.onDelta);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc.feed(decoder.decode(value, { stream: true }));
    }
    acc.feed(decoder.decode());
    acc.end();
    return acc.result();
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return `HTTP ${res.status}: ${t.slice(0, 500)}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
