import { createAiSdkProvider, type AiSdkProviderOptions } from "@clarvis/llm";
import type { LLMProvider } from "@clarvis/capability";
import { createEffectReviewService } from "../../src/guard/effect-review-service.ts";
import { createOperatorAuthorityRuntime } from "../../src/guard/operator-authority.ts";
import { createGuardEffectRegistry } from "../../src/guard/effects/registry.ts";
import { effectDigest } from "../../src/guard/effects/facts.ts";
import { recordingLogger } from "../helpers/logger.ts";

/** Opt-in real-SDK contract probe. Caller supplies host authorization; no credentials enter results. */
export async function runEffectReviewCanary(options: {
  optIn: boolean;
  provider: AiSdkProviderOptions;
  models: { scheme: "openai-codex" | "xai-grok"; model: string }[];
  trials?: number;
}) {
  if (!options.optIn) throw new Error("effect review canary requires explicit opt-in");
  if (
    options.models.length !== 2 ||
    new Set(options.models.map((entry) => entry.scheme)).size !== 2
  )
    throw new Error("canary requires one openai-codex and one xai-grok model");
  const trials = options.trials ?? 1;
  if (!Number.isInteger(trials) || trials < 1 || trials > 5)
    throw new Error("canary trials must be 1..5");
  const sdk = createAiSdkProvider(options.provider);
  const records: Record<string, unknown>[] = [];
  const latencies: number[] = [];
  for (const { scheme, model } of options.models) {
    for (let trial = 0; trial < trials; trial++) {
      for (const scenario of ["contract", "timeout", "invalid_response"] as const) {
        const audit = recordingLogger();
        const authority = createOperatorAuthorityRuntime({
          owner: "canary",
          executionId: `canary-${trial}`,
          seed: {
            binding: {
              owner_key_name: "canary",
              session_id: "canary",
              controller_epoch: `${trial}`,
            },
            evidence: [
              {
                id: "operator",
                source: "start",
                execution_id: `canary-${trial}`,
                text: "Commit the local changes in this repository.",
              },
            ],
          },
        });
        const llm: LLMProvider = {
          async call(params) {
            const result = await sdk.call(params);
            return scenario === "invalid_response" ? { ...result, toolCalls: [] } : result;
          },
        };
        const service = createEffectReviewService({
          llm,
          authority: authority.reader,
          registry: createGuardEffectRegistry(),
          audit,
          providers: [{ name: scheme, kind: scheme }],
          defaultModel: `${scheme}/${model}`,
          options: { timeout_ms: scenario === "timeout" ? 1 : 20000, max_retries: 0 },
        });
        const receipt = await service.review(
          {
            reviewability: "static",
            facts: [
              {
                id: "git.commit",
                class: "local_mutation",
                inference: "bounded",
                attestation: "complete",
                reviewability: "static",
                analysis_issues: [],
                constraints: { head_sha: "a".repeat(40) },
                target: { kind: "repository", digest: effectDigest("canary", "branch") },
              },
            ],
          },
          { tool: "shell", args: { command: "git commit -m fixture" } },
          "command_guard",
        );
        latencies.push(receipt.elapsed_ms);
        records.push({
          scheme,
          scenario,
          trial,
          ...receipt,
          events: audit.records.map((entry) => entry.fields),
        });
        authority.finalize({ status: "completed" });
      }
    }
  }
  const sorted = latencies.toSorted((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)];
  return {
    version: 1,
    records,
    latency_ms: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  };
}
