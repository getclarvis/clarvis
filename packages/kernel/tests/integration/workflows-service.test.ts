import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "bun:test";
import {
  createCapabilityRegistry,
  loadEnv,
  type Capability,
  type ExecutionRecord,
  type ExecutionStatus,
} from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM, type MockLLMRoute, type MockLLMScriptStep } from "@clarvis/loop/testing";
import { createAgentToolsCapability } from "@clarvis/loop/capabilities/tools";
import { createFileMemory } from "@clarvis/memory";
import { createMemoryCapability, type MemoryFactory } from "@clarvis/memory/capability";
import { tasksSettingsSpec } from "@clarvis/tasks/settings";
import { createAskUserCapability, type ExecuteRunDeps } from "@clarvis/loop";
import { managerLiveChildrenFloor } from "@clarvis/workflows";
import type { RunEvent } from "@clarvis/protocol";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import {
  createInProcessKernel,
  createSettingsRunAssembler,
  createWorkflowStore,
  type WorkflowRecord,
  type WorkflowStore,
} from "../../src/index.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";
import { recordingLogger } from "../helpers/logger.ts";
import { createWorkflowsService } from "../../src/workflows/workflows-service.ts";
import {
  WORKFLOW_MAX_EDGES,
  WORKFLOW_MAX_ERROR_BYTES,
  WORKFLOW_MAX_REASON_BYTES,
  WORKFLOW_MAX_TASK_BYTES,
  WORKFLOW_RECORD_MAX_BYTES,
  WORKFLOW_TRUNCATION_MARKER,
} from "../../src/workflows/workflow-store.ts";

const PROVIDERS = [{ name: "anthropic", kind: "anthropic" }];

function seededConfig() {
  return createMemoryConfigStore({
    settings: {
      workspace: {
        providers: PROVIDERS,
        default_model: "anthropic/x",
      },
    },
    agents: [
      {
        name: "manager",
        scope: "workspace",
        frontmatter: {
          model: "anthropic/x",
          tools: [],
          grants: ["workflow"],
          can_spawn: ["leader"],
          default_spawn: "leader",
        },
        body: "You are the manager.",
        model: "anthropic/x",
      },
      {
        name: "leader",
        scope: "workspace",
        frontmatter: { model: "anthropic/x", tools: [], can_spawn: ["leader"] },
        body: "You are a leader.",
        model: "anthropic/x",
      },
      {
        // No can_spawn ⇒ this profile runs its leader in subagent-only mode,
        // which is what a real `explorer`/`coder` leader looks like.
        name: "researcher",
        scope: "workspace",
        frontmatter: { model: "anthropic/x", tools: [] },
        body: "You are a researcher.",
        model: "anthropic/x",
      },
    ],
  });
}

