# The run host, kernel run client and the session/activity stores

> Implemented at `packages/code/src/`. Every claim below is anchored to a file and line. Open
> questions are collected in the final section.

## 1. Purpose

`packages/code/src/run-host.ts` is the stateful bridge between a UI shell and the kernel's run stream.
It owns the in-flight `RunHandle`, the active `Session`, the status line, terminal attention cues, the
resident-turn window over the transcript, and the derived workflow projection. Its constructor
`createRunHost` (`packages/code/src/run-host.ts:305`) returns a `RunHost`
(`packages/code/src/run-host.ts:117`) whose members every shell surface — the composer, the footer,
the sidebar, the export command — drives.

Below it sit two families of module. One is the *backend adapter*:
`packages/code/src/adapters/kernel-run-client.ts` wraps a `KernelClient` (`@clarvis/protocol`) and
presents `startRun → RunHandle`, `steer`, `compact`, `getRun`, `deleteRun`, `listProfiles`, plus thin
pass-throughs for the remaining kernel services (`packages/code/src/adapters/kernel-run-client.ts:64`).
`packages/code/src/adapters/workspace-client-manager.ts` sits under *that*, owning the process's one
pinned file kernel; `open` accepts only that workspace, returns a no-op `release`, and `invalidate`
rebuilds the same kernel (`WorkspaceClientManager`). The other family is the *projection
stores*: `adapters/store.ts` (the reactive transcript), `adapters/activity-store.ts` (subagents, plan,
usage, context), `adapters/session.ts` + `adapters/session-store.ts` (turn history and its persistence
through `SessionService`), plus small leaves — `run-reducers.ts`, `run-types.ts`, `active-agent.ts`,
`connection-state.ts`, `stream-metrics.ts`, `memory-pressure.ts`, `execution-safety.ts`,
`file-prompt-history.ts`.

The recurring problem the code solves is **ownership across asynchrony**. A run's events, its
`done` envelope, its stream close, its persisted trace, its post-run memory-ingest notice, a user's
`^C`, a session switch and a backend reconnect all arrive on independent schedules. Nearly every guard
in `run-host.ts` is an identity check — an execution id, a session object, an epoch counter — deciding
whether a late callback still owns the surface it wants to write to
(`packages/code/src/run-host.ts:372`, `:391`, `:525`, `:533`, `:552`, `:1172`, `:1231`).

## 2. Surface

### 2.1 `RunHost` (`packages/code/src/run-host.ts:117`)

| Member | Signature | Line |
|---|---|---|
| `runActive` | `Accessor<boolean>` | `:118` |
| `bashActive` | `Accessor<boolean>` | `:119` |
| `compactionActive` | `Accessor<boolean>` — live compaction pipeline state | `packages/code/src/run-host.ts` (`RunHost`) |
| `physicalWorkActive` | `Accessor<boolean>` — remains true until every run handle and local command settles | `packages/code/src/run-host.ts` (`RunHost`) |
| `memory()` | `Record<string, number \| boolean>` — host-owned sampled-memory counters | `packages/code/src/run-host.ts` (`RunHost`) |
| `runStatus` / `setRunStatus` | `Accessor<string>` / `Setter<string>` | `:120`, `:121` |
| `runStartedAt` | `Accessor<number \| null>` — current *or last* run's start, `null` before any | `:123` |
| `workflowActivity` | `Accessor<WorkflowActivity \| null>` — current or last workflow's tree | `:126` |
| `ownsExecution` | `(executionId: string) => boolean` | `:128` |
| `onEvent` | `(event: RunEvent, source: EventSource, executionId?: string) => void` | `:129` |
| `onMemoryIngest` | `(notice: MemoryIngestNotice) => void` | `:139` |
| `cancelCurrentRun` | `() => boolean` — whether the keypress was consumed | `:140` |
| `compactCurrentRun` | `(request?: string) => Promise<void>` | `:141` |
| `inspectCurrentContext` | `(targetWindowTokens: number) => ReturnType<KernelRunClient["context"]> \| null` | `packages/code/src/run-host.ts` (`RunHost`) |
| `fitCurrentContext` | `(targetWindowTokens: number) => Promise<CompactResult \| null>` | `packages/code/src/run-host.ts` (`RunHost`) |
| `teardownRuns` | `() => void` | `:142` |
| `submitTurn` | `(content: MessageContent, display?: string) => Promise<void>` | `:143` |
| `submitPromptTurn` | `(messages, display?, skill?: {name, task?, plansMode?}) => void` | `:144` |
| `submitSkillRun` | `(name, task, agent) => Promise<void>` | `:150` |
| `workOnTask` | `(ref: TaskRefDto, profile: string) => Promise<void>` | `:152` |
| `runBangCommand` | `(cmd: string) => boolean` — whether the command was accepted | `:153` |
| `clearSession` | `(opts?: { flush?: boolean }) => void` | `:154` |
| `loadSessionMeta` | `(meta: SessionMeta) => Promise<void>` | `:155` |
| `resumeSessionById` | `(id: SessionId) => Promise<void>` | `:156` |
| `exportNodeBatches` | `() => AsyncIterable<readonly TranscriptNode[]>` | `:175` |
| `sessionMeta` / `setSessionProfile` / `flushSession` | session accessors | `:176`–`:178` |
| `registerDraftRestore` | `(fn: (text, content?) => void) => void` | `:179` |

The public `submitTurn` declares **two** parameters; the implementation takes a third `skill`
argument (`packages/code/src/run-host.ts:568`) reachable only through `submitPromptTurn`
(`packages/code/src/run-host.ts:744`).

Exported constants: `RESIDENT_TRANSCRIPT_TURN_LIMIT = 20` (`packages/code/src/run-host.ts:202`).
Module-private: `EXPORT_BATCH_NODE_LIMIT = 128` (`:182`) and `EXPORT_INCOMPLETE_PREFIX` (`:185`).

### 2.2 `RunHostDeps` (`packages/code/src/run-host.ts:66`)

| Field | Type | Required | Line |
|---|---|---|---|
| `store` | `TranscriptStore` | yes | `:67` |
| `activity` | `ActivityStore` | yes | `:68` |
| `sessionStore` | `SessionStore` | yes | `:69` |
| `history` | `PromptHistory` | yes | `:70` |
| `client` | `Pick<KernelRunClient, "startRun"\|"steer"\|"compact"\|"getRun"\|"files"> & Partial<Pick<KernelRunClient, "context">>` | yes | `packages/code/src/run-host.ts` (`RunHostDeps.client`) |
| `elicit` | `Pick<ElicitSlot, "cancelPending">` | yes | `:72` |
| `owner` / `project` / `workspaceId` / `workspace` | `string` | yes | `:73`–`:76` |
| `priceFor` | `(model) => CatalogCost \| undefined` | yes | `:77` |
| `activeProfile` / `setActiveProfile` | agent selection | yes | `:78`, `:79` |
| `guardMode` / `judgePayload` / `memoryMode` | run policy | yes | `:80`–`:82` |
| `plansMode` | `() => PlanMode` | no | `:85` |
| `planProviderKey` | `() => string \| undefined` | no | `:88` |
| `isManagerProfile` | `() => boolean` — the `workflow` grant | no | `:94` |
| `attention` | `Pick<Attention, "notify"\|"setTitle"\|"away">` | no | `:96` |
| `runBash` | `typeof runLocalBash` — tests only | no | `:98` |
| `presentStatus` | `(line: StatusLine) => string` | no | `:100` |
| `describeToolCall` | `TranscriptStoreDeps["describeToolCall"]` | no | `:110` |

`isManagerProfile`'s own TSDoc (`:89`–`:93`) states its scope precisely: it drives only local UI (arming
the workflow-tree projection) and keeps the manager on the full-message path; "routing itself is the
kernel's decision by grant, not a client toggle" — the flag never causes `code` to route a run as a
workflow, it only tracks that the kernel already will.

Defaults applied at construction: `runBash ?? runLocalBash` (`:301`) and
`presentStatus ?? plainStatusLine` (`:302`).

### 2.3 `KernelRunClient` (`packages/code/src/adapters/kernel-run-client.ts:64`)

Constructed by `createKernelRunClient(deps: KernelRunClientDeps)`
(`packages/code/src/adapters/kernel-run-client.ts:148`). Deps: `createKernel: () => Promise<KernelClient>`,
optional `prepareReconnect`, and `callbacks` (`:111`).

| Member | Kind | Line |
|---|---|---|
| `project` / `workspace` | getters that throw when disconnected | `:65`, `:66`, impl `:512`, `:515` |
| `capabilities` | getter, survives a reconnect window | `:67`, impl `:173` |
| `connect` / `reconnect` / `dispose` | lifecycle | `:68`, `:69`, `:107`, impl `:181`, `:193`, `:186` |
| `listProfiles(prefetched?)` | `Promise<ProfileInfo[]>` | `:71`, impl `:199` |
| `startRun(input: StartRunInput)` | `RunHandle` (synchronous) | `:77`, impl `:363` |
| `steer({executionId, message, profile?})` | `Promise<SteerResult>` | `:80`, impl `:368` |
| `compact({executionId, request?, mechanicalTargetTokens?})` | `Promise<CompactResult>` | `packages/code/src/adapters/kernel-run-client.ts` (`KernelRunClient.compact`) |
| `context(executionId, targetWindowTokens?)` | `ReturnType<RunService["context"]>` | `packages/code/src/adapters/kernel-run-client.ts` (`KernelRunClient.context`) |
| `getRun(executionId)` | `Promise<RunDetail \| null>` | `:86`, impl `:397` |
| `deleteRun(executionId)` | `Promise<boolean>` | `:87`, impl `:406` |
| `plans` `workflows` `skills` `config` `secrets` `models` `providerAuth` `files` `sessions` `plugins` `tasks` `storage` | thin per-method pass-throughs to `requireKernel()` | `packages/code/src/adapters/kernel-run-client.ts` (`createKernelRunClient`) |

`KernelRunClientCallbacks` (`:56`): `onEvent(event, source, executionId)`, optional
`onProgress(progress, executionId)`, `onMemoryIngest(notice)`, `onElicit(params) => Promise<ElicitResult>`.

### 2.4 Other exported surfaces in scope

