# The run host, kernel run client and the session/activity stores

> Implemented at `packages/code/src/`. Every claim below is anchored to a file and line. Open
> questions are collected in the final section.

## 1. Purpose

`packages/code/src/run-host.ts` is the stateful bridge between a UI shell and the kernel's run stream.
It owns the in-flight `RunHandle`, the active `Session`, the status line, terminal attention cues, the
resident-turn window over the transcript, and the derived workflow projection. Its constructor
`createRunHost` (`packages/code/src/run-host.ts:329`) returns a `RunHost`
(`packages/code/src/run-host.ts:127`) whose members every shell surface — the composer, the footer,
the sidebar, the export command — drives.

Below it sit two families of module. One is the *backend adapter*:
`packages/code/src/adapters/kernel-run-client.ts` wraps a `KernelClient` (`@clarvis/protocol`) and
presents `startRun → RunHandle`, `steer`, `compact`, `getRun`, `deleteRun`, `listProfiles`, plus thin
pass-throughs for the remaining kernel services (`packages/code/src/adapters/kernel-run-client.ts:447-588`).
`packages/code/src/adapters/workspace-client-manager.ts` sits under *that*, owning the process's one
pinned file kernel; `open` accepts only that workspace, returns a no-op `release`, and `invalidate`
rebuilds the same kernel (`WorkspaceClientManager`). The other family is the *projection
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
(`packages/code/src/run-host.ts:415`, `:456`, `:639`, `:669`, `:681`, `:697`, `:709`, `:1343`,
`:1374`, `:1377`, `:1427`).

## 2. Surface

### 2.1 `RunHost` (`packages/code/src/run-host.ts:127`)

| Member | Signature | Line |
|---|---|---|
| `runActive` | `Accessor<boolean>` — true only while the current run accepts interactive control; post-run stream delivery does not keep it true | `packages/code/src/run-host.ts` (`RunHost`, `runManaged`) |
| `bashActive` | `Accessor<boolean>` | `:130` |
| `compactionActive` | `Accessor<boolean>` — live compaction pipeline state | `packages/code/src/run-host.ts` (`RunHost`) |
| `physicalWorkActive` | `Accessor<boolean>` — remains true until every run handle and local command settles | `packages/code/src/run-host.ts` (`RunHost`) |
| `memory()` | `Record<string, number \| boolean>` — host-owned sampled-memory counters | `packages/code/src/run-host.ts` (`RunHost`) |
| `runStatus` / `setRunStatus` | `Accessor<string>` / `Setter<string>` | `:137`, `:138` |
| `runStartedAt` | `Accessor<number \| null>` — current *or last* run's start, `null` before any | `:140` |
| `sessionUsageBaseline` | `Accessor<SessionTotals \| null>` — full persisted totals frozen immediately before the active run | `packages/code/src/run-host.ts` (`RunHost`, `runManaged`) |
| `workflowActivity` | `Accessor<WorkflowActivity \| null>` — current or last workflow's tree | `:145` |
| `ownsExecution` | `(executionId: string) => boolean` | `:149` |
| `onEvent` | `(event: RunEvent, source: EventSource, executionId?: string) => void` | `:150` |
| `onMemoryIngest` | `(notice: MemoryIngestNotice) => void` | `:160` |
| `cancelCurrentRun` | `() => boolean` — whether the keypress was consumed | `:161` |
| `compactCurrentRun` | `(request?: string) => Promise<void>` | `:162` |
| `inspectCurrentContext` | `(targetWindowTokens: number) => ReturnType<KernelRunClient["context"]> \| null` | `packages/code/src/run-host.ts` (`RunHost`) |
| `fitCurrentContext` | `(targetWindowTokens: number) => Promise<CompactResult \| null>` | `packages/code/src/run-host.ts` (`RunHost`) |
| `teardownRuns` | `() => void` | `:165` |
| `submitTurn` | `(content: MessageContent, display?: string) => Promise<void>` | `:166` |
| `submitPromptTurn` | `(messages, display?, skill?: {name, task?, plansMode?}) => void` | `:167`–`:171` |
| `submitSkillRun` | `(name, task, agent) => Promise<void>` | `:173` |
| `workOnTask` | `(ref: TaskRefDto, profile: string) => Promise<void>`; `profile` is an Agent Profile id | `:175` |
| `runBangCommand` | `(cmd: string) => boolean` — whether the command was accepted | `:176` |
| `clearSession` | `(opts?: { flush?: boolean }) => void` | `:177` |
| `loadSessionMeta` | `(meta: SessionMeta) => Promise<void>` | `:178` |
| `resumeSessionById` | `(id: SessionId) => Promise<void>` | `:179` |
| `exportNodeBatches` | `() => AsyncIterable<readonly TranscriptNode[]>` | `:198` |
| `sessionMeta` / `setSessionProfile` / `flushSession` | session accessors | `:199`–`:201` |
| `registerDraftRestore` | `(fn: (text, content?) => void) => void` | `:202` |

The public `submitTurn` declares **two** parameters; the implementation takes a third `skill`
argument (`packages/code/src/run-host.ts:723`) reachable only through `submitPromptTurn`
(`packages/code/src/run-host.ts:891-905`).

Exported constants: `RESIDENT_TRANSCRIPT_TURN_LIMIT = 20` (`packages/code/src/run-host.ts:225`).
Module-private: `EXPORT_BATCH_NODE_LIMIT = 128` (`:214`) and `EXPORT_INCOMPLETE_PREFIX` (`:226-227`).

### 2.2 `RunHostDeps` (`packages/code/src/run-host.ts:67-112`)

| Field | Type | Required | Line |
|---|---|---|---|
| `store` | `TranscriptStore` | yes | `:68` |
| `activity` | `ActivityStore` | yes | `:69` |
| `sessionStore` | `SessionStore` | yes | `:70` |
| `history` | `PromptHistory` | yes | `:71` |
| `client` | `Pick<KernelRunClient, "startRun"\|"steer"\|"compact"\|"getRun"\|"files"> & Partial<Pick<KernelRunClient, "context"\|"currentExtensionProfile">>` | yes | `packages/code/src/run-host.ts:72-73` |
| `elicit` | `Pick<ElicitSlot, "cancelPending">` | yes | `:74` |
| `owner` / `project` / `workspaceId` / `workspace` | `string` | yes | `:75-78` |
| `priceFor` | `(model) => CatalogCost \| undefined` | yes | `:79` |
| `activeProfile` / `setActiveProfile` | agent selection | yes | `:80-81` |
| `guardMode` / `judgePayload` / `memoryMode` | run policy | yes | `:82-84` |
| `plansMode` | `() => PlanMode` | no | `:87` |
| `planProviderKey` | `() => string \| undefined` | no | `:90` |
| `isManagerProfile` | `() => boolean` — the `workflow` grant | no | `:96` |
| `attention` | `Pick<Attention, "notify"\|"setTitle"\|"away">` | no | `:98` |
| `runBash` | `typeof runLocalBash` — tests only | no | `:100` |
| `presentStatus` | `(line: StatusLine) => string` | no | `:102` |
| `describeToolCall` | `TranscriptStoreDeps["describeToolCall"]` | no | `:111` |

`isManagerProfile`'s own TSDoc (`:91-95`) states its scope precisely: it drives only local UI (arming
the workflow-tree projection) and keeps the manager on the full-message path; "routing itself is the
kernel's decision by grant, not a client toggle" — the flag never causes `code` to route a run as a
workflow, it only tracks that the kernel already will.

Defaults applied at construction: `runBash ?? runLocalBash` (`:343`) and
`presentStatus ?? plainStatusLine` (`:344`).

### 2.3 `KernelRunClient` (`packages/code/src/adapters/kernel-run-client.ts:68`)

Constructed by `createKernelRunClient(deps: KernelRunClientDeps)`
(`packages/code/src/adapters/kernel-run-client.ts:163`). Deps: `createKernel: () => Promise<KernelClient>`,
optional `prepareReconnect`, and `callbacks` (`:126-133`).

| Member | Kind | Line |
|---|---|---|
| `project` / `workspace` | getters that throw when disconnected | `:69`, `:70`, impl `:558-563` |
| `capabilities` | getter, survives a reconnect window | `:71`, impl `:189-195`, `:555-557` |
| `connect` / `reconnect` / `dispose` | lifecycle | `:72`, `:73`, `:122`, impl `:197-215` |
| `listProfiles(prefetched?)` | `Promise<ProfileInfo[]>` | `:75-77`, impl `:225-237` |
| `startRun(input: StartRunInput)` | `RunHandle` (synchronous) | `:81`, impl `:392-395` |
| `steer({executionId, message, profile?})` | `Promise<SteerResult>` | `:84-88`, impl `:397-409` |
| `compact({executionId, request?, mechanicalTargetTokens?})` | `Promise<CompactResult>` | `packages/code/src/adapters/kernel-run-client.ts` (`KernelRunClient.compact`) |
| `context(executionId, targetWindowTokens?)` | `ReturnType<RunService["context"]>` | `packages/code/src/adapters/kernel-run-client.ts` (`KernelRunClient.context`) |
| `getRun(executionId)` | `Promise<RunDetail \| null>` | `:95`, impl `:428-435` |
| `deleteRun(executionId)` | `Promise<boolean>` | `:96`, impl `:437-445` |
| `plans` | current-plan `read` only; no retained-plan administration | `packages/code/src/adapters/kernel-run-client.ts` (`KernelRunClient.plans`, `plans`) |
| `workflows` `skills` `config` `secrets` `models` `providerAuth` `files` `sessions` `plugins` `extensionProfiles` `tasks` `storage` | thin per-method pass-throughs to `requireKernel()` | `packages/code/src/adapters/kernel-run-client.ts` (`createKernelRunClient`) |
| `currentExtensionProfile()` | the process-pinned `{id, fingerprint}` captured during `connect()` and refreshed after idle trust recomposition | `packages/code/src/adapters/kernel-run-client.ts` (`connect`, `mutateTrust`, `currentExtensionProfile`) |

`KernelRunClientCallbacks` (`:60-65`): `onEvent(event, source, executionId)`, optional
`onProgress(progress, executionId)`, `onMemoryIngest(notice)`, `onElicit(params) => Promise<ElicitResult>`.

### 2.4 Other exported surfaces in scope

