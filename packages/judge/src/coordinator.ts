import { ProviderError, type LLMProvider, type ProviderConfig } from "@clarvis/capability";
import { JudgeArchitectureError } from "./errors.ts";
import { executeJudge, type JudgeExecutionInput } from "./executor.ts";
import { canonicalJudgeJson, JUDGE_POLICY, type JudgeJson } from "./prompt.ts";
import type { CompiledAuthorityTransition, JudgeTerminalReceipt } from "./private-protocol.ts";
import type { JudgeStepBinding } from "./step-machine.ts";

export type JudgeFailureKind =
  | "timeout"
  | "auth"
  | "quota"
  | "rate_limit"
  | "transport"
  | "admission"
  | "cancelled"
  | "invalid_response"
  | "unknown";
export type JudgeCommandReceipt = Extract<JudgeTerminalReceipt, { action: "decide_command" }>;
export type JudgeEffectReceipt = Extract<JudgeTerminalReceipt, { action: "decide_effects" }>;

/** JSON-only case facts; the trusted snapshot and validators are separate host bindings. */
export interface JudgeReviewCase {
  consumer?: "command_guard" | "configuration_file";
  effectId?: string;
  currentCase: JudgeJson;
}

/** Host functions retain authority and semantic validation; the coordinator stores no consent. */
export interface JudgeReviewContext<T extends JudgeTerminalReceipt> {
  snapshot(): JudgeJson;
  isCurrent(receipt?: T): boolean;
  validateReceipt(receipt: T): boolean;
}

export interface JudgeEffectContext extends JudgeReviewContext<JudgeEffectReceipt> {
  binding: Exclude<JudgeStepBinding, { kind: "command" }>;
}

type Metrics = { elapsedMs: number; attempts: number; executionId?: string; cacheHit: boolean };
export type JudgeReviewOutcome<T extends JudgeTerminalReceipt> = Metrics &
  (
    | { kind: "reviewed"; receipt: T }
    | { kind: "failed"; failureKind: JudgeFailureKind }
    | { kind: "stale" }
  );

/** One work run owns this port; it never grants effects or calls a human channel. */
export interface JudgeCoordinator {
  reviewCommand(
    input: JudgeReviewCase,
    context: JudgeReviewContext<JudgeCommandReceipt>,
  ): Promise<JudgeReviewOutcome<JudgeCommandReceipt>>;
  reviewEffects(
    input: JudgeReviewCase,
    context: JudgeEffectContext,
  ): Promise<JudgeReviewOutcome<JudgeEffectReceipt>>;
  close(): Promise<void>;
}

export interface JudgeCoordinatorOptions {
  owner: string;
  workExecutionId: string;
  sessionId: string;
  executionBaseLlm: LLMProvider;
  promptCacheTtl: "5m" | "1h";
  model?: string;
  providers: ProviderConfig[];
  timeoutMs: number;
  maxRetries: number;
  signal?: AbortSignal;
  createServices: JudgeExecutionInput["createServices"];
}

function failureKind(error: unknown, timedOut: boolean, signal: AbortSignal): JudgeFailureKind {
  if (signal.aborted) return "cancelled";
  if (timedOut) return "timeout";
  if (error instanceof ProviderError) {
    if (error.kind === "auth" || error.kind === "quota") return error.kind;
    if (error.status === 429) return "rate_limit";
    return error.kind === "transient" ? "transport" : "admission";
  }
  return "unknown";
}

