import { describe, expect, it } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "@clarvis/capability";
import type { MCPClientHandle } from "../../src/client.ts";
import {
  createResilientSession,
  DEFAULT_MCP_CLOSE_GRACE_MS,
  MAX_MCP_CLOSE_GRACE_MS,
  normalizeMcpCloseGraceMs,
  type ResilientSession,
  type ResilientSessionOptions,
  type ResilientSessionRuntime,
  type ResilientSessionTimer,
} from "../../src/resilient-session.ts";
import { interpretCallResult } from "../../src/tool-results.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ScheduledTask {
  at: number;
  callback: () => void | Promise<void>;
  cancelled: boolean;
}

class FakeRuntime implements ResilientSessionRuntime {
  private current = 0;
  private readonly tasks: ScheduledTask[] = [];

  now(): number {
    return this.current;
  }

  schedule(callback: () => void | Promise<void>, delayMs: number): ResilientSessionTimer {
    const task: ScheduledTask = {
      at: this.current + delayMs,
      callback,
      cancelled: false,
    };
    this.tasks.push(task);
    return { cancel: () => (task.cancelled = true) };
  }

  pending(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (true) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.cancelled = true;
      this.current = next.at;
      await next.callback();
    }
    this.current = target;
  }
}

interface HandleOptions {
  call?: () => unknown | Promise<unknown>;
  ping?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
}

function handle(options: HandleOptions = {}): MCPClientHandle {
  return {
    client: {
      callTool: async () => (options.call ? options.call() : "ok"),
      ping: async () => options.ping?.(),
    } as any,
    close: async () => options.close?.(),
  };
}

function session(
  initialHandle: MCPClientHandle,
  reconnect: () => Promise<MCPClientHandle>,
  overrides: Partial<ResilientSessionOptions> = {},
): ResilientSession {
  return createResilientSession({
    initialHandle,
    reconnect,
    mcpName: "m",
    callTimeoutMs: 100,
    connectTimeoutMs: 100,
    reprobeCooldownMs: 10,
    timeoutStreakThreshold: 3,
    healthPingIntervalMs: 0,
    eventBase: { scope: { workspace: "/ws", owner: "o" }, mcp_name: "m", transport: "stdio" },
    ...overrides,
  });
}

function invoke(resilient: ResilientSession, signal?: AbortSignal): Promise<ToolResult> {
  return resilient.invoke(
    "t",
    (active) => active.client.callTool({ name: "t" }),
    (raw) => ({ ok: true, data: raw }),
    signal,
  );
}

