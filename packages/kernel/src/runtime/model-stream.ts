import type { LLMCallParams, LLMCallResult, LLMProvider } from "@clarvis/loop";
import { MAX_EXECUTION_QUEUE_FRAMES } from "./execution-rpc.ts";

/** Convert a callback provider to a bounded stream without waiting for its terminal result. */
export async function* streamHostModelCall(
  llm: LLMProvider,
  params: LLMCallParams,
  maxBufferedBytes: number,
): AsyncIterable<unknown> {
  const controller = new AbortController();
  const signal =
    params.signal === undefined
      ? controller.signal
      : AbortSignal.any([params.signal, controller.signal]);
  const queue: Array<{ event: unknown; bytes: number }> = [];
  let bufferedBytes = 0;
  let wake: (() => void) | undefined;
  let finished = false;
  let failure: unknown;
  let result: LLMCallResult | undefined;
  const notify = (): void => wake?.();
  signal.addEventListener("abort", notify);
  const call = Promise.resolve()
    .then(() => {
      signal.throwIfAborted();
      return llm.call({
        ...params,
        signal,
        onStreamDelta(delta) {
          if (signal.aborted) return;
          const event = { type: "stream", ...delta };
          const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
          if (
            queue.length >= MAX_EXECUTION_QUEUE_FRAMES ||
            bufferedBytes + bytes > maxBufferedBytes
          ) {
            failure = Object.assign(new Error("model stream exceeds the buffer bound"), {
              code: "resource_exhausted",
            });
            controller.abort(failure);
            return;
          }
          queue.push({ event, bytes });
          bufferedBytes += bytes;
          notify();
        },
      });
    })
    .then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        failure ??= error;
      },
    )
    .finally(() => {
      finished = true;
      notify();
    });
  try {
    while (true) {
      while (queue.length > 0) {
        const next = queue.shift()!;
        bufferedBytes -= next.bytes;
        yield next.event;
      }
      if (failure !== undefined)
        throw failure instanceof Error
          ? failure
          : new Error(typeof failure === "string" ? failure : "model provider failed", {
              cause: failure,
            });
      signal.throwIfAborted();
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    yield { type: "result", result };
  } finally {
    controller.abort(new Error("model stream closed"));
    signal.removeEventListener("abort", notify);
    void call.catch(() => undefined);
  }
}
