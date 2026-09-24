import {
  ProviderError,
  type Capability,
  type LLMProvider,
  type Logger,
  type OperatorReviewContextProvider,
  type TraceEvent,
} from "@clarvis/capability";
import {
  admitGoalCreationIntent,
  applyGoalControl,
  pauseGoalForPolicy,
  goalNetTokens,
  createGoalAttachmentCapability,
  admitGoalRun,
  advanceGoalRun,
  prepareGoalSettlement,
  createGoalCapability,
  createGoalCreationCapability,
  goalAdmission,
  goalDeadlineLimit,
  stopGoalContinuation,
  type GoalRepository,
  type GoalRecord,
  type GoalCreationInput,
  type GoalLimits,
  type GoalRunCause,
  type GoalRuntimePort,
  type GoalCreationPort,
  type GoalAttachmentPort,
  type GoalStewardFinalizeAttempt,
  type GoalStewardPort,
  type GoalUsage,
} from "@clarvis/goal";
import type { Message, RunRequest } from "@clarvis/loop";
import type {
  ModelCost,
  RunDetail,
  RunResult,
  Session,
  SessionService,
  StartRunParams,
} from "@clarvis/protocol";
import { generateExecutionId } from "@clarvis/trace";
import type { HostedExecutionBinding, HostedPreparationContext } from "../hosting/sessions.ts";
import type { HostedContinuationProposal, HostedTurnContinuation } from "../hosting/registry.ts";
import { kernelError } from "../core/errors.ts";
import { protoMessagesToEngine } from "../runs/map-message.ts";
import type { GoalEvidenceSource } from "./evidence.ts";
import { createGoalRuntimePort } from "./runtime-port.ts";
import { createGoalCreationPort } from "./creation-port.ts";
import { goalStateFromSession, goalStateToDto } from "./session-state.ts";
import { pendingInstant, settleGoalSession } from "./settlement.ts";
import { createGoalUsageTracker, measureGoalRunUsage } from "./usage.ts";
import { projectStewardOrigin } from "./steward-input.ts";
import {
  createGoalStewardCoordinator,
  type StewardCoordinatorOptions,
  type StewardExecutionRuntime,
} from "./steward-coordinator.ts";

/** Mandatory entry capability and finite request policy for one host-admitted stage. */
export interface GoalExecutionPolicy {
  capability: Capability;
  observe(event: TraceEvent): void;
  /** Observe complete host inference accounting without trusting zero-filled guest totals. */
  trackModel(provider: LLMProvider): LLMProvider;
  /** Apply after ordinary profile/settings resolution, before immutable launch preparation. */
  constrain(request: RunRequest): RunRequest;
}

/** Host policy for the first ordinary run that creates a Goal through its model-facing tool. */
export interface GoalCreationExecutionPolicy {
  capability: Capability;
  observe(event: TraceEvent): void;
  trackModel(provider: LLMProvider): LLMProvider;
}

async function goalAuthorityMessages(
  goal: GoalRecord,
  readRun: ((executionId: string) => Promise<RunDetail | null>) | undefined,
): Promise<Message[]> {
  const messages: Message[] = [];
  if (goal.origin.kind !== "literal" && readRun !== undefined) {
    for (const executionId of goal.origin.source_execution_ids) {
      const run = await readRun(executionId);
      if (run === null) continue;
      messages.push(
        ...protoMessagesToEngine(run.messages.filter((message) => message.role === "user")),
      );
    }
  }
  if (goal.origin.kind === "guided") messages.push({ role: "user", content: goal.origin.seed });
  else if (goal.origin.kind === "literal")
    messages.push({
      role: "user",
      content: JSON.stringify({
        objective: goal.objective,
        criteria: goal.criteria,
        constraints: goal.constraints,
        exclusions: goal.exclusions,
        assumptions: goal.assumptions,
      }),
    });
  return messages;
}

/**
 * The host-authored orientation a successor Goal stage starts from.
 *
 * @remarks Keyed by the closed cause the settlement recorded, so the successor is told
 *   what happened without copying the failed run's prose, the objective or any new
 *   authorization. The checkpoint wording is the original one, because that handoff is
 *   unchanged; a recovery names its ending and asks for a different approach instead of
 *   a repeat, and it never claims a permission the Goal did not already have.
 */
