import { NOOP_LOGGER, composePromptCacheKey, type Logger } from "@clarvis/capability";
import {
  GoalError,
  blockGoalRun,
  boundedGoalState,
  goalCandidateInputSchema,
  goalCheckpointInputSchema,
  goalProgressInputSchema,
  recordGoalCandidate,
  recordGoalCheckpoint,
  recordGoalProgress,
  validateGoalCandidate,
  type GoalCompletionValidation,
  type GoalRecord,
  type GoalRepository,
  type GoalRuntimeBinding,
  type GoalRuntimePort,
  type GoalState,
} from "@clarvis/goal";
import type { GoalEvidenceSnapshot, GoalEvidenceSource } from "./evidence.ts";
import { goalEvidenceDigest } from "./evidence.ts";
import { kernelError } from "../core/errors.ts";
import { toGoalKernelError } from "./errors.ts";

/** Metadata-only notification emitted after the private session write succeeds. */
export interface GoalRuntimeChange {
  kind: "progress" | "checkpoint" | "candidate" | "blocked";
  session_id: string;
  goal_id: string;
  execution_id: string;
  revision: number;
}

/**
 * Native/guest-neutral host implementation. The repository is already owner/workspace scoped;
 * its closure, binding and evidence reader never come from model arguments. Slow evidence work
 * runs outside the short session transaction, which revalidates authority and observation generation.
 * Successful mutation resolves only after durability; completion is still a separate host commit.
 */
