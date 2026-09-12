import { expect, test } from "bun:test";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createSignal } from "solid-js";
import { createMutable } from "solid-js/store";
import { MouseEvent, type Renderable, type ScrollBoxRenderable } from "@opentui/core";
import { TranscriptRegion } from "../../src/views/app/TranscriptRegion.tsx";
import { createTranscriptState } from "../../src/views/transcript-state.ts";
import type {
  TranscriptRegionLayout,
  TranscriptRegionProps,
  TranscriptRegionRun,
} from "../../src/views/app/TranscriptRegion.tsx";
import type { TranscriptStore, TranscriptNode } from "../../src/adapters/store.ts";
import type { ActivityStore } from "../../src/adapters/activity-store.ts";
import type { ElicitRequestParams, ElicitResult } from "../../src/adapters/elicit-types.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { LayoutMode } from "../../src/app/layout.ts";
import type { WorkflowActivity } from "../../src/adapters/workflow-projection.ts";
import type { FoldFixtureToolNode } from "../helpers/transcript-fixtures.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import type { TranscriptViewportHandle } from "../../src/views/transcript/TranscriptViewport.tsx";

function renderableCount(root: Renderable): number {
  return 1 + root.getChildren().reduce((count, child) => count + renderableCount(child), 0);
}

function renderableByNumber(root: Renderable, number: number): Renderable | undefined {
  if (root.num === number) return root;
  for (const child of root.getChildren()) {
    const found = renderableByNumber(child, number);
    if (found !== undefined) return found;
  }
  return undefined;
}

function fakeInteraction(): { interaction: Interaction; press: (key: string) => void } {
  const { keymap, press } = createFakeKeymap();
  return {
    interaction: {
      keymap,
      pushOverlayContext: () => {},
      popOverlayContext: () => {},
      syncContext: () => {},
    } as unknown as Interaction,
    press,
  };
}

function activity(over: Partial<ActivityStore> = {}): ActivityStore {
  return createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
    ...over,
  }) as unknown as ActivityStore;
}

function store(
  nodes: TranscriptNode[],
  defaultFolded: (key: string) => boolean = () => false,
): TranscriptStore {
  return {
    nodes,
    frontierNodes: () => [],
    committedNodes: () => nodes,
    defaultFolded,
  } as unknown as TranscriptStore;
}

function layout(over: Partial<TranscriptRegionLayout> = {}): TranscriptRegionLayout {
  return {
    mode: () => "wide" as LayoutMode,
    sidebarVisible: () => false,
    sidebarWidth: () => 28,
    drawerOpen: () => false,
    contentInset: () => 0,
    width: () => 120,
    height: () => 34,
    ...over,
  };
}

function run(over: Partial<TranscriptRegionRun> = {}): TranscriptRegionRun {
  return {
    elicit: () => null,
    resolveElicit: () => {},
    workflowActivity: () => null,
    ...over,
  };
}

let seq = 0;
function toolNode(over: Partial<FoldFixtureToolNode> = {}): FoldFixtureToolNode {
  return {
    key: `n${seq++}`,
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName: "",
    toolName: "edit_file",
    args: { path: "a.ts", old_string: "one", new_string: "ONE" },
    result: "Replaced 1 occurrence in a.ts.",
    error: null,
    collapsed: false,
    ...over,
  };
}

function baseProps(overrides: Partial<TranscriptRegionProps> = {}): TranscriptRegionProps {
  const nodes = overrides.store?.nodes ?? [];
  const s = overrides.store ?? store(nodes);
  const a = overrides.activity ?? activity();
  const ts =
    overrides.transcript ??
    createTranscriptState({
      nodes: () => s.nodes,
      subagents: () =>
        a.subagents.map((w) => ({
          id: w.id,
          order: w.order,
          title: w.title,
          status: w.status === "done" ? "ok" : w.status === "error" ? "error" : "running",
        })),
      notify: () => {},
      defaultFolded: (key) => s.defaultFolded(key),
    });
  return {
    store: s,
    transcript: ts,
    activity: a,
    interaction: overrides.interaction ?? fakeInteraction().interaction,
    run: overrides.run ?? run(),
    layout: overrides.layout ?? layout(),
    active: overrides.active,
    contextWindow: overrides.contextWindow ?? (() => 1_024_000),
    agent: overrides.agent ?? (() => "coder"),
    model: overrides.model ?? (() => "z-ai/glm-5.2"),
    notify: overrides.notify ?? (() => {}),
    openPlan: overrides.openPlan ?? (() => {}),
    onOpenDetail: overrides.onOpenDetail,
    onScrollbox: overrides.onScrollbox ?? (() => {}),
    onHistoryHandle: overrides.onHistoryHandle,
  };
}