function buildDeps(
  workspaceRoot: string,
  script: MockLLMScriptStep[],
  routes?: readonly MockLLMRoute[],
  extraCapabilities: Capability[] = [],
): ExecuteRunDeps {
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000" });
  const llm = new MockLLM({ script, ...(routes !== undefined ? { routes } : {}) });
  const scriptedCall = llm.call.bind(llm);
  llm.call = async (params) => {
    if ((params.tools ?? []).some((tool) => tool.wireName === "set_title")) {
      return {
        toolCalls: [
          { id: "title", name: "set_title", arguments: { title: "Manage workflow task" } },
        ],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    }
    return scriptedCall(params);
  };
  return {
    env,
    llm,
    connections: createConnectionManager({
      workspace: workspaceRoot,
      factory: defaultMCPClientFactory,
      connectTimeoutMs: env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
      callTimeoutMs: env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
    }),
    traceStore: createMemoryTraceStore(),
    workspaceRoot,
    capabilities: [createAgentToolsCapability(), createAskUserCapability(), ...extraCapabilities],
  };
}

/** Claims the manager's calls: only a manager is offered `run_leader`. Manager
 * and leader share a model here, so the tool surface is what tells them apart. */
const IS_MANAGER = (params: { tools?: { wireName: string }[] }): boolean =>
  (params.tools ?? []).some((t) => t.wireName === "run_leader");

/** The auxiliary root-title call has its own one-tool surface. */
const IS_TITLE = (params: { tools?: { wireName: string }[] }): boolean =>
  (params.tools ?? []).some((t) => t.wireName === "set_title");

/** Build a kernel and hand back the {@link MockLLM} driving it, so a test can
 * observe what each agent was actually prompted with. */
function makeKernelWithLLM(script: MockLLMScriptStep[], routes?: readonly MockLLMRoute[]) {
  const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-"));
  const globalConfigDir = mkdtempSync(join(tmpdir(), "clarvis-wf-global-"));
  const deps = buildDeps(ws, script, routes);
  const kernel = createInProcessKernel({
    deps,
    workspaceRoot: ws,
    ...kernelIdentity(ws),
    configStore: seededConfig(),
    globalConfigDir,
  });
  return { kernel, llm: deps.llm as MockLLM };
}

function makeKernel(script: MockLLMScriptStep[], routes?: readonly MockLLMRoute[]) {
  const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-"));
  const globalConfigDir = mkdtempSync(join(tmpdir(), "clarvis-wf-global-"));
  return createInProcessKernel({
    deps: buildDeps(ws, script, routes),
    workspaceRoot: ws,
    ...kernelIdentity(ws),
    configStore: seededConfig(),
    globalConfigDir,
  });
}

describe("WorkflowStore (file-backed)", () => {
  function record(id: string, updatedAt: number): WorkflowRecord {
    return {
      id,
      root_run_id: id,
      title: `wf ${id}`,
      workspace: "/ws",
      status: "running",
      created_at: 1,
      updated_at: updatedAt,
      edges: [{ run_id: id, kind: "manager", title: "root", status: "running" }],
      output_tokens: 0,
    };
  }

  it("round-trips a record and lists newest-first, tolerating a missing dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-wfstore-"));
    const store = createWorkflowStore({ dir, owner: "o" });
    expect(store.list()).toEqual([]);
    store.save(record("a", 10));
    store.save(record("b", 20));
    expect(store.get("a")?.title).toBe("wf a");
    expect(store.list().map((r) => r.id)).toEqual(["b", "a"]);
    expect(store.delete("a")).toBe(true);
    expect(store.get("a")).toBeNull();
    expect(store.delete("missing")).toBe(false);
  });

  it("pages a large catalog from bounded sidecars without parsing workflow bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-wfstore-page-"));
    const ownerDir = join(globalPaths(dir).workflowRecordsDir, "o");
    mkdirSync(ownerDir, { recursive: true });
    const ids: string[] = [];
    for (let index = 0; index < 513; index += 1) {
      const id = `wf-${String(index).padStart(4, "0")}`;
      ids.push(id);
      // A valid sidecar beside an intentionally unreadable body proves listing
      // never parses the edge snapshot on the normal path.
      writeFileSync(join(ownerDir, `${id}.json`), "{unreadable body");
      writeFileSync(
        join(ownerDir, `${id}.summary.json`),
        JSON.stringify({
          id,
          title: id,
          workspace: "/ws",
          status: "completed",
          created_at: 1,
          updated_at: index,
          leader_count: index % 7,
        }),
      );
    }
    const store = createWorkflowStore({ dir, owner: "o" });

    let settled = false;
    const listing = store.listPage({ limit: 25 }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    const first = await listing;
    expect(first.total).toBe(513);
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(-25).reverse());
    const second = await store.listPage({ limit: 25, offset: 25 });
    expect(second.items.map((item) => item.id)).toEqual(ids.slice(-50, -25).reverse());
    await expect(store.listPage({ limit: Number.POSITIVE_INFINITY })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(store.listPage({ offset: 2_001 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(() => store.list()).toThrow("use listPage()");
  });

  it("repairs a legacy sidecar and deletes it with the authoritative record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-wfstore-legacy-"));
    const ownerDir = join(globalPaths(dir).workflowRecordsDir, "o");
    mkdirSync(ownerDir, { recursive: true });
    writeFileSync(join(ownerDir, "legacy.json"), JSON.stringify(record("legacy", 42)));
    const store = createWorkflowStore({ dir, owner: "o" });

    expect((await store.listPage()).items.map((item) => item.id)).toEqual(["legacy"]);
    expect(existsSync(join(ownerDir, "legacy.summary.json"))).toBe(true);
    expect(store.delete("legacy")).toBe(true);
    expect(existsSync(join(ownerDir, "legacy.summary.json"))).toBe(false);
  });

  it("caps edges and large task/error/reason strings with an explicit marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-wfstore-bounds-"));
    const store = createWorkflowStore({ dir, owner: "o" });
    const huge = "é".repeat(20_000);
    const value = record("bounded", 10);
    value.edges.push(
      ...Array.from({ length: WORKFLOW_MAX_EDGES + 50 }, (_, index) => ({
        run_id: `leader-${String(index)}`,
        parent_run_id: value.id,
        kind: "leader" as const,
        title: huge,
        task: huge,
        error: { code: huge, message: huge },
        reason: huge,
        status: "failed",
      })),
    );

    store.save(value);
    const stored = store.get(value.id)!;
    expect(stored.edges).toHaveLength(WORKFLOW_MAX_EDGES);
    expect(stored.edges[0]?.reason).toContain(WORKFLOW_TRUNCATION_MARKER);
    const leader = stored.edges[1]!;
    expect(leader.task).toContain(WORKFLOW_TRUNCATION_MARKER);
    expect(leader.error?.message).toContain(WORKFLOW_TRUNCATION_MARKER);
    expect(leader.reason).toContain(WORKFLOW_TRUNCATION_MARKER);
    expect(Buffer.byteLength(leader.task!, "utf8")).toBeLessThanOrEqual(WORKFLOW_MAX_TASK_BYTES);
    expect(Buffer.byteLength(leader.error!.message, "utf8")).toBeLessThanOrEqual(
      WORKFLOW_MAX_ERROR_BYTES,
    );
    expect(Buffer.byteLength(leader.reason!, "utf8")).toBeLessThanOrEqual(
      WORKFLOW_MAX_REASON_BYTES,
    );
    const body = readFileSync(join(globalPaths(dir).workflowRecordsDir, "o", "bounded.json"));
    expect(body.byteLength).toBeLessThanOrEqual(WORKFLOW_RECORD_MAX_BYTES);
  });

  it("paginates through the replacement path of the bounded top-K heap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-wfstore-heap-"));
    const ownerDir = join(globalPaths(dir).workflowRecordsDir, "o");
    const store = createWorkflowStore({ dir, owner: "o" });
    for (const id of ["a", "b", "c", "d", "e"]) store.save(record(id, 0));
    const traversal = readdirSync(ownerDir)
      .filter((entry) => entry.endsWith(".json") && !entry.endsWith(".summary.json"))
      .map((entry) => entry.slice(0, -5));
    for (const [updatedAt, id] of traversal.entries()) {
      writeFileSync(
        join(ownerDir, `${id}.summary.json`),
        JSON.stringify({
          id,
          title: `wf ${id}`,
          workspace: "/ws",
          status: "running",
          created_at: 1,
          updated_at: updatedAt,
          leader_count: 0,
        }),
      );
    }

    const page = await store.listPage({ limit: 3 });

    expect(page.items.map((item) => item.id)).toEqual(traversal.slice(-3).reverse());
    expect(page.total).toBe(5);
  });

  it("rejects an already-cancelled catalog scan before reading a record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-wfstore-cancelled-"));
    const store = createWorkflowStore({ dir, owner: "o" });
    store.save(record("never-read", 1));
    const controller = new AbortController();
    controller.abort();

    await expect(store.listPage({}, { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("rejects a new record and skips a legacy one when its summary cannot fit 8 KiB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-wfstore-summary-bound-"));
    const ownerDir = join(globalPaths(dir).workflowRecordsDir, "o");
    mkdirSync(ownerDir, { recursive: true });
    const store = createWorkflowStore({ dir, owner: "o" });
    const oversized = record("oversized", 1);
    oversized.workspace = "w".repeat(9 * 1024);

    expect(() => store.save(oversized)).toThrow("workflow summary exceeds 8 KiB");
    expect(store.get(oversized.id)).toBeNull();

    const legacy = { ...oversized, id: "legacy", root_run_id: "legacy" };
    writeFileSync(join(ownerDir, "legacy.json"), JSON.stringify(legacy));
    await expect(store.listPage()).resolves.toMatchObject({ items: [], total: 0 });
    expect(existsSync(join(ownerDir, "legacy.summary.json"))).toBeFalse();
  });

  it("rejects a workflow body before writing when it exceeds the record byte budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-wfstore-record-bound-"));
    const store = createWorkflowStore({ dir, owner: "o" });
    const oversized = record("oversized-body", 1);
    oversized.workspace = "w".repeat(WORKFLOW_RECORD_MAX_BYTES + 1);

    expect(() => store.save(oversized)).toThrow("workflow record exceeds 8 MiB");
    expect(store.get(oversized.id)).toBeNull();
  });

  it("backs up from a UTF-16 split so truncation never persists half a surrogate pair", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-wfstore-surrogate-"));
    const store = createWorkflowStore({ dir, owner: "o" });
    const suffix = `\n${WORKFLOW_TRUNCATION_MARKER} task`;
    const payloadBytes = WORKFLOW_MAX_TASK_BYTES - Buffer.byteLength(suffix, "utf8");
    const prefix = "a".repeat(payloadBytes - 3);
    const value = record("surrogate", 1);
    value.edges.push({
      run_id: "leader",
      kind: "leader",
      title: "leader",
      task: `${prefix}😀${"z".repeat(Buffer.byteLength(suffix, "utf8") + 10)}`,
      status: "completed",
    });

    store.save(value);

    expect(store.get(value.id)?.edges[1]?.task).toBe(`${prefix}${suffix}`);
  });
});

