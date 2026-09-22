# Judge ownership and configuration

## Ownership

`@clarvis/judge` owns semantic reviewer configuration and the associated model-reference declaration.
It is a product capability boundary, distinct from the Loop engine, neutral authority vocabulary,
and Protocol transport DTOs. It cannot depend on Kernel, Tools, Protocol or other product
capabilities. Authority installation, effect consumption, final authorization and human fallback
remain host-owned. Command review uses the isolated execution path; effect/configuration review uses the same private boundary.

Production: [settings.ts](../../packages/judge/src/settings.ts), `judgeSettingsSpec`.
Test: [dependencies.test.ts](../../packages/judge/tests/architecture/dependencies.test.ts),
`Judge keeps its runtime imports below its host and product peers`.

## Settings and request schema

Cross-package integration fixtures access the production coordinator through `@clarvis/judge/testing`,
not relative internal imports or a parallel reviewer implementation. Production hosts use the capability.
Production: [testing.ts](../../packages/judge/src/testing.ts), `createJudgeCoordinator` export.
Test: [review-runtime.ts](../../packages/kernel/tests/helpers/review-runtime.ts), `commandReviewFixture`
and `effectReviewFixture`, exercised by the Kernel Judge and effect-review integration suites.

`effect_review` accepts optional model, positive timeout up to the timer representation ceiling,
validated against `CLARVIS_TIMEOUT_CEILING_MS` by the ordinary profile validator, nonnegative retries
bounded by `CLARVIS_RETRY_CEILING`,
`on_unsure` (`ask` or `deny`; Auto ignores `ask` and refuses to the calling agent) and rollout
(`shadow`, `local`; both scope configuration review only, never command authorization). A document
written before the `ci_retry` stage was withdrawn still parses: that spelling normalizes to the
conservative `local` ceiling rather than failing validation, because a rejected document is
discarded whole and would silently drop every unrelated setting beside it. Any other value is still
rejected. Its merge is last-wins,
with global/workspace restrictions applied by Kernel. Calls inherit `CLARVIS_DEFAULT_CALL_TIMEOUT_MS`
(180000 ms by default) and `CLARVIS_DEFAULT_MAX_RETRIES` (three retries by default), with denial on
uncertainty. There is no private transport retry default or ceiling. The strict per-run `guard_judge` parameter accepts the same model,
timeout, retry and uncertainty overrides plus nonempty guidance up to 32768 characters, but no
rollout override. Additional guidance is optional and never replaces host policy or evidence.
Unknown fields are rejected, not translated. `guard_mode` remains owned by tools policy.

Production: `effectReviewSchema`, `guardJudgeSchema`, `JUDGE_DEFAULTS` and `judgeRequestConfig` in
[settings.ts](../../packages/judge/src/settings.ts).
Test: [settings.test.ts](../../packages/judge/tests/unit/settings.test.ts), `Judge settings ownership`
(the withdrawn-stage normalization and the still-rejected unknown value), and the store-level upgrade
regression in
[file-config-store.test.ts](../../packages/kernel/tests/integration/file-config-store.test.ts),
`FileConfigStore — settings upgrade`.

Absent runtime overrides remain absent through settings merging. Workspace configuration may only
lower the effective runtime defaults or explicit operator limits. Protocol correction remains
separate: three corrections per stage use ordinary tool feedback, not another transport retry loop.
Production: `resolveEffectReviewSettings` in
[effect-review-settings.ts](../../packages/kernel/src/config/effect-review-settings.ts) and
`createHostJudge` in [judge-host.ts](../../packages/kernel/src/guard/judge-host.ts).
Test: [effect-review-settings.test.ts](../../packages/kernel/tests/unit/effect-review-settings.test.ts)
and [judge-host.test.ts](../../packages/kernel/tests/integration/judge-host.test.ts) pin workspace
narrowing and non-default environment timeout/retry inheritance.

Provider timeouts are classified through the shared `ModelCallInactivityError`; an aborted child
signal alone is not evidence of a provider timeout. Parent cancellation takes precedence.
Production: `reviewerFailureKind` in [reviewer-trace.ts](../../packages/kernel/src/guard/reviewer-trace.ts).
Test: [reviewer-trace.test.ts](../../packages/kernel/tests/unit/reviewer-trace.test.ts).

## Host registration and model validation

