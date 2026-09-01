# The capability contract and the shared run vocabulary

> Implemented at `packages/capability/src/**` and `packages/capability/tests/**`. Every claim below
> is anchored to a file and line. Open questions are collected in the final section.

## 1. Purpose

`@clarvis/capability` is a package with one runtime dependency, `zod`
(`packages/capability/package.json:50-52`), and no internal ones. It holds two things that the rest
of the monorepo is written against.

The first is the **capability contract**: a four-level lifecycle
(`Capability` -> `RunCapability` -> `AgentCapability` -> `AgentLoopContribution`,
`packages/capability/src/contract.ts:6-12`) plus the machinery that folds a list of such
contributions into the single tool/handler/gate bundle a loop consumes
(`packages/capability/src/compose.ts:83`). Alongside it sit the registries that make a capability
declarable from outside the engine: a settings-block registry
(`packages/capability/src/registry.ts:48`), a per-run typed port registry
(`packages/capability/src/services.ts:82`), and the `PortKey` mechanism that lets one capability
reach another without importing it (`packages/capability/src/services.ts:1-16`).

The second is the **shared run vocabulary** — the request, message, agent-profile, usage, status,
error-code, LLM-port and tool-call types that every layer above it names. Several of these
vocabularies are deliberately *open* unions (`TraceKind`, `ErrorCode`, `RunEndedReason`,
`AgentErrorCode`), each shipped as a runtime list plus a narrowing predicate, so a capability living
in its own package can terminate, fail and record under names the engine never declared
(`packages/capability/src/run.ts:28-48`, `:206-227`; `packages/capability/src/agent-result.ts:21-31`).
Eight of its modules are type-only and emit nothing at runtime, as recorded in the coverage
allowlist at `tooling/checks/coverage.ts:73-83`; the package's coverage floor is 100% functions and
100% lines (`tooling/checks/coverage.ts:28`).

## 2. Surface

### 2.1 Package identity and entrypoints

| Field | Value | Source |
|---|---|---|
| `name` | `@clarvis/capability` | `packages/capability/package.json:2` |
| release identity | private, unversioned workspace; root manifest owns the Clarvis product version | `packages/capability/package.json` (`private`, no `version`); root `package.json` (`version`) |
| `dependencies` | `zod: ^4.4.3` only | `packages/capability/package.json:50-52` |
| `engines.bun` | `>=1.4.0` | `packages/capability/package.json:34-36` |
| Test layout | `test` = unit, then integration, then architecture | `packages/capability/package.json:40` |

| Subpath | `bun` condition | `types` | `import` |
|---|---|---|---|
| `.` | `./src/index.ts` | `./dist/index.d.ts` | `./dist/index.js` |
| `./ports` | `./src/ports.ts` | `./dist/ports.d.ts` | `./dist/ports.js` |
| `./trace` | `./src/trace.ts` | `./dist/trace.d.ts` | `./dist/trace.js` |
| `./package.json` | literal passthrough | — | — |

`packages/capability/package.json:12-28`. `./trace` exists so a capability that only records events
does not pull the whole contract in, and so the open/closed split is visible at the import site
(`packages/capability/src/trace.ts:1-8`). `./ports` is the narrow set of interfaces a capability is
written against, deliberately the measured minimum
(`packages/capability/src/ports.ts:3-12`). Trace kinds, events and the `Logger` port are delegated
to [trace-recording-and-persistence](trace.md) and [observability-and-diagnostics](../cross-cutting/observability.md).

### 2.2 The contract lifecycle

| Level | Interface | Produced by | Cardinality |
|---|---|---|---|
| Registration | `Capability` (`packages/capability/src/contract.ts:132`) | the host | process-lifetime, or per-run for a session-bound host (`packages/capability/src/contract.ts:127-131`) |
| Run | `RunCapability \| null` (`packages/capability/src/contract.ts:219`) | `Capability.forRun(ctx)` (`packages/capability/src/contract.ts:192`) | one per run, `null` = not used this run |
| Agent | `AgentCapability \| null` (`packages/capability/src/contract.ts:300`) | `RunCapability.forAgent(scope)` (`packages/capability/src/contract.ts:252`) | one per agent, `null` = this agent does not get it |
| Loop | `AgentLoopContribution` (`packages/capability/src/contract.ts:307`) | `AgentCapability.attach(bc)` (`packages/capability/src/contract.ts:303`) | one per agent loop |

`Capability` members:

| Member | Type | Notes |
|---|---|---|
| `name` | `string` | `packages/capability/src/contract.ts:133` |
| `persistedTraceProjectors?` | `readonly PersistedTraceProjector[]` | static, collected before activation (`packages/capability/src/contract.ts:135`) |
| `grants?` | `readonly CapabilityGrantDeclaration[]` | added to the request vocabulary before validation (`packages/capability/src/contract.ts:137`) |
| `seedMarker?` | `string` | collected from every **registered** capability, active or not (`packages/capability/src/contract.ts:139-144`) |
| `reservedWireNames?` | `readonly string[]` | same registered-not-active rule (`packages/capability/src/contract.ts:146-154`) |
| `toolEffects?` | `Readonly<Record<string, ToolEffect>>` | keyed by wire name; deliberately separate from reservation (`packages/capability/src/contract.ts:155-171`) |
| `requiresUserInput?(view)` | `boolean` | consulted *before* any `forRun` (`packages/capability/src/contract.ts:172-182`) |
| `forRun(ctx)` | `Promise<RunCapability \| null> \| RunCapability \| null` | `packages/capability/src/contract.ts:192` |

A `Capability` declares itself with a `CapabilityGrantDeclaration` (`packages/capability/src/contract.ts:75-80`): `name` (the
exact grant profiles may carry) and an optional `entryCanSpawn` (whether the grant lets a non-lead
entry agent produce supervised children). This is the shape `CapabilityRegistry.registerGrant`
actually stores (§4.3).

`Capability.forRun(ctx)` receives a `RunCapabilityContext` (`packages/capability/src/contract.ts:85-125`), which extends
`CapabilityRequestView` (`request`, `requestParam(key)`, `packages/capability/src/contract.ts:67-72`) with:

| Field | Type | Note |
|---|---|---|
| `owner` | `string` | `:86` |
| `entryGrants` | `readonly string[]` | `:87` |
| `env` | `EnvConfig` | `:88` |
| `workspaceRoot` | `string` | `:89` |
| `llm` | `LLMProvider` | `:90` |
| `elicit?` | `Elicit` | the host's raw elicit channel, when the MCP client supports elicitation (`:92`) |
| `logger?` | `Logger` | `:93` |
| `emit` | `CapabilityEventListener` | emit a host-visible event; listener throws are swallowed by the engine (`:95`) |
| `signal?` | `AbortSignal` | long work in `forRun`/`seedBlock` should observe it (`:97`) |
| `priorState?` | `Record<string, unknown>` | the prior run's `capability_state`, keyed by capability name; absent for a fresh run or a capability that wrote nothing (`:98-106`) |
| `services` | `CapabilityServices` | published before any `forRun` runs; a capability publishes its own ports here and a consumer reads them at `attach` time (`:107-115`) |
| `executionId` | `string` | the run's resolved execution id — the same id its trace persists under (`:116-124`) |

`RunCapability` members: `name` (`:220`), `order?: number` default `0` (`:231`), `seedBlock?()`
(`:239`), `systemSection?(id)` (`:247`), `lifecycle?: readonly LifecycleHook[]` (`:250`),
`forAgent(scope)` — the only required method besides `name` (`:252`), `onRunEnd?(record)` (`:264`),
`finalizeRun?({status})` (`:283`), `guardTripCodes?: readonly string[]` (`:293`).

`AgentLoopContribution` members: `tools?`, `handlers?`, `gates?`, `anchor?`, `forcedChoice?`,
`hooks?`, `outputBudget?`, `advertised?` (`packages/capability/src/contract.ts:307-327`). `advertised` defaults to `true`
and `false` marks a prompt-driven tool that should not count toward `availableWireNames`
(`packages/capability/src/contract.ts:321-326`).

### 2.3 Composition machinery — exported values

| Symbol | Signature | Defined at |
|---|---|---|
| `projected` | `(event: CapabilityEvent) => CapabilityEvent` | `packages/capability/src/contract.ts:354` |
| `capabilitiesForScope` | `(caps \| undefined, scope) => AgentCapability[]` | `packages/capability/src/compose.ts:43` |
| `systemSectionsFor` | `(caps \| undefined, id) => string[]` | `packages/capability/src/compose.ts:53` |
| `activationForScope` | `(caps \| undefined, scope) => AgentActivation` | `packages/capability/src/compose.ts:63` |
| `foldContributions` | `(readonly AgentLoopContribution[]) => FoldedContributions` | `packages/capability/src/compose.ts:83` |
| `createCapabilityRegistry` | `(seed?: CapabilityRegistrySeed) => CapabilityRegistry` | `packages/capability/src/registry.ts:48` |
| `composeCapabilityRegistry` | `(base \| undefined, declarations) => CapabilityRegistry` | `packages/capability/src/registry.ts:86` |
| `createCapabilityRequestView` | `(request: RunRequest) => CapabilityRequestView` | `packages/capability/src/services.ts:21` |
| `portKey` | `<T>(id: string) => PortKey<T>` | `packages/capability/src/services.ts:48` |
| `createCapabilityServices` | `() => CapabilityServices` | `packages/capability/src/services.ts:82` |
| `requestParamKeys` | `(specs) => string[]` | `packages/capability/src/settings-spec.ts:55` |
| `handlerBaseOf` | `(bc: AgentBuildContext) => HandlerBase` | `packages/capability/src/handler-base.ts:26` |
| `openCallEnvelope` | `(a: CallEnvelopeArgs) => CallEnvelope` | `packages/capability/src/call-envelope.ts:68` |
| `memoizeByOwner` | `<T>(build: (owner) => T) => (owner) => T` | `packages/capability/src/per-owner.ts:14` |
| `sharedFallback` | `<T>(build: () => T) => (owner) => T` | `packages/capability/src/per-owner.ts:43` |
| `TOOL_EFFECT_PORT` | `PortKey<ToolEffectPort>` with id `"tools.effect"` | `packages/capability/src/tool-effect.ts:45` |
| `TASK_TRACKING_PORT` | `PortKey<TaskTrackingProvider>` with id `"delegation.task-tracking"` | `packages/capability/src/task-tracking-port.ts:66` |
| `createPersistedTraceProjectorRegistry` / `composePersistedTraceProjectors` | see `packages/capability/src/trace-projectors.ts:34`, `:64` | delegated to [trace-recording-and-persistence](trace.md) |

### 2.4 Shared run vocabulary — exported values

| Symbol | Kind | Defined at |
|---|---|---|
| `BUILTIN_RUN_ENDED_REASONS`, `isBuiltinRunEndedReason` | 8-item tuple + guard | `packages/capability/src/run.ts:14`, `:46` |
| `BUILTIN_ERROR_CODES`, `isBuiltinErrorCode` | 42-item tuple + guard | `packages/capability/src/run.ts:158`, `:225` |
| `BUILTIN_AGENT_ERROR_CODES` | 7-item tuple | `packages/capability/src/agent-result.ts:8` |
| `partialStructOf` | `(lastSubmitAttempt) => {partialStructured} \| {}` | `packages/capability/src/agent-result.ts:69` |
| `EXECUTION_STATUSES` | 6-item tuple | `packages/capability/src/execution-status.ts:16` |
| `ProviderError` | class, `code = "provider_error"` | `packages/capability/src/llm-port.ts:294` |
| `CodedError`, `ValidationError`, `ConflictError`, `PersistenceError`, `ContinuationUnavailableError`, `executionIdConflict` | error classes + factory | `packages/capability/src/errors.ts:10`, `:30`, `:49`, `:65`, `:83`, `:103` |
| `MALFORMED_ARGUMENTS_PREVIEW_CHARS` = `200`, `normalizeToolArguments`, `malformedArgumentsMessage` | argument decoding | `packages/capability/src/tool-arguments.ts:8`, `:57`, `:87` |
| `DELEGATE_TASK_MAX_CHARS` = `32768`, `parseDelegateTaskText` | brief validation | `packages/capability/src/delegate-task.ts:2`, `:17` |
| `TASK_TITLE_MAX` = `60`, `parseTaskTitle` | title validation | `packages/capability/src/task-title.ts:2`, `:18` |
| `splitFrontmatterFence` | markdown fence split | `packages/capability/src/frontmatter-fence.ts:81` |
| `escapeRegExp`, `globToRegExp` | `*`-only glob | `packages/capability/src/glob.ts:17`, `:30` |
| `contentToText` | `MessageContent -> string` | `packages/capability/src/message-content.ts:10` |
| `bestEffort`, `detachObserved`, `suppressSecondaryRejection` | failure-tolerant task helpers | `packages/capability/src/tasks.ts:49`, `:58`, `:63` |
| `unref` | best-effort timer unref | `packages/capability/src/unref.ts:7` |
| `capabilitySkillPlansModeSchema`, `capabilityRunPoliciesSchema` | zod | `packages/capability/src/capability-run-policies.ts:4`, `:7` |
Everything else re-exported from `index.ts` is either type-only or belongs to a delegated module:
`hooks-config` (hooks-execution), `env*` and `sanitize` (security-confinement-and-redaction),
`log` (observability-and-diagnostics), `compute-clock` / `output-budget` / `semaphore` /
`extension-admission` (loop-budgets-clocks-and-guards), `elicit` (elicitation-and-user-interaction),
`capability-executables` (capability-provider-executables), `model-ref` / `provider-resolver` /
`reasoning-budget` (model-catalog-and-provider-resolution), and the trace modules
(trace-recording-and-persistence).

