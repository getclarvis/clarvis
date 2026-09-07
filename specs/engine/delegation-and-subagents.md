# `spawn_subagent`, `delegate_task`, sub-agent runs and supervision

> Implemented at `packages/loop/src/runtime/**`, with supporting code in `packages/capability/src`
> and `packages/supervision/src`. Every claim below is anchored to a file and a named symbol or test. Open questions
> are collected in the final section.

## 1. Purpose

This subsystem is how one run produces **children**. A lead (entry) agent calls `spawn_subagent` for
independent work or `delegate_task` for one existing tracked task; the engine runs a second agent
loop inside the same process, under the same token ledger, and hands its terminal text back as the
tool result. The pieces are
`runtime/subagents/**` (argument validation, profile resolution, the two-phase spawn, the child's
own `runAgent` invocation and its persona), `runtime/delegation.ts` (the loop contribution: the
tool, its handler and the inline/background spawn paths), `runtime/capabilities/delegation.ts` (the
same, packaged as a `RunCapability` that activates for the entry lead only), and
`runtime/capabilities/agents.ts` (the five `agent_*` supervision tools over the run's child
registry).

Two spawn modes exist. The default is **inline**: the handler returns a `deferred` verdict and the
lead's dispatch blocks on the child (`packages/loop/src/runtime/delegation.ts`). The opt-in is
**background** (`background: true`): the handler registers the child in the supervision registry and
returns an **immediate `result`** carrying an `ag_`-prefixed handle, so the lead's iteration ends
and the next one — with its steer drain — can happen while the child runs
(`packages/loop/src/runtime/delegation.ts`). The comment at
`packages/loop/src/runtime/delegation.ts` states the mechanism explicitly: "A `deferred`
verdict would be joined by `runDispatch`'s own `finally` before the iteration could end, so the
parent would stay blocked exactly as before; only an immediate `result` answers the `tool_use` and
lets iteration N+1 — and with it the steer drain — happen."

The topology is fixed at **two levels** structurally, not by a depth counter. Both child-spawn tools are
contributed only by `createDelegationRunCapability`, which returns `null` for any non-entry scope
and for an entry that cannot delegate (`packages/loop/src/runtime/capabilities/delegation.ts`);
and that capability object is constructed inside the *entry input builder* and prepended to the
entry's list only (`packages/loop/src/runtime/entry-inputs.ts`), so it is not in
`deps.runCapabilities` — which is the exact list a spawned sub-agent's activation is computed from
(`packages/loop/src/runtime/capabilities/delegation.ts`). The same is true of the five
`agent_*` tools: `createAgentsRunCapability.forAgent` returns `null` unless `scope.entry`
(`packages/loop/src/runtime/capabilities/agents.ts`).

The "cannot delegate" half of that gate is `DelegationCapabilityDeps.canDelegate`
(`packages/loop/src/runtime/capabilities/delegation.ts`, wired as `canDelegate: isLead` at
`packages/loop/src/runtime/entry-inputs.ts`), whose own TSDoc states why it is a separate,
explicit field rather than folded into the entry check: "a run can be worth activating capabilities
for without the entry agent holding `can_spawn` — and a solo agent offered child-spawn tools with no
profile to target is worse than no tool at all" (`packages/loop/src/runtime/capabilities/delegation.ts`). Because
`canSpawnChildren` (the registry/tools gate) and `canDelegate` (the child-spawn gate) are
evaluated independently, they coincide only for a lead: a non-lead entry whose profile carries a
grant some capability declared `entryCanSpawn: true` for gets the five `agent_*` tools (§5 invariant
1) but never either child-spawn tool, which is hard-gated to `isLead` regardless of any grant
(`packages/loop/src/runtime/entry-inputs.ts`).

## 2. Surface

The compact descriptor contract requires self-contained briefs, distinguishes isolated conversation
from a shared workspace/token budget, and states the background-to-inline fallback when supervision
is absent. Child ids can be taken directly from spawn results; listing first is not required.
`await_agents` reports the first wake and still-running children, not that every child finished;
timeout does not cancel them. Finalization guidance preserves useful live work and warns that
cancellation does not undo writes. Production: `buildSpawnSubagentTool`/`buildDelegateTaskTool` in
`packages/loop/src/runtime/subagents/lead-tools.ts`, `buildTools`/`liveChildrenNote` in
`packages/loop/src/runtime/capabilities/agents.ts`. Test:
`packages/loop/tests/unit/lead-tools.test.ts` and `agents-capability.test.ts` in the same directory.
See [`model-instructions.md`](../cross-cutting/model-instructions.md).

### 2.1 Exported symbols

This subsystem has no barrel: `runtime/subagents/index.ts` was deleted (see §8 item 7)
and every consumer, in `src` and in tests alike, imports `lead-tools.ts`, `delegate-task.ts`,
`subagent-profiles.ts`, `run-subagent.ts`, `build-subagent-input.ts` and `build-lead-input.ts` by
direct path. Nothing in this subsystem reaches the package's public entrypoints except one name:
`packages/loop/src/lib.ts` exports `DELEGATION_CAPABILITY_NAME` and nothing else from here.

| Symbol | Kind | File | Signature / value |
| --- | --- | --- | --- |
| `canSpawnChildren` | fn | `packages/loop/src/runtime/spawn-shape.ts` | `(shape: RunShape, declarations: readonly CapabilityGrantDeclaration[]) => boolean` |
| `SPAWN_SUBAGENT_TOOL_NAME` | const | `packages/loop/src/runtime/tools/wire-names.ts` | `"spawn_subagent"` |
| `DELEGATE_TASK_TOOL_NAME` | const | `packages/loop/src/runtime/tools/wire-names.ts` | `"delegate_task"` |
| `spawnSubagentTool` | const | `packages/loop/src/runtime/subagents/lead-tools.ts` | the independent base `NamespacedTool` |
| `buildSpawnSubagentTool` | fn | `packages/loop/src/runtime/subagents/lead-tools.ts` | `(profiles?, imageRefsAllowed?) => NamespacedTool` |
| `buildDelegateTaskTool` | fn | `packages/loop/src/runtime/subagents/lead-tools.ts` | `(profiles, imageRefsAllowed, augmentation) => NamespacedTool` |
| `ResolvedSubagentProfile` | type | `packages/loop/src/runtime/subagents/subagent-profiles.ts` | 22-field resolved profile |
| `SubagentProfileRegistry` | type | `packages/loop/src/runtime/subagents/subagent-profiles.ts` | `Map<string, ResolvedSubagentProfile>` |
| `resolveIterationCap` | fn | `packages/loop/src/runtime/subagents/subagent-profiles.ts` | `(profile, defaultLimit) => number` |
| `resolveSubagentProfiles` | fn | `packages/loop/src/runtime/subagents/subagent-profiles.ts` | `(raw, providers, env) => SubagentProfileRegistry` |
| `hasVisionCapableProfile` | fn | `packages/loop/src/runtime/subagents/subagent-profiles.ts` | `(profiles) => boolean` |
| `findInvalidToolRef` | fn | `packages/loop/src/runtime/subagents/subagent-profiles.ts` | `(refs, poolNames) => { label, tool } \| null` |
| `validateDelegateTaskArgs` | fn | `packages/loop/src/runtime/subagents/delegate-task.ts` | `(raw, options) => DelegateTaskArgsResult` |
| `prepareSpawn` | fn | `packages/loop/src/runtime/subagents/delegate-task.ts` | `(rawArgs, ctx) => Promise<PrepareSpawnResult>` |
| `buildRunSubagentInput` | fn | `packages/loop/src/runtime/subagents/delegate-task.ts` | `(profile, base) => RunSubagentInput` |
| `runPreparedSubagent` | fn | `packages/loop/src/runtime/subagents/delegate-task.ts` | `(prepared, ctx) => Promise<SpawnResult>` |
| `runSubagent` | fn | `packages/loop/src/runtime/subagents/run-subagent.ts` | `(input) => Promise<RunSubagentResult>` |
| `toSubagentOutcome` | fn | `packages/loop/src/runtime/subagents/run-subagent.ts` | `(AgentResult) => SubagentOutcome` |
| `buildSystemSections` | fn | `packages/loop/src/runtime/subagents/build-subagent-input.ts` | ordered `[environment?, basePrompt?, ...capabilitySections]` |
| `userText` | fn | `packages/loop/src/runtime/subagents/build-subagent-input.ts` | user-role text joined by blank lines, trimmed |
| `collectTurnImages` | fn | `packages/loop/src/runtime/subagents/build-subagent-input.ts` | `(messages) => ImagePart[]` |
| `buildSubagentInputPersona` | fn | `packages/loop/src/runtime/subagents/build-subagent-input.ts` | `(params) => SubagentPersona` |
| `buildLeadInputPersona` | fn | `packages/loop/src/runtime/subagents/build-lead-input.ts` | `(params) => LeadPersona` |
| `buildDelegationContribution` | fn | `packages/loop/src/runtime/delegation.ts` | `(deps: DelegationDeps) => AgentLoopContribution` |
| `DELEGATION_CAPABILITY_NAME` | const | `packages/loop/src/runtime/capabilities/delegation.ts` | `"delegation"` |
| `createDelegationRunCapability` | fn | `packages/loop/src/runtime/capabilities/delegation.ts` | `(deps) => RunCapability` |
| `createAgentsRunCapability` | fn | `packages/loop/src/runtime/capabilities/agents.ts` | `(registry, awaitTimeoutMs, nudgeCap) => RunCapability` |
| `AGENTS_UNFINISHED_CODE` | const | `packages/loop/src/runtime/capabilities/agents.ts` | `"agents_unfinished"` |
| `AGENT_{LIST,POLL,STOP,STEER}_TOOL`, `AWAIT_AGENTS_TOOL` | const | `packages/loop/src/runtime/tools/wire-names.ts` | re-exported at `packages/loop/src/runtime/capabilities/agents.ts` |

### 2.2 Child-spawn input schemas

