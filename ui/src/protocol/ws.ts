/**
 * WebSocket client for the engine protocol (SPEC §5).
 *
 * - request/reply with id matching, per-type timeout (default 15 s; native dialogs and
 *   long project IO get minutes — see timeoutFor), rejects with WsRequestError on
 *   {ok:false} replies (carrying the engine's error code/message).
 * - auto-reconnect with exponential backoff (0.5 s → 10 s).
 * - event subscription: on("event/...", cb) / off(...).
 * - onReconnect(cb): fired on EVERY successful open (including the first connection) —
 *   the store uses it to (re-)send session/hello (SPEC §9: "On reconnect → session/hello re-sync").
 * - connection state subscribable via onStateChange.
 */

import type {
  EventMap,
  EventType,
  ReplyPayload,
  RequestPayload,
  RequestType,
} from "./types";

export type ConnectionState = "connecting" | "open" | "closed";

export class WsRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WsRequestError";
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: WsRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
  type: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Per-type reply timeouts. The engine replies to dialog/* (and to project/save with no
 * path, export/* with no path, …) only AFTER the user closes its native picker — these
 * are user-paced and can legitimately take minutes. A short timeout here used to fire
 * mid-dialog and the late reply was then dropped, so the whole flow silently no-op'd.
 */
const TYPE_TIMEOUT_MS: Record<string, number> = {
  "project/importForeign": 180_000,
  "project/load": 120_000,
  "project/loadRecent": 120_000,
  "project/save": 120_000,
  "project/saveAs": 120_000,
  // recover runs the same heavy path as load (full plugin recreation + asset IO)
  "project/recover": 120_000,
  // media/import decodes every file engine-side (resample + peaks) before replying
  "media/import": 180_000,
  "plugins/recreate": 600_000,
  // export with no path opens a native save dialog engine-side; render is also long.
  "export/render": 600_000,
  "export/midi": 600_000,
  "export/trackArchive": 600_000,
  "export/cpr": 600_000,
};

function timeoutFor(type: string): number {
  if (type.startsWith("dialog/")) return 600_000; // native file dialogs — user-paced
  return TYPE_TIMEOUT_MS[type] ?? DEFAULT_TIMEOUT_MS;
}

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const BACKOFF_FACTOR = 1.7;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEventCb = (payload: any) => void;

export class WsClient {
  private url = "";
  private sock: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Map<string, Set<AnyEventCb>>();
  private stateSubs = new Set<(s: ConnectionState) => void>();
  private reconnectHooks = new Set<() => void>();
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stateValue: ConnectionState = "closed";

  get state(): ConnectionState {
    return this.stateValue;
  }