Kernel registers `judgeSettingsSpec` before parsing settings or requests. `KernelSettingsFile`
composes the typed settings block; the neutral `RunRequest` has no reviewer configuration field.
Consumers use `judgeRequestConfig` through `CapabilityRequestView.requestParam`. The spec declares
only an explicit reviewer model through the generic `referencedModels` callback. Provider-only
usage and exact logical-model resolution therefore use the engine's existing validation paths.
Protocol retains structurally equivalent transport DTOs without a Judge dependency.

Production: [capability-registry.ts](../../packages/kernel/src/config/capability-registry.ts),
`kernelCapabilityRegistry`; [request-schema.ts](../../packages/loop/src/validation/request-schema.ts),
`validateBody`.
Test: [judge-settings-registration.test.ts](../../packages/kernel/tests/component/judge-settings-registration.test.ts)
and [request-schema-facade.test.ts](../../packages/loop/tests/component/request-schema-facade.test.ts).

## Plugin prohibition

The registered settings spec forbids plugin contribution. The Kernel's `parsePluginManifest`
provides its capability registry to the generic parser; registered prohibition messages are enforced
even though foreign manifest metadata remains accepted. Registered plugin contribution/description
surfaces remain unsupported. No plugin can silently supply reviewer settings after their extraction
from the engine's static schema.

Production: [manifest-schema.ts](../../packages/kernel/src/plugins/manifest-schema.ts),
`parsePluginManifest`; [plugin-schema.ts](../../packages/loop/src/settings/plugin-schema.ts),
`pluginManifestSchemaFor`.
Test: `Kernel rejects reviewer configuration in plugins through the registered prohibition` in
[judge-settings-registration.test.ts](../../packages/kernel/tests/component/judge-settings-registration.test.ts).

## Coupling

Judge depends on neutral Capability contracts, Loop execution and zod. Kernel composes it; Loop
consumes only generic settings declarations. Command/effect review policy and safety invariants
remain in [command guard](../execution/command-guard.md) and [effect review](../execution/effect-review.md).
Registry and parsing mechanics remain in [request and settings](../engine/request-and-settings-schema.md).

## Private persistence prerequisite

Kernel owns `createJudgeTraceStore`, which composes the internal visibility view with a closed
write projection. The native host uses this factory for private command review executions.

The projection rebuilds requests, responses and durable events using strict field tables. It keeps
execution identity, owner, session, status, timestamps, model identifiers and token/cache counters.
Prompts, model output, tool arguments/results, provider credentials, private state and final context
are replaced with constants or omitted. Provider-controlled tool call identifiers become opaque
per-store keyed identifiers, preserving lifecycle correlation without retaining their text.
Recognized live-only iteration and streaming events are validated and discarded from both journals
and final records. Unknown kinds or unclassified fields fail closed. Journal projection failure
closes that journal; final-record projection failure prevents insertion, with no raw fallback.
The stored request remains valid for the engine parser and crash recovery.

Production: [judge-trace-store.ts](../../packages/kernel/src/guard/judge-trace-store.ts),
`createJudgeTraceStore` and `createJudgeTraceProjection`;
[judge-request-projection.ts](../../packages/kernel/src/guard/judge-request-projection.ts),
`projectJudgeRequest`;
[judge-response-projection.ts](../../packages/kernel/src/guard/judge-response-projection.ts),
`projectJudgeResponse`;
[judge-event-projection.ts](../../packages/kernel/src/guard/judge-event-projection.ts),
`createJudgeEventProjection`.
Test: [judge-projection.test.ts](../../packages/kernel/tests/unit/judge-projection.test.ts)
checks strict reconstruction and rejected evolution;
[judge-private-persistence.test.ts](../../packages/kernel/tests/integration/judge-private-persistence.test.ts)
runs the ordinary engine through real JSON storage on successful and failed provider calls and
checks journals, summaries and records for sentinel payload leakage. The same test exercises the
public RunService over that physical store: get, context, both compaction modes and delete report
not found; continuation reports unavailable before inference and leaves the private record intact.

## Private step protocol

`judge_step` has exactly three strict actions: `compile_authority`, `decide_effects` and
`decide_command`. The internal state machine validates the complete response before admitting an
action; multiple calls never partially install authority. Text-only responses, absent/foreign calls, malformed
arguments, repeated actions and wrong order produce classified correction feedback. Up to three
correction retries per stage follow the initial attempt through ordinary Loop tool results, without
operator questions. Exhaustion terminates as `invalid_response`. A command receipt completes directly. A compile transaction returns a validated
envelope, revision and transition token; only a decide referencing that exact revision/token may
complete the effects case. An existing host transition allows a direct decide.
Accompanying text does not invalidate a single valid call and is never parsed as a decision or
authority. Conflicting prose cannot override validated tool arguments. Text remains private context;
the existing projected trace does not publish it. Schema, ordering and host validation remain mandatory.

