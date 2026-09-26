import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalRoot as resolveGlobalRoot } from "@clarvis/paths";
import { createExecutionPolicy, InvalidExecutionPolicy } from "../../src/index.ts";

describe("execution policy", () => {
  test("constructs broad-read policy without implicit home denies", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-policy-"));
    try {
      const policy = createExecutionPolicy({
        id: "default",
        workspaceRoot: root,
        homeRoot: root,
        globalRoot: join(root, ".clarvis"),
      });
      expect(policy.mode).toBe("host");
      expect(policy.workspaceAccess).toBe("read-write");
      expect(policy.network).toBe("enabled");
      expect(policy.globalAgentsRoot).toBe(join(root, ".agents"));
      expect(policy.workflowsRoot).toBe(join(root, ".clarvis", "workflows"));
      expect(policy.settingsFile).toBe(join(root, ".clarvis", "settings.json"));
      expect(policy.denies).toEqual([]);
      expect(policy.readOnlyPaths).toContain(join(root, ".git"));
      expect(policy.readOnlyPaths).toContain(join(root, ".clarvis"));
      expect(Object.isFrozen(policy)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed authority instead of changing mode", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-policy-"));
    const installation = mkdtempSync(join(process.cwd(), ".policy-install-"));
    try {
      expect(() =>
        createExecutionPolicy({
          id: "bad",
          workspaceRoot: root,
          homeRoot: root,
          mode: "other" as "host",
        }),
      ).toThrow(InvalidExecutionPolicy);
      expect(() =>
        createExecutionPolicy({
          id: "bad",
          workspaceRoot: root,
          homeRoot: root,
          denies: ["relative"],
        }),
      ).toThrow(InvalidExecutionPolicy);
      expect(() =>
        createExecutionPolicy({
          id: "bad",
          workspaceRoot: root,
          homeRoot: root,
          installationRoots: [root],
        }),
      ).toThrow(InvalidExecutionPolicy);
      const temporaryAlias = join(root, "installation-alias");
      symlinkSync(installation, temporaryAlias);
      expect(() =>
        createExecutionPolicy({
          id: "bad",
          workspaceRoot: root,
          homeRoot: root,
          temporaryWriteRoots: [temporaryAlias],
          installationRoots: [installation],
        }),
      ).toThrow(InvalidExecutionPolicy);
      const privateGlobal = join(root, ".clarvis", "state");
      mkdirSync(privateGlobal, { recursive: true });
      const separateWorkspace = join(root, "workspace");
      mkdirSync(separateWorkspace);
      for (const roots of [{ installationRoots: [privateGlobal] }]) {
        expect(() =>
          createExecutionPolicy({
            id: "bad",
            mode: "sandbox",
            workspaceRoot: separateWorkspace,
            homeRoot: root,
            globalRoot: join(root, ".clarvis"),
            ...roots,
          }),
        ).toThrow(InvalidExecutionPolicy);
      }
      expect(() =>
        createExecutionPolicy({
          id: "bad",
          workspaceRoot: separateWorkspace,
          homeRoot: root,
          writableMetadataRoots: [join(root, ".clarvis")],
        }),
      ).toThrow(InvalidExecutionPolicy);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(installation, { recursive: true, force: true });
    }
  });

  test("uses the effective home for the default global root", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-sandbox-policy-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    try {
      const policy = createExecutionPolicy({
        id: "effective-home",
        mode: "sandbox",
        workspaceRoot: workspace,
        homeRoot: root,
      });
      expect(policy.globalRoot).toBe(resolveGlobalRoot({ home: root }));
      expect(policy.globalAgentsRoot).toBe(join(root, ".agents"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
