import type { Logger, SteerSource } from "@clarvis/capability";
import {
  bind,
  checkpointMetadataSchema,
  contentToText,
  levelEnabled,
  NOOP_LOGGER,
} from "@clarvis/capability";
import type { FinalizeAttempt } from "@clarvis/capability";
import type { NamespacedRegistry, NamespacedTool } from "@clarvis/capability";
import { VISION_AGENT_TOOL_WIRE_NAMES } from "../tools/wire-names.ts";
import type { CompactionAnchor } from "../context/llm-compaction.ts";
import {
  createLiveContext,
  type LiveContext,
  type LiveSeedEntry,
} from "../context/context-compaction.ts";
import { checkLimits, limitOf } from "../budget/budget.ts";
import { checkCancelled } from "./cancellation.ts";
import { createConvergenceGuards, type GuardTrip } from "../guards/convergence-guards.ts";
import { escalateGuardTrip, type GuardEscalationAsk } from "../guards/guard-escalation.ts";
import { createProgressTracker } from "./progress.ts";
import { createToolArgValidator } from "../tools/tool-arg-validator.ts";
import { runBudgetCheckpoint } from "../budget/budget-checkpoint.ts";
import { runAgentLoop, type FinalizeStep, type LoopCore } from "./loop.ts";
import { buildPreFinalizeGate, fireObservers } from "./lifecycle-hooks.ts";
import type { LLMToolCall } from "@clarvis/capability";
import { openCallEnvelope, type CallEnvelope, type HandlerBase } from "@clarvis/capability";
import { SUBMIT_RESULT_TOOL_NAME } from "../tools/submit-result-tool.ts";
import type { ResultContract } from "../tools/result-contract.ts";
import {
  runGates,
  type AgentBuildContext,
  type LoopAgentBuildContext,
  type AgentRunState,
  type ToolHandler,
  type EngineHandlerVerdict,
} from "./loop-contract.ts";
import { buildMcpHandler } from "./mcp-handler.ts";
import { createSteerInbox } from "./steer-inbox.ts";
import type { AgentCapability, AgentLoopContribution } from "@clarvis/capability";
import type { AgentLimitExhausted } from "@clarvis/capability";
import { foldContributions } from "@clarvis/capability";
import { type AgentResult, emptyResponseError, partialStructOf } from "./loop-shared.ts";
import { withOutputTokenBudget } from "./output-budget.ts";

export type { AgentBuildContext, AgentRunState };

/**
 * The full input to {@link runAgent}: the {@link LoopCore} the loop reads plus
 * the seed messages, tool registry, capability activations, and the persona
 * knobs (progress limits, finalize contract, empty-response identity) that
 * distinguish a lead from a sub-agent.
 *
 * @remarks Extends {@link LoopCore} so the same object flows straight into
 *   {@link runAgentLoop}. `contract` turns on `submit_result` finalization;
 *   `agentCapabilities` are already grant-gated upstream; `mcpFullToolset`
 *   advertises every tool (not just the registry's) as available.
 */
export interface RunAgentInput extends LoopCore {
  /** The initial conversation seed for the live context. */
  messages: readonly LiveSeedEntry[];
  /** Optional source of mid-run user steer messages, drained each iteration. */
  steer?: SteerSource;
  registry: NamespacedRegistry;
  /** Overrides the convergence guards' stagnation threshold. */
  stagnationThreshold?: number;
  /** Overrides the convergence guards' stagnation *warning* threshold. */
  stagnationSoftThreshold?: number;
  /**
   * Asks the user whether to continue past a tripped convergence guard.
   *
   * @remarks Present only when the run opted into guard escalation. Its absence
   *   is what makes a hard trip terminate exactly as it did before — by
   *   construction, not by a flag consulted at the trip site.
   */
  guardEscalationAsk?: GuardEscalationAsk;
  /** How many guard trips one run may be waved through; `0` disables escalation. */
  guardMaxEscalations?: number;
  /** The persona's tool-progress policy: whether a dispatch outcome counts as progress. */
  mcpProgress: (r: { errText: string | null; productive: boolean }) => boolean;
  /** When `true`, all resolved tools are advertised as available, not just the registry's. */
  mcpFullToolset?: boolean;
  /** Enables `submit_result` finalization with structured validation. */
  contract?: ResultContract;
  /** Per-agent capability activations (already grant-gated upstream). */
  agentCapabilities?: readonly AgentCapability[];
  /** Builds an optional `beforeCheckpoint` hook bound to the agent build context. */
  buildBeforeCheckpoint?: (bc: LoopAgentBuildContext) => () => void;
  /** A fixed compaction anchor used when no capability contributes one. */
  staticAnchor?: CompactionAnchor;
  /** The no-progress streak limit before the run ends in error. */
  noProgressLimit: number;
  /** Builds the error message for a plain no-progress termination. */
  noProgressMessage: (streak: number) => string;
  /** Builds the error message when a contract run keeps producing text without submitting. */
  textNoSubmitMessage?: (streak: number) => string;
  /** Which persona to name in the empty-response error. */
  emptyResponseAgent: "LLM" | "Lead";
  /** Notified of the created {@link LiveContext} before the loop starts. */
  onContext?: (ctx: LiveContext) => void;
  /** Mutable sink for run-level warnings, forwarded to {@link AgentBuildContext.warnings}. */
  warnings?: string[];
}

