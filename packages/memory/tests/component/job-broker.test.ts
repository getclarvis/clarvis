import { describe, expect, test } from "bun:test";

import { createMemoryJobBroker, type MemoryJobSettlement } from "../../src/job-broker.ts";
import { createTestClock } from "../../src/testing.ts";

function settlement(over: Partial<MemoryJobSettlement> = {}): MemoryJobSettlement {
  return { run_id: "r1", outcome: "completed", ...over };
}

describe("createMemoryJobBroker", () => {
  test("delivers a settlement published after subscribing", () => {
    const broker = createMemoryJobBroker();
    const seen: MemoryJobSettlement[] = [];
    broker.subscribe("owner-a", "r1", (s) => seen.push(s));

    broker.publish("owner-a", settlement());

    expect(seen).toEqual([settlement()]);
  });

  test("subscribing immediately before a synchronous publish is not missed", () => {
    const broker = createMemoryJobBroker();
    const seen: MemoryJobSettlement[] = [];
    const unsubscribe = broker.subscribe("owner-a", "r1", (s) => seen.push(s));
    // Simulates the worker draining the job on the very same tick the caller
    // finished registering — the ordering the loop capability relies on.
    broker.publish("owner-a", settlement());
    unsubscribe();

    expect(seen).toHaveLength(1);
  });

  test("retry_wait does not unsubscribe; a later terminal outcome still delivers", () => {
    const broker = createMemoryJobBroker();
    const seen: MemoryJobSettlement[] = [];
    broker.subscribe("owner-a", "r1", (s) => seen.push(s));

    broker.publish("owner-a", settlement({ outcome: "retry_wait" }));
    broker.publish("owner-a", settlement({ outcome: "retry_wait" }));
    broker.publish("owner-a", settlement({ outcome: "completed" }));

    expect(seen.map((s) => s.outcome)).toEqual(["retry_wait", "retry_wait", "completed"]);
  });

  test("delivers a terminal outcome exactly once, then drops further publishes", () => {
    const broker = createMemoryJobBroker();
    const seen: MemoryJobSettlement[] = [];
    broker.subscribe("owner-a", "r1", (s) => seen.push(s));

    broker.publish("owner-a", settlement({ outcome: "completed" }));
    broker.publish("owner-a", settlement({ outcome: "completed" }));

    expect(seen).toHaveLength(1);
  });

  test.each(["failed", "blocked"] as const)("%s terminates the subscription", (outcome) => {
    const broker = createMemoryJobBroker();
    const seen: MemoryJobSettlement[] = [];
    broker.subscribe("owner-a", "r1", (s) => seen.push(s));

    broker.publish("owner-a", settlement({ outcome }));
    broker.publish("owner-a", settlement({ outcome: "completed" }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.outcome).toBe(outcome);
  });

  test("publish for an unknown run_id is a no-op", () => {
    const broker = createMemoryJobBroker();
    expect(() => broker.publish("owner-a", settlement({ run_id: "unknown" }))).not.toThrow();
  });

  test("a listener throw does not propagate and does not affect the subscription's lifecycle", () => {
    const broker = createMemoryJobBroker();
    let calls = 0;
    broker.subscribe("owner-a", "r1", () => {
      calls += 1;
      throw new Error("listener exploded");
    });

    expect(() => broker.publish("owner-a", settlement({ outcome: "retry_wait" }))).not.toThrow();
    expect(() => broker.publish("owner-a", settlement({ outcome: "completed" }))).not.toThrow();
    expect(calls).toBe(2);

    // The prior publish was terminal, so the subscription is gone now.
    broker.publish("owner-a", settlement({ outcome: "completed" }));
    expect(calls).toBe(2);
  });

  test("manual unsubscribe stops further delivery", () => {
    const broker = createMemoryJobBroker();
    const seen: MemoryJobSettlement[] = [];
    const unsubscribe = broker.subscribe("owner-a", "r1", (s) => seen.push(s));

    unsubscribe();
    broker.publish("owner-a", settlement());

    expect(seen).toHaveLength(0);
  });

  test("re-subscribing for the same run_id replaces the prior listener", () => {
    const broker = createMemoryJobBroker();
    const first: MemoryJobSettlement[] = [];
    const second: MemoryJobSettlement[] = [];
    broker.subscribe("owner-a", "r1", (s) => first.push(s));
    broker.subscribe("owner-a", "r1", (s) => second.push(s));

    broker.publish("owner-a", settlement());

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  test("an unsettled subscription is dropped after the leak-guard timeout", async () => {
    const clock = createTestClock();
    const broker = createMemoryJobBroker({ clock, timeoutMs: 1000 });
    const seen: MemoryJobSettlement[] = [];
    broker.subscribe("owner-a", "r1", (s) => seen.push(s));

    await clock.advance(1000);
    broker.publish("owner-a", settlement());

    expect(seen).toHaveLength(0);
  });

  test("no listener present never affects publish — durable processing is unconditional", () => {
    const broker = createMemoryJobBroker();
    // No subscribe() call at all: publish must still be side-effect-free and
    // never throw, since the worker's drain loop calls it unconditionally.
    for (const outcome of ["completed", "retry_wait", "failed", "blocked"] as const) {
      expect(() => broker.publish("owner-a", settlement({ outcome }))).not.toThrow();
    }
  });

  test("the same run_id is isolated by owner", () => {
    const broker = createMemoryJobBroker();
    const alice: MemoryJobSettlement[] = [];
    const bob: MemoryJobSettlement[] = [];
    broker.subscribe("alice", "r1", (s) => alice.push(s));
    broker.subscribe("bob", "r1", (s) => bob.push(s));

    broker.publish("alice", settlement());

    expect(alice).toEqual([settlement()]);
    expect(bob).toHaveLength(0);
  });

  test("closeOwner cancels only that owner's subscriptions", () => {
    const broker = createMemoryJobBroker();
    const seen: string[] = [];
    broker.subscribe("alice", "r1", () => seen.push("alice"));
    broker.subscribe("bob", "r1", () => seen.push("bob"));

    broker.closeOwner("alice");
    broker.publish("alice", settlement());
    broker.publish("bob", settlement());

    expect(seen).toEqual(["bob"]);
  });

  test("close cancels every owner's leak guard and permanently rejects new subscriptions", async () => {
    const clock = createTestClock();
    const broker = createMemoryJobBroker({ clock, timeoutMs: 1000 });
    const seen: string[] = [];
    const unsubscribeAlice = broker.subscribe("alice", "shared", () => seen.push("alice"));
    const unsubscribeBob = broker.subscribe("bob", "shared", () => seen.push("bob"));
    expect(clock.pending()).toBe(2);

    broker.close();
    broker.close();
    expect(clock.pending()).toBe(0);

    const unsubscribeAfterClose = broker.subscribe("alice", "later", () => seen.push("later"));
    expect(clock.pending()).toBe(0);
    broker.publish("alice", settlement({ run_id: "shared" }));
    broker.publish("bob", settlement({ run_id: "shared" }));
    await clock.advance(2000);
    expect(seen).toEqual([]);
    expect(clock.pending()).toBe(0);

    expect(() => unsubscribeAlice()).not.toThrow();
    expect(() => unsubscribeBob()).not.toThrow();
    expect(() => unsubscribeAfterClose()).not.toThrow();
  });
});
