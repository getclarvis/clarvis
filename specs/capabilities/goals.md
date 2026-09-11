# Persistent conversation goals

## Ownership and authority

`@clarvis/goal` owns objective state, bounded schemas, user-control transitions, execution policy and
criteria evaluation. It does not depend on the loop, kernel, plan or protocol packages. The host owns
the authenticated conversation, durable session transaction, physical run lifecycle, authority and
evidence lookup. `GoalRepository` describes a transaction over the existing session document; it is
not another authoritative store. `GoalRuntimePort` binds model operations to one host-selected entry
agent and run. Children return their work to that entry rather than controlling the objective.

Production: the ports in [ports.ts](../../packages/goal/src/ports.ts), strict schemas in
[schemas.ts](../../packages/goal/src/schemas.ts), and user controls in
[control.ts](../../packages/goal/src/control.ts).
Test: `goal user controls` in [domain.test.ts](../../packages/goal/tests/unit/domain.test.ts) verifies
session isolation, physical exclusion, CAS and operation replay.

`update_goal` accepts an object with one `update` property. Its nested discriminated alternatives
describe exactly the progress, checkpoint, candidate and blocked arguments accepted at dispatch.
The catalog is generated from the input schema using JSON Schema draft 7; optional evidence arrays
retain their empty default. Fields belonging to another action and caller-selected authority remain
invalid. A flat superset of action fields is not equivalent: a provider can require those siblings
and then produce a checkpoint containing candidate or blocker fields that the runtime rejects.
Production: `goalModelToolInputSchema` in [model-input.ts](../../packages/goal/src/model-input.ts),
`buildGoalTools` in [tools.ts](../../packages/goal/src/tools.ts) and the bound handler in
[capability.ts](../../packages/goal/src/capability.ts).
Test: the branch catalog in [tool-schema.test.ts](../../packages/goal/tests/unit/tool-schema.test.ts)
and valid/privileged action cases in [capability.test.ts](../../packages/goal/tests/unit/capability.test.ts).

## Client presentation boundary

The Code goal parser recognizes only explicit control verbs. `/goal -- <text>` protects a literal
objective beginning with a reserved word. A malformed control is refused rather than forwarded as
an objective. The presentation controller subscribes before its initial state read, coalesces
invalidations and suppresses late reads after a conversation generation changes. It never starts
or schedules a run. Local presentation generations do not cross the goal service seam as authority.

Every user mutation gets one operation ID and carries its reviewed CAS revision when supplied.
After a lost reply the controller queries the same operation's receipt; it does not repeat the
mutation. Unconfirmed operations survive presentation resets/reconnects within that TUI process,
bounded to 32 conversations. A missing receipt remains distinct from a failed receipt lookup. An
explicit refusal with a successful absent-receipt lookup permits another user action; unknown
outcomes block further mutations until recovered. A stale form cannot silently apply to a newer
revision or another conversation whose revision happens to match.
The edit form compares its reviewed snapshot and submits only changed fields. Saving an unchanged
draft performs no mutation; changing limits alone does not send objective or criteria. A confirmed
control or recovered receipt remains successful if its independent follow-up state read fails; the
controller reports a stale view and keeps the confirmed receipt instead of inviting a conflicting
retry.

`registerGoalCommands` exposes `/goal`, literal objective creation and the edit/pause/resume/cancel/
clear controls through the normal Code registry. Unsupported hosts refuse controls explicitly.
The deterministic form stages objective, bounded criteria and finite limits in one reviewed mutation;
replacement retains the previous goal and requires confirmation. Editing a terminal goal also uses
replacement. Physical work, including unknown work without a live hosted reference, blocks editing.
The view distinguishes durable goal status, physical execution, completion candidate, checkpoint and
qualitative model assessment. A paused goal may still have a running physical stage.
Human criteria display pending or accepted status from the host's persisted acceptance for the
same criterion and objective revision. The acceptance picker excludes criteria already accepted
for that revision; missing, foreign-criterion or older-revision approvals remain pending.
Terminal goals retain their approval display without offering a new acceptance mutation.
Production: `GoalView` and `humanAccepted` in
[view.tsx](../../packages/code/src/features/goal/view.tsx).
Test: `human approval is $status only for its criterion and objective revision` in
[goal-commands.test.tsx](../../packages/code/tests/integration/goal-commands.test.tsx).

The application root connects canonical goal invalidations to `RunHost.synchronizeGoal`, which
observes automatic stages without switching or retiring the conversation. Earlier painted transcript
entries retain their identities. A stage that already finished is reconstructed from persisted turn
and trace state. The controller remains a presentation layer; only the host admits continuation.
Returning from the goal view keeps older checkpoint publications in history navigation rather
than repeating them in the live tail after a newer stage outcome. The handoff and its rendering
regression are owned by [transcript stability](../hosts/code-transcript-stability.md).
Deterministic rendering and observation tests do not qualify the complete local/remote TUI,
container, real-provider or installed-artifact journeys.

