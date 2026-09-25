import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { makeWorkspace, cleanup, makeSymlink } from "../helpers/fixtures.ts";
import { resolvePath, resolveFileToolPath, displayPath } from "../../src/lib/paths.ts";

describe("resolvePath", () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("resolves a relative path against the workspace base", () => {
    const result = resolvePath("nested/file.txt", root);
    expect(result).toBe(path.join(root, "nested", "file.txt"));
  });

  it("normalizes an absolute input and returns it unchanged", () => {
    const abs = path.join(root, "abs.txt");
    expect(resolvePath(abs, root)).toBe(abs);
  });

  it("resolves against a workspace root that does not exist yet", () => {
    const ghostRoot = path.join(root, "ghost", "sub");
    const result = resolvePath("file.txt", ghostRoot);
    expect(result).toBe(path.join(ghostRoot, "file.txt"));
  });

  it("resolves a parent traversal without treating the base as an access rule", () => {
    const outside = path.resolve(root, "..", "escapee.txt");
    expect(resolvePath("../escapee.txt", root)).toBe(outside);
  });
});

describe("file-tool paths", () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
    mkdirSync(path.join(root, ".clarvis"));
  });
  afterEach(() => cleanup(root));

  it("resolves configuration paths as ordinary workspace paths", () => {
    expect(resolveFileToolPath(".clarvis/unrecognized.json", { workspaceRoot: root })).toBe(
      path.join(root, ".clarvis", "unrecognized.json"),
    );
    makeSymlink(path.join(root, ".clarvis"), path.join(root, "alias"), "dir");
    expect(resolveFileToolPath("alias/settings.json", { workspaceRoot: root })).toBe(
      path.join(root, "alias", "settings.json"),
    );
  });
});

describe("displayPath", () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("returns '.' for the root itself", () => {
    expect(displayPath(root, root)).toBe(".");
  });

  it("returns a relative path for a child of the root", () => {
    expect(displayPath(path.join(root, "sub", "f.txt"), root)).toBe("sub/f.txt");
  });

  it("returns the absolute path for a target outside the root, forward-slashed", () => {
    const outside = path.resolve(root, "..", "elsewhere.txt");
    expect(displayPath(outside, root)).toBe(outside.split(path.sep).join("/"));
  });
});
