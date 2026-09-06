import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { withoutGitRepositoryEnvironment } from "@clarvis/paths";
import { createNodeProcessRunner } from "../adapters/process/node-process-runner.ts";
import type { ProcessRunner } from "../ports/process-runner.ts";

/** Failure while constructing independent Git metadata for a retained copy. */
export class RuntimeGitError extends Error {
  readonly code = "private_git_failed" as const;
}

function gitEnvironment(): Readonly<Record<string, string | undefined>> {
  return {
    ...withoutGitRepositoryEnvironment(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  };
}

async function runGit(
  runner: ProcessRunner,
  cwd: string,
  args: readonly string[],
  allowFailure = false,
): Promise<string> {
  const result = await runner.run({
    command: "git",
    args,
    cwd,
    environment: gitEnvironment(),
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0 && !allowFailure) {
    throw new RuntimeGitError("failed to construct private runtime Git metadata");
  }
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

/**
 * Create private Git objects and an index matching the source HEAD without
 * sharing metadata, hardlinks, alternates, remotes, hooks, or credential helpers.
 */
export async function createPrivateRuntimeGit(
  sourceRoot: string,
  retainedRoot: string,
  runner: ProcessRunner = createNodeProcessRunner(),
): Promise<boolean> {
  const marker = await lstat(join(sourceRoot, ".git")).catch(() => undefined);
  if (marker === undefined) return false;
  const inside = await runGit(runner, sourceRoot, ["rev-parse", "--is-inside-work-tree"], true);
  if (inside !== "true") return false;
  const head = await runGit(runner, sourceRoot, ["symbolic-ref", "-q", "HEAD"], true);
  if (head !== "" && !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(head)) {
    throw new RuntimeGitError("source Git HEAD is unsafe");
  }
  const references = await runGit(
    runner,
    sourceRoot,
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"],
    true,
  );
  const branch = head === "" ? "runtime" : head.slice("refs/heads/".length);
  await runGit(runner, retainedRoot, [
    "init",
    "--quiet",
    "--template=",
    "--initial-branch",
    branch,
  ]);
  await runGit(runner, retainedRoot, ["config", "credential.helper", ""]);
  await runGit(runner, retainedRoot, ["config", "core.hooksPath", ".git/disabled-hooks"]);
  if (references === "") return true;
  const bundle = join(retainedRoot, ".git", "clarvis-history.bundle");
  try {
    await runGit(runner, sourceRoot, ["bundle", "create", bundle, "--branches", "--tags"]);
    await runGit(runner, retainedRoot, [
      "fetch",
      "--quiet",
      "--no-write-fetch-head",
      bundle,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ]);
    if (head !== "") {
      await runGit(runner, retainedRoot, ["symbolic-ref", "HEAD", head]);
      await runGit(runner, retainedRoot, ["read-tree", "HEAD"]);
    }
  } finally {
    await rm(bundle, { force: true });
  }
  return true;
}
