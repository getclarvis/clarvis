import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sanitizeErrorMessage, type McpServerConfig, type ToolResult } from "@clarvis/capability";
import {
  MCPAuthorizationPendingError,
  MCPBackgroundConnectDeferredError,
  MCPConnectionFailedError,
  type ConnectionManager,
  type ElicitationRelay,
  type ElicitationRelayResult,
  type Lease,
} from "@clarvis/mcp-client";
import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";

export const RUNTIME_MCP_METHOD = "runtime.mcp";
const REVISION = "v1";
const name = z.string().min(1).max(256);
const leaseId = z.string().uuid();
const requestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("acquire"),
      leaseId,
      server: name,
      elicitation: z.boolean(),
      authorizationWait: z.enum(["background", "blocking"]),
    })
    .strict(),
  z.object({ operation: z.literal("release"), leaseId }).strict(),
  z
    .object({ operation: z.literal("callTool"), leaseId, tool: name, input: z.unknown() })
    .strict()
    .refine((value) => Object.hasOwn(value, "input")),
  z.object({ operation: z.literal("listResources"), leaseId }).strict(),
  z
    .object({ operation: z.literal("readResource"), leaseId, uri: z.string().min(1).max(16_384) })
    .strict(),
]);
const elicitSchema = z.object({ leaseId, params: z.record(z.string(), z.unknown()) }).strict();
type Request = z.infer<typeof requestSchema>;
type Descriptor = { tools: Lease["tools"]; instructions?: string };
type Acquisition =
  | { ok: true; value: Descriptor }
  | { ok: false; error: "pending" }
  | { ok: false; error: "deferred"; limit: number; resource: "connections" | "handshakes" }
  | { ok: false; error: "failed"; message: string };

function refused(message: string): Error {
  return Object.assign(new Error(message), { code: "unauthorized" });
}

/**
 * Keep remote transports, environment-backed credentials and OAuth on the host.
 * The guest names only an admitted server or run-owned lease, never an endpoint,
 * credential, owner or stdio command. Disposing the run aborts acquisition and
 * releases every lease, including one that opens after cancellation.
 */
export function createHostRemoteMcpBridge(options: {
  servers: readonly McpServerConfig[];
  owner: string;
  connections: ConnectionManager;
  maxLeases: number;
  elicit: (input: unknown, signal: AbortSignal) => Promise<unknown>;
}): { grant: HostCapabilityGrant; dispose(): Promise<void> } {
  const servers = new Map(
    options.servers
      .filter(
        (server) =>
          (server?.transport === "http" || server?.transport === "sse") && server.enabled !== false,
      )
      .map((server) => [server.name, structuredClone(server)]),
  );
  const shutdown = new AbortController();
  const leases = new Map<string, { lease?: Lease; controller: AbortController }>();
  const release = async (id: string): Promise<void> => {
    const entry = leases.get(id);
    if (entry === undefined) return;
    leases.delete(id);
    entry.controller.abort(new Error("remote MCP lease closed"));
    await entry.lease?.release();
  };
  return {
    grant: {
      method: RUNTIME_MCP_METHOD,
      revision: REVISION,
      idempotent: false,
      validateArguments: (input) => requestSchema.safeParse(input).success,
      async invoke(input, signal): Promise<unknown> {
        const request = requestSchema.parse(input);
        shutdown.signal.throwIfAborted();
        signal.throwIfAborted();
        if (request.operation === "release") {
          await release(request.leaseId);
          return null;
        }
        if (request.operation === "acquire") {
          const server = servers.get(request.server);
          if (server === undefined) throw refused("remote MCP server is outside this run");
          if (leases.has(request.leaseId)) throw refused("remote MCP lease already exists");
          if (leases.size >= options.maxLeases) {
            throw Object.assign(new Error("remote MCP lease capacity exceeded"), {
              code: "resource_exhausted",
            });
          }
          const entry: { lease?: Lease; controller: AbortController } = {
            controller: new AbortController(),
          };
          leases.set(request.leaseId, entry);
          const combined = AbortSignal.any([signal, shutdown.signal, entry.controller.signal]);
          try {
            const lease = await options.connections.acquire({
              server,
              owner: options.owner,
              poolSharing: "owner",
              authorizationWait: request.authorizationWait,
              signal: combined,
              ...(request.elicitation
                ? {
                    relay: {
                      handle: (params: Record<string, unknown>, incoming?: AbortSignal) =>
                        options.elicit(
                          { leaseId: request.leaseId, params },
                          AbortSignal.any([
                            shutdown.signal,
                            entry.controller.signal,
                            ...(incoming === undefined ? [] : [incoming]),
                          ]),
                        ) as Promise<ElicitationRelayResult>,
                    },
                  }
                : {}),
            });
            entry.lease = lease;
            if (combined.aborted || leases.get(request.leaseId) !== entry) {
              if (leases.get(request.leaseId) !== entry) await lease.release();
              combined.throwIfAborted();
              throw refused("remote MCP lease was withdrawn");
            }
            return {
              ok: true,
              value: {
                tools: lease.tools,
                ...(lease.conn.instructions === undefined
                  ? {}
                  : { instructions: lease.conn.instructions }),
              },
            } satisfies Acquisition;
          } catch (error) {
            if (leases.get(request.leaseId) === entry) await release(request.leaseId);
            if (error instanceof MCPAuthorizationPendingError)
              return { ok: false, error: "pending" } satisfies Acquisition;
            if (error instanceof MCPBackgroundConnectDeferredError)
              return {
                ok: false,
                error: "deferred",
                limit: error.limit,
                resource: error.resource,
              } satisfies Acquisition;
            return {
              ok: false,
              error: "failed",
              message: sanitizeErrorMessage(
                error instanceof Error ? error.message : "remote MCP acquisition failed",
              ).slice(0, 2_048),
            } satisfies Acquisition;
          }
        }
        const entry = leases.get(request.leaseId);
        if (entry?.lease === undefined) throw refused("remote MCP lease is not active");
        const combined = AbortSignal.any([signal, shutdown.signal, entry.controller.signal]);
        const connection = entry.lease.conn;
        if (request.operation === "callTool") {
          if (
            !entry.lease.tools.some((tool) => tool.kind === undefined && tool.name === request.tool)
          ) {
            throw refused("remote MCP tool is outside the admitted catalog");
          }
          return connection.callTool(request.tool, request.input, combined);
        }
        if (
          request.operation === "listResources" &&
          connection.listResources !== undefined &&
          entry.lease.tools.some((tool) => tool.kind === "resource_list")
        ) {
          return connection.listResources(combined);
        }
        if (
          request.operation === "readResource" &&
          connection.readResource !== undefined &&
          entry.lease.tools.some((tool) => tool.kind === "resource_read")
        ) {
          return connection.readResource(request.uri, combined);
        }
        throw refused("remote MCP resource operation is unavailable");
      },
    },
    async dispose() {
      shutdown.abort(new Error("remote MCP run closed"));
      await Promise.all([...leases.keys()].map(release));
    },
  };
}

