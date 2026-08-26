import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore, type TranscriptNode } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";
import { BlockView, railColor } from "../../src/views/blocks.tsx";
import { computeGroupedNodes, type SectionHeader } from "../../src/views/subagent-sections.ts";
import { tokens } from "../../src/theme/tokens.ts";
import type { LegacyCollapsibleNode } from "../helpers/transcript-fixtures.ts";

const ev = runEvent;

function drive(stream: RunEvent[]): TranscriptNode[] {
  return createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    for (const event of stream) applyRunEvent(sink, event, "live");
    return store.nodes;
  });
}

async function frame(node: TranscriptNode, header?: SectionHeader): Promise<string> {
  const t = await openRender(
    () => (
      <BlockView
        node={node}
        forceExpand={() => true}
        sectionHeader={header ? () => header : undefined}
      />
    ),
    { width: 90, height: 24 },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("railColor: Lead = accent2, each subagent = its spawn-order color, non-agent = invisible", () => {
  expect(railColor({ key: "a", kind: "assistant", status: "ok", text: "" })).toBe(tokens.accent2);
  expect(railColor({ key: "b", kind: "assistant", status: "ok", text: "", subagentOrder: 0 })).toBe(
    tokens.subagent(0),
  );
  expect(railColor({ key: "c", kind: "tool_call", status: "ok", text: "", subagentOrder: 2 })).toBe(
    tokens.subagent(2),
  );
  expect(railColor({ key: "d", kind: "user", status: "ok", text: "hi" })).toBe(tokens.bg);
});

test("subagent events attribute the assistant, reasoning and tool_call nodes (order + title + model)", () => {
  const nodes = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "delegation_created",
      delegation_id: "w1",
      at: 2,
      title: "explorer",
      task: "look",
      tools: [],
    }),
    ev({
      type: "iteration_started",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 3,
      model: "anthropic/claude-sonnet-4-5",
    }),
    ev({
      type: "reasoning",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 4,
      model: "anthropic/claude-sonnet-4-5",
      text: "thinking about auth",
    }),
    ev({
      type: "tool_call",
      agent: "subagent",
      subagent_id: "w1",
      at: 6,
      server: "",
      tool: "grep",
      arguments: { pattern: "jwt" },
      result: "(no matches)",
      ok: true,
    }),
    ev({
      type: "iteration_completed",
      agent: "subagent",
      subagent_id: "w1",
      iteration: 1,
      at: 7,
      model: "anthropic/claude-sonnet-4-5",
      input_tokens: 10,
      output_tokens: 5,
      response: "auth uses JWT",
    }),
  ]);

  const assistant = nodes.find((n) => n.kind === "assistant")!;
  expect(assistant.subagentOrder).toBe(0);
  expect(assistant.agentLabel).toBe("explorer");
  expect(assistant.model).toBe("anthropic/claude-sonnet-4-5");

  const reasoning = nodes.find((n) => n.kind === "reasoning")!;
  expect(reasoning.subagentOrder).toBe(0);
  expect(reasoning.agentLabel).toBe("explorer");

  const tool = nodes.find((n) => n.kind === "tool_call")!;
  expect(tool.subagentOrder).toBe(0);
});

test("a Lead iteration leaves the assistant node unattributed (subagentOrder undefined)", () => {
  const nodes = drive([
    ev({ type: "run_started", at: 1 }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "anthropic/claude-opus-4-5",
      input_tokens: 10,
      output_tokens: 5,
      response: "here is the plan",
    }),
  ]);
  const assistant = nodes.find((n) => n.kind === "assistant")!;
  expect(assistant.subagentOrder).toBeUndefined();
  expect(assistant.agentLabel).toBeUndefined();
});

