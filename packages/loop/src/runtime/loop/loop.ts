import { NOOP_LOGGER, sanitizeErrorMessage } from "@clarvis/capability";
import type {
  AgentRole,
  CompactionContribution,
  CompactionSource,
  ToolResultImage,
  LifecycleHook,
  HookVerdict,
  CheckpointAttempt,
  OrchestrationHooks,
} from "@clarvis/capability";
import type { HandlerResult, HandlerVerdict } from "./loop-contract.ts";
import type { Logger } from "@clarvis/capability";
import type { NamespacedTool } from "@clarvis/capability";
import type { LLMCallParams, LLMToolCall, ToolChoice } from "@clarvis/capability";
import { reasoningOutputFloor } from "@clarvis/capability";
import type { ConvergenceGuards, GuardTrip } from "../guards/convergence-guards.ts";
import type {
  LiveContext,
  CompactionConfig,
  CompactionEvent,
} from "../context/context-compaction.ts";
import { willTruncateToolResult } from "../context/context-compaction.ts";
import type { ToolSpill } from "../context/tool-spill.ts";
import type { CompactionAnchor } from "../context/llm-compaction.ts";
import { attemptCompaction, runCompaction } from "../context/llm-compaction.ts";
import {
  createCachePrefixWatch,
  recordIterationMetrics,
  recordModelCallError,
} from "./iteration-metrics.ts";
import { createCompactionReachWatch } from "./compaction-reach.ts";
import { addUsage } from "../usage.ts";
import {
  collectCompactionContributions,
  fireObservers,
  runVerdictHooks,
  runBeforeIteration,
} from "./lifecycle-hooks.ts";
import { runIterationPreamble } from "./loop-iteration.ts";
import { callModelWithRecovery } from "./model-call.ts";
import { classifyResponse } from "./classify-response.ts";
import { selectHandler, type EngineTerminalVerdict, type ToolHandler } from "./loop-contract.ts";
import {
  cancelOrCheckpoint,
  type AgentResult,
  type LlmTarget,
  type LoopBudget,
  type LoopRuntime,
} from "./loop-shared.ts";
import { combineSignals } from "../support/signals.ts";
import type { ProgressTracker } from "./progress.ts";
import type {
  AssistantReasoningPart,
  AssistantTextPart,
  ComputeClock,
  ComputeRegion,
} from "@clarvis/capability";
import { OutputBudgetExhaustedError } from "./output-budget.ts";

/**
 * The outcome of a finalize policy step: `"return"` ends the loop with the given
 * {@link AgentResult}, `"continue"` keeps iterating.
 */
export type FinalizeStep = { kind: "return"; result: AgentResult } | { kind: "continue" };

/**
 * How the loop turns a would-be completion into a decision — how it treats a
 * lone `submit_result` call and a text-only completion.
 *
 * @remarks {@link runAgent} supplies this; the loop never decides finalization
 *   itself.
 */
export interface FinalizePolicy {
  /** A capability requested a checkpoint; all call results are appended before the gate sweep. */
  onRequested: (attempt: CheckpointAttempt) => Promise<FinalizeStep>;
  /**
   * Optional fast path: given the iteration's tool calls, return an
   * {@link AgentResult} to accept a submit immediately (bypassing dispatch) or
   * `null` to fall through to normal handling.
   */
  fastAcceptSubmit?: (toolCalls: LLMToolCall[], iteration: number) => AgentResult | null;
  /**
   * Invoked when the model produced text and no tool calls; decides whether that
   * text finalizes the run (a {@link FinalizeStep}).
   */
  onTextOnly: (
    text: string,
    iteration: number,
    reasoning?: AssistantReasoningPart[],
    textParts?: AssistantTextPart[],
  ) => Promise<FinalizeStep> | FinalizeStep;
}

/**
 * The terminal {@link AgentResult} factories the loop calls when a stop
 * condition is reached, each producing the persona-appropriate result.
 */
export interface AgentLoopResults {
  /** All configured MCP servers became unavailable. */
  allToolsUnavailable: () => AgentResult;
  /** The shared output-token ceiling has no headroom for another model call. */
  budgetExhausted: () => Promise<AgentResult>;
  /** The model returned empty/reasoning-only completions past the streak limit. */
  emptyResponse: () => AgentResult;
  /** The progress tracker's no-progress streak was exceeded. */
  noProgress: () => AgentResult;
  /** A convergence guard tripped; carries the {@link GuardTrip} that fired. */
  guardTrip: (trip: GuardTrip) => AgentResult;
}

/**
 * The slice of the run input the loop reads directly — the agent identity, LLM
 * target, budget, runtime handles, compaction config and lifecycle hooks.
 *
 * @remarks {@link RunAgentInput} extends this, so {@link runAgent} hands its own
 *   input through to {@link runAgentLoop} unchanged — these fields are never
 *   re-marshaled between the two layers.
 */
export interface LoopCore {
  agent: AgentRole;
  subagentInstanceId?: string;
  target: LlmTarget;
  budget: LoopBudget;
  runtime: LoopRuntime;
  compaction: CompactionConfig;
  compactionPrompt?: string;
  /** Explicit requests for this entry agent, consumed before an iteration starts. */
  compactionSource?: CompactionSource;
  clock?: ComputeClock;
  /**
   * This agent's own background compute region, when it runs in the background.
   *
   * @remarks Present only for a child spawned in the background. Its dispatch
   * pauses *this* region instead of the shared clock, so pausing for its own
   * tool batch never stops the parent's countdown — and so the parent's own
   * `pauseCompute` can never claim this child's work as paused.
   */
  computeRegion?: ComputeRegion;
  /**
   * Persists a tool result the context is about to truncate, answering with the
   * workspace-relative path the truncation marker then names.
   *
   * @remarks A port rather than a `workspaceRoot` field: this is a loop config
   *   object, not a path registry, and a {@link LiveContext} must stay
   *   synchronous and I/O-free. Absent when the run has no workspace (a
   *   sub-agent may be built without one), in which case a truncated result
   *   loses its middle exactly as before.
   */
  spillToolResult?: ToolSpill;
  hooks?: LifecycleHook[];
  logger?: Logger;
  allToolsUnavailable: () => boolean;
  onStart?: () => void;
}

