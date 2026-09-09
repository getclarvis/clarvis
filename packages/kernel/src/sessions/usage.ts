import type { ModelCost, RunUsage, SessionTotals } from "@clarvis/protocol";

/** Preserve the existing measured/unknown cache semantics without inventing model prices. */
export function addRunUsage(
  totals: SessionTotals,
  usage: RunUsage | undefined,
  priceFor?: (model: string) => ModelCost | undefined,
): void {
  if (usage === undefined) return;
  if (usage.by_agent === undefined) {
    const input = usage.input_tokens ?? 0;
    totals.input += input;
    totals.output += usage.output_tokens ?? 0;
    if (totals.cached !== undefined) {
      if (usage.cached_tokens !== undefined) totals.cached += usage.cached_tokens;
      else if (input > 0) delete totals.cached;
    }
    return;
  }
  for (const agent of usage.by_agent) {
    totals.input += agent.input_tokens;
    totals.output += agent.output_tokens;
    if (totals.cached !== undefined) totals.cached += agent.cached_tokens;
    const price = priceFor?.(agent.model);
    if (price === undefined) continue;
    const fresh = Math.max(0, agent.input_tokens - agent.cached_tokens);
    const cost =
      (fresh * price.input +
        agent.output_tokens * price.output +
        agent.cached_tokens * (price.cache_read ?? price.input) +
        (agent.cache_write_tokens ?? 0) * (price.cache_write ?? price.input)) /
      1e6;
    totals.cost_usd = (totals.cost_usd ?? 0) + cost;
  }
}
