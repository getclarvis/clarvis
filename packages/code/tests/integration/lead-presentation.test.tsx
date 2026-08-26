import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore, type TranscriptNode } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { computeGroupedNodes, type SectionHeader } from "../../src/views/subagent-sections.ts";

const ev = runEvent;

function drive(stream: RunEvent[]): TranscriptNode[] {
  return createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec1");
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
  let out = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 8));
    await t.renderOnce();
    out = t.captureCharFrame();
    if (out.trim().length > 0 && !out.trim().endsWith("•")) break;
  }
  t.renderer.destroy();
  return out;
}

test("a lead turn with real work gets ONE header on its first agent node (model · N tool calls)", () => {
  const flat: TranscriptNode[] = [
    { key: "exec1::r", kind: "reasoning", status: "ok", text: "think", model: "glm-5.2" },
    { key: "exec1::t", kind: "tool_call", status: "ok", text: "", toolName: "read_files" },
    { key: "exec1::m", kind: "assistant", status: "ok", text: "answer" },
  ];
  const { headers } = computeGroupedNodes(flat);
  expect(headers.get("exec1::r")).toEqual({
    order: -1,
    title: "",
    lead: true,
    model: "glm-5.2",
    status: "running",
    toolCalls: 1,
  });
  expect(headers.has("exec1::t")).toBe(false);
});

test("a lead turn that is only an answer (no tools, no reasoning) gets no header", () => {
  const flat: TranscriptNode[] = [{ key: "exec2::m", kind: "assistant", status: "ok", text: "hi" }];
  expect(computeGroupedNodes(flat).headers.has("exec2::m")).toBe(false);
});

test("a commentary-phase assistant turn does not synthesize a visible phase label", async () => {
  const rendered = await frame({
    key: "exec2::commentary",
    kind: "assistant",
    status: "ok",
    text: "I am checking the provider history now.",
    assistantPhase: "commentary",
  });

  expect(rendered).toContain("I am checking the provider history now.");
  expect(rendered).not.toContain("update");
});

test("a locally-appended bash node (no run namespace) never seeds a lead header", () => {
  const flat: TranscriptNode[] = [
    { key: "user:0", kind: "user", status: "ok", text: "hi" },
    {
      key: "local:0",
      kind: "tool_call",
      status: "ok",
      text: "",
      mcpName: "local",
      toolName: "shell",
    },
    { key: "exec1::r", kind: "reasoning", status: "ok", text: "think", model: "m1" },
    { key: "exec1::t", kind: "tool_call", status: "ok", text: "", toolName: "grep" },
  ];
  const { headers, ordered } = computeGroupedNodes(flat);
  expect(headers.has("local:0")).toBe(false);
  expect(headers.get("exec1::r")?.toolCalls).toBe(1);
  expect(ordered.map((n) => n.key)).toEqual(["user:0", "local:0", "exec1::r", "exec1::t"]);
});

test("the lead header adopts the run's terminal status once the run ends", () => {
  const flat: TranscriptNode[] = [
    { key: "exec1::t", kind: "tool_call", status: "ok", text: "", toolName: "grep" },
    { key: "exec1::run", kind: "run", status: "ok", text: "", reason: "done" },
  ];
  expect(computeGroupedNodes(flat).headers.get("exec1::t")?.status).toBe("ok");
});

test("run_ended stamps lead tool-call count and accumulated lead tokens on the run node", () => {
  const nodes = drive([
    ev({ type: "run_started", at: 1, lead_model: "glm-5.2" }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "glm-5.2",
      input_tokens: 2000,
      output_tokens: 400,
      response: "here",
    }),
    ev({
      type: "tool_call",
      call_id: "c1",
      agent: "lead",
      at: 4,
      server: "clarvis",
      tool: "read_file",
      arguments: { path: "a.ts" },
      result: "     1\tconst a = 1",
      ok: true,
    }),
    ev({ type: "run_ended", status: "completed", at: 5, reason: "completed" }),
  ]);
  const run = nodes.find((n) => n.kind === "run")!;
  expect(run.toolCalls).toBe(1);
  expect(run.inputTokens).toBe(2000);
  expect(run.outputTokens).toBe(400);
});

test("lead nodes are stamped with the lead model captured from run_started", () => {
  const nodes = drive([
    ev({ type: "run_started", at: 1, lead_model: "glm-5.2" }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "glm-5.2" }),
    ev({
      type: "reasoning",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "glm-5.2",
      text: "let me look",
    }),
  ]);
  expect(nodes.find((n) => n.kind === "reasoning")?.model).toBe("glm-5.2");
});

test("the lead SectionHead renders the model and tool-call count in the lead's accent", async () => {
  const node: TranscriptNode = { key: "exec1::t", kind: "tool_call", status: "running", text: "" };
  const header: SectionHeader = {
    order: -1,
    title: "",
    lead: true,
    model: "glm-5.2",
    status: "running",
    toolCalls: 17,
  };
  const out = await frame(node, header);
  expect(out).toContain("glm-5.2");
  expect(out).toContain("17 tool calls");
});
