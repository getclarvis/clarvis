import { describe, expect, test } from "bun:test";
import { dirname, join, parse, resolve } from "node:path";

import {
  assertRuntimeLaunchSpec,
  RuntimeLaunchError,
  type RuntimeLaunchSpec,
} from "../../src/index.ts";

const digest = `sha256:${"a".repeat(64)}`;
const workspaceRoot = resolve("runtime-test-workspace");
const gitCommonDir = resolve("runtime-test-git");

function launchSpec(overrides: Partial<RuntimeLaunchSpec> = {}): RuntimeLaunchSpec {
  return {
    generation: "runtime-1",
    ownerId: "owner-1",
    project: { id: "project-1" },
    workspace: {
      id: "workspace-1",
      projectId: "project-1",
      label: "primary",
      kind: "primary",
    },
    workspaceRoot,
    readOnlyWorkspacePaths: [join(workspaceRoot, ".clarvis", "memory")],
    gitCommonDir,
    imageDigest: digest,
    configurationRevision: "config-1",
    extensionRevision: "extensions-1",
    network: "none",
    limits: {
      cpuCount: 2,
      memoryBytes: 1024,
      processCount: 64,
      outputBytes: 4096,
      storageBytes: 8192,
    },
    capabilityMethods: ["memory.search", "plans.get"],
    ...overrides,
  };
}

describe("assertRuntimeLaunchSpec", () => {
  test("accepts a direct workspace mount with bounded overlays and linked Git metadata", () => {
    expect(() => assertRuntimeLaunchSpec(launchSpec())).not.toThrow();
  });

  test.each([
    ["same", workspaceRoot],
    ["outside", resolve("runtime-test-other", "memory")],
    ["parent", dirname(workspaceRoot)],
    ["relative", join("relative", "memory")],
  ])("rejects a %s read-only workspace path", (_name, path) => {
    expect(() => assertRuntimeLaunchSpec(launchSpec({ readOnlyWorkspacePaths: [path] }))).toThrow(
      RuntimeLaunchError,
    );
  });

  test("rejects duplicate overlays and Git metadata that overlaps the workspace", () => {
    const protectedPath = join(workspaceRoot, ".clarvis", "memory");
    for (const spec of [
      launchSpec({ readOnlyWorkspacePaths: [protectedPath, protectedPath] }),
      launchSpec({ gitCommonDir: workspaceRoot }),
      launchSpec({ gitCommonDir: join(workspaceRoot, ".git") }),
      launchSpec({ gitCommonDir: dirname(workspaceRoot) }),
      launchSpec({ gitCommonDir: parse(workspaceRoot).root }),
      launchSpec({ gitCommonDir: join("relative", ".git") }),
    ]) {
      expect(() => assertRuntimeLaunchSpec(spec)).toThrow(RuntimeLaunchError);
    }
  });

  test("rejects mutable image tags, invalid limits, duplicate and open-ended methods", () => {
    for (const spec of [
      launchSpec({ imageDigest: "clarvis:latest" }),
      launchSpec({ limits: { ...launchSpec().limits, processCount: 0 } }),
      launchSpec({ capabilityMethods: ["memory.search", "memory.search"] }),
      launchSpec({ capabilityMethods: ["filesystem"] }),
      launchSpec({ capabilityMethods: ["kernel.*"] }),
      launchSpec({ generation: "" }),
      launchSpec({ workspaceRoot: join("relative", "source") }),
    ]) {
      expect(() => assertRuntimeLaunchSpec(spec)).toThrow(RuntimeLaunchError);
    }
  });
});