### 2.5 Settings-spec declaration surface

`CapabilitySettingsSpec` (`packages/capability/src/settings-spec.ts:33`) is what a capability living in its own package hands
a host:

| Field | Type | Meaning |
|---|---|---|
| `key` | `string` | the block key in `settings.json` and, when allowed, in a plugin manifest (`:35`) |
| `schema` | `z.ZodType` | the unwrapped block schema; composition applies optional/describe (`:37`) |
| `merge` | `"lastWins" \| (scopes) => unknown` | how stacked settings scopes combine (`:27-28`, `:39`) |
| `pluginContributable` | `boolean` | whether an enabled plugin's manifest may contribute the block (`:41`) |
| `pluginDescription?` | `string` | manifest describe text (`:43`) |
| `pluginForbiddenReason?` | `string` | explanatory rejection declared as a `z.undefined` field when not contributable (`:44-49`) |
| `requestParams?` | `z.ZodRawShape` | per-run request parameters (`:51`) |

`SettingsValueScope` carries `origin: "plugin" \| "operator"` and the value
(`packages/capability/src/settings-spec.ts:16-22`).

### 2.6 The narrow ports (`./ports`)

| Port | Members | Defined at |
|---|---|---|
| `ContextPort` | `appendNote`, `setStableBlock(kind, content)`, `setCanonicalState(content)` | `packages/capability/src/ports.ts:81-88` |
| `TracePort` | `record<K>(kind, detail)`, `signal<K>(kind, detail)`, `now(): number` | `packages/capability/src/ports.ts:98-127` |
| `Logger`, `LogFn` | four levels + optional `child`/`level` | `packages/capability/src/ports.ts:22-72` (delegated) |

`./ports` additionally re-exports `Elicit` and friends, `AgentRegistryPort`, `LLMProvider` and
`ToolChoice` (`packages/capability/src/ports.ts:129-138`). The stated rule is that the loop's `LiveContext` (~50 members) and
`TraceHandle` satisfy `ContextPort`/`TracePort` **structurally**, with no adapter and no cast
(`packages/capability/src/ports.ts:7-11`).

### 2.7 The run/message/agent-profile vocabulary (`api.ts`)

`api.ts` is the request/message/hook vocabulary the rest of the package — and every layer
above it — programs against.

**Messages and content.** `MessageRole` (`packages/capability/src/api.ts:2`) is `system | user | assistant`; a `TextPart`
(`:5-8`) or `ImagePart` (`:11-15`, `image` + optional `mediaType`) makes up a `ContentPart` (`:18`), and
`MessageContent` (`:21`) is a bare string or an array of them. `Message` (`:24-27`) pairs a role with
content. `AssistantMessagePhase` (`:102`) is `commentary | final_answer`, and `AssistantTextPart`
(`:111-115`) retains one assistant text block, its optional public phase, and opaque provider replay
metadata. `LiveMessage` (`:124-140`) is the loop's runtime superset: a plain `Message`; assistant turns
carrying `reasoning`, retained `text_parts`, or `tool_calls`; or a `tool` turn keyed by `tool_call_id`
with optional `images`. `SteerMessage` (`:35-38`, `content` + optional
`id`) is drained from a `SteerSource` (`:45-51`, pull-based, optional `close()`); `CompactionRequest`
(`:61-63`, an optional additive `request` string that "can never replace the agent profile's base
compaction prompt") is drained from a `CompactionSource` (`:66-71`) the same way. `ToolCallRef`
(`:74-78`) and `ToolResultImage` (`:81-84`) are the model-call-boundary shapes; `AssistantReasoningPart`
(`:96-99`) carries opaque `providerOptions` a provider adapter alone interprets, so replay stays
provider-neutral at the loop.

**Providers and models.** `ToolTransport` (`:120`) is `stdio | http | sse`; `AgentRole` (`:123`) is
`lead | subagent`. `McpServerConfig` names one server, its transport-specific fields, optional stdio
`cwd`, interpolation policy `expandVariables`, `shared`/`resources` flags, OAuth or environment-backed
remote credentials, explicitly forwarded stdio environment names, per-server timeouts, enablement
and requiredness, tool allow/deny filters, installer authentication timing, and the host-composition
flag `auto_tools`. The last flag admits every retained tool the opened server actually advertises to
every effective agent for that run; it does not mutate an authored profile or alter transport
identity. `McpOAuthConfig` supports a pre-registered client id, configured callback URL or port, and
an HTTPS client-metadata URL for CIMD.
`ProviderKind`
(`:214-215`) is `openai-compatible | openai | anthropic |
google | openai-codex | xai-grok`; the final two select renewable subscription billing boundaries
over the native OpenAI Responses adapter. `PromptCacheMode`
(`:232`) is `explicit | implicit | off`; its doc-comment states absence is deliberately not `off` — "it
means nobody has decided," and a host with a pricing catalog is expected to resolve it (`:217-230`).
`ModelConfig` (`packages/capability/src/api.ts:244-252`) carries `context_window_tokens`,
`max_output_tokens`, `capabilities`, provider-published `reasoning_efforts`, `prompt_cache`, and
per-model `headers`/`body` overrides; `ProviderConfig` (`:270-278`) carries the
provider-wide `kind`/`base_url`/`api_key_env`/`headers`/`body`/`models`, with the doc-comment
restricting `body` from carrying a key that is the cached prefix (`messages`, `tools`) or that
contradicts the resolved call (`model`, `stream`, `tool_choice`, `stream_options`) (`:254-268`). The
four-row `promptCache` resolution table (which value maps to which behavior on `anthropic` versus
`openai-compatible`) lives on `ResolvedProviderConfig` in `llm-port.ts`, not here — see §3.7.

**Budget and grants.** `BudgetMode` (`:280-295`) is `stop | escalate`; `BudgetConfig` (`:297-315`) is
`on_exceed` plus optional `total_token_limit`/`timeout_ms`/`max_escalations`. `BuiltinGrant`
(`:317-318`) is the engine's own four grants (`ask_user`, `read_workspace`, `edit_workspace`,
`run_commands`); `Grant` (`:320-326`) opens it the same way `ErrorCode` opens, because its doc-comment
states "external capability grant names are registered before request validation rather than added to
this union" (`:323-324`). `ReasoningSummary`
(`:328-329`) and `ReasoningEffort` (`:331-332`) are the two reasoning-tuning enums.

