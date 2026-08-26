import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAgentSkills } from "@clarvis/skills";
import {
  clarvisRoots,
  cleanup,
  makeHome,
  makeWorkspace,
  skillsRoot,
  writeSkill,
} from "../helpers/fixtures.ts";

describe("createAgentSkills public facade", () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = makeHome();
    workspace = makeWorkspace();
  });

  afterEach(() => {
    cleanup(home);
    cleanup(workspace);
  });

  function create() {
    return createAgentSkills({
      home,
      cwd: workspace,
      workspace,
      roots: clarvisRoots(home, workspace),
    });
  }

  it("exposes catalog, body and resource tiers from one discovered skill", () => {
    const root = skillsRoot(workspace, "clarvis");
    writeSkill(root, "pdf", {
      body: "How to PDF",
      resources: {
        "references/spec.md": "spec",
        "scripts/extract.py": "print(1)",
      },
    });

    const skills = create();
    expect(skills.listSkills()).toEqual([
      expect.objectContaining({ name: "pdf", source: "clarvis", scope: "workspace" }),
    ]);
    expect(skills.loadSkill("pdf")).toMatchObject({
      body: "How to PDF",
      resources: [
        expect.objectContaining({ rel: "references/spec.md" }),
        expect.objectContaining({ rel: "scripts/extract.py" }),
      ],
    });
    expect(skills.resourcePath("pdf", "references/spec.md")).toBe(
      path.join(root, "pdf", "references", "spec.md"),
    );
    expect(skills.readResource("pdf", "references/spec.md")).toBe("spec");
  });

  it("refreshes additions, modifications and removals from disk", () => {
    const root = skillsRoot(workspace, "clarvis");
    const temporary = writeSkill(root, "temporary", { body: "v1" });
    const skills = create();
    expect(skills.loadSkill("temporary")?.body).toBe("v1");

    writeSkill(root, "temporary", { body: "v2" });
    writeSkill(root, "new-one");
    skills.refresh();
    expect(skills.listSkills().map((skill) => skill.name)).toEqual(["new-one", "temporary"]);
    expect(skills.loadSkill("temporary")?.body).toBe("v2");

    cleanup(temporary);
    skills.refresh();
    expect(skills.listSkills().map((skill) => skill.name)).toEqual(["new-one"]);
    expect(skills.loadSkill("temporary")).toBeUndefined();
  });
});
