# Manager-to-leader fan-out: explicit round control, waves, cumulative admission and budgets

> Implemented at `packages/workflows/...`. Every claim below is anchored to production/test symbols. Open
> questions are collected in the final section.

## 1. Purpose

`@clarvis/workflows` turns one agent run (the **manager**, shipped as Admiral) into a fan-out of
independent agent runs (**leaders**). The manager never calls `executeRun` itself: it uses the
workflow-facing tools, and the package registers each leader as a background child in the run's supervision registry, runs
it through `runLeader` (`packages/workflows/src/run-leader.ts:52`), meters its output tokens against
a workflow-child ledger (`packages/workflows/src/ledger.ts:71`), and bounds how many run at once with a
FIFO semaphore (`packages/workflows/src/concurrency.ts:11`). A separate `WorkflowLeaderCount`
atomically bounds how many leaders may be registered over the manager's complete lifetime
(`createWorkflowLeaderCount` in `packages/workflows/src/leader-count.ts`).

The spawn tools sit on a ladder of how much structure the caller supplies: `run_leader` starts one
ad-hoc leader (`packages/workflows/src/tool.ts:11`); `run_work_items` takes a decomposition and lets
the runtime derive the dependency order and the write-conflict separation
(`packages/workflows/src/work-items.ts:42`, `packages/workflows/src/schedule.ts:178`); `run_round`
starts the first round of a declared sequence whose internal barriers follow from what the round
*consumes* (`startRounds` / `drainRound` in `packages/workflows/src/run-round.ts`); `run_workflow`
reviews and compiles a workflow document into that same controlled sequence
(`buildRunWorkflowHandler` in `packages/workflows/src/run-workflow.ts`). `workflow_status` inspects
the sequence, and `workflow_decide` is the only operation that may authorize its proposed next
authored round or repeat pass.

`run_leader`, `run_work_items`, `run_round`, `workflow_status`, and `workflow_decide` answer
**immediately**. `run_round` starts only its first semantic round; the sequence pauses after that
round settles. `run_workflow` first awaits its mandatory interactive review; after explicit approval
it starts the same first-round path and returns a normal result verdict, never a deferred one
(`buildRunWorkflowHandler`). Authorized work continues on a task the registry adopts
(`buildRunLeaderHandler`, `buildRunWorkItemsHandler`, and `createRoundCoordinator`). The
three-level topology (Manager → Leaders → Sub-agents) is fixed by structural gates rather than a
depth counter: only an **entry** agent
carrying the `workflow` grant is contributed the tools
(`createWorkflowsCapability`), a leader's request is assembled without that grant by the host, and
the capability is injected only into the manager's primary run. A leader may use ordinary delegation
for sub-agents; neither a leader nor those sub-agents can spawn another workflow leader.

## 2. Surface

### 2.1 Package entrypoints

| Subpath | File | Notes |
|---|---|---|
| `.` | `packages/workflows/src/index.ts` | the exported API below |
| `./schemas` | `packages/workflows/src/schemas.ts` | result schemas + `WORKFLOW_LIMITS` re-export (`packages/workflows/src/schemas.ts:20`) |
| `./artifact` | `packages/workflows/src/artifact.ts` | workflow-document loading — **delegated** to [capabilities/workflows-service.md](workflows-service.md) |

`run-round.ts`, `work-items.ts`, `dispatch.ts`, `schedule.ts`, `rounds.ts`, `interpolate.ts`,
`log.ts`, `schedule-log.ts` and `result-text.ts` export symbols but are reachable only from **inside**
the package: `packages/workflows/package.json` resolves no subpath to them. `capability.ts` reaches
them through `createWorkflowsCapability`.

### 2.2 Exported values in scope for this document

| Export | Signature / value | Defined |
|---|---|---|
| `createWorkflowsCapability` | `(ctx: WorkflowCtx) => Capability` | named export in `packages/workflows/src/capability.ts` |
| `WORKFLOW_GRANT` | `"workflow"` | named export in `packages/workflows/src/capability.ts` |
| `WORKFLOWS_CAPABILITY_NAME` | `"workflows"` (re-exported from settings by `packages/workflows/src/index.ts`) | named export in `packages/workflows/src/settings.ts` |
| `runLeader` | `(spec, ctx, runId?, heldReservation?) => Promise<LeaderResult>` | `packages/workflows/src/run-leader.ts:52` |
| `createWorkflowLedger` | `(total: number \| null) => WorkflowLedger` | `packages/workflows/src/ledger.ts:71` |
| `createWorkflowLeaderCount` | `(limit: number) => WorkflowLeaderCount` | `createWorkflowLeaderCount` in `packages/workflows/src/leader-count.ts` |
| `createWorkflowSemaphore` | `= createSemaphore` from `@clarvis/capability` | `packages/workflows/src/concurrency.ts:11` |
| `buildRunLeaderTool` / `RUN_LEADER_TOOL_NAME` | `(profiles?) => NamespacedTool` / `"run_leader"` | `packages/workflows/src/tool.ts:47`, `packages/workflows/src/tool.ts:11` |
| `WORKFLOW_LIMITS` | frozen numeric ceilings | `packages/workflows/src/limits.ts:11` |
| `WORKFLOWS_DEFAULTS`, `WORKFLOWS_MAX_CONCURRENCY`, `WORKFLOWS_MAX_TOTAL_LEADERS`, `WORKFLOWS_SETTINGS_FIELDS`, `workflowsSettingsSpec`, `managerLiveChildrenFloor` | settings block | named exports in `packages/workflows/src/settings.ts` |
| `recordWorkflowTrace`, `WORKFLOW_TRACE_KINDS`, `WORKFLOW_PERSISTED_TRACE_PROJECTORS`, the three `is*` guards | trace vocabulary | `packages/workflows/src/trace-events.ts:198,13,223,117,134,151` |

Internal but load-bearing: `beginDispatch`, `describeQueued`, and `reportSettled` in
`packages/workflows/src/dispatch.ts`; `startRounds` and `createRoundCoordinator` in
`packages/workflows/src/run-round.ts`; `scheduleWorkItems` (`packages/workflows/src/schedule.ts:178`);
`toWorkItem` / `workItemBrief` in `packages/workflows/src/work-items.ts`; `interpolate` /
`placeholders` (`packages/workflows/src/interpolate.ts:39,64`), and the pure round vocabulary in
`rounds.ts`. The other five tools' wire-name constants are package-internal in the same way
`RUN_LEADER_TOOL_NAME` would be if `tool.ts` were not re-exported: `RUN_WORK_ITEMS_TOOL_NAME`,
`RUN_ROUND_TOOL_NAME`, `WORKFLOW_STATUS_TOOL_NAME`, `WORKFLOW_DECIDE_TOOL_NAME`, and
`RUN_WORKFLOW_TOOL_NAME` are module-level exports that `index.ts` does not re-export. By contrast,
`RUN_LEADER_TOOL_NAME` is part of the public package entrypoint.

### 2.3 The model-facing tools

All carry `mcpName: ""` and `wireName === toolName === fullName` (their respective `build*Tool`
functions).

**`run_leader`** (`packages/workflows/src/tool.ts:47`) — `additionalProperties: false`, `required: ["title","prompt"]`
(`packages/workflows/src/tool.ts:94-96`).

| Property | Type | Bound | Line |
|---|---|---|---|
| `title` | string | `minLength 1`, `maxLength LEADER_TITLE_MAX` (= `TASK_TITLE_MAX`, 60) | `packages/workflows/src/tool.ts:49-52`, `packages/workflows/src/tool.ts:22` |
| `prompt` | string | `minLength 1`, `maxLength WORKFLOW_LIMITS.textChars` | `packages/workflows/src/tool.ts:58-61` |
| `profile` | string enum | present **only** when `profiles.length > 0`; enum = profile names | `packages/workflows/src/tool.ts:67-79` |
| `expect_schema` | object | free-form JSON Schema | `packages/workflows/src/tool.ts:80-85` |

**`run_work_items`** (`buildRunWorkItemsTool`) — `required: ["items"]`.

| Property | Shape | Line |
|---|---|---|
| `items[]` | `minItems 1`, `maxItems WORKFLOW_LIMITS.workItems`; each item requires `id`, `title`, `goal`, `files`, `dependencies`, `mutation` | `buildRunWorkItemsTool` |
| `items[].files` | `maxItems filesPerWorkItem`, each `maxLength pathChars` | `buildRunWorkItemsTool` |
| `items[].dependencies` | `maxItems dependenciesPerWorkItem`, each `maxLength identifierChars` | `buildRunWorkItemsTool` |
| `profile` | enum, only when profiles exist; applies to **every** item | `buildRunWorkItemsTool` |
| `brief_prefix` | string ≤ `textChars`, prepended to every brief | `buildRunWorkItemsTool` |
| `expect_schema` | object, applied to every leader | `buildRunWorkItemsTool` |

**`run_round`** (`buildRunRoundTool`) — `required: ["rounds"]`.

| Property | Shape | Line |
|---|---|---|
| `rounds[]` | `minItems 1`, `maxItems WORKFLOW_LIMITS.rounds`; each requires `id`,`type`,`over`,`title`,`brief` | `buildRunRoundTool` |
| `rounds[].type` | enum `discovery \| findings \| verdict \| free` | `buildRunRoundTool` / `ROUND_TYPES` |
| `rounds[].over` | selector string ≤ `pathChars` | `buildRunRoundTool` |
| `rounds[].fanout` | integer 1…`WORKFLOW_LIMITS.fanout` | `buildRunRoundTool` |
| `rounds[].accept` | rule string | `buildRunRoundTool` |
| `rounds[].when` | `<round>.<field>` guard | `buildRunRoundTool` |
| `rounds[].profile` | enum, only when profiles exist | `buildRunRoundTool` |
| `repeat` | requires `rounds`,`dedupe_by`,`max_rounds`; optional `until` (`no_new`\|`budget`) and `dry_rounds` | `buildRunRoundTool` |
| `args` | object, `maxProperties WORKFLOW_LIMITS.args`, property names ≤ `identifierChars` | `buildRunRoundTool` |

**`run_workflow`** (`buildRunWorkflowTool`) — returns `null` (i.e. the tool is **not contributed**)
when the workspace ships no workflow documents. It requires `name`; its properties are `name` (enum
of loaded workflow names), `args`, and boolean `explain`.

**`workflow_status`** (`buildWorkflowStatusTool`) — accepts an optional bounded `session_id`. It
returns the active or latest sequence status, revision, current/proposed round, and cumulative leader
usage. It is read-only and never starts work.

**`workflow_decide`** (`buildWorkflowDecideTool`) — requires `session_id`, positive `revision`,
`decision: "continue" | "stop"`, and a bounded non-empty `reason`. `continue` can start only the
round already named by the checkpoint. Unknown sessions, stale revisions, duplicate decisions, and
states other than `awaiting_manager` are non-progressing refusals that spawn nothing.

### 2.4 The capability object

