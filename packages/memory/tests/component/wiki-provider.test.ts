import { describe, expect, it, vi } from "bun:test";

import { MEMORY_READ_TOOL_NAMES, MEMORY_WRITE_TOOL_NAMES } from "../../src/provider.ts";
import { wikiMemoryProvider, WIKI_PROVIDER_KIND } from "../../src/wiki-provider.ts";
import type { MemoryToolDef } from "../../src/types.ts";
import type { Memory } from "../../src/memory-contract.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "../../src/tool-contract.ts";

function memTool(name: string): MemoryToolDef {
  const canonical = MEMORY_TOOL_CONTRACTS[name as MemoryToolName];
  return {
    name,
    description: canonical?.description ?? name,
    parameters:
      canonical === undefined
        ? { type: "object", properties: {} }
        : memoryToolParameters(name as MemoryToolName),
    execute: vi.fn().mockResolvedValue({ text: "ok", isError: false }),
  };
}

describe("wikiMemoryProvider", () => {
  const wikiOf = (over: Partial<Memory> = {}): Memory =>
    ({
      tools: [...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES].map(memTool),
      seed: vi.fn().mockResolvedValue("block"),
      ...over,
    }) as unknown as Memory;

  it("splits the wiki's seven tools into the two halves", () => {
    const provider = wikiMemoryProvider(wikiOf());
    expect(provider.kind).toBe(WIKI_PROVIDER_KIND);
    expect(provider.readTools.map((t) => t.name).sort()).toEqual(
      [...MEMORY_READ_TOOL_NAMES].sort(),
    );
    expect(provider.writeTools!.map((t) => t.name).sort()).toEqual(
      [...MEMORY_WRITE_TOOL_NAMES].sort(),
    );
  });

  it("delegates seed to the wiki, passing the task through", async () => {
    const seed = vi.fn().mockResolvedValue("b");
    const provider = wikiMemoryProvider(wikiOf({ seed } as unknown as Partial<Memory>));
    await expect(provider.seed("find the mapping")).resolves.toBe("b");
    expect(seed).toHaveBeenCalledWith("find the mapping");
  });

  it("throws when the wiki's own tool names have drifted from the contract", () => {
    const drifted = wikiOf({
      tools: [...MEMORY_READ_TOOL_NAMES, "write_memories"].map(memTool),
    } as unknown as Partial<Memory>);
    expect(() => wikiMemoryProvider(drifted)).toThrow(/wrong write vocabulary/);
  });
});
