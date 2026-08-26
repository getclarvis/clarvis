import { ADMIRAL } from "./admiral.ts";
import { CODER } from "./coder.ts";
import { EXPLORER } from "./explorer.ts";
import { MARSHALL } from "./marshall.ts";
import { PLANNER } from "./planner.ts";
import type { BuiltinAgent } from "./types.ts";

export type { BuiltinAgent } from "./types.ts";

/**
 * The agent fleet Clarvis ships, in the order every surface presents it.
 *
 * @remarks Clarvis has no scaffolding step: these are not templates copied into
 *   the user's configuration on first run, they are the agents. A host that has
 *   never written a file still has all five, which is what lets `@clarvis/code`
 *   reach its first prompt — and `@clarvis/server` serve a request — against an
 *   empty configuration directory.
 *
 *   The order is deliberate and is the product's, not the alphabet's:
 *   {@link MARSHALL} is the general-purpose entry and the default, then the
 *   workflow lead, then the three sub-agents. {@link compareAgentDisplayOrder}
 *   is what applies it, and it ranks by *name*, so an overlay of `marshall`
 *   still sorts first.
 */
export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
  MARSHALL,
  ADMIRAL,
  CODER,
  EXPLORER,
  PLANNER,
];

/**
 * The builtin agent names in presentation order.
 *
 * @remarks Derived from {@link BUILTIN_AGENTS} rather than restated, so the two
 *   cannot disagree about either membership or order.
 */
export const BUILTIN_AGENT_NAMES: readonly string[] = BUILTIN_AGENTS.map((a) => a.name);

/** The name of the agent a host enters when a request and its settings name none. */
export const DEFAULT_ENTRY_AGENT = MARSHALL.name;

const BY_NAME = new Map(BUILTIN_AGENTS.map((a) => [a.name, a]));

/**
 * Look up one shipped agent by name.
 *
 * @param name - the agent name, unqualified.
 * @returns the {@link BuiltinAgent}, or `undefined` when Clarvis ships none by
 *   that name.
 */
export function readBuiltinAgent(name: string): BuiltinAgent | undefined {
  return BY_NAME.get(name);
}

/** Whether Clarvis ships an agent called `name`. */
export function isBuiltinAgent(name: string): boolean {
  return BY_NAME.has(name);
}
