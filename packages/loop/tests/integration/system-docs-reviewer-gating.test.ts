import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnv,
  NOOP_LOGGER,
  type LLMProvider,
  type RunCapabilityContext,
} from "@clarvis/capability";
import type { SkillsProvider } from "@clarvis/skills/capability";
import { buildExecuteRunDeps } from "../../src/runtime/build-run-deps.ts";

test("file tools without a host mutation reviewer do not expose system-only documentation", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-system-reviewer-gate-"));
  const env = loadEnv({ CLARVIS_SKILLS_ENABLED: "false", CLARVIS_AGENT_TOOLS_MAX_GRANT: "edit" });
  const system: SkillsProvider = {
    listSkills: () => [
      {
        name: "clarvis-docs",
        description: "Product documentation",
        metadata: { name: "clarvis-docs", description: "Product documentation" },
        productOwned: true,
        userInvocable: false,
        scope: "user",
        source: "builtin",
        root: "product:docs",
        dir: "product:docs",
        path: "product:docs/SKILL.md",
      },
    ],
    loadSkill: () => undefined,
    readResource: () => {
      throw new Error("unavailable");
    },
  };
  try {
    const built = await buildExecuteRunDeps({
      env,
      logger: NOOP_LOGGER,
      workspaceRoot: root,
      traceDir: join(root, "traces"),
      llm: { call: async () => ({ text: "Done." }) } as unknown as LLMProvider,
      systemSkillProvider: system,
      reservedSystemSkillName: "clarvis-docs",
      builtins: { tools: true, skills: false, hooks: false },
    });
    try {
      const capabilities = built.deps.capabilities ?? [];
      expect(capabilities.map((capability) => capability.name)).toContain("tools");
      const skills = capabilities.find((capability) => capability.name === "skills");
      expect(skills).toBeDefined();
      const context = {
        env,
        entryGrants: ["edit_workspace"],
        request: { servers: [] },
      } as unknown as RunCapabilityContext;
      expect(await skills!.forRun(context)).toBeNull();
    } finally {
      await built.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
