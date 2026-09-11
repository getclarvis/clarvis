# The run host, kernel run client and the session/activity stores

> Implemented at `packages/code/src/`. Every claim below is anchored to a file and a named symbol or test. Open
> questions are collected in the final section.

## 1. Purpose

`packages/code/src/run-host.ts` is the stateful bridge between a UI shell and the kernel's run stream.
It owns the in-flight `RunHandle`, the active `Session`, the status line, terminal attention cues, the
resident-turn window over the transcript, and the derived workflow projection. Its constructor
`createRunHost` (`packages/code/src/run-host.ts`) returns a `RunHost`
(`packages/code/src/run-host.ts`) whose members every shell surface — the composer, the footer,
the sidebar, the export command — drives.

Below it sit two families of module. One is the *backend adapter*:
`packages/code/src/adapters/kernel-run-client.ts` wraps a `KernelClient` (`@clarvis/protocol`) and
presents `startRun → RunHandle`, `steer`, `compact`, `getRun`, `deleteRun`, `listProfiles`, plus thin
pass-throughs for the remaining kernel services (`packages/code/src/adapters/kernel-run-client.ts`).
`packages/code/src/adapters/workspace-client-manager.ts` sits under *that*, owning the process's one
connection to its independently hosted workspace kernel. `open` accepts only that workspace and
returns a no-op `release`; `close` releases the connection. `recover` authenticates a replacement
connection without restarting the host. `invalidate` asks the host to accept a quiescent restart
before releasing the previous connection (`WorkspaceClientManager`). The other family is the *projection
stores*: `adapters/store.ts` (the reactive transcript), `adapters/activity-store.ts` (subagents, plan,
usage, context), `adapters/session.ts` + `adapters/session-store.ts` (turn history and its persistence
through `SessionService`), plus small leaves — `run-reducers.ts`, `run-types.ts`, `active-agent.ts`,
`connection-state.ts`, `stream-metrics.ts`, `memory-pressure.ts`, `execution-safety.ts`,
`file-prompt-history.ts`.

This document owns **when** live events, the result envelope and stored reconciliation reach those
stores. It does not decide when a rendered candidate becomes immutable or where live motion belongs:
that publication/layout contract is
[code-transcript-stability.md](code-transcript-stability.md). `onEvent` applies the transcript and
activity sinks inside one Solid batch. `runManaged` releases interactive ownership, fetches and
reconciles the stored run, then closes publication through `TranscriptRunSink.complete`; a failed
stored read or exceptional settlement supplies an explicit degraded completion instead of leaving
the terminal batch pending. Session restore closes each replayed sink through the same boundary.

The recurring problem the code solves is **ownership across asynchrony**. A run's events, its
`done` envelope, its stream close, its persisted trace, its post-run memory-ingest notice, a user's
`^C`, a session switch and a backend reconnect all arrive on independent schedules. Nearly every guard
in `run-host.ts` is an identity check — an execution id, a session object, an epoch counter — deciding
whether a late callback still owns the surface it wants to write to
(`packages/code/src/run-host.ts`).

## 2. Surface

### Hosted backend adapter

`KernelRunClient.hosting` exposes the connected service only when the kernel provides it.
`startRun` then requires `StartRunInput.session` with the persisted id/revision, turn kind and preview;
it calls `hosting.start` exactly once. Missing session metadata cannot fall back to ordinary
`runs.start`. `attachRun` names an existing execution/generation and never submits a prompt. A client
cannot attach twice to the same currently observed execution.

The adapter applies `redactPreview` with a 4096-character bound to the hosted `user_preview` only.
The full `params.messages` remains unchanged, including large pasted corpora. Production:
[`createKernelRunClient`](../../packages/code/src/adapters/kernel-run-client.ts). Test:
`long hosted prompts bound only the preview and preserve the complete model message` in
[`kernel-run-client.test.ts`](../../packages/code/tests/component/kernel-run-client.test.ts).

The adapter replays the immutable prefix with `source: replay`, then consumes the live tail with
`source: live`, preserving the execution id throughout. Historical events do not trigger live progress
or memory-ingest notices. Observer attachments do not display or answer interactive questions.
Hosted `done` waits for snapshot/tail delivery, physical closure, host reconciliation, terminal
index commit and admission release. A successfully consumed controlled result is acknowledged and
its observation released before the TUI reports readiness. Observer-only, abandoned or failed
observations do not acknowledge the result; acknowledgement failure rejects readiness. Disconnect or malformed observation rejects that promise
and `closed` instead of fabricating a failed execution result. Observation release follows closure
or observation failure; semantic stream end alone cannot release a still-closing host observation.

Active hosted steering and explicit compaction use the attached handle's controller epoch. Mechanical
target compaction is currently refused while such a handle is active; idle compaction uses the ordinary
service under host maintenance admission. `RunHost` uses a local session presentation shadow for
hosted turns and adopts canonical revisions after reconciliation. Background commands and startup
discovery enter through the application feature composition; their product contract is in
[hosted runs](hosted-runs.md#code-integration).

Production: `startRun`, `attachRun`, `hostedHandle` and `driveHandle` in
[kernel-run-client.ts](../../packages/code/src/adapters/kernel-run-client.ts), using
`readHostedSnapshot` from [hosted-snapshot.ts](../../packages/kernel/src/transport/hosted-snapshot.ts).
Test: the hosted admission, observer attach, connection-loss and missing-revision cases in
[kernel-run-client.test.ts](../../packages/code/tests/component/kernel-run-client.test.ts).

`SessionMeta.revision` round-trips through the protocol DTO. `SessionStore.load(id, { refresh: true })`
waits for that id's write lane and replaces even a full cached document with the canonical read.
A `versioned` store confirms each successful save with a read of exactly the next revision before
advancing its cache and a same-base queued local snapshot. It never rebases a rejected/uncertain
write on a different client's revision. Any failed versioned write stops queued/future writes and
makes `flushPending` reject until the store is recreated; read-only refresh remains available.
The ordinary store keeps its existing optimistic behavior. Production composition selects versioned
mode only when it adopts hosted conversations.

Production: `SessionMeta`, `metaToSession`, `sessionToMeta` and `createSessionStore` in
[session-store.ts](../../packages/code/src/adapters/session-store.ts). Test: hosted revision round trip,
confirmed queued revision advancement, uncertainty without replay and canonical terminal refresh in
[session-store.test.ts](../../packages/code/tests/component/session-store.test.ts).

Configuration authorization uses a volatile identity associated with the current `Session` object.
`createRunHost` passes it as `configurationSessionId`; `toStartParams` maps it to the protocol's
`configuration_session_id`. Neither metadata nor trace continuations store it. A resumed session
gets a fresh identity, while successive turns in the same live object reuse it. The existing
standalone skill path invokes `/clarvis-configure` and renders its host elicitation.
For that reserved native route, the kernel exposes the leaf execution as one standalone lead and
omits its synthetic delegation lifecycle. Its `configure_clarvis` operations consequently follow
the ordinary lead tool publication path in both the live stream and stored reconciliation, rather
than disappearing into a subagent section. Code derives the row label and scoped authored path from
the safe operation/root/path projection; configuration content and CAS/edit material do not cross
that presentation boundary.
Production: `configurationSessions` in [run-host.ts](../../packages/code/src/run-host.ts),
`toStartParams` in [kernel-run-client.ts](../../packages/code/src/adapters/kernel-run-client.ts), and
the native projection in [map-events.ts](../../packages/kernel/src/runs/map-events.ts) and
[map-result.ts](../../packages/kernel/src/runs/map-result.ts).
Test: `configuration consent identity lives only in the open TUI session, never in resume` in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts). Native admission and
file authority and its live/replay projection are owned by
[self-configuration.md](self-configuration.md).

### 2.1 `RunHost` (`packages/code/src/run-host.ts`)

The background list offers explicit recovery archival for an old unknown execution. The operator
must verify physical work stopped before confirming the displayed generation and execution. A late
confirmation after view disposal is ignored. Only a matching durable recovery response permits
discovery acknowledgement. The canonical session preserves its recovery audit and remains archived
against new inference; no execution is replayed. Production: `BackgroundView` and
`createBackgroundListController` in [view.tsx](../../packages/code/src/features/background/view.tsx)
and [controller.ts](../../packages/code/src/features/background/controller.ts). Test:
[background-list-controller.test.ts](../../packages/code/tests/unit/background-list-controller.test.ts)
and [background-controller.test.ts](../../packages/code/tests/unit/background-controller.test.ts).
The host contract is [explicit operator recovery](hosted-runs.md#explicit-operator-recovery).
`resumeSessionById` also refuses an archived canonical session after its discovery entry has been
acknowledged, preserving the history without treating it as a fresh inference context. Production:
[run-host.ts](../../packages/code/src/run-host.ts). Test:
`an acknowledged recovery archive cannot resume inference through its saved session` in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

`backgroundCurrentRun` retains an uncertain handoff's operation identity for receipt lookup.
Only a matching `HostedHandoffFailureDetails` pre-admission refusal clears the attempt for a new
mutation after its cause is resolved. Production: `backgroundCurrentRun` in
[run-host.ts](../../packages/code/src/run-host.ts). Test: definite refusal, uncertain conflict and
lost-reply recovery in [run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

`attachHostedRun` routes explicit acquisition/takeover of the current observed execution to that
handle's `acquireControl`, preserving its session, transcript and stream. `driveHandle` wires
elicitation once after confirmed acquisition; `createHostedObservationLease` reads its updated
interactive disposition before acknowledging a consumed result.
Production: [run-host.ts](../../packages/code/src/run-host.ts),
[kernel-run-client.ts](../../packages/code/src/adapters/kernel-run-client.ts) and
[hosted-observation.ts](../../packages/code/src/adapters/hosted-observation.ts).
Test: takeover without reattachment and observer-to-controller result consumption in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts) and
[kernel-run-client.test.ts](../../packages/code/tests/component/kernel-run-client.test.ts).

| Member | Signature | File |
| --- | --- | --- |
| `runActive` | `Accessor<boolean>` — true only while the current run accepts interactive control; post-run stream delivery does not keep it true | `packages/code/src/run-host.ts` (`RunHost`, `runManaged`) |
| `continuesOnExit` | `Accessor<boolean>` — the active observed run has confirmed host `continue` policy; later admissions reset the projection | `packages/code/src/run-host.ts` (`RunHost`, `runManaged`, `attachHostedRun`) |
| `bashActive` | `Accessor<boolean>` | `packages/code/src/run-host.ts` |
| `compactionActive` | `Accessor<boolean>` — live compaction pipeline state | `packages/code/src/run-host.ts` (`RunHost`) |
| `physicalWorkActive` | `Accessor<boolean>` — remains true until every run handle and local command settles | `packages/code/src/run-host.ts` (`RunHost`) |
| `memory()` | `Record<string, number \| boolean>` — host-owned sampled-memory counters | `packages/code/src/run-host.ts` (`RunHost`) |
| `runStatus` / `setRunStatus` | `Accessor<string>` / `Setter<string>` | `packages/code/src/run-host.ts` |
| `runStartedAt` | `Accessor<number \| null>` — current *or last* run's start, `null` before any | `packages/code/src/run-host.ts` |
| `sessionUsageBaseline` | `Accessor<SessionTotals \| null>` — full persisted totals frozen immediately before the active run | `packages/code/src/run-host.ts` (`RunHost`, `runManaged`) |
| `workflowActivity` | `Accessor<WorkflowActivity \| null>` — current or last workflow's tree | `packages/code/src/run-host.ts` |
| `ownsExecution` | `(executionId: string) => boolean` | `packages/code/src/run-host.ts` |
| `onEvent` | `(event: RunEvent, source: EventSource, executionId?: string) => void` | `packages/code/src/run-host.ts` |
| `onMemoryIngest` | `(notice: MemoryIngestNotice) => void` | `packages/code/src/run-host.ts` |
| `cancelCurrentRun` | `() => boolean` — whether the keypress was consumed | `packages/code/src/run-host.ts` |
| `compactCurrentRun` | `(request?: string) => Promise<void>` | `packages/code/src/run-host.ts` |
| `inspectCurrentContext` | `(targetWindowTokens: number) => ReturnType<KernelRunClient["context"]> \| null` | `packages/code/src/run-host.ts` (`RunHost`) |
| `fitCurrentContext` | `(targetWindowTokens: number) => Promise<CompactResult \| null>` | `packages/code/src/run-host.ts` (`RunHost`) |
| `teardownRuns` | `() => void` | `packages/code/src/run-host.ts` |
| `submitTurn` | `(content: MessageContent, display?: string) => Promise<void>` | `packages/code/src/run-host.ts` |
| `scheduledBinding` | `(materialize?: boolean) => LoopBinding \| null`; captures live conversation/configuration identity without a model call | [run-host.ts](../../packages/code/src/run-host.ts) |
| `submitScheduledTurn` | `(request: ScheduledTurnRequest) => ScheduledTurnAdmission`; reserves synchronously and never steers | [run-host.ts](../../packages/code/src/run-host.ts) |
| `scheduledBusy` | `Accessor<boolean>`; includes human preparation, reservations, session loading, reconciliation, physical handles, bash and outstanding compaction | [run-host.ts](../../packages/code/src/run-host.ts) |
| `submitPromptTurn` | `(messages, display?, skill?: {name, task?, plansMode?}) => void` | `packages/code/src/run-host.ts` |
| `submitSkillRun` | `(name, task, agent) => Promise<void>` | `packages/code/src/run-host.ts` |
| `workOnTask` | `(ref: TaskRefDto, profile: string) => Promise<void>`; `profile` is an Agent Profile id | `packages/code/src/run-host.ts` |
| `runBangCommand` | `(cmd: string) => boolean` — whether the command was accepted | `packages/code/src/run-host.ts` |
| `stopLocalWork` | `() => Promise<void>` — abort and await the TUI's shell, observation persistence and activity release before disconnect | `packages/code/src/run-host.ts` |
| `clearSession` | `(opts?: { flush?: boolean }) => void` | `packages/code/src/run-host.ts` |
| `loadSessionMeta` | `(meta: SessionMeta) => Promise<void>` | `packages/code/src/run-host.ts` |
| `resumeSessionById` | `(id: SessionId) => Promise<void>` | `packages/code/src/run-host.ts` |
| `exportNodeBatches` | `() => AsyncIterable<readonly TranscriptNode[]>` | `packages/code/src/run-host.ts` |
| `sessionMeta` / `setSessionProfile` / `flushSession` | session accessors | `packages/code/src/run-host.ts` |
| `registerDraftRestore` | `(fn: (text, content?) => void) => void` | `packages/code/src/run-host.ts` |

The public `submitTurn` declares **two** parameters; the implementation takes a third `skill`
argument (`packages/code/src/run-host.ts`) reachable only through `submitPromptTurn`
(`packages/code/src/run-host.ts`).

Exported constants: `RESIDENT_TRANSCRIPT_TURN_LIMIT = 20` (`packages/code/src/run-host.ts`).
Module-private: `EXPORT_BATCH_NODE_LIMIT = 128` and `EXPORT_INCOMPLETE_PREFIX`.

### 2.2 `RunHostDeps` (`packages/code/src/run-host.ts`)

| Field | Type | Required | File |
| --- | --- | --- | --- |
| `store` | `TranscriptStore` | yes | `packages/code/src/run-host.ts` |
| `activity` | `ActivityStore` | yes | `packages/code/src/run-host.ts` |
| `sessionStore` | `SessionStore` | yes | `packages/code/src/run-host.ts` |
| `history` | `PromptHistory` | yes | `packages/code/src/run-host.ts` |
| `client` | `Pick<KernelRunClient, "startRun"\|"steer"\|"compact"\|"getRun"\|"files"> & Partial<Pick<KernelRunClient, "context"\|"currentExtensionProfile">>` | yes | `packages/code/src/run-host.ts` |
| `elicit` | `Pick<ElicitSlot, "cancelPending">` | yes | `packages/code/src/run-host.ts` |
| `owner` / `project` / `workspaceId` / `workspace` | `string` | yes | `packages/code/src/run-host.ts` |
| `priceFor` | `(model) => CatalogCost \| undefined` | yes | `packages/code/src/run-host.ts` |
| `activeProfile` / `setActiveProfile` | agent selection | yes | `packages/code/src/run-host.ts` |
| `guardMode` / `judgePayload` / `memoryMode` | run policy | yes | `packages/code/src/run-host.ts` |
| `executionConfiguration` | fingerprint and readable effective model label | no | [run-host.ts](../../packages/code/src/run-host.ts) |
| `scheduledBlockedReason` / `onSessionInvalidated` | current execution health and registration invalidation ports | no | [run-host.ts](../../packages/code/src/run-host.ts) |
| `plansMode` | `() => PlanMode` | no | `packages/code/src/run-host.ts` |
| `planProviderKey` | `() => string \| undefined` | no | `packages/code/src/run-host.ts` |
| `isManagerProfile` | `() => boolean` — the `workflow` grant | no | `packages/code/src/run-host.ts` |
| `attention` | `Pick<Attention, "notify"\|"setTitle"\|"away">` | no | `packages/code/src/run-host.ts` |
| `runBash` | `typeof runLocalBash` — tests only | no | `packages/code/src/run-host.ts` |
| `presentStatus` | `(line: StatusLine) => string` | no | `packages/code/src/run-host.ts` |
| `describeToolCall` | `TranscriptStoreDeps["describeToolCall"]` | no | `packages/code/src/run-host.ts` |

`isManagerProfile`'s own TSDoc states its scope precisely: it drives only local UI (arming
the workflow-tree projection) and keeps the manager on the full-message path; "routing itself is the
kernel's decision by grant, not a client toggle" — the flag never causes `code` to route a run as a
workflow, it only tracks that the kernel already will.

