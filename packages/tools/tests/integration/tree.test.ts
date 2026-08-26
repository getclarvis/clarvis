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

describe("tree", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("renders an indented tree: dirs first with /, files with size", async () => {
    write(root, "src/a.ts", "xx");
    write(root, "b.txt", "y");
    const r = await callTool("tree", {}, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe([".", "├── src/", "│   └── a.ts\t2", "└── b.txt\t1"].join("\n"));
  });

  it("skips .gitignored paths and .git by default, but shows them when disabled", async () => {
    write(root, "keep.txt", "y");
    write(root, ".gitignore", "ignored.txt\n");
    write(root, "ignored.txt", "z");
    const def = await callTool("tree", {}, config);
    expect(def.text).toContain("keep.txt");
    expect(def.text).not.toContain("ignored.txt");

    const all = await callTool("tree", { respect_gitignore: false }, config);
    expect(all.text).toContain("ignored.txt");
  });

  it("limits recursion with depth", async () => {
    write(root, "a/b/c.txt", "x");
    const d1 = await callTool("tree", { depth: 1 }, config);
    expect(d1.text).toContain("a/");
    expect(d1.text).not.toContain("b/");

    const d2 = await callTool("tree", { depth: 2 }, config);
    expect(d2.text).toContain("b/");
    expect(d2.text).not.toContain("c.txt");
  });

  it("lists a symlinked directory with @ but does not traverse it", async () => {
    write(root, "realdir/inner.txt", "x");
    makeSymlink(path.join(root, "realdir"), path.join(root, "linkdir"));
    const r = await callTool("tree", {}, config);
    expect(r.text).toContain("linkdir@");
    expect(r.text.match(/inner\.txt/g)).toHaveLength(1);
  });

  it("returns (no entries) for an empty directory", async () => {
    mkdirSync(path.join(root, "empty"));
    const r = await callTool("tree", { path: "empty" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("empty\n(no entries)");
  });

  it("errors not_found for a missing directory", async () => {
    const r = await callTool("tree", { path: "nope" }, config);
    expect(r.json.error).toBe("not_found");
  });

  it("errors not_a_file when the path is a file", async () => {
    write(root, "f.txt", "x");
    const r = await callTool("tree", { path: "f.txt" }, config);
    expect(r.json.error).toBe("not_a_file");
  });

  it.skipIf(!modeBitsEnforced)("surfaces an unreadable subdirectory as io_error", async () => {
    mkdirSync(path.join(root, "locked"));
    chmod(root, "locked", 0o000);
    try {
      const r = await callTool("tree", {}, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("io_error");
    } finally {
      chmod(root, "locked", 0o755);
    }
  });

  it("treats depth 0 as the default (4), not unlimited", async () => {
    write(root, "a/b/c.txt", "x");
    const r = await callTool("tree", { depth: 0 }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("a/");
    expect(r.text).toContain("b/");
    expect(r.text).toContain("c.txt");
  });

  it("clamps a requested depth to MAX_TREE_DEPTH and reaches every level up to it", async () => {
    // 22 levels: deeper than the clamp, so the leaf at 21 must not appear and
    // the one at exactly 20 must. Nothing else exercises a depth above 4.
    const deep = Array.from({ length: 22 }, (_v, i) => `d${String(i + 1)}`);
    write(root, `${deep.join("/")}/leaf.txt`, "x");

    const r = await callTool("tree", { depth: 999 }, config);

    expect(r.isError).toBe(false);
    expect(r.text).toContain("d20/");
    expect(r.text).not.toContain("d21/");
    expect(r.text).not.toContain("leaf.txt");
  });

  it("does not report an incomplete tree when a directory has exactly the traversal cap", async () => {
    write(root, "a.txt", "a");
    write(root, "b.txt", "b");
    const capped = makeConfig(root, { maxTraversalEntries: 2 });

    const r = await callTool("tree", {}, capped);

    expect(r.isError).toBe(false);
    expect(r.text).toBe([".", "├── a.txt\t1", "└── b.txt\t1"].join("\n"));
    expect(r.text).not.toContain("tree incomplete");
  });

  it("reads N+1 to report an incomplete tree when a directory exceeds the traversal cap", async () => {
    write(root, "a.txt", "a");
    write(root, "b.txt", "b");
    write(root, "c.txt", "c");
    const capped = makeConfig(root, { maxTraversalEntries: 2 });

    const r = await callTool("tree", {}, capped);

    expect(r.isError).toBe(false);
    const lines = r.text.split("\n");
    expect(lines.filter((line) => line.includes(".txt\t1"))).toHaveLength(2);
    expect(lines.at(-1)).toBe(
      "[tree incomplete: a directory held more than 2 entries and was listed in part]",
    );
  });

  it("keeps walking siblings when an ignored directory blows the per-level cap", async () => {
    // `heavy/` is walked, but every child is ignored. The dirent cap is counted
    // before the matcher runs, so the level reports itself truncated while
    // contributing no rendered line at all. That must not discard `keep/` —
    // which sorts after it — nor the rest of the tree.
    for (let i = 0; i < 5; i++) write(root, `heavy/junk-${String(i)}.txt`, "x");
    write(root, "keep/wanted.txt", "y");
    write(root, ".gitignore", "junk-*\n");
    const capped = makeConfig(root, { maxTraversalEntries: 3 });

    const r = await callTool("tree", {}, capped);

    expect(r.isError).toBe(false);
    expect(r.text).toContain("keep/");
    expect(r.text).toContain("wanted.txt");
    expect(r.text).not.toContain("junk-");
  });

  it("ignores out-of-schema extra fields", async () => {
    const r = await callTool("tree", { bogus: true }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe(".\n(no entries)");
  });
});
