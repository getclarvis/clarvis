import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  loadEnv,
  MCP_HOOK_TOOL_PORT,
  NOOP_LOGGER,
  type Capability,
  type HookConfig,
  type LLMProvider,
  type RunRequest,
} from "@clarvis/capability";
import { buildExecuteRunDeps } from "@clarvis/loop/host";
import { executeRun } from "@clarvis/loop";
import { HOME_ENV } from "@clarvis/paths";
import { createTasksCapability } from "@clarvis/tasks/capability";
import type { TaskDocument, TaskProviderResolver } from "@clarvis/tasks";
import {
  createWorkflowsCapability,
  createWorkflowLedger,
  createWorkflowLeaderCount,
  createWorkflowSemaphore,
  type WorkflowCtx,
} from "@clarvis/workflows";
import { createLocalContainerRuntime } from "../../src/runtime/local-podman-runtime.ts";
import { createRuntimeAuthorityRouter } from "../../src/runtime/isolated-run-executor.ts";
import { createExecutionPeer } from "../../src/runtime/execution-rpc.ts";
import { serveExecutionWorker } from "../../src/runtime/execution-worker.ts";
import { createGuestLoopExecutor } from "../../src/runtime/guest-loop-executor.ts";
import { RUNTIME_PROTOCOL_REVISION } from "../../src/runtime/protocol-revision.ts";
import type { RuntimeBackend, RuntimeInfo } from "../../src/runtime/types.ts";
import { createHostHooksBridge } from "../../src/runtime/hooks-bridge.ts";
import {
  consumeGuestWorkflowEvent,
  createHostWorkflowBridge,
} from "../../src/runtime/workflows-bridge.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const usage = { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 };
const body = (execution_id: string, grants: string[] = []): RunRequest =>
  ({
    execution_id,
    messages: [{ role: "user", content: "exercise the runtime" }],
    servers: [],
    providers: [{ name: "test", kind: "anthropic" }],
    profiles: [{ name: "solo", model: "test/model", tools: [], grants, iteration_limit: 8 }],
    entry: "solo",
    budget: { on_exceed: "stop", total_token_limit: 10_000 },
  }) as RunRequest;

async function fixture(
  llm: LLMProvider,
  options: { hooks?: readonly HookConfig[]; tasks?: TaskProviderResolver } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-composition-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const built = await buildExecuteRunDeps({
    workspaceRoot,
    traceDir: join(root, "traces"),
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
    logger: NOOP_LOGGER,
    environment: { PATH: process.env.PATH },
    builtins: { tools: true, skills: false, hooks: options.hooks !== undefined },
    ...(options.hooks === undefined ? {} : { resolveHooks: () => options.hooks }),
    capabilities:
      options.tasks === undefined ? [] : [createTasksCapability({ resolver: options.tasks })],
  });
  cleanup.push(() => built.dispose());
  built.deps.llm = llm;
  const generation = "composition";
  const router = createRuntimeAuthorityRouter(generation);
  const backend: RuntimeBackend = {
    inspect: async () => ({ available: true, engineVersion: "test", rootless: true }),
    async start(spec) {
      const toHost = new PassThrough();
      const toGuest = new PassThrough();
      const guest = serveExecutionWorker({
        generation,
        imageDigest: spec.imageDigest,
        input: toGuest,
        output: toHost,
        executor: createGuestLoopExecutor({ workspaceRoot, scratchRoot: join(root, "guest") }),
      });
      const host = createExecutionPeer({
        role: "host",
        generation,
        input: toHost,
        output: toGuest,
        handlers: router.handlers,
      });
      await host.request(
        "runtime.bootstrap",
        { generation },
        {
          generation,
          imageDigest: spec.imageDigest,
          runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
        },
      );
      const info: RuntimeInfo = {
        kind: "container",
        generation,
        engine: "docker",
        engineVersion: "test",
        hostPlatform: process.platform,
        guestPlatform: "linux",
        imageDigest: spec.imageDigest,
        runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
        network: spec.network,
        limits: spec.limits,
        lifecycle: "ready",
      };
      return {
        info,
        get closed() {
          return host.closed;
        },
        startRun: (runId, payload, signal) =>
          host.request("runtime.start", { generation, runId }, payload, { signal }),
        callHookMcp: (runId, payload, signal) =>
          host.request("runtime.hook_mcp", { generation, runId }, payload, { signal }),
        steer: async (runId, payload, signal) => {
          await host.request("runtime.steer", { generation, runId }, payload, { signal });
        },
        cancel: async (runId) => {
          await host.request("runtime.cancel", { generation, runId });
        },
        exposePort: async () => {
          throw new Error("no port fixture");
        },
        stop: async () => {
          host.close();
          guest.close();
        },
      };
    },
  };
  const runtime = await createLocalContainerRuntime(
    {
      generation,
      ownerId: "owner",
      project: { id: "project" },
      workspace: { id: "workspace", projectId: "project", label: "main", kind: "primary" },
      workspaceRoot,
      configurationRevision: "config",
      extensionRevision: "extensions",
      deps: built.deps,
      ...(options.tasks === undefined ? {} : { taskResolver: options.tasks }),
      settings: {
        backend: "docker",
        image_digest: `sha256:${"d".repeat(64)}`,
        network: "none",
        executable: "docker",
        connection: "test",
        fallback: "fail",
        limits: {
          cpu_count: 2,
          memory_bytes: 64 * 1024 * 1024,
          process_count: 64,
          output_bytes: 1024 * 1024,
          storage_bytes: 128 * 1024 * 1024,
        },
      },
    },
    backend,
    router,
    { roots: { env: { [HOME_ENV]: join(root, "home") } } },
  );
  cleanup.push(() => runtime.close());
  return { root, workspaceRoot, deps: built.deps, runtime };
}

