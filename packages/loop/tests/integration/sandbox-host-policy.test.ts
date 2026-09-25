import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSandboxHostPolicy, resolveSandboxPath } from "../../src/capabilities-tools.ts";

const roots = new Set<string>();

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("sandbox host policy", () => {
  it("resolves workspace-relative and external sandbox paths", () => {
    const root = tempRoot("clarvis-host-policy-");
    const workspace = join(root, "workspace");
    const external = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(external);
    expect(resolveSandboxPath("../outside", workspace, true)).toEqual({ path: external });
    expect(resolveSandboxPath(external, workspace, true)).toEqual({ path: external });
    expect(resolveSandboxPath("./outside", workspace, false).error).toBe(
      "global sandbox paths must be absolute",
    );
  });

  it("includes existing external paths in manual sandbox policy", () => {
    const root = tempRoot("clarvis-host-policy-manual-");
    const workspace = join(root, "workspace");
    const sdk = join(root, "sdk");
    mkdirSync(workspace);
    mkdirSync(sdk);
    expect(
      resolveSandboxHostPolicy(
        { type: "native", toolchains: { mode: "manual", extra_paths: [sdk] } },
        workspace,
      )?.resolved_read_only_paths,
    ).toEqual([sdk]);
  });

  it("discovers an included runtime and filters an explicitly excluded one", () => {
    const root = tempRoot("clarvis-host-policy-auto-");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);

    const included = resolveSandboxHostPolicy(
      { type: "native", toolchains: { mode: "auto", include: ["bun"] } },
      workspace,
    );
    expect(included?.resolved_runtime_paths?.length).toBeGreaterThan(0);

    const excluded = resolveSandboxHostPolicy(
      {
        type: "native",
        toolchains: { mode: "auto", include: ["bun"], exclude: ["bun"] },
      },
      workspace,
    );
    expect(excluded?.resolved_runtime_paths).toBeUndefined();
  });
});
