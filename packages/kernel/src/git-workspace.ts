import { withoutGitRepositoryEnvironment } from "@clarvis/paths";
import type { ProjectRef, WorkspaceRef } from "@clarvis/protocol";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitWorkspaceContext {
  project: ProjectRef;
  workspace: WorkspaceRef;
  worktreeRoot: string;
  gitDir?: string;
  commonDir?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(resolve(value)).digest("hex");
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: {
      ...withoutGitRepositoryEnvironment(process.env),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      LC_ALL: "C",
    },
  });
  return String(result.stdout).trim();
}

/** Derive stable project/workspace identity directly from Git, with a path fallback outside Git. */
export async function discoverGitWorkspace(workspaceRoot: string): Promise<GitWorkspaceContext> {
  const root = await realpath(resolve(workspaceRoot));
  try {
    const worktreeRoot = await realpath(
      await git(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
    );
    if (worktreeRoot !== root) throw new Error("workspace root must be the Git top level");
    const [commonDir, gitDir, branch, listing] = await Promise.all([
      git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).then((path) =>
        realpath(path),
      ),
      git(root, ["rev-parse", "--path-format=absolute", "--git-dir"]).then((path) =>
        realpath(path),
      ),
      git(root, ["branch", "--show-current"]),
      git(root, ["worktree", "list", "--porcelain", "-z"]),
    ]);
    const primaryPath = listing
      .split("\0")
      .find((field) => field.startsWith("worktree "))
      ?.slice("worktree ".length);
    const projectId = `prj_${digest(commonDir)}`;
    const workspace: WorkspaceRef = {
      id: `ws_${digest(gitDir)}`,
      projectId,
      label: branch || basename(root) || "workspace",
      kind:
        primaryPath !== undefined && resolve(primaryPath) === root
          ? "primary"
          : "external_worktree",
      path: root,
    };
    return {
      project: { id: projectId, label: basename(primaryPath ?? root) || "workspace" },
      workspace,
      worktreeRoot: root,
      gitDir,
      commonDir,
    };
  } catch {
    const projectId = `prj_${digest(root)}`;
    return {
      project: { id: projectId, label: basename(root) || "workspace" },
      workspace: {
        id: `ws_${digest(root)}`,
        projectId,
        label: basename(root) || "workspace",
        kind: "primary",
        path: root,
      },
      worktreeRoot: root,
    };
  }
}