`buildSpawnSubagentTool` always advertises `spawn_subagent` with
`required: ["title", "task"]` and no `task_id`. When a `TaskTrackingPort` exists,
`buildDelegateTaskTool` additionally advertises `delegate_task` with
`required: ["title", "task", "task_id"]`. Neither schema sets
`additionalProperties: false`: surplus fields are tolerated by JSON Schema and ignored by
`validateDelegateTaskArgs` once the known inputs are valid. Production:
`packages/loop/src/runtime/subagents/lead-tools.ts` (`spawnSubagentTool`,
`buildSpawnSubagentTool`, `buildDelegateTaskTool`). Test:
`packages/loop/tests/unit/lead-tools.test.ts` (`child-spawn tool schemas`).

| Property | Type | Bounds | Present when | Cite |
| --- | --- | --- | --- | --- |
| `task_id` (tracker-owned property) | string | `minLength 1` for plans | `delegate_task` only; required | `packages/loop/src/runtime/subagents/lead-tools.ts` (`buildDelegateTaskTool`) |
| `title` | string | `minLength 1`, `maxLength TASK_TITLE_MAX` (60) | always | `packages/loop/src/runtime/subagents/lead-tools.ts`, `packages/capability/src/task-title.ts` |
| `task` | string | `minLength 1`, `maxLength DELEGATE_TASK_MAX_CHARS` (32 768) | always | `packages/loop/src/runtime/subagents/lead-tools.ts`, `packages/capability/src/delegate-task.ts` |
| `profile` | string, `enum` = registered profile names | — | `profiles.size > 0` | `packages/loop/src/runtime/subagents/lead-tools.ts` |
| `image_refs` | integer array, `minimum: 0`, `uniqueItems` | — | `imageRefsAllowed` | `packages/loop/src/runtime/subagents/lead-tools.ts` |
| `background` | boolean | — | **always** | `packages/loop/src/runtime/subagents/lead-tools.ts` |

`delegate_task` takes its description and `task_id` property from the tracker's augmentation. The
`profile` property's description appends a
`"name: description; …"` catalogue built from the registry (`packages/loop/src/runtime/subagents/lead-tools.ts`).
The plan tracker's augmentation makes `task_id` the exact id of an existing open plan task.
Independent work always uses `spawn_subagent`; it never needs a plan and ignores a surplus
`task_id` if a model or provider includes one. Production:
`packages/plan/src/capability/messages.ts` (`DELEGATE_TASK_PLAN_DESCRIPTION`,
`DELEGATE_TASK_TASK_ID_PROPERTY`); `packages/loop/src/runtime/subagents/delegate-task.ts`
(`validateDelegateTaskArgs`). Tests: `packages/plan/tests/unit/plan-messages.test.ts`,
`packages/loop/tests/unit/delegate-task.test.ts`, and
`packages/loop/tests/integration/lead-synthesizes.test.ts`.

`imageRefsAllowed` is computed once per contribution as
`turnImages.length > 0 && hasVisionCapableProfile(profiles.values())`
(`packages/loop/src/runtime/delegation.ts`).

### 2.3 The five `agent_*` tools

Declared in `buildTools` (`packages/loop/src/runtime/capabilities/agents.ts`), advertised in exactly this order
(pinned by `packages/loop/tests/unit/agents-capability.test.ts`):

| Wire name | Input schema | Notes | Cite |
| --- | --- | --- | --- |
| `agent_list` | `{}`, `additionalProperties: false` | returns `{ agents: registry.list() }` | `packages/loop/src/runtime/capabilities/agents.ts` |
| `agent_poll` | `{ id (req), offset?: int ≥0, match?: string }` | `match` is compiled as a `RegExp`; a bad pattern is refused, not thrown | `packages/loop/src/runtime/capabilities/agents.ts` |
| `agent_stop` | `{ id (req), reason (req) }` | `reason` defaults to `"no reason given"` when empty | `packages/loop/src/runtime/capabilities/agents.ts` |
| `agent_steer` | `{ id (req), message (req) }` |  | `packages/loop/src/runtime/capabilities/agents.ts` |
| `await_agents` | `{ ids?: string[], timeout_ms?: int ≥1 }` | `timeout_ms` default is the run's `awaitTimeoutMs`, interpolated into the description | `packages/loop/src/runtime/capabilities/agents.ts` |

All five are handled by **one** `ToolHandler` matching on
`TOOL_NAMES = new Set(AGENT_SUPERVISION_WIRE_NAMES)` (`packages/loop/src/runtime/capabilities/agents.ts`). The TSDoc at
`packages/loop/src/runtime/capabilities/agents.ts` gives the reason: "they share the id-resolution and refusal shapes, and
`foldContributions` would reject five handlers claiming overlapping names anyway."

### 2.4 Request/profile keys this subsystem reads

| Key | Read at | Effect |
| --- | --- | --- |
| `profiles[].can_spawn` | `packages/loop/src/validation/request/run-shape.ts` | non-empty on the **entry** profile ⇒ `isLead` |
| `profiles[].can_spawn` | `packages/loop/src/runtime/run-shape.ts` | filters `spawnableRegistry`, i.e. the `profile` enum |
| `profiles[].default_spawn` | `packages/loop/src/runtime/entry-inputs.ts` | both child-spawn tools' default `profile` |
| `profiles[].tools` | `packages/loop/src/runtime/subagents/delegate-task.ts` | scopes the child's MCP registry |
| `profiles[].grants` | `packages/loop/src/runtime/subagents/delegate-task.ts` | selects the child's inherited capabilities and its built-in coding toolset |
| `profiles[].iteration_limit` | `packages/loop/src/runtime/subagents/subagent-profiles.ts` (raw key read; the resolved cap is applied by `resolveIterationCap`) | the child's hard iteration cap |
| `agents:` block | `@clarvis/supervision`'s `resolveAgentsLimits`, called at `packages/loop/src/runtime/entry-inputs.ts` | registry limits, `await_agents` default, finish-nudge cap |
| `CLARVIS_MAX_PARALLEL_SUBAGENTS` (env, default `4`) | `packages/loop/src/runtime/orchestrator.ts`, `packages/capability/src/env.ts` | the fan-out semaphore's permit count |
| `CLARVIS_DEFAULT_ITERATION_LIMIT` (env) | `packages/loop/src/runtime/entry-inputs.ts` | `iterationLimitDefault` for a profile with no `iteration_limit` |

`resolveSubagentProfiles` fills every other `ResolvedSubagentProfile` field a profile leaves unset
from an env default, all read in the one function body (`packages/loop/src/runtime/subagents/subagent-profiles.ts`):

| Env var | Fills |
| --- | --- |
| `CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS` | `contextWindowTokens`, when the model config declares none |
| `CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION` | `compaction.fraction` |
| `CLARVIS_DEFAULT_COMPACTION_ENABLED` | `compaction.enabled` |
| `CLARVIS_DEFAULT_COMPACTION_TARGET_FRACTION` | `compaction.targetFraction`, before the hysteresis floor is applied |
| `CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS` | `compaction.maxResultChars`, falling further to `deriveMaxResultChars` |
| `CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS` | `compaction.preserveRecentTokens`, falling further to `derivePreserveRecentTokens` |
| `CLARVIS_COMPACTION_LLM_TIMEOUT_MS` | `compaction.llmTimeoutMs` (no profile override exists) |
| `CLARVIS_DEFAULT_STAGNATION_THRESHOLD` | `stagnationThreshold` |
| `CLARVIS_DEFAULT_CALL_TIMEOUT_MS` | `callTimeoutMs` |
| `CLARVIS_DEFAULT_REASONING_SUMMARY` | `reasoningSummary` |
| `CLARVIS_DEFAULT_REASONING_EFFORT` | `reasoningEffort`, present only when either side yields a value |
| `CLARVIS_DEFAULT_MAX_RETRIES` | `maxRetries` |
| `CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS` | `maxRetryAfterMs` |
| `CLARVIS_STREAM` | `stream` (no profile override exists) |

`entry.can_spawn` names must exist and `entry.default_spawn` must be one of them; both are
`unknown_profile` `ValidationError`s (`packages/loop/src/validation/request/identity-rules.ts`). Under
`budget.on_exceed = "stop"`, **every spawnable profile** must carry an `iteration_limit`
(`packages/loop/src/validation/request/budget-rules.ts`).

## 3. Data and formats

### 3.1 Identifiers

| Id | Shape | Minted at |
| --- | --- | --- |
| `subagentInstanceId` (a.k.a. `delegation_id`) | `randomUUID()` | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| `agent_id` | `"ag_"` + 8 lowercase hex | `packages/supervision/src/ids.ts`; pattern `/^ag_[0-9a-f]{8}$/` |

The background result text is asserted against `/started ag_[0-9a-f]{8} in the background/` in
`packages/loop/tests/unit/delegation-handler.test.ts`.

### 3.2 Trace entries this subsystem records

