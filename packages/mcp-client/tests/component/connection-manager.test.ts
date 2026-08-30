import { describe, it, expect, vi } from "../helpers/bun-test.ts";
import {
  createConnectionManager,
  MCPAuthorizationPendingError,
  MCPBackgroundConnectDeferredError,
} from "@clarvis/mcp-client";
import type { ConnectionManager, MCPClientFactory, MCPClientHandle } from "@clarvis/mcp-client";
import type { McpServerConfig } from "@clarvis/capability";

const TOOL: McpServerConfig = { name: "m", transport: "stdio", command: "x" };
const SHARED: McpServerConfig = { ...TOOL, shared: true };

interface HandleOpts {
  listTools?: () => unknown;
  callTool?: (call: { name: string; arguments: unknown }) => unknown;
  onClose?: () => void;
  close?: () => void | Promise<void>;
}

function makeHandle(opts: HandleOpts = {}): MCPClientHandle {
  const client = {
    async listTools(): Promise<unknown> {
      return opts.listTools
        ? opts.listTools()
        : { tools: [{ name: "t", inputSchema: { type: "object" } }] };
    },
    async callTool(call: { name: string; arguments: unknown }): Promise<unknown> {
      return opts.callTool ? opts.callTool(call) : { content: [{ type: "text", text: "ok" }] };
    },
    async close(): Promise<void> {},
  };
  return {
    client: client as any,
    close: async (): Promise<void> => {
      opts.onClose?.();
      await opts.close?.();
    },
  };
}

function genFactory(handlers: Array<() => MCPClientHandle | Promise<MCPClientHandle>>): {
  factory: MCPClientFactory;
  connects: () => number;
} {
  let i = 0;
  const factory: MCPClientFactory = async (): Promise<MCPClientHandle> => {
    const idx = Math.min(i, handlers.length - 1);
    i += 1;
    return await handlers[idx]!();
  };
  return { factory, connects: () => i };
}

const WS = "/ws";
const OWNER = "o";

function manager(factory: MCPClientFactory): ConnectionManager {
  return createConnectionManager({
    workspace: WS,
    factory,
    connectTimeoutMs: 1000,
    callTimeoutMs: 600000,
  });
}

