import { afterEach, describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadServerEnv } from "../../src/config/env.ts";
import { fixedKernelResolver } from "../../src/host/run-host.ts";
import { serveClarvisMcpOverHttp, type ServeHandle } from "../../src/http/serve.ts";
import { TOOL_NAMES } from "../../src/mcp/tools.ts";
import { createFakeRunHost, type ScriptedRun } from "../helpers/fake-run-host.ts";
import { payloadOf } from "../helpers/harness.ts";
import { createManualTimeouts } from "../helpers/manual-timeouts.ts";
import { recordingLoggers, SILENT_LOGGERS } from "../helpers/harness.ts";

const openHandles = new Set<ServeHandle>();
const openClients = new Set<Client>();

afterEach(async () => {
  await Promise.allSettled([...openClients].map((client) => client.close()));
  openClients.clear();
  await Promise.allSettled([...openHandles].map((handle) => handle.close()));
  openHandles.clear();
});

/** Start the endpoint on an ephemeral port over a scripted host. */
function serve(script: () => ScriptedRun, extraEnv: NodeJS.ProcessEnv = {}, version?: string) {
  const host = createFakeRunHost(script);
  const logs = recordingLoggers();
  const env = loadServerEnv({
    CLARVIS_SERVER_PORT: "0",
    CLARVIS_SERVER_HOST: "127.0.0.1",
    ...extraEnv,
  });
  const handle = serveClarvisMcpOverHttp({
    env,
    logger: logs.loggers,
    resolveKernel: fixedKernelResolver(host, "alice"),
    ...(version === undefined ? {} : { version }),
  });
  openHandles.add(handle);
  return { host, handle, logs, url: new URL(`http://127.0.0.1:${handle.port}/mcp`) };
}

/** Connect a real SDK client over Streamable HTTP. */
async function connect(url: URL): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0.0.0" }, { capabilities: {} });
  openClients.add(client);
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

/** A protocol-valid raw initialize request for HTTP admission tests. */
function initializeRequest(): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "admission-test", version: "0" },
      },
    }),
  };
}