**Per-agent overrides and `AgentProfile`.** `CompactionConfigInput` (`:334-354`), `RetryConfigInput`
(`:356-364`) and `OrchestrationConfigInput` (`:366-379`; its doc-comment at `:369-375` calls
`force_tool_on_nudge` "a property of the agent's own loop, applied by the loop rather than by
whichever capability raised the nudge") are the
three per-agent override blocks. `AgentProfile` (`:381-409`) is the full agent definition: `name`,
`description?`, `model`, `base_prompt?`, `tools`, `grants?`, `can_spawn?`/`default_spawn?` (delegation),
`iteration_limit?`/`stagnation_threshold?`/`call_timeout_ms?`, and the three override blocks above.

**`RunRequest` (`:445-489`).** The complete input to one loop run:

| Field | Type | Note |
|---|---|---|
| `execution_id?` | `string` | a clash raises `execution_id_conflict` |
| `continue_from?` | `string` | resumes a prior run's persisted trace |
| `prompt_cache_key?` | `string` | defaults to the execution id |
| `prompt_cache_ttl?` | `PromptCacheTtl` (`:430-443`, `5m \| 1h`) | Anthropic-only; see below |
| `messages` | `Message[]` | seed conversation |
| `servers` | `McpServerConfig[]` | — |
| `profiles` | `AgentProfile[]` | — |
| `entry` | `string` | profile to start from |
| `vision_model?` | `string` | a model reference, not a profile — reads the turn's images in a single-completion, no-tools, no-workspace, no-agent-identity pass, when the entry agent's own model cannot see them (`:454-462`) |
| `budget` | `BudgetConfig` | — |
| `providers` | `ProviderConfig[]` | — |
| `output_schema?` | `unknown` | constrains the agent's result |
| `elicit_wait_ms?` | `number` | bounds user elicitation |
| `guard_escalation?` | `boolean` | whether a hard convergence-guard trip asks the user; off by default, deliberately not inferred from elicit-channel presence — a headless caller's auto-declining channel would otherwise add a prompt round-trip to every trip with no change in outcome (`:467-476`) |
| `agents?` | `AgentsParam` (`:507-519`) | see below |
| `guard_mode?` | `GuardMode` (`:521-522`, `off \| on \| auto`) | — |
| `guard_judge?` | `GuardJudgeConfig` (`:524-531`) | judge `prompt`, optional `model`/`on_unsure`/`timeout_ms` |
| `hook_user_prompt_expansion?` | `{ command_name: string }` | host-derived context for the one user-invoked skill expansion that seeded the run; ordinary prompts and model-initiated skill loads omit it (`:480-488`) |

`PromptCacheTtl`'s doc-comment states Anthropic bills a `5m` write at 1.25x base input and a `1h` write
at 2x, a read at 0.1x either way (`:430-443`). A capability shipped in its own package takes its
per-run param through a registered `CapabilitySettingsSpec` instead — which is why `memory` and `plans`
are not fields here (`:425-428`).

`AgentsParam` (`:491-519`) is ten ceilings the doc-comment describes as bounding what the supervising
*parent* pays for — memory, context, or liveness — with no on/off field, because whether the surface
exists follows from whether the run's entry agent can spawn at all: `buffer_lines`, `buffer_bytes`,
`max_total_buffer_bytes`, `poll_max_bytes`, `await_timeout_ms`, `max_live_children`,
`max_retained_children`, `max_notices_per_iteration`, `max_consecutive_failed_children`,
`finish_nudges`. Why exactly these ten, and no others, is not stated anywhere in the file.

`BudgetConfig` (`:297-315`) models only `stop`/`escalate` outcomes for an exceeded budget;
`BudgetMode` explains why that pair is closed (`:280-295`).

**`HandlerResult` and the hook vocabulary.** `HandlerResult` (`:540-545`) is `text`, `progress`
(feeds stagnation detection), optional `taskId`, optional `images`. `HookVerdict` (`:585`) is
`pass | deny(message) | advise(message) | rewrite(arguments, message?)`; the doc-comment states
`rewrite` is meaningful only for `beforeToolUse` and is safe because a rewrite happens *upstream* of
both the tool's own schema validation and the command guard, and that the replacement is total, never a
merge (`:562-585`). `LifecycleHook` (`:742-767`) bundles four verdict-returning gates
(`beforeToolUse`, `afterToolUse`, `preFinalize`, `preDelegateTask`), eight `void` observers
(`onRunStart`, `onRunEnd`, `onSubagentStart`, `onSubagentComplete`, `onPostCompact`,
`onModelCallError`, `onBudgetExhausted`, `onUserSteer`), and the contribution-returning
`onPreCompact`; all thirteen are optional. Their contexts:

| Context | Fields | Cite |
|---|---|---|
| `BeforeToolUseContext` | wire `tool`, optional stable `toolFullName`, `arguments` | `:587-594` |
| `AfterToolUseContext` | wire `tool`, optional stable `toolFullName`, `arguments`, read-only `result: HandlerResult` | `:596-604` |
| `PreFinalizeContext` | `agent`, `subagentInstanceId?`, `mode: "text" \| "submit"`, `text?`, `value?` | `:606-623` |
| `PreDelegateTaskContext` | `title`, `task`, `profile`, `taskId?` | `:625-631` |
| `RunStartContext` | `mode`, `entry`, `leadModel?`, `subagentModel?` | `:633-639` |
| `RunEndContext` | `status`, `errorCode?`, `iterationsUsed`, `elapsedMs` | `:641-647` |
| `SubagentStartContext` | `subagentInstanceId`, `profile`, `model`, `task` | `:656-662` |
| `SubagentCompleteContext` | `subagentInstanceId`, `status`, `result` | `:649-654` |
| `PreCompactContext` | `agent`, `subagentInstanceId?`, `estimatedTokens` | `:664-669` |
| `PostCompactContext` | `agent`, `subagentInstanceId?`, `operation`, `freedChars?`, `keptChars?` | `:671-678` |
| `ModelCallErrorContext` | `agent`, `subagentInstanceId?`, `iteration`, `model`, `message` | `:709-716` |
| `BudgetExhaustedContext` | `agent`, `reason: "exhausted" \| "declined"`, `tokensUsed`, `iterationsUsed` | `:718-724` |
| `UserSteerContext` | `agent`, `subagentInstanceId?`, `iteration`, `message`, `id?` | `:726-733` |

`onPreCompact` may return `CompactionContribution[]` (`:695-707`, method at `:753-763`): a `source` (attribution
only, never shown to the summarizer — "workspace hooks all report `hook`") plus the request `text`,
*added* to the profile's own compaction prompt, never able to replace it because the type carries no
field through which "instead of" could be expressed (`:680-707`). A throw from `onPreCompact` is
swallowed by the loop's collector, since compaction fires because the context is already over budget
(`packages/loop/src/runtime/loop/lifecycle-hooks.ts:301-341`; API rationale at
`packages/capability/src/api.ts:753-761`).

### 2.8 The loop-time build context (`loop-contract.ts`)

`loop-contract.ts` is what an `AgentCapability.attach(bc)` actually receives and returns —
`AgentBuildContext` in, `AgentLoopContribution` (§2.2) out.

`ToolArgValidate` (`:22`) is a function type — `(schema, args) => string | null` — rather than a shared
helper, because the implementation is an ajv instance and this package deliberately carries no JSON
Schema dependency (`:10-21`). `AgentRunState` (`:29-32`) is the mutable per-agent state threaded through
an iteration: `lastAssistantText` and an optional `lastSubmitAttempt`.

`AgentBuildContext` (`:46-80`):

| Field | Type | Note |
|---|---|---|
| `agent` | `AgentRole` | — |
| `subagentInstanceId?` | `string` | — |
| `ctx` | `ContextPort` | live conversation |
| `state` | `AgentRunState` | — |
| `trace` | `TracePort` | — |
| `signal?` | `AbortSignal` | — |
| `guards` | `ConvergenceGuards` (§3.10) | the loop's doom-loop/stagnation guards, shared by tool dispatchers |
| `toolProgress` | `(r: {errText, productive}) => boolean` | the persona's tool-progress policy |
| `validateArgs?` | `ToolArgValidate` | required alongside `openCallEnvelope` by any tool declaring a schema |
| `maybeCancelled` | `() => AgentResult \| null` | terminal cancelled result, or `null` if still live |
| `clock?` | `ComputeClock` | paused by a capability that idles on purpose (e.g. waiting on a child) so the wait does not burn the run's wall-clock budget |
| `steerProbe?` | `() => boolean` | reports a queued steer *without* consuming it |
| `warnings?` | `string[]` | mutable sink folded into the final `Usage` |

`steerProbe`'s doc-comment states why it exists rather than draining: the loop's steer source is
pull-only, so pulling to check would swallow the message the loop's own drain is about to deliver at
the next iteration top — the probe buffers instead of consuming (`:67-76`). The doc-comment on the
interface itself states the engine's real build context is richer (it also carries the loop budget,
deliberately absent here because no capability reads it) and calls adding a member "a widening of the
contract: prefer a port over exposing an engine type" (`:41-44`).

`HandlerVerdict` (`:88-92`) is a tool handler's ruling on one dispatched call: `{kind:"result", ...HandlerResult}`,
`{kind:"deferred", run}` (a continuation to run, optionally under an abort signal), `{kind:"terminal",
result: AgentResult}`, or `{kind:"cancelled"}`. `ToolHandler` (`:99-104`) is `matches(call)` plus an
optional `canonicalName(call)` for a stable identity when the model-facing wire name is a projection,
and `handle(call, iteration)`. `FinalizeAttempt` (`:110`) is an agent's bid to finish (`mode: "text" |
"submit"`, optional `value`/`text`). `GateOutcome` (`:115-118`) is a finalize gate's ruling:
`{kind:"pass"}`, `{kind:"nudge", note, unbounded?}` — an `unbounded` nudge is exempt from the nudge
budget — or `{kind:"terminal", result: AgentResult}`. `FinalizeGate` (`:125-128`) is `check(attempt)`
plus an optional `fastAcceptOk()` that reports (without running `check`) whether the gate would
trivially pass, letting the loop skip the sweep.

`OrchestrationHooks` (`:146-152`) is `beforeIteration?`, `afterDispatch?`, `contributesProgress?`,
`onFinalizeAccepted?`, `onTeardown?` — the five hooks §4.1's `foldHooks` fans out. The doc-comment
states `onTeardown` may return a promise the loop awaits, and that it must stay bounded: a capability
holding work that outlives a dispatch (a background child) has to be able to wind it down while the
run's trace, MCP pool and usage accounting are all still open, so a fire-and-forget teardown would drop
that child's token usage on the floor — "everything after the loop resolves is waiting on it"
(`:139-144`).

## 3. Data and formats

This package persists nothing itself. What it owns are shapes that other layers persist or transmit.

### 3.1 Port key identifiers

Port keys are plain `{ id: string }` objects; the type parameter is carried only in the type position
via a never-read `_t` field (`packages/capability/src/services.ts:29-38`). Ids are namespaced by the publishing capability
because two capabilities minting the same id would silently overwrite each other
(`packages/capability/src/services.ts:40-47`). The two ids this package owns are pinned by test:

| Constant | Id | Pin |
|---|---|---|
| `TOOL_EFFECT_PORT` | `tools.effect` | `packages/capability/tests/unit/capability-ports.test.ts:71-75` |
| `TASK_TRACKING_PORT` | `delegation.task-tracking` | `packages/capability/tests/unit/capability-ports.test.ts:77-81` |

### 3.2 The trace entries the call envelope writes

`openCallEnvelope` is the only writer in this package. It emits two entry kinds through `TracePort`:

`tool_call_started` (`packages/capability/src/call-envelope.ts:99-107`):

```
{ agent, [subagent_instance_id], iteration_ref, call_id, started_at, name, arguments }
```

`tool_call` (`packages/capability/src/call-envelope.ts:82-93`), emitted by both `ok` and `fail`:

```
{ agent, [subagent_instance_id], iteration_ref, call_id, started_at, ended_at, name,
  arguments, result, error }
