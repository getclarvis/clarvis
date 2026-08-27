import type {
  Logger,
  MCPConnection,
  MCPStatus,
  McpServerConfig,
  ResourceToolKind,
  ToolTransport,
} from "@clarvis/capability";
import {
  MissingEnvVarsError,
  NOOP_LOGGER,
  bestEffort,
  bind,
  detachObserved,
  levelEnabled,
  sanitizeErrorMessage,
  unref,
} from "@clarvis/capability";
import type { ElicitationRelay, MCPClientFactory, MCPClientHandle } from "./client.ts";
import {
  appendResourceDescriptors,
  catalogResult,
  loadResourceCatalog,
  resourceReadResult,
  type ResourceCatalog,
} from "./resources.ts";
import { createResilientSession } from "./resilient-session.ts";
import { interpretCallResult } from "./tool-results.ts";

export const UNAVAILABLE_REPROBE_COOLDOWN_MS = 30_000;
export const DEFAULT_TIMEOUT_STREAK_THRESHOLD = 3;
export const DEFAULT_HEALTH_PING_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_TOOL_CATALOG_ENTRIES = 2_048;
export const DEFAULT_MAX_TOOL_CATALOG_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_CATALOG_PAGES = 50;

function boundedCatalogLimit(value: number, hardMaximum: number): number {
  if (!Number.isFinite(value)) return hardMaximum;
  return Math.min(hardMaximum, Math.max(0, Math.floor(value)));
}

export interface NamespacedToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  kind?: ResourceToolKind;
}

export interface OpenedConnection {
  conn: MCPConnection;
  tools: NamespacedToolDescriptor[];
}

export class MCPConnectionFailedError extends Error {
  readonly code = "mcp_connection_failed" as const;
  readonly mcpName: string;
  readonly transport: ToolTransport;
  constructor(mcpName: string, transport: ToolTransport, message: string) {
    super(message);
    this.name = "MCPConnectionFailedError";
    this.mcpName = mcpName;
    this.transport = transport;
  }
}

export interface PoolScope {
  workspace: string;
  owner: string;
}

export interface ConnectionEvent {
  connection_id: string;
  scope: PoolScope;
  mcp_name: string;
  transport: ToolTransport;
  state: "unavailable" | "recovered" | "closed";
  cause?: "timeout" | "transport" | "reconnect_failed";
}

export type ConnectionEventSink = (event: ConnectionEvent) => void;

export interface OpenConnectionOptions {
  server: McpServerConfig;
  scope: PoolScope;
  connectTimeoutMs: number;
  callTimeoutMs: number;
  factory: MCPClientFactory;
  relay?: ElicitationRelay;
  signal?: AbortSignal;
  reprobeCooldownMs?: number;
  timeoutStreakThreshold?: number;
  healthPingIntervalMs?: number;
  /** Per-operation shutdown grace for reconnect and handle closes. */
  closeGraceMs?: number;
  resourcesEnabled?: boolean;
  maxToolCatalogEntries?: number;
  maxToolCatalogBytes?: number;
  maxResourceCatalogEntries?: number;
  maxResourceCatalogBytes?: number;
  onEvent?: ConnectionEventSink;
  logger?: Logger;
}

