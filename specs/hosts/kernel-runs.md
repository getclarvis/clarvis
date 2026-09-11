# Starting a run, assembling its request, and projecting its events

> Implemented at `packages/kernel/src/runs/**`. Every claim below is anchored to a file and a named symbol or test.
> Open questions are collected in the final section.

## 1. Purpose

Hosted goals reuse this same prepared-run path. A private `GoalExecutionPolicy` constrains the
assembled request before launch and injects its mandatory entry capability into ordinary run deps.
Its observer receives canonical trace events before public projection. Public run arguments cannot
provide this policy. `PreparedKernelRun.tokenLimit` exposes the prepared finite budget without
starting inference so goal creation can inherit it once.
Production: `prepareKernelRun` in [prepare-run.ts](../../packages/kernel/src/runs/prepare-run.ts)
and prepared ordinary execution in [run-service.ts](../../packages/kernel/src/runs/run-service.ts).
Test: the real FileKernel goal journey in
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts).

`packages/kernel/src/runs/` is the layer that turns the protocol's `RunService`
(`RunService` in `packages/protocol/src/runs.ts`) into calls on the engine's `executeRun`
(`packages/kernel/src/runs/run-service.ts`), and turns everything the engine and its capabilities
emit back into the protocol's closed `RunEvent` union (`packages/protocol/src/runs.ts`, `RunEvent`). It owns
four distinct jobs:

1. **Admission and identity** — assigning or accepting an `execution_id`, refusing a duplicate for the
   same owner before any work starts, and holding that reservation until the last late event has been
    delivered (`packages/kernel/src/runs/run-service.ts`).
2. **Request assembly** — reading merged `settings.json` plus the agent markdown records and producing
   the untyped body the engine validates, including the transitive `can_spawn` profile graph, the MCP
   servers those profiles reference, the budget, and the `plans`/`agents` params
   (`packages/kernel/src/runs/settings-assembler.ts`).
3. **Run-scoped machinery** — one `RunHandle` per run, owning the buffered event stream, the steering
   and compaction queues, cancellation, the elicitation bridge, the bounded memory-ingest close grace,
   and the drop report (`packages/kernel/src/runs/managed-run.ts`).
4. **Projection** — the two mappers `engineEventToProto` (persisted engine trace) and
   `capabilityEventToProto` (live capability channel) (`packages/kernel/src/runs/map-events.ts`), the result/detail
   mappers (`packages/kernel/src/runs/map-result.ts`), the engine/protocol message conversion
   (`packages/kernel/src/runs/map-message.ts`), and the declarative per-event policy table that says which of those
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
| --- | --- | --- | --- |
| `createRunService` | value | `(cfg: RunServiceConfig) => KernelRunService` | `packages/kernel/src/runs/run-service.ts`, re-exported at `packages/kernel/src/index.ts` |
| `RunServiceConfig` | type | see §2.3 | `packages/kernel/src/runs/run-service.ts`, `packages/kernel/src/index.ts` |
| `RunRequestAssembler` | type | `(params: StartRunParams & { execution_id: string }) => unknown` | `packages/kernel/src/runs/run-service.ts` |
| `createManagedRun` | value | `(spec: ManagedRunSpec) => RunHandle` | `packages/kernel/src/runs/managed-run.ts`, `packages/kernel/src/index.ts` |
| `ManagedRunContext`, `ManagedRunSpec` | type | see §2.4 | `packages/kernel/src/runs/managed-run.ts` |
| `createSettingsRunAssembler` | value | `(store: ConfigStore, options?: SettingsAssemblerOptions) => RunRequestAssembler` | `packages/kernel/src/runs/settings-assembler.ts`, `packages/kernel/src/index.ts` |
| `SettingsAssemblerOptions` | type | see §2.5 | `packages/kernel/src/runs/settings-assembler.ts` |

### 2.1.1 Prepared host starts

