# The planning capability: sessions, review gate, tools and retention policy

> Implemented at `packages/plan/src/capability/**`, `packages/plan/src/tools.ts`,
> `packages/plan/src/settings.ts`, `packages/kernel/src/plans/**` and
> `packages/kernel/src/runs/plan-ref.ts`. Every claim below is anchored to a file and line. Open
> questions are collected in the final section.

---

## 1. Purpose

`@clarvis/plan/capability` packages file-backed execution planning as a loop **capability** — an
object satisfying `Capability` from `@clarvis/capability` that a host registers, rather than
something the engine knows about. `createPlansCapability(options)` returns that object
(`packages/plan/src/capability/index.ts:144`), and its entry file states the constraint that shapes
the whole module: "This entry must never import `@clarvis/loop`"
(`packages/plan/src/capability/index.ts:10`). The package's manifest carries only
`@clarvis/capability`, `@clarvis/paths`, `yaml` and `zod`
(`packages/plan/package.json` dependencies block), and every module under `src/capability/` imports
from `@clarvis/capability` or from sibling `../*.ts` files only.

What the capability contributes to a run is: five model-facing plan tools, a **review blocker**
(a `ToolHandler` that refuses workspace-changing calls until a human approves a plan), two
**finalize gates** (the review gate and the open-task pending gate), a **compaction anchor** and a
`beforeIteration` hook that republishes the plan as canonical context, and a **task port** that the
delegation capability consults — all assembled by `buildPlansOrchestration`
(`packages/plan/src/capability/orchestration.ts:280`). It also owns the run's `PlanSession`
(`packages/plan/src/capability/session.ts:146`), the run-lifetime object that mediates every read and
compare-and-swap write against the plan store.

The second half of the story is policy ownership. The `plans` block is a `CapabilitySettingsSpec`
shipped by the package itself (`packages/plan/src/settings.ts:86`) and registered by the kernel at
module load (`packages/kernel/src/config/capability-registry.ts:23`), so the engine can validate a
`plans` key it has never heard of. `mode` (`off`/`on`/`review`) and `retention` (`keep`/`discard`)
are settings a user authors; there is no agent grant that turns review off. The default retention is
`keep` (`packages/plan/src/schemas.ts:46`, `packages/plan/src/settings.ts:24`) and a `discard` plan is
deleted only in `onRunEnd`, only on a `completed` record
(`packages/plan/src/capability/index.ts:296`).

That claim is about grants, not about every path into `mode`: a trusted plugin can still declare
`capabilityRunPolicies.plans.skills[skill]` (`packages/capability/src/capability-run-policies.ts:9-14`)
for a skill it packages, and when a run is entered through that skill *and* the operator has selected
that same plugin as the Plans provider, the kernel folds the declared mode over the settings block's
`mode` for that one run — `skillPlansMode` (`packages/kernel/src/file-kernel.ts:629-639`,
`packages/kernel/src/plugins/plugin-contributions.ts:738-744`) is read in the settings assembler
(`packages/kernel/src/runs/settings-assembler.ts:399-406,491-506`) and only ever loses to an explicit
`plans` param on the run request itself, never to the settings block. This bypasses `pluginContributable:
false` on `plansSettingsSpec` (`packages/plan/src/settings.ts:90`) entirely, because it never goes
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
| `@clarvis/plan` (root) | `packages/plan/src/index.ts` | tool-name constants + `planToolDefinitions` + `revisePlanInputSchema` (`:115`–`:123`), `PlanService` (`:105`), `PLANS_CAPABILITY_NAME` (`:95`), `PlanRef` (`:103`) |

The `"./capability"` and `"./settings"` conditions are declared in `packages/plan/package.json`.

### 2.2 `createPlansCapability`

```ts
export function createPlansCapability(options: PlansCapabilityOptions): Capability
```
(`packages/plan/src/capability/index.ts:144`)

`PlansCapabilityOptions` (`packages/plan/src/capability/index.ts:82`):

| Field | Type | Meaning |
| --- | --- | --- |
| `factory` | `PlanFactory` | settings-sensitive, owner-scoped store resolver (`packages/plan/src/provider.ts:39`) |
| `defaultPendingTaskNudges` | `number` | fallback nudge budget when the request's `plans` block sets none (`:85`) |
| `defaultElicitWaitMs` | `number` | fallback human-wait bound for the review gate (`:87`) |
| `logger?` | `Logger` | resolved to `NOOP_LOGGER` once per capability (`:145`) |

`PlanFactory`/`createPlanFactory` (`packages/plan/src/provider.ts`) memoize one store resolution per
owner and select the provider (Markdown, a direct executable, or a plugin-hosted one). This
mechanism is pinned by `packages/plan/tests/component/provider.test.ts`, an in-scope file otherwise
undiscussed here: `storeFor` memoizes per owner and a second call for the same owner returns the
same store (`:8`–`22`); `evictOwner` drops one owner's resolution without touching a peer's
(`:24`–`42`); a direct executable provider runs from the workspace with raw argv (`:44`–`55`); a
plugin provider runs from the plugin's own root and cannot select itself (`:57`–`78`); a plugin
revision change rebuilds the session adapter while `key` (the provider identity) stays stable
(`:80`–`106`); and an unavailable executable provider throws `PlanProviderUnavailableError` rather
than silently falling back to Markdown (`:108`–`121`). The document format and digest machinery
`PlanFactory` sits beside remain delegated to **plan-document-and-store** (§7.4).

The returned `Capability` declares:

| Member | Value | Line |
| --- | --- | --- |
| `name` | `PLANS_CAPABILITY_NAME` = `"plans"` | `packages/plan/src/capability/index.ts:147`, `packages/plan/src/schemas.ts:234` |
| `reservedWireNames` | the five tool wire names, derived from `buildPlanRuntimeTools(false)` | `packages/plan/src/capability/index.ts:61`–`64`, `:148` |
| `toolEffects` | `read` for `read_plan`/`list_plans`, `mutate` for the other three | `packages/plan/src/capability/index.ts:65`–`74`, `:149` |
| `requiresUserInput(view)` | `true` iff the request's `plans` mode is `"review"` | `packages/plan/src/capability/index.ts:150` |
| `forRun(ctx)` | `RunCapability \| null` — `null` when mode is `off` | `packages/plan/src/capability/index.ts:151`–`153` |

The `RunCapability` it returns declares `order: -100` (`packages/plan/src/capability/index.ts:232`), `guardTripCodes:
["plan_review_unreviewed", "plan_review_revision_limit", "pending_tasks_unfinished"]`
(`packages/plan/src/capability/index.ts:262`–`266`), `forAgent` (entry-agent only, `packages/plan/src/capability/index.ts:267`–`276`), `finalizeRun`
(`packages/plan/src/capability/index.ts:277`), `onRunEnd` (`packages/plan/src/capability/index.ts:294`), and a one-element `lifecycle` array carrying
`onRunStart` — present **only** when the run continues a plan (`packages/plan/src/capability/index.ts:233`–`261`).

### 2.3 Model-facing tools

The five names live in `packages/plan/src/tools.ts:2`–`:10`; the JSON-Schema definitions are
`planToolDefinitions` (`packages/plan/src/tools.ts:74`). `buildPlanRuntimeTools(planReview)` adapts
them to `NamespacedTool` with identity wire/mcp/tool names and an empty MCP namespace
(`packages/plan/src/capability/runtime-tools.ts:78`).

| Wire name | Effect | Advertised input (JSON-Schema) | Runtime validation (zod) |
| --- | --- | --- | --- |
| `create_plan` | `mutate` | `title`, `objective`, `context?`, `tasks[]{title,detail?,exit?}`, `validation[]`, `retention?` — required `title/objective/tasks/validation` (`packages/plan/src/tools.ts:83`–`109`) | `createInputSchema` (`packages/plan/src/capability/runtime-tools.ts:95`) |
| `read_plan` | `read` | `{ id?: string }` (`packages/plan/src/tools.ts:116`) | `readInputSchema` (`packages/plan/src/capability/runtime-tools.ts:113`) |
| `list_plans` | `read` | `cursor?`, `limit?` 1–100, `status?`, `retention?` (`packages/plan/src/tools.ts:124`) | `listInputSchema` (`packages/plan/src/capability/runtime-tools.ts:114`) |
| `revise_plan` | `mutate` | CAS triple + `operations[]` (8-member `oneOf`) (`packages/plan/src/tools.ts:143`–`243`) | `revisePlanInputSchema` (`packages/plan/src/tools.ts:40`) |
| `transition_plan_task` | `mutate` | CAS triple + `transitions[]{task_id,status,result?,error?,reason?,assignee?}` (`packages/plan/src/tools.ts:255`–`280`) | `transitionInputSchema` (`packages/plan/src/capability/runtime-tools.ts:144`) |

`create_plan`'s description gains `CREATE_PLAN_REVIEW_NOTE` when the run is under review
(`packages/plan/src/capability/runtime-tools.ts:59`, applied at `:85`–`:87`). It is the **only** description that varies with run
configuration. Its TSDoc states the measured incident it exists for: "Two failures were measured
against the same prompt and profile: one model wrote three files before the finalize gate told it a
plan was required, and the other planned first but, not knowing the runtime would present the plan,
asked the human for approval itself with `ask_user` — so the human was asked twice, seconds apart,
about the same plan" (`packages/plan/src/capability/runtime-tools.ts:49`–`54`).

The CAS triple is `expected_revision` (positive int), `expected_digest` (1–256 chars),
`expected_spec_digest` (1–256 chars) (`packages/plan/src/capability/runtime-tools.ts:120`–`124`).

Both batch tools accept a singular form and normalise it:
`revisePlanInputSchema` refuses a payload carrying **both** `operation` and `operations`, or neither
(`packages/plan/src/tools.ts:52`–`54`); `transitionInputSchema` accepts a flat single `task_id`+`status` beside the CAS
fields and folds it into a one-element `transitions` array (`packages/plan/src/capability/runtime-tools.ts:144`–`161`).

### 2.4 Settings and request param

`PLANS_DEFAULTS` (`packages/plan/src/settings.ts:22`):

```ts
{ mode: "on", retention: "keep", pending_task_nudges: 3 }
```

| Schema | Shape | Line |
| --- | --- | --- |
| `plansConfigSchema` (settings.json block) | `.strict()` object: `mode` (default `"on"`), `retention` (default `"keep"`), `pending_task_nudges` (int ≥ 0, default 3), `provider?` | `packages/plan/src/settings.ts:37`–`44` |
| `plansRunConfigSchema` (request-visible subset) | `.strict()` object: `mode` required, `retention?`, `pending_task_nudges?` — **no `provider`** | `packages/plan/src/settings.ts:47`–`53` |
| `plansParamSchema` (the `plans` request param) | `union([plansModeField, plansRunConfigSchema]).optional()` | `packages/plan/src/settings.ts:65` |

