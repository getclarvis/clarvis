# The plan Markdown document, revisions, CAS and the repository

> Implemented at `packages/plan/src/**` and `packages/plan/tests/**`. Every claim below is anchored
> to a file and line. Open questions are collected in the final section.

## 1. Purpose

`@clarvis/plan` persists an execution plan as **one Markdown file whose bytes are the plan**. The
document carries YAML frontmatter plus five fixed `##` sections, and `parsePlan` / `renderPlan` are an
inverse pair over that text (`packages/plan/src/format.ts`). Nothing derives the document
from a database row: the file-backed repository re-derives the queryable projection by parsing the
bytes it just read (`packages/plan/src/file-repository.ts`), and so does the in-memory one
(`packages/plan/src/testing.ts`). A human editing the file out of band is therefore a first-class
input, not corruption.

Because the bytes are the record, concurrency is handled by **content-addressed compare-and-swap**
rather than by a lock the caller holds across a decision. Each stored plan's `digest` is
`sha256(source)` (`packages/plan/src/format.ts`, used at `packages/plan/src/repository.ts`),
and a second digest — `spec_digest` — covers only the plan's *substance* (objective, context,
validation, and each task's `id`/`title`/`detail`/`exit`), deliberately excluding status and outcome
fields (`packages/plan/src/format.ts`). The pair plus `revision` is the `PlanCas` triple a
mutation must present (`packages/plan/src/store.ts`).

Three layers stack. `PlanRepository` moves opaque canonical Markdown keyed by id and knows nothing
about revisions (`packages/plan/src/repository.ts`). `PlanStore` is the aggregate: it CAS-checks,
folds revision operations, bumps the two counters, invalidates approval, re-validates against the Zod
schema and renders (`packages/plan/src/store.ts`). `PlanService` adds the control-plane policy the
store does not have — refusing to delete a live plan (`packages/plan/src/service.ts`). How a *run*
uses a plan (the session, the review gate, the five model tools, retention as run policy) belongs to
**plan-capability-and-review**; the executable/external provider belongs to
**capability-provider-executables**.

## 2. Surface

Package `@clarvis/plan` is a private, unversioned workspace whose product version comes from the
root manifest. Its dependencies are exactly `@clarvis/capability`, `@clarvis/paths`, `yaml`, and
`zod` (`packages/plan/package.json`, `dependencies`). Entry points `.`, `./schemas`,
`./testing`, `./capability`, `./settings` (`packages/plan/package.json`).

### 2.1 Format codec — `src/format.ts`

| Export | Signature | File |
| --- | --- | --- |
| `digestText` | `(text: string) => string` — lowercase sha256 hex | `packages/plan/src/format.ts` |
| `specDigest` | `(d: Pick<PlanDocument,"objective"\|"context"\|"tasks"\|"validation">) => string` | `packages/plan/src/format.ts` |
| `projectPlan` | `(d: PlanDocument) => PlanIndex`; `path` falls back to `""` | `packages/plan/src/format.ts` |
| `planFilename` | `(date: Date, title: string) => string` | `packages/plan/src/format.ts` |
| `parsePlan` | `(source: string, path?: string) => PlanDocument` | `packages/plan/src/format.ts` |
| `renderPlan` | `(document: PlanDocument) => string` | `packages/plan/src/format.ts` |
| `newPlan` | `(input: {title, objective, context?, tasks, validation?, retention?, createdByRun, review?, now?}) => PlanDocument` | `packages/plan/src/format.ts` |

### 2.2 Schemas — `src/schemas.ts`

| Export | Kind | File |
| --- | --- | --- |
| `planStatusSchema` | `enum["awaiting_approval","active","completed","cancelled","failed"]` | `packages/plan/src/schemas.ts` |
| `planRetentionSchema` | `enum["discard","keep"]` | `packages/plan/src/schemas.ts` |
| `DEFAULT_PLAN_RETENTION` | `"keep"` | `packages/plan/src/schemas.ts` |
| `planTaskStatusSchema` | `enum["pending","in_progress","returned","done","abandoned","failed"]` | `packages/plan/src/schemas.ts` |
| `taskTitleSchema` | bounded string, non-blank, no `\n` | `packages/plan/src/schemas.ts` |
| `singleLineSchema` | bounded string, no `\n` | `packages/plan/src/schemas.ts` |
| `planTaskSchema` | object; `id` matches `^t[1-9]\d*$`, max 32 chars | `packages/plan/src/schemas.ts` |
| `planDocumentSchema` | object + `superRefine` total-text cap | `packages/plan/src/schemas.ts` |
| `PLANS_CAPABILITY_NAME` | `"plans"` | `packages/plan/src/schemas.ts` |
| `PlanRef` (type) | run→plan pointer filed in `capability_state` | `packages/plan/src/schemas.ts` |

### 2.3 Revisions — `src/revisions.ts`

| Export | Signature | File |
| --- | --- | --- |
| `planRevisionOperationSchema` | discriminated union on `type`, 8 members | `packages/plan/src/revisions.ts` |
| `nextRevision` | `(current, changed, {structural, now}) => PlanDocument` | `packages/plan/src/revisions.ts` |
| `applyPlanRevisions` | `(document, operations[]) => {document, structural}` | `packages/plan/src/revisions.ts` |
| `applyPlanRevision` | `(document, operation) => {document, structural}` | `packages/plan/src/revisions.ts` |

An operation's own task-id references — `task_id` and `after_task_id` on `add_task`, `edit_task`,
`remove_task`, `reorder_task` (`packages/plan/src/revisions.ts`) — are validated only by the regex `/^t[1-9]\d*$/`,
with no `.max()`. The stored task's own `id` field is additionally capped at 32 characters
(`packages/plan/src/schemas.ts`). An oversized numeral therefore passes `planRevisionOperationSchema` and only fails
later, inside `applyPlanRevision`'s task lookup, with an uncapped ``Unknown plan task: <id>`` message.

### 2.4 Transitions — `src/transitions.ts`

| Export | Signature | File |
| --- | --- | --- |
| `allowedTaskTransitions` | `(status) => readonly PlanTaskStatus[]` | `packages/plan/src/transitions.ts` |
| `transitionTask` | `(task, to, detail?) => PlanTask` (pure) | `packages/plan/src/transitions.ts` |
| `CLOSED_TASK_STATUSES` | `["done","abandoned"]` | `packages/plan/src/transitions.ts` |
| `isTaskClosed` | `(status) => boolean` | `packages/plan/src/transitions.ts` |
| `canCompletePlan` | `(plan) => boolean` | `packages/plan/src/transitions.ts` |
| `isPlanSealed` | `(plan: Pick<PlanDocument,"status">) => boolean` | `packages/plan/src/transitions.ts` |
| `sealedRevisionMessage` | `(id) => string` | `packages/plan/src/transitions.ts` |
| `sealedTransitionMessage` | `(id, to) => string` | `packages/plan/src/transitions.ts` |

### 2.5 Persistence port and errors — `src/repository.ts`

| Export | Kind | File |
| --- | --- | --- |
| `PlanIndex` | queryable projection (`path,title,status,retention,revision,spec_revision,created_at,updated_at,created_by_run`) | `packages/plan/src/repository.ts` |
| `PlanRecord` | `{id, source, digest, index}` | `packages/plan/src/repository.ts` |
| `PlanRecordQuery` | `{cursor?, limit?, status?, retention?}` | `packages/plan/src/repository.ts` |
| `PlanRecordPage` | `{records, next_cursor?}` | `packages/plan/src/repository.ts` |
| `PlanRepositoryTx` / `PlanRepository` | `create`/`read`/`list`/`write`/`delete` | `packages/plan/src/repository.ts` |
| `PlanNotFoundError` | `code = "plan_not_found"` | `packages/plan/src/repository.ts` |
| `PlanConflictError` | `code = "plan_conflict"`, `reason: "cas" \| "locked"` (default `"cas"`) | `packages/plan/src/repository.ts` |
| `PlanSealedError` | `code = "plan_sealed"` | `packages/plan/src/repository.ts` |
| `InvalidPlanError` | `code = "plan_invalid"` | `packages/plan/src/repository.ts` |

### 2.6 Aggregate — `src/store.ts`