The host callback captures case identity and expected revisions. It owns semantic validation and
installation; returning no transition rejects the candidate without installing it and permits correction.
Host-rejected terminal receipts also receive correction before completion. A stale context is returned
to the coordinator's existing stale fence rather than being treated as a correctable authorization.
The host transaction is consumed only when installation is attempted, not by an invalid candidate.
A thrown host failure propagates
unchanged instead of becoming uncertainty. Closing a pending case discards its late receipt but
does not roll back a completed host installation. These protocol modules serve the private capability and executor; the native host integrates them through the public coordinator.

Production: [private-protocol.ts](../../packages/judge/src/private-protocol.ts), `judgeStepSchema`
and `compiledAuthorityTransitionSchema`; [step-machine.ts](../../packages/judge/src/step-machine.ts),
`createJudgeStepMachine`.
Test: [step-machine.test.ts](../../packages/judge/tests/unit/step-machine.test.ts) checks exact stage
transitions, rejection before installation, host fault propagation and late-result fencing.


## Private run contribution

`createJudgeRunCapability` creates one mandatory `judge-private` contribution for the entry agent,
with one `judge_step` tool, no provider-side forced selection, and an injected aggregate output budget. Its response-admission
seam checks the complete model response before dispatch without executing authority transactions.
A command run publishes the strict `decide_command` schema rather than the three-action union;
admission applies that same schema, the state machine still enforces its stage, and effect runs
retain their staged protocol. Both schemas declare an explicit object root while preserving their
closed variants. Tool selection is enforced by local admission and bounded correction for every model.
A handler without admission fails closed. Compile invokes the host transaction in the handler and
returns a tool result; decide returns a terminal completed structured receipt in that same iteration.
A raw text finalization without response admission is terminal `judge_invalid_response`.
The executor routes invalid complete responses through a synthetic private tool call; its handler
returns classified correction feedback via the ordinary Loop dispatch contract. No new inference
loop or general engine retry mechanism is introduced. Host transaction exceptions
terminate with `internal_error` and remain separately available to the executor so they cannot be
mistaken for semantic uncertainty. Teardown and run-end close the state machine. No human tool or
channel is contributed. The native host composes the public capability.

Kernel's closed trace projection explicitly classifies the fixed `judge_invalid_response` code
alongside engine codes; arbitrary codes remain rejected.

Production: [run-capability.ts](../../packages/judge/src/run-capability.ts),
`createJudgeRunCapability`; [judge-response-projection.ts](../../packages/kernel/src/guard/judge-response-projection.ts),
`projectJudgeResponse`; [judge-event-projection.ts](../../packages/kernel/src/guard/judge-event-projection.ts),
`createJudgeEventProjection`.
Test: [run-capability.test.ts](../../packages/judge/tests/integration/run-capability.test.ts)
runs the ordinary engine and asserts the command-only provider schema, one iteration for command,
two for compile/decide, terminal
errors after bounded correction, recovery from text-only output with correction feedback, explicit
object roots without forced selection, a single tool catalog and no partial compile on multiple calls.


## Isolated execution and cache prefix

`executeJudge` constructs dependencies by an explicit allowlist from the host factory. It passes the
current effective base provider to that factory, which may wrap it for host observability, then the
ordinary engine applies child identity/cache decorators once. The request names a fresh host-supplied
execution ID, the parent session, agent instance `judge` and the parent-resolved TTL. It has one
private profile, no MCP servers or grants, no continuation, no compaction and only the private
capability. Elicitation, steering, tool interruption, host metadata and authority substrate are not
copied. The factory supplies empty connection machinery and the projected internal trace store.

