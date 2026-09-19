# `@clarvis/goal`

Persistent conversation objectives, main-agent Goal creation and bounded continuation policy. This
private product capability owns the domain without depending on the kernel, plans or a transport.
It depends on `@clarvis/loop` only for the generic run executor contract used by its bounded
compatibility formulation runtime; the loop does not name Goals. The host supplies session transactions, execution
authority, isolated executor dependencies and evidence validation.

The owning contract is [goals](../../specs/capabilities/goals.md). Hosting, plan finalization and
prompt-cache behavior retain their owning package contracts; domain tests alone do not qualify
automatic continuation, a TUI journey, a container or an installed artifact.

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
- `recordGoalCheckpoint`, `recordGoalCandidate` and `validateGoalCandidate` retain scoped evidence,
  explicitly labeled qualitative judgments and recorded human acceptance. Validation returns the
  exact goal revision it inspected so a host can fence the later completion commit.
- `recordGoalProgress` stores a bounded annotation without ending a stage or resetting stagnation.
- `blockGoalRun` records a running stage's blocker without claiming physical closure or overriding
  a later user pause/cancel decision.
- `goalAdmission` checks remaining tokens, deadline, continuation and stagnation limits. The host
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
resume preserves costs and continuation counts. A terminal goal requires replacement. Clear and
replacement never delete audit records silently and require physical closure.

Goal, run and receipt identities are unique within that audit, and nested revisions cannot outrun
their owning state. The kernel repository maps this domain into the private session transaction;
the protocol remains independent of domain runtime code.

After measured budget exhaustion, an unsuccessful stage leaves the goal `budget_limited` and
retains its own failed/cancelled outcome and any overrun. Missing usage still blocks accounting;
a later user pause or cancellation remains authoritative. Resume alone does not grant more tokens.

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
before settling the stage. The creation bridge is idempotent for the
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
host bridge supplied through `GoalCreationPort`. Test: the capability and hosted-turn integration
tests plus the host-port unit test verify one visible main-agent run, idempotent creation and no
pre-save Steward invocation.

## Entry capability

`@clarvis/goal/settings` is a lightweight entry for `goalsSettingsSpec`, `goalsSettingsSchema` and
`GoalsSettingsBlock`. Hosts register the strict `goals` settings block before reading configuration.
The nearest scope's whole block wins; plugins cannot contribute it, and it adds no run parameter.
Its optional `max_net_tokens` overrides the finite entry budget for the whole objective, while
`max_auto_continuations` defaults to 8 and `max_no_progress_checkpoints` to 3. `deadline_at` is an
optional absolute Unix timestamp in milliseconds. These defaults are copied only when creating or
replacing a goal; changes to configuration never rewrite existing limits, usage or receipts.
The legacy non-contributable `goals.agent.formulation` block is retained for compatibility with the
control-plane API. Main-agent Goal creation uses the ordinary run's resolved budget and provider.

`createGoalCapability` consumes a host-bound `GoalRuntimePort` and requires activation for that
session, execution and persisted entry-agent instance. It contributes `get_goal` and `update_goal`
only to the entry agent. The model can record progress, request a gated checkpoint, submit a
completion candidate or report blocking. Evidence arguments contain host-issued IDs; the host
resolves their scope and verifies them. User controls and limit changes are absent from these tools.
The catalog adds short host-authored descriptions for discovery; persisted evidence contains only
the scoped reference and digest. Descriptions do not establish proof.

`createGoalCreationCapability` is the first-stage variant. It contributes `create_goal` plus the
same progress/checkpoint/candidate controls, activates the bound runtime only after durable
creation, and applies the completion gate to the same physical execution. `GoalCreationPort` is
host-only and owns the transaction that creates and admits that execution.

`goalRuntimePortOf` recovers the bound port only from a capability created by this package's
factory. Placement adapters cannot substitute an object merely named `goal`. The complete Container
Kernel constructs the same canonical capability locally. Optional operation
signals supplement the execution signal; host implementations check them again inside each mutation,
so a cancelled queued operation cannot publish when its transaction eventually starts.

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
`goals.agent.steward` selects the optional model and finite allowance independently of the work budget.
Private `continue_from` history preserves compatible prompt prefixes across evaluations and checkpoints.
The Steward never receives repository instructions such as `AGENTS.md` or `CLARVIS.md` and has no
workspace tools. The host supplies only the persisted Goal contract, the original operator request,
later operator corrections, the work agent's explanatory report and any prior Steward question with
the work agent's answer. That decision assesses declared evidence; it is not an independent audit of
artifacts. During completion, `needs_work` returns a
concrete correction while `needs_evidence` asks one specific question that the main run answers with
its normal tools. Technical interruption is persisted with a typed cause rather than left pending.
The host checks semantic targets
before accepting output and allows one bounded schema-correction nudge inside the same evaluation.
One nonempty invalid final receives a recovery nudge; a repeated invalid final or the first empty
final stops with explicit blocking. Reporting a blocker uses safe interruption without requiring
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

Auxiliary execution results can carry host-only per-model accounting alongside domain usage;
unknown formulation telemetry remains unknown rather than being inferred from empty loop totals.
