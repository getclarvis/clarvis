import type { OperatorReviewContext } from "@clarvis/capability";
import type { PlanDocument } from "../schemas.ts";

const MAX_REVIEW_CONTEXT_CHARS = 262_144;

/**
 * Project only a Plan's substantive specification for host-side semantic review.
 *
 * @remarks Progress, lifecycle, results, revisions, timestamps, identities, paths and digests are
 * deliberately absent. Routine task transitions therefore cannot perturb reviewer input or its
 * prompt-cache prefix. An exceptionally large plan is omitted atomically instead of exposing a
 * partial specification that could misstate operator intent.
 */
export function planReviewContext(
  document: PlanDocument | undefined,
): OperatorReviewContext | undefined {
  if (document === undefined) return undefined;
  const content = JSON.stringify({
    title: document.title,
    objective: document.objective,
    context: document.context,
    tasks: document.tasks.map(({ title, detail, exit }) => ({
      title,
      ...(detail === undefined ? {} : { detail }),
      ...(exit === undefined ? {} : { exit }),
    })),
    validation: document.validation,
  });
  return content.length > MAX_REVIEW_CONTEXT_CHARS ? undefined : { kind: "plan", content };
}
