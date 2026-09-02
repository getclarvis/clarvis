# Starting a run, assembling its request, and projecting its events

> Implemented at `packages/kernel/src/runs/**`. Every claim below is anchored to a file and line.
> Open questions are collected in the final section.

## 1. Purpose

`packages/kernel/src/runs/` is the layer that turns the protocol's `RunService`
(`RunService` in `packages/protocol/src/runs.ts`) into calls on the engine's `executeRun`
(`packages/kernel/src/runs/run-service.ts:114-115`), and turns everything the engine and its capabilities
emit back into the protocol's closed `RunEvent` union (`packages/protocol/src/runs.ts`, `RunEvent`). It owns
four distinct jobs:

1. **Admission and identity** — assigning or accepting an `execution_id`, refusing a duplicate for the
   same owner before any work starts, and holding that reservation until the last late event has been
    delivered (`packages/kernel/src/runs/run-service.ts:137-160`).
2. **Request assembly** — reading merged `settings.json` plus the agent markdown records and producing
   the untyped body the engine validates, including the transitive `can_spawn` profile graph, the MCP
   servers those profiles reference, the budget, and the `plans`/`agents` params
   (`packages/kernel/src/runs/settings-assembler.ts:352-496`).
3. **Run-scoped machinery** — one `RunHandle` per run, owning the buffered event stream, the steering
   and compaction queues, cancellation, the elicitation bridge, the bounded memory-ingest close grace,
   and the drop report (`packages/kernel/src/runs/managed-run.ts:147-336`).
4. **Projection** — the two mappers `engineEventToProto` (persisted engine trace) and
   `capabilityEventToProto` (live capability channel) (`packages/kernel/src/runs/map-events.ts:389`, `:335`), the result/detail
   mappers (`packages/kernel/src/runs/map-result.ts:86,116,126,153`), the engine/protocol message conversion
   (`packages/kernel/src/runs/map-message.ts:40,50,56`), and the declarative per-event policy table that says which of those
   two paths owns each event and whether it survives a restart (`RUN_EVENT_POLICY`).

`RUN_EVENT_POLICY` is a transport/durability policy, not a TUI publication policy. Code classifies
the resulting closed `RunEvent` union again for live-frontier versus committed-history ownership in
[code-transcript-stability.md](code-transcript-stability.md#41-exhaustive-event-disposition); it may
not change which mapper emits an event or whether that event survives restart.

The subsystem is the only place where the engine's vocabulary (`TraceEvent`, `RunResponse`,
`StoredExecution`, engine `Message`) and the protocol's vocabulary (`RunEvent`, `RunResult`,
`RunDetail`, protocol `Message`) meet. A client of `@clarvis/protocol` never sees an engine type,
because `@clarvis/protocol` has no dependency on `@clarvis/loop` and these mappers are what stands
between them.

## 2. Surface

### 2.1 Exported from `@clarvis/kernel` (root entrypoint)

| Symbol | Kind | Signature / shape | Source |
|---|---|---|---|
| `createRunService` | value | `(cfg: RunServiceConfig) => RunService` | `packages/kernel/src/runs/run-service.ts:95`, re-exported at `packages/kernel/src/index.ts:8` |
| `RunServiceConfig` | type | see §2.3 | `packages/kernel/src/runs/run-service.ts:30`, `packages/kernel/src/index.ts:9` |
| `RunRequestAssembler` | type | `(params: StartRunParams & { execution_id: string }) => unknown` | `packages/kernel/src/runs/run-service.ts:27` |
| `createManagedRun` | value | `(spec: ManagedRunSpec) => RunHandle` | `packages/kernel/src/runs/managed-run.ts:159`, `packages/kernel/src/index.ts:58` |
| `ManagedRunContext`, `ManagedRunSpec` | type | see §2.4 | `packages/kernel/src/runs/managed-run.ts:28`, `:44` |
| `createSettingsRunAssembler` | value | `(store: ConfigStore, options?: SettingsAssemblerOptions) => RunRequestAssembler` | `packages/kernel/src/runs/settings-assembler.ts:363`, `packages/kernel/src/index.ts:60` |
| `SettingsAssemblerOptions` | type | see §2.5 | `packages/kernel/src/runs/settings-assembler.ts:33` |

### 2.2 Exported from `@clarvis/kernel/policy`

`packages/kernel/src/policy.ts:1` describes itself as "Guard, redaction, tool identity, and run-event
policy". The runs-owned half:

| Symbol | Kind | Source | Line in `policy.ts` |
|---|---|---|---|
| `capabilityEventToProto`, `engineEventToProto` | value | `packages/kernel/src/runs/map-events.ts:335,389` | `:10` |
| `isIngestPending` | value | `packages/kernel/src/runs/memory-ingest-phase.ts:23` | `:11` |
| `RUN_EVENT_POLICY` | value | `packages/kernel/src/runs/event-policy.ts` | `:12` |
| `coalesceRunEvents`, `sizeOfRunEvent`, `sizeOfCoalescedRunEvent` | value | `packages/kernel/src/runs/coalesce-events.ts:223,16,172` | `:16-172` |
| `RunEventDurability`, `RunEventMapper`, `RunEventPolicy`, `RunEventSource` | type | `packages/kernel/src/runs/event-policy.ts:7,10,13,4` | `:18-23` |
| `deriveRunEventSpan`, `iterationSpanId` | value | `packages/kernel/src/runs/run-event-span.ts` | `:28` |
| `RunEventSpan`, `SpanPhase`, `SpanKind` | type | `packages/kernel/src/runs/run-event-span.ts` | `:25` |
| `engineResultToProto`, `storedToDetail`, `summaryToProto`, `failedResult` | value | `packages/kernel/src/runs/map-result.ts:86,153,126,116` | `:26-31` |
| `engineMessagesToProto`, `protoMessagesToEngine`, `protoSteerToEngineContent` | value | `packages/kernel/src/runs/map-message.ts:40,56,50` | `packages/kernel/src/policy.ts:32-36` |

`packages/kernel/tests/architecture/public-surface.test.ts:6-20` pins the package to exactly six
entrypoints (`.`, `./bootstrap`, `./config`, `./local`, `./logger`, `./policy`), so `./policy` is a deliberate,
named surface rather than a barrel.

Not exported from any entrypoint: `isDroppableRunEvent` and `DEFAULT_RUN_EVENT_BUFFER*`
(`packages/kernel/src/runs/coalesce-events.ts:265,10,13`) — `packages/kernel/src/transport/client.ts:43-50` imports
`isDroppableRunEvent` by relative path, while `@clarvis/server` re-derives the same verdict from the
exported table (`packages/server/src/mcp/notify.ts:144`).

Also internal: `createManagedRunWithRuntime`, `ManagedRunRuntime`, `ManagedRunTimer`
(`packages/kernel/src/runs/managed-run.ts:170,87,76`), marked `@internal` with the stated reason that "hosts configure policy
through `ManagedRunSpec`, not by replacing the kernel's clock" (`packages/kernel/src/runs/managed-run.ts:80-89`);
`inspectCoalescedRunEvent` (`packages/kernel/src/runs/coalesce-events.ts:158`); `normalizeRunPagination` (`packages/kernel/src/runs/pagination.ts:8`);
`createSteerQueue` (`packages/kernel/src/runs/steer-queue.ts:16`).

### 2.3 `RunServiceConfig` (`packages/kernel/src/runs/run-service.ts:30-67`)

| Field | Type | Meaning |
|---|---|---|
| `deps` | `ExecuteRunDeps` | engine deps; `deps.traceStore` also backs `get`/`list`/`delete` (`:31-33`, used at `:99`) |
| `owner` | `string` | owner key every store read/write and `executeRun` call is scoped to (`:34-35`, `:117`) |
| `assembleRunRequest` | `RunRequestAssembler` | builds the engine body (`:36-37`, called at `:113`) |
| `isManagerRun?` | `(params: StartRunParams) => boolean` | routes to the workflow manager path (`:38-42`, `:104`) |
| `runManagerWorkflow?` | `(params & { execution_id }) => RunHandle` | the manager path (`:43-45`, `:105`) |
| `ingestGraceMs?` | `number` | sliding post-run wait; defaults to `DEFAULT_INGEST_CLOSE_GRACE_MS` (`:46-49`, `:98`) |
| `eventBuffer?` | `EventStreamOptions<RunEvent>` | backpressure overrides, merged field-by-field over kernel defaults (`:50-62`, used at `:109`) |
| `lifecycle?` | `KernelLifecycle` | owns active runs; rejects starts while closing (`:63-64`, used at `:111`) |
| `logger?` | `Logger` | where an unmapped event is reported; defaults `NOOP_LOGGER` (`:65-66`, `:97`) |

### 2.4 `ManagedRunSpec` / `ManagedRunContext` (`packages/kernel/src/runs/managed-run.ts:28-61`)

`ManagedRunContext` is what the execution callback receives: `executionId`, `signal`, `elicit`,
`steer`, `compaction`, `emit` (`:30-40`). `ManagedRunSpec` is what a host plugs in: `executionId`,
`execute(context)`, optional `observe(event)`, `settle(result)`, `eventBuffer`, `ingestGraceMs`,
`ingestMaxWaitMs`, `lifecycle` (`:45-60`). Two producers use it — `packages/kernel/src/runs/run-service.ts:107-134` for an
ordinary run and `runManagerWorkflow` in
`packages/kernel/src/workflows/workflows-service.ts` for a workflow manager run, the latter supplying
`observe`/`settle` to maintain its workflow record.

### 2.5 `SettingsAssemblerOptions` (`packages/kernel/src/runs/settings-assembler.ts:33-65`)

| Field | Default | Effect |
|---|---|---|
| `defaultModel?` | none | model when neither `default_model` nor frontmatter names one (`:35`, `:266-269`) |
| `defaultIterationLimit?` | `20` | applied when frontmatter omits `iteration_limit` (`:36-38`, `:290-293`) |
| `defaultAgent?` | none | entry agent when the request names none (`:39-40`, `:408-410`) |
| `fallbackTokenLimit?` | `160_000_000` (`FALLBACK_TOTAL_TOKEN_LIMIT`, `:129`) | fallback budget size (`:367-370`) |
| `fallbackOnExceed?` | `"escalate"` (`FALLBACK_ON_EXCEED`, `:132`) | fallback budget `on_exceed` (`:367-370`) |
| `skills?` | none | `SkillsProvider`; without it any `skill` start param is refused (`:52-54`, `:97-105`) |
| `skillPlansMode?` | none | trusted Plans-mode override for a skill, keyed by name + root source (`:55-56`, `:400-406`) |

### 2.6 Protocol shapes this subsystem produces and consumes

`StartRunParams` (`packages/protocol/src/runs.ts:70-115`) is the input; `RunHandle`
(`:700-756`), `RunResult` (`:162-172`), `RunSummary` (`:202-214`), `RunDetail` (`:235-255`) and
`RunEvent` is the output union. `RunHandle` has two settle points that are deliberately
distinct: `done` "Resolves when execution ends; it does not imply that `events` has closed"
(`:740-741`) and `closed` "Resolves after execution and bounded post-run event delivery both finish"
(`:750-755`).

