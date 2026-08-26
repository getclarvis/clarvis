# The four MCP tools, run hosting and session-scoped control

> Implemented at `packages/server/src/mcp/**`, `packages/server/src/host/**`,
> `packages/server/src/health/**`, `packages/server/src/tasks.ts`, `packages/server/src/logging.ts`
> and `packages/server/src/timing.ts`. Every claim below is anchored to a file and line. Open
> questions are collected in the final section.

## 1. Purpose

`@clarvis/server` exposes the Clarvis loop as an MCP-over-HTTP tool surface: a
caller talks to it with four tools instead of the kernel's full `KernelClient`.
`buildMcpServer` (`packages/server/src/mcp/server.ts:103`) assembles one
`@modelcontextprotocol/sdk` `McpServer` per MCP session, registering exactly
`clarvis_run`, `clarvis_steer`, `clarvis_cancel` and `clarvis_respond`
(`packages/server/src/mcp/tools.ts:10-15`). The problem this subsystem solves is threefold:

1. **Blocking-call semantics over a streaming engine.** `clarvis_run`
   (`packages/server/src/mcp/run-tool.ts:192` `handleRunTool`) starts a `RunHandle`, pumps its event
   stream out as MCP notifications, and does not return until the run settles
   — "the call **is** the run" (`packages/server/src/mcp/tools.ts:144`). A separate `clarvis_steer`
   / `clarvis_cancel` / `clarvis_respond` triad (`mcp/control-tools.ts`) lets
   the same session reach into that still-pending call.
2. **Session-scoped run bookkeeping with no durable state.** `LiveRunTable`
   (`packages/server/src/host/live-runs.ts:28-37`) is an in-memory map that exists only for as long
   as one MCP session's connection is open; there is no cross-session lookup
   and no persistence beyond the engine's own trace.
3. **Turning an unbounded, high-frequency engine event stream into a bounded
   transport write.** `createNotificationSink` (`packages/server/src/mcp/notify.ts:161`) coalesces
   adjacent deltas, caps queue depth and bytes, and degrades to a "wedged"
   state rather than stalling a run behind a slow or dead client socket.

Everything about *who* may call and *how* a connection is authenticated
belongs to the auth/HTTP/bind document; everything about *how* the kernel
that backs a session is constructed belongs to the kernel-composition work
item; the detailed mechanics of `mcp/elicitation.ts` belong to the
elicitation-and-user-interaction document. This document treats those as
external inputs (`ResolvedHost`, `Principal`, `AppliedPosture`) and describes
only the MCP tool surface, the run host/live-run table, health probes and the
package's own import boundary.

## 2. Surface

### 2.1 The four tools

| Constant | Wire name | Registered at | Input shape | Output shape |
|---|---|---|---|---|
| `TOOL_NAMES.run` | `clarvis_run` | `packages/server/src/mcp/server.ts:128-172` | `runInputShape` (`packages/server/src/mcp/tools.ts:58-72`) | `runOutputShape` (`packages/server/src/mcp/tools.ts:98-107`) |
| `TOOL_NAMES.steer` | `clarvis_steer` | `packages/server/src/mcp/server.ts:174-182` | `steerInputShape` (`packages/server/src/mcp/tools.ts:110-113`) | `ackOutputShape` (`packages/server/src/mcp/tools.ts:134-138`) |
| `TOOL_NAMES.cancel` | `clarvis_cancel` | `packages/server/src/mcp/server.ts:184-192` | `cancelInputShape` (`packages/server/src/mcp/tools.ts:116`) | `ackOutputShape` |
| `TOOL_NAMES.respond` | `clarvis_respond` | `packages/server/src/mcp/server.ts:194-202` | `respondInputShape` (`packages/server/src/mcp/tools.ts:119-124`) | `ackOutputShape` |

`TOOL_NAMES` is declared at `packages/server/src/mcp/tools.ts:10-15`, with a remark explaining the
underscored, prefixed naming (`^[a-zA-Z0-9_-]{1,64}$` client grammar and flat
namespace collision risk, `packages/server/src/mcp/tools.ts:5-8`).

### 2.2 `clarvis_run` input (`runInputShape`, `packages/server/src/mcp/tools.ts:58-72`)

| Field | Type | Notes |
|---|---|---|
| `prompt` | `string`, 1–1,000,000 chars, optional | exactly one of `prompt`/`messages` required (`packages/server/src/mcp/run-tool.ts:197-199`) |
| `messages` | array of `messageSchema`, 1–200 items, optional | see §3.2 |
| `agent` | `string`, 1–128 chars, optional | checked against `principal.permissions.agents` (`packages/server/src/mcp/run-tool.ts:203-211`) |
| `execution_id` | `EXEC_ID` (see §3.1), optional | caller-chosen; makes a retry idempotent per `TOOL_DESCRIPTIONS.run` (`packages/server/src/mcp/tools.ts:147`) |
| `continue_from` | `EXEC_ID`, optional | |
| `memory` | `"on" \| "off"`, optional | |
| `plans` | `"off" \| "on" \| "review"`, optional | may be downgraded by `resolvePosture` (§4.3) |
| `skill` | `{ name: string (1-128), task?: string (≤64,000) }`, optional | |
| `output_schema` | `record<string, unknown>`, optional | |
| `elicitations` | `"auto_decline" \| "await"`, default `"auto_decline"` | |
| `elicitation_wait_ms` | `number`, 1,000–600,000, optional | |

Deliberately **absent**: `guard_mode`, `guard_judge`, `prompt_cache_key`,
`prompt_cache_ttl` (as caller input) — see Invariant 5 and the remark at
`packages/server/src/mcp/tools.ts:47-57`. `task` is absent too — it names no field of
`runInputShape` (`packages/server/src/mcp/tools.ts:58-72`), and
`packages/server/tests/architecture/tool-surface.test.ts:35` asserts it out of the tool's
listed input schema.

### 2.3 `clarvis_run` output (`runOutputShape`, `packages/server/src/mcp/tools.ts:98-107`)

| Field | Type |
|---|---|
| `execution_id` | `string` |
| `status` | `"running" \| "completed" \| "failed" \| "cancelled"` |
| `result` | `unknown`, optional |
| `ended_reason` | `string`, optional |
| `usage` | `z.looseObject({})`, optional (deliberately loose, `packages/server/src/mcp/tools.ts:93-96`) |
| `error` | `{ code: string, message: string }`, optional |
| `posture` | `postureShape` (§2.4) |
| `stream` | `streamShape` (§2.5) |

Deliberately **absent** from output: `active_task` — it names no field of
`runOutputShape` (`packages/server/src/mcp/tools.ts:98-107`), asserted by
`packages/server/tests/architecture/tool-surface.test.ts:36`.

### 2.4 Posture block (`postureShape`, `packages/server/src/mcp/tools.ts:75-81`, output field `packages/server/src/mcp/tools.ts:105`)

| Field | Type |
|---|---|
| `elicitation` | `"relay" \| "tool" \| "auto_decline"` |
| `guard_confirmations` | `"relayed" \| "denied"` |
| `plans_effective` | `"off" \| "on" \| "review"`, optional |
| `downgrades` | `string[]` |
| `auto_answered` | non-negative integer |

### 2.5 Stream block (`streamShape`, `packages/server/src/mcp/tools.ts:84-89`)

| Field | Type |
|---|---|
| `events_sent` | non-negative integer |
| `deltas_coalesced` | non-negative integer |
| `events_dropped` | non-negative integer |
| `wedged` | boolean |

