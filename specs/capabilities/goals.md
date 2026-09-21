# Persistent conversation goals

## Ownership and authority

`@clarvis/goal` owns objective state, bounded schemas, user-control transitions, semantic formulation,
execution policy and criteria evaluation. It has a one-way dependency on `@clarvis/loop` for generic
run executor types and invocation; the loop does not name Goal behavior. It does not depend on the
kernel, plan or protocol packages. The host owns the authenticated conversation, durable session
transaction, physical run lifecycle, authority and evidence lookup. `GoalRepository` describes a
transaction over the existing session document; it is not another authoritative store.
`GoalRuntimePort` binds model operations to one host-selected entry agent and work run. Children
return their work to that entry rather than controlling the objective.

Production: the ports in [ports.ts](../../packages/goal/src/ports.ts), strict schemas in
[schemas.ts](../../packages/goal/src/schemas.ts), and user controls in
[control.ts](../../packages/goal/src/control.ts).
Test: `goal user controls` in [domain.test.ts](../../packages/goal/tests/unit/domain.test.ts) verifies
session isolation, physical exclusion, CAS and operation replay.

## Main-agent Goal creation

Guided `/goal <seed>` is an ordinary turn of the selected main agent. Authenticated admission
persists a `creation_intent` on the existing session `goal_state` with the original seed, execution
identity and `formulating` phase. That intent is not a Goal and does not authorize implementation.
The host appends a formulation instruction as a new stable context block after the operator's
literal message, then adds `create_goal` through `createGoalCreationCapability`. Catalog names,
schemas, descriptions and order stay fixed for the run. Until `create_goal` is durably committed,
the contribution's `dispatchPolicy` admits proven `read` tools, `create_goal`/`get_goal`/`update_goal`,
`ask_user` and `submit_result`, and refuses mutate, unknown/MCP, `spawn_run`, skill load and
work-executing delegation before workspace hooks run. Grouped create-then-write in one batch is
serialized by sequential dispatch: only a durable create flips the policy for later siblings.
After creation, handlers activate and the ordinary completion gate applies. The host assigns
identity, limits, origin, evidence scope and the first-stage execution binding.
`create_goal` is idempotent for its admitted execution and cannot be selected by an arbitrary model
argument. Literal `/goal -- <text>` remains a direct host control. Isolated backends receive the
same `goal_intent`; if the tool-effect port is absent the policy fail-closes unknown tools rather
than treating them as reads.
Production: `admitGoalCreationIntent` in [execution.ts](../../packages/goal/src/execution.ts),
`createFormulationDispatchPolicy` in [formulation-policy.ts](../../packages/goal/src/formulation-policy.ts),
`prepareHostedGoalCreationTurn` in [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts).
Test: `guided creation intent` in [domain.test.ts](../../packages/goal/tests/unit/domain.test.ts),
creation-stage dispatch in [capability.test.ts](../../packages/goal/tests/unit/capability.test.ts),
and `refuses workspace writes until create_goal is durably committed` in
[goal-file-host.test.ts](../../packages/kernel/tests/integration/goal-file-host.test.ts).

## Compatibility semantic formulation agent

The control-plane formulation service remains available to older clients but is no longer used by
the Code guided slash command. Its bounded formulation run is based on the conversation's selected main
agent profile. Auto mode treats the projected conversation trajectory as primary. Guided mode treats
its validated seed as the newest authoritative
request; trajectory and workspace reads may resolve references and retain already stated limits, but
cannot delete, replace or widen the seed. Literal mode never invokes this runtime. There is no
background observer, second Goal machine, draft queue or public job catalog.

The base prompt is byte-identical across auto and guided formulation. It contains both mode rules;
mode, seed, projected trajectory, digest, truncation and workspace availability appear only in the
volatile user input. The fixed prompt asks for an observable result rather than implementation steps, separates context,
quotations and meta commentary from operational authorization, preserves later corrections and
pivots, decomposes coherent compound requests into criteria, and exposes explicit constraints,
exclusions and necessary assumptions. It never infers permission, publication, spend, destruction or
external contact. Workspace and quoted content are untrusted data. When materially different readings
remain plausible, or a required artifact cannot be read completely, the only valid result is
`insufficient_context` with one short question and reason.
For a named artifact, the agent first reads the exact path from the request. It may follow only a
small number of directly referenced artifacts that are essential to formulate the observable result,
and stops reading once that result and its constraints are clear. Repository auditing, feasibility
research and broad exploration of architecture, source, tests or related documentation belong to the
execution agent rather than formulation. Production: `goalAgentPrompt` in
[prompt.ts](../../packages/goal/src/agent/prompt.ts). Test: the fixed prompt assertions in
[agent-run.test.ts](../../packages/goal/tests/unit/agent-run.test.ts).

The strict structured result is either ready or insufficient. Ready output contains objective,
qualitative/human criteria, constraints, exclusions, assumptions and normative source paths. Unknown
fields, empty strings, duplicate normalized semantics and bounds violations are rejected. The model
cannot supply host criteria, IDs, revisions, limits, digests, execution identities, provider settings
or authority. `formulationCriteria` normalizes descriptions and assigns ordered `criterion-NN` IDs.
Invalid output fails the operation without partial creation or fallback to the seed.
Human criteria apply only when an explicit human decision is indispensable to the currently
requested result. Permission boundaries for future or excluded work remain constraints/exclusions;
they do not create approval work or elicitation inside the current Goal.

The run retains the selected main agent's resolved model, base prompt and global/workspace
instructions, then appends the fixed formulation policy. The host replaces its tools, grants and
delegation surface: `shared_prompt: ""`, no MCP servers, no spawnable agents and only the
`read_workspace` grant. Its output schema contributes the
generic `submit_result`. The Kernel replaces, rather than extends, dependencies with the canonical
Tools capability, whose effective surface derives from `@clarvis/tools` `readOnlyTools`. Therefore
read file(s), image, directory, glob, grep, diff, file stat and tree operations may be available;
write/edit/shell/monitor and every Goal, Plan, Memory, Workflow, skill, hook, MCP or delegation
surface is absent and undispatchable. If Tools is disabled or the host ceiling forbids reads, the run
continues from seed/trajectory with `workspace_read_available: false` and receives no substitute.
For a normative source, the trace retains a host-minted SHA-256 attestation of the complete tool
result before its display copy is abbreviated. For `read_files`, the host reconstructs the complete
ordered batch, including its original headers, and compares that digest; abbreviated display text
alone cannot disprove a complete read. Literal truncation-notice text in a file is not a truncation
signal: exact content or digest matching determines completeness. Commit-time rereading must match that attestation;
an actual ranged/partial read, missing file or changed snapshot still fails closed. Production:
`verifyTraceNormativeSources` in
[trace-reads.ts](../../packages/kernel/src/goals/trace-reads.ts). Test: the complete-large and partial
source cases in
[goal-formulate-service.test.ts](../../packages/kernel/tests/integration/goal-formulate-service.test.ts),
plus batch/empty/line-ending/literal-marker acceptance and changed/missing/partial/forged/unlisted
rejection in [goal-trace-reads.test.ts](../../packages/kernel/tests/unit/goal-trace-reads.test.ts).