Managed and remote handles additionally project the optional `RunHandle.buffered()` counters from
their event streams. `EventStream.stats()` maintains item count, estimated bytes and dropped count
incrementally; collecting a host memory ledger is therefore O(1) and does not inspect the buffered
payloads. Production: `packages/kernel/src/core/event-stream.ts` (`EventStream.stats`),
`packages/kernel/src/runs/managed-run.ts` (`buffered`) and
`packages/kernel/src/transport/client.ts` (`buffered`). Test:
`packages/kernel/tests/unit/event-stream.test.ts` ("reports O(1) buffered item, byte and drop
counters").

Consumers must preserve the same distinction. `@clarvis/code` releases composer/steering ownership
after `done`, while retaining `closed` only as a physical-work lease for the event pump and post-run
memory notices. Production and test ownership live in
[`code-run-host.md`](code-run-host.md#42-runmanaged--the-single-funnel-packagescodesrcrun-hostts602-718).

## 3. Data and formats

### 3.1 Identifiers

| Identifier | Format | Producer |
|---|---|---|
| `execution_id` | `exec_<uuidv4>` when generated | `generateExecutionId` (`packages/trace/src/execution-id.ts:9`), called at `packages/kernel/src/runs/run-service.ts:139` when `params.execution_id` is absent. A client-supplied id is used verbatim. |
| elicitation id | `<executionId>:elicit:<n>` | `packages/kernel/src/runs/elicit-bridge.ts:51` (delegated document; cited for the id format only) |
| iteration span id | `lead:<n>`, `<subagentId>:<n>`, or `subagent-unknown:<n>` | `iterationSpanId` |
| tool span id | the event's `call_id`; `<agent>:tool` when a `tool_call` carries none | `deriveRunEventSpan` |
| sub-agent span id | `subagent:<delegation_id>` | `deriveRunEventSpan` |
| workflow span id | `workflow:<run_id>` | `deriveRunEventSpan` |

### 3.2 The engine run request body

`createSettingsRunAssembler` returns an object literal typed `unknown` (`RunRequestAssembler`,
`packages/kernel/src/runs/run-service.ts:27`), which the engine then validates. Its keys, in the order the code writes them
(`packages/kernel/src/runs/settings-assembler.ts:453-510`):

| Key | Value | Line |
|---|---|---|
| `messages` | `protoMessagesToEngine(params.messages)` then, for a skill run, one appended `{ role: "user", content: skillRun.seed }` | `:454-457` |
| `providers` | `merged.providers ?? []` | `:458` |
| `servers` | every active-plugin MCP namespace plus each operator MCP namespace referenced by a profile; plugin entries carry `auto_tools: true` | `:432-447`, `:459` |
| `profiles` | the transitive `can_spawn` closure, deduplicated | `:417-430`, `:460` |
| `entry` | resolved agent name | `:461` |
| `budget` | entry-agent frontmatter `budget`, else `merged.budget`, else the fallback, with `on_exceed` completed | `:449-465` |
| `vision_model` | `merged.default_vision_model`, only when a string | `:466-468` |
| `execution_id`, `continue_from`, `prompt_cache_key`, `output_schema`, `guard_mode`, `guard_judge`, `memory`, `task` | straight passthrough, present only when the param is | `:469-481`, `:489-490` |
| `prompt_cache_ttl` | request value, else `"1h"` when `guardParksOnHuman(...)`, else absent | `:474-478` |
| `hook_user_prompt_expansion` | only for a resolved user-invoked skill; `{ command_name }` is bare for operator/workspace skills and `<plugin>:<skill>` for plugin skills | `:482-488` |
| `plans` | request value, else settings block with the skill-mode override, else settings block, else absent | `:491-506` |
| `agents` | present only when `merged.agents` is a non-null object | `:507-509` |

Note what is **not** forwarded: the `skill` key itself never reaches the engine
(`packages/kernel/src/runs/settings-assembler.ts:359-361`; pinned by `packages/kernel/tests/component/settings-assembler.test.ts:548-560`),
and a `plans` block's `provider` sub-object is stripped by projection
(`plansBlockToParam`, `:146-162`; pinned at `packages/kernel/tests/component/settings-assembler.test.ts:133-151`).

An engine `AgentProfile` is built by `buildProfile` (`:258-324`) with required `name`, `model`,
`tools`, `iteration_limit` and twelve conditionally spread optional fields (`grants`, `can_spawn`,
`default_spawn`, `orchestration`, `base_prompt`, `description`, `reasoning_effort`,
`reasoning_summary`, `retry`, `compaction`, `stagnation_threshold`, `call_timeout_ms`). For the entry
profile only, `base_prompt` is the agent prompt followed by the effective global and workspace context
documents, each rendered as `## Context: <scope>/<filename>` (`:276-288`, `:426-427`).

An MCP entry is translated, not forwarded: `toEngineServer` parses with `mcpServerSettingsSchema` and
converts through `settingsServerToEngine` (`:219-235`). The recorded reason is that
"`settings.json` spells the transport `type` while the engine's strict request schema spells it
`transport`, so an entry forwarded verbatim is rejected downstream as an unrecognized key and takes
the whole run with it" (`:211-214`). The docstring continues, immediately after: "Failing here —
loudly, naming the server — is also why a bad entry is never dropped silently: a dropped server
surfaces much later as `profile '...' lists tool '...', which is not in the tool pool`, which points
at the agent rather than at the typo" (`:214-217`). The test comment names it as a shipped defect: "P1 lived here …
every run referencing `<server>.<tool>` died in `validateBody` with `unrecognized_keys`"
(`packages/kernel/tests/component/settings-assembler.test.ts:697-701`), and the round trip is asserted at `:715-720`.

### 3.3 `RUN_EVENT_POLICY` — the per-event matrix

`RUN_EVENT_POLICY` in `packages/kernel/src/runs/event-policy.ts` is a `const` object with
`satisfies Record<RunEvent["type"], RunEventPolicy>` (`:94`). Its stated mechanism: the `satisfies`
clause "makes every protocol event addition fail compilation until its replay and drop behavior is
classified" (`:53-54`). Each entry carries `sources`, `durability`, `mapper`, `coalesce`, `droppable`
(`:13-24`). Two constructors build the entries: `persisted(mapper="engine",
sources=["engine_trace"])` always sets `coalesce: false, droppable: false` (`:26-35`), and
`live(mapper, sources, coalesce=false, droppable=false)` sets `durability: "live_only"` (`:37-48`).

Complete table, transcribed from `:57-93`:

| Event type | sources | durability | mapper | coalesce | droppable |
|---|---|---|---|---|---|
| `run_started` | engine_trace | persisted | engine | false | false |
| `run_ended` | engine_trace | persisted | engine | false | false |
| `iteration_started` | engine_trace | persisted | engine | false | false |
| `iteration_completed` | engine_trace | persisted | engine | false | false |
| `tool_call_started` | engine_trace | persisted | engine | false | false |
| `tool_call` | engine_trace | persisted | engine | false | false |
| `tool_output_delta` | engine_trace | **live_only** | engine | `tool_output_delta` | **true** |
| `tool_input_delta` | engine_trace | **live_only** | engine | `tool_input_delta` | **true** |
| `reasoning` | engine_trace | persisted | engine | false | false |
| `text_delta` | engine_trace | **live_only** | engine | `text_delta` | **true** |
| `model_error` | engine_trace | persisted | engine | false | false |
| `model_retry` | engine_trace | persisted | engine | false | false |
| `delegation_created` | engine_trace, capability_channel | persisted | engine | false | false |
| `delegation_started` | engine_trace, capability_channel | persisted | engine | false | false |
| `delegation_completed` | engine_trace, capability_channel | persisted | engine | false | false |
| `delegation_failed` | engine_trace, capability_channel | persisted | engine | false | false |
| `workflow_run_started` | engine_trace, workflow | persisted | engine | false | false |
| `workflow_title_updated` | workflow | live_only | **workflow** | false | false |
| `workflow_sequence_state` | workflow | live_only | **workflow** | false | false |
| `workflow_run_progress` | workflow | live_only | **workflow** | false | false |
| `workflow_run_completed` | engine_trace, workflow | persisted | engine | false | false |
| `workflow_run_failed` | engine_trace, workflow | persisted | engine | false | false |
| `plan_created` | capability_channel | live_only | capability | false | false |
| `plan_updated` | capability_channel | live_only | capability | false | false |
| `plan_removed` | capability_channel | live_only | capability | false | false |
| `plan_review_requested` | capability_channel | live_only | capability | false | false |
| `plan_review_resolved` | capability_channel | live_only | capability | false | false |
| `soft_limit_check` | engine_trace | persisted | engine | false | false |
| `compaction_started` | engine_trace | **live_only** | engine | false | false |
| `compaction` | engine_trace | persisted | engine | false | false |
| `compaction_skipped` | engine_trace | persisted | engine | false | false |
| `vision_analysis` | engine_trace | persisted | engine | false | false |
| `elicitation_requested` | engine_trace | persisted | engine | false | false |
| `elicitation_resolved` | engine_trace | persisted | engine | false | false |
| `steering_applied` | engine_trace | persisted | engine | false | false |
| `memory_ingest` | capability_channel | live_only | capability | false | false |
| `capability_event` | capability_channel | live_only | capability | false | false |
| `events_dropped` | **kernel_derived** | live_only | **managed_run** | false | false |
| `mcp_degraded` | engine_trace | persisted | engine | false | false |

Read as a live-versus-rehydration matrix: fifteen types are `live_only` and therefore absent from a
restored run journal — the three deltas, three workflow state/metadata/progress events, five plan
events, `compaction_started`, `memory_ingest`, `capability_event`, and `events_dropped`. The latest
workflow sequence state remains separately durable in the workflow store. This is consistent with the
rehydration path, which reads only `s.trace.events` (`packages/kernel/src/runs/map-result.ts:193`), and with the integration
assertion that a stored run has no `tool_output_delta` but does have the closing `tool_call`
(`packages/kernel/tests/integration/run-service.smoke.test.ts:135-137`).

### 3.4 The `events_dropped` notice

Built in `packages/kernel/src/runs/managed-run.ts:217-223` as `{ type: "events_dropped", at: runtime.now(), dropped }`.
`dropped` is written twice — the pre-push snapshot, then re-read from the stream after the push
(`:222-223`), because pushing the notice into a full buffer can itself evict a further victim. A
concrete instance is asserted at `packages/kernel/tests/unit/managed-run.test.ts:431-434`: with
`eventBuffer: { maxBuffered: 2 }` and three pushed events, the consumer sees exactly
`[{ run_ended }, { type: "events_dropped", at: 1_000, dropped: 2 }]`.

### 3.5 Capability-event wire bounds

`packages/kernel/src/runs/map-events.ts:72-74` fixes the generic envelope's limits: `MAX_CAPABILITY_EVENT_DETAIL_BYTES = 64 *
1024` (exported), depth 32, 4 096 nodes. Text crossing the boundary passes `terminalSafe`
(`:82-84` — `sanitizeText`, then the ANSI-escape regex, then remaining C0/C1 controls) and labels
additionally through `terminalLabel`, which slices to 4 096 chars then to 256 code points (`:86-88`).
Over-budget detail becomes a string ending in a truncation marker, cut on a UTF-8 boundary
(`:213-215`, `utf8Prefix` at `:179-189`).

Typed capability projections are validated by closed zod schemas before being trusted
(`capabilityRunEventSchemas`, `:123-142`): `planProjectionSchema` is `.strip()` (`:121`) so
internal fields such as `objective`/`context` are removed rather than widening the DTO (`:104-108`;
pinned at `packages/kernel/tests/unit/map-events.test.ts:163-192`), `plan_removed` is `.strict()` (`:145`), and
`plan_updated`/`plan_review_resolved` extend it with `change`/`outcome` enums (`:133`, `:147-149`).
`PLAN_UPDATE_CHANGES` — `plan_updated`'s `change` enum — is four-valued: `content`, `task`,
`status`, `recovery` (`:122`), exactly the set `@clarvis/plan` emits. `plan_review_resolved`'s
`outcome` enum is three-valued: `approved`, `changes_requested`, `cancelled` (`:148`). Every plan
projection's `tasks` array is `planTaskSchema` (`:90-102`, `.strict()`): `id`, `title`, `status` (a
six-value enum — `pending`, `in_progress`, `returned`, `done`, `abandoned`, `failed`), and optional
`detail`, `exit`, `assignee`, `result`, `error`, `reason`.

The memory notice is a five-arm discriminated union on `phase`
(`started`/`queued`/`done`/`failed`/`blocked`, `:152-184`), each arm `.strict()`:

| Phase | Fields (beyond `execution_id`, `phase`) |
|---|---|
| `started` | none |
| `queued` | `indexer_run_id?` |
| `done` | `written?`, `deleted?`, `reindexed?`, `skipped?`, `note?`, `indexer_run_id?` |
| `failed` | `error?`, `indexer_run_id?` |
| `blocked` | `note?` |

`indexer_run_id` is optional on `queued`/`done`/`failed` but absent from the `started`/`blocked` arms
entirely — an extra field on either of those two is rejected by the arm's `.strict()`, not merely
ignored.

### 3.6 `RunDetail` hydration

`storedToDetail` (`packages/kernel/src/runs/map-result.ts:153-178`) builds the detail from a `StoredExecution`:
`result` from `engineResultToProto`, then usage token totals **overwritten** from the stored row's
`total_input_tokens`/`total_output_tokens`/`total_cached_tokens` (`:154-161`), `plan_ref` from
`capability_state` (delegated; `packages/kernel/src/runs/plan-ref.ts:62`), `active_task` likewise (`packages/kernel/src/runs/task-binding.ts:6`),
`extension_profile` validated from opaque `host_metadata.extension_profile`, `recovery` forwarded verbatim when
present, `messages` via `engineMessagesToProto`, and `events` via `rehydrateEvents`.

`extensionProfileFromHostMetadata` accepts only a qualified Extension Profile id and a lowercase SHA-256
fingerprint, then projects exactly those two strings (`packages/kernel/src/runs/map-result.ts:25-41`).
Malformed or extra host metadata is not reflected into the protocol DTO.

`engineResultToProto`'s `liveUsage` (`:50-57`) maps each `by_agent` row through `mapPerAgent`
(`:33-45`), which renames the engine's `type` to protocol `role` and includes `iterations` only when
the engine recorded it **and** `a.type !== "vision"` — a vision agent's usage row never carries
`iterations`, even one the engine did set.

## 4. Behavior

### 4.1 `RunService.start` (`packages/kernel/src/runs/run-service.ts:129-150`)

1. `executionId = params.execution_id ?? generateExecutionId()` (`:135`).
2. Reject with `kernelError("conflict", "run '<id>' already exists for this owner")` if the id is in
   the in-process `activeIds` set **or** `store.existsForOwner(owner, executionId)` returns true
   (`:136-138`). No engine work has happened at this point.
3. `activeIds.add(executionId)` (`:139`).
4. `startReserved(params, executionId)` (`:141`):
   - if `runManagerWorkflow` is configured **and** `isManagerRun?.(params) === true`, hand the whole
     thing to the workflow manager and return its handle (`:101-103`);
   - otherwise `createManagedRun({ executionId, eventBuffer, ingestGraceMs, lifecycle, execute })`
     (`:104-130`).
5. Register the release on `handle.closed`, **not** `handle.done` (`:149`). The stated reason, in the
   code comment: "`done` settles before the managed stream's optional ingest grace. Keep the id
   reserved until both model execution and event delivery finish, otherwise a same-id retry can
   overlap late capability events and write into the first run's trace/lifecycle scope" (`:145-148`).
6. If handle construction throws synchronously, release the reservation and rethrow (`:151-154`).

Assembly happens **inside** `execute`, not in `start` (`:110`), so an assembly failure (unknown agent,
malformed MCP entry, no resolvable model) never rejects `start` — it settles `done` as a failed
result. `packages/kernel/tests/integration/run-service.smoke.test.ts:204-269` pins exactly that: starting with
`agent: "ghost"` yields a handle whose `done` is `{ status: "failed", error.code: "not_found" }`.

### 4.1a Settled-context inspection and compaction

`RunService.context` returns only a token estimate, presence flag, and optional target-window fit
verdict. `RunService.compact` queues through the live handle while it exists; otherwise it loads the
owner-scoped persisted execution. Guided compaction uses the stored request and LLM, then atomically
replaces `final_context`. A mechanical target performs no model call and persists only after the
replacement fits. Production: `createRunService` in `packages/kernel/src/runs/run-service.ts`.
Test: `packages/kernel/tests/unit/run-service-lifecycle.test.ts`.

### 4.2 Assembly (`packages/kernel/src/runs/settings-assembler.ts:380-494`)

Per call, in order:

1. `store.readSettings().merged` (`:364`).
2. `store.readContext` is called for `"global"` and `"workspace"`; absent scopes contribute nothing,
   and each non-null effective document is retained in that order (`:365-368`). The store's
   first-existing-wins rule means each scope contributes `CLARVIS.md` when present, otherwise
   `AGENTS.md`; the two candidates from one scope are never both injected.
3. `resolveSkillRun(params.skill, options.skills)` (`:370`): loads the skill, refuses with
   `not_found` when there is no skills source, no such skill, or `userInvocable` is false
   (`:93-96`); reads the skill's own `agent` via `skillEntryAgent`
   (`packages/kernel/src/skills/render-skill-prompt.ts:79`); renders the seed with
   `renderSkillPrompt` (`:211`). The assembler always (re-)renders and appends its own copy of the
   seed (§3.2's `messages` row) regardless of what the caller sent — its docstring states the caller
   contract this implies: a host that already rendered the skill's seed into the current turn's
   `messages` for display must still forward the `skill` start param, and must leave that local copy
   out of `messages`, or the run doubles the seed (`:82-87`).
4. `skillPlansMode` is consulted only when both a `skill` param and a resolved skill exist
   (`:371-377`), and is passed the skill's root `source` for provenance.
   The same resolved invocation produces `hook_user_prompt_expansion.command_name`: a plugin source
   contributes its install identity as `<plugin>:<skill>`, while other sources keep the skill name
   bare. No field is emitted for an ordinary prompt or a model-initiated `load_skill` call
   (`hookCommandName`, `:216-223`; literal projection `:460-466`).
5. Entry agent = `skillRun?.agent ?? params.agent ?? options.defaultAgent`; `invalid_request` when
   all three are absent (`:379-382`).
6. `store.readEffectiveAgent(agentName)`; `not_found` when null (`:383-386`).
7. Breadth-first walk over `can_spawn` with a `seen` set; a child that resolves to `null` is
   **skipped, not fatal** (`:417-430`; pinned at `packages/kernel/tests/component/settings-assembler.test.ts:70-85`). Only the first
   name is treated as the entry, and only that profile receives the context documents (`:397-398`).
8. Server selection starts with every namespace returned by `pluginMcpServerNames`, then resolves
   each profile tool against the longest exact registered `<namespace>.` prefix. This preserves
   namespaced plugins whose compatible package name itself contains dots. A missing key contributes
   nothing. Active plugin entries carry `auto_tools: true`; operator entries remain profile-scoped
   (`createSettingsRunAssembler`).
9. Budget: entry frontmatter `budget` if it is a non-null object, else `merged.budget`, else the
   fallback; `on_exceed` filled from the fallback when the declared budget omits it (`:415-417`,
   `:354-362`, `:428-431`).
10. The literal is returned (`:419-469`).

**Entry versus child model/effort resolution is deliberately asymmetric** (`buildProfile`, `:239-241`
and `:259-261`): for the entry profile the merged `default_model` / `default_reasoning_effort` win
over frontmatter; for a spawned child the frontmatter wins and the defaults are the fallback. The
docstring states the intent — "The user's `/model` and `/effort` defaults are authoritative for the
entry profile. A spawned child instead keeps an explicit model or effort from its own profile, falling
back to those defaults only when it declares none. This distinction lets changing the current run
model do what the user asked without flattening a heterogeneous sub-agent fleet" (`:223-227`) — and
`packages/kernel/tests/component/settings-assembler.test.ts:219-240` pins both halves.

`plansBlockToParam` **materializes** `mode` and `retention`, and additionally carries an optional
`pending_task_nudges` through when the block's value is a non-negative integer, dropping it otherwise
(`:126-142`, `:133`, `:138-140`) — while `agentsBlockToParam` **omits** every unset field (`:172-179`).
The code names the difference: the plans default would otherwise be unreachable behind the plan
store's own fallback (`:118-124`), whereas "the loop owns the defaults outright (`AGENTS_DEFAULTS`),
so an absent field must stay absent — writing one out would freeze today's default into every run
request and make a later change to it invisible" (`:161-170`). `agentsBlockToParam` recognizes exactly
ten numeric fields, `AGENTS_FIELDS` (`:145-156`): `buffer_lines`, `buffer_bytes`,
`max_total_buffer_bytes`, `poll_max_bytes`, `await_timeout_ms`, `max_live_children`,
`max_retained_children`, `max_notices_per_iteration`, `max_consecutive_failed_children`,
`finish_nudges` — each carried through only when it is a non-negative integer.

`prompt_cache_ttl` derivation: an explicit request value wins; otherwise
`guardParksOnHuman(params.guard_mode, merged.guard, params.guard_judge !== undefined)`
(`packages/kernel/src/guard/resolver.ts:80-87`) yields `"1h"`, and nothing is emitted when it is
false (`:424-428`). The guard predicate returns true for mode `on` and for mode `auto` with no judge
(`packages/kernel/src/guard/resolver.ts:86`). `packages/kernel/tests/component/settings-assembler.test.ts:544-610` pins all four cases, including that an
unconfigured host derives `"1h"` because the guard defaults to on.

### 4.3 Managed-run construction (`packages/kernel/src/runs/managed-run.ts:158-336`)

Order of construction, which matters because later steps capture earlier ones:

| Step | Line | Effect |
|---|---|---|
| `AbortController` | `:162` | backs `context.signal` and `handle.cancel` |
| `resolveEventBuffer(spec.eventBuffer)` | `:163` | merges host overrides over kernel defaults, then wraps `droppable` |
| `createEventStream` with `onSaturated` / `onAbandoned` | `:164-174` | a saturated stream aborts the run with `unavailable`; an abandoned one aborts with `cancelled` |
| steer queue, compaction queue, elicit bridge | `:175-177` | run-scoped control channels |
| ingest bounds | `:178-192` | see §4.5 |
| `emitRelay.connect(...)` | `:204-212` | push, then observe, then ingest bookkeeping |
| lifecycle registration | `:280-288` | close means abort, await `executionStarted`, await `done`, force-settle ingest, await `closed` |
| the `done` async IIFE | `:290-310` | executes and settles |
| `resolveExecutionStarted()` | `:311` | released synchronously after `done` is constructed |

`resolveEventBuffer` (`:115-135`) merges each field independently with `??`, so a `0` supplied for
`maxBuffered` survives (disabling only the count cap and leaving `DEFAULT_RUN_EVENT_BUFFER_BYTES` in
force — `packages/kernel/src/runs/run-service.ts:47-49` says both caps must be `0` for an unbounded override). `sizeOfCoalesced`
defaults to `sizeOfCoalescedRunEvent` only when the host supplied neither `sizeOf` nor `coalesce`
(`:122-126`). Finally the effective `droppable` is wrapped so `events_dropped` can never be a victim
(`:132-134`).

The emit path (`:204-212`) is: `stream.push(event)`, then `spec.observe?.(event)`, then
`ingestPendingAfter(event)`; a non-`undefined` verdict sets `ingestPending` and either renews the
sliding wait or settles it.

### 4.4 The `done` promise (`packages/kernel/src/runs/managed-run.ts:290-310`)

| Situation | Result |
|---|---|
| lifecycle exists and `state !== "open"` | throws `kernelError("unavailable", "kernel is closing")` before `execute` runs (`:293-294`) |
| `execute` throws or rejects | `failedResult(executionId, toKernelError(error))` (`:297-299`) |
| `settle` throws | the settle failure replaces the result: `failedResult(...)` (`:302-304`) |
| always | `steer.close()`, `compaction.close()`, `closeStream()` in `finally` (`:305-309`) |

`packages/kernel/tests/unit/managed-run.test.ts:123-154` pins both failure conversions (code `internal`, messages
`"execution exploded"` and `"settlement exploded"`), and `:437-474` pins that a lifecycle closed
before construction yields
`{ status: "failed", error: { code: "unavailable", message: "kernel is closing" } }` with `execute`
never invoked.

### 4.5 Stream close and the memory-ingest grace

State machine, from `closeStream` (`:235-265`) and `endStream` (`:214-233`):

| State | Event | Next state | Effect |
|---|---|---|---|
| executing | `done` settles, `ingestPending === false` | closed | `endStream()` immediately (`:236-239`) |
| executing | `done` settles, `ingestPending === true` | waiting | schedule a timer for `min(ingestGraceMs, absoluteDeadline - now)` (`:240-251`) |
| waiting | a `memory_ingest` with phase `started` or `queued` | waiting | `renewIngestWait()` cancels and re-schedules (`:248-251`, `:210`) |
| waiting | a `memory_ingest` with a terminal phase (`done`/`failed`/`blocked`, or unrecognized) | closed | `settleIngest()` cancels the timer and resolves (`:252-255`, `:211`) |
| waiting | timer fires | closed | resolve, then `endStream()` (`:258-262`) |
| closed | any later `emit` | closed | the relay target is disconnected, so the event reaches nothing (`:228`) |

`endStream` in order: emit the drop notice if any (`:215-224`), `emitRelay.disconnect()` (`:228`),
`stream.close()` (`:229`), release the lifecycle registration (`:230-231`), `resolveClosed()`
(`:232`). The disconnect is explained in place: "Async capability listeners may retain
`context.emit` beyond the ingest grace window. Leave them only the tiny relay after closure, not this
target's stream, observer, timers, and full ManagedRunSpec graph" (`:225-227`); pinned at
`packages/kernel/tests/unit/managed-run.test.ts:374-400`, where a retained `emit` after close reaches neither the
stream nor `observe`.

The wait is bounded twice. `ingestGraceMs` is clamped into `[0, MAX_INGEST_CLOSE_WAIT_MS]`
(`:178-185`), and `ingestMaxWaitMs` is at least `ingestGraceMs` and likewise clamped (`:186-192`).
Constants: grace `5_000`, absolute `15_000`, hard ceiling `60_000`
(`packages/kernel/src/runs/memory-ingest-phase.ts:36,39,42`), the last documented as "No host/test override may retain a
settled run beyond one minute" (`:41`). `packages/kernel/tests/unit/managed-run.test.ts:293-344` pins the sliding
renewal (deadlines 1 080, then 1 110, then 1 170) and `:346-372` pins that renewals stop at the
absolute deadline (1 100, with `ingestGraceMs: 40, ingestMaxWaitMs: 100`).

### 4.6 Live event fold (`packages/kernel/src/runs/run-service.ts:107-122`)

`executeRun` is given two listeners. `onEvent` maps a `TraceEvent` through `engineEventToProto` and
`onCapabilityEvent` maps a `CapabilityEvent` through `capabilityEventToProto`; in both cases
`context.emit(mapped)` runs **only when the mapper returned non-`null`** (`:116-121`). The handle's
`steer`, `compaction`, `signal` and `elicit` are handed through as the engine's `SteerSource`,
`CompactionSource`, `externalSignal` and `Elicit` (`:123-126`; engine-side parameter names at
`packages/loop/src/runtime/execute-run.ts:85-101`). The outcome is converted by
`engineResultToProto(outcome.executionId, outcome.response)` (`:128`).

### 4.7 `engineEventToProto` (`packages/kernel/src/runs/map-events.ts:389-671`)

Three gates, in order:

1. `isWorkflowPersistedTraceEvent(ev)` — the workflows package's own runtime guard; a match goes to
   `workflowEventToProto` (`:390`, `:270-309`). A workflow discriminator whose payload fails that
   guard returns `null` (pinned at `packages/kernel/tests/unit/map-events.test.ts:418-428`).
2. `isBuiltinTraceEvent(ev)` — otherwise report `not_builtin` and return `null` (`:399-402`).
3. A `switch` over the builtin union (`:403-678`), ending in
   `default: reportUnmapped(..., "no_projection"); return null` (`:676-678`).

`workflowEventToProto` (`:278-317`) is itself a three-arm switch, not just a dispatch target: every
arm carries `parent_run_id`. On `workflow_run_started` it spreads an optional `profile`, falls back to
`legacyWorkflowTitle(event.task)` when `event.title` is unset, and conditionally spreads
`round_id`/`pass`/`item_index`/`replica`/`replica_count` (`:280-294`). On `workflow_run_completed` it
hardcodes `status: "completed"` rather than deriving it (`:295-302`). On `workflow_run_failed` it
derives `status` via `endedReasonToStatus(event.status)` and conditionally spreads `error`
(`:303-311`). `legacyWorkflowTitle` (`:261-269`) is the title fallback for a persisted event that
predates the `title` field: it takes the first non-blank line of `task`, then `parseTaskTitle`
(falling back to a `TASK_TITLE_MAX`-clipped slice on failure) — the same `@clarvis/capability` helper
listed in §7.1.

Notable renames and derivations inside the switch: `mcp_name` becomes `server` and `ok` is derived as
`ev.error === null` on `tool_call` (`:501-505`); `lead_iteration`/`subagent_iteration` collapse to one
`iteration_completed` carrying an `agent` field (`:437-461`); `model_reasoning` becomes `reasoning`
(`:509`), `model_stream_delta` becomes `text_delta` (`:518`), `model_call_error` becomes `model_error`
(`:529`), `model_call_retry` becomes `model_retry` (`:540`), `user_question` becomes
`elicitation_resolved` (`:649`), `user_steering` becomes `steering_applied` (`:660`);
`run_ended.reason` is mapped to a `status` through `endedReasonToStatus`, which collapses everything
but `completed`/`cancelled` to `failed` (`:254-258`, used at `:415`). `mcp_degraded` drops each
server's `transport` (`:673`). `delegation_completed`/`delegation_failed` put the engine's `result`
through `terminalLabel` — sanitized and capped at 256 code points — as `summary` (`:582`).

The `tool_call` projection copies `ev.guard` unchanged when present, so live and
rehydrated runs expose the same final command-review fact. Production: the
`tool_call` arm of `engineEventToProto` in
`packages/kernel/src/runs/map-events.ts`; Test: the first tool-call mapping case
in `packages/kernel/tests/unit/map-events.test.ts`.

Two builtin types are refused **explicitly** rather than by the default arm: `convergence_warning`
and `guard_escalation`. They shared one comment that explained only the first, which left the second
reading as unfinished work; **as of 2026-08-22 the comment gives each its own reason**, because they
are not the same kind of omission. `convergence_warning` is engine-internal *for now* — "the warning
already reaches the model as a runtime note and the record as a persisted event; whether a UI should
surface … is a product decision that has not been made". `guard_escalation` is not unfinished at all:
a tripped guard escalates through the **elicitation port** under its own `kind: "guard_escalation"`
(`packages/loop/src/runtime/guards/guard-escalation.ts`), so the client has already met it as a
question it must answer — "the run looks stuck, keep going?" — and publishing it here as well would
tell a client twice about the one thing it is currently blocking on. The trace records the outcome
either way, so the audit trail is complete. Both remain handled explicitly rather than left to the
`default` below, so the omission reads as a choice. The branch still
calls `reportUnmapped(logger, "engine", ev.type, undefined, "deliberately_internal")` before returning
`null` (`:594`), so this refusal produces the same sampled debug line as every other dropped event —
just with a distinct reason string — rather than dropping silently.
`packages/kernel/tests/unit/map-events.test.ts:728-756` pins that it stays one.

`sub(id)` (`:273-275`) is the spread helper that keeps `subagent_id` off a lead event entirely rather
than setting it to `undefined`; every optional engine field is spread the same conditional way, so
"absent data never becomes an explicit `undefined` on the wire" (`:394-395`).

### 4.8 `capabilityEventToProto` (`packages/kernel/src/runs/map-events.ts:335-367`)

1. `event.capability === MEMORY_CAPABILITY_NAME`: only `MEMORY_INGEST_EVENT` is accepted (anything
   else is reported `not_ingest` and dropped, `:340-343`); the detail is bounded then parsed against
   `memoryIngestSchema`, and a truncated or non-matching payload is dropped with reason `truncated`
   or `schema` (`:232-250`). On success: `{ type: "memory_ingest", at: Date.now(), detail }` (`:345`).
2. No `wire`, or `wire.detail === undefined`: reported `no_wire_projection`, returns `null`
   (`:347-358`).
3. The detail is bounded and sanitized; if a **closed schema exists for `wire.type`** and the detail
   was not truncated and it parses, the event is
   `{ ...parsed.data, type: event.wire.type, at: Date.now() }` (`:351-357`). Because `type` and `at`
   are written **after** the spread, capability detail cannot override either — pinned at
   `packages/kernel/tests/unit/map-events.test.ts:194-211`, which also asserts the serialized output does not contain
   the injected `Bearer secret-token`.
4. Anything else becomes the generic envelope `capability_event` carrying sanitized `capability`,
   `kind` and `projection` labels plus the bounded `detail` and a `truncated` flag (`:367-374`).

All three of `capabilityEventToProto`'s successful returns stamp `at: Date.now()` (`:353`, `:364`,
`:369`) — a wall-clock timestamp taken by the **kernel at projection time**, not carried from when the
capability actually emitted the event. This is unlike `engineEventToProto`, whose every case reads
`at` from the trace event itself (`ev.occurred_at`/`ev.started_at`/`ev.ended_at`/etc., e.g. `:407`,
`:423`, `:440`); a capability-channel event's `at` therefore reflects delivery time, not origination
time.

The docstring records that the previous design matched against a list of known capability names, and
that "any capability the kernel had not been taught about … had its events dropped in silence"
(`:331-337`). `packages/kernel/tests/unit/map-events.test.ts:213-229` pins the new behaviour for an invented `audit`
capability.

### 4.9 Backpressure (`coalesce-events.ts` over `core/event-stream.ts`)

The stream merges into the buffer tail only when the buffer is non-empty, and the code states why
that is sufficient: "the generator parks only on an empty buffer, so a non-empty buffer *means*
backpressure. A consumer that keeps up therefore still receives every item verbatim, and no timer or
coalescing window is needed" (`packages/kernel/src/core/event-stream.ts:45-49`; pinned at
`packages/kernel/tests/unit/event-stream.test.ts:127-146`).

`coalesceRunEvents` (`:223-253`) merges only same-type pairs whose `RUN_EVENT_POLICY[...].coalesce`
class matches, and only when `sameAgent` holds (`agent` **and** `subagent_id` equal, `:197-202`):

| Pair | Extra join key | Merge rule |
|---|---|---|
| `text_delta` | same `iteration` and `channel`; refuses when `next.reset` | append; keeps `previous.at` and `previous.reset` (`:226-231`, `:103-107`) |
| `tool_output_delta` | same `call_id` | append; keeps `previous.at` (`:232-242`, `:132-135`) |
| `tool_input_delta` | same `call_id` | **replace**: `{ ...next, at: prev.at }` (`:243-251`) |

The replacement rule for `tool_input_delta` is explained in the docstring — "its `chars` is the
cumulative size of the argument payload rather than a slice of it" (`:220-221`) — and in the test:
"Concatenating the way the two content deltas do would report a 3 KB call as 6 KB"
(`packages/kernel/tests/unit/event-stream.test.ts:230-232`).

The two appending kinds do not concatenate eagerly. A merged event carries a hidden
`CoalescedTextState` under a module-private symbol (`:34-45`) holding `blocks` and `pending`, flushed
every 4 096 chars (`COALESCED_TEXT_BLOCK_CHARS`, `:33`, `appendText` `:55-61`), and exposes `text` or
`chunk` as an accessor that materializes once and then releases the sources (`:63-79`, `:108-113`,
`:136-141`). Further deltas mutate the same object in place and return it unchanged
(`appendChunkedEvent`, `:146-155`; pinned at `packages/kernel/tests/unit/event-stream.test.ts:256-275`, which asserts
`merged` is identity-equal to the first aggregate across 20 000 appends, `materializations === 0`
before read and `1` after, and fewer than 4 100 retained blocks).

The `text`/`chunk` accessor is also **writable**: the same `Object.defineProperty` calls that install
the getter install a setter (`replaceText`, `:81-87`) wired at `:112` and `:140`, so external code can
overwrite a coalesced event's backing state directly by assignment rather than only reading it.

`sizeOfCoalescedRunEvent` (`:172-191`) keeps byte accounting O(1): append kinds add
`appendedJsonStringBytes(incoming.text|chunk)` (JSON-encoded length minus the two quotes, `:26-31`),
`tool_input_delta` swaps only the `at` field's encoded size, and anything else falls back to a full
`sizeOfRunEvent`. `sizeOfRunEvent` returns `Number.MAX_SAFE_INTEGER` when `JSON.stringify` throws
(`:16-24`), with the reason in place: "A contributed detail that cannot cross the wire must never
make a local consumer's buffer unbounded. Treat it as oversized and fail closed" (`:20-22`); pinned
at `packages/kernel/tests/unit/event-stream.test.ts:339-353`.

`isDroppableRunEvent` reads the table directly (`:265-267`).

### 4.10 Rehydration (`packages/kernel/src/runs/map-result.ts:192-207`)

`rehydrateEvents` maps every persisted trace event through `engineEventToProto` and filters `null`
away, then always emits one `runs.rehydrated` debug line with `events_total`, `events_mapped`,
`events_dropped` (`:176-185`). The docstring calls this "the aggregate half of the §4 rule whose
per-artifact half is `runs.event.unmapped`" (`:168-170`). `packages/kernel/tests/unit/observability.test.ts:84-123`
pins the counts (2 total, 1 mapped, 1 dropped).

`reportUnmapped` (`packages/kernel/src/runs/map-events.ts:50-69`) is guarded by `levelEnabled(logger, "debug")` **before** the
bindings object is allocated (`:57`) and then by a module-scoped `createSampler()` keyed on
`path\0capability\0kind` (`:32`, `:58`). The sampler is module-scoped deliberately: "the two mappers
share one budget: a format skew produces the same `(path, kind)` pair on every event of that type,
and a rehydration replays a whole run's trace in one loop" (`:26-30`).
`packages/kernel/tests/unit/observability.test.ts:75-80` pins that 40 identical unmapped events produce more than 0
and fewer than 40 lines.

### 4.11 Read paths

| Operation | Behaviour |
|---|---|
| `get(id)` | `store.getById(owner, id)`; `null` gives `kernelError("not_found", …)`; else `storedToDetail(row, logger)` (`packages/kernel/src/runs/run-service.ts:151-155`) |
| `list(page?)` | `normalizeRunPagination(page)` then `store.list(owner, limit, offset)`, rows through `summaryToProto`; the page echoes the normalized `limit`/`offset` (`:161-165`) |
| `delete(id)` | `store.deleteById(owner, id)`; `false` gives `not_found` (`:166-169`) |

`normalizeRunPagination` (`packages/kernel/src/runs/pagination.ts:8-24`) defaults `limit` to `DEFAULT_RUN_LIST_LIMIT = 20`
(`:5`) and `offset` to `0`, and throws `invalid_request` unless each is a safe integer within
`[0, MAX_TRACE_LIST_LIMIT]` and `[0, MAX_TRACE_LIST_OFFSET]` (200 and 10 000 —
`packages/trace/src/json-trace-store.ts:189,191`). Pinned at
`packages/kernel/tests/integration/run-service.smoke.test.ts:166-171`.

There is no admin read path beside those three. `TraceStore.listAcrossOwners`
(`packages/trace/src/trace-store.ts:132`) stays optional on the store port, but nothing under
`packages/kernel/src/runs/` calls it, so every read this subsystem performs is keyed under one
`owner`.

### 4.12 Span derivation (`deriveRunEventSpan`)

`deriveRunEventSpan` is a total function over the protocol union with a `default` arm that is a
compile-time `never` check (`:133-136`). Highlights: run start/end frame the `"run"` span
(`:51-54`); iteration and model-output events (`reasoning`, `text_delta`, `model_error`,
`model_retry`) sit on `iterationSpanId(...)` (`:56-67`, `:95-103`); tool events key on `call_id`
(`:87-93`); `steering_applied` and `compaction_started`/`compaction`/`compaction_skipped` route to the sub-agent span only
when `subagent_id` is present, else to `"run"` (`:105-116`); every remaining standalone notice —
including all five plan events, `memory_ingest`, `capability_event` and `events_dropped` — is a
`point` of kind `event` on `"run"` (`:118-131`).

`SpanKind` (`:7`) has no `"workflow"` member — the `workflow:<run_id>` span id (§3.1) is only an id
convention layered on the existing kinds, not a distinct category. `workflow_run_started` opens and
`workflow_run_completed`/`workflow_run_failed` close a span of kind `subagent` (`:77-78`, `:81-83`);
`workflow_run_progress` is a `point` of kind `subagent` on that same span; both
`workflow_title_updated` and `workflow_sequence_state` are `point`s of kind `event` on the manager
run span.

`iterationSpanId` isolates an id-less sub-agent event rather than letting it claim the lead's span,
and states the reason: "claiming `lead:N` for it would interleave its text with the lead's own
stream. It gets an isolated, deliberately non-colliding span so the damage is a stray anonymous node
instead of a scrambled transcript" (`:22-27`). Pinned at `packages/kernel/tests/unit/run-event-span.test.ts:41-58`.

## 5. Invariants

Each entry: the rule, the production anchor, the test anchor (or "unpinned").

**INV-R1 (owns INV-228).** `RUN_EVENT_POLICY` marks exactly three event types droppable —
`text_delta`, `tool_input_delta`, `tool_output_delta` — and every droppable entry also declares a
non-`false` `coalesce` class.
Production: `RUN_EVENT_POLICY`. Test: `packages/kernel/tests/unit/event-policy.test.ts`, whose comment
gives the justification: "the two content deltas are superseded by an authoritative terminal event,
and `tool_input_delta` carries a cumulative count, so the next one restates it in full" (`:11-13`).

**INV-R2 (owns INV-229).** `run_started` is `durability: "persisted"`; `plan_created` comes only from
`capability_channel`, is `live_only`, and maps via the `capability` mapper; `events_dropped` is
`kernel_derived` / `live_only` / `managed_run` and non-droppable; `workflow_title_updated` is
`workflow` / `live_only` / `workflow` and non-droppable; `workflow_sequence_state` has the same
classification; `compaction_started` is
`engine_trace` / `live_only` / `engine` and non-droppable.
Production: `packages/kernel/src/runs/event-policy.ts` (`RUN_EVENT_POLICY`). Test:
`packages/kernel/tests/unit/event-policy.test.ts` ("makes replay gaps and derived terminal reporting
explicit").

**INV-R3.** Adding a member to the protocol `RunEvent` union without classifying it fails compilation.
Production: `RUN_EVENT_POLICY` uses
`as const satisfies Record<RunEvent["type"], RunEventPolicy>`.
Test: unpinned by a runtime test — it is a type-level guarantee only.

**INV-R4.** An `events_dropped` notice is never itself dropped, whatever `droppable` predicate a host
supplies.
Production `packages/kernel/src/runs/managed-run.ts:132-134`. Test `packages/kernel/tests/unit/managed-run.test.ts:402-435` (the notice
survives at `maxBuffered: 2`); indirectly `packages/kernel/tests/integration/kernel-event-buffer.test.ts:75-95`.

**INV-R5.** The drop count on that notice is read **after** the notice is pushed, because the push can
evict another victim.
Production `packages/kernel/src/runs/managed-run.ts:222-223`. Test `packages/kernel/tests/unit/event-stream.test.ts:438-461`, whose title is
"a terminal notice can itself evict a buffered item — `dropped()` must be read after that push, not
before", plus `packages/kernel/tests/unit/managed-run.test.ts:433`.

**INV-R6.** An execution id is refused when it is either live in this process or already persisted for
this owner, and the refusal is `conflict`, raised before any engine work.
Production `packages/kernel/src/runs/run-service.ts:131-133`. Test `packages/kernel/tests/integration/run-service.smoke.test.ts:179-202`,
`packages/kernel/tests/unit/run-service-lifecycle.test.ts:45-49`.

**INV-R7.** The id reservation is released on `handle.closed`, not `handle.done`.
Production `packages/kernel/src/runs/run-service.ts:144`. Test `packages/kernel/tests/unit/run-service-lifecycle.test.ts:30-57` — a second
start with the same id is rejected after `done` resolves and accepted only after `closed` resolves.

**INV-R8.** Neither mapper ever forwards an unrecognized shape into the closed protocol union; it
returns `null` and the caller drops it.
Production `packages/kernel/src/runs/map-events.ts:401,357,365-374,594,677`; drop sites `packages/kernel/src/runs/run-service.ts:120-125` and
`packages/kernel/src/runs/map-result.ts:193-195`. Test `packages/kernel/tests/unit/map-events.test.ts:285-289,408-428,653-662`. The reason is
stated at `packages/kernel/src/runs/map-events.ts:45-48`: "It stays a log: what the mapper *returns* is unchanged, because a
client's event union is closed and forwarding an unrecognized shape into it is the worse failure."

**INV-R9.** Capability-supplied detail can override neither the event discriminator nor its timestamp.
Production `packages/kernel/src/runs/map-events.ts:356` (`type` and `at` written after the spread). Test
`packages/kernel/tests/unit/map-events.test.ts:194-211`.

**INV-R10.** Every capability projection that crosses to a client is secret-redacted,
terminal-control stripped and byte-bounded.
Production `packages/kernel/src/runs/map-events.ts:192-216` (`boundJsonValue` plus `sanitizeDeep(…, terminalSafe)`), `:82-88`.
Test `packages/kernel/tests/unit/map-events.test.ts:231-283` — asserts absence of `secret-token` and of any escape
byte, and a detail no larger than `MAX_CAPABILITY_EVENT_DETAIL_BYTES` for cyclic, 1 000-deep,
throwing-accessor and 2 MiB inputs.

**INV-R11.** A memory-ingest notice reaches a client only when it matches the five-arm phase union
exactly; an unknown phase or an extra field drops it.
Production `packages/kernel/src/runs/map-events.ts:144-176`, `:238-241`. Test `packages/kernel/tests/unit/map-events.test.ts:306-345` — pins
`queued` and `blocked` as first-class (with the regression note that they were "silently dropped
instead of reaching the wire"), and that `{ phase: "failed", injected: true }` yields `null`.

**INV-R12.** Adjacent deltas merge only within identical attribution (`agent` plus `subagent_id`) and
the kind's own join key, and never across a `reset`.
Production `packages/kernel/src/runs/coalesce-events.ts:226-251`, `:197-202`. Test
`packages/kernel/tests/unit/event-stream.test.ts:195-236`.

**INV-R13.** Coalescing is lossless in characters; only event *count* is lost.
Production `packages/kernel/src/runs/coalesce-events.ts:204-208` (the docstring's claim) and the accessor implementation
`:55-79`. Test `packages/kernel/tests/unit/event-stream.test.ts:238-254` — 5 000 deltas through a stalled consumer,
`dropped() === 0`, exact concatenation preserved.

**INV-R14.** A merged text or tool-output event's retained bytes are computed incrementally, never by
re-serializing the whole prefix.
Production `packages/kernel/src/runs/coalesce-events.ts:172-191`. Test `packages/kernel/tests/unit/event-stream.test.ts:293-337`.

**INV-R15.** A run event that cannot be JSON-serialized is charged `Number.MAX_SAFE_INTEGER` bytes
(fail closed) rather than zero.
Production `packages/kernel/src/runs/coalesce-events.ts:16-24`. Test `packages/kernel/tests/unit/event-stream.test.ts:339-353`.

**INV-R16.** A stream whose sole consumer abandons it cancels the run; a stream saturated with
non-droppable events aborts it as `unavailable`.
Production `packages/kernel/src/runs/managed-run.ts:166-173`. Test `packages/kernel/tests/unit/managed-run.test.ts:194-219` for the abandon
half (abandon, abort, `cancelled` result). The saturation half is pinned only at the stream level
(`packages/kernel/tests/unit/event-stream.test.ts:399-424`), not through a managed run — see §8.

**INV-R17.** After the stream closes, a capability that retained `context.emit` reaches neither the
stream nor `observe`.
Production `packages/kernel/src/runs/managed-run.ts:228` (`emitRelay.disconnect()`), relay at `:94-112`. Test
`packages/kernel/tests/unit/managed-run.test.ts:374-400`.

**INV-R18.** The post-run ingest wait slides on every non-terminal notice but is capped by an absolute
deadline, and no host or test override may exceed one minute.
Production `packages/kernel/src/runs/managed-run.ts:240-251`, `:178-192`; constants `packages/kernel/src/runs/memory-ingest-phase.ts:36,39,42`. Test
`packages/kernel/tests/unit/managed-run.test.ts:293-372`.

**INV-R19.** Assembly and execution failures after reservation settle `done` as a failed `RunResult`;
they never reject `start`.
Production `packages/kernel/src/runs/run-service.ts:104` (assembly inside `execute`), `packages/kernel/src/runs/managed-run.ts:296-299`. Test
`packages/kernel/tests/integration/run-service.smoke.test.ts:204-269`.

**INV-R20.** A `settle` that throws replaces an otherwise-successful result with a failed one.
Production `packages/kernel/src/runs/managed-run.ts:300-304`. Test `packages/kernel/tests/unit/managed-run.test.ts:139-153`.

**INV-R21.** A kernel that is not `open` refuses to execute, reporting `unavailable` and "kernel is
closing" through `done` rather than through `start`.
Production `packages/kernel/src/runs/managed-run.ts:293-294`. Test `packages/kernel/tests/unit/managed-run.test.ts:456-473`,
`packages/kernel/tests/integration/run-service.smoke.test.ts:294-302`.

**INV-R22.** Steering is acknowledged only when the loop drains the message. If the run closes
before that drain, or steering begins after settlement, `steer` throws `not_found`; `compact` also
throws `not_found` after settlement. A protocol success therefore cannot mean only that a transient
queue accepted data.
Production: `packages/kernel/src/runs/steer-queue.ts` (`push`, `drain`, `close`),
`packages/kernel/src/runs/managed-run.ts` (`RunHandle.steer`, `RunHandle.compact`), and
`packages/kernel/src/runs/compaction-queue.ts` (`push`). Tests:
`packages/kernel/tests/unit/run-control-queues.test.ts` (drain acknowledgement and close refusal) and
`packages/kernel/tests/unit/managed-run.test.ts` (close-before-drain and post-settlement refusal).

Both queues also expose `undrained()`, which inspects queued-but-not-yet-drained messages without
consuming them (`packages/kernel/src/runs/steer-queue.ts:12,31-33`; `packages/kernel/src/runs/compaction-queue.ts:10,31-33`). The handle's `compact`
also wraps its argument before pushing: `compaction.push(request === undefined ? {} : { request })`
(`packages/kernel/src/runs/managed-run.ts:319-320`) — an absent protocol `request` becomes an empty object, a supplied one is
nested under a `request` key, and only the push's boolean result (not the shape) decides the
`not_found` throw.

**INV-R23.** Run listing and paging are bounded at the kernel boundary, not left to the store.
Production `packages/kernel/src/runs/pagination.ts:11-22`. Test `packages/kernel/tests/integration/run-service.smoke.test.ts:166-171`.

**INV-R24.** Every trace read and write is owner-scoped; a cross-owner `get` or `delete` reports
`not_found`.
Production `packages/kernel/src/runs/run-service.ts:291-303` (all three store calls pass `owner`). Test
`packages/kernel/tests/integration/owner-isolation.test.ts:278-290`.

**INV-R25.** There is no cross-owner read path in this subsystem at all — neither a cross-owner
`get` nor a cross-owner index.
Production `packages/kernel/src/runs/run-service.ts:151-164` is the entire read surface and every
call passes `owner`; `TraceStore.listAcrossOwners` (`packages/trace/src/trace-store.ts:132`) has no
caller under `packages/kernel/src/`. Test: unpinned — an absence has none.

**INV-R26.** `engineMessagesToProto` keeps only `user` and `assistant` messages; a `system` message
never reaches a client.
Production `packages/kernel/src/runs/map-message.ts:42-43`. Test `packages/kernel/tests/unit/map-message.test.ts:10-32`.

**INV-R27.** Image parts round-trip: engine `mediaType`/`image` against protocol `mime`/`data`, with
`ref` as the fallback source and `application/octet-stream` as the fallback MIME.
Production `packages/kernel/src/runs/map-message.ts:9,18,29-33`. Test `packages/kernel/tests/unit/map-message.test.ts:34-60`.

**INV-R28.** Any stored execution status other than `completed`/`cancelled` collapses to `failed` on
the wire, in both the stored and the live path.
Production `packages/kernel/src/runs/map-result.ts:45-49` and `:100-105`; the event-level twin is `packages/kernel/src/runs/map-events.ts:246-250`. Test
`packages/kernel/tests/unit/map-events.test.ts:438-443` (`reason: "error"` gives `status: "failed"`).

**INV-R29.** A `RunDetail`'s token totals come from the stored row, overriding whatever the response's
own usage said.
Production `packages/kernel/src/runs/map-result.ts:156-161`. Test: unpinned as an override — the totals are exercised only as
part of the round trip at `packages/kernel/tests/integration/run-service.smoke.test.ts:158-161`, which never
constructs a disagreement.

**INV-R30.** `recovery` is forwarded verbatim when the stored row carries it and the key is absent
otherwise.
Production `packages/kernel/src/runs/map-result.ts:174`. Test `packages/kernel/tests/unit/map-result.test.ts:194-210`, including
`Object.hasOwn(detail, "recovery") === false`.

**INV-R31.** The `plans` settings block is materialized with defaults for `mode` and `retention`; the
`agents` block is projected sparsely.
Production `packages/kernel/src/runs/settings-assembler.ts:146-162` versus `:180-187`. Test
`packages/kernel/tests/component/settings-assembler.test.ts:110-157` and `:175-193`.

**INV-R32.** An explicit per-run `plans` param beats a skill's Plans policy, which beats the settings
block.
Production `packages/kernel/src/runs/settings-assembler.ts:468-490` (the nested ternary order). Test
`packages/kernel/tests/component/settings-assembler.test.ts:166-174`, `:385-421`.

**INV-R33.** A skill's declared `agent` overrides the request's `agent`; a skill naming none leaves it
alone.
Production `packages/kernel/src/runs/settings-assembler.ts:408` (`skillRun?.agent ?? params.agent ?? …`). Test
`packages/kernel/tests/component/settings-assembler.test.ts:440-469`.

**INV-R34.** The `skill` key is never forwarded to the engine.
Production `packages/kernel/src/runs/settings-assembler.ts:432-494` — no `skill` key in the returned literal; the stated reason
is at `:359-361`. Test `packages/kernel/tests/component/settings-assembler.test.ts:548-560`.

**INV-R34a.** Prompt-expansion hook context is emitted exactly for a successfully resolved
user-invoked skill, and plugin provenance is represented by a generic qualified command name rather
than by changing the skill seed or forwarding the kernel-only `skill` input.
Production `packages/kernel/src/runs/settings-assembler.ts:228-238`, `:399-406`, `:482-488`. Test
`packages/kernel/tests/component/settings-assembler.test.ts:548-587`.

**INV-R35.** A malformed `mcpServers` entry fails the whole assembly by name; it is never dropped.
Production `packages/kernel/src/runs/settings-assembler.ts:225-230`. Test
`packages/kernel/tests/component/settings-assembler.test.ts:675-682`.

**INV-R35a.** Active plugin MCP servers are attached even when every persisted profile has an empty
MCP tool list, carry `auto_tools: true`, and leave those profile lists unchanged. Operator MCP
servers are still omitted unless a profile references their namespace. A namespace containing dots
is matched as one exact registered prefix rather than split at its first dot.
Production: `createSettingsRunAssembler` and file-kernel `pluginMcpServerNames` composition. Test:
the active-plugin, dotted-namespace, and unreferenced-server cases in
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R36.** A `can_spawn` target that resolves to no agent is skipped, not fatal.
Production `packages/kernel/src/runs/settings-assembler.ts:410` (`if (rec === null) continue`). Test
`packages/kernel/tests/component/settings-assembler.test.ts:66-81`.

**INV-R37.** The entry profile takes the user's `default_model`/`default_reasoning_effort` first; a
spawned child takes its own frontmatter first.
Production `packages/kernel/src/runs/settings-assembler.ts:266-268`, `:274-276`. Test
`packages/kernel/tests/component/settings-assembler.test.ts:219-255`.

**INV-R38.** `prompt_cache_ttl` defaults to `"1h"` exactly when the effective guard mode parks on a
human, and an explicit request param always wins.
Production `packages/kernel/src/runs/settings-assembler.ts:458-462`; predicate `packages/kernel/src/guard/resolver.ts:80-87`. Test
`packages/kernel/tests/component/settings-assembler.test.ts:515-611`.

**INV-R39.** `completeBudget` fills in exactly one field: a declared budget missing `on_exceed` gets
the fallback's `on_exceed` (`{ ...declared, on_exceed: fallback.on_exceed }`). It never supplies a
missing `total_token_limit` — a budget declared as `{ on_exceed: "stop" }` alone is returned
unchanged, `total_token_limit` still absent.
Production `packages/kernel/src/runs/settings-assembler.ts:371-379`. Test
`packages/kernel/tests/component/settings-assembler.test.ts:266-313` (which additionally runs the assembled body
through the engine's own `validateBody` at `:276-282`) covers only the missing-`on_exceed` case; no
test in this subsystem exercises a declared budget missing `total_token_limit`, so whether the
resulting request validates in that case is not shown here — see §8.

**INV-R40.** `deriveRunEventSpan` is total over the protocol union, enforced by a `never` assignment.
Production: the exhaustive default in `deriveRunEventSpan`. Test:
`packages/kernel/tests/unit/run-event-span.test.ts`, which
documents the arm as "compile-time-only" by asserting the bogus input is returned unchanged.

**INV-R41.** An unmapped-event report is sampled and costs nothing below `debug`.
Production `packages/kernel/src/runs/map-events.ts:57-58`. Test `packages/kernel/tests/unit/observability.test.ts:75-80`.

**INV-R42.** Each configured scope contributes at most one context document to the entry profile's
`base_prompt`: `CLARVIS.md` wins when present, otherwise `AGENTS.md` is the fallback; neither file is
added to child profiles.
Production `packages/kernel/src/runs/settings-assembler.ts:276-288,394-397,426-427` plus the selection
order at `packages/kernel/src/config/file-config-store.ts:1019-1031`. Test
`packages/kernel/tests/component/settings-assembler.test.ts:87-124` covers absence, fallback, and
both candidates present without double injection.

**INV-R43.** `compaction_started` crosses the live engine trace as a strict, non-droppable,
live-only protocol event; its terminal `compaction` counterpart preserves `fallback_reason` when
present. The start never enters replay.
Production: `packages/kernel/src/runs/map-events.ts` (`engineEventToProto`),
`packages/kernel/src/runs/event-policy.ts` (`RUN_EVENT_POLICY`), and
`packages/kernel/src/transport/run-event-codec.ts` (`RUN_EVENT_SCHEMAS`). Test:
`packages/kernel/tests/unit/map-events.test.ts` (compaction mapping),
`packages/kernel/tests/unit/event-policy.test.ts`, and
`packages/kernel/tests/contract/transport-codecs.test.ts` ("preserves compaction lifecycle and
fallback attribution").

**INV-R44.** A hydrated run exposes an Extension Profile only when durable host metadata contains exactly
a valid qualified id and SHA-256 fingerprint; it never projects arbitrary host metadata.
Production: `extensionProfileFromHostMetadata` and `storedToDetail` in
`packages/kernel/src/runs/map-result.ts`. Test:
`packages/kernel/tests/unit/map-result.test.ts` (valid Extension Profile projection and malformed metadata
omission). The persistence half is [INV-319](extension-profiles.md#inv-319--execution-history-identifies-its-extension-snapshot-without-secrets).

**INV-R45.** `workflow_sequence_state` is a strict, non-droppable, live-only workflow event and a
point on the manager run span. Its runtime codec admits only the six statuses and strict field
shape; revision/pass/count fields are non-negative integers, the lifetime limit is positive, and
the started count cannot exceed it. It cannot enter the generic capability envelope or silently
disappear under backpressure.
Production: `RUN_EVENT_POLICY`, `RUN_EVENT_SCHEMAS`, and `runEventSpan`.
Test: `packages/kernel/tests/unit/event-policy.test.ts`,
`packages/kernel/tests/unit/run-event-span.test.ts`, and
`packages/kernel/tests/contract/transport-codecs.test.ts` (`preserves the workflow round checkpoint
contract`). Durable checkpoint ownership remains with `WorkflowRecord.sequence`, specified in
[workflows-service.md](../capabilities/workflows-service.md).

## 6. Failure modes and degradation

| Condition | Handler | Outcome |
|---|---|---|
| duplicate `execution_id` for the owner | `packages/kernel/src/runs/run-service.ts:131-133` | `KernelException("conflict")` thrown from `start`; nothing launched |
| engine's own in-flight id clash (`ConflictError`) | `packages/loop/src/runtime/execute-run.ts:132-140`, then `toKernelError`'s name match | surfaces inside `execute`, so it lands as a **failed result**; `toKernelError` maps a name containing `Conflict` to `conflict`, everything else to `internal` (`packages/kernel/src/core/errors.ts:57-64`) |
| unknown agent, unknown skill, no default agent | `packages/kernel/src/runs/settings-assembler.ts:412-414,103-105,408-410` | `not_found` or `invalid_request` **as a failed `RunResult`**, because assembly runs inside `execute` |
| malformed `mcpServers` entry | `packages/kernel/src/runs/settings-assembler.ts:225-230` | `invalid_request` naming the server key and the zod issue path |
| agent resolves no model | `packages/kernel/src/runs/settings-assembler.ts:270-273` | `invalid_request`, `"agent '<n>' declares no model and no default_model is set"` |
| `execute` throws | `packages/kernel/src/runs/managed-run.ts:297-299` | `failedResult(executionId, toKernelError(error))` |
| `settle` throws | `packages/kernel/src/runs/managed-run.ts:302-304` | previous result discarded, failed result returned |
| kernel closing at start | `packages/kernel/src/runs/managed-run.ts:293-294` | `unavailable` / `"kernel is closing"` on `done` |
| consumer stops draining and only structural events remain | `packages/kernel/src/runs/managed-run.ts:166-169` | run aborted with `unavailable` / `"run event consumer stopped draining"`; the underlying stream also fails with `"event stream saturated with N non-droppable items"` (`packages/kernel/src/core/event-stream.ts:168-179`) |
| consumer returns early (breaks out of `for await`) | `packages/kernel/src/runs/managed-run.ts:170-173` | run aborted with `cancelled` / `"run event consumer abandoned the stream"` |
| buffer full, droppable victims available | `packages/kernel/src/core/event-stream.ts:155-163` | oldest droppable evicted, `droppedCount` incremented; a terminal `events_dropped` notice reports the total |
| memory-ingest notice never arrives | `packages/kernel/src/runs/managed-run.ts:240-262` | stream closes after the sliding grace, bounded by the absolute deadline |
| `compact()` after settle | `packages/kernel/src/runs/managed-run.ts:319-322` | `not_found` / `"run '<id>' is no longer active"` |
| `steer()` after settle or while an undrained message loses the run | `packages/kernel/src/runs/steer-queue.ts` (`push`, `close`) and `packages/kernel/src/runs/managed-run.ts` (`RunHandle.steer`) | `not_found` / `"run '<id>' is no longer accepting steering"` |
| `respond()` with an unknown id | `packages/kernel/src/runs/elicit-bridge.ts:79-80` (delegated) | silently ignored |
| pagination out of range | `packages/kernel/src/runs/pagination.ts:11-22` | `invalid_request` naming the bound |
| engine event with no protocol projection | `packages/kernel/src/runs/map-events.ts:400,594,677` | dropped; sampled `runs.event.unmapped` debug line |
| capability event with no `wire` projection | `packages/kernel/src/runs/map-events.ts:347-349` | dropped; `reason: "no_wire_projection"` |
| capability detail too large, cyclic, or with throwing accessors | `packages/kernel/src/runs/map-events.ts:192-216` | bounded and truncated, never thrown; unserializable becomes the literal `"[unserializable capability event]"` (`:208`) |
| rehydration loses events | `packages/kernel/src/runs/map-result.ts:196-205` | the run is returned with fewer events plus a `runs.rehydrated` line carrying the delta |
| plan or task slot in `capability_state` malformed | `packages/kernel/src/runs/plan-ref.ts:66`, `packages/kernel/src/runs/task-binding.ts:10` (delegated) | field omitted from `RunDetail`, no throw; pinned at `packages/kernel/tests/unit/map-result.test.ts:52-66` and `:92-123` |
| Extension Profile slot in `host_metadata` malformed | `extensionProfileFromHostMetadata` in `packages/kernel/src/runs/map-result.ts` | `extension_profile` omitted from `RunDetail`; other run data still hydrates |

## 7. Coupling

### 7.1 Outbound (static imports)

| Dependency | Where | What forces it |
|---|---|---|
| `@clarvis/loop` | `packages/kernel/src/runs/run-service.ts:1,114-115,188,212,271`, `packages/kernel/src/runs/map-result.ts:1-8` (types), `packages/kernel/src/runs/map-message.ts:1-5` (types), `packages/kernel/src/runs/managed-run.ts:1` (types), `packages/kernel/src/runs/settings-assembler.ts:2-8` | `executeRun` and the settled-context helpers are runtime values loaded dynamically; the engine DTOs (`ExecuteRunDeps`, `StoredExecution`, `RunResponse`, `Message`) are type-only. `settings-assembler.ts` additionally takes four **values** from `@clarvis/loop/host`: `agentPromptOf`, `mcpServerSettingsSchema`, `normalizeTools`, `settingsServerToEngine` |
| `@clarvis/protocol` | every file in `runs/` | the closed `RunEvent` union is what `RUN_EVENT_POLICY` is `satisfies`-checked against, and what `deriveRunEventSpan` exhausts |
| `@clarvis/capability` | `packages/kernel/src/runs/map-events.ts:1-13`, `packages/kernel/src/runs/run-service.ts:14`, `packages/kernel/src/runs/map-result.ts:18` | `isBuiltinTraceEvent`, `sanitizeDeep`/`sanitizeText`, `createSampler`, `levelEnabled`, `parseTaskTitle`/`TASK_TITLE_MAX`, `NOOP_LOGGER`; `packages/kernel/src/runs/managed-run.ts:2` also takes `suppressSecondaryRejection` |
| `@clarvis/memory/settings` | `packages/kernel/src/runs/map-events.ts:14` | `MEMORY_CAPABILITY_NAME` and `MEMORY_INGEST_EVENT` — the one capability with a typed, kernel-validated projection |
| `@clarvis/workflows` | `packages/kernel/src/runs/map-events.ts:16-19` | `isWorkflowPersistedTraceEvent` is the first gate in `engineEventToProto`; the workflows package owns its own trace guard |
| `@clarvis/plan/settings` | `packages/kernel/src/runs/settings-assembler.ts:1` | `PLANS_DEFAULTS` for the materialized `mode` and `retention` |
| `@clarvis/plan`, `@clarvis/tasks/*` | `packages/kernel/src/runs/plan-ref.ts:1`, `packages/kernel/src/runs/task-binding.ts:1-2` | capability-state slot names and schema (delegated documents) |
| `@clarvis/trace` | `packages/kernel/src/runs/run-service.ts:2`, `packages/kernel/src/runs/pagination.ts:1` | runtime `generateExecutionId` plus `MAX_TRACE_LIST_LIMIT`/`MAX_TRACE_LIST_OFFSET`; nothing under `runs/` names the `TraceStore` type — `packages/kernel/src/runs/run-service.ts:99` takes the store off `deps.traceStore` |
| kernel-internal | `core/event-stream.ts`, `core/errors.ts`, `core/bounded-json.ts`, `application/lifecycle.ts`, `config/config-store.ts`, `guard/resolver.ts`, `skills/render-skill-prompt.ts` | see the per-file imports cited above |

`settings-assembler.ts` deliberately does **not** import the kernel's settings schema: it declares its
own loose `EngineSettings` interface and comments that it is "deliberately loose, since the config
store owns the full schema" (`:17-18`).

### 7.2 Inbound

| Consumer | Import | Nature |
|---|---|---|
| `packages/kernel/src/kernel.ts:38,54` | `createRunService`, `createSettingsRunAssembler` | the composition root; supplies `isManagerRun` and `runManagerWorkflow` from `createAgentWorkflowPolicy` and `createWorkflowsService` (`packages/kernel/src/kernel.ts:371,476-495`) |
| `packages/kernel/src/workflows/workflows-service.ts` | `createManagedRun` | `runManagerWorkflow` is the second producer of a `RunHandle`, with `observe` and `settle` |
| `packages/kernel/src/transport/client.ts:43-50` | `coalesceRunEvents`, `isDroppableRunEvent`, `sizeOfRunEvent`, `DEFAULT_RUN_EVENT_BUFFER*` | the remote client re-applies the same backpressure policy locally (`:389-408`) |
| `packages/server/src/mcp/notify.ts:2-5,144,366-370` | `RUN_EVENT_POLICY`, `coalesceRunEvents`, `sizeOfRunEvent` | MCP notification fan-out reuses the table rather than re-listing droppable types |
| `packages/server/src/mcp/event-view.ts:1,168,184` | `RUN_EVENT_POLICY`, `coalesceRunEvents` | the coalesce class is read from the table rather than restated (`:168-184`) |
| `packages/code/src/adapters/event-span.ts:2` | `deriveRunEventSpan` | the TUI groups its transcript by the kernel's span ids |
| `packages/kernel/src/index.ts`, focused subpath modules, and `packages/kernel/package.json` | the exported surface | pinned to six entrypoints by `packages/kernel/tests/architecture/public-surface.test.ts` |

### 7.3 Direction-forcing facts

- `@clarvis/protocol` has no dependency on `@clarvis/loop`, so **something** has to translate; the
  mappers here are that something, and both are pure functions with no store or transport access
  (`packages/kernel/src/runs/map-events.ts:343,397`).
- `event-policy.ts` importing only `type { RunEvent }` (`:1`) is what lets `coalesce-events.ts`,
  `transport/client.ts` and `@clarvis/server` all key off one table without pulling in the run service.
- `run-service.ts` never imports the workflows package; it receives `isManagerRun` and
  `runManagerWorkflow` as optional injected functions (`:40,43`), which is what keeps a host that
  wires no workflows (the docstring's "absent for hosts that do not wire workflows", `:39`) on the
  plain path.
- `managed-run.ts` is imported by both `run-service.ts` and `workflows-service.ts`, and its docstring
  claims sole ownership: "This is the sole owner of buffering, steering, cancellation, elicitation,
  memory-ingest close grace, drop reporting, and stream disposal for ordinary and workflow-manager
  runs" (`:142-145`).

## 8. Open questions

- **`sources`, `durability` and `mapper` have no runtime reader at all.** The only fields anything
  reads are `coalesce` (`packages/kernel/src/runs/coalesce-events.ts:225`, `packages/server/src/mcp/event-view.ts:166`) and
  `droppable` (`packages/kernel/src/runs/coalesce-events.ts:266`, `packages/server/src/mcp/notify.ts:144`). The other three
  exist as documentation-as-data pinned by `packages/kernel/tests/unit/event-policy.test.ts:20-39`. Nothing in the
  code cross-checks them against the mappers — nothing would fail if `plan_created` were marked
  `mapper: "engine"` while `capabilityEventToProto` still produced it.
- **Why `engineEventToProto` ends in `default: return null` instead of a `never` check.** The test
  file flags the consequence — "a new engine event that nobody adds a case for is dropped between the
  kernel and the client with a green build and a green suite. This is the only thing standing in for
  the exhaustiveness check the others get" (`packages/kernel/tests/unit/map-events.test.ts:57-59`, repeated at
  `:665-669`) — but no source states why the open arm is required. That it follows from `TraceEvent`'s
  open contributed-event arm is an inference, not a cited fact.
- **Whether a saturated buffer inside a real managed run behaves as the stream-level test suggests is
  not pinned.** `packages/kernel/src/runs/managed-run.ts:166-169` wires `onSaturated` to an `unavailable` abort, and
  `packages/kernel/src/core/event-stream.ts:168-179` fails the iterable, but no test drives a managed run into
  saturation; the only saturation assertions are at the raw-stream level
  (`packages/kernel/tests/unit/event-stream.test.ts:399-424`).
- **Whether a budget missing `total_token_limit` (but not `on_exceed`) validates as a run request is
  not shown by this subsystem.** `completeBudget` (`packages/kernel/src/runs/settings-assembler.ts:371-379`) never fills a
  missing `total_token_limit` — only a missing `on_exceed` — and `packages/kernel/tests/component/settings-assembler.test.ts:296-306`
  shows exactly that: a settings budget of `{ on_exceed: "escalate" }` is assembled with no
  `total_token_limit` key at all. The engine's own request schema treats `total_token_limit` as
  optional (`packages/loop/src/validation/request/request-schema.ts:106-110`) but conditionally
  requires it when `on_exceed === "stop"` unless the entry has an escalatable bound elsewhere
  (`packages/loop/src/validation/request/budget-rules.ts:11-18`); no test in this package's own suite
  runs an assembled `{ on_exceed: "stop" }`-only budget through `validateBody` to confirm which way it
  resolves.
- **The `started_at + elapsed_ms === ended_at` agreement is upheld by writers, never enforced on
  read.** `summaryToProto` computes `ended_at: s.started_at + s.elapsed_ms`
  (`packages/kernel/src/runs/map-result.ts:132`); `storedToDetail` uses the stored `s.ended_at`
  directly (`:150`). The only two writers of an `ExecutionRecord` — `buildRecord`
  (`packages/trace/src/record-builder.ts:35-56`, `started_at: input.wallStartedAt`, `ended_at:
  input.wallStartedAt + elapsedMs`, `elapsed_ms: elapsedMs`) and `journalToRecord`'s crash-recovery
  path (`packages/trace/src/journal-recovery.ts:382-411`, same pattern) — always derive `ended_at`
  and `elapsed_ms` from one shared `elapsedMs` anchored to the same stored `started_at`, and no
  writer or update path sets any of the three independently of the other two, so the two functions
  compute the same value two different ways for any row this codebase can produce. But
  `StoredSummary`/`StoredExecution` are read via a raw `JSON.parse(...) as T` cast with
  no schema validation (`packages/trace/src/json-trace-store.ts:764`, `:1293`, the latter through
  `parseStoredJson` at `packages/trace/src/trace-store.ts:15-17`), so a hand-edited
  or foreign-written store file could still make the two values diverge, and nothing would detect it.
- **`inspectCoalescedRunEvent` is described as "Internal structural diagnostics"**
  (`packages/kernel/src/runs/coalesce-events.ts:157`) and is exported from the module but from no entrypoint; its only
  consumer is `tests/unit/event-stream.test.ts`.
- **The `ManagedRunSpec.ingestMaxWaitMs` field is described as an "internal deterministic-test seam"**
  (`packages/kernel/src/runs/managed-run.ts:57`) but is a plain public field of an exported interface — no mechanism prevents a
  host from setting it. **Recorded 2026-08-22, shape unchanged**: its `@remarks` now says the lack of
  a mechanism is deliberate and bounds what a host can do with it. The value is clamped against the
  sliding grace before use, so the worst a host achieves is shortening or lengthening how long a
  settled run's stream waits for a memory-ingest notice — it cannot make the wait unbounded and
  cannot affect the run. Hiding it behind a private construction path would cost the one thing it
  buys: a test that observes the absolute deadline without waiting out the real one. It also carries
  an `@internal` tag now, which is the strongest marker available without changing the interface.
- **Delegated, and deliberately not described here:** the `RunEvent` wire schemas and their decoding
  (`transport/run-event-codec.ts`) go to [hosts/kernel-transport.md](kernel-transport.md); `compaction-queue.ts` to
  [engine/context-compaction.md](../engine/context-compaction.md); `memory-ingest-phase.ts`'s job semantics (as opposed to its use as a
  close-grace predicate) to [capabilities/memory-indexer.md](../capabilities/memory-indexer.md); `plan-ref.ts` to [capabilities/plan-capability.md](../capabilities/plan-capability.md);
  `task-binding.ts` to [capabilities/tasks-capability.md](../capabilities/tasks-capability.md); `elicit-bridge.ts` to
  [cross-cutting/elicitation.md](../cross-cutting/elicitation.md); `core/event-stream.ts` itself to
  [hosts/kernel-composition.md](kernel-composition.md) (cited here only where the runs policy plugs into it); the
  workflows manager path to [capabilities/workflows-service.md](../capabilities/workflows-service.md).
