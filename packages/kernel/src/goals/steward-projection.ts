import { sanitizeText } from "@clarvis/capability";
import type { GoalRecord, GoalStewardFinalizeAttempt } from "@clarvis/goal";
import { stewardDefinition, stewardDigest } from "./steward-input.ts";

const STEWARD_FRAME_MAX_BYTES = 96 * 1024;
const STEWARD_REPORT_MAX_BYTES = 32 * 1024;

export class StewardProjectionError extends Error {
  constructor(
    readonly code: "report_too_large" | "irreducible",
    message: string,
  ) {
    super(message);
    this.name = "StewardProjectionError";
  }
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function reportFrom(goal: GoalRecord, attempt: GoalStewardFinalizeAttempt) {
  const candidate =
    goal.candidate === undefined
      ? undefined
      : {
          summary: sanitizeText(goal.candidate.summary),
          assessments: goal.candidate.assessments.map(({ criterion_id, kind, justification }) => ({
            criterion_id,
            kind,
            justification: sanitizeText(justification),
          })),
        };
  const proposed =
    attempt.mode === "text" ? attempt.text : (attempt.submitted_value ?? attempt.text);
  const proposedText = typeof proposed === "string" ? proposed : JSON.stringify(proposed ?? null);
  const duplicate = candidate !== undefined && proposedText.trim() === candidate.summary.trim();
  return {
    report: candidate,
    ...(duplicate || proposedText.trim().length === 0
      ? {}
      : { proposed_final: JSON.parse(sanitizeText(JSON.stringify(attempt))) as unknown }),
  };
}

/** Conversational Steward frame: Goal contract plus selected operator and work-agent turns. */
export function buildStewardConversationFrame(input: {
  goal: GoalRecord;
  attempt: GoalStewardFinalizeAttempt;
  operatorRequest: string;
  corrections: readonly { text: string }[];
  dialogue: readonly {
    speaker: "steward" | "work_agent";
    kind: "question" | "answer";
    text: string;
  }[];
  includeContract?: boolean;
}): {
  frame: string;
  digest: string;
  speakers: Array<{
    speaker: "operator" | "work_agent" | "steward";
    kind: "request" | "correction" | "report" | "question" | "answer";
  }>;
} {
  const definition = stewardDefinition(input.goal);
  const payload = reportFrom(input.goal, input.attempt);
  if (payload.report !== undefined && bytes(payload.report) > STEWARD_REPORT_MAX_BYTES)
    throw new StewardProjectionError(
      "report_too_large",
      "Condense the completion report; it exceeds the Steward review bound.",
    );
  const speakers: Array<{
    speaker: "operator" | "work_agent" | "steward";
    kind: "request" | "correction" | "report" | "question" | "answer";
  }> = [{ speaker: "operator", kind: "request" }];
  for (let i = 0; i < input.corrections.length; i++)
    speakers.push({ speaker: "operator", kind: "correction" });
  if (payload.report !== undefined) speakers.push({ speaker: "work_agent", kind: "report" });
  for (const turn of input.dialogue) speakers.push({ speaker: turn.speaker, kind: turn.kind });
  const includeContract = input.includeContract !== false;
  const frameObject = {
    policy:
      "Evaluate the persisted Goal against the work agent's explanatory report. You have no tools and do not audit artifacts independently.",
    ...(includeContract
      ? {
          definition,
          operator_request: {
            origin: "operator" as const,
            text: sanitizeText(input.operatorRequest),
          },
          operator_corrections: input.corrections.map((item) => ({
            origin: "operator" as const,
            text: sanitizeText(item.text),
          })),
        }
      : {}),
    ...payload,
    dialogue: input.dialogue.map((turn) => ({
      speaker: turn.speaker,
      kind: turn.kind,
      text: sanitizeText(turn.text),
    })),
  };
  const frame = JSON.stringify(frameObject);
  if (Buffer.byteLength(frame, "utf8") > STEWARD_FRAME_MAX_BYTES) {
    if (
      bytes(definition) + Buffer.byteLength(input.operatorRequest, "utf8") >
      STEWARD_FRAME_MAX_BYTES
    )
      throw new StewardProjectionError(
        "irreducible",
        "Goal Steward frame exceeds its bound after removing optional fields",
      );
    throw new StewardProjectionError(
      "report_too_large",
      "Condense the completion report and dialogue; the Steward frame exceeds its bound.",
    );
  }
  return { frame, digest: stewardDigest(frameObject), speakers };
}
