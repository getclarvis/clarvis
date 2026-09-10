# The planning capability: sessions, review gate, tools and retention policy

> Implemented at `packages/plan/src/capability/**`, `packages/plan/src/tools.ts`,
> `packages/plan/src/settings.ts`, `packages/kernel/src/plans/**` and
> `packages/kernel/src/runs/plan-ref.ts`. Every claim below is anchored to a file and a named symbol or test. Open
> questions are collected in the final section.

---

## 1. Purpose

`@clarvis/plan/capability` packages file-backed execution planning as a loop **capability** — an
object satisfying `Capability` from `@clarvis/capability` that a host registers, rather than
something the engine knows about. `createPlansCapability(options)` returns that object
(`packages/plan/src/capability/index.ts`), and its entry file states the constraint that shapes
the whole module: "This entry must never import `@clarvis/loop`"
(`packages/plan/src/capability/index.ts`). The package's manifest carries only
`@clarvis/capability`, `@clarvis/paths`, `yaml` and `zod`
(`packages/plan/package.json` dependencies block), and every module under `src/capability/` imports
from `@clarvis/capability` or from sibling `../*.ts` files only.

What the capability contributes to a run is: five model-facing plan tools, a **review blocker**
(a `ToolHandler` that refuses workspace-changing calls until a human approves a plan), two
**finalize gates** (the review gate and the open-task pending gate), a **compaction anchor** and a
`beforeIteration` hook that republishes the plan as canonical context, and a **task port** that the
delegation capability consults — all assembled by `buildPlansOrchestration`
(`packages/plan/src/capability/orchestration.ts`). It also owns the run's `PlanSession`
(`packages/plan/src/capability/session.ts`), the run-lifetime object that mediates every read and
compare-and-swap write against the plan store.

The second half of the story is policy ownership. The `plans` block is a `CapabilitySettingsSpec`
shipped by the package itself (`packages/plan/src/settings.ts`) and registered by the kernel at
module load (`packages/kernel/src/config/capability-registry.ts`), so the engine can validate a
`plans` key it has never heard of. `mode` (`off`/`on`/`review`) and `retention` (`keep`/`discard`)
are settings a user authors; there is no agent grant that turns review off. The default retention is
`keep` (`packages/plan/src/schemas.ts`, `packages/plan/src/settings.ts`) and a `discard` plan is
deleted only in `onRunEnd`, only on a `completed` record
(`packages/plan/src/capability/index.ts`).

That claim is about grants, not about every path into `mode`: a trusted plugin can still declare
`capabilityRunPolicies.plans.skills[skill]` (`packages/capability/src/capability-run-policies.ts`)
for a skill it packages, and when a run is entered through that skill *and* the operator has selected
that same plugin as the Plans provider, the kernel folds the declared mode over the settings block's
`mode` for that one run — `skillPlansMode` (`packages/kernel/src/file-kernel.ts`,
`packages/kernel/src/plugins/plugin-contributions.ts`) is read in the settings assembler
(`packages/kernel/src/runs/settings-assembler.ts`) and only ever loses to an explicit
`plans` param on the run request itself, never to the settings block. This bypasses `pluginContributable:
false` on `plansSettingsSpec` (`packages/plan/src/settings.ts`) entirely, because it never goes
through the settings merge that flag governs. The mechanism, its parsing and its precedence belong to
[`../hosts/plugins.md`](../hosts/plugins.md) and [`../hosts/kernel-runs.md`](../hosts/kernel-runs.md),
not to this document.

---

## 2. Surface

The model-facing contract names optional tools conditionally, without hardcoding a second catalog
of read tools. A review gate never grants tools that another boundary withholds. Mutation guidance
uses the current revision/digests, serializes dependent writes and requests a re-read after conflict.
Delegation and a returned child result do not close a task: inspect the outcome before recording
`done` or a genuine `abandoned`. `PENDING_TASKS_NOTE` refuses invented completion and warns against
repeated-finalization bypasses; it remains a finalize-only note, not a mid-run completion request.
Production: `packages/plan/src/tools.ts` and `packages/plan/src/capability/messages.ts`. Test:
`packages/plan/tests/unit/plan-messages.test.ts` and the plan orchestration component suites.
See [`model-instructions.md`](../cross-cutting/model-instructions.md).

### 2.1 Package entrypoints

| Export path | File | Purpose |
| --- | --- | --- |
| `@clarvis/plan/capability` | `packages/plan/src/capability/index.ts` | `createPlansCapability`, `PLAN_PORT`, `PlanSession`, `planProjection`, `PLAN_TOOL_WIRE_NAMES` |
| `@clarvis/plan/settings` | `packages/plan/src/settings.ts` | `plansSettingsSpec`, `PLANS_DEFAULTS`, `plansParamSchema`, `PLANS_SETTINGS_FIELDS`, `PLANS_REQUEST_PARAMS`, `PlansSettingsBlock` |
| `@clarvis/plan` (root) | `packages/plan/src/index.ts` | tool-name constants + `planToolDefinitions` + `revisePlanInputSchema`, `PlanService`, `PLANS_CAPABILITY_NAME`, `PlanRef` |

The `"./capability"` and `"./settings"` conditions are declared in `packages/plan/package.json`.

### 2.2 `createPlansCapability`

```ts
export function createPlansCapability(options: PlansCapabilityOptions): Capability
```
(`packages/plan/src/capability/index.ts`)

`PlansCapabilityOptions` (`packages/plan/src/capability/index.ts`):

| Field | Type | Meaning |
| --- | --- | --- |
| `factory` | `PlanFactory` | settings-sensitive, owner-scoped store resolver (`packages/plan/src/provider.ts`) |
| `defaultPendingTaskNudges` | `number` | fallback nudge budget when the request's `plans` block sets none |
| `defaultElicitWaitMs` | `number` | fallback human-wait bound for the review gate |
| `logger?` | `Logger` | resolved to `NOOP_LOGGER` once per capability |

`PlanFactory`/`createPlanFactory` (`packages/plan/src/provider.ts`) memoize one store resolution per
owner and select the provider (Markdown, a direct executable, or a plugin-hosted one). This
mechanism is pinned by `packages/plan/tests/component/provider.test.ts`, an in-scope file otherwise
undiscussed here: `storeFor` memoizes per owner and a second call for the same owner returns the
same store; `evictOwner` drops one owner's resolution without touching a peer's; a direct executable provider runs from the workspace with raw argv; a
plugin provider runs from the plugin's own root and cannot select itself; a plugin
revision change rebuilds the session adapter while `key` (the provider identity) stays stable; and an unavailable executable provider throws `PlanProviderUnavailableError` rather
than silently falling back to Markdown. The document format and digest machinery
`PlanFactory` sits beside remain delegated to **plan-document-and-store** (§7.4).

The returned `Capability` declares:

| Member | Value | File |
| --- | --- | --- |
| `name` | `PLANS_CAPABILITY_NAME` = `"plans"` | `packages/plan/src/capability/index.ts`, `packages/plan/src/schemas.ts` |
| `reservedWireNames` | the five tool wire names, derived from `buildPlanRuntimeTools(false)` | `packages/plan/src/capability/index.ts` |
| `toolEffects` | `read` for `read_plan`/`list_plans`, `mutate` for the other three | `packages/plan/src/capability/index.ts` |
| `requiresUserInput(view)` | `true` iff the request's `plans` mode is `"review"` | `packages/plan/src/capability/index.ts` |
| `forRun(ctx)` | `RunCapability \| null` — `null` when mode is `off` | `packages/plan/src/capability/index.ts` |

The `RunCapability` it returns declares `order: -100` (`packages/plan/src/capability/index.ts`), `guardTripCodes:
["plan_review_unreviewed", "plan_review_revision_limit", "pending_tasks_unfinished"]`
(`packages/plan/src/capability/index.ts`), `forAgent` (entry-agent only, `packages/plan/src/capability/index.ts`), `finalizeRun`
(`packages/plan/src/capability/index.ts`), `onRunEnd` (`packages/plan/src/capability/index.ts`), and a one-element `lifecycle` array carrying
`onRunStart` — present **only** when the run continues a plan (`packages/plan/src/capability/index.ts`).

### 2.3 Model-facing tools

The five names live in `packages/plan/src/tools.ts`; the JSON-Schema definitions are
`planToolDefinitions` (`packages/plan/src/tools.ts`). `buildPlanRuntimeTools(planReview)` adapts
them to `NamespacedTool` with identity wire/mcp/tool names and an empty MCP namespace
(`packages/plan/src/capability/runtime-tools.ts`).

| Wire name | Effect | Advertised input (JSON-Schema) | Runtime validation (zod) |
| --- | --- | --- | --- |
| `create_plan` | `mutate` | `title`, `objective`, `context?`, `tasks[]{title,detail?,exit?}`, `validation[]`, `retention?` — required `title/objective/tasks/validation` (`packages/plan/src/tools.ts`) | `createInputSchema` (`packages/plan/src/capability/runtime-tools.ts`) |
| `read_plan` | `read` | `{ id?: string }` (`packages/plan/src/tools.ts`) | `readInputSchema` (`packages/plan/src/capability/runtime-tools.ts`) |
| `list_plans` | `read` | `cursor?`, `limit?` 1–100, `status?`, `retention?` (`packages/plan/src/tools.ts`) | `listInputSchema` (`packages/plan/src/capability/runtime-tools.ts`) |
| `revise_plan` | `mutate` | CAS triple + `operations[]` (8-member `oneOf`) (`packages/plan/src/tools.ts`) | `revisePlanInputSchema` (`packages/plan/src/tools.ts`) |
| `transition_plan_task` | `mutate` | CAS triple + `transitions[]{task_id,status,result?,error?,reason?,assignee?}` (`packages/plan/src/tools.ts`) | `transitionInputSchema` (`packages/plan/src/capability/runtime-tools.ts`) |

`create_plan`'s description gains `CREATE_PLAN_REVIEW_NOTE` when the run is under review
(`packages/plan/src/capability/runtime-tools.ts`). It is the **only** description that varies with run
configuration. Its TSDoc states the measured incident it exists for: "Two failures were measured
against the same prompt and profile: one model wrote three files before the finalize gate told it a
plan was required, and the other planned first but, not knowing the runtime would present the plan,
asked the human for approval itself with `ask_user` — so the human was asked twice, seconds apart,
about the same plan" (`packages/plan/src/capability/runtime-tools.ts`).

The CAS triple is `expected_revision` (positive int), `expected_digest` (1–256 chars),
`expected_spec_digest` (1–256 chars) (`packages/plan/src/capability/runtime-tools.ts`).

Both batch tools accept a singular form and normalise it:
`revisePlanInputSchema` refuses a payload carrying **both** `operation` and `operations`, or neither
(`packages/plan/src/tools.ts`); `transitionInputSchema` accepts a flat single `task_id`+`status` beside the CAS
fields and folds it into a one-element `transitions` array (`packages/plan/src/capability/runtime-tools.ts`).