| Export | Signature | File |
| --- | --- | --- |
| `PlanCas` | `{revision, digest, specDigest}` | `packages/plan/src/store.ts` |
| `PlanListInput` / `PlanListResult` | `{cursor?,limit?,status?,retention?}` / `{plans, next_cursor?}` | `packages/plan/src/store.ts` |
| `CreatePlanInput` | plan content + `createdByRun`, `review?`, `now?` | `packages/plan/src/store.ts` |
| `PlanStore` | `create`/`read`/`list`/`update`/`reconcile`/`revise`/`delete` | `packages/plan/src/store.ts` |
| `CreatePlanStoreOptions` | `{repository, now?, logger?}` | `packages/plan/src/store.ts` |
| `createPlanStore` | `(options) => PlanStore` | `packages/plan/src/store.ts` |

### 2.7 File adapter — `src/file-repository.ts`

| Export | Signature | File |
| --- | --- | --- |
| `CreateFilePlanRepositoryOptions` | `{workspaceRoot, root?, lockDir?, logger?}` | `packages/plan/src/file-repository.ts` |
| `createFilePlanRepository` | `(options) => PlanRepository` | `packages/plan/src/file-repository.ts` |

### 2.8 Control plane — `src/service.ts`

| Export | Signature | File |
| --- | --- | --- |
| `PlanNotTerminalError` | `code = "plan_not_terminal"` | `packages/plan/src/service.ts` |
| `PlanService` | `constructor(store)`, `list`, `read`, `setRetention`, `delete` | `packages/plan/src/service.ts` |

### 2.9 Limits — `src/limits.ts`

| Constant | Value | File |
| --- | --- | --- |
| `MAX_PLAN_DOCUMENT_BYTES` | 8 MiB | `packages/plan/src/limits.ts` |
| `MAX_PLAN_LIST_PAGE_BYTES` | 32 MiB | `packages/plan/src/limits.ts` |
| `MAX_PLAN_FRONTMATTER_BYTES` | 64 KiB | `packages/plan/src/limits.ts` |
| `MAX_PLAN_DIRECTORY_ENTRIES` | 10 000 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_FILENAME_WINDOW` | 256 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_TASKS` | 256 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_VALIDATION_ITEMS` | 256 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_BATCH_OPERATIONS` | 128 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_LOCATOR_CHARS` | 1 024 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_TITLE_CHARS` | 1 024 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_TASK_TITLE_CHARS` | 1 024 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_SECTION_CHARS` | 1 MiB | `packages/plan/src/limits.ts` |
| `MAX_PLAN_TASK_FIELD_CHARS` | 64 KiB | `packages/plan/src/limits.ts` |
| `MAX_PLAN_ASSIGNEE_CHARS` | 1 024 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_VALIDATION_ITEM_CHARS` | 8 KiB | `packages/plan/src/limits.ts` |
| `MAX_PLAN_TEXT_CHARS` | 4 MiB | `packages/plan/src/limits.ts` |
| `MAX_PLAN_EXTENSION_FIELDS` | 256 | `packages/plan/src/limits.ts` |
| `MAX_PLAN_EXTENSION_KEY_CHARS` | 1 024 | `packages/plan/src/limits.ts` |

Plus `planSourceByteLength(source)` (`packages/plan/src/limits.ts`) and `assertPlanSourceSize(source)`, which throws
`RangeError` above `MAX_PLAN_DOCUMENT_BYTES` (`packages/plan/src/limits.ts`).

### 2.10 Conformance harnesses — `src/testing.ts`

Exposed as **data**, asserting through `node:assert/strict`, so no test-runner dependency is carried
(`packages/plan/src/testing.ts`).

| Export | Shape | File |
| --- | --- | --- |
| `createInMemoryPlanRepository` | `() => PlanRepository` (+ hidden `poke`) | `packages/plan/src/testing.ts` |
| `PlanRepositoryHarness` | `{repository, poke?, cleanup}` | `packages/plan/src/testing.ts` |
| `PlanConformanceCase` | `{name, run(harness)}` | `packages/plan/src/testing.ts` |
| `planRepositoryConformance()` | 18 cases | `packages/plan/src/testing.ts` |
| `PlanStoreHarness` | `{store, cleanup}` | `packages/plan/src/testing.ts` |
| `PlanStoreConformanceCase` | `{name, run(harness)}` | `packages/plan/src/testing.ts` |
| `planStoreConformance()` | 10 cases | `packages/plan/src/testing.ts` |

## 3. Data and formats

### 3.1 The document

A real render, produced by calling `newPlan` + `renderPlan` from this package (id substituted for a
fixed value):

```markdown
---
id: 0f9c1b7e-6a2d-4c31-9d55-3f0d6b8e1a44
title: Ship the plan spec
status: active
retention: keep
revision: 1
spec_revision: 1
created_at: <iso-datetime>
updated_at: <iso-datetime>
created_by_run: run-1
---

## Objective

Document the store.

## Context

Documenting the on-disk format.

## Tasks

- [ ] (t1) Read format.ts
  - Detail: line by line
  - Exit: notes exist
- [ ] (t2) Write the spec

## Validation

- bun test passes

## Notes
```

Frontmatter key order is fixed by `renderPlan`: any preserved unknown keys are spread **first**, then
the ten controlled keys, with `approved_spec_revision` emitted only when defined
(`packages/plan/src/format.ts`). YAML is stringified with `lineWidth: 0` and the whole file is
newline-terminated (`packages/plan/src/format.ts`).

### 3.2 Frontmatter fields

| Key | Schema | File |
| --- | --- | --- |
| `id` | 1…1024 chars; generated as `randomUUID()` by `newPlan` | `packages/plan/src/schemas.ts`, `packages/plan/src/format.ts` |
| `title` | 1…1024 chars | `packages/plan/src/schemas.ts` |
| `status` | `planStatusSchema` | `packages/plan/src/schemas.ts` |
| `retention` | `planRetentionSchema` | `packages/plan/src/schemas.ts` |
| `revision` | non-negative int | `packages/plan/src/schemas.ts` |
| `spec_revision` | non-negative int | `packages/plan/src/schemas.ts` |
| `created_at`, `updated_at` | ISO datetime strings | `packages/plan/src/schemas.ts` |
| `created_by_run` | 1…1024 chars | `packages/plan/src/schemas.ts` |
| `approved_spec_revision` | optional non-negative int | `packages/plan/src/schemas.ts` |

`path`, `digest` and `spec_digest` are on the parsed object but are **not** persisted in the file:
`path` is the repository's display locator (`packages/plan/src/schemas.ts`), and the two digests are
recomputed (`packages/plan/src/format.ts` states the render does not store them; `parsePlan` sets
`digest = digestText(source)` and then derives `spec_digest` with `specDigest(parsed)`).

The `CONTROLLED` set at `packages/plan/src/format.ts` is exactly those ten keys; everything else in the frontmatter
lands in `unknown_frontmatter` (`packages/plan/src/format.ts`), bounded to 256 keys of ≤1024 chars each
(`packages/plan/src/schemas.ts`).

### 3.3 Section and task line grammar

- Required sections, in this order: `Objective`, `Context`, `Tasks`, `Validation`, `Notes`
  (`packages/plan/src/format.ts`). Each is located by a `^## (.+?)[ \t]*$` heading at or after the previous anchor
  (`packages/plan/src/format.ts`); a missing one throws ``Invalid plan Markdown: missing ## <name>``
  (`packages/plan/src/format.ts`).
- Any `##` heading **after** the `Notes` heading is an extra section, preserved in `extra_sections`
  (`packages/plan/src/format.ts`). A `##`-shaped line inside a prose section is absorbed into that
  section's body, because a controlled section spans to the next *anchor*'s heading
  (`packages/plan/src/format.ts`) — pinned by `packages/plan/tests/unit/plan-format.test.ts`.
- Task marker line: `- [<marker>] (<id>) <title>`, regex `^- \[([ x><!-])\] \((t[1-9]\d*)\) (.+)$`
  (`packages/plan/src/format.ts`).
- Task field line: ` - (Detail|Exit|Assignee|Result|Error|Reason):( value)?`, two-space indent
  (`packages/plan/src/format.ts`); an absent value yields `""` (`packages/plan/src/format.ts`).
- Continuation of a field: four-space indent, appended after a `\n` (`packages/plan/src/format.ts`); a blank
  line appends a bare `\n` (`packages/plan/src/format.ts`).
- Any other non-blank line inside `## Tasks` throws ``Invalid plan Markdown task line: <line>``
  (`packages/plan/src/format.ts`).
