# Manager to leader fan-out: the four spawn tools, waves, rounds and the ledger

> Implemented at `packages/workflows/...`. Every claim below is anchored to a file and line. Open
> questions are collected in the final section.

## 1. Purpose

`@clarvis/workflows` turns one agent run (the **manager**) into a fan-out of independent agent runs
(**leaders**). The manager never calls `executeRun` itself: it calls one of four model-facing tools,
and the package registers each leader as a background child in the run's supervision registry, runs
it through `runLeader` (`packages/workflows/src/run-leader.ts:52`), meters its output tokens against
a workflow-child ledger (`packages/workflows/src/ledger.ts:71`), and bounds how many run at once with a
FIFO semaphore (`packages/workflows/src/concurrency.ts:11`).

The four tools sit on a ladder of how much structure the caller supplies: `run_leader` starts one
ad-hoc leader (`packages/workflows/src/tool.ts:11`); `run_work_items` takes a decomposition and lets
the runtime derive the dependency order and the write-conflict separation
(`packages/workflows/src/work-items.ts:42`, `packages/workflows/src/schedule.ts:178`); `run_round`
executes a sequence of declared rounds whose barriers follow from what each round *consumes*
(`packages/workflows/src/run-round.ts:65`, `packages/workflows/src/rounds.ts:120`); `run_workflow`
compiles a workflow document the workspace ships into exactly the round sequence `run_round` runs
(`packages/workflows/src/run-workflow.ts:31`, `:294`).

`run_leader`, `run_work_items`, and `run_round` answer **immediately** with an agent handle or a wave
plan (`packages/workflows/src/capability.ts:355`, `packages/workflows/src/work-items.ts:417`,
`packages/workflows/src/run-round.ts:920-924`). `run_workflow` first awaits its mandatory interactive
review; after approval it starts the same background round driver and returns a normal result verdict,
never a deferred one (`packages/workflows/src/run-workflow.ts:261-301`). The work continues on a task
the registry adopts (`packages/workflows/src/capability.ts:353`,
`packages/workflows/src/work-items.ts:415`, `packages/workflows/src/run-round.ts:997`). The
three-level topology (Manager → Leaders →
Sub-agents) is fixed by two structural gates rather than a depth counter: only an **entry** agent
carrying the `workflow` grant is contributed the tools
(`packages/workflows/src/capability.ts:103`), and a leader's request is assembled without that grant
by the host (`packages/workflows/src/types.ts:53-59`).

## 2. Surface

### 2.1 Package entrypoints

| Subpath | File | Notes |
|---|---|---|
| `.` | `packages/workflows/src/index.ts` | the exported API below |
| `./schemas` | `packages/workflows/src/schemas.ts` | result schemas + `WORKFLOW_LIMITS` re-export (`packages/workflows/src/schemas.ts:20`) |
| `./artifact` | `packages/workflows/src/artifact.ts` | workflow-document loading — **delegated** to [capabilities/workflows-service.md](workflows-service.md) |

`run-round.ts`, `work-items.ts`, `dispatch.ts`, `schedule.ts`, `rounds.ts`, `interpolate.ts`,
`log.ts`, `schedule-log.ts` and `result-text.ts` export symbols but are reachable only from **inside**
the package: `packages/workflows/package.json` resolves no subpath to them. `capability.ts` is what
reaches them (`packages/workflows/src/capability.ts:32,38-44`).

### 2.2 Exported values in scope for this document

| Export | Signature / value | Defined |
|---|---|---|
| `createWorkflowsCapability` | `(ctx: WorkflowCtx) => Capability` | `packages/workflows/src/capability.ts:76` |
| `WORKFLOW_GRANT` | `"workflow"` | `packages/workflows/src/capability.ts:55` |
| `WORKFLOWS_CAPABILITY_NAME` | `"workflows"` (re-exported from settings by `packages/workflows/src/index.ts:69-75`) | `packages/workflows/src/settings.ts:25` |
| `runLeader` | `(spec, ctx, runId?, heldReservation?) => Promise<LeaderResult>` | `packages/workflows/src/run-leader.ts:52` |
| `createWorkflowLedger` | `(total: number \| null) => WorkflowLedger` | `packages/workflows/src/ledger.ts:71` |
| `createWorkflowSemaphore` | `= createSemaphore` from `@clarvis/capability` | `packages/workflows/src/concurrency.ts:11` |
| `buildRunLeaderTool` / `RUN_LEADER_TOOL_NAME` | `(profiles?) => NamespacedTool` / `"run_leader"` | `packages/workflows/src/tool.ts:47`, `packages/workflows/src/tool.ts:11` |
| `WORKFLOW_LIMITS` | frozen numeric ceilings | `packages/workflows/src/limits.ts:11` |
| `WORKFLOWS_DEFAULTS`, `WORKFLOWS_MAX_CONCURRENCY`, `WORKFLOWS_SETTINGS_FIELDS`, `workflowsSettingsSpec`, `managerLiveChildrenFloor` | settings block | `packages/workflows/src/settings.ts:73,36,96,111,62` |
| `recordWorkflowTrace`, `WORKFLOW_TRACE_KINDS`, `WORKFLOW_PERSISTED_TRACE_PROJECTORS`, the three `is*` guards | trace vocabulary | `packages/workflows/src/trace-events.ts:198,13,223,117,134,151` |

Internal but load-bearing: `beginDispatch` (`packages/workflows/src/dispatch.ts:196`), `describeQueued` (`packages/workflows/src/dispatch.ts:424`),
`reportSettled` (`packages/workflows/src/dispatch.ts:618`), `startRounds` (`packages/workflows/src/run-round.ts:939`), `scheduleWorkItems`
(`packages/workflows/src/schedule.ts:178`), `toWorkItem` / `workItemBrief` (`packages/workflows/src/work-items.ts:170,281`), `interpolate` /
`placeholders` (`packages/workflows/src/interpolate.ts:39,64`), and the pure round vocabulary in `rounds.ts`. The other three
tools' wire-name constants are internal in the same way `RUN_LEADER_TOOL_NAME` would be if `tool.ts`
were not re-exported: `RUN_WORK_ITEMS_TOOL_NAME` (`packages/workflows/src/work-items.ts:42`), `RUN_ROUND_TOOL_NAME`
(`packages/workflows/src/run-round.ts:65`) and `RUN_WORKFLOW_TOOL_NAME` (`packages/workflows/src/run-workflow.ts:31`) are module-level `export
const`s that `index.ts` never re-exports — unlike `RUN_LEADER_TOOL_NAME`, which §2.2's table lists
because `packages/workflows/src/index.ts:25` does.

### 2.3 The four model-facing tools

All four carry `mcpName: ""` and `wireName === toolName === fullName`
(`packages/workflows/src/tool.ts:87-90`, `packages/workflows/src/work-items.ts:147-150`, `packages/workflows/src/run-round.ts:198-202`, `packages/workflows/src/run-workflow.ts:52-55`).

**`run_leader`** (`packages/workflows/src/tool.ts:47`) — `additionalProperties: false`, `required: ["title","prompt"]`
(`packages/workflows/src/tool.ts:94-96`).

| Property | Type | Bound | Line |
|---|---|---|---|
| `title` | string | `minLength 1`, `maxLength LEADER_TITLE_MAX` (= `TASK_TITLE_MAX`, 60) | `packages/workflows/src/tool.ts:49-52`, `packages/workflows/src/tool.ts:22` |
| `prompt` | string | `minLength 1`, `maxLength WORKFLOW_LIMITS.textChars` | `packages/workflows/src/tool.ts:58-61` |
| `profile` | string enum | present **only** when `profiles.length > 0`; enum = profile names | `packages/workflows/src/tool.ts:67-79` |
| `expect_schema` | object | free-form JSON Schema | `packages/workflows/src/tool.ts:80-85` |

