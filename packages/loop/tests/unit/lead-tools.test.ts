import { describe, expect, it } from "../bun-test.ts";
import {
  buildDelegateTaskTool,
  buildSpawnSubagentTool,
  spawnSubagentTool,
} from "../../src/runtime/subagents/lead-tools.ts";
import { DELEGATE_TASK_MAX_CHARS, type DelegateTaskAugmentation } from "@clarvis/capability";

const augmentation: DelegateTaskAugmentation = {
  description: "Delegate one tracked task to a Sub-agent.",
  properties: {
    task_id: { type: "string", description: "The exact tracked task id." },
  },
};

describe("child-spawn tool schemas", () => {
  it("keeps independent spawning separate from tracked delegation", () => {
    const spawn = buildSpawnSubagentTool();
    const delegated = buildDelegateTaskTool(undefined, false, augmentation);

    expect(spawn.wireName).toBe("spawn_subagent");
    expect(props(spawn)).not.toHaveProperty("task_id");
    expect(required(spawn)).toEqual(["title", "task"]);

    expect(delegated.wireName).toBe("delegate_task");
    expect(delegated.description).toBe(augmentation.description);
    expect(props(delegated)).toHaveProperty("task_id");
    expect(required(delegated)).toEqual(["title", "task", "task_id"]);
  });

  it("allows harmless surplus arguments so runtime normalization can ignore them", () => {
    for (const tool of [
      spawnSubagentTool,
      buildSpawnSubagentTool(undefined, true),
      buildDelegateTaskTool(undefined, true, augmentation),
    ]) {
      expect(tool.inputSchema).not.toHaveProperty("additionalProperties", false);
    }
  });

  it("offers background on both tools without requiring it", () => {
    for (const tool of [
      buildSpawnSubagentTool(),
      buildDelegateTaskTool(undefined, false, augmentation),
    ]) {
      expect(props(tool).background).toMatchObject({ type: "boolean" });
      expect(required(tool)).not.toContain("background");
    }
  });

  it("publishes the canonical task-text ceiling in every schema", () => {
    for (const tool of [
      spawnSubagentTool,
      buildSpawnSubagentTool(undefined, true),
      buildDelegateTaskTool(undefined, true, augmentation),
    ]) {
      expect(props(tool).task).toMatchObject({ maxLength: DELEGATE_TASK_MAX_CHARS });
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