`plansSettingsSpec` (`packages/plan/src/settings.ts:86`): `key: "plans"`, `merge: "lastWins"`,
`pluginContributable: false`, `requestParams: { plans: plansParamSchema }`.

### 2.5 The task port

`PLAN_PORT` is an alias for the canonical `TASK_TRACKING_PORT` from `@clarvis/capability`
(`packages/plan/src/capability/task-port.ts:69`, defined at
`packages/capability/src/task-tracking-port.ts:66`). `PlanDelegationPort` narrows the neutral
`TaskTrackingPort` with planning's own `PlanTaskStatus` vocabulary
(`packages/plan/src/capability/task-port.ts:27`–`60`). Consumption of that port by
`delegate_task` belongs to the **loop-delegation-and-subagents** document.

`getTask`'s declared return type carries `description?: string` and `exit_condition?: string`
fields (`packages/plan/src/capability/task-port.ts:29`–`39`) that do not match the vocabulary used everywhere else in this
document (`detail`/`exit`, e.g. §2.3, §4.8); the concrete implementation just returns the raw
cached task object (`packages/plan/src/capability/delegation-port.ts:38`–`40`), which never populates those two names. Whether
this is dead/vestigial naming or a discrepancy against the `detail`/`exit` fields is not
determinable from the code read (see §8).

### 2.6 Kernel surface

| Symbol | File | Role |
| --- | --- | --- |
| `createPlanningRuntime(options)` | `packages/kernel/src/plans/planning-runtime.ts:38` | builds `{ capability, planFactory }` from one owner-scoped data plane |
| `createPlansService({ resolve? })` | `packages/kernel/src/plans/plans-service.ts:60` | adapts the domain `PlanService` to the protocol `PlansService` |
| `planRefFromCapabilityState(state)` | `packages/kernel/src/runs/plan-ref.ts:62` | validating reader of the `plans` slot in `ExecutionRecord.capability_state` |

`createPlansService` exposes `list`, `read`, `setRetention`, `delete`
(`packages/kernel/src/plans/plans-service.ts:100`, `:110`, `:121`, `:134`).

Every one of those methods projects the domain `PlanDocument` through `dto()`
(`packages/kernel/src/plans/plans-service.ts:27`–`48`), the only place that happens. Two of its fields are not stored values:
`markdown` is always freshly `renderPlan(plan)`-ed rather than read from disk, and
`approved_spec_revision` is included only when the document actually has one set — both per the
function's own TSDoc (`packages/kernel/src/plans/plans-service.ts:21`–`25`).

---

## 3. Data and formats

### 3.1 `PlanRef` — what the capability files on the run record

`finalizeRun` returns a `PlanRef` and the engine files it under `capability_state["plans"]`
(`packages/plan/src/capability/index.ts:277`–`293`; contract at
`packages/capability/src/contract.ts:283`). The interface
(`packages/plan/src/schemas.ts:213`–`224`):

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

It is built by `PlanSession.ref()` (`packages/plan/src/capability/session.ts:538`–`565`). When the plan disappeared mid-run the
ref is built from the tombstone instead, with `status` falling back through
`missing.document?.status ?? initial?.status ?? "failed"` and `retention` through
`missing.document?.retention ?? initial?.retention ?? this.#retention ?? DEFAULT_PLAN_RETENTION`
(`packages/plan/src/capability/session.ts:540`–`554`).

The kernel re-validates the slot rather than casting: `isPlanRef` type-guards every required field,
constrains `status` and `retention` to their literal sets, and admits `path` only as a string
(`packages/kernel/src/runs/plan-ref.ts:24`–`38`). Its TSDoc states the reason: `capability_state` is
opaque to the engine and the trace store, "so an unchecked cast at this boundary would let a
malformed or absent slot masquerade as a `PlanRef`" (`packages/kernel/src/runs/plan-ref.ts:53`–`57`).

### 3.2 `MissingPlanState`

`MissingPlanState` is the tombstone of a plan whose backing record disappeared
(`packages/plan/src/capability/session.ts:62`–`68`): `{ id, path?, revision, specRevision, document? }`.

The session publishes no other view of its own state — there is no snapshot accessor. Two one-line
readers reach the tombstone: `missing()` returns the durable one
(`packages/plan/src/capability/session.ts:177`–`179`), and `takeRemoval()` consumes the one-shot removal
projection the runtime turns into `plan_removed` (`packages/plan/src/capability/session.ts:185`–`189`),
leaving `missing()` intact.

### 3.3 Capability events

Five `CapabilityEvent` kinds are emitted, always wrapped in `projected(...)` so they carry a wire
projection (`packages/capability/src/contract.ts:354`; unwrapped events "stay internal", `:352`).

| Kind | Emitted at | Detail |
| --- | --- | --- |
| `plan_created` | `packages/plan/src/capability/orchestration.ts:662`–`671` (on a `create_plan` call) | `planProjection(document)` |
| `plan_updated` | `packages/plan/src/capability/orchestration.ts:662`–`671`; also `packages/plan/src/capability/index.ts:252` (`change: "recovery"`), `packages/plan/src/capability/index.ts:284` (`change: "status"`), `packages/plan/src/capability/orchestration.ts:681` (task-port writes) | `{ change, ...planProjection(document) }` |
| `plan_removed` | `packages/plan/src/capability/index.ts:242` (run start), `packages/plan/src/capability/index.ts:316` (retention discard), `packages/plan/src/capability/orchestration.ts:651`–`652` (a tool call discovered the removal) | `removedPlanProjection(missing)` or a flat id/path/revision/spec_revision object |
| `plan_review_requested` | `packages/plan/src/capability/orchestration.ts` (`presentPlanReviewGate`, `plan_review_requested` branch) | `planProjection(presented)` |
| `plan_review_resolved` | `packages/plan/src/capability/orchestration.ts` (`presentPlanReviewGate`, approval, change-request, and cancellation branches) | `{ outcome: "approved" \| "changes_requested" \| "cancelled", ...planProjection }` |

`planProjection` (`packages/plan/src/capability/orchestration.ts:82`) carries `id`, optional `path`, `title`, `status`,
`retention`, `revision`, `spec_revision`, `objective`, `context`, `validation`, and tasks reduced to
`id`/`title`/`status` plus only the present optional fields.

The kernel's `capabilityEventToProto` validates the detail against a **closed** projection schema
(`packages/kernel/src/runs/map-events.ts:110`–`121`) that deliberately `.strip()`s the extra fields:
"Internal plan events also carry objective/context fields. Stripping them here avoids either widening
the closed protocol DTO or rejecting an otherwise valid plan update"
(`packages/kernel/src/runs/map-events.ts:104`–`108`). The protocol `PlanProjection` therefore has no `objective`/`context`/
`validation` (`packages/protocol/src/runs.ts:269`–`285`).

All five map to `live("capability", ["capability_channel"])` in the kernel's event policy
(`packages/kernel/src/runs/event-policy.ts:78`–`82`) — i.e. none is persisted to the engine trace.

`PlanUpdateChange` has four members — `content`, `task`, `status`, `recovery`
(`packages/protocol/src/runs.ts:271`, mirrored at `packages/kernel/src/runs/map-events.ts:122`),
exactly the set this capability produces. It carried three more — `approval`, `retention`,
`external_edit` — that nothing ever emitted; they have been removed from both.

### 3.4 Trace entries

The capability writes four **contributed** trace kinds through the agent build context's
`TracePort`:

| Kind | Detail | Site |
| --- | --- | --- |
| `tool_call` | `{ agent: "lead", iteration_ref, started_at, ended_at, name, arguments, result, error, call_id? }` | `packages/plan/src/capability/orchestration.ts:640`–`642` |
| `plan_review` | `{ outcome, revision_index }` — `PlanReviewDetail` | `packages/plan/src/capability/orchestration.ts:326`; type at `packages/capability/src/trace-kinds.ts:391` |
| `task_nudge` | `{ outcome, pending_task_ids, nudge_index, progressed }` — `TaskNudgeDetail` | `packages/plan/src/capability/orchestration.ts:479`, `:487`; type at `packages/capability/src/trace-kinds.ts:410` |
| `terminate` | `{ reason }` — one of `plan_review_revision_limit`, `plan_review_cancelled`, `plan_review_unreviewed`, `pending_tasks_unfinished` | `packages/plan/src/capability/orchestration.ts:400`, `:429`, `:437`, `:447` |

`plan_review` and `task_nudge` are declared in `@clarvis/capability` but deliberately excluded from
`BUILTIN_TRACE_KINDS` (`packages/capability/src/trace-kinds.ts:11`–`47`); the declaring comment says "`plan_review` is a
kind the planning capability records, not one the engine does" (`packages/capability/src/trace-kinds.ts:386`–`388`).

The trace record on a plan tool call is load-bearing rather than decorative: the TSDoc says plan
calls "reached the trace" through no dispatcher, so "`create_plan` and `transition_plan_task` were
absent from the persisted trace entirely while being present in the run's own context"
(`packages/plan/src/capability/orchestration.ts:626`). Pinned by
`packages/plan/tests/component/plan-orchestration.test.ts:287`–`301`.

### 3.5 Tool result payloads

Every mutating tool's result carries the **next** CAS triple, so consecutive writes need no
intervening `read_plan` (`packages/plan/src/capability/runtime-tools.ts:180`–`201`). The wire string is
`` `Tool '${name}' result: ${JSON.stringify(payload)}` `` on success and
`` `Tool '${name}' result (error): ${message}` `` on failure (`packages/plan/src/capability/runtime-tools.ts:205`, `:214`).

| Tool | Payload |
| --- | --- |
| `create_plan` | `{ ...cas, task_ids: [...] }` (`packages/plan/src/capability/runtime-tools.ts:286`–`289`) |
| `read_plan` | the document, or `null` (`:295`) |
| `list_plans` | the store's `PlanListResult` (`:299`) |
| `revise_plan` | `cas(document)` (`:312`) |
| `transition_plan_task` | `{ ...cas, tasks: [only the tasks this call moved] }` (`:338`–`:343`) |

Real example from the integration test — a plan file created mid-run at
`.clarvis/plans/<yyyy-MM-ddTHH-mm-ss>-audit-the-auth-flow.md`, whose filename shape is asserted by
`/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-audit-the-auth-flow\.md$/`
(`packages/plan/tests/integration/planned-run-file.test.ts:186`). Document layout and the digest
algorithm belong to the **plan-document-and-store** document.