**`run_work_items`** (`packages/workflows/src/work-items.ts:67`) — `required: ["items"]` (`packages/workflows/src/work-items.ts:156`).

| Property | Shape | Line |
|---|---|---|
| `items[]` | `minItems 1`, `maxItems WORKFLOW_LIMITS.workItems`; each item requires `id`, `title`, `goal`, `files`, `dependencies`, `mutation` | `packages/workflows/src/work-items.ts:69-119` |
| `items[].files` | `maxItems filesPerWorkItem`, each `maxLength pathChars` | `packages/workflows/src/work-items.ts:101-106` |
| `items[].dependencies` | `maxItems dependenciesPerWorkItem`, each `maxLength identifierChars` | `packages/workflows/src/work-items.ts:107-112` |
| `profile` | enum, only when profiles exist; applies to **every** item | `packages/workflows/src/work-items.ts:122-132` |
| `brief_prefix` | string ≤ `textChars`, prepended to every brief | `packages/workflows/src/work-items.ts:133-139` |
| `expect_schema` | object, applied to every leader | `packages/workflows/src/work-items.ts:140-145` |

**`run_round`** (`packages/workflows/src/run-round.ts:122`) — `required: ["rounds"]` (`packages/workflows/src/run-round.ts:207`).

| Property | Shape | Line |
|---|---|---|
| `rounds[]` | `minItems 1`, `maxItems WORKFLOW_LIMITS.rounds`; each requires `id`,`type`,`over`,`title`,`brief` | `packages/workflows/src/run-round.ts:209-219` |
| `rounds[].type` | enum `discovery \| findings \| verdict \| free` | `packages/workflows/src/run-round.ts:126-132`, `packages/workflows/src/run-round.ts:104` |
| `rounds[].over` | selector string ≤ `pathChars` | `packages/workflows/src/run-round.ts:133-142` |
| `rounds[].fanout` | integer 1…`WORKFLOW_LIMITS.fanout` | `packages/workflows/src/run-round.ts:155-162` |
| `rounds[].accept` | rule string | `packages/workflows/src/run-round.ts:163-170` |
| `rounds[].when` | `<round>.<field>` guard | `packages/workflows/src/run-round.ts:171-177` |
| `rounds[].profile` | enum, only when profiles exist | `packages/workflows/src/run-round.ts:179-189` |
| `repeat` | requires `rounds`,`dedupe_by`,`max_rounds`; optional `until` (`no_new`\|`budget`) and `dry_rounds` | `packages/workflows/src/run-round.ts:220-251` |
| `args` | object, `maxProperties WORKFLOW_LIMITS.args`, property names ≤ `identifierChars` | `packages/workflows/src/run-round.ts:252-257` |

**`run_workflow`** (`packages/workflows/src/run-workflow.ts:46`) — returns `null` (i.e. the tool is **not contributed**)
when the workspace ships no workflow documents (`packages/workflows/src/run-workflow.ts:49`). `required: ["name"]`
(`packages/workflows/src/run-workflow.ts:60`); properties `name` (enum of loaded workflow names, `:62-70`), `args`
(`:71-79`), `explain` (boolean, `:80-85`).

### 2.4 The capability object

| Field | Value | Line |
|---|---|---|
| `name` | `"workflows"` | `packages/workflows/src/capability.ts:136` |
| `grants` | `[{ name: "workflow", entryCanSpawn: true }]` | `packages/workflows/src/capability.ts:137`, `:58` |
| `persistedTraceProjectors` | the three workflow projectors | `packages/workflows/src/capability.ts:138` |
| `reservedWireNames` | the contributed tools' wire names | `packages/workflows/src/capability.ts:86`, `:139` |
| `toolEffects` | every contributed tool → `"spawn_run"` | `packages/workflows/src/capability.ts:96-98`, `:140` |
| `forRun(runCtx)` | `null` when `services.get(AGENT_REGISTRY_PORT)` is absent | `packages/workflows/src/capability.ts:141-155` |

### 2.5 Settings

`workflowsSettingsSpec` (`packages/workflows/src/settings.ts:120`): `key: "workflows"`, `merge: "lastWins"`,
`pluginContributable: false`. The block is `.strict()` (`packages/workflows/src/settings.ts:102`) with two fields:

| Key | Schema | Default |
|---|---|---|
| `max_concurrency` | int, positive, `.max(WORKFLOWS_MAX_CONCURRENCY)` = 20 | 4 (`packages/workflows/src/settings.ts:83`) |
| `budget_tokens` | int, positive, **nullable** (`null` = unbounded) | 640 000 000 (`packages/workflows/src/settings.ts:84`): four 160-million-token shares at the default concurrency, intentionally larger in aggregate than the manager's primary session budget |

There is **no per-run request param**: the spec declares no `requestParams`
(`packages/workflows/src/settings.ts:120-125`), and the TSDoc states the capability is constructed by the host's workflow
service, "never by the loop from a run-request field" (`packages/workflows/src/settings.ts:113-119`).

`managerLiveChildrenFloor(maxConcurrency)` (`packages/workflows/src/settings.ts:71`) returns
`min(AGENTS_MAX_LIVE_CHILDREN, floor(max(1, maxConcurrency)) + 4)`, the 4 being
`MANAGER_REGISTRY_HEADROOM` (`packages/workflows/src/settings.ts:57`). At the default concurrency it equals the supervision
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
| leader `runId` | whatever `ctx.runDeps.generateExecutionId()` returns | `packages/workflows/src/capability.ts:222`, `packages/workflows/src/dispatch.ts:596` |
| agent handle id | `ag_` + 8 hex, minted by the supervision registry | asserted `packages/workflows/tests/component/run-leader.test.ts:239` |
| dispatch unit `key` (work items) | the work item's own `id` | `packages/workflows/src/work-items.ts:295-296` |
| dispatch unit `key` (rounds) | `` `${round.id}[${itemIndex}]${fanout>1 ? "#"+(replica+1) : ""}` `` | `packages/workflows/src/run-round.ts:590,593` |
| round `id` | must match `/^[A-Za-z0-9._-]+$/u` | `packages/workflows/src/run-round.ts:114`, enforced `packages/workflows/src/run-round.ts:269-278` |

The round-id character class is load-bearing, not cosmetic: `foldRound` recovers an item index by
`/\[(\d+)\]/u.exec(outcome.key)` (`packages/workflows/src/run-round.ts:774`), so an id such as `pass[1]` would fold every
outcome onto item 1 (`packages/workflows/src/run-round.ts:106-113`; pinned at
`packages/workflows/tests/component/run-round.test.ts:1393-1402`).

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

`schemaFor(type)` returns `WORKFLOW_RESULT_SCHEMAS[type]` and `undefined` for `free`
(`packages/workflows/src/run-round.ts:512-514`); the map is `{discovery, findings, verdict}` (`packages/workflows/src/schemas.ts:218-222`). Pinned:
`packages/workflows/tests/component/run-round.test.ts:710-723`.

### 3.7 The dispatch unit and outcome (`packages/workflows/src/dispatch.ts:62-187`)

`DispatchUnit` (`packages/workflows/src/dispatch.ts:62-80`) is what the two batched dispatchers,
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

