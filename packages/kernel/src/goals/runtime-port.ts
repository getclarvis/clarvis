import {
  NOOP_LOGGER,
  composePromptCacheKey,
  type FinalizeAttempt,
  type Logger,
  type TraceEvent,
} from "@clarvis/capability";
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
  recordGoalVerification,
  currentGoalVerification,
  goalFinalAttemptDigest,
  validateGoalVerificationResult,
  verificationAssessmentSummary,
  validateGoalCandidate,
  type GoalCompletionValidation,
  type GoalRecord,
  type GoalRepository,
  type GoalRuntimeBinding,
  type GoalRuntimePort,
  type GoalState,
  type GoalUsage,
  type GoalVerificationInput,
  type GoalVerificationRunResult,
} from "@clarvis/goal";
import { generateExecutionId } from "@clarvis/trace";
import { randomUUID } from "node:crypto";
import type { GoalEvidenceSnapshot, GoalEvidenceSource } from "./evidence.ts";
import { goalEvidenceDigest } from "./evidence.ts";
import { verificationArtifactsCurrent, verifyTraceInspectedArtifacts } from "./trace-reads.ts";
import type { GoalVerificationProjection } from "./verification-input.ts";
import { kernelError } from "../core/errors.ts";
import { toGoalKernelError } from "./errors.ts";