describe("WorkflowsService", () => {
  it("passes catalog cancellation through to the file-store scan", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-list-cancel-"));
    const globalConfigDir = mkdtempSync(join(tmpdir(), "clarvis-wf-list-cancel-global-"));
    const deps = buildDeps(ws, []);
    const workflows = createWorkflowsService({
      deps,
      owner: "kernel-test",
      workspace: ws,
      globalConfigDir,
      assembleRunRequest: createSettingsRunAssembler(seededConfig()),
      store: createWorkflowStore({ dir: globalConfigDir, owner: "kernel-test" }),
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(workflows.list(undefined, { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
    await deps.connections.closeAll();
  });

  it("reconciles crash-orphaned running records only from terminal root traces", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-reconcile-"));
    const globalConfigDir = mkdtempSync(join(tmpdir(), "clarvis-wf-reconcile-global-"));
    const storeDir = mkdtempSync(join(tmpdir(), "clarvis-wf-reconcile-store-"));
    const deps = buildDeps(ws, []);
    const store = createWorkflowStore({ dir: storeDir, owner: "kernel-test" });
    const fullReads: string[] = [];
    const observedStore: WorkflowStore = {
      ...store,
      get(id) {
        fullReads.push(id);
        return store.get(id);
      },
    };
    const record = (id: string, updatedAt: number): WorkflowRecord => ({
      id,
      root_run_id: id,
      title: id,
      workspace: ws,
      status: "running",
      created_at: 1,
      updated_at: updatedAt,
      edges: [
        { run_id: id, kind: "manager", title: "manager", status: "running" },
        {
          run_id: `${id}-done`,
          kind: "leader",
          title: "done",
          status: "completed",
          ended_at: 7,
        },
        { run_id: `${id}-pending`, kind: "leader", title: "pending", status: "running" },
      ],
      output_tokens: 0,
    });
    const trace = (id: string, status: ExecutionStatus, endedAt: number): ExecutionRecord => ({
      id,
      owner_key_name: "kernel-test",
      status,
      started_at: 1,
      ended_at: endedAt,
      elapsed_ms: endedAt - 1,
      request: {
        messages: [{ role: "user", content: "x" }],
        servers: [],
        entry: "manager",
        profiles: [{ name: "manager", model: "anthropic/x", tools: [], iteration_limit: 1 }],
        providers: [{ name: "anthropic", kind: "anthropic" }],
        budget: { on_exceed: "stop", total_token_limit: 1 },
      },
      response: {
        status: "completed",
        result: "done",
        usage: { iterations_used: 1, elapsed_ms: endedAt - 1, by_agent: [] },
      },
      trace: { events: [] },
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_tokens: 0,
      total_cache_write_tokens: 0,
    });
    store.save(record("repair-get", 30));
    store.save(record("repair-list", 20));
    store.save(record("still-live", 10));
    await deps.traceStore.insert(trace("repair-get", "cancelled", 50));
    await deps.traceStore.insert(trace("repair-list", "interrupted", 60));
    const workflows = createWorkflowsService({
      deps,
      owner: "kernel-test",
      workspace: ws,
      globalConfigDir,
      assembleRunRequest: createSettingsRunAssembler(seededConfig()),
      store: observedStore,
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
    });

    const detail = await workflows.get("repair-get");
    expect(detail.status).toBe("cancelled");
    expect(detail.updated_at).toBe(50);
    expect(detail.nodes.map((item) => item.status)).toEqual([
      "cancelled",
      "completed",
      "cancelled",
    ]);

    fullReads.length = 0;
    const page = await workflows.list();
    expect(page.items.find((item) => item.execution_id === "repair-list")).toMatchObject({
      status: "failed",
      updated_at: 60,
    });
    expect(page.items.find((item) => item.execution_id === "still-live")?.status).toBe("running");
    expect(fullReads).toEqual(["repair-list"]);
    expect(store.get("repair-list")).toMatchObject({ status: "failed", updated_at: 60 });
    expect((await store.listPage()).items.find((item) => item.id === "repair-list")).toMatchObject({
      status: "failed",
      updated_at: 60,
    });

    const fallback = createWorkflowsService({
      deps,
      owner: "kernel-test",
      workspace: ws,
      globalConfigDir,
      assembleRunRequest: createSettingsRunAssembler(seededConfig()),
      store: { ...observedStore, listPage: undefined } as WorkflowStore,
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
    });
    expect((await fallback.list()).items).toHaveLength(3);

    const logger = recordingLogger();
    const unreadableTrace = createWorkflowsService({
      deps: {
        ...deps,
        logger,
        traceStore: {
          ...deps.traceStore,
          getById() {
            throw new Error("trace offline");
          },
        },
      },
      owner: "kernel-test",
      workspace: ws,
      globalConfigDir,
      assembleRunRequest: createSettingsRunAssembler(seededConfig()),
      store,
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
    });
    expect((await unreadableTrace.get("still-live")).status).toBe("running");

    store.save(record("unsavable", 40));
    store.save(record("unreadable-record", 35));
    await deps.traceStore.insert(trace("unsavable", "cancelled", 70));
    await deps.traceStore.insert(trace("unreadable-record", "interrupted", 80));

    const unsavableRepair = createWorkflowsService({
      deps: { ...deps, logger },
      owner: "kernel-test",
      workspace: ws,
      globalConfigDir,
      assembleRunRequest: createSettingsRunAssembler(seededConfig()),
      store: {
        ...store,
        save() {
          throw new Error("store read-only");
        },
      },
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
    });
    expect((await unsavableRepair.get("unsavable")).status).toBe("cancelled");

    const unreadableRecord = createWorkflowsService({
      deps: { ...deps, logger },
      owner: "kernel-test",
      workspace: ws,
      globalConfigDir,
      assembleRunRequest: createSettingsRunAssembler(seededConfig()),
      store: {
        ...store,
        get(id) {
          if (id === "unreadable-record") throw new Error("record unreadable");
          return store.get(id);
        },
      },
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
    });
    expect(
      (await unreadableRecord.list()).items.find(
        (item) => item.execution_id === "unreadable-record",
      )?.status,
    ).toBe("running");
    expect(logger.records.filter(({ level }) => level === "warn")).toHaveLength(3);
    await deps.connections.closeAll();
  });

  it("does NOT route a run whose entry profile lacks the workflow grant (no record)", async () => {
    const kernel = makeKernel([{ text: "plain run done." }]);
    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "just a normal run" }],
      agent: "leader",
    });
    for await (const ev of handle.events) void ev;
    const result = await handle.done;

    expect(result.status).toBe("completed");
    const page = await kernel.workflows.list();
    expect(page.items.map((w) => w.execution_id)).not.toContain(handle.execution_id);
    await expect(kernel.workflows.get(handle.execution_id)).rejects.toMatchObject({
      code: "not_found",
    });
    await kernel.close();
  });

  it("routes a manager-grant run through runs.start, persists the record, and rehydrates it via get", async () => {
    const kernel = makeKernel([{ text: "All done." }]);
    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "manage the thing" }],
      agent: "manager",
    });

    const events: RunEvent[] = [];
    for await (const ev of handle.events) events.push(ev);
    const result = await handle.done;

    expect(result.status).toBe("completed");
    expect(events.some((e) => e.type === "run_started")).toBe(true);

    const detail = await kernel.workflows.get(handle.execution_id);
    expect(detail.execution_id).toBe(handle.execution_id);
    expect(detail.status).toBe("completed");
    expect(detail.nodes).toHaveLength(1);
    expect(detail.nodes[0]!.kind).toBe("manager");
    expect(detail.title).toBe("Manage workflow task");
    expect(detail.leader_count).toBe(0);

    const page = await kernel.workflows.list();
    expect(page.items.map((w) => w.execution_id)).toContain(handle.execution_id);

    await kernel.workflows.delete(handle.execution_id);
    await expect(kernel.workflows.get(handle.execution_id)).rejects.toMatchObject({
      code: "not_found",
    });
    await kernel.close();
  });

  it("starts the manager while semantic title generation is still in flight", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-"));
    const globalConfigDir = mkdtempSync(join(tmpdir(), "clarvis-wf-global-"));
    const deps = buildDeps(ws, [{ text: "All done." }]);
    const llm = deps.llm;
    const original = llm.call.bind(llm);
    let releaseTitle!: () => void;
    const titleHeld = new Promise<void>((resolve) => {
      releaseTitle = resolve;
    });
    let markManagerStarted!: () => void;
    const managerStarted = new Promise<void>((resolve) => {
      markManagerStarted = resolve;
    });
    llm.call = async (params) => {
      if (IS_TITLE(params)) await titleHeld;
      else markManagerStarted();
      return original(params);
    };
    const kernel = createInProcessKernel({
      deps,
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
      globalConfigDir,
    });
    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "manage the thing" }],
      agent: "manager",
    });
    const events: RunEvent[] = [];
    const drain = (async () => {
      for await (const event of handle.events) events.push(event);
    })();

    await managerStarted;
    expect((await kernel.workflows.get(handle.execution_id)).title).toStartWith("Workflow ");
    releaseTitle();
    expect((await handle.done).status).toBe("completed");
    await drain;

    expect((await kernel.workflows.get(handle.execution_id)).title).toBe("Manage workflow task");
    expect(events).toContainEqual({
      type: "workflow_title_updated",
      at: expect.any(Number),
      run_id: handle.execution_id,
      title: "Manage workflow task",
    });
    await kernel.close();
  });

  it("reports a subagent-role leader's progress: its turns are not tagged 'lead'", async () => {
    // A leader is whichever profile the manager named. A sub-agent role profile
    // runs its leader in subagent-only mode, so its turns arrive as
    // agent: "subagent" — and counting only "lead" left the UI showing a
    // permanent "loading…" beside a leader that was working.
    const kernel = makeKernel(
      [],
      [
        {
          name: "manager",
          when: IS_MANAGER,
          script: [
            {
              toolCalls: [
                {
                  name: "run_leader",
                  arguments: { title: "Research topic", prompt: "research", profile: "researcher" },
                },
              ],
            },
            { toolCalls: [{ name: "await_agents", arguments: {} }] },
            { text: "manager synthesis" },
          ],
        },
        { name: "leader", when: () => true, script: [{ text: "leader findings" }] },
      ],
    );
    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "decompose this" }],
      agent: "manager",
    });

    const events: RunEvent[] = [];
    for await (const ev of handle.events) events.push(ev);
    await handle.done;

    const progress = events.filter((e) => e.type === "workflow_run_progress");
    expect(progress.length).toBeGreaterThan(0);
    const last = progress.at(-1) as Extract<RunEvent, { type: "workflow_run_progress" }>;
    expect(last.iterations).toBeGreaterThanOrEqual(1);
    expect(last.output_tokens).toBeGreaterThan(0);
    await kernel.close();
  });

  it("delivers a steer to the manager while its leaders are still running", async () => {
    // The defect agent supervision exists to remove, reproduced at the layer the
    // user drives: a manager mid-fan-out must stay reachable. Before background
    // spawn the manager sat inside its dispatch until the slowest leader
    // returned, and the steer waited out the whole fan-out.
    const STEER = "drop angle B, focus on auth";
    let releaseLeaders!: () => void;
    const leadersHeld = new Promise<void>((resolve) => {
      releaseLeaders = resolve;
    });
    let leadersStarted = 0;
    let markLeadersStarted!: () => void;
    const allLeadersStarted = new Promise<void>((resolve) => {
      markLeadersStarted = resolve;
    });
    let markManagerSteered!: () => void;
    const managerSteered = new Promise<void>((resolve) => {
      markManagerSteered = resolve;
    });

    const { kernel, llm } = makeKernelWithLLM(
      [],
      [
        {
          name: "manager",
          when: IS_MANAGER,
          script: [
            {
              toolCalls: [
                {
                  id: "a",
                  name: "run_leader",
                  arguments: { title: "Research A", prompt: "A", profile: "researcher" },
                },
                {
                  id: "b",
                  name: "run_leader",
                  arguments: { title: "Research B", prompt: "B", profile: "researcher" },
                },
              ],
            },
            { toolCalls: [{ name: "await_agents", arguments: {} }] },
            { text: "manager synthesis" },
          ],
        },
        { name: "leader", when: () => true, script: [{ text: "leader done" }] },
      ],
    );

    const original = llm.call.bind(llm);
    llm.call = async (params) => {
      if (IS_TITLE(params)) {
        return original(params);
      }
      if (IS_MANAGER(params)) {
        if (
          params.messages.some(
            (message) => typeof message.content === "string" && message.content.includes(STEER),
          )
        ) {
          markManagerSteered();
        }
      } else {
        leadersStarted += 1;
        if (leadersStarted === 2) markLeadersStarted();
        await leadersHeld;
      }
      return original(params);
    };

    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "decompose this" }],
      agent: "manager",
    });
    const drained = (async () => {
      for await (const ev of handle.events) void ev;
    })();

    await allLeadersStarted;
    await handle.steer(STEER);

    // The manager must take another turn — carrying the steer — while both
    // leaders are still parked. Only then are they released.
    await managerSteered;
    expect(leadersStarted).toBe(2);

    releaseLeaders();
    await drained;
    await handle.done;
    await kernel.close();
  });

  it("fans out a leader via run_leader and records it as a second tree node", async () => {
    // No `profile` on the run_leader call: the leader defaults to the manager's
    // `default_spawn` ("leader" here) — never the manager's own profile — and never
    // fails with "no agent given".
    // `run_leader` is background-only, so the manager and the leader are genuinely
    // concurrent and a single global cursor would hand one the other's lines.
    // Each gets its own script; the manager parks on await_agents rather than
    // finishing on top of a live child.
    const kernel = makeKernel(
      [],
      [
        {
          name: "manager",
          when: IS_MANAGER,
          script: [
            {
              toolCalls: [
                {
                  name: "run_leader",
                  arguments: { title: "Research topic", prompt: "research the topic" },
                },
              ],
            },
            { toolCalls: [{ name: "await_agents", arguments: {} }] },
            { text: "manager synthesis" },
          ],
        },
        { name: "leader", when: () => true, script: [{ text: "leader findings" }] },
      ],
    );
    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "decompose this" }],
      agent: "manager",
    });

    const events: RunEvent[] = [];
    for await (const ev of handle.events) events.push(ev);
    const result = await handle.done;

    expect(result.status).toBe("completed");
    const started = events.find((event) => event.type === "workflow_run_started");
    const completed = events.find((event) => event.type === "workflow_run_completed");
    expect(started).toMatchObject({
      type: "workflow_run_started",
      parent_run_id: handle.execution_id,
      title: "Research topic",
      task: "research the topic",
    });
    expect(completed).toMatchObject({
      type: "workflow_run_completed",
      parent_run_id: handle.execution_id,
      status: "completed",
    });
    if (started?.type === "workflow_run_started" && completed?.type === "workflow_run_completed") {
      expect(completed.run_id).toBe(started.run_id);
    }
    // The leader's internal iterations are forwarded live as workflow_run_progress
    // (onLeaderEvent → cumulative per-leader iterations/tokens on the manager stream).
    const progress = events.filter((e) => e.type === "workflow_run_progress");
    expect(progress.length).toBeGreaterThan(0);
    const last = progress.at(-1) as Extract<RunEvent, { type: "workflow_run_progress" }>;
    expect(last.iterations).toBeGreaterThanOrEqual(1);

    const detail = await kernel.workflows.get(handle.execution_id);
    const leaders = detail.nodes.filter((n) => n.kind === "leader");
    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.parent_run_id).toBe(handle.execution_id);
    expect(leaders[0]!.title).toBe("Research topic");
    expect(leaders[0]!.task).toBe("research the topic");
    expect(leaders[0]!.status).toBe("completed");
    expect(detail.leader_count).toBe(1);

    await kernel.close();
  });

  it("forwards one external task binding to both workflow manager and leaders", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-task-"));
    const globalConfigDir = mkdtempSync(join(tmpdir(), "clarvis-wf-task-global-"));
    const storeDir = mkdtempSync(join(tmpdir(), "clarvis-wf-task-store-"));
    const deps = buildDeps(
      ws,
      [],
      [
        {
          name: "manager",
          when: IS_MANAGER,
          script: [
            {
              toolCalls: [
                {
                  name: "run_leader",
                  arguments: { title: "Implement task", prompt: "implement it" },
                },
              ],
            },
            { toolCalls: [{ name: "await_agents", arguments: {} }] },
            { text: "manager synthesis" },
          ],
        },
        { name: "leader", when: () => true, script: [{ text: "leader result" }] },
      ],
    );
    const capabilityRegistry = createCapabilityRegistry({ specs: [tasksSettingsSpec] });
    const runDeps = { ...deps, capabilityRegistry };
    const baseAssembler = createSettingsRunAssembler(seededConfig());
    const assembled: Parameters<typeof baseAssembler>[0][] = [];
    const workflows = createWorkflowsService({
      deps: runDeps,
      owner: "kernel-test",
      workspace: ws,
      globalConfigDir,
      assembleRunRequest: (params) => {
        assembled.push(structuredClone(params));
        return baseAssembler(params);
      },
      store: createWorkflowStore({ dir: storeDir, owner: "kernel-test" }),
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
      resolveLeaderDefault: () => "leader",
    });
    const task = {
      id: "CLAR-42",
      provider_key: "tasks:mcp:v1:sha256:test",
      mode: "work" as const,
    };

    const result = await workflows.runManagerWorkflow({
      messages: [{ role: "user", content: "work on the bound task" }],
      agent: "manager",
      task,
    }).done;

    expect(result).toMatchObject({ status: "completed" });
    expect(assembled).toHaveLength(2);
    expect(assembled.map((params) => params.task)).toEqual([task, task]);
    await deps.connections.closeAll();
  });

  it("raises the manager's live-children ceiling to what its leader concurrency needs", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-ceiling-"));
    const globalConfigDir = mkdtempSync(join(tmpdir(), "clarvis-wf-ceiling-global-"));
    const storeDir = mkdtempSync(join(tmpdir(), "clarvis-wf-ceiling-store-"));
    const deps = buildDeps(
      ws,
      [],
      [{ name: "manager", when: IS_MANAGER, script: [{ text: "manager synthesis" }] }],
    );
    const baseAssembler = createSettingsRunAssembler(seededConfig());
    const bodies: Array<Record<string, unknown>> = [];
    const workflows = createWorkflowsService({
      deps,
      owner: "kernel-test",
      workspace: ws,
      globalConfigDir,
      assembleRunRequest: (params) => {
        const body = baseAssembler(params) as Record<string, unknown>;
        bodies.push(body);
        return body;
      },
      store: createWorkflowStore({ dir: storeDir, owner: "kernel-test" }),
      readSettings: () => ({ max_concurrency: 12, budget_tokens: null }),
    });

    const result = await workflows.runManagerWorkflow({
      messages: [{ role: "user", content: "just synthesize" }],
      agent: "manager",
    }).done;

    expect(result).toMatchObject({ status: "completed" });
    // Without this the semaphore would admit twelve leaders and the supervision
    // registry would refuse to register them past its own default of eight.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.agents).toMatchObject({ max_live_children: managerLiveChildrenFloor(12) });
    expect(managerLiveChildrenFloor(12)).toBeGreaterThan(12);
    await deps.connections.closeAll();
  });

  it("flushes one coalesced terminal snapshot before done and closed settle", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-flush-"));
    const globalConfigDir = mkdtempSync(join(tmpdir(), "clarvis-wf-flush-global-"));
    const storeDir = mkdtempSync(join(tmpdir(), "clarvis-wf-flush-store-"));
    const deps = buildDeps(
      ws,
      [],
      [
        {
          name: "manager",
          when: IS_MANAGER,
          script: [
            {
              toolCalls: [
                {
                  name: "run_leader",
                  arguments: { title: "Bounded save", prompt: "do the work" },
                },
              ],
            },
            { toolCalls: [{ name: "await_agents", arguments: {} }] },
            { text: "manager synthesis", delayMs: 50 },
          ],
        },
        { name: "leader", when: () => true, script: [{ text: "leader result" }] },
      ],
    );
    const backing = createWorkflowStore({ dir: storeDir, owner: "kernel-test" });
    const logger = recordingLogger();
    let saves = 0;
    let scheduled = 0;
    let cancelled = 0;
    let scheduledTask: (() => void) | undefined;
    const workflows = createWorkflowsService({
      deps: { ...deps, logger },
      owner: "kernel-test",
      workspace: ws,
      globalConfigDir,
      assembleRunRequest: createSettingsRunAssembler(seededConfig()),
      store: {
        ...backing,
        save(record) {
          saves += 1;
          if (saves === 2) throw new Error("background save failed");
          backing.save(record);
        },
      },
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
      resolveLeaderDefault: () => "leader",
      persistenceDelayMs: 1_000,
      persistenceRuntime: {
        schedule(task) {
          scheduled += 1;
          scheduledTask = task;
          return {
            cancel() {
              cancelled += 1;
            },
          };
        },
      },
    });
    const handle = workflows.runManagerWorkflow({
      messages: [{ role: "user", content: "manage and persist" }],
      agent: "manager",
    });
    const drain = (async () => {
      for await (const event of handle.events) void event;
    })();

    for (let attempt = 0; scheduledTask === undefined && attempt < 20; attempt += 1) {
      await Bun.sleep(0);
    }
    scheduledTask?.();

    expect((await handle.done).status).toBe("completed");
    await handle.closed;
    await drain;
    expect(scheduled).toBe(2);
    expect(cancelled).toBe(1);
    expect(saves).toBe(3);
    expect(
      logger.records.some(({ message }) => message.includes("coalesced record save failed")),
    ).toBe(true);
    const terminal = backing.get(handle.execution_id)!;
    expect(terminal.status).toBe("completed");
    expect(terminal.edges[0]).toMatchObject({ kind: "manager", status: "completed" });
    expect(terminal.edges[1]).toMatchObject({ kind: "leader" });
    expect(terminal.edges[1]?.status).not.toBe("running");
    await deps.connections.closeAll();
  });

  it("cancelling mid-fan-out never crashes or hangs, and settles into a sane, non-'running' final state", async () => {
    // Verified (by tracing runDispatch's `finally { await Promise.allSettled(deferred) }`
    // in the loop, plus TraceHandle.record's synchronous onRecord dispatch): the
    // manager's run cannot finalize while an in-flight leader's deferred handler is
    // still unsettled, and that handler always records workflow_run_completed/failed
    // before it returns. So every started leader's edge is closed via the ordinary
    // observe() path here too — this is an end-to-end smoke test that cancellation
    // during fan-out behaves sanely, not a regression test for closeRunningEdges
    // (that lives below, directly on the function, since this scenario never
    // exercises its "leftover running edge" branch).
    const kernel = makeKernel([
      {
        toolCalls: [
          {
            name: "run_leader",
            arguments: { title: "Research topic", prompt: "research the topic" },
          },
        ],
      },
      { text: "leader findings", delayMs: 200 },
      { text: "manager synthesis" },
    ]);
    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "decompose this" }],
      agent: "manager",
    });

    const pump = (async () => {
      for await (const event of handle.events) {
        if (event.type === "workflow_run_started") void handle.cancel();
      }
    })();
    await handle.done;
    await pump;

    const detail = await kernel.workflows.get(handle.execution_id);
    expect(detail.nodes.length).toBeGreaterThan(0);
    for (const node of detail.nodes) {
      expect(node.status).not.toBe("running");
    }

    await kernel.close();
  });

  it("is owner-scoped: forOwner(other).workflows is isolated from the default owner's, and forOwner is memoized", async () => {
    const kernel = makeKernel([{ text: "done for A" }, { text: "done for B" }]);

    const a = await kernel.runs.start({
      messages: [{ role: "user", content: "task for owner A" }],
      agent: "manager",
    });
    for await (const ev of a.events) void ev;
    await a.done;

    const other = kernel.forOwner("owner-b");
    expect(other.workflows).toBe(kernel.forOwner("owner-b").workflows); // memoized per owner
    expect(other.workflows).not.toBe(kernel.workflows); // distinct from the default owner

    const b = await other.runs.start({
      messages: [{ role: "user", content: "task for owner B" }],
      agent: "manager",
    });
    for await (const ev of b.events) void ev;
    await b.done;

    // Each owner sees only its own workflow.
    const listA = await kernel.workflows.list();
    const listB = await other.workflows.list();
    expect(listA.items.map((w) => w.execution_id)).toEqual([a.execution_id]);
    expect(listB.items.map((w) => w.execution_id)).toEqual([b.execution_id]);
    await expect(kernel.workflows.get(b.execution_id)).rejects.toMatchObject({ code: "not_found" });
    await expect(other.workflows.get(a.execution_id)).rejects.toMatchObject({ code: "not_found" });

    await kernel.close();
  });
});

