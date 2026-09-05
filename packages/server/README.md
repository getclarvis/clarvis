# `@clarvis/server`

MCP-over-Streamable-HTTP facade that exposes the Clarvis loop as infrastructure for other
applications — a medical-records product, a support automation, an internal microservice.

> Private, unversioned workspace. The root manifest owns the Clarvis product version; APIs and
> on-disk formats may change during the beta period.

## Contract

HTTP authentication, bind policy, owner resolution, and token verification are specified in
[`hosts/server-auth.md`](../../specs/hosts/server-auth.md). The four MCP tools, run hosting,
notifications, and session-scoped control are specified in
[`hosts/server-mcp.md`](../../specs/hosts/server-mcp.md).

One container per deployment, holding its own `.clarvis/` configuration exactly as the `clarvis`
TUI reads it. **Clients supply no configuration and no credentials**: they consume the models and MCP
servers the container was set up with. An agent authored and debugged locally in `code` runs here
unchanged — the config directory is the deliverable.

ChatGPT/Grok subscription authentication is explicitly unavailable through this remote facade in
the current phase. The server starts no device flow, stores no subscription token, exposes no OAuth
callback, and does not alias its inbound MCP OAuth to model-provider OAuth. Remote enablement needs a
separate operator identity, TLS, credential-storage, and consent design; see
[`subscription-providers.md`](../../specs/hosts/subscription-providers.md).

The five agents Clarvis ships (`marshall`, `admiral`, `coder`, `explorer`, `planner`) are data inside
`@clarvis/kernel`, so a container whose `.clarvis/agents/` is empty still serves all of them, and a
`clarvis_run` naming no agent enters `marshall`. What the config directory must supply is providers,
a default model and credentials — not a fleet.

```
   client application (MCP over HTTP)
              │  run / steer / cancel / respond
              ▼
   @clarvis/server   MCP facade + owner resolution
   @clarvis/kernel   createFileKernel + owner-scoped file stores
   @clarvis/loop     the engine
```

Dependencies: `@clarvis/kernel` + `@clarvis/protocol` as the execution boundary,
`@clarvis/paths` for CLI/auth root resolution, and `@clarvis/capability` for the canonical environment
boolean parser. The kernel supplies the explicit per-owner file-store factory; the server still
chooses multi-owner composition but does not reach into loop, memory or plan. Externally,
`@modelcontextprotocol/sdk`, `jose` (the Ed25519 JWTs) and `zod`.

Within the kernel dependency, the server uses `@clarvis/kernel/bootstrap` for file-backed startup,
`@clarvis/kernel/config` for model parsing, `@clarvis/kernel/policy` for event policy, and the root
only for central kernel types/services. Its boundary test derives the exact Capability, Kernel,
Paths, and Protocol package allowlist from the repository's central role policy and separately pins
the owned Kernel entrypoints.

## Running

```bash
clarvis-server --workspace /workspace --config /config --port 8080
```

`clarvis-server --version` reports the product version from the root manifest, the same source used
by the terminal CLI, Loop export, MCP client identity, and this server's MCP initialization identity.

| Flag                  | Env                                | Default            |
| --------------------- | ---------------------------------- | ------------------ |
| `--workspace <path>`  | `CLARVIS_WORKSPACE_ROOT`           | cwd                |
| `--config <path>`     | `CLARVIS_HOME`                     | `~/.clarvis`       |
| `--host <addr>`       | `CLARVIS_SERVER_HOST`              | `127.0.0.1`        |
| `--port <n>`          | `PORT`, `CLARVIS_SERVER_PORT`      | `8080`             |
| `--path <p>`          | `CLARVIS_SERVER_PATH`              | `/mcp`             |
| `--owner-mode <m>`    | `CLARVIS_SERVER_OWNER_MODE`        | `fixed`            |
| `--auth <m>`          | `CLARVIS_SERVER_AUTH`              | `off`              |
| `--auth-file <path>`  | `CLARVIS_SERVER_AUTH_FILE`         | `<home>/auth.json` |
| `--public-url <url>`  | `CLARVIS_SERVER_PUBLIC_URL`        | —                  |
| `--memory`            | `CLARVIS_SERVER_MEMORY`            | off                |
| `--allow-public-bind` | `CLARVIS_SERVER_ALLOW_PUBLIC_BIND` | off                |
| `--allow-lan-bind`    | `CLARVIS_SERVER_ALLOW_LAN_BIND`    | off                |
| `--grace-ms <n>`      | `CLARVIS_SERVER_SHUTDOWN_GRACE_MS` | `15000`            |

