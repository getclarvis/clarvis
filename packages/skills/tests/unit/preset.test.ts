import path from "node:path";
import { describe, expect, it } from "bun:test";
import { clarvisSkillRoots } from "../../src/preset.ts";
import { agentsSkillsDirs, HOME_ENV } from "@clarvis/paths";

describe("clarvisSkillRoots", () => {
  it("builds the two shared roots in ascending precedence with scope/source labels", () => {
    const roots = clarvisSkillRoots({ home: "/home/u", cwd: "/tmp", workspace: "/work", env: {} });
    expect(roots).toEqual([
      { path: path.join("/home/u", ".agents", "skills"), scope: "user", source: "agents" },
      { path: path.join("/work", ".agents", "skills"), scope: "workspace", source: "agents" },
    ]);
  });

  it("defaults the workspace to cwd when none is given", () => {
    const roots = clarvisSkillRoots({ home: "/home/u", cwd: "/project" });
    expect(roots[1]?.path).toBe(path.join("/project", ".agents", "skills"));
    expect(roots).toHaveLength(2);
  });

  it("falls back to the real home and cwd when no options are given", () => {
    const roots = clarvisSkillRoots();
    expect(roots[0]?.path).toBe(agentsSkillsDirs({ env: {} }).user);
    expect(roots[1]?.path).toBe(agentsSkillsDirs({ env: {} }).workspace);
  });

  it("does not redirect shared roots when CLARVIS_HOME is set", () => {
    const roots = clarvisSkillRoots({
      home: "/home/u",
      cwd: "/tmp",
      workspace: "/work",
      env: { [HOME_ENV]: "/elsewhere" },
    });

    expect(roots[0]?.path).toBe(path.join("/home/u", ".agents", "skills"));
    expect(roots[1]?.path).toBe(path.join("/work", ".agents", "skills"));
  });
});
