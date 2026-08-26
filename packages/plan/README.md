# `@clarvis/plan`

Execution-plan contracts, orchestration and persistence providers for Clarvis. The built-in provider
remains workspace-local Markdown — **the Markdown document IS the plan**, not an export of one — but
an operator may select a persistent language-neutral executable directly or through an enabled
plugin. The adapter preserves the same `PlanStore` contract.

Dependencies: `@clarvis/capability`, `@clarvis/paths`, `zod` and `yaml`.

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> is not published independently.

## Contract

The Markdown format, revisions, compare-and-swap, and repository are specified in
[`plan-store.md`](../../specs/capabilities/plan-store.md). Sessions, tools, review gates, and
retention are specified in [`plan-capability.md`](../../specs/capabilities/plan-capability.md).
External providers are governed by
[`provider-executables.md`](../../specs/capabilities/provider-executables.md).

## Entry points

| Entry                      | Contents                                                                    |
| -------------------------- | --------------------------------------------------------------------------- |
| `@clarvis/plan`            | provider/factory contracts, stores, service, format, transitions, revisions |
| `@clarvis/plan/schemas`    | the zod schemas and `DEFAULT_PLAN_RETENTION`                                |
| `@clarvis/plan/testing`    | repository and provider-facing `PlanStore` conformance suites               |
| `@clarvis/plan/capability` | the provider-aware planning capability                                      |
| `@clarvis/plan/settings`   | the light `plans:` settings contract                                        |

## Format

YAML frontmatter followed by five fixed sections:

```markdown
---
id: 8f4e2d1c-9a3b-4c5d-6e7f-8a9b0c1d2e3f
title: Fix the build
status: in_progress
retention: keep
revision: 7
spec_revision: 2
created_at: 2026-08-01T09:14:22.000Z
updated_at: 2026-08-01T09:41:03.000Z
created_by_run: run_9f2b
approved_spec_revision: 2
---

## Objective

## Context

## Tasks

- [x] (t1) Reproduce the failure
      Detail: run the suite with --isolate
      Exit: a failing test named in the output
      Result: `max-output-tokens-threading` times out under contention
- [>] (t2) Raise the per-test timeout
  Assignee: coder

## Validation

## Notes
```

Tasks are a **flat ordered list** — there are no phases. Markers:

| Marker | Status      | Marker | Status    |
| ------ | ----------- | ------ | --------- |
| `[ ]`  | pending     | `[x]`  | done      |
| `[>]`  | in_progress | `[-]`  | abandoned |
| `[<]`  | returned    | `[!]`  | failed    |

Indented continuation lines carry `Detail:`, `Exit:`, `Assignee:`, `Result:`, `Error:` and `Reason:`.

**Unknown frontmatter keys and extra `##` sections round-trip intact**, as do multi-line values and a
`## ` line appearing inside prose — the last two used to _brick_ the file on the next read. Blank and
multi-line task titles are rejected at the schema.

Changing the format means updating **both** `parsePlan` and `renderPlan` plus the round-trip tests.
The parser is strict on mutation and lenient on read: an unparsable file is reported as a diagnostic
and left untouched — never overwritten, never deleted.

## Resource bounds

Plan persistence and model-facing mutations share one set of hard limits from `src/limits.ts`. A
canonical Markdown document is at most **8 MiB**, and one list page retains at most **32 MiB** of
canonical source; discovery reads only a **64 KiB frontmatter prefix**, so an oversized or
body-corrupt file whose `id` is still present remains addressable and can be removed without loading
its body. Full reads use one descriptor, check its size before allocation, read at most the bound
plus one byte, and reject a file that changes during the read.

Directory traversal uses `opendir` and bounded top-K filename windows rather than materializing an
unbounded `readdir`: an operation examines at most **10,000 directory entries** and reports excess
explicitly. A plan carries at most **256 tasks** and **256 validation items**; one atomic revision or
transition batch carries at most **128 operations**. Section, task-field, item and aggregate prose
limits keep a provider or tool payload below the same document budget, and the JSON Schema shown to
the model advertises those bounds. Create/write reject an oversized result before opening a temp
file, so no partial plan is persisted.

