/**
 * PlansService - the plan documents a UI reads back and manages over the wire.
 *
 * The wire projection of `@clarvis/plan`: a {@link PlanDocumentDto} is the parsed
 * plan carried to a client, and {@link PlansService} is the control-plane surface
 * (list / read / retention / delete) the kernel wraps over the plan store. The
 * backing data lives server-side; a client reaches it only through this service,
 * never the local filesystem, so a hosted kernel needs no client change.
 */

/**
 * Lifecycle status of a whole plan.
 *
 * `awaiting_approval` is the initial status in review mode; `active` is the
 * working status; `completed`, `cancelled`, and `failed` are the terminal
 * statuses a run's finalization records. Only `completed`/`cancelled`/`failed`
 * plans may be deleted (see {@link PlansService.delete}).
 */
export type PlanStatus = "awaiting_approval" | "active" | "completed" | "cancelled" | "failed";

/**
 * What happens to the plan record when its run reaches a successful terminal state:
 * `keep` (the default) leaves it in provider history, `discard` deletes it.
 * A crash or cancellation never deletes.
 */
export type PlanRetention = "discard" | "keep";

/**
 * Status of a single task.
 *
 * @remarks
 * `returned` is a sub-agent's hand-back that still awaits the lead's judgment - it
 * is not a closed state. Only `done` and `abandoned` close a task. `done`,
 * `failed`, and `abandoned` each require a matching outcome field on
 * {@link PlanTaskDto} (`result` / `error` / `reason`).
 */
export type PlanTaskStatus =
  "pending" | "in_progress" | "returned" | "done" | "abandoned" | "failed";

/**
 * One task in a plan, as carried to a client.
 *
 * @remarks
 * Tasks are a flat ordered list (no phases). `result`, `error`, and `reason` are
 * the outcome fields recorded when the task reaches `done`, `failed`, and
 * `abandoned` respectively.
 */
export interface PlanTaskDto {
  /** Stable task id for the life of the plan: `t` followed by a positive integer (`t1`, `t2`, ...). */
  id: string;
  /** Single-line task title (rendered onto the `- [x] (t1) <title>` marker line). */
  title: string;
  status: PlanTaskStatus;
  /** Free-form, possibly multi-line description of the task. */
  detail?: string;
  /** Free-form exit criteria - what "done" means for this task. */
  exit?: string;
  /** Name of the sub-agent or lead the task is assigned to. */
  assignee?: string;
  /** Outcome text recorded when the task reaches `done`. */
  result?: string;
  /** Outcome text recorded when the task reaches `failed`. */
  error?: string;
  /** Outcome text recorded when the task reaches `abandoned`. */
  reason?: string;
}

/**
 * The full parsed plan carried to a client - the wire projection of the domain
 * `PlanDocument`.
 *
 * @remarks
 * `revision` counts every write; `spec_revision` counts only changes to the plan's
 * substance (objective/context/tasks/validation), so recording task progress never
 * invalidates a human approval bound to `approved_spec_revision`. The parsed
 * sections (`objective`, `tasks`, ...) and the verbatim `markdown` are both
 * present: the parsed fields drive the UI, `markdown` is the exact document text.
 */
export interface PlanDocumentDto {
  /**
   * Optional backend locator. **Opaque to the client and presentational only** —
   * every operation addresses the plan by {@link PlanDocumentDto.id}.
   */
  path?: string;
  /** The plan's stable identity. */
  id: string;
  title: string;
  status: PlanStatus;
  retention: PlanRetention;
  /** Monotonic count of every provider write. */
  revision: number;
  /** Count of substance-only changes; what an approval binds to. */
  spec_revision: number;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 last-write timestamp. */
  updated_at: string;
  /** Id of the run that created the plan. */
  created_by_run: string;
  /** The {@link spec_revision} a human approved, when the plan has been approved. */
  approved_spec_revision?: number;
  objective: string;
  context: string;
  /** The flat ordered task list. */
  tasks: PlanTaskDto[];
  /** Validation checklist items, one single-line entry each. */
  validation: string[];
  notes: string;
  /** Canonical Markdown: authoritative bytes for Markdown, a read-only projection for other providers. */
  markdown: string;
}

/** Paging and filter options for {@link PlansService.list}. */
export interface PlanListInput {
  /** Opaque cursor from a prior {@link PlanListResult.next_cursor}. */
  cursor?: string;
  /** Max plans to return in the page. */
  limit?: number;
  /** Restrict to plans in this lifecycle status. */
  status?: PlanStatus;
  /** Restrict to plans with this retention policy. */
  retention?: PlanRetention;
}

/** One page of {@link PlansService.list}, newest first. */
export interface PlanListResult {
  plans: PlanDocumentDto[];
  /** Cursor to pass back for the next page; absent when none remain. */
  next_cursor?: string;
}

/**
 * The control-plane surface over the plan store the kernel exposes to clients:
 * list, read, retention changes, and deletion.
 */
export interface PlansService {
  /**
   * List plans, newest first, with optional cursor paging and status/retention
   * filters.
   *
   * @param input - paging and filter options; see {@link PlanListInput}.
   * @returns the matching plans and a `next_cursor` when more remain.
   */
  list(input?: PlanListInput): Promise<PlanListResult>;

  /**
   * Read a single plan by its stable id.
   *
   * @param id - the plan's id.
   * @returns the parsed plan.
   */
  read(id: string): Promise<PlanDocumentDto>;

  /**
   * Change a plan's retention policy.
   *
   * @param id - the plan's id.
   * @param retention - the new retention policy.
   * @returns the updated plan (a new {@link PlanDocumentDto.revision | revision}).
   */
  setRetention(id: string, retention: PlanRetention): Promise<PlanDocumentDto>;

  /**
   * Delete a plan.
   *
   * @param id - the plan's id.
   * @returns the id and whether a plan was actually removed (`false` if it was
   *   already gone).
   * @throws when the plan is still live (`active` or `awaiting_approval`); only
   *   terminal plans may be deleted.
   */
  delete(id: string): Promise<{ id: string; deleted: boolean }>;
}

/**
 * A pointer from a finished run's record to the plan it drove.
 *
 * Plan documents are deliberately not in the run trace; the record carries this
 * ref instead, naming its provider and id (plus final CAS counters and disposition) so a
 * client reads the document back through {@link PlansService}.
 */
export interface PlanRef {
  /** The plan's stable identity — how it is addressed through {@link PlansService}. */
  id: string;
  /** Stable identity of the provider that owns this plan id. */
  provider_key: string;
  /** Optional backend locator; opaque to the client and presentational only. */
  path?: string;
  /** {@link PlanDocumentDto.revision} at the run's end. */
  final_revision: number;
  /** {@link PlanDocumentDto.spec_revision} at the run's end. */
  final_spec_revision: number;
  /** The plan's terminal status when the run finished. */
  status: PlanStatus;
  /** The retention policy in effect at teardown (governs whether the record survives). */
  retention: PlanRetention;
}
