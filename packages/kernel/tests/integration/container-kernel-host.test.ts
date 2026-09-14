import { expect, spyOn, test } from "bun:test";
import { containerNativeFixture } from "../helpers/container-native.ts";
import type { PlanDocumentDto } from "@clarvis/protocol";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { envSchema } from "@clarvis/capability";
import * as llm from "@clarvis/llm";
import * as mcp from "@clarvis/mcp-client";
import { workspacePaths } from "@clarvis/paths";
import * as secrets from "../../src/secrets/secret-store.ts";
import * as plugins from "../../src/plugins/plugin-service.ts";
import { projectContainerConfiguration } from "../../src/config/container-projection.ts";
import { createFileRunHost, type FileRunHost } from "../../src/hosting/file-host.ts";
import * as fileKernel from "../../src/file-kernel.ts";
import { createLoopbackTransport } from "../../src/transport/loopback.ts";
import { connectKernelClient } from "../../src/transport/client.ts";

test("native memory indexer uses the injected model and writable wiki tools", async () => {
  let calls = 0;
  const leaf = "fixture/indexed/MEMORY.md";
  const fixture = await containerNativeFixture({
    settings: { memory: { enabled: true, model: "logical/model", provider: { kind: "wiki" } } },
    llm: {
      call: async (params) => {
        expect(params.providerConfig).toBeUndefined();
        const step = calls++;
        const usage = {
          input_tokens: 1,
          output_tokens: 1,
          cached_tokens: 0,
          cache_write_tokens: 0,
        };
        if (step === 0) return { text: "Remember the native indexing fixture.", usage };
        if (step === 2) return { text: "Premature indexing completion.", usage };
        if (step === 3)
          expect(
            params.messages.some(
              (message) =>
                typeof message.content === "string" &&
                message.content.includes("memory pyramid is not closed"),
            ),
          ).toBe(true);
        if (step === 1 || step === 3 || step === 4) {
          const tool = params.tools.find((item) => item.toolName === "write_memory");
          if (tool === undefined)
            throw new Error("native indexer did not receive writable memory tools");
          return {
            toolCalls: [
              {
                id: "index-write",
                name: tool.wireName,
                arguments: {
                  path: step === 1 ? leaf : step === 3 ? "fixture/TOPIC.md" : "PROFILE.md",
                  content:
                    "---\ndescription: Indexed fixture\n---\nNative indexer persisted this.\n",
                },
              },
            ],
            usage,
          };
        }
        if (step === 5) return { text: "Indexing complete.", usage };
        throw new Error("index fixture script exhausted");
      },
    },
  });
  try {
    const { attachment } = await fixture.start();
    await attachment.handle.done;
    await attachment.handle.closed;
    const jobs = await fixture.connection.client.memory.jobs();
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]).toMatchObject({ state: "completed", attempts: 1 });
    expect(calls).toBe(6);
    const path = relative(
      fixture.workspaceRoot,
      join(workspacePaths(fixture.workspaceRoot).memoryRoot, leaf),
    );
    expect((await fixture.connection.client.files.readFile(path)).content).toContain(
      "Native indexer persisted this.",
    );
  } finally {
    await fixture.close();
  }
});

test("native wiki writes and reads without an indexing model and persists across recreation", async () => {
  let calls = 0;
  const leaf = "fixture/fact/MEMORY.md";
  const content = "---\ndescription: Native fixture fact\n---\nNative retained fact.\n";
  const fixture = await containerNativeFixture({
    settings: { default_model: undefined, memory: { enabled: true, provider: { kind: "wiki" } } },
    llm: {
      call: async (params) => {
        const step = calls++;
        const usage = {
          input_tokens: 1,
          output_tokens: 1,
          cached_tokens: 0,
          cache_write_tokens: 0,
        };
        if (step === 2) {
          expect(params.messages.findLast((item) => item.role === "tool")?.content).toContain(
            "Native retained fact.",
          );
          return { text: "Native memory persisted.", usage };
        }
        if (step > 2) throw new Error("unexpected indexing without a model");
        const name = step === 0 ? "write_memory" : "read_memory";
        const tool = params.tools.find((item) => item.toolName === name);
        if (tool === undefined) throw new Error(`fixture missing native tool ${name}`);
        return {
          toolCalls: [
            {
              id: `memory-${step}`,
              name: tool.wireName,
              arguments: step === 0 ? { path: leaf, content } : { paths: [leaf] },
            },
          ],
          usage,
        };
      },
    },
  });
  let next: Awaited<ReturnType<typeof fixture.connect>> | undefined;
  try {
    const { attachment, sessionId } = await fixture.start();
    await attachment.handle.done;
    await attachment.handle.closed;
    expect(calls).toBe(3);
    expect((await fixture.connection.client.sessions.get(sessionId))?.turns[0]?.status).toBe(
      "done",
    );
    const path = relative(
      fixture.workspaceRoot,
      join(workspacePaths(fixture.workspaceRoot).memoryRoot, leaf),
    );
    expect((await fixture.connection.client.files.readFile(path)).content).toContain(
      "Native retained fact.",
    );
    const jobs = await fixture.connection.client.memory.jobs();
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]).toMatchObject({
      run_id: attachment.run.execution_id,
      state: "pending",
      attempts: 0,
    });
    await fixture.connection.close();
    next = await fixture.connect();
    expect((await next.client.files.readFile(path)).content).toContain("Native retained fact.");
    expect((await next.client.memory.jobs()).jobs).toEqual(jobs.jobs);
    expect(calls).toBe(3);
  } finally {
    await next?.close();
    await fixture.close();
  }
});

