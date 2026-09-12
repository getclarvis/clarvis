# Trace vocabulary, recording, on-disk store, journal and recovery

> Implemented at `packages/capability/src/trace-*.ts` and `packages/trace/**`. Every claim below is
> anchored to a file and a named symbol or test. Open questions are collected in the final section.

## 1. Purpose

Two packages split one concern. `@clarvis/capability` owns the **vocabulary** — which events exist,
what payload each carries, and the two open/closed narrowing guards
(`packages/capability/src/trace-kinds.ts`, `packages/capability/src/trace-events.ts`).
`@clarvis/trace` owns the **implementation** — the recording handle, the wire mapper, the display
caps, the on-disk JSON store, the crash journal and its recovery, and the retention sweeper
(`packages/trace/src/index.ts`). `@clarvis/trace` declares only `@clarvis/capability` and
`@clarvis/paths` as dependencies and no external package at all
(`packages/trace/package.json`).

The recording side is deliberately structural rather than adapted: `TraceHandle extends TracePort`
(`packages/trace/src/trace-handle.ts`), and `TracePort` is the interface a capability records
through (`packages/capability/src/ports.ts`). So a capability outside the engine records its own
kinds — `TraceKind` is `BuiltinTraceKind | (string & {})`
(`packages/capability/src/trace-kinds.ts`) — without the engine declaring them.

The persistence side exists so a run survives its own process. Two independent durable paths run
concurrently: the batch path (`buildRecord` → `mapTrace` → `TraceStore.insert`, driven from
`packages/loop/src/runtime/execute-run.ts`) writes one JSON file at the end of a run, and the
journal path (`RunJournal.append` per durable entry,
`packages/loop/src/runtime/run-trace.ts`) writes a `.jsonl` line as each event is recorded.
When the process dies before the batch path completes, `recoverOrphans` folds the journal into an
`interrupted` record (`packages/trace/src/json-trace-store.ts`,
`packages/trace/src/journal-recovery.ts`).

## 2. Surface

### 2a. `@clarvis/capability` — vocabulary (entrypoints `.` and `./trace`)

`packages/capability/src/trace.ts` re-exports `trace-kinds.ts` and `trace-projectors.ts` wholesale
 and a named list from `trace-events.ts`.

| Symbol | Kind | File | What it is |
| --- | --- | --- | --- |
| `BUILTIN_TRACE_KINDS` | const tuple, 37 entries | `packages/capability/src/trace-kinds.ts` | the runtime source of truth for engine-declared kinds |
| `BuiltinTraceKind` | type | `packages/capability/src/trace-kinds.ts` | `(typeof BUILTIN_TRACE_KINDS)[number]` |
| `TraceKind` | type | `packages/capability/src/trace-kinds.ts` | open union: builtin or `(string & {})` |
| `TraceDetailMap` | interface | `packages/capability/src/trace-kinds.ts` | kind → detail type, one entry per builtin kind |
| `TraceDetailFor<K>` | type | `packages/capability/src/trace-kinds.ts` | exact detail for a builtin kind, `unknown` otherwise |
| `BuiltinTraceEntry` | type | `packages/capability/src/trace-kinds.ts` | `{ at, kind, detail }` mapped over `BuiltinTraceKind` |
| `TraceEntry` | type | `packages/capability/src/trace-kinds.ts` | `BuiltinTraceEntry \| { at: number; kind: string; detail: unknown }` |
| `isBuiltinTraceEntry` | fn | `packages/capability/src/trace-kinds.ts` | narrows a `TraceEntry` against the kind set |
| `isBuiltinTraceKind` | fn | `packages/capability/src/trace-kinds.ts` | narrows a bare string |
| `RecordingTrace` | interface | `packages/capability/src/trace-kinds.ts` | `{ entries: TraceEntry[] }` |
| `BuiltinTraceEvent` | type | `packages/capability/src/trace-events.ts` | closed union of 31 flat, absolute-time wire events |
| `BUILTIN_TRACE_EVENT_TYPES` | const tuple, 31 entries | `packages/capability/src/trace-events.ts` | the runtime list for `isBuiltinTraceEvent` |
| `ContributedTraceEvent` | interface | `packages/capability/src/trace-events.ts` | `{ type: string; occurred_at: number; detail: unknown }` |
| `PersistedContributedTraceEvent` | interface | `packages/capability/src/trace-events.ts` | `{ type: string; [field: string]: unknown }` |
| `TraceEvent` | type | `packages/capability/src/trace-events.ts` | union of the three above |
| `isBuiltinTraceEvent` | fn | `packages/capability/src/trace-events.ts` | narrows a `TraceEvent` |
| `Trace` | interface | `packages/capability/src/trace-events.ts` | `{ events: TraceEvent[] }` |
| `ExecutionRecovery` | interface | `packages/capability/src/trace-events.ts` | `{ skipped_lines, synthesized_tool_calls }` |
| `ExecutionRecord` | interface | `packages/capability/src/trace-events.ts` | the full persisted record (§3a) |
| `PersistedTraceProjection` | interface | `packages/capability/src/trace-projectors.ts` | `{ readonly type: string; [field: string]: unknown }` |
| `PersistedTraceProjectorContext` | interface | `packages/capability/src/trace-projectors.ts` | `{ absoluteTime(offset: number): number }` |
| `PersistedTraceProjector` | interface | `packages/capability/src/trace-projectors.ts` | `{ kind, project(entry, context) → TraceEvent \| PersistedTraceProjection \| null }` |
| `PersistedTraceProjectorRegistry` | interface | `packages/capability/src/trace-projectors.ts` | `projectorFor(kind)` / `projectors()` |
| `createPersistedTraceProjectorRegistry` | fn | `packages/capability/src/trace-projectors.ts` | builds a frozen registry with duplicate/builtin rejection |
| `composePersistedTraceProjectors` | fn | `packages/capability/src/trace-projectors.ts` | copies a base registry and appends run-scoped projectors |

`TracePort` itself (`packages/capability/src/ports.ts`) has exactly three members: `record<K>(kind,
detail)`, `signal<K>(kind, detail)`, and `now(): number`.

`VisionAnalysisDetail` (`packages/capability/src/trace-kinds.ts`) is reachable through `./trace`'s `export *`
(`packages/capability/src/trace.ts`) but is not in `index.ts`'s explicit type-export list, which
never names it.

Two detail shapes are published but **not** in `BUILTIN_TRACE_KINDS`: `PlanReviewDetail`
(`packages/capability/src/trace-kinds.ts`) and `TaskNudgeDetail` (`packages/capability/src/trace-kinds.ts`). The doc comment
states the reason directly: "`plan_review` is a kind the planning capability records, not one the
engine does. The shape stays published so the capability and any host that renders it agree on one
definition rather than two." The kind-level exclusion is directly verifiable against the closed
37-entry `BUILTIN_TRACE_KINDS` array (`packages/capability/src/trace-kinds.ts`), which contains neither string, but
that exclusion has no test of its own. What
`packages/capability/tests/unit/open-vocabularies.test.ts` actually pins is the sibling,
downstream claim — that `BUILTIN_TRACE_EVENT_TYPES` (the *mapped*-event vocabulary; see its own row
below) also excludes both `"plan_review"` and `"task_nudge"`.

#### The 37 `BUILTIN_TRACE_KINDS`, paired with their `TraceDetailMap` entry

The recording-side vocabulary, one row per entry of `BUILTIN_TRACE_KINDS` (`packages/capability/src/trace-kinds.ts`) and
its paired detail type from `TraceDetailMap`; `init`/`terminate` carry no structured
payload. Field-level shapes for the kinds that matter to a downstream reader are documented at their
point of use elsewhere in this spec (the cap table in §2d, the mapping table in §4c, the span table in
§4o); this table exists so the vocabulary itself — which §1 claims this package owns — is enumerated
once, in one place.

| Kind | Detail type | Source |
| --- | --- | --- |
| `init` | `unknown` | `packages/capability/src/trace-kinds.ts` |
| `lead_iteration` | `LeadIterationDetail` | `packages/capability/src/trace-kinds.ts` |
| `lead_iteration_started` | `LeadIterationStartedDetail` | `packages/capability/src/trace-kinds.ts` |
| `subagent_iteration` | `SubagentIterationDetail` | `packages/capability/src/trace-kinds.ts` |
| `subagent_iteration_started` | `SubagentIterationStartedDetail` | `packages/capability/src/trace-kinds.ts` |
| `tool_call` | `ToolCallDetail` | `packages/capability/src/trace-kinds.ts` |
| `tool_call_started` | `ToolCallStartedDetail` | `packages/capability/src/trace-kinds.ts` |
| `tool_output_delta` | `ToolOutputDeltaDetail` | `packages/capability/src/trace-kinds.ts` |
| `tool_input_delta` | `ToolInputDeltaDetail` | `packages/capability/src/trace-kinds.ts` |
| `budget_check` | `BudgetCheckDetail` | `packages/capability/src/trace-kinds.ts` |
| `terminate` | `unknown` | `packages/capability/src/trace-kinds.ts` |
| `delegation_created` | `DelegationCreatedDetail` | `packages/capability/src/trace-kinds.ts` |
| `delegation_completed` | `DelegationFinishedDetail` | `packages/capability/src/trace-kinds.ts` |
| `delegation_failed` | `DelegationFinishedDetail` (shared with `delegation_completed`) | `packages/capability/src/trace-kinds.ts` |
| `compaction_started` | `CompactionStartedDetail` | `packages/capability/src/trace-kinds.ts` |
| `compaction` | `CompactionDetail` | `packages/capability/src/trace-kinds.ts` |
| `compaction_skipped` | `CompactionSkippedDetail` | `packages/capability/src/trace-kinds.ts` |
| `vision_analysis` | `VisionAnalysisDetail` | `packages/capability/src/trace-kinds.ts` |
| `cancellation` | `CancellationDetail` | `packages/capability/src/trace-kinds.ts` |
| `user_question` | `UserQuestionDetail` | `packages/capability/src/trace-kinds.ts` |
| `user_steering` | `UserSteeringDetail` | `packages/capability/src/trace-kinds.ts` |
| `soft_limit_check` | `SoftLimitCheckDetail` | `packages/capability/src/trace-kinds.ts` |
| `run_started` | `RunStartedDetail` | `packages/capability/src/trace-kinds.ts` |
| `run_ended` | `RunEndedDetail` | `packages/capability/src/trace-kinds.ts` |
| `delegation_started` | `DelegationStartedDetail` | `packages/capability/src/trace-kinds.ts` |
| `model_call_error` | `ModelCallErrorDetail` | `packages/capability/src/trace-kinds.ts` |
| `model_call_retry` | `ModelCallRetryDetail` | `packages/capability/src/trace-kinds.ts` |
| `convergence_warning` | `ConvergenceWarningDetail` | `packages/capability/src/trace-kinds.ts` |
| `guard_escalation` | `GuardEscalationDetail` | `packages/capability/src/trace-kinds.ts` |
| `elicitation_requested` | `ElicitationRequestedDetail` | `packages/capability/src/trace-kinds.ts` |
| `model_reasoning` | `ModelReasoningDetail` | `packages/capability/src/trace-kinds.ts` |
| `model_stream_delta` | `ModelStreamDeltaDetail` | `packages/capability/src/trace-kinds.ts` |
| `mcp_degraded` | `McpDegradedDetail` | `packages/capability/src/trace-kinds.ts` |
| `agent_registered` | `AgentRegisteredDetail` | `packages/capability/src/trace-kinds.ts` |
| `agent_stopped` | `AgentStoppedDetail` | `packages/capability/src/trace-kinds.ts` |
| `agent_steered` | `AgentSteeredDetail` | `packages/capability/src/trace-kinds.ts` |
| `agent_finish_nudge` | `AgentFinishNudgeDetail` | `packages/capability/src/trace-kinds.ts` |