test("computeGroupedNodes groups a subagent's blocks behind its card, which carries the header", () => {
  const n = (
    o: Partial<LegacyCollapsibleNode> & { key: string; kind: TranscriptNode["kind"] },
  ): LegacyCollapsibleNode =>
    ({
      status: "ok",
      text: "",
      ...o,
    }) as LegacyCollapsibleNode;
  const flat: LegacyCollapsibleNode[] = [
    n({ key: "l1", kind: "assistant", text: "delego" }),
    n({ key: "a", kind: "assistant", subagentOrder: 0, agentLabel: "explorer", model: "sonnet" }),
    n({ key: "x", kind: "assistant", subagentOrder: 1, agentLabel: "coder", model: "opus" }),
    n({ key: "b", kind: "tool_call", subagentOrder: 0, agentLabel: "explorer" }),
    n({ key: "c0", kind: "subagent", subagentOrder: 0, agentLabel: "explorer", title: "explorer" }),
    n({ key: "l2", kind: "assistant", text: "pronto" }),
  ];
  const { ordered, headers, folded, anchors } = computeGroupedNodes(flat);
  expect(ordered.map((x) => x.key)).toEqual(["l1", "c0", "a", "b", "x", "l2"]);
  expect(headers.get("c0")).toEqual({
    order: 0,
    title: "explorer",
    model: "sonnet",
    status: "ok",
    hiddenEntries: 2,
  });
  expect(headers.has("a")).toBe(false);
  expect(folded.has("c0")).toBe(false);
  expect(anchors.get("a")).toBe("c0");
  expect(anchors.get("b")).toBe("c0");
  expect(headers.get("x")).toEqual({
    order: 1,
    title: "coder",
    model: "opus",
    status: "running",
    hiddenEntries: 1,
  });
  expect(headers.has("l1")).toBe(false);
});

test("two runs' subagent-0 sections do NOT merge across turns (mid user msg not stranded at the end)", () => {
  const n = (
    o: Partial<LegacyCollapsibleNode> & { key: string; kind: TranscriptNode["kind"] },
  ) => ({
    status: "ok" as const,
    text: "",
    ...o,
  });
  const flat: LegacyCollapsibleNode[] = [
    n({ key: "user:0", kind: "user", text: "turn 1 question" }),
    n({
      key: "exec1::a",
      kind: "assistant",
      subagentOrder: 0,
      agentLabel: "coder",
      text: "t1 work",
    }),
    n({ key: "exec1::b", kind: "tool_call", subagentOrder: 0, agentLabel: "coder" }),
    n({ key: "user:3", kind: "user", text: "turn 2 question" }),
    n({
      key: "exec2::a",
      kind: "assistant",
      subagentOrder: 0,
      agentLabel: "coder",
      text: "t2 work",
    }),
    n({ key: "exec2::b", kind: "tool_call", subagentOrder: 0, agentLabel: "coder" }),
  ];
  const { ordered } = computeGroupedNodes(flat);
  expect(ordered.map((x) => x.key)).toEqual([
    "user:0",
    "exec1::a",
    "exec1::b",
    "user:3",
    "exec2::a",
    "exec2::b",
  ]);
  expect(ordered[ordered.length - 1]!.kind).not.toBe("user");
});

const gn = (o: Partial<LegacyCollapsibleNode> & { key: string; kind: TranscriptNode["kind"] }) => ({
  status: "ok" as const,
  text: "",
  ...o,
});

test("an active subagent sinks BELOW a finished one during a live run (finished-first)", () => {
  const flat: LegacyCollapsibleNode[] = [
    gn({ key: "w0a", kind: "tool_call", subagentOrder: 0, agentLabel: "coder" }),
    gn({
      key: "w1a",
      kind: "assistant",
      subagentOrder: 1,
      agentLabel: "explorer",
      text: "found it",
    }),
    gn({ key: "w1c", kind: "subagent", subagentOrder: 1, title: "explorer", status: "ok" }),
    gn({ key: "w0c", kind: "subagent", subagentOrder: 0, title: "coder", status: "running" }),
  ];
  const { ordered } = computeGroupedNodes(flat);
  expect(ordered.map((x) => x.key)).toEqual(["w1c", "w1a", "w0c", "w0a"]);
});

