import { describe, expect, it } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "@clarvis/capability";
import type { MCPClientHandle } from "../../src/client.ts";
import {
  createResilientSession,
  type ResilientSession,
  type ResilientSessionOptions,
  type ResilientSessionRuntime,
  type ResilientSessionTimer,
} from "../../src/resilient-session.ts";
import { createRecordingLogger } from "../helpers/recording-logger.ts";

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
    const task: ScheduledTask = { at: this.current + delayMs, callback, cancelled: false };
    this.tasks.push(task);
    return { cancel: () => (task.cancelled = true) };
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
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
}

function handle(options: HandleOptions = {}): MCPClientHandle {
  return {
    client: {
      callTool: async () => (options.call ? options.call() : "ok"),
      ping: async () => options.ping?.(),
    } as any,
    close: async () => {},
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
    mcpName: "docs",
    callTimeoutMs: 100,
    connectTimeoutMs: 100,
    reprobeCooldownMs: 10,
    timeoutStreakThreshold: 3,
    healthPingIntervalMs: 0,
    eventBase: {
      scope: { workspace: "/ws", owner: "owner" },
      mcp_name: "docs",
      transport: "stdio",
    },
    ...overrides,
  });
}

function invoke(resilient: ResilientSession, signal?: AbortSignal): Promise<ToolResult> {
  return resilient.invoke(
    "search",
    (active) => active.client.callTool({ name: "search" }),
    (raw) => ({ ok: true, data: raw }),
    signal,
  );
}

function timeoutError(): McpError {
  return new McpError(ErrorCode.RequestTimeout, "timed out");
}

