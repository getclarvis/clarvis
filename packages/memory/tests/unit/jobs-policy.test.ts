import { describe, expect, test } from "bun:test";

import {
  appendAttempt,
  classifyFailure,
  DEFAULT_RETRY_POLICY,
  boundRunSnapshot,
  isJobPrunable,
  keptFailureIds,
  retryDelayMs,
  type MemoryIndexJob,
  type MemoryRetryPolicy,
} from "../../src/jobs.ts";
import { run, toolCall } from "../helpers/fixtures.ts";

/** No jitter, so the schedule is exact. */
const POLICY: MemoryRetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: () => 1 };

function job(over: Partial<MemoryIndexJob> = {}): MemoryIndexJob {
  return {
    run_id: "r1",
    state: "running",
    enqueued_at: 0,
    updated_at: 0,
    attempts: 1,
    history: [],
    ...over,
  };
}

describe("retry policy", () => {
  test("backs off exponentially and clamps", () => {
    expect(retryDelayMs(1, POLICY)).toBe(POLICY.baseDelayMs);
    expect(retryDelayMs(2, POLICY)).toBe(POLICY.baseDelayMs * 2);
    expect(retryDelayMs(3, POLICY)).toBe(POLICY.baseDelayMs * 4);
    expect(retryDelayMs(99, POLICY)).toBe(POLICY.maxDelayMs);
  });

  test("applies jitter so workspaces do not retry in lockstep", () => {
    const half = retryDelayMs(3, { ...POLICY, jitter: () => 0.5 });
    expect(half).toBe((POLICY.baseDelayMs * 4) / 2);
  });

  test("reschedules a transient failure", () => {
    const next = classifyFailure(job(), { phase: "generate", error: "429" }, POLICY, 1000);
    expect(next).toEqual({ state: "retry_wait", not_before: 1000 + POLICY.baseDelayMs });
  });

  test("gives up once the attempt budget is spent", () => {
    const spent = job({ attempts: POLICY.maxAttempts });
    expect(classifyFailure(spent, { phase: "generate", error: "boom" }, POLICY, 0)).toEqual({
      state: "failed",
    });
  });

  test("gives up on validation sooner than on transport", () => {
    // A model that cannot emit a valid operation array twice will not on the
    // fifth try, and each attempt costs a full inference.
    const once = job({ history: [{ at: 0, phase: "validate", error: "bad json" }] });
    expect(classifyFailure(once, { phase: "validate", error: "bad json" }, POLICY, 0)).toEqual({
      state: "failed",
    });
    expect(classifyFailure(once, { phase: "generate", error: "429" }, POLICY, 0).state).toBe(
      "retry_wait",
    );
  });

  test("fails a terminal error immediately without burning the budget", () => {
    expect(
      classifyFailure(job(), { phase: "apply", error: "bad path", terminal: true }, POLICY, 0),
    ).toEqual({ state: "failed" });
  });

  test("keeps the newest failed jobs and classifies pruning by terminal state", () => {
    const failed = [
      job({ run_id: "old", state: "failed", updated_at: 1 }),
      job({ run_id: "new", state: "failed", updated_at: 2 }),
      job({ run_id: "pending", state: "pending", updated_at: 3 }),
    ];
    expect([...keptFailureIds(failed, 1)]).toEqual(["new"]);
    expect(isJobPrunable(failed[0]!, { terminalBefore: 2 })).toBeTrue();
    expect(isJobPrunable(failed[2]!, { terminalBefore: 10, pendingBefore: 4 })).toBeTrue();
    expect(isJobPrunable(failed[2]!, { terminalBefore: 10 })).toBeFalse();
    expect(
      appendAttempt(
        job({
          history: Array.from({ length: 8 }, (_, at) => ({ at, phase: "generate", error: "x" })),
        }),
        { phase: "validate", error: "bad" },
        9,
      ),
    ).toHaveLength(5);
  });
});

describe("boundRunSnapshot", () => {
  test("redacts before storing, so no secret is ever written", () => {
    const bounded = boundRunSnapshot(
      run({ task: "deploy with sk-abcdefghijklmnopqrstuvwxyz012345", tool_calls: [] }),
    );
    expect(bounded.snapshot.task).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });

  test("keeps the opening and closing moves when dropping tool calls", () => {
    const calls = Array.from({ length: 40 }, (_, i) => toolCall({ tool_name: `t${String(i)}` }));
    const bounded = boundRunSnapshot(run({ tool_calls: calls }), { maxToolCalls: 10 });

    const names = bounded.snapshot.tool_calls.map((c) => c.tool_name);
    expect(names).toHaveLength(10);
    expect(names[0]).toBe("t0");
    expect(names[names.length - 1]).toBe("t39");
    expect(bounded.truncated?.dropped_tool_calls).toBe(30);
  });

  test("caps long fields", () => {
    const bounded = boundRunSnapshot(
      run({ task: "x".repeat(50_000), final_answer: "y".repeat(50_000) }),
      { maxTask: 100, maxFinalAnswer: 100 },
    );
    expect(bounded.snapshot.task.length).toBeLessThanOrEqual(100);
    expect((bounded.snapshot.final_answer ?? "").length).toBeLessThanOrEqual(100);
  });

  test("caps steering messages independently", () => {
    const bounded = boundRunSnapshot(run({ steering: ["word ".repeat(20), "second"] }), {
      maxSteering: 1,
      maxSteeringChars: 5,
    });
    expect(bounded.snapshot.steering).toHaveLength(1);
    expect(bounded.snapshot.steering?.[0]).toHaveLength(5);
    expect(bounded.truncated).toBeDefined();
  });
});
