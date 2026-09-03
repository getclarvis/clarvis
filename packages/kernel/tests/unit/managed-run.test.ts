import { describe, expect, it } from "bun:test";
import type { ElicitationRequest, RunEvent, RunResult } from "@clarvis/protocol";
import { createKernelLifecycle } from "../../src/application/lifecycle.ts";
import {
  createManagedRunWithRuntime,
  type ManagedRunContext,
  type ManagedRunRuntime,
  type ManagedRunTimer,
} from "../../src/runs/managed-run.ts";

interface ScheduledTask {
  at: number;
  cancelled: boolean;
  task: () => void;
}

class FakeClock implements ManagedRunRuntime {
  private current = 1_000;
  private readonly tasks: ScheduledTask[] = [];

  now(): number {
    return this.current;
  }

  schedule(task: () => void, delayMs: number): ManagedRunTimer {
    const scheduled = { at: this.current + delayMs, cancelled: false, task };
    this.tasks.push(scheduled);
    return { cancel: () => (scheduled.cancelled = true) };
  }

  advanceBy(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (next === undefined) break;
      next.cancelled = true;
      this.current = next.at;
      next.task();
    }
    this.current = target;
  }

  pendingDeadlines(): number[] {
    return this.tasks
      .filter((task) => !task.cancelled)
      .map((task) => task.at)
      .sort((left, right) => left - right);
  }
}

