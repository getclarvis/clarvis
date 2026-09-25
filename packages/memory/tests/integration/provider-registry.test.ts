import { describe, expect, it, vi } from "bun:test";
import { resolveMemoryProvider } from "../../src/provider-registry.ts";
import { MEMORY_READ_TOOL_NAMES, MEMORY_WRITE_TOOL_NAMES } from "../../src/provider.ts";
import { memoryProviderSchema } from "../../src/schemas.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "../../src/tool-contract.ts";
import type { MemoryToolDef } from "../../src/types.ts";
import type { Memory } from "../../src/memory-contract.ts";

function tool(name: string): MemoryToolDef {
  const canonical = MEMORY_TOOL_CONTRACTS[name as MemoryToolName];
  return {
    name,
    description: canonical.description,
    parameters: memoryToolParameters(name as MemoryToolName),
    execute: vi.fn().mockResolvedValue({ text: "ok", isError: false }),
  };
}

const wiki = (): Memory =>
  ({
    tools: [...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES].map(tool),
    seed: vi.fn().mockResolvedValue(null),
  }) as unknown as Memory;

describe("built-in memory provider", () => {
  it("resolves the wiki with its existing provider identity", async () => {
    const result = await resolveMemoryProvider(undefined, { wiki: wiki(), seedMaxChars: 4_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider.kind).toBe("wiki");
      expect(result.key).toBe(
        "wiki:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      );
    }
  });

  it("reports an unavailable wiki", async () => {
    const result = await resolveMemoryProvider(undefined, { seedMaxChars: 4_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toContain("no wiki is available");
  });

  it("rejects every former external provider kind in settings", () => {
    for (const kind of ["file", "mcp", "executable", "plugin"]) {
      expect(memoryProviderSchema.safeParse({ kind }).success).toBe(false);
    }
  });
});
