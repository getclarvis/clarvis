import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new McpServer({ name: "cov", version: "0.0.0" }, {});
server.registerTool("ask", { description: "asks", inputSchema: {} }, async () => {
  const result = await server.server.request(
    {
      method: "elicitation/create",
      params: {
        message: "ok?",
        requestedSchema: {
          type: "object",
          properties: { response: { type: "string" } },
        },
      },
    },
    ElicitResultSchema,
  );
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

await server.connect(new StdioServerTransport());
