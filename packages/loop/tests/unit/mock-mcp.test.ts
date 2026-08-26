import { describe, expect, it } from "../bun-test.ts";
import { mockMCPFactory } from "../../src/testing/mock-mcp.ts";

describe("mockMCPFactory", () => {
  it("rejects an unconfigured server and supports closing through the client", async () => {
    const factory = mockMCPFactory({ configured: { tools: [] } });
    await expect(
      factory({ name: "missing", transport: "stdio", command: "node", args: [] }),
    ).rejects.toThrow("No mock MCP configured");

    const handle = await factory({
      name: "configured",
      transport: "stdio",
      command: "node",
      args: [],
    });
    await handle.client.close();
    await expect(handle.client.callTool({ name: "x", arguments: {} })).rejects.toThrow("closed");
  });
});
