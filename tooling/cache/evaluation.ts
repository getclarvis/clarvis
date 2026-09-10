import type {
  CacheAgentEvaluation,
  CacheCall,
  CacheUsage,
  CacheVerdict,
  CacheWindowEvaluation,
} from "./types.ts";

/** Unknown usage never contributes a fabricated zero or a passing performance observation. */
export function validCacheUsage(usage: CacheUsage | undefined): usage is CacheUsage {
  return (
    usage !== undefined &&
    [usage.input, usage.cached, usage.output].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    usage.cached <= usage.input
  );
}

function verdict(reasons: readonly string[], incomplete: boolean): CacheVerdict {
  return reasons.length > 0 ? "fail" : incomplete ? "incomplete" : "pass";
}

/** Evaluate measured remote usage without simulating the backend's cache-write policy. */
function evaluateWindow(
  name: string,
  calls: readonly CacheCall[],
  requireGrowth: boolean,
): CacheWindowEvaluation {
  const reasons: string[] = [];
  const known = calls.filter(
    (call): call is CacheCall & { usage: CacheUsage } =>
      call.status === "completed" && validCacheUsage(call.usage) && call.usage.input > 0,
  );
  let incomplete = known.length !== calls.length || known.length < (requireGrowth ? 10 : 3);
  const input = known.reduce((sum, call) => sum + call.usage.input, 0);
  const cached = known.reduce((sum, call) => sum + call.usage.cached, 0);
  const weightedHit = input > 0 ? cached / input : undefined;
  const lastHits = known.slice(-3).map((call) => call.usage.cached / call.usage.input);
  if (weightedHit !== undefined && weightedHit < 0.9) reasons.push("weighted_hit_below_90_percent");
  if (lastHits.length === 3 && lastHits.some((hit) => hit < 0.85))
    reasons.push("last_three_hit_below_85_percent");
  const first = known[0]?.usage;
  const last = known.at(-1)?.usage;
  const inputGrowth = first && last ? last.input - first.input : undefined;
  const cachedGrowth = first && last ? last.cached - first.cached : undefined;
  if (
    requireGrowth &&
    known.length >= 10 &&
    first &&
    inputGrowth !== undefined &&
    cachedGrowth !== undefined
  ) {
    if (inputGrowth >= 8000 || inputGrowth >= first.input * 0.25) {
      if (cachedGrowth < inputGrowth * 0.1) reasons.push("cached_stagnated_while_input_grew");
    } else incomplete = true;
    for (let index = 1; index < known.length; index += 1) {
      const growth = known[index].usage.input - known[index - 1].usage.input;
      if (growth <= 0 || growth > known[index - 1].usage.input * 0.055) incomplete = true;
    }
  }
  return {
    name,
    verdict: verdict(reasons, incomplete),
    reasons: [...reasons, ...(incomplete ? ["insufficient_valid_growth_or_usage"] : [])],
    calls: calls.length,
    weightedHit,
    lastHits,
    inputGrowth,
    cachedGrowth,
  };
}

