import { JudgeArchitectureError } from "./errors.ts";
import { ProviderError } from "@clarvis/capability";
import { executeRun, type ExecuteRunDeps } from "@clarvis/loop";
import type {
  LLMCallParams,
  LLMCallResult,
  LLMProvider,
  ProviderConfig,
  RunRequest,
} from "@clarvis/capability";
import { judgeStepSchema, type JudgeTerminalReceipt } from "./private-protocol.ts";
import { createJudgeRunCapability, JUDGE_CORRECTION_RETRIES } from "./run-capability.ts";
import { createJudgeOutputBudget } from "./execution-budget.ts";
import type { JudgeStepBinding } from "./step-machine.ts";
import { JUDGE_POLICY, judgeCacheBreakpoints, judgePrompt, type JudgeJson } from "./prompt.ts";

/** Only these host-owned services may enter the isolated child; controls and authority are absent. */
export type JudgeExecutionServices = Pick<
  ExecuteRunDeps,
  | "env"
  | "llm"
  | "connections"
  | "traceStore"
  | "workspaceRoot"
  | "logger"
  | "modelExecutionResolver"
  | "extensionAdmission"
>;

export interface JudgeCallObservation {
  path: "call_local" | "effect_review";
  consumer: "command_guard" | "configure_clarvis";
  effectId?: string;
}

export interface JudgeExecutionInput {
  observation?: JudgeCallObservation;
  owner: string;
  executionId: string;
  sessionId: string;
  executionBaseLlm: LLMProvider;
  promptCacheTtl: "5m" | "1h";
  model: string;
  providers: ProviderConfig[];
  timeoutMs: number;
  maxRetries: number;
  binding: JudgeStepBinding;
  validateReceipt?: (receipt: JudgeTerminalReceipt) => boolean;
  snapshot: JudgeJson;
  currentCase: JudgeJson;
  signal?: AbortSignal;
  callPurpose?: LLMCallParams["callPurpose"];
  createServices(input: {
    executionBaseLlm: LLMProvider;
    executionId: string;
    stage: () => "compile" | "decide";
    observation?: JudgeCallObservation;
    signal?: AbortSignal;
  }): JudgeExecutionServices;
}

/** Preserve accounting while routing invalid output through ordinary private tool-result recovery. */
function rejectedResponse(response: LLMCallResult): LLMCallResult {
  return {
    ...response,
    text: "",
    toolCalls: [{ id: `judge-invalid-${crypto.randomUUID()}`, name: "judge_step", arguments: {} }],
  };
}

