import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "@clarvis/capability";
import {
  createMCPAuthorizationCoordinator,
  createMCPClientFactory,
  openConnection,
  type MCPAuthorizationCoordinator,
} from "@clarvis/mcp-client";

const SCOPE = { workspace: "/workspace/oauth", owner: "owner" };
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

interface OAuthMcpFixture {
  url: string;
  registrations: number;
  tokenExchanges: number;
  authenticatedMcpRequests: number;
  close(): Promise<void>;
}

async function oauthMcpFixture(): Promise<OAuthMcpFixture> {
  let origin = "";
  const fixture: OAuthMcpFixture = {
    url: "",
    registrations: 0,
    tokenExchanges: 0,
    authenticatedMcpRequests: 0,
    close: async () => {},
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["mcp:tools"],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      fixture.registrations += 1;
      const metadata = JSON.parse(await bodyOf(req)) as Record<string, unknown>;
      json(res, 201, { ...metadata, client_id: "clarvis-test-client" });
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      fixture.tokenExchanges += 1;
      const form = new URLSearchParams(await bodyOf(req));
      if (
        form.get("grant_type") !== "authorization_code" ||
        form.get("code") !== "approved-code" ||
        !form.get("code_verifier")
      ) {
        json(res, 400, { error: "invalid_grant" });
        return;
      }
      json(res, 200, {
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "Bearer",
        expires_in: 3_600,
      });
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== "Bearer test-access-token") {
      res.writeHead(401, {
        "www-authenticate":
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", ` +
          'scope="mcp:tools"',
      });
      res.end();
      return;
    }
    fixture.authenticatedMcpRequests += 1;
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405).end();
      return;
    }
    const message = JSON.parse(await bodyOf(req)) as {
      id?: string | number;
      method?: string;
      params?: { protocolVersion?: string };
    };
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (message.method === "initialize") {
      json(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "oauth-fixture", version: "1.0.0" },
        },
      });
      return;
    }
    if (message.method === "tools/list") {
      json(res, 200, { jsonrpc: "2.0", id: message.id, result: { tools: [] } });
      return;
    }
    json(res, 200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32_601, message: "method not found" },
    });
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: String(error) });
      else res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(port)}`;
  fixture.url = `${origin}/mcp`;
  fixture.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fixture;
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("remote MCP OAuth transport", () => {
  it("discovers, registers, authorizes, exchanges PKCE, reconnects, and reuses tokens", async () => {
    const fixture = await oauthMcpFixture();
    cleanups.push(() => fixture.close());
    const root = await mkdtemp(join(tmpdir(), "clarvis-mcp-oauth-e2e-"));
    roots.push(root);
    const stateDir = join(root, "state");
    await mkdir(stateDir);
    const openedAuthorizationUrls: string[] = [];
    const authorization: MCPAuthorizationCoordinator = createMCPAuthorizationCoordinator({
      storeFile: join(stateDir, "mcp-oauth.json"),
      callbackPort: 0,
      openAuthorizationUrl: async (value) => {
        openedAuthorizationUrls.push(value);
        const authorizationUrl = new URL(value);
        expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorizationUrl.searchParams.get("scope")).toBe("mcp:tools");
        const redirect = authorizationUrl.searchParams.get("redirect_uri");
        const state = authorizationUrl.searchParams.get("state");
        if (redirect === null || state === null) return false;
        const callback = new URL(redirect);
        callback.searchParams.set("state", state);
        callback.searchParams.set("code", "approved-code");
        return (await fetch(callback)).ok;
      },
    });
    cleanups.push(() => authorization.close());
    const factory = createMCPClientFactory({}, { authorization });
    const server: McpServerConfig = {
      name: "oauth-remote",
      transport: "http",
      url: fixture.url,
    };
    const options = {
      scope: SCOPE,
      server,
      factory,
      connectTimeoutMs: 2_000,
      callTimeoutMs: 2_000,
      resourcesEnabled: false,
      healthPingIntervalMs: 0,
    };

    const first = await openConnection(options);
    expect(first.tools).toEqual([]);
    await first.conn.close();
    const second = await openConnection(options);
    expect(second.tools).toEqual([]);
    await second.conn.close();

    expect(openedAuthorizationUrls).toHaveLength(1);
    expect(fixture.registrations).toBe(1);
    expect(fixture.tokenExchanges).toBe(1);
    expect(fixture.authenticatedMcpRequests).toBeGreaterThanOrEqual(4);
  });
});