describe("ConnectionManager (Stage 0 — 1:1 acquire/release, no reuse)", () => {
  it("caps live transports and admits another after release", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 1000,
      callTimeoutMs: 600000,
      maxConnections: 2,
    });
    const a = await m.acquire({ server: TOOL, owner: OWNER });
    const b = await m.acquire({ server: TOOL, owner: OWNER });
    await expect(m.acquire({ server: TOOL, owner: OWNER })).rejects.toMatchObject({
      code: "mcp_connection_limit",
    });
    await a.release();
    const c = await m.acquire({ server: TOOL, owner: OWNER });
    expect(connects()).toBe(3);
    await Promise.all([b.release(), c.release()]);
    await m.closeAll();
  });

  it("bounds parallel handshakes independently of the live connection cap", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const factory: MCPClientFactory = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return makeHandle();
    };
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 1000,
      callTimeoutMs: 600000,
      maxConnections: 4,
      maxParallelConnects: 2,
    });
    const pending = Array.from({ length: 4 }, () => m.acquire({ server: TOOL, owner: OWNER }));
    while (releases.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(peak).toBe(2);
    releases.splice(0).forEach((release) => release());
    while (releases.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    releases.splice(0).forEach((release) => release());
    const leases = await Promise.all(pending);
    await Promise.all(leases.map((lease) => lease.release()));
    await m.closeAll();
  });

  it("keeps timed-out physical handshakes in the parallel-connect quarantine", async () => {
    let physicalAttempts = 0;
    const factory: MCPClientFactory = async () => {
      physicalAttempts += 1;
      return await new Promise<MCPClientHandle>(() => {});
    };
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 5,
      callTimeoutMs: 600_000,
      maxConnections: 8,
      maxParallelConnects: 2,
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(m.acquire({ server: TOOL, owner: OWNER })).rejects.toThrow("within 5ms");
    }

    // The first two factories ignore abort forever. Their physical permits
    // remain occupied; later logical retries time out in the bounded queue
    // without starting four more native transports.
    expect(physicalAttempts).toBe(2);
    await m.closeAll();
  });

  it("keeps connection capacity quarantined until a timed-out factory settles", async () => {
    let settleLate!: (handle: MCPClientHandle) => void;
    const late = new Promise<MCPClientHandle>((resolve) => {
      settleLate = resolve;
    });
    let physicalAttempts = 0;
    const factory: MCPClientFactory = async () => {
      physicalAttempts += 1;
      return physicalAttempts === 1 ? await late : makeHandle();
    };
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 5,
      callTimeoutMs: 600_000,
      maxConnections: 1,
      maxParallelConnects: 4,
    });

    await expect(m.acquire({ server: TOOL, owner: OWNER })).rejects.toThrow("within 5ms");
    await expect(m.acquire({ server: TOOL, owner: OWNER })).rejects.toMatchObject({
      code: "mcp_connection_limit",
    });
    expect(physicalAttempts).toBe(1);

    settleLate(makeHandle());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const admitted = await m.acquire({ server: TOOL, owner: OWNER });
    expect(physicalAttempts).toBe(2);
    await admitted.release();
    await m.closeAll();
  });

  it("retains both connection limits while background OAuth continues", async () => {
    let finishAuthorization!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    });
    let physicalAttempts = 0;
    const factory: MCPClientFactory = async () => {
      physicalAttempts += 1;
      if (physicalAttempts === 1) throw new MCPAuthorizationPendingError(completion);
      return makeHandle();
    };
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 1_000,
      callTimeoutMs: 600_000,
      maxConnections: 2,
      maxParallelConnects: 1,
    });

    await expect(
      m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "background" }),
    ).rejects.toBeInstanceOf(MCPAuthorizationPendingError);
    const waiting = m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "blocking" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(physicalAttempts).toBe(1);
    await expect(
      m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "background" }),
    ).rejects.toMatchObject({
      code: "mcp_background_connect_deferred",
      resource: "connections",
    });

    finishAuthorization();
    const lease = await waiting;
    expect(physicalAttempts).toBe(2);
    await lease.release();
    await m.closeAll();
  });

  it("degrades background acquisitions immediately while OAuth owns the handshake gate", async () => {
    let finishAuthorization!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    });
    let physicalAttempts = 0;
    const m = createConnectionManager({
      workspace: WS,
      factory: async () => {
        physicalAttempts += 1;
        throw new MCPAuthorizationPendingError(completion);
      },
      connectTimeoutMs: 1_000,
      callTimeoutMs: 600_000,
      maxConnections: 2,
      maxParallelConnects: 1,
    });

    await expect(
      m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "background" }),
    ).rejects.toBeInstanceOf(MCPAuthorizationPendingError);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "background" }),
      ).rejects.toBeInstanceOf(MCPBackgroundConnectDeferredError);
    }
    expect(physicalAttempts).toBe(1);

    finishAuthorization();
    await m.closeAll();
  });

  it("degrades a later background run while OAuth owns the connection limit", async () => {
    let finishAuthorization!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    });
    let physicalAttempts = 0;
    const m = createConnectionManager({
      workspace: WS,
      factory: async () => {
        physicalAttempts += 1;
        throw new MCPAuthorizationPendingError(completion);
      },
      connectTimeoutMs: 1_000,
      callTimeoutMs: 600_000,
      maxConnections: 1,
      maxParallelConnects: 4,
    });

    await expect(
      m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "background" }),
    ).rejects.toBeInstanceOf(MCPAuthorizationPendingError);
    await expect(
      m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "background" }),
    ).rejects.toMatchObject({
      code: "mcp_background_connect_deferred",
      resource: "connections",
    });
    expect(physicalAttempts).toBe(1);

    finishAuthorization();
    await m.closeAll();
  });

  it("retains connection capacity when cancellation wins just before OAuth becomes pending", async () => {
    const caller = new AbortController();
    let finishAuthorization!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    });
    let physicalAttempts = 0;
    const m = createConnectionManager({
      workspace: WS,
      factory: async () => {
        physicalAttempts += 1;
        if (physicalAttempts === 1) {
          caller.abort(new Error("run cancelled"));
          await Promise.resolve();
          throw new MCPAuthorizationPendingError(completion);
        }
        return makeHandle();
      },
      connectTimeoutMs: 1_000,
      callTimeoutMs: 600_000,
      maxConnections: 1,
      maxParallelConnects: 2,
    });

    await expect(
      m.acquire({
        server: TOOL,
        owner: OWNER,
        authorizationWait: "background",
        signal: caller.signal,
      }),
    ).rejects.toThrow("run cancelled");
    await Promise.resolve();
    await expect(
      m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "blocking" }),
    ).rejects.toMatchObject({ code: "mcp_connection_limit" });
    expect(physicalAttempts).toBe(1);

    finishAuthorization();
    await Promise.resolve();
    const lease = await m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "blocking" });
    expect(physicalAttempts).toBe(2);
    await lease.release();
    await m.closeAll();
  });

  it("bounds shutdown while a retained OAuth admission never settles", async () => {
    const scheduled: Array<() => void> = [];
    const m = createConnectionManager({
      workspace: WS,
      factory: async () =>
        Promise.reject(new MCPAuthorizationPendingError(new Promise<void>(() => {}))),
      connectTimeoutMs: 1_000,
      callTimeoutMs: 600_000,
      closeGraceMs: 5,
      scheduleCloseTimeout(callback) {
        scheduled.push(callback);
        return { cancel() {} };
      },
    });
    await expect(
      m.acquire({ server: TOOL, owner: OWNER, authorizationWait: "background" }),
    ).rejects.toBeInstanceOf(MCPAuthorizationPendingError);

    let closed = false;
    const closing = m.closeAll().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    scheduled.splice(0).forEach((run) => run());
    await closing;
    expect(closed).toBe(true);
  });

  it("keeps a late OAuth admission inside the bounded shutdown drain", async () => {
    const scheduled: Array<() => void> = [];
    let rejectConnect!: (error: Error) => void;
    const m = createConnectionManager({
      workspace: WS,
      factory: () =>
        new Promise<MCPClientHandle>((_resolve, reject) => {
          rejectConnect = reject;
        }),
      connectTimeoutMs: 1_000,
      callTimeoutMs: 600_000,
      closeGraceMs: 5,
      scheduleCloseTimeout(callback) {
        scheduled.push(callback);
        return { cancel() {} };
      },
    });
    const acquiring = m
      .acquire({ server: TOOL, owner: OWNER, authorizationWait: "background" })
      .catch((error: unknown) => error);
    await Promise.resolve();

    let closed = false;
    const closing = m.closeAll().then(() => {
      closed = true;
    });
    await Promise.resolve();
    rejectConnect(new MCPAuthorizationPendingError(new Promise<void>(() => {})));
    await acquiring;
    await Promise.resolve();

    expect(closed).toBe(false);
    scheduled.splice(0).forEach((run) => run());
    await closing;
    expect(closed).toBe(true);
  });

  it("does not start a dedicated reconnect after its caller signal aborts", async () => {
    let reconnectSignal: AbortSignal | undefined;
    let connects = 0;
    const factory: MCPClientFactory = async (_server, _relay, connect) => {
      connects += 1;
      if (connects === 1) {
        return makeHandle({ callTool: () => Promise.reject(new Error("transport lost")) });
      }
      reconnectSignal = connect?.signal;
      return new Promise<MCPClientHandle>(() => {});
    };
    const m = manager(factory);
    const controller = new AbortController();
    const lease = await m.acquire({ server: TOOL, owner: OWNER, signal: controller.signal });

    controller.abort(new Error("run stopped"));
    await lease.conn.callTool("t", {});
    expect(connects).toBe(1);
    expect(reconnectSignal).toBeUndefined();

    await lease.release();
    await m.closeAll();
  });

  it("detaches a signalled shared waiter on abort and on factory rejection", async () => {
    let settle!: (handle: MCPClientHandle) => void;
    const pending = new Promise<MCPClientHandle>((resolve) => {
      settle = resolve;
    });
    const waiting = manager(async () => pending);
    const aborted = new AbortController();
    const acquire = waiting.acquire({ server: SHARED, owner: OWNER, signal: aborted.signal });
    aborted.abort(new Error("caller stopped waiting"));
    await expect(acquire).rejects.toThrow("caller stopped waiting");
    settle(makeHandle());
    await waiting.closeAll();

    const failed = manager(async () => {
      throw new Error("factory rejected");
    });
    const liveSignal = new AbortController();
    await expect(
      failed.acquire({ server: SHARED, owner: OWNER, signal: liveSignal.signal }),
    ).rejects.toThrow("factory rejected");
    await failed.closeAll();
  });

  it("acquire opens one connection per call (connect maps 1:1)", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = manager(factory);
    const a = await m.acquire({ server: TOOL, owner: OWNER });
    const b = await m.acquire({ server: TOOL, owner: OWNER });
    const c = await m.acquire({ server: TOOL, owner: OWNER });
    expect(connects()).toBe(3);
    await Promise.all([a.release(), b.release(), c.release()]);
  });

  it("release closes the underlying connection (close maps 1:1)", async () => {
    let closes = 0;
    const { factory } = genFactory([() => makeHandle({ onClose: () => (closes += 1) })]);
    const m = manager(factory);
    const a = await m.acquire({ server: TOOL, owner: OWNER });
    const b = await m.acquire({ server: TOOL, owner: OWNER });
    await a.release();
    await b.release();
    expect(closes).toBe(2);
  });

  it("release is idempotent (double release closes once)", async () => {
    let closes = 0;
    const { factory } = genFactory([() => makeHandle({ onClose: () => (closes += 1) })]);
    const m = manager(factory);
    const a = await m.acquire({ server: TOOL, owner: OWNER });
    await a.release();
    await a.release();
    expect(closes).toBe(1);
  });

  it("tracks close without mutating a frozen factory handle", async () => {
    let closes = 0;
    const handle = Object.freeze(makeHandle({ onClose: () => (closes += 1) }));
    const m = manager(async () => handle);
    const lease = await m.acquire({ server: TOOL, owner: OWNER });
    await lease.release();
    expect(closes).toBe(1);
    await m.closeAll();
    expect(closes).toBe(1);
  });

  it("keeps managed connection close idempotent after its resources are released", async () => {
    let closes = 0;
    const { factory } = genFactory([() => makeHandle({ onClose: () => (closes += 1) })]);
    const m = manager(factory);
    const lease = await m.acquire({ server: TOOL, owner: OWNER });
    await lease.conn.close();
    await lease.conn.close();
    await lease.release();
    expect(closes).toBe(1);
    await m.closeAll();
  });

  it("closeAll force-closes un-released leases without double-closing released ones", async () => {
    let closes = 0;
    const { factory } = genFactory([() => makeHandle({ onClose: () => (closes += 1) })]);
    const m = manager(factory);
    const a = await m.acquire({ server: TOOL, owner: OWNER });
    await m.acquire({ server: TOOL, owner: OWNER });
    await a.release();
    await m.closeAll();
    expect(closes).toBe(2);
  });

  it("does not reuse a released non-shared connection", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = manager(factory);
    const a = await m.acquire({ server: TOOL, owner: OWNER });
    await a.release();
    const b = await m.acquire({ server: TOOL, owner: OWNER });
    expect(connects()).toBe(2);
    await b.release();
  });

  it("a failed acquire rejects and leaves nothing tracked to close", async () => {
    let closes = 0;
    const { factory } = genFactory([
      () =>
        makeHandle({
          listTools: () => {
            throw new Error("boom");
          },
          onClose: () => (closes += 1),
        }),
    ]);
    const m = manager(factory);
    await expect(m.acquire({ server: TOOL, owner: OWNER })).rejects.toThrow();
    expect(closes).toBe(1);
    await m.closeAll();
    expect(closes).toBe(1);
  });
});