describe("WorkflowsService workflow discovery", () => {
  /** Seed `<ws>/.clarvis/workflows/<name>/` with a document and its brief. */
  function seedWorkflow(ws: string, name: string, document: string, brief?: string): void {
    const dir = join(workspacePaths(ws).workflowsDir, name);
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "WORKFLOW.md"), document);
    if (brief !== undefined) writeFileSync(join(dir, "briefs", "one.md"), brief);
  }

  const GOOD = `---
name: probe
description: A one-round workflow.
rounds:
  - id: look
    title: Look around
    type: discovery
    over: once
    brief: briefs/one.md
---
Say what was found.
`;

  it("offers built-in workflows without materializing a workflow directory", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-"));
    const storeDir = mkdtempSync(join(tmpdir(), "clarvis-wf-store-"));
    const deps = buildDeps(ws, [{ text: "All done." }]);
    const calls: string[][] = [];
    const call = deps.llm.call.bind(deps.llm);
    deps.llm.call = async (params) => {
      calls.push((params.tools ?? []).map((tool) => tool.wireName));
      return call(params);
    };
    const workflows = createWorkflowsService({
      deps,
      owner: "kernel-test",
      workspace: ws,
      assembleRunRequest: createSettingsRunAssembler(seededConfig()),
      store: createWorkflowStore({ dir: storeDir, owner: "kernel-test" }),
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
    });

    const result = await workflows.runManagerWorkflow({
      messages: [{ role: "user", content: "manage the thing" }],
      agent: "manager",
    }).done;

    expect(result.status).toBe("completed");
    expect(calls.some((tools) => tools.includes("run_workflow"))).toBe(true);
    expect(existsSync(workspacePaths(ws).workflowsDir)).toBe(false);
  });

  it("reports a malformed workflow document without failing the run that found it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-"));
    const storeDir = mkdtempSync(join(tmpdir(), "clarvis-wf-store-"));
    seedWorkflow(ws, "probe", GOOD, "Do the thing.");
    seedWorkflow(ws, "audit", "this is not a workflow document");

    const warnings: unknown[] = [];
    const deps = buildDeps(ws, [{ text: "All done." }]);
    const offeredTools: string[] = [];
    const call = deps.llm.call.bind(deps.llm);
    deps.llm.call = async (params) => {
      offeredTools.push(JSON.stringify(params.tools ?? []));
      return call(params);
    };
    const workflows = createWorkflowsService({
      deps: {
        ...deps,
        logger: {
          debug: (): void => {},
          info: (): void => {},
          error: (): void => {},
          warn: (fields: unknown): void => {
            warnings.push(fields);
          },
        } as unknown as ExecuteRunDeps["logger"],
      },
      owner: "kernel-test",
      workspace: ws,
      assembleRunRequest: createSettingsRunAssembler(seededConfig()),
      store: createWorkflowStore({ dir: storeDir, owner: "kernel-test" }),
      readSettings: () => ({ max_concurrency: 2, budget_tokens: null }),
    });

    const result = await workflows.runManagerWorkflow({
      messages: [{ role: "user", content: "manage the thing" }],
      agent: "manager",
    }).done;

    // One document is unreadable and the other is fine: the run proceeds, and the
    // bad one is named rather than silently dropped. A single malformed workflow
    // must not make every other one undiscoverable.
    expect(result.status).toBe("completed");
    expect(warnings.filter((w) => JSON.stringify(w).includes("audit"))).toHaveLength(1);
    expect(offeredTools.some((tools) => tools.includes("audit: Map a subject"))).toBe(true);
  });
});

