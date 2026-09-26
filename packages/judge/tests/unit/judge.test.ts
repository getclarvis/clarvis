import { expect, test } from "bun:test";
import type { LLMProvider, ModelExecutionInfo } from "@clarvis/capability";
import { createJudgeService, DenialCircuitBreaker, parseAssessment } from "../../src/index.ts";
import { reviewPayload } from "../../src/prompt.ts";
import type { ReviewInput } from "../../src/types.ts";

const input: ReviewInput = {
  action: {
    identity: { owner: "owner", executionId: "run", actor: "lead", callId: "call", attempt: 1 },
    tool: "shell",
    arguments: { command: "echo ok" },
    command: "echo ok",
    cwd: "/tmp",
    requestedProfile: "sandbox",
    effectiveProfile: "sandbox",
    reason: "permission_delta",
    policyRevision: "policy",
    authorizationRevision: 0,
  },
  evidence: [{ role: "user", content: "Complete the requested local change." }],
  profile: "sandbox",
};
const model: ModelExecutionInfo = {
  provider: "configured",
  model: "model",
  kind: "openai-compatible",
  contextWindowTokens: 8192,
  capabilities: [],
  reasoningEfforts: ["low"],
  promptCache: undefined,
};
const usage = { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 };

test("minimal JSON, prose wrapper, and invalid assessments", () => {
  expect(parseAssessment('{"outcome":"allow"}')).toMatchObject({
    outcome: "allow",
    risk_level: "low",
    user_authorization: "unknown",
  });
  expect(parseAssessment('Assessment: {"outcome":"deny","risk_level":"critical"}.')).toMatchObject({
    outcome: "deny",
    risk_level: "critical",
  });
  expect(parseAssessment('{"outcome":"maybe"}')).toBeUndefined();
});

test("required authority and action must fit without truncation", () => {
  expect(reviewPayload(input, 8)).toBeUndefined();
  expect(reviewPayload(input, 4096)).toContain("echo ok");
});

test("valid deny is final and a parse failure retries within one review", async () => {
  let calls = 0;
  const llm: LLMProvider = {
    async call() {
      calls++;
      return { text: calls === 1 ? "bad" : '{"outcome":"deny"}', usage };
    },
  };
  const result = await createJudgeService({ llm, model, maxAttempts: 3 }).review(input);
  expect(result).toMatchObject({ kind: "assessment", assessment: { outcome: "deny" } });
  expect(calls).toBe(2);
});

test("inspection tool output is evidence and runner is closed", async () => {
  let calls = 0;
  let inspected = 0;
  let closed = 0;
  const llm: LLMProvider = {
    async call(params) {
      calls++;
      if (calls === 1)
        return {
          usage,
          toolCalls: [{ id: "inspect", name: "read_file", arguments: { path: "target" } }],
        };
      expect(
        params.messages.some(
          (message) => message.role === "tool" && message.content === "observed target",
        ),
      ).toBe(true);
      return { usage, text: '{"outcome":"allow"}' };
    },
  };
  const judge = createJudgeService({
    llm,
    model,
    runner: () => ({
      tools: [
        {
          fullName: "read_file",
          wireName: "read_file",
          mcpName: "",
          toolName: "read_file",
          inputSchema: {},
        },
      ],
      async run() {
        inspected++;
        return { text: "observed target" };
      },
      async close() {
        closed++;
      },
    }),
  });
  expect((await judge.review(input)).kind).toBe("assessment");
  expect([calls, inspected, closed]).toEqual([2, 1, 1]);
});

test("context overflow and persistent transport failure never become denial", async () => {
  let called = 0;
  const llm: LLMProvider = {
    async call() {
      called++;
      throw new Error("transport");
    },
  };
  const overflow = await createJudgeService({ llm, model, maxPayloadCharacters: 8 }).review(input);
  expect(overflow.kind).toBe("context_overflow");
  expect(called).toBe(0);
  const failed = await createJudgeService({ llm, model, maxAttempts: 2 }).review(input);
  expect(failed).toEqual({ kind: "technical_failure", reason: "review_failed" });
  expect(called).toBe(2);
});

test("a cancelled review is not consumed as an allow", async () => {
  const controller = new AbortController();
  const llm: LLMProvider = {
    async call() {
      controller.abort();
      return { usage, text: '{"outcome":"allow"}' };
    },
  };
  const result = await createJudgeService({ llm, model }).review(input, controller.signal);
  expect(result.kind).toBe("cancelled");
});

test("inspection setup failures and interrupted inspections remain technical outcomes", async () => {
  const llm: LLMProvider = {
    async call() {
      return { usage, toolCalls: [{ id: "inspect", name: "read_file", arguments: {} }] };
    },
  };
  const failed = await createJudgeService({
    llm,
    model,
    runner: () => {
      throw new Error("setup");
    },
  }).review(input);
  expect(failed).toEqual({ kind: "technical_failure", reason: "inspection_failed" });
  const controller = new AbortController();
  const cancelled = await createJudgeService({
    llm,
    model,
    runner: () => ({
      tools: [],
      async run() {
        controller.abort();
        return { text: "stale" };
      },
      async close() {},
    }),
  }).review(input, controller.signal);
  expect(cancelled.kind).toBe("cancelled");
});

test("the review deadline stops an in-flight provider call", async () => {
  const llm: LLMProvider = {
    async call(params) {
      await new Promise<void>((resolve) =>
        params.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { usage, text: '{"outcome":"allow"}' };
    },
  };
  expect(await createJudgeService({ llm, model, timeoutMs: 5 }).review(input)).toEqual({
    kind: "technical_failure",
    reason: "deadline_exceeded",
  });
});

test("assessment rejects invalid risk and authorization metadata", () => {
  expect(parseAssessment('{"outcome":"allow","risk_level":"impossible"}')).toBeUndefined();
  expect(parseAssessment('{"outcome":"allow","user_authorization":"none"}')).toBeUndefined();
  expect(parseAssessment('{"outcome":"allow","rationale":1}')).toBeUndefined();
});

test("semantic denials trip after three consecutive or ten in fifty", () => {
  const breaker = new DenialCircuitBreaker();
  expect(breaker.record(true)).toBe(false);
  expect(breaker.record(true)).toBe(false);
  expect(breaker.record(false)).toBe(false);
  expect(breaker.record(true)).toBe(false);
  expect(breaker.record(true)).toBe(false);
  expect(breaker.record(true)).toBe(true);
  const rolling = new DenialCircuitBreaker();
  for (let i = 0; i < 9; i++) {
    expect(rolling.record(true)).toBe(false);
    rolling.record(false);
  }
  expect(rolling.record(true)).toBe(true);
});
