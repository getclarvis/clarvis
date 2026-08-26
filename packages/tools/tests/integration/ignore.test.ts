import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { executableOnPath } from "@clarvis/paths";
import { makeWorkspace, cleanup, write } from "../helpers/fixtures.ts";
import { loadIgnore, MAX_IGNORE_FILE_BYTES } from "../../src/lib/ignore.ts";
import { setWarnSink } from "../../src/lib/log.ts";

const mkfifo = process.platform === "win32" ? undefined : executableOnPath("mkfifo");
const ignoreModule = new URL("../../src/lib/ignore.ts", import.meta.url).href;

function makeFifo(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const created = spawnSync(mkfifo!, [target], { stdio: "ignore" });
  expect(created.status).toBe(0);
}

function probeIgnore(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof spawnSync> {
  const program =
    `import { loadIgnore } from ${JSON.stringify(ignoreModule)};` +
    `loadIgnore(process.argv[1]).ignores("probe.txt");`;
  return spawnSync(process.execPath, ["-e", program, root], {
    env,
    encoding: "utf8",
    timeout: 2_000,
  });
}

describe("loadIgnore", () => {
  let root: string;
  let warnings: string[];
  const origXdg = process.env.XDG_CONFIG_HOME;
  const origHome = process.env.HOME;

  beforeEach(() => {
    root = makeWorkspace();
    warnings = [];
    setWarnSink((m) => warnings.push(m));
  });

  afterEach(() => {
    setWarnSink(null);
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    cleanup(root);
  });

  describe("built-in ignore rules", () => {
    it("ignores built-in base patterns (.clarvis, .clarvis-tmp-*)", () => {
      const m = loadIgnore(root);
      expect(m.ignores(".clarvis/state.json")).toBe(true);
      expect(m.ignores(".clarvis-tmp-abc/scratch")).toBe(true);
      expect(m.ignores("keepme.txt")).toBe(false);
    });

    it("treats any path component named .git as ignored", () => {
      const m = loadIgnore(root);
      expect(m.ignores(".git/config")).toBe(true);
      expect(m.ignores("sub/.git/HEAD")).toBe(true);
    });
  });

  describe("gitignore sources", () => {
    it("honors a root .gitignore for ignore decisions", () => {
      write(root, ".gitignore", "ignored.txt\n");
      write(root, "ignored.txt", "x");
      write(root, "keep.txt", "y");
      const m = loadIgnore(root);
      expect(m.ignores("ignored.txt")).toBe(true);
      expect(m.ignores("keep.txt")).toBe(false);
    });

    it("honors negation to un-ignore a file", () => {
      write(root, ".gitignore", "*.log\n!keep.log\n");
      const m = loadIgnore(root);
      expect(m.ignores("app.log")).toBe(true);
      expect(m.ignores("keep.log")).toBe(false);
    });

    it("caches the per-directory matcher across calls", () => {
      write(root, ".gitignore", "x.txt\n");
      const m = loadIgnore(root);
      expect(m.ignores("x.txt")).toBe(true);
      expect(m.ignores("x.txt")).toBe(true);
      expect(m.ignores("other.txt")).toBe(false);
    });

    it("applies a nested .gitignore while the root has none", () => {
      write(root, "sub/.gitignore", "local.txt\n");
      const m = loadIgnore(root);
      expect(m.ignores("sub/local.txt")).toBe(true);
      expect(m.ignores("sub/keep.txt")).toBe(false);
    });

    it("rejects an oversized .gitignore instead of parsing an unbounded source", () => {
      write(root, ".gitignore", "x".repeat(MAX_IGNORE_FILE_BYTES + 1));
      const m = loadIgnore(root);
      expect(m.ignores("anything.txt")).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("cannot read");
    });

    it.skipIf(mkfifo === undefined)("does not block when .gitignore is a FIFO", () => {
      makeFifo(path.join(root, ".gitignore"));
      const result = probeIgnore(root);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    });
  });

  describe("git exclude sources", () => {
    it("loads patterns from .git/info/exclude when a .git dir is present", () => {
      mkdirSync(path.join(root, ".git"));
      write(root, ".git/info/exclude", "excluded.txt\n");
      const m = loadIgnore(root);
      expect(m.ignores("excluded.txt")).toBe(true);
      expect(m.ignores("kept.txt")).toBe(false);
    });

    it("applies global excludes from XDG_CONFIG_HOME/git/ignore", () => {
      const xdg = makeWorkspace();
      try {
        write(xdg, "git/ignore", "globally-ignored.txt\n");
        process.env.XDG_CONFIG_HOME = xdg;
        const m = loadIgnore(root);
        expect(m.ignores("globally-ignored.txt")).toBe(true);
        expect(m.ignores("visible.txt")).toBe(false);
      } finally {
        cleanup(xdg);
      }
    });

    it("falls back to HOME/.config/git/ignore when XDG_CONFIG_HOME is unset", () => {
      const home = makeWorkspace();
      try {
        delete process.env.XDG_CONFIG_HOME;
        process.env.HOME = home;
        const m = loadIgnore(root);
        expect(m.ignores("anything.txt")).toBe(false);
      } finally {
        cleanup(home);
      }
    });

    it.skipIf(mkfifo === undefined)("does not block on FIFO repository or global excludes", () => {
      mkdirSync(path.join(root, ".git"), { recursive: true });
      makeFifo(path.join(root, ".git", "info", "exclude"));
      const xdg = makeWorkspace();
      try {
        makeFifo(path.join(xdg, "git", "ignore"));
        const result = probeIgnore(root, { ...process.env, XDG_CONFIG_HOME: xdg });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
      } finally {
        cleanup(xdg);
      }
    });
  });

  describe("path normalization and boundaries", () => {
    it("returns false for empty, dot, parent-relative and absolute paths", () => {
      const m = loadIgnore(root);
      expect(m.ignores("")).toBe(false);
      expect(m.ignores(".")).toBe(false);
      expect(m.ignores("../up.txt")).toBe(false);
      expect(m.ignores(path.resolve("/etc/passwd"))).toBe(false);
    });

    it("resolves paths that escape the ignore root to not-ignored", () => {
      const m = loadIgnore(root);
      expect(m.ignores("a/../../escape.txt")).toBe(false);
    });
  });

  describe("error contract", () => {
    it("warns when a .gitignore exists but cannot be read", () => {
      mkdirSync(path.join(root, ".gitignore"));
      const m = loadIgnore(root);
      expect(m.ignores("foo.txt")).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("cannot read");
      expect(warnings[0]).toContain(".gitignore");
    });

    it("silently skips a global excludes file that exists but cannot be read", () => {
      const xdg = makeWorkspace();
      try {
        mkdirSync(path.join(xdg, "git", "ignore"), { recursive: true });
        process.env.XDG_CONFIG_HOME = xdg;
        const m = loadIgnore(root);
        expect(m.ignores("anything.txt")).toBe(false);
      } finally {
        cleanup(xdg);
      }
    });
  });
});
