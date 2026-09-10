# `@clarvis/goal`

Persistent conversation objectives and bounded continuation policy. This private product capability
owns the domain without depending on the kernel, loop, plans or a transport. The host supplies
session transactions, execution authority and evidence verification.

The owning contract is [goals](../../specs/capabilities/goals.md). Hosting, plan finalization and
prompt-cache behavior retain their owning package contracts; domain tests alone do not qualify
automatic continuation, a TUI journey, a container or an installed artifact.

## Domain surface

- `applyGoalControl` validates user controls, CAS and idempotent operation receipts on a clone.
  Creation resolves omitted limits from host configuration and the finite entry budget only after
  checking replay. The raw parsed control determines the fingerprint; later configuration changes
  cannot alter a known receipt. Start receipts may retain the host's reserved execution identity.
- `admitGoalRun`, `advanceGoalRun` and `settleGoalRun` separate durable intent, physical lifecycle,
  confirmed usage and semantic status. Late usage belongs to its original goal, including archives.
- `recordGoalCheckpoint`, `recordGoalCandidate` and `validateGoalCandidate` retain scoped evidence,
  explicitly labeled qualitative judgments and recorded human acceptance.
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

## Entry capability

`@clarvis/goal/settings` is a lightweight entry for `goalsSettingsSpec`, `goalsSettingsSchema` and
`GoalsSettingsBlock`. Hosts register the strict `goals` settings block before reading configuration.
The nearest scope's whole block wins; plugins cannot contribute it, and it adds no run parameter.
Its optional `max_net_tokens` overrides the finite entry budget for the whole objective, while
`max_auto_continuations` defaults to 8 and `max_no_progress_checkpoints` to 3. `deadline_at` is an
optional absolute Unix timestamp in milliseconds. These defaults are copied only when creating or
replacing a goal; changes to configuration never rewrite existing limits, usage or receipts.

`createGoalCapability` consumes a host-bound `GoalRuntimePort` and requires activation for that
session, execution and persisted entry-agent instance. It contributes `get_goal` and `update_goal`
only to the entry agent. The model can record progress, request a gated checkpoint, submit a
completion candidate or report blocking. Evidence arguments contain host-issued IDs; the host
resolves their scope and verifies them. User controls and limit changes are absent from these tools.
The catalog adds short host-authored descriptions for discovery; persisted evidence contains only
the scoped reference and digest. Descriptions do not establish proof.

`goalRuntimePortOf` recovers the bound port only from a capability created by this package's
factory. Placement adapters cannot substitute an object merely named `goal`. Kernel's container
bridge uses that identity to install the same canonical capability in the guest. Optional operation
signals supplement the execution signal; host implementations check them again inside each mutation,
so a cancelled queued operation cannot publish when its transaction eventually starts.

`update_goal` takes one `update` object whose action selects progress, checkpoint, candidate or
blocked fields. The advertised nested alternatives and runtime parser share one schema; fields for
another action remain invalid. Optional evidence IDs retain their empty default. This keeps provider
structured output from requiring unrelated action fields and producing calls the runtime rejects.

The goal gate disables fast acceptance and revalidates completion before an ordinary final result.
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