### 2.4 Settings and request param

`PLANS_DEFAULTS` (`packages/plan/src/settings.ts`):

```ts
{ mode: "on", retention: "keep", pending_task_nudges: 3 }
```

| Schema | Shape | File |
| --- | --- | --- |
| `plansConfigSchema` (settings.json block) | `.strict()` object: `mode` (default `"on"`), `retention` (default `"keep"`), `pending_task_nudges` (int ≥ 0, default 3), `provider?` | `packages/plan/src/settings.ts` |
| `plansRunConfigSchema` (request-visible subset) | `.strict()` object: `mode` required, `retention?`, `pending_task_nudges?` — **no `provider`** | `packages/plan/src/settings.ts` |
| `plansParamSchema` (the `plans` request param) | `union([plansModeField, plansRunConfigSchema]).optional()` | `packages/plan/src/settings.ts` |

`plansSettingsSpec` (`packages/plan/src/settings.ts`): `key: "plans"`, `merge: "lastWins"`,
`pluginContributable: false`, `requestParams: { plans: plansParamSchema }`.

### 2.5 The task port

`PLAN_PORT` is an alias for the canonical `TASK_TRACKING_PORT` from `@clarvis/capability`
(`packages/plan/src/capability/task-port.ts`, defined at
`packages/capability/src/task-tracking-port.ts`). `PlanDelegationPort` narrows the neutral
`TaskTrackingPort` with planning's own `PlanTaskStatus` vocabulary
(`packages/plan/src/capability/task-port.ts`). Consumption of that port by
`delegate_task` belongs to the **loop-delegation-and-subagents** document.

`getTask`'s declared return type carries `description?: string` and `exit_condition?: string`
fields (`packages/plan/src/capability/task-port.ts`) that do not match the vocabulary used everywhere else in this
document (`detail`/`exit`, e.g. §2.3, §4.8); the concrete implementation just returns the raw
cached task object (`packages/plan/src/capability/delegation-port.ts`), which never populates those two names. Whether
this is dead/vestigial naming or a discrepancy against the `detail`/`exit` fields is not
determinable from the code read (see §8).

### 2.6 Kernel surface

| Symbol | File | Role |
| --- | --- | --- |
| `createPlanningRuntime(options)` | `packages/kernel/src/plans/planning-runtime.ts` | builds `{ capability, planFactory }` from one owner-scoped data plane |
| `createPlansService({ resolve? })` | `packages/kernel/src/plans/plans-service.ts` | adapts the domain `PlanService` to the protocol `PlansService` |
| `planRefFromCapabilityState(state)` | `packages/kernel/src/runs/plan-ref.ts` | validating reader of the `plans` slot in `ExecutionRecord.capability_state` |

`createPlansService` exposes `list`, `read`, `setRetention`, `delete`
(`packages/kernel/src/plans/plans-service.ts`).

Every one of those methods projects the domain `PlanDocument` through `dto()`
(`packages/kernel/src/plans/plans-service.ts`), the only place that happens. Two of its fields are not stored values:
`markdown` is always freshly `renderPlan(plan)`-ed rather than read from disk, and
`approved_spec_revision` is included only when the document actually has one set — both per the
function's own TSDoc (`packages/kernel/src/plans/plans-service.ts`).

---

## 3. Data and formats

### 3.1 `PlanRef` — what the capability files on the run record

`finalizeRun` returns a `PlanRef` and the engine files it under `capability_state["plans"]`
(`packages/plan/src/capability/index.ts`; contract at
`packages/capability/src/contract.ts`). The interface
(`packages/plan/src/schemas.ts`):

```ts
interface PlanRef {
  id: string;
  provider_key: string;
  path?: string;              // display locator; the file path for markdown
  final_revision: number;
  final_spec_revision: number;
  status: "awaiting_approval" | "active" | "completed" | "cancelled" | "failed";
  retention: "discard" | "keep";
}
```

It is built by `PlanSession.ref()` (`packages/plan/src/capability/session.ts`). When the plan disappeared mid-run the
ref is built from the tombstone instead, with `status` falling back through
`missing.document?.status ?? initial?.status ?? "failed"` and `retention` through
`missing.document?.retention ?? initial?.retention ?? this.#retention ?? DEFAULT_PLAN_RETENTION`
(`packages/plan/src/capability/session.ts`).

The kernel re-validates the slot rather than casting: `isPlanRef` type-guards every required field,
constrains `status` and `retention` to their literal sets, and admits `path` only as a string
(`packages/kernel/src/runs/plan-ref.ts`). Its TSDoc states the reason: `capability_state` is
opaque to the engine and the trace store, "so an unchecked cast at this boundary would let a
malformed or absent slot masquerade as a `PlanRef`" (`packages/kernel/src/runs/plan-ref.ts`).

### 3.2 `MissingPlanState`

`MissingPlanState` is the tombstone of a plan whose backing record disappeared
(`packages/plan/src/capability/session.ts`): `{ id, path?, revision, specRevision, document? }`.

The session publishes no other view of its own state — there is no snapshot accessor. Two focused
readers reach the tombstone: `missing()` returns the durable one
(`packages/plan/src/capability/session.ts`), and `takeRemoval()` consumes the one-shot removal
projection the runtime turns into `plan_removed` (`packages/plan/src/capability/session.ts`),
leaving `missing()` intact.

### 3.3 Capability events

Five `CapabilityEvent` kinds are emitted, always wrapped in `projected(...)` so they carry a wire
projection (`packages/capability/src/contract.ts`; unwrapped events "stay internal").

| Kind | Emitted at | Detail |
| --- | --- | --- |
| `plan_created` | `packages/plan/src/capability/orchestration.ts` (on a `create_plan` call) | `planProjection(document)` |
| `plan_updated` | `packages/plan/src/capability/orchestration.ts`; also `packages/plan/src/capability/index.ts` (`change: "recovery"`), `packages/plan/src/capability/index.ts` (`change: "status"`), `packages/plan/src/capability/orchestration.ts` (task-port writes) | `{ change, ...planProjection(document) }` |
| `plan_removed` | `packages/plan/src/capability/index.ts` (run start), `packages/plan/src/capability/index.ts` (retention discard), `packages/plan/src/capability/orchestration.ts` (a tool call discovered the removal) | `removedPlanProjection(missing)` or a flat id/path/revision/spec_revision object |
| `plan_review_requested` | `packages/plan/src/capability/orchestration.ts` (`presentPlanReviewGate`, `plan_review_requested` branch) | `planProjection(presented)` |
| `plan_review_resolved` | `packages/plan/src/capability/orchestration.ts` (`presentPlanReviewGate`, approval, change-request, and cancellation branches) | `{ outcome: "approved" \| "changes_requested" \| "cancelled", ...planProjection }` |

`planProjection` (`packages/plan/src/capability/orchestration.ts`) carries `id`, optional `path`, `title`, `status`,
`retention`, `revision`, `spec_revision`, `objective`, `context`, `validation`, and tasks reduced to
`id`/`title`/`status` plus only the present optional fields.

The kernel's `capabilityEventToProto` validates the detail against a **closed** projection schema
(`packages/kernel/src/runs/map-events.ts`) that deliberately `.strip()`s the extra fields:
"Internal plan events also carry objective/context fields. Stripping them here avoids either widening
the closed protocol DTO or rejecting an otherwise valid plan update"
(`packages/kernel/src/runs/map-events.ts`). The protocol `PlanProjection` therefore has no `objective`/`context`/
`validation` (`packages/protocol/src/runs.ts`).

All five map to `live("capability", ["capability_channel"])` in the kernel's event policy
(`packages/kernel/src/runs/event-policy.ts`) — i.e. none is persisted to the engine trace.

`PlanUpdateChange` has four members — `content`, `task`, `status`, `recovery`
(`packages/protocol/src/runs.ts`, mirrored at `packages/kernel/src/runs/map-events.ts`),
exactly the set this capability produces. It carried three more — `approval`, `retention`,
`external_edit` — that nothing ever emitted; they have been removed from both.

### 3.4 Trace entries

The capability writes four **contributed** trace kinds through the agent build context's
`TracePort`:

| Kind | Detail | Site |
| --- | --- | --- |
| `tool_call` | `{ agent: "lead", iteration_ref, started_at, ended_at, name, arguments, result, error, call_id? }` | `packages/plan/src/capability/orchestration.ts` |
| `plan_review` | `{ outcome, revision_index }` — `PlanReviewDetail` | `packages/plan/src/capability/orchestration.ts`; type at `packages/capability/src/trace-kinds.ts` |
| `task_nudge` | `{ outcome, pending_task_ids, nudge_index, progressed }` — `TaskNudgeDetail` | `packages/plan/src/capability/orchestration.ts`; type at `packages/capability/src/trace-kinds.ts` |
| `terminate` | `{ reason }` — one of `plan_review_revision_limit`, `plan_review_cancelled`, `plan_review_unreviewed`, `pending_tasks_unfinished` | `packages/plan/src/capability/orchestration.ts` |

`plan_review` and `task_nudge` are declared in `@clarvis/capability` but deliberately excluded from
`BUILTIN_TRACE_KINDS` (`packages/capability/src/trace-kinds.ts`); the declaring comment says "`plan_review` is a
kind the planning capability records, not one the engine does" (`packages/capability/src/trace-kinds.ts`).

The trace record on a plan tool call is load-bearing rather than decorative: the TSDoc says plan
calls "reached the trace" through no dispatcher, so "`create_plan` and `transition_plan_task` were
absent from the persisted trace entirely while being present in the run's own context"
(`packages/plan/src/capability/orchestration.ts`). Pinned by
`packages/plan/tests/component/plan-orchestration.test.ts`.

### 3.5 Tool result payloads

Every mutating tool's result carries the **next** CAS triple, so consecutive writes need no
intervening `read_plan` (`packages/plan/src/capability/runtime-tools.ts`). The wire string is
`` `Tool '${name}' result: ${JSON.stringify(payload)}` `` on success and
`` `Tool '${name}' result (error): ${message}` `` on failure (`packages/plan/src/capability/runtime-tools.ts`).

| Tool | Payload |
| --- | --- |
| `create_plan` | `{ ...cas, task_ids: [...] }` (`packages/plan/src/capability/runtime-tools.ts`) |
| `read_plan` | the document, or `null` |
| `list_plans` | the store's `PlanListResult` |
| `revise_plan` | `cas(document)` |
| `transition_plan_task` | `{...cas, tasks: [only the tasks this call moved] }` |

