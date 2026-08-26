import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  worktreeIsClean,
} from "../../src/bootstrap/worktree.ts";

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

function repository(): { root: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), "clarvis-worktree-bootstrap-"));
  roots.push(parent);
  const root = join(parent, "repo");
  git(parent, ["init", "--quiet", "--initial-branch=main", root]);
  git(root, ["config", "user.name", "Clarvis Test"]);
  git(root, ["config", "user.email", "test@clarvis.invalid"]);
  writeFileSync(join(root, "README.md"), "primary\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "--quiet", "-m", "initial"]);
  return { root, parent };
}

test("bootstrapWorktree creates and then reopens a deterministic Git-owned checkout", async () => {
  const repo = repository();
  const previousIndexFile = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = join(repo.root, "inherited-index");
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
    if (previousIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndexFile;
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
  expect(reopened.workspaceRoot).toBe(legacy);
  expect(existsSync(join(repo.root, ".clarvis"))).toBe(false);
  await removeWorktreeCheckout(reopened, { changeDirectory: () => {} });
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(externalParent)).toBe(true);
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
