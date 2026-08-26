import type { NamespacedRegistry } from "@clarvis/capability";
import { LEAD_NO_PROGRESS_LIMIT } from "../loop/loop-shared.ts";
import type { RunAgentInput } from "../loop/run-agent.ts";

/**
 * The subset of {@link RunAgentInput} that shapes the lead (entry) agent's loop
 * behavior — progress signalling, the per-checkpoint runtime note, the
 * all-tools-unavailable guard, and the no-progress / text-without-submit
 * convergence messages.
 *
 * @remarks Produced by {@link buildLeadInputPersona} and spread into the lead's
 *   `runAgent` call, distinct from the sub-agent persona built by
 *   `buildSubagentInputPersona`.
 */
export type LeadPersona = Pick<
  RunAgentInput,
  | "mcpProgress"
  | "mcpFullToolset"
  | "buildBeforeCheckpoint"
  | "allToolsUnavailable"
  | "noProgressLimit"
  | "noProgressMessage"
  | "textNoSubmitMessage"
  | "emptyResponseAgent"
>;

/**
 * Inputs for {@link buildLeadInputPersona}: the lead's tool `registry`, its
 * iteration cap `entryMax`, whether the run is in `softMode` (unbounded
 * iterations), whether the lead and/or sub-agents carry built-in
 * tools, and a lazy `buildSubagentRegistry` used only to decide the
 * all-tools-unavailable guard.
 */
export interface LeadPersonaParams {
  registry: NamespacedRegistry;
  entryMax: number;
  softMode: boolean;
  leadHasBuiltins: boolean;
  subagentsHaveBuiltins: boolean;
  buildSubagentRegistry: () => NamespacedRegistry;
}

/**
 * Builds the lead agent's {@link LeadPersona} from {@link LeadPersonaParams}.
 *
 * @param params - the lead's registry, budgets, and mode flags; see
 *   {@link LeadPersonaParams}.
 * @returns the persona spread into the lead's `runAgent` call.
 * @remarks `buildBeforeCheckpoint` appends a `tokens_remaining` runtime note
 *   each checkpoint, reporting remaining tokens (`"unbounded"` when the ledger is
 *   infinite) and remaining lead iterations (`"unbounded"` under `softMode` or an
 *   infinite cap). `allToolsUnavailable` reports true only when neither the lead
 *   nor sub-agents carry built-ins and both the lead's registry and a freshly
 *   built sub-agent registry are non-empty yet fully unavailable. The no-progress
 *   limit is {@link LEAD_NO_PROGRESS_LIMIT}; the no-progress message reminds
 *   the lead which child-spawn tool fits independent versus tracked work.
 */
export function buildLeadInputPersona(params: LeadPersonaParams): LeadPersona {
  const { registry, entryMax, softMode } = params;
  return {
    mcpProgress: (r) => r.errText === null,
    mcpFullToolset: true,
    buildBeforeCheckpoint: (bc) => () => {
      const remTokens = bc.budget.ledger.remaining();
      const remIters = entryMax - bc.budget.counter.count();
      const tokensRemaining = Number.isFinite(remTokens) ? Math.max(0, remTokens) : "unbounded";
      const itersRemaining =
        softMode || !Number.isFinite(remIters) ? "unbounded" : Math.max(0, remIters);
      bc.ctx.appendRuntimeNote(
        "tokens_remaining",
        `[runtime: tokens_remaining=${tokensRemaining}, lead_iterations_remaining=${itersRemaining}]`,
      );
    },
    allToolsUnavailable: () => {
      if (params.leadHasBuiltins || params.subagentsHaveBuiltins) return false;
      const subagentRegistry = params.buildSubagentRegistry();
      return (
        registry.tools.length > 0 &&
        registry.allUnavailable() &&
        (subagentRegistry.tools.length === 0 || subagentRegistry.allUnavailable())
      );
    },
    noProgressLimit: LEAD_NO_PROGRESS_LIMIT,
    noProgressMessage: (streak) =>
      `Lead made no progress for ${streak} consecutive iterations (no sub-agent spawned, no task judged, no tool call). Last actions produced only errors or no-ops. Use spawn_subagent for independent work; delegate_task requires the exact id of an existing tracked task.`,
    textNoSubmitMessage: (streak) =>
      `Lead emitted assistant text for ${streak} consecutive iterations without calling submit_result to finalize.`,
    emptyResponseAgent: "Lead",
  };
}
