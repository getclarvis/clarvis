import path from "node:path";
import { describe, expect, it } from "bun:test";
import { discoverSkills, resolveConfig } from "@clarvis/skills";
import { SkillError } from "../../src/errors.ts";
import { cleanup, makeWorkspace, writeSkill } from "../helpers/fixtures.ts";

function captureSkillError(run: () => unknown): SkillError {
  try {
    run();
  } catch (error) {
    if (error instanceof SkillError) return error;
    throw error;
  }
  throw new Error("expected a SkillError");
}

describe("skill registry resource policy", () => {
  it("distinguishes an unknown skill, a missing resource and a directory", () => {
    const workspace = makeWorkspace();
    try {
      const root = path.join(workspace, "skills");
      writeSkill(root, "demo", { resources: { "scripts/run.sh": "echo ok" } });
      const registry = discoverSkills(
        resolveConfig({ workspace, roots: [{ path: root, source: "test" }] }),
      );

      expect(captureSkillError(() => registry.resource("ghost", "x")).code).toBe("not_found");
      expect(captureSkillError(() => registry.resource("demo", "missing.txt")).code).toBe(
        "not_found",
      );
      expect(captureSkillError(() => registry.resource("demo", "scripts")).code).toBe("not_a_file");
    } finally {
      cleanup(workspace);
    }
  });
});
