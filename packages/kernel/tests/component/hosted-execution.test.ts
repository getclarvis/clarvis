import { describe, expect, it } from "bun:test";
import type { HostedRunAttachment, HostedRunFrame, RunEvent, RunResult } from "@clarvis/protocol";
import { createHostedExecution, type HostedExecutionOptions } from "../../src/hosting/execution.ts";
import { createHostedProjection, type ProjectionStorage } from "../../src/hosting/projection.ts";
import { createManagedRun, type ManagedRunContext } from "../../src/runs/managed-run.ts";

const completed: RunResult = {
  execution_id: "hosted-run",
  status: "completed",
  result: "done",
  usage: { elapsed_ms: 1, iterations: 1 },
};
const delta = (text: string): RunEvent => ({
  type: "text_delta",
  at: 1,
  agent: "lead",
  iteration: 1,
  channel: "text",
  text,
  reset: false,
});
const structural = (step: number): RunEvent => ({
  type: "capability_event",
  at: step,
  capability: "fixture",
  kind: "marker",
  projection: "fixture.marker",
  detail: { step },
  truncated: false,
});

async function until(condition: () => boolean): Promise<void> {
  for (let step = 0; step < 200 && !condition(); step++) await Promise.resolve();
  expect(condition()).toBe(true);
}

async function fixture(
  overrides: Partial<Pick<HostedExecutionOptions, "maxBuffered" | "reconcile">> = {},
) {
  let data = Buffer.alloc(0);
  let fault = false;
  let sync: (() => Promise<void>) | undefined;
  const storage: ProjectionStorage = {
    async write(bytes, offset) {
      if (fault) throw new Error("disk full");
      data = Buffer.concat([data.subarray(0, offset), bytes]);
    },
    async read(offset, bytes) {
      return data.subarray(offset, offset + bytes);
    },
    async sync() {
      await sync?.();
    },
    async close() {},
  };
  const projection = createHostedProjection(storage, {
    execution_id: completed.execution_id,
    host_generation: "host-one",
  });
  const entered = Promise.withResolvers<ManagedRunContext>();
  const finish = Promise.withResolvers<RunResult>();
  const source = createManagedRun({
    executionId: completed.execution_id,
    execute(context) {
      entered.resolve(context);
      return finish.promise;
    },
  });
  const context = await entered.promise;
  const reconciled: RunResult[] = [];
  const execution = createHostedExecution({
    handle: source,
    projection,
    reconcile: async (result) => {
      reconciled.push(result);
    },
    ...overrides,
  });
  const observe = () => execution.observe(source);
  const read = async (
    attachment: Pick<HostedRunAttachment, "snapshot">,
  ): Promise<HostedRunFrame[]> => {
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const page = await projection.readPage(attachment.snapshot.snapshot_id, offset);
      parts.push(Buffer.from(page.data_base64, "base64"));
      if (page.next_offset === undefined) break;
      offset = page.next_offset;
    }
    return Buffer.concat(parts)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HostedRunFrame);
  };
  return {
    context,
    source,
    execution,
    projection,
    observe,
    read,
    reconciled,
    finish: () => finish.resolve(completed),
    setFault: () => {
      fault = true;
    },
    setSync: (callback: () => Promise<void>) => {
      sync = callback;
    },
  };
}

