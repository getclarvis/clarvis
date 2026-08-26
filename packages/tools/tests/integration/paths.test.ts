import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { makeWorkspace, cleanup, write, makeSymlink } from "../helpers/fixtures.ts";
import { resolvePath, displayPath, assertWithinWorkspace } from "../../src/lib/paths.ts";

describe("resolvePath", () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("resolves a relative path against an existing workspace with confine", () => {
    const result = resolvePath("nested/file.txt", root, true);
    expect(result).toBe(path.join(root, "nested", "file.txt"));
  });

  it("canonicalizes an existing confined target that has no missing path segments", () => {
    write(root, "here.txt", "x");
    const result = resolvePath("here.txt", root, true);
    expect(result).toBe(path.join(root, "here.txt"));
  });

  it("normalizes an absolute input and returns it unchanged", () => {
    const abs = path.join(root, "abs.txt");
    expect(resolvePath(abs, root, false)).toBe(abs);
  });

  it("resolves against a workspace root that does not exist yet", () => {
    const ghostRoot = path.join(root, "ghost", "sub");
    const result = resolvePath("file.txt", ghostRoot, true);
    expect(result).toBe(path.join(ghostRoot, "file.txt"));
  });

  it("throws when a confined path escapes the workspace root", () => {
    const outside = path.resolve(root, "..", "escapee.txt");
    expect(() => resolvePath(outside, root, true)).toThrow(/escapes the workspace root/);
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

describe("assertWithinWorkspace — case folding", () => {
  // The drive-letter shape (`C:\Proj\a` against root `c:\proj`) cannot be
  // asserted here: `path.sep` is a host constant, so on a POSIX host the prefix
  // test builds `c:\proj/` and would fail for the wrong reason. That case belongs
  // to the Windows job. The case-folding property itself is testable with
  // host-native paths, which is what these cover.
  const accepts = (abs: string, root: string, caseInsensitive: boolean): boolean => {
    try {
      assertWithinWorkspace(abs, root, abs, caseInsensitive);
      return true;
    } catch {
      return false;
    }
  };

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
 * A workspace reached through a symlinked ancestor is the ordinary case on
 * macOS, where every temp directory lives under `/var` -> `/private/var`, and is
 * reachable anywhere a user's project path crosses a link. It is built
 * explicitly here so the guarantee is asserted on Linux CI too, rather than only
 * on the hosts that happen to supply the link for free.
 *
 * The link is created *inside* a temp parent and torn down by {@link cleanup}
 * rather than removed on its own. On Windows {@link makeSymlink} produces a
 * directory junction, and a non-recursive `rmSync` on one fails there with
 * `EFAULT`; the recursive sweep handles it, which is how the equivalent fixture
 * in `list-dir` already disposes of a junction on that platform.
 */
describe("confinement through a symlinked workspace root", () => {
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

  it("admits a child that cannot be realpathed, so its own error surfaces", () => {
    const locked = path.join(real, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      expect(() => resolvePath("locked", link, true)).not.toThrow();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("admits a not-yet-created child of the linked root", () => {
    expect(() => resolvePath("new/file.txt", link, true)).not.toThrow();
  });

  it("still rejects a genuine escape reached through the link", () => {
    const outside = path.resolve(real, "..", "escapee.txt");
    expect(() => resolvePath(outside, link, true)).toThrow(/escapes the workspace root/);
  });

  /**
   * The dangerous half of tolerating an unresolvable path. `realpath` needs read
   * permission on a directory, while creating a file inside it needs only search
   * and write — so a link out of the workspace whose target is mode `0o311`
   * cannot be resolved yet can be written through. Admitting a path merely
   * because it would not resolve hands `write_file` a way out of the workspace.
   */
  it("rejects a symlink out of the workspace whose target cannot be realpathed", () => {
    const target = path.join(parent, "outside", "dir");
    mkdirSync(target, { recursive: true });
    const escape = path.join(real, "sub");
    makeSymlink(target, escape, "dir");
    chmodSync(target, 0o311);
    try {
      expect(() => resolvePath("sub/new.txt", link, true)).toThrow(/escapes the workspace root/);
    } finally {
      chmodSync(target, 0o755);
    }
  });
});
