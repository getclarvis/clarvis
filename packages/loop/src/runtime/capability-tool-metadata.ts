import type { Capability, ToolEffect } from "@clarvis/capability";

/** Tool-name ownership and effect declarations collected from registered capabilities. */
export interface CapabilityToolMetadata {
  /** Every capability-owned wire name that MCP namespacing must not claim. */
  readonly reservedWireNames: readonly string[];
  /** Explicit effects keyed by capability-owned wire name. */
  readonly toolEffects: Readonly<Record<string, ToolEffect>>;
}

/**
 * Collect the tool metadata declared by every registered capability.
 *
 * @param capabilities - The host's complete registration list, before per-run
 *   activation is evaluated.
 * @returns The reserved names and effects the engine must carry into this run.
 * @remarks Metadata belongs to registration rather than activation: a capability
 * whose `forRun` returns `null` still owns its wire names, so an MCP server cannot
 * take one during a gated-off run and silently change the meaning of a later run.
 * Effect declarations retain registration-order, last-wins behavior to match the
 * former inline composition in the orchestrator.
 */
export function collectCapabilityToolMetadata(
  capabilities: readonly Capability[],
): CapabilityToolMetadata {
  const reservedWireNames: string[] = [];
  const toolEffects: Record<string, ToolEffect> = {};
  for (const capability of capabilities) {
    reservedWireNames.push(...(capability.reservedWireNames ?? []));
    Object.assign(toolEffects, capability.toolEffects ?? {});
  }
  return { reservedWireNames, toolEffects };
}
