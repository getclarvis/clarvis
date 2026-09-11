import type { GoalCandidate, GoalCriterion, GoalEvidenceRef, GoalRecord } from "./schemas.ts";

/** Host evidence lookup checks the declared result and current digest, not the model's prose. */
export interface GoalEvidenceVerifier {
  verify(
    reference: GoalEvidenceRef,
    criterion: GoalCriterion,
  ): Promise<{ valid: boolean; reason?: string }>;
}

export interface GoalCompletionValidation {
  valid: boolean;
  reasons: string[];
  qualitative_criteria: string[];
  /** Exact durable goal-state revision fenced by this validation. */
  revision: number;
}

/** Check exact criterion coverage and scoped evidence; qualitative judgments remain explicitly labeled. */
export async function validateGoalCandidate(
  goal: GoalRecord,
  candidate: GoalCandidate,
  verifier: GoalEvidenceVerifier,
): Promise<GoalCompletionValidation> {
  const reasons: string[] = [];
  const qualitative_criteria: string[] = [];
  if (candidate.objective_revision !== goal.objective_revision)
    reasons.push("Candidate refers to an obsolete objective revision");
  if (
    !goal.runs.some(
      (run) =>
        run.execution_id === candidate.execution_id &&
        run.objective_revision === goal.objective_revision,
    )
  )
    reasons.push("Candidate execution is not bound to this objective");
  const criteria: GoalCriterion[] =
    goal.criteria.length === 0
      ? [{ id: "objective", description: goal.objective, kind: "qualitative" }]
      : goal.criteria;
  if (
    candidate.assessments.length !== criteria.length ||
    new Set(candidate.assessments.map((value) => value.criterion_id)).size !== criteria.length
  )
    reasons.push("Candidate must assess every current criterion exactly once");
  for (const assessment of candidate.assessments) {
    const criterion = criteria.find((value) => value.id === assessment.criterion_id);
    if (criterion === undefined || criterion.kind !== assessment.kind) {
      reasons.push(
        `Criterion ${assessment.criterion_id} is absent or has a different assessment type`,
      );
      continue;
    }
    if (criterion.kind === "qualitative") {
      qualitative_criteria.push(criterion.id);
    } else if (criterion.kind === "human") {
      if (
        !goal.human_acceptances.some(
          (acceptance) =>
            acceptance.criterion_id === criterion.id &&
            acceptance.objective_revision === goal.objective_revision,
        )
      )
        reasons.push(`Criterion ${criterion.id} requires a recorded user decision`);
    } else if (assessment.evidence.length === 0) {
      reasons.push(`Criterion ${criterion.id} requires host-verifiable evidence`);
    }
    for (const evidence of assessment.evidence) {
      if (
        evidence.goal_id !== goal.goal_id ||
        evidence.objective_revision !== goal.objective_revision ||
        !goal.runs.some(
          (run) =>
            run.execution_id === evidence.execution_id &&
            run.objective_revision === goal.objective_revision,
        )
      ) {
        reasons.push(`Evidence ${evidence.id} is outside this objective revision`);
        continue;
      }
      const result = await verifier.verify(evidence, criterion);
      if (!result.valid)
        reasons.push(result.reason ?? `Evidence ${evidence.id} is invalid or stale`);
    }
  }
  return { valid: reasons.length === 0, reasons, qualitative_criteria, revision: goal.revision };
}
