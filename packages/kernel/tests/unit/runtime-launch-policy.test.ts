import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";

import {
  assertRuntimeLaunchSpec,
  RuntimeLaunchError,
  type RuntimeLaunchSpec,
} from "../../src/index.ts";
import { assertMaterializedProtectedTargets } from "../../src/runtime/container-policy.ts";

const digest = `sha256:${"a".repeat(64)}`;
const workspaceRoot = resolve("runtime-test-workspace");
const maskRoot = resolve("runtime-test-masks");

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
    controlRootMasks: [
      {
        source: join(maskRoot, "clarvis"),
        target: "/workspace/.clarvis",
        type: "directory",
        readOnly: true,
      },
      {
        source: join(maskRoot, "agents"),
        target: "/workspace/.agents",
        type: "directory",
        readOnly: true,
      },
    ],
    gitMetadataMounts: [
      {
        source: join(maskRoot, "git"),
        target: "/workspace/.git",
        type: "directory",
        readOnly: true,
      },
    ],
    imageDigest: digest,
    network: "none",
    limits: {
      cpuCount: 2,
      memoryBytes: 1024,
      processCount: 64,
      outputBytes: 4096,
      storageBytes: 8192,
    },
    capabilityMethods: ["runtime.elicit"],
    ...overrides,
  };
}

function linkedSpec(): RuntimeLaunchSpec {
  const common = resolve("runtime-test-repository", ".git");
  const gitDir = join(common, "worktrees", "feature");
  return launchSpec({
    workspace: { ...launchSpec().workspace, kind: "external_worktree" },
    gitMetadataMounts: [
      {
        source: join(workspaceRoot, ".git"),
        target: "/workspace/.git",
        type: "file",
        readOnly: true,
      },
      { source: gitDir, target: gitDir, type: "directory", readOnly: true },
      { source: common, target: common, type: "directory", readOnly: true },
    ],
  });
}

describe("assertRuntimeLaunchSpec", () => {
  test("refuses absent protected roots without materializing nested mount targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-non-git-"));
    try {
      const spec = launchSpec({ workspaceRoot: root });
      await expect(assertMaterializedProtectedTargets(spec)).rejects.toMatchObject({
        code: "unsupported_policy",
        message: expect.stringContaining("Use Isolation Sandbox or Host"),
      });
      for (const name of [".clarvis", ".agents", ".git"]) {
        await expect(stat(join(root, name))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts exact private control masks and primary or linked Git projections", () => {
    expect(() => assertRuntimeLaunchSpec(launchSpec())).not.toThrow();
    expect(() => assertRuntimeLaunchSpec(linkedSpec())).not.toThrow();
  });

  test("rejects missing, reordered, writable or workspace-backed control masks", () => {
    const base = launchSpec();
    for (const spec of [
      launchSpec({ controlRootMasks: base.controlRootMasks.slice(0, 1) }),
      launchSpec({ controlRootMasks: [...base.controlRootMasks].reverse() }),
      launchSpec({
        controlRootMasks: [
          { ...base.controlRootMasks[0]!, readOnly: false as true },
          base.controlRootMasks[1]!,
        ],
      }),
      launchSpec({
        controlRootMasks: [
          { ...base.controlRootMasks[0]!, source: join(workspaceRoot, "mask") },
          base.controlRootMasks[1]!,
        ],
      }),
    ]) {
      expect(() => assertRuntimeLaunchSpec(spec)).toThrow(RuntimeLaunchError);
    }
  });

  test("rejects extra, writable, duplicate, root or malformed Git projections", () => {
    const base = launchSpec();
    const linked = linkedSpec();
    for (const spec of [
      launchSpec({ gitMetadataMounts: [] }),
      launchSpec({
        gitMetadataMounts: [{ ...base.gitMetadataMounts[0]!, readOnly: false as true }],
      }),
      launchSpec({
        gitMetadataMounts: [base.gitMetadataMounts[0]!, base.gitMetadataMounts[0]!],
      }),
      launchSpec({
        gitMetadataMounts: [{ ...base.gitMetadataMounts[0]!, source: parse(workspaceRoot).root }],
      }),
      launchSpec({
        gitMetadataMounts: [{ ...base.gitMetadataMounts[0]!, target: "/workspace/other" }],
      }),
      { ...linked, gitMetadataMounts: linked.gitMetadataMounts.slice(1) },
      {
        ...linked,
        gitMetadataMounts: [
          linked.gitMetadataMounts[0]!,
          { ...linked.gitMetadataMounts[1]!, target: "/different" },
        ],
      },
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