/** Explicit run ownership replaces implicit host-object sharing; only validated terminal receipts cache. */
export function createJudgeCoordinator(bound: JudgeCoordinatorOptions): JudgeCoordinator {
  const options = { ...bound };
  const retirement = new AbortController();
  const signal =
    options.signal === undefined
      ? retirement.signal
      : AbortSignal.any([options.signal, retirement.signal]);
  const caches = {
    command: new Map<string, JudgeTerminalReceipt>(),
    effects: new Map<string, JudgeTerminalReceipt>(),
  };
  const inFlight = new Map<string, Promise<JudgeReviewOutcome<JudgeTerminalReceipt>>>();
  let closed = false;
  const key = (path: "command" | "effects", snapshot: JudgeJson, currentCase: JudgeJson): string =>
    canonicalJudgeJson({
      path,
      workRun: options.workExecutionId,
      snapshot,
      currentCase,
      model: options.model ?? null,
      ttl: options.promptCacheTtl,
      timeout: options.timeoutMs,
      retries: options.maxRetries,
      policy: JUDGE_POLICY,
    });
  async function review<T extends JudgeTerminalReceipt>(
    path: "command" | "effects",
    input: JudgeReviewCase,
    context: JudgeReviewContext<T>,
    binding: JudgeStepBinding,
  ): Promise<JudgeReviewOutcome<T>> {
    const cache = caches[path];
    const started = performance.now();
    const metrics = (attempts = 0, executionId?: string): Metrics => ({
      elapsedMs: Math.round(performance.now() - started),
      attempts,
      executionId,
      cacheHit: false,
    });
    if (closed || signal.aborted) return { ...metrics(), kind: "failed", failureKind: "cancelled" };
    if (!context.isCurrent()) return { ...metrics(), kind: "stale" };
    const snapshot = JSON.parse(canonicalJudgeJson(context.snapshot())) as JudgeJson;
    const currentCase = JSON.parse(canonicalJudgeJson(input.currentCase)) as JudgeJson;
    const identity = key(path, snapshot, currentCase);
    const stored = cache.get(identity);
    const cached = stored === undefined ? undefined : (structuredClone(stored) as T);
    if (cached !== undefined) {
      if (!context.validateReceipt(cached)) {
        cache.delete(identity);
        return { ...metrics(), kind: "failed", failureKind: "invalid_response" };
      }
      if (!context.isCurrent(cached)) {
        cache.delete(identity);
        return { ...metrics(), kind: "stale" };
      }
      if (closed || signal.aborted)
        return { ...metrics(), kind: "failed", failureKind: "cancelled" };
      return { ...metrics(), cacheHit: true, kind: "reviewed", receipt: structuredClone(cached) };
    }
    const existing = inFlight.get(identity);
    if (existing !== undefined) {
      const result = structuredClone(await existing) as JudgeReviewOutcome<T>;
      if (closed || signal.aborted)
        return { ...metrics(), kind: "failed", failureKind: "cancelled" };
      if (!context.isCurrent(result.kind === "reviewed" ? result.receipt : undefined))
        return { ...metrics(), kind: "stale" };
      if (result.kind === "reviewed" && !context.validateReceipt(result.receipt))
        return { ...metrics(), kind: "failed", failureKind: "invalid_response" };
      if (closed || signal.aborted)
        return { ...metrics(), kind: "failed", failureKind: "cancelled" };
      if (!context.isCurrent(result.kind === "reviewed" ? result.receipt : undefined))
        return { ...metrics(), kind: "stale" };
      return result;
    }
    const operation = (async (): Promise<JudgeReviewOutcome<T>> => {
      if (options.model === undefined)
        return { ...metrics(), kind: "failed", failureKind: "admission" };
      const executionId = crypto.randomUUID();
      const outcome = await executeJudge({
        owner: options.owner,
        executionId,
        observation: {
          path: path === "command" ? "call_local" : "effect_review",
          consumer: input.consumer ?? "command_guard",
          effectId: input.effectId,
        },
        sessionId: options.sessionId,
        executionBaseLlm: options.executionBaseLlm,
        promptCacheTtl: options.promptCacheTtl,
        model: options.model,
        providers: options.providers,
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries,
        signal,
        binding,
        validateReceipt: (receipt) =>
          !context.isCurrent(receipt as T) || context.validateReceipt(receipt as T),
        snapshot,
        currentCase,
        createServices: options.createServices,
      });
      const measured = metrics(outcome.attempts, executionId);
      if (closed || signal.aborted || outcome.response.status === "cancelled")
        return { ...measured, kind: "failed", failureKind: "cancelled" };
      if (!context.isCurrent(outcome.receipt as T | undefined))
        return { ...measured, kind: "stale" };
      if (outcome.providerFailure !== undefined || outcome.timedOut)
        return {
          ...measured,
          kind: "failed",
          failureKind: failureKind(outcome.providerFailure?.error, outcome.timedOut, signal),
        };
      if (outcome.invalidResponse)
        return { ...measured, kind: "failed", failureKind: "invalid_response" };
      if (outcome.response.status === "budget_exhausted")
        return { ...measured, kind: "failed", failureKind: "admission" };
      const receipt = outcome.receipt as T | undefined;
      if (receipt === undefined) throw new JudgeArchitectureError();
      if (!context.validateReceipt(receipt))
        return { ...measured, kind: "failed", failureKind: "invalid_response" };
      if (!context.isCurrent(outcome.receipt as T | undefined))
        return { ...measured, kind: "stale" };
      if (closed || signal.aborted)
        return { ...measured, kind: "failed", failureKind: "cancelled" };
      if (receipt.decision !== "unsure") {
        if (path === "effects" && cache.size >= 128) cache.clear();
        cache.set(key(path, context.snapshot(), currentCase), structuredClone(receipt));
      }
      return { ...measured, kind: "reviewed", receipt };
    })();
    inFlight.set(identity, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(identity) === operation) inFlight.delete(identity);
    }
  }
  return {
    reviewCommand: (input, context) => review("command", input, context, { kind: "command" }),
    reviewEffects: (input, context) => review("effects", input, context, context.binding),
    async close() {
      closed = true;
      retirement.abort();
      caches.command.clear();
      caches.effects.clear();
      await Promise.allSettled(inFlight.values());
      inFlight.clear();
    },
  };
}

export type { CompiledAuthorityTransition };