```

`arguments` is `traceArguments ?? call.arguments ?? {}` in both, so a sensitive tool can persist a
safe projection instead of the raw model payload (`packages/capability/src/call-envelope.ts:28`, `:90`, `:106`).
`started_at` is stamped at envelope construction and `ended_at` at record time, both from
`trace.now()` (`packages/capability/src/call-envelope.ts:75`, `:87`). On `fail`, the same string is written to `result` and
to `error` unless a redacted `traceMessage` is supplied (`packages/capability/src/call-envelope.ts:46-47`, `:113-116`), which
the test pins at `packages/capability/tests/unit/call-envelope.test.ts:48-61`.

The model-facing return strings are fixed:

| Method | Returned text |
|---|---|
| `ok(result)` | `` Tool '<name>' result: <result> `` (`packages/capability/src/call-envelope.ts:111`) |
| `fail(message)` | `` Tool '<name>' result (error): <message> `` (`packages/capability/src/call-envelope.ts:115`) |

### 3.3 Capability state on a run record

`RunContinuation.capability_state` is `Record<string, unknown>` keyed by capability name, and its
values are opaque to the engine (`packages/capability/src/run.ts:402-415`). It is read back into
`RunCapabilityContext.priorState`, where a capability reads only its own slot and the value is
exactly what its own `finalizeRun` returned (`packages/capability/src/contract.ts:98-106`). `finalizeRun` returns the value
to file under the capability's name in `ExecutionRecord.capability_state`, or `undefined` to write
nothing (`packages/capability/src/contract.ts:268-272`).

### 3.4 The open vocabularies as data

Each open vocabulary ships as a `readonly` tuple, a derived union, and a `Set`-backed narrowing
predicate:

| Vocabulary | Members | Tuple | Predicate |
|---|---|---|---|
| `BuiltinRunEndedReason` | `completed`, `budget_exhausted`, `cancelled`, `soft_limit_declined`, `interrupted`, `timeout`, `guard_trip`, `error` | `packages/capability/src/run.ts:14-23` | `packages/capability/src/run.ts:46` |
| `BuiltinErrorCode` | 42 codes across request-validation, loop-termination, MCP, provider, execution-id and continuation families | `packages/capability/src/run.ts:158-201` | `packages/capability/src/run.ts:225` |
| `BuiltinAgentErrorCode` | `empty_response`, `all_tools_unavailable`, `tool_failure_loop`, `stagnation_detected`, `no_progress`, `agents_unfinished`, `background_children_failing` | `packages/capability/src/agent-result.ts:8-16` | (none of its own; subset-checked against `isBuiltinErrorCode`) |
| `ExecutionStatus` | `completed`, `budget_exhausted`, `error`, `cancelled`, `soft_limit_declined`, `interrupted` | `packages/capability/src/execution-status.ts:16-23` | (closed union, no predicate) |

`ExecutionStatus` is closed, and `interrupted` is documented as never produced by a live run — only
by `@clarvis/trace`'s `TraceStore.recoverOrphans` (`packages/capability/src/execution-status.ts:11-13`), a claim echoed on
`RunResponse` at `packages/capability/src/run.ts:281-285`.

### 3.5 `ToolEffect`

`type ToolEffect = "read" | "mutate" | "control" | "spawn_run" | "unknown"`
(`packages/capability/src/tool-effect.ts:31`). `unknown` is described as the load-bearing member: a gate that must refuse
everything that could change the workspace has to refuse it by construction, and a classification
that defaulted `unknown` to `read` would turn a closed rule into an open one
(`packages/capability/src/tool-effect.ts:14-18`). `spawn_run` is separated from `control` because a workflow leader is a
separate `executeRun` whose profile the caller chooses (`packages/capability/src/tool-effect.ts:20-30`).

### 3.6 Zod schemas this document owns

`capabilityRunPoliciesSchema` is `{ plans?: { skills: Record<string, "off"|"on"|"review"> } }`, both
levels `.strict()` (`packages/capability/src/capability-run-policies.ts:4-16`). It is the run policy a plugin contributes for
the skills it packages (`packages/capability/src/capability-run-policies.ts:6`). No default is supplied at any level.

### 3.7 LLM call parameters and results (`llm-port.ts`)

`LLMToolCall` (`packages/capability/src/llm-port.ts:15-43`) is `id`, `name`, `arguments: unknown`, plus two signal fields:
`malformedArguments?` (a bounded preview when the payload did not decode — its presence means
`arguments` is a `{}` **substitute** and a dispatcher must refuse the call rather than run it) and
`rewrittenFrom?` (the model's original `arguments`, present when a `beforeToolUse` hook rewrote the
call — the engine never mutates the call the provider returned, so the assistant message already in
context keeps the model's own arguments). `LLMUsage` (`:51-56`) is `input_tokens`/`output_tokens`/
`cached_tokens`/`cache_write_tokens`.

`LLMCallResult` (`:65-105`) normalizes one model call: `text?`, `toolCalls?`, `usage` (always present),
`reasoning?` (display text), `billing_source?: "subscription"` (explicit billing authority),
`reasoningParts?: AssistantReasoningPart[]` and `textParts?: AssistantTextPart[]` (opaque provider
continuation state, with text phase retained separately from display text), `finishReason?`
(`"length"` marks a response cut off at `maxOutputTokens`), and `retriedUsage?: LLMUsage` — tokens
burned by attempts that failed before this one succeeded, attached by `withTransportRetry`. Its
doc-comment states a caller charging a budget
**must add `retriedUsage` to `usage`**, or the ledger under-counts by exactly what an unhealthy provider
cost, "making the hard token cap least accurate precisely when a run is burning money for nothing"
(`:90-99`).

`ResolvedProviderConfig` (`:145-152`) is `kind`, `baseUrl?`, `apiKeyEnv?`, `headers?`, `body?`,
`promptCache?: PromptCacheMode`. Its doc-comment's table — absence is deliberately not `off`:

| `promptCache` value | `anthropic` | `openai-compatible` |
|---|---|---|
| `"explicit"` | cache breakpoints | `cache_control` blocks |
| `"implicit"` | cache breakpoints | nothing — informational |
| `"off"` | no breakpoints | nothing |
| absent | cache breakpoints | nothing |

(`packages/capability/src/llm-port.ts:128-141`). `headers` values are raw `${VAR}` templates, never resolved — resolved at
client construction, not per message, which is why `ResolvedProviderConfig` rides beside
`LLMCallParams` rather than inside it (`:110-126`).

`LLMCallParams` (`:183-247`) is the full call input: `model`, `messages`, `tools`, `provider`, optional
`providerConfig`/`capabilities`/`signal`/`toolChoice`/`timeoutMs`/`maxOutputTokens`/
`reasoningSummary`/`reasoningEffort`/`promptCacheKey`/`promptCacheTtl`, `cacheBreakpoints?: readonly
number[]` (Anthropic-only prompt-cache breakpoint indices; the adapter keeps at most the two newest
usable ones and falls back to the last non-system message when absent, `:199-209`), `maxRetries?`/
`maxRetryAfterMs?`, `onRetry?: (info: RetryInfo) => void` (fired *after* the backoff delay is computed,
so `delayMs` is never invented, `:213-219`), `onStreamDelta?` (a live streaming sink; `reset: true`
marks the first slice of a retried call, `:221-227`), and `onToolInputDelta?` (a separate, `call_id`-keyed
sink for in-progress tool-call arguments — kept separate from `onStreamDelta` because the two signals
cannot share one batcher: a stream delta is an unkeyed slice, this is keyed and can interleave across
concurrent calls; `chars: 0` announces a call exists, `:229-245`). `RetryInfo` (`:157-170`) is
`attempt`, `maxRetries`, `delayMs`, `kind: FailureKind`, optional `status`/`retryAfterMs`.

`LLMProvider` (`:254-256`) is the single-method port — `call(params) => Promise<LLMCallResult>` — every
backend implements and every decorator (`withTransportRetry`, `withCallLogging`,
`withPromptCacheDefaults`) wraps.

`ProviderErrorInit` (`:263-283`) is the optional constructor input for `ProviderError` (§2.4): `kind?`
(defaults `"transient"`), `status?`, `retryAfterMs?`, `partialUsage?` (deliberately absent rather than
zero when unreadable — "treating 'could not read' as 'cost nothing' would under-count the ledger
silently"), `streamStarted?` (whether any output delta reached the consumer before the failure — a
retry past this point re-bills the whole prompt). `ProviderError` itself additionally carries
`accumulatedUsage?: LLMUsage`, tokens burned by every failed attempt the retry wrapper made before
giving up, attached by `withTransportRetry` on the error it finally rethrows (`:307-315`).

### 3.8 Token tallies (`usage.ts`)

`TokenCounts` (`packages/capability/src/usage.ts:8-13`) is `input`, `output`, `cached`, `cache_write` — the doc-comment states
`cached` counts input tokens served from the provider's prompt cache (a read hit) and `cache_write`
counts input tokens written into it, the two disjoint from each other and from plain `input` (`:4-6`).
`TokenAccumulator` (`:19`) is a type alias of `TokenCounts` used as a mutable running total.
`SubagentAggregate` (`:28-31`) extends `TokenCounts` with `iterations` (summed across every instance of
one sub-agent profile) and `instances` (how many instances ran).

### 3.9 Agent supervision seam (`agents-port.ts`)

`agents-port.ts` is the public seam a *producer* of children (the loop's delegation, `@clarvis/workflows`'
manager) programs against; its doc-comment states it is kept free of implementation imports so these
types cross a package boundary while the registry itself does not (`packages/capability/src/agents-port.ts:1-9`).

`AgentKind` (`:15`) is `subagent | leader`. `AgentStatus` (`:26`) is six states — `running`, `waiting`,
`completed`, `failed`, `stopped`, `cancelled` — whose doc-comment explains the split: `waiting` is still
live, distinguished from `running` so a parent can tell a stalled child from a working one, and the four
terminal states differ by *who* ended the child (`completed`/`failed` are the child's own outcome,
`stopped` is a parent's `agent_stop`, `cancelled` is the run going down) (`:17-25`). `SettledStatus`
(`:29`) is the terminal subset. `WaitingOn` (`:32`) is `"elicitation" | null`.

`AgentControl` (`:43-49`) is the two-method handle a producer supplies: `stop(reason)` and
`steer(message): boolean` — the doc-comment states a steer to a finished child is "a plain refusal,
never an error" (`:38-41`) — plus an optional `undrained?()` reporting steers queued and never drained.
`AgentRegistration` (`:52-61`) is what a producer declares at registration: `kind`, `nativeId`, `title`,
optional `profile`, and `control`. `AgentSettlement` (`:64-70`) is a child's terminal outcome:
`status`, optional `result`/`iterations`/`tokens`.

`AgentHandle` (`:81-89`) is a producer's handle on one registered child: `ingest(event)` (feeds one
trace event into the child's activity buffer — a sub-agent's activity instead routes off the run's own
trace, so a sub-agent producer never calls this), `waiting(on)`, and `settled(settlement)` — documented
idempotent, "the first settle wins."

`AgentRegistryPort` (`:97-116`) is the producer-facing slice, deliberately write-only ("reading the tree
is the supervision tools' job, not a producer's," `:91-95`): `register(registration)` returns an
`AgentHandle` or `null` when the registry is sealed or at its live-children ceiling — a producer must
treat `null` as "do not spawn" and answer with a plain refusal (`:98-104`); `adopt(id, task)` hands the
registry a background child's in-flight promise so teardown can await it, and the doc-comment states
the registry attaches its own rejection handler so the producer must **not** also await the task, "or
the spawn stops being background" (`:106-112`); `liveCount()` reports children neither settled nor
evicted.

### 3.10 Convergence guard vocabulary (`convergence-guards.ts`)

Types only — the doom-loop and stagnation guards themselves stay in `@clarvis/loop`, and a capability
only ever holds the combined handle (`packages/capability/src/convergence-guards.ts:1-4`). `GuardTrip` (`:12-15`) is `code:
"tool_failure_loop" | "stagnation_detected"` plus a `message`. `GuardWarning` (`:21-24`) is the
soft-tier counterpart, same two codes. `ConvergenceGuards` (`:30-51`) is four methods: `record(signature,
resultText, isError)` feeds one tool result in; `takeSoft()` yields pending warnings once each,
"consumed by reading, so the caller needs no memory of what it has already shown"; `tripped()` returns
the first tripped guard or `null`; `reset()` clears both guards' trips and counters, documented as used
when a human answers a guard escalation with "continue" — "the counters go with the latch, or the next
single failure re-trips and the escalation was theatre" (`:43-49`). This is the concrete type behind
`AgentBuildContext.guards` (§2.8).

### 3.11 Compaction anchor (`compaction-anchor.ts`)

`CompactionAnchor` (`packages/capability/src/compaction-anchor.ts:8-11`) is a `label` and a `body` — a stable reference block
(e.g. the task or plan) prepended to the summarizer's system prompt so a compaction summary stays
grounded. The doc-comment repeats §2.2/§4.1's at-most-one-anchor rule and states the engine owns the
summarization that consumes it (`:1-7`).

### 3.12 Task-tracking port (`task-tracking-port.ts`)

`SpawnGate` (`packages/capability/src/task-tracking-port.ts:6-7`) is a task tracker's ruling on a child spawn before it begins:
`{kind:"ok"}`, `{kind:"refuse", text}`, or `{kind:"terminal", result: AgentResult}`.
`DelegateTaskAugmentation` (`packages/capability/src/task-tracking-port.ts`) is a tracker's
contribution to `delegate_task`'s advertised schema: its description and properties, including a
required `task_id` definition. `TrackedTask` is the neutral shape delegation consumes:
`id`, `title`, `status`, optional `detail`/`exit`/`description`/`exit_condition`.

`TaskTrackingPort` (`:27-58`) is the operations a child-producing capability may consume:
`reconcile?()`, `openTasks()`, `getTask(id)`, `markSpawned(id)`, `markFailed(id, error)` (may return a
digest summary instead of a bare boolean), `markReturned?(id, summary)`, `beforeSpawn(taskId)` (returns
a `SpawnGate`), `noteSpawned(taskId)`, `augmentDelegateTask()`. `markReturned`'s doc-comment records a
concrete historical defect: "delegation called the port on the *failure* path only, so a successful
hand-back went straight from `in_progress` to whatever the parent decided next, and the intermediate
state ... was never written by anything. Delegation must not close the task itself: only the parent
may, through `transition_plan_task`" (`:46-52`). `TaskTrackingProvider` (`:61-63`) hands out a port bound
to one `AgentBuildContext`. `TASK_TRACKING_PORT` (`:66`) is the canonical key (§3.1).

### 3.13 The wire/response/continuation shapes (`run.ts`)

Beyond the open vocabularies (§3.4), `run.ts` defines the run's remaining wire and persistence shapes.

`ExecutionMode` (`packages/capability/src/run.ts:54`) is `subagent-only | lead-subagent`. `PerAgentUsage` (`:64-101`) is
discriminated by `type`: `lead` (model + token fields + `iterations` + `subagents_spawned`),
`subagent` (model + token fields + optional `iterations`/`instances`, rolled up across every instance of
one profile), and `vision` (model + token fields only). The doc-comment states `vision` is a **third**
variant rather than a `subagent` row, because counting it as one inflated the lead's
`subagents_spawned` and reported a child no client could address — and it carries no `iterations` for
the same reason context compaction contributes none: it is a single call, not a loop (`:85-93`). `Usage`
(`:110-115`) bundles `iterations_used`, `elapsed_ms`, `by_agent: PerAgentUsage[]`, optional `warnings`.

`ResourceToolKind` (`:118`) is `resource_list | resource_read`. `Resolved` (`:127-133`) is what
resolving a wire tool name back to an MCP call yields: `connection`, `toolName`, `fullName`, optional
`inputSchema`/`kind`. `NamespacedRegistry` (`:142-146`) is `tools` + `resolve(name)` (nullable) +
`allUnavailable()`.

`FailureKind` (`:243-244`) is `transient | context_overflow | client | auth | quota | content_policy`;
the doc-comment states only `transient` is retried, and that `quota`/`content_policy` were split out of
`client` because retrying a quota failure spends what allowance remains, retrying a policy refusal
reproduces it, and the two are resolved in "entirely different ways" a UI cannot advise on while both
looked like a malformed payload (`:236-241`). `ProviderErrorDetails` (`:253-257`) is `kind` + optional
`status`/`retry_after_ms`. `ErrorBody` (`:263-267`) is `code: ErrorCode`, `message`, optional `details`.
`StructuredResult`/`ResultValue` (`:270-273`) are both `unknown`, the second an alias of the first.

`RunResponse` (`:286-292`) is discriminated by `status`: five variants (`completed`, `budget_exhausted`,
`cancelled`, `soft_limit_declined`, `interrupted`) share `{result: ResultValue; usage: Usage}`, and
`error` replaces `result` with an `ErrorBody` while still reporting usage accumulated before the fault.
The doc-comment states `interrupted` is "the one variant no live run produces" — it belongs only to a
record rebuilt from a journal after the process died, where `result` is necessarily absent (`:281-285`;
echoed at `packages/capability/src/execution-status.ts:11-13`, §3.4). `WireRunResponse` (`:295`) stamps a `RunResponse` with
`execution_id` for transport.

`ResolvedConfig` (`packages/capability/src/run.ts:306-309`) is the effective per-run limits:
`max_tokens` and `timeout_ms`, and deliberately **no** iteration cap — it declared a `max_iterations`
that `resolveConfig` fixed at `Number.POSITIVE_INFINITY` for every run, which is why `run_started`'s
finite-only emission of it never fired. The run's real iteration cap is `entryMax`, resolved from the
agent profile. `MutableUsage` (`:312-315`) is a running tally: `iterations` + a `TokenCounts`
accumulator. `MCPStatus` (`:318`) is `connected | lost | unavailable`. `ToolResult` (`:327-337`) is
`ok` + `data?` on success, or `error` (`code`, `message`, optional `kind`/`outcome: "unknown"` — the
doc-comment states a sent request whose effect cannot be proved must never be retried automatically) on
failure. `MCPConnection` (`:348-357`) is one live server connection: `name`, `transport`, `status`,
bounded initialize `instructions?`, `callTool`/`listResources?`/`readResource?`/`close`.
`NamespacedTool` (`:367-375`) is one MCP tool under
a collision-free wire name: `fullName`, `wireName`, `mcpName`, `toolName`, optional `description`,
`inputSchema`, `kind`.

`ContextSnapshotEntry` (`:380-396`) is one entry in a persisted context snapshot used to continue a run:
`message: LiveMessage`, `evictable`, `summary`, `canonical` (booleans marking what compaction may drop,
what is a compaction-produced summary, and what is always retained), optional `task_id` (associates the
entry with a plan task), `note_kind?` (a replaceable-note identity — without it a continued run restores
a runtime note as anonymous and `appendRuntimeNote` appends a second copy instead of replacing the
first), `block_kind?` (a stable block's position-holding identity). `RunContinuation` (§3.3) carries an
array of these plus `capability_state`.

### 3.14 `AgentResult` (`agent-result.ts`)

`AgentResult` (`packages/capability/src/agent-result.ts:49-56`) is the terminal outcome of one agent's loop, and the concrete
payload behind `HandlerVerdict`'s `terminal` variant (§2.8), `GateOutcome`'s `terminal` variant (§2.8),
and `SpawnGate`'s `terminal` variant (§3.12):

| Field | Type | Note |
|---|---|---|
| `status` | `"completed" \| "budget_exhausted" \| "error" \| "cancelled" \| "soft_limit_declined"` | — |
| `text?` | `string` | set only on a clean completion |
| `partialText` | `string` | always present — accumulated so far regardless of how the agent ended |
| `error?` | `{ code: AgentErrorCode; message: string }` | on failure |
| `structuredResult?` | `{ value: unknown }` | a completed structured submit |
| `partialStructured?` | `{ value: unknown }` | a best-effort partial, built by `partialStructOf` (§2.4) |

## 4. Behavior

### 4.1 Fold: `foldContributions`

`foldContributions` walks contributions in order and accumulates
(`packages/capability/src/compose.ts:83-140`):

| Step | Code | Rule |
|---|---|---|
| 1 | `:97-104` | for each tool, reject if `wireName` already seen — throws ``foldContributions: duplicate tool wire name '<n>' across contributions`` |
| 2 | `:105-106` | push tools; also push into `advertisedTools` unless `advertised === false` |
| 3 | `:108-109` | concatenate `handlers` and `gates` |
| 4 | `:110-115` | `anchor`: second provider throws `more than one contribution provides an anchor` |
| 5 | `:116-121` | `forcedChoice`: same rule |
| 6 | `:122-127` | `outputBudget`: same rule |
| 7 | `:138` | fold hooks by fan-out |

The duplicate-tool rule is justified in the module docstring: dispatch is first-match while the
provider tool set is last-def-wins, so a collision would make the advertised schema and the
dispatching handler disagree (`packages/capability/src/compose.ts:4-8`). The same docstring records that the core appends
the submit handler and the MCP catch-all **after** the fold (`packages/capability/src/compose.ts:8`) — the engine side of
that is delegated to [loop-capability-composition](../engine/capability-composition.md).

`foldHooks` (`packages/capability/src/compose.ts:144-186`) builds each field only when at least one contribution set it, so a
caller's `folded.hooks.beforeIteration ? ...` presence check keeps working (`packages/capability/src/compose.ts:142-143`);
the empty case is pinned at `packages/capability/tests/unit/compose.test.ts:77-80`. Fan-out semantics:

| Hook | Merge | Code |
|---|---|---|
| `beforeIteration` | sequential, contribution order | `:157-159` |
| `afterDispatch` | sequential, contribution order | `:164-166` |
| `contributesProgress` | `Array.some` (logical OR) | `:170` |
| `onFinalizeAccepted` | sequential | `:174-176` |
| `onTeardown` | sequential **and awaited** | `:181-183` |

Order and the OR are pinned at `packages/capability/tests/unit/compose.test.ts:82-120`.

### 4.2 Per-scope activation

`capabilitiesForScope` maps `forAgent(scope)` over the run capabilities and drops `null`s, treating
`undefined` as an empty list (`packages/capability/src/compose.ts:47-49`); pinned at `packages/capability/tests/unit/compose.test.ts:126-134`.
`systemSectionsFor` does the same for `systemSection(id)`, dropping `undefined`
(`packages/capability/src/compose.ts:57-59`); order and dropping pinned at `packages/capability/tests/unit/compose-activation.test.ts:18-26`.
`activationForScope` bundles both into `{ capabilities, systemSections }` (`packages/capability/src/compose.ts:63-71`).

`systemSection` takes an `AgentIdentity` rather than an `AgentScope` because it is called at
seed/spawn time, before the run clock exists, and it must agree with `forAgent` for the same identity
(`packages/capability/src/contract.ts:240-247`). `AgentScope` is `AgentIdentity` plus `clock`, `signal` and `elicit`
(`packages/capability/src/contract.ts:207-212`).

### 4.3 Settings registry

`createCapabilityRegistry(seed)` builds two maps and applies the seed through the same public methods
(`packages/capability/src/registry.ts:49-79`):

| (state, event) | -> (state, effect) |
|---|---|
| key absent, `register(spec)` | key stored; `specs()` order = insertion order (`:52-58`) |
| key present, `register(spec)` | **throws** ``capability settings key '<k>' is already registered`` (`:54-56`) |
| `specs()` | returns `[...byKey.values()]` — a fresh array each call (`:59-61`) |
| blank name, `registerGrant` | **throws** `capability grant name must be a non-empty string` (`:63-65`) |
| name present, same `entryCanSpawn` | silent no-op, returns (`:67-68`) |
| name present, different `entryCanSpawn` | **throws** ``capability grant '<n>' is already registered differently`` (`:69`) |
| name absent | stored (`:71`) |

`composeCapabilityRegistry(base, declarations)` builds a **new** registry from the base's specs and
grants plus the additions, so a per-run grant never mutates the host's long-lived registry
(`packages/capability/src/registry.ts:86-93`); pinned at `packages/capability/tests/unit/registry.test.ts:66-82`.

`requestParamKeys` flat-maps `Object.keys(spec.requestParams ?? {})` across specs in spec order
(`packages/capability/src/settings-spec.ts:55-57`), pinned at `packages/capability/tests/unit/registry.test.ts:90-97`.

The registry's own docstring states the split it implements: the engine's built-in specs are spread
statically into the settings and request schemas so zod's inference stays exact, and this registry is
the open half for capabilities shipped in their own package; registration must happen before settings
are parsed or the block reads as an unrecognized key (`packages/capability/src/registry.ts:6-18`).

### 4.4 Inter-capability ports

`createCapabilityServices()` returns a `Map`-backed registry (`packages/capability/src/services.ts:82-95`):

| (state, event) | -> (state, effect) |
|---|---|
| key free, `provide(key, value)` | stored (`:89`) |
| key taken, `provide(key, value)` | **throws** ``capability port '<id>' is already provided``; the original value stays (`:86-88`, pinned `packages/capability/tests/unit/capability-ports.test.ts:31-40`) |
| any, `get(key)` | the stored value cast to `T`, or `undefined` (`:91-93`) |

The module docstring states the resolution discipline: a consumer reads at `attach` time, not in
`forRun`, which is what removes any ordering requirement between capabilities — with eager reads a
run's capability order would silently decide which features could see each other, and the failure
would be a missing tool rather than an error (`packages/capability/src/services.ts:11-16`). The engine's own sequencing is
consistent with that: `AGENT_REGISTRY_PORT` is provided before any `forRun`
(`packages/loop/src/runtime/orchestrator.ts:220-221`) while `TOOL_EFFECT_PORT` is provided *after*
every `forRun` has resolved (`packages/loop/src/runtime/orchestrator.ts:345`), so a capability that
read the effect port in `forRun` would find nothing.

`createCapabilityRequestView(request)` returns `{ request, requestParam }` where `requestParam(key)`
is an untyped index into the same request object (`packages/capability/src/services.ts:21-26`); pinned against an
open, capability-declared key at `packages/capability/tests/unit/capability-ports.test.ts:53-68`.

### 4.5 Tool call envelope

`openCallEnvelope(a)` runs in this order (`packages/capability/src/call-envelope.ts:68-95`):

1. If `schema` is present and `validate` is absent, **throw** immediately
   (`:69-74`). The docstring gives the reason: this package carries no JSON Schema implementation, so
   the alternative to throwing is reporting every malformed call as valid — a validation boundary
   failing open in silence (`:61-65`).
2. Stamp `startedAt = trace.now()` (`:75`).
3. Resolve `callId = call.id` when non-empty, else `randomUUID()` (`:76`).
4. Compute `invalid = schema === undefined ? null : (validate?.(schema, call.arguments) ?? null)`
   (`:79-80`) — a validator returning `undefined` therefore reads as valid, pinned at
   `packages/capability/tests/unit/call-envelope.test.ts:96-109`.
5. Return `{ callId, invalid, start, ok, fail }`.

When `invalid` is non-null the caller is told to short-circuit via `fail(invalid)` without emitting a
`start` (`:58-59`); the test asserts that constructing an envelope with a failing validator records
nothing at all (`packages/capability/tests/unit/call-envelope.test.ts:80-94`).

`handlerBaseOf(bc)` projects exactly `trace`, `agent`, and the three optionals
`subagentInstanceId`/`signal`/`validateArgs`, **omitting** each key rather than setting it to
`undefined` (`packages/capability/src/handler-base.ts:26-33`); pinned at `packages/capability/tests/unit/call-envelope.test.ts:151-157`.

### 4.6 Tool-argument normalization

`normalizeToolArguments(raw)` (`packages/capability/src/tool-arguments.ts:57-73`):

| Input | Outcome | Line |
|---|---|---|
| `undefined` / `null` | `{ ok: true, args: {} }` | `:58` |
| plain non-array object | `{ ok: true, args: raw }` — the same object by identity | `:59` (identity pinned `packages/capability/tests/unit/tool-arguments.test.ts:25-30`) |
| `""` or whitespace-only string | `{ ok: true, args: {} }` | `:61` |
| string parsing to an object | `{ ok: true, args: parsed }` | `:68-69` |
| string failing `JSON.parse` | `{ ok: false, reason: "unparsable", preview }` | `:66` |
| string parsing to a non-object | `{ ok: false, reason: "not_an_object", preview }` | `:70` |
| any other type (number, boolean, array) | `{ ok: false, reason: "not_an_object", preview }` | `:72` |

`preview` renders the payload as a string, or `JSON.stringify(value) ?? String(value)` otherwise, and
appends a horizontal ellipsis when it truncates at `MALFORMED_ARGUMENTS_PREVIEW_CHARS = 200`, so its
own cut is distinguishable from the provider's (`packages/capability/src/tool-arguments.ts:8`, `:28-33`).

The docstring records the reason absent arguments are accepted as `{}`: a tool whose schema requires
nothing is legitimately called that way, and it names `list_dir`, `list_memories`, `monitor_list`
(`packages/capability/src/tool-arguments.ts:43-46`). It records the reason everything else fails rather than defaulting to
`{}`: substituting an empty object makes the tool answer with a schema error naming a property the
model did send (`:52-55`).

`malformedArgumentsMessage(toolName, norm)` builds a message that states the transport fault, embeds
the preview, and tells the model to re-issue and then rewrite the arguments around the cut point
(`packages/capability/src/tool-arguments.ts:87-101`). Two properties are pinned by test: the message contains the preview and
the word "truncated" (`packages/capability/tests/unit/tool-arguments.test.ts:71-79`), and it never contains
"required property" while it does contain "not run" (`packages/capability/tests/unit/tool-arguments.test.ts:84-90`).

### 4.7 Title and brief validation

`parseTaskTitle(value)` (`packages/capability/src/task-title.ts:18-48`), in order: non-string -> reject (`:19`); a line break
matching the `LINE_BREAK` pattern at `packages/capability/src/task-title.ts:7` (CR, LF and the two Unicode line/paragraph
separators, written there as escapes) -> reject (`:26`); trim and collapse `[\t ]+` runs to one space
(`:33`); empty after normalization -> reject (`:34`); more than `TASK_TITLE_MAX = 60` **Unicode**
characters (`[...title].length`) -> reject (`:41`). Every rejection message contains the word
"title" (pinned `packages/capability/tests/unit/task-title.test.ts:12-18`).

`parseDelegateTaskText(value)` (`packages/capability/src/delegate-task.ts:17-33`) rejects a non-string or empty string
(`:18`), then counts Unicode characters with a `for...of` loop that **stops at the ceiling**
(`:22-31`) — the docstring states this is so a direct embedder cannot make validation allocate a
second copy of an oversized task (`:14-15`), and that the Unicode measure is chosen to agree with
JSON Schema's `maxLength` (`:11-13`). The exact-ceiling behaviour is pinned with emoji at
`packages/capability/tests/unit/delegate-task.test.ts:16-21`.

### 4.8 Frontmatter fence split

`splitFrontmatterFence(raw)` (`packages/capability/src/frontmatter-fence.ts:81-89`):

1. Strip a leading BOM and then `trimStart()` (`:82`).
2. Match `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/` (`:31`, executed at `:83`).
3. No match and the normalized text starts with `---` -> `{ kind: "unterminated", body: raw }`
   (`:85`).
4. No match otherwise -> `{ kind: "absent", body: raw }` (`:86`).
5. Match -> `{ kind: "fenced", frontmatter: match[1] ?? "", body: match[2] ?? "" }` (`:88`).

`body` on the two non-fenced outcomes is `raw` exactly as given, with the BOM and leading whitespace
still on it (`:63-67`, pinned `packages/capability/tests/unit/frontmatter-fence.test.ts:73-76` and `:86-89`). Two
adjacent `---` lines report `unterminated`, not an empty block, because the closing fence must be
preceded by a newline the opening fence did not already consume (`:74-77`, pinned
`packages/capability/tests/unit/frontmatter-fence.test.ts:44-47`). The frontmatter group is lazy, so the first `---` line
closes the fence and a later one is body text (`:28-30`, pinned
`packages/capability/tests/unit/frontmatter-fence.test.ts:106-119`). The function never throws — every input maps to one
of the three outcomes, and what a missing or unterminated fence *means* is the caller's to decide
(`:79-80`).

### 4.9 Glob

`globToRegExp(pattern)` splits on `*`, escapes every other regex metacharacter in each fragment, and
joins with `.*` inside `^...$` (`packages/capability/src/glob.ts:30-32`). The module docstring says both callers are
security-relevant and that an unanchored match would let `github.*` also select
`mygithub.internal` (`packages/capability/src/glob.ts:4-7`); the anchoring is pinned at `packages/capability/tests/unit/glob.test.ts:20-35`.

### 4.10 Per-owner memoization

`memoizeByOwner(build)` caches by owner string and **never evicts**; the docstring states the reason
as exclusive per-owner state (an on-disk lock, a mutex) that a second instance over the same tree
would not observe (`packages/capability/src/per-owner.ts:8-13`, implementation `:14-23`). `sharedFallback(build)` builds at
most once total and ignores its owner argument (`packages/capability/src/per-owner.ts:43-45`); it is meant to be composed as
`memoizeByOwner`'s fallback build function, never as a replacement, because building directly inside
`memoizeByOwner` would build one instance *per* owner (`packages/capability/src/per-owner.ts:36-42`). All three
compositions are pinned at `packages/capability/tests/unit/per-owner.test.ts:22-57`.

### 4.11 Failure-tolerant task helpers

The public surface a caller of `bestEffort` programs against:

| Type | Fields | Cite |
|---|---|---|
| `TaskFailure` | `operation`, `cause`, `workspace?` | `packages/capability/src/tasks.ts:3-7` |
| `TaskObservation` | `operation`, `workspace?`, `logger?`, `observer?`, `dedupeKey?`, `rateLimitMs?`, `clock?` | `packages/capability/src/tasks.ts:9-17` |

`bestEffort(run, options)` awaits `run()` and routes any throw or rejection to `observe`
(`packages/capability/src/tasks.ts:49-55`). `observe` (`packages/capability/src/tasks.ts:23-46`):

1. `now = options.clock?.() ?? Date.now()` (`:24`).
2. `key = options.dedupeKey ?? \`${operation}\0${workspace ?? ""}\`` — a NUL-separated composite
   (`:25`).
