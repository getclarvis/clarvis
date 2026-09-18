import {
  JudgeArchitectureError,
  canonicalJudgeJson,
  type JudgeCoordinator,
  type JudgeEffectReceipt,
  type JudgeJson,
  type CompiledAuthorityTransition,
} from "@clarvis/judge";
import { NOOP_LOGGER, type OperatorAuthorityReader, type Logger } from "@clarvis/capability";
import type { GuardJudgeConfig } from "@clarvis/judge/settings";
import type { ReviewerFailureKind } from "./reviewer-trace.ts";

/** Host operational receipt; contains no case payload and grants no authority by itself. */
export interface EffectReviewReceipt {
  decision: "allow" | "deny" | "unsure";
  relation: "direct" | "bounded_prerequisite" | "none";
  revision: number;
  failure_kind?: ReviewerFailureKind;
  elapsed_ms: number;
  attempts: number;
}
import {
  createAuthorityReviewTransaction,
  installedAuthorityTransition,
} from "./authority-review-transaction.ts";
import { consumeAuthorityEffects, denyAuthorityEffect } from "./operator-authority.ts";
import {
  reviewerAuthoritySnapshot,
  reviewerContextIsCurrent,
  reviewerContextSnapshot,
  type ReviewerContextSource,
} from "./review-context.ts";
import type { GuardEffectRegistry } from "./effects/registry.ts";
import type { GuardEffectBatch, GuardEffectFact } from "./effects/types.ts";
import { effectDigest } from "./effects/facts.ts";
import { refusalKey } from "./effect-refusal.ts";

