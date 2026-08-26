import type { RunEvent } from "@clarvis/protocol";
export { type PlanTaskActivity } from "./plan-projection.ts";

type IterationEvent = Extract<RunEvent, { type: "iteration_completed" }>;

/** Whether a delegation's terminal status counts as success for transcript folding. */
export function subagentCompletedOk(status: string): boolean {
  return status === "completed" || status === "done";
}

/**
 * Extract an `iteration_completed` event's token counts.
 *
 * @remarks `input` stays the gross prompt — cache hits included — because that
 * is what the context window actually holds. `cached` is how much of it the
 * provider served from its prefix cache, so a surface reporting work done can
 * net it out; it is `0` when the provider or an older trace reports nothing.
 */
export function iterationTokens(event: IterationEvent): {
  input: number;
  output: number;
  cached: number;
} {
  return {
    input: event.input_tokens,
    output: event.output_tokens,
    cached: event.cached_tokens ?? 0,
  };
}

interface SubagentSeed {
  title: string;
  order: number;
  model?: string;
}

/** Assigns each subagent id a stable display title and ordinal on first sight. */
export interface SubagentRegistry {
  /** Get-or-create: an unknown id claims the next order slot. */
  resolve(id: string): SubagentSeed;
  /** Lookup only — never registers the id. */
  peek(id: string): SubagentSeed | undefined;
  clear(): void;
}

/** Build an empty {@link SubagentRegistry} for one run's transcript reduction. */
export function createSubagentRegistry(): SubagentRegistry {
  const byId = new Map<string, SubagentSeed>();
  return {
    resolve(id) {
      let w = byId.get(id);
      if (!w) {
        w = { title: "subagent", order: byId.size };
        byId.set(id, w);
      }
      return w;
    },
    peek: (id) => byId.get(id),
    clear: () => byId.clear(),
  };
}
