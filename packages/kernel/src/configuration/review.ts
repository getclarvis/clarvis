import {
  OPERATOR_AUTHORITY_PORT,
  RUN_TRACE_PORT,
  sanitizeDeep,
  sanitizeText,
  type Logger,
  type RunCapabilityContext,
} from "@clarvis/capability";
import type { ConfigStore } from "../config/config-store.ts";
import { effectReviewServiceFor } from "../guard/effect-review-service.ts";
import {
  attestConfiguration,
  type ConfigurationMutationFacts,
} from "../guard/effects/configuration.ts";
import { createGuardEffectRegistry } from "../guard/effects/registry.ts";
import { resolveGuardMode } from "../guard/resolver.ts";

/** Bind both authoring consumers to the shared effect reviewer and live host authority. */
export function createConfigurationReview(
  ctx: RunCapabilityContext,
  options: { store: ConfigStore; audit?: Logger },
) {
  const settings = options.store.readSettings().merged;
  const mode = resolveGuardMode(
    ctx.request.guard_mode,
    settings.guard === undefined ? undefined : { ...settings.guard, type: "shell" },
  );
  const authority = ctx.services.get(OPERATOR_AUTHORITY_PORT);
  const registry = createGuardEffectRegistry();
  const reviewer = effectReviewServiceFor({
    llm: ctx.llm,
    providers: ctx.request.providers,
    defaultModel: settings.default_model,
    authority,
    trace: ctx.services.get(RUN_TRACE_PORT),
    registry,
    audit: options.audit,
    signal: ctx.signal,
    options: {
      ...settings.effect_review,
      ...ctx.request.guard_judge,
      guidance: ctx.request.guard_judge?.guidance ?? ctx.request.guard_judge?.prompt,
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
    if (mode !== "on" && settings.effect_review?.rollout !== "shadow") {
      const receipt = await reviewer.review(batch, sanitizeDeep(context), "configure_clarvis");
      if (
        receipt.decision === "deny" ||
        (receipt.decision === "unsure" &&
          (ctx.request.guard_judge?.on_unsure ?? settings.effect_review?.on_unsure) === "deny")
      )
        throw new Error("Configuration effect was denied by authority review.");
      allowed = receipt.decision === "allow";
      if (!allowed)
        reviewReason =
          receipt.failure_kind === "timeout"
            ? "Automatic review timed out. The current policy requires a human decision."
            : receipt.failure_kind === undefined
              ? "Automatic review could not establish authorization for this effect."
              : "Automatic review did not return a valid decision. The current policy requires human review.";
    }
    if (!allowed) {
      if (ctx.elicit === undefined)
        throw new Error("This configuration change requires human review.");
      const signal = AbortSignal.any([
        ...(ctx.signal === undefined ? [] : [ctx.signal]),
        AbortSignal.timeout(ctx.request.elicit_wait_ms ?? ctx.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS),
      ]);
      const answer = await ctx.elicit(
        {
          kind: "configuration_review",
          message: sanitizeText(`${reviewReason}\n\n${prompt}`),
          requestedSchema: {
            type: "object",
            properties: { decision: { type: "string", enum: ["deny", "allow"] } },
            required: ["decision"],
          },
        },
        { signal },
      );
      signal.throwIfAborted();
      if (answer.action !== "accept" || answer.content?.decision !== "allow") {
        reviewer.refuse(batch, state?.revision ?? 0);
        throw new Error("Configuration change was not approved.");
      }
    }
    ctx.signal?.throwIfAborted();
    if (reviewer.wasRefused(batch))
      throw new Error("This exact configuration change was refused during review.");
    const current = authority?.snapshot();
    if (current?.status === "revoked" || current?.revision !== state?.revision)
      throw new Error("Configuration authority changed during review. Prepare the change again.");
  };
}