`DispatchStatus` (`packages/workflows/src/dispatch.ts:83-84`) is the closed six-value union every unit settles into:
`completed | failed | cancelled | blocked | budget_exhausted | unregistered`. `DispatchOutcome`
(`packages/workflows/src/dispatch.ts:87-92`) pairs one back with its unit: `{ key: string; status: DispatchStatus; result:
unknown }`, where `result` is the leader's own result, structured when `expectSchema` was set.
`DispatchGate` (`packages/workflows/src/dispatch.ts:111`) is `(unit: DispatchUnit) => { blocked: string } | null` — the
per-unit blocker function `run_work_items` and `run_round` each build from their own dependency
tracking (§4.6, §4.8). `DispatchSession` (`packages/workflows/src/dispatch.ts:144-187`) is the object `beginDispatch` returns:
`anchorId`, `pendingHandles()`, `queuedCount()`, `run(gate?)`, `cancelled()`, `advance(units)`, and
`end(summary)` — the API §4.4 describes by behavior.

### 3.8 Leader result text (`packages/workflows/src/result-text.ts:9-27`)

`describeLeaderResult(result: LeaderResult)` is the single projection of a finished leader's outcome
into the text a manager reads, shared by `run_leader` (`packages/workflows/src/capability.ts:312`) and by both
`run_work_items` and `run_round`, which reach it through `dispatch.ts`'s `runOne` (`packages/workflows/src/dispatch.ts:765`).
Its rule, in order: an `error` on the `LeaderResult` wins outright, rendered as `result.error.message`;
otherwise the raw `result.result` is projected by `stringifyResult` — a plain string passes through
unchanged; else, for an object, a string-valued `.text` property is extracted; else `JSON.stringify`,
falling back to the literal `"[unserializable result]"` if that throws (`packages/workflows/src/result-text.ts:9-20`).

## 4. Behavior

### 4.1 Capability construction and activation

1. `createWorkflowsCapability(ctx)` builds all four tool descriptors up front — `run_leader`,
   `run_work_items`, `run_round`, and `run_workflow` only if `buildRunWorkflowTool(workflows)`
   returned non-null (`packages/workflows/src/capability.ts:77-85`). `ctx.workflowDefs ?? []` is the workflow list
   (`packages/workflows/src/capability.ts:80`).
2. `reservedWireNames` and `toolEffects` are derived from that same array
   (`packages/workflows/src/capability.ts:86`, `:96-98`), so the reserved set grows with the tool set rather than being
   spelled twice.
3. `forRun(runCtx)` looks up `AGENT_REGISTRY_PORT` on the run's service registry
   (`packages/workflows/src/capability.ts:142`). Absent → one `warn` (`event: "workflow.capability_inactive"`,
   `reason: "no_registry"`) and `null` (`packages/workflows/src/capability.ts:143-153`).
4. `forAgent(scope)` computes `manager = scope.entry && scope.grants.includes(WORKFLOW_GRANT)`
   (`packages/workflows/src/capability.ts`). It always returns a contribution object; `attach` returns
   `{ outputBudget: ctx.ledger }` alone for a non-manager and
   `{ tools, handlers, advertised: true }` for the manager. The manager therefore remains on the
   primary session budget while its children use the workflow ledger.
5. `reportInactive` splits the refusal by reason: a **sub-agent** (`!scope.entry`) is a `debug` note
   (`packages/workflows/src/capability.ts:178-184`); an **entry** agent without the grant is a `warn`
   (`packages/workflows/src/capability.ts:185-188`).

| (scope) | tools | outputBudget | log |
|---|---|---|---|
| entry + `workflow` grant | all contributed tools | none (primary session budget) | none |
| entry, no grant | none | `ctx.ledger` | `warn reason=no_grant` (`packages/workflows/src/capability.ts:185`) |
| non-entry (sub-agent) | none | `ctx.ledger` | `debug reason=not_entry` (`packages/workflows/src/capability.ts:179`) |
| run with no registry | capability is `null` | — | `warn reason=no_registry` (`packages/workflows/src/capability.ts:144`) |

Pinned: `packages/workflows/tests/component/capability.test.ts:51-64` (`"keeps the manager on its session budget while carrying the leader budget to descendants"`), `:19-27`,
`packages/workflows/tests/component/observability.test.ts:141-157`.

### 4.2 `run_leader` — one ad-hoc leader

In `buildRunLeaderHandler.handle` (`packages/workflows/src/capability.ts`), synchronously:

1. `parseLeaderSpec(call.arguments)` — see §4.7.
2. `runId = ctx.runDeps.generateExecutionId()`.
3. `registerBackgroundChild(agents, bc.trace, {kind:"leader", nativeId:runId, title, profile?})`.
   `null` (registry sealed or at its ceiling) answers "too many child agents are already running";
   no ledger reservation has been taken, pinned by
   `packages/workflows/tests/component/capability.test.ts` (`refuses to spawn when the registry has
   no room without reserving ledger headroom`).
4. A per-leader `WorkflowCtx` clone is built: bound logger, `signal = AbortSignal.any([ctx.signal,
   controller.signal])`, a `steerForLeader` that returns this child's steer queue for its own id, and
   an `onLeaderEvent` that ingests matching events into the handle *and* forwards outward.
5. An async task is started and `agents.adopt(handle.id, task)` registers it.
6. The handler returns `{kind:"result", progress:true}` naming the agent id and the leader run id.

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

`beginDispatch(deps, first)` (`packages/workflows/src/dispatch.ts:196`) registers the first batch and returns `null` when
the registry admitted **none** of it, after a `warn` `workflow.dispatch_refused`
(`packages/workflows/src/dispatch.ts:202-217`). Otherwise it binds the session logger to the first handle's id as
`dispatch_id` and emits `info` `workflow.dispatch_begun` with `units`/`registered`/`queued`
(`packages/workflows/src/dispatch.ts:218-229`).

`register` (`packages/workflows/src/dispatch.ts:439`) stops at the **first** refusal and pushes the whole tail to
`backlog`, preserving the caller's order (`packages/workflows/src/dispatch.ts:445-456`); on an already-aborted run every
unit becomes an entry with `spawn: null` instead (`packages/workflows/src/dispatch.ts:442-445`), which is what makes
`beginDispatch` return `null` rather than a session whose queue can never drain.

`run(gate?)` (`packages/workflows/src/dispatch.ts:249`) then:

1. takes the pending batch and resets `pending` to empty (`packages/workflows/src/dispatch.ts:250-251`);
2. starts every registered entry via `start` → `runOne` (`packages/workflows/src/dispatch.ts:277-291`, `:312`);
3. `pump()` registers and starts backlog units while the registry admits them
   (`packages/workflows/src/dispatch.ts:300-310`), stopping on `stopped()`;
4. joins in-flight tasks in a loop, and when its own units have all settled but backlog remains,
   calls `waitForCapacity` and retries (`packages/workflows/src/dispatch.ts:328-354`);
5. writes `cancelled` (if stopped) or `unregistered` for whatever backlog remains
   (`packages/workflows/src/dispatch.ts:355-362`);
6. hands its last held handle to the session-level `baton` (`packages/workflows/src/dispatch.ts:363`).

**The baton.** `finish(settle)` decrements `outstanding` and settles immediately while other units
of this batch are live; the last one is *held* rather than settled (`packages/workflows/src/dispatch.ts:266-274`). The
decrement happens in `finish` rather than when the task resolves, because two units settling in the
same tick would otherwise both read the pre-decrement count and both settle
(`packages/workflows/src/dispatch.ts:259-264`). `advance(units)` registers the next batch and releases the previous baton
**only if the new batch actually got a handle** (`packages/workflows/src/dispatch.ts:388-393`). `end(summary)` releases the
final baton, appending the summary to that child's result (`packages/workflows/src/dispatch.ts:407-410`,
`packages/workflows/src/dispatch.ts:659-663`).