describe("resilient session — invocation state", () => {
  it("single-flights concurrent reconnects without replaying interrupted operations", async () => {
    let reconnects = 0;
    const reconnectGate = deferred<MCPClientHandle>();
    const resilient = session(
      handle({ call: () => Promise.reject(new Error("drop")) }),
      async () => {
        reconnects += 1;
        return reconnectGate.promise;
      },
    );

    const first = invoke(resilient);
    const second = invoke(resilient);
    await Promise.resolve();
    reconnectGate.resolve(handle());

    const results = await Promise.all([first, second]);
    expect(reconnects).toBe(1);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(resilient.status).toBe("connected");
    await resilient.close();
  });

  it("reconnects after one transport failure without replaying it, then uses the fresh handle", async () => {
    let freshCalls = 0;
    const resilient = session(handle({ call: () => Promise.reject(new Error("drop")) }), async () =>
      handle({
        call: () => {
          freshCalls += 1;
          return "fresh";
        },
      }),
    );

    const interrupted = await invoke(resilient);
    expect(interrupted.error?.message).toContain("may or may not have executed");
    expect(freshCalls).toBe(0);
    expect((await invoke(resilient)).data).toBe("fresh");
    expect(freshCalls).toBe(1);
    await resilient.close();
  });

  // The consequence of the nullish guard in interpretCallResult, seen through
  // the composition that actually runs it: connection.ts hands the mapper to
  // session.invoke, which calls it INSIDE the transport try. Before the guard, a
  // null response made the mapper throw a TypeError that missed both
  // isMcpRequestTimeout and isMcpProtocolError, so the session read it as a
  // dropped connection — reconnecting, telling the caller the call "may or may
  // not have executed", and blacking the server out on the second one.
  it("reports a null tool response as an operational error without faulting the transport", async () => {
    let reconnects = 0;
    const resilient = session(handle({ call: () => null }), async () => {
      reconnects += 1;
      return handle();
    });

    const mapNull = (raw: unknown): ToolResult => interpretCallResult(raw, "t");
    const first = await resilient.invoke(
      "t",
      (active) => active.client.callTool({ name: "t" }),
      mapNull,
    );
    expect(first.error).toEqual({
      code: "mcp_runtime_error",
      message: "Tool 't' returned no result.",
      kind: "operational",
    });
    expect(first.error?.outcome).toBeUndefined();
    expect(reconnects).toBe(0);

    const second = await resilient.invoke(
      "t",
      (active) => active.client.callTool({ name: "t" }),
      mapNull,
    );
    expect(second.error?.code).toBe("mcp_runtime_error");
    expect(resilient.status).toBe("connected");
    await resilient.close();
  });

  it("opens the transport circuit after two generations, then emits a paired recovery", async () => {
    const runtime = new FakeRuntime();
    const events: Array<{ state: string; cause?: string }> = [];
    let reconnects = 0;
    const resilient = session(
      handle({ call: () => Promise.reject(new Error("drop-1")) }),
      async () => {
        reconnects += 1;
        return reconnects === 1
          ? handle({ call: () => Promise.reject(new Error("drop-2")) })
          : handle();
      },
      {
        runtime,
        reprobeCooldownMs: 10,
        onEvent: ({ state, cause }) => events.push({ state, ...(cause ? { cause } : {}) }),
      },
    );

    expect((await invoke(resilient)).error?.code).toBe("mcp_runtime_error");
    const circuitOpening = await invoke(resilient);
    expect(circuitOpening.error).toMatchObject({
      code: "mcp_unavailable",
      outcome: "unknown",
    });
    expect(resilient.status).toBe("unavailable");
    expect(events).toEqual([{ state: "unavailable", cause: "transport" }]);

    await runtime.advance(10);
    expect((await invoke(resilient)).ok).toBe(true);
    expect(events).toEqual([{ state: "unavailable", cause: "transport" }, { state: "recovered" }]);
    await resilient.close();
  });

  it("a success resets the transport-failure streak", async () => {
    let freshCalls = 0;
    let reconnects = 0;
    const resilient = session(
      handle({ call: () => Promise.reject(new Error("drop-1")) }),
      async () => {
        reconnects += 1;
        if (reconnects === 1)
          return handle({
            call: () => {
              freshCalls += 1;
              if (freshCalls === 1) return "ok";
              throw new Error("drop-2");
            },
          });
        return handle();
      },
    );

    expect((await invoke(resilient)).ok).toBe(false);
    expect((await invoke(resilient)).ok).toBe(true);
    expect((await invoke(resilient)).error?.code).toBe("mcp_runtime_error");
    expect(resilient.status).toBe("connected");
    expect(reconnects).toBe(2);
    await resilient.close();
  });

  it("opens the timeout circuit at its threshold, emits once, and honors cooldown", async () => {
    const runtime = new FakeRuntime();
    const events: string[] = [];
    let reconnects = 0;
    const resilient = session(
      handle({ call: () => Promise.reject(new McpError(ErrorCode.RequestTimeout, "slow")) }),
      async () => {
        reconnects += 1;
        return handle();
      },
      {
        runtime,
        timeoutStreakThreshold: 2,
        reprobeCooldownMs: 1_000,
        onEvent: (event) => events.push(event.state),
      },
    );

    expect((await invoke(resilient)).error?.code).toBe("mcp_timeout");
    const thresholdFailure = await invoke(resilient);
    expect(thresholdFailure.error).toMatchObject({
      code: "mcp_unavailable",
      outcome: "unknown",
    });
    const shortCircuited = await invoke(resilient);
    expect(shortCircuited.error?.code).toBe("mcp_unavailable");
    expect(shortCircuited.error?.outcome).toBeUndefined();
    expect(reconnects).toBe(0);
    expect(events).toEqual(["unavailable"]);

    await runtime.advance(1_000);
    expect((await invoke(resilient)).ok).toBe(true);
    expect(reconnects).toBe(1);
    expect(events).toEqual(["unavailable", "recovered"]);
    await resilient.close();
  });

  it("a success resets the timeout streak", async () => {
    let calls = 0;
    const resilient = session(
      handle({
        call: () => {
          calls += 1;
          if (calls === 2) return "ok";
          throw new McpError(ErrorCode.RequestTimeout, "slow");
        },
      }),
      async () => handle(),
      { timeoutStreakThreshold: 2 },
    );

    expect((await invoke(resilient)).error?.code).toBe("mcp_timeout");
    expect((await invoke(resilient)).ok).toBe(true);
    expect((await invoke(resilient)).error?.code).toBe("mcp_timeout");
    expect(resilient.status).toBe("connected");
    await resilient.close();
  });

  it("treats protocol errors as per-call failures without reconnecting", async () => {
    let reconnects = 0;
    const resilient = session(
      handle({
        call: () => Promise.reject(new McpError(ErrorCode.InvalidParams, "bad params")),
      }),
      async () => {
        reconnects += 1;
        return handle();
      },
    );

    const result = await invoke(resilient);
    expect(result.error?.code).toBe("mcp_runtime_error");
    expect(result.error?.message).toContain("bad params");
    expect(reconnects).toBe(0);
    expect(resilient.status).toBe("connected");
    await resilient.close();
  });

  it("returns aborted without reconnecting when the call signal is already aborted", async () => {
    let calls = 0;
    let reconnects = 0;
    const controller = new AbortController();
    controller.abort();
    const resilient = session(
      handle({
        call: () => {
          calls += 1;
          throw new Error("cancelled transport");
        },
      }),
      async () => {
        reconnects += 1;
        return handle();
      },
    );

    const result = await invoke(resilient, controller.signal);
    expect(result.error?.message).toContain("aborted");
    expect(result.error?.outcome).toBeUndefined();
    expect(calls).toBe(0);
    expect(reconnects).toBe(0);
    await resilient.close();
  });

  it("returns aborted when cancellation happens during a failing reconnect", async () => {
    const controller = new AbortController();
    const resilient = session(
      handle({ call: () => Promise.reject(new Error("drop")) }),
      async () => {
        controller.abort();
        throw new Error("reconnect failed");
      },
    );

    const result = await invoke(resilient, controller.signal);
    expect(result.error?.message).toContain("aborted");
    expect(result.error?.outcome).toBe("unknown");
    expect(resilient.status).toBe("unavailable");
    await resilient.close();
  });

  it("marks cancellation after dispatch as an unknown outcome", async () => {
    const controller = new AbortController();
    const resilient = session(
      handle({
        call: async () => {
          controller.abort();
          throw new Error("cancelled transport");
        },
      }),
      async () => handle(),
    );

    const result = await invoke(resilient, controller.signal);
    expect(result.error).toMatchObject({ kind: "cancelled", outcome: "unknown" });
    await resilient.close();
  });

  it("short-circuits calls after close", async () => {
    const resilient = session(handle(), async () => handle());
    await resilient.close();
    expect((await invoke(resilient)).error?.code).toBe("mcp_unavailable");
  });
});

