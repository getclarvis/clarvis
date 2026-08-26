/**
 * The plan aggregate: compare-and-swap mutation, the two revision counters,
 * approval invalidation, filtering and paging — over an injected
 * {@link PlanRepository}. It holds no I/O of its own, so the same rules apply
 * whichever backend stores the Markdown.
 */
import { basename } from "node:path";

import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

import {
  digestText,
  newPlan,
  parsePlan,
  planFilename,
  projectPlan,
  renderPlan,
  specDigest,
} from "./format.ts";
import { boundedPlanReason } from "./log.ts";
import {
  InvalidPlanError,
  PlanConflictError,
  PlanNotFoundError,
  PlanSealedError,
  type PlanRecord,
  type PlanRepository,
} from "./repository.ts";
import { applyPlanRevisions, nextRevision, type PlanRevisionOperation } from "./revisions.ts";
import { isPlanSealed, sealedRevisionMessage } from "./transitions.ts";
import {
  planDocumentSchema,
  type PlanDocument,
  type PlanRetention,
  type PlanStatus,
} from "./schemas.ts";

/**
 * The compare-and-swap fingerprint of a plan at a known point: its `revision`
 * plus the content (`digest`) and substance (`specDigest`) hashes. A mutation
 * passes the triple it last observed; the store rejects the write if the plan
 * has moved on. A full {@link PlanDocument} (whose fields are `digest`/
 * `spec_digest`) is also accepted wherever a `PlanCas` is.
 */
export interface PlanCas {
  revision: number;
  digest: string;
  specDigest: string;
}

/** Paging and filter options for {@link PlanStore.list}. */
export interface PlanListInput {
  /** Opaque cursor from a previous result's `next_cursor`; start of history if omitted. */
  cursor?: string;
  /** Page size, clamped to 1–100 (default 20). */
  limit?: number;
  /** Only return plans with this status. */
  status?: PlanStatus;
  /** Only return plans with this retention policy. */
  retention?: PlanRetention;
}

/** A count- or byte-bounded page of plans plus a cursor for the next page. */
export interface PlanListResult {
  /** The matching plans, newest first. */
  plans: PlanDocument[];
  /** Cursor to pass as {@link PlanListInput.cursor} for the next page; absent when exhausted. */
  next_cursor?: string;
}

/** The content and metadata a new plan is created from. */
export interface CreatePlanInput {
  title: string;
  objective: string;
  context?: string;
  tasks: Array<{
    title: string;
    detail?: string;
    exit?: string;
    status?: PlanDocument["tasks"][number]["status"];
    result?: string;
    error?: string;
    reason?: string;
    assignee?: string;
  }>;
  validation?: string[];
  retention?: PlanRetention;
  createdByRun: string;
  review?: boolean;
  now?: Date;
}

/**
 * The plan data plane a run and the control plane both program against: plans
 * are addressed by their stable {@link PlanDocument.id}, and every mutation is a
 * compare-and-swap over a {@link PlanCas}.
 */
