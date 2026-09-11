import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import {
  applyGoalControl,
  emptyGoalState,
  goalControlSchema,
  pauseGoalForPolicy,
  stopGoalContinuation,
  type GoalRepository,
  type GoalRecord,
  type GoalLimits,
} from "@clarvis/goal";
import type { GoalService, SessionService, StartRunParams } from "@clarvis/protocol";
import { generateExecutionId } from "@clarvis/trace";
import type { HostedRegistry } from "../hosting/registry.ts";
import type { HostedConversationAuthority } from "../hosting/admission.ts";
import { kernelError, toKernelError } from "../core/errors.ts";
import { toGoalKernelError } from "./errors.ts";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:-]+$/u);
const requestSchema = goalControlSchema.extend({ session_id: identifier });

/** One authenticated connection's user controls over the host's private conversation store. */
export function createGoalService(options: {
  peerId: string;
  repository: GoalRepository;
  sessions: Pick<SessionService, "get">;
  registry: HostedRegistry;
  assertAuthority(): Promise<void>;
  assertWritable(): void;
  beginControl(): () => void;
  defaultLimits(): Promise<Partial<GoalLimits>>;
  entryTokenLimit(params: StartRunParams): number | undefined;
  logger?: Logger;
  subscribe: GoalService["subscribe"];
}): { service: GoalService; close(): Promise<void> } {
  const logger = options.logger ?? NOOP_LOGGER;
  const watches = new Map<HostedConversationAuthority, { goalId: string; revision: number }>();
  const pending = new Set<Promise<void>>();
  const controls = new Set<PromiseWithResolvers<void>>();
  const assert = (authority: HostedConversationAuthority): void => {
    options.assertWritable();
    options.registry.assertController(authority);
  };
  const watch = (authority: HostedConversationAuthority, goal: GoalRecord | undefined): void => {
    if (goal === undefined) return;
    const existing = watches.has(authority);
    watches.set(authority, { goalId: goal.goal_id, revision: goal.control_revision });
    if (existing) return;
    const revoke = (): void => {
      const bound = watches.get(authority);
      watches.delete(authority);
      if (bound === undefined) return;
      const work = (async () => {
        const deadline = performance.now() + 5000;
        for (;;) {
          try {
            await options.repository.transact(authority.sessionId, (state) => ({
              state:
                state?.current?.goal_id === bound.goalId &&
                state.current.control_revision === bound.revision
                  ? pauseGoalForPolicy(
                      state,
                      "Conversation authority was retired; explicit resume is required",
                      Date.now(),
                    )
                  : (state ?? emptyGoalState()),
              result: undefined,
            }));
            return;
          } catch (error) {
            if (toKernelError(error).code !== "conflict" || performance.now() >= deadline)
              throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
        }
      })();
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => {
          logger.error(
            { event: "goal.authority.retirement_failed", session_id: authority.sessionId },
            "Goal controller retirement failed",
          );
        },
      );
    };
    authority.signal.addEventListener("abort", revoke, { once: true });
    if (authority.signal.aborted) revoke();
  };
  const readSession = async (sessionId: string) => {
    identifier.parse(sessionId);
    const session = await options.sessions.get(sessionId);
    if (session === null) throw kernelError("not_found", "Goal conversation does not exist");
    return session;
  };
  return {
    service: {
      availability: async () => ({ available: true }),
      async subscribe(sessionId, listener) {
        await readSession(sessionId);
        return options.subscribe(sessionId, listener);
      },
      async get(sessionId) {
        try {
          const session = await readSession(sessionId);
          const physical = options.registry.physicalRun(sessionId);
          return {
            state: session.goal_state ?? emptyGoalState(),
            ...(physical === undefined ? {} : { physical_run: physical }),
          };
        } catch (error) {
          throw toGoalKernelError(error);
        }
      },
      async receipt(sessionId, operationId) {
        try {
          identifier.parse(operationId);
          return (
            (await readSession(sessionId)).goal_state?.receipts.find(
              (receipt) => receipt.operation_id === operationId,
            ) ?? null
          );
        } catch (error) {
          throw toGoalKernelError(error);
        }
      },
      async control(input) {
        let release: (() => void) | undefined;
        const settled = Promise.withResolvers<void>();
        try {
          release = options.beginControl();
          controls.add(settled);
          if (Buffer.byteLength(JSON.stringify(input), "utf8") > 128 * 1024)
            throw kernelError("resource_exhausted", "Goal control exceeds its byte bound");
          const { session_id: sessionId, ...control } = requestSchema.parse(input);
          await options.assertAuthority();
          const session = await readSession(sessionId);
          options.registry.assertOperator(options.peerId);
          if (
            session.goal_state?.receipts.some(
              (receipt) => receipt.operation_id === control.operation_id,
            )
          ) {
            options.assertWritable();
            return applyGoalControl(session.goal_state, control, {
              session_id: sessionId,
              now: Date.now(),
              physically_busy: options.registry.occupied(sessionId),
            }).receipt;
          }
          const authority = options.registry.claimController(options.peerId, sessionId);
          assert(authority);
          const executionId = generateExecutionId();
          const params: StartRunParams & { execution_id: string } = {
            execution_id: executionId,
            ...(session.agent_profile === undefined ? {} : { agent: session.agent_profile }),
            messages: [
              {
                role: "user",
                content:
                  "Work toward the current persistent goal under its criteria, approvals and remaining limits.",
              },
            ],
          };
          const action = control.action;
          const creating = action.kind === "create" || action.kind === "replace";
          const defaultLimits = creating ? await options.defaultLimits() : undefined;
          const tokenLimit =
            creating &&
            action.limits?.max_net_tokens === undefined &&
            defaultLimits?.max_net_tokens === undefined
              ? options.entryTokenLimit(params)
              : undefined;
          await options.assertAuthority();
          assert(authority);
          const result = await options.repository.transact(sessionId, (state) => {
            assert(authority);
            const result = applyGoalControl(state, control, {
              session_id: sessionId,
              new_goal_id: randomUUID(),
              new_execution_id: executionId,
              default_limits: defaultLimits,
              entry_token_limit: tokenLimit,
              now: Date.now(),
              physically_busy: options.registry.occupied(sessionId),
            });
            return { state: result.state, result };
          });
          watch(authority, result.state.current);
          if (result.replayed) return result.receipt;
          if (result.cancel_execution_id !== undefined) {
            await options.assertAuthority();
            assert(authority);
            await options.registry.cancelControlled(authority, result.cancel_execution_id);
          }
          if (result.start) {
            const bound = result.state.current!;
            try {
              await options.assertAuthority();
              const current = await readSession(sessionId);
              assert(authority);
              if (
                current.goal_state?.current?.goal_id !== bound.goal_id ||
                current.goal_state.current.control_revision !== bound.control_revision
              )
                throw kernelError("conflict", "Goal changed before its reserved execution started");
              const previous = current.turns.findLast(
                (turn) => turn.kind === "conversation" && turn.execution_id !== undefined,
              )?.execution_id;
              await options.registry.startControlled(authority, {
                session_id: sessionId,
                session_revision: current.revision ?? 0,
                kind: "conversation",
                user_preview: "Work toward the persistent goal",
                params: {
                  ...params,
                  ...(previous === undefined ? {} : { continue_from: previous }),
                },
              });
            } catch (error) {
              await options.repository.transact(sessionId, (state) => ({
                state: stopGoalContinuation(state!, {
                  goal_id: bound.goal_id,
                  execution_id: executionId,
                  previous_execution_id: bound.runs.at(-1)?.execution_id,
                  control_revision: bound.control_revision,
                  reason: authority.signal.aborted ? "revoked" : "failed",
                  now: Date.now(),
                }),
                result: undefined,
              }));
              throw error;
            }
          }
          return result.receipt;
        } catch (error) {
          throw toGoalKernelError(error);
        } finally {
          release?.();
          controls.delete(settled);
          settled.resolve();
        }
      },
    },
    async close() {
      await Promise.all([...controls].map((control) => control.promise));
      await Promise.all(pending);
    },
  };
}
