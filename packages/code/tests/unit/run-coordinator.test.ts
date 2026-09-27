import { describe, expect, test } from "bun:test";
import { createRunCoordinator } from "#src/core/run-coordinator.ts";
import type { RunHandle } from "#src/adapters/run-types.ts";
import type { ScheduledTurnRequest } from "#src/core/loop-schedule.ts";
import type { HostedRunReceipt } from "@clarvis/protocol";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function handle(closed: Promise<void>): RunHandle {
  return {
    executionId: "exec_1",
    done: Promise.resolve(undefined),
    closed,
    cancel: async () => undefined,
  };
}

const request = { prompt: "scheduled" } as ScheduledTurnRequest;

describe("run coordinator", () => {
  test("human and scheduled reservations are independent and release idempotently", async () => {
    const owner = createRunCoordinator<RunHandle>();
    const human = owner.reserveHuman();
    expect(owner.scheduledBusy()).toBe(true);
    const scheduled = owner.reserveScheduled(request, "exec_scheduled");
    human.release();
    human.release();
    expect(owner.snapshot().humanSubmissions).toBe(0);
    expect(owner.snapshot().scheduledReserved).toBe(true);
    owner.releaseScheduled(scheduled);
    await scheduled.ready;
    owner.releaseScheduled(scheduled);
    expect(owner.scheduledBusy()).toBe(false);
  });

  test("terminal interactive release retains physical and reconciliation ownership", async () => {
    const owner = createRunCoordinator<RunHandle>();
    const closed = deferred<void>();
    const run = owner.beginRun("cancel", true);
    owner.trackHandle(handle(closed.promise));
    expect(owner.snapshot()).toMatchObject({ runActive: true, physicalRunCount: 1 });
    expect(run.releaseInteractive()).toBe(true);
    expect(owner.snapshot()).toMatchObject({
      runActive: false,
      physicalRunCount: 1,
      settlementActive: true,
    });
    run.finish();
    expect(owner.scheduledBusy()).toBe(true);
    closed.resolve();
    await closed.promise;
    await Promise.resolve();
    expect(owner.scheduledBusy()).toBe(false);
  });

  test("old leases and closure cannot release newer work", async () => {
    const owner = createRunCoordinator<RunHandle>();
    const stale = owner.reserveCompaction();
    owner.invalidate(false);
    const current = owner.reserveCompaction();
    stale.release();
    expect(owner.snapshot().compactionCalls).toBe(1);
    owner.setCompactionActive(true, stale.generation);
    expect(owner.snapshot().compactionActive).toBe(false);
    current.release();
    const closed = deferred<void>();
    owner.trackHandle(handle(closed.promise));
    closed.resolve();
    await closed.promise;
    await Promise.resolve();
    expect(owner.snapshot().physicalRunCount).toBe(0);
  });

  test("session invalidation releases presentation but retains old physical closure", async () => {
    const owner = createRunCoordinator<RunHandle>();
    const closed = deferred<void>();
    const run = owner.beginRun("cancel", true);
    const old = handle(closed.promise);
    owner.trackHandle(old);
    const retired = owner.invalidate(false);
    expect(retired.currentHandle).toBe(old);
    expect(owner.snapshot()).toMatchObject({
      generation: 1,
      runActive: false,
      settlementActive: false,
      physicalRunCount: 1,
    });
    expect(run.releaseInteractive()).toBe(false);
    run.finish();
    expect(owner.snapshot().physicalRunCount).toBe(1);
    closed.resolve();
    await closed.promise;
    await Promise.resolve();
    expect(owner.snapshot().physicalRunCount).toBe(0);
  });

  test("local work and coordinator instances have separate ownership", async () => {
    const first = createRunCoordinator<RunHandle>();
    const second = createRunCoordinator<RunHandle>();
    const abort = new AbortController();
    const command = first.beginLocalCommand(abort);
    const work = deferred<void>();
    first.setLocalWork(command, work.promise);
    expect(first.localCommandAdmission()).toBe("already-running");
    expect(second.localCommandAdmission()).toBe("admitted");
    first.invalidate(false);
    expect(abort.signal.aborted).toBe(true);
    expect(first.localWork()).toEqual([work.promise]);
    command.release();
    command.release();
    work.resolve();
    await work.promise;
    expect(first.snapshot().localCommandCount).toBe(0);
    expect(second.snapshot().generation).toBe(0);
  });

  test("uncertain handoff keeps its identity; refusal clears only the matching operation", async () => {
    const owner = createRunCoordinator<RunHandle>();
    owner.recordHandoff("exec_1", "operation_1");
    owner.refuseHandoff("operation_other");
    expect(owner.pendingHandoff()).toEqual({ executionId: "exec_1", operationId: "operation_1" });
    const receipt = deferred<HostedRunReceipt>();
    const flight = receipt.promise;
    owner.beginHandoff(flight);
    expect(owner.handoffFlight()).toBe(flight);
    receipt.resolve({ execution_id: "exec_1" } as unknown as HostedRunReceipt);
    await flight;
    await Promise.resolve();
    expect(owner.handoffFlight()).toBeUndefined();
    owner.refuseHandoff("operation_1");
    expect(owner.pendingHandoff()).toBeUndefined();
  });
});
