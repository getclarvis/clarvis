import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  chmod,
  modeBitsEnforced,
  makeSymlink,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("list_dir", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("lists dirs first then files alpha, with dotfiles and sizes", async () => {
    mkdirSync(path.join(root, "sub"));
    write(root, ".hidden", "h");
    write(root, "a.txt", "aa");
    write(root, "b.txt", "bbb");
    const r = await callTool("list_dir", {}, config);
    expect(r.text).toBe("sub/\n.hidden\t1\na.txt\t2\nb.txt\t3");
  });

  it("orders two directories alphabetically and sorts files by name, not size", async () => {
    mkdirSync(path.join(root, "delta"));
    mkdirSync(path.join(root, "beta"));
    write(root, "gamma.txt", "y");
    write(root, "alpha.txt", "xx");
    write(root, "omega.txt", "zzz");
    const r = await callTool("list_dir", {}, config);
    expect(r.text).toBe("beta/\ndelta/\nalpha.txt\t2\ngamma.txt\t1\nomega.txt\t3");
  });

  it("defaults to the workspace root", async () => {
    write(root, "only.txt", "x");
    const r = await callTool("list_dir", {}, config);
    expect(r.text).toBe("only.txt\t1");
  });

  it("returns (empty directory) for an empty dir (BUG-16)", async () => {
    mkdirSync(path.join(root, "empty"));
    const r = await callTool("list_dir", { path: "empty" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("(empty directory)");
  });

  it("classifies a symlink-to-directory as a directory (trailing /, sorted with dirs)", async () => {
    mkdirSync(path.join(root, "realdir"));
    makeSymlink(path.join(root, "realdir"), path.join(root, "linkdir"), "dir");
    write(root, "plain.txt", "y");
    const r = await callTool("list_dir", {}, config);
    expect(r.text).toBe("linkdir/\nrealdir/\nplain.txt\t1");
  });

  it("treats a broken symlink as a zero-size file", async () => {
    mkdirSync(path.join(root, "sub"));
    write(root, "file.txt", "aa");
    makeSymlink(path.join(root, "does-not-exist"), path.join(root, "zlink"));
    const r = await callTool("list_dir", {}, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("sub/\nfile.txt\t2\nzlink\t0");
  });

  it("errors not_found for a missing directory", async () => {
    const r = await callTool("list_dir", { path: "nope" }, config);
    expect(r.json.error).toBe("not_found");
  });

  it("errors not_a_file when path is a file", async () => {
    write(root, "f.txt", "x");
    const r = await callTool("list_dir", { path: "f.txt" }, config);
    expect(r.json.error).toBe("not_a_file");
  });

  it.skipIf(!modeBitsEnforced)("surfaces a readdir failure as an io_error", async () => {
    mkdirSync(path.join(root, "locked"));
    chmod(root, "locked", 0o000);
    try {
      const r = await callTool("list_dir", { path: "locked" }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("io_error");
    } finally {
      chmod(root, "locked", 0o755);
    }
  });

  it("ignores out-of-schema extra fields", async () => {
    const r = await callTool("list_dir", { bogus: true }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("(empty directory)");
  });
});
