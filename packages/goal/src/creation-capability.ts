import {
  PLANS_REVIEW_CONTEXT_PORT,
  openCallEnvelope,
  type AgentBuildContext,
  type AgentLoopContribution,
  type AgentResult,
  type GateOutcome,
  type HandlerVerdict,
  type RunCapability,
  type RunCapabilityContext,
  type ToolHandler,
} from "@clarvis/capability";
import { goalContextBlock, goalModelView, GOAL_BLOCK_KIND } from "./context.ts";
import { GoalError } from "./errors.ts";
import type { GoalCreationPort, GoalRuntimePort, GoalRuntimeSnapshot } from "./ports.ts";
import { goalCreationInputSchema, goalModelToolInputSchema } from "./model-input.ts";
import { goalCheckpointSchema } from "./schemas.ts";
import {
  CREATE_GOAL,
  GET_GOAL,
  UPDATE_GOAL,
  buildGoalCreationTools,
  getGoalInputSchema,
} from "./tools.ts";
import { absentReviewContext, checkGoalSnapshot } from "./runtime-validation.ts";
import { GOAL_CAPABILITY_NAME } from "./constants.ts";

const guardTripCodes = [
  "goal_blocked",
  "goal_control_failed",
  "goal_steward_failed",
  "goal_steward_inconclusive",
] as const;

type CreationState = {
  runtime?: GoalRuntimePort;
  snapshot?: GoalRuntimeSnapshot;
  checkpoint?: { summary: string; next_step: string };
  finalNudged: boolean;
};

function errorResult(bc: AgentBuildContext, code: string, message: string): AgentResult {
  return { status: "error", partialText: bc.state.lastAssistantText, error: { code, message } };
}

function createCreationState(): CreationState {
  return { finalNudged: false };
}

function createCreationHooks(
  state: CreationState,
  bc: AgentBuildContext,
): AgentLoopContribution["hooks"] {
  const publish = (): void => {
    if (state.snapshot !== undefined)
      bc.ctx.setStableBlock(GOAL_BLOCK_KIND, goalContextBlock(state.snapshot));
  };
  const refresh = async (signal?: AbortSignal): Promise<void> => {
    if (state.runtime === undefined) return;
    state.snapshot = checkGoalSnapshot(await state.runtime.read(signal), state.runtime.binding);
  };
  return {
    async beforeIteration(signal) {
      const cancelled = bc.maybeCancelled();
      if (cancelled !== null) return cancelled;
      try {
        await refresh(signal);
        publish();
      } catch {
        signal?.throwIfAborted();
        return (
          bc.maybeCancelled() ??
          errorResult(bc, "goal_control_failed", "Goal control is unavailable; execution stopped")
        );
      }
    },
    afterDispatch: publish,
  };
}

function createCreationHandler(
  state: CreationState,
  port: GoalCreationPort,
  bc: AgentBuildContext,
  tools: ReturnType<typeof buildGoalCreationTools>,
): ToolHandler {
  const refresh = async (): Promise<void> => {
    if (state.runtime === undefined) return;
    state.snapshot = checkGoalSnapshot(await state.runtime.read(bc.signal), state.runtime.binding);
  };
  const unavailable = (): AgentResult =>
    errorResult(bc, "goal_control_failed", "Goal control is unavailable; execution stopped");
  return {
    matches: (call) =>
      call.name === CREATE_GOAL || call.name === GET_GOAL || call.name === UPDATE_GOAL,
    async handle(call, iteration): Promise<HandlerVerdict> {
      const cancelled = bc.maybeCancelled();
      if (cancelled !== null) return { kind: "terminal", result: cancelled };
      const tool = tools.find((value) => value.wireName === call.name)!;
      const envelope = openCallEnvelope({
        call,
        name: call.name,
        trace: bc.trace,
        agent: bc.agent,
        subagentInstanceId: bc.subagentInstanceId,
        iteration,
        schema: tool.inputSchema,
        validate: bc.validateArgs,
      });
      const parsed =
        call.name === CREATE_GOAL
          ? goalCreationInputSchema.safeParse(call.arguments)
          : call.name === GET_GOAL
            ? getGoalInputSchema.safeParse(call.arguments)
            : goalModelToolInputSchema.safeParse(call.arguments);
      if (envelope.invalid !== null || !parsed.success)
        return {
          kind: "result",
          text: envelope.fail("Invalid Goal arguments; use the fields advertised by the tool"),
          progress: false,
        };
      envelope.start();
      try {
        if (call.name === CREATE_GOAL) {
          if (state.runtime !== undefined)
            return { kind: "result", text: envelope.ok("Goal already exists"), progress: false };
          state.runtime = await port.create(
            goalCreationInputSchema.parse(call.arguments),
            bc.signal,
          );
          state.snapshot = checkGoalSnapshot(
            await state.runtime.read(bc.signal),
            state.runtime.binding,
          );
          return {
            kind: "result",
            text: envelope.ok(
              "Goal created in this run. Continue the requested work, record progress, and submit a candidate before the final answer.",
            ),
            progress: false,
          };
        }
        if (state.runtime === undefined || state.snapshot === undefined)
          return {
            kind: "result",
            text: envelope.fail("Create the Goal first with create_goal"),
            progress: false,
          };
        if (call.name === GET_GOAL)
          return {
            kind: "result",
            text: envelope.ok(JSON.stringify(goalModelView(state.snapshot))),
            progress: false,
          };
        const action = goalModelToolInputSchema.parse(call.arguments).update;
        switch (action.action) {
          case "progress":
            await state.runtime.progress({
              summary: action.summary,
              evidence_ids: action.evidence_ids,
            });
            await refresh();
            return { kind: "result", text: envelope.ok("Progress recorded"), progress: false };
          case "checkpoint": {
            const recorded = await state.runtime.checkpoint({
              summary: action.summary,
              next_step: action.next_step,
              evidence_ids: action.evidence_ids,
            });
            await refresh();
            const checkpoint = goalCheckpointSchema.parse(recorded);
            state.checkpoint = { summary: checkpoint.summary, next_step: checkpoint.next_step };
            return {
              kind: "finalize",
              attempt: {
                mode: "checkpoint",
                disposition: "checkpoint",
                checkpoint: { summary: checkpoint.summary, next_step: checkpoint.next_step },
              },
              text: envelope.ok("Checkpoint requested; review and finalization gates still apply"),
              progress: false,
            };
          }
          case "candidate": {
            const validation = await state.runtime.candidate({
              summary: action.summary,
              assessments: action.assessments,
            });
            await refresh();
            return {
              kind: "result",
              text: envelope.ok(JSON.stringify(validation)),
              progress: false,
            };
          }
          case "blocked":
            await state.runtime.blocked(action.reason, bc.signal);
            return {
              kind: "terminal",
              result: errorResult(
                bc,
                "goal_blocked",
                "Goal blocked; user intervention is required",
              ),
            };
        }
      } catch {
        envelope.fail("Goal control failed; execution stopped");
        return { kind: "terminal", result: unavailable() };
      }
    },
  };
}