| Module | Exports | Line |
|---|---|---|
| `adapters/run-types.ts` | `ProfileInfo`, `StartRunInput`, `RunHandle`, `SteerResult`, `CompactResult`; re-exports `MemoryIngestNotice`, `RunProgress` from `core/run-types.ts` | `:13`, `:32`, `:48`, `:57`, `:65`, `:10` |
| `adapters/run-reducers.ts` | `subagentCompletedOk`, `iterationTokens`, `SubagentRegistry`, `createSubagentRegistry`; re-exports `PlanTaskActivity` | `:7`, `:19`, `:38`, `:47`, `:2` |
| `adapters/activity-store.ts` | `ActivityStore`, `createActivityStore`, `UsageActivity`, `ContextActivity`, `SubagentStatus`, `ACTIVITY_SUBAGENT_SUMMARY_MAX_CHARS` (512), `ACTIVITY_SUBAGENT_SUMMARIES_MAX` (64) | `:66`, `:83`, `:42`, `:56`, `:11`, `:14`, `:16` |
| `adapters/session.ts` | `Session`, `SessionDeps`, `SessionInit`, `createSession`, `isContinuationUnavailable`, `buildSkillRunDigest`, `buildRecoveredContext`, `ResumedSession`, `ResumeDeps`, `ResumeOptions`, `resumeSession`, `deleteSession`, `SESSION_RESUME_MAX_PAYLOAD_CHARS` | `:41`, `:60`, `:69`, `:92`, `:81`, `:256`, `:289`, `:340`, `:359`, `:390`, `:493`, `:659`, `:398` |
| `adapters/session-store.ts` | `SessionId`, `NodeStatus`, `SessionTotals`, `TurnRef`, `SessionMeta`, `runStatusToNode`, `uuidv7`, `redactPreview`, `TURN_ERROR_MAX_CHARS` (2000), `redactTurnError`, `addUsageToTotals`, `uncachedInput`, `formatCostUsd`, `SessionStore`, `MAX_RESIDENT_FULL_SESSIONS` (8), `listSessionsForWorkspace`, `metaToSession`, `sessionToMeta`, `sessionSummaryToMeta`, `sessionTurnCount`, `loadSessions`, `createSessionStore` | `packages/code/src/adapters/session-store.ts` |
| `adapters/active-agent.ts` | `ActiveAgentStore`, `ActiveAgentDeps`, `AutomaticAgentCandidate`, `automaticAgentFallback`, `createActiveAgentStore` | `:16`, `:36`, `:46`, `:62`, `:77` |
| `adapters/connection-state.ts` | `ConnectionState`, `ConnectionStore`, `createConnectionState`, `connectionLabel`, `connectionProbe` | `:10`, `:16`, `:22`, `:30`, `:42` |
| `adapters/stream-metrics.ts` | `StreamMetrics`, `createStreamMetrics`, `streamMetrics` | `:30`, `:50`, `:102` |
| `adapters/memory-pressure.ts` | `MIB`, `DEFAULT_TUI_RSS_LIMIT_BYTES`, `MEMORY_PRESSURE_SAMPLE_MS`, `MEMORY_PRESSURE_ABORT_GRACE_MS`, `MEMORY_PRESSURE_RECOVERY_TIMEOUT_MS`, `MemoryPressurePhase`, `ProcessMemorySample`, `MemoryPressureSnapshot`, `MemoryRecoveryResult`, `MemoryPressureDeps`, `MemoryPressureController`, `memoryPressureAllowsSlash`, `tuiRssLimitBytes`, `createMemoryPressureController` | `:3`–`:12`, `:14`, `:17`, `:24`, `:32`, `:41`, `:59`, `:72`, `:77`, `:106` |
| `adapters/execution-safety.ts` | `SafetyPreset`, `CanonicalSafetyPreset`, `RunControlsState`, `MemoryState`, `PlanMode`, `PlanHistory`, `PlansState`, `planHistoryLabel`, `plansState`, `modelResolves`, `memoryState`, `deriveSafetyPreset`, `deriveRunControls`, `safetyDescription`, `memoryDescription`, `plansDescription`, `settingsForPreset` | `:10`, `:12`, `:15`, `:27`, `:30`, `:33`, `:44`, `:52`, `:58`, `:71`, `:102`, `:121`, `:141`, `:162`, `:195`, `:204`, `:223` |
| `adapters/file-prompt-history.ts` | `createFilePromptHistory(limit = 200, file = workspaceStatePaths().promptHistoryFile, options)` | `:84` |
| `adapters/workspace-client-manager.ts` | `ManagedWorkspaceClient`, `WorkspaceClientOptions`, `WorkspaceClientManager` | symbols of the same names |
| `adapters/kernel-errors.ts` | `hasKernelErrorCode(error, code): error is {code}` — the narrowing every kernel-error branch in this scope goes through | `packages/code/src/adapters/kernel-errors.ts:4-14` |