| Field | Value | Line |
|---|---|---|
| `name` | `"workflows"` | `createWorkflowsCapability` |
| `grants` | `[{ name: "workflow", entryCanSpawn: true }]` | `WORKFLOW_GRANT_DECLARATION` / `createWorkflowsCapability` |
| `persistedTraceProjectors` | the three workflow projectors | `createWorkflowsCapability` |
| `reservedWireNames` | the contributed tools' wire names | `createWorkflowsCapability` |
| `toolEffects` | `workflow_status` → `"control"`; every operation that can register a leader (including `workflow_decide`) → `"spawn_run"` | `createWorkflowsCapability` |
| `forRun(runCtx)` | `null` when `services.get(AGENT_REGISTRY_PORT)` is absent | `createWorkflowsCapability` |

### 2.5 Settings

`workflowsSettingsSpec`: `key: "workflows"`, `merge: "lastWins"`,
`pluginContributable: false`. The block is `.strict()` with three fields:

| Key | Schema | Default |
|---|---|---|
| `max_concurrency` | int, positive, `.max(WORKFLOWS_MAX_CONCURRENCY)` = 20 | 4 (`WORKFLOWS_DEFAULTS.max_concurrency`) |
| `max_total_leaders` | int, positive, `.max(WORKFLOWS_MAX_TOTAL_LEADERS)` = 255 | 32; cumulative across every workflow tool call in one manager run |
| `budget_tokens` | int, positive, **nullable** (`null` = unbounded) | 640 000 000 (`WORKFLOWS_DEFAULTS.budget_tokens`): four times the manager's 160-million-token primary run budget |

There is **no per-run request param**: `workflowsSettingsSpec` declares no `requestParams`, and its
TSDoc states the capability is constructed by the host's workflow service, never by the loop from a
run-request field.

`managerLiveChildrenFloor(maxConcurrency)` returns
`min(AGENTS_MAX_LIVE_CHILDREN, floor(max(1, maxConcurrency)) + 4)`, the 4 being
`MANAGER_REGISTRY_HEADROOM` in `packages/workflows/src/settings.ts`. At the default concurrency it equals the supervision
default exactly (`packages/workflows/tests/unit/settings.test.ts:31-35`).

## 3. Data and formats

### 3.1 `WORKFLOW_LIMITS` (`packages/workflows/src/limits.ts:11`)

| Key | Value | Governs |
|---|---|---|
| `rounds` | 16 | rounds per `run_round` call / workflow |
| `fanout` | 8 | replicas of one selected item |
| `repeatRounds` | 16 | round ids in one repeat block |
| `repeatDedupeFields` | 16 | dedupe fields |
| `repeatMaxRounds` | 8 | repeat passes after the initial sequence |
| `repeatDryRounds` | 8 | consecutive dry passes |
| `workItems` | 64 | work items / array members selected into a later round |
| `filesPerWorkItem` | 64 | |
| `dependenciesPerWorkItem` | 64 | |
| `resultItems` | 64 | arrays in shipped result schemas |
| `args` | 64 | declared argument names |
| `identifierChars` | 256 | ids, profiles, field names |
| `pathChars` | 1 024 | paths, selectors, accept rules |
| `textChars` | 32 768 | prompts, briefs, args values |
| `artifactBytes` / `briefBytes` / `catalog*` | see `packages/workflows/src/limits.ts:40-51` | document loading (delegated) |

`isBoundedWorkflowString(value, max)` (`packages/workflows/src/limits.ts:55`) is the single string-admission predicate used
by every parser here.

### 3.2 Identifiers

| Identifier | Form | Produced at |
|---|---|---|
| leader `runId` | whatever `ctx.runDeps.generateExecutionId()` returns | `buildRunLeaderHandler` / `registerOne` |
| agent handle id | `ag_` + 8 hex, minted by the supervision registry | asserted `packages/workflows/tests/component/run-leader.test.ts:239` |
| dispatch unit `key` (work items) | the work item's own `id` | `unitsForWave` |
| dispatch unit `key` (rounds) | `` `${round.id}[${itemIndex}]${fanout>1 ? "#"+(replica+1) : ""}` `` | `unitsOf` |
| round `id` | must match `/^[A-Za-z0-9._-]+$/u` | `ROUND_ID` / `parseRound` |

The round-id character class is load-bearing, not cosmetic: `foldRound` recovers an item index from
the bracketed suffix in the unit key, so an id such as `pass[1]` would fold every outcome onto item
1. `parseRound` enforces the class; the table case `a bracketed index, which foldRound's key
parsing would confuse` in `packages/workflows/tests/component/run-round.test.ts` pins it.

### 3.3 Selector and accept grammars (`packages/workflows/src/rounds.ts:243-246`)

```
SELECTOR_RE = /^(each|all)\(\s*([^\s)]+)\s*(?:where\s+([^\s)=]+)\s*(?:=\s*([^)]+?)\s*)?)?\)$/u
ACCEPT_RE   = /^(all|any|majority|threshold)\(\s*([^,)]+?)\s*,\s*([^,)]+?)\s*(?:,\s*(\d+)\s*)?\)$/u
```

| Written | Parsed | Line |
|---|---|---|
| `once` | `{ kind: "once" }` | `packages/workflows/src/rounds.ts:266` |
| `each(discover.work_items)` | `{ kind:"each", source }` | `packages/workflows/src/rounds.ts:271` |
| `each(review.findings where needs_verification)` | `… where:{field}` | `packages/workflows/src/rounds.ts:272-276` |
| `each(r.items where flag = true)` | `equals` coerced by `literal()` — `true`/`false`, numeric, else string, quotes stripped | `packages/workflows/src/rounds.ts:249-255` |
| `all(review.coverage_gaps)` | `{ kind:"all", source }`; a `where` on `all` is **refused** | `packages/workflows/src/rounds.ts:270` |
| `all(f, v)` / `any(f, v)` / `majority(f, v)` | rule without `count`; a count supplied is refused | `packages/workflows/src/rounds.ts:295-296` |
| `threshold(f, v, n)` | requires `count`, else `null` | `packages/workflows/src/rounds.ts:290-294` |

Pinned exhaustively in `packages/workflows/tests/unit/rounds.test.ts:258-326`.

### 3.4 Brief interpolation (`interpolate.ts`)

Placeholder regex `\{\{\s*([A-Za-z_][\w]*(?:\.[\w-]+)*)\s*\}\}` (`packages/workflows/src/interpolate.ts:23`). Only three
roots resolve — `item`, `args`, `state` (`packages/workflows/src/interpolate.ts:47-49`). A bare `{{item}}` renders the whole
item (`packages/workflows/src/interpolate.ts:47`); a non-string value is `JSON.stringify`d (`packages/workflows/src/interpolate.ts:26-29`). An
unresolvable placeholder is an **error**, and the first failure wins
(`packages/workflows/src/interpolate.ts:51,55,60`; `packages/workflows/tests/unit/interpolate.test.ts:29-49`).

Field access after the root is the same code as §3.3's selector `where` clause and `foldRound`'s
`accept`/dedupe field reads: `packages/workflows/src/interpolate.ts:47-49` calls `readPath` imported from `rounds.ts`
(`packages/workflows/src/interpolate.ts:14`), and `rounds.ts`'s own doc comment states the sharing is deliberate — "two
copies of what a dotted path means is one too many" (`packages/workflows/src/rounds.ts:65-68`).

### 3.5 Trace records (`trace-events.ts`)

Three kinds: `workflow_run_started`, `workflow_run_completed`, `workflow_run_failed`
(`packages/workflows/src/trace-events.ts:9-11`). Start detail (`packages/workflows/src/trace-events.ts:22-33`): `run_id`, `parent_run_id`, `title`,
`task`, optional `profile`, `round_id`, `pass`, `item_index`, `replica`, `replica_count`. Terminal
detail (`packages/workflows/src/trace-events.ts:36-41`): `run_id`, `parent_run_id`, `status`, optional
`error:{code,message}`.

The projectors add an absolute timestamp — `started_at` / `completed_at` from
`context.absoluteTime(entry.at)` (`packages/workflows/src/trace-events.ts:234,256,270`) — and **throw** `TypeError("invalid
<kind> trace detail")` when the opaque detail fails its guard (`packages/workflows/src/trace-events.ts:193-195`,
`:227-229`, `:249-251`, `:264-266`). `title` is optional on the persisted start event, documented as
"absent only on traces written before titles and tasks were separated"
(`packages/workflows/src/trace-events.ts:55-56`, guard `:162`).

`recordWorkflowTrace` is an overloaded wrapper whose only body is `trace.record(kind, detail)`
(`packages/workflows/src/trace-events.ts:213`); the overloads are what tie a kind to its detail type at compile time
(`packages/workflows/src/trace-events.ts:198-207`).

### 3.6 Result schemas bound by round type

`schemaFor(type)` in `packages/workflows/src/run-round.ts` returns
`WORKFLOW_RESULT_SCHEMAS[type]` and `undefined` for `free`; the map is
`{discovery, findings, verdict}` (`packages/workflows/src/schemas.ts:218-222`). Pinned by the
`a round's type binds its leaders to the shipped result schema` component case.

### 3.7 The dispatch unit and outcome

`DispatchUnit` in `packages/workflows/src/dispatch.ts` is what the two batched dispatchers,
`run_work_items` and `run_round`, build and hand to the shared machinery. The ad-hoc `run_leader`
path has its own single-child handler and does not use `beginDispatch`:

| Field | Type | Notes |
|---|---|---|
| `key` | `string` | caller-side identity, echoed back on the outcome |
| `title` | `string` | shown by the supervision tools |
| `brief` | `string` | the leader's full brief |
| `profile?` | `string` | |
| `expectSchema?` | `Record<string, unknown>` | |
| `roundId?` | `string` | authored round identity, for human grouping in workflow monitors |
| `pass?` | `number` | zero for the initial sequence, one-based for repeat passes |
| `itemIndex?` | `number` | zero-based item position selected by the round |
| `replica?` | `number` | zero-based replica position for this item |
| `replicaCount?` | `number` | |

`DispatchStatus` is the closed six-value union every unit settles into:
`completed | failed | cancelled | blocked | budget_exhausted | unregistered`. `DispatchOutcome`
pairs one back with its unit: `{ key: string; status: DispatchStatus; result:
unknown }`, where `result` is the leader's own result, structured when `expectSchema` was set.
`DispatchGate` is `(unit: DispatchUnit) => { blocked: string } | null` — the
per-unit blocker function `run_work_items` and `run_round` each build from their own dependency
tracking (§4.6, §4.8). `DispatchSession` is the object `beginDispatch` returns:
`anchorId`, `pendingHandles()`, `queuedCount()`, `run(gate?)`, `cancelled()`, `advance(units)`, and
`end(summary)` — the API §4.4 describes by behavior.

### 3.8 Leader result text (`packages/workflows/src/result-text.ts:9-27`)

