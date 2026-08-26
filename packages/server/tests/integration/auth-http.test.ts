import { afterEach, describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";
import { loadServerEnv } from "../../src/config/env.ts";
import type { KernelResolver } from "../../src/host/run-host.ts";
import { serveClarvisMcpOverHttp } from "../../src/http/serve.ts";
import { TOOL_NAMES } from "../../src/mcp/tools.ts";
import { createFakeRunHost, type FakeRunHost, type ScriptedRun } from "../helpers/fake-run-host.ts";
import {
  accessToken,
  cheapHash,
  makeAuthFixture,
  requestToken,
  type AuthFixture,
} from "../helpers/auth.ts";
import { payloadOf } from "../helpers/harness.ts";
import { recordingLoggers, type RecordingLoggers } from "../helpers/harness.ts";

/** A live endpoint with authentication enabled, over a scripted host. */
interface Served {
  host: FakeRunHost;
  fixture: AuthFixture;
  base: string;
  /** Owners the kernel resolver was asked for, in order. */
  owners: string[];
  /** Everything the endpoint logged on either channel. */
  logs: RecordingLoggers;
  close(): Promise<void>;
}

const openServed = new Set<Served>();
const openClients = new Set<Client>();

afterEach(async () => {
  await Promise.allSettled([...openClients].map((client) => client.close()));
  openClients.clear();
  await Promise.allSettled([...openServed].map((served) => served.close()));
});

/** Boot the endpoint on an ephemeral port with the given enrolment. */
async function serve(
  fixture: AuthFixture,
  extraEnv: NodeJS.ProcessEnv = {},
  script: () => ScriptedRun = () => ({}),
): Promise<Served> {
  const host = createFakeRunHost(script);
  const owners: string[] = [];
  const logs = recordingLoggers();
  const env = loadServerEnv({
    CLARVIS_SERVER_PORT: "0",
    CLARVIS_SERVER_HOST: "127.0.0.1",
    CLARVIS_SERVER_AUTH: "required",
    ...extraEnv,
  });
  const resolveKernel: KernelResolver = (ctx) => {
    owners.push(ctx.owner);
    return Promise.resolve({
      host,
      owner: ctx.owner,
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
    });
  };
  const handle = serveClarvisMcpOverHttp({
    env,
    logger: logs.loggers,
    resolveKernel,
    auth: fixture.auth,
  });
  let closed = false;
  const served: Served = {
    host,
    fixture,
    owners,
    logs,
    base: `http://127.0.0.1:${handle.port}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      openServed.delete(served);
      await handle.close();
      fixture.cleanup();
    },
  };
  openServed.add(served);
  return served;
}

/** The JSON-RPC `initialize` body, sent raw so the credential can be varied. */
function initialize(headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    }),
  };
}

/** One enrolled client, used by most cases. */
const SVC = { client_id: "svc", secret: "s3cret", owner: "acme", role: "user" };

describe("the token endpoint", () => {
  it("issues a token for an enrolled client and refuses a wrong secret", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      const ok = await requestToken(served.base, "svc", "s3cret");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.json()).toMatchObject({ token_type: "Bearer", expires_in: 3_600 });

      const wrong = await requestToken(served.base, "svc", "nope");
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toMatchObject({ error: "invalid_client" });
    } finally {
      await served.close();
    }
  });

  it("reports an unknown client exactly as it reports a wrong secret", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      const unknown = await requestToken(served.base, "ghost", "s3cret");
      expect(unknown.status).toBe(401);
      expect(await unknown.json()).toMatchObject({ error: "invalid_client" });
    } finally {
      await served.close();
    }
  });

  it("refuses a disabled client that still knows its secret", async () => {
    const served = await serve(await makeAuthFixture({ clients: [{ ...SVC, disabled: true }] }));
    try {
      const res = await requestToken(served.base, "svc", "s3cret");
      expect(res.status).toBe(401);
    } finally {
      await served.close();
    }
  });

  it("accepts HTTP Basic credentials", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      const res = await fetch(`${served.base}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from("svc:s3cret").toString("base64")}`,
        },
        body: "grant_type=client_credentials",
      });
      expect(res.status).toBe(200);
    } finally {
      await served.close();
    }
  });

  it("refuses every grant but client_credentials, any scope, and a foreign resource", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      const grant = await requestToken(served.base, "svc", "s3cret", {
        grant_type: "authorization_code",
      });
      expect(await grant.json()).toMatchObject({ error: "unsupported_grant_type" });

      const scoped = await requestToken(served.base, "svc", "s3cret", { scope: "admin" });
      expect(await scoped.json()).toMatchObject({ error: "invalid_scope" });

      const foreign = await requestToken(served.base, "svc", "s3cret", {
        resource: "https://elsewhere.test/mcp",
      });
      expect(await foreign.json()).toMatchObject({ error: "invalid_target" });

      const wrongMethod = await fetch(`${served.base}/oauth/token`);
      expect(wrongMethod.status).toBe(405);
    } finally {
      await served.close();
    }
  });

  it("throttles a flood of failures as slow_down, not as a wrong secret", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await requestToken(served.base, "svc", "wrong");
      }
      const throttled = await requestToken(served.base, "svc", "s3cret");
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toBe("60");
      expect(await throttled.json()).toMatchObject({ error: "slow_down" });
    } finally {
      await served.close();
    }
  });

  it("never spends a budget on a success, so a busy client cannot throttle itself", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const res = await requestToken(served.base, "svc", "s3cret");
        expect(res.status).toBe(200);
      }
    } finally {
      await served.close();
    }
  });

  it("does not let one client's failures throttle another sharing its address", async () => {
    const served = await serve(
      await makeAuthFixture({
        clients: [SVC, { client_id: "neighbour", secret: "n-secret", owner: "beta" }],
      }),
    );
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await requestToken(served.base, "svc", "wrong");
      }
      expect((await requestToken(served.base, "svc", "s3cret")).status).toBe(429);

      const neighbour = await requestToken(served.base, "neighbour", "n-secret");
      expect(neighbour.status).toBe(200);
    } finally {
      await served.close();
    }
  });
});

describe("discovery", () => {
  it("publishes the protected resource, the authorization server and the JWKS", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      const prm = await fetch(`${served.base}/.well-known/oauth-protected-resource`);
      expect(prm.status).toBe(200);
      expect(await prm.json()).toMatchObject({
        resource: "https://clarvis.test/mcp",
        authorization_servers: ["https://clarvis.test"],
      });

      const suffixed = await fetch(`${served.base}/.well-known/oauth-protected-resource/mcp`);
      expect(suffixed.status).toBe(200);

      const asm = await fetch(`${served.base}/.well-known/oauth-authorization-server`);
      const metadata = (await asm.json()) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        issuer: "https://clarvis.test",
        token_endpoint: "https://clarvis.test/oauth/token",
        grant_types_supported: ["client_credentials"],
      });
      expect(metadata.registration_endpoint).toBeUndefined();

      const keys = (await (await fetch(`${served.base}/.well-known/jwks.json`)).json()) as {
        keys: Record<string, unknown>[];
      };
      expect(keys.keys).toHaveLength(1);
      expect(keys.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
      expect(keys.keys[0]!.d).toBeUndefined();
    } finally {
      await served.close();
    }
  });

  it("has no registration endpoint at all", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      expect((await fetch(`${served.base}/register`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${served.base}/oauth/register`, { method: "POST" })).status).toBe(404);
    } finally {
      await served.close();
    }
  });

  it("leaves the probes unauthenticated and the MCP path protected", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      expect((await fetch(`${served.base}/healthz`)).status).toBe(200);
      expect((await fetch(`${served.base}/readyz`)).status).toBe(200);
      expect((await fetch(`${served.base}/mcp`, initialize())).status).toBe(401);
    } finally {
      await served.close();
    }
  });
});

