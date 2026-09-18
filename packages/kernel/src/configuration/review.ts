import { JUDGE_DEFAULTS, judgeRequestConfig } from "@clarvis/judge/settings";
import {
  OPERATOR_AUTHORITY_PORT,
  PLANS_REVIEW_CONTEXT_PORT,
  portKey,
  sanitizeDeep,
  sanitizeText,
  type Logger,
  type RunCapabilityContext,
} from "@clarvis/capability";
import type { ConfigStore } from "../config/config-store.ts";
import { createHostEffectReview } from "../guard/effect-review.ts";
import { canonicalJudgeJson, JUDGE_PORT, type JudgeJson } from "@clarvis/judge";
import {
  attestConfiguration,
  type ConfigurationMutationFacts,
} from "../guard/effects/configuration.ts";
import { createGuardEffectRegistry } from "../guard/effects/registry.ts";
import { resolveGuardMode } from "../guard/resolver.ts";

type ConfigurationAnswer = Awaited<ReturnType<NonNullable<RunCapabilityContext["elicit"]>>>;
const pendingQuestionsPort = portKey<Map<string, Promise<ConfigurationAnswer>>>(
  "configuration.pending_questions",
);

/** Bind both authoring consumers to the shared effect reviewer and live host authority. */
export function createConfigurationReview(
  ctx: RunCapabilityContext,
  options: { store: ConfigStore; audit?: Logger },
) {
  const settings = options.store.readSettings().merged;
  const judgeConfig = judgeRequestConfig(ctx);
  const mode = resolveGuardMode(
    ctx.request.guard_mode,
    settings.guard === undefined ? undefined : { ...settings.guard, type: "shell" },
  );
  const authority = ctx.services.get(OPERATOR_AUTHORITY_PORT);
  const registry = createGuardEffectRegistry();
  const reviewer = createHostEffectReview({
    judge: () => ctx.services.get(JUDGE_PORT),
    authority,
    reviewContext: () => ctx.services.get(PLANS_REVIEW_CONTEXT_PORT),
    registry,
    audit: options.audit,
    signal: ctx.signal,
    options: {
      ...settings.effect_review,
      ...judgeConfig,
      guidance: judgeConfig?.guidance,
    },
  });
  return async (
    mutations: readonly ConfigurationMutationFacts[],
    context: unknown,
    prompt: string,
  ): Promise<void> => {
    ctx.signal?.throwIfAborted();
    const state = authority?.snapshot();
    if (state?.status === "revoked") throw new Error("Configuration authority was revoked.");
    const facts = mutations.map((mutation) => attestConfiguration(mutation, registry));
    for (const fact of facts) reviewer.attest(fact, "configure_clarvis");
    const batch = {
      facts,
      reviewability: facts.some((fact) => fact.reviewability === "human_only")
        ? ("human_only" as const)
        : ("static" as const),
    };
    if (reviewer.wasRefused(batch))
      throw new Error(
        "This exact configuration change was already refused. A different proposal requires its own review.",
      );
    let reviewReason =
      mode === "on"
        ? "Human review is selected."
        : "This effect requires human review under the current policy.";
    let allowed = false;
    let expectedRevision = state?.revision;
    if (mode !== "on" && settings.effect_review?.rollout !== "shadow") {
      const receipt = await reviewer.review(batch, sanitizeDeep(context), "configure_clarvis");
      if (receipt.failure_kind !== undefined)
        throw new Error(
          `Configuration not changed: automatic review failed (${receipt.failure_kind}). This is a technical review failure, not missing operator authorization. Do not request authorization again to resolve it.`,
        );
      if (
        receipt.decision === "deny" ||
        (receipt.decision === "unsure" &&
          (judgeConfig?.on_unsure ??
            settings.effect_review?.on_unsure ??
            JUDGE_DEFAULTS.onUnsure) !== "ask")
      )
        throw new Error("Configuration effect was denied by authority review.");
      expectedRevision = state === undefined ? undefined : receipt.revision;
      allowed = receipt.decision === "allow";
      if (!allowed)
        reviewReason = "Automatic review could not establish authorization for this effect.";
    }
    if (!allowed) {
      if (ctx.elicit === undefined)
        throw new Error("This configuration change requires human review.");
      const signal = AbortSignal.any([
        ...(ctx.signal === undefined ? [] : [ctx.signal]),
        AbortSignal.timeout(ctx.request.elicit_wait_ms ?? ctx.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS),
      ]);
      const message = sanitizeText(`${reviewReason}\n\n${prompt}`);
      const key = canonicalJudgeJson(
        JSON.parse(
          JSON.stringify({
            facts,
            context: sanitizeDeep(context),
            message,
            revision: expectedRevision,
            binding: state?.binding,
          }),
        ) as JudgeJson,
      );
      let pending = ctx.services.get(pendingQuestionsPort);
      if (pending === undefined) {
        pending = new Map();
        ctx.services.provide(pendingQuestionsPort, pending);
      }
      let operation = pending.get(key);
      if (operation === undefined) {
        operation = ctx.elicit(
          {
            kind: "configuration_review",
            message,
            requestedSchema: {
              type: "object",
              properties: { decision: { type: "string", enum: ["deny", "allow"] } },
              required: ["decision"],
            },
          },
          { signal },
        );
        pending.set(key, operation);
        const questions = pending;
        const current = operation;
        const retire = () => {
          if (questions.get(key) === current) questions.delete(key);
        };
        void operation.then(retire, retire);
      }
      const answer = await operation;
      signal.throwIfAborted();
      if (answer.action !== "accept" || answer.content?.decision !== "allow") {
        reviewer.refuse(batch, expectedRevision ?? 0);
        throw new Error("Configuration change was not approved.");
      }
    }
    ctx.signal?.throwIfAborted();
    if (reviewer.wasRefused(batch))
      throw new Error("This exact configuration change was refused during review.");
    const current = authority?.snapshot();
    if (current?.status === "revoked" || current?.revision !== expectedRevision)
      throw new Error("Configuration authority changed during review. Prepare the change again.");
  };
}
