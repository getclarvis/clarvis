import type { LLMToolCall } from "@clarvis/capability";
import {
  compiledAuthorityTransitionSchema,
  judgeStepSchema,
  type CompiledAuthorityTransition,
  type JudgeStep,
  type JudgeTerminalReceipt,
} from "./private-protocol.ts";

type CompileStep = Extract<JudgeStep, { action: "compile_authority" }>;
/** Host bindings capture the original case and revisions; model input cannot select them. */
export type JudgeStepBinding =
  | { kind: "command" }
  | { kind: "effects"; transition: CompiledAuthorityTransition }
  | {
      kind: "compile_effects";
      validateAndInstall(
        candidate: CompileStep["candidate"],
      ): Promise<CompiledAuthorityTransition | undefined>;
    };

export type JudgeStepOutcome =
  | { kind: "invalid_response" }
  | { kind: "compiled"; transition: CompiledAuthorityTransition }
  | { kind: "completed"; receipt: JudgeTerminalReceipt };

/**
 * One case, at most one compile transaction and one terminal receipt. A provider
 * response is admitted atomically before any tool dispatch: multiple, missing,
 * foreign or out-of-order calls cannot partially install authority. Host faults
 * propagate unchanged and can never become semantic uncertainty or human fallback.
 */
export function createJudgeStepMachine(binding: JudgeStepBinding) {
  let stage: "command" | "compile" | "effects" | "pending" | "closed" =
    binding.kind === "command" ? "command" : binding.kind === "effects" ? "effects" : "compile";
  let transition =
    binding.kind === "effects"
      ? compiledAuthorityTransitionSchema.parse(binding.transition)
      : undefined;
  return {
    close(): void {
      stage = "closed";
    },
    stage(): string {
      return stage;
    },
    async accept(
      calls: readonly LLMToolCall[] | undefined,
      text?: string,
    ): Promise<JudgeStepOutcome> {
      const invalid = (): JudgeStepOutcome => {
        stage = "closed";
        return { kind: "invalid_response" };
      };
      if (
        stage === "closed" ||
        stage === "pending" ||
        calls?.length !== 1 ||
        (text?.trim().length ?? 0) !== 0
      )
        return invalid();
      const call = calls[0];
      if (call === undefined) return invalid();
      if (call.name !== "judge_step" || call.malformedArguments !== undefined) return invalid();
      let raw: unknown = call.arguments;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          return invalid();
        }
      }
      const parsed = judgeStepSchema.safeParse(raw);
      if (!parsed.success) return invalid();
      const step = parsed.data;
      if (stage === "command" && step.action === "decide_command") {
        stage = "closed";
        return { kind: "completed", receipt: step };
      }
      if (
        stage === "effects" &&
        step.action === "decide_effects" &&
        transition !== undefined &&
        step.revision === transition.revision &&
        step.transition_token === transition.transition_token
      ) {
        stage = "closed";
        return { kind: "completed", receipt: step };
      }
      if (
        stage !== "compile" ||
        step.action !== "compile_authority" ||
        binding.kind !== "compile_effects"
      )
        return invalid();
      stage = "pending";
      try {
        const candidate = await binding.validateAndInstall(step.candidate);
        if (candidate === undefined) return invalid();
        const installed = compiledAuthorityTransitionSchema.parse(candidate);
        if (stage !== "pending") return invalid();
        transition = installed;
        stage = "effects";
        return { kind: "compiled", transition: installed };
      } catch (error) {
        stage = "closed";
        throw error;
      }
    },
  };
}
