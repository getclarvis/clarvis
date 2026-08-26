# The run-scoped child registry, buffers and steer queue

> Implemented at `packages/supervision/src/**` and `packages/supervision/tests/**`. Every claim
> below is anchored to a file and line. Open questions are collected in the final section.

## 1. Purpose

`@clarvis/supervision` is the run-scoped registry a parent observes and controls its spawned
children through: agent ids, a per-child activity buffer, a trace→activity-line projection, a
per-child steer queue, and the settings/limits that bound all of it
(`packages/supervision/src/index.ts:1-21`). It exists because two independent producers need to
register a child into **one** id space without importing each other: `@clarvis/loop`'s
`delegate_task` (a sub-agent) and `@clarvis/workflows`' `run_leader` (a leader)
(`packages/supervision/src/index.ts:5-9`). Both reach the registry only through
`@clarvis/capability`'s port mechanism, never by importing one another.

The package is deliberately substrate, not policy: it knows how to mint an id, buffer a child's
activity, project a trace record into a readable line, queue a steer, and register a background
child; it does not know what a model may ask for any of that. The five model-facing tools
(`agent_list`, `agent_poll`, `agent_stop`, `agent_steer`, `await_agents`) and the decision of *when*
a parent spawns into this registry belong to `@clarvis/loop` and are covered by the
[loop-delegation-and-subagents](../engine/delegation-and-subagents.md) document; a workflow leader's use of the registry belongs to
[workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md) (`packages/supervision/src/index.ts:10-18`).

Its only internal dependency is `@clarvis/capability`; `zod` is used solely inside `settings.ts`
(`packages/supervision/src/index.ts:19-21`, confirmed in `packages/supervision/package.json`
`dependencies`). That is the only runtime edge out of this package, and only two manifests in the
workspace declare an edge back in, so nothing later in the build order reaches it except through
`loop`/`workflows` (`packages/loop/package.json:84`, `packages/workflows/package.json:56`).

## 2. Surface

### 2.1 Exported entrypoint (`src/index.ts`, all re-exported from `.`)

| Symbol | Kind | Defined at | What it is |
|---|---|---|---|
| `createAgentBuffer` | fn | `packages/supervision/src/buffer.ts:103` | builds a bounded per-child `AgentBuffer` |
| `AgentBufferRead`, `AgentBufferLimits`, `AgentBuffer` | type | `packages/supervision/src/buffer.ts:17,29,42` | one page read; line/byte ceilings; the buffer interface |
| `AGENT_REGISTRY_PORT` | const | `packages/supervision/src/agent-registry-port.ts:11` | `PortKey<AgentRegistry>` published under id `"supervision.agents"` |
| `AGENT_ID_PATTERN` | const | `packages/supervision/src/ids.ts:8` | `/^ag_[0-9a-f]{8}$/` |
| `mintAgentId` | fn | `packages/supervision/src/ids.ts:21` | mints a fresh, collision-checked `ag_` id |
| `resolveAgentsLimits` | fn | `packages/supervision/src/limits.ts:22` | folds a run request's `agents` param over `AGENTS_DEFAULTS` |
| `fromTraceEntry`, `fromTraceEvent` | fn | `packages/supervision/src/projection.ts:44,55` | normalize a nested `TraceEntry` or a flat wire `TraceEvent` into a `ProjectionSource` |
| `projectAgentEvent` | fn | `packages/supervision/src/projection.ts:122` | project one normalized record into a line, or `null` |
| `waitAgeSeconds` | fn | `packages/supervision/src/projection.ts:203` | age in whole seconds of a still-waiting elicitation |
| `ProjectionSource`, `ProjectionState` | type | `packages/supervision/src/projection.ts:22,29` | input shape; carried tag/wait state |
| `createAgentRegistry` | fn | `packages/supervision/src/registry.ts:205` | builds an `AgentRegistry` |
| `UnknownAgentError` | class | `packages/supervision/src/registry.ts:132` | `CodedError` (`code: "unknown_agent"`) for a `waitAny` naming an untracked id |
| `AgentsLimits`, `AgentListEntry`, `AgentPollResult`, `AgentStopResult`, `AgentNotice`, `AgentSettledInfo`, `AgentWait`, `AgentTeardownReport`, `AgentRegistryOptions`, `AgentRegistry` | type | `packages/supervision/src/registry.ts:49,69,85,96,106,115,122,137,143,155` | see §3 |
| `AGENTS_CAPABILITY_NAME` | const | `packages/supervision/src/settings.ts:14` | `"agents"` |
| `AGENTS_DEFAULTS` | const | `packages/supervision/src/settings.ts:76` | product defaults (§3.3) |
| `AGENTS_MAX_BUFFER_LINES` / `AGENTS_MAX_BUFFER_BYTES` | const | `packages/supervision/src/settings.ts:17-18` | `10_000` / `8_388_608` |
| `AGENTS_MAX_TOTAL_BUFFER_BYTES` | const | `packages/supervision/src/settings.ts:21` | `33_554_432` |
| `AGENTS_MAX_LIVE_CHILDREN` | const | `packages/supervision/src/settings.ts:32` | `32` |
| `AGENTS_MAX_RETAINED_CHILDREN` | const | `packages/supervision/src/settings.ts:42` | `64` |
| `AGENTS_SETTINGS_FIELDS` | const | `packages/supervision/src/settings.ts:146` | the `agents:` `settings.json` field map |
| `AGENTS_REQUEST_PARAMS` | const | `packages/supervision/src/settings.ts:157` | the per-run `agents` override field map |
| `agentsSettingsSpec` | const | `packages/supervision/src/settings.ts:169` | the `CapabilitySettingsSpec` registration entry |
| `registerBackgroundChild` | fn | `packages/supervision/src/spawn-child.ts:46` | shared register-a-background-child skeleton |
| `BackgroundChildSpec`, `BackgroundChildSpawn` | type | `packages/supervision/src/spawn-child.ts:18,28` | spec in / three handles out |
| `createSteerQueue` | fn | `packages/supervision/src/steer-queue.ts:31` | builds an empty `SteerQueue` |
| `SteerQueue` | type | `packages/supervision/src/steer-queue.ts:15` | `SteerSource` extended with `push`/`undrained`/`close` |