Real example from the integration test — a plan file created mid-run at
`.clarvis/plans/<yyyy-MM-ddTHH-mm-ss>-audit-the-auth-flow.md`, whose filename shape is asserted by
`/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-audit-the-auth-flow\.md$/`
(`packages/plan/tests/integration/planned-run-file.test.ts`). Document layout and the digest
algorithm belong to the **plan-document-and-store** document.

### 3.6 Elicitation payload

`buildPlanReviewElicitParams()` (`packages/plan/src/capability/review-gate.ts`) produces:

```jsonc
{
  "kind": "plan_review",
  "message": "The Lead has proposed a plan (shown above). Approve it, request changes, or cancel the run?",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "decision": { "type": "string", "enum": ["request_changes", "approve", "cancel"], "description": "…" },
      "feedback": { "type": "string", "description": "Optional notes for the Lead when requesting changes." }
    },
    "required": ["decision"]
  }
}
```

The plan body is **not** in the message — the test asserts the message contains neither
`[plan-review]` nor `[plan]` nor `phase:`
(`packages/plan/tests/unit/plan-review-gate.test.ts`, `identifies itself by kind and asks a constrained decision + optional feedback, with NO plan body`).

---

## 4. Behavior

### 4.1 Run activation (`forRun`)

Order of operations in `packages/plan/src/capability/index.ts`:

1. `readPlansSettings(ctx.requestParam("plans"))` parses the param with this capability's own schema. A parse failure or an absent value yields `{ mode: PLANS_DEFAULTS.mode }` — i.e.
   `"on"`.
2. `mode === "off"` → return `null` immediately, **before** any provider resolution.
3. Bind the logger with `execution_id`.
4. `await options.factory.storeFor(ctx.owner)`.
5. Reconcile the continuation ref against the resolved provider key :
   - no prior ref, or matching `provider_key` → carry it forward;
   - mismatched key and prior `status === "completed"` → drop it (`undefined`);
   - mismatched key otherwise → **throw** `PlanProviderMismatchError` (`packages/plan/src/provider.ts`).
6. `elicitWaitMs = ctx.request.elicit_wait_ms ?? options.defaultElicitWaitMs`.
7. Construct one `PlanSession` for the whole run.
8. Publish the task-port provider on `ctx.services` under `PLAN_PORT`.

### 4.2 Agent attachment

`forAgent(scope)` returns `null` for any non-entry agent (`packages/plan/src/capability/index.ts`), so sub-agents never get
plan tools. For the entry agent, `attach(bc)` memoizes one orchestration per `AgentBuildContext` in a
`WeakMap` (`packages/plan/src/capability/index.ts`) and returns that
contribution unchanged (`packages/plan/src/capability/index.ts`). It used to carry
`advertised: false`, meaning "stay out of `availableWireNames`"
(`packages/capability/src/contract.ts`) — but that field is consulted only when
`mcpFullToolset !== true`, and the lead persona, the only persona this capability attaches to, sets
it `true` (`packages/loop/src/runtime/subagents/build-lead-input.ts`). The flag could never act,
and has been removed.

The review ask is built only when all three of `review`, `scope.elicit` and `scope.clock` are present
(`packages/plan/src/capability/index.ts`).

### 4.3 The contribution

`buildPlansOrchestration` returns (`packages/plan/src/capability/orchestration.ts`):

```
tools:    the five plan tools
handlers: [ reviewBlocker, createPlanHandler, readPlanHandler, listPlansHandler,
            revisePlanHandler, transitionPlanTaskHandler ]
gates:    [ reviewGate, pendingGate ]
anchor:   () => "Current plan" | "Plan unavailable" | undefined
hooks:    { beforeIteration, contributesProgress }
```

`reviewBlocker` is **first** by construction (`packages/plan/src/capability/orchestration.ts`), which is what the gating test
relies on when it reads `handlers[0]` rather than using `find`
(`packages/plan/tests/component/plan-orchestration.test.ts`).

### 4.4 The review blocker

Three phases, computed per call by `reviewPhase()`
(`packages/plan/src/capability/orchestration.ts`, `reviewPhase`):

| Phase | Condition | Allowed |
| --- | --- | --- |
| `open` | `!planReview` or the plan holds an approval at the current `spec_revision` | everything (blocker returns `matches: false`) |
| `unplanned` | review on, no plan cached | plan tools, `control` tools, `read` tools |
| `awaiting` | review on, plan cached but unapproved | plan tools, `control` tools only |

`allowedInPhase` (`packages/plan/src/capability/orchestration.ts`, `allowedInPhase`) asks the `ToolEffectPort` what a tool *does* rather
than matching names. `unknown` and `spawn_run` are refused in both phases by construction — the
TSDoc names that explicitly (`packages/plan/src/capability/orchestration.ts`), and the tests pin it: an MCP-shaped name
is blocked (`packages/plan/tests/component/plan-orchestration.test.ts`), `run_leader`/`run_work_items` are blocked while
the in-run `spawn_subagent` and `delegate_task` tools (classified `control`) are not
(`packages/plan/tests/component/plan-orchestration.test.ts`, review-blocker cases).

When no `ToolEffectPort` is on the registry, `forRun` substitutes `{ effect: () => "unknown" }`
(`packages/plan/src/capability/index.ts`), so an unclassified tool is refused during review
(`packages/plan/tests/component/plan-capability-gating.test.ts`).

Three distinct refusal texts, chosen by `refusalFor`
(`packages/plan/src/capability/orchestration.ts`, `refusalFor`):

| Situation | Message | File |
| --- | --- | --- |
| effect is `spawn_run` | `planReviewSpawnBlock(tool)` — "starts an independent run whose own tools this gate does not bound" | `packages/plan/src/capability/messages.ts` |
| phase `unplanned` | `planReviewUnplannedBlock(tool)` — names the read-only tools and `create_plan` | `packages/plan/src/capability/messages.ts` |
| phase `awaiting` | `PLAN_REVIEW_AWAITING_APPROVAL_BLOCK` | `packages/plan/src/capability/messages.ts` |

The verdict is always `{ kind: "result", text: "Tool '<name>' result: <refusal>", progress: false }`
(`packages/plan/src/capability/orchestration.ts`, `reviewBlocker.handle`).

`planReviewUnplannedBlock`'s TSDoc states the measured incident that made this the first place the
review contract reaches the model: "the requirement was stated only inside `delegate_task`'s
description, so a Lead that did the work itself learned of it from `PLAN_REVIEW_BYPASS_NOTE` — at
the *finalize* attempt, with the job already done. One measured run wrote three files and ran two
commands before anything spoke, then authored a plan titled '(completed)' describing work already
shipped, and a human 'approved' a fait accompli" (`packages/plan/src/capability/messages.ts`).

### 4.5 The review gate

`reviewGate.check(attempt)` (`packages/plan/src/capability/orchestration.ts`), in order:

| # | Condition | Outcome |
| --- | --- | --- |
| 1 | `!planReview \|\| isPlanApproved()` | `pass` |
| 2 | plan cached **and** `isRejectedAtCurrentSpec()` | `nudge` with `planReviewRejectionNote(attempt.mode === "submit", session.rejectionFeedback)` |
| 3 | plan cached, not yet judged at this spec | `presentPlanReviewGate()` |
| 3a | → `approved` and `attempt.mode === "submit"` | `pass` |
| 3b | → `approved` and mode `text` | `nudge` with `PLAN_REVIEW_EXECUTE_NOTE` |
| 3c | → `revise` | record the rejection, `nudge` |
| 3d | → `terminal` | `terminal` with that result |
| 4 | no plan, first time | set `planReviewNudged`, record `bypass_detected`, `nudge` (`PLAN_REVIEW_BYPASS_MSG` on submit, `PLAN_REVIEW_BYPASS_NOTE` on text) |
| 5 | no plan, already nudged | `terminal` `plan_review_unreviewed` |

`fastAcceptOk()` is `!planReview || isPlanApproved()` (`packages/plan/src/capability/orchestration.ts`).

`planReviewRejectionNote` (`packages/plan/src/capability/orchestration.ts`, `planReviewRejectionNote`) composes a submit attempt's rejection text
from the exported `planNotApprovedRejection(feedback, retry)` (`packages/plan/src/capability/review-gate.ts`) with
`retry = "submit_result again"`; a `text`-mode attempt gets a different, inline rejection sentence
instead. The same `planNotApprovedRejection` is the one `beforeSpawn`'s delegation refusal composes
from too, with `retry = "spawn sub-agents again"` — see §4.14.

`presentPlanReviewGate()` (`packages/plan/src/capability/orchestration.ts`) reconciles, emits
`plan_review_requested`, records `plan_review: presented`, then calls the ask:

| Decision | Effect |
| --- | --- |
| `approve` | `planSession.approve()`, emit `plan_review_resolved{approved}`, record `approved`, return `{kind:"approved"}` |
| `request_changes` | emit `plan_review_resolved{changes_requested}`, `planReviewRevision += 1`, record `changes_requested`; if the counter now exceeds `MAX_PLAN_REVIEW_REVISIONS` (10, `packages/plan/src/capability/orchestration.ts`) → `terminal` `plan_review_revision_limit` with `renderPlan(...)` as `partialText`; else `{kind:"revise", feedback?}` |
| `cancel` / `no_human` | record `cancelled` or `no_human_fallback`, emit `plan_review_resolved{cancelled}`, `trace.record("terminate", {reason:"plan_review_cancelled"})`, `terminal` with `status: "cancelled"` |

An **exception** thrown by the ask is re-checked against `bc.maybeCancelled()`: a cancelled run
returns that result as `terminal`, otherwise the error propagates
(`packages/plan/src/capability/orchestration.ts`, `presentPlanReviewGate`'s `planReviewAsk` error branch; both branches pinned at
`packages/plan/tests/component/plan-orchestration.test.ts`).

**Rejection is keyed by spec digest, not by iteration.** `recordRejection` stores
`planSession.cached()?.spec_digest` (`packages/plan/src/capability/orchestration.ts`, `recordRejection`) and `isRejectedAtCurrentSpec`
compares against the live one (`packages/plan/src/capability/orchestration.ts`, `isRejectedAtCurrentSpec`). The TSDoc states the failure this
replaced: "Holding it per iteration re-asked the human to approve a byte-identical plan on every
subsequent finalize attempt" (`packages/plan/src/capability/orchestration.ts`, `SessionState.rejectedSpecDigest` contract). Pinned:
`packages/plan/tests/component/plan-orchestration.test.ts` asks once across three retries and a second time only after a
real revision.

### 4.6 The pending-task gate

`pendingGate` (`packages/plan/src/capability/orchestration.ts`) delegates to `pendingTaskGate()`
(`packages/plan/src/capability/orchestration.ts`):