describe("resilient session observability", () => {
  it("binds the connection id once and reports a reconnect that succeeded", async () => {
    const recording = createRecordingLogger();
    const resilient = session(
      handle({ call: () => Promise.reject(new Error("transport gone")) }),
      async () => handle(),
      { logger: recording.logger },
    );

    await invoke(resilient);

    const begin = recording.first("mcp.reconnect.begin");
    const ok = recording.first("mcp.reconnect.ok");
    expect(begin?.level).toBe("debug");
    expect(begin?.fields.trigger).toBe("transport_error");
    expect(ok?.level).toBe("info");
    expect(ok?.fields.generation).toBe(1);
    expect(typeof ok?.fields.duration_ms).toBe("number");
    const ids = new Set(recording.records.map((record) => record.fields.connection_id));
    expect(ids.size).toBe(1);
    expect(typeof [...ids][0]).toBe("string");
    expect(recording.records.some((record) => "run_id" in record.fields)).toBe(false);
    await resilient.close();
  });

  it("reports the discarded reconnect failure, then the unavailability it causes", async () => {
    const recording = createRecordingLogger();
    const resilient = session(
      handle({ call: () => Promise.reject(new Error("transport gone")) }),
      () => Promise.reject(new Error("spawn ENOENT for docs-server")),
      { logger: recording.logger },
    );

    await invoke(resilient);

    const failed = recording.first("mcp.reconnect.failed");
    expect(failed?.level).toBe("warn");
    expect(failed?.fields.reason).toContain("spawn ENOENT");
    expect(failed?.fields.trigger).toBe("transport_error");
    const unavailable = recording.first("mcp.unavailable");
    expect(unavailable?.level).toBe("warn");
    expect(unavailable?.fields).toMatchObject({ cause: "reconnect_failed", cooldown_ms: 10 });
    await resilient.close();
  });

  it("reports recovery after a reprobe reconnect", async () => {
    const runtime = new FakeRuntime();
    const recording = createRecordingLogger();
    let reconnects = 0;
    const resilient = session(
      handle({ call: () => Promise.reject(new Error("drop-1")) }),
      async () => {
        reconnects += 1;
        return reconnects === 1
          ? handle({ call: () => Promise.reject(new Error("drop-2")) })
          : handle();
      },
      { runtime, logger: recording.logger },
    );

    await invoke(resilient);
    await invoke(resilient);
    expect(recording.first("mcp.unavailable")?.fields.cause).toBe("transport");

    await runtime.advance(10);
    expect((await invoke(resilient)).ok).toBe(true);
    expect(recording.first("mcp.recovered")?.level).toBe("info");
    expect(recording.all("mcp.reconnect.begin").at(-1)?.fields.trigger).toBe("reprobe");
    await resilient.close();
  });

  it("warns once, on the crossing, when the timeout streak reaches its threshold", async () => {
    const recording = createRecordingLogger();
    const resilient = session(
      handle({ call: () => Promise.reject(timeoutError()) }),
      async () => handle(),
      { logger: recording.logger, timeoutStreakThreshold: 2 },
    );

    expect((await invoke(resilient)).error?.code).toBe("mcp_timeout");
    expect(recording.all("mcp.timeout_streak")).toHaveLength(0);
    expect((await invoke(resilient)).error?.code).toBe("mcp_unavailable");
    expect((await invoke(resilient)).error?.code).toBe("mcp_unavailable");

    const streak = recording.all("mcp.timeout_streak");
    expect(streak).toHaveLength(1);
    expect(streak[0]?.fields).toMatchObject({ streak: 2, threshold: 2, call_timeout_ms: 100 });
    await resilient.close();
  });

  it("reports a failed health ping at debug", async () => {
    const runtime = new FakeRuntime();
    const recording = createRecordingLogger();
    const resilient = session(
      handle({ ping: () => Promise.reject(new Error("ping refused")) }),
      async () => handle(),
      { runtime, logger: recording.logger, healthPingIntervalMs: 5 },
    );

    await runtime.advance(5);

    const pingFailed = recording.first("mcp.health.ping_failed");
    expect(pingFailed?.level).toBe("debug");
    expect(pingFailed?.fields.reason).toContain("ping refused");
    expect(recording.all("mcp.reconnect.begin").at(-1)?.fields.trigger).toBe("health_ping_failed");
    await resilient.close();
  });

  it("classifies each call outcome on the hot per-call record", async () => {
    const recording = createRecordingLogger();
    const outcomes: unknown[] = [];
    const collect = async (
      call: () => unknown,
      overrides: Partial<ResilientSessionOptions> = {},
      signal?: AbortSignal,
    ): Promise<void> => {
      const resilient = session(handle({ call }), async () => handle(), {
        logger: recording.logger,
        ...overrides,
      });
      await invoke(resilient, signal);
      outcomes.push(recording.all("mcp.call.done").at(-1)?.fields.outcome);
      await resilient.close();
    };

    await collect(() => "ok");
    await collect(() => Promise.reject(timeoutError()));
    await collect(() => Promise.reject(new McpError(ErrorCode.InvalidParams, "bad")));
    await collect(() => Promise.reject(new Error("socket closed")));

    const aborting = new AbortController();
    await collect(
      () => {
        aborting.abort();
        return Promise.reject(new Error("cancelled"));
      },
      {},
      aborting.signal,
    );

    expect(outcomes).toEqual(["ok", "timeout", "protocol", "transport", "aborted"]);
    expect(recording.all("mcp.call.done").at(-1)?.fields.label).toBe("search");
  });

  it("allocates no per-call record when the logger is above debug", async () => {
    const recording = createRecordingLogger("info");
    const resilient = session(handle(), async () => handle(), { logger: recording.logger });

    await invoke(resilient);

    expect(recording.all("mcp.call.done")).toHaveLength(0);
    await resilient.close();
  });

  it("samples a repeated call record rather than writing one per call", async () => {
    const recording = createRecordingLogger();
    const resilient = session(handle(), async () => handle(), { logger: recording.logger });

    for (let call = 0; call < 16; call += 1) await invoke(resilient);

    expect(recording.all("mcp.call.done").length).toBeLessThan(16);
    expect(recording.all("mcp.call.done").length).toBeGreaterThan(0);
    await resilient.close();
  });
});