/** Route stdio locally and remote MCP leases through the host without importing credentials. */
export function createGuestMcpConnections(options: {
  local: ConnectionManager;
  bridge: GuestExecutionBridge;
  signal: AbortSignal;
}): ConnectionManager & {
  elicit(input: unknown, signal: AbortSignal): Promise<ElicitationRelayResult>;
} {
  const relays = new Map<string, ElicitationRelay | undefined>();
  const releases = new Map<string, () => Promise<void>>();
  const call = (request: Request, signal?: AbortSignal): Promise<unknown> =>
    options.bridge.capability(
      randomUUID(),
      { method: RUNTIME_MCP_METHOD, revision: REVISION, arguments: request },
      signal,
    );
  return {
    async acquire(input) {
      if (input.server.transport === "stdio") return options.local.acquire(input);
      const id = randomUUID();
      const combined = AbortSignal.any([
        options.signal,
        ...(input.signal === undefined ? [] : [input.signal]),
      ]);
      combined.throwIfAborted();
      relays.set(id, input.relay);
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        relays.delete(id);
        releases.delete(id);
        await call({ operation: "release", leaseId: id });
      };
      releases.set(id, release);
      try {
        const result = (await call(
          {
            operation: "acquire",
            leaseId: id,
            server: input.server.name,
            elicitation: input.relay !== undefined,
            authorizationWait: input.authorizationWait ?? "blocking",
          },
          combined,
        )) as Acquisition;
        if (result.ok === false) {
          if (result.error === "pending") throw new MCPAuthorizationPendingError();
          if (result.error === "deferred")
            throw new MCPBackgroundConnectDeferredError(result.limit, result.resource);
          throw new MCPConnectionFailedError(
            input.server.name,
            input.server.transport,
            result.message,
          );
        }
        const operation = async (request: Request, signal?: AbortSignal): Promise<ToolResult> => {
          if (released) throw refused("remote MCP lease is closed");
          return call(
            request,
            AbortSignal.any([options.signal, ...(signal === undefined ? [] : [signal])]),
          ) as Promise<ToolResult>;
        };
        return {
          tools: result.value.tools,
          conn: {
            name: input.server.name,
            transport: input.server.transport,
            status: "connected",
            ...(result.value.instructions === undefined
              ? {}
              : { instructions: result.value.instructions }),
            callTool: (tool, value, signal) =>
              operation({ operation: "callTool", leaseId: id, tool, input: value }, signal),
            listResources: (signal) =>
              operation({ operation: "listResources", leaseId: id }, signal),
            readResource: (uri, signal) =>
              operation({ operation: "readResource", leaseId: id, uri }, signal),
            close: release,
          },
          release,
        };
      } catch (error) {
        await release().catch(() => undefined);
        throw error;
      }
    },
    async elicit(input, signal) {
      const request = elicitSchema.parse(input);
      const relay = relays.get(request.leaseId);
      if (relay === undefined) throw refused("remote MCP elicitation lease is not active");
      signal.throwIfAborted();
      return relay.handle(request.params, AbortSignal.any([signal, options.signal]));
    },
    async closeAll() {
      try {
        await Promise.all([...releases.values()].map((release) => release()));
      } finally {
        await options.local.closeAll();
      }
    },
  };
}
