import { recordingLogger } from "../helpers/logger.ts";
import { effectReviewAuditSchema } from "../../src/guard/review-audit-schema.ts";
import { expect, test } from "bun:test";
import { JudgeArchitectureError, type JudgeEffectReceipt } from "@clarvis/judge";
import type { AuthorityEnvelopeV1 } from "@clarvis/capability";
import { createHostEffectReview } from "../../src/guard/effect-review.ts";
import { createOperatorAuthorityRuntime } from "../../src/guard/operator-authority.ts";
import { createGuardEffectRegistry } from "../../src/guard/effects/registry.ts";
import type { GuardEffectBatch } from "../../src/guard/effects/types.ts";
import { judgePort } from "../helpers/judge-port.ts";
import { configurationFact } from "../helpers/configuration-mutation.ts";
function fixture(change?: (receipt: JudgeEffectReceipt) => void) {
  const authority = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [
        {
          id: "operator",
          source: "start",
          text: "Update the workspace settings",
          execution_id: "run",
        },
      ],
    },
  });
  const registry = createGuardEffectRegistry();
  const fact = configurationFact(registry);
  const batch: GuardEffectBatch = { reviewability: "static", facts: [fact] };
  const candidate: AuthorityEnvelopeV1 = {
    version: 1,
    revision: authority.reader.snapshot().revision,
    objectives: [],
    exclusions: [],
    grants: [
      {
        id: "grant",
        effect_id: fact.id,
        relation: "direct",
        target_digests: [fact.target!.digest],
        constraints: fact.constraints,
        evidence_ids: ["operator"],
      },
    ],
  };
  let compiles = 0;
  let decisions = 0;
  const port = judgePort(undefined, async (_input, context) => {
    const metrics = { elapsedMs: 0, attempts: 1, cacheHit: false };
    let transition;
    if (context.binding.kind === "compile_effects") {
      compiles++;
      transition = await context.binding.validateAndInstall(candidate);
    } else transition = context.binding.transition;
    if (transition === undefined)
      return { ...metrics, kind: "failed", failureKind: "invalid_response" };
    decisions++;
    const receipt: JudgeEffectReceipt = {
      action: "decide_effects",
      decision: "allow",
      relation: "direct",
      grant_ids: ["grant"],
      revision: transition.revision,
      transition_token: transition.transition_token,
    };
    change?.(receipt);
    return { ...metrics, kind: "reviewed", receipt };
  });
  const deps = {
    authority: authority.reader,
    registry,
    judge: () => port,
  };
  return {
    authority,
    batch,
    candidate,
    deps,
    create: () => createHostEffectReview(deps),
    counts: () => ({ compiles, decisions }),
  };
}

test("configuration review and refusals share the host ledger across services", async () => {
  const f = fixture();
  expect((await f.create().review(f.batch, {}, "configure_clarvis")).decision).toBe("allow");
  expect((await f.create().review(f.batch, {}, "configure_clarvis")).decision).toBe("allow");
  expect(f.counts()).toEqual({ compiles: 1, decisions: 2 });
  f.create().refuse(f.batch, f.authority.reader.snapshot().revision);
  expect((await f.create().review(f.batch, {}, "configure_clarvis")).decision).toBe("deny");
  expect(f.counts()).toEqual({ compiles: 1, decisions: 2 });
});

test("a reused receipt remains bound when equivalent call properties are reordered", async () => {
  const f = fixture();
  const port = f.deps.judge();
  const original = port.reviewEffects.bind(port);
  let saved: Awaited<ReturnType<typeof original>> | undefined;
  port.reviewEffects = async (input, context) => (saved ??= await original(input, context));
  expect(
    (
      await f
        .create()
        .review(
          f.batch,
          { surface: "operational", target: { path: ".clarvis/settings.json" } },
          "configure_clarvis",
        )
    ).decision,
  ).toBe("allow");
  expect(
    (
      await f
        .create()
        .review(
          f.batch,
          { target: { path: ".clarvis/settings.json" }, surface: "operational" },
          "configure_clarvis",
        )
    ).decision,
  ).toBe("allow");
  expect(f.counts()).toEqual({ compiles: 1, decisions: 1 });
});

