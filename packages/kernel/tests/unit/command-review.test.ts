import { expect, test } from "bun:test";
import { JudgeArchitectureError, type JudgeCoordinator } from "@clarvis/judge";
import type { ElicitRequest } from "@clarvis/loop";
import { createCommandReview } from "../../src/guard/command-review.ts";
import { createOperatorAuthorityRuntime } from "../../src/guard/operator-authority.ts";
import { judgePort } from "../helpers/judge-port.ts";

function ledger() {
  return createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "input", source: "start", text: "Run tests", execution_id: "run" }],
    },
  });
}
const request = { tool: "shell", args: { command: "bun run test", cwd: "." } } as ElicitRequest;

test("retiring the coordinator never creates a human question", async () => {
  let prompts = 0;
  const port = judgePort(async () => ({
    kind: "failed",
    failureKind: "cancelled",
    elapsedMs: 0,
    attempts: 0,
    cacheHit: false,
  }));
  const review = createCommandReview(
    { judge: () => port, authority: ledger().reader },
    { on_unsure: "ask" },
    async () => {
      prompts++;
      return true;
    },
  );
  expect(await review(request)).toEqual({ allowed: false, answerer: "judge" });
  expect(prompts).toBe(0);
});

test("an authority change prevents a clean allow and a late human answer cannot outlive cancellation", async () => {
  const authority = ledger();
  const abort = new AbortController();
  let prompts = 0;
  const port = judgePort(async () => {
    authority.onSteer({ agent: "lead", iteration: 1, message: "Do not run tests" });
    return {
      kind: "reviewed",
      receipt: { action: "decide_command", decision: "allow" },
      elapsedMs: 0,
      attempts: 1,
      cacheHit: false,
    };
  });
  const review = createCommandReview(
    { judge: () => port, authority: authority.reader, signal: abort.signal },
    { on_unsure: "ask" },
    async () => {
      prompts++;
      abort.abort();
      return true;
    },
  );
  expect(await review(request)).toEqual({ allowed: false, answerer: "human" });
  expect(prompts).toBe(1);
});

test.each([
  ["allow", "ask", true, 0],
  ["deny", "ask", false, 0],
  ["unsure", "ask", true, 1],
  ["invalid_response", "ask", true, 1],
  ["transport", "ask", true, 1],
  ["unsure", "deny", false, 0],
  ["invalid_response", "deny", false, 0],
  ["transport", "deny", false, 0],
] as const)(
  "eight concurrent reviews preserve %s/%s outcome and human count",
  async (outcome, fallback, allowed, humans) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reviews = 0;
    let prompts = 0;
    const port: JudgeCoordinator = {
      async reviewCommand() {
        reviews++;
        entered.resolve();
        await release.promise;
        const metrics = { elapsedMs: 1, attempts: 1, cacheHit: false };
        if (outcome === "invalid_response" || outcome === "transport")
          return { ...metrics, kind: "failed", failureKind: outcome };
        return {
          ...metrics,
          kind: "reviewed",
          receipt: { action: "decide_command", decision: outcome },
        };
      },
      async reviewEffects() {
        throw new Error("unexpected effects");
      },
      async close() {},
    };
    const review = createCommandReview(
      { judge: () => port, authority: ledger().reader },
      { on_unsure: fallback },
      async () => {
        prompts++;
        return true;
      },
    );
    const first = review(request);
    await entered.promise;
    const others = Array.from({ length: 7 }, () =>
      review({ ...request, args: { cwd: ".", command: "bun run test" } }),
    );
    release.resolve();
    for (const answer of await Promise.all([first, ...others]))
      expect(answer).toEqual({
        allowed,
        answerer: humans === 0 ? "judge" : "human",
        ...((outcome === "invalid_response" || outcome === "transport") && fallback === "deny"
          ? { review: { failure_kind: outcome } }
          : {}),
      });
    expect(reviews).toBe(1);
    expect(prompts).toBe(humans);
    await review(request);
    expect(reviews).toBe(2);
    expect(prompts).toBe(humans * 2);
  },
);

test("missing port and architecture faults never elicit; lookup happens at review time", async () => {
  let port: JudgeCoordinator | undefined = undefined;
  let prompts = 0;
  const review = createCommandReview(
    { judge: () => port, authority: ledger().reader },
    { on_unsure: "ask" },
    async () => {
      prompts++;
      return true;
    },
  );
  expect(() => review(request)).toThrow(JudgeArchitectureError);
  port = {
    async reviewCommand() {
      throw new JudgeArchitectureError();
    },
    async reviewEffects() {
      throw new Error("unexpected effects");
    },
    async close() {},
  };
  await expect(review(request)).rejects.toBeInstanceOf(JudgeArchitectureError);
  expect(prompts).toBe(0);
});
