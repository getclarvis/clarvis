import { describe, it, expect, vi } from "../helpers/bun-test.ts";
import { withTransportRetry, backoffDelayMs } from "../../src/index.ts";
import { ModelCallInactivityError } from "../../src/model-call-timeout-bridge.ts";
import {
  ProviderError,
  type LLMCallParams,
  type LLMCallResult,
  type LLMProvider,
  type RetryInfo,
} from "@clarvis/capability";

const ok: LLMCallResult = {
  text: "ok",
  usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
};

function scripted(seq: Array<Error | LLMCallResult>): LLMProvider & { calls: number } {
  const p = {
    calls: 0,
    async call(): Promise<LLMCallResult> {
      const step = seq[p.calls];
      p.calls += 1;
      if (step instanceof Error) throw step;
      if (!step) throw new Error("scripted provider exhausted");
      return step;
    },
  };
  return p;
}

const params = (signal?: AbortSignal): LLMCallParams => ({
  model: "m",
  provider: "openai-compatible",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  ...(signal ? { signal } : {}),
});

const transient = (retryAfterMs?: number): ProviderError =>
  new ProviderError("overloaded", {
    kind: "transient",
    status: 503,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

const fastOpts = { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 };

describe("withTransportRetry", () => {
  it("does not retry a transient failure when maxRetries is 0", async () => {
    const inner = scripted([transient(), ok]);
    const wrapped = withTransportRetry(inner, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 });
    await expect(wrapped.call(params())).rejects.toThrow();
    expect(inner.calls).toBe(1);
  });

  it("promotes a no-retry failure's partial usage so the run is still billed for it", async () => {
    // With retries off the error goes straight back to the caller, and the
    // tokens the provider already burned before failing would otherwise never
    // reach the run's accounting.
    const partialUsage = {
      input_tokens: 7,
      output_tokens: 3,
      cached_tokens: 0,
      cache_write_tokens: 0,
    };
    const failed = new ProviderError("gave up mid-stream", { kind: "transient", partialUsage });
    const inner: LLMProvider = {
      call: () => Promise.reject(failed),
    };
    const wrapped = withTransportRetry(inner, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 });

    await expect(wrapped.call(params())).rejects.toBe(failed);
    expect(failed.accumulatedUsage).toEqual(partialUsage);
  });

  it("retries a transient failure then returns the success", async () => {
    const inner = scripted([transient(), ok]);
    const wrapped = withTransportRetry(inner, fastOpts);
    const res = await wrapped.call(params());
    expect(res.text).toBe("ok");
    expect(inner.calls).toBe(2);
  });

  it("does NOT retry client/auth/context_overflow", async () => {
    for (const kind of ["client", "auth", "context_overflow"] as const) {
      const err = new ProviderError(kind, { kind });
      const inner = scripted([err, ok]);
      const wrapped = withTransportRetry(inner, fastOpts);
      await expect(wrapped.call(params())).rejects.toBe(err);
      expect(inner.calls).toBe(1);
    }
  });

  it("does NOT retry a non-ProviderError throw", async () => {
    const err = new Error("boom");
    const inner = scripted([err, ok]);
    const wrapped = withTransportRetry(inner, fastOpts);
    await expect(wrapped.call(params())).rejects.toBe(err);
    expect(inner.calls).toBe(1);
  });

  it("makes exactly 1 + maxRetries attempts on an always-transient provider", async () => {
    const inner = scripted([transient(), transient(), transient(), transient(), transient()]);
    const wrapped = withTransportRetry(inner, { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 });
    await expect(wrapped.call(params())).rejects.toBeInstanceOf(ProviderError);
    expect(inner.calls).toBe(4);
  });

  it("does not retry when Retry-After exceeds the ceiling; surfaces with retry_after_ms", async () => {
    const inner = scripted([transient(120000), ok]);
    const wrapped = withTransportRetry(inner, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 30000,
      maxRetryAfterMs: 60000,
    });
    const err = await wrapped.call(params()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryAfterMs).toBe(120000);
    expect(inner.calls).toBe(1);
  });

  it("stops backing off and surfaces the failure when the signal aborts an armed sleep", async () => {
    const inner = scripted([transient(10000), ok]);
    const wrapped = withTransportRetry(inner, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10000 });
    const controller = new AbortController();
    let retryCommitted = (): void => {};
    const committed = new Promise<void>((resolve) => (retryCommitted = resolve));
    const pending = wrapped.call({
      ...params(controller.signal),
      onRetry: () => retryCommitted(),
    });
    await committed;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ProviderError);
    expect(inner.calls).toBe(1);
  });

  it("completes an armed backoff on a deterministic fake clock", async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const inner = scripted([transient(25), ok]);
      const wrapped = withTransportRetry(inner, {
        maxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 25,
      });
      const controller = new AbortController();
      let retryCommitted = (): void => {};
      const committed = new Promise<void>((resolve) => (retryCommitted = resolve));
      const pending = wrapped.call({
        ...params(controller.signal),
        onRetry: () => retryCommitted(),
      });

      await committed;
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toEqual(ok);
      expect(inner.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry when the signal is already aborted", async () => {
    const inner = scripted([transient(), ok]);
    const wrapped = withTransportRetry(inner, fastOpts);
    const controller = new AbortController();
    controller.abort();
    await expect(wrapped.call(params(controller.signal))).rejects.toBeInstanceOf(ProviderError);
    expect(inner.calls).toBe(1);
  });
});