Production: `parseGoalCommand` in [parser.ts](../../packages/code/src/features/goal/parser.ts) and
`createGoalController` in [controller.ts](../../packages/code/src/features/goal/controller.ts).
Test: [goal-parser.test.ts](../../packages/code/tests/unit/goal-parser.test.ts) and
[goal-controller.test.ts](../../packages/code/tests/unit/goal-controller.test.ts) cover literal
commands, sparse edits, CAS, confirmed-receipt refresh failure, receipt recovery, unavailable hosts,
invalidation races and disposal.
Production: `registerGoalCommands`, `GoalForm` and `GoalView` in
[commands.ts](../../packages/code/src/features/goal/commands.ts),
[form.tsx](../../packages/code/src/features/goal/form.tsx) and
[view.tsx](../../packages/code/src/features/goal/view.tsx); `synchronizeGoal` in
[run-host.ts](../../packages/code/src/run-host.ts), wired by
[runtime.tsx](../../packages/code/src/runtime.tsx).
Test: [goal-commands.test.tsx](../../packages/code/tests/integration/goal-commands.test.tsx) covers
literal dispatch, physical-state display, pinned review and replacement confirmation;
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts) covers live and already
closed automatic stages, painted-prefix preservation and a delayed read after conversation change.

## Private session ownership

The kernel implements `GoalRepository` over `HostedSessionTransactions.transact`, using the existing
private session as the sole authority. The internal `HostSessionStore.saveHost` port never enters
the public RPC catalog. Ordinary saves reject all changes to `goal_state`, including omission and
archived records. The kernel validates the schema, byte bound and each current/archived conversation
binding before commit. Replay of an unchanged result avoids another session write. A failed write
after canonical publication is resolved by the persisted operation receipt.
Production: [repository.ts](../../packages/kernel/src/goals/repository.ts),
[session-state.ts](../../packages/kernel/src/goals/session-state.ts), and the coordinator in
[sessions.ts](../../packages/kernel/src/hosting/sessions.ts).
Test: [goal-repository.test.ts](../../packages/kernel/tests/integration/goal-repository.test.ts)
exercises the real private file store, CAS, corruption, public-save refusal and preparation races.

## User controls and durable records

One session has one current goal and a bounded archive. User controls create, edit, replace, pause,
resume, cancel, clear and record acceptance of a human criterion. Creation requires explicit text
and effective finite limits. A normal running conversation cannot retroactively acquire a goal.
Creation over an existing goal requires explicit replacement review. Replacement creates a different
goal identity and archives the old record atomically. An active but physically idle old commitment is
marked cancelled when replaced; completed commitments retain completion in the audit.

`revision` is the CAS revision of state; `objective_revision` changes only with objective/criteria
edits; `control_revision` fences pending admission and late completion. Human acceptance updates its
record and CAS revision without revoking the running commitment. Edits retain all consumption and
continuation counts. Objective edits invalidate candidates and human acceptance; limit-only edits
do not manufacture new evidence. Terminal goals cannot silently reopen.

Each control carries an operation ID and expected revision. The parsed request and session identity
form the receipt fingerprint. An exact replay returns its known receipt without repeating execution
effects; reuse for different arguments fails. The last 64 receipts are retained. Older evicted
operations cannot replay because their original expected revision is obsolete.

For create/replace, omitted limits resolve from host defaults and the finite entry budget after
receipt lookup. Configuration changes do not rewrite the parsed request fingerprint or a known
receipt. Host start controls reserve an execution ID in the receipt before launching work; replay
never repeats that start, including when the original reply was lost.
Production: `GoalControlContext` and `applyGoalControl` in
[control.ts](../../packages/goal/src/control.ts), and `createGoalService` in
[service.ts](../../packages/kernel/src/goals/service.ts).
Test: `replays the reserved start receipt independently of changed configuration defaults` in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts), and the IPC goal journey in
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts).

Archive capacity is eight goals and each goal retains at most 256 run bindings. The goal slice is
bounded to 1 MiB within the existing session limit; ordinary controls leave 64 KiB for settlement
and recovery. Rejection leaves the previous document intact. No audit data is silently discarded.
Goal IDs, execution bindings and operation receipts remain unambiguous across the current record
and audit. A record/receipt revision cannot exceed its owning state revision.

Production: `applyGoalControl` and `boundedGoalState` in
[control.ts](../../packages/goal/src/control.ts), and schema limits in
[schemas.ts](../../packages/goal/src/schemas.ts).
Test: `replaces atomically, retains audit and never reopens terminal goals`, `keeps replay fenced
after bounded receipt eviction`, and the structural/serialized bounds cases in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts).

## Status, physical work and settlement

Statuses are `active`, `paused`, `blocked`, `budget_limited`, `usage_limited`, `complete` and
`cancelled`. Physical phase is independent: `preparing`, `running`, `settling`, `unknown` or `closed`.
Pausing future work does not claim physical cancellation. Cancelling requests termination only of
the goal's bound execution; the host must wait for actual closure before editing, clearing or
replacing. Unknown physical state prevents further admission and requires the host's recovery path.