async function mount(
  props: TranscriptRegionProps,
  width = 120,
  height = 34,
): Promise<TestRendererSetup> {
  const t = await openRender(() => <TranscriptRegion {...props} />, { width, height });
  await settleSyntaxSurfaces(t);
  return t;
}

test("with no nodes and no elicitation, the splash screen renders", async () => {
  const t = await mount(baseProps());
  const out = t.captureCharFrame();
  expect(out).toContain("coder");
  expect(out).toContain("z-ai/glm-5.2");
  t.renderer.destroy();
});

test("a current plan stays out of the transcript tail when the sidebar is closed", async () => {
  const nodes = [toolNode()];
  const plan: TranscriptNode = {
    key: "exec-live-plan::plan",
    kind: "plan",
    status: "running",
    text: ".clarvis/plans/live-plan.md",
    planTitle: "Keep history still",
    planStatus: "active",
    revision: 1,
    tasks: [{ id: "task-1", title: "Measure the physical window", status: "in_progress" }],
  };
  const committed = store(nodes);
  const liveStore = {
    ...committed,
    nodes: [...nodes, plan],
    frontierNodes: () => [plan],
  } as TranscriptStore;
  const t = await mount(
    baseProps({
      store: liveStore,
      activity: activity({
        plan: {
          id: "live-plan",
          title: "Keep history still",
          status: "active",
          retention: "keep",
          revision: 1,
          spec_revision: 1,
          tasks: [{ id: "task-1", title: "Measure the physical window", status: "in_progress" }],
        },
      }),
    }),
  );
  const out = t.captureCharFrame();
  expect(out).not.toContain("Plan 0/1");
  expect(out).not.toContain("Measure the physical window");
  t.renderer.destroy();
});

test("the physical reading runway uses fixed normal and compact height bands", async () => {
  const tall = await mount(
    baseProps({
      store: store([toolNode()]),
      layout: layout({ height: () => 34 }),
    }),
    120,
    34,
  );
  const tallRunway = tall.renderer.root.findDescendantById("transcript-reading-runway");
  expect(tallRunway).toBeDefined();
  expect(tallRunway!.height).toBe(3);
  expect(
    tall.renderer.root
      .findDescendantById("transcript-viewport")
      ?.findDescendantById("transcript-reading-runway"),
  ).toBe(tallRunway);
  tall.renderer.destroy();

  const compact = await mount(
    baseProps({
      store: store([toolNode()]),
      layout: layout({ mode: () => "single", width: () => 64, height: () => 24 }),
    }),
    64,
    24,
  );
  const compactRunway = compact.renderer.root.findDescendantById("transcript-reading-runway");
  expect(compactRunway).toBeDefined();
  expect(compactRunway!.height).toBe(1);
  compact.renderer.destroy();
});

test("workflow activity never enters or moves the main transcript", async () => {
  const live: TranscriptNode = {
    key: "live::msg",
    kind: "assistant",
    status: "running",
    text: "STREAMING ANCHOR",
  };
  const liveStore = {
    nodes: [live],
    frontierNodes: () => [live],
    committedNodes: () => [],
    defaultFolded: () => false,
  } as unknown as TranscriptStore;
  const [workflow, setWorkflow] = createSignal<WorkflowActivity | null>(null);
  const t = await mount(
    baseProps({
      store: liveStore,
      run: run({ workflowActivity: workflow }),
    }),
  );
  const beforeRows = t.captureCharFrame().split("\n");
  const before = beforeRows.findIndex((row) => row.includes("STREAMING ANCHOR"));
  expect(before).toBeGreaterThanOrEqual(0);

  setWorkflow({
    root: "manager",
    nodes: new Map([
      ["leader", { runId: "leader", kind: "leader", title: "verify", status: "running" }],
    ]),
  });
  await t.renderOnce();
  const afterRows = t.captureCharFrame().split("\n");
  const after = afterRows.findIndex((row) => row.includes("STREAMING ANCHOR"));
  expect(after).toBe(before);
  expect(afterRows.join("\n")).not.toContain("workflow leader active");
  t.renderer.destroy();
});

test("once nodes exist, the splash disappears in favor of the transcript", async () => {
  const nodes = [toolNode()];
  const t = await mount(baseProps({ store: store(nodes) }));
  const out = t.captureCharFrame();
  expect(out).toContain("ONE");
  expect(out).not.toContain("z-ai/glm-5.2");
  t.renderer.destroy();
});