describe("withTransportRetry — onRetry activity hook", () => {
  it("fires onRetry exactly once when a single transient is retried into success", async () => {
    let pokes = 0;
    const inner = scripted([transient(), ok]);
    const wrapped = withTransportRetry(inner, fastOpts);
    await wrapped.call({ ...params(), onRetry: () => void (pokes += 1) });
    expect(inner.calls).toBe(2);
    expect(pokes).toBe(1);
  });

  it("fires onRetry once per retry — maxRetries times when the provider stays transient", async () => {
    let pokes = 0;
    const inner = scripted([transient(), transient(), transient(), transient()]);
    const wrapped = withTransportRetry(inner, { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 });
    await expect(
      wrapped.call({ ...params(), onRetry: () => void (pokes += 1) }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(inner.calls).toBe(4);
    expect(pokes).toBe(3);
  });

  it("never fires onRetry when maxRetries is 0 (no retry loop is entered)", async () => {
    let pokes = 0;
    const inner = scripted([transient(), ok]);
    const wrapped = withTransportRetry(inner, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 });
    await expect(
      wrapped.call({ ...params(), onRetry: () => void (pokes += 1) }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(pokes).toBe(0);
  });

  it("never fires onRetry for a non-transient failure", async () => {
    let pokes = 0;
    const err = new ProviderError("bad request", { kind: "client" });
    const inner = scripted([err, ok]);
    const wrapped = withTransportRetry(inner, fastOpts);
    await expect(wrapped.call({ ...params(), onRetry: () => void (pokes += 1) })).rejects.toBe(err);
    expect(pokes).toBe(0);
  });

  it("never fires onRetry when the signal is already aborted", async () => {
    let pokes = 0;
    const inner = scripted([transient(), ok]);
    const wrapped = withTransportRetry(inner, fastOpts);
    const controller = new AbortController();
    controller.abort();
    await expect(
      wrapped.call({ ...params(controller.signal), onRetry: () => void (pokes += 1) }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(pokes).toBe(0);
  });

  it("never fires onRetry when Retry-After exceeds the ceiling (the retry is refused)", async () => {
    let pokes = 0;
    const inner = scripted([transient(120000), ok]);
    const wrapped = withTransportRetry(inner, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 30000,
      maxRetryAfterMs: 60000,
    });
    await expect(
      wrapped.call({ ...params(), onRetry: () => void (pokes += 1) }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(pokes).toBe(0);
  });

  it("fires onRetry at retry commit before observing an abort", async () => {
    let pokes = 0;
    const inner = scripted([transient(10000), ok]);
    const wrapped = withTransportRetry(inner, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10000 });
    const controller = new AbortController();
    await expect(
      wrapped.call({
        ...params(controller.signal),
        onRetry: () => {
          pokes += 1;
          controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(inner.calls).toBe(1);
    expect(pokes).toBe(1);
  });
});

describe("withTransportRetry — signal trips before the backoff sleep starts", () => {
  it("surfaces the failure without retrying when the signal aborts during backoff computation", async () => {
    const inner = scripted([
      new ProviderError("overloaded", { kind: "transient", status: 503 }),
      ok,
    ]);
    const controller = new AbortController();
    const wrapped = withTransportRetry(inner, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 });
    const originalRandom = Math.random;
    Math.random = (): number => {
      controller.abort();
      return 0.5;
    };
    try {
      await expect(wrapped.call(params(controller.signal))).rejects.toBeInstanceOf(ProviderError);
    } finally {
      Math.random = originalRandom;
    }
    expect(inner.calls).toBe(1);
  });
});

describe("backoffDelayMs", () => {
  it("never exceeds maxDelayMs even at maximum jitter", () => {
    const maxDelayMs = 1000;
    for (let n = 1; n <= 10; n += 1) {
      for (const r of [0, 0.5, 0.9999]) {
        const orig = Math.random;
        Math.random = () => r;
        try {
          const d = backoffDelayMs(n, undefined, 500, maxDelayMs);
          expect(d).toBeLessThanOrEqual(maxDelayMs);
        } finally {
          Math.random = orig;
        }
      }
    }
  });

  it("caps a Retry-After hint at maxDelayMs by default", () => {
    expect(backoffDelayMs(1, 9999, 1, 100)).toBe(100);
    expect(backoffDelayMs(1, 30, 1, 100)).toBe(30);
  });

  it("honors a Retry-After above maxDelayMs up to an explicit ceiling", () => {
    expect(backoffDelayMs(1, 45000, 1, 30000, 60000)).toBe(45000);
    expect(backoffDelayMs(1, 90000, 1, 30000, 60000)).toBe(60000);
  });
});

describe("withTransportRetry — the RetryInfo payload", () => {
  it("reports attempt, cap, delay and classification for each retry", async () => {
    const seen: RetryInfo[] = [];
    const inner = scripted([transient(), transient(), ok]);
    const wrapped = withTransportRetry(inner, fastOpts);

    await wrapped.call({ ...params(), onRetry: (info) => void seen.push(info) });

    expect(seen).toHaveLength(2);
    expect(seen.map((i) => i.attempt)).toEqual([1, 2]);
    for (const info of seen) {
      expect(info.maxRetries).toBe(3);
      expect(info.kind).toBe("transient");
      expect(info.message).toBe("overloaded");
      expect(info.status).toBe(503);
      expect(info.delayMs).toBe(0);
      expect(info.retryAfterMs).toBeUndefined();
    }
  });

  /**
   * `delayMs` has to be the delay actually slept. The hook used to fire before
   * `backoffDelayMs` ran, so anything reporting a wait would have been inventing
   * the number it displayed.
   */
  it("reports the server-advised delay it is actually about to sleep", async () => {
    const seen: RetryInfo[] = [];
    const inner = scripted([transient(0), ok]);
    const wrapped = withTransportRetry(inner, fastOpts);

    await wrapped.call({ ...params(), onRetry: (info) => void seen.push(info) });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.retryAfterMs).toBe(0);
    expect(seen[0]!.delayMs).toBe(0);
  });

  it("reports the per-call maxRetries override, not the wrapper default", async () => {
    const seen: RetryInfo[] = [];
    const inner = scripted([transient(), ok]);
    const wrapped = withTransportRetry(inner, fastOpts);

    await wrapped.call({ ...params(), maxRetries: 1, onRetry: (info) => void seen.push(info) });

    expect(seen[0]!.maxRetries).toBe(1);
  });
});

/**
 * `isTransient` gates on `kind === "transient"`, so splitting quota and content
 * policy out of `"client"` made them non-retryable by construction rather than
 * by a rule anyone has to remember. These pin that, because the property is
 * invisible at the call site.
 */
describe("withTransportRetry — the non-retryable kinds", () => {
  for (const kind of ["quota", "content_policy", "auth", "client", "context_overflow"] as const) {
    it(`never retries a ${kind} failure`, async () => {
      const err = new ProviderError(kind, { kind, status: 429 });
      const inner = scripted([err, ok]);
      const wrapped = withTransportRetry(inner, fastOpts);
      let retries = 0;

      await expect(wrapped.call({ ...params(), onRetry: () => void (retries += 1) })).rejects.toBe(
        err,
      );
      expect(inner.calls).toBe(1);
      expect(retries).toBe(0);
    });
  }
});

const withUsage = (
  partial: { input_tokens: number; output_tokens: number },
  init: { streamStarted?: boolean } = {},
): ProviderError =>
  new ProviderError("overloaded", {
    kind: "transient",
    status: 503,
    partialUsage: { ...partial, cached_tokens: 0, cache_write_tokens: 0 },
    ...init,
  });

describe("withTransportRetry — accounting for failed attempts", () => {
  it("accumulates each failed attempt's usage onto the eventual success", async () => {
    const inner = scripted([
      withUsage({ input_tokens: 100, output_tokens: 5 }),
      withUsage({ input_tokens: 100, output_tokens: 7 }),
      ok,
    ]);
    const wrapped = withTransportRetry(inner, fastOpts);

    const res = await wrapped.call(params());

    expect(res.usage.input_tokens).toBe(1);
    expect(res.retriedUsage).toEqual({
      input_tokens: 200,
      output_tokens: 12,
      cached_tokens: 0,
      cache_write_tokens: 0,
    });
  });

  it("omits retriedUsage when nothing was retried", async () => {
    const wrapped = withTransportRetry(scripted([ok]), fastOpts);
    expect((await wrapped.call(params())).retriedUsage).toBeUndefined();
  });

  /**
   * A missing number and a known zero must stay distinguishable: treating
   * "could not read" as "cost nothing" under-counts the ledger silently.
   */
  it("leaves retriedUsage absent when no failed attempt reported usage", async () => {
    const wrapped = withTransportRetry(scripted([transient(), ok]), fastOpts);
    expect((await wrapped.call(params())).retriedUsage).toBeUndefined();
  });

  it("attaches accumulatedUsage to the error when the retries never recover", async () => {
    const inner = scripted([
      withUsage({ input_tokens: 80, output_tokens: 1 }),
      withUsage({ input_tokens: 80, output_tokens: 1 }),
      withUsage({ input_tokens: 80, output_tokens: 1 }),
      withUsage({ input_tokens: 80, output_tokens: 1 }),
    ]);
    const wrapped = withTransportRetry(inner, fastOpts);

    const err = (await wrapped.call(params()).catch((e: unknown) => e)) as ProviderError;
    expect(err.accumulatedUsage?.input_tokens).toBe(320);
  });
});

/**
 * POLICY: ordinary provider failures are not retried once the stream has emitted
 * a delta to a consumer. The model-call inactivity timeout is the deliberate
 * exception: its job is to recover an attempt that stopped making progress.
 *
 * The prompt has already been billed in full at that point, and a retry
 * re-sends and re-bills all of it — at a large context, the dominant cost of
 * the turn. The trade accepted here is a truncated turn (which the loop already
 * handles as a model-call error) in exchange for predictable spend. Changing
 * this is a deliberate product decision, not a refactor.
 */
describe("withTransportRetry — POLICY: no retry after a consumer observed the stream", () => {
  it("refuses to retry a transient failure that already emitted output", async () => {
    const err = withUsage({ input_tokens: 500, output_tokens: 200 }, { streamStarted: true });
    const inner = scripted([err, ok]);
    const wrapped = withTransportRetry(inner, fastOpts);
    let retries = 0;

    await expect(
      wrapped.call({
        ...params(),
        onStreamDelta: () => {},
        onRetry: () => void (retries += 1),
      }),
    ).rejects.toBe(err);
    expect(inner.calls).toBe(1);
    expect(retries).toBe(0);
    expect(err.accumulatedUsage?.input_tokens).toBe(500);
  });

  it("retries an internal stream that no consumer observed", async () => {
    const failed = withUsage({ input_tokens: 500, output_tokens: 200 }, { streamStarted: true });
    const inner = scripted([failed, ok]);
    const wrapped = withTransportRetry(inner, fastOpts);

    const res = await wrapped.call(params());
    expect(inner.calls).toBe(2);
    expect(res.retriedUsage?.input_tokens).toBe(500);
  });

  it("does not retry after a tool-input consumer observed the stream", async () => {
    const failed = withUsage({ input_tokens: 500, output_tokens: 20 }, { streamStarted: true });
    const inner = scripted([failed, ok]);
    const wrapped = withTransportRetry(inner, fastOpts);

    await expect(wrapped.call({ ...params(), onToolInputDelta: () => {} })).rejects.toBe(failed);
    expect(inner.calls).toBe(1);
  });

  it("retries an explicit inactivity timeout after tool-input progress stopped", async () => {
    const timedOut = new ModelCallInactivityError(180_000, true);
    const inner = scripted([timedOut, ok]);
    const wrapped = withTransportRetry(inner, fastOpts);

    await expect(wrapped.call({ ...params(), onToolInputDelta: () => {} })).resolves.toMatchObject({
      text: "ok",
    });
    expect(inner.calls).toBe(2);
  });

  it("still retries a transient failure that emitted nothing", async () => {
    const inner = scripted([
      withUsage({ input_tokens: 500, output_tokens: 0 }, { streamStarted: false }),
      ok,
    ]);
    const wrapped = withTransportRetry(inner, fastOpts);

    const res = await wrapped.call(params());
    expect(inner.calls).toBe(2);
    expect(res.retriedUsage?.input_tokens).toBe(500);
  });
});