## Two revisions, on purpose

- `revision` counts **every** write.
- `spec_revision` counts only changes to the plan's _substance_ — objective, context, tasks,
  validation.

Approval binds to `spec_revision`, so recording task progress never invalidates a human approval,
while editing the plan's substance always does.

## Batch, because compare-and-swap makes serial edits expensive

Every mutation carries the `(revision, digest, spec_digest)` triple it was read at. A human edit
between read and write is **detected and rejected, never overwritten**; `reconcile()` adopts an
external edit as a new revision.

Writes are atomic — temp file, `rename`, directory fsync, `0600`/`0700` — under a reentrant per-file
lease. Its ownership token and inode are verified on release, a heartbeat keeps a live writer fresh,
and stale recovery requires the recorded local process to be dead; an empty/partial legacy lock is
recoverable only after the same grace. The in-process queue is released even when lock-directory
setup fails, and a rejected setup promise is not cached, so a transient filesystem error can be
retried instead of wedging that plan key permanently.

That triple is also why **`revise_plan` and `transition_plan_task` take batches, and their tool
descriptions tell the model to use them**. A caller holds exactly one triple, so a second call issued
from the same decision carries the one the first just invalidated and is rejected as a conflict — a
three-call batch measured one write and two conflicts. Serial edits therefore cost a full model round
trip each, and a plan in the demo workspace reached `revision: 35` that way.

`applyPlanRevisions` folds the operations in order (so one may build on the last), the batch is
**all-or-nothing**, and it spends **one `revision` and at most one `spec_revision`** however many
operations it carries. Both tools still accept their old singular shape (`operation`, or a flat
`task_id`/`status`): the batch is what is advertised, but a model reaching for the singular is wrong
only about the envelope, and refusing it would cost the round trip this exists to save.

## States

**Two terminal states only**: `done` and `abandoned`, each with a mandatory field
(`result` / `reason`). `failed` requires `error` and is not terminal.

A sub-agent's return lands in `returned`, which is **not** closed — the lead must judge it
explicitly. In the loop, `delegate_task` may claim a task (`in_progress`) and record its return, but
only `transition_plan_task` may close one.

Planning does not turn independent spawning into a plan task. `spawn_subagent` remains the route for
independent work and carries no `task_id`. The plan capability adds `delegate_task`, which requires
the exact id of an existing task that the child genuinely implements. No plan or task should be
created solely to obtain an id.

**A `completed` plan is sealed** (`isPlanSealed`): it is the record of work that finished, and its
substance is immutable. `revise` refuses it with `PlanSealedError`. The one edit that survives the
seal is closing a task that is still **open** — a run that did the work and forgot to record it
leaves exactly that residue, and correcting it changes what the document says was _done_, not what
the plan _was_. `cancelled` and `failed` are deliberately not sealed: they describe work that
stopped, and continuing such a run is meant to resume it.

This is why a session may hold more than one plan over its life. The bound is on _open_ plans, not on
plans — see the loop's `PlanSession`, whose `create` seals a plan whose tasks are all closed and
starts the next. Before the seal existed, a session that finished one feature and was asked for a
second rewrote the first plan's title, objective, context and every task, because creating a second
was refused and the refusal named `revise_plan` as the way forward.

## Retention

`keep` is the default at every layer: a plan is the auditable record of what the agent intended and
what it did, so nothing is deleted without an explicit choice.

`discard` removes the file only **after** the terminal record persists, and only on a `completed`
run. A crash or cancellation always leaves it for recovery.

The default is defined once as `DEFAULT_PLAN_RETENTION` in `src/schemas.ts` and mirrored by
`PLANS_DEFAULTS` in `src/settings.ts`. The component test in
`tests/component/plan-session.test.ts` asserts that retention and pending-task-nudge defaults never
drift from their canonical constants.

## Observability

