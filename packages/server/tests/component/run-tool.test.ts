import { afterEach, describe, it, expect } from "bun:test";
import type { RunEvent, RunHandle } from "@clarvis/protocol";
import type { RunHost } from "../../src/host/run-host.ts";
import { createFakeRunHost } from "../helpers/fake-run-host.ts";
import { closeOpenHarnesses, makeHarness, payloadOf } from "../helpers/harness.ts";
import { TOOL_NAMES } from "../../src/mcp/tools.ts";

afterEach(closeOpenHarnesses);

describe("tool surface", () => {
  it("accepts the standard MCP logging level request", async () => {
    const h = await makeHarness({ host: createFakeRunHost(() => ({})) });

    await expect(h.client.setLoggingLevel("warning")).resolves.toEqual({});
    await h.close();
  });

  it("requires exactly one of prompt or messages", async () => {
    const host = createFakeRunHost(() => ({}));
    const h = await makeHarness({ host });

    const neither = await h.client.callTool({ name: TOOL_NAMES.run, arguments: {} });
    expect(neither.isError).toBe(true);
    expect(JSON.stringify(payloadOf(neither))).toContain("exactly one");

    const both = await h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "hi", messages: [{ role: "user", content: "hi" }] },
    });
    expect(both.isError).toBe(true);
    expect(host.started).toHaveLength(0);
    await h.close();
  });

  it("runs to completion and echoes the execution id, posture and stream stats", async () => {
    const host = createFakeRunHost(() => ({
      events: [{ type: "run_started", at: 1 }],
      result: { result: "all done" },
    }));
    const h = await makeHarness({ host });

    const out = payloadOf(
      await h.client.callTool({
        name: TOOL_NAMES.run,
        arguments: { prompt: "do it", agent: "solo", execution_id: "run-a" },
      }),
    );

    expect(out.execution_id).toBe("run-a");
    expect(out.status).toBe("completed");
    expect(out.result).toBe("all done");
    expect(out.posture).toMatchObject({
      elicitation: "auto_decline",
      guard_confirmations: "denied",
    });
    expect(out.stream).toMatchObject({ wedged: false });
    expect(host.started[0]).toMatchObject({ agent: "solo", execution_id: "run-a" });
    await h.close();
  });

  it("returns a structured tool error and releases admission when run startup fails", async () => {
    const host: RunHost = {
      runs: {
        start: async () => {
          throw Object.assign(new Error("provider unavailable"), { code: "unavailable" });
        },
      },
    };
    const h = await makeHarness({ host, limits: { maxRuns: 1, maxRunsPerOwner: 1 } });

    const first = await h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "do it", execution_id: "start-failure-1" },
    });
    const second = await h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "try again", execution_id: "start-failure-2" },
    });

    expect(first.isError).toBeTrue();
    expect(payloadOf(first)).toMatchObject({
      error: { code: "unavailable", message: "provider unavailable" },
    });
    expect(second.isError).toBeTrue();
    expect(payloadOf(second)).toMatchObject({ error: { code: "unavailable" } });
    await h.close();
  });

  it("returns after the result grace and marks a stream whose iterator has not closed", async () => {
    let returned = false;
    let finishPending: ((value: IteratorResult<RunEvent>) => void) | undefined;
    let first = true;
    const iterator: AsyncIterator<RunEvent> = {
      next() {
        if (first) {
          first = false;
          return Promise.resolve({ done: false, value: { type: "run_started", at: 1 } });
        }
        return new Promise((resolve) => {
          finishPending = resolve;
        });
      },
      return() {
        returned = true;
        finishPending?.({ done: true, value: undefined });
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    const handle: RunHandle = {
      execution_id: "run-truncated",
      events: { [Symbol.asyncIterator]: () => iterator },
      done: Promise.resolve({
        execution_id: "run-truncated",
        status: "completed",
        result: "done",
      }),
      closed: Promise.resolve(),
      steer: async () => {},
      compact: async () => {},
      cancel: async () => {},
      respond: async () => {},
      onElicit: () => {},
    };
    const host: RunHost = { runs: { start: async () => handle } };
    const h = await makeHarness({ host, limits: { settleGraceMs: 1 } });

    const result = await h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "do it", execution_id: "run-truncated" },
    });
    const stream = (result._meta as Record<string, unknown> | undefined)?.["dev.clarvis/stream"];
    expect(stream).toMatchObject({ truncated: true });
    expect(returned).toBeTrue();
    await h.close();
  });

  it("cancels at the server wall-clock cap and reports that terminal reason", async () => {
    const host = createFakeRunHost(() => ({ holdUntil: new Promise<void>(() => {}) }));
    const h = await makeHarness({ host, limits: { runMaxMs: 1 } });

    const result = payloadOf(
      await h.client.callTool({
        name: TOOL_NAMES.run,
        arguments: { prompt: "wait", execution_id: "wall-clock" },
      }),
    );

    expect(result).toMatchObject({
      execution_id: "wall-clock",
      status: "cancelled",
      ended_reason: "server_wall_clock_cap",
    });
    expect(host.cancels).toEqual(["wall-clock"]);
    await h.close();
  });

  it("maps a rejected run result to an internal failure envelope", async () => {
    const failure = new Error("result channel failed");
    const handle: RunHandle = {
      execution_id: "done-rejected",
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
        }),
      },
      done: Promise.reject(failure),
      closed: Promise.resolve(),
      steer: async () => {},
      compact: async () => {},
      cancel: async () => {},
      respond: async () => {},
      onElicit: () => {},
    };
    const host: RunHost = { runs: { start: async () => handle } };
    const h = await makeHarness({ host });

    const result = payloadOf(
      await h.client.callTool({
        name: TOOL_NAMES.run,
        arguments: { prompt: "go", execution_id: "done-rejected" },
      }),
    );

    expect(result).toMatchObject({
      execution_id: "done-rejected",
      status: "failed",
      error: { code: "internal", message: "result channel failed" },
    });
    await h.close();
  });

  it("cancels a live run when its tool request aborts after admission", async () => {
    const host = createFakeRunHost(() => ({ holdUntil: new Promise<void>(() => {}) }));
    const h = await makeHarness({ host });
    const controller = new AbortController();
    const pending = h.client.callTool(
      {
        name: TOOL_NAMES.run,
        arguments: { prompt: "wait", execution_id: "abort-live" },
      },
      undefined,
      { signal: controller.signal },
    );
    await h.waitForMessage(
      (message) =>
        (message.data as { type?: string; execution_id?: string }).type === "run_accepted" &&
        (message.data as { execution_id?: string }).execution_id === "abort-live",
    );

    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await host.settled();
    expect(host.cancels).toContain("abort-live");
    await h.close();
  });

  it("cancels and releases a run whose event iterator cannot be opened", async () => {
    let cancelled = 0;
    const handle: RunHandle = {
      execution_id: "iterator-failure",
      events: {
        [Symbol.asyncIterator]() {
          throw new Error("iterator failed");
        },
      },
      done: new Promise(() => {}),
      closed: Promise.resolve(),
      steer: async () => {},
      compact: async () => {},
      cancel: async () => {
        cancelled += 1;
      },
      respond: async () => {},
      onElicit: () => {},
    };
    const h = await makeHarness({ host: { runs: { start: async () => handle } } });

    const result = await h.client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "go", execution_id: "iterator-failure" },
    });

    expect(result.isError).toBeTrue();
    expect(cancelled).toBe(1);
    expect(h.bundle.runs.size).toBe(0);
    await h.close();
  });

  it("cancels a handle when the request aborts while runs.start is pending", async () => {
    const backing = createFakeRunHost(() => ({ holdUntil: new Promise<void>(() => {}) }));
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const host: RunHost = {
      runs: {
        async start(params) {
          startEntered();
          await startGate;
          return backing.runs.start(params);
        },
      },
    };
    const h = await makeHarness({ host });
    const controller = new AbortController();
    const pending = h.client.callTool(
      {
        name: TOOL_NAMES.run,
        arguments: { prompt: "do it", execution_id: "abort-during-start" },
      },
      undefined,
      { signal: controller.signal },
    );

    await entered;
    controller.abort();
    releaseStart();
    await expect(pending).rejects.toBeDefined();
    await backing.waitForStart("abort-during-start");
    await Promise.resolve();
    await Promise.resolve();
    expect(backing.cancels).toContain("abort-during-start");
    await h.close();
  });
});
