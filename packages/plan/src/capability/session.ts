import { NOOP_LOGGER, type Logger } from "@clarvis/capability";

import {
  InvalidPlanError,
  PlanConflictError,
  PlanNotFoundError,
  PlanSealedError,
} from "../repository.ts";
import { MAX_PLAN_BATCH_OPERATIONS } from "../limits.ts";
import { applyPlanRevisions, type PlanRevisionOperation } from "../revisions.ts";
import {
  DEFAULT_PLAN_RETENTION,
  type PlanDocument,
  type PlanRef,
  type PlanRetention,
  type PlanTaskStatus,
} from "../schemas.ts";
import type { PlanCas, PlanListInput, PlanListResult, PlanStore } from "../store.ts";
import {
  canCompletePlan,
  isPlanSealed,
  isTaskClosed,
  sealedRevisionMessage,
  sealedTransitionMessage,
  transitionTask,
} from "../transitions.ts";

/**
 * Construction options for a {@link PlanSession}: the `store` it reads and
 * writes plans through, the `executionId` stamped as the plan's creator, whether
 * the run runs under `review`, an optional workspace/run-default `retention`,
 * and an `initialRef` to a plan from a continued run.
 */
export interface PlanSessionOptions {
  /** The plan data plane, injected by the host so a run and the control plane
   * share one instance. */
  store: PlanStore;
  /** Stable provider selection persisted beside every plan id. */
  providerKey?: string;
  executionId: string;
  review: boolean;
  /** Workspace/run default; `create_plan` may still override it per plan. */
  retention?: PlanRetention;
  initialRef?: PlanRef;
  /**
   * Operator diagnostics for what a continuation silently changes.
   *
   * @remarks Optional only because the property cannot carry a default; it is
   * resolved to {@link NOOP_LOGGER} once in the constructor.
   */
  logger?: Logger;
}

/**
 * The last confirmed identity of a plan whose backing record disappeared.
 *
 * @remarks A live session keeps this tombstone after invalidating its cached
 *   document. The runtime uses it to supersede stale canonical context and to
 *   emit one `plan_removed` projection; it never treats the cached document as
 *   mutable after the store reports it missing.
 */
export interface MissingPlanState {
  id: string;
  path?: string;
  revision: number;
  specRevision: number;
  document?: PlanDocument;
}

/**
 * Thrown when a run whose plan is still open tries to create a second one. This
 * is the loop's own one-open-plan-at-a-time policy, not a persistence conflict.
 *
 * @remarks Module-private on purpose: the only caller of {@link PlanSession.create}
 *   is `handlePlanRuntimeCall`, which reports any throw to the model as the error's
 *   message. Nothing narrows this type, so exporting it would advertise a
 *   discrimination the engine does not perform.
 *
 *   The bound is on *open* plans, not on plans. A session in `code` spans every
 *   turn the user takes, each one continuing the last, so a per-session bound
 *   meant the first feature's plan became a container every later feature had to
 *   be rewritten into — and this message, which used to end "change it with
 *   revise_plan", was the instruction that told the model to do it.
 */
class ActivePlanExistsError extends Error {
  constructor(id: string) {
    super(
      `An active plan already exists: ${id}. Finish it first — close its remaining tasks with ` +
        `transition_plan_task — and then create_plan for the next piece of work. To change the ` +
        `plan you are on, use revise_plan.`,
    );
    this.name = "ActivePlanExistsError";
  }
}

/** Model-facing recovery guidance for a plan removed outside the plan API. */
class MissingActivePlanError extends Error {
  constructor(missing: MissingPlanState) {
    const locator = missing.path ?? missing.id;
    super(
      `The active plan's backing record is missing: ${locator} (id: ${missing.id}). ` +
        "Clarvis invalidated the cached plan, so its expected_* values and task states are no " +
        "longer active. Do not retry this mutation. Restore the backing record or call " +
        "create_plan to start a replacement plan.",
    );
    this.name = "MissingActivePlanError";
  }
}

