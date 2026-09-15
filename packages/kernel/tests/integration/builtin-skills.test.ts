import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentToText, loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import { executeRun, buildExecuteRunDeps } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { createFileKernel } from "../../src/bootstrap.ts";
import { withBuiltinSkills } from "../../src/skills/builtin-skills.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(): { root: string; globalDir: string; workspaceRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "clarvis-builtin-skills-"));
  roots.push(root);
  const globalDir = join(root, "global");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(globalPaths(globalDir).extensionProfilesDir, { recursive: true });
  mkdirSync(workspaceRoot);
  writeFileSync(
    join(globalPaths(globalDir).extensionProfilesDir, "empty.json"),
    JSON.stringify({ schema_version: 1, plugins: [], skills: [] }),
  );
  return { root, globalDir, workspaceRoot };
}

describe("builtin skill distribution and run composition", () => {
  it.each(["enabled", "host-disabled", "env-disabled"] as const)(
    "%s: composes the builtin with an empty Extension Profile without creating skill files",
    async (mode) => {
      const paths = fixture();
      const kernel = await createFileKernel({
        ...paths,
        traceDir: join(paths.root, "traces"),
        logger: NOOP_LOGGER,
        env: loadEnv({
          CLARVIS_LOG_LEVEL: "silent",
          CLARVIS_SKILLS_ENABLED: mode === "env-disabled" ? "false" : "true",
        }),
        extensionProfileSelector: "global:empty",
        builtins: { tools: false, hooks: false, tasks: false, skills: mode !== "host-disabled" },
      });
      try {
        const skills = await kernel.skills.list();
        expect(skills.map((skill) => skill.name)).toEqual(
          mode === "enabled" ? ["clarvis-configure"] : [],
        );
        if (mode === "enabled") {
          const prompt = await kernel.skills.getPrompt("clarvis-configure");
          expect(prompt[0]?.content).toContain("# Configure Clarvis");
        }
        expect(existsSync(globalPaths(paths.globalDir).skillsDir)).toBe(false);
        expect(existsSync(workspacePaths(paths.workspaceRoot).skillsDir)).toBe(false);
      } finally {
        await kernel.close();
      }
    },
  );

  it.each([true, false])("the use_skills grant controls model access (%s)", async (granted) => {
    const paths = fixture();
    const llm = new MockLLM({
      script: granted
        ? [
            { toolCalls: [{ name: "load_skill", arguments: { name: "clarvis-configure" } }] },
            { text: "Configuration instructions loaded." },
          ]
        : [{ text: "No skills are available to this profile." }],
    });
    const built = await buildExecuteRunDeps({
      workspaceRoot: paths.workspaceRoot,
      traceDir: join(paths.root, "traces"),
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: NOOP_LOGGER,
      skillRoots: [],
      composeSkills: withBuiltinSkills,
      builtins: { tools: false, hooks: false },
    });
    try {
      const result = await executeRun({
        owner: "test",
        deps: { ...built.deps, llm },
        rawBody: {
          messages: [{ role: "user", content: "Help configure Clarvis." }],
          entry: "solo",
          profiles: [
            {
              name: "solo",
              model: "anthropic/x",
              tools: [],
              iteration_limit: 5,
              grants: granted ? ["use_skills"] : [],
            },
          ],
          providers: [{ name: "anthropic", kind: "anthropic" }],
          servers: [],
          budget: { on_exceed: "stop", total_token_limit: 100000 },
        },
      });
      expect(result.response).toMatchObject({ status: "completed" });
      const first = llm.calls[0]!;
      expect(first.tools.some((tool) => tool.wireName === "load_skill")).toBe(granted);
      const initial = first.messages.map((message) => contentToText(message.content)).join("\n");
      expect(initial.includes("clarvis-configure")).toBe(granted);
      expect(initial).not.toContain("## Working procedure");
      if (granted) {
        const disclosed = llm.calls[1]!.messages.map((message) =>
          contentToText(message.content),
        ).join("\n");
        expect(disclosed).toContain("## Working procedure");
        expect(disclosed).toContain("Builtin instructions embedded in Clarvis");
        expect(disclosed).not.toContain("Skill directory: builtin:");
      }
    } finally {
      await built.dispose();
    }
  });
});
