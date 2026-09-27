import {
  Output,
  type GenerateTextEndEvent,
  type LanguageModelUsage,
  type ProviderMetadata,
  type streamText,
} from "ai";
import {
  ModelCallInactivityError,
  ProviderError,
  type AssistantTextPart,
  type LLMCallParams,
  type LLMCallResult,
  type Logger,
} from "@clarvis/capability";
import { modelCallTimeoutBridgeOf } from "../model-call-timeout-bridge.ts";
import type { StreamMetrics } from "../stream-metrics.ts";
import { toProviderError } from "./errors.ts";
import { buildCallResult, normalizeUsage } from "./result.ts";
import { makeDeltaBatcher, makeToolInputReporter } from "./streaming.ts";

/** Consume one SDK stream with call-local buffers, usage evidence and batcher cleanup. */
export async function runStreamCall(options: {
  params: LLMCallParams;
  callArgs: Parameters<typeof streamText>[0];
  stream: typeof streamText;
  markActivity(): void;
  timedOut(): boolean;
  timeoutMs?: number;
  logger: Logger;
  metrics?: Pick<StreamMetrics, "count">;
  now?: () => number;
}): Promise<LLMCallResult> {
  const { params, callArgs, stream, timeoutMs, logger, metrics } = options;
  const markActivity = (): void => options.markActivity();
  const timedOut = (): boolean => options.timedOut();
  const now = options.now ?? Date.now;
  let batcher: ReturnType<typeof makeDeltaBatcher> | undefined;
  let outputObserved = false;
  let partialUsage: LanguageModelUsage | undefined;
  try {
    let streamError: unknown;
    let aggregate: GenerateTextEndEvent | undefined;
    const streamedTextOrder: string[] = [];
    const streamedTextParts = new Map<
      string,
      { text: string; providerOptions?: ProviderMetadata }
    >();
    const retainTextPart = (id: string, text: string, providerOptions?: ProviderMetadata): void => {
      const current = streamedTextParts.get(id);
      if (current === undefined) streamedTextOrder.push(id);
      streamedTextParts.set(id, {
        text: `${current?.text ?? ""}${text}`,
        ...(providerOptions !== undefined
          ? { providerOptions }
          : current?.providerOptions !== undefined
            ? { providerOptions: current.providerOptions }
            : {}),
      });
    };
    const textOutput = Output.text();
    const nonRetainingTextOutput = {
      ...textOutput,
      parsePartialOutput: ({ text }: { text: string }) => Promise.resolve({ partial: text.length }),
    };
    const streamStartedAt = now();
    /**
     * Reports time-to-first-token exactly once per call.
     *
     * @remarks Called only from the `!outputObserved` arm of each part
     * branch, so the per-delta path costs one boolean test — the same test
     * that used to be an unconditional store. A `logger.debug` per delta is
     * forbidden outright: this loop runs thousands of times per call at
     * roughly a millisecond apart, and the bindings object would be
     * allocated before any backend saw the level. Per-chunk telemetry belongs
     * to the injected counter sink.
     */
    const firstOutput = (channel: string): void => {
      outputObserved = true;
      modelCallTimeoutBridgeOf(params)?.markStreamStarted();
      logger.debug(
        {
          event: "llm.stream.first_token",
          provider: params.provider,
          model: params.model,
          ttft_ms: now() - streamStartedAt,
          channel,
        },
        "the provider started emitting; the turn is now streaming to the user",
      );
    };
    const result = stream({
      ...callArgs,
      output: nonRetainingTextOutput,
      onError: ({ error }) => {
        markActivity();
        streamError ??= error;
      },
      onStepEnd: (step) => {
        markActivity();
        metrics?.count("sdk_step_end");
        partialUsage = step.usage;
      },
      onEnd: (event) => {
        markActivity();
        metrics?.count("sdk_on_end");
        aggregate = event;
        partialUsage = event.usage;
      },
    });

    batcher = makeDeltaBatcher(params.onStreamDelta ?? (() => undefined), undefined, metrics);
    const toolInput = params.onToolInputDelta
      ? makeToolInputReporter(params.onToolInputDelta, undefined, metrics)
      : undefined;
    for await (const part of result.stream) {
      markActivity();
      if (part.type === "text-start" || part.type === "text-end") {
        retainTextPart(part.id, "", part.providerMetadata);
      } else if (part.type === "text-delta") {
        retainTextPart(part.id, part.text, part.providerMetadata);
        if (!outputObserved) firstOutput("text");
        toolInput?.observe(part.text);
        batcher.push("text", part.text);
      } else if (part.type === "reasoning-delta") {
        if (!outputObserved) firstOutput("reasoning");
        toolInput?.observe(part.text);
        batcher.push("reasoning", part.text);
      } else if (part.type === "tool-input-start") {
        if (!outputObserved) firstOutput("tool_input");
        toolInput?.start(part.id, part.toolName);
      } else if (part.type === "tool-input-delta") {
        if (!outputObserved) firstOutput("tool_input");
        toolInput?.delta(part.id, part.delta);
      } else if (part.type === "tool-input-end") {
        if (!outputObserved) firstOutput("tool_input");
        toolInput?.end(part.id);
      } else if (part.type === "finish-step") {
        metrics?.count("provider_finish_step");
        partialUsage = part.usage;
      } else if (part.type === "finish") {
        metrics?.count("provider_finish");
        partialUsage = part.totalUsage;
      } else if (part.type === "tool-call" || part.type === "file" || part.type === "source") {
        metrics?.count(`provider_${part.type}`);
        if (!outputObserved) firstOutput(part.type === "tool-call" ? "tool_call" : part.type);
      } else if (part.type === "error") {
        metrics?.count("provider_error");
        streamError ??= part.error;
      }
    }
    metrics?.count("stream_drained");
    batcher.flush();

    if (streamError !== undefined) {
      const attemptCost = {
        streamStarted: outputObserved || batcher.emitted(),
        ...(partialUsage !== undefined ? { partialUsage: normalizeUsage(partialUsage) } : {}),
      };
      /**
       * Recognise the timeout before generic provider mapping so it keeps the
       * explicit inactivity subtype and the attempt evidence accumulated by
       * this stream. The outer catch repeats this for async throws that bypass
       * the structured stream-error part.
       */
      if (timeoutMs !== undefined && timedOut()) {
        throw new ModelCallInactivityError(
          timeoutMs,
          attemptCost.streamStarted,
          attemptCost.partialUsage,
        );
      }
      throw toProviderError(streamError, attemptCost, logger);
    }

    if (aggregate === undefined) {
      const streamStarted = outputObserved || batcher.emitted();
      const partial = partialUsage !== undefined ? normalizeUsage(partialUsage) : undefined;
      logger.warn(
        {
          event: "llm.stream.no_aggregate",
          model: params.model,
          stream_started: streamStarted,
          partial_output_tokens: partial?.output_tokens ?? 0,
        },
        "the provider stream ended with no final result; the attempt is retried as a transient failure",
      );
      throw new ProviderError("Provider stream ended without a final aggregate result.", {
        kind: "transient",
        streamStarted,
        ...(partial !== undefined ? { partialUsage: partial } : {}),
      });
    }
    const normalized = buildCallResult(aggregate);
    const retainedStreamTextParts: AssistantTextPart[] = streamedTextOrder.flatMap((id) => {
      const part = streamedTextParts.get(id);
      if (part === undefined || part.providerOptions === undefined || part.text.trim().length === 0)
        return [];
      const phaseValue = part.providerOptions.openai?.phase;
      return [
        {
          text: part.text,
          ...(phaseValue === "commentary" || phaseValue === "final_answer"
            ? { phase: phaseValue }
            : {}),
          providerOptions: part.providerOptions,
        },
      ];
    });
    const withRetainedText =
      normalized.textParts === undefined && retainedStreamTextParts.length > 0
        ? { ...normalized, textParts: retainedStreamTextParts }
        : normalized;
    return withRetainedText;
  } catch (err) {
    const attemptCost = {
      streamStarted: outputObserved || batcher?.emitted() === true,
      ...(partialUsage !== undefined ? { partialUsage: normalizeUsage(partialUsage) } : {}),
    };
    if (timeoutMs !== undefined && timedOut()) {
      throw new ModelCallInactivityError(
        timeoutMs,
        attemptCost.streamStarted,
        attemptCost.partialUsage,
      );
    }
    if (err instanceof ProviderError) throw err;
    throw toProviderError(err, attemptCost, logger);
  } finally {
    batcher?.dispose();
  }
}
