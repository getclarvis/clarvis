import { describe, expect, test } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";

import { expandHome, resolveAgainst, resolveWorkspaceDir } from "../../src/index.ts";

const HOME = resolve("/home/clarvis-user");

describe("expandHome", () => {
  test("expands a bare ~ to home", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
  });

  test("expands ~/ followed by a path to home joined with the remainder", () => {
    expect(expandHome("~/foo/bar", HOME)).toBe(join(HOME, "foo/bar"));
  });

  test("expands ~/ alone to home", () => {
    expect(expandHome("~/", HOME)).toBe(join(HOME, ""));
  });

  test("leaves a bare ~foo unchanged — another user's home is a different lookup", () => {
    expect(expandHome("~foo", HOME)).toBe("~foo");
  });

  test("leaves an absolute and a relative path unchanged", () => {
    expect(expandHome(resolve("/etc/passwd"), HOME)).toBe(resolve("/etc/passwd"));
    expect(expandHome("relative/path", HOME)).toBe("relative/path");
  });
});

describe("resolveAgainst", () => {
  const BASE = resolve("/base/dir");

  test("expands ~ before resolving", () => {
    expect(resolveAgainst(BASE, "~/config", HOME)).toBe(join(HOME, "config"));
  });

  test("returns an already-absolute non-~ path unchanged", () => {
    const abs = resolve("/absolute/path");
    expect(resolveAgainst(BASE, abs, HOME)).toBe(abs);
  });

  test("resolves a relative path against base", () => {
    expect(resolveAgainst(BASE, "sub/path", HOME)).toBe(resolve(BASE, "sub/path"));
  });

  test("resolves . against base to base itself", () => {
    expect(resolveAgainst(BASE, ".", HOME)).toBe(BASE);
  });

  test("always answers with an absolute path", () => {
    for (const p of ["~", "~/x", ".", "sub", resolve("/abs")]) {
      expect(isAbsolute(resolveAgainst(BASE, p, HOME))).toBe(true);
    }
  });
});

describe("resolveWorkspaceDir", () => {
  const CWD = resolve("/cwd");

  test("falls back to cwd when workspace is undefined", () => {
    expect(resolveWorkspaceDir(undefined, CWD, HOME)).toBe(CWD);
  });

  test("resolves a relative workspace against cwd", () => {
    expect(resolveWorkspaceDir("projects/foo", CWD, HOME)).toBe(resolve(CWD, "projects/foo"));
  });

  test("expands a ~-prefixed workspace against home", () => {
    expect(resolveWorkspaceDir("~/projects/foo", CWD, HOME)).toBe(join(HOME, "projects/foo"));
  });

  test("returns an absolute workspace unchanged", () => {
    const abs = resolve("/abs/workspace");
    expect(resolveWorkspaceDir(abs, CWD, HOME)).toBe(abs);
  });
});
