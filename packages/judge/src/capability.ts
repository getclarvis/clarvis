import {
  portKey,
  type Capability,
  type CapabilityRequestView,
  type RunCapabilityContext,
} from "@clarvis/capability";
import {
  createJudgeCoordinator,
  type JudgeCoordinator,
  type JudgeCoordinatorOptions,
} from "./coordinator.ts";

export const JUDGE_CAPABILITY_NAME = "judge";
export const JUDGE_PORT = portKey<JudgeCoordinator>("judge.coordinator");

/** Bind synchronously from host-owned dependencies; peer ports must be read lazily by review callbacks. */
export interface JudgeCapabilityOptions {
  requiredFor(view: CapabilityRequestView): boolean;
  bind(
    context: RunCapabilityContext,
  ): Omit<
    JudgeCoordinatorOptions,
    "owner" | "workExecutionId" | "sessionId" | "executionBaseLlm" | "promptCacheTtl" | "signal"
  >;
}

/** Public product capability owns exactly one coordinator for each physical work run. */
export function createJudgeCapability(options: JudgeCapabilityOptions): Capability {
  return {
    name: JUDGE_CAPABILITY_NAME,
    requiredFor: (view) => options.requiredFor(view),
    forRun(context) {
      const bound = options.bind(context);
      const coordinator = createJudgeCoordinator({
        ...bound,
        owner: context.owner,
        workExecutionId: context.executionId,
        sessionId: context.request.session_id ?? context.executionId,
        executionBaseLlm: context.executionBaseLlm,
        promptCacheTtl: context.resolvedPromptCacheTtl,
        signal: context.signal,
      });
      context.services.provide(JUDGE_PORT, coordinator);
      return {
        name: JUDGE_CAPABILITY_NAME,
        forAgent: (scope) => (scope.entry ? { attach: () => ({}) } : null),
        onRunEnd: () => coordinator.close(),
      };
    },
  };
}