test("a subagent that produced no visible events still leaves its card once it concludes", () => {
  const finished: LegacyCollapsibleNode[] = [
    gn({ key: "lead", kind: "assistant", text: "delegating" }),
    gn({ key: "w0c", kind: "subagent", subagentOrder: 0, title: "coder", status: "error" }),
  ];
  const { ordered, headers } = computeGroupedNodes(finished);
  expect(ordered.map((x) => x.key)).toEqual(["lead", "w0c"]);
  expect(headers.get("w0c")).toMatchObject({ title: "coder", status: "error" });

  const running: LegacyCollapsibleNode[] = [
    gn({ key: "w0c", kind: "subagent", subagentOrder: 0, title: "coder", status: "running" }),
  ];
  expect(computeGroupedNodes(running).ordered.map((x) => x.key)).toEqual(["w0c"]);
});

test("at rest (both finished) sections sit in spawn/creation order", () => {
  const flat: LegacyCollapsibleNode[] = [
    gn({ key: "w0a", kind: "tool_call", subagentOrder: 0, agentLabel: "coder" }),
    gn({
      key: "w1a",
      kind: "assistant",
      subagentOrder: 1,
      agentLabel: "explorer",
      text: "found it",
    }),
    gn({ key: "w1c", kind: "subagent", subagentOrder: 1, title: "explorer", status: "ok" }),
    gn({ key: "w0c", kind: "subagent", subagentOrder: 0, title: "coder", status: "ok" }),
  ];
  const { ordered } = computeGroupedNodes(flat);
  expect(ordered.map((x) => x.key)).toEqual(["w0c", "w0a", "w1c", "w1a"]);
});

test("in a lead-subagent run a subagent's whole conversation folds behind its header (any kind/status)", () => {
  const flat: LegacyCollapsibleNode[] = [
    gn({ key: "lead", kind: "reasoning", text: "delegating" }),
    gn({ key: "okReason", kind: "reasoning", subagentOrder: 0, text: "weigh it" }),
    gn({ key: "okTool", kind: "tool_call", subagentOrder: 0 }),
    gn({ key: "okMsg", kind: "assistant", subagentOrder: 0, text: "the answer" }),
    gn({ key: "okCard", kind: "subagent", subagentOrder: 0, title: "explorer", status: "ok" }),
    gn({ key: "runTool", kind: "tool_call", status: "running", subagentOrder: 1 }),
    gn({ key: "runCard", kind: "subagent", subagentOrder: 1, title: "coder", status: "running" }),
    gn({ key: "errTool", kind: "tool_call", status: "error", subagentOrder: 2 }),
    gn({ key: "errCard", kind: "subagent", subagentOrder: 2, title: "planner", status: "error" }),
  ];
  const { folded } = computeGroupedNodes(flat);
  expect(folded.has("okReason")).toBe(true);
  expect(folded.has("okTool")).toBe(true);
  expect(folded.has("okMsg")).toBe(true);
  expect(folded.has("runTool")).toBe(true);
  expect(folded.has("errTool")).toBe(true);
  expect(folded.has("lead")).toBe(false);
});

test("in a subagent-only run without a card, the first body anchors a folded section", () => {
  const flat: LegacyCollapsibleNode[] = [
    gn({ key: "wReason", kind: "reasoning", subagentOrder: 0, text: "let me look" }),
    gn({ key: "wTool", kind: "tool_call", subagentOrder: 0 }),
    gn({ key: "wMsg", kind: "assistant", subagentOrder: 0, text: "done" }),
  ];
  const { folded, headers } = computeGroupedNodes(flat);
  expect([...folded]).toEqual(["wTool", "wMsg"]);
  expect(headers.get("wReason")?.hiddenEntries).toBe(2);
});