The HTTP facade also bounds retained process state. `CLARVIS_SERVER_MAX_SESSIONS` defaults to 128
and reserves a slot before constructing an owner kernel, so concurrent initialize requests cannot
oversubscribe it. The reservation follows the request's abort signal and the overall
`CLARVIS_SERVER_SESSION_INIT_TIMEOUT_MS` deadline (30 seconds), including owner-kernel resolution;
a resolver that finishes after either boundary has its lease released instead of reviving the
abandoned session. Each session's notification queue is bounded by both
`CLARVIS_SERVER_STREAM_BUFFER_MAX` (1,024 events) and `CLARVIS_SERVER_STREAM_BUFFER_BYTES` (8 MiB);
the byte ceiling applies after event coalescing as well as on initial enqueue.
`CLARVIS_SERVER_MAX_BODY_BYTES` (4 MiB by default) is enforced while consuming the HTTP stream,
not after `Request.text()` has allocated it; chunked JSON-RPC and OAuth bodies are cancelled as soon
as their observed byte count crosses the limit.

With `--auth off` the bind address is the boundary: a public `--host` exits `1` unless you pass
`--allow-public-bind`, and an RFC1918 local-network address exits `1` unless you either set
`--auth required` or pass `--allow-lan-bind` to accept the network itself as the boundary. Owner ids
are then caller-supplied, so they separate data by namespace and do **not** authenticate the
separation — do not describe them to a client as isolation.

## Authentication

Enrolment is the operator's act and happens **only in a config file**, the way RabbitMQ declares its
users. There is no registration endpoint and no dynamic client registration; a caller the operator
did not write into `auth.json` is refused however good its token is.

The server is its own authorization server: it issues audience-bound Ed25519 JWTs over OAuth 2.0's
`client_credentials` grant, so a deployment needs no external identity provider. See
[`specs/hosts/server-auth.md`](../../specs/hosts/server-auth.md) for the design and the invariants.

```bash
clarvis-server hash-secret            # prints a generated secret and its digest
```

```jsonc
// <CLARVIS_HOME>/auth.json
{
  "version": 1,
  "clients": [
    { "client_id": "svc-app", "secret_hash": "sha256:9f2b…", "owner": "acme", "role": "service" },
  ],
  "roles": { "service": { "agents": ["support"], "max_runs": 2 } },
}
```

```bash
clarvis-server --auth required --owner-mode token --public-url https://clarvis.example.com
```

| Clarvis       | RabbitMQ equivalent          |
| ------------- | ---------------------------- |
| `clients[]`   | users in `definitions.json`  |
| `secret_hash` | `password_hash`              |
| `role`        | user tags (`administrator`…) |
| `owner`       | vhost                        |
| `roles{}`     | permissions                  |

Two roles exist without being declared: `admin` (every agent, may approve guarded commands, may act
for another owner) and `user` (every agent, approves nothing, its own owner only). Declaring either
overrides it field by field; any other role name starts from `user`. A role that lists `agents`
**requires** `clarvis_run` to name one. An omitted `agent` does resolve — to the shipped entry agent
— which is exactly why a restricted role may not omit it: the default is not on anyone's allowlist,
and silently entering it would make the restriction decorative. `guard_confirmations: "relay"` still needs
`CLARVIS_SERVER_ALLOW_REMOTE_GUARD_APPROVAL=1` — the container switch is the ceiling.

