import type { GoalControlAction, GoalCriterion, GoalLimits, GoalView } from "@clarvis/protocol";
import type { GoalBinding } from "./controller.ts";

/** A review pins its session revision; refreshing the visible goal never rewrites this draft. */
export interface GoalDraft {
  kind: "create" | "replace" | "edit";
  expectedRevision: number;
  binding: GoalBinding | null;
  previousObjective?: string;
  objective: string;
  criteria: GoalCriterion[];
  limits: Partial<GoalLimits>;
}

/** Start an explicit user review without mutating or clearing the current goal. */
export function createGoalDraft(
  view: GoalView | undefined,
  binding: GoalBinding | null,
  objective?: string,
): GoalDraft {
  const current = view?.state.current;
  return {
    kind:
      current === undefined
        ? "create"
        : objective !== undefined || current.status === "complete" || current.status === "cancelled"
          ? "replace"
          : "edit",
    expectedRevision: view?.state.revision ?? 0,
    binding: binding === null ? null : { ...binding },
    ...(current === undefined ? {} : { previousObjective: current.objective }),
    objective: objective ?? current?.objective ?? "",
    criteria: objective === undefined ? structuredClone(current?.criteria ?? []) : [],
    limits: structuredClone(current?.limits ?? {}),
  };
}

/** Validate editable values locally; the authenticated host remains the schema and CAS authority. */
export function goalDraftAction(draft: GoalDraft): GoalControlAction {
  const objective = draft.objective.trim();
  if (!objective || objective.length > 16384)
    throw new Error("Enter an objective of 1 to 16384 characters.");
  if (draft.criteria.length > 32) throw new Error("A goal can have at most 32 criteria.");
  for (const [key, value] of Object.entries(draft.limits)) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < (key === "max_auto_continuations" ? 0 : 1))
    )
      throw new Error(
        "Goal limits require whole positive values; automatic continuations may be zero.",
      );
  }
  return {
    kind: draft.kind,
    objective,
    criteria: structuredClone(draft.criteria),
    limits: { ...draft.limits },
  };
}