Inside `pump` the order is stated as load-bearing: register the replacement, *then* release the held
handle, *then* start the unit — because a unit the gate blocks settles synchronously and would
otherwise overwrite the held settle (`packages/workflows/src/dispatch.ts:292-299`, `:301-309`).

**Capacity waiting.** `waitForCapacity` (`packages/workflows/src/dispatch.ts:530`) computes `foreignLive =
agents.liveCount() - oursLive` where `oursLive` counts this batch's held handle *and* the previous
batch's baton (`packages/workflows/src/dispatch.ts:344`, `:538-539`). `foreignLive <= 0` → `false`, i.e. the refusal is
structural and the tail is reported `unregistered` (`packages/workflows/src/dispatch.ts:539`). Otherwise it sleeps
`min(500, 25 · 2^min(attempt,10))` ms, resolving early on abort (`packages/workflows/src/dispatch.ts:540`, `:463-466`,
`:473-483`). There is deliberately **no deadline** (`packages/workflows/src/dispatch.ts:519-523`); instead the poll is
sampled at `debug` and a single `info` `workflow.capacity_stalled` fires once past
`CAPACITY_STALL_MS` = 5000 (`packages/workflows/src/dispatch.ts:487`, `:565-584`).

State table for one unit's slot, as `run` sees it:

| State | Event | Next | Effect |
|---|---|---|---|
| registered | task settles, `outstanding > 0` | settled | `settle()` frees a registry slot (`packages/workflows/src/dispatch.ts:268-270`) |
| registered | task settles, last of batch | held (baton) | previous `held` released, this one kept (`packages/workflows/src/dispatch.ts:272-273`) |
| backlog | a settlement freed a slot | registered | `pump` registers + starts it (`packages/workflows/src/dispatch.ts:301-308`) |
| backlog | registry full, foreign children live | backlog | poll + retry (`packages/workflows/src/dispatch.ts:345-353`) |
| backlog | registry full, only our batons live | outcome `unregistered` | (`packages/workflows/src/dispatch.ts:539`, `:355-361`) |
| backlog | `stopped()` | outcome `cancelled` | (`packages/workflows/src/dispatch.ts:357`) |
| held | `advance(next)` registers ≥ 1 | settled | baton released (`packages/workflows/src/dispatch.ts:388-391`) |
| held | `advance(next)` registers 0 | held | baton kept (`packages/workflows/src/dispatch.ts:390`) |
| held | `end(summary)` | settled with summary | (`packages/workflows/src/dispatch.ts:407-409`) |

`advance` on a stopped dispatch registers nothing at all, emits `warn`
`workflow.dispatch_halted` with `queued_dropped`, and empties `pending`
(`packages/workflows/src/dispatch.ts:373-384`).

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

`buildRunWorkItemsHandler.handle` (`packages/workflows/src/work-items.ts:353`):

1. `parseWorkItemsCall` (`packages/workflows/src/work-items.ts:354`, defined `:208`).
2. `scheduleWorkItems(items)` (`packages/workflows/src/work-items.ts:357`). Not ok → `reportScheduleRefused` + a textual
   verdict naming the code and message; **nothing is registered**
   (`packages/workflows/src/work-items.ts:358-363`; pinned `packages/workflows/tests/component/work-items.test.ts:222-231`).
3. `reportScheduleDerived` (`packages/workflows/src/work-items.ts:364`).
4. First wave → `beginDispatch`; `null` → "too many child agents" (`packages/workflows/src/work-items.ts:370-378`).
5. `pendingHandles()` and `queuedCount()` are read **before** the driver starts, because the
   driver's first `run` takes the pending batch (`packages/workflows/src/work-items.ts:379-386`).
6. The driver walks `laterWaves`: `run(gate)` → collect → break if `session.cancelled()` →
   `advance(nextWave)`; after the loop one final `run(gate)`; then
   `session.end(describeSummary(outcomes))` (`packages/workflows/src/work-items.ts:388-414`).
7. `agents.adopt(session.anchorId, driver)` (`packages/workflows/src/work-items.ts:415`), then the immediate wave-plan
   result (`packages/workflows/src/work-items.ts:417-423`).

The gate holds each item against its declared `dependencies`: a blocker is any dependency whose
recorded status is not `completed` (`packages/workflows/src/work-items.ts:392-397`). Wave ordering alone would still have
dispatched it — pinned `packages/workflows/tests/component/work-items.test.ts:401-411`.

**Brief construction** (`packages/workflows/src/work-items.ts:281`): `[brief_prefix, item.goal, "<scope sentence> <posture
sentence>"]` joined by blank lines, where the scope sentence names the declared files or says none
were declared, and the posture sentence is "may modify the workspace" vs "read-only: do not modify
the workspace" (`packages/workflows/src/work-items.ts:282-290`).

**Answer text** (`packages/workflows/src/work-items.ts:305-322`): the full wave shape (`wave 1: a, b; wave 2: c`), the
wave-1 `id=agentId` handles, `describeQueued(queued)`, and an instruction not to finish until they
return. **Summary text** (`packages/workflows/src/work-items.ts:325-332`): status → ids tally, e.g. `work item batch
finished — failed: a; blocked: b` (pinned `packages/workflows/tests/component/work-items.test.ts:571-604`).

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
(`packages/workflows/src/run-round.ts:915-919`). `startRounds` (`packages/workflows/src/run-round.ts:939`) is shared with `run_workflow`
(`packages/workflows/src/run-workflow.ts:294`).

Synchronous refusals, before anything is registered:

| Refusal | Line |
|---|---|
| `roundCallBoundsError(call)` — a full re-check of every retained string, `fanout`, and every `repeat` bound at the **programmatic** boundary | `packages/workflows/src/run-round.ts:944-945`, `:654-750` |
| the first round's selector is not `once` ("there is no earlier round for it to consume") | `packages/workflows/src/run-round.ts:948-954` |
| the first round's `when` guard is empty | `packages/workflows/src/run-round.ts:955-960` |
| `planRound` failed (unresolvable selector, unrenderable brief/title, oversized source) | `packages/workflows/src/run-round.ts:961-965` |
| `beginDispatch` returned `null` | `packages/workflows/src/run-round.ts:969-976` |

`roundCallBoundsError` exists because `run_workflow` and embedders call `startRounds` with **typed
objects**, and "types are not a runtime admission control" (`packages/workflows/src/run-round.ts:646-652`); pinned by
`packages/workflows/tests/component/run-round.test.ts:333-356` and `:358-493`, both asserting `registrations === 0`.

**`planRound`** (`packages/workflows/src/run-round.ts:551`):

1. For a non-`once` selector, refuse when the resolved source has more than
   `WORKFLOW_LIMITS.workItems` members (`packages/workflows/src/run-round.ts:558-567`).
2. `selectItems(over, state)` (`packages/workflows/src/run-round.ts:568`) — `once` yields `[undefined]`, `each` yields the
   (optionally filtered) members, `all` yields the whole array as **one** entry
   (`packages/workflows/src/rounds.ts:124-135`).
3. For each item × each replica in `[0, fanout)`, render the title and brief through `interpolate`,
   re-validate the rendered title with `parseTaskTitle`, refuse a rendered brief over `textChars`,
   and emit a `PlannedUnit` (`packages/workflows/src/run-round.ts:572-604`, `:605-612`). When the item itself parses as a
   work item, the rendered brief becomes the *prefix* of `workItemBrief` (`packages/workflows/src/run-round.ts:583`).
4. If the selector is `each` **and every** selected item parses as a work item, the batch is run
   through `scheduleWorkItems`; the waves become unit waves, and `prereqs` maps each unit key to its
   blockers (`packages/workflows/src/run-round.ts:615-641`). Otherwise the round is one flat wave
   (`packages/workflows/src/run-round.ts:643`). The `.every(...)` check (`packages/workflows/src/run-round.ts:614`) means a round whose selected
   items are a *mix* of well-formed and not-well-formed work items silently takes the flat, unscheduled
   path with no separate note to the model — the same path a round of plain (non-work-item) values
   takes — rather than scheduling only the well-formed subset.

