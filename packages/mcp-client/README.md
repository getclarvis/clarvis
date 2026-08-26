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
| `buildRegistry`, `selectTools`, `poolToolNames` | the namespaced tool registry                                                    |
| `interpolateEnv`                                | `${VAR}` expansion in a server's `env` and `headers`                            |
| `CLIENT_NAME`, `VERSION`                        | MCP handshake identity using the root Clarvis product version                   |

It depends on `@clarvis/capability` (the `MCPConnection` / `NamespacedRegistry`
vocabulary and the `Logger` port), `@clarvis/paths` (`ownerSegment`,
`executableOnPath`) and `@modelcontextprotocol/sdk`.

## It does not know the engine

`@clarvis/loop` depends on this package, never the reverse. The one edge that
used to point the wrong way was `buildRegistry` importing the engine's built-in
wire names to keep an MCP tool from shadowing `submit_result` or `read_file`.
Those names are now a **required argument**: required rather than defaulted,
because a host that forgot them would silently reintroduce the shadowing the
parameter exists to prevent, and nothing would report it.

Tool _dispatch_ — routing a model's call to a connection, with guards, trace and
the result envelope — stays in the engine. This package knows how to talk to a
server; the engine knows when to.

Cancellation is classified at the transport boundary. A signal already aborted
before invocation is a definite local cancellation. Once the SDK call has been
invoked, cancellation, timeout or loss of availability carries
`outcome: "unknown"`: a mutating consumer must reconcile before choosing a new
idempotency key.

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
handshakes and eight zero-reference warm shared transports by default. These
are package-level safety defaults and remain overridable through the factory,
connection and manager option seams.

Manager and resilient-session shutdown never wait forever for a custom factory,
reconnect or handle `close()`. Manager teardown gets one 2-second window and each
session lifecycle operation gets the same default; `closeGraceMs` can tune either,
but is hard-capped at 30 seconds. After that window a late promise remains observed,
and any handle that eventually opens is still closed. Manager shutdown also aborts
all owned handshakes and clears pool/capacity references before waiting on its grace.

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

| Level | `event` | Fields |
| ----- | ------- | ------ |
| debug | `mcp.connect.begin` | `connect_timeout_ms`, `attempt` |
| info | `mcp.connect.ok` | `duration_ms`, `attempt`, `server_name`, `server_version`, `protocol_version` |
| warn | `mcp.connect.failed` | `duration_ms`, `attempt`, `reason`, `missing_env` |
| warn | `mcp.connect.quarantined` | `mcp`, `transport` |
| info | `mcp.tools.listed` | `count`, `bytes`, `pages`, `truncated`, `names` (debug only) |
| warn | `mcp.catalog.limit` | `kind` (`entries`/`bytes`/`pages`), `limit`, `observed` |
| warn | `mcp.resources.probe_failed` | `reason` |
| debug | `mcp.resources.templates_failed` | `reason` |
| debug | `mcp.reconnect.begin` | `generation`, `trigger` |
| info | `mcp.reconnect.ok` | `generation`, `duration_ms`, `trigger` |
| warn | `mcp.reconnect.failed` | `generation`, `duration_ms`, `trigger`, `reason` |
| warn | `mcp.unavailable` | `cause`, `cooldown_ms` |
| info | `mcp.recovered` | — |
| warn | `mcp.timeout_streak` | `streak`, `threshold`, `call_timeout_ms` |
| debug | `mcp.health.ping_failed` | `reason` |
| debug | `mcp.call.done` | `label`, `duration_ms`, `outcome` |
| error | `mcp.transport.frame_limit` | `limit`, `observed` |
| error | `mcp.transport.response_limit` | `mcp`, `kind` (`response`/`sse_event`), `limit` |
| debug | `mcp.pool.evicted` | `mcp`, `key_hash`, `idle_ms`, `reason` |
| warn | `mcp.pool.limit` | `mcp`, `limit`, `admitted` |
| warn | `mcp.pool.relay_dropped` | `mcp` |
| debug | `mcp.pool.connect_queued` | `mcp`, `active`, `max_parallel` |
| warn | `mcp.registry.renamed` | `mcp`, `tool`, `full_name`, `wire_name`, `reason` |

`reason` is a sanitized failure message everywhere except the reconnect trio,
where the failure is `reason` and *why the reconnect started* is `trigger`.

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
  plus one narrow MCP SDK elicitation compatibility canary and the real Clarvis
  relay round-trip;
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
