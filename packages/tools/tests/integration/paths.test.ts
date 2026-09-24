import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import { configurationRoots } from "@clarvis/paths";
import { makeWorkspace, cleanup, makeSymlink } from "../helpers/fixtures.ts";
import {
  resolvePath,
  resolveFileToolPath,
  displayPath,
  isWithinRoots,
} from "../../src/lib/paths.ts";

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

describe("file-tool configuration path identity", () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
    mkdirSync(path.join(root, ".clarvis"));
  });
  afterEach(() => cleanup(root));

  const config = (root: string) => ({
    workspaceRoot: root,
    stateRoot: path.join(root, "state"),
    configurationRoots: configurationRoots({
      home: root,
      workspaceRoot: root,
      globalDir: path.join(root, "global"),
    }),
  });

  it("reports an unknown configuration document by its own class", () => {
    expect(() => resolveFileToolPath(".clarvis/unrecognized.json", config(root))).toThrow(
      "Configuration target is not recognized",
    );
  });

  it("refuses an unresolved link beneath the configuration root", () => {
    makeSymlink(path.join(root, "missing"), path.join(root, ".clarvis", "redirect"), "dir");
    expect(() => resolveFileToolPath(".clarvis/redirect/file.txt", config(root))).toThrow(
      "could not be safely resolved",
    );
  });

  it("refuses an ordinary alias that resolves into configuration", () => {
    makeSymlink(path.join(root, ".clarvis"), path.join(root, "alias"), "dir");
    expect(() => resolveFileToolPath("alias/settings.json", config(root))).toThrow(
      "changed during resolution",
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a configuration document with another hard-link name",
    () => {
      const settings = path.join(root, ".clarvis", "settings.json");
      writeFileSync(settings, "{}");
      linkSync(settings, path.join(root, "alias.json"));
      expect(() => resolveFileToolPath(".clarvis/settings.json", config(root))).toThrow(
        "contains a link",
      );
    },
  );
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

describe("Guard location facts — case folding", () => {
  // The drive-letter shape (`C:\Proj\a` against root `c:\proj`) cannot be
  // asserted here: `path.sep` is a host constant, so on a POSIX host the prefix
  // test builds `c:\proj/` and would fail for the wrong reason. That case belongs
  // to the Windows job. The case-folding property itself is testable with
  // host-native paths, which is what these cover.
  const accepts = (abs: string, root: string, caseInsensitive: boolean): boolean =>
    isWithinRoots(abs, [root], caseInsensitive);

  it("accepts a differently-cased child when the filesystem ignores case", () => {
    expect(accepts("/Ws/A", "/ws", true)).toBe(true);
  });

  it("rejects that same child when the filesystem is case-sensitive", () => {
    expect(accepts("/Ws/A", "/ws", false)).toBe(false);
  });

  it("still rejects a genuine escape under folding", () => {
    expect(accepts("/Other/A", "/ws", true)).toBe(false);
  });

  it("still rejects a sibling whose name merely starts with the root's", () => {
    expect(accepts("/wsX/a", "/ws", true)).toBe(false);
    expect(accepts("/WSX/a", "/ws", true)).toBe(false);
  });

  it("accepts the root itself in either mode", () => {
    expect(accepts("/ws", "/ws", true)).toBe(true);
    expect(accepts("/WS", "/ws", true)).toBe(true);
    expect(accepts("/WS", "/ws", false)).toBe(false);
  });
});

/**
 * A workspace reached through a symlinked ancestor is ordinary on macOS.
 * Guard location facts follow the canonical target without granting access.
 *
 * The link is created *inside* a temp parent and torn down by {@link cleanup}
 * rather than removed on its own. On Windows {@link makeSymlink} produces a
 * directory junction, and a non-recursive `rmSync` on one fails there with
 * `EFAULT`; the recursive sweep handles it, which is how the equivalent fixture
 * in `list-dir` already disposes of a junction on that platform.
 */
describe("Guard facts through a symlinked workspace root", () => {
  let parent: string;
  let real: string;
  let link: string;
  beforeEach(() => {
    parent = makeWorkspace();
    real = path.join(parent, "ws");
    mkdirSync(real);
    link = path.join(parent, "ws-link");
    makeSymlink(real, link, "dir");
  });
  afterEach(() => cleanup(parent));

  it("recognizes a not-yet-created child of the linked root", () => {
    expect(isWithinRoots(resolvePath("new/file.txt", link), [link])).toBe(true);
  });

  it("reports a genuine escape reached through the link", () => {
    const outside = path.resolve(real, "..", "escapee.txt");
    expect(isWithinRoots(outside, [link])).toBe(false);
  });

  it("reports a symlink out of the workspace as outside", () => {
    const target = path.join(parent, "outside", "dir");
    mkdirSync(target, { recursive: true });
    const escape = path.join(real, "sub");
    makeSymlink(target, escape, "dir");
    expect(isWithinRoots(resolvePath("sub/new.txt", link), [link])).toBe(false);
  });
});
