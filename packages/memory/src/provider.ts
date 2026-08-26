/**
 * The substitutable half of execution memory.
 *
 * A **provider** supplies the *content* of memory — where the knowledge lives,
 * how it is searched, what a write does, and what the run's entry block says.
 * It never supplies the *vocabulary*: the seven tool names below are Clarvis's,
 * and a provider implements them rather than renaming them. That is what lets a
 * workspace swap its memory without rewriting a prompt, moving a grant, or
 * changing anything an agent profile says.
 *
 * See `specs/capabilities/provider-executables.md` for why the substitutable unit is the whole
 * provider rather than an individual tool call.
 */
import type { MemoryProvider, MemoryToolDef } from "./types.ts";
export type { MemoryProvider } from "./types.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "./tool-contract.ts";

/**
 * The read operations every provider must implement.
 *
 * @remarks Read is the required half because a read-only provider — a doctrine
 * document, a knowledge base nobody writes from here — is a first-class case,
 * while a provider that can write but not read is not a memory at all.
 */
export const MEMORY_READ_TOOL_NAMES = [
  "list_memories",
  "read_memory",
  "grep_memories",
  "query_memories",
] as const;

/**
 * The write operations a provider *may* implement.
 *
 * @remarks Absent, the write tools are simply never advertised and the model
 * never sees a tool that is going to refuse — which is why the contract is
 * "read required, write optional" rather than "all seven, some of which throw".
 */
export const MEMORY_WRITE_TOOL_NAMES = ["write_memory", "edit_memory", "delete_memory"] as const;

/** The built-in wiki provider's stable kind. */
export const WIKI_PROVIDER_KIND = "wiki";

/**
 * A source of execution memory, behind Clarvis's fixed tool vocabulary.
 *
 * @remarks The built-in markdown wiki is one implementation
 * ({@link wikiMemoryProvider}); a workspace may declare another through the
 * `memory.provider` settings block.
 */
/**
 * Fail loudly when a provider's tools do not carry the exact names Clarvis
 * dispatches on.
 *
 * @param provider - the provider to check.
 * @throws {@link Error} naming the offending half and the mismatch.
 * @remarks Called at construction, not at dispatch. A wrong name is a silent
 *   failure otherwise: the tool is advertised under whatever the provider
 *   called it, the model calls the name it was told, and nothing matches — so
 *   memory appears to exist and answers nothing.
 */
export function assertProviderVocabulary(provider: MemoryProvider): void {
  check(provider.kind, "read", provider.readTools, MEMORY_READ_TOOL_NAMES);
  if (provider.writeTools !== undefined) {
    check(provider.kind, "write", provider.writeTools, MEMORY_WRITE_TOOL_NAMES);
  }
}

/** One half's vocabulary check; see {@link assertProviderVocabulary}. */
function check(
  kind: string,
  half: string,
  tools: readonly MemoryToolDef[],
  expected: readonly string[],
): void {
  const got = [...tools.map((t) => t.name)].sort();
  const want = [...expected].sort();
  if (got.length !== want.length || got.some((n, i) => n !== want[i])) {
    throw new Error(
      `memory provider '${kind}' declares the wrong ${half} vocabulary: ` +
        `expected [${want.join(", ")}], got [${got.join(", ")}]`,
    );
  }
  for (const tool of tools) {
    const name = tool.name as MemoryToolName;
    const contract = MEMORY_TOOL_CONTRACTS[name];
    if (
      contract === undefined ||
      tool.description !== contract.description ||
      JSON.stringify(tool.parameters) !== JSON.stringify(memoryToolParameters(name))
    ) {
      throw new Error(
        `memory provider '${kind}' declares a non-canonical descriptor for '${tool.name}'`,
      );
    }
  }
}
