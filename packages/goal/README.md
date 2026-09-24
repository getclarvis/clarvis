# `@clarvis/goal`

Persistent conversation objectives, main-agent Goal creation and bounded continuation policy. This
private product capability owns the domain without depending on the kernel, plans or a transport.
It depends on `@clarvis/loop` only for the generic run executor contract used by its bounded
compatibility formulation runtime; the loop does not name Goals. The host supplies session transactions, execution
authority, isolated executor dependencies and evidence validation.

The owning contract is [goals](../../specs/capabilities/goals.md). Hosting, plan finalization and
prompt-cache behavior retain their owning package contracts; domain tests alone do not qualify
automatic continuation, a TUI journey or an installed artifact.

Runtime snapshots expose classified catalog failures through `evidence_unavailable`, separately
from validated Goal authority. Iteration refresh and `get_goal` preserve this distinction in their
model-facing state. Evidence-dependent operations still require valid proof; availability is not
completion or observed progress.
Settlement records `activity_unavailable` when the host cannot measure activity. It preserves the
semantic no-progress allowance without resetting it or increasing token, time or continuation limits.

The host can persist non-final settlement inputs with `prepareGoalSettlement` after physical closure.
Its immutable run-scoped preparation preserves usage gaps and unavailable activity across restart;
activity is deduplicated, excludes receipts already credited, and retains at most 32 new receipts.
Measured usage may carry the host's priced subtotal so recovery credits the Goal stage cost to the
Session once without relying on the loop's narrower per-agent detail.
`settleGoalRun` consumes it in the same transaction that charges the stage. It grants no final
completion proof or execution authority.

## Domain surface

- `applyGoalControl` validates user controls, CAS and idempotent operation receipts on a clone.
  Creation resolves omitted limits from host configuration and the finite entry budget only after
  checking replay. The raw parsed control determines the fingerprint; later configuration changes
  cannot alter a known receipt. Start receipts may retain the host's reserved execution identity.
- `applyGoalFormulation` reuses the same create reducer for the legacy control-plane formulation
  service after the host validates a semantic proposal.
  `recordGoalFormulationReceipt` stores created, insufficient, stale and failed outcomes in the
  existing bounded receipt audit without creating a draft store.
- `admitGoalRun`, `advanceGoalRun` and `settleGoalRun` separate durable intent, physical lifecycle,
  confirmed usage and semantic status. Late usage belongs to its original goal, including archives.
  A closed stage records one decision from a closed vocabulary — `complete`, `continue`, `attention`
  or `closed` — beside the host's typed `GoalRunCause` and whether the stage advanced the work. A
  recoverable ending keeps the goal active and records `continue`, so the host can admit one successor
  without a model checkpoint; the stage allowance, goal budget, deadline and continuation ceiling are
  what stop it. A cause the host cannot name is never presumed recoverable, and a durable fact the run
  code does not carry outranks that classification: a declared impediment and a completion review
  whose consumption could not be determined both settle as blocked rather than continuing. Progress is
  decided per receipt against the goal's whole recorded history, so recombining or repeating receipts
  an earlier stage already presented is not new progress, and only a successful observation
  contributes one. A provider's backoff is stored as a durable instant on the stage and is a pending
  wait only until it elapses.
- `recordGoalCheckpoint`, `recordGoalCandidate` and `validateGoalCandidate` retain scoped evidence,
  explicitly labeled qualitative judgments and recorded human acceptance. Validation returns the
  exact goal revision it inspected so a host can fence the later completion commit.
- `recordGoalProgress` stores a bounded annotation without ending a stage or resetting stagnation.
- `declareGoalImpediment` records a running stage's declared blocker without revoking the goal's
  authority: the status, control revision, limits, approvals and spend are unchanged, the declaration
  is durable on the stage, and the settlement blocks the goal with the declared reason. No automatic
  successor follows a declaration the host cannot separate from an operator's refusal.
- `goalAdmission` checks remaining tokens, deadline, continuation and stage-progress limits. The host
  must additionally hold the conversation reservation and current controller authority.
