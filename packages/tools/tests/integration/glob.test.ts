import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { utimesSync } from "node:fs";
import path from "node:path";
import type { ServerConfig } from "../../src/config.ts";
import { createGlobTool } from "../../src/tools/glob.ts";

import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  chmod,
  modeBitsEnforced,
} from "../helpers/fixtures.ts";

describe("glob", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => {
    cleanup(root);
  });

  it("returns matches sorted by mtime (most recent first)", async () => {
    write(root, "old.ts", "a");
    write(root, "new.ts", "b");
    utimesSync(path.join(root, "old.ts"), new Date(1000), new Date(1000));
    utimesSync(path.join(root, "new.ts"), new Date(2000), new Date(2000));
    const r = await callTool("glob", { pattern: "**/*.ts" }, config);
    expect(r.text).toBe("new.ts\nold.ts");
  });

  it("breaks mtime ties by path in ascending order", async () => {
    write(root, "c.ts", "1");
    write(root, "a.ts", "2");
    write(root, "b.ts", "3");
    const same = new Date(1_700_000_000_000);
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      utimesSync(path.join(root, name), same, same);
    }
    const r = await callTool("glob", { pattern: "**/*.ts", respect_gitignore: false }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("a.ts\nb.ts\nc.ts");
  });

  it("excludes .gitignore'd files by default", async () => {
    write(root, "keep.ts", "a");
    write(root, ".gitignore", "node_modules/\n");
    write(root, "node_modules/dep.ts", "b");
    const r = await callTool("glob", { pattern: "**/*.ts" }, config);
    expect(r.text).toBe("keep.ts");
  });

  it("includes ignored files when respect_gitignore is false", async () => {
    write(root, "keep.ts", "a");
    write(root, ".gitignore", "node_modules/\n");
    write(root, "node_modules/dep.ts", "b");
    const r = await callTool("glob", { pattern: "**/*.ts", respect_gitignore: false }, config);
    const lines = r.text.split("\n").sort();
    expect(lines).toEqual(["keep.ts", "node_modules/dep.ts"]);
  });

  it("returns (no matches) as a success when nothing matches", async () => {
    write(root, "a.js", "x");
    const r = await callTool("glob", { pattern: "**/*.ts" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)");
  });

  it("stops retaining matches at the traversal cap and says the result is incomplete", async () => {
    for (const name of ["a.ts", "b.ts", "c.ts"]) write(root, name, "x");
    const capped = makeConfig(root, { maxTraversalEntries: 2 });

    const result = await callTool("glob", { pattern: "**/*.ts", respect_gitignore: false }, capped);

    expect(result.isError).toBe(false);
    expect(result.text).toContain("search incomplete");
    expect(result.text.split("\n").filter((line) => line.endsWith(".ts"))).toHaveLength(2);
  });

  it.skipIf(!modeBitsEnforced)(
    "drops files whose metadata cannot be read, yielding (no matches)",
    async () => {
      write(root, "sub/a.ts", "x");
      chmod(root, "sub", 0o444);
      try {
        const r = await callTool("glob", { pattern: "sub/*.ts", respect_gitignore: false }, config);
        expect(r.isError).toBe(false);
        expect(r.text).toBe("(no matches)");
      } finally {
        chmod(root, "sub", 0o755);
      }
    },
  );

  it("errors not_found for a missing base path", async () => {
    const r = await callTool("glob", { pattern: "*", path: "nope" }, config);
    expect(r.json.error).toBe("not_found");
  });

  it("ignores out-of-schema extra fields", async () => {
    const r = await callTool("glob", { pattern: "*", bogus: 1 }, config);
    expect(r.isError).toBe(false);
  });

  it("surfaces a failed file listing as invalid_input", async () => {
    write(root, "a.ts", "x");
    const tool = createGlobTool(async () => {
      throw new Error("simulated enumerator failure");
    });
    expect(
      tool.handler({ pattern: "**/*.ts", respect_gitignore: true }, config),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("simulated enumerator failure"),
    });
  });
});