`describeLeaderResult(result: LeaderResult)` is the single projection of a finished leader's outcome
into the text a manager reads, shared by `run_leader` through `buildRunLeaderHandler` and by both
`run_work_items` and `run_round` through `dispatch.ts`'s `runOne`.
Its rule, in order: an `error` on the `LeaderResult` wins outright, rendered as `result.error.message`;
otherwise the raw `result.result` is projected by `stringifyResult` — a plain string passes through
unchanged; else, for an object, a string-valued `.text` property is extracted; else `JSON.stringify`,
falling back to the literal `"[unserializable result]"` if that throws (`packages/workflows/src/result-text.ts:9-20`).

## 4. Behavior

### 4.1 Capability construction and activation

1. `createWorkflowsCapability(ctx)` builds five descriptors unconditionally — `run_leader`,
   `run_work_items`, `run_round`, `workflow_status`, and `workflow_decide` — plus `run_workflow`
   only when `buildRunWorkflowTool(workflows)` returns non-null. `ctx.workflowDefs ?? []` is the
   workflow list.
2. `reservedWireNames` and `toolEffects` are derived from that same array in
   `createWorkflowsCapability`, so the reserved set grows with the tool set rather than being
   spelled twice.
3. `forRun(runCtx)` looks up `AGENT_REGISTRY_PORT` on the run's service registry. Absent → one
   `warn` (`event: "workflow.capability_inactive"`, `reason: "no_registry"`) and `null`.
4. `forRun` creates one `RoundCoordinator` shared by every workflow handler and finish gate on that
   manager run. It therefore admits at most one active round sequence, independent of how many tool
   calls the model issues.
5. `forAgent(scope)` computes `manager = scope.entry && scope.grants.includes(WORKFLOW_GRANT)`
   (`createWorkflowsCapability`). It always returns a contribution object; `attach` returns a lazy
   per-call fair-share `outputBudget` for a non-manager and
   `{ tools, handlers, gates, advertised: true }` for the manager. The manager therefore remains on
   its primary run budget while an in-process child's provider call reserves from that execution's
   workflow ledger only when the call starts.
6. `reportInactive` splits the refusal by reason: a **sub-agent** (`!scope.entry`) is a `debug`
   note; an **entry** agent without the grant is a `warn`.

| (scope) | tools | outputBudget | log |
|---|---|---|---|
| entry + `workflow` grant | all contributed tools + the coordinator finish gate | none (primary run budget) | none |
| entry, no grant | none | lazy fair share of `ctx.ledger` | `warn reason=no_grant` (`reportInactive`) |
| non-entry (sub-agent) | none | lazy fair share of `ctx.ledger` | `debug reason=not_entry` (`reportInactive`) |
| run with no registry | capability is `null` | — | `warn reason=no_registry` (`createWorkflowsCapability`) |

Pinned in `packages/workflows/tests/component/capability.test.ts`
(`keeps the manager on its run budget while capping concurrent descendant calls`,
`does not reserve descendant headroom until its first model call`, and
`forRun returns null without one: there is no synchronous run_leader to fall back to`) and in the
capability-inactive cases of
`packages/workflows/tests/component/observability.test.ts`.

### 4.2 `run_leader` — one ad-hoc leader

In `buildRunLeaderHandler.handle` (`packages/workflows/src/capability.ts`), synchronously:

1. `parseLeaderSpec(call.arguments)` — see §4.7.
2. `ctx.leaderCount.reserve(1)` atomically admits the ad-hoc leader. Exhaustion returns a
   non-progressing `max_total_leaders` refusal before an id or supervision handle exists.
3. `runId = ctx.runDeps.generateExecutionId()`.
4. `registerBackgroundChild(agents, bc.trace, {kind:"leader", nativeId:runId, title, profile?},
   onRegistered)`; `onRegistered` consumes the cumulative slot immediately after registry
   acceptance and before `agent_registered` trace publication. `null` (registry sealed or at its
   ceiling) answers "too many child agents are already running"; the unconsumed cumulative
   reservation is released and no token-ledger reservation has been taken, pinned by
   `packages/workflows/tests/component/capability.test.ts` (`refuses to spawn when the registry has
   no room without reserving ledger headroom`).
5. Registry acceptance permanently consumes the single cumulative slot. Completion never returns
   it; if trace publication throws, the supervision helper settles the accepted handle before
   rethrowing and the consumed lifetime count remains charged.
6. A per-leader `WorkflowCtx` clone is built: bound logger, `signal = AbortSignal.any([ctx.signal,
   controller.signal])`, a `steerForLeader` that returns this child's steer queue for its own id, and
   an `onLeaderEvent` that ingests matching events into the handle *and* forwards outward.
7. An async task is started and `agents.adopt(handle.id, task)` registers it.
8. The handler returns `{kind:"result", progress:true}` naming the agent id and the leader run id.

Inside the task, in order: `semaphore.acquire(leaderCtx.signal)` →
`ctx.ledger.reserve(ctx.maxConcurrency)` → record `workflow_run_started` →
`clock?.enterBackground()` → `runLeader` → `reportSettled` → record `workflow_run_completed` or
`workflow_run_failed` → `handle.settled` with `completed` / `stopped` (cancelled) / `failed`.
`reserve === null` emits `workflow.budget_exhausted`, invokes `onBudgetExhausted`, settles the
registered handle `failed`, and dispatches no model call. This ordering is pinned by
`packages/workflows/tests/component/run-leader.test.ts` (`bounds concurrent leaders by the
semaphore, sums usage, and records the tree edges` and `several admitted run_leader calls under a
tight budget cannot collectively overrun it`).

The semaphore `acquire` sits **inside** the adopted task, not in `handle`, which is what lets a queued
leader be stopped: an abort rejects the acquire, `acquired` stays false, and the child settles
`stopped` with "cancelled while waiting for a concurrency slot". Because reservation follows
acquisition, that stopped queue entry held no token headroom.

The `finally` releases four resources, each in its own nested `try`/`finally` so an earlier throw
cannot skip a later release: compute region → optional ledger reservation → semaphore permit (only
if acquired) → steer queue close. Pinned by `packages/workflows/tests/component/run-leader.test.ts`
(`a fault in the first leader trace releases every execution resource`), which faults the first
`workflow_run_started` record and asserts the second leader still runs and the ledger records exactly
the second's spend.

### 4.3 `runLeader` — one isolated `executeRun`

`runLeader(spec, ctx, runId, heldReservation?)` (`packages/workflows/src/run-leader.ts:52`):

| Step | Effect | Line |
|---|---|---|
| reservation | uses `heldReservation` or takes one; `null` → `budget_exhausted` with `EMPTY_USAGE`, no assemble, no run | `packages/workflows/src/run-leader.ts:59-68`, `:21` |
| assemble | `ctx.assemble(spec, {parentRunId: ctx.managerRunId})`, then `execution_id` is overwritten with `runId` | `packages/workflows/src/run-leader.ts:70-71` |
| channels | `elicitForLeader(runId)`, `steerForLeader(runId)`, `onLeaderEvent` wrapped to tag the run id | `packages/workflows/src/run-leader.ts:72-76` |
| execute | `ctx.runDeps.executeRun({rawBody, owner, deps, externalSignal: ctx.signal, capabilities:[budget-only capability]})` | `packages/workflows/src/run-leader.ts:94-103` |
| account | `reservation.reconcile(response.usage)` | `packages/workflows/src/run-leader.ts:104` |
| project | `status === "error"` → `LeaderResult.error = {code,message}`; otherwise status/result/usage passed through | `packages/workflows/src/run-leader.ts:105-114` |
| fault | a thrown `executeRun` is caught, logged at `error` with a stack, and returned as `status:"error"`, `code:"leader_run_failed"` | `packages/workflows/src/run-leader.ts:115-127` |
| always | `reservation.release()` | `packages/workflows/src/run-leader.ts:128-130` |

The capability list a leader run receives is **replaced**, not extended: exactly one tool-free
capability carrying the reservation as its `outputBudget` (`packages/workflows/src/run-leader.ts:24-35`, `:99`).

### 4.4 The dispatch session — batches, backlog and the baton

`beginDispatch(deps, first, totalUnits)` first reserves `totalUnits` in the manager's
`WorkflowLeaderCount`. This is the complete work-item batch or semantic round, not merely the first
wave. If it does not fit, it emits `workflow.leader_limit_refused`, returns `null`, and registers
nothing. A successful supervision registration consumes one held slot; `end` releases only the
unused tail, so the cumulative `started` count is never refunded. Production: `beginDispatch` and
`registerOne` in `packages/workflows/src/dispatch.ts`; test: `packages/workflows/tests/unit/leader-count.test.ts`
and the atomic cap cases in `tests/component/{work-items,run-round}.test.ts`.

It then registers the first batch and returns `null` when the registry admitted **none** of it, after
a `warn` `workflow.dispatch_refused`. Otherwise it binds the session logger to the first handle's id as
`dispatch_id` and emits `info` `workflow.dispatch_begun` with `units`/`registered`/`queued`
(the opening branch of `beginDispatch`).

`register` stops at the **first** refusal and pushes the whole tail to `backlog`, preserving the
caller's order; on an already-aborted run every unit becomes an entry with `spawn: null` instead,
which is what makes `beginDispatch` return `null` rather than a session whose queue can never
drain.

`DispatchSession.run(gate?)` then:

1. takes the pending batch and resets `pending` to empty;
2. starts every registered entry via `start` → `runOne`;
3. `pump()` registers and starts backlog units while the registry admits them, stopping on
   `stopped()`;
4. joins in-flight tasks in a loop, and when its own units have all settled but backlog remains,
   calls `waitForCapacity` and retries;
5. writes `cancelled` (if stopped) or `unregistered` for whatever backlog remains;
6. hands its last held handle to the session-level `baton`.

**The baton.** `finish(settle)` decrements `outstanding` and settles immediately while other units
of this batch are live; the last one is *held* rather than settled. The decrement happens in
`finish` rather than when the task resolves, because two units settling in the same tick would
otherwise both read the pre-decrement count and both settle. `advance(units)` registers the next
batch and releases the previous baton **only if the new batch actually got a handle**.
`end(summary)` releases the final baton, appending the summary to that child's result. All three
operations are methods/closures of `beginDispatch`.

The baton spans only batches/waves within this one dispatch. A round coordinator calls `end` when
the authorized semantic round settles, intentionally allowing the live-child count to reach zero at
`awaiting_manager`. It never bridges an authored-round or repeat-pass checkpoint.

Inside `pump` the order is stated as load-bearing: register the replacement, *then* release the held
handle, *then* start the unit — because a unit the gate blocks settles synchronously and would
otherwise overwrite the held settle.

**Capacity waiting.** `waitForCapacity` computes `foreignLive =
agents.liveCount() - oursLive` where `oursLive` counts this batch's held handle *and* the previous
batch's baton. `foreignLive <= 0` → `false`, i.e. the refusal is structural and the tail is
reported `unregistered`. Otherwise it sleeps `min(500, 25 · 2^min(attempt,10))` ms, resolving early
on abort. There is deliberately **no deadline**; instead the poll is
sampled at `debug` and a single `info` `workflow.capacity_stalled` fires once past
`CAPACITY_STALL_MS` = 5000. Production: `waitForCapacity`, `delayOrAbort`, and
`reportCapacityWait`.

