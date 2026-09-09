# @clarvis/mcp-client

Clarvis's MCP transport layer.

## Contract

Transports, resilient sessions, pooling, and the namespaced registry are specified in
[`foundations/mcp-client.md`](../../specs/foundations/mcp-client.md). Engine-owned MCP dispatch is
specified in [`engine/tool-dispatch.md`](../../specs/engine/tool-dispatch.md).

|                                                 |                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `createMCPClientFactory`, `buildTransport`      | client and transport construction (stdio, SSE, Streamable HTTP)                 |
| `BunStdioClientTransport`                       | a stdio transport written for Bun                                               |
| `openConnection`                                | one self-healing connection: reconnect, health ping, consecutive-timeout streak |
| `createConnectionManager`                       | the pool over connections, with idle TTL and owner scoping                      |
| `buildRegistry`, `selectTools`, `poolToolNames` | collision-safe tool registry with dotted canonical identities                   |
| `interpolateEnv`                                | `${VAR}` expansion in a server's `env` and `headers` when enabled               |
| `createMCPAuthorizationCoordinator`             | browser OAuth, loopback callback, PKCE and per-resource serialization           |
| `createMcpOAuthCredentialStore`                 | bounded, private persistence for registrations and tokens                       |
| `MCPAuthorizationWait`, pending/deferred errors | blocking/embedder and non-blocking run authorization/admission policy           |
| `CLIENT_NAME`, `VERSION`                        | MCP handshake identity using the root Clarvis product version                   |

It depends on `@clarvis/capability` (the `MCPConnection` / `NamespacedRegistry`
vocabulary and the `Logger` port), `@clarvis/paths` (`ownerSegment`,
`executableOnPath`) and `@modelcontextprotocol/sdk`.

`McpServerConfig.cwd` selects an explicit stdio working directory; otherwise the factory's
workspace-rooted default applies. `expandVariables` defaults to true. A portable Agent Plugin
adapter sets it false after expanding only its format-owned `PLUGIN_ROOT`/`PLUGIN_DATA` placeholders,
so this transport preserves every remaining authored env/header placeholder literally instead of
applying a second, broader Clarvis interpolation pass. `bearer_token_env_var` and
`env_http_headers` are intentionally exempt: they explicitly name credentials and always resolve
from the environment rather than sending `${VAR}` literally. The pool key includes the flag. It
deliberately excludes `auto_tools`: that flag changes the loop's run-level admission after discovery,
not the physical server, transport, or catalog that this package pools.

For stdio, `env_vars` forwards only named host variables in addition to the explicit `env` map. For
remote transports, `bearer_token_env_var` and `env_http_headers` resolve credentials at connection
time without persisting their values. `startup_timeout_ms` and `tool_timeout_ms` override the pool
defaults per server; `enabled_tools` is applied first and `disabled_tools` afterward. The bounded
`instructions` returned by `initialize` is retained on the opened connection for the engine to
place beside the server's tools.

## It does not know the engine

`@clarvis/kernel` also consumes this package for its isolated-runtime bridge. HTTP/SSE leases,
environment-backed authentication and saved OAuth remain on the host, while the guest receives
catalogs/results and retains native pending/deferred failure and elicitation semantics. Stdio
connections, including MCP hooks, stay inside the guest. The closed operation and lifetime contract
belongs to [`isolated-agent-runtime.md`](../../specs/hosts/isolated-agent-runtime.md); this package
does not depend on the kernel or implement its RPC protocol.

`@clarvis/loop` depends on this package, never the reverse. The one edge that
used to point the wrong way was `buildRegistry` importing the engine's built-in
wire names to keep an MCP tool from shadowing `submit_result` or `read_file`.
Those names are now a **required argument**: required rather than defaulted,
because a host that forgot them would silently reintroduce the shadowing the
parameter exists to prevent, and nothing would report it.