(`SinkStats` in `packages/server/src/mcp/notify.ts:13-20` additionally carries `truncated`, which
travels in the tool result's `_meta` block, not `streamShape`; see §3.4.)

### 2.6 Control tools

| Tool | Input (`mcp/tools.ts`) | Output |
|---|---|---|
| `clarvis_steer` | `{ execution_id: EXEC_ID, message: string(1-64,000) \| messageSchema }` (`:110-113`) | `ackOutputShape` |
| `clarvis_cancel` | `{ execution_id: EXEC_ID }` (`:116`) | `ackOutputShape` |
| `clarvis_respond` | `{ execution_id: EXEC_ID, id: string(1-256), action: "accept"\|"decline"\|"cancel", content?: record }` (`:119-124`) | `ackOutputShape` |

`ackOutputShape` (`packages/server/src/mcp/tools.ts:134-138`): `{ execution_id: string, accepted:
boolean, note?: string }`.

### 2.7 `buildMcpServer` surface

```ts
function buildMcpServer(opts: BuildMcpServerOptions): McpServerBundle
```
(`packages/server/src/mcp/server.ts:103`)

`BuildMcpServerOptions` (`packages/server/src/mcp/server.ts:43-73`): `resolved: ResolvedHost`,
`limits: McpServerLimits`, `gate?: ConcurrencyGate`, `version?: string`,
`getPrincipal?: () => Principal | undefined`, `logger?: ServerLoggers`.

The executable passes root-owned `PRODUCT_VERSION` through the HTTP/session seam as `version`, so
MCP initialization reports `@clarvis/server` at the same product version as the terminal and server
CLIs. The `0.0.0` default remains only for directly constructed test/library bundles that omit the
optional input. Production: `packages/server/src/bin.ts` (`serveClarvisMcpOverHttp` options),
`packages/server/src/http/serve.ts`, `packages/server/src/http/sessions.ts`, and
`packages/server/src/mcp/server.ts` (`buildMcpServer`). Test:
`packages/server/tests/unit/version.test.ts` and the product-version initialize case in
`packages/server/tests/integration/serve-http.test.ts`.

`McpServerLimits` (`packages/server/src/mcp/server.ts:28-40`): `maxRuns`, `maxRunsPerOwner`,
`bufferMax`, `bufferMaxBytes`, `sendTimeoutMs`, `heartbeatMs`, `runMaxMs`,
`settleGraceMs`, `elicitToolWaitMs`, `elicitRelayMs`,
`allowRemoteGuardApproval`.

`McpServerBundle` (`packages/server/src/mcp/server.ts:76-92`): `server: McpServer`, `runs:
LiveRunTable`, `drain(graceMs): Promise<boolean>`, `cancelAll(reason):
number`.

### 2.8 Host surface (`host/run-host.ts`, `host/owner-scoping.ts`)

| Symbol | Kind | Line |
|---|---|---|
| `RunHost` (`{ readonly runs: Pick<RunService, "start"> }`) | type | `packages/server/src/host/run-host.ts:12-14` |
| `OwnerContext` (`sessionId`, `owner`, `headers`, `principal?`) | type | `packages/server/src/host/run-host.ts:17-26` |
| `ResolvedHost` (`host`, `owner`, `principal?`, `release?`) | type | `packages/server/src/host/run-host.ts:29-42` |
| `KernelResolver = (ctx: OwnerContext) => Promise<ResolvedHost>` | type | `packages/server/src/host/run-host.ts:50` |
| `fixedKernelResolver(host, owner = "default")` | value | `packages/server/src/host/run-host.ts:61-63` |
| `OwnerScopedKernel` (`forOwner`, `acquireOwner?`) | type | `packages/server/src/host/owner-scoping.ts:4-7` |
| `ownerScopedKernelResolver(kernel)` | value | `packages/server/src/host/owner-scoping.ts:30-40` |

The pooled MCP connection each owner's run acquires is itself keyed on the
acquiring run's owner, so no owner is served another owner's warm connection;
setting `CLARVIS_MCP_POOL_SHARING` to `workspace` trades that back for one
subprocess per workspace, and is opt-in for that reason
(`packages/server/src/host/owner-scoping.ts:17-21`). Whether owner scoping is a real boundary or only a
naming convention depends on the owner mode: under `token` the owner comes
from an authenticated enrolment record, while under `fixed`/`header`/
`allowlist` it is validated but caller-supplied — separating data without
authenticating the separation, and not to be described to a client as
isolation (`packages/server/src/host/owner-scoping.ts:24-28`).

### 2.9 Live-run table and concurrency gate (`host/live-runs.ts`)

| Symbol | Kind | Line |
|---|---|---|
| `LiveRun` (`executionId`, `owner`, `handle`, `startedAt`, `elicit`, `lifecycleDone`, `cancelledBy?`) | type | `:7-17` |
| `LiveRunTable` (`add`, `get`, `require`, `delete`, `values`, `size`) | type | `:28-37` |
| `createLiveRunTable()` | value | `:40-73` |
| `ConcurrencyGate` (`acquire`, `inFlight`, `total`) | type | `:76-90` |
| `createConcurrencyGate(opts)` | value | `:133-178` |

### 2.10 Health probes

| Symbol | Kind | Line |
|---|---|---|
| `ConnectionHealth` (`sink`, `unavailable()`, `ready(required)`) | type | `packages/server/src/health/connection-health.ts:5-12` |
| `createConnectionHealth(logger?)` | value | `packages/server/src/health/connection-health.ts:37-76` |
| `isDefaultModelReady(merged, environment)` | value | `packages/server/src/health/model-readiness.ts:4-19` |

### 2.11 Errors, results, tasks, logging, timing

| Symbol | Kind | Line |
|---|---|---|
| `ServerErrorCode = KernelErrorCode \| "forbidden"` | type | `packages/server/src/mcp/errors.ts:12` |
| `ServerError` (class, `code`, `details`) | value | `packages/server/src/mcp/errors.ts:31-41` |
| `serverError(code, message, details?)` | value | `packages/server/src/mcp/errors.ts:44-50` |
| `mapError(err)` | value | `packages/server/src/mcp/errors.ts:61-83` |
| `ToolResult` (`content`, `structuredContent?`, `isError?`, `_meta?`) | type | `packages/server/src/mcp/results.ts:12-18` |
| `toolResult(envelope, meta?)` | value | `packages/server/src/mcp/results.ts:28-37` |
| `errorResult(code, message, details?)` | value | `packages/server/src/mcp/results.ts:47-60` |
| `errorResultFrom(err)` | value | `packages/server/src/mcp/results.ts:63-66` |
| `streamMeta(stats)` / `postureMeta(posture)` | value | `packages/server/src/mcp/results.ts:69-77`, `:80-82` |
| `observeServerTask(operation, run)` | value | `packages/server/src/tasks.ts:28-33` |
| `setServerTaskObserver(logger)` | value | `packages/server/src/tasks.ts:15-17` |
| `ServerLoggers` (`log`, `audit`, `child(bindings)`) | type | `packages/server/src/logging.ts:16-28` |
| `createServerLoggers(log, audit)` | value | `packages/server/src/logging.ts:37-45` |
| `SILENT_SERVER_LOGGERS` | value | `packages/server/src/logging.ts:54` |
| `ownerFields(owner, mode)` | value | `packages/server/src/logging.ts:68-73` |
| `RequestLogMode = "off" \| "errors" \| "all"` | type | `packages/server/src/logging.ts:76` |
| `RequestLogFields` | type | `packages/server/src/logging.ts:79-90` |
| `logHttpRequest(logger, mode, fields)` | value | `packages/server/src/logging.ts:104-115` |
| `REQUEST_ID_HEADER` (`"x-clarvis-request-id"`) | value | `packages/server/src/logging.ts:118` |
| `newRequestId()` / `newInstanceId()` | value | `packages/server/src/logging.ts:148-150`, `:159-161` |
| `CancelTimeout` / `ScheduleTimeout` (types) | type | `packages/server/src/timing.ts:2`, `:5` |
| `scheduleSystemTimeout: ScheduleTimeout` | value | `packages/server/src/timing.ts:8-12` |

`ServerLoggers.child` (`packages/server/src/logging.ts:22-27`) is what every run-scoped log line's
`execution_id` binding comes from: `handleRunTool` derives its own logger with
`loggers.child({ execution_id: handle.execution_id })` (`packages/server/src/mcp/run-tool.ts:276`)
rather than threading the id through every call.

`ScheduleTimeout` is a seam shared well beyond this table's own row: `run-
tool.ts` (`:18,47,146,166,172`), `mcp/notify.ts` (`:8,57,220`) and `mcp/
elicitation.ts` (`:4,145,258`) each accept an optional `scheduleTimeout` and
default to `scheduleSystemTimeout`, so that wall-clock timeouts, heartbeats,
send timeouts and elicitation deadlines are all replaceable by the same
deterministic-test seam; `tests/helpers/manual-timeouts.ts` is the harness
built over it.

### 2.12 Notification sink surface (`mcp/notify.ts`)

| Symbol | Kind | Line |
|---|---|---|
| `SendNotification` | type | `:23-26` |
| `NotificationSink` (`onEvent`, `notify`, `heartbeat`, `flush`, `seal`, `stats`) | type | `:29-41` |
| `NotificationSinkOptions` | type | `:44-64` |
| `WedgeReason` | type | `:67` |
| `reportDropped(logger, droppedTotal)` | value | `:106-111` |

`NotificationSinkOptions.observeDrain` (`:59`) and `.onDrainIdle` (`:61`) are,
by their own doc comments, internal deterministic-test seams with no
production caller: the harness that lets a test observe an in-flight `drain()`
call deterministically rather than by racing real timers. `reportDropped` is
the sealed-drop counterpart to the wedge-time `reportWedged` already cited in
§4.4.

### 2.13 `run-tool.ts`'s own surface

| Symbol | Kind | Line |
|---|---|---|
| `RunToolDeps` (`resolved`, `principal?`, `runs`, `gate`, `clientDeclaresElicitation`, `sendNotification`, `sendElicitRequest?`, `getLevel`, `limits`, `scheduleTimeout?`, `logger?`) | type | `:21-50` |
| `reportRunCancelled(logger, executionId, cancelledBy, elapsedMs)` | value | `:63-78` |
| `reportDowngraded(logger, executionId, downgrades)` | value | `:102-111` |
| `usageFields(result)` | value | `:114-124` |
| `RunToolArgs` | type | `:127-139` |
| `withDeadline` / `settlesWithin` | value | `:142-160`, `:163-174` |

`usageFields` flattens a finished run's usage into the exact scalar fields
`usage_iterations`, `usage_elapsed_ms`, and (when the engine reported them)
`usage_input_tokens`, `usage_output_tokens`, `usage_cached_tokens` (`:114-
124`). `withDeadline`/`settlesWithin` are the two race-a-timer helpers every
settle-grace step in §4.2 relies on. `reportRunCancelled`'s own doc comment
(`:59-61`) states it is shared with `cancelAll` "because a cancellation
reaches the caller only through the tool envelope — and if the connection is
what died, that envelope reaches nobody and the fact is otherwise lost": it is
the fallback record for a cancellation the caller's own tool result cannot
carry, not a routine per-cancel log line.

## 3. Data and formats

### 3.1 `execution_id` (`EXEC_ID`, `packages/server/src/mcp/tools.ts:19-23`)

```ts
z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
```

Comment: "a client-chosen run id: bounded and restricted to characters that
are safe in a path segment, since it becomes one in the trace store"
(`packages/server/src/mcp/tools.ts:17-18`). Caller-chosen and reused as the idempotency key for
retries: `live-runs.ts`'s `add` throws `conflict` on a duplicate id within one
session's table (`packages/server/src/host/live-runs.ts:44-49`), and `handleRunTool` checks the same
session's table again at `packages/server/src/mcp/run-tool.ts:259-266`, before ever calling
`runs.start` (`packages/server/src/mcp/run-tool.ts:268-274`).

### 3.2 Message shape (`packages/server/src/mcp/tools.ts:26-45`)

```ts
textPart   = { type: "text", text: string }
imagePart  = { type: "image", mime: string, data?: string, ref?: string }
messageSchema = {
  role: "user" | "assistant",
  content: string | (textPart | imagePart)[1..64]
}
```

### 3.3 Tool result envelope (`packages/server/src/mcp/results.ts:12-37`)

Every call returns

```ts
{
  content: [{ type: "text", text: JSON.stringify(envelope) }],
  structuredContent: envelope,
  _meta?: { "dev.clarvis/stream": SinkStats, "dev.clarvis/posture": AppliedPosture },
  isError?: true
}
```

`_meta` keys are namespaced under `dev.clarvis` (`META_NS`, `packages/server/src/mcp/results.ts:4`)
"keeping them out of MCP's own space" (`packages/server/src/mcp/results.ts:3`). An error result
sets `isError: true` and mirrors `{ error: { code, message, details? } }` both
as JSON text and as `structuredContent`, explicitly bypassing output-schema
validation (`errorResult`, `packages/server/src/mcp/results.ts:47-60`, remark at `:39-46`).

### 3.4 `SinkStats` (`packages/server/src/mcp/notify.ts:13-20`)

```ts
{ events_sent: number, deltas_coalesced: number, events_dropped: number,
  wedged: boolean, truncated: boolean }
```

`streamMeta` (`packages/server/src/mcp/results.ts:69-77`) puts the whole object under
`dev.clarvis/stream`; the `clarvis_run` output schema's own `stream` field
(§2.5) carries the same four counters minus `truncated` — `truncated` is only
observable through `_meta`, confirmed in
`packages/server/tests/component/run-tool.test.ts:124-125` (`result._meta["dev.clarvis/stream"]`
checked for `{ truncated: true }`).

### 3.5 `AppliedPosture` (`packages/server/src/mcp/elicitation.ts:16-33`)

```ts
{ elicitation: "relay" | "tool" | "auto_decline",
  guard_confirmations: "relayed" | "denied",
  plans_effective?: "off" | "on" | "review",
  prompt_cache_ttl?: "5m" | "1h",
  downgrades: string[],
  auto_answered: number }
```

Owned in detail by the elicitation-and-user-interaction document; carried
here only as the shape `handleRunTool` builds `StartRunParams` from
(`packages/server/src/mcp/run-tool.ts:219-227`, the `resolvePosture` call) and the output envelope's
`posture` field from (`packages/server/src/mcp/run-tool.ts:452`).

### 3.6 `StartRunParams` construction (`packages/server/src/mcp/run-tool.ts:245-257`)

```ts
{
  messages,
  agent?, execution_id?, continue_from?, memory?,
  plans: posture.plans_effective?,
  prompt_cache_ttl: posture.prompt_cache_ttl?,
  skill?, output_schema?,
}
```

Note `plans` and `prompt_cache_ttl` on the wire to the kernel come from the
**resolved posture**, never the raw request fields — the request never
carried `prompt_cache_ttl` at all (§2.2).

### 3.7 Error code space (`packages/server/src/mcp/errors.ts:12`, set at `:15-28`)

`ServerErrorCode = KernelErrorCode | "forbidden"`, backed at runtime by the
explicit `SERVER_ERROR_CODES` set: `unauthorized`, `not_found`,
`invalid_request`, `conflict`, `unavailable`, `unsupported`, `cancelled`,
`capability_disabled`, `continuation_unavailable`, `resource_exhausted`,
`internal`, `forbidden`. The comment on `forbidden`
(`packages/server/src/mcp/errors.ts:7-11`) states it exists because "the kernel has no notion of a
role" and a facade-level authorization refusal must not be flattened into
`unauthorized`.

### 3.8 Notification method vocabulary (`mcp/notify.ts`, `mcp/server.ts`)

| Method | Emitted from | Purpose |
|---|---|---|
| `notifications/message` | `notify.ts` `deliver` (`:253-260`), also `flush` (`:436-447`) | event/`viewOf` projection, and a final "notifications_dropped" summary |
| `notifications/message`, `data.type: "elicitation_pending"` | `run-tool.ts`'s elicitation `publish` callback (`:295-302`) | a guaranteed, non-droppable notice carrying the full `ElicitationRequest`, sent alongside the coalescible `elicitation_requested` run event (`:290-294`) — see §4.2 step 9 |
| `notifications/progress` | `notify.ts` `deliver` (`:261-268`), `heartbeat()` (`:418-434`) | per-event progress ticks and periodic heartbeats, only when the tool call carried a `progressToken` |
| `logging/setLevel` (request, not notification) | `packages/server/src/mcp/server.ts:119-123` | sets the session's `level` variable read by `getLevel()` |

### 3.9 `viewOf` event projection (`packages/server/src/mcp/event-view.ts:49-156`)

Every `RunEvent` variant is projected to `{level, logger,
label}`. Most resolve to `info` (`run_started`, `run_ended`,
`tool_call_started`, `model_retry`, `delegation_created`/`delegation_started`,
`delegation_completed`/`delegation_failed`, `workflow_run_started`,
`workflow_run_completed`/`workflow_run_failed`, `plan_created`/`plan_updated`/
`plan_removed`/`plan_review_resolved`, `elicitation_resolved`,
`steering_applied`, `compaction_started`) or `debug` (`iteration_started`/`iteration_completed`,
`tool_output_delta`, `tool_input_delta`, `text_delta`, `reasoning`,
`workflow_title_updated`, `workflow_run_progress`, `compaction`,
`memory_ingest`, `capability_event`). The non-default mappings, which decide
what a `logging/setLevel`-filtered client actually sees:

| `RunEvent.type` | Level | Line |
|---|---|---|
| `tool_call` | `info` if `event.ok`, else `warning` | `:65-70` |
| `model_error` | `warning` | `:79-80` |
| `plan_review_requested` | `notice` | `:108-109` |
| `elicitation_requested` | `notice` | `:112-113` |
| `soft_limit_check` | `notice` | `:116-117` |
| `compaction_skipped` | `warning` | `:120-125` |
| `vision_analysis` | `info` if `status === "completed"`, else `warning` | `:126-134` |
| `events_dropped` | `warning` | `:145-146` |
| `mcp_degraded` | `warning` | `:147-148` |

The `switch` closes with an exhaustive `never` default (`:151-154`), so a
`RunEvent` variant added upstream without a matching `case` here fails to
compile rather than silently defaulting to `info`.

`compaction_started` is deliberately `info`, while the terminal `compaction` event is `debug`: a
client at the default logging threshold must see that a potentially long context operation began,
even if it does not request routine terminal diagnostics. The terminal event itself carries the
operation and any summarization fallback reason in its structured `data`; `viewOf` does not flatten
those fields into the progress label.

## 4. Behavior

### 4.1 `buildMcpServer` construction (`packages/server/src/mcp/server.ts:103-231`)

1. Construct an SDK `McpServer` with `capabilities: { tools: {}, logging: {}
   }` (`:104-107`).
2. Build a fresh `LiveRunTable` (`:110`) and either use the supplied
   `gate` or build one from `opts.limits` (`:111-117`) — the doc comment on
   `BuildMcpServerOptions.gate` says it is "shared across sessions so the
   global cap really is global" (`packages/server/src/mcp/server.ts:46`).
3. Register a `SetLevelRequestSchema` handler that mutates a closed-over
   `level` variable (`:119-123`).
4. Register `clarvis_run`, wiring `handleRunTool`'s deps to the SDK's
   `extra.sendNotification`/`extra.sendRequest`/`extra.signal`/
   `extra._meta?.progressToken` (`:128-172`). `sendElicitRequest` wraps
   `extra.sendRequest` with the SDK's `elicitation/create` method and a zod
   response schema (`:148-160`). `principal: opts.getPrincipal?.()` is read
   **inside** this handler (`:140`), i.e. once per tool call rather than once
   at construction: `BuildMcpServerOptions.getPrincipal`'s own doc comment
   (`:49-59`) states this is deliberate, since the enrolment file is the
   authority and is re-read on every request, so a role narrowed mid-session
   takes effect on the very next call rather than only after a reconnect.
5. Register `clarvis_steer` (`:174-182`), `clarvis_cancel` (`:184-192`),
   `clarvis_respond` (`:194-202`), each a thin call into
   `control-tools.ts`.
6. Return the bundle's `drain` and `cancelAll`:
   - `drain(graceMs)` races `Promise.allSettled` over every live run's
     `lifecycleDone` against a `setTimeout` (`:207-218`); a timer whose
     `unref?.()` is called so it never keeps the process alive on its own.
   - `cancelAll(reason)` marks every still-unmarked `LiveRun.cancelledBy` and
     calls `handle.cancel()` through `observeServerTask` for each
     (`:219-229`) — see §6.

### 4.2 `handleRunTool` (`packages/server/src/mcp/run-tool.ts:192-485`), the `clarvis_run` flow

Numbered in call order:

1. **Argument validation.** Reject unless exactly one of `prompt`/`messages`
   is present (`:197-199`, XOR via `(a === undefined) === (b === undefined)`).
2. **Authorization.** If a `principal` is present and `mayRunAgent(principal,
   args.agent)` is false, audit-log `authz.agent.denied` and return a
   `forbidden` error result naming the role and (if supplied) the agent
   (`:203-211`). (`mayRunAgent`/`Principal` belong to the auth document.)
3. **Message normalization**: `prompt` becomes a single `{role: "user",
   content: prompt}`; otherwise `args.messages` is cast to `Message[]`
   (`:214-217`).
4. **Posture resolution**: `resolvePosture(...)` (owned by the
   elicitation-and-user-interaction item) folds client capability, requested
   elicitation mode, requested plan mode and guard-approval permissions into
   an `AppliedPosture` (`:219-227`).
5. **Concurrency admission**: `deps.gate.acquire(owner, principal's maxRuns)`
   (`:238-243`); a thrown `ServerError` short-circuits to `fail(err)` before
   anything else happens.
6. **Build `StartRunParams`** (`:245-257`) from the messages, the raw
   arguments and the resolved posture's `plans_effective`/`prompt_cache_ttl`
   — never the caller's own `plans`/`prompt_cache_ttl` fields (see §3.6).
7. **Duplicate-id guard**: if `execution_id` is already live in this
   session's table, release the just-acquired gate slot and return a
   `conflict` error (`:259-266`).
8. **Start the run**: `deps.resolved.host.runs.start(params)`; on throw,
   release the gate slot and `fail(err)` (`:268-274`).
9. **Build the sink and elicitation controller** (`:276-309`), log
   `run.started` (`:311-323`) and, if `posture.downgrades.length > 0`, log
   `run.posture.downgraded` (`:324-326`). The controller's `publish` callback
   does two distinct things per pending elicitation: a coalescible,
   droppable `elicitation_requested` run event via `sink.onEvent` (`:290-
   294`), **and** a non-droppable `notifications/message` carrying the whole
   `ElicitationRequest` under `data.type: "elicitation_pending"` via
   `sink.notify` (`:295-302`) — see §3.8's notification-vocabulary table.
10. **Register the live run.** `controller.attach(handle)` then
    `deps.runs.add({...})` (`:332-341`). Step 7's duplicate-id check and this
    `add` are two separate, non-atomic operations against the same table
    (`:259-266` vs `:334-341`), so a second collision can still land here; if
    `add` throws, dispose the controller, fire-and-settle a cancel, release
    the gate and return the error (`:342-349`).
11. **Wire abort, wall-clock timeout and heartbeat**:
    - `extra.signal` `"abort"` listener calls `markCancelled("client")` then
      `handle.cancel()` via `observeServerTask` (`onAbort`, `:357-360`,
      wired at `:375-376`); if the signal is *already* aborted at this
      point, `onAbort()` fires synchronously (`:376`) — the `handleRunTool`
      doc comment (`:188-190`) calls out exactly this window: "abort
      listeners do not replay an abort that happened while `runs.start()`
      awaited, the post-registration state check closes that window
      synchronously."
    - `wallClock` timer at `deps.limits.runMaxMs` calls
      `markCancelled("wall_clock")` then cancels the handle (`:378-381`).
    - `heartbeat` interval at `deps.limits.heartbeatMs` calls
      `sink.heartbeat()` (`:384-385`).
    - Both timers are `unref?.()`-ed (`:382`, `:385`); `stopRunControls`
      (defined `:365-372`) tears all three down and disposes the
      controller, idempotently (guarded by `controlsStopped`).
12. **Notify `run_accepted`** on the sink with `execution_id`, `owner`,
    `posture`, `wall_clock_ms` (`:387-400`).
13. **Pump the event stream** into the sink: an async loop over
    `handle.events[Symbol.asyncIterator]()` calling `sink.onEvent` per value,
    swallowing its own rejection (`:402-409`).
14. **Await `handle.done`**, converting a throw into a synthetic `{status:
    "failed", error: {code: "internal", ...}}` result (`:411-420`).
15. **Stop the timers/abort listener/controller** via `stopRunControls()`
    (`:421`).
16. **Settle the stream**: race `[pump, handle.closed]` against
    `settleGraceMs`; if it did not settle, call `eventIterator.return?.()`
    and race again against the same grace (`:423-436`). `sink.seal(!streamSettled)`
    marks `truncated` when the first race failed (`:428`).
17. **Flush the sink** (`:438`), read its stats (`:440`), and build the
    result envelope from `result` plus `live.cancelledBy === "wall_clock" ?
    "server_wall_clock_cap" : result.ended_reason` (`:441-454`).
18. **Log `run.finished`** with duration, the flattened `usage_iterations`,
    `usage_elapsed_ms`, `usage_input_tokens`, `usage_output_tokens`,
    `usage_cached_tokens` fields (`usageFields`, §2.13, `:114-124`, spread in
    at `:466`), and stream counters (`:456-473`), then return the tool result
    (`:474`).
19. **`finally`**: stop controls again (idempotent), if the lifecycle wasn't
    already waited on cancel-and-settle once more, delete the live-run
    table entry, release the gate slot, resolve `finishLifecycle()`
    (`:475-484`).

`lifecycleDone` (a promise resolved only in the `finally`) is what
`McpServerBundle.drain` waits on (`packages/server/src/mcp/server.ts:208`) and what
`packages/server/tests/unit/run-lifecycle.test.ts:24-198` pins: the live-run table entry and
gate slot must survive the event pump, survive `handle.closed` still
pending, and only clear once both are drained.

### 4.3 Control tools (`mcp/control-tools.ts`)

| Tool | Steps |
|---|---|
| `handleSteerTool` (`:11-29`) | `runs.require(execution_id)` (throws `not_found` if absent) → `handle.steer(message)` → `toolResult({accepted: true, note: "delivered..."})`; any throw → `errorResultFrom` |
| `handleCancelTool` (`:37-53`) | `runs.require` → `live.cancelledBy ??= "client"` → `handle.cancel()` → ack with note "cancelling; the pending clarvis_run call will return the partial result" |
| `handleRespondTool` (`:62-86`) | `runs.require` → `live.elicit.respond({id, action, content?})` → ack mirroring `outcome.accepted`/`outcome.note` |

All three are synchronous lookups keyed on the *calling session's own*
`LiveRunTable` (`packages/server/src/mcp/server.ts:181,191,201` all pass the one `runs` built in
step 2 of §4.1) — a second session's `execution_id` is simply not in that
map, so `require` throws `not_found` (pinned by
`packages/server/tests/unit/live-runs.test.ts:57-69` at the table level and by
`packages/server/tests/component/control-tools.test.ts:83` "a second session cannot reach the
first session's run").

### 4.4 `createNotificationSink` state machine (`packages/server/src/mcp/notify.ts:161-459`)

Per-sink mutable state: `queue: Entry[]`, `stats`, `progress`, `draining`,
`sealed`, `queuedBytes`, `heartbeatOutstanding`.

| State / event | Effect |
|---|---|
| `onEvent(event)`, not sealed, not wedged, mergeable with queue tail | `coalesceRunEvents` merges in place; if the merged size would exceed `bufferMaxBytes`, drop the tail entry instead and count it (`:369-392`); else replace tail, bump `deltas_coalesced`, `kickDrain()` |
| `onEvent(event)`, buffer at `bufferMax` or over `bufferMaxBytes` | evict the first *droppable* entry (`isDroppable`, keyed off `RUN_EVENT_POLICY[type].droppable`); if none is droppable and the new event itself is droppable, drop it and return; if none is droppable and the new event is **not** droppable, `markWedged("buffer_full")`, `truncated = true`, and drop the whole queue plus this event (`:393-408`) |
| `onEvent`/`notify`, `sealed === true` | increment `events_dropped`, set `truncated = true`, do nothing else (`:357-361`, `:319-323`) |
| `onEvent`/`notify`, `stats.wedged === true` | increment `events_dropped` only (no queueing) |
| `send()` | races `opts.sendNotification` against `sendTimeoutMs`; timeout → `markWedged("send_timeout")`; thrown → `markWedged("send_failed")`; success → `events_sent += 1` (`:216-237`) |
| `runDrain()` reaches `stats.wedged` mid-drain | drop the remainder of the queue via `clearQueue()`, counted as dropped, and stop (`:280-283`) |
| `heartbeat()` | no-op if sealed, no `progressToken`, wedged, or one heartbeat already outstanding; else enqueues a droppable `notifications/progress` entry keyed `"heartbeat"` (`:418-434`) |
| `flush()` | loops `await drain()` until the queue is empty and nothing is draining; if any drops occurred and the sink is not wedged, sends one final `notifications/message` reporting `notifications_dropped` (`:436-447`) |
| `seal(truncated?)` | sets `sealed = true`; if `truncated` was passed true, also sets `stats.truncated`; if any drops occurred, logs `stream.dropped` once (`:449-453`) |

If the buffer is momentarily full when `heartbeat()`'s own enqueue runs, the
`enqueueNotification` call returns `false` without wedging the sink or
incrementing `events_dropped` — the buffer-full/wedge path only fires for a
*non*-droppable entry, and a heartbeat's own entry is droppable — so the
`heartbeat()` call just resets `heartbeatOutstanding` and tries again on the
next tick (`:433`). Heartbeat delivery is therefore best-effort with no
explicit failure signal at that call site.

`markWedged` is idempotent (`if (stats.wedged) return`, `:178`) and logs
`stream.wedged` exactly once via `reportWedged` (`:80-98`). The doc comment on
`createNotificationSink` (`:146-160`) states the design intent: this sink
bounds a slow *transport*, distinct from whatever buffer bound the *kernel*
applies to a slow *consumer*.

`kickDrain`'s own comment (`:304-305`) documents a specific hazard it avoids:
"Promise reactions are retained until their source settles. Observing the
same blocked drain per delta therefore bypasses every queue byte cap" — i.e.
naively awaiting an in-flight `drain()` call from every `onEvent` would
accumulate unbounded continuations regardless of the queue caps.

### 4.5 Health probes

`createConnectionHealth` (`packages/server/src/health/connection-health.ts:37-76`) keeps a `Map<
connection_id, mcp_name>` of connections currently `unavailable`.
`sink(event)` adds/reports on a new `"unavailable"` transition and, for
**every other** `ConnectionEvent.state` (including `"closed"`), deletes the
entry and reports `"recovered"` if it had been down (`:58-67`) — the sink
code does not distinguish `"closed"` from any other non-`"unavailable"`
state; both collapse to the same delete-and-maybe-report branch. `ready
(required)` is true iff no required server name appears among any live
connection's `unavailable` set (`:71-74`). The doc comment (`:14-36`) states
the reason state is per-**connection** rather than per-name: several
connections to one server name can coexist, and "a name is unavailable while
*any* of its live connections is" (`:27-28`); it also states why `closed`
gets no distinct verb: "`closed` drops the entry, which is why this counts
connections rather than summing transitions. A connection that goes
`unavailable` and is then closed never emits `recovered`... so any tally that
only ever cancelled `unavailable` against `recovered` would leave the server
permanently down" (`:30-35`).

**Connections open lazily**, on the first run that references one, so a
server name that has never been observed reads as **ready** rather than
blocking the probe forever — `ready(required)` only ever excludes a name
that is *currently* in the `unavailable` map, and an unopened connection has
no entry there at all (`:18-21`). A host that wants the check to be a real
assertion has to warm the required servers at boot, which both populates
this map and primes the connection pool.

`isDefaultModelReady(merged, environment)` (`packages/server/src/health/model-readiness.ts:4-19`)
is a pure, offline check: parse `merged.default_model` with `parseModelRef`,
find the matching entry in `merged.providers`, and require either no
`api_key_env` or a non-empty value for that env var name in the supplied
`environment` map. Returns `false` for any malformed `merged` shape
(`:8`).

### 4.6 `observeServerTask` (`packages/server/src/tasks.ts:28-33`)

A module-level `sink: Logger` (default `NOOP_LOGGER`, `packages/server/src/tasks.ts:3`) is set
once at boot by `setServerTaskObserver` (`:15-17`).
`observeServerTask(operation, run)` wraps `detachObserved` (from
`@clarvis/capability`) so a fire-and-forget task's failure is reported
through `reportTaskFailure` (`:20-25`) rather than an unhandled rejection.
Its doc comment (`:9-13`) frames the module as replacing
"`process.emitWarning`, which no package installs a handler for."

## 5. Invariants

**Invariant 1 (INV-237).** No file in `@clarvis/server`'s `src/` or `tests/`
imports `@clarvis/loop`, `@clarvis/memory`, `@clarvis/plan`, or `@clarvis/tasks`;
a `@clarvis/kernel` import is only ever one of the
four sanctioned entrypoints (`.`, `./bootstrap`, `./config`, `./policy` — no
`./local`).
Production: this subsystem's own files import only `@clarvis/kernel/policy`
(`packages/server/src/mcp/event-view.ts:1`, `packages/server/src/mcp/notify.ts:1-6`) and `@clarvis/kernel/bootstrap`
(`packages/server/src/health/connection-health.ts:2`, type-only). `bin.ts` (outside this document's
scope) is the only file that imports the bare `@clarvis/kernel` entry, at `packages/server/src/bin.ts:3-11`.
Test: `packages/server/tests/architecture/dependency-boundary.test.ts:52`.

**Invariant 2 (INV-238).** The server's own `package.json` and
`tsconfig.build.json` name none of `@clarvis/loop`, `@clarvis/memory`,
`@clarvis/plan`, or `@clarvis/tasks` at all — checked two
different ways for two different attack surfaces. `package.json` is scanned
for the exact npm specifier string, e.g. `"@clarvis/loop"`
(`packages/server/tests/architecture/dependency-boundary.test.ts:71`); `tsconfig.build.json` is scanned instead
for the relative project-reference path form, e.g.
`../loop/tsconfig.build.json` (`:72-74`) — a declared dependency and a build-graph
project reference are different things, and neither file is checked for the
other's pattern.
Test: `packages/server/tests/architecture/dependency-boundary.test.ts:67-75`.

**Invariant 3 (INV-240).** `bin.ts` boots its backing kernel with `builtins:
{ tasks: false }`, disables subscription-backed providers, and never references `tasks.provider`.
Worktrees are no longer a separately composed kernel builtin, so there is no `worktrees` switch.
Production evidence within this document's scope: neither `runInputShape`
(`packages/server/src/mcp/tools.ts:58-72`) nor `runOutputShape` (`packages/server/src/mcp/tools.ts:98-107`) names
`task` or `active_task`, consistent with Tasks being unreachable.
Production: `packages/server/src/bin.ts:318-338`.
Test: `packages/server/tests/architecture/tool-surface.test.ts:9-15`.

**Invariant 4 (INV-241).** The server's MCP tool listing exposes exactly four
tools: `clarvis_run`/`clarvis_steer`/`clarvis_cancel`/`clarvis_respond` —
nothing more.
Production: `packages/server/src/mcp/server.ts:128,174,184,194` are the only four
`server.registerTool` call sites in the file, and `packages/server/src/mcp/tools.ts:10-15` is the
only place `TOOL_NAMES` is declared.
Test: `packages/server/tests/architecture/tool-surface.test.ts:17-24`.

**Invariant 5 (INV-242).** The `clarvis_run` tool's input/output schemas omit
every caller-controlled policy or local-only field: `guard_mode`,
`guard_judge`, `prompt_cache_key`, `prompt_cache_ttl` (as input),
`task` (input), and `active_task` (output) are all absent.
Production: `runInputShape` (`packages/server/src/mcp/tools.ts:58-72`) and `runOutputShape`
(`packages/server/src/mcp/tools.ts:98-107`) enumerate every field of each schema; none of the six
named fields appears. The remark at `packages/server/src/mcp/tools.ts:47-57` states the reasoning
for `guard_mode`/`guard_judge`/`prompt_cache_key` explicitly (the guard
omission "is the whole protection," and `prompt_cache_key` "becomes a
cross-owner cache-poisoning vector once owners share a kernel").
Test: `packages/server/tests/architecture/tool-surface.test.ts:26-34`.

**Invariant 5a.** The production executable's MCP `serverInfo.version` equals the single
root-owned product version. Production: `packages/server/src/version.ts` (`PRODUCT_VERSION`) and
`packages/server/src/bin.ts` (`version: PRODUCT_VERSION`). Test:
`packages/server/tests/unit/version.test.ts`,
`packages/server/tests/integration/serve-http.test.ts` (product-version initialize), and
`packages/server/tests/architecture/product-version.test.ts`.

**Invariant 6 (derived).** A `LiveRunTable` never returns another session's
run: `add` throws `conflict` on a same-table duplicate id (`packages/server/src/host/live-runs.ts:44-
49`) and `require` throws `not_found` for any id not in *this* table
(`packages/server/src/host/live-runs.ts:54-62`) — there is no shared or global run registry
(`createLiveRunTable()` is a fresh closure per `buildMcpServer` call,
`packages/server/src/mcp/server.ts:110`).
Test: `packages/server/tests/unit/live-runs.test.ts:35-48,57-69`;
`packages/server/tests/component/control-tools.test.ts:83` ("a second session
cannot reach the first session's run").

**Invariant 7 (derived).** A concurrency-gate release function is idempotent:
calling it more than once after the first call has no further effect on
`total`/`inFlight`.
Production: `packages/server/src/host/live-runs.ts:162-169`, guarded by a closed-over `released`
boolean.
Test: `packages/server/tests/unit/live-runs.test.ts:111-118` ("release is
idempotent when called more than once").

**Invariant 8 (derived).** An owner-supplied per-role `maxRuns` can only
*narrow* the operator's configured per-owner cap, never widen it:
`Math.min(opts.perOwner, ownerLimit)` (`packages/server/src/host/live-runs.ts:140`).
Test: `packages/server/tests/unit/live-runs.test.ts` "uses a role cap only to
narrow the operator's per-owner limit."

**Invariant 9 (derived).** A `clarvis_run` call's live-run-table entry and
concurrency-gate slot are held until *both* the event stream and
`RunHandle.closed` have settled (or the `settleGraceMs` deadline elapses
twice, once for the stream/closed race and once for the iterator-return/closed
race) — they are never released merely because `handle.done` resolved.
Production: `packages/server/src/mcp/run-tool.ts:423-436` (the settle races) and `:475-484` (the
`finally` block that deletes the table entry and releases the gate, run only
after those races and the sink flush complete).
Test: `packages/server/tests/unit/run-lifecycle.test.ts:24-198` ("keeps the
live run and gate slot through the event pump and sink flush", "...until
RunHandle.closed settles").

**Invariant 10 (derived).** A notification sink, once wedged, never calls
`sendNotification` again and only counts further events as dropped.
Production: `send()` returns immediately if `stats.wedged` (`packages/server/src/mcp/notify.ts:217`);
`onEvent`/`notify` short-circuit to a drop-count increment when
`stats.wedged` (`packages/server/src/mcp/notify.ts:362-365`, `packages/server/src/mcp/notify.ts:324-327`).
Test: `packages/server/tests/unit/notify.test.ts:300` "drops new events
immediately once wedged, without calling sendNotification again."

**Invariant 11 (derived).** A sink whose buffer is saturated with entirely
non-droppable structural notifications wedges (drops the whole queue) rather
than growing without bound.
Production: `packages/server/src/mcp/notify.ts:395-403` (the `victim === -1` branch when the
triggering event is itself non-droppable).
Test: `packages/server/tests/unit/notify.test.ts:424-441` ("wedges instead of
growing without bound when structural events saturate the buffer").

## 6. Failure modes and degradation

| Condition | Handling | Cite |
|---|---|---|
| Neither/both of `prompt`/`messages` supplied | `errorResult("invalid_request", ...)`, no gate acquired, no run started | `packages/server/src/mcp/run-tool.ts:197-199` |
| Role forbids the requested (or missing) agent | audit-logged `authz.agent.denied`, `errorResult("forbidden", ...)` | `packages/server/src/mcp/run-tool.ts:203-211`, `reportAgentDenied` `:87-99` |
| Concurrency gate at the server-wide cap | `ServerError("resource_exhausted", { scope: "server" })` thrown synchronously from `acquire` **before** the per-owner check ever runs; logged once via `reportRejected(..., "server", ...)` — an owner well under its own limit is still refused here first | `packages/server/src/host/live-runs.ts:141-149`, `reportRejected` `:112-130` |
| Concurrency gate at the per-owner cap (server-wide cap not reached) | `ServerError("resource_exhausted", { scope: "owner" })`; logged via `reportRejected(..., "owner", ...)` | `packages/server/src/host/live-runs.ts:150-158` |
| Duplicate `execution_id` already live on this session | gate slot released, `ServerError("conflict", ...)` | `packages/server/src/mcp/run-tool.ts:259-266` |
| `runs.start` throws | gate slot released, error mapped via `fail`/`mapError` | `packages/server/src/mcp/run-tool.ts:268-274` |
| Race: caller aborted or a second `add` collided between start and registration | controller disposed, handle cancelled best-effort within `settleGraceMs`, gate released, error returned | `packages/server/src/mcp/run-tool.ts:342-349` |
| Client disconnects the MCP transport / aborts mid-run | `onAbort` marks `cancelledBy: "client"` and calls `handle.cancel()` via `observeServerTask` (never awaited by the abort listener itself) | `packages/server/src/mcp/run-tool.ts:357-360`, wired `:375-376` |
| Run exceeds `limits.runMaxMs` | `markCancelled("wall_clock")`, `handle.cancel()`; final envelope's `ended_reason` becomes `"server_wall_clock_cap"` | `packages/server/src/mcp/run-tool.ts:378-381`, `:445-449` |
| `handle.done` itself throws | synthesized `{status: "failed", error: {code: "internal", message}}` rather than propagating | `packages/server/src/mcp/run-tool.ts:411-420` |
| Event stream / `handle.closed` do not settle within `settleGraceMs` | `sink.seal(true)` (marks `truncated`), a second bounded attempt calls `eventIterator.return?.()` | `packages/server/src/mcp/run-tool.ts:423-436` |
| A single `sendNotification` exceeds `sendTimeoutMs` or throws | sink wedges (`send_timeout`/`send_failed`), rest of the queue is dropped, `stream.wedged` logged once | `packages/server/src/mcp/notify.ts:216-237`, `:80-98` |
| Buffer full, evictable entries exist | oldest droppable entry evicted per new arrival, counted as dropped | `packages/server/src/mcp/notify.ts:404-407` |
| Buffer full, nothing droppable and the new item is not droppable either | sink wedges with reason `"buffer_full"`, whole queue counted dropped | `packages/server/src/mcp/notify.ts:400-403` |
| A pending elicitation's channel dies (relay send throws, or `dispose()` is called) | auto-declined via `answer(id, "decline")`, counted in `posture.auto_answered` | `packages/server/src/mcp/elicitation.ts:207-211` (`autoDecline`), `:284-287` (`dispose`) |
| Session/process shutdown with runs in flight | `McpServerBundle.cancelAll(reason)` marks every unmarked `cancelledBy` and best-effort cancels each via `observeServerTask`, logging `run.cancelled` per run through `reportRunCancelled` | `packages/server/src/mcp/server.ts:219-229`, `packages/server/src/mcp/run-tool.ts:63-78` |
| A detached background task (`observeServerTask`) throws | never surfaces to the caller; logged once as `task.failed` through the module-level sink | `packages/server/src/tasks.ts:20-33` |
| An unrecognized/unexpected thrown error reaches a tool handler | `mapError` degrades any code outside `SERVER_ERROR_CODES` to `"internal"`, so no stack or unexpected code ever reaches the caller | `packages/server/src/mcp/errors.ts:61-83` |

## 7. Coupling

**What this subsystem depends on, and what forces it:**

- `@clarvis/kernel/policy` (`RUN_EVENT_POLICY`, `coalesceRunEvents`,
  `sizeOfRunEvent`, `sizeOfCoalescedRunEvent`) — a static value import in
  `packages/server/src/mcp/notify.ts:1-6` and `packages/server/src/mcp/event-view.ts:1`. This is the mechanism that
  keeps event-droppability/coalescing policy defined once in the kernel
  rather than duplicated here; `mergeKeyOf`'s own comment
  (`packages/server/src/mcp/event-view.ts:158-166`) states "which event types are eligible is read
  from kernel's `RUN_EVENT_POLICY` rather than re-listed here."
- `@clarvis/kernel/bootstrap`, type-only, for `ConnectionEvent`/
  `ConnectionEventSink` (`packages/server/src/health/connection-health.ts:2`) — the health
  tracker's `sink` field is handed to `createFileKernel` by the
  kernel-composition document; this package only consumes the event shape.
- `@clarvis/protocol` for `RunEvent`, `RunHandle`, `RunResult`,
  `StartRunParams`, `Message`, `ElicitationRequest`, `ElicitationResponse`,
  `RunService`, `KernelErrorCode` — used throughout `mcp/*` and `host/*` as
  pure types; `@clarvis/protocol` carries no runtime dependency on
  `@clarvis/loop`, and none on anything else either — its manifest declares no
  `dependencies`, `devDependencies` or `peerDependencies` block at all
  (`packages/protocol/package.json:1-33`), and all 17 files under
  `packages/protocol/src/` import only `./`-relative siblings.
- `@clarvis/capability` for `Logger`, `NOOP_LOGGER`, `bind`,
  `detachObserved`, `suppressSecondaryRejection` — a leaf dependency used for
  the logging port and detached-task observation (`packages/server/src/tasks.ts:1`,
  `packages/server/src/mcp/notify.ts:10`).
- `@modelcontextprotocol/sdk` (`McpServer`, `SetLevelRequestSchema`) — the
  transport/protocol library `buildMcpServer` wraps (`packages/server/src/mcp/server.ts:1-2`).
- `../auth/principals.ts` (`Principal`, `mayRunAgent`) — consumed by
  `packages/server/src/mcp/run-tool.ts:9` for the agent-authorization check in step 2 of §4.2; owned
  by the auth document.

**What forces the import boundary (Invariants 1–2):**
`tests/architecture/dependency-boundary.test.ts` statically scans every `.ts`
file under `src/` and `tests/` for import specifiers (`importedSpecifiers`,
`:19-23`, a regex covering `from`, bare `import(...)`, `require(...)`) and
asserts none matches `FORBIDDEN` (`:5-11`) or an unlisted `@clarvis/kernel/*`
subpath (`KERNEL_ENTRYPOINTS`, `:12-17`); a second assertion greps
`package.json` and `tsconfig.build.json` text for the same forbidden names
(`:73-80`, split by file — see Invariant 2). This is a
textual/static check, not a type-level or runtime one — it would not catch a
forbidden import reached only through a re-exported barrel from an allowed
package, though no such indirection appears among the files in this
document's scope. Its own dedicated test, "recognises type-only, exported, side-effect,
and dynamic imports" (`:33-50`), pins that `importedSpecifiers`' regex
actually captures all four of `import type { X } from "…"`, `export type { X }
from "…"`, a bare side-effect `import "…"`, and a dynamic `import("…")` (plus
the inline `type X = import("…").Y` form) — without that test, a forbidden
import written in any of those four forms could escape the scan the rest of
this boundary relies on.

**What depends on this subsystem, and why:**
- `bin.ts` (outside this document's scope) boots the HTTP transport
  (`serveClarvisMcpOverHttp`, `packages/server/src/bin.ts:251`); the bundle
  itself is constructed one-per-session inside that transport, by
  `createSession` (`packages/server/src/http/sessions.ts:381`), which
  `http/serve.ts` reaches through `createSessionStore`
  (`packages/server/src/http/serve.ts:30,192`). Both files are outside this
  document's scope.
- Nothing outside `@clarvis/server` imports from `mcp/**` or `host/**`: no
  other package in the workspace depends on `@clarvis/server` at all (its
  `package.json` declares a `bin` and no `exports` map — it is a `bin`-only
  application package).

**Runtime vs. type-only:** the `@clarvis/kernel/policy` edge is a runtime
value import (functions called at request time). The `@clarvis/kernel/
bootstrap` edge in `packages/server/src/health/connection-health.ts:2` is `import type` only —
confirmed by the surrounding context implying `ConnectionEvent`/
`ConnectionEventSink` are consumed purely as parameter/field types in that
file's declarations (`:7` field, `:42,58` parameters).

## 8. Open questions

- **Why `clarvis_run`'s output schema uses `z.looseObject({})` for `usage`**
  beyond the one-line remark at `packages/server/src/mcp/tools.ts:93-96` ("a run's per-agent
  breakdown is an open shape"); the actual per-agent breakdown's real shape
  is defined in the kernel/protocol layer, outside this document's scope.
- **The full enumeration of `ConnectionEvent.state` values beyond
  `"unavailable"`.** §4.5 already establishes that the sink itself collapses
  every non-`"unavailable"` state into one `"recovered"` verb
  (`packages/server/src/health/connection-health.ts:58-67`, doc comment `:30-35`); what is not
  determinable from this document's scope is the full list of state strings
  the type actually admits, since `ConnectionEventSink`/`ConnectionEvent` are
  defined in `@clarvis/kernel/bootstrap`, owned by the kernel-composition
  document.
- **The exact shape and meaning of `RunResult.ended_reason` values other than
  the facade's own `"server_wall_clock_cap"`.** `packages/server/src/mcp/run-tool.ts:445-449` just
  forwards whatever the engine set; the vocabulary of engine-set reasons is
  outside this document's scope.
- **What `RunService.start`'s full contract looks like beyond `Pick<RunService,
  "start">`.** `RunHost` (`packages/server/src/host/run-host.ts:12-14`) deliberately narrows to that one
  method; the full `RunService` interface lives in `@clarvis/protocol`, whose
  detailed surface is a sibling concern.
- **Whether any test exercises `McpServerBundle.cancelAll` end-to-end through
  a real MCP transport** (as opposed to unit-level construction) — the
  component/integration test directories in `tests/` were enumerated by name
  (§ method) but `cancelAll`'s call sites in `bin.ts`'s shutdown path were not
  opened, since `bin.ts` is outside this document's `src/mcp`, `src/host`,
  `src/health` scope; the SIGTERM/SIGINT wiring that reaches it is at
  `packages/server/src/bin.ts:393-394` and is outside this document's scope.
- **The precise set of MCP logging levels versus MCP's full level vocabulary
  interaction** — `packages/server/src/mcp/event-view.ts:17-26` defines eight `ALL_LEVELS` including
  `critical`/`alert`/`emergency`, which `LogLevel` (five values, `:5`) never
  emits; whether a client can legitimately set `logging/setLevel` to one of
  those three unreachable-by-emission levels and what that implies is not
  something the code states a rationale for — `meetsThreshold`'s clamp
  (`:31`, `Math.min(idx, LEVEL_RANK.error)`) simply treats any level above
  `error` as equivalent to `error` for filtering purposes.

## 9. Compaction progress invariant

**INV-SM19.** A live `compaction_started` event projects to an `info` notification labeled
`context compaction started`, so a default-threshold MCP client receives positive progress before
the model-backed compaction can block on provider latency. The terminal event remains structured and
retains any `fallback_reason` supplied by the kernel.

Production: `viewOf`, `packages/server/src/mcp/event-view.ts` (`case "compaction_started"`).

Test: `packages/server/tests/unit/event-view.test.ts` (`projects compaction_started`).
