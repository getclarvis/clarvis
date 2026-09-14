import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerGuestPaths } from "@clarvis/paths";
import {
  inspectReservedWorkspacePath,
  prepareContainerDomainMounts,
  prepareRuntimeMounts,
} from "../../src/runtime/container-mounts.ts";
import { containerGitDirectoryTarget } from "../../src/git-workspace.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "clarvis-runtime-mounts-test-"));
  temporary.push(value);
  return value;
}

function input(
  workspaceRoot: string,
  options: {
    kind?: "primary" | "external_worktree";
    gitDir?: string;
    gitCommonDir?: string;
  } = {},
): Parameters<typeof prepareRuntimeMounts>[0] {
  return {
    generation: "mount-test",
    ownerId: "owner",
    project: { id: "project" },
    workspace: {
      id: "workspace",
      projectId: "project",
      label: "fixture",
      kind: options.kind ?? "primary",
    },
    workspaceRoot,
    gitMetadataMounts:
      options.gitDir === undefined || options.gitCommonDir === undefined
        ? []
        : options.kind === "external_worktree"
          ? [
              {
                source: join(workspaceRoot, ".git"),
                target: "/workspace/.git",
                type: "file",
                readOnly: true,
              },
              ...(options.gitCommonDir === options.gitDir
                ? []
                : [
                    {
                      source: options.gitCommonDir,
                      target: containerGuestPaths.gitCommonRoot,
                      type: "directory" as const,
                      readOnly: true as const,
                    },
                  ]),
              {
                source: options.gitDir,
                target:
                  options.gitDir === options.gitCommonDir
                    ? `${containerGuestPaths.gitCommonRoot}/worktrees/invalid`
                    : containerGitDirectoryTarget(options.gitDir, options.gitCommonDir),
                type: "directory",
                readOnly: true,
              },
            ]
          : [
              {
                source: options.gitDir,
                target: "/workspace/.git",
                type: "directory",
                readOnly: true,
              },
            ],
    deps: {} as never,
    settings: {
      backend: "podman",
      image_digest: `sha256:${"a".repeat(64)}`,
      network: "none",
      executable: "/usr/bin/podman",
      connection: "local",
      limits: {
        cpu_count: 1,
        memory_bytes: 1024,
        process_count: 8,
        output_bytes: 1024,
        storage_bytes: 2048,
      },
    },
  };
}