describe("the MCP path", () => {
  it("challenges an unauthenticated request with its own resource metadata URL", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      const res = await fetch(`${served.base}/mcp`, initialize());
      expect(res.status).toBe(401);
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain('error="invalid_request"');
      expect(challenge).toContain(
        'resource_metadata="https://clarvis.test/.well-known/oauth-protected-resource/mcp"',
      );
      expect(served.owners).toHaveLength(0);
    } finally {
      await served.close();
    }
  });

  it("does not let the Host header choose where a client looks for its authorization server", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      const res = await fetch(`${served.base}/mcp`, initialize({ host: "evil.example" }));
      expect(res.status).toBe(401);
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).not.toContain("evil.example");
      expect(challenge).toContain('resource_metadata="https://clarvis.test/');
    } finally {
      await served.close();
    }
  });

  it("accepts a token this server minted, leaving the owner to the owner mode", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }));
    try {
      const token = await accessToken(served.base, "svc", "s3cret");
      const res = await fetch(
        `${served.base}/mcp`,
        initialize({ authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(200);
      expect(served.owners).toEqual(["default"]);
    } finally {
      await served.close();
    }
  });

  it("refuses a token minted for a different resource", async () => {
    const fixture = await makeAuthFixture({ clients: [SVC] });
    const served = await serve(fixture);
    try {
      const foreign = await new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: fixture.auth.key.kid })
        .setIssuer("https://clarvis.test")
        .setAudience("https://elsewhere.test/mcp")
        .setSubject("svc")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(fixture.auth.key.privateKey);

      const res = await fetch(
        `${served.base}/mcp`,
        initialize({ authorization: `Bearer ${foreign}` }),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "invalid_token" });
      expect(served.owners).toHaveLength(0);
    } finally {
      await served.close();
    }
  });

  it("refuses an expired token as unauthenticated, not as forbidden", async () => {
    const fixture = await makeAuthFixture({ clients: [SVC] });
    const served = await serve(fixture);
    try {
      const stale = await new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: fixture.auth.key.kid })
        .setIssuer("https://clarvis.test")
        .setAudience("https://clarvis.test/mcp")
        .setSubject("svc")
        .setIssuedAt(Math.floor(Date.now() / 1_000) - 7_200)
        .setExpirationTime(Math.floor(Date.now() / 1_000) - 3_600)
        .sign(fixture.auth.key.privateKey);

      const res = await fetch(
        `${served.base}/mcp`,
        initialize({ authorization: `Bearer ${stale}` }),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "expired_token" });
    } finally {
      await served.close();
    }
  });

  it("forbids a token whose client was removed, before any owner is provisioned", async () => {
    const fixture = await makeAuthFixture({
      clients: [SVC, { client_id: "other", secret: "x", owner: "beta" }],
    });
    const served = await serve(fixture);
    try {
      const token = await accessToken(served.base, "svc", "s3cret");
      fixture.write({
        version: 1,
        issuer: "https://clarvis.test",
        resource: "https://clarvis.test/mcp",
        clients: [{ client_id: "other", secret_hash: cheapHash("x"), owner: "beta" }],
      });
      await Bun.sleep(1_100);

      const res = await fetch(
        `${served.base}/mcp`,
        initialize({ authorization: `Bearer ${token}` }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "unknown_client" });
      expect(served.owners).toHaveLength(0);
      expect(served.host.started).toHaveLength(0);
    } finally {
      await served.close();
    }
  });

  it("narrows a live session when the operator narrows its role", async () => {
    const fixture = await makeAuthFixture({ clients: [SVC] });
    const served = await serve(fixture);
    try {
      const token = await accessToken(served.base, "svc", "s3cret");
      const client = new Client({ name: "e2e", version: "0.0.0" }, { capabilities: {} });
      openClients.add(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${served.base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );

      const before = payloadOf(
        await client.callTool({ name: TOOL_NAMES.run, arguments: { prompt: "go", agent: "root" } }),
      );
      expect(before).toMatchObject({ status: "completed" });

      fixture.write({
        version: 1,
        issuer: "https://clarvis.test",
        resource: "https://clarvis.test/mcp",
        clients: [
          { client_id: "svc", secret_hash: cheapHash("s3cret"), owner: "acme", role: "svc" },
        ],
        roles: { svc: { agents: ["support"] } },
      });
      await Bun.sleep(1_100);

      const after = payloadOf(
        await client.callTool({ name: TOOL_NAMES.run, arguments: { prompt: "go", agent: "root" } }),
      );
      expect(after).toMatchObject({
        error: { code: "forbidden", message: "role 'svc' may not run agent 'root'" },
      });
      expect(served.logs.one("auth.principal.narrowed").fields).toMatchObject({
        from_role: "user",
        to_role: "svc",
        client_id: "svc",
      });
      expect(served.logs.one("authz.agent.denied").fields).toMatchObject({
        client_id: "svc",
        role: "svc",
        agent: "root",
        allowed: "support",
      });

      await client.close();
      openClients.delete(client);
    } finally {
      await served.close();
    }
  });

  it("binds a session to the client that opened it", async () => {
    const served = await serve(
      await makeAuthFixture({
        clients: [SVC, { client_id: "other", secret: "o-secret", owner: "beta" }],
      }),
    );
    try {
      const mine = await accessToken(served.base, "svc", "s3cret");
      const opened = await fetch(
        `${served.base}/mcp`,
        initialize({ authorization: `Bearer ${mine}` }),
      );
      const sessionId = opened.headers.get("mcp-session-id");
      expect(sessionId).not.toBeNull();

      const theirs = await accessToken(served.base, "other", "o-secret");
      const stolen = await fetch(`${served.base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${theirs}`,
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(stolen.status).toBe(403);
      expect(await stolen.json()).toMatchObject({ error: "session_mismatch" });
      expect(served.logs.one("auth.session.mismatch").fields).toMatchObject({
        session_id: sessionId,
        expected_client: "svc",
        presented_client: "other",
      });
    } finally {
      await served.close();
    }
  });
});