### 3.6 Elicitation payload

`buildPlanReviewElicitParams()` (`packages/plan/src/capability/review-gate.ts:50`) produces:

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

Order of operations in `packages/plan/src/capability/index.ts:151`–`228`:

1. `readPlansSettings(ctx.requestParam("plans"))` parses the param with this capability's own schema
   (`:117`–`:129`). A parse failure or an absent value yields `{ mode: PLANS_DEFAULTS.mode }` — i.e.
   `"on"` (`:119`).
2. `mode === "off"` → return `null` immediately, **before** any provider resolution (`:153`).
3. Bind the logger with `execution_id` (`:155`).
4. `await options.factory.storeFor(ctx.owner)` (`:156`).
5. Reconcile the continuation ref against the resolved provider key (`:159`–`167`):
   - no prior ref, or matching `provider_key` → carry it forward;
   - mismatched key and prior `status === "completed"` → drop it (`undefined`);
   - mismatched key otherwise → **throw** `PlanProviderMismatchError` (`packages/plan/src/provider.ts:60`).
6. `elicitWaitMs = ctx.request.elicit_wait_ms ?? options.defaultElicitWaitMs` (`:168`).
7. Construct one `PlanSession` for the whole run (`:169`–`177`).
8. Publish the task-port provider on `ctx.services` under `PLAN_PORT` (`:216`–`228`).

### 4.2 Agent attachment

`forAgent(scope)` returns `null` for any non-entry agent (`packages/plan/src/capability/index.ts:268`), so sub-agents never get
plan tools. For the entry agent, `attach(bc)` memoizes one orchestration per `AgentBuildContext` in a
`WeakMap` (`packages/plan/src/capability/index.ts:185`, `:188`–`212`) and returns that
contribution unchanged (`packages/plan/src/capability/index.ts:273`). It used to carry
`advertised: false`, meaning "stay out of `availableWireNames`"
(`packages/capability/src/contract.ts:322`–`326`) — but that field is consulted only when
`mcpFullToolset !== true`, and the lead persona, the only persona this capability attaches to, sets
it `true` (`packages/loop/src/runtime/subagents/build-lead-input.ts:62`). The flag could never act,
and has been removed.

The review ask is built only when all three of `review`, `scope.elicit` and `scope.clock` are present
(`packages/plan/src/capability/index.ts:191`–`194`).

### 4.3 The contribution

`buildPlansOrchestration` returns (`packages/plan/src/capability/orchestration.ts:715`–`731`):

```
tools:    the five plan tools
handlers: [ reviewBlocker, createPlanHandler, readPlanHandler, listPlansHandler,
            revisePlanHandler, transitionPlanTaskHandler ]
gates:    [ reviewGate, pendingGate ]
anchor:   () => "Current plan" | "Plan unavailable" | undefined
hooks:    { beforeIteration, contributesProgress }
```

`reviewBlocker` is **first** by construction (`packages/plan/src/capability/orchestration.ts:720`), which is what the gating test
relies on when it reads `handlers[0]` rather than using `find`
(`packages/plan/tests/component/plan-orchestration.test.ts:645`–`651`).

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
TSDoc names that explicitly (`packages/plan/src/capability/orchestration.ts:562`–`563`), and the tests pin it: an MCP-shaped name
is blocked (`packages/plan/tests/component/plan-orchestration.test.ts:769`–`772`), `run_leader`/`run_work_items` are blocked while
the in-run `spawn_subagent` and `delegate_task` tools (classified `control`) are not
(`packages/plan/tests/component/plan-orchestration.test.ts`, review-blocker cases).

When no `ToolEffectPort` is on the registry, `forRun` substitutes `{ effect: () => "unknown" }`
(`packages/plan/src/capability/index.ts:205`), so an unclassified tool is refused during review
(`packages/plan/tests/component/plan-capability-gating.test.ts:368`–`381`).

Three distinct refusal texts, chosen by `refusalFor`
(`packages/plan/src/capability/orchestration.ts`, `refusalFor`):

| Situation | Message | Line |
| --- | --- | --- |
| effect is `spawn_run` | `planReviewSpawnBlock(tool)` — "starts an independent run whose own tools this gate does not bound" | `packages/plan/src/capability/messages.ts:52` |
| phase `unplanned` | `planReviewUnplannedBlock(tool)` — names the read-only tools and `create_plan` | `packages/plan/src/capability/messages.ts:29` |
| phase `awaiting` | `PLAN_REVIEW_AWAITING_APPROVAL_BLOCK` | `packages/plan/src/capability/messages.ts:67` |

The verdict is always `{ kind: "result", text: "Tool '<name>' result: <refusal>", progress: false }`
(`packages/plan/src/capability/orchestration.ts`, `reviewBlocker.handle`).

`planReviewUnplannedBlock`'s TSDoc states the measured incident that made this the first place the
review contract reaches the model: "the requirement was stated only inside `delegate_task`'s
description, so a Lead that did the work itself learned of it from `PLAN_REVIEW_BYPASS_NOTE` — at
the *finalize* attempt, with the job already done. One measured run wrote three files and ran two
commands before anything spoke, then authored a plan titled '(completed)' describing work already
shipped, and a human 'approved' a fait accompli" (`packages/plan/src/capability/messages.ts:18`–`24`).

### 4.5 The review gate

`reviewGate.check(attempt)` (`packages/plan/src/capability/orchestration.ts:498`–`520`), in order:

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

`fastAcceptOk()` is `!planReview || isPlanApproved()` (`packages/plan/src/capability/orchestration.ts:497`).

`planReviewRejectionNote` (`packages/plan/src/capability/orchestration.ts`, `planReviewRejectionNote`) composes a submit attempt's rejection text
from the exported `planNotApprovedRejection(feedback, retry)` (`packages/plan/src/capability/review-gate.ts:32`–`39`) with
`retry = "submit_result again"`; a `text`-mode attempt gets a different, inline rejection sentence
instead. The same `planNotApprovedRejection` is the one `beforeSpawn`'s delegation refusal composes
from too, with `retry = "spawn sub-agents again"` — see §4.14.

`presentPlanReviewGate()` (`packages/plan/src/capability/orchestration.ts:354`–`426`) reconciles, emits
`plan_review_requested`, records `plan_review: presented`, then calls the ask:

| Decision | Effect |
| --- | --- |
| `approve` | `planSession.approve()`, emit `plan_review_resolved{approved}`, record `approved`, return `{kind:"approved"}` |
| `request_changes` | emit `plan_review_resolved{changes_requested}`, `planReviewRevision += 1`, record `changes_requested`; if the counter now exceeds `MAX_PLAN_REVIEW_REVISIONS` (10, `packages/plan/src/capability/orchestration.ts:70`) → `terminal` `plan_review_revision_limit` with `renderPlan(...)` as `partialText`; else `{kind:"revise", feedback?}` |
| `cancel` / `no_human` | record `cancelled` or `no_human_fallback`, emit `plan_review_resolved{cancelled}`, `trace.record("terminate", {reason:"plan_review_cancelled"})`, `terminal` with `status: "cancelled"` |

An **exception** thrown by the ask is re-checked against `bc.maybeCancelled()`: a cancelled run
returns that result as `terminal`, otherwise the error propagates
(`packages/plan/src/capability/orchestration.ts`, `presentPlanReviewGate`'s `planReviewAsk` error branch; both branches pinned at
`packages/plan/tests/component/plan-orchestration.test.ts:397`–`428`).

**Rejection is keyed by spec digest, not by iteration.** `recordRejection` stores
`planSession.cached()?.spec_digest` (`packages/plan/src/capability/orchestration.ts`, `recordRejection`) and `isRejectedAtCurrentSpec`
compares against the live one (`packages/plan/src/capability/orchestration.ts`, `isRejectedAtCurrentSpec`). The TSDoc states the failure this
replaced: "Holding it per iteration re-asked the human to approve a byte-identical plan on every
subsequent finalize attempt" (`packages/plan/src/capability/orchestration.ts`, `SessionState.rejectedSpecDigest` contract). Pinned:
`packages/plan/tests/component/plan-orchestration.test.ts:576`–`606` asks once across three retries and a second time only after a
real revision.

### 4.6 The pending-task gate

`pendingGate` (`packages/plan/src/capability/orchestration.ts:531`–`540`) delegates to `pendingTaskGate()`
(`packages/plan/src/capability/orchestration.ts:465`–`486`):

| # | Condition | Outcome |
| --- | --- | --- |
| 1 | `pendingNudgeCap === 0` | `ok` |
| 2 | no open task | `ok` |
| 3 | progress made — every open id was spawned this batch, **or** the open count fell below `lastNudgeOpenCount` | `pendingStall = 0`, fall through |
| 4 | `pendingStall < pendingNudgeCap` | increment stall/total, set `lastNudgeOpenCount`, record `task_nudge{nudged}`, return `nudge` with `PENDING_TASKS_NOTE(ids)` |
| 5 | otherwise | record `task_nudge{terminated}`, `terminal` `pending_tasks_unfinished` |

`fastAcceptOk()` is `false` only when the cap is positive **and** some task is neither `done` nor
`abandoned` (`packages/plan/src/capability/orchestration.ts`, `pendingGate.fastAcceptOk`); all three arms are pinned at
`packages/plan/tests/component/plan-orchestration.test.ts:826`–`853`.

### 4.7 Per-iteration and per-session state

`SessionState` persists across iterations (`packages/plan/src/capability/orchestration.ts:219`); `IterState` is rebuilt
each `beforeIteration` by `freshIter()` (`packages/plan/src/capability/orchestration.ts:253`).

`hooks.beforeIteration` does exactly two things: reset `iter` and call `publishPlanContext()`
(`packages/plan/src/capability/orchestration.ts`, `hooks.beforeIteration` and `publishPlanContext`). `publishPlanContext` sets the stable block `plan_document` to
`planSpecBlock(document)` and the canonical state to `planCasHeader(document, planReview)`; with no
cached document it publishes the missing-plan tombstone instead, or nothing when there is neither
(`packages/plan/src/capability/orchestration.ts:312`–`315`).

`hooks.contributesProgress()` is `iter.planContentChanged || iter.planReviewChangeRequested`
(`packages/plan/src/capability/orchestration.ts:736`). `planReviewChangeRequested` is set only inside `recordRejection`
(`packages/plan/src/capability/orchestration.ts:351`) — i.e. only when the human was actually asked and answered, never when a
retry was turned away against an unchanged plan (`packages/plan/src/capability/orchestration.ts`, `IterState.planReviewChangeRequested` contract, pinned at
`packages/plan/tests/component/plan-orchestration.test.ts:607`–`629`).

