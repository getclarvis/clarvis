/**
 * `@clarvis/mcp-client` — how Clarvis *speaks* MCP.
 *
 * @remarks
 * Client and transport construction ({@link createMCPClientFactory},
 * {@link buildTransport}, {@link BunStdioClientTransport}), a single
 * self-healing connection ({@link openConnection}), the pool over them with
 * idle TTL and health checks ({@link createConnectionManager}), the namespaced
 * tool registry ({@link buildRegistry}), `${VAR}` env interpolation, and the
 * error predicates.
 *
 * The line against `@clarvis/loop` is the same one `@clarvis/trace` draws: this
 * package knows how to talk to an MCP server; the engine knows *when* to — the
 * dispatch, the guards, the trace and the result envelope stay there.
 * {@link buildRegistry} takes the host's reserved wire names as an argument
 * rather than importing them, which is what keeps that line one-directional.
 */
export { defaultMCPClientFactory, createMCPClientFactory, buildTransport } from "./client.ts";
export {
  createMCPBoundedFetch,
  MCPHttpResponseLimitError,
  DEFAULT_MCP_HTTP_MAX_RESPONSE_BYTES,
  DEFAULT_MCP_HTTP_MAX_SSE_EVENT_BYTES,
} from "./bounded-fetch.ts";
export type { MCPBoundedFetchOptions } from "./bounded-fetch.ts";
export type {
  ElicitationRelayResult,
  ElicitationRelay,
  MCPClientHandle,
  MCPConnectOptions,
  MCPClientFactory,
  RuntimeEnvironment,
  MCPClientFactoryOptions,
} from "./client.ts";
export {
  mcpSpawnArgv,
  BunStdioClientTransport,
  MCPStdioFrameLimitError,
  DEFAULT_MCP_STDIO_MAX_FRAME_BYTES,
} from "./bun-stdio-client.ts";
export type { BunStdioClientParameters, BunStderrWritable } from "./bun-stdio-client.ts";
export {
  UNAVAILABLE_REPROBE_COOLDOWN_MS,
  DEFAULT_TIMEOUT_STREAK_THRESHOLD,
  DEFAULT_HEALTH_PING_INTERVAL_MS,
  MCPConnectionFailedError,
  openConnection,
  DEFAULT_MAX_TOOL_CATALOG_ENTRIES,
  DEFAULT_MAX_TOOL_CATALOG_BYTES,
  MAX_TOOL_CATALOG_PAGES,
} from "./connection.ts";
export {
  DEFAULT_MAX_RESOURCE_CATALOG_ENTRIES,
  DEFAULT_MAX_RESOURCE_CATALOG_BYTES,
  MAX_RESOURCE_CATALOG_PAGES,
  MCPResourceCatalogLimitError,
} from "./resources.ts";
export type { ResourceCatalogLimits } from "./resources.ts";
export type {
  NamespacedToolDescriptor,
  OpenedConnection,
  PoolScope,
  ConnectionEvent,
  ConnectionEventSink,
  OpenConnectionOptions,
} from "./connection.ts";
export {
  createConnectionManager,
  MCPConnectionLimitError,
  DEFAULT_MAX_MCP_CONNECTIONS,
  DEFAULT_MAX_PARALLEL_MCP_CONNECTS,
  DEFAULT_MAX_IDLE_MCP_CONNECTIONS,
} from "./connection-manager.ts";
export { DEFAULT_MCP_CLOSE_GRACE_MS, MAX_MCP_CLOSE_GRACE_MS } from "./resilient-session.ts";
export type {
  Lease,
  AcquireOptions,
  ConnectionManager,
  PoolSharing,
  ConnectionManagerOptions,
} from "./connection-manager.ts";
export { isMcpRequestTimeout, isMcpProtocolError } from "./errors.ts";
export { toWireToolName, buildRegistry, poolToolNames, selectTools } from "./registry.ts";
export type { NamespacedRegistry, RegistryEntry, BuildRegistryOptions } from "./registry.ts";
export { CLIENT_NAME, VERSION } from "./version.ts";
export {
  createServerStderrForwarder,
  drainStderrStream,
  DEFAULT_SERVER_STDERR_MAX_BYTES,
} from "./server-stderr.ts";
export type {
  ServerStderrSink,
  ServerStderrForwarder,
  ServerStderrForwarderOptions,
  NodeStderrStream,
} from "./server-stderr.ts";
