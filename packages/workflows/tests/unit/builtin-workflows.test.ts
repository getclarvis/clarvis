import { describe, expect, test } from "bun:test";
import {
  BUILTIN_WORKFLOWS,
  BUILTIN_WORKFLOW_NAMES,
  resolveWorkflowDefinitions,
} from "../../src/builtin-workflows/index.ts";
import type { WorkflowDefinition } from "../../src/artifact.ts";
import { interpolate } from "../../src/interpolate.ts";

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
  test("keeps the complete builtin definitions compact without dropping verification inputs", () => {
    expect(JSON.stringify(BUILTIN_WORKFLOWS).length).toBeLessThanOrEqual(11_000);
    const finding = {
      id: "finding-exact-42",
      title: "Check parser bounds",
      claim: "The parser accepts an invalid bound",
      evidence: ["src/parser.ts:12"],
      impact: "Invalid input is accepted",
    };
    const item = {
      id: "item-1",
      title: "Inspect parser",
      goal: "Inspect the parser bounds",
      files: ["src/parser.ts"],
      dependencies: [],
      mutation: false,
    };
    for (const workflow of BUILTIN_WORKFLOWS) {
      const args = Object.fromEntries(workflow.args.map((name) => [name, "bounded test goal"]));
      for (const round of workflow.rounds) {
        const rendered = interpolate(round.brief, {
          args,
          item: round.type === "verdict" ? finding : round.over.kind === "all" ? ["gap"] : item,
          state: { build: { findings: [finding] } },
        });
        expect(rendered).not.toHaveProperty("error");
        if (!("text" in rendered)) throw new Error(rendered.error);
        expect(rendered.text).not.toContain("{{");
        if (round.type === "verdict") {
          expect(rendered.text).toContain(`Finding id: ${finding.id}`);
          expect(rendered.text).toContain("finding_id");
          expect(rendered.text).toContain("inconclusive");
          expect(rendered.text).toContain("read-only tools");
        }
      }
      expect(workflow.synthesis).toContain("verify.accepted");
      expect(workflow.synthesis).toContain("verify.rejected");
      expect(workflow.synthesis).toContain("not refuted, not confirmed");
    }
    const implement = BUILTIN_WORKFLOWS.find((workflow) => workflow.name === "implement")!;
    expect(implement.synthesis.replace(/\s+/g, " ")).toContain("failure does not roll back writes");
    expect(implement.rounds.find((round) => round.id === "review")!.brief).toContain(
      "could not run",
    );
  });

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
