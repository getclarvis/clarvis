import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { enumerateResources, findSkillFile, listSkillDirs } from "../../src/scan.ts";
import { MAX_SKILL_GROUP_DIRECTORIES } from "../../src/limits.ts";
import { captureWarnings, cleanup, makeWorkspace, writeSkill } from "../helpers/fixtures.ts";

describe("listSkillDirs", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });

  afterEach(() => cleanup(root));

  it("finds every subdirectory that contains a SKILL.md, sorted", () => {
    writeSkill(root, "beta");
    writeSkill(root, "alpha");
    mkdirSync(path.join(root, "not-a-skill"), { recursive: true });
    const found = listSkillDirs(root, true);
    expect(found.map((f) => path.basename(f.dir))).toEqual(["alpha", "beta"]);
  });

  it("returns an empty list for a root that does not exist", () => {
    expect(listSkillDirs(path.join(root, "missing"), true)).toEqual([]);
  });

  it("descends through a directory that groups skills instead of holding one", () => {
    writeSkill(path.join(root, "roles"), "architect");
    writeSkill(path.join(root, "roles"), "reviewer");
    writeSkill(root, "flat");
    const found = listSkillDirs(root, true);
    expect(found.map((f) => path.relative(root, f.dir))).toEqual([
      "flat",
      path.join("roles", "architect"),
      path.join("roles", "reviewer"),
    ]);
  });

  it("descends through several levels of grouping", () => {
    writeSkill(path.join(root, "a", "b", "c"), "deep");
    expect(listSkillDirs(root, true).map((f) => path.basename(f.dir))).toEqual(["deep"]);
  });

  it("stops at the nesting bound rather than walking an arbitrary tree", () => {
    writeSkill(path.join(root, "a", "b", "c", "d", "e"), "too-deep");
    expect(listSkillDirs(root, true)).toEqual([]);
  });

  it("never looks inside a skill, so a bundled example is not a second skill", () => {
    const dir = writeSkill(root, "outer");
    writeSkill(path.join(dir, "references"), "example");
    expect(listSkillDirs(root, true).map((f) => path.basename(f.dir))).toEqual(["outer"]);
  });

  it("gives up on a tree that is wide rather than deep, and says so", () => {
    for (let index = 0; index <= MAX_SKILL_GROUP_DIRECTORIES; index += 1) {
      mkdirSync(path.join(root, `group-${String(index)}`), { recursive: true });
    }
    const captured = captureWarnings();
    expect(listSkillDirs(root, true, captured)).toEqual([]);
    expect(captured.warnings.join(" ")).toContain("stopping after");
  });

  it("stops probing once it has as many skills as the caller asked for", () => {
    writeSkill(path.join(root, "group"), "alpha");
    writeSkill(path.join(root, "group"), "beta");
    expect(listSkillDirs(root, true, undefined, 1)).toHaveLength(1);
  });
});

describe("findSkillFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeWorkspace();
  });

  afterEach(() => cleanup(dir));

  it("matches SKILL.md case-insensitively", () => {
    writeFileSync(path.join(dir, "Skill.md"), "x");
    expect(findSkillFile(dir, true)).toBe(path.join(dir, "Skill.md"));
  });

  it("returns undefined when there is no manifest", () => {
    writeFileSync(path.join(dir, "README.md"), "x");
    expect(findSkillFile(dir, true)).toBeUndefined();
  });

  it("accepts a symlinked manifest only when followSymlinks is true", () => {
    const targetDir = makeWorkspace();
    const target = path.join(targetDir, "real-skill.md");
    writeFileSync(target, "x");
    symlinkSync(target, path.join(dir, "SKILL.md"));
    try {
      expect(findSkillFile(dir, true)).toBe(path.join(dir, "SKILL.md"));
      expect(findSkillFile(dir, false)).toBeUndefined();
    } finally {
      cleanup(targetDir);
    }
  });
});

describe("enumerateResources", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeWorkspace();
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\ndescription: y\n---\nbody");
  });

  afterEach(() => cleanup(dir));

  it("classifies files by their top-level resource directory", () => {
    for (const sub of ["scripts", "references", "assets", "examples"]) {
      mkdirSync(path.join(dir, sub), { recursive: true });
      writeFileSync(path.join(dir, sub, "file.txt"), "x");
    }
    const kinds = Object.fromEntries(enumerateResources(dir, true).map((r) => [r.kind, r.rel]));
    expect(kinds).toEqual({
      scripts: "scripts/file.txt",
      references: "references/file.txt",
      assets: "assets/file.txt",
      examples: "examples/file.txt",
    });
  });

  it("treats other bundled files as kind 'other' and excludes the manifest", () => {
    writeFileSync(path.join(dir, "LICENSE.txt"), "x");
    const resources = enumerateResources(dir, true);
    expect(resources.map((r) => r.rel)).toEqual(["LICENSE.txt"]);
    expect(resources[0]?.kind).toBe("other");
  });

  it("recurses into nested resource directories with POSIX-style relative paths", () => {
    mkdirSync(path.join(dir, "references", "deep"), { recursive: true });
    writeFileSync(path.join(dir, "references", "deep", "note.md"), "x");
    const resources = enumerateResources(dir, true);
    expect(resources.map((r) => r.rel)).toContain("references/deep/note.md");
  });

  it("returns an empty list for a skill with no bundled resources", () => {
    expect(enumerateResources(dir, true)).toEqual([]);
  });

  it("skips a dangling symlink among the resources, with a warning", () => {
    symlinkSync(path.join(dir, "missing-target"), path.join(dir, "ghost.txt"));
    const cap = captureWarnings();
    try {
      const resources = enumerateResources(dir, true, cap);
      expect(resources.map((r) => r.rel)).not.toContain("ghost.txt");
      expect(cap.warnings.join("")).toMatch(/dangling symlink/);
    } finally {
      cap.restore();
    }
  });

  it("skips a resource symlink whose target escapes the skill dir, with a warning", () => {
    const outside = makeWorkspace();
    const outsideFile = path.join(outside, "secret.txt");
    writeFileSync(outsideFile, "x");
    symlinkSync(outsideFile, path.join(dir, "escape.txt"));
    const cap = captureWarnings();
    try {
      const resources = enumerateResources(dir, true, cap);
      expect(resources.map((r) => r.rel)).not.toContain("escape.txt");
      expect(cap.warnings.join("")).toMatch(/escaping skill dir/);
    } finally {
      cap.restore();
      cleanup(outside);
    }
  });

  it("skips an escaping resource symlink whose target cannot be realpathed", () => {
    const outside = makeWorkspace();
    const outsideFile = path.join(outside, "secret.txt");
    writeFileSync(outsideFile, "x");
    symlinkSync(outsideFile, path.join(dir, "opaque.txt"));
    chmodSync(outsideFile, 0o000);
    const cap = captureWarnings();
    try {
      expect(enumerateResources(dir, true, cap).map((r) => r.rel)).not.toContain("opaque.txt");
    } finally {
      cap.restore();
      chmodSync(outsideFile, 0o644);
      cleanup(outside);
    }
  });

  it("keeps a resource symlink whose target stays inside the skill dir", () => {
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    writeFileSync(path.join(dir, "assets", "logo.png"), "x");
    symlinkSync(path.join(dir, "assets", "logo.png"), path.join(dir, "icon.png"));
    const resources = enumerateResources(dir, true);
    expect(resources.map((r) => r.rel)).toContain("icon.png");
  });
});
