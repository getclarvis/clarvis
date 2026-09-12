import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore, type TranscriptNode } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";
import { BlockView } from "../../src/views/blocks.tsx";

const ev = runEvent;

function drive(stream: RunEvent[]): TranscriptNode[] {
  return createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec1");
    for (const event of stream) applyRunEvent(sink, event, "live");
    return store.nodes;
  });
}

async function frame(node: TranscriptNode): Promise<string> {
  const t = await openRender(() => <BlockView node={node} forceExpand={() => true} />, {
    width: 90,
    height: 24,
  });
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
