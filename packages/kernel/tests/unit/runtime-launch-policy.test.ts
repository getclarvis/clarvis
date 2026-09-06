import { describe, expect, test } from "bun:test";

import {
  assertRuntimeLaunchSpec,
  RuntimeLaunchError,
  type RuntimeLaunchSpec,
} from "../../src/index.ts";

const digest = `sha256:${"a".repeat(64)}`;

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
    sourceWorkspaceRoot: "/work/source",
    retainedWorkspaceRoot: "/state/runtime/workspace",
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
  test("accepts a separate retained workspace and immutable bounded authority", () => {
    expect(() => assertRuntimeLaunchSpec(launchSpec())).not.toThrow();
  });

  test.each([
    ["same", "/work/source"],
    ["inside", "/work/source/copy"],
    ["parent", "/work"],
  ])("rejects a %s source/copy relationship", (_name, retainedWorkspaceRoot) => {
    expect(() => assertRuntimeLaunchSpec(launchSpec({ retainedWorkspaceRoot }))).toThrow(
      RuntimeLaunchError,
    );
  });

  test("rejects mutable image tags, invalid limits, duplicate and open-ended methods", () => {
    for (const spec of [
      launchSpec({ imageDigest: "clarvis:latest" }),
      launchSpec({ limits: { ...launchSpec().limits, processCount: 0 } }),
      launchSpec({ capabilityMethods: ["memory.search", "memory.search"] }),
      launchSpec({ capabilityMethods: ["filesystem"] }),
      launchSpec({ capabilityMethods: ["kernel.*"] }),
      launchSpec({ generation: "" }),
      launchSpec({ sourceWorkspaceRoot: "relative/source" }),
    ]) {
      expect(() => assertRuntimeLaunchSpec(spec)).toThrow(RuntimeLaunchError);
    }
  });
});
