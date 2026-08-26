/**
 * The injected persistence port for plans, and the typed errors every adapter
 * raises.
 *
 * The port stores **opaque canonical Markdown** keyed by {@link PlanDocument.id}:
 * the Markdown *is* the plan, so it stays canonical whichever backend holds it
 * and a hand edit is a first-class thing the domain reconciles. Parsing,
 * rendering, compare-and-swap and the revision counters all live above this line,
 * in the plan aggregate; below it an adapter only moves bytes.
 *
 * A backend that cannot query inside the Markdown persists {@link PlanIndex}
 * alongside it as indexed columns; the file adapter re-derives it by parsing.
 *
 * @remarks Plans are addressed by {@link PlanRecord.id}, which the Markdown
 * itself carries in its frontmatter. A stored document mangled badly enough to
 * lose that frontmatter therefore stops being addressable as a plan: an adapter
 * reports it as absent rather than inventing an identity for it. Damage below
 * the frontmatter — the realistic hand edit — keeps the plan addressable, so it
 * can still be read (as {@link InvalidPlanError}) and deleted.
 */
import type { PlanRetention, PlanStatus } from "./schemas.ts";

/**
 * The queryable projection of a plan, derived from its Markdown by
 * `projectPlan`. Everything {@link PlanRepositoryTx.list} can filter or order by
 * lives here, so no adapter has to look inside the source to serve a query.
 */
export interface PlanIndex {
  /**
   * The plan's human-facing locator — workspace-relative (`.clarvis/plans/….md`)
   * for the file adapter. **Not a key**: it is derived from the title and
   * creation time, and on {@link PlanRepositoryTx.create} it is only a
   * suggestion the adapter may replace.
   */
  path: string;
  title: string;
  status: PlanStatus;
  retention: PlanRetention;
  revision: number;
  spec_revision: number;
  created_at: string;
  updated_at: string;
  created_by_run: string;
}

/**
 * One stored plan.
 *
 * @remarks `digest` is `digestText(source)` — the compare-and-swap token, which
 * every adapter computes identically from the bytes. Because it is derived from
 * content rather than assigned by the backend, it detects a hand edit that never
 * went through the store at all.
 */
export interface PlanRecord {
  id: string;
  source: string;
  digest: string;
  index: PlanIndex;
}

/** Filter and paging for {@link PlanRepositoryTx.list}. */
export interface PlanRecordQuery {
  /** Opaque cursor from a previous page's `next_cursor`; start of history when omitted. */
  cursor?: string;
  /** Page size, clamped to 1–100 by the caller (default 20). */
  limit?: number;
  /** Only records with this status. */
  status?: PlanStatus;
  /** Only records with this retention policy. */
  retention?: PlanRetention;
}

/** A page of records. */
export interface PlanRecordPage {
  /** The matching records, newest first by `index.created_at`. */
  records: PlanRecord[];
  /** Cursor for the next page; absent when the query is exhausted. */
  next_cursor?: string;
}

