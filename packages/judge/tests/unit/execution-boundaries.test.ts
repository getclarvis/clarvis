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
  const prompt = judgePrompt({ revision: 1 }, { command: "case" });
  const params: LLMCallParams = {
    model: "model",
    provider: "provider",
    messages: [
      { role: "system", content: JUDGE_POLICY },
      { role: "user", content: prompt.seed },
      { role: "user", content: prompt.current },
    ],
    tools: [],
    cacheBreakpoints: [0, 2],
  };
  expect(judgeCacheBreakpoints(params, prompt.seed, prompt.current)).toEqual([0, 1, 2]);
  expect(
    judgeCacheBreakpoints({ ...params, cacheBreakpoints: undefined }, prompt.seed, prompt.current),
  ).toEqual([1]);
  for (const index of [0, 1, 2]) {
    const messages = params.messages.map((message, current) =>
      current === index ? { ...message, content: "tampered" } : message,
    );
    expect(() =>
      judgeCacheBreakpoints({ ...params, messages }, prompt.seed, prompt.current),
    ).toThrow();
  }
  expect(() =>
    judgeCacheBreakpoints(
      { ...params, messages: [...params.messages, { role: "system", content: "extra" }] },
      prompt.seed,
      prompt.current,
    ),
  ).toThrow();
});
