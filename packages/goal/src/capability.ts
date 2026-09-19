import {
  NOOP_LOGGER,
  PLANS_REVIEW_CONTEXT_PORT,
  openCallEnvelope,
  type AgentBuildContext,
  type AgentLoopContribution,
  type AgentResult,
  type Capability,
  type CheckpointMetadata,
  type GateOutcome,
  type HandlerVerdict,
} from "@clarvis/capability";
import { GOAL_BLOCK_KIND, goalContextBlock, goalModelView } from "./context.ts";
import { GoalError } from "./errors.ts";
import type { GoalCreationPort, GoalRuntimePort } from "./ports.ts";
import { goalModelToolInputSchema } from "./model-input.ts";
import { goalCheckpointSchema } from "./schemas.ts";
import { CREATE_GOAL, GET_GOAL, UPDATE_GOAL, buildGoalTools, getGoalInputSchema } from "./tools.ts";
import { absentReviewContext, checkGoalSnapshot } from "./runtime-validation.ts";
import { createGoalCreationRunCapability } from "./creation-capability.ts";
import { GOAL_CAPABILITY_NAME } from "./constants.ts";

export { GOAL_CAPABILITY_NAME } from "./constants.ts";
const runtimePorts = new WeakMap<Capability, GoalRuntimePort>();

/** Recover trusted placement authority only for a capability created by this factory. */
export function goalRuntimePortOf(capability: Capability): GoalRuntimePort | undefined {
  return runtimePorts.get(capability);
}

/**
 * Register one mandatory host-bound entry capability. No model argument selects identity, user
 * controls, budget or evidence scope. Checkpoint requests use generic finalization gates; final
 * acceptance is still only a candidate for the host's later physical and durable settlement.
 */
