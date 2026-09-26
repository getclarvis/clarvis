import { expect, test } from "bun:test";
import type { ActionAuthorizationRequest } from "@clarvis/capability";
import { createApprovalService } from "../../src/execution/approval-service.ts";

function action(command: string, revision = 0): ActionAuthorizationRequest {
  return {
    identity: { owner: "owner", executionId: "run", actor: "lead", callId: "call", attempt: 1 },
    tool: "shell",
    arguments: { command },
    command,
    cwd: "/tmp",
    requestedProfile: "sandbox",
    effectiveProfile: "sandbox",
    reason: "test",
    policyRevision: "policy",
    authorizationRevision: revision,
  };
}

test("ordinary commands pass without a question and forbidden rules never reach reviewer", async () => {
  let questions = 0;
  const port = createApprovalService({
    owner: "owner",
    executionId: "run",
    policy: "on-request",
    policyRevision: "policy",
    sources: [
      {
        layer: "host",
        file: "host",
        digest: "digest",
        rules: [
          {
            id: "block",
            pattern: ["blocked"],
            decision: "forbidden",
          },
        ],
      },
    ],
    revision: () => 0,
    backendAvailable: true,
    denyRead: false,
    elicit: async () => {
      questions++;
      return { action: "accept", content: { approved: "yes" } };
    },
  });
  const ordinary = action("echo hello");
  const allowed = await port.authorize(ordinary);
  expect(allowed.granted).toBe(true);
  expect(port.valid(ordinary, allowed)).toBe(true);
  expect((await port.authorize(action("blocked arg"))).granted).toBe(false);
  expect(questions).toBe(0);
});

test("permission grants require manual consent and cannot survive steering", async () => {
  let revision = 0;
  const port = createApprovalService({
    owner: "owner",
    executionId: "run",
    policy: "on-request",
    policyRevision: "policy",
    sources: [],
    revision: () => revision,
    backendAvailable: true,
    denyRead: false,
    elicit: async () => {
      revision++;
      return { action: "accept", content: { approved: "yes" } };
    },
  });
  const request = { ...action("echo hello"), permissions: { network: "enabled" as const } };
  const decision = await port.authorize(request);
  expect(decision.granted).toBe(false);
  expect(port.valid(request, decision)).toBe(false);
});

test("never refuses a permission request without elicitation", async () => {
  let questions = 0;
  const port = createApprovalService({
    owner: "owner",
    executionId: "run",
    policy: "never",
    policyRevision: "policy",
    sources: [],
    revision: () => 0,
    backendAvailable: true,
    denyRead: false,
    elicit: async () => {
      questions++;
      return { action: "accept", content: { approved: "yes" } };
    },
  });
  expect(
    (await port.authorize({ ...action("echo hello"), permissions: { host: true } })).granted,
  ).toBe(false);
  expect(questions).toBe(0);
});

test("a reviewed delta is reused for the same action and allow bypass keeps deny-read", async () => {
  let questions = 0;
  const sources = [
    {
      layer: "global" as const,
      file: "rules",
      digest: "digest",
      rules: [
        {
          id: "git_status",
          pattern: ["git", "status"],
          decision: "allow" as const,
        },
      ],
    },
  ];
  const make = (denyRead: boolean) =>
    createApprovalService({
      owner: "owner",
      executionId: "run",
      policy: "on-request" as const,
      policyRevision: "policy",
      sources,
      revision: () => 0,
      backendAvailable: true,
      denyRead,
      elicit: async () => {
        questions++;
        return { action: "accept", content: { approved: "yes" } };
      },
    });
  const request = { ...action("git status"), permissions: { network: "enabled" as const } };
  const reviewed = make(false);
  const decision = await reviewed.authorize(request);
  expect(decision.granted).toBe(true);
  expect(reviewed.valid(request, decision)).toBe(true);
  expect(questions).toBe(1);
  expect((await make(false).authorize(action("git status"))).permissions).toEqual({ host: true });
  expect((await make(true).authorize(action("git status"))).permissions).toBeUndefined();
});

test("manual remember binds a shown literal prefix and a failed write keeps one-time approval", async () => {
  const prompts: string[] = [];
  const remembered: string[][] = [];
  const port = createApprovalService({
    owner: "owner",
    executionId: "run",
    policy: "untrusted",
    policyRevision: "policy",
    sources: [],
    revision: () => 0,
    backendAvailable: true,
    denyRead: false,
    elicit: async (params) => {
      prompts.push(params.message);
      return { action: "accept", content: { approved: "remember" } };
    },
    rememberPrefix: async (_request, prefix) => {
      remembered.push([...prefix]);
      throw new Error("disk unavailable");
    },
  });
  const decision = await port.authorize(action("git status"));
  expect(decision.granted).toBe(true);
  expect(decision.evidence.reason).toBe("review_approved_remember_failed");
  expect(prompts[0]).toContain("global rules, argv prefix");
  expect(remembered).toEqual([["git", "status"]]);
});

test("manual remember is absent for a composed command", async () => {
  let message = "";
  const port = createApprovalService({
    owner: "owner",
    executionId: "run",
    policy: "untrusted",
    policyRevision: "policy",
    sources: [],
    revision: () => 0,
    backendAvailable: true,
    denyRead: false,
    elicit: async (params) => {
      message = params.message;
      return { action: "accept", content: { approved: "yes" } };
    },
    rememberPrefix: async () => {
      throw new Error("must not persist");
    },
  });
  expect((await port.authorize(action("echo one && echo two"))).granted).toBe(true);
  expect(message).not.toContain("Remembered allow:");
});

test("a mode change routes only later actions through judge", async () => {
  let mode: "manual" | "auto" = "manual";
  let questions = 0;
  let reviews = 0;
  const port = createApprovalService({
    owner: "owner",
    executionId: "run",
    policy: "on-request",
    policyRevision: () => mode,
    mode: () => mode,
    sources: [],
    revision: () => 0,
    backendAvailable: true,
    denyRead: false,
    elicit: async () => {
      questions++;
      return { action: "accept", content: { approved: "yes" } };
    },
    judge: {
      review: async () => {
        reviews++;
        return {
          kind: "assessment",
          assessment: {
            outcome: "allow",
            risk_level: "medium",
            user_authorization: "medium",
            rationale: "bounded",
          },
        };
      },
    },
  });
  expect(
    (await port.authorize({ ...action("rm -rf cache"), policyRevision: port.policyRevision }))
      .granted,
  ).toBe(true);
  expect([questions, reviews]).toEqual([1, 0]);
  mode = "auto";
  expect(
    (await port.authorize({ ...action("rm -rf cache"), policyRevision: port.policyRevision }))
      .granted,
  ).toBe(true);
  expect([questions, reviews]).toEqual([1, 1]);
});
