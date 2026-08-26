import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { discoverSkills, resolveConfig } from "@clarvis/skills";
import {
  clarvisRoots,
  cleanup,
  makeHome,
  makeWorkspace,
  skillsRoot,
  userSkillsRoot,
  writeSkill,
} from "../helpers/fixtures.ts";

describe("root discovery and shadowing", () => {
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

  it("applies the complete Clarvis root order and retains every shadowed origin", () => {
    writeSkill(skillsRoot(home, "agents"), "demo", { body: "user agents" });
    writeSkill(skillsRoot(workspace, "agents"), "demo", { body: "workspace agents" });
    writeSkill(userSkillsRoot(home), "demo", { body: "user clarvis" });
    writeSkill(skillsRoot(workspace, "clarvis"), "demo", { body: "workspace clarvis" });

    const registry = discoverSkills(
      resolveConfig({
        home,
        cwd: workspace,
        workspace,
        strict: true,
        roots: clarvisRoots(home, workspace),
      }),
    );

    const winner = registry.get("demo");
    expect(winner).toMatchObject({
      body: "workspace clarvis",
      scope: "workspace",
      source: "clarvis",
    });
    expect(winner?.shadowed?.map(({ source, scope }) => `${source}:${scope}`)).toEqual([
      "clarvis:user",
      "agents:workspace",
      "agents:user",
    ]);
    expect(registry.size).toBe(1);
  });

  it("applies last-root-wins to arbitrary caller roots while merging distinct skills", () => {
    const lower = path.join(workspace, "lower-store");
    const upper = path.join(workspace, "upper-store");
    writeSkill(lower, "demo", { body: "lower" });
    writeSkill(lower, "only-lower");
    writeSkill(upper, "demo", { body: "upper" });

    const registry = discoverSkills(
      resolveConfig({
        home,
        cwd: workspace,
        workspace,
        roots: [
          { path: lower, source: "lower" },
          { path: upper, source: "upper" },
        ],
      }),
    );

    expect(registry.list().map((skill) => skill.name)).toEqual(["demo", "only-lower"]);
    expect(registry.get("demo")).toMatchObject({
      body: "upper",
      source: "upper",
      scope: "workspace",
      shadowed: [expect.objectContaining({ source: "lower", scope: "workspace" })],
    });
  });
});
