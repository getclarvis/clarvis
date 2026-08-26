/** Transport-neutral classification supplied by the host after an operational failure. */
export interface TaskServerFailure {
  kind: "cancelled" | "timeout" | "unavailable" | "operational";
  /** Present only when the request may have reached the server. */
  outcome?: "unknown";
}

/** The deliberately narrow server seam consumed by the MCP task provider. */
export interface TaskServerPort {
  callTool(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    data?: unknown;
    isError: boolean;
    message?: string;
    failure?: TaskServerFailure;
  }>;
}

/** Host-owned immutable binding captured from one effective settings snapshot. */
export interface TaskServerBinding {
  readonly server: string;
  /** Structurally opaque here; the kernel validates and owns the MCP declaration. */
  readonly declaration: unknown;
}

/** Binds the seam to one authenticated owner and one resolved backend. */
export interface TaskServerPortResolver {
  forOwner(owner: string, binding: TaskServerBinding): TaskServerPort;
}
