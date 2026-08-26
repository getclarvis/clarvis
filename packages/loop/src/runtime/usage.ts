import type { MutableUsage, PerAgentUsage, Usage } from "@clarvis/capability";
import type { TokenAccumulator, SubagentAggregate } from "@clarvis/capability";
import type { LLMUsage } from "@clarvis/capability";

/**
 * Fold one provider call's token counts into a running {@link TokenAccumulator}.
 *
 * @param acc - the accumulator to mutate in place.
 * @param usage - the per-call token counts reported by the provider.
 */
export function addUsage(acc: TokenAccumulator, usage: LLMUsage): void {
  acc.input += usage.input_tokens;
  acc.output += usage.output_tokens;
  acc.cached += usage.cached_tokens;
  acc.cache_write += usage.cache_write_tokens;
}

/**
 * Add one finished sub-agent's tokens and iterations into the per-model
 * aggregate map, creating the bucket on first use and bumping its `instances`.
 *
 * @param byModel - the aggregate map keyed by model ref, mutated in place.
 * @param modelRef - the sub-agent's model, the bucket key.
 * @param delta - that sub-agent's total tokens and iteration count.
 * @remarks Each call counts as exactly one sub-agent instance, regardless of the
 *   token/iteration totals in `delta`.
 */
export function accumulateSubagentUsage(
  byModel: Map<string, SubagentAggregate>,
  modelRef: string,
  delta: { input: number; output: number; cached: number; cache_write: number; iterations: number },
): void {
  let agg = byModel.get(modelRef);
  if (agg === undefined) {
    agg = { input: 0, output: 0, cached: 0, cache_write: 0, iterations: 0, instances: 0 };
    byModel.set(modelRef, agg);
  }
  agg.input += delta.input;
  agg.output += delta.output;
  agg.cached += delta.cached;
  agg.cache_write += delta.cache_write;
  agg.iterations += delta.iterations;
  agg.instances += 1;
}

/**
 * Project one model's {@link SubagentAggregate} into the wire-facing
 * {@link PerAgentUsage} shape, tagged `type: "subagent"`.
 *
 * @param model - the model ref this aggregate belongs to.
 * @param agg - the accumulated tokens, iterations, and instance count.
 * @returns the per-agent usage row for this model.
 */
export function perAgentFromAggregate(model: string, agg: SubagentAggregate): PerAgentUsage {
  return {
    type: "subagent",
    model,
    input_tokens: agg.input,
    output_tokens: agg.output,
    cached_tokens: agg.cached,
    cache_write_tokens: agg.cache_write,
    iterations: agg.iterations,
    instances: agg.instances,
  };
}

/**
 * Inputs to {@link finalizeLeadSubagentUsage}: the lead's own model, tokens and
 * iteration count, the per-model sub-agent aggregates, the run's wall time, and
 * any usage warnings to attach.
 *
 * @remarks `primarySubagentModel` is the model reported for the placeholder
 *   sub-agent row when no sub-agent ever ran (see {@link finalizeLeadSubagentUsage}).
 */
export interface LeadSubagentUsageInput {
  leadModel: string;
  primarySubagentModel: string;
  leadUsage: TokenAccumulator;
  leadIterations: number;
  subagentsByModel: Map<string, SubagentAggregate>;
  elapsedMs: number;
  warnings?: string[];
  /** The vision pre-pass's model and tokens, when one ran. */
  vision?: VisionUsage;
}

/** What the vision pre-pass spent, and on which model. */
export interface VisionUsage {
  model: string;
  tokens: TokenAccumulator;
}

/** Projects a {@link VisionUsage} into its `type: "vision"` row. */
export function perAgentFromVision(vision: VisionUsage): PerAgentUsage {
  return {
    type: "vision",
    model: vision.model,
    input_tokens: vision.tokens.input,
    output_tokens: vision.tokens.output,
    cached_tokens: vision.tokens.cached,
    cache_write_tokens: vision.tokens.cache_write,
  };
}

/**
 * Assemble the final {@link Usage} for a lead run: a `type: "lead"` row followed
 * by one `type: "subagent"` row per model that ran.
 *
 * @param input - the lead totals and per-model sub-agent aggregates; see
 *   {@link LeadSubagentUsageInput}.
 * @returns the run usage, its `iterations_used` being the lead's plus all
 *   sub-agents' iterations and the lead row's `subagents_spawned` the total
 *   instance count.
 * @remarks When no sub-agent ever ran, a single zeroed placeholder row for
 *   `primarySubagentModel` is emitted so the shape always names the sub-agent
 *   model; otherwise sub-agent rows are sorted by model. `warnings` is attached
 *   only when non-empty.
 */
export function finalizeLeadSubagentUsage(input: LeadSubagentUsageInput): Usage {
  let totalInstances = 0;
  let totalIterations = 0;
  for (const agg of input.subagentsByModel.values()) {
    totalInstances += agg.instances;
    totalIterations += agg.iterations;
  }
  const lead: PerAgentUsage = {
    type: "lead",
    model: input.leadModel,
    input_tokens: input.leadUsage.input,
    output_tokens: input.leadUsage.output,
    cached_tokens: input.leadUsage.cached,
    cache_write_tokens: input.leadUsage.cache_write,
    iterations: input.leadIterations,
    subagents_spawned: totalInstances,
  };
  const subagents: PerAgentUsage[] =
    input.subagentsByModel.size === 0
      ? [
          {
            type: "subagent",
            model: input.primarySubagentModel,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cache_write_tokens: 0,
            iterations: 0,
            instances: 0,
          },
        ]
      : [...input.subagentsByModel.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([model, agg]) => perAgentFromAggregate(model, agg));
  const usage: Usage = {
    iterations_used: input.leadIterations + totalIterations,
    elapsed_ms: Math.round(input.elapsedMs),
    by_agent: [lead, ...subagents, ...(input.vision ? [perAgentFromVision(input.vision)] : [])],
  };
  if (input.warnings && input.warnings.length > 0) {
    usage.warnings = input.warnings;
  }
  return usage;
}

/**
 * Assemble the final {@link Usage} for a non-lead (single-agent) run: one
 * `type: "subagent"` row for the entry model.
 *
 * @param raw - the accumulated tokens and iteration count.
 * @param model - the entry model ref.
 * @param elapsedMs - the run's wall time, rounded into the result.
 * @returns the run usage carrying the single per-agent row.
 * @remarks Callers append any nested sub-agent rows and fold their iterations
 *   into `iterations_used` after this returns (see
 *   {@link createUsageAccounting}).
 */
export function finalizeUsage(raw: MutableUsage, model: string, elapsedMs: number): Usage {
  const perAgent: PerAgentUsage = {
    type: "subagent",
    model,
    input_tokens: raw.tokens.input,
    output_tokens: raw.tokens.output,
    cached_tokens: raw.tokens.cached,
    cache_write_tokens: raw.tokens.cache_write,
  };
  return {
    iterations_used: raw.iterations,
    elapsed_ms: Math.round(elapsedMs),
    by_agent: [perAgent],
  };
}
