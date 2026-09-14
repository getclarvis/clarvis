import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { withoutGitRepositoryEnvironment } from "@clarvis/paths";
import { captureWorkspaceState } from "../../src/workspace-state.ts";
import { makeRoot } from "../helpers/fs.ts";
import { environmentFixture, spyOnProcessEnv } from "../helpers/process-fixtures.ts";

describe("workspace state capture", () => {
  test("repository-local variables from a parent hook cannot redirect the workspace probe", async () => {
    const { root, cleanup } = await makeRoot();
    const environment = withoutGitRepositoryEnvironment(process.env);
    const runGit = (...args: string[]): void => {
      expect(spawnSync("git", args, { cwd: root, env: environment }).status).toBe(0);
    };
    try {
      runGit("init", "--quiet", "-b", "main");
      runGit("config", "user.email", "tests@clarvis.dev");
      runGit("config", "user.name", "Clarvis Tests");
      writeFileSync(join(root, "README.md"), "fixture\n");
      runGit("add", "README.md");
      runGit("commit", "--quiet", "-m", "fixture");
      const commit = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        env: environment,
        encoding: "utf8",
      }).stdout.trim();
      const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] as const;
      const probeEnvironment = environmentFixture({
        ...process.env,
        ...Object.fromEntries(names.map((name) => [name, join(root, "parent", name)])),
      });
      const envSpy = spyOnProcessEnv(probeEnvironment);
      try {
        await expect(captureWorkspaceState(root)).resolves.toEqual({
          vcs: "git",
          branch: "main",
          commit,
          dirty: false,
        });
      } finally {
        envSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("a non-git workspace has no captured state", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      expect(await captureWorkspaceState(root)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