A future-only pause allows progress, checkpoint proposals and completion candidates from the
already-running stage to remain inspectable. They do not resume the goal or override the later
settlement fence. Cancelled/blocked goals, closed executions and obsolete objective revisions refuse
these model updates. The latest progress annotation is bounded and does not reset the checkpoint
stagnation counter or change confirmed consumption.
Reading or updating the host snapshot inside a tool handler does not publish a context reminder.
Changed reminders are appended after dispatch has recorded every tool result, at iteration entry,
or during teardown after the exchange closes. An intervening pause therefore cannot place a user
reminder between an assistant tool call and its result, which the provider SDK would reject on
continuation. Historical entries retain their order and contents.
Production: `createGoalCapability` in [capability.ts](../../packages/goal/src/capability.ts).
Test: `resumes a paused checkpoint with its complete tool exchange before the changed reminder` in
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts)
captures real SDK requests after explicit resume and automatic continuation; the capability test in
[capability.test.ts](../../packages/goal/tests/unit/capability.test.ts) keeps publication outside handlers.
Production: `recordGoalProgress`, `recordGoalCheckpoint` and `recordGoalCandidate` in
[execution.ts](../../packages/goal/src/execution.ts), with `GoalRun.progress` mapped through
[protocol goals.ts](../../packages/protocol/src/goals.ts).
Test: `retains progress and candidates from a running stage after future-only pause without resuming
or completing` in [domain.test.ts](../../packages/goal/tests/unit/domain.test.ts).

`blockGoalRun` records a running stage's blocker and advances the control fence without changing
its physical phase, usage or continuation count. Repeated blockers are idempotent. A newer pause,
cancel or terminal state remains unchanged; a foreign binding or obsolete objective still fails.
Production: `blockGoalRun` in [execution.ts](../../packages/goal/src/execution.ts).
Test: `records blocking without claiming physical closure and preserves later user controls` in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts).

Admission records one execution/admission identity and the current objective/control revisions.
An exact repeated intent is idempotent; conflicting identity reuse fails. A stale start after pause
fails even if preparation already returned. Closed callbacks cannot reopen physical work. Policy
pause on disconnect/restart retains run bindings and usage and requires explicit user resume.

Settlement is a separate host operation requiring physical closure, including children. It charges
usage against the original execution and goal independently of pause, cancellation or later archival.
An unknown measurement can later be reconciled once; a known measurement cannot be rewritten.
Duplicate settlement has no effect. Completion also requires validated current criteria, successful
gates, successful run outcome and unchanged control/objective revision. A candidate is inspectable
data until this durable commit. A checkpoint never converts failure or cancellation into success.

Production: admission, phase, candidate, checkpoint, policy-pause and settlement functions in
[execution.ts](../../packages/goal/src/execution.ts).
Test: `goal physical settlement, usage and continuation` in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts), including late cancelled/archived
usage, pending-admission pause and unknown physical outcomes.

## Limits and progress

The strict `goals` configuration block is owned by the lightweight `@clarvis/goal/settings` entry
and registered by the kernel before settings parsing. It uses whole-block last-scope precedence:
a workspace block replaces the global block, including omission of its optional token cap or
deadline. Plugins cannot contribute this block, and it adds no model-callable run parameter.

Creation and replacement resolve limits in this order: explicit user control, effective `goals`
configuration, then domain defaults. An omitted `max_net_tokens` inherits the finite entry run
budget once; it is never multiplied by a continuation count. `max_auto_continuations` defaults to
8 (range 0–255), `max_no_progress_checkpoints` to 3 (range 1–32). The token cap is a positive safe
integer below `Number.MAX_SAFE_INTEGER`. Optional `deadline_at` is an absolute Unix timestamp in
milliseconds within that safe counter range; it is independent of run idle timeout. These defaults
are policy values, not measured reliability claims.

The host reads defaults only after receipt lookup and only for creation/replacement. Persisted
limits, consumption and counts survive settings changes and resume. An exhausted continuation
limit still requires an explicit goal edit; increasing the configuration default cannot grant a
live goal another run. Replacement takes current defaults and archives the old limits and usage.
Production: `goalsSettingsSpec` and `goalsSettingsSchema` in
[settings.ts](../../packages/goal/src/settings.ts), `kernelCapabilityRegistry` in
[capability-registry.ts](../../packages/kernel/src/config/capability-registry.ts),
`createFileRunHost` in [file-host.ts](../../packages/kernel/src/hosting/file-host.ts) and
`createGoalService` in [service.ts](../../packages/kernel/src/goals/service.ts).
Test: schema bounds in
[capability-settings-schema.test.ts](../../packages/kernel/tests/integration/capability-settings-schema.test.ts)
and configured/explicit limits, scope precedence, receipt replay, retained resume accounting,
replacement and expired-deadline refusal through file configuration, IPC and SDK in
[goal-file-host-settings.test.ts](../../packages/kernel/tests/integration/goal-file-host-settings.test.ts).