The registry assigns model-facing names in two passes. It first counts provider-local tool names
case-insensitively and reserves every local name that uses only `[A-Za-z0-9_-]`, occurs exactly
once, and is not reserved by the host. Those tools keep their exact local name, which lets a skill
call a provider by the spelling that provider documents. Duplicate, case-colliding, invalid, or
host-reserved local names instead use a sanitized `mcpName.toolName` fallback, suffixed when needed.
Reserving all eligible local names before allocating any fallback makes the result independent of
connection order. The dotted `fullName` remains the canonical identity and remains resolvable even
when the model sees a local or sanitized fallback. Every fallback emits `mcp.registry.renamed` with
`reason: "invalid" | "reserved" | "collision"` through the supplied logger.

Tool _dispatch_ — routing a model's call to a connection, with guards, trace and
the result envelope — stays in the engine. This package knows how to talk to a
server; the engine knows when to.

Cancellation is classified at the transport boundary. A signal already aborted
before invocation is a definite local cancellation. Once the SDK call has been
invoked, cancellation, timeout or loss of availability carries
`outcome: "unknown"`: a mutating consumer must reconcile before choosing a new
idempotency key.

## Remote OAuth

HTTP and SSE transports use the SDK's protected-resource discovery, CIMD when an HTTPS
`client_metadata_url` is configured, dynamic client registration when available, PKCE, token
exchange and refresh flow when a server requires OAuth. A configured `client_id` takes precedence
over both registration methods. One coordinator owns a
loopback-only callback listener and serializes authorization by the hash of `(workspace, owner,
canonical resource URL)`, so overlapping runs do not race one credential record. The host supplies
the browser opener; an intentionally headless host omits it and receives
`MCPInteractiveAuthorizationUnavailableError` instead of waiting indefinitely.

Every OAuth discovery, registration, token, browser, and redirect destination must use HTTPS,
except for HTTP on a loopback host. Headers configured for the MCP resource are attached only to
resource requests on that origin; OAuth exchanges do not inherit them, even when both services share
an origin, and an SDK-defined authorization header always wins. Callback routes are the configured
path or that path plus the stable server-specific callback id. The listener validates both route
and 256-bit state, validates `iss` whenever supplied and requires the matching issuer when the
authorization server advertises issuer-bound responses, bounds callback fields, and never renders a
code or state into its response. A portless `http://127.0.0.1/...` callback receives the active
listener port; other loopback names need an explicit matching port. HTTPS callback URLs are allowed
for a configured ingress/proxy, while plaintext non-loopback callbacks are refused.

Callback selection follows the interoperable matrix: dynamic registration with issuer support may
reuse the configured callback; without issuer support it appends the callback id. A pre-registered
client reuses an issuer-bound callback or an already id-suffixed callback, otherwise it falls back
to the global/default loopback callback with the id appended. The configured callback itself is not
rewritten. Clarvis does not depend on a vendor-hosted CIMD document: a plugin or host that needs CIMD
must supply its public `client_metadata_url`.

An authorization challenge may arrive during the handshake, catalog discovery, a tool/resource
request, or a health probe. Clarvis completes the SDK-started browser flow and repeats only the
refused request once; a later challenge receives a fresh state and verifier. The default
`authorizationWait: "blocking"` contract retains that behavior for explicit embedder operations.
Run acquisition uses `"background"`: once the browser flow starts, that acquisition rejects with
`MCPAuthorizationPendingError`, the MCP is inactive for that run, and authorization continues
without the run's abort signal. An initial-connect challenge retains both the live-connection slot
and physical-handshake permit until its completion settles; a catalog challenge retains its
connection slot through temporary-handle cleanup and preserves the completion's success or failure.
A second run arriving behind the same pending initial flow, or behind either saturated background
admission bound, degrades immediately instead of waiting on the serialized credential key or connect
timeout. If the user completes the browser
flow, the durable token is available to a later run without opening a second page. A late challenge
during a tool call similarly maps to `mcp_unavailable` without reconnecting or opening the circuit;
that later flow is coordinator-bounded, not retained as manager connection capacity.

The outer connection budget pauses while blocking initial authorization or another flow for the
same resource is pending, but cancellation and the five-minute human-authorization deadline remain
live. Coordinator shutdown also waits for an in-progress callback-listener startup before closing
it. Background authorization remains bounded by the same human deadline and by coordinator
shutdown; it is detached only from the run that must remain responsive.