State table for one unit's slot, as `run` sees it:

| State | Event | Next | Effect |
|---|---|---|---|
| registered | task settles, `outstanding > 0` | settled | `finish` frees a registry slot |
| registered | task settles, last of batch | held (baton) | `finish` releases the previous `held`, keeps this one |
| backlog | a settlement freed a slot | registered | `pump` registers + starts it |
| backlog | registry full, foreign children live | backlog | `waitForCapacity` + retry |
| backlog | registry full, only our batons live | outcome `unregistered` | structural-refusal branch of `run` |
| backlog | `stopped()` | outcome `cancelled` | stopped branch of `run` |
| held | `advance(next)` registers ≥ 1 | settled | baton released |
| held | `advance(next)` registers 0 | held | baton kept |
| held | `end(summary)` | settled with summary | final release |

`advance` on a stopped dispatch registers nothing at all, emits `warn`
`workflow.dispatch_halted` with `queued_dropped`, and empties `pending` (`DispatchSession.advance`).

### 4.5 `runOne` — one unit's life (`runOne` in `packages/workflows/src/dispatch.ts`)

Order of refusals, each producing an outcome and settling the handle through `skip`:

| Check | Outcome status | Line |
|---|---|---|
| entry never registered (`spawn === null`) | `unregistered` (no settle at all) | `runOne` in `packages/workflows/src/dispatch.ts` |
| `gate(unit)` returned a blocker | `blocked`, text `'<key>' was not run: <reason>` | `runOne` in `packages/workflows/src/dispatch.ts` |
| `semaphore.acquire` rejected | `cancelled`; no reservation existed | `runOne` in `packages/workflows/src/dispatch.ts` |
| signal aborted after the grant | `cancelled`, permit released | `runOne` in `packages/workflows/src/dispatch.ts` |
| `budget.exhausted` already latched after admission | `budget_exhausted`, permit released | `runOne` in `packages/workflows/src/dispatch.ts` |
| `ledger.reserve` returned `null` after admission | `budget_exhausted`, **latches** `budget.exhausted = true` + `warn`, permit released | `runOne` in `packages/workflows/src/dispatch.ts` |

The latch is why a whole batch stops after one admitted refusal rather than re-asking the ledger per
unit — pinned by `packages/workflows/tests/component/work-items.test.ts` (`a sibling in the same wave
is refused off the remembered flag, not by asking again`), which counts exactly **one** `reserve`
call for two independent items under a zero ledger. Semaphore admission precedes every such
reservation; the serial-headroom regression is
`packages/workflows/tests/component/dispatch.test.ts` (`serial concurrency admits the queued tail
against headroom released by each predecessor`).

On the happy path, `runOne` records `workflow_run_started` with the full unit coordinates
(`round_id`, `pass`, `item_index`, `replica`, `replica_count`), enters the background compute region,
runs `runLeader`, reports settlement, records the terminal edge, settles the handle, and returns the
outcome carrying the leader's own `result`.

`runOne` never rejects: a throw (including from the trace sink) is caught, logged
`workflow.leader_faulted`, the failure edge is recorded inside its own `try`/`catch` that logs
`workflow.trace_sink_failed` if *that* also throws, and the unit settles `failed`
(`runOne` in `packages/workflows/src/dispatch.ts`). The `finally` releases region, reservation and
semaphore permit.

### 4.6 `run_work_items` — derived waves

`buildRunWorkItemsHandler.handle`:

1. `parseWorkItemsCall`.
2. `scheduleWorkItems(items)`. Not ok → `reportScheduleRefused` + a textual verdict naming the
   code and message; **nothing is registered**. The `propagates a scheduling failure instead of
   guessing` component case pins it.
3. `reportScheduleDerived`.
4. Sum every scheduled wave and call `beginDispatch(firstWave, totalUnits)`. Cumulative exhaustion
   refuses the whole batch atomically; registry exhaustion still returns "too many child agents".
5. `pendingHandles()` and `queuedCount()` are read **before** the driver starts, because the
   driver's first `run` takes the pending batch.
6. The driver walks `laterWaves`: `run(gate)` → collect → break if `session.cancelled()` →
   `advance(nextWave)`; after the loop one final `run(gate)`; then
   `session.end(describeSummary(outcomes))`.
7. `agents.adopt(session.anchorId, driver)`, then the immediate wave-plan result.

The gate holds each item against its declared `dependencies`: a blocker is any dependency whose
recorded status is not `completed` (the gate in `buildRunWorkItemsHandler`). Wave ordering alone
would still have dispatched it — pinned by `a dependent of a failed item is not dispatched and says
which ancestor stopped it`.

**Brief construction** (`workItemBrief`): `[brief_prefix, item.goal, "<scope sentence> <posture
sentence>"]` joined by blank lines, where the scope sentence names the declared files or says none
were declared, and the posture sentence is "may modify the workspace" vs "read-only: do not modify
the workspace".

**Answer text** (`describePlan`): the full wave shape (`wave 1: a, b; wave 2: c`), the
wave-1 `id=agentId` handles, `describeQueued(queued)`, and an instruction not to finish until they
return. **Summary text** (`describeSummary`): status → ids tally, e.g. `work item batch finished —
failed: a; blocked: b`, pinned by `the last child to settle carries the batch tally`.

### 4.7 The scheduler (`packages/workflows/src/schedule.ts:178`)

`scheduleWorkItems` runs five ordered checks before deriving anything:

| # | Check | Code | Line |
|---|---|---|---|
| 1 | batch size ≤ `workItems` | `limits_exceeded` | `packages/workflows/src/schedule.ts:179-186` |
| 2 | per-item string/array bounds | `limits_exceeded` (ids truncated to `identifierChars` in the message) | `packages/workflows/src/schedule.ts:187-206` |
| 3 | ids unique | `duplicate_id`, `ids` = repeated ids in first-seen order | `packages/workflows/src/schedule.ts:207-215`, `:111-119` |
| 4 | every dependency names a batch member | `unknown_dependency`, `ids` = the dependents | `packages/workflows/src/schedule.ts:217-227`, `:122-125` |
| 5 | no cycle | `dependency_cycle`, `ids` = **only** the unplaced members | `packages/workflows/src/schedule.ts:229-237`, `:135-150` |

Then per topological layer (`topologicalLayers`, `packages/workflows/src/schedule.ts:135`) it normalizes paths and packs the
layer into conflict-free waves (`packages/workflows/src/schedule.ts:239-247`).

- **Normalization** (`packages/workflows/src/schedule.ts:72-78`): trim, `\` → `/`, strip leading `./` repeatedly, collapse
  `//+`, drop trailing `/`, **lowercase**. An entry that normalizes to empty is dropped
  (`packages/workflows/src/schedule.ts:243`), which leaves a mutator unscoped (`packages/workflows/tests/unit/schedule.test.ts:220-226`).
- **Overlap** (`packages/workflows/src/schedule.ts:86-88`): equality or per-segment containment — `packages/loop` covers
  `packages/loop/src/x.ts`, `packages/loo` covers neither.
- **Conflict** (`packages/workflows/src/schedule.ts:103-108`) is reader-writer, not writer-writer: two non-mutators never
  conflict; a mutator with **no** files conflicts with everything in the layer, in both argument
  orders; otherwise conflict is any file overlap.
- **Packing** (`packages/workflows/src/schedule.ts:159-167`) is first-fit in **input order**, so the same `work_items[]`
  always yields the same waves (`packages/workflows/tests/unit/schedule.test.ts:237-243` asserts both determinism and
  the exact `[["a","b"],["d"],["c"]]` shape).

Complexity is documented as O(n²·f²) with an explicit instruction not to optimize it
(`packages/workflows/src/schedule.ts:174-176`).

### 4.8 `run_round` / `startRounds` — declared round sequences

`buildRunRoundHandler.handle` parses and delegates to `startRounds`
with the `RoundCoordinator` created once by `createWorkflowsCapability`. `startRounds` is shared with
`run_workflow`; both therefore use the same one-active-sequence rule and checkpoint state.

Synchronous refusals, before anything is registered:

| Refusal | Production |
|---|---|
| `roundCallBoundsError(call)` — a full re-check of every retained string, `fanout`, and every `repeat` bound at the **programmatic** boundary | `RoundCoordinator.start` / `roundCallBoundsError` |
| the first round's selector is not `once` ("there is no earlier round for it to consume") | `RoundCoordinator.start` |
| the first round's `when` guard is empty | `launch` |
| `planRound` failed (unresolvable selector, unrenderable brief/title, oversized source) | `launch` / `planRound` |
| the complete first round exceeds remaining `max_total_leaders` or `beginDispatch` cannot register its first wave | `launch` inside `createRoundCoordinator` |