  /**
   * Start the connection (idempotent). Default URL derives from the page location so it
   * works both through the vite dev proxy and when the engine serves ui/dist directly.
   */
  connect(url?: string): void {
    if (url) this.url = url;
    if (!this.url) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      this.url = `${proto}//${window.location.host}/ws`;
    }
    if (this.started) return;
    this.started = true;
    this.open();
  }

  /** Stop reconnecting and close the socket. */
  disconnect(): void {
    this.started = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.onopen = s.onclose = s.onmessage = s.onerror = null;
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.failAllPending("disconnected", "connection closed by client");
    this.setState("closed");
  }

  /**
   * Send a request and await its reply payload. Fully typed via RequestMap.
   * `transient: true` is placed at the envelope top level (SPEC §5): apply to model+audio,
   * no undo entry, no projectChanged broadcast — used while dragging faders/knobs.
   * `timeoutMs` overrides the per-type reply timeout (see timeoutFor).
   */
  request<K extends RequestType>(
    type: K,
    payload: RequestPayload<K>,
    transient?: boolean,
    timeoutMs?: number,
  ): Promise<ReplyPayload<K>> {
    return new Promise<ReplyPayload<K>>((resolve, reject) => {
      if (!this.sock || this.sock.readyState !== WebSocket.OPEN) {
        reject(new WsRequestError("not_connected", `cannot send ${type}: socket not open`));
        return;
      }
      const id = this.nextId++;
      const envelope: Record<string, unknown> = { id, type, payload: payload ?? {} };
      if (transient) envelope.transient = true;
      const tmo = timeoutMs ?? timeoutFor(type);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WsRequestError("timeout", `request ${type} (#${id}) timed out after ${tmo} ms`));
      }, tmo);
      this.pending.set(id, {
        resolve: resolve as (p: unknown) => void,
        reject,
        timer,
        type,
      });
      try {
        this.sock.send(JSON.stringify(envelope));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new WsRequestError("send_failed", `failed to send ${type}: ${String(e)}`));
      }
    });
  }

  /**
   * Untyped request/reply for protocol types outside the typed RequestMap — the internal
   * agent primitives `agent/query` and `agent/batch` (the agent runtime's engine surface),
   * and dynamic `mydaw_execute` operation types resolved from the catalog at runtime.
   * Same envelope, timeouts, and error handling as request().
   */
  requestRaw(
    type: string,
    payload: unknown,
    opts?: { transient?: boolean; timeoutMs?: number },
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.sock || this.sock.readyState !== WebSocket.OPEN) {
        reject(new WsRequestError("not_connected", `cannot send ${type}: socket not open`));
        return;
      }
      const id = this.nextId++;
      const envelope: Record<string, unknown> = { id, type, payload: payload ?? {} };
      if (opts?.transient) envelope.transient = true;
      const tmo = opts?.timeoutMs ?? timeoutFor(type);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WsRequestError("timeout", `request ${type} (#${id}) timed out after ${tmo} ms`));
      }, tmo);
      this.pending.set(id, { resolve, reject, timer, type });
      try {
        this.sock.send(JSON.stringify(envelope));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new WsRequestError("send_failed", `failed to send ${type}: ${String(e)}`));
      }
    });
  }

  /** Subscribe to an engine event. Returns an unsubscribe function. */
  on<K extends EventType>(eventType: K, cb: (payload: EventMap[K]) => void): () => void {
    let set = this.listeners.get(eventType);
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    set.add(cb as AnyEventCb);
    return () => this.off(eventType, cb);
  }

  off<K extends EventType>(eventType: K, cb: (payload: EventMap[K]) => void): void {
    this.listeners.get(eventType)?.delete(cb as AnyEventCb);
  }

  /**
   * Hook fired after every successful socket open (initial connect AND reconnects).
   * Used for session/hello re-sync. Returns an unsubscribe function.
   */
  onReconnect(cb: () => void): () => void {
    this.reconnectHooks.add(cb);
    return () => {
      this.reconnectHooks.delete(cb);
    };
  }

  /**
   * Subscribe to connection state changes; the callback is invoked immediately with the
   * current state. Returns an unsubscribe function.
   */
  onStateChange(cb: (s: ConnectionState) => void): () => void {
    this.stateSubs.add(cb);
    cb(this.stateValue);
    return () => {
      this.stateSubs.delete(cb);
    };
  }

  /* ------------------------------------------------------------------ */

  private open(): void {
    this.reconnectTimer = null;
    this.setState("connecting");
    let s: WebSocket;
    try {
      s = new WebSocket(this.url);
    } catch (e) {
      console.error("[ws] failed to create WebSocket:", e);
      this.scheduleReconnect();
      return;
    }
    this.sock = s;
    s.onopen = () => {
      if (this.sock !== s) return;
      this.backoffMs = BACKOFF_MIN_MS;
      this.setState("open");
      for (const hook of [...this.reconnectHooks]) {
        try {
          hook();
        } catch (e) {
          console.error("[ws] onReconnect hook threw:", e);
        }
      }
    };
    s.onclose = () => {
      if (this.sock !== s) return;
      this.sock = null;
      this.failAllPending("disconnected", "connection lost");
      this.setState("closed");
      this.scheduleReconnect();
    };
    s.onerror = () => {
      /* onclose follows; nothing to do */
    };
    s.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      this.handleMessage(ev.data);
    };
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private handleMessage(data: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      console.error("[ws] non-JSON frame:", data.slice(0, 200));
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;

    if (typeof m.replyTo === "number") {
      const p = this.pending.get(m.replyTo);
      if (!p) return; // late reply after timeout — drop
      this.pending.delete(m.replyTo);
      clearTimeout(p.timer);
      if (m.ok === true) {
        p.resolve(m.payload ?? {});
      } else {
        const err = (m.error ?? {}) as { code?: string; message?: string };
        p.reject(
          new WsRequestError(err.code ?? "unknown", err.message ?? `request ${p.type} failed`),
        );
      }
      return;
    }

    if (typeof m.type === "string") {
      const set = this.listeners.get(m.type);
      if (!set || set.size === 0) return;
      const payload = m.payload ?? {};
      for (const cb of [...set]) {
        try {
          cb(payload);
        } catch (e) {
          console.error(`[ws] listener for ${m.type} threw:`, e);
        }
      }
    }
  }

  private failAllPending(code: string, message: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new WsRequestError(code, `${p.type}: ${message}`));
    }
    this.pending.clear();
  }

  private setState(s: ConnectionState): void {
    if (this.stateValue === s) return;
    this.stateValue = s;
    for (const cb of [...this.stateSubs]) {
      try {
        cb(s);
      } catch (e) {
        console.error("[ws] state subscriber threw:", e);
      }
    }
  }
}

/** App-wide singleton. Call ws.connect() once at startup (the shell does this). */
export const ws = new WsClient();