`createMcpOAuthCredentialStore` persists SDK-validated client registrations and tokens in a
versioned JSON document. The default file is `state/mcp-oauth.json` under the global Clarvis root;
records are isolated by the same workspace/owner/resource hash, capped by count and bytes, written
durably under a process-shared lease, and created as `0600` below a `0700` directory on POSIX. A
malformed, oversized or symlinked store is refused and never replaced implicitly. Authorization
URLs, state, codes, verifiers, tokens and client secrets do not enter logs.

## Resource bounds

The Bun stdio transport retains at most one 16 MiB newline-delimited frame and
copies only the unfinished tail of a stream chunk. Ordinary HTTP response
bodies are capped at 16 MiB, while a long-lived SSE stream caps each
unterminated event at 4 MiB before the SDK's JSON parser can materialize it. A limit failure starts transport cancellation
without waiting for a broken cancel algorithm. Shutdown is awaited: stdin
gets a graceful window, then the child is escalated through `SIGTERM` and
`SIGKILL`, and `close()` does not resolve before the process and its readers do.
Forwarded child stderr observes the parent writable's `drain` signal, so a noisy
server cannot move unbounded output from its pipe into Node/Bun's writable queue.

Discovery is bounded before catalogs are retained. Tool discovery allows 2,048
descriptors / 8 MiB and resource plus template discovery allows 5,000 entries /
4 MiB; either catalog refuses a cursor chain beyond 50 pages. The connection
manager admits at most 32 live-or-connecting transports, four simultaneous
handshakes/initial background authorization completions and eight zero-reference warm shared
transports by default. Blocking callers queue behind the handshake gate. A background caller that
reaches either the connection or handshake bound receives `MCPBackgroundConnectDeferredError`, is
never logged as queued, and leaves that MCP inactive for the run. These
are package-level safety defaults and remain overridable through the factory,
connection and manager option seams.

Manager and resilient-session shutdown never wait forever for a custom factory,
reconnect or handle `close()`. Manager teardown gets one 2-second window and each
session lifecycle operation gets the same default; `closeGraceMs` can tune either,
but is hard-capped at 30 seconds. After that window a late promise remains observed,
and any handle that eventually opens is still closed. When a factory resolves during that window
after abort or timeout, an idempotent close shim keeps the late handle's `close()` in the same
manager grace rather than letting teardown finish at factory resolution. Mutable handles preserve
their identity; a read-only fallback wrapper inherits the late-OAuth request boundary. Manager shutdown also aborts all
owned handshakes and clears pool/capacity references before waiting on its grace.

## What it logs

Every record is written through the `Logger` port and nothing else. **This
package must never write to stdout**: an MCP stdio child's stdout is its
JSON-RPC frame channel, and Clarvis's own kernel wire is `process.stdout`.

Three lifetimes live here and only two of them may be bound. The manager is one
per workspace and outlives every run; a connection is per
`(server, owner|workspace)` pool key, survives the idle TTL and serves many
runs. **No record in this package may carry a `run_id`** — a pooled
connection's line would be attributed to whichever run happened to open it.
The join key is `connection_id`, and run correlation is the loop's job at
dispatch. `openConnection` binds `{ workspace, owner, mcp, transport }` and the
session adds `connection_id`, so the events below list only what they add.