const CONTINUATION_TURNS: Record<GoalRunCause, string> = {
  checkpoint:
    "Continue the current goal from its accepted checkpoint. Preserve the current objective, approvals and remaining limits.",
  local_limit:
    "The previous stage reached its own limit before finishing. Continue the current goal from its observable result, and do not repeat work that is already done.",
  declined:
    "Continue the current goal from its last settled stage. The previous stage stopped because the extension was declined; the current objective and limits still apply.",
  cancelled:
    "Continue the current goal from its last settled stage. Preserve the current objective, approvals and remaining limits.",
  stagnation:
    "The previous stage stopped without progress. Continue the current goal by changing the approach: state what did not work, choose a different one, and do not repeat the same calls.",
  empty_response:
    "The previous stage produced no answer. Continue the current goal from its observable result.",
  impediment:
    "The previous stage reported an impediment. Continue the current goal only within the authorization it already has.",
  transient:
    "The previous stage ended on a transient provider failure. Continue the current goal from its observable result.",
  steward_interrupted:
    "The completion review of the previous stage was interrupted. Continue the current goal and re-establish what still needs verification.",
  usage_unknown:
    "Continue the current goal from its last settled stage. The current objective, approvals and limits still apply.",
  context_overflow:
    "The previous stage could not fit its context. Continue the current goal from its observable result without repeating the same payload.",
  provider_refused:
    "Continue the current goal from its last settled stage. The current objective, approvals and limits still apply.",
  tools_unavailable:
    "Continue the current goal from its last settled stage. The current objective, approvals and limits still apply.",
  control_failure:
    "Continue the current goal from its last settled stage. The current objective, approvals and limits still apply.",
  finalization_conflict:
    "The previous stage could not validate a stable completion snapshot. Preserve its work and verify the current criteria and evidence before submitting a new completion candidate. Do not repeat confirmed effects.",
  unclassified:
    "Continue the current goal from its last settled stage. Preserve the current objective, approvals and remaining limits.",
};

/** Short operator-facing label for the same cause, used as the successor's preview. */
const CONTINUATION_PREVIEWS: Record<GoalRunCause, string> = {
  checkpoint: "checkpoint",
  local_limit: "stage limit reached",
  declined: "extension declined",
  cancelled: "cancelled",
  stagnation: "no progress",
  empty_response: "no answer",
  impediment: "impediment declared",
  transient: "provider transient failure",
  steward_interrupted: "completion review interrupted",
  usage_unknown: "review consumption unknown",
  context_overflow: "context limit reached",
  provider_refused: "provider refused",
  tools_unavailable: "tools unavailable",
  control_failure: "control failure",
  finalization_conflict: "completion state changed",
  unclassified: "stage failed",
};

/**
 * Compose one Goal stage's settlement, shared by the guided creation turn and every later
 * stage.
 *
 * @param scope - the durable store, the bound identities, the clock and the optional
 *   completion prerequisites of this stage.
 * @returns the host policy the registry calls once, after physical closure and
 *   reconciliation.
 * @remarks Both turns settle the same way: the stage's physical phase advances, the
 *   candidate is revalidated outside the session lock when this stage is the one that
 *   produced it, and the returned closure applies the domain's settlement inside the
 *   caller's canonical transaction. The guided creation turn used to have its own copy
 *   without the checkpoint chain, which is why a first stage that handed off a checkpoint
 *   could not start a successor.
 *
 *   The stage's own activity is observed here, once, from the host's trace-derived
 *   evidence rather than from the model's citations, and it is compared with the Goal's
 *   whole recorded history: repeating an earlier stage's checks is not progress. An
 *   observation that cannot be taken remains explicitly unknown without consuming the semantic
 *   no-progress allowance. Continuation and spend budgets remain enforced. Both turns take
 *   that observation through the same helper, so an unreadable
 *   trace cannot mean one thing in the creation stage and another in a later one.
 */
async function observeStageActivity(
  evidence: GoalEvidenceSource,
  goal: GoalRecord,
  executionId: string,
  logger: { warn(fields: Record<string, unknown>, message: string): void } | undefined,
): Promise<string[] | undefined> {
  try {
    return (await evidence.snapshot(goal)).stageActivity();
  } catch {
    logger?.warn(
      { event: "goal.stage.activity_unavailable", execution_id: executionId },
      "Goal stage activity could not be observed; progress remains unknown",
    );
    return undefined;
  }
}

