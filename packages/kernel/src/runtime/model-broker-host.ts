import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createSemaphore,
  ProviderError,
  sanitizeErrorMessage,
  type LLMCallParams,
  type LLMCallResult,
  type LLMProvider,
  type ModelExecutionInfo,
  type ResolvedProviderConfig,
} from "@clarvis/capability";
import type { KernelServer, NotificationSender } from "../transport/server.ts";
import {
  assertModelJson,
  containerModelResultSchema,
  decodeContainerModelCall,
  MODEL_INPUT_BYTES,
  MODEL_QUEUE_BYTES,
  MODEL_QUEUE_EVENTS,
  modelBrokerError,
  type ContainerModelCall,
  type ContainerModelEvent,
} from "../hosting/container-model-contract.ts";
import { encodeRuntimeProviderError } from "./provider-error.ts";

/** Host-only policy, already resolved from host environment by composition. */
export interface ContainerModelBrokerOptions {
  readonly owner: string;
  readonly namespace: string;
  readonly modelCatalog: readonly ModelExecutionInfo[];
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly tokenCeiling: number;
  readonly hostMaxRetries: number;
  readonly maxResponseBytes: number;
  readonly maxRetryAfterMs?: number;
  /** Resolved host timeout ceiling, independent of the guest request. */
  readonly maxTimeoutMs: number;
  /** Resolved default, used when the request does not select a shorter timeout. */
  readonly defaultTimeoutMs: number;
  /** Called only after atomic admission. Resolve aliases/subscriptions here, never from guest config. */
  resolve(
    target: ModelExecutionInfo,
    attribution: Pick<ContainerModelCall, "runId" | "sessionId" | "agentInstanceId" | "purpose">,
  ): Promise<{ llm: LLMProvider; providerConfig: ResolvedProviderConfig }>;
  readonly now?: () => number;
}
/**
 * One immutable channel authority; closing its sole connection revokes it permanently.
 * Dispatched reservations remain charged until complete usage and a successful local
 * terminal write are observed. Unknown usage and failed/cancelled writes retain the
 * reservation. A write is not an acknowledgement of peer processing. No prompt or replay
 * result is retained; measured usage counts input/output, never cache subsets twice.
 */
export interface ContainerModelBroker extends KernelServer {
  readonly leaseId: string;
  readonly generation: string;
  readonly expiresAt: number;
  revoke(): void;
  revokePair(provider: string, model?: string): void;
  readonly accounting: {
    readonly chargedTokens: number;
    readonly debitedTokens: number;
    readonly retainedCalls: number;
    readonly admitted: number;
  };
}

