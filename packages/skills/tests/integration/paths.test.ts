import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveResourcePath } from "../../src/paths.ts";
import { SkillError } from "../../src/errors.ts";
import { cleanup, makeWorkspace } from "../helpers/fixtures.ts";
import { recordingLogger } from "../helpers/logging.ts";

function skillError(fn: () => unknown): SkillError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SkillError) return e;
    throw e;
  }
  throw new Error("expected resolveResourcePath to throw a SkillError");
}

describe("resolveResourcePath", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeWorkspace();
    mkdirSync(path.join(dir, "references"), { recursive: true });
    writeFileSync(path.join(dir, "references", "a.md"), "a");
  });

  afterEach(() => cleanup(dir));

  it("resolves a nested resource inside the skill dir", () => {
    expect(resolveResourcePath(dir, "references/a.md")).toBe(path.join(dir, "references", "a.md"));
  });

  it("resolves a not-yet-existing nested path (confinement only, no existence check)", () => {
    expect(resolveResourcePath(dir, "assets/new/logo.png")).toBe(
      path.join(dir, "assets", "new", "logo.png"),
    );
  });

  it("confines against a skill dir path that is not present on disk", () => {
    expect(resolveResourcePath("/no/such/skill/xyz123", "references/a.md")).toBe(
      path.join("/no/such/skill/xyz123", "references", "a.md"),
    );
  });

  it("rejects an empty relative path", () => {
    expect(() => resolveResourcePath(dir, "")).toThrow(SkillError);
  });

  it("rejects an absolute path", () => {
    const err = skillError(() => resolveResourcePath(dir, "/etc/passwd"));
    expect(err.code).toBe("invalid_input");
  });

  it("rejects a ../ traversal that escapes the skill dir", () => {
    const err = skillError(() => resolveResourcePath(dir, "../../secret"));
    expect(err.code).toBe("path_escape");
  });

  it("rejects a resource reached through a symlink that escapes the skill dir", () => {
    const outside = makeWorkspace();
    try {
      writeFileSync(path.join(outside, "secret.txt"), "top secret");
      symlinkSync(outside, path.join(dir, "escape"));
      expect(() => resolveResourcePath(dir, "escape/secret.txt")).toThrow(/escapes/);
    } finally {
      cleanup(outside);
    }
  });

  it("rejects a sibling dir whose name is a prefix of the skill dir (trailing-separator guard)", () => {
    const evil = `${dir}-evil`;
    mkdirSync(evil, { recursive: true });
    writeFileSync(path.join(evil, "secret.txt"), "x");
    try {
      const err = skillError(() =>
        resolveResourcePath(dir, `../${path.basename(evil)}/secret.txt`),
      );
      expect(err.code).toBe("path_escape");
    } finally {
      cleanup(evil);
    }
  });

  it("warns when containment had to fall back to a lexical comparison", () => {
    const recorder = recordingLogger();
    const absent = path.join(dir, "absent-skill");

    expect(resolveResourcePath(absent, "references/a.md", recorder.logger)).toBe(
      path.join(absent, "references", "a.md"),
    );

    const [record] = recorder.events("skill.path_unresolved");
    expect(record?.level).toBe("warn");
    expect(record?.fields["path"]).toBe(absent);
  });
});