The default request takes the ordinary run's resolved token allowance as its formulation allowance
and stops at 120,000 ms or eight iterations. That allowance is one cumulative ledger shared by the
main formulation attempts and their definition reviews: before every invocation the host passes only
the measured remainder, so a revision cannot multiply the configured cap. Each provider call is
limited to 60,000 ms with at most one transport retry. Existing environment ceilings may only lower
these values. The non-contributable `goals.agent.formulation` settings block may override the
formulation token allowance while lowering the other limits. If measured usage becomes unknown, the
host fails closed before another ready/review attempt. The selected main-agent profile owns the
model. The run has host-minted execution and agent-instance IDs, its own persisted trace, no
conversation turn, and provider `callPurpose: "goal"`.

When work starts, the command reviewers receive the complete persisted definition as host-attested
Goal review context alongside, but separate from, the exact operator evidence that created it. The
context guides relevance and necessity; it cannot grant authority or manufacture acceptance of a
human criterion. Production: `goalReviewContext` in
[hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts) and the reviewer payloads in
[command-review.ts](../../packages/kernel/src/guard/command-review.ts) and
[effect-review.ts](../../packages/kernel/src/guard/effect-review.ts). Test:
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts),
[judge.test.ts](../../packages/kernel/tests/integration/judge.test.ts) and
[effect-review-service.test.ts](../../packages/kernel/tests/integration/effect-review-service.test.ts).

`projectGoalTrajectory` reconstructs every persisted `continue_from` ancestor reachable from
non-pending conversation turns, then orders sanitized user messages, final-answer assistant results,
terminal status, accepted steering and user elicitation answers by timestamp. It excludes system and
developer prompts, reasoning, tool arguments/results, opaque provider metadata, pending turns and the
slash command. Guided seed travels once in its own field. Simultaneous entry/byte bounds retain recent
corrections first and encode omitted counts plus partial-chain state. The host hashes the exact
canonical projection sent and derives ordered source execution IDs; absent or partial continuation
records set truncation rather than masquerading as a complete conversation.

Production: [request.ts](../../packages/goal/src/agent/request.ts),
[prompt.ts](../../packages/goal/src/agent/prompt.ts), [run.ts](../../packages/goal/src/agent/run.ts),
[settings.ts](../../packages/goal/src/settings.ts), and
[agent-runtime.ts](../../packages/kernel/src/goals/agent-runtime.ts).
Test: [agent-run.test.ts](../../packages/goal/tests/unit/agent-run.test.ts) and the announced-surface
assertion in
[goal-formulate-service.test.ts](../../packages/kernel/tests/integration/goal-formulate-service.test.ts).
Production: `projectGoalTrajectory` in
[trajectory.ts](../../packages/kernel/src/goals/trajectory.ts).
Test: [goal-trajectory.test.ts](../../packages/kernel/tests/unit/goal-trajectory.test.ts) covers
continuation recovery, ordering, correction priority, sanitization, exclusion and stable digest.

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

The Code goal parser recognizes only explicit control verbs. `/goal <seed>` submits an ordinary turn
to the selected main agent, which creates the Goal with `create_goal` and continues the same run;
`/goal -- <text>` creates literal text without a model call, so `/goal -- auto` is valid.
The automatic formulation mode remains available to the host service but is not exposed as a slash
command. Control verbs remain reserved only in their exact documented forms. A malformed reserved
control is refused rather than reinterpreted as a seed. The
presentation controller subscribes before its initial state read, coalesces
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

`registerGoalCommands` exposes `/goal`, main-agent guided creation, literal objective creation and the
edit/pause/resume/cancel/clear controls through the normal Code registry. Guided creation uses the
ordinary selected conversation, does not open a pre-creation form, and does not silently replace a
current Goal. Created reveals the compact
Goal sidebar section without navigating away from the transcript; insufficient, stale and failed
outcomes show one question/message without automatic retry. The controller exposes the in-flight
formulation state and the host projects its live trace into bounded `thinking`, `reading` and
`searching` activity plus the current iteration when known. Because local reads may complete between
painted frames, a subsequent thinking state retains the last workspace activity and the sidebar
renders that completed action above its current thinking line. The Lead activity line and sidebar
thus distinguish concrete formulation work from an idle or stalled TUI without exposing model text, tool
arguments or paths. This activity is non-authoritative and never persisted in Goal state. Production:
`createGoalService` in [service.ts](../../packages/kernel/src/goals/service.ts),
`createGoalController` in [controller.ts](../../packages/code/src/features/goal/controller.ts), and
`Sidebar` in [Sidebar.tsx](../../packages/code/src/views/Sidebar.tsx). Test:
[goal-formulate-service.test.ts](../../packages/kernel/tests/integration/goal-formulate-service.test.ts),
[goal-controller.test.ts](../../packages/code/tests/unit/goal-controller.test.ts), and
[sidebar-render.test.tsx](../../packages/code/tests/integration/sidebar-render.test.tsx).
The sidebar follows the Plan pattern: objective/title emphasis, lifecycle tone, status metadata and
the navigation key occupy the same visual roles, including the lowercase `full goal` label.
Host-created start and resume transcript previews show `Work toward the persistent goal:` followed
by the complete current objective, without changing the synthetic model message. Production:
`createGoalService` in [service.ts](../../packages/kernel/src/goals/service.ts). Test:
[goal-file-host.test.ts](../../packages/kernel/tests/integration/goal-file-host.test.ts) checks
the persisted preview through the real file host. The sidebar owns the bounded summary, and `Ctrl+X O` opens the
existing complete Goal view while that section is revealed. Literal creation and successful control also
remain in the transcript rather than forcing the view open.
Unsupported hosts refuse controls explicitly. The deterministic form stages objective, bounded
criteria, constraints, exclusions, assumptions and finite limits in one reviewed mutation;
replacement retains the previous goal and requires confirmation. Editing a terminal goal also uses
replacement. Physical work, including unknown work without a live hosted reference, blocks editing.
The view distinguishes durable status, current physical execution, origin and every semantic array.
The full view limits its reading column to 100 cells and separates the objective, lifecycle,
Steward review and usage with blank lines. Completed goals omit the internal completion reason;
actionable review guidance is labelled `Next step`.
It shows normative paths with a shortened SHA-256 display and only actionable negative or
inconclusive review assessments; raw execution IDs, full digests, detailed accounting, completion
candidate prose and satisfied review narration stay out of the primary presentation. A semantic edit
announces that it converts the whole definition to literal and clears source bindings; limit-only
edits preserve them. A paused goal may still have a running physical stage.