/** Execute one noncontinuable review through the ordinary engine, with no inherited product controls. */
export async function executeJudge(input: JudgeExecutionInput) {
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 120_000 ||
    !Number.isInteger(input.maxRetries) ||
    input.maxRetries < 0 ||
    input.maxRetries > 2
  )
    throw new JudgeArchitectureError();
  const stages = input.binding.kind === "compile_effects" ? 2 : 1;
  const iterations = stages * (JUDGE_CORRECTION_RETRIES + 1);
  const cap = input.binding.kind === "command" ? 1024 : 2048;
  const privateRun = createJudgeRunCapability(
    input.binding,
    createJudgeOutputBudget(cap, input.maxRetries + 1, iterations),
    input.validateReceipt,
  );
  const services = input.createServices({
    executionBaseLlm: input.executionBaseLlm,
    executionId: input.executionId,
    observation: input.observation,
    signal: input.signal,
    stage: () => {
      const stage = privateRun.stage();
      if (stage === "compile") return "compile";
      if (stage === "command" || stage === "effects") return "decide";
      throw new JudgeArchitectureError();
    },
  });
  const prompt = judgePrompt(
    input.snapshot,
    input.binding.kind === "command"
      ? input.currentCase
      : {
          facts: input.currentCase,
          ...(input.binding.kind === "effects"
            ? { host_transition: input.binding.transition }
            : {}),
        },
  );
  let framingFailure: { error: unknown } | undefined;
  let timedOut = false;
  let attempts = 0;
  let providerFailure: { error: unknown } | undefined;
  const calledStages = new Map<string, number>();
  const llm: LLMProvider = {
    async call(params) {
      const stage = privateRun.stage();
      const stageCalls = calledStages.get(stage) ?? 0;
      if (
        providerFailure !== undefined ||
        framingFailure !== undefined ||
        stageCalls > JUDGE_CORRECTION_RETRIES
      ) {
        const error = new Error("Private Judge stage cannot repeat inference.");
        if (providerFailure === undefined) framingFailure = { error };
        throw error;
      }
      calledStages.set(stage, stageCalls + 1);
      let cacheBreakpoints: readonly number[];
      try {
        cacheBreakpoints = judgeCacheBreakpoints(params, prompt);
      } catch (error) {
        framingFailure = { error };
        throw error;
      }
      const deadline = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        deadline.abort();
      }, input.timeoutMs);
      const signal =
        params.signal === undefined
          ? deadline.signal
          : AbortSignal.any([params.signal, deadline.signal]);
      attempts++;
      try {
        const response = await services.llm.call({
          ...params,
          signal,
          cacheBreakpoints,
          timeoutMs: input.timeoutMs,
          maxOutputTokens: Math.min(params.maxOutputTokens ?? cap, cap),
          onRetry(event) {
            attempts++;
            params.onRetry?.(event);
          },
        });
        if (params.signal?.aborted) {
          privateRun.admitResponse(undefined);
          return rejectedResponse(response);
        }
        if (signal.aborted) {
          const usage = response.usage;
          const retried = response.retriedUsage;
          const failure = new ProviderError("Private Judge call cancelled or timed out.", {
            kind: "transient",
            streamStarted: true,
            partialUsage: {
              input_tokens: usage.input_tokens + (retried?.input_tokens ?? 0),
              output_tokens: usage.output_tokens + (retried?.output_tokens ?? 0),
              cached_tokens: usage.cached_tokens + (retried?.cached_tokens ?? 0),
              cache_write_tokens: usage.cache_write_tokens + (retried?.cache_write_tokens ?? 0),
              ...(usage.usage_unknown === true || retried?.usage_unknown === true
                ? { usage_unknown: true }
                : {}),
              ...(response.cacheUsageKnown === false ||
              usage.cache_unknown === true ||
              retried?.cache_unknown === true
                ? { cache_unknown: true }
                : {}),
            },
          });
          failure.accumulatedUsage = failure.partialUsage;
          throw failure;
        }
        return privateRun.admitResponse(response.toolCalls, response.text)
          ? response
          : rejectedResponse(response);
      } catch (error) {
        if (error instanceof JudgeArchitectureError) framingFailure = { error };
        else providerFailure = { error };
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  const request: RunRequest = {
    execution_id: input.executionId,
    session_id: input.sessionId,
    agent_instance_id: "judge",
    prompt_cache_ttl: input.promptCacheTtl,
    entry: "judge",
    shared_prompt: "",
    servers: [],
    providers: input.providers,
    guard_escalation: false,
    messages: prompt.messages.map((content) => ({ role: "user" as const, content })),
    profiles: [
      {
        name: "judge",
        model: input.model,
        base_prompt: JUDGE_POLICY,
        tools: [],
        grants: [],
        can_spawn: [],
        iteration_limit: iterations,
        reasoning_effort: "low",
        call_timeout_ms: input.timeoutMs,
        retry: { max_retries: input.maxRetries },
        compaction: { enabled: false },
      },
    ],
    budget: {
      on_exceed: "stop",
      total_token_limit: services.env.CLARVIS_TOKEN_CEILING,
      timeout_ms: Math.min(
        services.env.CLARVIS_TIMEOUT_CEILING_MS,
        iterations * input.timeoutMs + 1000,
      ),
    },
  };
  const outcome = await executeRun({
    owner: input.owner,
    rawBody: request,
    externalSignal: input.signal,
    callPurpose: input.callPurpose,
    deps: {
      env: services.env,
      llm,
      connections: services.connections,
      traceStore: services.traceStore,
      workspaceRoot: services.workspaceRoot,
      logger: services.logger,
      modelExecutionResolver: services.modelExecutionResolver,
      extensionAdmission: services.extensionAdmission,
      executionVisibility: "internal",
      includeEnvironmentPreamble: false,
      capabilities: [privateRun.capability],
    },
  });
  const fault = privateRun.hostFailure() ?? framingFailure;
  if (fault !== undefined) throw fault.error;
  let receipt: JudgeTerminalReceipt | undefined;
  if (outcome.response.status === "completed") {
    const parsed = judgeStepSchema.safeParse(outcome.response.result);
    if (!parsed.success || parsed.data.action === "compile_authority")
      throw new JudgeArchitectureError();
    receipt = parsed.data;
  }
  return {
    ...outcome,
    receipt,
    attempts,
    timedOut,
    providerFailure,
    invalidResponse: privateRun.invalidResponse(),
  };
}