Net tokens are `max(0, input - cached) + output`. Unknown cache is conservatively charged as fresh
input and explicitly labeled estimated. Unknown total usage blocks continuation; it is not zero.
The host normalizes either aggregate run usage or its agent decomposition, including attributable
auxiliary work, before settlement. Run-scoped sequenced estimates do not charge confirmed totals.
In-flight work may exceed the total; `overrun_tokens` records it. No monetary or zero-overrun
guarantee is implied.

An unsuccessful stage whose confirmed cumulative spend exhausts the goal budget settles the goal
as `budget_limited`, retaining the stage's failed/cancelled outcome and measured overrun. A missing
usage measure remains `blocked`, and newer user pause/cancel controls take precedence. A generic
stage failure must not hide that the exhausted goal requires an explicit budget change to resume.
Production: `settleGoalRun` in [execution.ts](../../packages/goal/src/execution.ts).
Test: failed/cancelled settlement and newer-control cases in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts), and `reports budget_limited after
the real loop stops with exhausted measured usage` in
[goal-file-host.test.ts](../../packages/kernel/tests/integration/goal-file-host.test.ts).

Admission requires remaining tokens, deadline and continuation allowance, physical closure and known
usage. Resume preserves spend and used continuations; it cannot grant budget or bypass expired
limits. User intervention may restart a recorded stagnation evaluation. Repeated host activity
fingerprints cannot reset stagnation even if checkpoint wording changes. The host decides relevance
from observed activity; fresh activity alone does not prove useful semantic progress. The independent
run bound remains in force. An invalid final or missing checkpoint blocks immediately.

The host reuses the admission deadline decision before each physical model call in the active
stage. A call already in flight may finish and remains chargeable, but the stage cannot issue a
later call or commit completion after the absolute deadline. Settlement retains the physical outcome
and measured usage while moving the still-current goal to `usage_limited`.

Production: `resolveGoalLimits`, `goalNetTokens` and `goalAdmission` in
[policy.ts](../../packages/goal/src/policy.ts), checkpoint/usage settlement in
[execution.ts](../../packages/goal/src/execution.ts), and the model-call boundary in
[hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts).
Test: finite inheritance, usage/overrun, deadline/continuation, empty-final and repeated-activity
cases in [domain.test.ts](../../packages/goal/tests/unit/domain.test.ts), plus the active-stage SDK
deadline regression in
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts).

The kernel's `measureGoalRunUsage` selects agent detail when present, or otherwise the complete
flat measure. It never adds both forms, cache writes or independent memory jobs. Missing input or
output, empty agent detail and invalid/overflowing counters produce unknown usage. Missing cache
is retained as absence and charged conservatively. `settleGoalSession` combines the domain result
and confirmed session accounting under `HostedSessionOptions.settleSession`, in the same durable
write as the terminal turn. A repeated callback does not charge again. Late measured usage can
resolve a closed unknown binding even after the goal was archived. Unknown usage remains explicit
in goal state; session totals include only the confirmed subset until reconciliation.
Production: [usage.ts](../../packages/kernel/src/goals/usage.ts),
[settlement.ts](../../packages/kernel/src/goals/settlement.ts), and `reconcile` in
[sessions.ts](../../packages/kernel/src/hosting/sessions.ts).
Test: [goal-usage.test.ts](../../packages/kernel/tests/unit/goal-usage.test.ts) covers complete,
unknown, invalid and redundant measures; the atomic settlement and archived late-usage cases in
[goal-repository.test.ts](../../packages/kernel/tests/integration/goal-repository.test.ts) exercise
failures before/after canonical publication. These seams require a host controller to supply the
physical-closure and completion decisions; repository tests do not establish that full lifecycle.

## Criteria and evidence

A completion candidate covers every criterion of the current objective revision exactly once.
Without explicit criteria, the objective text is one qualitative criterion. Qualitative conclusions
retain the model's justification and are identified as model judgment. Human criteria require a
recorded user acceptance at the current objective revision; model prose cannot replace it.

Host criteria declare an explicit verification: success of a named tool, optionally with the
expected argument digest, or an artifact path and expected digest. References identify an existing
result in a run bound to this goal/revision. The host verifier checks the specified result, relevance
and current digest. Missing, invented, foreign, obsolete or contradicted evidence fails. There is
no generic proof engine or independent verifier agent. The host revalidates before completion commit.

Production: criterion/evidence schemas in [schemas.ts](../../packages/goal/src/schemas.ts) and
`validateGoalCandidate` in [criteria.ts](../../packages/goal/src/criteria.ts).
Test: `goal criteria and completion` in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts) covers qualitative labeling, explicit
host checks, human acceptance, foreign references, stale/digest failures and exact coverage.

The kernel's `createGoalEvidenceSource` indexes completed host-observed tool envelopes, including
bound child events, without retaining a second transcript. It keeps at most 512 observations with
1 MiB payload limits and returns at most 32 catalog options. Each option has an opaque ID, stamped
scope, digest and short host-authored description; the description is omitted from persisted evidence.
Oversized or conflicting live observations fail closed. Prior stages are read through the existing
owner-scoped trace reader, restricted to this objective revision. Evicted or unavailable references
cannot establish success. Duplicate persisted events do not move an old result past a newer failure;
conflicting duplicates refuse the snapshot.

