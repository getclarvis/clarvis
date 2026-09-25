import { addGoalAuxiliaryUsage } from "./usage.ts";
import type { ModelCost } from "@clarvis/protocol";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { isBuiltinTraceEvent, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import {
  applyGoalControl,
  GoalError,
  retryGoalResume,
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
  type GoalStewardRunResult,
  GoalAgentRunFailure,
  GoalStewardRunFailure,
  goalNetTokens,
  type GoalDefinitionSource,
  type GoalUsageGapCause,
} from "@clarvis/goal";
import type { TraceEvent } from "@clarvis/capability";
import type {
  GoalFormulateResult,
  GoalReceipt,
  GoalFormulationActivity,
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
const DEFINITION_SOURCE_CONTEXT_MAX_BYTES = 128 * 1024;

interface GoalDefinitionSourceContext extends GoalDefinitionSource {
  content: string;
  truncated: boolean;
}

/**
 * Add two goal-agent measurements, keeping every subtotal either side did confirm.
 *
 * @param left - the measurement accumulated so far.
 * @param right - the measurement to add.
 * @returns a `complete` sum when both sides are complete, a `partial` one when a subtotal exists
 *   alongside unresolved work, or `unknown` when neither side produced a figure at all.
 * @remarks An unknown side is not a zero: it becomes a bounded gap, so the half that *was*
 *   measured still counts. Collapsing the sum to `unknown` on either side is what let one
 *   unmeasured agent call discard the accounting of every other call in the same formulation.
 */
function appendUsage(
  left: GoalAgentRunResult["usage"],
  right: GoalAgentRunResult["usage"],
): GoalAgentRunResult["usage"] {
  if (left.kind === "unknown" && right.kind === "unknown") return { kind: "unknown" };
  const gaps = [
    ...(left.kind === "unknown"
      ? [{ cause: "invalid_measure" as const, calls: 1 }]
      : left.kind === "partial"
        ? left.gaps
        : []),
    ...(right.kind === "unknown"
      ? [{ cause: "invalid_measure" as const, calls: 1 }]
      : right.kind === "partial"
        ? right.gaps
        : []),
  ];
  const merged = new Map<GoalUsageGapCause, number>();
  for (const gap of gaps) merged.set(gap.cause, (merged.get(gap.cause) ?? 0) + gap.calls);
  const totals = {
    input:
      (left.kind === "unknown" ? 0 : left.input) + (right.kind === "unknown" ? 0 : right.input),
    output:
      (left.kind === "unknown" ? 0 : left.output) + (right.kind === "unknown" ? 0 : right.output),
    ...(left.kind !== "unknown" &&
    right.kind !== "unknown" &&
    left.cached !== undefined &&
    right.cached !== undefined
      ? { cached: left.cached + right.cached }
      : {}),
  };
  if (merged.size === 0) return { kind: "complete", ...totals };
  return {
    kind: "partial",
    ...totals,
    gaps: [...merged.entries()]
      .map(([cause, calls]) => ({ cause, calls }))
      .sort((first, second) => first.cause.localeCompare(second.cause)),
  };
}

async function definitionSourceContext(
  sources: readonly GoalDefinitionSource[],
  readFile: (path: string) => Promise<{ path: string; content: string }>,
): Promise<GoalDefinitionSourceContext[]> {
  let remaining = DEFINITION_SOURCE_CONTEXT_MAX_BYTES;
  const context: GoalDefinitionSourceContext[] = [];
  for (const source of sources) {
    const current = await readFile(source.path);
    const bytes = Buffer.from(current.content, "utf8");
    const included = bytes.subarray(0, Math.max(0, remaining));
    context.push({
      ...source,
      content: included.toString("utf8"),
      truncated: included.byteLength < bytes.byteLength,
    });
    remaining -= included.byteLength;
  }
  return context;
}

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
  publishFormulationActivity(sessionId: string, activity: GoalFormulationActivity): void;
  transactions: HostedSessionTransactions;
  readRun(executionId: string): Promise<RunDetail | null>;
  readTrace(executionId: string): readonly TraceEvent[] | undefined;
  readWorkspaceFile(path: string): Promise<{ path: string; content: string }>;
  priceFor?: (model: string) => ModelCost | undefined;
  /** Effective cumulative formulation allowance shared by the main agent and definition reviews. */
  formulationTokenLimit: number;
  formulateRun(input: GoalAgentRunInput): Promise<GoalAgentRunResult>;
  reviewDefinition(input: {
    session_id: string;
    request: { mode: "auto" | "guided"; seed?: string };
    proposal: Extract<GoalAgentRunResult["result"], { status: "ready" }>;
    sources: readonly GoalDefinitionSourceContext[];
    trajectory: GoalAgentRunInput["trajectory"];
    signal: AbortSignal;
    token_limit: number;
  }): Promise<GoalStewardRunResult>;
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
  const readActivityTools = new Set(["read_file", "read_image"]);
  const searchActivityTools = new Set(["list_dir"]);
  const activityFor = (event: TraceEvent): GoalFormulationActivity | undefined => {
    if (!isBuiltinTraceEvent(event)) return undefined;
    if (event.type === "subagent_iteration_started")
      return { phase: "thinking", iteration: event.iteration };
    if (event.type !== "tool_call_started") return undefined;
    const name = event.tool_name || event.mcp_name;
    const phase = readActivityTools.has(name)
      ? "reading"
      : searchActivityTools.has(name)
        ? "searching"
        : undefined;
    if (phase === undefined) return undefined;
    return { phase, iteration: event.iteration_ref };
  };
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
  const receiptView = (receipt: GoalReceipt): GoalReceipt => {
    if (receipt.execution_id === undefined || receipt.resume_pending === true) return receipt;
    const execution = options.registry.execution(receipt.execution_id);
    return {
      ...receipt,
      outcome:
        execution === undefined ||
        execution.execution_state === "starting" ||
        execution.execution_state === "unknown"
          ? "recovering"
          : "running",
    };
  };
  const startReserved = async (
    authority: HostedConversationAuthority,
    sessionId: string,
    bound: GoalRecord,
    executionId: string,
    params: StartRunParams & { execution_id: string },
    recoverable = false,
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
      if (recoverable) throw error;
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
        accounting?: GoalAgentRunResult["accounting"],
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
          if (!result.replayed)
            addGoalAuxiliaryUsage(session.totals, usage, accounting, options.priceFor);
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
            ...(usage === undefined || usage.kind === "unknown"
              ? {}
              : {
                  input_tokens: usage.input,
                  output_tokens: usage.output,
                  cached_tokens: usage.cached ?? 0,
                }),
          },
          "Goal formulation completed",
        );
        return committed;
      };

      if (request.mode === "auto" && trajectory.eligible_user_messages === 0)
        return commitReceipt("insufficient_context", {
          question: "What outcome should Clarvis pursue?",
        });

      let analyzed: GoalAgentRunResult | undefined;
      let accumulatedUsage: GoalAgentRunResult["usage"] | undefined;
      const accumulatedAccounting: NonNullable<GoalAgentRunResult["accounting"]> = [];
      let revisionGuidance: string | undefined;
      let previousDefinition: GoalAgentRunResult["result"] | undefined;
      const formulationTokenLimit = options.formulationTokenLimit;
      const remainingFormulationTokens = (): number | undefined => {
        const spent = accumulatedUsage === undefined ? 0 : goalNetTokens(accumulatedUsage);
        return spent === undefined ? undefined : formulationTokenLimit - spent;
      };
      let latestActivity = "";
      let lastWorkspaceActivity: "reading" | "searching" | undefined;
      const publishActivity = (activity: GoalFormulationActivity): void => {
        const fingerprint = `${activity.phase}:${activity.iteration ?? ""}:${activity.last_workspace_activity ?? ""}`;
        if (fingerprint === latestActivity) return;
        latestActivity = fingerprint;
        options.publishFormulationActivity(request.session_id, activity);
      };
      publishActivity({ phase: "thinking" });
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0)
            publishActivity({ phase: "thinking", last_workspace_activity: lastWorkspaceActivity });
          const mainTokenLimit = remainingFormulationTokens();
          if (mainTokenLimit === undefined || mainTokenLimit <= 0)
            throw new Error("Goal formulation token allowance exhausted");
          formulationExecutionId = generateExecutionId();
          analyzed = await options.formulateRun({
            mode: request.mode,
            ...(request.mode === "guided" ? { seed: request.seed } : {}),
            trajectory,
            execution_id: formulationExecutionId,
            agent_instance_id: randomUUID(),
            ...(captured.agent_profile === undefined ? {} : { agent_name: captured.agent_profile }),
            ...(revisionGuidance === undefined
              ? {}
              : { revision_guidance: revisionGuidance, previous_definition: previousDefinition }),
            session_id: request.session_id,
            signal: authority.signal,
            budget: { max_net_tokens: mainTokenLimit },
            on_event: (event) => {
              const activity = activityFor(event);
              if (activity === undefined) return;
              if (activity.phase === "reading" || activity.phase === "searching")
                lastWorkspaceActivity = activity.phase;
              publishActivity({
                ...activity,
                ...(lastWorkspaceActivity === undefined
                  ? {}
                  : { last_workspace_activity: lastWorkspaceActivity }),
              });
            },
          });
          accumulatedUsage =
            accumulatedUsage === undefined
              ? analyzed.usage
              : appendUsage(accumulatedUsage, analyzed.usage);
          accumulatedAccounting.push(...(analyzed.accounting ?? []));
          if (analyzed.result.status !== "ready") break;
          const reviewTokenLimit = remainingFormulationTokens();
          if (reviewTokenLimit === undefined || reviewTokenLimit <= 0)
            throw new Error("Goal formulation token allowance exhausted");
          let proposedSources: GoalDefinitionSource[];
          try {
            proposedSources = await verifyTraceNormativeSources({
              trace: options.readTrace(formulationExecutionId) ?? [],
              paths: analyzed.result.normative_source_paths,
              readFile: (path) => options.readWorkspaceFile(path),
            });
          } catch {
            return commitReceipt(
              "insufficient_context",
              { message: "A normative source could not be revalidated; invoke /goal again" },
              accumulatedUsage,
              accumulatedAccounting,
            );
          }
          publishActivity({
            phase: "thinking",
            ...(lastWorkspaceActivity === undefined
              ? {}
              : { last_workspace_activity: lastWorkspaceActivity }),
          });
          const reviewed = await options.reviewDefinition({
            session_id: request.session_id,
            request:
              request.mode === "guided" ? { mode: "guided", seed: request.seed } : { mode: "auto" },
            proposal: analyzed.result,
            sources: await definitionSourceContext(proposedSources, (path) =>
              options.readWorkspaceFile(path),
            ),
            trajectory,
            signal: authority.signal,
            token_limit: reviewTokenLimit,
          });
          if (reviewed.result.decision !== "definition")
            throw new Error("Goal Steward returned another review mode");
          accumulatedUsage = appendUsage(accumulatedUsage, reviewed.usage);
          accumulatedAccounting.push(...(reviewed.accounting ?? []));
          analyzed = {
            ...analyzed,
            usage: accumulatedUsage,
            accounting: accumulatedAccounting,
          };
          if (reviewed.result.verdict === "accept_definition") {
            const remaining = remainingFormulationTokens();
            if (remaining === undefined) throw new Error("Goal formulation usage is unknown");
            if (remaining < 0) throw new Error("Goal formulation token allowance exhausted");
            break;
          }
          revisionGuidance = reviewed.result.guidance;
          previousDefinition = analyzed.result;
          if (attempt === 2) throw new Error("Goal definition revision limit reached");
        }
      } catch (error) {
        const failedRun =
          error instanceof GoalAgentRunFailure || error instanceof GoalStewardRunFailure
            ? error
            : undefined;
        const failureUsage =
          failedRun === undefined
            ? accumulatedUsage
            : accumulatedUsage === undefined
              ? failedRun.usage
              : appendUsage(accumulatedUsage, failedRun.usage);
        const failureAccounting = [...accumulatedAccounting, ...(failedRun?.accounting ?? [])];
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
          failureUsage,
          failureAccounting,
        );
      }
      if (analyzed === undefined) throw new Error("Goal formulation produced no result");
      analyzed = {
        ...analyzed,
        usage: accumulatedUsage ?? analyzed.usage,
        accounting: accumulatedAccounting,
      };
      if (formulationExecutionId === undefined)
        throw new Error("Goal formulation execution identity is unavailable");
      const acceptedFormulationExecutionId = formulationExecutionId;
      if (analyzed.result.status === "insufficient_context")
        return commitReceipt(
          "insufficient_context",
          { question: analyzed.result.question, message: analyzed.result.reason },
          analyzed.usage,
          analyzed.accounting,
        );
      const ready = analyzed.result;

      let sources: GoalDefinitionSource[];
      try {
        sources = await verifyTraceNormativeSources({
          trace: options.readTrace(acceptedFormulationExecutionId) ?? [],
          paths: ready.normative_source_paths,
          readFile: (path) => options.readWorkspaceFile(path),
        });
      } catch {
        return commitReceipt(
          "insufficient_context",
          { message: "A normative source could not be revalidated; invoke /goal again" },
          analyzed.usage,
          analyzed.accounting,
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
            formulation_execution_id: acceptedFormulationExecutionId,
            mode: request.mode,
            outcome: "stale_context",
            message: "Conversation changed during formulation; invoke /goal again",
          });
          session.goal_state = goalStateToDto(stale.state);
          if (!stale.replayed)
            addGoalAuxiliaryUsage(
              session.totals,
              analyzed.usage,
              analyzed.accounting,
              options.priceFor,
            );
          return { session, result: { domain: stale, stale: true } };
        }
        const definition = ready;
        const origin =
          request.mode === "guided"
            ? {
                kind: "guided" as const,
                seed: request.seed,
                formulation_execution_id: acceptedFormulationExecutionId,
                source_session_revision: captured.revision ?? 0,
                source_execution_ids: trajectory.source_execution_ids,
                trajectory_digest: trajectory.digest,
                trajectory_truncated: trajectory.truncated,
                formulation_usage: analyzed.usage,
              }
            : {
                kind: "auto" as const,
                formulation_execution_id: acceptedFormulationExecutionId,
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
        if (!domain.replayed)
          addGoalAuxiliaryUsage(
            session.totals,
            analyzed.usage,
            analyzed.accounting,
            options.priceFor,
          );
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
          ...(analyzed.usage.kind === "unknown"
            ? {}
            : {
                input_tokens: analyzed.usage.input,
                output_tokens: analyzed.usage.output,
                cached_tokens: analyzed.usage.cached ?? 0,
              }),
        },
        "Goal formulation completed",
      );
      return { ...receipt, formulation: receipt.formulation! };
    })().finally(() => {
      options.publishFormulationActivity(request.session_id, { phase: "idle" });
      release();
    });
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
          const receipt = (await readSession(sessionId)).goal_state?.receipts.find(
            (receipt) => receipt.operation_id === operationId,
          );
          return receipt === undefined ? null : receiptView(receipt);
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
            const receipt = applyGoalControl(goalStateFromSession(session), control, {
              session_id: sessionId,
              now: Date.now(),
              physically_busy: options.registry.occupied(sessionId),
            }).receipt;
            if (control.action.kind === "resume" && receipt.resume_pending === true) {
              const authority = options.registry.claimController(options.peerId, sessionId);
              let physical;
              try {
                physical = await options.registry.resumePhysical(authority);
              } catch {
                return receipt;
              }
              const resumed = await options.repository
                .transact(sessionId, (state) => {
                  assert(authority);
                  const result = retryGoalResume(state!, control.operation_id, {
                    session_id: sessionId,
                    now: Date.now(),
                    physically_busy: options.registry.occupied(sessionId),
                    ...(physical === undefined ? {} : { live_execution_id: physical.execution_id }),
                  });
                  return { state: result.state, result };
                })
                .catch((error: unknown) => {
                  if (
                    error instanceof GoalError &&
                    ["budget_limited", "usage_limited"].includes(error.code)
                  )
                    return undefined;
                  throw error;
                });
              if (resumed === undefined) return receipt;
              if (resumed.start && resumed.receipt.execution_id !== undefined) {
                try {
                  await startReserved(
                    authority,
                    sessionId,
                    resumed.state.current!,
                    resumed.receipt.execution_id,
                    paramsFor(session, resumed.receipt.execution_id),
                    true,
                  );
                } catch {
                  return { ...resumed.receipt, outcome: "unavailable" };
                }
              }
              return receiptView(resumed.receipt);
            }
            if (
              control.action.kind === "resume" &&
              receipt.execution_id !== undefined &&
              options.registry.execution(receipt.execution_id) === undefined
            ) {
              const bound = goalStateFromSession(session)?.current;
              if (
                bound === undefined ||
                bound.goal_id !== receipt.goal_id ||
                bound.control_revision !== receipt.revision
              )
                return { ...receipt, outcome: "superseded" };
              const authority = options.registry.claimController(options.peerId, sessionId);
              try {
                await startReserved(
                  authority,
                  sessionId,
                  bound,
                  receipt.execution_id,
                  paramsFor(session, receipt.execution_id),
                  true,
                );
              } catch {
                return { ...receipt, outcome: "unavailable" };
              }
            }
            return receiptView(receipt);
          }
          const authority = options.registry.claimController(options.peerId, sessionId);
          assert(authority);
          let resumePending = false;
          const physical =
            control.action.kind === "resume"
              ? await options.registry.resumePhysical(authority).catch((error: unknown) => {
                  const details = toKernelError(error).details as
                    { goal_outcome?: string } | undefined;
                  if (
                    details?.goal_outcome !== "needs_input" &&
                    details?.goal_outcome !== "recovering"
                  )
                    throw error;
                  resumePending = true;
                  return undefined;
                })
              : undefined;
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
            const rebaseResume =
              control.action.kind === "resume" &&
              session.goal_state?.revision === control.expected_revision &&
              state?.current?.goal_id === session.goal_state.current?.goal_id &&
              state?.current?.control_revision === session.goal_state.current?.control_revision;
            const effectiveControl = rebaseResume
              ? { ...control, expected_revision: state!.revision }
              : control;
            const context = {
              ...(rebaseResume
                ? {
                    fingerprint: createHash("sha256")
                      .update(JSON.stringify({ session_id: sessionId, control }))
                      .digest("hex"),
                  }
                : {}),
              session_id: sessionId,
              new_goal_id: randomUUID(),
              new_execution_id: executionId,
              default_limits: defaultLimits,
              entry_token_limit: tokenLimit,
              now: Date.now(),
              physically_busy: options.registry.occupied(sessionId),
              ...(physical === undefined ? {} : { live_execution_id: physical.execution_id }),
              ...(resumePending ? { resume_pending: true } : {}),
            };
            let result;
            try {
              result = applyGoalControl(state, effectiveControl, context);
            } catch (error) {
              if (
                control.action.kind !== "resume" ||
                !(error instanceof GoalError) ||
                !["budget_limited", "usage_limited"].includes(error.code)
              )
                throw error;
              result = applyGoalControl(state, effectiveControl, {
                ...context,
                resume_pending: true,
                resume_condition: error.code === "budget_limited" ? "token_limit" : "deadline",
              });
            }

            return { state: result.state, result };
          });
          if (action.kind === "edit" && action.resume_operation_id !== undefined) {
            const resumed = await options.repository.transact(sessionId, (state) => {
              assert(authority);
              try {
                const next = retryGoalResume(state!, action.resume_operation_id!, {
                  session_id: sessionId,
                  now: Date.now(),
                  physically_busy: options.registry.occupied(sessionId),
                });
                return { state: next.state, result: next };
              } catch (error) {
                if (
                  !(error instanceof GoalError) ||
                  !["budget_limited", "usage_limited"].includes(error.code)
                )
                  throw error;
                return { state: state!, result: undefined };
              }
            });
            if (resumed?.start && resumed.receipt.execution_id !== undefined) {
              await startReserved(
                authority,
                sessionId,
                resumed.state.current!,
                resumed.receipt.execution_id,
                paramsFor(session, resumed.receipt.execution_id),
                true,
              );
              return {
                ...result.receipt,
                execution_id: resumed.receipt.execution_id,
                outcome: "running",
              };
            }
            return { ...result.receipt, outcome: "needs_input" };
          }
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
              await startReserved(
                authority,
                sessionId,
                bound,
                executionId,
                params,
                action.kind === "resume",
              );
            } catch (error) {
              if (action.kind !== "resume") throw error;
              return { ...result.receipt, outcome: "unavailable" };
            }
          }
          return receiptView(result.receipt);
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
