import { createAiSdkProvider, type AiSdkProviderOptions } from "@clarvis/llm";
import {
  loadEnv,
  OPERATOR_AUTHORITY_PORT,
  type Capability,
  type LLMProvider,
} from "@clarvis/capability";
import { JUDGE_PORT } from "@clarvis/judge";
import { executeRun } from "@clarvis/loop";
import { createTestRunInfrastructure } from "@clarvis/loop/testing";
import { createJsonTraceStore, createTraceVisibilityView } from "@clarvis/trace";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostJudge } from "../../src/guard/judge-host.ts";
import { createHostEffectReview } from "../../src/guard/effect-review.ts";
import { createOperatorAuthorityRuntime } from "../../src/guard/operator-authority.ts";
import { createGuardEffectRegistry } from "../../src/guard/effects/registry.ts";
import { configurationFact } from "../helpers/configuration-mutation.ts";
import { recordingLogger } from "../helpers/logger.ts";

export const EFFECT_REVIEW_CANARY_MAX_EXTERNAL_CALLS = 20;

/** Enforce the physical provider-call ceiling independently of scenario counts or retries. */
export function boundEffectReviewCanaryProvider(
  provider: LLMProvider,
  limit = EFFECT_REVIEW_CANARY_MAX_EXTERNAL_CALLS,
): {
  provider: LLMProvider;
  used: () => number;
} {
  let used = 0;
  return {
    provider: {
      async call(params) {
        if (used >= limit) throw new Error("effect review canary external call budget exhausted");
        used++;
        return provider.call(params);
      },
    },
    used: () => used,
  };
}

