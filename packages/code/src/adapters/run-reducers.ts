import type { RunEvent } from "@clarvis/protocol";
import type { NodeStatus } from "../core/transcript/index.ts";
export { type PlanTaskActivity } from "./plan-projection.ts";

type IterationEvent = Extract<RunEvent, { type: "iteration_completed" }>;

/** How a delegation's terminal status reads in a projection. */
export type SubagentOutcomeKind = "completed" | "limited" | "cancelled" | "failed";

/**
 * Classify a delegation's terminal `status` — the string the trace and the wire
 * carry — for a projection to render.
 *
 * @param status - the event's `status` field.
 * @returns the outcome kind. `completed`/`done` finished on the child's own terms;
 *   a budget cap (`iteration_limit_reached`, `budget_exhausted`, `limited`) is
 *   `limited`; `cancelled`/`stopped` are `cancelled`; and an unrecognised status,
 *   including `error`, is `failed`.
 * @remarks The three non-completing families are separated here because the wire
 *   cannot separate them for a reader: `delegation_failed` is the event *kind* for
 *   every delegation that did not complete, so a projection that read "not
 *   completed" as "failed" reported a cancelled child, and a child stopped at its
 *   own iteration limit, as errors. Success is decided by `completed` alone, which
 *   is also what transcript folding keys on.
 */
export function subagentOutcomeKind(status: string): SubagentOutcomeKind {
  switch (status) {
    case "completed":
    case "done":
      return "completed";
    case "iteration_limit_reached":
    case "budget_exhausted":
    case "limited":
      return "limited";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "failed";
  }
}

/** The settled roster lifecycles a delegation outcome maps onto. */
export type SubagentSettledStatus = "done" | "limited" | "cancelled" | "error";

/**
 * Project a delegation outcome onto the roster lifecycle it settles into.
 *
 * @param kind - the classified {@link SubagentOutcomeKind}.
 * @returns the settled status a roster row keeps.
 */
export function subagentSettledStatus(kind: SubagentOutcomeKind): SubagentSettledStatus {
  switch (kind) {
    case "completed":
      return "done";
    case "limited":
      return "limited";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "error";
  }
}

/**
 * Project a roster lifecycle onto the transcript's node status.
 *
 * @param status - the row's lifecycle: one of {@link SubagentSettledStatus}, or
 *   `spawned`/`running` while the child is not settled.
 * @returns the shared {@link NodeStatus} that the rail glyph, the tone and
 *   transcript folding all read.
 */
export function subagentNodeStatus(
  status: SubagentSettledStatus | "spawned" | "running",
): NodeStatus {
  switch (status) {
    case "done":
      return "ok";
    case "limited":
      return "limited";
    case "cancelled":
      return "cancelled";
    case "error":
      return "error";
    default:
      return "running";
  }
}

/**
 * The word a settled delegation marker shows for one outcome.
 *
 * @param kind - the classified {@link SubagentOutcomeKind}.
 * @returns a short phrase naming what actually ended the child.
 */
export function subagentOutcomeLabel(kind: SubagentOutcomeKind): string {
  switch (kind) {
    case "completed":
      return "completed";
    case "limited":
      return "stopped at its limit";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
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