test("native Plans tools complete tasks and retain the plan and session across Kernel recreation", async () => {
  let calls = 0;
  const fixture = await containerNativeFixture({
    settings: { plans: { mode: "on" } },
    llm: {
      call: async (params) => {
        const step = calls++;
        const usage = {
          input_tokens: 1,
          output_tokens: 1,
          cached_tokens: 0,
          cache_write_tokens: 0,
        };
        if (step === 6) return { text: "The native plan is complete.", usage };
        if (step > 6) throw new Error("fixture plan script exhausted");
        let name: string;
        let args: unknown;
        if (step === 0) {
          name = "create_plan";
          args = {
            title: "Native plan",
            objective: "Prove native tasks",
            context: "Fixture",
            tasks: [
              { title: "Native task", detail: "Complete in guest graph", exit: "Recorded result" },
            ],
            validation: [],
            retention: "keep",
          };
        } else if (step % 2 === 1) {
          name = "read_plan";
          args = {};
        } else {
          const message = params.messages.findLast((item) => item.role === "tool");
          if (message?.role !== "tool") throw new Error("fixture missing plan tool result");
          const plan = JSON.parse(
            message.content.slice("Tool 'read_plan' result: ".length),
          ) as PlanDocumentDto & { digest: string; spec_digest: string };
          const task = plan.tasks[0];
          if (task === undefined) throw new Error("fixture plan has no task");
          name = "transition_plan_task";
          args = {
            expected_revision: plan.revision,
            expected_digest: plan.digest,
            expected_spec_digest: plan.spec_digest,
            transitions: [
              {
                task_id: task.id,
                status: step === 2 ? "in_progress" : "done",
                ...(step === 4 ? { result: "Native completion" } : {}),
              },
            ],
          };
        }
        const tool = params.tools.find((item) => item.toolName === name);
        if (tool === undefined) throw new Error(`fixture missing native tool ${name}`);
        return {
          toolCalls: [{ id: `fixture-${step}`, name: tool.wireName, arguments: args }],
          usage,
        };
      },
    },
  });
  let next: Awaited<ReturnType<typeof fixture.connect>> | undefined;
  try {
    const { attachment, sessionId } = await fixture.start();
    await attachment.handle.done;
    await attachment.handle.closed;
    expect(calls).toBe(7);
    expect((await fixture.connection.client.sessions.get(sessionId))?.turns[0]?.status).toBe(
      "done",
    );
    const listed = await fixture.connection.client.plans.list();
    expect(listed.plans).toHaveLength(1);
    const plan = await fixture.connection.client.plans.read(listed.plans[0]!.id);
    expect(plan.status).toBe("completed");
    expect(plan.tasks[0]?.result).toBe("Native completion");
    await fixture.connection.close();
    next = await fixture.connect();
    expect(await next.client.plans.read(plan.id)).toEqual(plan);
    expect((await next.client.sessions.get(sessionId))?.turns[0]?.status).toBe("done");
    expect(calls).toBe(7);
  } finally {
    await next?.close();
    await fixture.close();
  }
});

test("native hosted execution resolves a logical compatible alias without endpoint configuration", async () => {
  let calls = 0;
  const fixture = await containerNativeFixture({
    llm: {
      call: async (params) => {
        calls++;
        expect(params.providerConfig).toBeUndefined();
        return {
          text: "Native fixture completed.",
          usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
        };
      },
    },
  });
  try {
    const { attachment, sessionId } = await fixture.start();
    await attachment.handle.done;
    await attachment.handle.closed;
    expect(calls).toBe(1);
    const session = await fixture.connection.client.sessions.get(sessionId);
    expect(session?.turns[0]?.status).toBe("done");
  } finally {
    await fixture.close();
  }
});