export async function openConnection({
  server,
  scope,
  connectTimeoutMs,
  callTimeoutMs,
  factory,
  relay,
  signal,
  reprobeCooldownMs = UNAVAILABLE_REPROBE_COOLDOWN_MS,
  timeoutStreakThreshold = DEFAULT_TIMEOUT_STREAK_THRESHOLD,
  healthPingIntervalMs = DEFAULT_HEALTH_PING_INTERVAL_MS,
  closeGraceMs,
  resourcesEnabled = true,
  maxToolCatalogEntries = DEFAULT_MAX_TOOL_CATALOG_ENTRIES,
  maxToolCatalogBytes = DEFAULT_MAX_TOOL_CATALOG_BYTES,
  maxResourceCatalogEntries,
  maxResourceCatalogBytes,
  onEvent,
  logger,
}: OpenConnectionOptions): Promise<OpenedConnection> {
  const log = bind(logger ?? NOOP_LOGGER, {
    workspace: scope.workspace,
    owner: scope.owner,
    mcp: server.name,
    transport: server.transport,
  });
  let attempts = 0;
  const connect = (): Promise<MCPClientHandle> => {
    attempts += 1;
    return observedConnect(
      { factory, server, relay, connectTimeoutMs, signal, scope, logger: log },
      attempts,
    );
  };

  let handle: MCPClientHandle;
  try {
    handle = await connect();
  } catch (err) {
    if (err instanceof MCPConnectionFailedError) throw err;
    throw new MCPConnectionFailedError(server.name, server.transport, errorText(err));
  }

  let toolsList: NamespacedToolDescriptor[];
  try {
    toolsList = await loadToolCatalog(
      handle,
      connectTimeoutMs,
      boundedCatalogLimit(maxToolCatalogEntries, DEFAULT_MAX_TOOL_CATALOG_ENTRIES),
      boundedCatalogLimit(maxToolCatalogBytes, DEFAULT_MAX_TOOL_CATALOG_BYTES),
      log,
      signal,
    );
  } catch (err) {
    await bestEffort(() => handle.close(), {
      operation: "mcp_failed_listing_close",
      workspace: scope.workspace,
      dedupeKey: `mcp_failed_listing_close\0${scope.workspace}\0${server.name}`,
      logger: log,
    });
    throw new MCPConnectionFailedError(
      server.name,
      server.transport,
      `Failed to list tools on '${server.name}': ${errorText(err)}`,
    );
  }

  let resourceCatalog: ResourceCatalog | null = null;
  if (resourcesEnabled && server.resources !== false) {
    try {
      resourceCatalog = await loadResourceCatalog(handle, connectTimeoutMs, signal, {
        ...(maxResourceCatalogEntries !== undefined
          ? { maxEntries: maxResourceCatalogEntries }
          : {}),
        ...(maxResourceCatalogBytes !== undefined ? { maxBytes: maxResourceCatalogBytes } : {}),
        logger: log,
      });
      if (resourceCatalog) appendResourceDescriptors(toolsList);
    } catch (err) {
      log.warn(
        { event: "mcp.resources.probe_failed", reason: sanitizeErrorMessage(errorText(err)) },
        "mcp resource capability probe failed; the run continues without this server's resource tools",
      );
    }
  }

  const session = createResilientSession({
    initialHandle: handle,
    reconnect: connect,
    mcpName: server.name,
    callTimeoutMs,
    connectTimeoutMs,
    reprobeCooldownMs,
    timeoutStreakThreshold,
    healthPingIntervalMs,
    ...(closeGraceMs !== undefined ? { closeGraceMs } : {}),
    ...(signal ? { signal } : {}),
    eventBase: { scope, mcp_name: server.name, transport: server.transport },
    ...(onEvent ? { onEvent } : {}),
    logger: log,
  });

  const conn: MCPConnection = {
    name: server.name,
    transport: server.transport,
    get status(): MCPStatus {
      return session.status;
    },
    callTool(toolName, args, callSignal) {
      return session.invoke(
        toolName,
        (active, opts) =>
          active.client.callTool(
            { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
            undefined,
            opts,
          ),
        (raw) => interpretCallResult(raw, toolName),
        callSignal,
      );
    },
    listResources() {
      return Promise.resolve(catalogResult(resourceCatalog));
    },
    readResource(uri, callSignal) {
      return session.invoke(
        "read_resource",
        (active, opts) => active.client.readResource({ uri }, opts),
        (raw) => resourceReadResult(raw, uri),
        callSignal,
      );
    },
    close: () => session.close(),
  };

  return { conn, tools: toolsList };
}

const CATALOG_LIMIT_NOUN = { entries: "entry", bytes: "byte", pages: "page" } as const;

function catalogLimitReached(
  logger: Logger,
  kind: keyof typeof CATALOG_LIMIT_NOUN,
  limit: number,
  observed: number,
): Error {
  logger.warn(
    { event: "mcp.catalog.limit", kind, limit, observed },
    "mcp tool catalog exceeded a discovery bound; the connection is refused and none of this " +
      "server's tools are offered",
  );
  return new Error(
    `MCP tool catalog exceeds the ${String(limit)}-${CATALOG_LIMIT_NOUN[kind]} limit.`,
  );
}

async function loadToolCatalog(
  handle: MCPClientHandle,
  timeout: number,
  maxEntries: number,
  maxBytes: number,
  logger: Logger,
  signal?: AbortSignal,
): Promise<NamespacedToolDescriptor[]> {
  const tools: NamespacedToolDescriptor[] = [];
  let bytes = 0;
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_TOOL_CATALOG_PAGES; pageNumber += 1) {
    const listed = await handle.client.listTools(cursor ? { cursor } : undefined, {
      timeout,
      ...(signal ? { signal } : {}),
    });
    const page = Array.isArray((listed as { tools?: unknown }).tools)
      ? ((listed as { tools: unknown[] }).tools as Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>)
      : [];
    for (const tool of page) {
      if (tools.length >= maxEntries) {
        throw catalogLimitReached(logger, "entries", maxEntries, tools.length + 1);
      }
      const descriptor: NamespacedToolDescriptor = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      };
      bytes += Buffer.byteLength(JSON.stringify(descriptor), "utf8");
      if (bytes > maxBytes) {
        throw catalogLimitReached(logger, "bytes", maxBytes, bytes);
      }
      tools.push(descriptor);
    }
    const nextCursor = (listed as { nextCursor?: unknown }).nextCursor;
    if (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor === cursor) {
      logger.info(
        {
          event: "mcp.tools.listed",
          count: tools.length,
          bytes,
          pages: pageNumber + 1,
          truncated: false,
          ...(levelEnabled(logger, "debug") ? { names: tools.map((tool) => tool.name) } : {}),
        },
        "mcp server's tool catalog was read; those tools are offered to the model this run",
      );
      return tools;
    }
    cursor = nextCursor;
  }
  throw catalogLimitReached(logger, "pages", MAX_TOOL_CATALOG_PAGES, MAX_TOOL_CATALOG_PAGES + 1);
}

