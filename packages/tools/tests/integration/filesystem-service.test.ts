import {
  chmodSync,
  existsSync,
  linkSync,
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
import { configurationRoots } from "@clarvis/paths";
import { createAgentTools } from "../../src/index.ts";
import { applyOpsAtomic, type MutationReview } from "../../src/lib/atomic.ts";
import { ToolError } from "../../src/errors.ts";
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

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "worker and host preserve typed prepare, review and commit failures",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-failures-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const tools = createAgentTools({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async (_operations, commit) => commit(),
    });
    try {
      const missing = await tools.callTool("read_file", { path: "missing.txt" });
      expect(JSON.parse(resultText(missing.content))).toMatchObject({
        error: "not_found",
        phase: "execute",
        operation: "read_file",
      });
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "outside");
      symlinkSync(outside, join(workspace, "linked.txt"));
      const refused = await tools.callTool("write_file", {
        path: "linked.txt",
        content: "changed",
      });
      expect(JSON.parse(resultText(refused.content))).toMatchObject({
        error: "invalid_input",
        phase: "commit",
        operation: "write_file",
        path_role: "target",
      });
      expect(readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a technical reviewer failure crosses the native worker channel without becoming internal",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-review-failed-"));
    const tools = createAgentTools({
      workspaceRoot: root,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async () => {
        throw new ToolError("review_failed", "Automatic configuration review failed", {
          failure_kind: "invalid_response",
        });
      },
    });
    try {
      const result = await tools.callTool("write_file", { path: "target.txt", content: "data" });
      expect(JSON.parse(resultText(result.content))).toMatchObject({
        error: "review_failed",
        phase: "review",
        failure_kind: "invalid_response",
      });
      expect(existsSync(join(root, "target.txt"))).toBe(false);
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
  let blockSourceRemoval = false;
  const tools = createAgentTools({
    workspaceRoot: workspace,
    temporaryRoots: [destinationRoot],
    sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
    reviewMutation: async (_operations, commit) => {
      if (blockSourceRemoval) chmodSync(workspace, 0o500);
      await commit();
    },
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
    writeFileSync(join(workspace, "second.txt"), "second");
    const secondDestination = join(destinationRoot, "second.txt");
    blockSourceRemoval = true;
    const partial = await tools.callTool("move", {
      source: "second.txt",
      destination: secondDestination,
    });
    expect(JSON.parse(resultText(partial.content))).toMatchObject({
      error: "commit_partial",
      source_exists: true,
      destination_committed: true,
    });
    expect(readFileSync(join(workspace, "second.txt"), "utf8")).toBe("second");
    expect(readFileSync(secondDestination, "utf8")).toBe("second");
  } finally {
    await tools.close();
    chmodSync(workspace, 0o700);
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

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "the host reviews prepared file bytes before the Sandbox child commits them",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-review-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "reviewed.txt");
    const reviewed: string[] = [];
    const tools = createAgentTools({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async (operations, commit) => {
        expect(existsSync(target)).toBe(false);
        reviewed.push(operations[0]?.content ?? "");
        await commit();
      },
    });
    try {
      const outcome = await tools.callTool("write_file", {
        path: "reviewed.txt",
        content: "fixed",
      });
      expect(outcome.isError).toBe(false);
      expect(reviewed).toEqual(["fixed"]);
      expect(readFileSync(target, "utf8")).toBe("fixed");
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "native recursive cleanup previews its bounded tree before worker commit",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-tree-review-"));
    const workspace = join(root, "workspace");
    const target = join(workspace, "probe");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "a.txt"), "probe");
    let reviewed = false;
    const tools = createAgentTools({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async (operations, commit) => {
        expect(operations).toMatchObject([
          {
            type: "rmtree",
            path: target,
            treeEntries: [".", "a.txt"],
          },
        ]);
        expect(existsSync(join(target, "a.txt"))).toBe(true);
        reviewed = true;
        await commit();
      },
    });
    try {
      const result = await tools.callTool("remove", { path: "probe", recursive: true });
      expect(result.isError, resultText(result.content)).toBe(false);
      expect(reviewed).toBe(true);
      expect(existsSync(target)).toBe(false);
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a classified configuration batch commits through the host reviewer",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-classified-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const roots = configurationRoots({
      workspaceRoot: workspace,
      globalDir: join(root, "global"),
      home: join(root, "home"),
    });
    const target = join(roots.workspace_clarvis, "agents", "reviewer.md");
    let hostCommits = 0;
    const review: MutationReview = Object.assign(
      async (_operations: Parameters<MutationReview>[0], commit: () => Promise<void>) => {
        expect(existsSync(target)).toBe(false);
        await commit();
      },
      {
        async commitClassified(operations: Parameters<MutationReview>[0]) {
          hostCommits++;
          await applyOpsAtomic([...operations]);
        },
      },
    );
    const tools = createAgentTools({
      workspaceRoot: workspace,
      configurationRoots: roots,
      reviewMutation: review,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
    });
    try {
      const result = await tools.callTool("write_file", { path: target, content: "reviewed" });
      expect(result.isError).toBe(false);
      expect(hostCommits).toBe(1);
      expect(readFileSync(target, "utf8")).toBe("reviewed");
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a mixed configuration batch cannot route an external write through the host",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-classified-mixed-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const roots = configurationRoots({
      workspaceRoot: workspace,
      globalDir: join(root, "global"),
      home: join(root, "home"),
    });
    const target = join(roots.workspace_clarvis, "agents", "reviewer.md");
    const outside = join(root, "outside.txt");
    const review: MutationReview = Object.assign(
      async (_operations: Parameters<MutationReview>[0], commit: () => Promise<void>) => commit(),
      {
        async commitClassified(operations: Parameters<MutationReview>[0]) {
          await applyOpsAtomic([...operations]);
        },
      },
    );
    const tools = createAgentTools({
      workspaceRoot: workspace,
      configurationRoots: roots,
      reviewMutation: review,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
    });
    try {
      const patch = `*** Begin Patch\n*** Add File: ${target}\n+reviewed\n*** Add File: ${outside}\n+escaped\n*** End Patch`;
      const result = await tools.callTool("apply_patch", { patch });
      expect(result.isError).toBe(true);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(outside)).toBe(false);
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a refused prepared mutation leaves its target untouched",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-review-denial-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const tools = createAgentTools({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async () => {
        throw new ToolError("denied", "review refused");
      },
    });
    try {
      const outcome = await tools.callTool("write_file", {
        path: "denied.txt",
        content: "blocked",
      });
      expect(outcome.isError).toBe(true);
      expect(existsSync(join(workspace, "denied.txt"))).toBe(false);
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a reviewer that returns without committing refuses the prepared mutation",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-review-no-commit-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const tools = createAgentTools({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async () => undefined,
    });
    try {
      const result = await tools.callTool("write_file", { path: "target.txt", content: "blocked" });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("not committed by review");
      expect(existsSync(join(workspace, "target.txt"))).toBe(false);
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a target changed to a symlink during review cannot redirect the commit",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-review-link-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    const target = join(workspace, "target.txt");
    const tools = createAgentTools({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async (_operations, commit) => {
        symlinkSync(outside, target);
        await commit();
      },
    });
    try {
      const result = await tools.callTool("write_file", { path: target, content: "changed" });
      expect(result.isError).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "an existing hard link does not let a reviewed commit change the external inode",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-review-hardlink-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const outside = join(root, "outside.txt");
    const target = join(workspace, "target.txt");
    writeFileSync(outside, "outside");
    linkSync(outside, target);
    const tools = createAgentTools({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async (_operations, commit) => commit(),
    });
    try {
      const result = await tools.callTool("write_file", { path: target, content: "changed" });
      expect(result.isError).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("changed");
      expect(readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      await tools.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a cancelled review cannot commit after the physical service has stopped",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-review-cancel-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    let prepared!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const config = resolveConfig({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async (_operations, commit) => {
        prepared();
        await wait;
        await commit();
      },
    });
    const service = new SandboxAgentFilesystem(config);
    const controller = new AbortController();
    try {
      const result = service.execute(
        { operation: "write_file", args: { path: "late.txt", content: "late" } },
        config,
        controller.signal,
      );
      await seen;
      controller.abort();
      await expect(result).rejects.toThrow();
      release();
      expect(await service.close(Date.now() + 1_200)).toBe(true);
      expect(existsSync(join(workspace, "late.txt"))).toBe(false);
    } finally {
      release?.();
      await service.close(Date.now() + 1_200);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a child death during review closes the channel and refuses a late host commit",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-review-death-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    let prepared!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const config = resolveConfig({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async (_operations, commit) => {
        prepared();
        await wait;
        await commit();
      },
    });
    const service = new SandboxAgentFilesystem(config);
    try {
      const result = service.execute(
        { operation: "write_file", args: { path: "late.txt", content: "late" } },
        config,
      );
      await seen;
      const pid = (service as unknown as { child?: { pid?: number } }).child?.pid;
      expect(pid).toBeNumber();
      process.kill(pid!, "SIGKILL");
      await expect(result).rejects.toThrow();
      release();
      expect(await service.close(Date.now() + 1_200)).toBe(true);
      expect(existsSync(join(workspace, "late.txt"))).toBe(false);
    } finally {
      release?.();
      await service.close(Date.now() + 1_200);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "a file-service call timeout stops the child and refuses a late commit",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-file-review-timeout-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    let prepared!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const config = resolveConfig({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      reviewMutation: async (_operations, commit) => {
        prepared();
        await wait;
        await commit();
      },
    });
    const service = new SandboxAgentFilesystem(config, probeSandbox, 500);
    try {
      const result = service.execute(
        { operation: "write_file", args: { path: "late.txt", content: "late" } },
        config,
      );
      await seen;
      await expect(result).rejects.toThrow("timed out");
      release();
      expect(await service.close(Date.now() + 1_200)).toBe(true);
      expect(existsSync(join(workspace, "late.txt"))).toBe(false);
    } finally {
      release?.();
      await service.close(Date.now() + 1_200);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
