import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { withoutGitRepositoryEnvironment } from "@clarvis/kernel/local";
import { ensureWorkspaceDir, worktreeCheckoutRoot } from "@clarvis/paths";
import type { WorktreeRequest } from "../cli-args.ts";

const OUTPUT_LIMIT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;

export interface WorktreeBootstrapResult {
  /** Canonical checkout root that this process must keep for its entire lifetime. */
  workspaceRoot: string;
  /** Stable identity shared by every worktree of this Git repository. */
  projectId: string;
  /** Name accepted by `--worktree`, without the `clarvis/` branch namespace. */
  name: string;
  /** Canonical primary checkout that owns `.clarvis/worktrees`. */
  primaryWorkspaceRoot: string;
  /** Git branch selected for a Clarvis-created worktree. */
  branch: string;
  /** Whether this invocation created the checkout. */
  created: boolean;
  /** Whether the checkout occupies Clarvis's canonical workspace-owned location. */
  managedLocation: boolean;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

export interface WorktreeBootstrapDependencies {
  now?: () => Date;
  random?: () => string;
  runGit?: (cwd: string, args: readonly string[]) => Promise<GitResult>;
}

function gitFailure(args: readonly string[], stderr: string): Error {
  const detail = stderr.trim().split(/\r?\n/).at(-1) ?? "";
  return new Error(`git ${args.slice(0, 2).join(" ")} failed${detail ? `: ${detail}` : ""}`);
}

/** Run one bounded argv-only Git command with prompts disabled. */
export function runBootstrapGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...withoutGitRepositoryEnvironment(process.env),
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        LC_ALL: "C",
      },
    });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[], bytes: 0 };
    let overflow = false;
    const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      chunks.bytes += chunk.byteLength;
      if (chunks.bytes > OUTPUT_LIMIT) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks[stream].push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      };
      if (overflow) return reject(new Error("git output exceeded 1 MiB"));
      if (code !== 0) return reject(gitFailure(args, result.stderr));
      resolveResult(result);
    });
  });
}

function generatedName(now: Date, random: () => string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `clarvis-${stamp}-${random()}`;
}

function validateName(value: string): string {
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > 80 ||
    name === "." ||
    name === ".." ||
    name.includes("..") ||
    name.includes("@{") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    throw new Error(
      "worktree name must be 1-80 letters, digits, dots, underscores, or hyphens and a valid Git branch segment",
    );
  }
  return name;
}

interface ListedWorktree {
  path: string;
  branch?: string;
}

function listedWorktrees(output: string): ListedWorktree[] {
  const records: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: field.slice("worktree ".length) };
    } else if (field.startsWith("branch ") && current) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current) records.push(current);
  return records;
}

/** Ensure checkout creation cannot proceed unless Git will ignore its parent tree. */
function ensureWorktreeIgnore(primaryWorkspaceRoot: string): void {
  const clarvisDir = ensureWorkspaceDir(primaryWorkspaceRoot);
  const ignored = readFileSync(join(clarvisDir, ".gitignore"), "utf8")
    .split(/\r?\n/)
    .includes("worktrees/");
  if (!ignored) throw new Error("workspace .clarvis/.gitignore does not exclude worktrees/");
}

async function preferredBaseRef(
  cwd: string,
  runGit: (cwd: string, args: readonly string[]) => Promise<GitResult>,
): Promise<string> {
  try {
    await runGit(cwd, ["fetch", "--quiet", "origin"]);
  } catch {}
  try {
    const remote = (
      await runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    ).stdout.trim();
    if (remote) return remote;
  } catch {}
  return "HEAD";
}

/**
 * Resolve or create the one immutable workspace selected by `--worktree`.
 *
 * Git's registered worktree list is the source of truth. Clarvis writes no registry,
 * lease, operation journal, or cleanup record. Exit cleanup is explicit, clean-only,
 * and removes the checkout while preserving the branch.
 */
