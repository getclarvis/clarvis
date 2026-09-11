import { describe, expect, it, mock } from "bun:test";
import type { McpServerConfig, ToolResult } from "@clarvis/capability";
import { createGuestHookMcpCaller } from "../../src/runtime/hook-mcp.ts";

function fixture(
  callTool = async (
    _tool: string,
    _input: unknown,
    _signal?: AbortSignal,
  ): Promise<ToolResult> => ({
    ok: true,
    data: { accepted: true },
  }),
) {
  const server: McpServerConfig = {
    name: "review",
    transport: "stdio",
    command: "guest-command",
    args: ["--guest"],
    env: { FIXTURE: "guest-value" },
  };
  const release = mock(async () => undefined);
  const call = mock(callTool);
  const acquire = mock(
    async (
      _options: Parameters<
        Parameters<typeof createGuestHookMcpCaller>[0]["connections"]["acquire"]
      >[0],
    ) => ({
      tools: [],
      conn: {
        name: server.name,
        status: "connected" as const,
        transport: "stdio" as const,
        close: async () => undefined,
        callTool: call,
      },
      release,
    }),
  );
  const run = new AbortController();
  const invoke = createGuestHookMcpCaller({
    servers: [
      server,
      { ...server, name: "disabled", enabled: false },
      { name: "remote-http", transport: "http", url: "https://hooks.invalid/mcp" },
      { name: "remote-sse", transport: "sse", url: "https://hooks.invalid/sse" },
    ],
    owner: "run-owner",
    connections: { acquire, closeAll: async () => undefined },
    signal: run.signal,
  });
  return { server, run, invoke, acquire, release, call };
}

const input = { server: "review", tool: "inspect", input: { mode: "solo" } };

describe("guest stdio MCP hooks", () => {
  it("uses the run's server snapshot and owner before the ordinary MCP pool opens", async () => {
    const f = fixture();
    const original = structuredClone(f.server);
    f.server.command = "modified-command";
    f.server.env!.FIXTURE = "modified-value";
    const signal = new AbortController().signal;
    await expect(f.invoke(input, signal)).resolves.toEqual({ ok: true, data: { accepted: true } });
    expect(f.acquire).toHaveBeenCalledTimes(1);
    const options = f.acquire.mock.calls[0]![0];
    expect(options).toEqual({
      server: original,
      owner: "run-owner",
      poolSharing: "owner",
      signal: expect.any(AbortSignal),
    });
    expect(f.call).toHaveBeenCalledWith("inspect", { mode: "solo" }, options.signal);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "disabled", "remote-http", "remote-sse"])(
    "refuses non-admitted server %s",
    async (server) => {
      const f = fixture();
      await expect(
        f.invoke({ ...input, server }, new AbortController().signal),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(f.acquire).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {},
    { ...input, server: "" },
    { ...input, tool: "" },
    { server: "review", tool: "inspect" },
    { ...input, command: "host-command" },
    { ...input, cwd: "/host" },
    { ...input, env: { TOKEN: "host-secret" } },
    { ...input, url: "https://hooks.invalid/mcp" },
    { ...input, owner: "another-owner" },
  ])("refuses malformed or authority-widening payload %j", async (payload) => {
    const f = fixture();
    await expect(f.invoke(payload, new AbortController().signal)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it("releases the lease on tool failure and never retries the call elsewhere", async () => {
    const f = fixture(async () => {
      throw new Error("guest MCP failed");
    });
    await expect(f.invoke(input, new AbortController().signal)).rejects.toThrow("guest MCP failed");
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed connection acquisition", async () => {
    const f = fixture();
    f.acquire.mockRejectedValueOnce(new Error("guest command unavailable"));
    await expect(f.invoke(input, new AbortController().signal)).rejects.toThrow(
      "guest command unavailable",
    );
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it.each(["call", "run"])(
    "cancels in-flight tools on %s cancellation and releases their lease",
    async (target) => {
      const started = Promise.withResolvers<void>();
      const f = fixture(async (_tool, _input, signal) => {
        started.resolve();
        return new Promise((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () =>
              reject(
                signal!.reason instanceof Error ? signal!.reason : new Error("hook cancelled"),
              ),
            { once: true },
          );
        });
      });
      const call = new AbortController();
      const pending = f.invoke(input, call.signal);
      await started.promise;
      (target === "call" ? call : f.run).abort(new Error("hook cancelled"));
      await expect(pending).rejects.toThrow("hook cancelled");
      expect(f.release).toHaveBeenCalledTimes(1);
      if (target === "run") {
        await expect(f.invoke(input, new AbortController().signal)).rejects.toThrow(
          "hook cancelled",
        );
        expect(f.acquire).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("refuses an already-cancelled call before opening a connection", async () => {
    const f = fixture();
    await expect(
      f.invoke(input, AbortSignal.abort(new Error("already cancelled"))),
    ).rejects.toThrow("already cancelled");
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it("releases a lease acquired at the cancellation boundary without invoking its tool", async () => {
    const f = fixture();
    const pending = f.invoke(input, new AbortController().signal);
    f.run.abort(new Error("run closed"));
    await expect(pending).rejects.toThrow("run closed");
    expect(f.call).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});