- Validation lines are `- <item>`; anything else throws
  ``Invalid plan Markdown validation line: <line>`` (`packages/plan/src/format.ts`).

Status ↔ marker table (`packages/plan/src/format.ts`, inverted):

| Status | Marker |
| --- | --- |
| `pending` | `[ ]` |
| `in_progress` | `[>]` |
| `returned` | `[<]` |
| `done` | `[x]` |
| `abandoned` | `[-]` |
| `failed` | `[!]` |

### 3.4 Filename

`planFilename(date, title)` = `date.toISOString().slice(0,19)` with `:` → `-`, then `-`, then a slug:
NFKD-normalized, combining marks stripped, lowercased, non-`[a-z0-9]` runs collapsed to `-`, leading
and trailing `-` trimmed, truncated to 48 chars, falling back to `plan` when empty; suffix `.md`
(`packages/plan/src/format.ts`). Pinned example: for a UTC instant represented by
`YYYY-MM-DDTHH:mm:ssZ` and the title `"Ship the Plan!"`, `planFilename` returns
`YYYY-MM-DDTHH-mm-ss-ship-the-plan.md` (`packages/plan/tests/unit/plan-format.test.ts`).

### 3.5 On-disk layout

| Path | Owner | File |
| --- | --- | --- |
| `<ws>/.clarvis/plans/` | default plans root | `packages/plan/src/file-repository.ts` → `packages/paths/src/workspace.ts` |
| `<ws>/.clarvis/owners/<segment>/plans/` | per-owner root passed as `root` | `packages/paths/src/workspace.ts`, used at `packages/kernel/src/owner-scoped-file-stores.ts` |
| `<global>/state/workspaces/<segment>/plans/` | lockfile directory (default) | `packages/plan/src/file-repository.ts` → `packages/paths/src/workspace-state.ts` |
| `<global>/state/workspaces/<segment>/owners/<segment>/plans/` | per-owner lock dir | `packages/paths/src/workspace-state.ts`, used at `packages/kernel/src/owner-scoped-file-stores.ts` |

Modes: root `0o700`, plan file `0o600`, lock directory `0o700` (`packages/plan/src/file-repository.ts`), pinned at `packages/plan/tests/integration/file-repository.test.ts` (every intermediate owner directory too). A record's `index.path` is workspace-relative and
forward-slashed regardless of platform separator (`packages/plan/src/file-repository.ts`), e.g.
`.clarvis/plans/YYYY-MM-DDTHH-mm-ss-ship-the-thing.md`
(`packages/plan/tests/integration/file-repository.test.ts`).

The atomic-write temp file is a **sibling** of the plan, named by `@clarvis/paths`' `tmpPathFor`
(`packages/plan/src/file-repository.ts`), i.e. prefixed `.clarvis-tmp-` (`packages/paths/src/constants.ts`) —
which does not end in `.md` and so is invisible to the directory scan (`packages/plan/src/file-repository.ts`).
Lockfiles are `<lockDir>/<name>.lock` (`packages/plan/src/file-repository.ts`); creation is
`<lockDir>/.allocation.lock` (`packages/plan/src/file-repository.ts`).

### 3.6 Cursors

Cursors are **opaque, adapter-specific and self-identifying**. Each carries a three-letter tag naming
the dialect that minted it — `pf1`, `pm1`, `pp1` in `PLAN_CURSOR_TAGS`
(`packages/plan/src/cursor.ts`) — so a cursor fed to a backend that did not mint it raises
`PlanCursorError` instead of being read as that backend's own. The tag is stripped on the way in and
stamped on the way out, so the paging contract is unchanged: an opaque string in, an opaque string
out. Under the tag, the file adapter's cursor is a *filename* used as an exclusive upper bound in
descending lexical order (`packages/plan/src/file-repository.ts`, validated as a locator); the in-memory adapter's is a *record id* looked up by index
(`packages/plan/src/testing.ts`); the provider store strips its own tag before forwarding and
re-stamps the remote's `next_cursor` on the way back (`packages/plan/src/provider.ts`), so the
remote's dialect is untouched inside the envelope.

One divergence survives the tagging deliberately. When the plan a *correctly tagged* cursor names has
been deleted between pages, the file adapter pages on — a filename is a lexical bound, and a deleted
one is still a valid bound — while the in-memory adapter restarts at page one. That is a race, not a
dialect error, and conflating the two would turn a production-reachable sequence into a hard failure:
the plan overlay arms a delete and then replays a cursor stack it does not reset.

## 4. Behavior

### 4.1 `parsePlan(source, path?)` — `packages/plan/src/format.ts`

1. `assertPlanSourceSize(source)`.
2. `splitDocument` — require `^---\n…\n---\n?` and a YAML **mapping**; otherwise throw
   ``Invalid plan Markdown: YAML frontmatter is required`` / ``… frontmatter must be a mapping``
   (`packages/plan/src/format.ts`).
3. `sections(body)` — locate the five anchors in order, slice controlled bodies, collect extras
   (`packages/plan/src/format.ts`). Each slice strips one leading blank line and all trailing whitespace.
4. Partition frontmatter into controlled and unknown.
5. `parseTasks` then `parseValidation`, then `planDocumentSchema.parse` of the merged object with
   `digest = digestText(source)` and `spec_digest = ""`.
6. Return with `spec_digest` recomputed by `specDigest(parsed)`.

Duplicate task ids across the whole `## Tasks` block throw
``Invalid plan Markdown: duplicate task id`` (`packages/plan/src/format.ts`).

### 4.2 `renderPlan(document)` — `packages/plan/src/format.ts`

Frontmatter (unknown keys first) → each task's marker line then its present fields in the fixed order
Detail, Exit, Assignee, Result, Error, Reason, splitting a multi-line value into a first line plus
four-space continuations → the five controlled sections then the extras, joined by blank
lines → `assertPlanSourceSize` on the result. The round-trip
`renderPlan(parsePlan(renderPlan(d))) === renderPlan(d)` is pinned at
`packages/plan/tests/unit/plan-format.test.ts`.

### 4.3 `newPlan(input)` — `packages/plan/src/format.ts`

1. `RangeError` above `MAX_PLAN_TASKS` tasks or `MAX_PLAN_VALIDATION_ITEMS` validation items.
2. `id = randomUUID()`, `revision = 1`, `spec_revision = 1`, `created_at = updated_at = now`.
3. Task ids default to `t1, t2, …` by position and status defaults to `pending`.
4. `status = input.review ? "awaiting_approval" : "active"`; `retention` defaults to
   `DEFAULT_PLAN_RETENTION`.
5. Validate, then compute `digest = digestText(renderPlan(parsed))` and `spec_digest`.

### 4.4 Task state machine — `packages/plan/src/transitions.ts`

| State | Event (`to`) | Next | Effect / required detail |
| --- | --- | --- | --- |
| `pending` | `in_progress` | `in_progress` | — |
| `pending` | `done` | `done` | non-blank `result` required |
| `pending` | `abandoned` | `abandoned` | non-blank `reason` required |
| `in_progress` | `returned` | `returned` | — |
| `in_progress` | `done` | `done` | `result` |
| `in_progress` | `failed` | `failed` | non-blank `error` required |
| `in_progress` | `pending` | `pending` | — |
| `returned` | `done` / `failed` / `pending` | as named | `result` / `error` / — |
| `failed` | `pending` / `abandoned` | as named | — / `reason` |
| `done` | *any* | rejected | ``Invalid task transition: done -> <to>`` |
| `abandoned` | *any* | rejected | same |

`assignee` is optional for every target and copied through when present. The function is pure —
it spreads a copy.

`isTaskClosed` is `done`/`abandoned` only; `failed` is deliberately not closed. `canCompletePlan` is `tasks.every(isTaskClosed)` and is vacuously true for a task-less plan. `isPlanSealed` is `status === "completed"` only.

### 4.5 Revision operations — `packages/plan/src/revisions.ts`

`applyPlanRevision` re-parses the operation against the schema, `structuredClone`s the document, then:

| `type` | Effect | `structural` |
| --- | --- | --- |
| `set_title` | replaces `title` | **`false`** |
| `set_objective` | replaces `objective` | `true` |
| `set_context` | replaces `context` | `true` |
| `add_task` | id = `max(numeric ids, 0) + 1`, status `pending`, inserted after `after_task_id` or appended | `true` |
| `edit_task` | `Object.assign` of the partial `{title?,detail?,exit?}` | `true` |
| `remove_task` | splices the task out | `true` |
| `reorder_task` | splices out, refuses `after_task_id === task_id`, re-inserts at head when `null` else after the target | `true` |
| `set_validation` | replaces `validation` | `true` |