3. If the previous emission for that key is newer than `rateLimitMs` (default `60_000`, `:19`),
   **return without notifying anyone** (`:27-28`).
4. If the registry is at `MAX_DEDUPE_KEYS = 1_024` and the key is new, evict the oldest inserted key
   (`:20`, `:29-32`).
5. Re-insert the key so it moves to the end of insertion order (`:33-34`).
6. Build a `TaskFailure` whose `cause` is `sanitizeErrorMessage(...)` (`:35-39`).
7. Call `observer` inside a bare `try/catch` (`:40-42`), then `logger.warn(failure,
   "best_effort_failed")` inside another (`:43-45`).

`detachObserved` is `void bestEffort(...)` (`packages/capability/src/tasks.ts:58-60`).
`suppressSecondaryRejection(promise, observedBy)` **throws** when `observedBy` is blank and otherwise
attaches an empty catch (`packages/capability/src/tasks.ts:63-71`). `observedBy` is validated and otherwise never read: its
only function is to force a caller to name the primary observation channel in the source, at the call
site, rather than to drive any behavior (`packages/capability/src/tasks.ts:63-70`).

### 4.12 Event projection

`projected(event)` returns the same event with `wire = { type: event.kind }`, adding `detail` only
when `event.detail !== undefined` (`packages/capability/src/contract.ts:354-361`). The stated rule is that a host projects an
event only when it carries a `wire` and drops it otherwise, because the alternative — a host matching
on known capability names — silently discards everything from a capability the host was not written
to know about (`packages/capability/src/contract.ts:344-352`).