/**
 * The machinery {@link runAgent} assembles on top of its {@link LoopCore} input
 * before entering {@link runAgentLoop} — the live context, the resolved
 * tools/handlers/guards, the finalize policy, and the optional lifecycle hooks
 * (all `?` fields) that capabilities contribute.
 *
 * @remarks The `beforeIteration`/`afterDispatch`/`beforeCheckpoint`/`onTeardown`
 *   hooks fire at fixed points in {@link runAgentLoop}; `computeProgress`,
 *   `takeForcedChoice`, `drainSteer` and `onAssistantText` let a capability
 *   influence a single iteration.
 */
export interface LoopDerived {
  ctx: LiveContext;
  tools: NamespacedTool[];
  handlers: ToolHandler[];
  guards: ConvergenceGuards;
  progress: ProgressTracker;
  /** Returns the current compaction anchor (immovable context head), if any. */
  anchor?: () => CompactionAnchor | undefined;

  /** Returns a cancelled {@link AgentResult} if the run's signal aborted, else `null`. */
  maybeCancelled: () => AgentResult | null;
  /** Runs the budget checkpoint; a non-`null` result ends the loop. */
  checkpoint: () => Promise<AgentResult | null>;
  results: AgentLoopResults;
  finalize: FinalizePolicy;

  /** Awaited under a finite wall bound before the preamble; a terminal result stops this stage. */
  beforeIteration?: OrchestrationHooks["beforeIteration"];
  /** Drains queued user steer messages into the context for this iteration. */
  drainSteer?: (iteration: number) => void | Promise<void>;
  /** Fires after a tool-dispatch batch, before guard/progress evaluation. */
  afterDispatch?: () => void;
  /**
   * Resolves a hard convergence-guard trip before it becomes terminal.
   *
   * @returns `"continue"` to keep looping (the guard has been reset), an
   *   {@link AgentResult} to end the run with that outcome, or `undefined` to
   *   fall through to the default terminal result.
   * @remarks Absent unless the run opted into guard escalation, which is what
   *   keeps a non-interactive caller's behaviour identical to before: with no
   *   hook, the trip terminates exactly as it always did.
   */
  onGuardTrip?: (trip: GuardTrip) => Promise<AgentResult | "continue" | undefined>;
  /** Fires just before the end-of-iteration budget checkpoint. */
  beforeCheckpoint?: () => void;
  /** Fires once in the loop's `finally`, whatever the exit path, and is awaited
   * — a capability may hold background work that must wind down before the run's
   * trace and accounting close over it. */
  onTeardown?: () => void | Promise<void>;
  /** Yields a one-shot forced {@link ToolChoice} for the next model call, if a capability set one. */
  takeForcedChoice?: () => ToolChoice | undefined;
  /** Notified of the assistant's latest text (used to track partial output). */
  onAssistantText?: (text: string) => void;
  /**
   * Folds capability-contributed progress into the dispatch's own signal — the
   * iteration counts as productive if the dispatch produced work or this returns
   * `true`.
   */
  computeProgress?: (dispatchProduced: boolean) => boolean;
}

/**
 * The result of dispatching one iteration's tool calls: either a `"terminal"`
 * {@link AgentResult} that ends the loop, or `"done"` with whether the batch
 * `produced` progress.
 */
type DispatchResult =
  | { kind: "terminal"; result: AgentResult }
  | { kind: "finalize"; attempt: CheckpointAttempt; produced: boolean }
  | { kind: "done"; produced: boolean };

/**
 * How many consecutive empty/reasoning-only completions end the run as an error.
 *
 * @remarks The smallest value that admits a nudge: at 1 the run dies without the
 * model ever being told what went wrong, and at 3 or more a second full model
 * call is spent on a condition the first nudge already failed to fix. So the
 * sequence is fixed — first empty completion nudges, second ends the run.
 */
const MAX_CONSECUTIVE_EMPTY_RESPONSES = 2;

/**
 * Builds the thunk the iteration preamble calls for automatic or explicitly
 * requested context compaction.
 *
 * @returns a function that drains explicit requests, fires any `onPreCompact`
 *   hooks when a pass is requested or automatically needed, and runs the
 *   applicable policy against the current target/anchor. It resolves to the
 *   {@link CompactionEvent} recorded by the iteration, or `undefined` when the
 *   request is observably skipped and no automatic fallback applies.
 */