/** A {@link MemoryFactory} over a real file-backed wiki in `root`, with no
 * indexer model — enough to contribute the seven wiki tools. */
function memoryFactoryOverTree(root: string): MemoryFactory {
  const memory = createFileMemory({ root: join(root, "memory") });
  return {
    forOwner: () => undefined,
    forOwnerControlPlane: () => memory,
    start: () => {},
    poke: () => {},
    stop: async () => {},
    subscribeToRun: () => () => {},
  };
}

describe("deps-level capabilities reach a workflow leader", () => {
  // `run-leader.ts` calls `executeRun` with `deps: ctx.deps` and no `capabilities`
  // argument, so a leader inherits exactly `deps.capabilities` and nothing else.
  // That is why the kernel folds memory into the deps object rather than passing
  // it per call site the way it passes `workflowsCap` — the opposite choice would
  // strip `edit_memory` from every leader, with nothing failing.
  it("offers the entry agent's memory write tools to a leader, not just to the manager", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-wf-mem-"));
    const globalConfigDir = mkdtempSync(join(tmpdir(), "clarvis-wf-mem-global-"));
    const deps = buildDeps(
      ws,
      [],
      [
        {
          name: "manager",
          when: IS_MANAGER,
          script: [
            {
              toolCalls: [
                { name: "run_leader", arguments: { title: "Research memory", prompt: "go" } },
              ],
            },
            { toolCalls: [{ name: "await_agents", arguments: {} }] },
            { text: "manager synthesis" },
          ],
        },
        { name: "leader", when: () => true, script: [{ text: "leader findings" }] },
      ],
      [createMemoryCapability(memoryFactoryOverTree(ws))],
    );
    const kernel = createInProcessKernel({
      deps,
      workspaceRoot: ws,
      ...kernelIdentity(ws),
      configStore: seededConfig(),
      globalConfigDir,
    });

    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "decompose this" }],
      agent: "manager",
    });
    // Deliberately not draining `handle.events`: an active memory capability
    // emits a non-terminal `queued` ingest notice from `onRunEnd`, and the run
    // service holds the stream open for `DEFAULT_INGEST_CLOSE_GRACE_MS` waiting
    // for the job to settle. Nothing drains the queue here, so the stream would
    // linger for that whole grace. `done` does not wait on it.
    expect((await handle.done).status).toBe("completed");

    const llm = deps.llm as MockLLM;
    const leaderCalls = llm.calls.filter((c) => !IS_MANAGER(c));
    expect(leaderCalls.length).toBeGreaterThan(0);
    const offered = (call: (typeof leaderCalls)[number]): string[] =>
      (call.tools ?? []).map((t) => t.wireName);
    // Read tools reach every agent; the write half is the entry-agent gate, and a
    // leader IS the entry agent of its own run.
    expect(leaderCalls.some((c) => offered(c).includes("read_memory"))).toBe(true);
    expect(leaderCalls.some((c) => offered(c).includes("write_memory"))).toBe(true);
    expect(leaderCalls.some((c) => offered(c).includes("edit_memory"))).toBe(true);

    await kernel.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
  });
});