## 5. Invariants

Each rule is stated in this subsystem's own terms, with the production site and the test that pins
it. "Unpinned" means no test in the repository was found asserting it.

**INV-C1 (= INV-022).** `@clarvis/capability`'s own `src/` never reaches its own modules through the
published package name `@clarvis/capability` or a subpath of it; internal modules use relative
specifiers. Production: every module under `packages/capability/src/` (e.g. `packages/capability/src/contract.ts:13-32`, all
relative). Test: `packages/capability/tests/architecture/self-import.test.ts:10-21`, which scans
`src/**/*.ts`, strips `/** ... */` blocks, and matches
`/from\s+["']@clarvis\/capability(?:\/[^"']*)?["']/u`. The rule is scoped to `src` only: the
package's own integration test does import itself by published name
(`packages/capability/tests/integration/sanitize-runtime.test.ts:2`) and is outside the scan root.

**INV-C2.** Two contributions may not claim the same tool wire name, and neither may one contribution
claim it twice. Production: `packages/capability/src/compose.ts:98-102`. Test:
`packages/capability/tests/unit/compose.test.ts:53-60` (both cases).

**INV-C3.** At most one contribution per agent may provide an `anchor`, a `forcedChoice`, or an
`outputBudget`; a second throws. Production: `packages/capability/src/compose.ts:110-127`. Test:
`packages/capability/tests/unit/compose.test.ts:62-75`.

**INV-C4.** `advertised: false` keeps a contribution's tools in `tools` and out of
`advertisedTools`; the default is advertised. Production: `packages/capability/src/compose.ts:106`. Test:
`packages/capability/tests/unit/compose.test.ts:44-51`.

**INV-C5.** A folded hook field exists only when some contribution supplied it, so presence checks
downstream stay meaningful. Production: `packages/capability/src/compose.ts:155-185`. Test:
`packages/capability/tests/unit/compose.test.ts:77-80` (asserts `folded.hooks` equals `{}`).

**INV-C6.** Folded hooks fire in contribution order; `contributesProgress` is a logical OR; and
`onTeardown` is awaited sequentially. Production: `packages/capability/src/compose.ts:157-183`. Test:
`packages/capability/tests/unit/compose.test.ts:82-120`.

**INV-C7.** `capabilitiesForScope` and `systemSectionsFor` drop the declining capabilities (`null` /
`undefined`) and preserve registration order; both accept an absent capability list. Production:
`packages/capability/src/compose.ts:47-49`, `:57-59`. Test: `packages/capability/tests/unit/compose.test.ts:126-134`,
`packages/capability/tests/unit/compose-activation.test.ts:14-26`.

**INV-C8.** Registering a second settings spec under an existing key throws rather than silently
dropping the registration. Production: `packages/capability/src/registry.ts:54-56`. Test:
`packages/capability/tests/unit/registry.test.ts:30-36`.

**INV-C9.** `specs()` and `grants()` return fresh arrays, so a caller cannot mutate the registry
through a returned list. Production: `packages/capability/src/registry.ts:60`, `:74`. Test:
`packages/capability/tests/unit/registry.test.ts:38-44` (specs only; the same property for `grants()` is unpinned).

**INV-C10.** A grant name must be non-empty; an identical re-declaration is a no-op; a re-declaration
that changes `entryCanSpawn` throws. Production: `packages/capability/src/registry.ts:63-71`. Test:
`packages/capability/tests/unit/registry.test.ts:46-64`.

**INV-C11.** `composeCapabilityRegistry` produces an isolated registry and never mutates the base.
Production: `packages/capability/src/registry.ts:86-93`. Test: `packages/capability/tests/unit/registry.test.ts:66-82`.

**INV-C12.** `requestParamKeys` collects every declared param key across specs, in spec order.
Production: `packages/capability/src/settings-spec.ts:55-57`. Test: `packages/capability/tests/unit/registry.test.ts:85-97`.

**INV-C13.** Publishing a port under an already-taken key throws, and the rejected write does not
take effect. Production: `packages/capability/src/services.ts:86-89`. Test:
`packages/capability/tests/unit/capability-ports.test.ts:31-40`.

**INV-C14.** Looking up an unpublished port returns `undefined`, which a consumer must read as "that
feature is off for this run", never as an error. Production: `packages/capability/src/services.ts:68-73`, `:91-93`. Test:
`packages/capability/tests/unit/capability-ports.test.ts:15-19`.

**INV-C15.** The two canonical port ids are `tools.effect` and `delegation.task-tracking`.
Production: `packages/capability/src/tool-effect.ts:45`, `packages/capability/src/task-tracking-port.ts:66`. Test:
`packages/capability/tests/unit/capability-ports.test.ts:71-81`.

**INV-C16.** Supplying `openCallEnvelope` a `schema` with no `validate` throws at construction.
Production: `packages/capability/src/call-envelope.ts:69-74`. Test: `packages/capability/tests/unit/call-envelope.test.ts:111-123`.

**INV-C17.** A failed argument validation produces a non-null `invalid` and records **no** trace
entry. Production: `packages/capability/src/call-envelope.ts:79-80` (validation happens before any `record`). Test:
`packages/capability/tests/unit/call-envelope.test.ts:80-94`.

