# The run-scoped child registry, buffers and steer queue

> Implemented at `packages/supervision/src/**` and `packages/supervision/tests/**`. Every claim
> below is anchored to a file and a named symbol or test. Open questions are collected in the final section.

## 1. Purpose

`@clarvis/supervision` is the run-scoped registry a parent observes and controls its spawned
children through: agent ids, a per-child activity buffer, a trace→activity-line projection, a
per-child steer queue, and the settings/limits that bound all of it
(`packages/supervision/src/index.ts`). It exists because two independent producers need to
register a child into **one** id space without importing each other: `@clarvis/loop`'s
`delegate_task` (a sub-agent) and `@clarvis/workflows`' `run_leader` (a leader)
(`packages/supervision/src/index.ts`). Both reach the registry only through
`@clarvis/capability`'s port mechanism, never by importing one another.

The package is deliberately substrate, not policy: it knows how to mint an id, buffer a child's
activity, project a trace record into a readable line, queue a steer, and register a background
child; it does not know what a model may ask for any of that. The five model-facing tools
(`agent_list`, `agent_poll`, `agent_stop`, `agent_steer`, `await_agents`) and the decision of *when*
a parent spawns into this registry belong to `@clarvis/loop` and are covered by the
[loop-delegation-and-subagents](../engine/delegation-and-subagents.md) document; a workflow leader's use of the registry belongs to
[workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md) (`packages/supervision/src/index.ts`).

Its only internal dependency is `@clarvis/capability`; `zod` is used solely inside `settings.ts`
(`packages/supervision/src/index.ts`, confirmed in `packages/supervision/package.json`
`dependencies`). That is the only runtime edge out of this package, and only two manifests in the
workspace declare an edge back in, so nothing later in the build order reaches it except through
`loop`/`workflows` (`packages/loop/package.json`, `packages/workflows/package.json`).

## 2. Surface

### 2.1 Exported entrypoint (`src/index.ts`, all re-exported from `.`)

| Symbol | Kind | File | What it is |
| --- | --- | --- | --- |
| `createAgentBuffer` | fn | `packages/supervision/src/buffer.ts` | builds a bounded per-child `AgentBuffer` |
| `AgentBufferRead`, `AgentBufferLimits`, `AgentBuffer` | type | `packages/supervision/src/buffer.ts` | one page read; line/byte ceilings; the buffer interface |
| `AGENT_REGISTRY_PORT` | const | `packages/supervision/src/agent-registry-port.ts` | `PortKey<AgentRegistry>` published under id `"supervision.agents"` |
| `AGENT_ID_PATTERN` | const | `packages/supervision/src/ids.ts` | `/^ag_[0-9a-f]{8}$/` |
| `mintAgentId` | fn | `packages/supervision/src/ids.ts` | mints a fresh, collision-checked `ag_` id |
| `resolveAgentsLimits` | fn | `packages/supervision/src/limits.ts` | folds a run request's `agents` param over `AGENTS_DEFAULTS` |
| `fromTraceEntry`, `fromTraceEvent` | fn | `packages/supervision/src/projection.ts` | normalize a nested `TraceEntry` or a flat wire `TraceEvent` into a `ProjectionSource` |
| `projectAgentEvent` | fn | `packages/supervision/src/projection.ts` | project one normalized record into a line, or `null` |
| `waitAgeSeconds` | fn | `packages/supervision/src/projection.ts` | age in whole seconds of a still-waiting elicitation |
| `ProjectionSource`, `ProjectionState` | type | `packages/supervision/src/projection.ts` | input shape; carried tag/wait state |
| `createAgentRegistry` | fn | `packages/supervision/src/registry.ts` | builds an `AgentRegistry` |
| `UnknownAgentError` | class | `packages/supervision/src/registry.ts` | `CodedError` (`code: "unknown_agent"`) for a `waitAny` naming an untracked id |
| `AgentsLimits`, `AgentListEntry`, `AgentPollResult`, `AgentStopResult`, `AgentNotice`, `AgentSettledInfo`, `AgentWait`, `AgentTeardownReport`, `AgentRegistryOptions`, `AgentRegistry` | type | `packages/supervision/src/registry.ts` | see §3 |
| `AGENTS_CAPABILITY_NAME` | const | `packages/supervision/src/settings.ts` | `"agents"` |
| `AGENTS_DEFAULTS` | const | `packages/supervision/src/settings.ts` | product defaults (§3.3) |
| `AGENTS_MAX_BUFFER_LINES` / `AGENTS_MAX_BUFFER_BYTES` | const | `packages/supervision/src/settings.ts` | `10_000` / `8_388_608` |
| `AGENTS_MAX_TOTAL_BUFFER_BYTES` | const | `packages/supervision/src/settings.ts` | `33_554_432` |
| `AGENTS_MAX_LIVE_CHILDREN` | const | `packages/supervision/src/settings.ts` | `32` |
| `AGENTS_MAX_RETAINED_CHILDREN` | const | `packages/supervision/src/settings.ts` | `64` |
| `AGENTS_SETTINGS_FIELDS` | const | `packages/supervision/src/settings.ts` | the `agents:` `settings.json` field map |
| `AGENTS_REQUEST_PARAMS` | const | `packages/supervision/src/settings.ts` | the per-run `agents` override field map |
| `agentsSettingsSpec` | const | `packages/supervision/src/settings.ts` | the `CapabilitySettingsSpec` registration entry |
| `registerBackgroundChild` | fn | `packages/supervision/src/spawn-child.ts` | shared register-a-background-child skeleton |
| `BackgroundChildSpec`, `BackgroundChildSpawn`, `BackgroundChildRegistered` | type | `packages/supervision/src/spawn-child.ts` | spec in / three handles out / optional producer-accounting callback |
| `createSteerQueue` | fn | `packages/supervision/src/steer-queue.ts` | builds an empty `SteerQueue` |
| `SteerQueue` | type | `packages/supervision/src/steer-queue.ts` | `SteerSource` extended with `push`/`undrained`/`close` |

### 2.2 `AgentRegistryPort` — the producer-only slice (`@clarvis/capability`)

