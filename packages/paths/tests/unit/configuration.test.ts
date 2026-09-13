import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENTS_DIR,
  configurationPathClass,
  configurationTarget,
  configurationRoots,
  globalPaths,
  workspacePaths,
} from "../../src/index.ts";

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

test("configuration classes share a closed authoring, operational and private vocabulary", () => {
  for (const root of ["workspace_clarvis", "global_clarvis"] as const) {
    for (const path of [
      "agents/reviewer.md",
      "skills/review-tests/SKILL.md",
      "workflows/review/WORKFLOW.md",
    ])
      expect(configurationPathClass(root, path)).toBe("authoring");
    for (const path of [
      "settings.json",
      "plugins/review/plugin.json",
      "runtime-recipes/build.sh",
      "skills/review/helper.sh",
    ])
      expect(configurationPathClass(root, path)).toBe("operational");
  }
  for (const root of ["workspace_agents", "global_agents"] as const) {
    expect(configurationPathClass(root, "skills/review/SKILL.md")).toBe("authoring");
    expect(configurationPathClass(root, "agents/reviewer.md")).toBe("private");
    expect(configurationPathClass(root, "settings.json")).toBe("private");
  }
  for (const path of [
    "state/run.json",
    "auth.json",
    "skills/review/token.json",
    "../agents/a.md",
    "skills/../agents/a.md",
    "skills/review\\SKILL.md",
    "/agents/a.md",
  ])
    expect(configurationPathClass("workspace_clarvis", path)).toBe("private");
});

test("resolved configuration targets share one root classification and reject sibling prefixes", () => {
  const roots = configurationRoots({ workspaceRoot: resolve("workspace") });
  expect(configurationTarget(roots, join(roots.workspace_clarvis, "agents", "review.md"))).toEqual({
    root: "workspace_clarvis",
    path: "agents/review.md",
    kind: "authoring",
  });
  expect(configurationTarget(roots, roots.workspace_agents)?.kind).toBe("operational");
  expect(
    configurationTarget(roots, `${roots.workspace_clarvis}-other/settings.json`),
  ).toBeUndefined();
  expect(
    configurationTarget(roots, join(roots.workspace_clarvis, "state", "private.json"))?.kind,
  ).toBe("private");
});
