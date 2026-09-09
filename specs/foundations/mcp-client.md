# Speaking MCP: transports, resilient sessions, pool and namespaced registry

> Implemented at `packages/mcp-client/`. Every claim below is anchored to a file and a named symbol or test. Open
> questions are collected in the final section.

## 1. Purpose

`@clarvis/mcp-client` is the package that knows *how* to talk to an MCP server. It builds the SDK
client and one of three transports (`packages/mcp-client/src/client.ts`), wraps a live client in
a self-healing session that reconnects, health-pings and trips a circuit breaker
(`packages/mcp-client/src/resilient-session.ts`), pools shareable connections behind refcounted
leases with an idle TTL (`packages/mcp-client/src/connection-manager.ts`), and projects each
server's tools into collision-free wire names (`makeRegistry` in
`packages/mcp-client/src/registry.ts`). For
remote HTTP/SSE servers it also coordinates SDK OAuth through an interactive browser callback and a
private persistent credential store (`packages/mcp-client/src/oauth.ts`,
`packages/mcp-client/src/oauth-store.ts`).

The package's own doc comment states the boundary it draws: "this package knows how to talk to an
MCP server; the engine knows *when* to — the dispatch, the guards, the trace and the result envelope
stay there. `buildRegistry` takes the host's reserved wire names as an argument rather than importing
them, which is what keeps that line one-directional"
(`packages/mcp-client/src/index.ts`). Its manifest confirms the direction: its only
dependencies are `@clarvis/capability`, `@clarvis/paths` and `@modelcontextprotocol/sdk`
(`packages/mcp-client/package.json`), and nothing named `loop` appears in them.

Everything the model ever sees from an MCP server passes through a `ToolResult`
(`packages/capability/src/run.ts`) produced here — including the failure vocabulary that tells a
caller whether a call may safely be retried (`packages/mcp-client/src/tool-results.ts`).
**Delegated elsewhere:** *when* the loop decides to call an MCP tool, and what reserved wire names it
seeds into `buildRegistry`, belong to [loop-tool-dispatch-and-results](../engine/tool-dispatch.md); the user-facing half of
elicitation belongs to [elicitation-and-user-interaction](../cross-cutting/elicitation.md); assembling `McpServerConfig` from settings
and plugin manifests belongs to [kernel-config-and-agents](../hosts/kernel-config.md).

## 2. Surface

The package publishes exactly one entrypoint, `.`, mapped to `./src/index.ts` under the `bun`
condition and `./dist/index.js` otherwise (`packages/mcp-client/package.json`). `src/index.ts`
is a pure re-export list (`packages/mcp-client/src/index.ts`).

### 2.1 Client and transport construction — `src/client.ts`

| Symbol | Kind | File | Signature / shape |
| --- | --- | --- | --- |
| `defaultMCPClientFactory` | const | `packages/mcp-client/src/client.ts` | `createMCPClientFactory(process.env)` |
| `createMCPClientFactory` | fn | `packages/mcp-client/src/client.ts` | `(environment: RuntimeEnvironment, options?: MCPClientFactoryOptions) => MCPClientFactory` |
| `buildTransport` | fn | `packages/mcp-client/src/client.ts` | `(server, environment = process.env, defaultCwd?, limits = {}) => BunStdioClientTransport \| StdioClientTransport \| StreamableHTTPClientTransport \| SSEClientTransport` |
| `MCPClientFactory` | type | `packages/mcp-client/src/client.ts` | `(server: McpServerConfig, relay?: ElicitationRelay, opts?: MCPConnectOptions) => Promise<MCPClientHandle>` |
| `MCPClientHandle` | type | `packages/mcp-client/src/client.ts` | `{ client; close(); protocolVersion? }` |
| `MCPConnectOptions` | type | `packages/mcp-client/src/client.ts` | signal/deadline/scope, wait-budget hooks, and `authorizationWait?: "blocking" | "background"` |
| `ElicitationRelay` | type | `packages/mcp-client/src/client.ts` | `{ handle(params: Record<string, unknown>, signal?: AbortSignal): Promise<ElicitationRelayResult> }` |
| `ElicitationRelayResult` | type | `packages/mcp-client/src/client.ts` | `{ action: "accept" \| "decline" \| "cancel"; content?: Record<string, unknown> }` |
| `RuntimeEnvironment` | type | `packages/mcp-client/src/client.ts` | `Readonly<Record<string, string \| undefined>>` |
| `MCPClientFactoryOptions` | type | `packages/mcp-client/src/client.ts` | transport bounds/stdio defaults, `logger`, and optional `authorization` coordinator (`packages/mcp-client/src/client.ts`) |

### 2.2 One connection — `src/connection.ts`

| Symbol | Kind | File | Value / shape |
| --- | --- | --- | --- |
| `openConnection` | fn | `packages/mcp-client/src/connection.ts` | `(OpenConnectionOptions) => Promise<OpenedConnection>` |
| `OpenedConnection` | type | `packages/mcp-client/src/connection.ts` | `{ conn: MCPConnection; tools: NamespacedToolDescriptor[] }`; `conn.instructions?` carries bounded initialize guidance |
| `NamespacedToolDescriptor` | type | `packages/mcp-client/src/connection.ts` | `{ name; description?; inputSchema: Record<string, unknown>; kind?: ResourceToolKind }` |
| `MCPConnectionFailedError` | class | `packages/mcp-client/src/connection.ts` | `code: "mcp_connection_failed"`, `mcpName`, `transport` |
| `PoolScope` | type | `packages/mcp-client/src/connection.ts` | `{ workspace: string; owner: string }` |
| `ConnectionEvent` | type | `packages/mcp-client/src/connection.ts` | `{ connection_id; scope; mcp_name; transport; state: "unavailable"\|"recovered"\|"closed"; cause?: "timeout"\|"transport"\|"reconnect_failed" }` |
| `ConnectionEventSink` | type | `packages/mcp-client/src/connection.ts` | `(event: ConnectionEvent) => void` |
| `UNAVAILABLE_REPROBE_COOLDOWN_MS` | const | `packages/mcp-client/src/connection.ts` | `30_000` |
| `DEFAULT_TIMEOUT_STREAK_THRESHOLD` | const | `packages/mcp-client/src/connection.ts` | `3` |
| `DEFAULT_HEALTH_PING_INTERVAL_MS` | const | `packages/mcp-client/src/connection.ts` | `30_000` |
| `DEFAULT_MAX_TOOL_CATALOG_ENTRIES` | const | `packages/mcp-client/src/connection.ts` | `2_048` |
| `DEFAULT_MAX_TOOL_CATALOG_BYTES` | const | `packages/mcp-client/src/connection.ts` | `8 * 1024 * 1024` |
| `MAX_TOOL_CATALOG_PAGES` | const | `packages/mcp-client/src/connection.ts` | `50` |

`OpenConnectionOptions` (`packages/mcp-client/src/connection.ts`) carries `server`, `scope`, `connectTimeoutMs`,
`callTimeoutMs`, `factory`, plus optional `relay`, `signal`, `authorizationWait`, `reprobeCooldownMs`,
`timeoutStreakThreshold`, `healthPingIntervalMs`, `closeGraceMs`, `resourcesEnabled`, the four
catalog bounds, `onEvent` and `logger`.

### 2.3 The pool — `src/connection-manager.ts`

| Symbol | Kind | File | Value / shape |
| --- | --- | --- | --- |
| `createConnectionManager` | fn | `packages/mcp-client/src/connection-manager.ts` | `(ConnectionManagerOptions) => ConnectionManager` |
| `ConnectionManager` | type | `packages/mcp-client/src/connection-manager.ts` | `{ acquire(opts: AcquireOptions): Promise<Lease>; closeAll(): Promise<void> }` |
| `Lease` | type | `packages/mcp-client/src/connection-manager.ts` | `OpenedConnection & { release: () => Promise<void> }` |
| `AcquireOptions` | type | `packages/mcp-client/src/connection-manager.ts` | `{ server; owner; relay?; signal?; authorizationWait?; poolSharing? }` |
| `PoolSharing` | type | `packages/mcp-client/src/connection-manager.ts` | `"owner" \| "workspace"` |
| `MCPConnectionLimitError` | class | `packages/mcp-client/src/connection-manager.ts` | `code: "mcp_connection_limit"`, `limit` |
| `MCPBackgroundConnectDeferredError` | class | `packages/mcp-client/src/errors.ts` | `code: "mcp_background_connect_deferred"`; `resource: "connections" \| "handshakes"`; background acquire is inactive rather than queued |
| `DEFAULT_MAX_MCP_CONNECTIONS` | const | `packages/mcp-client/src/connection-manager.ts` | `32` |
| `DEFAULT_MAX_PARALLEL_MCP_CONNECTS` | const | `packages/mcp-client/src/connection-manager.ts` | `4` |
| `DEFAULT_MAX_IDLE_MCP_CONNECTIONS` | const | `packages/mcp-client/src/connection-manager.ts` | `8` |

`ConnectionManagerOptions` (`packages/mcp-client/src/connection-manager.ts`) requires `workspace`, `factory`,
`connectTimeoutMs`, `callTimeoutMs`; optional are `idleTtlMs`, `poolSharing`, `resourcesEnabled`,
`timeoutStreakThreshold`, `healthPingIntervalMs`, `onConnectionEvent`, `logger`, `maxConnections`,
`maxParallelConnects`, `maxIdleConnections`, `closeGraceMs`, and the test seam
`scheduleCloseTimeout`. The unexported `DEFAULT_IDLE_TTL_MS` is `60_000`
(`packages/mcp-client/src/connection-manager.ts`).

### 2.4 Registry, errors, transports, stderr

| Symbol | Kind | File | Value / shape |
| --- | --- | --- | --- |
| `toWireToolName` | fn | `packages/mcp-client/src/registry.ts` (`toWireToolName`) | `(fullName, used: Set<string>, onRename?) => string` |
| `buildRegistry` | fn | `packages/mcp-client/src/registry.ts` (`buildRegistry`) | `(entries, reserved: readonly string[], options?: { logger }) => NamespacedRegistry` |
| `poolToolNames` | fn | `packages/mcp-client/src/registry.ts` (`poolToolNames`) | `(entries) => string[]` of `mcpName.toolName` |
| `selectTools` | fn | `packages/mcp-client/src/registry.ts` (`selectTools`) | `(entries, names?) => RegistryEntry[]` |
| `RegistryEntry` | type | `packages/mcp-client/src/registry.ts` (`RegistryEntry`) | `{ conn: MCPConnection; tools: NamespacedToolDescriptor[] }` |
| `NamespacedRegistry` | type | re-exported by `packages/mcp-client/src/registry.ts` | defined by `NamespacedRegistry` in `packages/capability/src/run.ts` |
| `isMcpRequestTimeout` | fn | `packages/mcp-client/src/errors.ts` | `(err: unknown) => boolean` |
| `isMcpProtocolError` | fn | `packages/mcp-client/src/errors.ts` | `(err: unknown) => boolean` |
| `mcpSpawnArgv` | fn | `packages/mcp-client/src/bun-stdio-client.ts` | `(command, args, platform = process.platform) => { argv: string[]; verbatim: boolean }` |
| `BunStdioClientTransport` | class | `packages/mcp-client/src/bun-stdio-client.ts` | implements the SDK `Transport` |
| `BunStdioClientParameters` | type | `packages/mcp-client/src/bun-stdio-client.ts` | `{ command; args?; cwd?; env?; onStderr?; onStderrEnd?; stderrWritable?; maxFrameBytes?; closeGraceMs?; terminateGraceMs?; logger? }` — spawn parameters for a `BunStdioClientTransport` |
| `BunStderrWritable` | type | `packages/mcp-client/src/bun-stdio-client.ts` | `{ write; once("drain"\|"error"); off("drain"\|"error") }` — the minimal backpressure surface a parent stderr sink must expose |
| `MCPStdioFrameLimitError` | class | `packages/mcp-client/src/bun-stdio-client.ts` | `code: "mcp_stdio_frame_too_large"`, `limit` |
| `DEFAULT_MCP_STDIO_MAX_FRAME_BYTES` | const | `packages/mcp-client/src/bun-stdio-client.ts` | `16 * 1024 * 1024` |
| `createMCPBoundedFetch` | fn | `packages/mcp-client/src/bounded-fetch.ts` | `(MCPBoundedFetchOptions) => FetchLike` |
| `MCPBoundedFetchOptions` | type | `packages/mcp-client/src/bounded-fetch.ts` | `{ fetch?; headers?; maxResponseBytes?; maxSseEventBytes?; logger?; mcpName? }` — `mcpName` is "only needed when `logger` carries no `mcp` binding of its own" |
| `MCPHttpResponseLimitError` | class | `packages/mcp-client/src/bounded-fetch.ts` | `code: "mcp_http_response_too_large"`, `limit: "response"\|"sse_event"`, `maxBytes` |
| `DEFAULT_MCP_HTTP_MAX_RESPONSE_BYTES` | const | `packages/mcp-client/src/bounded-fetch.ts` | `16 * 1024 * 1024` |
| `DEFAULT_MCP_HTTP_MAX_SSE_EVENT_BYTES` | const | `packages/mcp-client/src/bounded-fetch.ts` | `4 * 1024 * 1024` |
| `MCPResourceCatalogLimitError` | class | `packages/mcp-client/src/resources.ts` | `code: "mcp_resource_catalog_too_large"`, `dimension`, `limit` |
| `ResourceCatalogLimits` | type | `packages/mcp-client/src/resources.ts` | `{ maxEntries?; maxBytes?; logger? }` — `logger` "should already carry the connection's bindings" |
| `DEFAULT_MAX_RESOURCE_CATALOG_ENTRIES` | const | `packages/mcp-client/src/resources.ts` | `5_000` |
| `DEFAULT_MAX_RESOURCE_CATALOG_BYTES` | const | `packages/mcp-client/src/resources.ts` | `4 * 1024 * 1024` |
| `MAX_RESOURCE_CATALOG_PAGES` | const | `packages/mcp-client/src/resources.ts` | `50` |
| `BuildRegistryOptions` | type | `packages/mcp-client/src/registry.ts` (`BuildRegistryOptions`) | `{ logger? }` — where a wire-name fallback is reported |
| `createServerStderrForwarder` | fn | `packages/mcp-client/src/server-stderr.ts` | `(options) => ServerStderrForwarder` |
| `drainStderrStream` | fn | `packages/mcp-client/src/server-stderr.ts` | `(stream, forwarder) => void` |
| `DEFAULT_SERVER_STDERR_MAX_BYTES` | const | `packages/mcp-client/src/server-stderr.ts` | `64 * 1024` |
| `DEFAULT_MCP_CLOSE_GRACE_MS` | const | `packages/mcp-client/src/resilient-session.ts` | `2_000` |
| `MAX_MCP_CLOSE_GRACE_MS` | const | `packages/mcp-client/src/resilient-session.ts` | `30_000` |
| `CLIENT_NAME` | const | `packages/mcp-client/src/version.ts`, `CLIENT_NAME` | `"@clarvis/mcp-client"` |
| `VERSION` | const | `packages/mcp-client/src/version.ts` | Clarvis product version, statically imported from the root manifest |

