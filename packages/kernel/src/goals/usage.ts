import { createHash } from "node:crypto";
import { goalUsageSchema, type GoalUsage, type GoalUsageGapCause } from "@clarvis/goal";
import {
  ProviderError,
  type LLMProvider,
  type LLMUsage,
  type PerAgentUsage,
} from "@clarvis/capability";
import { addRunUsage } from "../sessions/usage.ts";
import type { SessionTotals, ModelCost, RunUsage } from "@clarvis/protocol";

/**
 * Observe the host provider port for one goal stage, including child and auxiliary calls.
 * Missing or still-pending usage cannot be repaired by zero-initialized loop accumulators.
 * The wrapper preserves provider options, cancellation and response identity unchanged.
 */
export function createGoalUsageTracker(): {
  wrap(provider: LLMProvider): LLMProvider;
  measure(priceFor?: (model: string) => ModelCost | undefined): GoalUsage;
  accounting(): PerAgentUsage[];
} {
  const rows: PerAgentUsage[] = [];
  const pending = new Set<string>();
  let sequence = 0;
  let observedCalls = 0;
  const gaps = new Map<
    GoalUsageGapCause,
    { calls: number; call_ids: string[]; fingerprint: string }
  >();
  let cacheUnknown = false;
  let input = 0;
  let output = 0;
  let cached = 0;
  const addGap = (cause: GoalUsageGapCause, callId: string): void => {
    const previous = gaps.get(cause);
    gaps.set(cause, {
      calls: (previous?.calls ?? 0) + 1,
      call_ids: [...(previous?.call_ids ?? []), callId].slice(-16),
      fingerprint: createHash("sha256")
        .update(`${previous?.fingerprint ?? ""}:${callId}`)
        .digest("hex"),
    });
  };
  const observe = (usage: LLMUsage, model: string, callId: string) => {
    rows.push({
      type: "lead",
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_tokens: usage.cached_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      iterations: 0,
      subagents_spawned: 0,
    });
    /**
     * A flagged figure is a subtotal only when it actually carries tokens.
     *
     * @remarks A provider that omits usage entirely reports a flagged all-zero object: that is an
     *   absence, and counting it as an observation would turn "we were never told" into a charged
     *   zero — the exact confusion this contract exists to prevent. A flagged object that *does*
     *   carry tokens (a `partialUsage` or `accumulatedUsage` on a failed call, for instance) is a
     *   real subtotal with an open gap next to it.
     */
    if (usage.usage_unknown === true) {
      addGap("provider_unknown", callId);
      if (usage.input_tokens + usage.output_tokens > 0) observedCalls += 1;
    } else observedCalls += 1;
    cacheUnknown ||= usage.cache_unknown === true;
    input += usage.input_tokens;
    output += usage.output_tokens;
    cached += usage.cached_tokens;
  };
  return {
    wrap(provider) {
      return {
        async call(params) {
          const callId = `call_${++sequence}`;
          pending.add(callId);
          const model = `${params.provider}/${params.model}`;
          try {
            const result = await provider.call(params);
            observe(result.usage, model, callId);
            if (result.retriedUsage !== undefined)
              observe(result.retriedUsage, model, `${callId}_retry`);
            return result;
          } catch (error) {
            const usage =
              error instanceof ProviderError
                ? (error.accumulatedUsage ?? error.partialUsage)
                : undefined;
            if (usage === undefined) addGap("no_usage", callId);
            else observe(usage, model, callId);
            throw error;
          } finally {
            pending.delete(callId);
          }
        },
      };
    },
    accounting: () => structuredClone(rows),
    /**
     * The stage's consumption as far as this stage could resolve it.
     *
     * @returns a `complete` measurement when every call is accounted for, a `partial` one when a
     *   confirmed subtotal exists alongside bounded references to what stayed unresolved, and
     *   `unknown` only when no call produced a usable figure at all.
     * @remarks The subtotal is what makes a gap actionable: reporting `unknown` for a stage that
     *   measured most of its calls threw away the part that *was* known, and the Goal then treated
     *   a partly known quantity as no quantity. A call still in flight at this moment is a gap of
     *   its own — the stage closed while it was running, so its tokens were never observed — and it
     *   is reported per call rather than as one flag.
     */
    measure(priceFor) {
      if (observedCalls === 0) return { kind: "unknown" };
      const resolved = new Map(gaps);
      if (pending.size > 0)
        resolved.set("pending_call", {
          calls: pending.size,
          call_ids: [...pending].slice(-16),
          fingerprint: createHash("sha256")
            .update(JSON.stringify([...pending]))
            .digest("hex"),
        });
      const totals = {
        input,
        output,
        ...(cacheUnknown ? {} : { cached }),
      };
      const priced: SessionTotals = { input: 0, output: 0 };
      if (!cacheUnknown && priceFor !== undefined && rows.every((row) => priceFor(row.model)))
        addRunUsage(
          priced,
          {
            iterations: 0,
            elapsed_ms: 0,
            by_agent: rows.map((row) => ({ ...row, role: row.type })),
          },
          priceFor,
        );
      const cost = priced.cost_usd === undefined ? {} : { cost_usd: priced.cost_usd };
      const result =
        resolved.size === 0
          ? goalUsageSchema.safeParse({ kind: "complete", ...totals, ...cost })
          : goalUsageSchema.safeParse({
              kind: "partial",
              ...totals,
              ...cost,
              gaps: [...resolved.entries()]
                .map(([cause, gap]) => ({ cause, ...gap }))
                .sort((left, right) => left.cause.localeCompare(right.cause)),
            });
      return result.success ? result.data : { kind: "unknown" };
    },
  };
}

