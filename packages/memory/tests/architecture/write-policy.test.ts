/**
 * Memory writes are authorised, never standing.
 *
 * @remarks The rule is carried entirely in prose, across three strings that have
 * to agree, so nothing but a test can hold it. The agent learns about memory
 * through exactly two channels that involve no tool call — the capability's
 * system section and the `<memory>` seed block — and both used to end by telling
 * it to record learnings *as you go*. That is the indexing pass's job; an agent
 * doing it inline records what it currently believes rather than what turned out
 * to be true.
 *
 * The third string is the one that makes the other two safe. A continuation pass
 * **inherits this same system section**, byte for byte, and is then handed the
 * indexing instruction as a trailing message. If the section simply forbade
 * writing, the pass would face a system-level prohibition and a trailing request
 * to write, with the prohibition in the stronger position — so the section
 * promises an explicit authorisation later, and the instruction delivers it in
 * those terms. Break either half and the pass quietly stops recording anything,
 * with every suite green.
 */
import { describe, expect, it } from "bun:test";

import type { Capability, RunCapability } from "@clarvis/capability";
import type { MemoryFactory } from "../../src/factory.ts";
import { createMemory } from "../../src/index.ts";
import { createMemoryCapability } from "../../src/capability.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import { INDEXER_CONTINUATION_INSTRUCTION } from "../../src/indexer/request.ts";
import { fakeRunCapabilityContext } from "../helpers/capability.ts";

const ENTRY = { agent: "lead", entry: true, grants: [] } as const;
const SUBAGENT = { agent: "subagent", entry: false, grants: [] } as const;

/** The write tools, as the model would name them. */
const WRITE_TOOLS = ["write_memory", "edit_memory", "delete_memory"];

/** A capability over a tree that already has a PROFILE, so the seed is real. */
async function capability(): Promise<Capability> {
  const store = createInMemoryMemoryStore();
  const memory = createMemory({ store });
  const write = memory.tools.find((t) => t.name === "write_memory")!;
  await write.execute({
    path: "PROFILE.md",
    content: "---\ndescription: what this workspace is\n---\n\nBun monorepo.",
  });
  return createMemoryCapability({ forOwnerControlPlane: () => memory } as unknown as MemoryFactory);
}

/** The run capability, built over that tree. */
async function runCapability(): Promise<RunCapability> {
  return (await (await capability()).forRun(fakeRunCapabilityContext())) as RunCapability;
}

/** The system section composed for one agent scope. */
async function sectionFor(scope: typeof ENTRY | typeof SUBAGENT): Promise<string> {
  return (await runCapability()).systemSection!(scope)!;
}

describe("the system section withholds standing write permission", () => {
  it("tells the entry agent not to write on its own initiative", async () => {
    const section = await sectionFor(ENTRY);
    expect(section).toContain("Do NOT call write_memory");
    expect(section.toLowerCase()).not.toContain("as you go");
  });

  it("names both authorisations: the user asking, and the dedicated pass", async () => {
    const section = await sectionFor(ENTRY);
    expect(section).toContain("dedicated pass");
    expect(section).toContain("when the user asks");
  });

  it("still tells every agent how to read the wiki", async () => {
    for (const scope of [ENTRY, SUBAGENT]) {
      expect(await sectionFor(scope)).toContain("query_memories");
    }
  });

  it("says nothing about writing to a subagent, which has no write tools", async () => {
    const section = await sectionFor(SUBAGENT);
    for (const tool of WRITE_TOOLS) expect(section).not.toContain(tool);
  });
});

describe("the seed block does not re-authorise what the section withheld", () => {
  it("points at the navigation tools and no further", async () => {
    const seed = await (await runCapability()).seedBlock!();
    expect(seed).toContain("list_memories");
    for (const tool of WRITE_TOOLS) expect(seed).not.toContain(tool);
  });
});

describe("the indexing pass carries the authorisation the section promised", () => {
  it("grants in the same terms the section defers to", () => {
    expect(INDEXER_CONTINUATION_INSTRUCTION).toContain("explicitly authorised");
    for (const tool of WRITE_TOOLS) {
      expect(INDEXER_CONTINUATION_INSTRUCTION).toContain(tool);
    }
  });

  it("identifies itself as the pass the section told the agent to wait for", () => {
    expect(INDEXER_CONTINUATION_INSTRUCTION).toContain("dedicated memory pass");
  });
});
