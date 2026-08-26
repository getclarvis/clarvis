import { describe, expect, test } from "bun:test";
import {
  BUILTIN_WORKFLOWS,
  BUILTIN_WORKFLOW_NAMES,
  resolveWorkflowDefinitions,
} from "../../src/builtin-workflows/index.ts";
import type { WorkflowDefinition } from "../../src/artifact.ts";

function override(name: string, description: string): WorkflowDefinition {
  return {
    name,
    description,
    args: [],
    rounds: [
      {
        id: "only",
        type: "free",
        over: { kind: "once" },
        title: "Run override",
        brief: "Run the operator-authored workflow.",
        fanout: 1,
      },
    ],
    synthesis: "Report the result.",
    dir: `/operator/${name}`,
  };
}

describe("built-in workflows", () => {
  test("ships the complete catalogue as code with resolved prompts", () => {
    expect(BUILTIN_WORKFLOW_NAMES).toEqual(["audit", "implement", "research"]);
    expect(BUILTIN_WORKFLOWS.map((workflow) => workflow.name)).toEqual([...BUILTIN_WORKFLOW_NAMES]);
    for (const workflow of BUILTIN_WORKFLOWS) {
      expect(workflow.dir).toBe(`builtin:${workflow.name}`);
      expect(workflow.args.length).toBeGreaterThan(0);
      expect(workflow.synthesis.length).toBeGreaterThan(0);
      for (const round of workflow.rounds) expect(round.brief.length).toBeGreaterThan(0);
      for (const round of workflow.rounds.filter((round) => round.type === "verdict")) {
        expect(round.fanout).toBeGreaterThan(1);
        expect(round.accept?.value).toBe("refuted");
      }
    }
  });

  test("applies operator definitions by name without removing untouched built-ins", () => {
    const audit = override("audit", "Operator audit");
    const custom = override("custom", "Operator custom workflow");
    const resolved = resolveWorkflowDefinitions([audit, custom]);

    expect(resolved.map((workflow) => workflow.name)).toEqual([
      "audit",
      "custom",
      "implement",
      "research",
    ]);
    expect(resolved.find((workflow) => workflow.name === "audit")).toBe(audit);
    expect(resolved.find((workflow) => workflow.name === "custom")).toBe(custom);
    expect(resolved.find((workflow) => workflow.name === "implement")).toBe(BUILTIN_WORKFLOWS[1]);
  });
});