### 2.5 OAuth coordination and credential storage

The OAuth surface exported by `packages/mcp-client/src/index.ts` is:

| Symbol | Kind | File | Purpose |
| --- | --- | --- | --- |
| `createMCPAuthorizationCoordinator` | fn | `packages/mcp-client/src/oauth.ts` | long-lived loopback callback, SDK provider sessions and per-key serialization |
| `MCPAuthorizationCoordinator`, `MCPAuthorizationOptions`, `MCPAuthorizationSession`, `OAuthFinishingTransport` | interface/type | `packages/mcp-client/src/oauth.ts` | host options and the client-factory seam |
| `MCPInteractiveAuthorizationUnavailableError` | class | `packages/mcp-client/src/oauth.ts` | an OAuth challenge needs a browser but the host cannot open one |
| `MCPAuthorizationFailedError` | class | `packages/mcp-client/src/oauth.ts` | callback, state, URL, timeout or authorization failure |
| `MCPAuthorizationWait` | type | `packages/mcp-client/src/client.ts` | `"blocking" | "background"`; caller policy for a browser flow |
| `MCPAuthorizationPendingError` | class | `packages/mcp-client/src/oauth.ts` | browser flow continues, but this acquisition/run proceeds without the MCP |
| `createMcpOAuthCredentialStore` | fn | `packages/mcp-client/src/oauth-store.ts` | bounded, validated, process-coordinated persistence |
| `McpOAuthCredentialStore`, `McpOAuthRecord` | interface/type | `packages/mcp-client/src/oauth-store.ts` | store operations and one persisted record |
| `McpOAuthStoreError` | class | `packages/mcp-client/src/oauth-store.ts` | corrupt, oversized, unsafe or unreadable store |
| `DEFAULT_MCP_OAUTH_CALLBACK_PORT`, `DEFAULT_MCP_OAUTH_AUTHORIZATION_TIMEOUT_MS` | const | `packages/mcp-client/src/oauth.ts` | ephemeral port `0` and five minutes |
| `MAX_MCP_OAUTH_STORE_BYTES`, `MAX_MCP_OAUTH_RECORDS` | const | `packages/mcp-client/src/oauth-store.ts` | 1 MiB and 128 records |

### 2.6 What is deliberately *not* exported

`createResilientSession` and its option types (`packages/mcp-client/src/resilient-session.ts`),
`resourceContentsToBlocks` (`packages/mcp-client/src/resources.ts`), `paginate` (`packages/mcp-client/src/resources.ts`),
`loadResourceCatalog` (`packages/mcp-client/src/resources.ts`), the late-authorization dispatcher
`runMCPRequest` (`packages/mcp-client/src/client.ts`), and the whole of
`packages/mcp-client/src/tool-results.ts` (`abortedResult` through `interpretCallResult`) are
internal. The architecture test asserts three of these are
absent from the facade and that the connection exports are re-exported *by identity*
(`packages/mcp-client/tests/architecture/connection-facade.test.ts`).

### 2.7 Model-facing tool descriptors this package synthesizes

Two, and only for a server that advertises the `resources` capability
(`packages/mcp-client/src/resources.ts`):

| Tool name | `kind` | Input schema |
| --- | --- | --- |
| `list_resources` | `resource_list` | `{ type: "object", properties: {}, additionalProperties: false }` (`packages/mcp-client/src/resources.ts`) |
| `read_resource` | `resource_read` | `{ type: "object", properties: { uri: { type: "string", … } }, required: ["uri"], additionalProperties: false }` (`packages/mcp-client/src/resources.ts`) |

They are appended only when the name is not already taken by a real tool of that server
(`packages/mcp-client/src/resources.ts`), which a test pins by pre-seeding `read_resource`
(`packages/mcp-client/tests/unit/resources.test.ts`).

## 3. Data and formats

Most connection/session state is ephemeral. Remote OAuth is the deliberate exception: SDK-validated
registrations and tokens are persisted in the private document described in §3.10. What the package
transmits and shapes:

### 3.1 The `initialize` handshake identity

The client is constructed as `{ name: CLIENT_NAME, version: VERSION }`
(`packages/mcp-client/src/client.ts`), i.e. the wire-visible client name is
`"@clarvis/mcp-client"` (`packages/mcp-client/src/version.ts`, `CLIENT_NAME`) and the version is read
from the root product manifest (`packages/mcp-client/src/version.ts`, `VERSION`). Capabilities are
`{ elicitation: {} }` when a relay was supplied and `{}` otherwise
(`packages/mcp-client/src/client.ts`).
`packages/mcp-client/tests/unit/version.test.ts` (`MCP client identity`) pins both identity fields to
their owned sources.

### 3.2 The stdio child's environment

`{ ...getDefaultEnvironment(), ...forwardedEnv, ...customEnv }` — the SDK's fixed safe base, only
the host keys explicitly named by `env_vars`, and the server's own conditionally interpolated `env`
block. The caller's remaining environment is used for `${VAR}` lookup only, never handed wholesale
to the child. Production: `resolveForwardedEnvironment` and `buildTransport` in
`packages/mcp-client/src/client.ts`. Test: the environment-forwarding cases in
`packages/mcp-client/tests/unit/mcp-transport-env.test.ts`.

### 3.3 `${VAR}` interpolation

By default, both `env` and `headers` go through `resolveStringMap(map, environment)` from `@clarvis/capability`
(`packages/capability/src/env-interpolate.ts`). Resolution is all-or-nothing and throws
`MissingEnvVarsError` naming the *distinct* unresolved variables
(`packages/capability/src/env-interpolate.ts`, message). Substitution is by
`String.replace`, so `"Bearer ${TOKEN}"` resolves to `Bearer <value>`
(`packages/capability/src/env-interpolate.ts`). An end-to-end test over a real HTTP listener
asserts the resolved value reaches the wire and the literal `${` never does
(`packages/mcp-client/tests/integration/remote-transport.test.ts`), and that an absent variable
fails the connection before any request is made. With `expandVariables: false`, the maps authored
directly as `env`/`headers` are copied literally. This is the portable Agent Plugin seam: its adapter
has already expanded only `PLUGIN_ROOT`/`PLUGIN_DATA`, and a second general `${VAR}` pass would
violate that format. Declarative `bearer_token_env_var` and `env_http_headers` are not authored
placeholder text and always resolve their named variables, even under that flag. Pinned by
`packages/mcp-client/tests/component/transport-builder.test.ts` (literal portable placeholders) and
`packages/mcp-client/tests/integration/remote-transport.test.ts` (resolved declarative credentials
beside a literal authored header).

Remote declarations may additionally derive `Authorization: Bearer <value>` from
`bearer_token_env_var` and arbitrary header values from `env_http_headers`. Missing variables fail
before the transport is built, and resolved values remain confined to the resource origin by
`createMCPRemoteFetch`. Production: `buildTransport` in
`packages/mcp-client/src/client.ts`. Test: the environment-backed header cases in
`packages/mcp-client/tests/integration/remote-transport.test.ts`.

### 3.4 Wire tool names

`makeRegistry` performs name allocation in two passes (`packages/mcp-client/src/registry.ts`,
`makeRegistry`). The first pass counts provider-local names case-insensitively and reserves every
local spelling that matches `[A-Za-z0-9_-]+`, occurs exactly once, and does not collide
case-insensitively with the caller's host-reserved names. Every such tool keeps that exact local
spelling as its model-facing `wireName`. Reserving the complete eligible set before any fallback is
allocated prevents a namespaced fallback from taking a later local name, so reversing connection
order cannot change which provider owns that local spelling. The registry test
`"reserves a unique local name before allocating colliding namespaced fallbacks"` runs both orders
and pins that rule (`packages/mcp-client/tests/unit/registry.test.ts`).

A duplicate or case-colliding local name, a spelling outside the safe character set, or a
host-reserved local name falls back to the dotted `mcpName.toolName` projected by
`toWireToolName` (`packages/mcp-client/src/registry.ts`, `toWireToolName`). That projection replaces
every character outside `[A-Za-z0-9_-]` with `_` and appends `_1`, `_2`, … until unused,
case-insensitively. A unique safe local name therefore remains `diagram_create_mermaid`; two servers
offering `search`/`SEARCH` receive namespaced fallbacks. The tests
`"preserves a unique provider-safe local name for skill/tool compatibility"` and
`"falls back to namespaced names when local names collide across servers"` pin both branches
(`packages/mcp-client/tests/unit/registry.test.ts`).

Each tool is indexed four ways — exact wire name, dotted `mcpName.toolName`, and the lowercased form
of each, first-wins on lowercase collision (`packages/mcp-client/src/registry.ts`, `makeRegistry`).
`NamespacedTool` (`packages/capability/src/run.ts`, `NamespacedTool`) carries both `fullName` and
`wireName`; the dotted `fullName` remains the canonical identity and is resolvable regardless of
which model-facing spelling was allocated.

### 3.5 `ConnectionEvent`

`{ connection_id, scope: { workspace, owner }, mcp_name, transport, state, cause? }`
(`packages/mcp-client/src/connection.ts`). `connection_id` is a `randomUUID()` allocated once per session
(`packages/mcp-client/src/resilient-session.ts`) and also bound onto every log record from that session.

### 3.6 `ToolResult` failure vocabulary

Produced entirely by `src/tool-results.ts` and pinned by
`packages/mcp-client/tests/unit/tool-results.test.ts` plus the OAuth-pending resilient-session case:

| Producer | `code` | `kind` | `outcome` | Message form |
| --- | --- | --- | --- | --- |
| `abortedResult(label)` | `mcp_runtime_error` | `cancelled` | — | `Tool 'X' call aborted (run cancelled).` |
| `abortedResult(label, true)` | `mcp_runtime_error` | `cancelled` | `unknown` | same |
| `runtimeErrorResult` | `mcp_runtime_error` | `operational` | — | `Tool 'X' failed: <err>` |
| `unavailableResult` | `mcp_unavailable` | `unavailable` | — | `MCP 'N' is unavailable.` |
| `authorizationPendingResult` | `mcp_unavailable` | `unavailable` | — | `MCP 'N' is inactive for this run while browser authorization is pending.` |
| `interruptedResult` | `mcp_runtime_error` | `operational` | `unknown` | `Tool 'X' failed in transit: <err>. The connection was restored, but the call may or may not have executed on the server — retry only if running it twice is safe.` |
| `becameUnavailableResult` | `mcp_unavailable` | `unavailable` | `unknown` | `MCP 'N' became unavailable: <err>` |
| `timeoutResult` | `mcp_timeout` | `timeout` | `unknown` | `Tool 'X' timed out after Nms (still connected).` |

`interpretCallResult` (`packages/mcp-client/src/tool-results.ts`) maps a successful SDK result to `{ ok: true, data: raw }`
and an `isError: true` result to `mcp_runtime_error` carrying the **first** entry of `content` that
has a string `text`, falling back to `Tool 'X' returned an error.`
(`packages/mcp-client/src/tool-results.ts`).

### 3.7 Resource read blocks

`resourceContentsToBlocks` (`packages/mcp-client/src/resources.ts`) maps each content entry to a `text` or `image` block:

| Entry | Result |
| --- | --- |
| string `text` | `{ type: "text", text: capText(text) }` |
| `blob` with `image/*` mime and `≤ 2_000_000` decoded bytes | `{ type: "image", data, mimeType }` |
| `blob` with `image/*` mime, larger | text: `image resource <mime>, N bytes exceeds the 2000000-byte inline cap — not inlined; uri=<uri>` |
| any other `blob` | text: `binary resource <mime ?? application/octet-stream>, N bytes — not inlined; uri=<uri>` |
| empty/absent `contents` | `Resource 'X' returned no content.` |
| present but nothing readable | `Resource 'X' returned no readable content.` |

`capText` truncates at 2 MiB on a UTF-8 character boundary by walking back over continuation bytes
(`packages/mcp-client/src/resources.ts`), appending `\n\n[resource truncated at 2000000 bytes]`. Pinned for both
ASCII and multibyte input (`packages/mcp-client/tests/unit/resources.test.ts`).
`base64ByteLength` computes decoded size from padding without decoding (`packages/mcp-client/src/resources.ts`).

### 3.7a `list_resources` output shape

`catalogResult(catalog)` (`packages/mcp-client/src/resources.ts`) is the whole envelope
`MCPConnection.listResources()` answers with (call site `packages/mcp-client/src/connection.ts`): `{ ok: true, data:
{ content: [{ type: "text", text: JSON.stringify(catalog ?? { resources: [], resourceTemplates: [] },
null, 2) }] } }`. There is no separate error shape — a disabled or never-probed catalog (`catalog ===
null`) serializes as the empty pair rather than an error or an empty array, so a model reading this
tool's result cannot distinguish "no resources" from "resources are off for this server."

### 3.8 The pool key

A JSON string (`packages/mcp-client/src/connection-manager.ts`) of, in order: `workspace`,
`owner` (or `null` under `poolSharing: "workspace"`), `name`, `transport`, `command ?? null`,
`args ?? []`, sorted `env`, sorted `env_vars`, `cwd ?? null`, `url ?? null`, sorted `headers`, sorted
`env_http_headers`, `bearer_token_env_var ?? null`, `expandVariables ?? true`, `resources ?? null`,
`oauth ?? null`, `startup_timeout_ms ?? null`, `tool_timeout_ms ?? null`, and sorted `enabled_tools`
and `disabled_tools`. `sortKeys` makes map key order irrelevant; the arrays whose order
does not affect the physical connection are sorted inline. The owner in the key is
`ownerSegment(owner)` (`packages/mcp-client/src/connection-manager.ts`, `packages/paths/src/roots.ts`), so two owner
ids that differ only by percent-encoding stay separate
(`packages/mcp-client/tests/component/connection-manager.test.ts`).

A compile-time drift lock, `PoolKeyCoversConfig` / `_poolKeyDriftLock`
(`packages/mcp-client/src/connection-manager.ts`), fails to type-check if `McpServerConfig`
grows a field not covered by the key or explicitly classified as non-physical. `shared` is the
precondition for entering this path; `auto_tools`, `enabled`, `required`, and `authentication` are
host/run policy rather than physical connection identity. Its own
comment states why a runtime test cannot cover it: "altering `transport`, `url` or `headers` makes
the server unpoolable, so no slot is ever created and the assertion is vacuous"
(`packages/mcp-client/src/connection-manager.ts`).
The focused `auto_tools` exclusion is pinned by the "run-level automatic tool admission" case in
`packages/mcp-client/tests/component/connection-manager.test.ts`; owner/workspace isolation
and the `resources` and `cwd` discriminants are pinned in the surrounding block.

Pool keys are never logged raw. `poolKeyHash` reports the first 12 hex characters of a SHA-256
(`packages/mcp-client/src/connection-manager.ts`), and a test asserts the record matches `/^[0-9a-f]{12}$/` and does
not contain the owner string (`packages/mcp-client/tests/component/observability-pool.test.ts`).

### 3.9 Windows spawn argv

`mcpSpawnArgv` (`packages/mcp-client/src/bun-stdio-client.ts`) returns `{ argv: [command...args], verbatim: false }`
unchanged off Windows. On Windows it resolves the command on `PATH`
(`packages/paths/src/which.ts`) and, only if the resolved extension is `.cmd` or `.bat`
(`packages/mcp-client/src/bun-stdio-client.ts`), rewrites it to
`[ComSpec ?? "cmd.exe", "/d", "/s", "/c", '"part" "part" …']` with `verbatim: true`. A
double quote anywhere in the command or arguments throws instead. The exact produced line is pinned:
`'"myserver.cmd" "--flag" "value"'`
(`packages/mcp-client/tests/unit/mcp-spawn-argv.test.ts`).

### 3.10 OAuth credential document

The store is strict JSON `{ "version": 1, "records": { "<64 lowercase hex>": record } }`
(`packages/mcp-client/src/oauth-store.ts`). A record contains only
`redirect_url?`, SDK `client_information?`, SDK `tokens?`, and integer `updated_at`; unknown fields,
invalid SDK shapes and records larger than 512 KiB are refused
(`packages/mcp-client/src/oauth-store.ts`). The map is capped at 128 newest records and the
whole UTF-8 document at 1 MiB.

The record key is SHA-256 over the workspace, owner, canonical resource URL and the configured
`client_id`, `callback_url`, `callback_port`, and `client_metadata_url`, with the three identity
strings separated by NUL bytes (`packages/mcp-client/src/oauth.ts`); none of those raw
identities, configuration values, or credentials appear as JSON keys. The callback URL, when stored, must be credential-free HTTPS or
credential-free loopback HTTP with an explicit port; query strings and fragments are refused. The
path may be the configured callback path or its stable server-specific suffix. Production:
`validRedirect` in `packages/mcp-client/src/oauth-store.ts`. Test: redirect validation in
`packages/mcp-client/tests/integration/oauth-store.test.ts`.
The settings and direct-request schemas enforce the same no-query/no-fragment shape before a browser
flow can start. Production: `mcpOAuthSchema` in `packages/loop/src/settings/settings-schema.ts` and
`oauthSchema` in `packages/loop/src/validation/request/server-schemas.ts`. Test:
`packages/loop/tests/unit/engine-server.test.ts`.
The default host path is `<global>/state/mcp-oauth.json`
(`packages/paths/src/global.ts`).

## 4. Behavior

### 4.1 Building a client — `createMCPClientFactory`

1. Bind a per-server logger with `{ mcp, transport }`
   (`packages/mcp-client/src/client.ts`).
2. `buildClient(authProvider?)` constructs the SDK `Client` with `CLIENT_NAME`/`VERSION`,
   advertising `elicitation` only if a relay was passed, builds the transport with the optional SDK
   OAuth provider, and captures the negotiated protocol version
   (`packages/mcp-client/src/client.ts`).
3. If a relay was passed, register a request handler on `ElicitRequestSchema` that forwards
   `request.params` and `extra.signal` to `relay.handle` and casts the answer to `ElicitResult`
   (`packages/mcp-client/src/client.ts`).
4. Monkey-patch `transport.setProtocolVersion` to capture the negotiated version before delegating to
   the SDK's own implementation (`packages/mcp-client/src/client.ts`). The doc comment states the reason: "The SDK
   hands the negotiated version to the transport and exposes no getter for it, so a factory that wants
   to report it has to observe `setProtocolVersion`" (`packages/mcp-client/src/client.ts`). A live stdio integration
   test asserts the captured value matches `/^\d{4}-\d{2}-\d{2}$/`
   (`packages/mcp-client/tests/integration/stdio-client.test.ts`).
5. `connectBuilt` calls `client.connect` with the signal/deadline and closes a failed client
   (`packages/mcp-client/src/client.ts`). Without configured authorization, or for stdio,
   this is the entire path.
6. A remote OAuth-enabled path requires `opts.scope`, serializes work under its credential key,
   creates one provider session, and tries the connection with stored credentials. Only an SDK
   `UnauthorizedError` enters interactive authorization. Under the default `"blocking"` policy the
   factory calls `finishAuth`, closes the challenged client, then constructs and connects one fresh
   client with the saved token. Under `"background"`, the same browser/callback work continues
   independently as soon as human wait begins and the caller receives
   `MCPAuthorizationPendingError`; a same-key caller queued behind that flow receives the same
   immediate pending outcome. The completion includes reconnect verification and temporary-handle
   close. Other failures propagate without being reclassified as OAuth
   (`createMCPClientFactory` in `packages/mcp-client/src/client.ts`).
7. Every production remote handle is registered in the internal late-authorization dispatcher.
   `runMCPRequest` uses that dispatcher around catalog pages, resource probes, health pings and live
   tool/resource calls. If one of those SDK requests starts a browser flow and throws
   `UnauthorizedError`, same-key completion is single-flighted. Blocking callers repeat the refused
   operation once; background callers return `mcp_unavailable` for this run while the token exchange
   continues, without reconnecting or mutating circuit state. No other failure is retried
   (`attachAuthorization`, `packages/mcp-client/src/client.ts`;
   `packages/mcp-client/src/connection.ts`;
   `packages/mcp-client/src/resources.ts`;
   `packages/mcp-client/src/resilient-session.ts`).

### 4.2 Building a transport — `buildTransport`

| Branch | Condition | Result |
| --- | --- | --- |
| stdio, no `command` | `packages/mcp-client/src/client.ts` | throws `server 'N': command is required for stdio transport` |
| stdio under Bun | `typeof Bun !== "undefined"` (`packages/mcp-client/src/client.ts`) | `BunStdioClientTransport` with `onStderr`/`onStderrEnd` wired to the forwarder when a sink was given |
| stdio elsewhere | `packages/mcp-client/src/client.ts` | SDK `StdioClientTransport` with `stderr: "pipe"` when a sink was given, then `drainStderrStream` |
| http/sse, no `url` | `packages/mcp-client/src/client.ts` | throws `server 'N': url is required for <transport> transport` |
| `http` | `packages/mcp-client/src/client.ts` | `StreamableHTTPClientTransport(url, { fetch, authProvider? })` |
| `sse` | `packages/mcp-client/src/client.ts` | `SSEClientTransport(url, { fetch, authProvider? })` |

Interpolated headers are injected by `createMCPRemoteFetch` only when the requested origin equals
the configured MCP resource origin. The transport deliberately supplies no header-bearing
`requestInit`, so SDK OAuth discovery, registration and token calls at another origin cannot inherit
resource credentials. OAuth requests also retain their own SDK header instead of being overwritten
by a configured resource header, including when both services share an origin. The same network
authority manually follows redirects, strips explicit credential headers across origins, and—after
an OAuth challenge or SDK authorization header—refuses every non-HTTPS destination except loopback
HTTP before fetching it (`packages/mcp-client/src/remote-fetch.ts`; construction at
`packages/mcp-client/src/client.ts`). The transport-type
mapping, the two "required" errors, the `${VAR}` behaviours, and `defaultCwd` precedence
(`server.cwd ?? defaultCwd`, `packages/mcp-client/src/client.ts`) are all pinned in
`packages/mcp-client/tests/component/transport-builder.test.ts`. When neither
`cwd` is given, the key is absent from the spawn parameters entirely, preserving host inheritance
(`packages/mcp-client/tests/component/transport-builder.test.ts`).

### 4.3 Opening a connection — `openConnection`

Order, from `openConnection` (`packages/mcp-client/src/connection.ts`):

1. Bind `{ workspace, owner, mcp, transport }` onto the logger.
2. Define a `connect` closure that increments an attempt counter and calls `observedConnect`; the same closure is later handed to the session as its reconnect function,
   so **a reconnect keeps the same relay and the same attempt numbering** — pinned by a test asserting
   two `mcp.connect.begin` records with `attempt` 1 then 2
   (`packages/mcp-client/tests/component/observability-connection.test.ts`).
3. Connect once; any non-authorization/deferred and non-`MCPConnectionFailedError` throw is wrapped
   into one, so a
   factory throwing the bare string `"factory offline"` surfaces as
   `{ code: "mcp_connection_failed", mcpName: "docs", transport: "stdio", message: "factory offline" }`
   (`packages/mcp-client/tests/component/connection.test.ts`).
4. Load the tool catalog. On failure the handle is closed best-effort and the error is rethrown as
   `Failed to list tools on 'N': <err>` — the close is asserted to happen exactly once
   (`packages/mcp-client/tests/component/connection.test.ts`).
5. If `resourcesEnabled` **and** `server.resources !== false`, probe the resource catalog and append
   the two synthetic descriptors. Any throw here is caught and logged at `warn` as
   `mcp.resources.probe_failed`; the connection survives without resource tools.
6. Read, trim and bound the server's initialize `instructions` to 8,192 Unicode code points.
   Production: `openConnection` and `MAX_MCP_SERVER_INSTRUCTIONS_CHARS` in
   `packages/mcp-client/src/connection.ts`. Test: `packages/mcp-client/tests/component/connection.test.ts`
   (`retains bounded initialize instructions on the opened connection`).