Declared in `packages/capability/src/agents-port.ts` and `extends`-ed by the full `AgentRegistry`
(`packages/supervision/src/registry.ts`), so a producer that only needs to register a child can
depend on the narrower port type:

| Member | Signature | Cited at |
| --- | --- | --- |
| `register` | `(registration: AgentRegistration) => AgentHandle \| null` | `packages/capability/src/agents-port.ts` |
| `adopt` | `(id: string, task: Promise<unknown>) => void` | `packages/capability/src/agents-port.ts` |
| `liveCount` | `() => number` | `packages/capability/src/agents-port.ts` |

`AgentHandle` (`packages/capability/src/agents-port.ts`) is what a producer holds after registering: `id`,
`ingest(event: TraceEvent)`, `waiting(on: WaitingOn)`, `settled(settlement: AgentSettlement)`. A
sub-agent producer never calls `ingest` — its activity is routed automatically off the run's own
trace by `ingestTraceEntry` (`packages/capability/src/agents-port.ts`, `packages/supervision/src/registry.ts`); a leader producer
forwards its own `executeRun`'s trace through it.

`AGENT_REGISTRY_PORT` actually round-trips through `@clarvis/capability`'s
`createCapabilityServices`/`services.provide`/`services.get` — a full `AgentRegistry` provided under
the port is retrievable as itself, not merely as the narrower `AgentRegistryPort` shape — pinned end
to end by `packages/supervision/tests/unit/agent-registry-port.test.ts`.

### 2.3 `AgentRegistry` — the full surface (`packages/supervision/src/registry.ts`)

| Member | Signature | Cited at |
| --- | --- | --- |
| `list()` | `() => AgentListEntry[]` | `packages/supervision/src/registry.ts` |
| `has(id)` | `(id: string) => boolean` | `packages/supervision/src/registry.ts` |
| `poll(id, opts)` | `(id, { offset?, match? }) => AgentPollResult \| null` | `packages/supervision/src/registry.ts` |
| `stop(id, reason)` | `(id, string) => AgentStopResult \| null` | `packages/supervision/src/registry.ts` |
| `steer(id, message)` | `(id, SteerMessage) => { ok, status } \| null` | `packages/supervision/src/registry.ts` |
| `waitAny(ids?)` | `(readonly string[]?) => AgentWait` | `packages/supervision/src/registry.ts` |
| `liveIds()` | `() => string[]` | `packages/supervision/src/registry.ts` |
| `ingestTraceEntry(entry)` | `(TraceEntry) => void` | `packages/supervision/src/registry.ts` |
| `takeNotices()` | `() => AgentNotice[]` | `packages/supervision/src/registry.ts` |
| `failingStreakExceeded()` | `() => boolean` | `packages/supervision/src/registry.ts` |
| `seal()` / `sealed()` | `() => void` / `() => boolean` | `packages/supervision/src/registry.ts` |
| `teardown(graceMs)` | `(number) => Promise<AgentTeardownReport>` | `packages/supervision/src/registry.ts` |

Plus the `AgentRegistryPort` members inherited.

### 2.4 `settings.json` block and per-run request param

| Field | Default | Schema bound | Cited at |
| --- | --- | --- | --- |
| `buffer_lines` | `2000` | `1..10_000` int | `packages/supervision/src/settings.ts` |
| `buffer_bytes` | `1_048_576` | `1..8_388_608` int | `packages/supervision/src/settings.ts` |
| `max_total_buffer_bytes` | `33_554_432` | `1..33_554_432` int | `packages/supervision/src/settings.ts` |
| `poll_max_bytes` | `65_536` | `1..65_536` int | `packages/supervision/src/settings.ts` |
| `await_timeout_ms` | `120_000` | `1..600_000` int | `packages/supervision/src/settings.ts` |
| `max_live_children` | `8` | `1..32` int | `packages/supervision/src/settings.ts` |
| `max_retained_children` | `64` | `1..64` int | `packages/supervision/src/settings.ts` |
| `max_notices_per_iteration` | `8` | positive int, no upper bound | `packages/supervision/src/settings.ts` |
| `max_consecutive_failed_children` | `3` | nonnegative int, no upper bound | `packages/supervision/src/settings.ts` |
| `finish_nudges` | `2` | nonnegative int, no upper bound | `packages/supervision/src/settings.ts` |

`agentsConfigSchema` is `.strict()` (`packages/supervision/src/settings.ts`), so an unknown key is rejected rather than
ignored (pinned by `packages/supervision/tests/unit/settings.test.ts`). It is exposed twice
from the same object: as `AGENTS_SETTINGS_FIELDS.agents` (optional, unfilled when absent — pinned at
`packages/supervision/tests/unit/settings.test.ts`) for `settings.json`, and as `AGENTS_REQUEST_PARAMS.agents` (`.partial()`,
still filling every omitted field from the same defaults — pinned at `packages/supervision/tests/unit/settings.test.ts`) for a
run request's `agents` param (`AgentsParam` in `packages/capability/src/api.ts`). There is
**no on/off field**: the settings comment states the surface follows from whether the run's entry
agent can spawn at all, not from a flag (`packages/supervision/src/settings.ts`, `packages/capability/src/api.ts`).

`agentsSettingsSpec` registers under key `"agents"`, `merge: "lastWins"`,
`pluginContributable: false` (`packages/supervision/src/settings.ts`, pinned at `packages/supervision/tests/unit/settings.test.ts`) — the
in-code comment states the reason: "a plugin must not be able to raise a ceiling that exists to
protect the run it is running inside" (`packages/supervision/src/settings.ts`).

## 3. Data and formats

### 3.1 Agent ids

`mintAgentId(taken)` returns `"ag_" + randomUUID().replace(/-/g, "").slice(0, 8)`, redrawing while
the candidate is in `taken` (`packages/supervision/src/ids.ts`). `AGENT_ID_PATTERN` is
`/^ag_[0-9a-f]{8}$/` (`packages/supervision/src/ids.ts`); 200 consecutive mints are pinned unique and pattern-matching
(`packages/supervision/tests/unit/ids.test.ts`), and the retry branch is exercised directly with
a `Set` subclass whose `has()` reports the first candidate as already taken
(`packages/supervision/tests/unit/ids.test.ts`). Uniqueness is scoped to one run's one registry — the doc comment states this
is why 8 hex digits are treated as ample rather than birthday-bound (`packages/supervision/src/ids.ts`).

