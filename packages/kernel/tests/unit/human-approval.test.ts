import { expect, test } from "bun:test";
import type { ElicitRequest, ElicitRawResult } from "@clarvis/loop";
import { createGuardHumanApproval } from "../../src/guard/human-approval.ts";
import { createGuardSessionAllowlist } from "../../src/guard/guard-elicit.ts";

const request = {
  tool: "shell",
  args: { command: "run check", cwd: "." },
  reason: "Review this effect",
} as ElicitRequest;

test("a failed question is retired so a later attempt can ask again", async () => {
  let questions = 0;
  const approval = createGuardHumanApproval({
    workspaceRoot: "/workspace",
    allowlist: () => undefined,
    elicit: async () => {
      if (++questions === 1) throw new Error("channel failed");
      return { action: "accept", content: { decision: "allow" } };
    },
  });
  await expect(approval.ask(request)).rejects.toThrow("channel failed");
  expect(await approval.ask(request)).toEqual({ allowed: true, persisted: false });
  expect(questions).toBe(2);
});

test("eight identical concurrent effects ask once without caching human consent", async () => {
  let questions = 0;
  const response = Promise.withResolvers<ElicitRawResult>();
  const approval = createGuardHumanApproval({
    workspaceRoot: "/workspace",
    allowlist: () => undefined,
    elicit: async () => {
      questions++;
      return response.promise;
    },
  });
  const answers = Array.from({ length: 8 }, (_, index) =>
    approval.ask(
      index % 2 === 0 ? request : { ...request, args: { cwd: ".", command: "run check" } },
    ),
  );
  expect(questions).toBe(1);
  response.resolve({ action: "accept", content: { decision: "allow" } });
  for (const answer of await Promise.all(answers))
    expect(answer).toEqual({ allowed: true, persisted: false });
  await approval.ask(request);
  expect(questions).toBe(2);
});

test("a new controller scope cannot share or accept the old pending question", async () => {
  let scope = createGuardSessionAllowlist();
  const responses = [
    Promise.withResolvers<ElicitRawResult>(),
    Promise.withResolvers<ElicitRawResult>(),
  ];
  let questions = 0;
  const approval = createGuardHumanApproval({
    workspaceRoot: "/workspace",
    allowlist: () => scope,
    elicit: async () => responses[questions++]!.promise,
  });
  const old = approval.ask(request);
  scope = createGuardSessionAllowlist();
  const current = approval.ask(request);
  expect(questions).toBe(2);
  for (const response of responses)
    response.resolve({ action: "accept", content: { decision: "allow" } });
  expect(await old).toEqual({ allowed: false, persisted: false });
  expect(await current).toEqual({ allowed: true, persisted: false });
});
