import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "stderr-fixture", version: "0.0.0" }, {});
server.registerTool("noop", { description: "does nothing", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "ok" }],
}));

process.stderr.write("fixture diagnostic\n");
await server.connect(new StdioServerTransport());
