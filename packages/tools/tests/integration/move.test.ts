import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  read,
  exists,
  chmod,
  mode,
  modeBitsEnforced,
  makeSymlink,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("move", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  describe("moving", () => {
    it("moves a file, removing the source and preserving content", async () => {
      write(root, "a.txt", "hello");
      const r = await callTool("move", { source: "a.txt", destination: "b.txt" }, config);
      expect(r.isError).toBe(false);
      expect(r.text).toBe("Moved a.txt → b.txt.");
      expect(exists(root, "a.txt")).toBe(false);
      expect(read(root, "b.txt")).toBe("hello");
    });

    it("creates missing parent directories of the destination", async () => {
      write(root, "a.txt", "x");
      const r = await callTool("move", { source: "a.txt", destination: "x/y/b.txt" }, config);
      expect(r.isError).toBe(false);
      expect(read(root, "x/y/b.txt")).toBe("x");
    });

    it.skipIf(!modeBitsEnforced)("preserves the source file's mode", async () => {
      write(root, "s.sh", "echo a\n");
      chmod(root, "s.sh", 0o755);
      await callTool("move", { source: "s.sh", destination: "bin/s.sh" }, config);
      expect(mode(root, "bin/s.sh")).toBe(0o755);
    });
  });

  describe("overwrite", () => {
    it("refuses an existing destination and leaves both files intact", async () => {
      write(root, "a.txt", "src");
      write(root, "b.txt", "dst");
      const r = await callTool("move", { source: "a.txt", destination: "b.txt" }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("invalid_input");
      expect(String(r.json.message)).toContain("already exists");
      expect(read(root, "a.txt")).toBe("src");
      expect(read(root, "b.txt")).toBe("dst");
    });

    it("replaces an existing destination when overwrite is true", async () => {
      write(root, "a.txt", "src");
      write(root, "b.txt", "dst");
      const r = await callTool(
        "move",
        { source: "a.txt", destination: "b.txt", overwrite: true },
        config,
      );
      expect(r.isError).toBe(false);
      expect(r.text).toBe("Moved a.txt → b.txt (overwritten).");
      expect(exists(root, "a.txt")).toBe(false);
      expect(read(root, "b.txt")).toBe("src");
    });
  });

  describe("error contract", () => {
    it("errors not_found when the source is missing", async () => {
      const r = await callTool("move", { source: "nope.txt", destination: "b.txt" }, config);
      expect(r.json.error).toBe("not_found");
    });

    it("errors not_a_file when the source is a directory", async () => {
      mkdirSync(path.join(root, "d"));
      const r = await callTool("move", { source: "d", destination: "e" }, config);
      expect(r.json.error).toBe("not_a_file");
    });

    it("errors not_a_file when the destination is an existing directory", async () => {
      write(root, "a.txt", "x");
      mkdirSync(path.join(root, "d"));
      const r = await callTool(
        "move",
        { source: "a.txt", destination: "d", overwrite: true },
        config,
      );
      expect(r.json.error).toBe("not_a_file");
    });

    it("errors invalid_input when source and destination are the same", async () => {
      write(root, "a.txt", "x");
      const r = await callTool("move", { source: "a.txt", destination: "a.txt" }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(String(r.json.message)).toContain("same");
    });

    it("refuses a symlink source and reports invalid_input", async () => {
      write(root, "real.txt", "x");
      makeSymlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
      const r = await callTool("move", { source: "link.txt", destination: "b.txt" }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(String(r.json.message)).toContain("symlink");
    });

    it("refuses a symlink destination and reports invalid_input", async () => {
      write(root, "a.txt", "x");
      write(root, "real.txt", "y");
      makeSymlink(path.join(root, "real.txt"), path.join(root, "b.txt"));
      const r = await callTool(
        "move",
        { source: "a.txt", destination: "b.txt", overwrite: true },
        config,
      );
      expect(r.json.error).toBe("invalid_input");
      expect(String(r.json.message)).toContain("symlink");
    });

    it.skipIf(!modeBitsEnforced)(
      "reports io_error when the destination dir is read-only",
      async () => {
        write(root, "a.txt", "x");
        mkdirSync(path.join(root, "ro"));
        chmod(root, "ro", 0o555);
        try {
          const r = await callTool("move", { source: "a.txt", destination: "ro/b.txt" }, config);
          expect(r.isError).toBe(true);
          expect(r.json.error).toBe("io_error");
        } finally {
          chmod(root, "ro", 0o755);
        }
      },
    );

    it("rejects a path escaping the workspace with path_escape", async () => {
      write(root, "a.txt", "x");
      const r = await callTool("move", { source: "a.txt", destination: "../b.txt" }, config);
      expect(r.json.error).toBe("path_escape");
    });

    it("ignores out-of-schema extra fields", async () => {
      write(root, "a.txt", "hello");
      const r = await callTool("move", { source: "a.txt", destination: "b.txt", bogus: 1 }, config);
      expect(r.isError).toBe(false);
      expect(read(root, "b.txt")).toBe("hello");
    });
  });
});