test("native Goal pauses, survives Kernel recreation, and resumes explicitly", async () => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cached_tokens: 0,
    cache_write_tokens: 0,
  };
  const fixture = await containerNativeFixture({
    llm: {
      call: async (params) => {
        const step = calls++;
        const tool = params.tools.find((item) => item.toolName === "update_goal");
        if (tool === undefined) throw new Error("fixture missing native Goal tool");
        if (step === 0) {
          arrived.resolve();
          await release.promise;
          return {
            toolCalls: [
              {
                id: "goal-checkpoint",
                name: tool.wireName,
                arguments: {
                  update: {
                    action: "checkpoint",
                    summary: "Paused native Goal checkpoint",
                    next_step: "Finish after explicit resume",
                  },
                },
              },
            ],
            usage,
          };
        }
        if (step === 1)
          return {
            toolCalls: [
              {
                id: "goal-candidate",
                name: tool.wireName,
                arguments: {
                  update: {
                    action: "candidate",
                    summary: "Resumed native Goal complete",
                    assessments: [
                      {
                        criterion_id: "objective",
                        kind: "qualitative",
                        justification: "The resumed Container Goal completed",
                      },
                    ],
                  },
                },
              },
            ],
            usage,
          };
        if (step === 2) return { text: "Native Goal completed after reconnect.", usage };
        throw new Error("native Goal fixture script exhausted");
      },
    },
  });
  const sessionId = randomUUID();
  let next: Awaited<ReturnType<typeof fixture.connect>> | undefined;
  try {
    await fixture.connection.client.sessions.save({
      id: sessionId,
      title: "Container Goal",
      project_id: "project",
      workspace: "workspace",
      created_at: 1,
      updated_at: 1,
      turns: [],
      totals: { input: 0, output: 0, cached: 0 },
      agent_profile: "fixture",
    });
    const created = await fixture.connection.client.goals.control({
      session_id: sessionId,
      expected_revision: 0,
      operation_id: "create",
      action: {
        kind: "create",
        objective: "Prove native Container Goal continuity",
        limits: { max_net_tokens: 10_000 },
      },
    });
    await arrived.promise;
    const active = await fixture.connection.client.goals.get(sessionId);
    await fixture.connection.client.goals.control({
      session_id: sessionId,
      expected_revision: active.state.revision,
      operation_id: "pause",
      action: { kind: "pause" },
    });
    expect((await fixture.connection.client.goals.get(sessionId)).state.current?.status).toBe(
      "paused",
    );
    release.resolve();
    for (let index = 0; index < 200 && fixture.connection.host.stats().runs !== 0; index += 1)
      await Bun.sleep(0);
    expect(fixture.connection.host.stats().runs).toBe(0);
    const paused = await fixture.connection.client.goals.get(sessionId);
    expect(paused.state.current).toMatchObject({ status: "paused", auto_continuations: 0 });
    expect(paused.state.current?.runs[0]).toMatchObject({
      execution_id: created.execution_id,
      disposition: "checkpoint",
    });

    await fixture.connection.close();
    next = await fixture.connect();
    const recovered = await next.client.goals.get(sessionId);
    expect(recovered.state.current?.status).toBe("paused");
    await next.client.goals.control({
      session_id: sessionId,
      expected_revision: recovered.state.revision,
      operation_id: "resume",
      action: { kind: "resume" },
    });
    let completed = false;
    for (let index = 0; index < 200; index += 1) {
      completed = (await next.client.goals.get(sessionId)).state.current?.status === "complete";
      if (completed) break;
      await Bun.sleep(0);
    }
    expect(completed).toBe(true);
    expect(calls).toBe(3);
  } finally {
    release.resolve();
    await next?.close();
    await fixture.close();
  }
});

