import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_FOLLOW_SYMLINKS,
  DEFAULT_STRICT,
  StartupError,
  resolveConfig,
} from "../../src/config.ts";
import { MAX_SKILL_ROOTS } from "../../src/limits.ts";

describe("resolveConfig", () => {
  it("fills defaults and preserves the given roots in order", () => {
    const config = resolveConfig({
      home: "/home/u",
      cwd: "/proj",
      roots: [
        { path: "/a", scope: "user", source: "alpha" },
        { path: "/b", scope: "workspace", source: "beta" },
      ],
    });
    expect(config.strict).toBe(DEFAULT_STRICT);
    expect(config.followSymlinks).toBe(DEFAULT_FOLLOW_SYMLINKS);
    expect(config.roots.map((r) => `${r.scope}:${r.source}`)).toEqual([
      "user:alpha",
      "workspace:beta",
    ]);
  });

  it("normalizes each root path and defaults scope/source", () => {
    const config = resolveConfig({
      home: "/home/u",
      cwd: "/proj",
      roots: [{ path: "~/skills" }, { path: ".local/skills" }, { path: "/abs/skills" }],
    });
    expect(config.roots.map((r) => r.path)).toEqual([
      path.join("/home/u", "skills"),
      path.join("/proj", ".local", "skills"),
      "/abs/skills",
    ]);
    expect(config.roots.map((r) => `${r.scope}:${r.source}`)).toEqual([
      "workspace:",
      "workspace:",
      "workspace:",
    ]);
  });

  it("normalizes an exact root allowlist without changing root precedence", () => {
    const config = resolveConfig({
      home: "/home/u",
      cwd: "/proj",
      roots: [{ path: "/a", include: ["zeta", "alpha", "zeta"] }, { path: "/b" }],
    });
    expect(config.roots[0]?.include).toEqual(["alpha", "zeta"]);
    expect(config.roots[1]?.include).toBeUndefined();
    expect(() =>
      resolveConfig({
        home: "/home/u",
        cwd: "/proj",
        roots: [{ path: "/a", include: [" spaced "] }],
      }),
    ).toThrow(StartupError);
  });

  it("preserves per-root portable discovery policy and resolves its confinement boundary", () => {
    const [root] = resolveConfig({
      home: "/home/u",
      cwd: "/proj",
      roots: [
        {
          path: "plugin/skills",
          discovery: "immediate",
          manifestName: "exact",
          validation: "agent-skills",
          confinementRoot: "plugin",
        },
      ],
    }).roots;

    expect(root).toMatchObject({
      path: path.join("/proj", "plugin", "skills"),
      discovery: "immediate",
      manifestName: "exact",
      validation: "agent-skills",
      confinementRoot: path.join("/proj", "plugin"),
    });
  });

  it("defaults the workspace to cwd when none is provided", () => {
    const config = resolveConfig({ home: "/home/u", cwd: "/proj", roots: [{ path: "/x" }] });
    expect(config.workspaceDir).toBe("/proj");
  });

  it("throws StartupError when no roots are given", () => {
    expect(() => resolveConfig({ home: "/home/u", cwd: "/proj", roots: [] })).toThrow(StartupError);
  });

  it("throws StartupError past the root ceiling, naming both counts", () => {
    const roots = Array.from({ length: MAX_SKILL_ROOTS + 1 }, (_, i) => ({
      path: `/r${String(i)}`,
    }));
    expect(() => resolveConfig({ home: "/home/u", cwd: "/proj", roots })).toThrow(
      new RegExp(`at most ${String(MAX_SKILL_ROOTS)} roots .*received ${String(roots.length)}`),
    );
    expect(() =>
      resolveConfig({ home: "/home/u", cwd: "/proj", roots: roots.slice(0, MAX_SKILL_ROOTS) }),
    ).not.toThrow();
  });

  it("names the error type it throws", () => {
    const err = new StartupError("boom");
    expect(err.name).toBe("StartupError");
    expect(err.message).toBe("boom");
    expect(err).toBeInstanceOf(Error);
  });
});
