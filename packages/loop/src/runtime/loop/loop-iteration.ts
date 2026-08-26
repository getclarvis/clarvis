import type { AgentRole, TracePort } from "@clarvis/capability";
import type { IterationCounter } from "../budget/budget.ts";
import type { CompactionEvent } from "../context/context-compaction.ts";
import { startIteration } from "./iteration-metrics.ts";

/** The maximum number of context-overflow evict-and-retry attempts allowed within a single model call. */
export const MAX_OVERFLOW_RECOVERIES = 3;

/**
 * The outcome of {@link runIterationPreamble}: `proceed: true` with the started
 * iteration's number and start time, or `proceed: false` with the reason the
 * iteration was aborted before starting (`cancelled` or `all_tools_unavailable`).
 */
export type IterationPreamble =
  | { proceed: true; iteration: number; iterStart: number }
  | { proceed: false; reason: "cancelled" | "all_tools_unavailable" };

/**
 * Run the checks and setup that gate the top of every loop iteration.
 *
 * @param args.signal - abort probe; an aborted signal yields `cancelled`.
 * @param args.allToolsUnavailable - guard that, when true, records a `terminate`
 *   trace event and yields `all_tools_unavailable`.
 * @param args.compact - context-compaction step run before the iteration; a
 *   returned event is traced as `compaction`.
 * @param args.counter - the iteration counter advanced by {@link startIteration}.
 * @param args - the remaining fields (trace, agent, model) identify the
 *   iteration for tracing.
 * @returns an {@link IterationPreamble}; when it proceeds, the iteration has
 *   already been counted and its `*_iteration_started` event recorded.
 */
export async function runIterationPreamble(args: {
  signal?: AbortSignal;
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  model: string;
  counter: IterationCounter;
  allToolsUnavailable: () => boolean;
  compact: () => Promise<CompactionEvent | undefined>;
}): Promise<IterationPreamble> {
  if (args.signal?.aborted) {
    return { proceed: false, reason: "cancelled" };
  }
  if (args.allToolsUnavailable()) {
    args.trace.record("terminate", { reason: "all_tools_unavailable" });
    return { proceed: false, reason: "all_tools_unavailable" };
  }
  const compactionEvent = await args.compact();
  if (compactionEvent) args.trace.record("compaction", compactionEvent);
  const { iteration, iterStart } = startIteration(args.counter, {
    trace: args.trace,
    agent: args.agent,
    ...(args.subagentInstanceId !== undefined
      ? { subagentInstanceId: args.subagentInstanceId }
      : {}),
    model: args.model,
  });
  return { proceed: true, iteration, iterStart };
}
