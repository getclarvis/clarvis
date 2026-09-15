import { describe, expect, test } from "bun:test";
import type { HostedRunFrame, RunEvent } from "@clarvis/protocol";
import {
  createHostedProjection,
  type HostedProjection,
  type ProjectionStorage,
} from "../../src/hosting/projection.ts";

const identity = { host_generation: "generation-one", execution_id: "run-one" };

function memoryStorage() {
  let data = Buffer.alloc(0);
  let writes = 0;
  let syncs = 0;
  let closed = false;
  const storage: ProjectionStorage = {
    async write(bytes, offset) {
      data = Buffer.concat([data.subarray(0, offset), bytes]);
      writes += 1;
    },
    async read(offset, length) {
      return data.subarray(offset, offset + length);
    },
    async sync() {
      syncs += 1;
    },
    async close() {
      closed = true;
    },
  };
  return { storage, stats: () => ({ writes, syncs, closed, bytes: data.length }) };
}

function delta(
  text: string,
  extra: Partial<Extract<RunEvent, { type: "text_delta" }>> = {},
): RunEvent {
  return {
    type: "text_delta",
    at: 1,
    agent: "lead",
    iteration: 1,
    channel: "text",
    text,
    reset: false,
    ...extra,
  };
}

async function readFrames(
  projection: HostedProjection,
  snapshotId: string,
): Promise<HostedRunFrame[]> {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const page = await projection.readPage(snapshotId, offset);
    expect(page.offset).toBe(offset);
    chunks.push(Buffer.from(page.data_base64, "base64"));
    if (page.next_offset === undefined) break;
    expect(page.next_offset).toBeGreaterThan(offset);
    offset = page.next_offset;
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HostedRunFrame);
}