An unknown task id throws ``Unknown plan task: <id>``. Self-reorder throws
``A task cannot be ordered after itself``. `edit_task` may only touch `title`/`detail`/`exit`
(`taskContentSchema`, `.partial()`) and must carry at least one key.

`applyPlanRevisions` bounds the batch to `MAX_PLAN_BATCH_OPERATIONS` then folds left,
each operation seeing the previous one's output, ORing `structural`.

### 4.6 `nextRevision(current, changed, {structural, now})` — `packages/plan/src/revisions.ts`

| Field | Result |
| --- | --- |
| `id`, `path` | pinned from `current` |
| `revision` | `current.revision + 1` |
| `spec_revision` | `+1` iff `structural` |
| `approved_spec_revision` | set to `undefined` iff `structural` |
| `status` | forced to `awaiting_approval` iff `structural` **and** `current.approved_spec_revision !== undefined` |
| `updated_at` | `now.toISOString()` |
| `digest`, `spec_digest` | blanked for recomputation |

### 4.7 `createPlanStore` write path — `packages/plan/src/store.ts` (`apply`)

The header comment names the order: *CAS-check, apply, bump, validate, render, persist*
(`packages/plan/src/store.ts`).

1. `require(id)` — `repository.read`, `PlanNotFoundError` on `null`, parse via `documentOf`.
2. Compare all three components of the baseline; on any mismatch call `conflict`, which logs
   `plan.cas.rejected` at **debug** with a `mismatch` array and then throws
   `PlanConflictError("Plan changed since it was read", "cas")`.
3. `mutate(structuredClone(current))`.
4. `nextRevision` with the mutation's `structural` and the injected clock.
5. `planDocumentSchema.parse(next)`.
6. `sealed()` — `renderPlan` plus the two digests its bytes imply.
7. `repository.write` with `expectedDigest: record.digest` — **the digest just read**, not the
   caller's. The caller's baseline is checked in step 2; the repository-level CAS closes
   the read-modify-write window.
8. Return the document with `path` taken from the written record.

Per-method behaviour:

| Method | Notes |
| --- | --- |
| `create` | `newPlan` → `sealed` → `repository.create` with `index.path = planFilename(input.now ?? clock(), input.title)`; the returned `path` is the adapter's allocation. |
| `read` | `require(id).document`. |
| `list` | Parses each record; an unparsable one is reported through `reportUnparsable` and skipped, the rest of the page survives. |
| `update` | `structural` defaults to `false`; a `mutate` returning `undefined` means "the draft was edited in place". **No seal check.** |
| `reconcile` | See below. |
| `revise` | Throws `PlanSealedError(sealedRevisionMessage(id))` inside the mutate callback — i.e. **after** the CAS check — then folds the operations, normalizing a single operation to a one-element array. |
| `delete` | With no baseline, delegates straight to `repository.delete(id)` — no CAS and no status check. With a baseline: read, `documentOf`, three-component check → `conflict`, then `repository.delete(id, record.digest)`. |

`reconcile(id, known, now?)` — `packages/plan/src/store.ts`:

| Condition | Outcome |
| --- | --- |
| `current.digest === known.digest` | return `current` unchanged; **no** new revision |
| digest differs **and** `current.revision !== known.revision` | `PlanConflictError("Plan revision and content changed externally", "cas")` |
| digest differs, revision matches | adopt the stored content as the next revision, `structural` derived from whether `spec_digest` moved |

Pinned end to end at `packages/plan/tests/integration/markdown-plan-store.test.ts`: an external
edit to `## Context` yields `revision + 1` **and** `spec_revision + 1`.

### 4.8 `PlanService` — `packages/plan/src/service.ts`

- `list`/`read` delegate verbatim.
- `setRetention` reads, then `store.update` with the read as baseline — a non-structural write that
  still bumps `revision`.
- `delete` reads first. `InvalidPlanError` → delete without a baseline (a corrupt plan is still
  removable); `PlanNotFoundError` → `{deleted: false}`; `active`/`awaiting_approval` →
  `PlanNotTerminalError`; otherwise `store.delete(id, plan)` under CAS. Three of the four
  branches are pinned at `packages/plan/tests/component/plan-service.test.ts`
  (`PlanNotTerminalError`) (`InvalidPlanError`, delete-without-baseline) (CAS conflict
  on a raced baseline). The `PlanNotFoundError` → `{deleted: false}` branch is **unpinned**:
  only asserts that the underlying store forgets a plan after a successful delete
  (`store.read` rejects `PlanNotFoundError`); no test in that file calls `service.delete` a second time
  against an id already absent.

### 4.9 File adapter

**Every operation validates its locator arguments before touching disk.** `assertPlanLocator(value,
label)` (`packages/plan/src/file-repository.ts`) throws `RangeError("<label> must contain 1-1024 characters")`
whenever a plan id or list cursor is empty or exceeds `MAX_PLAN_LOCATOR_CHARS`, and it gates `create`, `read`, `list`'s cursor, `write` and `delete`.

**Root preparation — `ensureRoot()` (`packages/plan/src/file-repository.ts`), run on every `confined` and every
directory scan.** Two containment checks in a fixed order: a *lexical* `relative(workspaceRoot, root)`
check that rejects an escaping `root` **before anything is created**, then `mkdir`, then
an `lstat` rejecting a symlink or non-directory, then a `realpath` comparison catching an
intermediate symlink, then `chmod 0o700`. Directory creation goes through
`ensureWorkspaceDir` / `ensureWorkspaceSubdir` when the root is inside `.clarvis`, so the workspace
`.gitignore` is seeded by the same act. The "no creation before rejection" half is pinned
at `packages/plan/tests/integration/file-repository.test.ts`
(`await expect(readdir(outsideParent)).resolves.toEqual([])`).

**Path confinement — `confined(name, existing = true)`.** Resolve, reject `..`-shaped or
absolute relatives, require the parent's `realpath` to equal the root's `realpath` — so a plan must be
a *direct child* of its root — and, for an existing target, reject a symlink or
non-regular file.

**Locating by id — `locate(id)`.** Consult the memo; verify the hit by re-reading only the
frontmatter prefix and comparing the extracted `id`; on any failure delete the memo entry and
`rescan()`. `rescan` reads at most `MAX_PLAN_FRONTMATTER_BYTES` per file and, on duplicate
ids, keeps the lexically greatest filename. `locate` **never parses the document**, which is what keeps a hand-corrupted plan addressable for `read` and `delete`.

**Bounded reads — `readBoundedUtf8`.** Opens with `O_RDONLY | O_NOFOLLOW` where available, rejects a non-regular file, refuses an oversized file up front in whole-document mode,
allocates a bounded buffer, and re-`stat`s the descriptor afterwards — a change in
`dev`/`ino`/`size`/`mtimeMs`/`ctimeMs` throws ``Plan document changed while it was being read``.

**Atomic write — `atomicWrite`.** `assertPlanSourceSize` → `O_CREAT|O_EXCL|O_WRONLY` at
`0o600` on `tmpPathFor(path)` → `writeFile` → `handle.sync()` → `close` → `rename` → `chmod 0o600` →
`fsyncDir()`; any failure unlinks the temp file and rethrows. Pinned "no `.tmp` left
behind" at `packages/plan/tests/integration/file-repository.test.ts`.

**Directory fsync — `fsyncDir`.** Swallows an open/sync failure **only** when
`process.platform === "win32"`; everywhere else it propagates. Both branches are pinned
with the platform explicitly redefined rather than assumed
(`packages/plan/tests/integration/file-repository.test.ts`). This `fsyncDir` is a **second,
independent** function of the same name, local to this module — not the one `@clarvis/paths` exports,
which never throws on any platform. The doc comment states the two "disagree on purpose":
a trace record or memory revision can afford to lose its last write to a crash, but "a plan is the
auditable record of what the agent intended and did, and a durability failure there must be reported
rather than swallowed."

