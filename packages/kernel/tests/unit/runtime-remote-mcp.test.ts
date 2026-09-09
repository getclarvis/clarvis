import { describe, expect, it, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import type { McpServerConfig, ToolResult } from "@clarvis/capability";
import {
  MCPAuthorizationPendingError,
  MCPBackgroundConnectDeferredError,
  MCPConnectionFailedError,
  type AcquireOptions,
  type Lease,
} from "@clarvis/mcp-client";
import {
  createGuestMcpConnections,
  createHostRemoteMcpBridge,
} from "../../src/runtime/remote-mcp.ts";

function fixture(error?: Error) {
  const server: McpServerConfig = {
    name: "remote",
    transport: "http",
    url: "https://remote.test/mcp",
    bearer_token_env_var: "HOST_TOKEN",
    env_http_headers: { "X-Key": "HOST_KEY" },
    oauth: { client_id: "host-client" },
  };
  const release = mock(async () => undefined);
  const tool = mock(async (): Promise<ToolResult> => ({ ok: true, data: "remote result" }));
  let acquired: AcquireOptions | undefined;
  const lease: Lease = {
    tools: [
      { name: "inspect", inputSchema: {} },
      { name: "list_resources", inputSchema: {}, kind: "resource_list" },
      { name: "read_resource", inputSchema: {}, kind: "resource_read" },
    ],
    conn: {
      name: "remote",
      transport: "http",
      status: "connected",
      instructions: "remote instructions",
      callTool: tool,
      listResources: async () => ({ ok: true, data: [] }),
      readResource: async (uri) => ({ ok: true, data: uri }),
      close: release,
    },
    release,
  };
  const forwarded: unknown[] = [];
  const run = new AbortController();
  const host = createHostRemoteMcpBridge({
    servers: [
      server,
      { ...server, name: "disabled", enabled: false },
      { name: "local", transport: "stdio", command: "never-on-host" },
    ],
    owner: "owner",
    maxLeases: 1,
    connections: {
      acquire: async (input) => {
        acquired = input;
        if (error) throw error;
        return lease;
      },
      closeAll: async () => undefined,
    },
    elicit: (input, signal) => guest.elicit(input, signal),
  });
  const localAcquire = mock(async () => ({
    ...lease,
    conn: { ...lease.conn, transport: "stdio" as const },
  }));
  const guest = createGuestMcpConnections({
    signal: run.signal,
    local: { acquire: localAcquire, closeAll: async () => undefined },
    bridge: {
      capability: async (_id, request, signal) => {
        forwarded.push(request);
        expect(host.grant.validateArguments(request.arguments)).toBe(true);
        return host.grant.invoke(request.arguments, signal ?? new AbortController().signal);
      },
      model: async () => {
        throw new Error("unexpected model");
      },
      event: async () => undefined,
      checkpoint: async () => undefined,
    },
  });
  return {
    host,
    guest,
    server,
    release,
    tool,
    forwarded,
    localAcquire,
    run,
    acquired: () => acquired,
  };
}

describe("runtime remote MCP ownership", () => {
  it("uses the host snapshot and owner, proxies tools/resources, and keeps stdio local", async () => {
    const f = fixture();
    const original = structuredClone(f.server);
    f.server.url = "https://forged.test";
    const remote = await f.guest.acquire({
      server: f.server,
      owner: "forged-owner",
      authorizationWait: "background",
    });
    try {
      expect(f.acquired()).toMatchObject({
        server: original,
        owner: "owner",
        poolSharing: "owner",
        authorizationWait: "background",
      });
      expect(remote.conn.instructions).toBe("remote instructions");
      expect(await remote.conn.callTool("inspect", {})).toEqual({
        ok: true,
        data: "remote result",
      });
      expect(await remote.conn.listResources!()).toEqual({ ok: true, data: [] });
      expect(await remote.conn.readResource!("resource:allowed")).toEqual({
        ok: true,
        data: "resource:allowed",
      });
      expect(f.localAcquire).not.toHaveBeenCalled();
      expect(JSON.stringify(f.forwarded)).not.toContain("HOST_TOKEN");
      expect(JSON.stringify(f.forwarded)).not.toContain("forged.test");
      await expect(remote.conn.callTool("hidden", {})).rejects.toMatchObject({
        code: "unauthorized",
      });
      const local = await f.guest.acquire({
        server: { name: "local", transport: "stdio", command: "guest-only" },
        owner: "owner",
      });
      expect(local.conn.transport).toBe("stdio");
      expect(f.localAcquire).toHaveBeenCalledTimes(1);
    } finally {
      await remote.release();
      await f.guest.closeAll();
      await f.host.dispose();
    }
    expect(f.release).toHaveBeenCalledTimes(1);
    await expect(remote.conn.callTool("inspect", {})).rejects.toThrow("closed");
  });

  it.each([
    new MCPAuthorizationPendingError(),
    new MCPBackgroundConnectDeferredError(4),
    new MCPConnectionFailedError("remote", "http", "failed"),
  ])("preserves typed acquisition failure %s", async (error) => {
    const f = fixture(error);
    try {
      await expect(f.guest.acquire({ server: f.server, owner: "owner" })).rejects.toBeInstanceOf(
        error.constructor,
      );
    } finally {
      await f.guest.closeAll();
      await f.host.dispose();
    }
    expect(f.release).not.toHaveBeenCalled();
  });

  it("routes elicitation to the matching live guest lease and rejects a stale lease", async () => {
    const f = fixture();
    const relay = mock(async () => ({ action: "accept" as const, content: { approved: true } }));
    const lease = await f.guest.acquire({
      server: f.server,
      owner: "owner",
      relay: { handle: relay },
    });
    try {
      expect(await f.acquired()!.relay!.handle({ message: "approve" })).toEqual({
        action: "accept",
        content: { approved: true },
      });
      expect(relay).toHaveBeenCalledTimes(1);
      await expect(
        f.guest.elicit({ leaseId: randomUUID(), params: {} }, f.run.signal),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await lease.release();
      await expect(f.acquired()!.relay!.handle({ message: "late" })).rejects.toBeInstanceOf(Error);
    } finally {
      await f.guest.closeAll();
      await f.host.dispose();
    }
  });

  it("refuses undeclared/disabled/stdio servers, forged configuration, stale leases and over-capacity acquisition", async () => {
    const f = fixture();
    const request = {
      operation: "acquire",
      leaseId: randomUUID(),
      server: "remote",
      elicitation: false,
      authorizationWait: "background",
    };
    try {
      for (const server of ["disabled", "local", "unknown"]) {
        await expect(
          f.host.grant.invoke({ ...request, server }, f.run.signal),
        ).rejects.toMatchObject({ code: "unauthorized" });
      }
      expect(f.host.grant.validateArguments({ ...request, url: "https://forged.test" })).toBe(
        false,
      );
      expect(
        f.host.grant.validateArguments({
          operation: "callTool",
          leaseId: request.leaseId,
          tool: "inspect",
        }),
      ).toBe(false);
      await f.host.grant.invoke(request, f.run.signal);
      await expect(f.host.grant.invoke(request, f.run.signal)).rejects.toMatchObject({
        code: "unauthorized",
      });
      await expect(
        f.host.grant.invoke({ ...request, leaseId: randomUUID() }, f.run.signal),
      ).rejects.toMatchObject({ code: "resource_exhausted" });
      await expect(
        f.host.grant.invoke(
          { operation: "callTool", leaseId: randomUUID(), tool: "inspect", input: {} },
          f.run.signal,
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });
    } finally {
      await f.host.dispose();
    }
    expect(f.release).toHaveBeenCalledTimes(1);
    await expect(f.host.grant.invoke(request, f.run.signal)).rejects.toThrow("closed");
  });

  it.each(["cancel", "dispose"])(
    "releases a host acquisition that completes after %s",
    async (mode) => {
      const pending = Promise.withResolvers<Lease>();
      const acquired = Promise.withResolvers<void>();
      const release = mock(async () => undefined);
      const controller = new AbortController();
      const bridge = createHostRemoteMcpBridge({
        servers: [{ name: "remote", transport: "http", url: "https://remote.test" }],
        owner: "owner",
        maxLeases: 1,
        connections: {
          acquire: async () => {
            acquired.resolve();
            return pending.promise;
          },
          closeAll: async () => undefined,
        },
        elicit: async () => ({ action: "cancel" }),
      });
      const call = bridge.grant.invoke(
        {
          operation: "acquire",
          leaseId: randomUUID(),
          server: "remote",
          elicitation: false,
          authorizationWait: "background",
        },
        controller.signal,
      );
      await acquired.promise;
      if (mode === "cancel") controller.abort(new Error("cancelled"));
      else await bridge.dispose();
      pending.resolve({
        tools: [],
        conn: {
          name: "remote",
          transport: "http",
          status: "connected",
          callTool: async () => ({ ok: true }),
          close: release,
        },
        release,
      });
      expect(await call).toMatchObject({ ok: false, error: "failed" });
      await bridge.dispose();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );
});