A recovering Goal is visible as recovering. The settlement leaves the goal active with a reason that
names the closing stage's ending, and the full view renders that reason for every non-complete goal,
so the operator sees why the stage stopped while the Kernel continues it. The successor's transcript
turn carries a host-authored preview naming the same ending, while the original run's outcome and
cause stay consultable in its history. Nothing paints the continuation as a completion, and no
recovery text is presented as an operator decision.
Production: `GoalView` in [view.tsx](../../packages/code/src/features/goal/view.tsx) and the
continuation preview in [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts).
Test: `goal view shows a recovered stage and a resuming goal without claiming completion` in
[goal-commands.test.tsx](../../packages/code/tests/integration/goal-commands.test.tsx) and
`starts a successor when the guided creation stage itself checkpointed` in
[goal-file-host.test.ts](../../packages/kernel/tests/integration/goal-file-host.test.ts).
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
[sidebar-render.test.tsx](../../packages/code/tests/integration/sidebar-render.test.tsx) and
[app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx) cover
the compact Goal projection and `Ctrl+X O` navigation;
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

The current record keeps `constraints`, `exclusions`, `assumptions`, normative `sources` and `origin`
beside the existing objective and criteria. Each semantic array and the sources array contains at
most 16 items; text and confined paths are at most 4,096 characters and every source digest is a
lowercase SHA-256. Guided origin retains the normalized seed up to 16,384 characters. Auto/guided
origin also records the formulation execution, captured full-session revision, host-derived source
execution IDs, digest and truncation state of the exact canonical trajectory, and optional measured
formulation usage. Pre-release records without these fields decode with empty arrays and literal
origin and are canonically rewritten by the next host publication; no parallel version or migrator
exists.

A source is normative only when it defines the requested result, was read completely and
successfully in the legacy semantic formulation run, and was reread through the confined workspace service before
commit. The model supplies only a path; the host computes its digest. A missing, partial, invented or
changed read fails closed. Later drift does not redefine the Goal: the view reports attention and
completion remains blocked until a semantic edit, or cancel/clear followed by formulation. Files the
Goal authorizes changing are execution evidence, not normative sources.
An explicit `read_file` range counts as complete only when its observed rendering equals that entire
confined reread and has no continuation marker. Thus line one with an ample limit is valid, while an
actually partial range remains invalid.

`revision` is the CAS revision of state; `objective_revision` changes with any objective, criteria,
constraint, exclusion or assumption edit; `control_revision` fences pending admission and late
completion. Human acceptance updates its
record and CAS revision without revoking the running commitment. Edits retain all consumption and
continuation counts. Semantic edits invalidate candidates and human acceptance, clear normative
sources and convert the complete definition to literal because the edit is a new explicit user
declaration. Limit-only edits retain provenance and do not manufacture new evidence. Terminal goals
cannot silently reopen.

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

Formulation requests carry session ID, expected Goal-state revision, operation ID and the strict
auto/guided discriminator. Auto forbids a seed; guided requires a nonempty normalized seed. The
fingerprint includes mode and guided seed. Every terminal analysis outcome receives a receipt in the
same ring, including insufficient, stale and provider/schema failure. An identical concurrent
operation shares its process promise; replay after settlement reads the durable receipt. Reusing an
operation ID for a different mode or seed conflicts.

Before inference the service checks operator authority, expected Goal revision, absence of any
current Goal and absence of physical conversation work. It captures the complete Session revision,
trajectory, configuration and host-owned IDs, then releases all session transactions during the
semantic run. Auto with no eligible user message records a deterministic question without a model
call. Ready output and normative sources are validated before a short transaction compares the full
captured Session revision. A change records only `stale_context`; insufficient and failure record
only their receipts. Ready calls `applyGoalFormulation`, persists Goal/receipt and reserves the work
execution before using the same start/compensation routine as literal creation.

Measured formulation usage is added once to Session totals in the receipt transaction and copied to
origin for audit when a Goal is created. It never charges `GoalRecord.consumption`, whose budget starts
with the admitted work run. The semantic execution is not a conversation turn and work settlement
cannot count it again.

Production: `GoalFormulateRequest` and `GoalFormulateResult` in
[protocol goals.ts](../../packages/protocol/src/goals.ts), `applyGoalFormulation` and
`recordGoalFormulationReceipt` in [control.ts](../../packages/goal/src/control.ts), and
`createGoalService` in [service.ts](../../packages/kernel/src/goals/service.ts).

### Goal Steward

The admitted entry run has one host coordinator and at most one finite tool-free Steward completion
evaluation in flight. This is automatic only inside an admitted Goal run; automatic formulation
remains an explicit host-service operation and ordinary messages never create a Goal. The Steward
is invoked only after a
terminal candidate passes the deterministic candidate, evidence, human and Plan gates. It does not
continuously observe intermediate responses, run in the background or inject corrections at
iteration boundaries. Accepted operator steering invalidates an in-flight or reusable completion
decision through the existing semantic fences. Review-limit exhaustion requires explicit operator
action.

The fixed output schema accepts definition or completion assessments. Formulation and Steward
output schemas declare an explicit `type: "object"` root with exclusive `oneOf` variants,
without model-specific rewriting or relaxing local validation.
Production: `goalFormulationOutputSchema` in [request.ts](../../packages/goal/src/agent/request.ts)
and `goalStewardOutputSchema` in [steward-request.ts](../../packages/goal/src/agent/steward-request.ts).
Test: [agent-run.test.ts](../../packages/goal/tests/unit/agent-run.test.ts) and
[steward.test.ts](../../packages/goal/tests/unit/steward.test.ts).