/** Each conversation is judged independently; child volume cannot repair a leader's verdict. */
export function evaluateCacheAgents(calls: readonly CacheCall[]): CacheAgentEvaluation[] {
  const groups = new Map<string, CacheCall[]>();
  for (const call of calls) {
    const key = JSON.stringify([
      call.scenario,
      call.trial,
      call.requestedModel,
      call.sessionId,
      call.agentInstanceId,
      call.purpose,
    ]);
    const group = groups.get(key) ?? [];
    group.push(call);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    group.sort(
      (a, b) => a.startedAt - b.startedAt || a.iteration - b.iteration || a.attempt - b.attempt,
    );
    const first = group[0];
    const reasons: string[] = [];
    const totals = { input: 0, cached: 0, output: 0 };
    let unknownUsageCalls = 0;
    for (const call of group) {
      if (!validCacheUsage(call.usage)) {
        unknownUsageCalls += 1;
        if (call.usage !== undefined) reasons.push("invalid_usage");
      } else {
        totals.input += call.usage.input;
        totals.cached += call.usage.cached;
        totals.output += call.usage.output;
      }
      if (call.keyHash !== first.keyHash) reasons.push("identity_changed");
      if (
        call.divergence &&
        !call.compaction &&
        call.purpose !== "compaction" &&
        call.scenario !== "C10"
      )
        reasons.push(`unexpected_${call.divergence.surface}_divergence`);
    }
    const auxiliary = first.purpose === "compaction" || first.purpose === "auxiliary";
    const windows: CacheWindowEvaluation[] = [];
    const mutation =
      first.scenario === "C10" ? group.findIndex((call) => call.divergence !== undefined) : -1;
    if (!auxiliary && mutation < 0) {
      const bases = new Map<number, CacheCall[]>();
      for (const call of group) {
        const items = bases.get(call.base) ?? [];
        items.push(call);
        bases.set(call.base, items);
      }
      for (const [base, records] of bases) {
        const conversation = records.filter((call) => call.status === "completed");
        const warmed = conversation.slice(2);
        windows.push(evaluateWindow(`base-${base}`, warmed, true));
        if (conversation.length < 12) {
          windows[windows.length - 1].verdict = "incomplete";
          windows[windows.length - 1].reasons.push("fewer_than_12_completed_calls");
        }
        const phases = new Map<string, CacheCall[]>();
        for (const call of warmed) {
          const phase = phases.get(call.phase) ?? [];
          phase.push(call);
          phases.set(call.phase, phase);
        }
        for (const [phase, items] of phases)
          if (phases.size > 1 && phase !== "before-plan" && phase !== "growth") {
            const window = evaluateWindow(
              `base-${base}/${phase}`,
              items,
              phase === "plan-unchanged",
            );
            if (phase === "plan-unchanged" && items.length < 12 && window.verdict !== "fail") {
              window.verdict = "incomplete";
              window.reasons.push("fewer_than_12_post_create_calls");
            }
            windows.push(window);
          }
        for (let index = 0; index < records.length; index += 1) {
          const transition =
            records[index]?.transition ??
            (records[index]?.truncatedNewResult ? "new-result-truncated" : undefined);
          if (!transition) continue;
          const continuation = records.slice(index, index + 4);
          const window = evaluateWindow(`transition/${transition}`, continuation, false);
          if (continuation.length < 4 && window.verdict === "pass") window.verdict = "incomplete";
          if (
            validCacheUsage(continuation[0]?.usage) &&
            continuation[0].usage.input > 0 &&
            continuation[0].usage.cached / continuation[0].usage.input < 0.85
          ) {
            window.reasons.push("first_transition_call_below_85_percent");
            window.verdict = "fail";
          }
          windows.push(window);
        }
        if (first.scenario === "C03" && first.purpose === "leader") {
          const children = calls.filter(
            (call) =>
              call.scenario === first.scenario &&
              call.trial === first.trial &&
              call.requestedModel === first.requestedModel &&
              call.sessionId === first.sessionId &&
              call.purpose === "child",
          );
          const start = Math.min(...children.map((call) => call.startedAt));
          const end = Math.max(...children.map((call) => call.endedAt));
          for (const [name, period] of [
            ["before", warmed.filter((call) => call.startedAt < start)],
            ["during", warmed.filter((call) => call.startedAt >= start && call.startedAt <= end)],
            ["after", warmed.filter((call) => call.startedAt > end)],
          ] as const)
            windows.push(evaluateWindow(`concurrency/${name}`, period, false));
        }
      }
    }
    if (!auxiliary && mutation >= 0) {
      const prior = group[mutation - 1]?.usage;
      const changed = group[mutation]?.usage;
      const measuredLoss =
        validCacheUsage(prior) && validCacheUsage(changed) && changed.cached < prior.cached;
      windows.push({
        name: "deliberate-mutation-loss",
        verdict: measuredLoss ? "pass" : "incomplete",
        reasons: measuredLoss ? [] : ["no_measured_mutation_loss"],
        calls: 1,
        lastHits: [],
      });
      windows.push(evaluateWindow("deliberate-mutation-recovery", group.slice(mutation + 2), true));
    }
    const failed = reasons.length > 0 || windows.some((window) => window.verdict === "fail");
    const incomplete =
      unknownUsageCalls > 0 ||
      windows.some((window) => window.verdict === "incomplete") ||
      (!auxiliary && windows.length === 0);
    return {
      sessionId: first.sessionId,
      agentInstanceId: first.agentInstanceId,
      purpose: first.purpose,
      verdict: failed ? "fail" : incomplete ? "incomplete" : "pass",
      reasons: [...new Set(reasons)],
      windows,
      totals,
      unknownUsageCalls,
      physicalCalls: group.length,
    };
  });
}
