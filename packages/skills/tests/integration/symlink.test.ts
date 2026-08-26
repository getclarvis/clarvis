import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAgentSkills, discoverSkills, resolveConfig } from "@clarvis/skills";
import { enumerateResources } from "../../src/scan.ts";
import {
  captureWarnings,
  clarvisRoots,
  cleanup,
  makeHome,
  makeWorkspace,
  skillsRoot,
  writeSkill,
} from "../helpers/fixtures.ts";

describe("symlinked skills (the shared .agents store)", () => {
  let home: string;
  let ws: string;
  let store: string;

  beforeEach(() => {
    home = makeHome();
    ws = makeWorkspace();
    store = makeWorkspace();
  });

  afterEach(() => {
    cleanup(home);
    cleanup(ws);
    cleanup(store);
  });

  it("follows a symlinked skill dir and loads its body + resource", () => {
    const realSkill = writeSkill(store, "opentui", {
      body: "TUI docs",
      resources: { "references/api.md": "api" },
    });
    const root = skillsRoot(home, "agents");
    mkdirSync(root, { recursive: true });
    symlinkSync(realSkill, path.join(root, "opentui"));

    const agent = createAgentSkills({
      home,
      cwd: ws,
      workspace: ws,
      roots: clarvisRoots(home, ws),
    });
    const content = agent.loadSkill("opentui");
    expect(content?.body).toBe("TUI docs");
    expect(content?.resources.map((r) => r.rel)).toContain("references/api.md");
    expect(agent.resourcePath("opentui", "references/api.md")).toContain("api.md");
  });

  it("ignores a symlinked skill dir when followSymlinks is false", () => {
    const realSkill = writeSkill(store, "linked");
    const root = skillsRoot(home, "agents");
    mkdirSync(root, { recursive: true });
    symlinkSync(realSkill, path.join(root, "linked"));

    const registry = discoverSkills(
      resolveConfig({
        home,
        cwd: ws,
        workspace: ws,
        followSymlinks: false,
        roots: clarvisRoots(home, ws),
      }),
    );
    expect(registry.size).toBe(0);
  });

  it("does not hang on a resource directory that symlinks back into the skill", () => {
    const dir = writeSkill(skillsRoot(ws, "clarvis"), "loopy", {
      resources: { "references/a.md": "a" },
    });
    symlinkSync(dir, path.join(dir, "references", "back")); // references/back -> the skill dir

    const resources = enumerateResources(dir, true);
    expect(resources.map((r) => r.rel)).toContain("references/a.md");
    expect(resources.length).toBeGreaterThan(0);
  });

  it("skips a dangling symlink with a warning", () => {
    const root = skillsRoot(home, "agents");
    mkdirSync(root, { recursive: true });
    symlinkSync(path.join(store, "does-not-exist"), path.join(root, "ghost"));

    const cap = captureWarnings();
    try {
      const registry = discoverSkills(
        resolveConfig({
          home,
          cwd: ws,
          workspace: ws,
          roots: clarvisRoots(home, ws),
          warningSink: cap.warningSink,
        }),
      );
      expect(registry.size).toBe(0);
      expect(cap.warnings.join("")).toMatch(/dangling symlink/);
    } finally {
      cap.restore();
    }
  });

  it("skips a skill whose SKILL.md is a dangling symlink", () => {
    const root = skillsRoot(ws, "clarvis");
    const skillDir = path.join(root, "brokenlink");
    mkdirSync(skillDir, { recursive: true });
    symlinkSync(path.join(store, "nope.md"), path.join(skillDir, "SKILL.md"));

    const cap = captureWarnings();
    try {
      const registry = discoverSkills(
        resolveConfig({
          home,
          cwd: ws,
          workspace: ws,
          roots: clarvisRoots(home, ws),
          warningSink: cap.warningSink,
        }),
      );
      expect(registry.size).toBe(0);
      expect(cap.warnings.join("")).toMatch(/skipping/);
    } finally {
      cap.restore();
    }
  });
});
