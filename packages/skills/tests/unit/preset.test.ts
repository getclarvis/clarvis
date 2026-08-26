import path from "node:path";
import { describe, expect, it } from "bun:test";
import { clarvisSkillRoots } from "../../src/preset.ts";
import { agentsSkillsDirs, globalPaths, HOME_ENV, workspacePaths } from "@clarvis/paths";

describe("clarvisSkillRoots", () => {
  it("builds the four clarvis roots in ascending precedence with scope/source labels", () => {
    const roots = clarvisSkillRoots({ home: "/home/u", cwd: "/tmp", workspace: "/work", env: {} });
    expect(roots).toEqual([
      { path: path.join("/home/u", ".agents", "skills"), scope: "user", source: "agents" },
      { path: path.join("/work", ".agents", "skills"), scope: "workspace", source: "agents" },
      {
        path: globalPaths(path.join("/home/u", ".clarvis")).skillsDir,
        scope: "user",
        source: "clarvis",
      },
      { path: workspacePaths("/work").skillsDir, scope: "workspace", source: "clarvis" },
    ]);
  });

  it("defaults the workspace to cwd when none is given", () => {
    const roots = clarvisSkillRoots({ home: "/home/u", cwd: "/project" });
    expect(roots[1]?.path).toBe(path.join("/project", ".agents", "skills"));
    expect(roots[3]?.path).toBe(workspacePaths("/project").skillsDir);
  });

  it("falls back to the real home and cwd when no options are given", () => {
    const roots = clarvisSkillRoots();
    expect(roots[0]?.path).toBe(agentsSkillsDirs({ env: {} }).user);
    expect(roots[3]?.path).toBe(workspacePaths(process.cwd()).skillsDir);
  });

  it("lets CLARVIS_HOME outrank the injected home for the clarvis user root only", () => {
    const roots = clarvisSkillRoots({
      home: "/home/u",
      cwd: "/tmp",
      workspace: "/work",
      env: { [HOME_ENV]: "/elsewhere" },
    });

    expect(roots[2]).toEqual({
      path: globalPaths("/elsewhere").skillsDir,
      scope: "user",
      source: "clarvis",
    });
    expect(roots[0]?.path).toBe(path.join("/home/u", ".agents", "skills"));
    expect(roots[1]?.path).toBe(path.join("/work", ".agents", "skills"));
    expect(roots[3]?.path).toBe(workspacePaths("/work").skillsDir);
  });

  it("reads CLARVIS_HOME from the ambient process env when none is injected", () => {
    const previous = process.env[HOME_ENV];
    process.env[HOME_ENV] = "/ambient";
    try {
      expect(clarvisSkillRoots({ home: "/home/u", cwd: "/tmp", workspace: "/work" })[2]?.path).toBe(
        globalPaths("/ambient").skillsDir,
      );
    } finally {
      if (previous === undefined) delete process.env[HOME_ENV];
      else process.env[HOME_ENV] = previous;
    }
  });
});