- `goalDeadlineLimit` gives execution and settlement the same absolute deadline decision as
  admission. The host checks it before every physical model call; work already in flight may finish,
  but no later call or completion commit crosses the deadline.
- `recordGoalUsageEstimate` retains sequenced per-run estimates without charging confirmed totals.
- `pauseGoalForPolicy` revokes future continuation on disconnect/restart while retaining occupancy.
- `stopGoalContinuation` fences host preparation/continuation failures against the bound stage and
  control revision, preserving a later user decision or successor admission.

There is one current goal plus a bounded audit archive in the existing private session document.
No public request may choose another owner. A paused or blocked goal requires explicit resume;
resume preserves costs and continuation counts. Explicit resume can reopen a terminal goal while preserving its audit. Clear and
replacement never delete audit records silently and require physical closure.

Goal, run and receipt identities are unique within that audit, and nested revisions cannot outrun
their owning state. The kernel repository maps this domain into the private session transaction;
the protocol remains independent of domain runtime code.

After measured budget exhaustion, an unsuccessful stage leaves the goal `budget_limited` and
retains its own failed/cancelled outcome and any overrun. Consumption is `complete`, `partial` (a
confirmed subtotal beside named gaps) or `unknown`, and only the last is charged nothing: a partial
subtotal is charged and its gap suspends automatic continuation until an explicit resume accepts
that execution's gap, which never rewrites the measurement. A later user pause or cancellation
remains authoritative. Resume alone does not grant more tokens.

## Main-agent Goal creation

Guided `/goal <seed>` is an ordinary turn of the selected main agent. The host carries a typed,
authenticated creation intent into admission, persists it on the session document as a formulating
intent that is not yet a Goal, and adds `create_goal` to that turn; it never starts a
second hidden formulation run. The operator's literal request stays a separate message from the
host formulation instruction. Until durable creation, dispatch admits proven reads and
clarification and refuses writes, shell, unknown/MCP tools, skills, workflows and work-executing
delegation. After `create_goal` commits, the same run may investigate, plan and implement. The host
assigns the Goal identity, limits, origin, execution binding and evidence scope.

Before `create_goal` there is no Goal state and no Goal Steward activity. The first request already
advertises the stable catalog `create_goal`, `get_goal` and `update_goal`; the latter two return
deterministic pre-creation guidance until `create_goal` succeeds. After durable creation their
handlers become active and the completion gate validates a candidate against host-issued evidence
before settling the stage. That first stage is an ordinary stage in every other respect: it runs the
same settlement and the same continuation policy as any later one, so a checkpoint or a recoverable
ending in the creating stage starts exactly one bounded successor. Until the Goal exists durably the
policy proposes nothing. The creation bridge is idempotent for the
admitted execution and cannot be selected by arbitrary model arguments or another conversation.
Literal `/goal -- <text>` remains a direct host control and does not invoke the model. The older
semantic formulation service remains available only as a compatibility control-plane API while
clients migrate to the main-agent path; it is not used by the Code slash command.

`GoalRecord` keeps constraints, exclusions, assumptions, normative source snapshots and literal,
guided or auto origin alongside its existing objective and criteria. Old pre-release state decodes
these arrays empty with literal origin. A semantic edit increments `objective_revision`, invalidates
the old candidate and acceptances, clears sources and converts the whole definition to literal.
Limit-only edits retain formulation provenance.

Production: `createGoalCreationCapability` and `goalCreationInputSchema` in
[src/capability.ts](src/capability.ts) and [src/model-input.ts](src/model-input.ts), with the
host bridge supplied through `GoalCreationPort`, and the shared settlement/continuation composition
in the kernel's `prepareHostedGoalCreationTurn`. Test: the capability and hosted-turn integration
tests plus the host-port unit test verify one visible main-agent run, idempotent creation, no
pre-save Steward invocation.

## Entry capability

