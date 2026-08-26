import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
  promises as fs,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  read,
  makeSymlink,
  canSymlink,
  lines,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("workspace confinement (default) and opt-out", () => {
  let root: string;
  let outside: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    outside = mkdtempSync(path.join(tmpdir(), "clarvis-outside-"));
    config = makeConfig(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(root);
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects an absolute path outside the workspace root with path_escape", async () => {
    const target = path.join(outside, "external.txt");
    writeFileSync(target, "external content\n");
    const r = await callTool("read_file", { path: target }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("path_escape");
  });

  it("rejects a .. path above the workspace root with path_escape", async () => {
    writeFileSync(path.join(outside, "up.txt"), "up\n");
    const rel = path.relative(root, path.join(outside, "up.txt"));
    const r = await callTool("read_file", { path: rel }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("path_escape");
  });

  it("reads an absolute path outside the workspace root when confinement is disabled", async () => {
    const target = path.join(outside, "external.txt");
    writeFileSync(target, "external content\n");
    const r = await callTool(
      "read_file",
      { path: target },
      makeConfig(root, { confineToWorkspace: false }),
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("external content");
  });

  it.skipIf(!canSymlink)("rejects a symlink inside the workspace that points outside", async () => {
    const secret = path.join(outside, "secret.txt");
    writeFileSync(secret, "secret\n");
    makeSymlink(secret, path.join(root, "leak"), "file");
    const r2 = await callTool("read_file", { path: "leak" }, config);
    expect(r2.isError).toBe(true);
    expect(r2.json.error).toBe("path_escape");
  });

  it("rejects read_file when a checked parent becomes an outside link before open", async () => {
    const targetDir = path.join(root, "scope");
    const parkedDir = path.join(root, "parked-scope");
    write(root, "scope/raced.txt", "workspace content\n");
    writeFileSync(path.join(outside, "raced.txt"), "outside secret\n");

    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
      renameSync(targetDir, parkedDir);
      makeSymlink(outside, targetDir, "dir");
      return originalOpen(file, flags, mode);
    });

    const result = await callTool("read_file", { path: "scope/raced.txt" }, config);

    expect(result.isError).toBe(true);
    expect(result.json.error).toBe("path_escape");
    expect(result.text).not.toContain("outside secret");
  });

  it("rejects grep when a checked parent becomes an outside link before open", async () => {
    const targetDir = path.join(root, "scope");
    const parkedDir = path.join(root, "parked-scope");
    write(root, "scope/raced.txt", "workspace content\n");
    writeFileSync(path.join(outside, "raced.txt"), "outside needle\n");

    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
      renameSync(targetDir, parkedDir);
      makeSymlink(outside, targetDir, "dir");
      return originalOpen(file, flags, mode);
    });

    const result = await callTool(
      "grep",
      { pattern: "needle", path: "scope/raced.txt", output_mode: "content" },
      config,
    );

    expect(result.isError).toBe(true);
    expect(result.json.error).toBe("path_escape");
    expect(result.text).not.toContain("outside needle");
  });

  it("keeps a confined directory grep in process when the directory is replaced", async () => {
    const targetDir = path.join(root, "scope");
    const parkedDir = path.join(root, "parked-scope");
    write(root, "scope/safe.txt", "workspace content\n");
    writeFileSync(path.join(outside, "raced.txt"), "outside needle\n");

    const originalStat = fs.stat;
    const raceStat = async (target: Parameters<typeof originalStat>[0]) => {
      const stat = await originalStat(target);
      renameSync(targetDir, parkedDir);
      makeSymlink(outside, targetDir, "dir");
      return stat;
    };
    vi.spyOn(fs, "stat").mockImplementationOnce(raceStat as unknown as typeof fs.stat);

    const result = await callTool(
      "grep",
      { pattern: "needle", path: "scope", output_mode: "content" },
      makeConfig(root, { ripgrepAvailable: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.json.error).toBe("path_escape");
    expect(result.text).not.toContain("outside needle");
  });

  it("aborts write_file when its prior read detects a parent-link race", async () => {
    const targetDir = path.join(root, "scope");
    const parkedDir = path.join(root, "parked-scope");
    write(root, "scope/raced.txt", "workspace content\n");
    writeFileSync(path.join(outside, "raced.txt"), "outside content\n");

    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
      renameSync(targetDir, parkedDir);
      makeSymlink(outside, targetDir, "dir");
      return originalOpen(file, flags, mode);
    });

    const result = await callTool(
      "write_file",
      { path: "scope/raced.txt", content: "replacement\n" },
      config,
    );

    expect(result.isError).toBe(true);
    expect(result.json.error).toBe("path_escape");
    expect(read(root, "parked-scope/raced.txt")).toBe("workspace content\n");
    expect(readFileSync(path.join(outside, "raced.txt"), "utf8")).toBe("outside content\n");
  });

  it("runs an arbitrary shell command (no command filtering)", async () => {
    const r = await callTool("shell", { command: "echo unconfined" }, config);
    expect(r.json.exit_code).toBe(0);
    expect(lines(r.json.stdout)).toBe("unconfined\n");
  });
});
