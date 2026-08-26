import { describe, expect, test } from "bun:test";
import { WORKFLOW_LIMITS } from "../../src/limits.ts";
import { buildRunLeaderTool, RUN_LEADER_TOOL_NAME } from "../../src/tool.ts";

describe("buildRunLeaderTool", () => {
  test("requires a title and prompt and exposes the run_leader wire name", () => {
    const tool = buildRunLeaderTool();
    expect(tool.wireName).toBe(RUN_LEADER_TOOL_NAME);
    expect(tool.mcpName).toBe("");
    const schema = tool.inputSchema as {
      required: string[];
      properties: { prompt: { maxLength: number }; [key: string]: unknown };
    };
    expect(schema.required).toEqual(["title", "prompt"]);
    expect(schema.properties.title).toBeDefined();
    expect(schema.properties.prompt).toBeDefined();
    expect(schema.properties.expect_schema).toBeDefined();
    expect(schema.properties.prompt.maxLength).toBe(WORKFLOW_LIMITS.textChars);
  });

  test("omits the profile selector when no profiles are registered", () => {
    const schema = buildRunLeaderTool().inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.profile).toBeUndefined();
  });

  test("enumerates registered leader profiles in the profile selector", () => {
    const tool = buildRunLeaderTool([
      { name: "researcher", description: "reads code" },
      { name: "writer" },
    ]);
    const schema = tool.inputSchema as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.profile?.enum).toEqual(["researcher", "writer"]);
  });
});
