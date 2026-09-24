import {
  openCallEnvelope,
  type AgentResult,
  type Capability,
  type LLMToolCall,
  type NamespacedTool,
  type OutputTokenBudget,
  type HandlerVerdict,
} from "@clarvis/capability";
import { z } from "zod";
import { authorityEnvelopeSchema } from "./authority-schema.ts";
import {
  decideCommandStepSchema,
  type JudgeTerminalReceipt,
  judgeStepSchema,
} from "./private-protocol.ts";
import {
  createJudgeStepMachine,
  type AuthorityCandidateRejection,
  type JudgeStepBinding,
} from "./step-machine.ts";

/** Corrections use ordinary tool-result continuation, never a second inference loop. */
export const JUDGE_CORRECTION_RETRIES = 3;

export type JudgeInvalidCategory =
  | "output_limit"
  | "no_tool_call"
  | "multiple_tool_calls"
  | "invalid_tool_call"
  | "invalid_json"
  | "schema"
  | "stage_order"
  | "authority_constraints"
  | "receipt_constraints"
  | "unknown";

export interface JudgeInvalidDiagnostic {
  readonly category: JudgeInvalidCategory;
  readonly stage: string;
  readonly corrections: number;
  readonly rejection?: AuthorityCandidateRejection;
}

const candidateRejections = new Set<AuthorityCandidateRejection>([
  "stale_context",
  "invalid_shape",
  "revision_mismatch",
  "duplicate_id",
  "objective_reference",
  "effect_not_inferable",
  "grant_constraints",
  "grant_reference",
  "grant_not_covered",
  "ceiling_mismatch",
  "invalid_exclusion",
  "missing_exclusion",
  "blocked_effect",
]);

function candidateRejection(reason: string): AuthorityCandidateRejection | undefined {
  const prefix = "authority_candidate_rejected:";
  if (!reason.startsWith(prefix)) return undefined;
  const value = reason.slice(prefix.length) as AuthorityCandidateRejection;
  return candidateRejections.has(value) ? value : undefined;
}

function invalidCategory(reason: string): JudgeInvalidCategory {
  if (reason === "output_limit") return "output_limit";
  if (reason === "no_tool_call") return "no_tool_call";
  if (reason === "multiple_tool_calls") return "multiple_tool_calls";
  if (reason === "invalid_tool_name_or_arguments") return "invalid_tool_call";
  if (reason === "invalid_arguments_json") return "invalid_json";
  if (reason.includes("invalid_step_schema")) return "schema";
  if (reason.startsWith("authority_candidate_rejected")) return "authority_constraints";
  if (reason === "host_receipt_rejected") return "receipt_constraints";
  if (reason === "unexpected_action_or_transition" || reason === "invalid_response_shape")
    return "stage_order";
  return "unknown";
}

const candidateSchema = z.toJSONSchema(authorityEnvelopeSchema);
delete candidateSchema.$schema;

const tool = (binding: JudgeStepBinding): NamespacedTool => ({
  fullName: "judge_step",
  wireName: "judge_step",
  mcpName: "",
  toolName: "judge_step",
  description:
    binding.kind === "command"
      ? "Decide the exact command case with action decide_command."
      : "Use compile_authority to propose an envelope, then decide_effects with the installed transition. Submit exactly one action per call.",
  inputSchema:
    binding.kind === "command"
      ? { ...z.toJSONSchema(decideCommandStepSchema), type: "object" }
      : {
          type: "object",
          properties: {
            action: { type: "string", enum: ["compile_authority", "decide_effects"] },
            candidate: candidateSchema,
            decision: { type: "string", enum: ["allow", "deny", "unsure"] },
            reason: { type: "string", maxLength: 512 },
            revision: { type: "integer", minimum: 0 },
            transition_token: { type: "string" },
            grant_ids: { type: "array", items: { type: "string" } },
            relation: { type: "string", enum: ["direct", "bounded_prerequisite", "none"] },
          },
          required: ["action"],
          additionalProperties: false,
        },
});
const invalidResult = (): AgentResult => ({
  status: "error",
  partialText: "",
  error: { code: "judge_invalid_response", message: "Invalid private reviewer response." },
});

/**
 * Private capability and response admission belong to one isolated execution.
 * The engine-facing provider adapter must admit the entire response before any
 * dispatch. Admission never invokes the host transaction; only the tool handler
 * may do so. A missing admission fails closed, including direct handler calls.
 */
