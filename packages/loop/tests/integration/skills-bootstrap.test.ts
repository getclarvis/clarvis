import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { SkillsProvider } from "@clarvis/skills/capability";
import type { PluginBootstrapSkill } from "../../src/runtime/capabilities/skills-settings.ts";
import type { LiveMessage } from "@clarvis/capability";
import type { SkillContent, SkillInfo } from "@clarvis/skills";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const mcp = () => mockMCPFactory({});
const PLUGIN_ROOT = "/home/.clarvis/plugins/superpowers/skills";
const BOOTSTRAP_BODY = "ALWAYS BRAINSTORM BEFORE YOU WRITE CODE";

function info(name: string, root: string): SkillInfo {
  return {
    name,
    description: `The ${name} skill`,
    metadata: { name, description: `The ${name} skill` },
    userInvocable: true,
    scope: "user",
    source: root === PLUGIN_ROOT ? "plugin:superpowers" : "clarvis",
    root,
    dir: `${root}/${name}`,
    path: `${root}/${name}/SKILL.md`,
  };
}

/** A catalog of one plugin skill plus one workspace skill. */
function fakeSkills(bootstrapRoot = PLUGIN_ROOT): SkillsProvider {
  const catalog = [info("using-superpowers", bootstrapRoot), info("alpha", "/ws/.clarvis/skills")];
  return {
    listSkills: () => catalog,
    loadSkill: (name): SkillContent | undefined => {
      const found = catalog.find((s) => s.name === name);
      return found === undefined ? undefined : { ...found, body: BOOTSTRAP_BODY, resources: [] };
    },
    readResource: () => {
      throw new Error("no resources in this fake");
    },
  };
}

const bootstraps = (): readonly PluginBootstrapSkill[] => [
  { plugin: "superpowers", skill: "using-superpowers", roots: [PLUGIN_ROOT] },
];

function systemText(call: { messages: LiveMessage[] }): string {
  return call.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

const grantedSolo = {
  name: "solo",
  model: "anthropic/x",
  tools: [],
  iteration_limit: 5,
  grants: ["use_skills"],
};

describe("a plugin's bootstrap skill reaches the real system prompt", () => {
  it("injects the body ahead of the catalog for a granted entry agent", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      skills: { provider: fakeSkills(), bootstraps },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [grantedSolo],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect((res as { status: string }).status).toBe("completed");
    const sys = systemText(llm.calls[0]!);
    expect(sys).toContain(BOOTSTRAP_BODY);
    expect(sys).toContain("'superpowers' plugin");
    expect(sys.indexOf(BOOTSTRAP_BODY)).toBeLessThan(sys.indexOf("# Available skills"));
  });

  it("withholds it from an agent that lacks use_skills", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      skills: { provider: fakeSkills(), bootstraps },
    });

    await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 5 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(systemText(llm.calls[0]!)).not.toContain(BOOTSTRAP_BODY);
  });

  it("refuses a bootstrap whose skill is shadowed by a higher-precedence root", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      skills: { provider: fakeSkills("/ws/.clarvis/skills"), bootstraps },
    });

    await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [grantedSolo],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    const sys = systemText(llm.calls[0]!);
    expect(sys).not.toContain(BOOTSTRAP_BODY);
    expect(sys).toContain("# Available skills");
  });
});