`KernelRunService` adds a trusted optional prepared-execution argument to `start`; it is not a
protocol parameter. `InProcessKernel.prepareRun` uses this overload to launch an immutable body or
prepared workflow while sharing ordinary id reservations and physical leases. Ordinary wire starts
keep their existing assembly-failure behavior. Prepared host calls surface invalid configuration
before conversation intent is committed. The effective snapshot and workflow coupling are specified
in [hosted runs](hosted-runs.md#file-kernel-composition).

Production: `PreparedRunExecution`, `KernelRunService` and `startReserved` in
[run-service.ts](../../packages/kernel/src/runs/run-service.ts); `prepareKernelRun` in
[prepare-run.ts](../../packages/kernel/src/runs/prepare-run.ts). Test:
[prepared-kernel-run.test.ts](../../packages/kernel/tests/integration/prepared-kernel-run.test.ts).

### 2.2 Exported from `@clarvis/kernel/policy`

`packages/kernel/src/policy.ts` describes itself as "Guard, redaction, tool identity, and run-event
policy". The runs-owned half:

| Symbol | Kind | Source |
| --- | --- | --- |
| `capabilityEventToProto`, `engineEventToProto` | value | `packages/kernel/src/runs/map-events.ts` |
| `isIngestPending` | value | `packages/kernel/src/runs/memory-ingest-phase.ts` |
| `RUN_EVENT_POLICY` | value | `packages/kernel/src/runs/event-policy.ts` |
| `coalesceRunEvents`, `sizeOfRunEvent`, `sizeOfCoalescedRunEvent` | value | `packages/kernel/src/runs/coalesce-events.ts` |
| `RunEventDurability`, `RunEventMapper`, `RunEventPolicy`, `RunEventSource` | type | `packages/kernel/src/runs/event-policy.ts` |
| `deriveRunEventSpan`, `iterationSpanId` | value | `packages/kernel/src/runs/run-event-span.ts` |
| `RunEventSpan`, `SpanPhase`, `SpanKind` | type | `packages/kernel/src/runs/run-event-span.ts` |
| `engineResultToProto`, `storedToDetail`, `summaryToProto`, `failedResult` | value | `packages/kernel/src/runs/map-result.ts` |
| `engineMessagesToProto`, `protoMessagesToEngine`, `protoSteerToEngineContent` | value | `packages/kernel/src/runs/map-message.ts` |

`packages/kernel/tests/architecture/public-surface.test.ts` pins the package to exactly six
entrypoints (`.`, `./bootstrap`, `./config`, `./local`, `./logger`, `./policy`), so `./policy` is a deliberate,
named surface rather than a barrel.

Not exported from any entrypoint: `isDroppableRunEvent` and `DEFAULT_RUN_EVENT_BUFFER*`
(`packages/kernel/src/runs/coalesce-events.ts`) — `packages/kernel/src/transport/client.ts` imports
`isDroppableRunEvent` by relative path, while `@clarvis/server` re-derives the same verdict from the
exported table (`packages/server/src/mcp/notify.ts`).

Also internal: `createManagedRunWithRuntime`, `ManagedRunRuntime`, `ManagedRunTimer`
(`packages/kernel/src/runs/managed-run.ts`), marked `@internal` with the stated reason that "hosts configure policy
through `ManagedRunSpec`, not by replacing the kernel's clock" (`packages/kernel/src/runs/managed-run.ts`);
`inspectCoalescedRunEvent` (`packages/kernel/src/runs/coalesce-events.ts`); `normalizeRunPagination` (`packages/kernel/src/runs/pagination.ts`);
`createSteerQueue` (`packages/kernel/src/runs/steer-queue.ts`).

### 2.3 `RunServiceConfig` (`packages/kernel/src/runs/run-service.ts`)

| Field | Type | Meaning |
| --- | --- | --- |
| `deps` | `ExecuteRunDeps` | engine deps; `deps.traceStore` also backs `get`/`list`/`delete` |
| `owner` | `string` | owner key every store read/write and `executeRun` call is scoped to |
| `assembleRunRequest` | `RunRequestAssembler` | builds the engine body |
| `isManagerRun?` | `(params: StartRunParams) => boolean` | routes to the workflow manager path |
| `runManagerWorkflow?` | `(params & { execution_id }) => RunHandle` | the manager path |
| `ingestGraceMs?` | `number` | sliding post-run wait; defaults to `DEFAULT_INGEST_CLOSE_GRACE_MS` |
| `eventBuffer?` | `EventStreamOptions<RunEvent>` | backpressure overrides, merged field-by-field over kernel defaults |
| `lifecycle?` | `KernelLifecycle` | owns active runs; rejects starts while closing |
| `logger?` | `Logger` | where an unmapped event is reported; defaults `NOOP_LOGGER` |

### 2.4 `ManagedRunSpec` / `ManagedRunContext` (`packages/kernel/src/runs/managed-run.ts`)

`ManagedRunContext` is what the execution callback receives: `executionId`, `signal`, `elicit`,
`steer`, `compaction`, `emit`. `ManagedRunSpec` is what a host plugs in: `executionId`,
`execute(context)`, optional `observe(event)`, `settle(result)`, `eventBuffer`, `ingestGraceMs`,
`ingestMaxWaitMs`, `lifecycle`. Two producers use it — `packages/kernel/src/runs/run-service.ts` for an
ordinary run and `runManagerWorkflow` in
`packages/kernel/src/workflows/workflows-service.ts` for a workflow manager run, the latter supplying
`observe`/`settle` to maintain its workflow record.

### 2.5 `SettingsAssemblerOptions` (`packages/kernel/src/runs/settings-assembler.ts`)

| Field | Default | Effect |
| --- | --- | --- |
| `defaultModel?` | none | model when neither `default_model` nor frontmatter names one |
| `defaultIterationLimit?` | `20` | applied when frontmatter omits `iteration_limit` |
| `defaultAgent?` | none | entry agent when the request names none |
| `fallbackTokenLimit?` | `160_000_000` (`FALLBACK_TOTAL_TOKEN_LIMIT`) | fallback budget size |
| `fallbackOnExceed?` | `"escalate"` (`FALLBACK_ON_EXCEED`) | fallback budget `on_exceed` |
| `skills?` | none | `SkillsProvider`; without it any `skill` start param is refused |
| `skillPlansMode?` | none | trusted Plans-mode override for a skill, keyed by name + root source |

### 2.6 Protocol shapes this subsystem produces and consumes

`StartRunParams` (`packages/protocol/src/runs.ts`) is the input; `RunHandle`, `RunResult`, `RunSummary`, `RunDetail` and
`RunEvent` is the output union. `RunHandle` has two settle points that are deliberately
distinct: `done` "Resolves when execution ends; it does not imply that `events` has closed"
 and `closed` "Resolves after execution and bounded post-run event delivery both finish".

Managed handles return an unsubscribe function from `onElicit` and expose the optional
`onElicitSettled` observer. Settlement includes answers, abort and execution closure, allowing a
hosting pump to retain only current questions without consuming events twice. Production:
`createManagedRunWithRuntime` in [managed-run.ts](../../packages/kernel/src/runs/managed-run.ts).
Test: [elicit-bridge.test.ts](../../packages/kernel/tests/unit/elicit-bridge.test.ts), owned by
[elicitation](../cross-cutting/elicitation.md#44-kernel-elicit-bridge--state-machine).

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
[`code-run-host.md`](code-run-host.md#42-runmanaged--the-single-funnel).

## 3. Data and formats

### 3.1 Identifiers

| Identifier | Format | Producer |
| --- | --- | --- |
| `execution_id` | `exec_<uuidv4>` when generated | `generateExecutionId` (`packages/trace/src/execution-id.ts`), called at `packages/kernel/src/runs/run-service.ts` when `params.execution_id` is absent. A client-supplied id is used verbatim. |
| elicitation id | `<executionId>:elicit:<n>` | `packages/kernel/src/runs/elicit-bridge.ts` (delegated document; cited for the id format only) |
| iteration span id | `lead:<n>`, `<subagentId>:<n>`, or `subagent-unknown:<n>` | `iterationSpanId` |
| tool span id | the event's `call_id`; `<agent>:tool` when a `tool_call` carries none | `deriveRunEventSpan` |
| sub-agent span id | `subagent:<delegation_id>` | `deriveRunEventSpan` |
| workflow span id | `workflow:<run_id>` | `deriveRunEventSpan` |

### 3.2 The engine run request body

`createSettingsRunAssembler` returns an object literal typed `unknown` (`RunRequestAssembler`,
`packages/kernel/src/runs/run-service.ts`), which the engine then validates. Its keys, in the order the code writes them
(`packages/kernel/src/runs/settings-assembler.ts`):

| Key | Value |
| --- | --- |
| `messages` | `protoMessagesToEngine(params.messages)` then, for a skill run, one appended `{ role: "user", content: skillRun.seed }` |
| `providers` | `merged.providers ?? []` |
| `servers` | every active-plugin MCP namespace plus each operator MCP namespace referenced by a profile; plugin entries carry `auto_tools: true` |
| `profiles` | the transitive `can_spawn` closure, deduplicated |
| `entry` | resolved agent name |
| `budget` | entry-agent frontmatter `budget`, else `merged.budget`, else the fallback, with `on_exceed` completed |
| `vision_model` | `merged.default_vision_model`, only when a string |
| `execution_id`, `continue_from`, `session_id`, `agent_instance_id`, `output_schema`, `guard_mode`, `guard_judge`, `memory`, `task` | straight passthrough, present only when the param is |
| `prompt_cache_ttl` | request value, else `"1h"` when `guardParksOnHuman(...)`, else absent |
| `hook_user_prompt_expansion` | only for a resolved user-invoked skill; `{ command_name }` is bare for operator/workspace skills and `<plugin>:<skill>` for plugin skills |
| `plans` | request value, else settings block with the skill-mode override, else settings block, else absent |
| `agents` | present only when `merged.agents` is a non-null object |

Note what is **not** forwarded: the `skill` key itself never reaches the engine
(`packages/kernel/src/runs/settings-assembler.ts`; pinned by `packages/kernel/tests/component/settings-assembler.test.ts`),
and a `plans` block's `provider` sub-object is stripped by projection
(`plansBlockToParam`; pinned at `packages/kernel/tests/component/settings-assembler.test.ts`).

An engine `AgentProfile` is built by `buildProfile` with required `name`, `model`,
`tools`, `iteration_limit` and twelve conditionally spread optional fields (`grants`, `can_spawn`,
`default_spawn`, `orchestration`, `base_prompt`, `description`, `reasoning_effort`,
`reasoning_summary`, `retry`, `compaction`, `stagnation_threshold`, `call_timeout_ms`). For the entry
profile only, `base_prompt` is the agent prompt followed by the effective global and workspace context
documents, each rendered as `## Context: <scope>/<filename>`.

An MCP entry is translated, not forwarded: `toEngineServer` parses with `mcpServerSettingsSchema` and
converts through `settingsServerToEngine`. The recorded reason is that
"`settings.json` spells the transport `type` while the engine's strict request schema spells it
`transport`, so an entry forwarded verbatim is rejected downstream as an unrecognized key and takes
the whole run with it". The docstring continues, immediately after: "Failing here —
loudly, naming the server — is also why a bad entry is never dropped silently: a dropped server
surfaces much later as `profile '...' lists tool '...', which is not in the tool pool`, which points
at the agent rather than at the typo". The test comment names it as a shipped defect: "P1 lived here …
every run referencing `<server>.<tool>` died in `validateBody` with `unrecognized_keys`"
(`packages/kernel/tests/component/settings-assembler.test.ts`), and the round trip is asserted.

### 3.3 `RUN_EVENT_POLICY` — the per-event matrix

`RUN_EVENT_POLICY` in `packages/kernel/src/runs/event-policy.ts` is a `const` object with
`satisfies Record<RunEvent["type"], RunEventPolicy>`. Its stated mechanism: the `satisfies`
clause "makes every protocol event addition fail compilation until its replay and drop behavior is
classified". Each entry carries `sources`, `durability`, `mapper`, `coalesce`, `droppable`. Two constructors build the entries: `persisted(mapper="engine",
sources=["engine_trace"])` always sets `coalesce: false, droppable: false`, and
`live(mapper, sources, coalesce=false, droppable=false)` sets `durability: "live_only"`.

Complete table, transcribed :

| Event type | sources | durability | mapper | coalesce | droppable |
| --- | --- | --- | --- | --- | --- |
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

Read as a client live-versus-rehydration matrix: fifteen types are `live_only` and therefore absent
from restored `RunDetail.events` — the three deltas, three workflow state/metadata/progress events,
five plan events, `compaction_started`, `memory_ingest`, `capability_event`, and `events_dropped`.
The latest workflow sequence state remains separately durable in the workflow store. The engine may
still record one first `tool_input_delta` announcement per provider attempt in its raw trace as a
bounded diagnostic breadcrumb; `rehydrateEvents` maps stored entries and then filters them through
this policy, so that breadcrumb cannot revive a stale composing tool in a restored client. This is
consistent with the integration assertion that a stored run has no client `tool_output_delta` but
does have the closing `tool_call` (`packages/kernel/tests/integration/run-service.smoke.test.ts`).

### 3.4 The `events_dropped` notice

Built in `packages/kernel/src/runs/managed-run.ts` as `{ type: "events_dropped", at: runtime.now(), dropped }`.
`dropped` is written twice — the pre-push snapshot, then re-read from the stream after the push, because pushing the notice into a full buffer can itself evict a further victim. A
concrete instance is asserted at `packages/kernel/tests/unit/managed-run.test.ts`: with
`eventBuffer: { maxBuffered: 2 }` and three pushed events, the consumer sees exactly
`[{ run_ended }, { type: "events_dropped", at: 1_000, dropped: 2 }]`.

### 3.5 Capability-event wire bounds

`packages/kernel/src/runs/map-events.ts` fixes the generic envelope's limits: `MAX_CAPABILITY_EVENT_DETAIL_BYTES = 64 *
1024` (exported), depth 32, 4 096 nodes. Text crossing the boundary passes `terminalSafe`
(`sanitizeText`, then the ANSI-escape regex, then remaining C0/C1 controls) and labels
additionally through `terminalLabel`, which slices to 4 096 chars then to 256 code points.
Over-budget detail becomes a string ending in a truncation marker, cut on a UTF-8 boundary
(`utf8Prefix`).

Typed capability projections are validated by closed zod schemas before being trusted
(`capabilityRunEventSchemas`): `planProjectionSchema` is `.strip()` so
internal fields such as `objective`/`context` are removed rather than widening the DTO (pinned at `packages/kernel/tests/unit/map-events.test.ts`), `plan_removed` is `.strict()`, and
`plan_updated`/`plan_review_resolved` extend it with `change`/`outcome` enums.
`PLAN_UPDATE_CHANGES` — `plan_updated`'s `change` enum — is four-valued: `content`, `task`,
`status`, `recovery`, exactly the set `@clarvis/plan` emits. `plan_review_resolved`'s
`outcome` enum is three-valued: `approved`, `changes_requested`, `cancelled`. Every plan
projection's `tasks` array is `planTaskSchema` (`.strict()`): `id`, `title`, `status` (a
six-value enum — `pending`, `in_progress`, `returned`, `done`, `abandoned`, `failed`), and optional
`detail`, `exit`, `assignee`, `result`, `error`, `reason`.

The memory notice is a five-arm discriminated union on `phase`
(`started`/`queued`/`done`/`failed`/`blocked`), each arm `.strict()`:

| Phase | Fields (beyond `execution_id`, `phase`) |
| --- | --- |
| `started` | none |
| `queued` | `indexer_run_id?` |
| `done` | `written?`, `deleted?`, `reindexed?`, `skipped?`, `note?`, `indexer_run_id?` |
| `failed` | `error?`, `indexer_run_id?` |
| `blocked` | `note?` |

`indexer_run_id` is optional on `queued`/`done`/`failed` but absent from the `started`/`blocked` arms
entirely — an extra field on either of those two is rejected by the arm's `.strict()`, not merely
ignored.

### 3.6 `RunDetail` hydration

`storedToDetail` (`packages/kernel/src/runs/map-result.ts`) builds the detail from a `StoredExecution`:
`result` from `engineResultToProto`, then usage token totals **overwritten** from the stored row's
`total_input_tokens`/`total_output_tokens`/`total_cached_tokens`, `plan_ref` from
`capability_state` (delegated; `packages/kernel/src/runs/plan-ref.ts`), `active_task` likewise (`packages/kernel/src/runs/task-binding.ts`),
`extension_profile` validated from opaque `host_metadata.extension_profile`, `recovery` forwarded verbatim when
present, `messages` via `engineMessagesToProto`, and `events` via `rehydrateEvents`. That last step
maps only recognized events and retains only entries whose mapped protocol type is `persisted` in
`RUN_EVENT_POLICY`; its debug summary reports total, mapped and dropped counts. The filter is needed
even though ordinary deltas are signals because the loop deliberately records the first tool-input
announcement for post-mortem diagnosis.

`extensionProfileFromHostMetadata` accepts only a qualified Extension Profile id and a lowercase SHA-256
fingerprint, then projects exactly those two strings (`packages/kernel/src/runs/map-result.ts`).
Malformed or extra host metadata is not reflected into the protocol DTO.

`engineResultToProto`'s `liveUsage` maps each `by_agent` row through `mapPerAgent`, which renames the engine's `type` to protocol `role` and includes `iterations` only when
the engine recorded it **and** `a.type !== "vision"` — a vision agent's usage row never carries
`iterations`, even one the engine did set.

## 4. Behavior

### 4.1 `RunService.start` (`packages/kernel/src/runs/run-service.ts`)

1. `executionId = params.execution_id ?? generateExecutionId()`.
2. Reject with `kernelError("conflict", "run '<id>' already exists for this owner")` if the id is in
   the in-process `activeIds` set **or** `store.existsForOwner(owner, executionId)` returns true. No engine work has happened at this point.
3. `activeIds.add(executionId)`.
4. `startReserved(params, executionId)` :
   - if `runManagerWorkflow` is configured **and** `isManagerRun?.(params) === true`, hand the whole
     thing to the workflow manager and return its handle;
   - otherwise `createManagedRun({ executionId, eventBuffer, ingestGraceMs, lifecycle, execute })`.
5. Register the release on `handle.closed`, **not** `handle.done`. The stated reason, in the
   code comment: "`done` settles before the managed stream's optional ingest grace. Keep the id
   reserved until both model execution and event delivery finish, otherwise a same-id retry can
   overlap late capability events and write into the first run's trace/lifecycle scope".
6. If handle construction throws synchronously, release the reservation and rethrow.

Assembly happens **inside** `execute`, not in `start`, so an assembly failure (unknown agent,
malformed MCP entry, no resolvable model) never rejects `start` — it settles `done` as a failed
result. `packages/kernel/tests/integration/run-service.smoke.test.ts` pins exactly that: starting with
`agent: "ghost"` yields a handle whose `done` is `{ status: "failed", error.code: "not_found" }`.

### 4.1a Settled-context inspection and compaction

`RunService.context` returns only a token estimate, presence flag, and optional target-window fit
verdict. `RunService.compact` queues through the live handle while it exists; otherwise it loads the
owner-scoped persisted execution. Guided compaction uses the stored request and LLM, then atomically
replaces `final_context`. A mechanical target performs no model call and persists only after the
replacement fits. Production: `createRunService` in `packages/kernel/src/runs/run-service.ts`.
Test: `packages/kernel/tests/unit/run-service-lifecycle.test.ts`.

An ineffective guided summary leaves the stored context intact but still charges consumed model
usage. A summary completing after its execution was deleted returns `not_found`; it cannot recreate
the execution. Production: `createRunService.compact` in
[run-service.ts](../../packages/kernel/src/runs/run-service.ts). Test: the settled guided compaction
and removed-execution cases in
[run-service-lifecycle.test.ts](../../packages/kernel/tests/unit/run-service-lifecycle.test.ts).

### 4.2 Assembly (`packages/kernel/src/runs/settings-assembler.ts`)

Per call, in order:

1. `store.readSettings().merged`.
2. `store.readContext` is called for `"global"` and `"workspace"`; absent scopes contribute nothing,
   and each non-null effective document is retained in that order. The store's
   first-existing-wins rule means each scope contributes `CLARVIS.md` when present, otherwise
   `AGENTS.md`; the two candidates from one scope are never both injected.
3. `resolveSkillRun(params.skill, options.skills)` : loads the skill, refuses with
   `not_found` when there is no skills source, no such skill, or `userInvocable` is false; reads the skill's own `agent` via `skillEntryAgent`
   (`packages/kernel/src/skills/render-skill-prompt.ts`); renders the seed with
   `renderSkillPrompt`. The assembler always (re-)renders and appends its own copy of the
   seed (§3.2's `messages` row) regardless of what the caller sent — its docstring states the caller
   contract this implies: a host that already rendered the skill's seed into the current turn's
   `messages` for display must still forward the `skill` start param, and must leave that local copy
   out of `messages`, or the run doubles the seed.
4. `skillPlansMode` is consulted only when both a `skill` param and a resolved skill exist, and is passed the skill's root `source` for provenance.
   The same resolved invocation produces `hook_user_prompt_expansion.command_name`: a plugin source
   contributes its install identity as `<plugin>:<skill>`, while other sources keep the skill name
   bare. No field is emitted for an ordinary prompt or a model-initiated `load_skill` call
   (`hookCommandName`; literal projection).
5. Entry agent = `skillRun?.agent ?? params.agent ?? options.defaultAgent`; `invalid_request` when
   all three are absent.
6. `store.readEffectiveAgent(agentName)`; `not_found` when null.
7. Breadth-first walk over `can_spawn` with a `seen` set; a child that resolves to `null` is
   **skipped, not fatal** (pinned at `packages/kernel/tests/component/settings-assembler.test.ts`). Only the first
   name is treated as the entry, and only that profile receives the context documents.
8. Server selection starts with every namespace returned by `pluginMcpServerNames`, then resolves
   each profile tool against the longest exact registered `<namespace>.` prefix. This preserves
   namespaced plugins whose compatible package name itself contains dots. A missing key contributes
   nothing. Active plugin entries carry `auto_tools: true`; operator entries remain profile-scoped
   (`createSettingsRunAssembler`).
9. Budget: entry frontmatter `budget` if it is a non-null object, else `merged.budget`, else the
   fallback; `on_exceed` filled from the fallback when the declared budget omits it.
10. The literal is returned.

**Entry versus child model/effort resolution is deliberately asymmetric** (`buildProfile`): for the entry profile the merged `default_model` / `default_reasoning_effort` win
over frontmatter; for a spawned child the frontmatter wins and the defaults are the fallback. The
docstring states the intent — "The user's `/model` and `/effort` defaults are authoritative for the
entry profile. A spawned child instead keeps an explicit model or effort from its own profile, falling
back to those defaults only when it declares none. This distinction lets changing the current run
model do what the user asked without flattening a heterogeneous sub-agent fleet" — and
`packages/kernel/tests/component/settings-assembler.test.ts` pins both halves.

`plansBlockToParam` **materializes** `mode` and `retention`, and additionally carries an optional
`pending_task_nudges` through when the block's value is a non-negative integer, dropping it otherwise
 — while `agentsBlockToParam` **omits** every unset field.
The code names the difference: the plans default would otherwise be unreachable behind the plan
store's own fallback, whereas "the loop owns the defaults outright (`AGENTS_DEFAULTS`),
so an absent field must stay absent — writing one out would freeze today's default into every run
request and make a later change to it invisible". `agentsBlockToParam` recognizes exactly
ten numeric fields, `AGENTS_FIELDS` : `buffer_lines`, `buffer_bytes`,
`max_total_buffer_bytes`, `poll_max_bytes`, `await_timeout_ms`, `max_live_children`,
`max_retained_children`, `max_notices_per_iteration`, `max_consecutive_failed_children`,
`finish_nudges` — each carried through only when it is a non-negative integer.

`prompt_cache_ttl` derivation: an explicit request value wins; otherwise
`guardParksOnHuman(params.guard_mode, merged.guard, params.guard_judge !== undefined)`
(`packages/kernel/src/guard/resolver.ts`) yields `"1h"`, and nothing is emitted when it is
false. The guard predicate returns true for mode `on` and for mode `auto` with no judge
(`packages/kernel/src/guard/resolver.ts`). `packages/kernel/tests/component/settings-assembler.test.ts` pins all four cases, including that an
unconfigured host derives `"1h"` because the guard defaults to on.

### 4.3 Managed-run construction (`packages/kernel/src/runs/managed-run.ts`)

Order of construction, which matters because later steps capture earlier ones:

| Step | Effect |
| --- | --- |
| `AbortController` | backs `context.signal` and `handle.cancel` |
| `resolveEventBuffer(spec.eventBuffer)` | merges host overrides over kernel defaults, then wraps `droppable` |
| `createEventStream` with `onSaturated` / `onAbandoned` | a saturated stream aborts the run with `unavailable`; an abandoned one aborts with `cancelled` |
| steer queue, compaction queue, elicit bridge | run-scoped control channels |
| ingest bounds | see §4.5 |
| `emitRelay.connect(...)` | push, then observe, then ingest bookkeeping |
| lifecycle registration | close means abort, await `executionStarted`, await `done`, force-settle ingest, await `closed` |
| the `done` async IIFE | executes and settles |
| `resolveExecutionStarted()` | released synchronously after `done` is constructed |

`resolveEventBuffer` merges each field independently with `??`, so a `0` supplied for
`maxBuffered` survives (disabling only the count cap and leaving `DEFAULT_RUN_EVENT_BUFFER_BYTES` in
force — `packages/kernel/src/runs/run-service.ts` says both caps must be `0` for an unbounded override). `sizeOfCoalesced`
defaults to `sizeOfCoalescedRunEvent` only when the host supplied neither `sizeOf` nor `coalesce`. Finally the effective `droppable` is wrapped so `events_dropped` can never be a victim.

The emit path is: `stream.push(event)`, then `spec.observe?.(event)`, then
`ingestPendingAfter(event)`; a non-`undefined` verdict sets `ingestPending` and either renews the
sliding wait or settles it.

### 4.4 The `done` promise (`packages/kernel/src/runs/managed-run.ts`)

| Situation | Result |
| --- | --- |
| lifecycle exists and `state !== "open"` | throws `kernelError("unavailable", "kernel is closing")` before `execute` runs |
| `execute` throws or rejects | `failedResult(executionId, toKernelError(error))` |
| `settle` throws | the settle failure replaces the result: `failedResult(...)` |
| always | `steer.close()`, `compaction.close()`, `closeStream()` in `finally` |

`packages/kernel/tests/unit/managed-run.test.ts` pins both failure conversions (code `internal`, messages
`"execution exploded"` and `"settlement exploded"`), pins that a lifecycle closed
before construction yields
`{ status: "failed", error: { code: "unavailable", message: "kernel is closing" } }` with `execute`
never invoked.

### 4.5 Stream close and the memory-ingest grace

State machine, from `closeStream` and `endStream` :

| State | Event | Next state | Effect |
| --- | --- | --- | --- |
| executing | `done` settles, `ingestPending === false` | closed | `endStream()` immediately |
| executing | `done` settles, `ingestPending === true` | waiting | schedule a timer for `min(ingestGraceMs, absoluteDeadline - now)` |
| waiting | a `memory_ingest` with phase `started` or `queued` | waiting | `renewIngestWait()` cancels and re-schedules |
| waiting | a `memory_ingest` with a terminal phase (`done`/`failed`/`blocked`, or unrecognized) | closed | `settleIngest()` cancels the timer and resolves |
| waiting | timer fires | closed | resolve, then `endStream()` |
| closed | any later `emit` | closed | the relay target is disconnected, so the event reaches nothing |

`endStream` in order: emit the drop notice if any, `emitRelay.disconnect()`,
`stream.close()`, release the lifecycle registration, `resolveClosed()`. The disconnect is explained in place: "Async capability listeners may retain
`context.emit` beyond the ingest grace window. Leave them only the tiny relay after closure, not this
target's stream, observer, timers, and full ManagedRunSpec graph"; pinned at
`packages/kernel/tests/unit/managed-run.test.ts`, where a retained `emit` after close reaches neither the
stream nor `observe`.

The wait is bounded twice. `ingestGraceMs` is clamped into `[0, MAX_INGEST_CLOSE_WAIT_MS]`, and `ingestMaxWaitMs` is at least `ingestGraceMs` and likewise clamped.
Constants: grace `5_000`, absolute `15_000`, hard ceiling `60_000`
(`packages/kernel/src/runs/memory-ingest-phase.ts`), the last documented as "No host/test override may retain a
settled run beyond one minute". `packages/kernel/tests/unit/managed-run.test.ts` pins the sliding
renewal (deadlines 1 080, then 1 110, then 1 170) pins that renewals stop at the
absolute deadline (1 100, with `ingestGraceMs: 40, ingestMaxWaitMs: 100`).

### 4.6 Live event fold (`packages/kernel/src/runs/run-service.ts`)

`executeRun` is given two listeners. `onEvent` maps a `TraceEvent` through `engineEventToProto` and
`onCapabilityEvent` maps a `CapabilityEvent` through `capabilityEventToProto`; in both cases
`context.emit(mapped)` runs **only when the mapper returned non-`null`**. The handle's
`steer`, `compaction`, `signal` and `elicit` are handed through as the engine's `SteerSource`,
`CompactionSource`, `externalSignal` and `Elicit` (engine-side parameter names at
`packages/loop/src/runtime/execute-run.ts`). The outcome is converted by
`engineResultToProto(outcome.executionId, outcome.response)`.

### 4.7 `engineEventToProto` (`packages/kernel/src/runs/map-events.ts`)

Three gates, in order:

1. `isWorkflowPersistedTraceEvent(ev)` — the workflows package's own runtime guard; a match goes to
   `workflowEventToProto`. A workflow discriminator whose payload fails that
   guard returns `null` (pinned at `packages/kernel/tests/unit/map-events.test.ts`).
2. `isBuiltinTraceEvent(ev)` — otherwise report `not_builtin` and return `null`.
3. A `switch` over the builtin union, ending in
   `default: reportUnmapped(..., "no_projection"); return null`.

`workflowEventToProto` is itself a three-arm switch, not just a dispatch target: every
arm carries `parent_run_id`. On `workflow_run_started` it spreads an optional `profile`, falls back to
`legacyWorkflowTitle(event.task)` when `event.title` is unset, and conditionally spreads
`round_id`/`pass`/`item_index`/`replica`/`replica_count`. On `workflow_run_completed` it
hardcodes `status: "completed"` rather than deriving it. On `workflow_run_failed` it
derives `status` via `endedReasonToStatus(event.status)` and conditionally spreads `error`. `legacyWorkflowTitle` is the title fallback for a persisted event that
predates the `title` field: it takes the first non-blank line of `task`, then `parseTaskTitle`
(falling back to a `TASK_TITLE_MAX`-clipped slice on failure) — the same `@clarvis/capability` helper
listed in §7.1.

Notable renames and derivations inside the switch: `mcp_name` becomes `server` and `ok` is derived as
`ev.error === null` on `tool_call`; `lead_iteration`/`subagent_iteration` collapse to one
`iteration_completed` carrying an `agent` field; `model_reasoning` becomes `reasoning`, `model_stream_delta` becomes `text_delta`, `model_call_error` becomes `model_error`, `model_call_retry` becomes `model_retry`, `user_question` becomes
`elicitation_resolved`, `user_steering` becomes `steering_applied`;
`run_ended.reason` is mapped to a `status` through `endedReasonToStatus`, which collapses everything
but `completed`/`cancelled` to `failed`. `mcp_degraded` drops each
server's `transport`. `delegation_completed`/`delegation_failed` put the engine's `result`
through `terminalLabel` — sanitized and capped at 256 code points — as `summary`.

The `tool_call` projection copies `ev.guard` unchanged when present, so live and
rehydrated runs expose the same final command-review fact. Production: the
`tool_call` arm of `engineEventToProto` in
`packages/kernel/src/runs/map-events.ts`; Test: the first tool-call mapping case
in `packages/kernel/tests/unit/map-events.test.ts`.

Two builtin types are refused **explicitly** rather than by the default arm: `convergence_warning`
and `guard_escalation`. They shared one comment that explained only the first, which left the second
reading as unfinished work; **the comment now gives each its own reason**, because they
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
`null`, so this refusal produces the same sampled debug line as every other dropped event —
just with a distinct reason string — rather than dropping silently.
`packages/kernel/tests/unit/map-events.test.ts` pins that it stays one.

`sub(id)` is the spread helper that keeps `subagent_id` off a lead event entirely rather
than setting it to `undefined`; every optional engine field is spread the same conditional way, so
"absent data never becomes an explicit `undefined` on the wire".

### 4.8 `capabilityEventToProto` (`packages/kernel/src/runs/map-events.ts`)

1. `event.capability === MEMORY_CAPABILITY_NAME`: only `MEMORY_INGEST_EVENT` is accepted (anything
   else is reported `not_ingest` and dropped); the detail is bounded then parsed against
   `memoryIngestSchema`, and a truncated or non-matching payload is dropped with reason `truncated`
   or `schema`. On success: `{ type: "memory_ingest", at: Date.now(), detail }`.
2. No `wire`, or `wire.detail === undefined`: reported `no_wire_projection`, returns `null`.
3. The detail is bounded and sanitized; if a **closed schema exists for `wire.type`** and the detail
   was not truncated and it parses, the event is
   `{...parsed.data, type: event.wire.type, at: Date.now() }`. Because `type` and `at`
   are written **after** the spread, capability detail cannot override either — pinned at
   `packages/kernel/tests/unit/map-events.test.ts`, which also asserts the serialized output does not contain
   the injected `Bearer secret-token`.
4. Anything else becomes the generic envelope `capability_event` carrying sanitized `capability`,
   `kind` and `projection` labels plus the bounded `detail` and a `truncated` flag.

All three of `capabilityEventToProto`'s successful returns stamp `at: Date.now()` — a wall-clock timestamp taken by the **kernel at projection time**, not carried from when the
capability actually emitted the event. This is unlike `engineEventToProto`, whose every case reads
`at` from the trace event itself (`ev.occurred_at`/`ev.started_at`/`ev.ended_at`/etc., e.g.); a capability-channel event's `at` therefore reflects delivery time, not origination
time.

The docstring records that the previous design matched against a list of known capability names, and
that "any capability the kernel had not been taught about … had its events dropped in silence". `packages/kernel/tests/unit/map-events.test.ts` pins the new behaviour for an invented `audit`
capability.

### 4.9 Backpressure (`coalesce-events.ts` over `core/event-stream.ts`)

The stream merges into the buffer tail only when the buffer is non-empty, and the code states why
that is sufficient: "the generator parks only on an empty buffer, so a non-empty buffer *means*
backpressure. A consumer that keeps up therefore still receives every item verbatim, and no timer or
coalescing window is needed" (`packages/kernel/src/core/event-stream.ts`; pinned at
`packages/kernel/tests/unit/event-stream.test.ts`).

`coalesceRunEvents` merges only same-type pairs whose `RUN_EVENT_POLICY[...].coalesce`
class matches, and only when `sameAgent` holds (`agent` **and** `subagent_id` equal):

| Pair | Extra join key | Merge rule |
| --- | --- | --- |
| `text_delta` | same `iteration` and `channel`; refuses when `next.reset` | append; keeps `previous.at` and `previous.reset` |
| `tool_output_delta` | same `call_id` | append; keeps `previous.at` |
| `tool_input_delta` | same `call_id` | **replace**: `{...next, at: prev.at }` |

The replacement rule for `tool_input_delta` is explained in the docstring — its argument `chars`
and optional provider `stream_chars` are cumulative rather than slices — and in the test:
"Concatenating the way the two content deltas do would report a 3 KB call as 6 KB"
(`packages/kernel/tests/unit/event-stream.test.ts`).

The two appending kinds do not concatenate eagerly. A merged event carries a hidden
`CoalescedTextState` under a module-private symbol holding `blocks` and `pending`, flushed
every 4 096 chars (`COALESCED_TEXT_BLOCK_CHARS`, `appendText`), and exposes `text` or
`chunk` as an accessor that materializes once and then releases the sources. Further deltas mutate the same object in place and return it unchanged
(`appendChunkedEvent`; pinned at `packages/kernel/tests/unit/event-stream.test.ts`, which asserts
`merged` is identity-equal to the first aggregate across 20 000 appends, `materializations === 0`
before read and `1` after, and fewer than 4 100 retained blocks).

The `text`/`chunk` accessor is also **writable**: the same `Object.defineProperty` calls that install
the getter install a setter (`replaceText`) wired, so external code can
overwrite a coalesced event's backing state directly by assignment rather than only reading it.

`sizeOfCoalescedRunEvent` keeps byte accounting O(1): append kinds add
`appendedJsonStringBytes(incoming.text|chunk)` (JSON-encoded length minus the two quotes),
`tool_input_delta` swaps only the `at` field's encoded size because every other field, including
both cumulative counters, comes from the replacing event; anything else falls back to a full
`sizeOfRunEvent`. `sizeOfRunEvent` returns `Number.MAX_SAFE_INTEGER` when `JSON.stringify` throws, with the reason in place: "A contributed detail that cannot cross the wire must never
make a local consumer's buffer unbounded. Treat it as oversized and fail closed"; pinned
at `packages/kernel/tests/unit/event-stream.test.ts`.

`isDroppableRunEvent` reads the table directly.

### 4.10 Rehydration (`packages/kernel/src/runs/map-result.ts`)

`rehydrateEvents` maps every persisted trace event through `engineEventToProto` and filters `null`
away, then always emits one `runs.rehydrated` debug line with `events_total`, `events_mapped`,
`events_dropped`. The docstring calls this "the aggregate half of the §4 rule whose
per-artifact half is `runs.event.unmapped`". `packages/kernel/tests/unit/observability.test.ts`
pins the counts (2 total, 1 mapped, 1 dropped).

`reportUnmapped` (`packages/kernel/src/runs/map-events.ts`) is guarded by `levelEnabled(logger, "debug")` **before** the
bindings object is allocated and then by a module-scoped `createSampler()` keyed on
`path\0capability\0kind`. The sampler is module-scoped deliberately: "the two mappers
share one budget: a format skew produces the same `(path, kind)` pair on every event of that type,
and a rehydration replays a whole run's trace in one loop".
`packages/kernel/tests/unit/observability.test.ts` pins that 40 identical unmapped events produce more than 0
and fewer than 40 lines.

### 4.11 Read paths

| Operation | Behaviour |
| --- | --- |
| `get(id)` | `store.getById(owner, id)`; `null` gives `kernelError("not_found", …)`; else `storedToDetail(row, logger)` (`packages/kernel/src/runs/run-service.ts`) |
| `list(page?)` | `normalizeRunPagination(page)` then `store.list(owner, limit, offset)`, rows through `summaryToProto`; the page echoes the normalized `limit`/`offset` |
| `delete(id)` | `store.deleteById(owner, id)`; `false` gives `not_found` |

`normalizeRunPagination` (`packages/kernel/src/runs/pagination.ts`) defaults `limit` to `DEFAULT_RUN_LIST_LIMIT = 20`
 and `offset` to `0`, and throws `invalid_request` unless each is a safe integer within
`[0, MAX_TRACE_LIST_LIMIT]` and `[0, MAX_TRACE_LIST_OFFSET]` (200 and 10 000 —
`packages/trace/src/json-trace-store.ts`). Pinned at
`packages/kernel/tests/integration/run-service.smoke.test.ts`.

There is no admin read path beside those three. `TraceStore.listAcrossOwners`
(`packages/trace/src/trace-store.ts`) stays optional on the store port, but nothing under
`packages/kernel/src/runs/` calls it, so every read this subsystem performs is keyed under one
`owner`.

### 4.12 Span derivation (`deriveRunEventSpan`)

`deriveRunEventSpan` is a total function over the protocol union with a `default` arm that is a
compile-time `never` check. Highlights: run start/end frame the `"run"` span; iteration and model-output events (`reasoning`, `text_delta`, `model_error`,
`model_retry`) sit on `iterationSpanId(...)`; tool events key on `call_id`; `steering_applied` and `compaction_started`/`compaction`/`compaction_skipped` route to the sub-agent span only
when `subagent_id` is present, else to `"run"`; every remaining standalone notice —
including all five plan events, `memory_ingest`, `capability_event` and `events_dropped` — is a
`point` of kind `event` on `"run"`.

`SpanKind` has no `"workflow"` member — the `workflow:<run_id>` span id (§3.1) is only an id
convention layered on the existing kinds, not a distinct category. `workflow_run_started` opens and
`workflow_run_completed`/`workflow_run_failed` close a span of kind `subagent`;
`workflow_run_progress` is a `point` of kind `subagent` on that same span; both
`workflow_title_updated` and `workflow_sequence_state` are `point`s of kind `event` on the manager
run span.

`iterationSpanId` isolates an id-less sub-agent event rather than letting it claim the lead's span,
and states the reason: "claiming `lead:N` for it would interleave its text with the lead's own
stream. It gets an isolated, deliberately non-colliding span so the damage is a stray anonymous node
instead of a scrambled transcript". Pinned at `packages/kernel/tests/unit/run-event-span.test.ts`.

## 5. Invariants

Each entry: the rule, the production anchor, the test anchor (or "unpinned").

**INV-R1 (owns INV-228).** `RUN_EVENT_POLICY` marks exactly three event types droppable —
`text_delta`, `tool_input_delta`, `tool_output_delta` — and every droppable entry also declares a
non-`false` `coalesce` class.
Production: `RUN_EVENT_POLICY`. Test: `packages/kernel/tests/unit/event-policy.test.ts`, whose comment
gives the justification: "the two content deltas are superseded by an authoritative terminal event,
and `tool_input_delta` carries cumulative counts, so the next one restates them in full".

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
Production `packages/kernel/src/runs/managed-run.ts`. Test `packages/kernel/tests/unit/managed-run.test.ts` (the notice
survives at `maxBuffered: 2`); indirectly `packages/kernel/tests/integration/kernel-event-buffer.test.ts`.

**INV-R5.** The drop count on that notice is read **after** the notice is pushed, because the push can
evict another victim.
Production `packages/kernel/src/runs/managed-run.ts`. Test `packages/kernel/tests/unit/event-stream.test.ts`, whose title is
"a terminal notice can itself evict a buffered item — `dropped()` must be read after that push, not
before", plus `packages/kernel/tests/unit/managed-run.test.ts`.

**INV-R6.** An execution id is refused when it is either live in this process or already persisted for
this owner, and the refusal is `conflict`, raised before any engine work.
Production `packages/kernel/src/runs/run-service.ts`. Test `packages/kernel/tests/integration/run-service.smoke.test.ts`,
`packages/kernel/tests/unit/run-service-lifecycle.test.ts`.

**INV-R7.** The id reservation is released on `handle.closed`, not `handle.done`.
Production `packages/kernel/src/runs/run-service.ts`. Test `packages/kernel/tests/unit/run-service-lifecycle.test.ts` — a second
start with the same id is rejected after `done` resolves and accepted only after `closed` resolves.

**INV-R8.** Neither mapper ever forwards an unrecognized shape into the closed protocol union; it
returns `null` and the caller drops it.
Production `packages/kernel/src/runs/map-events.ts`; drop sites `packages/kernel/src/runs/run-service.ts` and
`packages/kernel/src/runs/map-result.ts`. Test `packages/kernel/tests/unit/map-events.test.ts`. The reason is
stated at `packages/kernel/src/runs/map-events.ts`: "It stays a log: what the mapper *returns* is unchanged, because a
client's event union is closed and forwarding an unrecognized shape into it is the worse failure."

**INV-R9.** Capability-supplied detail can override neither the event discriminator nor its timestamp.
Production `packages/kernel/src/runs/map-events.ts` (`type` and `at` written after the spread). Test
`packages/kernel/tests/unit/map-events.test.ts`.

**INV-R10.** Every capability projection that crosses to a client is secret-redacted,
terminal-control stripped and byte-bounded.
Production `packages/kernel/src/runs/map-events.ts` (`boundJsonValue` plus `sanitizeDeep(…, terminalSafe)`).
Test `packages/kernel/tests/unit/map-events.test.ts` — asserts absence of `secret-token` and of any escape
byte, and a detail no larger than `MAX_CAPABILITY_EVENT_DETAIL_BYTES` for cyclic, 1 000-deep,
throwing-accessor and 2 MiB inputs.

**INV-R11.** A memory-ingest notice reaches a client only when it matches the five-arm phase union
exactly; an unknown phase or an extra field drops it.
Production `packages/kernel/src/runs/map-events.ts`. Test `packages/kernel/tests/unit/map-events.test.ts` — pins
`queued` and `blocked` as first-class (with the regression note that they were "silently dropped
instead of reaching the wire"), and that `{ phase: "failed", injected: true }` yields `null`.

**INV-R12.** Adjacent deltas merge only within identical attribution (`agent` plus `subagent_id`) and
the kind's own join key, and never across a `reset`.
Production `packages/kernel/src/runs/coalesce-events.ts`. Test
`packages/kernel/tests/unit/event-stream.test.ts`.

**INV-R13.** Coalescing is lossless in characters; only event *count* is lost.
Production `packages/kernel/src/runs/coalesce-events.ts` (the docstring's claim) and the accessor implementation. Test `packages/kernel/tests/unit/event-stream.test.ts` — 5 000 deltas through a stalled consumer,
`dropped() === 0`, exact concatenation preserved.

**INV-R14.** A merged text or tool-output event's retained bytes are computed incrementally, never by
re-serializing the whole prefix.
Production `packages/kernel/src/runs/coalesce-events.ts`. Test `packages/kernel/tests/unit/event-stream.test.ts`.

**INV-R15.** A run event that cannot be JSON-serialized is charged `Number.MAX_SAFE_INTEGER` bytes
(fail closed) rather than zero.
Production `packages/kernel/src/runs/coalesce-events.ts`. Test `packages/kernel/tests/unit/event-stream.test.ts`.

**INV-R16.** A stream whose sole consumer abandons it cancels the run; a stream saturated with
non-droppable events aborts it as `unavailable`.
Production `packages/kernel/src/runs/managed-run.ts`. Test `packages/kernel/tests/unit/managed-run.test.ts` for the abandon
half (abandon, abort, `cancelled` result). The saturation half is pinned only at the stream level
(`packages/kernel/tests/unit/event-stream.test.ts`), not through a managed run — see §8.

**INV-R17.** After the stream closes, a capability that retained `context.emit` reaches neither the
stream nor `observe`.
Production `packages/kernel/src/runs/managed-run.ts` (`emitRelay.disconnect()`), relay. Test
`packages/kernel/tests/unit/managed-run.test.ts`.

**INV-R18.** The post-run ingest wait slides on every non-terminal notice but is capped by an absolute
deadline, and no host or test override may exceed one minute.
Production `packages/kernel/src/runs/managed-run.ts`; constants `packages/kernel/src/runs/memory-ingest-phase.ts`. Test
`packages/kernel/tests/unit/managed-run.test.ts`.

**INV-R19.** Assembly and execution failures after reservation settle `done` as a failed `RunResult`;
they never reject `start`.
Production `packages/kernel/src/runs/run-service.ts` (assembly inside `execute`), `packages/kernel/src/runs/managed-run.ts`. Test
`packages/kernel/tests/integration/run-service.smoke.test.ts`.

**INV-R20.** A `settle` that throws replaces an otherwise-successful result with a failed one.
Production `packages/kernel/src/runs/managed-run.ts`. Test `packages/kernel/tests/unit/managed-run.test.ts`.

**INV-R21.** A kernel that is not `open` refuses to execute, reporting `unavailable` and "kernel is
closing" through `done` rather than through `start`.
Production `packages/kernel/src/runs/managed-run.ts`. Test `packages/kernel/tests/unit/managed-run.test.ts`,
`packages/kernel/tests/integration/run-service.smoke.test.ts`.

**INV-R22.** Steering is acknowledged only when the loop drains the message. If the run closes
before that drain, or steering begins after settlement, `steer` throws `not_found`; `compact` also
throws `not_found` after settlement. A protocol success therefore cannot mean only that a transient
queue accepted data.
Container transfer uses `take()` without resolving the pending acknowledgement. Its delivery handle
settles only after the guest confirms a loop drain; closing either queue or refusing a late guest
RPC settles the message as undelivered. A refused control request does not overwrite a successful
run result, and authority teardown is unconditional even if the control pump rejects.
Production: `packages/kernel/src/runs/steer-queue.ts` (`push`, `drain`, `close`),
`packages/kernel/src/runs/managed-run.ts` (`RunHandle.steer`, `RunHandle.compact`), and
`packages/kernel/src/runs/compaction-queue.ts` (`push`). Tests:
`packages/kernel/tests/unit/run-control-queues.test.ts` (drain acknowledgement and close refusal) and
`packages/kernel/tests/unit/managed-run.test.ts` (close-before-drain and post-settlement refusal).
Production: `createIsolatedRunExecutor` in `packages/kernel/src/runtime/isolated-run-executor.ts`.
Test: `packages/kernel/tests/integration/isolated-run-executor.test.ts` (guest acknowledgement,
completion race and unconditional authority teardown).

Both queues also expose `undrained()`, which inspects queued-but-not-yet-drained messages without
consuming them (`packages/kernel/src/runs/steer-queue.ts`; `packages/kernel/src/runs/compaction-queue.ts`). The handle's `compact`
also wraps its argument before pushing: `compaction.push(request === undefined ? {} : { request })`
(`packages/kernel/src/runs/managed-run.ts`) — an absent protocol `request` becomes an empty object, a supplied one is
nested under a `request` key, and only the push's boolean result (not the shape) decides the
`not_found` throw.

**INV-R23.** Run listing and paging are bounded at the kernel boundary, not left to the store.
Production `packages/kernel/src/runs/pagination.ts`. Test `packages/kernel/tests/integration/run-service.smoke.test.ts`.

**INV-R24.** Every trace read and write is owner-scoped; a cross-owner `get` or `delete` reports
`not_found`.
Production `packages/kernel/src/runs/run-service.ts` (all three store calls pass `owner`). Test
`packages/kernel/tests/integration/owner-isolation.test.ts`.

**INV-R25.** There is no cross-owner read path in this subsystem at all — neither a cross-owner
`get` nor a cross-owner index.
Production `packages/kernel/src/runs/run-service.ts` is the entire read surface and every
call passes `owner`; `TraceStore.listAcrossOwners` (`packages/trace/src/trace-store.ts`) has no
caller under `packages/kernel/src/`. Test: unpinned — an absence has none.

**INV-R26.** `engineMessagesToProto` keeps only `user` and `assistant` messages; a `system` message
never reaches a client.
Production `packages/kernel/src/runs/map-message.ts`. Test `packages/kernel/tests/unit/map-message.test.ts`.

**INV-R27.** Image parts round-trip: engine `mediaType`/`image` against protocol `mime`/`data`, with
`ref` as the fallback source and `application/octet-stream` as the fallback MIME.
Production `packages/kernel/src/runs/map-message.ts`. Test `packages/kernel/tests/unit/map-message.test.ts`.

**INV-R28.** Any stored execution status other than `completed`/`cancelled` collapses to `failed` on
the wire, in both the stored and the live path.
Production `packages/kernel/src/runs/map-result.ts`; the event-level twin is `packages/kernel/src/runs/map-events.ts`. Test
`packages/kernel/tests/unit/map-events.test.ts` (`reason: "error"` gives `status: "failed"`).

**INV-R29.** A `RunDetail`'s token totals come from the stored row, overriding whatever the response's
own usage said.
Production `packages/kernel/src/runs/map-result.ts`. Test: unpinned as an override — the totals are exercised only as
part of the round trip at `packages/kernel/tests/integration/run-service.smoke.test.ts`, which never
constructs a disagreement.

**INV-R30.** `recovery` is forwarded verbatim when the stored row carries it and the key is absent
otherwise.
Production `packages/kernel/src/runs/map-result.ts`. Test `packages/kernel/tests/unit/map-result.test.ts`, including
`Object.hasOwn(detail, "recovery") === false`.

**INV-R31.** The `plans` settings block is materialized with defaults for `mode` and `retention`; the
`agents` block is projected sparsely.
Production `packages/kernel/src/runs/settings-assembler.ts`. Test
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R32.** An explicit per-run `plans` param beats a skill's Plans policy, which beats the settings
block.
Production `packages/kernel/src/runs/settings-assembler.ts` (the nested ternary order). Test
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R33.** A skill's declared `agent` overrides the request's `agent`; a skill naming none leaves it
alone.
Production `packages/kernel/src/runs/settings-assembler.ts` (`skillRun?.agent ?? params.agent ?? …`). Test
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R34.** The `skill` key is never forwarded to the engine.
Production `packages/kernel/src/runs/settings-assembler.ts` — no `skill` key in the returned literal; the stated reason
is. Test `packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R34a.** Prompt-expansion hook context is emitted exactly for a successfully resolved
user-invoked skill, and plugin provenance is represented by a generic qualified command name rather
than by changing the skill seed or forwarding the kernel-only `skill` input.
Production `packages/kernel/src/runs/settings-assembler.ts`. Test
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R35.** A malformed `mcpServers` entry fails the whole assembly by name; it is never dropped.
Production `packages/kernel/src/runs/settings-assembler.ts`. Test
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R35a.** Active plugin MCP servers are attached even when every persisted profile has an empty
MCP tool list, carry `auto_tools: true`, and leave those profile lists unchanged. Operator MCP
servers are still omitted unless a profile references their namespace. A namespace containing dots
is matched as one exact registered prefix rather than split at its first dot.
Production: `createSettingsRunAssembler` and file-kernel `pluginMcpServerNames` composition. Test:
the active-plugin, dotted-namespace, and unreferenced-server cases in
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R36.** A `can_spawn` target that resolves to no agent is skipped, not fatal.
Production `packages/kernel/src/runs/settings-assembler.ts` (`if (rec === null) continue`). Test
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R37.** The entry profile takes the user's `default_model`/`default_reasoning_effort` first; a
spawned child takes its own frontmatter first.
Production `packages/kernel/src/runs/settings-assembler.ts`. Test
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R38.** `prompt_cache_ttl` defaults to `"1h"` exactly when the effective guard mode parks on a
human, and an explicit request param always wins.
Production `packages/kernel/src/runs/settings-assembler.ts`; predicate `packages/kernel/src/guard/resolver.ts`. Test
`packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-R39.** `completeBudget` fills in exactly one field: a declared budget missing `on_exceed` gets
the fallback's `on_exceed` (`{...declared, on_exceed: fallback.on_exceed }`). It never supplies a
missing `total_token_limit` — a budget declared as `{ on_exceed: "stop" }` alone is returned
unchanged, `total_token_limit` still absent.
Production `packages/kernel/src/runs/settings-assembler.ts`. Test
`packages/kernel/tests/component/settings-assembler.test.ts` (which additionally runs the assembled body
through the engine's own `validateBody`) covers only the missing-`on_exceed` case; no
test in this subsystem exercises a declared budget missing `total_token_limit`, so whether the
resulting request validates in that case is not shown here — see §8.

**INV-R40.** `deriveRunEventSpan` is total over the protocol union, enforced by a `never` assignment.
Production: the exhaustive default in `deriveRunEventSpan`. Test:
`packages/kernel/tests/unit/run-event-span.test.ts`, which
documents the arm as "compile-time-only" by asserting the bogus input is returned unchanged.

**INV-R41.** An unmapped-event report is sampled and costs nothing below `debug`.
Production `packages/kernel/src/runs/map-events.ts`. Test `packages/kernel/tests/unit/observability.test.ts`.

**INV-R42.** Each configured scope contributes at most one context document to the entry profile's
`base_prompt`: `CLARVIS.md` wins when present, otherwise `AGENTS.md` is the fallback; neither file is
added to child profiles.
Production `packages/kernel/src/runs/settings-assembler.ts` plus the selection
order at `packages/kernel/src/config/file-config-store.ts`. Test
`packages/kernel/tests/component/settings-assembler.test.ts` covers absence, fallback, and
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

**INV-R46.** Rehydration never exposes a protocol event whose `RUN_EVENT_POLICY` durability is
`live_only`, even when the engine intentionally retained a bounded raw trace breadcrumb of that
type. Production: `rehydrateEvents` in `packages/kernel/src/runs/map-result.ts` and
`RUN_EVENT_POLICY`. Test: `packages/kernel/tests/unit/observability.test.ts` (`runs.rehydrated`).

## 6. Failure modes and degradation

| Condition | Handler | Outcome |
| --- | --- | --- |
| duplicate `execution_id` for the owner | `packages/kernel/src/runs/run-service.ts` | `KernelException("conflict")` thrown from `start`; nothing launched |
| engine's own in-flight id clash (`ConflictError`) | `packages/loop/src/runtime/execute-run.ts`, then `toKernelError`'s name match | surfaces inside `execute`, so it lands as a **failed result**; `toKernelError` maps a name containing `Conflict` to `conflict`, everything else to `internal` (`packages/kernel/src/core/errors.ts`) |
| unknown agent, unknown skill, no default agent | `packages/kernel/src/runs/settings-assembler.ts` | `not_found` or `invalid_request` **as a failed `RunResult`**, because assembly runs inside `execute` |
| malformed `mcpServers` entry | `packages/kernel/src/runs/settings-assembler.ts` | `invalid_request` naming the server key and the zod issue path |
| agent resolves no model | `packages/kernel/src/runs/settings-assembler.ts` | `invalid_request`, `"agent '<n>' declares no model and no default_model is set"` |
| `execute` throws | `packages/kernel/src/runs/managed-run.ts` | `failedResult(executionId, toKernelError(error))` |
| `settle` throws | `packages/kernel/src/runs/managed-run.ts` | previous result discarded, failed result returned |
| kernel closing at start | `packages/kernel/src/runs/managed-run.ts` | `unavailable` / `"kernel is closing"` on `done` |
| consumer stops draining and only structural events remain | `packages/kernel/src/runs/managed-run.ts` | run aborted with `unavailable` / `"run event consumer stopped draining"`; the underlying stream also fails with `"event stream saturated with N non-droppable items"` (`packages/kernel/src/core/event-stream.ts`) |
| consumer returns early (breaks out of `for await`) | `packages/kernel/src/runs/managed-run.ts` | run aborted with `cancelled` / `"run event consumer abandoned the stream"` |
| buffer full, droppable victims available | `packages/kernel/src/core/event-stream.ts` | oldest droppable evicted, `droppedCount` incremented; a terminal `events_dropped` notice reports the total |
| memory-ingest notice never arrives | `packages/kernel/src/runs/managed-run.ts` | stream closes after the sliding grace, bounded by the absolute deadline |
| `compact()` after settle | `packages/kernel/src/runs/managed-run.ts` | `not_found` / `"run '<id>' is no longer active"` |
| `steer()` after settle or while an undrained message loses the run | `packages/kernel/src/runs/steer-queue.ts` (`push`, `close`) and `packages/kernel/src/runs/managed-run.ts` (`RunHandle.steer`) | `not_found` / `"run '<id>' is no longer accepting steering"` |
| `respond()` with an unknown id | `packages/kernel/src/runs/elicit-bridge.ts` (delegated) | silently ignored |
| pagination out of range | `packages/kernel/src/runs/pagination.ts` | `invalid_request` naming the bound |
| engine event with no protocol projection | `packages/kernel/src/runs/map-events.ts` | dropped; sampled `runs.event.unmapped` debug line |
| capability event with no `wire` projection | `packages/kernel/src/runs/map-events.ts` | dropped; `reason: "no_wire_projection"` |
| capability detail too large, cyclic, or with throwing accessors | `packages/kernel/src/runs/map-events.ts` | bounded and truncated, never thrown; unserializable becomes the literal `"[unserializable capability event]"` |
| rehydration maps an unknown entry or encounters a mapped live-only breadcrumb | `rehydrateEvents` in `packages/kernel/src/runs/map-result.ts` | the entry is omitted from `RunDetail.events`; `runs.rehydrated` reports total/mapped/dropped counts |
| plan or task slot in `capability_state` malformed | `packages/kernel/src/runs/plan-ref.ts`, `packages/kernel/src/runs/task-binding.ts` (delegated) | field omitted from `RunDetail`, no throw; pinned at `packages/kernel/tests/unit/map-result.test.ts` |
| Extension Profile slot in `host_metadata` malformed | `extensionProfileFromHostMetadata` in `packages/kernel/src/runs/map-result.ts` | `extension_profile` omitted from `RunDetail`; other run data still hydrates |

## 7. Coupling

### 7.1 Outbound (static imports)

| Dependency | Where | What forces it |
| --- | --- | --- |
| `@clarvis/loop` | `packages/kernel/src/runs/run-service.ts`, `packages/kernel/src/runs/map-result.ts` (types), `packages/kernel/src/runs/map-message.ts` (types), `packages/kernel/src/runs/managed-run.ts` (types), `packages/kernel/src/runs/settings-assembler.ts` | `executeRun` and the settled-context helpers are runtime values loaded dynamically; the engine DTOs (`ExecuteRunDeps`, `StoredExecution`, `RunResponse`, `Message`) are type-only. `settings-assembler.ts` additionally takes four **values** from `@clarvis/loop/host`: `agentPromptOf`, `mcpServerSettingsSchema`, `normalizeTools`, `settingsServerToEngine` |
| `@clarvis/protocol` | every file in `runs/` | the closed `RunEvent` union is what `RUN_EVENT_POLICY` is `satisfies`-checked against, and what `deriveRunEventSpan` exhausts |
| `@clarvis/capability` | `packages/kernel/src/runs/map-events.ts`, `packages/kernel/src/runs/run-service.ts`, `packages/kernel/src/runs/map-result.ts` | `isBuiltinTraceEvent`, `sanitizeDeep`/`sanitizeText`, `createSampler`, `levelEnabled`, `parseTaskTitle`/`TASK_TITLE_MAX`, `NOOP_LOGGER`; `packages/kernel/src/runs/managed-run.ts` also takes `suppressSecondaryRejection` |
| `@clarvis/memory/settings` | `packages/kernel/src/runs/map-events.ts` | `MEMORY_CAPABILITY_NAME` and `MEMORY_INGEST_EVENT` — the one capability with a typed, kernel-validated projection |
| `@clarvis/workflows` | `packages/kernel/src/runs/map-events.ts` | `isWorkflowPersistedTraceEvent` is the first gate in `engineEventToProto`; the workflows package owns its own trace guard |
| `@clarvis/plan/settings` | `packages/kernel/src/runs/settings-assembler.ts` | `PLANS_DEFAULTS` for the materialized `mode` and `retention` |
| `@clarvis/plan`, `@clarvis/tasks/*` | `packages/kernel/src/runs/plan-ref.ts`, `packages/kernel/src/runs/task-binding.ts` | capability-state slot names and schema (delegated documents) |
| `@clarvis/trace` | `packages/kernel/src/runs/run-service.ts`, `packages/kernel/src/runs/pagination.ts` | runtime `generateExecutionId` plus `MAX_TRACE_LIST_LIMIT`/`MAX_TRACE_LIST_OFFSET`; nothing under `runs/` names the `TraceStore` type — `packages/kernel/src/runs/run-service.ts` takes the store off `deps.traceStore` |
| kernel-internal | `core/event-stream.ts`, `core/errors.ts`, `core/bounded-json.ts`, `application/lifecycle.ts`, `config/config-store.ts`, `guard/resolver.ts`, `skills/render-skill-prompt.ts` | see the per-file imports cited above |

`settings-assembler.ts` deliberately does **not** import the kernel's settings schema: it declares its
own loose `EngineSettings` interface and comments that it is "deliberately loose, since the config
store owns the full schema".

### 7.2 Inbound

| Consumer | Import | Nature |
| --- | --- | --- |
| `packages/kernel/src/kernel.ts` | `createRunService`, `createSettingsRunAssembler` | the composition root; supplies `isManagerRun` and `runManagerWorkflow` from `createAgentWorkflowPolicy` and `createWorkflowsService` (`packages/kernel/src/kernel.ts`) |
| `packages/kernel/src/workflows/workflows-service.ts` | `createManagedRun` | `runManagerWorkflow` is the second producer of a `RunHandle`, with `observe` and `settle` |
| `packages/kernel/src/transport/client.ts` | `coalesceRunEvents`, `isDroppableRunEvent`, `sizeOfRunEvent`, `DEFAULT_RUN_EVENT_BUFFER*` | the remote client re-applies the same backpressure policy locally |
| `packages/server/src/mcp/notify.ts` | `RUN_EVENT_POLICY`, `coalesceRunEvents`, `sizeOfRunEvent` | MCP notification fan-out reuses the table rather than re-listing droppable types |
| `packages/server/src/mcp/event-view.ts` | `RUN_EVENT_POLICY`, `coalesceRunEvents` | the coalesce class is read from the table rather than restated |
| `packages/code/src/adapters/event-span.ts` | `deriveRunEventSpan` | the TUI groups its transcript by the kernel's span ids |
| `packages/kernel/src/index.ts`, focused subpath modules, and `packages/kernel/package.json` | the exported surface | pinned to six entrypoints by `packages/kernel/tests/architecture/public-surface.test.ts` |

### 7.3 Direction-forcing facts

- `@clarvis/protocol` has no dependency on `@clarvis/loop`, so **something** has to translate; the
  mappers here are that something, and both are pure functions with no store or transport access
  (`packages/kernel/src/runs/map-events.ts`).
- `event-policy.ts` importing only `type { RunEvent }` is what lets `coalesce-events.ts`,
  `transport/client.ts` and `@clarvis/server` all key off one table without pulling in the run service.
- `run-service.ts` never imports the workflows package; it receives `isManagerRun` and
  `runManagerWorkflow` as optional injected functions, which is what keeps a host that
  wires no workflows (the docstring's "absent for hosts that do not wire workflows") on the
  plain path.
- `managed-run.ts` is imported by both `run-service.ts` and `workflows-service.ts`, and its docstring
  claims sole ownership: "This is the sole owner of buffering, steering, cancellation, elicitation,
  memory-ingest close grace, drop reporting, and stream disposal for ordinary and workflow-manager
  runs".

## 8. Open questions

- **`sources`, `durability` and `mapper` have no runtime reader at all.** The only fields anything
  reads are `coalesce` (`packages/kernel/src/runs/coalesce-events.ts`, `packages/server/src/mcp/event-view.ts`) and
  `droppable` (`packages/kernel/src/runs/coalesce-events.ts`, `packages/server/src/mcp/notify.ts`). The other three
  exist as documentation-as-data pinned by `packages/kernel/tests/unit/event-policy.test.ts`. Nothing in the
  code cross-checks them against the mappers — nothing would fail if `plan_created` were marked
  `mapper: "engine"` while `capabilityEventToProto` still produced it.
- **Why `engineEventToProto` ends in `default: return null` instead of a `never` check.** The test
  file flags the consequence — "a new engine event that nobody adds a case for is dropped between the
  kernel and the client with a green build and a green suite. This is the only thing standing in for
  the exhaustiveness check the others get" (`packages/kernel/tests/unit/map-events.test.ts`, repeated) — but no source states why the open arm is required. That it follows from `TraceEvent`'s
  open contributed-event arm is an inference, not a cited fact.
- **Whether a saturated buffer inside a real managed run behaves as the stream-level test suggests is
  not pinned.** `packages/kernel/src/runs/managed-run.ts` wires `onSaturated` to an `unavailable` abort, and
  `packages/kernel/src/core/event-stream.ts` fails the iterable, but no test drives a managed run into
  saturation; the only saturation assertions are at the raw-stream level
  (`packages/kernel/tests/unit/event-stream.test.ts`).
- **Whether a budget missing `total_token_limit` (but not `on_exceed`) validates as a run request is
  not shown by this subsystem.** `completeBudget` (`packages/kernel/src/runs/settings-assembler.ts`) never fills a
  missing `total_token_limit` — only a missing `on_exceed` — and `packages/kernel/tests/component/settings-assembler.test.ts`
  shows exactly that: a settings budget of `{ on_exceed: "escalate" }` is assembled with no
  `total_token_limit` key at all. The engine's own request schema treats `total_token_limit` as
  optional (`packages/loop/src/validation/request/request-schema.ts`) but conditionally
  requires it when `on_exceed === "stop"` unless the entry has an escalatable bound elsewhere
  (`packages/loop/src/validation/request/budget-rules.ts`); no test in this package's own suite
  runs an assembled `{ on_exceed: "stop" }`-only budget through `validateBody` to confirm which way it
  resolves.
- **The `started_at + elapsed_ms === ended_at` agreement is upheld by writers, never enforced on
  read.** `summaryToProto` computes `ended_at: s.started_at + s.elapsed_ms`
  (`packages/kernel/src/runs/map-result.ts`); `storedToDetail` uses the stored `s.ended_at`
  directly. The only two writers of an `ExecutionRecord` — `buildRecord`
  (`packages/trace/src/record-builder.ts`, `started_at: input.wallStartedAt`, `ended_at:
  input.wallStartedAt + elapsedMs`, `elapsed_ms: elapsedMs`) and `journalToRecord`'s crash-recovery
  path (`packages/trace/src/journal-recovery.ts`, same pattern) — always derive `ended_at`
  and `elapsed_ms` from one shared `elapsedMs` anchored to the same stored `started_at`, and no
  writer or update path sets any of the three independently of the other two, so the two functions
  compute the same value two different ways for any row this codebase can produce. But
  `StoredSummary`/`StoredExecution` are read via a raw `JSON.parse(...) as T` cast with
  no schema validation (`packages/trace/src/json-trace-store.ts`, the latter through
  `parseStoredJson` at `packages/trace/src/trace-store.ts`), so a hand-edited
  or foreign-written store file could still make the two values diverge, and nothing would detect it.
- **`inspectCoalescedRunEvent` is described as "Internal structural diagnostics"**
  (`packages/kernel/src/runs/coalesce-events.ts`) and is exported from the module but from no entrypoint; its only
  consumer is `tests/unit/event-stream.test.ts`.
- **The `ManagedRunSpec.ingestMaxWaitMs` field is described as an "internal deterministic-test seam"**
  (`packages/kernel/src/runs/managed-run.ts`) but is a plain public field of an exported interface — no mechanism prevents a
  host from setting it. **Recorded, shape unchanged**: its `@remarks` now says the lack of
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