/** Metadata-only notification emitted after the private session write succeeds. */
export interface GoalRuntimeChange {
  kind: "progress" | "checkpoint" | "candidate" | "verification" | "blocked";
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
  verification?: {
    project(
      goal: GoalRecord,
      attempt: Exclude<FinalizeAttempt, { mode: "checkpoint" }>,
      evidence: GoalEvidenceSnapshot,
      validation: GoalCompletionValidation,
    ): Promise<GoalVerificationProjection>;
    reserveAttempt(): GoalVerificationInput["budget"] | undefined;
    finishAttempt(usage: GoalUsage | undefined): void;
    run(input: GoalVerificationInput): Promise<GoalVerificationRunResult>;
    readTrace(executionId: string): readonly TraceEvent[] | undefined;
    readFile(path: string): Promise<{ path: string; content: string }>;
    validateDefinitionSources(sources: GoalRecord["sources"]): Promise<boolean>;
  };
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
  const proof = async (
    attempt: Exclude<FinalizeAttempt, { mode: "checkpoint" }>,
    signal?: AbortSignal,
  ) => {
    const { goal, evidence } = await snapshot("validate", signal);
    if (goal.candidate?.execution_id !== binding.execution_id)
      return {
        goal,
        evidence,
        validation: {
          valid: false,
          reasons: ["The current stage has no completion candidate"],
          qualitative_criteria: [],
          revision: goal.revision,
        },
      };
    const validation = await validateGoalCandidate(goal, goal.candidate, evidence);
    return { goal, evidence, validation };
  };
  const verifyCompletion: GoalRuntimePort["verifyCompletion"] = (attempt, signal) =>
    guard(async () => {
      const initial = await proof(attempt, signal);
      if (!initial.validation.valid || options.verification === undefined)
        return initial.validation.valid
          ? {
              ...initial.validation,
              valid: false,
              reasons: ["Independent Goal verification is unavailable"],
            }
          : initial.validation;
      if (!(await options.verification.validateDefinitionSources(initial.goal.sources)))
        return {
          ...initial.validation,
          valid: false,
          reasons: ["A normative Goal source changed or disappeared before verification"],
          verdict: "inconclusive",
        };
      const projected = await options.verification.project(
        initial.goal,
        attempt,
        initial.evidence,
        initial.validation,
      );
      const existing = currentGoalVerification(initial.goal, projected.fence);
      if (
        existing !== undefined &&
        (await verificationArtifactsCurrent(existing.inspected_artifacts, (path) =>
          options.verification!.readFile(path),
        ))
      )
        return {
          valid: existing.verdict === "achieved",
          reasons:
            existing.verdict === "achieved"
              ? []
              : [existing.summary, ...verificationAssessmentSummary(existing.assessments)],
          qualitative_criteria: projected.qualitative_criterion_ids,
          revision: initial.goal.revision,
          verdict: existing.verdict,
          verification_execution_id: existing.verification_execution_id,
        };
      const budget = options.verification.reserveAttempt();
      if (budget === undefined)
        return {
          valid: false,
          reasons: [
            "Independent Goal verification exhausted its bounded attempts or token reserve",
          ],
          qualitative_criteria: projected.qualitative_criterion_ids,
          revision: initial.goal.revision,
          verdict: "inconclusive",
        };
      const verificationExecutionId = generateExecutionId();
      let completed: GoalVerificationRunResult;
      try {
        completed = await options.verification.run({
          execution_id: verificationExecutionId,
          agent_instance_id: randomUUID(),
          session_id: binding.session_id,
          projection: projected.projection,
          signal,
          budget,
        });
        options.verification.finishAttempt(completed.usage);
      } catch (error) {
        const usage =
          typeof error === "object" && error !== null && "usage" in error
            ? (error as { usage?: GoalUsage }).usage
            : undefined;
        options.verification.finishAttempt(usage);
        signal?.throwIfAborted();
        logger.warn(
          {
            event: "goal.verification.failed",
            execution_id: binding.execution_id,
            verification_execution_id: verificationExecutionId,
            ...(usage?.kind === "measured"
              ? {
                  input_tokens: usage.input,
                  output_tokens: usage.output,
                  ...(usage.cached === undefined ? {} : { cached_tokens: usage.cached }),
                }
              : {}),
          },
          "Independent Goal verification failed",
        );
        return {
          valid: false,
          reasons: ["Independent Goal verification failed without establishing completion"],
          qualitative_criteria: projected.qualitative_criterion_ids,
          revision: initial.goal.revision,
          verdict: "inconclusive",
          verification_execution_id: verificationExecutionId,
        };
      }
      let result: ReturnType<typeof validateGoalVerificationResult>;
      let artifacts: Awaited<ReturnType<typeof verifyTraceInspectedArtifacts>>;
      try {
        result = validateGoalVerificationResult(
          completed.result,
          projected.qualitative_criterion_ids,
          projected.evidence_ids,
        );
        const inspectedPaths = result.assessments.flatMap(
          (assessment) => assessment.inspected_paths,
        );
        if (initial.goal.sources.some((source) => !inspectedPaths.includes(source.path)))
          return {
            valid: false,
            reasons: ["Independent Goal verification did not inspect every normative source"],
            qualitative_criteria: projected.qualitative_criterion_ids,
            revision: initial.goal.revision,
            verdict: "inconclusive",
            verification_execution_id: completed.execution_id,
          };
        artifacts = await verifyTraceInspectedArtifacts({
          trace: options.verification.readTrace(completed.execution_id) ?? [],
          paths: [...new Set(inspectedPaths)],
          readFile: (path) => options.verification!.readFile(path),
        });
      } catch {
        signal?.throwIfAborted();
        logger.warn(
          {
            event: "goal.verification.rejected",
            execution_id: binding.execution_id,
            verification_execution_id: completed.execution_id,
          },
          "Independent Goal verification claimed invalid or incomplete inspection",
        );
        return {
          valid: false,
          reasons: [
            "Independent Goal verification claimed an invalid result or a path it did not read completely",
          ],
          qualitative_criteria: projected.qualitative_criterion_ids,
          revision: initial.goal.revision,
          verdict: "inconclusive",
          verification_execution_id: completed.execution_id,
        };
      }
      if (
        options.evidence.generation !== initial.evidence.generation ||
        !(await options.verification.validateDefinitionSources(initial.goal.sources))
      )
        throw new GoalError(
          "conflict",
          "Goal evidence or normative sources changed during verification",
        );
      const refreshed = await options.verification.project(
        initial.goal,
        attempt,
        initial.evidence,
        initial.validation,
      );
      if (
        JSON.stringify(refreshed.fence) !== JSON.stringify(projected.fence) ||
        refreshed.projection !== projected.projection
      )
        throw new GoalError("conflict", "Goal conversation changed during verification");
      const verification = {
        verification_execution_id: completed.execution_id,
        control_revision: projected.fence.control_revision,
        objective_revision: projected.fence.objective_revision,
        definition_digest: projected.fence.definition_digest,
        candidate_digest: projected.fence.candidate_digest,
        final_attempt_digest: projected.fence.final_attempt_digest,
        evidence_digest: projected.fence.evidence_digest,
        verdict: result.verdict,
        summary: result.summary,
        assessments: result.assessments,
        inspected_artifacts: artifacts,
        usage: completed.usage,
        verified_at: now(),
      };
      const committed = await options.repository.transact(binding.session_id, (previous) => {
        if (previous === undefined) throw new GoalError("conflict", "Goal state is absent");
        if (options.evidence.generation !== initial.evidence.generation)
          throw new GoalError(
            "conflict",
            "Goal evidence changed before verification was persisted",
          );
        const state = recordGoalVerification(previous, {
          ...projected.fence,
          verification,
          now: now(),
        });
        return { state, result: state.current! };
      });
      const persisted = currentGoalVerification(committed, projected.fence);
      if (persisted === undefined)
        throw new GoalError("conflict", "Goal verification lost its persistence fence");
      logger.info(
        {
          event: "goal.verification.completed",
          execution_id: binding.execution_id,
          verification_execution_id: persisted.verification_execution_id,
          verdict: persisted.verdict,
          assessment_count: persisted.assessments.length,
          artifact_count: persisted.inspected_artifacts.length,
          elapsed_ms: completed.elapsed_ms,
          ...(persisted.usage.kind === "measured"
            ? {
                input_tokens: persisted.usage.input,
                output_tokens: persisted.usage.output,
                ...(persisted.usage.cached === undefined
                  ? {}
                  : { cached_tokens: persisted.usage.cached }),
              }
            : {}),
        },
        "Independent Goal verification completed",
      );
      try {
        options.onChange?.({
          kind: "verification",
          session_id: binding.session_id,
          goal_id: binding.goal_id,
          execution_id: binding.execution_id,
          revision: committed.revision,
        });
      } catch {
        logger.warn(
          { event: "goal.notification.failed", execution_id: binding.execution_id },
          "Goal verification is durable but its observer failed",
        );
      }
      return {
        valid: persisted.verdict === "achieved",
        reasons:
          persisted.verdict === "achieved"
            ? []
            : [persisted.summary, ...verificationAssessmentSummary(persisted.assessments)],
        qualitative_criteria: projected.qualitative_criterion_ids,
        revision: committed.revision,
        verdict: persisted.verdict,
        verification_execution_id: persisted.verification_execution_id,
      };
    }, signal);
  const readCompletionProof: GoalRuntimePort["readCompletionProof"] = (result, signal) =>
    guard(async () => {
      const attempt =
        typeof result === "string"
          ? ({ mode: "text", text: result } as const)
          : ({ mode: "submit", value: result } as const);
      const initial = await proof(attempt, signal);
      if (!initial.validation.valid || options.verification === undefined)
        return initial.validation;
      const projected = await options.verification.project(
        initial.goal,
        attempt,
        initial.evidence,
        initial.validation,
      );
      if (goalFinalAttemptDigest(result) !== projected.fence.final_attempt_digest)
        return { ...initial.validation, valid: false, reasons: ["Terminal result changed"] };
      const verification = currentGoalVerification(initial.goal, projected.fence);
      const current =
        verification !== undefined &&
        verification.verdict === "achieved" &&
        (await verificationArtifactsCurrent(verification.inspected_artifacts, (path) =>
          options.verification!.readFile(path),
        ));
      return {
        valid: current,
        reasons: current ? [] : ["No current achieved verification matches the terminal result"],
        qualitative_criteria: projected.qualitative_criterion_ids,
        revision: initial.goal.revision,
      };
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
    verifyCompletion,
    readCompletionProof,
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