The sole system block is fixed policy without a version label. Canonical object-key ordering applies within every
user block and arrays retain their semantic order. Fixed configuration includes host-captured
global and workspace persistent instructions, with source and content identity. The user sequence is fixed configuration,
dedicated Goal slot, dedicated Plan slot, one chronological block per authenticated operator
evidence entry, current authority fence, then the volatile case. Goal and Plan slots contain only
their bounded host-attested semantic projections; the work run's operational Goal reminder and Plan
CAS/task-status header are excluded. Empty slots serialize as `null`, so their positions never move.
New operator input extends the stable evidence prefix instead of rewriting preceding entries. The
authority fence excludes evidence, persistent instructions and review context because those already
occupy dedicated blocks. Instruction changes invalidate from the configuration slot.
Non-JSON/cyclic input is rejected. The private provider adapter validates the exact sequence and
preserves engine breakpoints while adding the end of the stable evidence prefix. Compile's tool
result supersedes authority in the private transcript without rewriting that prefix. Independent
cases share no transcript.

Policy treats captured instructions as operator intent, with direct operator messages taking
precedence. Routine necessary inspection, local validation and bounded prerequisites do not need
the operator to repeat each command. An allowlist miss or static dynamic-expansion limitation is
a review trigger, not evidence of prohibition. The reviewer evaluates every segment and side effect;
`unsure` is reserved for material missing facts and is a closed refusal to the calling agent, not a
handoff to a person. The reviewer must not request, imply or wait for operator approval or a TUI
prompt. A conventional name, path prefix or location under
a temporary directory does not prove that a target is discardable; a recognized cleanup does not
authorize other effects in the same call; a constructor in the command text is not filesystem
attestation. This does not widen publication authorization,
descriptor ceilings, human-only boundaries or the configured fallback.
Policy separates evidence precedence, operator authorization, intrinsic risk, decision and protocol.
Low risk cannot create authority; explicit authorization does not make dangerous effects low risk.
Necessary implementation steps remain bounded by trusted scope, prerequisites, targets and restrictions;
they do not authorize unrelated effects. The policy uses general principles rather than workflow or
command examples or a catalog of command-specific rules. Concrete operations come from the current
case and host-provided descriptors, not hardcoded workflow vocabulary in the policy.
Trajectory interprets only the concrete current case, never hypothetical future grants or
denials. Correction feedback repairs protocol output without changing authority or replaying an installation.
The output remains `judge_step`, never a high/low classifier. Changing the fixed policy invalidates
the old system prefix once; message positions and subsequent append-only cache framing are unchanged.

Production: `JUDGE_POLICY` and `judgePrompt` in [prompt.ts](../../packages/judge/src/prompt.ts).
Test: [execution-boundaries.test.ts](../../packages/judge/tests/unit/execution-boundaries.test.ts)
and [judge-host.test.ts](../../packages/kernel/tests/integration/judge-host.test.ts).
`policy separates risk from authorization without replacing the private protocol` checks the shipped
policy contract, not probabilistic model compliance.

Per-attempt output caps are 1024 for command and 2048 for effects. The aggregate output budget is
cap times configured transport attempts times four correction attempts times the closed stage count. Its reservations cap each retry group
independently. The child input/output token ceiling is the host environment ceiling, independent of
the parent ledger. Call timing belongs to the shared provider: streaming activity renews the
inactivity window and transport retries receive the ordinary per-attempt window. No private
wall timer or stage-derived run timeout is installed. The ordinary Loop resolves run inactivity
from `CLARVIS_DEFAULT_TIMEOUT_MS` and validates profile timeout overrides against the host ceiling.
The host resolves absent call overrides from its effective environment; workspace settings may
only reduce that default or the explicit operator limit. `ModelCallInactivityError` is the shared
Capability error subtype, preserving timeout classification and usage without inspecting error prose.
The adapter permits four correction calls per stage but fences provider/framing failures so the
engine cannot issue another external call after such a failure.
The original provider failure remains available for host policy. Retries
inside the existing provider wrapper retain their configured limits and accounting.

A response received after cancellation/deadline never yields a receipt; known usage, including
retried usage, is attributed once. Host transaction and prompt-framing failures are rethrown after
engine settlement and cannot become semantic uncertainty. Completed receipts are validated again
before being returned. Provider errors, timeout and invalid response remain distinct outcomes. Invalid complete responses
are routed to a synthetic rejected private tool call while preserving their usage; the handler returns
bounded correction feedback or terminates on exhaustion. Empty or reasoning-only responses cannot trigger the engine's ordinary
empty-response nudge. A successful packet arriving after parent cancellation retains its usage but
cannot install authority or yield a receipt.