Transport success alone does not prove a native `shell` or `host_exec` command succeeded: the parsed
result must report exit zero without timeout or termination signal. The latest result for the same
tool and argument digest supersedes earlier results, including earlier successes contradicted by a
failure. A host criterion must match that tool and its declared argument digest when present.
References from other goals, runs or revisions, unknown IDs and caller-altered digests are refused.
Tool names follow the canonical trace mapper: flat internal names occupy `mcp_name` with an empty
`tool_name`; MCP names join both fields with a dot. Native command validation and control/polling
exclusion apply to the flat form, without treating a qualified MCP tool as a native shell command.
Production: `observation` in [evidence.ts](../../packages/kernel/src/goals/evidence.ts), consuming
`mapEntry` from [trace-mapper.ts](../../packages/trace/src/trace-mapper.ts).
Test: `interprets the real trace mapper's flat tool names without treating goal controls as evidence`
in [goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts)
checks real mapper output, successful/failed commands, control exclusion and qualified MCP names.

Artifact criteria read the actual bytes through the shared `readRawFile` descriptor confinement,
with only the selected workspace admitted and a 16 MiB ceiling. The reference includes the observed
digest; it satisfies an artifact criterion only when path and expected digest match. Verification
reads again to detect mutation, including when the artifact is cited in a qualitative assessment.
Missing, oversized, non-regular or escaping files supply no valid reference. This proves a bounded
snapshot, not permanent immutability or an independent semantic proof.

Checkpoint progress requires referenced observed workspace changes or an explicitly declared
verification. Goal controls and polling are excluded. Stable fingerprints omit call IDs, execution
IDs and output wording, so repeating the same check cannot reset stagnation. The recorded reason
states that the entry attributed this activity to the goal; usefulness is not independently verified.
Finite continuation limits still apply even when new activity is accepted.
Production: `createGoalEvidenceSource` and `goalEvidenceDigest` in
[evidence.ts](../../packages/kernel/src/goals/evidence.ts).
Test: [goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts)
checks real file mutation/confinement, command failures, argument relevance, foreign references,
duplicate/oversized observations, persisted trace replay and repeated-check stagnation.

## Kernel runtime authority

`createGoalRuntimePort` captures the owner-scoped repository, session, persisted entry-agent
instance, execution and objective revision before capability registration. Model arguments cannot
replace that scope or perform user controls. Every operation revalidates its binding; writes require
the latest running stage, reads may also prepare under the unchanged admission fence, and final
validation may run during physical settlement. Future-only pause permits current-stage annotations;
cancel, closed/unknown execution or an obsolete binding refuses them.

Slow evidence reads occur outside the session transaction. State is reread afterward, and the short
write rechecks binding and observation generation. The model cannot publish prepared evidence after
known activity changes. Completion validation checks the current stage's candidate, then rechecks
state revision, candidate and observation generation; it never commits goal completion itself.
Human acceptance comes from the durable user-control record, not the model's assessment.

Mutation resolves only after the canonical session write succeeds. Metadata-only notifications
follow publication; observer failures are logged without undoing durable state. A storage failure
returns an error even if canonical publication already happened, with persisted state remaining
authoritative for recovery. No runtime-port method starts another execution or retries an uncertain
write automatically. Domain/schema/storage failures map to bounded protocol errors and structured
diagnostics without objective text, evidence payloads, file paths or private exception details.
Production: [runtime-port.ts](../../packages/kernel/src/goals/runtime-port.ts) and
[errors.ts](../../packages/kernel/src/goals/errors.ts).
Test: [goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts)
uses the actual private session store, reopen, controlled pause/cancel/read races, publication faults,
observer faults, final-validation phases and cancellation;
[goal-errors.test.ts](../../packages/kernel/tests/unit/goal-errors.test.ts) pins safe error mapping.

## Bound entry capability

`createGoalCapability` is a required, host-registered capability. Its immutable binding identifies
the session, entry-agent instance, execution, goal and objective revision. Activation rejects a
mismatched request or unavailable state. Children receive no goal controls, including children with
a similarly named grant. Every model operation and final gate refreshes the bound state; foreign
evidence catalog entries, obsolete revisions and closed/unknown executions fail closed.

`get_goal` returns current criteria, limits, usage, progress and a bounded host evidence catalog,
excluding the session audit and operation receipts. `update_goal` accepts only `progress`,
`checkpoint`, `candidate` and `blocked`; action-specific schemas reject other fields, caller-chosen
scope and user-only controls. Evidence inputs are opaque IDs. `GoalRuntimePort` resolves and stamps
the corresponding references; the model never supplies trusted execution or goal bindings.
Tool names, descriptions, schemas and order are independent of goal revisions and balances.

