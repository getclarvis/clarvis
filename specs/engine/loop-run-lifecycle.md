# The run loop: iterations, model calls, steering, cancellation and termination

> Implemented at `packages/loop/src/runtime/**`. Every claim below is anchored to a file and line.
> Open questions are collected in the final section.

## 1. Purpose

This subsystem is the part of `@clarvis/loop` that turns *one validated run request* into *one
persisted execution record and one terminal `RunResponse`*. It spans three nested layers, each of
which owns a different question:

| Layer | Entry point | Owns |
| --- | --- | --- |
| Run | `executeRun` — `packages/loop/src/runtime/execute-run.ts:274` | Validation, execution-id reservation, continuation load, journal, persistence, capability run-end |
| Orchestration | `runOrchestrator` — `packages/loop/src/runtime/orchestrator.ts:182` | Capability activation, trace construction, seed, `run_started`/`run_ended`, MCP pool, clock/timeout |
| Agent | `runAgent` → `runAgentLoop` — `packages/loop/src/runtime/loop/run-agent.ts:124`, `packages/loop/src/runtime/loop/loop.ts:829` | The iteration loop itself: compact, call model, classify, dispatch, guard, checkpoint |

The loop layer is an unbounded `for (;;)` (`packages/loop/src/runtime/loop/loop.ts:845`) with no
iteration counter of its own — every stop condition is delegated to an injected probe or factory
(`LoopDerived.maybeCancelled`, `.checkpoint`, `.results`, `.finalize` —
`packages/loop/src/runtime/loop/loop.ts:172-177`). `runAgentLoop` never constructs a terminal result:
it selects one from `AgentLoopResults` (`packages/loop/src/runtime/loop/loop.ts:94-105`) or returns
what a handler, gate or checkpoint handed it.

The same three layers serve both run shapes. `subagent-only` runs the entry profile directly;
`lead-subagent` runs the entry profile as a lead that gains the delegation capability
(`packages/loop/src/runtime/entry-inputs.ts:175-206`). The shape is derived once
(`packages/loop/src/runtime/run-shape.ts:67`) from whether the entry profile declares a non-empty
`can_spawn` (`packages/loop/src/validation/request/run-shape.ts:19`).

## 2. Surface

### 2.1 Exported from `@clarvis/loop` (the package root)

| Symbol | Kind | Signature / shape | Source |
| --- | --- | --- | --- |
| `executeRun` | function | `(args: ExecuteRunArgs) => Promise<ExecuteRunOutcome>` | `packages/loop/src/lib.ts:8`, `packages/loop/src/runtime/execute-run.ts:274` |
| `ExecuteRunArgs` | type | see §2.2 | `packages/loop/src/runtime/execute-run.ts:83` |
| `ExecuteRunDeps` | type | see §2.3 | `packages/loop/src/runtime/execute-run.ts:53` |
| `ExecuteRunOutcome` | type | `{ executionId: string; response: RunResponse }` | `packages/loop/src/runtime/execute-run.ts:105` |

`runOrchestrator`, `runAgent`, `runAgentLoop`, `runWithClockAndTimeout`, `buildEntrySeed`,
`createEntryInput`, `traceBridge`, `loopResultToResponse` and `mapErrorToResponse` are **not** in
`packages/loop/src/lib.ts` — they are internal to the package and are imported by tests through
relative paths (e.g. `packages/loop/tests/integration/orchestrator.test.ts:3`,
`packages/loop/tests/unit/run-timeout.test.ts:2`).

`collectCapabilityState` is exported from its module (`packages/loop/src/runtime/execute-run.ts:194`)
but is not re-exported by `lib.ts`; its only non-test consumer is `executeRun` itself
(`packages/loop/src/runtime/execute-run.ts:415`).

`BUILTIN_CAPABILITY_NAMES` is exported from the orchestrator module
(`packages/loop/src/runtime/orchestrator.ts:134`) and is a deliberate literal duplicate of three
capability names, locked by `packages/loop/tests/architecture/builtin-capability-names.test.ts`
(see INV-068 in [loop-capability-composition](capability-composition.md), which owns it).

### 2.2 `ExecuteRunArgs` — one run's inputs

| Field | Type | Meaning | Source |
| --- | --- | --- | --- |
| `rawBody` | `unknown` | the un-validated request body | `packages/loop/src/runtime/execute-run.ts:84` |
| `owner` | `string` | scoping key for persistence and capability activation | `:85` |
| `deps` | `ExecuteRunDeps` | the long-lived collaborators | `:86` |
| `onEvent?` | `(e: TraceEvent) => void` | live wire-event sink | `:87` |
| `externalSignal?` | `AbortSignal` | caller cancellation | `:88` |
| `elicit?` | `Elicit` | human channel | `:89` |
| `steer?` | `SteerSource` | mid-run user messages | `:90` |
| `compaction?` | `CompactionSource` | explicit compaction requests | `:92` |
| `capabilities?` | `Capability[]` | per-run capabilities, activated *after* the deps-level ones | `:95` |
| `onCapabilityEvent?` | `CapabilityEventListener` | capability out-of-band notices | `:98` |

### 2.3 `ExecuteRunDeps` — the long-lived collaborators

`env`, `llm`, `connections`, `traceStore`, `logger?`, `workspaceRoot`, `capabilities?`,
`capabilityRegistry?`, `persistedTraceProjectors?`, `extensionAdmission?`
(`packages/loop/src/runtime/execute-run.ts:53-75`).

### 2.4 `OrchestratorDeps` / `OrchestratorResult`

`OrchestratorDeps` (`packages/loop/src/runtime/orchestrator.ts:81-118`) is a trimmed slice of
`ExecuteRunDeps` plus the per-run channels, plus four fields `executeRun` computes and hands down:
`requestView`, `grantDeclarations`, `persistedTraceProjectors`, `emitCapabilityEvent`, and the
`openJournal(wallStartedAt)` factory (`:117`).

`OrchestratorResult` (`:146-154`) is `{ response, trace, wallStartedAt, finalContext?, runCapabilities }`.

### 2.5 `RunShape` — the derived run shape

`RunShape` (`packages/loop/src/runtime/run-shape.ts:40-50`) is the read-only summary
`deriveRunShape` computes once; every downstream builder (seed, entry input, accounting) reads its
role and settings from here rather than re-deriving them:

| Field | Meaning |
| --- | --- |
| `entryProfile` | the request's entry `RunRequest["profiles"][number]` |
| `entryResolved` | the entry profile's `ResolvedSubagentProfile` |
| `isLead` | whether the entry profile runs as a lead (declares a non-empty `can_spawn`) |
| `userInputEnabled` | whether the run's elicitation relay/serializer is active |
| `askUserGranted` | whether the entry profile carries the `ask_user` grant |
| `softMode` | whether the run's budgets are soft (escalatable) rather than hard |
| `spawnableRegistry` | the subset of `fullRegistry` the entry profile's `can_spawn` names |
| `fullRegistry` | every resolved subagent profile the request declared |
| `primarySubagentModel` | the model surfaced in `run_started` telemetry (see below) |

`deriveRunShape` (`:67-98`) derives `primarySubagentModel` as: for a lead, the profile named by
`entryProfile.default_spawn`, or else the first spawnable profile's model; for a non-lead, the entry
profile's own model (`:84-87`). `resolveConfig` (`:20-27`) is the sibling function that produces the
run's hard `ResolvedConfig`: `max_tokens`, bounded only when
`request.budget.on_exceed === "stop"`, and `timeout_ms`. It carries no iteration cap — it declared a
`max_iterations` fixed at `Number.POSITIVE_INFINITY` for every run, and that field has been removed.

### 2.6 The agent-layer contract

| Type | Purpose | Source |
| --- | --- | --- |
| `LoopCore` | what `runAgentLoop` reads directly — agent identity, `target`, `budget`, `runtime`, `compaction`, `hooks`, `clock`, `computeRegion`, `spillToolResult`, `allToolsUnavailable`, `onStart` | `packages/loop/src/runtime/loop/loop.ts:115-150` |
| `LoopDerived` | what `runAgent` assembles on top — `ctx`, `tools`, `handlers`, `guards`, `progress`, `anchor?`, `maybeCancelled`, `checkpoint`, `results`, `finalize`, and nine optional hook slots | `:163-212` |
| `RunAgentInput` | `LoopCore` + seed `messages` and persona knobs — see the field table below | `packages/loop/src/runtime/loop/run-agent.ts:52-105` |
| `FinalizePolicy` | `fastAcceptSubmit?` and `onTextOnly` | `packages/loop/src/runtime/loop/loop.ts:71-88` |
| `AgentLoopResults` | five terminal factories: `allToolsUnavailable`, `budgetExhausted`, `emptyResponse`, `noProgress`, `guardTrip` | `:94-105` |
| `AgentResult` | the agent-layer terminal outcome (owned by `@clarvis/capability`) | `packages/capability/src/agent-result.ts:49-56` |
| `ProgressTracker` | the no-progress streak tracker: `bump(true)` resets the streak to `0` and never trips; `bump(false)` increments it and trips (returns `true`) only once the streak reaches `limit`; `reset()` clears it | `packages/loop/src/runtime/loop/progress.ts:6-39`. Tests: `packages/loop/tests/unit/progress.test.ts:4-37` |
| `LlmTarget` / `toLlmTarget` | a fully resolved model-call target (model/provider identity plus the optional per-call knobs); `toLlmTarget(llm, src)` copies only the knobs `src` defines, so an unset optional field is **omitted** from the built target rather than copied through as `undefined` | `packages/loop/src/runtime/loop/loop-shared.ts:30-71`. Test: `packages/loop/tests/unit/loop-shared.test.ts:7-18` (`"reasoningEffort" in withoutEffort === false`) |
| `LoopAgentBuildContext` / `EngineTerminalVerdict` / `EngineHandlerVerdict` | the engine's own widened build-context and verdict types: `LoopAgentBuildContext` is the capability `AgentBuildContext` plus `ctx`/`trace`/`budget`, which no capability reads; `EngineTerminalVerdict` widens a terminal `HandlerVerdict` with an optional `text` only the engine's own handlers populate; assignability runs one way — every capability-produced verdict satisfies the engine type, never the reverse | `packages/loop/src/runtime/loop/loop-contract.ts:39-74`. This is the type mechanism behind invariant 33. |

`RunAgentInput`'s persona-knob fields (`packages/loop/src/runtime/loop/run-agent.ts:52-105`), beyond `LoopCore` and `messages`:

| Field | Purpose |
| --- | --- |
| `steer?` | source of mid-run user steer messages, drained each iteration |
| `registry` | the entry agent's `NamespacedRegistry` of MCP tools |
| `stagnationThreshold?` / `stagnationSoftThreshold?` | overrides for the convergence guards' stagnation/warning thresholds |
| `guardEscalationAsk?` | asks the user whether to continue past a tripped guard; present only when the run opted into guard escalation |
| `guardMaxEscalations?` | how many guard trips one run may be waved through; `0` disables escalation |
| `mcpProgress` | the persona's tool-progress policy: whether a dispatch outcome counts as progress |
| `mcpFullToolset?` | when `true`, advertises every resolved tool as available, not just the registry's |
| `contract?` | enables `submit_result` finalization with structured validation |
| `agentCapabilities?` | per-agent capability activations, already grant-gated upstream |
| `buildBeforeCheckpoint?` | builds an optional `beforeCheckpoint` hook bound to the agent build context |
| `forceToolOnNudge?` | whether a finalize gate's nudge forces a tool call on the next iteration |
| `staticAnchor?` | a fixed compaction anchor used when no capability contributes one |
| `noProgressLimit` | the no-progress streak limit before the run ends in error |
| `noProgressMessage` | builds the error message for a plain no-progress termination |
| `textNoSubmitMessage?` | builds the error message when a contract run keeps producing text without submitting |
| `emptyResponseAgent` | which persona (`"LLM"` or `"Lead"`) to name in the empty-response error |
| `onContext?` | notified of the created `LiveContext` before the loop starts |
| `warnings?` | mutable sink for run-level warnings, forwarded to `AgentBuildContext.warnings` |

### 2.7 Environment knobs this subsystem reads

| Key | Default | Read at |
| --- | --- | --- |
| `CLARVIS_DEFAULT_TIMEOUT_MS` | `300000` (`packages/capability/src/env.ts:64`) | `packages/loop/src/runtime/run-shape.ts:21` |
| `CLARVIS_DEFAULT_ITERATION_LIMIT` | `50` (`packages/capability/src/env.ts:69`) | `packages/loop/src/runtime/orchestrator.ts:606,608` |
| `CLARVIS_DEFAULT_ELICIT_WAIT_MS` | `1_800_000` (`packages/capability/src/env.ts:68`) | `packages/loop/src/runtime/orchestrator.ts:431` |
| `CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS` | `5000`, capped at `60_000` (`packages/capability/src/env.ts:153`) | `packages/loop/src/runtime/orchestrator.ts:233` |
| `CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` | `2000` (`packages/capability/src/env.ts:165`) | `packages/loop/src/runtime/execute-run.ts` (`executeRun`, `raceWithBudget`); `packages/loop/src/runtime/orchestrator.ts` (`wrap`) |
| `CLARVIS_RUN_ABORT_SETTLE_MS` | `2000` (`packages/capability/src/env.ts:204`) | `packages/loop/src/runtime/orchestrator.ts:622` |
| `CLARVIS_DEFAULT_FORCE_TOOL_ON_NUDGE` | `true` (`packages/capability/src/env.ts:106`) | `packages/loop/src/runtime/entry-inputs.ts:255-257` |
| `CLARVIS_GUARD_MAX_ESCALATIONS` | `2` (`packages/capability/src/env.ts:95`) | `packages/loop/src/runtime/entry-inputs.ts:262` |
| `CLARVIS_MAX_PARALLEL_SUBAGENTS` | — | `packages/loop/src/runtime/orchestrator.ts:591` |
| `CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS` (+`_RUN_END_CALLS`, `_CALLS_PER_OPERATION`) | — | `packages/loop/src/runtime/extension-admission.ts:220-222` |

