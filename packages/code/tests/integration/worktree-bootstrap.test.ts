import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { withoutGitRepositoryEnvironment } from "@clarvis/kernel/local";
import {
  bootstrapWorktree,
  removeWorktreeCheckout,
  runBootstrapGit,
  worktreeIsClean,
} from "../../src/bootstrap/worktree.ts";
import { environmentFixture, spyOnProcessEnv } from "../helpers/process-fixtures.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...withoutGitRepositoryEnvironment(process.env),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function repository(options: { commit?: boolean } = {}): { root: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), "clarvis-worktree-bootstrap-"));
  roots.push(parent);
  const root = join(parent, "repo");
  git(parent, ["init", "--quiet", "--initial-branch=main", root]);
  git(root, ["config", "user.name", "Clarvis Test"]);
  git(root, ["config", "user.email", "test@clarvis.invalid"]);
  if (options.commit !== false) {
    writeFileSync(join(root, "README.md"), "primary\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "--quiet", "-m", "initial"]);
  }
  return { root: realpathSync(root), parent: realpathSync(parent) };
}

/** Commit `files` in `cwd` and return the resulting commit id. */
function commit(cwd: string, message: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  git(cwd, ["add", ...Object.keys(files)]);
  git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Record every Git invocation bootstrap makes while delegating to the real runner. */
function recordingGit(): {
  calls: Array<{ cwd: string; args: readonly string[] }>;
  runGit: (cwd: string, args: readonly string[]) => ReturnType<typeof runBootstrapGit>;
} {
  const calls: Array<{ cwd: string; args: readonly string[] }> = [];
  return {
    calls,
    runGit: (cwd, args) => {
      calls.push({ cwd, args: [...args] });
      return runBootstrapGit(cwd, args);
    },
  };
}

test("bootstrapWorktree creates and then reopens a deterministic Git-owned checkout", async () => {
  const repo = repository();
  const env = spyOnProcessEnv(
    environmentFixture({ ...process.env, GIT_INDEX_FILE: join(repo.root, "inherited-index") }),
  );
  try {
    const created = await bootstrapWorktree(repo.root, "review-auth");
    expect(created.created).toBe(true);
    expect(created.branch).toBe("clarvis/review-auth");
    expect(created.name).toBe("review-auth");
    expect(created.managedLocation).toBe(true);
    expect(created.primaryWorkspaceRoot).toBe(repo.root);
    expect(created.workspaceRoot).toBe(join(repo.root, ".clarvis", "worktrees", "review-auth"));
    expect(readFileSync(join(created.workspaceRoot, "README.md"), "utf8")).toBe("primary\n");
    expect(readFileSync(join(repo.root, ".clarvis", ".gitignore"), "utf8")).toContain(
      "worktrees/\n",
    );
    expect(git(repo.root, ["status", "--porcelain"])).toBe("");
    expect(git(repo.root, ["worktree", "list", "--porcelain"])).toContain(
      `worktree ${created.workspaceRoot}`,
    );

    const reopened = await bootstrapWorktree(repo.root, "review-auth");
    expect(reopened).toEqual({ ...created, created: false });
  } finally {
    env.mockRestore();
  }
});

test("bootstrapWorktree generates a name and refuses unregistered destinations", async () => {
  const repo = repository();
  const generated = await bootstrapWorktree(repo.root, true, {
    now: () => new Date("2026-08-23T12:34:56.000Z"),
    random: () => "abc123",
  });
  expect(generated.branch).toBe("clarvis/clarvis-20260823T123456Z-abc123");

  const occupiedName = "occupied";
  const occupied = join(repo.root, ".clarvis", "worktrees", occupiedName);
  mkdirSync(occupied, { recursive: true });
  await Bun.write(join(occupied, "file"), "not a worktree");
  await expect(bootstrapWorktree(repo.root, occupiedName)).rejects.toThrow(
    "exists but Git does not register it",
  );
});

test("bootstrapWorktree rejects names Git cannot safely use as branch segments", async () => {
  const repo = repository();
  await expect(bootstrapWorktree(repo.root, "review..main")).rejects.toThrow(
    "valid Git branch segment",
  );
  expect(git(repo.root, ["worktree", "list", "--porcelain"])).not.toContain("review..main");
});

test("bootstrapWorktree fails closed when a later ignore rule exposes worktree contents", async () => {
  const repo = repository();
  mkdirSync(join(repo.root, ".clarvis"));
  writeFileSync(join(repo.root, ".clarvis", ".gitignore"), ".gitignore\nworktrees/\n!worktrees/\n");
  await expect(bootstrapWorktree(repo.root, "exposed")).rejects.toThrow(
    "does not effectively exclude worktrees/",
  );
  expect(existsSync(join(repo.root, ".clarvis", "worktrees", "exposed"))).toBe(false);
});

test("bootstrapWorktree anchors sibling launches in the primary checkout", async () => {
  const repo = repository();
  const first = await bootstrapWorktree(repo.root, "first");
  const second = await bootstrapWorktree(first.workspaceRoot, "second");
  expect(second.primaryWorkspaceRoot).toBe(repo.root);
  expect(second.workspaceRoot).toBe(join(repo.root, ".clarvis", "worktrees", "second"));
});

test("bootstrapWorktree reopens a registered Clarvis branch at its existing location", async () => {
  const repo = repository();
  const externalParent = join(repo.parent, "external-checkouts");
  mkdirSync(externalParent);
  const legacy = join(externalParent, "legacy-review");
  git(repo.root, ["worktree", "add", "--quiet", "-b", "clarvis/legacy", legacy, "HEAD"]);
  chmodSync(repo.root, 0o555);
  let reopened!: Awaited<ReturnType<typeof bootstrapWorktree>>;
  try {
    reopened = await bootstrapWorktree(repo.root, "legacy");
  } finally {
    chmodSync(repo.root, 0o700);
  }
  expect(reopened.created).toBe(false);
  expect(reopened.managedLocation).toBe(false);
  expect(reopened.workspaceRoot).toBe(realpathSync(legacy));
  expect(existsSync(join(repo.root, ".clarvis"))).toBe(false);
  await removeWorktreeCheckout(reopened, { changeDirectory: () => {} });
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(externalParent)).toBe(true);
});