interface ConnectAttemptContext {
  factory: MCPClientFactory;
  server: McpServerConfig;
  relay: ElicitationRelay | undefined;
  connectTimeoutMs: number;
  signal: AbortSignal | undefined;
  scope: PoolScope;
  logger: Logger;
}

/**
 * The connected server's own identity, as far as the handle reports one.
 *
 * @param handle - the connected handle.
 * @returns the fields that could be read, and nothing for those that could not.
 * @remarks Every member is read defensively because {@link MCPClientFactory} is
 *   a substitution seam: a host or a test may hand back a handle whose client is
 *   a narrow stand-in, and a connection must not fail because the identity of
 *   the thing it just connected to could not be logged.
 */
function serverIdentity(handle: MCPClientHandle): Record<string, string> {
  const identity =
    typeof handle.client.getServerVersion === "function"
      ? handle.client.getServerVersion()
      : undefined;
  return {
    ...(identity?.name !== undefined ? { server_name: identity.name } : {}),
    ...(identity?.version !== undefined ? { server_version: identity.version } : {}),
    ...(handle.protocolVersion !== undefined ? { protocol_version: handle.protocolVersion } : {}),
  };
}

/**
 * Run one bounded connect attempt and report how it went.
 *
 * @param ctx - the factory, server and bounds the attempt runs against.
 * @param attempt - 1 for the initial handshake, then one per reconnect.
 * @returns the connected handle.
 * @remarks The server's own identity is read here because nothing else does:
 *   `getServerVersion()` is populated by the handshake and was discarded, so an
 *   operator could not tell which build of a server a workspace was actually
 *   talking to. A `${VAR}` interpolation failure names the variables it could
 *   not resolve — the names only, never a value.
 */