### 3.2 `ChildRecord` (internal, `packages/supervision/src/registry.ts`)

One record per registered child: `id`, `kind` (`"subagent" | "leader"`), `nativeId` (the producer's
own id — a `subagent_instance_id` or a `run_id`), `title`, optional `profile`, `status`
(`AgentStatus`), `waitingOn` (`WaitingOn`), `startedAt`/`lastActivityAt` (epoch ms), `iterations`,
`tokens`, `result` (`string | null`), its own `AgentBuffer`, a `ProjectionState`, its producer's
`AgentControl`, and an optional adopted `task` promise.

`AgentStatus` is `"running" | "waiting" | "completed" | "failed" | "stopped" | "cancelled"`
(`packages/capability/src/agents-port.ts`), and `SettledStatus` is the terminal subset
excluding `"running" | "waiting"` (`packages/capability/src/agents-port.ts`). `WaitingOn` is `"elicitation" | null`
(`packages/capability/src/agents-port.ts`).

### 3.3 `AGENTS_DEFAULTS` (`packages/supervision/src/settings.ts`)

```
{
  buffer_lines: 2000,
  buffer_bytes: 1_048_576,
  max_total_buffer_bytes: 33_554_432,
  poll_max_bytes: 65_536,
  await_timeout_ms: 120_000,
  max_live_children: 8,
  max_retained_children: 64,
  max_notices_per_iteration: 8,
  max_consecutive_failed_children: 3,
  finish_nudges: 2,
}
```

### 3.4 `AgentListEntry` (one `agent_list` row, `packages/supervision/src/registry.ts`)

`id`, `kind`, `native_id`, optional `profile`, `title`, `status`, `started_at`, `iterations`,
`tokens`, `waiting_on`, optional `waiting_for_s` (present only while `waiting_on !== null` and a wait
age is known — `packages/supervision/src/registry.ts`), `last_activity_ms` (computed as `now - lastActivityAt` at read
time —).

### 3.5 `AgentPollResult` (`packages/supervision/src/registry.ts`) / `AgentStopResult`

`AgentPollResult`: `id`, `running` (`isLive`), `status`, `output` (the buffer page's text plus a
`"\n[... more output buffered; continue with offset=N...]"` marker appended when `read.more`
—), `next_offset`, `truncated_head`, `result`.

`AgentStopResult`: `id`, `status`, `tail` (the last `TAIL_BYTES = 2048` bytes of the buffer, read
after settlement — `packages/supervision/src/registry.ts`), `iterations`, `tokens`, `already_settled`.

### 3.6 `AgentBufferRead` (one page, `packages/supervision/src/buffer.ts`)

`text` (newline-joined, no trailing newline), `nextOffset` (absolute byte offset to resume from),
`more` (true when unread content remains past `nextOffset`), `truncatedHead` (bytes the caller asked
for that had already been dropped, `0` when none). `truncatedHead` reads `0` once a caller's own
`offset` is at or past `head()` — the steady-state case of a caller that has fully caught up
(`packages/supervision/src/buffer.ts`; pinned `packages/supervision/tests/unit/buffer.test.ts`, "reports no
truncated head once the caller has caught up past the drop").

### 3.7 Trace record kinds this package reads or writes

`registerBackgroundChild` writes exactly one trace kind, `agent_registered`
(`registerBackgroundChild` in `packages/supervision/src/spawn-child.ts`), whose detail shape (`AgentRegisteredDetail`) is declared once in
`@clarvis/capability`: `agent_id`, `kind: "subagent" | "leader"`, `native_id`, `title`, optional
`profile`, `background: boolean` (`packages/capability/src/trace-kinds.ts`). Three sibling
kinds — `agent_stopped`, `agent_steered`, `agent_finish_nudge` — are declared in the same open
`BuiltinTraceKind` union (`packages/capability/src/trace-kinds.ts`) but are **not** emitted anywhere in this
package's `src/`; their producer is outside this document's scope (see §8).

`projectAgentEvent` reads (but does not write) trace vocabulary by string `kind`/`type` switch:
`lead_iteration_started`/`subagent_iteration_started`, `lead_iteration`/`subagent_iteration`,
`tool_call`, `delegation_created`, `workflow_run_started`, `elicitation_requested`, `user_question`,
`user_steering`, `cancellation`, `model_call_error`, `terminate`, `run_ended`
(`packages/supervision/src/projection.ts`); every other kind — explicitly including the high-frequency
`model_stream_delta`/`tool_output_delta` (pinned at
`packages/supervision/tests/unit/projection.test.ts`) and the bookkeeping
`compaction`/`budget_check`/`tool_call_started`/`init` (pinned at `packages/supervision/tests/unit/projection.test.ts`) —
projects to `null` (`packages/supervision/src/projection.ts`).

### 3.8 A worked projected line

From `packages/supervision/tests/unit/projection.test.ts`, a `tool_call` entry
`{ name: "read_file", arguments: { path: "src/a.ts" }, result: "x".repeat(3174), error: null }` at
`lastIteration: 2` projects to:

```
[i2] tool read_file {path:"src/a.ts"} → ok 3.1kB
```

An elicitation opens with `[i3] elicit "may I run bun install?" — WAITING`
(`packages/supervision/tests/unit/projection.test.ts`) and its resolution closes with
`[i3] elicit resolved: accept after 42s`.

## 4. Behavior

### 4.1 Registration (`packages/supervision/src/registry.ts`)

1. Count live children (`status === "running" || "waiting"`, `isLive`).
2. If `isSealed`, log `agents.spawn_refused` with `reason: "sealed"` and return `null`.
3. Else if `live >= maxLiveChildren`, log the same event with `reason: "at_capacity"` and return
   `null` — **the registry refuses a spawn past the ceiling; it never queues it**
   (pinned at `packages/supervision/tests/component/registry.test.ts`).
4. Otherwise mint an id, build the `ChildRecord` with a fresh `AgentBuffer` sized by
   `bufferBytesPerChild` (§4.5), store it in `records`/`byNative`/`order`, and return its
   `AgentHandle`.

### 4.2 Producing activity (two paths, `packages/supervision/src/registry.ts`)

- **Sub-agent path**: the run's own trace entries are routed by `ingestTraceEntry(entry)`, which
  reads `entry.detail.subagent_instance_id`, looks it up in `byNative`, and — only for a match —
  appends the projected line and, for a `subagent_iteration` builtin entry, folds
  `iterations`/`tokens`. An entry naming no registered native id is silently ignored
  (pinned at `packages/supervision/tests/component/registry.test.ts`).
- **Leader path**: the leader's producer calls `handle.ingest(event)` directly with its own forwarded
  wire `TraceEvent`s; the same projection and the same `lead_iteration`/`subagent_iteration` folding
  logic applies (pinned at `packages/supervision/tests/component/registry.test.ts`, including that a forwarded
  iteration count never rewinds — `Math.max(r.iterations, event.iteration)`, pinned at
  `packages/supervision/tests/component/registry.test.ts`).

Every append calls `touch(r)`, which stamps `lastActivityAt = Date.now()` and calls the optional
`onActivity` callback — the doc comment on `AgentRegistryOptions.onActivity` states this
exists so an orchestrator can poke its own compute-clock stall watchdog, because a leader's events
land on the leader's own trace and would otherwise never reach it (pinned at
`packages/supervision/tests/component/registry.test.ts`).