test("an active elicitation suppresses the splash even with an empty transcript", async () => {
  const request: ElicitRequestParams = { message: "proceed with the risky command?" };
  const t = await mount(baseProps({ run: run({ elicit: () => request }) }));
  const out = t.captureCharFrame();
  expect(out).toContain("proceed with the risky command?");
  expect(out).not.toContain("z-ai/glm-5.2");
  t.renderer.destroy();
});

test("a full-region cover pauses interaction without destroying the transcript projection", async () => {
  const request: ElicitRequestParams = { message: "covered elicitation must be inert" };
  const node = toolNode();
  const [active, setActive] = createSignal(true);
  let scrollbox: ScrollBoxRenderable | undefined;
  let history: TranscriptViewportHandle | undefined;
  const props = baseProps({
    store: store([node]),
    active,
    run: run({ elicit: () => request }),
    onScrollbox: (value) => (scrollbox = value),
    onHistoryHandle: (value) => (history = value),
  });
  const t = await mount(props);
  const retainedScrollbox = scrollbox;
  const retainedHistory = history;
  expect(t.captureCharFrame()).toContain("covered elicitation must be inert");
  expect(retainedScrollbox).toBeDefined();
  expect(retainedHistory).toBeDefined();
  const activeRows = t.captureCharFrame().split("\n");
  const headerRow = activeRows.findIndex((row) => row.includes("edit_file"));
  const headerColumn = activeRows[headerRow]!.indexOf("edit_file");
  const targetNumber = t.renderer.hitTest(headerColumn, headerRow);
  const retainedTarget = renderableByNumber(t.renderer.root, targetNumber);
  expect(retainedTarget).toBeDefined();

  setActive(false);
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("covered elicitation must be inert");
  expect(scrollbox).toBe(retainedScrollbox);
  expect(history).toBe(retainedHistory);
  expect(retainedScrollbox!.isDestroyed).toBe(false);
  retainedTarget!.processMouseEvent(
    new MouseEvent(retainedTarget!, {
      type: "down",
      button: 0,
      x: headerColumn,
      y: headerRow,
      modifiers: { shift: false, alt: false, ctrl: false },
    }),
  );
  expect(props.transcript.overrideOf(node.key)).toBeUndefined();

  setActive(true);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("covered elicitation must be inert");
  expect(scrollbox).toBe(retainedScrollbox);
  expect(history).toBe(retainedHistory);
  retainedTarget!.processMouseEvent(
    new MouseEvent(retainedTarget!, {
      type: "down",
      button: 0,
      x: headerColumn,
      y: headerRow,
      modifiers: { shift: false, alt: false, ctrl: false },
    }),
  );
  expect(props.transcript.overrideOf(node.key)).toBeDefined();
  t.renderer.destroy();
});

test("resolving the elicit block calls resolveElicit with the chosen result", async () => {
  const request: ElicitRequestParams = { message: "cancel the run?" };
  const results: ElicitResult[] = [];
  const t = await mount(
    baseProps({
      run: run({ elicit: () => request, resolveElicit: (r) => results.push(r) }),
    }),
  );
  expect(t.captureCharFrame()).toContain("cancel the run?");
  t.renderer.destroy();
});

test("ctrl+p on a plan_review elicitation calls openPlan, wiring the block's plan and onOpenPlan props", async () => {
  const request: ElicitRequestParams = {
    message: "Approve the plan?",
    kind: "plan_review",
    requestedSchema: {
      type: "object",
      properties: { decision: { type: "string", enum: ["approve", "request_changes", "cancel"] } },
      required: ["decision"],
    },
  };
  const { interaction, press } = fakeInteraction();
  let opened = 0;
  const t = await mount(
    baseProps({
      interaction,
      run: { elicit: () => request, resolveElicit: () => {}, workflowActivity: () => null },
      activity: activity({
        plan: {
          path: ".clarvis/plans/x.md",
          title: "Reviewed plan",
          status: "awaiting_approval",
          retention: "keep",
          revision: 1,
          spec_revision: 1,
          tasks: [{ id: "t1", title: "Do the thing", status: "pending" }],
        } as ActivityStore["plan"],
      }),
      openPlan: () => (opened += 1),
    }),
  );
  press("ctrl+p");
  expect(opened).toBe(1);
  t.renderer.destroy();
});

test("clicking a tool block's header toggles its fold override through the transcript state", async () => {
  const nodes = [toolNode()];
  const props = baseProps({ store: store(nodes) });
  const t = await mount(props);
  expect(props.transcript.overrideOf(nodes[0]!.key)).toBeUndefined();
  const rows = t.captureCharFrame().split("\n");
  const headerRow = rows.findIndex((r) => r.includes("edit_file"));
  expect(headerRow).toBeGreaterThan(-1);
  await t.mockMouse.click(rows[headerRow]!.indexOf("edit_file"), headerRow);
  await t.renderOnce();
  expect(props.transcript.overrideOf(nodes[0]!.key)).toBeDefined();
  expect(t.renderer.hasSelection).toBe(false);
  t.renderer.destroy();
});

