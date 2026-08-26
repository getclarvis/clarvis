/**
 * The built-in markdown wiki, as a {@link MemoryProvider}.
 *
 * A thin adapter, deliberately: {@link Memory} already exposes the seven tools
 * as host-agnostic {@link MemoryToolDef}s and a `seed()`, so the wiki satisfies
 * the provider contract by selection rather than by reimplementation. Nothing
 * here knows the tree's shape — that stays inside `createMemory`.
 */
import type { Memory } from "./memory-contract.ts";
import {
  assertProviderVocabulary,
  MEMORY_READ_TOOL_NAMES,
  WIKI_PROVIDER_KIND,
  type MemoryProvider,
} from "./provider.ts";

/** The default provider's `kind`, and the value `memory.provider` defaults to. */
export { WIKI_PROVIDER_KIND } from "./provider.ts";

/** Membership test for the read half, over the contract's own name list. */
const READ_NAMES: ReadonlySet<string> = new Set(MEMORY_READ_TOOL_NAMES);

/**
 * Adapt a {@link Memory} onto the {@link MemoryProvider} contract.
 *
 * @param memory - the wiki instance for this run's owner.
 * @returns the provider; its `writeTools` are always present, since the wiki is
 *   writable by construction.
 * @throws {@link Error} when the wiki's tool names have drifted from the
 *   contract's — a rename inside `createMemoryTools` would otherwise ship a
 *   provider whose tools nothing dispatches to.
 */
export function wikiMemoryProvider(memory: Memory): MemoryProvider {
  const provider: MemoryProvider = {
    kind: WIKI_PROVIDER_KIND,
    readTools: memory.tools.filter((t) => READ_NAMES.has(t.name)),
    writeTools: memory.tools.filter((t) => !READ_NAMES.has(t.name)),
    seed: (task?: string) => memory.seed(task),
  };
  assertProviderVocabulary(provider);
  return provider;
}
