import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { makeWorkspace, cleanup, makeConfig, callTool, write, read } from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("meta.diff (real unified diff on write/edit tools)", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  const diffOf = (meta: Record<string, unknown> | undefined): string =>
    typeof meta?.diff === "string" ? meta.diff : "";

  it("edit_file emits a diff with real line numbers and context", async () => {
    write(root, "a.ts", "line1\nline2\nline3\nline4\nline5\n");
    const r = await callTool(
      "edit_file",
      { path: "a.ts", old_string: "line3", new_string: "LINE3" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Replaced 1 occurrence in a.ts.");
    const diff = diffOf(r.meta);
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).not.toContain("@@ -1,1 +1,1 @@");
    expect(diff).toContain("-line3");
    expect(diff).toContain("+LINE3");
    expect(diff).toContain(" line2");
    expect(diff).toContain(" line4");
  });

  it("multi_edit emits a diff reflecting the sequential result", async () => {
    write(root, "b.txt", "alpha beta gamma\n");
    const r = await callTool(
      "multi_edit",
      {
        path: "b.txt",
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "gamma", new_string: "GAMMA" },
        ],
      },
      config,
    );
    const diff = diffOf(r.meta);
    expect(diff).toContain("-alpha beta gamma");
    expect(diff).toContain("+ALPHA beta GAMMA");
  });

  it("write_file overwrite emits a before/after diff", async () => {
    write(root, "c.md", "one\ntwo\nthree\n");
    const r = await callTool("write_file", { path: "c.md", content: "one\nTWO\nthree\n" }, config);
    expect(r.text).toContain("overwritten");
    const diff = diffOf(r.meta);
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
    expect(diff).toContain(" one");
    expect(read(root, "c.md")).toBe("one\nTWO\nthree\n");
  });

  it("write_file on a new file emits NO diff (nothing to compare)", async () => {
    const r = await callTool("write_file", { path: "new.txt", content: "fresh\n" }, config);
    expect(r.text).toContain("created");
    expect(diffOf(r.meta)).toBe("");
  });

  it("replace apply emits a diff per changed file", async () => {
    write(root, "d.txt", "foo foo foo\n");
    const r = await callTool(
      "replace",
      { pattern: "foo", replacement: "bar", glob: "**/*.txt", dry_run: false },
      config,
    );
    const diff = diffOf(r.meta);
    expect(diff).toContain("-foo foo foo");
    expect(diff).toContain("+bar bar bar");
  });

  it("keeps serialized diff metadata inside the configured byte cap", async () => {
    const before = Array.from({ length: 300 }, (_, index) => `old-${String(index)}`).join("\n");
    const after = Array.from({ length: 300 }, (_, index) => `new-${String(index)}`).join("\n");
    write(root, "large.txt", before);

    const result = await callTool(
      "write_file",
      { path: "large.txt", content: after },
      makeConfig(root, { maxToolMetaBytes: 1024 }),
    );

    expect(result.meta?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.meta), "utf8")).toBeLessThanOrEqual(1024);
  });
});
