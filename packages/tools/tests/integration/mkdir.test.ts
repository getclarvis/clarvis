import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  chmod,
  modeBitsEnforced,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("mkdir", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("creates a directory and any missing parents", async () => {
    const r = await callTool("mkdir", { path: "a/b/c" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Created directory a/b/c.");
    expect(statSync(path.join(root, "a/b/c")).isDirectory()).toBe(true);
  });

  it("is idempotent when the directory already exists", async () => {
    await callTool("mkdir", { path: "d" }, config);
    const r = await callTool("mkdir", { path: "d" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Directory already exists: d.");
  });

  it("errors not_a_file when the path already exists as a file", async () => {
    write(root, "f.txt", "x");
    const r = await callTool("mkdir", { path: "f.txt" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("not_a_file");
  });

  it("errors not_a_file when a parent component is a file (ENOTDIR)", async () => {
    write(root, "f.txt", "x");
    const r = await callTool("mkdir", { path: "f.txt/sub" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("not_a_file");
  });

  it.skipIf(!modeBitsEnforced)("reports io_error under a read-only parent directory", async () => {
    await callTool("mkdir", { path: "ro" }, config);
    chmod(root, "ro", 0o555);
    try {
      const r = await callTool("mkdir", { path: "ro/child" }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("io_error");
      expect(existsSync(path.join(root, "ro/child"))).toBe(false);
    } finally {
      chmod(root, "ro", 0o755);
    }
  });

  it("rejects a path escaping the workspace with path_escape", async () => {
    const r = await callTool("mkdir", { path: "../escape" }, config);
    expect(r.json.error).toBe("path_escape");
  });

  it("ignores out-of-schema extra fields", async () => {
    const r = await callTool("mkdir", { path: "a", bogus: true }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Created directory a.");
  });
});
