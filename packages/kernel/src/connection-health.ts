/** Workspace/owner boundary of one pooled MCP connection. */
export interface ConnectionPoolScope {
  workspace: string;
  owner: string;
}

/** Kernel-owned projection of downstream MCP connection health. */
export interface ConnectionEvent {
  connection_id: string;
  scope: ConnectionPoolScope;
  mcp_name: string;
  transport: "stdio" | "http" | "sse";
  state: "unavailable" | "recovered" | "closed";
  cause?: "timeout" | "transport" | "reconnect_failed";
}

export type ConnectionEventSink = (event: ConnectionEvent) => void;
