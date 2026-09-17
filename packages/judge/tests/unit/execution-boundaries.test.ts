import { expect, test } from "bun:test";
import type { LLMCallParams } from "@clarvis/capability";
import { createJudgeOutputBudget } from "../../src/execution-budget.ts";
import {
  canonicalJudgeJson,
  judgeCacheBreakpoints,
  judgePrompt,
  JUDGE_POLICY,
  type JudgeJson,
} from "../../src/prompt.ts";

test("output reservations bound each retry group while preserving the next stage allowance", () => {
  const budget = createJudgeOutputBudget(2048, 2, 2);
  const first = budget.reserveOutput(100000)!;
  expect(first.amount).toBe(4096);
  expect(budget.remaining()).toBe(4096);
  const second = budget.reserveOutput(100000)!;
  expect(second.amount).toBe(4096);
  expect(budget.reserveOutput(1)).toBeNull();
  first.settle(4096);
  first.release();
  expect(budget.remaining()).toBe(0);
  second.release();
  second.settle(0);
  expect(budget.remaining()).toBe(4096);
  expect(budget.reserveOutput(Number.NaN)).toBeNull();
});

test("unknown or excessive usage cannot manufacture output headroom", () => {
  const budget = createJudgeOutputBudget(1024, 1, 1);
  budget.reserveOutput(1024)!.settle(Number.NaN);
  expect(budget.remaining()).toBe(0);
  const excessive = createJudgeOutputBudget(1024, 1, 1);
  excessive.reserveOutput(1024)!.settle(2048);
  expect(excessive.remaining()).toBe(0);
});

test("canonical snapshot rejects non-JSON input and preserves semantic array order", () => {
  expect(canonicalJudgeJson({ z: [2, 1], a: { b: true, a: null } })).toBe(
    '{"a":{"a":null,"b":true},"z":[2,1]}',
  );
  for (const value of [Number.NaN, new Date(), undefined, () => {}])
    expect(() => canonicalJudgeJson(value as JudgeJson)).toThrow();
  const cycle: { cycle?: JudgeJson } = {};
  cycle.cycle = cycle as JudgeJson;
  expect(() => canonicalJudgeJson(cycle as JudgeJson)).toThrow();
});

test("breakpoint selection validates exact framing and preserves engine breakpoints", () => {
  const prompt = judgePrompt(
    {
      authority: { revision: 1 },
      operator_evidence: [{ id: "first", text: "test the change" }],
      review_context: [{ kind: "plan", definition: { objective: "ship" } }],
    },
    { command: "case" },
  );
  const params: LLMCallParams = {
    model: "model",
    provider: "provider",
    messages: [
      { role: "system", content: JUDGE_POLICY },
      ...prompt.messages.map((content) => ({ role: "user" as const, content })),
    ],
    tools: [],
    cacheBreakpoints: [0, 2],
  };
  expect(judgeCacheBreakpoints(params, prompt)).toEqual([0, 2, 4]);
  expect(judgeCacheBreakpoints({ ...params, cacheBreakpoints: undefined }, prompt)).toEqual([4]);
  expect(prompt.messages[1]).toContain("<judge_goal_v1>\nnull");
  expect(prompt.messages[2]).toContain("<judge_plan_v1>");
  expect(prompt.messages[3]).toContain("<judge_operator_evidence_v1>");
  for (const index of params.messages.keys()) {
    const messages = params.messages.map((message, current) =>
      current === index ? { ...message, content: "tampered" } : message,
    );
    expect(() => judgeCacheBreakpoints({ ...params, messages }, prompt)).toThrow();
  }
  expect(() =>
    judgeCacheBreakpoints(
      { ...params, messages: [...params.messages, { role: "system", content: "extra" }] },
      prompt,
    ),
  ).toThrow();
});

test("new operator evidence extends the stable prefix without moving Goal or Plan", () => {
  const snapshot = {
    authority: { revision: 1 },
    operator_evidence: [{ id: "first", text: "implement the plan" }],
    review_context: [
      { kind: "goal", definition: { objective: "deliver" } },
      { kind: "plan", definition: { objective: "build" } },
    ],
  } satisfies JudgeJson;
  const first = judgePrompt(snapshot, { command: "npm install" });
  const second = judgePrompt(
    {
      ...snapshot,
      authority: { revision: 2 },
      operator_evidence: [...snapshot.operator_evidence, { id: "second", text: "run the checks" }],
    },
    { command: "npm test" },
  );
  expect(second.messages.slice(0, first.stableCount)).toEqual(
    first.messages.slice(0, first.stableCount),
  );
  expect(second.messages[first.stableCount]).toContain('"id":"second"');
  expect(second.stableCount).toBe(first.stableCount + 1);
});
