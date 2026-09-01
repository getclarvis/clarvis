import { expect, test } from "bun:test";
import { createMemo, createRoot } from "solid-js";
import type { RunEvent } from "@clarvis/protocol";
import { createActivityStore } from "../../src/adapters/activity-store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";
import { contextMeter } from "../../src/views/Sidebar.tsx";
import { tokens } from "../../src/theme/tokens.ts";

const ev = runEvent;
const iter = (
  event: Omit<Extract<RunEvent, { type: "iteration_completed" }>, "at" | "model" | "response">,
): RunEvent => ev({ at: 1, model: "m", response: "", ...event });

test("contextMeter: fill fraction, pressure color, and used/window · pct label", () => {
  expect(contextMeter(0, 200000)).toEqual({
    frac: 0,
    filled: 0,
    color: tokens.add,
    label: "0/200k · 0%",
    pct: 0,
  });
  expect(contextMeter(100000, 200000)).toMatchObject({
    filled: 8,
    color: tokens.add,
    label: "100k/200k · 50%",
    pct: 50,
  });
  expect(contextMeter(150000, 200000)).toMatchObject({ color: tokens.warn, pct: 75 });
  expect(contextMeter(180000, 200000)).toMatchObject({ color: tokens.del, pct: 90 });
  expect(contextMeter(300000, 200000)).toMatchObject({ frac: 1, filled: 16, pct: 100 });
});

test("cached input accumulates beside the gross count and leaves the context window gross", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();
    const sink = activity.openRun();

    applyRunEvent(sink, ev({ type: "run_started", at: 1, lead_model: "anthropic/m" }), "live");
    applyRunEvent(
      sink,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 10_000,
        output_tokens: 500,
        cached_tokens: 8_000,
      }),
      "live",
    );
    expect(activity.usage).toEqual({ input: 10_000, output: 500, cached: 8_000 });
    expect(activity.currentUsage).toEqual({ input: 10_000, output: 500, cached: 8_000 });
    expect(activity.context!.used).toBe(10_000);

    applyRunEvent(
      sink,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 2,
        input_tokens: 12_000,
        output_tokens: 300,
        cached_tokens: 11_000,
      }),
      "live",
    );
    expect(activity.usage).toEqual({ input: 22_000, output: 800, cached: 19_000 });
    expect(activity.currentUsage).toEqual({ input: 22_000, output: 800, cached: 19_000 });
    dispose();
  });
});

test("an iteration that reports no cache split leaves cached off the usage entirely", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();
    const sink = activity.openRun();
    applyRunEvent(sink, ev({ type: "run_started", at: 1, lead_model: "anthropic/m" }), "live");
    applyRunEvent(
      sink,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 10_000,
        output_tokens: 500,
      }),
      "live",
    );
    expect(activity.usage).toEqual({ input: 10_000, output: 500 });
    expect(activity.currentUsage).toEqual({ input: 10_000, output: 500 });
    dispose();
  });
});

test("a measured zero stays distinct from missing cache detail and replay never owns current usage", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();
    const replay = activity.openRun();
    applyRunEvent(replay, ev({ type: "run_started", at: 1 }), "replay");
    applyRunEvent(
      replay,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 20_000,
        output_tokens: 2_000,
        cached_tokens: 10_000,
      }),
      "replay",
    );
    expect(activity.currentUsage).toBeNull();

    const live = activity.openRun();
    applyRunEvent(live, ev({ type: "run_started", at: 2 }), "live");
    applyRunEvent(
      live,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 5_000,
        output_tokens: 100,
        cached_tokens: 0,
      }),
      "live",
    );
    expect(activity.currentUsage).toEqual({ input: 5_000, output: 100, cached: 0 });

    replay.beginReconcile();
    applyRunEvent(replay, ev({ type: "run_started", at: 3 }), "replay");
    applyRunEvent(
      replay,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 30_000,
        output_tokens: 3_000,
      }),
      "replay",
    );
    replay.endReconcile();
    expect(activity.currentUsage).toEqual({ input: 5_000, output: 100, cached: 0 });
    expect(activity.usage).toEqual({ input: 35_000, output: 3_100 });

    activity.openRun({ current: true });
    expect(activity.currentUsage).toEqual({ input: 0, output: 0, cached: 0 });

    activity.clear();
    expect(activity.currentUsage).toBeNull();
    dispose();
  });
});