function buildCompactionThunk(
  core: LoopCore,
  d: LoopDerived,
): () => Promise<CompactionEvent | undefined> {
  const { target, budget, runtime } = core;
  const { ctx } = d;
  return async () => {
    const requests = core.compactionSource?.drain() ?? [];
    const requested = requests.length > 0;
    const scheduledNeeded = ctx.needsCompaction();
    const observed = async (
      event: CompactionEvent | undefined,
    ): Promise<CompactionEvent | undefined> => {
      if (event !== undefined) {
        await fireObservers(
          core.hooks,
          "onPostCompact",
          {
            agent: event.agent,
            ...(event.subagent_instance_id === undefined
              ? {}
              : { subagentInstanceId: event.subagent_instance_id }),
            operation: event.operation,
            ...(event.freed_chars === undefined ? {} : { freedChars: event.freed_chars }),
            ...(event.kept_chars === undefined ? {} : { keptChars: event.kept_chars }),
          },
          core.logger,
        );
      }
      return event;
    };
    if (requested || scheduledNeeded) {
      runtime.trace.signal("compaction_started", {
        agent: core.agent,
        ...(core.subagentInstanceId !== undefined
          ? { subagent_instance_id: core.subagentInstanceId }
          : {}),
        mode: requested ? "forced" : "scheduled",
      });
    }
    let contributions: CompactionContribution[] = [];
    if (core.hooks?.some((h) => h.onPreCompact) === true && (requested || scheduledNeeded)) {
      contributions = await collectCompactionContributions(
        core.hooks,
        {
          agent: core.agent,
          ...(core.subagentInstanceId !== undefined
            ? { subagentInstanceId: core.subagentInstanceId }
            : {}),
          estimatedTokens: ctx.estimateTokens(),
        },
        core.logger,
      );
    }
    const anchor = d.anchor?.();
    const args = {
      ctx,
      ...(core.compactionPrompt !== undefined ? { compactionPrompt: core.compactionPrompt } : {}),
      ...(anchor ? { anchor } : {}),
      llm: target.llm,
      model: target.model,
      provider: target.provider,
      ...(target.providerConfig ? { providerConfig: target.providerConfig } : {}),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      timeoutMs: core.compaction.llmTimeoutMs,
      windowTokens: core.compaction.windowTokens,
      ledger: budget.ledger,
      usage: budget.usage,
      logger: core.logger ?? NOOP_LOGGER,
    };

    if (!requested) {
      return observed(
        await runCompaction({
          ...args,
          ...(contributions.length > 0 ? { contributions } : {}),
        }),
      );
    }

    const userContributions = requests.flatMap((entry): CompactionContribution[] => {
      const text = entry.request?.trim();
      return text ? [{ source: "user", text }] : [];
    });
    const recordSkipped = (
      reason:
        | "disabled"
        | "nothing_to_compact"
        | "summarization_disabled"
        | "summarization_failed"
        | "summary_not_effective",
    ): void => {
      runtime.trace.record("compaction_skipped", {
        agent: core.agent,
        ...(core.subagentInstanceId !== undefined
          ? { subagent_instance_id: core.subagentInstanceId }
          : {}),
        reason,
      });
    };

    if (!core.compaction.enabled) {
      recordSkipped("disabled");
      return undefined;
    }
    if (userContributions.length > 0 && core.compactionPrompt === undefined) {
      recordSkipped("summarization_disabled");
      return observed(scheduledNeeded ? ctx.compact() : undefined);
    }

    const outcome = await attemptCompaction({
      ...args,
      mode: "forced",
      fallbackOnFailure: userContributions.length === 0,
      contributions: [...contributions, ...userContributions],
    });
    if (outcome.kind === "applied") {
      const userContributionCount = outcome.appliedContributions.filter(
        (contribution) => contribution.source === "user",
      ).length;
      return observed({
        ...outcome.event,
        requested: true,
        ...(userContributionCount > 0 ? { user_contribution_count: userContributionCount } : {}),
      });
    }

    recordSkipped(outcome.reason);
    return observed(scheduledNeeded ? ctx.compact() : undefined);
  };
}

/**
 * Clamps the configured max-output-tokens so the prompt plus the reserved output
 * fits the model's context window, after first raising it toward an optional
 * reasoning floor.
 *
 * @param configured - the target's requested `maxOutputTokens`.
 * @param windowTokens - the model context window; `<= 0` disables the window
 *   clamp (the floor, when given, still applies).
 * @param promptTokensEstimate - the current estimated prompt size.
 * @param floor - a minimum to raise `configured` toward before clamping (see
 *   {@link reasoningOutputFloor}), so the window clamp is always the last,
 *   outermost step and can never be overridden back above the window.
 * @returns the smaller of `available` (90% of the remaining window) and
 *   `Math.max(configured, floor)`, but never below 1. `configured` alone when
 *   `windowTokens <= 0`.
 * @remarks The floor and the window clamp can conflict (a context window too
 *   full to leave room for the requested reasoning effort); the window always
 *   wins, so the call degrades to less thinking room rather than exceeding the
 *   window and being rejected outright by the provider.
 */
function clampOutputBudget(
  configured: number,
  windowTokens: number,
  promptTokensEstimate: number,
  floor?: number,
): number {
  const floored = floor !== undefined ? Math.max(configured, floor) : configured;
  if (windowTokens <= 0) return floored;
  const available = Math.floor((windowTokens - promptTokensEstimate) * 0.9);
  return Math.max(1, Math.min(floored, available));
}

/**
 * Assembles the {@link LLMCallParams} for one iteration from the target, the live
 * context messages, and the tool set.
 *
 * @remarks Tools are omitted when the target lacks the `tool_calling` capability;
 *   `maxOutputTokens` is passed through {@link clampOutputBudget}, raised
 *   toward the target's {@link reasoningOutputFloor} first — this also runs
 *   when the target sets no explicit `maxOutputTokens` at all, so a high
 *   reasoning effort still gets a window-safe budget instead of an unclamped
 *   one.
 *
 *   `onRetry` is attached unconditionally. It pokes the {@link ComputeClock}
 *   when there is one, so retry waits do not count as idle compute, and it
 *   always records a durable `model_call_retry` — a retried call is worth
 *   showing whether or not the run has a clock. `at` is taken from the trace
 *   rather than closed over, so this function stays pure with respect to loop
 *   state; the iteration it belongs to is passed in instead.
 */