### 4.3 Waiting / settlement (`AgentHandle.waiting`, `.settled`, `packages/supervision/src/registry.ts`)

| State transition | Effect |
| --- | --- |
| `waiting(on)` while live, `on !== null` | `status = "waiting"`, `waitingOn = on`, `touch(r)` |
| `waiting(null)` while live | `status = "running"`, `waitingOn = null`, clears `projection.waitingSince`, `touch(r)` |
| `waiting(...)` once settled | no-op (`isLive` guard; pinned `packages/supervision/tests/component/registry.test.ts`) |
| `settled(s)` while live | `status = s.status`, `waitingOn = null`, `result = s.result ?? null`, folds `iterations`/`tokens` if given, resets/increments `consecutiveFailures`, pushes a notice, wakes every matching `waitAny` waiter, calls `evictRetained()` |
| `settled(...)` once already settled | no-op, idempotent (`isLive` guard) |

The notice text is `` `[agents] ${id} (${kind} "${title}") ${status}${": " + result.slice(0,400) if given}` ``
and `progress` is `true` **only** for `status === "completed"` — a `failed` settle or a still-waiting
report is not progress, so a doomed run cannot be kept alive by them (doc comment
pinned `packages/supervision/tests/component/registry.test.ts`).

### 4.4 `agent_stop` / `agent_steer` (`packages/supervision/src/registry.ts`)

- `stop(id, reason)`: if already settled, reports `already_settled: true` without touching the
  child's control port again (pinned `packages/supervision/tests/component/registry.test.ts`); otherwise it calls
  `r.control.stop(reason)` (swallowing and logging a throw as `agents.stop_port_threw`, phase
  `"stop"` — pinned `packages/supervision/tests/component/registry.test.ts`), then settles it as
  `{ status: "stopped", result: "stopped by parent: <reason>" }`. The buffer is **not**
  cleared by a stop — it stays fully readable afterward (pinned
  `packages/supervision/tests/component/registry.test.ts`, `"(D9)"`).
- `steer(id, message)`: refuses with `{ ok: false, status }` and logs `agents.steer_refused` when
  the child is not live or when `r.control.steer(message)` itself returns `false`; otherwise it `touch(r)`es and returns `{ ok: true, status }`. Neither
  case throws — a steer to any non-receiving child is a plain result (pinned
  `packages/supervision/tests/component/registry.test.ts`).

### 4.5 Buffer sizing across live and retained slots (`packages/supervision/src/registry.ts`)

```
maxLiveChildren      = clamp(limits.maxLiveChildren, 0, AGENTS_MAX_LIVE_CHILDREN)
maxRetainedChildren  = max(1, clamp(limits.maxRetainedChildren, 0, 64))
maxTotalBufferBytes  = clamp(limits.maxTotalBufferBytes, 0, AGENTS_MAX_TOTAL_BUFFER_BYTES)
configuredBufferBytes = max(0, floor(limits.bufferBytes)) or 0 if non-finite
bufferBytesPerChild  = min(configuredBufferBytes,
                            floor(maxTotalBufferBytes / (maxLiveChildren + maxRetainedChildren)))
```

The lower bound on `maxLiveChildren` is `0`, not the schema's own positive-integer minimum of `1` —
the in-code comment states this is deliberate: "Programmatic test/host callers historically use zero
to close admission completely even though settings require a positive live ceiling". That
value is reachable only by a programmatic/test caller bypassing `agentsConfigSchema`, whose own
`max_live_children` field is `.positive()` (`packages/supervision/src/settings.ts`).

Every child — live or retained — reserves the **same** fixed slice up front, which the in-code
comment states is what makes the aggregate ceiling independent of settlement/registration ordering. Pinned at the boundary: with `bufferBytes: 1000, maxTotalBufferBytes: 50,
maxLiveChildren: 2, maxRetainedChildren: 3` the per-child slice is `floor(50/5) = 10` and the summed
retained bytes across all 5 children never exceeds 50 (`packages/supervision/tests/component/registry.test.ts`); at the schema
maximum (`maxTotalBufferBytes: 96, maxLiveChildren: 32, maxRetainedChildren: 64`) the slice is
exactly `1` byte per child and 96 children retain exactly 96 bytes total, with a 97th spawn refused
(`packages/supervision/tests/component/registry.test.ts`).

### 4.6 Retention eviction (`evictRetained`, `packages/supervision/src/registry.ts`)