`roundCallBoundsError` exists because `run_workflow` and embedders call `startRounds` with **typed
objects`, and types are not a runtime admission control. The programmatic-boundary cases in
`packages/workflows/tests/component/run-round.test.ts` pin every refusal before registration.

**`planRound`**:

1. For a non-`once` selector, refuse when the resolved source has more than
   `WORKFLOW_LIMITS.workItems` members.
2. `selectItems(over, state)` — `once` yields `[undefined]`, `each` yields the
   (optionally filtered) members, `all` yields the whole array as **one** entry
   (`packages/workflows/src/rounds.ts:124-135`).
3. For each item × each replica in `[0, fanout)`, render the title and brief through `interpolate`,
   re-validate the rendered title with `parseTaskTitle`, refuse a rendered brief over `textChars`,
   and emit a `PlannedUnit`. When the item itself parses as a work item, the rendered brief becomes
   the *prefix* of `workItemBrief`.
4. If the selector is `each` **and every** selected item parses as a work item, the batch is run
   through `scheduleWorkItems`; the waves become unit waves, and `prereqs` maps each unit key to its
   blockers. Otherwise the round is one flat wave. The `.every(...)` check in `planRound` means a
   round whose selected items are a *mix* of well-formed and not-well-formed work items silently
   takes the flat, unscheduled path with no separate note to the model — the same path a round of
   plain (non-work-item) values takes — rather than scheduling only the well-formed subset.

**Answer text** (`describePlan`): the round shape as an arrow-joined chain,
`id (type, selector×N) → …`, an optional repeat clause explicitly described as proposals, the
running first-round handles, `describeQueued(queued)`, and the instruction to inspect and decide the
checkpoint after settlement. It states that no later round starts automatically. **Summary text**
(`describeSummary`, over `RoundReport[]`): each authorized round renders
as `<id>: N leader(s)[, X accepted / Y rejected]`, or `<id>: skipped (<reason>)` when `skipped` is set,
joined as `rounds finished — <round>; <round>; …`.

**`RoundCoordinator`** (`createRoundCoordinator`):

- `start` validates the complete call, refuses a second active sequence, creates a `wfseq-N`
  identity, and launches only initial round 0. A first-round refusal leaves no active sequence.
- `drainRound` automatically runs every dependency wave *inside that authorized round*. It never
  selects or registers an authored successor.
- On settlement, `fold` stores the structured result and cumulative report. Cancellation and token
  budget exhaustion become terminal states. Otherwise `advance` computes exactly one successor.
  If one exists, status becomes `awaiting_manager`, `revision` increments, state is published, and
  no supervision handle remains live. If none exists, status becomes `completed`.
- An initial successor is the next authored round. After the initial sequence, `nextRepeat` and
  `admitNew` may compute a candidate repeat round/pass; they never authorize it. Each round within a
  repeat pass is a separate checkpoint as well.
- `workflow_status` reads the active or named sequence. `workflow_decide` applies compare-and-set:
  only the exact `session_id + revision` in `awaiting_manager` may `continue` the existing proposal.
  `stop` makes the sequence terminal. A stale or duplicate delivery cannot register a leader.
- Whole-round cumulative admission happens before the first wave. If the round will exceed remaining
  capacity, the decision fails and the same checkpoint/revision remains retryable; partial fan-out is
  impossible.
- `onSequenceState` receives every running, checkpoint and terminal snapshot. Status values are
  `running_round`, `awaiting_manager`, `completed`, `stopped`, `failed`, and `cancelled`.
- The contributed finish gate nudges Admiral once when it tries to finalize at a checkpoint. A
  second finalization without a decision is interpreted as `stop` and passes; finalization can never
  mean implicit continuation.
- A driver or registration fault logs `workflow.driver_faulted`, transitions the sequence to
  `failed`, and always calls `session.end` for an existing dispatch. `end` settles both a held baton
  and registrations still pending before the driver started, so running-state publication failure
  cannot strand a live supervision handle.

Production: `createRoundCoordinator`, `drainRound`, `buildWorkflowStatusHandler`, and
`buildWorkflowDecideHandler` in `packages/workflows/src/run-round.ts`. Tests:
`packages/workflows/tests/component/run-round.test.ts` under `run_round — Admiral checkpoints`
(one active sequence, no automatic continuation, CAS, stop, repeat proposal, atomic cap, finish gate), plus the
wave-boundary tests proving live count reaches zero between semantic rounds.

**`foldRound`**: outcomes are grouped by item index recovered from the key; with
an `accept` rule the round's value becomes `{decisions, accepted, rejected}` where each decision
carries `applyAccept`'s `{accepted, tally}`; without one, results are concatenated in item order
and merged.

**`mergeResults`**: if any result is not a plain object the whole set is returned as-is (one result
unwrapped, several as an array); otherwise keys are unioned, array-valued keys are flattened, a key
present in exactly one object keeps its scalar, and a key present in several becomes an array.
Pinned by `merging several leaders keeps a field only one of them reported` —
`shared=[1,3] only=2`.

**`applyAccept`** (`packages/workflows/src/rounds.ts:149`): a replica whose `field` is not a string is tallied under
`UNAVAILABLE` = `"(unavailable)"` and stays in the denominator (`packages/workflows/src/rounds.ts:156-160`, `:58`).
`all` requires `total > 0 && hits === total`; `any` is `hits > 0`; `majority` is `hits*2 > total`
(so a tie is not a majority); `threshold` is `hits >= count` (`packages/workflows/src/rounds.ts:162-169`). Pinned:
`packages/workflows/tests/unit/rounds.test.ts:119-162`.

**`nextRepeat`** (`packages/workflows/src/rounds.ts:231`) precedence: budget → `max_rounds` → (`until === "no_new"` only)
`dryRounds >= dry_rounds ?? 2` (`packages/workflows/src/rounds.ts:235-240`, default at `:55`). Under `until: "budget"` dry
passes are ignored entirely (`packages/workflows/tests/unit/rounds.test.ts:328-356`).

**`admitNew` / `dedupeKey`** (`packages/workflows/src/rounds.ts:199`, `:188`): dedupe is against everything seen so far,
never against survivors; a key is the declared fields joined by a `\0` **escape**
(`packages/workflows/src/rounds.ts:189`, with the escape called out at `:184-186`); values normalize case-insensitively,
arrays sort before joining (`packages/workflows/src/rounds.ts:174-179`).

**`producedItems`**: every array-valued field of every round in the block contributes, and an entry
carrying none of the `dedupe_by` fields is ignored.

### 4.9 `run_workflow`

`buildRunWorkflowHandler.handle`: parse → resolve the name against
the loaded catalogue → if `explain`, return `explainWorkflow(workflow)` and run nothing →
`toRoundCall` compile → **fail closed** when there is no `elicit` or no `clock` → a
`workflow_review` elicitation whose decision enum is ordered `["cancel", "run"]`, whose accepted
decision must be `"run"`, and whose timeout is the manager run's effective `elicit_wait_ms` →
`startRounds` with the shared coordinator → an answer carrying the first-round plan plus the
document's synthesis instruction. Every settled review logs `workflow.review_resolved` with its
decision and `waited_ms`; a timeout additionally logs `capability.elicit_no_response`.
The TUI also leaves this choice unselected initially; neither schema order nor an untouched Enter
can approve it. Production: `buildRunWorkflowHandler`; tests:
`packages/workflows/tests/component/run-workflow.test.ts` and
`packages/code/tests/integration/elicit-block-render.test.tsx`.

`toRoundCall` refuses a document with 0 or > `rounds` rounds, over-large declared args, an
over-long synthesis, and any declared arg the call did not supply. `explainWorkflow` states fixed
leader counts and says an `each` round's count scales with what the earlier rounds return rather
than inventing a number.

The elicit half is the sibling document **elicitation-and-user-interaction**; the workflow-document
format and the catalogue that fills `ctx.workflowDefs` are **workflows-documents-and-service**.

### 4.10 Argument parsing (all workflow tools)

| Tool | Parser | Notable rules |
|---|---|---|
| `run_leader` | `parseLeaderSpec` | non-object → error; `prompt` required non-empty ≤ `textChars`; `title` ≤ `TASK_TITLE_MAX*2` then re-validated by `parseTaskTitle` — **no fallback to the prompt** (`packages/workflows/src/tool.ts:17-21`); `profile` non-empty ≤ `identifierChars`; `expect_schema` accepted as any non-null object |
| `run_work_items` | `parseWorkItemsCall` → `toWorkItem` | every item is fully validated; the *rendered* brief is checked against `textChars` after the prefix is applied |
| `run_round` | `parseRoundCall` → `parseRound`, `parseRepeat`, `parseArgs` | round ids must be unique within the call; `repeat.rounds` must name rounds declared in the same call |
| `run_workflow` | `parseCall` | `args` must be a non-array object; property names and string values bounded |
| `workflow_status` | `buildWorkflowStatusHandler` | object required; optional `session_id` must be a bounded non-empty string |
| `workflow_decide` | `buildWorkflowDecideHandler` | object required; bounded `session_id`/`reason`, positive integer `revision`, closed `continue \| stop` decision |

Every parse failure becomes a **non-terminal** `{kind:"result", progress:false}` prefixed
`Tool '<name>' result: …` (the local `verdict` / `controlVerdict` functions) — the manager is
told what was wrong and keeps its turn.

### 4.11 The ledger (`createWorkflowLedger` in `packages/workflows/src/ledger.ts`)

`runManagerWorkflow` constructs a new primary run and a new auxiliary `WorkflowLedger` inside every
execution. Reusing the same `WorkflowsService` for later turns therefore never carries spent tokens
forward as a session budget. Production: `runManagerWorkflow` in
`packages/kernel/src/workflows/workflows-service.ts`. Test:
`packages/kernel/tests/integration/workflows-service.test.ts` (`creates a fresh auxiliary token
ledger for every manager execution`).

Three counters: `spent`, `reserved`, and `total`. `remaining() = total === null ? Infinity : max(0,
total - spent - reserved)`.

- `add(usage)` charges `sumOutputTokens(usage)` clamped to `remaining()` on a bounded ledger
  (`createWorkflowLedger` and `sumOutputTokens` in `packages/workflows/src/ledger.ts`).
- `reserveOutput(n)` (the `OutputTokenBudget` port) grants `min(n, remaining())`, and `settle(used)`
  converts `min(amount, used)` into spend exactly once (`directReservation` inside
  `createWorkflowLedger`).
- `reserve(maxConcurrent)` — a top-level leader claim — takes
  `min(headroom, max(1, ceil(headroom / max(1,maxConcurrent))))` (`packages/workflows/src/ledger.ts`,
  `createWorkflowLedger`). The manager has an independent primary-run budget and consumes no share.
  Leaders create it after semaphore admission, with `maxConcurrent` equal to configured leader
  concurrency plus the manager run's `CLARVIS_MAX_PARALLEL_SUBAGENTS`. Each reservation is itself a nested
  budget: `reserveOutput` inside it draws down `amount - childSpent - childReserved`,
  `reconcile(usage)` charges any gap the model calls did not settle, and `release()` returns the
  *unused* part `amount - childSpent`. A `released` reservation refuses further inner claims and
  further reconciliation (the bounded `reserve` branch in `createWorkflowLedger`).
- Unbounded (`total === null`): `reserve` returns a zero-cost placeholder whose `remaining()` is
  `Infinity` but which still accumulates `childSpent` and folds it into `spent`
  (the unbounded `reserve` branch in `createWorkflowLedger`).
- `createFairShareOutputBudget(parent, maxConcurrent)` caps each provider call to
  `ceil(parent.remaining() / maxConcurrent)` while reserving atomically from `parent`. Manager
  descendants use `max_concurrency + CLARVIS_MAX_PARALLEL_SUBAGENTS` over the tree ledger. Every
  agent in an isolated leader run uses `1 + CLARVIS_MAX_PARALLEL_SUBAGENTS` over that leader's held
  reservation, covering the root and its possible concurrent descendants.

The point of `reserve` over a bare `remaining()` check is that concurrent agents would otherwise all
read the same pre-spend snapshot. A leader reserves synchronously after FIFO semaphore admission and
before model dispatch. An in-process manager child reserves lazily for each model call, with unused
headroom returned by that call's ordinary settlement. The admitted set remains atomic, merely
attaching or checking a child holds nothing, and a model with no explicit output cap cannot reserve
the entire raw ledger ahead of its siblings. The leader reservation is partitioned again so its
entry call cannot starve its own subagents. This is pinned arithmetically by
`packages/workflows/tests/unit/ledger.test.ts` (`many concurrent reservations under a tight budget can
never collectively exceed it`), at the capability seam by
`packages/workflows/tests/component/capability.test.ts` (concurrent descendant call shares and lazy
reservation), and end-to-end for leaders by `packages/workflows/tests/component/run-leader.test.ts`
(`partitions one leader reservation across its root and concurrent subagent calls`; `several
admitted run_leader calls under a tight budget cannot collectively overrun it`).

### 4.12 Cumulative leader admission (`createWorkflowLeaderCount`)

`WorkflowLeaderCount` has independent `started` and `held` counters. `reserve(amount)` succeeds only
when the complete positive integer amount fits `limit - started - held`; success immediately adds it
to `held`. `consume()` moves one slot from `held` to `started`; `release()` returns only the
reservation's unconsumed tail and is idempotent. There is deliberately no decrement operation:
settlement frees concurrency and registry capacity, not the manager's cumulative spawn allowance.

The three admission units are:

| Caller | Atomic amount |
|---|---|
| `run_leader` | 1 |
| `run_work_items` | every unit across all scheduled waves |
| one authorized `run_round` round | every selected item × replica across its internal waves |

Concurrent calls cannot oversubscribe using stale `remaining()` snapshots because `reserve` mutates
the held count synchronously. Production: `packages/workflows/src/leader-count.ts`,
`buildRunLeaderHandler`, `beginDispatch`, and the `totalUnits` calls in `work-items.ts` /
`run-round.ts`. Test: `packages/workflows/tests/unit/leader-count.test.ts` and the component cap
cases in `run-leader.test.ts`, `work-items.test.ts`, and `run-round.test.ts`.

### 4.13 Diagnostics vocabulary

All records go through the `Logger` port carried on `ctx.deps.logger`, normalized once by
`workflowLogger` (`packages/workflows/src/log.ts:29-31`); nothing constructs a logger (`packages/workflows/src/log.ts:5-10`).

| `event` | Level | Emitted at |
|---|---|---|
| `workflow.capability_inactive` | warn / debug | `createWorkflowsCapability` / `reportInactive` |
| `workflow.budget_exhausted` | warn | `buildRunLeaderHandler` / `runOne` |
| `workflow.leader_started` | debug (guarded by `levelEnabled`) | `packages/workflows/src/run-leader.ts:77-93` |
| `workflow.leader_settled` | info / warn | `reportSettled` |
| `workflow.leader_faulted` | error (carries `stack`, `cause`) | `buildRunLeaderHandler`, `runLeader`, `runOne` |
| `workflow.trace_sink_failed` | error | `runOne` |
| `workflow.leader_limit_refused` | warn | `beginDispatch` when the complete semantic unit exceeds cumulative admission |
| `workflow.dispatch_begun` / `_refused` / `_halted` | info / warn / warn | `beginDispatch` / `DispatchSession.advance` |
| `workflow.wave_advanced` | debug | `DispatchSession.advance` |
| `workflow.capacity_wait` / `_stalled` | debug (sampled) / info (once) | `reportCapacityWait` |
| `workflow.schedule_derived` / `_refused` | debug / warn | `packages/workflows/src/schedule-log.ts:32`, `:54` |
| `workflow.round_planned` / `_skipped` / `_folded` | info / warn / debug | `reportRoundPlanned` / `reportRoundSkipped` / `reportRoundFolded` |
| `workflow.driver_faulted` | error | `reportDriverFault` |

Field values are scalars only, and model prose (a brief, a goal, a result) is never a field value
(`packages/workflows/src/log.ts:12-15`); `packages/workflows/tests/component/observability.test.ts:209` asserts the started-leader record does
not contain the brief. `joinIds` (`packages/workflows/src/log.ts:118`) exists because array field values are dropped by the
sink, and truncates past 32 entries (`packages/workflows/src/log.ts:106`, `:119-120`).

## 5. Invariants

**INV-W1 (INV-173).** `@clarvis/workflows`'s `src/` reaches `@clarvis/loop` through exactly two
import sites — `elicit-mux.ts` importing `@clarvis/loop/workflows` and `types.ts` importing
`@clarvis/loop`. Production: `packages/workflows/src/types.ts:8`,
`packages/workflows/src/elicit-mux.ts`. Test:
`packages/workflows/tests/architecture/dependency-direction.test.ts:15-30` (an exact-array equality,
so a third site fails it). `packages/workflows/src/log.ts:45-48` records that `withBoundLogger` is typed *structurally*
rather than against `ExecuteRunDeps` precisely so this module adds no such import.

**INV-W2 (INV-174).** No file in `src/` contains `"@clarvis/loop/internal"`. Test:
`packages/workflows/tests/architecture/dependency-direction.test.ts:32-37`.

**INV-W3 (INV-175).** `createWorkflowSemaphore` is `@clarvis/capability`'s `createSemaphore` by
identity, not a wrapper. Production: `packages/workflows/src/concurrency.ts:11`. Test:
`packages/workflows/tests/contract/concurrency.test.ts:7-9` (`toBe`).

**INV-W4 (INV-176).** A workflow semaphore bounds concurrent leaders to its size and, on release,
wakes the longest-waiting acquirer first. A leader reserves ledger headroom only after that admission,
so a queued serial successor can reuse its predecessor's released share. Production:
`createSemaphore` in `packages/capability/src/semaphore.ts`, `runOne` in
`packages/workflows/src/dispatch.ts`, and `buildRunLeaderHandler` in
`packages/workflows/src/capability.ts`. Test: `packages/workflows/tests/contract/concurrency.test.ts`
(`bounds leader fan-out and hands a released slot to the longest waiter`); end-to-end at
`packages/workflows/tests/component/dispatch.test.ts` (`serial concurrency admits the queued tail
against headroom released by each predecessor`) and
`packages/workflows/tests/component/run-leader.test.ts` (`bounds concurrent leaders by the
semaphore, sums usage, and records the tree edges`).

**INV-W5 (INV-177).** A queued acquisition whose `AbortSignal` fires rejects with the abort's error
instead of hanging. Production: `packages/capability/src/semaphore.ts:55-67`. Test:
`packages/workflows/tests/contract/concurrency.test.ts:26-33`. The workflow-side consequence — the
child settles `stopped`, not `failed` — is in `buildRunLeaderHandler` and `runOne`, pinned by
`an item cancelled while queued for a concurrency slot is settled, not left hanging`.

**INV-W6.** Only an **entry** agent carrying the `workflow` grant is contributed the spawn tools;
that manager gets no workflow `outputBudget`, while every other agent in its primary run gets no
tools and a lazy per-call fair share of the workflow-child ledger. Attaching or pre-checking a child
reserves nothing; each model call is capped against the combined maximum of leader and manager-child
consumers, so one capless child cannot transiently exhaust the tree before a concurrent sibling
starts. A leader's budget-only capability applies a second fair-share boundary across its root and
subagents. Production: `createFairShareOutputBudget`, `createDescendantOutputBudget`,
`createLeaderOutputBudgetCapability`, and `createWorkflowsCapability` in
`packages/workflows/src/{ledger,capability,run-leader}.ts`. Test:
`packages/workflows/tests/component/capability.test.ts` (`keeps the manager on its run budget while
capping concurrent descendant calls`; `does not reserve descendant headroom until its first model
call`) and `packages/workflows/tests/component/run-leader.test.ts` (`partitions one leader
reservation across its root and concurrent subagent calls`).

**INV-W7.** Every operation that can register a leader has `ToolEffect: "spawn_run"`, including
`workflow_decide`; only read-only `workflow_status` is `control`. Production:
`createWorkflowsCapability`. Test: `packages/workflows/tests/component/capability.test.ts`
(`is named 'workflows' and activates for a run`).

**INV-W8.** A run publishing no supervision registry yields `forRun === null`; there is no
synchronous fallback path. Production: `createWorkflowsCapability`. Test: `forRun returns null
without one: there is no synchronous run_leader to fall back to`.

**INV-W9.** Every spawn tool answers with `kind: "result"`, never `deferred`. Production:
`buildRunLeaderHandler`, `buildRunWorkItemsHandler`, `buildRunRoundHandler`, and
`buildRunWorkflowHandler`. Test: the corresponding component tool cases, including
`run_leader`'s immediate verdict and `ag_` handle assertion.

**INV-W10.** Registry refusal precedes ledger reservation, so a leader the registry cannot admit
claims no headroom. Production: `buildRunLeaderHandler` in `packages/workflows/src/capability.ts`.
Test: `packages/workflows/tests/component/capability.test.ts` (`refuses to spawn when the registry has
no room for another live child`, with `ledger.remaining()` unchanged).

**INV-W11.** The sum of live reservations plus settled spend can never exceed a bounded ledger's
`total`, whatever the batch size. Production: `packages/workflows/src/ledger.ts:166-172`, `:74-75`.
Test: `packages/workflows/tests/unit/ledger.test.ts:105-121`;
`packages/workflows/tests/component/run-leader.test.ts:348-390`.

**INV-W12.** `beginDispatch` returns `null` when the registry admits none of the first batch, so a
tool refuses outright rather than starting what it cannot finish. Production: `beginDispatch`.
Test: `refuses outright when the run was already aborted`, `refuses the whole batch when the
registry has no room for even one child`, and `refuses when the registry has no room for the first
round`.

**INV-W13.** A batch's outcome count always equals its unit count, however narrow the registry —
queued units are registered as slots free, never dropped. Production: `DispatchSession.run`.
Test: `the batch's outcome count equals its unit count however narrow the registry` and `every
unit runs even when the live-child ceiling admits only part of the batch`.

**INV-W14 (the baton).** The live-child count cannot reach zero between waves of one authorized
dispatch, but it **does** reach zero at every semantic round checkpoint. Production: `finish`,
`advance`, and `end` in `packages/workflows/src/dispatch.ts`, called once per authorized round by
`launch` inside `createRoundCoordinator`. Test: `packages/workflows/tests/component/work-items.test.ts` (`never lets
the live-child count reach zero while a wave is still pending`) and
`packages/workflows/tests/component/run-round.test.ts` (`the live-child count reaches zero between
semantic rounds`).

**INV-W15.** The baton is released only when the next batch actually got a handle. Production:
`DispatchSession.advance`. Test: `releasing the checkpoint baton lets the next round use a
one-slot registry` and the work-item baton regressions.

**INV-W16.** A cancellation stops the dispatch scheduling anything further; queued units are reported
`cancelled` rather than started. Production: `stopped`, `pump`, `run`, and `advance` inside
`beginDispatch`. Test: `an abort between batches registers nothing further`, `a cancellation
drains the queue instead of starting what it had not paid for`, and `a cancelled item stops later
waves instead of replacing the stopped work`.

**INV-W17.** A cancelled leader makes the controlled sequence terminal and never proposes or spawns
a replacement repeat pass. Production: `drainRound` and the cancelled branch in
`launch` inside `createRoundCoordinator`. Test: `packages/workflows/tests/component/run-round.test.ts` (`a
cancelled leader stops the repeat candidate instead of proposing a replacement`).

**INV-W18.** One post-admission ledger refusal latches the whole batch: later units acquire and
release their FIFO permits but are refused from the remembered flag without asking the ledger again.
Production: `runOne` in `packages/workflows/src/dispatch.ts`. Test:
`packages/workflows/tests/component/work-items.test.ts` (`a sibling in the same wave is refused off
the remembered flag, not by asking again`, exactly one `reserve` call).

**INV-W19.** A work item whose dependency did not **complete** is not dispatched at all — wave
ordering alone is not the guarantee. Production: the gates in `buildRunWorkItemsHandler` and
`drainRound`. Test: `a dependent of a failed item is not dispatched and says which ancestor
stopped it` and `a work item whose dependency failed is not dispatched, only ordered after it`.

**INV-W20.** Two items may share a wave only if neither writes a file the other touches; a mutating
item that declared no files runs alone, against readers as well as writers, in either comparison
order. Production: `packages/workflows/src/schedule.ts:103-108`, `:159-167`. Test:
`packages/workflows/tests/unit/schedule.test.ts:136-183`.

**INV-W21.** Path comparison is case-insensitive and separator-normalized, and containment is tested
per path segment. Production: `packages/workflows/src/schedule.ts:72-88`. Test:
`packages/workflows/tests/unit/schedule.test.ts:127-134`, `:203-218`.

**INV-W22.** The schedule is deterministic and follows the emitted item order rather than a sort.
Production: `packages/workflows/src/schedule.ts:159-167` (first-fit in input order). Test:
`packages/workflows/tests/unit/schedule.test.ts:237-243`.

**INV-W23.** A structurally unschedulable batch registers **nothing**. Production:
`buildRunWorkItemsHandler`. Test: `propagates a scheduling failure instead of guessing`
(`registrations === 0`).

**INV-W24.** The first round of a sequence must be `once`. Production:
`RoundCoordinator.start`. Test: `refuses when the first round consumes anything — there is nothing
yet to consume`.

**INV-W25.** A round id must match `/^[A-Za-z0-9._-]+$/u`, because the unit key encodes the item
index in brackets. Production: `ROUND_ID`, `parseRound`, `unitsOf`, and `foldRound`. Test:
`a bracketed index, which foldRound's key parsing would confuse`.