describe("ConnectionManager (Stage 1 — warm reuse for shared stdio servers)", () => {
  it("warns once when a shared connection drops an elicitation relay", async () => {
    const warnings: string[] = [];
    const { factory } = genFactory([() => makeHandle()]);
    const log = (): void => {};
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 1000,
      callTimeoutMs: 600000,
      logger: {
        debug: log,
        info: log,
        warn: (_fields, message) => warnings.push(String(message)),
        error: log,
      },
    });
    const relay = { handle: async () => ({ action: "decline" as const }) };

    const first = await m.acquire({ server: SHARED, owner: OWNER, relay });
    const second = await m.acquire({ server: SHARED, owner: OWNER, relay });

    const relayWarnings = warnings.filter((message) =>
      message.includes("advertises no elicitation capability"),
    );
    expect(relayWarnings).toHaveLength(1);
    await first.release();
    await second.release();
    await m.closeAll();
  });

  it("reuses a warm connection across sequential shared runs (connects once)", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = manager(factory);
    const a = await m.acquire({ server: SHARED, owner: OWNER });
    expect(connects()).toBe(1);
    await a.release();
    const b = await m.acquire({ server: SHARED, owner: OWNER });
    expect(connects()).toBe(1);
    expect(b.conn).toBe(a.conn);
    await b.release();
    await m.closeAll();
  });

  it("overlapping runs share ONE connection (refcount); it stays warm after all release", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = manager(factory);
    const a = await m.acquire({ server: SHARED, owner: OWNER });
    const b = await m.acquire({ server: SHARED, owner: OWNER });
    expect(connects()).toBe(1);
    expect(a.conn).toBe(b.conn);
    await a.release();
    await b.release();
    const c = await m.acquire({ server: SHARED, owner: OWNER });
    expect(connects()).toBe(1);
    expect(c.conn).toBe(a.conn);
    await c.release();
    await m.closeAll();
  });

  it("single-flights the connect for simultaneous first acquirers (connects once)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let connects = 0;
    const factory: MCPClientFactory = async () => {
      connects += 1;
      await gate;
      return makeHandle();
    };
    const m = manager(factory);
    const pa = m.acquire({ server: SHARED, owner: OWNER });
    const pb = m.acquire({ server: SHARED, owner: OWNER });
    release();
    const [a, b] = await Promise.all([pa, pb]);
    expect(connects).toBe(1);
    expect(a.conn).toBe(b.conn);
    await a.release();
    await b.release();
    await m.closeAll();
  });

  it("keeps the connection open until the LAST lease releases, then closes once", async () => {
    let closes = 0;
    const { factory } = genFactory([() => makeHandle({ onClose: () => (closes += 1) })]);
    const m = manager(factory);
    const a = await m.acquire({ server: SHARED, owner: OWNER });
    const b = await m.acquire({ server: SHARED, owner: OWNER });
    await a.release();
    expect(closes).toBe(0);
    await b.release();
    expect(closes).toBe(0);
    await m.closeAll();
    expect(closes).toBe(1);
  });

  it("never reuses when shared is not set (connects every time)", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = manager(factory);
    for (let i = 0; i < 3; i += 1) {
      const l = await m.acquire({ server: TOOL, owner: OWNER });
      await l.release();
    }
    expect(connects()).toBe(3);
    await m.closeAll();
  });

  it("shares only within the same tool name (name is part of the pool key)", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = manager(factory);
    const a = await m.acquire({ server: { ...SHARED, name: "alpha" }, owner: OWNER });
    await a.release();
    const a2 = await m.acquire({ server: { ...SHARED, name: "alpha" }, owner: OWNER });
    expect(connects()).toBe(1);
    await a2.release();
    await m.closeAll();
  });

  it("does not share across different tool names (namespacing correctness)", async () => {
    const { factory, connects } = genFactory([() => makeHandle(), () => makeHandle()]);
    const m = manager(factory);
    const a = await m.acquire({ server: { ...SHARED, name: "alpha" }, owner: OWNER });
    await a.release();
    const b = await m.acquire({ server: { ...SHARED, name: "beta" }, owner: OWNER });
    expect(connects()).toBe(2);
    await b.release();
    await m.closeAll();
  });

  it("keys on args (order-sensitive) and ignores env key order", async () => {
    const byArgs = genFactory([() => makeHandle()]);
    const ma = manager(byArgs.factory);
    const x = await ma.acquire({ server: { ...SHARED, args: ["a"] }, owner: OWNER });
    await x.release();
    const y = await ma.acquire({ server: { ...SHARED, args: ["b"] }, owner: OWNER });
    expect(byArgs.connects()).toBe(2);
    await y.release();
    await ma.closeAll();

    const byEnv = genFactory([() => makeHandle()]);
    const mb = manager(byEnv.factory);
    const p = await mb.acquire({ server: { ...SHARED, env: { A: "1", B: "2" } }, owner: OWNER });
    await p.release();
    const q = await mb.acquire({ server: { ...SHARED, env: { B: "2", A: "1" } }, owner: OWNER });
    expect(byEnv.connects()).toBe(1);
    await q.release();
    await mb.closeAll();
  });

  it("does not poison a healthy shared conn when the run's signal aborted (no abort-poison)", async () => {
    let closes = 0;
    const { factory, connects } = genFactory([() => makeHandle({ onClose: () => (closes += 1) })]);
    const m = manager(factory);
    const ac = new AbortController();
    const a = await m.acquire({ server: SHARED, signal: ac.signal, owner: OWNER });
    ac.abort();
    await a.release();
    expect(closes).toBe(0);
    const b = await m.acquire({ server: SHARED, owner: OWNER });
    expect(connects()).toBe(1);
    expect(b.conn).toBe(a.conn);
    await b.release();
    await m.closeAll();
  });

  it("an aborted lease release never closes a connection still in use by another run", async () => {
    let closes = 0;
    const { factory } = genFactory([() => makeHandle({ onClose: () => (closes += 1) })]);
    const m = manager(factory);
    const ac = new AbortController();
    const a = await m.acquire({ server: SHARED, signal: ac.signal, owner: OWNER });
    const b = await m.acquire({ server: SHARED, owner: OWNER });
    expect(a.conn).toBe(b.conn);
    ac.abort();
    await a.release();
    expect(closes).toBe(0);
    const r = await b.conn.callTool("t", {});
    expect(r.ok).toBe(true);
    await b.release();
    await m.closeAll();
    expect(closes).toBe(1);
  });

  it("a failed shared connect rejects and leaves no lingering slot (next acquire retries)", async () => {
    let attempt = 0;
    const factory: MCPClientFactory = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return makeHandle();
    };
    const m = manager(factory);
    await expect(m.acquire({ server: SHARED, owner: OWNER })).rejects.toThrow();
    const b = await m.acquire({ server: SHARED, owner: OWNER });
    expect(attempt).toBe(2);
    await b.release();
    await m.closeAll();
  });

  it("discards a warm connection that went unhealthy and opens a fresh one", async () => {
    const drop = (): never => {
      throw new Error("drop");
    };
    const { factory, connects } = genFactory([
      () => makeHandle({ callTool: drop }),
      () => makeHandle({ callTool: drop }),
      () => makeHandle(),
    ]);
    const m = manager(factory);
    const a = await m.acquire({ server: SHARED, owner: OWNER });
    await a.release();
    await a.conn.callTool("t", {});
    const r = await a.conn.callTool("t", {});
    expect(r.ok).toBe(false);
    expect(a.conn.status).toBe("unavailable");
    const b = await m.acquire({ server: SHARED, owner: OWNER });
    expect(connects()).toBe(3);
    expect(b.conn).not.toBe(a.conn);
    await b.release();
    await m.closeAll();
  });

  it("evicts an idle pooled connection after the TTL, forcing a reconnect", async () => {
    vi.useFakeTimers();
    try {
      let closes = 0;
      const { factory, connects } = genFactory([
        () => makeHandle({ onClose: () => (closes += 1) }),
      ]);
      const m = createConnectionManager({
        workspace: WS,
        factory,
        connectTimeoutMs: 1000,
        callTimeoutMs: 600000,
        idleTtlMs: 1000,
      });
      const a = await m.acquire({ server: SHARED, owner: OWNER });
      await a.release();
      expect(closes).toBe(0);
      await vi.advanceTimersByTimeAsync(1001);
      expect(closes).toBe(1);
      const b = await m.acquire({ server: SHARED, owner: OWNER });
      expect(connects()).toBe(2);
      await b.release();
      await m.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shared release is idempotent (double release does not double-close)", async () => {
    let closes = 0;
    const { factory } = genFactory([() => makeHandle({ onClose: () => (closes += 1) })]);
    const m = manager(factory);
    const a = await m.acquire({ server: SHARED, owner: OWNER });
    await a.release();
    await a.release();
    expect(closes).toBe(0);
    await m.closeAll();
    expect(closes).toBe(1);
  });

  it("release closes (not pools) a shared conn whose status is no longer connected", async () => {
    const drop = (): never => {
      throw new Error("drop");
    };
    let closes = 0;
    const { factory, connects } = genFactory([
      () => makeHandle({ callTool: drop, onClose: () => (closes += 1) }),
      () => makeHandle({ callTool: drop, onClose: () => (closes += 1) }),
      () => makeHandle({ onClose: () => (closes += 1) }),
    ]);
    const m = manager(factory);
    const a = await m.acquire({ server: SHARED, owner: OWNER });
    await a.conn.callTool("t", {});
    await a.conn.callTool("t", {});
    expect(a.conn.status).toBe("unavailable");
    await a.release();
    expect(closes).toBe(2);
    const b = await m.acquire({ server: SHARED, owner: OWNER });
    expect(connects()).toBe(3);
    expect(b.conn).not.toBe(a.conn);
    await b.release();
    await m.closeAll();
  });

  it("releasing a shared lease after closeAll neither re-pools nor double-closes it", async () => {
    let closes = 0;
    const { factory } = genFactory([() => makeHandle({ onClose: () => (closes += 1) })]);
    const m = manager(factory);
    const a = await m.acquire({ server: SHARED, owner: OWNER });
    const b = await m.acquire({ server: SHARED, owner: OWNER });
    await m.closeAll();
    await a.release();
    await b.release();
    expect(closes).toBe(1);
  });

  it("closeAll closes a shared connection that is still connecting (opened not yet resolved)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let closes = 0;
    const factory: MCPClientFactory = async () => {
      await gate;
      return makeHandle({ onClose: () => (closes += 1) });
    };
    const m = manager(factory);
    const pa = m.acquire({ server: SHARED, owner: OWNER });
    const pClose = m.closeAll();
    release();
    await expect(pa).rejects.toThrow("aborted");
    await pClose;
    expect(closes).toBe(1);
  });

  it("keys a shared stdio tool that omits command (null-safe pool key)", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = manager(factory);
    const tool: McpServerConfig = { name: "m", transport: "stdio", shared: true };
    const a = await m.acquire({ server: tool, owner: OWNER });
    await a.release();
    const b = await m.acquire({ server: tool, owner: OWNER });
    expect(connects()).toBe(1);
    expect(b.conn).toBe(a.conn);
    await b.release();
    await m.closeAll();
  });
});

