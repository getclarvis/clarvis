import type { CacheBudget } from "./limits.ts";
import {
  cacheHash,
  cacheIdentityFromKey,
  capturePrompt,
  firstPromptDivergence,
  type CapturedPrompt,
} from "./wire.ts";
import type { CacheCall, CachePurpose, CacheScenario, CacheUsage } from "./types.ts";

export interface CacheRecorderOptions {
  scenario: CacheScenario;
  trial: number;
  sdkVersion: string;
  requestedModel: string;
  effort: string | (() => string | undefined);
  leaderId: string;
  budget: CacheBudget;
  globalBudget: CacheBudget;
  /** Safe serialized hashes from the preceding process; no raw reasoning or credentials. */
  previousCalls?: readonly CacheCall[];
  phase(): string;
  base(): number;
  transition?(): string | undefined;
  purpose?(identity: { sessionId: string; agentInstanceId: string }): CachePurpose;
  executionId?(): string | undefined;
  completed?(call: CacheCall): void;
}

/** Inspect a bounded response stream without retaining text, credentials or opaque reasoning. */
async function responseEvidence(
  response: Response,
  streaming: boolean,
  signal: AbortSignal,
): Promise<{
  usage?: CacheUsage;
  model?: string;
  effort?: string;
  tools: CacheCall["toolCalls"];
  complete: boolean;
  diagnostic?: string;
}> {
  const reader = response.body?.getReader();
  const result: {
    usage?: CacheUsage;
    model?: string;
    effort?: string;
    tools: CacheCall["toolCalls"];
    complete: boolean;
    diagnostic?: string;
  } = { tools: [], complete: false };
  if (!reader) return result;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const decoder = new TextDecoder();
  let buffered = "";
  const toolIds = new Set<string>();
  function inspect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const data = value as Record<string, any>;
    const body = data.response ?? data;
    if (data.type === "response.completed" || body.status === "completed") result.complete = true;
    const usage = body.usage;
    if (
      usage &&
      Number.isSafeInteger(usage.input_tokens ?? usage.prompt_tokens) &&
      Number.isSafeInteger(usage.output_tokens ?? usage.completion_tokens)
    ) {
      const cached =
        usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens;
      if (Number.isSafeInteger(cached))
        result.usage = {
          input: usage.input_tokens ?? usage.prompt_tokens,
          cached,
          output: usage.output_tokens ?? usage.completion_tokens,
        };
    }
    if (typeof body.model === "string") result.model = body.model;
    if (typeof body.reasoning?.effort === "string") result.effort = body.reasoning.effort;
    const items = [
      ...(Array.isArray(body.output) ? body.output : []),
      ...(data.type === "response.output_item.done" ? [data.item] : []),
    ];
    for (const item of items)
      if (
        item?.type === "function_call" &&
        typeof item.call_id === "string" &&
        !toolIds.has(item.call_id)
      ) {
        toolIds.add(item.call_id);
        result.tools.push({
          name: item.name,
          callId: item.call_id,
          ...(typeof item.id === "string" ? { itemId: item.id } : {}),
        });
      }
  }
  const sse =
    streaming || response.headers.get("content-type")?.includes("text/event-stream") === true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > 8 * 1024 * 1024) throw new Error("cache_capture_response_limit");
      if (!sse) continue;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line.startsWith("data:") || line === "data: [DONE]") continue;
        try {
          inspect(JSON.parse(line.slice(5).trim()));
        } catch {
          /* A malformed provider event remains a provider failure. */
        }
      }
    }
    if (!sse && buffered.trim()) {
      inspect(JSON.parse(buffered));
      result.complete = true;
    }
    return result;
  } catch (error) {
    if (!result.complete)
      result.diagnostic = error instanceof Error ? error.name : "response_capture_failed";
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Wrap the final HTTP boundary used by the production kernel subscription adapter.
 * Authorization headers and response bodies are never written to the report. The
 * provider's stream is returned immediately while a bounded tee observes its usage.
 */
export function createCacheRecorder(
  fetcher: typeof globalThis.fetch,
  options: CacheRecorderOptions,
): { fetch: typeof globalThis.fetch; drain(): Promise<void>; calls: CacheCall[] } {
  const calls: CacheCall[] = [...(options.previousCalls ?? [])];
  const previous = new Map<
    string,
    { prompt: CapturedPrompt; iteration: number; attempt: number; base: number }
  >();
  const pending = new Set<Promise<void>>();
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (!url.pathname.endsWith("/responses") && !url.pathname.endsWith("/chat/completions"))
        return fetcher(input, init);
      const raw =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : "{}";
      const body = JSON.parse(raw) as Record<string, unknown>;
      const signal = AbortSignal.any([
        options.budget.signal,
        options.globalBudget.signal,
        ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
      ]);
      init = { ...init, signal };
      const prompt = capturePrompt(body);
      const identity = cacheIdentityFromKey(prompt.key);
      options.globalBudget.check();
      options.budget.check();
      options.globalBudget.admit();
      options.budget.admit();
      const purpose: CachePurpose =
        options.purpose?.(identity) ??
        (identity.agentInstanceId === options.leaderId ? "leader" : "child");
      const conversation = JSON.stringify([prompt.key, purpose]);
      const prior = previous.get(conversation);
      const restored =
        prior === undefined
          ? calls
              .filter((call) => call.keyHash === cacheHash(prompt.key) && call.purpose === purpose)
              .at(-1)
          : undefined;
      const sameRequest = prior && JSON.stringify(prior.prompt) === JSON.stringify(prompt);
      const iteration = sameRequest
        ? prior.iteration
        : (prior?.iteration ?? restored?.iteration ?? 0) + 1;
      const attempt = sameRequest ? prior.attempt + 1 : 1;
      const base = options.base();
      const compaction = prior !== undefined && prior.base !== base;
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      const affinity = headers.get("session-id") ?? headers.get("x-session-id");
      const transition = options.transition?.();
      const call: CacheCall = {
        scenario: options.scenario,
        trial: options.trial,
        ...identity,
        iteration,
        attempt,
        purpose,
        executionId: options.executionId?.(),
        phase: options.phase(),
        base,
        startedAt: Date.now(),
        endedAt: 0,
        requestedModel: options.requestedModel,
        serializedModel: typeof body.model === "string" ? body.model : undefined,
        endpoint: url.origin + url.pathname,
        requestedEffort: typeof options.effort === "function" ? options.effort() : options.effort,
        serializedEffort:
          typeof body.reasoning === "object" &&
          body.reasoning !== null &&
          "effort" in body.reasoning &&
          typeof body.reasoning.effort === "string"
            ? body.reasoning.effort
            : undefined,
        sdkVersion: options.sdkVersion,
        keyHash: cacheHash(prompt.key),
        ...(affinity === null ? {} : { sessionHeaderHash: cacheHash(affinity) }),
        instructionsHash: cacheHash(prompt.instructions),
        toolsHash: cacheHash(prompt.tools),
        parametersHash: cacheHash(prompt.parameters),
        itemHashes: prompt.items.map(cacheHash),
        itemMetadata: prompt.items.map((value, index) => {
          const item = value as Record<string, unknown>;
          return {
            index,
            type: typeof item.type === "string" ? item.type : undefined,
            id: typeof item.id === "string" ? item.id : undefined,
            callId: typeof item.call_id === "string" ? item.call_id : undefined,
            phase: typeof item.phase === "string" ? item.phase : undefined,
            ...(item.type === "reasoning"
              ? {
                  reasoningParts: Array.isArray(item.summary) ? item.summary.length : 0,
                  encrypted: typeof item.encrypted_content === "string",
                }
              : {}),
          };
        }),
        ...(prompt.items
          .slice(prior?.prompt.items.length ?? 0)
          .some((item) => JSON.stringify(item).includes("[runtime: tool result truncated"))
          ? { truncatedNewResult: true }
          : {}),
        ...(prior
          ? { divergence: firstPromptDivergence(prior.prompt, prompt) }
          : restored
            ? { divergence: restoredDivergence(restored, prompt) }
            : {}),
        ...(compaction ? { compaction: true } : {}),
        ...(transition ? { transition } : {}),
        status: "failed",
        toolCalls: [],
      };
      previous.set(conversation, { prompt, iteration, attempt, base });
      const finish = (): void => {
        call.endedAt = Date.now();
        calls.push(call);
        options.budget.record(call);
        options.globalBudget.record(call);
        options.completed?.(call);
      };
      let response: Response;
      try {
        response = await fetcher(input, init);
      } catch (error) {
        call.status = init?.signal?.aborted ? "cancelled" : "failed";
        call.diagnostic = error instanceof Error ? error.name : "transport_failure";
        finish();
        throw error;
      }
      const observed = responseEvidence(response.clone(), body.stream === true, signal)
        .then(
          (evidence) => {
            call.responseContentType = response.headers.get("content-type") ?? undefined;
            call.usage = evidence.usage;
            call.resolvedModel = evidence.model;
            call.effectiveEffort = evidence.effort;
            call.toolCalls = evidence.tools;
            call.status =
              response.ok && evidence.complete
                ? "completed"
                : signal.aborted
                  ? "cancelled"
                  : "failed";
            if (evidence.diagnostic) call.diagnostic = evidence.diagnostic;
            if (!response.ok) call.diagnostic = `http_${response.status}`;
          },
          () => {
            call.status = init?.signal?.aborted ? "cancelled" : "failed";
            call.diagnostic = "response_capture_incomplete";
          },
        )
        .finally(finish);
      pending.add(observed);
      observed.then(
        () => pending.delete(observed),
        () => pending.delete(observed),
      );
      return response;
    },
    { preconnect: fetcher.preconnect },
  );
  return {
    fetch,
    calls,
    async drain() {
      await Promise.all([...pending]);
    },
  };
}

/** Compare a restarted request against independently persisted wire hashes. */
function restoredDivergence(previous: CacheCall, current: CapturedPrompt): CacheCall["divergence"] {
  if (previous.instructionsHash !== cacheHash(current.instructions))
    return { surface: "instructions" };
  if (previous.toolsHash !== cacheHash(current.tools)) return { surface: "tools" };
  for (let item = 0; item < previous.itemHashes.length; item += 1) {
    if (previous.itemHashes[item] !== cacheHash(current.items[item]))
      return { surface: "history", item };
  }
  return undefined;
}
