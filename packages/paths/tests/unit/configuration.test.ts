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

test("configuration classes distinguish authoring, generated, secret and unknown targets", () => {
  for (const root of ["workspace_clarvis", "global_clarvis"] as const) {
    for (const path of ["agents/reviewer.md", "workflows/review/WORKFLOW.md", "rules/default.json"])
      expect(configurationPathClass(root, path)).toBe("authoring");
    for (const path of ["settings.json", "plugins/review/plugin.json", "skills/review/helper.sh"])
      expect(configurationPathClass(root, path)).toBe(
        path === "settings.json" ? "operational" : "reserved_unknown",
      );
  }
  for (const root of ["workspace_agents", "global_agents"] as const) {
    expect(configurationPathClass(root, "skills/review/SKILL.md")).toBe("authoring");
    expect(configurationPathClass(root, "plugins/marketplace.json")).toBe("operational");
    expect(configurationPathClass(root, "marketplace.json")).toBe("reserved_unknown");
    expect(configurationPathClass(root, "agents/reviewer.md")).toBe("reserved_unknown");
    expect(configurationPathClass(root, "settings.json")).toBe("reserved_unknown");
  }
  for (const path of ["state/run.json", "auth.json", "skills/review/token.json"])
    expect(configurationPathClass("workspace_clarvis", path)).toBe("secret");
  for (const path of [
    "../agents/a.md",
    "skills/../agents/a.md",
    "skills/review\\SKILL.md",
    "/agents/a.md",
  ])
    expect(configurationPathClass("workspace_clarvis", path)).toBe("reserved_unknown");
  expect(configurationPathClass("workspace_clarvis", ".gitignore")).toBe("generated_read_only");
  expect(configurationPathClass("global_clarvis", "harness-probe.txt")).toBe("reserved_unknown");
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
  ).toBe("secret");
});
