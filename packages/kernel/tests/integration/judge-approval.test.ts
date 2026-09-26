import { expect, test } from "bun:test";
import type { ActionAuthorizationRequest } from "@clarvis/capability";
import { createApprovalService } from "../../src/execution/approval-service.ts";

function request(
  command: string,
  permissions?: { network: "enabled" },
): ActionAuthorizationRequest {
  return {
    identity: { owner: "owner", executionId: "run", actor: "lead", callId: "call", attempt: 1 },
    tool: "shell",
    arguments: { command },
    command,
    cwd: "/tmp",
    requestedProfile: "sandbox",
    effectiveProfile: "sandbox",
    ...(permissions ? { permissions } : {}),
    reason: "test",
    policyRevision: "policy",
    authorizationRevision: 0,
  };
}

test("auto reviews eligible delta and skips ordinary calls; manual asks operator", async () => {
  let modelCalls = 0;
  let questions = 0;
  const common = {
    owner: "owner",
    executionId: "run",
    policy: "on-request" as const,
    policyRevision: "policy",
    sources: [],
    revision: () => 0,
    backendAvailable: true,
    denyRead: false,
    elicit: async () => {
      questions++;
      return { action: "accept" as const, content: { approved: "yes" } };
    },
    judge: {
      async review() {
        modelCalls++;
        return {
          kind: "assessment" as const,
          assessment: {
            outcome: "allow" as const,
            risk_level: "low" as const,
            user_authorization: "unknown" as const,
            rationale: "bounded",
          },
        };
      },
    },
  };
  const auto = createApprovalService({ ...common, mode: "auto" });
  expect((await auto.authorize(request("echo ok"))).granted).toBe(true);
  expect(modelCalls).toBe(0);
  expect((await auto.authorize(request("echo ok", { network: "enabled" }))).granted).toBe(true);
  expect(modelCalls).toBe(1);
  expect(questions).toBe(0);
  const manual = createApprovalService({ ...common, mode: "manual" });
  expect((await manual.authorize(request("echo ok", { network: "enabled" }))).granted).toBe(true);
  expect(questions).toBe(1);
  expect(modelCalls).toBe(1);
});

test("forbidden and never deny before reviewer; technical failure does not ask operator", async () => {
  let modelCalls = 0;
  let questions = 0;
  const base = {
    owner: "owner",
    executionId: "run",
    policyRevision: "policy",
    revision: () => 0,
    backendAvailable: true,
    denyRead: false,
    mode: "auto" as const,
    elicit: async () => {
      questions++;
      return { action: "accept" as const, content: { approved: "yes" } };
    },
    judge: {
      async review() {
        modelCalls++;
        return { kind: "technical_failure" as const, reason: "provider" };
      },
    },
  };
  const forbidden = createApprovalService({
    ...base,
    policy: "on-request",
    sources: [
      {
        layer: "host",
        file: "host",
        digest: "digest",
        rules: [{ id: "deny", pattern: ["blocked"], decision: "forbidden" }],
      },
    ],
  });
  expect((await forbidden.authorize(request("blocked"))).granted).toBe(false);
  const never = createApprovalService({ ...base, policy: "never", sources: [] });
  expect((await never.authorize(request("echo ok", { network: "enabled" }))).granted).toBe(false);
  expect(modelCalls).toBe(0);
  const failed = createApprovalService({ ...base, policy: "on-request", sources: [] });
  const result = await failed.authorize(request("echo ok", { network: "enabled" }));
  expect(result.granted).toBe(false);
  expect(result.evidence.reason).toBe("judge_technical_failure");
  expect(questions).toBe(0);
});

test("three completed denials stop further reviews without a human fallback", async () => {
  let calls = 0;
  const port = createApprovalService({
    owner: "owner",
    executionId: "run",
    policyRevision: "policy",
    revision: () => 0,
    policy: "on-request",
    sources: [],
    backendAvailable: true,
    denyRead: false,
    mode: "auto",
    judge: {
      async review() {
        calls++;
        return {
          kind: "assessment" as const,
          assessment: {
            outcome: "deny" as const,
            risk_level: "high" as const,
            user_authorization: "unknown" as const,
            rationale: "not authorized",
          },
        };
      },
    },
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const action = {
      ...request("echo ok", { network: "enabled" }),
      identity: { ...request("echo ok").identity, attempt: attempt + 1 },
    };
    expect((await port.authorize(action)).granted).toBe(false);
  }
  expect(port.stopReason?.()).toBe("execution review denial limit reached");
  const fourth = await port.authorize(request("echo ok"));
  expect(fourth.evidence.reason).toBe("review_circuit_open");
  expect(calls).toBe(3);
});

test("a completed denial can be identified for a later scoped authorization without executing it", async () => {
  const denied: string[] = [];
  let reviewed = 0;
  const port = createApprovalService({
    owner: "owner",
    executionId: "run",
    policyRevision: "policy",
    revision: () => 0,
    policy: "on-request",
    sources: [],
    backendAvailable: true,
    denyRead: false,
    mode: "auto",
    onJudgeDenied: (action, reason) => denied.push(`${action.identity.callId}:${reason}`),
    onJudgeReviewed: () => reviewed++,
    judge: {
      async review() {
        return {
          kind: "assessment" as const,
          assessment: {
            outcome: "deny" as const,
            risk_level: "high" as const,
            user_authorization: "unknown" as const,
            rationale: "target unclear",
          },
        };
      },
    },
  });
  expect((await port.authorize(request("rm cache.tmp", { network: "enabled" }))).granted).toBe(
    false,
  );
  expect(reviewed).toBe(1);
  expect(denied).toEqual(["call:judge_denied: target unclear"]);
});