describe("resilient session — health and lifecycle", () => {
  it("uses the health ping to reconnect an idle failed session", async () => {
    const runtime = new FakeRuntime();
    let reconnects = 0;
    const resilient = session(
      handle({ ping: () => Promise.reject(new Error("dead")) }),
      async () => {
        reconnects += 1;
        return handle();
      },
      { runtime, healthPingIntervalMs: 5 },
    );

    await runtime.advance(5);
    expect(reconnects).toBe(1);
    expect(resilient.status).toBe("connected");
    await resilient.close();
  });

  it("marks unavailable when an idle health reconnect fails", async () => {
    const runtime = new FakeRuntime();
    const events: string[] = [];
    const resilient = session(
      handle({ ping: () => Promise.reject(new Error("dead")) }),
      async () => Promise.reject(new Error("cannot reconnect")),
      {
        runtime,
        healthPingIntervalMs: 5,
        onEvent: (event) => events.push(`${event.state}:${event.cause ?? "none"}`),
      },
    );

    await runtime.advance(5);
    expect(resilient.status).toBe("unavailable");
    expect(events).toEqual(["unavailable:reconnect_failed"]);
    await resilient.close();
  });

  it("does not schedule health checks when disabled", async () => {
    const runtime = new FakeRuntime();
    const resilient = session(handle(), async () => handle(), {
      runtime,
      healthPingIntervalMs: 0,
    });
    expect(runtime.pending()).toBe(0);
    await resilient.close();
  });

  it("skips health ping while a call is in flight", async () => {
    const runtime = new FakeRuntime();
    const call = deferred<unknown>();
    let pings = 0;
    const resilient = session(
      handle({
        call: () => call.promise,
        ping: () => {
          pings += 1;
        },
      }),
      async () => handle(),
      { runtime, healthPingIntervalMs: 5 },
    );

    const running = invoke(resilient);
    await runtime.advance(5);
    expect(pings).toBe(0);
    call.resolve("ok");
    await running;
    await resilient.close();
  });

  it("closes once while a reconnect is pending and closes the late fresh handle", async () => {
    const reconnectGate = deferred<MCPClientHandle>();
    let initialCloses = 0;
    let freshCloses = 0;
    const resilient = session(
      handle({
        call: () => Promise.reject(new Error("drop")),
        close: () => {
          initialCloses += 1;
        },
      }),
      async () => reconnectGate.promise,
    );

    const call = invoke(resilient);
    await Promise.resolve();
    const closing = resilient.close();
    reconnectGate.resolve(
      handle({
        close: () => {
          freshCloses += 1;
        },
      }),
    );
    await Promise.all([call, closing, resilient.close()]);

    expect(initialCloses).toBeGreaterThanOrEqual(1);
    expect(freshCloses).toBe(1);
  });

  it("returns at its grace when a reconnect never settles", async () => {
    const runtime = new FakeRuntime();
    const reconnectStarted = deferred<void>();
    const neverReconnect = new Promise<MCPClientHandle>(() => {});
    let initialCloses = 0;
    const resilient = session(
      handle({
        call: () => Promise.reject(new Error("drop")),
        close: () => {
          initialCloses += 1;
        },
      }),
      async () => {
        reconnectStarted.resolve();
        return neverReconnect;
      },
      { runtime, closeGraceMs: 5 },
    );

    void invoke(resilient);
    await reconnectStarted.promise;
    let closed = false;
    const closing = resilient.close().then(() => {
      closed = true;
    });
    await runtime.advance(4);
    expect(closed).toBe(false);
    await runtime.advance(1);
    await closing;
    expect(closed).toBe(true);
    expect(initialCloses).toBeGreaterThanOrEqual(1);
  });

  it("returns at its grace when the active handle close never settles", async () => {
    const runtime = new FakeRuntime();
    const resilient = session(
      handle({ close: () => new Promise<void>(() => {}) }),
      async () => handle(),
      { runtime, closeGraceMs: 5 },
    );

    let closed = false;
    const closing = resilient.close().then(() => {
      closed = true;
    });
    await runtime.advance(4);
    expect(closed).toBe(false);
    await runtime.advance(1);
    await closing;
    expect(closed).toBe(true);
    expect(await resilient.close()).toBeUndefined();
  });

  it("normalizes non-finite close graces to the finite default", async () => {
    const runtime = new FakeRuntime();
    const resilient = session(
      handle({ close: () => new Promise<void>(() => {}) }),
      async () => handle(),
      { runtime, closeGraceMs: Number.POSITIVE_INFINITY },
    );

    let closed = false;
    const closing = resilient.close().then(() => {
      closed = true;
    });
    await runtime.advance(1_999);
    expect(closed).toBe(false);
    await runtime.advance(1);
    await closing;
    expect(closed).toBe(true);
  });

  it("cancels the armed health timer and emits closed exactly once", async () => {
    const runtime = new FakeRuntime();
    const events: string[] = [];
    const resilient = session(handle(), async () => handle(), {
      runtime,
      healthPingIntervalMs: 5,
      onEvent: (event) => events.push(event.state),
    });

    expect(runtime.pending()).toBe(1);
    await resilient.close();
    await resilient.close();
    expect(runtime.pending()).toBe(0);
    expect(events).toEqual(["closed"]);
  });

  it("does not emit unavailable after close when a background reconnect later fails", async () => {
    const runtime = new FakeRuntime();
    const reconnectGate = deferred<MCPClientHandle>();
    const reconnectStarted = deferred<boolean>();
    const events: string[] = [];
    const resilient = session(
      handle({ ping: () => Promise.reject(new Error("dead")) }),
      async () => {
        reconnectStarted.resolve(true);
        return reconnectGate.promise;
      },
      {
        runtime,
        healthPingIntervalMs: 5,
        onEvent: (event) => events.push(event.state),
      },
    );

    const health = runtime.advance(5);
    await reconnectStarted.promise;
    const closing = resilient.close();
    reconnectGate.reject(new Error("cannot reconnect"));
    await Promise.all([health, closing]);

    expect(events).toEqual(["closed"]);
  });
});