### 2.2 `AgentRegistryPort` — the producer-only slice (`@clarvis/capability`)

Declared in `packages/capability/src/agents-port.ts` and `extends`-ed by the full `AgentRegistry`
(`packages/supervision/src/registry.ts:159`), so a producer that only needs to register a child can
depend on the narrower port type:

| Member | Signature | Cited at |
|---|---|---|
| `register` | `(registration: AgentRegistration) => AgentHandle \| null` | `packages/capability/src/agents-port.ts:98-105` |
| `adopt` | `(id: string, task: Promise<unknown>) => void` | `packages/capability/src/agents-port.ts:106-113` |
| `liveCount` | `() => number` | `packages/capability/src/agents-port.ts:115` |

`AgentHandle` (`packages/capability/src/agents-port.ts:81-89`) is what a producer holds after registering: `id`,
`ingest(event: TraceEvent)`, `waiting(on: WaitingOn)`, `settled(settlement: AgentSettlement)`. A
sub-agent producer never calls `ingest` — its activity is routed automatically off the run's own
trace by `ingestTraceEntry` (`packages/capability/src/agents-port.ts:76-78`, `packages/supervision/src/registry.ts:581-597`); a leader producer
forwards its own `executeRun`'s trace through it.

`AGENT_REGISTRY_PORT` actually round-trips through `@clarvis/capability`'s
`createCapabilityServices`/`services.provide`/`services.get` — a full `AgentRegistry` provided under
the port is retrievable as itself, not merely as the narrower `AgentRegistryPort` shape — pinned end
to end by `packages/supervision/tests/unit/agent-registry-port.test.ts:6-27`.

### 2.3 `AgentRegistry` — the full surface (`packages/supervision/src/registry.ts:159-178`)

| Member | Signature | Cited at |
|---|---|---|
| `list()` | `() => AgentListEntry[]` | `packages/supervision/src/registry.ts:160` |
| `has(id)` | `(id: string) => boolean` | `:161` |
| `poll(id, opts)` | `(id, { offset?, match? }) => AgentPollResult \| null` | `:162` |
| `stop(id, reason)` | `(id, string) => AgentStopResult \| null` | `:163` |
| `steer(id, message)` | `(id, SteerMessage) => { ok, status } \| null` | `:164` |
| `waitAny(ids?)` | `(readonly string[]?) => AgentWait` | `:165` |
| `liveIds()` | `() => string[]` | `:166` |
| `ingestTraceEntry(entry)` | `(TraceEntry) => void` | `:168` |
| `takeNotices()` | `() => AgentNotice[]` | `:170` |
| `failingStreakExceeded()` | `() => boolean` | `:172` |
| `seal()` / `sealed()` | `() => void` / `() => boolean` | `:174-175` |
| `teardown(graceMs)` | `(number) => Promise<AgentTeardownReport>` | `:177` |

Plus the `AgentRegistryPort` members inherited (`:159`).

### 2.4 `settings.json` block and per-run request param

| Field | Default | Schema bound | Cited at |
|---|---|---|---|
| `buffer_lines` | `2000` | `1..10_000` int | `packages/supervision/src/settings.ts:94-99` |
| `buffer_bytes` | `1_048_576` | `1..8_388_608` int | `:77-82` |
| `max_total_buffer_bytes` | `33_554_432` | `1..33_554_432` int | `:83-88` |
| `poll_max_bytes` | `65_536` | `1..65_536` int | `:89` |
| `await_timeout_ms` | `120_000` | `1..600_000` int | `:90-95` |
| `max_live_children` | `8` | `1..32` int | `:96-101` |
| `max_retained_children` | `64` | `1..64` int | `:102-107` |
| `max_notices_per_iteration` | `8` | positive int, no upper bound | `:108-112` |
| `max_consecutive_failed_children` | `3` | nonnegative int, no upper bound | `:113-117` |
| `finish_nudges` | `2` | nonnegative int, no upper bound | `:118` |

`agentsConfigSchema` is `.strict()` (`packages/supervision/src/settings.ts:93-143`), so an unknown key is rejected rather than
ignored (pinned by `packages/supervision/tests/unit/settings.test.ts:21-23`). It is exposed twice
from the same object: as `AGENTS_SETTINGS_FIELDS.agents` (optional, unfilled when absent — pinned at
`packages/supervision/tests/unit/settings.test.ts:17-19`) for `settings.json`, and as `AGENTS_REQUEST_PARAMS.agents` (`.partial()`,
still filling every omitted field from the same defaults — pinned at `packages/supervision/tests/unit/settings.test.ts:52-57`) for a
run request's `agents` param (`AgentsParam` in `packages/capability/src/api.ts:427-437`). There is
**no on/off field**: the settings comment states the surface follows from whether the run's entry
agent can spawn at all, not from a flag (`packages/supervision/src/settings.ts:5-8`, `packages/capability/src/api.ts:416`).

`agentsSettingsSpec` registers under key `"agents"`, `merge: "lastWins"`,
`pluginContributable: false` (`packages/supervision/src/settings.ts:169-175`, pinned at `packages/supervision/tests/unit/settings.test.ts:63-68`) — the
in-code comment states the reason: "a plugin must not be able to raise a ceiling that exists to
protect the run it is running inside" (`packages/supervision/src/settings.ts:165-168`).

## 3. Data and formats

### 3.1 Agent ids

`mintAgentId(taken)` returns `"ag_" + randomUUID().replace(/-/g, "").slice(0, 8)`, redrawing while
the candidate is in `taken` (`packages/supervision/src/ids.ts:21-30`). `AGENT_ID_PATTERN` is
`/^ag_[0-9a-f]{8}$/` (`packages/supervision/src/ids.ts:8`); 200 consecutive mints are pinned unique and pattern-matching
(`packages/supervision/tests/unit/ids.test.ts:5-15`), and the retry branch is exercised directly with
a `Set` subclass whose `has()` reports the first candidate as already taken
(`packages/supervision/tests/unit/ids.test.ts:18-38`). Uniqueness is scoped to one run's one registry — the doc comment states this
is why 8 hex digits are treated as ample rather than birthday-bound (`packages/supervision/src/ids.ts:15-18`).

### 3.2 `ChildRecord` (internal, `packages/supervision/src/registry.ts:181-198`)