**INV-W26.** `startRounds` re-validates every bound at the programmatic boundary, before planning or
registry admission. Production: `RoundCoordinator.start` / `roundCallBoundsError`. Test: `the
programmatic executor rechecks fanout before planning or registry admission` and `the programmatic
executor rechecks every retained string and repeat bound`.

**INV-W27.** An unresolvable `{{…}}` placeholder is an error, never a blank; the first failure is
reported and the text is not half-substituted. Production:
`packages/workflows/src/interpolate.ts:51-60`. Test:
`packages/workflows/tests/unit/interpolate.test.ts:29-49`.

**INV-W28.** A replica that failed or answered off-schema stays in the accept denominator, tallied as
`(unavailable)`. Production: `packages/workflows/src/rounds.ts:156-160`, `:58`. Test:
`packages/workflows/tests/unit/rounds.test.ts:149-155`.

**INV-W29.** `fanout` is honoured for a work-item round rather than collapsed to one leader per item.
Production: `unitsOf` returns every replica of an item and encodes the replica suffix. Test:
`fanout is honoured for a work-item round, not collapsed to one leader per item` (2 items × 3
replicas = 6 leaders, `2 accepted / 0 rejected`).

**INV-W30.** Repeat deduplication is against everything seen so far, not against what survived
verification. Production: `packages/workflows/src/rounds.ts:199-213` (`next` seeded from `seen`) and
`nextAfter` in `createRoundCoordinator`. Test:
`packages/workflows/tests/unit/rounds.test.ts:196-208`.

