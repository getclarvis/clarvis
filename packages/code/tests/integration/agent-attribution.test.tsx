import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore, type TranscriptNode } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";
import { BlockView, railColor } from "../../src/views/blocks.tsx";
import { tokens } from "../../src/theme/tokens.ts";
import type { FoldFixtureNode } from "../helpers/transcript-fixtures.ts";

const ev = runEvent;

function drive(stream: RunEvent[]): TranscriptNode[] {
  return createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    for (const event of stream) applyRunEvent(sink, event, "live");
    return store.nodes;
  });
}

async function frame(node: TranscriptNode): Promise<string> {
  const t = await openRender(() => <BlockView node={node} forceExpand={() => true} />, {
    width: 90,
    height: 24,
  });
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

test("reasoning renders a labelled 'thinking' region when live/expanded, and hides once collapsed", async () => {
  const expanded: FoldFixtureNode = {
    key: "r",
    kind: "reasoning",
    status: "running",
    text: "let me weigh the options",
  };
  const eout = await frame(expanded);
  expect(eout).toContain("thinking");
  expect(eout).toContain("let me weigh the options");

  const collapsed: FoldFixtureNode = {
    ...expanded,
    key: "r2",
    status: "ok",
    collapsed: true,
  };
  const t = await openRender(
    () => <BlockView defaultFolded={() => true} node={collapsed} forceExpand={() => false} />,
    {
      width: 90,
      height: 12,
    },
  );
  await t.renderOnce();
  const cout = t.captureCharFrame();
  t.renderer.destroy();
  expect(cout).not.toContain("thinking");
  expect(cout).not.toContain("let me weigh the options");
});
