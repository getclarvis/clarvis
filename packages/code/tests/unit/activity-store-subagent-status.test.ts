import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { RunEvent } from "@clarvis/protocol";
import { createActivityStore, type SubagentStatus } from "../../src/adapters/activity-store.ts";
import { applyRunEvent, runEvent as ev } from "../helpers/run-events.ts";

/** Project one complete protocol stream through the activity store's roster. */
function roster(stream: RunEvent[]): SubagentStatus[] {
  return createRoot(() => {
    const activity = createActivityStore();
    const sink = activity.openRun({ current: true });
    for (const event of stream) applyRunEvent(sink, event, "live");
    return activity.subagents.map((agent) => agent.status);
  });
}

const created = (id: string): RunEvent =>
  ev({ type: "delegation_created", delegation_id: id, at: 1, title: id, task: "brief", tools: [] });

const started = (id: string): RunEvent =>
  ev({ type: "delegation_started", delegation_id: id, at: 2, model: "openai/gpt-5" });

const completed = (id: string): RunEvent =>
  ev({
    type: "delegation_completed",
    delegation_id: id,
    at: 3,
    status: "completed",
    summary: "ok",
  });

const failed = (id: string, status: string): RunEvent =>
  ev({ type: "delegation_failed", delegation_id: id, at: 3, status, summary: "partial" });

test("the roster keeps the cause each delegation terminal actually carried", () => {
  const cases: Array<[string, RunEvent, SubagentStatus]> = [
    ["a child that finished", completed("child"), "done"],
    ["a child the run cancelled", failed("child", "cancelled"), "cancelled"],
    ["a child its parent stopped", failed("child", "stopped"), "cancelled"],
    ["a child at its own iteration cap", failed("child", "iteration_limit_reached"), "limited"],
    ["a child on the run's token cap", failed("child", "budget_exhausted"), "limited"],
    ["a child that broke", failed("child", "error"), "error"],
  ];
  for (const [label, terminal, expected] of cases) {
    expect(
      roster([ev({ type: "run_started", at: 0 }), created("child"), started("child"), terminal]),
      label,
    ).toEqual([expected]);
  }
});

test("children still live when the run ends without success are cancelled, not failed", () => {
  expect(
    roster([
      ev({ type: "run_started", at: 0 }),
      created("child"),
      started("child"),
      ev({ type: "run_ended", status: "failed", at: 4, reason: "no_progress" }),
    ]),
  ).toEqual(["cancelled"]);

  expect(
    roster([
      ev({ type: "run_started", at: 0 }),
      created("child"),
      started("child"),
      ev({ type: "run_ended", status: "completed", at: 4, reason: "completed" }),
    ]),
  ).toEqual(["done"]);
});
