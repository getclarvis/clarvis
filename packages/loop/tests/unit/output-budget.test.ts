import { describe, expect, test } from "bun:test";
import {
  ProviderError,
  type LLMCallParams,
  type LLMProvider,
  type OutputTokenBudget,
  type OutputTokenReservation,
} from "@clarvis/capability";
import {
  OutputBudgetExhaustedError,
  withOutputTokenBudget,
} from "../../src/runtime/loop/output-budget.ts";

function budget(total: number): OutputTokenBudget & { spent(): number } {
  let spent = 0;
  let held = 0;
  return {
    spent: () => spent,
    remaining: () => Math.max(0, total - spent - held),
    reserveOutput(requested): OutputTokenReservation | null {
      const amount = Math.min(requested, total - spent - held);
      if (amount < 1) return null;
      held += amount;
      let closed = false;
      return {
        amount,
        settle(used): void {
          if (closed) return;
          closed = true;
          held -= amount;
          spent += Math.min(amount, used);
        },
        release(): void {
          if (closed) return;
          closed = true;
          held -= amount;
        },
      };
    },
  };
}

const params = (over: Partial<LLMCallParams> = {}): LLMCallParams => ({
  model: "model",
  provider: "provider",
  messages: [],
  tools: [],
  ...over,
});

describe("withOutputTokenBudget", () => {
  test("accounts successful output against an unbounded shared budget", async () => {
    const ceiling = budget(Number.POSITIVE_INFINITY);
    const guarded = withOutputTokenBudget(
      {
        call: async () => ({
          usage: { input_tokens: 0, output_tokens: 4, cached_tokens: 0, cache_write_tokens: 0 },
          retriedUsage: {
            input_tokens: 0,
            output_tokens: 2,
            cached_tokens: 0,
            cache_write_tokens: 0,
          },
        }),
      },
      ceiling,
    );

    await guarded.call(params());
    expect(ceiling.spent()).toBe(6);
  });

  test("accounts known failed output and preserves unknown failures with an unbounded budget", async () => {
    const measured = budget(Number.POSITIVE_INFINITY);
    const failure = new ProviderError("stream failed");
    failure.accumulatedUsage = {
      input_tokens: 0,
      output_tokens: 3,
      cached_tokens: 0,
      cache_write_tokens: 0,
    };
    await expect(
      withOutputTokenBudget({ call: () => Promise.reject(failure) }, measured).call(params()),
    ).rejects.toBe(failure);
    expect(measured.spent()).toBe(3);

    const unknown = budget(Number.POSITIVE_INFINITY);
    const transport = new Error("transport failed");
    await expect(
      withOutputTokenBudget({ call: () => Promise.reject(transport) }, unknown).call(params()),
    ).rejects.toBe(transport);
    expect(unknown.spent()).toBe(0);
  });

  test("reserves every retry attempt, caps each one, and settles aggregate output", async () => {
    const calls: LLMCallParams[] = [];
    const llm: LLMProvider = {
      call(call) {
        calls.push(call);
        return Promise.resolve({
          usage: { input_tokens: 1, output_tokens: 7, cached_tokens: 0, cache_write_tokens: 0 },
          retriedUsage: {
            input_tokens: 1,
            output_tokens: 3,
            cached_tokens: 0,
            cache_write_tokens: 0,
          },
        });
      },
    };
    const ceiling = budget(30);

    await withOutputTokenBudget(llm, ceiling).call(params({ maxOutputTokens: 10, maxRetries: 2 }));

    expect(calls[0]?.maxOutputTokens).toBe(10);
    expect(calls[0]?.maxRetries).toBe(2);
    expect(ceiling.spent()).toBe(10);
    expect(ceiling.remaining()).toBe(20);
  });

  test("reduces hidden/default retries when the remaining ceiling is tiny", async () => {
    const calls: LLMCallParams[] = [];
    const ceiling = budget(2);
    const llm: LLMProvider = {
      call(call) {
        calls.push(call);
        return Promise.resolve({
          usage: { input_tokens: 0, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
        });
      },
    };

    await withOutputTokenBudget(llm, ceiling).call(params({ maxOutputTokens: 100, maxRetries: 5 }));

    expect(calls[0]?.maxOutputTokens).toBe(1);
    expect(calls[0]?.maxRetries).toBe(1);
    expect(ceiling.spent()).toBe(1);
  });

  test("attributes failed streamed output and rejects a later call before the provider", async () => {
    let calls = 0;
    const llm: LLMProvider = {
      call() {
        calls += 1;
        throw new ProviderError("stream failed", {
          partialUsage: {
            input_tokens: 0,
            output_tokens: 2,
            cached_tokens: 0,
            cache_write_tokens: 0,
          },
        });
      },
    };
    const ceiling = budget(2);
    const guarded = withOutputTokenBudget(llm, ceiling);

    await expect(guarded.call(params({ maxOutputTokens: 2 }))).rejects.toBeInstanceOf(
      ProviderError,
    );
    await expect(guarded.call(params())).rejects.toBeInstanceOf(OutputBudgetExhaustedError);
    expect(calls).toBe(1);
    expect(ceiling.spent()).toBe(2);
  });

  test("charges the full reservation when a failed call has no trustworthy usage", async () => {
    let calls = 0;
    const guarded = withOutputTokenBudget(
      {
        call() {
          calls += 1;
          throw new Error("transport closed after dispatch");
        },
      },
      budget(4),
    );

    await expect(guarded.call(params({ maxOutputTokens: 4, maxRetries: 0 }))).rejects.toThrow(
      "transport closed",
    );
    await expect(guarded.call(params())).rejects.toBeInstanceOf(OutputBudgetExhaustedError);
    expect(calls).toBe(1);
  });

  test("releases a pre-generation context-overflow reservation for the recovery call", async () => {
    let calls = 0;
    const ceiling = budget(4);
    const guarded = withOutputTokenBudget(
      {
        call() {
          calls += 1;
          if (calls === 1) {
            throw new ProviderError("context too large", { kind: "context_overflow" });
          }
          return Promise.resolve({
            usage: { input_tokens: 1, output_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
          });
        },
      },
      ceiling,
    );

    await expect(guarded.call(params({ maxOutputTokens: 4 }))).rejects.toMatchObject({
      kind: "context_overflow",
    });
    expect(ceiling.remaining()).toBe(4);
    await guarded.call(params({ maxOutputTokens: 4 }));
    expect(calls).toBe(2);
    expect(ceiling.spent()).toBe(2);
  });

  test("releases any provider failure that never started streaming, forced tool or not", async () => {
    const clientError = new ProviderError("forced tool rejected", { kind: "client" });
    const rejecting: LLMProvider = { call: () => Promise.reject(clientError) };

    const forced = budget(3);
    await expect(
      withOutputTokenBudget(rejecting, forced).call(
        params({
          maxOutputTokens: 3,
          toolChoice: { type: "function", function: { name: "done" } },
        }),
      ),
    ).rejects.toBe(clientError);
    expect(forced.remaining()).toBe(3);

    /* Previously charged in full, purely because `client`-without-a-forced-tool
       was not on the two-item allowlist. Nothing streamed, so nothing was
       billable, so there is nothing to charge. */
    const unforced = budget(3);
    await expect(
      withOutputTokenBudget(rejecting, unforced).call(params({ maxOutputTokens: 3 })),
    ).rejects.toBe(clientError);
    expect(unforced.remaining()).toBe(3);
  });

  test("still charges the whole reservation once output had begun streaming", async () => {
    const ceiling = budget(3);
    const lost = new ProviderError("connection dropped mid-stream", {
      kind: "transient",
      streamStarted: true,
    });
    await expect(
      withOutputTokenBudget({ call: () => Promise.reject(lost) }, ceiling).call(
        params({ maxOutputTokens: 3 }),
      ),
    ).rejects.toBe(lost);
    expect(ceiling.remaining()).toBe(0);
  });

  /**
   * The defect this pins, with the numbers it was measured at. A workflow tree
   * shares one ceiling across the manager and every leader, and the reservation
   * covers `maxOutputTokens x attempts` clamped to whatever is left — so the
   * first call of any agent reserves nearly all of it. Charging that in full for
   * a rate limit took the whole tree budget out in one call, and every agent
   * spawned afterwards died at its pre-iteration budget check.
   */
  test("a rate limit does not consume a shared tree ceiling", async () => {
    const tree = budget(262_144);
    const rateLimited = new ProviderError("429 rate limit", { kind: "transient", status: 429 });

    await expect(
      withOutputTokenBudget({ call: () => Promise.reject(rateLimited) }, tree).call(
        params({ maxOutputTokens: 128_000, maxRetries: 3 }),
      ),
    ).rejects.toBe(rateLimited);

    expect(tree.spent()).toBe(0);
    expect(tree.remaining()).toBe(262_144);
  });
});
