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
  constraints?: string[];
  exclusions?: string[];
  assumptions?: string[];
  resetsFormulationOrigin?: boolean;
  limits: Partial<GoalLimits>;
  initial?: {
    objective: string;
    criteria: GoalCriterion[];
    constraints?: string[];
    exclusions?: string[];
    assumptions?: string[];
    limits: Partial<GoalLimits>;
  };
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
    constraints: objective === undefined ? structuredClone(current?.constraints ?? []) : [],
    exclusions: objective === undefined ? structuredClone(current?.exclusions ?? []) : [],
    assumptions: objective === undefined ? structuredClone(current?.assumptions ?? []) : [],
    resetsFormulationOrigin:
      current !== undefined && (current.origin.kind !== "literal" || current.sources.length > 0),
    limits: structuredClone(current?.limits ?? {}),
    ...(current === undefined
      ? {}
      : {
          initial: {
            objective: current.objective,
            criteria: structuredClone(current.criteria),
            constraints: structuredClone(current.constraints),
            exclusions: structuredClone(current.exclusions),
            assumptions: structuredClone(current.assumptions),
            limits: structuredClone(current.limits),
          },
        }),
  };
}

/** Validate editable values locally; the authenticated host remains the schema and CAS authority. */
export function goalDraftAction(draft: GoalDraft): GoalControlAction | undefined {
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
  if (draft.kind !== "edit")
    return {
      kind: draft.kind,
      objective,
      criteria: structuredClone(draft.criteria),
      limits: { ...draft.limits },
    };
  if (draft.initial === undefined) throw new Error("Goal edit draft has no original snapshot.");
  const limits = Object.fromEntries(
    Object.entries(draft.limits).filter(
      ([key, value]) => value !== draft.initial!.limits[key as keyof GoalLimits],
    ),
  ) as Partial<GoalLimits>;
  const objectiveChanged = objective !== draft.initial.objective;
  const criteriaChanged = JSON.stringify(draft.criteria) !== JSON.stringify(draft.initial.criteria);
  const constraintsChanged =
    JSON.stringify(draft.constraints ?? []) !== JSON.stringify(draft.initial.constraints ?? []);
  const exclusionsChanged =
    JSON.stringify(draft.exclusions ?? []) !== JSON.stringify(draft.initial.exclusions ?? []);
  const assumptionsChanged =
    JSON.stringify(draft.assumptions ?? []) !== JSON.stringify(draft.initial.assumptions ?? []);
  if (
    !objectiveChanged &&
    !criteriaChanged &&
    !constraintsChanged &&
    !exclusionsChanged &&
    !assumptionsChanged &&
    Object.keys(limits).length === 0
  )
    return undefined;
  return {
    kind: "edit",
    ...(objectiveChanged ? { objective } : {}),
    ...(criteriaChanged ? { criteria: structuredClone(draft.criteria) } : {}),
    ...(constraintsChanged ? { constraints: structuredClone(draft.constraints ?? []) } : {}),
    ...(exclusionsChanged ? { exclusions: structuredClone(draft.exclusions ?? []) } : {}),
    ...(assumptionsChanged ? { assumptions: structuredClone(draft.assumptions ?? []) } : {}),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
  };
}
