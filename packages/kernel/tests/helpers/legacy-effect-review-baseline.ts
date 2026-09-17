import { refusalKey } from "../../src/guard/effect-refusal.ts";
export { validateAuthorityEnvelope } from "../../src/guard/authority-validation.ts";
import { createAuthorityReviewTransaction } from "../../src/guard/authority-review-transaction.ts";
import { JUDGE_DEFAULTS, type GuardJudgeConfig } from "@clarvis/judge/settings";
import { z } from "zod";
import {
  NOOP_LOGGER,
  ProviderError,
  parseModelRef,
  resolveProvider,
  type OperatorAuthorityReader,
  type LLMProvider,
  type ProviderConfig,
  type Logger,
  type NamespacedTool,
  type TracePort,
} from "@clarvis/capability";
import type { GuardEffectRegistry } from "../../src/guard/effects/registry.ts";
import type { GuardEffectBatch, GuardEffectFact } from "../../src/guard/effects/types.ts";
import {
  consumeAuthorityEffects,
  denyAuthorityEffect,
} from "../../src/guard/operator-authority.ts";
import { effectDigest } from "../../src/guard/effects/facts.ts";
import { authorityEnvelopeSchema as envelopeSchema } from "../../src/guard/authority-schema.ts";
import { EFFECT_REVIEW_POLICY, GUARD_REVIEW_AGENT_INSTANCE_ID } from "./legacy-reviewer-policy.ts";
import {
  callReviewerWithTrace,
  reviewerFailureKind,
  type ReviewerFailureKind,
} from "../../src/guard/reviewer-trace.ts";
import {
  reviewerContextIsCurrent,
  reviewerContextSnapshot,
  type ReviewerContextSource,
} from "../../src/guard/review-context.ts";

export type { ReviewerFailureKind } from "../../src/guard/reviewer-trace.ts";

/** Shared configuration for compiler and per-call reviewer. */
export type EffectReviewOptions = GuardJudgeConfig;

/** Structured operational receipt; contains no prompt, command or operator text. */
export interface EffectReviewReceipt {
  decision: "allow" | "deny" | "unsure";
  relation: "direct" | "bounded_prerequisite" | "none";
  revision: number;
  failure_kind?: ReviewerFailureKind;
  elapsed_ms: number;
  attempts: number;
}

const id = z.string().min(1).max(256);
const decisionSchema = z
  .object({
    decision: z.enum(["allow", "deny", "unsure"]),
    reason: z.string().max(512).optional(),
    grant_ids: z.array(id).max(32),
    relation: z.enum(["direct", "bounded_prerequisite", "none"]),
  })
  .strict();

