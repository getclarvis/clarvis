import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { SkillsProvider } from "@clarvis/skills/capability";
import type { LiveMessage } from "@clarvis/capability";
import type { SkillContent, SkillInfo } from "@clarvis/skills";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const mcp = () => mockMCPFactory({});

function info(name: string): SkillInfo {
  return {
    name,
    description: `The ${name} skill`,
    metadata: { name, description: `The ${name} skill` },
    userInvocable: true,
    scope: "workspace",
    source: "clarvis",
    root: "/ws/.clarvis/skills",
    dir: `/ws/.clarvis/skills/${name}`,
    path: `/ws/.clarvis/skills/${name}/SKILL.md`,
  };
}

function fakeSkills(names: string[] = ["alpha", "beta"]): SkillsProvider {
  const bodies: Record<string, string> = { alpha: "ALPHA-INSTRUCTIONS", beta: "BETA-INSTRUCTIONS" };
  return {
    listSkills: () => names.map(info),
    loadSkill: (name): SkillContent | undefined =>
      names.includes(name) ? { ...info(name), body: bodies[name] ?? "", resources: [] } : undefined,
    readResource: () => {
      throw new Error("no resources in this fake");
    },
  };
}

const offersLoadSkill = (call: { tools: { wireName: string }[] }): boolean =>
  call.tools.some((t) => t.wireName === "load_skill");

function systemText(call: { messages: LiveMessage[] }): string {
  return call.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

describe("skill catalog + load_skill are gated on the use_skills grant", () => {
  it("an entry agent WITH use_skills gets the catalog in its system prompt and the load_skill tool", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      skills: { provider: fakeSkills() },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          grants: ["use_skills"],
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect((res as { status: string }).status).toBe("completed");
    expect(offersLoadSkill(llm.calls[0]!)).toBe(true);
    const sys = systemText(llm.calls[0]!);
    expect(sys).toContain("# Available skills");
    expect(sys).toContain("alpha");
    expect(sys).toContain("load_skill");
  });

  it("an entry agent WITHOUT the grant gets neither the catalog nor the tool", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      skills: { provider: fakeSkills() },
    });

    await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 5 }],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(offersLoadSkill(llm.calls[0]!)).toBe(false);
    expect(systemText(llm.calls[0]!)).not.toContain("# Available skills");
  });

  it("CLARVIS_SKILLS_ENABLED=false disables skills even with the grant", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      skills: { provider: fakeSkills() },
      env: { CLARVIS_SKILLS_ENABLED: "false" },
    });

    await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          grants: ["use_skills"],
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(offersLoadSkill(llm.calls[0]!)).toBe(false);
  });

  it("an empty catalog yields no section and no tool even with the grant", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      skills: { provider: fakeSkills([]) },
    });

    await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          grants: ["use_skills"],
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(offersLoadSkill(llm.calls[0]!)).toBe(false);
    expect(systemText(llm.calls[0]!)).not.toContain("# Available skills");
  });

  it("no skills provider on the deps means the grant is inert", async () => {
    const llm = new MockLLM({ script: [{ text: "Done." }] });
    harness = await makeHarness({ llm, mcpFactory: mcp(), skills: {} });

    await harness.run({
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          grants: ["use_skills"],
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(offersLoadSkill(llm.calls[0]!)).toBe(false);
  });

  it("the model can load a skill body on demand and it reaches the context", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "load_skill", arguments: { name: "alpha" } }] },
        { text: "Applied the alpha skill." },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      skills: { provider: fakeSkills() },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "use alpha" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          grants: ["use_skills"],
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect((res as { status: string }).status).toBe("completed");
    const secondCallText = llm.calls[1]!.messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    ).join("\n");
    expect(secondCallText).toContain("ALPHA-INSTRUCTIONS");
  });

  it("a spawned subagent WITH use_skills gets skills while a lead WITHOUT it does not", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: { title: "T", task: "do it", profile: "subagent" },
            },
          ],
        },
        { text: "subagent finished" },
        { text: "all done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mcp(),
      skills: { provider: fakeSkills() },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "delegate" }],
      servers: [],
      profiles: [
        {
          name: "lead",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/x",
          tools: [],
          iteration_limit: 5,
          grants: ["use_skills"],
        },
      ],
      entry: "lead",
      budget: { on_exceed: "stop", total_token_limit: 100000 },
    });

    expect(["completed", "error"]).toContain((res as { status: string }).status);
    expect(offersLoadSkill(llm.calls[0]!)).toBe(false);
    const subagentCall = llm.calls.find(offersLoadSkill);
    expect(subagentCall).toBeDefined();
    expect(systemText(subagentCall!)).toContain("# Available skills");
  });
});
