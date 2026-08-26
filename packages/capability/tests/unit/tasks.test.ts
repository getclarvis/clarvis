import { describe, expect, it } from "bun:test";

import {
  bestEffort,
  detachObserved,
  suppressSecondaryRejection,
  type TaskFailure,
} from "../../src/tasks.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("task intent helpers", () => {
  it("bestEffort observes sanitized sync and async failures without rejecting", async () => {
    const failures: TaskFailure[] = [];
    await expect(
      bestEffort(
        () => {
          throw new Error("api_key=secret-value");
        },
        { operation: "sync", observer: (failure) => failures.push(failure), rateLimitMs: 0 },
      ),
    ).resolves.toBeUndefined();
    await bestEffort(() => Promise.reject(new Error("async failure")), {
      operation: "async",
      observer: (failure) => failures.push(failure),
      rateLimitMs: 0,
    });
    expect(failures).toHaveLength(2);
    expect(failures[0]!.cause).not.toContain("secret-value");
  });

  it("rate-limits by operation and workspace", async () => {
    const failures: TaskFailure[] = [];
    let now = 1;
    const options = {
      operation: "sweep",
      workspace: "/ws",
      observer: (failure: TaskFailure) => failures.push(failure),
      clock: () => now,
      rateLimitMs: 10,
      dedupeKey: `test-${crypto.randomUUID()}`,
    };
    await bestEffort(() => Promise.reject(new Error("one")), options);
    await bestEffort(() => Promise.reject(new Error("two")), options);
    now = 11;
    await bestEffort(() => Promise.reject(new Error("three")), options);
    expect(failures.map((failure) => failure.cause)).toEqual(["one", "three"]);
  });

  it("detachObserved catches a rejection and a throwing observer", async () => {
    const finished = deferred();
    const calls: string[] = [];
    detachObserved(() => Promise.reject(new Error("boom")), {
      operation: `detach-${crypto.randomUUID()}`,
      rateLimitMs: 0,
      observer: () => {
        calls.push("observer");
        throw new Error("observer failure");
      },
      logger: {
        warn: () => {
          calls.push("logger");
          finished.resolve();
        },
      },
    });
    await finished.promise;
    expect(calls).toEqual(["observer", "logger"]);
  });

  it("never rejects when the logger itself fails", async () => {
    await expect(
      bestEffort(() => Promise.reject(new Error("operation failed")), {
        operation: `logger-${crypto.randomUUID()}`,
        rateLimitMs: 0,
        logger: {
          warn: () => {
            throw new Error("logger failed");
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("suppresses a secondary rejection only with a named primary channel", () => {
    suppressSecondaryRejection(Promise.reject(new Error("secondary")), "onError/fullStream");
    expect(() => suppressSecondaryRejection(Promise.resolve(), " ")).toThrow(/primary/);
  });

  it("bounds the failure-deduplication registry", async () => {
    const prefix = `bounded-${crypto.randomUUID()}`;
    for (let index = 0; index <= 1_024; index += 1) {
      await bestEffort(() => Promise.reject(new Error("expected")), {
        operation: "bounded-registry",
        dedupeKey: `${prefix}-${index}`,
        rateLimitMs: 0,
      });
    }
  });
});