| Endpoint                                  | Auth                                  |
| ----------------------------------------- | ------------------------------------- |
| `POST /oauth/token`                       | open; authenticates the client itself |
| `/.well-known/oauth-protected-resource`   | open (RFC 9728)                       |
| `/.well-known/oauth-authorization-server` | open (RFC 8414), no registration      |
| `/.well-known/jwks.json`                  | open                                  |
| `/healthz`, `/readyz`                     | open                                  |
| the MCP path                              | `Authorization: Bearer <token>`       |

**A token carries only its `sub`.** Owner and role are read from `auth.json` on every request, so
removing or disabling a client takes effect at once rather than at its token's expiry. The file is
re-read when it changes: a bad edit keeps the last good configuration and logs, while a bad file at
**boot** exits `1` — zero clients never degrades into "any client".

The credential is checked on every request and each session is bound to the client that opened it, so
an `mcp-session-id` is not a bearer credential of its own. A live session also **adopts** the freshly
resolved permissions, so narrowing a role takes effect without waiting for a reconnect; only a change
of _owner_ under `--owner-mode token` cannot be adopted, and answers `403 session_stale`.

With `--owner-mode token` the owner comes from the enrolment record and is authenticated;
`x-clarvis-owner` is then a `403` unless the role may impersonate. Under the default `fixed` mode the
declared owners do **not** take effect — every client shares `CLARVIS_SERVER_OWNER` — and booting
that way with clients declaring otherwise logs a warning. With `--auth required` a public bind needs
no `--allow-public-bind`.

`secret_hash` is a **plain SHA-256**, compared in constant time — not a password KDF. A memory-hard
KDF buys time against an offline attack on a _human-chosen_ secret; against the 256 bits
`hash-secret` emits it buys nothing, while making every attempt expensive enough to need an attempt
budget, which in turn lets anyone who learns a `client_id` throttle the real client. The cost of the
choice is that the secret's entropy is the only thing between a leaked `auth.json` and a usable
credential, so `hash-secret` generates by default and refuses a supplied secret under 32 characters.

The remaining attempt budgets are **failure** budgets, charged only on a wrong credential, so a busy
client never throttles itself. The per-client one is keyed on `(client_id, peer)`, so nobody can
spend a budget that is not theirs; the peer one is a coarse backstop, sized far larger because an
egress address may front a whole fleet. Exhaustion answers `429` `slow_down` with `Retry-After`,
never `invalid_client`.

`auth.json` lives in the config directory and is **never** part of `settings.json`: workspace-scope
settings are a file inside the agent's own working tree, and a run must not be able to grant itself a
role.

## Tools

| Tool              | What it does                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| `clarvis_run`     | Start a run and block until it finishes, streaming progress. The call _is_ the run. |
| `clarvis_steer`   | Inject a message into a run still in flight on this session.                        |
| `clarvis_cancel`  | Cancel a run; the pending `clarvis_run` still returns its partial result.           |
| `clarvis_respond` | Answer a question, for a run started with `elicitations: "await"`.                  |

Two per-request knobs beyond the messages: `memory` (`on`/`off`) and `plans`
(`off`/`on`/`review`). Nothing else is exposed — no config, secrets, files, plans, memory, sessions
or cross-owner run listing. `guard_mode` is deliberately **not** accepted: a caller must not be able
to switch off the container operator's command guard.

The backing kernel boots with `builtins.tasks = false`. This is stronger than merely omitting
control endpoints: agents running through `clarvis_run` receive no external-task tools or bindings,
even when a local agent definition carries the corresponding grants. Tasks remain a
`KernelClient`/Code product surface and are not part of the public MCP facade in this release.
Worktrees are a Code launch-time choice, not a kernel capability or MCP surface.

