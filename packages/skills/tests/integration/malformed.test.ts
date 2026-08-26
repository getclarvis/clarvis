import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { discoverSkills, resolveConfig } from "@clarvis/skills";
import { SkillError } from "../../src/errors.ts";
import {
  captureWarnings,
  clarvisRoots,
  cleanup,
  makeHome,
  makeWorkspace,
  skillsRoot,
  writeSkill,
} from "../helpers/fixtures.ts";

describe("malformed and duplicate skills", () => {
  let home: string;
  let ws: string;
  let root: string;

  beforeEach(() => {
    home = makeHome();
    ws = makeWorkspace();
    root = skillsRoot(ws, "clarvis");
  });

  afterEach(() => {
    cleanup(home);
    cleanup(ws);
  });

  function discover(strict = false, warningSink?: (message: string) => void) {
    return discoverSkills(
      resolveConfig({
        home,
        cwd: ws,
        workspace: ws,
        strict,
        roots: clarvisRoots(home, ws),
        ...(warningSink === undefined ? {} : { warningSink }),
      }),
    );
  }

  it("skips a malformed skill with a warning and keeps the healthy ones (default mode)", () => {
    writeSkill(root, "good");
    writeSkill(root, "broken", { raw: "---\nname: broken\n" }); // no closing fence

    const cap = captureWarnings();
    try {
      const registry = discover(false, cap.warningSink);
      expect(registry.list().map((s) => s.name)).toEqual(["good"]);
      expect(cap.warnings.join("")).toMatch(/skipping .*broken/);
    } finally {
      cap.restore();
    }
  });

  it("throws on the first malformed skill in strict mode", () => {
    writeSkill(root, "broken", { raw: "---\nname: broken\n" });
    expect(() => discover(true)).toThrow(SkillError);
  });

  it("keeps the first of a duplicate name within a root and warns (default mode)", () => {
    writeSkill(root, "dup", { dirName: "one", body: "first" });
    writeSkill(root, "dup", { dirName: "two", body: "second" });

    const cap = captureWarnings();
    try {
      const registry = discover(false, cap.warningSink);
      expect(registry.size).toBe(1);
      expect(registry.get("dup")?.body).toBe("first"); // "one" sorts before "two"
      expect(cap.warnings.join("")).toMatch(/duplicate skill 'dup'/);
    } finally {
      cap.restore();
    }
  });

  it("throws on a duplicate name within a root in strict mode", () => {
    writeSkill(root, "dup", { dirName: "one" });
    writeSkill(root, "dup", { dirName: "two" });
    const cap = captureWarnings();
    try {
      expect(() => discover(true)).toThrow(/Duplicate skill/);
    } finally {
      cap.restore();
    }
  });

  it("warns but still loads a skill whose declared name differs from its directory", () => {
    writeSkill(root, "declared", { dirName: "on-disk" });

    const cap = captureWarnings();
    try {
      const registry = discover(false, cap.warningSink);
      expect(registry.get("declared")?.name).toBe("declared");
      expect(cap.warnings.join("")).toMatch(/does not match directory/);
    } finally {
      cap.restore();
    }
  });
});