`LeadIterationDetail` and `SubagentIterationDetail` carry optional `response_phase` with the
bounded values `commentary` or `final_answer`. `mapEntry` preserves it on the corresponding flat
event, and `engineEventToProto` projects it to `iteration_completed`. Production:
`recordIterationMetrics`, `mapEntry`, and `engineEventToProto`. Tests:
`packages/trace/tests/unit/trace-mapper.test.ts`,
`packages/kernel/tests/unit/map-events.test.ts`, and
`packages/code/tests/unit/streaming-delta.test.ts`.

`ToolInputDeltaDetail` carries cumulative call-scoped argument `chars`, optional attempt-wide
`stream_chars` liveness, and optional `complete: true`; the latter means only that the provider
closed the argument stream. `ModelCallRetryDetail.message` carries the
bounded failure that scheduled the retry. Neither shape retains argument contents. Production:
`ToolInputDeltaDetail` and `ModelCallRetryDetail`. Tests:
`packages/loop/tests/unit/stream-delta-attribution.test.ts` and
`packages/trace/tests/unit/trace-mapper-kinds.test.ts`.

`ToolCallDetail.guard?: CommandGuardReview` is the final, persisted command
review attached only to the terminal call. `mapEntry` preserves it in the
persisted `TraceEvent`; `tool_call_started` and live output deltas do not carry
an interim verdict. Production: `ToolCallDetail`/`CommandGuardReview` in
`packages/capability/src/trace-kinds.ts` and the `tool_call` arm in
`packages/trace/src/trace-mapper.ts`. Test: the tool projection case in
`packages/trace/tests/unit/trace-mapper.test.ts`.

The table above is anchored to `BUILTIN_TRACE_KINDS` in
`packages/capability/src/trace-kinds.ts`. These kinds have no wire projection at all (§4c step 3,
T-13): `init`, `terminate`, `agent_registered`,
`agent_stopped`, `agent_steered`, `agent_finish_nudge`.

#### `BUILTIN_TRACE_EVENT_TYPES`

Successful `run_ended` events retain optional `disposition: "final" | "checkpoint"` from the engine
detail. Missing disposition is ordinary final semantics. Unsuccessful reasons never advertise an
accepted checkpoint. This field survives the same durable projection used by live delivery and
restored kernel run details; checkpoint metadata remains separate in the final run response.
Production: `RunEndedDetail` and `BuiltinTraceEvent` in
[trace-kinds.ts](../../packages/capability/src/trace-kinds.ts) and
[trace-events.ts](../../packages/capability/src/trace-events.ts); `mapEntry` in
[trace-mapper.ts](../../packages/trace/src/trace-mapper.ts).
Test: [checkpoint-composition.test.ts](../../packages/kernel/tests/integration/checkpoint-composition.test.ts)
compares the live terminal event with the restored event after reopening the kernel and file store.

The mapped/persisted-side vocabulary — the runtime list `isBuiltinTraceEvent` tests against
(`packages/capability/src/trace-events.ts`, `BUILTIN_TRACE_EVENT_TYPES`). Every name here except
`init`/`terminate` and the four `agent_*`
supervision kinds (which map to `null`, never becoming a wire event) corresponds to a same-named
builtin kind above, so the two vocabularies differ only by those unmapped kinds:

`lead_iteration`, `delegation_created`, `subagent_iteration`, `tool_call`, `tool_call_started`,
`tool_output_delta`, `tool_input_delta`, `subagent_iteration_started`, `lead_iteration_started`,
`delegation_completed`, `delegation_failed`, `budget_check`, `compaction_started`, `compaction`, `compaction_skipped`,
`vision_analysis`, `cancellation`, `user_question`, `user_steering`, `soft_limit_check`,
`run_started`, `run_ended`, `delegation_started`, `model_call_error`, `guard_escalation`,
`convergence_warning`, `model_call_retry`, `elicitation_requested`, `model_reasoning`,
`model_stream_delta`, `mcp_degraded`.

Each becomes one flat member of the `BuiltinTraceEvent` union (`packages/capability/src/trace-events.ts`), whose exact
per-type field shape is what §4c's mapping table and §4o's span table describe branch-by-branch; it is
not re-enumerated field-by-field here to avoid a second, driftable copy of the same 31 shapes.

### 2b. `@clarvis/trace` — entrypoint `.` (`packages/trace/src/index.ts`)

| Symbol | Signature / value | File |
| --- | --- | --- |
| `createTrace` | `(startedAt?: number, onRecord?: (entry, durable: boolean) => void) => TraceHandle & { seal(): void }` | `packages/trace/src/in-memory-trace.ts` |
| `TraceHandle` | `TracePort` + `entries(): TraceEntry[]` + `trace: RecordingTrace` | `packages/trace/src/trace-handle.ts` |
| `generateExecutionId` | `() => \`exec_${randomUUID()}\`` | `packages/trace/src/execution-id.ts` |
| `mapEntry` | `(entry, wallStartedAt, projectors?) => TraceEvent \| null` | `packages/trace/src/trace-mapper.ts` |
| `mapTrace` | `(entries, wallStartedAt, projectors?) => Trace` | `packages/trace/src/trace-mapper.ts` |
| `buildRecord` | `(input: BuildRecordInput) => ExecutionRecord` | `packages/trace/src/record-builder.ts` |
| `capDetail` | `<K extends TraceKind>(kind, detail) => TraceDetailFor<K>` | `packages/trace/src/cap-detail.ts` |
| `truncate` / `truncateTail` | head-cap with marker / tail-cap without | `packages/trace/src/cap-detail.ts` |
| `deriveEventSpan` | `(event: TraceEvent) => EventSpan` | `packages/trace/src/event-span.ts` |
| `iterationSpanId` | `(agent, subagentInstanceId, iteration) => string` | `packages/trace/src/event-span.ts` |
| `createJsonTraceStore` | `(opts: JsonTraceStoreOptions) => JournalingTraceStore` | `packages/trace/src/json-trace-store.ts` |
| `resolveTraceStore` | `(opts?) => { store, path }` | `packages/trace/src/trace-store-factory.ts` |
| `createRunJournal` | `(opts: CreateRunJournalOptions) => RunJournal` | `packages/trace/src/journal.ts` |
| `parseJournalChunks` | `(chunks: AsyncIterable<string>, limits) => Promise<JournalParseResult>` | `packages/trace/src/journal-recovery.ts` |
| `repairUnsettledToolCalls` | `(events) => TraceEvent[]` | `packages/trace/src/journal-recovery.ts` |
| `journalToRecord` | `(parsed: JournalParseSuccess) => ExecutionRecord` | `packages/trace/src/journal-recovery.ts` |
| `writerStillRunning` | `(header) => boolean` | `packages/trace/src/journal-recovery.ts` |
| `UNCOMPLETED_TOOL_RESULT` | `(name: string) => string` | `packages/trace/src/journal-recovery.ts` |
| `TraceCleanup` | class with `start(intervalMs)`, `stop()`, `runOnce(): number` | `packages/trace/src/cleanup.ts` |
| `parseStoredJson` | `<T>(json, label, id) => T`, throws `PersistenceError` | `packages/trace/src/trace-store.ts` |
| `recordToSummary` | `(record) => StoredSummary` | `packages/trace/src/trace-store.ts` |
| `sortDescPaginate` | `(items, limit, offset) => T[]` | `packages/trace/src/trace-store.ts` |

Entrypoint `./testing` exports exactly one symbol, `createMemoryTraceStore()`
(`packages/trace/src/testing.ts`); the exports map has three keys: `.`, `./testing`,
`./package.json` (`packages/trace/package.json`).

`generateExecutionId`'s shape is pinned tighter than `exec_${randomUUID()}` suggests:
`packages/trace/tests/unit/execution-id.test.ts` asserts the id against
`/^exec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/` — a v4 UUID
specifically (version nibble `4`, variant nibble in `[89ab]`), not merely "a UUID" — asserts 64 calls in a row mint 64 distinct ids.

### 2c. The `TraceStore` port (`packages/trace/src/trace-store.ts`)

| Member | Signature | Required? | File |
| --- | --- | --- | --- |
| `insert` | `(record: ExecutionRecord) => Promise<void>` | yes | `packages/trace/src/trace-store.ts` |
| `getById` | `(owner, id) => StoredExecution \| null` | yes | `packages/trace/src/trace-store.ts` |
| `list` | `(owner, limit, offset) => ListResult` | yes | `packages/trace/src/trace-store.ts` |
| `deleteById` | `(owner, id) => boolean` | yes | `packages/trace/src/trace-store.ts` |
| `deleteOwner` | `(owner) => number` | yes | `packages/trace/src/trace-store.ts` |
| `listAcrossOwners` | `(limit, offset, filter?: { owner? }) => ListResult` | optional | `packages/trace/src/trace-store.ts` |
| `existsForOwner` | `(owner, id) => boolean` | yes | `packages/trace/src/trace-store.ts` |
| `cleanup` | `(cutoffMs, batch, counters?, protectedExecutionIds?) => number` | yes | `TraceStore.cleanup` |
| `openJournal` | `(opts: OpenJournalOptions) => RunJournal` | optional | `packages/trace/src/trace-store.ts` |
| `recoverOrphans` | `() => Promise<TraceRecoveryReport>` | optional | `packages/trace/src/trace-store.ts` |

`JournalingTraceStore = TraceStore & Required<Pick<TraceStore, "openJournal" | "recoverOrphans">>`. `insert` is the only async member; the comment states the reason: the
filesystem implementation "serialized, then written, `fsync`ed, renamed and `fsync`ed again. Doing
that synchronously stalled the event loop".

There is deliberately **no cross-owner `getById`** — : "there is deliberately no
cross-owner `getById`, because a trace holds the full conversation."

### 2d. Display caps (`packages/trace/src/cap-detail.ts`)

| Constant | Value | Applies to |
| --- | --- | --- |
| `TRUNCATED_SUFFIX` | `"...[truncated]"` | marker appended by `truncate` |
| `RESULT_MAX` | `5000` | tool result, steering, errors, reasoning, stream text, delegation result; also every string of a *contributed* detail |
| `MODEL_RESPONSE_MAX` | `2 * 1024 * 1024` | `lead_iteration.response`, `subagent_iteration.response` |
| `SUMMARY_MAX` | `500` | `user_question.question`, `convergence_warning.message`, `elicitation_requested.question`, `mcp_degraded.servers[].reason` |
| `DIFF_MAX` | `20000` | `tool_call.diff` |
| `LIVE_CHUNK_MAX` | `8192` | `tool_output_delta.chunk` (tail-kept) |
| `ARGS_MAX` | `10000` | per-leaf string inside `arguments` |
| `ARGS_TOTAL_MAX` | `64 * 1024` | aggregate string+key budget for one argument projection |
| `DETAIL_MAX_ENTRIES` | `4096` | structural width ceiling |
| `DETAIL_MAX_DEPTH` | `32` | structural depth ceiling |
| `DETAIL_TRUNCATED_KEY` | `"__clarvis_truncated__"` | marker key set on a truncated object |

`delegation_created.task` uses `DELEGATE_TASK_MAX_CHARS` (`32_768`,
`packages/capability/src/delegate-task.ts`), applied through `truncateUnicodeTotal`
(`packages/trace/src/cap-detail.ts`), which keeps prefix + marker inside one total ceiling (`packages/trace/src/cap-detail.ts`).

### 2e. Store bounds (`packages/trace/src/json-trace-store.ts`)

