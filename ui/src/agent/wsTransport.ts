/**
 * Engine transport for the in-app agent (Increment 5) — backs AgentTransport with the
 * WebSocket client's untyped request path. agent/query and agent/batch and dynamic
 * mydaw_execute operation types all flow through here; WsRequestError carries the engine's
 * {code,message} so the tool layer can surface honest errors.
 */

import { ws } from "../protocol/ws";
import type { AgentTransport } from "./agentTypes";

export const wsTransport: AgentTransport = {
  send(type, payload) {
    return ws.requestRaw(type, payload);
  },
};
