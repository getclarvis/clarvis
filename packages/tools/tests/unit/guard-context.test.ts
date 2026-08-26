import { describe, expect, it } from "bun:test";
import path from "node:path";
import { buildGuardContext } from "../../src/guard/context.ts";
import { makeConfig } from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

// buildGuardContext only resolves paths lexically. A stable, nonexistent root
// keeps this a unit test and avoids creating a directory for behavior that
// never reads the filesystem.
const root = path.resolve(".guard-context-unit-workspace");
const config: ServerConfig = makeConfig(root);

const within = (ctx: ReturnType<typeof buildGuardContext>, raw: string): boolean | undefined =>
  ctx.paths.find((p) => p.raw === raw)?.withinWorkspace;

describe("buildGuardContext — command tools", () => {
  it("renders arbitrary host argv for review without treating it as shell input", () => {
    const ctx = buildGuardContext(
      "host_vcs",
      { program: "bun", args: ["test", "title with spaces"], cwd: "sub" },
      config,
    );
    expect(ctx.args.command).toBe("bun test 'title with spaces'");
    expect(ctx.shell?.segments[0]?.argv).toEqual(["bun", "test", "title with spaces"]);
    expect(within(ctx, "sub")).toBe(true);
  });

  it("analyzes bash and resolves in-workspace vs escaping paths", () => {
    const ok = buildGuardContext("shell", { command: "cat src/a.ts" }, config);
    expect(ok.shell?.undecidable).toBe(false);
    expect(within(ok, "src/a.ts")).toBe(true);

    const esc = buildGuardContext("shell", { command: "cat /etc/passwd" }, config);
    expect(within(esc, "/etc/passwd")).toBe(false);
  });

  it("expands ~/ with shell semantics so it escapes the workspace", () => {
    const ctx = buildGuardContext("shell", { command: "cat ~/.ssh/id_rsa" }, config);
    expect(within(ctx, "~/.ssh/id_rsa")).toBe(false);
  });

  it("adds cwd as an fs-semantics path fact", () => {
    const ctx = buildGuardContext("shell", { command: "ls", cwd: "sub" }, config);
    expect(within(ctx, "sub")).toBe(true);
  });

  it("handles monitor_start like bash", () => {
    const ctx = buildGuardContext("monitor_start", { command: "npm run dev" }, config);
    expect(ctx.shell).toBeDefined();
  });
});

describe("buildGuardContext — path-arg tools", () => {
  it("resolves the path arg, flagging escapes", () => {
    expect(within(buildGuardContext("read_file", { path: "a.ts" }, config), "a.ts")).toBe(true);
    expect(within(buildGuardContext("write_file", { path: "../x" }, config), "../x")).toBe(false);
  });

  it("treats a literal ~ path arg with fs semantics (stays inside)", () => {
    expect(within(buildGuardContext("read_file", { path: "~" }, config), "~")).toBe(true);
  });

  it("resolves the path arg for file_stat, tree, mkdir, and remove", () => {
    for (const tool of ["file_stat", "tree", "mkdir", "remove"]) {
      expect(within(buildGuardContext(tool, { path: "sub/a.ts" }, config), "sub/a.ts")).toBe(true);
      expect(within(buildGuardContext(tool, { path: "../x" }, config), "../x")).toBe(false);
    }
  });
});

describe("buildGuardContext — move / copy (source + destination)", () => {
  it("resolves both endpoints and flags an escaping one", () => {
    for (const tool of ["move", "copy"]) {
      const ctx = buildGuardContext(tool, { source: "a.txt", destination: "../out.txt" }, config);
      expect(ctx.paths.map((p) => p.raw)).toEqual(["a.txt", "../out.txt"]);
      expect(within(ctx, "a.txt")).toBe(true);
      expect(within(ctx, "../out.txt")).toBe(false);
    }
  });

  it("produces no facts when the endpoints are absent", () => {
    expect(buildGuardContext("move", {}, config).paths).toHaveLength(0);
  });
});