/** One shared compiler/reviewer with post-model host validation and revision-fenced caching. */
export function createEffectReviewService(deps: {
  llm: LLMProvider;
  providers: ProviderConfig[];
  defaultModel?: string;
  authority?: OperatorAuthorityReader;
  reviewContext?: ReviewerContextSource;
  registry: GuardEffectRegistry;
  audit?: Logger;
  signal?: AbortSignal;
  trace?: TracePort;
  options?: EffectReviewOptions;
}) {
  const audit = deps.audit ?? NOOP_LOGGER;
  const config = deps.options ?? {};
  const cache = new Map<string, EffectReviewReceipt>();
  const unboundRefusals = new Set<string>();
  const wasRefused = (batch: GuardEffectBatch): boolean => {
    const key = refusalKey(batch);
    return (
      deps.authority?.snapshot().denied_effects?.includes(key) === true || unboundRefusals.has(key)
    );
  };
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
      const state = deps.authority?.snapshot();
      const reviewContext = reviewerContextSnapshot(state?.review_context, deps.reviewContext);
      const contextCurrent = () =>
        reviewerContextIsCurrent(deps.reviewContext, reviewContext.live_revision);
      let revision = state?.revision ?? 0;
      let attempts = 0;
      const receipt = (
        decision: EffectReviewReceipt["decision"],
        relation: EffectReviewReceipt["relation"] = "none",
        failure_kind?: ReviewerFailureKind,
      ): EffectReviewReceipt => ({
        decision,
        relation,
        revision,
        elapsed_ms: Math.round(performance.now() - started),
        attempts,
        ...(failure_kind === undefined ? {} : { failure_kind }),
      });
      if (wasRefused(batch)) return receipt("deny");
      if (
        state?.status !== "active" ||
        state.evidence.length === 0 ||
        deps.authority === undefined ||
        batch.reviewability === "human_only" ||
        batch.facts.length === 0 ||
        batch.facts.some(
          (fact) => fact.attestation !== "complete" || fact.inference === "human_only",
        )
      )
        return receipt("unsure");
      const key = JSON.stringify([
        revision,
        reviewContext.live_revision,
        reviewContext.payload,
        batch,
        call,
      ]);
      const limitedKeys = batch.facts
        .filter((fact) => fact.id === "github.actions.rerun_failed")
        .map((fact) => effectDigest(fact.id, fact.target!.digest));
      if (limitedKeys.some((key) => state.consumed_effects?.includes(key)))
        return receipt("unsure");
      const cached = cache.get(key);
      if (cached !== undefined) {
        if (!contextCurrent()) return receipt("unsure");
        if (
          reserve &&
          cached.decision === "allow" &&
          !consumeAuthorityEffects(deps.authority, revision, limitedKeys)
        )
          return receipt("unsure");
        audit.info(
          {
            event: "effect_review.reviewer.completed",
            consumer,
            stage: "decide",
            revision,
            decision: cached.decision,
            relation: cached.relation,
            elapsed_ms: 0,
            attempts: 0,
            cache_hit: true,
          },
          "effect review cache hit",
        );
        return { ...cached, elapsed_ms: 0, attempts: 0 };
      }
      const model = config.model ?? deps.defaultModel;
      if (model === undefined) return receipt("unsure", "none", "admission");
      const ref = parseModelRef(model);
      const resolution = resolveProvider(ref.provider, deps.providers, ref.modelId);
      if (!resolution.ok) return receipt("unsure", "none", "admission");
      let operationalFailure: ReviewerFailureKind | undefined;
      let completeStage: (
        decision: EffectReviewReceipt["decision"],
        relation: EffectReviewReceipt["relation"],
        failure?: ReviewerFailureKind,
      ) => void = () => {};
      const invoke = async (
        stage: "compile" | "decide",
        payload: unknown,
        schema: z.ZodType,
      ): Promise<unknown> => {
        completeStage = () => {};
        const stageStarted = performance.now();
        const priorAttempts = attempts;
        const timeout = new AbortController();
        let timedOut = false;
        const timeoutMs = config.timeout_ms ?? JUDGE_DEFAULTS.timeoutMs;
        const timer = setTimeout(() => {
          timedOut = true;
          timeout.abort();
        }, timeoutMs);
        const signal =
          deps.signal === undefined
            ? timeout.signal
            : AbortSignal.any([deps.signal, timeout.signal]);
        const tool: NamespacedTool = {
          fullName: stage,
          wireName: stage,
          mcpName: "",
          toolName: stage,
          description: "Return the bounded effect review result.",
          inputSchema: z.toJSONSchema(schema),
        };
        attempts++;
        audit.info(
          {
            event: "effect_review.reviewer.started",
            consumer,
            stage,
            model: ref.modelId,
            provider: ref.provider,
            revision,
            effect_id: batch.facts[0]?.id ?? "external.unknown",
          },
          "effect review started",
        );
        try {
          const result = await callReviewerWithTrace(
            deps.llm,
            {
              model: ref.modelId,
              provider: ref.provider,
              providerConfig: resolution.config,
              messages: [
                { role: "system", content: EFFECT_REVIEW_POLICY },
                {
                  role: "user",
                  content: JSON.stringify({ ...Object(payload), guidance: config.guidance }),
                },
              ],
              tools: [tool],
              toolChoice: { type: "function", function: { name: stage } },
              signal,
              timeoutMs,
              maxRetries: config.max_retries ?? JUDGE_DEFAULTS.maxRetries,
              maxOutputTokens: 2048,
              reasoningEffort: "low",
              agentInstanceId: GUARD_REVIEW_AGENT_INSTANCE_ID,
              cacheBreakpoints: [],
              onRetry: () => {
                attempts++;
              },
            },
            {
              trace: deps.trace,
              path: "effect_review",
              consumer,
              stage,
              authority_revision: revision,
              effect_id: batch.facts[0]?.id ?? "external.unknown",
              failureKind: (error) => reviewerFailureKind(error, timedOut, deps.signal),
            },
          );
          if (timedOut || deps.signal?.aborted) throw new Error("review retired");
          completeStage = (decision, relation, failure) => {
            const fields = {
              event:
                failure === undefined
                  ? "effect_review.reviewer.completed"
                  : "effect_review.reviewer.failed",
              consumer,
              stage,
              revision,
              elapsed_ms: Math.round(performance.now() - stageStarted),
              attempts: attempts - priorAttempts,
              ...(failure === undefined
                ? { decision, relation, cache_hit: false }
                : { failure_kind: failure }),
              input_tokens: result.usage.input_tokens + (result.retriedUsage?.input_tokens ?? 0),
              output_tokens: result.usage.output_tokens + (result.retriedUsage?.output_tokens ?? 0),
            };
            if (failure === undefined) audit.info(fields, "effect review completed");
            else audit.warn(fields, "effect review response invalid");
          };
          const response = result.toolCalls?.length === 1 ? result.toolCalls[0] : undefined;
          if (response?.name !== stage) {
            operationalFailure = "invalid_response";
            return undefined;
          }
          try {
            const raw: unknown =
              typeof response.arguments === "string"
                ? JSON.parse(response.arguments)
                : response.arguments;
            const parsed = schema.safeParse(raw);
            if (!parsed.success) operationalFailure = "invalid_response";
            return parsed.success ? parsed.data : undefined;
          } catch {
            operationalFailure = "invalid_response";
            return undefined;
          }
        } catch (error) {
          operationalFailure = reviewerFailureKind(error, timedOut, deps.signal);
          audit.warn(
            {
              event: "effect_review.reviewer.failed",
              consumer,
              stage,
              failure_kind: operationalFailure,
              elapsed_ms: Math.round(performance.now() - stageStarted),
              attempts: attempts - priorAttempts,
              ...(error instanceof ProviderError &&
              (error.accumulatedUsage ?? error.partialUsage) !== undefined
                ? {
                    input_tokens: (error.accumulatedUsage ?? error.partialUsage)!.input_tokens,
                    output_tokens: (error.accumulatedUsage ?? error.partialUsage)!.output_tokens,
                  }
                : {}),
            },
            "effect review failed",
          );
          return undefined;
        } finally {
          if (operationalFailure === "invalid_response") {
            completeStage("unsure", "none", operationalFailure);
            completeStage = () => {};
          }
          clearTimeout(timer);
        }
      };
      let envelope = state.envelope?.revision === revision ? state.envelope : undefined;
      if (
        envelope === undefined ||
        state.envelope_context_revision !== reviewContext.live_revision ||
        !batch.facts.every((fact) =>
          envelope!.grants.some((grant) => deps.registry.get(fact.id)?.covers(grant, fact)),
        )
      ) {
        const transaction = createAuthorityReviewTransaction({
          authority: deps.authority,
          registry: deps.registry,
          batch,
          caseDigest: effectDigest(key),
          expectedAuthorityRevision: revision,
          expectedReviewContextRevision: reviewContext.live_revision,
          reviewContext: deps.reviewContext,
          signal: deps.signal,
        });
        const output = await invoke(
          "compile",
          {
            operator_evidence: state.evidence,
            ...(reviewContext.payload === undefined
              ? {}
              : { review_context: reviewContext.payload }),
            revision,
            effects: batch.facts,
            descriptors: deps.registry.list().map(({ id, class: effectClass, inference }) => ({
              id,
              class: effectClass,
              inference,
            })),
            exclusions: state.envelope?.exclusions ?? [],
            previous_objectives: state.envelope?.objectives ?? [],
          },
          envelopeSchema,
        );
        const transition = transaction.validateAndInstall(output);
        if (transition === undefined) {
          completeStage("unsure", "none", operationalFailure ?? "invalid_response");
          return receipt("unsure", "none", operationalFailure ?? "invalid_response");
        }
        envelope = transition.envelope;
        revision = transition.revision;
        completeStage("allow", "none");
        audit.info(
          {
            event: "operator_authority.recompiled",
            revision,
            objective_count: envelope.objectives.length,
            grant_count: envelope.grants.length,
            exclusion_count: envelope.exclusions.length,
          },
          "operator authority compiled",
        );
      }
      const blocked = batch.facts.some((fact) =>
        envelope.exclusions.some(
          (item) =>
            (item.effect_id === undefined || item.effect_id === fact.id) &&
            (item.class === undefined || item.class === fact.class) &&
            (item.target_digests === undefined ||
              item.target_digests.includes(fact.target!.digest)),
        ),
      );
      if (blocked || wasRefused(batch)) return receipt("deny");
      const output = await invoke(
        "decide",
        {
          ...(reviewContext.payload === undefined ? {} : { review_context: reviewContext.payload }),
          call,
          effects: batch.facts,
          envelope,
        },
        decisionSchema,
      );
      const decision = decisionSchema.safeParse(output);
      const current = deps.authority.snapshot();
      if (wasRefused(batch)) return receipt("deny");
      if (current.status !== "active" || current.revision !== revision || !contextCurrent()) {
        completeStage("unsure", "none");
        return receipt("unsure");
      }
      if (!decision.success)
        return receipt("unsure", "none", operationalFailure ?? "invalid_response");
      if (decision.data.decision === "allow") {
        const relation = decision.data.grant_ids.some((id) =>
          envelope.grants.some(
            (grant) => grant.id === id && grant.relation === "bounded_prerequisite",
          ),
        )
          ? "bounded_prerequisite"
          : "direct";
        if (
          decision.data.relation !== relation ||
          decision.data.grant_ids.length !== batch.facts.length ||
          !batch.facts.every((fact, index) => {
            const grant = envelope.grants.find(
              (item) => item.id === decision.data.grant_ids[index],
            );
            return grant !== undefined && deps.registry.get(fact.id)?.covers(grant, fact);
          })
        ) {
          completeStage("unsure", "none", "invalid_response");
          return receipt("unsure", "none", "invalid_response");
        }
      }
      const answer = receipt(decision.data.decision, decision.data.relation);
      if (
        reserve &&
        answer.decision === "allow" &&
        !consumeAuthorityEffects(deps.authority, revision, limitedKeys)
      ) {
        completeStage("unsure", "none");
        return receipt("unsure");
      }
      completeStage(answer.decision, answer.relation);
      if (answer.decision !== "unsure") {
        if (cache.size >= 128) cache.clear();
        cache.set(
          JSON.stringify([
            revision,
            reviewContext.live_revision,
            reviewContext.payload,
            batch,
            call,
          ]),
          answer,
        );
      }
      return answer;
    },
  });
}

const runServices = new WeakMap<
  OperatorAuthorityReader,
  ReturnType<typeof createEffectReviewService>
>();

/** Host consumers sharing one ledger also share reviewer configuration, compilation and caches. */
export function effectReviewServiceFor(deps: Parameters<typeof createEffectReviewService>[0]) {
  if (deps.authority === undefined) return createEffectReviewService(deps);
  const prior = runServices.get(deps.authority);
  if (prior !== undefined) return prior;
  const service = createEffectReviewService(deps);
  runServices.set(deps.authority, service);
  return service;
}