Before activation, definition
review compares the proposed definition with the operator
request and verified bounded normative-source snapshots. `revise_definition` returns one specific
correction to the selected main agent; `accept_definition` permits activation. At most three
formulation/review attempts occur. Completion must cover the definition, objective and exactly the
qualitative criterion IDs supplied by the host.
Qualitative criterion IDs must match the host-supplied set. Evidence IDs on Steward assessments are
optional and are not validated against a tool-result catalog. The private frame is a conversational
projection: persisted Goal contract, original operator request, later operator corrections, the
work agent's explanatory completion report, optional proposed final text when it is not a duplicate,
and any pending Steward question with the work agent's answer. It does not carry `evidence_manifest`,
`evidence_details`, `command_evidence`, `delegation_evidence`, `workflow_history`, plan dumps,
raw tool results, files, `AGENTS.md` or `CLARVIS.md`. The Steward evaluates evidence declared by
the work agent; it is not an independent artifact audit. An achieved result requires all assessments
satisfied on that report; `needs_work` returns an actionable correction to the same work run;
`needs_evidence` asks one specific question, which the host persists and returns to the main run
through the existing finalize-gate nudge so the work agent can verify or correct with its normal
tools. Human-acceptance criteria still require actual human acceptance. Malformed, failed,
unknown-usage or stale evaluations cannot complete the Goal. Technical interruption is persisted as
`interrupted` with a typed cause (`timeout`, `transport`, `invalid_output`, `cancelled`,
`usage_unknown`) and is not `needs_work` or a still-pending review. `usage_unknown` is its own
cause, not a transport fault: the evaluation did answer — possibly with a valid `achieved` — but
its consumption could not be determined, and the Goal cannot be concluded on a review the host
cannot charge. Final failures retain the domain codes
`goal_steward_failed` or `goal_steward_inconclusive`. Cancellation during result validation remains
cancellation.

Both entry capabilities — the guided creation turn (`createGoalCreationRunCapability`) and the
bound work run (`createGoalCapability`) — end the Goal through one mapping,
`stewardInterruptionOutcome` (`packages/goal/src/agent/steward-types.ts`), which pairs the domain
code with fixed operator-facing text for the cause. The guided creation turn is the one the original
defect surfaced in, and it reported no cause at all until the two shared the mapping. Production:
`stewardInterruptionOutcome` in `packages/goal/src/agent/steward-types.ts`. Test:
`routes Steward completion decisions and respects pending operator steering` and
`covers creation review feedback, invalid candidates and bounded failures` in
`packages/goal/tests/unit/capability.test.ts`.

The coordinator checks Goal/control/objective identity, cumulative operator trajectory, operator
epoch, candidate and final attempt before effects. Plan context is bound for the host but is not
sent in the Steward frame and does not fence a completion decision. The host's private result gate
checks the qualitative targets before accepting `submit_result`. Its first invalid result
appends one corrective nudge within that evaluation's existing token, time and iteration limits;
a repeated invalid result fails closed. The persisted result is revalidated before settlement, so
this recovery never bypasses the durable candidate fences. Missing operator request or an
irreducible oversize frame fails closed rather than silently truncating criteria. Normative-source
drift remains a deterministic host failure before semantic completion review.

Each evaluation is an ordinary isolated execution containing only `submit_result`: no workspace
tools, Goal, Plan, Guard, Memory, MCP, skills, hooks or spawn capability. It has a fresh
execution ID and a stable conversation-scoped `goal-steward` agent instance. Compatible evaluations
continue the persisted private context with `continue_from`; work messages are delimited observed
data, never Steward assistant history. Fixed policy, schema, TTL and model identity precede
append-only semantic frames. Runtime/configuration or definition incompatibility starts a new base;
operator corrections and later reports append frames. Checkpoint continuation preserves the
chain. Completion, cancellation, clearing and substantive edits retire its predecessor.

The Steward does not receive `AGENTS.md`, `CLARVIS.md`, the selected main-agent prompt, plan dumps
or another filesystem view. Those instructions remain with the main agent that formulates and
executes the Goal. Each Steward frame is a host-projected conversational package from
`buildStewardConversationFrame`. Oversize reports are returned to the work agent for condensation
rather than silently truncating operator criteria. Repository text is untrusted data, never policy
or authority.

Production: `prepareHostedGoalTurn` in [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts),
`createStewardExecutionRuntime` in [steward-runtime.ts](../../packages/kernel/src/goals/steward-runtime.ts),
and `buildGoalStewardRequest` in [steward-request.ts](../../packages/goal/src/agent/steward-request.ts).
Test: `reviews completion without receiving repository instructions`, `returns unfinished work to
the same run and preserves the private serialized prefix`, and `completion review receives
authenticated checkpoint history without repository instructions` in
[goal-steward-runtime.test.ts](../../packages/kernel/tests/integration/goal-steward-runtime.test.ts).

`GoalRecord.steward` persists the predecessor, pending reservation, consumed sequence/digest,
operator epoch, runtime fingerprint, status and separate measured usage. Each GoalRun retains at
most eight reviews and a bounded evaluation counter. Admission compares the predecessor and consumed
sequence in a short transaction; inference never holds that transaction. Settlement clears the pending
reservation and charges Session totals exactly once, including discarded decisions. An orphaned
reservation is reconciled from persisted run usage or marked unknown before restarting tool-free
analysis on a new base. Shutdown aborts and awaits the retained evaluation through the finite executor;
it does not launch further work. No daemon, polling loop, queue or generic engine knowledge of Goal
is introduced.

`goals.agent.steward.model` overrides the normal default model. Its optional
`max_net_tokens` otherwise inherits the effective admitted work cap without reserving or reducing it.
Per-call timeout and retries follow the common provider policy (`call_timeout_ms` and `max_retries`);
there is no extra 120-second coordinator wall around a still-valid attempt. An optional
`goals.agent.steward.timeout_ms` may lower the run allowance subject to the host ceiling. Review
and completion-attempt defaults are eight and one; their setting maxima are 32 and two. Steward
usage never enters Goal work consumption. The TUI presents `needs_evidence` as a Steward
clarification that the main agent is answering, not as an operator action.

A technical interruption ends the stage, and what follows depends on whether the host can charge the
review. A review that timed out, failed in transit or returned unusable output was measured: the
Closed stage records `steward_interrupted`, and one bounded successor stage may re-establish the
result and be reviewed again, so a failed evaluation does not by itself make the Goal the operator's
responsibility. A review whose consumption could not be determined is the opposite case — the
evaluation answered, possibly with a valid `achieved`, but the Goal cannot continue on a review the
host cannot account for, so the stage records `usage_unknown` and never admits a successor. Both
outcomes keep the Goal distinct from a completion: the interrupted review is persisted with its typed
cause, and no recovery dispenses with the validation and evaluation the contract requires.
Production: `stewardInterruptionOutcome` in [steward-types.ts](../../packages/goal/src/agent/steward-types.ts)
and the `unaccountable` override in [execution.ts](../../packages/goal/src/execution.ts).
Test: `fails closed on unknown auxiliary usage and retains it outside the work allowance` in
[goal-steward.test.ts](../../packages/kernel/tests/unit/goal-steward.test.ts), and
`blocks completion when the provider never reports the review's consumption` with
`gives the review exactly one correction before the Goal is left unresolved` in
[goal-steward-runtime.test.ts](../../packages/kernel/tests/integration/goal-steward-runtime.test.ts).

