import type { LLMToolCall } from "@clarvis/capability";
import {
  compiledAuthorityTransitionSchema,
  judgeStepSchema,
  type CompiledAuthorityTransition,
  type JudgeStep,
  type JudgeTerminalReceipt,
} from "./private-protocol.ts";

type CompileStep = Extract<JudgeStep, { action: "compile_authority" }>;
/** Closed, content-free reasons the host may return for a rejected authority candidate. */
export type AuthorityCandidateRejection =
  | "stale_context"
  | "invalid_shape"
  | "revision_mismatch"
  | "duplicate_id"
  | "objective_reference"
  | "effect_not_inferable"
  | "grant_constraints"
  | "grant_reference"
  | "grant_not_covered"
  | "ceiling_mismatch"
  | "invalid_exclusion"
  | "missing_exclusion"
  | "blocked_effect";
/** Host bindings capture the original case and revisions; model input cannot select them. */
export type JudgeStepBinding =
  | { kind: "command" }
  | { kind: "effects"; transition: CompiledAuthorityTransition }
  | {
      kind: "compile_effects";
      validateAndInstall(
        candidate: CompileStep["candidate"],
      ): Promise<
        CompiledAuthorityTransition | { rejected: AuthorityCandidateRejection } | undefined
      >;
    };

export type JudgeStepOutcome =
  | { kind: "invalid_response"; reason?: string }
  | { kind: "compiled"; transition: CompiledAuthorityTransition }
  | { kind: "completed"; receipt: JudgeTerminalReceipt };

/**
 * One case, at most one authority installation and one terminal receipt. A provider
 * response is admitted atomically before any tool dispatch: multiple, missing,
 * foreign or out-of-order calls cannot partially install authority. Host faults
 * propagate unchanged and can never become semantic uncertainty or human fallback.
 */
export function createJudgeStepMachine(
  binding: JudgeStepBinding,
  validateReceipt?: (receipt: JudgeTerminalReceipt) => boolean,
) {
  let stage: "command" | "compile" | "effects" | "pending" | "closed" =
    binding.kind === "command" ? "command" : binding.kind === "effects" ? "effects" : "compile";
  let transition =
    binding.kind === "effects"
      ? compiledAuthorityTransitionSchema.parse(binding.transition)
      : undefined;
  const validReceipt = (receipt: JudgeTerminalReceipt): boolean => {
    try {
      return validateReceipt?.(receipt) !== false;
    } catch (error) {
      stage = "closed";
      throw error;
    }
  };
  return {
    close(): void {
      stage = "closed";
    },
    stage(): string {
      return stage;
    },
    async accept(
      calls: readonly LLMToolCall[] | undefined,
      _text?: string,
    ): Promise<JudgeStepOutcome> {
      const invalid = (reason = "unexpected_action_or_transition"): JudgeStepOutcome => {
        if (stage === "pending") stage = "closed";
        return { kind: "invalid_response", reason };
      };
      if (stage === "closed" || stage === "pending" || calls?.length !== 1)
        return invalid("invalid_response_shape");
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
      if (!parsed.success) return invalid("invalid_step_schema");
      const step = parsed.data;
      if (stage === "command" && step.action === "decide_command") {
        if (!validReceipt(step)) return invalid("host_receipt_rejected");
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
        if (!validReceipt(step)) return invalid("host_receipt_rejected");
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
        if (candidate === undefined || "rejected" in candidate) {
          if (stage === "pending") stage = "compile";
          return invalid(
            candidate === undefined
              ? "authority_candidate_rejected"
              : `authority_candidate_rejected:${candidate.rejected}`,
          );
        }
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