**Locking — `withLock(key, operation)`.** Reentrant via an `AsyncLocalStorage` set of held
keys, an in-process promise chain per key, and an on-disk lease via
`acquireLocalLease` with `staleMs = 30_000`, `waitMs = 1000 × 10 = 10_000`, `retryMs = 10`,
`heartbeatMs = 5_000`. A timeout raises
`PlanConflictError("Timed out waiting for plan lock", "locked")`, and `lease.assertOwned()`
is checked before the operation runs. The lock directory `mkdir` is memoized per repository
and the memo is **cleared on failure** so a later attempt retries — pinned at
`packages/plan/tests/integration/file-repository.test.ts`.

**`create`.** Validates id and size, ensures the root, then holds the single `.allocation`
lock so duplicate-id detection and filename allocation are one critical section — pinned
across two independent repository instances at
`packages/plan/tests/integration/file-repository.test.ts`. The suggested locator is reduced to
its last `/` segment, which is why a traversal-shaped `index.path` flattens into the owner's
own root (`packages/plan/tests/integration/file-repository.test.ts`). A name collision is resolved
by appending `-2`, `-3`, …, pinned at
`packages/plan/tests/integration/file-repository.test.ts`.

**`list`.** `limit` is clamped to `[1, 100]`, default 20. Then a loop over
`filenameWindow(before)` — the newest ≤256 filenames strictly below the cursor, kept in descending
order by binary insertion. For each name: read, `toRecord`, warm the locator memo, apply the `status` and `retention` filters, then — **before** admitting the
record — return with a cursor if the page is already full, enforce the aggregate page-byte
budget, push. A cursor is therefore issued only from a position the scan
has just proved carries a **matching** record, never from a bare filename. The outer loop terminates
when a window is empty or short. Directory scanning is capped at `MAX_PLAN_DIRECTORY_ENTRIES` *entries examined*, not
plans, and throws past it — pinned at
`packages/plan/tests/integration/file-repository.test.ts`. The byte-budget check only
fires when `records.length > 0`, so the first candidate of every page is admitted unconditionally: a
page can never come back with zero records because of the byte budget alone. That floor-of-one
guarantee currently relies on `MAX_PLAN_DOCUMENT_BYTES` (8 MiB) staying under `MAX_PLAN_LIST_PAGE_BYTES`
(32 MiB, `packages/plan/src/limits.ts`) — an implicit precondition nothing in the code asserts.

**`write`.** Locate first (outside the lock), `PlanNotFoundError` if absent, then under the
plan's own lock re-read the file and compare `digestText(source)` to `expectedDigest`, raising
`PlanConflictError(…, "cas")` on mismatch, then `atomicWrite`.

**`delete`.** Same shape; `ENOENT` anywhere inside the lock resolves to `false` rather than
throwing. The baseline is checked **inside** the lock, so a concurrent writer that finished
first turns a stale delete into a `PlanConflictError` — pinned by a rename-interception test at
`packages/plan/tests/integration/file-repository.test.ts`.

### 4.10 Conformance tables

`planRepositoryConformance()` (18 cases, `packages/plan/src/testing.ts`, `planRepositoryConformance`) is driven against **file** and
**in-memory** backends by `packages/plan/tests/contract/repository.test.ts`.
`planStoreConformance()` (10 cases, `packages/plan/src/testing.ts`, `planStoreConformance`) is driven against **executable**, **Markdown**
(file) and **in-memory** backends by `packages/plan/tests/contract/plan-store.test.ts`. Cases
needing an out-of-band edit return early when the harness supplies no `poke` (`packages/plan/src/testing.ts`).

| Repository case | File |
| --- | --- |
| creates a plan and reads it back by id | `packages/plan/src/testing.ts` |
| reports an unknown id as null | `packages/plan/src/testing.ts` |
| reports a locator for every stored plan | `packages/plan/src/testing.ts` |
| allocates a distinct locator for same-titled plans | `packages/plan/src/testing.ts` |
| rejects creating a plan whose id already exists | `packages/plan/src/testing.ts` |
| writes under compare-and-swap and moves the digest forward | `packages/plan/src/testing.ts` |
| rejects a write whose expected digest is stale | `packages/plan/src/testing.ts` |
| lets exactly one of two racing writers win | `packages/plan/src/testing.ts` |
| rejects a write to an unknown id | `packages/plan/src/testing.ts` |
| deletes idempotently and honours an expected digest | `packages/plan/src/testing.ts` |
| lists newest first and pages with a stable cursor | `packages/plan/src/testing.ts` |
| rejects a cursor another backend minted | `packages/plan/src/testing.ts` |
| still pages when the plan a cursor names was deleted | `packages/plan/src/testing.ts` |
| filters before paging, so a filtered page is never short early | `packages/plan/src/testing.ts` |
| filters by status | `packages/plan/src/testing.ts` |
| surfaces a hand edit as a new digest without losing the plan | `packages/plan/src/testing.ts` |
| reports an unparseable plan rather than destroying it | `packages/plan/src/testing.ts` |
| skips an unparseable plan instead of failing the whole listing | `packages/plan/src/testing.ts` |

| Store case | File |
| --- | --- |
| creates, reads, lists and deletes by stable id without requiring a path | `packages/plan/src/testing.ts` |
| reports an unknown id as a typed not-found error | `packages/plan/src/testing.ts` |
| enforces compare-and-swap on update | `packages/plan/src/testing.ts` |
| invalidates approval only for structural revisions | `packages/plan/src/testing.ts` |
| reconciles an unchanged baseline without inventing a revision | `packages/plan/src/testing.ts` |
| applies a revision batch atomically under one structural revision | `packages/plan/src/testing.ts` |
| filters before paging and returns a stable cursor | `packages/plan/src/testing.ts` |
| rejects a cursor another store minted | `packages/plan/src/testing.ts` |
| still pages when the plan a cursor names was deleted | `packages/plan/src/testing.ts` |
| seals a completed plan against later revision | `packages/plan/src/testing.ts` |

## 5. Invariants

Numbered from the catalog this document owns (INV-146…INV-164), restated in this subsystem's terms, plus
further ones derived directly from the code.