| # | Condition | Outcome |
| --- | --- | --- |
| 1 | `pendingNudgeCap === 0` | `ok` |
| 2 | no open task | `ok` |
| 3 | progress made — every open id was spawned this batch, **or** the open count fell below `lastNudgeOpenCount` | `pendingStall = 0`, fall through |
| 4 | `pendingStall < pendingNudgeCap` | increment stall/total, set `lastNudgeOpenCount`, record `task_nudge{nudged}`, return `nudge` with `PENDING_TASKS_NOTE(ids)` |
| 5 | otherwise | record `task_nudge{terminated}`, `terminal` `pending_tasks_unfinished` |

`fastAcceptOk()` is `false` only when the cap is positive **and** some task is neither `done` nor
`abandoned` (`packages/plan/src/capability/orchestration.ts`, `pendingGate.fastAcceptOk`); all three arms are pinned at
`packages/plan/tests/component/plan-orchestration.test.ts`.

### 4.7 Per-iteration and per-session state

`SessionState` persists across iterations (`packages/plan/src/capability/orchestration.ts`); `IterState` is rebuilt
each `beforeIteration` by `freshIter()` (`packages/plan/src/capability/orchestration.ts`).

`hooks.beforeIteration` does exactly two things: reset `iter` and call `publishPlanContext()`
(`packages/plan/src/capability/orchestration.ts`, `hooks.beforeIteration` and `publishPlanContext`). `publishPlanContext` sets the stable block `plan_document` to
`planSpecBlock(document)` and the canonical state to `planCasHeader(document, planReview)`; with no
cached document it publishes the missing-plan tombstone instead, or nothing when there is neither
(`packages/plan/src/capability/orchestration.ts`).

`hooks.contributesProgress()` is `iter.planContentChanged || iter.planReviewChangeRequested`
(`packages/plan/src/capability/orchestration.ts`). `planReviewChangeRequested` is set only inside `recordRejection`
(`packages/plan/src/capability/orchestration.ts`) — i.e. only when the human was actually asked and answered, never when a
retry was turned away against an unchanged plan (`packages/plan/src/capability/orchestration.ts`, `IterState.planReviewChangeRequested` contract, pinned at
`packages/plan/tests/component/plan-orchestration.test.ts`).

### 4.8 The canonical-state split

Two halves, deliberately separated by cost:

| Half | Function | Contents | Republished |
| --- | --- | --- | --- |
| appended reminder | `planCasHeader(document, reviewRequired)` (`packages/plan/src/capability/canonical-state.ts`) | plan file path, the CAS triple, the approval line, open tasks, **all** task statuses | end of transcript, every iteration |
| stable spec block | `planSpecBlock(document)` (`packages/plan/src/capability/canonical-state.ts`) | objective, context, per-task `id`/`title`/`detail`/`exit`, validation | appended only when the substance changes |

The block's field set "deliberately mirrors `@clarvis/plan`'s `specDigest` … so these bytes change if
and only if `spec_revision` does" (`packages/plan/src/capability/canonical-state.ts`). Pinned:
`packages/plan/tests/unit/plan-canonical-state.test.ts` asserts `planSpecBlock` is byte-identical across two task
transitions while `revision` grows.

`approvalLine` is keyed on the **run**, not on `document.status`
(`packages/plan/src/capability/canonical-state.ts`), returning one of three sentences. Its TSDoc says deriving from
status alone "can state the exact opposite of what the runtime enforces"
(`packages/plan/src/capability/canonical-state.ts`); the four cases are pinned at
`packages/plan/tests/unit/plan-canonical-state.test.ts`.

The tombstone case has its own parallel pair, `missingPlanHeader`/`missingPlanSpecBlock`
(composed by `missingPlanCanonicalState`, `packages/plan/src/capability/canonical-state.ts`), which
`publishPlanContext` (`packages/plan/src/capability/orchestration.ts`) and `anchor()` (`packages/plan/src/capability/orchestration.ts`)
switch to in place of the live pair once the plan is gone. Their content carries a safety
instruction the live header never needs: "Do not reuse any earlier expected_revision,
expected_digest or expected_spec_digest values" (`packages/plan/src/capability/canonical-state.ts`), because the tombstone
supersedes every earlier copy of the plan the model may still be holding CAS values from.

`anchor()` returns `{ label: "Current plan", body: planCanonicalState(document, planReview) }`,
or `{ label: "Plan unavailable", … }` for a tombstone, or `undefined`
(`packages/plan/src/capability/orchestration.ts`).

### 4.9 `PlanSession.reconcile` — the continuation path

First call only (`packages/plan/src/capability/session.ts`):

| Condition | Effect |
| --- | --- |
| no `initialRef` | return `undefined` |
| read succeeds, `isPlanSealed(loaded)` | return it **verbatim** — no reset (`packages/plan/src/capability/session.ts`) |
| any `in_progress` task, or `status !== "active"`, or a stale approval | rewrite: `in_progress → pending`, `status = "active"`, clear `approved_spec_revision` when stale; log `plan.continuation.reset` with `tasks_reset`, `status_from`, `stale_approval_cleared` (`packages/plan/src/capability/session.ts`) |
| `PlanNotFoundError` + ref `status === "completed"` + `retention === "discard"` | log `plan.continuation.absent` at `debug`, return `undefined` (`packages/plan/src/capability/session.ts`) |
| `PlanNotFoundError` otherwise | `#markMissing` from the ref, return `undefined` (`packages/plan/src/capability/session.ts`) |
| any other error | rethrow (`packages/plan/src/capability/session.ts`) |

A "stale approval" is `!review && loaded.approved_spec_revision !== undefined`
(`packages/plan/src/capability/session.ts`). Both directions are pinned:
`packages/plan/tests/component/plan-session.test.ts` (dropped under `review: false`) (kept under
`review: true`).

Later calls (`packages/plan/src/capability/session.ts`): `store.reconcile` adopts an external edit; an
`InvalidPlanError` is recorded in `#invalidError` and the last valid document kept; a
`PlanConflictError` triggers a full re-read; a `PlanNotFoundError` (from either) tombstones.

### 4.10 `PlanSession.create` — the one-open-plan rule

`create` (`packages/plan/src/capability/session.ts`):

1. `reconcile()`.
2. If a plan exists and is not sealed:
   - `canCompletePlan(current)` false → throw `ActivePlanExistsError` (`packages/plan/src/capability/session.ts`);
   - otherwise **seal it** by setting `status = "completed"` and continue (`packages/plan/src/capability/session.ts`).
3. `retention = input.retention ?? this.#retention` (`packages/plan/src/capability/session.ts`).
4. `store.create({ ...input, retention?, createdByRun: executionId, review })`.
5. Clear `#invalidError` and `#missing`.

The bound is on **open** plans, not plans (`packages/plan/src/capability/session.ts`, TSDoc). Pinned:
`packages/plan/tests/component/plan-session.test.ts` (one turn finishes a plan and starts the next, sealing the first) (refused while a task is open).

### 4.11 Mutation guards on the session

| Method | Guard | File |
| --- | --- | --- |
| `revise` | `#requireMutable()`, then `isPlanSealed` → `PlanSealedError`, then a three-field CAS comparison → `PlanConflictError` | `packages/plan/src/capability/session.ts` |
| `transition` | batch size 1..`MAX_PLAN_BATCH_OPERATIONS` else `RangeError`; `#requireMutable()`; on a sealed plan, any transition to a non-closed status → `PlanSealedError` | `packages/plan/src/capability/session.ts` |
| `transitionCurrent` | supplies `expected` from the freshly reconciled document | `packages/plan/src/capability/session.ts` |
| `approve` | `#requireMutable()`, then `approved_spec_revision = spec_revision`, `status = "active"` | `packages/plan/src/capability/session.ts` |
| `setRetention` | `#requireMutable()` | `packages/plan/src/capability/session.ts` |
| `finalize(status)` | returns the existing ref unchanged when there is no plan, when `#invalidError` is set, or when the plan is sealed | `packages/plan/src/capability/session.ts` |
| `read(id?)` | omitted `id` reconciles and returns the session's own plan; an explicit `id` reads directly, throwing `MissingActivePlanError` immediately if it already matches the cached tombstone, or discovering a **new** tombstone (`#markMissingFromDocument`) and throwing it if the store 404s on an id matching the session's `#lastValid` | `packages/plan/src/capability/session.ts` |

`read(id)`'s explicit-id branch is a distinct tombstone-discovery path from the reconcile-driven one
described throughout §4.9 — no test in this document's scope exercises it (see §8).

`#requireMutable()` throws `InvalidPlanError` on an unparseable document, `MissingActivePlanError`
on a tombstone, and a bare `Error("No active plan")` otherwise (`packages/plan/src/capability/session.ts`).

`revise`'s TSDoc names the reason the seal is re-checked here: this method "does not call"
`PlanStore.revise` — it applies the operation itself and writes through the generic `update`, "so the
store's gate never sees the model's `revise_plan`" (`packages/plan/src/capability/session.ts`).

### 4.12 Tool dispatch

`handlePlanRuntimeCall(name, args, session, logger)` (`packages/plan/src/capability/runtime-tools.ts`):

1. For a batch tool, `assertRawArrayLimit` rejects an oversized **raw** array before zod walks every
   element (`packages/plan/src/capability/runtime-tools.ts`).
2. Parse per tool with zod; dispatch to the session.
3. `withRemoval(session, result)` attaches a one-shot tombstone if the call discovered one
   (`packages/plan/src/capability/runtime-tools.ts`, applied on both the success path the catch).
4. Any throw becomes a failure result — never propagated. If the error's `name` is outside
   `EXPECTED_PLAN_TOOL_ERRORS` (`packages/plan/src/capability/runtime-tools.ts`) it is additionally logged at `error`
   as `plan.tool.unexpected_error` with a `sanitizeErrorMessage`d cause and the stack
   (`packages/plan/src/capability/runtime-tools.ts`). `EXPECTED_PLAN_TOOL_ERRORS` is the closed, 11-member set that
   decides whether a throw is a modelled refusal or an operator-visible defect —
   `ActivePlanExistsError`, `InvalidPlanError`, `MissingActivePlanError`, `PlanConflictError`,
   `PlanNotFoundError`, `PlanNotTerminalError`, `PlanProviderMismatchError`,
   `PlanProviderUnavailableError`, `PlanSealedError`, `RangeError`, `ZodError`
   (`packages/plan/src/capability/runtime-tools.ts`). The TSDoc states the reason: "Anything outside this set reaching
   the catch-all is a defect in Clarvis, not a refusal the model can act on — and the model is
   handed the two in identical shapes" (`packages/plan/src/capability/runtime-tools.ts`).
5. An unrecognised `name` yields `failure(name, Error("Unknown plan tool: …"))`.

`planCallHandler` then wraps each dispatch (`packages/plan/src/capability/orchestration.ts`): trace the call, emit
`plan_removed` and republish context if `r.removed`, set `iter.planContentChanged` if `r.changed`,
emit `plan_created`/`plan_updated` if `r.document`. The event kind is `plan_created` only for
`create_plan`; the `change` tag is `content` for `revise_plan` and `task` otherwise
(`packages/plan/src/capability/orchestration.ts`).

