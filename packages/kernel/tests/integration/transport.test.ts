import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM, type MockLLMScriptStep } from "@clarvis/loop/testing";
import { createAgentToolsCapability } from "@clarvis/loop/capabilities/tools";
import { createAskUserCapability, type ExecuteRunDeps } from "@clarvis/loop";
import {
  createFilePlanRepository,
  createPlanStore,
  type PlanFactory,
  type PlanStore,
} from "@clarvis/plan";
import type { RunEvent, RunHandle } from "@clarvis/protocol";
import {
  createInProcessKernel,
  createKernelServer,
  createLoopbackTransport,
  connectKernelClient,
  WIRE_METHODS,
} from "../../src/index.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

const PROVIDERS = [
  { name: "anthropic", kind: "anthropic" },
  { name: "openai", kind: "openai" },
  { name: "google", kind: "google" },
];

function deferredVoid(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function buildDeps(workspaceRoot: string, script?: MockLLMScriptStep[]): ExecuteRunDeps {
  const env = loadEnv({
    CLARVIS_LOG_LEVEL: "silent",
    CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000",
    CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
  });
  return {
    env,
    llm: new MockLLM({ script: script ?? [{ text: "Done." }] }),
    connections: createConnectionManager({
      workspace: workspaceRoot,
      factory: defaultMCPClientFactory,
      connectTimeoutMs: env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
      callTimeoutMs: env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
    }),
    traceStore: createMemoryTraceStore(),
    workspaceRoot,
    capabilities: [createAgentToolsCapability(), createAskUserCapability()],
  };
}

function makeRemote(
  opts: {
    script?: MockLLMScriptStep[];
    extraAgents?: Array<{ name: string; grants?: string[] }>;
  } = {},
) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-kernel-transport-"));
  const kernel = createInProcessKernel({
    deps: buildDeps(workspaceRoot, opts.script),
    workspaceRoot,
    ...kernelIdentity(workspaceRoot),
    configStore: createMemoryConfigStore({
      settings: { workspace: { providers: PROVIDERS, default_model: "anthropic/x" } },
      agents: [
        {
          name: "solo",
          scope: "workspace",
          frontmatter: { model: "anthropic/x", tools: [] },
          body: "You are solo.",
          model: "anthropic/x",
        },
        ...(opts.extraAgents ?? []).map((agent) => ({
          name: agent.name,
          scope: "workspace" as const,
          frontmatter: {
            model: "anthropic/x",
            tools: [],
            ...(agent.grants !== undefined ? { grants: agent.grants } : {}),
          },
          body: `You are ${agent.name}.`,
          model: "anthropic/x",
        })),
      ],
    }),
  });
  const transport = createLoopbackTransport(
    createKernelServer(kernel, { capabilities: { agent_tools: true } }),
  );
  return { kernel, transport };
}

function planFactory(): PlanFactory {
  const root = mkdtempSync(join(tmpdir(), "clarvis-kernel-transport-plans-"));
  const store: PlanStore = createPlanStore({
    repository: createFilePlanRepository({
      workspaceRoot: root,
      root: join(root, ".clarvis", "plans"),
    }),
  });
  return {
    async storeFor() {
      return { key: "markdown", providerKind: "markdown", store };
    },
  };
}