/** Build a bounded model-only KernelServer for the existing stdio decoder, not a native domain bridge. */
export function createContainerModelBroker(
  options: ContainerModelBrokerOptions,
): ContainerModelBroker {
  options = { ...options };
  for (const value of [
    options.maxConcurrent,
    options.tokenCeiling,
    options.maxResponseBytes,
    options.maxTimeoutMs,
    options.defaultTimeoutMs,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw modelBrokerError("invalid_request");
  }
  for (const value of [options.maxQueued, options.hostMaxRetries, options.maxRetryAfterMs ?? 0]) {
    if (!Number.isSafeInteger(value) || value < 0) throw modelBrokerError("invalid_request");
  }
  if (options.defaultTimeoutMs > options.maxTimeoutMs) throw modelBrokerError("invalid_request");
  const key = (provider: string, model: string): string => JSON.stringify([provider, model]);
  const catalog = new Map<string, ModelExecutionInfo>();
  for (const target of options.modelCatalog) {
    if (
      !Number.isSafeInteger(target.contextWindowTokens) ||
      target.contextWindowTokens <= 0 ||
      (target.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(target.maxOutputTokens) || target.maxOutputTokens <= 0)) ||
      catalog.has(key(target.provider, target.model))
    )
      throw modelBrokerError("invalid_request");
    catalog.set(key(target.provider, target.model), structuredClone(target));
  }
  const now = options.now ?? Date.now;
  const leaseId = randomBytes(32).toString("hex");
  const generation = randomUUID();
  const expiresAt = now() + 24 * 60 * 60 * 1_000;
  const maxOutputBytes = Math.min(MODEL_INPUT_BYTES, options.maxResponseBytes);
  const permits = createSemaphore(options.maxConcurrent);
  const calls = new Map<
    string,
    {
      digest: string;
      state: "queued" | "active" | "complete" | "outcome_unknown" | "cancelled";
      releasable: number;
    }
  >();
  const live = new Map<AbortController, string>();
  let chargedTokens = 0;
  let debitedTokens = 0;
  let admitted = 0;
  let revoked = false;
  let connected = false;
  const revoke = (): void => {
    revoked = true;
    clearTimeout(expiry);
    for (const controller of live.keys()) controller.abort(modelBrokerError("unauthorized"));
  };
  const expiry = setTimeout(revoke, Math.max(0, expiresAt - now()));
  expiry.unref();
  const active = (): void => {
    if (now() >= expiresAt) revoke();
    if (revoked) throw modelBrokerError("unauthorized");
  };
  const execute = async (
    value: unknown,
    send: NotificationSender,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    active();
    const request = decodeContainerModelCall(value);
    if (request.leaseId !== leaseId || request.generation !== generation)
      throw modelBrokerError("unauthorized");
    const targetKey = key(request.provider, request.model);
    const target = catalog.get(targetKey);
    if (target === undefined) throw modelBrokerError("unauthorized");
    if (calls.has(request.callId)) throw modelBrokerError("conflict");
    const outputBound = Math.min(
      target.contextWindowTokens,
      target.maxOutputTokens ?? target.contextWindowTokens,
    );
    if ((request.input.maxOutputTokens ?? outputBound) > outputBound)
      throw modelBrokerError("invalid_request");
    const reserve = (target.contextWindowTokens + outputBound) * (1 + options.hostMaxRetries);
    if (
      !Number.isSafeInteger(reserve) ||
      chargedTokens + reserve > options.tokenCeiling ||
      calls.size >= 65_536 ||
      admitted >= options.maxConcurrent + options.maxQueued
    )
      throw modelBrokerError("resource_exhausted");
    if (signal?.aborted) throw modelBrokerError("cancelled");
    const state = {
      digest: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      state: "queued" as "queued" | "active" | "complete" | "outcome_unknown" | "cancelled",
      releasable: 0,
    };
    calls.set(request.callId, state);
    chargedTokens += reserve;
    admitted++;
    const controller = new AbortController();
    const abort = (): void => controller.abort(modelBrokerError("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    live.set(controller, targetKey);
    let acquired = false;
    let dispatched = false;
    let sequence = 0;
    let bufferedBytes = 0;
    let bufferedEvents = 0;
    let outputBytes = 0;
    let tail = Promise.resolve();
    let failure: unknown;
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () =>
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : modelBrokerError("cancelled"),
          ),
        {
          once: true,
        },
      );
    });
    void interrupted.catch(() => undefined);
    const enqueue = (event: ContainerModelEvent): void => {
      if (controller.signal.aborted) return;
      try {
        active();
        const delta = {
          callId: request.callId,
          sequence: sequence + 1,
          event: structuredClone(event),
        };
        const bytes = assertModelJson(delta, MODEL_QUEUE_BYTES);
        if (
          bufferedEvents >= MODEL_QUEUE_EVENTS ||
          bufferedBytes + bytes > MODEL_QUEUE_BYTES ||
          outputBytes + bytes > maxOutputBytes
        )
          throw modelBrokerError("resource_exhausted", true);
        sequence++;
        bufferedEvents++;
        bufferedBytes += bytes;
        outputBytes += bytes;
        tail = tail.then(async () => {
          controller.signal.throwIfAborted();
          await Promise.race([Promise.resolve(send("model.delta", delta)), interrupted]);
          bufferedEvents--;
          bufferedBytes -= bytes;
        });
        void tail.catch((error: unknown) => {
          failure ??= error;
          controller.abort(modelBrokerError("unavailable", true));
        });
      } catch (error) {
        failure ??= error;
        controller.abort(error);
      }
    };
    try {
      await permits.acquire(controller.signal);
      acquired = true;
      active();
      controller.signal.throwIfAborted();
      if (!catalog.has(targetKey)) throw modelBrokerError("unauthorized");
      const resolved = await Promise.race([
        options.resolve(structuredClone(target), {
          runId: request.runId,
          sessionId: request.sessionId,
          agentInstanceId: request.agentInstanceId,
          purpose: request.purpose,
        }),
        interrupted,
      ]);
      active();
      controller.signal.throwIfAborted();
      const input = request.input;
      const params: LLMCallParams = {
        provider: target.provider,
        model: target.model,
        providerConfig: resolved.providerConfig,
        capabilities: new Set(target.capabilities),
        callPurpose: request.purpose,
        sessionId: request.sessionId,
        agentInstanceId: request.agentInstanceId,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        signal: controller.signal,
        timeoutMs: Math.min(input.timeoutMs ?? options.defaultTimeoutMs, options.maxTimeoutMs),
        maxOutputTokens: input.maxOutputTokens ?? outputBound,
        reasoningSummary: input.reasoningSummary,
        reasoningEffort: input.reasoningEffort,
        promptCacheKey: input.promptCacheKey,
        promptCacheTtl: input.promptCacheTtl,
        cacheBreakpoints: input.cacheBreakpoints,
        maxRetries: Math.min(input.maxRetries ?? options.hostMaxRetries, options.hostMaxRetries),
        maxRetryAfterMs: Math.min(
          input.maxRetryAfterMs ?? options.maxRetryAfterMs ?? 60_000,
          options.maxRetryAfterMs ?? 60_000,
        ),
        onStreamDelta: (delta) => enqueue({ type: "stream", delta }),
        onToolInputDelta: (delta) => enqueue({ type: "tool_input", delta }),
        onRetry: (info) =>
          enqueue({
            type: "retry",
            info: { ...info, message: sanitizeErrorMessage(info.message).slice(0, 16_384) },
          }),
      };
      dispatched = true;
      state.state = "active";
      const result: LLMCallResult = await Promise.race([resolved.llm.call(params), interrupted]);
      if (failure !== undefined)
        throw failure instanceof Error ? failure : modelBrokerError("unavailable", true);
      await Promise.race([tail, interrupted]);
      active();
      controller.signal.throwIfAborted();
      const parsed = containerModelResultSchema.safeParse(result);
      if (!parsed.success) throw modelBrokerError("unavailable", true);
      const terminal = { callId: request.callId, lastSequence: sequence, result: parsed.data };
      if (assertModelJson(terminal, maxOutputBytes) + outputBytes > maxOutputBytes)
        throw modelBrokerError("resource_exhausted", true);
      const usage = parsed.data.usage;
      const retried = parsed.data.retriedUsage;
      const actual =
        usage.input_tokens +
        usage.output_tokens +
        (retried?.input_tokens ?? 0) +
        (retried?.output_tokens ?? 0);
      if (!Number.isSafeInteger(actual) || !Number.isSafeInteger(debitedTokens + actual)) {
        revoke();
        throw modelBrokerError("resource_exhausted", true);
      }
      debitedTokens += actual;
      chargedTokens += Math.max(0, actual - reserve);
      if (usage.usage_unknown === true || retried?.usage_unknown === true) {
        state.state = "outcome_unknown";
      } else {
        state.state = "complete";
        state.releasable = Math.max(0, reserve - actual);
      }
      return terminal;
    } catch (error) {
      state.state = dispatched ? "outcome_unknown" : "cancelled";
      if (!dispatched) chargedTokens -= reserve;
      if (error instanceof ProviderError) {
        const encoded = encodeRuntimeProviderError(error);
        const usage = encoded.provider.accumulatedUsage ?? encoded.provider.partialUsage;
        if (dispatched && usage !== undefined) {
          const actual = usage.input_tokens + usage.output_tokens;
          if (Number.isSafeInteger(actual) && Number.isSafeInteger(debitedTokens + actual)) {
            debitedTokens += actual;
            chargedTokens += Math.max(0, actual - reserve);
          } else revoke();
        }
        throw Object.assign(modelBrokerError("unavailable", dispatched), {
          message: encoded.message,
          details: { outcome_unknown: dispatched, provider: encoded.provider },
        });
      }
      if (
        failure !== undefined &&
        typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        failure.code === "resource_exhausted"
      )
        throw modelBrokerError("resource_exhausted", dispatched);
      if (
        error instanceof Error &&
        "code" in error &&
        ["unauthorized", "resource_exhausted", "cancelled"].includes(String(error.code))
      )
        throw modelBrokerError(
          error.code as "unauthorized" | "resource_exhausted" | "cancelled",
          dispatched,
        );
      throw modelBrokerError("unavailable", dispatched);
    } finally {
      controller.abort(modelBrokerError("cancelled"));
      signal?.removeEventListener("abort", abort);
      live.delete(controller);
      admitted--;
      if (acquired) permits.release();
    }
  };
  return {
    leaseId,
    generation,
    expiresAt,
    revoke,
    get accounting() {
      return { chargedTokens, debitedTokens, retainedCalls: calls.size, admitted };
    },
    revokePair(provider, model) {
      for (const [targetKey, target] of catalog) {
        if (target.provider !== provider || (model !== undefined && target.model !== model))
          continue;
        catalog.delete(targetKey);
        for (const [controller, pair] of live)
          if (pair === targetKey) controller.abort(modelBrokerError("unauthorized"));
      }
    },
    connect(send) {
      active();
      if (connected) throw modelBrokerError("conflict");
      connected = true;
      return {
        async handle(method, params, signal) {
          if (method !== "model.call") throw modelBrokerError("unauthorized");
          return execute(params, send, signal);
        },
        responseSent(method, result) {
          if (
            revoked ||
            method !== "model.call" ||
            typeof result !== "object" ||
            result === null ||
            !("callId" in result) ||
            typeof result.callId !== "string"
          )
            return;
          const state = calls.get(result.callId);
          if (state?.state !== "complete") return;
          chargedTokens -= state.releasable;
          state.releasable = 0;
        },
        close: revoke,
      };
    },
  };
}
