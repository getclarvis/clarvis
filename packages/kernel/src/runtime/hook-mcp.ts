import { z } from "zod";
import type { McpServerConfig } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";

const callSchema = z
  .object({
    server: z.string().min(1).max(256),
    tool: z.string().min(1).max(256),
    input: z.unknown(),
  })
  .strict()
  .refine((call) => Object.hasOwn(call, "input"));

/**
 * Bind stdio hook execution to one guest run's admitted server snapshot and lifecycle.
 *
 * Early hooks may acquire a lease before the ordinary tool pool opens. Every lease is
 * owner-scoped and released after the call; no request can supply a command, environment,
 * remote endpoint or another owner's identity. Teardown cancels outstanding calls.
 */
export function createGuestHookMcpCaller(options: {
  readonly servers: readonly McpServerConfig[];
  readonly owner: string;
  readonly connections: ExecuteRunDeps["connections"];
  readonly signal: AbortSignal;
}): (input: unknown, signal: AbortSignal) => Promise<unknown> {
  const servers = new Map(
    options.servers
      .filter((server) => server?.transport === "stdio" && server.enabled !== false)
      .map((server) => [server.name, structuredClone(server)]),
  );
  return async (input, signal) => {
    const combined = AbortSignal.any([options.signal, signal]);
    combined.throwIfAborted();
    const parsed = callSchema.safeParse(input);
    if (!parsed.success) {
      throw Object.assign(new Error("runtime MCP hook input is invalid"), {
        code: "invalid_request",
      });
    }
    const server = servers.get(parsed.data.server);
    if (server === undefined) {
      throw Object.assign(new Error("stdio MCP server is not active for this run"), {
        code: "not_found",
      });
    }
    const lease = await options.connections.acquire({
      server,
      owner: options.owner,
      poolSharing: "owner",
      signal: combined,
    });
    try {
      combined.throwIfAborted();
      return await lease.conn.callTool(parsed.data.tool, parsed.data.input, combined);
    } finally {
      await lease.release();
    }
  };
}
