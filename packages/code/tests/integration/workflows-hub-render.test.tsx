import { expect, test } from "bun:test";
import { createSignal, type Accessor } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type {
  Page,
  RunDetail,
  WorkflowDetail,
  WorkflowNode,
  WorkflowSummary,
} from "@clarvis/protocol";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { WorkflowsHub, type WorkflowsHubDeps } from "../../src/views/config/WorkflowsHub.tsx";
import type { WorkflowActivity } from "../../src/adapters/workflow-projection.ts";
import { captureUntil } from "../helpers/render-support.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const fakeKeymap = createFakeKeymap;

function summary(over: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    execution_id: "wf-1",
    status: "completed",
    title: "refactor the widgets",
    created_at: 900_000,
    updated_at: 900_000,
    leader_count: 2,
    ...over,
  };
}

function node(over: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    run_id: "run-1",
    kind: "manager",
    title: "manager",
    status: "completed",
    ...over,
  };
}

function detail(over: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    ...summary(),
    nodes: [
      node({ run_id: "run-1", kind: "manager", title: "manager" }),
      node({
        run_id: "run-2",
        kind: "leader",
        title: "Review authentication",
        task: "Inspect the complete authentication flow.\nReport concrete risks and file references.",
        profile: "coder",
      }),
    ],
    ...over,
  };
}

function runDetail(over: Partial<RunDetail> = {}): RunDetail {
  return {
    execution_id: "run-1",
    status: "completed",
    created_at: 0,
    messages: [],
    events: [],
    ...over,
  };
}

function mount(opts: {
  rows?: WorkflowSummary[];
  listError?: boolean;
  get?: (id: string) => Promise<WorkflowDetail>;
  getRun?: (id: string) => Promise<RunDetail | null>;
  list?: WorkflowsHubDeps["list"];
  live?: () => WorkflowActivity | null;
  openAgentPicker?: () => void;
  pollMs?: number;
  refreshSlowMs?: number;
  del?: (id: string) => Promise<void>;
  withDelete?: boolean;
  active?: Accessor<boolean>;
}) {
  const { keymap, press } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
    ...(opts.active === undefined ? {} : { active: opts.active }),
  });
  const listCalls: number[] = [];
  const deletedIds: string[] = [];
  const deps: WorkflowsHubDeps = {
    list: () => {
      listCalls.push(1);
      if (opts.list) return opts.list();
      if (opts.listError) return Promise.reject(new Error("kernel unreachable"));
      const rows = opts.rows ?? [];
      const page: Page<WorkflowSummary> = {
        items: rows,
        total: rows.length,
        limit: 20,
        offset: 0,
      };
      return Promise.resolve(page);
    },
    get: opts.get ?? ((id: string) => Promise.resolve(detail({ execution_id: id }))),
    getRun: opts.getRun ?? (() => Promise.resolve(runDetail())),
    now: () => 1_000_000,
    ...(opts.live ? { live: opts.live } : {}),
    ...(opts.openAgentPicker ? { openAgentPicker: opts.openAgentPicker } : {}),
    ...(opts.pollMs === undefined ? {} : { pollMs: opts.pollMs }),
    ...(opts.refreshSlowMs === undefined ? {} : { refreshSlowMs: opts.refreshSlowMs }),
    ...(opts.withDelete
      ? {
          delete:
            opts.del ??
            (async (id: string) => {
              deletedIds.push(id);
            }),
        }
      : {}),
  };
  return { host, press, deps, listCalls, deletedIds };
}