function createGoalStageSettlement(scope: {
  repository: GoalRepository;
  sessionId: string;
  executionId: string;
  signal: AbortSignal;
  now: () => number;
  usageTracker: { measure(priceFor?: (model: string) => ModelCost | undefined): GoalUsage };
  /** The bound runtime, once the Goal exists. */
  runtime: () => GoalRuntimePort | undefined;
  /** Whether the Steward's completion decision still covers this attempt. */
  stewardCompletion?: (result: unknown) => Promise<boolean>;
  /** Revalidate host-owned normative snapshots immediately before a completion commit. */
  validateDefinitionSources?: (
    sources: readonly { path: string; digest: string }[],
  ) => Promise<boolean>;
  /** The stage's own successful activity receipts, when the host can collect them. */
  observeActivity?: (goal: GoalRecord) => Promise<string[] | undefined>;
  priceFor?: (model: string) => ModelCost | undefined;
}): (result: RunResult) => Promise<(session: Session) => boolean> {
  return async (result) => {
    const current = await scope.repository.read(scope.sessionId);
    const goal = current?.current;
    const run = goal?.runs.find((item) => item.execution_id === scope.executionId);
    if (run?.settlement_preparation !== undefined) {
      const preparation = run.settlement_preparation;
      if (
        preparation.outcome !== result.status ||
        preparation.disposition !== (result.disposition ?? "final")
      )
        throw kernelError("conflict", "Settlement result changed after preparation");
      return (session) =>
        settleGoalSession(
          session,
          result,
          { ...preparation, completion_validated: false },
          scope.now(),
          scope.priceFor,
        );
    }
    let validated: number | undefined;
    let activity: string[] | undefined = [];
    if (goal !== undefined && run !== undefined && run.phase !== "closed") {
      if (scope.observeActivity !== undefined) activity = await scope.observeActivity(goal);
      if (run.phase !== "settling")
        await scope.repository.transact(scope.sessionId, (state) => ({
          state: advanceGoalRun(state!, {
            goal_id: goal.goal_id,
            execution_id: scope.executionId,
            phase: "settling",
            now: scope.now(),
          }),
          result: undefined,
        }));
      const before = (await scope.repository.read(scope.sessionId))?.current;
      const runtime = scope.runtime();
      if (
        result.status === "completed" &&
        result.disposition !== "checkpoint" &&
        before?.status === "active" &&
        before.candidate?.execution_id === scope.executionId &&
        runtime !== undefined &&
        !scope.signal.aborted
      ) {
        try {
          const sourcesCurrent =
            scope.validateDefinitionSources === undefined ||
            (await scope.validateDefinitionSources(before.sources));
          if (sourcesCurrent) {
            const validation = await runtime.validateCompletion();
            if (
              validation.valid &&
              (scope.stewardCompletion === undefined ||
                (await scope.stewardCompletion(result.result)))
            )
              validated = validation.revision;
          }
        } catch (error) {
          const latest = (await scope.repository.read(scope.sessionId))?.current;
          if (
            latest?.goal_id !== goal.goal_id ||
            (latest.status === "active" && latest.control_revision === goal.control_revision)
          )
            throw error;
        }
      }
    }
    const usage = scope.usageTracker.measure(scope.priceFor);
    if (
      goal !== undefined &&
      run !== undefined &&
      run.phase !== "closed" &&
      result.status !== "running" &&
      (result.status !== "completed" || result.disposition === "checkpoint")
    ) {
      await scope.repository.transact(scope.sessionId, (state) => ({
        state: prepareGoalSettlement(state!, {
          goal_id: goal.goal_id,
          execution_id: scope.executionId,
          preparation: {
            outcome: result.status as "completed" | "failed" | "cancelled",
            disposition: result.disposition ?? "final",
            usage,
            ...(activity === undefined ? { activity_unavailable: true } : { activity }),
          },
          now: scope.now(),
        }),
        result: undefined,
      }));
    }
    return (session) =>
      settleGoalSession(
        session,
        result,
        {
          disposition: result.disposition ?? "final",
          usage,
          completion_validated:
            validated !== undefined && session.goal_state?.revision === validated,
          ...(activity === undefined ? { activity_unavailable: true } : { activity }),
        },
        scope.now(),
        scope.priceFor,
      );
  };
}

/**
 * Compose the automatic-continuation policy of one Goal stage, shared by both turns.
 *
 * @param scope - the canonical session reader, the predecessor identity and the policy's
 *   own failure notification.
 * @returns the policy the registry evaluates after its whole barrier.
 * @remarks Eligibility is read from the durable decision the settlement recorded on the
 *   closed stage, revalidated against the canonical session each time: the same Goal, its
 *   current control and objective revision, the same latest stage, and admission under the
 *   remaining limits. A proposal is a *successor* the registry may start; it never carries
 *   authority, and the registry still owns exclusion and the single-use reservation. The
 *   guided creation turn returns nothing until its Goal exists durably, so a stage that
 *   never created one cannot invent a successor.
 */