/**
 * Normalize one bound run's complete accounting scope, including its attributed child/auxiliary
 * work. Agent detail takes precedence over redundant stored totals, matching session accounting.
 * Independent memory-index runs are never added to this run. A row whose telemetry cannot be read
 * becomes a bounded `invalid_measure` gap instead of discarding the rows that did decode; a scope
 * with no usable subtotal at all stays unknown, and absent cache detail is conservative rather than
 * a measured cache miss.
 */
export function measureGoalRunUsage(usage: RunUsage | undefined): GoalUsage {
  if (usage === undefined) return { kind: "unknown" };
  if (usage.by_agent === undefined) {
    const parsed = goalUsageSchema.safeParse({
      kind: "complete",
      input: usage.input_tokens,
      output: usage.output_tokens,
      ...(usage.cached_tokens === undefined ? {} : { cached: usage.cached_tokens }),
    });
    return parsed.success ? parsed.data : { kind: "unknown" };
  }
  let input = 0;
  let output = 0;
  let cached: number | undefined = 0;
  let attributed = 0;
  let unreadable = 0;
  for (const agent of usage.by_agent) {
    const parsed = goalUsageSchema.safeParse({
      kind: "complete",
      input: agent.input_tokens,
      output: agent.output_tokens,
      ...(agent.cached_tokens === undefined ? {} : { cached: agent.cached_tokens }),
    });
    if (!parsed.success || parsed.data.kind !== "complete") {
      unreadable += 1;
      continue;
    }
    attributed += 1;
    input += parsed.data.input;
    output += parsed.data.output;
    if (cached !== undefined) {
      if (parsed.data.cached !== undefined) cached += parsed.data.cached;
      else if (parsed.data.input > 0) cached = undefined;
    }
  }
  /**
   * With no readable row, the run's own totals are still the best subtotal available.
   *
   * @remarks They include the unreadable rows' tokens, so they are usable precisely because
   *   nothing else was attributed: mixing them with decoded rows would charge one call twice.
   */
  const totals =
    attributed === 0
      ? { input: usage.input_tokens, output: usage.output_tokens, cached: usage.cached_tokens }
      : { input, output, ...(cached === undefined ? {} : { cached }) };
  const unmeasured = attributed === 0 ? usage.by_agent.length : unreadable;
  const total =
    unmeasured === 0
      ? goalUsageSchema.safeParse({ kind: "complete", ...totals })
      : goalUsageSchema.safeParse({
          kind: "partial",
          ...totals,
          gaps: [{ cause: "invalid_measure", calls: unmeasured }],
        });
  return total.success ? total.data : { kind: "unknown" };
}

/** Settle measured auxiliary tokens and attributed prices without charging the work allowance. */
export function addGoalAuxiliaryUsage(
  totals: SessionTotals,
  usage: GoalUsage | undefined,
  accounting: PerAgentUsage[] | undefined,
  priceFor: ((model: string) => ModelCost | undefined) | undefined,
): void {
  if (usage?.kind === "unknown" || usage === undefined) return;
  addRunUsage(totals, {
    iterations: 0,
    elapsed_ms: 0,
    input_tokens: usage.input,
    output_tokens: usage.output,
    ...(usage.cached === undefined ? {} : { cached_tokens: usage.cached }),
  });
  if (accounting === undefined || usage.cached === undefined) return;
  const priced: SessionTotals = { input: 0, output: 0 };
  addRunUsage(
    priced,
    {
      iterations: 0,
      elapsed_ms: 0,
      by_agent: accounting.map((row) => ({ ...row, role: row.type })),
    },
    priceFor,
  );
  if (priced.cost_usd !== undefined) totals.cost_usd = (totals.cost_usd ?? 0) + priced.cost_usd;
}
