import { describe, expect, it } from "../bun-test.ts";
import {
  buildSpawnSubagentTool,
  spawnSubagentTool,
} from "../../src/runtime/subagents/lead-tools.ts";
import { TASK_BRIEF_MAX_CHARS } from "@clarvis/capability";

describe("child-spawn tool schemas", () => {
  it("advertises independent spawning with a bounded brief", () => {
    const spawn = buildSpawnSubagentTool();
    expect(spawn.wireName).toBe("spawn_subagent");
    expect(required(spawn)).toEqual(["title", "task"]);
  });

  it("allows harmless surplus arguments so runtime normalization can ignore them", () => {
    for (const tool of [spawnSubagentTool, buildSpawnSubagentTool(undefined, true)]) {
      expect(tool.inputSchema).not.toHaveProperty("additionalProperties", false);
    }
  });

  it("offers optional background spawning without requiring it", () => {
    for (const tool of [buildSpawnSubagentTool()]) {
      expect(props(tool).background).toMatchObject({ type: "boolean" });
      expect(required(tool)).not.toContain("background");
      expect(props(tool).background).toMatchObject({
        description: expect.stringContaining("waits inline"),
      });
      expect((props(tool).task as { description: string }).description).toContain(
        "Self-contained brief",
      );
    }
  });

  it("explains context isolation without promising workspace or token isolation", () => {
    expect(spawnSubagentTool.description).toContain("not your conversation");
    expect(spawnSubagentTool.description).toContain("shares the workspace and run token budget");
    expect(spawnSubagentTool.description).toContain("handle when backgrounded");
    expect(props(buildSpawnSubagentTool(undefined, true)).image_refs).toMatchObject({
      description: expect.stringContaining("vision-capable model"),
    });
  });

  it("publishes the canonical task-text ceiling", () => {
    for (const tool of [spawnSubagentTool, buildSpawnSubagentTool(undefined, true)]) {
      expect(props(tool).task).toMatchObject({ maxLength: TASK_BRIEF_MAX_CHARS });
    }
  });
});

/** The tool's input-schema properties, which is where every affordance lands. */
function props(tool: { inputSchema: Record<string, unknown> }): Record<string, unknown> {
  return (tool.inputSchema as { properties: Record<string, unknown> }).properties;
}

function required(tool: { inputSchema: Record<string, unknown> }): string[] {
  return (tool.inputSchema as { required: string[] }).required;
}