/**
 * Assembles one agent's run — context, guards, budget checkpoints, capability
 * contributions, tool handlers and finalize policy — and drives it to a terminal
 * {@link AgentResult} via {@link runAgentLoop}.
 *
 * @param input - the run input; see {@link RunAgentInput}.
 * @returns the agent's terminal result. Returns early with a cancelled result if
 *   the signal is already aborted, or a `budget_exhausted` result — carrying the
 *   {@link AgentLimitExhausted} `limit` that ended it — if the pre-run limit check
 *   is already terminal.
 * @remarks Capabilities are attached against a shared {@link AgentBuildContext}
 *   and folded (in registration order) into gates, tools, handlers, an anchor
 *   and lifecycle hooks. When `contract` is set, a `submit_result` handler runs
 *   the finalize gates and structured validation, and `finalize.onTextOnly`
 *   nudges the model to submit rather than accepting bare text; without it,
 *   text-only completions pass through the gates and may complete the run. Any
 *   `steer` source is closed when the loop settles.
 */
export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const { runtime, budget } = input;
  const trace = runtime.trace;
  const idFields =
    input.subagentInstanceId !== undefined
      ? { subagent_instance_id: input.subagentInstanceId }
      : {};

  const logger: Logger =
    input.logger === undefined
      ? NOOP_LOGGER
      : bind(input.logger, { agent: input.agent, ...idFields });

  const ctx = createLiveContext(input.messages, input.compaction, {
    agent: input.agent,
    ...(input.subagentInstanceId !== undefined
      ? { subagent_instance_id: input.subagentInstanceId }
      : {}),
    logger,
  });
  input.onContext?.(ctx);

  const state: AgentRunState = { lastAssistantText: "" };
  const partialStruct = (): { partialStructured: { value: unknown } } | Record<string, never> =>
    partialStructOf(state.lastSubmitAttempt);

  const guards = createConvergenceGuards({
    ...(input.stagnationThreshold !== undefined
      ? { stagnationThreshold: input.stagnationThreshold }
      : {}),
    ...(input.stagnationSoftThreshold !== undefined
      ? { stagnationSoftThreshold: input.stagnationSoftThreshold }
      : {}),
  });
  const guardAsk = input.guardEscalationAsk;
  const guardMaxEscalations = input.guardMaxEscalations ?? 0;

  const argValidator = createToolArgValidator(logger);
  const progress = createProgressTracker(input.noProgressLimit);

  const base: HandlerBase = {
    trace,
    agent: input.agent,
    ...(input.subagentInstanceId !== undefined
      ? { subagentInstanceId: input.subagentInstanceId }
      : {}),
    ...(runtime.signal ? { signal: runtime.signal } : {}),
    validateArgs: argValidator.validate,
  };

  const contract = input.contract;

  const cancelledResult = (): AgentResult => ({
    status: "cancelled",
    partialText: state.lastAssistantText,
    ...partialStruct(),
  });

  const maybeCancelled = (): AgentResult | null =>
    checkCancelled({
      signal: runtime.signal,
      trace,
      agent: input.agent,
      ...(input.subagentInstanceId !== undefined
        ? { subagentInstanceId: input.subagentInstanceId }
        : {}),
    })
      ? cancelledResult()
      : null;

  {
    const c = maybeCancelled();
    if (c) return c;
  }

  const budgetStop = async (
    kind: "declined" | "exhausted",
    limit?: AgentLimitExhausted,
  ): Promise<AgentResult> => {
    await fireObservers(
      input.hooks,
      "onBudgetExhausted",
      {
        agent: input.agent,
        reason: kind,
        tokensUsed: budget.ledger.consumed(),
        iterationsUsed: budget.counter.count(),
      },
      input.logger,
      { signal: runtime.signal },
    );
    return {
      status: kind === "declined" ? "soft_limit_declined" : "budget_exhausted",
      partialText: state.lastAssistantText,
      ...(kind === "exhausted" && limit !== undefined ? { limit } : {}),
      ...partialStruct(),
    };
  };

  let guardEscalations = 0;
  /**
   * Resolve a hard guard trip: with escalation opted into, ask the user whether
   * to continue and reset the guards on a yes; otherwise fall through to the
   * default terminal result.
   *
   * @returns `"continue"` to keep looping, an {@link AgentResult} for a
   *   cancellation observed mid-prompt, or `undefined` to terminate normally.
   * @remarks Returning `undefined` — rather than building a result here — is
   *   what keeps a declined escalation byte-identical to today's behaviour: the
   *   loop falls through to the same `results.guardTrip(trip)` it always used,
   *   so the status stays `error` with the guard's own code rather than drifting
   *   into a budget-shaped `soft_limit_declined`.
   */
  const onGuardTrip = async (trip: GuardTrip): Promise<AgentResult | "continue" | undefined> => {
    const outcome = await escalateGuardTrip({
      trip,
      guards,
      ...(guardAsk !== undefined ? { ask: guardAsk } : {}),
      maxEscalations: guardMaxEscalations,
      escalations: guardEscalations,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      record: (result) => {
        trace.record("guard_escalation", {
          agent: input.agent,
          ...(input.subagentInstanceId !== undefined
            ? { subagent_instance_id: input.subagentInstanceId }
            : {}),
          code: trip.code,
          outcome: result,
          escalations: guardEscalations,
        });
      },
    });
    if (outcome.kind === "cancelled") return maybeCancelled() ?? undefined;
    if (outcome.kind === "continue") {
      guardEscalations += 1;
      return "continue";
    }
    return undefined;
  };

  const checkpoint = async (): Promise<AgentResult | null> => {
    const oc = await runBudgetCheckpoint({
      ...(budget.softBudget ? { softBudget: budget.softBudget } : {}),
      ...(budget.softLimitAsk ? { softLimitAsk: budget.softLimitAsk } : {}),
      ledger: budget.ledger,
      counter: budget.counter,
      agent: input.agent,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      trace,
    });
    if (oc.kind === "cancelled") return maybeCancelled();
    if (oc.kind === "continue") return null;
    return oc.kind === "declined"
      ? budgetStop("declined")
      : budgetStop("exhausted", limitOf(oc.dimension));
  };

  const steerInbox = input.steer ? createSteerInbox(input.steer, input.logger) : undefined;

  const bc: LoopAgentBuildContext = {
    agent: input.agent,
    ...(input.subagentInstanceId !== undefined
      ? { subagentInstanceId: input.subagentInstanceId }
      : {}),
    ctx,
    state,
    trace,
    ...(runtime.signal ? { signal: runtime.signal } : {}),
    budget,
    guards,
    toolProgress: input.mcpProgress,
    validateArgs: argValidator.validate,
    maybeCancelled,
    ...(input.clock !== undefined ? { clock: input.clock } : {}),
    ...(steerInbox !== undefined ? { steerProbe: (): boolean => steerInbox.probe() } : {}),
    ...(input.warnings !== undefined ? { warnings: input.warnings } : {}),
  };

  const contributions: AgentLoopContribution[] = (input.agentCapabilities ?? []).map((c) =>
    c.attach(bc),
  );
  const folded = foldContributions(contributions);
  const hookGate =
    input.hooks?.some((h) => h.preFinalize) === true
      ? buildPreFinalizeGate({
          hooks: input.hooks,
          agent: input.agent,
          ...(input.subagentInstanceId !== undefined
            ? { subagentInstanceId: input.subagentInstanceId }
            : {}),
          appendNote: (note) => ctx.appendNote(note),
          ...(input.logger ? { logger: input.logger } : {}),
          ...(runtime.signal ? { signal: runtime.signal } : {}),
        })
      : undefined;
  const gates = [...folded.gates, ...(hookGate ? [hookGate] : [])];

  const sighted = input.target.capabilities?.has("vision") ?? false;
  const visible = (list: readonly NamespacedTool[]): NamespacedTool[] =>
    sighted ? [...list] : list.filter((t) => !VISION_AGENT_TOOL_WIRE_NAMES.includes(t.wireName));

  const tools = visible([
    ...input.registry.tools,
    ...folded.tools,
    ...(contract ? [contract.tool] : []),
  ]);
  const availableWireNames =
    input.mcpFullToolset === true
      ? tools.map((t) => t.wireName)
      : visible([...input.registry.tools, ...folded.advertisedTools]).map((t) => t.wireName);

  const mcpHandler = buildMcpHandler({
    ...(input.actionAuthorization ? { actionAuthorization: input.actionAuthorization } : {}),
    base,
    registry: input.registry,
    argValidator,
    guards,
    progress: input.mcpProgress,
    availableWireNames,
  });

  const checkStartBudget = (): Promise<AgentResult> | undefined => {
    const limits = checkLimits(budget.counter, budget.ledger);
    if (limits.terminal || (folded.outputBudget?.remaining() ?? 1) < 1) {
      trace.record("budget_check", {
        tokens_used: budget.ledger.consumed(),
        tokens_remaining: Math.max(0, budget.ledger.remaining()),
      });
      return budgetStop("exhausted", limitOf(limits.terminal ? limits.reason : "tokens"));
    }
    return undefined;
  };
  const initialStop = checkStartBudget();
  if (initialStop !== undefined) return initialStop;

  const noProgressResult = (): AgentResult => {
    trace.record("terminate", {
      reason: "no_progress",
      streak: progress.streak(),
      limit: input.noProgressLimit,
    });
    return {
      status: "error",
      partialText: state.lastAssistantText,
      error: { code: "no_progress", message: input.noProgressMessage(progress.streak()) },
      ...partialStruct(),
    };
  };

  const completed = (attempt: FinalizeAttempt): AgentResult => {
    folded.hooks.onFinalizeAccepted?.(attempt);
    trace.record("terminate", {
      reason: "completed",
      ...(attempt.mode === "checkpoint" ? { disposition: "checkpoint" } : {}),
    });
    if (attempt.mode === "checkpoint") {
      return {
        status: "completed",
        disposition: "checkpoint",
        checkpoint: attempt.checkpoint,
        partialText: state.lastAssistantText,
      };
    }
    return {
      status: "completed",
      ...(attempt.text !== undefined ? { text: attempt.text } : {}),
      partialText: attempt.text ?? state.lastAssistantText,
      ...(attempt.mode === "submit" ? { structuredResult: { value: attempt.value } } : {}),
    };
  };

  const submitEnvelope = (call: LLMToolCall, iteration: number): CallEnvelope =>
    openCallEnvelope({
      call,
      name: SUBMIT_RESULT_TOOL_NAME,
      trace,
      agent: input.agent,
      ...(input.subagentInstanceId !== undefined
        ? { subagentInstanceId: input.subagentInstanceId }
        : {}),
      iteration,
    });

  const submitHandler: ToolHandler = {
    matches: (call) => call.name === SUBMIT_RESULT_TOOL_NAME,
    async handle(call, iteration): Promise<EngineHandlerVerdict> {
      const envelope = submitEnvelope(call, iteration);
      const verdict = contract!.validate(call.arguments);
      state.lastSubmitAttempt = { value: call.arguments };
      if (!verdict.ok) {
        const errText = verdict.error ?? "submit_result rejected.";
        return { kind: "result", text: envelope.fail(errText), progress: false };
      }
      envelope.start();
      const { outcome: g, gate } = await runGates(gates, {
        mode: "submit",
        value: verdict.value,
      });
      if (g.kind === "terminal") {
        const text = envelope.fail(
          g.result.error?.message ?? `run ended at a finalize gate (${g.result.status})`,
        );
        return { kind: "terminal", result: g.result, text };
      }
      if (g.kind === "nudge") {
        noteGateNudged(gate, "submit");
        return { kind: "result", text: envelope.fail(g.note), progress: false };
      }
      const accepted = envelope.ok("accepted");
      return {
        kind: "terminal",
        result: completed({ mode: "submit", value: verdict.value }),
        text: accepted,
      };
    },
  };

  const handlers: ToolHandler[] = [
    ...folded.handlers,
    ...(contract ? [submitHandler] : []),
    mcpHandler,
  ];

  /**
   * Counts the finalize gates that refused a finish and nudged instead, and logs
   * each one.
   *
   * @remarks A nudge is prose asking the model to act where an action was
   *   required; the loop answers it by iterating with that note appended, and by
   *   nothing else. It deliberately does not change the next call's tool choice:
   *   forcing a call tells the model *that* it must call something, not *what*, so
   *   it answers a wrong-tool problem with a different wrong tool or a malformed
   *   argument the provider then rejects — and a provider that refuses a forced
   *   choice outright (a thinking model, for one) turns the nudge into an HTTP
   *   400 that ends the run. Exposing the catalog and letting the model choose is
   *   what the gate's own note already asks for.
   */
  let nudgeCount = 0;
  const noteGateNudged = (
    gate: number,
    mode: FinalizeAttempt["mode"],
    extra?: { no_progress_streak: number; no_progress_limit: number },
  ): void => {
    nudgeCount += 1;
    if (!levelEnabled(logger, "debug")) return;
    logger.debug(
      { event: "gate.nudged", gate, mode, nudge_count: nudgeCount, ...extra },
      "a finalize gate refused the finish and nudged instead; the agent iterates again",
    );
  };

  const anchor =
    folded.anchor ?? (input.staticAnchor ? (): CompactionAnchor => input.staticAnchor! : undefined);

  const contributesProgress = folded.hooks.contributesProgress;
  const computeProgress = contributesProgress
    ? (dispatchProduced: boolean): boolean => dispatchProduced || contributesProgress()
    : undefined;

  const beforeCheckpoint = input.buildBeforeCheckpoint
    ? input.buildBeforeCheckpoint(bc)
    : undefined;

  const drainSteer = steerInbox
    ? async (iteration: number): Promise<void> => {
        const pending = steerInbox.take();
        if (pending.length === 0) return;
        for (const msg of pending) {
          ctx.appendUser(msg.content);
          trace.record("user_steering", {
            agent: input.agent,
            ...idFields,
            iteration_ref: iteration,
            message: contentToText(msg.content),
            ...(msg.id !== undefined ? { id: msg.id } : {}),
          });
          await fireObservers(
            input.hooks,
            "onUserSteer",
            {
              agent: input.agent,
              ...(input.subagentInstanceId !== undefined
                ? { subagentInstanceId: input.subagentInstanceId }
                : {}),
              iteration,
              message: contentToText(msg.content),
              ...(msg.id !== undefined ? { id: msg.id } : {}),
            },
            input.logger,
          );
        }
        progress.reset();
      }
    : undefined;

  const withLogger: RunAgentInput = { ...input, logger };
  const loopInput: RunAgentInput =
    folded.outputBudget === undefined
      ? withLogger
      : {
          ...withLogger,
          target: {
            ...input.target,
            llm: withOutputTokenBudget(input.target.llm, folded.outputBudget),
          },
        };
  const loopResult = runAgentLoop(loopInput, {
    ctx,
    tools,
    handlers,
    ...(folded.dispatchPolicy !== undefined ? { dispatchPolicy: folded.dispatchPolicy } : {}),
    guards,
    progress,
    ...(anchor ? { anchor } : {}),
    maybeCancelled,
    checkpoint,
    ...(folded.hooks.beforeIteration ? { beforeIteration: folded.hooks.beforeIteration } : {}),
    ...(folded.hooks.afterDispatch ? { afterDispatch: folded.hooks.afterDispatch } : {}),
    ...(guardAsk !== undefined && guardMaxEscalations > 0 ? { onGuardTrip } : {}),
    ...(folded.hooks.onTeardown ? { onTeardown: folded.hooks.onTeardown } : {}),
    ...(computeProgress ? { computeProgress } : {}),
    ...(beforeCheckpoint ? { beforeCheckpoint } : {}),
    ...(drainSteer ? { drainSteer } : {}),
    onAssistantText: (t) => {
      state.lastAssistantText = t;
    },
    results: {
      allToolsUnavailable: () => ({
        status: "error",
        partialText: state.lastAssistantText,
        error: {
          code: "all_tools_unavailable",
          message: "All configured MCP servers became unavailable.",
        },
        ...partialStruct(),
      }),
      budgetExhausted: () => budgetStop("exhausted", limitOf("tokens")),
      emptyResponse: () => {
        trace.record("terminate", { reason: "empty_response" });
        return {
          status: "error",
          partialText: state.lastAssistantText,
          error: emptyResponseError(input.emptyResponseAgent),
          ...partialStruct(),
        };
      },
      noProgress: noProgressResult,
      guardTrip: (trip) => ({
        status: "error",
        partialText: state.lastAssistantText,
        error: { code: trip.code, message: trip.message },
        ...partialStruct(),
      }),
    },
    finalize: {
      onRequested: async (request): Promise<FinalizeStep> => {
        const cancelled = maybeCancelled();
        if (cancelled) return { kind: "return", result: cancelled };
        const parsed = checkpointMetadataSchema.safeParse(request.checkpoint);
        if (!parsed.success) {
          ctx.appendNote(
            "[runtime: checkpoint requires a nonempty summary and next_step, at most 4096 characters each]",
          );
          return { kind: "continue" };
        }
        const attempt: FinalizeAttempt = {
          mode: "checkpoint",
          disposition: "checkpoint",
          checkpoint: parsed.data,
        };
        const { outcome, gate } = await runGates(gates, attempt);
        const stopped = maybeCancelled();
        if (stopped) return { kind: "return", result: stopped };
        if (outcome.kind === "terminal") return { kind: "return", result: outcome.result };
        if (outcome.kind === "nudge") {
          noteGateNudged(gate, "checkpoint");
          ctx.appendNote(outcome.note);
          return { kind: "continue" };
        }
        return { kind: "return", result: completed(attempt) };
      },
      ...(contract
        ? {
            fastAcceptSubmit: (toolCalls, iteration): AgentResult | null => {
              if (toolCalls.length !== 1) return null;
              const call = toolCalls[0]!;
              if (call.name !== SUBMIT_RESULT_TOOL_NAME) return null;
              const verdict = contract.validate(call.arguments);
              if (!verdict.ok) return null;
              if (input.hooks?.some((h) => h.beforeToolUse) === true) return null;
              if (!gates.every((g) => g.fastAcceptOk?.() ?? true)) return null;
              const envelope = submitEnvelope(call, iteration);
              envelope.start();
              const accepted = envelope.ok("accepted");
              state.lastSubmitAttempt = { value: call.arguments };
              ctx.appendToolMessage(call.id, accepted);
              return completed({ mode: "submit", value: verdict.value });
            },
          }
        : {}),
      onTextOnly: async (text, _iteration, reasoning, textParts): Promise<FinalizeStep> => {
        if (contract) {
          state.lastAssistantText = text;
          ctx.appendAssistant(text, reasoning, textParts);
          ctx.appendNote("[runtime: result not yet submitted; call submit_result to finalize]");
          if (progress.bump(false)) {
            if (input.textNoSubmitMessage) {
              trace.record("terminate", {
                reason: "no_progress",
                streak: progress.streak(),
                limit: input.noProgressLimit,
              });
              return {
                kind: "return",
                result: {
                  status: "error",
                  partialText: state.lastAssistantText,
                  error: {
                    code: "no_progress",
                    message: input.textNoSubmitMessage(progress.streak()),
                  },
                  ...partialStruct(),
                },
              };
            }
            return { kind: "return", result: noProgressResult() };
          }
          const cp = await checkpoint();
          if (cp) return { kind: "return", result: cp };
          return { kind: "continue" };
        }
        state.lastAssistantText = text;
        ctx.appendAssistant(text, reasoning, textParts);
        const { outcome: g, gate } = await runGates(gates, { mode: "text", text });
        if (g.kind === "terminal") return { kind: "return", result: g.result };
        if (g.kind === "nudge") {
          ctx.appendNote(g.note);
          /**
           * An unbounded refusal is bounded here rather than by the gate: it counts
           * once as an unproductive iteration, a productive iteration clears it, and
           * the streak reaching the persona's limit ends the run. The log records the
           * resulting streak and limit so the repetition is attributable without
           * copying the gate's note into it.
           */
          const exhausted = g.unbounded === true && progress.bump(false);
          noteGateNudged(
            gate,
            "text",
            g.unbounded === true
              ? { no_progress_streak: progress.streak(), no_progress_limit: input.noProgressLimit }
              : undefined,
          );
          if (exhausted) return { kind: "return", result: noProgressResult() };
          const cp = await checkpoint();
          if (cp) return { kind: "return", result: cp };
          return { kind: "continue" };
        }
        return { kind: "return", result: completed({ mode: "text", text }) };
      },
    },
  });

  return steerInbox === undefined && input.compactionSource === undefined
    ? loopResult
    : loopResult.finally(() => {
        steerInbox?.close();
        input.compactionSource?.close?.();
      });
}