**Pass `resetTimeoutOnProgress: true` and a `progressToken`**, or a `timeout` at least as long as the
run. The SDK's default request timeout is 60 s and a blocking `clarvis_run` will outlive it. The
server emits a progress heartbeat every 10 s so the reset actually fires.
These are client transport options/metadata, not `clarvis_run` tool arguments.

**Pass a stable `execution_id`.** Retries are then safe: a duplicate is rejected rather than starting
a second run. This matters because a restart drops in-flight runs (see _Scaling_).

Control acknowledgements are not work results: a successful `clarvis_steer` acknowledges the
instruction but does not confirm the requested work completed. Tool guidance keeps this distinction,
session scope and elicitation posture explicit; see
[`model-instructions.md`](../../specs/cross-cutting/model-instructions.md).

Long context compaction is visible as an `info` progress notification when it starts. Its terminal
event reports whether the context was summarized or mechanically evicted, including the fallback
reason when summarization failed or did not reduce the context enough.

An Admiral-controlled workflow checkpoint is emitted at `notice` while it is awaiting a next-round
decision. Its structured event carries the sequence revision and proposed round; other sequence
transitions remain `debug` diagnostics.

## Questions the run asks

A run can ask a human — `ask_user`, a command-guard confirmation, a plan-review gate, a soft budget
breach. How they are answered is resolved once per run:

| Posture        | When                                               | Behaviour                                              |
| -------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `relay`        | the client declared MCP's `elicitation` capability | forwarded to the client                                |
| `tool`         | `elicitations: "await"`                            | published on the stream; answer with `clarvis_respond` |
| `auto_decline` | otherwise (the default)                            | declined immediately                                   |

`auto_decline` is what keeps a headless caller from hanging: without it a run parks on each question
for the engine's elicit wait bound. Under `auto_decline` a requested `plans: "review"` is downgraded
to `"on"`, because an unanswered review gate _cancels_ the run rather than merely skipping approval.
Every applied constraint is reported back in the result's `posture` block.

Guard confirmations are denied regardless of posture unless
`CLARVIS_SERVER_ALLOW_REMOTE_GUARD_APPROVAL=1` **and** the caller's role allows it. The guard exists
to protect the container from the model; letting a caller approve arbitrary commands would remove the
only thing it does.

## Health

`GET /healthz` — liveness. `200` from the moment the socket binds, including during the drain. It
answers one question: is the event loop responsive. It deliberately checks no dependencies, so a
provider outage cannot turn into a restart loop.

`GET /readyz` — readiness. `200` only when the kernel has constructed, every settings scope parsed,
the default model resolves to a configured provider whose key is present in the environment, every
required MCP server is not unavailable, and the process is not draining. Otherwise `503` naming each
failing check. Durable memory-queue recovery begins only after readiness is published and therefore
never delays the readiness transition; subsequent recovery work remains observable through the
kernel's ordinary memory diagnostics.

## Shutdown

`SIGTERM` runs an ordered drain: stop accepting → wait `CLARVIS_SERVER_DRAIN_DELAY_MS` so the load
balancer observes the `503` → drain in-flight runs within the grace → cancel any survivor so its
trace still persists → give cancelled runs `CLARVIS_SERVER_RUN_SETTLE_GRACE_MS` to settle → close the
endpoint → close the kernel. A session keeps its owner-kernel lease through that bounded settle
window. Closing _after_ the drain is not cosmetic: closing tears down the SSE streams the runs are
writing to.

Set `terminationGracePeriodSeconds` above `drainDelay + grace + settle + margin` — **30 s** at the
defaults. Below that, SIGKILL lands mid-drain and the drain was theatre.

## Scaling

**One replica per config directory.** The trace store is local disk with an mtime-invalidated index
and `O_EXCL` lockfiles, neither of which is reliable over NFS/EFS, so a shared volume is unsafe
rather than merely awkward. Scale by running more containers off more config volumes. A restart
drops in-flight runs — already true, since a run lives only while its connection is open — so the
availability story is client retry with a stable `execution_id`.

