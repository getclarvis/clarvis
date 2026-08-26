/**
 * The indexing pass and the run it indexes must advertise the **same** wire
 * surface.
 *
 * @remarks This is the assertion the prompt-cache reuse rests on. A pass that
 * continues a finished run (`continue_from`) is served from the provider's
 * prefix cache only while the request is byte-identical up to the appended
 * instruction — and a provider serializes **tools → system → messages**, so the
 * tool array is the very first thing that can break it. Advertise one tool
 * differently, in a different order, or with a different description, and the
 * whole prefix is billed fresh: `specs/cross-cutting/prompt-cache.md` prices that at 120:1
 * against a cache read.
 *
 * Nothing else can see this. Both capabilities build their defs from the same
 * `createMemoryTools`, so the names agree today by construction — but the
 * read/write partition is a **literal `Set` duplicated in two files**
 * (`src/capability.ts` and `src/indexer/capability.ts`), and the arrays are
 * assembled as `[...read, ...write]` in each. Move one name across that
 * partition in one file and the two arrays silently reorder: every suite stays
 * green, every tool still works, and the cache saving quietly disappears with no
 * failing assertion anywhere. It is the same hazard `packages/paths` guards with
 * its `".clarvis"` sweep — a duplicated literal that has no owner.
 *
 * The comparison is on the full {@link NamespacedTool}, not on names, because
 * `description` and `inputSchema` are on the wire too.
 *
 * **What this deliberately does not fire on**, established by perturbing each
 * `Set` and watching it: moving a name across the partition *at its boundary*
 * (today `grep_memories`, the last read tool) leaves the concatenated
 * `[...read, ...write]` array in the same order on both sides, so the wire
 * surface is genuinely unchanged and the guard stays green. Only the call budget
 * that name is charged against moves, which is runtime behaviour behind an
 * identical surface — exactly the kind of difference this design depends on
 * being free. Moving a non-boundary name reorders the array and turns it red.
 */
import { describe, expect, it } from "bun:test";

import type { MemoryFactory } from "../../src/factory.ts";
import { createMemory } from "../../src/index.ts";
import { createMemoryCapability } from "../../src/capability.ts";
import { createIndexerMemoryCapability } from "../../src/indexer/capability.ts";
import { DEFAULT_BUDGETS } from "../../src/config.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import { fakeAgentBuildContext, fakeRunCapabilityContext } from "../helpers/capability.ts";
import type { NamespacedTool } from "@clarvis/capability";

/** The scope of the agent that gets the write half: the run's entry agent. */
const ENTRY_SCOPE = { agent: "lead", entry: true, grants: [] } as const;

/** Everything about a tool that reaches the provider. */
function wireOf(tools: readonly NamespacedTool[] | undefined): unknown[] {
  return (tools ?? []).map((t) => ({
    fullName: t.fullName,
    wireName: t.wireName,
    mcpName: t.mcpName,
    toolName: t.toolName,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** The two capabilities' advertised tools, built over one shared store. */
async function surfaces(): Promise<{ host: unknown[]; indexer: unknown[] }> {
  const store = createInMemoryMemoryStore();
  const memory = createMemory({ store });
  const factory = { forOwnerControlPlane: () => memory } as unknown as MemoryFactory;

  const hostRun = await createMemoryCapability(factory).forRun(fakeRunCapabilityContext());
  const hostAgent = hostRun!.forAgent!(ENTRY_SCOPE);
  const host = hostAgent!.attach(fakeAgentBuildContext());

  const indexerRun = await createIndexerMemoryCapability({
    store,
    runId: "run_subject",
    budgets: DEFAULT_BUDGETS,
  }).forRun(fakeRunCapabilityContext());
  const indexerAgent = indexerRun!.forAgent!(ENTRY_SCOPE);
  const indexer = indexerAgent!.attach(fakeAgentBuildContext());

  return { host: wireOf(host.tools), indexer: wireOf(indexer.tools) };
}

describe("the indexing pass advertises the indexed run's tool surface", () => {
  it("advertises every wiki tool the entry agent has, in the same order", async () => {
    const { host, indexer } = await surfaces();
    expect(indexer).toEqual(host);
  });

  it("compares a non-empty surface, so agreement means something", async () => {
    const { host } = await surfaces();
    expect(host.length).toBe(7);
  });

  it("partitions read before write identically on both sides", async () => {
    const { host, indexer } = await surfaces();
    const names = (s: unknown[]): unknown[] => s.map((t) => (t as { wireName: string }).wireName);
    expect(names(host)).toEqual([
      "list_memories",
      "query_memories",
      "read_memory",
      "grep_memories",
      "write_memory",
      "edit_memory",
      "delete_memory",
    ]);
    expect(names(indexer)).toEqual(names(host));
  });
});