/** The persistence operations, available directly on a {@link PlanRepository}. */
export interface PlanRepositoryTx {
  /**
   * Persist a brand-new plan.
   *
   * @param record - the plan's id, canonical source and projection.
   *   `record.index.path` is a *suggestion*; the adapter allocates a free
   *   locator and reports the one it used.
   * @returns the stored record, with `digest` computed and `index.path` set to
   *   the allocated locator.
   * @throws {@link PlanConflictError} with `reason: "cas"` if `record.id`
   *   already exists.
   */
  create(record: Omit<PlanRecord, "digest">): Promise<PlanRecord>;
  /**
   * Fetch one plan.
   *
   * @param id - the plan's stable id.
   * @returns the record, or `null` when no such plan exists.
   */
  read(id: string): Promise<PlanRecord | null>;
  /**
   * A page of plans.
   *
   * @param query - filters and paging; see {@link PlanRecordQuery}.
   * @returns the page. Filters are applied **before** paging, so a filtered page
   *   is short only when the query is genuinely exhausted, and ordering is
   *   newest-first by `index.created_at`.
   * @remarks A record the adapter cannot project (a corrupt document) is skipped
   *   rather than failing the whole listing. An adapter may return a short page
   *   with `next_cursor` when its aggregate page-byte budget is reached; callers
   *   continue from that cursor exactly as they would after a count-limited page.
   */
  list(query?: PlanRecordQuery): Promise<PlanRecordPage>;
  /**
   * Compare-and-swap: replace the source iff the stored digest still matches.
   *
   * @param input - the plan's id, the `expectedDigest` the caller last observed,
   *   and the new source plus projection.
   * @returns the stored record at its new digest.
   * @throws {@link PlanNotFoundError} when `id` does not exist.
   * @throws {@link PlanConflictError} with `reason: "cas"` when the stored digest
   *   has moved on.
   */
  write(input: {
    id: string;
    expectedDigest: string;
    source: string;
    index: PlanIndex;
  }): Promise<PlanRecord>;
  /**
   * Remove a plan.
   *
   * @param id - the plan's stable id.
   * @param expectedDigest - when given, delete only if the stored digest still
   *   matches.
   * @returns `true` if a plan was removed, `false` if it was already gone.
   * @throws {@link PlanConflictError} with `reason: "cas"` when `expectedDigest`
   *   is given and no longer matches.
   */
  delete(id: string, expectedDigest?: string): Promise<boolean>;
}

/**
 * The injected persistence port for a plan scope. One instance per scope — the
 * adapter's constructor binds the workspace (or, later, the tenant), so no port
 * method carries a scope argument.
 *
 * @remarks There is deliberately no lock or transaction method: every plan
 * mutation is a compare-and-swap over a single document, made atomic inside
 * {@link PlanRepositoryTx.write}. The only mutual exclusion an adapter needs —
 * allocating a free locator on create — is its own business (a `UNIQUE`
 * constraint, in a database).
 */
export type PlanRepository = PlanRepositoryTx;

/** Thrown when a plan is addressed that does not exist. */
export class PlanNotFoundError extends Error {
  /** Stable machine-readable discriminator, `"plan_not_found"`. */
  readonly code = "plan_not_found";

  constructor(id: string) {
    super(`Plan not found: ${id}`);
    this.name = "PlanNotFoundError";
  }
}

/**
 * Thrown when a mutation cannot proceed against the plan's current state:
 * `"cas"` when the document moved on since the caller read it, `"locked"` when
 * the backend could not take exclusive access in time.
 */
export class PlanConflictError extends Error {
  /** Stable machine-readable discriminator, `"plan_conflict"`. */
  readonly code = "plan_conflict";

  constructor(
    message: string,
    /** Which kind of conflict this is. */
    readonly reason: "cas" | "locked" = "cas",
  ) {
    super(message);
    this.name = "PlanConflictError";
  }
}

/**
 * Thrown when an edit is refused because the plan is sealed — see
 * {@link isPlanSealed}.
 *
 * @remarks A completed plan is the record of work that finished, so its
 *   substance is immutable: reopening it to describe *different* work destroys
 *   the only account of what the earlier run actually did. That is not
 *   hypothetical — a session that finished one feature and was then asked for a
 *   second rewrote the first plan's title, objective, context and every task,
 *   ten spec revisions deep, because creating a second plan was refused and the
 *   refusal named `revise_plan` as the way forward.
 */
export class PlanSealedError extends Error {
  /** Stable machine-readable discriminator, `"plan_sealed"`. */
  readonly code = "plan_sealed";

  constructor(message: string) {
    super(message);
    this.name = "PlanSealedError";
  }
}

/**
 * Thrown when a plan's stored source cannot be parsed. An adapter never
 * overwrites or deletes an unparseable plan as a side effect; it surfaces this
 * instead, so a hand-broken document stays recoverable.
 */
export class InvalidPlanError extends Error {
  /** Stable machine-readable discriminator, `"plan_invalid"`. */
  readonly code = "plan_invalid";

  constructor(message: string) {
    super(message);
    this.name = "InvalidPlanError";
  }
}
