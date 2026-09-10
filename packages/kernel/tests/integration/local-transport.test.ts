import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, chmod, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "@clarvis/capability";
import { localHostPaths } from "@clarvis/paths";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM } from "@clarvis/loop/testing";
import type { KernelTransport } from "@clarvis/protocol";
import { createInProcessKernel } from "../../src/kernel.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import { createKernelServer } from "../../src/transport/server.ts";
import { connectKernelClient } from "../../src/transport/client.ts";
import {
  connectLocalKernelTransport,
  listenLocalKernel,
  type LocalKernelListenerOptions,
} from "../../src/transport/local.ts";
import { kernelError } from "../../src/core/errors.ts";
import { CLARVIS_WIRE_VERSION, M } from "../../src/transport/wire.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(options?: LocalKernelListenerOptions) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-local-rpc-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const paths = localHostPaths({
    globalDir: join(root, "global"),
    workspaceRoot: root,
    owner: "fixture",
    operatorId: "fixture-operator",
  });
  if (paths.endpointDirectory !== undefined) {
    const directory = paths.endpointDirectory;
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
  }
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" });
  const kernel = createInProcessKernel({
    workspaceRoot: root,
    globalConfigDir: join(root, "global"),
    ...kernelIdentity(root),
    deps: {
      env,
      workspaceRoot: root,
      llm: new MockLLM({ script: [{ text: "RPC result." }] }),
      traceStore: createMemoryTraceStore(),
      connections: createConnectionManager({
        workspace: root,
        factory: defaultMCPClientFactory,
        connectTimeoutMs: 1000,
        callTimeoutMs: 1000,
      }),
    },
    configStore: createMemoryConfigStore({
      settings: {
        global: {
          providers: [{ name: "anthropic", kind: "anthropic" }],
          default_model: "anthropic/x",
        },
      },
      agents: [
        {
          name: "solo",
          scope: "global",
          frontmatter: { model: "anthropic/x", tools: [] },
          body: "You are solo.",
          model: "anthropic/x",
        },
      ],
    }),
  });
  cleanup.push(() => kernel.close());
  const server = createKernelServer(kernel, {
    resolveConnection(params) {
      if (params.auth !== "fixture-local-token")
        throw kernelError("unauthorized", "invalid local credential");
      return {
        ...kernelIdentity(root),
        principal: { id: "fixture-operator" },
        services: {
          ...kernel.operatorServices,
          goals: kernel.goals,
          ...kernel.defaultOwnerServices,
        },
      };
    },
    authorize: ({ principal, metadata }) =>
      principal?.id === "fixture-operator" && metadata.sensitivity !== "secrets",
  });
  const listener = await listenLocalKernel(server, paths.endpoint, options);
  cleanup.push(() => listener.close());
  const connect = async (): Promise<KernelTransport> => {
    const transport = await connectLocalKernelTransport(paths.endpoint);
    cleanup.push(() => transport.close());
    return transport;
  };
  return { kernel, server, listener, connect, paths };
}

describe("kernel RPC over reconnectable local IPC", () => {
  test("uses the existing client, authorization, services, events and result across connections", async () => {
    const fixture = await setup();
    const transport = await fixture.connect();
    const client = await connectKernelClient(transport, { auth: "fixture-local-token" });
    expect(client.principal?.id).toBe("fixture-operator");
    expect((await client.config.listAgents()).map((agent) => agent.name)).toContain("solo");
    await expect(client.secrets.listNames()).rejects.toMatchObject({ code: "unauthorized" });
    await expect(transport.request("host.capability", {})).rejects.toMatchObject({
      code: "invalid_request",
    });
    const handle = await client.runs.start({
      execution_id: "local-ipc-run",
      agent: "solo",
      messages: [{ role: "user", content: "Return a result." }],
    });
    const events = Array.fromAsync(handle.events);
    expect(await handle.done).toMatchObject({ execution_id: "local-ipc-run", status: "completed" });
    expect((await events).some((event) => event.type === "run_started")).toBe(true);
    await handle.closed;
    await client.close();
    const next = await connectKernelClient(await fixture.connect(), {
      auth: "fixture-local-token",
    });
    expect((await next.runs.get("local-ipc-run")).result?.status).toBe("completed");
  });

  test("invalid credentials and incompatible wire revisions do not receive services", async () => {
    const fixture = await setup();
    const unauthenticated = await fixture.connect();
    await expect(connectKernelClient(unauthenticated, { auth: "wrong" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    await unauthenticated.close();
    const incompatible = await fixture.connect();
    await expect(
      incompatible.request(M.hello, {
        wire_version: CLARVIS_WIRE_VERSION + 1,
        auth: "fixture-local-token",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  test("bounds clients and never removes the endpoint of another listener", async () => {
    const fixture = await setup({ maxConnections: 1 });
    const first = await fixture.connect();
    await connectKernelClient(first, { auth: "fixture-local-token" });
    const second = await fixture.connect();
    await expect(
      connectKernelClient(second, { auth: "fixture-local-token" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fixture.listener.connections()).toBe(1);
    await expect(listenLocalKernel(fixture.server, fixture.paths.endpoint)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(await first.request("config.listAgents", {})).toBeArray();
  });

  test("clients which never finish hello are disconnected by the listener", async () => {
    const fixture = await setup({ helloTimeoutMs: 20 });
    const socket = createConnection({ path: fixture.paths.endpoint });
    const closed = once(socket, "close");
    await closed;
    expect(socket.destroyed).toBe(true);
    expect(fixture.listener.connections()).toBe(0);
  });

  test("malformed frames close only their connection and a fresh client can negotiate", async () => {
    const fixture = await setup();
    const socket = createConnection({ path: fixture.paths.endpoint });
    const closed = once(socket, "close");
    await once(socket, "connect");
    socket.write("{broken-json}\n");
    await closed;
    const client = await connectKernelClient(await fixture.connect(), {
      auth: "fixture-local-token",
    });
    expect(client.workspace.id).toBe(fixture.kernel.workspace.id);
  });

  test("a missing endpoint fails within the connection operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-local-rpc-missing-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await expect(connectLocalKernelTransport(join(root, "missing"))).rejects.toBeInstanceOf(Error);
    await expect(connectLocalKernelTransport("unused", { timeoutMs: 0 })).rejects.toThrow(
      "positive safe integer",
    );
  });

  test.skipIf(process.platform === "win32")(
    "refuses a socket directory readable by other accounts",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "clarvis-local-rpc-mode-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const directory = join(root, "public");
      await mkdir(directory, { mode: 0o755 });
      await chmod(directory, 0o755);
      await expect(
        listenLocalKernel(
          {
            connect: () => {
              throw new Error("must not reach dispatch");
            },
          },
          join(directory, "socket"),
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });
    },
  );
});