test("the delegation card renders its brief muted under the section header", async () => {
  const card: LegacyCollapsibleNode = {
    key: "w0c",
    kind: "subagent",
    status: "running",
    text: "audit the auth flow and report every unchecked token path",
    title: "explorer",
    subagentOrder: 0,
  };
  const header: SectionHeader = { order: 0, title: "explorer", status: "running" };
  const out = await frame(card, header);
  expect(out).toContain("Explorer");
  expect(out).toContain("audit the auth flow");
});

test("a finished (collapsed) card hides the brief but keeps the header", async () => {
  const card: LegacyCollapsibleNode = {
    key: "w0c",
    kind: "subagent",
    status: "ok",
    text: "audit the auth flow and report every unchecked token path",
    title: "explorer",
    subagentOrder: 0,
    collapsed: true,
  };
  const header: SectionHeader = { order: 0, title: "explorer", status: "ok", hiddenEntries: 3 };
  const t = await openRender(
    () => <BlockView node={card} forceExpand={() => false} sectionHeader={() => header} />,
    { width: 90, height: 24 },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  expect(out).toContain("Explorer");
  expect(out).toContain("Completed");
  expect(out).not.toContain("audit the auth flow");
});

test("a subagent section renders one synthesized header (title · model); the Lead has none", async () => {
  const subagent: LegacyCollapsibleNode = {
    key: "w",
    kind: "assistant",
    status: "ok",
    text: "auth uses JWT",
    subagentOrder: 0,
    agentLabel: "explorer",
    model: "sonnet",
  };
  const header: SectionHeader = { order: 0, title: "explorer", model: "sonnet", status: "ok" };
  const wout = await frame(subagent, header);
  expect(wout).toContain("Explorer");
  expect(wout).toContain("sonnet");

  const lead: LegacyCollapsibleNode = {
    key: "l",
    kind: "assistant",
    status: "ok",
    text: "the plan",
  };
  const lout = await frame(lead);
  expect(lout).toContain("•");
  expect(lout).not.toContain("Explorer");
});

test("a folded subagent's tool row is hidden (header still shows); Ctrl+O force-expand reveals it", async () => {
  const header: SectionHeader = { order: 0, title: "explorer", model: "sonnet", status: "ok" };
  const toolNode: LegacyCollapsibleNode = {
    key: "t",
    kind: "tool_call",
    status: "ok",
    text: "",
    toolName: "grep",
    args: { pattern: "needle" },
  };
  const foldedOut = await openRender(
    () => (
      <BlockView
        node={toolNode}
        forceExpand={() => false}
        folded={() => true}
        sectionHeader={() => header}
      />
    ),
    { width: 90, height: 24 },
  );
  await foldedOut.renderOnce();
  const folded = foldedOut.captureCharFrame();
  foldedOut.renderer.destroy();
  expect(folded).toContain("Explorer");
  expect(folded).not.toContain("grep");

  const openOut = await openRender(
    () => (
      <BlockView
        node={toolNode}
        forceExpand={() => true}
        folded={() => true}
        sectionHeader={() => header}
      />
    ),
    { width: 90, height: 24 },
  );
  await openOut.renderOnce();
  const open = openOut.captureCharFrame();
  openOut.renderer.destroy();
  expect(open).toContain("grep");
});

test("reasoning renders a labelled 'thinking' region when live/expanded, and hides once collapsed", async () => {
  const expanded: LegacyCollapsibleNode = {
    key: "r",
    kind: "reasoning",
    status: "running",
    text: "let me weigh the options",
  };
  const eout = await frame(expanded);
  expect(eout).toContain("thinking");
  expect(eout).toContain("let me weigh the options");

  const collapsed: LegacyCollapsibleNode = {
    ...expanded,
    key: "r2",
    status: "ok",
    collapsed: true,
  };
  const t = await openRender(() => <BlockView node={collapsed} forceExpand={() => false} />, {
    width: 90,
    height: 12,
  });
  await t.renderOnce();
  const cout = t.captureCharFrame();
  t.renderer.destroy();
  expect(cout).not.toContain("thinking");
  expect(cout).not.toContain("let me weigh the options");
});
