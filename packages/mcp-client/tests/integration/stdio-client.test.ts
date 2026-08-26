import { describe, it, expect, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { defaultMCPClientFactory } from "@clarvis/mcp-client";
import type { ElicitationRelay, MCPClientHandle } from "@clarvis/mcp-client";
import type { McpServerConfig } from "@clarvis/capability";

const SERVER_ENTRY = fileURLToPath(new URL("../fixtures/mcp-server.ts", import.meta.url));

function stdioTool(): McpServerConfig {
  return {
    name: "cov",
    transport: "stdio",
    command: process.execPath,
    args: [SERVER_ENTRY],
  };
}

const live: MCPClientHandle[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.close().catch(() => {});
});

describe("defaultMCPClientFactory over a live stdio server", () => {
  it("registers an elicitation relay and round-trips a server-initiated request", async () => {
    let received: Record<string, unknown> | undefined;
    const relay: ElicitationRelay = {
      handle: async (params) => {
        received = params;
        return { action: "accept", content: { response: "yes" } };
      },
    };
    const ac = new AbortController();
    const handle = await defaultMCPClientFactory(stdioTool(), relay, {
      signal: ac.signal,
      timeoutMs: 8000,
    });
    live.push(handle);
    const result = await handle.client.callTool({ name: "ask", arguments: {} });
    await handle.close();
    expect(received?.message).toBe("ok?");
    expect(JSON.stringify(result)).toContain("accept");
    expect(JSON.stringify(result)).toContain("yes");
  });

  it("connects with neither a relay nor connect options and tears down on close", async () => {
    const handle = await defaultMCPClientFactory(stdioTool());
    live.push(handle);
    const listed = await handle.client.listTools();
    const negotiated = handle.protocolVersion;
    await handle.close();
    expect(listed.tools.map((t) => t.name)).toContain("ask");
    expect(negotiated).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});