Production: `createGoalStewardCoordinator` in
[steward-coordinator.ts](../../packages/kernel/src/goals/steward-coordinator.ts),
`createStewardResultGate` in [steward-result-gate.ts](../../packages/kernel/src/goals/steward-result-gate.ts),
`buildStewardConversationFrame` in [steward-projection.ts](../../packages/kernel/src/goals/steward-projection.ts),
`GOAL_STEWARD_PROMPT` in [steward-prompt.ts](../../packages/goal/src/agent/steward-prompt.ts),
`createStewardExecutionRuntime` in [steward-runtime.ts](../../packages/kernel/src/goals/steward-runtime.ts),
`settleStewardEvaluation` in [steward-state.ts](../../packages/goal/src/steward-state.ts), and
`createGoalCapability` in [capability.ts](../../packages/goal/src/capability.ts).
Test: `Goal Steward coordinator` in
[goal-steward.test.ts](../../packages/kernel/tests/unit/goal-steward.test.ts), schema/request contracts in
[steward.test.ts](../../packages/goal/tests/unit/steward.test.ts), conversational projection in
[goal-steward-projection.test.ts](../../packages/kernel/tests/unit/goal-steward-projection.test.ts),
and the native SDK journeys (including historical-read rejection, bounded in-run correction and repeated-invalid failure) in
[goal-steward-runtime.test.ts](../../packages/kernel/tests/integration/goal-steward-runtime.test.ts).

### Completion validation

Every non-checkpoint final attempt passes the existing deterministic candidate, human and host
evidence validation. Normative source digests are revalidated by the host immediately before the
completion commit; changed or missing bytes keep the Goal incomplete and require edit or
reformulation. The independent Goal Steward reviews the proposed final result after those
prerequisites pass, using its own finite allowance. An achieved review is necessary but never
sufficient for completion. `settleGoalRun` remains the sole writer of `status: complete` after physical closure.

Production: `validateCompletion` in
[runtime-port.ts](../../packages/kernel/src/goals/runtime-port.ts), the source check in
[hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts), and the gate in
[capability.ts](../../packages/goal/src/capability.ts). Test:
[goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts) and
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts).
[goal-formulate-service.test.ts](../../packages/kernel/tests/integration/goal-formulate-service.test.ts)
separately covers the real file host, IPC, provider adapter, read-only tools, source digest,
separate trace, single work admission, empty auto, receipt replay, Session CAS and source drift.

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

`declareGoalImpediment` records a running stage's declared blocker without revoking the Goal's own
authority: the status, the control revision and the stage's physical phase are unchanged, the
declaration is durable on the stage, and a repeated declaration is idempotent. The settlement then
blocks the Goal with the declared reason, so the operator still acts on the impediment the model
reported — but with the same limits, approvals, spend and continuation allowance a resume would have
had. The host never admits an automatic successor for a declaration it cannot separate from a refusal
the operator just made: a refused plan review reaches settlement through the model's own blocker, and
continuing it automatically would retry work an authenticated decision had refused. A newer pause,
cancel or terminal state keeps precedence; a foreign binding or obsolete objective still fails.
Production: `declareGoalImpediment` in [execution.ts](../../packages/goal/src/execution.ts).
Test: `records a declared impediment without revoking the Goal's own authority` and `blocks on a
declared impediment once without spending the Goal's own authority` in
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

The closed stage records one decision from a closed vocabulary — `complete`, `continue`, `attention`
or `closed` — beside the cause the host classified and whether the stage advanced the work. `continue`
is what lets the Kernel keep responsibility for a pending Goal without a model-generated checkpoint:
the host admits the successor from that durable record rather than from the run's physical shape. A
recoverable ending keeps the Goal `active` and spends one stage of the progress allowance when the
stage did not advance the work; the ordinary admission path then blocks the Goal when that allowance
is exhausted, instead of the stage looping or the Goal becoming the operator's responsibility for a
single failure. `closed` covers a control or a durable limit that ended the automatic path, and
`attention` covers an ending the host could not class as recoverable at all.

Production: settlement, phase, candidate, checkpoint, policy-pause and settlement functions in
[execution.ts](../../packages/goal/src/execution.ts), and `goalStageOutcome` in
[settlement.ts](../../packages/kernel/src/goals/settlement.ts).
Test: `goal physical settlement, usage and continuation` and `keeps the Goal active and continues
after a recoverable ending` in [domain.test.ts](../../packages/goal/tests/unit/domain.test.ts), the
classification table in
[goal-settlement.test.ts](../../packages/kernel/tests/unit/goal-settlement.test.ts), and
`continues a stalled stage in a successor and stops at the stage progress limit` in
[goal-file-host.test.ts](../../packages/kernel/tests/integration/goal-file-host.test.ts).

## Limits and progress

The strict `goals` configuration block is owned by the lightweight `@clarvis/goal/settings` entry
and registered by the kernel before settings parsing. It uses whole-block last-scope precedence:
a workspace block replaces the global block, including omission of its optional token cap or
deadline. Plugins cannot contribute this block, and it adds no model-callable run parameter.

`agent.formulation` may override `max_net_tokens` and lower `timeout_ms`, `max_iterations`,
`call_timeout_ms` and `max_retries` from the resolved-run-budget/120,000/eight/60,000/one defaults. The
ordinary execution ceilings still apply. Plugins, Code requests and model output cannot contribute
or override these host values.

Creation and replacement resolve limits in this order: explicit user control, effective `goals`
configuration, then domain defaults. An omitted `max_net_tokens` inherits the finite entry run
budget once; it is never multiplied by a continuation count. `max_auto_continuations` defaults to
8 (range 0–255), `max_no_progress_stages` to 3 (range 1–32). The token cap is a positive safe
integer below `Number.MAX_SAFE_INTEGER`. Optional `deadline_at` is an absolute Unix timestamp in
milliseconds within that safe counter range; it is independent of run idle timeout. These defaults
are policy values, not measured reliability claims.

The stage allowance counts closed stages that advanced nothing: an accepted checkpoint whose
activity was not new, and every recoverable ending a successor re-evaluates. A stage that advanced
the work clears the sequence, and the allowance is compared with the goal's whole recorded history
rather than the previous stage, so repeating an earlier stage's checks — in another order or with
different wording — cannot reset it. `max_auto_continuations` remains an independent global ceiling
on automatic stages.