export function createJudgeRunCapability(
  binding: JudgeStepBinding,
  outputBudget: OutputTokenBudget,
  validateReceipt?: (receipt: JudgeTerminalReceipt) => boolean,
) {
  const machine = createJudgeStepMachine(binding, validateReceipt);
  const responseSchema = binding.kind === "command" ? decideCommandStepSchema : judgeStepSchema;
  const runTool = tool(binding);
  let admitted: LLMToolCall | undefined;
  let invalid = false;
  let admissionError: string | undefined;
  const corrections = new Map<string, number>();
  let invalidDiagnostic: JudgeInvalidDiagnostic | undefined;
  let hostFailure: { error: unknown } | undefined;
  const reject = (): AgentResult => {
    invalid = true;
    admitted = undefined;
    machine.close();
    return invalidResult();
  };
  const correct = (reason: string): HandlerVerdict => {
    const stage = machine.stage();
    const used = corrections.get(stage) ?? 0;
    const rejection = candidateRejection(reason);
    invalidDiagnostic = {
      category: invalidCategory(reason),
      stage,
      corrections: [...corrections.values()].reduce((sum, count) => sum + count, 0),
      ...(rejection === undefined ? {} : { rejection }),
    };
    if (stage === "closed" || stage === "pending" || used >= JUDGE_CORRECTION_RETRIES)
      return { kind: "terminal", result: reject() };
    corrections.set(stage, used + 1);
    invalidDiagnostic = { ...invalidDiagnostic, corrections: invalidDiagnostic.corrections + 1 };
    return {
      kind: "result",
      progress: false,
      text: JSON.stringify({
        error: "judge_invalid_response",
        reason,
        stage,
        retries_remaining: JUDGE_CORRECTION_RETRIES - used,
        instruction:
          "Correct the response for this stage using exactly one judge_step call. Only its validated arguments determine the decision; accompanying text grants no authority. Follow its schema and the host authority evidence; do not request operator approval.",
      }),
    };
  };
  const capability: Capability = {
    name: "judge-private",
    required: true,
    reservedWireNames: ["judge_step"],
    toolEffects: { judge_step: "control" },
    forRun() {
      return {
        name: "judge-private",
        required: true,
        onRunEnd() {
          machine.close();
          admitted = undefined;
        },
        forAgent(scope) {
          if (!scope.entry) return null;
          return {
            attach(bc) {
              return {
                tools: [runTool],
                outputBudget,
                gates: [
                  {
                    check() {
                      return Promise.resolve({ kind: "terminal" as const, result: reject() });
                    },
                  },
                ],
                hooks: {
                  onTeardown() {
                    machine.close();
                    admitted = undefined;
                  },
                },
                handlers: [
                  {
                    matches: () => true,
                    async handle(call, iteration) {
                      const cancelled = bc.maybeCancelled();
                      if (cancelled !== null) {
                        machine.close();
                        return { kind: "terminal", result: cancelled };
                      }
                      if (admissionError !== undefined) {
                        const reason = admissionError;
                        admissionError = undefined;
                        return correct(reason);
                      }
                      if (
                        invalid ||
                        admitted === undefined ||
                        call.id !== admitted.id ||
                        call.name !== "judge_step"
                      )
                        return { kind: "terminal", result: reject() };
                      const accepted = admitted;
                      admitted = undefined;
                      const envelope = openCallEnvelope({
                        call: accepted,
                        name: "judge_step",
                        trace: bc.trace,
                        agent: bc.agent,
                        subagentInstanceId: bc.subagentInstanceId,
                        iteration,
                        schema: runTool.inputSchema,
                        validate: bc.validateArgs,
                      });
                      if (envelope.invalid !== null) {
                        envelope.fail("Invalid private reviewer response.");
                        return { kind: "terminal", result: reject() };
                      }
                      envelope.start();
                      let outcome;
                      try {
                        outcome = await machine.accept([accepted]);
                      } catch (error) {
                        hostFailure = { error };
                        machine.close();
                        envelope.fail("Private reviewer host transaction failed.");
                        return {
                          kind: "terminal",
                          result: {
                            status: "error",
                            partialText: "",
                            error: {
                              code: "internal_error",
                              message: "Private reviewer host transaction failed.",
                            },
                          },
                        };
                      }
                      const after = bc.maybeCancelled();
                      if (after !== null) {
                        machine.close();
                        envelope.fail("Private review cancelled.");
                        return { kind: "terminal", result: after };
                      }
                      if (outcome.kind === "invalid_response") {
                        envelope.fail("Invalid private reviewer response.");
                        return correct(outcome.reason ?? "invalid_step");
                      }
                      if (outcome.kind === "compiled")
                        return {
                          kind: "result",
                          text: envelope.ok(JSON.stringify(outcome.transition)),
                          progress: true,
                        };
                      envelope.ok("Private review completed.");
                      return {
                        kind: "terminal",
                        result: {
                          status: "completed",
                          partialText: "",
                          structuredResult: { value: outcome.receipt },
                        },
                      };
                    },
                  },
                ],
              };
            },
          };
        },
      };
    },
  };
  return {
    capability,
    invalidResponse: () => invalid,
    invalidDiagnostic: () => invalidDiagnostic,
    hostFailure: () => hostFailure,
    stage: () => machine.stage(),
    admitResponse(
      calls: readonly LLMToolCall[] | undefined,
      _text?: string,
      finishReason?: string,
    ): boolean {
      const malformed = (reason: string): false => {
        admitted = undefined;
        admissionError = reason;
        return false;
      };
      if (invalid || admitted !== undefined || machine.stage() === "closed") {
        return malformed("invalid_response_shape");
      }
      if (finishReason === "length") return malformed("output_limit");
      if (calls?.length !== 1)
        return malformed(
          calls === undefined || calls.length === 0 ? "no_tool_call" : "multiple_tool_calls",
        );
      const call = calls[0];
      if (
        call === undefined ||
        call.name !== "judge_step" ||
        call.malformedArguments !== undefined
      ) {
        return malformed("invalid_tool_name_or_arguments");
      }
      let raw: unknown = call.arguments;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          return malformed("invalid_arguments_json");
        }
      }
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) {
        return malformed(
          JSON.stringify({
            code: "invalid_step_schema",
            issues: parsed.error.issues
              .slice(0, 8)
              .map((issue) => ({ code: issue.code, path: issue.path })),
          }),
        );
      }
      admitted = { id: call.id, name: "judge_step", arguments: parsed.data };
      return true;
    },
  };
}