### 4.8 The canonical-state split

Two halves, deliberately separated by cost:

| Half | Function | Contents | Republished |
| --- | --- | --- | --- |
| volatile header | `planCasHeader(document, reviewRequired)` (`packages/plan/src/capability/canonical-state.ts:76`) | plan file path, the CAS triple, the approval line, open tasks, **all** task statuses | end of transcript, every iteration |
| stable spec block | `planSpecBlock(document)` (`packages/plan/src/capability/canonical-state.ts:117`) | objective, context, per-task `id`/`title`/`detail`/`exit`, validation | appended only when the substance changes |

The block's field set "deliberately mirrors `@clarvis/plan`'s `specDigest` … so these bytes change if
and only if `spec_revision` does" (`packages/plan/src/capability/canonical-state.ts:103`–`106`). Pinned:
`packages/plan/tests/unit/plan-canonical-state.test.ts:78`–`90` asserts `planSpecBlock` is byte-identical across two task
transitions while `revision` grows.

`approvalLine` is keyed on the **run**, not on `document.status`
(`packages/plan/src/capability/canonical-state.ts:165`–`177`), returning one of three sentences. Its TSDoc says deriving from
status alone "can state the exact opposite of what the runtime enforces"
(`packages/plan/src/capability/canonical-state.ts:158`–`163`); the four cases are pinned at
`packages/plan/tests/unit/plan-canonical-state.test.ts:154`–`185`.

The tombstone case has its own parallel pair, `missingPlanHeader`/`missingPlanSpecBlock`
(composed by `missingPlanCanonicalState`, `packages/plan/src/capability/canonical-state.ts:33`–`58`), which
`publishPlanContext` (`packages/plan/src/capability/orchestration.ts:312`–`315`) and `anchor()` (`packages/plan/src/capability/orchestration.ts:722`)
switch to in place of the live pair once the plan is gone. Their content carries a safety
instruction the live header never needs: "Do not reuse any earlier expected_revision,
expected_digest or expected_spec_digest values" (`packages/plan/src/capability/canonical-state.ts:43`), because the tombstone
supersedes every earlier copy of the plan the model may still be holding CAS values from.

`anchor()` returns `{ label: "Current plan", body: planCanonicalState(document, planReview) }`,
or `{ label: "Plan unavailable", … }` for a tombstone, or `undefined`
(`packages/plan/src/capability/orchestration.ts:722`).

### 4.9 `PlanSession.reconcile` — the continuation path

First call only (`packages/plan/src/capability/session.ts:222`–`281`):

| Condition | Effect |
| --- | --- |
| no `initialRef` | return `undefined` |
| read succeeds, `isPlanSealed(loaded)` | return it **verbatim** — no reset (`packages/plan/src/capability/session.ts:228`) |
| any `in_progress` task, or `status !== "active"`, or a stale approval | rewrite: `in_progress → pending`, `status = "active"`, clear `approved_spec_revision` when stale; log `plan.continuation.reset` with `tasks_reset`, `status_from`, `stale_approval_cleared` (`packages/plan/src/capability/session.ts:229`–`253`) |
| `PlanNotFoundError` + ref `status === "completed"` + `retention === "discard"` | log `plan.continuation.absent` at `debug`, return `undefined` (`packages/plan/src/capability/session.ts:256`–`270`) |
| `PlanNotFoundError` otherwise | `#markMissing` from the ref, return `undefined` (`packages/plan/src/capability/session.ts:271`–`279`) |
| any other error | rethrow (`packages/plan/src/capability/session.ts:280`) |

A "stale approval" is `!review && loaded.approved_spec_revision !== undefined`
(`packages/plan/src/capability/session.ts:231`). Both directions are pinned:
`packages/plan/tests/component/plan-session.test.ts:201`–`240` (dropped under `review: false`) and `:236`–`265` (kept under
`review: true`).

Later calls (`packages/plan/src/capability/session.ts:283`–`310`): `store.reconcile` adopts an external edit; an
`InvalidPlanError` is recorded in `#invalidError` and the last valid document kept; a
`PlanConflictError` triggers a full re-read; a `PlanNotFoundError` (from either) tombstones.

### 4.10 `PlanSession.create` — the one-open-plan rule

`create` (`packages/plan/src/capability/session.ts:331`–`356`):

1. `reconcile()`.
2. If a plan exists and is not sealed:
   - `canCompletePlan(current)` false → throw `ActivePlanExistsError` (`packages/plan/src/capability/session.ts:85`);
   - otherwise **seal it** by setting `status = "completed"` and continue (`packages/plan/src/capability/session.ts:340`–`344`).
3. `retention = input.retention ?? this.#retention` (`packages/plan/src/capability/session.ts:346`).
4. `store.create({ ...input, retention?, createdByRun: executionId, review })`.
5. Clear `#invalidError` and `#missing`.

The bound is on **open** plans, not plans (`packages/plan/src/capability/session.ts:340`, TSDoc `:322`–`:329`). Pinned:
`packages/plan/tests/component/plan-session.test.ts:434`–`457` (one turn finishes a plan and starts the next, sealing the first)
and `:458`–`472` (refused while a task is open).

### 4.11 Mutation guards on the session

| Method | Guard | Line |
| --- | --- | --- |
| `revise` | `#requireMutable()`, then `isPlanSealed` → `PlanSealedError`, then a three-field CAS comparison → `PlanConflictError` | `packages/plan/src/capability/session.ts:415`–`434` |
| `transition` | batch size 1..`MAX_PLAN_BATCH_OPERATIONS` else `RangeError`; `#requireMutable()`; on a sealed plan, any transition to a non-closed status → `PlanSealedError` | `packages/plan/src/capability/session.ts:462`–`489` |
| `transitionCurrent` | supplies `expected` from the freshly reconciled document | `packages/plan/src/capability/session.ts:500`–`503` |
| `approve` | `#requireMutable()`, then `approved_spec_revision = spec_revision`, `status = "active"` | `packages/plan/src/capability/session.ts:511`–`518` |
| `setRetention` | `#requireMutable()` | `packages/plan/src/capability/session.ts:521`–`527` |
| `finalize(status)` | returns the existing ref unchanged when there is no plan, when `#invalidError` is set, or when the plan is sealed | `packages/plan/src/capability/session.ts:582`–`593` |
| `read(id?)` | omitted `id` reconciles and returns the session's own plan; an explicit `id` reads directly, throwing `MissingActivePlanError` immediately if it already matches the cached tombstone, or discovering a **new** tombstone (`#markMissingFromDocument`) and throwing it if the store 404s on an id matching the session's `#lastValid` | `packages/plan/src/capability/session.ts:362`–`376` |

`read(id)`'s explicit-id branch is a distinct tombstone-discovery path from the reconcile-driven one
described throughout §4.9 — no test in this document's scope exercises it (see §8).

`#requireMutable()` throws `InvalidPlanError` on an unparseable document, `MissingActivePlanError`
on a tombstone, and a bare `Error("No active plan")` otherwise (`packages/plan/src/capability/session.ts:602`–`613`).

`revise`'s TSDoc names the reason the seal is re-checked here: this method "does not call"
`PlanStore.revise` — it applies the operation itself and writes through the generic `update`, "so the
store's gate never sees the model's `revise_plan`" (`packages/plan/src/capability/session.ts:410`–`413`).

### 4.12 Tool dispatch

`handlePlanRuntimeCall(name, args, session, logger)` (`packages/plan/src/capability/runtime-tools.ts:272`):

1. For a batch tool, `assertRawArrayLimit` rejects an oversized **raw** array before zod walks every
   element (`packages/plan/src/capability/runtime-tools.ts:245`–`249`, called at `:281`, `:282`, `:302`, `:316`).
2. Parse per tool with zod; dispatch to the session.
3. `withRemoval(session, result)` attaches a one-shot tombstone if the call discovered one
   (`packages/plan/src/capability/runtime-tools.ts:253`–`255`, applied on both the success path `:349` and the catch `:364`).
4. Any throw becomes a failure result — never propagated. If the error's `name` is outside
   `EXPECTED_PLAN_TOOL_ERRORS` (`packages/plan/src/capability/runtime-tools.ts:229`–`241`) it is additionally logged at `error`
   as `plan.tool.unexpected_error` with a `sanitizeErrorMessage`d cause and the stack
   (`packages/plan/src/capability/runtime-tools.ts:353`–`363`). `EXPECTED_PLAN_TOOL_ERRORS` is the closed, 11-member set that
   decides whether a throw is a modelled refusal or an operator-visible defect —
   `ActivePlanExistsError`, `InvalidPlanError`, `MissingActivePlanError`, `PlanConflictError`,
   `PlanNotFoundError`, `PlanNotTerminalError`, `PlanProviderMismatchError`,
   `PlanProviderUnavailableError`, `PlanSealedError`, `RangeError`, `ZodError`
   (`packages/plan/src/capability/runtime-tools.ts:229`–`241`). The TSDoc states the reason: "Anything outside this set reaching
   the catch-all is a defect in Clarvis, not a refusal the model can act on — and the model is
   handed the two in identical shapes" (`packages/plan/src/capability/runtime-tools.ts:224`–`227`).
5. An unrecognised `name` yields `failure(name, Error("Unknown plan tool: …"))` (`:347`).

`planCallHandler` then wraps each dispatch (`packages/plan/src/capability/orchestration.ts:635`–`671`): trace the call, emit
`plan_removed` and republish context if `r.removed`, set `iter.planContentChanged` if `r.changed`,
emit `plan_created`/`plan_updated` if `r.document`. The event kind is `plan_created` only for
`create_plan`; the `change` tag is `content` for `revise_plan` and `task` otherwise
(`packages/plan/src/capability/orchestration.ts:666`–`667`).

### 4.13 Run teardown

Two hooks, in this order (`packages/capability/src/contract.ts:274`–`278` explains why both exist):

1. **`finalizeRun({ status })`** (`packages/plan/src/capability/index.ts:277`–`293`), *before* the record is built.
   Returns `undefined` when no agent ever attached (`liveSession === undefined`, `:278`, pinned at
   `packages/plan/tests/component/plan-capability-gating.test.ts:315`–`319`). Otherwise maps the run status →
   `completed` / `cancelled` / **`failed`** for everything else (`:280`, pinned at
   `packages/plan/tests/component/plan-capability-gating.test.ts:296`–`313`), calls `liveSession.finalize(...)`, emits
   `plan_updated{change:"status"}`, and returns the `PlanRef`.