7. Apply `enabled_tools`/`disabled_tools` to the discovered real and synthetic descriptors.
8. Create the resilient session.
9. Build the `MCPConnection` façade : `status` delegates to the session, `callTool` runs
   through `session.invoke` with `interpretCallResult`, `readResource` through `session.invoke` with
   `resourceReadResult`, and `listResources` answers **synchronously from the catalog captured at open
   time**, never touching the session.

`connectWithinBound` (`packages/mcp-client/src/connection.ts`) races the factory promise against a timeout and the
caller's abort signal. Three details are load-bearing and each is tested:

- If the caller's signal is already aborted, the factory is **not invoked at all**; its comment says "a dedicated session may discover transport loss just after its
  owning run was cancelled; starting a reconnect here would create native work whose only possible
  outcome is immediate disposal". Pinned at
  `packages/mcp-client/tests/component/connection-manager.test.ts`, which asserts the second
  factory call never happens.
- A factory promise that settles *after* the race was lost has its handle closed, pinned twice — once for the timeout path and once for the caller-abort path
  (`packages/mcp-client/tests/component/connection.test.ts`).
- The signal handed to the factory is a **fresh** `AbortController`'s signal, not the caller's
  (created, passed); a test asserts `factoryOptions.signal !== signal`
  (`packages/mcp-client/tests/component/connection.test.ts`).
- The connection deadline is paused, with nesting depth, while a person is authorizing or a second
  same-key flow is queued; only elapsed machine-connect time is charged. Cancellation remains live
  throughout (`packages/mcp-client/src/connection.ts`), pinned with a fake clock at
  `packages/mcp-client/tests/component/connection.test.ts`.

Timeout message: `Failed to connect to MCP 'N' within <ms>ms.`; abort message:
`Connection to MCP 'N' aborted (run cancelled).`.

### 4.4 Tool catalog pagination — `loadToolCatalog`

`packages/mcp-client/src/connection.ts`. Up to `MAX_TOOL_CATALOG_PAGES = 50` iterations. Per tool: refuse if
`tools.length >= maxEntries`; add `Buffer.byteLength(JSON.stringify(descriptor))` and refuse if the
running total exceeds `maxBytes`. A missing `inputSchema` defaults to
`{ type: "object", properties: {} }` and a non-array `tools` field yields an empty page
 — both pinned (`packages/mcp-client/tests/component/connection.test.ts`). Pagination stops when
`nextCursor` is absent, empty, or identical to the cursor just used; exhausting 50 pages
throws. The programmatic bounds are clamped by `boundedCatalogLimit`
(`packages/mcp-client/src/connection.ts`): a non-finite value falls back to the hard maximum, and a finite one is
`min(hardMaximum, max(0, floor(value)))` — so **a caller can only lower a bound, never raise it**,
pinned by passing `Infinity`/`NaN` and still failing at "2048-entry limit"
(`packages/mcp-client/tests/component/connection.test.ts`).

### 4.5 Resource catalog probe — `loadResourceCatalog`

`packages/mcp-client/src/resources.ts`. Returns `null` immediately unless `getServerCapabilities()?.resources` is truthy. Then paginates `resources/list` and `resources/templates/list` via
the shared `paginate`. The template listing is **optional**: any error other than a
`MCPResourceCatalogLimitError` is swallowed into `resourceTemplates: []` with a `debug` record, pinned at `packages/mcp-client/tests/unit/resources.test.ts`. The template
pass's budget is the resource pass's remainder — `maxItems - resources.length` and
`maxBytes - resourceBytes`, both floored at 0.

`paginate` shares the page cap and cursor-termination rules with the tool catalog;
its budgets are also hard-clamped by `boundedCatalogLimit`. Tests pin cursor
following, repeated-cursor termination, the 50-page cap, both budget dimensions, and the hard clamp
of `Infinity`/`NaN` (`packages/mcp-client/tests/unit/resources.test.ts`).

### 4.6 The resilient session

`createResilientSession` (`packages/mcp-client/src/resilient-session.ts`) holds `status`, a `generation` counter, two
failure streaks, an in-flight count, a `lastActivityAt` stamp, and an armed health timer. Its clock and timers come from an injectable `ResilientSessionRuntime` whose production
implementation uses `setTimeout` + `unref`.

#### `invoke` — the per-call state machine

`packages/mcp-client/src/resilient-session.ts`. Preconditions, in order :

| Condition | Result |
| --- | --- |
| caller signal already aborted | `abortedResult(label)` — the run function is never called |
| session closed | `unavailableResult(mcpName)` |
| a reconnect is in flight and it fails | `abortedResult` if aborted, else `unavailableResult` |
| `status === "unavailable"` and still inside the cooldown | `unavailableResult` |
| `status === "unavailable"` past the cooldown | attempt a `"reprobe"` reconnect; on failure, `unavailableResult` |
| signal aborted after the reconnect/cooldown checks above but before dispatch | `abortedResult(label)` |

The last row exists because the two awaits above it (`await reconnecting`, `await
ensureReconnected(...)`) can let the caller's signal abort during the wait — a second,
later abort re-check that the first five preconditions alone would miss.

Then the call runs through the late-authorization boundary with
`{ timeout: callTimeoutMs, signal? }`. Outcomes:

| Event | Next state | `McpCallOutcome` | Effect |
| --- | --- | --- | --- |
| success | `connected` | `"ok"` | both streaks reset, `lastActivityAt` stamped, `onResult(raw)` |
| signal aborted after dispatch | unchanged | `"aborted"` | `abortedResult(label, true)` — `outcome: "unknown"` |
| `MCPAuthorizationPendingError` | unchanged | `"unavailable"` | `authorizationPendingResult`; no reconnect, streak or circuit transition |
| MCP `RequestTimeout`, streak `< threshold` | unchanged (`connected`) | `"timeout"` | `timeoutResult(label, callTimeoutMs)` |
| MCP `RequestTimeout`, streak `>= threshold` | `unavailable` | `"timeout"` | `becameUnavailableResult`; the threshold crossing is warned exactly once |
| MCP protocol error | unchanged (`connected`) | `"protocol"` | `runtimeErrorResult` — **no reconnect** |
| transport error, first in this generation | reconnect attempted | `"transport"` | on success `interruptedResult` (`outcome: "unknown"`); on failure `becameUnavailableResult` |
| transport error, `transportFailStreak >= 2` | `unavailable` | `"transport"` | `becameUnavailableResult` — circuit opens without another reconnect |

`McpCallOutcome` (`packages/mcp-client/src/resilient-session.ts`) is the closed 6-member type `"ok" | "timeout" |
"protocol" | "transport" | "aborted" | "unavailable"` tagging the `mcp.call.done` record built in the `invoke`
`finally` block (§6.5). It is initialized to `"transport"` before dispatch, which
is why the two transport-error rows above never assign it explicitly — the declared default *is* the
transport branch, reassigned by the other outcomes. None of the six preconditions in the
table above reach this `finally` block at all, so a call rejected before dispatch produces no
`mcp.call.done` record.

`transportFailStreak` advances at most once per generation, guarded by `lastFailedGeneration`. Every one of these transitions is pinned in
`packages/mcp-client/tests/unit/resilient-session.test.ts`, including the two circuit
breakers with their paired `recovered` event, streak reset on success, protocol errors reconnecting zero times, and the two
cancellation shapes.

The interrupted-call comment states the contract the `outcome: "unknown"` flag exists for: "Once
`run` has been invoked the request may already have reached the server. Cancellation is still
reported as cancellation, but callers must reconcile mutations before issuing a new idempotency key".

#### Reconnect

`reconnectOnce` sets `status = "lost"`, closes the stale handle within the close grace,
awaits `options.reconnect()`, and — if the session closed meanwhile — closes the fresh handle instead
and returns `false`. On success it swaps the handle, increments `generation`, resets the
timeout streak and clears the cooldown, and emits `recovered` only if an `unavailable`
was emitted earlier. On failure it marks unavailable with cause `reconnect_failed`.

`ensureReconnected` single-flights: a caller whose observed generation is stale simply reads
the current status, and concurrent callers share one `reconnecting` promise. Pinned by a
test asserting two concurrent failing calls produce exactly one reconnect
(`packages/mcp-client/tests/unit/resilient-session.test.ts`).

#### Health ping

`runHealthCheck` is skipped while another ping is running, after close, when not
`connected`, when a call is in flight, or when there has been activity within the interval. Otherwise it calls `client.ping` through the late-authorization boundary, bounded by
`connectTimeoutMs`; success
stamps activity and clears the timeout streak, failure triggers a `"health_ping_failed"` reconnect. `armHealthCheck` re-arms itself through `.finally` and does nothing when the
interval is `<= 0` or the session is closed. Tests pin: an idle failed session is
reconnected (`packages/mcp-client/tests/unit/resilient-session.test.ts`), a failed reconnect
marks unavailable with cause `reconnect_failed`, `healthPingIntervalMs: 0` schedules
nothing, and a ping is skipped while a call is in flight.

#### Close

`close` memoizes one promise, cancels the health timer, emits `closed` exactly once, awaits
any pending reconnect and then the handle close — each within `awaitLifecycle`, which races the work
against a grace timer and, on expiry, detaches the work rather than continuing to wait. `normalizeMcpCloseGraceMs` turns a non-finite value into the 2 s default and
clamps everything else to `[0, 30_000]` — pinned by passing `Infinity` and observing a 2 000 ms
return (`packages/mcp-client/tests/unit/resilient-session.test.ts`).

`emit` suppresses every state except `closed` once the session is closed, and swallows a
throwing sink. A test proves a background reconnect failing after close emits nothing
(`packages/mcp-client/tests/unit/resilient-session.test.ts`).

### 4.7 The pool — `acquire`

`packages/mcp-client/src/connection-manager.ts`. Steps:

1. Reject outright if closed — **before** opening anything. The comment records the prior
   defect: "`poolable` used to include `!closed`, so an acquire on a torn-down manager took the
   unpooled branch: it spawned a real subprocess, then closed it and threw"
   (`packages/mcp-client/tests/component/connection-manager.test.ts`), and the test asserts zero connects after
   `closeAll`.
2. `poolable = transport === "stdio" && shared === true`. Anything else gets a dedicated
   connection closed on release (`makeFreshLease`).
3. Compute the pool key and warn once per **server name** if a relay was supplied (`warnRelayDropped`). The key choice is documented: a per-slot flag would re-warn every
   idle TTL, and the pool key "embeds the owner, which under the server's `header` and `allowlist`
   modes is caller-supplied, so a client varying it per request would grow this set without limit". Pinned at `packages/mcp-client/tests/component/connection-manager.test.ts` (exactly one warning
   across two acquires).
4. If a slot exists at refcount 0 whose connection is no longer `connected`, drop it, report
   `evicted{reason:"unhealthy"}` and close it in the background.
5. If a slot exists, bump the refcount, cancel its idle timer, and await its shared `connPromise`
   through `awaitAbortable` — which rejects on the caller's signal **without disturbing the shared
   promise** other runs may be awaiting (comment).
6. Otherwise create a slot at refcount 1 whose `connPromise` is `openFresh(o, undefined, true)` —
   note the `undefined` signal, so a shared connect is not bound to one caller — and register a
   post-settle handler that closes an abandoned connection (refcount fell to 0 while connecting) or
   deletes the slot on rejection.

`makeSharedLease.release` decrements; at zero it closes rather than pools when the
manager is closed, the slot has been replaced, or the connection is no longer `connected`; otherwise
it arms the idle timer. `armIdle` stamps `idleSince`, schedules a `ttl` eviction, and then
evicts oldest-first until at most `maxIdleConnections` zero-ref slots remain.

Every one of these behaviours is covered in `tests/component/connection-manager.test.ts`: warm reuse
across sequential runs, refcounted sharing, single-flighted first connect, close only after the last release, no reuse without `shared`,
key discrimination by name/args/env-order/cwd/`resources`, an aborted lease
never poisoning a healthy shared connection, a failed shared connect leaving no slot, unhealthy discard, TTL eviction, idempotent release, and release-after-`closeAll` neither re-pooling nor double-closing.

### 4.8 Admission control

Three independent bounds:

| Bound | Mechanism | Behaviour on exhaustion |
| --- | --- | --- |
| `maxConnections` (live + connecting) | `admittedConnections` counter checked at `openFresh` entry | `warn mcp.pool.limit`; background acquire throws `MCPBackgroundConnectDeferredError`, blocking acquire throws `MCPConnectionLimitError` |
| `maxParallelConnects` (handshakes/initial background authorization completions) | `createPhysicalConnectGate` wrapping the factory | blocking acquire waits with sampled `mcp.pool.connect_queued`; background acquire throws `MCPBackgroundConnectDeferredError` immediately and is never logged as queued |
| `maxIdleConnections` (zero-ref warm slots) | oldest-first eviction inside `armIdle` | `debug mcp.pool.evicted{reason:"max_idle"}` |

Capacity is released only when `connection.close()` completes, via the wrapper installed by
`manageConnectionClose`, whose callbacks are nulled after first use "so a retained old
lease cannot keep the manager's maps and counters reachable".

Two quarantine rules exist because a factory may ignore its abort signal:

- The **handshake permit** is held until the physical factory promise settles, not until the logical
  wait ends. Its comment: "If the logical connect timeout freed this permit, repeated
  acquires could start one never-settling subprocess or HTTP handshake per timeout". Pinned by six timed-out acquires producing exactly two physical attempts
  (`packages/mcp-client/tests/component/connection-manager.test.ts`).
- An initial background OAuth pending outcome transfers both the handshake permit and connection
  slot to its completion promise. A catalog challenge happens after the handshake and retains its
  connection slot through temporary-handle cleanup while preserving the completion's outcome.
  Repeated background acquires fail fast without starting another physical attempt or consuming
  retained capacity; a blocking embedder still queues. Pinned by
  `packages/mcp-client/tests/component/{connection,connection-manager}.test.ts` (catalog completion,
  retained OAuth limits, abort/pending races, and immediate background degradation).
- The **connection slot** stays reserved when a timed-out factory attempt has not settled; a
  `warn mcp.connect.quarantined` is emitted and capacity is released when the attempt finally unwinds. Pinned at `packages/mcp-client/tests/component/connection-manager.test.ts`.

All four numeric limits pass through `finiteIntegerAtLeast`, so `NaN`/`Infinity` fall
back to the defaults rather than disabling admission — pinned individually
(`packages/mcp-client/tests/component/connection-manager.test.ts`).

### 4.9 `closeAll`

`closeAllInner` sets `closed`, aborts the shutdown controller linked into every open connect, closes
the physical gate, and then closes every live dedicated connection, every handle captured
mid-handshake by `withInitialHandleTracking`, every pending open and physical attempt once it
resolves, every retained OAuth admission registered while those attempts settle, and every pooled
slot. `trackHandleClose` installs an idempotent observable close while preserving mutable handle
identity; its read-only fallback wrapper inherits the original late-authorization boundary, so a factory that
resolves after caller abort or connect timeout cannot let manager teardown finish until that late
handle closes or the shared grace expires. The whole set is awaited inside `awaitCloseGrace`, which
returns at the grace and detaches the remainder. Production:
`packages/mcp-client/src/connection-manager.ts` (`withInitialHandleTracking`, `trackHandleClose`,
`closeAllInner`, `awaitCloseGrace`). Pinned: `packages/mcp-client/tests/component/connection-manager.test.ts`
(`waits for a late handle close after abort until the shared close grace`, the equivalent timeout
case, never-settling open/close cases, shared connection still connecting, and late OAuth admission
drain).

### 4.10 Bounded HTTP fetch

`createMCPBoundedFetch` (`packages/mcp-client/src/bounded-fetch.ts`) returns a `FetchLike` that:

1. Creates an upstream `AbortController` and combines it with the caller's signal via
   `AbortSignal.any`.
2. Merges the configured headers over the request's own.
3. Classifies the response as an event stream by `content-type` containing `text/event-stream`.
4. For a non-stream response with a declared `content-length` over the limit, refuses **before
   reading a byte**: log at `error`, abort upstream, start-and-detach the body cancel, throw.
5. Otherwise re-wraps the body in a `ReadableStream` whose `pull` counts bytes. Non-stream responses
   are bounded by cumulative `maxResponseBytes`; event streams are bounded per **event**,
   where the counter resets on a blank line, i.e. two consecutive newlines.

The doc comment states the cancellation rule: "Cancellation is started and observed, but never
awaited on the failure path: a broken transport's cancel algorithm must not defeat the byte limit
itself". Two tests pin exactly that by making `cancel()` return a promise that never
settles (`packages/mcp-client/tests/unit/bounded-fetch.test.ts`), and one pins that a long-lived
SSE stream whose *total* exceeds the JSON cap is allowed as long as each event fits.
`boundedPositive` again only allows lowering a limit.

### 4.11 `BunStdioClientTransport`

`start` refuses a second start, computes argv via `mcpSpawnArgv`, spawns with all three
streams piped and `windowsVerbatimArguments` only when the cmd-routing branch fired, and
arms two readers whose rejections are routed through `suppressSecondaryRejection(…, "transport.onerror")`.

`send` writes one outbound JSON-RPC message as a single newline-framed line —
`` `${JSON.stringify(message)}\n` `` — to the child's stdin, then calls `stdin.flush()`. It throws a
plain `Error("Not connected")` if `this.process?.stdin` is absent or is a numeric fd,
i.e. before `start` has run or after `close` has torn the process down.

`readMessages` scans each chunk for `0x0a`, accumulating chunk slices into a frame and
emitting on each newline. `appendFrameChunk` enforces `maxFrameBytes` **before** retaining
the bytes, logging at `error` and throwing `MCPStdioFrameLimitError`; it copies with
`.slice()` rather than `.subarray()` because "`subarray` would keep the stream's whole backing chunk
alive for a tiny trailing fragment". `emitFrame` concatenates, strips a
trailing `\r`, decodes with a **fatal** UTF-8 decoder, and parses through `JSONRPCMessageSchema`. Because framing is byte-level and decoding happens only on a complete frame, a 4-byte
character split across two pipe chunks survives — pinned for stdout and, independently, for stderr
(`packages/mcp-client/tests/unit/bun-stdio-decoder.test.ts`), including under interleaved
concurrent reads proving the two decoders are independent.

`readStderr` decodes with a streaming decoder, routing to `onStderr` when given and to the
parent stderr otherwise, flushes the decoder tail, and **always** calls `onStderrEnd` in a `finally`
 — pinned for both the clean and the faulted stream
(`packages/mcp-client/tests/unit/bun-stdio-decoder.test.ts`). `writeStderr` honours backpressure by
awaiting `drain`, registering the resolver in a set so teardown can release it; a test proves the reader stops pulling until drain
(`packages/mcp-client/tests/unit/bun-stdio-decoder.test.ts`) and another proves a permanently
blocked writable cannot keep `close()` pending.

`closeInner` ends stdin, waits `closeGraceMs` (default 2 000), escalates to
`SIGTERM`, waits `terminateGraceMs` (default 500), escalates to `SIGKILL`, then sets
`discardStderr`, releases drain waiters, awaits both readers, clears the frame buffer and calls
`finish`. Once the child has exited, teardown does not wait for a slow stderr consumer:
setting `discardStderr` and releasing every backpressure waiter means a stderr chunk still sitting in
the pipe or awaiting `drain` is dropped rather than delivered, per the method's own comment, "any
already-buffered pipe tail is discarded". `finish` fires `onclose` at most once
and is also called from the `onExit` handler, so `onclose` fires on the first of child
exit or `close`.

### 4.12 Server stderr forwarding

`createServerStderrForwarder` (`packages/mcp-client/src/server-stderr.ts`) buffers until a `\n`, strips a trailing `\r`,
drops empty lines, and releases a partial line of its own once it exceeds `MAX_PENDING_CHARS = 8 KiB`. Past `maxBytes` (default 64 KiB) it emits one
`[further stderr suppressed after N characters]` line and drops everything after, including a later
`flush`. All of this is pinned line-by-line in
`packages/mcp-client/tests/unit/server-stderr.test.ts`.

`drainStderrStream` adapts a Node stream, settling on the **first** of `end` or `close`
because "a killed child emits only the second" — pinned at
`packages/mcp-client/tests/unit/server-stderr.test.ts`, together with mid-character chunk splitting
and the replacement character released for a dangling sequence at end.

### 4.13 Building the registry

`makeRegistry` (`packages/mcp-client/src/registry.ts`) first derives the case-insensitive local-name
counts and reserves all unique, safe, non-host-reserved local spellings. Its allocation pass keeps
those exact names and sends every duplicate/case-colliding, invalid, or reserved local name through
the sanitized namespaced fallback in `toWireToolName`. A fallback emits `mcp.registry.renamed` with
`reason: "invalid" | "reserved" | "collision"`; a suffix collision is reported by
`toWireToolName`'s rename callback. `resolve` then tries exact wire name → exact dotted full name →
lowercased either, preserving `fullName` as the canonical identity. `allUnavailable` is `false` when
there are no connections and otherwise requires **every** connection to be `unavailable`
— the test comments on why: "One healthy server is enough for the pool to be usable — 'all' is the
whole predicate, and an `.some` written here would strand a run whose other servers are fine"
(`packages/mcp-client/tests/unit/registry.test.ts`).

### 4.14 Interactive remote OAuth and durable credentials

`createMCPAuthorizationCoordinator` validates the callback port and a positive finite human timeout,
then clamps that timeout to 30 minutes. A portless `http://127.0.0.1/<path>` receives the actual
listener port; other loopback names require an explicit matching port. Configured HTTPS callbacks
are accepted for an ingress/proxy and bind locally on the selected port. The listener accepts only
the path selected for that session, bounds state/code, compares state timing-safely, and never
reflects either value into HTML. Production: `ensureServer`, `withCallbackId`, and `handleCallback`
in `packages/mcp-client/src/oauth.ts`. Test: the callback configuration and state cases in
`packages/mcp-client/tests/integration/oauth.test.ts`.

One session implements the SDK's `OAuthClientProvider`: a configured `client_id` is preferred as a
pre-registered public client; a configured public HTTPS `client_metadata_url` is exposed for CIMD;
otherwise the SDK may use dynamic registration. Clarvis does not depend on a vendor-hosted CIMD
document, so automatic CIMD requires the operator or plugin to supply that URL. Stored registration
and tokens are reused only when their redirect URL still matches, SDK client metadata requests
authorization-code plus refresh-token grants, and changes are persisted through the credential
store. Each interactive flow
gets a fresh 32-byte state and verifier; concurrent SDK requests share the already-open browser flow,
and the opened URL is paired with its own PKCE verifier even when starts overlap. Completion clears
that flow so a later challenge on the same connection starts cleanly
(`packages/mcp-client/src/oauth.ts`). Callback selection distinguishes pre-registered versus
dynamic clients and issuer-bound versus non-issuer responses: an eligible configured callback is
reused; otherwise a stable server-specific callback suffix is appended or the pre-registered client
falls back to the default loopback callback. When authorization metadata supplies an issuer, any
returned `iss` must match; when issuer-bound responses are advertised, `iss` is required. Before
browser opening, the authorization URL must be HTTPS or loopback HTTP; a missing, throwing or
false-returning host opener fails explicitly (`packages/mcp-client/src/oauth.ts`).
`finishAuthorization`
waits for the matching callback with cancellation and a separate human deadline, exchanges the code
through the SDK transport, and always clears pending state and the in-memory verifier.

Same-key work is serialized by a promise tail; a queued run can cancel and announces its wait so the
outer connection timer pauses (`packages/mcp-client/src/oauth.ts`). Closing the
coordinator is idempotent, rejects all pending callbacks, awaits a callback listener that is still
starting, then closes it (`packages/mcp-client/src/oauth.ts`). Tests cover key isolation,
startup/close races, state rejection, fresh sequential/concurrent flow state, credential
reuse/invalidation, headless and insecure-URL failures, authorization refusal, and serialization
(`packages/mcp-client/tests/integration/oauth.test.ts`).

Background policy changes ownership of the wait, not the OAuth protocol. Once a browser flow starts,
the run-scoped connection attempt throws `MCPAuthorizationPendingError` with an observed completion
promise; the authorization attempt stops listening to that run's abort signal, reconnects only to
persist/verify the token, then closes its temporary handle. Initial-connect, catalog-list and late
tool-call challenges all retain the callback after the run ends. A concurrent background connection
for the same credential key reports pending while the first flow still owns the browser, so it does
not wait for the five-minute deadline. The next blocking or background connection reuses the saved
token without reopening the page. Production: `createMCPClientFactory` and `attachAuthorization` in
`packages/mcp-client/src/client.ts`, pending-handle cleanup in `packages/mcp-client/src/connection.ts`,
and pending-call classification in `packages/mcp-client/src/resilient-session.ts`. Test:
`packages/mcp-client/tests/integration/oauth-transport.test.ts` (background initial, concurrent,
catalog and tool-call cases) and `packages/mcp-client/tests/unit/resilient-session.test.ts`.
`packages/mcp-client/tests/unit/remote-fetch.test.ts` pins origin-scoped resource headers,
same-origin SDK-header precedence, insecure OAuth-target refusal and pre-fetch redirect validation. A
real loopback MCP/OAuth fixture pins
protected-resource discovery, dynamic registration, S256 PKCE, code exchange, reconnect, token
reuse, a challenge during tool discovery and a challenge during a later tool call
(`packages/mcp-client/tests/integration/oauth-transport.test.ts`).

The store validates before use and never repairs silently. It reads with `O_NOFOLLOW`, refuses a
non-regular or oversized final file, wipes the read buffer, and rejects a parent whose real path is
not its lexical path (`packages/mcp-client/src/oauth-store.ts`). Mutations take a shared local
lease, re-read under the lease, bound and sort the records, assert lease ownership, write durably,
and enforce `0700`/`0600` on POSIX. Integration tests pin private modes, malformed-file
non-overwrite, byte limits, final/parent symlink refusal and independent concurrent writers
(`packages/mcp-client/tests/integration/oauth-store.test.ts`).

## 5. Invariants

`INV-0xx` ids are the repository-wide catalog's; `MCP-xx` ids are local to this document and were
derived directly from the code and tests during this pass.