test("a failed tool retains a short reason while folded and opens its detail on click", async () => {
  const message = "Invalid input: expected array, received undefined";
  const nodes = [
    toolNode({
      mcpName: "fixture-server",
      toolName: "read_file",
      status: "error",
      error: message,
      result: message,
    }),
  ];
  const failedStore = store(nodes, () => true);
  const props = baseProps({ store: failedStore });
  const t = await mount(props);
  let out = t.captureCharFrame();
  expect(out).toContain("read_file");
  expect(out).toContain(message);
  expect(out).not.toContain("lines");

  const rows = out.split("\n");
  const headerRow = rows.findIndex((row) => row.includes("read_file"));
  await t.mockMouse.click(rows[headerRow]!.indexOf("read_file"), headerRow);
  await settleSyntaxSurfaces(t);
  out = t.captureCharFrame();
  expect(out).toContain(message);
  t.renderer.destroy();
});

test("a collapsed mutation chip counts the real diff, not the display-bounded copy", async () => {
  // The display projection caps a field at 64 KiB for rendering. Counting the
  // chip from it reported a fraction of the lines the call actually changed —
  // the one number a collapsed mutation exists to state.
  const changed = 4000;
  const diff = [
    "--- a/big.ts",
    "+++ b/big.ts",
    `@@ -0,0 +1,${String(changed)} @@`,
    ...Array.from({ length: changed }, (_, i) => `+line ${String(i)} ${"x".repeat(20)}`),
  ].join("\n");
  expect(diff.length).toBeGreaterThan(64 * 1024);

  const node = toolNode({
    toolName: "write_file",
    args: { path: "big.ts" },
    diff,
    result: "Wrote big.ts",
  });
  const props = baseProps({ store: store([node]) });
  props.transcript.toggleAt(node.key);
  const t = await mount(props);
  const frame = t.captureCharFrame();
  t.renderer.destroy();

  expect(frame).toContain(`+${String(changed)}`);
});

test("the main transcript hides sub-agent work until an isolated transcript is selected", async () => {
  const card: TranscriptNode = {
    key: "run-1::subagent-s1",
    kind: "subagent",
    status: "ok",
    text: "Inspect the implementation",
    title: "Worker",
    subagentId: "s1",
    subagentOrder: 0,
  };
  const body = toolNode({
    key: "run-1::tool-s1",
    subagentId: "s1",
    subagentOrder: 0,
  });
  const props = baseProps({
    store: store([card, body]),
    activity: activity({
      subagents: [
        { id: "s1", order: 0, status: "done", title: "Worker", input: 0, output: 0 },
      ] as ActivityStore["subagents"],
    }),
  });
  const t = await mount(props);
  expect(t.captureCharFrame()).not.toContain("Worker");
  expect(t.captureCharFrame()).not.toContain("edit_file");

  props.transcript.toggleSubagent("s1");
  await settleSyntaxSurfaces(t);
  expect(t.captureCharFrame()).toContain("Worker");
  props.transcript.toggleExpandOrBlock();
  await settleSyntaxSurfaces(t);
  expect(t.captureCharFrame()).toContain("edit_file");
  t.renderer.destroy();
});

