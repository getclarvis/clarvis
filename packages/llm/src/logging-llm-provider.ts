import type { Logger } from "@clarvis/capability";
import type { LLMCallParams, LLMCallResult, LLMProvider } from "@clarvis/capability";
import type { LiveMessage } from "@clarvis/capability";
import { levelEnabled } from "@clarvis/capability";

const PENDING_WARN_INTERVAL_MS = 20_000;
const SLOW_CALL_WARN_MS = 30_000;

/**
 * How many characters the transcript would flatten to, without flattening it.
 *
 * @param messages - the call's live conversation.
 * @returns the length `contentToText` would produce for every message, summed.
 * @remarks Byte-for-byte the old `contentToText(m.content).length`, computed
 *   from the part lengths instead: `contentToText` joins with a newline and
 *   renders a non-text part as `[type]`, so a separator per gap and
 *   `type.length + 2` per placeholder reproduce it exactly. The join is what
 *   made this expensive — it allocated a fresh string per multipart message
 *   purely to read its `length`.
 *
 *   Never call it outside a level guard. It is O(transcript) on every physical
 *   model attempt, and `@clarvis/code` runs its kernel at `silent`, so an
 *   unguarded call is a walk of the whole conversation for a record nothing
 *   will ever read.
 */
function approxInputChars(messages: LiveMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      total += content.length;
      continue;
    }
    for (let i = 0; i < content.length; i += 1) {
      const part = content[i]!;
      if (i > 0) total += 1;
      total += part.type === "text" ? part.text.length : part.type.length + 2;
    }
  }
  return total;
}

/**
 * Counts the physical attempts one logical call has made.
 *
 * @remarks Keyed on the params object because that is what identifies a logical
 *   call here: {@link withTransportRetry} sits *outside* this decorator and
 *   re-enters `inner.call(params)` with the very same object, so each attempt
 *   arrives as a distinct invocation of an indistinguishable call. Weak, so a
 *   finished call's entry dies with its params.
 */
const attemptsByParams = new WeakMap<LLMCallParams, number>();

/**
 * Wraps a provider with structured start/done/failure logging and slow/pending
 * warnings.
 *
 * @param inner - the provider to decorate.
 * @param logger - the sink for the debug/warn records.
 * @returns a provider that logs a `debug` at call start, warns every
 *   {@link PENDING_WARN_INTERVAL_MS} while a call is still in flight, and on
 *   completion logs `debug` (or `warn` past {@link SLOW_CALL_WARN_MS}) with
 *   duration/token/tool-call/text-length metadata; a thrown error is logged
 *   `warn` and re-thrown unchanged.
 * @remarks Purely observational — it never alters params, result, or error. The
 *   pending timer is `unref`'d so it cannot keep the process alive, and is not
 *   armed at all when the logger discards warnings.
 *
 *   Every field is either already in hand or computed behind a level guard.
 *   That is the whole point of the guards: a backend checks its level *inside*
 *   the call, long after the caller has built the bindings object, so a payload
 *   assembled eagerly is paid for even at `silent`.
 */
export function withCallLogging(inner: LLMProvider, logger: Logger): LLMProvider {
  return {
    async call(params: LLMCallParams): Promise<LLMCallResult> {
      const wantsDebug = levelEnabled(logger, "debug");
      const wantsWarn = levelEnabled(logger, "warn");
      const attempt = (attemptsByParams.get(params) ?? 0) + 1;
      attemptsByParams.set(params, attempt);

      const meta = {
        provider: params.provider,
        model: params.model,
        message_count: params.messages.length,
        tool_count: params.tools.length,
        attempt_of_call: attempt,
      };
      let inputChars: number | undefined;
      const chars = (): number => (inputChars ??= approxInputChars(params.messages));
      let streamStartedAt: number | undefined;
      let lastProgressAt: number | undefined;
      const markProgress = (): void => {
        const now = Date.now();
        streamStartedAt ??= now;
        lastProgressAt = now;
      };
      const observedParams: LLMCallParams = {
        ...params,
        ...(params.onStreamDelta !== undefined
          ? {
              onStreamDelta: (delta): void => {
                markProgress();
                params.onStreamDelta?.(delta);
              },
            }
          : {}),
        ...(params.onToolInputDelta !== undefined
          ? {
              onToolInputDelta: (delta): void => {
                markProgress();
                params.onToolInputDelta?.(delta);
              },
            }
          : {}),
      };

      const startedAt = Date.now();
      if (wantsDebug) {
        logger.debug(
          { event: "llm.call.start", ...meta, input_chars: chars() },
          "model call issued; the run is waiting on the provider",
        );
      }

      const pending = wantsWarn
        ? setInterval(() => {
            const now = Date.now();
            const streamStarted = streamStartedAt !== undefined;
            logger.warn(
              {
                event: "llm.call.pending",
                ...meta,
                input_chars: chars(),
                elapsed_ms: now - startedAt,
                stream_started: streamStarted,
                ...(lastProgressAt !== undefined ? { last_progress_ms: now - lastProgressAt } : {}),
              },
              streamStarted
                ? "the provider is still streaming; the run is waiting for the final result"
                : "the provider has not responded yet; the run stays blocked until it does",
            );
          }, PENDING_WARN_INTERVAL_MS)
        : undefined;
      pending?.unref?.();

      try {
        const result = await inner.call(observedParams);
        const duration_ms = Date.now() - startedAt;
        const slow = duration_ms >= SLOW_CALL_WARN_MS;
        if (slow ? wantsWarn : wantsDebug) {
          const done = {
            event: slow ? "llm.call.slow" : "llm.call.done",
            ...meta,
            input_chars: chars(),
            duration_ms,
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            cached_tokens: result.usage.cached_tokens,
            cache_write_tokens: result.usage.cache_write_tokens,
            tool_calls: result.toolCalls?.length ?? 0,
            text_len: result.text?.length ?? 0,
            reasoning_len: result.reasoning?.length ?? 0,
            finish_reason: result.finishReason,
          };
          if (slow) logger.warn(done, "the model call was slow; the turn is that much later");
          else logger.debug(done, "the model call returned; the run continues with its output");
        }
        return result;
      } catch (err) {
        if (wantsWarn) {
          logger.warn(
            {
              event: "llm.call.failed",
              ...meta,
              input_chars: chars(),
              duration_ms: Date.now() - startedAt,
              error: err instanceof Error ? err.message : String(err),
            },
            "the model call failed; retry policy decides whether the run continues",
          );
        }
        throw err;
      } finally {
        if (pending !== undefined) clearInterval(pending);
      }
    },
  };
}