**INV-C18.** A call whose provider supplied no id gets a freshly minted UUID, and absent arguments are
recorded as `{}`. Production: `packages/capability/src/call-envelope.ts:76`, `:90`, `:106`. Test:
`packages/capability/tests/unit/call-envelope.test.ts:63-78`.

**INV-C19.** `handlerBaseOf` omits `subagentInstanceId`, `signal` and `validateArgs` rather than
setting them to `undefined`. Production: `packages/capability/src/handler-base.ts:30-32`. Test:
`packages/capability/tests/unit/call-envelope.test.ts:151-157`.

**INV-C20.** `projected` sets `wire.type` from `kind` and omits the `detail` **key** entirely when the
event has no detail. Production: `packages/capability/src/contract.ts:357-360`. Test:
`packages/capability/tests/unit/capability-ports.test.ts:96-116`.

**INV-C21.** `memoizeByOwner` builds each distinct owner at most once and never evicts; `sharedFallback`
builds at most once in total regardless of owner. Production: `packages/capability/src/per-owner.ts:14-23`, `:43-45`. Test:
`packages/capability/tests/unit/per-owner.test.ts:4-48`.

**INV-C22.** An absent, null, or blank-string tool-argument payload normalizes to `{}`; a plain object
passes through by identity; a JSON string that decodes to an object is accepted; everything else is a
failure carrying a bounded preview and a reason, never a silent `{}`. Production:
`packages/capability/src/tool-arguments.ts:57-73`. Test: `packages/capability/tests/unit/tool-arguments.test.ts:14-67`.

**INV-C23.** The malformed-arguments message never claims the model omitted a required property, and
states that the call was not run. Production: `packages/capability/src/tool-arguments.ts:96-100`. Test:
`packages/capability/tests/unit/tool-arguments.test.ts:84-90`.

**INV-C24.** A malformed-arguments preview is at most `MALFORMED_ARGUMENTS_PREVIEW_CHARS` characters
plus the ellipsis this module appends. Production: `packages/capability/src/tool-arguments.ts:8`, `:30-32`. Test:
`packages/capability/tests/unit/tool-arguments.test.ts:61-67`.

**INV-C25.** Task titles and delegated briefs are measured in Unicode characters, not UTF-16 code
units, at ceilings 60 and 32768. Production: `packages/capability/src/task-title.ts:41`, `packages/capability/src/delegate-task.ts:23-30`. Test:
`packages/capability/tests/unit/task-title.test.ts:20-25`, `packages/capability/tests/unit/delegate-task.test.ts:16-21`.

**INV-C26.** A task title may not contain a line break, and repeated horizontal whitespace is
collapsed rather than rejected. Production: `packages/capability/src/task-title.ts:7-8`, `:26`, `:33`. Test:
`packages/capability/tests/unit/task-title.test.ts:5-18`.

**INV-C27.** `globToRegExp` anchors the whole candidate string; only `*` is a wildcard and every other
regex metacharacter is literal. Production: `packages/capability/src/glob.ts:17-18`, `:31`. Test:
`packages/capability/tests/unit/glob.test.ts:4-35`.

**INV-C28.** `splitFrontmatterFence` never throws; it returns exactly one of `fenced` / `absent` /
`unterminated`, and on the latter two `body` is the untouched input. Production:
`packages/capability/src/frontmatter-fence.ts:81-89`. Test: `packages/capability/tests/unit/frontmatter-fence.test.ts:25-47`, `:73-89`.

**INV-C29.** Two adjacent `---` lines are `unterminated`, not an empty frontmatter block; an empty
block is written as `---`, blank line, `---`. Production: `packages/capability/src/frontmatter-fence.ts:31` (the pattern's
mandatory `\r?\n` before the closing fence). Test: `packages/capability/tests/unit/frontmatter-fence.test.ts:44-55`.

**INV-C30.** Every engine-declared agent error code is also an engine-declared error code, checked
both at compile time and at runtime. Production: `packages/capability/src/agent-result.ts:38-41` (a conditional-type
assertion `[Exclude<BuiltinAgentErrorCode, BuiltinErrorCode>] extends [never]`). Test:
`packages/capability/tests/unit/open-vocabularies.test.ts:78-81`.

**INV-C31.** `AgentErrorCode` is open, so a capability's own code is assignable on an `AgentResult`
while `isBuiltinErrorCode` still reports it as not the engine's. Production:
`packages/capability/src/agent-result.ts:31`, `:53`. Test: `packages/capability/tests/unit/open-vocabularies.test.ts:83-91`.

**INV-C32.** The three open vocabularies (`BUILTIN_ERROR_CODES`, `BUILTIN_RUN_ENDED_REASONS`,
`BUILTIN_AGENT_ERROR_CODES`) contain no duplicates and their predicates match exactly — no trimming,
no case folding. Production: `packages/capability/src/run.ts:38`, `:217` (Set-backed lookups). Test:
`packages/capability/tests/unit/open-vocabularies.test.ts:22-69`.

**INV-C33.** `BUILTIN_ERROR_CODES` no longer declares the plans capability's codes
(`plan_review_unreviewed`, `plan_review_revision_limit`, `pending_tasks_unfinished`). Production:
`packages/capability/src/run.ts:158-201` (absent from the tuple). Test: `packages/capability/tests/unit/open-vocabularies.test.ts:31-39`.

**INV-C34.** `EXECUTION_STATUSES` is exactly `completed, budget_exhausted, error, cancelled,
soft_limit_declined, interrupted`, in that order, with no duplicates. Production:
`packages/capability/src/execution-status.ts:16-23`. Test: `packages/capability/tests/unit/vocabulary.test.ts:6-18`.

**INV-C35.** A `ProviderError` constructed without a `kind` classifies as `transient` — the one kind
that is retried — and `streamStarted` defaults to `false`. Production: `packages/capability/src/llm-port.ts:324`, `:328`.
Test: `packages/capability/tests/unit/vocabulary.test.ts:38-45`.

**INV-C36.** Every `CodedError` subclass reports its own class name via `new.target.name`, remains an
`instanceof Error`, and leaves `details` undefined when none were supplied. Production:
`packages/capability/src/errors.ts:21-22`. Test: `packages/capability/tests/unit/errors.test.ts:12-35`.

**INV-C37.** `ConflictError.code` is fixed to `execution_id_conflict` and `PersistenceError.code` to
`persistence_failure`; `executionIdConflict(id)` names the id in both message and `details`.
Production: `packages/capability/src/errors.ts:51`, `:67`, `:103-107`. Test: `packages/capability/tests/unit/errors.test.ts:46-67`.

**INV-C38.** `ContinuationUnavailableError` echoes the unresolvable id into `details.continue_from`
and directs the caller to retry with the full message history. Production: `packages/capability/src/errors.ts:87-94`. Test:
`packages/capability/tests/unit/errors.test.ts:69-77`.

**INV-C39.** `bestEffort` never rejects, even when the observer throws, and even when the logger
itself throws. Production: `packages/capability/src/tasks.ts:40-45`. Test: `packages/capability/tests/unit/tasks.test.ts:56-89`.

**INV-C40.** Failure observation is rate-limited per `(operation, workspace)` (or an explicit
`dedupeKey`), defaulting to 60 seconds, and suppressed failures notify neither observer nor logger.
Production: `packages/capability/src/tasks.ts:19`, `:25-28`. Test: `packages/capability/tests/unit/tasks.test.ts:38-54`.

**INV-C41.** The dedupe registry is bounded at 1024 keys, evicting the oldest inserted key.
Production: `packages/capability/src/tasks.ts:20`, `:29-32`. Test: `packages/capability/tests/unit/tasks.test.ts:96-105`.

**INV-C42.** `suppressSecondaryRejection` requires a non-blank primary observation channel name.
Production: `packages/capability/src/tasks.ts:65-67`. Test: `packages/capability/tests/unit/tasks.test.ts:91-94`.

**INV-C43.** `contentToText` returns a string body unchanged and renders every non-text part as a
`[type]` placeholder joined by newlines. Production: `packages/capability/src/message-content.ts:10-13`. Test:
`packages/capability/tests/unit/message-content.test.ts:5-26`.

**INV-C44.** `partialStructOf` returns a spread-ready empty object when nothing was submitted, not an
object with an undefined key. Production: `packages/capability/src/agent-result.ts:69-73`. Test:
`packages/capability/tests/unit/capability-ports.test.ts:83-94`.

**INV-C45.** A capability's `seedMarker` and `reservedWireNames` are collected from every
**registered** capability, active or not — the engine reads them off `allCapabilities` before the
activation filter. Production (declaration): `packages/capability/src/contract.ts:139-154`. Production (engine):
`packages/loop/src/runtime/orchestrator.ts:197` and `:342-344` both read `allCapabilities`, while
`runCapabilities` is the post-`forRun` filtered list at `:241-311`. Unpinned in this package; the
engine-side test is delegated to [loop-capability-composition](../engine/capability-composition.md).

**INV-C46.** A reserved wire name that a capability did not also classify in `toolEffects` resolves to
`unknown`, not to `read` and not to `control`; and the engine's own vocabulary is consulted first, so
a capability cannot reclassify an engine tool. Production (declaration): `packages/capability/src/contract.ts:159-169`.
Production (engine): `packages/loop/src/runtime/tools/tool-effect.ts:62-65`. Unpinned in this
package.

**INV-C47.** The `@clarvis/capability` package must hold 100% function and 100% line coverage over its
non-type-only modules; the eight modules that emit nothing at runtime are named explicitly.
Production: `tooling/checks/coverage.ts:28`, `:73-83`.

**INV-C48.** `AgentRegistryPort.register` returning `null` (the registry is sealed, or at its
live-children ceiling) means the producer must refuse to spawn, never proceed anyway. Production
(declaration): `packages/capability/src/agents-port.ts:98-104`. Unpinned in this package; the producers
(`delegate_task`, `run_leader`) and the registry itself live in `@clarvis/loop` and
`@clarvis/supervision`.

**INV-C49.** A producer that calls `AgentRegistryPort.adopt(id, task)` must not also await that same
task itself — the registry attaches its own rejection handler, and a producer awaiting it too would
stop the spawn from being background. Production (declaration): `packages/capability/src/agents-port.ts:106-112`. Unpinned in
this package.

**INV-C50.** `LLMCallResult.retriedUsage`, when present, must be added to `usage` by any caller
charging a budget — it is not included in `usage` itself, and omitting it under-counts a ledger by
exactly what an unhealthy provider cost before the call that finally succeeded. Production
(declaration): `packages/capability/src/llm-port.ts:90-99`. Production (engine): `@clarvis/llm`'s `packages/llm/src/retry-llm-provider.ts:149-150`
attaches it; `@clarvis/loop`'s `packages/loop/src/runtime/loop/iteration-metrics.ts:179-181` and
`packages/loop/src/runtime/loop/output-budget.ts:24` are two independent callers that add it in. Test (engine side):
`packages/llm/tests/unit/retry-llm-provider.test.ts:404-423`.

**INV-C51.** `ResolvedProviderConfig.promptCache` is absent, not `"off"`, when nothing has decided the
mode — an absent value still resolves to cache breakpoints on Anthropic per the four-row table at
`packages/capability/src/llm-port.ts:128-141`, and only an explicit `"off"` withholds them. Production: `packages/capability/src/llm-port.ts:128-149`
(the doc-comment) and `provider-resolver.ts` (the resolver this package owns). Test (absence
preserved rather than defaulted to off): `packages/capability/tests/unit/provider-resolver.test.ts:142-147`. The adapter's
own per-provider-kind handling of each of the four values is delegated to [llm-provider-layer](llm.md)
(`specs/foundations/llm.md`).

**INV-C52.** A projected tool may retain two identities without conflating them: `tool` is the
model-facing wire name, while `toolFullName` is the optional stable dotted identity supplied by the
claiming `ToolHandler.canonicalName`. When present, the same full identity reaches both the before- and
after-tool hook contexts for that dispatch. Production (contract):
`packages/capability/src/loop-contract.ts:94-104` and `packages/capability/src/api.ts:587-604`.
Production (engine): `packages/loop/src/runtime/loop/loop.ts:494-508`, `:549-617`. Test:
`packages/loop/tests/unit/tool-hooks.test.ts:171-214`.