**Answer text** (`describePlan`, `packages/workflows/src/run-round.ts:846-867`): the round shape as an arrow-joined chain,
`id (type, selector×N) → …`, an optional repeat clause naming the repeated round ids and the max pass
count, the running round-1 handles, `describeQueued(queued)`, and an instruction not to finish until
they return. **Summary text** (`describeSummary`, `packages/workflows/src/run-round.ts:885-895`, over the `RoundReport[]`
built by `packages/workflows/src/run-round.ts:96-102`: `{ id, skipped?, leaders, accepted?, rejected? }`): each round renders
as `<id>: N leader(s)[, X accepted / Y rejected]`, or `<id>: skipped (<reason>)` when `skipped` is set,
joined as `rounds finished — <round>; <round>; …`.

**`runRounds`** (the adopted driver, `packages/workflows/src/run-round.ts:1114`):

- `drain(waves, prereqs)` runs the already-registered batch, advances to each wave, and finishes with
  one last `run` — with a gate holding a unit against its work-item prerequisites
  (`packages/workflows/src/run-round.ts:1138-1162`). Any `cancelled` outcome latches `cancelled`
  (`packages/workflows/src/run-round.ts:1152`).
- `finishRound` latches `budgetExhausted` from any `budget_exhausted` outcome, folds the round into
  `state.rounds[round.id]`, logs `workflow.round_folded`, and appends a `RoundReport`
  (`packages/workflows/src/run-round.ts:1164-1197`).
- `runFrom(rounds, pass)` iterates the remaining rounds; each `continue` is a skipped round that also
  emits `workflow.round_skipped` (`packages/workflows/src/run-round.ts:1199-1231`). The four skip-and-report reasons: budget
  exhausted, an empty `when` guard, a `planRound` error, and a round that selected no items
  (`packages/workflows/src/run-round.ts:1200-1226`). Cancellation (`packages/workflows/src/run-round.ts:1201`) is qualitatively different: it is a
  plain `break` with no `reportRoundSkipped` call and no `RoundReport` pushed for that iteration, so it
  is not a fifth member of the skip-and-report list.
- The repeat block: seed `seen` from the initial pass's produced items, then loop —
  `nextRepeat(block, {roundsRun: pass, dryRounds, budgetExhausted})`; on `done` record
  `repeat: skipped (stopped: <reason>)` and break; otherwise run the named rounds again at
  `pass + 1`, admit the new items, and increment `dryRounds` when nothing fresh appeared
  (`packages/workflows/src/run-round.ts:1239-1261`). Beside that synthetic `id: "repeat"` row, a `cancelled` sequence appends
  one more synthetic `RoundReport` with `id: "workflow"` and `skipped: "stopped after cancellation"`
  after the repeat block (or in its place, if there was none) — a report row naming no authored round
  (`packages/workflows/src/run-round.ts:1263-1266`).
- A driver throw is logged `workflow.driver_faulted` and **re-thrown**, but the `finally` still calls
  `session.end(describeSummary(reports))` (`packages/workflows/src/run-round.ts:1267-1280`). The stated reason:
  `agents.adopt` swallows the rejection, so an unsettled baton would block `await_agents` until
  teardown (`packages/workflows/src/run-round.ts:1107-1112`); pinned `packages/workflows/tests/component/run-round.test.ts:1348-1391`.

**`foldRound`** (`packages/workflows/src/run-round.ts:767`): outcomes are grouped by item index recovered from the key; with
an `accept` rule the round's value becomes `{decisions, accepted, rejected}` where each decision
carries `applyAccept`'s `{accepted, tally}` (`packages/workflows/src/run-round.ts:777-789`); without one, results are
concatenated in item order and merged (`packages/workflows/src/run-round.ts:791-792`).

**`mergeResults`** (`packages/workflows/src/run-round.ts:796`): if any result is not a plain object the whole set is
returned as-is (one result unwrapped, several as an array) (`packages/workflows/src/run-round.ts:800-803`); otherwise keys
are unioned, array-valued keys are flattened, a key present in exactly one object keeps its scalar,
and a key present in several becomes an array (`packages/workflows/src/run-round.ts:804-813`). Pinned:
`packages/workflows/tests/component/run-round.test.ts:979-1023` — `shared=[1,3] only=2`.

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

**`producedItems`** (`packages/workflows/src/run-round.ts:824`): every array-valued field of every round in the block
contributes, and an entry carrying none of the `dedupe_by` fields is ignored
(`packages/workflows/src/run-round.ts:828-843`).

### 4.9 `run_workflow`

`buildRunWorkflowHandler.handle` (`packages/workflows/src/run-workflow.ts:239`): parse (`:240`) → resolve the name against
the loaded catalogue (`:243-250`) → if `explain`, return `explainWorkflow(workflow)` and run nothing
(`:251`) → `toRoundCall` compile (`:253`) → **fail closed** when there is no `elicit` or no `clock`
(`:255-260`) → a `workflow_review` elicitation whose accepted `decision` must be `"run"`, with
`onNoResponse` mapping to `"cancel"` (`:261-290`) → `startRounds` (`:294`) → an answer carrying the
plan text plus the document's synthesis instruction (`:296-301`).

`toRoundCall` (`packages/workflows/src/run-workflow.ts:91`) refuses a document with 0 or > `rounds` rounds, over-large
declared args, an over-long synthesis, and any declared arg the call did not supply
(`packages/workflows/src/run-workflow.ts:95-120`). `explainWorkflow` (`packages/workflows/src/run-workflow.ts:144`) states fixed leader counts and
says an `each` round's count "scales with what the earlier rounds return" rather than inventing a
number (`packages/workflows/src/run-workflow.ts:169-176`, reason at `:140-143`).

The elicit half is the sibling document **elicitation-and-user-interaction**; the workflow-document
format and the catalogue that fills `ctx.workflowDefs` are **workflows-documents-and-service**.

### 4.10 Argument parsing (all four tools)

| Tool | Parser | Notable rules |
|---|---|---|
| `run_leader` | `parseLeaderSpec` (`packages/workflows/src/capability.ts:379`) | non-object → error; `prompt` required non-empty ≤ `textChars`; `title` ≤ `TASK_TITLE_MAX*2` then re-validated by `parseTaskTitle` — **no fallback to the prompt** (`packages/workflows/src/tool.ts:17-21`); `profile` non-empty ≤ `identifierChars`; `expect_schema` accepted as any non-null object |
| `run_work_items` | `parseWorkItemsCall` (`packages/workflows/src/work-items.ts:208`) → `toWorkItem` (`:170`) | every item is fully validated; the *rendered* brief is checked against `textChars` after the prefix is applied (`packages/workflows/src/work-items.ts:261-270`) |
| `run_round` | `parseRoundCall` (`packages/workflows/src/run-round.ts:470`) → `parseRound` (`:265`), `parseRepeat` (`:371`), `parseArgs` (`:438`) | round ids must be unique within the call (`packages/workflows/src/run-round.ts:488-490`); `repeat.rounds` must name rounds declared in the same call (`packages/workflows/src/run-round.ts:379-390`) |
| `run_workflow` | `parseCall` (`packages/workflows/src/run-workflow.ts:180`) | `args` must be a non-array object; property names and string values bounded |

