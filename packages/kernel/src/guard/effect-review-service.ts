import { z } from "zod";
import {
  NOOP_LOGGER,
  ProviderError,
  parseModelRef,
  resolveProvider,
  type AuthorityEnvelopeV1,
  type OperatorAuthorityReader,
  type LLMProvider,
  type ProviderConfig,
  type Logger,
  type NamespacedTool,
} from "@clarvis/capability";
import type { GuardEffectRegistry } from "./effects/registry.ts";
import type { GuardEffectBatch, GuardEffectFact } from "./effects/types.ts";
import { installAuthorityEnvelope, consumeAuthorityEffects } from "./operator-authority.ts";
import { effectDigest } from "./effects/facts.ts";
import { authorityEnvelopeSchema as envelopeSchema } from "./authority-schema.ts";
import { EFFECT_REVIEW_POLICY } from "./reviewer-policy.ts";

/** Operational failures remain distinguishable from an uncertain policy verdict. */
export type ReviewerFailureKind =
  | "timeout"
  | "auth"
  | "quota"
  | "rate_limit"
  | "transport"
  | "admission"
  | "cancelled"
  | "invalid_response"
  | "unknown";

/** Shared configuration for compiler and per-call reviewer. */
export interface EffectReviewOptions {
  model?: string;
  timeout_ms?: number;
  max_retries?: number;
  on_unsure?: "ask" | "deny";
  guidance?: string;
}

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

/** Reject an envelope atomically unless all references, inference ceilings and targets are valid. */
export function validateAuthorityEnvelope(
  value: unknown,
  reader: OperatorAuthorityReader,
  registry: GuardEffectRegistry,
  batch: GuardEffectBatch,
): AuthorityEnvelopeV1 | undefined {
  const parsed = envelopeSchema.safeParse(value);
  const state = reader.snapshot();
  if (!parsed.success || state.status !== "active" || parsed.data.revision !== state.revision)
    return undefined;
  const envelope = parsed.data;
  const evidence = new Set(state.evidence.map((entry) => entry.id));
  const targets = new Set(
    batch.facts.flatMap((fact) => (fact.target === undefined ? [] : [fact.target.digest])),
  );
  if (new Set(envelope.grants.map((grant) => grant.id)).size !== envelope.grants.length)
    return undefined;
  if (
    new Set(envelope.objectives.map((objective) => objective.id)).size !==
    envelope.objectives.length
  )
    return undefined;
  for (const objective of envelope.objectives) {
    if (
      objective.evidence_ids.some((key) => !evidence.has(key)) ||
      objective.target_digests.some((key) => !targets.has(key))
    )
      return undefined;
  }
  for (const grant of envelope.grants) {
    const descriptor = registry.get(grant.effect_id);
    if (
      descriptor === undefined ||
      descriptor.inference === "human_only" ||
      (grant.relation === "bounded_prerequisite" && descriptor.inference !== "bounded") ||
      !descriptor.validateConstraints(grant.constraints) ||
      grant.evidence_ids.some((key) => !evidence.has(key)) ||
      grant.target_digests.some((key) => !targets.has(key)) ||
      !batch.facts.some((fact) => descriptor.covers(grant, fact))
    )
      return undefined;
    if (
      state.ceiling !== undefined &&
      !state.ceiling.grants.some(
        (parent) =>
          parent.effect_id === grant.effect_id &&
          parent.relation === grant.relation &&
          grant.target_digests.every((target) => parent.target_digests.includes(target)) &&
          JSON.stringify(parent.constraints) === JSON.stringify(grant.constraints),
      )
    )
      return undefined;
  }
  for (const item of envelope.exclusions) {
    if (
      (item.effect_id !== undefined && registry.get(item.effect_id) === undefined) ||
      item.target_digests?.some((target) => !targets.has(target))
    )
      return undefined;
  }
  if (
    state.envelope?.exclusions.some(
      (item) =>
        !envelope.exclusions.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(item),
        ),
    )
  )
    return undefined;
  if (
    state.ceiling?.exclusions.some(
      (item) =>
        !envelope.exclusions.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(item),
        ),
    )
  )
    return undefined;
  return envelope;
}