function buildModelCall(
  core: LoopCore,
  d: LoopDerived,
  retryCtx: {
    iteration: number;
    traceIdFields: { subagent_instance_id?: string };
    onRetry?: () => void;
  },
): LLMCallParams {
  const { target, runtime, clock } = core;
  const supportsToolCalling = target.capabilities?.has("tool_calling") ?? true;
  const reasoningFloor = reasoningOutputFloor(target.providerConfig?.kind, target.reasoningEffort);
  const outputBudgetBase = target.maxOutputTokens ?? reasoningFloor;
  const breakpoints = d.ctx.cacheBreakpoints();
  const cacheBreakpoints = [breakpoints.prior, breakpoints.stable].filter((i) => i >= 0);
  return {
    model: target.model,
    ...(core.subagentInstanceId === undefined ? {} : { agentInstanceId: core.subagentInstanceId }),
    provider: target.provider,
    ...(target.providerConfig ? { providerConfig: target.providerConfig } : {}),
    ...(target.capabilities !== undefined ? { capabilities: target.capabilities } : {}),
    messages: d.ctx.messages,
    ...(cacheBreakpoints.length > 0 ? { cacheBreakpoints } : {}),
    tools: supportsToolCalling ? d.tools : [],
    signal: runtime.signal,
    ...(target.callTimeoutMs !== undefined ? { timeoutMs: target.callTimeoutMs } : {}),
    ...(outputBudgetBase !== undefined
      ? {
          maxOutputTokens: clampOutputBudget(
            outputBudgetBase,
            core.compaction.windowTokens,
            d.ctx.estimateTokens(),
            reasoningFloor,
          ),
        }
      : {}),
    ...(target.reasoningSummary !== undefined ? { reasoningSummary: target.reasoningSummary } : {}),
    ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort } : {}),
    ...(target.maxRetries !== undefined ? { maxRetries: target.maxRetries } : {}),
    ...(target.maxRetryAfterMs !== undefined ? { maxRetryAfterMs: target.maxRetryAfterMs } : {}),
    onRetry: (info): void => {
      retryCtx.onRetry?.();
      clock?.poke();
      runtime.trace.record("model_call_retry", {
        agent: core.agent,
        ...retryCtx.traceIdFields,
        iteration: retryCtx.iteration,
        model: target.model,
        kind: info.kind,
        message: info.message,
        attempt: info.attempt,
        max_retries: info.maxRetries,
        delay_ms: info.delayMs,
        ...(info.status !== undefined ? { status: info.status } : {}),
        ...(info.retryAfterMs !== undefined ? { retry_after_ms: info.retryAfterMs } : {}),
      });
    },
  };
}

/**
 * Longest rendering of replacement arguments placed in the model's context.
 *
 * @remarks A clamp on *someone else's* payload: the arguments are whatever a
 * workspace hook chose to substitute, so this is the one number standing between
 * an operator's hook and the run's context. It is paid permanently — the note is
 * appended, so it sits inside the cached prefix for every later request — which
 * is what rules out simply rendering the whole thing.
 *
 * Bracketed rather than derived: below roughly this size the note truncates the
 * very arguments it exists to name (a rewritten `write_file` is mostly content),
 * and the excess only has to be enough for the model to recognise what ran, not
 * to reconstruct it. The trace keeps the untruncated `arguments` either way, so
 * nothing is lost to diagnosis — only to the model's own reading.
 */
const REWRITE_NOTE_MAX_CHARS = 2_000;

/** Describe a dispatched tool to lifecycle hooks without losing its wire name. */
function hookToolIdentity(
  handler: ToolHandler,
  call: LLMToolCall,
): { tool: string; toolFullName?: string } {
  let toolFullName: string | undefined;
  try {
    toolFullName = handler.canonicalName?.(call);
  } catch {
    toolFullName = undefined;
  }
  return {
    tool: call.name,
    ...(toolFullName === undefined || toolFullName === call.name ? {} : { toolFullName }),
  };
}

/**
 * Render the note telling the model its call was rewritten before it ran.
 *
 * @param args - the arguments that actually executed.
 * @returns one advisory line, with the arguments serialized and clamped.
 * @remarks The model must be told. Its own transcript keeps the call it made —
 *   the engine never mutates that — so without this note the model reasons about
 *   a call that did not happen, and a result it cannot account for looks like a
 *   tool defect. Naming what actually ran is what makes the divergence
 *   debuggable rather than merely disclosed.
 */
function rewriteNote(args: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(args) ?? "";
  } catch {
    rendered = "";
  }
  const shown =
    rendered.length <= REWRITE_NOTE_MAX_CHARS
      ? rendered
      : `${rendered.slice(0, REWRITE_NOTE_MAX_CHARS)}...`;
  return shown === ""
    ? "A workspace hook replaced this call's arguments before it ran."
    : `A workspace hook replaced this call's arguments before it ran. What actually ran: ${shown}`;
}

/**
 * Runs every `beforeToolUse` hook for one tool call and collapses their verdicts.
 *
 * @returns `denied` — the first deny message, or `null` if the call may proceed —
 *   `adviseMessages`, any advisory notes the hooks appended, and `rewritten` when
 *   a hook replaced the call's arguments.
 * @remarks Fails closed: a hook that throws denies the call. Replacement
 *   arguments are threaded, so each hook rules on what its predecessors left and
 *   the last writer decides; operator hooks run first, so they shape what a
 *   plugin hook is given.
 */
