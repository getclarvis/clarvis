import type { ElicitationRelay } from "@clarvis/mcp-client";
import { MCPConnectionFailedError } from "@clarvis/mcp-client";
import type { ConnectionManager, Lease } from "@clarvis/mcp-client";
import { poolToolNames } from "./tools/mcp-registry.ts";
import { sanitizeErrorMessage } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import type { RunRequest, ToolTransport } from "@clarvis/capability";
import type { RunResponse, Usage } from "@clarvis/capability";
import { errorResponse } from "./support/run-response.ts";
import { findInvalidToolRef } from "./subagents/subagent-profiles.ts";

/** A declared MCP server that failed to connect at startup; the run proceeds
 * without it (degraded) rather than failing. */
export interface DegradedServer {
  name: string;
  transport: ToolTransport;
  reason: string;
}

/**
 * The outcome of opening the MCP tool pool: on `ok` the acquired {@link Lease}es
 * and any {@link DegradedServer}s that were skipped, otherwise a terminal
 * {@link RunResponse} the run should return immediately.
 */
export type OpenToolPoolResult =
  { ok: true; opened: Lease[]; degraded: DegradedServer[] } | { ok: false; response: RunResponse };

/**
 * Acquire connections to every declared MCP server in parallel and validate the
 * resulting tool pool against the run's profiles.
 *
 * A server that fails to connect does not fail the run: it is dropped as a
 * {@link DegradedServer} and the run proceeds without it, and profile tool
 * references belonging to a failed server are excluded from validation. The run
 * only fails when every declared server fails (no successes), when the signal is
 * already aborted, or when a profile references a tool that is absent for a
 * reason other than a failed server.
 *
 * @param input.request - the run request supplying `servers` and `profiles`.
 * @param input.connections - the manager used to acquire each server lease.
 * @param input.owner - the run's owner, which scopes every pooled connection so
 *   one owner's warm subprocess is never handed to another.
 * @param input.signal - optional cancel signal; if already aborted, all opened
 *   leases are released and a `cancelled` response is returned.
 * @param input.relay - optional elicitation relay threaded into each connection.
 * @param input.emptyUsage - factory for the zero {@link Usage} attached to any
 *   failure response.
 * @param input.logger - optional logger warned once per degraded server.
 * @returns {@link OpenToolPoolResult}; on the failure branch the leases already
 *   opened are released before returning (`mcp_connection_failed`,
 *   `provider_error`, `invalid_profile`, or `cancelled`).
 */
export async function openToolPool(input: {
  request: RunRequest;
  connections: ConnectionManager;
  owner: string;
  signal?: AbortSignal;
  relay: ElicitationRelay | undefined;
  emptyUsage: () => Usage;
  logger?: Logger;
}): Promise<OpenToolPoolResult> {
  const { request, connections, owner, signal, relay, emptyUsage, logger } = input;

  const results = await Promise.allSettled(
    request.servers.map((server) =>
      connections.acquire({
        server,
        owner,
        ...(relay ? { relay } : {}),
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  const successes: Lease[] = [];
  const failed: { name: string; transport: ToolTransport; reason: unknown }[] = [];
  request.servers.forEach((server, i) => {
    const r = results[i]!;
    if (r.status === "fulfilled") successes.push(r.value);
    else failed.push({ name: server.name, transport: server.transport, reason: r.reason });
  });

  if (signal?.aborted) {
    await Promise.allSettled(successes.map((o) => o.release()));
    return { ok: false, response: { status: "cancelled", result: "", usage: emptyUsage() } };
  }

  if (successes.length === 0 && request.servers.length > 0) {
    const err = failed[0]?.reason;
    if (err instanceof MCPConnectionFailedError) {
      return {
        ok: false,
        response: errorResponse(
          emptyUsage(),
          "mcp_connection_failed",
          sanitizeErrorMessage(err.message),
          { mcp_name: err.mcpName, transport: err.transport },
        ),
      };
    }
    return {
      ok: false,
      response: errorResponse(
        emptyUsage(),
        "provider_error",
        sanitizeErrorMessage(err instanceof Error ? err.message : "Failed to initialize tools."),
      ),
    };
  }

  const failedNames = new Set(failed.map((f) => f.name));
  const degraded: DegradedServer[] = failed.map((f) => ({
    name: f.name,
    transport: f.transport,
    reason: sanitizeErrorMessage(f.reason instanceof Error ? f.reason.message : String(f.reason)),
  }));
  for (const f of degraded) {
    logger?.warn(
      { event: "mcp.connect.failed", mcp: f.name, transport: f.transport, err: f.reason },
      "mcp server failed to connect at startup; continuing without it (degraded run)",
    );
  }

  const poolNames = poolToolNames(successes);
  const belongsToFailed = (tool: string): boolean => {
    for (const name of failedNames) {
      if (tool === name || tool.startsWith(`${name}.`)) return true;
    }
    return false;
  };
  const badRef = findInvalidToolRef(
    request.profiles.map((p) => ({
      label: p.name,
      tools: p.tools.filter((t) => !belongsToFailed(t)),
    })),
    poolNames,
  );
  if (badRef) {
    await Promise.allSettled(successes.map((o) => o.release()));
    return {
      ok: false,
      response: errorResponse(
        emptyUsage(),
        "invalid_profile",
        `profile '${badRef.label}' lists tool '${badRef.tool}', which is not in the tool pool: ${poolNames.join(", ") || "(none)"}.`,
      ),
    };
  }

  return { ok: true, opened: successes, degraded };
}