**INV-030 (owned).** The package's public facade (`packages/mcp-client/src/index.ts`)
re-exports `openConnection`, `MCPConnectionFailedError`, `UNAVAILABLE_REPROBE_COOLDOWN_MS`,
`DEFAULT_TIMEOUT_STREAK_THRESHOLD` and `DEFAULT_HEALTH_PING_INTERVAL_MS` **by identity** — the facade
binding and the module binding are the same object — and does **not** expose
`createResilientSession`, `resourceContentsToBlocks` or `interpretCallResult`.
Pinned: `packages/mcp-client/tests/architecture/connection-facade.test.ts`.

**INV-031 (owned).** The MCP elicitation relay accepts the exact `ElicitRequestSchema` /
`ElicitResultSchema` shapes the SDK defines, forwarding the request's own `params` object and abort
signal **unchanged** (by identity, not a copy or a projection).
Production: `packages/mcp-client/src/client.ts` — `relay.handle(request.params, extra.signal)`.
Pinned: `packages/mcp-client/tests/integration/sdk-elicitation-surface.test.ts`, which asserts
`params === request.params` and `receivedSignal === signal`, and parses the relay's answer through
`ElicitResultSchema`. Corroborated end-to-end against a live stdio server that initiates
`elicitation/create` (`packages/mcp-client/tests/integration/stdio-client.test.ts`,
fixture at `packages/mcp-client/tests/fixtures/mcp-server.ts`).

**MCP-01.** `buildRegistry` takes `reserved` as a **required** positional parameter; a host cannot
forget it by omission. Production: `buildRegistry` in `packages/mcp-client/src/registry.ts`.
Pinned: the `"registry — the host's reserved names are honoured, whatever they are"` cases in
`packages/mcp-client/tests/unit/registry.test.ts`.

**MCP-02.** A stdio child's environment is `getDefaultEnvironment()` plus only the caller-environment
keys explicitly named by `env_vars`, then the server's own interpolated `env`; the rest of the
caller's environment is never forwarded — regardless of whether the caller passed `process.env` or
an injected map. Production: `packages/mcp-client/src/client.ts`.
Pinned: the safe-base, explicit-forwarding, precedence, and injected-environment cases in
`packages/mcp-client/tests/unit/mcp-transport-env.test.ts`.

**MCP-03.** With the default interpolation policy, an unresolved `${VAR}` in `env` or `headers`
fails connection construction before any byte reaches the server; the literal `${…}` is never
transmitted. With `expandVariables: false`, the literal is intentionally preserved because the
owning portable adapter has already performed its narrower expansion. Environment-backed credential
declarations are the exception: `bearer_token_env_var` and `env_http_headers` always resolve the
named environment values and never transmit synthesized `${VAR}` text. Production: `buildTransport`
in `packages/mcp-client/src/client.ts` and `resolveStringMap` in
`packages/capability/src/env-interpolate.ts`. Pinned:
`packages/mcp-client/tests/component/transport-builder.test.ts` and the real-socket cases in
`packages/mcp-client/tests/integration/remote-transport.test.ts`.

**MCP-04.** An MCP protocol error (`InvalidRequest`, `MethodNotFound`, `InvalidParams`,
`InternalError`, `ParseError`) is a per-call failure: it never reconnects, never advances a streak,
and never changes `status`. Production: `packages/mcp-client/src/errors.ts`,
`packages/mcp-client/src/resilient-session.ts`.
Pinned: `packages/mcp-client/tests/unit/resilient-session.test.ts`;
code classification at `packages/mcp-client/tests/unit/errors.test.ts`.

**MCP-05.** A call that may have reached the server carries `outcome: "unknown"`, and one that
provably did not carries none. Production: `packages/mcp-client/src/tool-results.ts`; the two abort spellings at `packages/mcp-client/src/resilient-session.ts`
(no outcome) (outcome). Pinned:
`packages/mcp-client/tests/unit/resilient-session.test.ts` (pre-dispatch abort has no
outcome) (post-dispatch abort does); shapes at
`packages/mcp-client/tests/unit/tool-results.test.ts`.

**MCP-06.** A transport failure never replays the interrupted call on the fresh handle.
Production: `packages/mcp-client/src/resilient-session.ts` returns `interruptedResult` rather
than re-running `run`. Pinned:
`packages/mcp-client/tests/unit/resilient-session.test.ts` (`freshCalls` is 0 after the
reconnect) and `packages/mcp-client/tests/component/connection.test.ts`.

**MCP-07.** Concurrent reconnects are single-flighted per generation.
Production: `packages/mcp-client/src/resilient-session.ts`.
Pinned: `packages/mcp-client/tests/unit/resilient-session.test.ts`.

**MCP-08.** A programmatic catalog, response or frame bound may only *lower* the shipped ceiling; a
non-finite value falls back to it. Production: `packages/mcp-client/src/connection.ts`,
`packages/mcp-client/src/resources.ts`, `packages/mcp-client/src/bounded-fetch.ts`.
Pinned: `packages/mcp-client/tests/component/connection.test.ts`,
`packages/mcp-client/tests/unit/resources.test.ts`.

**MCP-09.** A pooled (shared) connection is opened without the acquiring run's elicitation relay and
therefore advertises no `elicitation` capability; the dropped relay is warned once per server name
rather than silently disabling the pool. Production:
`packages/mcp-client/src/connection-manager.ts` (`o.relay && !pooled`).
Pinned: `packages/mcp-client/tests/component/connection-manager.test.ts`,
`packages/mcp-client/tests/component/observability-pool.test.ts`.

**MCP-10.** The pool key carries every physical server-config field plus the scope. It deliberately
excludes `auto_tools`, `enabled`, `required`, and `authentication`, because those fields express
host/run policy rather than physical connection identity; it also excludes `shared`, which is the
precondition for reaching the pooled path rather than a discriminant. Under the default
`poolSharing: "owner"` no subprocess is shared between owners or between workspaces.
Production: `packages/mcp-client/src/connection-manager.ts`.
Pinned: the "pool key carries the scope and the whole config" cases in
`packages/mcp-client/tests/component/connection-manager.test.ts` (owner default, `workspace`
opt-in, two workspaces, encoding-distinct owners, `auto_tools` exclusion, `resources` on/off and
differing `cwd`).
A compile-time guard, not a test, covers a newly added `McpServerConfig` field
(`packages/mcp-client/src/connection-manager.ts`).

**MCP-11.** A caller's abort signal cancels only that caller's wait on a shared connect; it never
poisons the shared connection or the promise other runs are awaiting.
Production: `packages/mcp-client/src/connection-manager.ts` (a pooled `openFresh`
receives `undefined` as its signal).
Pinned: `packages/mcp-client/tests/component/connection-manager.test.ts`.

**MCP-12.** A handshake permit is released only when the physical factory promise settles, and a
connection slot stays reserved while a timed-out attempt has not unwound.
Production: `packages/mcp-client/src/connection-manager.ts`.
Pinned: `packages/mcp-client/tests/component/connection-manager.test.ts`.

**MCP-13.** After `closeAll`, every `acquire` — pooled or not — rejects **without** opening
anything. Production: `packages/mcp-client/src/connection-manager.ts`.
Pinned: `packages/mcp-client/tests/component/connection-manager.test.ts`.

**MCP-14.** Every lease `release` and every `close` is idempotent.
Production: `packages/mcp-client/src/connection-manager.ts`;
`packages/mcp-client/src/resilient-session.ts` (memoized `closePromise`);
`packages/mcp-client/src/bun-stdio-client.ts`.
Pinned: `packages/mcp-client/tests/component/connection-manager.test.ts`;
`packages/mcp-client/tests/unit/resilient-session.test.ts`.

**MCP-15.** A shutdown grace is finite and bounded: a non-finite programmatic value becomes 2 000 ms
and anything larger than 30 000 ms is clamped.
Production: `packages/mcp-client/src/resilient-session.ts`.
Pinned: `packages/mcp-client/tests/unit/resilient-session.test.ts` (the `Infinity` case);
~~the upper clamp itself is **unpinned**~~ — **pinned** by a direct
`normalizeMcpCloseGraceMs` suite in the same file, covering the clamp, its inclusive boundary, the
zero floor and the fractional truncation.

**MCP-16.** A raw pool key is never logged; only a 12-hex-character SHA-256 prefix is.
Production: `packages/mcp-client/src/connection-manager.ts`, reported.
Pinned: `packages/mcp-client/tests/component/observability-pool.test.ts`.

**MCP-17.** A `${VAR}` interpolation failure is reported by variable **name** only, never by value.
Production: `packages/mcp-client/src/connection.ts` (`missing_env: err.missing`, plus a
`sanitizeErrorMessage`d `reason`).
Pinned: `packages/mcp-client/tests/component/observability-connection.test.ts`.

**MCP-18.** Tool names are logged only when the logger is at `debug`.
Production: `packages/mcp-client/src/connection.ts` (`levelEnabled(logger, "debug")`).
Pinned: `packages/mcp-client/tests/component/observability-connection.test.ts`.

**MCP-19.** The hot per-call record `mcp.call.done` is not even constructed above `debug`, and is
sampled rather than written per call.
Production: `packages/mcp-client/src/resilient-session.ts`
(`createSampler`, `packages/capability/src/log.ts`).
Pinned: `packages/mcp-client/tests/unit/observability-session.test.ts`.

**MCP-20.** On Windows, a command whose resolved extension is `.cmd`/`.bat` is routed through
`cmd /d /s /c` with every part quoted and `verbatim: true`; a literal double quote in any part is
refused rather than escaped. Production: `packages/mcp-client/src/bun-stdio-client.ts`.
Pinned: `packages/mcp-client/tests/unit/mcp-spawn-argv.test.ts`.

**MCP-21.** A newline-delimited JSON-RPC frame is refused **before** the transport retains more than
its byte budget. Production: `packages/mcp-client/src/bun-stdio-client.ts`.
Pinned: `packages/mcp-client/tests/unit/bun-stdio-decoder.test.ts`.

**MCP-22.** An oversized HTTP body is refused without awaiting the stream's own `cancel`.
Production: `packages/mcp-client/src/bounded-fetch.ts` (both use
`detachCancel`). Pinned: `packages/mcp-client/tests/unit/bounded-fetch.test.ts`.

**MCP-23.** A server's stderr is forwarded as whole attributed lines, bounded, with exactly one
suppression notice. Production: `packages/mcp-client/src/server-stderr.ts`.
Pinned: `packages/mcp-client/tests/unit/server-stderr.test.ts`.

**MCP-24.** `allUnavailable()` is `false` for an empty registry and requires every connection to be
`unavailable` otherwise. Production: `makeRegistry` in
`packages/mcp-client/src/registry.ts`. Pinned: the `"allUnavailable is true only when EVERY
connection is unavailable"` and empty-registry cases in
`packages/mcp-client/tests/unit/registry.test.ts`.

**MCP-25.** The connection façade's `listResources` never reaches the server: it answers from the
catalog captured at open time. Production: `packages/mcp-client/src/connection.ts`.
Pinned indirectly by `packages/mcp-client/tests/component/connection-resources.test.ts`
(the fake client's `listResources` is called during open, and the result text carries the probed
catalog); **no test asserts the absence of a second call**.

**MCP-26.** Persistent OAuth identity is isolated by `(workspace, owner, canonical resource URL,
client_id, callback_url, callback_port, client_metadata_url)` and represented only by its SHA-256
digest. Production: `packages/mcp-client/src/oauth.ts`. The integration test at
`packages/mcp-client/tests/integration/oauth.test.ts` pins canonical URL plus workspace and
owner isolation; the four OAuth-configuration dimensions are enforced by production shape but are
not each independently varied by a focused key-isolation assertion.

**MCP-27.** A callback code is accepted only at the session-selected callback path with the matching
random 256-bit state; neither state nor code is reflected to the browser. A known issuer is checked
whenever `iss` is supplied and is required when authorization metadata advertises issuer-bound
responses. Production: `handleCallback`, `issuerMetadata`, and `redirectToAuthorization` in
`packages/mcp-client/src/oauth.ts`. Test: the state and issuer cases in
`packages/mcp-client/tests/integration/oauth.test.ts`.

**MCP-28.** Every OAuth fetch target, redirect and browser URL is HTTPS, except that HTTP is
permitted on a loopback host; validation happens before the request/open. A headless host fails
explicitly instead of hanging. Production: `packages/mcp-client/src/remote-fetch.ts`;
`packages/mcp-client/src/oauth.ts`. Pinned:
`packages/mcp-client/tests/unit/remote-fetch.test.ts` and
`packages/mcp-client/tests/integration/oauth.test.ts`.

**MCP-29.** Only same-key OAuth work is serialized, and both same-key queue time and human browser
time pause the connection deadline without pausing cancellation. Production:
`packages/mcp-client/src/oauth.ts`; `packages/mcp-client/src/connection.ts`. Pinned:
`packages/mcp-client/tests/integration/oauth.test.ts` and
`packages/mcp-client/tests/component/connection.test.ts`.

