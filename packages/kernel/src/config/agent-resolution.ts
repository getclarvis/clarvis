import type { Scope } from "@clarvis/protocol";
import { BUILTIN_AGENT_NAMES } from "./builtin-agents/index.ts";

/**
 * Precedence when the same agent name appears more than once: workspace beats
 * global beats plugin beats builtin.
 *
 * @remarks In practice `"builtin"` never has to lose this comparison. A shipped
 *   agent reaches a consumer already resolved against any file overlaying it —
 *   one record, at the scope whose content is in effect — so a name never
 *   arrives as both a builtin record and a file record. The rank exists so the
 *   ordering is total for every value `scope` can hold, not because something
 *   is expected to arbitrate on it.
 */
const SCOPE_RANK: Readonly<Record<Scope | "plugin" | "builtin", number>> = {
  workspace: 3,
  global: 2,
  plugin: 1,
  builtin: 0,
};

const BUILTIN_RANK = new Map(BUILTIN_AGENT_NAMES.map((name, index) => [name, index]));

/**
 * The order every surface presents agents in: the fleet Clarvis ships, in the
 * order it ships it, then everything else ascending by name.
 *
 * @remarks This is the single owner of agent display order, for the same reason
 *   {@link resolveAgentsByName} is the single owner of precedence: the agent
 *   list, the profile picker and the automatic entry-agent fallback each used to
 *   sort by name on their own, which put `admiral` first and buried the
 *   general-purpose lead in the middle of the alphabet.
 *
 *   The rank is keyed on the **name**, not the scope, so a `marshall` a user has
 *   overlaid with their own file keeps its place at the head of the fleet rather
 *   than falling in with their custom agents.
 */
export function compareAgentDisplayOrder(a: { name: string }, b: { name: string }): number {
  const ra = BUILTIN_RANK.get(a.name) ?? Number.MAX_SAFE_INTEGER;
  const rb = BUILTIN_RANK.get(b.name) ?? Number.MAX_SAFE_INTEGER;
  return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
}

/**
 * Collapse a list of scope-tagged entries to one per `name`, workspace
 * winning over global winning over plugin.
 *
 * This is the single agent-name resolution order every consumer must agree
 * on — the kernel's run assembly, leader/default resolution, and the
 * client's profile and Agents-panel stores. `entries` may contain more than
 * one item per `name` — `writeAgent` refuses to create a cross-scope conflict,
 * but nothing stops a user dropping the same filename into both `agents/`
 * directories by hand; this only decides which one is *effective*, it does not
 * remove the others from wherever `entries` came from.
 *
 * @param entries - possibly containing more than one entry per `name`.
 * @returns one entry per distinct `name`, in order of first occurrence.
 */
export function resolveAgentsByName<
  T extends { name: string; scope: Scope | "plugin" | "builtin" },
>(entries: readonly T[]): T[] {
  const winners = new Map<string, T>();
  const order: string[] = [];
  for (const e of entries) {
    const cur = winners.get(e.name);
    if (cur === undefined) order.push(e.name);
    if (cur === undefined || SCOPE_RANK[e.scope] >= SCOPE_RANK[cur.scope]) winners.set(e.name, e);
  }
  return order.map((n) => winners.get(n)!);
}