async function applyBeforeHooks(
  core: LoopCore,
  call: LLMToolCall,
  handler: ToolHandler,
): Promise<{
  denied: string | null;
  adviseMessages: string[];
  rewritten?: { arguments: unknown };
}> {
  const sweep = await runVerdictHooks(
    core.hooks,
    (h, rewritten) =>
      h.beforeToolUse
        ? (): Promise<HookVerdict> | HookVerdict =>
            h.beforeToolUse!({
              ...hookToolIdentity(handler, call),
              arguments: rewritten === undefined ? call.arguments : rewritten,
            })
        : undefined,
    {
      onThrow: "deny",
      onThrowWarn: "beforeToolUse hook threw; failing closed — call denied",
      logger: core.logger,
      logFields: { tool: call.name },
      ...(core.runtime.signal !== undefined ? { signal: core.runtime.signal } : {}),
    },
  );
  const advise = [...sweep.advise];
  if (sweep.rewritten !== undefined) advise.push(rewriteNote(sweep.rewritten.arguments));
  return {
    denied: sweep.denied?.message ?? null,
    adviseMessages: advise,
    ...(sweep.rewritten === undefined ? {} : { rewritten: sweep.rewritten }),
  };
}

/**
 * Runs every `afterToolUse` hook over a tool result and folds in advisory notes.
 *
 * @param adviseMessages - advisories carried over from {@link applyBeforeHooks},
 *   extended in place with any the after-hooks add.
 * @returns the possibly-rewritten {@link HandlerResult}: a hook deny replaces the
 *   text with a `DENIED by a workspace hook` message, otherwise each advisory is
 *   appended to the result text as an `[advisor]` line.
 * @remarks Fails open: a hook that throws leaves the result unmodified.
 */
async function applyAfterHooks(
  core: LoopCore,
  call: LLMToolCall,
  handler: ToolHandler,
  result: HandlerResult,
  adviseMessages: string[],
): Promise<HandlerResult> {
  const afterResult = {
    text: result.text,
    progress: result.progress,
    taskId: result.taskId,
    images: result.images,
  };
  const sweep = await runVerdictHooks(
    core.hooks,
    (h) =>
      h.afterToolUse
        ? (): Promise<HookVerdict> | HookVerdict =>
            h.afterToolUse!({
              ...hookToolIdentity(handler, call),
              arguments: call.arguments,
              result: afterResult,
            })
        : undefined,
    {
      onThrow: "ignore",
      onThrowWarn: "afterToolUse hook threw; result passed through unmodified",
      logger: core.logger,
      logFields: { tool: call.name },
      ...(core.runtime.signal !== undefined ? { signal: core.runtime.signal } : {}),
    },
  );
  if (sweep.denied !== null) {
    return { text: `DENIED by a workspace hook: ${sweep.denied.message}`, progress: false };
  }
  adviseMessages.push(...sweep.advise);
  let text = result.text;
  for (const m of adviseMessages) text = `${text}\n\n[advisor] ${m}`;
  return { text, progress: result.progress, taskId: result.taskId, images: result.images };
}

/**
 * The model-facing result text for the call whose handler ended the agent.
 *
 * @param name - the tool's name, as the model called it.
 * @param verdict - the terminal verdict that call produced.
 * @returns the handler's own `text` when it framed one, otherwise a line derived
 *   from the terminal {@link AgentResult}: its cancellation, its error message,
 *   or a plain acceptance.
 * @remarks A call that ended the agent is a call that ran, so it never carries
 *   the `was not completed` fill — that text belongs to the calls of the same
 *   batch the dispatch never reached.
 */
function terminalCallText(name: string, verdict: EngineTerminalVerdict): string {
  if (verdict.text !== undefined) return verdict.text;
  if (verdict.result.status === "cancelled") return `Tool '${name}' was cancelled.`;
  const message = verdict.result.error?.message;
  return message === undefined
    ? `Tool '${name}' result: accepted (the run ended with this call).`
    : `Tool '${name}' result (error): ${message}`;
}

type AbortableSettlement<T> =
  { kind: "fulfilled"; value: T } | { kind: "rejected"; reason: unknown } | { kind: "aborted" };

/**
 * Observe a promise until it settles or the supplied signal aborts.
 *
 * @remarks The tagged settlement promise installs both fulfillment and
 *   rejection handlers before the abort race starts. If abort wins, the
 *   underlying work is therefore detached but remains observed — a later
 *   rejection cannot become an unhandled rejection.
 */