Called on every `settle`. Filters `order` to settled (non-live) ids, and while
`settled.length - maxRetainedChildren > 0`, deletes the **oldest-registered** settled record from
`records`, `byNative` and `order` — a live child is never a candidate, because the filter excludes
it (pinned `packages/supervision/tests/component/registry.test.ts`, which shows the oldest of four settled children
evicted while a fifth, live, child survives untouched).

### 4.7 Notices (`takeNotices`, `packages/supervision/src/registry.ts`)

Caps the queued notices at `max(1, limits.maxNoticesPerIteration)` per call; when more were queued,
the shown slice is truncated and a synthetic trailing notice
`` `[agents] +${hidden} more child updates this turn; call agent_list to see them all.` `` (with
`progress: false`) is appended (pinned `packages/supervision/tests/component/registry.test.ts`).

### 4.8 Failing-streak (`failingStreakExceeded`, `packages/supervision/src/registry.ts`)

`consecutiveFailures` increments on a `"failed"` settle and resets to `0` on a `"completed"` one. `failingStreakExceeded()` is true once `maxConsecutiveFailedChildren > 0` **and**
`consecutiveFailures >= maxConsecutiveFailedChildren` — a `0` limit disables the check
entirely rather than tripping on the first failure (pinned by the schema admitting `0` at
`packages/supervision/tests/unit/settings.test.ts`, and behaviourally at
`packages/supervision/tests/component/registry.test.ts`, which walks 2 failures → not exceeded, a 3rd → exceeded, then a success →
reset).

### 4.9 `waitAny` (`packages/supervision/src/registry.ts`)

1. If `ids` is given, first reject with `UnknownAgentError` **immediately** if any named id is not
   tracked at all — before consulting liveness for any of them (pinned
   `packages/supervision/tests/component/registry.test.ts`).
2. Else if any named id is already settled, resolve **immediately** with that child's
   `AgentSettledInfo`, checked in the caller's own `ids` order so the first-listed already-settled
   child wins (pinned `packages/supervision/tests/component/registry.test.ts`, `b` before `a` in argument order).
3. Otherwise register a listener in `waiters`, scoped to `ids` (or unscoped) via a closed-over
   `Set`; a settle outside the scope re-adds the same listener rather than resolving
   (pinned `packages/supervision/tests/component/registry.test.ts`). `dispose()` removes the listener so a lost race
   leaves nothing behind (pinned `packages/supervision/tests/component/registry.test.ts`).

### 4.10 Teardown (`packages/supervision/src/registry.ts`)

1. Seal the registry (`isSealed = true`) so no further registration can land mid-teardown.
2. Call `control.stop("the run is finishing")` on every still-live record, logging (not throwing on)
   a port that throws as `agents.stop_port_threw`, phase `"teardown"`.
3. If any adopted task is still outstanding, race `Promise.allSettled([...tasks])` against a grace
   timer (`scheduleTimeout`, default an unref'ed `setTimeout`) and cancel the timer either way
   (the grace timer is a deterministic test seam via `AgentRegistryOptions.scheduleTimeout`,
   pinned at `packages/supervision/tests/component/registry.test.ts`, which fires the timer manually to prove teardown gives up at
   the bound rather than hanging).
4. For every record still live after the race, settle it as
   `{ status: "cancelled", result: "abandoned when the run finished" }` and record its id in
   `abandoned`; for every record, sum `control.undrained?.() ?? 0` into
   `undrainedSteers` and `freeze()` its buffer.
5. Clear `notices` and every remaining `waiters` entry.
6. If anything was abandoned or any steer went undrained, log one `agents.teardown_abandoned`
   warning naming the abandoned ids, the undrained count, the grace and the task count
   (pinned `packages/supervision/tests/component/registry.test.ts` for the warning shape, and
   `packages/supervision/tests/component/registry.test.ts` for silence when nothing was abandoned).

An adopted task's own rejection is caught and logged (`"agents: background child task rejected"`)
before it is ever awaited by teardown's `Promise.allSettled`, and the tracked/derived promise chain
is explicitly passed through `suppressSecondaryRejection` so the same rejection can never also
surface as an unhandled rejection on the `tasks` set's cleanup `.finally()` (`packages/supervision/src/registry.ts`;
pinned `packages/supervision/tests/component/registry.test.ts`).

### 4.11 `registerBackgroundChild` (`packages/supervision/src/spawn-child.ts`)

The shared skeleton both `delegate_task` and `run_leader` call into:

1. Build a fresh `AbortController` and `SteerQueue`.
2. Call `agents.register(...)` with a `control` object wired to them: `stop` aborts the controller
   with `new Error(reason)` as the abort reason, `steer` pushes onto the queue,
   `undrained` reports `steerQueue.undrained().length`.
3. If `register` returned `null`, return `null` and record nothing (pinned
   `packages/supervision/tests/component/spawn-child.test.ts`) — "a producer must treat `null` as 'do not spawn'" (doc comment
   on `registerBackgroundChild`).
4. Otherwise invoke the optional `onRegistered` callback with the three handles, then record one
   `agent_registered` trace entry with `background: true`, omitting `profile` entirely (not as
   `undefined`) when the spec carried none, and return `{ handle, controller, steerQueue }`.
5. If producer accounting or trace publication throws after registry acceptance, abort the
   controller, settle the handle `failed`, close its steer queue and rethrow the original error. The
   child is therefore no longer live or adoptable when the producer's catch runs.

Production: `registerBackgroundChild` in `packages/supervision/src/spawn-child.ts`. Tests:
`packages/supervision/tests/component/spawn-child.test.ts` (`omits profile entirely rather than
registering it as undefined`; `commits producer accounting before trace publication and abandons
the child if it throws`).

### 4.12 Buffer append and eviction (`packages/supervision/src/buffer.ts`)

`createAgentBuffer` closes over an array of `Line | undefined` slots plus a `first` head-index, so a
drop does not `splice` the array on every eviction:

1. `append(line)` strips a trailing newline, computes `originalStart = tail`, and advances `tail` by
   `textBytes + 1` **before** any truncation happens — the newline is charged to the absolute offset
   space even though a read never shows it.