One record per registered child: `id`, `kind` (`"subagent" | "leader"`), `nativeId` (the producer's
own id — a `subagent_instance_id` or a `run_id`), `title`, optional `profile`, `status`
(`AgentStatus`), `waitingOn` (`WaitingOn`), `startedAt`/`lastActivityAt` (epoch ms), `iterations`,
`tokens`, `result` (`string | null`), its own `AgentBuffer`, a `ProjectionState`, its producer's
`AgentControl`, and an optional adopted `task` promise.

`AgentStatus` is `"running" | "waiting" | "completed" | "failed" | "stopped" | "cancelled"`
(`packages/capability/src/agents-port.ts:17-26`), and `SettledStatus` is the terminal subset
excluding `"running" | "waiting"` (`packages/capability/src/agents-port.ts:29`). `WaitingOn` is `"elicitation" | null`
(`packages/capability/src/agents-port.ts:32`).

### 3.3 `AGENTS_DEFAULTS` (`packages/supervision/src/settings.ts:76-86`)

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

### 3.4 `AgentListEntry` (one `agent_list` row, `packages/supervision/src/registry.ts:73-86`)

`id`, `kind`, `native_id`, optional `profile`, `title`, `status`, `started_at`, `iterations`,
`tokens`, `waiting_on`, optional `waiting_for_s` (present only while `waiting_on !== null` and a wait
age is known — `packages/supervision/src/registry.ts:472-474`), `last_activity_ms` (computed as `now - lastActivityAt` at read
time — `:475`).

### 3.5 `AgentPollResult` (`packages/supervision/src/registry.ts:89-97`) / `AgentStopResult` (`:100-107`)

`AgentPollResult`: `id`, `running` (`isLive`), `status`, `output` (the buffer page's text plus a
`"\n[... more output buffered; continue with offset=N ...]"` marker appended when `read.more`
— `:489-496`), `next_offset`, `truncated_head`, `result`.

`AgentStopResult`: `id`, `status`, `tail` (the last `TAIL_BYTES = 2048` bytes of the buffer, read
after settlement — `packages/supervision/src/registry.ts:196,508`), `iterations`, `tokens`, `already_settled`.

### 3.6 `AgentBufferRead` (one page, `packages/supervision/src/buffer.ts:17-24`)

`text` (newline-joined, no trailing newline), `nextOffset` (absolute byte offset to resume from),
`more` (true when unread content remains past `nextOffset`), `truncatedHead` (bytes the caller asked
for that had already been dropped, `0` when none). `truncatedHead` reads `0` once a caller's own
`offset` is at or past `head()` — the steady-state case of a caller that has fully caught up
(`packages/supervision/src/buffer.ts:175`; pinned `packages/supervision/tests/unit/buffer.test.ts:41-47`, "reports no
truncated head once the caller has caught up past the drop").

### 3.7 Trace record kinds this package reads or writes

`registerBackgroundChild` writes exactly one trace kind, `agent_registered`
(`packages/supervision/src/spawn-child.ts:68-76`), whose detail shape (`AgentRegisteredDetail`) is declared once in
`@clarvis/capability`: `agent_id`, `kind: "subagent" | "leader"`, `native_id`, `title`, optional
`profile`, `background: boolean` (`packages/capability/src/trace-kinds.ts:585-592,663`). Three sibling
kinds — `agent_stopped`, `agent_steered`, `agent_finish_nudge` — are declared in the same open
`BuiltinTraceKind` union (`packages/capability/src/trace-kinds.ts:45-47,664-666`) but are **not** emitted anywhere in this
package's `src/`; their producer is outside this document's scope (see §8).

`projectAgentEvent` reads (but does not write) trace vocabulary by string `kind`/`type` switch:
`lead_iteration_started`/`subagent_iteration_started`, `lead_iteration`/`subagent_iteration`,
`tool_call`, `delegation_created`, `workflow_run_started`, `elicitation_requested`, `user_question`,
`user_steering`, `cancellation`, `model_call_error`, `terminate`, `run_ended`
(`packages/supervision/src/projection.ts:130-196`); every other kind — explicitly including the high-frequency
`model_stream_delta`/`tool_output_delta` (pinned at
`packages/supervision/tests/unit/projection.test.ts:139-142`) and the bookkeeping
`compaction`/`budget_check`/`tool_call_started`/`init` (pinned at `packages/supervision/tests/unit/projection.test.ts:144-149`) —
projects to `null` (`packages/supervision/src/projection.ts:14-17`).

### 3.8 A worked projected line

From `packages/supervision/tests/unit/projection.test.ts:33-42`, a `tool_call` entry
`{ name: "read_file", arguments: { path: "src/a.ts" }, result: "x".repeat(3174), error: null }` at
`lastIteration: 2` projects to:

```
[i2] tool read_file {path:"src/a.ts"} → ok 3.1kB
```

An elicitation opens with `[i3] elicit "may I run bun install?" — WAITING`
(`packages/supervision/tests/unit/projection.test.ts:104-110`) and its resolution closes with
`[i3] elicit resolved: accept after 42s` (`:113-118`).

## 4. Behavior

### 4.1 Registration (`packages/supervision/src/registry.ts:394-431`)

1. Count live children (`status === "running" || "waiting"`, `isLive`, `:247`).
2. If `isSealed`, log `agents.spawn_refused` with `reason: "sealed"` and return `null`
   (`:397-400`).
3. Else if `live >= maxLiveChildren`, log the same event with `reason: "at_capacity"` and return
   `null` (`:401-404`) — **the registry refuses a spawn past the ceiling; it never queues it**
   (pinned at `packages/supervision/tests/component/registry.test.ts:149-155`).
4. Otherwise mint an id, build the `ChildRecord` with a fresh `AgentBuffer` sized by
   `bufferBytesPerChild` (§4.5), store it in `records`/`byNative`/`order`, and return its
   `AgentHandle` (`:398-423`).

### 4.2 Producing activity (two paths, `packages/supervision/src/registry.ts:370-392`, `:581-597`)

- **Sub-agent path**: the run's own trace entries are routed by `ingestTraceEntry(entry)`, which
  reads `entry.detail.subagent_instance_id`, looks it up in `byNative`, and — only for a match —
  appends the projected line and, for a `subagent_iteration` builtin entry, folds
  `iterations`/`tokens` (`:581-597`). An entry naming no registered native id is silently ignored
  (`:580,582,584`; pinned at `packages/supervision/tests/component/registry.test.ts:235-243`).
- **Leader path**: the leader's producer calls `handle.ingest(event)` directly with its own forwarded
  wire `TraceEvent`s; the same projection and the same `lead_iteration`/`subagent_iteration` folding
  logic applies (`:365-373`; pinned at `packages/supervision/tests/component/registry.test.ts:556-575`, including that a forwarded
  iteration count never rewinds — `Math.max(r.iterations, event.iteration)`, `:371`, pinned at
  `packages/supervision/tests/component/registry.test.ts:569-575`).

Every append calls `touch(r)`, which stamps `lastActivityAt = Date.now()` and calls the optional
`onActivity` callback (`:306-309`) — the doc comment on `AgentRegistryOptions.onActivity` states this
exists so an orchestrator can poke its own compute-clock stall watchdog, because a leader's events
land on the leader's own trace and would otherwise never reach it (`:146-149`; pinned at
`packages/supervision/tests/component/registry.test.ts:255-266`).

