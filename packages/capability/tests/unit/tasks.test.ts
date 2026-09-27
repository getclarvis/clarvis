import { describe, expect, it } from "bun:test";

import {
  bestEffort,
  createTaskObservationScope,
  detachObserved,
  suppressSecondaryRejection,
  type TaskFailure,
} from "#src/tasks.ts";

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
    const scope = createTaskObservationScope();
    await expect(
      bestEffort(
        () => {
          throw new Error("api_key=secret-value");
        },
        { scope, operation: "sync", observer: (failure) => failures.push(failure), rateLimitMs: 0 },
      ),
    ).resolves.toBeUndefined();
    await bestEffort(() => Promise.reject(new Error("async failure")), {
      scope,
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
    const scope = createTaskObservationScope({ clock: () => now });
    const options = {
      scope,
      operation: "sweep",
      workspace: "/ws",
      observer: (failure: TaskFailure) => failures.push(failure),
      rateLimitMs: 10,
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
      scope: createTaskObservationScope(),
      operation: "detach",
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
        scope: createTaskObservationScope(),
        operation: "logger",
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
    const scope = createTaskObservationScope({ clock: () => 1 });
    for (let index = 0; index <= 1_024; index += 1) {
      await bestEffort(() => Promise.reject(new Error("expected")), {
        scope,
        operation: "bounded-registry",
        dedupeKey: String(index),
      });
    }
    const failures: TaskFailure[] = [];
    await bestEffort(() => Promise.reject(new Error("evicted")), {
      scope,
      operation: "bounded-registry",
      dedupeKey: "0",
      observer: (failure) => failures.push(failure),
    });
    expect(failures).toHaveLength(1);
  });

  it("isolates scopes and suppresses shared failures until the window boundary", async () => {
    let now = 1;
    const first = createTaskObservationScope({ clock: () => now });
    const second = createTaskObservationScope({ clock: () => now });
    const failures: string[] = [];
    const logged: string[] = [];
    const fail = (scope: typeof first, owner: string) =>
      bestEffort(() => Promise.reject(new Error(owner)), {
        scope,
        operation: "shared",
        dedupeKey: "same",
        observer: () => failures.push(owner),
        logger: { warn: () => logged.push(owner) },
        rateLimitMs: 10,
      });
    await fail(first, "first");
    await fail(first, "suppressed");
    await fail(second, "second");
    now = 11;
    await fail(first, "boundary");
    expect(failures).toEqual(["first", "second", "boundary"]);
    expect(logged).toEqual(failures);
  });

  it("uses custom keys and allows repeated failures with a zero window", async () => {
    const scope = createTaskObservationScope({ clock: () => 1 });
    const failures: TaskFailure[] = [];
    const run = (dedupeKey: string, rateLimitMs?: number) =>
      bestEffort(
        () => {
          throw new Error("failed");
        },
        {
          scope,
          operation: "custom",
          dedupeKey,
          rateLimitMs,
          observer: (failure) => failures.push(failure),
        },
      );
    await run("a");
    await run("a");
    await run("b");
    await run("a", 0);
    expect(failures).toHaveLength(3);
  });
});