test("one selected sub-agent transcript excludes every sibling transcript", async () => {
  const researcherCard: TranscriptNode = {
    key: "run-empty::subagent:researcher",
    kind: "subagent",
    status: "ok",
    text: "Inspect the implementation",
    title: "Researcher",
    subagentId: "researcher",
    subagentOrder: 0,
  };
  const researcherBody: TranscriptNode = {
    key: "run-empty::answer:researcher",
    kind: "assistant",
    status: "ok",
    text: "RESEARCHER BODY MUST START FOLDED",
    agentLabel: "Researcher",
    subagentId: "researcher",
    subagentOrder: 0,
  };
  const reviewerBody: TranscriptNode = {
    key: "run-empty::answer:reviewer",
    kind: "assistant",
    status: "ok",
    text: "REVIEWER BODY MUST START FOLDED",
    agentLabel: "Reviewer",
    subagentId: "reviewer",
    subagentOrder: 1,
  };
  const reviewerCard: TranscriptNode = {
    key: "run-empty::subagent:reviewer",
    kind: "subagent",
    status: "ok",
    text: "Review the implementation",
    title: "Reviewer",
    subagentId: "reviewer",
    subagentOrder: 1,
  };
  const props = baseProps({
    store: store([researcherCard, researcherBody, reviewerCard, reviewerBody]),
    activity: activity({
      subagents: [
        {
          id: "researcher",
          order: 0,
          status: "done",
          title: "Researcher",
          input: 0,
          output: 0,
        },
        {
          id: "reviewer",
          order: 1,
          status: "done",
          title: "Reviewer",
          input: 0,
          output: 0,
        },
      ] as ActivityStore["subagents"],
    }),
  });
  const t = await mount(props);

  expect(t.captureCharFrame()).not.toContain("Researcher");
  expect(t.captureCharFrame()).not.toContain("Reviewer");
  props.transcript.toggleSubagent("researcher");
  await settleSyntaxSurfaces(t);
  for (let pass = 0; pass < 10; pass += 1) await t.renderOnce();
  expect(props.transcript.overrideOf(researcherCard.key)).toBeUndefined();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Researcher");
  expect(frame).not.toContain("Reviewer");
  expect(frame).not.toContain("Completed");
  expect(frame).not.toContain("1 entry");
  const researcherBodyOwner = t.renderer.root.findDescendantById(researcherBody.key);
  expect(researcherBodyOwner).toBeDefined();
  expect(researcherBodyOwner!.height).toBeGreaterThan(0);
  expect(frame).toContain("RESEARCHER BODY MUST START FOLDED");
  expect(frame).not.toContain("REVIEWER BODY MUST START FOLDED");
  props.transcript.toggleSubagent("researcher");
  await settleSyntaxSurfaces(t);
  expect(t.captureCharFrame()).not.toContain("RESEARCHER BODY MUST START FOLDED");
  props.transcript.toggleSubagent("researcher");
  await settleSyntaxSurfaces(t);
  expect(t.captureCharFrame()).toContain("RESEARCHER BODY MUST START FOLDED");
  expect(t.captureCharFrame()).not.toContain("REVIEWER BODY MUST START FOLDED");
  t.renderer.destroy();
});

test("a delegation keeps only a bounded preview inline and opens the full brief on click", async () => {
  const longBrief = `## Investigate\n\n${"Detailed evidence and constraints. ".repeat(30)}`;
  const card: TranscriptNode = {
    key: "run-brief::subagent:worker",
    kind: "subagent",
    status: "running",
    text: longBrief,
    title: "researcher",
    subagentId: "worker",
    subagentOrder: 0,
  };
  let opened = "";
  const props = baseProps({
    store: store([card]),
    activity: activity({
      subagents: [
        { id: "worker", order: 0, status: "running", title: "researcher", input: 0, output: 0 },
      ] as ActivityStore["subagents"],
    }),
    onOpenDetail: (detail) => (opened = detail.content),
  });
  props.transcript.toggleSubagent("worker");
  const t = await mount(props);
  const frame = t.captureCharFrame();
  expect(frame).toContain("click to read");
  expect(frame).not.toContain(
    "Detailed evidence and constraints. Detailed evidence and constraints. Detailed evidence",
  );
  const row = frame.split("\n").findIndex((line) => line.includes("click to read"));
  const x = frame.split("\n")[row]!.indexOf("Investigate");
  expect(x).toBeGreaterThan(-1);
  await t.mockMouse.click(x + 2, row);
  await t.renderOnce();
  expect(opened).toBe(longBrief);
  t.renderer.destroy();
});

test("the sidebar is hidden in single-column mode even when marked visible", async () => {
  const t = await mount(
    baseProps({
      activity: activity({
        subagents: [
          { id: "s1", order: 0, status: "running", title: "Worker", input: 0, output: 0 },
        ] as ActivityStore["subagents"],
      }),
      layout: layout({ mode: () => "single", sidebarVisible: () => true }),
    }),
  );
  const out = t.captureCharFrame();
  expect(out).not.toContain("Worker");
  t.renderer.destroy();
});

test("the sidebar renders inline in wide mode when visible and content exists", async () => {
  const t = await mount(
    baseProps({
      store: store([toolNode()]),
      activity: activity({
        subagents: [
          { id: "s1", order: 0, status: "running", title: "Worker", input: 0, output: 0 },
        ] as ActivityStore["subagents"],
      }),
      layout: layout({ mode: () => "wide", sidebarVisible: () => true }),
    }),
  );
  const out = t.captureCharFrame();
  expect(out).toContain("Worker");
  t.renderer.destroy();
});