The settings field was renamed from `max_no_progress_checkpoints` when the counter became stage rather
than checkpoint based. A document that still carries the old spelling is admitted by the settings
schema and normalized in memory by `resolveGoalsSettings`, so the nearest scope is never discarded
whole over the rename and the operator's value is honored; nothing is rewritten on a read.
Production: `goalLimitsSchema` in [schemas.ts](../../packages/goal/src/schemas.ts) and
`resolveGoalsSettings` in [settings.ts](../../packages/goal/src/settings.ts).
Test: `accepts the renamed stage limit and normalizes it in memory` in
[settings.test.ts](../../packages/goal/tests/unit/settings.test.ts) and
`admits bounded goal defaults only through the kernel settings registry` in
[capability-settings-schema.test.ts](../../packages/kernel/tests/integration/capability-settings-schema.test.ts).

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

An unsuccessful stage also carries the host's typed failure cause, from a closed vocabulary the
domain owns, so a blocked goal's reason tells the operator which action it needs instead of repeating
a generic failed-stage sentence. `stagnation` is the whole family the engine reports for a stage that
kept going without advancing — the loop's unproductive-attempt streak, the doom-loop guard on a
repeatedly failing call and the convergence guard on identical repeated results — because naming only
one member would leave the others reporting a generic failure for the condition the operator has to
act on. `local_limit`, `empty_response`, `transient`, `steward_interrupted` and a progressing
`context_overflow` are the endings one bounded successor may re-evaluate; `declined`, `cancelled`,
`provider_refused`, `tools_unavailable`, `control_failure`, `impediment`, `usage_unknown` and
`unclassified` are never presumed recoverable. A structural failure such as an empty completion, and
a run whose tools all disappeared, keep the generic wording where no cause applies. The vocabulary is
host-owned: the failed run's own message never becomes the reason, and the host preserves only the
provider's own classification and requested backoff from the engine's error payload — `provider_error`
alone cannot tell a retryable fault from a credential, quota or content refusal.
Production: `GoalRunCause`, `GoalStageDecision` and `settleGoalRun` in [execution.ts](../../packages/goal/src/execution.ts),
and `goalStageOutcome` with its `STAGNATION_CODES` and `REFUSAL_CODES` sets in
[settlement.ts](../../packages/kernel/src/goals/settlement.ts).
Test: `names the host's typed failure cause instead of a generic stage failure`,
`never presumes an unclassified or refused ending recoverable` and `closes the automatic path on an
operator refusal or a durable control` in [domain.test.ts](../../packages/goal/tests/unit/domain.test.ts),
the classification table in [goal-settlement.test.ts](../../packages/kernel/tests/unit/goal-settlement.test.ts),
and `never repeats a credential, quota or content refusal on its own` with `resumes a transient
provider fault once its backoff has been recorded` there.

Admission requires remaining tokens, deadline and continuation allowance, physical closure and known
usage. Resume preserves spend and used continuations; it cannot grant budget or bypass expired
limits. User intervention may restart a recorded stagnation evaluation. Repeated host activity
fingerprints cannot reset stagnation even if checkpoint wording changes: settlement compares the
stage's own observed activity digest with the Goal's whole recorded history, and a stage whose set was
already seen does not count as progress however its summary reads. The host decides relevance from
observed activity and never requires the model to cite an identifier for it; fresh activity alone
still does not prove useful semantic progress. The independent run bound remains in force. An invalid
final or missing checkpoint blocks immediately.

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
write as the terminal turn, and stamps the stage's closed decision in that same transaction. A
repeated callback does not charge again. Late measured usage can
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
no generic proof engine. The separate Goal Steward assesses semantic sufficiency without replacing
these deterministic prerequisites. The host revalidates before completion commit.

Production: criterion/evidence schemas in [schemas.ts](../../packages/goal/src/schemas.ts) and
`validateGoalCandidate` in [criteria.ts](../../packages/goal/src/criteria.ts).
Test: `goal criteria and completion` in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts) covers qualitative labeling, explicit
host checks, human acceptance, foreign references, stale/digest failures and exact coverage.

The kernel's `createGoalEvidenceSource` indexes completed host-observed tool envelopes and successful
`delegation_completed` events, including bound child events, without retaining a second transcript. It keeps at most 512 observations with
1 MiB payload limits and returns at most 32 catalog options. Native successful command observations
also retain sanitized excerpts for the private Steward frame: at most 2,048 characters of arguments,
3,072 of stdout and 1,024 of stderr, with an explicit truncation flag. Completed delegation results
retain at most 4,096 sanitized characters with the same explicit truncation semantics. The producer
captures a typed pre-cap receipt before the ordinary 5,000-character trace display limit, so command
classification does not parse an abbreviated JSON result. The coordinator resolves candidate-cited
references from the complete eligible set, prioritizes them over auxiliary catalog entries and bounds
delivery to 64 references and 160 KiB of reference/detail material. `evidence_manifest` explicitly
marks delivered, frame-budget and unavailable references. Details are projected only for delivered
IDs, never copied into Goal evidence references or protocol catalog fields. Each option has an opaque ID, stamped
scope, digest and short host-authored description; the description is omitted from persisted evidence.
That description names the operation rather than the call: the command a shell ran, the path a read or
write touched, the pattern a search used — sanitized, single-line and bounded — because the previous
`<tool>; call <call id>` form told the model nothing it could act on and forced manual correlation with
the work. It is presentation only: the opaque ID, its stamped scope and its digest remain the
authority, and an exit-zero command gains no strength from being described.
Oversized or conflicting live observations fail closed. Prior stages are read through the existing
owner-scoped trace reader, restricted to this objective revision. Evicted or unavailable references
cannot establish success. Duplicate persisted events do not move an old result past a newer failure;
conflicting duplicates refuse the snapshot.
Production: `goalEvidenceLabel` in [evidence.ts](../../packages/kernel/src/goals/evidence.ts).
Test: `describes a catalog option by its operation instead of an opaque call id` in
[goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts).

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
and `uses a pre-cap command receipt when the persisted display result is truncated` in
[goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts) check
real mapper output, pre-cap terminal classification, successful/failed commands, control exclusion and
qualified MCP names; `projects completed delegation receipts from current and prior Goal stages`
covers delegation receipts.

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

