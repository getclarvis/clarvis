import type { EnvConfig } from "@clarvis/capability";
import type { MutableUsage, Usage } from "@clarvis/capability";
import type { TokenAccumulator, SubagentAggregate } from "@clarvis/capability";
import { createIterationCounter, type IterationCounter } from "./budget/budget.ts";
import { agentToolsActive } from "./tools/builtin/grants.ts";
import {
  finalizeLeadSubagentUsage,
  finalizeUsage,
  perAgentFromAggregate,
  perAgentFromVision,
  type VisionUsage,
} from "./usage.ts";
import type { RunShape } from "./run-shape.ts";

/**
 * The mutable usage-tracking surface for one run: the entry agent's token
 * accumulator and iteration counter, the per-model sub-agent aggregates, any
 * static warnings, and {@link UsageAccounting.finalize | finalize} to snapshot
 * it all into a wire {@link Usage}.
 *
 * @remarks The three mutable fields are shared by reference with the loop and
 *   delegation machinery, which write into them as the run proceeds; `finalize`
 *   reads their live state each time it is called.
 */
export interface UsageAccounting {
  entryUsage: TokenAccumulator;
  counter: IterationCounter;
  subagentAggByModel: Map<string, SubagentAggregate>;
  warnings: string[];
  /**
   * The vision pre-pass's spend, set by the pre-pass when one ran.
   *
   * @remarks A mutable single slot rather than a map: a run makes at most one
   *   such call. It is deliberately *not* folded into
   *   {@link UsageAccounting.subagentAggByModel} — doing so reported a spawned
   *   sub-agent that never existed and inflated the lead's `subagents_spawned`.
   */
  vision: { current?: VisionUsage };
  finalize: () => Usage;
}

/**
 * Derive the static lead-run warnings from the spawnable sub-agent profiles:
 * `subagent_has_no_tools` when none has tools or active built-ins, and
 * `subagent_ask_user_ignored` when any grants `ask_user` (which sub-agents
 * cannot use).
 */
function collectLeadWarnings(shape: RunShape, deps: { env: EnvConfig }): string[] {
  const warnings: string[] = [];
  const spawnable = [...shape.spawnableRegistry.values()];
  if (!spawnable.some((pp) => pp.tools.length > 0 || agentToolsActive(deps.env, pp.grants))) {
    warnings.push("subagent_has_no_tools");
  }
  if (spawnable.some((pp) => (pp.grants ?? []).includes("ask_user"))) {
    warnings.push("subagent_ask_user_ignored");
  }
  return warnings;
}

/**
 * Build the {@link UsageAccounting} for a run: a fresh iteration counter capped
 * at `entryMax`, a zeroed entry accumulator, an empty sub-agent aggregate map,
 * and a `finalize` closure that snapshots them into a {@link Usage}.
 *
 * @param a.shape - the run shape; its `isLead` selects the lead-vs-single-agent
 *   finalization path and drives the static warnings.
 * @param a.deps - carries the {@link EnvConfig} used to test for active built-in
 *   tools when collecting lead warnings.
 * @param a.entryMax - the iteration cap for the entry agent's counter.
 * @param a.startedAt - the `performance.now()` origin from which `finalize`
 *   measures `elapsed_ms`.
 * @returns the accounting surface; `finalize` may be called more than once and
 *   reflects live state each time.
 * @remarks For a lead run, `finalize` delegates to
 *   {@link finalizeLeadSubagentUsage}; otherwise it builds a single-agent
 *   {@link Usage} and appends one row per sub-agent model, folding their
 *   iterations into `iterations_used`.
 */
export function createUsageAccounting(a: {
  shape: RunShape;
  deps: { env: EnvConfig };
  entryMax: number;
  startedAt: number;
}): UsageAccounting {
  const { shape, deps, entryMax, startedAt } = a;
  const { isLead } = shape;
  const entryModelFull = shape.entryProfile.model;

  const counter = createIterationCounter(entryMax);
  const entryUsage: TokenAccumulator = { input: 0, output: 0, cached: 0, cache_write: 0 };
  const subagentAggByModel = new Map<string, SubagentAggregate>();
  const vision: { current?: VisionUsage } = {};
  const warnings = isLead ? collectLeadWarnings(shape, deps) : [];

  const finalize = (): Usage => {
    const elapsedMs = performance.now() - startedAt;
    if (isLead) {
      return finalizeLeadSubagentUsage({
        leadModel: entryModelFull,
        primarySubagentModel: shape.primarySubagentModel,
        leadUsage: entryUsage,
        leadIterations: counter.count(),
        subagentsByModel: subagentAggByModel,
        elapsedMs,
        warnings,
        ...(vision.current ? { vision: vision.current } : {}),
      });
    }
    const snapshot: MutableUsage = { iterations: counter.count(), tokens: { ...entryUsage } };
    const usage = finalizeUsage(snapshot, entryModelFull, elapsedMs);
    for (const [model, agg] of subagentAggByModel.entries()) {
      usage.by_agent.push(perAgentFromAggregate(model, agg));
      usage.iterations_used += agg.iterations;
    }
    if (vision.current) usage.by_agent.push(perAgentFromVision(vision.current));
    if (warnings.length > 0) usage.warnings = warnings;
    return usage;
  };

  return { entryUsage, counter, subagentAggByModel, vision, warnings, finalize };
}
