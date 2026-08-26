import { describe, it, expect, afterEach } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { defaultMCPClientFactory } from "@clarvis/mcp-client";
import type { MCPClientHandle } from "@clarvis/mcp-client";
import type { McpServerConfig } from "@clarvis/capability";

// The version the fake server negotiates DOWN to. Deliberately not the SDK's
// LATEST_PROTOCOL_VERSION, so the assertions prove the negotiated value
// travelled rather than a constant either side already knew.
const NEGOTIATED = "2025-06-18";

interface ProbeServer {
  url: string;
  /** Headers of every POST that carried a JSON-RPC request, by method name. */
  posts: Map<string, http.IncomingHttpHeaders>;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (text += chunk));
    req.on("end", () => resolve(text));
  });
}

/**
 * The smallest Streamable-HTTP MCP server the SDK client will complete a
 * handshake against: it answers `initialize` with a negotiated version, accepts
 * the `initialized` notification, declines the optional GET event stream with a
 * 405, and answers `tools/list` — recording the request headers of each POST.
 */
function probeServer(): Promise<ProbeServer> {
  const posts = new Map<string, http.IncomingHttpHeaders>();
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    void readBody(req).then((text) => {
      const message = JSON.parse(text) as { id?: number | string; method?: string };
      const method = message.method ?? "";
      posts.set(method, req.headers);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        method === "initialize"
          ? {
              protocolVersion: NEGOTIATED,
              capabilities: { tools: {} },
              serverInfo: { name: "probe", version: "0.0.0" },
            }
          : { tools: [] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        posts,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let srv: ProbeServer | undefined;
const live: MCPClientHandle[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.close().catch(() => {});
  await srv?.close();
  srv = undefined;
});

// createMCPClientFactory replaces `transport.setProtocolVersion` with a wrapper
// that does two jobs: it CAPTURES the negotiated version for
// MCPClientHandle.protocolVersion, and it FORWARDS to the transport's own
// implementation. Only the capture half was pinned (by the live stdio test,
// where the transport has no setProtocolVersion of its own and so nothing is
// forwarded). The forwarding half is what keeps `mcp-protocol-version` on every
// post-handshake HTTP request, since StreamableHTTPClientTransport builds that
// header from the value it was handed.
describe("the negotiated MCP protocol version over a live http transport", () => {
  it("is captured on the handle and forwarded to the transport's own header", async () => {
    srv = await probeServer();
    const server: McpServerConfig = { name: "probe", transport: "http", url: srv.url };
    const handle = await defaultMCPClientFactory(server, undefined, { timeoutMs: 8000 });
    live.push(handle);

    expect(handle.protocolVersion).toBe(NEGOTIATED);

    await handle.client.listTools();
    expect(srv.posts.get("initialize")?.["mcp-protocol-version"]).toBeUndefined();
    expect(srv.posts.get("tools/list")?.["mcp-protocol-version"]).toBe(NEGOTIATED);
  });
});