describe("buildGuardContext — apply_patch", () => {
  it("extracts paths from diff headers, ignoring /dev/null", () => {
    const patch = ["--- a/src/x.ts", "+++ b/src/x.ts", "--- /dev/null", "+++ b/new.ts"].join("\n");
    const ctx = buildGuardContext("apply_patch", { patch }, config);
    const raws = ctx.paths.map((p) => p.raw);
    expect(raws).toContain("src/x.ts");
    expect(raws).toContain("new.ts");
    expect(raws).not.toContain("/dev/null");
  });

  it("extracts every model-envelope source and move destination", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: ../outside.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/new.ts",
      "+new",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ].join("\n");
    const ctx = buildGuardContext("apply_patch", { patch }, config);

    expect(ctx.paths.map((fact) => fact.raw)).toEqual([
      "src/a.ts",
      "../outside.ts",
      "src/new.ts",
      "src/old.ts",
    ]);
    expect(within(ctx, "../outside.ts")).toBe(false);
  });
});

describe("buildGuardContext — read_files (array of paths)", () => {
  it("resolves every path in the array, flagging escapes", () => {
    const ctx = buildGuardContext("read_files", { paths: ["a.ts", "../x", "sub/b.ts"] }, config);
    expect(ctx.paths.map((p) => p.raw)).toEqual(["a.ts", "../x", "sub/b.ts"]);
    expect(within(ctx, "a.ts")).toBe(true);
    expect(within(ctx, "../x")).toBe(false);
    expect(within(ctx, "sub/b.ts")).toBe(true);
  });

  it("ignores non-string entries and a missing paths arg", () => {
    const raws = buildGuardContext("read_files", { paths: ["a.ts", 3, null] }, config).paths.map(
      (p) => p.raw,
    );
    expect(raws).toEqual(["a.ts"]);
    expect(buildGuardContext("read_files", {}, config).paths).toHaveLength(0);
  });
});

describe("buildGuardContext — diff (from + to)", () => {
  it("resolves both endpoints and flags an escaping one", () => {
    const ctx = buildGuardContext("diff", { from: "a.ts", to: "../b.ts" }, config);
    expect(ctx.paths.map((p) => p.raw)).toEqual(["a.ts", "../b.ts"]);
    expect(within(ctx, "a.ts")).toBe(true);
    expect(within(ctx, "../b.ts")).toBe(false);
  });
});

describe("buildGuardContext — replace (scope)", () => {
  it("surfaces an explicit path as the scope, flagging escapes", () => {
    const inside = buildGuardContext(
      "replace",
      { path: "src", pattern: "a", replacement: "b" },
      config,
    );
    expect(within(inside, "src")).toBe(true);
    const out = buildGuardContext(
      "replace",
      { path: "../x", pattern: "a", replacement: "b" },
      config,
    );
    expect(within(out, "../x")).toBe(false);
  });

  it("falls back to the workspace root when only a glob is given", () => {
    const ctx = buildGuardContext(
      "replace",
      { glob: "**/*.ts", pattern: "a", replacement: "b" },
      config,
    );
    expect(ctx.paths.map((p) => p.raw)).toEqual(["."]);
    expect(within(ctx, ".")).toBe(true);
  });
});

describe("buildGuardContext — tools without path/command args", () => {
  it("returns empty paths and no bash facts", () => {
    const ctx = buildGuardContext("monitor_poll", { id: "m1" }, config);
    expect(ctx.paths).toHaveLength(0);
    expect(ctx.shell).toBeUndefined();
  });
});

describe("buildGuardContext — missing / absent args", () => {
  it("produces no facts when the relevant arg is absent", () => {
    expect(buildGuardContext("shell", {}, config).shell).toBeUndefined();
    expect(buildGuardContext("shell", {}, config).paths).toHaveLength(0);
    expect(buildGuardContext("read_file", {}, config).paths).toHaveLength(0);
    expect(buildGuardContext("apply_patch", {}, config).paths).toHaveLength(0);
  });

  it("expands a bare ~ with shell semantics", () => {
    const ctx = buildGuardContext("shell", { command: "cd ~" }, config);
    expect(within(ctx, "~")).toBe(false);
  });

  it("ignores blank diff headers and body lines", () => {
    const patch = ["--- ", "+++ b/only.ts", "context line"].join("\n");
    const raws = buildGuardContext("apply_patch", { patch }, config).paths.map((p) => p.raw);
    expect(raws).toEqual(["only.ts"]);
  });
});
