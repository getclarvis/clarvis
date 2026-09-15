import type { LLMProvider } from "@clarvis/capability";
import { EFFECT_REVIEW_POLICY } from "../../src/guard/reviewer-policy.ts";

/** Route compiler/decision calls through valid exact grants while preserving the test's agent LLM. */
export function withHostValidatedEffectReview(
  agent: LLMProvider,
  onReview?: (stage: "compile" | "decide") => void,
): LLMProvider {
  return {
    async call(params) {
      const stage = params.tools?.[0]?.wireName;
      if (
        (stage !== "compile" && stage !== "decide") ||
        params.messages[0]?.content !== EFFECT_REVIEW_POLICY
      )
        return agent.call(params);
      onReview?.(stage);
      const payload = JSON.parse(params.messages.at(-1)!.content as string) as {
        revision?: number;
        operator_evidence?: Array<{ id: string }>;
        effects: Array<{
          id: string;
          target: { digest: string };
          constraints: Record<string, string | number | boolean>;
        }>;
        envelope?: { grants: Array<{ id: string }> };
      };
      if (
        !payload.effects.every(
          (effect) => effect.id.startsWith("clarvis.") || effect.id === "destructive.delete",
        )
      )
        return agent.call(params);
      if (stage === "compile") {
        if (payload.operator_evidence?.length === 0)
          throw new Error("test reviewer received no evidence");
        const evidenceIds = payload.operator_evidence!.map((entry) => entry.id);
        const targets = [...new Set(payload.effects.map((effect) => effect.target.digest))];
        return {
          usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
          toolCalls: [
            {
              id: "compile",
              name: "compile",
              arguments: {
                version: 1,
                revision: payload.revision,
                objectives: [
                  {
                    id: "test-objective",
                    summary: "Apply the operator-requested effect",
                    target_digests: targets,
                    evidence_ids: evidenceIds,
                  },
                ],
                grants: payload.effects.map((effect, index) => ({
                  id: `test-grant-${index}`,
                  effect_id: effect.id,
                  relation: "direct" as const,
                  target_digests: [effect.target.digest],
                  constraints: effect.constraints,
                  evidence_ids: evidenceIds,
                })),
                exclusions: [],
              },
            },
          ],
        };
      }
      return {
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
        toolCalls: [
          {
            id: "decide",
            name: "decide",
            arguments: {
              decision: "allow",
              grant_ids: payload.envelope!.grants.map((grant) => grant.id),
              relation: "direct",
            },
          },
        ],
      };
    },
  };
}