function createGoalContinuation(scope: {
  sessionId: string;
  sessions: Pick<SessionService, "get">;
  executionId: string;
  /** The predecessor's resolved request, minus anything that belonged to its own turn. */
  params: StartRunParams;
  goalId: () => string | undefined;
  signal: AbortSignal;
  now: () => number;
  stopped: (reason: "revoked" | "superseded" | "failed") => Promise<void>;
}): HostedTurnContinuation {
  return {
    async prepare(signal): Promise<HostedContinuationProposal | undefined> {
      signal.throwIfAborted();
      const goalId = scope.goalId();
      if (goalId === undefined) return undefined;
      const session = await scope.sessions.get(scope.sessionId);
      signal.throwIfAborted();
      if (session === null) return undefined;
      const current = goalStateFromSession(session)?.current;
      const predecessor = current?.runs.at(-1);
      if (
        current?.goal_id !== goalId ||
        predecessor?.execution_id !== scope.executionId ||
        predecessor.phase !== "closed" ||
        predecessor.decision !== "continue" ||
        predecessor.control_revision !== current.control_revision ||
        predecessor.objective_revision !== current.objective_revision ||
        !goalAdmission(current, scope.now(), true).allowed
      )
        return undefined;
      const cause = predecessor.cause ?? "unclassified";
      /** A recorded backoff is pending only until it elapses; after that a successor may start. */
      const pending = pendingInstant(predecessor.not_before, scope.now());
      return {
        input: {
          session_id: scope.sessionId,
          session_revision: session.revision ?? 0,
          kind: "conversation",
          user_preview: `Continue the persistent goal (previous stage: ${CONTINUATION_PREVIEWS[cause]})`,
          params: {
            ...scope.params,
            intent: "automatic",
            execution_id: generateExecutionId(),
            continue_from: scope.executionId,
            messages: [{ role: "user", content: CONTINUATION_TURNS[cause] }],
          },
        },
        ...(pending === undefined ? {} : { not_before: pending }),
      };
    },
    stopped: (reason) => scope.stopped(reason),
  };
}

/**
 * Compose goal intent, model authority, settlement and continuation with the existing hosting ports.
 * The caller prepares the ordinary executor with the supplied mandatory capability and request
 * policy. No public peer is created and no run is started until the registry commits its intent.
 */
