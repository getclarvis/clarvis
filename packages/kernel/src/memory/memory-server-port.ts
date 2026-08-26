/**
 * The tool-server seam an `mcp` memory provider calls through.
 *
 * Built here rather than inside `@clarvis/memory`, which declares the port
 * structurally and names no MCP type — the same arrangement that keeps the
 * engine from naming whoever provides `TaskTrackingPort`. This module is where
 * the two halves meet, and it is the only place that knows both.
 */
import { bestEffort, contentToText, type McpServerConfig } from "@clarvis/capability";
import type { MemoryServerPort, MemoryServerPortResolver } from "@clarvis/memory/capability";

/** What {@link createMemoryServerPort} needs from the surrounding kernel. */
export interface MemoryServerPortDeps {
  /**
   * The workspace's declared MCP servers, re-read per call.
   *
   * @remarks A function rather than a snapshot, so editing `settings.json` takes
   * effect on the next memory call instead of at the next restart — the same
   * rule every other settings consumer in the kernel follows.
   */
  servers: () => Record<string, McpServerConfig> | undefined;
  /** The connection pool a lease is taken from. */
  connections: {
    acquire(opts: { server: McpServerConfig; owner: string; signal?: AbortSignal }): Promise<{
      conn: {
        callTool(
          tool: string,
          args: unknown,
          signal?: AbortSignal,
        ): Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>;
      };
      release: () => Promise<void>;
    }>;
  };
}

/**
 * Build the port.
 *
 * @param deps - the declared servers and shared connection pool.
 * @returns a resolver that binds one {@link MemoryServerPort} to an owner before
 *   any provider tool can call it. Every failure is answered as a failed call
 *   rather than a throw, matching the posture a provider's tools already
 *   present to the model.
 * @remarks A lease is acquired **per call** and released in a `finally`. Memory
 *   calls are sparse next to a run's ordinary tool traffic, and holding a
 *   connection open for the whole run would keep a subprocess alive for a
 *   capability the run may never use.
 */
export function createMemoryServerPort(deps: MemoryServerPortDeps): MemoryServerPortResolver {
  return {
    forOwner(owner): MemoryServerPort {
      return {
        async callTool(server, tool, args, signal) {
          const config = deps.servers()?.[server];
          if (config === undefined) {
            return { text: `no MCP server named '${server}' is configured`, isError: true };
          }
          let lease:
            Awaited<ReturnType<MemoryServerPortDeps["connections"]["acquire"]>> | undefined;
          try {
            lease = await deps.connections.acquire({
              server: config,
              owner,
              ...(signal !== undefined ? { signal } : {}),
            });
            const res = await lease.conn.callTool(tool, args, signal);
            if (!res.ok) return { text: res.error?.message ?? `'${tool}' failed`, isError: true };
            /**
             * A server's payload is `unknown` on the wire; `contentToText` already
             * knows every shape a tool result arrives in, so it is narrowed here
             * rather than reshaped.
             */
            return {
              text: contentToText(res.data as Parameters<typeof contentToText>[0]),
              isError: false,
            };
          } catch (err) {
            return { text: err instanceof Error ? err.message : String(err), isError: true };
          } finally {
            if (lease !== undefined) {
              const acquiredLease = lease;
              await bestEffort(() => acquiredLease.release(), {
                operation: "memory_mcp_lease_release",
              });
            }
          }
        },
      };
    },
  };
}