### 2.8 Loop-level constants

| Constant | Value | Source |
| --- | --- | --- |
| `MAX_CONSECUTIVE_EMPTY_RESPONSES` | `2` | `packages/loop/src/runtime/loop/loop.ts:230` |
| `MAX_OVERFLOW_RECOVERIES` | `3` | `packages/loop/src/runtime/loop/loop-iteration.ts:7` |
| `REWRITE_NOTE_MAX_CHARS` | `2_000` | `packages/loop/src/runtime/loop/loop.ts:460` |
| `LIFECYCLE_HOOK_TIMEOUT_MS` | `5_000` | `packages/loop/src/runtime/loop/lifecycle-hooks.ts:16` |
| `LIFECYCLE_GATE_HOOK_TIMEOUT_MS` | `30_000` | `packages/loop/src/runtime/loop/lifecycle-hooks.ts:18` |
| `LEAD_NO_PROGRESS_LIMIT` / `SUBAGENT_NO_PROGRESS_LIMIT` | `6` / `6` | `packages/loop/src/runtime/loop/loop-shared.ts:8,10` |
| `CACHE_PREFIX_LOSS` | `0.1` | `packages/loop/src/runtime/loop/iteration-metrics.ts:68` |

## 3. Data and formats

### 3.1 Execution id

Either the request's `execution_id` verbatim, or one minted by `generateExecutionId()`
(`packages/loop/src/runtime/execute-run.ts:315-323`). Generated ids are prefixed `exec_` and satisfy
the format constants — charset `[A-Za-z0-9._:-]`, length `1..128` — pinned by
`packages/loop/tests/unit/execution-id.test.ts:13-45`. `packages/loop/tests/component/execute-run.test.ts:46`
asserts `expect(executionId).toMatch(/^exec_/)`.

### 3.2 The terminal `RunResponse`

Discriminated by `status` (`packages/capability/src/run.ts:286-292`):

| status | payload | produced by |
| --- | --- | --- |
| `completed` | `result: ResultValue` | `loopResultToResponse` — structured result if present, else `text ?? partialText` (`packages/loop/src/runtime/run-response-mapping.ts:95-102`) |
| `budget_exhausted` | `result` = partial (structured if any, else text) | `:104` |
| `cancelled` | `result` = partial | `:106`, and `mapErrorToResponse` when the signal aborted (`:47-49`) |
| `soft_limit_declined` | `result` = partial | `:108` |
| `error` | `error: ErrorBody` | `:109-112`, `errorResponse` (`packages/loop/src/runtime/support/run-response.ts:13`) |
| `interrupted` | `result` | never produced here — `packages/capability/src/execution-status.ts:11` states it is only produced by `TraceStore.recoverOrphans` |

Every variant carries `usage: Usage` = `{ iterations_used, elapsed_ms, by_agent, warnings? }`
(`packages/capability/src/run.ts:110-116`).

### 3.3 Provider-error → `ErrorCode` mapping

`PROVIDER_ERROR_CODES` (`packages/loop/src/runtime/run-response-mapping.ts:25-29`):

| `ProviderError.kind` | `ErrorCode` |
| --- | --- |
| `context_overflow` | `context_overflow` |
| `quota` | `provider_quota_exhausted` |
| `content_policy` | `provider_content_policy` |
| anything else (`transient`, `client`, `auth`) | `provider_error` |

`details` always carries `{ kind, status?, retry_after_ms? }`
(`packages/loop/src/runtime/run-response-mapping.ts:9-14`), pinned by
`packages/loop/tests/unit/run-response-mapping.test.ts:39-46`. A `CodedError` keeps its own `code`
and gets `sanitizeDeep`'d details (`:58-65`), pinned at `packages/loop/tests/unit/run-response-mapping.test.ts:61-81`.
Anything else becomes `internal_error` (`:66-70`).

### 3.4 The `init` trace detail

`InitDetail` (`packages/loop/src/runtime/run-trace.ts:15-19`) is `{ config, modelProvider, mode }` —
the run's resolved `ResolvedConfig`, the model provider name, and the `ExecutionMode`.
`deriveInitDetail(config, modelProvider, mode)` (`:47-53`) builds it verbatim, and it is recorded on
the `init` entry at `packages/loop/src/runtime/orchestrator.ts:375`
(`traceHandle.record("init", deriveInitDetail(config, provider, mode))`). Per §3.7, `init` is never
wire-visible.

### 3.5 `run_started` / `run_ended` trace detail

`deriveRunStartedDetail` (`packages/loop/src/runtime/run-trace.ts:69-80`) emits
`{ mode, lead_model?, subagent_model, max_tokens? }` — the token cap only when finite. It also emitted
a `max_iterations`, which `resolveConfig` fixed at `Number.POSITIVE_INFINITY` for every run, so the
finiteness test was always false and the field never reached a trace; it is gone from `ResolvedConfig`
and from both trace-detail types. `ResolvedConfig` is now `max_tokens` + `timeout_ms`
(`packages/loop/src/runtime/run-shape.ts:20-29`). The run's real iteration cap is `entryMax`, resolved
from the agent profile in the orchestrator.

`deriveRunEndedDetail` (`packages/loop/src/runtime/run-trace.ts:91-103`):

| response | `reason` | `code` |
| --- | --- | --- |
| non-`error` | the status verbatim | absent |
| `error`, code `timeout` | `timeout` | `timeout` |
| `error`, code in `GUARD_TRIP_CODES` or in the capability set | `guard_trip` | the code |
| `error`, otherwise | `error` | the code |

`GUARD_TRIP_CODES` = `no_progress`, `tool_failure_loop`, `stagnation_detected`, `agents_unfinished`,
`background_children_failing`, `all_tools_unavailable`, `empty_response`
(`packages/loop/src/runtime/run-trace.ts:26-34`). Every row of this table is pinned by
`packages/loop/tests/unit/run-trace.test.ts:19-80`, including that a capability-contributed code maps
to `guard_trip` **only** when the capability supplied it (`:48-68`).

### 3.6 Per-iteration trace events

`recordIterationMetrics` (`packages/loop/src/runtime/loop/iteration-metrics.ts:163-209`) records, once
per iteration after the model call returns, a `lead_iteration` or `subagent_iteration` entry (chosen by
`agent`) carrying `{ subagent_instance_id?, iteration, started_at, ended_at, model, input_tokens,
output_tokens, cached_tokens, cache_write_tokens, cache_read_ratio, response, response_phase? }`,
where `response` is `llmResult.text ?? ""` and `response_phase` is the last declared phase among the
result's retained assistant text parts. When the result carries `reasoning`, it additionally records a
`model_reasoning` entry: `{ agent, subagent_instance_id?, iteration, model, text }`. A paired
`lead_iteration_started` / `subagent_iteration_started` marker — `{ subagent_instance_id?, iteration,
started_at, model }` — is recorded at the *top* of the iteration by `recordIterationStarted`
(`:247-262`), called from `startIteration` inside `runIterationPreamble`. Every field of both entry
kinds is pinned by `packages/loop/tests/unit/iteration-metrics.test.ts:50-75` (lead),
`:76-98` (subagent), and `model_reasoning`'s conditional `subagent_instance_id` by `:100-121`.
Assistant text parts are appended through `LiveContext.appendAssistant` or
`appendAssistantToolCalls` and survive snapshots unchanged; `packages/loop/tests/unit/context-snapshot.test.ts`
pins both phase and opaque item metadata.
(present for a subagent) and `:122-144` (absent for the lead).

`model_call_error` is recorded strictly before `run_ended` on a provider-error termination —
`packages/loop/tests/integration/run-lifecycle-events.test.ts:225-257` pins one classified
`model_call_error` entry (`agent`, `kind`, `status`) followed by a `run_ended` entry whose `reason` is
`"error"` and whose `code` is `"provider_error"`, with the error entry's index strictly less than the
ended entry's.

### 3.7 Durable vs live trace entries

`createTrace` (`packages/trace/src/in-memory-trace.ts:41`) exposes two writers: `record` pushes onto
`trace.entries` and calls the sink with `durable = true` (`:48-53`); `signal` calls the sink with
`durable = false` and pushes nothing (`:54-58`). After `seal()` both are no-ops (`:49,55,60-62`).

`traceBridge` (`packages/loop/src/runtime/run-trace.ts:138-180`) is the sink: it pokes the clock
first (`:148`), feeds `ingest` (the agent registry) inside a try/catch (`:149-161`), then maps once
via `mapEntry` and hands the *same* object to `journal` (durable only) and `emitEvent` (`:162-167`).
`packages/loop/tests/unit/run-trace.test.ts:181-195` asserts `journalled[0]` is the identical object
as `emitted[0]`.

`init` and `terminate` entries map to `null` in `mapEntry`
(`packages/trace/src/trace-mapper.ts:506-512`), so they exist in the in-memory trace but never in the
persisted `trace.events` — which is why `packages/loop/tests/integration/run-lifecycle-events.test.ts:55`
can assert `run_started` is the *first* persisted event even though `init` was recorded before it
(`packages/loop/src/runtime/orchestrator.ts:375-376`).

### 3.8 The entry seed

`buildEntrySeed` (`packages/loop/src/runtime/entry-seed.ts:126`) composes, in order
(`:174-179`):

1. one `system` message — `buildSystemSections({ workspaceRoot, basePrompt?, capabilitySections? })`
   joined with `"\n\n"` (`:142-149`);
2. the filtered continuation history (`:156-160`), image-collapsed when the entry agent lacks `vision`
   (`:176`, `:77-85`);
3. the pinned capability seed blocks the continuation did not already carry, as `user` entries
   (`:167-172`);
4. this turn's request `messages` (`:178`).

The filter drops (a) restored *volatile* entries — those with `canonical === true` or a `note_kind`
(`:70-72`, applied at `:157`) — and (b) any restored entry whose leading marker belongs to a
capability that contributed no fresh block this run (`:158-159`). A marker still live is *kept*, and
the freshly rendered block for that marker is *discarded* (`:162-172`).

Worked example, from `packages/loop/tests/unit/entry-seed-markers.test.ts:99-116`: with a carried
block `<cap-block>\nwhat the session started with\n</cap-block>` and a fresh `SEED` for the same
marker, the composed texts after the system head are
`[carried, "a normal earlier message", "do the thing"]` and the fresh `SEED` is absent.

`EntrySeed` is `{ entryMessages, turnImages, entryStripsImages }`
(`packages/loop/src/runtime/entry-seed.ts:30-34`).

### 3.9 `final_context`

The entry agent's `LiveContext` is captured through `onContext`
(`packages/loop/src/runtime/orchestrator.ts:615-617`), read *after* the loop settles
(`:650`), and attached only when non-empty (`:653`). It excludes the system head — asserted at
`packages/loop/tests/integration/final-context-capture.test.ts:72`
(`expect(snap.some((e) => e.message.role === "system")).toBe(false)`). It is captured even on a
non-`completed` exit (`:85-114`, a `budget_exhausted` run).

### 3.10 `capability_state`

`collectCapabilityState` (`packages/loop/src/runtime/execute-run.ts:194`) returns
`Record<string, unknown> | undefined`, keyed by capability `name` (`:243`), seeded from the continued
run's prior state (`:201`) so a capability that did not run this turn keeps its slot
(`packages/loop/tests/unit/capability-state.test.ts:99-106`). It returns `undefined` when nothing
contributed, so the record stays clean (`:263`, pinned at `:38-41`).

## 4. Behavior

### 4.1 `executeRun`, in order

