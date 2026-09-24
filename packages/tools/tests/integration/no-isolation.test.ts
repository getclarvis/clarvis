import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, promises as fs, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  makeSymlink,
  canSymlink,
  lines,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("Host file tools use OS filesystem authority", () => {
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

  it("reads an absolute file outside the workspace", async () => {
    const target = path.join(outside, "external.txt");
    writeFileSync(target, "external content\n");
    const result = await callTool("read_file", { path: target }, config);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("external content");
  });

  it("resolves .. from the workspace without imposing a boundary", async () => {
    const target = path.join(outside, "up.txt");
    writeFileSync(target, "up\n");
    const result = await callTool("read_file", { path: path.relative(root, target) }, config);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("up");
  });

  it.skipIf(!canSymlink)(
    "reads an ordinary external file through a workspace symlink",
    async () => {
      const target = path.join(outside, "ordinary.txt");
      writeFileSync(target, "linked content\n");
      makeSymlink(target, path.join(root, "linked"), "file");
      const result = await callTool("read_file", { path: "linked" }, config);
      expect(result.isError).toBe(false);
      expect(result.text).toContain("linked content");
    },
  );

  it.skipIf(!canSymlink)(
    "rejects a classified read redirected to private configuration during open",
    async () => {
      write(root, ".clarvis/agents/agent.md", "public agent\n");
      write(root, ".clarvis/keys/agent.md", "private credential\n");
      const agents = path.join(root, ".clarvis", "agents");
      const parked = path.join(root, ".clarvis", "agents-parked");
      const originalOpen = fs.open;
      vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
        renameSync(agents, parked);
        makeSymlink(path.join(root, ".clarvis", "keys"), agents, "dir");
        return originalOpen(file, flags, mode);
      });
      const result = await callTool("read_file", { path: ".clarvis/agents/agent.md" }, config);
      expect(result.isError).toBe(true);
      expect(result.json.error).toBe("path_escape");
      expect(result.text).not.toContain("private credential");
    },
  );

  it.skipIf(!canSymlink)("rejects a configuration root replaced during open", async () => {
    write(root, ".clarvis/agents/agent.md", "public agent\n");
    write(outside, "agents/agent.md", "external secret\n");
    const configRoot = path.join(root, ".clarvis");
    const parked = path.join(root, ".clarvis-parked");
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
      renameSync(configRoot, parked);
      makeSymlink(outside, configRoot, "dir");
      return originalOpen(file, flags, mode);
    });
    const result = await callTool("read_file", { path: ".clarvis/agents/agent.md" }, config);
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe("path_escape");
    expect(result.text).not.toContain("external secret");
  });

  it("runs a shell command under the same Host placement", async () => {
    const result = await callTool("shell", { command: "echo host" }, config);
    expect(result.json.exit_code).toBe(0);
    expect(lines(result.json.stdout)).toBe("host\n");
  });
});
