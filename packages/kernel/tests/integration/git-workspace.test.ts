import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { withoutGitRepositoryEnvironment } from "@clarvis/paths";
import { discoverGitWorkspace } from "../../src/git-workspace.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: withoutGitRepositoryEnvironment(process.env),
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("discoverGitWorkspace", () => {
  it("shares project identity while keeping linked workspaces distinct", async () => {
    const parent = mkdtempSync(join(tmpdir(), "clarvis-git-workspace-"));
    roots.push(parent);
    const primary = join(parent, "primary");
    const linked = join(parent, "linked");
    git(parent, ["init", "--quiet", "--initial-branch=main", primary]);
    git(primary, ["config", "user.name", "Clarvis Test"]);
    git(primary, ["config", "user.email", "test@clarvis.invalid"]);
    await Bun.write(join(primary, "README.md"), "test\n");
    git(primary, ["add", "README.md"]);
    git(primary, ["commit", "--quiet", "-m", "initial"]);
    git(primary, ["worktree", "add", "--quiet", "-b", "linked", linked, "HEAD"]);

    const a = await discoverGitWorkspace(primary);
    const b = await discoverGitWorkspace(linked);
    expect(a.project.id).toBe(b.project.id);
    expect(a.workspace.id).not.toBe(b.workspace.id);
    expect(a.workspace.kind).toBe("primary");
    expect(b.workspace.kind).toBe("external_worktree");
    expect(a.commonDir).toBe(a.gitDir);
    expect(b.commonDir).toBe(a.commonDir);
    expect(b.gitDir).not.toBe(b.commonDir);
  });

  it("falls back deterministically outside Git", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clarvis-non-git-workspace-")));
    roots.push(root);
    const first = await discoverGitWorkspace(root);
    const second = await discoverGitWorkspace(root);
    expect(second).toEqual(first);
    expect(first.workspace.kind).toBe("primary");
    expect(first.workspace.path).toBe(root);
  });
});