### 4.3 Waiting / settlement (`AgentHandle.waiting`, `.settled`, `packages/supervision/src/registry.ts:382-391`, `:345-368`)

| State transition | Effect |
|---|---|
| `waiting(on)` while live, `on !== null` | `status = "waiting"`, `waitingOn = on`, `touch(r)` (`:376-378,380`) |
| `waiting(null)` while live | `status = "running"`, `waitingOn = null`, clears `projection.waitingSince`, `touch(r)` (`:384-387`) |
| `waiting(...)` once settled | no-op (`isLive` guard, `:383`; pinned `packages/supervision/tests/component/registry.test.ts:587-589`) |
| `settled(s)` while live | `status = s.status`, `waitingOn = null`, `result = s.result ?? null`, folds `iterations`/`tokens` if given, resets/increments `consecutiveFailures`, pushes a notice, wakes every matching `waitAny` waiter, calls `evictRetained()` (`:338-360`) |
| `settled(...)` once already settled | no-op, idempotent (`isLive` guard, `:339`) |

The notice text is `` `[agents] ${id} (${kind} "${title}") ${status}${": " + result.slice(0,400) if given}` ``
and `progress` is `true` **only** for `status === "completed"` — a `failed` settle or a still-waiting
report is not progress, so a doomed run cannot be kept alive by them (`:350-354`, doc comment
`:108-111`; pinned `packages/supervision/tests/component/registry.test.ts:355-366`).

### 4.4 `agent_stop` / `agent_steer` (`packages/supervision/src/registry.ts:503-537`)

- `stop(id, reason)`: if already settled, reports `already_settled: true` without touching the
  child's control port again (`:506-507`; pinned `packages/supervision/tests/component/registry.test.ts:185-194`); otherwise it calls
  `r.control.stop(reason)` (swallowing and logging a throw as `agents.stop_port_threw`, phase
  `"stop"` — `:501-504`, pinned `packages/supervision/tests/component/registry.test.ts:606-629`), then settles it as
  `{ status: "stopped", result: "stopped by parent: <reason>" }` (`:506`). The buffer is **not**
  cleared by a stop — it stays fully readable afterward (`:508-517`; pinned
  `packages/supervision/tests/component/registry.test.ts:196-206`, `"(D9)"`).
- `steer(id, message)`: refuses with `{ ok: false, status }` and logs `agents.steer_refused` when
  the child is not live (`:522-524`) or when `r.control.steer(message)` itself returns `false`
  (`:526-528`); otherwise it `touch(r)`es and returns `{ ok: true, status }` (`:526-527`). Neither
  case throws — a steer to any non-receiving child is a plain result (pinned
  `packages/supervision/tests/component/registry.test.ts:657-692`).

### 4.5 Buffer sizing across live and retained slots (`packages/supervision/src/registry.ts:208-229`)

```
maxLiveChildren      = clamp(limits.maxLiveChildren, 0, AGENTS_MAX_LIVE_CHILDREN)      (:206-208)
maxRetainedChildren  = max(1, clamp(limits.maxRetainedChildren, 0, 64))                (:209)
maxTotalBufferBytes  = clamp(limits.maxTotalBufferBytes, 0, AGENTS_MAX_TOTAL_BUFFER_BYTES) (:210-212)
configuredBufferBytes = max(0, floor(limits.bufferBytes)) or 0 if non-finite           (:213-215)
bufferBytesPerChild  = min(configuredBufferBytes,
                            floor(maxTotalBufferBytes / (maxLiveChildren + maxRetainedChildren))) (:219-222)
```

The lower bound on `maxLiveChildren` is `0`, not the schema's own positive-integer minimum of `1` —
the in-code comment states this is deliberate: "Programmatic test/host callers historically use zero
to close admission completely even though settings require a positive live ceiling" (`:210-211`). That
value is reachable only by a programmatic/test caller bypassing `agentsConfigSchema`, whose own
`max_live_children` field is `.positive()` (`packages/supervision/src/settings.ts:119-124`).

Every child — live or retained — reserves the **same** fixed slice up front, which the in-code
comment states is what makes the aggregate ceiling independent of settlement/registration ordering
(`:216-218`). Pinned at the boundary: with `bufferBytes: 1000, maxTotalBufferBytes: 50,
maxLiveChildren: 2, maxRetainedChildren: 3` the per-child slice is `floor(50/5) = 10` and the summed
retained bytes across all 5 children never exceeds 50 (`packages/supervision/tests/component/registry.test.ts:395-423`); at the schema
maximum (`maxTotalBufferBytes: 96, maxLiveChildren: 32, maxRetainedChildren: 64`) the slice is
exactly `1` byte per child and 96 children retain exactly 96 bytes total, with a 97th spawn refused
(`packages/supervision/tests/component/registry.test.ts:425-454`).

### 4.6 Retention eviction (`evictRetained`, `packages/supervision/src/registry.ts:318-334`)