**MCP-30.** A malformed, oversized or symlinked credential store is refused and is never replaced
implicitly. Mutations are lease-serialized and durable; POSIX mode is `0600` below a `0700`
directory. Production: `packages/mcp-client/src/oauth-store.ts`. Pinned:
`packages/mcp-client/tests/integration/oauth-store.test.ts`.

**MCP-31.** Interactive OAuth is attempted only after the SDK reports `UnauthorizedError`. A
handshake challenge closes the challenged client and connects one fresh client; a post-handshake
challenge finishes once and repeats only the refused SDK operation. Catalogs, resource probes,
health pings and live tool/resource requests all cross this boundary. Production:
`packages/mcp-client/src/client.ts`;
`packages/mcp-client/src/connection.ts`;
`packages/mcp-client/src/resources.ts`;
`packages/mcp-client/src/resilient-session.ts`. Pinned end to end for initial connection,
catalog discovery, and live tool calls:
`packages/mcp-client/tests/integration/oauth-transport.test.ts`. The resource-probe and
health-ping branches share the same dispatcher in production but have no focused OAuth-challenge test.

**MCP-32.** Configured remote MCP headers are sent only to resource requests at the configured
origin. They are not placed in the SDK transport's `requestInit`, do not replace SDK-supplied
credentials, cannot cross to OAuth requests at either a different or shared origin, and are
re-evaluated on every redirect hop. Production: `packages/mcp-client/src/remote-fetch.ts`;
`packages/mcp-client/src/client.ts`. Pinned:
`packages/mcp-client/tests/unit/remote-fetch.test.ts`.

**MCP-33.** Closing the authorization coordinator while its callback listener is starting waits for
that start attempt and closes any listener that became live; later sessions fail closed. Production:
`packages/mcp-client/src/oauth.ts`. Pinned:
`packages/mcp-client/tests/integration/oauth.test.ts`.

**MCP-34.** Completing or abandoning one browser flow removes its ephemeral state so a later
challenge on the same connection starts with a fresh state and verifier. If SDK requests overlap,
the authorization URL that is actually opened remains paired with its own PKCE verifier. Production:
`packages/mcp-client/src/oauth.ts`. Pinned:
`packages/mcp-client/tests/integration/oauth.test.ts`.

**MCP-35.** Background browser authorization never retains the current run as its lifetime owner.
After the browser flow starts, initial connection or catalog discovery reports
`mcp_oauth_authorization_pending`; a late tool challenge returns `mcp_unavailable`. In all three
cases authorization continues under the coordinator deadline, a concurrent same-key run also
returns pending without opening another page, and a successfully persisted token is consumed by a
later connection. No pending outcome advances reconnect or circuit-breaker state. Production:
`createMCPClientFactory`/`attachAuthorization` in `packages/mcp-client/src/client.ts`,
`openConnection` in `packages/mcp-client/src/connection.ts`, and `invoke` in
`packages/mcp-client/src/resilient-session.ts`. Test:
`packages/mcp-client/tests/integration/oauth-transport.test.ts` and
`packages/mcp-client/tests/unit/resilient-session.test.ts`.

**MCP-36.** An initial background OAuth flow remains under both connection and physical-handshake
admission until its observed completion settles; a catalog flow remains under connection admission
through temporary-handle cleanup. A late tool/resource challenge remains coordinator-bounded but is
not represented as manager connection capacity. A later background acquire never queues behind a
saturated connection or handshake bound; it receives `mcp_background_connect_deferred` and is
inactive for that run, while a blocking caller may queue only at the handshake gate. Manager
shutdown observes retained initial/catalog completions and those registered during an in-flight
attempt only through its bounded close grace; a raw handle that resolves after abort or timeout has
its idempotent close tracked in that same grace. Production: `createPhysicalConnectGate`,
`retainPendingAdmission`, `trackHandleClose`, `openFresh`, and
`closeAllInner` in `packages/mcp-client/src/connection-manager.ts`; cleanup completion in
`packages/mcp-client/src/client.ts` and `packages/mcp-client/src/connection.ts`. Test:
`packages/mcp-client/tests/component/{connection,connection-manager,observability-pool}.test.ts`
(completion outcome, retained limits, consecutive/abort races, immediate degradation, truthful
queue diagnostics, and bounded shutdown).

**MCP-37.** A provider-local MCP tool name is preserved exactly when it is wire-safe,
case-insensitively unique, and not host-reserved. All eligible local names are reserved before any
duplicate/case-colliding, invalid, or reserved name receives a sanitized namespaced fallback, so a
fallback cannot steal a unique local name and changing entry order cannot change its owner. The
dotted `fullName` remains canonical and resolvable for every branch. Production: `makeRegistry` and
`toWireToolName` in `packages/mcp-client/src/registry.ts`. Test: the
`"preserves a unique provider-safe local name for skill/tool compatibility"`,
`"falls back to namespaced names when local names collide across servers"`,
`"reserves a unique local name before allocating colliding namespaced fallbacks"`, and reserved-name
cases in `packages/mcp-client/tests/unit/registry.test.ts`.

## 6. Failure modes and degradation

### 6.1 Error types

| Error | Code | Thrown by | Effect |
| --- | --- | --- | --- |
| `MCPConnectionFailedError` | `mcp_connection_failed` | `packages/mcp-client/src/connection.ts`, raised, | the connection is not opened; the caller decides |
| `MCPConnectionLimitError` | `mcp_connection_limit` | blocking saturation branch in `openFresh` | blocking acquire rejects; background callers receive the deferred error below |
| `MCPBackgroundConnectDeferredError` | `mcp_background_connect_deferred` | saturated background branch in `openFresh` or `createPhysicalConnectGate` | current run proceeds without that MCP; `resource` identifies `connections` or `handshakes`; no connect-timeout queue |
| `MCPStdioFrameLimitError` | `mcp_stdio_frame_too_large` | `packages/mcp-client/src/bun-stdio-client.ts`, raised | surfaces on `transport.onerror`, then `close()` |
| `MCPHttpResponseLimitError` | `mcp_http_response_too_large` | `packages/mcp-client/src/bounded-fetch.ts`, raised | the fetch throws or the body stream errors |
| `MCPResourceCatalogLimitError` | `mcp_resource_catalog_too_large` | `packages/mcp-client/src/resources.ts`, raised by `resourceCatalogLimitReached` from `paginate` | see §6.4 |
| `MCPInteractiveAuthorizationUnavailableError` | `mcp_oauth_interactive_unavailable` | `packages/mcp-client/src/oauth.ts` | the challenged connect or request rejects; a headless host never waits for a callback |
| `MCPAuthorizationFailedError` | `mcp_oauth_authorization_failed` | `packages/mcp-client/src/oauth.ts` and callback/session failure paths; `packages/mcp-client/src/remote-fetch.ts` | authorization rejects; pending state is removed and an insecure target is never fetched |
| `MCPAuthorizationPendingError` | `mcp_oauth_authorization_pending` | background branches in `packages/mcp-client/src/client.ts` | current acquisition ends without the MCP; its completion remains observed by the coordinator |
| `McpOAuthStoreError` | `mcp_oauth_store_invalid` | `packages/mcp-client/src/oauth-store.ts`, raised by validation/read/write bounds | credentials are not used or overwritten; operator repair is required |
| `MissingEnvVarsError` | — | `packages/capability/src/env-interpolate.ts` | transport construction throws; `missing_env` is logged |
| plain `Error` (tool catalog limit) | — | `catalogLimitReached` in `packages/mcp-client/src/connection.ts` | wrapped into `MCPConnectionFailedError` |
| plain `Error("connection manager closed")` | — | `packages/mcp-client/src/connection-manager.ts` | queued or later acquire rejects |
| plain `Error("Not connected")` | — | `packages/mcp-client/src/bun-stdio-client.ts` (`send()`) | the outbound write is never attempted |

### 6.2 What degrades rather than failing

| Situation | Handler | Degradation |
| --- | --- | --- |
| resource capability probe throws | `packages/mcp-client/src/connection.ts` | `warn mcp.resources.probe_failed`; connection lives, no resource tools |
| server's handshake capabilities don't advertise `resources` | `packages/mcp-client/src/resources.ts` | `loadResourceCatalog` returns `null` immediately, with **no** probe attempted and **no** log line at any level — a server that supports resources but omitted the capability flag gets zero resource tools with nothing recorded anywhere in this package |
| `resources/templates/list` throws | `packages/mcp-client/src/resources.ts` | `debug mcp.resources.templates_failed`; `resourceTemplates: []` |
| server reports no identity | `serverIdentity` in `packages/mcp-client/src/connection.ts` | the identity fields are simply absent from `mcp.connect.ok` — read defensively because `MCPClientFactory` is a substitution seam |
| a `ConnectionEvent` sink throws | `packages/mcp-client/src/resilient-session.ts` | swallowed |
| a local name is duplicated/case-colliding, invalid, or host-reserved | `makeRegistry` / `toWireToolName` in `packages/mcp-client/src/registry.ts` | the tool is offered under a sanitized namespaced fallback, suffixed when necessary; `mcp.registry.renamed` reports `reason: "invalid" | "reserved" | "collision"` |
| a server writes megabytes to stderr | `packages/mcp-client/src/server-stderr.ts` | one suppression line, rest dropped |
| an unterminated stderr line grows past 8 KiB | `packages/mcp-client/src/server-stderr.ts` | released as a line of its own |
| a stdout frame ends with a lone `\r` or is empty | `packages/mcp-client/src/bun-stdio-client.ts` | skipped, no message emitted |
| lifecycle work (stale close, reconnect, handle close) never settles | `packages/mcp-client/src/resilient-session.ts` | returns at the grace and detaches the work |
| manager teardown work never settles | `packages/mcp-client/src/connection-manager.ts` | same, via `scheduleCloseTimeout` |
| browser OAuth is pending under background policy | `MCPAuthorizationPendingError` / `authorizationPendingResult` | connection acquisition is inactive for this run, or a late call returns `mcp_unavailable`; browser/token work continues for a later run |
| background connection or physical-connect admission is saturated | `MCPBackgroundConnectDeferredError` | acquisition returns immediately; the MCP is inactive for that run, is not reported as queued, and no new physical attempt starts |

### 6.3 Retries and timeouts

There is no general tool-call retry in this package. The sole request-level repetition is for a
blocking SDK operation that first failed with `UnauthorizedError`; once the callback is exchanged,
`runMCPRequest` invokes that refused operation one more time and does not catch a second failure.
Background policy does not repeat the current run's operation; it reports unavailable while the
credential flow completes for a later connection (`attachAuthorization` in
`packages/mcp-client/src/client.ts`). Session reconnection is bounded three
ways:
single-flighted per generation (`packages/mcp-client/src/resilient-session.ts`), refused
while `transportFailStreak >= 2`, and gated behind the `reprobeCooldownMs` window once
the circuit is open. The four clocks are: `connectTimeoutMs` (handshake and health
ping), `callTimeoutMs` (per tool/resource call), `reprobeCooldownMs` (default 30 s) and
`healthPingIntervalMs` (default 30 s, disabled at `<= 0`).

OAuth also adds one narrowly-scoped connection repetition: after the SDK's first remote handshake
raises `UnauthorizedError`, Clarvis completes authorization and connects a newly constructed client
once with the saved credentials. Under background policy this fresh handle exists only to finish and
verify persistence, then closes; it is not leased back into the run that already degraded. The
human authorization clock is five minutes by default, independently capped at 30 minutes
(`packages/mcp-client/src/oauth.ts`); the outer connect
clock is paused only for initial browser/serialization waits (§4.3).

### 6.4 One prose/behaviour mismatch

`resourceCatalogLimitReached` logs "the connection is refused and none of this server's resources are
offered" (`packages/mcp-client/src/resources.ts`), but `openConnection` catches **every**
throw from the resource probe, including `MCPResourceCatalogLimitError`, and continues
(`packages/mcp-client/src/connection.ts`). Only the second half of that sentence is true on
this path. The tool-catalog twin's message — "the connection is refused and none of this server's
tools are offered" (`packages/mcp-client/src/connection.ts`) — *is* accurate, because that throw is rethrown as
`MCPConnectionFailedError`. Unit tests cover resource-catalog bounds, but no test covers
an `MCPResourceCatalogLimitError` flowing through `openConnection`.

### 6.5 Diagnostic vocabulary emitted by this package