**INV-W31.** `repeat.max_rounds` has no default and is required; `until` genuinely selects the
stopping rule. Production: `buildRunRoundTool`, `parseRepeat`, and
`packages/workflows/src/rounds.ts:235-240`. Test:
`packages/workflows/tests/unit/rounds.test.ts:328-356`.

**INV-W32.** A driver fault marks the sequence `failed`, still settles an existing held handle and
reports what ran. A registration fault is caught at the same boundary rather than escaping the tool
handler. Production: `reportDriverFault` and `launch` in `packages/workflows/src/run-round.ts`.
Test: `packages/workflows/tests/component/run-round.test.ts` (`a fault mid-sequence still settles the
held handle and reports what ran`) and `packages/workflows/tests/component/observability.test.ts`
(`a driver that throws is attributable to its rounds before adopt swallows it`).

**INV-W33.** `runOne` never rejects: a thrown leader or a throwing trace sink settles that unit
`failed` and releases its permit and reservation. Production: `runOne`. Test: `a leader that
throws after resolving still settles the item as failed` and the trace-sink fault case in
`packages/workflows/tests/component/observability.test.ts`.

**INV-W34.** The three-field `workflows` settings block is `strict`, `lastWins`, not
plugin-contributable, and exposes no per-run request param. `max_total_leaders` defaults to 32 and is
bounded at 255. Production: `workflowsConfigSchema` and `workflowsSettingsSpec`.
Test: `packages/workflows/tests/unit/settings.test.ts` pins the schema's bounds and defaults;
**the absence of a request param is unpinned in this package** (no test asserts
`workflowsSettingsSpec.requestParams === undefined`).

**INV-W35.** `managerLiveChildrenFloor` never exceeds `AGENTS_MAX_LIVE_CHILDREN`, equals the
supervision default at the default concurrency, and floors nonsensical input to the value for 1.
Production: `managerLiveChildrenFloor`. Test: `packages/workflows/tests/unit/settings.test.ts`.
The host applies it as a *floor*, keeping a deliberately higher operator value in
`createWorkflowsService`.

**INV-W36.** A `run_leader` title is required and never derived from the prompt. Production:
`parseLeaderSpec`. Test: `refuses a missing title instead of deriving one from the prompt` and
`registers the model's short title, not the whole prompt`.

**INV-W37.** A workflow trace projector rejects a detail that fails its guard by throwing rather than
emitting a partial event. Production: `packages/workflows/src/trace-events.ts:193-195`, used at
`:227-229`, `:249-251`, `:264-266`. Test: `packages/workflows/tests/unit/trace-events.test.ts:30ff`.

**INV-W38 (unpinned).** `describeQueued` is the only sentence telling the manager that units missing
from the handle list are waiting rather than skipped. Its *text* is pinned by `names the count and
tells the caller it needs no action`, and its presence in the `run_work_items` answer is pinned by
`runs every item and says how many are queued rather than listing only the started ones`, but
nothing pins its presence in `run_round`'s `describePlan` answer.

**INV-W39.** No authored next round or repeat pass starts when an authorized round settles. The
coordinator publishes `awaiting_manager` with one proposal and waits for an explicit decision.
Production: `advance` in `createRoundCoordinator`. Test:
`packages/workflows/tests/component/run-round.test.ts` (`finishing a round only creates a checkpoint;
a matching decision starts exactly one next round`).

**INV-W40.** `workflow_decide` is compare-and-set on sequence id and revision; stale and duplicate
deliveries spawn nothing. Production: `RoundCoordinator.decide`. Test: the stale and duplicate
assertions in the same Admiral-checkpoint component case.

**INV-W41.** Every repeat pass and every round within it is a proposal subject to the same Admiral
checkpoint; `nextRepeat` decides usefulness, not authority. Production: `nextAfter` and `advance`.
Test: `packages/workflows/tests/component/run-round.test.ts` (`repeat is a proposed pass and remains
idle until the Admiral continues it`).

**INV-W42.** Cumulative admission is atomic at the semantic unit: one ad-hoc leader, one complete
work-item batch, or one complete authorized round. Exhaustion never partially registers the unit and
does not consume an awaiting checkpoint. Production: `createWorkflowLeaderCount`, `beginDispatch`,
and `launch` inside `createRoundCoordinator`. Test: `packages/workflows/tests/unit/leader-count.test.ts` and the
three component cap cases.

**INV-W43.** A manager cannot silently finalize through an undecided checkpoint. The first attempt
nudges; the second means stop and spawns nothing. Production: `RoundCoordinator.finalizeGate`.
Test: `packages/workflows/tests/component/run-round.test.ts` (`finalization nudges once, then means
stop instead of implicit continuation`).

**INV-W44.** A setup fault cannot leak cumulative admission or a supervision handle. Faults before
registry acceptance release the unconsumed reservation. Every accepted handle consumes its lifetime
slot before trace publication; if that publication fails, the current handle and any accepted batch
prefix are aborted, settled and closed while only the unconsumed tail is released. A round-state
publication fault likewise terminalizes the sequence and ends the undispatched session, settling its
pending handles. Production: `buildRunLeaderHandler`, `registerOne`, `register`,
`abandonRegistered`, `DispatchSession.end`, and `launch` inside `createRoundCoordinator`. Tests:
`packages/workflows/tests/component/run-leader.test.ts` (`releases cumulative admission when child
registration throws`; `counts and settles an accepted child when its registration trace throws`),
`packages/workflows/tests/component/dispatch.test.ts` (`settles an already-registered prefix when a
later registration throws`; `counts and settles every accepted registration when the trace sink
throws mid-batch`), and `packages/workflows/tests/component/run-round.test.ts` (`a running-state
publication fault terminalizes the sequence and its undispatched session`).

**INV-W45.** One manager may own at most one non-terminal round sequence. A second `run_round` or
`run_workflow` call is refused in both `running_round` and `awaiting_manager`, and a terminal stop
releases the coordinator for a new sequence. Production: `RoundCoordinator.start` in
`createRoundCoordinator`. Test: `packages/workflows/tests/component/run-round.test.ts` (`one manager
owns at most one active round sequence`).

## 6. Failure modes and degradation