Defaults applied at construction: `runBash ?? runLocalBash` and
`presentStatus ?? plainStatusLine`.

### 2.3 `KernelRunClient` (`packages/code/src/adapters/kernel-run-client.ts`)

Constructed by `createKernelRunClient(deps: KernelRunClientDeps)`
(`packages/code/src/adapters/kernel-run-client.ts`). Deps: `createKernel: () => Promise<KernelClient>`,
optional `prepareReconnect`, and `callbacks`.

| Member | Kind | File |
| --- | --- | --- |
| `project` / `workspace` | getters that throw when disconnected | impl |
| `capabilities` | getter, survives a reconnect window | impl |
| `connect` / `reconnect` / `dispose` | lifecycle | impl |
| `listProfiles(prefetched?)` | `Promise<ProfileInfo[]>` | impl |
| `startRun(input: StartRunInput)` | `RunHandle` (synchronous) | impl |
| `steer({executionId, message, profile?})` | `Promise<SteerResult>` | impl |
| `compact({executionId, request?, mechanicalTargetTokens?})` | `Promise<CompactResult>` | `packages/code/src/adapters/kernel-run-client.ts` (`KernelRunClient.compact`) |
| `context(executionId, targetWindowTokens?)` | `ReturnType<RunService["context"]>` | `packages/code/src/adapters/kernel-run-client.ts` (`KernelRunClient.context`) |
| `getRun(executionId)` | `Promise<RunDetail \| null>` | impl |
| `deleteRun(executionId)` | `Promise<boolean>` | impl |
| `plans` | current-plan `read` only; no retained-plan administration | `packages/code/src/adapters/kernel-run-client.ts` (`KernelRunClient.plans`, `plans`) |
| `workflows` `skills` `config` `secrets` `models` `providerAuth` `files` `sessions` `plugins` `extensionProfiles` `tasks` `storage` | thin per-method pass-throughs to `requireKernel()` | `packages/code/src/adapters/kernel-run-client.ts` (`createKernelRunClient`) |
| `currentExtensionProfile()` | the process-pinned `{id, fingerprint}` captured during `connect()` and refreshed after idle trust recomposition | `packages/code/src/adapters/kernel-run-client.ts` (`connect`, `mutateTrust`, `currentExtensionProfile`) |

`KernelRunClientCallbacks` : `onEvent(event, source, executionId)`, optional
`onProgress(progress, executionId)`, `onMemoryIngest(notice)`, `onElicit(params) => Promise<ElicitResult>`.

### 2.4 Other exported surfaces in scope

| Module | Exports | File |
| --- | --- | --- |
| `adapters/run-types.ts` | `ProfileInfo`, `StartRunInput`, `RunHandle`, `SteerResult`, `CompactResult`; re-exports `MemoryIngestNotice`, `RunProgress` from `core/run-types.ts` | — |
| `adapters/run-reducers.ts` | `subagentCompletedOk`, `iterationTokens`, `SubagentRegistry`, `createSubagentRegistry`; re-exports `PlanTaskActivity` | — |
| `adapters/activity-store.ts` | `ActivityStore`, `createActivityStore`, `UsageActivity`, `ContextActivity`, `SubagentStatus`, `ACTIVITY_SUBAGENT_SUMMARY_MAX_CHARS` (512), `ACTIVITY_SUBAGENT_SUMMARIES_MAX` (64) | — |
| `adapters/session.ts` | `Session`, `SessionDeps`, `SessionInit`, `createSession`, `isContinuationUnavailable`, `buildSkillRunDigest`, `buildRecoveredContext`, `ResumedSession`, `ResumeDeps`, `ResumeOptions`, `resumeSession`, `deleteSession`, `SESSION_RESUME_MAX_PAYLOAD_CHARS` | — |
| `adapters/session-store.ts` | `SessionId`, `NodeStatus`, `SessionTotals`, `TurnRef`, `SessionMeta`, `runStatusToNode`, `uuidv7`, `redactPreview`, `TURN_ERROR_MAX_CHARS` (2000), `redactTurnError`, `addUsageToTotals`, `uncachedInput`, `formatCostUsd`, `SessionStore`, `MAX_RESIDENT_FULL_SESSIONS` (8), `listSessionsForWorkspace`, `metaToSession`, `sessionToMeta`, `sessionSummaryToMeta`, `sessionTurnCount`, `loadSessions`, `createSessionStore` | `packages/code/src/adapters/session-store.ts` |
| `adapters/active-agent.ts` | `ActiveAgentStore`, `ActiveAgentDeps`, `AutomaticAgentCandidate`, `automaticAgentFallback`, `createActiveAgentStore` | `packages/code/src/adapters/session-store.ts` |
| `adapters/connection-state.ts` | `ConnectionState`, `ConnectionStore`, `createConnectionState`, `connectionLabel`, `connectionProbe` | `packages/code/src/adapters/session-store.ts` |
| `adapters/stream-metrics.ts` | `StreamMetrics`, `createStreamMetrics`, `streamMetrics` | `packages/code/src/adapters/session-store.ts` |
| `adapters/memory-pressure.ts` | `MIB`, `DEFAULT_TUI_RSS_LIMIT_BYTES`, `MEMORY_PRESSURE_SAMPLE_MS`, `MEMORY_PRESSURE_ABORT_GRACE_MS`, `MEMORY_PRESSURE_RECOVERY_TIMEOUT_MS`, `MemoryPressurePhase`, `ProcessMemorySample`, `MemoryPressureSnapshot`, `MemoryRecoveryResult`, `MemoryPressureDeps`, `MemoryPressureController`, `memoryPressureAllowsSlash`, `tuiRssLimitBytes`, `createMemoryPressureController` | `packages/code/src/adapters/session-store.ts` |
| `adapters/execution-safety.ts` | `IsolationMode`, `RunControlsState`, `MemoryState`, `PlanMode`, `PlanRetention`, `PlansState`, `planRetentionLabel`, `plansState`, `modelResolves`, `memoryState`, `deriveIsolation`, `deriveRunControls`, `safetyDescription`, `memoryDescription`, `planRetentionDescription` | symbols of the same names |
| `adapters/file-prompt-history.ts` | `createFilePromptHistory(limit = 200, file = workspaceStatePaths().promptHistoryFile, options)` | `packages/code/src/adapters/session-store.ts` |
| `adapters/workspace-client-manager.ts` | `ManagedWorkspaceClient`, `WorkspaceClientOptions`, `WorkspaceClientManager` | symbols of the same names |
| `adapters/kernel-errors.ts` | `hasKernelErrorCode(error, code): error is {code}` — the narrowing every kernel-error branch in this scope goes through | `packages/code/src/adapters/kernel-errors.ts` |

