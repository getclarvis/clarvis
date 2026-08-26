import { describe, expect, it, vi } from "../helpers/bun-test.ts";
import { createConnectionManager } from "@clarvis/mcp-client";
import type { MCPClientFactory, MCPClientHandle } from "@clarvis/mcp-client";
import type { McpServerConfig } from "@clarvis/capability";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.ts";

const TOOL: McpServerConfig = { name: "docs", transport: "stdio", command: "x" };
const SHARED: McpServerConfig = { ...TOOL, shared: true };
const WS = "/ws";
const OWNER = "owner";

interface HandleOpts {
  callTool?: () => unknown;
  onClose?: () => void;
}

function makeHandle(opts: HandleOpts = {}): MCPClientHandle {
  return {
    client: {
      listTools: async () => ({ tools: [{ name: "t", inputSchema: { type: "object" } }] }),
      callTool: async () =>
        opts.callTool ? opts.callTool() : { content: [{ type: "text", text: "ok" }] },
      ping: async () => {},
    } as any,
    close: async () => opts.onClose?.(),
  };
}

function manager(
  factory: MCPClientFactory,
  recording: RecordingLogger,
  overrides: Partial<Parameters<typeof createConnectionManager>[0]> = {},
): ReturnType<typeof createConnectionManager> {
  return createConnectionManager({
    workspace: WS,
    factory,
    connectTimeoutMs: 1_000,
    callTimeoutMs: 600_000,
    healthPingIntervalMs: 0,
    logger: recording.logger,
    ...overrides,
  });
}

describe("connection pool observability", () => {
  it("reports an idle eviction with a digest of the pool key, never the key", async () => {
    vi.useFakeTimers();
    try {
      const recording = createRecordingLogger();
      const pool = manager(async () => makeHandle(), recording, { idleTtlMs: 1_000 });
      const lease = await pool.acquire({ server: SHARED, owner: OWNER });
      await lease.release();
      await vi.advanceTimersByTimeAsync(1_001);

      const evicted = recording.first("mcp.pool.evicted");
      expect(evicted?.level).toBe("debug");
      expect(evicted?.fields).toMatchObject({ mcp: "docs", reason: "ttl", workspace: WS });
      expect(evicted?.fields.key_hash).toMatch(/^[0-9a-f]{12}$/u);
      expect(JSON.stringify(evicted?.fields)).not.toContain(OWNER);
      await pool.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the oldest warm connection dropped to respect the idle cap", async () => {
    const recording = createRecordingLogger();
    const pool = manager(async () => makeHandle(), recording, { maxIdleConnections: 1 });
    const first = await pool.acquire({ server: SHARED, owner: "a" });
    const second = await pool.acquire({ server: SHARED, owner: "b" });
    await first.release();
    await second.release();

    expect(recording.all("mcp.pool.evicted").map((record) => record.fields.reason)).toContain(
      "max_idle",
    );
    await pool.closeAll();
  });

  it("reports a warm connection dropped because it was no longer connected", async () => {
    const recording = createRecordingLogger();
    const drop = (): never => {
      throw new Error("drop");
    };
    const pool = manager(async () => makeHandle({ callTool: drop }), recording);
    const lease = await pool.acquire({ server: SHARED, owner: OWNER });
    await lease.release();
    await lease.conn.callTool("t", {});
    await lease.conn.callTool("t", {});
    expect(lease.conn.status).toBe("unavailable");

    const next = await pool.acquire({ server: SHARED, owner: OWNER });
    expect(recording.all("mcp.pool.evicted").map((record) => record.fields.reason)).toContain(
      "unhealthy",
    );
    await next.release();
    await pool.closeAll();
  });

  it("reports a pooled connection nobody was left waiting for", async () => {
    const recording = createRecordingLogger();
    const caller = new AbortController();
    let release!: (handle: MCPClientHandle) => void;
    const pending = new Promise<MCPClientHandle>((resolve) => {
      release = resolve;
    });
    const pool = manager(() => pending, recording);

    const acquiring = pool.acquire({ server: SHARED, owner: OWNER, signal: caller.signal });
    caller.abort();
    await expect(acquiring).rejects.toBeDefined();
    release(makeHandle());
    for (let tick = 0; tick < 50 && recording.all("mcp.pool.evicted").length === 0; tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    expect(recording.all("mcp.pool.evicted").map((record) => record.fields.reason)).toContain(
      "abandoned",
    );
    await pool.closeAll();
  });

  it("warns which server was refused when the connection cap is reached", async () => {
    const recording = createRecordingLogger();
    const pool = manager(async () => makeHandle(), recording, { maxConnections: 1 });
    const held = await pool.acquire({ server: TOOL, owner: OWNER });

    await expect(pool.acquire({ server: TOOL, owner: OWNER })).rejects.toMatchObject({
      code: "mcp_connection_limit",
    });

    const limit = recording.first("mcp.pool.limit");
    expect(limit?.level).toBe("warn");
    expect(limit?.fields).toMatchObject({ mcp: "docs", limit: 1, admitted: 1 });
    await held.release();
    await pool.closeAll();
  });

  it("reports a connect waiting on a handshake permit", async () => {
    const recording = createRecordingLogger();
    const releases: Array<() => void> = [];
    const pool = manager(
      async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return makeHandle();
      },
      recording,
      { maxParallelConnects: 1 },
    );

    const first = pool.acquire({ server: TOOL, owner: OWNER });
    const second = pool.acquire({ server: TOOL, owner: OWNER });
    while (releases.length === 0) await Promise.resolve();
    releases[0]!();
    const firstLease = await first;
    while (releases.length < 2) await Promise.resolve();
    releases[1]!();
    const secondLease = await second;

    const queued = recording.first("mcp.pool.connect_queued");
    expect(queued?.level).toBe("debug");
    expect(queued?.fields).toMatchObject({ mcp: "docs", max_parallel: 1 });
    await Promise.all([firstLease.release(), secondLease.release()]);
    await pool.closeAll();
  });

  it("says nothing about a queued connect when the logger is above debug", async () => {
    const recording = createRecordingLogger("warn");
    const releases: Array<() => void> = [];
    const pool = manager(
      async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return makeHandle();
      },
      recording,
      { maxParallelConnects: 1 },
    );

    const first = pool.acquire({ server: TOOL, owner: OWNER });
    const second = pool.acquire({ server: TOOL, owner: OWNER });
    while (releases.length === 0) await Promise.resolve();
    releases[0]!();
    const firstLease = await first;
    while (releases.length < 2) await Promise.resolve();
    releases[1]!();
    const secondLease = await second;

    expect(recording.all("mcp.pool.connect_queued")).toHaveLength(0);
    await Promise.all([firstLease.release(), secondLease.release()]);
    await pool.closeAll();
  });

  it("names the shared server whose elicitation relay was dropped", async () => {
    const recording = createRecordingLogger();
    const pool = manager(async () => makeHandle(), recording);
    const lease = await pool.acquire({
      server: SHARED,
      owner: OWNER,
      relay: { handle: async () => ({ action: "decline" }) },
    });

    expect(recording.first("mcp.pool.relay_dropped")?.fields).toMatchObject({ mcp: "docs" });
    await lease.release();
    await pool.closeAll();
  });
});