Called on every `settle`. Filters `order` to settled (non-live) ids, and while
`settled.length - maxRetainedChildren > 0`, deletes the **oldest-registered** settled record from
`records`, `byNative` and `order` — a live child is never a candidate, because the filter excludes
it (`:319-333`; pinned `packages/supervision/tests/component/registry.test.ts:456-465`, which shows the oldest of four settled children
evicted while a fifth, live, child survives untouched).

### 4.7 Notices (`takeNotices`, `packages/supervision/src/registry.ts:599-616`)

Caps the queued notices at `max(1, limits.maxNoticesPerIteration)` per call; when more were queued,
the shown slice is truncated and a synthetic trailing notice
`` `[agents] +${hidden} more child updates this turn; call agent_list to see them all.` `` (with
`progress: false`) is appended (`:606-615`; pinned `packages/supervision/tests/component/registry.test.ts:368-377`).

### 4.8 Failing-streak (`failingStreakExceeded`, `packages/supervision/src/registry.ts:618-620`)

`consecutiveFailures` increments on a `"failed"` settle and resets to `0` on a `"completed"` one
(`:354-355`). `failingStreakExceeded()` is true once `maxConsecutiveFailedChildren > 0` **and**
`consecutiveFailures >= maxConsecutiveFailedChildren` (`:618-620`) — a `0` limit disables the check
entirely rather than tripping on the first failure (pinned by the schema admitting `0` at
`packages/supervision/tests/unit/settings.test.ts:41-46`, and behaviourally at
`packages/supervision/tests/component/registry.test.ts:379-391`, which walks 2 failures → not exceeded, a 3rd → exceeded, then a success →
reset).

### 4.9 `waitAny` (`packages/supervision/src/registry.ts:539-579`)

1. If `ids` is given, first reject with `UnknownAgentError` **immediately** if any named id is not
   tracked at all — before consulting liveness for any of them (`:541-545`; pinned
   `packages/supervision/tests/component/registry.test.ts:343-351`).
2. Else if any named id is already settled, resolve **immediately** with that child's
   `AgentSettledInfo`, checked in the caller's own `ids` order so the first-listed already-settled
   child wins (`:539-551`; pinned `packages/supervision/tests/component/registry.test.ts:327-341`, `b` before `a` in argument order).
3. Otherwise register a listener in `waiters`, scoped to `ids` (or unscoped) via a closed-over
   `Set`; a settle outside the scope re-adds the same listener rather than resolving
   (`:553-565`; pinned `packages/supervision/tests/component/registry.test.ts:297-311`). `dispose()` removes the listener so a lost race
   leaves nothing behind (`:568-570`; pinned `packages/supervision/tests/component/registry.test.ts:313-325`).

### 4.10 Teardown (`packages/supervision/src/registry.ts:626-673`)

1. Seal the registry (`isSealed = true`) so no further registration can land mid-teardown
   (`:627`).
2. Call `control.stop("the run is finishing")` on every still-live record, logging (not throwing on)
   a port that throws as `agents.stop_port_threw`, phase `"teardown"` (`:630-637`).
3. If any adopted task is still outstanding, race `Promise.allSettled([...tasks])` against a grace
   timer (`scheduleTimeout`, default an unref'ed `setTimeout`) and cancel the timer either way
   (`:638-648`; the grace timer is a deterministic test seam via `AgentRegistryOptions.scheduleTimeout`,
   pinned at `packages/supervision/tests/component/registry.test.ts:500-511`, which fires the timer manually to prove teardown gives up at
   the bound rather than hanging).
4. For every record still live after the race, settle it as
   `{ status: "cancelled", result: "abandoned when the run finished" }` and record its id in
   `abandoned` (`:643-648`); for every record, sum `control.undrained?.() ?? 0` into
   `undrainedSteers` and `freeze()` its buffer (`:643-650`).
5. Clear `notices` and every remaining `waiters` entry (`:651-652`).
6. If anything was abandoned or any steer went undrained, log one `agents.teardown_abandoned`
   warning naming the abandoned ids, the undrained count, the grace and the task count
   (`:653-664`; pinned `packages/supervision/tests/component/registry.test.ts:694-719` for the warning shape, and
   `packages/supervision/tests/component/registry.test.ts:721-730` for silence when nothing was abandoned).

An adopted task's own rejection is caught and logged (`"agents: background child task rejected"`)
before it is ever awaited by teardown's `Promise.allSettled`, and the tracked/derived promise chain
is explicitly passed through `suppressSecondaryRejection` so the same rejection can never also
surface as an unhandled rejection on the `tasks` set's cleanup `.finally()` (`packages/supervision/src/registry.ts:433-447`;
pinned `packages/supervision/tests/component/registry.test.ts:513-518`, `:592-604`).

### 4.11 `registerBackgroundChild` (`packages/supervision/src/spawn-child.ts:46-78`)

The shared skeleton both `delegate_task` and `run_leader` call into:

1. Build a fresh `AbortController` and `SteerQueue` (`:51-52`).
2. Call `agents.register(...)` with a `control` object wired to them: `stop` aborts the controller
   with `new Error(reason)` as the abort reason (`:59-61`), `steer` pushes onto the queue (`:62`),
   `undrained` reports `steerQueue.undrained().length` (`:63`).
3. If `register` returned `null`, return `null` and record nothing (`:66`; pinned
   `packages/supervision/tests/component/spawn-child.test.ts:109-121`) — "a producer must treat `null` as 'do not spawn'" (doc comment
   `packages/supervision/src/spawn-child.ts:43-44`).
4. Otherwise record one `agent_registered` trace entry with `background: true` (`:68-75`), omitting
   `profile` entirely (not as `undefined`) when the spec carried none (pinned
   `packages/supervision/tests/component/spawn-child.test.ts:99-107`), and return `{ handle, controller, steerQueue }` (`:77`).

### 4.12 Buffer append and eviction (`packages/supervision/src/buffer.ts:103-215`)

`createAgentBuffer` closes over an array of `Line | undefined` slots plus a `first` head-index, so a
drop does not `splice` the array on every eviction:

1. `append(line)` strips a trailing newline, computes `originalStart = tail`, and advances `tail` by
   `textBytes + 1` **before** any truncation happens — the newline is charged to the absolute offset
   space even though a read never shows it (`:138-143`).