| Module | Exports | Line |
|---|---|---|
| `adapters/run-types.ts` | `ProfileInfo`, `StartRunInput`, `RunHandle`, `SteerResult`, `CompactResult`; re-exports `MemoryIngestNotice`, `RunProgress` from `core/run-types.ts` | `:13`, `:32`, `:48`, `:57`, `:65`, `:10` |
| `adapters/run-reducers.ts` | `subagentCompletedOk`, `iterationTokens`, `SubagentRegistry`, `createSubagentRegistry`; re-exports `PlanTaskActivity` | `:7`, `:19`, `:38`, `:47`, `:2` |
| `adapters/activity-store.ts` | `ActivityStore`, `createActivityStore`, `UsageActivity`, `ContextActivity`, `SubagentStatus`, `ACTIVITY_SUBAGENT_SUMMARY_MAX_CHARS` (512), `ACTIVITY_SUBAGENT_SUMMARIES_MAX` (64) | `:66`, `:83`, `:42`, `:56`, `:11`, `:14`, `:16` |
| `adapters/session.ts` | `Session`, `SessionDeps`, `SessionInit`, `createSession`, `isContinuationUnavailable`, `buildSkillRunDigest`, `buildRecoveredContext`, `ResumedSession`, `ResumeDeps`, `ResumeOptions`, `resumeSession`, `deleteSession`, `SESSION_RESUME_MAX_PAYLOAD_CHARS` | `:43`, `:74`, `:85`, `:108`, `:97`, `:338`, `:371`, `:422`, `:441`, `:472`, `:585`, `:760`, `:480` |
| `adapters/session-store.ts` | `SessionId`, `NodeStatus`, `SessionTotals`, `TurnRef`, `SessionMeta`, `runStatusToNode`, `uuidv7`, `redactPreview`, `TURN_ERROR_MAX_CHARS` (2000), `redactTurnError`, `addUsageToTotals`, `uncachedInput`, `formatCostUsd`, `SessionStore`, `MAX_RESIDENT_FULL_SESSIONS` (8), `listSessionsForWorkspace`, `metaToSession`, `sessionToMeta`, `sessionSummaryToMeta`, `sessionTurnCount`, `loadSessions`, `createSessionStore` | `packages/code/src/adapters/session-store.ts` |
| `adapters/active-agent.ts` | `ActiveAgentStore`, `ActiveAgentDeps`, `AutomaticAgentCandidate`, `automaticAgentFallback`, `createActiveAgentStore` | `:16`, `:36`, `:46`, `:62`, `:77` |
| `adapters/connection-state.ts` | `ConnectionState`, `ConnectionStore`, `createConnectionState`, `connectionLabel`, `connectionProbe` | `:10`, `:16`, `:22`, `:30`, `:42` |
| `adapters/stream-metrics.ts` | `StreamMetrics`, `createStreamMetrics`, `streamMetrics` | `:30`, `:50`, `:102` |
| `adapters/memory-pressure.ts` | `MIB`, `DEFAULT_TUI_RSS_LIMIT_BYTES`, `MEMORY_PRESSURE_SAMPLE_MS`, `MEMORY_PRESSURE_ABORT_GRACE_MS`, `MEMORY_PRESSURE_RECOVERY_TIMEOUT_MS`, `MemoryPressurePhase`, `ProcessMemorySample`, `MemoryPressureSnapshot`, `MemoryRecoveryResult`, `MemoryPressureDeps`, `MemoryPressureController`, `memoryPressureAllowsSlash`, `tuiRssLimitBytes`, `createMemoryPressureController` | `:3`–`:12`, `:14`, `:17`, `:24`, `:32`, `:41`, `:59`, `:72`, `:77`, `:106` |
| `adapters/execution-safety.ts` | `SafetyPreset`, `CanonicalSafetyPreset`, `RunControlsState`, `MemoryState`, `PlanMode`, `PlanRetention`, `PlansState`, `planRetentionLabel`, `plansState`, `modelResolves`, `memoryState`, `deriveSafetyPreset`, `deriveRunControls`, `safetyDescription`, `memoryDescription`, `planRetentionDescription`, `settingsForPreset` | symbols of the same names |
| `adapters/file-prompt-history.ts` | `createFilePromptHistory(limit = 200, file = workspaceStatePaths().promptHistoryFile, options)` | `:84` |
| `adapters/workspace-client-manager.ts` | `ManagedWorkspaceClient`, `WorkspaceClientOptions`, `WorkspaceClientManager` | symbols of the same names |
| `adapters/kernel-errors.ts` | `hasKernelErrorCode(error, code): error is {code}` — the narrowing every kernel-error branch in this scope goes through | `packages/code/src/adapters/kernel-errors.ts:4-14` |