2. If the buffer's own configured `maxBytes` is `0`, the whole ring is dropped immediately and `head`
   jumps to `tail` — a per-child hard "no capture" mode.
3. Otherwise `retainUtf8Tail` keeps the newest UTF-8-safe tail of the line within `maxBytes - 1` bytes,
   reserving one byte for the newline. If that retain dropped any bytes, **every older
   line is discarded** (`lines.length = 0; first = 0; held = 0`) so the just-retained line becomes the
   new head and `truncatedHead` accounts for all of the now-unavailable bytes rather than leaving an
   invisible gap behind an older line (pinned by
   `packages/supervision/tests/unit/buffer.test.ts`, "does not hide an oversized line's
   dropped prefix behind an older retained line").
4. The line is pushed and `held` updated, then `evict()` drops from the front while
   `lines.length - first > maxLines || held > maxBytes`, recomputing `head` from
   `lines[first]?.start ?? tail` each time (pinned by `packages/supervision/tests/unit/buffer.test.ts`, "the byte
   bound evicts oldest-first and keeps at least the newest line").
5. `evict()` only physically compacts the backing array — `lines.splice(0, first); first = 0` — once
   `first >= 1024 && first * 2 >= lines.length`, so steady-state eviction is O(1) index-bumping and
   dropped strings still stop being referenced periodically rather than never (pinned by
   `packages/supervision/tests/unit/buffer.test.ts`, "compacts dropped slots without losing the newest lines", which appends
   5000 lines against `maxLines: 3`).

`read(offset, budget, match?)` clamps its own two arguments defensively before doing anything else:
`want` falls back to `0` when `offset` is non-finite, and `budget` is floored through
`finiteIntAtMost(budget, 1, 65_536)` — independent of the constructor-side clamp on
`maxLines`/`maxBytes`. Pinned by three tests: "an offset past the tail returns nothing
and parks at the tail" (`packages/supervision/tests/unit/buffer.test.ts`), "a mid-line offset clamps up to the next boundary
rather than re-emitting a partial line", and "bounds non-finite programmatic cursors and
page budgets" (asserting `buf.read(NaN, Infinity).text === "f"`).

## 5. Invariants

The invariants below are derived directly from this package's own code and tests.

1. **A well-formed `agent_id` is exactly `ag_` + 8 lowercase hex digits, nothing else.**
   Production: `packages/supervision/src/ids.ts`. Test:
   `packages/supervision/tests/unit/ids.test.ts`.
2. **A registration never blocks or queues past the live-children ceiling — it is refused outright,
   with the refusal logged and its reason distinguished (`sealed` vs `at_capacity`).**
   Production: `packages/supervision/src/registry.ts`. Test: `packages/supervision/tests/component/registry.test.ts`.
3. **A settled child's slot is reusable immediately** (a spawn refused at capacity succeeds once the
   occupying child settles, with no other state change required). Production: `packages/supervision/src/registry.ts`
   interacting with. Test: `packages/supervision/tests/component/registry.test.ts`.
4. **Reads and writes against an id from a different registry are a plain `null`/refusal, never a
   throw**, except `waitAny` naming an explicitly-unknown id, which rejects with `UnknownAgentError`.
   Production: `packages/supervision/src/registry.ts`. Test: `packages/supervision/tests/component/registry.test.ts`.
5. **A settle is idempotent: the first one wins, and a later `settled`/`waiting` call on an already
   -settled child is a no-op.** Production: the `isLive` guard at `packages/supervision/src/registry.ts`. Test:
   `packages/supervision/tests/component/registry.test.ts`.
6. **A stop or teardown never clears a settled child's buffer** — a parent can still read exactly
   what the child produced up to the moment it was ended. Production: `packages/supervision/src/registry.ts` (no
   buffer mutation on the settle path) (`freeze()`, which stops future appends but leaves
   existing content readable — `packages/supervision/src/buffer.ts`). Test: `packages/supervision/tests/component/registry.test.ts` (labelled `(D9)` in
   both the production comment `packages/supervision/src/buffer.ts` and the test name), and `buffer.test.ts` (the `(D9)`
   describe block, "freeze keeps existing content readable but stops accepting appends").
7. **The aggregate retained-buffer budget across every live and retained child never exceeds
   `maxTotalBufferBytes`, independent of registration/settlement order**, because each child reserves
   an equal fixed slice — `floor(maxTotalBufferBytes / (maxLiveChildren + maxRetainedChildren))` —
   at construction rather than a shared pool consumed on a first-come basis. Production:
   `packages/supervision/src/registry.ts`. Test: `packages/supervision/tests/component/registry.test.ts` (order: settled children written
   before live ones) (at the schema-maximum combination, 96 children retain exactly 96
   bytes and a 97th spawn is refused).
8. **A buffer read never splits a line, so a page boundary can never land inside a multi-byte UTF-8
   sequence.** Production: `packages/supervision/src/buffer.ts` (doc comment), the line-granular `read()` loop
   (`packages/supervision/src/buffer.ts`) and `retainUtf8Tail`/`truncateUtf8Prefix`'s code-point-boundary walks. Test:
   `packages/supervision/tests/unit/buffer.test.ts` ("a page boundary falls between lines: a
   multibyte line is never half-emitted", "always emits at least one line, truncating an oversized
   one at a code-point boundary", "retains only the UTF-8-safe tail of one oversized line").
9. **Buffer offsets are absolute over the whole stream a child has ever produced, monotonic, and
   never rewind on a head drop.** Production: `packages/supervision/src/buffer.ts` (doc comment), `head`/`tail` closures
   (`registry` of `packages/supervision/src/buffer.ts`). Test: `buffer.test.ts` ("offsets are absolute over the whole
   stream…", "a head drop raises head and never rewinds tail…").
10. **A forwarded iteration counter can only advance, never rewind, even when events arrive
    out of order.** Production: `packages/supervision/src/registry.ts` (`Math.max(r.iterations, …)`). Test:
    `packages/supervision/tests/component/registry.test.ts` (a later-arriving lower iteration number is ignored).
11. **A `progress` notice requires a `"completed"` settle; a `"failed"` settle or a still-waiting
    report never counts as progress**, so a run whose children only ever fail cannot be kept alive by
    its own notices. Production: `packages/supervision/src/registry.ts` (`progress: s.status === "completed"`). Test:
    `packages/supervision/tests/component/registry.test.ts`.
12. **A `settings.json`/request `agents` block rejects any key outside the schema rather than
    silently ignoring a typo, and every numeric bound is capped at its named ceiling constant**
    (`AGENTS_MAX_BUFFER_LINES`, `AGENTS_MAX_BUFFER_BYTES`, `AGENTS_MAX_TOTAL_BUFFER_BYTES`,
    `AGENTS_MAX_LIVE_CHILDREN`, and a literal `64` for `max_retained_children`). Production:
    `packages/supervision/src/settings.ts`. Test: `packages/supervision/tests/unit/settings.test.ts`.
13. **The `agents` capability settings block is not plugin-contributable and merges last-wins.**
    Production: `packages/supervision/src/settings.ts`. Test: `packages/supervision/tests/unit/settings.test.ts`.
14. **`resolveAgentsLimits` treats an empty request `agents` object identically to an absent one, and
    a partial override merges field-by-field over the product defaults rather than replacing the
    whole block** — including that an explicit `0` is honoured rather than read as "unset".
    Production: `packages/supervision/src/limits.ts`. Test: `packages/supervision/tests/unit/limits.test.ts`.
15. **`registerBackgroundChild` makes registry acceptance atomic with producer accounting and trace
    publication.** A declined registration records and accounts nothing; an accepted registration
    invokes `onRegistered` before `agent_registered`, omits an absent `profile`, and any callback or
    trace failure leaves the handle settled rather than live and unadopted. Production:
    `registerBackgroundChild` in `packages/supervision/src/spawn-child.ts`. Test:
    `packages/supervision/tests/component/spawn-child.test.ts` (`returns null and records nothing
    when the registry declines`; `commits producer accounting before trace publication and abandons
    the child if it throws`).
16. **A closed `SteerQueue` still allows an already-queued message to be drained** — closing never
    discards what a child could still take, it only refuses new pushes. Production:
    `packages/supervision/src/steer-queue.ts` (`push` checks `closed`; `drain` is unconditional). Test:
    `packages/supervision/tests/unit/steer-queue.test.ts`.

## 6. Failure modes and degradation

| Condition | Handling | Cited at |
| --- | --- | --- |
| Registration while sealed | `null` return, `agents.spawn_refused` debug log, reason `"sealed"` | `packages/supervision/src/registry.ts` |
| Registration at the live-children ceiling | `null` return, same log, reason `"at_capacity"` | `packages/supervision/src/registry.ts` |
| Producer accounting or `agent_registered` trace publication throws after registry acceptance | Accepted child is aborted, settled `failed` and closed, then the original error is rethrown; no live unadopted handle remains | `registerBackgroundChild`; component test `commits producer accounting before trace publication and abandons the child if it throws` |
| `poll`/`stop`/`steer`/`has` on an unknown id | `null` (or `false` for `has`) — courtesy, not a throw, because a grandchild's id structurally cannot exist in this registry (doc comment `packages/supervision/src/registry.ts`) | `packages/supervision/src/registry.ts` |
| `waitAny` naming an id this registry never tracked | rejects the returned promise with `UnknownAgentError` (`code: "unknown_agent"`) | `packages/supervision/src/registry.ts` |
| A child's `control.stop`/`control.steer` port throws | caught, logged as `agents.stop_port_threw` (phase `"stop"` or `"teardown"`), the child is settled regardless of the throw | `packages/supervision/src/registry.ts` |
| A steer to a non-live or refusing child | `{ ok: false, status }`, logged as `agents.steer_refused`, never an exception | `packages/supervision/src/registry.ts` |
| An adopted background task rejects | caught and logged (`"agents: background child task rejected"`); never escapes as an unhandled rejection, via `suppressSecondaryRejection` on the derived promise | `packages/supervision/src/registry.ts` |
| Teardown outlives its grace window | the wait is bounded by a race against `scheduleTimeout`; whatever is still live past the grace is force-settled `"cancelled"` and reported in `abandoned` | `packages/supervision/src/registry.ts` |
| Notices exceeding `maxNoticesPerIteration` | truncated with a synthetic `"+N more…"` trailing notice (`progress: false`) rather than delivering all of them | `packages/supervision/src/registry.ts` |
| Non-finite / out-of-range programmatic limits (`maxLines`, `maxBytes`, `maxLiveChildren`, etc.) | every numeric limit is clamped through a `finite → fallback/max` guard rather than propagating `NaN`/`Infinity` into arithmetic | `packages/supervision/src/buffer.ts`, `packages/supervision/src/registry.ts` |
| Non-finite / out-of-range programmatic cursor or page budget passed to `AgentBuffer.read` | `offset` falls back to `0` when non-finite; `maxBytes` is clamped through `finiteIntAtMost(budget, 1, 65_536)` — independent of the buffer's own constructor-side clamp | `packages/supervision/src/buffer.ts` (test: `packages/supervision/tests/unit/buffer.test.ts`) |
| A single line larger than the byte budget | the newest UTF-8-safe tail is kept (`retainUtf8Tail`) and the dropped prefix is charged to `truncatedHead`; because the drop clears the whole prior ring rather than leaving an interior gap behind an older retained line, the retained line becomes the new head; a code point that cannot fit at all is dropped entirely rather than split | `packages/supervision/src/buffer.ts` (test: `packages/supervision/tests/unit/buffer.test.ts` for the single-line case for "does not hide an oversized line's dropped prefix behind an older retained line") |
| A normal multi-line eviction under a tight byte cap, no oversized line involved | the byte bound evicts oldest-first and keeps at least the newest line | `packages/supervision/src/buffer.ts` (test: `packages/supervision/tests/unit/buffer.test.ts`) |
| `maxBytes === 0` on append | the whole ring is cleared and the offset still advances — the child produces no readable output but the stream stays consistent | `packages/supervision/src/buffer.ts` |

Nothing in this package retries a failed operation. Registry/control failures resolve synchronously
to a courtesy value (`null`, a refusal object, or a settled/logged state); an explicit `waitAny`
miss rejects with `UnknownAgentError`, and a producer callback or trace-sink exception is rethrown
only after its accepted child has been made terminal.

## 7. Coupling

**Depends on**: only `@clarvis/capability` at runtime (`packages/supervision/package.json`,
whose `dependencies` list it beside `zod` and nothing else) — for `portKey`/`PortKey`
(`packages/capability/src/services.ts`), the `CodedError` base
(used by `UnknownAgentError`), `NOOP_LOGGER`/`Logger` (`packages/capability/src/log.ts`),
`unref` (`packages/capability/src/unref.ts`), `suppressSecondaryRejection`
(`packages/capability/src/tasks.ts`), `isBuiltinTraceEntry`/`isBuiltinTraceEvent`
(`packages/capability/src/trace-kinds.ts`, `packages/capability/src/trace-events.ts`), and the
`AgentControl`/`AgentHandle`/`AgentKind`/`AgentRegistration`/`AgentRegistryPort`/`AgentSettlement`/
`AgentStatus`/`SettledStatus`/`WaitingOn` types from `packages/capability/src/agents-port.ts`. `zod`
is used only inside `settings.ts` and is not re-exported.

**Depended on by**: `@clarvis/loop` (`packages/loop/package.json`,
`packages/loop/tests/component/capability-run-context.test.ts`) and `@clarvis/workflows`
(`packages/workflows/package.json`, `packages/workflows/tests/component/dispatch.test.ts`), both
as static-value edges. `@clarvis/kernel` and `@clarvis/code` reach it transitively through
`loop`/`workflows` — neither declares it and neither names it anywhere in its own `src/`. No other
package imports it.

**What forces the direction**: `AGENT_REGISTRY_PORT` is a `PortKey<AgentRegistry>`
(`packages/supervision/src/agent-registry-port.ts`) published on a run's `CapabilityServices`
(`packages/capability/src/services.ts`) — a producer looks the port up rather than importing
this package's factory directly, and `AgentRegistryPort`'s own doc comment states registration is
"deliberately write-only: reading the tree is the supervision tools' job, not a producer's"
(`packages/capability/src/agents-port.ts`), which is what keeps a producer (`loop`, `workflows`) from depending on
anything beyond the three-method port. This package's own `registry.ts` doc comment states the
converse: "The registry knows nothing about delegation or workflows; producers register into it"
(`packages/supervision/src/registry.ts`) — nothing in `src/` imports `@clarvis/loop` or
`@clarvis/workflows`, and the manifest gives it no way to (`packages/supervision/package.json`).

`registerBackgroundChild` is explicitly a **shared skeleton**, not a full producer implementation —
its doc comment states only the identical part (build control plumbing, register, bail on `null`,
record `agent_registered`) is extracted, because what each producer does with the resulting task
(semaphore, compute-clock region, the run itself, its `settled()` mapping, producer-specific trace
events) differs enough that forcing it through a shared callback "would be more abstraction than the
duplication it replaces" (module TSDoc in `packages/supervision/src/spawn-child.ts`). One such left-out responsibility is closing the
`SteerQueue` itself: `SteerQueue.close()`'s own doc comment describes "closing on settle"
(`packages/supervision/src/steer-queue.ts`), but no call site inside `@clarvis/supervision`'s `src/` ever invokes
`close()` — settling a `ChildRecord` (`packages/supervision/src/registry.ts`) never touches the queue. Closing the
queue is left to whichever producer holds the `BackgroundChildSpawn.steerQueue` that
`registerBackgroundChild` handed back, at the moment that producer settles its own child.

## 8. Open questions

- **Who emits `agent_stopped`, `agent_steered` and `agent_finish_nudge`.** These three `TraceKind`s
  are declared in the same open union as `agent_registered`
  (`packages/capability/src/trace-kinds.ts`), but nothing in
  `packages/supervision/src/**` writes them — `registerBackgroundChild` is the package's only
  `trace.record` call, and it emits `agent_registered` alone (`registerBackgroundChild` in
  `packages/supervision/src/spawn-child.ts`). Their
  producer belongs to a consumer of this registry (most likely [loop-delegation-and-subagents](../engine/delegation-and-subagents.md) or
  [workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md)), out of this document's scope.
- **Where `AgentsLimits.awaitTimeoutMs` and `.finishNudges` are actually consumed.** Both are resolved
  by `resolveAgentsLimits` (`packages/supervision/src/limits.ts`) and carried on every `AgentsLimits` value
  (`packages/supervision/src/registry.ts`), but no function inside `packages/supervision/src/**` reads either field —
  `registry.ts` never references `limits.awaitTimeoutMs` or `limits.finishNudges`. A consumer outside
  this package (the `await_agents` tool handler for the timeout; a finish-nudge counter for the
  nudge count) must read them directly off the resolved `AgentsLimits` object it already holds. This
  package only guarantees the value is correctly resolved and typed, not how it is spent.
  Belongs to [loop-delegation-and-subagents](../engine/delegation-and-subagents.md).
- **Whether the `AgentRegistryOptions.onActivity` callback's contract (fired on every `touch`, i.e.
  every buffer append and every `waiting`/`steer` mutation — `packages/supervision/src/registry.ts`) is
  exactly what a compute-clock consumer expects**, beyond the one test that counts calls
  (`packages/supervision/tests/component/registry.test.ts`). The consumer side (a run's stall watchdog) is outside this package's
  scope.
- **The reasoning behind specific numeric defaults** (why `8` live children rather than another
  number, why a `120_000`ms await timeout) is not stated anywhere in `settings.ts` beyond the general
  rationale that buffer bounds protect the parent's memory and the live/notice/failure ceilings
  protect its context (`packages/supervision/src/settings.ts`). No test or comment gives a numeric justification beyond
  that framing, so the specific values are treated as product decisions the code does not explain.