export async function prepareHostedGoalTurn(options: {
  params: StartRunParams;
  context: HostedPreparationContext;
  repository: GoalRepository;
  sessions: Pick<SessionService, "get">;
  evidence: GoalEvidenceSource;
  /** Revalidate host-owned normative snapshots immediately before completion. */
  validateDefinitionSources?(
    sources: readonly { path: string; digest: string }[],
  ): Promise<boolean>;
  readRun?(executionId: string): Promise<RunDetail | null>;
  prepareExecution(policy: GoalExecutionPolicy): Promise<HostedExecutionBinding>;
  logger?: Logger;
  now?: () => number;
  priceFor?(model: string): ModelCost | undefined;
  onChange?(sessionId: string): void;
  steward?: {
    runtime(workTokenLimit: number, ttl: "5m" | "1h"): StewardExecutionRuntime;
    settle: StewardCoordinatorOptions["settle"];
  };
}): Promise<HostedExecutionBinding> {
  const params = structuredClone(options.params);
  const initial = goalStateFromSession(options.context.session);
  const goal = initial?.current;
  const executionId = params.execution_id;
  const sessionId = options.context.session.id;
  if (
    goal === undefined ||
    initial === undefined ||
    executionId === undefined ||
    params.session_id !== sessionId ||
    params.agent_instance_id === undefined ||
    params.skill !== undefined
  )
    throw kernelError("unsupported", "Goal execution requires a bound ordinary conversation turn");
  const now = options.now ?? Date.now;
  const automatic = options.context.continuationOf !== undefined;
  const previous = goal.runs.at(-1);
  const authorityMessages = await goalAuthorityMessages(
    goal,
    options.readRun === undefined
      ? undefined
      : (sourceExecutionId) => options.readRun!(sourceExecutionId),
  );
  if (
    automatic &&
    (previous === undefined ||
      options.context.continuationOf !== previous.execution_id ||
      params.continue_from !== previous.execution_id ||
      previous.phase !== "closed" ||
      previous.decision !== "continue" ||
      previous.control_revision !== goal.control_revision ||
      previous.objective_revision !== goal.objective_revision)
  )
    throw kernelError("conflict", "Goal continuation does not follow its settled stage");
  const admission = goalAdmission(goal, now(), automatic);
  /**
   * A refusal names what the operator has to do, in the host's closed vocabulary.
   *
   * @remarks Every admission refusal is the Goal asking for a decision — accept a gap, resume,
   *   change a limit, wait for a deadline — so the client gets a typed outcome next to the reason
   *   instead of having to read the sentence to learn what happened. The reason stays the domain's
   *   own bounded text; nothing here invents an outcome for a refusal that is not admission's.
   */
  if (admission.allowed === false)
    throw kernelError("conflict", admission.reason, {
      goal_outcome: "needs_input",
      goal_status: admission.status,
    });
  const binding = {
    session_id: sessionId,
    agent_instance_id: params.agent_instance_id,
    execution_id: executionId,
    goal_id: goal.goal_id,
    objective_revision: goal.objective_revision,
  };
  const usageTracker = createGoalUsageTracker();
  const trackWithDeadline = (provider: LLMProvider): LLMProvider => {
    const tracked = usageTracker.wrap(provider);
    return {
      call(call) {
        const deadline = goalDeadlineLimit(goal, now());
        if (deadline !== undefined) throw new ProviderError(deadline.reason, { kind: "client" });
        return tracked.call(call);
      },
    };
  };
  const runtime = createGoalRuntimePort({
    repository: options.repository,
    binding,
    evidence: options.evidence,
    signal: options.context.signal,
    logger: options.logger,
    now,
    onChange: () => options.onChange?.(sessionId),
  });
  let stewardRuntime: StewardExecutionRuntime | undefined;
  const stewardProvenance =
    options.steward === undefined
      ? undefined
      : await projectStewardOrigin(
          goal,
          options.context.session,
          options.readRun === undefined ? undefined : (id) => options.readRun!(id),
        );
  const steward =
    options.steward === undefined
      ? undefined
      : createGoalStewardCoordinator({
          binding,
          repository: options.repository,
          runtimePort: runtime,
          runtime() {
            if (!stewardRuntime) throw new Error("Goal Steward work budget is not admitted");
            return stewardRuntime;
          },
          initialMessages: (goal.steward.last_steward_execution_id === undefined
            ? authorityMessages
            : automatic
              ? []
              : protoMessagesToEngine(params.messages ?? [])
          ).flatMap((message) =>
            typeof message.content === "string" && message.role === "user" ? [message.content] : [],
          ),
          sequenceBase: goal.steward.last_consumed_work_sequence,
          digestBase: goal.steward.trajectory_digest,
          epochBase: goal.steward.operator_steering_epoch,
          recoverUsage: async (id) => {
            const usage = (await options.readRun?.(id))?.result?.usage;
            return {
              usage: measureGoalRunUsage(usage),
              accounting: usage?.by_agent?.map((row) => ({ ...row, type: "subagent" as const })),
            };
          },
          provenance: stewardProvenance,
          operatorRequest: goal.origin.kind === "guided" ? goal.origin.seed : undefined,
          signal: options.context.signal,
          settle: options.steward.settle,
          changed: () => options.onChange?.(sessionId),
        });
  const stopped = async (reason: "revoked" | "superseded" | "failed"): Promise<void> => {
    if (reason === "superseded") return;
    await options.repository.transact(sessionId, (state) => ({
      state: stopGoalContinuation(state!, {
        goal_id: goal.goal_id,
        execution_id: executionId,
        previous_execution_id: previous?.execution_id,
        control_revision: goal.control_revision,
        reason,
        now: now(),
      }),
      result: undefined,
    }));
  };
  const policy: GoalExecutionPolicy = {
    capability: createGoalCapability({ ...runtime, steward }),
    observe: (event) => {
      options.evidence.observe(event);
      steward?.observe(event);
    },
    trackModel(provider) {
      return trackWithDeadline(provider);
    },
    constrain(request) {
      const bounded = structuredClone(request);
      if (
        bounded.execution_id !== executionId ||
        bounded.session_id !== sessionId ||
        bounded.agent_instance_id !== params.agent_instance_id ||
        bounded.profiles.some((profile) => profile.grants?.includes("workflow"))
      )
        throw kernelError(
          "unsupported",
          "Goal scope or workflow profile is incompatible with this turn",
        );
      if (
        bounded.profiles.some(
          (profile) =>
            !Number.isSafeInteger(profile.iteration_limit) || profile.iteration_limit! <= 0,
        )
      )
        throw kernelError("invalid_request", "Every goal agent requires a finite iteration limit");
      const configured = bounded.budget.total_token_limit;
      if (configured !== undefined && (!Number.isSafeInteger(configured) || configured <= 0))
        throw kernelError("invalid_request", "Goal run token limit must be finite and positive");
      bounded.budget = {
        ...bounded.budget,
        total_token_limit: Math.min(
          configured ?? admission.remaining_tokens,
          admission.remaining_tokens,
        ),
        on_exceed: "stop",
      };
      stewardRuntime ??= options.steward?.runtime(
        bounded.budget.total_token_limit!,
        bounded.prompt_cache_ttl ?? "5m",
      );
      return bounded;
    },
  };
  let execution: HostedExecutionBinding;
  try {
    execution = await options.prepareExecution(policy);
  } catch (error) {
    await stopped("failed");
    throw error;
  }
  if (
    execution.continuation !== undefined ||
    execution.commitSessionIntent !== undefined ||
    execution.prepareSettlement !== undefined
  )
    throw kernelError("conflict", "Goal execution already has a host turn policy");
  return {
    ...execution,
    commitSessionIntent(session) {
      const current = goalStateFromSession(session);
      if (current === undefined) throw kernelError("conflict", "Goal intent state disappeared");
      session.goal_state = goalStateToDto(
        admitGoalRun(current, {
          goal_id: goal.goal_id,
          expected_revision: initial.revision,
          control_revision: goal.control_revision,
          execution_id: executionId,
          admission_id: executionId,
          automatic,
          now: now(),
        }),
      );
    },
    async start() {
      options.context.signal.throwIfAborted();
      await options.repository.transact(sessionId, (state) => {
        if (state === undefined) throw kernelError("conflict", "Goal intent state disappeared");
        return {
          state: advanceGoalRun(state, { ...binding, phase: "running", now: now() }),
          result: undefined,
        };
      });
      options.context.signal.throwIfAborted();
      return execution.start();
    },
    prepareSettlement: createGoalStageSettlement({
      repository: options.repository,
      sessionId,
      executionId,
      signal: options.context.signal,
      now,
      usageTracker,
      runtime: () => runtime,
      ...(steward === undefined
        ? {}
        : { stewardCompletion: (result: unknown) => steward.completionCurrent(result) }),
      ...(options.validateDefinitionSources === undefined
        ? {}
        : {
            validateDefinitionSources: (sources: readonly { path: string; digest: string }[]) =>
              options.validateDefinitionSources!(sources),
          }),
      observeActivity: (current) =>
        observeStageActivity(options.evidence, current, executionId, options.logger),
      priceFor: (model) => options.priceFor?.(model),
    }),
    continuation: createGoalContinuation({
      sessionId,
      sessions: options.sessions,
      executionId,
      params,
      goalId: () => goal.goal_id,
      signal: options.context.signal,
      now,
      stopped,
    }),
  };
}

