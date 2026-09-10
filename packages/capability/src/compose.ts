/**
 * Folds AgentLoopContributions into the single set of tools/handlers/gates the
 * loop consumes. Order is contribution order (capabilities in registration
 * order, then the built-in orchestration). Tool wire names MUST be disjoint
 * across contributions — a collision would make the advertised schema and the
 * dispatching handler disagree (dispatch is first-match, the provider tool set
 * is last-def-wins), so the fold throws on duplicates. The core appends the
 * submit handler and the MCP catch-all after the fold.
 */
import type { ToolChoice } from "./llm-port.ts";
import { CapabilityUnavailableError } from "./errors.ts";
import type { NamespacedTool } from "./run.ts";
import type { CompactionAnchor } from "./compaction-anchor.ts";
import type { OutputTokenBudget } from "./output-budget.ts";
import type { FinalizeGate, OrchestrationHooks, ToolHandler } from "./loop-contract.ts";
import type {
  AgentActivation,
  AgentCapability,
  AgentIdentity,
  AgentLoopContribution,
  AgentScope,
  RunCapability,
} from "./contract.ts";

/**
 * The single flattened bundle {@link foldContributions} produces from a list of
 * {@link AgentLoopContribution}s: the union of tools/handlers/gates plus the at-
 * most-one anchor and forcedChoice and the fan-out-merged hooks the loop drives.
 */
export interface FoldedContributions {
  tools: NamespacedTool[];
  /** Subset of `tools` that counts toward availableWireNames. */
  advertisedTools: NamespacedTool[];
  handlers: ToolHandler[];
  gates: FinalizeGate[];
  anchor?: () => CompactionAnchor | undefined;
  forcedChoice?: () => ToolChoice | undefined;
  /** The agent's hard output-token ceiling, when a capability supplies one. */
  outputBudget?: OutputTokenBudget;
  hooks: OrchestrationHooks;
}

/** Per-agent activation of a run's capabilities for one scope. */
export function capabilitiesForScope(
  runCapabilities: readonly RunCapability[] | undefined,
  scope: AgentScope,
): AgentCapability[] {
  return (runCapabilities ?? [])
    .map((c) => {
      const activation = c.forAgent(scope);
      if (
        activation === null &&
        c.required === true &&
        scope.entry &&
        scope.signal?.aborted !== true
      )
        throw new CapabilityUnavailableError(c.name, "entry");
      if (activation !== null && c.required === true && scope.entry)
        return {
          attach(bc) {
            try {
              return activation.attach(bc);
            } catch (error) {
              if (scope.signal?.aborted === true) throw error;
              throw new CapabilityUnavailableError(c.name, "entry");
            }
          },
        } satisfies AgentCapability;
      return activation;
    })
    .filter((c): c is AgentCapability => c !== null);
}

/** System-prompt sections a run's capabilities contribute for one agent. */
export function systemSectionsFor(
  runCapabilities: readonly RunCapability[] | undefined,
  id: AgentIdentity,
): string[] {
  return (runCapabilities ?? [])
    .map((c) => c.systemSection?.(id))
    .filter((s): s is string => s !== undefined);
}

/** Full per-agent bundle: loop attachments + system-prompt sections. */
export function activationForScope(
  runCapabilities: readonly RunCapability[] | undefined,
  scope: AgentScope,
): AgentActivation {
  return {
    capabilities: capabilitiesForScope(runCapabilities, scope),
    systemSections: systemSectionsFor(runCapabilities, scope),
  };
}

/**
 * Fold agent-loop contributions into one {@link FoldedContributions}.
 *
 * @param contributions - in contribution order (capability registration order,
 *   then built-in orchestration).
 * @returns the merged bundle; unadvertised contributions' tools are omitted from
 *   `advertisedTools`.
 * @throws Error on a duplicate tool wire name across contributions, or when more
 *   than one contribution provides an `anchor` or a `forcedChoice`.
 */
export function foldContributions(
  contributions: readonly AgentLoopContribution[],
): FoldedContributions {
  const tools: NamespacedTool[] = [];
  const advertisedTools: NamespacedTool[] = [];
  const handlers: ToolHandler[] = [];
  const gates: FinalizeGate[] = [];
  const seenWireNames = new Set<string>();
  let anchor: FoldedContributions["anchor"];
  let forcedChoice: FoldedContributions["forcedChoice"];
  let outputBudget: OutputTokenBudget | undefined;

  for (const c of contributions) {
    if (c.tools !== undefined) {
      for (const t of c.tools) {
        if (seenWireNames.has(t.wireName)) {
          throw new Error(
            `foldContributions: duplicate tool wire name '${t.wireName}' across contributions`,
          );
        }
        seenWireNames.add(t.wireName);
      }
      tools.push(...c.tools);
      if (c.advertised !== false) advertisedTools.push(...c.tools);
    }
    if (c.handlers !== undefined) handlers.push(...c.handlers);
    if (c.gates !== undefined) gates.push(...c.gates);
    if (c.anchor !== undefined) {
      if (anchor !== undefined) {
        throw new Error("foldContributions: more than one contribution provides an anchor");
      }
      anchor = c.anchor;
    }
    if (c.forcedChoice !== undefined) {
      if (forcedChoice !== undefined) {
        throw new Error("foldContributions: more than one contribution provides a forcedChoice");
      }
      forcedChoice = c.forcedChoice;
    }
    if (c.outputBudget !== undefined) {
      if (outputBudget !== undefined) {
        throw new Error("foldContributions: more than one contribution provides an outputBudget");
      }
      outputBudget = c.outputBudget;
    }
  }

  return {
    tools,
    advertisedTools,
    handlers,
    gates,
    ...(anchor !== undefined ? { anchor } : {}),
    ...(forcedChoice !== undefined ? { forcedChoice } : {}),
    ...(outputBudget !== undefined ? { outputBudget } : {}),
    hooks: foldHooks(contributions.map((c) => c.hooks).filter((h) => h !== undefined)),
  };
}

/** Fan-out merge; each field is present only when some contribution set it, so
 * the core's presence checks (`folded.hooks.beforeIteration ? …`) keep working. */
function foldHooks(all: readonly OrchestrationHooks[]): OrchestrationHooks {
  const pick = <K extends keyof OrchestrationHooks>(key: K): OrchestrationHooks[K][] =>
    all.map((h) => h[key]).filter((f) => f !== undefined);

  const beforeIteration = pick("beforeIteration");
  const afterDispatch = pick("afterDispatch");
  const contributesProgress = pick("contributesProgress");
  const onFinalizeAccepted = pick("onFinalizeAccepted");
  const onTeardown = pick("onTeardown");

  return {
    ...(beforeIteration.length > 0
      ? {
          beforeIteration: async (signal) => {
            for (const f of beforeIteration) {
              signal?.throwIfAborted();
              const result = await f!(signal);
              signal?.throwIfAborted();
              if (result !== undefined) return result;
            }
          },
        }
      : {}),
    ...(afterDispatch.length > 0
      ? {
          afterDispatch: (): void => {
            for (const f of afterDispatch) f!();
          },
        }
      : {}),
    ...(contributesProgress.length > 0
      ? { contributesProgress: (): boolean => contributesProgress.some((f) => f!()) }
      : {}),
    ...(onFinalizeAccepted.length > 0
      ? {
          onFinalizeAccepted: (attempt): void => {
            for (const f of onFinalizeAccepted) f!(attempt);
          },
        }
      : {}),
    ...(onTeardown.length > 0
      ? {
          onTeardown: async (): Promise<void> => {
            for (const f of onTeardown) await f!();
          },
        }
      : {}),
  };
}
