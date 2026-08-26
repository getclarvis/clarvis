import { describe, expect, it } from "../bun-test.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTEXT_FILES = [
  "context-compaction.ts",
  "compaction-contracts.ts",
  "compaction-policy.ts",
  "compaction-selection.ts",
  "context-rewrite.ts",
  "live-entry-store.ts",
  "live-context.ts",
] as const;

function source(file: (typeof CONTEXT_FILES)[number]): string {
  return readFileSync(
    fileURLToPath(new URL(`../../src/runtime/context/${file}`, import.meta.url)),
    "utf8",
  );
}

describe("compaction module boundaries", () => {
  it("imports neither an LLM provider nor any agent-spawn module", () => {
    for (const file of CONTEXT_FILES) {
      const imports = source(file)
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line));
      for (const line of imports) {
        expect(line).not.toMatch(/llm-provider|ai-sdk-adapter|providers\//);
        expect(line).not.toMatch(/spawn-subagent|subagent-loop|lead-loop/);
      }
    }
  });

  it("never reaches the token or iteration budget ledger", () => {
    for (const file of CONTEXT_FILES) {
      expect(source(file)).not.toMatch(/TokenLedger|IterationCounter|\bledger\b|\bcounter\b/);
    }
  });
});