`@clarvis/goal/settings` is a lightweight entry for `goalsSettingsSpec`, `goalsSettingsSchema` and
`GoalsSettingsBlock`. Hosts register the strict `goals` settings block before reading configuration.
The nearest scope's whole block wins; plugins cannot contribute it, and it adds no run parameter.
Its optional `max_net_tokens` overrides the finite entry budget for the whole objective, while
`max_auto_continuations` defaults to 8 and `max_no_progress_stages` to 3 — the stage allowance counts
closed stages that advanced nothing, including recoverable endings a successor re-evaluates, and it is
compared with the goal's whole recorded activity history. The field was renamed from
`max_no_progress_checkpoints`; `resolveGoalsSettings` admits and normalizes the old spelling in memory,
so a document that still carries it is not discarded whole. `deadline_at` is an
optional absolute Unix timestamp in milliseconds. These defaults are copied only when creating or
replacing a goal; changes to configuration never rewrite existing limits, usage or receipts.
The legacy non-contributable `goals.agent.formulation` block is retained for compatibility with the
control-plane API. Main-agent Goal creation uses the ordinary run's resolved budget and provider.

`createGoalCapability` consumes a host-bound `GoalRuntimePort` and requires activation for that
session, execution and persisted entry-agent instance. It contributes `get_goal` and `update_goal`
only to the entry agent. The model can record progress, request a gated checkpoint, submit a
completion candidate or report blocking. Evidence arguments contain host-issued IDs; the host
resolves their scope and verifies them. User controls and limit changes are absent from these tools. An authenticated ordinary operator turn may separately expose `attach_goal` to bind that already admitted execution to the previous objective.
The catalog adds short host-authored descriptions for discovery; persisted evidence contains only
the scoped reference and digest. Descriptions do not establish proof.

`createGoalCreationCapability` is the first-stage variant. It contributes `create_goal` plus the
same progress/checkpoint/candidate controls, activates the bound runtime only after durable
creation, and applies the completion gate to the same physical execution. `GoalCreationPort` is
host-only and owns the transaction that creates and admits that execution.

`goalRuntimePortOf` recovers the bound port only from a capability created by this package's
factory. Placement adapters cannot substitute an object merely named `goal`. The native
Kernel constructs the same canonical capability locally. Optional operation
signals supplement the execution signal; host implementations check them again inside each mutation,
so a cancelled queued operation cannot publish when its transaction eventually starts.

`progress`, `checkpoint` and `candidate` answer with `GoalOperationOutcome`: an evidence identifier
that is absent, duplicated, obsolete or unsuccessful is resolved before any durable write and returned
as corrigible input, which the entry capability answers as a tool error so the model can read the
catalog again. A lost binding, unreadable control, storage fault or state conflict still throws and
still ends the stage with host attention, because the host cannot present it as a rejected argument.

`update_goal` takes one `update` object whose action selects progress, checkpoint, candidate or
blocked fields. The advertised nested alternatives and runtime parser share one schema; fields for
another action remain invalid. Optional evidence IDs retain their empty default. This keeps provider
structured output from requiring unrelated action fields and producing calls the runtime rejects.

