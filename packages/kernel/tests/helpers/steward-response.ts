import type { LLMCallResult } from "@clarvis/capability";

/** Deterministic Steward response for transport fixtures that test the surrounding host. */
export function stewardResponse(
  messages: readonly { role: string; content?: unknown }[],
): LLMCallResult {
  const frame = JSON.parse(
    String(messages.findLast((message) => message.role === "user")?.content),
  ) as {
    goal_header: { mode: string; criteria: Array<{ id: string; kind: string }> };
  };
  const result =
    frame.goal_header.mode === "observation"
      ? { decision: "aligned", summary: "Fixture work is aligned" }
      : {
          decision: "completion",
          verdict: "achieved",
          summary: "Fixture result observed",
          assessments: [
            ...["definition", "objective"].map((scope) => ({
              scope,
              verdict: "satisfied",
              rationale: "Fixture result observed",
              evidence_ids: [],
              inspected_paths: [],
            })),
            ...frame.goal_header.criteria
              .filter((criterion) => criterion.kind === "qualitative")
              .map((criterion) => ({
                scope: "criterion",
                criterion_id: criterion.id,
                verdict: "satisfied",
                rationale: "Fixture criterion observed",
                evidence_ids: [],
                inspected_paths: [],
              })),
          ],
        };
  return {
    toolCalls: [{ id: "steward-result", name: "submit_result", arguments: result }],
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cache_write_tokens: 0 },
  };
}