// The pool key used to be the server config alone. Nothing but process topology
// kept two workspaces — or two owners of one workspace — off the same warm
// subprocess, and `resources` decides the tool surface every lease of a slot is
// handed.
describe("ConnectionManager — the pool key carries the scope and the whole config", () => {
  function scopedManager(
    factory: MCPClientFactory,
    over: { workspace?: string; poolSharing?: "owner" | "workspace" } = {},
  ): ConnectionManager {
    return createConnectionManager({
      workspace: over.workspace ?? WS,
      factory,
      connectTimeoutMs: 1000,
      callTimeoutMs: 600000,
      ...(over.poolSharing ? { poolSharing: over.poolSharing } : {}),
    });
  }

  it("does not share a subprocess between owners by default", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = scopedManager(factory);
    const a = await m.acquire({ server: SHARED, owner: "alice" });
    const b = await m.acquire({ server: SHARED, owner: "bob" });
    expect(connects()).toBe(2);
    expect(b.conn).not.toBe(a.conn);
    await Promise.all([a.release(), b.release()]);
    await m.closeAll();
  });

  it("shares one subprocess across owners under poolSharing 'workspace'", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = scopedManager(factory, { poolSharing: "workspace" });
    const a = await m.acquire({ server: SHARED, owner: "alice" });
    const b = await m.acquire({ server: SHARED, owner: "bob" });
    expect(connects()).toBe(1);
    expect(b.conn).toBe(a.conn);
    await Promise.all([a.release(), b.release()]);
    await m.closeAll();
  });

  it("keeps two workspaces apart even for a byte-identical server", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const one = scopedManager(factory, { workspace: "/ws/one" });
    const two = scopedManager(factory, { workspace: "/ws/two" });
    const a = await one.acquire({ server: SHARED, owner: OWNER });
    const b = await two.acquire({ server: SHARED, owner: OWNER });
    expect(connects()).toBe(2);
    expect(b.conn).not.toBe(a.conn);
    await Promise.all([a.release(), b.release()]);
    await Promise.all([one.closeAll(), two.closeAll()]);
  });

  it("separates owners whose ids differ only by encoding", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = scopedManager(factory);
    const a = await m.acquire({ server: SHARED, owner: "a/b" });
    const b = await m.acquire({ server: SHARED, owner: "a%2Fb" });
    expect(connects()).toBe(2);
    await Promise.all([a.release(), b.release()]);
    await m.closeAll();
  });

  it("reuses one slot for the same owner across acquires", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = scopedManager(factory);
    const a = await m.acquire({ server: SHARED, owner: "alice" });
    const b = await m.acquire({ server: SHARED, owner: "alice" });
    expect(connects()).toBe(1);
    expect(b.conn).toBe(a.conn);
    await Promise.all([a.release(), b.release()]);
    await m.closeAll();
  });

  it("reuses one slot when only run-level automatic tool admission differs", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = scopedManager(factory);
    const explicit = await m.acquire({
      server: { ...SHARED, auto_tools: false },
      owner: OWNER,
    });
    const automatic = await m.acquire({
      server: { ...SHARED, auto_tools: true },
      owner: OWNER,
    });
    expect(connects()).toBe(1);
    expect(automatic.conn).toBe(explicit.conn);
    await Promise.all([explicit.release(), automatic.release()]);
    await m.closeAll();
  });

  // `resources` gates the synthetic list_resources/read_resource tools, and every
  // lease of a slot is handed the same `tools` array — so sharing a slot across
  // both settings lets whoever connects first pick the other's tool surface.
  it("does not share a slot between resources on and resources off", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = scopedManager(factory);
    const a = await m.acquire({ server: { ...SHARED, resources: false }, owner: OWNER });
    const b = await m.acquire({ server: { ...SHARED, resources: true }, owner: OWNER });
    expect(connects()).toBe(2);
    await Promise.all([a.release(), b.release()]);
    await m.closeAll();
  });

  it("does not share a slot between differing cwds", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = scopedManager(factory);
    const a = await m.acquire({ server: { ...SHARED, cwd: "/a" }, owner: OWNER });
    const b = await m.acquire({ server: { ...SHARED, cwd: "/b" }, owner: OWNER });
    expect(connects()).toBe(2);
    await Promise.all([a.release(), b.release()]);
    await m.closeAll();
  });
});