describe("serveClarvisMcpOverHttp", () => {
  it("reports the product version supplied by the executable during MCP initialize", async () => {
    const { url } = serve(() => ({}), {}, "0.0.1-beta");
    const client = await connect(url);
    expect(client.getServerVersion()).toEqual({ name: "@clarvis/server", version: "0.0.1-beta" });
  });

  it("answers /healthz immediately and /readyz once the checks pass", async () => {
    const { handle } = serve(() => ({}));
    const base = `http://127.0.0.1:${handle.port}`;

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);

    handle.stopAccepting();
    const draining = await fetch(`${base}/readyz`);
    expect(draining.status).toBe(503);
    const stillLive = await fetch(`${base}/healthz`);
    expect(stillLive.status).toBe(200);

    await handle.close();
  });

  it("404s an unknown path and rejects a non-initialize POST without a session", async () => {
    const { handle } = serve(() => ({}));
    const base = `http://127.0.0.1:${handle.port}`;

    expect((await fetch(`${base}/nope`)).status).toBe(404);

    const orphan = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(orphan.status).toBe(400);

    await handle.close();
  });

  it("releases a provisional host lease when initialize never creates a session", async () => {
    const host = createFakeRunHost(() => ({}));
    const env = loadServerEnv({
      CLARVIS_SERVER_PORT: "0",
      CLARVIS_SERVER_HOST: "127.0.0.1",
    });
    let releases = 0;
    const handle = serveClarvisMcpOverHttp({
      env,
      logger: SILENT_LOGGERS,
      resolveKernel: async () => ({
        host,
        owner: "alice",
        release: () => {
          releases += 1;
        },
      }),
    });
    openHandles.add(handle);

    const response = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(response.status).toBe(400);
    expect(releases).toBe(1);
    await handle.close();
    expect(releases).toBe(1);
  });

  it("reports resource_exhausted when the live session cap is full", async () => {
    const { handle, url, logs } = serve(() => ({}), { CLARVIS_SERVER_MAX_SESSIONS: "1" });
    await connect(url);

    const response = await fetch(url, initializeRequest());
    const body = (await response.json()) as {
      error?: { data?: { code?: string; req_id?: string } };
    };

    expect(response.status).toBe(503);
    expect(body.error?.data?.code).toBe("resource_exhausted");
    expect(body.error?.data?.req_id).toBe(response.headers.get("x-clarvis-request-id") ?? "");
    expect(logs.find("session.capacity_exhausted")[0]?.fields).toMatchObject({
      limit: 1,
      live: 1,
    });
    await handle.close();
  });

  it("releases an initialize reservation at its deadline and cleans up a late owner lease", async () => {
    const host = createFakeRunHost(() => ({}));
    const env = loadServerEnv({
      CLARVIS_SERVER_PORT: "0",
      CLARVIS_SERVER_HOST: "127.0.0.1",
      CLARVIS_SERVER_MAX_SESSIONS: "1",
      CLARVIS_SERVER_SESSION_INIT_TIMEOUT_MS: "25",
    });
    const timeouts = createManualTimeouts();
    let enterFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    let resolveFirst!: (resolved: {
      host: typeof host;
      owner: string;
      release: () => void;
    }) => void;
    const firstResolution = new Promise<{
      host: typeof host;
      owner: string;
      release: () => void;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    let markLateReleased!: () => void;
    const lateReleased = new Promise<void>((resolve) => {
      markLateReleased = resolve;
    });
    let resolutions = 0;
    const handle = serveClarvisMcpOverHttp({
      env,
      logger: SILENT_LOGGERS,
      scheduleTimeout: timeouts.schedule,
      resolveKernel: async () => {
        resolutions += 1;
        if (resolutions === 1) {
          enterFirst();
          return firstResolution;
        }
        return { host, owner: "alice" };
      },
    });
    openHandles.add(handle);
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);

    const first = fetch(url, initializeRequest());
    await firstEntered;
    expect(timeouts.pending).toBe(1);
    timeouts.fireNext();

    const timedOut = await first;
    const error = (await timedOut.json()) as { error?: { data?: { code?: string } } };
    expect(timedOut.status).toBe(503);
    expect(error.error?.data?.code).toBe("unavailable");

    const replacement = await fetch(url, initializeRequest());
    expect(replacement.status).toBe(200);

    resolveFirst({
      host,
      owner: "alice",
      release: markLateReleased,
    });
    await lateReleased;
    await handle.close();
  });

  it("maps owner-kernel resolution failures to their HTTP status", async () => {
    const cases = [
      ["invalid_request", 400],
      ["unauthorized", 401],
      ["forbidden", 403],
      ["not_found", 404],
      ["conflict", 409],
      ["cancelled", 408],
      ["resource_exhausted", 503],
      ["internal", 500],
    ] as const;

    for (const [code, status] of cases) {
      const env = loadServerEnv({
        CLARVIS_SERVER_PORT: "0",
        CLARVIS_SERVER_HOST: "127.0.0.1",
      });
      const handle = serveClarvisMcpOverHttp({
        env,
        logger: SILENT_LOGGERS,
        resolveKernel: async () => {
          throw Object.assign(new Error(`resolution ${code}`), { code });
        },
      });
      openHandles.add(handle);

      const response = await fetch(`http://127.0.0.1:${handle.port}/mcp`, initializeRequest());
      const body = (await response.json()) as { error?: { data?: { code?: string } } };
      expect(response.status).toBe(status);
      expect(body.error?.data?.code).toBe(code);

      await handle.close();
      openHandles.delete(handle);
    }
  });

  it("deletes an initialized session through the transport close callback", async () => {
    const { handle, url } = serve(() => ({}));
    const initialized = await fetch(url, initializeRequest());
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(initialized.status).toBe(200);
    expect(sessionId).not.toBeNull();

    const deleted = await fetch(url, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId ?? "" },
    });
    expect(deleted.status).toBe(200);

    await handle.close();
  });

  it("runs end to end and steers a pending run on a second request", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { host, handle, url } = serve(() => ({ holdUntil: held }));
    const client = await connect(url);

    const pending = client.callTool({
      name: TOOL_NAMES.run,
      arguments: { prompt: "go", execution_id: "http-1" },
    });
    await host.waitForStart("http-1");

    const ack = payloadOf(
      await client.callTool({
        name: TOOL_NAMES.steer,
        arguments: { execution_id: "http-1", message: "adjust" },
      }),
    );
    expect(ack).toMatchObject({ accepted: true });
    expect(host.steers).toEqual(["adjust"]);

    release();
    const out = payloadOf(await pending);
    expect(out).toMatchObject({ execution_id: "http-1", status: "completed" });

    await client.close();
    await handle.close();
  });

  it("closing the endpoint cancels a run still in flight", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, handle, url } = serve(() => ({ holdUntil: held }));
    const client = await connect(url);

    void client
      .callTool({ name: TOOL_NAMES.run, arguments: { prompt: "go", execution_id: "http-2" } })
      .catch(() => undefined);
    await host.waitForStart("http-2");

    await handle.close(20);
    expect(host.cancels).toContain("http-2");
    release();

    await client.close().catch(() => undefined);
  });

  it("rejects an owner the allowlist does not name, before any run starts", async () => {
    const { host, handle } = serve(() => ({}), {
      CLARVIS_SERVER_OWNER_MODE: "allowlist",
      CLARVIS_SERVER_OWNER_ALLOWLIST: "alice",
    });
    const base = `http://127.0.0.1:${handle.port}`;

    const init = (owner: string) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-clarvis-owner": owner,
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
      });

    expect((await init("mallory")).status).toBe(400);
    expect(host.started).toHaveLength(0);
    expect((await init("alice")).status).toBe(200);

    await handle.close();
  });
});