Each replica opens its own MCP connections, so remote MCP servers see N clients rather than one.

## What it logs

One channel, through `@clarvis/kernel`'s `createLogger` / `createComponentLoggers` /
`createAuditLogger`, tagged `service: "@clarvis/server"` and stamped with an `instance_id`. Four
nested bindings narrow it: **server** → **request** (`req_id`) → **session**
(`session_id`, `owner`, `owner_authenticated`, `client_id`) → **run** (`execution_id`). Every record
names its event in an `event` field; the message is prose and is free to change. See
[`specs/cross-cutting/observability.md`](../../specs/cross-cutting/observability.md).

The kernel is handed the **root** logger, never the server's own `component: "server"` child: it
derives component children of its own, and a parent that already carries a `component` binding would
emit the key twice in one record.

**Configuration is environment and CLI only** — never `settings.json`, whose workspace scope is a
file inside the agent's own working tree, so a run that could write it could silence the record of
what it did. `CLARVIS_LOG_LEVEL` (or `--log-level`) sets the floor, `CLARVIS_LOG=server=debug`
narrows one component, `CLARVIS_LOG_AUDIT=off` disables the audit channel, and
`CLARVIS_SERVER_LOG_REQUESTS` (`off`|`errors`|`all`, default `errors`) decides how much of the
per-request hot path is written. There is no way to express "no destination".

### Audit — `audit: true`, and they survive the level filter

`CLARVIS_LOG_LEVEL=warn` is a legitimate production setting and would otherwise silence every
authentication success, every enrolment reload and every owner impersonation. **Every audit line
carrying an `owner` also carries `owner_authenticated`**, derived in one place (`ownerFields`),
because only `--owner-mode token` authenticates the owner and a line reading `owner: "acme"` on its
own asserts a boundary that does not exist.

| Level | Event                               | Fields                                                            |
| ----- | ----------------------------------- | ----------------------------------------------------------------- |
| info  | `auth.boot.loaded`                  | `file, clients, roles, owner_mode`                                |
| info  | `auth.config.reloaded`              | `file, clients, added, removed, disabled` — **ids, never hashes** |
| warn  | `auth.config.reload_failed`         | `file, err, kept_clients`                                         |
| warn  | `auth.config.disappeared`           | `file, kept_clients`                                              |
| info  | `auth.token.issued`                 | `client_id, expires_in, peer`                                     |
| warn  | `auth.token.rejected`               | `client_id` (when parsed), `reason, peer, status`                 |
| warn  | `auth.token.throttled`              | `client_id, peer, retry_after_s, budget`                          |
| warn  | `auth.request.rejected`             | `reason, status, client_id` when known                            |
| warn  | `auth.session.mismatch`             | `session_id, expected_client, presented_client`                   |
| warn  | `auth.session.stale`                | `session_id, client_id, from_owner, to_owner`                     |
| info  | `auth.principal.narrowed`           | `from_role, to_role` — only on a change                           |
| warn  | `authz.owner.impersonation_denied`  | `client_id, role, claimed_owner`                                  |
| info  | `authz.owner.impersonated`          | `client_id, role, owner, acting_for`                              |
| warn  | `authz.agent.denied`                | `client_id, role, agent, allowed`                                 |
| error | `bind.refused`                      | `reason, host` — then `exit 1`                                    |
| error | `auth.boot.failed`                  | `err` — then `exit 1`                                             |
| warn  | `bind.owner_unauthenticated`        | `host, owner_mode, owner_authenticated: false`                    |
| warn  | `auth.owner_mode.ignores_enrolment` | `declared, effective`                                             |

### Diagnostics