test.each(["grant", "relation", "revision", "token"] as const)(
  "host rejects an invalid %s despite a purported allow",
  async (field) => {
    const f = fixture((receipt) => {
      if (field === "grant") receipt.grant_ids = ["invented"];
      if (field === "relation") receipt.relation = "bounded_prerequisite";
      if (field === "revision") receipt.revision++;
      if (field === "token") receipt.transition_token = "invented";
    });
    expect(await f.create().review(f.batch, {}, "configure_clarvis")).toMatchObject({
      decision: "unsure",
      failure_kind: "invalid_response",
    });
  },
);

test("an installed exclusion denies without a decide call or human fallback", async () => {
  const f = fixture();
  f.candidate.exclusions = [{ effect_id: "clarvis.operational_config.write" }];
  expect((await f.create().review(f.batch, {}, "configure_clarvis")).decision).toBe("deny");
  expect(f.counts()).toEqual({ compiles: 1, decisions: 0 });
  expect(f.authority.reader.snapshot().envelope?.exclusions).toEqual(f.candidate.exclusions);
});

test("missing composition throws instead of returning unsure", async () => {
  const f = fixture();
  const review = createHostEffectReview({ ...f.deps, judge: () => undefined });
  await expect(review.review(f.batch, {}, "configure_clarvis")).rejects.toBeInstanceOf(
    JudgeArchitectureError,
  );
});

test.each(["compile", "decide"] as const)(
  "failure audit identifies %s without provider prose",
  async (stage) => {
    const f = fixture((receipt) => {
      receipt.grant_ids = ["invalid"];
    });
    const audit = recordingLogger();
    if (stage === "compile")
      f.deps.judge().reviewEffects = async () => ({
        kind: "failed",
        failureKind: "transport",
        elapsedMs: 1,
        attempts: 1,
        cacheHit: false,
      });
    const review = createHostEffectReview({ ...f.deps, audit });
    expect(
      (await review.review(f.batch, { secret: "PRIVATE_CASE" }, "configure_clarvis")).decision,
    ).toBe("unsure");
    const events = audit.events("effect_review.reviewer.failed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage,
      failure_kind: stage === "compile" ? "transport" : "invalid_response",
      attempts: 1,
    });
    expect(effectReviewAuditSchema.safeParse(events[0]).success).toBe(true);
    expect(JSON.stringify(audit.records)).not.toContain("PRIVATE_CASE");
  },
);

test("human-only facts never enter semantic inference", async () => {
  const f = fixture();
  f.batch.reviewability = "human_only";
  expect((await f.create().review(f.batch, {}, "configure_clarvis")).decision).toBe("unsure");
  expect(f.counts()).toEqual({ compiles: 0, decisions: 0 });
});

test("the audit schema admits a configuration attested event and rejects removed effects and the command consumer", () => {
  const f = fixture();
  const audit = recordingLogger();
  createHostEffectReview({ ...f.deps, audit }).attest(f.batch.facts[0]!, "configure_clarvis");
  const [event] = audit.events("effect_review.effect.attested");
  expect(effectReviewAuditSchema.safeParse(event).success).toBe(true);
  expect(effectReviewAuditSchema.safeParse({ ...event, effect_id: "git.push" }).success).toBe(
    false,
  );
  expect(effectReviewAuditSchema.safeParse({ ...event, consumer: "command_guard" }).success).toBe(
    false,
  );
});

test("a refusal without a host ledger stays bounded and loud", () => {
  const registry = createGuardEffectRegistry();
  const review = createHostEffectReview({ registry, judge: () => undefined });
  const batch = (index: number): GuardEffectBatch => ({
    reviewability: "static",
    facts: [configurationFact(registry, { canonicalPath: `.clarvis/settings-${index}.json` })],
  });
  for (let index = 0; index < 32; index++) {
    review.refuse(batch(index), 0);
    expect(review.wasRefused(batch(index))).toBe(true);
  }
  expect(() => review.refuse(batch(32), 0)).toThrow("Configuration refusal budget exhausted.");
});