describe("hosted execution observation", () => {
  it("a bounded observer coalesces adjacent deltas without losing text or crossing the snapshot", async () => {
    const f = await fixture({ maxBuffered: 1 });
    const view = await f.observe();
    for (const [index, text] of ["A", "B", "C"].entries()) {
      f.context.emit(delta(text));
      await until(() => f.projection.stats().sequence === index + 1);
    }
    expect(f.context.signal.aborted).toBe(false);
    expect(f.execution.state().subscribers).toBe(1);
    expect(view.handle.buffered!().buffered_items).toBe(1);
    f.finish();
    const tail = await Array.fromAsync(view.handle.events);
    expect(tail.map((frame) => (frame.event as { text: string }).text).join("")).toBe("ABC");
    expect(tail[0]!.first_sequence).toBe(1);
    expect(tail.at(-1)!.last_sequence).toBe(3);
    expect(await f.read(view)).toEqual([]);
    await f.execution.settled;
    await f.execution.dispose();
  });

  it("live controls reach the source while observer faults and retirement cannot manufacture answers", async () => {
    const f = await fixture();
    const controls: unknown[] = [];
    const view = await f.execution.observe({
      ...f.source,
      steer: async (message) => {
        controls.push({ kind: "steer", message });
      },
      compact: async (request) => {
        controls.push({ kind: "compact", request });
      },
    });
    await view.handle.steer("preserve the selected database");
    await view.handle.compact("retain confirmed decisions");
    expect(controls).toEqual([
      { kind: "steer", message: "preserve the selected database" },
      { kind: "compact", request: "retain confirmed decisions" },
    ]);
    const received: string[] = [];
    view.handle.onElicit(() => {
      throw new Error("broken question renderer");
    });
    view.handle.onElicit((question) => received.push(question.id));
    const answer = f.context.elicit(
      {
        message: "Continue?",
        requestedSchema: { type: "object", properties: {}, required: [] },
      },
      {},
    );
    await until(() => received.length === 1);
    await view.handle.respond({ id: received[0]!, action: "accept" });
    expect(await answer).toEqual({ action: "accept" });
    expect(f.execution.state().attention).toBe("none");
    f.execution.releaseObservation(view.observation_id);
    await expect(view.handle.steer("stale steer")).rejects.toMatchObject({ code: "not_found" });
    expect(f.context.signal.aborted).toBe(false);
    f.finish();
    await f.execution.settled;
    await f.execution.dispose();
  });

  it("keeps the sole source alive without observers and reattaches to the same execution", async () => {
    const f = await fixture();
    f.context.emit(delta("before"));
    await until(() => f.projection.stats().sequence === 1);
    const first = await f.observe();
    expect((await f.read(first))[0]!.event).toMatchObject({ text: "before" });
    f.execution.releaseObservation(first.observation_id);
    expect(f.context.signal.aborted).toBe(false);
    f.context.emit(delta(" after detach"));
    await until(() => f.projection.stats().sequence === 2);
    const second = await f.observe();
    expect(second.handle.execution_id).toBe(first.handle.execution_id);
    expect(second.snapshot.cursor.sequence).toBe(2);
    expect(
      (await f.read(second)).map((frame) => (frame.event as { text: string }).text).join(""),
    ).toBe("before after detach");
    const tail = Array.fromAsync(second.handle.events);
    f.context.emit(structural(3));
    f.finish();
    expect((await tail).map((frame) => frame.first_sequence)).toEqual([3]);
    await f.execution.settled;
    expect(f.reconciled).toEqual([completed]);
    expect(await second.handle.done).toEqual(completed);
    const terminal = await f.observe();
    expect(terminal.snapshot.cursor.sequence).toBe(3);
    expect(await terminal.handle.done).toEqual(completed);
    await f.execution.dispose();
  });

  it("cuts snapshot and tail atomically while an append races the snapshot sync", async () => {
    const f = await fixture();
    f.context.emit(delta("A"));
    await until(() => f.projection.stats().sequence === 1);
    const syncing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setSync(async () => {
      syncing.resolve();
      await release.promise;
    });
    const attaching = f.observe();
    await syncing.promise;
    f.context.emit(delta("B"));
    f.context.emit(delta("C"));
    release.resolve();
    const attachment = await attaching;
    expect(attachment.snapshot.cursor.sequence).toBe(1);
    expect((await f.read(attachment))[0]!.event).toMatchObject({ text: "A" });
    f.finish();
    const frames = await Array.fromAsync(attachment.handle.events);
    expect(frames[0]!.first_sequence).toBe(2);
    expect(frames.map((frame) => (frame.event as { text: string }).text).join("")).toBe("BC");
    await f.execution.settled;
    await f.execution.dispose();
  });

  it("disconnects a saturated observer while draining and persisting the healthy run", async () => {
    const f = await fixture({ maxBuffered: 2 });
    const slow = await f.observe();
    for (let step = 1; step <= 4; step++) f.context.emit(structural(step));
    await until(() => f.projection.stats().sequence === 4);
    expect(f.execution.state().subscribers).toBe(0);
    expect(f.execution.state().recoveryError).toBeUndefined();
    expect(f.context.signal.aborted).toBe(false);
    await slow.handle.closed;
    const restored = await f.observe();
    expect((await f.read(restored)).map((frame) => frame.first_sequence)).toEqual([1, 2, 3, 4]);
    f.finish();
    await f.execution.settled;
    await f.execution.dispose();
  });

  it("replays only pending elicitation and refuses an expired question's response", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const answer = f.context.elicit(
      {
        message: "Approve this?",
        requestedSchema: { type: "object", properties: {}, required: [] },
      },
      { signal: abort.signal },
    );
    const attachment = await f.observe();
    expect(attachment.pending_elicitations).toHaveLength(1);
    expect(f.execution.state().attention).toBe("waiting_user");
    const id = attachment.pending_elicitations[0]!.id;
    const settled: string[] = [];
    attachment.handle.onElicitSettled!((value) => settled.push(value));
    abort.abort();
    expect(await answer).toEqual({ action: "cancel" });
    expect(settled).toEqual([id]);
    const restored = await f.observe();
    expect(restored.pending_elicitations).toEqual([]);
    await expect(restored.handle.respond({ id, action: "accept" })).rejects.toThrow("settled");
    expect(f.execution.state().attention).toBe("none");
    f.finish();
    await f.execution.settled;
    await f.execution.dispose();
  });

  it("waits for physical closure and reconciliation after cancellation acknowledgement", async () => {
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({
      reconcile: async () => {
        writing.resolve();
        await release.promise;
      },
    });
    const view = await f.observe();
    await view.handle.cancel();
    expect(f.context.signal.aborted).toBe(true);
    expect(f.execution.state().physicalClosed).toBe(false);
    f.context.emit({
      type: "memory_ingest",
      at: 1,
      detail: { execution_id: completed.execution_id, phase: "queued" },
    });
    f.finish();
    await f.source.done;
    expect(f.execution.state().physicalClosed).toBe(false);
    f.context.emit({
      type: "memory_ingest",
      at: 2,
      detail: { execution_id: completed.execution_id, phase: "done" },
    });
    await writing.promise;
    expect(f.execution.state().physicalClosed).toBe(true);
    expect(f.execution.state().reconciled).toBe(false);
    release.resolve();
    await f.execution.settled;
    expect(f.execution.state().reconciled).toBe(true);
    await f.execution.dispose();
  });

  it("exposes storage failure and retains physical ownership while cancellation unwinds", async () => {
    const f = await fixture();
    const view = await f.observe();
    f.setFault();
    f.context.emit(structural(1));
    await until(() => f.execution.state().recoveryError !== undefined);
    expect(f.context.signal.aborted).toBe(true);
    expect(f.execution.state().physicalClosed).toBe(false);
    await view.handle.closed;
    await expect(f.observe()).rejects.toThrow("disk full");
    f.context.emit(structural(2));
    f.finish();
    await f.execution.settled;
    expect(f.execution.state().physicalClosed).toBe(true);
    expect(f.reconciled).toEqual([completed]);
    await f.execution.dispose();
  });
});
