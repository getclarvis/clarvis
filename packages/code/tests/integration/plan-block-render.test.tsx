import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { type TranscriptNode } from "../../src/adapters/store.ts";
import { createTranscriptState } from "../../src/views/transcript-state.ts";
import type { PlanTaskActivity } from "../../src/adapters/plan-projection.ts";

function planNode(over: Partial<TranscriptNode> = {}): TranscriptNode {
  const tasks: PlanTaskActivity[] = [
    { id: "t1", title: "Read the session store", status: "done" },
    { id: "t2", title: "Add the index", status: "in_progress" },
    { id: "t3", title: "Wire the query", status: "pending" },
  ];
  return {
    key: "exec_1::plan",
    kind: "plan",
    status: "running",
    text: ".clarvis/plans/2026-07-27T10-00-00-implement-session-search.md",
    planTitle: "Implement session search",
    planStatus: "active",
    revision: 2,
    tasks,
    ...over,
  };
}

async function frame(node: TranscriptNode, folded = false): Promise<string> {
  const t = await openRender((() => <BlockView node={node} folded={() => folded} />) as never, {
    width: 100,
    height: 30,
  });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("the transcript plan block owns the summary and routes full detail to the overlay", async () => {
  const out = await frame(planNode());
  expect(out).toContain("plan Implement session search");
  expect(out).toContain("revision 2");
  expect(out).toContain("1/3 completed");
  expect(out).toContain("Open plan for the full objective, task list and review history");
  expect(out).not.toContain("Read the session store");
  expect(out).not.toContain("Add the index");
  expect(out).not.toContain("Wire the query");
  expect(out).not.toContain(".clarvis/plans/");
});

test("an active plan does not spell out its status; a gated one does", async () => {
  expect(await frame(planNode())).not.toContain("active");
  const gated = await frame(planNode({ planStatus: "awaiting_approval" }));
  expect(gated).toContain("Awaiting approval");
});

test("the review verdict shows once the human has ruled", async () => {
  const out = await frame(planNode({ planReview: "approved" }));
  expect(out).toContain("review: approved");
});

test("a retention discard is historical rather than an unavailable plan", async () => {
  const out = await frame(
    planNode({
      status: "ok",
      planStatus: "completed",
      planRemoved: true,
      planDiscarded: true,
      tasks: [{ id: "t1", title: "Finish work", status: "done" }],
    }),
  );
  expect(out).toContain("1/1 completed");
  expect(out).toContain("History discarded");
  expect(out).toContain("Plan history was deleted after success, as configured");
  expect(out).not.toContain("unavailable");
  expect(out).not.toContain("restore it");
});

test("a folded plan keeps its header and drops the task list", async () => {
  const out = await frame(planNode(), true);
  expect(out).not.toContain("Read the session store");
  expect(out).not.toContain("Wire the query");
});

test("the transcript no longer filters plan nodes out of view", () => {
  const nodes: TranscriptNode[] = [
    { key: "u", kind: "user", status: "ok", text: "plan it" },
    planNode(),
  ];
  const state = createTranscriptState({
    nodes: () => nodes,
    subagents: () => [],
    notify: () => {},
  });
  expect(state.grouped().ordered.map((n) => n.kind)).toContain("plan");
});

test("a pathless transcript plan shows its title once without duplicating its id", async () => {
  const out = await frame(planNode({ text: "remote-plan-42", planTitle: "Remote rollout" }));
  expect(out).toContain("plan Remote rollout");
  expect(out).not.toContain("remote-plan-42");
  expect(out).not.toContain("undefined");
});
