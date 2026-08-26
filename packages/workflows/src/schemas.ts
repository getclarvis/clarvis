/**
 * Reusable `expect_schema` shapes for the three leader rounds a manager runs
 * again and again: discovery, findings, and adversarial verdicts.
 *
 * @remarks A `run_leader` call's `expect_schema` becomes the leader run's
 *   `output_schema`, which the loop compiles before the run starts and rejects
 *   with `invalid_output_schema` unless its top-level `type` is `"object"`. Every
 *   schema here satisfies that, so a manager can hand one straight to
 *   `run_leader` without inventing (and mis-shaping) its own. They are the single
 *   source of truth behind the `<result_schemas>` block of the shipped
 *   `admiral` agent template; a test asserts the two never drift.
 *
 *   Each requires an evidence field on purpose: a schema that lets a leader
 *   return a bare claim invites exactly the unverifiable report the manager then
 *   has to spend another leader refuting.
 */
import { TASK_TITLE_MAX } from "@clarvis/capability";
import { WORKFLOW_LIMITS } from "./limits.ts";

export { WORKFLOW_LIMITS } from "./limits.ts";

/**
 * A JSON Schema describing one structured leader result.
 *
 * @remarks Deliberately loose — the loop validates the schema itself, and this
 *   module only needs to hand it across unchanged.
 */
export type WorkflowResultSchema = Record<string, unknown>;

/**
 * The discovery round: one leader maps the problem before any fan-out, returning
 * the decomposition the manager will spread across the next round.
 *
 * @remarks `work_items[].mutation` is what lets the manager partition writers
 *   from readers, and `work_items[].files` is what lets it prove two mutating
 *   items do not overlap — the check that keeps concurrent leaders from
 *   corrupting a shared workspace. `unknowns` keeps a leader from silently
 *   guessing past the edge of what it could observe.
 */
export const DISCOVERY_SCHEMA: WorkflowResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: {
      type: "string",
      maxLength: WORKFLOW_LIMITS.textChars,
      description: "What this leader actually inspected.",
    },
    evidence: {
      type: "array",
      maxItems: WORKFLOW_LIMITS.resultItems,
      description: "Observations that ground the decomposition below.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", maxLength: WORKFLOW_LIMITS.pathChars },
          observation: { type: "string", maxLength: WORKFLOW_LIMITS.textChars },
        },
        required: ["path", "observation"],
      },
    },
    work_items: {
      type: "array",
      maxItems: WORKFLOW_LIMITS.workItems,
      description: "The independent units the manager can hand to separate leaders.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: WORKFLOW_LIMITS.identifierChars },
          title: {
            type: "string",
            minLength: 1,
            maxLength: TASK_TITLE_MAX,
            description: "A short human-facing label for the leader that will execute this item.",
          },
          goal: { type: "string", maxLength: WORKFLOW_LIMITS.textChars },
          files: {
            type: "array",
            maxItems: WORKFLOW_LIMITS.filesPerWorkItem,
            description:
              "Files this item would read or change; the manager uses it to prove two mutating items do not overlap.",
            items: { type: "string", maxLength: WORKFLOW_LIMITS.pathChars },
          },
          dependencies: {
            type: "array",
            maxItems: WORKFLOW_LIMITS.dependenciesPerWorkItem,
            description: "Ids of work items that must finish first.",
            items: { type: "string", maxLength: WORKFLOW_LIMITS.identifierChars },
          },
          mutation: {
            type: "boolean",
            description: "True when the item writes to the workspace.",
          },
        },
        required: ["id", "title", "goal", "files", "dependencies", "mutation"],
      },
    },
    unknowns: {
      type: "array",
      maxItems: WORKFLOW_LIMITS.resultItems,
      description: "What could not be determined, and would change the plan if resolved.",
      items: { type: "string", maxLength: WORKFLOW_LIMITS.textChars },
    },
  },
  required: ["scope", "evidence", "work_items", "unknowns"],
};

/**
 * The finding round: one leader reviews through a single lens and returns
 * homogeneous, comparable findings the manager can deduplicate across lenses.
 *
 * @remarks `needs_verification` and `confidence` are what let the manager spend
 *   its verification budget on the findings that warrant it rather than on all of
 *   them; `coverage_gaps` is the honest counterweight to a finding list that
 *   would otherwise read as exhaustive.
 */
export const FINDINGS_SCHEMA: WorkflowResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      maxItems: WORKFLOW_LIMITS.resultItems,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: WORKFLOW_LIMITS.identifierChars },
          title: {
            type: "string",
            minLength: 1,
            maxLength: TASK_TITLE_MAX,
            description: "A short label for this finding when another leader verifies it.",
          },
          claim: {
            type: "string",
            maxLength: WORKFLOW_LIMITS.textChars,
            description: "The defect or conclusion, in one sentence.",
          },
          evidence: {
            type: "array",
            maxItems: WORKFLOW_LIMITS.resultItems,
            description: "Observed support, cited as path:line where a line was seen.",
            items: { type: "string", maxLength: WORKFLOW_LIMITS.textChars },
          },
          impact: {
            type: "string",
            maxLength: WORKFLOW_LIMITS.textChars,
            description: "What breaks, and for whom.",
          },
          confidence: { enum: ["low", "medium", "high"] },
          needs_verification: {
            type: "boolean",
            description:
              "True when an independent leader should try to refute this before it is acted on.",
          },
        },
        required: [
          "id",
          "title",
          "claim",
          "evidence",
          "impact",
          "confidence",
          "needs_verification",
        ],
      },
    },
    coverage_gaps: {
      type: "array",
      maxItems: WORKFLOW_LIMITS.resultItems,
      description: "What this lens did not cover: areas sampled, skipped, or unreadable.",
      items: { type: "string", maxLength: WORKFLOW_LIMITS.textChars },
    },
  },
  required: ["findings", "coverage_gaps"],
};

/**
 * The adversarial round: one leader is sent to refute a single finding and
 * returns a verdict grounded in what it could observe.
 *
 * @remarks `inconclusive` exists so a leader that could not reach the evidence
 *   says so instead of confirming by default — the failure mode that makes a
 *   verification round decorative.
 */
export const VERDICT_SCHEMA: WorkflowResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    finding_id: {
      type: "string",
      maxLength: WORKFLOW_LIMITS.identifierChars,
      description: "The id of the finding under test.",
    },
    verdict: { enum: ["confirmed", "refuted", "inconclusive"] },
    evidence: {
      type: "array",
      maxItems: WORKFLOW_LIMITS.resultItems,
      description: "What was observed while trying to refute the claim.",
      items: { type: "string", maxLength: WORKFLOW_LIMITS.textChars },
    },
    reason: {
      type: "string",
      maxLength: WORKFLOW_LIMITS.textChars,
      description: "Why the evidence supports this verdict.",
    },
  },
  required: ["finding_id", "verdict", "evidence", "reason"],
};

/**
 * The three schemas keyed by round, for a host or test that needs to iterate
 * them rather than name them.
 */
export const WORKFLOW_RESULT_SCHEMAS: Readonly<Record<string, WorkflowResultSchema>> = {
  discovery: DISCOVERY_SCHEMA,
  findings: FINDINGS_SCHEMA,
  verdict: VERDICT_SCHEMA,
};
