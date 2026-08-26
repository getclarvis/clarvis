import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import type { LLMCallParams } from "@clarvis/capability";
import { ENV_SECTION } from "../env-section.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const infoMCP = () =>
  mockMCPFactory({
    info: {
      tools: [
        {
          name: "lookup",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          call: () => "court=SP",
        },
        {
          name: "write",
          inputSchema: { type: "object", properties: { v: { type: "string" } } },
          call: () => "ok",
        },
      ],
    },
  });

const infoTool = {
  name: "info",
  transport: "stdio" as const,
  command: "node",
  args: ["-e", ""],
};

function firstCallFor(llm: MockLLM, model: string): LLMCallParams {
  const c = llm.calls.find((x) => x.model === model);
  if (!c) throw new Error(`no LLM call for model '${model}'`);
  return c;
}

describe("specialized subagents", () => {
  it("a subagent base_prompt seeds the spawned Subagent with a leading system message", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { name: "spawn_subagent", arguments: { title: "w", task: "extract the plaintiff" } },
          ],
          usage: { input_tokens: 80, output_tokens: 30 },
        },
        { text: "Plaintiff: Jane", usage: { input_tokens: 60, output_tokens: 40 } },
        { text: "Final: Jane", usage: { input_tokens: 50, output_tokens: 25 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: infoMCP() });

    const res = (await harness.run({
      messages: [{ role: "user", content: "extract plaintiff" }],
      servers: [infoTool],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: ["info.lookup", "info.write"],
          iteration_limit: 10,
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["info.lookup", "info.write"],
          iteration_limit: 10,
          base_prompt: "You are a careful extraction Subagent.",
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    })) as unknown as { status: string };

    expect(res.status).toBe("completed");

    const subagentSeed = firstCallFor(llm, "claude-haiku-4-5").messages;
    expect(subagentSeed[0]).toEqual({
      role: "system",
      content: `${ENV_SECTION(process.cwd())}\n\nYou are a careful extraction Subagent.`,
    });
    expect(subagentSeed[1]).toMatchObject({ role: "user", content: "extract the plaintiff" });
  });

  it("the Lead selects a profile; the Subagent runs its model, base prompt, and tool ceiling", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "spawn_subagent",
              arguments: { title: "w", task: "research the court", profile: "researcher" },
            },
          ],
          usage: { input_tokens: 80, output_tokens: 30 },
        },
        { text: "court=SP", usage: { input_tokens: 60, output_tokens: 40 } },
        { text: "Final: SP", usage: { input_tokens: 50, output_tokens: 25 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: infoMCP() });

    const res = (await harness.run({
      messages: [{ role: "user", content: "which court" }],
      servers: [infoTool],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: ["info.lookup", "info.write"],
          iteration_limit: 10,
          can_spawn: ["researcher", "implementer"],
        },
        {
          name: "researcher",
          description: "read-only research",
          model: "anthropic/claude-sonnet-4-5",
          base_prompt: "You are a RESEARCHER.",
          tools: ["info.lookup"],
          iteration_limit: 10,
        },
        {
          name: "implementer",
          model: "anthropic/claude-haiku-4-5",
          base_prompt: "You are an IMPLEMENTER.",
          tools: ["info.lookup", "info.write"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    })) as unknown as { status: string };

    expect(res.status).toBe("completed");

    const leadCall = firstCallFor(llm, "claude-opus-4-5");
    const spawnTool = leadCall.tools.find((t) => t.fullName === "spawn_subagent")!;
    const profileProp = (spawnTool.inputSchema as { properties: { profile?: { enum?: string[] } } })
      .properties.profile;
    expect(profileProp?.enum).toEqual(["researcher", "implementer"]);

    const subagentCall = firstCallFor(llm, "claude-sonnet-4-5");
    expect(subagentCall.messages[0]).toEqual({
      role: "system",
      content: `${ENV_SECTION(process.cwd())}\n\nYou are a RESEARCHER.`,
    });
    const subagentToolNames = subagentCall.tools.map((t) => t.fullName);
    expect(subagentToolNames).toContain("info.lookup");
    expect(subagentToolNames).not.toContain("info.write");
  });

  it("no base_prompt ⇒ subagent seeded from the single user message", async () => {
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [{ name: "spawn_subagent", arguments: { title: "w", task: "do it" } }],
          usage: { input_tokens: 80, output_tokens: 30 },
        },
        { text: "done", usage: { input_tokens: 60, output_tokens: 40 } },
        { text: "Final", usage: { input_tokens: 50, output_tokens: 25 } },
      ],
    });
    harness = await makeHarness({ llm, mcpFactory: infoMCP() });

    const res = (await harness.run({
      messages: [{ role: "user", content: "go" }],
      servers: [infoTool],
      entry: "lead",
      profiles: [
        {
          name: "lead",
          model: "anthropic/claude-opus-4-5",
          tools: ["info.lookup", "info.write"],
          iteration_limit: 10,
          can_spawn: ["subagent"],
        },
        {
          name: "subagent",
          model: "anthropic/claude-haiku-4-5",
          tools: ["info.lookup", "info.write"],
          iteration_limit: 10,
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 50000, timeout_ms: 30000 },
    })) as unknown as { status: string };

    expect(res.status).toBe("completed");

    const subagentSeed = firstCallFor(llm, "claude-haiku-4-5").messages;
    expect(subagentSeed[0]).toEqual({
      role: "system",
      content: `${ENV_SECTION(process.cwd())}`,
    });
    expect(subagentSeed[1]).toMatchObject({ role: "user", content: "do it" });

    const leadCall = firstCallFor(llm, "claude-opus-4-5");
    const spawnTool = leadCall.tools.find((t) => t.fullName === "spawn_subagent")!;
    expect(
      (spawnTool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
        .profile?.enum,
    ).toEqual(["subagent"]);
  });
});