| Kind | Detail fields recorded here | Recorded at |
| --- | --- | --- |
| `delegation_created` | `delegation_id`, `title`, `task`, `tools`, `task_id?`, `profile` | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| `delegation_started` | `delegation_id`, `model` | `packages/loop/src/runtime/subagents/build-subagent-input.ts` (the child's `onStart`) |
| `delegation_completed` / `delegation_failed` | `delegation_id`, `task_id?`, `status`, `result` | throw path `packages/loop/src/runtime/subagents/delegate-task.ts`; normal path |
| `agent_registered` | `agent_id`, `kind`, `native_id`, `title`, `profile?`, `background: true` | `registerBackgroundChild` in `packages/supervision/src/spawn-child.ts` |
| `agent_stopped` | `agent_id`, `reason`, `already_settled` | `packages/loop/src/runtime/capabilities/agents.ts` |
| `agent_steered` | `agent_id`, `message`, `delivered` | `packages/loop/src/runtime/capabilities/agents.ts` |
| `agent_finish_nudge` | `outcome` (`"nudged"`/`"terminated"`), `live_agent_ids`, `nudge_index`, `progressed` | `packages/loop/src/runtime/capabilities/agents.ts` |
| `terminate` | `{ reason: "background_children_failing" }` | `packages/loop/src/runtime/delegation.ts` |
| `terminate` | `{ reason: AGENTS_UNFINISHED_CODE }` | `packages/loop/src/runtime/capabilities/agents.ts` |

The wire shapes for the four `delegation_*` kinds are in `packages/capability/src/trace-events.ts`. The four `agent_*` kinds map to `null` in the trace mapper — they never reach
a client as a run event (`packages/trace/src/trace-mapper.ts`).

### 3.3 Capability-channel events

Emitted through `projected(...)` (`packages/capability/src/contract.ts`), which fills `wire`
from the event's own `kind`; an unwrapped event stays internal (`packages/capability/src/contract.ts`). All carry
`capability: "delegation"`.

| Kind | Detail | Emitted at |
| --- | --- | --- |
| `delegation_created` | `delegation_id`, `task_id?`, `title`, `task`, `profile`, `tools` | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| `delegation_started` | `delegation_id`, `task_id?`, `model` | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| `delegation_failed` | `delegation_id`, `task_id?`, `status` (`"cancelled"` \| `"error"`) | `packages/loop/src/runtime/subagents/delegate-task.ts` (throw path) |
| `delegation_failed` | `delegation_id`, `task_id`, `status` | `packages/loop/src/runtime/subagents/delegate-task.ts` (tracked failure path) |
| `delegation_completed` / `delegation_failed` | `delegation_id`, `task_id?`, `status` | `packages/loop/src/runtime/subagents/delegate-task.ts` |

Note the asymmetry with the trace: `delegation_started` reaches the trace from the **child's**
`onStart` (`packages/loop/src/runtime/subagents/build-subagent-input.ts`) but reaches the capability channel from the **parent's**
`runPreparedSubagent` before the child begins (`packages/loop/src/runtime/subagents/delegate-task.ts`).

### 3.4 The `onSubagentStart` and `onSubagentComplete` lifecycle-hook observers

Distinct from both tables above, these are workspace-hook **observers**, not trace kinds or
capability events. `onSubagentStart` fires after the parent emits `delegation_started` and immediately
before it calls `runSubagent`, carrying `{ subagentInstanceId, profile, model, task }`
(`packages/loop/src/runtime/subagents/delegate-task.ts`). `onSubagentComplete` carries
`{ subagentInstanceId, status, result }` on both terminal paths. Both differ from
`preDelegateTask` — which gates the spawn itself and gets its own failure-mode row and invariant
(16) — because observers only ever inform and a thrown observer is swallowed.

| Payload | Call site | `status` |
| --- | --- | --- |
| `{ subagentInstanceId, status, result }` | `packages/loop/src/runtime/subagents/delegate-task.ts` (throw path) | `"cancelled"` when `ctx.signal?.aborted`, else `"error"` |
| `{ subagentInstanceId, status, result }` | `packages/loop/src/runtime/subagents/delegate-task.ts` (normal path) | the outcome's own `status` (`completed` / `budget_exhausted` / `cancelled` / `error`) |

The hook compiler and `subagent_start` payload are pinned at
`packages/hooks/tests/component/capability.test.ts`; no `@clarvis/loop` test independently
pins the `runPreparedSubagent` start-observer call site.

### 3.5 The child's seed messages

`seedFromTask` (`packages/loop/src/runtime/subagents/run-subagent.ts`) produces either `[system, user]` or `[user]`:

- system content = `buildSystemSections({ workspaceRoot?, basePrompt?, capabilitySections? })`
  joined with `"\n\n"`, emitted only when non-empty (`packages/loop/src/runtime/subagents/run-subagent.ts`). Section order is
  environment preamble, then base prompt, then capability sections
  (`packages/loop/src/runtime/subagents/build-subagent-input.ts`).
- The environment preamble is exactly three lines under a `# Environment` heading: workspace root,
  `OS: <platform>`, and a shell line — `"Shell: PowerShell (pwsh/powershell.exe) — not sh, and not
  cmd.exe."` on `win32`, `"Shell: sh, invoked as \`sh -c\`."` otherwise
  (`packages/loop/src/runtime/subagents/build-subagent-input.ts`).
- user content = the task string, or `[{type:"text", text: task}...images]` when images were
  routed (`packages/loop/src/runtime/subagents/run-subagent.ts`).

Pinned end-to-end: a `base_prompt` with no workspace root yields
`{ role: "system", content: "system rules" }` (`packages/loop/tests/unit/run-subagent.test.ts`); with a
workspace root it is `ENV_SECTION("/fake/ws") + "\n\nsystem rules"`
(`packages/loop/tests/unit/run-subagent.test.ts`); with no base prompt the system message is the
environment section alone (`packages/loop/tests/unit/run-subagent.test.ts`).

### 3.6 Resolved sub-agent profile

`resolveSubagentProfiles` (`packages/loop/src/runtime/subagents/subagent-profiles.ts`) maps declared frontmatter onto
`ResolvedSubagentProfile`. Resolution details that are this subsystem's own:

| Field | Resolution | Cite |
| --- | --- | --- |
| `model` / `modelRef` / `provider` | `parseModelRef(p.model)`; `modelRef` keeps the full `provider/model` string used as the usage-aggregate key | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `providerConfig` | present only when `resolveProvider` succeeded — an unresolvable provider still yields a profile | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `contextWindowTokens` | `providers[].models[modelId].context_window_tokens ?? CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS` | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `capabilities` | `new Set(modelConfig.capabilities)`, or **undefined** when the model declares none | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `compaction.targetFraction` | `min(declared, fraction * (1 - 0.2))` — a hard hysteresis floor | `packages/loop/src/runtime/subagents/subagent-profiles.ts` (`MIN_COMPACTION_HYSTERESIS`) |
| `compactionPrompt` | `{}` under `prompt_mode: "none"`; else the declared non-blank prompt; else `DEFAULT_COMPACTION_PROMPT` | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `iterationLimit` | present only when declared; `resolveIterationCap` applies the run default otherwise | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |

The rest of `ResolvedSubagentProfile`'s fields carry no subsystem-specific rule beyond "the declared
frontmatter value, or an env default when unset" — listed here for completeness rather than because
any is individually interesting:

| Field | Resolution | Cite |
| --- | --- | --- |
| `name` | `p.name`, verbatim (also the registry's `Map` key) | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `description` | `p.description`, present only when declared | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `basePrompt` | `p.base_prompt`, present only when declared | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `tools` | `p.tools`, verbatim | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `grants` | `p.grants`, present only when declared | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `maxOutputTokens` | `modelConfig.max_output_tokens`, present only when the model config declares one | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `stagnationThreshold` | `p.stagnation_threshold ?? CLARVIS_DEFAULT_STAGNATION_THRESHOLD` | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `callTimeoutMs` | `p.call_timeout_ms ?? CLARVIS_DEFAULT_CALL_TIMEOUT_MS` | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `reasoningSummary` | `p.reasoning_summary ?? CLARVIS_DEFAULT_REASONING_SUMMARY` | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `reasoningEffort` | `p.reasoning_effort ?? CLARVIS_DEFAULT_REASONING_EFFORT`, present only when either yields a value | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `maxRetries` | `p.retry?.max_retries ?? CLARVIS_DEFAULT_MAX_RETRIES` | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `maxRetryAfterMs` | `p.retry?.max_retry_after_ms ?? CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS` | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| `stream` | `CLARVIS_STREAM`, unconditionally (no per-profile override exists) | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |

## 4. Behavior

### 4.1 Wiring: who gets a registry, and who gets the tools

1. `runOrchestrator` resolves the profile registry and derives the run shape
   (`packages/loop/src/runtime/orchestrator.ts`).
2. It creates the supervision registry **only** when `canSpawnChildren(shape, grantDeclarations)`
   (`packages/loop/src/runtime/orchestrator.ts`). That predicate is `shape.isLead || any(entry grant declared
   `entryCanSpawn`)` (`packages/loop/src/runtime/spawn-shape.ts`).
3. The registry, when it exists, is published on the run's service registry under
   `AGENT_REGISTRY_PORT` (`packages/loop/src/runtime/orchestrator.ts`).
4. `createSemaphore(env.CLARVIS_MAX_PARALLEL_SUBAGENTS)` bounds the fan-out
   (`packages/loop/src/runtime/orchestrator.ts`), reached through the re-export-only
   `packages/loop/src/runtime/support/concurrency.ts`, which exposes `@clarvis/capability`'s
   `createSemaphore`/`Semaphore` and nothing else. Its own doc comment gives the reason it is not
   just imported directly: "the implementation lives in `@clarvis/capability`: it is pure computation
   over promises with no engine type in its signature, and the workflow layer bounds its leader
   fan-out with the very same one. This module stays as the runtime's name for it, so `./support` and
   every direct importer keep one import path" (`packages/loop/src/runtime/support/concurrency.ts`).
   `delegation.ts` and `capabilities/delegation.ts` import only the `Semaphore` **type** through this
   path (`packages/loop/src/runtime/delegation.ts`, `packages/loop/src/runtime/capabilities/delegation.ts`), while
   `entry-inputs.ts` does the same to type the dependency it threads from the orchestrator into
   `createDelegationRunCapability` (`packages/loop/src/runtime/entry-inputs.ts`). The semaphore's own
   `acquire`/`release` contract — FIFO grant order, an abort signal rejecting a still-queued waiter
   without granting or leaking its slot, and a `release` with no waiter clamped at zero rather than
   going negative — is `@clarvis/capability`'s to define (`packages/capability/src/semaphore.ts`); this
   document's own use of it is `delegation.ts` (`acquire`/`release` around one sub-agent's tool
   loop) (the same pair guarding the parallel `Promise.all` fan-out).
5. `createEntryInput` reads the registry back off the services
   (`packages/loop/src/runtime/entry-inputs.ts`), and:
   - for a **lead** only, prepends `createDelegationRunCapability({...})` to the run's capabilities
     (`packages/loop/src/runtime/entry-inputs.ts`);
   - orders the list by `RunCapability.order` (`packages/loop/src/runtime/entry-inputs.ts`,
     `packages/loop/src/runtime/capability-order.ts`);
   - if a registry exists, prepends `createAgentsRunCapability(agents, awaitTimeoutMs, finishNudges)`
     ahead of everything (`packages/loop/src/runtime/entry-inputs.ts`).
6. `capabilitiesForScope` activates the list for the entry scope
   (`packages/loop/src/runtime/entry-inputs.ts`); `packages/loop/src/runtime/loop/run-agent.ts` attaches each and folds the contributions.

Because handler selection is first-match-wins (`selectHandler`, `packages/loop/src/runtime/loop/loop-contract.ts`,
whose TSDoc says "earlier handlers win"), the `agents` handler is consulted before every
other capability's.

### 4.2 `spawn_subagent` and `delegate_task`, phase by phase

`spawnHandler.handle` (`packages/loop/src/runtime/delegation.ts`):

| Step | Action | Cite |
| --- | --- | --- |
| 1 | Classify the call by wire name. Only `delegate_task` reads `task_id`; `spawn_subagent` discards it as surplus input. | `packages/loop/src/runtime/delegation.ts` (`spawnHandler.handle`) |
| 2 | `tasks?.beforeSpawn(callTaskId)` — the tracked id for `delegate_task`, `undefined` for `spawn_subagent`; `terminal` ends the agent and `refuse` returns a plain result. | `packages/loop/src/runtime/delegation.ts` (`spawnHandler.handle`) |
| 3 | Call `prepareSpawn` with the actual `toolName` and `requireTaskId` mode; a throw becomes `Tool '<name>' result: <name> error: <msg>`. | `packages/loop/src/runtime/delegation.ts` (`spawnHandler.handle`) |
| 4 | A rejection (`!prep.ok`) becomes `Tool '<name>' result: <text>`, `progress: false`. | `packages/loop/src/runtime/delegation.ts` (`spawnHandler.handle`) |
| 5 | `tasks?.noteSpawned(taskId)` when a task id survived validation | `packages/loop/src/runtime/delegation.ts` |
| 6 | If `background: true` **and** a registry exists: check `failingStreakExceeded()` (⇒ terminal), else `spawnInBackground` | `packages/loop/src/runtime/delegation.ts` |
| 7 | Otherwise return a `deferred` verdict | `packages/loop/src/runtime/delegation.ts` |

`prepareSpawn` (`packages/loop/src/runtime/subagents/delegate-task.ts`), in order:

1. `await ctx.tasks?.reconcile?.()` — so `task_id` validation sees external edits.
2. `validateDelegateTaskArgs`; a tracked call requires and resolves `task_id`, while an independent
   call ignores it. A failure is prefixed with the actual child-spawn tool name.
3. If the tracked task carries an `exit`/`exit_condition`, append
   `"\n\nExit condition: <exit>"` to the task, and re-check the 32 768-character ceiling on the
   **combined** text. Both the standalone and combined checks produce the same message.
4. `runVerdictHooks` over every hook's `preDelegateTask`, with `onThrow: "deny"` and
   `timeoutMs = LIFECYCLE_GATE_HOOK_TIMEOUT_MS` (30 000 ms, `packages/loop/src/runtime/loop/lifecycle-hooks.ts`). A denial is prefixed with the actual child-spawn tool name.
   `advise` messages are carried on `PreparedSpawn.adviseMessages`.
5. `tasks.markSpawned(taskId)`.
6. Mint `subagentInstanceId`, record `delegation_created` on the trace and on the capability channel.
7. `buildRegistry(selectTools(ctx.opened, selectedProfile.tools), ctx.capabilityReserved ?? [])` —
   the child's MCP registry is the intersection of the open pool with the profile's `tools`
   (`selectTools` at `packages/mcp-client/src/registry.ts`).
8. `ctx.capabilitiesFor?.(selectedProfile.grants)` — the child's inherited run capabilities and
   their system sections.
9. `hasBuiltinTools = agentToolsActive(ctx.env, selectedProfile.grants)`
   (`packages/loop/src/runtime/tools/builtin/grants.ts`).
10. Map `image_refs` indices onto `ctx.turnImages`.

`runPreparedSubagent` (`packages/loop/src/runtime/subagents/delegate-task.ts`):

1. Resolve the iteration cap and build a `withAdvise` suffixer that appends
   `"\n\n[advisor] <m>"` per advise message.
2. Pre-seed a zeroed `usageSink`, emit `delegation_started` on the capability channel, and fire `onSubagentStart`.
3. `runSubagent(buildRunSubagentInput(profile, {...}))`.
4. **Throw path** : accumulate usage from the pre-seeded sink; if `ctx.signal.aborted`
   the text is `"Sub-agent cancelled."` and the tracker is **not** touched, otherwise
   `markFailed(taskId, "Sub-agent error: …")`; fire `onSubagentComplete`; emit `delegation_failed`;
   return `{ spawned: true, failed: true }` unless aborted.
5. **Normal path**: accumulate usage, render text via `mapOutcomeToText`, record
   `delegation_completed`/`delegation_failed` on the trace, fire `onSubagentComplete`.
6. Tracker reconciliation : `error` ⇒ `markFailed` + `delegation_failed` event + early
   return with `failed: true`; `budget_exhausted` ⇒ same; `completed` ⇒ `markReturned?.(taskId,
   resultText)`. A cancelled run never touches the tracker (`aborted` short-circuits; the throw path has the same guard). The
   in-source comment states the rule: "A completed child has handed work back but
   nothing has judged it yet. Recording that hand-back is the tracker's job; closing the task is not
   — only the parent may close it, through its own transition tool."
7. Emit the terminal capability event and return.

### 4.3 Inline (deferred) spawn

`packages/loop/src/runtime/delegation.ts`. The `deferred.run(signal)` closure:

1. `effective = signal ?? bc.signal`.
2. `await deps.semaphore.acquire(effective)` — the fan-out bound.
3. `deps.clock?.enter()` — a foreground compute region.
4. `runPreparedSubagent`. On success and `!r.failed`, set `iter.subagentSpawned = true`.
5. Result text is `Tool '<name>' result: <r.text>`, always with `progress: false`; the
   taskId rides along when present.
6. A throw becomes `Tool '<name>' result: Sub-agent cancelled.` when
   `effective.aborted`, else `… Sub-agent error: <msg>`; both pinned at
   `packages/loop/tests/unit/delegation-handler.test.ts`.
7. `finally`: leave the clock region if entered, release the permit if held.

The verdict's own `progress` is always `false`; progress instead flows through
`hooks.contributesProgress: () => iter.subagentSpawned` (`packages/loop/src/runtime/delegation.ts`), reset each
`beforeIteration`. `packages/loop/src/runtime/loop/run-agent.ts` ORs the dispatch's own result with that.

An **inline sub-agent has no steer channel**: `spawnCtx` (`packages/loop/src/runtime/delegation.ts`) never sets
`steer`, and only the background path supplies one.

### 4.4 Background spawn

`spawnInBackground` (`packages/loop/src/runtime/delegation.ts`):

1. `registerBackgroundChild(agents, bc.trace, { kind: "subagent", nativeId: subagentInstanceId,
   title: prepared.subagentTask, profile: selectedProfile.name })`. That helper creates
   the `AbortController` and steer queue, registers the handle, and records `agent_registered`
   (`registerBackgroundChild` in `packages/supervision/src/spawn-child.ts`). If trace publication
   throws after registry acceptance, the helper aborts, settles and closes that handle before the
   error returns to this handler; no unadopted child remains live.
2. `null` (registry sealed or at capacity) ⇒ plain `result`, `progress: false`:
   `"Tool '<name>' result: not spawned — too many child agents are already running. Wait with
   await_agents or end one with agent_stop, then try again."`.
3. Otherwise start an unawaited async task :
   - `combined = combineSignals(bc.signal, controller.signal)` (`packages/loop/src/runtime/support/signals.ts`).
   - `await deps.semaphore.acquire(combined)` — **inside** the task, so a child queued for a permit
     no longer holds the parent's dispatch (the TSDoc says exactly this).
   - `region = deps.clock?.enterBackground()` — a background compute region, distinct from
     `enter()` (contract at `packages/capability/src/compute-clock.ts`).
   - `runPreparedSubagent(prepared, {...spawnCtx, signal: combined, steer: steerQueue,
     computeRegion: region })`.
   - `handle.settled({ status: outcome.failed ? "failed" : "completed", result: outcome.text })`.
   - A throw settles as `"stopped"` with `"cancelled before it finished"` when `combined.aborted`,
     else `"failed"` with the message.
   - `finally`: `region?.leave()`, release the permit if held, `steerQueue.close()`.
4. `agents.adopt(handle.id, task)`.
5. Return the immediate handle result with `progress: true`.

Pinned: a saturated semaphore still yields an immediate handle
(`packages/loop/tests/unit/delegation-handler.test.ts`); an already-aborted parent signal settles the
queued child as `stopped` / `"cancelled before it finished"`; a throw from outside
`runPreparedSubagent`'s own catch still settles the handle as `failed` rather than vanishing.

`background: true` with **no** registry silently degrades to the inline path — `deps.agents !== undefined`
is part of the branch condition (`packages/loop/src/runtime/delegation.ts`), pinned at
`packages/loop/tests/unit/delegation-handler.test.ts`.

### 4.5 `await_agents`

`waitForWake` (`packages/loop/src/runtime/capabilities/agents.ts`) races four outcomes:

| Racer | Source | Result |
| --- | --- | --- |
| a child settling | `registry.waitAny(scope)` | `woke_on: "agent_done"` + `id`, `status`, `result?` |
| a queued user steer | `setInterval(probe, 250)` (`STEER_POLL_MS`, `packages/loop/src/runtime/capabilities/agents.ts`) | `woke_on: "steer"` |
| the timeout | `boundPromise({ timeoutMs, onTimeout })` | `woke_on: "timeout"` |
| cancellation | `boundPromise({ signal: bc.signal, onAbort })` | `woke_on: "cancelled"` |

`still_running` is `registry.liveIds()` filtered to the scope. The clock is `pause()`d, not
`pauseCompute()`d — the TSDoc states the reason: "`pauseCompute` claims an active
compute region, and the one it would claim belongs to a background child that is still spending
tokens." The steer branch **probes** rather than drains, so delivery still happens in the loop's own
`drainSteer`; pinned at `packages/loop/tests/unit/agents-capability.test.ts`. When
`bc.steerProbe` is `undefined` the steer branch never resolves at all. A rejected wait
promise is mapped to `timeout`. `finally` clears the poller, disposes the wait and resumes
the clock.

Only `woke_on === "agent_done"` counts as progress, and it also sets `awaited.any` for the
iteration's `contributesProgress`.

### 4.6 Notices, progress and the finish gate

`beforeIteration` (`packages/loop/src/runtime/capabilities/agents.ts`): drain `registry.takeNotices()`, reset `awaited.any`, and
append each notice's text to the model's context. `contributesProgress` is
`awaited.any || drained.some((n) => n.progress)` — so a *failed* child's notice arrives in context
but is not progress (`packages/loop/tests/unit/agents-capability.test.ts`).

Finish gate (`buildFinishGate`, `packages/loop/src/runtime/capabilities/agents.ts`):

| State | Event | Next state / effect |
| --- | --- | --- |
| any | `fastAcceptOk()` | `true` iff `registry.liveCount() === 0` |
| `stall = s`, live = 0 | `check()` | `{ kind: "pass" }` |
| `stall = s < nudgeCap`, live > 0 | `check()` | `stall = s + 1`; record `agent_finish_nudge` `outcome: "nudged"`; return `{ kind: "nudge", note }` |
| any, live count **decreased** since last check | `check()` | `stall = 0` before the comparison |
| `stall = nudgeCap`, live > 0 | `check()` | `registry.seal()`; `registry.stop(id, "the run finished without them")` for every survivor; record `agent_finish_nudge` `outcome: "terminated"` and `terminate`; return `{ kind: "terminal", result }` with `error.code = "agents_unfinished"` |

The TSDoc at `packages/loop/src/runtime/capabilities/agents.ts` gives `fastAcceptOk`'s role: "the loop accepts a lone
`submit_result` without running any `check` when every gate reports it would trivially pass, so a
gate without it is dead code on the most common finishing path of all." `nudgeCap = 0` terminates on
the very first check (`packages/loop/tests/unit/agents-capability.test.ts`).

`onTeardown` (`packages/loop/src/runtime/capabilities/agents.ts`) awaits `registry.teardown(TEARDOWN_GRACE_MS)` — 5 000 ms
(`packages/loop/src/runtime/capabilities/agents.ts`) — and pushes two run warnings when the report is non-empty: `"<n> child agent(s)
abandoned when the run finished: …"` and `"<n> steer message(s) to child agent(s) were never
delivered before the run finished."`. It runs in the loop's `finally`
(`packages/loop/src/runtime/loop/loop.ts`) and is awaited.

### 4.7 The lead's own persona

`buildLeadInputPersona` (`packages/loop/src/runtime/subagents/build-lead-input.ts`) builds the `LeadPersona` spread into the
**lead's own** `runAgent` call — the sub-agent-shaped counterpart to §4.8 below, and, unlike it,
never described elsewhere in this document:

- `mcpFullToolset: true`, unconditionally. This is why the delegation contribution carries
  no `advertised` flag: the flag is read only when `mcpFullToolset !== true`, and the lead is the
  only persona this capability attaches to. It used to say `advertised: false`, which could never
  act, and has been removed.
- `buildBeforeCheckpoint` appends a `[runtime: tokens_remaining=…, lead_iterations_remaining=…]`
  note to the model's context on every checkpoint, reporting `"unbounded"` for tokens when the
  ledger is infinite and for iterations under `softMode` or an infinite cap.
- `allToolsUnavailable` reports `true` only when **neither** the lead **nor** sub-agents carry
  built-ins, **and** the lead's own registry is non-empty yet fully unavailable, **and** a freshly
  built sub-agent registry (`params.buildSubagentRegistry()`) is *either* empty *or* likewise fully
  unavailable — so the lead is never told "no tools" while a spawnable sub-agent still has a working
  registry.
- `noProgressLimit = LEAD_NO_PROGRESS_LIMIT`, whose message names "no sub-agent spawned, no task
  judged, no tool call" and directs independent work to `spawn_subagent` while reminding the lead
  that `delegate_task` requires an exact tracked id (`buildLeadInputPersona`).
- `textNoSubmitMessage` reports assistant text emitted for `<streak>` consecutive iterations without
  calling `submit_result`.
- `emptyResponseAgent: "Lead"`.

Pinned end-to-end: a lead that keeps spawning doomed sub-agents converges via `no_progress` rather
than spawning forever (`packages/loop/tests/integration/repeated-spawn-no-progress.test.ts`).

### 4.8 The child's own loop

`runSubagent` (`packages/loop/src/runtime/subagents/run-subagent.ts`):

- Creates a fresh iteration counter at `input.maxIterations` but shares the parent's
  `TokenLedger`.
- Calls `runAgent({ agent: "subagent", subagentInstanceId, … })` with **no** `contract`, so the child has no `submit_result`: its first text-only turn that clears the gates
  completes it (`packages/loop/src/runtime/loop/run-agent.ts`).
- Compaction defaults to `DISABLED_COMPACTION` when the profile sets none.
- Conditions tool-result spilling on a workspace root exactly as the lead's own `runAgent` call does:
  `...(input.workspaceRoot !== undefined ? { spillToolResult: createToolSpill(input.workspaceRoot) }
  : {})` — pinned by
  `packages/loop/tests/integration/compaction-subagent-truncate.test.ts` ("a Subagent survives a tool result
  larger than its window … truncates the live copy with a marker; the run continues; the full
  result stays in the trace").
- Forwards the run's own workspace hooks unchanged: `...(input.hooks ? { hooks: input.hooks } : {})`
  (sourced from `RunSubagentInput.hooks`), so a `beforeToolUse` deny or
  `afterToolUse` advise applies to every one of the child's own tool calls exactly as it would to
  the lead's — a distinct hook-propagation surface from `preDelegateTask`, which gates only the
  spawn call itself. Pinned by
  `packages/loop/tests/unit/tool-hooks-subagent-propagation.test.ts` (both a `beforeToolUse` deny blocking a
  sub-agent's tool call, and an `afterToolUse` advise appending to its tool result).
- The persona (`buildSubagentInputPersona`, `packages/loop/src/runtime/subagents/build-subagent-input.ts`) pins the task text as
  a `staticAnchor` labelled `"Current task"` (only when non-empty), sets
  `noProgressLimit = SUBAGENT_NO_PROGRESS_LIMIT` (6, `packages/loop/src/runtime/loop/loop-shared.ts`),
  `emptyResponseAgent = "LLM"`, and reports `allToolsUnavailable` only when the built-in toolset is
  inactive **and** the registry is non-empty **and** fully unavailable.
- `usageSink` is populated in a `finally`, so partial usage survives a throw.

`toSubagentOutcome` maps the loop's `AgentResult`:

| `AgentResult.status` | `SubagentOutcome` |
| --- | --- |
| `completed` | `{ status: "completed", text: result.text ?? result.partialText }` |
| `budget_exhausted` | `{ status: "budget_exhausted", partialText }` |
| `soft_limit_declined` | `{ status: "budget_exhausted", partialText }` |
| `cancelled` | `{ status: "cancelled", partialText }` |
| `error` | `{ status: "error", code: error?.code ?? "empty_response", message: error?.message ?? "Sub-agent terminated with no result." }` |

`mapOutcomeToText` (`packages/loop/src/runtime/subagents/delegate-task.ts`) renders those for the lead:

| Outcome | Lead-facing text |
| --- | --- |
| `completed` | the text verbatim |
| `budget_exhausted` | `Sub-agent stopped early (budget_exhausted). Partial result: <partial>` |
| `cancelled` | `Sub-agent cancelled. Partial result: <partial>` |
| `error` | `Sub-agent error: code=<code>, message=<message>` |

### 4.9 Argument validation

`validateDelegateTaskArgs` (`packages/loop/src/runtime/subagents/delegate-task.ts`), in order:

1. Non-object ⇒ `"task must be a non-empty string"`.
2. `parseDelegateTaskText(obj.task)` — Unicode-character counting with early exit at
   `DELEGATE_TASK_MAX_CHARS` (`packages/capability/src/delegate-task.ts`). The TSDoc there
    states the reason: "JSON Schema's `maxLength` counts Unicode characters rather than
   UTF-16 code units. The programmatic boundary must use the same measure or an emoji-heavy payload
   could pass one path and fail the other." Pinned with an emoji string at
   `packages/loop/tests/unit/delegate-task.test.ts`.
3. `parseTaskTitle(obj.title)` — trims, collapses runs of `[\t ]`, rejects line breaks and titles
   over 60 characters (`packages/capability/src/task-title.ts`). Pinned at
   `packages/loop/tests/unit/delegate-task.test.ts`.
4. Profile resolution : explicit registered name → `defaultProfile` if registered → the
   sole profile when exactly one exists → error. Every error message appends
   `" Registered profiles: …"` or `" No profiles are registered."`.
5. `task_id`: tracked mode requires a non-empty exact id; independent mode ignores the field even
   when surplus input carries it. An unknown id produces the spawnable ids and directs independent
   work to `spawn_subagent`; `done`/`abandoned` is refused as already closed. Production:
   `packages/loop/src/runtime/subagents/delegate-task.ts` (`validateDelegateTaskArgs`). Tests:
   `packages/loop/tests/unit/delegate-task.test.ts` (`tracked task status guard`) and
   `packages/loop/tests/unit/delegation-handler.test.ts` (`TaskTrackingPort seam`).
6. `image_refs` : must be a non-empty array; the turn must carry images; the selected
   profile's model must declare `"vision"`; every entry must be an integer in `[0, count-1]`;
   duplicates are dropped preserving order. Pinned at `packages/loop/tests/unit/image-routing.test.ts`.

## 5. Invariants

The invariants below are derived directly from this document's own source and its tests.

1. **A run gets a supervision registry — and therefore the five `agent_*` tools — exactly when its
   entry agent can spawn children.** `shape.isLead` (a non-empty `entry.can_spawn`) or an entry
   grant a capability declared `entryCanSpawn`. Production: `packages/loop/src/runtime/spawn-shape.ts`,
   `packages/loop/src/runtime/orchestrator.ts`. Test: `packages/loop/tests/unit/spawn-shape.test.ts`.

2. **`agent_*` never attaches to a spawned sub-agent.** `forAgent` returns `null` for any scope with
   `entry !== true`. Production: `packages/loop/src/runtime/capabilities/agents.ts`. Test:
   `packages/loop/tests/unit/agents-capability.test.ts` ("does not attach to a spawned sub-agent — that is
   what scopes a parent to its own children").

3. **Neither child-spawn tool reaches a sub-agent.** The delegation capability is built inside
   `createEntryInput` and prepended to the *entry's* list only; the list handed to a spawned child
   is `deps.runCapabilities`, which does not contain it. Production:
   `packages/loop/src/runtime/entry-inputs.ts`; `packages/loop/src/runtime/capabilities/delegation.ts`. It also
   refuses activation for a non-entry scope or a non-delegating entry
   (`packages/loop/src/runtime/capabilities/delegation.ts`). Test (subagent-only entry advertises no
   either name): `packages/loop/tests/integration/subagent-only-regression.test.ts`
   (`injects no child-spawn tools`).

4. **Every `agent_*` verdict is an immediate `result`, never `deferred`.** Production:
   `packages/loop/src/runtime/capabilities/agents.ts` (every branch returns `result`/`errorResult`). Test:
   `packages/loop/tests/unit/agents-capability.test.ts`. The TSDoc reason at `packages/loop/src/runtime/capabilities/agents.ts`: "a
   supervision call that deferred would be joined by the very dispatch whose blocking this
   capability exists to remove."

5. **Either child-spawn tool in background mode answers with a handle immediately, even under a saturated
   semaphore.** The permit is acquired inside the registry's adopted task, not before the verdict.
   Production: `packages/loop/src/runtime/delegation.ts`. Tests:
   `packages/loop/tests/unit/delegation-handler.test.ts`; and end-to-end,
   `packages/loop/tests/integration/background-steer-latency.test.ts`, whose failure message is "the lead
   never took another turn while its children ran — an awaited spawn is back"
   (`packages/loop/tests/integration/background-steer-latency.test.ts`).

6. **A run-level steer never reaches a child.** The run's `SteerSource` is wired onto the entry
   agent only (`packages/loop/src/runtime/entry-inputs.ts`); a child's channel is the per-handle steer queue set
   solely on the background path (`packages/loop/src/runtime/delegation.ts`). Tests:
   `packages/loop/tests/integration/steering-lead-subagent.test.ts` (no sub-agent turn sees the steer) (nor does a background child).

7. **An inline sub-agent has no steer channel at all.** `spawnCtx` never sets `steer`
   (`packages/loop/src/runtime/delegation.ts`); only `spawnInBackground` does. **Unpinned** — no test
   asserts that `agent_steer` cannot reach an inline child (it cannot be reached anyway, since an
   inline child holds the parent's dispatch).

8. **A background child's dispatch pauses its own compute region, not the shared clock.**
   `enterBackground()` on the background path (`packages/loop/src/runtime/delegation.ts`) versus `enter()` on the
   inline path (`packages/loop/src/runtime/delegation.ts`). **Unpinned in this package** — the clock's own truth
   table lives with `@clarvis/capability`'s `ComputeClock`
   (`packages/capability/src/compute-clock.ts`).

9. **`await_agents` pauses the clock with `pause()`, never `pauseCompute()`.** Production:
   `packages/loop/src/runtime/capabilities/agents.ts`. **Unpinned** — no test distinguishes the two calls.

10. **A finish on top of live children is gated, and `fastAcceptOk` is part of the gate's reach.**
    Production: `packages/loop/src/runtime/capabilities/agents.ts`. Tests:
    `packages/loop/tests/unit/agents-capability.test.ts` (fastAcceptOk) (nudge)
    (terminal + survivors stopped + registry sealed) (nudgeCap 0).

11. **A child settling between nudges resets the stall counter.** Production:
    `packages/loop/src/runtime/capabilities/agents.ts`. Test: `packages/loop/tests/unit/agents-capability.test.ts`.

12. **Teardown is awaited and its report is surfaced as run warnings, never dropped.** Production:
    `packages/loop/src/runtime/capabilities/agents.ts`; `packages/loop/src/runtime/loop/loop.ts`. Tests:
    `packages/loop/tests/unit/agents-capability.test.ts`.

13. **Consecutive background-child failures terminate the run rather than letting the lead spawn
    forever.** Checked before every background spawn. Production: `packages/loop/src/runtime/delegation.ts`; the streak itself at `packages/supervision/src/registry.ts`. Test:
    `packages/loop/tests/unit/delegation-handler.test.ts`.

14. **A capacity refusal and an already-settled steer are plain results, not errors; a malformed
    call or an unowned id is an `(error)`.** Production: `packages/loop/src/runtime/delegation.ts` (capacity),
    `packages/loop/src/runtime/capabilities/agents.ts` (settled steer) versus `packages/loop/src/runtime/capabilities/agents.ts`.
    The TSDoc at `packages/loop/src/runtime/capabilities/agents.ts` states the rule. Tests:
    `packages/loop/tests/unit/agents-capability.test.ts`;
    `packages/loop/tests/unit/delegation-handler.test.ts`.

15. **Nothing in the spawn path throws out of the handler.** A `capabilitiesFor` throw, an unknown
    profile, a hook denial and a mid-run throw all become plain results. Production:
    `packages/loop/src/runtime/delegation.ts`; `packages/loop/src/runtime/subagents/delegate-task.ts`.
    Tests: `packages/loop/tests/unit/delegation-handler.test.ts`.

16. **A `preDelegateTask` hook that throws fails closed.** `onThrow: "deny"` with the warning
    "preDelegateTask hook threw; failing closed — spawn denied". Production:
    `packages/loop/src/runtime/subagents/delegate-task.ts`; the deny-on-throw branch at
    `packages/loop/src/runtime/loop/lifecycle-hooks.ts`. ~~**Unpinned** — no test in this
    package exercises a throwing `preDelegateTask`.~~ **Pinned**:
    `packages/loop/tests/component/lifecycle-delegation-wiring.test.ts` — a throwing hook denies the
    spawn and records no `delegation_created`, and a later passing hook never runs.

17. **A cancelled sub-agent never mutates the tracker.** Both the throw path and the outcome path
    guard on `ctx.signal?.aborted`. Production: `packages/loop/src/runtime/subagents/delegate-task.ts`. ~~**Unpinned.**~~ **Pinned**: same file, four tests. Each guarded path is
    paired with a control that aborts nothing and asserts `markFailed` *is* called, so a green run
    means the guard held rather than that the path was never reached. The outcome path is reached by
    an `onSubagentComplete` hook aborting mid-settle, which is the race the guard exists for — the
    observer fires before `aborted` is read.

18. **A completed child is marked `returned`, never closed, by delegation.** Production:
    `packages/loop/src/runtime/subagents/delegate-task.ts`, with the in-source rationale and the
    port's own at `packages/capability/src/task-tracking-port.ts`. **Unpinned in
    `@clarvis/loop`** — `tests/unit/delegation-handler.test.ts`'s fake tracker never reaches the
    completion path (its `llm` is `{}`); the tracker-side test lives in `@clarvis/plan`.

19. **A sub-agent's usage is charged even when its run threw.** The `usageSink` is pre-seeded and
    filled in `runSubagent`'s `finally`, then accumulated on both paths. Production:
    `packages/loop/src/runtime/subagents/run-subagent.ts`; `packages/loop/src/runtime/subagents/delegate-task.ts`.
    Test: `packages/loop/tests/integration/lead-subagent-usage.test.ts` ("a Subagent that errors after
    consuming tokens still contributes to by_agent").

20. **A sub-agent's iteration counter is its own; its token ledger is the run's.**
    `createIterationCounter(input.maxIterations)` versus the passed-through `input.ledger`.
    Production: `packages/loop/src/runtime/subagents/run-subagent.ts`. Test:
    `packages/loop/tests/unit/run-subagent.test.ts` (`maxIterations: 1` ⇒ `budget_exhausted`).

21. **A sub-agent's iteration cap is a hard stop regardless of the run's `on_exceed` policy —
    `escalate` never reaches it.** The independent counter from invariant 20
    (`packages/loop/src/runtime/subagents/run-subagent.ts`) exhausts into `budget_exhausted` unconditionally; there is no path from
    a sub-agent's own iteration limit to the run-level human-elicit escalation a lead's own budget
    boundary can trigger. Test: `packages/loop/tests/integration/subagent-iteration-hard-cap-escalate.test.ts`
    (`on_exceed: "escalate"` on the run, and `elicitCalls` stays `0` when the spawned sub-agent
    exhausts its own `iteration_limit`).

22. **The `profile` enum is the `can_spawn` subset, not every declared profile.**
    `shape.spawnableRegistry` is built by filtering `request.profiles` through `entry.can_spawn`.
    Production: `packages/loop/src/runtime/run-shape.ts`; `packages/loop/src/runtime/entry-inputs.ts`. Test:
    `packages/loop/tests/integration/specialized-subagents.test.ts`.

23. **`task` and `task+exit_condition` share one 32 768-character ceiling, measured in Unicode
    characters.** Production: `packages/loop/src/runtime/subagents/delegate-task.ts`;
    `packages/capability/src/delegate-task.ts`. Test:
    `packages/loop/tests/unit/delegate-task.test.ts` (the standalone ceiling). The *combined* check is
    **unpinned**.

24. **`image_refs` is offered only when the turn has images and some spawnable profile's model
    declares `vision`; a model with unknown capabilities counts as blind.** Production:
    `packages/loop/src/runtime/delegation.ts`; `packages/loop/src/runtime/subagents/subagent-profiles.ts`. Tests:
    `packages/loop/tests/unit/image-routing.test.ts`;
    `packages/loop/tests/integration/image-vision-routing.test.ts`.

25. **A sub-agent's MCP registry is the profile's `tools` intersected with the open pool, with the
    engine's and the capabilities' wire names reserved.** Production:
    `packages/loop/src/runtime/subagents/delegate-task.ts`; `packages/loop/src/runtime/tools/mcp-registry.ts`;
    `packages/mcp-client/src/registry.ts`. Test:
    `packages/loop/tests/integration/specialized-subagents.test.ts` (the child sees `info.lookup` and not
    `info.write`).

26. **A sub-agent has no `submit_result`.** `runSubagent` passes no `contract`, and `run-agent`
    only mints the submit tool and handler when one is present. Production:
    `packages/loop/src/runtime/subagents/run-subagent.ts`; `packages/loop/src/runtime/loop/run-agent.ts`.
    **Unpinned directly**; implied by `packages/loop/tests/unit/run-subagent.test.ts`, where a bare text
    turn completes the child.

27. **A profile naming a tool absent from the open pool fails the whole run before any model call,
    as `invalid_profile`.** Production: `packages/loop/src/runtime/subagents/subagent-profiles.ts`;
    `packages/loop/src/runtime/open-tool-pool.ts`. Test: `packages/loop/tests/unit/subagent-profiles.test.ts`
    (the predicate); the run-level refusal is **unpinned here**.

28. **`compaction.target_fraction` can never meet `context_fraction`: a 20 % hysteresis floor is
    enforced, not documented.** Production: `packages/loop/src/runtime/subagents/subagent-profiles.ts`. Test: `packages/loop/tests/unit/subagent-profiles.test.ts`.

29. **`spawn_subagent`, `delegate_task`, and the five `agent_*` names classify as `control` in the
    engine's tool-effect port.** Production: `packages/loop/src/runtime/tools/tool-effect.ts`
    (`CONTROL`). Test: `packages/loop/tests/unit/tool-effect.test.ts` (`classifies the engine's own
    control surface as control`).

30. **The four `agent_*` trace kinds never reach a client as a run event.** Production:
    `packages/trace/src/trace-mapper.ts` (mapped to `null`). **Unpinned here.**

31. **Independent spawning and tracked delegation are separate contracts.** `spawn_subagent` has no
    `task_id`, ignores surplus fields, and never manufactures a tracked task. `delegate_task` is
    advertised only when a `TaskTrackingPort` exists and requires the exact id of an existing open
    task. Production: `packages/loop/src/runtime/delegation.ts` (`buildDelegationContribution`),
    `packages/loop/src/runtime/subagents/lead-tools.ts` (`buildSpawnSubagentTool`,
    `buildDelegateTaskTool`), and `packages/loop/src/runtime/subagents/delegate-task.ts`
    (`validateDelegateTaskArgs`). Tests: `packages/loop/tests/unit/delegation-handler.test.ts`
    (`TaskTrackingPort seam`), `packages/loop/tests/unit/lead-tools.test.ts`, and
    `packages/loop/tests/unit/delegate-task.test.ts`.

## 6. Failure modes and degradation

| Condition | Handling | Cite |
| --- | --- | --- |
| Non-object / missing / empty `task` or `title` | plain `result`, `progress: false`, message names the field | `packages/loop/src/runtime/subagents/delegate-task.ts`; `packages/loop/src/runtime/delegation.ts` |
| Task (or task + exit condition) over 32 768 chars | plain `result` naming the limit and telling the model to shorten | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| Unknown / missing `profile` when several exist | plain `result` listing registered names | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| Missing, unknown, or closed `task_id` on `delegate_task` | plain `result` listing spawnable ids when available and directing independent work to `spawn_subagent` | `packages/loop/src/runtime/subagents/delegate-task.ts` (`validateDelegateTaskArgs`) |
| Surplus properties on either child-spawn tool | ignored once the known arguments validate; a surplus `task_id` on `spawn_subagent` creates no tracker association | `packages/loop/src/runtime/subagents/lead-tools.ts`; test `packages/loop/tests/unit/delegation-handler.test.ts` |
| `image_refs` on a blind profile / out of range / no images this turn | plain `result` explaining which | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| `preDelegateTask` hook returns `deny` | `<tool-name> DENIED by a workspace hook: <message>` | `packages/loop/src/runtime/subagents/delegate-task.ts` (`prepareSpawn`) |
| `preDelegateTask` hook throws or exceeds 30 s | **fails closed** — treated as a denial; a warning is logged under `event: "hook.verdict_failed"` | `packages/loop/src/runtime/subagents/delegate-task.ts`; `packages/loop/src/runtime/loop/lifecycle-hooks.ts` |
| `preDelegateTask` returns `rewrite` | **fails closed** as an unsupported rewrite: the spawn is denied, `hook.rewrite_unsupported` is logged, and the refusal message explains that this fire point has no rewritable action | `packages/loop/src/runtime/subagents/delegate-task.ts` (`rewritable: false`); `packages/loop/src/runtime/loop/lifecycle-hooks.ts`; test `packages/loop/tests/component/lifecycle-rewrite-refusal.test.ts` |
| `prepareSpawn` throws (e.g. a throwing `capabilitiesFor`) | `Tool '<name>' result: <name> error: <msg>`, `progress: false` | `packages/loop/src/runtime/delegation.ts` (`spawnHandler.handle`) |
| Tracker `beforeSpawn` ⇒ `refuse` | plain `result` with the tracker's text; **no** `delegation_created` is recorded | `packages/loop/src/runtime/delegation.ts`; test `packages/loop/tests/unit/delegation-handler.test.ts` |
| Tracker `beforeSpawn` ⇒ `terminal` | the agent ends with the tracker's own `AgentResult` | `packages/loop/src/runtime/delegation.ts`; test `packages/loop/tests/unit/delegation-handler.test.ts` |
| Registry sealed or at `maxLiveChildren` | background spawn refused as a plain `result` telling the model to `await_agents` or `agent_stop` | `packages/loop/src/runtime/delegation.ts` |
| `agent_registered` trace publication throws after background registry acceptance | the shared helper aborts, settles and closes the accepted child, then rethrows; the tool fails without leaking a live unadopted child | `registerBackgroundChild` in `packages/supervision/src/spawn-child.ts`; `packages/supervision/tests/component/spawn-child.test.ts` (`commits producer accounting before trace publication and abandons the child if it throws`) |
| `maxConsecutiveFailedChildren` reached | `terminal`, `error.code = "background_children_failing"`, message tells the model to `agent_poll` one and finish with what it has | `packages/loop/src/runtime/delegation.ts` |
| `background: true` with no registry | degrades silently to the inline `deferred` path | `packages/loop/src/runtime/delegation.ts`; test |
| Sub-agent run throws, parent not aborted | `Sub-agent error: <msg>`; tracker `markFailed`; `delegation_failed`; `failed: true` | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| Sub-agent run throws, parent aborted | `Sub-agent cancelled.`; tracker untouched; `failed` omitted | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| Sub-agent outcome `error` / `budget_exhausted` | rendered with its code/partial text; tracker `markFailed`; `failed: true` | `packages/loop/src/runtime/subagents/delegate-task.ts` |
| Background child throws or is stopped | `handle.settled({ status: "stopped" \| "failed", … })`; the parent learns of it through a notice at its next `beforeIteration`, or `agent_poll` | `packages/loop/src/runtime/delegation.ts`; `packages/loop/src/runtime/capabilities/agents.ts` |
| `agent_poll` with an invalid `match` regex | `Tool 'agent_poll' result (error): invalid 'match' regex: <why>` | `packages/loop/src/runtime/capabilities/agents.ts` |
| Any `agent_*` with an id the caller does not own | `Tool '<name>' result (error): unknown agent_id "<id>"; call agent_list for the ones you own.` | `packages/loop/src/runtime/capabilities/agents.ts` |
| `agent_steer` to a settled child | plain `result` (not an error): `"<id> has already settled (<status>); the steer was not delivered."`; trace records `delivered: false` | `packages/loop/src/runtime/capabilities/agents.ts` |
| `await_agents` on an empty scope | `{ woke_on: "none", still_running: [] }`, `progress: false` | `packages/loop/src/runtime/capabilities/agents.ts` |
| `await_agents` wait promise rejects | mapped to `timeout` | `packages/loop/src/runtime/capabilities/agents.ts` |
| Run finishes with live children, nudge budget spent | survivors `stop`ped with `"the run finished without them"`, registry sealed, `error.code = "agents_unfinished"` | `packages/loop/src/runtime/capabilities/agents.ts` |
| Teardown leaves children running / steers undelivered | run **warnings**, not errors; the run still returns | `packages/loop/src/runtime/capabilities/agents.ts` |
| Unresolvable provider on a sub-agent profile | the profile still resolves, just without `providerConfig` | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |
| Model with no declared `capabilities` | `capabilities` stays `undefined` ⇒ counts as **blind** for `image_refs` routing | `packages/loop/src/runtime/subagents/subagent-profiles.ts` |

## 7. Coupling

### Runtime, static (import edges out of this subsystem)

| Depends on | Via | What forces it |
| --- | --- | --- |
| `@clarvis/capability` | `packages/loop/src/runtime/subagents/delegate-task.ts`, `packages/loop/src/runtime/capabilities/agents.ts`, `packages/loop/src/runtime/subagents/lead-tools.ts` | the tool/verdict/port types, `parseDelegateTaskText`, `parseTaskTitle`, `projected`, `activationForScope`, `TASK_TRACKING_PORT`, `unref`, `createSemaphore` |
| `@clarvis/supervision` | `packages/loop/src/runtime/delegation.ts`, `packages/loop/src/runtime/capabilities/agents.ts`, `packages/loop/src/runtime/entry-inputs.ts` | `AgentRegistry`, `registerBackgroundChild`, `AGENTS_CAPABILITY_NAME`, `AGENT_REGISTRY_PORT`, `resolveAgentsLimits` |
| `@clarvis/mcp-client` | `packages/loop/src/runtime/tools/mcp-registry.ts` (re-exported to `packages/loop/src/runtime/subagents/delegate-task.ts`) | `selectTools`, `buildRegistry`, `RegistryEntry` |
| `runtime/loop/**` | `packages/loop/src/runtime/subagents/delegate-task.ts`, `packages/loop/src/runtime/subagents/run-subagent.ts`, `packages/loop/src/runtime/delegation.ts` | `runVerdictHooks`, `fireObservers`, `runAgent`, `toLlmTarget`, `AgentBuildContext`, `HandlerVerdict` |
| `runtime/tools/wire-names.ts` | `packages/loop/src/runtime/subagents/lead-tools.ts`, `packages/loop/src/runtime/capabilities/agents.ts` | the six wire names; the module is dependency-free on purpose (`packages/loop/src/runtime/tools/wire-names.ts`) |

### Runtime, dynamic / late-bound

- **The task tracker.** Delegation never names the package that provides it. The capability resolves
  `deps.services?.get(TASK_TRACKING_PORT)?.forAgent(bc)` at *attach* time
  (`packages/loop/src/runtime/capabilities/delegation.ts`), and every use is `ctx.tasks?.…`. Its absence means no
  `task_id` property, no augmented description and no pre-spawn gate
  (`packages/loop/src/runtime/delegation.ts` TSDoc). `prepareSpawn`'s own `tasks.markSpawned(taskId)`
  (`packages/loop/src/runtime/subagents/delegate-task.ts`) and the handler's subsequent `deps.tasks?.noteSpawned(prepared.taskId)`
  (`packages/loop/src/runtime/delegation.ts`) are two separate calls into the port for the same spawn, not one call under
  two names — a tracker implementation must handle both without assuming one implies the other was
  skipped. The port itself is declared once, owner-neutrally,
  at `packages/capability/src/task-tracking-port.ts`. Pinned with a hand-rolled fake at
  `packages/loop/tests/unit/delegation-handler.test.ts`, whose fixture comment reads "every case below
  would read the same against a tracker over, say, a list of GitHub issues."
- **The child's inherited capabilities.** `SubagentCapabilitiesFactory` is a closure over
  `activationForScope(deps.runCapabilities, { agent: "subagent", entry: false, grants, clock?,
  signal?, elicit? })` — the last three forwarded from the *lead's own* `AgentScope`/`deps` whenever
  present (`scope.clock`, `scope.signal`, `deps.elicit`), not only `grants`
  (`packages/loop/src/runtime/capabilities/delegation.ts`), so grant-gating is the capability's own decision,
  not delegation's. Forwarding `elicit` means a sub-agent-scoped capability can in principle be
  handed the run's human-elicitation callback through this path.
- **The supervision registry.** Reached off the run's service registry
  (`packages/loop/src/runtime/entry-inputs.ts`), published by the orchestrator (`packages/loop/src/runtime/orchestrator.ts`).
  `DelegationDeps.agents` is optional and its absence is the *only* thing that makes
  `background: true` degrade rather than fail (`packages/loop/src/runtime/delegation.ts`).

### What depends on this subsystem

| Consumer | Edge | Kind |
| --- | --- | --- |
| `runtime/orchestrator.ts` | `resolveSubagentProfiles`, `resolveIterationCap`, `canSpawnChildren` | static value |
| `runtime/entry-inputs.ts` | `createDelegationRunCapability`, `createAgentsRunCapability`, `buildSubagentInputPersona`, `buildLeadInputPersona`, `userText` | static value |
| `runtime/run-shape.ts` | `ResolvedSubagentProfile`, `SubagentProfileRegistry` | type-only |
| `runtime/entry-seed.ts` | `buildSystemSections`, `collectTurnImages` | static value |
| `runtime/open-tool-pool.ts` | `findInvalidToolRef` | static value |
| `runtime/tools/tool-effect.ts` | both child-spawn names from the engine's wire-name vocabulary | static value |
| `packages/loop/src/lib.ts` | `DELEGATION_CAPABILITY_NAME` | the only public export |

### Deliberately absent edges

- Nothing here imports `@clarvis/plan`, `@clarvis/workflows` or `@clarvis/kernel`. The tracker
  arrives entirely through `TASK_TRACKING_PORT`.
- `build-subagent-input.ts` derives its shell line locally rather than importing
  `@clarvis/tools`; the TSDoc gives the reason: "That package is an
  `optionalDependency` of the engine, and a run configured with `builtins.tools = false` still has a
  system prompt."
- `packages/loop/src/runtime/tools/wire-names.ts` keeps the five supervision names out of the capability that implements
  them "so a consumer gating on them can name them without importing that capability."

## 8. Open questions

1. **The short `title` never reaches the supervision panel.** The `title` property's description
   says it is "shown to the operator on the sub-agent panel"
   (`packages/loop/src/runtime/subagents/lead-tools.ts`), but `PreparedSpawn` carries no `title`
   (`packages/loop/src/runtime/subagents/delegate-task.ts`) and `spawnInBackground` registers the child with
   `title: prepared.subagentTask` — the full brief, possibly with the exit condition appended
   (`packages/loop/src/runtime/delegation.ts`). `AgentListEntry.title` is that value verbatim
   (`packages/supervision/src/registry.ts`), truncated to 60 chars only in the registry's own
   log line (`packages/supervision/src/registry.ts`). Whether this is intended is not stated
   in the source.

2. ~~**`validateDelegateTaskArgs`'s TSDoc mentions an `image` grant that the code does not check.**~~
   **Resolved by striking the clause.** The remark now says what the two agreeing witnesses said —
   the chosen profile's *model* must declare the `vision` capability, and no grant is consulted
   (`packages/loop/src/runtime/subagents/delegate-task.ts`). The implementation is unchanged
   (`selected?.capabilities?.has("vision")`), as is the model-facing description
   (`packages/loop/src/runtime/subagents/lead-tools.ts`). The internal doc was the lone dissenter,
   so it was the one corrected: adding the grant check instead would have been inventing a contract
   from a sentence rather than reading one.

3. **`DelegateTaskContext.steer` and `.computeRegion` are only ever set on the background path.**
   Both fields are declared with TSDoc describing a general mechanism
   (`packages/loop/src/runtime/subagents/delegate-task.ts`), but `buildDelegationContribution`'s `spawnCtx`
   never populates them (`packages/loop/src/runtime/delegation.ts`) and only `spawnInBackground` supplies them. Whether inline steering is a deliberate non-goal or an unfinished path is not
   recorded in code.

4. ~~**A `preDelegateTask` `rewrite` verdict is dropped.**~~ **Resolved — by refusing
   it, not by honouring it.** The reading was right about the code: `runVerdictHooks` computed a
   `rewritten` that `prepareSpawn` never read, so a hook that replaced a delegation's brief watched
   the original brief spawn anyway and was told nothing. Resolving it the other way — threading the
   replacement into the spawn — would have rebuilt at a second site the non-silence the first site
   already provides, so the spawn now **denies** instead: `prepareSpawn`'s sweep passes
   `rewritable: false` (`packages/loop/src/runtime/subagents/delegate-task.ts`), and a `rewrite`
   arriving there resolves through the same `onThrow: "deny"` path a thrown hook does, carrying
   `UNSUPPORTED_REWRITE_MESSAGE` (`packages/loop/src/runtime/loop/lifecycle-hooks.ts`,
   refused). Output a fire point cannot act on is a hook that failed to rule, not a
   ruling.

   The type system carries the same rule ahead of the runtime. `@clarvis/capability` now splits
   `GateVerdict` — `pass`/`deny`/`advise`, "a lifecycle hook's ruling where the action cannot be
   rewritten" (`packages/capability/src/api.ts`) — from `HookVerdict`, which is that plus
   `rewrite`. `beforeToolUse` takes the wider type and `afterToolUse`, `preFinalize`
   and `preDelegateTask` take the narrower one, so a hook this compiler can see is a
   compile error rather than a verdict computed and then dropped; the runtime refusal covers the
   hooks it cannot see.

   No capability is lost, which is why refusing is the right answer rather than the cheap one.
   both child-spawn tools are dispatched through the ordinary tool loop, so a
   `beforeToolUse`/`pre_tool_use` hook matching either one already replaces the brief *and* the
   profile, upstream of the spawn's own
   validation and of the command guard — and does it non-silently, which `preDelegateTask` could
   not: the replacement travels as a new call object so the assistant message already in context
   keeps what the model sent (`packages/loop/src/runtime/loop/loop.ts`), the model is told
   through the `[advisor]` channel, and a dispatch that writes a tool-call record carries
   `arguments_original` beside the executed `arguments`
   (`packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts`). All four are
   pinned by `packages/loop/tests/component/delegate-task-pre-tool-use-rewrite.test.ts` — the hook's
   profile and brief reach `delegation_created`, the model is told what actually ran, the assistant message is untouched while the spawn diverges, and the model's
   own choice spawns when no hook rewrites. The refusal itself is pinned by
   `packages/loop/tests/component/lifecycle-rewrite-refusal.test.ts`: the spawn is denied and the
   message names the channel that does work, the sub-agent the hook believed it had
   redirected never runs, the refusal reaches the diagnostic channel, it
   short-circuits a later hook exactly as a denial does, and every verdict a
   `preDelegateTask` hook may legitimately return still spawns. `preFinalize` is covered the
   same way, holds the control: the identical verdict is still
   honoured where the caller genuinely substitutes the arguments, and refused the moment the caller
   declares it has nothing to rewrite.

5. **Several invariants are unpinned** (7, 8, 9, ~~16, 17,~~ 18, 23-combined-ceiling, 26,
   27-run-level, 29, 30 in §5). ~~The most consequential gaps are the fail-closed
   `preDelegateTask` throw (16) and the "cancellation never touches the tracker" rule (17): both are
   small guards whose removal would be silent.~~ **Resolved** for the two named as most
   consequential: 16 and 17 now carry tests, each guarded assertion paired with a control that proves
   the path is reached. The rest of the list stands.

6. **Delegated to sibling documents, deliberately not described here:** the registry's internals —
   id minting, the per-child activity buffer and its caps, the trace→activity projection, the steer
   queue, `teardown`'s grace semantics and the `agents:` settings block — belong to
   [supervision-registry](../foundations/supervision.md); workflow **leader** spawns (`run_leader` and friends, and the
   `spawn_run` tool effect) to [workflows-scheduling-and-spawn](../capabilities/workflows-scheduling.md); the plan session behind
   `TaskTrackingPort` to [plan-capability-and-review](../capabilities/plan-capability.md); the prefix-stability economics of the child's
   seed and of the parent's transcript to [prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md); the dispatch loop
   around `HandlerVerdict` (including how a `deferred` is joined) to
   [loop-tool-dispatch-and-results](tool-dispatch.md) and [loop-run-lifecycle](loop-run-lifecycle.md).

7. ~~**`runtime/subagents/index.ts` re-exports `lead-tools`, `delegate-task` and
   `subagent-profiles` but not `run-subagent`, `build-subagent-input` or `build-lead-input`.**~~
   **Resolved — deleted.** Why it was partial is not stated and did not need to be: no
   `src` file imported through it at all — its only importers were **five test files**, so it had
   grown to exactly the set the suite happened to want. Its own header nonetheless called it "public
   surface of the subagents runtime", a claim `src` did not honour, and a second import path for the
   same symbols is the shape `@clarvis/loop` already removed once — its general internal barrel is
   gone and, by the repository's own rule, must not return. The five test files now import by direct
   path like everything else.
