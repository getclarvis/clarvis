import { InvalidPlanError, PlanNotFoundError } from "./repository.ts";
import type { PlanDocument, PlanRetention, PlanStatus } from "./schemas.ts";
import type { PlanStore, PlanListInput, PlanListResult } from "./store.ts";

/**
 * Thrown by {@link PlanService.delete} when the plan is still live
 * (`active` or `awaiting_approval`) and therefore may not be deleted.
 */
export class PlanNotTerminalError extends Error {
  /** Stable machine-readable discriminator, `"plan_not_terminal"`. */
  readonly code = "plan_not_terminal";

  constructor(id: string, status: PlanStatus) {
    super(`Plan '${id}' is ${status}; only terminal plans can be deleted`);
    this.name = "PlanNotTerminalError";
  }
}

/**
 * The control-plane surface over a {@link PlanStore} that the kernel wraps and
 * exposes to clients: list, read, retention changes, and deletion. It adds the
 * policy the raw store does not — e.g. refusing to delete a live plan — while
 * delegating all persistence to the store.
 */
export class PlanService {
  /** @param store - the backing store this service operates over. */
  constructor(readonly store: PlanStore) {}

  /**
   * List plans, newest first, with optional cursor paging and status/retention
   * filters.
   *
   * @param input - paging and filter options; see {@link PlanListInput}.
   * @returns the matching plans and a `next_cursor` when more remain.
   */
  list(input: PlanListInput = {}): Promise<PlanListResult> {
    return this.store.list(input);
  }

  /**
   * Read a single plan.
   *
   * @param id - the plan's stable id.
   * @returns the parsed plan.
   * @throws {@link PlanNotFoundError} when no such plan exists.
   * @throws {@link InvalidPlanError} if the stored source cannot be parsed.
   */
  read(id: string): Promise<PlanDocument> {
    return this.store.read(id);
  }

  /**
   * Change a plan's retention policy.
   *
   * @param id - the plan's stable id.
   * @param retention - the new retention policy.
   * @returns the updated plan (a new {@link PlanDocument.revision | revision}).
   * @remarks This is a control-plane write and bumps the plan's revision, so a
   *   run holding an older baseline must reconcile onto it.
   */
  async setRetention(id: string, retention: PlanRetention): Promise<PlanDocument> {
    const current = await this.store.read(id);
    return this.store.update(id, current, (plan) => {
      plan.retention = retention;
    });
  }

  /**
   * Delete a plan.
   *
   * @param id - the plan's stable id.
   * @returns the id and whether a plan was actually removed (`false` if it was
   *   already gone).
   * @throws {@link PlanNotTerminalError} if the plan is still `active` or
   *   `awaiting_approval`.
   * @remarks A corrupt/unparseable plan has no readable status and is deleted
   *   anyway, so a broken plan can be cleaned up rather than being stuck.
   */
  async delete(id: string): Promise<{ id: string; deleted: boolean }> {
    let plan: PlanDocument;
    try {
      plan = await this.store.read(id);
    } catch (error) {
      if (error instanceof InvalidPlanError) return { id, deleted: await this.store.delete(id) };
      if (error instanceof PlanNotFoundError) return { id, deleted: false };
      throw error;
    }
    if (plan.status === "active" || plan.status === "awaiting_approval")
      throw new PlanNotTerminalError(id, plan.status);
    return { id, deleted: await this.store.delete(id, plan) };
  }
}