test("the sidebar bounds a plan result and opens its full Markdown detail", async () => {
  const result = `## Conclusion\n\n${"A long finding with evidence. ".repeat(40)}`;
  let opened = "";
  const t = await mount(
    baseProps({
      activity: activity({
        plan: {
          id: "p1",
          title: "Research plan",
          status: "completed",
          retention: "keep",
          revision: 2,
          spec_revision: 1,
          tasks: [{ id: "t1", title: "Research", status: "done", result }],
        },
      }),
      layout: layout({ sidebarVisible: () => true, sidebarWidth: () => 42 }),
      onOpenDetail: (detail) => (opened = detail.content),
    }),
  );
  const frame = t.captureCharFrame();
  expect(frame).toContain("Last result");
  expect(frame).toContain("click to rea");
  expect(frame).not.toContain(
    "A long finding with evidence. A long finding with evidence. A long finding",
  );
  const rows = frame.split("\n");
  const row = rows.findIndex((line) => line.includes("Last result"));
  const x = rows[row]!.indexOf("Last result");
  expect(x).toBeGreaterThan(-1);
  await t.mockMouse.click(x + 2, row);
  await t.renderOnce();
  expect(opened).toBe(result);
  t.renderer.destroy();
});

test("transcript blocks use the available width when the inline sidebar is absent", async () => {
  const nodes: TranscriptNode[] = [
    { key: "wide-user", kind: "user", status: "ok", text: "x".repeat(150) },
  ];
  const t = await mount(
    baseProps({
      store: store(nodes),
      layout: layout({ width: () => 160, sidebarVisible: () => false }),
    }),
    160,
  );
  const longestRun = Math.max(
    ...t
      .captureCharFrame()
      .split("\n")
      .flatMap((row) => row.match(/x+/g) ?? [])
      .map((run) => run.length),
  );
  expect(longestRun).toBeGreaterThan(110);
  t.renderer.destroy();
});

test("transcript blocks use the available pane beside an inline sidebar", async () => {
  const width = 160;
  const sidebarWidth = 32;
  const nodes: TranscriptNode[] = [
    { key: "split-user", kind: "user", status: "ok", text: "x".repeat(150) },
  ];
  const t = await mount(
    baseProps({
      store: store(nodes),
      layout: layout({
        width: () => width,
        sidebarVisible: () => true,
        sidebarWidth: () => sidebarWidth,
      }),
    }),
    width,
  );
  const longestRun = Math.max(
    ...t
      .captureCharFrame()
      .split("\n")
      .flatMap((row) => row.match(/x+/g) ?? [])
      .map((run) => run.length),
  );
  expect(longestRun).toBeGreaterThan(110);
  expect(longestRun).toBeLessThanOrEqual(width - sidebarWidth - 2);
  t.renderer.destroy();
});

test("focused sub-agent identity stays pinned without live status in its transcript", async () => {
  const a = activity({
    subagents: [
      {
        id: "s1",
        order: 0,
        status: "running",
        title: "Audit authentication",
        profile: "security-reviewer",
        model: "deepseek/deepseek-chat-v3-0324",
        input: 0,
        output: 0,
      },
    ] as ActivityStore["subagents"],
  });
  const props = baseProps({ store: store([toolNode()]), activity: a });
  props.transcript.toggleSubagent("s1");
  const t = await mount(props);
  const out = t.captureCharFrame();
  expect(out).toContain("Viewing A1 Audit authentication");
  expect(out).not.toContain("Activity: working");
  expect(out).not.toContain("Focused agent");
  expect(out).not.toContain("Lead transcript");
  t.renderer.destroy();
});

test("a focused failed sub-agent keeps its terminal summary out of the transcript banner", async () => {
  const a = activity({
    subagents: [
      {
        id: "s1",
        order: 0,
        status: "error",
        title: "Verify release",
        profile: "reviewer",
        summary: "The release test failed on Windows",
        input: 0,
        output: 0,
      },
    ] as ActivityStore["subagents"],
  });
  const props = baseProps({ store: store([toolNode()]), activity: a });
  props.transcript.toggleSubagent("s1");
  const t = await mount(props);
  const out = t.captureCharFrame();
  expect(out).toContain("Viewing A1 Verify release");
  expect(out).not.toContain("The release test failed on Windows");
  expect(out).not.toContain("Failed:");
  t.renderer.destroy();
});

test("the aggregate transcript does not duplicate the roster when the optional sidebar is hidden", async () => {
  const t = await mount(
    baseProps({
      store: store([toolNode()]),
      activity: activity({
        subagents: [
          { id: "s1", order: 0, status: "running", title: "Worker", input: 0, output: 0 },
        ] as ActivityStore["subagents"],
      }),
      layout: layout({ mode: () => "wide", sidebarVisible: () => false }),
    }),
  );
  const out = t.captureCharFrame();
  expect(out).not.toContain("All agents");
  expect(out).not.toContain("Lead transcript");
  expect(out).not.toContain("A1 Worker");
  t.renderer.destroy();
});