2. If the buffer's own configured `maxBytes` is `0`, the whole ring is dropped immediately and `head`
   jumps to `tail` — a per-child hard "no capture" mode (`:144-150`).
3. Otherwise `retainUtf8Tail` keeps the newest UTF-8-safe tail of the line within `maxBytes - 1` bytes,
   reserving one byte for the newline (`:152-156`). If that retain dropped any bytes, **every older
   line is discarded** (`lines.length = 0; first = 0; held = 0`) so the just-retained line becomes the
   new head and `truncatedHead` accounts for all of the now-unavailable bytes rather than leaving an
   invisible gap behind an older line (`:157-165`; pinned by
   `packages/supervision/tests/unit/buffer.test.ts:176-185`, "does not hide an oversized line's
   dropped prefix behind an older retained line").
4. The line is pushed and `held` updated, then `evict()` drops from the front while
   `lines.length - first > maxLines || held > maxBytes`, recomputing `head` from
   `lines[first]?.start ?? tail` each time (`:116-124`; pinned by `packages/supervision/tests/unit/buffer.test.ts:152-161`, "the byte
   bound evicts oldest-first and keeps at least the newest line").
5. `evict()` only physically compacts the backing array — `lines.splice(0, first); first = 0` — once
   `first >= 1024 && first * 2 >= lines.length`, so steady-state eviction is O(1) index-bumping and
   dropped strings still stop being referenced periodically rather than never (`:126-132`; pinned by
   `packages/supervision/tests/unit/buffer.test.ts:199-203`, "compacts dropped slots without losing the newest lines", which appends
   5000 lines against `maxLines: 3`).

`read(offset, budget, match?)` clamps its own two arguments defensively before doing anything else:
`want` falls back to `0` when `offset` is non-finite, and `budget` is floored through
`finiteIntAtMost(budget, 1, 65_536)` (`:172-173`) — independent of the constructor-side clamp on
`maxLines`/`maxBytes` (`:104-108`). Pinned by three tests: "an offset past the tail returns nothing
and parks at the tail" (`packages/supervision/tests/unit/buffer.test.ts:49-56`), "a mid-line offset clamps up to the next boundary
rather than re-emitting a partial line" (`:58-64`), and "bounds non-finite programmatic cursors and
page budgets" (`:103-108`, asserting `buf.read(NaN, Infinity).text === "f"`).

## 5. Invariants

The invariants below are derived directly from this package's own code and tests.

1. **A well-formed `agent_id` is exactly `ag_` + 8 lowercase hex digits, nothing else.**
   Production: `packages/supervision/src/ids.ts:8,21-30`. Test:
   `packages/supervision/tests/unit/ids.test.ts:5-15,43-51`.
2. **A registration never blocks or queues past the live-children ceiling — it is refused outright,
   with the refusal logged and its reason distinguished (`sealed` vs `at_capacity`).**
   Production: `packages/supervision/src/registry.ts:388-397,254-269`. Test: `packages/supervision/tests/component/registry.test.ts:149-155`, `:633-655`.
3. **A settled child's slot is reusable immediately** (a spawn refused at capacity succeeds once the
   occupying child settles, with no other state change required). Production: `packages/supervision/src/registry.ts:346-367`
   interacting with `:389,394`. Test: `packages/supervision/tests/component/registry.test.ts:157-163`.
4. **Reads and writes against an id from a different registry are a plain `null`/refusal, never a
   throw**, except `waitAny` naming an explicitly-unknown id, which rejects with `UnknownAgentError`.
   Production: `packages/supervision/src/registry.ts:474-476,496-498,519-521,532-538`. Test: `packages/supervision/tests/component/registry.test.ts:137-145,343-351`.
5. **A settle is idempotent: the first one wins, and a later `settled`/`waiting` call on an already
   -settled child is a no-op.** Production: the `isLive` guard at `packages/supervision/src/registry.ts:339,376,382-384`. Test:
   `packages/supervision/tests/component/registry.test.ts:185-194,577-590`.
6. **A stop or teardown never clears a settled child's buffer** — a parent can still read exactly
   what the child produced up to the moment it was ended. Production: `packages/supervision/src/registry.ts:503-524` (no
   buffer mutation on the settle path) and `:656` (`freeze()`, which stops future appends but leaves
   existing content readable — `packages/supervision/src/buffer.ts:58`). Test: `packages/supervision/tests/component/registry.test.ts:196-206` (labelled `(D9)` in
   both the production comment `packages/supervision/src/buffer.ts:58` and the test name), and `buffer.test.ts` (the `(D9)`
   describe block, "freeze keeps existing content readable but stops accepting appends").
7. **The aggregate retained-buffer budget across every live and retained child never exceeds
   `maxTotalBufferBytes`, independent of registration/settlement order**, because each child reserves
   an equal fixed slice — `floor(maxTotalBufferBytes / (maxLiveChildren + maxRetainedChildren))` —
   at construction rather than a shared pool consumed on a first-come basis. Production:
   `packages/supervision/src/registry.ts:216-222,413-416`. Test: `packages/supervision/tests/component/registry.test.ts:395-423` (order: settled children written
   before live ones) and `:425-454` (at the schema-maximum combination, 96 children retain exactly 96
   bytes and a 97th spawn is refused).
8. **A buffer read never splits a line, so a page boundary can never land inside a multi-byte UTF-8
   sequence.** Production: `packages/supervision/src/buffer.ts:2-9` (doc comment), the line-granular `read()` loop
   (`packages/supervision/src/buffer.ts:171-193`) and `retainUtf8Tail`/`truncateUtf8Prefix`'s code-point-boundary walks
   (`:78-91`). Test:
   `packages/supervision/tests/unit/buffer.test.ts` ("a page boundary falls between lines: a
   multibyte line is never half-emitted", "always emits at least one line, truncating an oversized
   one at a code-point boundary", "retains only the UTF-8-safe tail of one oversized line").
9. **Buffer offsets are absolute over the whole stream a child has ever produced, monotonic, and
   never rewind on a head drop.** Production: `packages/supervision/src/buffer.ts:6-9` (doc comment), `head`/`tail` closures
   (`registry` of `packages/supervision/src/buffer.ts:117-215`). Test: `buffer.test.ts` ("offsets are absolute over the whole
   stream…", "a head drop raises head and never rewinds tail…").
10. **A forwarded iteration counter can only advance, never rewind, even when events arrive
    out of order.** Production: `packages/supervision/src/registry.ts:371,587` (`Math.max(r.iterations, …)`). Test:
    `packages/supervision/tests/component/registry.test.ts:569-575` (a later-arriving lower iteration number is ignored).
11. **A `progress` notice requires a `"completed"` settle; a `"failed"` settle or a still-waiting
    report never counts as progress**, so a run whose children only ever fail cannot be kept alive by
    its own notices. Production: `packages/supervision/src/registry.ts:360` (`progress: s.status === "completed"`). Test:
    `packages/supervision/tests/component/registry.test.ts:355-366`.
12. **A `settings.json`/request `agents` block rejects any key outside the schema rather than
    silently ignoring a typo, and every numeric bound is capped at its named ceiling constant**
    (`AGENTS_MAX_BUFFER_LINES`, `AGENTS_MAX_BUFFER_BYTES`, `AGENTS_MAX_TOTAL_BUFFER_BYTES`,
    `AGENTS_MAX_LIVE_CHILDREN`, and a literal `64` for `max_retained_children`). Production:
    `packages/supervision/src/settings.ts:93-143`. Test: `packages/supervision/tests/unit/settings.test.ts:20-38`.
13. **The `agents` capability settings block is not plugin-contributable and merges last-wins.**
    Production: `packages/supervision/src/settings.ts:169-175`. Test: `packages/supervision/tests/unit/settings.test.ts:63-68`.
14. **`resolveAgentsLimits` treats an empty request `agents` object identically to an absent one, and
    a partial override merges field-by-field over the product defaults rather than replacing the
    whole block** — including that an explicit `0` is honoured rather than read as "unset".
    Production: `packages/supervision/src/limits.ts:22-38`. Test: `packages/supervision/tests/unit/limits.test.ts:29-46`.
15. **`registerBackgroundChild` records the `agent_registered` trace entry, and omits `profile`
    entirely (not as `undefined`), if and only if the registry actually accepted the registration** —
    a declined registration (registry returns `null`) records nothing. Production:
    `packages/supervision/src/spawn-child.ts:64-76`. Test: `packages/supervision/tests/component/spawn-child.test.ts:60-121`.
16. **A closed `SteerQueue` still allows an already-queued message to be drained** — closing never
    discards what a child could still take, it only refuses new pushes. Production:
    `packages/supervision/src/steer-queue.ts:30-50` (`push` checks `closed`; `drain` is unconditional). Test:
    `packages/supervision/tests/unit/steer-queue.test.ts:28-33`.

## 6. Failure modes and degradation

| Condition | Handling | Cited at |
|---|---|---|
| Registration while sealed | `null` return, `agents.spawn_refused` debug log, reason `"sealed"` | `packages/supervision/src/registry.ts:397-400` |
| Registration at the live-children ceiling | `null` return, same log, reason `"at_capacity"` | `:401-404` |
| `poll`/`stop`/`steer`/`has` on an unknown id | `null` (or `false` for `has`) — courtesy, not a throw, because a grandchild's id structurally cannot exist in this registry (doc comment `packages/supervision/src/registry.ts:5-9`) | `:474-476,496-498,519-521,444` |
| `waitAny` naming an id this registry never tracked | rejects the returned promise with `UnknownAgentError` (`code: "unknown_agent"`) | `packages/supervision/src/registry.ts:128-134,534-538` |
| A child's `control.stop`/`control.steer` port throws | caught, logged as `agents.stop_port_threw` (phase `"stop"` or `"teardown"`), the child is settled regardless of the throw | `packages/supervision/src/registry.ts:294-304,501-506,626-630` |
| A steer to a non-live or refusing child | `{ ok: false, status }`, logged as `agents.steer_refused`, never an exception | `packages/supervision/src/registry.ts:277-282,522-529` |
| An adopted background task rejects | caught and logged (`"agents: background child task rejected"`); never escapes as an unhandled rejection, via `suppressSecondaryRejection` on the derived promise | `packages/supervision/src/registry.ts:428-433,436-439` |
| Teardown outlives its grace window | the wait is bounded by a race against `scheduleTimeout`; whatever is still live past the grace is force-settled `"cancelled"` and reported in `abandoned` | `packages/supervision/src/registry.ts:638-655` |
| Notices exceeding `maxNoticesPerIteration` | truncated with a synthetic `"+N more…"` trailing notice (`progress: false`) rather than delivering all of them | `packages/supervision/src/registry.ts:599-615` |
| Non-finite / out-of-range programmatic limits (`maxLines`, `maxBytes`, `maxLiveChildren`, etc.) | every numeric limit is clamped through a `finite → fallback/max` guard rather than propagating `NaN`/`Infinity` into arithmetic | `packages/supervision/src/buffer.ts:31-34`, `packages/supervision/src/registry.ts:208-229` |
| Non-finite / out-of-range programmatic cursor or page budget passed to `AgentBuffer.read` | `offset` falls back to `0` when non-finite; `maxBytes` is clamped through `finiteIntAtMost(budget, 1, 65_536)` — independent of the buffer's own constructor-side clamp | `packages/supervision/src/buffer.ts:172-173` (test: `packages/supervision/tests/unit/buffer.test.ts:49-56,58-64,103-108`) |
| A single line larger than the byte budget | the newest UTF-8-safe tail is kept (`retainUtf8Tail`) and the dropped prefix is charged to `truncatedHead`; because the drop clears the whole prior ring rather than leaving an interior gap behind an older retained line, the retained line becomes the new head; a code point that cannot fit at all is dropped entirely rather than split | `packages/supervision/src/buffer.ts:71-79,152-165` (test: `packages/supervision/tests/unit/buffer.test.ts:163-174` for the single-line case, `:176-185` for "does not hide an oversized line's dropped prefix behind an older retained line") |
| A normal multi-line eviction under a tight byte cap, no oversized line involved | the byte bound evicts oldest-first and keeps at least the newest line | `packages/supervision/src/buffer.ts:116-133` (test: `packages/supervision/tests/unit/buffer.test.ts:152-161`) |
| `maxBytes === 0` on append | the whole ring is cleared and the offset still advances — the child produces no readable output but the stream stays consistent | `packages/supervision/src/buffer.ts:139-146` |

Nothing in this package retries a failed operation; every failure path above resolves synchronously
to a courtesy value (`null`, a refusal object, or a settled/logged state) rather than raising to its
caller, with the sole thrown type being `UnknownAgentError` from an explicit `waitAny` miss.

## 7. Coupling

**Depends on**: only `@clarvis/capability` at runtime (`packages/supervision/package.json:39-42`,
whose `dependencies` list it beside `zod` and nothing else) — for `portKey`/`PortKey`
(`packages/capability/src/services.ts:35-48`), the `CodedError` base
(used by `UnknownAgentError`), `NOOP_LOGGER`/`Logger` (`packages/capability/src/log.ts:48`),
`unref` (`packages/capability/src/unref.ts:7`), `suppressSecondaryRejection`
(`packages/capability/src/tasks.ts:63-70`), `isBuiltinTraceEntry`/`isBuiltinTraceEvent`
(`packages/capability/src/trace-kinds.ts:731`, `packages/capability/src/trace-events.ts:476`), and the
`AgentControl`/`AgentHandle`/`AgentKind`/`AgentRegistration`/`AgentRegistryPort`/`AgentSettlement`/
`AgentStatus`/`SettledStatus`/`WaitingOn` types from `packages/capability/src/agents-port.ts`. `zod`
is used only inside `settings.ts` and is not re-exported.

**Depended on by**: `@clarvis/loop` (`packages/loop/package.json:84`,
`packages/loop/tests/component/capability-run-context.test.ts:14`) and `@clarvis/workflows`
(`packages/workflows/package.json:56`, `packages/workflows/tests/component/dispatch.test.ts:4`), both
as static-value edges. `@clarvis/kernel` and `@clarvis/code` reach it transitively through
`loop`/`workflows` — neither declares it and neither names it anywhere in its own `src/`. No other
package imports it.

**What forces the direction**: `AGENT_REGISTRY_PORT` is a `PortKey<AgentRegistry>`
(`packages/supervision/src/agent-registry-port.ts:11`) published on a run's `CapabilityServices`
(`packages/capability/src/services.ts:47-80`) — a producer looks the port up rather than importing
this package's factory directly, and `AgentRegistryPort`'s own doc comment states registration is
"deliberately write-only: reading the tree is the supervision tools' job, not a producer's"
(`packages/capability/src/agents-port.ts:91-95`), which is what keeps a producer (`loop`, `workflows`) from depending on
anything beyond the three-method port. This package's own `registry.ts` doc comment states the
converse: "The registry knows nothing about delegation or workflows; producers register into it"
(`packages/supervision/src/registry.ts:11-12`) — nothing in `src/` imports `@clarvis/loop` or
`@clarvis/workflows`, and the manifest gives it no way to (`packages/supervision/package.json:39-42`).

`registerBackgroundChild` is explicitly a **shared skeleton**, not a full producer implementation —
its doc comment states only the identical part (build control plumbing, register, bail on `null`,
record `agent_registered`) is extracted, because what each producer does with the resulting task
(semaphore, compute-clock region, the run itself, its `settled()` mapping, producer-specific trace
events) differs enough that forcing it through a shared callback "would be more abstraction than the
duplication it replaces" (`packages/supervision/src/spawn-child.ts:6-12`). One such left-out responsibility is closing the
`SteerQueue` itself: `SteerQueue.close()`'s own doc comment describes "closing on settle"
(`packages/supervision/src/steer-queue.ts:25-26`), but no call site inside `@clarvis/supervision`'s `src/` ever invokes
`close()` — settling a `ChildRecord` (`packages/supervision/src/registry.ts:345-368`) never touches the queue. Closing the
queue is left to whichever producer holds the `BackgroundChildSpawn.steerQueue` that
`registerBackgroundChild` handed back, at the moment that producer settles its own child.

## 8. Open questions

- **Who emits `agent_stopped`, `agent_steered` and `agent_finish_nudge`.** These three `TraceKind`s
  are declared in the same open union as `agent_registered`
  (`packages/capability/src/trace-kinds.ts:44-46,664-666`), but nothing in
  `packages/supervision/src/**` writes them — `registerBackgroundChild` is the package's only
  `trace.record` call, and it emits `agent_registered` alone (`packages/supervision/src/spawn-child.ts:68-76`). Their
  producer belongs to a consumer of this registry (most likely [loop-delegation-and-subagents](../engine/delegation-and-subagents.md) or
  [workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md)), out of this document's scope.
- **Where `AgentsLimits.awaitTimeoutMs` and `.finishNudges` are actually consumed.** Both are resolved
  by `resolveAgentsLimits` (`packages/supervision/src/limits.ts:29,36`) and carried on every `AgentsLimits` value
  (`packages/supervision/src/registry.ts:55,65`), but no function inside `packages/supervision/src/**` reads either field —
  `registry.ts` never references `limits.awaitTimeoutMs` or `limits.finishNudges`. A consumer outside
  this package (the `await_agents` tool handler for the timeout; a finish-nudge counter for the
  nudge count) must read them directly off the resolved `AgentsLimits` object it already holds. This
  package only guarantees the value is correctly resolved and typed, not how it is spent.
  Belongs to [loop-delegation-and-subagents](../engine/delegation-and-subagents.md).
- **Whether the `AgentRegistryOptions.onActivity` callback's contract (fired on every `touch`, i.e.
  every buffer append and every `waiting`/`steer` mutation — `packages/supervision/src/registry.ts:306-309,332,381,527`) is
  exactly what a compute-clock consumer expects**, beyond the one test that counts calls
  (`packages/supervision/tests/component/registry.test.ts:255-266`). The consumer side (a run's stall watchdog) is outside this package's
  scope.
- **The reasoning behind specific numeric defaults** (why `8` live children rather than another
  number, why a `120_000`ms await timeout) is not stated anywhere in `settings.ts` beyond the general
  rationale that buffer bounds protect the parent's memory and the live/notice/failure ceilings
  protect its context (`packages/supervision/src/settings.ts:47-51`). No test or comment gives a numeric justification beyond
  that framing, so the specific values are treated as product decisions the code does not explain.