| Situation | Handling | Cite |
|---|---|---|
| malformed tool arguments | non-terminal textual result naming the field; nothing registered, nothing spent | each tool handler's parser-before-admission branch |
| cumulative leader limit reached by `run_leader` | refuses before generating/registering a child | `buildRunLeaderHandler`; component test `refuses an ad-hoc spawn after the manager reaches its cumulative leader ceiling` |
| a complete work-item batch or authorized round exceeds remaining cumulative capacity | refuses atomically; zero children from that unit; a round checkpoint and revision remain unchanged | `beginDispatch`, `launch` inside `createRoundCoordinator`; atomic cap component tests |
| child setup throws before registry acceptance, or producer accounting / trace publication throws after acceptance | releases every unconsumed cumulative slot; every accepted handle is aborted/settled/closed and remains counted as registration history | `buildRunLeaderHandler`, `registerOne`, `register`, `registerBackgroundChild`; setup-fault component tests |
| `running_round` state publication throws after the first handle was registered | sequence becomes `failed`; `DispatchSession.end` settles every not-yet-run pending handle and releases only unconsumed reservation tail | `launch` in `createRoundCoordinator`, `DispatchSession.end`; component test `a running-state publication fault terminalizes the sequence and its undispatched session` |
| tree budget exhausted at `run_leader` | after semaphore admission: `warn`, `onBudgetExhausted`, registered handle settles `failed`, no model call | `buildRunLeaderHandler` in `packages/workflows/src/capability.ts`; test `packages/workflows/tests/component/capability.test.ts` (`settles an admitted leader failed when the tree budget is exhausted`) |
| tree budget exhausted mid-batch | after semaphore admission: latch; this unit and every later one skipped `budget_exhausted`; the controlled sequence becomes `failed` and proposes no later round | `runOne`, `advance` inside `createRoundCoordinator` |
| registry sealed / at ceiling on the first batch | tool refuses outright with "too many child agents are already running" | `beginDispatch` plus the null-session branches in the batch/round handlers |
| registry full mid-batch, foreign children live | poll with exponential backoff (25 ms → 500 ms), **no deadline**; one `info` stall record after 5 s | `waitForCapacity` / `reportCapacityWait` |
| registry full mid-batch, only our own batons live | remaining units reported `unregistered` rather than waiting forever | structural-refusal branch of `DispatchSession.run`; test `gives up on a queue no slot can ever free, instead of waiting forever` |
| leader `executeRun` throws | caught in `runLeader`; `status:"error"`, `code:"leader_run_failed"`; the stack exists only in the log | `packages/workflows/src/run-leader.ts:115-127` |
| leader task throws outside `runLeader` | `workflow.leader_faulted`, a `workflow_run_failed` edge, child settles `failed` | `buildRunLeaderHandler` / `runOne` |
| trace sink throws while recording the failure edge | `workflow.trace_sink_failed` at `error`; the durable record is knowingly missing that edge; the unit still settles | failure-edge catch inside `runOne` |
| an explicitly authorized later round cannot be planned, its guard is empty, or it selects no items | `workflow.round_skipped`, one cumulative report clause, then a new checkpoint/terminal state; no leader is registered for the skipped round | `skip` / `launch` in `createRoundCoordinator` |
| the first round cannot be planned, its guard is empty, or it selects no items | hard refusal; no active sequence and no child | `RoundCoordinator.start` / `launch` |
| the round sequence stops on cancellation | status `cancelled`; no later proposal or leader | cancelled branch in `launch` inside `createRoundCoordinator` |
| `workflow_decide` carries an unknown session, stale revision, duplicate delivery, or non-awaiting state | non-progressing textual refusal; no leader | `RoundCoordinator.decide` |
| Admiral finalizes while a sequence awaits | first attempt nudges; second transitions to `stopped` and passes without spawning | `RoundCoordinator.finalizeGate` |
| a leader answers prose where a schema was expected | `mergeResults` degrades to an array/scalar; `workflow.round_folded` reports `result_shape` and `non_object_replicas` so the degradation is visible | `mergeResults` / `reportRoundFolded`; observability component case |
| a replica died | counted in the accept denominator as `(unavailable)` | `packages/workflows/src/rounds.ts:156-160` |
| `run_workflow` with no elicit channel or no clock | fails closed, suggesting `explain: true` | `buildRunWorkflowHandler` |
| `run_workflow` review declined, dismissed, invalid, or timed out | distinct tool result plus `workflow.review_resolved`; timeout also emits `capability.elicit_no_response`; no leader spawned | `buildRunWorkflowHandler` |
| host wired no logger | `NOOP_LOGGER`, and `withBoundLogger` returns the deps object **by identity** so `executeRun` sees exactly what the host supplied | `packages/workflows/src/log.ts:29-31`, `:50-57`; test `packages/workflows/tests/component/observability.test.ts:781-793` |
| a `cause` that is neither `Error` nor string | dropped rather than coerced to `[object Object]` | `packages/workflows/src/log.ts:70-73`, `:90-93` |

Silently tolerated: a `file` entry that normalizes to the empty string is dropped, which silently
widens a mutator to unscoped (`packages/workflows/src/schedule.ts:243`) — visible only through
`workflow.schedule_derived`'s `unscoped_writers` count (`packages/workflows/src/schedule-log.ts:38`).

## 7. Coupling

### 7.1 What this package depends on

| Target | Kind | Forced by |
|---|---|---|
| `@clarvis/capability` | runtime, static | `bind`, `parseTaskTitle`, `TASK_TITLE_MAX` (`packages/workflows/src/capability.ts:30`); `createSemaphore` (`packages/workflows/src/concurrency.ts:11`); `levelEnabled`, `NOOP_LOGGER`, `sanitizeErrorMessage` (`packages/workflows/src/run-round.ts:23-28`, `packages/workflows/src/log.ts:17`); `elicitWithClockPause` (`packages/workflows/src/run-workflow.ts:23`) |
| `@clarvis/supervision` | runtime, static | `AGENT_REGISTRY_PORT` + `registerBackgroundChild` (`packages/workflows/src/capability.ts:31`, `packages/workflows/src/dispatch.ts:47`); `AGENTS_MAX_LIVE_CHILDREN` for the floor (`packages/workflows/src/settings.ts:22`) |
| `@clarvis/loop` | two sites: type-only from the root, runtime from the workflow adapter | `packages/workflows/src/types.ts:8` type-imports `ExecuteRunArgs`, `ExecuteRunDeps`, `ExecuteRunOutcome`; `packages/workflows/src/elicit-mux.ts:15` value-imports `createElicitSerializer` from `@clarvis/loop/workflows` — pinned by `packages/workflows/tests/architecture/dependency-direction.test.ts:15-30` |
| `zod` | runtime | the settings schema (`packages/workflows/src/settings.ts:20`) |
| `yaml` | runtime | declared in `package.json`; used by `artifact.ts` (delegated document) |

The engine dependency is deliberately narrowed further at runtime by `WorkflowRunDeps`
(`packages/workflows/src/types.ts:71-74`): only `generateExecutionId` and `executeRun`. A host supplies the real
implementation; every test in this package supplies a per-context fake instead of mocking a module
(`packages/workflows/tests/helpers/workflow.ts:22-36`).

The loop's own `@clarvis/loop/workflows` entry exports exactly one symbol,
`createElicitSerializer` (`packages/loop/src/workflows.ts:14`), and its TSDoc records that
supervision used to be re-exported there and was moved to `@clarvis/supervision` so both packages
depend on a leaf (`packages/loop/src/workflows.ts:8-12`).

### 7.2 What depends on this package

| Consumer | Edge | Cite |
|---|---|---|
| `@clarvis/kernel` — capability registry | registers `workflowsSettingsSpec` at module load | `packages/kernel/src/config/capability-registry.ts:5`, `:24` |
| `@clarvis/kernel` — kernel | accepts `WORKFLOW_GRANT` as a runnable grant and reads the block's defaults | `packages/kernel/src/kernel.ts` (`createInProcessKernel`'s `knownGrants`, `readWorkflowsSettings`) |
| `@clarvis/kernel` — workflows service | constructs semaphore, ledger, cumulative leader count and the capability; applies `managerLiveChildrenFloor` | `runManagerWorkflow` and `raiseLiveChildrenCeiling` in `packages/kernel/src/workflows/workflows-service.ts` |
| `@clarvis/kernel` — event mapping | consumes the trace-event guards/types | `packages/kernel/src/runs/map-events.ts:19` |
| `@clarvis/kernel` — workflow policy | `LeaderProfileInfo` (type-only) | `packages/kernel/src/application/workflow-policy.ts:2` |

Nothing in `@clarvis/loop`, `@clarvis/supervision` or `@clarvis/capability` imports this package;
their only occurrences of the name are TSDoc prose (`packages/loop/src/workflows.ts:10`,
`packages/supervision/src/index.ts:8`, `packages/supervision/src/spawn-child.ts:4`,
`packages/capability/src/agents-port.ts:3`, `:6`). `@clarvis/loop`'s
`packages/loop/tests/architecture/no-feature-names.test.ts:21-25` explicitly exempts `@clarvis/workflows` from its
package-name scan, on the stated ground that `@clarvis/loop/workflows` is the sanctioned adapter
entry.

The capability is injected into a **manager's** `executeRun` only, never into shared run deps: the
kernel comments state that at `packages/kernel/src/kernel.ts:800-803`, and the grant is stripped from
leader profiles by the workflows service (`stripWorkflowGrant` in
`packages/kernel/src/workflows/workflows-service.ts` — function docstring "Remove the `workflow`
grant from every profile so a leader can never become a
[manager]"). The construction of `WorkflowCtx` itself belongs to the sibling document
**workflows-documents-and-service**.

## 8. Open questions

- **`ExecuteRunDeps.capabilities` vs `ExecuteRunArgs.capabilities` for leaders.** `runLeader` passes
  the budget-only capability on the per-call `capabilities` array (`packages/workflows/src/run-leader.ts:99`) while handing
  `ctx.deps` through unchanged. Whether the host's `deps.capabilities` are *also* active for a leader
  run is decided in the loop's composition, which is outside this document's scope; the debug
  record at `packages/workflows/src/run-leader.ts:87-89` implies they are ("the capabilities named here are the whole
  surface it gets"), but that is prose, not a verified mechanism.
- **Why background is the only mode.** The module TSDoc in `capability.ts` asserts it and gives a
  rationale, and the immediate-verdict component case fails with a message about a deferred verdict
  — but no test in this package measures the manager's latency, so the TSDoc claim that a deferred
  verdict is joined by `runDispatch`'s `finally` is unverified from this package's code. The
  loop-side dispatch belongs to another document.
- **`WorkflowCtx.workflowDefs` provenance.** The type says the host supplies loaded definitions and
  "this package never reads a root itself" (`WorkflowCtx.workflowDefs` in
  `packages/workflows/src/types.ts`); the loader in `artifact.ts` and the kernel service that calls
  it belong to **workflows-documents-and-service**.
- **`ExecuteRunOutcome.response.status` domain.** `LeaderStatus` (`packages/workflows/src/types.ts:33-34`) enumerates six
  statuses and `runLeader` passes `response.status` through verbatim (`packages/workflows/src/run-leader.ts:114`); the loop's
  `RunResponse` is outside this document's scope, so whether the two sets coincide is unconfirmed.
- **`elicitWithClockPause` semantics.** Used by `buildRunWorkflowHandler`; its clock-pause
  behaviour is the elicitation document's.
- **`AgentRegistryPort.liveCount()` counting rules.** `waitForCapacity` subtracts `oursLive` from it
  and treats the remainder as foreign. What exactly the registry counts as live (adopted tasks?
  retained children?) is [foundations/supervision.md](../foundations/supervision.md)'s.
- **Unpinned invariants.** (a) `workflowsSettingsSpec` exposing no `requestParams` is
  asserted nowhere in this package (§5 INV-W34). (b) `describeQueued`'s appearance in
  `run_round`'s `describePlan` text is unasserted (§5 INV-W38). (c) `placeholders`
  (`packages/workflows/src/interpolate.ts:64`) has a unit test (`packages/workflows/tests/unit/interpolate.test.ts:54`) but no `src/` caller
  inside this document's scope — its consumer is presumably `artifact.ts`'s load-time validation, which
  is not covered here.
- **`WorkflowLedger.reserve` sizing rationale.** Division by `maxConcurrent` and `ceil` are
  documented by `WorkflowLedger.reserve` and pinned numerically in
  `packages/workflows/tests/unit/ledger.test.ts`; the separate manager budget is a topology rule,
  not another provisional share in this arithmetic.
- **`MANAGER_REGISTRY_HEADROOM = 4`.** Its TSDoc in `settings.ts` enumerates three slot consumers
  and says four covers the shapes a manager actually produces; no test derives 4 from those three,
  so the constant is a judgement that cannot be verified mechanically.
- **`DispatchUnit.replicaCount`** is recorded into the start trace by `runOne` and projected
  (`packages/workflows/src/trace-events.ts:242`), but nothing in this package reads it back; its consumer would be a UI.