test("the split sidebar is the sole owner of the agent roster", async () => {
  const t = await mount(
    baseProps({
      store: store([toolNode()]),
      activity: activity({
        subagents: [
          { id: "s1", order: 0, status: "running", title: "Split worker", input: 0, output: 0 },
        ] as ActivityStore["subagents"],
      }),
      layout: layout({
        mode: () => "wide",
        sidebarVisible: () => true,
        secondaryMode: () => "split",
      }),
    }),
  );
  const out = t.captureCharFrame();
  const normalized = out.replace(/\s+/g, " ");
  expect(out).toContain("Lead transcript");
  expect(normalized).toContain("A1 Split worker");
  expect(out).not.toContain("Viewing A1");
  expect(out).not.toContain("All agents");
  t.renderer.destroy();
});

test("single mode with the drawer open renders the sidebar as an absolute-positioned overlay", async () => {
  const t = await mount(
    baseProps({
      store: store([toolNode()]),
      activity: activity({
        subagents: [
          { id: "s1", order: 0, status: "running", title: "Drawer worker", input: 0, output: 0 },
        ] as ActivityStore["subagents"],
      }),
      layout: layout({ mode: () => "single", sidebarVisible: () => false, drawerOpen: () => true }),
    }),
  );
  const out = t.captureCharFrame();
  expect(out).toContain("Lead transcript");
  expect(out).toContain("Drawer worker");
  expect(out).not.toContain("Viewing A1");
  t.renderer.destroy();
});

test("single mode with the drawer closed leaves the aggregate transcript unobstructed", async () => {
  const t = await mount(
    baseProps({
      store: store([toolNode()]),
      activity: activity({
        subagents: [
          { id: "s1", order: 0, status: "running", title: "Hidden worker", input: 0, output: 0 },
        ] as ActivityStore["subagents"],
      }),
      layout: layout({
        mode: () => "single",
        sidebarVisible: () => true,
        drawerOpen: () => false,
      }),
    }),
  );
  const out = t.captureCharFrame();
  expect(out).not.toContain("All agents");
  expect(out).not.toContain("Lead transcript");
  expect(out).not.toContain("A1 Hidden worker");
  t.renderer.destroy();
});

test("a workflow leader in the sidebar suppresses the splash's empty-transcript heuristic in App, but the region itself only reacts to store.nodes", async () => {
  const workflow: WorkflowActivity = {
    root: "run-1",
    nodes: new Map([
      [
        "run-1",
        {
          runId: "run-1",
          kind: "leader",
          title: "Ship the feature",
          status: "running",
        } as WorkflowActivity["nodes"] extends Map<string, infer V> ? V : never,
      ],
    ]),
  };
  const t = await mount(
    baseProps({
      run: run({ workflowActivity: () => workflow }),
      layout: layout({ mode: () => "wide", sidebarVisible: () => true }),
    }),
  );
  const out = t.captureCharFrame();
  expect(out).toContain("Ship the");
  expect(out).toContain("feature");
  expect(out).toContain("z-ai/glm-5.2");
  t.renderer.destroy();
});

test("onScrollbox receives the mounted scrollbox ref", async () => {
  let received: ScrollBoxRenderable | undefined;
  const t = await mount(baseProps({ onScrollbox: (el) => (received = el) }));
  expect(received).toBeDefined();
  t.renderer.destroy();
});