/** Opt-in real-SDK contract probe. Caller supplies host authorization; no credentials enter results. */
export async function runEffectReviewCanary(options: {
  optIn: boolean;
  provider: AiSdkProviderOptions;
  models: { scheme: "openai-codex" | "xai-grok"; model: string }[];
  trials?: number;
  externalCallLimit?: number;
}) {
  if (!options.optIn) throw new Error("effect review canary requires explicit opt-in");
  if (
    options.models.length !== 2 ||
    new Set(options.models.map(({ scheme, model }) => `${scheme}/${model}`)).size !== 2
  )
    throw new Error("canary requires two distinct subscription model identities");
  const trials = options.trials ?? 1;
  if (!Number.isInteger(trials) || trials < 1 || trials > 3)
    throw new Error("canary trials must be 1..3");
  const externalCallLimit = options.externalCallLimit ?? EFFECT_REVIEW_CANARY_MAX_EXTERNAL_CALLS;
  if (
    !Number.isInteger(externalCallLimit) ||
    externalCallLimit < 1 ||
    externalCallLimit > EFFECT_REVIEW_CANARY_MAX_EXTERNAL_CALLS
  )
    throw new Error("canary external call limit must be 1..20");
  const bounded = boundEffectReviewCanaryProvider(
    createAiSdkProvider(options.provider),
    externalCallLimit,
  );
  const sdk = bounded.provider;
  const records: Record<string, unknown>[] = [];
  const latencies: number[] = [];
  for (const { scheme, model } of options.models) {
    for (let trial = 0; trial < trials; trial++) {
      for (const scenario of ["contract", "timeout", "invalid_response"] as const) {
        const audit = recordingLogger();
        const root = mkdtempSync(join(tmpdir(), "judge-canary-"));
        const env = loadEnv({
          CLARVIS_LOG_LEVEL: "silent",
          CLARVIS_AGENT_TOOLS_ENABLED: "true",
          CLARVIS_AGENT_TOOLS_MAX_GRANT: "edit",
        });
        const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
        const physical = createJsonTraceStore({ dir: join(root, "traces") });
        let receipt:
          Awaited<ReturnType<ReturnType<typeof createHostEffectReview>["review"]>> | undefined;
        let reviewOperation: Promise<void> | undefined;
        const providerCalls: Array<{
          input_tokens: number;
          output_tokens: number;
          cached_tokens: number;
          cache_write_tokens: number;
          cache_usage_known: boolean;
        }> = [];
        const llm: LLMProvider = {
          async call(params) {
            if (params.agentInstanceId !== "judge") {
              await reviewOperation;
              return {
                text: "Canary finished",
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cached_tokens: 0,
                  cache_write_tokens: 0,
                },
              };
            }
            const result = await sdk.call(params);
            providerCalls.push({
              input_tokens: result.usage.input_tokens,
              output_tokens: result.usage.output_tokens,
              cached_tokens: result.usage.cached_tokens,
              cache_write_tokens: result.usage.cache_write_tokens,
              cache_usage_known:
                result.cacheUsageKnown !== false && result.usage.cache_unknown !== true,
            });
            return scenario === "invalid_response" ? { ...result, toolCalls: [] } : result;
          },
        };
        const providers = [{ name: scheme, kind: scheme }];
        const deps = {
          ...infrastructure,
          env,
          llm,
          traceStore: createTraceVisibilityView(physical, "public"),
          operatorAuthority: createOperatorAuthorityRuntime,
        };
        const host = createHostJudge({
          deps,
          physicalStore: physical,
          audit,
          toolsEnabled: true,
          loadSettings: () => ({
            providers,
            defaultModel: `${scheme}/${model}`,
            effect_review: { timeout_ms: scenario === "timeout" ? 1 : 120000, max_retries: 0 },
          }),
        });
        let privateRuns: number;
        const consumer: Capability = {
          name: "canary-consumer",
          forRun(ctx) {
            const registry = createGuardEffectRegistry();
            const service = createHostEffectReview({
              judge: () => ctx.services.get(JUDGE_PORT),
              authority: ctx.services.get(OPERATOR_AUTHORITY_PORT),
              registry,
              audit,
            });
            reviewOperation = service
              .review(
                {
                  reviewability: "static",
                  facts: [configurationFact(registry)],
                },
                {
                  surface: "operational",
                  canonical_path: ".clarvis/settings.json",
                },
                "configuration_file",
              )
              .then((value) => {
                receipt = value;
              });
            return {
              name: "canary-consumer",
              forAgent: () => null,
            };
          },
        };
        try {
          const outcome = await executeRun({
            owner: "canary",
            operatorAuthoritySeed: {
              binding: {
                owner_key_name: "canary",
                session_id: "canary",
                controller_epoch: String(trial),
              },
              evidence: [
                {
                  id: "operator",
                  source: "start",
                  execution_id: "canary",
                  text: "Update the workspace settings this run was asked to change.",
                },
              ],
            },
            rawBody: {
              execution_id: "canary",
              session_id: "canary",
              messages: [{ role: "user", content: "Run the review fixture" }],
              entry: "work",
              profiles: [
                {
                  name: "work",
                  model: `${scheme}/${model}`,
                  tools: [],
                  grants: ["edit_workspace"],
                  iteration_limit: 1,
                },
              ],
              providers,
              servers: [],
              prompt_cache_ttl: "1h",
              budget: { on_exceed: "stop", total_token_limit: 10000 },
            },
            deps: { ...deps, capabilities: [host.capability, consumer] },
          });
          if (outcome.response.status !== "completed" || receipt === undefined) {
            const internal = createTraceVisibilityView(physical, "internal");
            const privateDiagnostics = internal.list("canary", 10, 0).items.map((item) => {
              const record = internal.getById("canary", item.id);
              return {
                id: item.id,
                status: item.status,
                response_status: record?.response.status,
                response_error_code:
                  record?.response.status === "error" ? record.response.error.code : undefined,
                event_types: record?.trace.events.map((entry) => entry.type),
              };
            });
            throw new Error(
              `Native Judge canary did not finish its host review: ${JSON.stringify({
                status: outcome.response.status,
                error_code:
                  outcome.response.status === "error" ? outcome.response.error.code : undefined,
                receipt:
                  receipt === undefined
                    ? undefined
                    : { decision: receipt.decision, failure_kind: receipt.failure_kind },
                private_runs: privateDiagnostics,
                audit_events: audit.records.map(({ fields }) => fields),
              })}`,
            );
          }
          privateRuns = createTraceVisibilityView(physical, "internal").list("canary", 10, 0).total;
          if (privateRuns !== 1)
            throw new Error("Native Judge canary must persist one private run");
        } finally {
          await host.close();
          await infrastructure.connections.closeAll();
          rmSync(root, { recursive: true, force: true });
        }
        latencies.push(receipt.elapsed_ms);
        records.push({
          scheme,
          model,
          scenario,
          trial,
          ...receipt,
          provider_calls: providerCalls,
          private_runs: privateRuns,
          events: audit.records.map((entry) => entry.fields),
        });
      }
    }
  }
  const sorted = latencies.toSorted((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)];
  return {
    version: 2,
    execution: "native-judge-capability",
    external_calls: bounded.used(),
    external_call_limit: externalCallLimit,
    records,
    latency_ms: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  };
}