| Level | Event                                       | Fields                                                                                                                                                               |
| ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| info  | `server.boot.posture`                       | `host, port, path, owner_mode, auth, memory, builtins, max_runs, max_runs_per_owner, max_sessions, run_max_ms, log_requests`                                         |
| info  | `http.request`                              | `req_id, method, path, status, dur_ms, req_bytes, session_id, owner, client_id, rpc_method` — gated by `CLARVIS_SERVER_LOG_REQUESTS`                                 |
| debug | `http.body.rejected`                        | `req_id, reason, limit`                                                                                                                                              |
| warn  | `http.guard.blocked`                        | `req_id, reason, value`                                                                                                                                              |
| info  | `session.opened` / `session.closed`         | `sessions_live` · `reason, runs_cancelled, drained, dur_ms`                                                                                                          |
| warn  | `session.capacity_exhausted`                | `limit, live, reserved`                                                                                                                                              |
| info  | `session.init.timeout`                      | `req_id, phase, timeout_ms`                                                                                                                                          |
| info  | `run.started` / `run.finished`              | `agent, elicitation_posture, plans_effective, continue_from` · `status, dur_ms, ended_reason, cancelled_by, usage_*, events_sent, events_dropped, wedged, truncated` |
| warn  | `run.cancelled`                             | `execution_id, cancelled_by, elapsed_ms`                                                                                                                             |
| warn  | `run.rejected`                              | `reason, scope, in_flight, limit, owner`                                                                                                                             |
| info  | `run.posture.downgraded`                    | `execution_id, downgrades` — only when non-empty                                                                                                                     |
| warn  | `stream.wedged`                             | `reason, sent, dropped, queued_bytes, send_timeout_ms` — once per run                                                                                                |
| debug | `stream.dropped`                            | `dropped_total` — aggregated at seal, never per event                                                                                                                |
| debug | `elicit.answered`                           | `posture, action, auto`                                                                                                                                              |
| warn  | `task.failed`                               | `operation, err`                                                                                                                                                     |
| warn  | `mcp.connection.unavailable` / `.recovered` | `mcp_name, connection_id, down_count`                                                                                                                                |

A client-visible failure names its line: every response carries `x-clarvis-request-id`, and the
`req_id` is repeated in the error body's `data`. A caller-supplied request-id header is never
adopted — correlation that a caller can poison is worse than none.

**Never logged, at any level**: the `Authorization` header, a bearer token, a `secret_hash`, a JWK,
the contents of `auth.json`, or a run's prompt, messages or result. `/healthz` and `/readyz` build
no request log at all, and neither an SSE event nor a heartbeat is ever a line of its own.

## Development

The suite is physically classified by the boundary each test owns:

- `tests/unit/` covers pure server policy and state machines: authentication roles/configuration,
  request guards, event views, connection health, environment parsing, owner ids, live-run tables,
  notification buffering and elicitation posture/controller deadlines;
- `tests/component/` owns one representative wiring path for control tools, live-run publication,
  notifications, elicitation, role enforcement, and owner scoping without a real kernel or socket.
  The package-local fake `RunHost` is the single owner of run lifecycle signals and records starts,
  control calls and elicitation responses;
- `tests/integration/` owns real filesystem and loopback-HTTP effects, including auth issuance,
  config reload, MCP transport, endpoint serving, socket lifetime, and teardown;
- `tests/architecture/` guards dependency boundaries, the executable bind gate, and the public MCP
  tool surface.

Package-local fakes and harnesses live in `tests/helpers/`; they are support code, not an additional
test level. Component synchronization uses explicit host/notification barriers, never elapsed-time
polling, and every opened harness, client and server is registered for immediate `afterEach` cleanup.
Run the full suite or a named level explicitly:

```bash
bun --filter @clarvis/server test
bun --filter @clarvis/server test:unit
bun --filter @clarvis/server test:component
bun --filter @clarvis/server test:integration
bun --filter @clarvis/server test:architecture
bun --filter @clarvis/server typecheck
bun --filter @clarvis/server start -- --workspace /path/to/ws
```