| # | Rule | Production | Pinned by |
| --- | --- | --- | --- |
| **INV-146** | `allowedTaskTransitions("pending")` is exactly `["in_progress","done","abandoned"]`, and moving a task to `done` without a non-blank `result` throws a message containing "requires result". | `packages/plan/src/transitions.ts` | `packages/plan/tests/unit/plan-policy.test.ts` |
| **INV-147** | `add_task` allocates the monotonically-next id (`t4` when `t1`/`t3` exist), and `reorder_task` refuses to place a task after itself ("after itself"). | `packages/plan/src/revisions.ts` | `packages/plan/tests/unit/plan-policy.test.ts` |
| **INV-148** | Only `status: "completed"` seals a plan; `cancelled`, `failed`, `active` and `awaiting_approval` are all unsealed. | `packages/plan/src/transitions.ts` | `packages/plan/tests/unit/plan-policy.test.ts` |
| **INV-149** | `failed` is **not** a closed task status, and its only outgoing transitions are `pending` and `abandoned`. | `packages/plan/src/transitions.ts` | `packages/plan/tests/unit/plan-policy.test.ts` |
| **INV-150** | `applyPlanRevisions` folds in order, so a later operation may act on an id an earlier one created or moved; `structural` is `true` iff **any** operation in the batch is structural. | `packages/plan/src/revisions.ts` | `packages/plan/tests/unit/plan-policy.test.ts` |
| **INV-151** | The `revise_plan` wire schema normalizes either the singular `operation` or the plural `operations`, and refuses a request carrying **both** or **neither**. | `packages/plan/src/tools.ts` | `packages/plan/tests/unit/plan-policy.test.ts` |
| **INV-152** | `newPlan` refuses more than `MAX_PLAN_TASKS` tasks and `applyPlanRevisions` refuses more than `MAX_PLAN_BATCH_OPERATIONS` operations; both `RangeError`s name the limit. | `packages/plan/src/format.ts`, `packages/plan/src/revisions.ts` | `packages/plan/tests/unit/plan-policy.test.ts` |
| **INV-153** | `repository.create` rejects an id that already exists with `PlanConflictError` (`code === "plan_conflict"`). | `packages/plan/src/file-repository.ts`, `packages/plan/src/testing.ts` | `packages/plan/src/testing.ts` (both backends via `packages/plan/tests/contract/repository.test.ts`) |
| **INV-154** | `repository.write` is compare-and-swap: a correct expected digest moves the digest forward; a stale one rejects with `PlanConflictError` `reason === "cas"`; two writers racing on the same expected digest yield exactly one success. | `packages/plan/src/file-repository.ts`, `packages/plan/src/testing.ts` | `packages/plan/src/testing.ts` |
| **INV-155** | `repository.write` against an id the backend has never seen rejects with `PlanNotFoundError` (`plan_not_found`). | `packages/plan/src/file-repository.ts`, `packages/plan/src/testing.ts` | `packages/plan/src/testing.ts` |
| **INV-156** | `repository.delete` is idempotent and CAS-checked: a stale expected digest rejects; the correct digest deletes and returns `true`; a second delete returns `false` and the plan is then unreadable. | `packages/plan/src/file-repository.ts`, `packages/plan/src/testing.ts` | `packages/plan/src/testing.ts` |
| **INV-157** | `repository.list` returns newest-created-first, pages with a cursor stable across calls, and applies filters **before** paging so a filtered page is never short early. | `packages/plan/src/file-repository.ts`, `packages/plan/src/testing.ts` | `packages/plan/src/testing.ts` |
| **INV-158** | A hand edit outside the repository is re-read as a new digest without losing content; an unparseable body is reported as `InvalidPlanError` (`plan_invalid`) and never overwritten or deleted as a side effect; a listing skips it rather than failing. | `packages/plan/src/file-repository.ts`; `packages/plan/src/store.ts` | `packages/plan/src/testing.ts` |
| **INV-159** | `store.update` enforces compare-and-swap: a correct baseline bumps `revision` by exactly 1; the same baseline presented again rejects with `PlanConflictError`. | `packages/plan/src/store.ts`, `packages/plan/src/revisions.ts` | `packages/plan/src/testing.ts` |
| **INV-160** | `approved_spec_revision` is invalidated **only** by a structural revision: `set_title` leaves it and `spec_revision` untouched; `edit_task` clears it, bumps `spec_revision` and returns the plan to `awaiting_approval`; a plan created with `review: false` never enters that state. | `packages/plan/src/revisions.ts` | `packages/plan/src/testing.ts` |
| **INV-161** | `store.reconcile` against an already-current baseline invents no revision — `revision` and `digest` come back unchanged. | `packages/plan/src/store.ts` | `packages/plan/src/testing.ts` |
| **INV-162** | A batch applies atomically under **one** `revision` and at most one `spec_revision`; a batch containing a bad reference is rejected whole and leaves the plan's prior objective and revision intact. | `packages/plan/src/store.ts`, `packages/plan/src/revisions.ts` | `packages/plan/src/testing.ts` |
| **INV-163** | `store.list` also filters before paging and returns a stable cursor. | `packages/plan/src/store.ts` (delegating to the repository) | `packages/plan/src/testing.ts` |
| **INV-164** | `store.revise` on a plan whose status is `completed` throws `PlanSealedError`. | `packages/plan/src/store.ts` | `packages/plan/src/testing.ts` |

Further invariants derived here:

| # | Rule | Production | Pinned by |
| --- | --- | --- | --- |
| **P-01** | `renderPlan ∘ parsePlan` is a fixpoint on rendered bytes, and unknown frontmatter keys plus extra `##` sections survive it verbatim. | `packages/plan/src/format.ts` | `packages/plan/tests/unit/plan-format.test.ts` |
| **P-02** | A `##`-shaped line inside a prose section is body text, and a multi-line task field round-trips through indented continuations. | `packages/plan/src/format.ts` | `packages/plan/tests/unit/plan-format.test.ts` |
| **P-03** | `planFilename` is Windows-safe: no `:` survives, and the slug is `[a-z0-9-]` only. | `packages/plan/src/format.ts` | `packages/plan/tests/unit/plan-format.test.ts` |
| **P-04** | A blank or multi-line task title, and a multi-line validation item, are rejected at the schema boundary rather than producing an unparseable document. | `packages/plan/src/schemas.ts` | `packages/plan/tests/unit/plan-format.test.ts` |
| **P-05** | `spec_digest` excludes task status and outcome fields, so recording progress never changes it. | `packages/plan/src/format.ts` | `packages/plan/tests/unit/plan-canonical-state.test.ts` |
| **P-06** | The plans root is created `0o700` and each plan file `0o600`; an owner-scoped root's intermediate directories are created `0o700` too, via `ensureWorkspaceSubdir` → `ensureDir`'s `mkdirSync(..., { recursive: true, mode: DIR_MODE })`. | `packages/plan/src/file-repository.ts`; `packages/paths/src/ensure.ts`; `DIR_MODE = 0o700` at `packages/paths/src/constants.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-07** | A `root` that escapes the workspace is refused, and refused **before** the directory is created. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-08** | A plans root reached through a directory symlink is refused. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-09** | Two owner-scoped roots over one workspace are mutually invisible: neither lists nor reads the other's plans. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-10** | A traversal-shaped `index.path` is flattened to its last segment inside the caller's own root. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-11** | Duplicate-id detection and filename allocation happen under one `.allocation` lock, so two repository instances creating the same id yield one success and one `PlanConflictError`. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-12** | A crashed writer's lockfile is reclaimed once it is stale, so an abandoned write cannot wedge the plan. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-13** | 24 independent stores creating concurrently over one workspace all succeed, with distinct ids and distinct filenames. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/markdown-plan-store.test.ts` |
| **P-14** | An oversized plan is discovered from its frontmatter prefix alone — no read exceeds `MAX_PLAN_FRONTMATTER_BYTES` for `read` (which raises `InvalidPlanError`) or for `delete`. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-15** | An oversized source is rejected before any plan file exists on disk. | `packages/plan/src/file-repository.ts`, `packages/plan/src/limits.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-16** | A non-Markdown file in the plans root is ignored by listing. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-17** | A cold repository (empty locator memo) still finds a plan by id and reports the same locator. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-18** | A directory-sync failure is swallowed on win32 and propagated everywhere else, with the platform pinned in both directions rather than assumed. | `packages/plan/src/file-repository.ts` | `packages/plan/tests/integration/file-repository.test.ts` |
| **P-19** | An external edit whose substance changed is adopted as `revision + 1` **and** `spec_revision + 1`. | `packages/plan/src/store.ts` | `packages/plan/tests/integration/markdown-plan-store.test.ts` |
| **P-20** | `plan.cas.rejected` is logged at **debug** and names which of `revision`/`digest`/`spec_digest` disagreed, including a `spec_digest`-only mismatch a revision number alone cannot show; it stays silent when the baseline matched. | `packages/plan/src/store.ts` | `packages/plan/tests/component/plan-observability.test.ts` |
| **P-21** | `plan.document.unparsable` is logged at **warn** with `layer` of `store` \| `list` \| `rescan`, a **basename-only** `path`, and a reason that is single-line and ≤500 chars. | `packages/plan/src/store.ts`, `packages/plan/src/file-repository.ts`, `packages/plan/src/log.ts` | `packages/plan/tests/component/plan-observability.test.ts`; `packages/plan/tests/integration/file-repository-observability.test.ts` |
| **P-22** | A plan document's own prose never reaches a log record: a `YAMLParseError`'s quoted excerpt is collapsed, redacted and capped. | `packages/plan/src/log.ts` | `packages/plan/tests/unit/plan-log-reason.test.ts` |
| **P-23** | `PlanService.delete` refuses `active` and `awaiting_approval`, deletes a corrupt plan anyway, and passes the status-bearing read as its CAS baseline so a concurrent write turns the deletion into a `PlanConflictError`. | `packages/plan/src/service.ts` | `packages/plan/tests/component/plan-service.test.ts` |
| **P-24** | `store.delete` **without** a baseline performs no CAS and no status check — it delegates straight to the repository. | `packages/plan/src/store.ts` | unpinned (exercised incidentally at `packages/plan/src/testing.ts`) |
| **P-25** | `store.update` performs **no** seal check, so a sealed plan's `status`/`retention`/task outcomes remain mutable through it while `revise` is refused. | `packages/plan/src/store.ts` | indirectly, `packages/plan/src/testing.ts` (the conformance case reaches `completed` via `update`) |
| **P-26** | A stale baseline on a sealed plan yields `PlanConflictError`, not `PlanSealedError`, because the CAS check runs before the mutate callback. | `packages/plan/src/store.ts` then | unpinned |
| **P-27** | A concurrently-changing file is detected by a pre/post descriptor stat and reported rather than returning a mixture of two revisions. | `packages/plan/src/file-repository.ts` | unpinned |

## 6. Failure modes and degradation

| Condition | Behaviour | Handler |
| --- | --- | --- |
| Missing/non-mapping YAML frontmatter | `Error` from `splitDocument`; wrapped to `InvalidPlanError` by every caller that stores | `packages/plan/src/format.ts`; wrapped at `packages/plan/src/store.ts`, `packages/plan/src/file-repository.ts`, `packages/plan/src/testing.ts` |
| Missing required `##` section | `Error("Invalid plan Markdown: missing ## <name>")` → `InvalidPlanError` | `packages/plan/src/format.ts` |
| Unparseable task or validation line, duplicate task id | `Error` → `InvalidPlanError` | `packages/plan/src/format.ts` |
| Frontmatter present but body corrupt | Plan stays **addressable** (locating never parses), so `read` reports `InvalidPlanError` and `delete` still works | `packages/plan/src/file-repository.ts`; `packages/plan/src/repository.ts` |
| Frontmatter destroyed (id unrecoverable) | Plan is reported as **absent** — `locate` returns `null`, `read` returns `null` | `packages/plan/src/file-repository.ts` |
| One unparseable file in a listing | Skipped, logged `plan.document.unparsable`, rest of page returned | `packages/plan/src/file-repository.ts`; `packages/plan/src/store.ts` |
| One unreadable file during a locator rescan | Skipped, logged with `layer: "rescan"` | `packages/plan/src/file-repository.ts` |
| Document over 8 MiB | `RangeError` from `assertPlanSourceSize`, or `InvalidPlanError` when it came off disk | `packages/plan/src/limits.ts`; `packages/plan/src/file-repository.ts` |
| Plan id or list cursor outside 1..`MAX_PLAN_LOCATOR_CHARS` chars | `RangeError` from `assertPlanLocator`, unpinned by any test | `packages/plan/src/file-repository.ts` |
| Directory over 10 000 entries | `RangeError` naming the limit — a **hard** failure, not a truncation | `packages/plan/src/file-repository.ts` |
| Aggregate page over 32 MiB | Short page with a `next_cursor`; caller continues exactly as after a count-limited page | `packages/plan/src/file-repository.ts`; documented at `packages/plan/src/repository.ts` |
| Baseline stale | `PlanConflictError(…, "cas")`, logged at debug with the mismatching components; **the plan is unchanged** | `packages/plan/src/store.ts` |
| External writer moved both revision and content | `PlanConflictError("Plan revision and content changed externally", "cas")` — `reconcile` refuses to guess | `packages/plan/src/store.ts` |
| Lock unobtainable within 10 s | `PlanConflictError("Timed out waiting for plan lock", "locked")` | `packages/plan/src/file-repository.ts` |
| Lock held by a dead writer | Reclaimed after `LOCK_STALE_MS` (30 s) via `acquireLocalLease`'s liveness check | `packages/plan/src/file-repository.ts` |
| Lock-directory `mkdir` fails transiently | Memo cleared and rethrown, so the next attempt retries instead of wedging the queue | `packages/plan/src/file-repository.ts` |
| Directory fsync fails | Swallowed on win32; propagated (write fails) elsewhere | `packages/plan/src/file-repository.ts` |
| Any failure during `atomicWrite` | Temp file unlinked best-effort, error rethrown | `packages/plan/src/file-repository.ts` |
| `ENOENT` during `delete` | Resolves to `false` rather than throwing | `packages/plan/src/file-repository.ts` |
| Plan file removed/replaced by a non-regular file between `write`'s `locate()` call and its lock acquisition | `write()` wraps no try/catch around its own `confined()` call, so any failure there — including a plain `ENOENT` — propagates as a raw, untyped `Error`, never `PlanNotFoundError`/`PlanConflictError` | `packages/plan/src/file-repository.ts`; `confined()` |
| Plan file replaced by a non-regular file/symlink (not merely removed) between `delete`'s `locate()` call and its lock acquisition | `delete()`'s catch only recognizes an `ENOENT`-coded error (a plain removal, which resolves to `false` as above); `confined()`'s `Error("Plan path is not a regular file")` carries no such code and rethrows raw | `packages/plan/src/file-repository.ts`; `confined()`'s regular-file check |
| Mutation produces a schema-invalid document | `ZodError` from `planDocumentSchema.parse` **before** rendering or persisting | `packages/plan/src/store.ts` |
| Sealed plan revised | `PlanSealedError` carrying `sealedRevisionMessage(id)`, which names `create_plan` and `transition_plan_task` as the way forward | `packages/plan/src/store.ts`, `packages/plan/src/transitions.ts` |
| Live plan deleted through the control plane | `PlanNotTerminalError` | `packages/plan/src/service.ts` |
| Corrupt plan deleted through the control plane | Deleted anyway, without a baseline | `packages/plan/src/service.ts` |