Checkpoint returns `HandlerVerdict.finalize` with separate bounded handoff metadata. The goal gate
accepts only a checkpoint requested through its own bound handler, and the remaining gates still
run. The ordinary-final gate always has `fastAcceptOk=false` and asks the host to validate completion
again. A first nonempty invalid final receives one recovery nudge; another invalid final, or the
first empty final, durably reports blocking and stops. An explicit `blocked` action uses interruption
without requiring open tasks to be closed. Storage or binding failure produces `goal_control_failed`
and host attention without reflecting private exception details in the model response.

The activation sets `preserveStateOnInterruption`; it never marks the goal complete in a teardown
hook. Progress wording and status reads are not productive-tool claims. Actual progress acceptance
and finite-run admission remain the host's responsibility. Candidate validation can pass the local
gate while the goal remains active until physical closure and the host's durable completion commit.

The current reminder uses `ContextPort.setStableBlock("goal", ...)`. Iteration entry awaits a fresh
bound read before compaction or inference, independently of model tool selection. A future-only
pause committed before that read appears in the next request even after an ordinary tool batch.
Failed reads stop the stage with `goal_control_failed`; cancellation or timeout retires the iteration
signal so a delayed read cannot publish or replace the retained snapshot. Model controls also refresh
state, with publication deferred until the complete tool exchange is recorded. Unchanged content stays
in place; changed content is appended. It neither replaces the plan's canonical state nor adds an
anchor, output budget or system section. The block summarizes long objective/criterion text and
directs the model to `get_goal` for the complete values. The host store remains authoritative;
no snapshot can resume automation or override a newer user control.

Production: [capability.ts](../../packages/goal/src/capability.ts), model schemas in
[model-input.ts](../../packages/goal/src/model-input.ts), the stable catalog in
[tools.ts](../../packages/goal/src/tools.ts), and projections in
[context.ts](../../packages/goal/src/context.ts).
Test: [capability.test.ts](../../packages/goal/tests/unit/capability.test.ts) covers admission,
entry filtering, action bounds, final recovery, cancellation, faults and context/catalog stability.
`delivers an external pause before another model call without polling a goal tool` in
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts)
captures the real SDK request after a controlled host pause and ordinary tool result, preserving the
previous prefix, catalog and cache identity while preventing another stage.
[goal-capability-composition.test.ts](../../packages/kernel/tests/integration/goal-capability-composition.test.ts)
uses the actual goal capability, loop, plan gates and SDK serialization: a manually admitted second
stage retains the open plan and complete historical prefix, final output follows its schema, and
blocking/refused review retains pending tasks. It uses the real durable host port and verifies
goal state after reopening the session store. Controlled responses and manual stage admission do not prove
automatic hosting admission, durable host completion or real-provider behavior.

## Cross-package integration and qualification

`prepareHostedGoalTurn` is the internal host composition for a bound conversation stage. It derives
scope from `HostedPreparationContext`, rejects skill/workflow or foreign execution identities, and
requires finite iteration limits for every resolved profile. It constrains the resolved run budget
to the lesser configured ceiling and remaining goal tokens and sets `on_exceed: "stop"`. Its required
entry capability and trace observer are supplied to the ordinary execution preparation port.
Preparation errors record bounded blocking without inventing a physical run or billed usage.

The turn and `admitGoalRun` intent publish atomically in the private session. Start then advances the
same binding, rejecting a control revision revoked during preparation. After physical closure the
host advances to settlement, revalidates the actual candidate/evidence outside the session lock,
and records the exact revision returned by that validation. It commits completion only if that
validated revision is still current. A non-revoking human confirmation that lands before the
validation snapshot can therefore settle, while a later revision still fails the fence. A pause or cancellation
that wins during validation is preserved while the run's confirmed usage is still charged. A slow
callback cannot restore completion from an old objective or reopen a closed execution.

After the full registry barrier, its continuation policy re-reads the canonical session, requires
the same active goal/control and latest accepted checkpoint, evaluates remaining limits and returns
one fresh execution identity. The conversation and entry-agent identity remain unchanged. The
registry's host-only continuation provenance distinguishes this from a human stage. A superseding
human reservation discards the old proposal. Retirement pauses and host failure blocks only the
matching stage or still-pending preparation; `stopGoalContinuation` preserves newer controls,
replacement and successor admission without releasing physical work.

Production: [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts),
`stopGoalContinuation` in [execution.ts](../../packages/goal/src/execution.ts), and the admission,
registry and coordinator in [hosting](../hosts/hosted-runs.md).
Test: `settles the exact revision validated after a non-revoking human confirmation` in
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts)
pins the validation/settlement race.
Test: `host continuation retirement` in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts), and
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts).
The latter composes private file sessions, actual hosting, goal gates, loop and SDK with controlled
responses. It verifies two automatic continuations, three separate run intents, decreasing budgets,
single-count usage, complete serialized prefix/cache identity, stagnation, incompatible request
refusal and pause/cancel races. These controlled-SDK tests are separate from TUI and guest qualification.