/**
 * A shutdown grace is a programmatic input, so it is bounded on both ends.
 *
 * @remarks The suite only ever passed `5` or a non-finite value, which covers
 * the floor and the fallback and leaves the upper clamp — the half that exists
 * so a caller cannot turn shutdown into an unbounded wait — asserted by nothing.
 */
describe("normalizeMcpCloseGraceMs", () => {
  it("falls back to the default when unset or non-finite", () => {
    expect(normalizeMcpCloseGraceMs(undefined)).toBe(DEFAULT_MCP_CLOSE_GRACE_MS);
    expect(normalizeMcpCloseGraceMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MCP_CLOSE_GRACE_MS);
    expect(normalizeMcpCloseGraceMs(Number.NaN)).toBe(DEFAULT_MCP_CLOSE_GRACE_MS);
  });

  it("clamps above the hard bound, so no caller can wait forever", () => {
    expect(normalizeMcpCloseGraceMs(MAX_MCP_CLOSE_GRACE_MS + 1)).toBe(MAX_MCP_CLOSE_GRACE_MS);
    expect(normalizeMcpCloseGraceMs(3_600_000)).toBe(MAX_MCP_CLOSE_GRACE_MS);
    expect(normalizeMcpCloseGraceMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_MCP_CLOSE_GRACE_MS);
  });

  it("keeps the bound itself, so the clamp is inclusive", () => {
    expect(normalizeMcpCloseGraceMs(MAX_MCP_CLOSE_GRACE_MS)).toBe(MAX_MCP_CLOSE_GRACE_MS);
  });

  it("floors at zero rather than passing a negative wait through", () => {
    expect(normalizeMcpCloseGraceMs(-1)).toBe(0);
    expect(normalizeMcpCloseGraceMs(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_MCP_CLOSE_GRACE_MS);
  });

  it("truncates a fractional grace to whole milliseconds", () => {
    expect(normalizeMcpCloseGraceMs(1_500.9)).toBe(1_500);
  });
});