The goal gate disables fast acceptance and revalidates completion before an ordinary final result.
Its host-owned Goal Steward then reviews semantic sufficiency with a separate tool-free execution.
The Steward runs only after a terminal candidate passes deterministic completion prerequisites; it
does not continuously observe work or inject background corrections. A not-achieved review returns a
concrete correction to the same run; failure or inconclusive review prevents completion. The domain
owns the fixed schema, request policy, settings, review state and idempotent usage reducer; the Kernel
owns the bounded completion call, evidence projection, fencing and durable settlement.
Formulation and Steward output schemas declare an explicit object root and retain their exclusive
variants; the same schema is sent to every model without provider-specific rewriting.
`goals.agent.steward` selects the optional model and finite allowance independently of the work budget.
Private `continue_from` history preserves compatible prompt prefixes across evaluations and checkpoints.
The Steward never receives repository instructions such as `AGENTS.md` or `CLARVIS.md` and has no
workspace tools. The host supplies only the persisted Goal contract, the original operator request,
later operator corrections, the work agent's explanatory report and any prior Steward question with
the work agent's answer. That decision assesses declared evidence; it is not an independent audit of
artifacts. During completion, `needs_work` returns a
concrete correction while `needs_evidence` asks one specific question that the main run answers with
its normal tools. Technical interruption is persisted with a typed cause rather than left pending —
including `usage_unknown`, which is not a transport fault: the evaluation answered, possibly with a
valid `achieved`, but its consumption could not be determined and a Goal cannot be concluded on a
review the host cannot charge.
The host checks semantic targets
before accepting output and allows one bounded schema-correction nudge inside the same evaluation.
A review whose consumption was measured leaves the goal continuable by one bounded successor stage,
which re-establishes the result and is reviewed again; a review the host could not charge
(`usage_unknown`) never admits one, because the goal cannot continue on an evaluation the host cannot
account for.
A premature final is answered by one shared recovery policy: an attempt whose completion validation
rejects the candidate on its merits is nudged with the same orientation however many times it
repeats, and the run's own unproductive-attempt sequence is what bounds it. A productive iteration
clears that sequence, so an earlier refusal never condemns a later attempt, and a genuinely stuck
stage ends with `no_progress` rather than a blocked Goal. A verdict fenced out because the goal or
its evidence moved is a state conflict, not a deficiency: it is re-read once so a non-revoking human
acceptance inside the window can still settle the attempt, and a conflict that survives stops the
stage with `goal_finalization_conflict`. Settlement records `finalization_conflict` and may
admit one successor through the existing continuation path, preserving the semantic no-progress
allowance. Authority, consumption, deadline and continuation limits are still revalidated; the new
stage must submit a fresh candidate and pass every completion gate. The
orientation never requires a fabricated candidate before continuing and never names the Steward; the
typed cause and the host's own verdicts are recorded as bounded trace evidence without model or
objective text. Only recoverable verdicts recover: a failed read, foreign binding or obsolete
revision stays `goal_control_failed`, and an empty final stays a structural terminal. Reporting a
blocker uses safe interruption without requiring
plan task completion. Checkpoint requests still pass all plan/review/delegation gates. Plan state
is preserved on interruption. Neither acceptance nor a capability teardown commits goal completion.

Current state is a named stable context block, separate from the plan's canonical state. Each
iteration awaits a bound host read, so an external pause reaches the next request even when the model
does not call a goal tool. Read failure stops the stage; cancelled or timed-out reads cannot publish
late state. Model controls also refresh the snapshot. Publication waits until all tool results have been appended;
it never separates an assistant tool call from its result. Iteration entry and teardown also publish
the latest validated snapshot. Changed content is appended and older publications remain historical.
Its latest publication survives normal compaction selection. This capability contributes
no system section, second compaction anchor or output budget. The host remains the authority for
controls, bounded operations, finite execution budgets and automatic continuation.

## Development

Run from the monorepo root:

```bash
bun --filter @clarvis/goal build
bun --filter @clarvis/goal test
bun --filter @clarvis/goal typecheck
bun --filter @clarvis/goal lint
```

Tests exercise domain controls, execution fencing, reconciliation, bounds and criteria without a
provider. Kernel composition, protocol, runtime and real PTY tests own their respective seams.

The live qualification runner under `tooling/goal/live.ts` is a separate host-boundary harness. It
uses fresh roots, workers and locks for every trial; the operator's subscription store is not
selected unless `--use-global-oauth` is passed explicitly and the Linux Bubblewrap view is
available. Synthetic trials therefore do not imply provider, PTY or installed-artifact coverage.

Auxiliary execution results can carry host-only per-model accounting alongside domain usage;
unknown formulation telemetry remains unknown rather than being inferred from empty loop totals.

Existing-objective activation uses `GoalAttachmentPort` and `createGoalAttachmentCapability`.
Before attachment the previous objective is subordinate context and does not gate independent work.
After attachment the same progress, completion and Steward gates apply. Gap acceptance is bound to
its recorded gap identity; a changed subtotal alone does not accept newly discovered gaps.
Explicitly versioned usage corrections accept signed deltas, ignore older revisions and reject
conflicting values at the same revision. Unversioned measurements must still add information.

Pending resumes can link a limits edit through `resume_operation_id`; a plain edit never starts work. Partial usage gaps preserve bounded call provenance.