function createCreationGate(
  state: CreationState,
  port: GoalCreationPort,
  bc: AgentBuildContext,
): NonNullable<AgentLoopContribution["gates"]>[number] {
  return {
    fastAcceptOk: () => false,
    async check(attempt): Promise<GateOutcome> {
      const cancelled = bc.maybeCancelled();
      if (cancelled !== null) return { kind: "terminal", result: cancelled };
      if (state.runtime === undefined) {
        if (!state.finalNudged) {
          state.finalNudged = true;
          return {
            kind: "nudge",
            note: "Define the objective and criteria first with create_goal, then continue the work.",
          };
        }
        return {
          kind: "terminal",
          result: errorResult(bc, "goal_blocked", "Run ended before the Goal was created"),
        };
      }
      try {
        if (attempt.mode === "checkpoint") {
          if (
            state.checkpoint !== undefined &&
            state.checkpoint.summary === attempt.checkpoint.summary &&
            state.checkpoint.next_step === attempt.checkpoint.next_step
          )
            return { kind: "pass" };
          return {
            kind: "terminal",
            result: errorResult(
              bc,
              "goal_blocked",
              "Checkpoint was not requested through the bound goal control",
            ),
          };
        }
        const validation = await state.runtime.validateCompletion(bc.signal);
        if (validation.valid) {
          if (port.reviewCompletion === undefined) return { kind: "pass" };
          const projected =
            attempt.mode === "text"
              ? { mode: "text" as const, text: attempt.text ?? "" }
              : { mode: "submit" as const, text: attempt.text, submitted_value: attempt.value };
          if (Buffer.byteLength(JSON.stringify(projected), "utf8") > 128 * 1024)
            return {
              kind: "terminal",
              result: errorResult(
                bc,
                "goal_steward_inconclusive",
                "Final attempt exceeds the Goal Steward review bound",
              ),
            };
          const decision = await port.reviewCompletion(projected, bc.signal);
          if (decision.kind === "achieved") return { kind: "pass" };
          if (decision.kind === "needs_work" || decision.kind === "needs_evidence")
            return {
              kind: "nudge",
              note: `[goal steward ${decision.kind === "needs_evidence" ? "evidence request" : "correction"}] ${decision.next_step}`,
            };
          return {
            kind: "terminal",
            result: errorResult(bc, decision.reason, "Goal Steward could not verify completion"),
          };
        }
        if (
          !state.finalNudged &&
          (attempt.mode !== "text" || (attempt.text?.trim().length ?? 0) > 0)
        ) {
          state.finalNudged = true;
          return {
            kind: "nudge",
            note: `The Goal is not complete. Record a candidate covering every criterion, or checkpoint remaining work. ${validation.reasons.join("; ")}`,
          };
        }
        return {
          kind: "terminal",
          result: errorResult(
            bc,
            "goal_blocked",
            "Run ended without a valid Goal completion candidate",
          ),
        };
      } catch {
        return {
          kind: "terminal",
          result: errorResult(
            bc,
            "goal_control_failed",
            "Goal control is unavailable; execution stopped",
          ),
        };
      }
    },
  };
}

/** Build the stable-catalog entry capability; creation changes handlers and state, never tools. */
export function createGoalCreationRunCapability(
  port: GoalCreationPort,
  runContext: RunCapabilityContext,
): RunCapability {
  if (
    runContext.request.session_id !== port.session_id ||
    runContext.request.agent_instance_id !== port.agent_instance_id ||
    runContext.executionId !== port.execution_id
  )
    throw new GoalError("conflict", "Goal creation requires its admitted entry identity");
  return {
    name: GOAL_CAPABILITY_NAME,
    required: true,
    preserveStateOnInterruption: true,
    order: -200,
    guardTripCodes,
    forAgent(scope) {
      if (!scope.entry) return null;
      const state = createCreationState();
      return {
        attach(bc: AgentBuildContext): AgentLoopContribution {
          port.bindReviewContext?.(
            runContext.services.get(PLANS_REVIEW_CONTEXT_PORT) ?? absentReviewContext,
          );
          const tools = buildGoalCreationTools();
          const contribution: AgentLoopContribution = {
            tools,
            hooks: createCreationHooks(state, bc),
            handlers: [createCreationHandler(state, port, bc, tools)],
            gates: [createCreationGate(state, port, bc)],
          };
          return contribution;
        },
      };
    },
  };
}