test("native Workflow manager launches and persists a leader in the Container graph", async () => {
  let managerStep = 0;
  let leaderCalls = 0;
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cached_tokens: 0,
    cache_write_tokens: 0,
  };
  const fixture = await containerNativeFixture({
    llm: {
      call: async (params) => {
        const runLeader = params.tools.find((item) => item.toolName === "run_leader");
        if (runLeader === undefined) {
          leaderCalls++;
          return { text: "Native leader finding.", usage };
        }
        const step = managerStep++;
        if (step === 0)
          return {
            toolCalls: [
              {
                id: "workflow-leader",
                name: runLeader.wireName,
                arguments: { title: "Native leader", prompt: "Inspect the Container graph." },
              },
            ],
            usage,
          };
        if (step === 1) {
          const awaitAgents = params.tools.find((item) => item.toolName === "await_agents");
          if (awaitAgents === undefined)
            throw new Error("fixture missing native await_agents tool");
          return {
            toolCalls: [{ id: "workflow-await", name: awaitAgents.wireName, arguments: {} }],
            usage,
          };
        }
        if (step === 2) return { text: "Native workflow synthesis.", usage };
        throw new Error("native Workflow fixture script exhausted");
      },
    },
  });
  let next: Awaited<ReturnType<typeof fixture.connect>> | undefined;
  try {
    const { attachment } = await fixture.start({ agent: "admiral" });
    await attachment.handle.done;
    await attachment.handle.closed;
    const detail = await fixture.connection.client.workflows.get(attachment.run.execution_id);
    expect(detail.status).toBe("completed");
    expect(detail.nodes.filter((node) => node.kind === "manager")).toHaveLength(1);
    expect(detail.nodes.filter((node) => node.kind === "leader")).toMatchObject([
      {
        parent_run_id: attachment.run.execution_id,
        title: "Native leader",
        task: "Inspect the Container graph.",
        status: "completed",
      },
    ]);
    expect(managerStep).toBe(3);
    expect(leaderCalls).toBeGreaterThanOrEqual(1);

    await fixture.connection.close();
    next = await fixture.connect();
    expect(await next.client.workflows.get(attachment.run.execution_id)).toEqual(detail);
  } finally {
    await next?.close();
    await fixture.close();
  }
});

test("native composition uses projected settings and injected inference without SDK, MCP, plugins or secret stores", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-container-native-"));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "state");
  mkdirSync(workspaceRoot);
  mkdirSync(globalDir);
  const paths = workspacePaths(workspaceRoot);
  mkdirSync(paths.clarvisDir);
  writeFileSync(
    paths.settingsFile,
    JSON.stringify({
      providers: [{ name: "forbidden", api_key: "fixture-only" }],
      memory: { enabled: true },
    }),
  );
  const configuration = projectContainerConfiguration({
    store: {
      readSettings: () => ({ merged: {}, operator_merged: {}, scopes: {}, sources: [] }),
      listAgents: () => [],
    },
    env: envSchema.parse({ CLARVIS_OWNER: "fixture" }),
    modelCatalog: [],
    sharedPrompt: "",
    contexts: [],
    memoryPolicy: "",
    workflowDefinitions: [],
  });
  const spies = [
    spyOn(llm, "createAiSdkProvider"),
    spyOn(mcp, "createConnectionManager"),
    spyOn(secrets, "createFileSecretStore"),
    spyOn(plugins, "createPluginService"),
    spyOn(fileKernel, "createFileKernel"),
  ];
  let graph: FileRunHost | undefined;
  let client: Awaited<ReturnType<typeof connectKernelClient>> | undefined;
  let calls = 0;
  try {
    graph = await createFileRunHost({
      composition: {
        kind: "container",
        configuration,
        runtime: {
          kind: "container",
          engine: "podman",
          host_platform: "linux",
          guest_platform: "linux",
          network: "none",
          lifecycle: "starting",
        },
        llm: {
          call: async () => {
            calls++;
            throw new Error("unexpected inference");
          },
        },
      },
      kernel: {
        globalDir,
        workspaceRoot,
        defaultOwner: "fixture",
        project: { id: "project" },
        workspace: {
          id: "workspace",
          projectId: "project",
          label: "fixture",
          kind: "primary",
          path: workspaceRoot,
        },
      },
      hostGeneration: "fixture-generation",
      authenticate: () => "operator",
      exposeDefaultOwner: true,
      storage: {
        projection: async () => {
          throw new Error("unexpected run projection");
        },
        removeProjection: async () => undefined,
        commit: async () => undefined,
      },
    });
    client = await connectKernelClient(createLoopbackTransport(graph.server));
    expect(client.localHost).toBeUndefined();
    expect(client.capabilities.goals).toBe(true);
    expect(client.capabilities.runtime?.kind).toBe("container");
    expect(graph.kernel.capabilities.runtime?.kind).toBe("container");
    expect(graph.kernel.capabilities.tasks).toBe(false);
    expect(graph.kernel.capabilities.skills).toBe(false);
    expect((await graph.kernel.config.getSettings()).merged.providers).toBeUndefined();
    expect(await graph.kernel.plugins.list()).toEqual([]);
    expect(await graph.kernel.secrets.listNames()).toEqual([]);
    expect((await graph.kernel.models.get()).source).toBe("projection");
    await expect(graph.kernel.secrets.set("KEY", "fixture-only")).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(graph.kernel.plugins.install("https://invalid.test/plugin")).rejects.toMatchObject(
      { code: "unsupported" },
    );
    expect(calls).toBe(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    try {
      await client?.close();
      await graph?.close();
    } finally {
      for (const spy of spies) spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