describe("runtime capability composition", () => {
  it("routes stdio hooks only to the guest and never falls back to a host connection", async () => {
    const f = await fixture({
      call: async () => {
        throw new Error("unexpected model request");
      },
    });
    const request = body("stdio-hooks");
    request.servers = [{ name: "review", transport: "stdio", command: "guest-only-command" }];
    const signal = new AbortController().signal;
    let hostAcquisitions = 0;
    let guestCalls = 0;
    let fail = false;
    const hook: Capability = {
      name: "hooks",
      forRun(context) {
        return {
          name: "hooks",
          forAgent: () => null,
          lifecycle: [
            {
              async onRunStart() {
                await context.services
                  .get(MCP_HOOK_TOOL_PORT)!
                  .call("review", "inspect", { mode: "solo" }, signal);
              },
            },
          ],
        };
      },
    };
    const deps = {
      ...f.deps,
      capabilities: [hook],
      connections: {
        closeAll: async () => undefined,
        async acquire(): Promise<never> {
          hostAcquisitions++;
          throw new Error("stdio hook must not acquire a host connection");
        },
      },
    };
    const bridge = await createHostHooksBridge(
      { rawBody: request, owner: "owner", deps },
      "stdio-hooks",
      async (call, callSignal) => {
        guestCalls++;
        expect(call).toEqual({ server: "review", tool: "inspect", input: { mode: "solo" } });
        expect(callSignal).toBe(signal);
        if (fail) throw new Error("guest hook unavailable");
        return { accepted: true };
      },
    );
    const invocation = {
      operation: "invoke",
      index: 0,
      method: "onRunStart",
      context: { mode: "solo", entry: "solo" },
    };
    await bridge!.grant.invoke(invocation, signal);
    fail = true;
    await expect(bridge!.grant.invoke(invocation, signal)).rejects.toThrow(
      "guest hook unavailable",
    );
    request.servers[0]!.enabled = false;
    await expect(bridge!.grant.invoke(invocation, signal)).rejects.toThrow(
      "hook MCP server is not active",
    );
    expect(guestCalls).toBe(2);
    expect(hostAcquisitions).toBe(0);
  });

  it.each(["http", "sse"] as const)(
    "keeps %s MCP hooks owner-scoped on the host and releases their lease",
    async (transport) => {
      const f = await fixture({
        call: async () => {
          throw new Error("unexpected model request");
        },
      });
      const signal = new AbortController().signal;
      const request = body("mcp-hooks");
      const server = {
        name: "review",
        transport,
        url: "https://hooks.invalid/mcp",
      };
      request.servers = [server];
      let acquisitions = 0;
      let releases = 0;
      let fail = false;
      const hook: Capability = {
        name: "hooks",
        forRun(context) {
          const port = context.services.get(MCP_HOOK_TOOL_PORT)!;
          return {
            name: "hooks",
            forAgent: () => null,
            lifecycle: [
              {
                async onRunStart(input) {
                  await port.call("review", "inspect", { mode: input.mode }, signal);
                },
              },
            ],
          };
        },
      };
      const deps = {
        ...f.deps,
        capabilities: [hook],
        connections: {
          closeAll: async () => undefined,
          async acquire(options: Parameters<typeof f.deps.connections.acquire>[0]) {
            acquisitions++;
            expect(options).toEqual({ server, owner: "owner", poolSharing: "owner", signal });
            return {
              tools: [],
              conn: {
                name: "review",
                status: "connected" as const,
                transport,
                close: async () => undefined,
                async callTool(tool: string, input: unknown, callSignal?: AbortSignal) {
                  expect([tool, input, callSignal]).toEqual(["inspect", { mode: "solo" }, signal]);
                  if (fail) throw new Error("hook provider failed");
                  return { ok: true, data: { accepted: true } };
                },
              },
              release: async () => {
                releases++;
              },
            };
          },
        },
      };
      const bridge = await createHostHooksBridge(
        { rawBody: request, owner: "owner", deps },
        "mcp-hooks",
        async () => {
          throw new Error("remote hooks must stay on the host");
        },
      );
      const invocation = {
        operation: "invoke",
        index: 0,
        method: "onRunStart",
        context: { mode: "solo", entry: "solo" },
      };
      expect(bridge!.grant.validateArguments(invocation)).toBe(true);
      await bridge!.grant.invoke(invocation, signal);
      expect(releases).toBe(1);
      fail = true;
      await expect(bridge!.grant.invoke(invocation, signal)).rejects.toThrow(
        "hook provider failed",
      );
      expect(releases).toBe(2);
      const inactive = await createHostHooksBridge(
        { rawBody: { ...request, servers: [] }, owner: "owner", deps },
        "inactive-hooks",
        async () => {
          throw new Error("inactive hook must not reach guest");
        },
      );
      await expect(inactive!.grant.invoke(invocation, signal)).rejects.toThrow(
        "hook MCP server is not active",
      );
      expect(acquisitions).toBe(2);
      expect(releases).toBe(2);
    },
  );

  it("refuses duplicate, unprepared and over-authorized leaders and validates guest workflow progress", async () => {
    const f = await fixture({
      call: async () => {
        throw new Error("unexpected model request");
      },
    });
    const assembly = Promise.withResolvers<RunRequest>();
    const signal = new AbortController().signal;
    const states: unknown[] = [];
    let exhausted = 0;
    const ctx: WorkflowCtx = {
      deps: f.deps,
      runDeps: { generateExecutionId: () => "unused", executeRun: f.runtime.executeRun },
      owner: "owner",
      managerRunId: "manager",
      signal,
      ledger: createWorkflowLedger(100),
      leaderCount: createWorkflowLeaderCount(2),
      semaphore: createWorkflowSemaphore(1),
      maxConcurrency: 1,
      maxParallelSubagents: 1,
      elicitWaitMs: 1000,
      leaderProfiles: [{ name: "leader", description: "Leader" }],
      assemble: () => assembly.promise,
      onSequenceState: (state) => {
        states.push(state);
      },
      onBudgetExhausted: () => {
        exhausted++;
      },
    };
    const { grant } = createHostWorkflowBridge(ctx, async () => {
      throw new Error("must not execute");
    });
    const prepare = {
      operation: "prepare",
      runId: "leader-1",
      spec: { title: "Check", prompt: "Inspect", profile: "leader" },
    };
    expect(grant.validateArguments({ ...prepare, unexpected: true })).toBe(false);
    await expect(
      grant.invoke({ operation: "execute", runId: "missing" }, signal),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(grant.invoke({ ...prepare, runId: "manager" }, signal)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      grant.invoke({ ...prepare, spec: { ...prepare.spec, profile: "unlisted" } }, signal),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const pending = grant.invoke(prepare, signal);
    await expect(grant.invoke(prepare, signal)).rejects.toMatchObject({ code: "unauthorized" });
    assembly.resolve(body("leader-1", ["workflow"]));
    await expect(pending).rejects.toThrow("assembler retained a manager grant");
    await expect(grant.invoke(prepare, signal)).rejects.toMatchObject({ code: "unauthorized" });

    expect(consumeGuestWorkflowEvent(ctx, { channel: "workflow_budget", spent: 40 })).toBe(true);
    expect(consumeGuestWorkflowEvent(ctx, { channel: "workflow_budget", spent: 20 })).toBe(true);
    expect(ctx.ledger.spent()).toBe(40);
    expect(() =>
      consumeGuestWorkflowEvent(ctx, { channel: "workflow_budget", spent: 101 }),
    ).toThrow("exceeds its admitted budget");
    const state = {
      sessionId: "sequence",
      status: "awaiting_manager",
      revision: 1,
      leadersStarted: 1,
      maxTotalLeaders: 2,
    };
    expect(consumeGuestWorkflowEvent(ctx, { channel: "workflow_state", state })).toBe(true);
    expect(states).toEqual([state]);
    expect(() =>
      consumeGuestWorkflowEvent(ctx, {
        channel: "workflow_state",
        state: { ...state, revision: -1 },
      }),
    ).toThrow();
    expect(consumeGuestWorkflowEvent(ctx, { channel: "workflow_budget_exhausted" })).toBe(true);
    expect(exhausted).toBe(1);
    expect(consumeGuestWorkflowEvent(ctx, { channel: "unknown" })).toBe(false);
  });

  it("enforces the same configured blocking hook natively and through guest dispatch", async () => {
    let call = 0;
    const prompts: string[] = [];
    const f = await fixture(
      {
        async call(params) {
          prompts.push(JSON.stringify(params.messages));
          return ++call % 2 === 1
            ? {
                toolCalls: [
                  {
                    id: `write-${call}`,
                    name: "write_file",
                    arguments: { path: "blocked.txt", content: "denied" },
                  },
                ],
                usage,
              }
            : { text: "done", usage };
        },
      },
      {
        hooks: [
          {
            event: "pre_tool_use",
            command: `printf '%s' '{"kind":"deny","message":"HOST_BLOCKING_HOOK"}'`,
          },
        ],
      },
    );
    const native = await executeRun({
      rawBody: body("native-hooks", ["edit_workspace"]),
      owner: "owner",
      deps: f.deps,
    });
    const guest = await f.runtime.executeRun({
      rawBody: body("guest-hooks", ["edit_workspace"]),
      owner: "owner",
      deps: f.deps,
    });
    expect(native.response.status).toBe("completed");
    expect(guest.response.status).toBe("completed");
    expect(prompts[1]).toContain("HOST_BLOCKING_HOOK");
    expect(prompts[3]).toContain("HOST_BLOCKING_HOOK");
    await expect(access(join(f.workspaceRoot, "blocked.txt"))).rejects.toThrow();
  });

  it("preserves task binding, native tool schemas and host provider ownership", async () => {
    const document: TaskDocument = {
      ref: { providerKey: "fixture", id: "T-1" },
      container: { id: "project", label: "Project" },
      title: "HOST_TASK_DOCUMENT",
      stage: "ready",
      nativeState: { id: "ready", label: "Ready" },
      labels: [],
      acceptanceCriteria: [],
      availableIntents: [],
    };
    const reads: string[] = [];
    const resolver: TaskProviderResolver = {
      async resolve(owner) {
        expect(owner).toBe("owner");
        return {
          provider: {
            kind: "fixture",
            key: "fixture",
            capabilities: async () => caps,
            listContainers: async () => ({ items: [] }),
            search: async () => ({ items: [document] }),
            get: async (ref) => {
              reads.push(ref.id);
              return document;
            },
          },
          capabilities: caps,
          writes: "disabled",
          server: "host-only",
        };
      },
    };
    const caps = {
      protocolVersion: 2 as const,
      providerInstanceId: "fixture",
      providerKind: "fixture",
      read: { containers: true as const, search: true as const, get: true as const, actors: false },
      write: { create: false, assign: false, comment: false, attachArtifact: false, intents: [] },
      concurrency: "none" as const,
    };
    const prompts: string[] = [];
    let call = 0;
    const f = await fixture(
      {
        async call(params) {
          prompts.push(JSON.stringify(params));
          return ++call === 1
            ? { toolCalls: [{ id: "read", name: "read_task", arguments: { id: "T-1" } }], usage }
            : { text: "done", usage };
        },
      },
      { tasks: resolver },
    );
    const outcome = await f.runtime.executeRun({
      rawBody: { ...body("task-run", ["tasks.read"]), task: { id: "T-1", mode: "inspect" } },
      owner: "owner",
      deps: f.deps,
    });
    expect(outcome.response.status).toBe("completed");
    expect(prompts[0]).toContain("HOST_TASK_DOCUMENT");
    expect(prompts[0]).toContain('"additionalProperties":false');
    expect(reads).toEqual(["T-1", "T-1"]);
    expect(f.deps.traceStore.getById("owner", "task-run")).toMatchObject({
      capability_state: { tasks: { version: 2, taskId: "T-1", mode: "inspect" } },
    });
  });

  it("runs an Admiral and its leader through the same guest registry and subtree budget", async () => {
    let managerCalls = 0;
    let leaderCalls = 0;
    let leaderLimit: number | undefined;
    const f = await fixture({
      async call(params) {
        if (params.tools?.some((tool) => tool.wireName === "run_leader")) {
          managerCalls++;
          if (managerCalls === 1)
            return {
              toolCalls: [
                {
                  id: "spawn",
                  name: "run_leader",
                  arguments: { title: "Check", prompt: "leader work", profile: "leader" },
                },
              ],
              usage,
            };
          if (managerCalls === 2)
            return { toolCalls: [{ id: "wait", name: "await_agents", arguments: {} }], usage };
          return { text: "manager done", usage };
        }
        leaderCalls++;
        leaderLimit = params.maxOutputTokens;
        return { text: "leader done", usage };
      },
    });
    const ctx: WorkflowCtx = {
      deps: f.deps,
      runDeps: { generateExecutionId: () => "unused", executeRun: f.runtime.executeRun },
      owner: "owner",
      managerRunId: "manager-run",
      signal: new AbortController().signal,
      ledger: createWorkflowLedger(100),
      leaderCount: createWorkflowLeaderCount(4),
      semaphore: createWorkflowSemaphore(1),
      maxConcurrency: 1,
      maxParallelSubagents: 1,
      elicitWaitMs: 1000,
      leaderProfiles: [{ name: "leader", description: "Leader" }],
      assemble: () => body("host-prepared-leader"),
    };
    const outcome = await f.runtime.executeRun({
      rawBody: body("manager-run", ["workflow"]),
      owner: "owner",
      deps: f.deps,
      capabilities: [createWorkflowsCapability(ctx)],
    });
    expect(outcome.response.status).toBe("completed");
    expect(managerCalls).toBe(3);
    expect(JSON.stringify(f.deps.traceStore.getById("owner", "manager-run"))).toContain(
      "leader done",
    );
    expect(leaderCalls).toBe(1);
    expect(leaderLimit).toBeLessThanOrEqual(25);
    expect(leaderLimit).toBeGreaterThan(0);
    expect(ctx.ledger.spent()).toBe(1);
    const record = f.deps.traceStore.getById("owner", "manager-run");
    expect(JSON.stringify(record)).toContain("workflow_run_started");
    expect(JSON.stringify(record)).toContain("workflow_run_completed");
  });

  it("refuses a host capability it cannot project instead of dropping it", async () => {
    const f = await fixture({
      async call() {
        throw new Error("no model call may start");
      },
    });
    const capability: Capability = { name: "operator-policy", forRun: () => null };
    await expect(
      f.runtime.executeRun({
        rawBody: body("unprojected"),
        owner: "owner",
        deps: f.deps,
        capabilities: [capability],
      }),
    ).rejects.toMatchObject({ code: "unsupported_policy" });
  });
});