test("Lead keeps its physical reader state while one bounded child projection is visited", async () => {
  const leadNodes: TranscriptNode[] = Array.from({ length: 40 }, (_, index) => ({
    key: `lead-${String(index)}`,
    kind: "assistant",
    status: "ok",
    text: `LEAD ROW ${String(index)} ${"reader context ".repeat(5)}`,
  }));
  const childNodes: TranscriptNode[] = [
    {
      key: "execution::child-a-card",
      kind: "subagent",
      status: "ok",
      text: "Inspect child A",
      title: "Child A",
      subagentId: "a",
      subagentOrder: 0,
    },
    {
      key: "execution::child-a",
      kind: "assistant",
      status: "ok",
      text: "CHILD A TRANSCRIPT",
      subagentId: "a",
      subagentOrder: 0,
    },
    {
      key: "execution::child-b-card",
      kind: "subagent",
      status: "ok",
      text: "Inspect child B",
      title: "Child B",
      subagentId: "b",
      subagentOrder: 1,
    },
    {
      key: "execution::child-b",
      kind: "assistant",
      status: "ok",
      text: "CHILD B TRANSCRIPT",
      subagentId: "b",
      subagentOrder: 1,
    },
  ];
  let activeScrollbox: ScrollBoxRenderable | undefined;
  let activeHandle: TranscriptViewportHandle | undefined;
  const props = baseProps({
    store: store([...leadNodes, ...childNodes]),
    activity: activity({
      subagents: [
        { id: "a", order: 0, status: "done", title: "Child A", input: 0, output: 0 },
        { id: "b", order: 1, status: "done", title: "Child B", input: 0, output: 0 },
      ] as ActivityStore["subagents"],
    }),
    onScrollbox: (value) => (activeScrollbox = value),
    onHistoryHandle: (value) => (activeHandle = value),
  });
  const t = await mount(props, 100, 20);
  const leadScrollbox = activeScrollbox;
  const leadHandle = activeHandle;
  expect(leadScrollbox).toBeDefined();
  expect(leadHandle).toBeDefined();
  expect(leadHandle!.scrollBy(-6)).toBe("scrolled");
  await t.renderOnce();
  expect(leadScrollbox!.scrollTop).toBeGreaterThan(0);

  props.transcript.toggleSubagent("a");
  await settleSyntaxSurfaces(t);
  const childA = activeScrollbox;
  expect(childA).toBeDefined();
  expect(childA).toBe(leadScrollbox);
  expect(t.captureCharFrame()).toContain("CHILD A TRANSCRIPT");
  expect(leadScrollbox!.isDestroyed).toBe(false);

  props.transcript.toggleSubagent("b");
  await settleSyntaxSurfaces(t);
  const childB = activeScrollbox;
  expect(childB).toBeDefined();
  expect(childB).toBe(childA);
  expect(childA!.isDestroyed).toBe(false);
  expect(t.captureCharFrame()).toContain("CHILD B TRANSCRIPT");

  await new Promise<void>((resolve) => process.nextTick(resolve));
  await new Promise<void>((resolve) => process.nextTick(resolve));
  await t.renderOnce();
  const retainedFrameListeners = t.renderer.listenerCount("frame");
  const retainedRenderables = renderableCount(t.renderer.root);
  const retainedLifecyclePasses = t.renderer.getLifecyclePasses().size;

  for (let cycle = 0; cycle < 12; cycle += 1) {
    const target = cycle % 2 === 0 ? "a" : "b";
    props.transcript.toggleSubagent(target);
    await settleSyntaxSurfaces(t);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain(
      target === "a" ? "CHILD A TRANSCRIPT" : "CHILD B TRANSCRIPT",
    );
    expect(t.renderer.listenerCount("frame")).toBe(retainedFrameListeners);
    expect(renderableCount(t.renderer.root)).toBe(retainedRenderables);
    expect(t.renderer.getLifecyclePasses().size).toBe(retainedLifecyclePasses);
  }

  props.transcript.toggleSubagent("b");
  leadHandle!.returnToTail();
  await settleSyntaxSurfaces(t);
  expect(activeScrollbox).toBe(leadScrollbox);
  expect(activeHandle).toBe(leadHandle);
  expect(leadScrollbox!.isDestroyed).toBe(false);
  expect(t.captureCharFrame()).toContain("LEAD ROW");
  expect(t.captureCharFrame()).not.toContain("CHILD B TRANSCRIPT");
  t.renderer.destroy();
});

test("clicking a sidebar sub-agent row toggles the transcript's selection", async () => {
  const nodes = [toolNode({ subagentId: "s1" }), toolNode({ subagentId: "s1" })];
  const props = baseProps({
    store: store(nodes),
    activity: activity({
      subagents: [
        { id: "s1", order: 0, status: "running", title: "Worker", input: 0, output: 0 },
      ] as ActivityStore["subagents"],
    }),
    layout: layout({ mode: () => "wide", sidebarVisible: () => true }),
  });
  const t = await mount(props);
  const rows = t.captureCharFrame().split("\n");
  const worker = rows
    .map((row, y) => ({ row, y, x: row.lastIndexOf("Worker") }))
    .find((hit) => hit.x > 80);
  expect(worker).toBeDefined();
  await t.mockMouse.click(worker!.x + 2, worker!.y);
  await t.renderOnce();
  expect(props.transcript.selectedSubagent()).toBe("s1");
  expect(t.renderer.hasSelection).toBe(false);
  t.renderer.destroy();
});

test("the vertical scrollbar gutter is reserved even with an empty transcript", async () => {
  const t = await mount(baseProps());
  expect(t.captureCharFrame()).toBeDefined();
  t.renderer.destroy();
});
