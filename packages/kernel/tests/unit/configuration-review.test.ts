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
import { attestConfiguration } from "../../src/guard/effects/configuration.ts";
import { createGuardEffectRegistry } from "../../src/guard/effects/registry.ts";

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

test("human-only configuration deletion goes straight to a person in Auto mode", async () => {
  const services = createCapabilityServices();
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [
        { id: "operator", source: "start", text: "Remove the test settings", execution_id: "run" },
      ],
    },
  });
  services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
  let automaticCalls = 0;
  services.provide(
    JUDGE_PORT,
    judgePort(undefined, async () => {
      automaticCalls++;
      return {
        kind: "failed",
        failureKind: "invalid_response",
        attempts: 1,
        elapsedMs: 1,
        cacheHit: false,
      };
    }),
  );
  let questions = 0;
  const ctx = {
    services,
    workspaceRoot: "/fixture",
    env: loadEnv({}),
    request: { guard_mode: "auto" },
    requestParam: () => undefined,
    elicit: async () => {
      questions++;
      return { action: "accept", content: { decision: "allow" } };
    },
  } as unknown as RunCapabilityContext;
  const store = { readSettings: () => ({ merged: {} }) } as ConfigStore;
  await createConfigurationReview(ctx, { store })(
    [
      {
        ...mutation,
        expectedRevision: "a".repeat(64),
        nextRevision: null,
        bytes: 0,
        operation: "delete",
        surface: "delete",
      },
    ],
    {},
    "Remove test settings?",
  );
  expect(automaticCalls).toBe(0);
  expect(questions).toBe(1);
});

test.each([
  ["file", "/fixture/.agents/skills/probe/SKILL.md", "allow"],
  ["empty directory", "/fixture/.agents/skills/probe", "allow"],
  ["uncertain file", "/fixture/.agents/skills/probe/SKILL.md", "unsure"],
] as const)(
  "Auto handles an attested skill deletion of %s without a human question",
  async (_target, canonicalPath, decision) => {
    const services = createCapabilityServices();
    const ledger = createOperatorAuthorityRuntime({
      owner: "owner",
      executionId: "run",
      seed: {
        binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
        evidence: [
          { id: "operator", source: "start", text: "Remove the test skill", execution_id: "run" },
        ],
      },
    });
    services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
    const skill: ConfigurationMutationFacts = {
      canonicalPath,
      root: "workspace_agents",
      expectedRevision: "a".repeat(64),
      nextRevision: null,
      bytes: 0,
      operation: "delete",
      fieldClass: "skills",
      surface: "authoring_delete",
    };
    const fact = attestConfiguration(skill, createGuardEffectRegistry());
    expect(fact).toMatchObject({
      id: "clarvis.authoring.delete",
      inference: "bounded",
      attestation: "complete",
    });
    services.provide(
      JUDGE_PORT,
      judgePort(undefined, async (_input, context) => {
        const transition =
          context.binding.kind === "compile_effects"
            ? await context.binding.validateAndInstall({
                version: 1,
                revision: ledger.reader.snapshot().revision,
                objectives: [],
                exclusions: [],
                grants: [
                  {
                    id: "skill-delete",
                    effect_id: fact.id,
                    relation: "direct",
                    target_digests: [fact.target!.digest],
                    constraints: fact.constraints,
                    evidence_ids: ["operator"],
                  },
                ],
              })
            : context.binding.transition;
        if (transition === undefined || "rejected" in transition)
          throw new Error("The host rejected a fully attested skill deletion");
        return {
          kind: "reviewed",
          receipt: {
            action: "decide_effects",
            decision,
            relation: "direct",
            grant_ids: ["skill-delete"],
            revision: transition.revision,
            transition_token: transition.transition_token,
          },
          attempts: 1,
          elapsedMs: 0,
          cacheHit: false,
        };
      }),
    );
    const ctx = {
      services,
      workspaceRoot: "/fixture",
      env: loadEnv({}),
      request: { guard_mode: "auto" },
      requestParam: () => undefined,
      elicit: async () => {
        throw new Error("Auto must not ask about an authorized skill deletion");
      },
    } as unknown as RunCapabilityContext;
    const store = {
      readSettings: () => ({ merged: { effect_review: { on_unsure: "ask" } } }),
    } as ConfigStore;
    const reviewed = createConfigurationReview(ctx, { store })([skill], {}, "Remove test skill?");
    if (decision === "allow") await reviewed;
    else await expect(reviewed).rejects.toMatchObject({ code: "denied" });
  },
);

test("Auto refuses an effect without authority instead of asking a human", async () => {
  const services = createCapabilityServices();
  const ctx = {
    services,
    workspaceRoot: "/fixture",
    env: loadEnv({}),
    request: { guard_mode: "auto" },
    requestParam: () => undefined,
    elicit: async () => {
      throw new Error("Missing authority must not become a human question in Auto");
    },
  } as unknown as RunCapabilityContext;
  const store = { readSettings: () => ({ merged: {} }) } as ConfigStore;
  await expect(
    createConfigurationReview(ctx, { store })(
      [{ ...mutation, nextRevision: "a".repeat(64) }],
      {},
      "Apply settings?",
    ),
  ).rejects.toMatchObject({ code: "denied" });
});

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
        ...(failureKind === "invalid_response"
          ? { diagnostic: { category: "output_limit" as const, stage: "full", corrections: 2 } }
          : {}),
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
    ).rejects.toThrow(`automatic review failed (${failureKind}`);
    expect(questions).toBe(0);
    expect(ledger.reader.snapshot().envelope).toBeUndefined();
  },
);

