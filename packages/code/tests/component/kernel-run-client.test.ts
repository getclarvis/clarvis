import { expect, test } from "bun:test";
import { kernelError } from "@clarvis/kernel";
import type {
  ElicitationRequest,
  KernelClient,
  RunDetail,
  RunEvent,
  RunResult,
} from "@clarvis/protocol";
import {
  createKernelRunClient,
  type KernelRunClientCallbacks,
} from "../../src/adapters/kernel-run-client.ts";
import type { RunProgress } from "../../src/adapters/run-types.ts";
import { recordDiagnostics } from "../helpers/recording-diagnostics.ts";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function controllableHandle(executionId: string) {
  const buffer: RunEvent[] = [];
  let streamEnded = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let wake: (() => void) | undefined;
  const bump = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  async function* gen(): AsyncGenerator<RunEvent> {
    for (;;) {
      if (buffer.length > 0) {
        yield buffer.shift() as RunEvent;
        continue;
      }
      if (streamEnded) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  let settle!: (r: RunResult) => void;
  const done = new Promise<RunResult>((r) => (settle = r));
  let elicitHandler: ((req: ElicitationRequest) => void) | undefined;
  const steered: unknown[] = [];
  const compacted: unknown[] = [];
  const responded: unknown[] = [];
  const handle = {
    execution_id: executionId,
    events: { [Symbol.asyncIterator]: () => gen() },
    steer: async (m: unknown) => void steered.push(m),
    compact: async (request?: string) => void compacted.push(request),
    cancel: async () => {},
    respond: async (r: unknown) => void responded.push(r),
    onElicit: (h: (req: ElicitationRequest) => void) => (elicitHandler = h),
    done,
    closed,
  };
  return {
    handle,
    push: (e: RunEvent) => {
      buffer.push(e);
      bump();
    },
    close: () => {
      streamEnded = true;
      resolveClosed();
      bump();
    },
    settle,
    fireElicit: (req: ElicitationRequest) => elicitHandler?.(req),
    steered,
    compacted,
    responded,
  };
}

interface KernelOver {
  start?: (params: unknown) => ReturnType<KernelClient["runs"]["start"]>;
  get?: (id: string) => RunDetail | null;
  getError?: unknown;
  del?: (id: string) => boolean;
  deleteError?: unknown;
  compact?: KernelClient["runs"]["compact"];
  agents?: { name: string; scope: "workspace" | "global"; model?: string; description?: string }[];
  tasks?: KernelClient["tasks"];
  capabilities?: Partial<KernelClient["capabilities"]>;
}

/**
 * A deliberately partial {@link KernelClient}: this suite drives the run
 * client, which touches `runs`, `listAgents` and `close` only.
 *
 * @remarks The widening goes through `unknown` because the real surface carries
 * ten services and standing them all up here would say nothing about the client.
 * It blinds nothing: every member below is explicitly typed on its own, either by
 * annotation or through {@link KernelOver}.
 */
function fakeKernel(over: KernelOver): KernelClient {
  return {
    workspaceRoot: "/ws",
    runs: {
      start: over.start ?? (async () => controllableHandle("exec_x").handle),
      compact:
        over.compact ?? (async (id: string) => ({ status: "queued" as const, execution_id: id })),
      context: async (id: string) => ({
        execution_id: id,
        estimated_tokens: 0,
        has_context: false,
      }),
      async get(id: string) {
        if (over.getError !== undefined) throw over.getError;
        const d = over.get?.(id) ?? null;
        if (d === null) throw kernelError("not_found", `run '${id}' not found`);
        return d;
      },
      async list() {
        return { items: [], total: 0, limit: 20, offset: 0 };
      },
      async delete(id: string) {
        if (over.deleteError !== undefined) throw over.deleteError;
        if (!(over.del?.(id) ?? false)) throw kernelError("not_found", `run '${id}' not found`);
      },
    },
    config: {
      listAgents: async () => over.agents ?? [],
    } as KernelClient["config"],
    environments: {
      current: async () => ({
        id: "builtin:default",
        fingerprint: `sha256:${"0".repeat(64)}`,
      }),
    } as KernelClient["environments"],
    ...(over.tasks === undefined ? {} : { tasks: over.tasks }),
    ...(over.capabilities === undefined ? {} : { capabilities: over.capabilities }),
    close: async () => {},
  } as unknown as KernelClient;
}

function client(over: KernelOver, cbOver: Partial<KernelRunClientCallbacks> = {}) {
  const events: RunEvent[] = [];
  const progress: RunProgress[] = [];
  const callbacks: KernelRunClientCallbacks = {
    onEvent: (e) => events.push(e),
    onProgress: (p) => progress.push(p),
    ...cbOver,
  };
  const c = createKernelRunClient({ createKernel: async () => fakeKernel(over), callbacks });
  return { c, events, progress };
}

test("connect exposes the process-pinned Environment identity", async () => {
  const { c } = client({});
  await c.connect();
  expect(c.currentEnvironment()).toEqual({
    id: "builtin:default",
    fingerprint: `sha256:${"0".repeat(64)}`,
  });
  await c.dispose();
});

test("startRun pumps the kernel event stream into onEvent and resolves done", async () => {
  const ctrl = controllableHandle("exec_1");
  const { c, events, progress } = client({ start: async () => ctrl.handle });
  await c.connect();

  const handle = c.startRun({ messages: [{ role: "user", content: "hi" }], profile: "coder" });
  ctrl.push({ type: "run_started", at: 0, lead_model: "m" });
  ctrl.push({ type: "iteration_started", at: 1, agent: "lead", iteration: 1, model: "m" });
  ctrl.settle({ execution_id: "exec_1", status: "completed", result: "done" });
  ctrl.close();

  const result = await handle.done;
  expect(result).toMatchObject({ execution_id: "exec_1", status: "completed", result: "done" });
  await flushMicrotasks();
  expect(events.map((e) => e.type)).toEqual(["run_started", "iteration_started"]);
  expect(progress).toEqual([{ label: "iteration 1", iteration: 1, counter: 0 }]);
});

test("done does not release the event pump before the protocol stream closes", async () => {
  const ctrl = controllableHandle("exec_lifecycle");
  const routed: { type: RunEvent["type"]; executionId: string }[] = [];
  const c = createKernelRunClient({
    createKernel: async () => fakeKernel({ start: async () => ctrl.handle }),
    callbacks: {
      onEvent: (event, _source, executionId) => routed.push({ type: event.type, executionId }),
    },
  });
  await c.connect();

  const handle = c.startRun({ executionId: "exec_lifecycle", messages: [] });
  ctrl.settle({ execution_id: "exec_lifecycle", status: "completed" });
  await handle.done;
  let closed = false;
  void handle.closed.then(() => {
    closed = true;
  });
  await flushMicrotasks();
  expect(closed).toBe(false);

  ctrl.push({ type: "run_started", at: 1 });
  await flushMicrotasks();
  expect(routed).toEqual([{ type: "run_started", executionId: "exec_lifecycle" }]);

  ctrl.close();
  await handle.closed;
  expect(closed).toBe(true);
});

test("startRun maps the complete guard and active-task request without workspace routing", async () => {
  const ctrl = controllableHandle("exec_task");
  let captured: unknown;
  const { c } = client({
    start: async (params) => {
      captured = params;
      return ctrl.handle;
    },
  });
  await c.connect();
  const handle = c.startRun({
    executionId: "exec_task",
    messages: [],
    guardJudge: {
      prompt: "review writes",
      model: "openai/judge",
      onUnsure: "deny",
      timeoutMs: 5_000,
    },
    task: { id: "CLAR-42", provider_key: "provider-key", mode: "work" },
  });
  expect(captured).toMatchObject({
    execution_id: "exec_task",
    guard_judge: {
      prompt: "review writes",
      model: "openai/judge",
      on_unsure: "deny",
      timeout_ms: 5_000,
    },
    task: { id: "CLAR-42", provider_key: "provider-key", mode: "work" },
  });
  expect(captured).not.toHaveProperty("workspace");
  ctrl.settle({ execution_id: "exec_task", status: "completed" });
  ctrl.close();
  await handle.done;
});

test("progress derives retries, plan revisions and non-successful run endings", async () => {
  const ctrl = controllableHandle("exec_progress");
  const { c, progress } = client({ start: async () => ctrl.handle });
  await c.connect();
  const handle = c.startRun({ executionId: "exec_progress", messages: [] });
  ctrl.push({
    type: "model_retry",
    at: 1,
    agent: "lead",
    iteration: 2,
    kind: "rate_limit",
    attempt: 2,
    max_retries: 3,
    delay_ms: 1_500,
  });
  ctrl.push({
    type: "plan_updated",
    at: 2,
    change: "task",
    id: "11111111-1111-1111-1111-111111111111",
    path: ".clarvis/plans/work.md",
    title: "Work",
    status: "active",
    retention: "keep",
    revision: 7,
    spec_revision: 1,
    tasks: [],
  });
  ctrl.push({ type: "run_ended", at: 3, status: "failed", reason: "provider_error" });
  ctrl.settle({ execution_id: "exec_progress", status: "failed" });
  ctrl.close();
  await handle.done;
  await flushMicrotasks();
  expect(progress).toEqual([
    { label: "retrying in 2s (2/3)", counter: 0 },
    { label: "plan r7", event: { type: "plan_updated" }, counter: 1 },
    {
      label: "",
      event: { type: "run_ended", reason: "provider_error" },
      counter: 2,
    },
  ]);
});

test("memory_ingest events route to onMemoryIngest, never the transcript", async () => {
  const ctrl = controllableHandle("exec_m");
  const notices: unknown[] = [];
  const { c, events } = client(
    { start: async () => ctrl.handle },
    { onMemoryIngest: (n) => void notices.push(n) },
  );
  await c.connect();
  const handle = c.startRun({ messages: [], profile: "coder", executionId: "exec_m" });

  ctrl.push({ type: "run_started", at: 0 });
  ctrl.settle({ execution_id: "exec_m", status: "completed" });
  ctrl.push({ type: "memory_ingest", at: 1, detail: { execution_id: "exec_m", phase: "started" } });
  ctrl.push({
    type: "memory_ingest",
    at: 2,
    detail: { execution_id: "exec_m", phase: "done", written: 2, deleted: 0 },
  });
  ctrl.close();

  await handle.done;
  await flushMicrotasks();
  expect(notices).toEqual([
    { execution_id: "exec_m", phase: "started" },
    { execution_id: "exec_m", phase: "done", written: 2, deleted: 0 },
  ]);
  expect(events.some((e) => e.type === "memory_ingest")).toBe(false);
});

test("steer routes to the live handle by execution id", async () => {
  const ctrl = controllableHandle("exec_2");
  const { c } = client({ start: async () => ctrl.handle });
  await c.connect();
  const handle = c.startRun({ messages: [], profile: "coder", executionId: "exec_2" });
  await flushMicrotasks();

  const res = await c.steer({ executionId: "exec_2", message: "focus on tests" });
  expect(res).toEqual({ status: "steered", execution_id: "exec_2", accepted: 1 });
  expect(ctrl.steered).toEqual(["focus on tests"]);

  const unknown = await c.steer({ executionId: "nope", message: "x" });
  expect(unknown.status).toBe("unknown");

  ctrl.settle({ execution_id: "exec_2", status: "completed" });
  ctrl.close();
  await handle.done;
});

test("steer waits for a run handle that is still starting", async () => {
  const ctrl = controllableHandle("exec_starting");
  let release!: (handle: typeof ctrl.handle) => void;
  const starting = new Promise<typeof ctrl.handle>((resolve) => {
    release = resolve;
  });
  const { c } = client({ start: () => starting });
  await c.connect();
  const run = c.startRun({ messages: [], profile: "coder", executionId: "exec_starting" });

  const steering = c.steer({ executionId: "exec_starting", message: "keep going" });
  release(ctrl.handle);

  expect(await steering).toMatchObject({ status: "steered", execution_id: "exec_starting" });
  expect(ctrl.steered).toEqual(["keep going"]);
  ctrl.settle({ execution_id: "exec_starting", status: "completed" });
  ctrl.close();
  await run.done;
});

test("cancel stays pending until the kernel acknowledges the request", async () => {
  const ctrl = controllableHandle("exec_cancel");
  let acknowledge!: () => void;
  ctrl.handle.cancel = () =>
    new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
  const { c } = client({ start: async () => ctrl.handle });
  await c.connect();
  const run = c.startRun({ messages: [], profile: "coder", executionId: "exec_cancel" });
  await flushMicrotasks();

  let acknowledged = false;
  const cancellation = run.cancel().then(() => {
    acknowledged = true;
  });
  await flushMicrotasks();
  expect(acknowledged).toBe(false);
  acknowledge();
  await cancellation;
  expect(acknowledged).toBe(true);

  ctrl.settle({ execution_id: "exec_cancel", status: "cancelled" });
  ctrl.close();
  await run.done;
});

test("compact routes the optional request through the unified runs service", async () => {
  const ctrl = controllableHandle("exec_compact");
  const calls: [string, string | undefined][] = [];
  const { c } = client({
    start: async () => ctrl.handle,
    compact: async (id, request) => {
      calls.push([id, request]);
      return { status: "queued", execution_id: id };
    },
  });
  await c.connect();
  const run = c.startRun({ messages: [], profile: "coder", executionId: "exec_compact" });
  await flushMicrotasks();

  expect(await c.compact({ executionId: "exec_compact" })).toEqual({
    status: "queued",
    execution_id: "exec_compact",
  });
  expect(
    await c.compact({ executionId: "exec_compact", request: "keep auth context" }),
  ).toMatchObject({ status: "queued" });
  expect(calls).toEqual([
    ["exec_compact", undefined],
    ["exec_compact", "keep auth context"],
  ]);

  ctrl.settle({ execution_id: "exec_compact", status: "completed" });
  ctrl.close();
  await run.done;
});

test("elicitation bridges request→UI→respond", async () => {
  const ctrl = controllableHandle("exec_3");
  let askedMessage = "";
  const { c } = client(
    { start: async () => ctrl.handle },
    {
      onElicit: async (params) => {
        askedMessage = (params as { message: string }).message;
        return { action: "accept", content: { answer: "yes" } };
      },
    },
  );
  await c.connect();
  const handle = c.startRun({ messages: [], profile: "coder" });
  await flushMicrotasks();

  ctrl.fireElicit({
    id: "exec_3:elicit:0",
    execution_id: "exec_3",
    kind: "ask_user",
    prompt: "Deploy to prod?",
  });
  await flushMicrotasks();

  expect(askedMessage).toBe("Deploy to prod?");
  expect(ctrl.responded).toEqual([
    { id: "exec_3:elicit:0", action: "accept", content: { answer: "yes" } },
  ]);

  ctrl.settle({ execution_id: "exec_3", status: "completed" });
  ctrl.close();
  await handle.done;
});

test("an elicit handler that throws answers cancel, and leaves a record saying so", async () => {
  const ctrl = controllableHandle("exec_e");
  const { c } = client(
    { start: async () => ctrl.handle },
    {
      onElicit: () => {
        throw new Error("the overlay was already disposed");
      },
    },
  );
  await c.connect();
  const handle = c.startRun({ messages: [], profile: "coder" });
  await flushMicrotasks();

  const recording = recordDiagnostics();
  try {
    ctrl.fireElicit({
      id: "exec_e:elicit:0",
      execution_id: "exec_e",
      kind: "ask_user",
      prompt: "Deploy to prod?",
    });
    await flushMicrotasks();
  } finally {
    recording.uninstall();
  }

  expect(ctrl.responded).toEqual([{ id: "exec_e:elicit:0", action: "cancel" }]);
  expect(recording.first("elicit.handler.failed")?.level).toBe("warn");

  ctrl.settle({ execution_id: "exec_e", status: "completed" });
  ctrl.close();
  await handle.done;
});

test("an event stream that throws mid-iteration is recorded, not swallowed", async () => {
  const ctrl = controllableHandle("exec_s");
  const broken = {
    ...ctrl.handle,
    events: {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<RunEvent> {
        yield { type: "run_started", at: 0, lead_model: "m" };
        throw new Error("transport closed mid-stream");
      },
    },
  };
  const { c } = client({ start: async () => broken });
  await c.connect();
  const recording = recordDiagnostics();
  let handle;
  try {
    handle = c.startRun({ messages: [], profile: "coder", executionId: "exec_s" });
    await flushMicrotasks();
    ctrl.settle({ execution_id: "exec_s", status: "completed" });
    ctrl.close();
    await handle.done;
    await handle.closed;
  } finally {
    recording.uninstall();
  }

  expect(recording.first("run.stream.interrupted")).toMatchObject({
    level: "warn",
    details: { execution_id: "exec_s" },
  });
});

test("a lifecycle closure that rejects is recorded rather than escaping a finally", async () => {
  const ctrl = controllableHandle("exec_c");
  const broken = { ...ctrl.handle, closed: Promise.reject(new Error("teardown refused")) };
  const { c } = client({ start: async () => broken });
  await c.connect();
  const recording = recordDiagnostics();
  try {
    const handle = c.startRun({ messages: [], profile: "coder", executionId: "exec_c" });
    ctrl.settle({ execution_id: "exec_c", status: "completed" });
    ctrl.close();
    await handle.done;
    await handle.closed;
  } finally {
    recording.uninstall();
  }

  expect(recording.first("run.close.failed")).toMatchObject({
    level: "debug",
    details: { execution_id: "exec_c" },
  });
});

test("a guard_confirm's structured command detail reaches the UI params", async () => {
  const ctrl = controllableHandle("exec_g");
  let seen: unknown;
  const { c } = client(
    { start: async () => ctrl.handle },
    {
      onElicit: async (params) => {
        seen = params;
        return { action: "decline" };
      },
    },
  );
  await c.connect();
  const handle = c.startRun({ messages: [], profile: "coder" });
  await flushMicrotasks();

  ctrl.fireElicit({
    id: "exec_g:elicit:0",
    execution_id: "exec_g",
    kind: "guard_confirm",
    prompt: "Allow `rm -rf dist`?",
    detail: { command: "rm -rf dist", cwd: "/ws", reason: "no allowed commands list configured" },
  });
  await flushMicrotasks();

  expect(seen).toMatchObject({
    kind: "guard_confirm",
    detail: { command: "rm -rf dist", cwd: "/ws", reason: "no allowed commands list configured" },
  });

  ctrl.settle({ execution_id: "exec_g", status: "completed" });
  ctrl.close();
  await handle.done;
});

test("getRun maps a stored run and returns null on not_found", async () => {
  const detail: RunDetail = {
    execution_id: "exec_4",
    status: "completed",
    created_at: 1,
    ended_at: 2,
    messages: [],
    events: [],
  };
  const { c } = client({ get: (id) => (id === "exec_4" ? detail : null) });
  await c.connect();
  expect(await c.getRun("exec_4")).toEqual(detail);
  expect(await c.getRun("missing")).toBeNull();
});

test("deleteRun reports whether the run existed", async () => {
  const { c } = client({ del: (id) => id === "exec_5" });
  await c.connect();
  expect(await c.deleteRun("exec_5")).toBe(true);
  expect(await c.deleteRun("gone")).toBe(false);
});

test("transported not_found errors are classified structurally", async () => {
  const remote = Object.assign(new Error("not found over stdio"), { code: "not_found" });
  const { c } = client({ getError: remote, deleteError: remote });
  await c.connect();
  expect(await c.getRun("missing")).toBeNull();
  expect(await c.deleteRun("missing")).toBe(false);
});

test("listProfiles projects the kernel's agents", async () => {
  const { c } = client({
    agents: [
      { name: "coder", scope: "workspace", model: "m", description: "codes" },
      { name: "answerer", scope: "global" },
    ],
  });
  await c.connect();
  expect(await c.listProfiles()).toEqual([
    { name: "coder", description: "codes", model: "m" },
    { name: "answerer" },
  ]);
});

test("Tasks control-plane methods stay thin pass-throughs to the kernel service", async () => {
  const calls: string[] = [];
  const tasks = new Proxy({} as KernelClient["tasks"], {
    get: (_target, property) => async () => {
      calls.push(String(property));
      return {};
    },
  });
  const { c } = client({ tasks });
  await c.connect();

  await c.tasks.status();
  await c.tasks.capabilities();
  await c.tasks.listContainers({});
  await c.tasks.search({});
  await c.tasks.get({ provider_key: "provider", id: "TASK-1" });
  await c.tasks.searchActors({});
  await c.tasks.create({} as never);
  await c.tasks.assign({} as never);
  await c.tasks.previewTransition({} as never);
  await c.tasks.transition({} as never);
  await c.tasks.comment({} as never);
  await c.tasks.attachArtifact({} as never);

  expect(calls).toEqual([
    "status",
    "capabilities",
    "listContainers",
    "search",
    "get",
    "searchActors",
    "create",
    "assign",
    "previewTransition",
    "transition",
    "comment",
    "attachArtifact",
  ]);
});

test("plugin installs forward the selected inventory target to the kernel", async () => {
  let target: unknown;
  const kernel = Object.assign(fakeKernel({}), {
    plugins: {
      install: async (_url: string, _subdir: string | undefined, input: unknown) => {
        target = input;
        return {} as never;
      },
    } as unknown as KernelClient["plugins"],
  }) as KernelClient;
  const c = createKernelRunClient({
    createKernel: async () => kernel,
    callbacks: { onEvent: () => {} },
  });
  await c.connect();

  await c.plugins.install("https://example.test/plugin.git", undefined, { source: "clarvis" });

  expect(target).toEqual({ source: "clarvis" });
  await c.dispose();
});

test("every non-run control-plane method stays a thin pass-through to its kernel service", async () => {
  const calls: string[] = [];
  const service = (name: string): object =>
    new Proxy(
      {},
      {
        get:
          (_target, property) =>
          (..._args: unknown[]) => {
            calls.push(`${name}.${String(property)}`);
            return Promise.resolve({});
          },
      },
    );
  const kernel = Object.assign(fakeKernel({}), {
    plans: service("plans"),
    workflows: service("workflows"),
    skills: service("skills"),
    config: service("config"),
    secrets: service("secrets"),
    models: service("models"),
    providerAuth: service("providerAuth"),
    files: service("files"),
    sessions: service("sessions"),
    plugins: service("plugins"),
  }) as unknown as KernelClient;
  const c = createKernelRunClient({
    createKernel: async () => kernel,
    callbacks: { onEvent: () => {} },
  });
  await c.connect();

  await Promise.all([
    c.plans.list(),
    c.plans.read("plan"),
    c.plans.setRetention("plan", "keep"),
    c.plans.delete("plan"),
    c.workflows.get("workflow"),
    c.workflows.list(),
    c.workflows.delete("workflow"),
    c.skills.list(),
    c.skills.getPrompt("skill", { task: "args" }),
    c.config.getSettings(),
    c.config.previewSettingsRepair("global"),
    c.config.repairSettings("global", "revision"),
    c.config.updateSettings("global", {}, null),
    c.config.inspectSandbox({} as never),
    c.config.approveWorkspace(),
    c.config.revokeWorkspace(),
    c.config.workspaceTrustError(),
    c.config.listAgents(),
    c.config.getAgent("global", "agent"),
    c.config.writeAgent("global", "agent", {} as never),
    c.config.deleteAgent("global", "agent"),
    c.config.renameAgent("global", "agent", "renamed"),
    c.config.getContext("global"),
    Promise.resolve(c.config.subscribe([], () => {})),
    c.secrets.listNames(),
    c.secrets.set("KEY", "value"),
    c.secrets.delete("KEY"),
    c.models.get(),
    c.models.refresh(),
    c.models.getEntitled("openai-codex"),
    c.models.refreshEntitled("openai-codex"),
    c.providerAuth.list(),
    c.providerAuth.startDevice("openai-codex"),
    c.providerAuth.wait("attempt"),
    c.providerAuth.cancel("attempt"),
    c.providerAuth.disconnect("openai-codex"),
    c.files.listFiles({} as never),
    c.files.readFile("README.md"),
    c.files.readImage("image.png"),
    c.sessions.listPage(),
    c.sessions.list(),
    c.sessions.get("session"),
    c.sessions.save({} as never),
    c.sessions.delete("session"),
    c.plugins.list(),
    c.plugins.install("https://example.com/plugin.git"),
    c.plugins.update({ scope: "global", source: "clarvis", name: "plugin" }),
    c.plugins.uninstall({ scope: "global", source: "clarvis", name: "plugin" }),
    c.plugins.hooks(),
    c.plugins.approveHook({ scope: "global", source: "clarvis", name: "plugin" }, "fingerprint"),
    c.plugins.revokeHook({ scope: "global", source: "clarvis", name: "plugin" }, "fingerprint"),
  ]);
  expect(c.project).toBe(kernel.project);
  expect(c.workspace).toBe(kernel.workspace);
  expect(calls).toHaveLength(51);
  await c.dispose();
});

test("reconnect evicts the released host kernel before opening a replacement", async () => {
  const order: string[] = [];
  let generation = 0;
  const callbacks: KernelRunClientCallbacks = { onEvent: () => {} };
  const c = createKernelRunClient({
    createKernel: async () => {
      const current = ++generation;
      order.push(`create:${current}`);
      return {
        ...fakeKernel({}),
        close: async () => void order.push(`close:${current}`),
      };
    },
    prepareReconnect: async () => void order.push("evict"),
    callbacks,
  });

  await c.connect();
  await c.reconnect();

  expect(order).toEqual(["create:1", "close:1", "evict", "create:2"]);
  await c.dispose();
});

test("capabilities stays readable while reconnect is between kernels", async () => {
  let release!: () => void;
  const replacement = new Promise<void>((r) => (release = r));
  let builds = 0;
  const c = createKernelRunClient({
    createKernel: async () => {
      if (builds++ > 0) await replacement;
      return fakeKernel({ capabilities: { tasks: true } });
    },
    callbacks: { onEvent: () => {} },
  });

  await c.connect();
  expect(c.capabilities.tasks).toBe(true);

  const reconnecting = c.reconnect();
  await flushMicrotasks();

  expect(() => c.capabilities).not.toThrow();
  expect(c.capabilities).toMatchObject({ tasks: true });

  release();
  await reconnecting;
  expect(c.capabilities).toMatchObject({ tasks: true });
  await c.dispose();
});

test("capabilities still refuses before the first connect", () => {
  const { c } = client({ capabilities: { tasks: true } });
  expect(() => c.capabilities).toThrow("kernel run client is not connected");
});
