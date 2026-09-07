/** Synthetic MCP peer exercising the real HTTP/SSE client without external services or secrets. */
export function remoteServer(transport: "http" | "sse", header: string, expected: string) {
  const headers: string[] = [];
  let events: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      headers.push(request.headers.get(header) ?? "");
      if (request.headers.get(header) !== expected)
        return new Response("unauthorized", { status: 401 });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (request.method === "GET") {
        if (transport === "http") return new Response(null, { status: 405 });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              events = controller;
              controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
            },
            cancel() {
              events = undefined;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const input = (await request.json()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (input.id === undefined) return new Response(null, { status: 202 });
      const result =
        input.method === "initialize"
          ? {
              protocolVersion: input.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic-remote", version: "1" },
              instructions: "host authenticated MCP",
            }
          : input.method === "tools/list"
            ? { tools: [{ name: "inspect", inputSchema: { type: "object" } }] }
            : input.method === "tools/call"
              ? { content: [{ type: "text", text: "authenticated remote result" }] }
              : {};
      const message = { jsonrpc: "2.0", id: input.id, result };
      if (transport === "sse") {
        events!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
        return new Response(null, { status: 202 });
      }
      return Response.json(message);
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}/${transport === "sse" ? "sse" : "mcp"}`,
    headers,
    async close() {
      await server.stop(true);
    },
  };
}
