import {
  contentToText,
  type LLMCallParams,
  type LLMProvider,
  type AuthorityEnvelopeV1,
} from "@clarvis/capability";
import type { CompiledAuthorityTransition } from "@clarvis/judge";

interface Snapshot {
  authority: { revision: number };
  operator_evidence: Array<{ id: string }>;
}
interface Case {
  effects: Array<{
    id: string;
    target: { digest: string };
    constraints: Record<string, string | number | boolean>;
  }>;
}

/** Decode actual private framing and the authoritative compile tool result in integration fixtures. */
export function effectReviewInput(params: LLMCallParams) {
  const frame = (name: string) => {
    const text = params.messages
      .map((message) => contentToText(message.content))
      .find((value) => value.startsWith(`<${name}>\n`));
    if (text === undefined) throw new Error(`Missing ${name}`);
    return JSON.parse(text.slice(name.length + 3, text.lastIndexOf(`\n</${name}>`))) as unknown;
  };
  const snapshot = frame("judge_snapshot_v1") as Snapshot;
  const packet = frame("judge_case_v1") as {
    facts: Case;
    host_transition?: CompiledAuthorityTransition;
  };
  const current = packet.facts;
  const result = [...params.messages].reverse().find((message) => message.role === "tool");
  const transition =
    result === undefined
      ? packet.host_transition
      : (JSON.parse(
          contentToText(result.content).replace(/^Tool 'judge_step' result: /, ""),
        ) as CompiledAuthorityTransition);
  return { snapshot, current, transition };
}

/** Answer the real private protocol with exact grants, preserving the work agent's scripted LLM. */
export function withHostValidatedEffectReview(
  agent: LLMProvider,
  onReview?: (stage: "compile" | "decide") => void,
): LLMProvider {
  return {
    async call(params) {
      if (params.agentInstanceId !== "judge" || params.tools?.[0]?.wireName !== "judge_step")
        return agent.call(params);
      const { snapshot, current, transition } = effectReviewInput(params);
      if (
        !current.effects.every(
          (effect) => effect.id.startsWith("clarvis.") || effect.id === "destructive.delete",
        )
      )
        return agent.call(params);
      const stage = transition === undefined ? "compile" : "decide";
      onReview?.(stage);
      const usage = { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 };
      if (transition === undefined) {
        if (snapshot.operator_evidence.length === 0)
          throw new Error("test reviewer received no evidence");
        const evidence_ids = snapshot.operator_evidence.map((entry) => entry.id);
        const candidate: AuthorityEnvelopeV1 = {
          version: 1,
          revision: snapshot.authority.revision,
          objectives: [
            {
              id: "test-objective",
              summary: "Apply the operator-requested effect",
              target_digests: [...new Set(current.effects.map((effect) => effect.target.digest))],
              evidence_ids,
            },
          ],
          grants: current.effects.map((effect, index) => ({
            id: `test-grant-${index}`,
            effect_id: effect.id,
            relation: "direct",
            target_digests: [effect.target.digest],
            constraints: effect.constraints,
            evidence_ids,
          })),
          exclusions: [],
        };
        return {
          usage,
          toolCalls: [
            {
              id: "compile",
              name: "judge_step",
              arguments: { action: "compile_authority", candidate },
            },
          ],
        };
      }
      return {
        usage,
        toolCalls: [
          {
            id: "decide",
            name: "judge_step",
            arguments: {
              action: "decide_effects",
              decision: "allow",
              relation: "direct",
              grant_ids: transition.envelope.grants.map((grant) => grant.id),
              revision: transition.revision,
              transition_token: transition.transition_token,
            },
          },
        ],
      };
    },
  };
}
