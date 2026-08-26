import { execFile } from "node:child_process";

import { levelEnabled, NOOP_LOGGER, sanitizeErrorMessage, type Logger } from "@clarvis/capability";
import { withoutGitRepositoryEnvironment } from "@clarvis/paths";

import type { WorkspaceState } from "./types.ts";

const GIT_TIMEOUT_MS = 1500;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: withoutGitRepositoryEnvironment(process.env), timeout: GIT_TIMEOUT_MS },
      (err, stdout) => {
        if (err) reject(new Error(err.message));
        else resolve(stdout.trim());
      },
    );
  });
}

/**
 * Best-effort capture of the workspace's git state for a `RunSnapshot`.
 *
 * @param cwd - the workspace directory to inspect.
 * @param logger - where a probe that could not run is reported. A snapshot with
 *   no branch or commit is otherwise indistinguishable from one taken outside a
 *   repository, and every run indexed from it loses that provenance silently.
 * @returns the current branch, commit, and dirty flag, or `undefined` when the
 *   directory is not a git repo, git is missing, or any probe times out
 *   ({@link GIT_TIMEOUT_MS}) — absence is a valid outcome, never an error.
 * @remarks Runs `rev-parse` and `status --porcelain` in parallel; `dirty` is
 *   true when the porcelain output is non-empty. Every launched probe settles
 *   before this function returns, including when one fails, so no sibling
 *   process can retain `cwd` while the caller tears a temporary workspace down.
 */
export async function captureWorkspaceState(
  cwd: string,
  logger: Logger = NOOP_LOGGER,
): Promise<WorkspaceState | undefined> {
  try {
    const [branch, commit, porcelain] = await Promise.allSettled([
      git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
      git(["rev-parse", "HEAD"], cwd),
      git(["status", "--porcelain"], cwd),
    ]);
    if (branch.status === "rejected") throw branch.reason;
    if (commit.status === "rejected") throw commit.reason;
    if (porcelain.status === "rejected") throw porcelain.reason;
    return {
      vcs: "git",
      branch: branch.value,
      commit: commit.value,
      dirty: porcelain.value.length > 0,
    };
  } catch (err) {
    if (levelEnabled(logger, "debug")) {
      logger.debug(
        {
          event: "memory.workspace_state.unavailable",
          cause: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "the workspace's git state could not be captured; the run this indexes carries no branch or commit",
      );
    }
    return undefined;
  }
}
