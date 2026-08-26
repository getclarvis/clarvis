import { expect, test } from "bun:test";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";

const ev = runEvent;

function replay(events: RunEvent[]) {
  const store = createTranscriptStore();
  const sink = store.openRun("exec_test");
  for (const e of events) applyRunEvent(sink, e, "replay");
  return store;
}

test("lead reasoning arriving after its iteration close is created already folded (no flicker)", () => {
  const store = replay([
    ev({ type: "run_started", at: 1 }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "compat/glm" }),
    ev({
      type: "iteration_completed",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "compat/glm",
      response: "Todas as fases concluídas.",
      input_tokens: 0,
      output_tokens: 0,
    }),
    ev({
      type: "reasoning",
      agent: "lead",
      iteration: 1,
      at: 4,
      model: "compat/glm",
      text: "All 5 tasks done. Let me write the final report.",
    }),
    ev({ type: "run_ended", status: "completed", reason: "completed", at: 5 }),
  ]);
  const nodes = store.nodes;

  const reasoning = nodes.filter((n) => n.kind === "reasoning");
  expect(reasoning).toHaveLength(1);
  expect(reasoning[0]!.status).toBe("ok");
  expect(store.defaultFolded(reasoning[0]!.key)).toBe(true);
  expect(
    nodes.some((n) => (n.kind === "reasoning" || n.kind === "thinking") && n.status === "running"),
  ).toBe(false);
  expect(nodes.some((n) => n.kind === "assistant" && n.text.includes("Todas as fases"))).toBe(true);
});

test("run_ended folds any reasoning still running whose iteration never closed", () => {
  const nodes = replay([
    ev({ type: "run_started", at: 1 }),
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 2, model: "compat/glm" }),
    ev({
      type: "reasoning",
      agent: "lead",
      iteration: 1,
      at: 3,
      model: "compat/glm",
      text: "thinking…",
    }),
    ev({ type: "run_ended", status: "cancelled", reason: "cancelled", at: 4 }),
  ]).nodes;

  const dangling = nodes.filter(
    (n) => (n.kind === "reasoning" || n.kind === "thinking") && n.status === "running",
  );
  expect(dangling).toHaveLength(0);
});
