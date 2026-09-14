import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentsWorkspaceDir, containerGuestPaths, workspacePaths } from "@clarvis/paths";
import type { WorkspaceRef } from "@clarvis/protocol";
import { RuntimeLaunchError, type RuntimeProtectedMount } from "./types.ts";
import { containerGitDirectoryTarget } from "../git-workspace.ts";

export interface ContainerMountPreparationInput {
  readonly [key: string]: unknown;
  readonly workspaceRoot: string;
  readonly workspace: WorkspaceRef;
  readonly gitMetadataMounts: readonly RuntimeProtectedMount[];
}

export interface PreparedRuntimeMounts {
  readonly controlRootMasks: readonly RuntimeProtectedMount[];
  readonly gitMetadataMounts: readonly RuntimeProtectedMount[];
  cleanup(): Promise<void>;
}

/** Inspect one nested control path without following any workspace-relative symlink. */
export async function inspectReservedWorkspacePath(
  candidate: string,
  workspaceRoot: string,
): Promise<Stats | undefined> {
  const fromRoot = relative(workspaceRoot, candidate);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new RuntimeLaunchError(
      "unsupported_policy",
      `reserved workspace path '${candidate}' is outside the selected workspace`,
    );
  }
  const segments = fromRoot.split(sep);
  let current = workspaceRoot;
  let result: Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      result = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `runtime could not inspect reserved workspace path '${candidate}'`,
        { cause: error },
      );
    }
    if (result.isSymbolicLink()) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `reserved workspace path '${candidate}' must not traverse symbolic links`,
      );
    }
    const final = index === segments.length - 1;
    if ((!final && !result.isDirectory()) || (final && !result.isDirectory() && !result.isFile())) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `reserved workspace path '${candidate}' must be a regular file or directory`,
      );
    }
  }
  return result;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) === resolve(path, "..")) {
    throw new RuntimeLaunchError(
      "unsupported_policy",
      `${label} must be an absolute non-root path`,
    );
  }
  const canonical = await realpath(path).catch((cause: unknown) => {
    throw new RuntimeLaunchError("unsupported_policy", `${label} is unavailable`, { cause });
  });
  const info = await lstat(canonical);
  if (!info.isDirectory()) {
    throw new RuntimeLaunchError("unsupported_policy", `${label} must be a directory`);
  }
  return canonical;
}