export function createGoalRuntimePort(options: {
  repository: GoalRepository;
  binding: GoalRuntimeBinding;
  evidence: GoalEvidenceSource;
  signal?: AbortSignal;
  logger?: Logger;
  now?: () => number;
  onChange?: (change: GoalRuntimeChange) => void;
}): GoalRuntimePort {
  const binding = Object.freeze({ ...options.binding });
  composePromptCacheKey({
    sessionId: binding.session_id,
    agentInstanceId: binding.agent_instance_id,
  });
  const logger = options.logger ?? NOOP_LOGGER;
  const now = options.now ?? Date.now;
  const alive = (signal?: AbortSignal): void => {
    if (options.signal?.aborted || signal?.aborted)
      throw kernelError("cancelled", "Goal execution or operation was cancelled");
  };
  const bound = (
    input: GoalState | undefined,
    mode: "read" | "write" | "validate" | "stop",
    signal?: AbortSignal,
  ): { state: GoalState; goal: GoalRecord } => {
    alive(signal);
    if (input === undefined) throw new GoalError("not_found", "Goal state is absent");
    const state = boundedGoalState(input, true);
    const goal = state.current;
    const run = goal?.runs.at(-1);
    if (
      goal?.goal_id !== binding.goal_id ||
      goal.session_id !== binding.session_id ||
      goal.objective_revision !== binding.objective_revision ||
      run?.execution_id !== binding.execution_id ||
      run.objective_revision !== binding.objective_revision
    )
      throw new GoalError("conflict", "Goal operation is outside its execution binding");
    if (mode !== "stop") {
      if (goal.status !== "active" && goal.status !== "paused")
        throw new GoalError("blocked", "Goal is no longer accepting stage operations");
      const phaseAllowed =
        run.phase === "running" ||
        (mode === "read" &&
          run.phase === "preparing" &&
          goal.status === "active" &&
          run.control_revision === goal.control_revision) ||
        (mode === "validate" && run.phase === "settling");
      if (!phaseAllowed)
        throw new GoalError("conflict", "Goal execution is not in the required physical phase");
    }
    return { state, goal };
  };
  const guard = async <T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    try {
      alive(signal);
      const result = await action();
      alive(signal);
      return result;
    } catch (error) {
      const mapped = toGoalKernelError(error);
      logger.warn(
        { event: "goal.operation.failed", execution_id: binding.execution_id, code: mapped.code },
        "Bound goal operation failed",
      );
      throw mapped;
    }
  };
  const snapshot = async (mode: "read" | "write" | "validate" = "read", signal?: AbortSignal) => {
    const { goal } = bound(await options.repository.read(binding.session_id), mode, signal);
    const evidence = await options.evidence.snapshot(goal);
    const current = bound(await options.repository.read(binding.session_id), mode, signal).goal;
    return { goal: current, evidence };
  };
  const mutate = async <T>(
    kind: GoalRuntimeChange["kind"],
    evidence: GoalEvidenceSnapshot | undefined,
    mutation: (state: GoalState) => { state: GoalState; result: T },
    signal?: AbortSignal,
  ): Promise<T> => {
    const committed = await options.repository.transact(binding.session_id, (previous) => {
      const { state } = bound(previous, kind === "blocked" ? "stop" : "write", signal);
      if (evidence !== undefined && options.evidence.generation !== evidence.generation)
        throw new GoalError("conflict", "Goal evidence changed before publication");
      const result = mutation(state);
      return {
        state: result.state,
        result: {
          value: result.result,
          revision: result.state.revision,
          changed: result.state.revision !== state.revision,
        },
      };
    });
    if (committed.changed) {
      try {
        options.onChange?.({
          kind,
          session_id: binding.session_id,
          goal_id: binding.goal_id,
          execution_id: binding.execution_id,
          revision: committed.revision,
        });
      } catch {
        logger.warn(
          { event: "goal.notification.failed", execution_id: binding.execution_id },
          "Goal state is durable but its observer failed",
        );
      }
    }
    return committed.value;
  };
  const validateCompletion = (signal?: AbortSignal): Promise<GoalCompletionValidation> =>
    guard(async () => {
      const { goal, evidence } = await snapshot("validate", signal);
      if (goal.candidate?.execution_id !== binding.execution_id)
        return {
          valid: false,
          reasons: ["The current stage has no completion candidate"],
          qualitative_criteria: [],
          revision: goal.revision,
        };
      const result = await validateGoalCandidate(goal, goal.candidate, evidence);
      const latest = bound(
        await options.repository.read(binding.session_id),
        "validate",
        signal,
      ).goal;
      if (
        latest.revision !== goal.revision ||
        options.evidence.generation !== evidence.generation ||
        goalEvidenceDigest(latest.candidate) !== goalEvidenceDigest(goal.candidate)
      )
        return {
          valid: false,
          reasons: ["Goal or evidence changed during completion validation"],
          qualitative_criteria: result.qualitative_criteria,
          revision: latest.revision,
        };
      return result;
    }, signal);
  return {
    binding,
    logger,
    read: (signal) =>
      guard(async () => {
        const { goal, evidence } = await snapshot("read", signal);
        return { goal, evidence: evidence.catalog };
      }, signal),
    progress: (input, signal) =>
      guard(async () => {
        const parsed = goalProgressInputSchema.parse(input);
        const { evidence } = await snapshot("write", signal);
        const progress = {
          summary: parsed.summary,
          evidence: evidence.resolve(parsed.evidence_ids),
        };
        await mutate(
          "progress",
          evidence,
          (state) => ({
            state: recordGoalProgress(state, { ...binding, progress, now: now() }),
            result: undefined,
          }),
          signal,
        );
      }, signal),
    checkpoint: (input, signal) =>
      guard(async () => {
        const parsed = goalCheckpointInputSchema.parse(input);
        const { evidence } = await snapshot("write", signal);
        const checkpoint = {
          summary: parsed.summary,
          next_step: parsed.next_step,
          evidence: evidence.resolve(parsed.evidence_ids),
          ...evidence.progress(parsed.evidence_ids),
        };
        return mutate(
          "checkpoint",
          evidence,
          (state) => {
            const next = recordGoalCheckpoint(state, { ...binding, checkpoint, now: now() });
            return { state: next, result: next.current!.runs.at(-1)!.checkpoint! };
          },
          signal,
        );
      }, signal),
    candidate: (input, signal) =>
      guard(async () => {
        const parsed = goalCandidateInputSchema.parse(input);
        const { evidence } = await snapshot("write", signal);
        const candidate = {
          summary: parsed.summary,
          execution_id: binding.execution_id,
          objective_revision: binding.objective_revision,
          assessments: parsed.assessments.map(({ evidence_ids, ...assessment }) => ({
            ...assessment,
            evidence: evidence.resolve(evidence_ids),
          })),
        };
        await mutate(
          "candidate",
          evidence,
          (state) => ({
            state: recordGoalCandidate(state, { ...binding, candidate, now: now() }),
            result: undefined,
          }),
          signal,
        );
        return validateCompletion(signal);
      }, signal),
    validateCompletion,
    blocked: (reason, signal) =>
      guard(async () => {
        await mutate(
          "blocked",
          undefined,
          (state) => ({
            state: blockGoalRun(state, { ...binding, reason, now: now() }),
            result: undefined,
          }),
          signal,
        );
      }, signal),
  };
}
