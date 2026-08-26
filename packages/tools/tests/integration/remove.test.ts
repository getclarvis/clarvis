import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  exists,
  chmod,
  modeBitsEnforced,
  makeSymlink,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("remove", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("deletes a file", async () => {
    write(root, "a.txt", "x");
    const r = await callTool("remove", { path: "a.txt" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Removed a.txt.");
    expect(exists(root, "a.txt")).toBe(false);
  });

  it("errors not_found when the path does not exist", async () => {
    const r = await callTool("remove", { path: "nope.txt" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("not_found");
  });

  it("errors not_a_file when the path is a directory", async () => {
    mkdirSync(path.join(root, "d"));
    const r = await callTool("remove", { path: "d" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("not_a_file");
    expect(exists(root, "d")).toBe(true);
  });

  it("refuses to delete through a symlink and reports invalid_input", async () => {
    write(root, "real.txt", "x");
    makeSymlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
    const r = await callTool("remove", { path: "link.txt" }, config);
    expect(r.json.error).toBe("invalid_input");
    expect(String(r.json.message)).toContain("symlink");
    expect(exists(root, "real.txt")).toBe(true);
    expect(exists(root, "link.txt")).toBe(true);
  });

  it.skipIf(!modeBitsEnforced)(
    "reports io_error when the parent directory is read-only",
    async () => {
      write(root, "ro/a.txt", "x");
      chmod(root, "ro", 0o555);
      try {
        const r = await callTool("remove", { path: "ro/a.txt" }, config);
        expect(r.isError).toBe(true);
        expect(r.json.error).toBe("io_error");
        expect(exists(root, "ro/a.txt")).toBe(true);
      } finally {
        chmod(root, "ro", 0o755);
      }
    },
  );

  it("rejects a path escaping the workspace with path_escape", async () => {
    const r = await callTool("remove", { path: "../a.txt" }, config);
    expect(r.json.error).toBe("path_escape");
  });

  it("ignores out-of-schema extra fields", async () => {
    write(root, "a.txt", "x");
    const r = await callTool("remove", { path: "a.txt", bogus: true }, config);
    expect(r.isError).toBe(false);
    expect(exists(root, "a.txt")).toBe(false);
  });
});
