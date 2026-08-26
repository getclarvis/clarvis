import { bestEffort, type McpServerConfig, type ToolResult } from "@clarvis/capability";
import type { TaskServerFailure, TaskServerPort, TaskServerPortResolver } from "@clarvis/tasks";

export interface TaskServerPortDeps {
  connections: {
    acquire(opts: {
      server: McpServerConfig;
      owner: string;
      signal?: AbortSignal;
      poolSharing?: "owner" | "workspace";
    }): Promise<{
      conn: {
        callTool(tool: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>;
      };
      release: () => Promise<void>;
    }>;
  };
}

function failureOf(result: ToolResult): TaskServerFailure {
  const error = result.error;
  const kind =
    error?.kind === "cancelled"
      ? "cancelled"
      : error?.kind === "timeout" || error?.code === "mcp_timeout"
        ? "timeout"
        : error?.kind === "unavailable" || error?.code === "mcp_unavailable"
          ? "unavailable"
          : "operational";
  return {
    kind,
    ...(error?.outcome === "unknown" ? { outcome: "unknown" as const } : {}),
  };
}

/**
 * Bind the domain's narrow port to the shared MCP pool.
 *
 * The resolver captures the exact validated declaration selected by the
 * provider factory. Every call acquires an owner-isolated lease for that frozen
 * backend and releases it in `finally`; a settings change can therefore affect
 * the next resolution, never redirect an in-flight provider. Lease teardown is
 * best-effort and cannot replace the already-known tool outcome, which would
 * otherwise make a safe retry indistinguishable from an uncertain write.
 */
export function createTaskServerPort(deps: TaskServerPortDeps): TaskServerPortResolver {
  return {
    forOwner(owner, binding): TaskServerPort {
      const declaration = binding.declaration as McpServerConfig;
      return {
        async callTool(tool, args, signal) {
          if (typeof declaration !== "object" || declaration === null) {
            return {
              isError: true,
              message: `the MCP binding for '${binding.server}' is invalid`,
              failure: { kind: "unavailable" },
            };
          }
          let lease: Awaited<ReturnType<TaskServerPortDeps["connections"]["acquire"]>> | undefined;
          try {
            lease = await deps.connections.acquire({
              server: declaration,
              owner,
              poolSharing: "owner",
              ...(signal === undefined ? {} : { signal }),
            });
            const result = await lease.conn.callTool(tool, args, signal);
            if (!result.ok) {
              return {
                isError: true,
                message: result.error?.message ?? `'${tool}' failed`,
                failure: failureOf(result),
              };
            }
            const payload = result.data;
            return {
              data:
                typeof payload === "object" && payload !== null
                  ? (payload as { structuredContent?: unknown }).structuredContent
                  : undefined,
              isError: false,
            };
          } catch (error) {
            return {
              isError: true,
              message: error instanceof Error ? error.message : String(error),
              failure: {
                kind: signal?.aborted === true ? "cancelled" : "unavailable",
                ...(lease === undefined ? {} : { outcome: "unknown" as const }),
              },
            };
          } finally {
            if (lease !== undefined) {
              const acquiredLease = lease;
              await bestEffort(() => acquiredLease.release(), {
                operation: "tasks_mcp_lease_release",
                workspace: binding.server,
              });
            }
          }
        },
      };
    },
  };
}
