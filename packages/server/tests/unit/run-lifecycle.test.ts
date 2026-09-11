import { describe, expect, it } from "bun:test";
import type { RunEvent, RunHandle } from "@clarvis/protocol";
import { createConcurrencyGate } from "../../src/host/live-runs.ts";
import type { ResolvedHost } from "../../src/host/run-host.ts";
import { handleRunTool } from "../../src/mcp/run-tool.ts";
import { buildMcpServer, type McpServerLimits } from "../../src/mcp/server.ts";
import { createManualTimeouts } from "../helpers/manual-timeouts.ts";

const LIMITS: McpServerLimits = {
  maxRuns: 1,
  maxRunsPerOwner: 1,
  bufferMax: 16,
  bufferMaxBytes: 1024 * 1024,
  sendTimeoutMs: 10_000,
  heartbeatMs: 60_000,
  runMaxMs: 60_000,
  settleGraceMs: 10_000,
  elicitToolWaitMs: 10_000,
  elicitRelayMs: 10_000,
  allowRemoteGuardApproval: false,
};

describe("run stream lifecycle", () => {
  it("absorbs an event-pump rejection and still returns the run result", async () => {
    const handle: RunHandle = {
      execution_id: "pump-rejected",
      events: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("event stream failed")),
        }),
      },
      done: Promise.resolve({
        execution_id: "pump-rejected",
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
    const resolved: ResolvedHost = {
      owner: "alice",
      host: { runs: { start: async () => handle } },
    };
    const gate = createConcurrencyGate({ perOwner: 1, global: 1 });
    const bundle = buildMcpServer({ resolved, limits: LIMITS, gate });

    const result = await handleRunTool(
      { prompt: "go", execution_id: "pump-rejected", elicitations: "auto_decline" },
      {
        resolved,
        runs: bundle.runs,
        gate,
        clientDeclaresElicitation: () => false,
        sendNotification: async () => {},
        getLevel: () => "debug",
        limits: LIMITS,
      },
      {},
    );

    expect(result.isError).not.toBeTrue();
    expect(bundle.runs.size).toBe(0);
  });

  it("emits heartbeat progress while a run remains open", async () => {
    const finish = Promise.withResolvers<{ execution_id: string; status: "completed" }>();
    const done = finish.promise;
    const handle: RunHandle = {
      execution_id: "heartbeat",
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
        }),
      },
      done,
      closed: done.then(() => undefined),
      steer: async () => {},
      compact: async () => {},
      cancel: async () => {},
      respond: async () => {},
      onElicit: () => {},
    };
    const resolved: ResolvedHost = {
      owner: "alice",
      host: { runs: { start: async () => handle } },
    };
    const gate = createConcurrencyGate({ perOwner: 1, global: 1 });
    const limits = { ...LIMITS, heartbeatMs: 1 };
    const bundle = buildMcpServer({ resolved, limits, gate });
    let progress = 0;

    await handleRunTool(
      { prompt: "go", execution_id: "heartbeat", elicitations: "auto_decline" },
      {
        resolved,
        runs: bundle.runs,
        gate,
        clientDeclaresElicitation: () => false,
        sendNotification: async (notification) => {
          if (notification.method === "notifications/progress") {
            progress += 1;
            finish.resolve({ execution_id: "heartbeat", status: "completed" });
          }
        },
        getLevel: () => "debug",
        limits,
      },
      { progressToken: "heartbeat-token" },
    );

    expect(progress).toBeGreaterThan(0);
  });

  it("cancels a started handle when its returned execution id collides", async () => {
    let cancelled = 0;
    const occupiedHandle: RunHandle = {
      execution_id: "occupied",
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
        }),
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
    const resolved: ResolvedHost = {
      owner: "alice",
      host: { runs: { start: async () => occupiedHandle } },
    };
    const gate = createConcurrencyGate({ perOwner: 2, global: 2 });
    const bundle = buildMcpServer({ resolved, limits: { ...LIMITS, maxRuns: 2 }, gate });
    bundle.runs.add({
      executionId: "occupied",
      owner: "alice",
      handle: occupiedHandle,
      startedAt: Date.now(),
      elicit: { dispose: () => {} } as never,
      lifecycleDone: new Promise(() => {}),
    });

    const result = await handleRunTool(
      { prompt: "go", execution_id: "requested", elicitations: "auto_decline" },
      {
        resolved,
        runs: bundle.runs,
        gate,
        clientDeclaresElicitation: () => false,
        sendNotification: async () => {},
        getLevel: () => "debug",
        limits: LIMITS,
      },
      {},
    );

    expect(result.isError).toBeTrue();
    expect(cancelled).toBe(1);
    expect(gate.total).toBe(0);
  });

  it("keeps the live run and gate slot through the event pump and sink flush", async () => {
    let firstEvent = true;
    let finishPump!: () => void;
    let markPumpWaiting!: () => void;
    const pumpWaiting = new Promise<void>((resolve) => {
      markPumpWaiting = resolve;
    });
    const heldPump = new Promise<IteratorResult<RunEvent>>((resolve) => {
      finishPump = () => resolve({ done: true, value: undefined });
    });
    const iterator: AsyncIterator<RunEvent> = {
      next() {
        if (firstEvent) {
          firstEvent = false;
          return Promise.resolve({
            done: false,
            value: { type: "run_started", at: 1 } satisfies RunEvent,
          });
        }
        markPumpWaiting();
        return heldPump;
      },
    };
    const handle: RunHandle = {
      execution_id: "lifecycle-run",
      events: { [Symbol.asyncIterator]: () => iterator },
      done: Promise.resolve({
        execution_id: "lifecycle-run",
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
    const resolved: ResolvedHost = {
      owner: "alice",
      host: { runs: { start: async () => handle } },
    };
    const gate = createConcurrencyGate({ perOwner: 1, global: 1 });
    const bundle = buildMcpServer({ resolved, limits: LIMITS, gate });

    let releaseSend!: () => void;
    const heldSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markStreamSendStarted!: () => void;
    const streamSendStarted = new Promise<void>((resolve) => {
      markStreamSendStarted = resolve;
    });
    const running = handleRunTool(
      { prompt: "go", execution_id: "lifecycle-run", elicitations: "auto_decline" },
      {
        resolved,
        runs: bundle.runs,
        gate,
        clientDeclaresElicitation: () => false,
        sendNotification: async (notification) => {
          const data = notification.params.data as { type?: string } | undefined;
          if (data?.type === "run_started") {
            markStreamSendStarted();
            await heldSend;
          }
        },
        getLevel: () => "debug",
        limits: LIMITS,
      },
      {},
    );

    await Promise.all([pumpWaiting, streamSendStarted]);
    const live = bundle.runs.require("lifecycle-run");
    let lifecycleSettled = false;
    void live.lifecycleDone.then(() => {
      lifecycleSettled = true;
    });
    const draining = bundle.drain(10_000);
    let drainSettled = false;
    void draining.then(() => {
      drainSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(bundle.runs.size).toBe(1);
    expect(gate.total).toBe(1);
    expect(lifecycleSettled).toBeFalse();
    expect(drainSettled).toBeFalse();

    finishPump();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bundle.runs.size).toBe(1);
    expect(gate.total).toBe(1);
    expect(lifecycleSettled).toBeFalse();
    expect(drainSettled).toBeFalse();

    releaseSend();
    const [result, drained] = await Promise.all([running, draining]);

    expect(drained).toBeTrue();
    expect(result.isError).not.toBeTrue();
    expect(lifecycleSettled).toBeTrue();
    expect(bundle.runs.size).toBe(0);
    expect(gate.total).toBe(0);
  });

  it("keeps the live run and gate slot until RunHandle.closed settles", async () => {
    let closeHandle!: () => void;
    const closed = new Promise<void>((resolve) => {
      closeHandle = resolve;
    });
    const handle: RunHandle = {
      execution_id: "held-closed",
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
        }),
      },
      done: Promise.resolve({
        execution_id: "held-closed",
        status: "completed",
        result: "done",
      }),
      closed,
      steer: async () => {},
      compact: async () => {},
      cancel: async () => {},
      respond: async () => {},
      onElicit: () => {},
    };
    const resolved: ResolvedHost = {
      owner: "alice",
      host: { runs: { start: async () => handle } },
    };
    const gate = createConcurrencyGate({ perOwner: 1, global: 1 });
    const bundle = buildMcpServer({ resolved, limits: LIMITS, gate });
    let accepted!: () => void;
    const runAccepted = new Promise<void>((resolve) => {
      accepted = resolve;
    });

    const running = handleRunTool(
      { prompt: "go", execution_id: "held-closed", elicitations: "auto_decline" },
      {
        resolved,
        runs: bundle.runs,
        gate,
        clientDeclaresElicitation: () => false,
        sendNotification: async (notification) => {
          if (
            (notification.params.data as { type?: string } | undefined)?.type === "run_accepted"
          ) {
            accepted();
          }
        },
        getLevel: () => "debug",
        limits: LIMITS,
      },
      {},
    );

    await runAccepted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bundle.runs.size).toBe(1);
    expect(gate.total).toBe(1);

    closeHandle();
    const result = await running;
    expect(result.isError).not.toBeTrue();
    expect(bundle.runs.size).toBe(0);
    expect(gate.total).toBe(0);
  });

  it("releases after two explicit settle deadlines when the stream and handle never close", async () => {
    const timeouts = createManualTimeouts();
    let returned = false;
    const iterator: AsyncIterator<RunEvent> = {
      next: () => new Promise<IteratorResult<RunEvent>>(() => {}),
      return: () => {
        returned = true;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    const handle: RunHandle = {
      execution_id: "never-closed",
      events: { [Symbol.asyncIterator]: () => iterator },
      done: Promise.resolve({
        execution_id: "never-closed",
        status: "completed",
        result: "done",
      }),
      closed: new Promise<void>(() => {}),
      steer: async () => {},
      compact: async () => {},
      cancel: async () => {},
      respond: async () => {},
      onElicit: () => {},
    };
    const resolved: ResolvedHost = {
      owner: "alice",
      host: { runs: { start: async () => handle } },
    };
    const gate = createConcurrencyGate({ perOwner: 1, global: 1 });
    const bundle = buildMcpServer({ resolved, limits: LIMITS, gate });

    const running = handleRunTool(
      { prompt: "go", execution_id: "never-closed", elicitations: "auto_decline" },
      {
        resolved,
        runs: bundle.runs,
        gate,
        clientDeclaresElicitation: () => false,
        sendNotification: async () => {},
        getLevel: () => "debug",
        limits: LIMITS,
        scheduleTimeout: timeouts.schedule,
      },
      {},
    );

    for (let pass = 0; pass < 10 && timeouts.pending === 0; pass += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(timeouts.pending).toBe(1);
    expect(bundle.runs.size).toBe(1);
    expect(gate.total).toBe(1);

    timeouts.fireNext();
    for (let pass = 0; pass < 10 && (!returned || timeouts.pending === 0); pass += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(returned).toBeTrue();
    expect(timeouts.pending).toBe(1);
    expect(gate.total).toBe(1);

    timeouts.fireNext();
    const result = await running;
    expect(result._meta?.["dev.clarvis/stream"]).toMatchObject({ truncated: true });
    expect(bundle.runs.size).toBe(0);
    expect(gate.total).toBe(0);
  });
});
