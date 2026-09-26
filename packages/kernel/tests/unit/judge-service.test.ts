import { expect, test } from "bun:test";
import type { RunCapabilityContext } from "@clarvis/capability";
import { createRunJudge, runAuthorizationEvidence } from "../../src/execution/judge-service.ts";

test("the run judge resolves only a model declared for the current execution", () => {
  const ctx = {
    request: {
      entry: "lead",
      profiles: [{ name: "lead", model: "fixture/reviewer" }],
      providers: [
        {
          name: "fixture",
          kind: "openai-compatible",
          models: {
            reviewer: { context_window_tokens: 8192, max_output_tokens: 512, capabilities: [] },
          },
        },
      ],
      messages: [
        { role: "system", content: "System instructions" },
        { role: "user", content: "Approve the task" },
        { role: "assistant", content: "I will inspect" },
      ],
    },
    llm: {
      async call() {
        throw new Error("unused");
      },
    },
  } as unknown as RunCapabilityContext;
  const runnerOptions = { workspaceRoot: "/tmp", globalRoot: "/tmp", denyReadPaths: [] };
  expect(createRunJudge(ctx, {}, undefined, runnerOptions)).toHaveProperty("review");
  expect(runAuthorizationEvidence(ctx)).toEqual([
    { role: "host", content: "System instructions" },
    { role: "user", content: "Approve the task" },
    { role: "assistant", content: "I will inspect" },
  ]);
  expect(() =>
    createRunJudge(
      { ...ctx, request: { ...ctx.request, profiles: [] } },
      {},
      undefined,
      runnerOptions,
    ),
  ).toThrow("requires a resolved parent model");
  expect(() => createRunJudge(ctx, { model: "fixture/missing" }, undefined, runnerOptions)).toThrow(
    "not in the execution catalog",
  );
});