| # | Step | Source |
| --- | --- | --- |
| 1 | resolve the extension-admission controller (host's, else a per-`deps` memoized fallback — `extensionAdmissionFor`, `packages/loop/src/runtime/extension-admission.ts:216-228`) | `packages/loop/src/runtime/execute-run.ts:286` |
| 2 | concatenate `deps.capabilities` then `args.capabilities` — deps-level first | `:287` |
| 3 | compose the persisted-trace projector registry from host + every capability | `:288-291`, `packages/loop/src/runtime/run-trace.ts:37-45` |
| 4 | compose the capability registry with every capability's `grants` | `:310-313` |
| 5 | `validateBody(rawBody, env, requestRegistry)` | `:314` |
| 6 | build the request view; ask every capability `requiresUserInput?` | `:315-318` |
| 7 | `deriveRunShape(parsed, capabilityNeedsHuman)` and derive `runMode` | `:319-320` |
| 8 | **throw** `ValidationError("elicitation_not_supported")` if `userInputEnabled` and no `elicit` | `:321-328` |
| 9 | compile the result contract when `output_schema` is present | `:330-331` |
| 10 | choose the execution id; **throw** `ConflictError` if `traceStore.existsForOwner` | `:333-341` |
| 11 | bind the run-scoped logger with `execution_id`, `owner_key_name`, `mode` | `:354-357` |
| 12 | reserve the id in the per-store in-flight set | `:359` |
| 13 | derive `promptCacheKey = prompt_cache_key ?? executionId`, `promptCacheTtl = prompt_cache_ttl ?? (humanParkLikely ? "1h" : "5m")` | `:361-362` |
| 14 | load the continuation; **throw** `ContinuationUnavailableError` if absent/empty | `:364-376` |
| 15 | build the swallowing capability-event emitter | `:378-384` |
| 16 | create the run's `AbortController` and forward `externalSignal` (including an already-aborted one) | `:386-393` |
| 17 | `runOrchestrator(parsed, {...})` with the prompt-cache-defaulted LLM | `:397-431`, `:412` |
| 18 | `collectCapabilityState(runCapabilities, response.status, continuation?.capability_state, …)` | `:433-439` |
| 19 | `buildRecord({...})` with `mapTrace(trace.entries, wallStartedAt, projectors)` | `:440-449` |
| 20 | `traceStore.insert(record)`; on success `journal.discard()` | `:451-453` |
| 21 | fire every capability's `onRunEnd(record)`, collecting returned promises | `:472-500` |
| 22 | await them under `CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` via `raceWithBudget` | `:501-511` |
| 23 | return `{ executionId, response }` | `:513` |
| — | `finally`: remove the abort listener, `journal.close()` | `:514-517` |
| — | outer `finally`: release the execution-id reservation | `:518-520` |

Step 8's error carries `{ capability: "elicitation" }` details and is pinned by
`packages/loop/tests/component/execute-run.test.ts:74-83`.

### 4.2 `runOrchestrator`, in order

| # | Step | Source |
| --- | --- | --- |
| 1 | `startedAt = performance.now()`, `wallStartedAt = Date.now()` | `packages/loop/src/runtime/orchestrator.ts:186-187` |
| 2 | `resolveConfig`, `resolveSubagentProfiles`, capability tool metadata, projectors, request view | `:188-194` |
| 3 | `deriveRunShape` (re-derived here, with its own `requiresUserInput` sweep) | `:195-199` |
| 4 | create the agent registry **iff** `canSpawnChildren(shape, grantDeclarations)` | `:204-212`, `packages/loop/src/runtime/spawn-shape.ts:18-29` |
| 5 | build `CapabilityServices`; provide `AGENT_REGISTRY_PORT` when a registry exists | `:232-233` |
| 6 | activate every capability: `extensionAdmission.call(…, capability.forRun(ctx))` inside `boundPromise(setupTimeoutMs)` | `:253-323` |
| 7 | collect `lifecycle` hooks from the activations | `:324` |
| 8 | resolve every `seedBlock()` under the same wall bound | `:325-353` |
| 9 | collect `seedMarker`s from **all registered** capabilities, not only the activated ones | `:354-356` |
| 10 | provide `TOOL_EFFECT_PORT` | `:357` |
| 11 | open the journal (`openJournal(wallStartedAt)`) and create the trace over `traceBridge` | `:360-384` |
| 12 | log `run.composed` once, at `info` | `:386-392`, `:520-550` |
| 13 | `record("init", …)` then `record("run_started", …)` | `:393-394` |
| 14 | `fireObservers(hooks, "onRunStart", …)` under `setupTimeoutMs` | `:395-411` |
| 15 | wrap `elicit` in `withElicitWaitBound`, then the serializing relay | `:449-463` |
| 16 | `openToolPool`; on `!ok` short-circuit straight to `wrap(poolResult.response)` | `:465-474` |
| 17 | record `mcp_degraded` when some servers failed but the pool is usable | `:476-478` |
| 18 | `runEntryAgent(…)`, then `wrap(outcome.response, outcome)` | `:480-497` |
| — | `finally`: `Promise.allSettled(opened.map(o => o.release()))` | `:498-500` |

`wrap` (`:413-441`) is the single exit funnel: it unions every activation's `guardTripCodes`
(`:417`), records `run_ended` (`:418`), fires `onRunEnd` observers under the run-end timeout
(`:419-432`), then **seals** the trace (`:433`). Sealing after `run_ended` is what makes `run_ended`
the last persisted event (`packages/loop/tests/integration/run-lifecycle-events.test.ts:56`). The
`onRunEnd` observer context it hands every lifecycle hook is `{ status, errorCode?, iterationsUsed,
elapsedMs }` — `errorCode` present only when `response.status === "error"` (`:423-426`). This is the
lifecycle-hook *observer* method (§4.14's `ObserverMethod`), distinct from `RunCapability.onRunEnd`
(invariant 8), which fires later, in `executeRun`, after the record is persisted.

Note the asymmetry in step 6: the activation is invoked **even for a pre-aborted run**, with the
admission class switched to `"run_end"` when `deps.signal?.aborted` (`:270`). The in-source comment
at `:258-262` states the reason: "The activation owns finalizeRun/onRunEnd, which must still observe
the cancelled record."

### 4.3 `runEntryAgent` — building the entry agent

`packages/loop/src/runtime/orchestrator.ts:569-655`:

- tool registry from the pool, reserving capability wire names (`:584`);
- token ledger from `config.max_tokens` (`:585`);
- the entry iteration cap (`:586-590`):

| role | cap |
| --- | --- |
| lead, soft mode | `entryResolved.iterationLimit ?? CLARVIS_DEFAULT_ITERATION_LIMIT` |
| lead, hard mode | `entryResolved.iterationLimit ?? Number.POSITIVE_INFINITY` |
| sub-agent | `resolveIterationCap(entryResolved, CLARVIS_DEFAULT_ITERATION_LIMIT)` (`packages/loop/src/runtime/subagents/subagent-profiles.ts:67-72`) |

- usage accounting (`:611`), entry seed (`:614`), and the per-attempt input builder (`:617-636`);
- `runWithClockAndTimeout` whose `buildLoop` runs the vision prepass *then* `runAgent` (`:646-656`);
- `toResponse` maps the loop result with a role-aware empty-result fallback message: `"Lead returned
  an empty response."` for a lead; otherwise `"LLM returned an empty response."` for
  `empty_response` and `"Run terminated with no result."` for any other code (`:658-665`).

### 4.4 `createEntryInput` — assembling the per-attempt input builder

`packages/loop/src/runtime/entry-inputs.ts:163-318` builds the `EntryInputBuilder` `runEntryAgent`
calls once per clock/signal attempt (`EntryInputBuilder`'s own type at `:114-117`), in this order:

1. **`entryRunCaps` composition** (`:174-206`): a lead's run-capability list is
   `[createDelegationRunCapability({...}), ...(deps.runCapabilities ?? [])]` — the delegation
   capability first, then the run's own capabilities; a plain subagent gets only
   `deps.runCapabilities ?? []`, no delegation capability at all.
2. **`orderCapabilities(entryRunCaps)`** (`:208`) sorts that list by declared `order`, exactly as
   `runOrchestrator`'s own activation fold does, before anything is folded into the entry agent's
   handlers.
3. **The agents-registry injection** (`:210-217`): when `deps.services` holds an `AGENT_REGISTRY_PORT`
   entry (i.e. a supervision registry exists — see §4.2 step 4), `resolveAgentsLimits` is consulted
   and, if it resolves, `createAgentsRunCapability(agents, ...)` is **prepended** ahead of the ordered
   list, so the five `agent_*` handlers are matched before any other capability's.
4. **`buildFinalizerSoftBudget`** (`:128-147`, called per-attempt inside `buildSharedInput`): returns
   `[undefined, undefined]` outright when the run is not in soft mode; otherwise it builds a
   `SoftBudget` from the request's `total_token_limit` and the resolved iteration cap, and — only when
   that budget resolves — a `SoftLimitAsk` bound to the run's `elicit` channel, clock and signal. In
   soft mode `deps.elicit` is asserted non-`undefined` (`buildSoftLimitAsk(deps.elicit!, ...)`).

The returned builder dispatches to `buildLeadInput` or `buildSubagentInput` (`:316-318`) — a lead's
persona names its spawnable subagent registry and soft-mode status; a subagent's persona carries the
request's user text as its task body (`subagentTaskBody`, computed once at `:169` from
`userText(request.messages)`, empty for a lead).

### 4.5 `runWithClockAndTimeout` — the timeout/cancel race

`packages/loop/src/runtime/run-timeout.ts:66`. The clock is a **stall** clock, not a wall clock: it
is armed with `config.timeout_ms` (`:78`) and re-armed by `poke()` on every trace entry
(`packages/loop/src/runtime/run-trace.ts:148`). The doc comment at `:44-46` states `timeout_ms` means
"no activity for this long".

| Race winner | Effect | Source |
| --- | --- | --- |
| `"timeout"` | abort the internal controller, wait `settleGraceMs`, return `errorResponse(finalize(), "timeout", "Run stalled: no activity for timeout_ms=…", { elapsed_ms })` | `:102-128` |
| the `externallyAborted` sentinel | wait `settleGraceMs`, return `mapErrorToResponse(externalSignal.reason, finalize(), externalSignal)` — i.e. `cancelled` | `:129-147` |
| the loop's own value | `toResponse(winner, finalize())` | `:148` |
| a thrown error | `mapErrorToResponse(err, finalize(), externalSignal)` | `:149-150` |

If the loop does not settle within the grace, a `run.teardown_detached` warning is logged and the
promise is detached via `suppressSecondaryRejection` (`:105-119`, `:131-145`).
`packages/loop/tests/unit/run-timeout.test.ts:16-38` pins that the outer run resolves with
`{status:"error", error:{code:"timeout"}}` while the loop is still hanging;
`:40-57` pins the same for external cancellation.

`finalize()` is called exactly once on every exit path (`:122,147,149,151`) — the doc comment at
`:59` states this explicitly.

### 4.6 `runAgent` — assembling `LoopDerived`

`packages/loop/src/runtime/loop/run-agent.ts:124`, in order:

1. bind an agent-scoped logger (`:132-135`);
2. create the `LiveContext` from the seed and notify `onContext` (`:137-144`);
3. build convergence guards, arg validator, progress tracker (`:150-162`);
4. **early cancellation probe** — return a cancelled result before anything else (`:194-197`), pinned
   by `packages/loop/tests/unit/run-agent.test.ts:166-176` (`llm.calls` is empty);
5. build `budgetStop`, `onGuardTrip`, `checkpoint` (`:199-274`) — `budgetStop(kind)` fires
   `onBudgetExhausted` with `{ agent, reason: kind, tokensUsed: budget.ledger.consumed(),
   iterationsUsed: budget.counter.count() }` (`:199-210`) before returning the terminal
   `budget_exhausted`/`soft_limit_declined` result;
6. create the steer inbox (`:276`);
7. build the `LoopAgentBuildContext` and `attach` every agent capability, then `foldContributions`
   (`:278-300`);
8. append the hook-driven pre-finalize gate, if any hook owns `preFinalize` (`:301-314`);
9. compute the visible tool list, filtering vision tools for a non-vision target (`:316-328`);
10. build the catch-all MCP handler (`:330-337`);
11. **pre-loop budget check** — `checkLimits`, plus `folded.outputBudget?.remaining() < 1`; record
    `budget_check` and return `budgetStop("exhausted")` (`:339-346`), pinned by
    `packages/loop/tests/unit/run-agent.test.ts:645-669` (fires `onBudgetExhausted` and records
    `budget_check`, with zero model calls);
12. wrap the target's LLM in `withOutputTokenBudget` when a capability contributed one (`:493-502`);
13. call `runAgentLoop`, and close the steer source / compaction source in a `finally` when either
    exists (`:629-634`).

Handler order is `[...folded.handlers, submitHandler?, mcpHandler]` (`:415-419`); `selectHandler`
takes the first match (`packages/loop/src/runtime/loop/loop-contract.ts:84-89`) and `mcpHandler`
matches everything (`packages/loop/src/runtime/loop/mcp-handler.ts:34`), so it is the terminal
fallback by construction.

### 4.7 `runAgentLoop` — one iteration, step by step

`packages/loop/src/runtime/loop/loop.ts:829`. `core.onStart?.()` fires once before the loop (`:838`).

| # | Step | Source | Early exit |
| --- | --- | --- | --- |
| 1 | `beforeIteration?.()` | `:846` | — |
| 2 | `runIterationPreamble` — abort probe, `allToolsUnavailable` probe, compaction thunk, counter+`*_iteration_started` | `packages/loop/src/runtime/loop/loop.ts` (`runAgentLoop`, `runIterationPreamble` call); `packages/loop/src/runtime/loop/loop-iteration.ts` (`runIterationPreamble`) | `cancelled` → `maybeCancelled()!`; `all_tools_unavailable` → `results.allToolsUnavailable()` (`runAgentLoop`, non-proceed branch) |
| 3 | `drainSteer?.(iteration)` | `:864` | — |
| 4 | build the call: `buildModelCall`, `withStreaming`, `takeForcedChoice` | `:866-902` | — |
| 5 | `callModelWithRecovery` | `:903-952` | `OutputBudgetExhaustedError` → `results.budgetExhausted()` (`:948-950`); `!ok` → the cancelled result (`:952`) |
| 6 | `ctx.observeUsage(input_tokens)` and `recordIterationMetrics` | `:954` (observe), `:956-968` (metrics) | — |
| 7 | `classifyResponse` | call site `:970`, function `packages/loop/src/runtime/loop/classify-response.ts:18` | — |
| 8a | `empty` / `reasoning-only` → append reasoning parts, bump streak, nudge, bump progress, checkpoint | `:971-987` | streak ≥ 2 → `results.emptyResponse()`; progress trip → `results.noProgress()`; checkpoint → its result |
| 8b | `text-only` → `finalize.onTextOnly` | `:989-998` | `{kind:"return"}` → its result |
| 8c | `has-tools` → `onAssistantText`, `appendAssistantToolCalls`, `fastAcceptSubmit`, `runDispatch` | `:1000-1013` | fast-accept → its result; dispatch `terminal` → its result |
| 9 | `afterDispatch?.()` | `:1015` | — |
| 10 | soft convergence warnings: one joined runtime note + one trace entry each | `:1017-1037` | — |
| 11 | hard guard trip → `onGuardTrip?`; `"continue"` falls through, `undefined` records `terminate` and returns `results.guardTrip(trip)` | `:1039-1058` | — |
| 12 | fold progress; `progress.bump(productive)` | `:1060-1063` | trip → `results.noProgress()` |
| 13 | `beforeCheckpoint?.()` then `cancelOrCheckpoint` | `:1065-1068` | non-null → its result |
| — | `catch`: `OutputBudgetExhaustedError` → `results.budgetExhausted()`, else rethrow | `:1070-1072` | — |
| — | `finally`: `await d.onTeardown?.()` | `:1073-1075` | — |

Step 2's "compaction thunk" is not a lightweight check: `buildCompactionThunk`
(`packages/loop/src/runtime/loop/loop.ts:242-340`) can itself call `runCompaction`/`attemptCompaction`,
which invoke `target.llm` to summarize the context. It runs after the cancellation and
`allToolsUnavailable` probes (`packages/loop/src/runtime/loop/loop-iteration.ts:42-48`), but before the
iteration's own model call — so a slow or failing compaction summarization is a real model call
subject to the same stall clock as any other, and it can consume the run's inactivity budget before an
ordinary per-iteration model call happens at all this turn. The thunk's own internal policy
(what triggers it, `runCompaction` vs. `attemptCompaction`, fallback behaviour) is owned by
[loop-context-compaction](context-compaction.md) (§7.4); what belongs here is that it is not free and not skipped.

Two ordering facts the code itself calls out:

- The soft-warning note is *joined* rather than appended twice, because `appendRuntimeNote` replaces
  any earlier note of the same kind and the second would delete the first
  (`:1017-1022`).
- A waived guard trip falls **through** to steps 12–13 rather than `continue`-ing, so a waiver does
  not exempt the turn from the no-progress tracker or the budget checkpoint (`:1039-1044`).

### 4.8 Response classification

`classifyResponse` (`packages/loop/src/runtime/loop/classify-response.ts:18-26`), in strict priority
order:

| condition | class |
| --- | --- |
| `toolCalls` non-empty | `has-tools` |
| `text` non-empty | `text-only` |
| `reasoning` non-empty | `reasoning-only` |
| otherwise | `empty` |

Pinned by `packages/loop/tests/unit/classify-response.test.ts:6-29`, including that empty strings and
an empty `toolCalls` array all read as `empty` (`:26-29`).

### 4.9 Empty / reasoning-only streak

State machine over `emptyStreak` (`packages/loop/src/runtime/loop/loop.ts:842,975,988`):

| state | event | next | effect |
| --- | --- | --- | --- |
| `streak = 0` | `empty` or `reasoning-only` | `streak = 1` | append reasoning parts if any (`:971-974`); append the class-specific `empty_response` runtime note (`:977-982`); `progress.bump(false)`; checkpoint; `continue` |
| `streak = 1` | `empty` or `reasoning-only` | terminal | `results.emptyResponse()` → `status: "error"`, code `empty_response` (`:976`, `packages/loop/src/runtime/loop/run-agent.ts:546-554`) |
| any | `text-only` or `has-tools` | `streak = 0` | (`:988`) |

Pinned end-to-end by `packages/loop/tests/integration/empty-response.test.ts:20-35` (two empties →
error), `:67-83` (one empty is nudged and recovers), `:85-113` (reasoning-only is not terminal and
the reasoning parts survive into the next request), `:115-140` (the streak resets). The single-note
property is pinned by `packages/loop/tests/unit/run-agent.test.ts:672-710`.

The error message is `"${agent} returned neither text nor tool calls in consecutive completions."`
with `agent` ∈ `{"LLM","Lead"}` (`packages/loop/src/runtime/loop/loop-shared.ts:100-108`), selected
by `RunAgentInput.emptyResponseAgent`.

### 4.10 Model call and its recoveries

`buildModelCall` (`packages/loop/src/runtime/loop/loop.ts:392-443`) assembles `LLMCallParams`:
tools are withheld as an empty list when the target lacks `tool_calling` (`:398`, `:410`); cache breakpoints come from
`ctx.cacheBreakpoints()` filtered to non-negative indices (`:401-402`, `:409`); `maxOutputTokens`
goes through `clampOutputBudget` (`:413-421`); `onRetry` is attached **unconditionally** and both
pokes the clock and records a durable `model_call_retry` (`:427-440`).

`clampOutputBudget` (`:362-372`, doc at `:342-361`): raise `configured` to `max(configured, floor)`; if
`windowTokens <= 0` return that; else return `max(1, min(floored, floor((windowTokens −
promptTokensEstimate) * 0.9)))`. The doc comment at `:357-360` states the window always wins over
the reasoning floor. Pinned by `packages/loop/tests/component/max-output-tokens-clamp.test.ts:30-56`.

`callModelWithRecovery` (`packages/loop/src/runtime/loop/model-call.ts:84-131`):

| situation | behaviour |
| --- | --- |
| success | `{ ok: true, result }` (`:92`) |
| any throw, run aborted | `{ ok: false, cancelled }` (`:94-95`) |
| `context_overflow` and `overflowRecoveries < 3` and `evict()` returned an event | record `compaction`, increment, `rebuild()` the call, retry (`:96-107`) |
| `context_overflow`, nothing evictable, `overflowDiagnostic` given | synthesize a new `ProviderError` with the diagnostic text, `recordError` it, throw it (`:108-115`) |
| forced tool choice + `client` error | `recordError` the original, retry once with the **unforced** base call (`:117-127`) |
| anything else | `recordError` if it is a `ProviderError`, rethrow (`:128-129`) |

Pinned by `packages/loop/tests/unit/model-call.test.ts:104-167` (forced-choice retry, both errors
recorded, cancellation after retry) and `:170-279` (overflow: eviction retry, raw rethrow without a
diagnostic, the diagnostic path, and the hard stop after `MAX_OVERFLOW_RECOVERIES` with
`llm.calls` of length 8).

`rebuild` exists because `cacheBreakpoints` are *indices* captured before an eviction shifted the
array — the doc comment at `packages/loop/src/runtime/loop/model-call.ts:50-60` spells out the
failure it prevents.

### 4.11 The output-token budget

`withOutputTokenBudget` (`packages/loop/src/runtime/loop/output-budget.ts:65-138`) wraps `llm.call` in
a reservation against a shared `OutputTokenBudget`, and splits into two branches on
`budget.remaining()`:

- **Unbounded** (`remaining === Number.POSITIVE_INFINITY`, `:71-86`): no reservation is taken up
  front — the call runs directly — but the result is still accounted for afterward: on success or on
  a failure carrying `accumulatedUsage`/`partialUsage`, the observed output tokens are reserved and
  immediately settled. This branch is not a pure passthrough: it always touches the shared accounting,
  it simply never blocks on it.
- **Bounded** (`:87-134`): `remaining < 1` throws `OutputBudgetExhaustedError` immediately (`:87`).
  Otherwise `configuredAttempts = (params.maxRetries ?? 0) + 1` and
  `desiredPerAttempt = params.maxOutputTokens ?? remaining` are combined into a requested reservation
  of `min(remaining, desiredPerAttempt * configuredAttempts)` (`:89-95`); a `null` reservation or one
  under 1 token also throws `OutputBudgetExhaustedError` (`:97-100`). The reservation is then divided
  back into `attempts = min(configuredAttempts, floor(reservation.amount))` and
  `perAttempt = min(desiredPerAttempt, floor(reservation.amount / attempts))` (`:102-108`) — so a tiny
  remaining ceiling silently shrinks the number of hidden retries the call is allowed, not just their
  size. The bounded call is always sent with an explicit `maxRetries: attempts - 1` so an inner retry
  decorator cannot apply an unseen default and escape the reservation.

On settle, three outcomes: a failure carrying `accumulatedUsage`/`partialUsage` settles that exact
amount (`:118-124`); `producedNoBillableOutput(err)` — no `streamStarted`, no accumulated/partial
usage — releases the whole reservation (`:125-126`); anything else (output had begun streaming, or the
failure is unclassified) settles the **entire** reservation (`:127-133`), because that is the only way
to keep the shared ceiling hard when no accounting survived the failure.

Pinned by `packages/loop/tests/unit/output-budget.test.ts:52-77` (per-attempt reservation math),
`:78-96` (hidden retries shrink under a tiny remaining ceiling), `:97-122` (attributed streamed
failure, and a later call is rejected once the budget is gone), `:123-141` (full charge on
untrustworthy failure), and `:142-168` (a context-overflow reservation released ahead of the
recovery call).

### 4.12 Tool dispatch within an iteration

`runDispatch` (`packages/loop/src/runtime/loop/loop.ts:656-806`). Full mechanics of *what a tool
does* belong to [loop-tool-dispatch-and-results](tool-dispatch.md); what this document owns is the batch's control flow:

1. pause the compute clock for the whole batch — this agent's own `computeRegion` if it has one,
   else `clock.pauseCompute()` (`:648`), released in `finally` (`:756`);
2. iterate the calls in emission order; break immediately if a terminal was set or the run signal
   aborted (`:651-657`);
3. run `beforeToolUse` hooks; a denial short-circuits that one call with
   `DENIED by a workspace hook: …` and continues the batch (`:660-664`);
4. a rewrite produces a **new** call object carrying `rewrittenFrom`, never a mutation of the one
   already in context; its advisory rendering is capped at 2,000 characters before entering the
   model context (`:445-485`, `:665-675`);
5. `settleOrAbort` the handler against the run signal (`:676-679`): `aborted` → cancelled text and
   break (`:680-685`); `rejected` → `Tool 'X' failed: msg`, warn, continue (`:686-695`);
6. `afterToolUse` hooks fold advisories into a `result` verdict (`:696-700`);
7. verdict routing — `terminal` sets `terminal` and breaks with `terminalCallText` (`:701-705`);
   `cancelled` records the text and only terminates if the run is genuinely cancelled (`:706-714`);
   `deferred` is pushed onto the concurrent list under a batch signal (`:715-740`); plain results are
   stored (`:741-744`);
8. `finally`: abort the batch controller if terminal or the loop broke early, then `settleOrAbort` the
   joined deferreds; an abort here converts to a cancelled terminal (`:748-755`);
9. after the loop, **every** slot is filled — unfilled ones get
   `Tool 'X' was not completed (the dispatch ended before its result).` — spilled if oversize, and
   appended to the context as a tool message (`:759-773`).

`terminalCallText` (`:566-573`) never fabricates a failure: handler-supplied `text` wins, then a
cancellation line, then the error message, then `Tool 'X' result: accepted (the run ended with this
call).` All four branches plus the "was not completed" fill are pinned by
`packages/loop/tests/unit/run-agent.test.ts:594-641`.

The dispatch's tolerance for throwing and rejecting handlers, and the guarantee that every
`tool_call` gets a paired `tool_result`, is pinned by
`packages/loop/tests/unit/run-agent.test.ts:311-409` (`assertNoOrphans`), and the abort boundaries by
`:411-536`.

### 4.13 Finalization

Two paths, chosen by whether `RunAgentInput.contract` is set
(`packages/loop/src/runtime/loop/run-agent.ts:174`).

**With a contract** (`output_schema` present):

- `fastAcceptSubmit` (`:566-580`) accepts only when *all five* conditions hold: exactly one tool call
  (`:567`), it is `submit_result` (`:569`), it validates (`:570-571`), **no** hook owns
  `beforeToolUse` (`:572`), and every gate's `fastAcceptOk?.() ?? true` is true (`:573`). It opens a
  `CallEnvelope`, appends the acceptance as the tool message, and completes (`:574-579`). Each guard
  is pinned: `packages/loop/tests/integration/fast-accept-submit.test.ts:41` (a sibling tool call
  forces the slow path and the sibling actually runs), `:93` (a denying `beforeToolUse` hook is
  honoured), `:127` (the plain single-submit fast path survives).
- otherwise `submitHandler` (`:381-413`) validates, records `lastSubmitAttempt`, and on success runs
  the gates: `terminal` → terminal verdict with the envelope's failure text; `nudge` → a plain result
  carrying the note plus a `noteGateNudged` (`:392-405`).
- `onTextOnly` (`:583-609`) never accepts bare text: it appends the assistant text plus
  `"[runtime: result not yet submitted; call submit_result to finalize]"`, bumps progress, and either
  terminates on `no_progress` (using `textNoSubmitMessage` when supplied) or checkpoints and
  continues. Pinned by `packages/loop/tests/unit/run-agent.test.ts:101-126`.

**Without a contract**: `onTextOnly` (`:610-624`) appends the text, runs the gates, and completes on
`pass`; a `nudge` appends the note, and only an `unbounded` nudge bumps the progress tracker
(`:617-619`).

`runGates` (`packages/loop/src/runtime/loop/loop-contract.ts:103-112`) runs gates in order and
short-circuits on the first non-`pass`, returning the gate's **ordinal** as its only identity — the
doc comment at `:98-101` states the ordinal is stable because gates are folded in capability
registration order.

**Forced tool after a nudge**: `noteGateNudged` sets `forceToolNextIteration` when
`input.forceToolOnNudge === true` (`packages/loop/src/runtime/loop/run-agent.ts:437-446`), and
`takeForcedChoice` consumes it exactly once, returning `"required"` (`:517-529`). The one-shot
property is documented in-source at `:432-434`: leaving the choice forced would stop the model from
ever finishing, since `submit_result` is a tool but a closing summary is not.

### 4.14 Lifecycle-hook sweep machinery

`ObserverMethod` (`packages/loop/src/runtime/loop/lifecycle-hooks.ts:57-63`) enumerates the
fire-and-forget hook methods `fireObservers` dispatches: `onRunStart`, `onRunEnd`,
`onSubagentComplete`, `onModelCallError`, `onBudgetExhausted`, `onUserSteer`. `onPreCompact` is
deliberately **not** a member — it returns contributions, which `fireObservers` discards, so routing
it through this path would silently drop every one; `collectCompactionContributions` is its own
separate sweep (see invariant 66).

`runVerdictHooks` (`:100-147`) sweeps a verdict-returning hook list and short-circuits on the first
`deny`. Its `select` callback's *second* argument carries the arguments an earlier hook in the same
sweep already rewrote (`:90-91`, `:118`), so a later hook rules on what its predecessors actually left,
and the sweep's `VerdictSweep.rewritten` is therefore the **last** writer's value, never accumulated
across hooks. A denial carries no rewritten payload — a call that will not run has no arguments worth
reporting.

`buildPreFinalizeGate` (`:163-209`) builds the `FinalizeGate` that consults every hook's
`preFinalize`. Its fail-closed shape is **not** the same as `beforeToolUse`'s outright denial: a
denied or thrown `preFinalize` hook becomes an **unbounded `nudge`** carrying a
`[runtime: finalize rejected …]` note (`:196-204`) — never a terminal result. The agent is nudged to
try again, not stopped; `fastAcceptOk` reports `true` only when no hook defines `preFinalize` at all
(`:173`).

### 4.15 Steering

`SteerSource` is pull-only. `createSteerInbox` (`packages/loop/src/runtime/loop/steer-inbox.ts:38`)
splits arrival-detection from consumption: `probe()` pulls into a local buffer and reports
non-emptiness without consuming (`:63-66`); `take()` pulls, hands the buffer over and clears it
(`:57-62`); a throwing `drain()` is logged and treated as empty (`:45-53`). The whole surface is
pinned by `packages/loop/tests/unit/steer-inbox.test.ts:27-147`.

`drainSteer` (`packages/loop/src/runtime/loop/run-agent.ts:460-490`) runs at the *top* of an
iteration, after the preamble (`packages/loop/src/runtime/loop/loop.ts:864`). For each message it
appends a user entry, records a `user_steering` trace entry carrying `iteration_ref` and the
flattened text, and fires `onUserSteer` observers; after the batch it calls `progress.reset()`
(`:488`).

`packages/loop/tests/unit/steering.test.ts:122-165` pins that a steer queued *during* iteration N's
dispatch appears in iteration N+1's request and carries `iteration_ref: 2`; `:167-205` pins FIFO
ordering with one event each; `:207-238` pins multimodal content passing through; `:242-278` pins
that the reset buys a redirected run an extra iteration.

`bc.steerProbe` exposes `probe()` to capabilities (`packages/loop/src/runtime/loop/run-agent.ts:293`)
so an interruptible idle can wake on a steer without swallowing it — the module doc at
`packages/loop/src/runtime/loop/steer-inbox.ts:3-15` states this is the whole reason the inbox exists.

### 4.16 Cancellation

Cancellation is cooperative and observed at named probe points; there is no preemption.

| Probe point | Source |
| --- | --- |
| `runAgent` entry, before any work | `packages/loop/src/runtime/loop/run-agent.ts:194-197` |
| iteration preamble | `packages/loop/src/runtime/loop/loop-iteration.ts:42-44` |
| after a model-call throw | `packages/loop/src/runtime/loop/model-call.ts:94-95` |
| before each tool call in a batch | `packages/loop/src/runtime/loop/loop.ts:678-684` |
| when a handler's promise loses to the abort | `packages/loop/src/runtime/loop/loop.ts:703-711` |
| when a handler returns `kind: "cancelled"` | `packages/loop/src/runtime/loop/loop.ts:733-740` |
| when the deferred join loses to the abort | `packages/loop/src/runtime/loop/loop.ts:777-782` |
| before every budget checkpoint | `packages/loop/src/runtime/loop/loop-shared.ts:119-126` |

Every probe funnels through `maybeCancelled` → `checkCancelled`
(`packages/loop/src/runtime/loop/cancellation.ts:60-76`), which records **one** `cancellation` trace
entry as a side effect and reports `true`. `cancellationReason` (`:12-21`) resolves the reason in
three steps: a `reason` object with a string `source` yields that source; a non-empty string reason is
returned verbatim; anything else aborted yields the literal `"cancelled"`. Pinned by
`packages/loop/tests/unit/cancellation.test.ts:10-58`.

A handler returning `kind: "cancelled"` while the run is **not** aborted does not end the run — the
batch continues and the call still gets a paired tool result, pinned by
`packages/loop/tests/unit/run-agent.test.ts:267-308`.

At the run boundary, `executeRun` forwards an external abort with a default reason of
`{ source: "mcp" }` (`packages/loop/src/runtime/execute-run.ts:370`) and handles an
already-aborted signal by aborting immediately (`:373`), pinned by
`packages/loop/tests/component/execute-run.test.ts:164-172`.

### 4.17 Termination catalogue

Every way a run reaches its terminal `RunResponse`:

| Terminal | Where decided | Resulting response |
| --- | --- | --- |
| MCP pool refused to open | `packages/loop/src/runtime/orchestrator.ts:456` | the pool's own response (e.g. `mcp_connection_failed`, `cancelled`) |
| stall timeout | `packages/loop/src/runtime/run-timeout.ts:121-128` | `error` / `timeout`, `details.elapsed_ms` |
| external cancellation wins the race | `packages/loop/src/runtime/run-timeout.ts:147` | `cancelled` |
| thrown error escapes the loop | `packages/loop/src/runtime/run-timeout.ts:151` | mapped per §3.3 |
| pre-loop budget check | `packages/loop/src/runtime/loop/run-agent.ts:339-346` | `budget_exhausted` |
| iteration preamble: all tools unavailable | `packages/loop/src/runtime/loop/loop.ts:860` | `error` / `all_tools_unavailable` |
| iteration preamble: cancelled | `packages/loop/src/runtime/loop/loop.ts:859` | `cancelled` |
| output budget exhausted | `packages/loop/src/runtime/loop/loop.ts:949`, `:1071` | `budget_exhausted` |
| model call cancelled | `packages/loop/src/runtime/loop/loop.ts:952` | `cancelled` |
| empty-response streak | `packages/loop/src/runtime/loop/loop.ts:976` | `error` / `empty_response` |
| no-progress streak | `packages/loop/src/runtime/loop/loop.ts:983`, `:1063` | `error` / `no_progress` |
| finalize accepted (text or structured) | `packages/loop/src/runtime/loop/run-agent.ts:358-367` | `completed` |
| finalize gate returned terminal | `packages/loop/src/runtime/loop/run-agent.ts:396-400`, `:613` | the gate's own result |
| a tool handler returned terminal | `packages/loop/src/runtime/loop/loop.ts:1013` | the handler's result |
| hard guard trip | `packages/loop/src/runtime/loop/loop.ts:1055-1056` | `error` / the guard's code |
| budget checkpoint | `packages/loop/src/runtime/loop/loop.ts:984`, `:1067`; `packages/loop/src/runtime/loop/run-agent.ts:261-274` | `budget_exhausted` or `soft_limit_declined` |

`completed`, `noProgress` and `emptyResponse` each record a `terminate` entry with a reason
(`packages/loop/src/runtime/loop/run-agent.ts:360`, `:349`, `:547`), as does a non-escalated guard trip (`packages/loop/src/runtime/loop/loop.ts:1055`) and
`all_tools_unavailable` (`packages/loop/src/runtime/loop/loop-iteration.ts:46`). `terminate` is not wire-visible
(`packages/trace/src/trace-mapper.ts:507`).

## 5. Invariants

1. **An execution id is reserved for the run's whole duration and released in a `finally`.** A second
   in-flight run with the same `(owner, id)` throws `executionIdConflict` before the first has
   persisted anything. — `packages/loop/src/runtime/execute-run.ts:130-147` (doc at `:121-129`), released at `:501`. The
   *persisted*-collision half is pinned by `packages/loop/tests/component/execute-run.test.ts:53-63`;
   the in-flight half is **unpinned**.
2. **A run whose shape requires a human refuses to start without an `elicit` channel.** —
   `packages/loop/src/runtime/execute-run.ts:303-310`. Test:
   `packages/loop/tests/component/execute-run.test.ts:74-83`.
3. **`continue_from` naming a run with no restorable `final_context` throws
   `ContinuationUnavailableError`, and the lookup is owner-scoped.** —
   `packages/loop/src/runtime/execute-run.ts:347-351`. Tests:
   `packages/loop/tests/integration/continuation.test.ts:191`, `:198`, `:212`.
4. **A failed `traceStore.insert` becomes `PersistenceError`, except a `ConflictError`, which is
   rethrown as-is.** — `packages/loop/src/runtime/execute-run.ts:436-452`. Tests:
   `packages/loop/tests/component/execute-run.test.ts:65-72`, `:139-147`, `:149-157`.
5. **The journal is discarded only after a successful insert, and closed on every path.** —
   `packages/loop/src/runtime/execute-run.ts:435`, `:498`. Tests:
   `packages/loop/tests/integration/journal-durability.test.ts:85-91` (no journal left behind) and
   `:93-128` (the journal's events equal the persisted record's events exactly).
6. **A capability's `finalizeRun` failure or hang costs it its state slot and nothing else.** Each
   call is bounded by `CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` and both timeout and throw are logged
   and coerced to `undefined`. — `packages/loop/src/runtime/execute-run.ts:202-244`. Tests:
   `packages/loop/tests/unit/capability-state.test.ts:57-72` (throw), `:74-97` (hang).
7. **A continued run's prior `capability_state` is carried forward for any capability that did not
   run this turn; this turn's value replaces it for one that did.** —
   `packages/loop/src/runtime/execute-run.ts:219,261`. Tests:
   `packages/loop/tests/unit/capability-state.test.ts:99-106`, `:108-113`.
8. **`onRunEnd` runs after the record is persisted, never blocks the response beyond its budget, and
   a throwing or rejecting `onRunEnd` is warned and ignored.** —
   `packages/loop/src/runtime/execute-run.ts:454-493`. Tests:
   `packages/loop/tests/integration/host-capability.test.ts:213-226` (a rejecting and a throwing
   `onRunEnd` both log `capability_run_end_failed` with their messages while the run still
   `completed`s) and `:228-237` (an `onRunEnd` that outlives
   `CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` logs `capability_run_end_timeout` and the run still
   `completed`s).
9. **A capability's `forRun` is invoked even when the run's signal is already aborted**, with the
   admission class switched to `"run_end"`. — `packages/loop/src/runtime/orchestrator.ts:245-263`,
   the class chosen at `:252`. Test:
   `packages/loop/tests/integration/host-capability.test.ts:311-329` (an already-`AbortSignal.abort`ed
   run still activates the capability, whose `onRunEnd` observes the `cancelled` record) — the test
   pins the outcome, not the `"run_end"` admission-class switch by name.
10. **`forRun` and `seedBlock` are each bounded by `CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS`; a timeout
    costs the capability its contribution, not the run.** —
    `packages/loop/src/runtime/orchestrator.ts:248-263` and `:312-320`, warned at `:277-287`,
    `:321-331`. Tests: `packages/loop/tests/integration/host-capability.test.ts:274-283` (a `forRun`
    that never settles is skipped without delaying an activated sibling capability) and `:295-309`
    (a `seedBlock` that never settles is omitted and the run still completes).
11. **`seedMarker`s are collected from every *registered* capability, while `seedBlock`s come only
    from the *activated* ones.** — `packages/loop/src/runtime/orchestrator.ts:336-338` versus
    `:307-335`. The consequence is stated in-source at
    `packages/loop/src/runtime/entry-seed.ts:44-47`: an unrecognised block accumulates a fresh copy
    every turn. **Unpinned at the orchestrator level**; the seed-side effect is pinned by
    `packages/loop/tests/unit/entry-seed-markers.test.ts:118-136`.
12. **`init` is recorded before `run_started`, and `run_ended` is recorded before the trace is
    sealed — so `run_ended` is always the last persisted event.** —
    `packages/loop/src/runtime/orchestrator.ts:375-376`, `:400`, `:415`; sealing makes later
    `record`/`signal` calls no-ops (`packages/trace/src/in-memory-trace.ts:49,55`). Tests:
    `packages/loop/tests/integration/orchestrator.test.ts:76` (`init` first in the in-memory trace),
    `packages/loop/tests/integration/run-lifecycle-events.test.ts:53-56` (exactly one `run_started`
    first and one `run_ended` last, persisted).
13. **`init` and `terminate` are never wire-visible.** —
    `packages/trace/src/trace-mapper.ts:506-512`. Test:
    `packages/loop/tests/integration/run-lifecycle-events.test.ts:55` depends on it (it asserts
    `run_started` is index 0 of the persisted events).
14. **The trace bridge maps each entry at most once and hands the identical object to the journal and
    to `emitEvent`; the journal receives durable entries only; the clock is poked even for a
    live-only entry with no sink wired.** — `packages/loop/src/runtime/run-trace.ts:149,163-168`.
    Tests: `packages/loop/tests/unit/run-trace.test.ts:149-160`, `:169-179`, `:181-195`, `:197-206`.
15. **A throwing `ingest` or `emitEvent` consumer never reaches the run.** —
    `packages/loop/src/runtime/run-trace.ts:149-161`, `:167-178`. Tests:
    `packages/loop/tests/unit/run-trace.test.ts:95-112`, `:114-128`, `:130-139`.
16. **A throwing `onCapabilityEvent` listener never reaches the run or the emitting capability.** —
    `packages/loop/src/runtime/execute-run.ts:360-366`. **Unpinned.**
17. **MCP leases are released on every exit path from the entry agent.** —
    `packages/loop/src/runtime/orchestrator.ts:480-482`. Pinned indirectly by
    `packages/loop/tests/integration/connection-leak.test.ts`.
18. **`finalize()` (the usage snapshot) is called exactly once per run, on every exit path.** —
    `packages/loop/src/runtime/run-timeout.ts:122,147,149,151`; documented at `:59`. **Unpinned.**
19. **The run timeout measures inactivity, not wall time: it is re-armed by every trace entry.** —
    `packages/loop/src/runtime/run-timeout.ts:78` arms it, `packages/loop/src/runtime/run-trace.ts:148`
    pokes it. Tests: `packages/loop/tests/integration/orchestrator.test.ts:263-282` (a hung model call
    times out), `packages/loop/tests/integration/retry-pokes-stall-clock.test.ts:14` (a transient
    failure's retry refills the watchdog).
20. **A loop that ignores its abort cannot pin the outer run beyond `settleGraceMs`; it is detached
    with its rejection still observed.** — `packages/loop/src/runtime/run-timeout.ts:105-120`,
    `:131-146`, `suppressSecondaryRejection` at `:116`, `:142`. Tests:
    `packages/loop/tests/unit/run-timeout.test.ts:16-38` (timeout), `:40-57` (external cancellation).
21. **A cancelled run is reported as `cancelled` whatever error was thrown.** —
    `packages/loop/src/runtime/run-response-mapping.ts:47-49`. Test:
    `packages/loop/tests/unit/run-response-mapping.test.ts:48-57`; also
    `packages/loop/tests/integration/orchestrator.test.ts:367` (a cancellation during a compaction
    summary maps to `cancelled`, not `provider_error`).
22. **Every error message and every `details` payload on a run response is sanitized before it
    leaves.** — `packages/loop/src/runtime/run-response-mapping.ts:54,62-63,69`. Test:
    `packages/loop/tests/unit/run-response-mapping.test.ts:61-81` (nested details redacted, and the
    caller's own object left unmutated at `:80`).
23. **Two consecutive empty-or-reasoning-only completions end the agent; one does not.** —
    `packages/loop/src/runtime/loop/loop.ts:230`, `:975-976`. Tests:
    `packages/loop/tests/integration/empty-response.test.ts:20-35`, `:67-83`, `:85-113`, `:115-140`.
24. **The empty-response nudge is a *replaceable* runtime note: a second empty replaces the first
    rather than accumulating.** — `ctx.appendRuntimeNote("empty_response", …)` at
    `packages/loop/src/runtime/loop/loop.ts:977-982`. Test:
    `packages/loop/tests/unit/run-agent.test.ts:672-710`.
25. **A reasoning-only completion's `reasoningParts` are appended to the context before the nudge, so
    provider continuation state survives.** — `packages/loop/src/runtime/loop/loop.ts:971-974`. Test:
    `packages/loop/tests/integration/empty-response.test.ts:105-112`.
26. **Both soft convergence warnings of one iteration are joined into a single runtime note.** —
    `packages/loop/src/runtime/loop/loop.ts:1023-1037`, with the reason stated at `:1017-1022`.
    ~~**Unpinned** by any test naming this behaviour.~~ **Pinned 2026-08-22**:
    `packages/loop/tests/integration/convergence-warning-join.test.ts`. Making both guards warn in
    one iteration is the hard part and is not incidental — the stagnation guard ignores errors
    outright and any success clears the doom guard's counters, so it takes one batch holding a
    repeated *failing* call beside a repeatedly-identical *successful* one.
27. **A waived guard trip does not skip the no-progress tracker or the budget checkpoint.** —
    `packages/loop/src/runtime/loop/loop.ts:1045-1058` falls through to `:1060-1068`; reason stated at
    `:1039-1044`. Related tests live in
    `packages/loop/tests/integration/guard-escalation.test.ts` (guard escalation is owned by
    [loop-budgets-clocks-and-guards](budgets-and-guards.md)).
28. **An escalation that returns a result of its own does *not* record a `terminate` reason; only a
    genuine guard termination does.** — `packages/loop/src/runtime/loop/loop.ts:1055`, reason stated
    at `:1049-1054`. ~~**Unpinned.**~~ **Pinned 2026-08-22**:
    `packages/loop/tests/component/guard-trip-terminate.test.ts`, with both controls — a declining
    escalation and no escalation at all both *do* record it.
29. **`fastAcceptSubmit` is refused whenever anything downstream could have ruled on the call**: a
    multi-call batch, a non-`submit_result` call, an invalid payload, any `beforeToolUse` hook, or any
    gate that does not opt in. — `packages/loop/src/runtime/loop/run-agent.ts:566-573`. Tests:
    `packages/loop/tests/integration/fast-accept-submit.test.ts:41`, `:93`, `:127`.
30. **A forced tool choice after a nudge is consumed exactly once.** —
    `packages/loop/src/runtime/loop/run-agent.ts:517-528`; reason stated at `:432-434`.
    ~~**Unpinned.**~~ **Pinned 2026-08-22**: `packages/loop/tests/component/lifecycle-finalize-wiring.test.ts`.
    The existing `force_tool_on_nudge` tests showed the flag being *set*; their scripts ended on the
    forced call, so a `takeForcedChoice` that never cleared it kept them green while every later
    iteration was silently forced. The third iteration is reached by having the forced call name a
    tool the registry does not carry.
31. **A rewritten tool call is a new object; the assistant message already in context is never
    mutated.** — `packages/loop/src/runtime/loop/loop.ts:692-702`. **Unpinned** at this line (the
    hook-dialect side is owned by [hooks-execution](../execution/hooks.md)).
32. **Every tool call in a batch gets exactly one tool result appended, including calls the batch
    never reached.** — `packages/loop/src/runtime/loop/loop.ts:786-800`. Tests:
    `packages/loop/tests/unit/run-agent.test.ts:320-332` (`assertNoOrphans`), `:334-368`, `:370-408`,
    `:632-641`.
33. **A terminal verdict never fabricates a failure line for the call that produced it.** —
    `packages/loop/src/runtime/loop/loop.ts:582-599`. Tests:
    `packages/loop/tests/unit/run-agent.test.ts:594-630`.
34. **The compute clock is paused for the whole tool-dispatch batch and released in a `finally`,
    using this agent's own background region when it has one.** —
    `packages/loop/src/runtime/loop/loop.ts:675`, `:775-784`; the rationale for the region is stated at
    `packages/loop/src/runtime/loop/loop.ts:126-134`. **Unpinned** at this line;
    `packages/capability/tests/unit/compute-clock.test.ts` owns the clock's own truth table.
35. **`onTeardown` fires on every exit path from the iteration loop and is awaited.** —
    `packages/loop/src/runtime/loop/loop.ts:1073-1075`. ~~**Unpinned.**~~ **Pinned 2026-08-22**:
    `packages/loop/tests/component/lifecycle-finalize-wiring.test.ts` — a completed run, a
    no-progress termination, and a provider throwing out of the loop, each asserting the count is
    exactly one, plus that an async teardown has settled before the run returns.
36. **A steer is delivered exactly once, on the iteration after it was queued, and resets the
    no-progress streak.** — `packages/loop/src/runtime/loop/run-agent.ts:460-490` (drain at
    `packages/loop/src/runtime/loop/loop.ts:864`, i.e. after the preamble). Tests:
    `packages/loop/tests/unit/steering.test.ts:122-165`, `:242-278`.
37. **`probe()` does not consume; a throwing steer source is treated as empty.** —
    `packages/loop/src/runtime/loop/steer-inbox.ts:45-53,63-66`. Tests:
    `packages/loop/tests/unit/steer-inbox.test.ts:38-52`, `:65-81`, `:83-94`.
38. **The steer and compaction sources are closed when the agent's loop settles, and only when one of
    them exists.** — `packages/loop/src/runtime/loop/run-agent.ts:629-634`. **Unpinned.**
39. **One `cancellation` trace entry per detection, not one per probe.** —
    `packages/loop/src/runtime/loop/cancellation.ts:60-76` records only when it returns `true`, and
    each probe site returns immediately on a hit. Test:
    `packages/loop/tests/unit/run-agent.test.ts:178-216` asserts exactly one `cancellation` entry.
40. **The agent's pre-loop budget check runs before any model call and mirrors the checkpoint exit
    path** — it records `budget_check` and fires `onBudgetExhausted`. —
    `packages/loop/src/runtime/loop/run-agent.ts:339-346`, `:199-217`. Tests:
    `packages/loop/tests/unit/run-agent.test.ts:645-669`, and `:93-99` for the zero-model-call
    property.
41. **The window clamp is the outermost step of the output budget: a reasoning floor can never push
    `maxOutputTokens` above the remaining window.** —
    `packages/loop/src/runtime/loop/loop.ts:368-371`, reason stated at `:357-360`. Test:
    `packages/loop/tests/component/max-output-tokens-clamp.test.ts:30-42`.
42. **A call that provably generated no billable output releases its whole reservation; a call that
    had begun streaming is charged in full.** — `packages/loop/src/runtime/loop/output-budget.ts:49-56`
    (`producedNoBillableOutput` requires `!streamStarted` **and** no `accumulatedUsage` **and** no
    `partialUsage`), applied at `:125-133`. Test: `packages/loop/tests/unit/output-budget.test.ts:51`.
43. **`onRetry` is attached to every model call regardless of whether the run has a clock, and both
    pokes the clock and records a durable `model_call_retry`.** —
    `packages/loop/src/runtime/loop/loop.ts:427-440`, reason stated at `:385-390`.
    Tests: `packages/loop/tests/integration/model-retry-visibility.test.ts:33-62`,
    `packages/loop/tests/integration/retry-pokes-stall-clock.test.ts:14`.
44. **A retried attempt's tokens are charged to the ledger and the run totals, but are deliberately
    excluded from the recorded iteration event.** —
    `packages/loop/src/runtime/loop/iteration-metrics.ts:177-196`, reason stated at `:153-161`. Tests:
    `packages/loop/tests/unit/iteration-metrics.test.ts:153-176` (charged), `:177-195` (event
    unchanged).
45. **Context overflow is recovered at most `MAX_OVERFLOW_RECOVERIES` (3) times per model call, and
    the call is rebuilt after each eviction.** —
    `packages/loop/src/runtime/loop/model-call.ts:99-106`, `MAX_OVERFLOW_RECOVERIES` at
    `packages/loop/src/runtime/loop/loop-iteration.ts:7`. Tests:
    `packages/loop/tests/unit/model-call.test.ts:171-186`, `:262-279`.
46. **`evict` is invoked on a `context_overflow` error and on nothing else**, which is what makes the
    compaction-reach watch's observation meaningful. —
    `packages/loop/src/runtime/loop/model-call.ts:96-101`, stated at `:41-44`; the observer is wired at
    `packages/loop/src/runtime/loop/loop.ts:908-912`. **Unpinned** as a negative.
47. **`compaction.unreachable` is reported at most once per agent loop, only when compaction is
    enabled, and only when the refused prompt was *smaller* than the compaction high-water mark.**
    `observeOverflow` returns immediately, without reporting, when `!config.enabled` — the same
    early-return that also makes a second observation in the same loop a no-op. —
    `packages/loop/src/runtime/loop/compaction-reach.ts:51-68`, the `!config.enabled` short-circuit at
    `:53`. **Unpinned.**
48. **The prompt-cache prefix watch compares `cached_tokens` against the *previous iteration's*
    `cached_tokens`, tolerates a 10% loss, and does not latch for the run.** —
    `packages/loop/src/runtime/loop/iteration-metrics.ts:105-123`, reasoning at `:74-103`. Tests:
    `packages/loop/tests/integration/cache-prefix-capture.test.ts`,
    `packages/loop/tests/unit/prefix-break.test.ts`.
49. **`cacheReadRatio`'s denominator is `input_tokens` alone.** —
    `packages/loop/src/runtime/loop/iteration-metrics.ts:138-140`, reason stated at `:131-136`. Tests:
    `packages/loop/tests/unit/iteration-metrics.test.ts:15-46`.
50. **A restored volatile entry (canonical block or runtime note) is never carried into a
    continuation's seed.** — `packages/loop/src/runtime/entry-seed.ts:70-72,157`. Test:
    `packages/loop/tests/unit/entry-seed-markers.test.ts:153-170`.
51. **A seed block the continuation already carries is kept verbatim and the freshly rendered copy is
    dropped; a newly active capability's block is appended *after* the restored history.** —
    `packages/loop/src/runtime/entry-seed.ts:162-179`. Tests:
    `packages/loop/tests/unit/entry-seed-markers.test.ts:99-116`, `:138-151`, and the prefix property
    at `:176-197`.
52. **A block whose capability is no longer active is dropped from the continuation.** —
    `packages/loop/src/runtime/entry-seed.ts:158-159`. Test:
    `packages/loop/tests/unit/entry-seed-markers.test.ts:118-136`.
53. **A continuation's restored transcript is reproduced byte-identically under a fresh system
    head.** — `packages/loop/src/runtime/entry-seed.ts:174-179`. Tests:
    `packages/loop/tests/integration/continuation.test.ts:77-108` (the middle slice equals
    `final_context.map(e => e.message)`), `:110-137` (a profile switch swaps only the system head).
54. **`final_context` excludes the system head and is captured even on a non-`completed` exit.** —
    `packages/loop/src/runtime/orchestrator.ts` (`runEntryAgent` installs the `onContext` snapshot
    reader and returns it after the loop settles). Tests:
    `packages/loop/tests/integration/final-context-capture.test.ts:45-84`, `:86-114`.
55. **`final_context` is attached only when non-empty**, so a run that produced nothing leaves the
    field absent. — `packages/loop/src/runtime/orchestrator.ts:653`. **Unpinned** as a negative.
56. **A run with no MCP servers left usable short-circuits before the entry agent runs and reuses the
    pool's own response.** — `packages/loop/src/runtime/orchestrator.ts:456`. Tests:
    `packages/loop/tests/integration/orchestrator.test.ts:857`, `:883`, `:912`.
57. **The entry iteration cap depends on role and budget mode: a hard-mode lead is uncapped
    (`POSITIVE_INFINITY`), a soft-mode lead mirrors the configured limit, and a sub-agent uses
    `resolveIterationCap`.** — `packages/loop/src/runtime/orchestrator.ts:586-590`. **Partially
    pinned**: `packages/loop/tests/integration/soft-default-iteration-limit.test.ts:34` pins that a
    soft-mode run "asks at the default iteration limit instead of running unbounded", and
    `packages/loop/tests/integration/orchestrator.test.ts:606`, `:631` pin the soft-mode lead's own
    prompt text. No test pins the hard-mode lead's `POSITIVE_INFINITY` branch directly.
58. **`resolveConfig` carries no iteration bound at all, and bounds tokens only under
    `on_exceed: "stop"`.** — `packages/loop/src/runtime/run-shape.ts:20-29`. **Unpinned** directly;
    the consequence is visible in `deriveRunStartedDetail`'s finite-only emission
    (`packages/loop/src/runtime/run-trace.ts:78`) and in
    `packages/loop/tests/integration/run-lifecycle-events.test.ts`.
59. **The prompt-cache key defaults to the execution id, and the TTL to `1h` when a human park is
    likely, `5m` otherwise.** — `packages/loop/src/runtime/execute-run.ts:343-344`;
    `humanParkLikely` is derived at `packages/loop/src/validation/request/run-shape.ts:28`. The
    defaults are applied only where the call did not already set them
    (`packages/llm/src/prompt-cache-provider.ts:36-39`). **Unpinned** at the `executeRun` level.
60. **A supervision registry exists only for a run that can actually spawn children.** —
    `packages/loop/src/runtime/orchestrator.ts:204-212`, `packages/loop/src/runtime/spawn-shape.ts:18-29`.
    Test: `packages/loop/tests/unit/spawn-shape.test.ts`.
61. **The MCP catch-all handler is last in the handler list, so every capability handler shadows
    it.** — `packages/loop/src/runtime/loop/run-agent.ts:415-419`;
    `packages/loop/src/runtime/loop/mcp-handler.ts:34` matches everything;
    `selectHandler` takes the first match
    (`packages/loop/src/runtime/loop/loop-contract.ts:88`). **Unpinned** as an ordering rule at these
    lines.
62. **`runGates` short-circuits on the first non-`pass` and identifies the gate by ordinal only.** —
    `packages/loop/src/runtime/loop/loop-contract.ts:103-112`. **Unpinned.**
63. **`onPreCompact` is structurally excluded from the observer dispatch path**, because
    `fireObservers` discards return values and `ObserverMethod` omits it. —
    `packages/loop/src/runtime/loop/lifecycle-hooks.ts:57-63`, reason stated at `:50-55`. **Unpinned**
    (it is a compile-time guarantee).
64. **Every lifecycle-hook invocation is wall-bounded — 5s for observers and verdict sweeps, 30s for
    gate hooks — and a hung hook is detached.** —
    `packages/loop/src/runtime/loop/lifecycle-hooks.ts:16,17,27-44`. Tests:
    `packages/loop/tests/unit/lifecycle-hooks.test.ts:102-113`, `:236`.
65. **`beforeToolUse` fails closed (a throwing hook denies) and `afterToolUse` fails open (a throwing
    hook leaves the result unmodified).** —
    `packages/loop/src/runtime/loop/loop.ts:519` (`onThrow: "deny"`) versus `:565` (`onThrow: "ignore"`). Test:
    `packages/loop/tests/unit/lifecycle-hooks.test.ts:45-113` for the sweep semantics.
66. **`collectCompactionContributions` always fails open.** —
    `packages/loop/src/runtime/loop/lifecycle-hooks.ts:328-338`, reason stated at `:257-263`. Test:
    `packages/loop/tests/unit/compaction-contributions.test.ts`.
67. **`run.composed` is emitted once per run, at `info`, listing capabilities in activation order.** —
    `packages/loop/src/runtime/orchestrator.ts:502-532`, reason stated in the doc block at `:485-501`. Tests:
    `packages/loop/tests/integration/run-observability.test.ts:26-55` (exactly one line, correct
    fields), `:58-72` (run correlation on every line), `:101` (silent at a level that discards it),
    `:117` (the run works with no logger at all).
68. **The run-scoped logger is `undefined` — not a no-op object — when the host wired none.** —
    `packages/loop/src/runtime/execute-run.ts:336-339`, reason stated at `:328-334`. Test:
    `packages/loop/tests/integration/run-observability.test.ts:117`.
69. **`toLlmTarget` omits an undefined optional field from the built `LlmTarget` rather than copying
    it through as `undefined`.** — `packages/loop/src/runtime/loop/loop-shared.ts:56-71` (`LlmTarget`
    itself at `:30-43`). Test:
    `packages/loop/tests/unit/loop-shared.test.ts:7-18` (`"reasoningEffort" in withoutEffort ===
    false`).
70. **`EngineTerminalVerdict`/`EngineHandlerVerdict` widen the capability `HandlerVerdict` one way
    only: every verdict a capability produces satisfies the engine type, but only a handler the
    engine itself builds populates the terminal `text`.** —
    `packages/loop/src/runtime/loop/loop-contract.ts:39-74`. **Unpinned** as a type-level guarantee;
    its behavioural consequence is invariant 33.
71. **A hook-rewritten argument envelope contributes at most 2,000 rendered argument characters to
    the model's permanent context; the trace retains the untruncated executed arguments.** —
    Production: `packages/loop/src/runtime/loop/loop.ts:445-485`. Test:
    `packages/loop/tests/unit/tool-hooks.test.ts` ("bounds rewritten arguments before appending them
    to the model context").

## 6. Failure modes and degradation

| Failure | Handling | Cite |
| --- | --- | --- |
| Invalid request body | `validateBody` throws before anything is reserved or recorded | `packages/loop/src/runtime/execute-run.ts:296` |
| Duplicate persisted execution id | `ConflictError` thrown before the run starts | `packages/loop/src/runtime/execute-run.ts:318-320` |
| Duplicate in-flight execution id | `executionIdConflict` from the reservation | `packages/loop/src/runtime/execute-run.ts:141` |
| Missing `elicit` for a human-needing run | `ValidationError("elicitation_not_supported")` | `packages/loop/src/runtime/execute-run.ts:304-309` |
| Unavailable continuation | `ContinuationUnavailableError` | `packages/loop/src/runtime/execute-run.ts:350` |
| Persist failure | `run.persist_failed` logged with status and iterations, then `PersistenceError` | `packages/loop/src/runtime/execute-run.ts:440-451` |
| Extension gate saturated at activation | `capability.extension_saturated` warned; the capability contributes nothing | `packages/loop/src/runtime/orchestrator.ts:264-275` |
| `forRun` / `seedBlock` timeout | `capability.setup_timeout` warned with `phase`; contribution dropped | `packages/loop/src/runtime/orchestrator.ts:277-287`, `:321-331` |
| `finalizeRun` timeout / throw | `capability.finalize_timeout` / `capability.finalize_failed` warned; slot omitted | `packages/loop/src/runtime/execute-run.ts:218-239` |
| `onRunEnd` throw / rejection | `capability.run_end_failed` warned; run unaffected | `packages/loop/src/runtime/execute-run.ts:459-481` |
| `onRunEnd` work exceeds its budget | `capability.run_end_timeout` warned; the work continues detached | `packages/loop/src/runtime/execute-run.ts:484-492`, `raceWithBudget` at `:160-175` |
| Some MCP servers unreachable | `mcp_degraded` recorded; the run continues | `packages/loop/src/runtime/orchestrator.ts:458-460` |
| All MCP servers unreachable at open | the pool's failure response is returned without running the agent | `packages/loop/src/runtime/orchestrator.ts:456` |
| All tools become unavailable mid-run | `terminate{reason:"all_tools_unavailable"}` then `error`/`all_tools_unavailable` | `packages/loop/src/runtime/loop/loop-iteration.ts:45-48`, `packages/loop/src/runtime/loop/run-agent.ts:536-544` |
| Provider `context_overflow` | evict-and-retry up to 3×; then a legible diagnostic `ProviderError` | `packages/loop/src/runtime/loop/model-call.ts:96-115` |
| Forced tool choice rejected as `client` | one silent retry without the forcing | `packages/loop/src/runtime/loop/model-call.ts:117-127` |
| Provider transient failure | retried by the provider layer; each retry recorded as `model_call_retry` and pokes the clock | `packages/loop/src/runtime/loop/loop.ts:427-440` |
| Any provider error reaching the loop | `model_call_error` recorded with `kind`/`status`/`retry_after_ms`/`usage_attributed`, message sanitized; `onModelCallError` observers fired | `packages/loop/src/runtime/loop/iteration-metrics.ts:314-336`, `packages/loop/src/runtime/loop/loop.ts:919-946` |
| Output budget exhausted before or during a call | `OutputBudgetExhaustedError` → `budget_exhausted` | `packages/loop/src/runtime/loop/output-budget.ts:87,99`; caught at `packages/loop/src/runtime/loop/loop.ts:948-950`, `:1070-1072` |
| Tool handler throws | converted to `Tool 'X' failed: msg`; `tool.handler_failed` warned; batch continues | `packages/loop/src/runtime/loop/loop.ts:713-721` |
| Deferred handler rejects | same, via `tool.deferred_handler_failed` | `packages/loop/src/runtime/loop/loop.ts:742-765` |
| Deferred still pending at cancellation | detached, but its later rejection is still observed | `packages/loop/src/runtime/loop/loop.ts:775-782`, `settleOrAbort` at `:613-635`. Test: `packages/loop/tests/unit/run-agent.test.ts:458-536` |
| Steer source `drain()` throws | `steer.drain_failed` warned; treated as empty | `packages/loop/src/runtime/loop/steer-inbox.ts:45-53` |
| Trace `ingest` throws | `trace.ingest_failed` warned; entry dropped from the registry only | `packages/loop/src/runtime/run-trace.ts:149-161` |
| `onEvent` throws | `trace.emit_failed` warned; event dropped | `packages/loop/src/runtime/run-trace.ts:167-178` |
| Capability event listener throws | swallowed silently | `packages/loop/src/runtime/execute-run.ts:361-365` |
| Loop stalls | `error`/`timeout` with `details.elapsed_ms` | `packages/loop/src/runtime/run-timeout.ts:121-128` |
| Loop refuses to unwind after abort | `run.teardown_detached` warned; the outer run proceeds | `packages/loop/src/runtime/run-timeout.ts:106-120`, `:132-146` |
| Declared context window wider than the model's real one | `compaction.unreachable` warned once per agent loop | `packages/loop/src/runtime/loop/compaction-reach.ts:56-67` |
| Prompt-cache prefix collapses | `iteration.cache` escalated from `debug` to `warn` | `packages/loop/src/runtime/loop/iteration-metrics.ts:232-251` |

**What fails hard**: only the five throws from `executeRun` (`ValidationError`, two `ConflictError`
paths, `ContinuationUnavailableError`, `PersistenceError`) — every other failure becomes a terminal
`RunResponse` or a degraded-but-continuing run. A `ProviderError` that reaches
`runWithClockAndTimeout` is caught and mapped (`packages/loop/src/runtime/run-timeout.ts:150-151`); it does not escape
`executeRun`. `packages/loop/tests/integration/unexpected-throw-envelope.test.ts` exercises the
catch-all envelope.

## 7. Coupling

### 7.1 What this subsystem depends on

| Dependency | Edge | Forced by |
| --- | --- | --- |
| `@clarvis/capability` | runtime + type | value imports of `sanitizeErrorMessage`, `bind`, `unref`, `composeCapabilityRegistry`, `createCapabilityRequestView`, `createComputeClock`, `ProviderError`, `CodedError`, `foldContributions`, `openCallEnvelope`, `partialStructOf`, `parseModelRef`, `reasoningOutputFloor`, `contentToText`, `levelEnabled`, `NOOP_LOGGER`, `createExtensionAdmissionController` — `packages/loop/src/runtime/execute-run.ts:1,12,26,38,44`; `packages/loop/src/runtime/orchestrator.ts:3,45,46,68`; `packages/loop/src/runtime/loop/loop.ts:1,14`; `packages/loop/src/runtime/loop/run-agent.ts:2,21,35`; `packages/loop/src/runtime/run-timeout.ts:1,4` |
| `@clarvis/trace` | runtime | `generateExecutionId`, `mapTrace`, `buildRecord`, `createTrace`, `mapEntry` — `packages/loop/src/runtime/execute-run.ts:17-19`; `packages/loop/src/runtime/orchestrator.ts:22`; `packages/loop/src/runtime/run-trace.ts:7` |
| `@clarvis/llm` | runtime | `withPromptCacheDefaults` — `packages/loop/src/runtime/execute-run.ts:4` |
| `@clarvis/mcp-client` | type-only here | `import type { ConnectionManager }` (`packages/loop/src/runtime/execute-run.ts:5`), `import { type OpenedConnection }` (`packages/loop/src/runtime/orchestrator.ts:18`); the actual pool work is in `open-tool-pool.ts` |
| `@clarvis/supervision` | runtime | `AGENT_REGISTRY_PORT`, `createAgentRegistry`, `resolveAgentsLimits` — `packages/loop/src/runtime/orchestrator.ts:29-30`; `packages/loop/src/runtime/entry-inputs.ts:43` |
| `node:crypto` | runtime | `randomUUID` for the sub-agent instance id — `packages/loop/src/runtime/entry-inputs.ts:1` |

### 7.2 What depends on this subsystem

| Consumer | Edge | Cite |
| --- | --- | --- |
| `@clarvis/kernel`'s run service | calls `executeRun` | `packages/kernel/src/runs/run-service.ts:111` |
| `@clarvis/kernel`'s workflows service | calls `executeRun` for a leader | `packages/kernel/src/workflows/workflows-service.ts:492` |
| `@clarvis/memory`'s indexer | calls `executeRun` for an indexing pass | `packages/memory/src/indexer/run.ts:190` |
| `@clarvis/workflows` | receives `executeRun` through a port on `WorkflowCtx` rather than importing the engine | `packages/workflows/src/types.ts:71` (`executeRun(args: ExecuteRunArgs): Promise<ExecuteRunOutcome>`), used at `packages/workflows/src/run-leader.ts:93` |

The `@clarvis/workflows` edge is the one worth naming: it is a **structural inversion**. The type is
declared on `WorkflowCtx` and the function is supplied by the host, so `workflows` never imports
`loop`'s runtime — which is what keeps the dependency graph acyclic while a leader is a full
`executeRun`.

### 7.3 Internal edges within `@clarvis/loop`

- `execute-run.ts → orchestrator.ts` (`:14`) — the only call site of `runOrchestrator`.
- `orchestrator.ts → run-agent.ts` (`:24`, called at `:656`), `entry-seed.ts` (`:26`),
  `entry-inputs.ts` (`:50`), `run-shape.ts` (`:53`), `run-response-mapping.ts` (`:54`),
  `run-trace.ts` (`:55-61`), `run-timeout.ts` (`:62`), `vision-prepass.ts` (`:63`),
  `open-tool-pool.ts` (`:52`), `capability-order.ts` (`:47`), `capability-tool-metadata.ts` (`:48`).
- `run-agent.ts → loop.ts` (`:18`) — `runAgentLoop` is called from exactly one place (`:503`).
- `run-subagent.ts → run-agent.ts` — the second caller of `runAgent`
  (`packages/loop/src/runtime/subagents/run-subagent.ts:161`), which is what makes `runAgent` the
  shared agent driver rather than an entry-agent-only path. Owned by [loop-delegation-and-subagents](delegation-and-subagents.md).
- `loop/index.ts` re-exports `cancellation`, `iteration-metrics`, `loop-iteration`, `loop-shared`
  and `run-agent` — but **not** `loop.ts`, `model-call.ts`, `steer-inbox.ts`, `progress.ts`,
  `classify-response.ts`, `output-budget.ts` or `compaction-reach.ts`
  (`packages/loop/src/runtime/loop/index.ts:6-10`).
- `runtime/support/*` is the runtime's cross-cutting utility layer, and its barrel is the one in the
  package that re-exports a whole *dependency*. Beside `bounded`, `concurrency`, `run-response`,
  `signals` and `stringify` it carries a bare `export * from "@clarvis/capability"`
  (`packages/loop/src/runtime/support/index.ts:10`), because the pausable compute clock was extracted
  to that package and no local module defines it any more
  (`packages/loop/src/runtime/support/index.ts:1-8`; `createComputeClock` is
  `packages/capability/src/index.ts:56`). `concurrency.ts` is the same move one file down — ten lines
  re-exporting `createSemaphore` so that "`./support` and every direct importer keep one import path"
  (`packages/loop/src/runtime/support/concurrency.ts:4-10`). Nothing under any `src/` imports the
  barrel: production code names the file it wants
  (`packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts:6` for `safeStringify`,
  `packages/loop/src/host.ts:64` for `boundPromise`), and its importers are unit tests
  (`packages/loop/tests/unit/stringify.test.ts:2`,
  `packages/loop/tests/unit/ask-user-tool.test.ts:12`). The five modules themselves are owned
  elsewhere — `bounded.ts` by [elicitation-and-user-interaction](../cross-cutting/elicitation.md),
  `concurrency.ts` and `signals.ts` by [loop-delegation-and-subagents](delegation-and-subagents.md),
  `stringify.ts` by [loop-tool-dispatch-and-results](tool-dispatch.md) — and only `run-response.ts`
  belongs here, as `errorResponse` (§3.2).

### 7.4 Delegated scope

| Concern | Owning document |
| --- | --- |
| `LiveContext`, compaction selection/rewrite, `buildCompactionThunk`'s policy internals | [loop-context-compaction](context-compaction.md) |
| `TokenLedger`, `IterationCounter`, `runBudgetCheckpoint`, `SoftBudget`, `ComputeClock` arithmetic, `ConvergenceGuards`, guard escalation | [loop-budgets-clocks-and-guards](budgets-and-guards.md) |
| What a tool call does — the MCP registry, `executeMcpToolCall`, `openToolPool`, the result contract | [loop-tool-dispatch-and-results](tool-dispatch.md) |
| `delegate_task`, `run-subagent`, the five `agent_*` tools, the supervision registry | [loop-delegation-and-subagents](delegation-and-subagents.md), [supervision-registry](../foundations/supervision.md) |
| `foldContributions`, `capabilitiesForScope`, `orderCapabilities`, `buildExecuteRunDeps` | [loop-capability-composition](capability-composition.md) |
| Why appending is free and rewriting is not; the seed's prefix arithmetic | [prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md) |
| The elicit relay, `withElicitWaitBound`, the soft-limit ask | [elicitation-and-user-interaction](../cross-cutting/elicitation.md) |
| `runVisionPrepass` | [vision-prepass-and-image-routing](vision-routing.md) |
| Request validation and settings schemas | [loop-request-and-settings-schema](request-and-settings-schema.md) |
| The journal's on-disk format and `recoverOrphans` | [trace-recording-and-persistence](../foundations/trace.md) |

## 8. Open questions

1. ~~**Why the run shape is derived twice.**~~ **Resolved.** These are two different functions sharing
   one exported name across two modules, not one computation done twice for no reason, and a data
   constraint makes calling the heavier one from `executeRun` impossible.

   `execute-run.ts:13` imports `deriveRunShape` from `../validation/request-schema.ts` — a
   **validation-layer** function returning only `{ entry, isLead, userInputEnabled, askUserGranted,
   softMode }`. `orchestrator.ts:53` imports a **different** `deriveRunShape`, from `./run-shape.ts`,
   returning the full `RunShape` (`entryResolved`, `spawnableRegistry`, `fullRegistry`,
   `primarySubagentModel`, …) — and that richer function's own body (`run-shape.ts:68-79`) calls the
   validation-layer one *again* internally, aliased as `deriveRequestShape` (`run-shape.ts:4`), to get
   the same `{ entry, isLead, … }` shape before building the rest of `RunShape` around it. So the
   validation-layer computation — including its `requiresUserInput` sweep over
   `allCapabilities` — genuinely runs twice per request that goes through `executeRun`: once directly
   (`execute-run.ts:315-319`), once indirectly inside `orchestrator.ts`'s call to the full
   `deriveRunShape` (`orchestrator.ts:213-217` → `run-shape.ts:74`). Both sweeps read the same
   `requestView` object (`execute-run.ts` passes its own `requestView` through as
   `OrchestratorDeps.requestView`, and `orchestrator.ts:212` reuses it — `deps.requestView ??
   createCapabilityRequestView(request)` — rather than recreating it), so the two sweeps' *inputs* are
   identical; only a capability whose `requiresUserInput` reads something besides `requestView` (or is
   otherwise impure) could see the two calls disagree.

   `executeRun` cannot call the full, `run-shape.ts` version of `deriveRunShape` in its place: that
   function requires a `SubagentProfileRegistry` as its second argument (`run-shape.ts:69-72`), and
   `execute-run.ts` never builds one — `resolveSubagentProfiles` is called only inside
   `runOrchestrator` (`orchestrator.ts:207`), after `execute-run.ts`'s own check has already run. This
   is a genuine data-availability constraint, not a style choice: the lighter function is the *only*
   one `execute-run.ts` has the inputs to call.

   Conversely, `runOrchestrator` cannot simply accept an injected `shape` and skip its own derivation:
   `OrchestratorDeps` has no such field, and three test files
   (`packages/loop/tests/integration/orchestrator.test.ts`,
   `packages/loop/tests/integration/soft-default-iteration-limit.test.ts`,
   `packages/loop/tests/component/lifecycle-observers-wiring.test.ts`) call `runOrchestrator` directly,
   bypassing `execute-run.ts` entirely — so `runOrchestrator` must always be able to derive its own
   full shape from just a `RunRequest` and `OrchestratorDeps`, regardless of caller.

   Finally, the double sweep is inert even if a capability's `requiresUserInput` **were** impure:
   `execute-run.ts`'s own (first) `shape` is consumed only by the `elicitation_not_supported` fail-fast
   throw (`:320-325`) and to compute `runMode` (`:320`), which is used solely as a `logger` binding
   field (`:357`, `mode: runMode`) — never anything that reaches the model or governs dispatch. The
   run's actual behaviour is driven entirely by `orchestrator.ts`'s own (second, authoritative) shape;
   a divergence could at most skew that one log field, never execution.
2. **The in-flight execution-id reservation has no test.** `reserveExecutionId`
   (`packages/loop/src/runtime/execute-run.ts:130`) exists specifically for the window before a trace is written
   (`:122-125`), yet `packages/loop/tests/component/execute-run.test.ts` only covers the persisted
   collision. Nothing pins the concurrent case.
3. **`raceWithBudget`'s timer semantics vs. detached work.** The doc comment states work that outlives
   the budget "is not cancelled — it simply stops being waited on" (`packages/loop/src/runtime/execute-run.ts:157-159`), but
   nothing in the code says what should happen to such work if the process exits; the timer being
   `unref`'d (`:168`) means a pending budget never keeps the process alive, which is the only stated
   guarantee.
4. **`MAX_CONSECUTIVE_EMPTY_RESPONSES = 2` and the `CACHE_PREFIX_LOSS = 0.1` tolerance** are bare
   constants (`packages/loop/src/runtime/loop/loop.ts:230`, `packages/loop/src/runtime/loop/iteration-metrics.ts:68`). The latter carries a stated *purpose*
   ("absorbs the block rounding every provider reports in", `packages/loop/src/runtime/loop/iteration-metrics.ts:94-96`) but not a
   derivation for the specific figure.
5. **Whether `computeRegion` is ever set for the entry agent.** `LoopCore.computeRegion`
   (`packages/loop/src/runtime/loop/loop.ts:126-134`) is documented as "Present only for a child spawned in the background", and
   `createEntryInput` never sets it (`packages/loop/src/runtime/entry-inputs.ts:236-273`). Confirming that only the delegation
   path populates it requires reading [loop-delegation-and-subagents](delegation-and-subagents.md)' sources.
6. **`LoopDerived.beforeCheckpoint` has exactly one producer** —
    `RunAgentInput.buildBeforeCheckpoint` (`packages/loop/src/runtime/loop/run-agent.ts:81`, invoked at `:456-458`) — and no caller
    inside the files in this document's scope supplies it. Which capability or persona builds it is outside
    this document.
7. **The `interrupted` status is unreachable from this subsystem.**
    `packages/capability/src/execution-status.ts:11` states it is produced only by
    `TraceStore.recoverOrphans`. `loopResultToResponse` has no arm for it
    (`packages/loop/src/runtime/run-response-mapping.ts:94-113`), so a record carrying it can only come from the journal
    recovery path owned by [trace-recording-and-persistence](../foundations/trace.md).
8. ~~**No test names the joined-convergence-warning rule, the one-shot forced choice, the
    `onTeardown` guarantee, or the escalation's `terminate` suppression** (invariants 26, 28, 30, 35).
    Each is asserted only by an in-source comment. These are the highest-value gaps in this document's
    test coverage.~~ **Resolved 2026-08-22.** All four now carry tests; see the invariants themselves
    for where. Two were harder to reach than the claim suggests, and the difficulty is the finding:

    - **26** needs both guards warning in the *same* iteration, which a batch of only-failing or
      only-succeeding calls can never produce — the stagnation guard returns early on any error, and
      any success clears the doom guard's counters. It takes a batch holding a repeated failing call
      beside a repeatedly-identical successful one. Reverting the join shows exactly the predicted
      damage: the doom warning disappears and only the stagnation one reaches the model.
    - **28** is reached only when the escalation is *cancelled mid-prompt* — the one branch where
      `onGuardTrip` answers with an `AgentResult` instead of `undefined`. An ask that declines, and no
      ask at all, both still record `terminate`, and both are asserted beside it.