The same criteria are evaluated by the host at settlement, over the observations the bound execution
itself produced rather than the identifiers the model chose to cite: `stageActivity` digests that
stage's own activity set, and the settlement compares it with every fingerprint the Goal already
recorded. A reference recovered from an earlier stage may still support completion, but it is never
counted again as this stage's progress — which is what distinguishes evidence still being available
from progress newly accepted. When the host cannot take that observation at all, the stage is counted
as unproductive rather than blocking: absence of evidence is not proof that no work happened, and it
only spends the bounded stage allowance.
Production: `stageActivity` in [evidence.ts](../../packages/kernel/src/goals/evidence.ts) and
`createGoalStageSettlement` in [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts).
Test: `reports only the bound stage's own activity, never what it merely cited` and
`reuses prior trace evidence but rejects repeated checks as new progress across stages` in
[goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts), and
`does not count changing prose around the same activity as fresh progress` in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts).
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

A rejected argument is not one of those failures. Each model operation answers with a discriminated
outcome: an evidence identifier that is absent, duplicated, obsolete or unsuccessful for this
objective is resolved before any durable write and answered as corrigible input, so the model reads
the catalog again and re-sends while the previous candidate, revision and consumption stay exactly as
they were. The sentence never reveals whether an identifier belongs to another owner. Everything the
host cannot present as a rejected argument — a lost binding, an unreadable control, a storage fault,
a state conflict — still throws and still ends the stage with host attention, because an operation the
host could not confirm must never look like one the model may simply retry.
Production: `GoalOperationOutcome` in [ports.ts](../../packages/goal/src/ports.ts), `resolveEvidence`
in [runtime-port.ts](../../packages/kernel/src/goals/runtime-port.ts), and the handler branches in
[capability.ts](../../packages/goal/src/capability.ts) and
[creation-capability.ts](../../packages/goal/src/creation-capability.ts).
Test: `refuses an unusable evidence set as corrigible input without writing anything` in
[goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts), and
`answers a refused evidence set as a corrigible tool error without ending the stage` with
`answers a refused evidence set in the creation turn without ending the stage` in
[capability.test.ts](../../packages/goal/tests/unit/capability.test.ts).
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
again. An explicit `blocked` action uses interruption without requiring open tasks to be closed.
Storage or binding failure produces `goal_control_failed` and host attention without reflecting
private exception details in the model response.

Premature finalization has one recovery policy shared by both entry capabilities, expressed as one
ruling over the host's verdict (`ruleGoalFinalization`). A final attempt whose deterministic
completion validation rejects the candidate on its merits is answered with the same orientation and
an `unbounded` nudge, and the gate keeps no lifetime allowance of its own — so a refusal is not spent
by a stage that keeps working afterwards. The orientation states that the Goal cannot conclude yet
and leaves continuing the work, reading the criteria and requesting a checkpoint equally valid: the
model is never required to fabricate a candidate before it may work. It never names the Goal Steward,
which this path is reachable without invoking. The typed cause distinguishes a stage with no
candidate at all from one whose recorded candidate does not satisfy the current criteria, and the
guided creation turn names its own cause while the Goal is not yet created. Only recoverable verdicts
are answered this way: a failed read, foreign binding or obsolete revision stays terminal
`goal_control_failed`, and an empty final remains a structural terminal.

The failed-validation vocabulary has a third member that is not a deficiency at all. `state_conflict`
reports that the goal or its observation generation moved while the check ran, so the verdict says
nothing about the candidate; answering it with a candidate-deficiency orientation would consume the
run's allowance for a condition the model cannot act on and would then report stagnation for a stage
that never stagnated. Such a verdict is re-read once instead, because accepting a human criterion is
exactly what makes that candidate completable, so a non-revoking human acceptance landing inside the
validation window must still be able to settle the attempt — the same reason the host revalidates
before the durable commit. Only a conflict that survives the re-read stops the stage, and it stops
with `goal_control_failed` and host attention rather than with orientation. For the same reason the
kernel never folds a conflict into the no-candidate verdict: the port's own fence sets the cause.

The bound is the run's own unproductive-attempt sequence, so a productive iteration clears it and a
genuinely stuck stage ends the run with `no_progress` instead of the Goal being marked blocked by the
gate. A recovery answers with a nudge and nothing else: it starts no run, creates no stage, consumes
no automatic continuation and synthesizes no checkpoint. Each answer records a bounded
`goal_finalization_recovery` trace entry carrying the execution identity, agent, attempt mode, typed
cause and the host's own verdicts — never the model's text, the objective or reasoning. A conflict
records nothing as a recovery, because it is not one.
Production: `ruleGoalFinalization`, `recoverGoalFinalization`, `goalRecoveryNote` and
`GOAL_RECOVERY_TRACE_KIND` in
[finalization-recovery.ts](../../packages/goal/src/finalization-recovery.ts), the `cause` on
`GoalCompletionValidation` in [criteria.ts](../../packages/goal/src/criteria.ts) and its
`state_conflict` producer in [runtime-port.ts](../../packages/kernel/src/goals/runtime-port.ts), used
by `createGoalCapability` in [capability.ts](../../packages/goal/src/capability.ts) and
`createGoalCreationRunCapability` in [creation-capability.ts](../../packages/goal/src/creation-capability.ts);
`GateOutcome` in [loop-contract.ts](../../packages/capability/src/loop-contract.ts) and the text-path
nudge branch in [run-agent.ts](../../packages/loop/src/runtime/loop/run-agent.ts) own the count and the
`no_progress` termination. Test: `keeps recovering from a premature final without a lifetime nudge
allowance`, `records a typed recovery cause without copying model text or the objective`, `names a
missing candidate as its own recoverable cause`, `re-reads a state conflict once and lets a settled
state decide the attempt`, `never recovers a state conflict that survives the re-read`, `recovers
on the refreshed verdict when the conflict clears into a real deficiency` and `stops the creation
turn on a state conflict instead of orienting it` in
[capability.test.ts](../../packages/goal/tests/unit/capability.test.ts); `reports a state conflict,
not a candidate deficiency, when the goal moves during validation` in
[goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts);
`records the unproductive streak and its limit on a no-progress termination`, `counts a refused
submit once, so the submit path is bounded like the text path` and `clears the unproductive sequence
on a productive iteration instead of condemning a later refusal` in
[lifecycle-finalize-wiring.test.ts](../../packages/loop/tests/component/lifecycle-finalize-wiring.test.ts).

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

