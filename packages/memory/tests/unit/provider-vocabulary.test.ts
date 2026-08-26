import { describe, expect, it, vi } from "bun:test";

import {
  assertProviderVocabulary,
  MEMORY_READ_TOOL_NAMES,
  MEMORY_WRITE_TOOL_NAMES,
  type MemoryProvider,
} from "../../src/provider.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "../../src/tool-contract.ts";
import type { MemoryToolDef } from "../../src/types.ts";

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
function providerOf(over: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    kind: "test",
    readTools: MEMORY_READ_TOOL_NAMES.map(memTool),
    writeTools: MEMORY_WRITE_TOOL_NAMES.map(memTool),
    seed: async () => null,
    ...over,
  };
}

describe("assertProviderVocabulary", () => {
  it("accepts a provider carrying both halves exactly", () => {
    expect(() => {
      assertProviderVocabulary(providerOf());
    }).not.toThrow();
  });

  it("accepts a read-only provider, which is a first-class case", () => {
    const readOnly = providerOf();
    delete (readOnly as { writeTools?: unknown }).writeTools;
    expect(() => {
      assertProviderVocabulary(readOnly);
    }).not.toThrow();
  });

  it("rejects a misspelled read tool, naming both vocabularies", () => {
    const wrong = providerOf({
      readTools: ["list_memories", "read_memory", "grep_memories", "query_memory"].map(memTool),
    });
    expect(() => {
      assertProviderVocabulary(wrong);
    }).toThrow(/wrong read vocabulary/);
  });

  it("rejects a read half that is merely incomplete", () => {
    expect(() => {
      assertProviderVocabulary(providerOf({ readTools: [memTool("list_memories")] }));
    }).toThrow(/expected \[grep_memories, list_memories, query_memories, read_memory\]/);
  });

  it("rejects a write half that carries an extra tool", () => {
    const wrong = providerOf({
      writeTools: [...MEMORY_WRITE_TOOL_NAMES, "purge_memory"].map(memTool),
    });
    expect(() => {
      assertProviderVocabulary(wrong);
    }).toThrow(/wrong write vocabulary/);
  });

  it("reports the offending provider by kind, so an operator knows which one to fix", () => {
    expect(() => {
      assertProviderVocabulary(providerOf({ kind: "acme-kb", readTools: [] }));
    }).toThrow(/provider 'acme-kb'/);
  });

  it("rejects a provider-specific descriptor for a canonical tool", () => {
    const drifted = memTool("list_memories");
    drifted.description = "provider-specific list";
    expect(() => {
      assertProviderVocabulary(
        providerOf({
          readTools: [drifted, ...MEMORY_READ_TOOL_NAMES.slice(1).map(memTool)],
        }),
      );
    }).toThrow(/non-canonical descriptor for 'list_memories'/);
  });
});