test("identical technical review failures are reused only while facts, context and authority stay current", async () => {
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
  let calls = 0;
  services.provide(
    JUDGE_PORT,
    judgePort(undefined, async () => {
      calls++;
      return {
        kind: "failed",
        failureKind: "invalid_response",
        attempts: 4,
        elapsedMs: 1,
        cacheHit: false,
        diagnostic: {
          category: "authority_constraints",
          stage: "compile",
          corrections: 3,
          rejection: "grant_not_covered",
        },
      };
    }),
  );
  const ctx = {
    services,
    workspaceRoot: "/fixture",
    env: loadEnv({}),
    request: { guard_mode: "auto" },
    requestParam: () => undefined,
  } as unknown as RunCapabilityContext;
  const store = { readSettings: () => ({ merged: {} }) } as ConfigStore;
  const review = createConfigurationReview(ctx, { store });
  const facts = [{ ...mutation, nextRevision: "a".repeat(64) }];
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(review(facts, {}, "Update settings?")).rejects.toMatchObject({
      code: "review_failed",
      fields: { diagnostic_rejection: "grant_not_covered" },
    });
  }
  expect(calls).toBe(1);
  await expect(review(facts, { operation: "copy" }, "Update settings?")).rejects.toMatchObject({
    code: "review_failed",
  });
  expect(calls).toBe(2);
  await expect(
    review([{ ...facts[0]!, nextRevision: "b".repeat(64) }], {}, "Update settings?"),
  ).rejects.toMatchObject({ code: "review_failed" });
  expect(calls).toBe(3);
  ledger.onSteer({
    id: "new-intent",
    message: "Update the same settings",
    agent: "lead",
    iteration: 2,
  });
  await expect(review(facts, {}, "Update settings?")).rejects.toMatchObject({
    code: "review_failed",
  });
  expect(calls).toBe(4);
});

test("configuration review reports an unavailable human channel before mutation", async () => {
  const services = createCapabilityServices();
  const ctx = {
    services,
    workspaceRoot: "/fixture",
    env: loadEnv({}),
    request: { guard_mode: "on" },
    requestParam: () => undefined,
  } as unknown as RunCapabilityContext;
  const store = { readSettings: () => ({ merged: {} }) } as ConfigStore;
  await expect(
    createConfigurationReview(ctx, { store })([mutation], {}, "Apply settings?"),
  ).rejects.toMatchObject({ code: "approval_unavailable" });
});

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

test("session consent covers the accepted operation and target only after commit", async () => {
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
  const decisions = ["allow_session", "allow", "allow", "allow"];
  const schemas: unknown[] = [];
  const ctx = {
    services,
    workspaceRoot: "/fixture",
    env: loadEnv({}),
    request: { guard_mode: "on" },
    requestParam: () => undefined,
    elicit: async (question: { requestedSchema: unknown }) => {
      schemas.push(question.requestedSchema);
      return { action: "accept", content: { decision: decisions.shift() } };
    },
  } as unknown as RunCapabilityContext;
  const store = { readSettings: () => ({ merged: {} }) } as ConfigStore;
  const review = createConfigurationReview(ctx, { store });
  const complete = { ...mutation, nextRevision: "a".repeat(64) };
  const record = await review([complete], {}, "Apply settings?");
  expect(schemas).toHaveLength(1);
  expect(JSON.stringify(schemas[0])).toContain("allow_session");
  expect(record).toBeFunction();
  await review([{ ...complete, nextRevision: "b".repeat(64) }], {}, "Apply settings?");
  expect(schemas).toHaveLength(2);
  record?.();
  await review([{ ...complete, nextRevision: "c".repeat(64) }], {}, "Apply settings?");
  expect(schemas).toHaveLength(2);
  await review(
    [complete, { ...complete, canonicalPath: "/fixture/other.json" }],
    {},
    "Apply both?",
  );
  expect(schemas).toHaveLength(3);
  ledger.onSteer({
    id: "new-intent",
    message: "Update something else",
    agent: "lead",
    iteration: 2,
  });
  await review([complete], {}, "Apply settings?");
  expect(schemas).toHaveLength(4);
  ledger.finalize({ status: "cancelled" });
  await expect(review([complete], {}, "Apply settings?")).rejects.toThrow("no longer active");
});

test("unbounded configuration batches never offer session consent", async () => {
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
  let schema: unknown;
  const ctx = {
    services,
    env: loadEnv({}),
    request: { guard_mode: "on" },
    requestParam: () => undefined,
    elicit: async (question: { requestedSchema: unknown }) => {
      schema = question.requestedSchema;
      return { action: "accept", content: { decision: "allow" } };
    },
  } as unknown as RunCapabilityContext;
  const store = { readSettings: () => ({ merged: {} }) } as ConfigStore;
  const batch = Array.from({ length: 17 }, (_, index) => ({
    ...mutation,
    canonicalPath: `/fixture/config-${index}.json`,
  }));
  await createConfigurationReview(ctx, { store })(batch, {}, "Apply batch?");
  expect(JSON.stringify(schema)).toContain('"deny"');
  expect(JSON.stringify(schema)).not.toContain("allow_session");
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
    "Configuration human review did not complete.",
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