| Level | `event`                          | Fields                                                                        |
| ----- | -------------------------------- | ----------------------------------------------------------------------------- |
| debug | `mcp.connect.begin`              | `connect_timeout_ms`, `attempt`                                               |
| info  | `mcp.connect.ok`                 | `duration_ms`, `attempt`, `server_name`, `server_version`, `protocol_version` |
| warn  | `mcp.connect.failed`             | `duration_ms`, `attempt`, `reason`, `missing_env`                             |
| warn  | `mcp.connect.quarantined`        | `mcp`, `transport`                                                            |
| info  | `mcp.tools.listed`               | `count`, `bytes`, `pages`, `truncated`, `names` (debug only)                  |
| warn  | `mcp.catalog.limit`              | `kind` (`entries`/`bytes`/`pages`), `limit`, `observed`                       |
| warn  | `mcp.resources.probe_failed`     | `reason`                                                                      |
| debug | `mcp.resources.templates_failed` | `reason`                                                                      |
| debug | `mcp.reconnect.begin`            | `generation`, `trigger`                                                       |
| info  | `mcp.reconnect.ok`               | `generation`, `duration_ms`, `trigger`                                        |
| warn  | `mcp.reconnect.failed`           | `generation`, `duration_ms`, `trigger`, `reason`                              |
| warn  | `mcp.unavailable`                | `cause`, `cooldown_ms`                                                        |
| info  | `mcp.recovered`                  | —                                                                             |
| warn  | `mcp.timeout_streak`             | `streak`, `threshold`, `call_timeout_ms`                                      |
| debug | `mcp.health.ping_failed`         | `reason`                                                                      |
| debug | `mcp.call.done`                  | `label`, `duration_ms`, `outcome`                                             |
| error | `mcp.transport.frame_limit`      | `limit`, `observed`                                                           |
| error | `mcp.transport.response_limit`   | `mcp`, `kind` (`response`/`sse_event`), `limit`                               |
| debug | `mcp.pool.evicted`               | `mcp`, `key_hash`, `idle_ms`, `reason`                                        |
| warn  | `mcp.pool.limit`                 | `mcp`, `limit`, `admitted`                                                    |
| warn  | `mcp.pool.relay_dropped`         | `mcp`                                                                         |
| debug | `mcp.pool.connect_queued`        | `mcp`, `active`, `max_parallel`                                               |
| warn  | `mcp.registry.renamed`           | `mcp`, `tool`, `full_name`, `wire_name`, `reason`                             |

`reason` is a sanitized failure message everywhere except the reconnect trio,
where the failure is `reason` and _why the reconnect started_ is `trigger`.

Two rules bound the cost, because the bindings object is built at the call site
before any backend sees the level. `mcp.call.done` and `mcp.pool.connect_queued`
are the two per-call sites: each is guarded by `levelEnabled(logger, "debug")`
captured once and then sampled, so a silent host allocates nothing for them.
Per-frame and per-HTTP-chunk paths get no record at all — the frame and response
limits are reported once, when the bound is crossed.

Two values are never logged: a pool key (it embeds resolved `env` and `headers`,
so only a `key_hash` digest is written) and a resolved `${VAR}` value
(`missing_env` carries variable **names** only). An MCP server's own stderr is
not this package's to route either — it reaches the host through
`MCPClientFactoryOptions.onServerStderr`, which logs it under
`mcp.server.stderr` with the text in `server_output`, never in a field named
`stderr`.

## Test ownership

The suite is classified by the boundary each test exercises:

- `tests/unit/` is the exclusive owner of resilient-session state
  (reconnect/streak/cooldown/abort/health/close), resource policy
  (pagination/naming/truncation/binary/image/empty), error/result mapping,
  registry and pure transport argument/environment/decoder behavior. Time is
  injected there; no unit case waits on the wall clock;
- `tests/component/` owns only composition: `openConnection` wiring and
  representative tool/resource calls, the pool's refcount/owner/workspace/
  concurrency contract, and transport construction with external effects
  replaced. Session and resource-policy matrices are not repeated here;
- `tests/integration/` owns real stdio subprocess and loopback HTTP behavior,
  the complete OAuth discovery/registration/PKCE/callback/token/reconnect path,
  background initial/catalog/tool-call authorization and concurrent-run degradation,
  private credential-store filesystem behavior, one narrow MCP SDK elicitation
  compatibility canary and the real Clarvis relay round-trip;
- `tests/architecture/` owns the package's public-versus-internal export
  boundary;
- `tests/helpers/` and `tests/fixtures/` contain shared runner support and real
  integration fixtures, never test cases of their own.

Use `bun --filter @clarvis/mcp-client test` for the complete package suite, or
the package's `test:unit`, `test:component`, `test:integration` and
`test:architecture` scripts for one level. Real stdio and HTTP integrations
require process and loopback-socket permissions; an environment that denies
those effects must report that limitation rather than treating the tests as
passing or broadly skipping them.