### 4.13 Run teardown

Two hooks, in this order (`packages/capability/src/contract.ts` explains why both exist):

1. **`finalizeRun({ status })`** (`packages/plan/src/capability/index.ts`), *before* the record is built.
   Returns `undefined` when no agent ever attached (`liveSession === undefined`, pinned at
   `packages/plan/tests/component/plan-capability-gating.test.ts`). Otherwise maps the run status →
   `completed` / `cancelled` / **`failed`** for everything else (pinned at
   `packages/plan/tests/component/plan-capability-gating.test.ts`), calls `liveSession.finalize(...)`, emits
   `plan_updated{change:"status"}`, and returns the `PlanRef`.
2. **`onRunEnd(record)`** (`packages/plan/src/capability/index.ts`), *after* the record persists.
   Returns immediately unless `record.status === "completed"` **and** `ref.retention === "discard"`. Deletes through `bestEffort`, logs `plan.retention.discarded` with `deleted: boolean`
   at `info` either way, and emits `plan_removed` only when a document was actually removed.

In isolated execution, the host independently enforces this retention path. Mutation authority is
bound to a plan created through that run's grant or its host-selected continuation ref. Read/list
do not rebind it. Deletion requires the current owner's durable completed run record and matching
provider/id/final revisions, plus canonical `completed`/`discard` state. The host supplies CAS from
its own read, so a concurrent retention change prevents deletion even if the guest omitted CAS.
Production: `createHostPlansGrant` in
[`plan-bridge.ts`](../../packages/kernel/src/runtime/plan-bridge.ts) and `createLocalContainerRuntime`
in [`local-container-runtime.ts`](../../packages/kernel/src/runtime/local-container-runtime.ts).
Test: foreign-plan, retained/active-plan, trace identity and CAS refusals in
[`runtime-plan-bridge.test.ts`](../../packages/kernel/tests/unit/runtime-plan-bridge.test.ts), and
real guest keep/discard lifecycle in
[`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts).

The `lifecycle.onRunStart` hook exists only for a continuation (`packages/plan/src/capability/index.ts`): it reconciles,
emits `plan_removed` if the continuation plan was gone (and returns), else emits
`plan_updated{change:"recovery"}` (`packages/plan/src/capability/index.ts`). Pinned at
`packages/plan/tests/component/plan-capability-gating.test.ts`.

### 4.14 Delegation port state machine

`createDelegationPlanPort(session, onUpdated?)` (`packages/plan/src/capability/delegation-port.ts`) returns a
`Pick<PlanDelegationPort, "reconcile" | "openTasks" | "getTask" | "markSpawned" | "markFailed" |
"markReturned">` (`packages/plan/src/capability/delegation-port.ts`):

| Method | (state) → (state, effect) |
| --- | --- |
| `reconcile()` | delegates straight to `session.reconcile()`; no return value |
| `openTasks()` | cached tasks not `done`/`abandoned` |
| `getTask(id)` | cached task by id |
| `markSpawned(id)` | `in_progress` → `false`; `failed`/`returned` → reset to `pending` first (`recovering = true`); then `pending` → `in_progress`, `onUpdated(doc, recovering ? "recovery" : "task")`, `true`; anything else → `false` |
| `markFailed(id, error)` | only from `in_progress` → `failed`, `onUpdated(doc,"task")`, `true`; else `false` |
| `markReturned(id, summary)` | only from `in_progress` → `returned` with `result: summary`, `true`; else `false` |

`reconcile` is exercised directly by the test fixture's own setup, not just through the other
methods — `packages/plan/tests/component/delegation-plan-port.test.ts`.

The orchestration layers three more members onto it (`packages/plan/src/capability/orchestration.ts`):

- **`beforeSpawn(taskId)`** first calls `ensurePlanReviewGate()` (`packages/plan/src/capability/orchestration.ts`),
  then refuses a duplicate `task_id` already in `iter.spawnedTaskIds` this batch
  (`duplicateBatchTaskId`), then refuses while the current spec stands rejected
  (`planNotApprovedRejection(session.rejectionFeedback, "spawn sub-agents again")`,
  `packages/plan/src/capability/orchestration.ts`, `port.beforeSpawn`'s rejected-plan branch), else `ok`.
  `ensurePlanReviewGate()` reconciles, and — only when reviewing, a plan is cached, and it is
  neither approved nor already rejected at the current spec — presents the review gate
  **synchronously inside the spawn attempt**, meaning either child-spawn tool (not only
  `submit_result`/finalize) can trigger the human elicitation. Its four branches, each pinned by a
  dedicated test:
  1. a `planReviewAsk` throw propagates when the run is not cancelled
     (`packages/plan/tests/component/plan-orchestration.test.ts`);
  2. the same throw is swallowed into a terminal `cancelled` result instead, when the run is
     already cancelled (`bc.maybeCancelled()`) — so the gate can itself end the run
     (`packages/plan/tests/component/plan-orchestration.test.ts`);
  3. a spawn is refused while the gate is unresolved, and the ask fires **exactly once** across
     repeated `beforeSpawn` calls in the same iteration — no re-elicit
     (`packages/plan/tests/component/plan-orchestration.test.ts`);
  4. a `request_changes` decision with no feedback still reads back as a rejection, without notes
     (`packages/plan/tests/component/plan-orchestration.test.ts`).
- **`noteSpawned(taskId)`** adds to `iter.spawnedTaskIds`, read back by the pending gate's progress
  test (§4.6).
- **`augmentDelegateTask()`** returns `buildDelegateTaskPlanAugmentation(planReview)`
  (`packages/plan/src/capability/messages.ts`, `buildDelegateTaskPlanAugmentation`): the tracked
  description plus the required `task_id` property. Under review the suffix directs pre-plan
  exploration to `spawn_subagent` and keeps `delegate_task` reserved for an exact existing task.
  A plan therefore adds tracked delegation; independent spawning remains a separate capability.

Both `beforeSpawn`'s rejected-spec refusal and the submit-mode review-gate nudge (`reviewGate.check`,
§4.5) compose their text from the same exported function, `planNotApprovedRejection(feedback,
retry)` (`packages/plan/src/capability/review-gate.ts`): the delegation refusal calls it with `retry = "spawn sub-agents
again"` (`packages/plan/src/capability/orchestration.ts`), and `planReviewRejectionNote` calls it with `retry = "submit_result
again"` for a submit attempt (`packages/plan/src/capability/orchestration.ts`).

`markReturned` records `returned`, never `done` — pinned with the reason inline at
`packages/plan/tests/component/delegation-plan-port.test.ts`.

### 4.15 Kernel wiring

`createPlanningRuntime` (`packages/kernel/src/plans/planning-runtime.ts`) builds one `markdownStoreFor` (or takes the
host's), one `createPlanFactory`, and returns `{ planFactory, capability }` where the capability is
constructed with `env.CLARVIS_DEFAULT_PENDING_TASK_NUDGES` and
`env.CLARVIS_DEFAULT_ELICIT_WAIT_MS` (`packages/kernel/src/plans/planning-runtime.ts`; env defaults 3 and 1 800 000 ms
at `packages/capability/src/env.ts`).

`file-kernel.ts` composes it with a settings-reading `loadPlanProvider`, a plugin
locator scoped to `PLANS_CAPABILITY_NAME`, and the shared executable port, then hands `planning.planFactory` to `createInProcessKernel`.
`packages/kernel/src/kernel.ts` builds the per-owner `PlansService` from
`() => planFactory.storeFor(scope.owner)` — the same factory the capability holds, so a run and the
control plane read one provider store (`packages/plan/src/capability/index.ts`).

`plansBlockToParam` (`packages/kernel/src/runs/settings-assembler.ts`) projects the
settings block onto the request param. `retention` is always **materialized** —
"an absent or malformed value becomes `PLANS_DEFAULTS.retention` rather than being dropped"
(`packages/kernel/src/runs/settings-assembler.ts`) — and an unrecognized `mode` falls back to the default rather
than disabling planning silently.

---

## 5. Invariants

Numbered; each carries production evidence and the pinning test.

1. **`mode: "off"` resolves no provider.** `forRun` returns `null` before touching
   `options.factory` — `packages/plan/src/capability/index.ts`.
   Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts` (`resolutions` stays 0).

2. **`requiresUserInput` is true exactly for `review`,** in both the terse and block forms, and false
   for an unconfigured request — `packages/plan/src/capability/index.ts`.
   Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts`.

3. **The reservation is derived from the tools, never spelled twice.**
   `PLAN_TOOL_WIRE_NAMES = buildPlanRuntimeTools(false).map(t => t.wireName)` —
   `packages/plan/src/capability/index.ts`. `toolEffects` is derived from the same array with `read` for exactly
   `read_plan`/`list_plans` — `packages/plan/src/capability/index.ts`.
   Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts` asserts both against the five constants.

4. **A continuation from a different provider is refused unless the plan was completed.**
   `packages/plan/src/capability/index.ts` throws `PlanProviderMismatchError` (`code: "plan_provider_mismatch"`,
   `packages/plan/src/provider.ts`) for an unfinished ref, and drops a `completed` one.
   Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts` (both branches).

5. **Only the entry agent gets planning.** `forAgent` returns `null` when `!scope.entry` —
   `packages/plan/src/capability/index.ts`. **Unpinned** by any test in `packages/plan/tests/`.

6. **Plan tools reach the model through the lead's full toolset, not the advertised list.**
   `attach` returns the orchestration's contribution verbatim
   (`packages/plan/src/capability/index.ts`). The `advertised` flag
   (`packages/capability/src/contract.ts`) would be a no-op here either way.

7. **The review blocker is the contribution's first handler.**
   `handlers: [reviewBlocker, ...planTools.map(...)]` — `packages/plan/src/capability/orchestration.ts`.
   Pinned: `packages/plan/tests/component/plan-orchestration.test.ts` reads `handlers[0]` deliberately, and every
   `blocked()` assertion in that describe block depends on it.

8. **A tool of `unknown` effect is refused in both review phases.** `allowedInPhase` admits only a
   plan tool, `control`, or (in `unplanned`) `read` — `packages/plan/src/capability/orchestration.ts` (`allowedInPhase`); the fallback
   port when none is registered classifies everything as `unknown` — `packages/plan/src/capability/index.ts`.
   Pinned: `packages/plan/tests/component/plan-orchestration.test.ts` and `packages/plan/tests/component/plan-capability-gating.test.ts`.

9. **A `spawn_run` tool is refused in both phases, while `control` delegation is not.**
   `packages/plan/src/capability/orchestration.ts` (`allowedInPhase` and `refusalFor`).
   Pinned: `packages/plan/tests/component/plan-orchestration.test.ts`.

10. **The review gate re-presents only when the plan's substance changed.** Rejection is keyed by
    `spec_digest` — `packages/plan/src/capability/orchestration.ts`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts` (`asks` stays 1 across three retries, becomes 2
    after a structural revision).

11. **A structural revision revokes an approval and re-locks the run.** The blocker's `open` phase
    depends on `document.approved_spec_revision === document.spec_revision`
    (`packages/plan/src/capability/orchestration.ts`, `isPlanApproved` and `reviewPhase`).
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts`.

12. **Change-request rounds are capped at 10.** `MAX_PLAN_REVIEW_REVISIONS = 10`
    (`packages/plan/src/capability/orchestration.ts`); exceeding it terminates with `plan_review_revision_limit` and the
    rendered plan as `partialText` — `packages/plan/src/capability/orchestration.ts`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts` (11 `changes_requested` events, then terminal).

13. **A review run that never authors a plan is nudged once, then terminated `plan_review_unreviewed`.**
    `packages/plan/src/capability/orchestration.ts`, terminal built.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts`.

14. **An approval on a text-only finalize nudges rather than passing.**
    `packages/plan/src/capability/orchestration.ts` (`reviewGate.check`, approved text-mode branch).
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts`.

15. **`no_human` (declined, timed out, or no channel) never reads as approval.**
    `mapPlanReviewAnswer` maps any non-`accept` action and any unrecognized `decision` to
    `no_human` — `packages/plan/src/capability/review-gate.ts`; `no_human` cancels the run —
    `packages/plan/src/capability/orchestration.ts`.
    Pinned: `packages/plan/tests/unit/plan-review-gate.test.ts`.

16. **`request_changes` is listed first in the elicit enum.** `packages/plan/src/capability/review-gate.ts`. The test states
    the rule as behaviour, in a comment above the assertions it explains: "Order is behaviour, not
    presentation: a client highlights the schema's `default`, else the first option, so `approve`
    first meant one stray Enter approved the plan."
    Pinned: `packages/plan/tests/unit/plan-review-gate.test.ts`
    (`identifies itself by kind and asks a constrained decision + optional feedback, with NO plan body`).

17. **The review elicit carries no plan body.** `buildPlanReviewElicitParams`'s message names the
    plan only as "shown above" — `packages/plan/src/capability/review-gate.ts`.
    Pinned: `packages/plan/tests/unit/plan-review-gate.test.ts`
    (`identifies itself by kind and asks a constrained decision + optional feedback, with NO plan body`).

18. **The human wait does not spend the run's compute budget.** `buildPlanReviewAsk` wraps the
    elicit in `elicitWithClockPause` — `packages/plan/src/capability/review-gate.ts`
    (`buildPlanReviewAsk`).
    Pinned: `packages/plan/tests/unit/plan-review-gate.test.ts` (`clock.paused === 1`, `clock.resumed === 1`),
    and the timeout path.

19. **The pending gate nudges up to the cap, then terminates `pending_tasks_unfinished`,** and a cap
    of 0 disables it entirely — `packages/plan/src/capability/orchestration.ts`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts`.

20. **A spawn against every open task counts as progress and resets the stall counter.**
    `allOpenSpawnedThisBatch` is read off `iter.spawnedTaskIds`, written only by
    `noteSpawned` — `packages/plan/src/capability/orchestration.ts` (`pendingTaskGate` and `port.noteSpawned`).
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts`.

21. **A retry against an unchanged rejected plan does not count as progress.**
    `planReviewChangeRequested` is set only inside `recordRejection` — `packages/plan/src/capability/orchestration.ts`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts`.

22. **A `task_id` may be spawned at most once per iteration.** `beforeSpawn` refuses a repeat with
    `duplicateBatchTaskId(taskId)` — `packages/plan/src/capability/orchestration.ts` (`port.beforeSpawn`, duplicate-task branch), message at `packages/plan/src/capability/messages.ts`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts` (`refuses a task_id already
    spawned this iteration`); the following independent-spawn case is exempt because it carries no id.

23. **A completed plan is sealed: it may not be revised, and a task may only be *closed*.**
    `revise` throws `PlanSealedError` (`packages/plan/src/capability/session.ts`); `transition` refuses a batch containing
    any non-closed target status (`packages/plan/src/capability/session.ts`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts` for both the ordinary and
    all-or-nothing batch cases.

24. **A sealed plan is loaded verbatim on continuation and never re-stamped by `finalize`.**
    `reconcile` returns early on `isPlanSealed` (`packages/plan/src/capability/session.ts`); `finalize` returns `this.ref()`
    unchanged (`packages/plan/src/capability/session.ts`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts` (a cancelled continuation leaves
    `completed` standing).

25. **A session may hold more than one plan over its life, but only one *open* one.**
    `create` seals a fully-closed plan and proceeds; it throws `ActivePlanExistsError` only while
    work remains — `packages/plan/src/capability/session.ts`.
    Pinned: `packages/plan/tests/component/plan-session.test.ts`.

26. **An approval carried into a run with no review gate is dropped.**
    `staleApproval = !this.#review && loaded.approved_spec_revision !== undefined` —
    `packages/plan/src/capability/session.ts`, cleared.
    Pinned: `packages/plan/tests/component/plan-session.test.ts`; the mirror (kept under `review: true`).

27. **A continuation resets `in_progress` tasks to `pending` as an audited revision.**
    `packages/plan/src/capability/session.ts`, one `store.update` bumping `revision`.
    Pinned: `packages/plan/tests/component/plan-session.test.ts` (`revision === running.revision + 1`), and at the
    capability level with the recovery projection at `packages/plan/tests/component/plan-capability-gating.test.ts`.

28. **A missing `discard`ed plan from a completed run is normal, not a loss.**
    `packages/plan/src/capability/session.ts` returns `undefined` and logs at `debug`.
    Pinned: `packages/plan/tests/component/plan-observability.test.ts` (`reason === "discarded"`, level `debug`).

29. **A removed backing record invalidates every mutable cache and produces exactly one
    `plan_removed`.** `#markMissing` clears `#lastValid`, sets `#missing` and arms `#pendingRemoval`
    with `??=` (`packages/plan/src/capability/session.ts`); `takeRemoval` is one-shot (`packages/plan/src/capability/session.ts`);
    `withRemoval` attaches it once (`packages/plan/src/capability/runtime-tools.ts`).
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts` (`retry.removed` is `undefined`) and
    `packages/plan/tests/component/plan-orchestration.test.ts` (context is tombstoned, anchor flips to
    "Plan unavailable").

30. **A mutation on a tombstoned plan tells the model not to retry.**
    `MissingActivePlanError`'s message contains "Do not retry this mutation" —
    `packages/plan/src/capability/session.ts`.
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts`, `packages/plan/tests/component/plan-session.test.ts`.

31. **Every mutating tool result carries the next CAS triple.** `cas(document)` on
    `create_plan`/`revise_plan`/`transition_plan_task` — `packages/plan/src/capability/runtime-tools.ts`.
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts` chains create → revise → transition with no
    intervening `read_plan`.

32. **An oversized raw array is rejected before zod visits it.** `assertRawArrayLimit` throws a
    `RangeError` naming the limit — `packages/plan/src/capability/runtime-tools.ts`.
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts` for all three batch inputs; asserts nothing was
    written.

33. **A batch is all-or-nothing and costs one revision.** `transition` folds every member inside a
    single `store.update` (`packages/plan/src/capability/session.ts`); `revise` applies `applyPlanRevisions` and writes
    once (`packages/plan/src/capability/session.ts`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts`;
    `packages/plan/tests/component/plan-runtime-tools.test.ts` for both tools at the wire level.

34. **`transition_plan_task` refuses a call with neither `transitions` nor a single `task_id`.**
    `superRefine` at `packages/plan/src/capability/runtime-tools.ts`.
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts`.

35. **`revise_plan`'s wire schema refuses both-or-neither of `operation`/`operations`.** The XOR
    refinement site in this package is `packages/plan/src/tools.ts` — full statement
    owned by [capabilities/plan-store.md](plan-store.md) §5.

36. **`retention: discard` deletes only after a `completed` terminal record.**
    `onRunEnd` returns unless `record.status === "completed" && ref.retention === "discard"` —
    `packages/plan/src/capability/index.ts`.
    Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts` (a non-completed end leaves it, and a later
    completed end still finds it) and the end-to-end file check at
    `packages/plan/tests/integration/planned-run-file.test.ts`.

37. **The discard path is idempotent and emits `plan_removed` only on a real deletion.**
    `if (!deleted) return;` before the emit — `packages/plan/src/capability/index.ts`.
    Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts`.

38. **`keep` is the default at every layer, and the two definitions are pinned equal.**
    `DEFAULT_PLAN_RETENTION = "keep"` (`packages/plan/src/schemas.ts`), `PLANS_DEFAULTS.retention = "keep"`
    (`packages/plan/src/settings.ts`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts`.

39. **The nudge default is pinned to the contract's copy.** `PLANS_DEFAULTS.pending_task_nudges`
    equals `DEFAULT_PENDING_TASK_NUDGES` from `@clarvis/capability`
    (`packages/plan/src/settings.ts`, `packages/capability/src/env.ts`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts`.

40. **Provider selection is settings-only and never a request param.** `plansRunConfigSchema` is
    `.strict()` and omits `provider` — `packages/plan/src/settings.ts`; the spec is
    `pluginContributable: false` — `packages/plan/src/settings.ts`.
    Pinned: `packages/plan/tests/unit/settings.test.ts` (all three provider kinds parse in
    the block and are refused in the param).

41. **The settings entry never reaches executable-provider code.**
    `packages/plan/src/settings.ts` imports `./provider-config.ts` and nothing else local, and
    that file pulls in neither `./provider.ts` nor `node:fs`
    (`packages/plan/src/provider-config.ts`) — full statement owned by
    [capabilities/provider-executables.md](provider-executables.md) §5.
    Pinned: `packages/plan/tests/architecture/settings-provider-boundary.test.ts`.

42. **The stable spec block is byte-identical across task transitions.**
    `planSpecBlock`'s field set mirrors `specDigest` — `packages/plan/src/capability/canonical-state.ts`.
    Pinned: `packages/plan/tests/unit/plan-canonical-state.test.ts`.

43. **The latest appended reminder carries every task's status; older reminders remain history.**
    `packages/plan/src/capability/canonical-state.ts`; the test also caps it: `header.length < 1000`.
    Pinned: `packages/plan/tests/unit/plan-canonical-state.test.ts`.

44. **The approval line reports the run's posture, not the document's status.**
    `approvalLine(document, reviewRequired)` — `packages/plan/src/capability/canonical-state.ts`.
    Pinned: `packages/plan/tests/unit/plan-canonical-state.test.ts` (an `active` document in a gated run still
    reports the gate).

45. **Delegation may claim and fail a task but never judge it done.** `createDelegationPlanPort`
    exposes only `reconcile`/`openTasks`/`getTask`/`markSpawned`/`markFailed`/`markReturned` —
    `packages/plan/src/capability/delegation-port.ts`.
    Pinned: `packages/plan/tests/component/delegation-plan-port.test.ts`.

46. **The tracking port's absence is reported once, at `debug`, and never fails a run.**
    `absenceReported` latch — `packages/plan/src/capability/index.ts`.
    Pinned: `packages/plan/tests/component/plan-observability.test.ts` (two `forAgent` calls, one record) (silent once the entry agent attached).

47. **A plan tool error the dispatcher does not model is logged; a refusal the model can act on is
    not.** `EXPECTED_PLAN_TOOL_ERRORS` gate — `packages/plan/src/capability/runtime-tools.ts`.
    Pinned: `packages/plan/tests/component/plan-observability.test.ts` (logged, incl. a non-Error throw) (silent for a modelled refusal and for a rejected argument schema).

48. **`plan_review` and `task_nudge` are contributed trace kinds, not engine ones.**
    Neither appears in `BUILTIN_TRACE_KINDS` (`packages/capability/src/trace-kinds.ts`)
    while both have published detail interfaces. **Unpinned** in
    `packages/plan/tests/`.

49. **All five plan wire events are live-only on the capability channel.**
    `packages/kernel/src/runs/event-policy.ts` maps each to `live("capability", ["capability_channel"])`, so a
    rehydrated session (which reads only the persisted trace) restores none of them. **Unpinned**
    in this document's scope.

50. **The plan document itself never enters the run trace.** `PlanRef`'s TSDoc states it — "The
    plan document itself is deliberately not in the run trace" (`packages/plan/src/schemas.ts`) — and the
    trace record for a plan tool call carries only the tool's
    `arguments`/`result` strings (`packages/plan/src/capability/orchestration.ts`). **Unpinned.**

51. **The kernel validates the `plans` `capability_state` slot before handing it to a client.**
    `planRefFromCapabilityState` returns `undefined` for anything failing `isPlanRef` —
    `packages/kernel/src/runs/plan-ref.ts`. **Unpinned** in this document's scope.

52. **The kernel's plans service refuses cleanly when planning is unconfigured.**
    `active()` throws `kernelError("capability_disabled", …)` when `options.resolve` is absent —
    `packages/kernel/src/plans/plans-service.ts`. **Unpinned** in this document's scope.

53. **`plansSettingsSpec` is registered at module load, before any settings file is read.**
    `packages/kernel/src/config/capability-registry.ts`, with the reason.
    **Unpinned** in this document's scope.

54. **The control plane refuses to delete a live plan.** `PlanService.delete` throws
    `PlanNotTerminalError` for `active` or `awaiting_approval` — `packages/plan/src/service.ts`.
    Pinned: `packages/plan/tests/component/plan-service.test.ts`.

55. **A corrupt plan is still deletable.** `PlanService.delete` catches `InvalidPlanError` and
    deletes without a CAS baseline — `packages/plan/src/service.ts`.
    Pinned: `packages/plan/tests/component/plan-service.test.ts`.

55b. **`PlanService.delete` re-reads the plan immediately before deleting, using that as its CAS
    baseline**, so a delete racing a concurrent mutation fails as `PlanConflictError` rather than
    silently clobbering the concurrent change.
    Pinned: `packages/plan/tests/component/plan-service.test.ts` (a write racing the delete between the read and the
    store's own `delete` call surfaces as `PlanConflictError`, and the racing write's effect
    survives).

56. **Under the server's `auto_decline` posture, `plans: "review"` is downgraded to `"on"`,** and the
    downgrade is reported — `packages/server/src/mcp/elicitation.ts`. **Unpinned** in
    this document's scope.

57. **The plan capability never turns independent spawning into a planning requirement.**
    `spawn_subagent` remains independent and has no `task_id`. The plan-owned `delegate_task`
    augmentation requires the exact id of an existing task and forbids invented ids. Production:
    `packages/plan/src/capability/messages.ts` (`DELEGATE_TASK_PLAN_DESCRIPTION`,
    `DELEGATE_TASK_TASK_ID_PROPERTY`). Test: `packages/plan/tests/unit/plan-messages.test.ts`.

---

## 6. Failure modes and degradation

| Condition | Handler | Behaviour |
| --- | --- | --- |
| `plans` param unparseable | `readPlansSettings` `safeParse` | falls back to `{ mode: "on" }` — planning stays **on** (`packages/plan/src/capability/index.ts`) |
| provider settings unreadable / invalid | `createPlanFactory.storeFor` | `PlanProviderUnavailableError` (`code: "plan_provider_unavailable"`, `packages/plan/src/provider.ts`) — thrown out of `forRun` |
| continuation ref names another provider, plan unfinished | `forRun` | throws `PlanProviderMismatchError` (`packages/plan/src/capability/index.ts`) — the run does not start |
| continuation ref names another provider, plan completed | `forRun` | ref dropped, run proceeds with no plan (`packages/plan/src/capability/index.ts`) |
| continuation plan absent, was `completed` + `discard` | `reconcile` | `undefined`, `debug` log `plan.continuation.absent` (`packages/plan/src/capability/session.ts`) |
| continuation plan absent otherwise | `reconcile` | tombstone; `plan_removed` at run start (`packages/plan/src/capability/session.ts`, `packages/plan/src/capability/index.ts`) |
| on-disk plan unparseable | `reconcile` catch | `#invalidError` set, **last valid document kept, file untouched**; mutations then throw `InvalidPlanError` from `#requireMutable` (`packages/plan/src/capability/session.ts`) |
| `store.reconcile` conflict | `reconcile` catch | full re-read; a `PlanNotFoundError` on that re-read tombstones (`packages/plan/src/capability/session.ts`) |
| stale CAS on a mutation | `revise` / store `update` | `PlanConflictError("Plan changed since it was read")` (`packages/plan/src/capability/session.ts`); no write — pinned at `packages/plan/tests/component/plan-runtime-tools.test.ts` |
| mutation on a sealed plan | `revise`/`transition` | `PlanSealedError` with `sealedRevisionMessage`/`sealedTransitionMessage` (`packages/plan/src/capability/session.ts`) |
| second `create_plan` with open work | `create` | `ActivePlanExistsError` naming `revise_plan` and `transition_plan_task` (`packages/plan/src/capability/session.ts`) |
| any plan-tool throw | `handlePlanRuntimeCall` catch | converted to a failure **result** string; never propagated (`packages/plan/src/capability/runtime-tools.ts`) |
| unmodelled plan-tool throw | same catch | additionally `logger.error` `plan.tool.unexpected_error` with `sanitizeErrorMessage`d cause + stack (`packages/plan/src/capability/runtime-tools.ts`) |
| unknown plan tool name | dispatch `default` | `failure(name, Error("Unknown plan tool: …"))` (`packages/plan/src/capability/runtime-tools.ts`) |
| review ask throws, run cancelled | `presentPlanReviewGate` | returns the cancellation as `terminal` (`packages/plan/src/capability/orchestration.ts`, `presentPlanReviewGate`'s `planReviewAsk` error branch) |
| review ask throws, run live | same | rethrows (`packages/plan/src/capability/orchestration.ts`) |
| elicit times out / declines / no channel | `mapPlanReviewAnswer`, `buildPlanReviewAsk`'s `onNoResponse` | `no_human` → run **cancelled** (`packages/plan/src/capability/review-gate.ts`; `packages/plan/src/capability/orchestration.ts`) |
| 11th change request | `presentPlanReviewGate` | `terminal` `plan_review_revision_limit`, `partialText` = rendered plan (`packages/plan/src/capability/orchestration.ts`) |
| review run finalizes twice with no plan | `reviewGate.check` | `terminal` `plan_review_unreviewed` (`packages/plan/src/capability/orchestration.ts`) |
| open tasks past the nudge cap | `pendingTaskGate` | `terminal` `pending_tasks_unfinished`, message naming every open id (`packages/plan/src/capability/orchestration.ts`) |
| retention delete fails | `bestEffort` in `onRunEnd` | swallowed; `deleted` stays `false`; `plan.retention.discarded` logged with `deleted: false` and "nothing else will retry" (`packages/plan/src/capability/index.ts`) — pinned at `packages/plan/tests/component/plan-observability.test.ts` |
| `finalizeRun` with no attached agent | `packages/plan/src/capability/index.ts` | `undefined` — no `capability_state` slot |
| control plane, planning unconfigured | `createPlansService.active` | `kernelError("capability_disabled", "plans are not configured for this workspace")` (`packages/kernel/src/plans/plans-service.ts`) |
| control plane, provider unavailable | same | `kernelError("unavailable", sanitizeErrorMessage(...))`, details `sanitizeDeep`ed (`packages/kernel/src/plans/plans-service.ts`) |
| malformed `plans` slot on a stored record | `planRefFromCapabilityState` | `undefined` rather than a bad cast (`packages/kernel/src/runs/plan-ref.ts`) |
| capability event detail fails the closed schema | `capabilityEventToProto` | falls back to a generic bounded `capability_event` rather than dropping (`packages/kernel/src/runs/map-events.ts`) |

All three terminal error codes are declared in `guardTripCodes` (`packages/plan/src/capability/index.ts`), which per the
contract's own `@remarks` "Only affects the `reason` on the run's `run_ended` entry"
(`packages/capability/src/contract.ts`).

`finalizeRun` and `onRunEnd` are both bounded by
`CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` and a throw in either is logged without affecting the run
(`packages/capability/src/contract.ts`).

---

## 7. Coupling

### 7.1 Outbound (what planning depends on)

| Dependency | Kind | Forced by |
| --- | --- | --- |
| `@clarvis/capability` | runtime, static | value imports of `NOOP_LOGGER`, `TOOL_EFFECT_PORT`, `bestEffort`, `bind`, `projected` (`packages/plan/src/capability/index.ts`), `TASK_TRACKING_PORT` (`packages/plan/src/capability/task-port.ts`), `elicitWithClockPause` (`packages/plan/src/capability/review-gate.ts`), `sanitizeErrorMessage` (`packages/plan/src/capability/runtime-tools.ts`), `partialStructOf` (`packages/plan/src/capability/orchestration.ts`) |
| `zod` | runtime, static | `packages/plan/src/settings.ts`, `packages/plan/src/capability/runtime-tools.ts`, `packages/plan/src/tools.ts` |
| sibling `../format.ts`, `../schemas.ts`, `../store.ts`, `../transitions.ts`, `../revisions.ts`, `../repository.ts`, `../limits.ts`, `../provider.ts` | runtime, static | e.g. `packages/plan/src/capability/orchestration.ts`, `packages/plan/src/capability/session.ts` |
| `@clarvis/paths` | runtime, static | *not* from `src/capability/**` — it is a package-level dependency used elsewhere (`packages/plan/package.json`) |

**Nothing under `src/capability/**` imports `@clarvis/loop`.** The constraint is stated in the entry
file's own TSDoc (`packages/plan/src/capability/index.ts`) and the test-helper file repeats it: "`@clarvis/plan` must never
import `@clarvis/loop` — that edge would close a dependency cycle the loop's own tests enforce"
(`packages/plan/tests/helpers/context.ts`). The loop-side architecture test enforces the other
half of that boundary by asserting that the engine neither declares `@clarvis/plan` as a dependency
nor names it in production source
(`packages/loop/tests/architecture/no-feature-names.test.ts`).

The `ToolEffectPort` dependency is **required, not optional**, on the orchestration's deps
(`packages/plan/src/capability/orchestration.ts`); its TSDoc says absent it "every tool reads as `unknown` and a `review` run
is refused everything but planning — a silent, total regression of the gate's scope. Making it
mandatory turns a forgotten wire into a compile error" (`packages/plan/src/capability/orchestration.ts`, `PlansOrchestrationDeps.toolEffect`). The capability
still supplies a fallback rather than crashing (`packages/plan/src/capability/index.ts`).

### 7.2 Inbound (what depends on planning)

| Consumer | Edge | Forced by |
| --- | --- | --- |
| `@clarvis/kernel` | value import of `createPlansCapability` | `packages/kernel/src/plans/planning-runtime.ts` |
| `@clarvis/kernel` | value import of `plansSettingsSpec` for the settings registry | `packages/kernel/src/config/capability-registry.ts` |
| `@clarvis/kernel` | value import of `PLANS_DEFAULTS` for the run-request assembler | `packages/kernel/src/runs/settings-assembler.ts` |
| `@clarvis/kernel` | value import of `PLANS_CAPABILITY_NAME` for the `capability_state` key | `packages/kernel/src/runs/plan-ref.ts` |
| `@clarvis/kernel` | value imports of `PlanService`, `renderPlan`, `PlanProviderUnavailableError` | `packages/kernel/src/plans/plans-service.ts` |
| `@clarvis/code` | value import of `PLANS_DEFAULTS` re-exported through `packages/kernel/src/config.ts` | `packages/code/src/onboarding/seed-plans.ts`, `packages/code/src/adapters/settings.ts` |
| `@clarvis/loop` (delegation) | **structural only** — consumes a `TaskTrackingPort` from the service registry, never naming this package | `packages/capability/src/task-tracking-port.ts`; planning publishes under the same key at `packages/plan/src/capability/task-port.ts` |

The delegation edge is the one worth naming as *deliberately* structural: the entry TSDoc says
"`delegate_task` takes a port shaped like `PlanDelegationPort` without naming this package — which is
what keeps the dependency edge pointing one way" (`packages/plan/src/capability/index.ts`).

### 7.3 Ordering constraints

- **Capability fold order.** `order: -100` (`packages/plan/src/capability/index.ts`) is consumed by `orderCapabilities`
  (`packages/loop/src/runtime/capability-order.ts`), called at
  `packages/loop/src/runtime/entry-inputs.ts` and
  `packages/loop/src/runtime/orchestrator.ts`. The contract states the consequence: "planning's
  review blocker has to be consulted before the coding toolset and before the MCP catch-all or it
  guards nothing" (`packages/capability/src/contract.ts`). The loop test pins the exact
  plans-shaped ordering by sorting `plans` at `-100` ahead of default-order capabilities
  (`packages/loop/tests/unit/capability-dispatch-order.test.ts`).
- **Handler order inside the contribution.** `reviewBlocker` first — `packages/plan/src/capability/orchestration.ts`.
- **Settings registration before any read.** `packages/kernel/src/config/capability-registry.ts`.
- **`finalizeRun` before `onRunEnd`.** The contract spells out that this ordering is the reason both
  hooks exist: "sealing a plan and naming it on the record has to happen before the write, while
  deleting a discarded plan has to happen after it"
  (`packages/capability/src/contract.ts`).

### 7.4 Delegated to sibling documents

- Plan **document format, digests, `PlanStore`/`PlanRepository`, `applyPlanRevisions`,
  `transitionTask`'s matrix, list paging** → **plan-document-and-store**. Every one of them sits
  outside `src/capability/**`: `parsePlan`/`renderPlan` at `packages/plan/src/format.ts`, `digestText`/`specDigest`, the `PlanStore` interface and its cursor-paged
  `list` at `packages/plan/src/store.ts`, `PlanRecordQuery` and `PlanRepositoryTx` at
  `packages/plan/src/repository.ts`, `applyPlanRevisions` at
  `packages/plan/src/revisions.ts`, and `transitionTask` at
  `packages/plan/src/transitions.ts`.
- **`delegate_task`'s consumption** of the `TaskTrackingPort` → **loop-delegation-and-subagents**.
- **Plan block / overlay / sidebar rendering** in the TUI (`packages/code/src/adapters/plan-projection.ts`
  and friends) → **code-transcript-and-tool-rendering**.

---

## 8. Open questions

**Stale TSDoc that names files that no longer exist.** Three comments point at
`@clarvis/loop` paths that are not in the tree:

- ~~`packages/plan/src/tools.ts` pointed `revise_plan`'s validation at `@clarvis/loop`'s
  `runtime/plans/runtime-tools.ts`.~~ **Resolved.** The remark now names
  `capability/runtime-tools.ts` and records that both halves — the advertised wire contract and the
  validation applied to it — live inside this package (`packages/plan/src/tools.ts`).
- ~~`PLANS_CAPABILITY_NAME` was documented as "duplicated in `@clarvis/loop`'s `plans-settings.ts`",
  pinned by a loop test.~~ **Resolved: the claim was false.** No such file exists and the constant is
  not duplicated anywhere; the `plans` settings block moved into this package
  (`packages/plan/src/settings.ts`) and the kernel imports the constant rather than restating it. The
  remark now says so (`packages/plan/src/schemas.ts`). The genuinely-duplicated value with
  a drift test is `pending_task_nudges`, pinned at
  `packages/plan/tests/component/plan-session.test.ts`.
- ~~`messages.ts` linked to `../plans/task-port.ts` and `../subagents/lead-tools.ts`.~~ **Resolved.**
  `PlanDelegationPort` is linked at its real path, `./task-port.ts`
  (`packages/plan/src/capability/messages.ts`); `buildDelegateTaskTool` lives in `@clarvis/loop`
  and is now named in prose rather than through a `{@link}` this package cannot resolve, since it
  must not import the loop.

**Capability ordering and the loop-side dependency boundary are pinned.** The loop owns both tests:
`packages/loop/tests/unit/capability-dispatch-order.test.ts` asserts that a plans-shaped
`order: -100` sorts ahead of default-order capabilities, while
`packages/loop/tests/architecture/no-feature-names.test.ts` asserts that the engine neither
declares nor names `@clarvis/plan`. The within-contribution ordering remains separately pinned by
`packages/plan/tests/component/plan-orchestration.test.ts`, which reads `handlers[0]`
deliberately.

**`PLAN_REVIEW_ELICIT_KIND` has one owner and one pinned duplicate.** The constant is declared in
`@clarvis/capability` (`packages/capability/src/elicit.ts`, exported at
`packages/capability/src/index.ts`) and read here (`packages/plan/src/capability/review-gate.ts`).
`@clarvis/code` cannot import it — it depends on `@clarvis/kernel`, `@clarvis/protocol` and
`@clarvis/paths` only — so it declares its own at
`packages/code/src/adapters/elicit-types.ts` and uses that at
`packages/code/src/adapters/elicitation.ts` and `packages/code/src/views/ElicitBlock.tsx`.
`packages/kernel/tests/architecture/elicit-kind.test.ts` pins the two together, and pins both against
the elicit `kind` unions in `@clarvis/protocol`, `@clarvis/capability` and `@clarvis/code`.

**The review gate's construction can silently no-op.** `buildPlanReviewAsk` is built only when
`review && scope.elicit !== undefined && scope.clock !== undefined` (`packages/plan/src/capability/index.ts`); when it is
absent, `buildPlansOrchestration` computes
`const planReview = deps.planReviewAsk !== undefined` → `false` (`packages/plan/src/capability/orchestration.ts`), so the
blocker and gate stand down entirely. In practice the loop
refuses such a run first — `packages/loop/src/runtime/execute-run.ts` throws
`ValidationError("elicitation_not_supported", …)` when a capability needs the human and no elicit
exists — but **nothing in `@clarvis/plan` closes this**, and no test in the plan package covers a
`review` run built without an elicit. Whether the plan package intends to rely on the loop's check is
not recorded in the source.

**Whether contributed trace kinds persist.** `plan_review`, `task_nudge` and the capability's
`tool_call`/`terminate` records go through `bc.trace`, and the capability declares no
`persistedTraceProjectors` (`packages/plan/src/capability/index.ts` has no such member;
contract at `packages/capability/src/contract.ts`). What the trace store does with a contributed
kind that has no projector is a **@clarvis/trace** question this document leaves unresolved.

**Rationale for the numeric constants.** `MAX_PLAN_REVIEW_REVISIONS = 10`
(`packages/plan/src/capability/orchestration.ts`), `MAX_PLAN_BATCH_OPERATIONS = 128` (`packages/plan/src/limits.ts`) and
`DEFAULT_PENDING_TASK_NUDGES = 3` (`packages/capability/src/env.ts`) carry no stated derivation in
the code or in any test message.

**`plan_review`'s `revision_index` semantics at the first presentation.** `recordPlanReview` stamps
`session.planReviewRevision` (`packages/plan/src/capability/orchestration.ts`), which is incremented *after* a
`request_changes` (`packages/plan/src/capability/orchestration.ts`). So `presented` and `approved` on the first round both
carry `0`. No test asserts the field's value, so whether that is the intended indexing is
undetermined.

## Historical publication invariant

Plan publication retains its per-iteration frequency. Every header is appended; unchanged bodies
remain at their original positions, and changed bodies append. The latest reminder describes
current state. Historical CAS values cannot authorize stale writes, and human review remains bound
to the current store revision. Compaction retains current state through the capability anchor.
Production: [`buildPlansOrchestration`](../../packages/plan/src/capability/orchestration.ts) and
[`planCasHeader`](../../packages/plan/src/capability/canonical-state.ts).
Test: [`prompt-cache-composition.test.ts`](../../packages/kernel/tests/integration/prompt-cache-composition.test.ts)
uses real kernel/loop/SDK composition, external mutation, stale CAS and persisted replay.