function completed(executionId: string): RunResult {
  return {
    execution_id: executionId,
    status: "completed",
    result: "done",
    usage: { iterations: 1, elapsed_ms: 2 },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const collected: RunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function ingest(executionId: string, phase: string, at: number): RunEvent {
  return {
    type: "memory_ingest",
    at,
    detail: { execution_id: executionId, phase },
  } as RunEvent;
}

describe("createManagedRunWithRuntime", () => {
  it("owns execution, observation, terminal settlement, and stream completion", async () => {
    const clock = new FakeClock();
    const observed: RunEvent[] = [];
    const settled: RunResult[] = [];
    const handle = createManagedRunWithRuntime(
      {
        executionId: "run-success",
        execute(context) {
          context.emit({ type: "run_started", at: 1 });
          context.emit({ type: "run_ended", at: 2, status: "completed" });
          return Promise.resolve(completed(context.executionId));
        },
        observe: (event) => observed.push(event),
        settle: (result) => {
          settled.push(result);
        },
      },
      clock,
    );

    const result = await handle.done;
    const events = await collect(handle.events);

    expect(result).toEqual(completed("run-success"));
    expect(settled).toEqual([result]);
    expect(observed).toEqual(events);
    expect(events.map((event) => event.type)).toEqual(["run_started", "run_ended"]);
    expect(clock.pendingDeadlines()).toEqual([]);
  });

  it("turns execution and settlement exceptions into stable failed results", async () => {
    const clock = new FakeClock();
    const executionFailure = createManagedRunWithRuntime(
      {
        executionId: "run-execute-failure",
        execute: () => Promise.reject(new Error("execution exploded")),
      },
      clock,
    );
    expect(await executionFailure.done).toMatchObject({
      execution_id: "run-execute-failure",
      status: "failed",
      error: { code: "internal", message: "execution exploded" },
    });
    expect(await collect(executionFailure.events)).toEqual([]);

    const settlementFailure = createManagedRunWithRuntime(
      {
        executionId: "run-settle-failure",
        execute: () => Promise.resolve(completed("run-settle-failure")),
        settle: () => {
          throw new Error("settlement exploded");
        },
      },
      clock,
    );
    expect(await settlementFailure.done).toMatchObject({
      execution_id: "run-settle-failure",
      status: "failed",
      error: { code: "internal", message: "settlement exploded" },
    });
  });

  it("buffers steering and compaction, maps protocol content, and exposes cancellation", async () => {
    const clock = new FakeClock();
    const finish = deferred<RunResult>();
    let context!: ManagedRunContext;
    const handle = createManagedRunWithRuntime(
      {
        executionId: "run-control",
        execute(value) {
          context = value;
          return finish.promise;
        },
      },
      clock,
    );

    const firstSteer = handle.steer("focus on auth");
    const secondSteer = handle.steer({
      role: "user",
      content: [{ type: "text", text: "and logs" }],
    });
    expect(context.steer.drain()).toEqual([
      { content: "focus on auth" },
      { content: [{ type: "text", text: "and logs" }] },
    ]);
    await Promise.all([firstSteer, secondSteer]);
    await handle.compact();
    await handle.compact("keep auth context");
    expect(context.compaction.drain()).toEqual([{}, { request: "keep auth context" }]);

    await handle.cancel();
    expect(context.signal.aborted).toBe(true);
    const undeliveredSteer = handle.steer("too late to drain");
    finish.resolve(completed("run-control"));
    await handle.done;

    await expect(undeliveredSteer).rejects.toMatchObject({ code: "not_found" });
    await expect(handle.steer("too late")).rejects.toMatchObject({ code: "not_found" });
    expect(context.steer.drain()).toEqual([]);
    await expect(handle.compact("too late")).rejects.toMatchObject({ code: "not_found" });
  });

  it("cancels execution when the sole event consumer abandons the stream", async () => {
    const clock = new FakeClock();
    let observedSignal!: AbortSignal;
    const handle = createManagedRunWithRuntime(
      {
        executionId: "run-abandoned",
        execute: (context) => {
          observedSignal = context.signal;
          context.emit({ type: "run_started", at: 1 });
          return new Promise<RunResult>((resolve) => {
            context.signal.addEventListener("abort", () => {
              resolve({ ...completed(context.executionId), status: "cancelled" });
            });
          });
        },
      },
      clock,
    );

    const iterator = handle.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ done: false, value: { type: "run_started" } });
    await iterator.return?.();

    expect(observedSignal.aborted).toBe(true);
    expect(await handle.done).toMatchObject({ status: "cancelled" });
  });

  it("replays an elicitation raised before subscription and forwards its response", async () => {
    const clock = new FakeClock();
    const handle = createManagedRunWithRuntime(
      {
        executionId: "run-elicit",
        async execute(context) {
          const answer = await context.elicit(
            {
              message: "Approve?",
              requestedSchema: { type: "object", properties: {}, required: [] },
            },
            { signal: context.signal },
          );
          return { ...completed(context.executionId), result: answer };
        },
      },
      clock,
    );

    let request: ElicitationRequest | undefined;
    handle.onElicit((value) => {
      request = value;
    });
    expect(request).toMatchObject({
      id: "run-elicit:elicit:0",
      execution_id: "run-elicit",
      prompt: "Approve?",
    });
    await handle.respond({ id: request!.id, action: "accept", content: { answer: "yes" } });
    expect(await handle.done).toMatchObject({
      status: "completed",
      result: { action: "accept", content: { answer: "yes" } },
    });
  });

  it("closes immediately when no ingest is pending and on a terminal ingest notice", async () => {
    const clock = new FakeClock();
    const immediate = createManagedRunWithRuntime(
      {
        executionId: "run-immediate",
        execute: () => Promise.resolve(completed("run-immediate")),
      },
      clock,
    );
    await immediate.done;
    expect(await collect(immediate.events)).toEqual([]);
    expect(clock.pendingDeadlines()).toEqual([]);

    let context!: ManagedRunContext;
    const pending = createManagedRunWithRuntime(
      {
        executionId: "run-terminal-ingest",
        ingestGraceMs: 50,
        execute(value) {
          context = value;
          context.emit(ingest(value.executionId, "started", clock.now()));
          return Promise.resolve(completed(value.executionId));
        },
      },
      clock,
    );
    await pending.done;
    expect(clock.pendingDeadlines()).toEqual([clock.now() + 50]);
    context.emit(ingest(context.executionId, "done", clock.now()));
    await flushPromises();
    expect((await collect(pending.events)).map((event) => event.type)).toEqual([
      "memory_ingest",
      "memory_ingest",
    ]);
    expect(clock.pendingDeadlines()).toEqual([]);
  });

  it("bounds a hung ingest with fake time and renews the deadline for every queued retry", async () => {
    const timeoutClock = new FakeClock();
    const hung = createManagedRunWithRuntime(
      {
        executionId: "run-hung-ingest",
        ingestGraceMs: 40,
        execute(context) {
          context.emit(ingest(context.executionId, "started", timeoutClock.now()));
          return Promise.resolve(completed(context.executionId));
        },
      },
      timeoutClock,
    );
    await hung.done;
    timeoutClock.advanceBy(39);
    expect(timeoutClock.pendingDeadlines()).toEqual([1_040]);
    timeoutClock.advanceBy(1);
    await flushPromises();
    expect((await collect(hung.events)).map((event) => event.type)).toEqual(["memory_ingest"]);

    const slidingClock = new FakeClock();
    let context!: ManagedRunContext;
    const sliding = createManagedRunWithRuntime(
      {
        executionId: "run-sliding-ingest",
        ingestGraceMs: 80,
        execute(value) {
          context = value;
          value.emit(ingest(value.executionId, "started", slidingClock.now()));
          return Promise.resolve(completed(value.executionId));
        },
      },
      slidingClock,
    );
    await sliding.done;
    expect(slidingClock.pendingDeadlines()).toEqual([1_080]);
    slidingClock.advanceBy(30);
    context.emit(ingest(context.executionId, "queued", slidingClock.now()));
    expect(slidingClock.pendingDeadlines()).toEqual([1_110]);
    slidingClock.advanceBy(60);
    context.emit(ingest(context.executionId, "queued", slidingClock.now()));
    expect(slidingClock.pendingDeadlines()).toEqual([1_170]);
    slidingClock.advanceBy(79);
    expect(slidingClock.pendingDeadlines()).toEqual([1_170]);
    slidingClock.advanceBy(1);
    await flushPromises();
    expect((await collect(sliding.events)).map((event) => event.type)).toEqual([
      "memory_ingest",
      "memory_ingest",
      "memory_ingest",
    ]);
  });

  it("stops sliding ingest renewals at an absolute deadline", async () => {
    const clock = new FakeClock();
    let context!: ManagedRunContext;
    const handle = createManagedRunWithRuntime(
      {
        executionId: "run-absolute-ingest",
        ingestGraceMs: 40,
        ingestMaxWaitMs: 100,
        execute(value) {
          context = value;
          value.emit(ingest(value.executionId, "started", clock.now()));
          return Promise.resolve(completed(value.executionId));
        },
      },
      clock,
    );
    await handle.done;
    clock.advanceBy(30);
    context.emit(ingest(context.executionId, "queued", clock.now()));
    clock.advanceBy(30);
    context.emit(ingest(context.executionId, "queued", clock.now()));
    expect(clock.pendingDeadlines()).toEqual([1_100]);
    clock.advanceBy(40);
    await flushPromises();
    expect(await collect(handle.events)).toHaveLength(3);
    expect(clock.pendingDeadlines()).toEqual([]);
  });

  it("disconnects a retained emitter from the run target after stream close", async () => {
    const clock = new FakeClock();
    const observed: RunEvent[] = [];
    let retainedEmit!: ManagedRunContext["emit"];
    const handle = createManagedRunWithRuntime(
      {
        executionId: "run-late-memory",
        ingestGraceMs: 25,
        observe: (event) => observed.push(event),
        execute(context) {
          retainedEmit = context.emit;
          context.emit(ingest(context.executionId, "started", clock.now()));
          return Promise.resolve(completed(context.executionId));
        },
      },
      clock,
    );

    await handle.done;
    clock.advanceBy(25);
    await flushPromises();
    expect((await collect(handle.events)).map((event) => event.type)).toEqual(["memory_ingest"]);

    retainedEmit(ingest("run-late-memory", "done", clock.now()));
    expect(observed.map((event) => event.type)).toEqual(["memory_ingest"]);
    expect(clock.pendingDeadlines()).toEqual([]);
  });

  it("protects the final drop notice and timestamps the complete discarded count", async () => {
    const clock = new FakeClock();
    const handle = createManagedRunWithRuntime(
      {
        executionId: "run-dropped",
        eventBuffer: { maxBuffered: 2 },
        execute(context) {
          context.emit({
            type: "tool_output_delta",
            at: 1,
            agent: "lead",
            call_id: "a",
            chunk: "first",
          });
          context.emit({
            type: "tool_output_delta",
            at: 2,
            agent: "lead",
            call_id: "b",
            chunk: "second",
          });
          context.emit({ type: "run_ended", at: 3, status: "completed" });
          return Promise.resolve(completed(context.executionId));
        },
      },
      clock,
    );

    await handle.done;
    expect(await collect(handle.events)).toEqual([
      { type: "run_ended", at: 3, status: "completed" },
      { type: "events_dropped", at: 1_000, dropped: 2 },
    ]);
  });

  it("aborts a run when structural events saturate its bounded stream", async () => {
    const clock = new FakeClock();
    let signal: AbortSignal | undefined;
    const handle = createManagedRunWithRuntime(
      {
        executionId: "run-saturated",
        eventBuffer: { maxBuffered: 1 },
        execute(context) {
          signal = context.signal;
          context.emit({ type: "run_started", at: 1 });
          context.emit({ type: "run_started", at: 2 });
          return Promise.resolve(completed(context.executionId));
        },
      },
      clock,
    );

    await handle.done;
    expect(signal?.aborted).toBe(true);
  });

  it("lets lifecycle shutdown cancel an active run and rejects late admission through done", async () => {
    const clock = new FakeClock();
    const lifecycle = createKernelLifecycle();
    const active = createManagedRunWithRuntime(
      {
        executionId: "run-active",
        lifecycle,
        execute: (context) =>
          new Promise<RunResult>((resolve) => {
            context.signal.addEventListener("abort", () => {
              resolve({ ...completed(context.executionId), status: "cancelled" });
            });
          }),
      },
      clock,
    );

    await lifecycle.close();
    expect(await active.done).toMatchObject({ status: "cancelled" });

    let executed = false;
    const late = createManagedRunWithRuntime(
      {
        executionId: "run-late",
        lifecycle,
        execute: () => {
          executed = true;
          return Promise.resolve(completed("run-late"));
        },
      },
      clock,
    );
    expect(await late.done).toMatchObject({
      status: "failed",
      error: { code: "unavailable", message: "kernel is closing" },
    });
    expect(executed).toBe(false);
  });
});