async function observedConnect(
  ctx: ConnectAttemptContext,
  attempt: number,
): Promise<MCPClientHandle> {
  const startedAt = Date.now();
  ctx.logger.debug(
    { event: "mcp.connect.begin", connect_timeout_ms: ctx.connectTimeoutMs, attempt },
    "connecting to an mcp server",
  );
  try {
    const handle = await connectWithinBound(
      ctx.factory,
      ctx.server,
      ctx.relay,
      ctx.connectTimeoutMs,
      ctx.signal,
      ctx.scope,
      ctx.logger,
    );
    ctx.logger.info(
      {
        event: "mcp.connect.ok",
        duration_ms: Date.now() - startedAt,
        attempt,
        ...serverIdentity(handle),
      },
      "mcp server connected; its tools are being discovered",
    );
    return handle;
  } catch (err) {
    const missing = err instanceof MissingEnvVarsError ? err.missing : undefined;
    ctx.logger.warn(
      {
        event: "mcp.connect.failed",
        duration_ms: Date.now() - startedAt,
        attempt,
        reason: sanitizeErrorMessage(errorText(err)),
        ...(missing !== undefined ? { missing_env: missing } : {}),
      },
      "mcp server did not connect; the run continues without its tools",
    );
    throw err;
  }
}

async function connectWithinBound(
  factory: MCPClientFactory,
  server: McpServerConfig,
  relay: ElicitationRelay | undefined,
  connectTimeoutMs: number,
  signal: AbortSignal | undefined,
  scope: PoolScope,
  logger: Logger,
): Promise<MCPClientHandle> {
  const connectAbort = new AbortController();
  const abortError = (): MCPConnectionFailedError =>
    new MCPConnectionFailedError(
      server.name,
      server.transport,
      `Connection to MCP '${server.name}' aborted (run cancelled).`,
    );
  // Do not cross the physical factory boundary when the caller is already
  // gone. In particular, a dedicated session may discover transport loss just
  // after its owning run was cancelled; starting a reconnect here would create
  // native work whose only possible outcome is immediate disposal.
  if (signal?.aborted) {
    connectAbort.abort(signal.reason);
    throw abortError();
  }
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerStartedAt = 0;
  let remainingMs = Math.max(0, connectTimeoutMs);
  let pauseDepth = 0;
  let onAbort: (() => void) | undefined;
  let rejectGuard!: (error: MCPConnectionFailedError) => void;
  const timeoutError = (): MCPConnectionFailedError =>
    new MCPConnectionFailedError(
      server.name,
      server.transport,
      `Failed to connect to MCP '${server.name}' within ${connectTimeoutMs}ms.`,
    );
  const expire = (): void => {
    if (abandoned) return;
    abandoned = true;
    timer = undefined;
    connectAbort.abort();
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    rejectGuard(timeoutError());
  };
  const armTimer = (): void => {
    if (abandoned || pauseDepth > 0 || timer !== undefined) return;
    if (remainingMs <= 0) {
      queueMicrotask(expire);
      return;
    }
    timerStartedAt = Date.now();
    timer = setTimeout(expire, remainingMs);
    unref(timer);
  };
  const pauseTimer = (): void => {
    if (abandoned) return;
    pauseDepth += 1;
    if (pauseDepth !== 1 || timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt));
  };
  const resumeTimer = (): void => {
    if (abandoned || pauseDepth === 0) return;
    pauseDepth -= 1;
    if (pauseDepth === 0) armTimer();
  };
  const guard = new Promise<never>((_, reject) => {
    rejectGuard = reject;
    if (signal?.aborted) {
      abandoned = true;
      connectAbort.abort();
      reject(abortError());
      return;
    }
    onAbort = (): void => {
      abandoned = true;
      connectAbort.abort();
      if (timer) clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    armTimer();
  });
  let handlePromise: Promise<MCPClientHandle>;
  try {
    handlePromise = factory(server, relay, {
      signal: connectAbort.signal,
      timeoutMs: connectTimeoutMs,
      scope,
      onAuthorizationWaitStart: pauseTimer,
      onAuthorizationWaitEnd: resumeTimer,
    });
  } catch (error) {
    handlePromise = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  detachObserved(
    () =>
      handlePromise.then(
        (lateHandle) => {
          if (abandoned)
            detachObserved(() => lateHandle.close(), {
              operation: "mcp_late_connection_close",
              dedupeKey: `mcp_late_connection_close\0${server.name}`,
              logger,
            });
        },
        () => {},
      ),
    {
      operation: "mcp_late_connection_watch",
      dedupeKey: `mcp_late_connection_watch\0${server.name}`,
      logger,
    },
  );
  try {
    return await Promise.race([handlePromise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
