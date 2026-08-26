import {
  PlanCursorError,
  PlanProviderUnavailableError,
  PlanService,
  renderPlan,
  type PlanDocument,
  type ResolvedPlanStore,
} from "@clarvis/plan";
import { sanitizeDeep, sanitizeErrorMessage } from "@clarvis/capability";

import { kernelError } from "../core/errors.ts";
import type {
  PlanDocumentDto,
  PlanListInput,
  PlanListResult,
  PlanRetention,
  PlansService,
} from "@clarvis/protocol";

/**
 * Project a domain {@link PlanDocument} onto the wire {@link PlanDocumentDto}.
 *
 * @param plan - the parsed plan from the store.
 * @returns the DTO, carrying the parsed fields plus the verbatim `markdown`
 *   re-rendered from the plan; `approved_spec_revision` is included only when set.
 */
function dto(plan: PlanDocument): PlanDocumentDto {
  return {
    ...(plan.path === undefined ? {} : { path: plan.path }),
    id: plan.id,
    title: plan.title,
    status: plan.status,
    retention: plan.retention,
    revision: plan.revision,
    spec_revision: plan.spec_revision,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    created_by_run: plan.created_by_run,
    ...(plan.approved_spec_revision === undefined
      ? {}
      : { approved_spec_revision: plan.approved_spec_revision }),
    objective: plan.objective,
    context: plan.context,
    tasks: plan.tasks,
    validation: plan.validation,
    notes: plan.notes,
    markdown: renderPlan(plan),
  };
}

/**
 * Adapt a dynamically resolved domain {@link PlanService} to the protocol
 * {@link PlansService}, projecting each returned plan onto its wire DTO.
 *
 * @param options - async resolver for the currently selected owner store; omitted,
 *   every method rejects with `capability_disabled`.
 * @returns a {@link PlansService} that lists, reads, changes retention, and
 *   deletes plans through the wrapped {@link PlanService}.
 */
export function createPlansService(
  options: {
    resolve?: () => Promise<ResolvedPlanStore>;
  } = {},
): PlansService {
  const active = async (): Promise<PlanService> => {
    if (options.resolve === undefined)
      throw kernelError("capability_disabled", "plans are not configured for this workspace");
    try {
      const resolved = await options.resolve();
      return new PlanService(resolved.store);
    } catch (error) {
      if (error instanceof PlanProviderUnavailableError) {
        throw kernelError(
          "unavailable",
          sanitizeErrorMessage(error.message),
          error.details === undefined
            ? undefined
            : sanitizeDeep(error.details, sanitizeErrorMessage),
        );
      }
      throw kernelError(
        "unavailable",
        sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      );
    }
  };
  return {
    /**
     * List plans, newest first, with optional cursor paging and status/retention
     * filters.
     *
     * @param input - paging and filter options; see {@link PlanListInput}.
     * @returns the matching {@link PlanDocumentDto}s and a `next_cursor` when more
     *   remain.
     * @throws a `invalid_request` {@link KernelException} when the cursor was
     *   minted by a different backend. A cursor names its own dialect, so feeding
     *   one store's cursor to another is a caller mistake; without this it
     *   travelled as `internal` and read to a client as a Clarvis defect.
     */
    async list(input?: PlanListInput): Promise<PlanListResult> {
      const service = await active();
      const result = await service.list(input).catch((error: unknown) => {
        if (error instanceof PlanCursorError) {
          throw kernelError("invalid_request", "invalid plan cursor");
        }
        throw error;
      });
      return {
        plans: result.plans.map(dto),
        ...(result.next_cursor === undefined ? {} : { next_cursor: result.next_cursor }),
      };
    },
    /**
     * Read a single plan by its stable id.
     *
     * @param id - the plan's stable id.
     * @returns the parsed plan as a {@link PlanDocumentDto}.
     * @throws when the file cannot be parsed (surfaced from the store).
     */
    async read(id: string): Promise<PlanDocumentDto> {
      const service = await active();
      return dto(await service.read(id));
    },
    /**
     * Change a plan's retention policy.
     *
     * @param id - the plan's stable id.
     * @param retention - the new retention policy.
     * @returns the updated plan (a new {@link PlanDocumentDto.revision | revision}).
     */
    async setRetention(id: string, retention: PlanRetention): Promise<PlanDocumentDto> {
      const service = await active();
      return dto(await service.setRetention(id, retention));
    },
    /**
     * Delete a plan.
     *
     * @param id - the plan's stable id.
     * @returns the id and whether a plan was actually removed (`false` if it was
     *   already gone).
     * @throws when the plan is still live (`active` or `awaiting_approval`); only
     *   terminal plans may be deleted.
     */
    async delete(id: string): Promise<{ id: string; deleted: boolean }> {
      const service = await active();
      return service.delete(id);
    },
  };
}
