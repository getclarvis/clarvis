import { expect, test } from "bun:test";
import { JUDGE_PORT } from "@clarvis/judge";
import { judgePort } from "../helpers/judge-port.ts";
import {
  createCapabilityServices,
  loadEnv,
  OPERATOR_AUTHORITY_PORT,
  type RunCapabilityContext,
} from "@clarvis/capability";
import type { ConfigStore } from "../../src/config/config-store.ts";
import { createConfigurationReview } from "../../src/configuration/review.ts";
import { createOperatorAuthorityRuntime } from "../../src/guard/operator-authority.ts";
import type { ConfigurationMutationFacts } from "../../src/guard/effects/configuration.ts";

const mutation: ConfigurationMutationFacts = {
  canonicalPath: "/fixture/settings.json",
  root: "workspace_clarvis",
  expectedRevision: null,
  nextRevision: "next",
  bytes: 20,
  operation: "write",
  fieldClass: "settings",
  surface: "operational",
};

test.each(["invalid_response", "timeout", "transport"] as const)(
  "configuration %s failures never ask for repeated consent",
  async (failureKind) => {
    const services = createCapabilityServices();
    const ledger = createOperatorAuthorityRuntime({
      owner: "owner",
      executionId: "run",
      seed: {
        binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
        evidence: [
          { id: "operator", source: "start", text: "Update settings", execution_id: "run" },
        ],
      },
    });
    services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
    services.provide(
      JUDGE_PORT,
      judgePort(undefined, async () => ({
        kind: "failed",
        failureKind,
        attempts: 4,
        elapsedMs: 1,
        cacheHit: false,
      })),
    );
    let questions = 0;
    const ctx = {
      services,
      env: loadEnv({}),
      request: { guard_mode: "auto" },
      requestParam: () => undefined,
      elicit: async () => {
        questions++;
        return { action: "accept" };
      },
    } as unknown as RunCapabilityContext;
    const store = {
      readSettings: () => ({ merged: { effect_review: { on_unsure: "ask" } } }),
    } as ConfigStore;
    await expect(
      createConfigurationReview(ctx, { store })(
        [{ ...mutation, nextRevision: "a".repeat(64) }],
        {},
        "Apply settings?",
      ),
    ).rejects.toThrow(`automatic review failed (${failureKind})`);
    expect(questions).toBe(0);
    expect(ledger.reader.snapshot().envelope).toBeUndefined();
  },
);

test("configuration consumers share pending identical questions but never retain human consent", async () => {
  const services = createCapabilityServices();
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "operator", source: "start", text: "Update settings", execution_id: "run" }],
    },
  });
  services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
  type Answer = Awaited<ReturnType<NonNullable<RunCapabilityContext["elicit"]>>>;
  let answer = Promise.withResolvers<Answer>();
  let questions = 0;
  const ctx = {
    services,
    env: loadEnv({}),
    request: { guard_mode: "on" },
    requestParam: () => undefined,
    elicit: async () => {
      questions++;
      return answer.promise;
    },
  } as unknown as RunCapabilityContext;
  const store = { readSettings: () => ({ merged: {} }) } as ConfigStore;
  const reviewers = [
    createConfigurationReview(ctx, { store }),
    createConfigurationReview(ctx, { store }),
  ];
  const first = Array.from({ length: 8 }, (_, index) =>
    reviewers[index % 2]!([mutation], { path: "settings.json" }, "Apply settings?"),
  );
  const firstCount = questions;
  answer.resolve({ action: "accept", content: { decision: "allow" } });
  await Promise.all(first);
  expect(firstCount).toBe(1);
  answer = Promise.withResolvers<Answer>();
  const later = reviewers[0]!([mutation], { path: "settings.json" }, "Apply settings?");
  expect(questions).toBe(2);
  answer.resolve({ action: "accept", content: { decision: "allow" } });
  await later;
});

test("configuration question identity separates proposals and retires a failed channel", async () => {
  const services = createCapabilityServices();
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "operator", source: "start", text: "Update settings", execution_id: "run" }],
    },
  });
  services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
  type Answer = Awaited<ReturnType<NonNullable<RunCapabilityContext["elicit"]>>>;
  let calls = 0;
  let fail = true;
  const pending: Array<PromiseWithResolvers<Answer>> = [];
  const ctx = {
    services,
    env: loadEnv({}),
    request: { guard_mode: "on" },
    requestParam: () => undefined,
    async elicit() {
      calls++;
      if (fail) throw new Error("question channel unavailable");
      const answer = Promise.withResolvers<Answer>();
      pending.push(answer);
      return answer.promise;
    },
  } as unknown as RunCapabilityContext;
  const store = { readSettings: () => ({ merged: {} }) } as ConfigStore;
  const review = createConfigurationReview(ctx, { store });
  await expect(review([mutation], { path: "settings.json" }, "Apply settings?")).rejects.toThrow(
    "question channel unavailable",
  );
  fail = false;
  const first = review([mutation], { path: "settings.json" }, "Apply settings?");
  const distinct = review(
    [{ ...mutation, canonicalPath: "/fixture/other.json" }],
    { path: "other.json" },
    "Apply other settings?",
  );
  expect(calls).toBe(3);
  expect(pending).toHaveLength(2);
  for (const answer of pending)
    answer.resolve({ action: "accept", content: { decision: "allow" } });
  await Promise.all([first, distinct]);
});

test("a shared late configuration answer cannot outlive controller cancellation", async () => {
  const services = createCapabilityServices();
  const controller = new AbortController();
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    signal: controller.signal,
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "operator", source: "start", text: "Update settings", execution_id: "run" }],
    },
  });
  services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
  type Answer = Awaited<ReturnType<NonNullable<RunCapabilityContext["elicit"]>>>;
  const answer = Promise.withResolvers<Answer>();
  let questions = 0;
  const ctx = {
    services,
    env: loadEnv({}),
    signal: controller.signal,
    request: { guard_mode: "on" },
    requestParam: () => undefined,
    elicit: async () => {
      questions++;
      return answer.promise;
    },
  } as unknown as RunCapabilityContext;
  const store = { readSettings: () => ({ merged: {} }) } as ConfigStore;
  const review = createConfigurationReview(ctx, { store });
  const reviews = Array.from({ length: 8 }, () =>
    review([mutation], { path: "settings.json" }, "Apply settings?"),
  );
  expect(questions).toBe(1);
  controller.abort();
  answer.resolve({ action: "accept", content: { decision: "allow" } });
  const outcomes = await Promise.allSettled(reviews);
  expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
});
