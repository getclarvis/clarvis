import type { NamespacedRegistry } from "@clarvis/capability";

import {
  buildRegistry as buildRegistryWith,
  poolToolNames,
  selectTools,
  type RegistryEntry,
} from "@clarvis/mcp-client";
import { RESERVED_WIRE_NAMES } from "./wire-names.ts";

export { poolToolNames, selectTools, type RegistryEntry };

/**
 * Build a {@link NamespacedRegistry} with the engine's own tool names reserved.
 *
 * @param entries - the connections and their tools.
 * @param capabilityReserved - names the run's registered capabilities own, on
 *   top of the engine's own vocabulary.
 * @returns the registry, with every reserved name already taken so no MCP tool
 *   can be assigned one.
 * @remarks The MCP client takes the reserved set as an argument because it does
 *   not know the host's tool vocabulary — that is what removed its one import of
 *   `runtime/`. Binding it here rather than at each call site keeps the four
 *   callers unable to forget the *engine's* half.
 * @remarks `capabilityReserved` is **required**, with no default. It was
 *   optional for exactly one commit, and in that state three of the four call
 *   sites — the sub-agent, vision-delegate and lead-facing registries — silently
 *   took `[]` and reserved nothing a capability owned, while the entry agent's
 *   did. A default turns a forgotten call site into a shadowed tool name nothing
 *   reports; requiring it turns the same mistake into a compile error. Pass `[]`
 *   deliberately when a registry genuinely has no capability names to protect.
 */
export function buildRegistry(
  entries: RegistryEntry[],
  capabilityReserved: readonly string[],
): NamespacedRegistry {
  return buildRegistryWith(entries, [...RESERVED_WIRE_NAMES, ...capabilityReserved]);
}