test("context bar reactivity: a memo over activity.context follows the lead's latest input (not frozen)", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();
    const sink = activity.openRun();
    const window = 200000;
    const meter = createMemo(() =>
      activity.context ? contextMeter(activity.context.used, window) : null,
    );

    applyRunEvent(sink, ev({ type: "run_started", at: 1, lead_model: "anthropic/m" }), "live");
    expect(meter()).toBeNull();

    applyRunEvent(
      sink,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 100000,
        output_tokens: 5000,
      }),
      "live",
    );
    expect(meter()).toMatchObject({ filled: 8, label: "100k/200k · 50%", color: tokens.add });
    dispose();
  });
});

test("usage total sums all agents; context bar tracks only the lead; neither bounces on a checkpoint", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();
    const sink = activity.openRun();

    applyRunEvent(sink, ev({ type: "run_started", at: 1, lead_model: "anthropic/m" }), "live");
    applyRunEvent(
      sink,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 4000,
        output_tokens: 1000,
      }),
      "live",
    );
    expect(activity.context!.used).toBe(4000);

    applyRunEvent(
      sink,
      iter({
        type: "iteration_completed",
        agent: "subagent",
        subagent_id: "w1",
        iteration: 1,
        input_tokens: 2000,
        output_tokens: 500,
      }),
      "live",
    );
    expect(activity.usage).toEqual({ input: 6000, output: 1500 });
    expect(activity.context!.used).toBe(4000);

    applyRunEvent(
      sink,
      ev({
        type: "soft_limit_check",
        at: 5,
        dimension: "tokens",
        used: 2500,
        limit: 40000,
        outcome: "continued",
      }),
      "live",
    );
    expect(activity.usage).toEqual({ input: 6000, output: 1500 });
    expect(activity.context!.used).toBe(4000);

    applyRunEvent(
      sink,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 2,
        input_tokens: 9000,
        output_tokens: 200,
      }),
      "live",
    );
    expect(activity.context!.used).toBe(9000);
    expect(activity.usage).toEqual({ input: 15000, output: 1700 });

    applyRunEvent(
      sink,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 3,
        input_tokens: 3000,
        output_tokens: 100,
      }),
      "live",
    );
    expect(activity.context!.used).toBe(3000);
    expect(activity.context!.model).toBe("anthropic/m");
    expect(activity.usage).toEqual({ input: 18000, output: 1800 });
    dispose();
  });
});

test("usage total is session-cumulative: a second turn adds to the first (all leaders summed); clear wipes", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();

    const s1 = activity.openRun();
    applyRunEvent(s1, ev({ type: "run_started", at: 1, lead_model: "anthropic/m" }), "live");
    applyRunEvent(
      s1,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 3000,
        output_tokens: 1000,
      }),
      "live",
    );
    expect(activity.usage).toEqual({ input: 3000, output: 1000 });

    const s2 = activity.openRun();
    applyRunEvent(s2, ev({ type: "run_started", at: 10, lead_model: "anthropic/m" }), "live");
    expect(activity.usage).toEqual({ input: 3000, output: 1000 });
    applyRunEvent(
      s2,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 2000,
        output_tokens: 500,
      }),
      "live",
    );
    expect(activity.usage).toEqual({ input: 5000, output: 1500 });

    activity.clear();
    expect(activity.usage).toBeNull();
    expect(activity.context).toBeNull();
    dispose();
  });
});

test("usage reconciliation stays exact across a long session without rescanning prior runs", () => {
  createRoot((dispose) => {
    const activity = createActivityStore();
    let first: ReturnType<typeof activity.openRun> | undefined;
    for (let index = 0; index < 1_000; index += 1) {
      const sink = activity.openRun();
      first ??= sink;
      applyRunEvent(sink, ev({ type: "run_started", at: index + 1 }), "replay");
      applyRunEvent(
        sink,
        iter({
          type: "iteration_completed",
          agent: "lead",
          iteration: 1,
          input_tokens: 2,
          output_tokens: 1,
        }),
        "replay",
      );
    }
    expect(activity.usage).toEqual({ input: 2_000, output: 1_000 });

    first!.beginReconcile();
    expect(activity.usage).toEqual({ input: 1_998, output: 999 });
    applyRunEvent(first!, ev({ type: "run_started", at: 2_000 }), "replay");
    applyRunEvent(
      first!,
      iter({
        type: "iteration_completed",
        agent: "lead",
        iteration: 1,
        input_tokens: 5,
        output_tokens: 3,
      }),
      "replay",
    );
    first!.endReconcile();
    expect(activity.usage).toEqual({ input: 2_003, output: 1_002 });
    dispose();
  });
});
