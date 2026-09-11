import { describe, expect, test } from "bun:test";

import type { WorkflowDefinition } from "../../src/artifact.ts";
import { buildRunWorkflowTool, explainWorkflow } from "../../src/run-workflow.ts";
import { WORKFLOW_DEFINITIONS } from "../helpers/definitions.ts";

const WORKFLOWS: readonly WorkflowDefinition[] = WORKFLOW_DEFINITIONS;

describe("buildRunWorkflowTool", () => {
  test("derives its catalogue and argument vocabulary from local definitions", () => {
    expect(buildRunWorkflowTool([])).toBeNull();

    const schema = buildRunWorkflowTool(WORKFLOWS)!.inputSchema as {
      required: string[];
      properties: {
        name: { enum: string[]; description: string };
        args: { description: string };
      };
    };
    expect(schema.required).toEqual(["name"]);
    expect(schema.properties.name.enum).toEqual(["audit", "implement", "research"]);
    expect(schema.properties.name.description).toContain("audit (args: subject)");
    expect(schema.properties.name.description).toContain("implement (args: goal)");
    expect(schema.properties.name.description).toContain("research (args: question)");
    expect(schema.properties.args.description).toContain("selected workflow");

    const bare = buildRunWorkflowTool([{ ...WORKFLOWS[0]!, args: [] }])!.inputSchema as {
      properties: { args: { description: string } };
    };
    expect(bare.properties.args.description).not.toContain("Declared across");
  });
});

describe("explainWorkflow", () => {
  test("describes fixed, each, all, gated, accepted and repeated cost shapes", () => {
    const text = explainWorkflow(WORKFLOWS[0]!);
    expect(text).toContain("discover (discovery): 1 leader");
    expect(text).toContain("1 leader per item of discover.work_items");
    expect(text).toContain("1 leader over the whole set");
    expect(text).toContain("×3 replicas each");
    expect(text).toContain("only if review.coverage_gaps is non-empty");
    expect(text).toContain("accepted by threshold");
    expect(text).toContain("Repeat: [review, verify]");
    expect(text).toContain("scales with what the earlier rounds return");
  });

  test("reports an exact cost when every round has a fixed cardinality", () => {
    const flat = {
      ...WORKFLOWS[0]!,
      rounds: [WORKFLOWS[0]!.rounds[0]!],
      repeat: undefined,
    };
    const text = explainWorkflow(flat);
    expect(text).toContain("Cost: 1 leader(s).");
    expect(text).not.toContain("Repeat:");
  });
});