describe("ServeHandle lifetime", () => {
  it("refuses new sessions once it stops accepting", async () => {
    const { handle } = serve(() => ({}));
    handle.stopAccepting();

    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
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
    });
    expect(res.status).toBe(503);

    await handle.close();
  });

  it("names every answer with a request id, on the wire and in the log", async () => {
    const { handle, url, logs } = serve(() => ({}), { CLARVIS_SERVER_LOG_REQUESTS: "all" });
    await connect(url);

    const requests = logs.find("http.request");
    expect(requests.length).toBeGreaterThan(0);
    const initialize = requests.find((record) => record.fields.rpc_method === "initialize");
    expect(initialize?.fields).toMatchObject({
      method: "POST",
      path: "/mcp",
      status: 200,
      owner: "default",
      owner_authenticated: false,
    });
    expect(String(initialize?.fields.req_id)).toMatch(/^[0-9a-f]{12}$/);
    expect(Number(initialize?.fields.req_bytes)).toBeGreaterThan(0);
    expect(logs.find("session.opened")[0]?.fields).toMatchObject({
      owner: "alice",
      owner_authenticated: false,
      sessions_live: 1,
    });

    await handle.close();
  });

  it("logs only failures in the default mode, and never the probes", async () => {
    const { handle, url, logs } = serve(() => ({}));
    const base = `http://127.0.0.1:${handle.port}`;

    const probing = await fetch(`${base}/healthz`);
    expect(probing.status).toBe(200);
    expect(probing.headers.get("x-clarvis-request-id")).toBeNull();
    expect(logs.find("http.request")).toHaveLength(0);

    const bad = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{ not json",
    });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("x-clarvis-request-id")).toMatch(/^[0-9a-f]{12}$/);
    expect(logs.one("http.request").fields).toMatchObject({ status: 400, path: "/mcp" });

    await handle.close();
  });
});