Retries exist in exactly one place: the lockfile wait loop (`acquireLocalLease` with 1000 attempts at
10 ms, `packages/plan/src/file-repository.ts`). Nothing else retries — a CAS conflict is returned to
the caller to re-read and re-decide.

## 7. Coupling

**Depends on (runtime, static):**

| Target | Why forced | File |
| --- | --- | --- |
| `zod` | every schema and the `superRefine` text cap | `packages/plan/src/schemas.ts`, `packages/plan/src/revisions.ts` |
| `yaml` | frontmatter parse/stringify | `packages/plan/src/format.ts` |
| `node:crypto` | `createHash` for digests, `randomUUID` for plan ids | `packages/plan/src/format.ts` |
| `node:fs/promises`, `node:path`, `node:async_hooks`, `node:fs` | the file adapter only | `packages/plan/src/file-repository.ts` |
| `@clarvis/capability` | `Logger` / `NOOP_LOGGER` in the store and adapter; `sanitizeErrorMessage` in `log.ts` | `packages/plan/src/store.ts`, `packages/plan/src/file-repository.ts`, `packages/plan/src/log.ts` |
| `@clarvis/paths` | `workspacePaths().plansRoot`, `workspaceStatePaths().plansLockDir`, `ensureWorkspaceDir`/`ensureWorkspaceSubdir`, `tmpPathFor`, `acquireLocalLease` | `packages/plan/src/file-repository.ts` |

The manifest declares exactly those four external/internal dependencies
(`packages/plan/package.json`) — no `@clarvis/loop`, `@clarvis/kernel`, `@clarvis/protocol`.

**Direction is forced by:** `format.ts` imports `PlanIndex` from `repository.ts` **type-only**
(`packages/plan/src/format.ts`), while `store.ts` imports `format.ts` and `repository.ts` as values (`packages/plan/src/store.ts`)
— so the aggregate sits above both, and the port below knows nothing of revisions. `file-repository.ts`
imports `format.ts` for `digestText`/`parsePlan`/`projectPlan` but nothing from `store.ts`,
which is what makes the adapter substitutable. `store.ts` never imports `service.ts`; `service.ts`
imports `store.ts` type-only plus the two error classes as values (`packages/plan/src/service.ts`).

**Depended on by:**

| Consumer | Edge | File |
| --- | --- | --- |
| `@clarvis/kernel` — `owner-scoped-file-stores.ts` | value import of `createFilePlanRepository` + `createPlanStore`; supplies `root` and `lockDir` per owner | `packages/kernel/src/owner-scoped-file-stores.ts` |
| `@clarvis/kernel` — `file-kernel.ts`, `plans/plans-service.ts`, `plans/planning-runtime.ts` | value imports from `@clarvis/plan` and `@clarvis/plan/capability` | `packages/kernel/src/file-kernel.ts`, `packages/kernel/src/plans/plans-service.ts`, `packages/kernel/src/plans/planning-runtime.ts` |
| `@clarvis/kernel` — `runs/plan-ref.ts` | `PLANS_CAPABILITY_NAME` | `packages/kernel/src/runs/plan-ref.ts` |
| `@clarvis/kernel` — `config/capability-registry.ts`, `runs/settings-assembler.ts` | `@clarvis/plan/settings` | `packages/kernel/src/config/capability-registry.ts`, `packages/kernel/src/runs/settings-assembler.ts` |
| `@clarvis/paths` | comment-only; owns `plansLockDir` on behalf of this package | `packages/paths/src/workspace-state.ts` |
| `@clarvis/protocol` | comment-only; `PlanDocumentDto` is described as the wire projection of this package | `packages/protocol/src/plans.ts` |