/**
 * Admit a regular visible conversation turn with a deferred Goal creation capability.  No Goal
 * state or Steward work exists before the main agent calls create_goal; once it does, the host
 * binds the current execution as the first stage and the ordinary Goal completion gate applies.
 */
export async function prepareHostedGoalCreationTurn(options: {
  params: StartRunParams;
  context: HostedPreparationContext;
  repository: GoalRepository;
  /** Canonical conversation reads; a successor is evaluated against the durable session. */
  sessions: Pick<SessionService, "get">;
  evidence: GoalEvidenceSource;
  seed: string;
  /** Existing objective offered as subordinate context to an ordinary authenticated turn. */
  operatorGoal?: GoalRecord;
  entryTokenLimit?: number;
  defaultLimits?: Partial<GoalLimits>;
  prepareExecution(policy: GoalCreationExecutionPolicy): Promise<HostedExecutionBinding>;
  readRun?(executionId: string): Promise<RunDetail | null>;
  steward?: {
    runtime(workTokenLimit: number, ttl: "5m" | "1h"): StewardExecutionRuntime;
    settle: StewardCoordinatorOptions["settle"];
  };
  logger?: Logger;
  now?: () => number;
  priceFor?(model: string): ModelCost | undefined;
  onChange?(sessionId: string): void;
}): Promise<HostedExecutionBinding> {
  const params = structuredClone(options.params);
  /** A successor continues the Objective; it must not replay this turn's creation intent. */
  const successorParams = structuredClone(params);
  delete successorParams.goal_intent;
  const session = options.context.session;
  const executionId = params.execution_id;
  const sessionId = session.id;
  if (
    executionId === undefined ||
    params.session_id !== sessionId ||
    params.agent_instance_id === undefined ||
    params.skill !== undefined
  )
    throw kernelError("unsupported", "Goal creation requires a bound ordinary conversation turn");
  const existing = goalStateFromSession(session)?.current;
  if (
    options.operatorGoal === undefined &&
    existing !== undefined &&
    existing.status !== "complete" &&
    existing.status !== "cancelled"
  )
    throw kernelError("conflict", "A Goal already exists for this conversation");
  const now = options.now ?? Date.now;
  const usageTracker = createGoalUsageTracker();
  let runtime: GoalRuntimePort | undefined;
  /** The durably created Goal, once this stage has one; it is what a successor may follow. */
  let created: { goal_id: string; control_revision: number } | undefined;
  const stopped = async (reason: "revoked" | "superseded" | "failed"): Promise<void> => {
    if (reason === "superseded" || created === undefined) return;
    await options.repository.transact(sessionId, (state) => ({
      state: stopGoalContinuation(state!, {
        goal_id: created!.goal_id,
        execution_id: executionId,
        control_revision: created!.control_revision,
        reason,
        now: now(),
      }),
      result: undefined,
    }));
  };
  let steward:
    | (GoalStewardPort & {
        completionCurrent(result: unknown): Promise<boolean>;
        observe(event: TraceEvent): void;
      })
    | undefined;
  let stewardRuntime: StewardExecutionRuntime | undefined;
  let reviewContextProvider: OperatorReviewContextProvider | undefined;
  let operatorRevision: number | undefined;
  const basePort = createGoalCreationPort({
    repository: options.repository,
    session,
    executionId,
    agentInstanceId: params.agent_instance_id,
    seed: options.seed,
    evidence: options.evidence,
    defaultLimits: options.defaultLimits,
    entryTokenLimit: options.entryTokenLimit,
    signal: options.context.signal,
    now,
    onChange: (sessionId) => options.onChange?.(sessionId),
  });
  const create = async (
    input: GoalCreationInput,
    signal?: AbortSignal,
  ): Promise<GoalRuntimePort> => {
    if (runtime === undefined && options.operatorGoal !== undefined) {
      options.context.signal.throwIfAborted();
      signal?.throwIfAborted();
      options.context.conversation?.signal.throwIfAborted();
      const goal = await options.repository.transact(sessionId, (state) => {
        options.context.signal.throwIfAborted();
        signal?.throwIfAborted();
        options.context.conversation?.signal.throwIfAborted();
        if (
          state?.current?.goal_id !== options.operatorGoal!.goal_id ||
          state.current.control_revision !== operatorRevision
        )
          throw kernelError("conflict", "A newer control superseded this Goal attachment");
        const resumed = applyGoalControl(
          state,
          {
            operation_id: `goal-attach:${executionId}`,
            expected_revision: state.revision,
            action: { kind: "resume" },
          },
          { session_id: sessionId, now: now(), physically_busy: false },
        );
        const goal = resumed.state.current!;
        const admitted = admitGoalRun(resumed.state, {
          goal_id: goal.goal_id,
          expected_revision: resumed.state.revision,
          control_revision: goal.control_revision,
          execution_id: executionId,
          admission_id: `goal-attach:${executionId}`,
          automatic: false,
          now: now(),
        });
        const running = advanceGoalRun(admitted, {
          goal_id: goal.goal_id,
          execution_id: executionId,
          phase: "running",
          now: now(),
        });
        return { state: running, result: running.current! };
      });
      runtime = createGoalRuntimePort({
        repository: options.repository,
        binding: {
          session_id: sessionId,
          execution_id: executionId,
          agent_instance_id: params.agent_instance_id!,
          goal_id: goal.goal_id,
          objective_revision: goal.objective_revision,
        },
        evidence: options.evidence,
        signal: options.context.signal,
        now,
      });
    }
    runtime ??= await basePort.create(input, signal);
    if (created === undefined) {
      const current = await options.repository.read(sessionId);
      const goal = current?.current;
      if (goal === undefined) throw kernelError("conflict", "Goal disappeared after creation");
      created = { goal_id: goal.goal_id, control_revision: goal.control_revision };
    }
    if (steward === undefined && options.steward !== undefined) {
      const current = await options.repository.read(sessionId);
      const goal = current?.current;
      if (goal === undefined) throw kernelError("conflict", "Goal disappeared after creation");
      steward = createGoalStewardCoordinator({
        binding: runtime.binding,
        repository: options.repository,
        runtimePort: runtime,
        runtime() {
          stewardRuntime ??= options.steward!.runtime(
            options.entryTokenLimit ?? goal.limits.max_net_tokens,
            "5m",
          );
          return stewardRuntime;
        },
        initialMessages: params.messages.flatMap((message) =>
          message.role === "user" && typeof message.content === "string" ? [message.content] : [],
        ),
        signal: options.context.signal,
        settle: options.steward.settle,
        changed: () => options.onChange?.(sessionId),
        operatorRequest: options.seed,
        ...(options.readRun === undefined
          ? {}
          : {
              recoverUsage: async (id: string) => {
                const usage = (await options.readRun!(id))?.result?.usage;
                return {
                  usage: measureGoalRunUsage(usage),
                  accounting: usage?.by_agent?.map((row) => ({
                    ...row,
                    type: "subagent" as const,
                  })),
                };
              },
            }),
      });
      if (reviewContextProvider !== undefined) steward.bindReviewContext(reviewContextProvider);
    }
    return runtime;
  };
  const creationPort: GoalCreationPort = {
    ...basePort,
    create,
    bindReviewContext: (provider: OperatorReviewContextProvider) => {
      reviewContextProvider = provider;
      steward?.bindReviewContext(provider);
    },
    reviewCompletion: (attempt: GoalStewardFinalizeAttempt, signal?: AbortSignal) =>
      steward?.reviewCompletion(attempt, signal) ??
      Promise.resolve({
        kind: "interrupted" as const,
        review_id: "unavailable",
        reason: "goal_steward_inconclusive",
        cause: "transport" as const,
      }),
  };
  const attachmentPort: GoalAttachmentPort | undefined =
    options.operatorGoal === undefined
      ? undefined
      : {
          session_id: sessionId,
          execution_id: executionId,
          agent_instance_id: params.agent_instance_id,
          goal: options.operatorGoal,
          attach: (signal) =>
            create(
              {
                objective: options.operatorGoal!.objective,
                criteria: options.operatorGoal!.criteria,
                constraints: [],
                exclusions: [],
                assumptions: [],
              },
              signal,
            ),
          bindReviewContext: (provider) => creationPort.bindReviewContext?.(provider),
          reviewCompletion: (attempt, signal) => creationPort.reviewCompletion!(attempt, signal),
        };
  const policy: GoalCreationExecutionPolicy = {
    capability:
      attachmentPort === undefined
        ? createGoalCreationCapability(creationPort)
        : createGoalAttachmentCapability(attachmentPort),
    observe: (event) => {
      options.evidence.observe(event);
      steward?.observe(event);
    },
    trackModel(provider) {
      const tracked = usageTracker.wrap(provider);
      return {
        async call(call) {
          if (runtime !== undefined) {
            const current = (await options.repository.read(sessionId))?.current;
            if (current === undefined || current.goal_id !== runtime.binding.goal_id)
              throw new ProviderError("Goal binding changed", { kind: "client" });
            const deadline = goalDeadlineLimit(current, now());
            if (deadline !== undefined)
              throw new ProviderError(deadline.reason, { kind: "client" });
            const spent = goalNetTokens(usageTracker.measure()) ?? 0;
            if (current.consumption.net_tokens + spent >= current.limits.max_net_tokens)
              throw new ProviderError("Goal token budget exhausted", { kind: "client" });
          }
          return tracked.call(call);
        },
      };
    },
  };
  const execution = await options.prepareExecution(policy);
  if (execution.commitSessionIntent !== undefined)
    throw kernelError("conflict", "Goal creation already has a host turn policy");
  return {
    ...execution,
    commitSessionIntent(target) {
      const current = goalStateFromSession(target);
      if (options.operatorGoal !== undefined) {
        if (current?.current?.goal_id !== options.operatorGoal.goal_id)
          throw kernelError("conflict", "Goal changed before operator admission");
        const paused = pauseGoalForPolicy(
          current,
          "An operator turn was accepted; automatic continuation stopped",
          now(),
        );
        target.goal_state = goalStateToDto(paused);
        operatorRevision = paused.current!.control_revision;
        return;
      }
      target.goal_state = goalStateToDto(
        admitGoalCreationIntent(current, {
          session_id: sessionId,
          execution_id: executionId,
          operation_id: `goal-create:${executionId}`,
          seed: options.seed,
          expected_revision: current?.revision ?? 0,
          now: now(),
        }),
      );
    },
    prepareSettlement: createGoalStageSettlement({
      repository: options.repository,
      sessionId,
      executionId,
      signal: options.context.signal,
      now,
      usageTracker,
      runtime: () => runtime,
      stewardCompletion: async (result) =>
        steward === undefined || (await steward.completionCurrent(result)),
      observeActivity: (current) =>
        observeStageActivity(options.evidence, current, executionId, options.logger),
      priceFor: (model) => options.priceFor?.(model),
    }),
    continuation: createGoalContinuation({
      sessionId,
      sessions: options.sessions,
      executionId,
      /** A successor continues the Objective; it must not replay this turn's creation intent. */
      params: successorParams,
      goalId: () => created?.goal_id,
      signal: options.context.signal,
      now,
      stopped,
    }),
  };
}