async function settleOrAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<AbortableSettlement<T>> {
  const settled: Promise<AbortableSettlement<T>> = work.then(
    (value) => ({ kind: "fulfilled", value }),
    (reason: unknown) => ({ kind: "rejected", reason }),
  );
  if (signal === undefined) return settled;
  if (signal.aborted) return { kind: "aborted" };

  let resolveAborted!: (result: AbortableSettlement<T>) => void;
  const aborted = new Promise<AbortableSettlement<T>>((resolve) => {
    resolveAborted = resolve;
  });
  const onAbort = (): void => resolveAborted({ kind: "aborted" });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Executes one iteration's tool calls in order, honoring hooks, cancellation,
 * and deferred (parallel) handlers, then appends every result to the context.
 *
 * @param toolCalls - the calls to run, in the order the model emitted them.
 * @returns a {@link DispatchResult}: `"terminal"` when a handler returned a
 *   terminal result or the run was cancelled mid-batch, otherwise `"done"` with
 *   whether any call `produced` progress.
 * @remarks Sequential handlers run inline; `"deferred"` verdicts run concurrently
 *   under a batch {@link AbortController} combined with the run signal. A handler
 *   that throws or a deferred that rejects becomes an error result rather than
 *   aborting the batch. When the batch stops early (terminal or abort) the
 *   controller is aborted. Deferreds are awaited while the run remains active;
 *   run cancellation detaches non-cooperative work while retaining a rejection
 *   observer. A terminal or cancelled call records its own outcome — see
 *   {@link terminalCallText} — so the `was not completed` fill is left to the
 *   calls this batch never reached. The compute clock is paused for the batch and
 *   released in `finally`.
 */
async function runDispatch(
  core: LoopCore,
  d: LoopDerived,
  toolCalls: LLMToolCall[],
  iteration: number,
): Promise<DispatchResult> {
  const n = toolCalls.length;
  const results = new Array<string | undefined>(n);
  const taskIds = new Array<string | undefined>(n);
  const images = new Array<ToolResultImage[] | undefined>(n);
  const deferred: Promise<void>[] = [];
  let produced = false;
  let terminal: { result: AgentResult } | null = null;
  let requested: CheckpointAttempt | undefined;
  let dispatchCompleted = false;
  const batchController = new AbortController();
  let batchCombined: AbortSignal | undefined;
  const batchSignal = (): AbortSignal | undefined =>
    (batchCombined ??= combineSignals(core.runtime.signal, batchController.signal));

  const releaseClock = core.computeRegion ? core.computeRegion.pause() : core.clock?.pauseCompute();

  try {
    for (let i = 0; i < n; i += 1) {
      if (terminal) break;
      if (core.runtime.signal?.aborted) {
        const c = d.maybeCancelled();
        if (c) terminal = { result: c };
        break;
      }
      const original = toolCalls[i]!;
      const handler = selectHandler(d.handlers, original)!;
      const { denied, adviseMessages, rewritten } = await applyBeforeHooks(core, original, handler);
      if (denied !== null) {
        results[i] = `DENIED by a workspace hook: ${denied}`;
        continue;
      }
      /**
       * A rewritten call is a **new object**: the provider's own call has
       * already been appended to the context, and mutating it would rewrite the
       * assistant message the model sent and break the request prefix. The
       * replacement still meets the tool's schema and the command guard, both of
       * which sit downstream of this point.
       */
      const call: LLMToolCall =
        rewritten === undefined
          ? original
          : { ...original, arguments: rewritten.arguments, rewrittenFrom: original.arguments };
      const handled = await settleOrAbort(
        Promise.resolve().then(() => handler.handle(call, iteration)),
        core.runtime.signal,
      );
      if (handled.kind === "aborted") {
        results[i] = `Tool '${call.name}' was cancelled.`;
        const c = d.maybeCancelled();
        if (c) terminal = { result: c };
        break;
      }
      if (handled.kind === "rejected") {
        const msg =
          handled.reason instanceof Error ? handled.reason.message : String(handled.reason);
        results[i] = `Tool '${call.name}' failed: ${msg}`;
        core.logger?.warn(
          { event: "tool.handler_failed", tool: call.name, err: sanitizeErrorMessage(msg) },
          "tool handler threw; converted to an error result",
        );
        continue;
      }
      let v: HandlerVerdict = handled.value;
      if ((v.kind === "result" || v.kind === "finalize") && core.hooks) {
        const final = await applyAfterHooks(core, call, handler, v, adviseMessages);
        v =
          v.kind === "finalize"
            ? { kind: "finalize", attempt: v.attempt, ...final }
            : { kind: "result", ...final };
      }
      if (v.kind === "terminal") {
        results[i] = terminalCallText(call.name, v);
        terminal = { result: v.result };
        break;
      }
      if (v.kind === "cancelled") {
        results[i] = `Tool '${call.name}' was cancelled.`;
        const c = d.maybeCancelled();
        if (c) {
          terminal = { result: c };
          break;
        }
        continue;
      }
      if (v.kind === "deferred") {
        const idx = i;
        deferred.push(
          v
            .run(batchSignal())
            .then(async (r) => {
              const final = core.hooks
                ? await applyAfterHooks(core, call, handler, r, adviseMessages)
                : r;
              results[idx] = final.text;
              taskIds[idx] = final.taskId;
              images[idx] = final.images;
              if (final.progress) produced = true;
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              results[idx] = `Tool '${call.name}' failed: ${msg}`;
              core.logger?.warn(
                {
                  event: "tool.deferred_handler_failed",
                  tool: call.name,
                  err: sanitizeErrorMessage(msg),
                },
                "deferred tool handler rejected; converted to an error result",
              );
            }),
        );
        continue;
      }
      results[i] = v.text;
      taskIds[i] = v.taskId;
      images[i] = v.images;
      if (v.progress) produced = true;
      if (v.kind === "finalize") {
        requested = v.attempt;
        break;
      }
    }
    dispatchCompleted = true;
  } finally {
    if (terminal !== null || !dispatchCompleted) batchController.abort();
    const joined = await settleOrAbort(Promise.allSettled(deferred), core.runtime.signal);
    if (joined.kind === "aborted") {
      batchController.abort();
      const c = d.maybeCancelled();
      if (c) terminal = { result: c };
    }
    releaseClock?.();
  }

  for (let i = 0; i < n; i += 1) {
    const call = toolCalls[i]!;
    const text =
      results[i] ?? `Tool '${call.name}' was not completed (the dispatch ended before its result).`;
    const spillPath = willTruncateToolResult(text, core.compaction)
      ? await core.spillToolResult?.(text)
      : undefined;
    const taskId = taskIds[i];
    const resultImages = images[i];
    const { event } = d.ctx.appendToolMessage(call.id, text, {
      ...(taskId !== undefined ? { taskId } : {}),
      ...(resultImages !== undefined ? { images: resultImages } : {}),
      ...(spillPath !== undefined ? { spillPath } : {}),
    });
    if (event) core.runtime.trace.record("compaction", event);
  }

  if (terminal) return { kind: "terminal", result: terminal.result };
  if (requested) return { kind: "finalize", attempt: requested, produced };

  return { kind: "done", produced };
}

/**
 * Drives one agent to a terminal {@link AgentResult}: the iteration loop that
 * compacts, calls the model, classifies the completion, dispatches tool calls,
 * and checks guards/progress/budget until a stop condition is reached.
 *
 * @param core - the run's directly-read input ({@link LoopCore}).
 * @param d - the assembled machinery ({@link LoopDerived}) from {@link runAgent}.
 * @returns the terminal result from whichever branch stops the loop —
 *   cancellation, all-tools-unavailable, empty-response, a finalize decision, a
 *   guard trip, no-progress, or the budget checkpoint.
 * @remarks Each iteration: fire `beforeIteration`, run the preamble (budget +
 *   compaction), drain steer, call the model with recovery, record metrics, then
 *   branch on {@link classifyResponse} — empty/reasoning-only completions bump an
 *   empty streak and nudge (ending after {@link MAX_CONSECUTIVE_EMPTY_RESPONSES}),
 *   text-only defers to `finalize.onTextOnly`, and tool-call completions append
 *   the calls, try `fastAcceptSubmit`, then {@link runDispatch}. After a dispatch
 *   it evaluates guards, folds progress via `computeProgress`, and runs the
 *   end-of-iteration checkpoint. Compaction and ordinary turns share the same
 *   guarded provider; exhaustion anywhere in that boundary becomes a normal
 *   budget result. `onTeardown` always fires in `finally`.
 */
export async function runAgentLoop(core: LoopCore, d: LoopDerived): Promise<AgentResult> {
  const { target, budget, runtime } = core;
  const { ctx } = d;
  const trace = runtime.trace;
  const idFields =
    core.subagentInstanceId !== undefined ? { subagentInstanceId: core.subagentInstanceId } : {};
  const traceIdFields =
    core.subagentInstanceId !== undefined ? { subagent_instance_id: core.subagentInstanceId } : {};

  core.onStart?.();

  const cacheWatch = createCachePrefixWatch();
  const reachWatch = createCompactionReachWatch(core.compaction, core.logger);
  let emptyStreak = 0;

  try {
    for (;;) {
      const prepared = await runBeforeIteration(d.beforeIteration, { signal: runtime.signal });
      if (prepared !== undefined) return d.maybeCancelled() ?? prepared;

      const pre = await runIterationPreamble({
        signal: runtime.signal,
        trace,
        agent: core.agent,
        ...idFields,
        model: target.model,
        counter: budget.counter,
        allToolsUnavailable: core.allToolsUnavailable,
        compact: async () => {
          const event = await buildCompactionThunk(core, d)();
          if (event !== undefined) cacheWatch.resetForCompaction();
          return event;
        },
      });
      if (!pre.proceed) {
        if (pre.reason === "cancelled") return d.maybeCancelled()!;
        return d.results.allToolsUnavailable();
      }
      const { iteration, iterStart } = pre;

      await d.drainSteer?.(iteration);

      const announcedToolCalls = new Set<string>();
      let toolAttempt = 1;

      const withStreaming = (call: LLMCallParams): LLMCallParams =>
        target.stream === false
          ? call
          : {
              ...call,
              onStreamDelta: (delta: {
                channel: "text" | "reasoning";
                text: string;
                reset: boolean;
              }): void =>
                trace.signal("model_stream_delta", {
                  agent: core.agent,
                  ...traceIdFields,
                  iteration,
                  model: target.model,
                  channel: delta.channel,
                  text: delta.text,
                  reset: delta.reset,
                }),
              onToolInputDelta: (delta: {
                call_id: string;
                tool_name: string;
                chars: number;
                stream_chars?: number;
                complete?: true;
              }): void => {
                const detail = {
                  agent: core.agent,
                  ...traceIdFields,
                  call_id: delta.call_id,
                  tool_name: delta.tool_name,
                  chars: delta.chars,
                  ...(delta.stream_chars !== undefined ? { stream_chars: delta.stream_chars } : {}),
                  ...(delta.complete === true ? { complete: true as const } : {}),
                };
                if (!announcedToolCalls.has(delta.call_id)) {
                  announcedToolCalls.add(delta.call_id);
                  trace.record("tool_call_announced", {
                    agent: core.agent,
                    ...traceIdFields,
                    call_id: delta.call_id,
                    tool_name: delta.tool_name,
                    iteration,
                    attempt: toolAttempt,
                  });
                }
                trace.signal("tool_input_delta", detail);
              },
            };
      const retryCtx = {
        iteration,
        traceIdFields,
        onRetry: (): void => {
          announcedToolCalls.clear();
          toolAttempt++;
        },
      };
      const baseCall = buildModelCall(core, d, retryCtx);
      const streamingCall = withStreaming(baseCall);
      const forcedChoice = d.takeForcedChoice?.();
      let modelOutcome;
      try {
        modelOutcome = await callModelWithRecovery({
          llm: target.llm,
          baseCall: streamingCall,
          ...(forcedChoice !== undefined ? { forcedChoice } : {}),
          evict: () => {
            reachWatch.observeOverflow(ctx.estimateTokens());
            return ctx.forceEvictOldest();
          },
          rebuild: () => {
            retryCtx.onRetry();
            return withStreaming(buildModelCall(core, d, retryCtx));
          },
          overflowDiagnostic: (original) =>
            `context does not fit: ${core.agent}'s non-evictable context (~${ctx.estimateTokens()} tokens) ` +
            `exceeds the model context window (${core.compaction.windowTokens} tokens); ` +
            `eviction cannot recover. Provider error: ${original.message}`,
          trace,
          maybeCancelled: d.maybeCancelled,
          recordError: async (err) => {
            if (err.accumulatedUsage !== undefined) {
              budget.ledger.consume(err.accumulatedUsage);
              addUsage(budget.usage, err.accumulatedUsage);
            }
            recordModelCallError({
              trace,
              agent: core.agent,
              ...idFields,
              iteration,
              model: target.model,
              err,
            });
            await fireObservers(
              core.hooks,
              "onModelCallError",
              {
                agent: core.agent,
                ...(core.subagentInstanceId !== undefined
                  ? { subagentInstanceId: core.subagentInstanceId }
                  : {}),
                iteration,
                model: target.model,
                message: err instanceof Error ? err.message : String(err),
              },
              core.logger,
            );
          },
        });
      } catch (err) {
        if (err instanceof OutputBudgetExhaustedError) return d.results.budgetExhausted();
        throw err;
      }
      if (!modelOutcome.ok) return modelOutcome.cancelled;
      const llmResult = modelOutcome.result;
      ctx.observeUsage(llmResult.usage.input_tokens);

      recordIterationMetrics({
        llmResult,
        ledger: budget.ledger,
        usage: budget.usage,
        trace,
        agent: core.agent,
        ...idFields,
        iteration,
        iterStart,
        model: target.model,
        ...(core.logger !== undefined ? { logger: core.logger } : {}),
        cacheWatch,
      });

      const cls = classifyResponse(llmResult);
      if (cls === "empty" || cls === "reasoning-only") {
        if (cls === "reasoning-only" && llmResult.reasoningParts !== undefined) {
          ctx.appendAssistant("", llmResult.reasoningParts);
        }
        emptyStreak += 1;
        if (emptyStreak >= MAX_CONSECUTIVE_EMPTY_RESPONSES) return d.results.emptyResponse();
        ctx.appendRuntimeNote(
          "empty_response",
          cls === "reasoning-only"
            ? "[runtime: the previous completion carried only internal reasoning — no text or tool call reached the conversation. State your next action as text or call a tool now.]"
            : "[runtime: the previous completion was empty — no text and no tool call. Respond with your next action now.]",
        );
        if (d.progress.bump(false)) return d.results.noProgress();
        const stop = await cancelOrCheckpoint(d.maybeCancelled, d.checkpoint);
        if (stop) return stop;
        continue;
      }
      emptyStreak = 0;
      if (cls === "text-only") {
        const step = await d.finalize.onTextOnly(
          llmResult.text!,
          iteration,
          llmResult.reasoningParts,
          llmResult.textParts,
        );
        if (step.kind === "return") return step.result;
        continue;
      }

      const hasText = !!llmResult.text && llmResult.text.length > 0;
      if (hasText) d.onAssistantText?.(llmResult.text!);
      ctx.appendAssistantToolCalls(
        hasText ? llmResult.text! : "",
        llmResult.toolCalls!,
        llmResult.reasoningParts,
        llmResult.textParts,
      );

      const accepted = d.finalize.fastAcceptSubmit?.(llmResult.toolCalls!, iteration);
      if (accepted !== null && accepted !== undefined) return accepted;

      const dispatch = await runDispatch(core, d, llmResult.toolCalls!, iteration);
      if (dispatch.kind === "terminal") return dispatch.result;

      d.afterDispatch?.();

      /**
       * Both guards may warn in the same iteration, but `appendRuntimeNote`
       * replaces any earlier note of the same kind — so they are joined into
       * one note rather than appended in turn, where the second would silently
       * delete the first from the model's context.
       */
      const warnings = d.guards.takeSoft();
      if (warnings.length > 0) {
        ctx.appendRuntimeNote(
          "convergence_warning",
          `[runtime: ${warnings.map((w) => w.message).join(" Also: ")}]`,
        );
        for (const warning of warnings) {
          trace.record("convergence_warning", {
            agent: core.agent,
            ...traceIdFields,
            code: warning.code,
            message: warning.message,
          });
        }
      }

      /**
       * A waived trip falls through rather than `continue`-ing, so the
       * iteration still counts against the no-progress tracker and still hits
       * the budget checkpoint. Skipping both would make "continue past the
       * guard" quietly exempt that turn from two unrelated stop conditions.
       */
      const trip = d.guards.tripped();
      if (trip) {
        const escalated = await d.onGuardTrip?.(trip);
        if (escalated !== "continue") {
          /**
           * Only a genuine guard termination records `terminate`. When the
           * escalation hands back a result of its own it is a cancellation
           * observed while the prompt was open, and labelling that a guard
           * trip would put a reason in the trace that never happened.
           */
          if (escalated === undefined) trace.record("terminate", { reason: trip.code });
          return escalated ?? d.results.guardTrip(trip);
        }
      }

      if (dispatch.kind === "finalize") {
        const step = await d.finalize.onRequested(dispatch.attempt);
        if (step.kind === "return") return step.result;
      }

      const productive = d.computeProgress
        ? d.computeProgress(dispatch.produced)
        : dispatch.produced;
      if (d.progress.bump(productive)) return d.results.noProgress();

      d.beforeCheckpoint?.();

      const stop = await cancelOrCheckpoint(d.maybeCancelled, d.checkpoint);
      if (stop) return stop;
    }
  } catch (err) {
    const cancelled = d.maybeCancelled();
    if (cancelled !== null) return cancelled;
    if (err instanceof OutputBudgetExhaustedError) return d.results.budgetExhausted();
    throw err;
  } finally {
    await d.onTeardown?.();
  }
}