| Event | Level | Site |
| --- | --- | --- |
| `mcp.connect.begin` | debug | `packages/mcp-client/src/connection.ts` |
| `mcp.connect.ok` | info | `packages/mcp-client/src/connection.ts` |
| `mcp.connect.failed` | warn | `packages/mcp-client/src/connection.ts` |
| `mcp.connect.quarantined` | warn | `packages/mcp-client/src/connection-manager.ts` |
| `mcp.tools.listed` | info | `packages/mcp-client/src/connection.ts` |
| `mcp.catalog.limit` | warn | `packages/mcp-client/src/connection.ts`, `packages/mcp-client/src/resources.ts` |
| `mcp.resources.probe_failed` | warn | `packages/mcp-client/src/connection.ts` |
| `mcp.resources.templates_failed` | debug | `packages/mcp-client/src/resources.ts` |
| `mcp.reconnect.begin` / `.ok` / `.failed` | debug / info / warn | `packages/mcp-client/src/resilient-session.ts` |
| `mcp.unavailable` | warn | `packages/mcp-client/src/resilient-session.ts` |
| `mcp.recovered` | info | `packages/mcp-client/src/resilient-session.ts` |
| `mcp.health.ping_failed` | debug | `packages/mcp-client/src/resilient-session.ts` |
| `mcp.timeout_streak` | warn | `packages/mcp-client/src/resilient-session.ts` |
| `mcp.call.done` | debug (sampled) | `packages/mcp-client/src/resilient-session.ts` |
| `mcp.registry.renamed` | warn | `makeRegistry` in `packages/mcp-client/src/registry.ts` |
| `mcp.pool.connect_queued` | debug (sampled) | `packages/mcp-client/src/connection-manager.ts` |
| `mcp.pool.relay_dropped` | warn | `packages/mcp-client/src/connection-manager.ts` |
| `mcp.pool.limit` | warn | `packages/mcp-client/src/connection-manager.ts` |
| `mcp.pool.evicted` | debug | `packages/mcp-client/src/connection-manager.ts` |
| `mcp.transport.frame_limit` | error | `packages/mcp-client/src/bun-stdio-client.ts` |
| `mcp.transport.response_limit` | error | `packages/mcp-client/src/bounded-fetch.ts` |

`mcp.call.done`'s `outcome` field is the `McpCallOutcome` union — `"ok" | "timeout" | "protocol" |
"transport" | "aborted" | "unavailable"` (`packages/mcp-client/src/resilient-session.ts`) — set by the branch of `invoke` that produced the
result; see the outcome column in §4.6.

`mcp.pool.evicted`'s `reason` field (`reportEvicted`, `packages/mcp-client/src/connection-manager.ts`) is the closed
set `"ttl" | "max_idle" | "unhealthy" | "abandoned"`:

| `reason` | Triggering mechanism |
| --- | --- |
| `"ttl"` | `armIdle`'s idle timer fires after `idleTtlMs` with the slot still at refcount 0 |
| `"max_idle"` | `armIdle` evicts the globally-oldest idle slots once more than `maxIdleConnections` remain at refcount 0 |
| `"unhealthy"` | `acquire` finds a refcount-0 slot whose connection is no longer `connected` and discards it before reuse |
| `"abandoned"` | a brand-new slot's `connPromise` settles after every waiter already released it (refcount back to 0) |

`ReconnectTrigger` is a distinct field from `reason` on purpose: "Carried as `trigger` on the three
`mcp.reconnect.*` records, which keeps `reason` free to mean what it means everywhere else in this
package: the sanitized text of the failure being reported"
(`packages/mcp-client/src/resilient-session.ts`).

That sanitized `reason` text comes from `resilient-session.ts`'s own local `errorText`,
which runs every logged message through `sanitizeErrorMessage`. Two other, differently-scoped
functions share the exact name `errorText` but are **not** sanitized: `packages/mcp-client/src/tool-results.ts`
(`String(err)` / `err.message`, feeding `runtimeErrorResult`, `interruptedResult` and
`becameUnavailableResult`, `packages/mcp-client/src/tool-results.ts`) and `packages/mcp-client/src/connection.ts` (same shape, used only
to build the message of a thrown `MCPConnectionFailedError`, never for a log
call). The consequence: a `ToolResult` error message that reaches the model is **not** passed through
`sanitizeErrorMessage`, unlike every logged `reason` this document describes elsewhere.

## 7. Coupling

### 7.1 Outgoing (what this package depends on)

| Dependency | Kind | Forced by |
| --- | --- | --- |
| `@clarvis/capability` | runtime value + type | `NOOP_LOGGER`, `bind`, `resolveStringMap` at `packages/mcp-client/src/client.ts`; `MissingEnvVarsError`, `bestEffort`, `detachObserved`, `levelEnabled`, `sanitizeErrorMessage`, `unref` at `packages/mcp-client/src/connection.ts`; `createSampler` at `packages/mcp-client/src/resilient-session.ts` |
| `@clarvis/paths` | runtime value | `ownerSegment` at `packages/mcp-client/src/connection-manager.ts`; `executableOnPath` at `packages/mcp-client/src/bun-stdio-client.ts`; local lease, durable write and private modes at `packages/mcp-client/src/oauth-store.ts` |
| `@modelcontextprotocol/sdk` | runtime value + type | `Client`, `UnauthorizedError` and transports at `packages/mcp-client/src/client.ts`; OAuth provider/credential schemas at `packages/mcp-client/src/oauth.ts` and `packages/mcp-client/src/oauth-store.ts`; protocol errors and JSON-RPC schema in their focused modules |

The type contracts it implements structurally, all owned by `@clarvis/capability`: `MCPConnection`
(`packages/capability/src/run.ts`) built at `packages/mcp-client/src/connection.ts`; `ToolResult`
(`packages/capability/src/run.ts`) produced throughout `tool-results.ts`; `NamespacedRegistry`
(`NamespacedRegistry` in `packages/capability/src/run.ts`) built by `makeRegistry` in
`packages/mcp-client/src/registry.ts`; `McpServerConfig`
(`packages/capability/src/api.ts`) consumed by `createMCPClientFactory` and `buildTransport` in
`packages/mcp-client/src/client.ts`; `Logger`
(`packages/capability/src/log.ts`) as the single diagnostic channel. This package has **no
`zod`** dependency (`packages/mcp-client/package.json`) — the only schema work it performs is
through the SDK's own schemas.

### 7.2 Incoming (what depends on this package)

| Consumer | Kind | Evidence |
| --- | --- | --- |
| `@clarvis/loop` | production dependency | `packages/loop/package.json`; connection/registry consumers plus OAuth coordinator and connection-manager construction at `packages/loop/src/runtime/build-run-deps.ts` |
| `@clarvis/kernel` | production dependency | `packages/kernel/package.json`; `createHostRemoteMcpBridge` and `createGuestMcpConnections` in `packages/kernel/src/runtime/remote-mcp.ts` consume connection/lease/elicitation ports and native acquisition errors |

Container placement keeps HTTP/SSE transports and their environment/OAuth authorization on the host.
The kernel pins the admitted server snapshot and owner, exposes run-owned tool/resource leases, and
reconstructs native pending/deferred/failure types in the guest. Remote elicitation returns to the
guest's existing serialized relay; stdio remains guest-local. The kernel owns the closed RPC schema
and teardown, specified by [isolated-agent-runtime](../hosts/isolated-agent-runtime.md).
Production: `createHostRemoteMcpBridge` and `createGuestMcpConnections` in
[`remote-mcp.ts`](../../packages/kernel/src/runtime/remote-mcp.ts).
Test: `runtime remote MCP ownership` in
[`runtime-remote-mcp.test.ts`](../../packages/kernel/tests/unit/runtime-remote-mcp.test.ts), and
HTTP/SSE bearer/header/saved-OAuth plus remote elicitation cases in
[`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts).

The one-directional edge is enforced structurally rather than by a test *in this package*: `reserved`
is a required parameter of `buildRegistry` (`packages/mcp-client/src/registry.ts`,
`buildRegistry`), and the
engine binds its own vocabulary in its own module — `buildRegistryWith(entries, [...RESERVED_WIRE_NAMES, ...capabilityReserved])`
(`packages/loop/src/runtime/tools/mcp-registry.ts`). That file's comment records the reason: "The
MCP client takes the reserved set as an argument because it does not know the host's tool vocabulary
— that is what removed its one import of `runtime/`" (`packages/loop/src/runtime/tools/mcp-registry.ts`).
The half that proves the engine hands over the *right* set lives in the loop's own suite
(`packages/loop/tests/unit/mcp-registry-reservation.test.ts`) — delegated to
[loop-tool-dispatch-and-results](../engine/tool-dispatch.md).

### 7.3 Build and test configuration

The package extends the root `tsconfig.base.json` with `noEmit` for the typecheck project,
`resolveJsonModule: true` (needed by `packages/mcp-client/src/version.ts`), and source-level `paths` for its two workspace
dependencies (`packages/mcp-client/tsconfig.json`); `include` covers `src/**/*.ts` **and**
`tests/**/*.ts`. Its test script carries `--timeout 60000`
(`packages/mcp-client/package.json`). Its coverage floors are `functions: 0.90, lines: 0.98`
(`tooling/checks/coverage.ts`) — tied with `memory` and `server` for the lowest function floor in
that table (`tooling/checks/coverage.ts`), while its line floor of 0.98 is among the
highest.

## 8. Open questions

**Behavioural gaps and unpinned rules**

- ~~`MAX_MCP_CLOSE_GRACE_MS = 30_000` (`packages/mcp-client/src/resilient-session.ts`) is applied by
  `normalizeMcpCloseGraceMs` but **no test passes a value above it**; only the non-finite fallback is covered
  (`packages/mcp-client/tests/unit/resilient-session.test.ts`). The upper clamp is unpinned.~~
  **Resolved.** The exported `normalizeMcpCloseGraceMs` is now tested directly rather than
  only through a session, which reaches every branch — clamp, boundary, floor, truncation, fallback —
  without constructing a shutdown for each.
- ~~`interpretCallResult` dereferences its argument without a null guard.~~ **Resolved.**
  It now maps `null`/`undefined` to an operational `mcp_runtime_error` before reading `isError`
  (`packages/mcp-client/src/tool-results.ts`). Direct tests cover both nullish values and the
  absence of `outcome: "unknown"`; a resilient-session test proves the malformed response does not
  fault or reconnect the transport (`packages/mcp-client/tests/unit/tool-results.test.ts` and
  `packages/mcp-client/tests/unit/resilient-session.test.ts`).
- `mcp.tools.listed` always reports `truncated: false` (`packages/mcp-client/src/connection.ts`);
  the field is a constant, since every truncation path throws instead. Whether it is a placeholder
  for a future non-fatal truncation, or dead, is not determinable.
- `MCPConnection.listResources`/`readResource` remain optional on the cross-host contract
  (`packages/capability/src/run.ts`), while this implementation defines both on every opened
  connection (`packages/mcp-client/src/connection.ts`). Resource availability is represented
  by the synthesized `resource_list`/`resource_read` descriptors: the loop dispatches those kinds
  only after resolving a descriptor from the registry
  (`packages/loop/src/runtime/tools/mcp-dispatch.ts`). With discovery disabled, absent, or
  failed, `listResources` returns the empty captured catalog and `readResource` remains callable only
  to a direct programmatic holder of the connection.
- `MCPClientHandle.protocolVersion` is captured by replacing `transport.setProtocolVersion`
  (`packages/mcp-client/src/client.ts`). Whether the SDK guarantees that method is called exactly once, or at all,
  for every transport is outside this repository.

**Uncorroborated prose**

- Several doc comments narrate a prior defect (`packages/mcp-client/src/client.ts` on `defaultCwd`,
  `packages/mcp-client/src/server-stderr.ts` on stderr reaching the host terminal,
  `packages/mcp-client/src/bun-stdio-client.ts` on Windows `npx` shims, and
  `packages/mcp-client/src/connection-manager.ts` on the dropped relay). The *current*
  mechanism is verified in each case; the historical claims are not checkable from the code and are
  quoted, never asserted.
- The reason for `poolSharing`'s default being `owner` is stated as a security posture in the comment
  (`packages/mcp-client/src/connection-manager.ts`) referring to owner-isolation modes outside
  this package. Those modes live outside this package and are not verified here.

**Delegated to sibling documents**

- *When* the loop decides to open a pool, acquire leases, dispatch an MCP tool call, and what it does
  with a `ToolResult` (including `outcome: "unknown"`), plus the concrete `RESERVED_WIRE_NAMES` list
  — [loop-tool-dispatch-and-results](../engine/tool-dispatch.md).
- The user-facing side of elicitation: who implements `ElicitationRelay.handle`, how a prompt reaches
  a human, and the timeout around it — [elicitation-and-user-interaction](../cross-cutting/elicitation.md).
- How `McpServerConfig` values (including `shared`, `resources`, `env`, `headers`) are assembled from
  `settings.json` and plugin manifests, and who chooses `poolSharing` — [kernel-config-and-agents](../hosts/kernel-config.md).

**Not investigated**

- ~~Whether any test outside `packages/mcp-client` pins the absence of a `@clarvis/loop` import
  from this package.~~ **Corrected.** One does, and this entry recorded its absence
  wrongly: `packages/loop/tests/architecture/optional-package-boundary.test.ts` builds its package
  set from the engine's own manifest rather than a hand-written list, so `@clarvis/mcp-client` — a
  plain `dependencies` entry at `packages/loop/package.json` — is in scope
  (`enginePackageDependencies`). It then scans that package's `src` **and** `tests` trees
  (`SCANNED_TREES`) for any static, side-effect or dynamic `@clarvis/loop` specifier and
  requires the offender list to be empty, with a companion case asserting files were
  actually read, so an empty result means something.
- Runtime behaviour on Windows: `mcpSpawnArgv`'s cmd-routing branch is only partially exercised on a
  non-Windows host, and the test itself branches on whether a real `npx.cmd` resolved
  (`packages/mcp-client/tests/unit/mcp-spawn-argv.test.ts`).