/**
 * One task's move to a new status, with the outcome field that status requires:
 * `done` needs `result`, `failed` needs `error`, `abandoned` needs `reason`.
 */
export interface PlanTaskTransition {
  taskId: string;
  status: PlanTaskStatus;
  result?: string;
  error?: string;
  reason?: string;
  assignee?: string;
}

/** The compare-and-swap triple ({@link PlanCas}) identifying a document's
 * current revision and digests. */
function baseline(document: PlanDocument): PlanCas {
  return {
    revision: document.revision,
    digest: document.digest,
    specDigest: document.spec_digest,
  };
}

/**
 * The run-lifetime owner of a single workspace plan: it wraps a
 * {@link PlanStore}, caches the last valid document, and mediates every read and
 * compare-and-swap mutation the plan capability performs on behalf of the model.
 *
 * @remarks At most one *open* plan exists at a time — {@link create} refuses a
 *   second while the current one still has open tasks, and otherwise seals it
 *   and moves on. A parse failure is recorded in `invalidError` and the file is
 *   left untouched; mutations then throw {@link InvalidPlanError} rather than
 *   overwrite it. On a continued run {@link reconcile} loads `initialRef`,
 *   resetting any `in_progress` task back to `pending` as an audited revision —
 *   unless the plan is sealed, which is left exactly as it was found.
 */
export class PlanSession {
  readonly #store: PlanStore;
  readonly #providerKey: string;
  readonly #executionId: string;
  readonly #review: boolean;
  readonly #retention: PlanRetention | undefined;
  readonly #initialRef: PlanRef | undefined;
  readonly #logger: Logger;
  #loaded = false;
  #lastValid: PlanDocument | undefined;
  #invalidError: string | undefined;
  #missing: MissingPlanState | undefined;
  #pendingRemoval: MissingPlanState | undefined;

  /** @param options - see {@link PlanSessionOptions}. */
  constructor(options: PlanSessionOptions) {
    this.#store = options.store;
    this.#providerKey = options.providerKey ?? "markdown";
    this.#executionId = options.executionId;
    this.#review = options.review;
    this.#retention = options.retention;
    this.#initialRef = options.initialRef;
    this.#logger = options.logger ?? NOOP_LOGGER;
  }

  /** The last valid plan document, or `undefined` when none exists yet. */
  cached(): PlanDocument | undefined {
    return this.#lastValid;
  }

  /** The tombstone for a plan removed outside the plan API, if one was observed. */
  missing(): MissingPlanState | undefined {
    return this.#missing;
  }

  /**
   * Consume the one-shot removal projection for the runtime event stream.
   * The durable {@link missing} tombstone remains until a replacement is made.
   */
  takeRemoval(): MissingPlanState | undefined {
    const pending = this.#pendingRemoval;
    this.#pendingRemoval = undefined;
    return pending;
  }

