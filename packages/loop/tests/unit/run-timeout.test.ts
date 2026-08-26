import { describe, expect, it } from "../bun-test.ts";
import { runWithClockAndTimeout } from "../../src/runtime/run-timeout.ts";
import type { Usage } from "@clarvis/capability";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const usage: Usage = { iterations_used: 0, elapsed_ms: 0, by_agent: [] };

describe("run timeout teardown", () => {
  it("releases the outer run after the grace when teardown ignores abort", async () => {
    const cleanup = deferred<string>();
    const aborted = deferred<void>();
    const pending = runWithClockAndTimeout({
      config: { timeout_ms: 1, max_tokens: 1 },
      settleGraceMs: 1,
      startedAt: performance.now(),
      clockHolder: {},
      finalize: () => usage,
      buildLoop: ({ signal }) => {
        signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        return cleanup.promise;
      },
      toResponse: () => ({ status: "completed", result: "unexpected", usage }),
    });

    await aborted.promise;
    await expect(pending).resolves.toMatchObject({
      status: "error",
      error: { code: "timeout" },
    });
    cleanup.resolve("late teardown complete");
  });

  it("does not let a non-cooperative loop pin external cancellation", async () => {
    const cleanup = deferred<string>();
    const controller = new AbortController();
    const pending = runWithClockAndTimeout({
      config: { timeout_ms: 10_000, max_tokens: 1 },
      settleGraceMs: 1,
      externalSignal: controller.signal,
      startedAt: performance.now(),
      clockHolder: {},
      finalize: () => usage,
      buildLoop: () => cleanup.promise,
      toResponse: () => ({ status: "completed", result: "unexpected", usage }),
    });

    controller.abort(new Error("cancelled by test"));
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    cleanup.resolve("late teardown complete");
  });
});