## 6. Failure modes and degradation

| Situation | Behaviour | Cite |
|---|---|---|
| Two contributions claim one tool wire name | `foldContributions` **throws** — hard failure at fold time | `packages/capability/src/compose.ts:99-102` |
| Two contributions provide anchor / forcedChoice / outputBudget | **throws** | `packages/capability/src/compose.ts:112`, `:118`, `:124` |
| Duplicate settings key registered | **throws** at registration | `packages/capability/src/registry.ts:55` |
| Grant re-declared with a different `entryCanSpawn` | **throws**; an identical repeat is tolerated silently | `packages/capability/src/registry.ts:68-69` |
| Blank grant name | **throws** | `packages/capability/src/registry.ts:64` |
| Port key already provided | **throws**; the first value survives | `packages/capability/src/services.ts:87-88` |
| Port key never provided | `get` returns `undefined`; consumers must treat it as "feature off" | `packages/capability/src/services.ts:68-73` |
| `schema` without `validate` on a call envelope | **throws**, explicitly to avoid failing open | `packages/capability/src/call-envelope.ts:69-74`, rationale `:61-65` |
| Validator returns `undefined` instead of `null` | Treated as valid (`?? null`) | `packages/capability/src/call-envelope.ts:80` |
| Provider omitted the tool call id | A UUID is minted; the call proceeds | `packages/capability/src/call-envelope.ts:76` |
| Tool arguments could not be decoded | `{ ok: false }` with a bounded preview and reason; the caller is expected to refuse the call and say why | `packages/capability/src/tool-arguments.ts:66`, `:70`, `:72`; message at `:87-101` |
| `LLMToolCall.malformedArguments` present | Documented signal that `arguments` is a `{}` **substitute** and the dispatcher must refuse the call | `packages/capability/src/llm-port.ts:19-30` |
| `LLMToolCall.rewrittenFrom` present | Documented signal that `arguments` is not what the model sent (a `beforeToolUse` rewrite) | `packages/capability/src/llm-port.ts:31-42` |
| `Capability.forRun` exceeds its budget | The contract states the capability is **skipped for this run** under `CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS`; long work must observe `ctx.signal` because a timeout stops waiting but cannot stop arbitrary host code | `packages/capability/src/contract.ts:186-191`; env key defined `packages/capability/src/env.ts:153` (default 5000 ms, max 60000); engine handling `packages/loop/src/runtime/orchestrator.ts:239`, `:253-294` |
| `RunCapability.seedBlock` throws | Documented to **fail the run**; a timeout omits the block instead | `packages/capability/src/contract.ts:233-238`; engine timeout branch `packages/loop/src/runtime/orchestrator.ts:316-341` |
| `RunCapability.finalizeRun` throws or times out | The slot is omitted; the run is unaffected. Bounded by `CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` | `packages/capability/src/contract.ts:277-282`; env key `packages/capability/src/env.ts:165` (default 2000 ms); engine `packages/loop/src/runtime/execute-run.ts:206-240` |
| `RunCapability.onRunEnd` rejects or times out | Logged; the run is unaffected. Must not await long work | `packages/capability/src/contract.ts:255-263` |
| A capability event listener throws | Swallowed by the engine, per the contract | `packages/capability/src/contract.ts:56`, `:94` |
| A capability event carries no `wire` | The host drops it; an unwrapped event stays internal by design | `packages/capability/src/contract.ts:344-352`; kernel handler `packages/kernel/src/runs/map-events.ts:347-358` |
| `bestEffort` work throws; observer throws; logger throws | Each is caught independently; the returned promise still resolves | `packages/capability/src/tasks.ts:40-45` |
| Failure repeated inside the rate-limit window | Silently dropped — no observer call, no log line | `packages/capability/src/tasks.ts:27-28` |
| Unterminated or absent frontmatter fence | Reported as a variant, never thrown; the two callers disagree about severity and that disagreement is policy, not splitting | `packages/capability/src/frontmatter-fence.ts:42-46`, `:79-80` |
| `unref` on a handle with no `unref` method | No-op | `packages/capability/src/unref.ts:7-9` |

## 7. Coupling

### 7.1 What this package depends on

| Dependency | Kind | Forced by |
|---|---|---|
| `zod` | runtime value | `packages/capability/src/capability-run-policies.ts:1`, `hooks-config`, `env`, `capability-executables` (delegated) |
| `zod` | type-only | `packages/capability/src/settings-spec.ts:12` uses `import type { z }`, so the spec machinery adds no runtime edge |
| `node:crypto` | runtime value | `packages/capability/src/call-envelope.ts:1` (`randomUUID`) |
| nothing else internal | — | `packages/capability/package.json:50-52` lists only `zod` |

The package has no dependency on `@clarvis/loop`, `@clarvis/paths` or anything else in the monorepo,
which is what the module docstring calls "a dependency-free leaf" and identifies as the reason a
capability can live in its own package (`packages/capability/src/index.ts:5-8`).

### 7.2 What depends on this package

Fourteen of the other eighteen packages carry a static value edge to `@clarvis/capability` from their
own `src/`; the four that do not are
`@clarvis/paths` and `@clarvis/protocol` (both leaves), `@clarvis/tools` (which reaches only
`@clarvis/paths`) and `@clarvis/code` (which reaches only `@clarvis/kernel`, `@clarvis/paths` and
`@clarvis/protocol` — `packages/code/package.json:34-36`).
Verified samples of the forcing edge:

| Consumer | Edge | Cite |
|---|---|---|
| `@clarvis/loop` | value import of `createCapabilityRequestView` / `createCapabilityServices` | `packages/loop/src/runtime/orchestrator.ts:46-47` |
| `@clarvis/loop` | value import of `composeCapabilityRegistry` / `createCapabilityRequestView` | `packages/loop/src/runtime/execute-run.ts:38` |
| `@clarvis/loop` | reads `Capability.reservedWireNames` and `.toolEffects` off the registered list | `packages/loop/src/runtime/capability-tool-metadata.ts:26-32` |
| `@clarvis/loop` | sorts by `RunCapability.order`, defaulting `0` | `packages/loop/src/runtime/capability-order.ts:15` |
| `@clarvis/loop` | type-only import of `ToolEffect`/`ToolEffectPort` to implement the port | `packages/loop/src/runtime/tools/tool-effect.ts:6` |
| `@clarvis/kernel` | value import of `createCapabilityRegistry`, registering five out-of-engine specs at module load | `packages/kernel/src/config/capability-registry.ts:1`, `:21-26` |
| `@clarvis/kernel` | reads `CapabilityEvent.wire` when mapping to the protocol | `packages/kernel/src/runs/map-events.ts:347-366` |

The direction is forced structurally in one further way: `services.ts`'s docstring states that a
capability needing a peer *cannot import it*, because the two live in different packages and the edge
that would make the import legal is exactly the one the contract exists to remove
(`packages/capability/src/services.ts:3-9`). `TASK_TRACKING_PORT` is the concrete instance — delegation looks a tracker up on
the run's service registry under an owner-neutral key rather than naming the providing package
(`packages/capability/src/task-tracking-port.ts:60-66`).

### 7.3 Structural (non-import) coupling

`ContextPort` and `TracePort` are satisfied **structurally**: the loop's `LiveContext` and
`TraceHandle` are assignable with no adapter and no cast (`packages/capability/src/ports.ts:7-11`). Likewise `Logger` is
shaped so pino's `LogFn` satisfies it without this package depending on pino (`packages/capability/src/ports.ts:18-21`), and
`ToolArgValidate` is a function type rather than a shared helper precisely so the JSON Schema
implementation stays in the engine (`packages/capability/src/loop-contract.ts:16-21`). `AgentBuildContext` is described as a
structural subset of the engine's richer build context, and the docstring says adding a member is a
widening of the contract, preferring a port over exposing an engine type
(`packages/capability/src/loop-contract.ts:42-45`).

## 8. Open questions

- **Why the timeouts are 5000 ms and 2000 ms.** `CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS`
  (`packages/capability/src/env.ts:153`) and `CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` (`:165`) carry
  those defaults and a 60000 ms ceiling on the first, with no comment or test explaining the numbers.
- **A `projected()` event with no detail is dropped by the kernel.** `projected` deliberately omits
  the `detail` key when the event has none (`packages/capability/src/contract.ts:359`, pinned
  `packages/capability/tests/unit/capability-ports.test.ts:110-116`), while `capabilityEventToProto` returns `null` when
  `event.wire.detail === undefined` (`packages/kernel/src/runs/map-events.ts:347-358`). Whether that
  combination is intended — a detail-less projected event being unrenderable — or an oversight is not
  stated anywhere in either file. Flagged for [loop-capability-composition](../engine/capability-composition.md) / the kernel document.
- **The self-import scan has two blind spots.** `packages/capability/tests/architecture/self-import.test.ts:7`
  matches only `from "..."` clauses, so a bare side-effect `import "@clarvis/capability"` or a dynamic
  `await import("@clarvis/capability")` would not be caught; and line 16 strips only `/** ... */`
  blocks, so a `//` comment mentioning the specifier would be a false positive. Neither case exists in
  `src` today.
- **`INV-C9` is half-pinned.** `packages/capability/tests/unit/registry.test.ts:38-44` proves `specs()` returns a fresh
  array; nothing asserts the same for `grants()`, though `packages/capability/src/registry.ts:74` implements it identically.
- **`RunCapability.order` semantics are declared here but enforced elsewhere.** The default of `0` and
  the "lower runs first, registration order breaks ties" rule are stated at `packages/capability/src/contract.ts:225-231`; the
  only sort is `packages/loop/src/runtime/capability-order.ts:15`. No test in this package pins it.
  Delegated to [loop-capability-composition](../engine/capability-composition.md).
- **`SubagentCapabilitiesFactory`** (`packages/capability/src/contract.ts:337-339`) is exported and typed but has no consumer
  inside this package; where it is threaded into the spawn path is delegated to
  [loop-capability-composition](../engine/capability-composition.md).
- **`Capability.persistedTraceProjectors`** (`packages/capability/src/contract.ts:135`) is declared on the contract, but the
  registry that consumes it (`packages/capability/src/trace-projectors.ts:34-69`, tested at
  `tests/unit/trace-projectors.test.ts`) belongs to [trace-recording-and-persistence](trace.md); only the
  declaration is covered here.
- **`CapabilityRunPolicies` has no reader in this package.** `capability-run-policies.ts` defines the
  schema and the two types (`:4-19`) but nothing under `packages/capability/src/` consumes them, and
  no test in `packages/capability/tests/` exercises the schema. Who validates a plugin's run policies,
  and what a `review` mode means, is outside this document.
- **The `tasks.ts` dedupe registry is process-global module state.** `lastEmission`
  (`packages/capability/src/tasks.ts:21`) is a module-level `Map` shared by every caller in the process, so two unrelated
  subsystems using the same `operation`/`workspace` pair rate-limit each other. Whether that sharing
  is intended is not stated; every test that could collide passes a UUID, either as an explicit
  `dedupeKey` (`packages/capability/tests/unit/tasks.test.ts:47`, `:101`) or inside the `operation` string
  (`packages/capability/tests/unit/tasks.test.ts:60`, `:81`).
- **`ports.ts` re-export surface vs. `index.ts`.** `trace.ts` does `export * from "./trace-kinds.ts"`
  (`packages/capability/src/trace.ts:9`) while `index.ts` enumerates its type exports explicitly (`packages/capability/src/index.ts:315-368`), so at
  least one type (`VisionAnalysisDetail`, declared at `packages/capability/src/trace-kinds.ts:277`
  and named nowhere in `index.ts`) is reachable through `./trace` but not through `.`. Whether that asymmetry is deliberate is not
  recorded in either file.
- **Rationale is generally absent by design.** Where the source carries a `@remarks`
  block giving a reason, this document quotes it and cites the line. Where it does not, no reason is
  derivable and none is asserted here — see §2.7 for the two such gaps in `api.ts` itself (why
  `AgentsParam` has exactly the ten ceilings it has, and why `BudgetConfig` models only
  `stop`/`escalate`).
