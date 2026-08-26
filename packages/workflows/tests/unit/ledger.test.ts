import { describe, expect, test } from "bun:test";
import type { Usage } from "@clarvis/capability";
import { createWorkflowLedger } from "../../src/ledger.ts";

function usage(outputByAgent: number[]): Usage {
  return {
    iterations_used: 1,
    elapsed_ms: 0,
    by_agent: outputByAgent.map((output_tokens) => ({
      type: "lead",
      model: "m",
      input_tokens: 0,
      output_tokens,
      cached_tokens: 0,
      cache_write_tokens: 0,
      iterations: 1,
      subagents_spawned: 0,
    })),
  };
}

describe("WorkflowLedger", () => {
  test("an unbounded ledger reports Infinity remaining no matter how much it spends", () => {
    const ledger = createWorkflowLedger(null);
    expect(ledger.remaining()).toBe(Number.POSITIVE_INFINITY);
    ledger.add(usage([1000]));
    expect(ledger.spent()).toBe(1000);
    expect(ledger.remaining()).toBe(Number.POSITIVE_INFINITY);
  });

  test("a bounded ledger sums output tokens across agents and counts down", () => {
    const ledger = createWorkflowLedger(500);
    ledger.add(usage([100, 50]));
    expect(ledger.spent()).toBe(150);
    expect(ledger.remaining()).toBe(350);
  });

  test("unattributed usage is fenced at the hard ceiling", () => {
    const ledger = createWorkflowLedger(100);
    ledger.add(usage([250]));
    expect(ledger.spent()).toBe(100);
    expect(ledger.remaining()).toBe(0);
  });

  describe("reserveOutput", () => {
    test("atomically replaces a bounded provisional claim with clamped actual spend", () => {
      const ledger = createWorkflowLedger(10);
      expect(ledger.reserveOutput(0)).toBeNull();
      const reservation = ledger.reserveOutput(20)!;
      expect(reservation.amount).toBe(10);
      expect(ledger.remaining()).toBe(0);

      reservation.settle(50);
      reservation.settle(1); // idempotent
      reservation.release(); // a settled reservation cannot be released twice
      expect(ledger.spent()).toBe(10);
      expect(ledger.remaining()).toBe(0);
      expect(ledger.reserveOutput(1)).toBeNull();
    });

    test("releasing a bounded direct claim returns all of its headroom", () => {
      const ledger = createWorkflowLedger(10);
      const reservation = ledger.reserveOutput(7)!;
      expect(ledger.remaining()).toBe(3);
      reservation.release();
      reservation.release();
      reservation.settle(7);
      expect(ledger.spent()).toBe(0);
      expect(ledger.remaining()).toBe(10);
    });

    test("an unbounded direct claim records finite actual output and supports release", () => {
      const ledger = createWorkflowLedger(null);
      const settled = ledger.reserveOutput(8)!;
      expect(settled.amount).toBe(8);
      settled.settle(3.9);
      settled.settle(8);
      expect(ledger.spent()).toBe(3);

      const released = ledger.reserveOutput(4)!;
      released.release();
      released.settle(4);
      expect(ledger.spent()).toBe(3);
      expect(ledger.reserveOutput(Number.POSITIVE_INFINITY)).toBeNull();
    });
  });

  describe("reserve", () => {
    test("divides headroom across leader slots plus the manager and reflects it in remaining()", () => {
      const ledger = createWorkflowLedger(100);
      const r1 = ledger.reserve(4);
      expect(r1?.amount).toBe(20);
      expect(ledger.remaining()).toBe(80);
      const r2 = ledger.reserve(4);
      expect(r2?.amount).toBe(16); // ceil(80/(4 leaders + the manager))
      expect(ledger.remaining()).toBe(64);
    });

    test("a full leader wave leaves a provisional share for the manager", () => {
      const ledger = createWorkflowLedger(100);
      for (let i = 0; i < 4; i++) expect(ledger.reserve(4)).not.toBeNull();
      expect(ledger.remaining()).toBeGreaterThan(0);
    });

    test("many concurrent reservations under a tight budget can never collectively exceed it, closing the check-then-spawn race", () => {
      const ledger = createWorkflowLedger(100);
      const reservations: Array<ReturnType<typeof ledger.reserve>> = [];
      for (let i = 0; i < 20; i++) reservations.push(ledger.reserve(4));
      const granted = reservations.filter((r) => r !== null);
      expect(granted.length).toBeGreaterThan(0);
      const totalReserved = granted.reduce((n, r) => n + (r?.amount ?? 0), 0);
      // The hard safety invariant: no matter how many run_leader calls land in one
      // batch, the sum of what they reserve can never exceed the tree budget —
      // this is what closes the original TOCTOU race (all of them reading the same
      // stale, pre-spend remaining()).
      expect(totalReserved).toBeLessThanOrEqual(100);
      expect(ledger.remaining()).toBeGreaterThanOrEqual(0);
      // Once headroom is fully claimed, further calls in the same batch are
      // refused rather than also passing a stale snapshot.
      expect(ledger.reserve(4)).toBeNull();
    });

    test("release() frees the reservation without touching spent()", () => {
      const ledger = createWorkflowLedger(100);
      const reservation = ledger.reserve(1);
      expect(ledger.remaining()).toBe(50);
      reservation!.release();
      expect(ledger.remaining()).toBe(100);
      expect(ledger.spent()).toBe(0);
      reservation!.release(); // idempotent
      expect(ledger.remaining()).toBe(100);
    });

    test("committing real usage after release leaves spent() (not the cleared reservation) as the only deduction", () => {
      const ledger = createWorkflowLedger(100);
      const reservation = ledger.reserve(4); // reserves 25
      ledger.add(usage([10])); // the leader's real usage, folded in independently
      reservation!.release();
      expect(ledger.spent()).toBe(10);
      expect(ledger.remaining()).toBe(90);
    });

    test("settles call reservations into real spend without releasing the leader's unused share", () => {
      const ledger = createWorkflowLedger(100);
      const leader = ledger.reserve(1)!;
      const call = leader.reserveOutput(60)!;
      expect(call.amount).toBe(50);
      expect(leader.remaining()).toBe(0);
      call.settle(25);
      expect(leader.spent()).toBe(25);
      expect(leader.remaining()).toBe(25);
      expect(ledger.spent()).toBe(25);
      expect(ledger.remaining()).toBe(50);
      leader.release();
      expect(ledger.remaining()).toBe(75);
    });

    test("a stale inner reservation cannot spend after its leader reservation closes", () => {
      const ledger = createWorkflowLedger(20);
      const leader = ledger.reserve(1)!;
      const call = leader.reserveOutput(20)!;
      leader.release();
      call.settle(20);
      expect(ledger.spent()).toBe(0);
      expect(ledger.remaining()).toBe(20);
    });

    test("a bounded leader can release an inner claim and rejects claims after close", () => {
      const ledger = createWorkflowLedger(20);
      const leader = ledger.reserve(1)!;
      const call = leader.reserveOutput(10)!;
      expect(leader.remaining()).toBe(0);
      call.release();
      call.release();
      call.settle(10);
      expect(leader.remaining()).toBe(10);
      expect(leader.reserveOutput(0)).toBeNull();
      leader.release();
      leader.reconcile(usage([10]));
      expect(leader.reserveOutput(1)).toBeNull();
      expect(ledger.spent()).toBe(0);
      expect(ledger.remaining()).toBe(20);
    });

    test("returns null once headroom is exhausted, and never goes negative", () => {
      const ledger = createWorkflowLedger(10);
      ledger.add(usage([10]));
      expect(ledger.reserve(4)).toBeNull();
    });

    test("an unbounded ledger's reservations always succeed with a zero-cost placeholder", () => {
      const ledger = createWorkflowLedger(null);
      const reservation = ledger.reserve(4);
      expect(reservation?.amount).toBe(0);
      expect(ledger.remaining()).toBe(Number.POSITIVE_INFINITY);
      expect(reservation!.remaining()).toBe(Number.POSITIVE_INFINITY);
      const call = reservation!.reserveOutput(20)!;
      call.settle(7);
      call.settle(20);
      expect(reservation!.spent()).toBe(7);
      reservation!.reconcile(usage([10]));
      expect(reservation!.spent()).toBe(10);
      expect(ledger.spent()).toBe(10);

      const releasedCall = reservation!.reserveOutput(2)!;
      releasedCall.release();
      releasedCall.release();
      reservation!.release();
      reservation!.reconcile(usage([30]));
      expect(reservation!.reserveOutput(1)).toBeNull();
      expect(ledger.spent()).toBe(10);
    });
  });
});
