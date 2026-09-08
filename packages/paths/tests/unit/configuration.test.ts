import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGENTS_DIR, configurationRoots, globalPaths, workspacePaths } from "../../src/index.ts";

test("configuration roots preserve an explicit global override and both shared-agent scopes", () => {
  const home = resolve("operator-home");
  const workspaceRoot = resolve("workspace");
  const globalDir = resolve("custom-global");
  expect(configurationRoots({ home, workspaceRoot, globalDir })).toEqual({
    global_clarvis: globalDir,
    workspace_clarvis: workspacePaths(workspaceRoot).clarvisDir,
    global_agents: join(home, AGENTS_DIR),
    workspace_agents: join(workspaceRoot, AGENTS_DIR),
  });
});

test("configuration roots default to the normal global resolver and OS home", () => {
  const roots = configurationRoots({ workspaceRoot: process.cwd() });
  expect(roots.global_clarvis).toBe(resolve(globalPaths().root));
  expect(roots.global_agents).toBe(join(homedir(), AGENTS_DIR));
});