Every parse failure becomes a **non-terminal** `{kind:"result", progress:false}` prefixed
`Tool '<name>' result: …` (`packages/workflows/src/capability.ts:368-374`, `packages/workflows/src/work-items.ts:429-435`,
`packages/workflows/src/run-round.ts:1284-1290`, `packages/workflows/src/run-workflow.ts:307-312`) — the manager is told what was wrong and keeps
its turn.

### 4.11 The ledger (`createWorkflowLedger` in `packages/workflows/src/ledger.ts`)

Three counters: `spent`, `reserved`, and `total`. `remaining() = total === null ? Infinity : max(0,
total - spent - reserved)`.

- `add(usage)` charges `sumOutputTokens(usage)` clamped to `remaining()` on a bounded ledger
  (`createWorkflowLedger` and `sumOutputTokens` in `packages/workflows/src/ledger.ts`).
- `reserveOutput(n)` (the `OutputTokenBudget` port) grants `min(n, remaining())`, and `settle(used)`
  converts `min(amount, used)` into spend exactly once (`directReservation` inside
  `createWorkflowLedger`).
- `reserve(maxConcurrent)` — the leader-level claim — takes
  `min(headroom, max(1, ceil(headroom / max(1,maxConcurrent))))` (`packages/workflows/src/ledger.ts`,
  `createWorkflowLedger`). The manager has an independent primary-session budget and consumes no
  share. Each leader reservation is itself a nested
  budget: `reserveOutput` inside it draws down `amount - childSpent - childReserved`,
  `reconcile(usage)` charges any gap the model calls did not settle, and `release()` returns the
  *unused* part `amount - childSpent`. A `released` reservation refuses further inner claims and
  further reconciliation (the bounded `reserve` branch in `createWorkflowLedger`).
- Unbounded (`total === null`): `reserve` returns a zero-cost placeholder whose `remaining()` is
  `Infinity` but which still accumulates `childSpent` and folds it into `spent`
  (the unbounded `reserve` branch in `createWorkflowLedger`).

The point of `reserve` over a bare `remaining()` check is that concurrent leaders would otherwise all
read the same pre-spend snapshot. Reservation occurs synchronously after FIFO semaphore admission and
before model dispatch, so the admitted set remains atomic while queued leaders preserve headroom for
later use. This is pinned arithmetically by `packages/workflows/tests/unit/ledger.test.ts` (`many
concurrent reservations under a tight budget can never collectively exceed it`) and end-to-end by
`packages/workflows/tests/component/run-leader.test.ts` (`several admitted run_leader calls under a
tight budget cannot collectively overrun it`).

### 4.12 Diagnostics vocabulary

All records go through the `Logger` port carried on `ctx.deps.logger`, normalized once by
`workflowLogger` (`packages/workflows/src/log.ts:29-31`); nothing constructs a logger (`packages/workflows/src/log.ts:5-10`).

| `event` | Level | Emitted at |
|---|---|---|
| `workflow.capability_inactive` | warn / debug | `packages/workflows/src/capability.ts:144`, `:179`, `:185` |
| `workflow.budget_exhausted` | warn | `packages/workflows/src/capability.ts:264`, `packages/workflows/src/dispatch.ts:708` |
| `workflow.leader_started` | debug (guarded by `levelEnabled`) | `packages/workflows/src/run-leader.ts:77-93` |
| `workflow.leader_settled` | info / warn | `packages/workflows/src/dispatch.ts:618-629` |
| `workflow.leader_faulted` | error (carries `stack`, `cause`) | `packages/workflows/src/capability.ts:323`, `packages/workflows/src/run-leader.ts:117`, `packages/workflows/src/dispatch.ts:776` |
| `workflow.trace_sink_failed` | error | `packages/workflows/src/dispatch.ts:787-795` |
| `workflow.dispatch_begun` / `_refused` / `_halted` | info / warn / warn | `packages/workflows/src/dispatch.ts:219`, `:207`, `:377` |
| `workflow.wave_advanced` | debug | `packages/workflows/src/dispatch.ts:395` |
| `workflow.capacity_wait` / `_stalled` | debug (sampled) / info (once) | `packages/workflows/src/dispatch.ts:577`, `:584` |
| `workflow.schedule_derived` / `_refused` | debug / warn | `packages/workflows/src/schedule-log.ts:32`, `:54` |
| `workflow.round_planned` / `_skipped` / `_folded` | info / warn / debug | `packages/workflows/src/run-round.ts:1020`, `:1045`, `:1078` |
| `workflow.driver_faulted` | error | `packages/workflows/src/run-round.ts:1268` |

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
child settles `stopped`, not `failed` — is at `packages/workflows/src/capability.ts:315-321` and
`packages/workflows/src/dispatch.ts:685-691`, pinned by
`packages/workflows/tests/component/work-items.test.ts:482-500`.

**INV-W6.** Only an **entry** agent carrying the `workflow` grant is contributed the spawn tools;
that manager gets no workflow `outputBudget`, while every other agent in its primary run gets the
workflow-child ledger and no tools. Production: `createWorkflowsCapability` in
`packages/workflows/src/capability.ts`. Test: `packages/workflows/tests/component/capability.test.ts`
(`keeps the manager on its session budget while carrying the leader budget to descendants`).

**INV-W7.** Every contributed spawn tool's `ToolEffect` is `spawn_run`, never `control`. Production:
`packages/workflows/src/capability.ts:96-98`. Test:
`packages/workflows/tests/component/capability.test.ts:43-47`.

**INV-W8.** A run publishing no supervision registry yields `forRun === null`; there is no
synchronous fallback path. Production: `packages/workflows/src/capability.ts:141-153`. Test:
`packages/workflows/tests/component/capability.test.ts:19-27`.

**INV-W9.** Every spawn tool answers with `kind: "result"`, never `deferred`. Production:
`packages/workflows/src/capability.ts:355-362`, `packages/workflows/src/work-items.ts:417-423`, `packages/workflows/src/run-round.ts:920-924`.
Test: `packages/workflows/tests/component/run-leader.test.ts:237-240` (asserts the verdict kind and
the `ag_` handle in the text).

**INV-W10.** Registry refusal precedes ledger reservation, so a leader the registry cannot admit
claims no headroom. Production: `buildRunLeaderHandler` in `packages/workflows/src/capability.ts`.
Test: `packages/workflows/tests/component/capability.test.ts` (`refuses to spawn when the registry has
no room for another live child`, with `ledger.remaining()` unchanged).

**INV-W11.** The sum of live reservations plus settled spend can never exceed a bounded ledger's
`total`, whatever the batch size. Production: `packages/workflows/src/ledger.ts:166-172`, `:74-75`.
Test: `packages/workflows/tests/unit/ledger.test.ts:105-121`;
`packages/workflows/tests/component/run-leader.test.ts:348-390`.

**INV-W12.** `beginDispatch` returns `null` when the registry admits none of the first batch, so a
tool refuses outright rather than starting what it cannot finish. Production:
`packages/workflows/src/dispatch.ts:202-217`. Test:
`packages/workflows/tests/component/dispatch.test.ts:98-112`;
`packages/workflows/tests/component/work-items.test.ts:306-310`;
`packages/workflows/tests/component/run-round.test.ts:600-604`.

**INV-W13.** A batch's outcome count always equals its unit count, however narrow the registry —
queued units are registered as slots free, never dropped. Production:
`packages/workflows/src/dispatch.ts:300-310`, `:328-354`, `:355-362`. Test:
`packages/workflows/tests/component/dispatch.test.ts:164-174`;
`packages/workflows/tests/component/run-round.test.ts:1198-1206`.