The package writes to an injected `Logger` (`@clarvis/capability`) and to nothing else; absent one it
resolves to `NOOP_LOGGER`, so every call site below is unconditional. The kernel supplies
`componentLogger("plan")` to `createPlanStore`, `createFilePlanRepository` and `createPlansCapability`.
There is **no `log_level` key** in the `plans:` block and no per-run parameter — verbosity is
`CLARVIS_LOG_LEVEL` / `CLARVIS_LOG` only (`specs/cross-cutting/observability.md` §2.6).

| Level | `event`                      | Fields                                                                                              |
| ----- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| debug | `plan.cas.rejected`          | `plan_id`, `mismatch[]` (`revision`/`digest`/`spec_digest`), `expected_revision`, `actual_revision` |
| warn  | `plan.document.unparsable`   | `path` (basename), `reason`, `layer` (`store`/`list`/`rescan`)                                      |
| info  | `plan.continuation.reset`    | `plan_id`, `tasks_reset`, `status_from`, `stale_approval_cleared`                                   |
| debug | `plan.continuation.absent`   | `plan_id`, `reason`                                                                                 |
| info  | `plan.retention.discarded`   | `plan_id`, `revision`, `deleted`                                                                    |
| error | `plan.tool.unexpected_error` | `tool`, `error_name`, `cause`, `stack`                                                              |
| debug | `plan.tracking_port.absent`  | `execution_id` (once per run)                                                                       |

A plan document is never logged — every event above reads a parsed `PlanDocument`/`PlanRef` and none
touches `record.source` or the `renderPlan` path.

## Control plane

`PlanService` is the list/read/setRetention/delete surface `@clarvis/kernel` wraps and exposes as
`PlansService` over the protocol. Clients read documents through it, never from the local filesystem,
so a remote kernel needs no client change.

The capability and control plane resolve through one `PlanFactory`. The factory re-reads the
operator's provider selection per operation, initializes a kernel-owned JSON-RPC session lazily,
and memoizes one authoritative store per effective declaration and owner. A live `PlanSession` never
changes stores mid-run.

## Providers

`plans.provider` accepts built-in Markdown, a direct executable declaration, or a plugin selection.
Absent means Markdown. Provider selection is configuration-only: a plugin may offer a service but
cannot select itself, and the selection is stripped from the per-run `plans` parameter.

Services speak JSON-RPC 2.0 over JSON Lines and may be written in any language. Clarvis applies
callbacks, revision operations, schemas, transitions and approval rules locally before sending a
serializable document plus expected CAS to `plans/write`. A configured service that cannot initialize
fails explicitly and never falls back to Markdown. See
[`specs/capabilities/provider-executables.md`](../../specs/capabilities/provider-executables.md).

Plan identity is `(provider_key, id)`. `path` is an optional display locator only; `read_plan` and
the control plane address plans by `id`.

## Development

The test suite is physically split by responsibility:

- `tests/unit`: messages, canonical state, pure policy, schemas and rendering rules;
- `tests/component`: sessions, runtime tools, orchestration and provider fakes in memory;
- `tests/contract`: the shared repository and store-provider conformance suites;
- `tests/integration`: real Markdown files, compare-and-swap, locks and external edits;
- `tests/architecture`: package and source-boundary guards.

`planRepositoryConformance` owns repository semantics and runs against the file and in-memory
adapters. `planStoreConformance` owns the complete store data-plane semantics and runs against the
executable, Markdown and in-memory stores. File layout, permissions, confinement, atomic writes,
lock contention, corruption and external-edit reconciliation remain real integration/contract tests;
sessions, runtime tools and orchestration compose in-memory stores and contract-shaped fakes.

```bash
bun --filter @clarvis/plan build
bun --filter @clarvis/plan typecheck
bun --filter @clarvis/plan test
bun --filter @clarvis/plan test:unit
bun --filter @clarvis/plan test:component
bun --filter @clarvis/plan test:contract
bun --filter @clarvis/plan test:integration
bun --filter @clarvis/plan test:architecture
bun --filter @clarvis/plan lint
bun --filter @clarvis/plan format:check
```

The package requires Bun 1.4.0 or newer.