/** Prefer provider-classified errors; never extract secrets or classify raw error prose. */
function failureKind(error: unknown, timedOut: boolean, signal?: AbortSignal): ReviewerFailureKind {
  if (signal?.aborted) return "cancelled";
  if (timedOut) return "timeout";
  if (error instanceof ProviderError) {
    if (error.kind === "auth" || error.kind === "quota") return error.kind;
    if (error.status === 429) return "rate_limit";
    return error.kind === "transient" ? "transport" : "admission";
  }
  return "unknown";
}

/** One shared compiler/reviewer with post-model host validation and revision-fenced caching. */
export function createEffectReviewService(deps: {
  llm: LLMProvider;
  providers: ProviderConfig[];
  defaultModel?: string;
  authority?: OperatorAuthorityReader;
  registry: GuardEffectRegistry;
  audit?: Logger;
  signal?: AbortSignal;
  options?: EffectReviewOptions;
}) {
  const audit = deps.audit ?? NOOP_LOGGER;
  const config = deps.options ?? {};
  const cache = new Map<string, EffectReviewReceipt>();
  return Object.freeze({
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
      const key = JSON.stringify([revision, batch, call]);
      const limitedKeys = batch.facts
        .filter((fact) => fact.id === "github.actions.rerun_failed")
        .map((fact) => effectDigest(fact.id, fact.target!.digest));
      if (limitedKeys.some((key) => state.consumed_effects?.includes(key)))
        return receipt("unsure");
      const cached = cache.get(key);
      if (cached !== undefined) {
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
        const timeoutMs = config.timeout_ms ?? 20000;
        const timer = setTimeout(() => {
          timedOut = true;
          timeout.abort();
        }, timeoutMs);
        const signal =
          deps.signal === undefined
            ? timeout.signal
            : AbortSignal.any([deps.signal, timeout.signal]);
        let removeAbort = (): void => {};
        const aborted = new Promise<never>((_resolve, reject) => {
          const cancel = (): void => {
            reject(new Error("effect review cancelled"));
          };
          if (signal.aborted) cancel();
          else signal.addEventListener("abort", cancel, { once: true });
          removeAbort = () => signal.removeEventListener("abort", cancel);
        });
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
          const result = await Promise.race([
            aborted,
            deps.llm.call({
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
              maxRetries: config.max_retries ?? 1,
              maxOutputTokens: 2048,
              reasoningEffort: "low",
              onRetry: () => {
                attempts++;
              },
            }),
          ]);
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
          operationalFailure = failureKind(error, timedOut, deps.signal);
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
          removeAbort();
        }
      };
      let envelope = state.envelope?.revision === revision ? state.envelope : undefined;
      if (
        envelope === undefined ||
        !batch.facts.every((fact) =>
          envelope!.grants.some((grant) => deps.registry.get(fact.id)?.covers(grant, fact)),
        )
      ) {
        const output = await invoke(
          "compile",
          {
            operator_evidence: state.evidence,
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
        envelope = validateAuthorityEnvelope(output, deps.authority, deps.registry, batch);
        if (envelope === undefined || !installAuthorityEnvelope(deps.authority, envelope)) {
          completeStage("unsure", "none", operationalFailure ?? "invalid_response");
          return receipt("unsure", "none", operationalFailure ?? "invalid_response");
        }
        const installed = deps.authority.snapshot();
        if (installed.status !== "active" || installed.envelope?.revision !== installed.revision)
          return receipt("unsure");
        envelope = installed.envelope;
        revision = installed.revision;
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
      if (blocked) return receipt("deny");
      const output = await invoke(
        "decide",
        { call, effects: batch.facts, envelope },
        decisionSchema,
      );
      const decision = decisionSchema.safeParse(output);
      const current = deps.authority.snapshot();
      if (current.status !== "active" || current.revision !== revision) {
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
        cache.set(JSON.stringify([revision, batch, call]), answer);
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