**INV-W14 (the baton).** The live-child count reaches zero only at the very end of a dispatch, across
wave *and* round boundaries. Production: `packages/workflows/src/dispatch.ts:266-274`, `:388-393`,
`:406-409`. Test: `packages/workflows/tests/component/work-items.test.ts:538-568` (asserts the exact
register/settle interleaving); `packages/workflows/tests/component/run-round.test.ts:1134-1171`;
`:1208-1217`; `:1314-1346`.

**INV-W15.** The baton is released only when the next batch actually got a handle. Production:
`packages/workflows/src/dispatch.ts:388-391`. Test:
`packages/workflows/tests/component/run-round.test.ts:1314-1346` (a round the registry cannot admit
still leaves the live count above zero, and the summary still lands).

**INV-W16.** A cancellation stops the dispatch scheduling anything further; queued units are reported
`cancelled` rather than started. Production: `packages/workflows/src/dispatch.ts:302` (`stopped()` in
`pump`), `:356`, `:372-383`. Test:
`packages/workflows/tests/component/run-round.test.ts:1219-1236`;
`packages/workflows/tests/component/dispatch.test.ts:114-129`;
`packages/workflows/tests/component/work-items.test.ts:390-400`.

**INV-W17.** A cancelled leader stops an automatic repeat block instead of spawning a replacement.
Production: `packages/workflows/src/run-round.ts:1152`, `:1201`, `:1257`. Test:
`packages/workflows/tests/component/run-round.test.ts:1107-1131` (exactly one call, one
registration).

**INV-W18.** One post-admission ledger refusal latches the whole batch: later units acquire and
release their FIFO permits but are refused from the remembered flag without asking the ledger again.
Production: `runOne` in `packages/workflows/src/dispatch.ts`. Test:
`packages/workflows/tests/component/work-items.test.ts` (`a sibling in the same wave is refused off
the remembered flag, not by asking again`, exactly one `reserve` call).

**INV-W19.** A work item whose dependency did not **complete** is not dispatched at all — wave
ordering alone is not the guarantee. Production: `packages/workflows/src/work-items.ts:392-397`
(work-items path), `packages/workflows/src/run-round.ts:1144-1146` (round path). Test:
`packages/workflows/tests/component/work-items.test.ts:401-411`;
`packages/workflows/tests/component/run-round.test.ts:1286-1312`.

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
`packages/workflows/src/work-items.ts:357-363`. Test:
`packages/workflows/tests/component/work-items.test.ts:222-231` (`registrations === 0`).

**INV-W24.** The first round of a sequence must be `once`. Production:
`packages/workflows/src/run-round.ts:948-954`. Test:
`packages/workflows/tests/component/run-round.test.ts:584-590`.

**INV-W25.** A round id must match `/^[A-Za-z0-9._-]+$/u`, because the unit key encodes the item
index in brackets. Production: `packages/workflows/src/run-round.ts:114`, `:269-278`, key built at
`:593`, index recovered at `:774`. Test:
`packages/workflows/tests/component/run-round.test.ts:1393-1402`.

**INV-W26.** `startRounds` re-validates every bound at the programmatic boundary, before planning or
registry admission. Production: `packages/workflows/src/run-round.ts:944-945`, `:654-750`. Test:
`packages/workflows/tests/component/run-round.test.ts:333-356`, `:358-493` (each case asserts
`registrations === 0`).

**INV-W27.** An unresolvable `{{…}}` placeholder is an error, never a blank; the first failure is
reported and the text is not half-substituted. Production:
`packages/workflows/src/interpolate.ts:51-60`. Test:
`packages/workflows/tests/unit/interpolate.test.ts:29-49`.

**INV-W28.** A replica that failed or answered off-schema stays in the accept denominator, tallied as
`(unavailable)`. Production: `packages/workflows/src/rounds.ts:156-160`, `:58`. Test:
`packages/workflows/tests/unit/rounds.test.ts:149-155`.

**INV-W29.** `fanout` is honoured for a work-item round rather than collapsed to one leader per item.
Production: `packages/workflows/src/run-round.ts:590,593` (replica suffix), `:615-641` (`unitsOf`
returns every replica of an item). Test:
`packages/workflows/tests/component/run-round.test.ts:1256-1284` (2 items × 3 replicas = 6 leaders,
`2 accepted / 0 rejected`).

**INV-W30.** Repeat deduplication is against everything seen so far, not against what survived
verification. Production: `packages/workflows/src/rounds.ts:199-213` (`next` seeded from `seen`),
driver at `packages/workflows/src/run-round.ts:1242-1260`. Test:
`packages/workflows/tests/unit/rounds.test.ts:196-208`.

**INV-W31.** `repeat.max_rounds` has no default and is required; `until` genuinely selects the
stopping rule. Production: `packages/workflows/src/run-round.ts:223` (schema `required`), `:403-414`
(parse), `packages/workflows/src/rounds.ts:235-240`. Test:
`packages/workflows/tests/unit/rounds.test.ts:328-356`.

**INV-W32.** A driver fault still settles the held handle and reports what ran. Production:
`packages/workflows/src/run-round.ts:1279` (`finally { session.end(...) }`). Test:
`packages/workflows/tests/component/run-round.test.ts:1348-1391`.

**INV-W33.** `runOne` never rejects: a thrown leader or a throwing trace sink settles that unit
`failed` and releases its permit and reservation. Production:
`packages/workflows/src/dispatch.ts:774-803`. Test:
`packages/workflows/tests/component/work-items.test.ts:413-427`;
`packages/workflows/tests/component/observability.test.ts:440-456`.

**INV-W34.** The `workflows` settings block is `strict`, `lastWins`, not plugin-contributable, and
exposes no per-run request param. Production: `packages/workflows/src/settings.ts:102`, `:120-125`.
Test: `packages/workflows/tests/unit/settings.test.ts:12-28` pins the schema's bounds and defaults;
**the absence of a request param is unpinned in this package** (no test asserts
`workflowsSettingsSpec.requestParams === undefined`).

**INV-W35.** `managerLiveChildrenFloor` never exceeds `AGENTS_MAX_LIVE_CHILDREN`, equals the
supervision default at the default concurrency, and floors nonsensical input to the value for 1.
Production: `packages/workflows/src/settings.ts:71-74`. Test:
`packages/workflows/tests/unit/settings.test.ts:30-51`. The host applies it as a *floor*, keeping a
deliberately higher operator value: `packages/kernel/src/workflows/workflows-service.ts:764-775`.

**INV-W36.** A `run_leader` title is required and never derived from the prompt. Production:
`packages/workflows/src/capability.ts:394-398`. Test:
`packages/workflows/tests/component/run-leader.test.ts:551`, `:568`.

**INV-W37.** A workflow trace projector rejects a detail that fails its guard by throwing rather than
emitting a partial event. Production: `packages/workflows/src/trace-events.ts:193-195`, used at
`:227-229`, `:249-251`, `:264-266`. Test: `packages/workflows/tests/unit/trace-events.test.ts:30ff`.

**INV-W38 (unpinned).** `describeQueued` is the only sentence telling the manager that units missing
from the handle list are waiting rather than skipped (`packages/workflows/src/dispatch.ts:417-422`,
`:423-426`). Its *text* is pinned (`packages/workflows/tests/component/dispatch.test.ts:206-214`) and its presence in
the `run_work_items` answer is pinned
(`packages/workflows/tests/component/work-items.test.ts:369-377`), but nothing pins its presence in the `run_round`
answer built at `packages/workflows/src/run-round.ts:863`.

## 6. Failure modes and degradation