/** The host owns effect policy and consumption; inference and semantic receipt caches belong to Judge. */
export function createHostEffectReview(deps: {
  judge(): JudgeCoordinator | undefined;
  authority?: OperatorAuthorityReader;
  reviewContext?: ReviewerContextSource;
  registry: GuardEffectRegistry;
  audit?: Logger;
  signal?: AbortSignal;
  options?: GuardJudgeConfig;
}) {
  const audit = deps.audit ?? NOOP_LOGGER;
  const unboundRefusals = new Set<string>();
  const wasRefused = (batch: GuardEffectBatch) =>
    deps.authority?.snapshot().denied_effects?.includes(refusalKey(batch)) === true ||
    unboundRefusals.has(refusalKey(batch));
  return Object.freeze({
    wasRefused,
    refuse(batch: GuardEffectBatch, revision: number): void {
      const key = refusalKey(batch);
      if (deps.authority !== undefined) {
        denyAuthorityEffect(deps.authority, revision, key);
        return;
      }
      if (unboundRefusals.size >= 32) throw new Error("Configuration refusal budget exhausted.");
      unboundRefusals.add(key);
    },
    attest(fact: GuardEffectFact, consumer: "command_guard" | "configure_clarvis"): void {
      audit.info(
        {
          event: "effect_review.effect.attested",
          consumer,
          effect_id: fact.id,
          class: fact.class,
          inference: fact.inference,
          attestation: fact.attestation,
          target_digest: fact.target?.digest,
        },
        "effect attested",
      );
    },
    async review(
      batch: GuardEffectBatch,
      call: unknown,
      consumer: "command_guard" | "configure_clarvis",
      reserve = true,
    ): Promise<EffectReviewReceipt> {
      const started = performance.now();
      const authority = deps.authority;
      const state = authority?.snapshot();
      let revision = state?.revision ?? 0;
      let attempts = 0;
      const receipt = (
        decision: EffectReviewReceipt["decision"],
        relation: EffectReviewReceipt["relation"] = "none",
        failure_kind?: EffectReviewReceipt["failure_kind"],
      ): EffectReviewReceipt => ({
        decision,
        relation,
        revision,
        attempts,
        elapsed_ms: Math.round(performance.now() - started),
        ...(failure_kind === undefined ? {} : { failure_kind }),
      });
      if (wasRefused(batch)) return receipt("deny");
      if (deps.signal?.aborted) return receipt("unsure", "none", "cancelled");
      if (
        authority === undefined ||
        state?.status !== "active" ||
        state.evidence.length === 0 ||
        batch.reviewability === "human_only" ||
        batch.facts.length === 0 ||
        batch.facts.some(
          (fact) => fact.attestation !== "complete" || fact.inference === "human_only",
        )
      )
        return receipt("unsure");
      const port = deps.judge();
      if (port === undefined) throw new JudgeArchitectureError();
      const context = reviewerContextSnapshot(state.review_context, deps.reviewContext);
      const currentCase = JSON.parse(JSON.stringify({ effects: batch.facts, call })) as JudgeJson;
      const caseDigest = effectDigest(canonicalJudgeJson(currentCase));
      const limitedKeys = batch.facts
        .filter((fact) => fact.id === "github.actions.rerun_failed")
        .map((fact) => effectDigest(fact.id, fact.target!.digest));
      if (limitedKeys.some((key) => state.consumed_effects?.includes(key)))
        return receipt("unsure");
      const transaction = createAuthorityReviewTransaction({
        authority,
        registry: deps.registry,
        batch,
        caseDigest,
        expectedAuthorityRevision: revision,
        expectedReviewContextRevision: context.live_revision,
        reviewContext: deps.reviewContext,
        signal: deps.signal,
      });
      const installed = () =>
        installedAuthorityTransition(authority, caseDigest, context.live_revision);
      let transition = installed();
      let compileInstalled = false;
      const covered =
        transition !== undefined &&
        batch.facts.every((fact) =>
          transition!.envelope.grants.some((grant) =>
            deps.registry.get(fact.id)?.covers(grant, fact),
          ),
        );
      const blocked = () =>
        batch.facts.some((fact) =>
          authority
            .snapshot()
            .envelope?.exclusions.some(
              (item) =>
                (item.effect_id === undefined || item.effect_id === fact.id) &&
                (item.class === undefined || item.class === fact.class) &&
                (item.target_digests === undefined ||
                  item.target_digests.includes(fact.target!.digest)),
            ),
        );
      if (covered && blocked()) return receipt("deny");
      const isCurrent = (answer?: JudgeEffectReceipt) => {
        if (
          deps.signal?.aborted ||
          !reviewerContextIsCurrent(deps.reviewContext, context.live_revision)
        )
          return false;
        const current = authority.snapshot();
        if (current.status !== "active") return false;
        if (answer !== undefined) {
          const now = installed();
          return (
            now !== undefined &&
            now.revision === answer.revision &&
            now.transition_token === answer.transition_token
          );
        }
        if (transition !== undefined) return transaction.isCurrent(transition);
        return (
          current.revision === state.revision &&
          JSON.stringify(current.envelope) === JSON.stringify(state.envelope)
        );
      };
      const validateReceipt = (answer: JudgeEffectReceipt) => {
        if (!isCurrent(answer)) return false;
        if (answer.decision !== "allow") return true;
        if (wasRefused(batch) || blocked()) return false;
        const envelope = authority.snapshot().envelope!;
        const relation = answer.grant_ids.some((id) =>
          envelope.grants.some(
            (grant) => grant.id === id && grant.relation === "bounded_prerequisite",
          ),
        )
          ? "bounded_prerequisite"
          : "direct";
        return (
          answer.relation === relation &&
          answer.grant_ids.length === batch.facts.length &&
          batch.facts.every((fact, index) => {
            const grant = envelope.grants.find((item) => item.id === answer.grant_ids[index]);
            return grant !== undefined && deps.registry.get(fact.id)?.covers(grant, fact);
          })
        );
      };
      const outcome = await port.reviewEffects(
        { currentCase, consumer, effectId: batch.facts[0]?.id },
        {
          snapshot: () =>
            JSON.parse(
              JSON.stringify({
                authority: reviewerAuthoritySnapshot(authority.snapshot()),
                operator_evidence: state.evidence,
                operator_instructions: state.instructions ?? [],
                review_context: context.payload,
                review_context_revision: context.live_revision,
                guidance: deps.options?.guidance,
                descriptors: deps.registry.list().map(({ id, class: effectClass, inference }) => ({
                  id,
                  class: effectClass,
                  inference,
                })),
              }),
            ) as JudgeJson,
          isCurrent,
          validateReceipt,
          binding: covered
            ? { kind: "effects", transition: transition! }
            : {
                kind: "compile_effects",
                async validateAndInstall(
                  candidate,
                ): Promise<CompiledAuthorityTransition | undefined> {
                  transition = transaction.validateAndInstall(candidate);
                  if (transition !== undefined) {
                    compileInstalled = true;
                    revision = transition.revision;
                    audit.info(
                      {
                        event: "operator_authority.recompiled",
                        revision,
                        objective_count: transition.envelope.objectives.length,
                        grant_count: transition.envelope.grants.length,
                        exclusion_count: transition.envelope.exclusions.length,
                      },
                      "operator authority compiled",
                    );
                  }
                  return blocked() ? undefined : transition;
                },
              },
        },
      );
      attempts = outcome.attempts;
      if (wasRefused(batch)) return receipt("deny");
      if (transition !== undefined && transaction.isCurrent(transition) && blocked())
        return receipt("deny");
      if (outcome.kind === "stale") return receipt("unsure");
      const failed = (failure: NonNullable<EffectReviewReceipt["failure_kind"]>) => {
        audit.warn(
          {
            event: "effect_review.reviewer.failed",
            consumer,
            stage: covered || compileInstalled ? "decide" : "compile",
            revision,
            elapsed_ms: outcome.elapsedMs,
            attempts,
            failure_kind: failure,
          },
          "effect review failed",
        );
        return receipt("unsure", "none", failure);
      };
      if (outcome.kind === "failed") return failed(outcome.failureKind);
      if (!isCurrent(outcome.receipt) || !validateReceipt(outcome.receipt))
        return failed("invalid_response");
      revision = outcome.receipt.revision;
      if (
        reserve &&
        outcome.receipt.decision === "allow" &&
        !consumeAuthorityEffects(authority, revision, limitedKeys)
      )
        return receipt("unsure");
      audit.info(
        {
          event: "effect_review.reviewer.completed",
          consumer,
          stage: "decide",
          revision,
          decision: outcome.receipt.decision,
          relation: outcome.receipt.relation,
          elapsed_ms: outcome.elapsedMs,
          attempts,
          cache_hit: outcome.cacheHit,
        },
        "effect review completed",
      );
      return receipt(outcome.receipt.decision, outcome.receipt.relation);
    },
  });
}
