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

function fixture(change?: (receipt: JudgeEffectReceipt) => void) {
  const authority = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [
        { id: "operator", source: "start", text: "Commit the changes", execution_id: "run" },
      ],
    },
  });
  const batch: GuardEffectBatch = {
    reviewability: "static",
    facts: [
      {
        id: "git.commit",
        class: "local_mutation",
        inference: "bounded",
        target: { kind: "repository", digest: "target" },
        constraints: { head_sha: "a".repeat(40) },
        attestation: "complete",
        reviewability: "static",
        analysis_issues: [],
      },
    ],
  };
  const candidate: AuthorityEnvelopeV1 = {
    version: 1,
    revision: authority.reader.snapshot().revision,
    objectives: [],
    exclusions: [],
    grants: [
      {
        id: "grant",
        effect_id: "git.commit",
        relation: "direct",
        target_digests: ["target"],
        constraints: batch.facts[0]!.constraints,
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
    registry: createGuardEffectRegistry(),
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

test("separate consumers reuse the ledger and share exact refusals without a WeakMap service", async () => {
  const f = fixture();
  expect((await f.create().review(f.batch, {}, "command_guard")).decision).toBe("allow");
  expect((await f.create().review(f.batch, {}, "configure_clarvis")).decision).toBe("allow");
  expect(f.counts()).toEqual({ compiles: 1, decisions: 2 });
  f.create().refuse(f.batch, f.authority.reader.snapshot().revision);
  expect((await f.create().review(f.batch, {}, "command_guard")).decision).toBe("deny");
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
          { tool: "shell", args: { command: "git commit", cwd: "." } },
          "command_guard",
        )
    ).decision,
  ).toBe("allow");
  expect(
    (
      await f
        .create()
        .review(
          f.batch,
          { args: { cwd: ".", command: "git commit" }, tool: "shell" },
          "command_guard",
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
    expect(await f.create().review(f.batch, {}, "command_guard")).toMatchObject({
      decision: "unsure",
      failure_kind: "invalid_response",
    });
  },
);

test("an installed exclusion denies without a decide call or human fallback", async () => {
  const f = fixture();
  f.candidate.exclusions = [{ effect_id: "git.commit" }];
  expect((await f.create().review(f.batch, {}, "command_guard")).decision).toBe("deny");
  expect(f.counts()).toEqual({ compiles: 1, decisions: 0 });
  expect(f.authority.reader.snapshot().envelope?.exclusions).toEqual(f.candidate.exclusions);
});

test("missing composition throws instead of returning unsure", async () => {
  const f = fixture();
  const review = createHostEffectReview({ ...f.deps, judge: () => undefined });
  await expect(review.review(f.batch, {}, "command_guard")).rejects.toBeInstanceOf(
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
      (await review.review(f.batch, { secret: "PRIVATE_CASE" }, "command_guard")).decision,
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

test("one-attempt effects are consumed once across concurrent consumers", async () => {
  const f = fixture();
  const constraints = { failed_only: true, attempts: 1, head_sha: "a".repeat(40), run_id: "7" };
  Object.assign(f.batch.facts[0]!, {
    id: "github.actions.rerun_failed",
    class: "external_mutation",
    constraints,
  });
  Object.assign(f.candidate.grants[0]!, { effect_id: "github.actions.rerun_failed", constraints });
  const answers = await Promise.all([
    f.create().review(f.batch, {}, "command_guard"),
    f.create().review(f.batch, {}, "command_guard"),
  ]);
  expect(answers.filter((answer) => answer.decision === "allow")).toHaveLength(1);
  expect(f.authority.reader.snapshot().consumed_effects).toHaveLength(1);
  expect((await f.create().review(f.batch, {}, "command_guard")).decision).toBe("unsure");
});
