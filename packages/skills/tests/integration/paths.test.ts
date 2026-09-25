import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveResourcePath } from "../../src/paths.ts";
import { SkillError } from "../../src/errors.ts";
import { cleanup, makeWorkspace } from "../helpers/fixtures.ts";

describe("resolveResourcePath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeWorkspace();
    mkdirSync(path.join(dir, "references"), { recursive: true });
    writeFileSync(path.join(dir, "references", "a.md"), "a");
  });
  afterEach(() => cleanup(dir));

  it("resolves paths relative to the skill", () => {
    expect(resolveResourcePath(dir, "references/a.md")).toBe(path.join(dir, "references", "a.md"));
  });

  it("accepts parent traversal and absolute paths", () => {
    const external = path.resolve(dir, "../external.md");
    expect(resolveResourcePath(dir, "../external.md")).toBe(external);
    expect(resolveResourcePath(dir, external)).toBe(external);
  });

  it("leaves symlinks for the filesystem to resolve", () => {
    const outside = makeWorkspace();
    try {
      symlinkSync(outside, path.join(dir, "link"));
      expect(resolveResourcePath(dir, "link/file.md")).toBe(path.join(dir, "link", "file.md"));
    } finally {
      cleanup(outside);
    }
  });

  it("rejects an empty path", () => {
    expect(() => resolveResourcePath(dir, "")).toThrow(SkillError);
  });
});