describe("hosted observation projection", () => {
  test("coalesces provider tokens and pages UTF-8 without altering a frozen prefix", async () => {
    const memory = memoryStorage();
    const projection = createHostedProjection(memory.storage, identity, { pageBytes: 13 });
    for (let i = 0; i < 1000; i++) await projection.append(delta("λ🙂"));
    expect(memory.stats().writes).toBe(0);
    const first = await projection.snapshot();
    expect(memory.stats()).toMatchObject({ writes: 1, syncs: 1 });
    expect(first.cursor).toEqual({ ...identity, sequence: 1000 });
    await projection.append(delta("later"));
    const second = await projection.snapshot();
    const firstFrames = await readFrames(projection, first.snapshot_id);
    expect(firstFrames).toEqual([
      { first_sequence: 1, last_sequence: 1000, event: delta("λ🙂".repeat(1000)) },
    ]);
    const secondFrames = await readFrames(projection, second.snapshot_id);
    expect(secondFrames.length).toBe(2);
    expect(secondFrames[1]).toMatchObject({
      first_sequence: 1001,
      last_sequence: 1001,
      event: delta("later"),
    });
    await projection.close();
  });

  test("keeps attribution, reset, plans and workflow state in their original order", async () => {
    const memory = memoryStorage();
    const projection = createHostedProjection(memory.storage, identity);
    const events: RunEvent[] = [
      delta("lead"),
      delta("worker", { agent: "subagent", subagent_id: "child" }),
      delta("replacement", { reset: true }),
      { type: "plan_removed", at: 2, id: "plan-one", revision: 2, spec_revision: 1 },
      { type: "workflow_title_updated", at: 3, run_id: "run-one", title: "Updated title" },
      { type: "run_ended", at: 4, status: "completed" },
    ];
    for (const event of events) await projection.append(event);
    const snapshot = await projection.snapshot();
    expect(
      (await readFrames(projection, snapshot.snapshot_id)).map((frame) => frame.event),
    ).toEqual(events);
    await projection.close();
  });

  test("flushes a long token stream in bounded chunks instead of retaining all deltas", async () => {
    const memory = memoryStorage();
    const projection = createHostedProjection(memory.storage, identity, { chunkBytes: 512 });
    for (let i = 0; i < 1000; i++) await projection.append(delta("abcdef"));
    expect(projection.stats().pending_bytes).toBeLessThan(512);
    expect(memory.stats().writes).toBeGreaterThan(5);
    expect(memory.stats().writes).toBeLessThan(30);
    const snapshot = await projection.snapshot();
    const frames = await readFrames(projection, snapshot.snapshot_id);
    expect(
      frames
        .map((frame) => (frame.event as Extract<RunEvent, { type: "text_delta" }>).text)
        .join(""),
    ).toBe("abcdef".repeat(1000));
    expect(frames[0]?.first_sequence).toBe(1);
    expect(frames.at(-1)?.last_sequence).toBe(1000);
    await projection.close();
  });

  test("bounds and expires snapshots without evicting a still-valid reader", async () => {
    let time = 100;
    const memory = memoryStorage();
    const projection = createHostedProjection(memory.storage, identity, {
      maxSnapshots: 2,
      snapshotLifetimeMs: 10,
      now: () => time,
    });
    const one = await projection.snapshot();
    await projection.snapshot();
    await expect(projection.snapshot()).rejects.toMatchObject({ code: "conflict" });
    expect(await readFrames(projection, one.snapshot_id)).toEqual([]);
    projection.releaseSnapshot(one.snapshot_id);
    const three = await projection.snapshot();
    await expect(projection.readPage(three.snapshot_id, -1)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(projection.readPage(three.snapshot_id, 0.5)).rejects.toMatchObject({
      code: "invalid_request",
    });
    time = 110;
    await expect(projection.readPage(three.snapshot_id, 0)).rejects.toMatchObject({
      code: "not_found",
    });
    await projection.snapshot();
    expect(projection.stats().snapshots).toBe(1);
    await projection.close();
  });

  test("a storage failure is sticky and leaves earlier snapshots readable", async () => {
    const memory = memoryStorage();
    let fail = false;
    const projection = createHostedProjection(
      {
        ...memory.storage,
        async write(bytes, offset) {
          if (fail) throw new Error("disk full");
          await memory.storage.write(bytes, offset);
        },
      },
      identity,
    );
    await projection.append({ type: "run_started", at: 1 });
    const snapshot = await projection.snapshot();
    fail = true;
    await expect(
      projection.append({ type: "run_ended", at: 2, status: "completed" }),
    ).rejects.toThrow("disk full");
    await expect(projection.snapshot()).rejects.toThrow("disk full");
    await expect(projection.append(delta("ignored"))).rejects.toThrow("disk full");
    expect((await readFrames(projection, snapshot.snapshot_id)).length).toBe(1);
    await projection.close();
    expect(memory.stats().closed).toBe(true);
  });

  test("quota exhaustion rejects further handoffs instead of silently dropping history", async () => {
    const memory = memoryStorage();
    const projection = createHostedProjection(memory.storage, identity, { maxBytes: 1024 });
    await projection.append({ type: "run_started", at: 1 });
    await expect(projection.append(delta("x".repeat(1024)))).rejects.toThrow("byte quota");
    await expect(projection.snapshot()).rejects.toThrow("byte quota");
    expect(memory.stats().bytes).toBeLessThan(1024);
    await projection.close();
  });

  test("bounds queued operations and bytes before allocating more work", async () => {
    const memory = memoryStorage();
    const gate = Promise.withResolvers<void>();
    const projection = createHostedProjection(
      {
        ...memory.storage,
        async write(bytes, offset) {
          await gate.promise;
          await memory.storage.write(bytes, offset);
        },
      },
      identity,
      { maxPendingOperations: 2, maxPendingBytes: 1024 },
    );
    const first = projection.append({ type: "run_started", at: 1 });
    const second = projection.append(delta("second"));
    await expect(projection.append(delta("third"))).rejects.toMatchObject({ code: "conflict" });
    gate.resolve();
    await Promise.all([first, second]);
    await expect(projection.append(delta("x".repeat(1024)))).rejects.toMatchObject({
      code: "conflict",
    });
    const closing = projection.close();
    await expect(projection.append(delta("late"))).rejects.toMatchObject({ code: "unavailable" });
    await closing;
    expect(projection.close()).toBe(closing);
  });

  test("validates configured bounds and detects truncated snapshot reads", async () => {
    const memory = memoryStorage();
    expect(() => createHostedProjection(memory.storage, identity, { maxBytes: 0 })).toThrow(
      "positive safe integer",
    );
    expect(() => createHostedProjection(memory.storage, identity, { maxSnapshots: 1.5 })).toThrow(
      "positive safe integer",
    );
    expect(() =>
      createHostedProjection(memory.storage, identity, { pageBytes: 1024 * 1024 + 1 }),
    ).toThrow("1 MiB");
    const projection = createHostedProjection(
      { ...memory.storage, read: async () => new Uint8Array() },
      identity,
    );
    await projection.append({ type: "run_started", at: 1 });
    const snapshot = await projection.snapshot();
    await expect(projection.readPage(snapshot.snapshot_id, 0)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(projection.snapshot()).rejects.toThrow("incomplete");
    await projection.close();
  });
});