| Situation | Handling | Cite |
|---|---|---|
| malformed tool arguments | non-terminal textual result naming the field; nothing registered, nothing spent | `packages/workflows/src/capability.ts:218-220`, `packages/workflows/src/work-items.ts:355`, `packages/workflows/src/run-round.ts:911`, `packages/workflows/src/run-workflow.ts:241` |
| tree budget exhausted at `run_leader` | after semaphore admission: `warn`, `onBudgetExhausted`, registered handle settles `failed`, no model call | `buildRunLeaderHandler` in `packages/workflows/src/capability.ts`; test `packages/workflows/tests/component/capability.test.ts` (`settles an admitted leader failed when the tree budget is exhausted`) |
| tree budget exhausted mid-batch | after semaphore admission: latch; this unit and every later one skipped `budget_exhausted`; later rounds reported `skipped (the token budget was exhausted)` | `runOne` in `packages/workflows/src/dispatch.ts`, `runRounds` in `packages/workflows/src/run-round.ts` |
| registry sealed / at ceiling on the first batch | tool refuses outright with "too many child agents are already running" | `packages/workflows/src/dispatch.ts:206-217`, `packages/workflows/src/work-items.ts:371-378`, `packages/workflows/src/run-round.ts:969-976` |
| registry full mid-batch, foreign children live | poll with exponential backoff (25 ms → 500 ms), **no deadline**; one `info` stall record after 5 s | `packages/workflows/src/dispatch.ts:540`, `:565-584` |
| registry full mid-batch, only our own batons live | remaining units reported `unregistered` rather than waiting forever | `packages/workflows/src/dispatch.ts:539`, `:355-361`; test `packages/workflows/tests/component/dispatch.test.ts:151-162` |
| leader `executeRun` throws | caught in `runLeader`; `status:"error"`, `code:"leader_run_failed"`; the stack exists only in the log | `packages/workflows/src/run-leader.ts:115-127` |
| leader task throws outside `runLeader` | `workflow.leader_faulted`, a `workflow_run_failed` edge, child settles `failed` | `packages/workflows/src/capability.ts:314-336`, `packages/workflows/src/dispatch.ts:774-798` |
| trace sink throws while recording the failure edge | `workflow.trace_sink_failed` at `error`; the durable record is knowingly missing that edge; the unit still settles | `packages/workflows/src/dispatch.ts:787-795` |
| a round cannot be planned | `workflow.round_skipped` + one clause of the batch summary; the sequence continues | `packages/workflows/src/run-round.ts:1214-1219` |
| a round's `when` guard is empty | skipped and named (`'<path>' is empty`) | `packages/workflows/src/run-round.ts:1207-1211`; first-round case is a hard refusal `packages/workflows/src/run-round.ts:955-960` |
| a round selected no items | skipped and named (`it selected no items`) | `packages/workflows/src/run-round.ts:1221-1225` |
| the round sequence stops on cancellation | one final synthetic `RoundReport` (`id: "workflow"`, `skipped: "stopped after cancellation"`) is appended, naming no authored round | `packages/workflows/src/run-round.ts:1263-1266` |
| a leader answers prose where a schema was expected | `mergeResults` degrades to an array/scalar; `workflow.round_folded` reports `result_shape` and `non_object_replicas` so the degradation is visible | `packages/workflows/src/run-round.ts:797-802`, `:1077-1092`; test `packages/workflows/tests/component/observability.test.ts:519-533` |
| a replica died | counted in the accept denominator as `(unavailable)` | `packages/workflows/src/rounds.ts:156-160` |
| `run_workflow` with no elicit channel or no clock | fails closed, suggesting `explain: true` | `packages/workflows/src/run-workflow.ts:255-260` |
| `run_workflow` review declined or unanswered | "was not started", no leader spawned | `packages/workflows/src/run-workflow.ts:286-293` |
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
| `@clarvis/kernel` — workflows service | constructs semaphore, ledger and the capability; applies `managerLiveChildrenFloor` | `packages/kernel/src/workflows/workflows-service.ts:246-247`, `:483`, `:764` |
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
leader profiles by the workflows service (`packages/kernel/src/workflows/workflows-service.ts:777-778`
— function docstring "Remove the `workflow` grant from every profile so a leader can never become a
[manager]"). The construction of `WorkflowCtx` itself belongs to the sibling document
**workflows-documents-and-service**.

## 8. Open questions

- **`ExecuteRunDeps.capabilities` vs `ExecuteRunArgs.capabilities` for leaders.** `runLeader` passes
  the budget-only capability on the per-call `capabilities` array (`packages/workflows/src/run-leader.ts:99`) while handing
  `ctx.deps` through unchanged. Whether the host's `deps.capabilities` are *also* active for a leader
  run is decided in the loop's composition, which is outside this document's scope; the debug
  record at `packages/workflows/src/run-leader.ts:87-89` implies they are ("the capabilities named here are the whole
  surface it gets"), but that is prose, not a verified mechanism.
- **Why background is the only mode.** `packages/workflows/src/capability.ts:10-14` asserts it and gives a rationale, and
  `packages/workflows/tests/component/run-leader.test.ts:237-238` fails with a message about a deferred verdict — but no
  test in this package measures the manager's latency, so the claim that a deferred verdict is joined
  by `runDispatch`'s `finally` (`packages/workflows/src/capability.ts:195-197`) is unverified from this package's code. The
  loop-side dispatch belongs to another document.
- **`WorkflowCtx.workflowDefs` provenance.** The type says the host supplies loaded definitions and
  "this package never reads a root itself" (`packages/workflows/src/types.ts:102-108`); the loader in `artifact.ts` and the
  kernel service that calls it belong to **workflows-documents-and-service**.
- **`ExecuteRunOutcome.response.status` domain.** `LeaderStatus` (`packages/workflows/src/types.ts:33-34`) enumerates six
  statuses and `runLeader` passes `response.status` through verbatim (`packages/workflows/src/run-leader.ts:114`); the loop's
  `RunResponse` is outside this document's scope, so whether the two sets coincide is unconfirmed.
- **`elicitWithClockPause` semantics.** Used at `packages/workflows/src/run-workflow.ts:261`; its clock-pause behaviour is
  the elicitation document's.
- **`AgentRegistryPort.liveCount()` counting rules.** `waitForCapacity` subtracts `oursLive` from it
  (`packages/workflows/src/dispatch.ts:538`) and treats the remainder as foreign. What exactly the registry counts as live
  (adopted tasks? retained children?) is [foundations/supervision.md](../foundations/supervision.md)'s.
- **Unpinned invariants.** (a) `workflowsSettingsSpec` exposing no `requestParams` is
  asserted nowhere in this package (§5 INV-W34). (b) `describeQueued`'s appearance in the `run_round`
  plan text (`packages/workflows/src/run-round.ts:863`) is unasserted (§5 INV-W38). (c) `placeholders`
  (`packages/workflows/src/interpolate.ts:64`) has a unit test (`packages/workflows/tests/unit/interpolate.test.ts:54`) but no `src/` caller
  inside this document's scope — its consumer is presumably `artifact.ts`'s load-time validation, which
  is not covered here.
- **`WorkflowLedger.reserve` sizing rationale.** Division by `maxConcurrent` and `ceil` are
  documented by `WorkflowLedger.reserve` and pinned numerically in
  `packages/workflows/tests/unit/ledger.test.ts`; the separate manager budget is a topology rule,
  not another provisional share in this arithmetic.
- **`MANAGER_REGISTRY_HEADROOM = 4`.** `packages/workflows/src/settings.ts:41-56` enumerates three slot consumers and says
  "four covers the shapes a manager actually produces"; no test derives 4 from those three, so the
  constant is a judgement that cannot be verified mechanically.
- **`DispatchUnit.replicaCount`** is recorded into the start trace (`packages/workflows/src/dispatch.ts:729`) and projected
  (`packages/workflows/src/trace-events.ts:242`), but nothing in this package reads it back; its consumer would be a UI.