No package outside `@clarvis/kernel` imports `@clarvis/plan` values
(`rg "@clarvis/plan" packages/*/src` returns only the rows above).

**Test-only coupling:** `packages/plan/tests/contract/plan-store.test.ts` drives the store
conformance table against the *executable* provider harness as well as the two built-ins — so a change
to `planStoreConformance()` also constrains `src/provider.ts` (that provider is
**capability-provider-executables**'s scope).

## 8. Open questions

- **Rationale.** Almost none of the *why* is recoverable from the source. Where a reason is stated in
  the code it is prose in a TSDoc comment, not behaviour, and only the machine-checkable parts are
  quoted. Specifically the source does not establish: why `spec_digest` covers exactly
  `{objective, context, tasks[id,title,detail,exit], validation}` and not, say, `title`; why
  `MAX_PLAN_TASKS` is 256; why `LOCK_ATTEMPTS` is 1000 rather than any other number beyond the
  comment's assertion that 200 was exhausted by 24 concurrent writers on a Windows runner
  (`packages/plan/src/file-repository.ts`).
- ~~**Apparently unreachable branch.**~~ **Resolved and removed.** In `file-repository.list`, the
  byte-budget return used to emit `next_cursor` only when its captured cursor was defined. Reaching
  that return requires `records.length > 0`, and the cursor is `undefined` only at index 0 of the
  first window, where `records.length` is still 0 — so the `undefined` arm was unreachable. It now
  asserts the invariant instead of branching on it, with the reasoning on the local's own
  TSDoc.
- ~~**Misfiled as an ambiguity — this is a bounded, non-corrupting defect in `hasMore`.**~~
  **Resolved: the look-ahead is now the filtered one.** The two unfiltered probes are gone —
  `hasMoreInWindow` and the one-entry `filenameWindow(before, 1)` scan both treated a bare *filename*
  as evidence of "more", though a filename carries neither `status` nor `retention` (they live in the
  frontmatter, unread at that point), so a `next_cursor` could be attached to a page whose one
  remaining file fails the filter on the very next call. The limit check moved **above** the push
  (`packages/plan/src/file-repository.ts`): the scan continues past a full page and returns a
  cursor at the first record that both matches the filters and does not fit, so the cursor is only
  ever issued from a position proven to carry a matching record. When no such record remains, the
  loop reaches its ordinary exhaustion branches and returns with no cursor at all.
  `filenameWindow`'s `windowSize` parameter went with the probe — nothing passed it a non-default
  value any more, and an unreachable parameter is the same "signature promising more than the
  implementation does" the two entries above were about. The cost is real and was accepted: with no
  filters the scan now parses one extra plan where it used to list one extra filename, and an
  adversarial run of filtered-out files at the tail is walked rather than guessed at. That walk is
  the only correct answer to the question — it is what "is there a next page" means once a filter
  exists. Pinned in both directions, full page and partial, at
  `packages/plan/tests/integration/file-repository.test.ts`; the conformance case
  (`packages/plan/src/testing.ts`) still asserts only that the *current* page is not short.
- ~~**Genuinely ambiguous, sharpened: a cursor from one adapter fed into another does not error — it
  silently produces a wrong page.**~~ **Resolved.** The diagnosis held exactly as written:
  `assertPlanLocator` checked only length, so an in-memory record id passed it and was then compared
  lexically against filenames — a deterministic but meaningless partition point — while the reverse
  direction resolved an unrecognised cursor through `findIndex(...) + 1`, which is `0`, silently
  restarting the page. The entry's own reason for leaving it open was that no caller swaps adapters
  under a live cursor, and that is still true of the two it named. It is **not** true of the pair it
  did not consider: `createInMemoryPlanRepository` is exported only from `@clarvis/plan/testing`, so
  file-versus-memory really is unreachable, but file-versus-**provider** is reachable in production
  across a `PlanFactory` settings change. That is what settled it.

  Every cursor now carries the tag of the dialect that minted it (§3.6), so a foreign one raises
  `PlanCursorError` naming the two dialects — and never echoing the payload, which can be a filename.
  The rejection is driven from the conformance harness rather than a per-adapter test, so a backend
  added later is covered without touching the case. Two of the fix's details are worth keeping: the
  error extends `RangeError`, because `assertPlanLocator` already threw `RangeError` on this exact
  argument and any existing handler keeps working while the distinct `name` still discriminates; and
  it is registered in `EXPECTED_PLAN_TOOL_ERRORS` and mapped to `invalid_request` at the kernel
  boundary, because a stale cursor is an ordinary model or caller mistake and had otherwise logged at
  ERROR with a stack, and reached a protocol client as an internal Clarvis defect.

  What was deliberately **not** done: making a correctly tagged cursor whose plan has since been
  deleted an error. That is a race rather than a dialect defect, the two adapters answer it
  differently on purpose, and §3.6 records the divergence.

- **Resolved: `limit` clamping is the adapter's job, and `PlanRecordQuery.limit`'s JSDoc ("clamped to
  1–100 **by the caller**", `packages/plan/src/repository.ts`) is simply wrong about who does it.**
  Tracing every call site between a `.list()` caller and `PlanRepositoryTx.list` in this repository —
  `PlanStore.list` (`packages/plan/src/store.ts`, forwards `input` unchanged),
  `PlanService.list` (`packages/plan/src/service.ts`, forwards `input` unchanged), and the kernel's
  `plans.list` operation (`OPERATIONS.plans.list` in `packages/kernel/src/transport/operations.ts`, forwards `p.input`
  unchanged) — none of them clamps, bounds, or even reads `limit` before handing the query on. The
  clamp exists in exactly one place per adapter, inside the adapter itself, and both known adapters
  implement it identically: `Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT))` with
  `MAX_LIMIT = 100`/`DEFAULT_LIMIT = 20` in the file adapter (`packages/plan/src/file-repository.ts`) and the literal equivalent `Math.min(100, Math.max(1, query.limit ?? 20))` in the in-memory
  adapter (`packages/plan/src/testing.ts`). With no caller anywhere in the call graph performing
  this clamp, "by the caller" cannot describe the codebase's actual behavior — the normative reading
  for a third adapter is that **the adapter clamps**, matching what both existing implementations
  independently do with the same bounds and the same default. This closes the first half of the retired gap
  report's cursor item; the JSDoc itself lives in `@clarvis/plan`'s
  source and is out of this corpus's authority to edit, so the correction stands here rather than
  there.
- **Unpinned surface.** `specDigest` and `projectPlan` have no direct unit test (only transitive
  coverage, e.g. `packages/plan/tests/unit/plan-canonical-state.test.ts`). `planFilename`'s 48-character slug
  truncation and its `"plan"` empty-slug fallback (`packages/plan/src/format.ts`) are unpinned. The `PlanRef`
  interface (`packages/plan/src/schemas.ts`) has no consumer inside this package — it is filed by the capability, so
  its contract belongs to **plan-capability-and-review**. P-24, P-26 and P-27 above are likewise
  unpinned.
- **`created_at` typing across the YAML boundary.** `planDocumentSchema` requires
  `z.string().datetime()` (`packages/plan/src/schemas.ts`) while `renderPlan` emits the timestamp unquoted
  (`packages/plan/src/format.ts`); the round-trip demonstrably works (`packages/plan/tests/unit/plan-format.test.ts`), but it is
  unverified against the `yaml` package's own source that its default schema never coerces a
  timestamp scalar to a `Date`. A YAML dialect change here would break parsing silently at the schema.
- **Windows.** `@clarvis/plan` is one of the packages the Windows CI job runs
  (`packages/plan/tests/integration/file-repository.test.ts` probe rather than assume the
  platform), but whether the `O_NOFOLLOW`-absent path
  (`packages/plan/src/file-repository.ts`) or the junction-based root-escape check behave as the tests expect
  there is unconfirmed.
- **Delegated by scope.** How a run creates, reads, revises and finalizes a plan
  (`src/capability/**`, `src/tools.ts` beyond `revisePlanInputSchema`), the review gate, the seal rule
  for *task transitions* (`sealedTransitionMessage`, used only at
  `packages/plan/src/capability/session.ts`), and retention as run policy → **plan-capability-and-review**.
  `src/provider.ts`, `src/provider-config.ts`, `src/settings.ts` and
  `tests/architecture/settings-provider-boundary.test.ts` (INV-145) →
  **capability-provider-executables**.
