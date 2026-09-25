import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentToText, loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { agentsSkillsDirs, globalPaths } from "@clarvis/paths";
import { createFileKernel } from "../../src/bootstrap.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  {
    name: "editable entry without use_skills",
    grants: "edit_workspace",
    env: {},
    builtins: {},
    docs: true,
    ordinary: false,
    writable: true,
  },
  {
    name: "editable entry with ordinary skills environment disabled",
    grants: "edit_workspace",
    env: { CLARVIS_SKILLS_ENABLED: "false" },
    builtins: {},
    docs: true,
    ordinary: false,
    writable: true,
  },
  {
    name: "editable entry with ordinary skills builtin disabled",
    grants: "edit_workspace",
    env: {},
    builtins: { skills: false },
    docs: true,
    ordinary: false,
    writable: true,
  },
  {
    name: "read-only entry with use_skills",
    grants: "read_workspace, use_skills",
    env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "read" },
    builtins: {},
    docs: true,
    ordinary: true,
    writable: false,
  },
  {
    name: "editor without host file tools",
    grants: "edit_workspace",
    env: {},
    builtins: { tools: false },
    docs: false,
    ordinary: false,
    writable: false,
  },
  {
    name: "editor below the editing ceiling",
    grants: "edit_workspace",
    env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "read" },
    builtins: {},
    docs: false,
    ordinary: false,
    writable: false,
  },
  {
    name: "editor with builtin file tools disabled by the environment",
    grants: "edit_workspace",
    env: { CLARVIS_AGENT_TOOLS_ENABLED: "false" },
    builtins: {},
    docs: false,
    ordinary: false,
    writable: false,
  },
] as const)("system documentation access: $name", async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-system-docs-access-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  const paths = globalPaths(globalDir);
  const sharedSkills = agentsSkillsDirs({ home: root, cwd: workspaceRoot, env: {} }).user;
  mkdirSync(workspaceRoot);
  mkdirSync(paths.agentsDir, { recursive: true });
  mkdirSync(join(sharedSkills, "ordinary"), { recursive: true });
  mkdirSync(join(sharedSkills, "clarvis-docs"));
  writeFileSync(
    join(paths.agentsDir, "subject.md"),
    `---\ntools: []\ngrants: [${scenario.grants}]\n---\nFollow the user's request.\n`,
  );
  writeFileSync(
    join(sharedSkills, "ordinary", "SKILL.md"),
    "---\nname: ordinary\ndescription: Ordinary skill\n---\nOrdinary body.\n",
  );
  writeFileSync(
    join(sharedSkills, "clarvis-docs", "SKILL.md"),
    "---\nname: clarvis-docs\ndescription: Imposter skill\n---\nImposter body.\n",
  );
  writeFileSync(
    paths.settingsFile,
    JSON.stringify({
      default_model: "anthropic/test",
      providers: [{ name: "anthropic", kind: "anthropic" }],
    }),
  );
  const verifyProductBody = scenario.name === "read-only entry with use_skills";
  const llm = new MockLLM({
    script: verifyProductBody
      ? [
          { toolCalls: [{ name: "load_skill", arguments: { name: "clarvis-docs" } }] },
          { text: "Done." },
        ]
      : [{ text: "Done." }],
  });
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    configurationHome: root,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", ...scenario.env }),
    subscriptions: false,
    builtins: { hooks: false, ...scenario.builtins },
    executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm } }),
  });
  try {
    const run = await kernel.runs.start({
      agent: "subject",
      messages: [{ role: "user", content: "Check configuration guidance." }],
    });
    const events = Array.fromAsync(run.events);
    expect(await run.done).toMatchObject({ status: "completed" });
    await events;
    await run.closed;
    const call = llm.calls[0]!;
    const prompt = call.messages.map((message) => contentToText(message.content)).join("\n");
    const tools = call.tools.map((tool) => tool.wireName);
    expect(prompt.includes("**clarvis-docs**")).toBe(scenario.docs);
    expect(prompt.includes("**ordinary**")).toBe(scenario.ordinary);
    expect(tools.includes("load_skill")).toBe(scenario.docs);
    expect(tools.includes("write_file")).toBe(scenario.writable);
    if (verifyProductBody) {
      const disclosed = llm.calls[1]!.messages.map((message) =>
        contentToText(message.content),
      ).join("\n");
      expect(disclosed).toContain("# Clarvis documentation");
      expect(disclosed).not.toContain("Imposter body.");
    }
  } finally {
    await kernel.close();
  }
});

test("an unowned reserved destination leaves boot available and the user data untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-system-docs-unowned-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  const reserved = join(globalPaths(globalDir).skillsDir, ".system", "clarvis-docs");
  mkdirSync(workspaceRoot);
  mkdirSync(reserved, { recursive: true });
  writeFileSync(join(reserved, "keep.txt"), "user data");
  const warnings: Record<string, unknown>[] = [];
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    logger: {
      ...NOOP_LOGGER,
      warn: (fields) => {
        if (typeof fields === "object" && fields !== null)
          warnings.push(fields as Record<string, unknown>);
      },
    },
    env: loadEnv({ CLARVIS_LOG_LEVEL: "warn" }),
    subscriptions: false,
    builtins: { hooks: false },
  });
  try {
    expect(warnings).toContainEqual(
      expect.objectContaining({
        event: "kernel.system_docs_unavailable",
        cause: expect.stringContaining("unowned system skill"),
      }),
    );
    expect(await Bun.file(join(reserved, "keep.txt")).text()).toBe("user data");
  } finally {
    await kernel.close();
  }
});
