import { expect, test } from "bun:test";
import type { AuthorityEnvelopeV1 } from "@clarvis/capability";
import {
  createOperatorAuthorityRuntime,
  installAuthorityEnvelope,
} from "../../src/guard/operator-authority.ts";
import {
  createAuthorityReviewTransaction,
  installedAuthorityTransition,
} from "../../src/guard/authority-review-transaction.ts";
import { createGuardEffectRegistry } from "../../src/guard/effects/registry.ts";

function fixture() {
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "input", source: "start", text: "Inspect", execution_id: "run" }],
    },
  });
  let revision = "plan-1";
  const envelope: AuthorityEnvelopeV1 = {
    version: 1,
    revision: ledger.reader.snapshot().revision,
    objectives: [],
    grants: [],
    exclusions: [],
  };
  const make = (caseDigest = "case-1") =>
    createAuthorityReviewTransaction({
      authority: ledger.reader,
      registry: createGuardEffectRegistry(),
      batch: {
        facts: [
          {
            id: "git.commit",
            class: "local_mutation",
            inference: "bounded",
            target: { kind: "repository", digest: "target" },
            constraints: {},
            attestation: "complete",
            reviewability: "static",
            analysis_issues: [],
          },
        ],
        reviewability: "static",
      },
      caseDigest,
      expectedAuthorityRevision: ledger.reader.snapshot().revision,
      expectedReviewContextRevision: revision,
      reviewContext: () => ({ snapshot: () => ({ revision, contexts: [] }) }),
    });
  return {
    ledger,
    envelope,
    make,
    changePlan: () => {
      revision = "plan-2";
    },
  };
}

test("compile returns one ledger-bound transition and another case cannot reuse its token", () => {
  const f = fixture();
  const transaction = f.make();
  const transition = transaction.validateAndInstall(f.envelope)!;
  expect(transition.envelope).toEqual(f.envelope);
  expect(transaction.isCurrent(transition)).toBe(true);
  expect(f.make().isCurrent(transition)).toBe(true);
  expect(f.make("case-2").isCurrent(transition)).toBe(false);
  expect(transaction.validateAndInstall(f.envelope)).toBeUndefined();
  transition.envelope.exclusions.push({ effect_id: "git.push" });
  expect(f.ledger.reader.snapshot().envelope?.exclusions).toEqual([]);
});

test("invalid candidates can be corrected before the single installation", () => {
  const f = fixture();
  const transaction = f.make();
  expect(transaction.validateAndInstall({ ...f.envelope, version: 2 })).toBeUndefined();
  expect(f.ledger.reader.snapshot().envelope).toBeUndefined();
  expect(transaction.validateAndInstall(f.envelope)).toBeDefined();
  expect(transaction.validateAndInstall(f.envelope)).toBeUndefined();
});

test("authority or Plans changes fence compilation before installation", () => {
  for (const change of ["authority", "plan"] as const) {
    const f = fixture();
    const transaction = f.make();
    if (change === "authority") f.ledger.onSteer({ agent: "lead", iteration: 1, message: "Stop" });
    else f.changePlan();
    expect(transaction.validateAndInstall(f.envelope)).toBeUndefined();
    expect(f.ledger.reader.snapshot().envelope).toBeUndefined();
  }
});

test("an intervening installation at the same revision cannot be overwritten", () => {
  const f = fixture();
  const transaction = f.make();
  expect(
    installAuthorityEnvelope(
      f.ledger.reader,
      { ...f.envelope, exclusions: [{ effect_id: "git.push" }] },
      "plan-1",
    ),
  ).toBe(true);
  expect(transaction.validateAndInstall(f.envelope)).toBeUndefined();
  expect(f.ledger.reader.snapshot().envelope?.exclusions).toEqual([{ effect_id: "git.push" }]);
});

test("post-install context changes invalidate the receipt without rolling back the envelope", () => {
  const f = fixture();
  const transaction = f.make();
  const transition = transaction.validateAndInstall(f.envelope)!;
  f.changePlan();
  expect(transaction.isCurrent(transition)).toBe(false);
  expect(f.ledger.reader.snapshot().envelope).toBeDefined();
  expect(installedAuthorityTransition(f.ledger.reader, "case-1", "plan-2")).toBeUndefined();
});

test("the compile's own authenticated outcome revision remains current", () => {
  const f = fixture();
  const initial = {
    ...f.envelope,
    objectives: [
      { id: "old", summary: "Old", target_digests: ["target"], evidence_ids: ["input"] },
    ],
  };
  expect(installAuthorityEnvelope(f.ledger.reader, initial, "plan-1")).toBe(true);
  f.ledger.onSteer({ agent: "lead", iteration: 1, message: "New objective" });
  const before = f.ledger.reader.snapshot();
  const transaction = f.make();
  const transition = transaction.validateAndInstall({
    ...initial,
    revision: before.revision,
    objectives: [
      { ...initial.objectives[0]!, id: "new", evidence_ids: [before.evidence.at(-1)!.id] },
    ],
  })!;
  expect(transition.revision).toBe(before.revision + 1);
  expect(transaction.isCurrent(transition)).toBe(true);
  f.ledger.onSteer({ agent: "lead", iteration: 2, message: "Stop" });
  expect(transaction.isCurrent(transition)).toBe(false);
});
