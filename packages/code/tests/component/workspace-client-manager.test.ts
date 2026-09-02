import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { ownerFromWorkspace } from "@clarvis/paths";
import { withoutGitRepositoryEnvironment } from "@clarvis/kernel/local";

import { WorkspaceClientManager } from "../../src/adapters/workspace-client-manager.ts";
import { prepareStartupFoundation } from "../../src/startup-foundation.ts";
import { openTempDir } from "../helpers/tracked-temp.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: withoutGitRepositoryEnvironment(process.env),
    stdio: "ignore",
  });
}

describe("WorkspaceClientManager", () => {
  it("prepares the startup foundation from process-pinned paths and owner", async () => {
    const root = openTempDir("clarvis-startup-foundation-");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const previousHome = process.env.CLARVIS_HOME;
    const previousWorkspace = process.env.CLARVIS_WORKSPACE_ROOT;
    const previousOwner = process.env.CLARVIS_OWNER;
    let manager: WorkspaceClientManager | undefined;
    try {
      process.env.CLARVIS_HOME = join(root, "global");
      process.env.CLARVIS_WORKSPACE_ROOT = workspace;
      process.env.CLARVIS_OWNER = "startup-owner";
      manager = await prepareStartupFoundation({
        kind: "run",
        ascii: false,
        debug: { enabled: false },
        extensionProfileSelector: "builtin:default",
      });
      expect(manager.current.path).toBe(realpathSync(workspace));
      expect(manager.defaultOwner).toBe("startup-owner");
      await manager.close();
      manager = undefined;

      delete process.env.CLARVIS_OWNER;
      manager = await prepareStartupFoundation({
        kind: "run",
        ascii: false,
        debug: { enabled: false },
      });
      expect(manager.defaultOwner).toBe(ownerFromWorkspace(workspace));
    } finally {
      await manager?.close();
      if (previousHome === undefined) delete process.env.CLARVIS_HOME;
      else process.env.CLARVIS_HOME = previousHome;
      if (previousWorkspace === undefined) delete process.env.CLARVIS_WORKSPACE_ROOT;
      else process.env.CLARVIS_WORKSPACE_ROOT = previousWorkspace;
      if (previousOwner === undefined) delete process.env.CLARVIS_OWNER;
      else process.env.CLARVIS_OWNER = previousOwner;
    }
  });

  it("opens only the process-pinned workspace", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-workspaces-"));
    const globalDir = join(workspaceRoot, "global");
    git(workspaceRoot, "init", "--quiet");
    git(workspaceRoot, "config", "user.email", "tests@example.com");
    git(workspaceRoot, "config", "user.name", "Clarvis Tests");
    git(workspaceRoot, "commit", "--allow-empty", "-m", "initial", "--quiet");

    const manager = await WorkspaceClientManager.create({
      workspaceRoot,
      globalDir,
    });
    expect(manager.project.id).toStartWith("prj_");

    const opened = await manager.open();
    expect(opened.workspace).toEqual(manager.current);
    await opened.release();
    await opened.release();
    await expect(manager.open("another-workspace")).rejects.toThrow("pinned to one workspace");

    await manager.close();
    await manager.close();
  });

  it("derives the default owner from the selected linked checkout", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-primary-owner-"));
    const externalRoot = join(workspaceRoot, "linked");
    const primaryRoot = join(workspaceRoot, "primary");
    git(workspaceRoot, "init", "--quiet", primaryRoot);
    git(primaryRoot, "config", "user.email", "tests@example.com");
    git(primaryRoot, "config", "user.name", "Clarvis Tests");
    git(primaryRoot, "commit", "--allow-empty", "-m", "initial", "--quiet");
    git(primaryRoot, "worktree", "add", "--quiet", "-b", "linked", externalRoot, "HEAD");

    const manager = await WorkspaceClientManager.create({
      workspaceRoot: externalRoot,
      globalDir: join(workspaceRoot, "global"),
    });
    expect(manager.current.path).toBe(realpathSync(externalRoot));
    expect(manager.defaultOwner).toBe(ownerFromWorkspace(externalRoot));
    expect(manager.defaultOwner).not.toBe(ownerFromWorkspace(primaryRoot));
    await manager.close();
  });
});
