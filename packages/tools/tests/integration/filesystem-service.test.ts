import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createAgentTools } from "../../src/index.ts";
import { probeSandbox } from "../../src/sandbox.ts";
import { resolveConfig } from "../../src/config.ts";
import { SandboxAgentFilesystem } from "../../src/filesystem-service.ts";
import { isAlive } from "../../src/lib/process-owner.ts";
import { resultText, writePng } from "../helpers/fixtures.ts";

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "native file calls execute in the run-owned Sandbox service under shell's write policy",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-service-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const scratch = join(root, "scratch");
    mkdirSync(workspace);
    mkdirSync(outside);
    mkdirSync(scratch);
    const marker = join(outside, "marker.txt");
    const denied = join(outside, "denied.txt");
    writeFileSync(marker, "outside\n");
    const tools = createAgentTools({
      workspaceRoot: workspace,
      temporaryRoots: [scratch],
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
    });
    try {
      const read = await tools.callTool("read_file", { path: marker });
      expect(read.isError).toBe(false);
      expect(read.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("outside"),
      });

      const refused = await tools.callTool("write_file", { path: denied, content: "escape" });
      expect(refused.isError).toBe(true);
      expect(existsSync(denied)).toBe(false);

      const written = await tools.callTool("write_file", { path: "inside.txt", content: "inside" });
      expect(written.isError).toBe(false);
      expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toBe("inside");

      const link = join(workspace, "external-link");
      symlinkSync(marker, link);
      const removed = await tools.callTool("remove", { path: link });
      expect(removed.isError).toBe(false);
      expect(existsSync(link)).toBe(false);
      expect(readFileSync(marker, "utf8")).toBe("outside\n");
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(
  process.platform !== "linux" ||
    probeSandbox().mode === "unavailable" ||
    statSync(process.cwd()).dev === statSync(tmpdir()).dev,
)("native move stages across filesystems and preserves overwrite", async () => {
  const workspace = mkdtempSync(join(process.cwd(), ".clarvis-cross-move-"));
  const destinationRoot = mkdtempSync(join(tmpdir(), "clarvis-cross-move-"));
  const destination = join(destinationRoot, "target.txt");
  writeFileSync(join(workspace, "source.txt"), "first");
  writeFileSync(destination, "previous");
  const tools = createAgentTools({
    workspaceRoot: workspace,
    temporaryRoots: [destinationRoot],
    sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
  });
  try {
    const result = await tools.callTool("move", {
      source: "source.txt",
      destination,
      overwrite: true,
    });
    expect(result.isError, resultText(result.content)).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe("first");
    expect(existsSync(join(workspace, "source.txt"))).toBe(false);
  } finally {
    await tools.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(destinationRoot, { recursive: true, force: true });
  }
});