`createFileRunHost` registers this policy in its ordinary prepared execution path. It exposes a
connection-scoped `GoalService` with availability, state, receipt lookup and strict user controls.
Observer connections receive reads; writes resolve the actual registry controller and revalidate
authority inside the short mutation and after asynchronous preparation. Initial/resumed execution
uses the registry's internal start with that proof. Foreign peers and stale proof copies cannot
control the conversation. Pause retains physical occupancy, and ordinary input cannot resume it.
Native and compatible container hosts advertise the service; headless kernels do not. Container
admission requires the current private protocol, which includes the goal bridge.
The common client returns explicit unavailability when the optional capability is absent.
Production: [service.ts](../../packages/kernel/src/goals/service.ts),
[file-host.ts](../../packages/kernel/src/hosting/file-host.ts), and
[prepare-run.ts](../../packages/kernel/src/runs/prepare-run.ts).
Test: `starts a durable goal over IPC and admits its checkpoint continuation through the real kernel`
and `pause retains physical work, fences foreign control and prevents automatic continuation` in
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts).

Goal preparation wraps the host provider port for that stage. `createGoalUsageTracker` observes
leader, child, compaction and attributed retry calls without changing their options or responses.
Pending calls, rejected calls with no usage, and explicit provider uncertainty remain unknown;
zero-initialized loop or guest totals cannot establish complete consumption. Missing cache detail
alone counts input conservatively. Settlement uses that host observation and retains the per-agent
breakdown only when its totals agree; otherwise it uses the observed aggregate. Unknown usage
prevents automatic continuation and explicit resume until reconciled.
Production: `createGoalUsageTracker` in [usage.ts](../../packages/kernel/src/goals/usage.ts),
`prepareHostedGoalTurn` in [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts),
`createRunService` in [run-service.ts](../../packages/kernel/src/runs/run-service.ts), and
`settleGoalSession` in [settlement.ts](../../packages/kernel/src/goals/settlement.ts).
Test: [goal-usage.test.ts](../../packages/kernel/tests/unit/goal-usage.test.ts) and
[goal-file-host.test.ts](../../packages/kernel/tests/integration/goal-file-host.test.ts).
The latter uses actual IPC, file hosting, SDK and controlled HTTP to cover two automatic
checkpoints with a delegated plan, per-stage closure, exact prefix/catalog/identity preservation,
complete physical-call accounting, pause/resume, cancellation, and missing usage/cache controls.
It does not establish real-provider cache hits or container-engine/installed-artifact qualification.
Test: [goal-file-host-plan.test.ts](../../packages/kernel/tests/integration/goal-file-host-plan.test.ts)
uses real IPC review elicitations, plan gates and host continuation: human approval survives
delegation and two checkpoints; cancellation or requested changes prevents writes and preserves an
unapproved plan with discard retention. Neither refusal admits an automatic successor.
Test: [goal-file-host-compaction.test.ts](../../packages/kernel/tests/integration/goal-file-host-compaction.test.ts)
queues forced compaction through the active hosted handle and executes the actual SDK summarizer
against controlled HTTP. The current goal block and plan survive beside one rolling summary anchor;
the deliberate rewrite is isolated from exact serialized prefix preservation on both sides and
across automatic continuation. Goal/session accounting includes the auxiliary summary call once.
Production: `createGoalCapability` in [capability.ts](../../packages/goal/src/capability.ts),
`attemptCompaction` in [llm-compaction.ts](../../packages/loop/src/runtime/context/llm-compaction.ts),
`createGoalUsageTracker` in [usage.ts](../../packages/kernel/src/goals/usage.ts), and
`prepareHostedGoalTurn` in [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts).
The same `runGoalFileHostJourney` assertion helper is exercised by the optional
[goal-file-host.e2e.test.ts](../../packages/kernel/tests/integration/goal-file-host.e2e.test.ts)
against the actual Docker/Podman runtime factory. It verifies the guest executable through a
delegated tool, records its hash, and checks container/fixture-volume cleanup after host shutdown.
Its controlled HTTP transport is independent of live-provider qualification. Missing opt-in or
engine inputs skip this test; a skip is no engine evidence.

The local `tooling/goal/live.ts` command qualifies the native file host with the existing global
subscription through the kernel's production resolver. A Linux host mount view retains renewable
credentials at their authoritative location and masks unrelated global configuration/state. The
synthetic goal requires a delegated implementation, a checkpoint, automatic continuation and actual
verification; the harness independently reruns an unchanged test file that fails on the baseline.
It observes the original provider beneath the execution seam without replacing the goal usage
tracker, and reuses bounded HTTP observation with its own `goal-continuation` scenario namespace.
Reports distinguish current source inputs, requested/serialized/resolved model and effort, each
agent's weighted cache ratio, prefix/affinity, accounting, physical closure and cleanup. A missing
stage, call usage or checkpoint cannot pass. This native host series does not qualify the TUI,
installed launcher, other runtimes or the separate cache-efficiency matrix.
The version 2 live report retains bounded tool outcomes and argument shapes without copying their
values or successful payloads. This allows rejected goal actions to be diagnosed after temporary
host state is removed. ChatGPT affinity compares hashes according to the subscription contract:
the session header already contains the SHA-256 of the composed cache key.
Production: `goalArgumentShape` and `goalChatGptAffinity` in
[evidence.ts](../../tooling/goal/evidence.ts). Test: safe diagnostic structure and absent/foreign
affinity controls in [goal-live-fixture.test.ts](../../tooling/tests/unit/goal-live-fixture.test.ts).