2. **`onRunEnd(record)`** (`packages/plan/src/capability/index.ts:294`–`328`), *after* the record persists.
   Returns immediately unless `record.status === "completed"` **and** `ref.retention === "discard"`
   (`:296`). Deletes through `bestEffort`, logs `plan.retention.discarded` with `deleted: boolean`
   at `info` either way, and emits `plan_removed` only when a document was actually removed
   (`:298`–`:327`).

The `lifecycle.onRunStart` hook exists only for a continuation (`packages/plan/src/capability/index.ts:234`): it reconciles,
emits `plan_removed` if the continuation plan was gone (and returns), else emits
`plan_updated{change:"recovery"}` (`packages/plan/src/capability/index.ts:238`–`259`). Pinned at
`packages/plan/tests/component/plan-capability-gating.test.ts:239`–`292`.

### 4.14 Delegation port state machine

`createDelegationPlanPort(session, onUpdated?)` (`packages/plan/src/capability/delegation-port.ts:20`) returns a
`Pick<PlanDelegationPort, "reconcile" | "openTasks" | "getTask" | "markSpawned" | "markFailed" |
"markReturned">` (`packages/plan/src/capability/delegation-port.ts:23`–`26`):

| Method | (state) → (state, effect) |
| --- | --- |
| `reconcile()` | delegates straight to `session.reconcile()`; no return value (`:28`–`30`) |
| `openTasks()` | cached tasks not `done`/`abandoned` (`:31`–`37`) |
| `getTask(id)` | cached task by id (`:38`–`40`) |
| `markSpawned(id)` | `in_progress` → `false`; `failed`/`returned` → reset to `pending` first (`recovering = true`); then `pending` → `in_progress`, `onUpdated(doc, recovering ? "recovery" : "task")`, `true`; anything else → `false` (`:41`–`54`) |
| `markFailed(id, error)` | only from `in_progress` → `failed`, `onUpdated(doc,"task")`, `true`; else `false` (`:55`–`61`) |
| `markReturned(id, summary)` | only from `in_progress` → `returned` with `result: summary`, `true`; else `false` (`:62`–`72`) |

`reconcile` is exercised directly by the test fixture's own setup, not just through the other
methods — `packages/plan/tests/component/delegation-plan-port.test.ts:24`, `:34`.

The orchestration layers three more members onto it (`packages/plan/src/capability/orchestration.ts:691`–`705`):

- **`beforeSpawn(taskId)`** first calls `ensurePlanReviewGate()` (`packages/plan/src/capability/orchestration.ts:550`),
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
     (`packages/plan/tests/component/plan-orchestration.test.ts:397`–`408`);
  2. the same throw is swallowed into a terminal `cancelled` result instead, when the run is
     already cancelled (`bc.maybeCancelled()`) — so the gate can itself end the run
     (`packages/plan/tests/component/plan-orchestration.test.ts:410`–`427`);
  3. a spawn is refused while the gate is unresolved, and the ask fires **exactly once** across
     repeated `beforeSpawn` calls in the same iteration — no re-elicit
     (`packages/plan/tests/component/plan-orchestration.test.ts:429`–`453`);
  4. a `request_changes` decision with no feedback still reads back as a rejection, without notes
     (`packages/plan/tests/component/plan-orchestration.test.ts:455`–`469`).
- **`noteSpawned(taskId)`** adds to `iter.spawnedTaskIds`, read back by the pending gate's progress
  test (§4.6).
- **`augmentDelegateTask()`** returns `buildDelegateTaskPlanAugmentation(planReview)`
  (`packages/plan/src/capability/messages.ts`, `buildDelegateTaskPlanAugmentation`): the tracked
  description plus the required `task_id` property. Under review the suffix directs pre-plan
  exploration to `spawn_subagent` and keeps `delegate_task` reserved for an exact existing task.
  A plan therefore adds tracked delegation; independent spawning remains a separate capability.

Both `beforeSpawn`'s rejected-spec refusal and the submit-mode review-gate nudge (`reviewGate.check`,
§4.5) compose their text from the same exported function, `planNotApprovedRejection(feedback,
retry)` (`packages/plan/src/capability/review-gate.ts:32`–`39`): the delegation refusal calls it with `retry = "spawn sub-agents
again"` (`packages/plan/src/capability/orchestration.ts:694`), and `planReviewRejectionNote` calls it with `retry = "submit_result
again"` for a submit attempt (`packages/plan/src/capability/orchestration.ts:130`).

`markReturned` records `returned`, never `done` — pinned with the reason inline at
`packages/plan/tests/component/delegation-plan-port.test.ts:49`–`59`.

### 4.15 Kernel wiring