test("an unavailable native backend cannot start the file service or fall back to host I/O", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-file-backend-unavailable-"));
  try {
    const config = resolveConfig({ workspaceRoot: root, sandbox: { type: "native" } });
    const filesystem = new SandboxAgentFilesystem(config, () => ({
      backend: "bubblewrap",
      mode: "unavailable",
      reason: "fixture backend unavailable",
    }));
    await expect(
      filesystem.execute({ operation: "read_file", args: { path: "missing.txt" } }, config),
    ).rejects.toThrow("fixture backend unavailable");
    expect(await filesystem.close(Date.now() + 1_200)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "closing the run confirms the file service's physical process has exited",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-service-close-"));
    const tools = createAgentTools({ workspaceRoot: root, sandbox: { type: "native" } });
    try {
      await tools.callTool("list_dir", { path: "." });
      const service = tools.config.sessionManager.acquireFilesystem(
        tools.config.filesystemPolicy.identity,
        () => {
          throw new Error("a second filesystem service must not be created");
        },
      ) as SandboxAgentFilesystem;
      const pid = (service as unknown as { child?: { pid?: number } }).child?.pid;
      expect(pid).toBeNumber();
      await tools.close();
      expect(isAlive(pid!)).toBe(false);
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a lost parent-to-child channel fails the next file call closed",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-service-channel-"));
    const config = resolveConfig({ workspaceRoot: root, sandbox: { type: "native" } });
    const service = new SandboxAgentFilesystem(config);
    try {
      await service.execute({ operation: "list_dir", args: { path: "." } }, config);
      const child = (service as unknown as { child?: { stdin?: { destroy(): void } } }).child;
      expect(child?.stdin).toBeDefined();
      child!.stdin!.destroy();
      await expect(
        service.execute({ operation: "list_dir", args: { path: "." } }, config),
      ).rejects.toThrow();
      expect(await service.close(Date.now() + 1_200)).toBe(true);
    } finally {
      await service.close(Date.now() + 1_200);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a lost child-to-parent channel fails pending file calls closed",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-service-response-"));
    const config = resolveConfig({ workspaceRoot: root, sandbox: { type: "native" } });
    const service = new SandboxAgentFilesystem(config);
    try {
      await service.execute({ operation: "list_dir", args: { path: "." } }, config);
      const child = (service as unknown as { child?: { stdout?: { destroy(error: Error): void } } })
        .child;
      expect(child?.stdout).toBeDefined();
      child!.stdout!.destroy(new Error("response channel lost"));
      await expect(
        service.execute({ operation: "list_dir", args: { path: "." } }, config),
      ).rejects.toThrow();
      expect(await service.close(Date.now() + 1_200)).toBe(true);
    } finally {
      await service.close(Date.now() + 1_200);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "closing during the file-service handshake rejects the waiting call and reaps the child",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-service-boot-close-"));
    const config = resolveConfig({ workspaceRoot: root, sandbox: { type: "native" } });
    const service = new SandboxAgentFilesystem(config);
    try {
      const call = service.execute({ operation: "list_dir", args: { path: "." } }, config);
      const refused = call.then(
        () => false,
        () => true,
      );
      const pid = (service as unknown as { child?: { pid?: number } }).child?.pid;
      expect(pid).toBeNumber();
      expect(await service.close(Date.now() + 1_200)).toBe(true);
      expect(await refused).toBe(true);
      expect(isAlive(pid!)).toBe(false);
    } finally {
      await service.close(Date.now() + 1_200);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "every read and discovery family observes the same external Sandbox read scope",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-read-scope-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const scratch = join(root, "scratch");
    mkdirSync(workspace);
    mkdirSync(outside);
    mkdirSync(scratch);
    const external = join(outside, "external.txt");
    writeFileSync(external, "outside text\n");
    writeFileSync(join(workspace, "inside.txt"), "inside text\n");
    const image = writePng(outside, "external.png");
    const tools = createAgentTools({
      workspaceRoot: workspace,
      temporaryRoots: [scratch],
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
    });
    try {
      const cases = [
        ["read_file", { path: external }],
        ["read_files", { paths: [external] }],
        ["read_image", { path: image }],
        ["file_stat", { path: external }],
        ["list_dir", { path: outside }],
        ["glob", { path: outside, pattern: "*.txt" }],
        ["grep", { path: outside, pattern: "outside" }],
        ["tree", { path: outside }],
        ["diff", { from: external, to: join(workspace, "inside.txt") }],
      ] as const;
      for (const [name, args] of cases) {
        const result = await tools.callTool(name, args);
        expect(result.isError).toBe(false);
        expect(result.content.length).toBeGreaterThan(0);
      }
      const shell = await tools.callTool("shell", { command: `cat '${external}'` });
      expect(shell.isError).toBe(false);
      expect(JSON.stringify(shell.content)).toContain("outside text");
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "every native mutation family is physically denied outside Sandbox write roots",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-write-scope-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const scratch = join(root, "scratch");
    mkdirSync(workspace);
    mkdirSync(outside);
    mkdirSync(scratch);
    const external = join(outside, "external.txt");
    const inside = join(workspace, "inside.txt");
    writeFileSync(external, "outside text\n");
    writeFileSync(inside, "inside text\n");
    const tools = createAgentTools({
      workspaceRoot: workspace,
      temporaryRoots: [scratch],
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
    });
    try {
      const cases = [
        ["write_file", { path: external, content: "changed" }],
        ["edit_file", { path: external, old_string: "outside", new_string: "changed" }],
        [
          "multi_edit",
          { path: external, edits: [{ old_string: "outside", new_string: "changed" }] },
        ],
        [
          "apply_patch",
          {
            patch: `*** Begin Patch\n*** Update File: ${external}\n@@\n-outside text\n+changed text\n*** End Patch`,
          },
        ],
        [
          "replace",
          {
            path: outside,
            glob: "*.txt",
            pattern: "outside",
            replacement: "changed",
            dry_run: false,
          },
        ],
        ["copy", { source: inside, destination: join(outside, "copy.txt") }],
        ["move", { source: inside, destination: join(outside, "move.txt") }],
        ["mkdir", { path: join(outside, "newdir") }],
        ["remove", { path: external }],
      ] as const;
      for (const [name, args] of cases) {
        const result = await tools.callTool(name, args);
        expect(result.isError).toBe(true);
        expect(readFileSync(external, "utf8")).toBe("outside text\n");
        expect(readFileSync(inside, "utf8")).toBe("inside text\n");
      }
      expect(existsSync(join(outside, "copy.txt"))).toBe(false);
      expect(existsSync(join(outside, "move.txt"))).toBe(false);
      expect(existsSync(join(outside, "newdir"))).toBe(false);
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a temp-contained read-only workspace stays protected for file tools and shell",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-nested-temp-"));
    const temporary = join(root, "temporary");
    const workspace = join(temporary, "workspace");
    const external = join(root, "outside.txt");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(external, "external\n");
    writeFileSync(join(workspace, "original.txt"), "original\n");
    const tools = createAgentTools({
      workspaceRoot: workspace,
      temporaryRoots: [temporary],
      sandbox: { type: "native", filesystem: "workspace-read-only", network: "none" },
    });
    try {
      const read = await tools.callTool("read_file", { path: external });
      expect(read.isError).toBe(false);
      const denied = await tools.callTool("write_file", {
        path: "original.txt",
        content: "changed",
      });
      expect(denied.isError).toBe(true);
      expect(readFileSync(join(workspace, "original.txt"), "utf8")).toBe("original\n");
      const allowed = await tools.callTool("write_file", {
        path: join(temporary, "allowed.txt"),
        content: "temporary",
      });
      expect(allowed.isError).toBe(false);
      expect(readFileSync(join(temporary, "allowed.txt"), "utf8")).toBe("temporary");
      const shell = await tools.callTool("shell", {
        command: "if printf denied > original.txt 2>/dev/null; then exit 63; fi",
      });
      expect(shell.isError).toBe(false);
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