describe("kernel loopback transport", () => {
  it("handshakes, dispatches one ordinary service call, and streams one run end-to-end", async () => {
    const { kernel, transport } = makeRemote();
    const client = await connectKernelClient(transport, { clientInfo: { name: "test" } });

    expect(client.capabilities.agent_tools).toBe(true);
    expect(client.workspace.path).toBeTruthy();
    expect((await client.config.listAgents()).map((agent) => agent.name)).toContain("solo");

    const handle = await client.runs.start({
      messages: [{ role: "user", content: "Do it" }],
      agent: "solo",
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    const result = await handle.done;

    expect(result.status).toBe("completed");
    expect(events.some((event) => event.type === "run_started")).toBe(true);
    expect(events.some((event) => event.type === "run_ended")).toBe(true);
    expect((await client.runs.get(result.execution_id)).status).toBe("completed");

    await client.close();
    await kernel.close();
  });

  it("routes settled compaction through the owner-bound run service", async () => {
    const { kernel, transport } = makeRemote();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({
      messages: [{ role: "user", content: "Preserve this context." }],
      agent: "solo",
    });

    const result = await handle.done;
    await handle.closed;
    const compacted = await client.runs.compact(result.execution_id, undefined, {
      mechanical_target_tokens: 1,
    });

    expect(compacted.execution_id).toBe(result.execution_id);
    expect(["compacted", "skipped"]).toContain(compacted.status);

    await client.close();
    await kernel.close();
  });

  it("keeps subscription authentication explicitly unavailable on a remote connection", async () => {
    const { kernel, transport } = makeRemote();
    const client = await connectKernelClient(transport);

    const statuses = await client.providerAuth.list();
    expect(statuses).toEqual([
      {
        scheme: "openai-codex",
        state: "unavailable",
        authorization_available: false,
        diagnostic: "not_authorized",
      },
      {
        scheme: "xai-grok",
        state: "unavailable",
        authorization_available: false,
        diagnostic: "not_authorized",
      },
    ]);
    expect(JSON.stringify(statuses)).not.toMatch(
      /access_token|refresh_token|device_code|account_id/,
    );
    await expect(client.providerAuth.startDevice("openai-codex")).rejects.toThrow(
      "not available in this Clarvis host",
    );

    await client.close();
    await kernel.close();
  });

  it("forwards config notifications only while the remote subscription is active", async () => {
    const { kernel, transport } = makeRemote();
    const client = await connectKernelClient(transport);
    const changes: string[] = [];
    const unsubscribe = client.config.subscribe(["agents"], (change) => changes.push(change.kind));

    await client.config.writeAgent("workspace", "first", {
      frontmatter: { model: "anthropic/x" },
      body: "First.",
    });
    unsubscribe();
    await client.config.writeAgent("workspace", "second", {
      frontmatter: { model: "anthropic/x" },
      body: "Second.",
    });

    expect(changes).toEqual(["agents"]);
    await client.close();
    await kernel.close();
  });

  it("rejects duplicate subscription ids without leaking the first listener", async () => {
    const { kernel, transport } = makeRemote();
    const client = await connectKernelClient(transport);
    const id = "shared-subscription-id";

    await transport.request(WIRE_METHODS.configSubscribe, {
      kinds: ["agents"],
      subscription_id: id,
    });
    await expect(
      transport.request(WIRE_METHODS.configSubscribe, {
        kinds: ["settings"],
        subscription_id: id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await transport.request(WIRE_METHODS.configUnsubscribe, { subscription_id: id });

    await client.close();
    await kernel.close();
  });

  it("sequences immediate unsubscription after delayed subscription authorization", async () => {
    const { kernel } = makeRemote();
    const configGate = deferredVoid();
    let configSubscribed = 0;
    let configReleased = 0;
    const server = createKernelServer(kernel, {
      authorize: async ({ method }) => {
        if (method === WIRE_METHODS.configSubscribe) await configGate.promise;
        return true;
      },
      resolveConnection: () => ({
        project: kernel.project,
        workspace: kernel.workspace,
        services: {
          ...kernel.operatorServices,
          ...kernel.defaultOwnerServices,
          config: {
            ...kernel.config,
            subscribe() {
              configSubscribed += 1;
              return () => {
                configReleased += 1;
              };
            },
          },
        },
      }),
    });
    const client = await connectKernelClient(createLoopbackTransport(server));

    const offConfig = client.config.subscribe(["agents"], () => {});
    offConfig();
    configGate.resolve();
    for (let turn = 0; turn < 10 && configReleased < 1; turn += 1) {
      await Bun.sleep(0);
    }

    expect({ configSubscribed, configReleased }).toEqual({
      configSubscribed: 1,
      configReleased: 1,
    });
    await client.close();
    await kernel.close();
  });

  it("does not install a subscription whose authorization finishes after close", async () => {
    for (const method of [WIRE_METHODS.configSubscribe] as const) {
      const { kernel } = makeRemote();
      const gate = deferredVoid();
      let subscriptions = 0;
      const server = createKernelServer(kernel, {
        authorize: async ({ method: candidate }) => {
          if (candidate === method) await gate.promise;
          return true;
        },
        resolveConnection: () => ({
          project: kernel.project,
          workspace: kernel.workspace,
          services: {
            ...kernel.operatorServices,
            ...kernel.defaultOwnerServices,
            config: {
              ...kernel.config,
              subscribe() {
                subscriptions += 1;
                return () => {};
              },
            },
          },
        }),
      });
      const transport = createLoopbackTransport(server);
      await connectKernelClient(transport);
      const pending = transport.request(method, { kinds: ["agents"], subscription_id: "late" });

      await transport.close();
      gate.resolve();
      await expect(pending).rejects.toMatchObject({ code: "unavailable" });
      expect(subscriptions).toBe(0);
      await kernel.close();
    }
  });

  it("binds owner services only from the host-resolved hello context", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-kernel-owner-wire-"));
    const kernel = createInProcessKernel({
      deps: buildDeps(workspaceRoot),
      workspaceRoot,
      ...kernelIdentity(workspaceRoot, "host-workspace"),
      configStore: createMemoryConfigStore(),
      planFactory: planFactory(),
      ownershipMode: "multi",
    });
    const server = createKernelServer(kernel, {
      resolveConnection: (hello) => {
        expect(hello.auth).toBe("trusted-token");
        return {
          principal: { id: "authenticated-owner" },
          project: kernel.project,
          workspace: kernel.workspace,
          services: {
            ...kernel.operatorServices,
            ...kernel.forOwner("authenticated-owner"),
          },
        };
      },
    });
    const client = await connectKernelClient(createLoopbackTransport(server), {
      auth: "trusted-token",
      workspace: "caller-requested-workspace",
    });
    await client.sessions.save({
      id: "bound-session",
      title: "Bound session",
      project_id: kernel.project.id,
      workspace: "host-workspace",
      created_at: 1,
      updated_at: 1,
      turns: [],
      totals: { input: 0, output: 0, cached: 0 },
    });

    expect(client.principal?.id).toBe("authenticated-owner");
    expect(client.workspace.id).toBe("host-workspace");
    expect(
      await kernel.forOwner("authenticated-owner").sessions.get("bound-session"),
    ).not.toBeNull();
    expect(
      await kernel.forOwner("caller-requested-workspace").sessions.get("bound-session"),
    ).toBeNull();

    await client.close();
    await kernel.close();
  });

  it("rejects a second hello without rebinding the connection", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-kernel-one-shot-hello-"));
    const kernel = createInProcessKernel({
      deps: buildDeps(workspaceRoot),
      workspaceRoot,
      ...kernelIdentity(workspaceRoot),
      configStore: createMemoryConfigStore(),
    });
    let resolutions = 0;
    const transport = createLoopbackTransport(
      createKernelServer(kernel, {
        resolveConnection: () => {
          resolutions += 1;
          return {
            principal: { id: `principal-${resolutions}` },
            project: kernel.project,
            workspace: kernel.workspace,
            services: { ...kernel.operatorServices, ...kernel.defaultOwnerServices },
          };
        },
      }),
    );
    const client = await connectKernelClient(transport);

    await expect(transport.request(WIRE_METHODS.hello, {})).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(resolutions).toBe(1);
    expect(client.principal?.id).toBe("principal-1");

    await client.close();
    await kernel.close();
  });

  it("rejects every ordinary operation until the clean-break hello completes", async () => {
    const { kernel } = makeRemote();
    const transport = createLoopbackTransport(createKernelServer(kernel));

    await expect(transport.request(WIRE_METHODS.listAgents, {})).rejects.toMatchObject({
      code: "unauthorized",
    });

    const client = await connectKernelClient(transport);
    expect((await client.config.listAgents()).map(({ name }) => name)).toContain("solo");
    await client.close();
    await kernel.close();
  });

  it("rejects a missing or mismatched clean-break wire version", async () => {
    for (const params of [{}, { wire_version: 1 }]) {
      const { kernel } = makeRemote();
      const transport = createLoopbackTransport(createKernelServer(kernel));
      await expect(transport.request(WIRE_METHODS.hello, params)).rejects.toMatchObject({
        code: "unsupported",
      });
      await transport.close();
      await kernel.close();
    }
  });

  it("rejects malformed ordinary and special envelopes", async () => {
    const { kernel } = makeRemote();
    const transport = createLoopbackTransport(createKernelServer(kernel));
    const client = await connectKernelClient(transport);

    await expect(
      transport.request(WIRE_METHODS.listAgents, { unexpected: true }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(transport.request(WIRE_METHODS.runsCancel, "not-an-object")).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    await expect(
      transport.request(WIRE_METHODS.runsCancel, { execution_id: "missing", unexpected: true }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    await client.close();
    await kernel.close();
  });

  it("rejects malformed hello identity fields before resolving a connection", async () => {
    for (const identity of [{ auth: 42 }, { clientInfo: { name: "client", version: 42 } }]) {
      const { kernel } = makeRemote();
      const transport = createLoopbackTransport(createKernelServer(kernel));
      await expect(
        transport.request(WIRE_METHODS.hello, { wire_version: 4, ...identity }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await transport.close();
      await kernel.close();
    }
  });

  it("applies operation metadata to authorization and rejects unknown methods", async () => {
    const { kernel } = makeRemote();
    const server = createKernelServer(kernel, {
      authorize: ({ metadata }) => metadata.sensitivity !== "secrets",
    });
    const transport = createLoopbackTransport(server);
    const client = await connectKernelClient(transport);

    await expect(client.secrets.listNames()).rejects.toMatchObject({ code: "unauthorized" });
    expect(await client.config.listAgents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "solo" })]),
    );
    await expect(transport.request("not.a.real.method", {})).rejects.toMatchObject({
      code: "invalid_request",
    });

    await client.close();
    await kernel.close();
  });

  it("rejects control requests for an execution not live on that connection", async () => {
    const { kernel, transport } = makeRemote();
    const client = await connectKernelClient(transport);

    await expect(
      transport.request(WIRE_METHODS.runsSteer, { execution_id: "missing", message: "hi" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      transport.request(WIRE_METHODS.runsCancel, { execution_id: "missing" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      transport.request(WIRE_METHODS.runsRespond, {
        execution_id: "missing",
        response: { id: "question", action: "accept" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await client.close();
    await kernel.close();
  });

  it("carries a live elicitation and its response through server notifications", async () => {
    const { kernel, transport } = makeRemote({
      script: [
        { toolCalls: [{ name: "ask_user", arguments: { question: "proceed?" } }] },
        { text: "Done." },
      ],
      extraAgents: [{ name: "asker", grants: ["ask_user"] }],
    });
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({
      messages: [{ role: "user", content: "ask away" }],
      agent: "asker",
    });
    let prompt = "";
    handle.onElicit((request) => {
      prompt = request.prompt;
      void handle.respond({ id: request.id, action: "accept", content: { response: "yes" } });
    });

    for await (const _event of handle.events) void _event;
    expect((await handle.done).status).toBe("completed");
    expect(prompt).toBe("proceed?");

    await client.close();
    await kernel.close();
  });

  it("closes the connection when the notification sender rejects or stalls", async () => {
    for (const senderFailure of ["reject", "stall"] as const) {
      const { kernel, transport } = makeRemote();
      await transport.close();
      const stalled = deferredVoid();
      const disconnected = deferredVoid();
      let started: RunHandle | undefined;
      let sendCalls = 0;
      let disconnectCalls = 0;
      let contextCloseCalls = 0;
      const server = createKernelServer(kernel, {
        notificationTimeoutMs: 10,
        resolveConnection: () => ({
          project: kernel.project,
          workspace: kernel.workspace,
          services: {
            ...kernel.operatorServices,
            ...kernel.defaultOwnerServices,
            runs: {
              ...kernel.runs,
              async start(params) {
                const handle = await kernel.runs.start(params);
                started = handle;
                return started;
              },
            },
          },
          close() {
            contextCloseCalls += 1;
          },
        }),
      });
      const connection = server.connect(
        () => {
          sendCalls += 1;
          return senderFailure === "reject"
            ? Promise.reject(new Error("notification sink rejected"))
            : stalled.promise;
        },
        () => {
          disconnectCalls += 1;
          disconnected.resolve();
        },
      );

      await connection.handle(WIRE_METHODS.hello, { wire_version: 4 });
      await connection.handle(WIRE_METHODS.runsStart, {
        params: { messages: [{ role: "user", content: "finish" }], agent: "solo" },
      });
      if (started === undefined) throw new Error("the test run was not started");
      await disconnected.promise;

      await expect(
        connection.handle(WIRE_METHODS.runsSteer, {
          execution_id: started.execution_id,
          message: "too late",
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
      connection.close();
      expect(disconnectCalls).toBe(1);
      expect(contextCloseCalls).toBe(1);
      expect(sendCalls).toBe(1);
      await kernel.close();
    }
  });

  it("settles remote run handles when notification delivery fails", async () => {
    const { kernel, transport: initial } = makeRemote();
    await initial.close();
    const transport = createLoopbackTransport(createKernelServer(kernel));
    const client = await connectKernelClient(transport);
    transport.onNotification("run.event", () => {
      throw new Error("notification consumer failed");
    });

    const handle = await client.runs.start({
      messages: [{ role: "user", content: "finish" }],
      agent: "solo",
    });

    await expect(handle.done).resolves.toMatchObject({
      status: "failed",
      error: { code: "unavailable" },
    });
    await expect(handle.closed).resolves.toBeUndefined();
    await client.close();
    await kernel.close();
  });

  it("closes without waiting for an infinite notification send", async () => {
    const { kernel, transport } = makeRemote();
    await transport.close();
    const sendStarted = deferredVoid();
    const stalled = deferredVoid();
    const streamReleased = deferredVoid();
    let cancelCalls = 0;
    let sendCalls = 0;
    const handle: RunHandle = {
      execution_id: "stalled-notification-run",
      events: {
        async *[Symbol.asyncIterator]() {
          try {
            yield { type: "run_started", at: 1 } as const;
          } finally {
            streamReleased.resolve();
          }
        },
      },
      done: Promise.resolve({
        execution_id: "stalled-notification-run",
        status: "completed",
      }),
      closed: streamReleased.promise,
      steer: async () => {},
      compact: async () => {},
      cancel: async () => {
        cancelCalls += 1;
      },
      respond: async () => {},
      onElicit: () => {},
    };
    const server = createKernelServer(kernel, {
      resolveConnection: () => ({
        project: kernel.project,
        workspace: kernel.workspace,
        services: {
          ...kernel.operatorServices,
          ...kernel.defaultOwnerServices,
          runs: { ...kernel.runs, start: async () => handle },
        },
      }),
    });
    const connection = server.connect(
      () => {
        sendCalls += 1;
        sendStarted.resolve();
        return stalled.promise;
      },
      () => {},
    );
    await connection.handle(WIRE_METHODS.hello, { wire_version: 4 });
    await connection.handle(WIRE_METHODS.runsStart, { params: { messages: [] } });
    await sendStarted.promise;

    connection.close();

    expect(
      await Promise.race([
        streamReleased.promise.then(() => true),
        Bun.sleep(250).then(() => false),
      ]),
    ).toBe(true);
    expect(cancelCalls).toBe(1);
    expect(sendCalls).toBe(1);
    await kernel.close();
  });

  it("validates notification timeout configuration before accepting connections", () => {
    const { kernel } = makeRemote();
    expect(() => createKernelServer(kernel, { notificationTimeoutMs: 0 })).toThrow(
      "notificationTimeoutMs must be a positive finite number",
    );
    void kernel.close();
  });

  it("releases a context resolved after its connection has already closed", async () => {
    const { kernel } = makeRemote();
    let contextCloseCalls = 0;
    const context = {
      project: kernel.project,
      workspace: kernel.workspace,
      services: { ...kernel.operatorServices, ...kernel.defaultOwnerServices },
      close() {
        contextCloseCalls += 1;
      },
    };
    let resolveContext!: (value: typeof context) => void;
    const contextPromise = new Promise<typeof context>((resolve) => {
      resolveContext = resolve;
    });
    const connection = createKernelServer(kernel, {
      resolveConnection: () => contextPromise,
    }).connect(
      async () => {},
      () => {},
    );

    const hello = connection.handle(WIRE_METHODS.hello, { wire_version: 4 });
    await Promise.resolve();
    connection.close();
    resolveContext(context);

    await expect(hello).rejects.toMatchObject({ code: "unavailable" });
    expect(contextCloseCalls).toBe(1);
    await kernel.close();
  });

  it("maps a rejected run result and dispatches compact through the live handle", async () => {
    const { kernel } = makeRemote();
    let rejectDone!: (reason: unknown) => void;
    const done = new Promise<never>((_resolve, reject) => {
      rejectDone = reject;
    });
    const runClosed = deferredVoid();
    let compactRequest: string | undefined;
    const handle: RunHandle = {
      execution_id: "rejected-run",
      events: {
        async *[Symbol.asyncIterator]() {},
      },
      done,
      closed: runClosed.promise,
      steer: async () => {},
      compact: async (request) => {
        compactRequest = request;
      },
      cancel: async () => {},
      respond: async () => {},
      onElicit: () => {},
    };
    const notifications: Array<{ method: string; params: unknown }> = [];
    const connection = createKernelServer(kernel, {
      resolveConnection: () => ({
        project: kernel.project,
        workspace: kernel.workspace,
        services: {
          ...kernel.operatorServices,
          ...kernel.defaultOwnerServices,
          runs: { ...kernel.runs, start: async () => handle },
        },
      }),
    }).connect(
      async (method, params) => {
        notifications.push({ method, params });
      },
      () => {},
    );

    await connection.handle(WIRE_METHODS.hello, { wire_version: 4 });
    await connection.handle(WIRE_METHODS.runsStart, { params: { messages: [] } });
    await connection.handle(WIRE_METHODS.runsCompact, {
      execution_id: handle.execution_id,
      request: "keep decisions",
    });
    rejectDone(new Error("provider token leaked: sk-secret"));
    await Bun.sleep(0);

    expect(compactRequest).toBe("keep decisions");
    expect(notifications).toContainEqual({
      method: "run.result",
      params: {
        execution_id: handle.execution_id,
        result: expect.objectContaining({ execution_id: handle.execution_id, status: "failed" }),
      },
    });
    runClosed.resolve();
    connection.close();
    await kernel.close();
  });

  it("disconnects when a run contributes a non-serializable notification", async () => {
    const { kernel } = makeRemote();
    const disconnected = deferredVoid();
    const cyclic: Record<string, unknown> = { type: "plugin.event", at: 1 };
    cyclic.self = cyclic;
    const never = new Promise<never>(() => {});
    const handle: RunHandle = {
      execution_id: "cyclic-notification",
      events: {
        async *[Symbol.asyncIterator]() {
          yield cyclic as unknown as RunEvent;
        },
      },
      done: never,
      closed: never,
      steer: async () => {},
      compact: async () => {},
      cancel: async () => {},
      respond: async () => {},
      onElicit: () => {},
    };
    const connection = createKernelServer(kernel, {
      resolveConnection: () => ({
        project: kernel.project,
        workspace: kernel.workspace,
        services: {
          ...kernel.operatorServices,
          ...kernel.defaultOwnerServices,
          runs: { ...kernel.runs, start: async () => handle },
        },
      }),
    }).connect(
      async () => {},
      () => disconnected.resolve(),
    );

    await connection.handle(WIRE_METHODS.hello, { wire_version: 4 });
    await connection.handle(WIRE_METHODS.runsStart, { params: { messages: [] } });
    await disconnected.promise;
    await expect(connection.handle(WIRE_METHODS.listAgents, {})).rejects.toMatchObject({
      code: "unavailable",
    });
    await kernel.close();
  });
});
