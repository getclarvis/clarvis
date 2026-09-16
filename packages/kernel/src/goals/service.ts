import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import {
  applyGoalControl,
  applyGoalFormulation,
  emptyGoalState,
  formulationCriteria,
  goalControlSchema,
  goalFormulateRequestSchema,
  goalFormulationFingerprint,
  recordGoalFormulationReceipt,
  pauseGoalForPolicy,
  stopGoalContinuation,
  type GoalRepository,
  type GoalRecord,
  type GoalLimits,
  type GoalAgentRunInput,
  type GoalAgentRunResult,
  GoalAgentRunFailure,
  type GoalDefinitionSource,
} from "@clarvis/goal";
import type { TraceEvent } from "@clarvis/capability";
import type {
  GoalFormulateResult,
  GoalService,
  RunDetail,
  Session,
  SessionService,
  StartRunParams,
} from "@clarvis/protocol";
import { generateExecutionId } from "@clarvis/trace";
import type { HostedRegistry } from "../hosting/registry.ts";
import type { HostedConversationAuthority } from "../hosting/admission.ts";
import { kernelError, toKernelError } from "../core/errors.ts";
import { toGoalKernelError } from "./errors.ts";
import type { HostedSessionTransactions } from "../hosting/sessions.ts";
import { goalStateFromSession, goalStateToDto } from "./session-state.ts";
import { projectGoalTrajectory } from "./trajectory.ts";
import { verifyTraceNormativeSources } from "./trace-reads.ts";

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
  transactions: HostedSessionTransactions;
  readRun(executionId: string): Promise<RunDetail | null>;
  readTrace(executionId: string): readonly TraceEvent[] | undefined;
  readWorkspaceFile(path: string): Promise<{ path: string; content: string }>;
  formulateRun(input: GoalAgentRunInput): Promise<GoalAgentRunResult>;
  workspaceReadAvailable: boolean;
}): { service: GoalService; close(): Promise<void> } {
  const logger = options.logger ?? NOOP_LOGGER;
  const watches = new Map<HostedConversationAuthority, { goalId: string; revision: number }>();
  const pending = new Set<Promise<void>>();
  const controls = new Set<PromiseWithResolvers<void>>();
  const formulations = new Map<
    string,
    { fingerprint: string; promise: Promise<GoalFormulateResult> }
  >();
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
  const paramsFor = (
    session: Session,
    executionId: string,
  ): StartRunParams & { execution_id: string } => ({
    execution_id: executionId,
    ...(session.agent_profile === undefined ? {} : { agent: session.agent_profile }),
    messages: [
      {
        role: "user",
        content:
          "Work toward the current persistent goal under its criteria, approvals and remaining limits.",
      },
    ],
  });
  const startReserved = async (
    authority: HostedConversationAuthority,
    sessionId: string,
    bound: GoalRecord,
    executionId: string,
    params: StartRunParams & { execution_id: string },
  ): Promise<void> => {
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
        user_preview: `Work toward the persistent goal: ${bound.objective}`,
        params: { ...params, ...(previous === undefined ? {} : { continue_from: previous }) },
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
  };

  const formulation = async (raw: unknown): Promise<GoalFormulateResult> => {
    const request = goalFormulateRequestSchema.parse(raw);
    const fingerprint = goalFormulationFingerprint(request);
    const formulationKey = `${request.session_id}\0${request.operation_id}`;
    const existing = formulations.get(formulationKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint)
        throw kernelError("conflict", "Operation ID was already used for another formulation");
      return existing.promise;
    }
    const release = options.beginControl();
    const task = (async (): Promise<GoalFormulateResult> => {
      await options.assertAuthority();
      options.registry.assertOperator(options.peerId);
      const captured = await readSession(request.session_id);
      const goalState = captured.goal_state ?? emptyGoalState();
      const known = goalState.receipts.find(
        (receipt) => receipt.operation_id === request.operation_id,
      );
      if (known !== undefined) {
        if (known.fingerprint !== fingerprint)
          throw kernelError("conflict", "Operation ID was already used for another formulation");
        if (known.formulation === undefined)
          throw kernelError("conflict", "Operation ID belongs to a non-formulation control");
        return { ...known, formulation: known.formulation };
      }
      if (goalState.revision !== request.expected_revision)
        throw kernelError("conflict", "Goal revision changed; reload before formulating");
      if (goalState.current !== undefined)
        throw kernelError("conflict", "A goal already exists; review, cancel or clear it first");
      if (options.registry.occupied(request.session_id))
        throw kernelError("conflict", "A running conversation cannot acquire a goal");
      const authority = options.registry.claimController(options.peerId, request.session_id);
      assert(authority);
      const trajectory = await projectGoalTrajectory(
        captured,
        (executionId) => options.readRun(executionId),
        {
          workspace_read_available: options.workspaceReadAvailable,
          ...(request.mode === "guided" ? { exclude_user_text: request.seed } : {}),
        },
      );
      let formulationExecutionId: string | undefined = undefined;
      const commitReceipt = async (
        outcome: "insufficient_context" | "failed",
        details: { question?: string; message?: string },
        usage?: GoalAgentRunResult["usage"],
      ): Promise<GoalFormulateResult> => {
        const committed = await options.transactions.transact(request.session_id, (session) => {
          const stale = (session.revision ?? 0) !== (captured.revision ?? 0);
          const state = goalStateFromSession(session);
          const result = recordGoalFormulationReceipt(state, {
            operation_id: request.operation_id,
            expected_revision: state?.revision ?? 0,
            fingerprint,
            formulation_execution_id: formulationExecutionId,
            mode: request.mode,
            outcome: stale ? "stale_context" : outcome,
            ...(stale
              ? { message: "Conversation changed during formulation; invoke /goal again" }
              : details),
          });
          session.goal_state = goalStateToDto(result.state);
          if (usage?.kind === "measured" && !result.replayed) {
            session.totals.input += usage.input;
            session.totals.output += usage.output;
            if (session.totals.cached !== undefined) session.totals.cached += usage.cached ?? 0;
          }
          return {
            session,
            result: { ...result.receipt, formulation: result.receipt.formulation! },
          };
        });
        logger.info(
          {
            event: "goal.formulation.completed",
            session_id: request.session_id,
            ...(formulationExecutionId === undefined
              ? {}
              : { formulation_execution_id: formulationExecutionId }),
            mode: request.mode,
            outcome: committed.formulation.outcome,
            usage_kind: usage?.kind ?? "none",
            ...(usage?.kind === "measured"
              ? {
                  input_tokens: usage.input,
                  output_tokens: usage.output,
                  cached_tokens: usage.cached ?? 0,
                }
              : {}),
          },
          "Goal formulation completed",
        );
        return committed;
      };

      if (request.mode === "auto" && trajectory.eligible_user_messages === 0)
        return commitReceipt("insufficient_context", {
          question: "What outcome should Clarvis pursue?",
        });

      formulationExecutionId = generateExecutionId();
      let analyzed: GoalAgentRunResult;
      try {
        analyzed = await options.formulateRun({
          mode: request.mode,
          ...(request.mode === "guided" ? { seed: request.seed } : {}),
          trajectory,
          execution_id: formulationExecutionId,
          agent_instance_id: randomUUID(),
          session_id: request.session_id,
          signal: authority.signal,
        });
      } catch (error) {
        logger.warn(
          {
            event: "goal.formulation.failed",
            session_id: request.session_id,
            formulation_execution_id: formulationExecutionId,
          },
          "Goal formulation failed",
        );
        return commitReceipt(
          "failed",
          { message: "Goal formulation failed; try again" },
          error instanceof GoalAgentRunFailure ? error.usage : undefined,
        );
      }
      if (analyzed.result.status === "insufficient_context")
        return commitReceipt(
          "insufficient_context",
          { question: analyzed.result.question, message: analyzed.result.reason },
          analyzed.usage,
        );
      const ready = analyzed.result;

      let sources: GoalDefinitionSource[];
      try {
        sources = await verifyTraceNormativeSources({
          trace: options.readTrace(formulationExecutionId) ?? [],
          paths: ready.normative_source_paths,
          readFile: (path) => options.readWorkspaceFile(path),
        });
      } catch {
        return commitReceipt(
          "insufficient_context",
          { message: "A normative source could not be revalidated; invoke /goal again" },
          analyzed.usage,
        );
      }

      const executionId = generateExecutionId();
      const params = paramsFor(captured, executionId);
      const defaultLimits = await options.defaultLimits();
      const tokenLimit =
        defaultLimits.max_net_tokens === undefined ? options.entryTokenLimit(params) : undefined;
      const committed = await options.transactions.transact(request.session_id, (session) => {
        if ((session.revision ?? 0) !== (captured.revision ?? 0)) {
          const stale = recordGoalFormulationReceipt(goalStateFromSession(session), {
            operation_id: request.operation_id,
            expected_revision: goalStateFromSession(session)?.revision ?? 0,
            fingerprint,
            formulation_execution_id: formulationExecutionId,
            mode: request.mode,
            outcome: "stale_context",
            message: "Conversation changed during formulation; invoke /goal again",
          });
          session.goal_state = goalStateToDto(stale.state);
          if (analyzed.usage.kind === "measured" && !stale.replayed) {
            session.totals.input += analyzed.usage.input;
            session.totals.output += analyzed.usage.output;
            if (session.totals.cached !== undefined)
              session.totals.cached += analyzed.usage.cached ?? 0;
          }
          return { session, result: { domain: stale, stale: true } };
        }
        const definition = ready;
        const origin =
          request.mode === "guided"
            ? {
                kind: "guided" as const,
                seed: request.seed,
                formulation_execution_id: formulationExecutionId,
                source_session_revision: captured.revision ?? 0,
                source_execution_ids: trajectory.source_execution_ids,
                trajectory_digest: trajectory.digest,
                trajectory_truncated: trajectory.truncated,
                formulation_usage: analyzed.usage,
              }
            : {
                kind: "auto" as const,
                formulation_execution_id: formulationExecutionId,
                source_session_revision: captured.revision ?? 0,
                source_execution_ids: trajectory.source_execution_ids,
                trajectory_digest: trajectory.digest,
                trajectory_truncated: trajectory.truncated,
                formulation_usage: analyzed.usage,
              };
        const domain = applyGoalFormulation(
          goalStateFromSession(session),
          {
            objective: definition.objective,
            criteria: formulationCriteria(definition),
            constraints: definition.constraints,
            exclusions: definition.exclusions,
            assumptions: definition.assumptions,
          },
          {
            session_id: request.session_id,
            new_goal_id: randomUUID(),
            new_execution_id: executionId,
            default_limits: defaultLimits,
            entry_token_limit: tokenLimit,
            now: Date.now(),
            physically_busy: options.registry.occupied(request.session_id),
            operation_id: request.operation_id,
            expected_revision: request.expected_revision,
            fingerprint,
            sources,
            origin,
          },
        );
        session.goal_state = goalStateToDto(domain.state);
        if (analyzed.usage.kind === "measured" && !domain.replayed) {
          session.totals.input += analyzed.usage.input;
          session.totals.output += analyzed.usage.output;
          if (session.totals.cached !== undefined)
            session.totals.cached += analyzed.usage.cached ?? 0;
        }
        return { session, result: { domain, stale: false } };
      });
      if (!committed.stale && committed.domain.start) {
        watch(authority, committed.domain.state.current);
        await startReserved(
          authority,
          request.session_id,
          committed.domain.state.current!,
          executionId,
          params,
        );
      }
      const receipt = committed.domain.receipt;
      logger.info(
        {
          event: "goal.formulation.completed",
          session_id: request.session_id,
          formulation_execution_id: formulationExecutionId,
          mode: request.mode,
          outcome: receipt.formulation?.outcome ?? "created",
          duration_ms: analyzed.elapsed_ms,
          usage_kind: analyzed.usage.kind,
          ...(analyzed.usage.kind === "measured"
            ? {
                input_tokens: analyzed.usage.input,
                output_tokens: analyzed.usage.output,
                cached_tokens: analyzed.usage.cached ?? 0,
              }
            : {}),
        },
        "Goal formulation completed",
      );
      return { ...receipt, formulation: receipt.formulation! };
    })().finally(release);
    formulations.set(formulationKey, { fingerprint, promise: task });
    try {
      return await task;
    } finally {
      formulations.delete(formulationKey);
    }
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
          const goal = session.goal_state?.current;
          let drift = false;
          for (const source of goal?.sources ?? []) {
            try {
              const current = await options.readWorkspaceFile(source.path);
              if (createHash("sha256").update(current.content).digest("hex") !== source.digest)
                drift = true;
            } catch {
              drift = true;
            }
          }
          return {
            state: session.goal_state ?? emptyGoalState(),
            ...(physical === undefined ? {} : { physical_run: physical }),
            ...(drift
              ? {
                  attention:
                    "A normative source changed or disappeared; edit or reformulate before completion.",
                }
              : {}),
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
      async formulate(input) {
        try {
          if (Buffer.byteLength(JSON.stringify(input), "utf8") > 128 * 1024)
            throw kernelError("resource_exhausted", "Goal formulation exceeds its byte bound");
          return await formulation(input);
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
            return applyGoalControl(goalStateFromSession(session), control, {
              session_id: sessionId,
              now: Date.now(),
              physically_busy: options.registry.occupied(sessionId),
            }).receipt;
          }
          const authority = options.registry.claimController(options.peerId, sessionId);
          assert(authority);
          const executionId = generateExecutionId();
          const params = paramsFor(session, executionId);
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
            await startReserved(authority, sessionId, bound, executionId, params);
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
      await Promise.allSettled([...formulations.values()].map((entry) => entry.promise));
      await Promise.all(pending);
    },
  };
}