`hasKernelErrorCode` narrows **structurally** (`typeof error === "object" && error !== null && "code" in
error && (error as { code?: unknown }).code === code`, `packages/code/src/adapters/kernel-errors.ts:8-13`)
rather than by `instanceof` against a concrete `KernelError` class, which is what lets it classify a
transported error too: `KernelRunClient.getRun`/`.deleteRun` (`:428-445`) apply it to whatever the
current `KernelClient` throws, and `packages/code/tests/component/kernel-run-client.test.ts:616-622`
constructs the failure as a plain `Object.assign(new Error(...), { code: "not_found" })` — named
"transported `not_found` errors are classified structurally" — precisely because a remote kernel (a
future stdio/HTTP transport) would reconstitute its thrown error that way, not as the original class
instance. The same helper and the same test shape are reused outside this scope: `adapters/agents-store.ts:134`
(`code-domain-hubs`, `specs/hosts/code-domain-hubs.md`) and `adapters/workspace-files.ts:56` both import
it for the identical `not_found`-to-`null` pattern; this document is its one description, since
`kernel-run-client.ts` is its heaviest caller (three of the module's five call sites).

### 2.5 `StartRunInput` → wire mapping (`toStartParams`, `packages/code/src/adapters/kernel-run-client.ts:137-160`)

| `StartRunInput` field | Wire `StartRunParams` field | Emitted when |
|---|---|---|
| `executionId` | `execution_id` | always (defaulted at `:393`) |
| `messages` | `messages` | always, `?? []` |
| `profile` | `agent` | truthy |
| `continueFrom` | `continue_from` | truthy |
| `promptCacheKey` | `prompt_cache_key` | truthy |
| `guardMode` | `guard_mode` | truthy |
| `guardJudge` | `guard_judge` `{prompt, model?, on_unsure?, timeout_ms?}` | truthy |
| `memory` | `memory` | truthy |
| `plans` | `plans` | truthy |
| `task` | `task` | truthy |
| `skill` | `skill` | truthy |

`workspace` is *not* a start parameter — `packages/code/tests/component/kernel-run-client.test.ts:268`
asserts `expect(captured).not.toHaveProperty("workspace")`.

### 2.6 Environment variables read in this scope

| Variable | Read at | Meaning |
|---|---|---|
| `CLARVIS_STREAM_DEBUG` | `packages/code/src/adapters/stream-metrics.ts:104` | JSONL path for the streaming counters; unset ⇒ no-op sink |
| `CLARVIS_TUI_RSS_LIMIT_MB` | `packages/code/src/views/App.tsx:338-340` via `tuiRssLimitBytes` (`packages/code/src/adapters/memory-pressure.ts:102`) | RSS fuse limit in MiB; `0` disables |

## 3. Data and formats

### 3.1 Identifiers

| Id | Shape | Generated at |
|---|---|---|
| execution id | `"exec_" + crypto.randomUUID()` | `packages/code/src/run-host.ts:771`, `:921`, `:977`; and as a fallback in `packages/code/src/adapters/kernel-run-client.ts:393` |
| session id | UUIDv7 — 48-bit ms timestamp in bytes 0–5, `crypto.getRandomValues` over 6–15, version nibble `0x7`, variant bits `0b10` | `uuidv7` in `packages/code/src/adapters/session-store.ts` |
| transcript user-node key | `"user:" + userSeq++` | `packages/code/src/adapters/store.ts:858` |
| transcript notice key | `"notice:" + noticeSeq++` | `packages/code/src/adapters/store.ts:901` |
| local-bash node key | `"local:" + localSeq++` | `packages/code/src/adapters/store.ts:983` |
| run-scoped node key | `` `${execId}::${spanId}` `` | `packages/code/src/adapters/store.ts:1081-1083`, tool form at `:739` |
| folded-prefix node key | the literal `"transcript:folded-prefix"` | `packages/code/src/adapters/store.ts:909` |
| run-failure node key | `` `${execId}::run-failed:${error.code}` `` | `packages/code/src/adapters/store.ts:893-908` |

`uuidv7`'s version/variant bits are pinned by
`packages/code/tests/component/session-store.test.ts:75-80`.

### 3.2 `SessionMeta` — the persisted session record

Declared as `SessionMeta` in `packages/code/src/adapters/session-store.ts`.

| Field | Type | Note |
|---|---|---|
| `id` | `SessionId` | UUIDv7 |
| `title` | `string` | `redactPreview(firstUserText, { max: 80 })` in `createSession.beginTurn` (`packages/code/src/adapters/session.ts`) |
| `projectId` | `string?` | required before persistence; `metaToSession` in `packages/code/src/adapters/session-store.ts` throws without it |
| `workspace` | `string` | the workspace **id**, from `RunHostDeps.workspaceId` (`packages/code/src/run-host.ts:392-397`) |
| `owner` | `string` | |
| `createdAt` / `updatedAt` | `number` (epoch ms) | |
| `agentProfile` | `string?` | Agent Profile name |
| `turns` | `TurnRef[]` | |
| `lastExtensionProfile` | `ExtensionProfileRunRef?` | newest turn's extension snapshot, retained by catalog-only projections |
| `turnCount` | `number?` | present *only* on a catalog-only summary (`SessionMeta`, `sessionSummaryToMeta`, and `demoteOldFullSessions` in `packages/code/src/adapters/session-store.ts`) |
| `totals` | `SessionTotals` `{input, output, cached?, costUsd?}`; absent `cached` means an incomplete split, numeric zero means measured zero | `packages/code/src/adapters/session-store.ts` (`SessionTotals`) |
| `pending` | `Message[]?` | unflushed observations (`:86`) |

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

JSONL, one `JSON.stringify(text)` per line (`packages/code/src/adapters/file-prompt-history.ts:71`,
encoder at `:15`), written to `workspaceStatePaths().promptHistoryFile` (`:86`) with `FILE_MODE` and
parent `DIR_MODE` from `@clarvis/paths` (`:1`). Reads take at most the **last** 8 MiB
(`MAX_PROMPT_HISTORY_FILE_BYTES`, `:13`) and parse backwards line by line until `limit` entries are
collected (`:43`–`:59`); a partially-read first line is dropped when the tail was truncated (`:50`),
and an unparsable line is skipped without hiding the rest (`:52`–`:57`).

### 3.4 `stream-metrics` JSONL

`createStreamMetrics(path, source)` (`packages/code/src/adapters/stream-metrics.ts:50`) appends one
record per 1000 ms window (`:84`):

```
{ at, source, window_ms, counts: {…}, rates: {…}, rss, heap_used, external }
```

(`:72`–`:81`), plus, on `process.on("exit")`, a totals line `{ at, source, totals: {…} }` when any
counter fired (`:86`–`:89`). `rates` is `round(count * 1000 / elapsed)` (`:67`). An idle window still
emits a record with empty `counts`/`rates` — pinned by
`packages/code/tests/integration/stream-metrics.test.ts:101`.

### 3.5 `MemoryPressureSnapshot`

`{ phase, limitBytes, warningBytes, rearmBytes, rss, heapUsed, external, arrayBuffers, sampledAt }`
(`packages/code/src/adapters/memory-pressure.ts:49`). Thresholds are derived from the limit:
`warningBytes = floor(limit * 0.8)`, `rearmBytes = floor(limit * 0.7)` (`:6`, `:7`, `:108`, `:109`).

## 4. Behavior

### 4.1 `submitTurn` — the ordinary turn (`packages/code/src/run-host.ts:720-889`)

1. Read `deps.activeProfile()`; empty ⇒ status `"no backend yet"` and return (`:725-729`).
2. Compute `draftText = display ?? composerText(content)` (`:730`, helper at `:269-277` — the composer
   text keeps only `type: "text"` parts).
3. Resolve `@`-mention images through `buildContent`/`appendMentionImages` (`:732-736`). A
   `MentionImageError` sets the status to the error's message, calls `draftRestore` with the original
   draft, and returns **before any session or run state is created** (`:737-741`); any other error
   rethrows (`:738`).
4. **If a run is already interactively active**: this is a *steer*, not a new turn (`:743-745`). An optimistic
   `queueSteer` annotation is added only if the current sink is that execution's
   (`:746-750`); `client.steer` is awaited; a non-`"steered"` status rolls the annotation back and
   shows the raw status; a throw rolls it back, sets `"steer failed — message restored to the input"`
   and restores the draft (`:751-764`). Kernel success means the loop drained the steering message;
   a run that closes first rejects the call, restores the draft and leaves one visible
   `Steer not delivered` receipt. That live-only failure receipt survives the stored-trace
   reconciliation pass. Returns. A run whose `done` result has settled is no
   longer active here even when `closed` is still waiting on post-run memory events.
5. If `done` has settled but stored-run reconciliation is still finishing, await that semantic
   settlement and re-check `runActive`; the message is retained for a new turn and is never sent to
   the settled handle's steer queue. Production: `packages/code/src/run-host.ts` (`submitTurn`,
   `currentSettlement`). Test: `packages/code/tests/component/run-host.test.ts` ("done releases
   interactive ownership before the post-run event stream closes").
6. Otherwise create the session if absent (`loadEpoch += 1`, `createSession`) (`:766-769`).
7. Mint `executionId`, snapshot `messagesBeforeTurn`, append the user node
   (`store.appendUserMessage`) (`:771-773`).
8. If the effective plans mode is `"review"` (`skill?.plansMode ?? deps.plansMode?.()`), append a
   plan-approval notice to the transcript (`:774-781`).
9. `sess.beginTurn(msg, executionId)` stamps the process-pinned Extension Profile identity on the new turn,
   mirrors it to `SessionMeta.lastExtensionProfile`, and returns the **continuation base** — the previous
   turn's execution id. Production: `packages/code/src/adapters/session.ts` (`beginTurn`). Test:
   `packages/code/tests/component/session.test.ts` ("beginTurn stamps the selected Extension Profile and
   reconcile adopts the persisted run snapshot").
10. `rememberResidentTurn` records the turn and folds the oldest when over the limit (`:783`).
11. Collect `promptCacheKey = sess.meta()?.id`, `guardMode`, `judgePayload(guardMode)`, and `memory`
    only when the mode is `"off"` (`:784-790`).
12. `workflowRunId = executionId; setWorkflowActivity(null)` (`:794-795`).
13. Run through `runManaged` (`:836-888`): a continuation start when `continueFrom && !isManager`
    (sending only `[...pending, {role:"user", content: msg}]`), otherwise a full start
    (`:840-861`).
14. On a `continuation_unavailable` failure that was not cancelled, await `handle.closed`, set
    `"context expired — rebuilding from history…"`, and re-start full with a rebuilt history
    (`:863-875`).
15. `afterRun: sess.endTurn(envelope)` (`:878`). `onStored`: `sess.reconcile(stored)`,
    `replayRunEvents(sink, stored)`, and `sess.releaseHistory()` when a trace exists, including for a
    manager (`:879-883`). `onError`: `sess.endTurn(undefined)` and a `"cancelled"` /
    `"run error: …"` status (`:884-887`).

`fullRequestMessages` (`:796-818`) rebuilds a released history by calling `resumeSession` over
`meta.turns.slice(0, -1)` with `renderWindow: 0`; a degraded rebuild throws
`"cannot rebuild full history: N persisted run trace(s) is/are unavailable"` (`:810-813`), which
surfaces as a run-error status rather than an incomplete request —
`packages/code/tests/component/run-host.test.ts:1530-1564`.

### 4.2 `runManaged` — the single funnel (`packages/code/src/run-host.ts:602-718`)

Every run shape (`submitTurn`, `submitSkillRun`, `workOnTask`) goes through it.

| Phase | Effect | Line |
|---|---|---|
| enter | capture `ownershipEpoch = runOwnershipEpoch` | `:612` |
| enter | `transcript = store.openRun(id)`; `sink = teeSink(transcript, activity.openRun({current:true}))` | `:614-615` |
| enter | `currentSink = {executionId, sink, transcript}`; `cancelRequested = false`; `currentStatusExecId = executionId`; `memoryStatusBase = null` | `:616-619` |
| enter | clone `sess.meta()?.totals` into `sessionUsageBaseline` before the run can settle or mutate those totals | `packages/code/src/run-host.ts` (`runManaged`, `sessionUsageBaseline`) |
| enter | `diagnosticBind({execution_id})`; `setRunActive(true)`; `setRunStartedAt(Date.now())`; initial status; `attention.setTitle("running")` | `packages/code/src/run-host.ts` (`runManaged`) |
| enter | open `currentSettlement`, the semantic-reconciliation gate that does not extend `runActive` | `packages/code/src/run-host.ts` (`runManaged`, `currentSettlement`) |
| handle | `setHandle` records an independent physical-work lease and attaches its release to `handle.closed` | `packages/code/src/run-host.ts` (`runManaged`) |
| resolve | ownership re-check (`session !== sess \|\| epoch mismatch` ⇒ return) | `:669` |
| resolve | `afterRun?`; publish the outcome status; release interactive handle/title/`runActive`; replay any held ingest notice | `packages/code/src/run-host.ts` (`runManaged`, `releaseInteractiveOwnership`) |
| resolve | `client.getRun(executionId)`; on throw, `store.settleRun(id, status === "completed")` | `:673-680` |
| resolve | ownership re-check again, then `onStored(envelope, stored, sink)` | `:681-682` |
| resolve | `store.appendRunFailure` when the envelope failed with an error | `:683-684` |
| resolve | `attention.notify` when not cancelled and away | `packages/code/src/run-host.ts` (`runManaged`) |
| reject | `onError(e)`; `store.settleRun(id)`; `attention.notify("run failed")` when not cancelled and away | `:696-707` |
| finally | idempotently release interactive ownership on an error path; clear the diagnostic binding and sink; resolve `currentSettlement` without awaiting `closed` | `packages/code/src/run-host.ts` (`runManaged`, `releaseInteractiveOwnership`) |
| finally | `elicit.cancelPending()` unconditionally | `:708-716` |

`runOutcomeStatus` (`:314-319`) renders `"failed — <message>"` for a failed envelope carrying an error,
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

### 4.3 `submitSkillRun` (`packages/code/src/run-host.ts:908-958`)

Unlike `submitTurn`, an active run makes `submitSkillRun` **refuse outright** rather than steer:
`if (runActive()) { setStatus(["busy", …, "finish the current run first"]); return; }` (`:909-914`),
pinned by `packages/code/tests/component/run-host.test.ts:1788-1799` ("submitSkillRun: refuses to start
while a run is already active").

1. `profile = deps.activeProfile()` (`:915`); this is the active Agent Profile, and if there is no
   session yet, create one with `{ agentProfile: profile || undefined }` (`:916-920`) — note the
   `|| undefined`, not the bare `{ agentProfile: profile }` `submitTurn` uses (`:766-769`), so an empty
   active Agent Profile is stored as absent rather than as `""`.
2. Mint `executionId`, build the label `` `/${name} ${task}` `` (or bare `` `/${name}` `` when `task`
   is blank), append the user node, persist it through `sess.beginTranscriptTurn(label, executionId)`
   and call `rememberResidentTurn`. `beginTranscriptTurn` writes `kind: "transcript"` but does not
   append the skill's internal prompt to model history or advance the session's conversation
   continuation base.
3. `client.startRun` is composed inline — `guardMode: skillGuardMode, ...deps.judgePayload(skillGuardMode),
   ...(skillMemoryMode === "off" ? {memory: skillMemoryMode} : {})` (`:927-941`) — rather than
   through the intermediate `guardArgs` object `submitTurn` builds once and spreads at its call sites
   (`:784-791`). The composed fields are the same shape either way: `guardMode` always present,
   `memory` only when the mode is `"off"`.
4. Run through `runManaged` with `run` calling `client.startRun({ skill: {name, task}, … })` (`:929-957`).
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

### 4.4 `workOnTask` (`packages/code/src/run-host.ts:960-1019`)

1. Refuses when `runActive() || bashActive()` (`:961-966`) or when `profile.trim().length === 0`
   (`:967-970`), each with its own status message.
2. Calls `clearSession()` **unconditionally** (`:971`) — every existing session, its turns and any
   folded-prefix notice are discarded before the task-bound run starts; there is no path that preserves
   prior session state alongside a task run.
3. `deps.setActiveProfile(profile)`, bumps `loadEpoch`, sets `sessionTask = {id: ref.id, provider_key:
   ref.provider_key, mode: "work"}`, and creates a fresh `Session` with `{ agentProfile: profile }`
   (`:972-976`).
4. Mints `executionId` and a **fixed** instruction message — `` `Work on task ${ref.id} in the current
   workspace. Read the active task context, call start_task explicitly when that tool is available and
   you are ready to begin, and keep every review or completion transition explicit.` `` — displayed as
   `` `Work on task ${ref.id}` `` (`:977-984`), pinned by
   `packages/code/tests/component/run-host.test.ts:1640-1666` ("Work on task starts a fresh current-workspace
   run with only task identity and provider key").
5. `sess.beginTurn`, `rememberResidentTurn`, arms `workflowRunId`/`workflowActivity` exactly as
   `submitTurn` does (`:982-989`), then runs through `runManaged` sending the session's full message
   chain (`sess.messages()`) plus `task: sessionTask` (`:990-1007`). `afterRun`/`onStored`/`onError`
   mirror `submitTurn`'s `reconcile`/`releaseHistory` handling (`:1008-1017`).

### 4.5 Cancellation

`cancelCurrentRun` (`packages/code/src/run-host.ts:478-503`) is a two-target function:

| Situation | Result | Line |
|---|---|---|
| a `!bash` job is in flight and not yet aborted | abort it, status `"! cancelling…"`, return `true` | `:479-487` |
| a `!bash` job whose `AbortController` already fired | return `false` (so a second `^C` belongs to the quit gate) | `:483` |
| no handle, or `!runActive()`, or `cancelRequested` already | return `false`, status untouched | `:493` |
| otherwise | `cancelRequested = true`, status `"cancelling…"`, `handle.cancel()`, return `true` | `:494-502` |
| `handle.cancel()` rejects while still the current handle and active | reset `cancelRequested = false`, status `"cancel request failed — <text>"` | `:497-500` |

The `!runActive()` guard is what stops a `^C` landing in the settle instant from permanently
relabelling a completed run — `packages/code/tests/component/run-host.test.ts:709-725`.

`teardownRuns` (`:560-580`) is the hard form: it bumps `runOwnershipEpoch`, aborts bash, cancels the
handle with `cancelRequested = true`, clears `currentSink`/`currentHandle`/`workflowRunId`/
`currentStatusExecId`/`heldIngest`, sets `runActive(false)` and resets the terminal title (`:561-580`).
It is what `runtime.tsx` supplies as the memory fuse's `forceStopRun`
(`packages/code/src/runtime.tsx`, `runControls.forceStop`, consumed by
`packages/code/src/views/App.tsx`).

Unlike `runManaged`'s `finally`, `teardownRuns` does **not** await the handle's `closed` or `done`: the
cancel is fire-and-forget — `void currentHandle.cancel().catch(() => undefined)` (`:566-568`) — so a
straggling run can go on executing (and delivering events) after `teardownRuns` returns. What stops
those late deliveries from touching UI state is `runManaged`'s own ownership-epoch check (invariant 5),
not anything in `teardownRuns` itself.

### 4.6 Event routing (`onEvent`, `packages/code/src/run-host.ts:411-444`)

Everything happens inside one Solid `batch` (`:412-443`).

| Condition | Effect | Line |
|---|---|---|
| `currentSink` exists and (`executionId === undefined` or it matches) | `applyEvent(target.sink, event, source)` | `:413-418` |
| `source === "live"`, `workflowRunId !== null`, event is a workflow-projection event, and the id matches (or is absent) | fold into `workflowActivity` via `reduceWorkflowProjection` | `:439-442` |

`isWorkflowProjectionEvent` (`:377-385`) admits `workflow_run_started`, `workflow_title_updated`,
`workflow_run_progress`, `workflow_run_completed`, `workflow_run_failed`, `run_ended`.

### 4.7 Memory-ingest status composition (`onMemoryIngest`, `packages/code/src/run-host.ts:455-476`)

Three closure-scoped variables carry the state: `memoryStatusBase` (`:446`), `heldIngest` (`:447`),
`currentStatusExecId` (`:453`).

| (state, event) | → (state, effect) | Line |
|---|---|---|
| any, notice whose `execution_id !== currentStatusExecId` | dropped, no display change | `:456` |
| run or bash active | `heldIngest = notice`, `memoryStatusBase = null`; nothing shown | `:457-460` |
| idle, `memoryIngestIsPending(phase)` (`started`/`queued`) | capture the base if unset, render `base · <segment>` | `:462-471` |
| idle, terminal phase (`done`/`failed`/`blocked`) | render `(memoryStatusBase ?? runStatus()) · <segment>`, then clear the base | `:473-475` |
| a held notice whose run releases interactive ownership | replayed through `onMemoryIngest` | `:647-650` |

`memoryIngestIsPending` is imported from the code adapter
(`packages/code/src/run-host.ts:10`, `packages/code/src/adapters/event-span.ts:9-11`), which delegates
to `isIngestPending` from `@clarvis/kernel/policy`
(`packages/kernel/src/runs/memory-ingest-phase.ts:23`) — the same partition the kernel uses to decide
whether a run's stream stays open.

### 4.8 `runBangCommand` (`packages/code/src/run-host.ts:1021-1063`)

Refuses while semantic reconciliation is pending or when `bashActive()` (`:1022-1026`), lazily
creates a session (`:1027-1031`), opens the transcript's local-bash node (`store.beginLocalBash`,
`:1032`), installs an `AbortController`, sets
`bashActive`, status `"! running…"`, and runs `runBash(cmd, {cwd: workspace, signal})` through
`detachObserved` (`:1037-1061`). On settle it finishes the transcript node, appends a `"user"`-role
observation to the session **only if the session is still the same object** (`:1043`), and updates the
status only if both the controller and the session are still current (`:1044-1052`). Terminal status
words: `"! cancelled"`, `"! timed out"`, `` `! exit ${exitCode ?? "?"}` `` (`:1046-1050`).

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

### 4.10 `exportNodeBatches` (`packages/code/src/run-host.ts:1125-1309`)

Creates a **scratch** `TranscriptStore` in its own `createRoot`, with every retention cap raised to
`Number.MAX_SAFE_INTEGER` (`:1126-1140`).

| Case | Behavior | Line |
|---|---|---|
| no folded turns and no released prose | yields `store.nodes` itself (identity), then done | `:1243-1248` |
| no folded turns but released prose present | yields through `exportResidentNodes` | `:1249-1250` |
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

`exportResidentNodes` (`:1142-1241`) walks nodes, and for each released-prose node
(`isReleasedProse`, `:282-286`) resolves the source execution id (`sourceExecutionId`, `:289-292` — the
`sourceExecutionId` field for a `user` node, otherwise the key prefix before `"::"`), lazily
`loadPersisted`es that run once (`:1151-1173`), and substitutes:

| Failure | Replacement text | Line |
|---|---|---|
| no execution id | `"no persisted run identifies this block"` | `:1177-1180` |
| fetch threw | `` `run ${id} could not be fetched` `` | `:1186-1187` |
| fetch returned `null` | `` `run ${id} is no longer retained` `` | `:1188-1189` |
| user node, no recoverable prompt | `` `run ${id} has no recoverable prompt` `` | `:1190-1196` |
| user node, `sourceTextFingerprint` mismatch | `` `run ${id}'s persisted prompt does not match this displayed block` `` | `:1198-1206` |
| assistant/reasoning node absent or itself released | `` `run ${id} has no recoverable ${kind} block` `` | `:1217-1227` |

each prefixed by `EXPORT_INCOMPLETE_PREFIX` (`:226-227`, `incompleteExportNode` at `:295-301`). Batches are
flushed every `EXPORT_BATCH_NODE_LIMIT` nodes (`:1234-1240`).

The fingerprint check is real: a `/skill` user node shows the rendered command while the persisted
prompt is the skill body, so exporting the persisted content would silently substitute a different
prompt — `packages/code/tests/component/run-host-export.test.ts:205`.

### 4.11 `clearSession` (`packages/code/src/run-host.ts:1111-1123`)

`clearSession(opts?: {flush?: boolean})` bumps `loadEpoch`, calls `teardownRuns()`, then — **flush is
the default**: `if (opts?.flush !== false) session?.flush()` (`:1114`), so a caller must pass
`{flush: false}` explicitly to skip persisting the outgoing session — drops `session`/`sessionTask`,
clears `store`/`activity`, resets `foldedTurnCount`/`residentTurns`/`foldedPrefix` to `0`/empty/`0`, and
sets status to `["idle"]`. `loadSessionMeta` and `workOnTask` both rely on this full reset before
installing their own session state.

### 4.12 `loadSessionMeta` (`packages/code/src/run-host.ts:1311-1416`)

1. `epoch = ++loadEpoch`; `teardownRuns()`; `session?.flush()`; drop session/task; clear both stores
   and the fold bookkeeping (`:1312-1321`).
2. `windowStart = max(0, meta.turns.length - RESIDENT_TRANSCRIPT_TURN_LIMIT)`. When positive,
   `foldedTurnCount = windowStart`, one folded notice is appended and `foldedPrefix = 1`. The older
   turn metadata stays only in canonical `meta.turns`; it is not copied into another host array.
3. `resumeSession(meta, {getRun, currentPlanProviderKey, renderTurn}, {renderWindow: 20})`
   (`:1335-1372`). `renderTurn` drops anything whose epoch has moved on or whose index is before
   `windowStart` (`:1341-1343`), otherwise appends the user node, records the resident turn, replays the
   turn's events into `teeSink(store.openRun, activity.openRun)` and appends a **recovery notice**
   with tone `"warn"` when the record was rebuilt from a damaged journal (`:1356-1368`).
4. Post-resume epoch check (`:1377`), then `sessionTask = resumed.activeTask` and a fresh `Session`
   seeded with `historyComplete: resumed.degraded.length === 0` (`:1378-1384`).
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

`recoveryNotice` (`:245-256`) names both counts: `"partial record — this turn was rebuilt from a damaged
journal after a crash: N journal lines lost, M tool results synthesized. The run happened; this record
of it is incomplete."`, singularised per count (`:247-254`).

`resumeSessionById` (`:1418-1433`) loads the meta through `sessionStore.load`, guards its own
`requestEpoch` around the await, and reports `"session not found"` / `"resume failed: …"` (`:1419-1432`).

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
|---|---|
| `turn.status === "running"` | `"interrupted"` |
| has an `executionId` but no detail | `"trace_pruned"` |
| no `executionId` | `"trace_unavailable"` |

A turn never fetched at all (outside both the chain walk and the window) renders `collapsed: true` and
counts toward `collapsed`, never `degraded` — the test "resumeSession counts a folded-but-pruned
turn as degraded only, never as both" in `packages/code/tests/component/session.test.ts` pins that
the two totals never overlap.

### 4.14 `Session` (`createSession` in `packages/code/src/adapters/session.ts`)

| Method | Effect | Line |
|---|---|---|
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
`submitSkillRun`'s `onStored` appends as an observation (`packages/code/src/run-host.ts:947-951`). It builds the tag
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
|---|---|---|
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

### 4.18 `ActivityStore` (`packages/code/src/adapters/activity-store.ts:94`)

`openRun` takes no execution id — see §8 — and returns a `RunSink` with per-run counters
(`runInput`/`runOutput`/`runCached` plus missing-split count) that are subtracted back out of the
resident process totals on a re-open or reconcile. `usage` is that mounted-run aggregate;
`currentUsage` belongs only to the most recent sink that received a **live** `run_started`, so a
rehydrated turn can never masquerade as the active delta. `runManaged` opens that sink with
`{current: true}`, claiming an explicit zero delta before `runActive` paints; stale usage from the
previous run therefore has no frame in which to be added again. A cache value, including zero, is emitted
only while every positive-input iteration in that scope reported the split; the first omission
deletes the optional field until that run is reset.

| Span/event | Effect | Line |
|---|---|---|
| sink open with `{current: true}` | claim `currentUsage` immediately as measured zero before the run paints | `packages/code/src/adapters/activity-store.ts` (`openRun`), `packages/code/src/run-host.ts` (`runManaged`) |
| `run` / `run_started` | reset subagents and plan, reset this run's usage, remember `lead_model`; a live source also claims `currentUsage` ownership | `packages/code/src/adapters/activity-store.ts` (`openRun`) |
| `subagent` / `delegation_created` | upsert by `delegation_id`, write title + profile | `:174`–`:186` |
| `subagent` / `delegation_started` | status `running`, model, `startedAt` | `:190`–`:202` |
| `event` / any `plan_*` | fold through `reducePlanProjection`; note that a plan event appeared during a reconcile | `:205`–`:214` |
| `run` / `run_ended` | every still-`running`/`spawned` subagent becomes `done` or `error` by `reason === "completed"` | `:218`–`:226` |
| `subagent` / `delegation_completed\|failed` | status from `subagentCompletedOk`, `endedAt`, `retainSummary` | `:228`–`:243` |
| `iteration` / `iteration_completed` | accumulate gross tokens and cache-detail completeness; update `currentUsage` only for its live owner; `agent === "lead"` sets gross context, otherwise credit the subagent | `packages/code/src/adapters/activity-store.ts` (`openRun`) |
| `beginReconcile` | snapshot the plan, wipe subagents/plan, reset usage | `:268`–`:276` |
| `endReconcile` | **restore the pre-reconcile plan** unless the replay produced a plan event of its own | `:278`–`:287` |

`retainSummary` (`:128`) bounds each summary to 512 chars with a `"...[display truncated]"` suffix
(`ACTIVITY_SUMMARY_TRUNCATED_NOTICE`, declared `:17`) and keeps at most 64 summarised subagents in a
FIFO, deleting the `summary` field of the evicted ones (`:136`–`:143`).

### 4.19 `KernelRunClient` run lifecycle (`driveHandle`, `packages/code/src/adapters/kernel-run-client.ts:352`)

```
startRun ──> live.set(executionId, handleP)
             started = handleP.then(h => { wireElicit(h); return {h, pump: pumpEvents(id, h)} })
             done   = started.then(({handle}) => handle.done)
             closed = started.then(async ({handle, pump}) => { await handle.closed; await pump })
                             .catch(reportCloseFailure)
                             .finally(() => live.delete(executionId) if unchanged)
```

(`:336`–`:353`). `pumpEvents` (`:295`) diverts every `memory_ingest` event to `onMemoryIngest` and
`continue`s — it never reaches `onEvent`, pinned at
`packages/code/tests/component/kernel-run-client.test.ts:317`. Everything else goes to
`onEvent(event, "live", executionId)` and then to the progress emitter.

`wireElicit(handle)` (`:270`–`:293`) is the elicitation bridge `started` installs on every handle
before its pump begins. Each incoming `ElicitationRequest` is mapped to an `ElicitRequestParams`:
`message: req.prompt`, `kind: req.kind`, `detail: req.detail` only when the kernel sent one, and
`requestedSchema: req.schema ?? {type: "object", properties: {}}` when the kernel sent none
(`:272`–`:277`). The callback runs `detachObserved`: `callbacks.onElicit?.(params)` if registered,
else `{action: "decline"}` (`:281`); a thrown handler is caught by `reportElicitFailure`, which answers
`{action: "cancel"}` instead (`:279`–`:282`, `:265`). The result is mapped back to an
`ElicitationResponse` — `id: req.id`, `action: result.action`, `content: result.content` only when
present (`:285`–`:289`) — and sent via `handle.respond(response)` (`:290`). Both directions are
pinned by `packages/code/tests/component/kernel-run-client.test.ts:436` ("elicitation bridges
request→UI→respond") and `:513` ("a guard_confirm's structured command detail reaches the UI params",
which proves a `guard_confirm`'s `detail: {command, cwd, reason}` reaches `onElicit` verbatim).

`makeProgressEmitter` (`:213`) emits on exactly four event shapes, each with a monotonically
increasing `counter`:

| Event | Label |
|---|---|
| `iteration_started` with `agent === "lead"` | `` `iteration ${n}` `` |
| `model_retry` | `` `retrying in ${max(1, round(delay_ms/1000))}s (${attempt}/${max_retries})` `` |
| `plan_updated` with `change === "task"` | `` `plan r${revision}` `` |
| `run_ended` with a `reason` other than `completed` | `""` plus `event: {type, reason}` |

`steer` (`:368`) looks the run up in `live`; an unknown id answers `{status: "unknown", execution_id}`
without touching the kernel. Because the map holds a *promise*, a steer issued while the handle is
still starting simply awaits it — `packages/code/tests/component/kernel-run-client.test.ts:365`. Before
calling `handle.steer`, a `MessageContent` string is passed through unchanged while any other content
is wrapped as `{role: "user", content: input.message}` (`:376`–`:377`). `handle.steer` settles only
after the kernel loop drains that content; close-before-drain rejects instead of producing a false
success. On success the adapter returns `accepted: 1` — a fixed literal describing that one
drain-acknowledged request, not a count the kernel reports back
(`` return {status: "steered", execution_id: input.executionId, accepted: 1} ``, `:378`) — pinned
exactly by `packages/code/tests/component/kernel-run-client.test.ts:354`
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

`reconnect` (`packages/code/src/adapters/kernel-run-client.ts:211-215`) is strictly
`dispose() → prepareReconnect?.() → connect()`; the asserted order is create generation 1, close
generation 1, evict, then create generation 2
(`packages/code/tests/component/kernel-run-client.test.ts:801-823`).

### 4.20 `execution-safety` derivations (`packages/code/src/adapters/execution-safety.ts`)

Pure functions of `RunControlsState`, no state of their own.

`safetyDescription` (`:162`) branches first on `sandboxEnabled`: when on, it appends up to three lines
— whether the native sandbox is required or a host fallback is possible (further split by `guardMode` when
required: `"off"` reads as fully autonomous, `"auto"` as the model escalating what it judges risky,
anything else as risky actions asking first), then a filesystem line (`workspace-read-only` vs.
read-write) and a network line (`none` vs. host access) (`:163`–`:181`); when sandboxing is off, one
line branches only on `guardMode === "off"` (`:182`–`:187`).

`memoryDescription` (`:195`) is a three-way switch on `state.memory`: `"on"` reads before/after, "no
extraction model resolves" for `"inert"`, otherwise disabled-for-this-session (`:196`–`:200`).

`planRetentionDescription(retention)` describes only the completed-plan retention consequence used by
Run Controls: `keep` leaves completed plans available in the selected provider; `discard` says a
successful run deletes after recording its result and that failed, cancelled or interrupted runs
retain the plan. Planning mode is intentionally absent from this presentation helper because the
TUI changes review policy through `/plan`, not Run Controls. Pinned by
`packages/code/tests/unit/execution-safety.test.ts` (plan-retention consequence case).

`settingsForPreset(preset)` is the declared inverse of `deriveSafetyPreset`: it maps each of
the six canonical presets to an explicit `{guard, sandbox}` settings patch — `sandbox.enabled` true
for `"isolated"`/`"reviewed"`/`"protected"`; `guard.mode` `"auto"` for `"judged"`/`"reviewed"`, `"on"` for
`"approval"`/`"protected"`, else `"off"`. The round-trip is pinned by
`packages/code/tests/unit/execution-safety.test.ts`
("maps every preset to explicit guard and sandbox settings" — e.g. `settingsForPreset("free")
.sandbox?.enabled === false`, `settingsForPreset("approval").guard?.mode === "on"`).
Before any selector writes that patch, `applySafetyPreset` carries the current scope's allow/deny
lists, or the global lists into a workspace with no local policy. Selecting `reviewed` or `judged`
therefore changes judge/sandbox posture without turning every safe command into an unlisted ask.
Production: `packages/code/src/features/run/safety-presets.ts` (`applySafetyPreset`) and
`packages/code/src/views/config/RunControlsPanel.tsx` (`applyGuard`). Tests:
`packages/code/tests/unit/safety-presets.test.ts` and
`packages/code/tests/integration/run-controls-render.test.tsx`.

### 4.21 Memory-pressure state machine (`packages/code/src/adapters/memory-pressure.ts:193`)

Sampled every `MEMORY_PRESSURE_SAMPLE_MS = 500` ms by an unref'd interval (`:229`, `:230`).

| State | Sample condition | → State | Effect |
|---|---|---|---|
| any, `limitBytes === 0` | — | `disabled` | publish only (`:169`) |
| `recovering` / `tripped` | — | unchanged | publish the fresh memory reading (`:172`, `:173`) |
| `aborting` | run active and `elapsed < 10_000` ms | `aborting` | at `elapsed >= grace`, call `forceStopRun()` once (`:177`–`:180`) |
| `aborting` | run inactive, or grace elapsed | `tripped` | `:181`–`:184` |
| `cooling` | `rss < rearmBytes` on 3 consecutive samples | `armed` | reset the counter (`:187`–`:193`) |
| `armed` / `warning` | `rss >= limitBytes` | `aborting`, then `tripped` if the run is already inactive | `deps.cancelRun()` exactly once per trip (`:196`–`:202`) |
| `armed` / `warning` | `rss >= warningBytes` | `warning` | `:203` |
| `armed` / `warning` | otherwise | `armed` | `:203` |

`blocked()` is true for `aborting`, `tripped`, `recovering`, `cooling` (`:96`, `:225`).
`memoryPressureAllowsSlash` (`:72`) permits exactly `clear`, `quit`, `exit`, `recover-memory` (`:69`).

`recover()` (`:238`) is guarded in two stages, checked in this order, and the guard is keyed on
`recoveryAttempt`, not on `phase`:

1. `recoveryAttempt !== null` (`:239`–`:247`) refuses first, with one of two messages: "memory recovery
   is already in progress" while `phase === "recovering"`, or "backend recovery is still pending after
   its timeout; restart clarvis if it does not finish" otherwise — the second message covers a prior
   `recover()` call that timed out (below) while its underlying `deps.reconnect()` promise is still
   outstanding. That window can occur while `phase` has already reverted to `"tripped"` (see the
   timeout branch), so this stage's refusal is not implied by the phase check that follows it.
2. Only once `recoveryAttempt` is `null` does `phase !== "tripped"` refuse (`:248`–`:258`), with a
   phase-specific message.

Past both guards, `recover()` publishes `recovering`, races `deps.reconnect()` against a 10 s timeout
(`:260`–`:286`), and:

- on timeout → back to `tripped`, but the in-flight attempt stays single-flight and, if it later
  succeeds while still `tripped`, advances through `finishRecovery()` (`:288`–`:307`);
- on rejection or a `{ok:false}` result → back to `tripped` (`:311`–`:321`);
- on success → `finishRecovery()`: best-effort `gc()` inside a `try`, reset counters, publish
  `cooling`, sample once (`:206`–`:221`).

Every publish emits `diagnosticCount("memory.sample", …)`, and a phase *change* additionally emits
`diagnosticEvent("memory.phase", …)` at `warn` for `aborting`/`tripped` and `info` otherwise
(`:150`–`:163`).

## 5. Invariants

The following are derived directly from this document's own source and its tests.

1. **A run event only reaches the transcript sink whose execution it names.** `onEvent` writes only
   when `executionId === undefined || target.executionId === executionId`
   (`packages/code/src/run-host.ts:413-418`). Pinned:
   `packages/code/tests/component/run-host.test.ts:256-279`.

2. **Only live events feed the workflow projection.** The fold is gated on `source === "live"`
   (`packages/code/src/run-host.ts:418`, `:439-442`), so a rehydration replay never mutates
   `workflowActivity`. Pinned: `packages/code/tests/component/run-host.test.ts:445-467`.

3. **A plain (non-manager) run leaves `workflowActivity` null.** `workflowRunId` is only set on the
   `submitTurn`/`workOnTask` paths (`packages/code/src/run-host.ts:794-795`, `:988-989`) and the
   projection is still gated by the event predicate (`:377-385`). Pinned:
   `packages/code/tests/component/run-host.test.ts:469-478`.

4. **A settled result releases interactive ownership before its post-run event stream closes.**
   `runManaged` clears `currentHandle`, title and `runActive` after `done` without awaiting `closed`.
   A submission arriving during stored-run reconciliation waits on `currentSettlement`, then starts
   a new turn instead of steering a settled queue. `setHandle` separately retains the physical lease
   until `closed`, while `driveHandle.closed` still awaits both the protocol handle and its event
   pump. Production: `packages/code/src/run-host.ts` (`runManaged`, `currentSettlement`,
   `physicalHandles`) and `packages/code/src/adapters/kernel-run-client.ts` (`driveHandle`). Test:
   `packages/code/tests/component/run-host.test.ts` ("done releases interactive ownership before the
   post-run event stream closes") and
   `packages/code/tests/component/kernel-run-client.test.ts:206`.

5. **A settle only writes back if the session object and the ownership epoch are both unchanged.**
   Three checks: `packages/code/src/run-host.ts:669`, `:681`, `:697`, plus the ownership/sink check in
   `finally` (`:709`). Pinned: `packages/code/tests/component/run-host.test.ts:2229-2251` (a torn-down
   run settling after the next one started emits no attention cue) and `:888-920`.

6. **A cancel request is refused once the run is no longer active, and refused twice in a row.**
   `if (!currentHandle || !runActive() || cancelRequested) return false`
   (`packages/code/src/run-host.ts:493`). Pinned:
   `packages/code/tests/component/run-host.test.ts:693-725`.

7. **A failed `handle.cancel()` re-arms cancellation instead of leaving the run un-cancellable.**
   `cancelRequested = false` in the catch (`packages/code/src/run-host.ts:497-500`). Pinned:
   `packages/code/tests/component/run-host.test.ts:727-745` (`cancelCurrentRun()` succeeds again).

8. **A memory-ingest notice whose `execution_id` is not the status line's current owner never touches
   the display.** `packages/code/src/run-host.ts:456`. Pinned:
   `packages/code/tests/component/run-host.test.ts:623-661`.

9. **A pending memory phase composes onto a retained base so a later terminal phase replaces rather
   than concatenates.** `memoryStatusBase` is captured only when null, and cleared on a terminal phase
   (`packages/code/src/run-host.ts:462-475`). Pinned:
   `packages/code/tests/component/run-host.test.ts:498-586`.

10. **A notice arriving while a run or a `!bash` job owns the line is held, not dropped, and replayed
    once that run releases it.** `heldIngest` (`packages/code/src/run-host.ts:447`) is replayed by
    `releaseInteractiveOwnership` only when the id matches (`:647-650`). Pinned:
    `packages/code/tests/component/run-host.test.ts:588-609`.

11. **`memory: "off"` is sent on the wire; `memory: "on"` is omitted.** The spread is conditional
    (`packages/code/src/run-host.ts:790`, `:941`, `:1003`) and `toStartParams` only emits truthy fields
    (`packages/code/src/adapters/kernel-run-client.ts:155`). Pinned:
    `packages/code/tests/component/run-host.test.ts:480-496`.

12. **A `continuation_unavailable` envelope retries once as a full run, and only when the run was not
    cancelled.** `packages/code/src/run-host.ts:863-875`. Pinned:
    `packages/code/tests/component/run-host.test.ts:1436-1465`.

13. **A released history is never retried as a silently partial full request.** `fullRequestMessages`
    throws when any trace is unavailable (`packages/code/src/run-host.ts:796-813`); `resumeSession`
    refuses an oversized chain with `SessionResumeLimitError` in
    `packages/code/src/adapters/session.ts`. Pinned:
    `packages/code/tests/component/run-host.test.ts:1530-1564`, `:2070-2101`, and
    `packages/code/tests/component/session.test.ts:949-979`.

14. **History is released only after the run's trace is durably readable, for ordinary and manager
    profiles alike.** A manager still sends a complete chain: the next manager request first rebuilds
    it from persisted traces through `fullRequestMessages`. Production:
    `packages/code/src/run-host.ts` (`fullRequestMessages`, both `onStored` callbacks). Pinned:
    `packages/code/tests/component/run-host.test.ts` ("manager runs release persisted history and
    rebuild the complete chain for the next turn").

15. **A manager run always sends its complete message chain, never a `continue_from` delta.** The
    ternary at `packages/code/src/run-host.ts:841-861` sends full whenever `isManager`. Pinned:
    `packages/code/tests/component/run-host.test.ts:1566-1638`.

16. **`Work on task` carries only `{id, provider_key, mode}` — never a workspace or repository.**
    `packages/code/src/run-host.ts:974`, and `toStartParams` passes `task` through verbatim
    (`packages/code/src/adapters/kernel-run-client.ts:157`). Pinned:
    `packages/code/tests/component/run-host.test.ts:1640-1666`.

17. **The resumed active-task binding survives a continuation fallback.** `sessionTask` is set from
    `resumed.activeTask` (`packages/code/src/run-host.ts:1378`) and spread into both the continuation
    and full-start paths (`:833`, `:858`, `:872`). Pinned:
    `packages/code/tests/component/run-host.test.ts:1668-1726`.

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
    notice (`packages/code/src/run-host.ts:1157-1162`, `:1186-1189`, `:1273-1282`). Pinned:
    `packages/code/tests/component/run-host-export.test.ts:484-510`, `:572-586`.

21. **An export lazily indexes canonical `SessionMeta.turns` and yields one folded turn at a time, so
    a second copy of the session is never resident.** Production: `packages/code/src/run-host.ts`
    (`exportNodeBatches`). Pinned by `packages/code/tests/component/run-host-export.test.ts` ("folded
    export reads the canonical turn index one item at a time" and "folded turns are yielded one at a
    time before the bounded live window").

22. **A session that still fits the resident window exports `store.nodes` itself, refetching nothing.**
    `packages/code/src/run-host.ts:1243-1250`. Pinned by object identity at
    `packages/code/tests/component/run-host-export.test.ts:158-165` and by the read count at `:240-305`
    (exactly 5 reads for 5 folded turns).

23. **A released user block is never exported using a persisted prompt that does not match what was
    displayed.** The `sourceTextFingerprint` comparison at `packages/code/src/run-host.ts:1198-1207`.
    Pinned: `packages/code/tests/component/run-host-export.test.ts:205-222`.

24. **Prompt-history seeding includes conversation turns only: resident conversations use rehydrated
    content and folded conversations use their canonical, already-redacted preview; transcript-only
    turns seed neither path.** Production: `packages/code/src/run-host.ts` (`loadSessionMeta`). Pinned
    for the resident conversation case by `packages/code/tests/component/run-host.test.ts` ("resume
    seeds prompt history from the rehydrated user content, not userPreview").

25. **`memory_ingest` is status-line material and never enters the transcript.**
    `packages/code/src/adapters/kernel-run-client.ts:321-330`. Pinned:
    `packages/code/tests/component/kernel-run-client.test.ts:325-352`.

26. **`capabilities` is readable across the reconnect window, but still throws before the first
    connect.** `currentCapabilities` returns `lastCapabilities` when the kernel is gone
    (`packages/code/src/adapters/kernel-run-client.ts:189-195`). Pinned:
    `packages/code/tests/component/kernel-run-client.test.ts:825-855`.

27. **Reconnect evicts the released host kernel before opening the replacement.**
    `dispose(); prepareReconnect?.(); connect()` (`packages/code/src/adapters/kernel-run-client.ts:211-215`).
    Pinned: `packages/code/tests/component/kernel-run-client.test.ts:801-823`.

28. **A run's usage is counted at most once per execution id.** The `counted` set is shared by
    `createSession`'s `endTurn` and `reconcile` paths in `packages/code/src/adapters/session.ts`.
    Pinned:
    `packages/code/tests/component/session.test.ts:316`, `:325`, and
    `packages/code/tests/component/run-host.test.ts:189` (`totals` equals exactly one run's).

29. **Session writes are coalesced last-write-wins per id.** `enqueue` in
    `createSessionStore` (`packages/code/src/adapters/session-store.ts`) retains only the newest not-yet-started
    mutation. Pinned: `packages/code/tests/component/session-store.test.ts:238` (1,000 saves → 2
    physical writes, `"0"` then `"999"`).

30. **The lane is deleted in the same async continuation that observed an empty queue.** The
    `enqueue` drain in `createSessionStore` owns this transition. Pinned:
    `packages/code/tests/component/session-store.test.ts:277`.

31. **At most 8 complete session documents stay resident, and a session with a live write lane is
    never demoted.** `MAX_RESIDENT_FULL_SESSIONS` and `demoteOldFullSessions` in
    `packages/code/src/adapters/session-store.ts`. Pinned:
    `packages/code/tests/component/session-store.test.ts:307-373`.

32. **A session preview is redacted on its first line and *before* truncation.** `redactPreview` in
    `packages/code/src/adapters/session-store.ts`, using `sanitizeText` re-exported from
    `@clarvis/kernel/policy`. Pinned:
    `packages/code/tests/component/session-store.test.ts:417-456`.

33. **`session-store.ts` is one of the fourteen files bound by the ASCII-source rule** (INV-247) —
    full statement owned by [hosts/code-theme.md](code-theme.md) §5. Every glyph in it goes
    through the imported `glyph()` helper (used by `redactPreview`).

34. **`resumeSession` releases each batch's `RunDetail` objects before fetching the next batch, and
    never exceeds 6 concurrent fetches.** Projection happens inside `resumeSession`'s `fetchBatch`;
    `FETCH_CONCURRENCY = 6` in `packages/code/src/adapters/session.ts`. Pinned:
    `packages/code/tests/component/session.test.ts:892-947` (WeakRef + `Bun.gc(true)`).

35. **A collapsed turn and a degraded turn are counted in exactly one bucket each.**
    `resumeSession` in `packages/code/src/adapters/session.ts`. Pinned:
    `packages/code/tests/component/session.test.ts:815-834`.

36. **`resumeSession` does not mutate a fetched run's own `messages` array.** The chain is rebuilt with
    spreads inside `resumeSession` in `packages/code/src/adapters/session.ts`. Pinned:
    `packages/code/tests/component/session.test.ts:982-994`.

37. **A plan projection survives an end-of-run reconcile unless the replay carried a newer plan
    event.** `packages/code/src/adapters/activity-store.ts:324` (activity) and
    `packages/code/src/adapters/store.ts:1680`–`:1704` (transcript). Pinned:
    `packages/code/tests/unit/run-end-reconcile.test.ts:155`.

38. **One live event, however many store writes it makes, propagates once.** `onEvent`'s `batch`
    (`packages/code/src/run-host.ts:412-443`) and `settleRun`'s
    (`packages/code/src/adapters/store.ts:1036-1052`).
    Pinned: `packages/code/tests/component/reactive-batching.test.ts:83` and `:118`.

39. **The RSS fuse never exits the process; a trip cancels once and leaves an explicitly recoverable
    state.** `cancelRun()` is called exactly once per trip
    (`packages/code/src/adapters/memory-pressure.ts:225`). Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts:50`.

40. **A run that ignores cancellation cannot leave the fuse stuck aborting.** After
    `MEMORY_PRESSURE_ABORT_GRACE_MS = 10_000`, `forceStopRun()` fires once and the phase advances to
    `tripped` (`packages/code/src/adapters/memory-pressure.ts:202`–`:209`). Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts:109`.

41. **Recovery is single-flight and time-bounded, and a late-succeeding rebuild still rearms.**
    `packages/code/src/adapters/memory-pressure.ts:264`, `:309`, `:319`–`:327`. Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts:143`.

42. **A disabled fuse (`limitBytes === 0`) installs no timer.**
    `packages/code/src/adapters/memory-pressure.ts:252`. Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts:215`.

43. **The sampler timer is unref'd.** `packages/code/src/adapters/memory-pressure.ts:255`. Pinned:
    `packages/code/tests/unit/memory-pressure.test.ts:189`.

44. **The stream-metrics sink never takes the process down and never writes to a terminal stream.**
    `appendFileSync` inside a `try {} catch {}` (`packages/code/src/adapters/stream-metrics.ts:57`–`:60`)
    to a file path only. Pinned: `packages/code/tests/integration/stream-metrics.test.ts:119`.

45. **`createStreamMetrics` is exported so it can be reached without a cache-busting dynamic import.**
    `packages/code/src/adapters/stream-metrics.ts:50` (the memo is at `:99`, `:102`). The reasoning is
    stated in the file's own TSDoc (`:41`–`:48`). Its twin in `@clarvis/llm` must stay
    token-identical modulo the `source` default — enforced by
    `tooling/tests/architecture/stream-metrics-drift.test.ts` ("the normalizer permits only the
    owner-specific default" and "the two production stream metrics implementations stay
    token-identical"); that rule belongs to
    [cross-cutting/test-architecture.md](../cross-cutting/test-architecture.md).

46. **The automatic entry-agent fallback prefers `marshall`, then the alphabetically-first runnable
    Lead, and never a sub-agent.** `packages/code/src/adapters/active-agent.ts:73`–`:76`. Pinned:
    `packages/code/tests/unit/active-agent.test.ts:12` and `:58` (a headless-only fleet resolves to
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
    same `ConnectionState` (`packages/code/src/adapters/connection-state.ts:30`, `:42`), and the
    failed label never mentions MCP. Pinned:
    `packages/code/tests/unit/connection-state.test.ts:15`, `:27`.

49. **`memoryState` is a single tri-state rule shared by every surface**, and `modelResolves` treats a
    provider with no enumerated `models` map as resolving.
    `packages/code/src/adapters/execution-safety.ts` (`memoryState`, `modelResolves`). Pinned by
    `packages/code/tests/unit/execution-safety.test.ts` ("is on only when the extraction model
    reaches a declared provider" and inert-state cases).

50. **A safety preset is reported only on an exact canonical match; anything else is `"custom"`.**
    `packages/code/src/adapters/execution-safety.ts:129`–`:134`. Pinned:
    `packages/code/tests/unit/execution-safety.test.ts:38`.

51. **`@clarvis/code`'s adapters never import from `ui/` or `views/`** (INV-244) — full statement
    owned by [hosts/code-bootstrap.md](code-bootstrap.md) §5. This is why
    `TranscriptStoreDeps.describeToolCall` is injected rather than imported
    (`packages/code/src/adapters/store.ts:321`–`:330`).

52. **Every `@clarvis/kernel` import in this scope uses one of the six sanctioned entrypoints**
    (INV-251) — full statement owned by [hosts/code-bootstrap.md](code-bootstrap.md) §5. In
    scope: `@clarvis/kernel/policy` (the imports in `packages/code/src/adapters/event-span.ts` and
    `packages/code/src/adapters/session-store.ts`), `@clarvis/kernel/config`
    (`packages/code/src/adapters/kernel-run-client.ts:1`,
    `packages/code/src/adapters/execution-safety.ts:1`), `@clarvis/kernel/bootstrap`
    (`packages/code/src/adapters/workspace-client-manager.ts:1-4,11-13`).

53. **`WorkspaceClientManager.open` only opens the process-pinned workspace and its `release` is an
    idempotent no-op.** The manager owns the one kernel lifetime; `invalidate` rebuilds that same
    workspace kernel during an explicit reconnect, and `close` itself is idempotent. Production:
    `packages/code/src/adapters/workspace-client-manager.ts` (`WorkspaceClientManager.open`,
    `invalidate`, and `close`). Test:
    `packages/code/tests/component/workspace-client-manager.test.ts` ("opens only the process-pinned
    workspace").

54. **Prompt history reads at most the last 8 MiB of its file and tolerates a corrupt line.**
    `packages/code/src/adapters/file-prompt-history.ts:13`, `:50`, `:52`–`:57`. Pinned:
    `packages/code/tests/integration/input-editor.test.ts` — "a corrupt line is skipped, the rest of
    the file still loads" and "loads only the bounded tail of a sparse oversized file" call
    `createFilePromptHistory` directly (imported at `:15`) and assert both behaviors against the real
    filesystem adapter.

55. **`metaToSession` refuses a session with no project identity.**
    `metaToSession` in `packages/code/src/adapters/session-store.ts` throws
    `"session project identity is required"`. Effectively pinned only indirectly through
    `packages/code/tests/component/session-store.test.ts:78`, which always supplies one — the throw
    itself is unpinned.

56. **`settingsForPreset` is the declared inverse of `deriveSafetyPreset` over the six canonical
    presets, including direct-host `judged` as `{sandbox.enabled:false, guard.mode:"auto"}`.**
    Production: `packages/code/src/adapters/execution-safety.ts` (`settingsForPreset`,
    `deriveSafetyPreset`). Pinned: `packages/code/tests/unit/execution-safety.test.ts`.

57. **An elicitation's structured `detail` reaches the UI only when the kernel sent one, and the
    kernel is always answered, even when no handler is registered or the handler throws.**
    `wireElicit` (`packages/code/src/adapters/kernel-run-client.ts:287`–`:310`) spreads `detail` only
    if `req.detail !== undefined` (`:276`), falls back to `{action:"decline"}` with no `onElicit`
    (`:281`), and to `{action:"cancel"}` on a thrown handler (`:265`, `:279`–`:282`). Pinned:
    `packages/code/tests/component/kernel-run-client.test.ts:436`, `:470`, `:559`.

58. **The active-agent list uses the kernel-owned display order, so `/agent` and Settings > Agents
    present the fleet identically: shipped order first, then custom names alphabetically.**
    Production: `packages/code/src/adapters/active-agent.ts:85`–`:88`. Test:
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
|---|---|---|
| `@`-mention image too large / unreadable | `MentionImageError` catch, `packages/code/src/run-host.ts:737-741` | status = the error message, draft restored, **no session or run created** (`packages/code/tests/component/run-host.test.ts:1342-1398`) |
| non-`MentionImageError` during content build | rethrown, `packages/code/src/run-host.ts:738` | propagates to the caller |
| `client.steer` rejects, including close-before-drain | `packages/code/src/run-host.ts` (`submitTurn`) and `packages/code/src/adapters/store.ts` (`queueSteer`, `endReconcile`) | draft restored, status `"steer failed — message restored to the input"`; if run settlement already promoted the receipt, one `Steer not delivered` warning survives reconciliation |
| `client.steer` returns a non-`"steered"` status | `:751-758` | annotation rolled back, raw status shown |
| steer against an unknown execution id | `packages/code/src/adapters/kernel-run-client.ts:391` | `{status:"unknown", execution_id}` without a kernel call |
| `handle.cancel()` rejects | `packages/code/src/run-host.ts:497-500` | run stays active, `cancelRequested` re-armed, status names the transport error |
| compact with no session turn | `compactCurrentRun` in `packages/code/src/run-host.ts` | `"no session context to compact"`, no call issued |
| compact latest settled turn | `compactCurrentRun` in `packages/code/src/run-host.ts` | persisted `final_context` is replaced and status reports freed characters |
| active compaction start is replayed or belongs to another execution | `onEvent` ownership/source guard in `packages/code/src/run-host.ts` | ignored; no stale spinner is revived |
| confirmed model fit cannot reach its target | `fitCurrentContext` + `ModelView.choose` | model remains unchanged and the failure reason is shown |
| compact throws anything else | `packages/code/src/run-host.ts:538-540` | status `"compaction failed: <text>"` |
| `client.getRun` rejects after a completed run | `packages/code/src/run-host.ts:673-680` | `store.settleRun(id, ok)` runs anyway; the turn stays `done` and totals stand (`packages/code/tests/component/run-host.test.ts:1240-1283`) |
| run rejects before any model call | `onError` + `store.settleRun(id)` (`:696-706`) | spinners settle, session turn marked `error` |
| run fails with an envelope error | `store.appendRunFailure` (`:683-684`, impl `packages/code/src/adapters/store.ts:893-908`) | one error node per distinct `(execId, code)`, suppressed if the same rendered text is already present |
| the kernel event stream throws mid-iteration | `reportStreamInterrupted` → `diagnosticEvent("run.stream.interrupted", …, "warn")` (`packages/code/src/adapters/kernel-run-client.ts:321-348`) | `done` still resolves; later events are silently missing from the transcript (stated in the TSDoc `@remarks` at `:337-345`) |
| `handle.closed` rejects | `reportCloseFailure` → `diagnosticEvent("run.close.failed", …, "debug")` in `packages/code/src/adapters/kernel-run-client.ts` (`reportCloseFailure`) | swallowed after the independent physical-lifecycle observer records the failure |
| an elicitation handler throws | `reportElicitFailure` → `diagnosticEvent("elicit.handler.failed", …, "warn")` and answers `{action:"cancel"}` (`packages/code/src/adapters/kernel-run-client.ts:282`) | the kernel is always answered; the defect is distinguishable from a user dismissal only in the diagnostic record |
| no `onElicit` callback registered | `packages/code/src/adapters/kernel-run-client.ts:298` | answers `{action:"decline"}` |
| an operation issued before `connect()` | `requireKernel()` throws `"kernel run client is not connected"` (`packages/code/src/adapters/kernel-run-client.ts:170-173`) | hard failure — except `capabilities`, which returns the last descriptor (`:189-195`) |
| `getRun`/`deleteRun` hit a kernel `not_found` | `hasKernelErrorCode` (`packages/code/src/adapters/kernel-errors.ts:4-14`, called at `packages/code/src/adapters/kernel-run-client.ts:428-445`) | `null` / `false` respectively; any other error rethrows |
| a session write fails | `opts.onError?.(\`session ${kind} failed: ${message}\`)` in `createSessionStore` (`packages/code/src/adapters/session-store.ts`) | the cache keeps the optimistic value; the lane continues draining |
| a full session turn has missing/unknown `kind` | `packages/code/src/adapters/session-store.ts` (`persistedTurnKind`, called by `sessionToMeta`) | load/resume rejects instead of guessing continuation semantics; catalog summaries remain listable until the full document is loaded |
| `sessions.get` returns `null` for a cached id | `createSessionStore.load` in `packages/code/src/adapters/session-store.ts` | cache entry and LRU slot are evicted, `load` returns `null` |
| a resumed turn's trace is gone | classified `interrupted` / `trace_pruned` / `trace_unavailable` by `resumeSession` in `packages/code/src/adapters/session.ts` | the turn renders from `userPreview` with a `degraded` marker; the count shows in the status (`packages/code/src/run-host.ts:1408-1414`) |
| a resumed run was rebuilt from a damaged journal | `resumeSession` passes `recovery` beside the events (`packages/code/src/adapters/session.ts`); notice at `packages/code/src/run-host.ts:1356-1368` | the events **are** shown, with a `"warn"` partial-record notice above them |
| resumed history exceeds 16 M chars or 10 k messages | `SessionResumeLimitError` and `resumeSession` in `packages/code/src/adapters/session.ts` | the whole resume rejects; **nothing renders** (`packages/code/tests/component/session.test.ts`, "resumeSession rejects an oversized continuation chain before fetching the next batch") |
| a resume is superseded by `clearSession`/another load | `loadEpoch` guards at `packages/code/src/run-host.ts:1312`, `:1343`, `:1374`, `:1377` | the stale resume writes nothing; status stays `"idle"` (`packages/code/tests/component/run-host.test.ts:2189-2227`) |
| resumed session's newest Extension Profile differs from the connected kernel | `packages/code/src/run-host.ts` (`loadSessionMeta`) | resume succeeds without rewriting history; a warning names the previous/current ids and fingerprint prefixes, and status includes `Extension Profile changed` |
| an export's `getRun` throws or returns `null` | `packages/code/src/run-host.ts:1157-1163`, `:1186-1189`, `:1273-1282` | replaced by an `EXPORT INCOMPLETE`/`folded — …` node; the export completes |
| prompt-history file missing or unreadable | `catch` returning `{entries: [], compact: false}` (`packages/code/src/adapters/file-prompt-history.ts:37`) | history starts empty |
| a corrupt prompt-history JSON line | skipped (`packages/code/src/adapters/file-prompt-history.ts:55`) | remaining usable history survives |
| `stream-metrics` path unwritable | `try {} catch {}` around `appendFileSync` (`packages/code/src/adapters/stream-metrics.ts:57`) | instrumentation silently disabled for that write |
| `gc()` unavailable or throwing during recovery | `try {} catch {}` (`packages/code/src/adapters/memory-pressure.ts:232`) | recovery still reports success |
| backend rebuild exceeds 10 s | timeout branch (`packages/code/src/adapters/memory-pressure.ts:313`) | control returns to the UI as `tripped` with an explicit message; the physical attempt continues |
| a detached UI task rejects | `detachObserved` → `diagnosticEvent("task.failed", …, "error")` before the local observer (`packages/code/src/core/tasks.ts:28`) | never reaches `process.emitWarning`/stderr, which would corrupt the TUI canvas (stated at `packages/code/src/core/tasks.ts:14`–`:20`) |

## 7. Coupling

### 7.1 Outbound (runtime, static)

| Target | Importer | Forced by |
|---|---|---|
| `@clarvis/kernel/policy` | `packages/code/src/adapters/event-span.ts` (`isIngestPending` behind `memoryIngestIsPending`), `packages/code/src/adapters/session-store.ts` (`sanitizeText`) | value imports; both are shared classification rules with a single kernel owner |
| `@clarvis/kernel/config` | `packages/code/src/adapters/kernel-run-client.ts:1` (`resolveAgentsByName`), `packages/code/src/adapters/execution-safety.ts:1` (`parseModelRef`, `PLANS_DEFAULTS`) | value imports |
| `@clarvis/kernel/bootstrap` | `packages/code/src/adapters/workspace-client-manager.ts` (`loadFileKernelFactory`) | type-only options plus a dynamic value import; `WorkspaceClientManager` owns one pinned file kernel without adding bootstrap to the eager startup graph |
| `@clarvis/paths` | `packages/code/src/adapters/file-prompt-history.ts:1` (`DIR_MODE`, `FILE_MODE`, `workspaceStatePaths`) | value import — the only place in this scope that names a path |
| `solid-js` / `solid-js/store` | `packages/code/src/run-host.ts:1`, `packages/code/src/adapters/store.ts:1-2`, `packages/code/src/adapters/activity-store.ts:1`, `packages/code/src/adapters/active-agent.ts:1`, `packages/code/src/adapters/connection-state.ts:1` | reactive primitives; `batch` is load-bearing (invariant 38) |
| `node:crypto` | `packages/code/src/adapters/store.ts:3` (`createHash` for `transcriptTextFingerprint`) | value import |
| `node:fs` | `packages/code/src/adapters/file-prompt-history.ts:2`, `packages/code/src/adapters/stream-metrics.ts:1` | value imports |

### 7.2 Outbound (type-only)

`@clarvis/protocol` is imported **type-only** everywhere in this scope — `packages/code/src/run-host.ts`;
`packages/code/src/adapters/kernel-run-client.ts`; `packages/code/src/adapters/session.ts`; `packages/code/src/adapters/session-store.ts`; `packages/code/src/adapters/activity-store.ts`;
`packages/code/src/adapters/run-reducers.ts:1`; `packages/code/src/adapters/run-types.ts:1`; `packages/code/src/core/run-types.ts:1`; `packages/code/src/adapters/workspace-client-manager.ts:7`. Only
`workspace-client-manager.ts` also holds a *value* edge into the kernel.

### 7.3 Inbound

| Consumer | What it takes | Line |
|---|---|---|
| `packages/code/src/runtime.tsx` | `createRunHost` and the entire dependency wiring | `runApp` |
| `packages/code/src/runtime.tsx` | one `createKernelRunClient` for the pinned workspace, with `prepareReconnect` bound to `workspaceManager.invalidate` | `createWorkspaceRunClient` |
| `packages/code/src/runtime.tsx` and `packages/code/src/startup-foundation.ts` | `WorkspaceClientManager.create`; ordinary run may prepare it while the complete runtime chunk loads | `bootSilentSessionStore`, `runApp`, `prepareStartupFoundation` |
| `packages/code/src/runtime.tsx` | `createSessionStore`, `createTranscriptStore`, `createActivityStore`, `createConnectionState`, `createFilePromptHistory`, `createActiveAgentStore` | `runApp` |
| `packages/code/src/views/App.tsx` | `createMemoryPressureController` + `tuiRssLimitBytes`, wired to `run.active` / `run.cancel` / `run.forceStop` / `backend.reconnect` | `:99-104`, `:338-345` |
| `packages/code/src/runtime.tsx` | `runHost.teardownRuns()` supplied as the fuse's `forceStop` | `runControls.forceStop` |

### 7.4 The layering constraint

Three architecture tests hold the direction:

- `adapters/` must not import `ui/` or `views/` —
  `packages/code/tests/architecture/architecture-boundary.test.ts:149`. This forces
  `describeToolCall` into `TranscriptStoreDeps` (`packages/code/src/adapters/store.ts:311-344`) and thence into `RunHostDeps`
  (`packages/code/src/run-host.ts:103-111`) rather than being imported from `views/`.
- `core/` must not import `adapters/`, `solid-js`, `@clarvis/kernel` or `@clarvis/paths` —
  `packages/code/tests/architecture/architecture-boundary.test.ts:128`. This is why `RunProgress`
  and `MemoryIngestNotice` live in `core/run-types.ts` and are merely re-exported from
  `packages/code/src/adapters/run-types.ts:10`, and why `PromptHistory` is a `core` interface with a `file-prompt-history`
  adapter behind its `PromptHistoryPersistence` port (`packages/code/src/core/prompt-history.ts:35`).
- Only six `@clarvis/kernel` entrypoints, and no lower package —
  `packages/code/tests/architecture/dependency-boundary.test.ts:74`, `:90`.

### 7.5 Coverage policy touching this scope

`tooling/checks/coverage.ts:29` sets `@clarvis/code`'s floors to 0.93 functions / 0.96 lines.
`src/adapters/run-types.ts` and `src/core/run-types.ts` are listed in the `NO_COUNTER_ALLOWLIST` as
type-only; `src/index.tsx` and `src/runtime.tsx` are allow-listed because importing either starts
application lifecycle work (`tooling/checks/coverage.ts`, `NO_COUNTER_ALLOWLIST.code`).

## 8. Open questions

- ~~**`TurnRef.error` is populated but has no wire field.**~~ **Resolved 2026-08-22.** The reading was
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
  (`packages/code/src/run-host.ts:723`) is reachable only through `submitPromptTurn` (`:891-905`). Whether the interface
  narrowing is deliberate encapsulation or an oversight is not stated in the source.
- **`packages/code/tests/unit/active-agent.test.ts:12` is named "prefers runnable coder"** but the
  production preference is `marshall` (`packages/code/src/adapters/active-agent.ts:75`); the fixture contains no `marshall`, so
  the assertion is really testing the alphabetically-first-Lead branch. The test name and the code
  disagree; the source does not settle which is stale.
- ~~**`ActivityStore.openRun` ignores its `execId` argument.**~~ **Resolved at the type boundary:** it
  accepts only an optional `{ current?: boolean }` selector and no execution id
  (`packages/code/src/adapters/activity-store.ts:74-82,162-183`). The projection genuinely is
  process-global — it feeds the sidebar and status surfaces, which show *the* current run — so two
  sinks open at once still fold into one cumulative subagent/plan/usage state; `current: true` only
  claims ownership of the live-run usage delta. The signature no longer implies per-execution
  isolation.
  `TranscriptStore.openRun` keeps its parameter, because it really is keyed by execution: it
  namespaces every node key with it (`packages/code/src/adapters/store.ts:1081-1083`).
- **`ConnectionStore` and `connectionLabel` have no producer in this document's scope.** `runtime.tsx` calls
  `conn.set(...)` (`:830`, `:1079`, `:1087`), but which header component consumes `connectionLabel`
  belongs to [hosts/code-bootstrap.md](code-bootstrap.md).
- **Delegated, deliberately:** transcript node kinds, segmentation, the tool-body hydration window and
  the reconcile ordering algorithm (`packages/code/src/adapters/store.ts:685`–`:848`, `:1673`–`:1729`) belong to
  [hosts/code-transcript.md](code-transcript.md); the kernel-side session record format, cursor paging and
  rehydration event mapping belong to [hosts/sessions.md](sessions.md); the `stream-metrics`
  duplicate-drift rule and the coverage-floor machinery belong to [cross-cutting/test-architecture.md](../cross-cutting/test-architecture.md).
- **No rationale is recoverable for the specific numeric constants** `RESIDENT_TRANSCRIPT_TURN_LIMIT
  = 20`, `EXPORT_BATCH_NODE_LIMIT = 128`, `FETCH_CONCURRENCY = 6`, `MAX_RESIDENT_FULL_SESSIONS = 8`,
  `ACTIVITY_SUBAGENT_SUMMARIES_MAX = 64`, the 0.8/0.7 pressure ratios, or the two 10 s memory-pressure
  bounds. Only `ACTIVITY_SUBAGENT_SUMMARIES_MAX` carries a stated reason —
  `"Mirrors the supervision registry's maximum retained settled-child roster"`
  (`packages/code/src/adapters/activity-store.ts:15`) — which is unverified against `@clarvis/supervision`.
