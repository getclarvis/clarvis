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
  );
  expect(await review(request)).toEqual({
    allowed: false,
    answerer: "judge",
    review: { failure_kind: "cancelled", reviewer_decision: "failed" },
  });
});

test("an authority change prevents a clean allow and does not elicit a person", async () => {
  const authority = ledger();
  const abort = new AbortController();
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
  );
  expect(await review(request)).toEqual({
    allowed: false,
    answerer: "judge",
    review: { reviewer_decision: "unsure" },
  });
});

test.each([
  ["allow", "ask", true],
  ["deny", "ask", false],
  ["unsure", "ask", false],
  ["invalid_response", "ask", false],
  ["transport", "ask", false],
  ["unsure", "deny", false],
  ["invalid_response", "deny", false],
  ["transport", "deny", false],
] as const)(
  "eight concurrent reviews preserve %s/%s outcome without a human",
  async (outcome, fallback, allowed) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reviews = 0;
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
        answerer: "judge",
        review:
          outcome === "invalid_response" || outcome === "transport"
            ? { failure_kind: outcome, reviewer_decision: "failed" }
            : { reviewer_decision: outcome },
      });
    expect(reviews).toBe(1);
    await review(request);
    expect(reviews).toBe(2);
  },
);

test("missing port and architecture faults never elicit; lookup happens at review time", async () => {
  let port: JudgeCoordinator | undefined = undefined;
  const review = createCommandReview(
    { judge: () => port, authority: ledger().reader },
    { on_unsure: "ask" },
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
});