/** Prepare opaque control masks and the exact read-only Git metadata projection. */
export async function prepareRuntimeMounts(
  input: ContainerMountPreparationInput,
): Promise<PreparedRuntimeMounts> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const paths = workspacePaths(workspaceRoot);
  const agentsRoot = agentsWorkspaceDir(workspaceRoot);
  for (const controlRoot of [paths.clarvisDir, agentsRoot]) {
    const info = await inspectReservedWorkspacePath(controlRoot, workspaceRoot);
    if (info === undefined) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `reserved workspace mount target '${controlRoot}' must already exist`,
      );
    }
    if (!info.isDirectory()) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `reserved workspace path '${controlRoot}' must be a directory`,
      );
    }
  }
  const privateRoot = await realpath(await mkdtemp(join(tmpdir(), "clarvis-container-masks-")));
  try {
    const fromWorkspace = relative(workspaceRoot, privateRoot);
    if (
      fromWorkspace === "" ||
      (fromWorkspace !== ".." &&
        !fromWorkspace.startsWith(`..${sep}`) &&
        !isAbsolute(fromWorkspace))
    ) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        "runtime control masks must be outside the selected workspace",
      );
    }
    const agentsMask = join(privateRoot, "agents");
    const gitMask = join(privateRoot, "git");
    await Promise.all([agentsMask, gitMask].map((path) => mkdir(path, { mode: 0o700 })));
    const controlRootMasks: readonly RuntimeProtectedMount[] = [
      {
        source: agentsMask,
        target: agentsWorkspaceDir("/workspace"),
        type: "directory",
        readOnly: true,
      },
    ];
    const dotGit = join(workspaceRoot, ".git");
    const dotGitInfo = await inspectReservedWorkspacePath(dotGit, workspaceRoot);
    let gitMetadataMounts: readonly RuntimeProtectedMount[];
    if (input.gitMetadataMounts.length === 0) {
      if (dotGitInfo === undefined) {
        throw new RuntimeLaunchError(
          "unsupported_policy",
          "non-Git Container workspaces require an existing empty .git mount target",
        );
      }
      if (!dotGitInfo.isDirectory() || (await readdir(dotGit)).length !== 0) {
        throw new RuntimeLaunchError(
          "unsupported_policy",
          "workspace Git metadata was not admitted by host discovery",
        );
      }
      gitMetadataMounts = [
        { source: gitMask, target: "/workspace/.git", type: "directory", readOnly: true },
      ];
    } else {
      if (dotGitInfo === undefined) {
        throw new RuntimeLaunchError(
          "unsupported_policy",
          "workspace Git metadata discovery is incomplete",
        );
      }
      let expected: readonly RuntimeProtectedMount[];
      let projectedGitDirectoryTarget: string | undefined;
      if (input.workspace.kind === "external_worktree") {
        if (!dotGitInfo.isFile()) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "linked worktree .git metadata must be a regular file",
          );
        }
        const indirection = (await readFile(dotGit, "utf8")).trim();
        const declaredGitDir = indirection.startsWith("gitdir: ")
          ? indirection.slice("gitdir: ".length)
          : "";
        if (!isAbsolute(declaredGitDir)) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "linked worktree .git indirection must name the admitted canonical Git directory",
          );
        }
        const gitDir = await canonicalDirectory(declaredGitDir, "runtime Git directory");
        const commonReference = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
        if (commonReference.length === 0) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "linked worktree common Git directory does not match host discovery",
          );
        }
        const commonDir = await canonicalDirectory(
          resolve(gitDir, commonReference),
          "runtime Git common directory",
        );
        let gitTarget: string;
        try {
          gitTarget = containerGitDirectoryTarget(gitDir, commonDir);
        } catch (cause) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "linked worktree Git directory must be contained by its common directory",
            { cause },
          );
        }
        projectedGitDirectoryTarget = gitTarget;
        expected = [
          { source: dotGit, target: "/workspace/.git", type: "file", readOnly: true },
          ...(commonDir === gitDir
            ? []
            : [
                {
                  source: commonDir,
                  target: containerGuestPaths.gitCommonRoot,
                  type: "directory" as const,
                  readOnly: true as const,
                },
              ]),
          { source: gitDir, target: gitTarget, type: "directory", readOnly: true },
        ];
      } else {
        if (!dotGitInfo.isDirectory()) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "primary checkout Git metadata does not match host discovery",
          );
        }
        const gitDir = await canonicalDirectory(dotGit, "runtime Git directory");
        expected = [
          { source: gitDir, target: "/workspace/.git", type: "directory", readOnly: true },
        ];
      }
      if (
        input.gitMetadataMounts.length !== expected.length ||
        input.gitMetadataMounts.some((mount, index) => {
          const wanted = expected[index];
          return (
            wanted === undefined ||
            mount.source !== wanted.source ||
            mount.target !== wanted.target ||
            mount.type !== wanted.type ||
            mount.readOnly !== true
          );
        })
      ) {
        throw new RuntimeLaunchError(
          "unsupported_policy",
          "runtime Git metadata mounts do not match host discovery",
        );
      }
      if (input.workspace.kind === "external_worktree") {
        const rewrittenGitFile = join(privateRoot, "worktree.git");
        await writeFile(rewrittenGitFile, `gitdir: ${projectedGitDirectoryTarget!}\n`, {
          mode: 0o400,
        });
        gitMetadataMounts = expected.map((mount, index) =>
          index === 0 ? { ...mount, source: rewrittenGitFile } : mount,
        );
      } else gitMetadataMounts = expected;
    }
    return {
      controlRootMasks,
      gitMetadataMounts,
      cleanup: async () => rm(privateRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(privateRoot, { recursive: true, force: true });
    throw error;
  }
}
