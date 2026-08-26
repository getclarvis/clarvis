import { describe, expect, it } from "bun:test";

import { createMemoryFactory } from "../../src/factory.ts";
import type { LLMProvider } from "@clarvis/capability";
import { makeRoot } from "../helpers/fs.ts";

describe("memory factory default file store", () => {
  it("shares one workspace-backed store across owners", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const factory = createMemoryFactory({
        llm: { call: () => Promise.reject(new Error("not used")) } as LLMProvider,
        workspaceRoot: root,
        loadSettings: () => ({
          config: { enabled: true, model: "anthropic/x" },
          providers: [{ name: "anthropic", kind: "anthropic" }],
        }),
      });

      const alice = factory.forOwner("alice");
      const bob = factory.forOwner("bob");
      expect(alice).toBeDefined();
      expect(alice!.store).toBe(bob!.store);
    } finally {
      await cleanup();
    }
  });
});