After the full registry barrier, its continuation policy re-reads the canonical session and rules from
the durable decision the settlement recorded on that closed stage: the same active Goal, control and
objective revision, that stage as the latest one, `decision: "continue"`, and remaining admission.
It returns one fresh execution identity and a host-authored orientation keyed by the stage's cause,
never the failed run's prose or a new authorization. The conversation and entry-agent identity remain
unchanged, and the successor's request keeps the predecessor's resolved identity without replaying the
creation intent. The registry's host-only continuation provenance distinguishes this from a human
stage. The registry no longer rules on the predecessor's physical shape, so a stage that ended with a
recoverable failure continues exactly as a checkpoint handoff does; a run without a continuation
policy stays inert. A provider-requested backoff travels as a typed minimum instant with the proposal,
is waited for abortably outside the short preparation deadline, and the policy is asked again before
anyone starts, so a stale proposal cannot create a successor. A superseding human reservation discards
the old proposal. Retirement pauses and host failure blocks only the matching stage or still-pending
preparation; `stopGoalContinuation` preserves newer controls, replacement and successor admission
without releasing physical work.

The guided creation turn runs the same settlement and the same continuation policy as every later
stage; it simply returns nothing until its Goal exists durably, so a stage that never created one
cannot invent a successor. That turn is also what claims the conversation control for the operator
connection that started it, exactly as an explicit goal control does for a literal Goal: every Goal
stage requires a live conversation controller, so without that claim a first-stage checkpoint could
never start its successor.

Production: [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts),
`stopGoalContinuation` in [execution.ts](../../packages/goal/src/execution.ts), and the continuation
admission in [registry.ts](../../packages/kernel/src/hosting/registry.ts).
Test: `settles the exact revision validated after a non-revoking human confirmation` in
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts)
pins the validation/settlement race, and `starts a successor when the guided creation stage itself
checkpointed` with `continues a stalled stage in a successor and stops at the stage progress limit` in
[goal-file-host.test.ts](../../packages/kernel/tests/integration/goal-file-host.test.ts) prove the
first-stage continuation and the non-checkpoint one through the real file host.
Test: `host continuation retirement` in
[domain.test.ts](../../packages/goal/tests/unit/domain.test.ts), and
[hosted-continuation.test.ts](../../packages/kernel/tests/component/hosted-continuation.test.ts)
separately holds the terminal-commit barrier, the typed minimum instant with its re-ask, and the
abandonment of a pending instant when the authority is retired.
The latter composes private file sessions, actual hosting, goal gates, loop and SDK with controlled
responses. It verifies two automatic continuations, three separate run intents, decreasing budgets,
single-count usage, complete serialized prefix/cache identity, stagnation, incompatible request
refusal and pause/cancel races. These controlled-SDK tests are separate from TUI and Container qualification.

`createFileRunHost` registers this policy in its ordinary prepared execution path. It exposes a
connection-scoped `GoalService` with availability, state, receipt lookup, semantic formulation and
strict user controls.
Observer connections receive reads; writes resolve the actual registry controller and revalidate
authority inside the short mutation and after asynchronous preparation. Initial/resumed execution
uses the registry's internal start with that proof. Foreign peers and stale proof copies cannot
control the conversation. Pause retains physical occupancy, and ordinary input cannot resume it.
Native Host/Sandbox and complete Container Kernels advertise the service. Container keeps Goal
state, controls, budgets and continuation inside the canonical session shared with Host/Sandbox; it does not resume an
active Goal automatically after reconnect.
The common client returns explicit unavailability when the optional capability is absent.
Production: [service.ts](../../packages/kernel/src/goals/service.ts),
[file-host.ts](../../packages/kernel/src/hosting/file-host.ts), and
[container-native.ts](../../packages/kernel/src/hosting/container-native.ts).
Test: `starts a durable goal over IPC and admits its checkpoint continuation through the real kernel`
and `pause retains physical work, fences foreign control and prevents automatic continuation` in
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts).

Goal preparation wraps the host provider port for that stage. `createGoalUsageTracker` observes
leader, child, compaction and attributed retry calls without changing their options or responses.
Pending calls, rejected calls with no usage, and explicit provider uncertainty remain unknown;
zero-initialized loop totals cannot establish complete consumption. Missing cache detail
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
Container Kernel coverage exercises Goal creation, pause and explicit resume using the native domain
inside its canonical owner-scoped session state. Engine qualification also proves boot, persistence and broker
availability; it never resumes an interrupted Goal or replays a stage automatically.

The local `tooling/goal/live.ts` command qualifies the native file host with the existing global
subscription through the kernel's production resolver. A Linux host mount view retains renewable
credentials at their authoritative location and masks unrelated global configuration/state. The
synthetic goal requires a delegated implementation, a checkpoint, automatic continuation and actual
verification; completed delegation receipts and persisted workflow history make those requirements
decidable by the tool-free Steward. The harness independently reruns an unchanged test file that fails on the baseline.
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

Local, remote and Container TUI controls require the same authenticated conversation/controller
guarantees. Container constructs the native Goal descriptor, runtime port and tools inside its
Kernel; the host receives only bounded model calls. Reconnect preserves recoverable Goal state but
requires explicit resume and never replays an unknown stage.

Production: `createContainerNativeKernel` in
[container-native.ts](../../packages/kernel/src/hosting/container-native.ts), and `goalRuntimePortOf`
in [capability.ts](../../packages/goal/src/capability.ts). Test:
[container-kernel-host.test.ts](../../packages/kernel/tests/integration/container-kernel-host.test.ts)
and the native Goal suites cited above.

### Auxiliary accounting and exploratory reads

Formulation captures provider telemetry rather than inferring measured usage from loop totals.
Auxiliary results retain host-only model attribution for retry-inclusive session pricing; unknown
usage or cache does not become a measured zero or an invented cost. Receipt and Steward settlement
fences prevent duplicate charges. Production: `createKernelGoalAgentRuntime`, `createGoalUsageTracker`
and `addGoalAuxiliaryUsage` in [agent-runtime.ts](../../packages/kernel/src/goals/agent-runtime.ts)
and [usage.ts](../../packages/kernel/src/goals/usage.ts). Test:
[goal-auxiliary-usage.test.ts](../../packages/kernel/tests/unit/goal-auxiliary-usage.test.ts) and
[goal-formulate-service.test.ts](../../packages/kernel/tests/integration/goal-formulate-service.test.ts).

Observations may explore partial file reads; only complete reads become fenced artifact evidence.
Completion citations remain strict. Production: `verifyTraceNormativeSources` and the observation
validator in [trace-reads.ts](../../packages/kernel/src/goals/trace-reads.ts) and
[steward-coordinator.ts](../../packages/kernel/src/goals/steward-coordinator.ts). Test:
[goal-trace-reads.test.ts](../../packages/kernel/tests/unit/goal-trace-reads.test.ts).