test("bootstrapWorktree bases a new branch on the local HEAD, not the remote default", async () => {
  const repo = repository();
  const origin = join(repo.parent, "origin.git");
  git(repo.parent, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  git(repo.root, ["remote", "add", "origin", origin]);
  git(repo.root, ["push", "--quiet", "origin", "main"]);
  git(repo.root, ["remote", "set-head", "origin", "--auto"]);
  const mainCommit = git(repo.root, ["rev-parse", "HEAD"]);
  git(repo.root, ["checkout", "--quiet", "-b", "develop"]);
  const developCommit = commit(repo.root, "develop work", { "develop.txt": "unpublished\n" });
  expect(developCommit).not.toBe(mainCommit);
  expect(git(repo.root, ["symbolic-ref", "refs/remotes/origin/HEAD"])).toBe(
    "refs/remotes/origin/main",
  );

  const recorder = recordingGit();
  const created = await bootstrapWorktree(repo.root, "from-head", { runGit: recorder.runGit });

  expect(git(created.workspaceRoot, ["rev-parse", "HEAD"])).toBe(developCommit);
  expect(readFileSync(join(created.workspaceRoot, "develop.txt"), "utf8")).toBe("unpublished\n");
  expect(recorder.calls.filter((call) => call.args[0] === "fetch")).toEqual([]);
  expect(recorder.calls.filter((call) => call.args.includes("origin"))).toEqual([]);
  expect(git(created.workspaceRoot, ["config", "--local", "--list"])).not.toContain(
    "branch.clarvis/",
  );
});

test("bootstrapWorktree includes commits that exist only in the source checkout", async () => {
  const repo = repository();
  const localCommit = commit(repo.root, "local only", { "local-only.txt": "local\n" });

  const created = await bootstrapWorktree(repo.root, "local-only");

  expect(git(created.workspaceRoot, ["rev-parse", "HEAD"])).toBe(localCommit);
  expect(existsSync(join(created.workspaceRoot, "local-only.txt"))).toBe(true);
});

test("bootstrapWorktree bases a nested launch on the source checkout's HEAD", async () => {
  const repo = repository();
  const primaryCommit = git(repo.root, ["rev-parse", "HEAD"]);
  const first = await bootstrapWorktree(repo.root, "first");
  const linkedCommit = commit(first.workspaceRoot, "linked work", { "linked.txt": "linked\n" });
  expect(linkedCommit).not.toBe(primaryCommit);

  const second = await bootstrapWorktree(first.workspaceRoot, "second");

  expect(second.primaryWorkspaceRoot).toBe(repo.root);
  expect(second.workspaceRoot).toBe(join(repo.root, ".clarvis", "worktrees", "second"));
  expect(git(second.workspaceRoot, ["rev-parse", "HEAD"])).toBe(linkedCommit);
  expect(existsSync(join(second.workspaceRoot, "linked.txt"))).toBe(true);
});

test("bootstrapWorktree bases a new branch on the commit of a detached HEAD", async () => {
  const repo = repository();
  const firstCommit = git(repo.root, ["rev-parse", "HEAD"]);
  commit(repo.root, "second", { "second.txt": "second\n" });
  git(repo.root, ["checkout", "--quiet", "--detach", firstCommit]);

  const created = await bootstrapWorktree(repo.root, "detached");

  expect(git(created.workspaceRoot, ["rev-parse", "HEAD"])).toBe(firstCommit);
  expect(existsSync(join(created.workspaceRoot, "second.txt"))).toBe(false);
});

test("bootstrapWorktree reopens a registered checkout without rewriting its history", async () => {
  const repo = repository();
  const created = await bootstrapWorktree(repo.root, "keeps-history");
  const advanced = commit(created.workspaceRoot, "worktree work", { "worktree.txt": "kept\n" });

  const reopened = await bootstrapWorktree(repo.root, "keeps-history");

  expect(reopened.created).toBe(false);
  expect(reopened.workspaceRoot).toBe(created.workspaceRoot);
  expect(git(reopened.workspaceRoot, ["rev-parse", "HEAD"])).toBe(advanced);
  expect(git(repo.root, ["rev-parse", "HEAD"])).not.toBe(advanced);
  expect(existsSync(join(reopened.workspaceRoot, "worktree.txt"))).toBe(true);
});

test("bootstrapWorktree reuses an existing clarvis branch without redefining it", async () => {
  const repo = repository();
  const initial = git(repo.root, ["rev-parse", "HEAD"]);
  commit(repo.root, "later", { "later.txt": "later\n" });
  git(repo.root, ["branch", "clarvis/reused", initial]);

  const created = await bootstrapWorktree(repo.root, "reused");

  expect(created.created).toBe(true);
  expect(git(created.workspaceRoot, ["rev-parse", "HEAD"])).toBe(initial);
  expect(git(repo.root, ["rev-parse", "clarvis/reused"])).toBe(initial);
  expect(existsSync(join(created.workspaceRoot, "later.txt"))).toBe(false);
});

test("bootstrapWorktree fails clearly without a commit and creates nothing", async () => {
  const repo = repository({ commit: false });

  await expect(bootstrapWorktree(repo.root, "no-commit")).rejects.toThrow("no commit at HEAD");

  expect(existsSync(join(repo.root, ".clarvis"))).toBe(false);
  expect(git(repo.root, ["branch", "--list"])).toBe("");
  expect(git(repo.root, ["worktree", "list", "--porcelain"])).not.toContain("clarvis/no-commit");
});

test("bootstrapWorktree leaves uncommitted source changes in place and copies none of them", async () => {
  const repo = repository();
  const committed = git(repo.root, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo.root, "README.md"), "modified\n");
  writeFileSync(join(repo.root, "staged.txt"), "staged\n");
  git(repo.root, ["add", "staged.txt"]);
  writeFileSync(join(repo.root, "untracked.txt"), "untracked\n");
  const status = ["status", "--porcelain=v1", "--untracked-files=all"];
  const before = git(repo.root, status);
  expect(before).toContain("README.md");

  const created = await bootstrapWorktree(repo.root, "clean-base");

  expect(git(repo.root, status)).toBe(before);
  expect(git(created.workspaceRoot, ["rev-parse", "HEAD"])).toBe(committed);
  expect(readFileSync(join(created.workspaceRoot, "README.md"), "utf8")).toBe("primary\n");
  expect(existsSync(join(created.workspaceRoot, "staged.txt"))).toBe(false);
  expect(existsSync(join(created.workspaceRoot, "untracked.txt"))).toBe(false);
  expect(await worktreeIsClean(created)).toBe(true);
});

test("clean checkout removal keeps the branch and removes an empty worktree directory", async () => {
  const repo = repository();
  const created = await bootstrapWorktree(repo.root, "temporary");
  expect(await worktreeIsClean(created)).toBe(true);
  let changedTo = "";
  await removeWorktreeCheckout(created, { changeDirectory: (path) => (changedTo = path) });
  expect(changedTo).toBe(repo.root);
  expect(existsSync(created.workspaceRoot)).toBe(false);
  expect(existsSync(dirname(created.workspaceRoot))).toBe(false);
  expect(git(repo.root, ["branch", "--list", "clarvis/temporary"])).toContain("clarvis/temporary");
});

test("checkout removal fails closed when pending changes appear", async () => {
  const repo = repository();
  const created = await bootstrapWorktree(repo.root, "keep-dirty");
  writeFileSync(join(created.workspaceRoot, "pending.txt"), "keep me\n");
  expect(await worktreeIsClean(created)).toBe(false);
  await expect(removeWorktreeCheckout(created, { changeDirectory: () => {} })).rejects.toThrow(
    "pending changes",
  );
  expect(existsSync(created.workspaceRoot)).toBe(true);
});