describe("owner mode 'token'", () => {
  it("takes the owner from the enrolment record, not from the caller", async () => {
    const served = await serve(await makeAuthFixture({ clients: [SVC] }), {
      CLARVIS_SERVER_OWNER_MODE: "token",
    });
    try {
      const token = await accessToken(served.base, "svc", "s3cret");
      const res = await fetch(
        `${served.base}/mcp`,
        initialize({ authorization: `Bearer ${token}`, "x-clarvis-owner": "acme" }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "owner_not_permitted" });
      expect(served.logs.one("authz.owner.impersonation_denied").fields).toMatchObject({
        client_id: "svc",
        role: "user",
        claimed_owner: "acme",
      });

      const plain = await fetch(
        `${served.base}/mcp`,
        initialize({ authorization: `Bearer ${token}` }),
      );
      expect(plain.status).toBe(200);
      expect(served.owners).toEqual(["acme"]);
    } finally {
      await served.close();
    }
  });

  it("lets a role that may impersonate act for another owner", async () => {
    const served = await serve(
      await makeAuthFixture({
        clients: [{ client_id: "ops", secret: "o", owner: "ops", role: "admin" }],
      }),
      { CLARVIS_SERVER_OWNER_MODE: "token" },
    );
    try {
      const token = await accessToken(served.base, "ops", "o");
      const res = await fetch(
        `${served.base}/mcp`,
        initialize({ authorization: `Bearer ${token}`, "x-clarvis-owner": "tenant-9" }),
      );
      expect(res.status).toBe(200);
      expect(served.owners).toEqual(["tenant-9"]);
      const impersonated = served.logs.one("authz.owner.impersonated");
      expect(impersonated.fields).toMatchObject({
        client_id: "ops",
        role: "admin",
        owner: "ops",
        acting_for: "tenant-9",
        owner_authenticated: true,
      });
      expect(served.logs.one("session.opened").fields).toMatchObject({
        owner: "tenant-9",
        owner_authenticated: true,
        client_id: "ops",
      });
    } finally {
      await served.close();
    }
  });

  it("refuses to let a live session follow its client to a new owner", async () => {
    const fixture = await makeAuthFixture({ clients: [SVC] });
    const served = await serve(fixture, { CLARVIS_SERVER_OWNER_MODE: "token" });
    try {
      const token = await accessToken(served.base, "svc", "s3cret");
      const opened = await fetch(
        `${served.base}/mcp`,
        initialize({ authorization: `Bearer ${token}` }),
      );
      const sessionId = opened.headers.get("mcp-session-id");
      expect(sessionId).not.toBeNull();

      fixture.write({
        version: 1,
        issuer: "https://clarvis.test",
        resource: "https://clarvis.test/mcp",
        clients: [{ client_id: "svc", secret_hash: cheapHash("s3cret"), owner: "beta" }],
      });
      await Bun.sleep(1_100);

      const stale = await fetch(`${served.base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(stale.status).toBe(403);
      expect(await stale.json()).toMatchObject({ error: "session_stale" });
      expect(served.logs.one("auth.session.stale").fields).toMatchObject({
        session_id: sessionId,
        client_id: "svc",
        from_owner: "acme",
        to_owner: "beta",
        owner_authenticated: true,
      });
    } finally {
      await served.close();
    }
  });

  it("is rejected at boot without authentication behind it", () => {
    expect(() =>
      loadServerEnv({ CLARVIS_SERVER_OWNER_MODE: "token", CLARVIS_SERVER_AUTH: "off" }),
    ).toThrow(/requires CLARVIS_SERVER_AUTH=required/);
  });

  it("refuses a header-driven owner on an authenticated server", () => {
    expect(() =>
      loadServerEnv({ CLARVIS_SERVER_OWNER_MODE: "header", CLARVIS_SERVER_AUTH: "required" }),
    ).toThrow(/use 'token' or 'fixed'/);
  });
});

describe("the auth switch", () => {
  it("refuses to serve when the two halves disagree", () => {
    const base = { CLARVIS_SERVER_PORT: "0", CLARVIS_SERVER_HOST: "127.0.0.1" };
    expect(() =>
      serveClarvisMcpOverHttp({
        env: loadServerEnv({ ...base, CLARVIS_SERVER_AUTH: "required" }),
        logger: recordingLoggers().loggers,
        resolveKernel: () => {
          throw new Error("unreachable");
        },
      }),
    ).toThrow(/no authentication layer was supplied/);
  });
});