describe("prepareRuntimeMounts", () => {
  test("maps every durable native domain store to its canonical host directory", async () => {
    const fixture = await root();
    const workspace = join(fixture, "workspace");
    const globalDir = join(fixture, "global");
    await Promise.all([mkdir(workspace), mkdir(globalDir)]);
    const mounts = await prepareContainerDomainMounts({
      workspaceRoot: workspace,
      globalDir,
      owner: "owner",
      projectId: "project",
      workspaceId: "workspace",
    });
    expect(mounts).toHaveLength(8);
    expect(mounts.map((mount) => mount.target)).toEqual([
      "/workspace/.clarvis/plans",
      "/workspace/.clarvis/memory",
      expect.stringMatching(/^\/var\/lib\/clarvis\/state\/workspaces\/.+\/plans$/),
      expect.stringMatching(/^\/var\/lib\/clarvis\/state\/workspaces\/.+\/memory$/),
      expect.stringMatching(/^\/var\/lib\/clarvis\/state\/traces\/.+$/),
      expect.stringMatching(/^\/var\/lib\/clarvis\/state\/workspaces\/.+\/trace-locks$/),
      expect.stringMatching(/^\/var\/lib\/clarvis\/state\/sessions\/.+$/),
      expect.stringMatching(/^\/var\/lib\/clarvis\/state\/workflows\/.+$/),
    ]);
    for (const mount of mounts) {
      expect(mount.readOnly).toBe(false);
      expect(existsSync(mount.source)).toBe(true);
    }
  });

  test("refuses a symlink in canonical domain state", async () => {
    const fixture = await root();
    const workspace = join(fixture, "workspace");
    const globalDir = join(fixture, "global");
    const outside = join(fixture, "outside");
    await Promise.all([
      mkdir(join(workspace, ".clarvis"), { recursive: true }),
      mkdir(globalDir),
      mkdir(outside),
    ]);
    await symlink(outside, join(workspace, ".clarvis", "plans"));
    await expect(
      prepareContainerDomainMounts({
        workspaceRoot: workspace,
        globalDir,
        owner: "owner",
        projectId: "project",
        workspaceId: "workspace",
      }),
    ).rejects.toMatchObject({ code: "unsupported_policy" });
  });

  test("leaves .clarvis to the private content volume and masks .agents outside the workspace", async () => {
    const fixture = await root();
    const workspace = join(fixture, "workspace");
    await mkdir(join(workspace, ".clarvis", "future"), { recursive: true });
    await mkdir(join(workspace, ".agents", "future"), { recursive: true });
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".clarvis", "future", "sentinel"), "clarvis-secret");
    await writeFile(join(workspace, ".agents", "future", "sentinel"), "agents-secret");

    const prepared = await prepareRuntimeMounts(input(workspace));
    expect(prepared.controlRootMasks.map((mount) => mount.target)).toEqual(["/workspace/.agents"]);
    expect(prepared.gitMetadataMounts).toHaveLength(1);
    expect(prepared.gitMetadataMounts[0]).toMatchObject({
      target: "/workspace/.git",
      type: "directory",
      readOnly: true,
    });
    for (const mount of [...prepared.controlRootMasks, ...prepared.gitMetadataMounts]) {
      expect(mount.source.startsWith(workspace)).toBe(false);
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: mount.source }))).toEqual([]);
    }
    const privateRoot = join(prepared.controlRootMasks[0]!.source, "..");
    await prepared.cleanup();
    expect(existsSync(privateRoot)).toBe(false);
    expect(existsSync(join(workspace, ".clarvis", "future", "sentinel"))).toBe(true);
    expect(existsSync(join(workspace, ".agents", "future", "sentinel"))).toBe(true);
  });

  test("projects primary Git metadata once and linked metadata at all referenced paths", async () => {
    const fixture = await root();
    const primary = join(fixture, "primary");
    const primaryGit = join(primary, ".git");
    await mkdir(primaryGit, { recursive: true });
    await Promise.all([mkdir(join(primary, ".clarvis")), mkdir(join(primary, ".agents"))]);
    const primaryMounts = await prepareRuntimeMounts(
      input(primary, { gitDir: primaryGit, gitCommonDir: primaryGit }),
    );
    expect(primaryMounts.gitMetadataMounts).toEqual([
      { source: primaryGit, target: "/workspace/.git", type: "directory", readOnly: true },
    ]);
    await primaryMounts.cleanup();

    const linked = join(fixture, "linked");
    const common = join(fixture, "repository", ".git");
    const gitDir = join(common, "worktrees", "linked");
    await mkdir(linked, { recursive: true });
    await Promise.all([mkdir(join(linked, ".clarvis")), mkdir(join(linked, ".agents"))]);
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(linked, ".git"), `gitdir: ${gitDir}\n`);
    await writeFile(join(gitDir, "commondir"), "../..\n");
    const linkedMounts = await prepareRuntimeMounts(
      input(linked, { kind: "external_worktree", gitDir, gitCommonDir: common }),
    );
    expect(linkedMounts.gitMetadataMounts.slice(1)).toEqual([
      {
        source: common,
        target: containerGuestPaths.gitCommonRoot,
        type: "directory",
        readOnly: true,
      },
      {
        source: gitDir,
        target: `${containerGuestPaths.gitCommonRoot}/worktrees/linked`,
        type: "directory",
        readOnly: true,
      },
    ]);
    const projectedGitFile = linkedMounts.gitMetadataMounts[0]!;
    expect(projectedGitFile).toMatchObject({
      target: "/workspace/.git",
      type: "file",
      readOnly: true,
    });
    expect(projectedGitFile.source).not.toBe(join(linked, ".git"));
    expect(await readFile(projectedGitFile.source, "utf8")).toBe(
      `gitdir: ${containerGuestPaths.gitCommonRoot}/worktrees/linked\n`,
    );
    await linkedMounts.cleanup();
  });

  test("refuses symbolic control roots and incomplete Git discovery", async () => {
    const fixture = await root();
    const workspace = join(fixture, "workspace");
    const outside = join(fixture, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, join(workspace, ".agents"));
    await expect(
      inspectReservedWorkspacePath(join(workspace, ".agents"), workspace),
    ).rejects.toMatchObject({ code: "unsupported_policy" });
    await expect(prepareRuntimeMounts(input(workspace))).rejects.toMatchObject({
      code: "unsupported_policy",
    });
    await rm(join(workspace, ".agents"));
    await mkdir(join(workspace, ".git"));
    await expect(
      prepareRuntimeMounts(input(workspace, { gitDir: join(workspace, ".git") })),
    ).rejects.toMatchObject({ code: "unsupported_policy" });

    const forged = input(workspace, {
      gitDir: join(workspace, ".git"),
      gitCommonDir: join(workspace, ".git"),
    });
    await expect(
      prepareRuntimeMounts({
        ...forged,
        gitMetadataMounts: [
          {
            source: join(fixture, "outside"),
            target: "/workspace/.git",
            type: "directory",
            readOnly: true,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "unsupported_policy" });
  });

  test("fails closed for every invalid control-root and Git metadata topology", async () => {
    const fixture = await root();
    const outside = join(fixture, "outside");
    await mkdir(outside);
    await expect(inspectReservedWorkspacePath(fixture, fixture)).rejects.toMatchObject({
      code: "unsupported_policy",
    });

    const controlFile = join(fixture, "control-file");
    await mkdir(controlFile);
    await writeFile(join(controlFile, ".clarvis"), "not a directory");
    await expect(prepareRuntimeMounts(input(controlFile))).rejects.toMatchObject({
      code: "unsupported_policy",
    });
    await expect(
      inspectReservedWorkspacePath(join(controlFile, ".clarvis", "child"), controlFile),
    ).rejects.toMatchObject({ code: "unsupported_policy" });

    const undiscovered = join(fixture, "undiscovered");
    await mkdir(join(undiscovered, ".git"), { recursive: true });
    await writeFile(join(undiscovered, ".git", "HEAD"), "ref: refs/heads/main\n");
    await expect(prepareRuntimeMounts(input(undiscovered))).rejects.toMatchObject({
      code: "unsupported_policy",
    });

    const noMountTarget = join(fixture, "no-mount-target");
    await mkdir(noMountTarget);
    await expect(prepareRuntimeMounts(input(noMountTarget))).rejects.toMatchObject({
      code: "unsupported_policy",
    });

    const missing = join(fixture, "missing");
    await mkdir(missing);
    await expect(
      prepareRuntimeMounts(
        input(missing, { gitDir: join(missing, ".git"), gitCommonDir: join(missing, ".git") }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_policy" });

    const primaryFile = join(fixture, "primary-file");
    await mkdir(primaryFile);
    await writeFile(join(primaryFile, ".git"), "gitdir: elsewhere");
    await expect(
      prepareRuntimeMounts(
        input(primaryFile, {
          gitDir: join(primaryFile, ".git"),
          gitCommonDir: join(primaryFile, ".git"),
        }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_policy" });

    const linkedDirectory = join(fixture, "linked-directory");
    await mkdir(join(linkedDirectory, ".git"), { recursive: true });
    await expect(
      prepareRuntimeMounts(
        input(linkedDirectory, {
          kind: "external_worktree",
          gitDir: join(linkedDirectory, ".git"),
          gitCommonDir: join(linkedDirectory, ".git"),
        }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_policy" });

    for (const [name, indirection] of [
      ["relative", "gitdir: relative/path\n"],
      ["root", "gitdir: /\n"],
      ["missing-target", `gitdir: ${join(fixture, "absent-git-dir")}\n`],
    ] as const) {
      const linked = join(fixture, name);
      await mkdir(linked);
      await writeFile(join(linked, ".git"), indirection);
      await expect(
        prepareRuntimeMounts(
          input(linked, {
            kind: "external_worktree",
            gitDir: join(fixture, "absent-git-dir"),
            gitCommonDir: join(fixture, "absent-git-dir"),
          }),
        ),
      ).rejects.toMatchObject({ code: "unsupported_policy" });
    }

    const gitDirFile = join(fixture, "git-dir-file");
    await writeFile(gitDirFile, "not a directory");
    const linkedFileTarget = join(fixture, "linked-file-target");
    await mkdir(linkedFileTarget);
    await writeFile(join(linkedFileTarget, ".git"), `gitdir: ${gitDirFile}\n`);
    await expect(
      prepareRuntimeMounts(
        input(linkedFileTarget, {
          kind: "external_worktree",
          gitDir: gitDirFile,
          gitCommonDir: gitDirFile,
        }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_policy" });

    const emptyCommonRoot = join(fixture, "empty-common");
    const emptyCommonGit = join(fixture, "repo", ".git", "worktrees", "empty-common");
    await mkdir(emptyCommonRoot);
    await mkdir(emptyCommonGit, { recursive: true });
    await writeFile(join(emptyCommonRoot, ".git"), `gitdir: ${emptyCommonGit}\n`);
    await writeFile(join(emptyCommonGit, "commondir"), "\n");
    await expect(
      prepareRuntimeMounts(
        input(emptyCommonRoot, {
          kind: "external_worktree",
          gitDir: emptyCommonGit,
          gitCommonDir: join(fixture, "repo", ".git"),
        }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_policy" });
  });
});
