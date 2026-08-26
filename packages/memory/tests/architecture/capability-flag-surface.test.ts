/**
 * `enqueueOnRunEnd: false` must remove one behaviour and change nothing else.
 *
 * @remarks An indexing pass continues the run it indexes, so it registers this
 * capability twice over: once for real, and once with the enqueue suppressed so
 * the pass does not queue itself forever. That only works while the flag is
 * genuinely invisible on the wire — the pass is served from the provider's
 * prefix cache, and `seedMarker`, `seedBlock`, `systemSection` and the tool
 * array all sit ahead of the appended instruction.
 *
 * The failure this guards against is quiet in a way a type-checker cannot help
 * with. Widening the flag to also skip `seedBlock` looks like a tidy
 * optimisation — the pass never reads a fresh seed, since a continuation keeps
 * the one it carried. But `buildEntrySeed` decides whether to keep the carried
 * block by asking whether the marker is still *live*, and a capability that
 * emits no block has no live marker: the carried entry is dropped out of the
 * middle of the transcript, and every token behind it is re-billed. The engine
 * measured one such boundary at 115,432 tokens.
 */
import { describe, expect, it } from "bun:test";

import type { Capability, NamespacedTool, RunCapability } from "@clarvis/capability";
import type { MemoryFactory } from "../../src/factory.ts";
import { createMemory } from "../../src/index.ts";
import { createMemoryCapability } from "../../src/capability.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import { fakeAgentBuildContext, fakeRunCapabilityContext } from "../helpers/capability.ts";

const ENTRY_SCOPE = { agent: "lead", entry: true, grants: [] } as const;
const SUBAGENT_SCOPE = { agent: "subagent", entry: false, grants: [] } as const;

/**
 * The capability over a store that already has a `PROFILE.md`.
 *
 * @remarks The seeding is load-bearing, not scene-setting. `seed()` resolves
 * `null` on an empty tree, so over a fresh store both sides of the comparison
 * return `undefined` for `seedBlock` and agree for the most vacuous possible
 * reason — the guard passed against a deliberately broken build until this
 * wrote a document first.
 */
async function capabilityWith(enqueueOnRunEnd: boolean): Promise<Capability> {
  const store = createInMemoryMemoryStore();
  const memory = createMemory({ store });
  const write = memory.tools.find((t) => t.name === "write_memory")!;
  await write.execute({
    path: "PROFILE.md",
    content: "---\ndescription: what this workspace is\n---\n\nBun monorepo; run bun test.",
  });
  const factory = { forOwnerControlPlane: () => memory } as unknown as MemoryFactory;
  return createMemoryCapability(factory, { enqueueOnRunEnd });
}

/** Everything about one run capability that a provider would see. */
async function wireSurfaceOf(capability: Capability): Promise<{
  seedMarker: string | undefined;
  seedBlock: string | undefined;
  entrySection: string | undefined;
  subagentSection: string | undefined;
  entryTools: string[];
  subagentTools: string[];
}> {
  const run = (await capability.forRun(fakeRunCapabilityContext())) as RunCapability;
  const toolsFor = async (scope: typeof ENTRY_SCOPE | typeof SUBAGENT_SCOPE): Promise<string[]> => {
    const agent = await run.forAgent!(scope);
    const contribution = agent!.attach(fakeAgentBuildContext());
    return ((contribution.tools ?? []) as NamespacedTool[]).map((t) => t.wireName);
  };
  return {
    seedMarker: capability.seedMarker,
    seedBlock: await run.seedBlock?.(),
    entrySection: run.systemSection?.(ENTRY_SCOPE),
    subagentSection: run.systemSection?.(SUBAGENT_SCOPE),
    entryTools: await toolsFor(ENTRY_SCOPE),
    subagentTools: await toolsFor(SUBAGENT_SCOPE),
  };
}

describe("suppressing the post-run enqueue leaves the wire surface untouched", () => {
  it("agrees on the seed marker, seed block, system sections and tools", async () => {
    const enqueueing = await wireSurfaceOf(await capabilityWith(true));
    const suppressed = await wireSurfaceOf(await capabilityWith(false));
    expect(suppressed).toEqual(enqueueing);
  });

  it("compares a surface that is actually there, so agreement means something", async () => {
    const surface = await wireSurfaceOf(await capabilityWith(true));
    expect(surface.seedMarker).toBeDefined();
    expect(surface.seedBlock).toBeDefined();
    expect(surface.entrySection).toContain("## Memory");
    expect(surface.entryTools).toHaveLength(7);
    expect(surface.subagentTools).toHaveLength(4);
  });

  it("differs in onRunEnd, and only there", async () => {
    const enqueueing = (await (
      await capabilityWith(true)
    ).forRun(fakeRunCapabilityContext())) as RunCapability;
    const suppressed = (await (
      await capabilityWith(false)
    ).forRun(fakeRunCapabilityContext())) as RunCapability;
    expect(Object.hasOwn(enqueueing, "onRunEnd")).toBe(true);
    expect(Object.hasOwn(suppressed, "onRunEnd")).toBe(false);
  });
});