export async function bootstrapWorktree(
  startingWorkspace: string,
  request: WorktreeRequest,
  dependencies: WorktreeBootstrapDependencies = {},
): Promise<WorktreeBootstrapResult> {
  const runGit = dependencies.runGit ?? runBootstrapGit;
  const root = realpathSync(resolve(startingWorkspace));
  const topLevel = realpathSync(
    (await runGit(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"])).stdout.trim(),
  );
  const commonDir = realpathSync(
    (await runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim(),
  );
  const projectId = `prj_${createHash("sha256").update(resolve(commonDir)).digest("hex")}`;
  const name = validateName(
    request === true
      ? generatedName(
          dependencies.now?.() ?? new Date(),
          dependencies.random ?? (() => randomBytes(3).toString("hex")),
        )
      : request,
  );
  const registered = listedWorktrees(
    (await runGit(topLevel, ["worktree", "list", "--porcelain", "-z"])).stdout,
  );
  const primaryWorkspaceRoot = realpathSync(resolve(registered[0]?.path ?? topLevel));
  const destination = worktreeCheckoutRoot(primaryWorkspaceRoot, name);
  const branch = `clarvis/${name}`;
  const existing = registered.find(
    (entry) =>
      resolve(entry.path) === resolve(destination) || entry.branch === `refs/heads/${branch}`,
  );
  if (existing !== undefined) {
    return {
      workspaceRoot: realpathSync(existing.path),
      projectId,
      name,
      primaryWorkspaceRoot,
      branch,
      created: false,
      managedLocation: resolve(existing.path) === resolve(destination),
    };
  }
  ensureWorktreeIgnore(primaryWorkspaceRoot);
  try {
    await runGit(primaryWorkspaceRoot, [
      "check-ignore",
      "--quiet",
      "--no-index",
      "--",
      join(destination, ".clarvis-ignore-probe"),
    ]);
  } catch (error) {
    throw new Error("workspace .clarvis/.gitignore does not effectively exclude worktrees/", {
      cause: error,
    });
  }
  if (existsSync(destination)) {
    throw new Error(
      `worktree destination exists but Git does not register it: ${basename(destination)}`,
    );
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  let branchExists = true;
  try {
    await runGit(topLevel, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    branchExists = false;
  }
  if (branchExists) {
    await runGit(topLevel, ["worktree", "add", "--", destination, branch]);
  } else {
    const baseRef = await preferredBaseRef(topLevel, runGit);
    await runGit(topLevel, ["worktree", "add", "-b", branch, "--", destination, baseRef]);
  }
  return {
    workspaceRoot: realpathSync(destination),
    projectId,
    name,
    primaryWorkspaceRoot,
    branch,
    created: true,
    managedLocation: true,
  };
}

/** True when a managed checkout has no staged, tracked, or untracked changes. */
export async function worktreeIsClean(
  worktree: WorktreeBootstrapResult,
  dependencies: Pick<WorktreeBootstrapDependencies, "runGit"> = {},
): Promise<boolean> {
  const runGit = dependencies.runGit ?? runBootstrapGit;
  const result = await runGit(worktree.workspaceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  return result.stdout.length === 0;
}

/** Remove one clean managed checkout while preserving its branch. */
export async function removeWorktreeCheckout(
  worktree: WorktreeBootstrapResult,
  dependencies: Pick<WorktreeBootstrapDependencies, "runGit"> & {
    changeDirectory?: (path: string) => void;
  } = {},
): Promise<void> {
  const runGit = dependencies.runGit ?? runBootstrapGit;
  if (!(await worktreeIsClean(worktree, { runGit }))) {
    throw new Error("worktree has pending changes; checkout was kept");
  }
  (dependencies.changeDirectory ?? process.chdir)(worktree.primaryWorkspaceRoot);
  await runGit(worktree.primaryWorkspaceRoot, ["worktree", "remove", "--", worktree.workspaceRoot]);
  if (worktree.managedLocation) {
    try {
      await rmdir(dirname(worktree.workspaceRoot));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
  }
}