// `poolable` used to include `!closed`, so an acquire on a torn-down manager took
// the unpooled branch: it spawned a real subprocess, then closed it and threw.
describe("ConnectionManager — teardown", () => {
  for (const cause of ["abort", "timeout"] as const) {
    it(`waits for a late handle close after ${cause} until the shared close grace`, async () => {
      let startFactory!: () => void;
      const factoryStarted = new Promise<void>((resolve) => {
        startFactory = resolve;
      });
      let settleFactory!: (handle: MCPClientHandle) => void;
      const lateFactory = new Promise<MCPClientHandle>((resolve) => {
        settleFactory = resolve;
      });
      let closeStarted!: () => void;
      const startedClosing = new Promise<void>((resolve) => {
        closeStarted = resolve;
      });
      let finishClose!: () => void;
      const closeFinished = new Promise<void>((resolve) => {
        finishClose = resolve;
      });
      const scheduled: Array<() => void> = [];
      const m = createConnectionManager({
        workspace: WS,
        factory: async () => {
          startFactory();
          return await lateFactory;
        },
        connectTimeoutMs: cause === "timeout" ? 5 : 60_000,
        callTimeoutMs: 600_000,
        closeGraceMs: 60_000,
        scheduleCloseTimeout(callback) {
          scheduled.push(callback);
          return { cancel() {} };
        },
      });
      const abort = new AbortController();
      const acquiring = m.acquire({
        server: TOOL,
        owner: OWNER,
        ...(cause === "abort" ? { signal: abort.signal } : {}),
      });
      await factoryStarted;
      if (cause === "abort") abort.abort();
      await expect(acquiring).rejects.toThrow(cause === "abort" ? "aborted" : "within 5ms");

      let managerClosed = false;
      const closing = m.closeAll().then(() => {
        managerClosed = true;
      });
      settleFactory(
        makeHandle({
          onClose: closeStarted,
          close: () => closeFinished,
        }),
      );
      await startedClosing;
      await Promise.resolve();
      expect(managerClosed).toBe(false);
      expect(scheduled).toHaveLength(1);

      finishClose();
      await closing;
      expect(managerClosed).toBe(true);
    });
  }

  it("returns after its grace when a pending open never settles", async () => {
    let listingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      listingStarted = resolve;
    });
    let closes = 0;
    const factory: MCPClientFactory = async () =>
      makeHandle({
        listTools: () => {
          listingStarted();
          return new Promise<unknown>(() => {});
        },
        onClose: () => {
          closes += 1;
        },
      });
    const scheduled: Array<() => void> = [];
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 60_000,
      callTimeoutMs: 600_000,
      closeGraceMs: 5,
      scheduleCloseTimeout(callback) {
        scheduled.push(callback);
        return { cancel() {} };
      },
    });
    void m.acquire({ server: SHARED, owner: OWNER }).catch(() => {});
    await started;

    let closed = false;
    const closing = m.closeAll().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    scheduled.splice(0).forEach((run) => run());
    await closing;
    expect(closed).toBe(true);
    expect(closes).toBe(1);
  });

  it("keeps connection capacity occupied while post-factory catalog loading is pending", async () => {
    let listingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      listingStarted = resolve;
    });
    const factory: MCPClientFactory = async () =>
      makeHandle({
        listTools: () => {
          listingStarted();
          return new Promise<unknown>(() => {});
        },
      });
    const scheduled: Array<() => void> = [];
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 60_000,
      callTimeoutMs: 600_000,
      maxConnections: 1,
      closeGraceMs: 5,
      scheduleCloseTimeout(callback) {
        scheduled.push(callback);
        return { cancel() {} };
      },
    });
    void m.acquire({ server: TOOL, owner: OWNER }).catch(() => {});
    await started;

    await expect(m.acquire({ server: TOOL, owner: OWNER })).rejects.toMatchObject({
      code: "mcp_connection_limit",
    });
    const closing = m.closeAll();
    await Promise.resolve();
    scheduled.splice(0).forEach((run) => run());
    await closing;
  });

  it("returns after its grace when connection and background closes never settle", async () => {
    const { factory } = genFactory([
      () => makeHandle({ close: () => new Promise<void>(() => {}) }),
    ]);
    const scheduled: Array<() => void> = [];
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 1000,
      callTimeoutMs: 600000,
      closeGraceMs: 5,
      scheduleCloseTimeout(callback) {
        scheduled.push(callback);
        return { cancel() {} };
      },
    });
    await m.acquire({ server: TOOL, owner: OWNER });
    const closing = m.closeAll();
    await Promise.resolve();
    scheduled.splice(0).forEach((run) => run());
    await closing;
    await expect(m.acquire({ server: TOOL, owner: OWNER })).rejects.toThrow(
      "connection manager closed",
    );
  });

  it("sanitizes NaN and Infinity manager limits instead of disabling admission", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 1000,
      callTimeoutMs: 600000,
      maxConnections: Number.NaN,
      maxParallelConnects: Number.POSITIVE_INFINITY,
      maxIdleConnections: Number.NaN,
      idleTtlMs: Number.POSITIVE_INFINITY,
    });
    const leases = await Promise.all(
      Array.from({ length: 32 }, () => m.acquire({ server: TOOL, owner: OWNER })),
    );
    await expect(m.acquire({ server: TOOL, owner: OWNER })).rejects.toMatchObject({
      code: "mcp_connection_limit",
    });
    expect(connects()).toBe(32);
    await Promise.all(leases.map((lease) => lease.release()));
    await m.closeAll();
  });

  it("uses the finite parallel-connect default for an Infinity override", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const factory: MCPClientFactory = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return makeHandle();
    };
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 1000,
      callTimeoutMs: 600000,
      maxConnections: 8,
      maxParallelConnects: Number.POSITIVE_INFINITY,
    });
    const pending = Array.from({ length: 8 }, () => m.acquire({ server: TOOL, owner: OWNER }));
    while (releases.length < 4) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(peak).toBe(4);
    releases.splice(0).forEach((release) => release());
    while (releases.length < 4) await new Promise<void>((resolve) => setImmediate(resolve));
    releases.splice(0).forEach((release) => release());
    const leases = await Promise.all(pending);
    await Promise.all(leases.map((lease) => lease.release()));
    await m.closeAll();
  });

  it("uses the finite idle-cap default for a NaN override", async () => {
    let closes = 0;
    const factory: MCPClientFactory = async () =>
      makeHandle({
        onClose: () => {
          closes += 1;
        },
      });
    const m = createConnectionManager({
      workspace: WS,
      factory,
      connectTimeoutMs: 1000,
      callTimeoutMs: 600000,
      idleTtlMs: 60_000,
      maxIdleConnections: Number.NaN,
    });
    for (let index = 0; index < 9; index += 1) {
      const lease = await m.acquire({
        server: { ...SHARED, name: `shared-${String(index)}` },
        owner: OWNER,
      });
      await lease.release();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closes).toBe(1);
    await m.closeAll();
    expect(closes).toBe(9);
  });

  it("uses the finite idle-TTL default for an Infinity override", async () => {
    vi.useFakeTimers();
    try {
      let closes = 0;
      const factory: MCPClientFactory = async () =>
        makeHandle({
          onClose: () => {
            closes += 1;
          },
        });
      const m = createConnectionManager({
        workspace: WS,
        factory,
        connectTimeoutMs: 1000,
        callTimeoutMs: 600000,
        idleTtlMs: Number.POSITIVE_INFINITY,
        healthPingIntervalMs: 0,
      });
      const lease = await m.acquire({ server: SHARED, owner: OWNER });
      await lease.release();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(closes).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(closes).toBe(1);
      await m.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects after closeAll without opening a connection first", async () => {
    const { factory, connects } = genFactory([() => makeHandle()]);
    const m = manager(factory);
    await m.closeAll();
    await expect(m.acquire({ server: SHARED, owner: OWNER })).rejects.toThrow(
      "connection manager closed",
    );
    await expect(m.acquire({ server: TOOL, owner: OWNER })).rejects.toThrow(
      "connection manager closed",
    );
    expect(connects()).toBe(0);
  });
});
