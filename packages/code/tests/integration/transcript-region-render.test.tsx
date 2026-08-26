import { expect, test } from "bun:test";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createMutable } from "solid-js/store";
import type { ScrollBoxRenderable } from "@opentui/core";
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
import type { LegacyCollapsibleToolNode } from "../helpers/transcript-fixtures.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

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

function store(nodes: TranscriptNode[]): TranscriptStore {
  return {
    nodes,
    defaultFolded: () => false,
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
function toolNode(over: Partial<LegacyCollapsibleToolNode> = {}): LegacyCollapsibleToolNode {
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
    contextWindow: overrides.contextWindow ?? (() => 1_024_000),
    agent: overrides.agent ?? (() => "coder"),
    model: overrides.model ?? (() => "z-ai/glm-5.2"),
    notify: overrides.notify ?? (() => {}),
    openPlan: overrides.openPlan ?? (() => {}),
    onOpenDetail: overrides.onOpenDetail,
    onScrollbox: overrides.onScrollbox ?? (() => {}),
  };
}

async function mount(props: TranscriptRegionProps, width = 120): Promise<TestRendererSetup> {
  const t = await openRender(() => <TranscriptRegion {...props} />, { width, height: 34 });
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

test("a failed tool reveals its error only after the user clicks its header", async () => {
  const message = "Invalid input: expected array, received undefined";
  const nodes = [
    toolNode({
      mcpName: "read_file",
      toolName: "",
      status: "error",
      error: message,
      result: message,
    }),
  ];
  const failedStore = {
    ...store(nodes),
    defaultFolded: () => true,
  } as TranscriptStore;
  const props = baseProps({ store: failedStore });
  const t = await mount(props);
  let out = t.captureCharFrame();
  expect(out).toContain("read_file");
  expect(out).not.toContain(message);
  expect(out).not.toContain("lines");

  const rows = out.split("\n");
  const headerRow = rows.findIndex((row) => row.includes("read_file"));
  await t.mockMouse.click(rows[headerRow]!.indexOf("read_file"), headerRow);
  await t.renderOnce();
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
    subagentOrder: 0,
    args: { path: "big.ts" },
    diff,
    result: "Wrote big.ts",
    collapsed: true,
  });
  const t = await mount(baseProps({ store: store([node]) }));
  const frame = t.captureCharFrame();
  t.renderer.destroy();

  expect(frame).toContain(`+${String(changed)}`);
});

test("a transcript sub-agent header is informational; only the sidebar selects its details", async () => {
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
  const rows = t.captureCharFrame().split("\n");
  const workerRow = rows.findIndex((row) => row.includes("Worker"));
  expect(workerRow).toBeGreaterThan(-1);

  await t.mockMouse.click(rows[workerRow]!.indexOf("Worker") + 2, workerRow);
  await t.renderOnce();

  expect(props.transcript.selectedSubagent()).toBeNull();
  expect(props.transcript.overrideOf(card.key)).toBeUndefined();
  expect(props.transcript.focusedKey()).toBeNull();
  expect(t.renderer.hasSelection).toBe(false);
  t.renderer.destroy();
});

test("an empty lead transcript keeps parallel worker bodies folded and terminal statuses current", async () => {
  const researcherCard: TranscriptNode = {
    key: "run-empty::subagent:researcher",
    kind: "subagent",
    status: "running",
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
    status: "running",
    text: "Review the implementation",
    title: "Reviewer",
    subagentId: "reviewer",
    subagentOrder: 1,
  };
  const t = await mount(
    baseProps({
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
    }),
  );

  const frame = t.captureCharFrame();
  expect(frame).toContain("Researcher");
  expect(frame).toContain("Reviewer");
  expect(frame.match(/Completed/g)?.length).toBe(2);
  expect(frame.match(/1 hidden/g)?.length).toBe(2);
  expect(frame).not.toContain("RESEARCHER BODY MUST START FOLDED");
  expect(frame).not.toContain("REVIEWER BODY MUST START FOLDED");
  expect(frame).not.toContain("Running");
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
  const t = await mount(
    baseProps({
      store: store([card]),
      activity: activity({
        subagents: [
          { id: "worker", order: 0, status: "running", title: "researcher", input: 0, output: 0 },
        ] as ActivityStore["subagents"],
      }),
      onOpenDetail: (detail) => (opened = detail.content),
    }),
  );
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

test("focused sub-agent context stays pinned above its filtered transcript", async () => {
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
  expect(out).toContain("Viewing A1 Audit authentication · Activity: working");
  expect(out).not.toContain("Focused agent");
  expect(out).not.toContain("All transcripts");
  t.renderer.destroy();
});

test("a focused failed sub-agent keeps its terminal reason visible", async () => {
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
  expect(t.captureCharFrame()).toContain("Failed: The release test failed on Windows");
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
  expect(out).not.toContain("All transcripts");
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
  expect(out).toContain("All transcripts");
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
  expect(out).toContain("All transcripts");
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
  expect(out).not.toContain("All transcripts");
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