`hasKernelErrorCode` narrows **structurally** (`typeof error === "object" && error !== null && "code" in
error && (error as { code?: unknown }).code === code`, `packages/code/src/adapters/kernel-errors.ts`)
rather than by `instanceof` against a concrete `KernelError` class, which is what lets it classify a
transported error too: `KernelRunClient.getRun`/`.deleteRun` apply it to whatever the
current `KernelClient` throws, and `packages/code/tests/component/kernel-run-client.test.ts`
constructs the failure as a plain `Object.assign(new Error(...), { code: "not_found" })` — named
"transported `not_found` errors are classified structurally" — precisely because a remote kernel (a
future stdio/HTTP transport) would reconstitute its thrown error that way, not as the original class
instance. The same helper and the same test shape are reused outside this scope: `adapters/agents-store.ts`
(`code-domain-hubs`, `specs/hosts/code-domain-hubs.md`) and `adapters/workspace-files.ts` both import
it for the identical `not_found`-to-`null` pattern; this document is its one description, since
`kernel-run-client.ts` is its heaviest caller (three of the module's five call sites).

### 2.5 `StartRunInput` → wire mapping (`toStartParams`, `packages/code/src/adapters/kernel-run-client.ts`)

| `StartRunInput` field | Wire `StartRunParams` field | Emitted when |
| --- | --- | --- |
| `executionId` | `execution_id` | always (defaulted) |
| `messages` | `messages` | always, `?? []` |
| `profile` | `agent` | truthy |
| `continueFrom` | `continue_from` | truthy |
| `sessionId` | `session_id` | truthy |
| `guardMode` | `guard_mode` | truthy |
| `guardJudge` | `guard_judge` `{prompt, model?, on_unsure?, timeout_ms?}` | truthy |
| `memory` | `memory` | truthy |
| `plans` | `plans` | truthy |
| `task` | `task` | truthy |
| `skill` | `skill` | truthy |

`workspace` is *not* a start parameter — `packages/code/tests/component/kernel-run-client.test.ts`
asserts `expect(captured).not.toHaveProperty("workspace")`.

### 2.6 Environment variables read in this scope

| Variable | Read at | Meaning |
| --- | --- | --- |
| `CLARVIS_STREAM_DEBUG` | `packages/code/src/adapters/stream-metrics.ts` | JSONL path for the streaming counters; unset ⇒ no-op sink |
| `CLARVIS_TUI_RSS_LIMIT_MB` | `packages/code/src/views/App.tsx` via `tuiRssLimitBytes` (`packages/code/src/adapters/memory-pressure.ts`) | RSS fuse limit in MiB; `0` disables |

## 3. Data and formats

### 3.1 Identifiers

| Id | Shape | Generated at |
| --- | --- | --- |
| execution id | `"exec_" + crypto.randomUUID()` | `packages/code/src/run-host.ts`; and as a fallback in `packages/code/src/adapters/kernel-run-client.ts` |
| session id | UUIDv7 — 48-bit ms timestamp in bytes 0–5, `crypto.getRandomValues` over 6–15, version nibble `0x7`, variant bits `0b10` | `uuidv7` in `packages/code/src/adapters/session-store.ts` |
| transcript user-node key | `"user:" + userSeq++` | `packages/code/src/adapters/store.ts` |
| transcript notice key | `"notice:" + noticeSeq++` | `packages/code/src/adapters/store.ts` |
| local-bash node key | `"local:" + localSeq++` | `packages/code/src/adapters/store.ts` |
| run-scoped node key | `` `${execId}::${spanId}` `` | `packages/code/src/adapters/store.ts`, tool form |
| folded-prefix node key | the literal `"transcript:folded-prefix"` | `packages/code/src/adapters/store.ts` |
| run-failure node key | `` `${execId}::run-failed:${error.code}` `` | `packages/code/src/adapters/store.ts` |

`uuidv7`'s version/variant bits are pinned by
`packages/code/tests/component/session-store.test.ts`.

### 3.2 `SessionMeta` — the persisted session record

Declared as `SessionMeta` in `packages/code/src/adapters/session-store.ts`.

| Field | Type | Note |
| --- | --- | --- |
| `id` | `SessionId` | UUIDv7 |
| `title` | `string` | `redactPreview(firstUserText, { max: 80 })` in `createSession.beginTurn` (`packages/code/src/adapters/session.ts`) |
| `projectId` | `string?` | required before persistence; `metaToSession` in `packages/code/src/adapters/session-store.ts` throws without it |
| `workspace` | `string` | the workspace **id**, from `RunHostDeps.workspaceId` (`packages/code/src/run-host.ts`) |
| `owner` | `string` |  |
| `createdAt` / `updatedAt` | `number` (epoch ms) |  |
| `agentProfile` | `string?` | Agent Profile name |
| `turns` | `TurnRef[]` |  |
| `lastExtensionProfile` | `ExtensionProfileRunRef?` | newest turn's extension snapshot, retained by catalog-only projections |
| `turnCount` | `number?` | present *only* on a catalog-only summary (`SessionMeta`, `sessionSummaryToMeta`, and `demoteOldFullSessions` in `packages/code/src/adapters/session-store.ts`) |
| `totals` | `SessionTotals` `{input, output, cached?, costUsd?}`; absent `cached` means an incomplete split, numeric zero means measured zero | `packages/code/src/adapters/session-store.ts` (`SessionTotals`) |
| `pending` | `Message[]?` | unflushed observations |

`TurnRef` is the required discriminated union `ConversationTurnRef | TranscriptTurnRef`. Both variants
carry
`{ kind, userPreview, executionId?, extensionProfile?: {id, fingerprint}, status, startedAt?, endedAt?, error? }`;
`kind: "conversation"` participates in provider continuation, while `kind: "transcript"` remains a
canonical display/export turn without becoming continuation context. `extensionProfile` identifies the
resolved extension snapshot pinned when the turn began and `error` is `{code, message}` present only
on a failed turn. Production: `packages/code/src/adapters/session-store.ts` (`TurnRefBase`,
`ConversationTurnRef`, `TranscriptTurnRef`, `TurnRef`).

The wire shape is `Session` from `@clarvis/protocol`; `metaToSession` and `sessionToMeta` are the
camelCase↔snake_case adapters. Protocol `SessionTurn.kind` is mandatory. `metaToSession` writes it for
every turn and `sessionToMeta` calls `persistedTurnKind`; a stale pre-discriminator document with a
missing or unknown `kind` throws instead of guessing whether its run belongs to continuation. The
protocol's declared `SessionTurn` type has no `error` member, so the adapter deliberately widens the
persisted turn locally with optional `{code,message}`. The write leg includes that member only when
present; the read leg accepts it only when both fields are strings.
`createSession.endTurn` applies `redactTurnError` before either memory or disk sees the value, masking
the message unless preview redaction is disabled and bounding it to `TURN_ERROR_MAX_CHARS = 2000`.
Production: `packages/code/src/adapters/session-store.ts` (`PersistedSessionTurn`,
`persistedTurnError`, `metaToSession`, `sessionToMeta`, `redactTurnError`) and
`packages/code/src/adapters/session.ts` (`endTurn`). Test:
`packages/code/tests/component/session-store.test.ts` ("transcript-only turn identity is persisted
and stale undiscriminated turns are rejected", "a failed turn's reason survives
metaToSession -> disk JSON -> sessionToMeta", "a reloaded session still carries why its turn failed",
and malformed persisted-error cases) and `packages/code/tests/component/session.test.ts` ("a failed
turn's reason is masked and bounded before it is recorded").

`sessionSummaryToMeta` maps a `SessionSummary` to a `SessionMeta` with `turns: []`,
`turnCount: s.turn_count`, and `lastExtensionProfile: s.last_extension_profile` when present;
`sessionTurnCount` returns `turnCount ?? turns.length`. Production:
`packages/code/src/adapters/session-store.ts` (`sessionSummaryToMeta`, `sessionTurnCount`). Test:
`packages/code/tests/component/session-store.test.ts` ("session wire adapters preserve the active
Extension Profile identity").

### 3.3 Prompt-history file

JSONL, one `JSON.stringify(text)` per line (`packages/code/src/adapters/file-prompt-history.ts`,
encoder), written to `workspaceStatePaths().promptHistoryFile` with `FILE_MODE` and
parent `DIR_MODE` from `@clarvis/paths`. Reads take at most the **last** 8 MiB
(`MAX_PROMPT_HISTORY_FILE_BYTES`) and parse backwards line by line until `limit` entries are
collected; a partially-read first line is dropped when the tail was truncated,
and an unparsable line is skipped without hiding the rest.

### 3.4 `stream-metrics` JSONL

`createStreamMetrics(path, source)` (`packages/code/src/adapters/stream-metrics.ts`) appends one
record per 1000 ms window :

```
{ at, source, window_ms, counts: {…}, rates: {…}, rss, heap_used, external }
```

On `process.on("exit")`, it also appends a totals line `{ at, source, totals: {…} }` when any
counter fired. `rates` is `round(count * 1000 / elapsed)`. An idle window still
emits a record with empty `counts`/`rates` — pinned by
`packages/code/tests/integration/stream-metrics.test.ts`.

### 3.5 `MemoryPressureSnapshot`

`{ phase, limitBytes, warningBytes, rearmBytes, rss, heapUsed, external, arrayBuffers, sampledAt }`
(`packages/code/src/adapters/memory-pressure.ts`). Thresholds are derived from the limit:
`warningBytes = floor(limit * 0.8)`, `rearmBytes = floor(limit * 0.7)`.

## 4. Behavior

### 4.1 `submitTurn` — the ordinary turn (`packages/code/src/run-host.ts`)

1. Read `deps.activeProfile()`; empty ⇒ status `"no backend yet"` and return.
2. Compute `draftText = display ?? composerText(content)` (helper — the composer
   text keeps only `type: "text"` parts).
3. Resolve `@`-mention images through `buildContent`/`appendMentionImages`. A
   `MentionImageError` sets the status to the error's message, calls `draftRestore` with the original
   draft, and returns **before any session or run state is created**; any other error
   rethrows.
4. **If a run is already interactively active**: this is a *steer*, not a new turn. An optimistic
   `queueSteer` annotation is added only if the current sink is that execution's; `client.steer` is awaited; a non-`"steered"` status rolls the annotation back and
   shows the raw status; a throw rolls it back, sets `"steer failed — message restored to the input"`
   and restores the draft. Kernel success means the loop drained the steering message;
   a run that closes first rejects the call, restores the draft and leaves one visible
   `Steer not delivered` receipt. That live-only failure receipt survives the stored-trace
   reconciliation pass. Returns. A run whose `done` result has settled is no
   longer active here even when `closed` is still waiting on post-run memory events.
5. If `done` has settled but stored-run reconciliation is still finishing, await that semantic
   settlement and re-check `runActive`; the message is retained for a new turn and is never sent to
   the settled handle's steer queue. Production: `packages/code/src/run-host.ts` (`submitTurn`,
   `currentSettlement`). Test: `packages/code/tests/component/run-host.test.ts` ("done releases
   interactive ownership before the post-run event stream closes").
6. Otherwise create the session if absent (`loadEpoch += 1`, `createSession`).
7. Mint `executionId`, snapshot `messagesBeforeTurn`, append the user node
   (`store.appendUserMessage`).
8. If the effective plans mode is `"review"` (`skill?.plansMode ?? deps.plansMode?.()`), append a
   plan-approval notice to the transcript.
9. `sess.beginTurn(msg, executionId)` stamps the process-pinned Extension Profile identity on the new turn,
   mirrors it to `SessionMeta.lastExtensionProfile`, and returns the **continuation base** — the previous
   turn's execution id. Production: `packages/code/src/adapters/session.ts` (`beginTurn`). Test:
   `packages/code/tests/component/session.test.ts` ("beginTurn stamps the selected Extension Profile and
   reconcile adopts the persisted run snapshot").
10. `rememberResidentTurn` records the turn and folds the oldest when over the limit.
11. Collect `sessionId = sess.meta()?.id`, `guardMode`, `judgePayload(guardMode)`, and `memory`
    only when the mode is `"off"`.
12. `workflowRunId = executionId; setWorkflowActivity(null)`.
13. Run through `runManaged` : a continuation start when `continueFrom && !isManager`
    (sending only `[...pending, {role:"user", content: msg}]`), otherwise a full start.
14. On a `continuation_unavailable` failure that was not cancelled, await `handle.closed`, set
    `"context expired — rebuilding from history…"`, and re-start full with a rebuilt history.
15. `afterRun: sess.endTurn(envelope)`. `onStored`: `sess.reconcile(stored)`,
    `replayRunEvents(sink, stored)`, and `sess.releaseHistory()` when a trace exists, including for a
    manager. `onError`: `sess.endTurn(undefined)` and a `"cancelled"` /
    `"run error: …"` status.

`fullRequestMessages` rebuilds a released history by calling `resumeSession` over
`meta.turns.slice(0, -1)` with `renderWindow: 0`; a degraded rebuild throws
`"cannot rebuild full history: N persisted run trace(s) is/are unavailable"`, which
surfaces as a run-error status rather than an incomplete request —
`packages/code/tests/component/run-host.test.ts`.

### 4.2 `runManaged` — the single funnel

Every run shape (`submitTurn`, `submitScheduledTurn`, `submitSkillRun`, `workOnTask`) goes through it.
Human and scheduled conversation turns share `submitPreparedTurn`. The scheduled entry additionally
reserves before asynchronous preparation and retains that reservation through reconciliation and
physical closure. It cannot steer, overwrite the human draft after preparation failure or dispatch
under a changed live-session/configuration binding. Human input received before reservation wins;
input received after reservation waits for the handle and can then steer normally. Production:
`submitScheduledTurn`, `submitTurn`, `submitPreparedTurn` in
[run-host.ts](../../packages/code/src/run-host.ts). Test: the automatic-admission, preparation-race,
stale-callback, cancellation and closure/reconciliation cases in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).
The complete registration contract is [loop-scheduling.md](loop-scheduling.md).

| Phase | Effect | File |
| --- | --- | --- |
| enter | capture `ownershipEpoch = runOwnershipEpoch` | `packages/code/src/run-host.ts` |
| enter | `transcript = store.openRun(id)`; `sink = teeSink(transcript, activity.openRun({current:true}))` | `packages/code/src/run-host.ts` |
| enter | `currentSink = {executionId, sink, transcript}`; `cancelRequested = false`; `currentStatusExecId = executionId`; `memoryStatusBase = null` | `packages/code/src/run-host.ts` |
| enter | clone `sess.meta()?.totals` into `sessionUsageBaseline` before the run can settle or mutate those totals | `packages/code/src/run-host.ts` (`runManaged`, `sessionUsageBaseline`) |
| enter | `diagnosticBind({execution_id})`; `setRunActive(true)`; `setRunStartedAt(Date.now())`; initial status; `attention.setTitle("running")` | `packages/code/src/run-host.ts` (`runManaged`) |
| enter | open `currentSettlement`, the semantic-reconciliation gate that does not extend `runActive` | `packages/code/src/run-host.ts` (`runManaged`, `currentSettlement`) |
| handle | `setHandle` records an independent physical-work lease and attaches its release to `handle.closed` | `packages/code/src/run-host.ts` (`runManaged`) |
| resolve | ownership re-check (`session !== sess \|\| epoch mismatch` ⇒ return) | `packages/code/src/run-host.ts` |
| resolve | `afterRun?`; publish the outcome status; release interactive handle/title/`runActive`; replay any held ingest notice | `packages/code/src/run-host.ts` (`runManaged`, `releaseInteractiveOwnership`) |
| resolve | `client.getRun(executionId)`; on throw, `store.settleRun(id, status === "completed")` | `packages/code/src/run-host.ts` |
| resolve | ownership re-check again, then `onStored(envelope, stored, sink)` | `packages/code/src/run-host.ts` |
| resolve | `store.appendRunFailure` when the envelope failed with an error | `packages/code/src/run-host.ts` |
| resolve | `attention.notify` when not cancelled and away | `packages/code/src/run-host.ts` (`runManaged`) |
| reject | `onError(e)`; `store.settleRun(id)`; `attention.notify("run failed")` when not cancelled and away | `packages/code/src/run-host.ts` |
| finally | idempotently release interactive ownership on an error path; clear the diagnostic binding and sink; resolve `currentSettlement` without awaiting `closed` | `packages/code/src/run-host.ts` (`runManaged`, `releaseInteractiveOwnership`) |
| finally | `elicit.cancelPending()` only while the same session and ownership epoch remain current | `packages/code/src/run-host.ts` |

`runOutcomeStatus` renders `"failed — <message>"` for a failed envelope carrying an error,
otherwise `envelope?.status ?? "done"`.

Interactive ownership ends as soon as the result has updated the session and outcome status, before
stored-run reconciliation and without awaiting `closed`. A new submission waits on
`currentSettlement` only long enough for reconciliation to finish, then re-checks `runActive` and
starts a semantic turn; it is never steered into the settled run. Every handle separately holds a
physical-work lease from `setHandle` until its own `closed` promise settles. This keeps post-run
memory events deliverable and prevents memory recovery from running GC while the backend is still
unwinding, without leaving the composer in steer mode. Production: `packages/code/src/run-host.ts`
(`currentSettlement`, `physicalHandles`, `physicalWorkActive`, `runManaged`). Tests:
`packages/code/tests/component/run-host.test.ts` ("done releases interactive ownership before the
post-run event stream closes" and "forced teardown keeps the physical run lease until closed").

### 4.3 `submitSkillRun` (`packages/code/src/run-host.ts`)

Unlike `submitTurn`, an active run makes `submitSkillRun` **refuse outright** rather than steer:
`if (runActive()) { setStatus(["busy", …, "finish the current run first"]); return; }`,
pinned by `packages/code/tests/component/run-host.test.ts` ("submitSkillRun: refuses to start
while a run is already active").

1. `profile = deps.activeProfile()`; this is the active Agent Profile, and if there is no
   session yet, create one with `{ agentProfile: profile || undefined }` — note the
   `|| undefined`, not the bare `{ agentProfile: profile }` `submitTurn` uses, so an empty
   active Agent Profile is stored as absent rather than as `""`.
2. Mint `executionId`, build the label `` `/${name} ${task}` `` (or bare `` `/${name}` `` when `task`
   is blank), append the user node, persist it through `sess.beginTranscriptTurn(label, executionId)`
   and call `rememberResidentTurn`. `beginTranscriptTurn` writes `kind: "transcript"` but does not
   append the skill's internal prompt to model history or advance the session's conversation
   continuation base.
3. `client.startRun` is composed inline — `guardMode: skillGuardMode...deps.judgePayload(skillGuardMode)...(skillMemoryMode === "off" ? {memory: skillMemoryMode} : {})` — rather than
   through the intermediate `guardArgs` object `submitTurn` builds once and spreads at its call sites. The composed fields are the same shape either way: `guardMode` always present,
   `memory` only when the mode is `"off"`.
4. Run through `runManaged` with `run` calling `client.startRun({ skill: {name, task}, … })`.
5. `afterRun` calls `sess.endTranscriptTurn(envelope)`, which settles the matching transcript-kind
   turn without appending its assistant result to conversation history. `onStored` never calls
   `sess.reconcile` or `sess.releaseHistory` — it only replays the run's events and appends
   `buildSkillRunDigest(name, agent, envelope, stored, deps.planProviderKey?.())` as a pending
   observation for the next conversation run. `onError` also settles only the transcript-kind turn.
   Production: `packages/code/src/run-host.ts` (`submitSkillRun`) and
   `packages/code/src/adapters/session.ts` (`beginTranscriptTurn`, `endTranscriptTurn`). Tests:
   `packages/code/tests/component/run-host.test.ts` ("submitSkillRun: starts a run on the skill's
   agent, appends its digest, and settles") and `packages/code/tests/component/session.test.ts`
   ("transcript-only runs are canonical without becoming continuation context").

### 4.4 `workOnTask` (`packages/code/src/run-host.ts`)

1. Refuses when `runActive() || bashActive()` or when `profile.trim().length === 0`, each with its own status message.
2. Calls `clearSession()` **unconditionally** — every existing session, its turns and any
   folded-prefix notice are discarded before the task-bound run starts; there is no path that preserves
   prior session state alongside a task run.
3. `deps.setActiveProfile(profile)`, bumps `loadEpoch`, sets `sessionTask = {id: ref.id, provider_key:
   ref.provider_key, mode: "work"}`, and creates a fresh `Session` with `{ agentProfile: profile }`.
4. Mints `executionId` and a **fixed** instruction message — `` `Work on task ${ref.id} in the current
   workspace. Read the active task context, call start_task explicitly when that tool is available and
   you are ready to begin, and keep every review or completion transition explicit.` `` — displayed as
   `` `Work on task ${ref.id}` ``, pinned by
   `packages/code/tests/component/run-host.test.ts` ("Work on task starts a fresh current-workspace
   run with only task identity and provider key").
5. `sess.beginTurn`, `rememberResidentTurn`, arms `workflowRunId`/`workflowActivity` exactly as
   `submitTurn` does, then runs through `runManaged` sending the session's full message
   chain (`sess.messages()`) plus `task: sessionTask`. `afterRun`/`onStored`/`onError`
   mirror `submitTurn`'s `reconcile`/`releaseHistory` handling.

### 4.5 Cancellation

`cancelCurrentRun` (`packages/code/src/run-host.ts`) is a two-target function:

| Situation | Result |
| --- | --- |
| a `!bash` job is in flight and not yet aborted | abort it, status `"! cancelling…"`, return `true` |
| a `!bash` job whose `AbortController` already fired | return `false` (so a second `^C` belongs to the quit gate) |
| no handle, or `!runActive()`, or `cancelRequested` already | return `false`, status untouched |
| otherwise | `cancelRequested = true`, status `"cancelling…"`, `handle.cancel()`, return `true` |
| `handle.cancel()` rejects while still the current handle and active | reset `cancelRequested = false`, status `"cancel request failed — <text>"` |

The `!runActive()` guard is what stops a `^C` landing in the settle instant from permanently
relabelling a completed run — `packages/code/tests/component/run-host.test.ts`.

`teardownRuns` is the hard form: it bumps `runOwnershipEpoch`, aborts bash, cancels the
handle with `cancelRequested = true`, clears `currentSink`/`currentHandle`/`workflowRunId`/
`currentStatusExecId`/`heldIngest`, sets `runActive(false)` and resets the terminal title.
It is what `runtime.tsx` supplies as the memory fuse's `forceStopRun`
(`packages/code/src/runtime.tsx`, `runControls.forceStop`, consumed by
`packages/code/src/views/App.tsx`).

Unlike `runManaged`'s `finally`, `teardownRuns` does **not** await the handle's `closed` or `done`: the
cancel is fire-and-forget — `void currentHandle.cancel().catch(() => undefined)` — so a
straggling run can go on executing (and delivering events) after `teardownRuns` returns. What stops
those late deliveries from touching UI state is `runManaged`'s own ownership-epoch check (invariant 5),
not anything in `teardownRuns` itself.

### 4.6 Event routing (`onEvent`, `packages/code/src/run-host.ts`)

Everything happens inside one Solid `batch`.

| Condition | Effect |
| --- | --- |
| `currentSink` exists and (`executionId === undefined` or it matches) | `applyEvent(target.sink, event, source)` |
| `source === "live"`, `workflowRunId !== null`, event is a workflow-projection event, and the id matches (or is absent) | fold into `workflowActivity` via `reduceWorkflowProjection` |

`isWorkflowProjectionEvent` admits `workflow_run_started`, `workflow_title_updated`,
`workflow_run_progress`, `workflow_run_completed`, `workflow_run_failed`, `run_ended`.

### 4.7 Memory-ingest status composition (`onMemoryIngest`, `packages/code/src/run-host.ts`)

Three closure-scoped variables carry the state: `memoryStatusBase`, `heldIngest`,
`currentStatusExecId`.

| (state, event) | → (state, effect) |
| --- | --- |
| any, notice whose `execution_id !== currentStatusExecId` | dropped, no display change |
| run or bash active | `heldIngest = notice`, `memoryStatusBase = null`; nothing shown |
| idle, `memoryIngestIsPending(phase)` (`started`/`queued`) | capture the base if unset, render `base · <segment>` |
| idle, terminal phase (`done`/`failed`/`blocked`) | render `(memoryStatusBase ?? runStatus()) · <segment>`, then clear the base |
| a held notice whose run releases interactive ownership | replayed through `onMemoryIngest` |

`memoryIngestIsPending` is imported from the code adapter
(`packages/code/src/run-host.ts`, `packages/code/src/adapters/event-span.ts`), which delegates
to `isIngestPending` from `@clarvis/kernel/policy`
(`packages/kernel/src/runs/memory-ingest-phase.ts`) — the same partition the kernel uses to decide
whether a run's stream stays open.

### 4.8 `runBangCommand` (`packages/code/src/run-host.ts`)

Refuses during turn preparation, session loading, physical run work, compaction or another shell; lazily
creates a session, opens the transcript's local-bash node (`store.beginLocalBash`), installs an `AbortController`, sets
`bashActive`, status `"! running…"`, and runs `runBash(cmd, {cwd: workspace, signal})` through
`detachObserved`. On settle it finishes the transcript node, appends a `"user"`-role
observation to the session **only if the session is still the same object**, and updates the
status only if both the controller and the session are still current. Terminal status
words: `"! cancelled"`, `"! timed out"`, `` `! exit ${exitCode ?? "?"}` ``.

With a hosted backend, it confirms the canonical session before reserving a `shell` activity on that
connection. A refusal never spawns, and a session change after reservation releases the lease without
running the command. The shell result is persisted as a pending user observation under the owning
activity before release. `stopLocalWork` aborts and waits for the physical shell plus that persistence
and release, allowing `closeWorkspace` to keep its authenticated connection alive until cleanup.
An abrupt disconnect does not prove physical completion and cannot free the host reservation.

Production: `runBangCommand`, `stopLocalWork`, `prepareHostedSession` and the runtime's `closeWorkspace`.
Test: `hosted shell reserves before spawn and shutdown waits for output persistence and release`,
`refused hosted shell admission settles its transcript without starting a process` and the existing
clear/session-switch cases in `packages/code/tests/component/run-host.test.ts`.

### 4.9 Resident-turn folding

`rememberResidentTurn` pushes the new `{userKey}` `ResidentTurnRef` and returns immediately while
`residentTurns.length <= RESIDENT_TRANSCRIPT_TURN_LIMIT`. Over the limit it first asks the store to
`foldPrefixBefore(residentTurns[1].userKey, foldedPrefixNotice(foldedTurnCount + 1))`. On success it
shifts the oldest ref, increments the scalar `foldedTurnCount` and sets `foldedPrefix = 1`; no second
array retains metadata for folded turns.

If that incremental boundary is refused, the fail-bounded path tries the newly appended turn's own
`userKey`, folding the entire earlier resident prefix at once. A successful fallback retains only the
new turn and advances `foldedTurnCount` by the number of discarded refs. If both boundaries are
refused, the speculative new ref is popped and neither `foldedTurnCount` nor `foldedPrefix` advances,
so `residentTurns` itself never grows beyond 20. Production: `packages/code/src/run-host.ts`
(`ResidentTurnRef`, `rememberResidentTurn`). Tests:
`packages/code/tests/component/run-host-export.test.ts` (incremental-fold fallback and double-refusal
cases).

`foldPrefixBefore` (`packages/code/src/adapters/store.ts`) refuses an absent or index-`0` boundary,
then performs one batched semantic replacement `[foldedNotice, ...nodes.slice(boundary)]` and one
resident-publication replacement. The latter drops only complete sealed batches whose nodes all
belong to the removed prefix, replaces the previous folded-prefix publication and prepends one new
frozen committed notice. It passes only removed keys absent from every retained publication to
`TranscriptPublisher.forgetDiscarded`; that method rechecks semantic residency, cancels discarded
tool staging and releases the matching `knownKeys`, held-answer and reserved-sub-agent bookkeeping.
A pending staging timer therefore cannot republish folded content, and repeated folds keep the
publication identity ledger bounded. The bookkeeping it also performs on `foldDefaults`,
hydrated-tool byte accounting and queued rehydration jobs is the tool-body hydration window's own
internal state and is described by
[hosts/code-transcript.md](code-transcript.md); the immutable publication consequence is owned by
[hosts/code-transcript-stability.md](code-transcript-stability.md). Production:
`packages/code/src/adapters/store.ts` (`foldPrefixBefore`) and
`packages/code/src/adapters/transcript-publication.ts` (`forgetDiscarded`). Tests:
`packages/code/tests/unit/transcript-publication.test.ts` (discard-release and staged-flush
retention cases) and `packages/code/tests/unit/store-status.test.ts` (repeated 20-turn plateau).

### 4.10 `exportNodeBatches` (`packages/code/src/run-host.ts`)

Creates a **scratch** `TranscriptStore` in its own `createRoot`, with every retention cap raised to
`Number.MAX_SAFE_INTEGER`.

| Case | Behavior | File |
| --- | --- | --- |
| no folded turns and no released prose | yields `store.nodes` itself (identity), then done | `packages/code/src/run-host.ts` |
| no folded turns but released prose present | yields through `exportResidentNodes` | `packages/code/src/run-host.ts` |
| folded turns present | lazily index `session.meta().turns[0..foldedTurnCount)`, rebuild and yield one canonical turn at a time, then stream the live window from `store.nodes.slice(foldedPrefix)` | `packages/code/src/run-host.ts` (`exportNodeBatches`) |

The host deliberately retains only `foldedTurnCount`, not a parallel `foldedTurns[]`. When export
begins, `canonicalTurns = session?.meta()?.turns` supplies each folded turn's preview, kind and trace
id by index. `scratch.clear()` runs before every index and the generator yields that reconstructed
turn before reading the next one, so export does not materialize a second copy of the session or
eagerly fetch the folded prefix. A transcript-kind turn uses its canonical display preview rather
than substituting the skill's internal persisted prompt. Production: `packages/code/src/run-host.ts`
(`exportNodeBatches`). Tests: `packages/code/tests/component/run-host-export.test.ts` ("folded export
reads the canonical turn index one item at a time", "transcript-only skill runs use the same bounded
canonical export index", and "folded turns are yielded one at a time before the bounded live
window").

`exportResidentNodes` walks nodes, and for each released-prose node
(`isReleasedProse`) resolves the source execution id (`sourceExecutionId` — the
`sourceExecutionId` field for a `user` node, otherwise the key prefix before `"::"`), lazily
`loadPersisted`es that run once, and substitutes:

| Failure | Replacement text |
| --- | --- |
| no execution id | `"no persisted run identifies this block"` |
| fetch threw | `` `run ${id} could not be fetched` `` |
| fetch returned `null` | `` `run ${id} is no longer retained` `` |
| user node, no recoverable prompt | `` `run ${id} has no recoverable prompt` `` |
| user node, `sourceTextFingerprint` mismatch | `` `run ${id}'s persisted prompt does not match this displayed block` `` |
| assistant/reasoning node absent or itself released | `` `run ${id} has no recoverable ${kind} block` `` |

each prefixed by `EXPORT_INCOMPLETE_PREFIX` (`incompleteExportNode`). Batches are
flushed every `EXPORT_BATCH_NODE_LIMIT` nodes.

The fingerprint check is real: a `/skill` user node shows the rendered command while the persisted
prompt is the skill body, so exporting the persisted content would silently substitute a different
prompt — `packages/code/tests/component/run-host-export.test.ts`.

### 4.11 `clearSession` (`packages/code/src/run-host.ts`)

`clearSession(opts?: {flush?: boolean})` bumps `loadEpoch`, calls `teardownRuns()`, then — **flush is
the default**: `if (opts?.flush !== false) session?.flush()`, so a caller must pass
`{flush: false}` explicitly to skip persisting the outgoing session — drops `session`/`sessionTask`,
clears `store`/`activity`, resets `foldedTurnCount`/`residentTurns`/`foldedPrefix` to `0`/empty/`0`, and
sets status to `["idle"]`. `loadSessionMeta` and `workOnTask` both rely on this full reset before
installing their own session state.

### 4.12 `loadSessionMeta` (`packages/code/src/run-host.ts`)

1. `epoch = ++loadEpoch`; `teardownRuns()`; `session?.flush()`; drop session/task; clear both stores
   and the fold bookkeeping.
2. `windowStart = max(0, meta.turns.length - RESIDENT_TRANSCRIPT_TURN_LIMIT)`. When positive,
   `foldedTurnCount = windowStart`, one folded notice is appended and `foldedPrefix = 1`. The older
   turn metadata stays only in canonical `meta.turns`; it is not copied into another host array.
3. `resumeSession(meta, {getRun, currentPlanProviderKey, renderTurn}, {renderWindow: 20})`. `renderTurn` drops anything whose epoch has moved on or whose index is before
   `windowStart`, otherwise appends the user node, records the resident turn, replays the
   turn's events into `teeSink(store.openRun, activity.openRun)` and appends a **recovery notice**
   with tone `"warn"` when the record was rebuilt from a damaged journal.
4. Post-resume epoch check, then `sessionTask = resumed.activeTask` and a fresh `Session`
   seeded with `historyComplete: resumed.degraded.length === 0`.
5. `history.seed(seeds)`. The seed array starts from `meta.turns[0..foldedTurnCount)`, adding the
   stored redacted `userPreview` only for `kind: "conversation"`; transcript-only turns never enter
   prompt history. For each resident turn `resumeSession` renders, `renderTurn` likewise pushes
   rehydrated `userContent` only for a conversation turn. A conversation inside the resident render
   window therefore seeds from its rehydrated content, while a folded conversation seeds from its
   canonical redacted preview. Production: `packages/code/src/run-host.ts` (`loadSessionMeta`). Test:
   `packages/code/tests/component/run-host.test.ts` ("resume seeds prompt history from the rehydrated
   user content, not userPreview").
6. Compare `meta.lastExtensionProfile ?? meta.turns.at(-1)?.extensionProfile` with
   `client.currentExtensionProfile()`. A different id or fingerprint appends a warning naming both
   snapshots; it does not block the resume or rewrite the historical turn. `currentExtensionProfile()`
   is refreshed after every successful trust approval/revocation, so this comparison cannot retain
   the pre-transition fingerprint until reconnect.
7. Status: `"resumed N turns"` plus ` · N folded`, ` · Extension Profile changed`, and
   ` · N degraded` segments when applicable. Production: `packages/code/src/run-host.ts`
   (`loadSessionMeta`). Test: `packages/code/tests/component/run-host.test.ts`
   ("loadSessionMeta warns when the active Extension Profile differs from the persisted turn").

`recoveryNotice` names both counts: `"partial record — this turn was rebuilt from a damaged
journal after a crash: N journal lines lost, M tool results synthesized. The run happened; this record
of it is incomplete."`, singularised per count.

`resumeSessionById` loads the meta through `sessionStore.load`, guards its own
`requestEpoch` around the await, and reports `"session not found"` / `"resume failed: …"`.

### 4.13 `resumeSession` (`packages/code/src/adapters/session.ts`)

The message-chain rebuild is a **backwards** walk in batches of `FETCH_CONCURRENCY = 6`:

1. `reserveHistory(meta.pending ?? [], null)` charges the persisted observations first.
2. `while (cursor >= 0 && !foundReset)`: build a batch of up to 6 descending indexes and
   `fetchBatch(batch, retainHistory = true)`.
3. Inside a batch, each fetched `RunDetail` is immediately *projected* to
   `{continueFrom?, userContent?, history?, events?, recovery?}`, and the `RunDetail`
   itself is released — pinned with `WeakRef` + `Bun.gc(true)` at
   `packages/code/tests/component/session.test.ts` ("resumeSession releases fetched RunDetail
   objects before requesting the next batch").
4. A turn with no `continue_from` sets `foundReset` and `resetIdx`; the walk stops at
   the next batch boundary, so up to 5 extra fetches happen.
5. Turns inside the visual window but before `resetIdx` are fetched in a second pass with
   `retainHistory = false`.
6. The render loop accumulates the chain: at or after `resetIdx`, a `continueFrom` turn
   **appends** its messages while a non-`continueFrom` turn **replaces** the accumulation outright
   (the final `for (const [idx, turn] of turns.entries())` loop).

Budget enforcement is incremental and pre-allocation: `reserveHistory` counts messages against
`SESSION_RESUME_MAX_MESSAGES = 10_000` and characters against
`SESSION_RESUME_MAX_PAYLOAD_CHARS = 16_000_000`, throwing `SessionResumeLimitError` —
`{ code: "resource_exhausted", reason: "session_resume_history_limit", dimension, limit }` — before
the next batch is fetched. The test "resumeSession rejects an oversized continuation chain before
fetching the next batch" in `packages/code/tests/component/session.test.ts` asserts exactly
18 fetches (three batches) and **zero** renders on that path.

Degradation classification in `resumeSession`:

| Turn state | `reason` |
| --- | --- |
| `turn.status === "running"` | `"interrupted"` |
| has an `executionId` but no detail | `"trace_pruned"` |
| no `executionId` | `"trace_unavailable"` |

A turn never fetched at all (outside both the chain walk and the window) renders `collapsed: true` and
counts toward `collapsed`, never `degraded` — the test "resumeSession counts a folded-but-pruned
turn as degraded only, never as both" in `packages/code/tests/component/session.test.ts` pins that
the two totals never overlap.

### 4.14 `Session` (`createSession` in `packages/code/src/adapters/session.ts`)

| Method | Effect | File |
| --- | --- | --- |
| `beginTurn(content, execId)` | creates `meta` on first call, pushes a user message and a running `kind: "conversation"` turn, advances continuation and returns its previous conversation execution id | `packages/code/src/adapters/session.ts` (`beginTurn`) |
| `beginTranscriptTurn(display, execId)` | creates a running `kind: "transcript"` turn without mutating model history or continuation | `packages/code/src/adapters/session.ts` (`beginTranscriptTurn`) |
| `endTurn(envelope)` | settles the matching conversation turn, appends the assistant reply, and folds usage into totals once | `packages/code/src/adapters/session.ts` (`endTurn`, `finishTurn`) |
| `endTranscriptTurn(envelope)` | settles the matching transcript turn and totals without appending its result to model history | `packages/code/src/adapters/session.ts` (`endTranscriptTurn`, `finishTurn`) |
| `reconcile(stored)` | re-maps status, adopts the persisted run's Extension Profile identity when present, and adds usage if the id was not already counted | `packages/code/src/adapters/session.ts` (`reconcile`) |
| `setAgentProfile(name)` | no-ops when `!meta \|\| meta.agentProfile === name`; otherwise updates `meta.agentProfile`/`meta.updatedAt` and saves | `createSession.setAgentProfile` |
| `appendObservation(content, role="assistant")` | pushes into `history` **and** `pending`, mirrors `pending` into `meta` and saves | `createSession.appendObservation` |
| `takePending()` | drains `pending` and deletes `meta.pending` | `createSession.takePending` |
| `flush()` | persists `meta` if present; a no-op with no session yet | `createSession.flush` |
| `releaseHistory()` | empties `history` and sets `historyComplete = false` | `createSession.releaseHistory` |
| `restoreHistory(messages)` | splices in a rebuilt chain and sets `historyComplete = true` | `createSession.restoreHistory` |

`lastTurnFor` searches backwards for the requested `kind` and, when supplied, exact `executionId`; it
returns `undefined` rather than falling back to a turn of another kind or id.

`runStatusToNode` in `packages/code/src/adapters/session-store.ts`: `completed→done`, `cancelled→cancelled`,
`running→running`, everything else `→ error` — except `endedReason === "soft_limit_declined"`, which
maps to `cancelled`.

### 4.15 `buildSkillRunDigest` / `buildRecoveredContext` (`packages/code/src/adapters/session.ts`)

`buildSkillRunDigest(name, agent, envelope, stored, selectedPlanProviderKey?)` is what
`submitSkillRun`'s `onStored` appends as an observation (`packages/code/src/run-host.ts`). It builds the tag
`` `[/${name} → ${agent}${execId ? \`, exec ${execId}\` : ""}]` ``, then resolves the body
through a fallback chain: the live envelope's or stored run's textual result
(`resultToContent(envelope ?? stored?.result)`); failing that, `buildRecoveredContext`'s salvage from
the stored run's events, when a `stored` detail exists; failing that, a bare
`` `${status} with no textual result.` `` line.

`buildRecoveredContext(events, planRef?, selectedPlanProviderKey?)` reconstructs what an interrupted
run should not force the next turn to redo, in up to two sections: **decisions** — every accepted
`elicitation_resolved` event with a non-empty string answer, rendered `` `${question} → ${answer}` ``
— and **plan status**, present only when `planRef` exists and is not `completed`; it always names the
plan's provider/id/revision and, when `selectedPlanProviderKey` differs
from `planRef.provider_key`, tells the reader to re-select `planRef.provider_key` before `read_plan`
can resolve the document, rather than simply pointing at `read_plan`. The function's own TSDoc
states the plan is deliberately **not** reconstructed from events, because
plan documents never enter the trace — the salvage points at the provider's authoritative state
instead of a stale snapshot. `buildRecoveredContext` returns `null` when neither section applies,
and is also used by `resumeSession`'s history rebuild.

### 4.16 `deleteSession` (`packages/code/src/adapters/session.ts`)

`deleteSession(meta, store, deleteRun)` cascades a session delete: for every turn carrying an
`executionId`, it awaits `deleteRun(executionId)` and records `{executionId, deleted}`, then deletes
the session record itself via `store.delete(meta.id)`, returning
`{session: boolean, traces: {executionId, deleted}[]}`. Trace deletion happens before the session
record's, and a turn with no `executionId` contributes no trace entry. Pinned:
`packages/code/tests/component/session.test.ts` ("deleteSession removes the session file and
cascades delete_run per turn").

### 4.17 `createSessionStore` (`packages/code/src/adapters/session-store.ts`)

An in-memory `cache` plus one **write lane per session id** (`lanes`).

| Operation | Cache effect | Persistence |
| --- | --- | --- |
| `list()` | all cached values sorted by `updatedAt` descending | none |
| `get(id)` | `cache.get(id) ?? null` | none |
| `load(id)` | returns a resident full document, otherwise `sessions.get(id)` → `sessionToMeta` → cache; a `null` reply evicts the entry | read |
| `save(meta)` | cache, `touchFull`, enqueue `{kind:"save", snapshot: metaToSession(meta)}` | queued |
| `delete(id)` | cache delete, `forgetFull`, enqueue `{kind:"delete"}`, returns whether it existed | queued |
| `flushPending()` | awaits every lane, repeatedly, then demotes | — |

None of the reads takes an owner. The store is scoped to the one `createSessionStore` bound, and
`sessionToMeta(loaded, owner)` is the only place that owner is used — stamping a fetched
document as it enters the cache. See §8.

`enqueue` is last-write-wins per id: while a lane exists, a new mutation only *replaces*
`lane.pending`. The drain loop deletes the lane **inside the same async continuation** that observed an
empty queue, not from a chained `.finally()` — the difference is a microtask window
where a save can populate a lane about to be deleted, pinned by
`packages/code/tests/component/session-store.test.ts` ("facade does not lose a save queued as the
prior lane settles").

The full-document LRU: `MAX_RESIDENT_FULL_SESSIONS = 8`; `demoteOldFullSessions`
rewrites an evicted entry into a summary (`turns: []`, `turnCount: current.turns.length`, `pending`
dropped) but **skips any id with a live write lane**, re-appending it to the LRU.

### 4.18 `ActivityStore` (`packages/code/src/adapters/activity-store.ts`)

`openRun` takes no execution id — see §8 — and returns a `RunSink` with per-run counters
(`runInput`/`runOutput`/`runCached` plus missing-split count) that are subtracted back out of the
resident process totals on a re-open or reconcile. `usage` is that mounted-run aggregate;
`currentUsage` belongs only to the most recent sink that received a **live** `run_started`, so a
rehydrated turn can never masquerade as the active delta. `runManaged` opens that sink with
`{current: true}`, claiming an explicit zero delta before `runActive` paints; stale usage from the
previous run therefore has no frame in which to be added again. A cache value, including zero, is emitted
only while every positive-input iteration in that scope reported the split; the first omission
deletes the optional field until that run is reset.

| Span/event | Effect | File |
| --- | --- | --- |
| sink open with `{current: true}` | claim `currentUsage` immediately as measured zero before the run paints | `packages/code/src/adapters/activity-store.ts` (`openRun`), `packages/code/src/run-host.ts` (`runManaged`) |
| `run` / `run_started` | reset subagents and plan, reset this run's usage, remember `lead_model`; a live source also claims `currentUsage` ownership | `packages/code/src/adapters/activity-store.ts` (`openRun`) |
| `subagent` / `delegation_created` | upsert by `delegation_id`, write title + profile | `packages/code/src/adapters/activity-store.ts` |
| `subagent` / `delegation_started` | status `running`, model, `startedAt` | `packages/code/src/adapters/activity-store.ts` |
| `event` / any `plan_*` | fold through `reducePlanProjection`; note that a plan event appeared during a reconcile | `packages/code/src/adapters/activity-store.ts` |
| `run` / `run_ended` | every still-`running`/`spawned` subagent becomes `done` or `error` by `reason === "completed"` | `packages/code/src/adapters/activity-store.ts` |
| `subagent` / `delegation_completed\|failed` | status from `subagentCompletedOk`, `endedAt`, `retainSummary` | `packages/code/src/adapters/activity-store.ts` |
| `iteration` / `iteration_completed` | accumulate gross tokens and cache-detail completeness; update `currentUsage` only for its live owner; `agent === "lead"` sets gross context, otherwise credit the subagent | `packages/code/src/adapters/activity-store.ts` (`openRun`) |
| `beginReconcile` | snapshot the plan, wipe subagents/plan, reset usage | `packages/code/src/adapters/activity-store.ts` |
| `endReconcile` | **restore the pre-reconcile plan** unless the replay produced a plan event of its own | `packages/code/src/adapters/activity-store.ts` |

`retainSummary` bounds each summary to 512 chars with a `"...[display truncated]"` suffix
(`ACTIVITY_SUMMARY_TRUNCATED_NOTICE`, declared) and keeps at most 64 summarised subagents in a
FIFO, deleting the `summary` field of the evicted ones.

### 4.19 `KernelRunClient` run lifecycle (`driveHandle`, `packages/code/src/adapters/kernel-run-client.ts`)

```
startRun ──> live.set(executionId, handleP)
             started = handleP.then(h => { wireElicit(h); return {h, pump: pumpEvents(id, h)} })
             done   = started.then(({handle}) => handle.done)
             closed = started.then(async ({handle, pump}) => { await handle.closed; await pump })
                             .catch(reportCloseFailure)
                             .finally(() => live.delete(executionId) if unchanged)
```

`pumpEvents` diverts every `memory_ingest` event to `onMemoryIngest` and
`continue`s — it never reaches `onEvent`, pinned at
`packages/code/tests/component/kernel-run-client.test.ts`. Everything else goes to
`onEvent(event, "live", executionId)` and then to the progress emitter.

`wireElicit(handle)` is the elicitation bridge `started` installs on every handle
before its pump begins. Each incoming `ElicitationRequest` is mapped to an `ElicitRequestParams`:
`message: req.prompt`, `kind: req.kind`, `detail: req.detail` only when the kernel sent one, and
`requestedSchema: req.schema ?? {type: "object", properties: {}}` when the kernel sent none. The callback runs `detachObserved`: `callbacks.onElicit?.(params)` if registered,
else `{action: "decline"}`; a thrown handler is caught by `reportElicitFailure`, which answers
`{action: "cancel"}` instead. The result is mapped back to an
`ElicitationResponse` — `id: req.id`, `action: result.action`, `content: result.content` only when
present — and sent via `handle.respond(response)`. Both directions are
pinned by `packages/code/tests/component/kernel-run-client.test.ts` ("elicitation bridges
request→UI→respond") ("a guard_confirm's structured command detail reaches the UI params",
which proves a `guard_confirm`'s `detail: {command, cwd, reason}` reaches `onElicit` verbatim).

`makeProgressEmitter` emits on exactly four event shapes, each with a monotonically
increasing `counter`:

| Event | Label |
| --- | --- |
| `iteration_started` with `agent === "lead"` | `` `iteration ${n}` `` |
| `model_retry` | `` `retrying in ${max(1, round(delay_ms/1000))}s (${attempt}/${max_retries})` `` |
| `plan_updated` with `change === "task"` | `` `plan r${revision}` `` |
| `run_ended` with a `reason` other than `completed` | `""` plus `event: {type, reason}` |

`steer` looks the run up in `live`; an unknown id answers `{status: "unknown", execution_id}`
without touching the kernel. Because the map holds a *promise*, a steer issued while the handle is
still starting simply awaits it — `packages/code/tests/component/kernel-run-client.test.ts`. Before
calling `handle.steer`, a `MessageContent` string is passed through unchanged while any other content
is wrapped as `{role: "user", content: input.message}`. `handle.steer` settles only
after the kernel loop drains that content; close-before-drain rejects instead of producing a false
success. On success the adapter returns `accepted: 1` — a fixed literal describing that one
drain-acknowledged request, not a count the kernel reports back
(`` return {status: "steered", execution_id: input.executionId, accepted: 1} ``) — pinned
exactly by `packages/code/tests/component/kernel-run-client.test.ts`
(`expect(res).toEqual({status: "steered", execution_id: "exec_2", accepted: 1})`).

`compact` routes through the owner-scoped `RunService`, so it can queue an active run or rewrite a
settled run's persisted continuation. `compactCurrentRun` targets the active execution when present,
otherwise the latest turn in the current session. `inspectCurrentContext` and `fitCurrentContext`
use that same identity for the model picker's preflight and confirmed mechanical fit.

The host does not treat queue acceptance as execution. For an active run, only a live
`compaction_started` event owned by the current execution sets `compactionActive`; either terminal
compaction event or `run_ended` clears it. A settled `/compact` has no live event stream, so
`compactCurrentRun` owns the state directly from immediately before `client.compact` until its
promise settles. Replay is ignored. `App` includes this accessor in the shared spinner clock and
passes `Compacting context…` through `Footer.status`, reusing the canonical running status surface.

`reconnect(mode)` (`packages/code/src/adapters/kernel-run-client.ts`) is strictly
`prepareReconnect?.(mode) → dispose() → connect()`. The preparation hook must accept the transition
before the adapter releases a healthy client. `connection` authenticates another connection to the
existing host; `reload` requests an idle host restart first. The omitted mode remains `reload` for
configuration callbacks, while `/reconnect` explicitly selects `connection` and `/reconnect reload`
selects `reload`. A refused reload leaves the existing adapter usable.

Production: `createKernelRunClient.reconnect` and `WorkspaceClientManager.recover` / `invalidate`.
Test: `reconnect confirms host retirement before releasing a healthy client`, `connection recovery
forwards its intent without preparing a host reload` and `a refused host reload leaves the connected
client usable` in `packages/code/tests/component/kernel-run-client.test.ts`, plus the real socket and
occupied-host cases in `packages/code/tests/component/workspace-client-manager.test.ts`.

### 4.20 `execution-safety` derivations (`packages/code/src/adapters/execution-safety.ts`)

Pure functions of `RunControlsState`, no state of their own.

`deriveIsolation` gives an explicit Docker or Podman runtime precedence over the native Sandbox
block; without a container runtime it returns Sandbox when that block is enabled and Host otherwise.
`deriveRunControls` then projects Review, Memory and Plans independently from that isolation choice.

`safetyDescription` branches first on container isolation. Docker and Podman describe the directly
mounted selected workspace plus either disabled networking or outbound access with explicit service
exposure. It states that guest changes appear on the host immediately rather than promising a hidden
copy or apply phase, then states whether commands run without review, use model review, or ask before
running. Container placement does not hide the independently selected Review mode.
Native Sandbox describes required versus optional confinement, filesystem and network policy; Host
describes direct execution. Review changes the consequence text inside either native placement but
never changes which placement was selected.

`memoryDescription` is a three-way switch on `state.memory`: `"on"` reads before/after, "no
extraction model resolves" for `"inert"`, otherwise disabled-for-this-session.

`planRetentionDescription(retention)` describes only the completed-plan retention consequence used by
Run Controls: `keep` leaves completed plans available in the selected provider; `discard` says a
successful run deletes after recording its result and that failed, cancelled or interrupted runs
retain the plan. Planning mode is intentionally absent from this presentation helper because the
TUI changes review policy through `/plan`, not Run Controls. Pinned by
`packages/code/tests/unit/execution-safety.test.ts` (plan-retention consequence case).

`applyIsolation` maps Host/Sandbox/Docker to an explicit global `{runtime, sandbox}` patch. Docker
persists only `{backend:"docker"}`, keeps the native Sandbox enabled and required for operational
fallback, and leaves guard policy untouched. `applyReviewMode` separately maps Off/Approval/Auto to
the selected scope's guard mode, carrying that scope's allow/deny lists or the global lists into a
workspace with no local policy; it writes no runtime or Sandbox field. Production:
`packages/code/src/features/run/isolation.ts`, `packages/code/src/features/run/review.ts`, and
`packages/code/src/views/config/RunControlsPanel.tsx`. Tests:
`packages/code/tests/integration/isolation-review-picker-render.test.tsx` and
`packages/code/tests/integration/run-controls-render.test.tsx`.

The simple picker deliberately has no runtime-recipe editor. An operator may add a script under the
global `runtime-recipes/` directory and reference it from the strict advanced Docker `recipe` block
in global `settings.json`; Code's `local-host.ts` keeps image resolution on the same lazy
first-run factory, and the kernel owns script capture, build, caching and fail-closed errors. Neither
the renderer nor a guest receives the script bytes or an operation to
mutate that configuration. Production: `main` in
`packages/code/src/local-host.ts`, `runtimeSettingsSchema` in
`packages/kernel/src/runtime/settings.ts`, and `resolveDockerRuntimeRecipe` in
`packages/kernel/src/runtime/runtime-recipe.ts`. Test:
`packages/kernel/tests/unit/runtime-settings.test.ts`,
`packages/kernel/tests/unit/runtime-recipe.test.ts`, and the gated
`packages/kernel/tests/integration/runtime-recipe.e2e.test.ts`.

Code supplies the workspace it already owns to the lazy container runtime. In a linked Git worktree,
that worktree is the separate checkout and Clarvis does not create a second copy, pause for apply,
commit, merge or remove it. A primary checkout or non-Git directory is mounted directly as well.
Production: `WorkspaceClientManager.create` in
`packages/code/src/adapters/workspace-client-manager.ts`; `discoverGitWorkspace` and the runtime
composition in `packages/kernel/src/file-kernel.ts`; `safetyDescription` in
`packages/code/src/adapters/execution-safety.ts`. Test:
`packages/code/tests/unit/execution-safety.test.ts` and
`packages/kernel/tests/integration/git-workspace.test.ts`.

### 4.21 Memory-pressure state machine (`packages/code/src/adapters/memory-pressure.ts`)

Sampled every `MEMORY_PRESSURE_SAMPLE_MS = 500` ms by an unref'd interval.

| State | Sample condition | → State | Effect |
| --- | --- | --- | --- |
| any, `limitBytes === 0` | — | `disabled` | publish only |
| `recovering` / `tripped` | — | unchanged | publish the fresh memory reading |
| `aborting` | run active and `elapsed < 10_000` ms | `aborting` | at `elapsed >= grace`, call `forceStopRun()` once |
| `aborting` | run inactive, or grace elapsed | `tripped` | publish the tripped state (`packages/code/src/adapters/memory-pressure.ts`) |
| `cooling` | `rss < rearmBytes` on 3 consecutive samples | `armed` | reset the counter |
| `armed` / `warning` | `rss >= limitBytes` | `aborting`, then `tripped` if the run is already inactive | `deps.cancelRun()` exactly once per trip |
| `armed` / `warning` | `rss >= warningBytes` | `warning` | publish the warning state (`packages/code/src/adapters/memory-pressure.ts`) |
| `armed` / `warning` | otherwise | `armed` | publish the armed state (`packages/code/src/adapters/memory-pressure.ts`) |

`blocked()` is true for `aborting`, `tripped`, `recovering`, `cooling`.
`memoryPressureAllowsSlash` permits exactly `clear`, `quit`, `exit`, `recover-memory`.

`recover()` is guarded in two stages, checked in this order, and the guard is keyed on
`recoveryAttempt`, not on `phase`:

1. `recoveryAttempt !== null` refuses first, with one of two messages: "memory recovery
   is already in progress" while `phase === "recovering"`, or "backend recovery is still pending after
   its timeout; restart clarvis if it does not finish" otherwise — the second message covers a prior
   `recover()` call that timed out (below) while its underlying `deps.reconnect()` promise is still
   outstanding. That window can occur while `phase` has already reverted to `"tripped"` (see the
   timeout branch), so this stage's refusal is not implied by the phase check that follows it.
2. Only once `recoveryAttempt` is `null` does `phase !== "tripped"` refuse, with a
   phase-specific message.

Past both guards, `recover()` publishes `recovering`, races `deps.reconnect()` against a 10 s timeout, and:

- on timeout → back to `tripped`, but the in-flight attempt stays single-flight and, if it later
  succeeds while still `tripped`, advances through `finishRecovery()`;
- on rejection or a `{ok:false}` result → back to `tripped`;
- on success → `finishRecovery()`: best-effort `gc()` inside a `try`, reset counters, publish
  `cooling`, sample once.

Every publish emits `diagnosticCount("memory.sample", …)`, and a phase *change* additionally emits
`diagnosticEvent("memory.phase", …)` at `warn` for `aborting`/`tripped` and `info` otherwise.

## 5. Invariants

The following are derived directly from this document's own source and its tests.

1. **A run event only reaches the transcript sink whose execution it names.** `onEvent` writes only
   when `executionId === undefined || target.executionId === executionId`
   (`packages/code/src/run-host.ts`). Pinned:
   `packages/code/tests/component/run-host.test.ts`.

2. **Only live events feed the workflow projection.** The fold is gated on `source === "live"`
   (`packages/code/src/run-host.ts`), so a rehydration replay never mutates
   `workflowActivity`. Pinned: `packages/code/tests/component/run-host.test.ts`.

3. **A plain (non-manager) run leaves `workflowActivity` null.** `workflowRunId` is only set on the
   `submitTurn`/`workOnTask` paths (`packages/code/src/run-host.ts`) and the
   projection is still gated by the event predicate. Pinned:
   `packages/code/tests/component/run-host.test.ts`.

4. **A settled result releases interactive ownership before its post-run event stream closes.**
   `runManaged` clears `currentHandle`, title and `runActive` after `done` without awaiting `closed`.
   A submission arriving during stored-run reconciliation waits on `currentSettlement`, then starts
   a new turn instead of steering a settled queue. `setHandle` separately retains the physical lease
   until `closed`, while `driveHandle.closed` still awaits both the protocol handle and its event
   pump. Production: `packages/code/src/run-host.ts` (`runManaged`, `currentSettlement`,
   `physicalHandles`) and `packages/code/src/adapters/kernel-run-client.ts` (`driveHandle`). Test:
   `packages/code/tests/component/run-host.test.ts` ("done releases interactive ownership before the
   post-run event stream closes") and
   `packages/code/tests/component/kernel-run-client.test.ts`.

5. **A settle only writes back if the session object and the ownership epoch are both unchanged.**
   Three checks: `packages/code/src/run-host.ts`, plus the ownership/sink check in
   `finally`. Pinned: `packages/code/tests/component/run-host.test.ts` (a torn-down
   run settling after the next one started emits no attention cue).

6. **A cancel request is refused once the run is no longer active, and refused twice in a row.**
   `if (!currentHandle || !runActive() || cancelRequested) return false`
   (`packages/code/src/run-host.ts`). Pinned:
   `packages/code/tests/component/run-host.test.ts`.

7. **A failed `handle.cancel()` re-arms cancellation instead of leaving the run un-cancellable.**
   `cancelRequested = false` in the catch (`packages/code/src/run-host.ts`). Pinned:
   `packages/code/tests/component/run-host.test.ts` (`cancelCurrentRun()` succeeds again).

8. **A memory-ingest notice whose `execution_id` is not the status line's current owner never touches
   the display.** `packages/code/src/run-host.ts`. Pinned:
   `packages/code/tests/component/run-host.test.ts`.

9. **A pending memory phase composes onto a retained base so a later terminal phase replaces rather
   than concatenates.** `memoryStatusBase` is captured only when null, and cleared on a terminal phase
   (`packages/code/src/run-host.ts`). Pinned:
   `packages/code/tests/component/run-host.test.ts`.

10. **A notice arriving while a run or a `!bash` job owns the line is held, not dropped, and replayed
    once that run releases it.** `heldIngest` (`packages/code/src/run-host.ts`) is replayed by
    `releaseInteractiveOwnership` only when the id matches. Pinned:
    `packages/code/tests/component/run-host.test.ts`.

11. **`memory: "off"` is sent on the wire; `memory: "on"` is omitted.** The spread is conditional
    (`packages/code/src/run-host.ts`) and `toStartParams` only emits truthy fields
    (`packages/code/src/adapters/kernel-run-client.ts`). Pinned:
    `packages/code/tests/component/run-host.test.ts`.

12. **A `continuation_unavailable` envelope retries once as a full run, and only when the run was not
    cancelled.** `packages/code/src/run-host.ts`. Pinned:
    `packages/code/tests/component/run-host.test.ts`.

13. **A released history is never retried as a silently partial full request.** `fullRequestMessages`
    throws when any trace is unavailable (`packages/code/src/run-host.ts`); `resumeSession`
    refuses an oversized chain with `SessionResumeLimitError` in
    `packages/code/src/adapters/session.ts`. Pinned:
    `packages/code/tests/component/run-host.test.ts`, and
    `packages/code/tests/component/session.test.ts`.

14. **History is released only after the run's trace is durably readable, for ordinary and manager
    profiles alike.** A manager still sends a complete chain: the next manager request first rebuilds
    it from persisted traces through `fullRequestMessages`. Production:
    `packages/code/src/run-host.ts` (`fullRequestMessages`, both `onStored` callbacks). Pinned:
    `packages/code/tests/component/run-host.test.ts` ("manager runs release persisted history and
    rebuild the complete chain for the next turn").

15. **A manager run always sends its complete message chain, never a `continue_from` delta.** The
    ternary at `packages/code/src/run-host.ts` sends full whenever `isManager`. Pinned:
    `packages/code/tests/component/run-host.test.ts`.

16. **`Work on task` carries only `{id, provider_key, mode}` — never a workspace or repository.**
    `packages/code/src/run-host.ts`, and `toStartParams` passes `task` through verbatim
    (`packages/code/src/adapters/kernel-run-client.ts`). Pinned:
    `packages/code/tests/component/run-host.test.ts`.

17. **The resumed active-task binding survives a continuation fallback.** `sessionTask` is set from
    `resumed.activeTask` (`packages/code/src/run-host.ts`) and spread into both the continuation
    and full-start paths. Pinned:
    `packages/code/tests/component/run-host.test.ts`.

18. **`residentTurns` never exceeds 20, and every successful structural fold produces exactly one
    frozen prefix notice.** The ordinary fold leaves 20 refs; if its boundary is refused, a
    current-turn-boundary fallback compresses the entire older prefix and leaves one. If both folds
    are refused, the speculative ref is rolled back.
    Production: `packages/code/src/run-host.ts` (`RESIDENT_TRANSCRIPT_TURN_LIMIT`,
    `rememberResidentTurn`, `loadSessionMeta`) and `packages/code/src/adapters/store.ts`
    (`foldPrefixBefore`). Pinned by `packages/code/tests/component/run-host.test.ts` (resident-turn
    retention) and `packages/code/tests/component/run-host-export.test.ts` (25-turn resident/export
    round trip).

19. **`foldedTurnCount` advances only when the store actually folds a prefix.** Both ordinary and
    fail-bounded fallback calls must return `true`; double refusal leaves the scalar unchanged.
    Production: `packages/code/src/run-host.ts` (`rememberResidentTurn`) and
    `packages/code/src/adapters/store.ts` (`foldPrefixBefore`). Pinned by
    `packages/code/tests/unit/store-status.test.ts` ("foldPrefixBefore rejects absent and first-node
    boundaries without mutating the transcript").

20. **An export never fails because of one missing trace.** Every fetch failure becomes a node or a
    notice (`packages/code/src/run-host.ts`). Pinned:
    `packages/code/tests/component/run-host-export.test.ts`.

21. **An export lazily indexes canonical `SessionMeta.turns` and yields one folded turn at a time, so
    a second copy of the session is never resident.** Production: `packages/code/src/run-host.ts`
    (`exportNodeBatches`). Pinned by `packages/code/tests/component/run-host-export.test.ts` ("folded
    export reads the canonical turn index one item at a time" and "folded turns are yielded one at a
    time before the bounded live window").

22. **A session that still fits the resident window exports `store.nodes` itself, refetching nothing.**
    `packages/code/src/run-host.ts`. Pinned by object identity at
    `packages/code/tests/component/run-host-export.test.ts` and by the read count
    (exactly 5 reads for 5 folded turns).

23. **A released user block is never exported using a persisted prompt that does not match what was
    displayed.** The `sourceTextFingerprint` comparison at `packages/code/src/run-host.ts`.
    Pinned: `packages/code/tests/component/run-host-export.test.ts`.

24. **Prompt-history seeding includes conversation turns only: resident conversations use rehydrated
    content and folded conversations use their canonical, already-redacted preview; transcript-only
    turns seed neither path.** Production: `packages/code/src/run-host.ts` (`loadSessionMeta`). Pinned
    for the resident conversation case by `packages/code/tests/component/run-host.test.ts` ("resume
    seeds prompt history from the rehydrated user content, not userPreview").

25. **`memory_ingest` is status-line material and never enters the transcript.**
    `packages/code/src/adapters/kernel-run-client.ts`. Pinned:
    `packages/code/tests/component/kernel-run-client.test.ts`.

26. **`capabilities` is readable across the reconnect window, but still throws before the first
    connect.** `currentCapabilities` returns `lastCapabilities` when the kernel is gone
    (`packages/code/src/adapters/kernel-run-client.ts`). Pinned:
    `packages/code/tests/component/kernel-run-client.test.ts`.

27. **Reconnect preparation succeeds before releasing a healthy adapter.**
    Connection recovery and explicit idle reload carry different intents; a refused transition
    preserves the original client. Production: `prepareReconnect`, `reconnect` in
    `packages/code/src/adapters/kernel-run-client.ts`. Test:
    `packages/code/tests/component/kernel-run-client.test.ts` and
    `packages/code/tests/component/workspace-client-manager.test.ts`.

28. **A run's usage is counted at most once per execution id.** The `counted` set is shared by
    `createSession`'s `endTurn` and `reconcile` paths in `packages/code/src/adapters/session.ts`.
    Pinned:
    `packages/code/tests/component/session.test.ts`, and
    `packages/code/tests/component/run-host.test.ts` (`totals` equals exactly one run's).

29. **Session writes are coalesced last-write-wins per id.** `enqueue` in
    `createSessionStore` (`packages/code/src/adapters/session-store.ts`) retains only the newest not-yet-started
    mutation. Pinned: `packages/code/tests/component/session-store.test.ts` (1,000 saves → 2
    physical writes, `"0"` then `"999"`).

30. **The lane is deleted in the same async continuation that observed an empty queue.** The
    `enqueue` drain in `createSessionStore` owns this transition. Pinned:
    `packages/code/tests/component/session-store.test.ts`.

31. **At most 8 complete session documents stay resident, and a session with a live write lane is
    never demoted.** `MAX_RESIDENT_FULL_SESSIONS` and `demoteOldFullSessions` in
    `packages/code/src/adapters/session-store.ts`. Pinned:
    `packages/code/tests/component/session-store.test.ts`.

32. **A session preview is redacted on its first line and *before* truncation.** `redactPreview` in
    `packages/code/src/adapters/session-store.ts`, using `sanitizeText` re-exported from
    `@clarvis/kernel/policy`. Pinned:
    `packages/code/tests/component/session-store.test.ts`.

33. **`session-store.ts` is one of the fourteen files bound by the ASCII-source rule** (INV-247) —
    full statement owned by [hosts/code-theme.md](code-theme.md) §5. Every glyph in it goes
    through the imported `glyph()` helper (used by `redactPreview`).

34. **`resumeSession` releases each batch's `RunDetail` objects before fetching the next batch, and
    never exceeds 6 concurrent fetches.** Projection happens inside `resumeSession`'s `fetchBatch`;
    `FETCH_CONCURRENCY = 6` in `packages/code/src/adapters/session.ts`. Pinned:
    `packages/code/tests/component/session.test.ts` (WeakRef + `Bun.gc(true)`).

35. **A collapsed turn and a degraded turn are counted in exactly one bucket each.**
    `resumeSession` in `packages/code/src/adapters/session.ts`. Pinned:
    `packages/code/tests/component/session.test.ts`.

36. **`resumeSession` does not mutate a fetched run's own `messages` array.** The chain is rebuilt with
    spreads inside `resumeSession` in `packages/code/src/adapters/session.ts`. Pinned:
    `packages/code/tests/component/session.test.ts`.

37. **A plan projection survives an end-of-run reconcile unless the replay carried a newer plan
    event.** `packages/code/src/adapters/activity-store.ts` (activity) and
    `packages/code/src/adapters/store.ts` (transcript). Pinned:
    `packages/code/tests/unit/run-end-reconcile.test.ts`.

38. **One live event, however many store writes it makes, propagates once.** `onEvent`'s `batch`
    (`packages/code/src/run-host.ts`) and `settleRun`'s
    (`packages/code/src/adapters/store.ts`).
    Pinned: `packages/code/tests/component/reactive-batching.test.ts`.

39. **The RSS fuse never exits the process; a trip cancels once and leaves an explicitly recoverable
    state.** `cancelRun()` is called exactly once per trip
    (`packages/code/src/adapters/memory-pressure.ts`). Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts`.

40. **A run that ignores cancellation cannot leave the fuse stuck aborting.** After
    `MEMORY_PRESSURE_ABORT_GRACE_MS = 10_000`, `forceStopRun()` fires once and the phase advances to
    `tripped` (`packages/code/src/adapters/memory-pressure.ts`). Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts`.

41. **Recovery is single-flight and time-bounded, and a late-succeeding rebuild still rearms.**
    `packages/code/src/adapters/memory-pressure.ts`. Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts`.

42. **A disabled fuse (`limitBytes === 0`) installs no timer.**
    `packages/code/src/adapters/memory-pressure.ts`. Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts`.

43. **The sampler timer is unref'd.** `packages/code/src/adapters/memory-pressure.ts`. Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts`.

44. **The stream-metrics sink never takes the process down and never writes to a terminal stream.**
    `appendFileSync` inside a `try {} catch {}` (`packages/code/src/adapters/stream-metrics.ts`)
    to a file path only. Pinned: `packages/code/tests/integration/stream-metrics.test.ts`.

45. **`createStreamMetrics` is exported so it can be reached without a cache-busting dynamic import.**
    `packages/code/src/adapters/stream-metrics.ts` (the memo is). The reasoning is
    stated in the file's own TSDoc. Its twin in `@clarvis/llm` must stay
    token-identical modulo the `source` default — enforced by
    `tooling/tests/architecture/stream-metrics-drift.test.ts` ("the normalizer permits only the
    owner-specific default" and "the two production stream metrics implementations stay
    token-identical"); that rule belongs to
    [cross-cutting/test-architecture.md](../cross-cutting/test-architecture.md).

46. **The automatic entry-agent fallback prefers `marshall`, then the alphabetically-first runnable
    Lead, and never a sub-agent.** `packages/code/src/adapters/active-agent.ts`. Pinned:
    `packages/code/tests/unit/active-agent.test.ts` (a headless-only fleet resolves to
    `""`).

47. **The active agent resolves the session's Agent Profile → runnable configured default → automatic
    fallback, and re-resolves whenever the Agent Profile list stops containing the current name. When
    that invalidated current name falls back to another available Agent Profile, the replacement is
    persisted into the live session so resume metadata continues to name the agent that will execute
    the conversation.** Production: `packages/code/src/adapters/active-agent.ts`
    (`activeAgentCatalogTransition`, `createActiveAgentStore`) and `packages/code/src/run-host.ts`
    (`setSessionProfile`). Test: `packages/code/tests/unit/active-agent.test.ts` ("an invalidated active
    agent fallback is persisted, but initial resolution is not").

48. **The connection label is a projection and never a channel** — the doctor probe derives from the
    same `ConnectionState` (`packages/code/src/adapters/connection-state.ts`), and the
    failed label never mentions MCP. Pinned:
    `packages/code/tests/unit/connection-state.test.ts`.

49. **`memoryState` is a single tri-state rule shared by every surface**, and `modelResolves` treats a
    provider with no enumerated `models` map as resolving.
    `packages/code/src/adapters/execution-safety.ts` (`memoryState`, `modelResolves`). Pinned by
    `packages/code/tests/unit/execution-safety.test.ts` ("is on only when the extraction model
    reaches a declared provider" and inert-state cases).

50. **Isolation is derived independently from Review.** A Docker or Podman runtime wins over native
    Sandbox state; otherwise an enabled native Sandbox is `sandbox` and absence/disablement is
    `host`. Guard mode cannot change that result. Production:
    `packages/code/src/adapters/execution-safety.ts` (`deriveIsolation`, `deriveRunControls`). Pinned:
    `packages/code/tests/unit/execution-safety.test.ts` ("derives isolation independently from
    command review").

51. **`@clarvis/code`'s adapters never import from `ui/` or `views/`** (INV-244) — full statement
    owned by [hosts/code-bootstrap.md](code-bootstrap.md) §5. This is why
    `TranscriptStoreDeps.describeToolCall` is injected rather than imported
    (`packages/code/src/adapters/store.ts`).

52. **Every `@clarvis/kernel` import in this scope uses one of the six sanctioned entrypoints**
    (INV-251) — full statement owned by [hosts/code-bootstrap.md](code-bootstrap.md) §5. In
    scope: `@clarvis/kernel/policy` (the imports in `packages/code/src/adapters/event-span.ts` and
    `packages/code/src/adapters/session-store.ts`), `@clarvis/kernel/config`
    (`packages/code/src/adapters/kernel-run-client.ts`,
    `packages/code/src/adapters/execution-safety.ts`), `@clarvis/kernel/bootstrap`
    (`packages/code/src/adapters/workspace-client-manager.ts`).

53. **`WorkspaceClientManager.open` only opens the process-pinned workspace and its `release` is an
    idempotent no-op.** The manager owns a connection to the independent host, and `close` is
    idempotent. A refused restart leaves the run adapter's current client intact. Production:
    `packages/code/src/adapters/workspace-client-manager.ts` (`WorkspaceClientManager.open`,
    `invalidate`, and `close`). Test:
    `packages/code/tests/component/workspace-client-manager.test.ts` ("opens only the process-pinned
    workspace") and `packages/code/tests/component/kernel-run-client.test.ts` ("a refused host
    reload leaves the connected client usable").

54. **Prompt history reads at most the last 8 MiB of its file and tolerates a corrupt line.**
    `packages/code/src/adapters/file-prompt-history.ts`. Pinned:
    `packages/code/tests/integration/input-editor.test.ts` — "a corrupt line is skipped, the rest of
    the file still loads" and "loads only the bounded tail of a sparse oversized file" call
    `createFilePromptHistory` directly (imported) and assert both behaviors against the real
    filesystem adapter.

55. **`metaToSession` refuses a session with no project identity.**
    `metaToSession` in `packages/code/src/adapters/session-store.ts` throws
    `"session project identity is required"`. Effectively pinned only indirectly through
    `packages/code/tests/component/session-store.test.ts`, which always supplies one — the throw
    itself is unpinned.

56. **Isolation and command review are independently derived: an explicit Docker or Podman runtime
    wins over the native Sandbox block, while `guardMode` remains an orthogonal field; every
    container safety description includes that guard consequence.** Production:
    `packages/code/src/adapters/execution-safety.ts` (`deriveIsolation`, `deriveRunControls`,
    `safetyDescription`). Pinned: `packages/code/tests/unit/execution-safety.test.ts`.

57. **An elicitation's structured `detail` reaches the UI only when the kernel sent one, and the
    kernel is always answered, even when no handler is registered or the handler throws.**
    `wireElicit` (`packages/code/src/adapters/kernel-run-client.ts`) spreads `detail` only
    if `req.detail !== undefined`, falls back to `{action:"decline"}` with no `onElicit`, and to `{action:"cancel"}` on a thrown handler. Pinned:
    `packages/code/tests/component/kernel-run-client.test.ts`.

58. **The active-agent list uses the kernel-owned display order, so `/agent` and Settings > Agents
    present the fleet identically: shipped order first, then custom names alphabetically.**
    Production: `packages/code/src/adapters/active-agent.ts`. Test:
    `packages/code/tests/unit/active-agent.test.ts` (`"agent list uses the same canonical presentation
    order as the Agents window"`).

59. **Compaction progress reflects actual work, not a queued acknowledgement or replay.** A current
    execution's live `compaction_started` event sets `compactionActive`; `compaction`,
    `compaction_skipped`, `run_ended`, teardown, and run settlement clear it. A direct settled-run
    request brackets its own `client.compact` promise.
    Production: `packages/code/src/run-host.ts` (`onEvent`, `compactCurrentRun`, `teardownRuns`,
    `runManaged`) and `packages/code/src/views/App.tsx` (`useSpinnerClock`, `Footer.status`). Test:
    `packages/code/tests/component/run-host.test.ts` ("compactCurrentRun queues on a live run and
    compacts the latest settled context").

60. **Session continuity never disguises an Extension Profile change.** Every new turn records the
    process-pinned Extension Profile id and fingerprint; a resume under a different snapshot keeps the
    historical data intact, continues normally, and presents an explicit warning in both transcript
    and status. An idle trust mutation refreshes that process identity from the recomposed kernel
    before returning. Production: `packages/code/src/adapters/session.ts` (`beginTurn`, `reconcile`),
    `packages/code/src/run-host.ts` (`loadSessionMeta`), and
    `packages/code/src/adapters/kernel-run-client.ts` (`mutateTrust`). Test:
    `packages/code/tests/component/session.test.ts` ("beginTurn stamps the selected Extension Profile and
    reconcile adopts the persisted run snapshot") and
    `packages/code/tests/component/run-host.test.ts` ("loadSessionMeta warns when the active
    Extension Profile differs from the persisted turn"), plus
    `packages/code/tests/component/kernel-run-client.test.ts` (trust transitions refresh the
    process-pinned identity).

61. **Active cumulative usage has one complete owner scope: the persisted full-session baseline
    captured before the run plus that run's live delta.** Resident transcript replays contribute to
    `ActivityStore.usage` for diagnostics but never claim `currentUsage`, so folding or reopening a
    session cannot change the footer total. The current sink claims a zero delta before first paint,
    so the previous run cannot flash twice. A missing cache split remains absent in both scopes;
    numeric zero remains a measured value. Production: `packages/code/src/run-host.ts`
    (`sessionUsageBaseline`, `runManaged`) and `packages/code/src/adapters/activity-store.ts`
    (`UsageActivity`, `ActivityStore`, `createActivityStore`). Tests:
    `packages/code/tests/component/run-host.test.ts` (successive pre-run baselines) and
    `packages/code/tests/unit/budget.test.ts` (measured zero, missing detail and replay ownership).

## 6. Failure modes and degradation

| Failure | Handler | Outcome |
| --- | --- | --- |
| `@`-mention image too large / unreadable | `MentionImageError` catch, `packages/code/src/run-host.ts` | status = the error message, draft restored, **no session or run created** (`packages/code/tests/component/run-host.test.ts`) |
| non-`MentionImageError` during content build | rethrown, `packages/code/src/run-host.ts` | propagates to the caller |
| `client.steer` rejects, including close-before-drain | `packages/code/src/run-host.ts` (`submitTurn`) and `packages/code/src/adapters/store.ts` (`queueSteer`, `endReconcile`) | draft restored, status `"steer failed — message restored to the input"`; if run settlement already promoted the receipt, one `Steer not delivered` warning survives reconciliation |
| `client.steer` returns a non-`"steered"` status | `packages/code/src/run-host.ts` | annotation rolled back, raw status shown |
| steer against an unknown execution id | `packages/code/src/adapters/kernel-run-client.ts` | `{status:"unknown", execution_id}` without a kernel call |
| `handle.cancel()` rejects | `packages/code/src/run-host.ts` | run stays active, `cancelRequested` re-armed, status names the transport error |
| compact with no session turn | `compactCurrentRun` in `packages/code/src/run-host.ts` | `"no session context to compact"`, no call issued |
| compact latest settled turn | `compactCurrentRun` in `packages/code/src/run-host.ts` | persisted `final_context` is replaced and status reports freed characters |
| active compaction start is replayed or belongs to another execution | `onEvent` ownership/source guard in `packages/code/src/run-host.ts` | ignored; no stale spinner is revived |
| confirmed model fit cannot reach its target | `fitCurrentContext` + `ModelView.choose` | model remains unchanged and the failure reason is shown |
| compact throws anything else | `packages/code/src/run-host.ts` | status `"compaction failed: <text>"` |
| `client.getRun` rejects after a completed run | `packages/code/src/run-host.ts` | `store.settleRun(id, ok)` runs anyway; the turn stays `done` and totals stand (`packages/code/tests/component/run-host.test.ts`) |
| run rejects before any model call | `onError` + `store.settleRun(id)` | spinners settle, session turn marked `error` |
| run fails with an envelope error | `store.appendRunFailure` (impl `packages/code/src/adapters/store.ts`) | one error node per distinct `(execId, code)`, suppressed if the same rendered text is already present |
| the kernel event stream throws mid-iteration | `reportStreamInterrupted` → `diagnosticEvent("run.stream.interrupted", …, "warn")` (`packages/code/src/adapters/kernel-run-client.ts`) | `done` still resolves; later events are silently missing from the transcript (stated in the TSDoc `@remarks`) |
| `handle.closed` rejects | `reportCloseFailure` → `diagnosticEvent("run.close.failed", …, "debug")` in `packages/code/src/adapters/kernel-run-client.ts` (`reportCloseFailure`) | swallowed after the independent physical-lifecycle observer records the failure |
| an elicitation handler throws | `reportElicitFailure` → `diagnosticEvent("elicit.handler.failed", …, "warn")` and answers `{action:"cancel"}` (`packages/code/src/adapters/kernel-run-client.ts`) | the kernel is always answered; the defect is distinguishable from a user dismissal only in the diagnostic record |
| no `onElicit` callback registered | `packages/code/src/adapters/kernel-run-client.ts` | answers `{action:"decline"}` |
| an operation issued before `connect()` | `requireKernel()` throws `"kernel run client is not connected"` (`packages/code/src/adapters/kernel-run-client.ts`) | hard failure — except `capabilities`, which returns the last descriptor |
| `getRun`/`deleteRun` hit a kernel `not_found` | `hasKernelErrorCode` (`packages/code/src/adapters/kernel-errors.ts`, called at `packages/code/src/adapters/kernel-run-client.ts`) | `null` / `false` respectively; any other error rethrows |
| a session write fails | `opts.onError?.(\`session ${kind} failed: ${message}\`)` in `createSessionStore` (`packages/code/src/adapters/session-store.ts`) | the cache keeps the optimistic value; the lane continues draining |
| a full session turn has missing/unknown `kind` | `packages/code/src/adapters/session-store.ts` (`persistedTurnKind`, called by `sessionToMeta`) | load/resume rejects instead of guessing continuation semantics; catalog summaries remain listable until the full document is loaded |
| `sessions.get` returns `null` for a cached id | `createSessionStore.load` in `packages/code/src/adapters/session-store.ts` | cache entry and LRU slot are evicted, `load` returns `null` |
| a resumed turn's trace is gone | classified `interrupted` / `trace_pruned` / `trace_unavailable` by `resumeSession` in `packages/code/src/adapters/session.ts` | the turn renders from `userPreview` with a `degraded` marker; the count shows in the status (`packages/code/src/run-host.ts`) |
| a resumed run was rebuilt from a damaged journal | `resumeSession` passes `recovery` beside the events (`packages/code/src/adapters/session.ts`); notice at `packages/code/src/run-host.ts` | the events **are** shown, with a `"warn"` partial-record notice above them |
| resumed history exceeds 16 M chars or 10 k messages | `SessionResumeLimitError` and `resumeSession` in `packages/code/src/adapters/session.ts` | the whole resume rejects; **nothing renders** (`packages/code/tests/component/session.test.ts`, "resumeSession rejects an oversized continuation chain before fetching the next batch") |
| a resume is superseded by `clearSession`/another load | `loadEpoch` guards at `packages/code/src/run-host.ts` | the stale resume writes nothing; status stays `"idle"` (`packages/code/tests/component/run-host.test.ts`) |
| resumed session's newest Extension Profile differs from the connected kernel | `packages/code/src/run-host.ts` (`loadSessionMeta`) | resume succeeds without rewriting history; a warning names the previous/current ids and fingerprint prefixes, and status includes `Extension Profile changed` |
| an export's `getRun` throws or returns `null` | `packages/code/src/run-host.ts` | replaced by an `EXPORT INCOMPLETE`/`folded — …` node; the export completes |
| prompt-history file missing or unreadable | `catch` returning `{entries: [], compact: false}` (`packages/code/src/adapters/file-prompt-history.ts`) | history starts empty |
| a corrupt prompt-history JSON line | skipped (`packages/code/src/adapters/file-prompt-history.ts`) | remaining usable history survives |
| `stream-metrics` path unwritable | `try {} catch {}` around `appendFileSync` (`packages/code/src/adapters/stream-metrics.ts`) | instrumentation silently disabled for that write |
| `gc()` unavailable or throwing during recovery | `try {} catch {}` (`packages/code/src/adapters/memory-pressure.ts`) | recovery still reports success |
| backend rebuild exceeds 10 s | timeout branch (`packages/code/src/adapters/memory-pressure.ts`) | control returns to the UI as `tripped` with an explicit message; the physical attempt continues |
| a detached UI task rejects | `detachObserved` → `diagnosticEvent("task.failed", …, "error")` before the local observer (`packages/code/src/core/tasks.ts`) | never reaches `process.emitWarning`/stderr, which would corrupt the TUI canvas (stated at `packages/code/src/core/tasks.ts`) |

## 7. Coupling

### 7.1 Outbound (runtime, static)

| Target | Importer | Forced by |
| --- | --- | --- |
| `@clarvis/kernel/policy` | `packages/code/src/adapters/event-span.ts` (`isIngestPending` behind `memoryIngestIsPending`), `packages/code/src/adapters/session-store.ts` (`sanitizeText`) | value imports; both are shared classification rules with a single kernel owner |
| `@clarvis/kernel/config` | `packages/code/src/adapters/kernel-run-client.ts` (`resolveAgentsByName`), `packages/code/src/adapters/execution-safety.ts` (`parseModelRef`, `PLANS_DEFAULTS`) | value imports |
| `@clarvis/kernel/bootstrap` | `packages/code/src/adapters/workspace-client-manager.ts` (`connectLocalKernel`) | type-only options plus a dynamic value import; `WorkspaceClientManager` connects to the independent workspace host |
| `@clarvis/paths` | `packages/code/src/adapters/file-prompt-history.ts` (`DIR_MODE`, `FILE_MODE`, `workspaceStatePaths`) | value import — the only place in this scope that names a path |
| `solid-js` / `solid-js/store` | `packages/code/src/run-host.ts`, `packages/code/src/adapters/store.ts`, `packages/code/src/adapters/activity-store.ts`, `packages/code/src/adapters/active-agent.ts`, `packages/code/src/adapters/connection-state.ts` | reactive primitives; `batch` is load-bearing (invariant 38) |
| `node:crypto` | `packages/code/src/adapters/store.ts` (`createHash` for `transcriptTextFingerprint`) | value import |
| `node:fs` | `packages/code/src/adapters/file-prompt-history.ts`, `packages/code/src/adapters/stream-metrics.ts` | value imports |

### 7.2 Outbound (type-only)

`@clarvis/protocol` is imported **type-only** everywhere in this scope — `packages/code/src/run-host.ts`;
`packages/code/src/adapters/kernel-run-client.ts`; `packages/code/src/adapters/session.ts`; `packages/code/src/adapters/session-store.ts`; `packages/code/src/adapters/activity-store.ts`;
`packages/code/src/adapters/run-reducers.ts`; `packages/code/src/adapters/run-types.ts`; `packages/code/src/core/run-types.ts`; `packages/code/src/adapters/workspace-client-manager.ts`. Only
`workspace-client-manager.ts` also holds a *value* edge into the kernel.

### 7.3 Inbound

| Consumer | What it takes | File |
| --- | --- | --- |
| `packages/code/src/runtime.tsx` | `createRunHost` and the entire dependency wiring | `runApp` |
| `packages/code/src/runtime.tsx` | one `createKernelRunClient` for the pinned workspace, with `prepareReconnect` routing connection recovery to `workspaceManager.recover` and configuration reload to `invalidate` | `createWorkspaceRunClient` |
| `packages/code/src/runtime.tsx` and `packages/code/src/startup-foundation.ts` | `WorkspaceClientManager.create`; headless and interactive modes connect to the independent application host, whose entry composes the lazy runtime factory | `bootSilentSessionStore`, `runPrintMode`, `runRefreshMode`, `runApp`, `prepareStartupFoundation` |
| `packages/code/src/runtime.tsx` | `createSessionStore`, `createTranscriptStore`, `createActivityStore`, `createConnectionState`, `createFilePromptHistory`, `createActiveAgentStore` | `runApp` |
| `packages/code/src/views/App.tsx` | `createMemoryPressureController` + `tuiRssLimitBytes`, wired to `run.active` / `run.cancel` / `run.forceStop` / `backend.reconnect` | — |
| `packages/code/src/runtime.tsx` | `runHost.teardownRuns()` supplied as the fuse's `forceStop` | `runControls.forceStop` |

### 7.4 The layering constraint

Three architecture tests hold the direction:

- `adapters/` must not import `ui/` or `views/` —
  `packages/code/tests/architecture/architecture-boundary.test.ts`. This forces
  `describeToolCall` into `TranscriptStoreDeps` (`packages/code/src/adapters/store.ts`) and thence into `RunHostDeps`
  (`packages/code/src/run-host.ts`) rather than being imported from `views/`.
- `core/` must not import `adapters/`, `solid-js`, `@clarvis/kernel` or `@clarvis/paths` —
  `packages/code/tests/architecture/architecture-boundary.test.ts`. This is why `RunProgress`
  and `MemoryIngestNotice` live in `core/run-types.ts` and are merely re-exported from
  `packages/code/src/adapters/run-types.ts`, and why `PromptHistory` is a `core` interface with a `file-prompt-history`
  adapter behind its `PromptHistoryPersistence` port (`packages/code/src/core/prompt-history.ts`).
- Only six `@clarvis/kernel` entrypoints, and no lower package —
  `packages/code/tests/architecture/dependency-boundary.test.ts`.

### 7.5 Coverage policy touching this scope

`tooling/checks/coverage.ts` sets `@clarvis/code`'s floors to 0.93 functions / 0.96 lines.
`src/adapters/run-types.ts` and `src/core/run-types.ts` are listed in the `NO_COUNTER_ALLOWLIST` as
type-only; `src/index.tsx` and `src/runtime.tsx` are allow-listed because importing either starts
application lifecycle work (`tooling/checks/coverage.ts`, `NO_COUNTER_ALLOWLIST.code`).

## 8. Open questions

- ~~**`TurnRef.error` is populated but has no wire field.**~~ **Resolved.** The reading was
  right and understated: **both** legs of the conversion dropped it, `metaToSession` on the way out
  and `sessionToMeta` on the way back, so fixing either alone would not have round-tripped. The
  unanswerable half is now answered too — the wire `Session` turn had no slot, and nothing validates
  a turn's members either: `isSession` in `packages/kernel/src/sessions/session-service.ts`
  checks identity and `Array.isArray(turns)`, there is no schema for the document, and the transport
  passes it opaquely. So an added key is not rejected on read, and a corrupt one is not caught. Both
  legs now carry `error` (`metaToSession` and `sessionToMeta` in
  `packages/code/src/adapters/session-store.ts`), the read side validates the `{code, message}` shape
  (`persistedTurnError`), and the value is masked and bounded at the producer (`redactTurnError`,
  applied by `createSession.endTurn` in `packages/code/src/adapters/session.ts`) rather than inside the converter — which keeps the
  in-memory and on-disk values identical and honours the existing `redactPreviews: false` opt-out.
  The bound is load-bearing rather than tidy: this is the first provider free text written into a
  session document, and one unbounded message could push it past `SESSION_MAX_BYTES`, after which
  the store swallows the throw and silently stops persisting that session for the rest of its life.
- **`RunHost.submitTurn`'s declared arity is 2 but the implementation's is 3.** The `skill` parameter
  (`packages/code/src/run-host.ts`) is reachable only through `submitPromptTurn`. Whether the interface
  narrowing is deliberate encapsulation or an oversight is not stated in the source.
- **`packages/code/tests/unit/active-agent.test.ts` is named "prefers runnable coder"** but the
  production preference is `marshall` (`packages/code/src/adapters/active-agent.ts`); the fixture contains no `marshall`, so
  the assertion is really testing the alphabetically-first-Lead branch. The test name and the code
  disagree; the source does not settle which is stale.
- ~~**`ActivityStore.openRun` ignores its `execId` argument.**~~ **Resolved at the type boundary:** it
  accepts only an optional `{ current?: boolean }` selector and no execution id
  (`packages/code/src/adapters/activity-store.ts`). The projection genuinely is
  process-global — it feeds the sidebar and status surfaces, which show *the* current run — so two
  sinks open at once still fold into one cumulative subagent/plan/usage state; `current: true` only
  claims ownership of the live-run usage delta. The signature no longer implies per-execution
  isolation.
  `TranscriptStore.openRun` keeps its parameter, because it really is keyed by execution: it
  namespaces every node key with it (`packages/code/src/adapters/store.ts`).
- **`ConnectionStore` and `connectionLabel` have no producer in this document's scope.** `runtime.tsx` calls
  `conn.set(...)`, but which header component consumes `connectionLabel`
  belongs to [hosts/code-bootstrap.md](code-bootstrap.md).
- **Delegated, deliberately:** transcript node kinds, segmentation, the tool-body hydration window and
  the reconcile ordering algorithm (`packages/code/src/adapters/store.ts`) belong to
  [hosts/code-transcript.md](code-transcript.md); the kernel-side session record format, cursor paging and
  rehydration event mapping belong to [hosts/sessions.md](sessions.md); the `stream-metrics`
  duplicate-drift rule and the coverage-floor machinery belong to [cross-cutting/test-architecture.md](../cross-cutting/test-architecture.md).
- **No rationale is recoverable for the specific numeric constants** `RESIDENT_TRANSCRIPT_TURN_LIMIT
  = 20`, `EXPORT_BATCH_NODE_LIMIT = 128`, `FETCH_CONCURRENCY = 6`, `MAX_RESIDENT_FULL_SESSIONS = 8`,
  `ACTIVITY_SUBAGENT_SUMMARIES_MAX = 64`, the 0.8/0.7 pressure ratios, or the two 10 s memory-pressure
  bounds. Only `ACTIVITY_SUBAGENT_SUMMARIES_MAX` carries a stated reason —
  `"Mirrors the supervision registry's maximum retained settled-child roster"`
  (`packages/code/src/adapters/activity-store.ts`) — which is unverified against `@clarvis/supervision`.
