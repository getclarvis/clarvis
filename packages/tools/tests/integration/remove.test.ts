import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync, promises as fs } from "node:fs";
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
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(root);
  });

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

  it("refuses recursive cleanup when the selected path is a file", async () => {
    write(root, "plain.txt", "keep");
    const result = await callTool("remove", { path: "plain.txt", recursive: true }, config);
    expect(result.json.error).toBe("invalid_input");
    expect(exists(root, "plain.txt")).toBe(true);
  });

  it("reports an OS refusal when recursive tree removal cannot start", async () => {
    mkdirSync(path.join(root, "blocked"));
    const target = path.join(root, "blocked");
    const realRm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation((selected, options) =>
      selected === target
        ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
        : realRm(selected, options),
    );
    const result = await callTool("remove", { path: "blocked", recursive: true }, config);
    expect(result.json.error).toBe("io_error");
    expect(exists(root, "blocked")).toBe(true);
  });

  it("reports a directory that gains an entry after the emptiness check", async () => {
    mkdirSync(path.join(root, "raced"));
    const target = path.join(root, "raced");
    const realRmdir = fs.rmdir.bind(fs);
    vi.spyOn(fs, "rmdir").mockImplementation((selected) =>
      selected === target
        ? Promise.reject(Object.assign(new Error("not empty"), { code: "ENOTEMPTY" }))
        : realRmdir(selected),
    );
    const result = await callTool("remove", { path: "raced" }, config);
    expect(result.json.error).toBe("invalid_input");
    expect(exists(root, "raced")).toBe(true);
  });

  it("removes an empty directory", async () => {
    mkdirSync(path.join(root, "d"));
    const r = await callTool("remove", { path: "d" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Removed empty directory d.");
    expect(exists(root, "d")).toBe(false);
  });

  it("recursively removes an empty directory", async () => {
    mkdirSync(path.join(root, "empty"));
    const result = await callTool("remove", { path: "empty", recursive: true }, config);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("Removed tree empty.");
    expect(exists(root, "empty")).toBe(false);
  });

  it("refuses a nonempty directory without changing its entries", async () => {
    write(root, "d/a.txt", "x");
    const r = await callTool("remove", { path: "d" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("invalid_input");
    expect(exists(root, "d")).toBe(true);
    expect(exists(root, "d/a.txt")).toBe(true);
  });

  it("removes a recursive tree without an approval callback", async () => {
    write(root, "tree/skill/SKILL.md", "selected");
    const result = await callTool("remove", { path: "tree", recursive: true }, config);
    expect(result.isError).toBe(false);
    expect(exists(root, "tree")).toBe(false);
  });

  it("deletes a symlink entry without changing its destination", async () => {
    write(root, "real.txt", "x");
    makeSymlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
    const r = await callTool("remove", { path: "link.txt" }, config);
    expect(r.isError).toBe(false);
    expect(exists(root, "real.txt")).toBe(true);
    expect(exists(root, "link.txt")).toBe(false);
  });

  it("recursive cleanup refuses a symlink entry even when its target is a directory", async () => {
    write(root, "real/a.txt", "x");
    makeSymlink(path.join(root, "real"), path.join(root, "link"));
    const result = await callTool("remove", { path: "link", recursive: true }, config);
    expect(result.json.error).toBe("invalid_input");
    expect(exists(root, "link")).toBe(true);
    expect(exists(root, "real/a.txt")).toBe(true);
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

  it("reports a missing parent-relative path using the OS error", async () => {
    const r = await callTool("remove", { path: "../a.txt" }, config);
    expect(r.json.error).toBe("not_found");
  });

  it("ignores out-of-schema extra fields", async () => {
    write(root, "a.txt", "x");
    const r = await callTool("remove", { path: "a.txt", bogus: true }, config);
    expect(r.isError).toBe(false);
    expect(exists(root, "a.txt")).toBe(false);
  });
});
