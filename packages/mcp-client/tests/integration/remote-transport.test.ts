import { describe, it, expect, afterEach } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { openConnection, defaultMCPClientFactory } from "@clarvis/mcp-client";
import type { McpServerConfig } from "@clarvis/capability";

const SCOPE = { workspace: "/ws", owner: "o" };

interface CaptureServer {
  url: string;
  firstHeaders: Promise<http.IncomingHttpHeaders>;
  close: () => Promise<void>;
}

function captureServer(): Promise<CaptureServer> {
  let resolveHeaders!: (h: http.IncomingHttpHeaders) => void;
  const firstHeaders = new Promise<http.IncomingHttpHeaders>((r) => (resolveHeaders = r));
  const server = http.createServer((req, res) => {
    resolveHeaders(req.headers);
    res.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        firstHeaders,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const OPTS = { connectTimeoutMs: 1500, callTimeoutMs: 1500, factory: defaultMCPClientFactory };

let srv: CaptureServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

describe("remote transport reaches a server over real HTTP", () => {
  it("connects over http with the SDK's Accept header preserved", async () => {
    srv = await captureServer();
    const tool: McpServerConfig = { name: "remote", transport: "http", url: srv.url };
    void openConnection({ scope: SCOPE, server: tool, ...OPTS }).catch(() => {});
    const headers = await srv.firstHeaders;
    expect(headers.accept).toContain("application/json");
    expect(headers.accept).toContain("text/event-stream");
  });

  it("sends a ${VAR} auth header RESOLVED from env — never the literal — alongside Accept", async () => {
    process.env.CLARVIS_TEST_REMOTE_TOK = "s3cret-value";
    srv = await captureServer();
    try {
      const tool: McpServerConfig = {
        name: "remote",
        transport: "http",
        url: srv.url,
        headers: { Authorization: "Bearer ${CLARVIS_TEST_REMOTE_TOK}" },
      };
      void openConnection({ scope: SCOPE, server: tool, ...OPTS }).catch(() => {});
      const headers = await srv.firstHeaders;
      expect(headers.authorization).toBe("Bearer s3cret-value");
      expect(headers.authorization).not.toContain("${");
      expect(headers.accept).toContain("text/event-stream");
    } finally {
      delete process.env.CLARVIS_TEST_REMOTE_TOK;
    }
  });

  it("an absent ${VAR} fails the connection before any request (no literal sent)", async () => {
    const tool: McpServerConfig = {
      name: "remote",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${CLARVIS_ABSENT_039}" },
    };
    await expect(openConnection({ scope: SCOPE, server: tool, ...OPTS })).rejects.toThrow();
  });
});
