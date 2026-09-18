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
import {
  decideCommandStepSchema,
  judgeStepSchema,
  type JudgeTerminalReceipt,
} from "./private-protocol.ts";
import { createJudgeStepMachine, type JudgeStepBinding } from "./step-machine.ts";

/** Corrections use ordinary tool-result continuation, never a second inference loop. */
export const JUDGE_CORRECTION_RETRIES = 3;

const tool = (binding: JudgeStepBinding): NamespacedTool => ({
  fullName: "judge_step",
  wireName: "judge_step",
  mcpName: "",
  toolName: "judge_step",
  description:
    binding.kind === "command"
      ? "Decide the exact command case with action decide_command."
      : "Return exactly the requested private review stage.",
  inputSchema: z.toJSONSchema(
    binding.kind === "command" ? decideCommandStepSchema : judgeStepSchema,
  ),
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
    if (stage === "closed" || stage === "pending" || used >= JUDGE_CORRECTION_RETRIES)
      return { kind: "terminal", result: reject() };
    corrections.set(stage, used + 1);
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
                forcedChoice: () => ({ type: "function", function: { name: "judge_step" } }),
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
    hostFailure: () => hostFailure,
    stage: () => machine.stage(),
    admitResponse(calls: readonly LLMToolCall[] | undefined, _text?: string): boolean {
      const malformed = (reason: string): false => {
        admitted = undefined;
        admissionError = reason;
        return false;
      };
      if (
        invalid ||
        admitted !== undefined ||
        machine.stage() === "closed" ||
        calls?.length !== 1
      ) {
        return malformed("expected_one_tool_call");
      }
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