Production: [executor.ts](../../packages/judge/src/executor.ts), `executeJudge`;
[execution-budget.ts](../../packages/judge/src/execution-budget.ts), `createJudgeOutputBudget`;
[prompt.ts](../../packages/judge/src/prompt.ts), `JUDGE_POLICY`, `canonicalJudgeJson` and
`judgeCacheBreakpoints`.
Test: [executor.test.ts](../../packages/judge/tests/integration/executor.test.ts) checks identity,
TTL, caps, stages, exact usage, provider fault/cancellation and independent prefixes;
`executor leaves call timing to the shared provider and run inactivity to the Loop` checks that
no second call timer is installed. `host-owned inactivity_retry Judge links provider events to one
projected private run` in [judge-host.test.ts](../../packages/kernel/tests/integration/judge-host.test.ts)
checks shared inactivity retry and usage accounting with a non-default host timeout.
`ordinary Loop corrects %s with append-only feedback and bounded attempts` verifies recovery,
per-stage limits, a single installation and unchanged message prefixes across corrections.
[execution-boundaries.test.ts](../../packages/judge/tests/unit/execution-boundaries.test.ts)
checks reservations, canonical JSON and framing rejection. These deterministic tests do not prove
provider KV-cache hits; that requires the live canary before final qualification.


## Public capability and coordinator

`createJudgeCapability` uses a host-provided pure `requiredFor` predicate, without static global
requiredness or a human-input declaration. Activation synchronously binds dependencies and publishes
exactly one coordinator through `JUDGE_PORT`. Its entry contribution is empty; it adds no work-run
tools. `onRunEnd` retires that coordinator. Every physical run gets its own instance and caches.
Consumers read the port lazily after activation, independent of capability registration order.
The host must exclude this capability from compositions where automatic review is impossible.
Native composition and command consumer integration are active; effect/configuration consumers use the same port.

The coordinator accepts JSON-only current-case facts separately from trusted synchronous snapshot,
fence and receipt-validation bindings. Keys include work execution identity, command/effects path,
complete canonical snapshot and case, effective model, TTL, timeout/retries and policy. Concurrent
identical evaluations share one private execution. Each joining caller still applies its own fence
and validator. A validator may examine the receipt's host-bound transition when checking the revision
change caused by the coalesced compile transaction; external changes remain stale.

Only host-validated allow/deny receipts are cached. Cache values are copied across caller boundaries;
validators recheck cache hits. Command receipts retain run-lifetime memoization; effect receipts keep
the existing clear-at-128 policy. Compile has no cache: reuse comes from the host ledger. After an
installation, the decide receipt is keyed against the current installed snapshot, enabling the next
identical direct decide to reuse it. Uncertainty, invalid output, stale state and operational failures
are never cached. The coordinator owns neither consent nor refusals nor effect consumption.

Retirement aborts the child signal, waits for tracked work, clears caches and rejects later inference
as cancelled. Missing effective model returns an admission failure. Provider classifications remain
separate from semantic uncertainty. `JudgeArchitectureError`, host transaction failures and host
validator failures propagate as errors; they must never enter human fallback. No human channel is
accepted by this API.

Production: [capability.ts](../../packages/judge/src/capability.ts), `createJudgeCapability` and
`JUDGE_PORT`; [coordinator.ts](../../packages/judge/src/coordinator.ts), `createJudgeCoordinator`;
[errors.ts](../../packages/judge/src/errors.ts), `JudgeArchitectureError`.
Test: [capability.test.ts](../../packages/judge/tests/integration/capability.test.ts) checks physical
ownership, one preflight evaluation, lazy lookup and retirement through the ordinary engine;
[coordinator.test.ts](../../packages/judge/tests/integration/coordinator.test.ts) checks concurrent
deduplication, complete-key invalidation, post-compile reuse, host validation, classified failures and
retirement without another provider call.


## Native host composition

`createHostJudge` binds the projected internal store and empty connection manager once per native
FileKernel. Activation resolves host settings, then supplies the work run's exact effective base
provider, resolved TTL and trusted host ports. Private diagnostics use the no-op logger so provider
prose cannot escape through ordinary host logs. Missing trace/authority substrates or observation
identity are architecture errors, not uncertainty.

The pure eligibility predicate includes edit/exec profiles when tools are enabled and mode is Auto
or off; automatic configuration review remains possible in off mode. Explicit human-only mode and
read-only ceilings exclude it. Memory indexing filters Judge from inherited capabilities. Container
composition does not invoke the native FileKernel factory. Command, configuration and effect review use this binding.

