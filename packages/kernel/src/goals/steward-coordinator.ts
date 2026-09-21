import type { PerAgentUsage } from "@clarvis/capability";
import {
  sanitizeText,
  type OperatorReviewContextProvider,
  type TraceEvent,
} from "@clarvis/capability";
import {
  validateGoalStewardResult,
  settleStewardEvaluation,
  type GoalRepository,
  type GoalRuntimeBinding,
  type GoalRuntimePort,
  type GoalState,
  type GoalStewardPort,
  type GoalStewardReview,
  type GoalStewardFinalizeAttempt,
  GoalStewardRunFailure,
  type GoalStewardRunResult,
  type GoalStewardRunInput,
  type GoalUsage,
} from "@clarvis/goal";
import { generateExecutionId } from "@clarvis/trace";
import { createStewardInput, stewardDefinitionDigest, stewardDigest } from "./steward-input.ts";
import { buildStewardConversationFrame, StewardProjectionError } from "./steward-projection.ts";
import { stewardBound } from "./steward-state.ts";

/**
 * Raised when an evaluation produced a decision the host cannot account for.
 *
 * @remarks Kept distinct from a transport fault on purpose. The evaluation did
 *   answer — possibly with a valid `achieved` — but its consumption could not be
 *   determined, and a Goal cannot be concluded on a review the host cannot
 *   charge. Classifying both as `transport` named the wrong cause in the
 *   operator's record and made the two indistinguishable there.
 */
class StewardUsageUnknownError extends Error {
  constructor() {
    super("Goal Steward usage is unknown");
  }
}

export interface StewardExecutionRuntime {
  fingerprint: string;
  budget: GoalStewardRunInput["budget"];
  promptCacheTtl: "5m" | "1h";
  maxReviews: number;
  maxCompletionReviews?: number;
  run(
    input: GoalStewardRunInput & {
      validateResult(result: unknown, trace: readonly TraceEvent[]): Promise<void>;
    },
  ): Promise<GoalStewardRunResult>;
}

export interface StewardCoordinatorOptions {
  binding: GoalRuntimeBinding;
  repository: GoalRepository;
  runtimePort: GoalRuntimePort;
  runtime(): StewardExecutionRuntime;
  initialMessages: readonly string[];
  sequenceBase?: number;
  digestBase?: string;
  epochBase?: number;
  recoverUsage?(executionId: string): Promise<{ usage: GoalUsage; accounting?: PerAgentUsage[] }>;
  provenance?: {
    entries: Array<{ actor: string; text: string }>;
    partial: boolean;
    truncated: boolean;
  };
  operatorRequest?: string;
  signal: AbortSignal;
  /** Atomically applies the domain mutation and measured Session usage on its first settlement. */
  settle(
    mutate: (previous: GoalState) => { state: GoalState; charged: boolean },
    usage: GoalUsage,
    accounting?: PerAgentUsage[],
  ): Promise<void>;
  changed(): void;
}

