import {
  ProviderError,
  type Capability,
  type LLMProvider,
  type Logger,
  type TraceEvent,
} from "@clarvis/capability";
import {
  admitGoalRun,
  advanceGoalRun,
  createGoalCapability,
  goalAdmission,
  goalDeadlineLimit,
  stopGoalContinuation,
  type GoalRepository,
} from "@clarvis/goal";
import type { RunRequest } from "@clarvis/loop";
import type { ModelCost, SessionService, StartRunParams } from "@clarvis/protocol";
import { generateExecutionId } from "@clarvis/trace";
import type { HostedExecutionBinding, HostedPreparationContext } from "../hosting/sessions.ts";
import { kernelError } from "../core/errors.ts";
import type { GoalEvidenceSource } from "./evidence.ts";
import { createGoalRuntimePort } from "./runtime-port.ts";
import { goalStateFromSession, goalStateToDto } from "./session-state.ts";
import { settleGoalSession } from "./settlement.ts";
import { createGoalUsageTracker } from "./usage.ts";

/** Mandatory entry capability and finite request policy for one host-admitted stage. */
export interface GoalExecutionPolicy {
  capability: Capability;
  observe(event: TraceEvent): void;
  /** Observe complete host inference accounting without trusting zero-filled guest totals. */
  trackModel(provider: LLMProvider): LLMProvider;
  /** Apply after ordinary profile/settings resolution, before immutable launch preparation. */
  constrain(request: RunRequest): RunRequest;
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
  prepareExecution(policy: GoalExecutionPolicy): Promise<HostedExecutionBinding>;
  logger?: Logger;
  now?: () => number;
  priceFor?(model: string): ModelCost | undefined;
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
  if (
    automatic &&
    (previous === undefined ||
      options.context.continuationOf !== previous.execution_id ||
      params.continue_from !== previous.execution_id ||
      previous.phase !== "closed" ||
      previous.disposition !== "checkpoint" ||
      previous.outcome !== "completed")
  )
    throw kernelError("conflict", "Goal continuation does not follow its settled checkpoint");
  const admission = goalAdmission(goal, now(), automatic);
  if (admission.allowed === false) throw kernelError("conflict", admission.reason);
  const binding = {
    session_id: sessionId,
    agent_instance_id: params.agent_instance_id,
    execution_id: executionId,
    goal_id: goal.goal_id,
    objective_revision: goal.objective_revision,
  };
  const runtime = createGoalRuntimePort({
    repository: options.repository,
    binding,
    evidence: options.evidence,
    signal: options.context.signal,
    logger: options.logger,
    now,
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
    capability: createGoalCapability(runtime),
    observe: (event) => options.evidence.observe(event),
    trackModel(provider) {
      const tracked = usageTracker.wrap(provider);
      return {
        call(call) {
          const deadline = goalDeadlineLimit(goal, now());
          if (deadline !== undefined) {
            throw new ProviderError(deadline.reason, { kind: "client" });
          }
          return tracked.call(call);
        },
      };
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
      return bounded;
    },
  };
  const usageTracker = createGoalUsageTracker();
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
    async prepareSettlement(result) {
      const current = await options.repository.read(sessionId);
      const owned = current?.current;
      const run = owned?.runs.find((item) => item.execution_id === executionId);
      let validationRevision: number | undefined;
      if (owned?.goal_id === goal.goal_id && run !== undefined && run.phase !== "closed") {
        await options.repository.transact(sessionId, (state) => ({
          state: advanceGoalRun(state!, { ...binding, phase: "settling", now: now() }),
          result: undefined,
        }));
        const before = await options.repository.read(sessionId);
        if (
          result.status === "completed" &&
          result.disposition !== "checkpoint" &&
          before?.current?.status === "active" &&
          before.current.candidate?.execution_id === executionId &&
          !options.context.signal.aborted
        ) {
          try {
            const validation = await runtime.validateCompletion();
            if (validation.valid) validationRevision = validation.revision;
          } catch (error) {
            const latest = (await options.repository.read(sessionId))?.current;
            if (
              latest?.goal_id !== goal.goal_id ||
              (latest.status === "active" && latest.control_revision === goal.control_revision)
            )
              throw error;
          }
        }
      }
      return (session) =>
        settleGoalSession(
          session,
          result,
          {
            disposition: result.disposition ?? "final",
            usage: usageTracker.measure(),
            completion_validated:
              validationRevision !== undefined &&
              session.goal_state?.revision === validationRevision,
          },
          now(),
          (model) => options.priceFor?.(model),
        );
    },
    continuation: {
      async prepare(signal) {
        signal.throwIfAborted();
        const session = await options.sessions.get(sessionId);
        signal.throwIfAborted();
        const current = session === null ? undefined : goalStateFromSession(session)?.current;
        if (
          session === null ||
          current?.goal_id !== goal.goal_id ||
          current.control_revision !== goal.control_revision ||
          current.runs.at(-1)?.execution_id !== executionId ||
          !goalAdmission(current, now(), true).allowed
        )
          return undefined;
        return {
          session_id: sessionId,
          session_revision: session.revision ?? 0,
          kind: "conversation",
          user_preview: "Continue the persistent goal",
          params: {
            ...params,
            execution_id: generateExecutionId(),
            continue_from: executionId,
            messages: [
              {
                role: "user",
                content:
                  "Continue the current goal from its accepted checkpoint. Preserve the current objective, approvals and remaining limits.",
              },
            ],
          },
        };
      },
      stopped,
    },
  };
}