Each actual inference emits one parent `guard_reviewer_model_call` with private
`judge_execution_id`, live stage/authority revision and consumer metadata. Cache hits emit none.
The parent execution ledger excludes the child's usage; private records retain their own accounting.
An effective host Goal usage wrapper still observes parent and child calls exactly once; isolating
the child's execution ledger does not remove that host wrapper.
For an ordinary hosted run, the Session settlement adds the measured parent Guard call events
once to cumulative tokens and cost, without changing the parent execution ledger.
Consumer/effect observation metadata does not change semantic cache identity. Cancellation of the
coordinator is classified separately from the per-stage timeout signal.

Production: [judge-host.ts](../../packages/kernel/src/guard/judge-host.ts), `createHostJudge` and
`judgeRequiredFor`; [file-kernel.ts](../../packages/kernel/src/file-kernel.ts), `createFileKernel`;
[pass-deps.ts](../../packages/kernel/src/memory/pass-deps.ts), `composeIndexPassDeps`;
[reviewer-trace.ts](../../packages/kernel/src/guard/reviewer-trace.ts), `callReviewerWithTrace`.
Test: [judge-host.test.ts](../../packages/kernel/tests/integration/judge-host.test.ts),
`host-owned %s Judge links provider events to one projected private run` and the eligibility
case; [index-pass-deps.test.ts](../../packages/kernel/tests/unit/index-pass-deps.test.ts) checks the
filtered capability set and preservation of input dependencies.

Workflow manager and leader executions preserve the host's Judge capability. Goal formulation and
Steward replace inherited capabilities with their own restricted surfaces, excluding Judge even
when the inherited capability declares itself required. Formulation retains only canonical
workspace reads; Steward retains only its result tool. Memory indexing removes Judge before
admission.

Production: [workflows-service.ts](../../packages/kernel/src/workflows/workflows-service.ts),
`auxiliaryWorkflowRunDeps`; [run-leader.ts](../../packages/workflows/src/run-leader.ts), `runLeader`;
[agent-runtime.ts](../../packages/kernel/src/goals/agent-runtime.ts), `createKernelGoalAgentRuntime`;
[steward-runtime.ts](../../packages/kernel/src/goals/steward-runtime.ts), `createStewardExecutionRuntime`.
Test: [workflows-service.test.ts](../../packages/kernel/tests/integration/workflows-service.test.ts),
the workflow memory ownership journey observes Judge activation in manager and leader executions;
[goal-auxiliary-usage.test.ts](../../packages/kernel/tests/unit/goal-auxiliary-usage.test.ts) inspects
the formulation executor dependencies;
[goal-steward-runtime.test.ts](../../packages/kernel/tests/unit/goal-steward-runtime.test.ts) verifies
required Judge exclusion while retaining only the Steward result gate.

The Container boundary rejects every supplied `guard_judge` value, including an empty object,
and guard modes Auto/On before inference. Guard off remains admitted without a Judge child.
Production: [container-native.ts](../../packages/kernel/src/hosting/container-native.ts),
`createContainerNativeKernel` request assembly.
Test: [container-kernel-host.test.ts](../../packages/kernel/tests/integration/container-kernel-host.test.ts),
`Container rejects Judge request controls before inference and permits guard off`.
The private executor also discards an inherited required Judge capability rather than recursively
activating it; [executor.test.ts](../../packages/judge/tests/integration/executor.test.ts),
`executor isolates %s and reuses the effective host provider`, exercises both command and compile paths.


Effect consumers supply installed transitions through the trusted execution binding. The executor
puts an existing case-bound transition in the volatile case message as `host_transition`, alongside
`facts`; it is never part of the canonical snapshot breakpoint. Compile returns its authoritative
transition through the tool result. Semantic cache keys retain the original facts and rekey against
the installed host snapshot, without introducing case-specific tokens into the stable prefix.
Production: `executeJudge` in [executor.ts](../../packages/judge/src/executor.ts), and
`createHostEffectReview` in [effect-review.ts](../../packages/kernel/src/guard/effect-review.ts).
Test: `successive %s cases share the exact stable prefix, not their transcript or transition token`
in [executor.test.ts](../../packages/judge/tests/integration/executor.test.ts).

The public `canonicalJudgeJson` serializer is shared by host case digests/in-flight identities and
coordinator keys, so reordered object properties cannot turn a coalesced receipt into a stale case.
Production: `canonicalJudgeJson`, `createCommandReview` and `createHostEffectReview`.
Test: canonical property-order checks in Judge's execution-boundary tests and coordinator tests.