export interface PlanStore {
  /**
   * Create a new plan.
   *
   * @param input - the plan's content and metadata; see {@link CreatePlanInput}.
   * @returns the created plan at `revision` 1, with its allocated locator and
   *   compare-and-swap digests populated.
   * @throws {@link z.ZodError} if the content violates {@link planDocumentSchema}.
   */
  create(input: CreatePlanInput): Promise<PlanDocument>;
  /**
   * Read a single plan.
   *
   * @param id - the plan's stable id.
   * @returns the parsed plan, its `digest` matching the stored bytes.
   * @throws {@link PlanNotFoundError} when no such plan exists.
   * @throws {@link InvalidPlanError} if the stored source cannot be parsed.
   */
  read(id: string): Promise<PlanDocument>;
  /**
   * List plans newest-first with cursor paging and optional filtering.
   *
   * @param input - paging and filter options; see {@link PlanListInput}.
   * @returns a page of plans and a `next_cursor` when more remain. A page may be
   *   shorter than `limit` when the repository's aggregate byte budget is hit.
   */
  list(input?: PlanListInput): Promise<PlanListResult>;
  /**
   * Compare-and-swap mutate a plan: re-read it, verify it still matches
   * `expected`, apply `mutate`, then persist the next revision.
   *
   * @param id - the plan to mutate.
   * @param expected - the {@link PlanCas} (or {@link PlanDocument}) the caller
   *   last observed.
   * @param mutate - edits the draft in place, or returns a replacement document.
   * @param options - `structural: true` also bumps `spec_revision` and clears any
   *   `approved_spec_revision`; `now` overrides the `updated_at` timestamp.
   * @returns the written plan at the next `revision`, with fresh digests.
   * @throws {@link PlanConflictError} if the plan changed since `expected`.
   * @throws {@link InvalidPlanError} if the stored source cannot be parsed, or if
   *   `mutate` produced a document that violates {@link planDocumentSchema}.
   */
  update(
    id: string,
    expected: PlanCas | PlanDocument,
    mutate: (document: PlanDocument) => PlanDocument | void,
    options?: { structural?: boolean; now?: Date },
  ): Promise<PlanDocument>;
  /**
   * Adopt an external edit as a new revision.
   *
   * @param id - the plan to reconcile.
   * @param known - the {@link PlanCas} the caller last held.
   * @param now - overrides the `updated_at` timestamp.
   * @returns the current plan unchanged if its bytes still match `known`;
   *   otherwise the stored content re-adopted as the next `revision` (bumping
   *   `spec_revision` and clearing approval when the substance changed).
   * @throws {@link PlanConflictError} if both the revision *and* content diverged
   *   — an out-of-band writer moved past `known`, not a hand edit.
   * @remarks A backend where only this store writes never produces the middle
   *   case, so this is a no-op there rather than a backend-specific branch.
   */
  reconcile(id: string, known: PlanCas | PlanDocument, now?: Date): Promise<PlanDocument>;
  /**
   * Compare-and-swap apply one or more {@link PlanRevisionOperation}s, deriving
   * whether the edit was structural from the operations themselves.
   *
   * @param id - the plan to revise.
   * @param expected - the {@link PlanCas} the caller last observed.
   * @param operation - the structural edit to apply, or a batch of them applied
   *   in order under this one compare-and-swap. A batch is all-or-nothing and
   *   costs a single `revision` (and at most one `spec_revision`).
   * @param now - overrides the `updated_at` timestamp.
   * @returns the written plan at the next `revision`.
   * @throws {@link PlanConflictError} if the plan changed since `expected`.
   * @throws {@link PlanSealedError} if the plan is a completed record.
   */
  revise(
    id: string,
    expected: PlanCas | PlanDocument,
    operation: PlanRevisionOperation | readonly PlanRevisionOperation[],
    now?: Date,
  ): Promise<PlanDocument>;
  /**
   * Delete a plan, optionally under compare-and-swap.
   *
   * @param id - the plan to delete.
   * @param expected - the baseline the caller read before deciding deletion was allowed.
   * @returns `true` if a plan was removed, `false` if it was already gone.
   * @throws {@link PlanConflictError} if `expected` no longer matches.
   */
  delete(id: string, expected?: PlanCas | PlanDocument): Promise<boolean>;
}

/** Construction inputs for {@link createPlanStore}. */
export interface CreatePlanStoreOptions {
  /** Where plans are persisted. */
  repository: PlanRepository;
  /** Injectable clock for `updated_at`; defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Operator diagnostics for the two facts this aggregate otherwise swallows: a
   * losing compare-and-swap, and a stored document that will not parse.
   *
   * @remarks Optional only because the property cannot carry a default; it is
   * resolved to {@link NOOP_LOGGER} once at construction so every call site
   * below is unconditional rather than optionally chained.
   */
  logger?: Logger;
}

/**
 * Which components of a compare-and-swap baseline disagreed with the stored
 * plan.
 *
 * @param current - the plan as stored.
 * @param expected - the baseline the caller held.
 * @returns the mismatching component names, in a stable order; empty when the
 *   baseline still matches.
 * @remarks The whole forensic content of a `cas` conflict. Without it the
 *   package's documented failure mode — three calls from one decision, one
 *   write and two conflicts — reports the same opaque sentence whether the
 *   caller raced itself, raced a human editing the file, or read a plan that
 *   had already moved several revisions on.
 */
function casMismatch(current: PlanDocument, expected: PlanCas | PlanDocument): string[] {
  const mismatch: string[] = [];
  if (current.revision !== expected.revision) mismatch.push("revision");
  if (current.digest !== expected.digest) mismatch.push("digest");
  if (current.spec_digest !== expectedSpecDigest(expected)) mismatch.push("spec_digest");
  return mismatch;
}

/** The `spec_digest` of a CAS baseline, whichever shape it arrived in. */
function expectedSpecDigest(expected: PlanCas | PlanDocument): string {
  return "specDigest" in expected ? expected.specDigest : expected.spec_digest;
}

/** Parse a stored record into a document carrying the backend's locator. */
function documentOf(record: PlanRecord): PlanDocument {
  try {
    return parsePlan(record.source, record.index.path);
  } catch (error) {
    throw new InvalidPlanError(error instanceof Error ? error.message : String(error));
  }
}

/** Render a document and pair it with the digests its bytes imply. */
function sealed(document: PlanDocument): { source: string; document: PlanDocument } {
  const source = renderPlan(document);
  return {
    source,
    document: { ...document, digest: digestText(source), spec_digest: specDigest(document) },
  };
}

/**
 * Build the plan aggregate over an injected repository.
 *
 * @param options - the backing repository and an optional clock; see
 *   {@link CreatePlanStoreOptions}.
 * @returns a {@link PlanStore}.
 * @remarks All methods are safe to call concurrently: a losing compare-and-swap
 *   raises {@link PlanConflictError} rather than clobbering. Every write is
 *   re-validated against {@link planDocumentSchema} before it is rendered, so a
 *   faulty mutation is rejected at the boundary instead of persisting a document
 *   that only fails on the next read.
 */