test("renders the workflow list rows with status, leader count and relative time", async () => {
  const { host, deps } = mount({
    rows: [
      summary({ execution_id: "wf-1", title: "refactor the widgets", status: "completed" }),
      summary({ execution_id: "wf-2", title: "", status: "running", leader_count: 0 }),
    ],
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Workflows");
  expect(frame).toContain("refactor the widgets");
  expect(frame).toContain("wf-2");
  expect(frame).toContain("2 agents");
  expect(frame).toContain("Completed");
  expect(frame).toContain("Running");
  t.renderer.destroy();
});

test("no workflows yet shows the empty hint", async () => {
  const { host, deps } = mount({ rows: [] });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("no workflows yet");
  expect(frame).toContain("choose a workflow-enabled agent");
  expect(frame).not.toContain("[↵] open");
  expect(frame).not.toContain("[d] delete");
  t.renderer.destroy();
});

test("a failed initial list load is visible rather than looking like an empty history", async () => {
  const { host, deps } = mount({ listError: true });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Refresh failed: kernel unreachable");
  expect(frame).toContain("no workflows yet");
  t.renderer.destroy();
});

test("a failed refresh keeps the last good workflow list on screen", async () => {
  let calls = 0;
  const { host, press, deps } = mount({
    list: () => {
      calls += 1;
      if (calls > 1) return Promise.reject(new Error("temporarily offline"));
      const item = summary();
      return Promise.resolve({ items: [item], total: 1, limit: 20, offset: 0 });
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await captureUntil(t, "refactor the widgets");
  press("r");
  const frame = await captureUntil(t, "Refresh failed: temporarily offline");
  expect(frame).toContain("refactor the widgets");
  t.renderer.destroy();
});

test("a running workflow list polls until persisted state catches up", async () => {
  let calls = 0;
  const { host, deps } = mount({
    pollMs: 5,
    list: () => {
      calls += 1;
      const item = summary({ status: calls === 1 ? "running" : "completed" });
      return Promise.resolve({ items: [item], total: 1, limit: 20, offset: 0 });
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const frame = await captureUntil(t, "Completed");
  expect(calls).toBeGreaterThan(1);
  expect(frame).toContain("Updated 0s ago");
  t.renderer.destroy();
});

test("a retained workflow page pauses polling while inactive", async () => {
  const [active, setActive] = createSignal(true);
  let calls = 0;
  const { host, deps } = mount({
    active,
    pollMs: 5,
    list: () => {
      calls += 1;
      const item = summary({ status: "running" });
      return Promise.resolve({ items: [item], total: 1, limit: 20, offset: 0 });
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await captureUntil(t, "Running");
  setActive(false);
  await tick();
  const inactiveCalls = calls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toBe(inactiveCalls);

  setActive(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBeGreaterThan(inactiveCalls);
  t.renderer.destroy();
});

test("slow workflow polling is single-flight and coalesces ticks into one trailing refresh", async () => {
  type ResolvePage = (page: Page<WorkflowSummary>) => void;
  const pending: ResolvePage[] = [];
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const runningPage = (): Page<WorkflowSummary> => ({
    items: [summary({ status: "running" })],
    total: 1,
    limit: 20,
    offset: 0,
  });
  const { host, deps } = mount({
    pollMs: 2,
    list: () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(runningPage());
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<Page<WorkflowSummary>>((resolve) => {
        pending.push((page) => {
          active -= 1;
          resolve(page);
        });
      });
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await captureUntil(t, "Running");
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(calls).toBe(2);
  expect(active).toBe(1);
  expect(maxActive).toBe(1);

  pending.shift()?.(runningPage());
  await tick();
  expect(calls).toBe(3);
  expect(active).toBe(1);
  expect(maxActive).toBe(1);

  t.renderer.destroy();
  pending.shift()?.(runningPage());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBe(3);
  expect(active).toBe(0);
});

test("a refresh that never settles stays one physical request and becomes visible", async () => {
  let calls = 0;
  const { host, deps } = mount({
    pollMs: 2,
    refreshSlowMs: 5,
    list: () => {
      calls += 1;
      if (calls === 1) {
        const item = summary({ status: "running" });
        return Promise.resolve({ items: [item], total: 1, limit: 20, offset: 0 });
      }
      return new Promise<Page<WorkflowSummary>>(() => {});
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await captureUntil(t, "Running");
  const frame = await captureUntil(t, "Refresh is still pending");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(frame).toContain("backend may be unavailable");
  expect(calls).toBe(2);
  t.renderer.destroy();
});

test("the empty state offers the agent picker as a concrete next action", async () => {
  let opens = 0;
  const { host, press, deps } = mount({
    rows: [],
    openAgentPicker: () => {
      opens += 1;
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await captureUntil(t, "choose agent");
  press("a");
  expect(opens).toBe(1);
  t.renderer.destroy();
});

test("[r] refreshes the list", async () => {
  const { host, press, deps, listCalls } = mount({ rows: [summary()] });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  expect(listCalls.length).toBe(1);
  press("r");
  await tick();
  await t.renderOnce();
  expect(listCalls.length).toBe(2);
  t.renderer.destroy();
});

test("activating the selected workflow opens its tree of nodes", async () => {
  const { host, press, deps } = mount({ rows: [summary({ execution_id: "wf-1" })] });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  const frame = await captureUntil(t, "Review authentication");
  expect(frame).toContain("Review authentication");
  expect(frame).toContain("coder");
  expect(frame).toContain("Workflow");
  t.renderer.destroy();
});

test("repeated activation keeps one physical workflow detail request", async () => {
  let calls = 0;
  let resolveDetail!: (value: WorkflowDetail) => void;
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    get: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveDetail = resolve;
      });
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await captureUntil(t, "refactor the widgets");
  for (let index = 0; index < 1_000; index += 1) press("return");
  expect(calls).toBe(1);
  resolveDetail(detail());
  await captureUntil(t, "Review authentication");
  expect(calls).toBe(1);
  t.renderer.destroy();
});

test("the tree merges live leaders and exposes their round, item, and replica context", async () => {
  const live: WorkflowActivity = {
    root: "wf-1",
    nodes: new Map([
      ["wf-1", { runId: "wf-1", kind: "manager", title: "manager", status: "running" }],
      [
        "live-2",
        {
          runId: "live-2",
          parentRunId: "wf-1",
          kind: "leader",
          title: "Verify the login flow",
          profile: "reviewer",
          status: "running",
          startedAt: 999_000,
          roundId: "verify",
          pass: 0,
          itemIndex: 0,
          replica: 1,
          replicaCount: 3,
        },
      ],
    ]),
  };
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1", status: "running" })],
    get: () =>
      Promise.resolve(
        detail({
          execution_id: "wf-1",
          status: "running",
          nodes: [node({ run_id: "wf-1", status: "running" })],
        }),
      ),
    live: () => live,
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 80, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "Verify the login flow");
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("round verify · pass 1 · item 1 · replica 2/3");
  expect(frame).toContain("Running");
  t.renderer.destroy();
});

test("the 80-column workflow tree stacks metadata and keeps Back visible", async () => {
  const { host, press, deps } = mount({ rows: [summary({ execution_id: "wf-1" })] });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, {
    width: 80,
    height: 24,
  });
  await tick();
  await t.renderOnce();
  press("return");
  const frame = await captureUntil(t, "Review authentication");
  expect(frame).toContain("manager · Completed");
  expect(frame).not.toContain("managerCompleted");
  expect(frame).toContain("[esc] back");
  t.renderer.destroy();
});

test("a workflow with no spawned nodes shows the tree's empty hint", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    get: () => Promise.resolve(detail({ nodes: [] })),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  const frame = await captureUntil(t, "no nodes");
  expect(frame).toContain("the manager has not spawned agents");
  t.renderer.destroy();
});

test("Escape backs out of the tree to the list and reloads it", async () => {
  const { host, press, deps, listCalls } = mount({ rows: [summary({ execution_id: "wf-1" })] });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  expect(listCalls.length).toBe(1);
  press("escape");
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Workflows");
  expect(listCalls.length).toBe(2);
  t.renderer.destroy();
});

test("opening a node shows loading, then the run's result and usage", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () =>
      Promise.resolve(
        runDetail({
          result: {
            execution_id: "run-1",
            status: "completed",
            result: "all done",
            usage: { iterations: 3, elapsed_ms: 1000, input_tokens: 100, output_tokens: 50 },
          },
        }),
      ),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  const frame = await captureUntil(t, "all done");
  expect(frame).toContain("Manager · manager · Completed");
  expect(frame).toContain("3 iterations");
  expect(frame).toContain("100");
  expect(frame).toContain("50");
  t.renderer.destroy();
});

test("a node whose run has not resolved yet shows the loading placeholder", async () => {
  let resolveRun: ((run: RunDetail | null) => void) | undefined;
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    get: () =>
      Promise.resolve(
        detail({ nodes: [node({ run_id: "run-1", kind: "manager", status: "running" })] }),
      ),
    getRun: () =>
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  expect(await captureUntil(t, "Agent is running. This view refreshes automatically")).toContain(
    "Agent is running. This view refreshes automatically",
  );
  resolveRun?.(runDetail({ result: { execution_id: "run-1", status: "completed", result: "ok" } }));
  const frame = await captureUntil(t, "ok");
  expect(frame).toContain("ok");
  t.renderer.destroy();
});

test("a run with no result recorded says so explicitly", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () => Promise.resolve(runDetail({ result: undefined })),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  const frame = await captureUntil(t, "(no result recorded)");
  expect(frame).toContain("(no result recorded)");
  t.renderer.destroy();
});

test("an errored run's result shows the error message", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () =>
      Promise.resolve(
        runDetail({
          status: "failed",
          result: {
            execution_id: "run-1",
            status: "failed",
            error: { code: "budget", message: "ran out of budget" },
          },
        }),
      ),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  const frame = await captureUntil(t, "ran out of budget");
  expect(frame).toContain("error: ran out of budget");
  t.renderer.destroy();
});

test("a structured result with a text field renders that text", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () =>
      Promise.resolve(
        runDetail({
          result: {
            execution_id: "run-1",
            status: "completed",
            result: { text: "structured text body", other: 1 },
          },
        }),
      ),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  const frame = await captureUntil(t, "structured text body");
  expect(frame).toContain("structured text body");
  t.renderer.destroy();
});

test("a plain-object result with no text field renders as a structured card", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () =>
      Promise.resolve(
        runDetail({
          result: {
            execution_id: "run-1",
            status: "completed",
            result: { count: 7 },
          },
        }),
      ),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  const frame = await captureUntil(t, "Structured result");
  expect(frame).toContain("Count:");
  expect(frame).toContain("7");
  expect(frame).not.toContain('{"count":7}');
  t.renderer.destroy();
});

test("a JSON-encoded workflow answer renders headings and wrapped fields instead of a raw line", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () =>
      Promise.resolve(
        runDetail({
          result: {
            execution_id: "run-1",
            status: "completed",
            result: JSON.stringify({
              scope: "Full workspace audit",
              findings: [
                {
                  id: "F01",
                  title: "Event triggers all valid",
                  claim: "Every trigger points to a known event",
                },
              ],
            }),
          },
        }),
      ),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  const frame = await captureUntil(t, "Event triggers all valid");
  expect(frame).toContain("Structured result");
  expect(frame).toContain("Scope:");
  expect(frame).toContain("Findings");
  expect(frame).toContain("Claim:");
  expect(frame).not.toContain('{"scope"');
  t.renderer.destroy();
});

test("a result that cannot be JSON-stringified renders a fallback message", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () =>
      Promise.resolve(
        runDetail({
          result: { execution_id: "run-1", status: "completed", result: circular },
        }),
      ),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  const frame = await captureUntil(t, "(unserializable result)");
  expect(frame).toContain("(unserializable result)");
  t.renderer.destroy();
});

test("usage with no token counts omits the token segment", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () =>
      Promise.resolve(
        runDetail({
          result: {
            execution_id: "run-1",
            status: "completed",
            result: "done",
            usage: { iterations: 5, elapsed_ms: 200 },
          },
        }),
      ),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  const frame = await captureUntil(t, "5 iterations");
  expect(frame).toContain("5 iterations");
  expect(frame).not.toContain("tok");
  t.renderer.destroy();
});

test("Escape from the node view returns to the tree", async () => {
  const { host, press, deps } = mount({ rows: [summary({ execution_id: "wf-1" })] });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "manager");
  press("return");
  await captureUntil(t, "(no result recorded)");
  press("escape");
  const frame = await captureUntil(t, "Review authentication");
  expect(frame).not.toContain("(no result recorded)");
  t.renderer.destroy();
});

test("[t] opens the selected leader's complete task without fetching its result", async () => {
  let runFetches = 0;
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () => {
      runFetches += 1;
      return Promise.resolve(runDetail());
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "Review authentication");
  press("down");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("open task");
  press("t");
  const frame = await captureUntil(t, "Inspect the complete authentication flow.");
  expect(frame).toContain("Report concrete risks and file references.");
  expect(frame).toContain("Task");
  expect(runFetches).toBe(0);
  press("escape");
  await t.renderOnce();
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("Inspect the complete authentication flow.");
  t.renderer.destroy();
});

test("[t] is unavailable for the manager and legacy leaders without a task", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    get: () =>
      Promise.resolve(
        detail({
          nodes: [
            node({ run_id: "run-1", kind: "manager", title: "manager" }),
            node({ run_id: "run-2", kind: "leader", title: "Legacy leader" }),
          ],
        }),
      ),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await tick();
  await t.renderOnce();
  press("return");
  await captureUntil(t, "Legacy leader");
  press("t");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("Task unavailable");
  press("down");
  press("t");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("Task unavailable");
  t.renderer.destroy();
});

test("without a delete dependency, [d] is not bound", async () => {
  const { host, press, deps } = mount({ rows: [summary({ execution_id: "wf-1" })] });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("d");
  expect(host.pendingConfirm()).toBeNull();
  t.renderer.destroy();
});

test("[d] asks for confirmation, naming the workflow, before deleting", async () => {
  const { host, press, deps, deletedIds } = mount({
    rows: [summary({ execution_id: "wf-1", title: "refactor the widgets" })],
    withDelete: true,
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("d");
  expect(host.pendingConfirm()?.message).toContain("refactor the widgets");
  expect(deletedIds).toEqual([]);
  t.renderer.destroy();
});

test("confirming the delete removes the workflow and reloads the list", async () => {
  const { host, press, deps, deletedIds, listCalls } = mount({
    rows: [summary({ execution_id: "wf-1", title: "refactor the widgets" })],
    withDelete: true,
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("d");
  press("y");
  await tick();
  await t.renderOnce();
  expect(deletedIds).toEqual(["wf-1"]);
  expect(listCalls.length).toBe(2);
  t.renderer.destroy();
});

test("deleting with no row selected is a no-op", async () => {
  const { host, press, deps, deletedIds } = mount({ rows: [], withDelete: true });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("d");
  expect(host.pendingConfirm()).toBeNull();
  expect(deletedIds).toEqual([]);
  t.renderer.destroy();
});

test("opening a workflow with no row selected is a no-op", async () => {
  const { host, press, deps } = mount({ rows: [] });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await tick();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("no workflows yet");
  t.renderer.destroy();
});

test("a failed workflow.get leaves the list open rather than crashing", async () => {
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    get: () => Promise.reject(new Error("boom")),
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, { width: 110, height: 24 });
  await tick();
  await t.renderOnce();
  press("return");
  await tick();
  await tick();
  await t.renderOnce();
  const frame = await captureUntil(t, "Refresh failed: boom");
  expect(frame).toContain("Workflows");
  expect(frame).toContain("refactor the widgets");
  t.renderer.destroy();
});

test("a failed tree refresh preserves the open tree and reports the stale state", async () => {
  let calls = 0;
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    get: () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(detail())
        : Promise.reject(new Error("tree temporarily unavailable"));
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await captureUntil(t, "refactor the widgets");
  press("return");
  await captureUntil(t, "Review authentication");
  press("r");
  const frame = await captureUntil(t, "Refresh failed: tree temporarily unavailable");
  expect(frame).toContain("Review authentication");
  t.renderer.destroy();
});

test("a failed node refresh preserves the result and exposes the refresh error", async () => {
  let calls = 0;
  const { host, press, deps } = mount({
    rows: [summary({ execution_id: "wf-1" })],
    getRun: () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(
            runDetail({
              result: { execution_id: "run-1", status: "completed", result: "stable result" },
            }),
          )
        : Promise.reject(new Error("run detail temporarily unavailable"));
    },
  });
  const t = await openRender((() => WorkflowsHub(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await captureUntil(t, "refactor the widgets");
  press("return");
  await captureUntil(t, "manager");
  press("return");
  await captureUntil(t, "stable result");
  press("r");
  const frame = await captureUntil(t, "Refresh failed: run detail temporarily unavailable");
  expect(frame).toContain("stable result");
  t.renderer.destroy();
});