export function createGoalCapability(port: GoalRuntimePort): Capability {
  const binding = Object.freeze({ ...port.binding });
  const logger = port.logger ?? NOOP_LOGGER;
  const capability: Capability = {
    name: GOAL_CAPABILITY_NAME,
    required: true,
    reservedWireNames: [GET_GOAL, UPDATE_GOAL],
    toolEffects: { [GET_GOAL]: "control", [UPDATE_GOAL]: "control" },
    async forRun(runContext) {
      if (
        runContext.executionId !== binding.execution_id ||
        runContext.request.session_id !== binding.session_id ||
        runContext.request.agent_instance_id !== binding.agent_instance_id
      )
        throw new GoalError("conflict", "Goal capability requires its admitted entry identity");
      let snapshot = checkGoalSnapshot(await port.read(), binding, true);
      return {
        name: GOAL_CAPABILITY_NAME,
        required: true,
        preserveStateOnInterruption: true,
        order: -200,
        guardTripCodes: [
          "goal_blocked",
          "goal_control_failed",
          "goal_steward_failed",
          "goal_steward_inconclusive",
        ],
        forAgent(scope) {
          if (!scope.entry) return null;
          return {
            attach(bc: AgentBuildContext): AgentLoopContribution {
              const steward = port.steward;
              steward?.bindReviewContext(
                runContext.services.get(PLANS_REVIEW_CONTEXT_PORT) ?? absentReviewContext,
              );
              const tools = buildGoalTools();
              let checkpoint: CheckpointMetadata | undefined;
              let finalNudged = false;
              const reviewed = new Set<string>();
              const recordReviews = (): void => {
                for (const review of snapshot.goal.runs.at(-1)?.steward_reviews ?? []) {
                  if (reviewed.has(review.steward_execution_id)) continue;
                  reviewed.add(review.steward_execution_id);
                  bc.trace.record("goal_steward_review", {
                    steward_execution_id: review.steward_execution_id,
                    work_execution_id: binding.execution_id,
                    mode: review.mode,
                    decision: review.decision,
                  });
                }
              };
              /** Publish outside dispatch so a reminder never splits an assistant/tool exchange. */
              const publish = (): void => {
                bc.ctx.setStableBlock(GOAL_BLOCK_KIND, goalContextBlock(snapshot));
              };
              const refresh = async (signal?: AbortSignal): Promise<void> => {
                const next = await port.read(signal);
                signal?.throwIfAborted();
                snapshot = checkGoalSnapshot(next, binding);
                recordReviews();
              };
              const failed = (code: string, message: string): AgentResult => ({
                status: "error",
                partialText: bc.state.lastAssistantText,
                error: { code, message },
              });
              const unavailable = (): AgentResult => {
                logger.error(
                  { event: "goal.control.failed", execution_id: binding.execution_id },
                  "Bound goal control failed; execution requires host attention",
                );
                return failed(
                  "goal_control_failed",
                  "Goal control is unavailable; execution stopped",
                );
              };
              const block = async (reason: string): Promise<AgentResult> => {
                await port.blocked(reason);
                return failed("goal_blocked", reason);
              };
              publish();
              return {
                tools,
                hooks: {
                  async beforeIteration(signal) {
                    const cancelled = bc.maybeCancelled();
                    if (cancelled !== null) return cancelled;
                    try {
                      await refresh(signal);
                      const cancelled = bc.maybeCancelled();
                      if (cancelled !== null) return cancelled;
                      publish();
                    } catch {
                      signal?.throwIfAborted();
                      return bc.maybeCancelled() ?? unavailable();
                    }
                  },
                  afterDispatch() {
                    publish();
                  },
                  async onTeardown() {
                    await steward?.closeCoordinator();
                    publish();
                  },
                },
                handlers: [
                  {
                    matches: (call) => call.name === GET_GOAL || call.name === UPDATE_GOAL,
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
                        call.name === GET_GOAL
                          ? getGoalInputSchema.safeParse(call.arguments)
                          : goalModelToolInputSchema.safeParse(call.arguments);
                      if (envelope.invalid !== null || !parsed.success)
                        return {
                          kind: "result",
                          text: envelope.fail(
                            "Invalid goal arguments; use the fields for this action only",
                          ),
                          progress: false,
                        };
                      envelope.start();
                      try {
                        await refresh();
                        if (call.name === GET_GOAL)
                          return {
                            kind: "result",
                            text: envelope.ok(JSON.stringify(goalModelView(snapshot))),
                            progress: false,
                          };
                        const action = goalModelToolInputSchema.parse(call.arguments).update;
                        switch (action.action) {
                          case "progress":
                            await port.progress({
                              summary: action.summary,
                              evidence_ids: action.evidence_ids,
                            });
                            await refresh();
                            return {
                              kind: "result",
                              text: envelope.ok("Progress recorded; stage remains open"),
                              progress: false,
                            };
                          case "checkpoint": {
                            const recorded = goalCheckpointSchema.parse(
                              await port.checkpoint({
                                summary: action.summary,
                                next_step: action.next_step,
                                evidence_ids: action.evidence_ids,
                              }),
                            );
                            await refresh();
                            checkpoint = {
                              summary: recorded.summary,
                              next_step: recorded.next_step,
                            };
                            return {
                              kind: "finalize",
                              attempt: {
                                mode: "checkpoint",
                                disposition: "checkpoint",
                                checkpoint,
                              },
                              text: envelope.ok(
                                "Checkpoint requested; review and finalization gates still apply",
                              ),
                              progress: false,
                            };
                          }
                          case "candidate": {
                            const validation = await port.candidate({
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
                          case "blocked": {
                            const result = await block(action.reason);
                            envelope.ok(
                              "Goal blocked; user intervention and explicit resume are required",
                            );
                            return { kind: "terminal", result };
                          }
                        }
                      } catch {
                        envelope.fail("Goal control failed; execution stopped for host attention");
                        return { kind: "terminal", result: unavailable() };
                      }
                    },
                  },
                ],
                gates: [
                  {
                    fastAcceptOk: () => false,
                    async check(attempt): Promise<GateOutcome> {
                      const cancelled = bc.maybeCancelled();
                      if (cancelled !== null) return { kind: "terminal", result: cancelled };
                      try {
                        await refresh();
                        if (attempt.mode === "checkpoint") {
                          if (
                            checkpoint !== undefined &&
                            checkpoint.summary === attempt.checkpoint.summary &&
                            checkpoint.next_step === attempt.checkpoint.next_step
                          )
                            return { kind: "pass" };
                          return {
                            kind: "terminal",
                            result: await block(
                              "Checkpoint was not requested through the bound goal control",
                            ),
                          };
                        }
                        const validation = await port.validateCompletion();
                        if (validation.valid) {
                          if (steward === undefined) return { kind: "pass" };
                          if (bc.steerProbe?.())
                            return {
                              kind: "nudge",
                              note: "Process the pending operator message before concluding this Goal.",
                            };
                          const resume = bc.clock?.pauseCompute();
                          try {
                            const projected =
                              attempt.mode === "text"
                                ? { mode: "text" as const, text: attempt.text ?? "" }
                                : {
                                    mode: "submit" as const,
                                    text: attempt.text,
                                    submitted_value: attempt.value,
                                  };
                            if (Buffer.byteLength(JSON.stringify(projected), "utf8") > 128 * 1024)
                              return {
                                kind: "terminal",
                                result: failed(
                                  "goal_steward_inconclusive",
                                  "Final attempt exceeds the Goal Steward review bound",
                                ),
                              };
                            const decision = await steward.reviewCompletion(projected, bc.signal);
                            await refresh();
                            if (bc.steerProbe?.())
                              return {
                                kind: "nudge",
                                note: "Process the pending operator message before concluding this Goal.",
                              };
                            if (decision.kind === "achieved") return { kind: "pass" };
                            if (
                              decision.kind === "needs_work" ||
                              decision.kind === "needs_evidence"
                            )
                              return {
                                kind: "nudge",
                                note: `[goal steward ${decision.kind === "needs_evidence" ? "evidence request" : "correction"}] ${decision.next_step}`,
                              };
                            return {
                              kind: "terminal",
                              result: failed(
                                decision.reason === "goal_steward_failed"
                                  ? "goal_steward_failed"
                                  : "goal_steward_inconclusive",
                                decision.reason,
                              ),
                            };
                          } catch {
                            return {
                              kind: "terminal",
                              result:
                                bc.maybeCancelled() ??
                                failed(
                                  "goal_steward_failed",
                                  "Goal Steward could not verify completion",
                                ),
                            };
                          } finally {
                            resume?.();
                          }
                        }
                        if (
                          !finalNudged &&
                          (attempt.mode !== "text" || (attempt.text?.trim().length ?? 0) > 0)
                        ) {
                          finalNudged = true;
                          return {
                            kind: "nudge",
                            note: "The goal has no valid completion candidate. Read get_goal, then use update_goal candidate with every current criterion, checkpoint for remaining work, or blocked for a missing decision. A final answer alone cannot complete the goal.",
                          };
                        }
                        return {
                          kind: "terminal",
                          result: await block(
                            "Run ended without a valid goal completion candidate or accepted checkpoint",
                          ),
                        };
                      } catch {
                        return { kind: "terminal", result: unavailable() };
                      }
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
  runtimePorts.set(capability, port);
  return capability;
}

/**
 * Main-agent entry capability for a guided `/goal` turn.  It starts with no Goal state, exposes
 * one host-bound create tool, and activates the normal Goal controls and completion gate only
 * after that tool has durably created the objective.  This keeps formulation in the visible run
 * while making the host the sole authority for identity, limits and evidence bindings.
 */
export function createGoalCreationCapability(port: GoalCreationPort): Capability {
  return {
    name: GOAL_CAPABILITY_NAME,
    required: true,
    reservedWireNames: [CREATE_GOAL, GET_GOAL, UPDATE_GOAL],
    toolEffects: { [CREATE_GOAL]: "control", [GET_GOAL]: "control", [UPDATE_GOAL]: "control" },
    forRun(runContext) {
      return createGoalCreationRunCapability(port, runContext);
    },
  };
}