`createPlanningRuntime` (`packages/kernel/src/plans/planning-runtime.ts:38`) builds one `markdownStoreFor` (or takes the
host's), one `createPlanFactory`, and returns `{ planFactory, capability }` where the capability is
constructed with `env.CLARVIS_DEFAULT_PENDING_TASK_NUDGES` and
`env.CLARVIS_DEFAULT_ELICIT_WAIT_MS` (`packages/kernel/src/plans/planning-runtime.ts:65`–`70`; env defaults 3 and 1 800 000 ms
at `packages/capability/src/env.ts:107`, `:68`).

`file-kernel.ts` composes it with a settings-reading `loadPlanProvider` (`:651`–`657`), a plugin
locator scoped to `PLANS_CAPABILITY_NAME` (`:660`–`667`), and the shared executable port
(`:674`–`681`), then hands `planning.planFactory` to `createInProcessKernel` (`:958`).
`packages/kernel/src/kernel.ts:522` builds the per-owner `PlansService` from
`() => planFactory.storeFor(scope.owner)` — the same factory the capability holds, so a run and the
control plane read one provider store (`packages/plan/src/capability/index.ts:79`–`80`).

`plansBlockToParam` (`packages/kernel/src/runs/settings-assembler.ts:146`–`162`) projects the
settings block onto the request param. `retention` is always **materialized** —
"an absent or malformed value becomes `PLANS_DEFAULTS.retention` rather than being dropped"
(`packages/kernel/src/runs/settings-assembler.ts:138-157`) — and an unrecognized `mode` falls back to the default rather
than disabling planning silently (`:143-149`).

---

## 5. Invariants

Numbered; each carries the production line and the pinning test.

1. **`mode: "off"` resolves no provider.** `forRun` returns `null` before touching
   `options.factory` — `packages/plan/src/capability/index.ts:153`.
   Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts:156`–`174` (`resolutions` stays 0).

2. **`requiresUserInput` is true exactly for `review`,** in both the terse and block forms, and false
   for an unconfigured request — `packages/plan/src/capability/index.ts:150`.
   Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts:139`–`152`.

3. **The reservation is derived from the tools, never spelled twice.**
   `PLAN_TOOL_WIRE_NAMES = buildPlanRuntimeTools(false).map(t => t.wireName)` —
   `packages/plan/src/capability/index.ts:61`–`64`. `toolEffects` is derived from the same array with `read` for exactly
   `read_plan`/`list_plans` — `packages/plan/src/capability/index.ts:65`–`74`.
   Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts:122`–`137` asserts both against the five constants.

4. **A continuation from a different provider is refused unless the plan was completed.**
   `packages/plan/src/capability/index.ts:159`–`167` throws `PlanProviderMismatchError` (`code: "plan_provider_mismatch"`,
   `packages/plan/src/provider.ts:60`) for an unfinished ref, and drops a `completed` one.
   Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts:176`–`237` (both branches).

5. **Only the entry agent gets planning.** `forAgent` returns `null` when `!scope.entry` —
   `packages/plan/src/capability/index.ts:268`. **Unpinned** by any test in `packages/plan/tests/`.

6. **Plan tools reach the model through the lead's full toolset, not the advertised list.**
   `attach` returns the orchestration's contribution verbatim
   (`packages/plan/src/capability/index.ts:273`). The `advertised` flag
   (`packages/capability/src/contract.ts:322`–`326`) would be a no-op here either way.

7. **The review blocker is the contribution's first handler.**
   `handlers: [reviewBlocker, ...planTools.map(...)]` — `packages/plan/src/capability/orchestration.ts:720`.
   Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:645`–`651` reads `handlers[0]` deliberately, and every
   `blocked()` assertion in that describe block depends on it.

8. **A tool of `unknown` effect is refused in both review phases.** `allowedInPhase` admits only a
   plan tool, `control`, or (in `unplanned`) `read` — `packages/plan/src/capability/orchestration.ts` (`allowedInPhase`); the fallback
   port when none is registered classifies everything as `unknown` — `packages/plan/src/capability/index.ts:205`.
   Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:769`–`772` and `packages/plan/tests/component/plan-capability-gating.test.ts:368`–`381`.

9. **A `spawn_run` tool is refused in both phases, while `control` delegation is not.**
   `packages/plan/src/capability/orchestration.ts` (`allowedInPhase` and `refusalFor`).
   Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:703`–`727`, `:728`–`747`, `:748`–`764`.

10. **The review gate re-presents only when the plan's substance changed.** Rejection is keyed by
    `spec_digest` — `packages/plan/src/capability/orchestration.ts:342`–`344`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:576`–`606` (`asks` stays 1 across three retries, becomes 2
    after a structural revision).

11. **A structural revision revokes an approval and re-locks the run.** The blocker's `open` phase
    depends on `document.approved_spec_revision === document.spec_revision`
    (`packages/plan/src/capability/orchestration.ts`, `isPlanApproved` and `reviewPhase`).
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:795`–`824`.

12. **Change-request rounds are capped at 10.** `MAX_PLAN_REVIEW_REVISIONS = 10`
    (`packages/plan/src/capability/orchestration.ts:70`); exceeding it terminates with `plan_review_revision_limit` and the
    rendered plan as `partialText` — `packages/plan/src/capability/orchestration.ts:399`–`404`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:542`–`575` (11 `changes_requested` events, then terminal).

13. **A review run that never authors a plan is nudged once, then terminated `plan_review_unreviewed`.**
    `packages/plan/src/capability/orchestration.ts:519`, terminal built at `:436`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:527`–`541`.

14. **An approval on a text-only finalize nudges rather than passing.**
    `packages/plan/src/capability/orchestration.ts` (`reviewGate.check`, approved text-mode branch).
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:515`–`526`.

15. **`no_human` (declined, timed out, or no channel) never reads as approval.**
    `mapPlanReviewAnswer` maps any non-`accept` action and any unrecognized `decision` to
    `no_human` — `packages/plan/src/capability/review-gate.ts:80`, `:92`; `no_human` cancels the run —
    `packages/plan/src/capability/orchestration.ts:418`–`425`.
    Pinned: `packages/plan/tests/unit/plan-review-gate.test.ts:70`–`80`.

16. **`request_changes` is listed first in the elicit enum.** `packages/plan/src/capability/review-gate.ts:60`. The test states
    the rule as behaviour, in a comment above the assertions it explains: "Order is behaviour, not
    presentation: a client highlights the schema's `default`, else the first option, so `approve`
    first meant one stray Enter approved the plan."
    Pinned: `packages/plan/tests/unit/plan-review-gate.test.ts`
    (`identifies itself by kind and asks a constrained decision + optional feedback, with NO plan body`).

17. **The review elicit carries no plan body.** `buildPlanReviewElicitParams`'s message names the
    plan only as "shown above" — `packages/plan/src/capability/review-gate.ts:53`–`57`.
    Pinned: `packages/plan/tests/unit/plan-review-gate.test.ts`
    (`identifies itself by kind and asks a constrained decision + optional feedback, with NO plan body`).

18. **The human wait does not spend the run's compute budget.** `buildPlanReviewAsk` wraps the
    elicit in `elicitWithClockPause` — `packages/plan/src/capability/review-gate.ts`
    (`buildPlanReviewAsk`).
    Pinned: `packages/plan/tests/unit/plan-review-gate.test.ts:108`–`120` (`clock.paused === 1`, `clock.resumed === 1`),
    and the timeout path at `:140`–`144`.

19. **The pending gate nudges up to the cap, then terminates `pending_tasks_unfinished`,** and a cap
    of 0 disables it entirely — `packages/plan/src/capability/orchestration.ts:466`, `:475`–`485`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:854`–`870` and `:834`–`841`.

20. **A spawn against every open task counts as progress and resets the stall counter.**
    `allOpenSpawnedThisBatch` is read off `iter.spawnedTaskIds`, written only by
    `noteSpawned` — `packages/plan/src/capability/orchestration.ts` (`pendingTaskGate` and `port.noteSpawned`).
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:871`–`890`.

21. **A retry against an unchanged rejected plan does not count as progress.**
    `planReviewChangeRequested` is set only inside `recordRejection` — `packages/plan/src/capability/orchestration.ts:351`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts:607`–`629`.

22. **A `task_id` may be spawned at most once per iteration.** `beforeSpawn` refuses a repeat with
    `duplicateBatchTaskId(taskId)` — `packages/plan/src/capability/orchestration.ts` (`port.beforeSpawn`, duplicate-task branch), message at `packages/plan/src/capability/messages.ts:154`.
    Pinned: `packages/plan/tests/component/plan-orchestration.test.ts` (`refuses a task_id already
    spawned this iteration`); the following independent-spawn case is exempt because it carries no id.

23. **A completed plan is sealed: it may not be revised, and a task may only be *closed*.**
    `revise` throws `PlanSealedError` (`packages/plan/src/capability/session.ts:420`); `transition` refuses a batch containing
    any non-closed target status (`packages/plan/src/capability/session.ts:471`–`474`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts:407`–`419` and, for the all-or-nothing batch case,
    `:520`–`:550`.

24. **A sealed plan is loaded verbatim on continuation and never re-stamped by `finalize`.**
    `reconcile` returns early on `isPlanSealed` (`packages/plan/src/capability/session.ts:228`); `finalize` returns `this.ref()`
    unchanged (`packages/plan/src/capability/session.ts:588`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts:368`–`376` and `:420`–`432` (a cancelled continuation leaves
    `completed` standing).

25. **A session may hold more than one plan over its life, but only one *open* one.**
    `create` seals a fully-closed plan and proceeds; it throws `ActivePlanExistsError` only while
    work remains — `packages/plan/src/capability/session.ts:339`–`345`.
    Pinned: `packages/plan/tests/component/plan-session.test.ts:434`–`457` and `:458`–`472`.

26. **An approval carried into a run with no review gate is dropped.**
    `staleApproval = !this.#review && loaded.approved_spec_revision !== undefined` —
    `packages/plan/src/capability/session.ts:231`, cleared at `:241`.
    Pinned: `packages/plan/tests/component/plan-session.test.ts:201`–`240`; the mirror (kept under `review: true`) at
    `:241`–`272`.

27. **A continuation resets `in_progress` tasks to `pending` as an audited revision.**
    `packages/plan/src/capability/session.ts:232`–`252`, one `store.update` bumping `revision`.
    Pinned: `packages/plan/tests/component/plan-session.test.ts:162`–`200` (`revision === running.revision + 1`), and at the
    capability level with the recovery projection at `packages/plan/tests/component/plan-capability-gating.test.ts:279`–`291`.

28. **A missing `discard`ed plan from a completed run is normal, not a loss.**
    `packages/plan/src/capability/session.ts:256`–`270` returns `undefined` and logs at `debug`.
    Pinned: `packages/plan/tests/component/plan-observability.test.ts:196`–`222` (`reason === "discarded"`, level `debug`).

29. **A removed backing record invalidates every mutable cache and produces exactly one
    `plan_removed`.** `#markMissing` clears `#lastValid`, sets `#missing` and arms `#pendingRemoval`
    with `??=` (`packages/plan/src/capability/session.ts:616`–`622`); `takeRemoval` is one-shot (`packages/plan/src/capability/session.ts:185`–`189`);
    `withRemoval` attaches it once (`packages/plan/src/capability/runtime-tools.ts:253`–`255`).
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts:260`–`308` (`retry.removed` is `undefined`) and
    `packages/plan/tests/component/plan-orchestration.test.ts:302`–`357` (context is tombstoned, anchor flips to
    "Plan unavailable").

30. **A mutation on a tombstoned plan tells the model not to retry.**
    `MissingActivePlanError`'s message contains "Do not retry this mutation" —
    `packages/plan/src/capability/session.ts:97`–`105`.
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts:289`, `packages/plan/tests/component/plan-session.test.ts:150`.

31. **Every mutating tool result carries the next CAS triple.** `cas(document)` on
    `create_plan`/`revise_plan`/`transition_plan_task` — `packages/plan/src/capability/runtime-tools.ts:185`–`201`, `:287`,
    `:312`, `:341`.
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts:154`–`211` chains create → revise → transition with no
    intervening `read_plan`.

32. **An oversized raw array is rejected before zod visits it.** `assertRawArrayLimit` throws a
    `RangeError` naming the limit — `packages/plan/src/capability/runtime-tools.ts:245`–`249`.
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts:65`–`108` for all three batch inputs; asserts nothing was
    written.

33. **A batch is all-or-nothing and costs one revision.** `transition` folds every member inside a
    single `store.update` (`packages/plan/src/capability/session.ts:476`–`487`); `revise` applies `applyPlanRevisions` and writes
    once (`packages/plan/src/capability/session.ts:427`–`433`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts:474`–`493` and `:494`–`519`;
    `packages/plan/tests/component/plan-runtime-tools.test.ts:310`–`366` for both tools at the wire level.

34. **`transition_plan_task` refuses a call with neither `transitions` nor a single `task_id`.**
    `superRefine` at `packages/plan/src/capability/runtime-tools.ts:149`–`155`.
    Pinned: `packages/plan/tests/component/plan-runtime-tools.test.ts:212`–`228`.

35. **`revise_plan`'s wire schema refuses both-or-neither of `operation`/`operations`.** The XOR
    refinement site in this package is `packages/plan/src/tools.ts:52`–`54` — full statement
    owned by [capabilities/plan-store.md](plan-store.md) §5.

36. **`retention: discard` deletes only after a `completed` terminal record.**
    `onRunEnd` returns unless `record.status === "completed" && ref.retention === "discard"` —
    `packages/plan/src/capability/index.ts:296`.
    Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts:339`–`349` (a non-completed end leaves it, and a later
    completed end still finds it) and the end-to-end file check at
    `packages/plan/tests/integration/planned-run-file.test.ts:222`–`240`.

37. **The discard path is idempotent and emits `plan_removed` only on a real deletion.**
    `if (!deleted) return;` before the emit — `packages/plan/src/capability/index.ts:315`.
    Pinned: `packages/plan/tests/component/plan-capability-gating.test.ts:351`–`358`.

38. **`keep` is the default at every layer, and the two definitions are pinned equal.**
    `DEFAULT_PLAN_RETENTION = "keep"` (`packages/plan/src/schemas.ts:46`), `PLANS_DEFAULTS.retention = "keep"`
    (`packages/plan/src/settings.ts:24`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts:306`–`309`.

39. **The nudge default is pinned to the contract's copy.** `PLANS_DEFAULTS.pending_task_nudges`
    equals `DEFAULT_PENDING_TASK_NUDGES` from `@clarvis/capability`
    (`packages/plan/src/settings.ts:25`, `packages/capability/src/env.ts:23`).
    Pinned: `packages/plan/tests/component/plan-session.test.ts:310`–`313`.

40. **Provider selection is settings-only and never a request param.** `plansRunConfigSchema` is
    `.strict()` and omits `provider` — `packages/plan/src/settings.ts:47`–`53`; the spec is
    `pluginContributable: false` — `packages/plan/src/settings.ts:90`.
    Pinned: `packages/plan/tests/unit/settings.test.ts:6`–`17` (all three provider kinds parse in
    the block and are refused in the param).

41. **The settings entry never reaches executable-provider code.**
    `packages/plan/src/settings.ts:11` imports `./provider-config.ts` and nothing else local, and
    that file pulls in neither `./provider.ts` nor `node:fs`
    (`packages/plan/src/provider-config.ts:1`–`2`) — full statement owned by
    [capabilities/provider-executables.md](provider-executables.md) §5.
    Pinned: `packages/plan/tests/architecture/settings-provider-boundary.test.ts:9`–`13`.

42. **The stable spec block is byte-identical across task transitions.**
    `planSpecBlock`'s field set mirrors `specDigest` — `packages/plan/src/capability/canonical-state.ts:117`–`149`.
    Pinned: `packages/plan/tests/unit/plan-canonical-state.test.ts:78`–`90`.

43. **The volatile header carries every task's status, so the spec block need not.**
    `packages/plan/src/capability/canonical-state.ts:90`–`92`; the test also caps it: `header.length < 1000`.
    Pinned: `packages/plan/tests/unit/plan-canonical-state.test.ts:127`–`140`.

44. **The approval line reports the run's posture, not the document's status.**
    `approvalLine(document, reviewRequired)` — `packages/plan/src/capability/canonical-state.ts:165`–`177`.
    Pinned: `packages/plan/tests/unit/plan-canonical-state.test.ts:180`–`184` (an `active` document in a gated run still
    reports the gate).

45. **Delegation may claim and fail a task but never judge it done.** `createDelegationPlanPort`
    exposes only `reconcile`/`openTasks`/`getTask`/`markSpawned`/`markFailed`/`markReturned` —
    `packages/plan/src/capability/delegation-port.ts:23`–`26`.
    Pinned: `packages/plan/tests/component/delegation-plan-port.test.ts:49`–`59`.

46. **The tracking port's absence is reported once, at `debug`, and never fails a run.**
    `absenceReported` latch — `packages/plan/src/capability/index.ts:215`–`227`.
    Pinned: `packages/plan/tests/component/plan-observability.test.ts:361`–`390` (two `forAgent` calls, one record) and
    `:392`–`418` (silent once the entry agent attached).

47. **A plan tool error the dispatcher does not model is logged; a refusal the model can act on is
    not.** `EXPECTED_PLAN_TOOL_ERRORS` gate — `packages/plan/src/capability/runtime-tools.ts:229`–`241`, `:352`.
    Pinned: `packages/plan/tests/component/plan-observability.test.ts:238`–`256` (logged, incl. a non-Error throw) and
    `:257`–`280` (silent for a modelled refusal and for a rejected argument schema).

48. **`plan_review` and `task_nudge` are contributed trace kinds, not engine ones.**
    Neither appears in `BUILTIN_TRACE_KINDS` (`packages/capability/src/trace-kinds.ts:11`–`47`)
    while both have published detail interfaces (`:391`, `:410`). **Unpinned** in
    `packages/plan/tests/`.

49. **All five plan wire events are live-only on the capability channel.**
    `packages/kernel/src/runs/event-policy.ts:78`–`82` maps each to `live("capability", ["capability_channel"])`, so a
    rehydrated session (which reads only the persisted trace) restores none of them. **Unpinned**
    in this document's scope.

50. **The plan document itself never enters the run trace.** `PlanRef`'s TSDoc states it — "The
    plan document itself is deliberately not in the run trace" (`packages/plan/src/schemas.ts:205`–`206`) — and the
    trace record for a plan tool call carries only the tool's
    `arguments`/`result` strings (`packages/plan/src/capability/orchestration.ts:640`–`642`). **Unpinned.**

51. **The kernel validates the `plans` `capability_state` slot before handing it to a client.**
    `planRefFromCapabilityState` returns `undefined` for anything failing `isPlanRef` —
    `packages/kernel/src/runs/plan-ref.ts:62`–`67`. **Unpinned** in this document's scope.

52. **The kernel's plans service refuses cleanly when planning is unconfigured.**
    `active()` throws `kernelError("capability_disabled", …)` when `options.resolve` is absent —
    `packages/kernel/src/plans/plans-service.ts:66`. **Unpinned** in this document's scope.

53. **`plansSettingsSpec` is registered at module load, before any settings file is read.**
    `packages/kernel/src/config/capability-registry.ts:23`, with the reason at `:13`–`:17`.
    **Unpinned** in this document's scope.

54. **The control plane refuses to delete a live plan.** `PlanService.delete` throws
    `PlanNotTerminalError` for `active` or `awaiting_approval` — `packages/plan/src/service.ts:88`–`89`.
    Pinned: `packages/plan/tests/component/plan-service.test.ts:25`–`44`.

55. **A corrupt plan is still deletable.** `PlanService.delete` catches `InvalidPlanError` and
    deletes without a CAS baseline — `packages/plan/src/service.ts:83`–`85`.
    Pinned: `packages/plan/tests/component/plan-service.test.ts:46`–`62`.

55b. **`PlanService.delete` re-reads the plan immediately before deleting, using that as its CAS
    baseline**, so a delete racing a concurrent mutation fails as `PlanConflictError` rather than
    silently clobbering the concurrent change.
    Pinned: `packages/plan/tests/component/plan-service.test.ts:64`–`90` (a write racing the delete between the read and the
    store's own `delete` call surfaces as `PlanConflictError`, and the racing write's effect
    survives).

56. **Under the server's `auto_decline` posture, `plans: "review"` is downgraded to `"on"`,** and the
    downgrade is reported — `packages/server/src/mcp/elicitation.ts:95`–`99`. **Unpinned** in
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
| `plans` param unparseable | `readPlansSettings` `safeParse` | falls back to `{ mode: "on" }` — planning stays **on** (`packages/plan/src/capability/index.ts:119`) |
| provider settings unreadable / invalid | `createPlanFactory.storeFor` | `PlanProviderUnavailableError` (`code: "plan_provider_unavailable"`, `packages/plan/src/provider.ts:55`) — thrown out of `forRun` |
| continuation ref names another provider, plan unfinished | `forRun` | throws `PlanProviderMismatchError` (`packages/plan/src/capability/index.ts:166`) — the run does not start |
| continuation ref names another provider, plan completed | `forRun` | ref dropped, run proceeds with no plan (`packages/plan/src/capability/index.ts:163`) |
| continuation plan absent, was `completed` + `discard` | `reconcile` | `undefined`, `debug` log `plan.continuation.absent` (`packages/plan/src/capability/session.ts:261`) |
| continuation plan absent otherwise | `reconcile` | tombstone; `plan_removed` at run start (`packages/plan/src/capability/session.ts:272`, `packages/plan/src/capability/index.ts:241`) |
| on-disk plan unparseable | `reconcile` catch | `#invalidError` set, **last valid document kept, file untouched**; mutations then throw `InvalidPlanError` from `#requireMutable` (`packages/plan/src/capability/session.ts:288`–`291`, `:604`) |
| `store.reconcile` conflict | `reconcile` catch | full re-read; a `PlanNotFoundError` on that re-read tombstones (`packages/plan/src/capability/session.ts:292`–`304`) |
| stale CAS on a mutation | `revise` / store `update` | `PlanConflictError("Plan changed since it was read")` (`packages/plan/src/capability/session.ts:426`); no write — pinned at `packages/plan/tests/component/plan-runtime-tools.test.ts:229`–`259` |
| mutation on a sealed plan | `revise`/`transition` | `PlanSealedError` with `sealedRevisionMessage`/`sealedTransitionMessage` (`packages/plan/src/capability/session.ts:420`, `:474`) |
| second `create_plan` with open work | `create` | `ActivePlanExistsError` naming `revise_plan` and `transition_plan_task` (`packages/plan/src/capability/session.ts:85`–`94`) |
| any plan-tool throw | `handlePlanRuntimeCall` catch | converted to a failure **result** string; never propagated (`packages/plan/src/capability/runtime-tools.ts:351`–`365`) |
| unmodelled plan-tool throw | same catch | additionally `logger.error` `plan.tool.unexpected_error` with `sanitizeErrorMessage`d cause + stack (`packages/plan/src/capability/runtime-tools.ts:353`–`363`) |
| unknown plan tool name | dispatch `default` | `failure(name, Error("Unknown plan tool: …"))` (`packages/plan/src/capability/runtime-tools.ts:348`) |
| review ask throws, run cancelled | `presentPlanReviewGate` | returns the cancellation as `terminal` (`packages/plan/src/capability/orchestration.ts`, `presentPlanReviewGate`'s `planReviewAsk` error branch) |
| review ask throws, run live | same | rethrows (`packages/plan/src/capability/orchestration.ts:371`) |
| elicit times out / declines / no channel | `mapPlanReviewAnswer`, `buildPlanReviewAsk`'s `onNoResponse` | `no_human` → run **cancelled** (`packages/plan/src/capability/review-gate.ts:80`, `:122`; `packages/plan/src/capability/orchestration.ts:418`–`425`) |
| 11th change request | `presentPlanReviewGate` | `terminal` `plan_review_revision_limit`, `partialText` = rendered plan (`packages/plan/src/capability/orchestration.ts:399`–`404`) |
| review run finalizes twice with no plan | `reviewGate.check` | `terminal` `plan_review_unreviewed` (`packages/plan/src/capability/orchestration.ts:527`) |
| open tasks past the nudge cap | `pendingTaskGate` | `terminal` `pending_tasks_unfinished`, message naming every open id (`packages/plan/src/capability/orchestration.ts:446`–`453`) |
| retention delete fails | `bestEffort` in `onRunEnd` | swallowed; `deleted` stays `false`; `plan.retention.discarded` logged with `deleted: false` and "nothing else will retry" (`packages/plan/src/capability/index.ts:298`–`314`) — pinned at `packages/plan/tests/component/plan-observability.test.ts:343`–`359` |
| `finalizeRun` with no attached agent | `packages/plan/src/capability/index.ts:278` | `undefined` — no `capability_state` slot |
| control plane, planning unconfigured | `createPlansService.active` | `kernelError("capability_disabled", "plans are not configured for this workspace")` (`packages/kernel/src/plans/plans-service.ts:67`) |
| control plane, provider unavailable | same | `kernelError("unavailable", sanitizeErrorMessage(...))`, details `sanitizeDeep`ed (`packages/kernel/src/plans/plans-service.ts:72`–`79`) |
| malformed `plans` slot on a stored record | `planRefFromCapabilityState` | `undefined` rather than a bad cast (`packages/kernel/src/runs/plan-ref.ts:66`) |
| capability event detail fails the closed schema | `capabilityEventToProto` | falls back to a generic bounded `capability_event` rather than dropping (`packages/kernel/src/runs/map-events.ts:353`–`374`) |

All three terminal error codes are declared in `guardTripCodes` (`packages/plan/src/capability/index.ts:262`–`266`), which per the
contract's own `@remarks` "Only affects the `reason` on the run's `run_ended` entry"
(`packages/capability/src/contract.ts:286`–`293`).

`finalizeRun` and `onRunEnd` are both bounded by
`CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` and a throw in either is logged without affecting the run
(`packages/capability/src/contract.ts:260`–`263`, `:276`–`:282`).

---

## 7. Coupling

### 7.1 Outbound (what planning depends on)

| Dependency | Kind | Forced by |
| --- | --- | --- |
| `@clarvis/capability` | runtime, static | value imports of `NOOP_LOGGER`, `TOOL_EFFECT_PORT`, `bestEffort`, `bind`, `projected` (`packages/plan/src/capability/index.ts:26`–`33`), `TASK_TRACKING_PORT` (`packages/plan/src/capability/task-port.ts:11`), `elicitWithClockPause` (`packages/plan/src/capability/review-gate.ts:4`), `sanitizeErrorMessage` (`packages/plan/src/capability/runtime-tools.ts:29`), `partialStructOf` (`packages/plan/src/capability/orchestration.ts:21`) |
| `zod` | runtime, static | `packages/plan/src/settings.ts:9`, `packages/plan/src/capability/runtime-tools.ts:26`, `packages/plan/src/tools.ts:12` |
| sibling `../format.ts`, `../schemas.ts`, `../store.ts`, `../transitions.ts`, `../revisions.ts`, `../repository.ts`, `../limits.ts`, `../provider.ts` | runtime, static | e.g. `packages/plan/src/capability/orchestration.ts:12`–`14`, `packages/plan/src/capability/session.ts:3`–`26` |
| `@clarvis/paths` | runtime, static | *not* from `src/capability/**` — it is a package-level dependency used elsewhere (`packages/plan/package.json`) |

**Nothing under `src/capability/**` imports `@clarvis/loop`.** The constraint is stated in the entry
file's own TSDoc (`packages/plan/src/capability/index.ts:10`–`13`) and the test-helper file repeats it: "`@clarvis/plan` must never
import `@clarvis/loop` — that edge would close a dependency cycle the loop's own tests enforce"
(`packages/plan/tests/helpers/context.ts:4`–`6`). The loop-side architecture test enforces the other
half of that boundary by asserting that the engine neither declares `@clarvis/plan` as a dependency
nor names it in production source
(`packages/loop/tests/architecture/no-feature-names.test.ts:127`–`135`).

The `ToolEffectPort` dependency is **required, not optional**, on the orchestration's deps
(`packages/plan/src/capability/orchestration.ts:172`); its TSDoc says absent it "every tool reads as `unknown` and a `review` run
is refused everything but planning — a silent, total regression of the gate's scope. Making it
mandatory turns a forgotten wire into a compile error" (`packages/plan/src/capability/orchestration.ts`, `PlansOrchestrationDeps.toolEffect`). The capability
still supplies a fallback rather than crashing (`packages/plan/src/capability/index.ts:205`).

### 7.2 Inbound (what depends on planning)

| Consumer | Edge | Forced by |
| --- | --- | --- |
| `@clarvis/kernel` | value import of `createPlansCapability` | `packages/kernel/src/plans/planning-runtime.ts:18` |
| `@clarvis/kernel` | value import of `plansSettingsSpec` for the settings registry | `packages/kernel/src/config/capability-registry.ts:4`, `:23` |
| `@clarvis/kernel` | value import of `PLANS_DEFAULTS` for the run-request assembler | `packages/kernel/src/runs/settings-assembler.ts:1` |
| `@clarvis/kernel` | value import of `PLANS_CAPABILITY_NAME` for the `capability_state` key | `packages/kernel/src/runs/plan-ref.ts:1` |
| `@clarvis/kernel` | value imports of `PlanService`, `renderPlan`, `PlanProviderUnavailableError` | `packages/kernel/src/plans/plans-service.ts:1`–`7` |
| `@clarvis/code` | value import of `PLANS_DEFAULTS` re-exported through `packages/kernel/src/config.ts:55` | `packages/code/src/onboarding/seed-plans.ts:1`, `packages/code/src/adapters/settings.ts:9` |
| `@clarvis/loop` (delegation) | **structural only** — consumes a `TaskTrackingPort` from the service registry, never naming this package | `packages/capability/src/task-tracking-port.ts:66`; planning publishes under the same key at `packages/plan/src/capability/task-port.ts:69` |

The delegation edge is the one worth naming as *deliberately* structural: the entry TSDoc says
"`delegate_task` takes a port shaped like `PlanDelegationPort` without naming this package — which is
what keeps the dependency edge pointing one way" (`packages/plan/src/capability/index.ts:10`–`13`).

### 7.3 Ordering constraints

- **Capability fold order.** `order: -100` (`packages/plan/src/capability/index.ts:232`) is consumed by `orderCapabilities`
  (`packages/loop/src/runtime/capability-order.ts:14`), called at
  `packages/loop/src/runtime/entry-inputs.ts:208` and
  `packages/loop/src/runtime/orchestrator.ts:241`. The contract states the consequence: "planning's
  review blocker has to be consulted before the coding toolset and before the MCP catch-all or it
  guards nothing" (`packages/capability/src/contract.ts:225`–`228`). The loop test pins the exact
  plans-shaped ordering by sorting `plans` at `-100` ahead of default-order capabilities
  (`packages/loop/tests/unit/capability-dispatch-order.test.ts:76`–`84`).
- **Handler order inside the contribution.** `reviewBlocker` first — `packages/plan/src/capability/orchestration.ts:720`.
- **Settings registration before any read.** `packages/kernel/src/config/capability-registry.ts:13`–`17`.
- **`finalizeRun` before `onRunEnd`.** The contract spells out that this ordering is the reason both
  hooks exist: "sealing a plan and naming it on the record has to happen before the write, while
  deleting a discarded plan has to happen after it"
  (`packages/capability/src/contract.ts:276`–`279`).

### 7.4 Delegated to sibling documents

- Plan **document format, digests, `PlanStore`/`PlanRepository`, `applyPlanRevisions`,
  `transitionTask`'s matrix, list paging** → **plan-document-and-store**. Every one of them sits
  outside `src/capability/**`: `parsePlan`/`renderPlan` at `packages/plan/src/format.ts:238`,
  `:275`, `digestText`/`specDigest` at `:46`, `:68`, the `PlanStore` interface and its cursor-paged
  `list` at `packages/plan/src/store.ts:98`, `:118`, `PlanRecordQuery` and `PlanRepositoryTx` at
  `packages/plan/src/repository.ts:61`, `:82`, `applyPlanRevisions` at
  `packages/plan/src/revisions.ts:129`, and `transitionTask` at
  `packages/plan/src/transitions.ts:40`.
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
  validation applied to it — live inside this package (`packages/plan/src/tools.ts:60`–`:71`).
- ~~`PLANS_CAPABILITY_NAME` was documented as "duplicated in `@clarvis/loop`'s `plans-settings.ts`",
  pinned by a loop test.~~ **Resolved: the claim was false.** No such file exists and the constant is
  not duplicated anywhere; the `plans` settings block moved into this package
  (`packages/plan/src/settings.ts`) and the kernel imports the constant rather than restating it. The
  remark now says so (`packages/plan/src/schemas.ts:226`–`:234`). The genuinely-duplicated value with
  a drift test is `pending_task_nudges`, pinned at
  `packages/plan/tests/component/plan-session.test.ts:311`.
- ~~`messages.ts` linked to `../plans/task-port.ts` and `../subagents/lead-tools.ts`.~~ **Resolved.**
  `PlanDelegationPort` is linked at its real path, `./task-port.ts`
  (`packages/plan/src/capability/messages.ts:96`); `buildDelegateTaskTool` lives in `@clarvis/loop`
  and is now named in prose rather than through a `{@link}` this package cannot resolve, since it
  must not import the loop (`:132`–`:135`).

**Capability ordering and the loop-side dependency boundary are pinned.** The loop owns both tests:
`packages/loop/tests/unit/capability-dispatch-order.test.ts:76`–`84` asserts that a plans-shaped
`order: -100` sorts ahead of default-order capabilities, while
`packages/loop/tests/architecture/no-feature-names.test.ts:127`–`135` asserts that the engine neither
declares nor names `@clarvis/plan`. The within-contribution ordering remains separately pinned by
`packages/plan/tests/component/plan-orchestration.test.ts:645`–`651`, which reads `handlers[0]`
deliberately.

**`PLAN_REVIEW_ELICIT_KIND` has one owner and one pinned duplicate.** The constant is declared in
`@clarvis/capability` (`packages/capability/src/elicit.ts:68`, exported at
`packages/capability/src/index.ts:258`) and read here (`packages/plan/src/capability/review-gate.ts:52`).
`@clarvis/code` cannot import it — it depends on `@clarvis/kernel`, `@clarvis/protocol` and
`@clarvis/paths` only — so it declares its own at
`packages/code/src/adapters/elicit-types.ts:17` and uses that at
`packages/code/src/adapters/elicitation.ts:106` and `packages/code/src/views/ElicitBlock.tsx:62`.
`packages/kernel/tests/architecture/elicit-kind.test.ts` pins the two together, and pins both against
the elicit `kind` unions in `@clarvis/protocol`, `@clarvis/capability` and `@clarvis/code`.

**The review gate's construction can silently no-op.** `buildPlanReviewAsk` is built only when
`review && scope.elicit !== undefined && scope.clock !== undefined` (`packages/plan/src/capability/index.ts:191`–`194`); when it is
absent, `buildPlansOrchestration` computes
`const planReview = deps.planReviewAsk !== undefined` → `false` (`packages/plan/src/capability/orchestration.ts:296`), so the
blocker and gate stand down entirely. In practice the loop
refuses such a run first — `packages/loop/src/runtime/execute-run.ts:306-312` throws
`ValidationError("elicitation_not_supported", …)` when a capability needs the human and no elicit
exists — but **nothing in `@clarvis/plan` closes this**, and no test in the plan package covers a
`review` run built without an elicit. Whether the plan package intends to rely on the loop's check is
not recorded in the source.

**Whether contributed trace kinds persist.** `plan_review`, `task_nudge` and the capability's
`tool_call`/`terminate` records go through `bc.trace`, and the capability declares no
`persistedTraceProjectors` (`packages/plan/src/capability/index.ts:146`–`330` has no such member;
contract at `packages/capability/src/contract.ts:135`). What the trace store does with a contributed
kind that has no projector is a **@clarvis/trace** question this document leaves unresolved.

**Rationale for the numeric constants.** `MAX_PLAN_REVIEW_REVISIONS = 10`
(`packages/plan/src/capability/orchestration.ts:70`), `MAX_PLAN_BATCH_OPERATIONS = 128` (`packages/plan/src/limits.ts:46`) and
`DEFAULT_PENDING_TASK_NUDGES = 3` (`packages/capability/src/env.ts:23`) carry no stated derivation in
the code or in any test message.

**`plan_review`'s `revision_index` semantics at the first presentation.** `recordPlanReview` stamps
`session.planReviewRevision` (`packages/plan/src/capability/orchestration.ts:326`), which is incremented *after* a
`request_changes` (`packages/plan/src/capability/orchestration.ts:397`). So `presented` and `approved` on the first round both
carry `0`. No test asserts the field's value, so whether that is the intended indexing is
undetermined.
