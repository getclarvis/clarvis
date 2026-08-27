import { describe, expect, it, vi } from "../helpers/bun-test.ts";
import type { McpServerConfig } from "@clarvis/capability";
import { MCPConnectionFailedError, openConnection } from "@clarvis/mcp-client";
import type { ElicitationRelay, MCPClientFactory, MCPClientHandle } from "@clarvis/mcp-client";

const SCOPE = { workspace: "/ws", owner: "owner" };
const SERVER: McpServerConfig = { name: "docs", transport: "stdio", command: "server" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface HandleOptions {
  listTools?: (params: unknown, options: unknown) => unknown;
  callTool?: (call: unknown, resultSchema: unknown, options: unknown) => unknown;
  onClose?: () => void;
}

function handle(options: HandleOptions = {}): MCPClientHandle {
  return {
    client: {
      listTools: async (params: unknown, requestOptions: unknown) =>
        options.listTools?.(params, requestOptions) ?? {
          tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
        },
      callTool: async (call: unknown, resultSchema: unknown, requestOptions: unknown) =>
        options.callTool?.(call, resultSchema, requestOptions) ?? {
          content: [{ type: "text", text: "ok" }],
        },
      getServerCapabilities: () => ({}),
      ping: async () => {},
    } as any,
    close: async () => options.onClose?.(),
  };
}

function open(
  factory: MCPClientFactory,
  overrides: Partial<Parameters<typeof openConnection>[0]> = {},
) {
  return openConnection({
    scope: SCOPE,
    server: SERVER,
    connectTimeoutMs: 1_000,
    callTimeoutMs: 250,
    healthPingIntervalMs: 0,
    resourcesEnabled: false,
    factory,
    ...overrides,
  });
}

describe("openConnection connection boundary", () => {
  it("bounds connection, aborts the factory signal, and closes a late handle", async () => {
    vi.useFakeTimers();
    try {
      const late = deferred<MCPClientHandle>();
      const lateClosed = deferred<boolean>();
      let connectSignal: AbortSignal | undefined;
      const factory: MCPClientFactory = (_server, _relay, options) => {
        connectSignal = options?.signal;
        return late.promise;
      };

      const opening = open(factory, { connectTimeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(20);
      await expect(opening).rejects.toThrow("within 20ms");
      expect(connectSignal?.aborted).toBe(true);

      late.resolve(handle({ onClose: () => lateClosed.resolve(true) }));
      await lateClosed.promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a pending connection from the caller signal and closes its late handle", async () => {
    const caller = new AbortController();
    const late = deferred<MCPClientHandle>();
    const lateClosed = deferred<boolean>();
    let connectSignal: AbortSignal | undefined;
    const opening = open(
      (_server, _relay, options) => {
        connectSignal = options?.signal;
        return late.promise;
      },
      { signal: caller.signal },
    );

    caller.abort();
    await expect(opening).rejects.toThrow("aborted (run cancelled)");
    expect(connectSignal?.aborted).toBe(true);
    late.resolve(handle({ onClose: () => lateClosed.resolve(true) }));
    await lateClosed.promise;
  });

  it("forwards server, relay, connect timeout, and signal to the factory and listTools", async () => {
    const signal = new AbortController().signal;
    const relay: ElicitationRelay = { handle: async () => ({ action: "decline" }) };
    const seen: Record<string, unknown> = {};
    const factory: MCPClientFactory = async (server, receivedRelay, options) => {
      seen.server = server;
      seen.relay = receivedRelay;
      seen.factoryOptions = options;
      return handle({
        listTools: (params, listOptions) => {
          seen.listParams = params;
          seen.listOptions = listOptions;
          return { tools: [] };
        },
      });
    };

    const opened = await open(factory, { connectTimeoutMs: 321, signal, relay });
    expect(seen).toEqual({
      server: SERVER,
      relay,
      factoryOptions: {
        timeoutMs: 321,
        signal: expect.any(AbortSignal),
        scope: SCOPE,
        onAuthorizationWaitStart: expect.any(Function),
        onAuthorizationWaitEnd: expect.any(Function),
      },
      listParams: undefined,
      listOptions: { timeout: 321, signal },
    });
    expect((seen.factoryOptions as { signal: AbortSignal }).signal).not.toBe(signal);
    await opened.conn.close();
  });

  it("pauses only the connect deadline while interactive authorization is pending", async () => {
    vi.useFakeTimers();
    try {
      const authorization = deferred<boolean>();
      const late = deferred<MCPClientHandle>();
      let connectSignal: AbortSignal | undefined;
      const opening = open(
        async (_server, _relay, options) => {
          connectSignal = options?.signal;
          options?.onAuthorizationWaitStart?.();
          try {
            await authorization.promise;
          } finally {
            options?.onAuthorizationWaitEnd?.();
          }
          return late.promise;
        },
        { connectTimeoutMs: 20 },
      );

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(connectSignal?.aborted).toBe(false);

      authorization.resolve(true);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(19);
      expect(connectSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(opening).rejects.toThrow("within 20ms");
      expect(connectSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps factory failures with the MCP identity", async () => {
    const opening = open(async () => {
      throw "factory offline";
    });

    const error = await opening.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MCPConnectionFailedError);
    expect(error).toMatchObject({
      code: "mcp_connection_failed",
      mcpName: "docs",
      transport: "stdio",
      message: "factory offline",
    });
  });

  it("closes the handle and wraps tool-enumeration failures", async () => {
    let closes = 0;
    const opening = open(async () =>
      handle({
        listTools: () => {
          throw new Error("cannot list");
        },
        onClose: () => (closes += 1),
      }),
    );

    await expect(opening).rejects.toThrow("Failed to list tools on 'docs': cannot list");
    expect(closes).toBe(1);
  });

  it("hard-caps non-finite programmatic tool catalog limits", async () => {
    const tools = Array.from({ length: 2_049 }, (_, index) => ({ name: `tool-${index}` }));
    const opening = open(async () => handle({ listTools: () => ({ tools }) }), {
      maxToolCatalogEntries: Number.POSITIVE_INFINITY,
      maxToolCatalogBytes: Number.NaN,
    });

    await expect(opening).rejects.toThrow("2048-entry limit");
  });
});

describe("openConnection façade composition", () => {
  it("maps listed tools and supplies a default input schema", async () => {
    const opened = await open(async () =>
      handle({
        listTools: () => ({
          tools: [
            { name: "bare" },
            { name: "typed", description: "Typed", inputSchema: { type: "object" } },
          ],
        }),
      }),
    );

    expect(opened.tools).toEqual([
      {
        name: "bare",
        description: undefined,
        inputSchema: { type: "object", properties: {} },
      },
      { name: "typed", description: "Typed", inputSchema: { type: "object" } },
    ]);
    await opened.conn.close();
  });

  it("uses an empty descriptor list for a malformed tools response", async () => {
    const opened = await open(async () => handle({ listTools: () => ({ notTools: true }) }));
    expect(opened.tools).toEqual([]);
    await opened.conn.close();
  });

  it("forwards a representative tool call and maps its successful result", async () => {
    const signal = new AbortController().signal;
    const calls: unknown[] = [];
    const opened = await open(async () =>
      handle({
        callTool: (call, resultSchema, options) => {
          calls.push({ call, resultSchema, options });
          return { content: [{ type: "text", text: "found" }] };
        },
      }),
    );

    const result = await opened.conn.callTool("search", undefined, signal);
    expect(calls).toEqual([
      {
        call: { name: "search", arguments: {} },
        resultSchema: undefined,
        options: { timeout: 250, signal },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      data: { content: [{ type: "text", text: "found" }] },
    });
    await opened.conn.close();
  });

  it("maps a representative SDK tool error through the façade", async () => {
    const opened = await open(async () =>
      handle({
        callTool: () => ({
          isError: true,
          content: [{ type: "text", text: "bad query" }],
        }),
      }),
    );

    expect(await opened.conn.callTool("search", { q: "x" })).toEqual({
      ok: false,
      error: { code: "mcp_runtime_error", message: "bad query", kind: "operational" },
    });
    await opened.conn.close();
  });

  it("wires reconnection to the same factory without replaying an interrupted call", async () => {
    let connects = 0;
    let initialCalls = 0;
    let freshCalls = 0;
    const factory: MCPClientFactory = async () => {
      connects += 1;
      if (connects === 1)
        return handle({
          callTool: () => {
            initialCalls += 1;
            throw new Error("socket closed");
          },
        });
      return handle({
        callTool: () => {
          freshCalls += 1;
          return { content: [{ type: "text", text: "fresh" }] };
        },
      });
    };
    const opened = await open(factory);

    const interrupted = await opened.conn.callTool("search", {});
    expect(interrupted.error?.message).toContain("connection was restored");
    expect(await opened.conn.callTool("search", {})).toEqual({
      ok: true,
      data: { content: [{ type: "text", text: "fresh" }] },
    });
    expect({ connects, initialCalls, freshCalls }).toEqual({
      connects: 2,
      initialCalls: 1,
      freshCalls: 1,
    });
    await opened.conn.close();
  });

  it("exposes connected status and closes the active handle", async () => {
    let closes = 0;
    const opened = await open(async () => handle({ onClose: () => (closes += 1) }));
    expect(opened.conn.status).toBe("connected");
    await opened.conn.close();
    expect(closes).toBe(1);
  });
});