Production: `runGoalLive`, `runGoalLiveWorker` and `prepareGoalLiveFixture` in
[live.ts](../../tooling/goal/live.ts), [goal-live-worker.ts](../../packages/kernel/tests/helpers/goal-live-worker.ts) and
[fixture.ts](../../tooling/goal/fixture.ts), with the host-only
[authentication view](../../tooling/cache/host-auth-view.ts).
Test: [goal-live-fixture.test.ts](../../tooling/tests/unit/goal-live-fixture.test.ts) verifies the
negative baseline, absence of fixture credentials and bounded call admission without live traffic.
Only a completed live report supplies real-provider evidence; the fixture unit test cannot.

The generic checkpoint seam preserves an open plan and its retention across explicit continuation.
`HandlerVerdict.finalize` goes through the loop's ordinary gates; it never treats checkpoint metadata
as a final output-schema value. A required entry activation sets `preserveStateOnInterruption` so
other capability finalizers retain state on cancellation/error. The accepted disposition survives
response mapping, trace persistence and kernel reopen. These mechanics do not themselves implement
automatic admission or durable goal completion.
Production: [loop-contract.ts](../../packages/capability/src/loop-contract.ts),
[run-agent.ts](../../packages/loop/src/runtime/loop/run-agent.ts), and plan finalizers in
[index.ts](../../packages/plan/src/capability/index.ts).
Test: [checkpoint-composition.test.ts](../../packages/kernel/tests/integration/checkpoint-composition.test.ts)
uses the real SDK transport with controlled responses, file-backed plan and trace stores, explicit
continuation and unchanged serialized prefix/cache identity.

The kernel binds persistence to its existing private session and owns all automatic continuation.
Protocol DTOs remain independent of domain runtime code. The loop only learns generic checkpoint
disposition and mandatory capability behavior. Plan approval, task completion and retention remain
owned by the planning capability. A checkpoint preserves open tasks; a final conclusion must pass
normal plan gates. Goal context uses preserved append-only blocks and never a second compaction
anchor or output budget. Session/agent cache identities survive runs; a goal ID is not cache affinity.

Local and remote TUI controls require the same authenticated conversation/controller guarantees.
`goalRuntimePortOf` projects only factory-created capability authority. The kernel pins one ordinary
entry binding in the private guest envelope and refuses duplicate goal capabilities, workflow
composition and objects forged by name. `runtime.goal` admits only read, progress, checkpoint,
candidate, validation and blocked operations with strict bounded arguments. Generation and physical
call identity are broker-owned; session, instance, execution, objective revision and entry role must
match the admitted binding. The canonical host port rechecks state after evidence reads and inside
the durable transaction. Operation cancellation or revocation before that transaction prevents a
late write; cancellation after a durable write does not undo it or authorize replay.

The guest executes the same capability and finalization gates. Goal calls await preceding guest
trace publications before reading host evidence. The model never supplies user controls, ownership,
run admission or token limits through this bridge. Only the bounded current goal and reference
catalog cross; archives and operation receipts remain in the private host session. A goal run admits
at most 1152 KiB per capability request/result, retaining the broker's call-count, aggregate replay
and RPC bounds. The guest validates response schemas and refuses an absent, stale, contradictory or
foreign descriptor before inference. Compatible images use private protocol revision 12.

Production: `goalRuntimePortOf` in [capability.ts](../../packages/goal/src/capability.ts),
[goal-bridge.ts](../../packages/kernel/src/runtime/goal-bridge.ts),
[runtime-port.ts](../../packages/kernel/src/goals/runtime-port.ts),
[local-container-runtime.ts](../../packages/kernel/src/runtime/local-container-runtime.ts) and
[guest-loop-executor.ts](../../packages/kernel/src/runtime/guest-loop-executor.ts).
Test: [runtime-goal-bridge.test.ts](../../packages/kernel/tests/integration/runtime-goal-bridge.test.ts)
checks private durability, forged identities, replay, cancellation/revocation during queued mutation,
large bounded state, malformed responses and missing projection. The `preserves goal authority, plan
checkpoint and SDK prefix across guest continuation` test in
[runtime-capability-composition.test.ts](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts)
uses the real worker RPC, guest loop, host goal/plan stores and SDK with controlled responses. It
checks plan retention, persisted checkpoint disposition, continued candidate validation and serialized
prefix/catalog/affinity. Manual test admission does not prove automatic hosted continuation or a real
Docker/Podman engine journey.

Unsupported headless, MCP and workflow combinations must be explicit. Guest runtimes require a
bounded host bridge and cannot fall back to host execution when that bridge is absent. Publishing
the complete feature requires controlled-loop continuation, race and reconciliation tests, actual
local/remote PTY journeys, native/Docker/Podman placement evidence, bounded real-provider trials and
the same short journey on the final installed artifact. Lower-level tests prove only their scope.
