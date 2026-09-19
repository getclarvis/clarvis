# `@clarvis/goal`

Persistent conversation objectives, semantic formulation and bounded continuation policy. This
private product capability owns the domain without depending on the kernel, plans or a transport.
It depends on `@clarvis/loop` only for the generic run executor contract used by its bounded
formulation runtime; the loop does not name Goals. The host supplies session transactions, execution
authority, isolated executor dependencies and evidence validation.

The owning contract is [goals](../../specs/capabilities/goals.md). Hosting, plan finalization and
prompt-cache behavior retain their owning package contracts; domain tests alone do not qualify
automatic continuation, a TUI journey, a container or an installed artifact.

## Domain surface

- `applyGoalControl` validates user controls, CAS and idempotent operation receipts on a clone.
  Creation resolves omitted limits from host configuration and the finite entry budget only after
  checking replay. The raw parsed control determines the fingerprint; later configuration changes
  cannot alter a known receipt. Start receipts may retain the host's reserved execution identity.
- `applyGoalFormulation` reuses the same create reducer after the host validates a semantic proposal.
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

## Semantic formulation

`runGoalAgent` executes a fixed `goal-agent` profile through the generic loop executor. Its base
prompt is byte-identical across auto and guided runs: both precedence rules live in that fixed
policy, while mode, seed, trajectory, digest, truncation and workspace availability occur only in
the final volatile user message. Auto mode
treats the bounded trajectory as primary; guided mode treats the validated seed as primary and uses
trajectory and workspace reads only to resolve it. The agent reads an exact user-named artifact
first, may follow only a small number of essential direct references, and stops once it can describe
the observable result. Repository auditing, feasibility research and broad architecture/source/test
exploration belong to the execution agent. Both modes require structured `submit_result`; invalid
output is a failed operation and never falls back to command text. `formulationCriteria` assigns
deterministic host-owned IDs and accepts only qualitative or human criteria.
Human criteria are reserved for decisions indispensable to the result currently requested. A later
approval boundary on future or excluded work remains a constraint/exclusion and cannot manufacture
an elicitation for work the user did not authorize.

The request has no MCP servers, skills, hooks, workflows, memory, plans, Goal control or delegation.
It carries only `read_workspace`, a finite stop-mode budget, an empty shared prompt and the strict
formulation output schema. The Kernel replaces the capability list with its canonical Tools
capability, so the effective file surface comes from `@clarvis/tools` `readOnlyTools`; this package
does not maintain another allowlist. `callPurpose: "goal"` identifies the provider call without
putting semantic payloads in logs.
The Kernel binds every reported normative path to a complete successful read. The retained trace may
abbreviate the result text, but a host-owned digest of the complete pre-cap result lets the Kernel
revalidate large files and ordered multi-file batches without accepting a partial range or trusting
a model-supplied digest.

`GoalRecord` keeps constraints, exclusions, assumptions, normative source snapshots and literal,
guided or auto origin alongside its existing objective and criteria. Old pre-release state decodes
these arrays empty with literal origin. A semantic edit increments `objective_revision`, invalidates
the old candidate and acceptances, clears sources and converts the whole definition to literal.
Limit-only edits retain formulation provenance.

Production: `buildGoalAgentRequest`, `goalAgentPrompt`, `runGoalAgent` and
`goalFormulationResultSchema` under [src/agent](src/agent), plus `applyGoalFormulation` in
[control.ts](src/control.ts). Test: [agent-run.test.ts](tests/unit/agent-run.test.ts) covers the fixed
request, schema rejection, deterministic criterion IDs, accounting and backward-compatible decode.

## Entry capability

`@clarvis/goal/settings` is a lightweight entry for `goalsSettingsSpec`, `goalsSettingsSchema` and
`GoalsSettingsBlock`. Hosts register the strict `goals` settings block before reading configuration.
The nearest scope's whole block wins; plugins cannot contribute it, and it adds no run parameter.
Its optional `max_net_tokens` overrides the finite entry budget for the whole objective, while
`max_auto_continuations` defaults to 8 and `max_no_progress_checkpoints` to 3. `deadline_at` is an
optional absolute Unix timestamp in milliseconds. These defaults are copied only when creating or
replacing a goal; changes to configuration never rewrite existing limits, usage or receipts.
The non-contributable `goals.agent` block may select a model or override the formulation token
allowance. When omitted, that allowance equals the ordinary run token budget resolved from merged
settings or the host fallback; it belongs only to the formulation run and is capped by the same host
ceiling. Time, iteration, call-timeout and retry defaults remain 120,000 ms, eight iterations,
60,000 ms per call and one transport retry. An omitted model inherits `default_model`; an explicit
invalid model fails when formulation is invoked.

`createGoalCapability` consumes a host-bound `GoalRuntimePort` and requires activation for that
session, execution and persisted entry-agent instance. It contributes `get_goal` and `update_goal`
only to the entry agent. The model can record progress, request a gated checkpoint, submit a
completion candidate or report blocking. Evidence arguments contain host-issued IDs; the host
resolves their scope and verifies them. User controls and limit changes are absent from these tools.
The catalog adds short host-authored descriptions for discovery; persisted evidence contains only
the scoped reference and digest. Descriptions do not establish proof.

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
Its host-owned Goal Steward then reviews semantic sufficiency with a separate read-only execution.
Current observation decisions become internal notes at a safe iteration boundary; operator steering
takes precedence. A not-achieved final review returns a concrete correction; failure or inconclusive
review prevents completion. The domain owns the fixed schema, request policy, settings, review state
and idempotent usage reducer; the Kernel owns scheduling, reads, fencing and durable settlement.
`goals.agent.steward` selects the optional model and finite allowance independently of the work budget.
Private `continue_from` history preserves compatible prompt prefixes across evaluations and checkpoints.
The host supplies the work run's captured global and workspace operating instructions (`CLARVIS.md`,
falling back to `AGENTS.md` independently per scope) as normative evaluation context, never extra
permissions. A canonical configuration message precedes the first evaluation frame and is retained
without duplication on continuation. Changed instructions start a fresh private history; direct
operator restrictions and the persisted Goal still constrain interpretation.
The host checks semantic targets and current-evaluation artifact reads before accepting the Steward's
output, with one bounded corrective nudge inside that same evaluation. Repeated invalid output fails
closed; historical reads cannot establish current inspection. The host reserves review slots for
completion so observations cannot exhaust the final review allowance. Its fixed policy separates
fresh artifact inspection from host-recorded command execution: eligible command receipts from
prior Goal stages can establish tests already run, while later edits and contradictions still
require renewed validation by the work agent.
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

The live qualification runner under `tooling/goal/live.ts` is a separate host-boundary harness. It
uses fresh roots, workers and locks for every trial; the operator's subscription store is not
selected unless `--use-global-oauth` is passed explicitly and the Linux Bubblewrap view is
available. Synthetic trials therefore do not imply provider, PTY or installed-artifact coverage.

Auxiliary execution results can carry host-only per-model accounting alongside domain usage;
unknown formulation telemetry remains unknown rather than being inferred from empty loop totals.