| Constant | Value | File |
| --- | --- | --- |
| `DEFAULT_MAX_TRACE_OWNER_INDEXES` | `32` | `packages/trace/src/json-trace-store.ts` |
| `DEFAULT_MAX_TRACE_OWNER_INDEX_ENTRIES` | `50_000` | `packages/trace/src/json-trace-store.ts` |
| `DEFAULT_MAX_TRACE_RECORD_BYTES` | `128 MiB` | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_RECORD_BYTES` | `256 MiB` (hard) | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_SUMMARY_BYTES` | `64 KiB` (hard **and** default) | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_LIST_LIMIT` | `200` | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_LIST_OFFSET` | `10_000` | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_RECOVERY_SCAN_ENTRIES` | `10_000` | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_RECOVERY_JOURNALS` | `100` | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_RECOVERY_TOTAL_BYTES` | `64 MiB` | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_RECOVERY_JOURNAL_BYTES` | `32 MiB` | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_RECOVERY_EVENTS` | `20_000` | `packages/trace/src/json-trace-store.ts` |
| `MAX_TRACE_CLEANUP_SCAN_ENTRIES` | `10_000` | `packages/trace/src/json-trace-store.ts` |
| `TMP_ORPHAN_GRACE_MS` (private) | `3_600_000` (1 h) | `packages/trace/src/json-trace-store.ts` |
| `DEFAULT_MAX_TRACE_CLEANUP_ENTRIES` | `10_000` | `packages/trace/src/cleanup.ts` |

`JsonTraceStoreOptions` takes `dir` plus overrides for each cache/byte bound, a `logger`,
and two named test seams: `beforeOwnerRemove` and `afterInsertWrite`.

There are **no `settings.json` keys and no CLI flags in this package** — its only configuration
surface is `JsonTraceStoreOptions`, `ResolveTraceStoreOptions` (`packages/trace/src/trace-store-factory.ts`) and
`TraceCleanupOptions` (`packages/trace/src/cleanup.ts`).

`TraceFileTooLargeError` (`packages/trace/src/json-trace-store.ts`) is the concrete, module-private class behind
every "oversized" row in the failure-modes table (§6): `class TraceFileTooLargeError extends
PersistenceError`, constructed as `(kind: "record" | "summary", path: string, size: number, limit:
number)` and attaching the structured detail `{ kind, path, actual_bytes: size, max_bytes: limit }` to
the `PersistenceError` it extends. It is not exported from `index.ts` — a caller sees only a
`PersistenceError` with that detail shape.

## 3. Data and formats

### 3a. `ExecutionRecord` — the unit a store inserts

`packages/capability/src/trace-events.ts`:

| Field | Type | Note |
| --- | --- | --- |
| `id` | `string` | `exec_<uuidv4>` when minted here (`packages/trace/src/execution-id.ts`) |
| `owner_key_name` | `string` | `packages/trace/src/record-builder.ts` |
| `status` | `ExecutionStatus` | one of six: `completed`, `budget_exhausted`, `error`, `cancelled`, `soft_limit_declined`, `interrupted` (`packages/capability/src/execution-status.ts`) |
| `started_at`, `ended_at`, `elapsed_ms` | `number` | absolute Unix ms; `ended_at = started_at + elapsed_ms` (`packages/trace/src/record-builder.ts`) |
| `request`, `response` | `RunRequest`, `RunResponse` | stored sanitized (`packages/trace/src/json-trace-store.ts`) |
| `trace` | `Trace` | stored **verbatim** (`packages/trace/src/json-trace-store.ts`) — its events were sanitized at map time |
| `total_input_tokens` … `total_cache_write_tokens` | `number` | summed from `response.usage.by_agent` (`packages/trace/src/record-builder.ts`) |
| `final_context?` | `ContextSnapshotEntry[]` | omitted when absent (`packages/trace/src/record-builder.ts`) |
| `capability_state?` | `Record<string, unknown>` | opaque to the engine (`packages/capability/src/trace-events.ts`) |
| `host_metadata?` | `Record<string, unknown>` | opaque host snapshot, sanitized before durable storage (`packages/capability/src/trace-events.ts`, `packages/trace/src/json-trace-store.ts`) |
| `recovery?` | `ExecutionRecovery` | present only on a damaged recovery (`packages/trace/src/journal-recovery.ts`) |

`ExecutionStatus` has six members, and `interrupted` is documented at
`packages/capability/src/execution-status.ts` as "never produced by a live run — only by
`@clarvis/trace`'s `TraceStore.recoverOrphans`".

### 3b. On-disk layout

Rooted at `resolve(opts.dir)` (`packages/trace/src/json-trace-store.ts`); `resolveTraceStore` defaults it to
`globalPaths().tracesDir` (`packages/trace/src/trace-store-factory.ts`).

```
<dir>/                                  mode 0700  (packages/trace/src/json-trace-store.ts)
  .locks/                               mode 0700
    <ownerSeg>.<idSeg>.lock                        per-id insert lease
    <ownerSeg>.delete-generation                   owner generation state
    <ownerSeg>.delete-lease                        owner deletion lease
    <ownerSeg>.<encoded recordName>.insert-generation
  <ownerSeg>/                           mode 0700
    .seq                                mode 0600  token file
    <started_at>.<idSeg>.json           mode 0600  the record
    <started_at>.<idSeg>.summary                   the listing sidecar
    <started_at>.<idSeg>.jsonl          mode 0600  the live/orphan journal
    <started_at>.<idSeg>.jsonl.corrupt             quarantined bad header (packages/trace/src/journal.ts)
    <started_at>.<idSeg>.jsonl.oversized           quarantined over a bound (packages/trace/src/journal.ts)
    .clarvis-tmp-*                                 in-flight atomic writes (paths' TMP_PREFIX)
```

`<ownerSeg>` and `<idSeg>` are both `ownerSegment(value)` from `@clarvis/paths`
(`packages/paths/src/roots.ts`): percent-encoding that also escapes `.`, falling
back to `h_<sha256hex>` past 200 encoded bytes. Round-tripped for `".."`, for an owner
with `/`, and for an over-long id by
`packages/trace/tests/integration/json-trace-store.test.ts`, which also pins the layout and modes.

Record filenames are matched by `FILE_RE = /^(\d+)\.(.+)\.json$/` (`packages/trace/src/json-trace-store.ts`). Two
naming decisions follow from that regex being greedy, and both are documented as structural rather
than guarded:

- The sidecar suffix is `.summary`, **not** `.summary.json` — otherwise it would parse as
  a record whose id segment is `<seg>.summary`. Pinned at
  `packages/trace/tests/integration/json-trace-store.test.ts` ("is not counted as an execution by
  list, the index, or deleteOwner").
- A journal is `.jsonl`, which `FILE_RE` (anchored on `.json$`) cannot match, so a
  journal never enters the owner index, `list` or `getById`. Pinned at
  `packages/trace/tests/integration/journal.test.ts`.

`.seq` is likewise excluded by `FILE_RE`.

### 3c. The `.jsonl` journal format

The first JSONL record is a `JournalHeader` (`packages/trace/src/journal.ts`):

```json
{"v":1,"id":"exec_…","owner_key_name":"alice","started_at":1700000000000,
 "request":{…sanitized…},"host_metadata":{…sanitized…},
 "writer":{"pid":4242,"host":"laptop"}}
```

`JOURNAL_VERSION = 1`. `request` passes through `sanitizeDeep`, which the doc
comment says makes a recovered record's request "byte-equivalent to the one a normal run
would have persisted"; pinned at `packages/trace/tests/integration/journal.test.ts`. `writer`
records pid+host so a peer can ask whether the writer is alive.
`host_metadata`, when supplied, passes through the same `sanitizeDeep` boundary and is recovered
without interpretation (`packages/trace/src/journal.ts`,
`packages/trace/src/journal-recovery.ts`). The file kernel uses it for extension
Extension Profile identity; that shape is owned by [`hosts/extension-profiles.md`](../hosts/extension-profiles.md).

Every subsequent line is one `JSON.stringify(event)` of a **mapped** `TraceEvent` — the same
object `mapEntry` produced, already rebased, capped and sanitized. A `null` mapping is skipped. Header + one line per appended event pinned at
`packages/trace/tests/integration/journal.test.ts`.

### 3d. Owner generation state (`.delete-generation`)

`OwnerGenerationState` (`packages/trace/src/json-trace-store.ts`) is `{ version: 1, state: "active" | "deleting",
generation: string }`, written durably. `readGenerationState` treats a missing file
as `{ active, generation: "" }` and an unparsable/older payload as `{ active, generation:
<raw> }`. A record belongs to a generation when `generation === ""` **or** its
`.insert-generation` sidecar holds that exact token.

### 3e. Result types

`StoredSummary` (`packages/trace/src/trace-store.ts`) is nine scalars: `id`, `owner`, `status`, `started_at`,
`elapsed_ms`, and the four token totals. `ListResult` is `{ items, total }`.
`TraceCleanupCounters` is `{ records, journals, leases, tmp }`, whose fields sum to the
returned total (pinned at
`packages/trace/tests/integration/observability.test.ts`). `TraceRecoveryReport` is
`{ recovered, examined, quarantined, degraded, exhausted }`; the comment
states why a bare count was insufficient — it "could not tell 'nothing to recover' from 'the budget
blew halfway through the scan'".

## 4. Behavior

### 4a. Recording: `createTrace`

`packages/trace/src/in-memory-trace.ts`. Per call:

1. If `sealed`, return.
2. Build `{ at: performance.now() - startedAt, kind, detail: capDetail(kind, detail) }`.
3. `record` pushes to `trace.entries` **and** calls `onRecord(entry, true)`.
   `signal` only calls `onRecord(entry, false)`.
4. `seal()` flips the flag; both become no-ops.

Both paths cap first. The `durable` boolean is the only thing distinguishing the two
at the sink, because the entries are structurally identical; both this distinction and seal
behaviour are pinned by `packages/trace/tests/unit/in-memory-trace.test.ts`.

The engine's sink is `traceBridge` (`packages/loop/src/runtime/run-trace.ts`): poke the clock,
feed the supervision registry with the *raw* entry, then map **once** and share the result between
the journal and the host's `onEvent`. `journal` is taken only when `durable` is true. All text,
reasoning, tool-output and tool-input progress stay off disk. The engine records one separate minimal
`tool_call_announced` per call and physical provider attempt, with actor, tool, iteration and attempt.
All counts and completion use `signal`; retry increments the attempt and clears the announcement
set. No argument content is needed for replay. Production: `announcedToolCalls` and `onToolInputDelta` in
`packages/loop/src/runtime/loop/loop.ts`. Test:
`packages/loop/tests/unit/stream-delta-attribution.test.ts`.

### 4b. Capping: `capDetail`

`packages/trace/src/cap-detail.ts`. Two branches:

- **Contributed kind** (`!isBuiltinTraceKind`): every reachable string is bounded at `RESULT_MAX`
  through `capStrings`. The doc states the consequence of omitting it: "the
  branch that carries a contributed detail through verbatim is precisely the one that skips every
  bound above it." Pinned at `packages/trace/tests/unit/cap-detail.test.ts`.
- **Builtin kind**: `capKinded` switches per kind; kinds with no free-text field fall
  through `default` and are returned untouched (pinned at `packages/trace/tests/unit/cap-detail.test.ts`).

Every branch is written to return the *same object* when nothing changed (…),
so `capDetail` allocates nothing on the common path (pinned at `packages/trace/tests/unit/cap-detail.test.ts`).
It never mutates (pinned at `packages/trace/tests/unit/cap-detail.test.ts`) — the comment states the reason: "A
tool call's `arguments` is the very object the model's conversation holds; capping it in place would
rewrite the run's input, not just its record."

`capStrings` walks with three budgets at once — `remainingChars` from `ARGS_TOTAL_MAX`,
`remainingEntries` from `DETAIL_MAX_ENTRIES`, depth against `DETAIL_MAX_DEPTH` — plus a `WeakSet`
cycle guard. When anything was dropped it sets `DETAIL_TRUNCATED_KEY` on the object
 or pushes a marker into the array. Depth/cycle pinned at `packages/trace/tests/unit/cap-detail.test.ts`,
aggregate width.

### 4c. Mapping: `mapEntry`

`packages/trace/src/trace-mapper.ts` → `mapEntryRaw` → `sanitizeDeep`. Order of
decisions inside `mapEntryRaw`:

| Step | Condition | Result |
| --- | --- | --- |
| 1 | a projector is registered for `entry.kind` | that projector's return, including an explicit `null` |
| 2 | `!isBuiltinTraceEntry(entry)` | `{ type: kind, occurred_at: abs(at), detail: capDetail(kind, detail) }` |
| 3 | `init`, `terminate`, `agent_registered`, `agent_stopped`, `agent_steered`, `agent_finish_nudge` | `null` |
| 4 | any other builtin kind | the flat projection for that kind |
| 5 | anything else | `const exhaustive: never = entry` |

The `isBuiltinTraceEntry` gate before the switch is what keeps step 5 a real exhaustiveness check
: with an open `TraceEntry`, "the contributed arm — whose `kind` is `string` — would match
every `case`". Projector precedence and the explicit-drop path pinned at
`packages/trace/tests/unit/persisted-projectors.test.ts`; the nested fallback.

Mechanics inside the builtin branches:

- `abs(offset) = wallStartedAt + Math.round(offset)`; rebasing pinned at
  `packages/trace/tests/unit/trace-mapper.test.ts`.
- `splitToolName` splits on the **first** `.`; a name with no dot yields `tool_name: ""`.
  Pinned at `packages/trace/tests/unit/trace-mapper.test.ts`.
- `asObject` coerces a non-object `arguments`. `undefined` → `{}`; anything else is
  stringified and preserved under `malformed_arguments`, tail-capped at `ARGS_MAX`. The
  comment states the failure this replaced: "the persisted trace asserted the model sent
  no arguments when it had sent a payload that was cut in transit." Pinned at
  `packages/trace/tests/unit/trace-mapper.test.ts`.
- Every builtin branch calls `capDetail` again (…). The comment
  calls it "a defence-in-depth pass for an entry that reached persistence without going through
  `createTrace`"; pinned by `packages/trace/tests/unit/trace-mapper.test.ts` ("bounds a legacy task that bypassed the
  recording handle").
- Optional fields are attached only when defined (throughout), so an absent value
  never becomes explicit `undefined`. Pinned across
  `packages/trace/tests/unit/trace-mapper-kinds.test.ts`.
- `tool_input_delta.stream_chars` is projected only when present, `complete` only when true, and
  `model_call_retry.message` is capped
  before mapping and retained on the persisted event. Production: `capKinded` and `mapEntryRaw`.
  Test: `packages/trace/tests/unit/trace-mapper-kinds.test.ts`.
- `budget_check.tokens_remaining` is attached only when `Number.isFinite`; pinned at
  `packages/trace/tests/unit/trace-mapper.test.ts`.
- `sanitizeDeep` is applied to the *whole event* after projection, including a projector's
  output — pinned at `packages/trace/tests/unit/persisted-projectors.test.ts` (an `api_key` field becomes `"[redacted]"`).

`mapTrace` is the same, per entry, dropping `null`s.

### 4d. `buildRecord`

`packages/trace/src/record-builder.ts`: sum `response.usage.by_agent` into four totals,
take `elapsed_ms` from `usage.elapsed_ms`, derive `ended_at = wallStartedAt + elapsed_ms`, include `final_context`/`capability_state`/`host_metadata` only when supplied.
Pinned at `packages/trace/tests/unit/record-builder.test.ts`.

The response also retains accepted checkpoint disposition and bounded handoff metadata, independently
of its status. A stage checkpoint has no validated final result value; persistence and reopening
must preserve that distinction. Journal recovery still produces an interrupted outcome, never an
invented checkpoint acceptance. Production: `buildRecord` in
[record-builder.ts](../../packages/trace/src/record-builder.ts), response serialization in
[json-trace-store.ts](../../packages/trace/src/json-trace-store.ts), and `journalToRecord` in
[journal-recovery.ts](../../packages/trace/src/journal-recovery.ts).
Test: the real kernel/SDK/plan/trace reopen journey in
[checkpoint-composition.test.ts](../../packages/kernel/tests/integration/checkpoint-composition.test.ts)
and the interrupted-record matrix in
[journal-recovery.test.ts](../../packages/trace/tests/unit/journal-recovery.test.ts).

### 4e. `insert` on the JSON store

`packages/trace/src/json-trace-store.ts`. A `phase` variable tracks progress and appears in the
failure log; the three phases are `generation | lease | write`.

1. `ensureLocksDir()`.
2. `ensureActiveGeneration(owner, ownerSeg)` — see §4f.
3. `phase = "lease"`; `ensureOwnerDir`, then a **pre-lease** `findEntry` conflict
   check.
4. `acquireLocalLease(lockPath, { staleMs: TMP_ORPHAN_GRACE_MS, waitMs: 0 })`; `null` →
   `executionIdConflict`. Non-waiting, so a concurrent inserter reads as a conflict. The same
   integration suite pins that a *stale* orphan lock with no data file is reclaimed inline rather
   than becoming a permanent conflict (`staleMs` = 1 h):
   `packages/trace/tests/integration/json-trace-store.test.ts`.
5. `lease.assertOwned()`, then the conflict check **again** under the lease.
6. `phase = "write"`; `insertLocked`: build the stored projection
   with `sanitizeDeep(request)` and `sanitizeDeep(response)` but `trace` verbatim, reject
   if the serialized UTF-8 exceeds `maxRecordBytes`, `writeFileDurable`, then
   `writeSummarySidecar`.
7. `afterInsertWrite` seam, then `isActiveGeneration` check → `abortDeletedInsert`.
8. If `generation !== ""`, durably write the `.insert-generation` sidecar, then check
   the generation **again**.
9. Update the in-memory index (or mark it incomplete past `maxOwnerIndexEntries`) and
   `bumpSeq`.
10. `finally` → `lease.release()`. Lock removal after insert pinned at
    `packages/trace/tests/integration/json-trace-store.test.ts`.

`abortDeletedInsert` unlinks the record, its sidecar and its generation sidecar, logs
`trace.insert_aborted_deleted_owner`, and throws `PersistenceError`.

### 4f. Owner deletion as a two-phase generation swap

`deleteOwner` is synchronous — unlike `insert`, whose async signature exists precisely
because the filesystem work behind it (serialize, write, `fsync`, rename, `fsync` again) is too
costly for a sync call (§2c). `deleteOwner`'s own doc comment states why it stays sync anyway:
"Filesystem stores keep this API synchronous by using a non-waiting owner-wide lease; a concurrent
deletion may therefore raise a persistence error for the caller to retry"
(`packages/trace/src/trace-store.ts`).

| Step | Action |
| --- | --- |
| 1 | `acquireLocalLeaseSync(delete-lease, { staleMs: 0 })`; `null` → `PersistenceError("deletion is in progress")` |
| 2 | read `previous` state, mint `nextGeneration = randomUUID()` |
| 3 | publish `{ state: "deleting", generation: next }` |
| 4 | count records belonging to `previous.generation` (only if `previous` was active) |
| 5 | `beforeOwnerRemove` seam, `rmSync(dir, recursive, force)` |
| 6 | drop the cached index, `purgeOwnerMachinery` (reclaim `.lock`s, unlink `.insert-generation`s under the owner prefix) |
| 7 | publish `{ state: "active", generation: next }` |
| 8 | `finally` → release the lease |

`ensureActiveGeneration` is the recovery half. If the state is `deleting`, it takes the same
non-waiting lease; failing to take it means a live deleter, so `PersistenceError`. Taking it
is, per the comment, "proof that this caller may finish that transaction": it re-reads,
purges the directory and machinery, and publishes `active` with the *same* generation.

`replaceFinalContext` is the explicit mutation path for a settled continuation. It first completes
or refuses any prior deletion generation, then holds the owner-wide deletion lease and the record
lease while atomically replacing `final_context`, updating optional compaction usage totals, and
refreshing the summary sidecar. It therefore cannot republish a record across `deleteOwner`.
Production: `replaceFinalContext` in `packages/trace/src/json-trace-store.ts`. Test:
`packages/trace/tests/integration/json-trace-store.test.ts` (`"atomically replaces final_context and
charges compaction usage"`).

`deleteById` takes those leases in the same owner-then-record order, so a settled-context rewrite
and a record deletion cannot pass one another and recreate the deleted file.

The state machine, by (state, event):

| State | Event | Next state | Effect |
| --- | --- | --- | --- |
| `active(g)` | `insert` | `active(g)` | record written + `.insert-generation` = `g` (skipped when `g === ""`) |
| `active(g)` | `deleteOwner` | `deleting(g')` → `active(g')` | directory removed, machinery purged, count returned |
| `deleting(g')` | `insert`, deleter alive | `deleting(g')` | lease unavailable → `PersistenceError` |
| `deleting(g')` | `insert`, deleter dead | `active(g')` | caller finishes the purge, then proceeds |
| `deleting(g')` | `list` / `listOwner` | unchanged | `{ items: [], total: 0 }` |
| `deleting(g')` | `ownerIndex` | unchanged | empty index |
| `deleting(g')` | `recoverOrphans` | unchanged | owner skipped |

Pinned at `packages/trace/tests/integration/json-trace-store.test.ts`.
Lock-prefix disambiguation (an owner segment that is a prefix of another) pinned, and rests
on `ownerSegment` escaping `.` (`packages/paths/src/roots.ts`).

The case is a materially stronger guarantee than the rest: `"rejects a cross-process insert
while the new generation is still being deleted"` spawns a **real, separate OS process** via
`Bun.spawn` (using the helper `packages/trace/tests/helpers/owner-delete-insert-worker.ts`, which
opens its own `createJsonTraceStore` over the same directory and attempts an insert while this
process's `deleteOwner` is mid-flight) and asserts that process's insert is rejected with
`code: "persistence_failure"`. It proves the generation-swap protocol holds across process
boundaries, not merely within one process's in-memory lease map.

### 4g. Owner index and `.seq`

`ownerIndex` keys a cache entry on `(seq, "state:generation")`. `readSeq`
 reads a small named file; `bumpSeq` writes a fresh `randomUUID()`. The comment states the measurement behind not using `mtime`: "a rapid insert-then-delete (or any two
mutations close enough in time) collides on the identical reported `mtimeMs` far too often to trust".
Cross-instance freshness pinned at `packages/trace/tests/integration/json-trace-store.test.ts`
(sees another instance's insert) (stops seeing another instance's delete).

`findEntry` answers from the index; on a miss it falls back to a directory scan **only** when
the index is incomplete. Past `maxOwnerIndexEntries` the index is marked `complete = false`
 and lookups degrade to the scan; pinned at `packages/trace/tests/integration/json-trace-store.test.ts`.
The LRU is bounded by `maxOwnerIndexes` (`cacheOwnerIndex`).

`cleanup` deletes files directly, never through `deleteById`, so it does not bump `.seq`; instead it
clears **every** cached index when it deleted anything. The comment gives the
mechanism: `readdirSync(rootDir)` yields encoded segments that are "not cheaply invertible for a
hashed segment", so a targeted invalidation could mis-target.

### 4h. `list` / `listAcrossOwners`

`listOwner` : normalize the page, refuse if the generation is not active,
then stream the directory keeping only the newest `limit + offset` rows in a worst-first heap
(`retainNewest`) while counting `total` over **every** matching entry. Then
`sortDescPaginate` and, per row, read the sidecar first and fall back to the bounded full record. The fallback is described as mandatory because "records written before
sidecars existed have none". `listAcrossOwners` delegates to `listOwner` when a `filter.owner`
is given, otherwise walks every owner directory skipping `.locks`.

`sortDescPaginate` (`packages/trace/src/trace-store.ts`) sorts by `started_at` descending with a descending-`id`
tiebreak; pinned at `packages/trace/tests/integration/json-trace-store.test.ts`.

`normalizeTracePage` **throws** `PersistenceError` for a non-safe-integer, negative, or
over-cap limit/offset; pinned at `packages/trace/tests/integration/json-trace-store.test.ts`.

### 4i. Journal lifecycle

`store.openJournal` owns the path, registers the run in an in-process `liveJournals`
set keyed `<ownerSeg>/<idSeg>`, wraps `createRunJournal`, and releases the key on
`discard()`/`close()` exactly once.

`createRunJournal` (`packages/trace/src/journal.ts`) opens with `openSync(path, "ax", 0o600)` — exclusive;
the comment says an `EEXIST` here "is a bug detector rather than a race guard" because
the store already reserved the id. Refusal to reopen pinned at
`packages/trace/tests/integration/journal.test.ts`; the `0600` mode.

Lines are `writeSync` and **deliberately not `fsync`ed** : "The failure this guards
against is *process* death … data handed to `write(2)` survives all three, because it sits in the
kernel's page cache."

Every method is infallible by contract. `die()` closes the fd, marks the journal
dead, and logs **once**; subsequent calls no-op. Pinned at
`packages/trace/tests/integration/journal.test.ts` (unopenable path) (append after close is
silent) (mid-run append failure disables and stays quiet).

`discard()` closes and unlinks, swallowing errors. `close()` closes without
unlinking. The loop calls `discard()` immediately after a successful `insert`
(`packages/loop/src/runtime/execute-run.ts`) and `close()` in a `finally`
(`packages/loop/src/runtime/execute-run.ts`).

### 4j. Journal parsing

`createJournalLineParser` (`packages/trace/src/journal-recovery.ts`) drives the package's one
journal parser, `parseJournalChunks`, which is streaming and always bounded — there is no
whole-text, unbounded variant beside it. The three limits are `JournalParseLimits`'s fields —
`maxChars`, `maxLineChars`, `maxEvents` (`packages/trace/src/journal-recovery.ts`) — and
`recoverOrphans`'s call site does not tune them independently:
`maxChars` and `maxLineChars` are **both** bound to the same constant,
`MAX_TRACE_RECOVERY_JOURNAL_BYTES`, while only `maxEvents` gets its own,
`MAX_TRACE_RECOVERY_EVENTS` (`packages/trace/src/json-trace-store.ts`). Per line :

| Input | Outcome |
| --- | --- |
| blank/whitespace | ignored |
| first non-blank line, header parses | becomes the header |
| first non-blank line, header fails | terminal `{ ok:false, reason:"bad_header" }` |
| unparseable JSON, **trailing** | dropped silently |
| unparseable JSON, interior | `skipped += 1` |
| parses but not an object with a string `type` | `skipped += 1` |
| `events.length >= maxEvents` | terminal `{ ok:false, reason:"limit", limit:"events" }` |
| otherwise | pushed verbatim, unknown `type` included |
| no header at `finish()` | `{ ok:false, reason:"empty" }` |

`parseHeader` requires an object with numeric `v <= JOURNAL_VERSION`, non-empty string
`id` and `owner_key_name`, finite numeric `started_at`, and `request` **present and an object**. The comment states the rule: "Recovery must not reject a journal because a
request shape changed under it, but every consumer reads `record.request.*`, so an absent one would be
a dereference waiting to happen." `writer` is admitted only when both fields have the right primitive
types.

Pinned at `packages/trace/tests/unit/journal-recovery.test.ts` (empty/bad header) (newer
version refused) (trailing partial not counted as damage) (unknown event type kept) (chunked, not line-aligned) (all three bounds).

`parseJournalChunks` accumulates parts and joins once per line, which the comment says keeps memory "O(largest bounded line + bounded events)".

### 4k. `journalToRecord`

`packages/trace/src/journal-recovery.ts`:

1. `repairUnsettledToolCalls(parsed.events)` — pair `tool_call_started` against `tool_call`
   by `call_id`, and append a synthetic terminal `tool_call` for every unsettled one, with
   `ended_at = started_at`, `result` and `error` both set to `UNCOMPLETED_TOOL_RESULT(name)`. A contributed event is skipped outright. The comment states the
   reason: "a `tool_use` with no `tool_result` is a conversation shape providers reject."
2. `synthesized = events.length - parsed.events.length`.
3. `sumUsage` rolls lead iterations per model and subagent iterations per model, counting
   distinct `subagent_instance_id`s per model, and attributes the whole
   `subagents_spawned` count to the *first* lead row only — the comment says assigning it
   to every row "would multiply it by the number of lead models a run happened to use".
4. `lastAt` is the max over the first present of `ended_at | occurred_at | started_at | spawned_at`; `elapsed_ms = max(0, lastAt - started_at)`.
5. Status is `interrupted` on both the response and the record.
6. `recovery` is attached **only** when `skipped > 0 || synthesized > 0`.
7. **No `final_context`** is emitted. The comment : "`continue_from` against a recovered
   run still fails. Recovery restores the audit trail and the accounting; it does not restore
   resumability."

Pinned at `packages/trace/tests/unit/journal-recovery.test.ts`.

### 4l. `recoverOrphans`

`packages/trace/src/json-trace-store.ts`. `staleCutoff = Date.now() - TMP_ORPHAN_GRACE_MS`. A `scanBudget` of `maxRecoveryScanEntries` is threaded through both `readDirEntries` loops.

Per owner directory (skipping `.locks` and any `deleting` owner), it first
enumerates journals and current-generation record segments, then per candidate journal:

| Guard | Action |
| --- | --- |
| a record with the same id segment exists | skip |
| the journal is in this process's `liveJournals` | skip |
| `stat` fails | skip |
| `mtimeMs >= staleCutoff` (younger than the 1 h grace) | skip |
| `size > MAX_TRACE_RECOVERY_JOURNAL_BYTES` | quarantine `.jsonl.oversized`, **without reading** |
| `admittedBytes + size > MAX_TRACE_RECOVERY_TOTAL_BYTES` | `exhaust("total_bytes")`, break |
| stream read throws | skip |
| parsed **and** `writerStillRunning(header)` | skip |
| parse failed, `reason === "limit"` | quarantine `.jsonl.oversized` |
| parse failed otherwise | quarantine `.jsonl.corrupt` |
| otherwise | `journalToRecord` → `store.insert`; on throw, skip |
| the inserted record carries `recovery` | `degraded += 1`, log `trace.journal_recovery_degraded` |
| success | `unlinkQuietly(path)` |

The `examined` counter is incremented before the size checks, and `MAX_TRACE_RECOVERY_JOURNALS`
bounds it from both loops. When `scanBudget` runs out mid-owner the owner
is left entirely untouched — the inline comment says why: "The directory may have an
unseen record matching a discovered journal … rather than making insertion's conflict check perform an
unbounded fallback scan."

Quarantine renames rather than deletes, and reports whether the rename itself succeeded. `JOURNAL_CORRUPT_SUFFIX`'s doc (`packages/trace/src/journal.ts`) states the rule: "a trace
holds an entire conversation, so an unreadable journal is quarantined rather than deleted — tidying a
directory is not a reason to destroy the only surviving copy of a run."

`writerStillRunning` (`packages/trace/src/journal-recovery.ts`) returns `false` for a missing writer or a different
host, `false` for *our own pid* (because "a journal this process still holds open is
already excluded by the store's live set"), and otherwise `kill(pid, 0)` with `EPERM` counted as alive. Pinned at `packages/trace/tests/integration/journal.test.ts` (live sibling skipped) (dead writer recovered).

Every pass ends by logging `trace.recovery_completed` with the report; pinned at
`packages/trace/tests/integration/observability.test.ts`.

### 4m. `cleanup`

`packages/trace/src/json-trace-store.ts`. Two cutoffs, deliberately different:

- `cutoffMs` — the caller's retention cutoff, applied to record `started_at` and to journal
  `started_at`.
- `tmpOrphanCutoff = Date.now() - TMP_ORPHAN_GRACE_MS`, applied to `.lock` mtime
  and tmp-file mtime.

`cleanupEntries` is a generator that yields **one value per examined entry**, `null` when the
entry is not expired. The comment says this is
load-bearing: the caller can
stop after a fixed number of examined entries, and the generator "resumes at the same cursor on the
next cleanup interval instead of rescanning an unbounded history synchronously from the beginning".
The cursor is held in the store-scope `cleanupScan`; pinned at
`packages/trace/tests/integration/json-trace-store.test.ts`.

Expired candidates are retained in a newest-first heap bounded by `cleanupBatch`, then
sorted oldest-first before deletion — so a bounded batch removes the oldest first; pinned by
the conformance case at `packages/trace/tests/contract/trace-store-conformance.ts` and by
`packages/trace/tests/integration/json-trace-store.test.ts`. A `leases` candidate goes through `reclaimLocalLeaseSync` with
`staleMs: TMP_ORPHAN_GRACE_MS`, so a lock whose owner process is live is never reclaimed. The same
test pins that a record's sidecar and generation sidecar are unlinked alongside it and do **not**
count against the batch: `packages/trace/tests/integration/json-trace-store.test.ts`.

`normalizeCleanupBatch` clamps to `[1, 10_000]` and maps non-finite to `10_000`.

**Journals age on the retention cutoff, not the orphan grace**. `TraceStore.cleanup`'s doc states the consequence of the alternative: sweeping on the grace "would delete precisely the
set `recoverOrphans` exists to read — leaving the crash record silently unrecoverable for any operator
who configured a TTL." That test carries an explicit `REGRESSION:` marker at
`packages/trace/tests/integration/journal.test.ts` pins this behavior.

### 4n. `TraceCleanup`

`packages/trace/src/cleanup.ts`. `start(intervalMs)` no-ops when `ttlDays === 0` or already running, runs one sweep immediately, then `setInterval` at `max(1, intervalMs)`, and
`unref`s the handle. `runOnce` computes `cutoffMs = Date.now() - ttlDays * 86_400_000`, clamps `batchSize` and `maxEntriesPerRun` into `[1, 10_000]`, and loops at most
`ceil(maxEntries / batch)` passes, stopping early on a short batch. Hitting the pass cap
logs a warning naming the backlog; a non-empty sweep logs an info line with the counter
split; a throw is caught, logged, and the count so far returned.

Pinned at `packages/trace/tests/component/cleanup.test.ts`.

`protectedExecutionIds`, when supplied, is resolved once per `runOnce` as `{ ids, complete }`. An
incomplete reference scan skips the whole destructive pass and warns; otherwise the ids are passed
unchanged to each bounded store batch. The JSON store encodes each raw protected id with
`ownerSegment` before comparing filename segments, while the in-memory store compares raw ids. The
file kernel supplies execution ids referenced by valid persisted sessions across every owner;
malformed or oversized individual session records are ignored, while the 10,000-file/256-MiB
aggregate bounds and filesystem failures return `complete: false`.
The product default is 30 days (`CLARVIS_TRACE_TTL_DAYS` in
`packages/capability/src/env.ts`); `0` remains a complete opt-out. Production:
`TraceCleanup.runOnce`, `JsonTraceStore.cleanup`, `referencedSessionExecutionIds` in
`packages/kernel/src/sessions/session-service.ts`, and the `TraceCleanup` composition in
`packages/kernel/src/file-kernel.ts`. Test: the protected-record case in
`packages/trace/tests/component/cleanup.test.ts` (including incomplete-scan refusal), the cleanup cases in
`packages/trace/tests/integration/json-trace-store.test.ts`, and the cross-owner scan case in
`packages/kernel/tests/integration/session-service.test.ts`.

### 4o. `deriveEventSpan`

`packages/trace/src/event-span.ts`. Narrows with `isBuiltinTraceEvent` first — a contributed
event gets `{ span_id: "run", phase: "point", kind: "event" }`. Then:

| Event type(s) | span_id | phase | kind |
| --- | --- | --- | --- |
| `run_started` / `run_ended` | `"run"` | start / end | `run` |
| `lead_iteration_started` / `lead_iteration` | `lead:<n>` | start / end | `iteration` |
| `subagent_iteration_started` / `subagent_iteration` | `<instanceId>:<n>` | start / end | `iteration` |
| `delegation_created` / `_started` / `_completed` / `_failed` | `delegation:<id>` | start / point / end / end | `subagent` |
| `tool_call_started` | `call_id` | start | `tool` |
| `tool_output_delta` / `tool_input_delta` | `call_id` | point | `tool` |
| `tool_call` | `call_id ?? "<agent>:<iteration_ref>:tool"` | end | `tool` |
| `model_reasoning` / `model_stream_delta` / `model_call_error` / `model_call_retry` | iteration span | point | `iteration` |
| `user_question` / `user_steering` | iteration span from `iteration_ref` | point | `iteration` |
| `compaction` / `compaction_skipped` / `cancellation` / `convergence_warning` / `guard_escalation` | `subagent:<id>` when scoped, else `"run"` | point | `subagent` / `event` |
| `elicitation_requested` / `budget_check` / `soft_limit_check` / `mcp_degraded` / `vision_analysis` | `"run"` | point | `event` |

`iterationSpanId` yields `<instanceId>:<n>` only when `agent === "subagent"` **and** the
instance id is defined; everything else, including a subagent with no instance id, is `lead:<n>`. Pinned at `packages/trace/tests/unit/event-span.test.ts`, and the whole table.

## 5. Invariants

Each rule names its production evidence and the test that pins it.

**T-1 (INV-023).** A record insert is scoped by `(owner, id)`: the same execution id under two
different owners is legal, a duplicate under the same owner is rejected with `ConflictError`.
Production: `packages/trace/src/json-trace-store.ts` (the two `findEntry` conflict
checks, before and under the lease) → `executionIdConflict`
(`packages/capability/src/errors.ts`, whose `code` is `"execution_id_conflict"` at
`packages/capability/src/errors.ts`); memory double at `packages/trace/src/testing.ts`.
Pinned: `packages/trace/tests/contract/trace-store-conformance.ts`, driven for both
backends from `packages/trace/tests/contract/trace-store.test.ts`.

**T-2 (INV-024).** Listing is owner-scoped, and an owner that never stored anything yields an empty
result rather than an error. Production: `packages/trace/src/json-trace-store.ts` (`listOwner`
reads only `ownerDir(owner)`), and `readDirEntries` returns on `ENOENT`/`ENOTDIR`
(`packages/trace/src/json-trace-store.ts`). Pinned:
`packages/trace/tests/contract/trace-store-conformance.ts`.

**T-3 (INV-025).** An owner's records list newest-first, and `limit`/`offset` paging leaves `total`
page-independent. Production: `packages/trace/src/trace-store.ts` (`sortDescPaginate`), and
`total` is incremented over every matching entry before paging
(`packages/trace/src/json-trace-store.ts`). Pinned:
`packages/trace/tests/contract/trace-store-conformance.ts`.

**T-4 (INV-026).** A listing's rows never include `request`, `response` or `trace`. Production:
`recordToSummary` projects exactly nine scalars (`packages/trace/src/trace-store.ts`), and
the sidecar holds only that projection (`packages/trace/src/json-trace-store.ts`). Pinned:
`packages/trace/tests/contract/trace-store-conformance.ts`.

**T-5 (INV-027).** `deleteById` affects only the requesting owner's copy and reports whether a record
existed. Production: `packages/trace/src/json-trace-store.ts` (`findEntry(owner, id)` first,
`false` when absent). Pinned: `packages/trace/tests/contract/trace-store-conformance.ts`.

**T-6 (INV-028).** A cleanup pass keyed on an age cutoff removes only records older than the cutoff,
across every owner, and a bounded batch removes the oldest first. Production:
`packages/trace/src/json-trace-store.ts` (`meta.startedAt < cutoffMs`) (`expired.sort`
ascending before deletion). Pinned:
`packages/trace/tests/contract/trace-store-conformance.ts`.

**T-7 (INV-029).** `deleteOwner` reports the count removed and leaves other owners untouched; an owner
with nothing stored reports zero. Production: `packages/trace/src/json-trace-store.ts`
(counts only entries of the previous generation in this owner's directory) (removes only
`ownerDir(owner)`). Pinned: `packages/trace/tests/contract/trace-store-conformance.ts`.

**T-7a.** `listAcrossOwners` lists across every owner newest-first and, given an exact `owner` filter,
returns only that owner's rows. Production: `packages/trace/src/json-trace-store.ts`
(delegates to `listOwner` when `filter.owner` is given) and `packages/trace/src/trace-store.ts` (`sortDescPaginate`,
shared with the single-owner path). Pinned:
`packages/trace/tests/contract/trace-store-conformance.ts`.

**T-8.** `BUILTIN_TRACE_KINDS` and `TraceDetailMap`'s keys are the same set, checked at compile time in
both directions. Production: `packages/capability/src/trace-kinds.ts`. Pinned: the assignments
themselves are the check (they fail `tsc`); the runtime half — no duplicates, every listed kind
recognised — is at `packages/capability/tests/unit/trace-kinds.test.ts`.

**T-9.** `BUILTIN_TRACE_EVENT_TYPES` and `BuiltinTraceEvent["type"]` are the same set, checked at
compile time in both directions. Production: `packages/capability/src/trace-events.ts`.
Pinned (runtime half): `packages/capability/tests/unit/open-vocabularies.test.ts`.

**T-10.** Narrowing with `isBuiltinTraceEntry` before a `switch` is what keeps an exhaustiveness check
honest over the open `TraceEntry`. Production: `packages/trace/src/trace-mapper.ts` guarding the
`never`. Pinned: `packages/capability/tests/unit/trace-kinds.test.ts` ("keeps an
exhaustive switch honest: narrow first, and the residual is never").

**T-11.** A projector may not be registered for an engine-owned kind, may not have an empty kind, and
may not be registered twice; the registry and its snapshot are frozen. Production:
`packages/capability/src/trace-projectors.ts`. Pinned:
`packages/capability/tests/unit/trace-projectors.test.ts`.

**T-12.** `composePersistedTraceProjectors` does not mutate the host registry. Production:
`packages/capability/src/trace-projectors.ts` (spreads into a fresh registry). Pinned:
`packages/capability/tests/unit/trace-projectors.test.ts`.

**T-13.** Six builtin kinds have no wire projection and map to `null`: `init`, `terminate`,
`agent_registered`, `agent_stopped`, `agent_steered`, `agent_finish_nudge`. Production:
`packages/trace/src/trace-mapper.ts`. Pinned **partially**:
`packages/trace/tests/unit/trace-mapper-kinds.test.ts` covers only the first five —
`agent_finish_nudge` is **unpinned**.

**T-14.** An entry whose kind no projector claims and the engine does not declare is persisted as a
`ContributedTraceEvent` with the payload nested under `detail`, never dropped. Production:
`packages/trace/src/trace-mapper.ts`. Pinned:
`packages/trace/tests/unit/persisted-projectors.test.ts`,
`packages/trace/tests/unit/trace-mapper.test.ts`.

**T-15.** Every mapped event, including a capability projector's output, passes through `sanitizeDeep`.
Production: `packages/trace/src/trace-mapper.ts`. Pinned:
`packages/trace/tests/unit/persisted-projectors.test.ts` (an `api_key` becomes `"[redacted]"`), and
`packages/trace/tests/unit/trace-mapper.test.ts` (a bearer token in tool arguments is not
persisted).

**T-16.** `capDetail` never mutates its input and returns the input by reference when nothing was
capped. Production: `packages/trace/src/cap-detail.ts` (…and every other
branch). Pinned: `packages/trace/tests/unit/cap-detail.test.ts`.

**T-17.** `capDetail` is the only cap table; the mapper calls it rather than restating a bound.
Production: `packages/trace/src/cap-detail.ts` (the stated rule) and
`packages/trace/src/trace-mapper.ts` etc. (every branch calls it). Pinned indirectly:
`packages/trace/tests/unit/trace-mapper.test.ts` shows the mapper capping an over-long
`delegation_created.task` that never went through `createTrace`. The "only cap table" property itself
is **unpinned** — no test fails if a second cap is introduced in the mapper.

**T-18.** A contributed detail is string-capped at `RESULT_MAX` with depth, width and cycle bounds.
Production: `packages/trace/src/cap-detail.ts`. Pinned:
`packages/trace/tests/unit/cap-detail.test.ts`.

**T-19.** A final model response is capped at `MODEL_RESPONSE_MAX`, not `RESULT_MAX`. Production:
`packages/trace/src/cap-detail.ts`. Pinned:
`packages/trace/tests/unit/cap-detail.test.ts`,
`packages/trace/tests/unit/in-memory-trace.test.ts`,
`packages/trace/tests/unit/trace-mapper.test.ts`.

**T-20.** `signal` entries never reach `trace.entries` and never reach the journal; only `record`
entries do. Production: `packages/trace/src/in-memory-trace.ts` (no push) and
`packages/loop/src/runtime/run-trace.ts` (`const journal = durable ? p.journal : undefined`).
Pinned: `packages/trace/tests/unit/in-memory-trace.test.ts`.

**T-21.** After `seal()`, both `record` and `signal` are no-ops. Production:
`packages/trace/src/in-memory-trace.ts`. Pinned:
`packages/trace/tests/unit/in-memory-trace.test.ts`.

**T-22.** Non-object tool `arguments` is preserved under `malformed_arguments`, never erased to `{}`;
only a genuinely absent payload becomes `{}`. Production: `packages/trace/src/trace-mapper.ts`.
Pinned: `packages/trace/tests/unit/trace-mapper.test.ts`.

**T-23.** The journal is opened exclusively (`"ax"`) at mode `0600` and never reopened. Production:
`packages/trace/src/journal.ts`. Pinned:
`packages/trace/tests/integration/journal.test.ts`.

**T-24.** No journal method ever throws; a failure disables the journal and is logged exactly once.
Production: `packages/trace/src/journal.ts`. Pinned:
`packages/trace/tests/integration/journal.test.ts`.

**T-25.** A journal never enters the record namespace — not `list`, not `getById`, not the owner index,
not `deleteOwner`'s count. Production: `FILE_RE` is anchored on `.json$`
(`packages/trace/src/json-trace-store.ts`), so `.jsonl` cannot match. Pinned:
`packages/trace/tests/integration/journal.test.ts`.

**T-26.** The summary sidecar likewise never enters the record namespace, because its name does not end
in `.json`. Production: `packages/trace/src/json-trace-store.ts`. Pinned:
`packages/trace/tests/integration/json-trace-store.test.ts`.

**T-27.** The sidecar is written **after** the record's rename, is not `fsync`ed, and every write
failure is swallowed. Production: `packages/trace/src/json-trace-store.ts` (order) (swallow + debug log). Pinned:
`packages/trace/tests/integration/observability.test.ts`; the read-side fallback at
`packages/trace/tests/integration/json-trace-store.test.ts`.

**T-28.** `list` must be able to serve a row from the full record when no sidecar exists. Production:
`packages/trace/src/json-trace-store.ts`. Pinned:
`packages/trace/tests/integration/json-trace-store.test.ts` (identical summary either way) (still lists with the sidecar removed).

**T-29.** `cleanup` ages journals on the retention cutoff, never on the orphan grace. Production:
`packages/trace/src/json-trace-store.ts`. Pinned:
`packages/trace/tests/integration/journal.test.ts` (carries an explicit `REGRESSION:` note).

**T-30.** `recoverOrphans` skips a journal this process holds open, one younger than the orphan grace,
one whose record already exists, and one whose writer process is provably alive on this host.
Production: `packages/trace/src/json-trace-store.ts`;
`writerStillRunning` at `packages/trace/src/journal-recovery.ts`. Pinned:
`packages/trace/tests/integration/journal.test.ts`.

**T-31 (INV-276).** An unrecoverable journal is renamed aside, never deleted — `.jsonl.corrupt` for a
body that would not parse, `.jsonl.oversized` when a size or parse *limit* stopped it — and the host
boots normally on top of it. Production:
`packages/trace/src/json-trace-store.ts` (`renameSync`, no `unlink` on the failure path), the two
suffixes at `packages/trace/src/journal.ts`, and the arms that choose between them at
`packages/trace/src/json-trace-store.ts`. Pinned:
`packages/trace/tests/integration/journal.test.ts` (corrupt header) (oversized),
`packages/trace/tests/integration/observability.test.ts` (failed rename reported); and
end-to-end through a real host boot at `packages/kernel/tests/integration/file-kernel.test.ts`,
which asserts the `.jsonl` is gone, the `.jsonl.corrupt` sidecar exists, and the kernel still
serves.

**T-32.** A recovered record carries `status: "interrupted"` and **no `final_context`**. Production:
`packages/trace/src/journal-recovery.ts`, and the absence of a `final_context` key in the
returned object. Pinned:
`packages/trace/tests/unit/journal-recovery.test.ts`.

**T-33.** `recovery` is attached only when something was lost or synthesized, so an undamaged recovered
record is indistinguishable from a normally persisted one. Production:
`packages/trace/src/journal-recovery.ts`. Pinned:
`packages/trace/tests/unit/journal-recovery.test.ts`;
`packages/trace/tests/integration/journal.test.ts`;
`packages/trace/tests/integration/observability.test.ts` ("stays quiet about a journal that
recovered intact").

**T-34.** A journal event whose `type` this build does not recognise is retained verbatim. Production:
`packages/trace/src/journal-recovery.ts` (only `type: string` is required). Pinned:
`packages/trace/tests/unit/journal-recovery.test.ts`.

**T-35.** A trailing partial line is not counted as damage; an interior bad line is. Production:
`packages/trace/src/journal-recovery.ts` (`if (!trailing) skipped += 1`). Pinned:
`packages/trace/tests/unit/journal-recovery.test.ts`.

**T-36.** `request` and opaque `host_metadata` are stored sanitized while `final_context` and
`capability_state` are stored verbatim. Production:
`packages/trace/src/json-trace-store.ts`. Pinned:
`packages/trace/tests/integration/json-trace-store.test.ts`.

**T-37.** The persisted `trace` is not re-sanitized at insert; it was sanitized at map time.
Production: `packages/trace/src/json-trace-store.ts` (`trace: record.trace`) against
`packages/trace/src/trace-mapper.ts`. **Unpinned** as a stated rule — the redaction property is
covered end-to-end at `packages/trace/tests/unit/trace-mapper.test.ts`, but nothing fails if the
insert path were to double-sanitize or stop sanitizing at map time.

**T-38.** A stored record and a stored sidecar are size-checked by `stat` before their body is read.
Production: `packages/trace/src/json-trace-store.ts` (`readBoundedUtf8`: `statSync` first,
then a second `Buffer.byteLength` check after reading). Pinned:
`packages/trace/tests/integration/json-trace-store.test.ts` (sparse oversized record)
(sparse oversized sidecar).

**T-39.** An oversized serialized record is rejected **before** it is published. Production:
`packages/trace/src/json-trace-store.ts` (throw before `writeFileDurable`). Pinned:
`packages/trace/tests/integration/json-trace-store.test.ts`.

**T-40.** An unreadable row is dropped from `items` while `total` still counts it, and the drop is
logged. Production: `packages/trace/src/json-trace-store.ts` (`continue` after
`logRecordUnreadable`). Pinned:
`packages/trace/tests/integration/observability.test.ts`;
`packages/trace/tests/integration/json-trace-store.test.ts`.

**T-41.** Owner-index freshness is guarded by `.seq` content, not directory `mtime`. Production:
`packages/trace/src/json-trace-store.ts`, consumed. Pinned:
`packages/trace/tests/integration/json-trace-store.test.ts`.

**T-42.** A `deleting` owner is invisible to `list`, to the index, and to recovery; an insert into it
either waits for a live deleter to finish (by failing) or completes a dead deleter's transaction.
Production: `packages/trace/src/json-trace-store.ts`. Pinned:
`packages/trace/tests/integration/json-trace-store.test.ts` — the
case spawns a real second OS process (`packages/trace/tests/helpers/owner-delete-insert-worker.ts`)
so the protocol is verified across process boundaries, not only in-process.

**T-43.** `listAcrossOwners` works when detached from the store object. Production: `listOwner` is a
free `const`, referenced rather than reached through `this`
(`packages/trace/src/json-trace-store.ts`); the reason is stated.
Pinned: `packages/trace/tests/integration/json-trace-store.test.ts`.

**T-44.** `list` refuses an out-of-range page rather than allocating for it. Production:
`normalizeTracePage` throws `PersistenceError` (`packages/trace/src/json-trace-store.ts`).
Pinned: `packages/trace/tests/integration/json-trace-store.test.ts`.

**T-45.** `TraceCleanup` with `ttlDays: 0` is a total no-op and its timer never keeps the process
alive. Production: `packages/trace/src/cleanup.ts` (`unref`). Pinned:
`packages/trace/tests/component/cleanup.test.ts`; the `unref` call itself is **unpinned**.

**T-46.** `resolveTraceStore` treats a blank or whitespace-only `dir` as absent and falls back to
`globalPaths().tracesDir`. Production: `packages/trace/src/trace-store-factory.ts`. Pinned:
`packages/trace/tests/integration/trace-store-factory.test.ts`.

**T-47.** The memory double and the JSON store satisfy the *same* conformance suite, so a caller
written against one works against the other. Production: `packages/trace/src/testing.ts` (and its
`Promise.reject` rather than `throw`). Pinned:
`packages/trace/tests/contract/trace-store.test.ts`.

**T-48.** `deriveEventSpan` narrows before switching, and a contributed event gets a run-level `point`.
Production: `packages/trace/src/event-span.ts`, guarding the `never`. Pinned:
`packages/trace/tests/unit/event-span.test.ts`.

**T-49.** Every `src` module of `@clarvis/trace` must appear in LCOV except the one named as
type-only. Production: floors `functions: 0.98 / lines: 0.97` at `tooling/checks/coverage.ts`;
allowlist `src/trace-handle.ts`.

**T-50 (INV-319).** Host metadata round-trips through a live journal, crash recovery, the JSON store,
and the memory double without the trace package interpreting its keys; durable stores redact secret
material. Production: `JournalHeader.host_metadata`, `journalToRecord`,
`createJsonTraceStore.insertLocked`, and `createMemoryTraceStore`. Test:
`packages/trace/tests/integration/journal.test.ts`,
`packages/trace/tests/unit/journal-recovery.test.ts`, and
`packages/trace/tests/integration/json-trace-store.test.ts`.

**T-51.** Provider tool-argument observability is bounded independently of argument size: one first
`tool_call_announced` is durable per `call_id` per physical attempt; all cumulative argument and
provider-stream progress plus completion are live signals. Retry advances the attempt and clears
the announcement set. The durable row contains identity, iteration and attempt, never argument
contents or progress counters. Production:
`announcedToolCalls`,
`buildModelCall.onRetry`, and `withStreaming.onToolInputDelta` in
`packages/loop/src/runtime/loop/loop.ts`. Test:
`packages/loop/tests/unit/stream-delta-attribution.test.ts`.

## 6. Failure modes and degradation

| Situation | Behaviour | Handler |
| --- | --- | --- |
| duplicate id for an owner | `ConflictError` (`code: "execution_id_conflict"`) rejected from `insert` | `packages/trace/src/json-trace-store.ts`; `packages/capability/src/errors.ts` |
| a concurrent inserter holds the id lock | same `ConflictError` — the lease is non-waiting (`waitMs: 0`) | `packages/trace/src/json-trace-store.ts` |
| a *stale* orphan id lock (crash) | reclaimed inline via `staleMs: TMP_ORPHAN_GRACE_MS`, insert proceeds | `packages/trace/src/json-trace-store.ts` |
| serialized record over `maxRecordBytes` | `TraceFileTooLargeError extends PersistenceError` before any write | `packages/trace/src/json-trace-store.ts` |
| stored record body corrupt on `getById` | `PersistenceError` naming the id, thrown | `packages/trace/src/trace-store.ts`; `packages/trace/src/json-trace-store.ts` |
| stored record body corrupt on `list` | dropped from the page, `total` unchanged, `trace.record_unreadable` warn | `packages/trace/src/json-trace-store.ts` |
| stored record oversized on `list` | same, `reason: "too_large"` | `packages/trace/src/json-trace-store.ts` |
| record missing under the row (`ENOENT`) | silently skipped | `packages/trace/src/json-trace-store.ts` |
| sidecar missing / corrupt / oversized | falls back to the full record; no log on read | `packages/trace/src/json-trace-store.ts` |
| sidecar cannot be written | swallowed, `trace.sidecar_write_failed` at **debug** | `packages/trace/src/json-trace-store.ts` |
| owner deletion racing an insert | `PersistenceError("… was deleted while execution … was being persisted")`, partial record rolled back | `packages/trace/src/json-trace-store.ts` |
| owner deletion racing another deletion | `PersistenceError("… deletion is in progress.")` | `packages/trace/src/json-trace-store.ts` |
| owner index outgrows `maxOwnerIndexEntries` | marked incomplete, lookups fall back to a directory scan, `trace.owner_index_evicted` at debug | `packages/trace/src/json-trace-store.ts` |
| more than `maxOwnerIndexes` owners | LRU eviction, same debug log | `packages/trace/src/json-trace-store.ts` |
| any insert failure | `trace.insert_failed` **error** log carrying the `phase`, then re-thrown | `packages/trace/src/json-trace-store.ts` |
| journal path unopenable | journal disabled, one warn, run continues without crash recovery | `packages/trace/src/journal.ts` |
| journal append fails mid-run | journal disabled, one warn, subsequent appends no-op | `packages/trace/src/journal.ts` |
| journal header unparseable at recovery | renamed `.jsonl.corrupt`, `trace.journal_quarantined` warn | `packages/trace/src/json-trace-store.ts` |
| journal exceeds a parse limit | renamed `.jsonl.oversized`, same warn with `reason: "limit"` | `packages/trace/src/json-trace-store.ts` |
| journal file exceeds `MAX_TRACE_RECOVERY_JOURNAL_BYTES` | quarantined `.jsonl.oversized` **without reading the body** | `packages/trace/src/json-trace-store.ts` |
| quarantine rename itself fails | counted anyway, warn says it "stays in place and is re-examined on every start" | `packages/trace/src/json-trace-store.ts` |
| a recovery budget runs out | `exhausted: true`, `trace.recovery_budget_exhausted` warn naming which bound, remaining journals left on disk | `packages/trace/src/json-trace-store.ts` |
| recovered record is incomplete | `recovery` on the record **and** `trace.journal_recovery_degraded` warn | `packages/trace/src/journal-recovery.ts`; `packages/trace/src/json-trace-store.ts` |
| `insert` of a recovered record throws | that journal is skipped and left on disk | `packages/trace/src/json-trace-store.ts` |
| `cleanup` throws inside `TraceCleanup` | caught, logged, count so far returned, retried next interval | `packages/trace/src/cleanup.ts` |
| `cleanup` backlog exceeds the pass cap | warn naming `max_passes`/`max_entries`; backlog left for the next interval | `packages/trace/src/cleanup.ts` |
| `list` limit/offset out of range | `PersistenceError`, thrown | `packages/trace/src/json-trace-store.ts` |
| a directory disappears mid-scan | `readDirEntries` returns quietly on `ENOENT`/`ENOTDIR`, including Bun's deferred scandir error | `packages/trace/src/json-trace-store.ts` |

Two degradations are worth naming as *policy* rather than mechanics, because the code states them:

- **The journal is best effort and must never fail a run.** `RunJournal`'s contract at
  `packages/trace/src/journal.ts`: "A run must never fail because its journal did — the journal
  is a best-effort improvement over losing the run entirely, not a new way to lose it."
- **Recovery restores the audit trail, not resumability.** `packages/trace/src/journal-recovery.ts`
  and `packages/trace/src/trace-store.ts`.

## 7. Coupling

### Inbound (what `@clarvis/trace` depends on)

| Edge | Kind | Forced by |
| --- | --- | --- |
| `@clarvis/capability` — types (`TraceEntry`, `TraceEvent`, `ExecutionRecord`, `RunRequest`, `Logger`, …) | type-only, static | `packages/trace/src/trace-store.ts` |
| `@clarvis/capability` — values (`sanitizeDeep`, `isBuiltinTraceKind`, `PersistenceError`, `ConflictError`, `executionIdConflict`, `levelEnabled`, `NOOP_LOGGER`, `unref`, `DELEGATE_TASK_MAX_CHARS`) | runtime, static | `packages/trace/src/json-trace-store.ts`, `packages/trace/src/cap-detail.ts`, `packages/trace/src/cleanup.ts`, `packages/trace/src/testing.ts` |
| `@clarvis/capability` — values (`isBuiltinTraceEntry`, `isBuiltinTraceEvent`) | runtime, static | `packages/trace/src/trace-mapper.ts` (`isBuiltinTraceEntry`), `packages/trace/src/event-span.ts` (`isBuiltinTraceEvent`) |
| `@clarvis/paths` — `ownerSegment`, `writeFileDurable(Sync)`, `acquireLocalLease(Sync)`, `reclaimLocalLeaseSync`, `isTmpFile`, `globalPaths` | runtime, static | `packages/trace/src/json-trace-store.ts`, `packages/trace/src/trace-store-factory.ts` |
| Node builtins `node:fs`, `node:os`, `node:path`, `node:crypto` | runtime, static | `packages/trace/src/json-trace-store.ts`, `packages/trace/src/journal.ts`, `packages/trace/src/execution-id.ts` |

`packages/trace/package.json` lists exactly two dependencies and no `devDependencies` of its
own beyond the root toolchain — the "no external package at all" claim in `packages/trace/src/index.ts` is
consistent with the manifest.

### Outbound (what depends on `@clarvis/trace`)

Only two packages declare it: `@clarvis/loop` and `@clarvis/kernel` (their package manifests).

| Consumer | What it takes | File |
| --- | --- | --- |
| `loop` | `createTrace` + `TraceHandle` for the run's recorder | `packages/loop/src/runtime/orchestrator.ts` |
| `loop` | `mapEntry` in the live/journal bridge | `packages/loop/src/runtime/run-trace.ts` |
| `loop` | `generateExecutionId`, `mapTrace`, `buildRecord`, `TraceStore`, `RunJournal` in `executeRun` | `packages/loop/src/runtime/execute-run.ts` |
| `loop` | `resolveTraceStore` in `buildExecuteRunDeps` | `packages/loop/src/runtime/build-run-deps.ts` |
| `loop` | re-exports `TraceStore`, `TraceCleanup`, `generateExecutionId`, `ResolvedTraceStore` from `lib.ts`, and `deriveEventSpan`/`EventSpan` from `host.ts` | `packages/loop/src/lib.ts`; `packages/loop/src/host.ts` |
| `kernel` | `TraceCleanup` + `TraceStore` in file-kernel composition | `packages/kernel/src/file-kernel.ts` |
| `kernel` | `MAX_TRACE_LIST_LIMIT` / `MAX_TRACE_LIST_OFFSET` for run pagination | `packages/kernel/src/runs/pagination.ts` |

### What forces the direction

- `@clarvis/trace` never imports `@clarvis/loop`. `packages/mcp-client/src/index.ts` describes this
  as "the same one `@clarvis/trace` draws", and `packages/supervision/src/index.ts` names it too —
  but **no test in `packages/trace`** was found to enforce it, unlike `@clarvis/capability`'s
  self-import test (`packages/capability/tests/architecture/self-import.test.ts`). See §8.
- The vocabulary/implementation split is forced by the *type* direction: `TracePort` lives in
  `capability` (`packages/capability/src/ports.ts`) and `TraceHandle` merely `extends` it
  (`packages/trace/src/trace-handle.ts`), so a capability records without knowing this package
  exists.
- `ExecutionRecord` lives in `capability`, not here
  (`packages/capability/src/trace-events.ts`), so a capability's `onRunEnd` can name the type of
  the record it receives without depending on the engine or on this package.
- The projector registry lives in `capability` because `mapEntry` takes it as a parameter
  (`packages/trace/src/trace-mapper.ts`) while capabilities produce it
  (`packages/loop/src/runtime/run-trace.ts`).

### Delegated to sibling documents

- **Which events reach a client and with what durability** — [kernel-run-service-and-events](../hosts/kernel-runs.md). This
  package produces `TraceEvent`s; the kernel decides which become protocol `RunEvent`s.
- **Boot-time orchestration of `recoverOrphans` and `TraceCleanup.start`** —
  [kernel-composition-and-lifecycle](../hosts/kernel-composition.md). `packages/kernel/src/file-kernel.ts` is the call site.
- **The trace-vs-log rule and the logging vocabulary** — [observability-and-diagnostics](../cross-cutting/observability.md). The event
  names this package emits (`trace.insert_failed`, `trace.record_unreadable`,
  `trace.sidecar_write_failed`, `trace.owner_index_evicted`, `trace.journal_quarantined`,
  `trace.journal_recovery_degraded`, `trace.recovery_budget_exhausted`, `trace.recovery_completed`,
  `trace.insert_aborted_deleted_owner`) are listed here for completeness only.
- **Atomic writes, leases and `ownerSegment`** — the `@clarvis/paths` document. This spec cites their
  entry points but does not restate their semantics.

## 8. Open questions

- **`agent_finish_nudge` is unpinned.** `packages/trace/src/trace-mapper.ts` maps it to `null`,
  but the parametrised test at `packages/trace/tests/unit/trace-mapper-kinds.test.ts` lists only
  `init`, `terminate`, `agent_registered`, `agent_stopped`, `agent_steered`. Removing
  `agent_finish_nudge` from that `case` list would not fail the suite — the compile-time
  exhaustiveness guard would then reject it only if it also lost every other branch, and it
  would in fact fall into `default` and fail `tsc`. So the *compiler* catches deletion; nothing
  catches it being moved into a projecting branch that mints a wire event.
- ~~**"`capDetail` is the only cap table" has no test.** The rule is stated at
  `packages/trace/src/cap-detail.ts`, but nothing fails if `trace-mapper.ts` grows a second,
  differing bound — and the doc at `packages/trace/src/cap-detail.ts` explains precisely that double-capping at two
  different maxima "leaves a mangled marker".~~ **Resolved** in
  `packages/trace/tests/architecture/package-boundary.test.ts`: exactly that — declaring a second
  `RESULT_MAX` in `trace-mapper.ts` now fails. The discriminating detail is that only **character**
  caps count. A record-size limit or a list page cap is a different kind of number — exceeding one is
  refused or paged, never silently shortened — so a first attempt matching any `MAX` flagged the
  store's byte and list bounds and had to be narrowed.
- ~~**No architecture test enforces `@clarvis/trace` not importing `@clarvis/loop`.**~~ **Resolved:**
  `packages/trace/tests/architecture/package-boundary.test.ts` now scans `src` **and**
  `tests`, alongside the manifest check. Both trees, because a `devDependency` import from `src`
  type-checks and bundles while the manifest still looks clean, and a test reaching for a fixture from
  a package above is a cycle no build, install or consumer ever sees. Two things had to be right, both
  found by the test failing: the scanning file must exclude itself, since its fixture necessarily
  contains the forbidden import forms; and that fixture must build each specifier by concatenation,
  because `@clarvis/loop` runs a mirror scan over its own dependencies and a literal
  `from "@clarvis/…"` inside a string is indistinguishable from the real thing to a line matcher.
  Adding the suite also exposed that `packages/trace/package.json` enumerated its test directories and
  would never have run a new `tests/architecture` level — caught by **knip**, not by the suite.
- **`MAX_CLEANUP_PASSES` is referenced but does not exist.** The TSDoc at
  `packages/trace/src/cleanup.ts` says "Caps at {@link MAX_CLEANUP_PASSES} batches per call", but no
  such symbol is defined; the real bound is the local `maxPasses`. A stale doc link, not a
  behavioural defect.
- **`JournalHeader.v` accepts any number `<= JOURNAL_VERSION`.** `packages/trace/src/journal-recovery.ts`
  rejects only a *newer* version. There is no reader for a hypothetical `v: 0`, and the code does not
  say what an older version's line shape would be.
- **`writeGenerationState` is not itself under the delete lease on the `ensureActiveGeneration` path's
  first read.** `packages/trace/src/json-trace-store.ts` reads state before acquiring the
  lease, and the correctness argument is stated in prose rather than checked. Whether the
  intervening window is closed by the subsequent re-read is a claim traceable through the
  source but unconfirmed as the intent.
- **Rationale is absent almost everywhere it matters.** The doc comments quoted above give *stated*
  reasons for the `.summary` suffix, the `.seq` guard, the journal's lack of `fsync`, the retention-vs-
  grace split, and the `malformed_arguments` preservation. For the rest — the specific numeric values
  of `RESULT_MAX`, `ARGS_MAX`, `DETAIL_MAX_ENTRIES`, `MAX_TRACE_RECOVERY_JOURNALS`, `TMP_ORPHAN_GRACE_MS`
  — the code states the mechanism and not the derivation, and none is invented here.
- **Windows.** `@clarvis/trace` is not in the Windows CI job: it runs `@clarvis/paths`,
  `@clarvis/tools` and `@clarvis/plan` only
  (`.github/workflows/ci.yml`). `process.kill(pid, 0)` (`packages/trace/src/journal-recovery.ts`) and the file-mode assertions
  (`packages/trace/src/json-trace-store.ts`; `packages/trace/src/journal.ts`) are POSIX-shaped; whether they behave as specified
  on Windows is unverified from this repository.
