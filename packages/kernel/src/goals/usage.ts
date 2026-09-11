import { goalUsageSchema, type GoalUsage } from "@clarvis/goal";
import { ProviderError, type LLMProvider, type LLMUsage } from "@clarvis/capability";
import type { RunUsage } from "@clarvis/protocol";

/**
 * Observe the host provider port for one goal stage, including child and auxiliary calls.
 * Missing or still-pending usage cannot be repaired by zero-initialized loop accumulators.
 * The wrapper preserves provider options, cancellation and response identity unchanged.
 */
export function createGoalUsageTracker(): {
  wrap(provider: LLMProvider): LLMProvider;
  measure(): GoalUsage;
} {
  let pending = 0;
  let unknown = false;
  let cacheUnknown = false;
  let input = 0;
  let output = 0;
  let cached = 0;
  const observe = (usage: LLMUsage) => {
    unknown ||= usage.usage_unknown === true;
    cacheUnknown ||= usage.cache_unknown === true;
    input += usage.input_tokens;
    output += usage.output_tokens;
    cached += usage.cached_tokens;
  };
  return {
    wrap(provider) {
      return {
        async call(params) {
          pending++;
          try {
            const result = await provider.call(params);
            observe(result.usage);
            if (result.retriedUsage !== undefined) observe(result.retriedUsage);
            return result;
          } catch (error) {
            const usage =
              error instanceof ProviderError
                ? (error.accumulatedUsage ?? error.partialUsage)
                : undefined;
            if (usage === undefined) unknown = true;
            else observe(usage);
            throw error;
          } finally {
            pending--;
          }
        },
      };
    },
    measure() {
      if (unknown || pending > 0) return { kind: "unknown" };
      const result = goalUsageSchema.safeParse({
        kind: "measured",
        input,
        output,
        ...(cacheUnknown ? {} : { cached }),
      });
      return result.success ? result.data : { kind: "unknown" };
    },
  };
}

/**
 * Normalize one bound run's complete accounting scope, including its attributed child/auxiliary
 * work. Agent detail takes precedence over redundant stored totals, matching session accounting.
 * Independent memory-index runs are never added to this run. Missing or invalid telemetry stays
 * unknown; absent cache detail is conservative, not a measured cache miss.
 */
export function measureGoalRunUsage(usage: RunUsage | undefined): GoalUsage {
  if (usage === undefined) return { kind: "unknown" };
  if (usage.by_agent === undefined) {
    const parsed = goalUsageSchema.safeParse({
      kind: "measured",
      input: usage.input_tokens,
      output: usage.output_tokens,
      ...(usage.cached_tokens === undefined ? {} : { cached: usage.cached_tokens }),
    });
    return parsed.success ? parsed.data : { kind: "unknown" };
  }
  if (usage.by_agent.length === 0) return { kind: "unknown" };
  let input = 0;
  let output = 0;
  let cached: number | undefined = 0;
  for (const agent of usage.by_agent) {
    const parsed = goalUsageSchema.safeParse({
      kind: "measured",
      input: agent.input_tokens,
      output: agent.output_tokens,
      ...(agent.cached_tokens === undefined ? {} : { cached: agent.cached_tokens }),
    });
    if (!parsed.success || parsed.data.kind !== "measured") return { kind: "unknown" };
    input += parsed.data.input;
    output += parsed.data.output;
    if (cached !== undefined) {
      if (parsed.data.cached !== undefined) cached += parsed.data.cached;
      else if (parsed.data.input > 0) cached = undefined;
    }
  }
  const total = goalUsageSchema.safeParse({
    kind: "measured",
    input,
    output,
    ...(cached === undefined ? {} : { cached }),
  });
  return total.success ? total.data : { kind: "unknown" };
}