export function createPlanStore(options: CreatePlanStoreOptions): PlanStore {
  const repository = options.repository;
  const clock = options.now ?? ((): Date => new Date());
  const logger = options.logger ?? NOOP_LOGGER;

  /** Report a losing compare-and-swap, then raise it. */
  function conflict(id: string, current: PlanDocument, expected: PlanCas | PlanDocument): never {
    logger.debug(
      {
        event: "plan.cas.rejected",
        plan_id: id,
        mismatch: casMismatch(current, expected),
        expected_revision: expected.revision,
        actual_revision: current.revision,
      },
      "plan write rejected because the caller's baseline is stale; the plan is unchanged",
    );
    throw new PlanConflictError("Plan changed since it was read", "cas");
  }

  /**
   * Report a stored plan this page had to omit.
   *
   * @param record - the record whose source would not parse.
   * @param error - what the parse threw.
   * @remarks A named function rather than an inline `catch` body for two
   *   reasons: Bun charges a `catch`'s lines to the enclosing `try`, so an
   *   inline body is not measurable (`specs/cross-cutting/test-architecture.md` §3.7); and the
   *   reason must pass through {@link boundedPlanReason}, because a parse
   *   failure can quote the document it failed on and a plan document is never
   *   logged.
   */
  function reportUnparsable(record: PlanRecord, error: unknown): void {
    logger.warn(
      {
        event: "plan.document.unparsable",
        path: basename(record.index.path),
        reason: boundedPlanReason(error),
        layer: "store",
      },
      "a stored plan could not be parsed and is omitted from this page; the file is untouched",
    );
  }

  /** Read `id` from the repository and parse it, throwing
   * {@link PlanNotFoundError} if no such plan exists. */
  async function require(id: string): Promise<{ record: PlanRecord; document: PlanDocument }> {
    const record = await repository.read(id);
    if (record === null) throw new PlanNotFoundError(id);
    return { record, document: documentOf(record) };
  }

  /** The shared write path: CAS-check, apply, bump, validate, render, persist. */
  async function apply(
    id: string,
    expected: PlanCas | PlanDocument,
    mutate: (document: PlanDocument) => { document: PlanDocument; structural: boolean },
    now?: Date,
  ): Promise<PlanDocument> {
    const { record, document: current } = await require(id);
    if (
      current.revision !== expected.revision ||
      current.digest !== expected.digest ||
      current.spec_digest !== expectedSpecDigest(expected)
    )
      conflict(id, current, expected);
    const applied = mutate(structuredClone(current));
    const next = nextRevision(current, applied.document, {
      structural: applied.structural,
      now: now ?? clock(),
    });
    const validated = planDocumentSchema.parse(next);
    const { source, document } = sealed(validated);
    const written = await repository.write({
      id,
      expectedDigest: record.digest,
      source,
      index: projectPlan(document),
    });
    return { ...document, path: written.index.path };
  }

  return {
    async create(input) {
      const draft = newPlan(input);
      const { source, document } = sealed(draft);
      const created = await repository.create({
        id: document.id,
        source,
        index: {
          ...projectPlan(document),
          path: planFilename(input.now ?? clock(), input.title),
        },
      });
      return { ...document, path: created.index.path };
    },

    async read(id) {
      return (await require(id)).document;
    },

    async list(input = {}) {
      const page = await repository.list(input);
      const plans: PlanDocument[] = [];
      for (const record of page.records) {
        try {
          plans.push(documentOf(record));
        } catch (error) {
          reportUnparsable(record, error);
          continue;
        }
      }
      return {
        plans,
        ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
      };
    },

    update(id, expected, mutate, updateOptions = {}) {
      return apply(
        id,
        expected,
        (draft) => ({
          document: mutate(draft) ?? draft,
          structural: updateOptions.structural === true,
        }),
        updateOptions.now,
      );
    },

    async reconcile(id, known, now) {
      const { record, document: current } = await require(id);
      if (current.digest === known.digest) return current;
      if (current.revision !== known.revision)
        throw new PlanConflictError("Plan revision and content changed externally", "cas");
      const structural = expectedSpecDigest(known) !== current.spec_digest;
      const next = nextRevision(current, current, { structural, now: now ?? clock() });
      const { source, document } = sealed(planDocumentSchema.parse(next));
      const written = await repository.write({
        id,
        expectedDigest: record.digest,
        source,
        index: projectPlan(document),
      });
      return { ...document, path: written.index.path };
    },

    revise(id, expected, operation, now) {
      return apply(
        id,
        expected,
        (draft) => {
          if (isPlanSealed(draft)) throw new PlanSealedError(sealedRevisionMessage(draft.id));
          return applyPlanRevisions(draft, Array.isArray(operation) ? operation : [operation]);
        },
        now,
      );
    },

    async delete(id, expected) {
      if (expected === undefined) return repository.delete(id);
      const record = await repository.read(id);
      if (record === null) return false;
      const current = documentOf(record);
      if (
        current.revision !== expected.revision ||
        current.digest !== expected.digest ||
        current.spec_digest !== expectedSpecDigest(expected)
      ) {
        conflict(id, current, expected);
      }
      return repository.delete(id, record.digest);
    },
  };
}