  /**
   * Bring the cached document in step with what is on disk, loading the
   * continuation plan on first call and adopting any external human edit
   * thereafter.
   *
   * @remarks First call: reads `initialRef` (if any), and if it holds an
   *   `in_progress` task or a non-`active` status, rewrites it to reset those
   *   tasks to `pending` and the status to `active` as a fresh revision; a
   *   missing `discard`ed plan from a completed run resolves to `undefined`
   *   (normal), any other read error rethrows.
   *
   *   A **sealed** plan ({@link isPlanSealed}) is exempt from all of that and is
   *   loaded exactly as stored. Resetting it was how a finished plan came back
   *   to life: `status !== "active"` is true of `completed`, so continuing a
   *   session republished the previous turn's finished plan as the active one,
   *   and `create_plan` then refused to make the next. It is still loaded rather
   *   than dropped, so the model can read what it just did — and close any task
   *   the earlier run forgot.
   *
   *   An approval recorded by an earlier run is also dropped when *this* run
   *   carries no review gate. Approval is a property of the run, so a plan
   *   approved under `mode: "review"` and continued under `mode: "on"` would
   *   otherwise keep a binding no gate in this run can renew — and a structural
   *   revision would then revoke it and move the document to
   *   `awaiting_approval` in a run that has no way to leave that state. Later
   *   calls: {@link PlanStore.reconcile}
   *   adopts an external edit; an {@link InvalidPlanError} is recorded and the
   *   last valid document kept, a {@link PlanConflictError} triggers a re-read.
   * @returns the reconciled document, or `undefined` when there is no plan.
   */
  async reconcile(): Promise<PlanDocument | undefined> {
    if (!this.#loaded) {
      this.#loaded = true;
      if (this.#initialRef === undefined) return undefined;
      try {
        const loaded = await this.#store.read(this.#initialRef.id);
        this.#lastValid = loaded;
        if (isPlanSealed(loaded)) return loaded;
        const needsReset =
          loaded.tasks.some((task) => task.status === "in_progress") || loaded.status !== "active";
        const staleApproval = !this.#review && loaded.approved_spec_revision !== undefined;
        if (needsReset || staleApproval) {
          let tasksReset = 0;
          this.#lastValid = await this.#store.update(loaded.id, loaded, (plan) => {
            for (const task of plan.tasks)
              if (task.status === "in_progress") {
                task.status = "pending";
                tasksReset += 1;
              }
            plan.status = "active";
            if (staleApproval) plan.approved_spec_revision = undefined;
          });
          this.#logger.info(
            {
              event: "plan.continuation.reset",
              plan_id: loaded.id,
              tasks_reset: tasksReset,
              status_from: loaded.status,
              stale_approval_cleared: staleApproval,
            },
            "the continued run reopened its plan, so claimed tasks are pending again and any approval from the earlier run no longer holds",
          );
        }
        return this.#lastValid;
      } catch (error) {
        if (
          error instanceof PlanNotFoundError &&
          this.#initialRef.status === "completed" &&
          this.#initialRef.retention === "discard"
        ) {
          this.#logger.debug(
            {
              event: "plan.continuation.absent",
              plan_id: this.#initialRef.id,
              reason: "discarded",
            },
            "the continued run's plan was deleted by its own retention policy; the run continues with no plan rather than reporting one missing",
          );
          return undefined;
        }
        if (error instanceof PlanNotFoundError) {
          this.#markMissing({
            id: this.#initialRef.id,
            ...(this.#initialRef.path === undefined ? {} : { path: this.#initialRef.path }),
            revision: this.#initialRef.final_revision,
            specRevision: this.#initialRef.final_spec_revision,
          });
          return undefined;
        }
        throw error;
      }
    }
    if (this.#lastValid === undefined) return undefined;
    try {
      this.#lastValid = await this.#store.reconcile(this.#lastValid.id, baseline(this.#lastValid));
      this.#invalidError = undefined;
    } catch (error) {
      if (error instanceof InvalidPlanError) {
        this.#invalidError = error.message;
        return this.#lastValid;
      }
      if (error instanceof PlanConflictError) {
        try {
          this.#lastValid = await this.#store.read(this.#lastValid.id);
          this.#invalidError = undefined;
          return this.#lastValid;
        } catch (readError) {
          if (readError instanceof PlanNotFoundError) {
            this.#markMissingFromDocument(this.#lastValid);
            return undefined;
          }
          throw readError;
        }
      }
      if (error instanceof PlanNotFoundError) {
        this.#markMissingFromDocument(this.#lastValid);
        return undefined;
      }
      throw error;
    }
    return this.#lastValid;
  }

  /**
   * Create the session's plan.
   *
   * @param input - the plan content; `retention` overrides the session default.
   * @returns the created document.
   * @throws {@link ActivePlanExistsError} when the session's current plan still
   *   has open work.
   *
   * @remarks A session may create more than one plan over its life; what it may
   *   not do is run two open ones at once. A plan that is sealed, or whose every
   *   task is closed, is finished work — so this proceeds, sealing the latter on
   *   the way past. That second case is what lets one turn finish a feature and
   *   start the next: nothing else in a run can move a plan to `completed`,
   *   since only teardown calls {@link finalize} and no tool sets a status.
   *   Without it the bound would still be one plan per *turn*, and the model's
   *   only way onward would again be to rewrite the plan it had just finished.
   */
  async create(input: {
    title: string;
    objective: string;
    context?: string;
    tasks: Array<{ title: string; detail?: string; exit?: string }>;
    validation?: string[];
    retention?: PlanRetention;
  }): Promise<PlanDocument> {
    const current = await this.reconcile();
    if (current !== undefined && !isPlanSealed(current)) {
      if (!canCompletePlan(current)) throw new ActivePlanExistsError(current.id);
      await this.#store.update(current.id, current, (plan) => {
        plan.status = "completed";
      });
    }
    const retention = input.retention ?? this.#retention;
    this.#lastValid = await this.#store.create({
      ...input,
      ...(retention === undefined ? {} : { retention }),
      createdByRun: this.#executionId,
      review: this.#review,
    });
    this.#invalidError = undefined;
    this.#missing = undefined;
    return this.#lastValid;
  }

  /**
   * Read a plan: an explicit `id` reads that plan directly; omitted, it
   * reconciles and returns the session's own plan.
   */
  async read(id?: string): Promise<PlanDocument | undefined> {
    if (id !== undefined) {
      if (this.#missing?.id === id) throw new MissingActivePlanError(this.#missing);
      try {
        return await this.#store.read(id);
      } catch (error) {
        if (error instanceof PlanNotFoundError && this.#lastValid?.id === id) {
          const missing = this.#markMissingFromDocument(this.#lastValid);
          throw new MissingActivePlanError(missing);
        }
        throw error;
      }
    }
    return this.reconcile();
  }

  /** The reconciled plan's task with `taskId`, or `undefined` if none. */
  async task(taskId: string): Promise<PlanDocument["tasks"][number] | undefined> {
    return (await this.reconcile())?.tasks.find((task) => task.id === taskId);
  }

  /** The reconciled plan's tasks that are neither `done` nor `abandoned`. */
  async openTasks(): Promise<PlanDocument["tasks"]> {
    return (
      (await this.reconcile())?.tasks.filter(
        (task) => task.status !== "done" && task.status !== "abandoned",
      ) ?? []
    );
  }

  /** List plans in the workspace; see {@link PlanListInput}. */
  list(input: PlanListInput = {}): Promise<PlanListResult> {
    return this.#store.list(input);
  }

  /**
   * Apply one or more substance revisions to the plan under compare-and-swap.
   *
   * @param expected - the CAS triple the caller last read.
   * @param operation - the revision to apply, or a batch applied in order under
   *   this one triple. The batch is all-or-nothing and costs a single revision;
   *   an operation may build on the one before it.
   * @returns the revised document.
   * @throws {@link PlanConflictError} when `expected` no longer matches the
   *   current document.
   * @throws {@link InvalidPlanError} when the on-disk plan is unparseable.
   * @throws {@link PlanSealedError} when the plan is a completed record.
   *
   * @remarks The seal is checked here as well as in `PlanStore.revise`, and the
   *   check here is the load-bearing one: this method does not call that one. It
   *   applies the operation itself and writes the result through the generic
   *   `update`, so the store's gate never sees the model's `revise_plan`.
   */
  async revise(
    expected: PlanCas,
    operation: PlanRevisionOperation | readonly PlanRevisionOperation[],
  ): Promise<PlanDocument> {
    const current = await this.#requireMutable();
    if (isPlanSealed(current)) throw new PlanSealedError(sealedRevisionMessage(current.id));
    if (
      current.revision !== expected.revision ||
      current.digest !== expected.digest ||
      current.spec_digest !== expected.specDigest
    )
      throw new PlanConflictError("Plan changed since it was read");
    const preview = applyPlanRevisions(
      current,
      Array.isArray(operation) ? operation : [operation as PlanRevisionOperation],
    );
    this.#lastValid = await this.#store.update(current.id, expected, () => preview.document, {
      structural: preview.structural,
    });
    return this.#lastValid;
  }

  /**
   * Transition one or more task statuses under compare-and-swap.
   *
   * @param input - the `expected` CAS triple and the `transitions` to apply in
   *   order.
   * @returns the updated document.
   * @throws Error when a `taskId` is unknown or a transition is illegal — before
   *   anything is written, so a batch is all-or-nothing.
   * @throws {@link InvalidPlanError} when the on-disk plan is unparseable.
   * @throws {@link PlanSealedError} when the plan is sealed and any target
   *   status is not a closed one.
   *
   * @remarks A batch costs one revision. Splitting it was not a style choice: a
   *   caller holds one CAS triple, so a second call issued from the same
   *   decision carries the triple the first just invalidated and is rejected as
   *   a conflict. Closing tasks is the most frequent thing anyone does to a
   *   plan, so this is where that cost was largest.
   *
   *   Closing an open task is the single edit a sealed plan admits, and it is
   *   checked here rather than in the store because a task transition goes
   *   through the generic `update` that `finalize`, `approve` and `setRetention`
   *   also use. `transitionTask`'s own matrix already refuses to move a task
   *   *out* of `done`/`abandoned`, so the two rules together leave no way to
   *   reopen anything on a finished plan.
   */
  async transition(input: {
    expected: PlanCas;
    transitions: readonly PlanTaskTransition[];
  }): Promise<PlanDocument> {
    if (input.transitions.length === 0 || input.transitions.length > MAX_PLAN_BATCH_OPERATIONS)
      throw new RangeError(
        `Plan transition batch must contain 1-${MAX_PLAN_BATCH_OPERATIONS} transitions`,
      );
    const current = await this.#requireMutable();
    if (isPlanSealed(current)) {
      const reopening = input.transitions.find((t) => !isTaskClosed(t.status));
      if (reopening !== undefined)
        throw new PlanSealedError(sealedTransitionMessage(current.id, reopening.status));
    }
    this.#lastValid = await this.#store.update(current.id, input.expected, (plan) => {
      for (const transition of input.transitions) {
        const index = plan.tasks.findIndex((task) => task.id === transition.taskId);
        if (index < 0) throw new Error(`Unknown plan task: ${transition.taskId}`);
        plan.tasks[index] = transitionTask(plan.tasks[index]!, transition.status, {
          ...(transition.result === undefined ? {} : { result: transition.result }),
          ...(transition.error === undefined ? {} : { error: transition.error }),
          ...(transition.reason === undefined ? {} : { reason: transition.reason }),
          ...(transition.assignee === undefined ? {} : { assignee: transition.assignee }),
        });
      }
    });
    return this.#lastValid;
  }

  /**
   * Transition one task against the plan's current baseline — the runtime-driven
   * variant of {@link transition} that supplies `expected` from the freshly
   * reconciled document rather than a model-provided CAS triple.
   *
   * @remarks Singular because every caller is: the runtime claims or returns one
   *   delegated task at a time. Batching is a model-facing concern, and the
   *   model reaches {@link transition} directly.
   */
  async transitionCurrent(input: PlanTaskTransition): Promise<PlanDocument> {
    const current = await this.#requireMutable();
    return this.transition({ expected: baseline(current), transitions: [input] });
  }

  /**
   * Record a human approval: bind `approved_spec_revision` to the current
   * `spec_revision` and set the status to `active`.
   *
   * @returns the approved document.
   */
  async approve(): Promise<PlanDocument> {
    const current = await this.#requireMutable();
    this.#lastValid = await this.#store.update(current.id, current, (plan) => {
      plan.approved_spec_revision = plan.spec_revision;
      plan.status = "active";
    });
    return this.#lastValid;
  }

  /** Change the plan's retention policy. */
  async setRetention(retention: PlanRetention): Promise<PlanDocument> {
    const current = await this.#requireMutable();
    this.#lastValid = await this.#store.update(current.id, current, (plan) => {
      plan.retention = retention;
    });
    return this.#lastValid;
  }

  /**
   * A {@link PlanRef} pointing at the cached plan for the run record, or at the
   * last confirmed identity when that plan disappeared mid-run.
   *
   * @remarks The missing-plan form is durable recovery state, not permission to
   * mutate stale data. Carrying its identity into the next continuation lets a
   * fresh session re-read that exact id, rediscover the tombstone and supersede
   * an older plan ref that the engine would otherwise carry forward.
   */
  ref(): PlanRef | undefined {
    const plan = this.#lastValid;
    if (plan === undefined) {
      const missing = this.#missing;
      if (missing === undefined) return undefined;
      const initial = this.#initialRef?.id === missing.id ? this.#initialRef : undefined;
      return {
        id: missing.id,
        provider_key: this.#providerKey,
        ...(missing.path === undefined ? {} : { path: missing.path }),
        final_revision: missing.revision,
        final_spec_revision: missing.specRevision,
        status: missing.document?.status ?? initial?.status ?? "failed",
        retention:
          missing.document?.retention ??
          initial?.retention ??
          this.#retention ??
          DEFAULT_PLAN_RETENTION,
      };
    }
    return {
      id: plan.id,
      provider_key: this.#providerKey,
      ...(plan.path === undefined ? {} : { path: plan.path }),
      final_revision: plan.revision,
      final_spec_revision: plan.spec_revision,
      status: plan.status,
      retention: plan.retention,
    };
  }

  /**
   * Drive the plan to a terminal status at run end.
   *
   * @param status - the terminal status to record.
   * @returns the final {@link PlanRef}, or `undefined` when there is no plan. If
   *   the on-disk document is invalid, the file is left untouched and the last
   *   valid ref is returned.
   *
   * @remarks A sealed plan is returned as it stands rather than re-stamped. It
   *   is not this run's plan to close — the run that finished it already did —
   *   and re-stamping meant a continued turn that was merely *cancelled* wrote
   *   `cancelled` over a `completed` record of work that had genuinely shipped.
   */
  async finalize(
    status: Extract<PlanDocument["status"], "completed" | "cancelled" | "failed">,
  ): Promise<PlanRef | undefined> {
    const current = await this.reconcile();
    if (current === undefined) return this.ref();
    if (this.#invalidError !== undefined) return this.ref();
    if (isPlanSealed(current)) return this.ref();
    this.#lastValid = await this.#store.update(current.id, current, (plan) => {
      plan.status = status;
    });
    return this.ref();
  }

  /**
   * Reconcile and return the plan, refusing to proceed with a mutation when the
   * document is invalid or absent.
   *
   * @throws {@link InvalidPlanError} when the on-disk plan failed to parse.
   * @throws Error when no plan exists.
   */
  async #requireMutable(): Promise<PlanDocument> {
    const plan = await this.reconcile();
    if (this.#invalidError !== undefined)
      throw new InvalidPlanError(
        `Plan document is invalid and was left untouched: ${this.#invalidError}`,
      );
    if (plan === undefined) {
      if (this.#missing !== undefined) throw new MissingActivePlanError(this.#missing);
      throw new Error("No active plan");
    }
    return plan;
  }

  /** Record a store-level disappearance and invalidate every mutable cache. */
  #markMissing(missing: MissingPlanState): MissingPlanState {
    this.#lastValid = undefined;
    this.#invalidError = undefined;
    this.#missing = missing;
    this.#pendingRemoval ??= missing;
    return missing;
  }

  /** Build a complete tombstone from the last document the session confirmed. */
  #markMissingFromDocument(document: PlanDocument): MissingPlanState {
    return this.#markMissing({
      id: document.id,
      ...(document.path === undefined ? {} : { path: document.path }),
      revision: document.revision,
      specRevision: document.spec_revision,
      document,
    });
  }
}
