import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { configurationRoots } from "@clarvis/paths";
import {
  isAuthoringSearchScope,
  isCanonicalAuthoringPath,
  isReviewedConfigurationPath,
} from "../../src/guard/authoring-path.ts";

test("authoring classification distinguishes reviewed documents from private state", () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-authoring-path-"));
  try {
    const roots = configurationRoots({ workspaceRoot: root });
    const authored = join(roots.workspace_clarvis, "agents", "reviewer.md");
    const operational = join(roots.workspace_clarvis, "settings.json");
    const privateFile = join(roots.workspace_clarvis, "state", "run.json");
    expect(isCanonicalAuthoringPath(authored, root)).toBe(true);
    expect(isCanonicalAuthoringPath(operational, root)).toBe(false);
    expect(isCanonicalAuthoringPath(privateFile, root)).toBe(false);
    expect(isReviewedConfigurationPath(authored, root)).toBe(true);
    expect(isReviewedConfigurationPath(operational, root)).toBe(true);
    expect(isReviewedConfigurationPath(privateFile, root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recursive authoring search admits real configuration directories only", () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-authoring-scope-"));
  try {
    const roots = configurationRoots({ workspaceRoot: root });
    const scope = join(roots.workspace_clarvis, "agents");
    mkdirSync(scope, { recursive: true });
    const file = join(scope, "reviewer.md");
    writeFileSync(file, "review");
    const link = join(roots.workspace_clarvis, "skills");
    symlinkSync(scope, link);
    expect(isAuthoringSearchScope(scope, root)).toBe(true);
    expect(isAuthoringSearchScope(file, root)).toBe(false);
    expect(isAuthoringSearchScope(join(root, "other"), root)).toBe(false);
    expect(isAuthoringSearchScope(join(roots.workspace_clarvis, "plugins"), root)).toBe(false);
    expect(isAuthoringSearchScope(link, root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