`hasKernelErrorCode` narrows **structurally** (`typeof error === "object" && error !== null && "code" in
error && (error as { code?: unknown }).code === code`, `packages/code/src/adapters/kernel-errors.ts:8-13`)
rather than by `instanceof` against a concrete `KernelError` class, which is what lets it classify a
transported error too: `KernelRunClient.getRun`/`.deleteRun` (`:401`, `:411`) apply it to whatever the
current `KernelClient` throws, and `packages/code/tests/component/kernel-run-client.test.ts:570-576`
constructs the failure as a plain `Object.assign(new Error(...), { code: "not_found" })` — named
"transported `not_found` errors are classified structurally" — precisely because a remote kernel (a
future stdio/HTTP transport) would reconstitute its thrown error that way, not as the original class
instance. The same helper and the same test shape are reused outside this scope: `adapters/agents-store.ts:134`
(`code-domain-hubs`, `specs/hosts/code-domain-hubs.md`) and `adapters/workspace-files.ts:56` both import
it for the identical `not_found`-to-`null` pattern; this document is its one description, since
`kernel-run-client.ts` is its heaviest caller (three of the module's five call sites).

### 2.5 `StartRunInput` → wire mapping (`toStartParams`, `packages/code/src/adapters/kernel-run-client.ts:122`)

| `StartRunInput` field | Wire `StartRunParams` field | Emitted when |
|---|---|---|
| `executionId` | `execution_id` | always (defaulted at `:364`) |
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

`workspace` is *not* a start parameter — `packages/code/tests/component/kernel-run-client.test.ts:222`
asserts `expect(captured).not.toHaveProperty("workspace")`.

### 2.6 Environment variables read in this scope

| Variable | Read at | Meaning |
|---|---|---|
| `CLARVIS_STREAM_DEBUG` | `packages/code/src/adapters/stream-metrics.ts:104` | JSONL path for the streaming counters; unset ⇒ no-op sink |
| `CLARVIS_TUI_RSS_LIMIT_MB` | `packages/code/src/views/App.tsx:206` via `tuiRssLimitBytes` (`packages/code/src/adapters/memory-pressure.ts:102`) | RSS fuse limit in MiB; `0` disables |

## 3. Data and formats

### 3.1 Identifiers

| Id | Shape | Generated at |
|---|---|---|
| execution id | `"exec_" + crypto.randomUUID()` | `packages/code/src/run-host.ts:620`, `:775`, `:827`; and as a fallback in `packages/code/src/adapters/kernel-run-client.ts:364` |
| session id | UUIDv7 — 48-bit ms timestamp in bytes 0–5, `crypto.getRandomValues` over 6–15, version nibble `0x7`, variant bits `0b10` | `packages/code/src/adapters/session-store.ts:86` |
| transcript user-node key | `"user:" + userSeq++` | `packages/code/src/adapters/store.ts:768` |
| transcript notice key | `"notice:" + noticeSeq++` | `packages/code/src/adapters/store.ts:810` |
| local-bash node key | `"local:" + localSeq++` | `packages/code/src/adapters/store.ts:863` |
| run-scoped node key | `` `${execId}::${spanId}` `` | `packages/code/src/adapters/store.ts:950`, tool form at `:639` |
| folded-prefix node key | the literal `"transcript:folded-prefix"` | `packages/code/src/adapters/store.ts:818` |
| run-failure node key | `` `${execId}::run-failed:${error.code}` `` | `packages/code/src/adapters/store.ts:801` |

`uuidv7`'s version/variant bits are pinned by
`packages/code/tests/component/session-store.test.ts:68`.

### 3.2 `SessionMeta` — the persisted session record

Declared at `packages/code/src/adapters/session-store.ts:51`.

| Field | Type | Note |
|---|---|---|
| `id` | `SessionId` | UUIDv7 |
| `title` | `string` | `redactPreview(firstUserText, { max: 80 })` (`packages/code/src/adapters/session.ts:119`) |
| `projectId` | `string?` | required before persistence; `metaToSession` throws without it (`packages/code/src/adapters/session-store.ts:295`) |
| `workspace` | `string` | the workspace **id**, from `RunHostDeps.workspaceId` (`packages/code/src/run-host.ts:615`) |
| `owner` | `string` | |
| `createdAt` / `updatedAt` | `number` (epoch ms) | |
| `profile` | `string?` | agent name |
| `turns` | `TurnRef[]` | |
| `turnCount` | `number?` | present *only* on a catalog-only summary (`packages/code/src/adapters/session-store.ts:63`, `:279`) |
| `totals` | `SessionTotals` `{input, output, cached, costUsd?}` | `:20` |
| `pending` | `Message[]?` | unflushed observations (`:61`) |

`TurnRef` (`:28`): `{ userPreview, executionId?, status, startedAt?, endedAt?, error? }`, where
`error` is `{code, message}` and is present only on a failed turn (`:43`).

The wire shape is `Session` from `@clarvis/protocol`; `metaToSession` and `sessionToMeta` are the
camelCase↔snake_case adapters. The protocol's declared `SessionTurn` type has no `error` member, so
the adapter deliberately widens the persisted turn locally with optional `{code,message}`. The write
leg includes that member only when present; the read leg accepts it only when both fields are strings.
`createSession.endTurn` applies `redactTurnError` before either memory or disk sees the value, masking
the message unless preview redaction is disabled and bounding it to `TURN_ERROR_MAX_CHARS = 2000`.
Production: `packages/code/src/adapters/session-store.ts` (`PersistedSessionTurn`,
`persistedTurnError`, `metaToSession`, `sessionToMeta`, `redactTurnError`) and
`packages/code/src/adapters/session.ts` (`endTurn`). Test:
`packages/code/tests/component/session-store.test.ts` ("a failed turn's reason survives
metaToSession -> disk JSON -> sessionToMeta", "a reloaded session still carries why its turn failed",
and malformed persisted-error cases) and `packages/code/tests/component/session.test.ts` ("a failed
turn's reason is masked and bounded before it is recorded").

`sessionSummaryToMeta` (`:256`) maps a `SessionSummary` to a `SessionMeta` with `turns: []` and
`turnCount: s.turn_count`; `sessionTurnCount` (`:278`) returns `turnCount ?? turns.length`.

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

### 4.1 `submitTurn` — the ordinary turn (`packages/code/src/run-host.ts:568`)

1. Read `deps.activeProfile()`; empty ⇒ status `"no backend yet"` and return (`:555`–`:559`).
2. Compute `draftText = display ?? composerText(content)` (`:560`, helper at `:228` — the composer
   text keeps only `type: "text"` parts).
3. Resolve `@`-mention images through `buildContent`/`appendMentionImages` (`:562`–`:566`). A
   `MentionImageError` sets the status to the error's message, calls `draftRestore` with the original
   draft, and returns **before any session or run state is created** (`:568`–`:571`); any other error
   rethrows (`:568`).
4. **If a run is already active**: this is a *steer*, not a new turn (`:573`). An optimistic
   `queueSteer` annotation is added only if the current sink is that execution's
   (`:575`–`:578`); `client.steer` is awaited; a non-`"steered"` status rolls the annotation back and
   shows the raw status; a throw rolls it back, sets `"steer failed — message restored to the input"`
   and restores the draft (`:579`–`:591`). Returns.
5. Otherwise create the session if absent (`loadEpoch += 1`, `createSession`) (`:594`–`:600`).
6. Mint `executionId`, snapshot `messagesBeforeTurn`, append the user node
   (`store.appendUserMessage`) (`:601`–`:604`).
7. If the effective plans mode is `"review"` (`skill?.plansMode ?? deps.plansMode?.()`), append a
   plan-approval notice to the transcript (`:605`–`:612`).
8. `sess.beginTurn(msg, executionId)` returns the **continuation base** — the previous turn's
   execution id (`:613`, impl `packages/code/src/adapters/session.ts:113`–`:114`).
9. `rememberResidentTurn` records the turn and folds the oldest when over the limit (`:614`).
10. Collect `promptCacheKey = sess.meta()?.id`, `guardMode`, `judgePayload(guardMode)`, and `memory`
    only when the mode is `"off"` (`:619`–`:626`).
11. `workflowRunId = executionId; setWorkflowActivity(null)` (`:629`, `:630`).
12. Run through `runManaged` (`:671`): a continuation start when `continueFrom && !isManager`
    (sending only `[...pending, {role:"user", content: msg}]`), otherwise a full start
    (`:676`–`:696`).
13. On a `continuation_unavailable` failure that was not cancelled, await `handle.closed`, set
    `"context expired — rebuilding from history…"`, and re-start full with a rebuilt history
    (`:699`–`:710`).
14. `afterRun: sess.endTurn(envelope)` (`:713`). `onStored`: `sess.reconcile(stored)`,
    `replayRunEvents(sink, stored)`, and `sess.releaseHistory()` when a trace exists, including for a
    manager (`:714`–`:718`). `onError`: `sess.endTurn(undefined)` and a `"cancelled"` /
    `"run error: …"` status (`:719`–`:722`).

`fullRequestMessages` (`:631`) rebuilds a released history by calling `resumeSession` over
`meta.turns.slice(0, -1)` with `renderWindow: 0`; a degraded rebuild throws
`"cannot rebuild full history: N persisted run trace(s) is/are unavailable"` (`:645`–`:648`), which
surfaces as a run-error status rather than an incomplete request —
`packages/code/tests/component/run-host.test.ts:1299`.

### 4.2 `runManaged` — the single funnel (`packages/code/src/run-host.ts:496`)

Every run shape (`submitTurn`, `submitSkillRun`, `workOnTask`) goes through it.

| Phase | Effect | Line |
|---|---|---|
| enter | capture `ownershipEpoch = runOwnershipEpoch` | `:487` |
| enter | `transcript = store.openRun(id)`; `sink = teeSink(transcript, activity.openRun())` | `:490`, `:491` |
| enter | `currentSink = {executionId, sink, transcript}`; `cancelRequested = false`; `currentStatusExecId = executionId`; `memoryStatusBase = null` | `:492`–`:496` |
| enter | `diagnosticBind({execution_id})`; `setRunActive(true)`; `setRunStartedAt(Date.now())`; initial status; `attention.setTitle("running")` | `:497`–`:501` |
| resolve | ownership re-check (`session !== sess \|\| epoch mismatch` ⇒ return) | `:507` |
| resolve | `afterRun?`; `client.getRun(executionId)`; on throw, `store.settleRun(id, status === "completed")` | `:508`–`:513` |
| resolve | ownership re-check again, then `onStored(envelope, stored, sink)` | `:515`, `:516` |
| resolve | `store.appendRunFailure` when the envelope failed with an error | `:517`, `:518` |
| resolve | status ← `runOutcomeStatus(envelope)`; `attention.notify` when not cancelled and away | `:519`–`:521` |
| reject | `onError(e)`; `store.settleRun(id)`; `attention.notify("run failed")` when not cancelled and away | `:522`–`:527` |
| finally | `await Promise.allSettled(lifecycleClosures)` — the handles' `closed` promises | `:532` |
| finally | `diagnosticBind({execution_id: undefined})` | `:533` |
| finally | if the epoch still matches **and** `currentSink?.sink === sink`: release sink/handle, `workflowRunId = null`, `setRunActive(false)`, `attention.setTitle(null)`, replay a `heldIngest` for this run | `:534`–`:545` |
| finally | `elicit.cancelPending()` unconditionally | `:546` |

`runOutcomeStatus` (`:272`) renders `"failed — <message>"` for a failed envelope carrying an error,
otherwise `envelope?.status ?? "done"`.

The `closed` await is what keeps a run "owned" past `done`;
`packages/code/tests/component/run-host.test.ts:252` fails if it regresses.
Every handle also holds a separate physical-work lease from `setHandle` until its own `closed`
promise settles. `teardownRuns` may detach visual ownership and clear `runActive`, but it cannot
release that lease. The memory recovery path therefore cannot run GC while a detached backend is
still unwinding. Production: `packages/code/src/run-host.ts` (`physicalHandles`,
`physicalWorkActive`, `runManaged`). Test: `packages/code/tests/component/run-host.test.ts` ("forced
teardown keeps the physical run lease until closed").

### 4.3 `submitSkillRun` (`packages/code/src/run-host.ts:761`)

Unlike `submitTurn`, an active run makes `submitSkillRun` **refuse outright** rather than steer:
`if (runActive()) { setStatus(["busy", …, "finish the current run first"]); return; }` (`:744`–`:747`),
pinned by `packages/code/tests/component/run-host.test.ts:1518` ("submitSkillRun: refuses to start
while a run is already active").

1. `profile = deps.activeProfile()` (`:748`); if there is no session yet, create one with
   `{ profile: profile || undefined }` (`:749`–`:755`) — note the `|| undefined`, not the bare
   `{profile}` `submitTurn` uses (`:598`), so an empty active profile is stored as absent rather than
   as `""`.
2. Mint `executionId`, build the label `` `/${name} ${task}` `` (or bare `` `/${name}` `` when `task`
   is blank), append the user node and call `rememberResidentTurn` (`:757`–`:760`).
3. `client.startRun` is composed inline — `guardMode: skillGuardMode, ...deps.judgePayload(skillGuardMode),
   ...(skillMemoryMode === "off" ? {memory: skillMemoryMode} : {})` (`:769`–`:777`) — rather than
   through the intermediate `guardArgs` object `submitTurn` builds once and spreads at its call sites
   (`:622`–`:626`). The composed fields are the same shape either way: `guardMode` always present,
   `memory` only when the mode is `"off"`.
4. Run through `runManaged` with `run` calling `client.startRun({ skill: {name, task}, … })` (`:764`–`:780`).
5. `onStored` never calls `sess.reconcile` or `sess.releaseHistory` — it only replays the run's events
   and appends `buildSkillRunDigest(name, agent, envelope, stored, deps.planProviderKey?.())` as an
   observation on the session (`:781`–`:786`).

### 4.4 `workOnTask` (`packages/code/src/run-host.ts:809`)

1. Refuses when `runActive() || bashActive()` (`:792`–`:795`) or when `profile.trim().length === 0`
   (`:796`–`:799`), each with its own status message.
2. Calls `clearSession()` **unconditionally** (`:800`) — every existing session, its turns and any
   folded-prefix notice are discarded before the task-bound run starts; there is no path that preserves
   prior session state alongside a task run.
3. `deps.setActiveProfile(profile)`, bumps `loadEpoch`, sets `sessionTask = {id: ref.id, provider_key:
   ref.provider_key, mode: "work"}`, and creates a fresh `Session` with `{profile}` (`:801`–`:807`).
4. Mints `executionId` and a **fixed** instruction message — `` `Work on task ${ref.id} in the current
   workspace. Read the active task context, call start_task explicitly when that tool is available and
   you are ready to begin, and keep every review or completion transition explicit.` `` — displayed as
   `` `Work on task ${ref.id}` `` (`:809`–`:813`), pinned by
   `packages/code/tests/component/run-host.test.ts:1401` ("Work on task starts a fresh current-workspace
   run with only task identity and provider key").
5. `sess.beginTurn`, `rememberResidentTurn`, arms `workflowRunId`/`workflowActivity` exactly as
   `submitTurn` does (`:815`–`:822`), then runs through `runManaged` sending the session's full message
   chain (`sess.messages()`) plus `task: sessionTask` (`:823`–`:840`). `afterRun`/`onStored`/`onError`
   mirror `submitTurn`'s manager-aware `reconcile`/`releaseHistory` handling (`:841`–`:850`).

### 4.5 Cancellation

`cancelCurrentRun` (`packages/code/src/run-host.ts:413`) is a two-target function:

| Situation | Result | Line |
|---|---|---|
| a `!bash` job is in flight and not yet aborted | abort it, status `"! cancelling…"`, return `true` | `:396`–`:404` |
| a `!bash` job whose `AbortController` already fired | return `false` (so a second `^C` belongs to the quit gate) | `:400` |
| no handle, or `!runActive()`, or `cancelRequested` already | return `false`, status untouched | `:410` |
| otherwise | `cancelRequested = true`, status `"cancelling…"`, `handle.cancel()`, return `true` | `:411`–`:419` |
| `handle.cancel()` rejects while still the current handle and active | reset `cancelRequested = false`, status `"cancel request failed — <text>"` | `:414`–`:418` |

The `!runActive()` guard is what stops a `^C` landing in the settle instant from permanently
relabelling a completed run — `packages/code/tests/component/run-host.test.ts:612`.

`teardownRuns` (`:442`) is the hard form: it bumps `runOwnershipEpoch`, aborts bash, cancels the
handle with `cancelRequested = true`, clears `currentSink`/`currentHandle`/`workflowRunId`/
`currentStatusExecId`/`heldIngest`, sets `runActive(false)` and resets the terminal title (`:443`–`:455`).
It is what `App.tsx` supplies as the memory fuse's `forceStopRun`
(`packages/code/src/index.tsx:1133`, consumed at `packages/code/src/views/App.tsx:209`).

Unlike `runManaged`'s `finally`, `teardownRuns` does **not** await the handle's `closed` or `done`: the
cancel is fire-and-forget — `void currentHandle.cancel().catch(() => undefined)` (`:444`–`:446`) — so a
straggling run can go on executing (and delivering events) after `teardownRuns` returns. What stops
those late deliveries from touching UI state is `runManaged`'s own ownership-epoch check (invariant 5),
not anything in `teardownRuns` itself.

### 4.6 Event routing (`onEvent`, `packages/code/src/run-host.ts:369`)

Everything happens inside one Solid `batch` (`:352`).

| Condition | Effect | Line |
|---|---|---|
| `currentSink` exists and (`executionId === undefined` or it matches) | `applyEvent(target.sink, event, source)` | `:354`, `:355` |
| `source === "live"`, `workflowRunId !== null`, event is a workflow-projection event, and the id matches (or is absent) | fold into `workflowActivity` via `reduceWorkflowProjection` | `:356`–`:359` |

`isWorkflowProjectionEvent` (`:326`) admits `workflow_run_started`, `workflow_title_updated`,
`workflow_run_progress`, `workflow_run_completed`, `workflow_run_failed`, `run_ended`.

### 4.7 Memory-ingest status composition (`onMemoryIngest`, `packages/code/src/run-host.ts:390`)

Three module-scoped variables carry the state: `memoryStatusBase` (`:363`), `heldIngest` (`:364`),
`currentStatusExecId` (`:370`).

| (state, event) | → (state, effect) | Line |
|---|---|---|
| any, notice whose `execution_id !== currentStatusExecId` | dropped, no display change | `:373` |
| run or bash active | `heldIngest = notice`, `memoryStatusBase = null`; nothing shown | `:374`–`:378` |
| idle, `isIngestPending(phase)` (`started`/`queued`) | capture the base if unset, render `base · <segment>` | `:379`–`:389` |
| idle, terminal phase (`done`/`failed`/`blocked`) | render `(memoryStatusBase ?? runStatus()) · <segment>`, then clear the base | `:390`–`:393` |
| a held notice whose run releases the line in `runManaged`'s `finally` | replayed through `onMemoryIngest` | `:540`–`:544` |

`isIngestPending` is imported from `@clarvis/kernel/policy` (`packages/code/src/run-host.ts:10`,
defined at `packages/kernel/src/runs/memory-ingest-phase.ts:23`) — the same partition the kernel uses
to decide whether a run's stream stays open.

### 4.8 `runBangCommand` (`packages/code/src/run-host.ts:872`)

Refuses when `bashActive()` (`:855`–`:858`), lazily creates a session (`:859`–`:865`), opens the
transcript's local-bash node (`store.beginLocalBash`, `:867`), installs an `AbortController`, sets
`bashActive`, status `"! running…"`, and runs `runBash(cmd, {cwd: workspace, signal})` through
`detachObserved` (`:868`–`:896`). On settle it finishes the transcript node, appends a `"user"`-role
observation to the session **only if the session is still the same object** (`:878`), and updates the
status only if both the controller and the session are still current (`:879`–`:887`). Terminal status
words: `"! cancelled"`, `"! timed out"`, `` `! exit ${exitCode ?? "?"}` `` (`:881`–`:885`).

### 4.9 Resident-turn folding

`rememberResidentTurn` (`packages/code/src/run-host.ts:941`) pushes a `ResidentTurnRef`
(`{executionId, userKey, userPreview}`, `:194`) and returns immediately while
`residentTurns.length <= RESIDENT_TRANSCRIPT_TURN_LIMIT` (`:925`). Over the limit it asks the store to
`foldPrefixBefore(residentTurns[1].userKey, foldedPrefixNotice(n+1))` (`:931`); only if that succeeds
does it shift the oldest into `foldedTurns` and set `foldedPrefix = 1` (`:933`–`:938`).

`foldPrefixBefore` (`packages/code/src/adapters/store.ts:820`) refuses an absent or index-`0`
boundary (`:822`), then performs **one** array replacement `[foldedNotice, ...nodes.slice(boundary)]`
(`:834`) and returns whether it folded. That single replacement is the run-host-visible contract; the
bookkeeping it also performs on the folded-away keys' entries in `foldDefaults`, the hydrated-tool
window and its byte accounting, and any queued rehydration jobs for those keys (`:836`–`:854`) is the
tool-body hydration window's own internal state and is described by [hosts/code-transcript.md](code-transcript.md),
not here — this paragraph names it only so the "one array replacement" claim is not mistaken for the
whole of what the call does.

### 4.10 `exportNodeBatches` (`packages/code/src/run-host.ts:973`)

Creates a **scratch** `TranscriptStore` in its own `createRoot`, with every retention cap raised to
`Number.MAX_SAFE_INTEGER` (`:958`–`:968`).

| Case | Behavior | Line |
|---|---|---|
| no folded turns and no released prose | yields `store.nodes` itself (identity), then done | `:1071`–`:1074` |
| no folded turns but released prose present | yields through `exportResidentNodes` | `:1076` |
| folded turns present | one batch per folded turn, rebuilt from its trace, then the live window from `store.nodes.slice(foldedPrefix)` | `:1080`–`:1117` |

`exportResidentNodes` (`:972`) walks nodes, and for each released-prose node
(`isReleasedProse`, `:240`) resolves the source execution id (`sourceExecutionId`, `:247` — the
`sourceExecutionId` field for a `user` node, otherwise the key prefix before `"::"`), lazily
`loadPersisted`es that run once (`:981`), and substitutes:

| Failure | Replacement text | Line |
|---|---|---|
| no execution id | `"no persisted run identifies this block"` | `:1006` |
| fetch threw | `` `run ${id} could not be fetched` `` | `:1014` |
| fetch returned `null` | `` `run ${id} is no longer retained` `` | `:1016` |
| user node, no recoverable prompt | `` `run ${id} has no recoverable prompt` `` | `:1021` |
| user node, `sourceTextFingerprint` mismatch | `` `run ${id}'s persisted prompt does not match this displayed block` `` | `:1030` |
| assistant/reasoning node absent or itself released | `` `run ${id} has no recoverable ${kind} block` `` | `:1051` |

each prefixed by `EXPORT_INCOMPLETE_PREFIX` (`:185`, `incompleteExportNode` at `:253`). Batches are
flushed every `EXPORT_BATCH_NODE_LIMIT` nodes (`:1062`).

The fingerprint check is real: a `/skill` user node shows the rendered command while the persisted
prompt is the skill body, so exporting the persisted content would silently substitute a different
prompt — `packages/code/tests/component/run-host-export.test.ts:204`.

### 4.11 `clearSession` (`packages/code/src/run-host.ts:959`)

`clearSession(opts?: {flush?: boolean})` bumps `loadEpoch`, calls `teardownRuns()`, then — **flush is
the default**: `if (opts?.flush !== false) session?.flush()` (`:944`), so a caller must pass
`{flush: false}` explicitly to skip persisting the outgoing session — drops `session`/`sessionTask`,
clears `store`/`activity`, resets `foldedTurns`/`residentTurns`/`foldedPrefix` to empty/`0`, and sets
status to `["idle"]` (`:941`–`:953`). `loadSessionMeta` and `workOnTask` both rely on this full reset
before installing their own session state.

### 4.12 `loadSessionMeta` (`packages/code/src/run-host.ts:1141`)

1. `epoch = ++loadEpoch`; `teardownRuns()`; `session?.flush()`; drop session/task; clear both stores
   and the fold bookkeeping (`:1124`–`:1133`).
2. `windowStart = max(0, meta.turns.length - RESIDENT_TRANSCRIPT_TURN_LIMIT)` (`:1134`). When
   positive, the older turns become `foldedTurns`, one folded notice is appended and
   `foldedPrefix = 1` (`:1135`–`:1141`).
3. `resumeSession(meta, {getRun, currentPlanProviderKey, renderTurn}, {renderWindow: 20})`
   (`:1147`–`:1174`). `renderTurn` drops anything whose epoch has moved on or whose index is before
   `windowStart` (`:1154`), otherwise appends the user node, records the resident turn, replays the
   turn's events into `teeSink(store.openRun, activity.openRun)` and appends a **recovery notice**
   with tone `"warn"` when the record was rebuilt from a damaged journal (`:1162`–`:1170`).
4. Post-resume epoch check (`:1179`), then `sessionTask = resumed.activeTask` and a fresh `Session`
   seeded with `historyComplete: resumed.degraded.length === 0` (`:1180`–`:1189`).
5. `history.seed(seeds)`. The seed array starts as the redacted `userPreview` of every folded
   (pre-window) turn (`:1143`); for each turn `resumeSession` actually renders — i.e. every turn at or
   after `windowStart` — `renderTurn` additionally pushes the turn's **rehydrated** `userContent`
   (`:1161`). So a turn inside the resident render window seeds from its rehydrated content, while a
   folded turn seeds from the same redacted preview it displays; pinned only for the former by
   `packages/code/tests/component/run-host.test.ts:867` (a single in-window turn, seed excludes
   `[redacted]`).
6. Status: `"resumed N turns"` plus ` · N folded` and ` · N degraded` segments when non-zero
   (`:1192`–`:1205`).

`recoveryNotice` (`:210`) names both counts: `"partial record — this turn was rebuilt from a damaged
journal after a crash: N journal lines lost, M tool results synthesized. The run happened; this record
of it is incomplete."`, singularised per count (`:214`, `:218`).

`resumeSessionById` (`:1207`) loads the meta through `sessionStore.load`, guards its own
`requestEpoch` around the await, and reports `"session not found"` / `"resume failed: …"` (`:1208`–`:1221`).

### 4.13 `resumeSession` (`packages/code/src/adapters/session.ts:504`)

The message-chain rebuild is a **backwards** walk in batches of `FETCH_CONCURRENCY = 6` (`:448`):

1. `reserveHistory(meta.pending ?? [], null)` charges the persisted observations first (`:534`).
2. `while (cursor >= 0 && !foundReset)`: build a batch of up to 6 descending indexes and
   `fetchBatch(batch, retainHistory = true)` (`:581`–`:585`).
3. Inside a batch, each fetched `RunDetail` is immediately *projected* to
   `{continueFrom?, userContent?, history?, events?, recovery?}` (`:562`–`:572`), and the `RunDetail`
   itself is released — pinned with `WeakRef` + `Bun.gc(true)` at
   `packages/code/tests/component/session.test.ts:667`.
4. A turn with no `continue_from` sets `foundReset` and `resetIdx` (`:574`–`:576`); the walk stops at
   the next batch boundary, so up to 5 extra fetches happen.
5. Turns inside the visual window but before `resetIdx` are fetched in a second pass with
   `retainHistory = false` (`:587`–`:591`).
6. The render loop (`:597`) accumulates the chain: at or after `resetIdx`, a `continueFrom` turn
   **appends** its messages while a non-`continueFrom` turn **replaces** the accumulation outright
   (`:606`, `:607`).

Budget enforcement is incremental and pre-allocation: `reserveHistory` (`:510`) counts messages
against `SESSION_RESUME_MAX_MESSAGES = 10_000` (`:399`) and characters against
`SESSION_RESUME_MAX_PAYLOAD_CHARS = 16_000_000` (`:398`), throwing `SessionResumeLimitError`
(`:403`) — `{ code: "resource_exhausted", reason: "session_resume_history_limit", dimension, limit }` —
before the next batch is fetched. `packages/code/tests/component/session.test.ts:724` asserts exactly
18 fetches (three batches) and **zero** renders on that path.

Degradation classification (`:622`–`:627`):

| Turn state | `reason` |
|---|---|
| `turn.status === "running"` | `"interrupted"` |
| has an `executionId` but no detail | `"trace_pruned"` |
| no `executionId` | `"trace_unavailable"` |

A turn never fetched at all (outside both the chain walk and the window) renders `collapsed: true` and
counts toward `collapsed`, never `degraded` (`:635`–`:640`) —
`packages/code/tests/component/session.test.ts:590` pins that the two totals never overlap.

### 4.14 `Session` (`packages/code/src/adapters/session.ts:93`)

| Method | Effect | Line |
|---|---|---|
| `beginTurn(content, execId)` | creates `meta` on first call (UUIDv7 id, redacted 80-char title), pushes a `user` message and a `running` `TurnRef`, saves; returns the previous turn's execution id | `:110`–`:139` |
| `endTurn(envelope)` | stamps `endedAt`, maps `status` via `runStatusToNode`, records/clears `turn.error`, appends the assistant reply, and folds usage into totals **once** per execution id | `:141`–`:164` |
| `reconcile(stored)` | re-maps the status from the stored record and adds its usage if the id was not already counted | `:166`–`:182` |
| `setProfile(name)` | no-ops when `!meta \|\| meta.profile === name`; otherwise updates `meta.profile`/`meta.updatedAt` and saves | `:184`–`:189` |
| `appendObservation(content, role="assistant")` | pushes into `history` **and** `pending`, mirrors `pending` into `meta` and saves | `:191`–`:203` |
| `takePending()` | drains `pending` and deletes `meta.pending` | `:205`–`:213` |
| `flush()` | persists `meta` if present; a no-op with no session yet | `:215`–`:217` |
| `releaseHistory()` | empties `history` and sets `historyComplete = false` | `:219`–`:222` |
| `restoreHistory(messages)` | splices in a rebuilt chain and sets `historyComplete = true` | `:224`–`:227` |

`lastTurnFor` (`:101`) searches backwards for a matching `executionId` and **falls back to the newest
turn** when none matches.

`runStatusToNode` (`packages/code/src/adapters/session-store.ts:72`): `completed→done`, `cancelled→cancelled`,
`running→running`, everything else `→ error` — except `endedReason === "soft_limit_declined"`, which
maps to `cancelled`.

### 4.15 `buildSkillRunDigest` / `buildRecoveredContext` (`packages/code/src/adapters/session.ts:257`, `:289`)

`buildSkillRunDigest(name, agent, envelope, stored, selectedPlanProviderKey?)` is what
`submitSkillRun`'s `onStored` appends as an observation (`packages/code/src/run-host.ts:801`–`:803`). It builds the tag
`` `[/${name} → ${agent}${execId ? \`, exec ${execId}\` : ""}]` `` (`:264`), then resolves the body
through a fallback chain: the live envelope's or stored run's textual result
(`resultToContent(envelope ?? stored?.result)`, `:265`–`:266`); failing that, `buildRecoveredContext`'s
salvage from the stored run's events, when a `stored` detail exists (`:267`–`:271`); failing that, a
bare `` `${status} with no textual result.` `` line (`:274`–`:276`).

`buildRecoveredContext(events, planRef?, selectedPlanProviderKey?)` reconstructs what an interrupted
run should not force the next turn to redo, in up to two sections: **decisions** — every accepted
`elicitation_resolved` event with a non-empty string answer, rendered `` `${question} → ${answer}` ``
(`:296`–`:306`) — and **plan status**, present only when `planRef` exists and is not `completed`
(`:308`); it always names the plan's provider/id/revision and, when `selectedPlanProviderKey` differs
from `planRef.provider_key`, tells the reader to re-select `planRef.provider_key` before `read_plan`
can resolve the document, rather than simply pointing at `read_plan` (`:308`–`:322`). The function's
own TSDoc (`:282`–`:288`) states the plan is deliberately **not** reconstructed from events, because
plan documents never enter the trace — the salvage points at the provider's authoritative state
instead of a stale snapshot. `buildRecoveredContext` returns `null` when neither section applies
(`:324`), and is also used by `resumeSession`'s history rebuild for a degraded turn
(`packages/code/src/adapters/session.ts:568`–`:568`).

### 4.16 `deleteSession` (`packages/code/src/adapters/session.ts:670`)

`deleteSession(meta, store, deleteRun)` cascades a session delete: for every turn carrying an
`executionId`, it awaits `deleteRun(executionId)` and records `{executionId, deleted}` (`:665`–`:668`),
then deletes the session record itself via `store.delete(meta.owner, meta.id)` (`:669`), returning
`{session: boolean, traces: {executionId, deleted}[]}`. Trace deletion happens before the session
record's, and a turn with no `executionId` contributes no trace entry. Pinned:
`packages/code/tests/component/session.test.ts:963` ("deleteSession removes the session file and
cascades delete_run per turn").

### 4.17 `createSessionStore` (`packages/code/src/adapters/session-store.ts:396`)

An in-memory cache (`:303`) plus one **write lane per session id** (`:310`).

| Operation | Cache effect | Persistence |
|---|---|---|
| `list()` | all cached values sorted by `updatedAt` descending (`:404`) | none |
| `get(id)` | `cache.get(id) ?? null` (`:405`) | none |
| `load(id)` | returns a resident full document, otherwise `sessions.get(id)` → `sessionToMeta` → cache (`:406`–`:422`); a `null` reply evicts the entry | read |
| `save(meta)` | cache, `touchFull`, enqueue `{kind:"save", snapshot: metaToSession(meta)}` (`:423`–`:428`) | queued |
| `delete(id)` | cache delete, `forgetFull`, enqueue `{kind:"delete"}`, returns whether it existed (`:429`–`:434`) | queued |
| `flushPending()` | awaits every lane, repeatedly, then demotes (`:435`–`:438`) | — |

None of the reads takes an owner. The store is scoped to the one `createSessionStore` bound, and
`sessionToMeta(loaded, owner)` (`:418`) is the only place that owner is used — stamping a fetched
document as it enters the cache. See §8.

`enqueue` (`:365`) is last-write-wins per id: while a lane exists, a new mutation only *replaces*
`lane.pending`. The drain loop deletes the lane **inside the same async continuation** that observed an
empty queue (`:386`–`:395`), not from a chained `.finally()` — the difference is a microtask window
where a save can populate a lane about to be deleted, pinned by
`packages/code/tests/component/session-store.test.ts:181`.

The full-document LRU: `MAX_RESIDENT_FULL_SESSIONS = 8` (`:188`); `demoteOldFullSessions` (`:329`)
rewrites an evicted entry into a summary (`turns: []`, `turnCount: current.turns.length`, `pending`
dropped) but **skips any id with a live write lane**, re-appending it to the LRU (`:334`–`:337`).

### 4.18 `ActivityStore` (`packages/code/src/adapters/activity-store.ts:90`)

`openRun` (`:153`) takes no execution id — see §8 — and returns a `RunSink` with per-run counters
(`runInput`/`runOutput`/`runCached`) that are subtracted back out of the process totals on a re-open
or a reconcile (`resetRunUsage`, `:160`).

| Span/event | Effect | Line |
|---|---|---|
| `run` / `run_started` | reset subagents and plan, reset this run's usage, remember `lead_model` | `:165`–`:172` |
| `subagent` / `delegation_created` | upsert by `delegation_id`, write title + profile | `:174`–`:186` |
| `subagent` / `delegation_started` | status `running`, model, `startedAt` | `:190`–`:202` |
| `event` / any `plan_*` | fold through `reducePlanProjection`; note that a plan event appeared during a reconcile | `:205`–`:214` |
| `run` / `run_ended` | every still-`running`/`spawned` subagent becomes `done` or `error` by `reason === "completed"` | `:218`–`:226` |
| `subagent` / `delegation_completed\|failed` | status from `subagentCompletedOk`, `endedAt`, `retainSummary` | `:228`–`:243` |
| `iteration` / `iteration_completed` | accumulate tokens; `agent === "lead"` sets `context = {used: input, model: leadModel}`, otherwise credit the subagent | `:245`–`:265` |
| `beginReconcile` | snapshot the plan, wipe subagents/plan, reset usage | `:268`–`:276` |
| `endReconcile` | **restore the pre-reconcile plan** unless the replay produced a plan event of its own | `:278`–`:287` |

`retainSummary` (`:128`) bounds each summary to 512 chars with a `"...[display truncated]"` suffix
(`ACTIVITY_SUMMARY_TRUNCATED_NOTICE`, declared `:17`) and keeps at most 64 summarised subagents in a
FIFO, deleting the `summary` field of the evicted ones (`:136`–`:143`).

### 4.19 `KernelRunClient` run lifecycle (`driveHandle`, `packages/code/src/adapters/kernel-run-client.ts:335`)

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
`packages/code/tests/component/kernel-run-client.test.ts:271`. Everything else goes to
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
pinned by `packages/code/tests/component/kernel-run-client.test.ts:390` ("elicitation bridges
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
still starting simply awaits it — `packages/code/tests/component/kernel-run-client.test.ts:319`. Before
calling `handle.steer`, a `MessageContent` string is passed through unchanged while any other content
is wrapped as `{role: "user", content: input.message}` (`:376`–`:377`). On success `steer` always
returns `accepted: 1` — a fixed literal, not a count the kernel reports back
(`` return {status: "steered", execution_id: input.executionId, accepted: 1} ``, `:378`) — pinned
exactly by `packages/code/tests/component/kernel-run-client.test.ts:308`
(`expect(res).toEqual({status: "steered", execution_id: "exec_2", accepted: 1})`); nothing in this
scope reflects how many messages the kernel actually queued.

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

`reconnect` (`:193`) is strictly `dispose() → prepareReconnect?.() → connect()`; the ordering is
asserted as the literal array `["create:1", "close:1", "evict", "create:2"]` at
`packages/code/tests/component/kernel-run-client.test.ts:651`.

### 4.20 `execution-safety` derivations (`packages/code/src/adapters/execution-safety.ts`)

Pure functions of `RunControlsState`, no state of their own.

`safetyDescription` (`:162`) branches first on `sandboxEnabled`: when on, it appends up to three lines
— whether Bubblewrap is required or a host fallback is possible (further split by `guardMode` when
required: `"off"` reads as fully autonomous, `"auto"` as the model escalating what it judges risky,
anything else as risky actions asking first), then a filesystem line (`workspace-read-only` vs.
read-write) and a network line (`none` vs. host access) (`:163`–`:181`); when sandboxing is off, one
line branches only on `guardMode === "off"` (`:182`–`:187`).

`memoryDescription` (`:195`) is a three-way switch on `state.memory`: `"on"` reads before/after, "no
extraction model resolves" for `"inert"`, otherwise disabled-for-this-session (`:196`–`:200`).

`plansDescription` (`:204`) reads `state.plans.{mode, history}`: a first line for `mode` (`"off"` no
plan tools, `"review"` waits for approval, otherwise executes without waiting), and — only when
`mode !== "off"` — a second line for `history` (kept in provider history vs. deleted after success,
with a crash always leaving one) (`:206`–`:218`).

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
   (`packages/code/src/run-host.ts:372`). Pinned: `packages/code/tests/component/run-host.test.ts:227`.

2. **Only live events feed the workflow projection.** The fold is gated on `source === "live"`
   (`packages/code/src/run-host.ts:374`), so a rehydration replay never mutates `workflowActivity`.
   Pinned: `packages/code/tests/component/run-host.test.ts:348`.

3. **A plain (non-manager) run leaves `workflowActivity` null.** `workflowRunId` is only set on the
   `submitTurn`/`workOnTask` paths (`packages/code/src/run-host.ts:647`, `:839`) and the projection is
   still gated by the event predicate (`:326`). Pinned:
   `packages/code/tests/component/run-host.test.ts:372`.

4. **A run keeps ownership of its sink, status and title until its event stream closes, not merely
   until `done` resolves.** `runManaged` awaits `Promise.allSettled(lifecycleClosures)` before
   releasing (`packages/code/src/run-host.ts:550`), and `driveHandle`'s `closed` awaits both
   `handle.closed` and the pump (`packages/code/src/adapters/kernel-run-client.ts:344`–`:346`).
   Pinned: `packages/code/tests/component/run-host.test.ts:252` and
   `packages/code/tests/component/kernel-run-client.test.ts:160`.

5. **A settle only writes back if the session object and the ownership epoch are both unchanged.**
   Three checks: `packages/code/src/run-host.ts:525`, `:533`, `:541`, plus the sink-identity check in
   `finally` (`:534`). Pinned: `packages/code/tests/component/run-host.test.ts:1886` (a torn-down run
   settling after the next one started emits no attention cue) and `:702`.

6. **A cancel request is refused once the run is no longer active, and refused twice in a row.**
   `if (!currentHandle || !runActive() || cancelRequested) return false`
   (`packages/code/src/run-host.ts:428`). Pinned:
   `packages/code/tests/component/run-host.test.ts:612` and `:596`.

7. **A failed `handle.cancel()` re-arms cancellation instead of leaving the run un-cancellable.**
   `cancelRequested = false` in the catch (`packages/code/src/run-host.ts:434`). Pinned:
   `packages/code/tests/component/run-host.test.ts:630` (`attempts` reaches 2).

8. **A memory-ingest notice whose `execution_id` is not the status line's current owner never touches
   the display.** `packages/code/src/run-host.ts:391`. Pinned:
   `packages/code/tests/component/run-host.test.ts:526`.

9. **A pending memory phase composes onto a retained base so a later terminal phase replaces rather
   than concatenates.** `memoryStatusBase` is captured only when null, and cleared on a terminal phase
   (`packages/code/src/run-host.ts:398`, `:409`). Pinned:
   `packages/code/tests/component/run-host.test.ts:428` and `:457`.

10. **A notice arriving while a run or a `!bash` job owns the line is held, not dropped, and replayed
    once that run releases it.** `heldIngest` (`packages/code/src/run-host.ts:393`) is replayed in
    `runManaged`'s `finally` only when the id matches (`:540`–`:544`). Pinned:
    `packages/code/tests/component/run-host.test.ts:491`.

11. **`memory: "off"` is sent on the wire; `memory: "on"` is omitted.** The spread is conditional
    (`packages/code/src/run-host.ts:643`, `:794`, `:854`) and `toStartParams` only emits truthy fields
    (`packages/code/src/adapters/kernel-run-client.ts:140`). Pinned:
    `packages/code/tests/component/run-host.test.ts:383`.

12. **A `continuation_unavailable` envelope retries once as a full run, and only when the run was not
    cancelled.** `packages/code/src/run-host.ts:717`. Pinned:
    `packages/code/tests/component/run-host.test.ts:1205`.

13. **A released history is never retried as a silently partial full request.** `fullRequestMessages`
    throws when any trace is unavailable (`packages/code/src/run-host.ts:663`); `resumeSession` refuses
    an oversized chain with `SessionResumeLimitError` (`packages/code/src/adapters/session.ts:404`).
    Pinned: `packages/code/tests/component/run-host.test.ts:1299` and `:1740`,
    `packages/code/tests/component/session.test.ts:724`.

14. **History is released only after the run's trace is durably readable, for ordinary and manager
    profiles alike.** A manager still sends a complete chain: the next manager request first rebuilds
    it from persisted traces through `fullRequestMessages`. Production:
    `packages/code/src/run-host.ts` (`fullRequestMessages`, both `onStored` callbacks). Pinned:
    `packages/code/tests/component/run-host.test.ts` ("manager runs release persisted history and
    rebuild the complete chain for the next turn").

15. **A manager run always sends its complete message chain, never a `continue_from` delta.** The
    ternary at `packages/code/src/run-host.ts:695` sends full whenever `isManager`. Pinned:
    `packages/code/tests/component/run-host.test.ts:1335`, `:1365`.

16. **`Work on task` carries only `{id, provider_key, mode}` — never a workspace or repository.**
    `packages/code/src/run-host.ts:821`, and `toStartParams` passes `task` through verbatim
    (`packages/code/src/adapters/kernel-run-client.ts:142`). Pinned:
    `packages/code/tests/component/run-host.test.ts:1401`.

17. **The resumed active-task binding survives a continuation fallback.** `sessionTask` is set from
    `resumed.activeTask` (`packages/code/src/run-host.ts:1198`) and spread into both the continuation
    and the full retry (`:668`, `:693`). Pinned:
    `packages/code/tests/component/run-host.test.ts:1429`.

18. **Exactly 20 semantic turns stay resident, and folding produces exactly one prefix notice.**
    `RESIDENT_TRANSCRIPT_TURN_LIMIT` (`packages/code/src/run-host.ts:202`), enforced both on the live
    path (`:925`) and on resume (`:1134`). Pinned:
    `packages/code/tests/component/run-host.test.ts:1910` and
    `packages/code/tests/component/run-host-export.test.ts:239`.

19. **A turn is recorded as folded only if the store actually folded it.** `rememberResidentTurn`
    returns early when `foldPrefixBefore` reports `false`
    (`packages/code/src/run-host.ts:949`); the store refuses an absent or first-node boundary
    (`packages/code/src/adapters/store.ts:822`). Pinned:
    `packages/code/tests/unit/store-status.test.ts:391`.

20. **An export never fails because of one missing trace.** Every fetch failure becomes a node or a
    notice (`packages/code/src/run-host.ts:1032`, `:1113`–`:1127`). Pinned:
    `packages/code/tests/component/run-host-export.test.ts:302` and `:319`.

21. **An export yields one folded turn at a time, so a second copy of the session is never resident.**
    `scratch.clear()` before each rebuild and a `yield` per turn
    (`packages/code/src/run-host.ts:1099`, `:1133`). Pinned:
    `packages/code/tests/component/run-host-export.test.ts:340` (6 batches for a 25-turn session).

22. **A session that still fits the resident window exports `store.nodes` itself, refetching nothing.**
    `packages/code/src/run-host.ts:1089`–`:1092`. Pinned by object identity at
    `packages/code/tests/component/run-host-export.test.ts:161` and by the read count at `:279`
    (exactly 5 reads for 5 folded turns).

23. **A released user block is never exported using a persisted prompt that does not match what was
    displayed.** The `sourceTextFingerprint` comparison at `packages/code/src/run-host.ts:1045`.
    Pinned: `packages/code/tests/component/run-host-export.test.ts:204`.

24. **Prompt-history seeding is rehydrated content only for turns inside the resident render window;
    a folded (pre-window) turn seeds from its stored, already-redacted preview instead.** The seed
    array starts as `foldedTurns.map((turn) => turn.userPreview)` (`packages/code/src/run-host.ts:1161`)
    and only turns whose index is `>= windowStart` push their rehydrated `userContent` on top
    (`:1161`). Pinned only for the in-window case:
    `packages/code/tests/component/run-host.test.ts:867` seeds a single turn inside the window and
    asserts the seed does not contain `[redacted]`; no test in this scope exercises seeding for a
    folded turn.

25. **`memory_ingest` is status-line material and never enters the transcript.**
    `packages/code/src/adapters/kernel-run-client.ts:299`–`:302`. Pinned:
    `packages/code/tests/component/kernel-run-client.test.ts:271`.

26. **`capabilities` is readable across the reconnect window, but still throws before the first
    connect.** `currentCapabilities` returns `lastCapabilities` when the kernel is gone
    (`packages/code/src/adapters/kernel-run-client.ts:173`–`:178`). Pinned:
    `packages/code/tests/component/kernel-run-client.test.ts:656` and `:683`.

27. **Reconnect evicts the released host kernel before opening the replacement.**
    `dispose(); prepareReconnect?.(); connect()` (`packages/code/src/adapters/kernel-run-client.ts:193`).
    Pinned: `packages/code/tests/component/kernel-run-client.test.ts:632`.

28. **A run's usage is counted at most once per execution id.** `counted` set in `endTurn`
    (`packages/code/src/adapters/session.ts:156`) and `reconcile`
    (`packages/code/src/adapters/session.ts:174`). Pinned:
    `packages/code/tests/component/session.test.ts:272`, `:281`, and
    `packages/code/tests/component/run-host.test.ts:189` (`totals` equals exactly one run's).

29. **Session writes are coalesced last-write-wins per id.** `enqueue`
    (`packages/code/src/adapters/session-store.ts:464`) retains only the newest not-yet-started
    mutation. Pinned: `packages/code/tests/component/session-store.test.ts:146` (1,000 saves → 2
    physical writes, `"0"` then `"999"`).

30. **The lane is deleted in the same async continuation that observed an empty queue.**
    `packages/code/src/adapters/session-store.ts:490`. Pinned:
    `packages/code/tests/component/session-store.test.ts:181`.

31. **At most 8 complete session documents stay resident, and a session with a live write lane is
    never demoted.** `MAX_RESIDENT_FULL_SESSIONS` (`packages/code/src/adapters/session-store.ts:250`),
    lane skip at `:334`. Pinned: `packages/code/tests/component/session-store.test.ts:209` and `:244`.

32. **A session preview is redacted on its first line and *before* truncation.**
    `packages/code/src/adapters/session-store.ts:102`–`:124`, using `sanitizeText` re-exported from
    `@clarvis/kernel/policy` (`:9`). Pinned: `packages/code/tests/component/session-store.test.ts:319`,
    `:332`, `:356`.

33. **`session-store.ts` is one of the fourteen files bound by the ASCII-source rule** (INV-247) —
    full statement owned by [hosts/code-theme.md](code-theme.md) §5. Every glyph in it goes
    through `glyph()` (`packages/code/src/adapters/session-store.ts:10`, used at `:118`).

34. **`resumeSession` releases each batch's `RunDetail` objects before fetching the next batch, and
    never exceeds 6 concurrent fetches.** Projection happens inside `fetchBatch`
    (`packages/code/src/adapters/session.ts:573`); `FETCH_CONCURRENCY = 6` (`:458`). Pinned:
    `packages/code/tests/component/session.test.ts:667` (WeakRef + `Bun.gc(true)`).

35. **A collapsed turn and a degraded turn are counted in exactly one bucket each.**
    `packages/code/src/adapters/session.ts:612`, `:638`, `:645`. Pinned:
    `packages/code/tests/component/session.test.ts:576` and `:590`.

36. **`resumeSession` does not mutate a fetched run's own `messages` array.** The chain is rebuilt with
    spreads (`packages/code/src/adapters/session.ts:617`, `:617`). Pinned:
    `packages/code/tests/component/session.test.ts:757`.

37. **A plan projection survives an end-of-run reconcile unless the replay carried a newer plan
    event.** `packages/code/src/adapters/activity-store.ts:290` (activity) and
    `packages/code/src/adapters/store.ts:1453`–`:1470` (transcript). Pinned:
    `packages/code/tests/unit/run-end-reconcile.test.ts:155`.

38. **One live event, however many store writes it makes, propagates once.** `onEvent`'s `batch`
    (`packages/code/src/run-host.ts:370`) and `settleRun`'s (`packages/code/src/adapters/store.ts:905`).
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

47. **The active agent resolves session profile → runnable configured default → automatic fallback,
    and re-resolves whenever the profile list stops containing the current name.**
    `packages/code/src/adapters/active-agent.ts:87`–`:107`. Pinned:
    `packages/code/tests/unit/active-agent.test.ts:67`, `:107`.

48. **The connection label is a projection and never a channel** — the doctor probe derives from the
    same `ConnectionState` (`packages/code/src/adapters/connection-state.ts:30`, `:42`), and the
    failed label never mentions MCP. Pinned:
    `packages/code/tests/unit/connection-state.test.ts:15`, `:27`.

49. **`memoryState` is a single tri-state rule shared by every surface**, and `modelResolves` treats a
    provider with no enumerated `models` map as resolving.
    `packages/code/src/adapters/execution-safety.ts:102`, `:90`. Pinned:
    `packages/code/tests/unit/execution-safety.test.ts:157`, `:181`.

50. **A safety preset is reported only on an exact canonical match; anything else is `"custom"`.**
    `packages/code/src/adapters/execution-safety.ts:129`–`:134`. Pinned:
    `packages/code/tests/unit/execution-safety.test.ts:50`.

51. **`@clarvis/code`'s adapters never import from `ui/` or `views/`** (INV-244) — full statement
    owned by [hosts/code-bootstrap.md](code-bootstrap.md) §5. This is why
    `TranscriptStoreDeps.describeToolCall` is injected rather than imported
    (`packages/code/src/adapters/store.ts:269`–`:278`).

52. **Every `@clarvis/kernel` import in this scope uses one of the five sanctioned entrypoints**
    (INV-251) — full statement owned by [hosts/code-bootstrap.md](code-bootstrap.md) §5. In
    scope: `@clarvis/kernel/policy` (`packages/code/src/run-host.ts:10`,
    `packages/code/src/adapters/session-store.ts:9`), `@clarvis/kernel/config`
    (`packages/code/src/adapters/kernel-run-client.ts:1`,
    `packages/code/src/adapters/execution-safety.ts:1`), `@clarvis/kernel/bootstrap`
    (`packages/code/src/adapters/workspace-client-manager.ts:1`).

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
    `packages/code/src/adapters/session-store.ts:295` throws
    `"session project identity is required"`. Effectively pinned only indirectly through
    `packages/code/tests/component/session-store.test.ts:73`, which always supplies one — the throw
    itself is unpinned.

56. **`settingsForPreset` is the declared inverse of `deriveSafetyPreset` over the six canonical
    presets, including direct-host `judged` as `{sandbox.enabled:false, guard.mode:"auto"}`.**
    Production: `packages/code/src/adapters/execution-safety.ts` (`settingsForPreset`,
    `deriveSafetyPreset`). Pinned: `packages/code/tests/unit/execution-safety.test.ts`.

57. **An elicitation's structured `detail` reaches the UI only when the kernel sent one, and the
    kernel is always answered, even when no handler is registered or the handler throws.**
    `wireElicit` (`packages/code/src/adapters/kernel-run-client.ts:270`–`:293`) spreads `detail` only
    if `req.detail !== undefined` (`:276`), falls back to `{action:"decline"}` with no `onElicit`
    (`:281`), and to `{action:"cancel"}` on a thrown handler (`:265`, `:279`–`:282`). Pinned:
    `packages/code/tests/component/kernel-run-client.test.ts:390`, `:424`, `:513`.

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

## 6. Failure modes and degradation

| Failure | Handler | Outcome |
|---|---|---|
| `@`-mention image too large / unreadable | `MentionImageError` catch, `packages/code/src/run-host.ts:586` | status = the error message, draft restored, **no session or run created** (`packages/code/tests/component/run-host.test.ts:1111`) |
| non-`MentionImageError` during content build | rethrown, `packages/code/src/run-host.ts:586` | propagates to the caller |
| `client.steer` rejects | `packages/code/src/run-host.ts:605` | queued annotation rolled back, draft restored, status `"steer failed — message restored to the input"` |
| `client.steer` returns a non-`"steered"` status | `:581` | annotation rolled back, raw status shown |
| steer against an unknown execution id | `packages/code/src/adapters/kernel-run-client.ts:374` | `{status:"unknown", execution_id}` without a kernel call |
| `handle.cancel()` rejects | `packages/code/src/run-host.ts:434` | run stays active, `cancelRequested` re-armed, status names the transport error |
| compact with no session turn | `compactCurrentRun` in `packages/code/src/run-host.ts` | `"no session context to compact"`, no call issued |
| compact latest settled turn | `compactCurrentRun` in `packages/code/src/run-host.ts` | persisted `final_context` is replaced and status reports freed characters |
| active compaction start is replayed or belongs to another execution | `onEvent` ownership/source guard in `packages/code/src/run-host.ts` | ignored; no stale spinner is revived |
| confirmed model fit cannot reach its target | `fitCurrentContext` + `ModelView.choose` | model remains unchanged and the failure reason is shown |
| compact throws anything else | `packages/code/src/run-host.ts:456` | status `"compaction failed: <text>"` |
| `client.getRun` rejects after a completed run | `packages/code/src/run-host.ts:529` | `store.settleRun(id, ok)` runs anyway; the turn stays `done` and totals stand (`packages/code/tests/component/run-host.test.ts:1009`) |
| run rejects before any model call | `onError` + `store.settleRun(id)` (`:524`, `:525`) | spinners settle, session turn marked `error` |
| run fails with an envelope error | `store.appendRunFailure` (`:518`, impl `packages/code/src/adapters/store.ts:791`) | one error node per distinct `(execId, code)`, suppressed if the same rendered text is already present |
| the kernel event stream throws mid-iteration | `reportStreamInterrupted` → `diagnosticEvent("run.stream.interrupted", …, "warn")` (`packages/code/src/adapters/kernel-run-client.ts:307`, `:320`) | `done` still resolves; later events are silently missing from the transcript (stated in the TSDoc `@remarks` at `:316`–`:318`) |
| `handle.closed` rejects | `reportCloseFailure` → `diagnosticEvent("run.close.failed", …, "debug")` (`packages/code/src/adapters/kernel-run-client.ts:350`, `:331`) | swallowed, because `closed` is awaited from `finally` blocks |
| an elicitation handler throws | `reportElicitFailure` → `diagnosticEvent("elicit.handler.failed", …, "warn")` and answers `{action:"cancel"}` (`packages/code/src/adapters/kernel-run-client.ts:265`) | the kernel is always answered; the defect is distinguishable from a user dismissal only in the diagnostic record |
| no `onElicit` callback registered | `packages/code/src/adapters/kernel-run-client.ts:281` | answers `{action:"decline"}` |
| an operation issued before `connect()` | `requireKernel()` throws `"kernel run client is not connected"` (`packages/code/src/adapters/kernel-run-client.ts:154`) | hard failure — except `capabilities`, which returns the last descriptor (`:173`) |
| `getRun`/`deleteRun` hit a kernel `not_found` | `hasKernelErrorCode` (`packages/code/src/adapters/kernel-errors.ts:4-14`, called at `packages/code/src/adapters/kernel-run-client.ts:401`, `:411`) | `null` / `false` respectively; any other error rethrows |
| a session write fails | `opts.onError?.(\`session ${kind} failed: ${message}\`)` (`packages/code/src/adapters/session-store.ts:482`) | the cache keeps the optimistic value; the lane continues draining |
| `sessions.get` returns `null` for a cached id | `packages/code/src/adapters/session-store.ts:507`–`:512` | cache entry and LRU slot are evicted, `load` returns `null` |
| a resumed turn's trace is gone | classified `interrupted` / `trace_pruned` / `trace_unavailable` (`packages/code/src/adapters/session.ts:633`) | the turn renders from `userPreview` with a `degraded` marker; the count shows in the status (`packages/code/src/run-host.ts:1215`) |
| a resumed run was rebuilt from a damaged journal | `recovery` passed beside the events (`packages/code/src/adapters/session.ts:580`), notice at `packages/code/src/run-host.ts:1187` | the events **are** shown, with a `"warn"` partial-record notice above them |
| resumed history exceeds 16 M chars or 10 k messages | `SessionResumeLimitError` (`packages/code/src/adapters/session.ts:404`) | the whole resume rejects; **nothing renders** (`packages/code/tests/component/session.test.ts:724`) |
| a resume is superseded by `clearSession`/another load | `loadEpoch` guards at `packages/code/src/run-host.ts:1172`, `:1194`, `:1197` | the stale resume writes nothing; status stays `"idle"` (`packages/code/tests/component/run-host.test.ts:919`) |
| an export's `getRun` throws or returns `null` | `packages/code/src/run-host.ts:1032`, `:1034`, `:1103`, `:1115` | replaced by an `EXPORT INCOMPLETE`/`folded — …` node; the export completes |
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
| `@clarvis/kernel/policy` | `packages/code/src/run-host.ts:10` (`isIngestPending`), `packages/code/src/adapters/session-store.ts:9` (`sanitizeText`) | value imports; both are shared classification rules with a single kernel owner |
| `@clarvis/kernel/config` | `packages/code/src/adapters/kernel-run-client.ts:1` (`resolveAgentsByName`), `packages/code/src/adapters/execution-safety.ts:1` (`parseModelRef`, `PLANS_DEFAULTS`) | value imports |
| `@clarvis/kernel/bootstrap` | `packages/code/src/adapters/workspace-client-manager.ts` (`createFileKernel`) | value import; `WorkspaceClientManager` owns one pinned file kernel |
| `@clarvis/paths` | `packages/code/src/adapters/file-prompt-history.ts:1` (`DIR_MODE`, `FILE_MODE`, `workspaceStatePaths`) | value import — the only place in this scope that names a path |
| `solid-js` / `solid-js/store` | `packages/code/src/run-host.ts:1`, `packages/code/src/adapters/store.ts:1`,`:2`, `packages/code/src/adapters/activity-store.ts:1`, `packages/code/src/adapters/active-agent.ts:1`, `packages/code/src/adapters/connection-state.ts:1` | reactive primitives; `batch` is load-bearing (invariant 38) |
| `node:crypto` | `packages/code/src/adapters/store.ts:3` (`createHash` for `transcriptTextFingerprint`) | value import |
| `node:fs` | `packages/code/src/adapters/file-prompt-history.ts:2`, `packages/code/src/adapters/stream-metrics.ts:1` | value imports |

### 7.2 Outbound (type-only)

`@clarvis/protocol` is imported **type-only** everywhere in this scope — `packages/code/src/run-host.ts:2`,`:9`;
`packages/code/src/adapters/kernel-run-client.ts:2`; `packages/code/src/adapters/session.ts:1`; `packages/code/src/adapters/session-store.ts:1`; `packages/code/src/adapters/activity-store.ts:2`;
`packages/code/src/adapters/run-reducers.ts:1`; `packages/code/src/adapters/run-types.ts:1`; `packages/code/src/core/run-types.ts:1`; `packages/code/src/adapters/workspace-client-manager.ts:7`. Only
`workspace-client-manager.ts` also holds a *value* edge into the kernel.

### 7.3 Inbound

| Consumer | What it takes | Line |
|---|---|---|
| `packages/code/src/index.tsx` | `createRunHost` and the entire dep wiring | `:36`, `:1003`–`:1029` |
| `packages/code/src/index.tsx` | one `createKernelRunClient` for the pinned workspace, with `prepareReconnect` bound to `workspaceManager.invalidate` | `createWorkspaceRunClient` |
| `packages/code/src/index.tsx` | `WorkspaceClientManager.create` | `bootSilentSessionStore` and `runApp` |
| `packages/code/src/index.tsx` | `createSessionStore`, `createTranscriptStore`, `createActivityStore`, `createConnectionState`, `createFilePromptHistory`, `createActiveAgentStore` | `:185`, `:543`, `:547`, `:554`, `:595`, `:911` |
| `packages/code/src/views/App.tsx` | `createMemoryPressureController` + `tuiRssLimitBytes`, wired to `run.active` / `run.cancel` / `run.forceStop` / `backend.reconnect` | `:79`, `:81`, `:205`–`:212` |
| `packages/code/src/index.tsx` | `runHost.teardownRuns()` supplied as the fuse's `forceStop` | `:1490` |

### 7.4 The layering constraint

Three architecture tests hold the direction:

- `adapters/` must not import `ui/` or `views/` —
  `packages/code/tests/architecture/architecture-boundary.test.ts:91`. This forces
  `describeToolCall` into `TranscriptStoreDeps` (`packages/code/src/adapters/store.ts:278`) and thence into `RunHostDeps`
  (`packages/code/src/run-host.ts:110`) rather than being imported from `views/`.
- `core/` must not import `adapters/`, `solid-js`, `@clarvis/kernel` or `@clarvis/paths` —
  `packages/code/tests/architecture/architecture-boundary.test.ts:72`. This is why `RunProgress`
  and `MemoryIngestNotice` live in `core/run-types.ts` and are merely re-exported from
  `packages/code/src/adapters/run-types.ts:10`, and why `PromptHistory` is a `core` interface with a `file-prompt-history`
  adapter behind its `PromptHistoryPersistence` port (`packages/code/src/core/prompt-history.ts:35`).
- Only five `@clarvis/kernel` entrypoints, and no lower package —
  `packages/code/tests/architecture/dependency-boundary.test.ts:73`, `:89`.

### 7.5 Coverage policy touching this scope

`tooling/checks/coverage.ts:29` sets `@clarvis/code`'s floors to 0.93 functions / 0.96 lines.
`src/adapters/run-types.ts` and `src/core/run-types.ts` are listed in the `NO_COUNTER_ALLOWLIST` as
type-only (`tooling/checks/coverage.ts:87`, `:87`); `src/index.tsx` is allow-listed as an executable
entry point whose import would start a terminal UI (`:72`–`:75`).

## 8. Open questions

- ~~**`TurnRef.error` is populated but has no wire field.**~~ **Resolved 2026-08-22.** The reading was
  right and understated: **both** legs of the conversion dropped it, `metaToSession` on the way out
  and `sessionToMeta` on the way back, so fixing either alone would not have round-tripped. The
  unanswerable half is now answered too — the wire `Session` turn had no slot, and nothing validates
  a turn's members either: `isSession` (`packages/kernel/src/sessions/session-service.ts:17`–`:29`)
  checks identity and `Array.isArray(turns)`, there is no schema for the document, and the transport
  passes it opaquely. So an added key is not rejected on read, and a corrupt one is not caught. Both
  legs now carry `error` (`packages/code/src/adapters/session-store.ts:294`, `:323`), the read side
  validates the `{code, message}` shape (`persistedTurnError`, `:284`), and the value is masked and
  bounded at the producer (`redactTurnError`, `:155`, applied at
  `packages/code/src/adapters/session.ts:151`) rather than inside the converter — which keeps the
  in-memory and on-disk values identical and honours the existing `redactPreviews: false` opt-out.
  The bound is load-bearing rather than tidy: this is the first provider free text written into a
  session document, and one unbounded message could push it past `SESSION_MAX_BYTES`, after which
  the store swallows the throw and silently stops persisting that session for the rest of its life.
- **`RunHost.submitTurn`'s declared arity is 2 but the implementation's is 3.** The `skill` parameter
  (`packages/code/src/run-host.ts:571`) is reachable only through `submitPromptTurn` (`:744`). Whether the interface
  narrowing is deliberate encapsulation or an oversight is not stated in the source.
- **`packages/code/tests/unit/active-agent.test.ts:12` is named "prefers runnable coder"** but the
  production preference is `marshall` (`packages/code/src/adapters/active-agent.ts:75`); the fixture contains no `marshall`, so
  the assertion is really testing the alphabetically-first-Lead branch. The test name and the code
  disagree; the source does not settle which is stale.
- ~~**`ActivityStore.openRun` ignores its `execId` argument.**~~ **Resolved the same way:** it takes
  none (`packages/code/src/adapters/activity-store.ts:78`, `:153`). The projection genuinely is
  process-global — it feeds the sidebar and status surfaces, which show *the* current run — so two
  sinks open at once still fold into one subagent/plan/usage state, and nothing in the store enforces
  otherwise. What changed is that the signature no longer implies they would not.
  `TranscriptStore.openRun` keeps its parameter, because it really is keyed by execution: it
  namespaces every node key with it (`packages/code/src/adapters/store.ts:949`-`:950`).
- **`ConnectionStore` and `connectionLabel` have no producer in this document's scope.** `index.tsx` calls
  `conn.set(...)` (`:830`, `:1079`, `:1087`), but which header component consumes `connectionLabel`
  belongs to [hosts/code-bootstrap.md](code-bootstrap.md).
- **Delegated, deliberately:** transcript node kinds, segmentation, the tool-body hydration window and
  the reconcile ordering algorithm (`packages/code/src/adapters/store.ts:595`–`:758`, `:1447`–`:1495`) belong to
  [hosts/code-transcript.md](code-transcript.md); the kernel-side session record format, cursor paging and
  rehydration event mapping belong to [hosts/sessions.md](sessions.md); the `stream-metrics`
  duplicate-drift rule and the coverage-floor machinery belong to [cross-cutting/test-architecture.md](../cross-cutting/test-architecture.md).
- **No rationale is recoverable for the specific numeric constants** `RESIDENT_TRANSCRIPT_TURN_LIMIT
  = 20`, `EXPORT_BATCH_NODE_LIMIT = 128`, `FETCH_CONCURRENCY = 6`, `MAX_RESIDENT_FULL_SESSIONS = 8`,
  `ACTIVITY_SUBAGENT_SUMMARIES_MAX = 64`, the 0.8/0.7 pressure ratios, or the two 10 s memory-pressure
  bounds. Only `ACTIVITY_SUBAGENT_SUMMARIES_MAX` carries a stated reason —
  `"Mirrors the supervision registry's maximum retained settled-child roster"`
  (`packages/code/src/adapters/activity-store.ts:15`) — which is unverified against `@clarvis/supervision`.
