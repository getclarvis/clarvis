import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv } from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM } from "@clarvis/loop/testing";
import type { SkillsProvider } from "@clarvis/loop";
import type { RunEvent } from "@clarvis/protocol";
import { createInProcessKernel } from "../../src/kernel.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import { snapshotRunConfiguration } from "../../src/runs/configuration-snapshot.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-prepared-run-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = createMemoryConfigStore({
    settings: {
      global: {
        default_model: "anthropic/original",
        providers: [{ name: "anthropic", kind: "anthropic" }],
        plans: { mode: "off" },
      },
    },
    agents: [
      {
        name: "captain",
        scope: "global",
        body: "The original manager.",
        frontmatter: {
          grants: ["workflow"],
          tools: [],
          can_spawn: ["worker"],
          default_spawn: "worker",
        },
      },
      {
        name: "worker",
        scope: "global",
        body: "The original worker.",
        frontmatter: {
          tools: [],
          can_spawn: ["worker"],
        },
      },
    ],
  });
  const skill = {
    name: "test-flow",
    description: "Test workflow",
    metadata: { name: "test-flow", description: "Test workflow", agent: "captain" },
    userInvocable: true,
    scope: "user",
    source: "builtin",
    root: "builtin:test-flow",
    dir: "builtin:test-flow",
    path: "builtin:test-flow",
    body: "Follow the original skill instructions.",
    resources: [],
  } satisfies NonNullable<ReturnType<SkillsProvider["loadSkill"]>>;
  const llm = new MockLLM({
    script: [],
    routes: [
      {
        name: "title",
        when: (call) => call.tools?.some((tool) => tool.wireName === "set_title") === true,
        script: [{ toolCalls: [{ name: "set_title", arguments: { title: "Prepared workflow" } }] }],
      },
      {
        name: "manager",
        when: (call) => call.tools?.some((tool) => tool.wireName === "run_leader") === true,
        script: [
          {
            toolCalls: [
              {
                name: "run_leader",
                arguments: { title: "Inspect", prompt: "Inspect using the captured configuration" },
              },
            ],
          },
          { toolCalls: [{ name: "await_agents", arguments: {} }] },
          { text: "Manager finished." },
        ],
      },
      { name: "worker", when: () => true, script: [{ text: "Worker finished." }] },
    ],
  });
  let leases = 0;
  const kernel = createInProcessKernel({
    workspaceRoot: root,
    globalConfigDir: root,
    ...kernelIdentity(root),
    configStore: store,
    assemblerOptions: { defaultAgent: "worker" },
    ownerCache: { idleMs: 0 },
    skillsProvider: { listSkills: () => [skill], loadSkill: () => skill, readResource: () => "" },
    acquireRunLease() {
      leases++;
      return () => {
        leases--;
      };
    },
    deps: {
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" }),
      workspaceRoot: root,
      llm,
      traceStore: createMemoryTraceStore(),
      connections: createConnectionManager({
        workspace: root,
        factory: defaultMCPClientFactory,
        connectTimeoutMs: 1000,
        callTimeoutMs: 1000,
      }),
    },
  });
  cleanup.push(() => kernel.close());
  return { kernel, store, skill, llm, leases: () => leases };
}

describe("prepared kernel execution", () => {
  test("resolves the skill entry once and keeps later workflow leaders on its admitted configuration", async () => {
    const f = await fixture();
    const prepared = f.kernel.prepareRun({
      execution_id: "prepared-tree",
      agent: "worker",
      messages: [],
      skill: { name: "test-flow", task: "Original task" },
    });
    expect(prepared).toMatchObject({
      agent: "captain",
      model: "anthropic/original",
      detachable: true,
    });
    expect(f.llm.calls).toHaveLength(0);
    expect(f.leases()).toBe(0);
    f.skill.body = "Replacement skill must not enter this run.";
    f.store.writeSettings("global", {
      ...f.store.readSettings().merged,
      default_model: "anthropic/changed",
    });
    f.store.writeAgent("global", "worker", {
      frontmatter: { tools: [] },
      body: "Replacement worker.",
    });
    f.store.writeAgent("global", "captain", {
      frontmatter: { tools: [], default_spawn: "unrelated" },
      body: "Replacement manager.",
    });
    const handle = await prepared.start();
    await expect(prepared.start()).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.kernel.runs.start({ execution_id: handle.execution_id, messages: [] }),
    ).rejects.toMatchObject({ code: "conflict" });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect((await handle.done).status).toBe("completed");
    await handle.closed;
    expect(f.leases()).toBe(0);
    expect(
      events.some(
        (event) => event.type === "workflow_run_completed" && event.status === "completed",
      ),
    ).toBe(true);
    const tree = await f.kernel.workflows.get(handle.execution_id);
    expect(tree.nodes.filter((node) => node.kind === "leader")).toMatchObject([
      { status: "completed" },
    ]);
    const calls = JSON.stringify(f.llm.calls);
    expect(calls).toContain("Follow the original skill instructions.");
    expect(calls).toContain("The original worker.");
    expect(calls).not.toContain("Replacement");
    expect(calls).not.toContain("anthropic/changed");
  });

  test("keeps ordinary preparation separate from inference and exposes invalid bindings before start", async () => {
    const f = await fixture();
    expect(() => f.kernel.prepareRun({ agent: "missing", messages: [] })).toThrow("not defined");
    const prepared = f.kernel.prepareRun({
      execution_id: "ordinary",
      messages: [{ role: "user", content: "Go" }],
    });
    expect(prepared.agent).toBe("worker");
    expect(f.llm.calls).toHaveLength(0);
    f.store.deleteAgent("global", "worker");
    const handle = await prepared.start();
    expect((await handle.done).status).toBe("completed");
    await handle.closed;
    expect(JSON.stringify(f.llm.calls)).toContain("The original worker.");
  });

  test("does not resurrect a retired owner generation through a prepared start", async () => {
    const f = await fixture();
    const lease = await f.kernel.acquireOwner("secondary");
    const prepared = f.kernel.prepareRun({ execution_id: "retired", messages: [] }, "secondary");
    lease.release();
    await expect(prepared.start()).rejects.toMatchObject({ code: "unavailable" });
    expect(f.llm.calls).toHaveLength(0);
    const next = await f.kernel.acquireOwner("secondary");
    try {
      const fresh = f.kernel.prepareRun(
        { execution_id: "retired", messages: [{ role: "user", content: "Continue" }] },
        "secondary",
      );
      const handle = await fresh.start();
      expect((await handle.done).status).toBe("completed");
      await handle.closed;
    } finally {
      next.release();
    }
  });

  test("bounds the per-tree snapshot and isolates readers from mutations", () => {
    const store = createMemoryConfigStore();
    const source = snapshotRunConfiguration(store);
    const first = source.listAgents();
    first[0]!.body = "Mutated reader";
    expect(source.listAgents()[0]!.body).not.toBe("Mutated reader");
    expect(() =>
      snapshotRunConfiguration({
        ...store,
        listAgents: () =>
          Array.from({ length: 1025 }, (_, i) => ({ ...first[0]!, name: `agent-${i}` })),
      }),
    ).toThrow("1024 agent profiles");
    store.writeAgent("global", "large", { frontmatter: {}, body: "x".repeat(16 * 1024 * 1024) });
    expect(() => snapshotRunConfiguration(store)).toThrow("16 MiB");
  });
});