/** One retained evaluation, one coalesced delta, and the existing durable continuation chain. */
export function createGoalStewardCoordinator(
  options: StewardCoordinatorOptions,
): GoalStewardPort & {
  observe(event: TraceEvent): void;
  completionCurrent(result: unknown): Promise<boolean>;
} {
  const input = createStewardInput(
    options.initialMessages,
    options.sequenceBase,
    options.digestBase,
    options.epochBase,
  );
  let provider: OperatorReviewContextProvider | undefined;
  let closed = false;
  let flight: Promise<GoalStewardReview | undefined> | undefined;
  let abort: AbortController | undefined;
  let failed = false;
  let acceptedAttempt: GoalStewardFinalizeAttempt | undefined;
  const read = async () =>
    stewardBound(await options.repository.read(options.binding.session_id), options.binding);
  const fenceCurrent = async (review: GoalStewardReview) => {
    const { goal } = await read();
    return (
      !options.signal.aborted &&
      goal.control_revision === review.control_revision &&
      stewardDefinitionDigest(goal) === review.definition_digest &&
      input.snapshot().digest === review.trajectory_digest &&
      input.snapshot().epoch === review.operator_steering_epoch &&
      (review.candidate_digest === undefined ||
        stewardDigest(goal.candidate) === review.candidate_digest)
    );
  };
  const evaluate = async (
    attempt: GoalStewardFinalizeAttempt,
    operationSignal?: AbortSignal,
  ): Promise<GoalStewardReview | undefined> => {
    const runtime = options.runtime();
    let before = await read();
    const orphan = before.goal.steward.pending_execution_id;
    if (orphan !== undefined) {
      const recovered = (await options.recoverUsage?.(orphan)) ?? {
        usage: { kind: "unknown" as const },
      };
      const recoveredUsage = recovered.usage;
      await options.settle(
        (previous) =>
          settleStewardEvaluation(previous, {
            binding: options.binding,
            executionId: orphan,
            usage: recoveredUsage,
            sequence: before.goal.steward.last_consumed_work_sequence,
            fingerprint: before.goal.steward.runtime_fingerprint,
            now: Date.now(),
            continued: false,
            controlRevision: before.goal.control_revision,
          }),
        recoveredUsage,
        recovered.accounting,
      );
      before = await read();
    }
    if (!provider || closed || options.signal.aborted) return undefined;
    if (before.run.steward_review_count >= runtime.maxReviews) {
      await options.runtimePort.blocked(
        "Goal Steward review limit reached; review the remaining work and resume explicitly",
      );
      return undefined;
    }
    if (before.goal.steward.pending_execution_id !== undefined)
      throw new Error("Goal Steward has an unsettled evaluation");
    const plan = provider.snapshot();
    const trajectory = input.snapshot();
    const operatorRequest =
      options.operatorRequest ??
      (before.goal.origin.kind === "guided"
        ? before.goal.origin.seed
        : (options.initialMessages[0] ?? before.goal.objective));
    const corrections = trajectory.events.flatMap((event) =>
      event.actor === "operator_steering" || event.actor === "elicitation"
        ? [{ text: event.text }]
        : [],
    );
    const pendingQuestion = before.goal.steward.pending_question;
    const dialogue = [
      ...(pendingQuestion === undefined
        ? []
        : [
            {
              speaker: "steward" as const,
              kind: "question" as const,
              text: pendingQuestion.question,
            },
            {
              speaker: "work_agent" as const,
              kind: "answer" as const,
              text: before.goal.candidate?.summary ?? sanitizeText(JSON.stringify(attempt)),
            },
          ]),
    ];
    const fingerprint = stewardDigest({
      runtime: runtime.fingerprint,
      definition: stewardDefinitionDigest(before.goal),
    });
    const predecessor =
      before.goal.steward.runtime_fingerprint === fingerprint
        ? before.goal.steward.last_steward_execution_id
        : undefined;
    const projected = buildStewardConversationFrame({
      goal: before.goal,
      attempt,
      operatorRequest,
      corrections,
      dialogue,
      includeContract: predecessor === undefined,
    });
    const executionId = generateExecutionId();
    const mode = "completion" as const;
    const frame = projected.frame;
    await options.repository.transact(options.binding.session_id, (previous) => {
      const { state, goal, run } = stewardBound(previous, options.binding);
      if (
        goal.control_revision !== before.goal.control_revision ||
        goal.steward.pending_execution_id !== undefined ||
        goal.steward.last_steward_execution_id !== before.goal.steward.last_steward_execution_id ||
        goal.steward.last_consumed_work_sequence !== before.goal.steward.last_consumed_work_sequence
      )
        throw new Error("Goal Steward admission conflict");
      goal.steward.pending_execution_id = executionId;
      goal.steward.prompt_cache_ttl = runtime.promptCacheTtl;
      goal.steward.status = "verifying";
      run.steward_review_count++;
      state.revision++;
      goal.revision = state.revision;
      return { state, result: undefined };
    });
    options.changed();
    const validate = async (value: unknown) => {
      const result = validateGoalStewardResult(
        value,
        mode,
        before.goal.criteria.filter((item) => item.kind === "qualitative").map((item) => item.id),
      );
      if (result.decision === "definition")
        throw new Error("Goal Steward returned a definition decision during work review");
      return result;
    };
    let usage: GoalUsage = { kind: "unknown" };
    let accounting: PerAgentUsage[] | undefined;
    let review: GoalStewardReview | undefined;
    let continued = false;
    abort = new AbortController();
    if (closed) abort.abort();
    const signal = AbortSignal.any([
      options.signal,
      abort.signal,
      ...(operationSignal === undefined ? [] : [operationSignal]),
    ]);
    try {
      const outcome = await runtime.run({
        execution_id: executionId,
        session_id: options.binding.session_id,
        continue_from: predecessor,
        projection: frame,
        signal,
        budget: runtime.budget,
        prompt_cache_ttl: runtime.promptCacheTtl,
        async validateResult(value) {
          await validate(value);
        },
      });
      usage = outcome.usage;
      accounting = outcome.accounting;
      signal.throwIfAborted();
      if (usage.kind === "unknown") throw new StewardUsageUnknownError();
      continued = true;
      const result = await validate(outcome.result);
      review = {
        steward_execution_id: executionId,
        mode,
        goal_id: options.binding.goal_id,
        work_execution_id: options.binding.execution_id,
        control_revision: before.goal.control_revision,
        objective_revision: before.goal.objective_revision,
        definition_digest: stewardDefinitionDigest(before.goal),
        trajectory_digest: trajectory.digest,
        plan_context_revision: plan.revision,
        operator_steering_epoch: trajectory.epoch,
        evidence_digest: projected.digest,
        candidate_digest: stewardDigest(before.goal.candidate),
        final_attempt_digest: stewardDigest(attempt),
        decision: result.verdict,
        summary: result.summary,
        ...("next_step" in result ? { next_step: result.next_step } : {}),
        ...(result.verdict === "needs_evidence" && result.next_step !== undefined
          ? { question: result.next_step }
          : {}),
        ...(pendingQuestion === undefined
          ? {}
          : { answer: before.goal.candidate?.summary ?? pendingQuestion.question }),
        speakers: projected.speakers,
        usage,
        reviewed_at: Date.now(),
      };
      if (!(await fenceCurrent(review))) review = undefined;
    } catch (error) {
      if (error instanceof StewardProjectionError) throw error;
      if (error !== null && typeof error === "object" && "usage" in error)
        usage = (error as { usage: GoalUsage }).usage;
      if (error instanceof GoalStewardRunFailure) accounting = error.accounting;
      failed = true;
      const cause =
        options.signal.aborted || operationSignal?.aborted
          ? ("cancelled" as const)
          : error instanceof StewardUsageUnknownError
            ? ("usage_unknown" as const)
            : error instanceof GoalStewardRunFailure &&
                (error.code === "timeout" || error.code.includes("timeout"))
              ? ("timeout" as const)
              : error instanceof GoalStewardRunFailure && error.code === "cancelled"
                ? ("cancelled" as const)
                : error instanceof GoalStewardRunFailure &&
                    (error.code === "invalid_request" || error.code.includes("invalid"))
                  ? ("invalid_output" as const)
                  : ("transport" as const);
      review = {
        steward_execution_id: executionId,
        mode,
        goal_id: options.binding.goal_id,
        work_execution_id: options.binding.execution_id,
        control_revision: before.goal.control_revision,
        objective_revision: before.goal.objective_revision,
        definition_digest: stewardDefinitionDigest(before.goal),
        trajectory_digest: trajectory.digest,
        plan_context_revision: plan.revision,
        operator_steering_epoch: trajectory.epoch,
        evidence_digest: projected.digest,
        candidate_digest: stewardDigest(before.goal.candidate),
        final_attempt_digest: stewardDigest(attempt),
        decision: "interrupted",
        summary: "Goal Steward review was interrupted",
        interruption_cause: cause,
        speakers: projected.speakers,
        usage,
        reviewed_at: Date.now(),
      };
      options.runtimePort.logger?.warn(
        {
          event: "goal.steward.failed",
          execution_id: executionId,
          mode,
          cause,
        },
        "Goal Steward evaluation did not produce a current decision",
      );
    } finally {
      await options.settle(
        (previous) => {
          const current = previous.current;
          if (
            review !== undefined &&
            (!current ||
              current.control_revision !== review.control_revision ||
              stewardDefinitionDigest(current) !== review.definition_digest ||
              input.snapshot().digest !== review.trajectory_digest ||
              (review.candidate_digest !== undefined &&
                stewardDigest(current.candidate) !== review.candidate_digest))
          )
            review = undefined;
          return settleStewardEvaluation(previous, {
            binding: options.binding,
            executionId,
            usage,
            review,
            sequence: trajectory.sequence,
            trajectoryDigest: trajectory.digest,
            steeringEpoch: trajectory.epoch,
            fingerprint,
            now: Date.now(),
            continued,
            controlRevision: before.goal.control_revision,
          });
        },
        usage,
        accounting,
      );
      options.runtimePort.logger?.info(
        {
          event: "goal.steward.settled",
          execution_id: executionId,
          work_execution_id: options.binding.execution_id,
          mode,
          decision: review?.decision ?? "discarded",
          usage_kind: usage.kind,
        },
        "Goal Steward evaluation accounted",
      );
      options.changed();
      abort = undefined;
    }
    if (continued) input.consumed(trajectory.sequence);
    return review;
  };
  return {
    observe(event) {
      input.observe(event);
    },
    bindReviewContext(next) {
      if (provider && provider !== next)
        throw new Error("Goal Steward review context is already bound");
      provider = next;
    },
    async reviewCompletion(attempt, signal) {
      try {
        signal?.throwIfAborted();
        failed = false;
        const latest = (await read()).run.steward_reviews.at(-1);
        let review =
          latest?.decision === "achieved" &&
          latest.final_attempt_digest === stewardDigest(attempt) &&
          (await fenceCurrent(latest))
            ? latest
            : undefined;
        for (
          let retry = 0;
          review?.decision !== "achieved" &&
          review?.decision !== "needs_work" &&
          review?.decision !== "needs_evidence" &&
          review?.decision !== "interrupted" &&
          retry < (options.runtime().maxCompletionReviews ?? 1);
          retry++
        ) {
          signal?.throwIfAborted();
          failed = false;
          try {
            flight = evaluate(attempt, signal);
            review = await flight;
          } catch (error) {
            if (error instanceof StewardProjectionError && error.code === "report_too_large")
              return {
                kind: "needs_work",
                review_id: "projection",
                next_step: error.message,
              };
            throw error;
          } finally {
            flight = undefined;
          }
        }
        if (review?.decision === "achieved") {
          acceptedAttempt = attempt;
          return { kind: "achieved", review_id: review.steward_execution_id };
        }
        if (review?.decision === "needs_work")
          return {
            kind: "needs_work",
            review_id: review.steward_execution_id,
            next_step: review.next_step!,
          };
        if (review?.decision === "needs_evidence")
          return {
            kind: "needs_evidence",
            review_id: review.steward_execution_id,
            next_step: review.next_step!,
          };
        if (review?.decision === "interrupted")
          return {
            kind: "interrupted",
            review_id: review.steward_execution_id,
            reason:
              review.interruption_cause === "timeout"
                ? "goal_steward_failed"
                : review.interruption_cause === "cancelled"
                  ? "goal_steward_inconclusive"
                  : "goal_steward_failed",
            cause: review.interruption_cause ?? "transport",
          };
        return {
          kind: "interrupted",
          review_id: review?.steward_execution_id ?? "unavailable",
          reason: failed ? "goal_steward_failed" : "goal_steward_inconclusive",
          cause: "transport",
        };
      } finally {
        flight = undefined;
      }
    },
    async completionCurrent(result) {
      if (
        acceptedAttempt === undefined ||
        stewardDigest(result) !==
          stewardDigest(
            acceptedAttempt.mode === "text"
              ? acceptedAttempt.text
              : acceptedAttempt.submitted_value,
          )
      )
        return false;
      const review = (await read()).run.steward_reviews.at(-1);
      return review?.decision === "achieved" && (await fenceCurrent(review));
    },
    async closeCoordinator() {
      closed = true;
      abort?.abort();
      await flight;
    },
  };
}
