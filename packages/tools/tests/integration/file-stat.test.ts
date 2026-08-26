import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync, promises as fs, renameSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  writeBinary,
  writePng,
  chmod,
  modeBitsEnforced,
  makeSymlink,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("file_stat", () => {
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

  it("reports a regular text file: type, size, mode, not binary, no mime", async () => {
    write(root, "a.txt", "hello");
    const r = await callTool("file_stat", { path: "a.txt" }, config);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      path: "a.txt",
      type: "file",
      size: 5,
      binary: false,
      mime: null,
    });
    expect(r.json.mode).toMatch(/^0[0-7]{3}$/);
    expect(typeof r.json.mtime).toBe("string");
  });

  it("flags a binary file", async () => {
    writeBinary(root, "a.bin");
    const r = await callTool("file_stat", { path: "a.bin" }, config);
    expect(r.json.binary).toBe(true);
  });

  it("detects an image MIME from magic bytes", async () => {
    writePng(root, "img.png");
    const r = await callTool("file_stat", { path: "img.png" }, config);
    expect(r.json).toMatchObject({ type: "file", mime: "image/png", binary: true });
  });

  it("reports a directory", async () => {
    mkdirSync(path.join(root, "d"));
    const r = await callTool("file_stat", { path: "d" }, config);
    expect(r.json).toMatchObject({ type: "directory" });
  });

  it("reports the descriptor type when a regular pathname changes during open", async () => {
    write(root, "raced.txt", "original");
    const openedStat = (kind: "directory" | "other") => ({
      size: 17,
      mode: 0o40755,
      mtime: new Date("2026-01-01T00:00:00.000Z"),
      isDirectory: () => kind === "directory",
      isFile: () => false,
    });
    const handle = (kind: "directory" | "other") => ({
      stat: () => Promise.resolve(openedStat(kind)),
      close: () => Promise.resolve(),
    });
    vi.spyOn(fs, "open")
      .mockResolvedValueOnce(handle("directory") as never)
      .mockResolvedValueOnce(handle("other") as never);

    expect((await callTool("file_stat", { path: "raced.txt" }, config)).json).toMatchObject({
      type: "directory",
      size: 17,
    });
    expect((await callTool("file_stat", { path: "raced.txt" }, config)).json).toMatchObject({
      type: "other",
      size: 17,
    });
  });

  it("reports a symlink without following it, including its target", async () => {
    write(root, "real.txt", "x");
    makeSymlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
    const r = await callTool("file_stat", { path: "link.txt" }, config);
    expect(r.json.type).toBe("symlink");
    expect(String(r.json.symlink_target)).toContain("real.txt");

    vi.spyOn(fs, "readlink").mockRejectedValueOnce(new Error("link vanished"));
    const raced = await callTool("file_stat", { path: "link.txt" }, config);
    expect(raced.json).toMatchObject({ type: "symlink", symlink_target: null });
  });

  it("works on a file larger than maxFileBytes (heads only, no too_large)", async () => {
    const small = makeConfig(root, { maxFileBytes: 1024 });
    writeFileSync(path.join(root, "big.txt"), "a".repeat(4096));
    const r = await callTool("file_stat", { path: "big.txt" }, small);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ type: "file", size: 4096, binary: false });
  });

  it("reports metadata and content from the same opened file after a pathname race", async () => {
    const target = path.join(root, "raced.txt");
    const replacement = path.join(root, "replacement.txt");
    writeFileSync(target, "old");
    writeFileSync(replacement, "replacement");
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
      renameSync(replacement, target);
      return originalOpen(file, flags, mode);
    });

    const r = await callTool("file_stat", { path: "raced.txt" }, config);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ type: "file", size: 11, binary: false });
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when a regular pathname becomes a symlink before open",
    async () => {
      const target = path.join(root, "raced.txt");
      const replacement = path.join(root, "replacement.txt");
      writeFileSync(target, "old");
      writeFileSync(replacement, "replacement");
      const originalOpen = fs.open;
      vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
        unlinkSync(target);
        makeSymlink(replacement, target);
        return originalOpen(file, flags, mode);
      });

      const r = await callTool("file_stat", { path: "raced.txt" }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("io_error");
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports a non-regular file (socket) as type other",
    async () => {
      const sock = path.join(root, "s.sock");
      const server = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(sock, () => {
            server.off("error", reject);
            resolve();
          });
        });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "EPERM" || code === "EACCES") {
          return;
        }
        throw error;
      }
      try {
        const r = await callTool("file_stat", { path: "s.sock" }, config);
        expect(r.json.type).toBe("other");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("errors not_found for a missing path", async () => {
    const r = await callTool("file_stat", { path: "nope" }, config);
    expect(r.json.error).toBe("not_found");
  });

  it.skipIf(!modeBitsEnforced)("reports io_error when the file is unreadable", async () => {
    write(root, "secret.txt", "x");
    chmod(root, "secret.txt", 0o000);
    try {
      const r = await callTool("file_stat", { path: "secret.txt" }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("io_error");
    } finally {
      chmod(root, "secret.txt", 0o644);
    }
  });

  it("rejects a path escaping the workspace with path_escape", async () => {
    const r = await callTool("file_stat", { path: "../x" }, config);
    expect(r.json.error).toBe("path_escape");
  });

  it("ignores out-of-schema extra fields", async () => {
    write(root, "a", "x");
    const r = await callTool("file_stat", { path: "a", bogus: true }, config);
    expect(r.isError).toBe(false);
    expect(r.json.type).toBe("file");
  });
});
